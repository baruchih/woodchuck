//! Controller Layer
//!
//! I/O layer handling HTTP endpoints and WebSocket connections.
//!
//! - **http**: REST API endpoints
//! - **ws**: WebSocket handler for real-time streaming
//! - **poller**: Background task for polling tmux sessions

pub mod http;
pub mod poller;
pub mod ws;

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use tracing::info;

use crate::config::Config;
use crate::model::{list_sessions, new_shared_states, ModelError, SessionState, SharedSessionStates};
use crate::utils::{
    Git, GitClient, JsonSessionStore, Ntfy, NtfyClient, SessionStore, Tmux, TmuxClient, WebPush,
    WebPushClient,
};

pub use poller::{add_subscriber, new_subscriber_map, remove_subscriber, SubscriberMap};

/// Stop function type
pub type StopFn = Box<dyn FnOnce() -> Pin<Box<dyn Future<Output = ()> + Send>> + Send>;

/// Start all controllers (HTTP, WebSocket, output poller)
pub async fn start(config: &Config) -> Result<StopFn, ModelError> {
    let config = Arc::new(config.clone());

    // Create dependencies
    let tmux: Arc<dyn TmuxClient> = Arc::new(Tmux::new());
    let git: Arc<dyn GitClient> = Arc::new(Git::new());
    let ntfy: Arc<dyn NtfyClient> = Arc::new(Ntfy::new(&config));
    let push: Arc<dyn WebPushClient> = Arc::new(WebPush::new(&config));
    let session_states = new_shared_states();
    let subscribers = new_subscriber_map();

    // Create session store (graceful degradation on failure)
    let session_store: Arc<dyn SessionStore> = match JsonSessionStore::new(&config).await {
        Ok(store) => Arc::new(store),
        Err(e) => {
            tracing::warn!(error = %e, "Failed to initialize session store, state won't persist");
            Arc::new(crate::utils::NoopSessionStore)
        }
    };

    // Discover existing tmux sessions and restore persisted names
    initialize_session_states(&tmux, &session_states, &session_store).await?;

    // Start HTTP server (now also serves WebSocket on /ws)
    let http_stop = http::start(
        config.clone(),
        tmux.clone(),
        git.clone(),
        ntfy.clone(),
        push.clone(),
        session_states.clone(),
        subscribers.clone(),
        session_store.clone(),
    )
    .await?;

    // Start output polling task
    let poller_handle = poller::start_poller(
        tmux.clone(),
        ntfy.clone(),
        push.clone(),
        session_states.clone(),
        subscribers.clone(),
        session_store.clone(),
    );

    // Return combined stop function
    let stop_fn: StopFn = Box::new(move || {
        Box::pin(async move {
            info!("Stopping controllers...");

            // Stop the poller
            poller_handle.abort();

            // Stop HTTP server
            http_stop().await;

            info!("All controllers stopped");
        })
    });

    Ok(stop_fn)
}

/// Initialize session states from existing tmux sessions
///
/// Restores persisted session state (name, status, timing) and prunes orphaned entries.
async fn initialize_session_states(
    tmux: &Arc<dyn TmuxClient>,
    session_states: &SharedSessionStates,
    session_store: &Arc<dyn SessionStore>,
) -> Result<(), ModelError> {
    let sessions = list_sessions(tmux.as_ref()).await?;

    // Load persisted session states
    let persisted_states = match session_store.load().await {
        Ok(states) => states,
        Err(e) => {
            tracing::warn!(error = %e, "Failed to load persisted session states");
            std::collections::HashMap::new()
        }
    };

    let mut states = session_states.write().await;
    let mut active_ids = Vec::with_capacity(sessions.len());

    for session in sessions {
        active_ids.push(session.id.clone());

        // Restore persisted state if available
        let state = if let Some(persisted) = persisted_states.get(&session.id) {
            // Restore full state from persisted data
            SessionState::from_persisted(persisted.clone())
        } else {
            SessionState::new()
        };
        states.insert(session.id.clone(), state);
    }

    info!(count = states.len(), "Initialized session states");

    // Prune orphaned sessions (non-fatal)
    if let Err(e) = session_store.prune(&active_ids).await {
        tracing::warn!(error = %e, "Failed to prune orphaned sessions");
    }

    Ok(())
}

// Re-export commonly used types
pub use http::AppState;
pub use ws::{ClientMessage, ServerMessage};
