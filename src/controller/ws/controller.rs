//! WebSocket Controller
//!
//! Lifecycle management for the WebSocket server.
//! Can run on the same port as HTTP or a different port.

use std::future::Future;
use std::net::SocketAddr;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use axum::{
    extract::{State, WebSocketUpgrade},
    response::IntoResponse,
    routing::get,
    Router,
};
use tokio::net::TcpSocket;
use tokio::sync::oneshot;
use axum::http::HeaderValue;
use tower_http::cors::{Any, CorsLayer};
use tracing::{error, info};

use super::handler::handle_connection;
use super::messages::ServerMessage;
use crate::config::Config;
use crate::controller::SubscriberMap;
use crate::model::{ModelError, SharedSessionStates};
use crate::utils::{SessionStore, TmuxClient};

/// Stop function type
pub type StopFn = Box<dyn FnOnce() -> Pin<Box<dyn Future<Output = ()> + Send>> + Send>;

/// Shared state for WebSocket handlers
#[derive(Clone)]
struct WsState {
    tmux: Arc<dyn TmuxClient>,
    session_states: SharedSessionStates,
    subscribers: SubscriberMap,
    config: Arc<Config>,
    session_store: Arc<dyn SessionStore>,
    global_broadcast: tokio::sync::broadcast::Sender<ServerMessage>,
}

/// Start the WebSocket server
pub async fn start(
    config: Arc<Config>,
    tmux: Arc<dyn TmuxClient>,
    session_states: SharedSessionStates,
    subscribers: SubscriberMap,
    session_store: Arc<dyn SessionStore>,
    global_broadcast: tokio::sync::broadcast::Sender<ServerMessage>,
) -> Result<StopFn, ModelError> {
    let addr: SocketAddr = format!("0.0.0.0:{}", config.ws_port)
        .parse()
        .map_err(|e| ModelError::Internal(format!("Invalid address: {}", e)))?;

    // Build state
    let state = WsState {
        tmux,
        session_states,
        subscribers,
        config: config.clone(),
        session_store,
        global_broadcast,
    };

    // Build router with configurable CORS
    let cors = if config.cors_origins == "*" {
        CorsLayer::new()
            .allow_origin(Any)
            .allow_methods(Any)
            .allow_headers(Any)
    } else {
        let origins: Vec<HeaderValue> = config
            .cors_origins
            .split(',')
            .filter_map(|s| s.trim().parse().ok())
            .collect();
        CorsLayer::new()
            .allow_origin(origins)
            .allow_methods(Any)
            .allow_headers(Any)
    };

    let app = Router::new()
        .route("/ws", get(ws_handler))
        .with_state(state)
        .layer(cors);

    // Create shutdown channel
    let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();
    let shutdown_timeout = Duration::from_secs(config.shutdown_timeout_secs);

    // Create socket with SO_REUSEADDR for quick restarts
    let socket = TcpSocket::new_v4()
        .map_err(|e| ModelError::Internal(format!("Failed to create socket: {}", e)))?;
    socket
        .set_reuseaddr(true)
        .map_err(|e| ModelError::Internal(format!("Failed to set SO_REUSEADDR: {}", e)))?;
    socket
        .bind(addr)
        .map_err(|e| ModelError::Internal(format!("Failed to bind to {}: {}", addr, e)))?;
    let listener = socket
        .listen(1024)
        .map_err(|e| ModelError::Internal(format!("Failed to listen: {}", e)))?;

    info!(%addr, "WebSocket server starting");

    // Spawn server task
    tokio::spawn(async move {
        axum::serve(listener, app)
            .with_graceful_shutdown(async move {
                let _ = shutdown_rx.await;
                info!("WebSocket server shutdown signal received");
            })
            .await
            .map_err(|e| {
                error!("WebSocket server error: {}", e);
            })
            .ok();
    });

    info!(%addr, "WebSocket server started");

    // Return stop function
    let stop_fn: StopFn = Box::new(move || {
        Box::pin(async move {
            info!("Stopping WebSocket server...");
            let _ = shutdown_tx.send(());
            tokio::time::sleep(shutdown_timeout).await;
            info!("WebSocket server stopped");
        })
    });

    Ok(stop_fn)
}

/// WebSocket upgrade handler
async fn ws_handler(
    ws: WebSocketUpgrade,
    State(state): State<WsState>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| {
        handle_connection(
            socket,
            state.tmux,
            state.session_states,
            state.subscribers,
            state.config,
            state.session_store,
            state.global_broadcast,
        )
    })
}
