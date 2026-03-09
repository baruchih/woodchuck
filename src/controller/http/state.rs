//! HTTP handler state
//!
//! Shared state passed to all HTTP handlers via Axum state extractor.

use std::sync::Arc;

use chrono::Utc;
use tracing::warn;

use crate::config::Config;
use crate::controller::SubscriberMap;
use crate::controller::deploy::DeployState;
use crate::controller::ralph::RalphHandle;
use crate::controller::ws::ServerMessage;
use crate::model::{OutputChange, SessionStatus, SharedSessionStates};
use crate::utils::{GitClient, NtfyClient, SessionStore, TmuxClient, WebPushClient};

/// Shared state for HTTP handlers
#[derive(Clone)]
pub struct AppState {
    /// Configuration
    pub config: Arc<Config>,

    /// tmux client
    pub tmux: Arc<dyn TmuxClient>,

    /// git client
    pub git: Arc<dyn GitClient>,

    /// Notification client
    pub ntfy: Arc<dyn NtfyClient>,

    /// Web Push client
    pub push: Arc<dyn WebPushClient>,

    /// Session states (output tracking, subscribers)
    pub session_states: SharedSessionStates,

    /// WebSocket subscriber map
    pub subscribers: SubscriberMap,

    /// Session state persistence store
    pub session_store: Arc<dyn SessionStore>,

    /// Ralph loop handle for the maintainer (if running)
    pub ralph_handle: Arc<tokio::sync::RwLock<Option<Arc<RalphHandle>>>>,

    /// Deploy pipeline state
    pub deploy: DeployState,
}

impl AppState {
    /// Create new app state
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        config: Arc<Config>,
        tmux: Arc<dyn TmuxClient>,
        git: Arc<dyn GitClient>,
        ntfy: Arc<dyn NtfyClient>,
        push: Arc<dyn WebPushClient>,
        session_states: SharedSessionStates,
        subscribers: SubscriberMap,
        session_store: Arc<dyn SessionStore>,
        deploy: DeployState,
    ) -> Self {
        Self {
            config,
            tmux,
            git,
            ntfy,
            push,
            session_states,
            subscribers,
            session_store,
            ralph_handle: Arc::new(tokio::sync::RwLock::new(None)),
            deploy,
        }
    }

    /// Set the ralph loop handle
    pub async fn set_ralph_handle(&self, handle: RalphHandle) {
        let mut rh = self.ralph_handle.write().await;
        *rh = Some(Arc::new(handle));
    }

    /// Get ralph loop state: (active, paused)
    pub fn ralph_state(&self) -> (bool, bool) {
        // Use try_read to avoid blocking in sync context
        match self.ralph_handle.try_read() {
            Ok(guard) => match guard.as_ref() {
                Some(handle) => (true, handle.is_paused()),
                None => (false, false),
            },
            Err(_) => (false, false),
        }
    }

    /// Pause the ralph loop
    pub fn pause_ralph(&self) {
        if let Ok(guard) = self.ralph_handle.try_read() {
            if let Some(handle) = guard.as_ref() {
                handle.pause();
            }
        }
    }

    /// Resume the ralph loop
    pub fn resume_ralph(&self) {
        if let Ok(guard) = self.ralph_handle.try_read() {
            if let Some(handle) = guard.as_ref() {
                handle.resume();
            }
        }
    }

    /// Track a new session in the shared state map
    pub async fn track_session(&self, session_id: &str, session_name: &str) {
        let mut states = self.session_states.write().await;
        states.insert(session_id.to_string(), crate::model::SessionState::with_name(session_name.to_string()));
    }

    /// Remove a session from the shared state map
    pub async fn untrack_session(&self, session_id: &str) {
        let mut states = self.session_states.write().await;
        states.remove(session_id);
    }

    /// Update a session's status and handle all side effects:
    /// 1. Update shared state
    /// 2. Broadcast via WebSocket
    /// 3. Send push notification if needed
    /// 4. Persist state
    ///
    /// Returns the OutputChange if status changed, None otherwise.
    pub async fn update_session_status(
        &self,
        session_id: &str,
        new_status: SessionStatus,
    ) -> Option<OutputChange> {
        let change = {
            let mut states = self.session_states.write().await;
            let state = states.get_mut(session_id)?;

            // Check if status actually changed
            if state.status == new_status {
                return None;
            }

            let old_status = state.status;
            state.status = new_status;

            // Update working_since tracking
            let now = Utc::now();
            if new_status == SessionStatus::Working {
                state.last_working_at = Some(now);
                if state.working_since.is_none() {
                    state.working_since = Some(now);
                }
            } else if old_status == SessionStatus::Working && new_status == SessionStatus::Error {
                // Working -> Error: clear immediately
                state.working_since = None;
                state.last_working_at = None;
            }
            // Note: Other transitions (grace period, NeedsInput->Resting) are handled
            // by the polling loop's update_output call, not here.

            Some(OutputChange {
                new_content: String::new(), // No content change from hook
                old_status,
                new_status,
                status_changed: true,
            })
        };

        let change = change?;

        // Broadcast status via WebSocket
        let timestamp = Utc::now().to_rfc3339();

        {
            let mut subs = self.subscribers.write().await;
            if let Some(session_subs) = subs.get_mut(session_id) {
                session_subs.broadcast(ServerMessage::Status {
                    session_id: session_id.to_string(),
                    status: change.new_status.to_string(),
                    timestamp,
                });
            }
        }

        // Send push notification if needs attention
        if change.new_status == SessionStatus::NeedsInput || change.new_status == SessionStatus::Error {
            let session_name = {
                let states = self.session_states.read().await;
                states.get(session_id)
                    .map(|s| s.name.clone())
                    .filter(|n| !n.is_empty())
                    .unwrap_or_else(|| session_id.to_string())
            };

            let (title, body) = if change.new_status == SessionStatus::Error {
                (format!("{} error", session_name), "An error occurred in the session".to_string())
            } else {
                (format!("{} needs input", session_name), "Claude is waiting for your response".to_string())
            };

            let push = self.push.clone();
            let sid = session_id.to_string();
            tokio::spawn(async move {
                let payload = serde_json::json!({
                    "title": title,
                    "body": body,
                    "session_id": sid,
                });
                if let Err(e) = push.send_to_all(&payload.to_string()).await {
                    warn!(session = %sid, error = %e, "Failed to send web push notification");
                }
            });
        }

        // Persist state
        {
            let states = self.session_states.read().await;
            if let Some(state) = states.get(session_id) {
                let persisted = state.to_persisted();
                let store = self.session_store.clone();
                let sid = session_id.to_string();
                tokio::spawn(async move {
                    if let Err(e) = store.save(&sid, &persisted).await {
                        warn!(session = %sid, error = %e, "Failed to persist session state");
                    }
                });
            }
        }

        Some(change)
    }
}
