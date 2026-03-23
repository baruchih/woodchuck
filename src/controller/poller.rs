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
    global_broadcast: tokio::sync::broadcast::Sender<ServerMessage>,
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
                cleanup_dead_sessions(&tmux, &session_states, &subscribers, &session_store, &global_broadcast).await;
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
    if let Some(ref change) = change {
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

        // Handle status changes: broadcast to WebSocket subscribers
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
        }
    }

    // If the session just stopped working, allow the next notification.
    // This is the ONLY place last_notified_status gets cleared, ensuring
    // notifications only fire after genuine Working→done transitions
    // (not after server restarts or brief status flickers).
    if let Some(ref change) = change {
        if change.status_changed && change.old_status == SessionStatus::Working {
            let mut states = session_states.write().await;
            if let Some(state) = states.get_mut(session_id) {
                state.last_notified_status = None;
            }
        }
    }

    // ── Push notifications ──
    // Runs on EVERY poll (not just output changes) so the Resting debounce
    // can fire after the required stability period even if output is static.
    //
    // Dedup: only notify once per status.
    // Debounce Resting: require status to be stable for 5+ seconds to avoid
    // false "finished" notifications during brief prompt flashes when user
    // sends input (quick Resting→Working transition).
    let current_status = {
        let states = session_states.read().await;
        states.get(session_id).map(|s| s.status)
    };

    if let Some(current_status) = current_status {
        let should_notify = matches!(current_status, SessionStatus::NeedsInput | SessionStatus::Error | SessionStatus::Resting) && {
            let mut states = session_states.write().await;
            if let Some(state) = states.get_mut(session_id) {
                if state.last_notified_status == Some(current_status) {
                    false // Already notified for this status
                } else if current_status == SessionStatus::Resting {
                    // Debounce: only notify Resting if stable for 5+ seconds
                    let stable_enough = state.status_stable_since
                        .map(|since| (chrono::Utc::now() - since).num_seconds() >= 5)
                        .unwrap_or(false);
                    if stable_enough {
                        state.last_notified_status = Some(current_status);
                        true
                    } else {
                        false // Not stable long enough, check again next poll
                    }
                } else {
                    state.last_notified_status = Some(current_status);
                    true
                }
            } else {
                false
            }
        };

        if should_notify {
            // Persist the updated last_notified_status so it survives restarts
            {
                let states = session_states.read().await;
                if let Some(state) = states.get(session_id) {
                    let persisted = state.to_persisted();
                    let store = session_store.clone();
                    let sid = session_id.to_string();
                    let permit = bg_semaphore.clone().try_acquire_owned();
                    if let Ok(permit) = permit {
                        tokio::spawn(async move {
                            if let Err(e) = store.save(&sid, &persisted).await {
                                warn!(session = %sid, error = %e, "Failed to persist notification state");
                            }
                            drop(permit);
                        });
                    }
                }
            }

            // Send ntfy notification (with semaphore to limit concurrency)
            let ntfy = ntfy.clone();
            let sid = session_id.to_string();
            let output_snippet = output.clone();
            let permit = bg_semaphore.clone().try_acquire_owned();
            if let Ok(permit) = permit {
                tokio::spawn(async move {
                    if let Err(e) = ntfy.notify(&sid, &current_status, &output_snippet).await {
                        warn!(session = %sid, error = %e, "Failed to send ntfy notification");
                    }
                    drop(permit);
                });
            } else {
                debug!(session = %session_id, "Skipping ntfy notification - background task limit reached");
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
            let permit = bg_semaphore.clone().try_acquire_owned();
            if let Ok(permit) = permit {
                tokio::spawn(async move {
                    let (title, body) = match current_status {
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
                debug!(session = %session_id, "Skipping web push notification - background task limit reached");
            }
        }
    }
}

/// Remove sessions that no longer exist in tmux
async fn cleanup_dead_sessions(
    tmux: &Arc<dyn TmuxClient>,
    session_states: &SharedSessionStates,
    subscribers: &SubscriberMap,
    session_store: &Arc<dyn SessionStore>,
    global_broadcast: &tokio::sync::broadcast::Sender<ServerMessage>,
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

                // Remove from persistent store (normal shutdown — not a crash orphan)
                if let Err(e) = session_store.remove(&session_id).await {
                    warn!(session = %session_id, error = %e, "Failed to remove ended session from store");
                }

                // Broadcast SessionDeleted to all connected clients
                let _ = global_broadcast.send(ServerMessage::SessionDeleted {
                    session_id: session_id.clone(),
                });

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

#[cfg(test)]
mod tests {
    use super::*;

    fn make_test_msg(id: &str) -> ServerMessage {
        ServerMessage::Status {
            session_id: id.to_string(),
            status: "working".to_string(),
            timestamp: "2025-01-01T00:00:00Z".to_string(),
        }
    }

    #[test]
    fn test_session_subscribers_default_empty() {
        let subs = SessionSubscribers::default();
        assert!(subs.is_empty());
        assert_eq!(subs.count(), 0);
    }

    #[test]
    fn test_add_subscriber() {
        let mut subs = SessionSubscribers::default();
        let (tx, _rx) = mpsc::channel(16);
        subs.add(tx);
        assert_eq!(subs.count(), 1);
        assert!(!subs.is_empty());
    }

    #[test]
    fn test_broadcast_delivers_to_all() {
        let mut subs = SessionSubscribers::default();
        let (tx1, mut rx1) = mpsc::channel(16);
        let (tx2, mut rx2) = mpsc::channel(16);
        subs.add(tx1);
        subs.add(tx2);

        subs.broadcast(make_test_msg("s1"));

        assert!(rx1.try_recv().is_ok());
        assert!(rx2.try_recv().is_ok());
        assert_eq!(subs.count(), 2);
    }

    #[test]
    fn test_broadcast_removes_closed_sender() {
        let mut subs = SessionSubscribers::default();
        let (tx1, _rx1) = mpsc::channel(16);
        let (tx2, rx2) = mpsc::channel(16);
        subs.add(tx1);
        subs.add(tx2);

        // Drop rx2 to close the channel
        drop(rx2);

        subs.broadcast(make_test_msg("s1"));
        // tx2 should be removed, tx1 kept
        assert_eq!(subs.count(), 1);
    }

    #[test]
    fn test_broadcast_drops_for_full_channel() {
        let mut subs = SessionSubscribers::default();
        // Channel with capacity 1
        let (tx, _rx) = mpsc::channel(1);
        subs.add(tx);

        // Fill the channel
        subs.broadcast(make_test_msg("s1"));
        // This should be dropped (channel full) but sender kept
        subs.broadcast(make_test_msg("s2"));

        assert_eq!(subs.count(), 1); // sender still there
    }

    #[test]
    fn test_cleanup_removes_closed_channels() {
        let mut subs = SessionSubscribers::default();
        let (tx1, _rx1) = mpsc::channel(16);
        let (tx2, rx2) = mpsc::channel(16);
        subs.add(tx1);
        subs.add(tx2);

        drop(rx2);
        subs.cleanup();

        assert_eq!(subs.count(), 1);
    }

    #[test]
    fn test_cleanup_keeps_open_channels() {
        let mut subs = SessionSubscribers::default();
        let (tx1, _rx1) = mpsc::channel(16);
        let (tx2, _rx2) = mpsc::channel(16);
        subs.add(tx1);
        subs.add(tx2);

        subs.cleanup();
        assert_eq!(subs.count(), 2);
    }

    #[tokio::test]
    async fn test_add_subscriber_updates_state() {
        let subscribers = new_subscriber_map();
        let session_states = crate::model::new_shared_states();

        // Add session to state first
        {
            let mut states = session_states.write().await;
            states.insert("s1".to_string(), crate::model::SessionState::new());
        }

        let (tx, _rx) = mpsc::channel(16);
        add_subscriber(&subscribers, &session_states, "s1", tx).await;

        let states = session_states.read().await;
        assert_eq!(states.get("s1").unwrap().subscriber_count, 1);
    }

    #[tokio::test]
    async fn test_remove_subscriber_updates_state() {
        let subscribers = new_subscriber_map();
        let session_states = crate::model::new_shared_states();

        {
            let mut states = session_states.write().await;
            states.insert("s1".to_string(), crate::model::SessionState::new());
        }

        let (tx, rx) = mpsc::channel(16);
        add_subscriber(&subscribers, &session_states, "s1", tx).await;

        // Drop receiver to simulate disconnect
        drop(rx);
        remove_subscriber(&subscribers, &session_states, "s1").await;

        let states = session_states.read().await;
        assert_eq!(states.get("s1").unwrap().subscriber_count, 0);
    }

    #[tokio::test]
    async fn test_cleanup_empty_subscribers_removes_entries() {
        let subscribers = new_subscriber_map();

        // Add an entry with no senders
        {
            let mut subs = subscribers.write().await;
            subs.insert("empty".to_string(), SessionSubscribers::default());
        }

        cleanup_empty_subscribers(&subscribers).await;

        let subs = subscribers.read().await;
        assert!(!subs.contains_key("empty"));
    }

    #[tokio::test]
    async fn test_cleanup_empty_subscribers_keeps_active() {
        let subscribers = new_subscriber_map();

        // Keep _rx alive outside the block so the channel stays open
        let (tx, _rx) = mpsc::channel(16);
        {
            let mut subs = subscribers.write().await;
            let mut session_subs = SessionSubscribers::default();
            session_subs.add(tx);
            subs.insert("active".to_string(), session_subs);
        }

        cleanup_empty_subscribers(&subscribers).await;

        let subs = subscribers.read().await;
        assert!(subs.contains_key("active"));
    }
}
