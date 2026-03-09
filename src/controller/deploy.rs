//! Deploy Pipeline
//!
//! Handles self-upgrade: build verification, binary swap, countdown with abort,
//! graceful re-exec, and rollback on failure.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use chrono::{DateTime, Utc};
use tokio::sync::Notify;
use tracing::{error, info, warn};

use crate::utils::WebPushClient;

/// Minimum time between deploys (1 hour)
const DEPLOY_COOLDOWN_SECS: i64 = 3600;

/// Countdown before deploy executes (seconds)
const DEPLOY_COUNTDOWN_SECS: u64 = 60;

/// Deploy state shared between the pipeline and API handlers
#[derive(Clone)]
pub struct DeployState {
    inner: Arc<DeployInner>,
}

struct DeployInner {
    /// Whether a deploy is currently pending (in countdown)
    pending: AtomicBool,
    /// Signal to abort a pending deploy
    abort: Notify,
    /// Data directory for deploy artifacts
    data_dir: PathBuf,
    /// Path to the repo (for finding built binaries)
    repo_dir: PathBuf,
    /// Path to the currently running binary
    current_binary: PathBuf,
}

/// Result of a deploy attempt
#[derive(Debug)]
pub enum DeployResult {
    /// Deploy executed successfully, process should re-exec
    ReExec { new_binary: PathBuf },
    /// Deploy was aborted during countdown
    Aborted,
    /// Deploy failed
    Failed(String),
    /// Rate limited — too soon since last deploy
    RateLimited { next_allowed: DateTime<Utc> },
}

/// Serializable deploy status for the API
#[derive(Debug, Clone, serde::Serialize)]
pub struct DeployStatus {
    pub pending: bool,
    pub last_deploy: Option<String>,
    pub cooldown_remaining_secs: Option<i64>,
}

impl DeployState {
    /// Create a new deploy state
    pub fn new(data_dir: &str) -> Self {
        let current_binary = std::env::current_exe()
            .unwrap_or_else(|_| PathBuf::from("woodchuck"));
        let repo_dir = std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."));

        Self {
            inner: Arc::new(DeployInner {
                pending: AtomicBool::new(false),
                abort: Notify::new(),
                data_dir: PathBuf::from(data_dir),
                repo_dir,
                current_binary,
            }),
        }
    }

    /// Create a new deploy state with explicit repo directory (for testing)
    #[cfg(test)]
    pub fn new_with_repo(data_dir: &str, repo_dir: &str) -> Self {
        let current_binary = std::env::current_exe()
            .unwrap_or_else(|_| PathBuf::from("woodchuck"));

        Self {
            inner: Arc::new(DeployInner {
                pending: AtomicBool::new(false),
                abort: Notify::new(),
                data_dir: PathBuf::from(data_dir),
                repo_dir: PathBuf::from(repo_dir),
                current_binary,
            }),
        }
    }

    /// Whether a deploy is currently pending (in countdown)
    pub fn is_pending(&self) -> bool {
        self.inner.pending.load(Ordering::Relaxed)
    }

    /// Abort a pending deploy
    pub fn abort(&self) {
        if self.inner.pending.load(Ordering::Relaxed) {
            info!("Deploy abort requested");
            self.inner.abort.notify_one();
        }
    }

    /// Get current deploy status
    pub fn status(&self) -> DeployStatus {
        let last_deploy = self.read_last_deploy_time();
        let cooldown_remaining = last_deploy.map(|t| {
            let elapsed = (Utc::now() - t).num_seconds();
            (DEPLOY_COOLDOWN_SECS - elapsed).max(0)
        });

        DeployStatus {
            pending: self.is_pending(),
            last_deploy: last_deploy.map(|t| t.to_rfc3339()),
            cooldown_remaining_secs: cooldown_remaining,
        }
    }

    /// Execute the deploy pipeline
    ///
    /// Steps:
    /// 1. Check rate limit
    /// 2. Verify new binary exists at `target/release/woodchuck`
    /// 3. Copy current binary to `{data_dir}/woodchuck-prev` (rollback)
    /// 4. Send push notification with countdown
    /// 5. Wait countdown (abortable)
    /// 6. Swap binary
    /// 7. Return ReExec signal
    pub async fn execute(&self, push: &Arc<dyn WebPushClient>) -> DeployResult {
        // 1. Rate limit check
        if let Some(last) = self.read_last_deploy_time() {
            let elapsed = (Utc::now() - last).num_seconds();
            if elapsed < DEPLOY_COOLDOWN_SECS {
                let next_allowed = last + chrono::Duration::seconds(DEPLOY_COOLDOWN_SECS);
                return DeployResult::RateLimited { next_allowed };
            }
        }

        // Prevent concurrent deploys
        if self.inner.pending.swap(true, Ordering::SeqCst) {
            return DeployResult::Failed("Deploy already in progress".to_string());
        }

        let result = self.execute_inner(push).await;

        self.inner.pending.store(false, Ordering::SeqCst);
        result
    }

    async fn execute_inner(&self, push: &Arc<dyn WebPushClient>) -> DeployResult {
        // 2. Find new binary
        let new_binary = self.find_new_binary();
        let new_binary = match new_binary {
            Some(p) => p,
            None => return DeployResult::Failed("No new binary found at target/release/woodchuck".to_string()),
        };

        // Verify new binary is newer than current
        let new_meta = match std::fs::metadata(&new_binary) {
            Ok(m) => m,
            Err(e) => return DeployResult::Failed(format!("Cannot read new binary: {}", e)),
        };
        let cur_meta = std::fs::metadata(&self.inner.current_binary).ok();
        if let Some(ref cur) = cur_meta {
            if let (Ok(new_mod), Ok(cur_mod)) = (new_meta.modified(), cur.modified()) {
                if new_mod <= cur_mod {
                    return DeployResult::Failed("New binary is not newer than current".to_string());
                }
            }
        }

        // 3. Backup current binary (required for rollback — abort if fails)
        let prev_path = self.inner.data_dir.join("woodchuck-prev");
        if let Err(e) = std::fs::copy(&self.inner.current_binary, &prev_path) {
            return DeployResult::Failed(format!(
                "Failed to backup current binary (no rollback possible): {}", e
            ));
        }
        info!(path = %prev_path.display(), "Backed up current binary");

        // 4. Send push notification
        let payload = serde_json::json!({
            "title": "Woodchuck Self-Upgrade",
            "body": format!("Deploying in {} seconds. Open settings to abort.", DEPLOY_COUNTDOWN_SECS),
            "type": "deploy_countdown",
        });
        if let Err(e) = push.send_to_all(&payload.to_string()).await {
            warn!(error = %e, "Failed to send deploy countdown notification");
        }

        info!(countdown = DEPLOY_COUNTDOWN_SECS, "Deploy countdown started");

        // 5. Countdown with abort
        let aborted = self.countdown().await;
        if aborted {
            info!("Deploy aborted during countdown");

            let payload = serde_json::json!({
                "title": "Woodchuck Deploy Aborted",
                "body": "Self-upgrade was cancelled.",
                "type": "deploy_aborted",
            });
            let _ = push.send_to_all(&payload.to_string()).await;

            return DeployResult::Aborted;
        }

        // 6. Copy new binary to current location
        let next_path = self.inner.data_dir.join("woodchuck-next");
        if let Err(e) = std::fs::copy(&new_binary, &next_path) {
            return DeployResult::Failed(format!("Failed to stage new binary: {}", e));
        }

        if let Err(e) = std::fs::copy(&next_path, &self.inner.current_binary) {
            // Try rollback
            warn!(error = %e, "Failed to install new binary, rolling back");
            if let Err(rb_err) = std::fs::copy(&prev_path, &self.inner.current_binary) {
                error!(error = %rb_err, "ROLLBACK FAILED — manual intervention needed");
            }
            return DeployResult::Failed(format!("Failed to install binary: {}", e));
        }

        // Clean up staging file
        let _ = std::fs::remove_file(&next_path);

        // 7. Record deploy time
        self.write_last_deploy_time();

        info!("Binary swapped, signaling re-exec");

        // Notify success
        let payload = serde_json::json!({
            "title": "Woodchuck Upgrading",
            "body": "Restarting with new binary. Back in a few seconds.",
            "type": "deploy_restarting",
        });
        let _ = push.send_to_all(&payload.to_string()).await;

        DeployResult::ReExec { new_binary: self.inner.current_binary.clone() }
    }

    /// Run countdown, returns true if aborted
    async fn countdown(&self) -> bool {
        let abort_fut = self.inner.abort.notified();
        let timer = tokio::time::sleep(Duration::from_secs(DEPLOY_COUNTDOWN_SECS));

        tokio::select! {
            _ = abort_fut => true,
            _ = timer => false,
        }
    }

    /// Find the new binary (built by maintainer)
    fn find_new_binary(&self) -> Option<PathBuf> {
        let candidates = [
            self.inner.repo_dir.join("target/release/woodchuck"),
            self.inner.data_dir.join("woodchuck-next"),
        ];

        for candidate in &candidates {
            if candidate.is_file() {
                return Some(candidate.clone());
            }
        }
        None
    }

    /// Read the last deploy timestamp
    fn read_last_deploy_time(&self) -> Option<DateTime<Utc>> {
        let path = self.inner.data_dir.join("last-deploy");
        let content = std::fs::read_to_string(path).ok()?;
        content.trim().parse::<DateTime<Utc>>().ok()
    }

    /// Write the current time as last deploy
    fn write_last_deploy_time(&self) {
        let path = self.inner.data_dir.join("last-deploy");
        let _ = std::fs::write(path, Utc::now().to_rfc3339());
    }

    /// Get the rollback binary path
    pub fn rollback_path(&self) -> PathBuf {
        self.inner.data_dir.join("woodchuck-prev")
    }

    /// Perform rollback: restore previous binary
    pub fn rollback(&self) -> Result<(), String> {
        let prev = self.rollback_path();
        if !prev.is_file() {
            return Err("No rollback binary found".to_string());
        }
        std::fs::copy(&prev, &self.inner.current_binary)
            .map_err(|e| format!("Rollback failed: {}", e))?;
        info!("Rolled back to previous binary");
        Ok(())
    }
}

/// Re-exec the current process with the same arguments.
///
/// This replaces the current process entirely (Unix exec).
/// Only call this after graceful shutdown of HTTP/WS/poller.
#[cfg(unix)]
pub fn re_exec() -> ! {
    use std::os::unix::process::CommandExt;

    let exe = std::env::current_exe().expect("Failed to get current exe path");
    let args: Vec<String> = std::env::args().collect();

    info!(binary = %exe.display(), "Re-execing process");

    let err = std::process::Command::new(&exe)
        .args(&args[1..])
        .exec();

    // exec() only returns on error
    panic!("Failed to re-exec: {}", err);
}

#[cfg(not(unix))]
pub fn re_exec() -> ! {
    panic!("Re-exec not supported on this platform");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_deploy_state_new() {
        let state = DeployState::new("/tmp/test-woodchuck");
        assert!(!state.is_pending());
    }

    #[test]
    fn test_deploy_status_not_pending() {
        let state = DeployState::new("/tmp/test-woodchuck");
        let status = state.status();
        assert!(!status.pending);
        assert!(status.last_deploy.is_none());
    }

    #[test]
    fn test_abort_when_not_pending() {
        let state = DeployState::new("/tmp/test-woodchuck");
        // Should not panic
        state.abort();
        assert!(!state.is_pending());
    }

    #[tokio::test]
    async fn test_countdown_abort() {
        let state = DeployState::new("/tmp/test-woodchuck");
        state.inner.pending.store(true, Ordering::SeqCst);

        // Abort immediately
        let state2 = state.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(50)).await;
            state2.abort();
        });

        let aborted = state.countdown().await;
        assert!(aborted);
    }

    #[test]
    fn test_deploy_rate_limit_tracking() {
        let dir = tempfile::tempdir().unwrap();
        let state = DeployState::new(dir.path().to_str().unwrap());

        // No last deploy
        assert!(state.read_last_deploy_time().is_none());

        // Write deploy time
        state.write_last_deploy_time();
        let last = state.read_last_deploy_time();
        assert!(last.is_some());

        // Should be within the last few seconds
        let elapsed = (Utc::now() - last.unwrap()).num_seconds();
        assert!(elapsed < 5);
    }

    #[test]
    fn test_deploy_status_with_recent_deploy() {
        let dir = tempfile::tempdir().unwrap();
        let state = DeployState::new(dir.path().to_str().unwrap());

        state.write_last_deploy_time();
        let status = state.status();

        assert!(status.last_deploy.is_some());
        // Should have cooldown remaining (just deployed)
        assert!(status.cooldown_remaining_secs.unwrap() > 3500);
    }

    #[test]
    fn test_rollback_no_binary() {
        let dir = tempfile::tempdir().unwrap();
        let state = DeployState::new(dir.path().to_str().unwrap());
        let result = state.rollback();
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("No rollback binary"));
    }

    #[test]
    fn test_find_new_binary_not_found() {
        let dir = tempfile::tempdir().unwrap();
        let repo_dir = tempfile::tempdir().unwrap();
        let state = DeployState::new_with_repo(dir.path().to_str().unwrap(), repo_dir.path().to_str().unwrap());
        assert!(state.find_new_binary().is_none());
    }

    #[tokio::test]
    async fn test_execute_no_binary_fails() {
        let dir = tempfile::tempdir().unwrap();
        let repo_dir = tempfile::tempdir().unwrap();
        let state = DeployState::new_with_repo(dir.path().to_str().unwrap(), repo_dir.path().to_str().unwrap());
        let push: Arc<dyn WebPushClient> = Arc::new(crate::utils::NoopWebPush);

        let result = state.execute(&push).await;
        assert!(matches!(result, DeployResult::Failed(msg) if msg.contains("No new binary")));
        assert!(!state.is_pending()); // cleaned up
    }

    #[tokio::test]
    async fn test_execute_rate_limited() {
        let dir = tempfile::tempdir().unwrap();
        let state = DeployState::new(dir.path().to_str().unwrap());

        // Fake a recent deploy
        state.write_last_deploy_time();

        let push: Arc<dyn WebPushClient> = Arc::new(crate::utils::NoopWebPush);
        let result = state.execute(&push).await;
        assert!(matches!(result, DeployResult::RateLimited { .. }));
    }
}
