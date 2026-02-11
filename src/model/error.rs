//! Error types for the model layer
//!
//! Defines all error variants for Woodchuck operations.

use thiserror::Error;

/// Result type alias using ModelError
pub type Result<T> = std::result::Result<T, ModelError>;

/// Main error type for the model layer
#[derive(Debug, Error, Clone)]
pub enum ModelError {
    #[error("Session not found: {0}")]
    SessionNotFound(String),

    #[error("Session already exists: {0}")]
    SessionAlreadyExists(String),

    #[error("Folder not found: {0}")]
    FolderNotFound(String),

    #[error("Project not found: {0}")]
    ProjectNotFound(String),

    #[error("Invalid input: {0}")]
    InvalidInput(String),

    #[error("Validation error: {0}")]
    ValidationError(String),

    #[error("tmux error: {0}")]
    TmuxError(String),

    #[error("IO error: {0}")]
    IoError(String),

    #[error("Notification error: {0}")]
    NotificationError(String),

    #[error("Folder already exists: {0}")]
    FolderAlreadyExists(String),

    #[error("Git clone error: {0}")]
    GitCloneError(String),

    #[error("Git error: {0}")]
    GitError(String),

    #[error("Internal error: {0}")]
    Internal(String),

    #[error("Session store error: {0}")]
    SessionStoreError(String),

    #[error("Hook injection failed: {0}")]
    HookInjection(String),
}

impl From<std::io::Error> for ModelError {
    fn from(e: std::io::Error) -> Self {
        ModelError::IoError(e.to_string())
    }
}
