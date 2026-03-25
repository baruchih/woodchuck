//! HTTP response types
//!
//! Consistent API response format for all endpoints.

use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde::Serialize;

use crate::model::ModelError;

// =============================================================================
// Error Mapping (controller concern — maps model errors to HTTP)
// =============================================================================

/// Map a ModelError to an HTTP status code
fn status_code(e: &ModelError) -> StatusCode {
    match e {
        ModelError::SessionNotFound(_)
        | ModelError::FolderNotFound(_)
        | ModelError::ProjectNotFound(_) => StatusCode::NOT_FOUND,
        ModelError::SessionAlreadyExists(_) | ModelError::FolderAlreadyExists(_) => StatusCode::CONFLICT,
        ModelError::InvalidInput(_) | ModelError::ValidationError(_) | ModelError::GitCloneError(_) => StatusCode::BAD_REQUEST,
        ModelError::TmuxError(_)
        | ModelError::IoError(_)
        | ModelError::NotificationError(_)
        | ModelError::GitError(_)
        | ModelError::SessionStoreError(_)
        | ModelError::HookInjection(_)
        | ModelError::Internal(_) => StatusCode::INTERNAL_SERVER_ERROR,
    }
}

/// Map a ModelError to an error code string for API responses
fn error_code(e: &ModelError) -> &'static str {
    match e {
        ModelError::SessionNotFound(_) => "SESSION_NOT_FOUND",
        ModelError::FolderNotFound(_) => "FOLDER_NOT_FOUND",
        ModelError::ProjectNotFound(_) => "PROJECT_NOT_FOUND",
        ModelError::SessionAlreadyExists(_) => "SESSION_ALREADY_EXISTS",
        ModelError::InvalidInput(_) => "INVALID_INPUT",
        ModelError::ValidationError(_) => "VALIDATION_ERROR",
        ModelError::FolderAlreadyExists(_) => "FOLDER_ALREADY_EXISTS",
        ModelError::GitCloneError(_) => "GIT_CLONE_ERROR",
        ModelError::GitError(_) => "GIT_ERROR",
        ModelError::TmuxError(_) => "TMUX_ERROR",
        ModelError::IoError(_) => "IO_ERROR",
        ModelError::NotificationError(_) => "NOTIFICATION_ERROR",
        ModelError::SessionStoreError(_) => "SESSION_STORE_ERROR",
        ModelError::HookInjection(_) => "HOOK_INJECTION_ERROR",
        ModelError::Internal(_) => "INTERNAL_ERROR",
    }
}

// =============================================================================
// API Response
// =============================================================================

/// Standard API response wrapper
#[derive(Debug, Serialize)]
pub struct ApiResponse<T: Serialize> {
    pub success: bool,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<T>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
}

impl<T: Serialize> ApiResponse<T> {
    /// Create a success response with data
    pub fn ok(data: T) -> Json<Self> {
        Json(Self {
            success: true,
            data: Some(data),
            error: None,
            code: None,
        })
    }
}

/// Sanitize error messages to avoid leaking internal paths
fn sanitize_error(e: &ModelError) -> String {
    match e {
        // Internal errors should not expose details to clients
        ModelError::TmuxError(_) => "Internal tmux error".to_string(),
        ModelError::IoError(_) => "Internal I/O error".to_string(),
        ModelError::HookInjection(_) => "Hook injection failed".to_string(),
        ModelError::Internal(_) => "Internal server error".to_string(),
        ModelError::GitError(_) => "Git operation failed".to_string(),
        ModelError::SessionStoreError(_) => "Session store error".to_string(),
        // User-facing errors are safe to pass through (validation messages, not found, etc.)
        _ => e.to_string(),
    }
}

/// Create an error response from ModelError
pub fn err(e: ModelError) -> (StatusCode, Json<ApiResponse<()>>) {
    (
        status_code(&e),
        Json(ApiResponse {
            success: false,
            data: None,
            error: Some(sanitize_error(&e)),
            code: Some(error_code(&e).to_string()),
        }),
    )
}

/// Create an error response from a string message
pub fn err_msg(status: StatusCode, message: &str, code: &str) -> (StatusCode, Json<ApiResponse<()>>) {
    (
        status,
        Json(ApiResponse {
            success: false,
            data: None,
            error: Some(message.to_string()),
            code: Some(code.to_string()),
        }),
    )
}

// =============================================================================
// Response Data Types
// =============================================================================

/// Health check response
#[derive(Debug, Serialize)]
pub struct HealthData {
    pub status: String,
    pub build_id: String,
}

/// Sessions list response
#[derive(Debug, Serialize)]
pub struct SessionsData {
    pub sessions: Vec<crate::model::Session>,
}

/// Single session response
#[derive(Debug, Serialize)]
pub struct SessionData {
    pub session: crate::model::Session,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recent_output: Option<String>,
}

/// Session created response
#[derive(Debug, Serialize)]
pub struct SessionCreatedData {
    pub session: crate::model::Session,
}

/// Session killed response
#[derive(Debug, Serialize)]
pub struct SessionKilledData {
    pub killed: bool,
}

/// Session updated response (renamed, moved to project, or tags updated)
#[derive(Debug, Serialize)]
pub struct SessionUpdatedData {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tags: Vec<String>,
}

/// Input sent response
#[derive(Debug, Serialize)]
pub struct InputSentData {
    pub sent: bool,
}

/// Poll output response (lightweight)
#[derive(Debug, Serialize)]
pub struct PollData {
    pub content: String,
    pub status: String,
}

/// Resize response
#[derive(Debug, Serialize)]
pub struct ResizeData {
    pub resized: bool,
}

/// Hook endpoint response
#[derive(Debug, Serialize)]
pub struct HookData {
    /// The resulting session status
    pub status: String,
    /// Whether the event was accepted (status actually changed)
    pub accepted: bool,
}

/// Folders list response
#[derive(Debug, Serialize)]
pub struct FoldersData {
    pub folders: Vec<String>,
}

/// Folder created response
#[derive(Debug, Serialize)]
pub struct FolderCreatedData {
    pub path: String,
}

/// VAPID public key response
#[derive(Debug, Serialize)]
pub struct VapidKeyData {
    #[serde(rename = "publicKey")]
    pub public_key: Option<String>,
}

/// Push subscribe response
#[derive(Debug, Serialize)]
pub struct PushSubscribedData {
    pub subscribed: bool,
}

/// Push unsubscribe response
#[derive(Debug, Serialize)]
pub struct PushUnsubscribedData {
    pub unsubscribed: bool,
}

/// Commands list response
#[derive(Debug, Serialize)]
pub struct CommandsData {
    pub commands: Vec<crate::model::SlashCommand>,
}

// =============================================================================
// Project Response Data Types
// =============================================================================

/// Projects list response
#[derive(Debug, Serialize)]
pub struct ProjectsData {
    pub projects: Vec<crate::model::Project>,
}

/// Project created response
#[derive(Debug, Serialize)]
pub struct ProjectCreatedData {
    pub project: crate::model::Project,
}

/// Project renamed response
#[derive(Debug, Serialize)]
pub struct ProjectRenamedData {
    pub name: String,
}

/// Project deleted response
#[derive(Debug, Serialize)]
pub struct ProjectDeletedData {
    pub deleted: bool,
}

// =============================================================================
// Template Response Data Types
// =============================================================================

/// Single template response
#[derive(Debug, Serialize)]
pub struct TemplateData {
    pub template: crate::model::types::Template,
}

/// Templates list response
#[derive(Debug, Serialize)]
pub struct TemplatesListData {
    pub templates: Vec<crate::model::types::Template>,
}

/// Template deleted response
#[derive(Debug, Serialize)]
pub struct TemplateDeletedData {
    pub deleted: bool,
}

// =============================================================================
// Maintainer Response Data Types
// =============================================================================

/// Maintainer status response
#[derive(Debug, Serialize)]
pub struct MaintainerStatusData {
    pub session_id: String,
    pub status: String,
    pub ralph_active: bool,
    pub ralph_paused: bool,
    pub inbox_count: usize,
    pub inbox_items: Vec<String>,
    pub current_task: Option<String>,
}

/// Inbox submission response
#[derive(Debug, Serialize)]
pub struct InboxItemData {
    pub filename: String,
}

// =============================================================================
// Deploy Response Data Types
// =============================================================================

/// Deploy status response
#[derive(Debug, Serialize)]
pub struct DeployStatusData {
    pub pending: bool,
    pub last_deploy: Option<String>,
    pub cooldown_remaining_secs: Option<i64>,
    pub deploy_branch: String,
    pub current_git_branch: Option<String>,
}

/// Deploy settings response
#[derive(Debug, Serialize)]
pub struct DeploySettingsData {
    pub deploy_branch: String,
}

/// Deploy history response
#[derive(Debug, Serialize)]
pub struct DeployHistoryData {
    pub entries: Vec<DeployEventResponse>,
}

/// Single deploy event in history response
#[derive(Debug, Serialize)]
pub struct DeployEventResponse {
    pub timestamp: String,
    pub branch: String,
    pub commit: String,
    pub outcome: String,
    pub outcome_detail: Option<String>,
    pub trigger: String,
}

/// Deploy trigger response
#[derive(Debug, Serialize)]
pub struct DeployTriggerData {
    pub result: String,
    pub message: String,
}

/// Deploy abort response
#[derive(Debug, Serialize)]
pub struct DeployAbortData {
    pub aborted: bool,
}

/// Image upload response
#[derive(Debug, Serialize)]
pub struct UploadedImageData {
    pub path: String,
}

/// Upload project response
#[derive(Debug, Serialize)]
pub struct UploadProjectData {
    pub path: String,
}

/// Upload files to session response
#[derive(Debug, Serialize)]
pub struct UploadedFilesData {
    pub paths: Vec<String>,
}

/// File entry in a directory listing
#[derive(Debug, Serialize)]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub children: Option<Vec<FileEntry>>,
}

/// Session files listing response
#[derive(Debug, Serialize)]
pub struct SessionFilesData {
    pub root: String,
    pub files: Vec<FileEntry>,
}

/// File content response (for in-browser viewing)
#[derive(Debug, Serialize)]
pub struct FileContentData {
    pub name: String,
    pub path: String,
    pub content: String,
    pub size: u64,
}

// =============================================================================
// Orphaned Session Response Data Types
// =============================================================================

/// Orphaned session info (for recovery UI)
#[derive(Debug, Serialize)]
pub struct OrphanedSessionData {
    pub id: String,
    pub name: String,
    pub folder: String,
    pub status: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tags: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_input: Option<String>,
}

/// Orphaned sessions list response
#[derive(Debug, Serialize)]
pub struct OrphanedSessionsData {
    pub sessions: Vec<OrphanedSessionData>,
}

/// Orphaned session recovered response
#[derive(Debug, Serialize)]
pub struct RecoveredSessionData {
    pub session: crate::model::Session,
}

/// Orphaned session discarded response
#[derive(Debug, Serialize)]
pub struct DiscardedSessionData {
    pub discarded: bool,
}

// =============================================================================
// IntoResponse Implementation
// =============================================================================

impl<T: Serialize> IntoResponse for ApiResponse<T> {
    fn into_response(self) -> Response {
        Json(self).into_response()
    }
}
