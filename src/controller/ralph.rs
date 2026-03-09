//! Ralph Loop — Autonomous agent behavior
//!
//! Watches a session's status and auto-responds to prompts.
//! When the session is resting, optionally checks an inbox directory for new tasks.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use regex::Regex;
use tokio::task::JoinHandle;
use tracing::{debug, info, warn, error};

use crate::controller::deploy::{DeployResult, DeployState};
use crate::model::{SessionStatus, SharedSessionStates};
use crate::utils::{TmuxClient, WebPushClient};

/// What to do when the agent finishes a task (status = Resting)
#[derive(Debug, Clone)]
pub enum OnResting {
    /// Do nothing, wait for manual input
    Idle,
    /// Check inbox directory for new task files
    CheckInbox { path: PathBuf },
}

/// Pattern -> response mapping for auto-responding to prompts
#[derive(Debug, Clone)]
pub struct AutoResponse {
    pub pattern: Regex,
    pub response: String,
}

/// Auto-deploy configuration: build and deploy after maintainer changes the repo
#[derive(Clone)]
pub struct AutoDeployConfig {
    /// Path to the git repo to monitor
    pub repo_dir: String,
    /// Deploy state for triggering deploys
    pub deploy: DeployState,
    /// Push client for deploy notifications
    pub push: Arc<dyn WebPushClient>,
    /// Path to store the last-deployed commit hash
    pub last_commit_file: PathBuf,
}

impl std::fmt::Debug for AutoDeployConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AutoDeployConfig")
            .field("repo_dir", &self.repo_dir)
            .field("last_commit_file", &self.last_commit_file)
            .finish()
    }
}

/// Configuration for a ralph loop instance
#[derive(Debug, Clone)]
pub struct RalphConfig {
    pub session_id: String,
    pub auto_responses: Vec<AutoResponse>,
    pub max_auto_responses_per_task: u32,
    pub cooldown: Duration,
    pub on_resting: OnResting,
    /// Delay before checking inbox after resting (let things settle)
    pub inbox_check_delay: Duration,
    /// If set, auto-build and deploy after maintainer finishes a task with new commits
    pub auto_deploy: Option<AutoDeployConfig>,
}

/// Handle to control a running ralph loop
pub struct RalphHandle {
    pub(crate) handle: JoinHandle<()>,
    paused: Arc<AtomicBool>,
}

impl RalphHandle {
    pub fn pause(&self) {
        self.paused.store(true, Ordering::Relaxed);
        info!("Ralph loop paused");
    }

    pub fn resume(&self) {
        self.paused.store(false, Ordering::Relaxed);
        info!("Ralph loop resumed");
    }

    pub fn is_paused(&self) -> bool {
        self.paused.load(Ordering::Relaxed)
    }

    pub fn abort(&self) {
        self.handle.abort();
        info!("Ralph loop aborted");
    }
}

/// Start a ralph loop for a session
pub fn start_ralph_loop(
    config: RalphConfig,
    tmux: Arc<dyn TmuxClient>,
    session_states: SharedSessionStates,
) -> RalphHandle {
    let paused = Arc::new(AtomicBool::new(false));
    let paused_clone = paused.clone();

    let handle = tokio::spawn(async move {
        info!(session = %config.session_id, "Ralph loop started");

        let poll_interval = Duration::from_millis(500);
        let mut auto_response_count: u32 = 0;
        let mut last_response_time = tokio::time::Instant::now();
        let mut was_working = false;
        let mut last_inbox_check = tokio::time::Instant::now() - Duration::from_secs(999);

        loop {
            tokio::time::sleep(poll_interval).await;

            // Check if paused
            if paused_clone.load(Ordering::Relaxed) {
                continue;
            }

            // Check if session still exists
            match tmux.has_session(&config.session_id).await {
                Ok(true) => {}
                Ok(false) => {
                    info!(session = %config.session_id, "Session ended, stopping ralph loop");
                    break;
                }
                Err(e) => {
                    warn!(session = %config.session_id, error = %e, "Error checking session");
                    continue;
                }
            }

            // Read current status from shared state
            let status = {
                let states = session_states.read().await;
                states.get(&config.session_id).map(|s| s.status)
            };

            let Some(status) = status else {
                debug!(session = %config.session_id, "Session not in state map");
                continue;
            };

            match status {
                SessionStatus::Working => {
                    was_working = true;
                }
                SessionStatus::NeedsInput => {
                    // Check iteration limit
                    if auto_response_count >= config.max_auto_responses_per_task {
                        warn!(
                            session = %config.session_id,
                            count = auto_response_count,
                            max = config.max_auto_responses_per_task,
                            "Max auto-responses reached, waiting for manual intervention"
                        );
                        continue;
                    }

                    // Enforce cooldown
                    let elapsed = last_response_time.elapsed();
                    if elapsed < config.cooldown {
                        tokio::time::sleep(config.cooldown - elapsed).await;
                    }

                    // Capture output and match patterns
                    let output = match tmux.capture_pane(&config.session_id, 50).await {
                        Ok(o) => o,
                        Err(e) => {
                            warn!(session = %config.session_id, error = %e, "Failed to capture pane");
                            continue;
                        }
                    };

                    let last_lines: String = output
                        .lines()
                        .rev()
                        .take(10)
                        .collect::<Vec<_>>()
                        .into_iter()
                        .rev()
                        .collect::<Vec<_>>()
                        .join("\n");

                    // Find matching auto-response
                    let response = config.auto_responses.iter().find_map(|ar| {
                        if ar.pattern.is_match(&last_lines) {
                            Some(ar.response.clone())
                        } else {
                            None
                        }
                    });

                    if let Some(response) = response {
                        info!(
                            session = %config.session_id,
                            response = %response,
                            "Ralph auto-responding"
                        );

                        if let Err(e) = tmux.send_keys(&config.session_id, &response).await {
                            error!(session = %config.session_id, error = %e, "Failed to send auto-response");
                        } else {
                            auto_response_count += 1;
                            last_response_time = tokio::time::Instant::now();
                        }
                    } else {
                        debug!(session = %config.session_id, "No matching auto-response pattern");
                    }
                }
                SessionStatus::Resting => {
                    // Check inbox periodically while resting (every 30s),
                    // or immediately after a task completes
                    let inbox_interval = Duration::from_secs(30);
                    if !was_working && last_inbox_check.elapsed() < inbox_interval {
                        continue;
                    }

                    // Task finished (or time to re-check) — reset counter
                    auto_response_count = 0;
                    was_working = false;
                    last_inbox_check = tokio::time::Instant::now();

                    // Handle on_resting behavior
                    match &config.on_resting {
                        OnResting::Idle => {
                            // Do nothing, wait
                        }
                        OnResting::CheckInbox { path } => {
                            // Wait a bit before checking inbox
                            tokio::time::sleep(config.inbox_check_delay).await;

                            match pick_next_inbox_item(path).await {
                                Ok(Some((file_path, content))) => {
                                    info!(
                                        session = %config.session_id,
                                        file = %file_path.display(),
                                        "Found inbox item, sending to maintainer"
                                    );

                                    // Move to processing
                                    let processing_dir = path.join("processing");
                                    let _ = tokio::fs::create_dir_all(&processing_dir).await;
                                    let filename = file_path.file_name().unwrap_or_default();
                                    let processing_path = processing_dir.join(filename);
                                    if let Err(e) = tokio::fs::rename(&file_path, &processing_path).await {
                                        warn!(error = %e, "Failed to move inbox item to processing");
                                    }

                                    // Send content as input to session
                                    if let Err(e) = tmux.send_keys(&config.session_id, &content).await {
                                        error!(
                                            session = %config.session_id,
                                            error = %e,
                                            "Failed to send inbox item to session"
                                        );
                                        // Move back to inbox on failure
                                        let _ = tokio::fs::rename(&processing_path, &file_path).await;
                                    } else {
                                        was_working = true; // Expect it to start working
                                        // Move to done after a short delay
                                        let done_dir = path.join("done");
                                        let _ = tokio::fs::create_dir_all(&done_dir).await;
                                        let done_path = done_dir.join(filename);
                                        tokio::spawn(async move {
                                            // Wait for task to be picked up before archiving
                                            tokio::time::sleep(Duration::from_secs(5)).await;
                                            if let Err(e) = tokio::fs::rename(&processing_path, &done_path).await {
                                                tracing::warn!(
                                                    error = %e,
                                                    from = %processing_path.display(),
                                                    to = %done_path.display(),
                                                    "Failed to archive inbox item to done"
                                                );
                                            }
                                        });
                                    }
                                }
                                Ok(None) => {
                                    debug!(session = %config.session_id, "No inbox items");
                                    // No inbox work — check if we should auto-deploy
                                    maybe_auto_deploy(&config).await;
                                }
                                Err(e) => {
                                    warn!(session = %config.session_id, error = %e, "Error checking inbox");
                                }
                            }
                        }
                    }
                }
                SessionStatus::Error => {
                    // On error, treat like NeedsInput — try to auto-respond
                    // but with more caution (don't auto-respond to errors by default)
                    debug!(session = %config.session_id, "Session in error state");
                }
            }
        }

        info!(session = %config.session_id, "Ralph loop ended");
    });

    RalphHandle { handle, paused }
}

/// Check if the repo has new commits since last deploy, and if so build + deploy.
async fn maybe_auto_deploy(config: &RalphConfig) {
    let ad = match &config.auto_deploy {
        Some(ad) => ad,
        None => return,
    };

    // Don't deploy if one is already pending
    if ad.deploy.is_pending() {
        debug!(session = %config.session_id, "Deploy already pending, skipping auto-deploy");
        return;
    }

    // Check current HEAD
    let head = match crate::utils::git::get_head_commit(&ad.repo_dir).await {
        Some(h) => h,
        None => {
            debug!(session = %config.session_id, "Could not get HEAD commit");
            return;
        }
    };

    // Compare with last deployed commit
    let last_deployed = tokio::fs::read_to_string(&ad.last_commit_file)
        .await
        .ok()
        .map(|s| s.trim().to_string());

    if last_deployed.as_deref() == Some(&head) {
        debug!(session = %config.session_id, commit = %head, "No new commits since last deploy");
        return;
    }

    info!(
        session = %config.session_id,
        head = %head,
        last_deployed = ?last_deployed,
        "New commits detected, starting auto-build"
    );

    // Build frontend + backend
    match run_full_build(&ad.repo_dir).await {
        Ok(()) => {
            info!(session = %config.session_id, "Full build succeeded, triggering deploy");
        }
        Err(e) => {
            warn!(session = %config.session_id, error = %e, "Auto-build failed, skipping deploy");
            return;
        }
    }

    // Trigger deploy
    let result = ad.deploy.execute(&ad.push).await;
    match &result {
        DeployResult::ReExec { .. } => {
            // Record the deployed commit before re-exec
            let _ = tokio::fs::write(&ad.last_commit_file, &head).await;
            info!(session = %config.session_id, commit = %head, "Auto-deploy successful, re-execing");
            // Small delay to let logs flush, then re-exec
            tokio::time::sleep(Duration::from_secs(2)).await;
            crate::controller::deploy::re_exec();
        }
        DeployResult::Aborted => {
            info!(session = %config.session_id, "Auto-deploy aborted");
        }
        DeployResult::Failed(msg) => {
            warn!(session = %config.session_id, error = %msg, "Auto-deploy failed");
        }
        DeployResult::RateLimited { next_allowed } => {
            debug!(session = %config.session_id, next = %next_allowed, "Auto-deploy rate limited");
        }
    }
}

/// Build the full project: frontend (npm) + backend (cargo).
async fn run_full_build(repo_dir: &str) -> Result<(), String> {
    // 1. Build frontend
    let app_dir = Path::new(repo_dir).join("app");
    if app_dir.join("package.json").exists() {
        info!("Building frontend...");
        let output = tokio::process::Command::new("npm")
            .arg("run")
            .arg("build")
            .current_dir(&app_dir)
            .output()
            .await
            .map_err(|e| format!("Failed to spawn npm: {}", e))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!("npm build failed: {}", stderr));
        }
        info!("Frontend build succeeded");
    }

    // 2. Build backend
    info!("Building backend...");
    let output = tokio::process::Command::new("cargo")
        .arg("build")
        .arg("--release")
        .current_dir(repo_dir)
        .output()
        .await
        .map_err(|e| format!("Failed to spawn cargo: {}", e))?;

    if output.status.success() {
        info!("Backend build succeeded");
        // Touch the binary to ensure a fresh timestamp even for frontend-only changes,
        // so the deploy pipeline's "newer than current" check passes.
        let binary = Path::new(repo_dir).join("target/release/woodchuck");
        let _ = filetime::set_file_mtime(
            &binary,
            filetime::FileTime::now(),
        );
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(format!("cargo build failed: {}", stderr))
    }
}

/// Pick the oldest file from the inbox directory
pub(crate) async fn pick_next_inbox_item(inbox_path: &Path) -> Result<Option<(PathBuf, String)>, std::io::Error> {
    let mut dir = tokio::fs::read_dir(inbox_path).await?;
    let mut oldest: Option<(PathBuf, std::time::SystemTime)> = None;

    while let Some(entry) = dir.next_entry().await? {
        let path = entry.path();

        // Only process .md files in the root inbox dir (not subdirs)
        if !path.is_file() || path.extension().and_then(|e| e.to_str()) != Some("md") {
            continue;
        }

        let metadata = entry.metadata().await?;
        let modified = metadata.modified().unwrap_or(std::time::SystemTime::UNIX_EPOCH);

        match &oldest {
            None => oldest = Some((path, modified)),
            Some((_, old_time)) if modified < *old_time => {
                oldest = Some((path, modified));
            }
            _ => {}
        }
    }

    match oldest {
        Some((path, _)) => {
            let content = tokio::fs::read_to_string(&path).await?;
            Ok(Some((path, content)))
        }
        None => Ok(None),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::new_shared_states;
    use crate::utils::tmux::mock::MockTmux;

    fn make_auto_responses() -> Vec<AutoResponse> {
        vec![
            AutoResponse {
                pattern: Regex::new(r"(?i)\(y/n\)").unwrap(),
                response: "y".to_string(),
            },
            AutoResponse {
                pattern: Regex::new(r"Press Enter").unwrap(),
                response: String::new(),
            },
        ]
    }

    #[tokio::test]
    async fn test_ralph_handle_pause_resume() {
        let tmux = Arc::new(MockTmux::new());
        tmux.add_session("test-session", "output").await;

        let states = new_shared_states();
        {
            let mut s = states.write().await;
            s.insert("test-session".to_string(), crate::model::SessionState::new());
        }

        let config = RalphConfig {
            session_id: "test-session".to_string(),
            auto_responses: make_auto_responses(),
            max_auto_responses_per_task: 5,
            cooldown: Duration::from_millis(100),
            on_resting: OnResting::Idle,
            inbox_check_delay: Duration::from_millis(100),
            auto_deploy: None,
        };

        let handle = start_ralph_loop(config, tmux, states);

        assert!(!handle.is_paused());
        handle.pause();
        assert!(handle.is_paused());
        handle.resume();
        assert!(!handle.is_paused());
        handle.abort();
    }

    #[tokio::test]
    async fn test_ralph_stops_when_session_ends() {
        let tmux = Arc::new(MockTmux::new());
        // Don't add any session — ralph should detect it's gone and stop

        let states = new_shared_states();

        let config = RalphConfig {
            session_id: "nonexistent".to_string(),
            auto_responses: vec![],
            max_auto_responses_per_task: 5,
            cooldown: Duration::from_millis(50),
            on_resting: OnResting::Idle,
            inbox_check_delay: Duration::from_millis(50),
            auto_deploy: None,
        };

        let handle = start_ralph_loop(config, tmux, states);

        // Wait for the loop to detect the session is gone
        tokio::time::sleep(Duration::from_millis(800)).await;

        // The handle's task should have completed
        assert!(handle.handle.is_finished());
    }

    #[tokio::test]
    async fn test_pick_next_inbox_item_empty_dir() {
        let dir = tempfile::tempdir().unwrap();
        let result = pick_next_inbox_item(dir.path()).await.unwrap();
        assert!(result.is_none());
    }

    #[tokio::test]
    async fn test_pick_next_inbox_item_finds_oldest() {
        let dir = tempfile::tempdir().unwrap();

        // Create two files with different names (sorted alphabetically = chronologically)
        tokio::fs::write(dir.path().join("20260101-first.md"), "first item").await.unwrap();
        tokio::time::sleep(Duration::from_millis(50)).await;
        tokio::fs::write(dir.path().join("20260102-second.md"), "second item").await.unwrap();

        let result = pick_next_inbox_item(dir.path()).await.unwrap();
        assert!(result.is_some());
        let (path, content) = result.unwrap();
        assert!(path.to_string_lossy().contains("first"));
        assert_eq!(content, "first item");
    }

    #[tokio::test]
    async fn test_pick_next_inbox_item_ignores_non_md() {
        let dir = tempfile::tempdir().unwrap();

        tokio::fs::write(dir.path().join("not-a-task.txt"), "ignore me").await.unwrap();
        tokio::fs::write(dir.path().join("task.md"), "pick me").await.unwrap();

        let result = pick_next_inbox_item(dir.path()).await.unwrap();
        assert!(result.is_some());
        let (path, content) = result.unwrap();
        assert!(path.to_string_lossy().contains("task.md"));
        assert_eq!(content, "pick me");
    }

    #[tokio::test]
    async fn test_pick_next_inbox_item_ignores_subdirs() {
        let dir = tempfile::tempdir().unwrap();

        // Create a subdirectory with a .md file — should be ignored
        let subdir = dir.path().join("processing");
        tokio::fs::create_dir_all(&subdir).await.unwrap();
        tokio::fs::write(subdir.join("old.md"), "in processing").await.unwrap();

        let result = pick_next_inbox_item(dir.path()).await.unwrap();
        assert!(result.is_none());
    }
}
