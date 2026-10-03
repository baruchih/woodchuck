//! WebSocket Controller
//!
//! WebSocket server for real-time session output streaming.
//! Lifecycle: start() returns stop().

mod controller;
pub mod handler;
pub mod messages;
mod terminal_stream;

pub use controller::{start, StopFn};
pub use messages::{ClientMessage, ServerMessage};
