//! Output polling and subscriber management
//!
//! Polls tmux sessions for output changes and broadcasts to WebSocket subscribers.
//! This is in the controller layer because it deals with I/O (WebSocket messages).

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::{mpsc, RwLock, Semaphore};
use tokio::task::JoinHandle;
use tracing::{debug, info, warn};

/// Maximum concurrent background tasks (notifications, persistence)
/// Prevents unbounded task accumulation if tasks are slow
const MAX_BACKGROUND_TASKS: usize = 32;

use super::ws::messages::ServerMessage;
use crate::model::{OutputChange, SessionStatus, SharedSessionStates};
use crate::utils::{NtfyClient, SessionStore, TmuxClient, WebPushClient};

/// Subscriber info for a session
#[derive(Default)]
pub struct SessionSubscribers {
    /// Channels to send messages to subscribers
    pub senders: Vec<mpsc::Sender<ServerMessage>>,
}

impl SessionSubscribers {
    /// Add a new subscriber
    pub fn add(&mut self, tx: mpsc::Sender<ServerMessage>) {
        self.senders.push(tx);
    }

    /// Remove closed channels
    pub fn cleanup(&mut self) {
        self.senders.retain(|tx| !tx.is_closed());
    }

    /// Broadcast message to all subscribers (drops messages for slow clients)
    pub fn broadcast(&mut self, msg: ServerMessage) {
        self.senders.retain(|tx| {
            match tx.try_send(msg.clone()) {
                Ok(()) => true,
                Err(mpsc::error::TrySendError::Closed(_)) => false, // Remove dead sender
                Err(mpsc::error::TrySendError::Full(_)) => {
                    tracing::debug!("Dropping message for slow WebSocket client");
                    true // Keep sender, just drop this message
                }
            }
        });
    }

    /// Get subscriber count
    pub fn count(&self) -> usize {
        self.senders.len()
    }

    /// Check if there are any subscribers
    pub fn is_empty(&self) -> bool {
        self.senders.is_empty()
    }
}

/// Map of session ID to subscribers
pub type SubscriberMap = Arc<RwLock<HashMap<String, SessionSubscribers>>>;

/// Create a new subscriber map
pub fn new_subscriber_map() -> SubscriberMap {
    Arc::new(RwLock::new(HashMap::new()))
}

/// Add a subscriber for a session
pub async fn add_subscriber(
    subscribers: &SubscriberMap,
    session_states: &SharedSessionStates,
    session_id: &str,
    tx: mpsc::Sender<ServerMessage>,
) {
    // Add to subscriber map
    {
        let mut subs = subscribers.write().await;
        subs.entry(session_id.to_string())
            .or_default()
            .add(tx);
    }

    // Update subscriber count in session state
    {
        let subs = subscribers.read().await;
        let count = subs.get(session_id).map(|s| s.count()).unwrap_or(0);

        let mut states = session_states.write().await;
        if let Some(state) = states.get_mut(session_id) {
            state.subscriber_count = count;
        }
    }
}

/// Remove a subscriber (called when WebSocket closes)
pub async fn remove_subscriber(
    subscribers: &SubscriberMap,
    session_states: &SharedSessionStates,
    session_id: &str,
) {
    // Cleanup closed channels
    {
        let mut subs = subscribers.write().await;
        if let Some(session_subs) = subs.get_mut(session_id) {
            session_subs.cleanup();
        }
    }

    // Update subscriber count in session state
    {
        let subs = subscribers.read().await;
        let count = subs.get(session_id).map(|s| s.count()).unwrap_or(0);

        let mut states = session_states.write().await;
        if let Some(state) = states.get_mut(session_id) {
            state.subscriber_count = count;
        }
    }
}

/// Start the output polling background task
pub fn start_poller(
    tmux: Arc<dyn TmuxClient>,
    ntfy: Arc<dyn NtfyClient>,
    push: Arc<dyn WebPushClient>,
    session_states: SharedSessionStates,
    subscribers: SubscriberMap,
    session_store: Arc<dyn SessionStore>,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        tracing::warn!("Output poller: Task spawned");
        let poll_interval = Duration::from_millis(200);
        let mut interval = tokio::time::interval(poll_interval);
        let mut tick_count: u64 = 0;
        // Run cleanup every ~5 seconds (25 ticks * 200ms = 5000ms)
        let cleanup_every = 25;

        // Semaphore to limit concurrent background tasks (Issue #3 fix)
        let bg_semaphore = Arc::new(Semaphore::new(MAX_BACKGROUND_TASKS));

        info!("Output poller started");
        tracing::warn!("Output poller: Entering main loop");

        loop {
            interval.tick().await;
            tick_count += 1;

            // Get ALL tracked session IDs (not just those with subscribers)
            // This ensures push notifications work even when the app is closed
            let session_ids: Vec<String> = {
                let states = session_states.read().await;
                states.keys().cloned().collect()
            };

            // Poll each tracked session
            for session_id in session_ids {
                poll_session(
                    &session_id,
                    &tmux,
                    &ntfy,
                    &push,
                    &session_states,
                    &subscribers,
                    &session_store,
                    &bg_semaphore,
                )
                .await;
            }

            // Check for dead sessions less frequently (~every 5 seconds)
            if tick_count.is_multiple_of(cleanup_every) {
                cleanup_dead_sessions(&tmux, &session_states, &subscribers).await;
                cleanup_empty_subscribers(&subscribers).await;
            }
        }
    })
}

/// Poll a single session for output changes
#[allow(clippy::too_many_arguments)]
async fn poll_session(
    session_id: &str,
    tmux: &Arc<dyn TmuxClient>,
    ntfy: &Arc<dyn NtfyClient>,
    push: &Arc<dyn WebPushClient>,
    session_states: &SharedSessionStates,
    subscribers: &SubscriberMap,
    session_store: &Arc<dyn SessionStore>,
    bg_semaphore: &Arc<Semaphore>,
) {
    // Capture current pane output
    let output = match tmux.capture_pane(session_id, 200).await {
        Ok(o) => o,
        Err(_) => return,
    };

    // Update state and check for changes
    // Issue #1 fix: Use get_mut instead of entry().or_default() to avoid creating entries
    let (change, persisted_state): (Option<OutputChange>, Option<crate::utils::PersistedSessionState>) = {
        let mut states = session_states.write().await;
        // Only update existing entries, don't create new ones
        if let Some(state) = states.get_mut(session_id) {
            let change = state.update_output(&output);
            // Get persisted state if there was a status change
            let persisted = if change.as_ref().is_some_and(|c| c.status_changed) {
                Some(state.to_persisted())
            } else {
                None
            };
            (change, persisted)
        } else {
            // Session not in our state map - skip it
            debug!(session = %session_id, "Session not in state map, skipping poll");
            return;
        }
    };

    // Persist state if status changed (with semaphore to limit concurrency)
    if let Some(persisted) = persisted_state {
        let store = session_store.clone();
        let sid = session_id.to_string();
        let permit = bg_semaphore.clone().try_acquire_owned();
        if let Ok(permit) = permit {
            tokio::spawn(async move {
                if let Err(e) = store.save(&sid, &persisted).await {
                    warn!(session = %sid, error = %e, "Failed to persist session state");
                }
                drop(permit); // Release semaphore when done
            });
        } else {
            // Too many background tasks - persist synchronously to avoid dropping
            warn!(session = %sid, "Background task limit reached, persisting synchronously");
            if let Err(e) = session_store.save(&sid, &persisted).await {
                warn!(session = %sid, error = %e, "Failed to persist session state");
            }
        }
    }

    // If there was a change, broadcast to subscribers
    if let Some(change) = change {
        let timestamp = chrono::Utc::now().to_rfc3339();

        // Broadcast output if there's new content
        if !change.new_content.is_empty() {
            let mut subs = subscribers.write().await;
            if let Some(session_subs) = subs.get_mut(session_id) {
                // Broadcast full output (not diff) - works better for TUI apps like Claude Code
                session_subs.broadcast(ServerMessage::Output {
                    session_id: session_id.to_string(),
                    content: output.clone(),
                    timestamp: timestamp.clone(),
                });
            }
        }

        // Handle status changes separately (notifications should fire even without new content)
        if change.status_changed {
            info!(
                session = %session_id,
                old_status = %change.old_status,
                new_status = %change.new_status,
                "Status changed"
            );

            // Broadcast status to WebSocket subscribers
            {
                let mut subs = subscribers.write().await;
                if let Some(session_subs) = subs.get_mut(session_id) {
                    session_subs.broadcast(ServerMessage::Status {
                        session_id: session_id.to_string(),
                        status: change.new_status.to_string(),
                        timestamp: timestamp.clone(),
                    });
                }
            }

            // Send notifications if waiting, error, or finished working
            // Deduplicate: only notify if we haven't already sent for this status
            let should_notify = matches!(change.new_status, SessionStatus::NeedsInput | SessionStatus::Error | SessionStatus::Resting) && {
                let mut states = session_states.write().await;
                if let Some(state) = states.get_mut(session_id) {
                    if state.last_notified_status == Some(change.new_status) {
                        false // Already notified for this status
                    } else {
                        state.last_notified_status = Some(change.new_status);
                        true
                    }
                } else {
                    false
                }
            };
            if should_notify {
                // Send ntfy notification (with semaphore to limit concurrency)
                let ntfy = ntfy.clone();
                let sid = session_id.to_string();
                let status = change.new_status;
                let output_snippet = output.clone();
                let permit = bg_semaphore.clone().try_acquire_owned();
                if let Ok(permit) = permit {
                    tokio::spawn(async move {
                        if let Err(e) = ntfy.notify(&sid, &status, &output_snippet).await {
                            warn!(session = %sid, error = %e, "Failed to send ntfy notification");
                        }
                        drop(permit);
                    });
                } else {
                    debug!(session = %sid, "Skipping ntfy notification - background task limit reached");
                }

                // Send web push notification
                info!(session = %session_id, "Sending web push notification");

                // Look up display name from session state (fall back to session_id if empty)
                let session_name: String = {
                    let states = session_states.read().await;
                    states.get(session_id)
                        .map(|s| &s.name)
                        .filter(|n| !n.is_empty())
                        .cloned()
                        .unwrap_or_else(|| session_id.to_string())
                };

                // Send web push notification (with semaphore to limit concurrency)
                let push = push.clone();
                let sid = session_id.to_string();
                let status = change.new_status;
                let permit = bg_semaphore.clone().try_acquire_owned();
                if let Ok(permit) = permit {
                    tokio::spawn(async move {
                        let (title, body) = match status {
                            SessionStatus::NeedsInput => (
                                format!("{} needs input", session_name),
                                "Claude is waiting for your response".to_string(),
                            ),
                            SessionStatus::Error => (
                                format!("{} error", session_name),
                                "An error occurred in the session".to_string(),
                            ),
                            SessionStatus::Resting => (
                                format!("{} finished", session_name),
                                "Claude has completed the task".to_string(),
                            ),
                            _ => {
                                drop(permit);
                                return;
                            }
                        };

                        let payload = serde_json::json!({
                            "title": title,
                            "body": body,
                            "session_id": sid,
                        });

                        if let Err(e) = push.send_to_all(&payload.to_string()).await {
                            warn!(session = %sid, error = %e, "Failed to send web push notification");
                        } else {
                            info!(session = %sid, "Web push notification sent");
                        }
                        drop(permit);
                    });
                } else {
                    debug!(session = %sid, "Skipping web push notification - background task limit reached");
                }
            }
        }
    }
}

/// Remove sessions that no longer exist in tmux
async fn cleanup_dead_sessions(
    tmux: &Arc<dyn TmuxClient>,
    session_states: &SharedSessionStates,
    subscribers: &SubscriberMap,
) {
    let tracked_ids: Vec<String> = {
        let states = session_states.read().await;
        states.keys().cloned().collect()
    };

    for session_id in tracked_ids {
        match tmux.has_session(&session_id).await {
            Ok(true) => {} // Session still exists
            Ok(false) => {
                // Session ended - notify subscribers and remove
                let timestamp = chrono::Utc::now().to_rfc3339();

                // Notify subscribers
                {
                    let mut subs = subscribers.write().await;
                    if let Some(session_subs) = subs.get_mut(&session_id) {
                        session_subs.broadcast(ServerMessage::SessionEnded {
                            session_id: session_id.clone(),
                            timestamp,
                        });
                    }
                    subs.remove(&session_id);
                }

                // Remove from session states
                {
                    let mut states = session_states.write().await;
                    states.remove(&session_id);
                }

                info!(session = %session_id, "Session ended, removed from tracking");
            }
            Err(e) => {
                warn!(session = %session_id, error = %e, "Error checking session existence");
            }
        }
    }
}

/// Remove subscriber entries that have no active senders
/// Prevents unbounded growth of the subscriber map
async fn cleanup_empty_subscribers(subscribers: &SubscriberMap) {
    let mut subs = subscribers.write().await;

    // First, cleanup closed channels within each session
    for session_subs in subs.values_mut() {
        session_subs.cleanup();
    }

    // Then remove sessions with no subscribers
    let empty_sessions: Vec<String> = subs
        .iter()
        .filter(|(_, s)| s.is_empty())
        .map(|(id, _)| id.clone())
        .collect();

    for session_id in empty_sessions {
        subs.remove(&session_id);
        debug!(session = %session_id, "Removed empty subscriber entry");
    }
}
