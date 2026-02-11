//! HTTP route definitions
//!
//! Builds the Axum router with all API routes.

use axum::{
    extract::{State, WebSocketUpgrade},
    response::IntoResponse,
    routing::{delete, get, patch, post},
    Router,
};
use axum::http::HeaderValue;
use tower_http::cors::{Any, CorsLayer};
use tower_http::services::{ServeDir, ServeFile};

use super::handlers::{
    create_folder_handler, create_project_handler, create_session_handler, delete_project_handler,
    delete_session_handler, get_session_handler, health_handler, hook_handler,
    list_commands_handler, list_folders_handler, list_projects_handler, list_sessions_handler,
    poll_handler, push_subscribe_handler, push_unsubscribe_handler, rename_project_handler,
    resize_handler, send_input_handler, update_session_handler, vapid_key_handler,
};
use super::state::AppState;
use crate::controller::ws::handler::handle_connection;

/// Build the HTTP router with all routes
pub fn build_router(state: AppState) -> Router {
    // API routes
    let api_router = Router::new()
        // Health
        .route("/health", get(health_handler))
        // Sessions
        .route("/sessions", get(list_sessions_handler))
        .route("/sessions", post(create_session_handler))
        .route("/sessions/:id", get(get_session_handler))
        .route("/sessions/:id", delete(delete_session_handler))
        .route("/sessions/:id", patch(update_session_handler))
        .route("/sessions/:id/input", post(send_input_handler))
        .route("/sessions/:id/poll", get(poll_handler))
        .route("/sessions/:id/resize", post(resize_handler))
        .route("/sessions/:id/hook", post(hook_handler))
        // Folders
        .route("/folders", get(list_folders_handler))
        .route("/folders", post(create_folder_handler))
        // Projects
        .route("/projects", get(list_projects_handler))
        .route("/projects", post(create_project_handler))
        .route("/projects/:id", patch(rename_project_handler))
        .route("/projects/:id", delete(delete_project_handler))
        // Push notifications
        .route("/push/vapid-key", get(vapid_key_handler))
        .route("/push/subscribe", post(push_subscribe_handler))
        .route("/push/unsubscribe", post(push_unsubscribe_handler))
        // Commands
        .route("/commands", get(list_commands_handler));

    // Combine with state and middleware — includes WebSocket on same port
    let app = Router::new()
        .nest("/api", api_router)
        .route("/ws", get(ws_upgrade_handler))
        .with_state(state.clone());

    // CORS layer - configurable via CORS_ORIGINS env var
    let cors = if state.config.cors_origins == "*" {
        CorsLayer::new()
            .allow_origin(Any)
            .allow_methods(Any)
            .allow_headers(Any)
    } else {
        let origins: Vec<HeaderValue> = state
            .config
            .cors_origins
            .split(',')
            .filter_map(|s| s.trim().parse().ok())
            .collect();
        CorsLayer::new()
            .allow_origin(origins)
            .allow_methods(Any)
            .allow_headers(Any)
    };

    // Add static file serving for PWA
    let static_dir = &state.config.static_dir;

    app.layer(cors)
        // Serve static files from app/dist, fallback to index.html for SPA routing
        .fallback_service(
            ServeDir::new(static_dir)
                .not_found_service(ServeFile::new(format!("{}/index.html", static_dir))),
        )
}

/// WebSocket upgrade handler — mounted on the HTTP server at /ws
async fn ws_upgrade_handler(
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| {
        handle_connection(socket, state.tmux, state.session_states, state.subscribers)
    })
}
