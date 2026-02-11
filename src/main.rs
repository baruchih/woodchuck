//! Woodchuck - Main entry point
//!
//! A service for managing Claude Code sessions via tmux.

use woodchuck::service;

#[tokio::main]
async fn main() {
    // Load .env file if present (ignore if missing)
    let _ = dotenvy::dotenv();

    if let Err(e) = service::run().await {
        eprintln!("Service error: {}", e);
        std::process::exit(1);
    }
}
