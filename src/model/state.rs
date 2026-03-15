//! Session state management
//!
//! Tracks session output, status, and WebSocket subscribers.
//!
//! Note: This module is pure and doesn't know about WebSocket messages.
//! Subscriber management is handled at the controller layer.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;
use chrono::{DateTime, Utc};
use tokio::sync::RwLock;

use super::output::{calculate_hash, diff_output};
use super::types::SessionStatus;
use crate::utils::PersistedSessionState;

/// State for a single session (pure model data)
#[derive(Debug, Clone)]
pub struct SessionState {
    /// User-provided display name for the session
    pub name: String,

    /// Full captured output (for new subscriber initial state)
    pub full_output: String,

    /// Hash of last captured output (for diff detection)
    pub last_output_hash: u64,

    /// Current detected status
    pub status: SessionStatus,

    /// Number of active subscribers (managed by controller)
    pub subscriber_count: usize,

    /// When the session entered "working" status (for duration tracking)
    pub working_since: Option<DateTime<Utc>>,

    /// Last time we detected "working" status (for debounce)
    pub last_working_at: Option<DateTime<Utc>>,

    /// Project ID if the session belongs to a project
    pub project_id: Option<String>,

    /// Last input sent to the session (for historical context)
    pub last_input: Option<String>,

    /// User-assigned tags for filtering/grouping
    pub tags: Vec<String>,

    /// Whether this is the maintainer session (hidden from main list)
    pub is_maintainer: bool,

    /// Last status for which a push notification was sent (deduplication)
    pub last_notified_status: Option<SessionStatus>,

    /// When the current status was first detected (for notification debounce)
    pub status_stable_since: Option<DateTime<Utc>>,
}

impl Default for SessionState {
    fn default() -> Self {
        Self {
            name: String::new(),
            full_output: String::new(),
            last_output_hash: 0,
            status: SessionStatus::Resting,
            subscriber_count: 0,
            working_since: None,
            last_working_at: None,
            project_id: None,
            last_input: None,
            tags: Vec::new(),
            is_maintainer: false,
            last_notified_status: None,
            status_stable_since: None,
        }
    }
}

impl SessionState {
    /// Create new session state
    pub fn new() -> Self {
        Self::default()
    }

    /// Create new session state with a display name
    pub fn with_name(name: String) -> Self {
        Self {
            name,
            ..Self::default()
        }
    }

    /// Create session state from persisted data
    pub fn from_persisted(persisted: PersistedSessionState) -> Self {
        // Pre-set last_notified_status to the restored status so the poller
        // doesn't re-notify for sessions that were already in this state
        // before the server restarted.
        let last_notified_status = Some(persisted.status);
        Self {
            name: persisted.name,
            status: persisted.status,
            working_since: persisted.working_since,
            last_working_at: persisted.last_working_at,
            project_id: persisted.project_id,
            last_input: persisted.last_input,
            tags: persisted.tags,
            last_notified_status,
            ..Self::default()
        }
    }

    /// Convert to persisted state (for saving to disk)
    pub fn to_persisted(&self) -> PersistedSessionState {
        PersistedSessionState {
            name: self.name.clone(),
            status: self.status,
            working_since: self.working_since,
            last_working_at: self.last_working_at,
            project_id: self.project_id.clone(),
            last_input: self.last_input.clone(),
            tags: self.tags.clone(),
        }
    }

    /// Check if there are any subscribers
    pub fn has_subscribers(&self) -> bool {
        self.subscriber_count > 0
    }

    /// Update output and return (new_content, status_changed, old_status, new_status)
    pub fn update_output(&mut self, new_output: &str) -> Option<OutputChange> {
        let hash = calculate_hash(new_output);

        // Check if output changed
        if hash == self.last_output_hash {
            return None;
        }

        // Output changed - extract diff
        let new_content = diff_output(&self.full_output, new_output);
        let old_status = self.status;

        self.full_output = new_output.to_string();
        self.last_output_hash = hash;

        // Detect new status
        let new_status = super::output::detect_status(new_output);
        let status_changed = new_status != old_status;
        self.status = new_status;

        // Track when this status was first seen (for debounce)
        if status_changed {
            self.status_stable_since = Some(Utc::now());
        }

        // Track working_since with proper status transition handling.
        //
        // Transition table:
        // | From        | To          | Behavior                                    |
        // |-------------|-------------|---------------------------------------------|
        // | Working     | NeedsInput  | Keep working_since (timer freezes)          |
        // | Working     | Error       | Clear immediately                           |
        // | Working     | Resting     | Apply 10-second grace period (flicker fix)  |
        // | NeedsInput  | Working     | Continue (don't reset working_since)        |
        // | NeedsInput  | Resting     | Clear immediately                           |
        // | NeedsInput  | Error       | Clear immediately                           |
        //
        // The grace period for Working->Resting prevents timer resets when
        // Claude Code briefly shows the prompt between tool calls.
        let now = Utc::now();
        if new_status == SessionStatus::Working {
            // Entering or continuing Working state
            self.last_working_at = Some(now);
            self.last_notified_status = None; // Reset so next transition will notify
            if self.working_since.is_none() {
                self.working_since = Some(now);
            }
        } else if old_status == SessionStatus::NeedsInput && new_status != SessionStatus::Working {
            // Leaving NeedsInput to Resting or Error: clear immediately
            self.working_since = None;
            self.last_working_at = None;
        } else if status_changed && old_status == SessionStatus::Working {
            // Leaving Working state
            if new_status == SessionStatus::Error {
                // Working -> Error: clear immediately
                self.working_since = None;
                self.last_working_at = None;
            }
            // Working -> NeedsInput: keep working_since (timer freezes)
            // Working -> Resting: keep for grace period, will clear on next poll
        } else if self.working_since.is_some() && new_status == SessionStatus::Resting {
            // Continuing in Resting state with active timer: check grace period
            const GRACE_PERIOD: Duration = Duration::from_secs(10);
            if let Some(last) = self.last_working_at {
                let elapsed = (now - last).to_std().unwrap_or(Duration::ZERO);
                if elapsed > GRACE_PERIOD {
                    self.working_since = None;
                    self.last_working_at = None;
                }
            }
        }

        Some(OutputChange {
            new_content,
            old_status,
            new_status,
            status_changed,
        })
    }
}

/// Information about an output change
#[derive(Debug, Clone)]
pub struct OutputChange {
    /// The new content (diff from previous)
    pub new_content: String,
    /// Previous status
    pub old_status: SessionStatus,
    /// New detected status
    pub new_status: SessionStatus,
    /// Whether status changed
    pub status_changed: bool,
}

/// Shared session states
pub type SharedSessionStates = Arc<RwLock<HashMap<String, SessionState>>>;

/// Create new shared session states
pub fn new_shared_states() -> SharedSessionStates {
    Arc::new(RwLock::new(HashMap::new()))
}

// =============================================================================
// Unit Tests
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_session_state_default() {
        let state = SessionState::default();
        assert!(state.full_output.is_empty());
        assert_eq!(state.last_output_hash, 0);
        assert_eq!(state.status, SessionStatus::Resting);
        assert!(!state.has_subscribers());
    }

    #[test]
    fn test_session_state_subscriber_count() {
        let mut state = SessionState::new();
        assert!(!state.has_subscribers());
        state.subscriber_count = 1;
        assert!(state.has_subscribers());
    }

    #[test]
    fn test_diff_output_simple_append() {
        let result = super::super::output::diff_output("line1\nline2", "line1\nline2\nline3");
        assert_eq!(result, "line3");
    }

    #[tokio::test]
    async fn test_shared_states() {
        let states = new_shared_states();

        {
            let mut states = states.write().await;
            states.insert("test".to_string(), SessionState::new());
        }

        {
            let states = states.read().await;
            assert!(states.contains_key("test"));
        }
    }

    #[test]
    fn test_session_state_with_name() {
        let state = SessionState::with_name("My Custom Name".to_string());
        assert_eq!(state.name, "My Custom Name");
        assert!(state.full_output.is_empty());
        assert_eq!(state.status, SessionStatus::Resting);
    }

    #[test]
    fn test_session_state_default_has_empty_name() {
        let state = SessionState::default();
        assert!(state.name.is_empty());
    }

    #[test]
    fn test_persisted_roundtrip() {
        let now = Utc::now();
        let mut state = SessionState::with_name("Test Session".to_string());
        state.status = SessionStatus::Working;
        state.working_since = Some(now);
        state.last_working_at = Some(now);
        state.project_id = Some("proj-123".to_string());
        state.last_input = Some("Test input request".to_string());
        state.full_output = "some output".to_string();
        state.last_output_hash = 12345;
        state.subscriber_count = 3;

        // Convert to persisted
        let persisted = state.to_persisted();
        assert_eq!(persisted.name, "Test Session");
        assert_eq!(persisted.status, SessionStatus::Working);
        assert_eq!(persisted.working_since, Some(now));
        assert_eq!(persisted.last_working_at, Some(now));
        assert_eq!(persisted.project_id, Some("proj-123".to_string()));
        assert_eq!(persisted.last_input, Some("Test input request".to_string()));

        // Restore from persisted
        let restored = SessionState::from_persisted(persisted);
        assert_eq!(restored.name, "Test Session");
        assert_eq!(restored.status, SessionStatus::Working);
        assert_eq!(restored.working_since, Some(now));
        assert_eq!(restored.last_working_at, Some(now));
        assert_eq!(restored.project_id, Some("proj-123".to_string()));
        assert_eq!(restored.last_input, Some("Test input request".to_string()));

        // Non-persisted fields should be defaults
        assert!(restored.full_output.is_empty());
        assert_eq!(restored.last_output_hash, 0);
        assert_eq!(restored.subscriber_count, 0);

        // last_notified_status should be pre-set to prevent re-notification on restart
        assert_eq!(restored.last_notified_status, Some(SessionStatus::Working));
    }

    #[test]
    fn test_persisted_with_none_timestamps() {
        let persisted = PersistedSessionState::with_name("Resting Session".to_string());
        assert_eq!(persisted.status, SessionStatus::Resting);
        assert!(persisted.working_since.is_none());
        assert!(persisted.last_working_at.is_none());
        assert!(persisted.project_id.is_none());

        let restored = SessionState::from_persisted(persisted);
        assert_eq!(restored.name, "Resting Session");
        assert_eq!(restored.status, SessionStatus::Resting);
        assert!(restored.working_since.is_none());
        assert!(restored.last_working_at.is_none());
        assert!(restored.project_id.is_none());
        // Should not re-notify for a resting session after restart
        assert_eq!(restored.last_notified_status, Some(SessionStatus::Resting));
    }
}
