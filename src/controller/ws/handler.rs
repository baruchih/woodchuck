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
use crate::controller::poller::{add_subscriber, remove_subscriber, SubscriberMap};
use crate::model::{detect_status, send_input, SharedSessionStates};
use crate::utils::TmuxClient;

/// Handle a WebSocket connection
pub async fn handle_connection(
    socket: WebSocket,
    tmux: Arc<dyn TmuxClient>,
    session_states: SharedSessionStates,
    subscribers: SubscriberMap,
) {
    let (mut ws_sender, mut ws_receiver) = socket.split();

    // Channel for sending messages to this client
    let (tx, mut rx) = mpsc::unbounded_channel::<ServerMessage>();

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
                let _ = tx.send(ServerMessage::Error {
                    session_id: String::new(),
                    message: format!("Invalid message: {}", e),
                });
                continue;
            }
        };

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
                let _ = tx.send(ServerMessage::Unsubscribed { session_id });
            }
            ClientMessage::Input { session_id, text } => {
                handle_input(&session_id, &text, &tx, &tmux).await;
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

    // Abort send task
    send_task.abort();

    debug!("WebSocket connection closed");
}

/// Handle subscribe message
async fn handle_subscribe(
    session_id: &str,
    tx: &mpsc::UnboundedSender<ServerMessage>,
    tmux: &Arc<dyn TmuxClient>,
    session_states: &SharedSessionStates,
    subscribers: &SubscriberMap,
    local_subscriptions: &Arc<tokio::sync::RwLock<HashSet<String>>>,
) {
    // Check if session exists
    match tmux.has_session(session_id).await {
        Ok(true) => {}
        Ok(false) => {
            let _ = tx.send(ServerMessage::Error {
                session_id: session_id.to_string(),
                message: "Session not found".to_string(),
            });
            return;
        }
        Err(e) => {
            let _ = tx.send(ServerMessage::Error {
                session_id: session_id.to_string(),
                message: format!("tmux error: {}", e),
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
            let _ = tx.send(ServerMessage::Error {
                session_id: session_id.to_string(),
                message: format!("Failed to get output: {}", e),
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
    let _ = tx.send(ServerMessage::Subscribed {
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
    tx: &mpsc::UnboundedSender<ServerMessage>,
    tmux: &Arc<dyn TmuxClient>,
) {
    match send_input(tmux.as_ref(), session_id, text).await {
        Ok(()) => {
            info!(session = %session_id, "Input sent via WebSocket");
        }
        Err(e) => {
            let _ = tx.send(ServerMessage::Error {
                session_id: session_id.to_string(),
                message: format!("Failed to send input: {}", e),
            });
        }
    }
}
