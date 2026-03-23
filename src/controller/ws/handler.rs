//! WebSocket connection handler
//!
//! Handles individual WebSocket connections: message parsing, subscription
//! management, and message routing.

use std::collections::HashSet;
use std::sync::Arc;

use axum::extract::ws::{Message, WebSocket};
use futures::{SinkExt, StreamExt};
use tokio::sync::mpsc;
use tracing::{debug, error, info, warn};

use super::messages::{ClientMessage, ServerMessage};
use crate::config::Config;
use crate::controller::poller::{add_subscriber, remove_subscriber, SubscriberMap};
use crate::model::{
    create_session, delete_session, detect_status, get_session, get_session_output, list_sessions,
    send_input, validate_rename, CreateSessionParams, SharedSessionStates,
};
use crate::utils::{PersistedSessionState, SessionStore, TmuxClient};

/// Max length for raw/text input via WebSocket (matches HTTP limit)
const MAX_WS_INPUT_LEN: usize = 10_000;

/// Maximum length for stored last_input (truncated if longer, matches HTTP limit)
const LAST_INPUT_MAX_LENGTH: usize = 500;

/// Max queued messages per WebSocket client before dropping
const WS_CHANNEL_CAPACITY: usize = 256;

/// Validate session ID format (mirrors model::session::validate_session_id)
fn validate_ws_session_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && !id.starts_with('-')
        && id.chars().all(|c| c.is_alphanumeric() || c == '-' || c == '_')
}

/// Handle a WebSocket connection
pub async fn handle_connection(
    socket: WebSocket,
    tmux: Arc<dyn TmuxClient>,
    session_states: SharedSessionStates,
    subscribers: SubscriberMap,
    config: Arc<Config>,
    session_store: Arc<dyn SessionStore>,
    global_broadcast: tokio::sync::broadcast::Sender<ServerMessage>,
) {
    let (mut ws_sender, mut ws_receiver) = socket.split();

    // W8 FIX: Bounded channel to prevent unbounded memory growth for slow clients
    let (tx, mut rx) = mpsc::channel::<ServerMessage>(WS_CHANNEL_CAPACITY);

    // Track subscriptions for this connection
    let subscriptions: Arc<tokio::sync::RwLock<HashSet<String>>> =
        Arc::new(tokio::sync::RwLock::new(HashSet::new()));

    // Task to forward messages from channel to WebSocket
    let send_task = tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {
            let json = match serde_json::to_string(&msg) {
                Ok(j) => j,
                Err(e) => {
                    error!("Failed to serialize message: {}", e);
                    continue;
                }
            };

            if ws_sender.send(Message::Text(json)).await.is_err() {
                break;
            }
        }
    });

    // Task to forward global broadcast messages to this client's WS sender
    let mut broadcast_rx = global_broadcast.subscribe();
    let broadcast_tx = tx.clone();
    let broadcast_task = tokio::spawn(async move {
        while let Ok(msg) = broadcast_rx.recv().await {
            if broadcast_tx.send(msg).await.is_err() {
                break;
            }
        }
    });

    // Handle incoming messages
    while let Some(result) = ws_receiver.next().await {
        let msg = match result {
            Ok(Message::Text(text)) => text,
            Ok(Message::Close(_)) => {
                debug!("WebSocket closed");
                break;
            }
            Ok(Message::Ping(_)) => {
                // Pong is sent automatically by axum
                continue;
            }
            Ok(_) => continue,
            Err(e) => {
                warn!("WebSocket error: {}", e);
                break;
            }
        };

        // Parse client message
        let client_msg: ClientMessage = match serde_json::from_str(&msg) {
            Ok(m) => m,
            Err(e) => {
                warn!("Invalid message: {}", e);
                let _ = tx.try_send(ServerMessage::Error {
                    session_id: String::new(),
                    message: "Invalid message format".to_string(),
                    request_id: None,
                });
                continue;
            }
        };

        // Extract session_id for validation (only for message types that have one)
        let session_id_opt = match &client_msg {
            ClientMessage::Subscribe { session_id }
            | ClientMessage::Unsubscribe { session_id }
            | ClientMessage::Input { session_id, .. }
            | ClientMessage::Resize { session_id, .. }
            | ClientMessage::GetSession { session_id, .. }
            | ClientMessage::DeleteSession { session_id, .. }
            | ClientMessage::UpdateSession { session_id, .. } => Some(session_id.as_str()),
            ClientMessage::GetSessions { .. } | ClientMessage::CreateSession { .. } => None,
        };

        // Validate session_id format when present
        if let Some(session_id_ref) = session_id_opt {
            if !validate_ws_session_id(session_id_ref) {
                let _ = tx.try_send(ServerMessage::Error {
                    session_id: String::new(),
                    message: "Invalid session ID format".to_string(),
                    request_id: None,
                });
                continue;
            }
        }

        // Handle message
        match client_msg {
            ClientMessage::Subscribe { session_id } => {
                handle_subscribe(
                    &session_id,
                    &tx,
                    &tmux,
                    &session_states,
                    &subscribers,
                    &subscriptions,
                )
                .await;
            }
            ClientMessage::Unsubscribe { session_id } => {
                handle_unsubscribe(&session_id, &subscriptions, &session_states, &subscribers).await;
                let _ = tx.try_send(ServerMessage::Unsubscribed { session_id });
            }
            ClientMessage::Input { session_id, text, raw } => {
                // Validate input length
                if text.len() > MAX_WS_INPUT_LEN {
                    let _ = tx.try_send(ServerMessage::Error {
                        session_id: session_id.clone(),
                        message: "Input too long".to_string(),
                        request_id: None,
                    });
                    continue;
                }
                handle_input(&session_id, &text, raw, &tx, &tmux, &session_states, &session_store).await;
            }
            ClientMessage::Resize {
                session_id,
                cols,
                rows,
            } => {
                handle_resize(&session_id, cols, rows, &tx, &tmux).await;
            }
            ClientMessage::GetSessions { request_id } => {
                handle_get_sessions(&tx, &tmux, &session_states, request_id).await;
            }
            ClientMessage::GetSession { session_id, request_id } => {
                handle_get_session(&session_id, &tx, &tmux, &session_states, request_id).await;
            }
            ClientMessage::CreateSession { name, folder, prompt, request_id } => {
                handle_create_session(
                    name, folder, prompt, request_id,
                    &tx, &tmux, &config, &session_states, &session_store, &global_broadcast,
                ).await;
            }
            ClientMessage::DeleteSession { session_id, request_id } => {
                handle_delete_session(
                    &session_id, request_id,
                    &tx, &tmux, &session_states, &session_store, &global_broadcast,
                ).await;
            }
            ClientMessage::UpdateSession { session_id, name, project_id, tags, request_id } => {
                handle_update_session(
                    &session_id, name, project_id, tags, request_id,
                    &tx, &tmux, &session_states, &session_store, &global_broadcast,
                ).await;
            }
        }
    }

    // Cleanup: unsubscribe from all sessions
    {
        let subs = subscriptions.read().await;
        for session_id in subs.iter() {
            remove_subscriber(&subscribers, &session_states, session_id).await;
        }
    }

    // Abort send task and broadcast forwarding task
    send_task.abort();
    broadcast_task.abort();

    debug!("WebSocket connection closed");
}

/// Handle subscribe message
async fn handle_subscribe(
    session_id: &str,
    tx: &mpsc::Sender<ServerMessage>,
    tmux: &Arc<dyn TmuxClient>,
    session_states: &SharedSessionStates,
    subscribers: &SubscriberMap,
    local_subscriptions: &Arc<tokio::sync::RwLock<HashSet<String>>>,
) {
    // Check if session exists
    match tmux.has_session(session_id).await {
        Ok(true) => {}
        Ok(false) => {
            let _ = tx.try_send(ServerMessage::Error {
                session_id: session_id.to_string(),
                message: "Session not found".to_string(),
                request_id: None,
            });
            return;
        }
        Err(e) => {
            warn!(session = %session_id, error = %e, "tmux error during subscribe");
            let _ = tx.try_send(ServerMessage::Error {
                session_id: session_id.to_string(),
                message: "Internal error checking session".to_string(),
                request_id: None,
            });
            return;
        }
    }

    // Get current output for initial state
    let (current_output, status) = match tmux.capture_pane(session_id, 200).await {
        Ok(output) => {
            let status = detect_status(&output);
            (output, status)
        }
        Err(e) => {
            let _ = tx.try_send(ServerMessage::Error {
                session_id: session_id.to_string(),
                message: format!("Failed to get output: {}", e),
                request_id: None,
            });
            return;
        }
    };

    // Add to local subscriptions tracking
    {
        let mut subs = local_subscriptions.write().await;
        subs.insert(session_id.to_string());
    }

    // Add subscriber to global subscriber map
    add_subscriber(subscribers, session_states, session_id, tx.clone()).await;

    // Send subscription confirmation with current state
    let _ = tx.try_send(ServerMessage::Subscribed {
        session_id: session_id.to_string(),
        current_output,
        status: status.to_string(),
    });

    info!(session = %session_id, "Client subscribed");
}

/// Handle unsubscribe message
async fn handle_unsubscribe(
    session_id: &str,
    local_subscriptions: &Arc<tokio::sync::RwLock<HashSet<String>>>,
    session_states: &SharedSessionStates,
    subscribers: &SubscriberMap,
) {
    // Remove from local subscriptions
    {
        let mut subs = local_subscriptions.write().await;
        subs.remove(session_id);
    }

    // Remove from global subscribers
    remove_subscriber(subscribers, session_states, session_id).await;

    info!(session = %session_id, "Client unsubscribed");
}

/// Handle input message
async fn handle_input(
    session_id: &str,
    text: &str,
    raw: bool,
    tx: &mpsc::Sender<ServerMessage>,
    tmux: &Arc<dyn TmuxClient>,
    session_states: &SharedSessionStates,
    session_store: &Arc<dyn SessionStore>,
) {
    if raw {
        // Raw mode: send keys directly without auto-Enter (for xterm keystroke passthrough)
        match tmux.send_keys_raw(session_id, text).await {
            Ok(()) => {
                debug!(session = %session_id, "Raw input sent via WebSocket");
            }
            Err(e) => {
                let _ = tx.try_send(ServerMessage::Error {
                    session_id: session_id.to_string(),
                    message: format!("Failed to send raw input: {}", e),
                    request_id: None,
                });
            }
        }
    } else {
        match send_input(tmux.as_ref(), session_id, text).await {
            Ok(()) => {
                info!(session = %session_id, "Input sent via WebSocket");

                // Track last_input in session_states (mirrors HTTP handler behavior)
                let char_count = text.chars().count();
                let last_input = if char_count > LAST_INPUT_MAX_LENGTH {
                    text.chars().take(LAST_INPUT_MAX_LENGTH).collect::<String>()
                } else {
                    text.to_string()
                };

                let mut states = session_states.write().await;
                if let Some(ss) = states.get_mut(session_id) {
                    ss.last_input = Some(last_input);
                    ss.last_input_at = Some(chrono::Utc::now());

                    // Persist updated state (non-fatal if fails)
                    let persisted = ss.to_persisted();
                    let store = session_store.clone();
                    let sid = session_id.to_string();
                    tokio::spawn(async move {
                        if let Err(e) = store.save(&sid, &persisted).await {
                            warn!(session = %sid, error = %e, "Failed to persist last_input from WS");
                        }
                    });
                }
            }
            Err(e) => {
                let _ = tx.try_send(ServerMessage::Error {
                    session_id: session_id.to_string(),
                    message: format!("Failed to send input: {}", e),
                    request_id: None,
                });
            }
        }
    }
}

/// Handle resize message
async fn handle_resize(
    session_id: &str,
    cols: u16,
    rows: u16,
    tx: &mpsc::Sender<ServerMessage>,
    tmux: &Arc<dyn TmuxClient>,
) {
    // Validate dimensions
    if cols == 0 || cols > 500 || rows == 0 || rows > 200 {
        let _ = tx.try_send(ServerMessage::Error {
            session_id: session_id.to_string(),
            message: format!(
                "Invalid dimensions: cols={} rows={} (must be 1-500 x 1-200)",
                cols, rows
            ),
            request_id: None,
        });
        return;
    }

    match tmux.resize_window(session_id, cols, rows).await {
        Ok(()) => {
            debug!(session = %session_id, cols = %cols, rows = %rows, "Resized via WebSocket");
        }
        Err(e) => {
            let _ = tx.try_send(ServerMessage::Error {
                session_id: session_id.to_string(),
                message: format!("Failed to resize: {}", e),
                request_id: None,
            });
        }
    }
}

// =============================================================================
// New WS-first handlers
// =============================================================================

/// Handle get_sessions: return full session list with overlaid state
async fn handle_get_sessions(
    tx: &mpsc::Sender<ServerMessage>,
    tmux: &Arc<dyn TmuxClient>,
    session_states: &SharedSessionStates,
    request_id: Option<String>,
) {
    let sessions = match list_sessions(tmux.as_ref()).await {
        Ok(s) => s,
        Err(e) => {
            let _ = tx.try_send(ServerMessage::Error {
                session_id: String::new(),
                message: format!("Failed to list sessions: {}", e),
                request_id,
            });
            return;
        }
    };

    // Overlay session states (same logic as HTTP list_sessions_handler)
    let mut sessions = sessions;
    {
        let mut states = session_states.write().await;
        for session in &mut sessions {
            let ss = states.entry(session.id.clone()).or_insert_with(|| {
                debug!(session_id = %session.id, "Creating default state for discovered session");
                crate::model::SessionState::default()
            });
            if ss.status != crate::model::SessionStatus::Resting || ss.working_since.is_some() {
                session.status = ss.status;
            }
            session.working_since = ss.working_since;
            session.project_id = ss.project_id.clone();
            session.last_input = ss.last_input.clone();
            session.last_input_at = ss.last_input_at;
            session.tags = ss.tags.clone();
            if !ss.name.is_empty() {
                session.name = ss.name.clone();
            }
        }
    }

    // Filter out maintainer session
    sessions.retain(|s| s.id != crate::controller::maintainer::MAINTAINER_SESSION_ID);

    let _ = tx.try_send(ServerMessage::Sessions { sessions, request_id });
}

/// Handle get_session: return single session detail with recent output
async fn handle_get_session(
    session_id: &str,
    tx: &mpsc::Sender<ServerMessage>,
    tmux: &Arc<dyn TmuxClient>,
    session_states: &SharedSessionStates,
    request_id: Option<String>,
) {
    let mut session = match get_session(tmux.as_ref(), session_id).await {
        Ok(s) => s,
        Err(e) => {
            let _ = tx.try_send(ServerMessage::Error {
                session_id: session_id.to_string(),
                message: format!("Failed to get session: {}", e),
                request_id,
            });
            return;
        }
    };

    // Overlay from session_states (same as HTTP handler)
    {
        let states = session_states.read().await;
        if let Some(ss) = states.get(session_id) {
            if ss.status != crate::model::SessionStatus::Resting || ss.working_since.is_some() {
                session.status = ss.status;
            }
            session.working_since = ss.working_since;
            session.project_id = ss.project_id.clone();
            session.last_input = ss.last_input.clone();
            session.last_input_at = ss.last_input_at;
            session.tags = ss.tags.clone();
            if !ss.name.is_empty() {
                session.name = ss.name.clone();
            }
        }
    }

    // Get recent output
    let recent_output = get_session_output(tmux.as_ref(), session_id, 200).await.ok();

    let _ = tx.try_send(ServerMessage::SessionDetail {
        session,
        recent_output,
        request_id,
    });
}

/// Handle create_session: create a new session, broadcast, and ack
#[allow(clippy::too_many_arguments)]
async fn handle_create_session(
    name: String,
    folder: String,
    prompt: String,
    request_id: Option<String>,
    tx: &mpsc::Sender<ServerMessage>,
    tmux: &Arc<dyn TmuxClient>,
    config: &Arc<Config>,
    session_states: &SharedSessionStates,
    session_store: &Arc<dyn SessionStore>,
    global_broadcast: &tokio::sync::broadcast::Sender<ServerMessage>,
) {
    let params = CreateSessionParams { name, folder, prompt };

    let session = match create_session(tmux.as_ref(), config, params).await {
        Ok(s) => s,
        Err(e) => {
            let _ = tx.try_send(ServerMessage::Error {
                session_id: String::new(),
                message: format!("Failed to create session: {}", e),
                request_id,
            });
            return;
        }
    };

    // Track in session_states
    {
        let mut states = session_states.write().await;
        let mut state = crate::model::SessionState::with_name(session.name.clone());
        state.folder = Some(session.folder.clone());
        states.insert(session.id.clone(), state);
    }

    // Inject hooks (non-fatal)
    if let Err(e) = crate::utils::inject_hooks(&session.id, &session.folder, &config.external_url).await {
        warn!(session = %session.id, error = %e, "Hook injection failed, session created without hooks");
    }

    // Persist session state
    let mut persisted_state = PersistedSessionState::with_name(session.name.clone());
    persisted_state.folder = Some(session.folder.clone());
    if let Err(e) = session_store.save(&session.id, &persisted_state).await {
        warn!(session = %session.id, error = %e, "Failed to persist session state");
    }

    // Send ack to requesting client
    if let Some(ref rid) = request_id {
        let _ = tx.try_send(ServerMessage::Ack {
            request_id: rid.clone(),
            success: true,
        });
    }

    // Broadcast SessionCreated to all clients
    let _ = global_broadcast.send(ServerMessage::SessionCreated { session });
}

/// Handle delete_session: delete session, broadcast, and ack
async fn handle_delete_session(
    session_id: &str,
    request_id: Option<String>,
    tx: &mpsc::Sender<ServerMessage>,
    tmux: &Arc<dyn TmuxClient>,
    session_states: &SharedSessionStates,
    session_store: &Arc<dyn SessionStore>,
    global_broadcast: &tokio::sync::broadcast::Sender<ServerMessage>,
) {
    if let Err(e) = delete_session(tmux.as_ref(), session_id).await {
        let _ = tx.try_send(ServerMessage::Error {
            session_id: session_id.to_string(),
            message: format!("Failed to delete session: {}", e),
            request_id,
        });
        return;
    }

    // Remove from session_states
    {
        let mut states = session_states.write().await;
        states.remove(session_id);
    }

    // Remove from session_store
    if let Err(e) = session_store.remove(session_id).await {
        warn!(session = %session_id, error = %e, "Failed to remove persisted session state");
    }

    // Send ack to requesting client
    if let Some(ref rid) = request_id {
        let _ = tx.try_send(ServerMessage::Ack {
            request_id: rid.clone(),
            success: true,
        });
    }

    // Broadcast SessionDeleted to all clients
    let _ = global_broadcast.send(ServerMessage::SessionDeleted {
        session_id: session_id.to_string(),
    });
}

/// Handle update_session: update metadata, broadcast, and ack
#[allow(clippy::too_many_arguments)]
async fn handle_update_session(
    session_id: &str,
    name: Option<String>,
    project_id: Option<Option<String>>,
    tags: Option<Vec<String>>,
    request_id: Option<String>,
    tx: &mpsc::Sender<ServerMessage>,
    tmux: &Arc<dyn TmuxClient>,
    session_states: &SharedSessionStates,
    session_store: &Arc<dyn SessionStore>,
    global_broadcast: &tokio::sync::broadcast::Sender<ServerMessage>,
) {
    // Validate session exists
    match tmux.has_session(session_id).await {
        Ok(true) => {}
        Ok(false) => {
            let _ = tx.try_send(ServerMessage::Error {
                session_id: session_id.to_string(),
                message: "Session not found".to_string(),
                request_id,
            });
            return;
        }
        Err(e) => {
            let _ = tx.try_send(ServerMessage::Error {
                session_id: session_id.to_string(),
                message: format!("Failed to check session: {}", e),
                request_id,
            });
            return;
        }
    }

    // Validate name if provided
    if let Some(ref new_name) = name {
        if let Err(e) = validate_rename(session_id, new_name) {
            let _ = tx.try_send(ServerMessage::Error {
                session_id: session_id.to_string(),
                message: format!("Invalid name: {}", e),
                request_id,
            });
            return;
        }
    }

    // Update session_states
    let (final_name, final_project_id, final_tags) = {
        let mut states = session_states.write().await;
        let ss = states.entry(session_id.to_string()).or_insert_with(|| {
            crate::model::SessionState::default()
        });

        if let Some(ref new_name) = name {
            ss.name = new_name.clone();
        }

        if let Some(new_project_id) = project_id.clone() {
            ss.project_id = new_project_id;
        }

        if let Some(ref new_tags) = tags {
            ss.tags = new_tags.clone();
        }

        let persisted = ss.to_persisted();
        let final_name = if ss.name.is_empty() { None } else { Some(ss.name.clone()) };
        let final_project_id = ss.project_id.clone();
        let final_tags = ss.tags.clone();

        // Persist full state
        if let Err(e) = session_store.save(session_id, &persisted).await {
            warn!(session = %session_id, error = %e, "Failed to persist updated session");
        }

        (final_name, final_project_id, final_tags)
    };

    // Send ack to requesting client
    if let Some(ref rid) = request_id {
        let _ = tx.try_send(ServerMessage::Ack {
            request_id: rid.clone(),
            success: true,
        });
    }

    // Broadcast SessionUpdated to all clients
    let _ = global_broadcast.send(ServerMessage::SessionUpdated {
        session_id: session_id.to_string(),
        name: final_name,
        project_id: final_project_id,
        tags: final_tags,
    });
}
