//! Session business logic
//!
//! Pure functions for session management operations.
//! All tmux interaction is through the TmuxClient trait.

use std::borrow::Cow;
use std::fs::canonicalize;
use std::path::Path;
use chrono::{TimeZone, Utc};
use rand::Rng;
use shell_escape::escape;
use tracing::{debug, info, instrument};

use super::error::{ModelError, Result};
use super::output::detect_status;
use super::types::{CreateSessionParams, Session, SessionStatus};
use crate::config::Config;
use crate::utils::detect_git_branch;
use crate::utils::tmux::TmuxClient;

/// Validate that a session ID contains only safe characters.
///
/// Uses a positive allowlist: only alphanumeric, hyphens, and underscores.
/// This prevents tmux metacharacter injection (`;`, `{`, `}`, `$`, etc.).
fn validate_session_id(id: &str) -> Result<()> {
    if id.is_empty() {
        return Err(ModelError::InvalidInput("Session ID cannot be empty".to_string()));
    }
    if id.len() > 128 {
        return Err(ModelError::InvalidInput("Session ID too long".to_string()));
    }
    if id.starts_with('-') {
        return Err(ModelError::InvalidInput("Session ID cannot start with a hyphen".to_string()));
    }
    if !id.chars().all(|c| c.is_alphanumeric() || c == '-' || c == '_') {
        return Err(ModelError::InvalidInput(
            "Session ID contains invalid characters (only alphanumeric, hyphens, and underscores allowed)".to_string(),
        ));
    }
    Ok(())
}

/// Validate user-provided session name (display name).
///
/// Relaxed validation: allows any printable characters.
fn validate_session_name(name: &str) -> Result<()> {
    if name.is_empty() {
        return Err(ModelError::InvalidInput("Session name cannot be empty".to_string()));
    }
    if name.len() > 100 {
        return Err(ModelError::InvalidInput("Session name too long (max 100 chars)".to_string()));
    }
    // Allow any printable characters (relaxed validation for display names)
    if !name.chars().all(|c| !c.is_control()) {
        return Err(ModelError::InvalidInput("Session name contains control characters".to_string()));
    }
    Ok(())
}

/// Generate a unique session ID from folder path.
///
/// Format: `{folder_name}_{random_6chars}`
/// - Extracts folder name from path
/// - Sanitizes to alphanumeric + hyphens + underscores
/// - Adds 6-character random suffix
fn generate_session_id(folder: &str) -> String {
    // Extract folder name from path
    let folder_name = Path::new(folder)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("session");

    // Sanitize: keep only alphanumeric, hyphens, underscores
    let sanitized: String = folder_name
        .chars()
        .filter(|c| c.is_alphanumeric() || *c == '-' || *c == '_')
        .collect();

    // Use "session" if sanitized is empty
    let base = if sanitized.is_empty() {
        "session".to_string()
    } else {
        sanitized
    };

    // Generate 6-character random suffix (alphanumeric)
    let suffix: String = rand::thread_rng()
        .sample_iter(&rand::distributions::Alphanumeric)
        .take(6)
        .map(char::from)
        .collect();

    format!("{}_{}", base, suffix)
}

/// List all active Claude sessions
#[instrument(skip(tmux))]
pub async fn list_sessions(tmux: &(impl TmuxClient + ?Sized)) -> Result<Vec<Session>> {
    let raw_sessions = tmux.list_sessions().await?;

    // W2 FIX: Run all capture_pane + detect_git_branch calls concurrently
    let futures: Vec<_> = raw_sessions.iter().map(|info| {
        let name = info.name.clone();
        let folder = info.folder.clone();
        async move {
            let (output, git_branch) = tokio::join!(
                tmux.capture_pane(&name, 50),
                detect_git_branch(&folder)
            );
            (output.unwrap_or_default(), git_branch)
        }
    }).collect();

    let results = futures::future::join_all(futures).await;

    let sessions: Vec<Session> = raw_sessions.into_iter().zip(results).map(|(info, (output, git_branch))| {
        let status = detect_status(&output);

        let created_at = Utc.timestamp_opt(info.created, 0)
            .single()
            .unwrap_or_else(Utc::now);
        let updated_at = Utc.timestamp_opt(info.activity, 0)
            .single()
            .unwrap_or_else(Utc::now);

        Session {
            id: info.name.clone(),
            name: info.name,
            folder: info.folder,
            git_branch,
            status,
            created_at,
            updated_at,
            working_since: None, // Will be overlaid from shared state in handler
            project_id: None,    // Will be overlaid from shared state in handler
            last_input: None,    // Will be overlaid from shared state in handler
        }
    }).collect();

    info!(count = sessions.len(), "Listed sessions");
    Ok(sessions)
}

/// Get a specific session by ID
#[instrument(skip(tmux))]
pub async fn get_session(tmux: &(impl TmuxClient + ?Sized), session_id: &str) -> Result<Session> {
    validate_session_id(session_id)?;

    // Single call: list_sessions already tells us if the session exists
    let raw_sessions = tmux.list_sessions().await?;
    let info = raw_sessions
        .into_iter()
        .find(|s| s.name == session_id)
        .ok_or_else(|| ModelError::SessionNotFound(session_id.to_string()))?;

    let (output, git_branch) = tokio::join!(
        tmux.capture_pane(session_id, 50),
        detect_git_branch(&info.folder)
    );
    let output = output.unwrap_or_default();
    let status = detect_status(&output);

    let created_at = Utc.timestamp_opt(info.created, 0)
        .single()
        .unwrap_or_else(Utc::now);
    let updated_at = Utc.timestamp_opt(info.activity, 0)
        .single()
        .unwrap_or_else(Utc::now);

    Ok(Session {
        id: info.name.clone(),
        name: info.name,
        folder: info.folder,
        git_branch,
        status,
        created_at,
        updated_at,
        working_since: None, // Will be overlaid from shared state in handler
        project_id: None,    // Will be overlaid from shared state in handler
        last_input: None,    // Will be overlaid from shared state in handler
    })
}

/// Get session output (recent terminal content)
#[instrument(skip(tmux))]
pub async fn get_session_output(tmux: &(impl TmuxClient + ?Sized), session_id: &str, lines: usize) -> Result<String> {
    if !tmux.has_session(session_id).await? {
        return Err(ModelError::SessionNotFound(session_id.to_string()));
    }

    tmux.capture_pane(session_id, lines).await
}

/// Create a new Claude session
#[instrument(skip(tmux, config), fields(session_name = %params.name))]
pub async fn create_session(
    tmux: &(impl TmuxClient + ?Sized),
    config: &Config,
    params: CreateSessionParams,
) -> Result<Session> {
    // Validate user-provided display name (relaxed validation)
    validate_session_name(&params.name)?;

    if params.folder.is_empty() {
        return Err(ModelError::InvalidInput("Folder cannot be empty".to_string()));
    }

    // Validate folder is within projects_dir (path traversal protection)
    let canonical_folder = canonicalize(&params.folder)
        .map_err(|_| ModelError::FolderNotFound(params.folder.clone()))?;
    let canonical_projects = canonicalize(&config.projects_dir)
        .map_err(|_| ModelError::InvalidInput("Invalid projects_dir configuration".to_string()))?;

    if !canonical_folder.starts_with(&canonical_projects) {
        return Err(ModelError::InvalidInput(
            "Folder must be within projects directory".to_string()
        ));
    }

    // Check folder exists (redundant after canonicalize but explicit)
    if !Path::new(&params.folder).is_dir() {
        return Err(ModelError::FolderNotFound(params.folder.clone()));
    }

    // Generate unique session ID from folder path
    let session_id = generate_session_id(&params.folder);

    // Check generated ID doesn't already exist (extremely unlikely with 6-char random suffix)
    if tmux.has_session(&session_id).await? {
        return Err(ModelError::SessionAlreadyExists(session_id));
    }

    // Build the command — start claude with optional prompt
    let cmd = if params.prompt.is_empty() {
        "claude".to_string()
    } else {
        let escaped_prompt = escape(Cow::Borrowed(&params.prompt));
        format!("claude {}", escaped_prompt)
    };

    // Detect git branch before creating session (folder already validated)
    let git_branch = detect_git_branch(&params.folder).await;

    // Create the tmux session with generated ID
    tmux.new_session(&session_id, &params.folder, &cmd).await?;

    info!(session_id = %session_id, session_name = %params.name, folder = %params.folder, "Created session");

    let now = Utc::now();
    Ok(Session {
        id: session_id,
        name: params.name,  // User-provided display name
        folder: params.folder,
        git_branch,
        status: SessionStatus::Working,
        created_at: now,
        updated_at: now,
        working_since: Some(now), // New sessions start as Working
        project_id: None,         // New sessions are ungrouped by default
        last_input: None,         // No input sent yet
    })
}

/// Delete (kill) a session
#[instrument(skip(tmux))]
pub async fn delete_session(tmux: &(impl TmuxClient + ?Sized), session_id: &str) -> Result<()> {
    validate_session_id(session_id)?;

    if !tmux.has_session(session_id).await? {
        return Err(ModelError::SessionNotFound(session_id.to_string()));
    }

    tmux.kill_session(session_id).await?;
    info!(session = %session_id, "Killed session");
    Ok(())
}

/// Send input to a session
#[instrument(skip(tmux))]
pub async fn send_input(tmux: &(impl TmuxClient + ?Sized), session_id: &str, text: &str) -> Result<()> {
    validate_session_id(session_id)?;

    if text.is_empty() {
        return Err(ModelError::InvalidInput("Input text cannot be empty".to_string()));
    }

    if text.len() > 10_000 {
        return Err(ModelError::InvalidInput(
            format!("Input text too long ({} chars, max 10000)", text.len()),
        ));
    }

    if !tmux.has_session(session_id).await? {
        return Err(ModelError::SessionNotFound(session_id.to_string()));
    }

    tmux.send_keys(session_id, text).await?;
    info!(session = %session_id, "Sent input");
    Ok(())
}

/// Poll session output (lightweight -- no session metadata)
///
/// Returns the raw pane content and detected status.
/// Uses 2000 lines of scrollback for thorough capture.
#[instrument(skip(tmux))]
pub async fn poll_output(tmux: &(impl TmuxClient + ?Sized), session_id: &str) -> Result<(String, SessionStatus)> {
    validate_session_id(session_id)?;

    if !tmux.has_session(session_id).await? {
        return Err(ModelError::SessionNotFound(session_id.to_string()));
    }

    let content = tmux.capture_pane(session_id, 2000).await?;
    let status = detect_status(&content);

    debug!(session = %session_id, status = %status, "Polled output");
    Ok((content, status))
}

/// Resize a session's tmux window
///
/// Validates that cols are in [20, 300] and rows are in [5, 100].
#[instrument(skip(tmux))]
pub async fn resize_session(tmux: &(impl TmuxClient + ?Sized), session_id: &str, cols: u16, rows: u16) -> Result<()> {
    validate_session_id(session_id)?;

    // Validate bounds
    if !(20..=300).contains(&cols) {
        return Err(ModelError::InvalidInput(
            format!("cols must be between 20 and 300, got {}", cols),
        ));
    }
    if !(5..=100).contains(&rows) {
        return Err(ModelError::InvalidInput(
            format!("rows must be between 5 and 100, got {}", rows),
        ));
    }

    if !tmux.has_session(session_id).await? {
        return Err(ModelError::SessionNotFound(session_id.to_string()));
    }

    tmux.resize_window(session_id, cols, rows).await?;
    info!(session = %session_id, cols = %cols, rows = %rows, "Resized session");
    Ok(())
}

/// Validate and return a sanitized session name
///
/// This is used by the rename handler to validate the new name before updating state.
/// Returns the validated name on success.
#[instrument]
pub fn validate_rename(session_id: &str, new_name: &str) -> Result<String> {
    validate_session_id(session_id)?;
    validate_session_name(new_name)?;
    Ok(new_name.to_string())
}

/// Validate that a hook can be processed for a session.
///
/// Validates the session_id format and checks that the session exists.
/// This should be called before process_hook_event() in the handler.
#[instrument(skip(tmux))]
pub async fn validate_hook_session(tmux: &(impl TmuxClient + ?Sized), session_id: &str) -> Result<()> {
    validate_session_id(session_id)?;

    if !tmux.has_session(session_id).await? {
        return Err(ModelError::SessionNotFound(session_id.to_string()));
    }

    Ok(())
}

/// Process a hook event and return the corresponding session status.
///
/// This is a pure function with no side effects. It validates the event
/// and maps it to a SessionStatus.
///
/// Event mappings:
/// - tool_start, thinking, typing -> Working
/// - tool_end -> Working (still working after tool ends)
/// - waiting -> NeedsInput
/// - error -> Error
/// - done -> Resting
#[instrument]
pub fn process_hook_event(event: &str) -> Result<SessionStatus> {
    match event {
        "tool_start" | "thinking" | "typing" => Ok(SessionStatus::Working),
        "tool_end" => Ok(SessionStatus::Working), // Still working after tool ends
        "waiting" => Ok(SessionStatus::NeedsInput),
        "error" => Ok(SessionStatus::Error),
        "done" => Ok(SessionStatus::Resting),
        _ => Err(ModelError::InvalidInput(format!(
            "Invalid hook event: {}. Valid events: tool_start, tool_end, thinking, typing, waiting, error, done",
            event
        ))),
    }
}

// =============================================================================
// Unit Tests
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_process_hook_event_working_states() {
        // tool_start -> Working
        assert_eq!(process_hook_event("tool_start").unwrap(), SessionStatus::Working);
        // thinking -> Working
        assert_eq!(process_hook_event("thinking").unwrap(), SessionStatus::Working);
        // typing -> Working
        assert_eq!(process_hook_event("typing").unwrap(), SessionStatus::Working);
        // tool_end -> Working (still working)
        assert_eq!(process_hook_event("tool_end").unwrap(), SessionStatus::Working);
    }

    #[test]
    fn test_process_hook_event_needs_input() {
        assert_eq!(process_hook_event("waiting").unwrap(), SessionStatus::NeedsInput);
    }

    #[test]
    fn test_process_hook_event_error() {
        assert_eq!(process_hook_event("error").unwrap(), SessionStatus::Error);
    }

    #[test]
    fn test_process_hook_event_done() {
        assert_eq!(process_hook_event("done").unwrap(), SessionStatus::Resting);
    }

    #[test]
    fn test_process_hook_event_invalid() {
        let result = process_hook_event("unknown_event");
        assert!(result.is_err());
        match result.unwrap_err() {
            ModelError::InvalidInput(msg) => {
                assert!(msg.contains("Invalid hook event: unknown_event"));
                assert!(msg.contains("Valid events:"));
            }
            _ => panic!("Expected InvalidInput error"),
        }
    }

    #[test]
    fn test_process_hook_event_empty_string() {
        let result = process_hook_event("");
        assert!(result.is_err());
        match result.unwrap_err() {
            ModelError::InvalidInput(msg) => {
                assert!(msg.contains("Invalid hook event:"));
            }
            _ => panic!("Expected InvalidInput error"),
        }
    }

    // =========================================================================
    // validate_session_id tests
    // =========================================================================

    #[test]
    fn test_validate_session_id_valid() {
        assert!(validate_session_id("my-session_123").is_ok());
        assert!(validate_session_id("a").is_ok());
        assert!(validate_session_id("ABC").is_ok());
    }

    #[test]
    fn test_validate_session_id_empty() {
        let err = validate_session_id("").unwrap_err();
        assert!(matches!(err, ModelError::InvalidInput(msg) if msg.contains("empty")));
    }

    #[test]
    fn test_validate_session_id_too_long() {
        let long_id = "a".repeat(129);
        let err = validate_session_id(&long_id).unwrap_err();
        assert!(matches!(err, ModelError::InvalidInput(msg) if msg.contains("too long")));
    }

    #[test]
    fn test_validate_session_id_128_chars_ok() {
        let id = "a".repeat(128);
        assert!(validate_session_id(&id).is_ok());
    }

    #[test]
    fn test_validate_session_id_starts_with_hyphen() {
        let err = validate_session_id("-bad").unwrap_err();
        assert!(matches!(err, ModelError::InvalidInput(msg) if msg.contains("hyphen")));
    }

    #[test]
    fn test_validate_session_id_special_chars_rejected() {
        assert!(validate_session_id("foo;bar").is_err());
        assert!(validate_session_id("foo bar").is_err());
        assert!(validate_session_id("foo$bar").is_err());
        assert!(validate_session_id("foo{bar}").is_err());
        assert!(validate_session_id("foo/bar").is_err());
        assert!(validate_session_id("foo.bar").is_err());
    }

    // =========================================================================
    // validate_session_name tests
    // =========================================================================

    #[test]
    fn test_validate_session_name_valid() {
        assert!(validate_session_name("My Session").is_ok());
        assert!(validate_session_name("project-alpha (v2)").is_ok());
        assert!(validate_session_name("日本語").is_ok());
    }

    #[test]
    fn test_validate_session_name_empty() {
        let err = validate_session_name("").unwrap_err();
        assert!(matches!(err, ModelError::InvalidInput(msg) if msg.contains("empty")));
    }

    #[test]
    fn test_validate_session_name_too_long() {
        let long_name = "a".repeat(101);
        let err = validate_session_name(&long_name).unwrap_err();
        assert!(matches!(err, ModelError::InvalidInput(msg) if msg.contains("too long")));
    }

    #[test]
    fn test_validate_session_name_control_chars_rejected() {
        assert!(validate_session_name("foo\x00bar").is_err());
        assert!(validate_session_name("foo\nbar").is_err());
        assert!(validate_session_name("foo\tbar").is_err());
    }

    // =========================================================================
    // generate_session_id tests
    // =========================================================================

    #[test]
    fn test_generate_session_id_format() {
        let id = generate_session_id("/home/user/projects/my-app");
        // Should be "my-app_{6 alphanumeric chars}"
        assert!(id.starts_with("my-app_"));
        assert_eq!(id.len(), "my-app_".len() + 6);
    }

    #[test]
    fn test_generate_session_id_sanitizes_special_chars() {
        let id = generate_session_id("/home/user/my app (v2)");
        // Spaces and parens should be stripped
        assert!(id.starts_with("myappv2_"));
    }

    #[test]
    fn test_generate_session_id_empty_folder_name() {
        let id = generate_session_id("/");
        // Should fall back to "session"
        assert!(id.starts_with("session_"));
    }

    #[test]
    fn test_generate_session_id_unique() {
        let id1 = generate_session_id("/foo");
        let id2 = generate_session_id("/foo");
        // Random suffix makes them different (extremely high probability)
        assert_ne!(id1, id2);
    }

    #[test]
    fn test_generate_session_id_passes_validation() {
        // Generated IDs should always pass validation
        for path in &["/foo", "/home/user/my-project", "/tmp/test_dir", "/a/b/c"] {
            let id = generate_session_id(path);
            assert!(validate_session_id(&id).is_ok(), "ID '{}' from path '{}' failed validation", id, path);
        }
    }
}
