//! Controller Layer
//!
//! I/O layer handling HTTP endpoints and WebSocket connections.
//!
//! - **http**: REST API endpoints
//! - **ws**: WebSocket handler for real-time streaming
//! - **poller**: Background task for polling tmux sessions

pub mod deploy;
pub mod http;
pub mod maintainer;
pub mod poller;
pub mod ralph;
pub mod ws;

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use regex::Regex;
use tracing::{info, warn};

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

    // Discover existing tmux sessions, restore persisted names, and keep orphans for manual recovery
    initialize_session_states(&tmux, &session_states, &session_store).await?;

    // Create inbox directory
    let inbox_path = maintainer::inbox_dir(&config.data_dir);
    if let Err(e) = tokio::fs::create_dir_all(&inbox_path).await {
        warn!(error = %e, "Failed to create inbox directory");
    }

    // Create deploy state (shared between HTTP handlers and ralph auto-deploy)
    let deploy_state = deploy::DeployState::new(&config.data_dir);

    // Create global broadcast channel for session list changes
    let (global_broadcast, _) = tokio::sync::broadcast::channel::<ws::ServerMessage>(256);

    // Start HTTP server (now also serves WebSocket on /ws)
    let (http_stop, app_state) = http::start(
        config.clone(),
        tmux.clone(),
        git.clone(),
        ntfy.clone(),
        push.clone(),
        session_states.clone(),
        subscribers.clone(),
        session_store.clone(),
        deploy_state.clone(),
        global_broadcast.clone(),
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
        global_broadcast.clone(),
    );

    // Start maintainer session and ralph loop
    let ralph_handle = start_maintainer(
        &config,
        &tmux,
        &session_states,
        &session_store,
        deploy_state,
        push.clone(),
    ).await;

    // Register ralph handle with app state so API can report status/pause/resume
    if let Some(handle) = ralph_handle {
        app_state.set_ralph_handle(handle).await;
        // Re-acquire for the stop function
        let app_state_stop = app_state.clone();

        // Return combined stop function
        let stop_fn: StopFn = Box::new(move || {
            Box::pin(async move {
                info!("Stopping controllers...");

                // Stop the ralph loop
                {
                    let rh = app_state_stop.ralph_handle.read().await;
                    if let Some(handle) = rh.as_ref() {
                        handle.abort();
                    }
                }

                // Stop the poller
                poller_handle.abort();

                // Stop HTTP server
                http_stop().await;

                info!("All controllers stopped");
            })
        });

        return Ok(stop_fn);
    }

    // Return combined stop function (no ralph)
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

/// Start the maintainer session and ralph loop
async fn start_maintainer(
    config: &Arc<Config>,
    tmux: &Arc<dyn TmuxClient>,
    session_states: &SharedSessionStates,
    session_store: &Arc<dyn SessionStore>,
    deploy_state: deploy::DeployState,
    push: Arc<dyn WebPushClient>,
) -> Option<ralph::RalphHandle> {
    let session_id = maintainer::MAINTAINER_SESSION_ID;

    // Check if maintainer session already exists in tmux
    let exists = match tmux.has_session(session_id).await {
        Ok(exists) => exists,
        Err(e) => {
            warn!(error = %e, "Failed to check maintainer session");
            return None;
        }
    };

    if !exists {
        // Find the woodchuck repo directory (parent of the data_dir, or use a config)
        // For now, use the current working directory or a sensible default
        let repo_dir = std::env::current_dir()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|_| config.projects_dir.clone());

        // Check if we're recovering from a crash (session was previously tracked)
        let was_previously_tracked = match session_store.load().await {
            Ok(states) => states.contains_key(session_id),
            Err(_) => false,
        };

        // Use --continue when recovering to restore Claude's conversation context
        let cmd = if was_previously_tracked {
            "claude --continue --dangerously-skip-permissions"
        } else {
            "claude --dangerously-skip-permissions"
        };

        match tmux.new_session(session_id, &repo_dir, cmd).await {
            Ok(()) => {
                if was_previously_tracked {
                    info!("Recovered maintainer session with --continue");
                } else {
                    info!("Created maintainer session");
                }

                // Track in session states
                let mut states = session_states.write().await;
                let mut state = SessionState::with_name("Woodchuck Maintainer".to_string());
                state.is_maintainer = true;
                state.folder = Some(repo_dir.clone());
                states.insert(session_id.to_string(), state);

                // Persist
                let persisted = crate::utils::PersistedSessionState {
                    name: "Woodchuck Maintainer".to_string(),
                    status: crate::model::SessionStatus::Working,
                    working_since: Some(chrono::Utc::now()),
                    last_working_at: Some(chrono::Utc::now()),
                    project_id: None,
                    last_input: None,
                    last_input_at: None,
                    tags: Vec::new(),
                    last_notified_status: None,
                    folder: Some(repo_dir),
                };
                let store = session_store.clone();
                let sid = session_id.to_string();
                tokio::spawn(async move {
                    if let Err(e) = store.save(&sid, &persisted).await {
                        warn!(error = %e, "Failed to persist maintainer state");
                    }
                });
            }
            Err(e) => {
                warn!(error = %e, "Failed to create maintainer session");
                return None;
            }
        }
    } else {
        // Session exists, make sure it's tracked
        let mut states = session_states.write().await;
        if !states.contains_key(session_id) {
            let mut state = SessionState::with_name("Woodchuck Maintainer".to_string());
            state.is_maintainer = true;
            states.insert(session_id.to_string(), state);
        } else {
            // Mark existing state as maintainer
            if let Some(state) = states.get_mut(session_id) {
                state.is_maintainer = true;
            }
        }
        info!("Attached to existing maintainer session");
    }

    // Build ralph config for the maintainer
    let inbox_path = maintainer::inbox_dir(&config.data_dir);

    // Auto-deploy: monitor repo for new commits, build + deploy
    let repo_dir = std::env::current_dir()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|_| config.projects_dir.clone());
    let auto_deploy = ralph::AutoDeployConfig {
        repo_dir,
        deploy: deploy_state,
        push,
        last_commit_file: std::path::PathBuf::from(&config.data_dir).join("last-deploy-commit"),
    };

    let ralph_config = ralph::RalphConfig {
        session_id: session_id.to_string(),
        auto_responses: vec![
            ralph::AutoResponse {
                pattern: Regex::new(r"(?i)\(y/n\)").unwrap(),
                response: "y".to_string(),
            },
            ralph::AutoResponse {
                pattern: Regex::new(r"(?i)Trust this").unwrap(),
                response: "y".to_string(),
            },
            ralph::AutoResponse {
                pattern: Regex::new(r"(?i)Do you want to").unwrap(),
                response: "y".to_string(),
            },
            ralph::AutoResponse {
                pattern: Regex::new(r"(?i)Would you like").unwrap(),
                response: "y".to_string(),
            },
            ralph::AutoResponse {
                pattern: Regex::new(r"Press Enter").unwrap(),
                response: String::new(), // bare Enter
            },
        ],
        max_auto_responses_per_task: 20,
        cooldown: Duration::from_secs(3),
        on_resting: ralph::OnResting::CheckInbox { path: inbox_path },
        inbox_check_delay: Duration::from_secs(10),
        auto_deploy: Some(auto_deploy),
    };

    let handle = ralph::start_ralph_loop(
        ralph_config,
        tmux.clone(),
        session_states.clone(),
    );

    info!("Maintainer ralph loop started");
    Some(handle)
}

/// Initialize session states from existing tmux sessions
///
/// Restores persisted session state (name, status, timing) for live sessions.
/// Orphaned sessions (persisted but tmux dead) with a folder are kept in the
/// store for user-driven recovery via API. Sessions without a folder are pruned.
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

    for session in &sessions {
        active_ids.push(session.id.clone());

        // Restore persisted state if available
        let mut state = if let Some(persisted) = persisted_states.get(&session.id) {
            SessionState::from_persisted(persisted.clone())
        } else {
            // No persisted state — session existed before persistence or store
            // was lost. Pre-set last_notified_status to current status so the
            // poller doesn't fire a spurious notification on the first poll.
            let mut state = SessionState::new();
            state.last_notified_status = Some(state.status);
            state
        };
        // Always update folder from live tmux data (most reliable source)
        state.folder = Some(session.folder.clone());
        states.insert(session.id.clone(), state);
    }

    info!(count = states.len(), "Initialized live session states");

    // Keep orphaned sessions WITH folders in the store (recoverable via API).
    // Add their IDs to active_ids so prune() won't remove them.
    // Sessions without a folder are unrecoverable and will be pruned.
    let orphaned_with_folder: Vec<String> = persisted_states.iter()
        .filter(|(id, ps)| {
            !active_ids.contains(id)
                && ps.folder.is_some()
                && id.as_str() != maintainer::MAINTAINER_SESSION_ID
        })
        .map(|(id, _)| id.clone())
        .collect();

    if !orphaned_with_folder.is_empty() {
        info!(count = orphaned_with_folder.len(), "Keeping orphaned sessions for user recovery via API");
    }

    active_ids.extend(orphaned_with_folder);

    // Prune sessions that are neither live nor recoverable (non-fatal)
    if let Err(e) = session_store.prune(&active_ids).await {
        tracing::warn!(error = %e, "Failed to prune orphaned sessions");
    }

    Ok(())
}

// Re-export commonly used types
pub use http::AppState;
pub use ws::{ClientMessage, ServerMessage};
