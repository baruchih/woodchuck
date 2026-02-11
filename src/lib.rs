//! Woodchuck - Library crate
//!
//! A Rust HTTP/WebSocket server that bridges REST/WebSocket clients
//! to tmux sessions running Claude Code.
//!
//! # Architecture
//!
//! ```text
//! config.rs       - Environment configuration
//! service.rs      - Lifecycle orchestration
//! controller/     - HTTP and WebSocket handlers
//! model/          - Pure business logic, domain types
//! utils/          - tmux wrapper, ntfy client
//! ```

pub mod config;
pub mod controller;
pub mod model;
pub mod service;
pub mod utils;

// Re-export commonly used types
pub use config::{Config, ConfigError};
pub use model::{ModelError, Session, SessionStatus};
pub use service::ServiceError;
