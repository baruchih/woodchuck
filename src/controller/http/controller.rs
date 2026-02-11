//! HTTP Controller
//!
//! Lifecycle management for the HTTP server.
//! start() returns a stop function for graceful shutdown.

use std::future::Future;
use std::net::SocketAddr;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use axum_server::tls_rustls::RustlsConfig;
use tokio::sync::oneshot;
use tracing::{error, info};

use super::routes::build_router;
use super::state::AppState;
use crate::config::Config;
use crate::controller::SubscriberMap;
use crate::model::{ModelError, SharedSessionStates};
use crate::utils::{GitClient, NtfyClient, SessionStore, TmuxClient, WebPushClient};

/// Stop function type - call to initiate graceful shutdown
pub type StopFn = Box<dyn FnOnce() -> Pin<Box<dyn Future<Output = ()> + Send>> + Send>;

/// Start the HTTP server
///
/// Returns a stop function that can be called to initiate graceful shutdown.
#[allow(clippy::too_many_arguments)]
pub async fn start(
    config: Arc<Config>,
    tmux: Arc<dyn TmuxClient>,
    git: Arc<dyn GitClient>,
    ntfy: Arc<dyn NtfyClient>,
    push: Arc<dyn WebPushClient>,
    session_states: SharedSessionStates,
    subscribers: SubscriberMap,
    session_store: Arc<dyn SessionStore>,
) -> Result<StopFn, ModelError> {
    let addr: SocketAddr = format!("{}:{}", config.bind_addr, config.http_port)
        .parse()
        .map_err(|e| ModelError::Internal(format!("Invalid address: {}", e)))?;

    // Build state
    let state = AppState::new(
        config.clone(),
        tmux,
        git,
        ntfy,
        push,
        session_states,
        subscribers,
        session_store,
    );

    // Build router
    let app = build_router(state);

    // Create shutdown channel
    let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();
    let shutdown_timeout = Duration::from_secs(config.shutdown_timeout_secs);

    // Check if TLS is enabled
    if let (Some(cert_path), Some(key_path)) = (&config.tls_cert, &config.tls_key) {
        // Install the ring crypto provider for rustls
        rustls::crypto::ring::default_provider()
            .install_default()
            .ok(); // Ignore error if already installed

        // HTTPS mode
        let tls_config = RustlsConfig::from_pem_file(cert_path, key_path)
            .await
            .map_err(|e| ModelError::Internal(format!("Failed to load TLS config: {}", e)))?;

        info!(%addr, "HTTPS server starting");

        // Create the server handle for graceful shutdown
        let handle = axum_server::Handle::new();
        let shutdown_handle = handle.clone();

        // Spawn shutdown listener
        tokio::spawn(async move {
            let _ = shutdown_rx.await;
            info!("HTTPS server shutdown signal received");
            shutdown_handle.graceful_shutdown(Some(Duration::from_secs(5)));
        });

        // Spawn HTTPS server task
        tokio::spawn(async move {
            axum_server::bind_rustls(addr, tls_config)
                .handle(handle)
                .serve(app.into_make_service())
                .await
                .map_err(|e| {
                    error!("HTTPS server error: {}", e);
                })
                .ok();
        });

        info!(%addr, "HTTPS server started");
    } else {
        // HTTP mode (no TLS)
        info!(%addr, "HTTP server starting (no TLS)");

        // Spawn HTTP server task
        let listener = tokio::net::TcpListener::bind(addr)
            .await
            .map_err(|e| ModelError::Internal(format!("Failed to bind to {}: {}", addr, e)))?;

        tokio::spawn(async move {
            axum::serve(listener, app)
                .with_graceful_shutdown(async move {
                    let _ = shutdown_rx.await;
                    info!("HTTP server shutdown signal received");
                })
                .await
                .map_err(|e| {
                    error!("HTTP server error: {}", e);
                })
                .ok();
        });

        info!(%addr, "HTTP server started");
    }

    // Return stop function
    let stop_fn: StopFn = Box::new(move || {
        Box::pin(async move {
            info!("Stopping HTTP server...");
            let _ = shutdown_tx.send(());
            // Give server time to finish in-flight requests
            tokio::time::sleep(shutdown_timeout).await;
            info!("HTTP server stopped");
        })
    });

    Ok(stop_fn)
}
