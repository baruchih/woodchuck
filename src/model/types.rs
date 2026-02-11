//! Domain types for Woodchuck
//!
//! Core types representing sessions, status, and API parameters.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::fmt;

// =============================================================================
// Session
// =============================================================================

/// A Claude Code session running in tmux
#[derive(Debug, Clone, Serialize)]
pub struct Session {
    /// Session ID (same as name)
    pub id: String,

    /// Session name (tmux session name)
    pub name: String,

    /// Project folder path
    pub folder: String,

    /// Current git branch (if in a git repo)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub git_branch: Option<String>,

    /// Current status
    pub status: SessionStatus,

    /// When the session was created
    pub created_at: DateTime<Utc>,

    /// Last activity timestamp
    pub updated_at: DateTime<Utc>,

    /// When the session entered "working" status (None if not currently working)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub working_since: Option<DateTime<Utc>>,

    /// Project ID if the session belongs to a project
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,

    /// Last input sent to the session (for historical context)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_input: Option<String>,
}

// =============================================================================
// Project
// =============================================================================

/// A project for grouping sessions
#[derive(Debug, Clone, Serialize)]
pub struct Project {
    /// Project ID (UUID)
    pub id: String,

    /// Project name
    pub name: String,

    /// When the project was created
    pub created_at: DateTime<Utc>,
}

// =============================================================================
// Session Status
// =============================================================================

/// Status of a Claude Code session
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum SessionStatus {
    /// Agent is resting -- not doing anything
    #[default]
    Resting,

    /// Agent is actively working
    Working,

    /// Agent needs user input
    NeedsInput,

    /// An error occurred
    Error,
}

impl fmt::Display for SessionStatus {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let s = match self {
            Self::Resting => "resting",
            Self::Working => "working",
            Self::NeedsInput => "needs_input",
            Self::Error => "error",
        };
        write!(f, "{}", s)
    }
}

// =============================================================================
// API Parameters
// =============================================================================

/// Parameters for creating a new session
#[derive(Debug, Clone, Deserialize)]
pub struct CreateSessionParams {
    /// Session name (must be unique)
    pub name: String,

    /// Project folder path
    pub folder: String,

    /// Initial prompt for Claude
    pub prompt: String,
}

/// Parameters for sending input to a session
#[derive(Debug, Clone, Deserialize)]
pub struct SendInputParams {
    /// Text to send to the session
    pub text: String,
}

/// Parameters for updating a session (name and/or project)
#[derive(Debug, Clone, Deserialize)]
pub struct UpdateSessionParams {
    /// New display name for the session (if changing)
    #[serde(default)]
    pub name: Option<String>,

    /// New project ID (Some(id) to set, use "null" in JSON to remove from project)
    #[serde(default, deserialize_with = "deserialize_optional_project_id")]
    pub project_id: Option<Option<String>>,
}

/// Custom deserializer for project_id to distinguish between missing field and null value
fn deserialize_optional_project_id<'de, D>(deserializer: D) -> Result<Option<Option<String>>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    // If the field is present, parse it (could be null or a string)
    Option::<String>::deserialize(deserializer).map(Some)
}

/// Parameters for creating a new project
#[derive(Debug, Clone, Deserialize)]
pub struct CreateProjectParams {
    /// Project name
    pub name: String,
}

/// Parameters for renaming a project
#[derive(Debug, Clone, Deserialize)]
pub struct RenameProjectParams {
    /// New project name
    pub name: String,
}

/// Parameters for resizing a session's tmux pane
#[derive(Debug, Clone, Deserialize)]
pub struct ResizeParams {
    /// Number of columns
    pub cols: u16,

    /// Number of rows
    pub rows: u16,
}

// =============================================================================
// Folder Parameters
// =============================================================================

/// Parameters for creating a new folder
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "action")]
pub enum CreateFolderParams {
    /// Create an empty folder
    #[serde(rename = "create")]
    Create { name: String },

    /// Clone a git repository
    #[serde(rename = "clone")]
    Clone {
        url: String,
        #[serde(default)]
        name: Option<String>,
    },
}

// =============================================================================
// Slash Commands
// =============================================================================

/// A slash command available in Claude Code
#[derive(Debug, Clone, Serialize)]
pub struct SlashCommand {
    /// Command name (including the leading slash, e.g., "/help")
    pub name: String,

    /// Short description of what the command does
    pub description: String,

    /// Usage example
    pub usage: String,

    /// Whether the command accepts arguments
    pub has_args: bool,
}

// =============================================================================
// Internal Types
// =============================================================================

/// Raw tmux session info from list-sessions
#[derive(Debug, Clone)]
pub struct TmuxSessionInfo {
    /// Session name
    pub name: String,

    /// Unix timestamp when created
    pub created: i64,

    /// Unix timestamp of last activity
    pub activity: i64,

    /// Current working directory of the pane
    pub folder: String,
}

// =============================================================================
// Hook Event Parameters
// =============================================================================

/// Parameters for hook status endpoint
#[derive(Debug, Clone, Deserialize)]
pub struct HookEventParams {
    /// The event type from Claude Code hook
    pub event: String,

    /// Optional tool name for tool_start/tool_end events
    #[serde(default)]
    pub tool_name: Option<String>,

    /// Optional context message
    #[serde(default)]
    pub message: Option<String>,
}

// =============================================================================
// Unit Tests
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_session_status_display() {
        assert_eq!(SessionStatus::Resting.to_string(), "resting");
        assert_eq!(SessionStatus::Working.to_string(), "working");
        assert_eq!(SessionStatus::NeedsInput.to_string(), "needs_input");
        assert_eq!(SessionStatus::Error.to_string(), "error");
    }

    #[test]
    fn test_session_status_serialize() {
        let status = SessionStatus::NeedsInput;
        let json = serde_json::to_string(&status).unwrap();
        assert_eq!(json, "\"needs_input\"");

        let status = SessionStatus::Working;
        let json = serde_json::to_string(&status).unwrap();
        assert_eq!(json, "\"working\"");
    }

    #[test]
    fn test_session_status_deserialize() {
        let status: SessionStatus = serde_json::from_str("\"needs_input\"").unwrap();
        assert_eq!(status, SessionStatus::NeedsInput);

        let status: SessionStatus = serde_json::from_str("\"resting\"").unwrap();
        assert_eq!(status, SessionStatus::Resting);
    }
}
