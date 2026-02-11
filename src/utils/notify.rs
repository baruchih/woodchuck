//! ntfy notification client
//!
//! Sends push notifications via ntfy.sh when Claude needs attention.

use async_trait::async_trait;
use tracing::{debug, instrument, warn};

use crate::config::Config;
use crate::model::error::ModelError;
use crate::model::types::SessionStatus;

/// Trait for notification operations
#[async_trait]
pub trait NtfyClient: Send + Sync {
    /// Send a notification
    async fn notify(
        &self,
        session_id: &str,
        status: &SessionStatus,
        output_snippet: &str,
    ) -> Result<(), ModelError>;

    /// Check if notifications are enabled
    fn is_enabled(&self) -> bool;
}

/// Real ntfy implementation
#[derive(Debug, Clone)]
pub struct Ntfy {
    server: Option<String>,
    topic: Option<String>,
    client: reqwest::Client,
}

impl Ntfy {
    /// Create new ntfy client from config
    pub fn new(config: &Config) -> Self {
        Self {
            server: config.ntfy_server.clone(),
            topic: config.ntfy_topic.clone(),
            client: reqwest::Client::new(),
        }
    }

    /// Create a disabled ntfy client
    pub fn disabled() -> Self {
        Self {
            server: None,
            topic: None,
            client: reqwest::Client::new(),
        }
    }
}

#[async_trait]
impl NtfyClient for Ntfy {
    #[instrument(skip(self, output_snippet))]
    async fn notify(
        &self,
        session_id: &str,
        status: &SessionStatus,
        output_snippet: &str,
    ) -> Result<(), ModelError> {
        let (server, topic) = match (&self.server, &self.topic) {
            (Some(s), Some(t)) => (s, t),
            _ => {
                debug!("Notifications disabled, skipping");
                return Ok(());
            }
        };

        let url = format!("{}/{}", server, topic);

        let title = match status {
            SessionStatus::NeedsInput => format!("Claude needs input: {}", session_id),
            SessionStatus::Error => format!("Error in session: {}", session_id),
            _ => format!("Claude update: {}", session_id),
        };

        // Get last few lines of output for context
        let body: String = output_snippet
            .lines()
            .rev()
            .take(5)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect::<Vec<_>>()
            .join("\n");

        let priority = match status {
            SessionStatus::Error => "high",
            SessionStatus::NeedsInput => "default",
            _ => "low",
        };

        let response = self
            .client
            .post(&url)
            .header("Title", title)
            .header("Priority", priority)
            .header("Tags", format!("claude,{}", status))
            .body(body)
            .send()
            .await
            .map_err(|e| ModelError::NotificationError(e.to_string()))?;

        if response.status().is_success() {
            debug!(session = %session_id, "Notification sent");
            Ok(())
        } else {
            let status = response.status();
            let body = response
                .text()
                .await
                .unwrap_or_else(|_| "unknown error".to_string());
            warn!(
                session = %session_id,
                status = %status,
                body = %body,
                "Notification failed"
            );
            Err(ModelError::NotificationError(format!(
                "ntfy returned {}: {}",
                status, body
            )))
        }
    }

    fn is_enabled(&self) -> bool {
        self.server.is_some() && self.topic.is_some()
    }
}

// =============================================================================
// Noop Implementation
// =============================================================================

/// No-op notification client (for when notifications are disabled)
#[derive(Debug, Clone, Default)]
pub struct NoopNtfy;

#[async_trait]
impl NtfyClient for NoopNtfy {
    async fn notify(
        &self,
        _session_id: &str,
        _status: &SessionStatus,
        _output_snippet: &str,
    ) -> Result<(), ModelError> {
        Ok(())
    }

    fn is_enabled(&self) -> bool {
        false
    }
}

// =============================================================================
// Unit Tests
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_ntfy_disabled() {
        let ntfy = Ntfy::disabled();
        assert!(!ntfy.is_enabled());
    }

    #[tokio::test]
    async fn test_noop_ntfy() {
        let ntfy = NoopNtfy;
        assert!(!ntfy.is_enabled());

        // Should succeed without doing anything
        let result = ntfy
            .notify("test", &SessionStatus::NeedsInput, "some output")
            .await;
        assert!(result.is_ok());
    }
}
