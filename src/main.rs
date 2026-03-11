//! Woodchuck - Main entry point
//!
//! A service for managing Claude Code sessions via tmux.

use woodchuck::service;

#[tokio::main]
async fn main() {
    // Load .env file if present (ignore if missing)
    let _ = dotenvy::dotenv();

    // If spawned by a deploy restart, wait for the parent to exit and release the port
    if std::env::var("WOODCHUCK_RESTART_DELAY").is_ok() {
        std::thread::sleep(std::time::Duration::from_secs(1));
    }

    if let Err(e) = service::run().await {
        eprintln!("Service error: {}", e);
        std::process::exit(1);
    }
}
