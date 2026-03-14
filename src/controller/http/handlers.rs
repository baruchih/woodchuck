//! HTTP request handlers
//!
//! Handler functions for all API endpoints.

use axum::{
    extract::{Multipart, Path, Query, State},
    http::StatusCode,
    Json,
};
use serde::Deserialize;
use tracing::{debug, info, instrument, warn};

use super::response::{
    err, err_msg, ApiResponse, CommandsData, DeployAbortData, DeployStatusData, DeployTriggerData,
    FileEntry, FolderCreatedData, FoldersData, HealthData, HookData, InboxItemData, InputSentData,
    MaintainerStatusData, PollData, ProjectCreatedData, ProjectDeletedData, ProjectRenamedData,
    ProjectsData, PushSubscribedData, PushUnsubscribedData, ResizeData, SessionCreatedData,
    SessionData, SessionFilesData, SessionKilledData, SessionUpdatedData, SessionsData, TemplateData,
    TemplateDeletedData, TemplatesListData, UploadProjectData, UploadedFilesData, UploadedImageData, VapidKeyData,
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
    SendInputParams, UpdateSessionParams, Project, CreateTemplateParams,
};
use crate::utils::PushSubscription;

/// Unique ID for this process instance — changes on every restart/re-exec.
static BUILD_ID: std::sync::LazyLock<String> = std::sync::LazyLock::new(|| {
    uuid::Uuid::new_v4().to_string()
});

// =============================================================================
// Health
// =============================================================================

/// GET /health - Health check endpoint
#[instrument(skip_all)]
pub async fn health_handler() -> Json<ApiResponse<HealthData>> {
    debug!("Health check");
    ApiResponse::ok(HealthData {
        status: "ok".to_string(),
        build_id: BUILD_ID.clone(),
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
            session.tags = ss.tags.clone();
            // Only overlay name if we have a user-provided name stored
            if !ss.name.is_empty() {
                debug!(session_id = %session.id, stored_name = %ss.name, "Overlaying stored name");
                session.name = ss.name.clone();
            } else {
                debug!(session_id = %session.id, "No stored name, using ID as name");
            }
        }
    }

    // Filter out maintainer session from the public list
    sessions.retain(|s| s.id != super::super::maintainer::MAINTAINER_SESSION_ID);

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
        session.tags = ss.tags.clone();
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
    let (final_name, final_project_id, final_tags) = {
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

        // Update tags if provided
        if let Some(new_tags) = params.tags.clone() {
            ss.tags = new_tags;
        }

        let persisted = ss.to_persisted();
        let name = if ss.name.is_empty() { None } else { Some(ss.name.clone()) };
        let project_id = ss.project_id.clone();
        let tags = ss.tags.clone();

        // Persist full state (non-fatal if fails)
        if let Err(e) = state.session_store.save(&session_id, &persisted).await {
            warn!(session = %session_id, error = %e, "Failed to persist updated session");
        }

        (name, project_id, tags)
    };

    info!(session = %session_id, name = ?final_name, project_id = ?final_project_id, "Updated session");
    Ok(ApiResponse::ok(SessionUpdatedData {
        name: final_name,
        project_id: final_project_id,
        tags: final_tags,
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

/// POST /folders/upload - Upload files as a new project folder
///
/// Supports two modes:
/// - **Zip mode**: fields `name` + single `file` (zip is extracted)
/// - **Files mode**: field `name` + multiple `files` fields, each with
///   `webkitRelativePath` in a `paths` field (written preserving directory structure)
#[instrument(skip(state, multipart))]
pub async fn upload_project_handler(
    State(state): State<AppState>,
    mut multipart: Multipart,
) -> ApiResultCreated<UploadProjectData> {
    let mut name: Option<String> = None;
    let mut zip_data: Option<Vec<u8>> = None;
    let mut loose_files: Vec<(String, Vec<u8>)> = Vec::new();

    // Extract fields from multipart
    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|e| err_msg(StatusCode::BAD_REQUEST, &format!("Invalid multipart: {}", e), "INVALID_INPUT"))?
    {
        let field_name = field.name().unwrap_or("").to_string();
        match field_name.as_str() {
            "name" => {
                let val = field.text().await.map_err(|e| {
                    err_msg(StatusCode::BAD_REQUEST, &format!("Failed to read name: {}", e), "INVALID_INPUT")
                })?;
                name = Some(val);
            }
            "file" => {
                let bytes = field.bytes().await.map_err(|e| {
                    err_msg(StatusCode::BAD_REQUEST, &format!("Failed to read file: {}", e), "INVALID_INPUT")
                })?;
                zip_data = Some(bytes.to_vec());
            }
            "files" => {
                // Get the relative path from the filename (browsers set this for webkitdirectory)
                let file_path = field.file_name().unwrap_or("").to_string();
                let bytes = field.bytes().await.map_err(|e| {
                    err_msg(StatusCode::BAD_REQUEST, &format!("Failed to read file: {}", e), "INVALID_INPUT")
                })?;
                if !file_path.is_empty() {
                    loose_files.push((file_path, bytes.to_vec()));
                }
            }
            _ => {} // ignore unknown fields
        }
    }

    let name = name
        .filter(|n| !n.trim().is_empty())
        .map(|n| n.trim().to_string())
        .ok_or_else(|| err_msg(StatusCode::BAD_REQUEST, "Missing 'name' field", "INVALID_INPUT"))?;

    let path = if !loose_files.is_empty() {
        crate::model::upload_project_files(&state.config, &name, &loose_files)
            .await
            .map_err(err)?
    } else if let Some(data) = zip_data {
        crate::model::upload_project(&state.config, &name, &data)
            .await
            .map_err(err)?
    } else {
        return Err(err_msg(StatusCode::BAD_REQUEST, "No files uploaded", "INVALID_INPUT"));
    };

    info!(path = %path, "Uploaded project");
    Ok((
        StatusCode::CREATED,
        ApiResponse::ok(UploadProjectData { path }),
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

// =============================================================================
// Templates
// =============================================================================

/// GET /templates - List all templates
#[instrument(skip(state))]
pub async fn list_templates_handler(
    State(state): State<AppState>,
) -> ApiResult<TemplatesListData> {
    let templates = state.session_store.load_templates().await.map_err(err)?;

    info!(count = templates.len(), "Listed templates");
    Ok(ApiResponse::ok(TemplatesListData { templates }))
}

/// POST /templates - Create a new template
#[instrument(skip(state))]
pub async fn create_template_handler(
    State(state): State<AppState>,
    Json(params): Json<CreateTemplateParams>,
) -> ApiResultCreated<TemplateData> {
    let name = params.name.trim();
    if name.is_empty() {
        return Err(err(crate::model::ModelError::ValidationError(
            "Template name cannot be empty".to_string(),
        )));
    }

    let template_id = format!("tmpl-{}", uuid::Uuid::new_v4().to_string().split('-').next().unwrap_or(""));
    let now = chrono::Utc::now();

    let persisted = crate::utils::PersistedTemplate {
        name: name.to_string(),
        folder: params.folder,
        prompt: params.prompt,
        created_at: now,
    };

    state
        .session_store
        .save_template(&template_id, &persisted)
        .await
        .map_err(err)?;

    let template = crate::model::Template {
        id: template_id.clone(),
        name: name.to_string(),
        folder: persisted.folder,
        prompt: persisted.prompt,
        created_at: now,
    };

    info!(template_id = %template_id, name = %name, "Created template");
    Ok((StatusCode::CREATED, ApiResponse::ok(TemplateData { template })))
}

/// DELETE /templates/:id - Delete a template
#[instrument(skip(state))]
pub async fn delete_template_handler(
    State(state): State<AppState>,
    Path(template_id): Path<String>,
) -> ApiResult<TemplateDeletedData> {
    // Check template exists
    let templates = state.session_store.load_templates().await.map_err(err)?;
    if !templates.iter().any(|t| t.id == template_id) {
        return Err(err(crate::model::ModelError::ValidationError(
            format!("Template not found: {}", template_id),
        )));
    }

    state.session_store.remove_template(&template_id).await.map_err(err)?;

    info!(template_id = %template_id, "Deleted template");
    Ok(ApiResponse::ok(TemplateDeletedData { deleted: true }))
}

// =============================================================================
// Maintainer
// =============================================================================

/// Inbox submission parameters
#[derive(Debug, Deserialize)]
pub struct InboxParams {
    pub source: String,
    #[serde(rename = "type")]
    pub item_type: String,
    pub message: String,
}

/// GET /maintainer/status - Get maintainer session status
#[instrument(skip(state))]
pub async fn maintainer_status_handler(
    State(state): State<AppState>,
) -> Result<Json<ApiResponse<MaintainerStatusData>>, (StatusCode, Json<ApiResponse<()>>)> {
    let session_id = super::super::maintainer::MAINTAINER_SESSION_ID;
    let inbox_path = super::super::maintainer::inbox_dir(&state.config.data_dir);

    // Get session status from shared state
    let status = {
        let states = state.session_states.read().await;
        states.get(session_id).map(|s| s.status.to_string())
    }.unwrap_or_else(|| "not_running".to_string());

    // Get ralph state from AppState
    let (ralph_active, ralph_paused) = state.ralph_state();

    // Count inbox items
    let inbox_items = super::super::maintainer::list_inbox_items(&inbox_path).await;
    let inbox_count = inbox_items.len();

    // Get current task (from processing dir)
    let processing_dir = inbox_path.join("processing");
    let current_task = super::super::maintainer::list_inbox_items(&processing_dir).await.into_iter().next();

    Ok(ApiResponse::ok(MaintainerStatusData {
        session_id: session_id.to_string(),
        status,
        ralph_active,
        ralph_paused,
        inbox_count,
        inbox_items,
        current_task,
    }))
}

/// POST /maintainer/inbox - Submit an item to the maintainer inbox
#[instrument(skip(state))]
pub async fn maintainer_inbox_handler(
    State(state): State<AppState>,
    Json(params): Json<InboxParams>,
) -> Result<Json<ApiResponse<InboxItemData>>, (StatusCode, Json<ApiResponse<()>>)> {
    // Validate input sizes
    if params.source.len() > 256 {
        return Err(err_msg(StatusCode::BAD_REQUEST, "Source too long (max 256 chars)", "INVALID_INPUT"));
    }
    if params.message.len() > 100_000 {
        return Err(err_msg(StatusCode::BAD_REQUEST, "Message too long (max 100K chars)", "INVALID_INPUT"));
    }
    if params.item_type.len() > 64 {
        return Err(err_msg(StatusCode::BAD_REQUEST, "Type too long (max 64 chars)", "INVALID_INPUT"));
    }

    let inbox_path = super::super::maintainer::inbox_dir(&state.config.data_dir);

    let filepath = super::super::maintainer::write_inbox_item(
        &inbox_path,
        &params.source,
        &params.item_type,
        &params.message,
    ).await.map_err(|e| {
        err(crate::model::ModelError::TmuxError(format!("Failed to write inbox item: {}", e)))
    })?;

    let filename = filepath.file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("unknown")
        .to_string();

    info!(filename = %filename, "Inbox item submitted via API");

    Ok(ApiResponse::ok(InboxItemData { filename }))
}

/// POST /maintainer/pause - Pause the ralph loop
#[instrument(skip(state))]
pub async fn maintainer_pause_handler(
    State(state): State<AppState>,
) -> Result<Json<ApiResponse<()>>, (StatusCode, Json<ApiResponse<()>>)> {
    state.pause_ralph();
    Ok(ApiResponse::ok(()))
}

/// POST /maintainer/resume - Resume the ralph loop
#[instrument(skip(state))]
pub async fn maintainer_resume_handler(
    State(state): State<AppState>,
) -> Result<Json<ApiResponse<()>>, (StatusCode, Json<ApiResponse<()>>)> {
    state.resume_ralph();
    Ok(ApiResponse::ok(()))
}

// =============================================================================
// Deploy
// =============================================================================

/// GET /deploy/status - Get deploy pipeline status
#[instrument(skip(state))]
pub async fn deploy_status_handler(
    State(state): State<AppState>,
) -> Json<ApiResponse<DeployStatusData>> {
    let status = state.deploy.status();
    ApiResponse::ok(DeployStatusData {
        pending: status.pending,
        last_deploy: status.last_deploy,
        cooldown_remaining_secs: status.cooldown_remaining_secs,
    })
}

/// POST /deploy/trigger - Trigger a deploy (build verification + countdown + swap)
#[instrument(skip(state))]
pub async fn deploy_trigger_handler(
    State(state): State<AppState>,
) -> Result<Json<ApiResponse<DeployTriggerData>>, (StatusCode, Json<ApiResponse<()>>)> {
    use super::super::deploy::DeployResult;

    let result = state.deploy.execute(&state.push).await;

    match result {
        DeployResult::ReExec { .. } => {
            info!("Deploy successful, scheduling re-exec");
            // Spawn re-exec after delay to ensure HTTP response is flushed.
            // exec() replaces the process; the new binary re-binds the port.
            // Old sockets are closed by the OS when the process image is replaced.
            tokio::spawn(async {
                tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                super::super::deploy::re_exec();
            });
            Ok(ApiResponse::ok(DeployTriggerData {
                result: "restarting".to_string(),
                message: "Binary swapped, restarting...".to_string(),
            }))
        }
        DeployResult::Aborted => {
            Ok(ApiResponse::ok(DeployTriggerData {
                result: "aborted".to_string(),
                message: "Deploy was aborted during countdown".to_string(),
            }))
        }
        DeployResult::Failed(msg) => {
            Err(err_msg(StatusCode::BAD_REQUEST, &msg, "DEPLOY_FAILED"))
        }
        DeployResult::RateLimited { next_allowed } => {
            Err(err_msg(
                StatusCode::TOO_MANY_REQUESTS,
                &format!("Deploy rate limited. Next allowed: {}", next_allowed.to_rfc3339()),
                "DEPLOY_RATE_LIMITED",
            ))
        }
    }
}

/// POST /deploy/abort - Abort a pending deploy
#[instrument(skip(state))]
pub async fn deploy_abort_handler(
    State(state): State<AppState>,
) -> Json<ApiResponse<DeployAbortData>> {
    let was_pending = state.deploy.is_pending();
    state.deploy.abort();
    ApiResponse::ok(DeployAbortData {
        aborted: was_pending,
    })
}

/// POST /deploy/rollback - Rollback to previous binary
#[instrument(skip(state))]
pub async fn deploy_rollback_handler(
    State(state): State<AppState>,
) -> Result<Json<ApiResponse<DeployTriggerData>>, (StatusCode, Json<ApiResponse<()>>)> {
    match state.deploy.rollback() {
        Ok(()) => {
            // Re-exec with rolled-back binary after response flush
            tokio::spawn(async {
                tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                super::super::deploy::re_exec();
            });
            Ok(ApiResponse::ok(DeployTriggerData {
                result: "rolled_back".to_string(),
                message: "Rolled back to previous binary, restarting...".to_string(),
            }))
        }
        Err(msg) => Err(err_msg(StatusCode::BAD_REQUEST, &msg, "ROLLBACK_FAILED")),
    }
}

// =============================================================================
// Image Upload
// =============================================================================

/// Maximum upload size: 10 MB
const MAX_UPLOAD_SIZE: usize = 10 * 1024 * 1024;

/// Allowed image MIME types and their file extensions
fn image_extension(content_type: &str) -> Option<&'static str> {
    match content_type {
        "image/png" => Some("png"),
        "image/jpeg" => Some("jpg"),
        "image/webp" => Some("webp"),
        "image/gif" => Some("gif"),
        _ => None,
    }
}

/// POST /sessions/:id/upload - Upload an image for a session
///
/// The image is saved to `{data_dir}/uploads/` and the absolute file path
/// is returned. The caller can then send this path as input to the session
/// so Claude Code can read the image.
#[instrument(skip(state, multipart))]
pub async fn upload_image_handler(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
    mut multipart: Multipart,
) -> ApiResultCreated<UploadedImageData> {
    // Validate session exists
    if !state.tmux.has_session(&session_id).await.map_err(err)? {
        return Err(err(crate::model::ModelError::SessionNotFound(session_id)));
    }

    // Extract the image field from multipart
    let field = multipart
        .next_field()
        .await
        .map_err(|e| err_msg(StatusCode::BAD_REQUEST, &format!("Invalid multipart: {}", e), "INVALID_INPUT"))?
        .ok_or_else(|| err_msg(StatusCode::BAD_REQUEST, "No file uploaded", "INVALID_INPUT"))?;

    // Validate content type
    let content_type = field
        .content_type()
        .unwrap_or("")
        .to_string();
    let ext = image_extension(&content_type)
        .ok_or_else(|| err_msg(
            StatusCode::BAD_REQUEST,
            &format!("Unsupported image type: {}. Allowed: png, jpeg, webp, gif", content_type),
            "INVALID_INPUT",
        ))?;

    // Read bytes with size limit
    let data = field
        .bytes()
        .await
        .map_err(|e| err_msg(StatusCode::BAD_REQUEST, &format!("Failed to read upload: {}", e), "INVALID_INPUT"))?;

    if data.len() > MAX_UPLOAD_SIZE {
        return Err(err_msg(
            StatusCode::PAYLOAD_TOO_LARGE,
            &format!("Image too large ({} bytes, max {} bytes)", data.len(), MAX_UPLOAD_SIZE),
            "PAYLOAD_TOO_LARGE",
        ));
    }

    // Validate magic bytes
    let valid_magic = match ext {
        "png" => data.starts_with(&[0x89, b'P', b'N', b'G']),
        "jpg" => data.starts_with(&[0xFF, 0xD8, 0xFF]),
        "webp" => data.len() >= 12 && &data[0..4] == b"RIFF" && &data[8..12] == b"WEBP",
        "gif" => data.starts_with(b"GIF8"),
        _ => false,
    };
    if !valid_magic {
        return Err(err_msg(
            StatusCode::BAD_REQUEST,
            "File content does not match declared image type",
            "INVALID_INPUT",
        ));
    }

    // Generate unique filename: {timestamp}_{uuid_short}.{ext}
    let now = chrono::Utc::now();
    let timestamp = now.format("%Y%m%d_%H%M%S");
    let uuid_short = &uuid::Uuid::new_v4().to_string()[..8];
    let filename = format!("{}_{}.{}", timestamp, uuid_short, ext);

    // Ensure uploads directory exists
    let uploads_dir = std::path::PathBuf::from(&state.config.data_dir).join("uploads");
    tokio::fs::create_dir_all(&uploads_dir)
        .await
        .map_err(|e| err_msg(StatusCode::INTERNAL_SERVER_ERROR, &format!("Failed to create uploads dir: {}", e), "IO_ERROR"))?;

    // Write file
    let file_path = uploads_dir.join(&filename);
    tokio::fs::write(&file_path, &data)
        .await
        .map_err(|e| err_msg(StatusCode::INTERNAL_SERVER_ERROR, &format!("Failed to write file: {}", e), "IO_ERROR"))?;

    // Get absolute path
    let abs_path = file_path
        .canonicalize()
        .map_err(|e| err_msg(StatusCode::INTERNAL_SERVER_ERROR, &format!("Failed to resolve path: {}", e), "IO_ERROR"))?
        .to_string_lossy()
        .to_string();

    info!(session = %session_id, path = %abs_path, size = data.len(), "Image uploaded");

    Ok((
        StatusCode::CREATED,
        ApiResponse::ok(UploadedImageData { path: abs_path }),
    ))
}

/// Maximum file upload size for session uploads: 100 MB total
const MAX_SESSION_UPLOAD_SIZE: usize = 100 * 1024 * 1024;

/// POST /sessions/:id/upload-files - Upload files to a session's uploads/ folder
///
/// Accepts multiple files via multipart. Files are saved to `{session_folder}/uploads/`
/// preserving any relative path structure. Returns the list of absolute file paths.
#[instrument(skip(state, multipart))]
pub async fn upload_files_handler(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
    mut multipart: Multipart,
) -> ApiResultCreated<UploadedFilesData> {
    // Get session to find its folder
    let session = crate::model::get_session(state.tmux.as_ref(), &session_id)
        .await
        .map_err(err)?;

    let uploads_dir = std::path::PathBuf::from(&session.folder).join("uploads");
    tokio::fs::create_dir_all(&uploads_dir)
        .await
        .map_err(|e| err_msg(StatusCode::INTERNAL_SERVER_ERROR, &format!("Failed to create uploads dir: {}", e), "IO_ERROR"))?;

    let mut paths: Vec<String> = Vec::new();
    let mut total_size: usize = 0;

    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|e| err_msg(StatusCode::BAD_REQUEST, &format!("Invalid multipart: {}", e), "INVALID_INPUT"))?
    {
        let file_name = field.file_name().unwrap_or("").to_string();
        if file_name.is_empty() {
            continue;
        }

        let data = field.bytes().await.map_err(|e| {
            err_msg(StatusCode::BAD_REQUEST, &format!("Failed to read file: {}", e), "INVALID_INPUT")
        })?;

        total_size += data.len();
        if total_size > MAX_SESSION_UPLOAD_SIZE {
            return Err(err_msg(
                StatusCode::PAYLOAD_TOO_LARGE,
                &format!("Total upload too large (max {} MB)", MAX_SESSION_UPLOAD_SIZE / 1024 / 1024),
                "PAYLOAD_TOO_LARGE",
            ));
        }

        // Sanitize the filename: use only the last component to prevent path traversal
        let safe_name = std::path::Path::new(&file_name)
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("file");

        // Skip hidden files
        if safe_name.starts_with('.') {
            continue;
        }

        let out_path = uploads_dir.join(safe_name);

        // Ensure output is within uploads dir
        if !out_path.starts_with(&uploads_dir) {
            continue;
        }

        // If file already exists, add a numeric suffix
        let final_path = if out_path.exists() {
            let stem = std::path::Path::new(safe_name)
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("file");
            let ext = std::path::Path::new(safe_name)
                .extension()
                .and_then(|e| e.to_str())
                .map(|e| format!(".{}", e))
                .unwrap_or_default();
            let mut suffix = 1u32;
            loop {
                let candidate = uploads_dir.join(format!("{}-{}{}", stem, suffix, ext));
                if !candidate.exists() {
                    break candidate;
                }
                suffix += 1;
            }
        } else {
            out_path
        };

        tokio::fs::write(&final_path, &data)
            .await
            .map_err(|e| err_msg(StatusCode::INTERNAL_SERVER_ERROR, &format!("Failed to write file: {}", e), "IO_ERROR"))?;

        let abs_path = final_path
            .canonicalize()
            .map_err(|e| err_msg(StatusCode::INTERNAL_SERVER_ERROR, &format!("Failed to resolve path: {}", e), "IO_ERROR"))?
            .to_string_lossy()
            .to_string();

        paths.push(abs_path);
    }

    if paths.is_empty() {
        return Err(err_msg(StatusCode::BAD_REQUEST, "No files uploaded", "INVALID_INPUT"));
    }

    info!(session = %session_id, count = paths.len(), total_size, "Files uploaded to session");

    Ok((
        StatusCode::CREATED,
        ApiResponse::ok(UploadedFilesData { paths }),
    ))
}

/// GET /sessions/:id/files - List files in the session's project folder
///
/// Returns a recursive tree of files and directories (max depth 4, skips hidden dirs).
#[instrument(skip(state))]
pub async fn session_files_handler(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
) -> ApiResult<SessionFilesData> {
    let session = crate::model::get_session(state.tmux.as_ref(), &session_id)
        .await
        .map_err(err)?;

    let root = std::path::PathBuf::from(&session.folder);
    if !root.is_dir() {
        return Err(err_msg(
            StatusCode::NOT_FOUND,
            "Session folder not found",
            "FOLDER_NOT_FOUND",
        ));
    }

    let files = list_dir_recursive(&root, &root, 0, 4).await;

    debug!(session = %session_id, count = files.len(), "Listed session files");
    Ok(ApiResponse::ok(SessionFilesData {
        root: session.folder,
        files,
    }))
}

/// Recursively list directory contents up to max_depth
async fn list_dir_recursive(
    base: &std::path::Path,
    dir: &std::path::Path,
    depth: u32,
    max_depth: u32,
) -> Vec<FileEntry> {
    let mut entries = Vec::new();

    let mut read_dir = match tokio::fs::read_dir(dir).await {
        Ok(rd) => rd,
        Err(_) => return entries,
    };

    let mut raw_entries = Vec::new();
    while let Ok(Some(entry)) = read_dir.next_entry().await {
        raw_entries.push(entry);
    }

    // Sort by name
    raw_entries.sort_by(|a, b| a.file_name().cmp(&b.file_name()));

    for entry in raw_entries {
        let name = entry.file_name().to_string_lossy().to_string();

        // Skip hidden files/dirs
        if name.starts_with('.') {
            continue;
        }

        let path = entry.path();
        let relative = path
            .strip_prefix(base)
            .unwrap_or(&path)
            .to_string_lossy()
            .to_string();

        let metadata = match entry.metadata().await {
            Ok(m) => m,
            Err(_) => continue,
        };

        if metadata.is_dir() {
            let children = if depth < max_depth {
                Some(Box::pin(list_dir_recursive(base, &path, depth + 1, max_depth)).await)
            } else {
                None
            };

            entries.push(FileEntry {
                name,
                path: relative,
                is_dir: true,
                size: None,
                children,
            });
        } else {
            entries.push(FileEntry {
                name,
                path: relative,
                is_dir: false,
                size: Some(metadata.len()),
                children: None,
            });
        }
    }

    entries
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
