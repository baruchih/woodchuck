//! Model layer - Business logic and domain types
//!
//! This module contains:
//! - error.rs: Error types
//! - types.rs: Domain types (Session, SessionStatus, etc.)
//! - session.rs: Session business logic
//! - output.rs: Output parsing and status detection
//! - state.rs: Session state management
//!
//! # Key Principles
//!
//! 1. **Model is pure** - No HTTP, WebSocket, or external service knowledge
//! 2. **Uses traits for deps** - TmuxClient trait for testing
//! 3. **Free functions** - Business logic as functions, not impl blocks

pub mod commands;
pub mod error;
pub mod folder;
pub mod output;
pub mod session;
pub mod state;
pub mod types;

// Re-exports
pub use error::{ModelError, Result};
pub use output::{calculate_hash, detect_status, diff_output};
pub use session::{
    create_session, delete_session, get_session, get_session_output, list_sessions, poll_output,
    process_hook_event, resize_session, send_input, validate_hook_session, validate_rename,
};
pub use state::{new_shared_states, OutputChange, SessionState, SharedSessionStates};
pub use commands::{discover_skills, list_commands, list_commands_with_skills};
pub use folder::{create_folder, list_folders, upload_project};
pub use types::{CreateFolderParams, CreateSessionParams, CreateProjectParams, CreateTemplateParams, HookEventParams, Project, RenameProjectParams, ResizeParams, SendInputParams, Session, SessionStatus, SlashCommand, Template, TmuxSessionInfo, UpdateSessionParams};
