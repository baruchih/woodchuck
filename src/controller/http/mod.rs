//! HTTP Controller
//!
//! HTTP server with REST API endpoints.
//! Lifecycle: start() returns stop().

mod controller;
mod handlers;
mod response;
mod routes;
mod state;

pub use controller::{start, StopFn};
pub use response::{ApiResponse, err, err_msg};
pub use state::AppState;
