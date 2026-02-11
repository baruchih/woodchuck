//! Service Orchestrator
//!
//! Top-level orchestrator that:
//! - Loads configuration from environment
//! - Initializes logging
//! - Starts controllers (HTTP, WebSocket)
//! - Handles shutdown signals (SIGTERM, SIGINT)
//! - Performs graceful shutdown

use thiserror::Error;
use tokio::signal;
use tracing::info;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt, EnvFilter};

use crate::config::{Config, ConfigError};
use crate::controller;
use crate::model::ModelError;

// =============================================================================
// Errors
// =============================================================================

/// Service errors
#[derive(Debug, Error)]
pub enum ServiceError {
    #[error("Configuration error: {0}")]
    Config(#[from] ConfigError),

    #[error("Controller failed: {0}")]
    Controller(#[from] ModelError),
}

// =============================================================================
// Service
// =============================================================================

/// Run the service
///
/// This is the main entry point that:
/// 1. Loads configuration from environment
/// 2. Initializes logging
/// 3. Starts controllers
/// 4. Waits for shutdown signal
/// 5. Performs graceful shutdown
pub async fn run() -> Result<(), ServiceError> {
    // 1. Load configuration
    let config = Config::from_env()?;

    // 2. Initialize logging
    init_logger(&config.log_level);

    info!(
        http_port = %config.http_port,
        projects_dir = %config.projects_dir,
        notifications = %config.notifications_enabled(),
        "Starting Woodchuck"
    );

    // 3. Start controllers
    let stop = controller::start(&config).await?;

    info!("Service started, waiting for shutdown signal");

    // 4. Wait for shutdown signal
    wait_for_shutdown().await;

    info!("Shutdown signal received, stopping service");

    // 5. Graceful shutdown
    stop().await;

    info!("Service stopped");

    Ok(())
}

/// Initialize the tracing subscriber for logging
fn init_logger(level: &str) {
    let filter = EnvFilter::try_from_default_env()
        .or_else(|_| EnvFilter::try_new(level))
        .unwrap_or_else(|_| EnvFilter::new("info"));

    tracing_subscriber::registry()
        .with(filter)
        .with(tracing_subscriber::fmt::layer())
        .init();
}

/// Wait for shutdown signal (SIGTERM or SIGINT)
async fn wait_for_shutdown() {
    let ctrl_c = async {
        signal::ctrl_c()
            .await
            .expect("Failed to install Ctrl+C handler");
    };

    #[cfg(unix)]
    let terminate = async {
        signal::unix::signal(signal::unix::SignalKind::terminate())
            .expect("Failed to install SIGTERM handler")
            .recv()
            .await;
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {
            info!("Received SIGINT");
        }
        _ = terminate => {
            info!("Received SIGTERM");
        }
    }
}
