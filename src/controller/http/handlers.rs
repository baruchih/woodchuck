//! HTTP request handlers
//!
//! Handler functions for all API endpoints.

use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    Json,
};
use serde::Deserialize;
use tracing::{debug, info, instrument, warn};

use super::response::{
    err, ApiResponse, CommandsData, FolderCreatedData, FoldersData, HealthData, HookData,
    InputSentData, PollData, ProjectCreatedData, ProjectDeletedData, ProjectRenamedData,
    ProjectsData, PushSubscribedData, PushUnsubscribedData, ResizeData, SessionCreatedData,
    SessionData, SessionKilledData, SessionUpdatedData, SessionsData, VapidKeyData,
};
use super::state::AppState;

/// Common result type for API handlers (avoids clippy::type_complexity)
type ApiResult<T> = Result<Json<ApiResponse<T>>, (StatusCode, Json<ApiResponse<()>>)>;
type ApiResultCreated<T> = Result<(StatusCode, Json<ApiResponse<T>>), (StatusCode, Json<ApiResponse<()>>)>;

use crate::model::{
    create_folder, create_session, delete_session, get_session, get_session_output, list_commands,
    list_commands_with_skills, list_folders, list_sessions, poll_output, process_hook_event,
    resize_session, send_input, validate_hook_session, validate_rename, CreateFolderParams,
    CreateSessionParams, CreateProjectParams, HookEventParams, RenameProjectParams, ResizeParams,
    SendInputParams, UpdateSessionParams, Project,
};
use crate::utils::PushSubscription;

// =============================================================================
// Health
// =============================================================================

/// GET /health - Health check endpoint
#[instrument(skip_all)]
pub async fn health_handler() -> Json<ApiResponse<HealthData>> {
    debug!("Health check");
    ApiResponse::ok(HealthData {
        status: "ok".to_string(),
    })
}

// =============================================================================
// Sessions
// =============================================================================

/// GET /sessions - List all sessions
#[instrument(skip(state))]
pub async fn list_sessions_handler(
    State(state): State<AppState>,
) -> ApiResult<SessionsData> {
    let mut sessions = list_sessions(state.tmux.as_ref()).await.map_err(err)?;

    // Ensure all sessions are tracked (for push notifications after server restart)
    // and overlay status, working_since, name, project_id, and last_input from shared state
    {
        let mut states = state.session_states.write().await;
        for session in &mut sessions {
            let ss = states.entry(session.id.clone()).or_insert_with(|| {
                // Session discovered after restart - we don't have the user-provided name
                // Just create an empty state; the session.name will stay as the ID
                debug!(session_id = %session.id, "Creating default state for discovered session");
                crate::model::SessionState::default()
            });
            // Prefer hook-provided status over terminal-parsed status if available
            // Hook status is more reliable (from Claude Code hooks) vs fragile terminal parsing
            if ss.status != crate::model::SessionStatus::Resting || ss.working_since.is_some() {
                session.status = ss.status;
            }
            session.working_since = ss.working_since;
            session.project_id = ss.project_id.clone();
            session.last_input = ss.last_input.clone();
            // Only overlay name if we have a user-provided name stored
            if !ss.name.is_empty() {
                debug!(session_id = %session.id, stored_name = %ss.name, "Overlaying stored name");
                session.name = ss.name.clone();
            } else {
                debug!(session_id = %session.id, "No stored name, using ID as name");
            }
        }
    }

    info!(count = sessions.len(), "Listed sessions");
    Ok(ApiResponse::ok(SessionsData { sessions }))
}

/// GET /sessions/:id - Get a specific session
#[instrument(skip(state))]
pub async fn get_session_handler(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
) -> ApiResult<SessionData> {
    let mut session = get_session(state.tmux.as_ref(), &session_id)
        .await
        .map_err(err)?;

    // Overlay status, working_since, name, project_id, and last_input from shared state
    let states = state.session_states.read().await;
    if let Some(ss) = states.get(&session.id) {
        // Prefer hook-provided status over terminal-parsed status if available
        if ss.status != crate::model::SessionStatus::Resting || ss.working_since.is_some() {
            session.status = ss.status;
        }
        session.working_since = ss.working_since;
        session.project_id = ss.project_id.clone();
        session.last_input = ss.last_input.clone();
        if !ss.name.is_empty() {
            session.name = ss.name.clone();
        }
    }

    let recent_output = get_session_output(state.tmux.as_ref(), &session_id, 200)
        .await
        .ok();

    info!(session = %session_id, "Got session");
    Ok(ApiResponse::ok(SessionData {
        session,
        recent_output,
    }))
}

/// POST /sessions - Create a new session
#[instrument(skip(state))]
pub async fn create_session_handler(
    State(state): State<AppState>,
    Json(params): Json<CreateSessionParams>,
) -> ApiResultCreated<SessionCreatedData> {
    let session = create_session(state.tmux.as_ref(), &state.config, params)
        .await
        .map_err(err)?;

    state.track_session(&session.id, &session.name).await;

    // Inject Claude Code hooks into the project folder (non-fatal if fails)
    if let Err(e) = crate::utils::inject_hooks(&session.id, &session.folder, &state.config.external_url).await {
        warn!(session = %session.id, error = %e, "Hook injection failed, session created without hooks");
    }

    // Persist session state (non-fatal if fails)
    let persisted_state = crate::utils::PersistedSessionState::with_name(session.name.clone());
    if let Err(e) = state.session_store.save(&session.id, &persisted_state).await {
        warn!(session = %session.id, error = %e, "Failed to persist session state");
    }

    info!(session = %session.id, "Created session");
    Ok((
        StatusCode::CREATED,
        ApiResponse::ok(SessionCreatedData { session }),
    ))
}

/// DELETE /sessions/:id - Delete a session
#[instrument(skip(state))]
pub async fn delete_session_handler(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
) -> ApiResult<SessionKilledData> {
    delete_session(state.tmux.as_ref(), &session_id)
        .await
        .map_err(err)?;

    state.untrack_session(&session_id).await;

    // Remove persisted session state (non-fatal if fails)
    if let Err(e) = state.session_store.remove(&session_id).await {
        warn!(session = %session_id, error = %e, "Failed to remove persisted session state");
    }

    info!(session = %session_id, "Deleted session");
    Ok(ApiResponse::ok(SessionKilledData { killed: true }))
}

/// Maximum length for stored last_input (truncated if longer)
const LAST_INPUT_MAX_LENGTH: usize = 500;

/// POST /sessions/:id/input - Send input to a session
#[instrument(skip(state))]
pub async fn send_input_handler(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
    Json(params): Json<SendInputParams>,
) -> ApiResult<InputSentData> {
    send_input(state.tmux.as_ref(), &session_id, &params.text)
        .await
        .map_err(err)?;

    // Capture last_input (truncated to LAST_INPUT_MAX_LENGTH chars)
    // Use char count for consistent Unicode handling
    let char_count = params.text.chars().count();
    let last_input = if char_count > LAST_INPUT_MAX_LENGTH {
        params.text.chars().take(LAST_INPUT_MAX_LENGTH).collect::<String>()
    } else {
        params.text.clone()
    };

    // Update shared state and persist
    {
        let mut states = state.session_states.write().await;
        if let Some(ss) = states.get_mut(&session_id) {
            ss.last_input = Some(last_input);

            // Persist updated state (non-fatal if fails)
            let persisted = ss.to_persisted();
            if let Err(e) = state.session_store.save(&session_id, &persisted).await {
                warn!(session = %session_id, error = %e, "Failed to persist last_input");
            }
        }
    }

    info!(session = %session_id, "Sent input");
    Ok(ApiResponse::ok(InputSentData { sent: true }))
}

/// GET /sessions/:id/poll - Lightweight poll for session output
#[instrument(skip(state))]
pub async fn poll_handler(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
) -> ApiResult<PollData> {
    let (content, status) = poll_output(state.tmux.as_ref(), &session_id)
        .await
        .map_err(err)?;

    debug!(session = %session_id, status = %status, "Polled session");
    Ok(ApiResponse::ok(PollData {
        content,
        status: status.to_string(),
    }))
}

/// POST /sessions/:id/resize - Resize a session's tmux pane
#[instrument(skip(state))]
pub async fn resize_handler(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
    Json(params): Json<ResizeParams>,
) -> ApiResult<ResizeData> {
    resize_session(state.tmux.as_ref(), &session_id, params.cols, params.rows)
        .await
        .map_err(err)?;

    info!(session = %session_id, cols = %params.cols, rows = %params.rows, "Resized session");
    Ok(ApiResponse::ok(ResizeData { resized: true }))
}

/// POST /sessions/:id/hook - Receive status update from Claude Code hook
#[instrument(skip(state))]
pub async fn hook_handler(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
    Json(params): Json<HookEventParams>,
) -> ApiResult<HookData> {
    // 1. Validate session_id format and session exists
    validate_hook_session(state.tmux.as_ref(), &session_id)
        .await
        .map_err(err)?;

    // 2. Process hook event (pure model function)
    let new_status = process_hook_event(&params.event).map_err(err)?;

    // 3. Update state + broadcast + persist (AppState helper)
    let accepted = state.update_session_status(&session_id, new_status).await.is_some();

    debug!(
        session = %session_id,
        event = %params.event,
        status = %new_status,
        accepted,
        "Hook event processed"
    );

    Ok(ApiResponse::ok(HookData {
        status: new_status.to_string(),
        accepted,
    }))
}

/// PATCH /sessions/:id - Update a session (name and/or project)
#[instrument(skip(state))]
pub async fn update_session_handler(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
    Json(params): Json<UpdateSessionParams>,
) -> ApiResult<SessionUpdatedData> {
    // Check session exists in tmux
    if !state.tmux.has_session(&session_id).await.map_err(err)? {
        return Err(err(crate::model::ModelError::SessionNotFound(session_id)));
    }

    // Validate new name if provided
    let validated_name = if let Some(ref name) = params.name {
        Some(validate_rename(&session_id, name).map_err(err)?)
    } else {
        None
    };

    // Validate project_id if provided (must exist)
    if let Some(Some(ref project_id)) = params.project_id {
        let projects = state.session_store.load_projects().await.map_err(err)?;
        if !projects.contains_key(project_id) {
            return Err(err(crate::model::ModelError::ProjectNotFound(project_id.clone())));
        }
    }

    // Update shared state and get the full state for persistence
    let (final_name, final_project_id) = {
        let mut states = state.session_states.write().await;
        let ss = states.entry(session_id.clone()).or_insert_with(|| {
            crate::model::SessionState::default()
        });

        // Update name if provided
        if let Some(ref new_name) = validated_name {
            ss.name = new_name.clone();
        }

        // Update project_id if provided (Some(Some(id)) = set, Some(None) = clear)
        if let Some(new_project_id) = params.project_id.clone() {
            ss.project_id = new_project_id;
        }

        let persisted = ss.to_persisted();
        let name = if ss.name.is_empty() { None } else { Some(ss.name.clone()) };
        let project_id = ss.project_id.clone();

        // Persist full state (non-fatal if fails)
        if let Err(e) = state.session_store.save(&session_id, &persisted).await {
            warn!(session = %session_id, error = %e, "Failed to persist updated session");
        }

        (name, project_id)
    };

    info!(session = %session_id, name = ?final_name, project_id = ?final_project_id, "Updated session");
    Ok(ApiResponse::ok(SessionUpdatedData {
        name: final_name,
        project_id: final_project_id,
    }))
}

// =============================================================================
// Folders
// =============================================================================

/// GET /folders - List available project folders
#[instrument(skip(state))]
pub async fn list_folders_handler(
    State(state): State<AppState>,
) -> ApiResult<FoldersData> {
    let folders = list_folders(&state.config).map_err(err)?;

    info!(count = folders.len(), "Listed folders");
    Ok(ApiResponse::ok(FoldersData { folders }))
}

/// POST /folders - Create a new folder or clone a repository
#[instrument(skip(state))]
pub async fn create_folder_handler(
    State(state): State<AppState>,
    Json(params): Json<CreateFolderParams>,
) -> ApiResultCreated<FolderCreatedData> {
    let path = create_folder(state.git.as_ref(), &state.config, params)
        .await
        .map_err(err)?;

    info!(path = %path, "Created folder");
    Ok((
        StatusCode::CREATED,
        ApiResponse::ok(FolderCreatedData { path }),
    ))
}

// =============================================================================
// Push Notifications
// =============================================================================

/// GET /push/vapid-key - Get the VAPID public key for web push subscriptions
#[instrument(skip(state))]
pub async fn vapid_key_handler(State(state): State<AppState>) -> Json<ApiResponse<VapidKeyData>> {
    let public_key = state.push.public_key();
    debug!(enabled = state.push.is_enabled(), "VAPID key requested");
    ApiResponse::ok(VapidKeyData { public_key })
}

/// POST /push/subscribe - Subscribe to web push notifications
#[instrument(skip(state, subscription))]
pub async fn push_subscribe_handler(
    State(state): State<AppState>,
    Json(subscription): Json<PushSubscription>,
) -> ApiResult<PushSubscribedData> {
    state.push.subscribe(subscription).await.map_err(err)?;
    info!("Push subscription added");
    Ok(ApiResponse::ok(PushSubscribedData { subscribed: true }))
}

/// POST /push/unsubscribe - Unsubscribe from web push notifications
#[instrument(skip(state))]
pub async fn push_unsubscribe_handler(
    State(state): State<AppState>,
    Json(params): Json<UnsubscribeParams>,
) -> Json<ApiResponse<PushUnsubscribedData>> {
    state.push.unsubscribe(&params.endpoint).await;
    info!("Push subscription removed");
    ApiResponse::ok(PushUnsubscribedData { unsubscribed: true })
}

/// Parameters for unsubscribe request
#[derive(Debug, serde::Deserialize)]
pub struct UnsubscribeParams {
    pub endpoint: String,
}

// =============================================================================
// Commands
// =============================================================================

/// Query parameters for commands endpoint
#[derive(Debug, Deserialize)]
pub struct CommandsQuery {
    /// Optional session ID to include project-specific skills
    pub session_id: Option<String>,
}

/// GET /commands - List available slash commands
///
/// If session_id is provided and valid, includes project-specific skills
/// discovered from the session's folder.
#[instrument(skip(state))]
pub async fn list_commands_handler(
    State(state): State<AppState>,
    Query(query): Query<CommandsQuery>,
) -> Json<ApiResponse<CommandsData>> {
    let commands = if let Some(ref session_id) = query.session_id {
        // Try to get the session's folder for skill discovery
        match get_session(state.tmux.as_ref(), session_id).await {
            Ok(session) => {
                debug!(session_id = %session_id, folder = %session.folder, "Discovering skills for session");
                list_commands_with_skills(&session.folder)
            }
            Err(_) => {
                // Session not found or error - fall back to static commands
                debug!(session_id = %session_id, "Session not found, using static commands");
                list_commands()
            }
        }
    } else {
        list_commands()
    };

    debug!(count = commands.len(), "Listed commands");
    ApiResponse::ok(CommandsData { commands })
}

// =============================================================================
// Projects
// =============================================================================

/// GET /projects - List all projects
#[instrument(skip(state))]
pub async fn list_projects_handler(
    State(state): State<AppState>,
) -> ApiResult<ProjectsData> {
    let projects_map = state.session_store.load_projects().await.map_err(err)?;

    let mut projects: Vec<Project> = projects_map
        .into_iter()
        .map(|(id, p)| Project {
            id,
            name: p.name,
            created_at: p.created_at,
        })
        .collect();

    // Sort by created_at descending (newest first)
    projects.sort_by(|a, b| b.created_at.cmp(&a.created_at));

    info!(count = projects.len(), "Listed projects");
    Ok(ApiResponse::ok(ProjectsData { projects }))
}

/// POST /projects - Create a new project
#[instrument(skip(state))]
pub async fn create_project_handler(
    State(state): State<AppState>,
    Json(params): Json<CreateProjectParams>,
) -> ApiResultCreated<ProjectCreatedData> {
    // Validate project name
    let name = params.name.trim();
    if name.is_empty() {
        return Err(err(crate::model::ModelError::ValidationError(
            "Project name cannot be empty".to_string(),
        )));
    }

    // Generate a unique project ID
    let project_id = format!("proj-{}", uuid::Uuid::new_v4().to_string().split('-').next().unwrap_or(""));

    let now = chrono::Utc::now();
    let persisted_project = crate::utils::PersistedProject {
        name: name.to_string(),
        created_at: now,
    };

    state
        .session_store
        .save_project(&project_id, &persisted_project)
        .await
        .map_err(err)?;

    let project = Project {
        id: project_id.clone(),
        name: name.to_string(),
        created_at: now,
    };

    info!(project_id = %project_id, name = %name, "Created project");
    Ok((StatusCode::CREATED, ApiResponse::ok(ProjectCreatedData { project })))
}

/// PATCH /projects/:id - Rename a project
#[instrument(skip(state))]
pub async fn rename_project_handler(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    Json(params): Json<RenameProjectParams>,
) -> ApiResult<ProjectRenamedData> {
    // Validate new name
    let name = params.name.trim();
    if name.is_empty() {
        return Err(err(crate::model::ModelError::ValidationError(
            "Project name cannot be empty".to_string(),
        )));
    }

    // Load existing project
    let projects = state.session_store.load_projects().await.map_err(err)?;
    let existing = projects.get(&project_id).ok_or_else(|| {
        err(crate::model::ModelError::ProjectNotFound(project_id.clone()))
    })?;

    // Update project with new name
    let updated = crate::utils::PersistedProject {
        name: name.to_string(),
        created_at: existing.created_at,
    };

    state
        .session_store
        .save_project(&project_id, &updated)
        .await
        .map_err(err)?;

    info!(project_id = %project_id, new_name = %name, "Renamed project");
    Ok(ApiResponse::ok(ProjectRenamedData { name: name.to_string() }))
}

/// DELETE /projects/:id - Delete a project (sessions become ungrouped)
#[instrument(skip(state))]
pub async fn delete_project_handler(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
) -> ApiResult<ProjectDeletedData> {
    // Check project exists
    let projects = state.session_store.load_projects().await.map_err(err)?;
    if !projects.contains_key(&project_id) {
        return Err(err(crate::model::ModelError::ProjectNotFound(project_id)));
    }

    // Remove project (this also clears project_id from sessions in the store)
    state.session_store.remove_project(&project_id).await.map_err(err)?;

    // Also update in-memory session states
    {
        let mut states = state.session_states.write().await;
        for ss in states.values_mut() {
            if ss.project_id.as_deref() == Some(&project_id) {
                ss.project_id = None;
            }
        }
    }

    info!(project_id = %project_id, "Deleted project");
    Ok(ApiResponse::ok(ProjectDeletedData { deleted: true }))
}
