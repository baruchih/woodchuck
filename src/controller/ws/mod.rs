//! WebSocket Controller
//!
//! WebSocket server for real-time session output streaming.
//! Lifecycle: start() returns stop().

mod controller;
pub mod handler;
pub mod messages;

pub use controller::{start, StopFn};
pub use messages::{ClientMessage, ServerMessage};
