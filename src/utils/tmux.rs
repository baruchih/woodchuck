//! tmux command wrapper
//!
//! Provides a trait for tmux operations and a real implementation.
//! The trait enables mocking for tests.

use async_trait::async_trait;
use tokio::process::Command;
use tracing::{debug, instrument};

use crate::model::error::ModelError;
use crate::model::types::TmuxSessionInfo;

/// Trait for tmux operations
///
/// Abstracts tmux commands for testability.
#[async_trait]
pub trait TmuxClient: Send + Sync {
    /// List all tmux sessions
    async fn list_sessions(&self) -> Result<Vec<TmuxSessionInfo>, ModelError>;

    /// Check if a session exists
    async fn has_session(&self, name: &str) -> Result<bool, ModelError>;

    /// Create a new session
    async fn new_session(&self, name: &str, cwd: &str, cmd: &str) -> Result<(), ModelError>;

    /// Capture pane content
    async fn capture_pane(&self, name: &str, lines: usize) -> Result<String, ModelError>;

    /// Send keys to a session
    async fn send_keys(&self, name: &str, keys: &str) -> Result<(), ModelError>;

    /// Send raw terminal data to a session (literal passthrough, no auto-Enter)
    async fn send_keys_raw(&self, name: &str, data: &str) -> Result<(), ModelError>;

    /// Resize a session's window
    async fn resize_window(&self, name: &str, cols: u16, rows: u16) -> Result<(), ModelError>;

    /// Kill a session
    async fn kill_session(&self, name: &str) -> Result<(), ModelError>;
}

/// Real tmux implementation
#[derive(Debug, Clone, Default)]
pub struct Tmux;

impl Tmux {
    pub fn new() -> Self {
        Self
    }
}

#[async_trait]
impl TmuxClient for Tmux {
    #[instrument(skip(self))]
    async fn list_sessions(&self) -> Result<Vec<TmuxSessionInfo>, ModelError> {
        let output = Command::new("tmux")
            .args([
                "list-sessions",
                "-F",
                "#{session_name}|#{session_created}|#{session_activity}|#{pane_current_path}",
            ])
            .output()
            .await
            .map_err(|e| ModelError::TmuxError(format!("Failed to run tmux: {}", e)))?;

        if output.status.success() {
            let stdout = String::from_utf8_lossy(&output.stdout);
            let sessions = parse_list_sessions(&stdout);
            debug!(count = sessions.len(), "Listed tmux sessions");
            Ok(sessions)
        } else {
            // No sessions is not an error - tmux returns error when no server
            let stderr = String::from_utf8_lossy(&output.stderr);
            if stderr.contains("no server")
                || stderr.contains("no sessions")
                || stderr.contains("No such file or directory")
            {
                debug!("No tmux sessions (server not running)");
                Ok(Vec::new())
            } else {
                Err(ModelError::TmuxError(stderr.to_string()))
            }
        }
    }

    #[instrument(skip(self))]
    async fn has_session(&self, name: &str) -> Result<bool, ModelError> {
        let output = Command::new("tmux")
            .args(["has-session", "-t", name])
            .output()
            .await
            .map_err(|e| ModelError::TmuxError(format!("Failed to run tmux: {}", e)))?;

        Ok(output.status.success())
    }

    #[instrument(skip(self))]
    async fn new_session(&self, name: &str, cwd: &str, cmd: &str) -> Result<(), ModelError> {
        // Wrap command in a login+interactive shell to inherit user's PATH and environment
        // The -lic flags: -l (login), -i (interactive), -c (command)
        // This matches wolfpack's approach and is essential for commands like claude
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string());
        let shell_cmd = format!("{} -lic '{}'", shell, cmd.replace('\'', "'\\''"));

        // Set CLAUDE_SESSION_ID environment variable for the hook script
        let env_var = format!("CLAUDE_SESSION_ID={}", name);

        let output = Command::new("tmux")
            .args([
                "new-session",
                "-d",
                "-s",
                name,
                "-c",
                cwd,
                "-e",
                &env_var,
                &shell_cmd,
            ])
            .output()
            .await
            .map_err(|e| ModelError::TmuxError(format!("Failed to run tmux: {}", e)))?;

        if output.status.success() {
            debug!(session = %name, "Created tmux session");
            Ok(())
        } else {
            let stderr = String::from_utf8_lossy(&output.stderr);
            Err(ModelError::TmuxError(stderr.to_string()))
        }
    }

    #[instrument(skip(self))]
    async fn capture_pane(&self, name: &str, lines: usize) -> Result<String, ModelError> {
        let output = Command::new("tmux")
            .args([
                "capture-pane",
                "-t",
                name,
                "-p",  // Print to stdout
                "-e",  // Include escape sequences (ANSI colors)
                "-J",  // Join wrapped lines
                "-S",
                &format!("-{}", lines),
            ])
            .output()
            .await
            .map_err(|e| ModelError::TmuxError(format!("Failed to run tmux: {}", e)))?;

        if output.status.success() {
            Ok(String::from_utf8_lossy(&output.stdout).to_string())
        } else {
            let stderr = String::from_utf8_lossy(&output.stderr);
            Err(ModelError::TmuxError(stderr.to_string()))
        }
    }

    #[instrument(skip(self))]
    async fn send_keys(&self, name: &str, keys: &str) -> Result<(), ModelError> {
        // Bare key names sent without -l flag (tmux interprets these as special keys)
        let bare_keys: &[&str] = &[
            "", "Enter", "Escape", "Up", "Down", "Left", "Right",
            "Tab", "BTab", "C-c", "C-d", "C-z", "y", "n",
        ];

        if bare_keys.contains(&keys) {
            // Send bare key name directly (no -l flag)
            let key = if keys.is_empty() { "Enter" } else { keys };
            let output = Command::new("tmux")
                .args(["send-keys", "-t", name, key])
                .output()
                .await
                .map_err(|e| ModelError::TmuxError(format!("Failed to run tmux: {}", e)))?;

            if output.status.success() {
                debug!(session = %name, key = %key, "Sent bare key to tmux session");
                Ok(())
            } else {
                let stderr = String::from_utf8_lossy(&output.stderr);
                Err(ModelError::TmuxError(stderr.to_string()))
            }
        } else {
            // Literal text: send with -l flag, then sleep 100ms, then send Enter separately
            // This matches wolfpack's tmuxSend pattern (serve.ts lines 109-119)
            let output = Command::new("tmux")
                .args(["send-keys", "-l", "-t", name, keys])
                .output()
                .await
                .map_err(|e| ModelError::TmuxError(format!("Failed to run tmux: {}", e)))?;

            if !output.status.success() {
                let stderr = String::from_utf8_lossy(&output.stderr);
                return Err(ModelError::TmuxError(stderr.to_string()));
            }

            // 100ms delay to ensure text is in the buffer before Enter
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;

            // Send Enter separately (without -l flag)
            let output = Command::new("tmux")
                .args(["send-keys", "-t", name, "Enter"])
                .output()
                .await
                .map_err(|e| ModelError::TmuxError(format!("Failed to run tmux: {}", e)))?;

            if output.status.success() {
                debug!(session = %name, "Sent literal text + Enter to tmux session");
                Ok(())
            } else {
                let stderr = String::from_utf8_lossy(&output.stderr);
                Err(ModelError::TmuxError(stderr.to_string()))
            }
        }
    }

    #[instrument(skip(self))]
    async fn send_keys_raw(&self, name: &str, data: &str) -> Result<(), ModelError> {
        // Translate xterm escape sequences to tmux key names
        let key = match data {
            "\r" | "\n" => "Enter",
            "\x1b" => "Escape",
            "\x1b[A" => "Up",
            "\x1b[B" => "Down",
            "\x1b[C" => "Right",
            "\x1b[D" => "Left",
            "\t" => "Tab",
            "\x1b[Z" => "BTab",
            "\x03" => "C-c",
            "\x04" => "C-d",
            "\x1a" => "C-z",
            "\x7f" | "\x08" => "BSpace",
            "\x1b[3~" => "DC",  // Delete key
            "\x1b[H" => "Home",
            "\x1b[F" => "End",
            "\x1b[5~" => "PageUp",
            "\x1b[6~" => "PageDown",
            _ => "",
        };

        if !key.is_empty() {
            // Send as tmux key name (no -l flag)
            let output = Command::new("tmux")
                .args(["send-keys", "-t", name, key])
                .output()
                .await
                .map_err(|e| ModelError::TmuxError(format!("Failed to run tmux: {}", e)))?;

            if !output.status.success() {
                let stderr = String::from_utf8_lossy(&output.stderr);
                return Err(ModelError::TmuxError(stderr.to_string()));
            }
        } else if !data.is_empty() {
            // Send as literal text (with -l flag, no Enter)
            let output = Command::new("tmux")
                .args(["send-keys", "-l", "-t", name, data])
                .output()
                .await
                .map_err(|e| ModelError::TmuxError(format!("Failed to run tmux: {}", e)))?;

            if !output.status.success() {
                let stderr = String::from_utf8_lossy(&output.stderr);
                return Err(ModelError::TmuxError(stderr.to_string()));
            }
        }

        Ok(())
    }

    #[instrument(skip(self))]
    async fn resize_window(&self, name: &str, cols: u16, rows: u16) -> Result<(), ModelError> {
        let output = Command::new("tmux")
            .args([
                "resize-window",
                "-t",
                name,
                "-x",
                &cols.to_string(),
                "-y",
                &rows.to_string(),
            ])
            .output()
            .await
            .map_err(|e| ModelError::TmuxError(format!("Failed to run tmux: {}", e)))?;

        if output.status.success() {
            debug!(session = %name, cols = %cols, rows = %rows, "Resized tmux window");
            Ok(())
        } else {
            let stderr = String::from_utf8_lossy(&output.stderr);
            Err(ModelError::TmuxError(stderr.to_string()))
        }
    }

    #[instrument(skip(self))]
    async fn kill_session(&self, name: &str) -> Result<(), ModelError> {
        let output = Command::new("tmux")
            .args(["kill-session", "-t", name])
            .output()
            .await
            .map_err(|e| ModelError::TmuxError(format!("Failed to run tmux: {}", e)))?;

        if output.status.success() {
            debug!(session = %name, "Killed tmux session");
            Ok(())
        } else {
            let stderr = String::from_utf8_lossy(&output.stderr);
            Err(ModelError::TmuxError(stderr.to_string()))
        }
    }
}

/// Parse tmux list-sessions output
pub fn parse_list_sessions(output: &str) -> Vec<TmuxSessionInfo> {
    output
        .lines()
        .filter(|line| !line.is_empty())
        .filter_map(|line| {
            let parts: Vec<&str> = line.split('|').collect();
            if parts.len() >= 3 {
                Some(TmuxSessionInfo {
                    name: parts[0].to_string(),
                    created: parts[1].parse().unwrap_or(0),
                    activity: parts[2].parse().unwrap_or(0),
                    folder: parts.get(3).unwrap_or(&"").to_string(),
                })
            } else {
                None
            }
        })
        .collect()
}

// =============================================================================
// Mock Implementation for Tests
// =============================================================================

#[cfg(test)]
pub mod mock {
    use super::*;
    use std::collections::HashMap;
    use std::sync::Arc;
    use tokio::sync::RwLock;

    /// Mock tmux client for testing
    #[derive(Debug, Clone, Default)]
    pub struct MockTmux {
        sessions: Arc<RwLock<HashMap<String, MockSession>>>,
    }

    #[derive(Debug, Clone, Default)]
    pub struct MockSession {
        pub name: String,
        pub output: String,
        pub created: i64,
        pub activity: i64,
        pub folder: String,
        pub cols: u16,
        pub rows: u16,
        pub last_keys: Vec<String>,
    }

    impl MockTmux {
        pub fn new() -> Self {
            Self::default()
        }

        pub async fn add_session(&self, name: &str, output: &str) {
            let mut sessions = self.sessions.write().await;
            sessions.insert(
                name.to_string(),
                MockSession {
                    name: name.to_string(),
                    output: output.to_string(),
                    created: chrono::Utc::now().timestamp(),
                    activity: chrono::Utc::now().timestamp(),
                    folder: String::new(),
                    cols: 80,
                    rows: 24,
                    last_keys: Vec::new(),
                },
            );
        }

        /// Get the stored dimensions for a session
        pub async fn get_dimensions(&self, name: &str) -> Option<(u16, u16)> {
            let sessions = self.sessions.read().await;
            sessions.get(name).map(|s| (s.cols, s.rows))
        }

        /// Get the last keys sent to a session
        pub async fn get_last_keys(&self, name: &str) -> Vec<String> {
            let sessions = self.sessions.read().await;
            sessions
                .get(name)
                .map(|s| s.last_keys.clone())
                .unwrap_or_default()
        }
    }

    #[async_trait]
    impl TmuxClient for MockTmux {
        async fn list_sessions(&self) -> Result<Vec<TmuxSessionInfo>, ModelError> {
            let sessions = self.sessions.read().await;
            Ok(sessions
                .values()
                .map(|s| TmuxSessionInfo {
                    name: s.name.clone(),
                    created: s.created,
                    activity: s.activity,
                    folder: s.folder.clone(),
                })
                .collect())
        }

        async fn has_session(&self, name: &str) -> Result<bool, ModelError> {
            let sessions = self.sessions.read().await;
            Ok(sessions.contains_key(name))
        }

        async fn new_session(&self, name: &str, cwd: &str, _cmd: &str) -> Result<(), ModelError> {
            let mut sessions = self.sessions.write().await;
            if sessions.contains_key(name) {
                return Err(ModelError::SessionAlreadyExists(name.to_string()));
            }
            sessions.insert(
                name.to_string(),
                MockSession {
                    name: name.to_string(),
                    output: String::new(),
                    created: chrono::Utc::now().timestamp(),
                    activity: chrono::Utc::now().timestamp(),
                    folder: cwd.to_string(),
                    cols: 80,
                    rows: 24,
                    last_keys: Vec::new(),
                },
            );
            Ok(())
        }

        async fn capture_pane(&self, name: &str, _lines: usize) -> Result<String, ModelError> {
            let sessions = self.sessions.read().await;
            sessions
                .get(name)
                .map(|s| s.output.clone())
                .ok_or_else(|| ModelError::SessionNotFound(name.to_string()))
        }

        async fn send_keys(&self, name: &str, keys: &str) -> Result<(), ModelError> {
            let mut sessions = self.sessions.write().await;
            if let Some(session) = sessions.get_mut(name) {
                session.last_keys.push(keys.to_string());
                Ok(())
            } else {
                Err(ModelError::SessionNotFound(name.to_string()))
            }
        }

        async fn send_keys_raw(&self, name: &str, data: &str) -> Result<(), ModelError> {
            let mut sessions = self.sessions.write().await;
            if let Some(session) = sessions.get_mut(name) {
                session.last_keys.push(format!("raw:{}", data));
                Ok(())
            } else {
                Err(ModelError::SessionNotFound(name.to_string()))
            }
        }

        async fn resize_window(&self, name: &str, cols: u16, rows: u16) -> Result<(), ModelError> {
            let mut sessions = self.sessions.write().await;
            if let Some(session) = sessions.get_mut(name) {
                session.cols = cols;
                session.rows = rows;
                Ok(())
            } else {
                Err(ModelError::SessionNotFound(name.to_string()))
            }
        }

        async fn kill_session(&self, name: &str) -> Result<(), ModelError> {
            let mut sessions = self.sessions.write().await;
            if sessions.remove(name).is_some() {
                Ok(())
            } else {
                Err(ModelError::SessionNotFound(name.to_string()))
            }
        }
    }
}

// =============================================================================
// Unit Tests
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_list_sessions() {
        let output = "session1|1706972400|1706972500|/home/user/project1\nsession2|1706972600|1706972700|/home/user/project2\n";
        let sessions = parse_list_sessions(output);

        assert_eq!(sessions.len(), 2);
        assert_eq!(sessions[0].name, "session1");
        assert_eq!(sessions[0].created, 1706972400);
        assert_eq!(sessions[0].folder, "/home/user/project1");
        assert_eq!(sessions[1].name, "session2");
        assert_eq!(sessions[1].folder, "/home/user/project2");
    }

    #[test]
    fn test_parse_list_sessions_missing_folder() {
        let output = "session1|1706972400|1706972500\n";
        let sessions = parse_list_sessions(output);

        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].name, "session1");
        assert_eq!(sessions[0].folder, "");
    }

    #[test]
    fn test_parse_list_sessions_empty() {
        let sessions = parse_list_sessions("");
        assert!(sessions.is_empty());
    }

    #[tokio::test]
    async fn test_mock_tmux() {
        let mock = mock::MockTmux::new();

        // Initially empty
        let sessions = mock.list_sessions().await.unwrap();
        assert!(sessions.is_empty());

        // Add session
        mock.add_session("test", "some output").await;

        // Now has one session
        let sessions = mock.list_sessions().await.unwrap();
        assert_eq!(sessions.len(), 1);

        // Has session
        assert!(mock.has_session("test").await.unwrap());
        assert!(!mock.has_session("nonexistent").await.unwrap());

        // Capture pane
        let output = mock.capture_pane("test", 100).await.unwrap();
        assert_eq!(output, "some output");

        // Kill session
        mock.kill_session("test").await.unwrap();
        assert!(!mock.has_session("test").await.unwrap());
    }

    #[tokio::test]
    async fn test_mock_resize_window() {
        let mock = mock::MockTmux::new();
        mock.add_session("test", "output").await;

        // Default dimensions
        let dims = mock.get_dimensions("test").await.unwrap();
        assert_eq!(dims, (80, 24));

        // Resize
        mock.resize_window("test", 120, 40).await.unwrap();
        let dims = mock.get_dimensions("test").await.unwrap();
        assert_eq!(dims, (120, 40));
    }

    #[tokio::test]
    async fn test_mock_resize_window_nonexistent() {
        let mock = mock::MockTmux::new();
        let result = mock.resize_window("nonexistent", 120, 40).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_mock_send_keys_tracks_keys() {
        let mock = mock::MockTmux::new();
        mock.add_session("test", "output").await;

        mock.send_keys("test", "hello world").await.unwrap();
        mock.send_keys("test", "Enter").await.unwrap();

        let keys = mock.get_last_keys("test").await;
        assert_eq!(keys, vec!["hello world", "Enter"]);
    }

    #[tokio::test]
    async fn test_mock_send_keys_nonexistent() {
        let mock = mock::MockTmux::new();
        let result = mock.send_keys("nonexistent", "hello").await;
        assert!(result.is_err());
    }

    #[test]
    fn test_bare_keys_classification() {
        // These are the bare key names that should be sent without -l flag
        let bare_keys: &[&str] = &[
            "", "Enter", "Escape", "Up", "Down", "Left", "Right",
            "Tab", "BTab", "C-c", "C-d", "C-z", "y", "n",
        ];

        // Verify bare keys are recognized
        assert!(bare_keys.contains(&"Enter"));
        assert!(bare_keys.contains(&"Escape"));
        assert!(bare_keys.contains(&"C-c"));
        assert!(bare_keys.contains(&""));
        assert!(bare_keys.contains(&"y"));
        assert!(bare_keys.contains(&"n"));

        // Verify literal text is NOT a bare key
        assert!(!bare_keys.contains(&"hello world"));
        assert!(!bare_keys.contains(&"ls -la"));
        assert!(!bare_keys.contains(&"yes"));
    }
}
