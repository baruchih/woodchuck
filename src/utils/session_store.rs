//! Session and project state persistence
//!
//! Stores session and project states to disk so they survive server restarts.
//! Uses atomic writes (temp file + rename) for safety.
//!
//! Persisted fields per session:
//! - name: User-provided display name
//! - status: Current session status (resting, working, needs_input, error)
//! - working_since: When the session entered "working" status
//! - last_working_at: Last time "working" status was detected (for grace period)
//! - project_id: Optional reference to parent project
//!
//! Persisted fields per project:
//! - name: User-provided display name
//! - created_at: When the project was created

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use tokio::fs;
use tokio::sync::RwLock;
use tracing::{debug, info, warn};

use crate::config::Config;
use crate::model::error::ModelError;
use crate::model::types::SessionStatus;

// =============================================================================
// Persisted State
// =============================================================================

/// Persisted session state (stored to disk)
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct PersistedSessionState {
    /// User-provided display name
    pub name: String,

    /// Current session status
    #[serde(default)]
    pub status: SessionStatus,

    /// When the session entered "working" status
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub working_since: Option<DateTime<Utc>>,

    /// Last time "working" status was detected (for grace period)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_working_at: Option<DateTime<Utc>>,

    /// Optional reference to parent project
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,

    /// Last input sent to the session (for historical context)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_input: Option<String>,

    /// User-assigned tags for filtering/grouping
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tags: Vec<String>,

    /// Last status for which a push notification was sent (deduplication)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_notified_status: Option<SessionStatus>,

    /// Project folder path (needed for session recovery after crash/power outage)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub folder: Option<String>,
}

/// Persisted project state (stored to disk)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PersistedProject {
    /// User-provided display name
    pub name: String,

    /// When the project was created
    pub created_at: DateTime<Utc>,
}

/// Persisted template state (stored to disk)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PersistedTemplate {
    /// Template name
    pub name: String,

    /// Project folder path
    pub folder: String,

    /// Prompt text
    pub prompt: String,

    /// When the template was created
    pub created_at: DateTime<Utc>,
}

impl PersistedSessionState {
    /// Create a new persisted state with just a name
    pub fn with_name(name: String) -> Self {
        Self {
            name,
            ..Self::default()
        }
    }
}

// =============================================================================
// Trait
// =============================================================================

/// Trait for session state persistence operations
#[async_trait]
pub trait SessionStore: Send + Sync {
    /// Load all session states from storage
    async fn load(&self) -> Result<HashMap<String, PersistedSessionState>, ModelError>;

    /// Save a session state
    async fn save(&self, session_id: &str, state: &PersistedSessionState) -> Result<(), ModelError>;

    /// Remove a session
    async fn remove(&self, session_id: &str) -> Result<(), ModelError>;

    /// Prune orphaned sessions (not in the provided active session list)
    async fn prune(&self, active_session_ids: &[String]) -> Result<usize, ModelError>;

    /// Load all projects from storage
    async fn load_projects(&self) -> Result<HashMap<String, PersistedProject>, ModelError>;

    /// Save a project
    async fn save_project(&self, project_id: &str, project: &PersistedProject) -> Result<(), ModelError>;

    /// Remove a project (sessions with this project_id will become ungrouped)
    async fn remove_project(&self, project_id: &str) -> Result<(), ModelError>;

    /// Load all templates from storage
    async fn load_templates(&self) -> Result<Vec<crate::model::types::Template>, ModelError>;

    /// Save a template
    async fn save_template(&self, template_id: &str, template: &PersistedTemplate) -> Result<(), ModelError>;

    /// Remove a template
    async fn remove_template(&self, template_id: &str) -> Result<(), ModelError>;
}

// =============================================================================
// File Format
// =============================================================================

/// File format version 1 (legacy: just names)
#[derive(Debug, Clone, Serialize, Deserialize)]
struct SessionStoreV1 {
    version: u8,
    sessions: HashMap<String, String>,
}

/// File format version 2 (full state, no projects)
#[derive(Debug, Clone, Serialize, Deserialize)]
struct SessionStoreV2 {
    version: u8,
    sessions: HashMap<String, PersistedSessionState>,
}

/// File format version 3 (with projects and templates)
#[derive(Debug, Clone, Serialize, Deserialize)]
struct SessionStoreV3 {
    version: u8,
    sessions: HashMap<String, PersistedSessionState>,
    #[serde(default)]
    projects: HashMap<String, PersistedProject>,
    #[serde(default)]
    templates: HashMap<String, PersistedTemplate>,
}

impl Default for SessionStoreV3 {
    fn default() -> Self {
        Self {
            version: 3,
            sessions: HashMap::new(),
            projects: HashMap::new(),
            templates: HashMap::new(),
        }
    }
}

/// Helper for detecting version during load
#[derive(Debug, Clone, Deserialize)]
struct VersionOnly {
    version: u8,
}

// =============================================================================
// JSON File Implementation
// =============================================================================

/// JSON file-based session store
#[derive(Debug)]
pub struct JsonSessionStore {
    file_path: PathBuf,
    data: Arc<RwLock<SessionStoreV3>>,
}

impl JsonSessionStore {
    /// Create a new JSON session store
    ///
    /// Creates the data directory if it doesn't exist.
    /// Loads existing data from file if present, migrating from v1 if needed.
    pub async fn new(config: &Config) -> Result<Self, ModelError> {
        let data_dir = PathBuf::from(&config.data_dir);
        let file_path = data_dir.join("sessions.json");

        // Ensure data directory exists
        if !data_dir.exists() {
            fs::create_dir_all(&data_dir).await.map_err(|e| {
                ModelError::SessionStoreError(format!(
                    "Failed to create data directory {:?}: {}",
                    data_dir, e
                ))
            })?;
            info!(path = %data_dir.display(), "Created data directory");
        }

        // Load existing data or use defaults
        let (data, needs_write) = if file_path.exists() {
            match fs::read_to_string(&file_path).await {
                Ok(content) => Self::parse_and_migrate(&content, &file_path),
                Err(e) => {
                    warn!(
                        path = %file_path.display(),
                        error = %e,
                        "Failed to read session store, starting fresh"
                    );
                    (SessionStoreV3::default(), false)
                }
            }
        } else {
            debug!(path = %file_path.display(), "Session store file not found, starting fresh");
            (SessionStoreV3::default(), false)
        };

        let store = Self {
            file_path,
            data: Arc::new(RwLock::new(data)),
        };

        // Write migrated data back to disk
        if needs_write {
            store.write_to_file().await?;
        }

        Ok(store)
    }

    /// Parse file content and migrate from older versions if needed
    fn parse_and_migrate(content: &str, file_path: &std::path::Path) -> (SessionStoreV3, bool) {
        // First, detect the version
        match serde_json::from_str::<VersionOnly>(content) {
            Ok(v) if v.version == 3 => {
                // Already v3, parse directly
                match serde_json::from_str::<SessionStoreV3>(content) {
                    Ok(store) => {
                        info!(
                            path = %file_path.display(),
                            sessions = store.sessions.len(),
                            projects = store.projects.len(),
                            "Loaded session states from file (v3)"
                        );
                        (store, false)
                    }
                    Err(e) => {
                        warn!(
                            path = %file_path.display(),
                            error = %e,
                            "Failed to parse v3 session store, starting fresh"
                        );
                        (SessionStoreV3::default(), false)
                    }
                }
            }
            Ok(v) if v.version == 2 => {
                // Migrate from v2 to v3
                match serde_json::from_str::<SessionStoreV2>(content) {
                    Ok(v2_store) => {
                        info!(
                            path = %file_path.display(),
                            count = v2_store.sessions.len(),
                            "Migrating session store from v2 to v3"
                        );
                        (
                            SessionStoreV3 {
                                version: 3,
                                sessions: v2_store.sessions,
                                projects: HashMap::new(),
                                templates: HashMap::new(),
                            },
                            true, // needs write to save migration
                        )
                    }
                    Err(e) => {
                        warn!(
                            path = %file_path.display(),
                            error = %e,
                            "Failed to parse v2 session store, starting fresh"
                        );
                        (SessionStoreV3::default(), false)
                    }
                }
            }
            Ok(v) if v.version == 1 => {
                // Migrate from v1 to v3
                match serde_json::from_str::<SessionStoreV1>(content) {
                    Ok(v1_store) => {
                        info!(
                            path = %file_path.display(),
                            count = v1_store.sessions.len(),
                            "Migrating session store from v1 to v3"
                        );
                        let v3_sessions: HashMap<String, PersistedSessionState> = v1_store
                            .sessions
                            .into_iter()
                            .map(|(id, name)| (id, PersistedSessionState::with_name(name)))
                            .collect();
                        (
                            SessionStoreV3 {
                                version: 3,
                                sessions: v3_sessions,
                                projects: HashMap::new(),
                                templates: HashMap::new(),
                            },
                            true, // needs write to save migration
                        )
                    }
                    Err(e) => {
                        warn!(
                            path = %file_path.display(),
                            error = %e,
                            "Failed to parse v1 session store, starting fresh"
                        );
                        (SessionStoreV3::default(), false)
                    }
                }
            }
            Ok(v) => {
                warn!(
                    path = %file_path.display(),
                    version = v.version,
                    "Unknown session store version, starting fresh"
                );
                (SessionStoreV3::default(), false)
            }
            Err(e) => {
                warn!(
                    path = %file_path.display(),
                    error = %e,
                    "Failed to detect session store version, starting fresh"
                );
                (SessionStoreV3::default(), false)
            }
        }
    }

    /// Write data to file atomically (temp file + rename)
    async fn write_to_file(&self) -> Result<(), ModelError> {
        let data = self.data.read().await;
        let content = serde_json::to_string_pretty(&*data).map_err(|e| {
            ModelError::SessionStoreError(format!("Failed to serialize session store: {}", e))
        })?;

        // Write to temp file first
        let temp_path = self.file_path.with_extension("json.tmp");
        fs::write(&temp_path, &content).await.map_err(|e| {
            ModelError::SessionStoreError(format!(
                "Failed to write temp file {:?}: {}",
                temp_path, e
            ))
        })?;

        // Atomic rename
        fs::rename(&temp_path, &self.file_path).await.map_err(|e| {
            ModelError::SessionStoreError(format!(
                "Failed to rename {:?} to {:?}: {}",
                temp_path, self.file_path, e
            ))
        })?;

        debug!(path = %self.file_path.display(), "Wrote session store to file");
        Ok(())
    }
}

#[async_trait]
impl SessionStore for JsonSessionStore {
    async fn load(&self) -> Result<HashMap<String, PersistedSessionState>, ModelError> {
        let data = self.data.read().await;
        Ok(data.sessions.clone())
    }

    async fn save(&self, session_id: &str, state: &PersistedSessionState) -> Result<(), ModelError> {
        {
            let mut data = self.data.write().await;
            data.sessions.insert(session_id.to_string(), state.clone());
        }
        self.write_to_file().await
    }

    async fn remove(&self, session_id: &str) -> Result<(), ModelError> {
        {
            let mut data = self.data.write().await;
            data.sessions.remove(session_id);
        }
        self.write_to_file().await
    }

    async fn prune(&self, active_session_ids: &[String]) -> Result<usize, ModelError> {
        let removed_count;
        {
            let mut data = self.data.write().await;
            let before_count = data.sessions.len();
            data.sessions
                .retain(|id, _| active_session_ids.contains(id));
            removed_count = before_count - data.sessions.len();
        }

        if removed_count > 0 {
            self.write_to_file().await?;
            info!(count = removed_count, "Pruned orphaned sessions");
        }

        Ok(removed_count)
    }

    async fn load_projects(&self) -> Result<HashMap<String, PersistedProject>, ModelError> {
        let data = self.data.read().await;
        Ok(data.projects.clone())
    }

    async fn save_project(&self, project_id: &str, project: &PersistedProject) -> Result<(), ModelError> {
        {
            let mut data = self.data.write().await;
            data.projects.insert(project_id.to_string(), project.clone());
        }
        self.write_to_file().await
    }

    async fn remove_project(&self, project_id: &str) -> Result<(), ModelError> {
        {
            let mut data = self.data.write().await;
            data.projects.remove(project_id);
            // Clear project_id from any sessions that referenced this project
            for session in data.sessions.values_mut() {
                if session.project_id.as_deref() == Some(project_id) {
                    session.project_id = None;
                }
            }
        }
        self.write_to_file().await
    }

    async fn load_templates(&self) -> Result<Vec<crate::model::types::Template>, ModelError> {
        let data = self.data.read().await;
        let mut templates: Vec<crate::model::types::Template> = data
            .templates
            .iter()
            .map(|(id, t)| crate::model::types::Template {
                id: id.clone(),
                name: t.name.clone(),
                folder: t.folder.clone(),
                prompt: t.prompt.clone(),
                created_at: t.created_at,
            })
            .collect();
        // Sort by created_at descending (newest first)
        templates.sort_by(|a, b| b.created_at.cmp(&a.created_at));
        Ok(templates)
    }

    async fn save_template(&self, template_id: &str, template: &PersistedTemplate) -> Result<(), ModelError> {
        {
            let mut data = self.data.write().await;
            data.templates.insert(template_id.to_string(), template.clone());
        }
        self.write_to_file().await
    }

    async fn remove_template(&self, template_id: &str) -> Result<(), ModelError> {
        {
            let mut data = self.data.write().await;
            data.templates.remove(template_id);
        }
        self.write_to_file().await
    }
}

// =============================================================================
// Noop Implementation
// =============================================================================

/// No-op session store (for testing)
#[derive(Debug, Clone, Default)]
pub struct NoopSessionStore;

#[async_trait]
impl SessionStore for NoopSessionStore {
    async fn load(&self) -> Result<HashMap<String, PersistedSessionState>, ModelError> {
        Ok(HashMap::new())
    }

    async fn save(&self, _session_id: &str, _state: &PersistedSessionState) -> Result<(), ModelError> {
        Ok(())
    }

    async fn remove(&self, _session_id: &str) -> Result<(), ModelError> {
        Ok(())
    }

    async fn prune(&self, _active_session_ids: &[String]) -> Result<usize, ModelError> {
        Ok(0)
    }

    async fn load_projects(&self) -> Result<HashMap<String, PersistedProject>, ModelError> {
        Ok(HashMap::new())
    }

    async fn save_project(&self, _project_id: &str, _project: &PersistedProject) -> Result<(), ModelError> {
        Ok(())
    }

    async fn remove_project(&self, _project_id: &str) -> Result<(), ModelError> {
        Ok(())
    }

    async fn load_templates(&self) -> Result<Vec<crate::model::types::Template>, ModelError> {
        Ok(Vec::new())
    }

    async fn save_template(&self, _template_id: &str, _template: &PersistedTemplate) -> Result<(), ModelError> {
        Ok(())
    }

    async fn remove_template(&self, _template_id: &str) -> Result<(), ModelError> {
        Ok(())
    }
}

// =============================================================================
// Unit Tests
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn test_config(data_dir: &str) -> Config {
        Config {
            http_port: 3000,
            ws_port: 3001,
            log_level: "info".to_string(),
            projects_dir: "/tmp/projects".to_string(),
            data_dir: data_dir.to_string(),
            ntfy_server: None,
            ntfy_topic: None,
            vapid_private_key: None,
            vapid_public_key: None,
            shutdown_timeout_secs: 5,
            static_dir: "app/dist".to_string(),
            cors_origins: "*".to_string(),
            bind_addr: "0.0.0.0".to_string(),
            tls_cert: None,
            tls_key: None,
            external_url: "http://localhost:3000".to_string(),
        }
    }

    #[tokio::test]
    async fn test_noop_store() {
        let store = NoopSessionStore;

        // Load returns empty
        let sessions = store.load().await.unwrap();
        assert!(sessions.is_empty());

        // Save and remove succeed silently
        let state = PersistedSessionState::with_name("Test Name".to_string());
        store.save("test-id", &state).await.unwrap();
        store.remove("test-id").await.unwrap();

        // Prune returns 0
        let pruned = store.prune(&["test-id".to_string()]).await.unwrap();
        assert_eq!(pruned, 0);
    }

    #[tokio::test]
    async fn test_json_store_creates_directory() {
        let temp_dir = TempDir::new().unwrap();
        let data_dir = temp_dir.path().join("woodchuck");
        let config = test_config(data_dir.to_str().unwrap());

        // Directory doesn't exist yet
        assert!(!data_dir.exists());

        // Creating store should create directory
        let _store = JsonSessionStore::new(&config).await.unwrap();
        assert!(data_dir.exists());
    }

    #[tokio::test]
    async fn test_json_store_save_and_load() {
        let temp_dir = TempDir::new().unwrap();
        let config = test_config(temp_dir.path().to_str().unwrap());

        let store = JsonSessionStore::new(&config).await.unwrap();

        // Save some sessions with full state
        let state1 = PersistedSessionState {
            name: "First Session".to_string(),
            status: SessionStatus::Working,
            working_since: Some(Utc::now()),
            last_working_at: Some(Utc::now()),
            project_id: None,
            last_input: None,
            tags: Vec::new(),
            last_notified_status: None,
            folder: None,
        };
        let state2 = PersistedSessionState::with_name("Second Session".to_string());

        store.save("session-1", &state1).await.unwrap();
        store.save("session-2", &state2).await.unwrap();

        // Load and verify
        let sessions = store.load().await.unwrap();
        assert_eq!(sessions.len(), 2);

        let loaded1 = sessions.get("session-1").unwrap();
        assert_eq!(loaded1.name, "First Session");
        assert_eq!(loaded1.status, SessionStatus::Working);
        assert!(loaded1.working_since.is_some());

        let loaded2 = sessions.get("session-2").unwrap();
        assert_eq!(loaded2.name, "Second Session");
        assert_eq!(loaded2.status, SessionStatus::Resting);
        assert!(loaded2.working_since.is_none());
    }

    #[tokio::test]
    async fn test_json_store_remove() {
        let temp_dir = TempDir::new().unwrap();
        let config = test_config(temp_dir.path().to_str().unwrap());

        let store = JsonSessionStore::new(&config).await.unwrap();

        let state1 = PersistedSessionState::with_name("First Session".to_string());
        let state2 = PersistedSessionState::with_name("Second Session".to_string());

        store.save("session-1", &state1).await.unwrap();
        store.save("session-2", &state2).await.unwrap();

        // Remove one
        store.remove("session-1").await.unwrap();

        // Verify
        let sessions = store.load().await.unwrap();
        assert_eq!(sessions.len(), 1);
        assert!(!sessions.contains_key("session-1"));
        assert!(sessions.contains_key("session-2"));
    }

    #[tokio::test]
    async fn test_json_store_prune() {
        let temp_dir = TempDir::new().unwrap();
        let config = test_config(temp_dir.path().to_str().unwrap());

        let store = JsonSessionStore::new(&config).await.unwrap();

        // Save some sessions
        store.save("active-1", &PersistedSessionState::with_name("Active One".to_string())).await.unwrap();
        store.save("active-2", &PersistedSessionState::with_name("Active Two".to_string())).await.unwrap();
        store.save("orphan-1", &PersistedSessionState::with_name("Orphan One".to_string())).await.unwrap();
        store.save("orphan-2", &PersistedSessionState::with_name("Orphan Two".to_string())).await.unwrap();

        // Prune with only active sessions
        let active = vec!["active-1".to_string(), "active-2".to_string()];
        let pruned = store.prune(&active).await.unwrap();
        assert_eq!(pruned, 2);

        // Verify only active remain
        let sessions = store.load().await.unwrap();
        assert_eq!(sessions.len(), 2);
        assert!(sessions.contains_key("active-1"));
        assert!(sessions.contains_key("active-2"));
        assert!(!sessions.contains_key("orphan-1"));
        assert!(!sessions.contains_key("orphan-2"));
    }

    #[tokio::test]
    async fn test_json_store_persistence() {
        let temp_dir = TempDir::new().unwrap();
        let config = test_config(temp_dir.path().to_str().unwrap());

        let working_since = Utc::now();

        // Create store and save data with timing info
        {
            let store = JsonSessionStore::new(&config).await.unwrap();
            let state = PersistedSessionState {
                name: "Persistent Session".to_string(),
                status: SessionStatus::Working,
                working_since: Some(working_since),
                last_working_at: Some(working_since),
                project_id: None,
                last_input: None,
                tags: Vec::new(),
                last_notified_status: None,
                folder: None,
            };
            store.save("persistent-1", &state).await.unwrap();
        }

        // Create new store instance and verify data persisted
        {
            let store = JsonSessionStore::new(&config).await.unwrap();
            let sessions = store.load().await.unwrap();
            assert_eq!(sessions.len(), 1);

            let loaded = sessions.get("persistent-1").unwrap();
            assert_eq!(loaded.name, "Persistent Session");
            assert_eq!(loaded.status, SessionStatus::Working);
            assert!(loaded.working_since.is_some());
            // Verify timestamp preserved (within 1 second tolerance due to serialization)
            let diff = (loaded.working_since.unwrap() - working_since).num_seconds().abs();
            assert!(diff < 1, "working_since not preserved: diff={}s", diff);
        }
    }

    #[tokio::test]
    async fn test_json_store_atomic_write() {
        let temp_dir = TempDir::new().unwrap();
        let config = test_config(temp_dir.path().to_str().unwrap());

        let store = JsonSessionStore::new(&config).await.unwrap();
        let state = PersistedSessionState::with_name("Test Session".to_string());
        store.save("test-id", &state).await.unwrap();

        // Verify file exists and temp file was cleaned up
        let file_path = temp_dir.path().join("sessions.json");
        let temp_path = temp_dir.path().join("sessions.json.tmp");
        assert!(file_path.exists());
        assert!(!temp_path.exists());

        // Verify file content is valid JSON v3
        let content = std::fs::read_to_string(&file_path).unwrap();
        let parsed: SessionStoreV3 = serde_json::from_str(&content).unwrap();
        assert_eq!(parsed.version, 3);
        assert_eq!(parsed.sessions.get("test-id").unwrap().name, "Test Session");
    }

    #[tokio::test]
    async fn test_v1_to_v3_migration() {
        let temp_dir = TempDir::new().unwrap();
        let config = test_config(temp_dir.path().to_str().unwrap());
        let file_path = temp_dir.path().join("sessions.json");

        // Write a v1 format file manually
        let v1_content = r#"{
            "version": 1,
            "sessions": {
                "session-1": "First Session",
                "session-2": "Second Session"
            }
        }"#;
        std::fs::write(&file_path, v1_content).unwrap();

        // Load with JsonSessionStore - should auto-migrate
        let store = JsonSessionStore::new(&config).await.unwrap();
        let sessions = store.load().await.unwrap();

        // Verify migration worked
        assert_eq!(sessions.len(), 2);

        let s1 = sessions.get("session-1").unwrap();
        assert_eq!(s1.name, "First Session");
        assert_eq!(s1.status, SessionStatus::Resting); // default
        assert!(s1.working_since.is_none()); // default
        assert!(s1.project_id.is_none()); // default

        let s2 = sessions.get("session-2").unwrap();
        assert_eq!(s2.name, "Second Session");

        // Verify file was rewritten as v3
        let content = std::fs::read_to_string(&file_path).unwrap();
        let parsed: SessionStoreV3 = serde_json::from_str(&content).unwrap();
        assert_eq!(parsed.version, 3);
        assert!(parsed.projects.is_empty());
    }

    #[tokio::test]
    async fn test_v2_to_v3_migration() {
        let temp_dir = TempDir::new().unwrap();
        let config = test_config(temp_dir.path().to_str().unwrap());
        let file_path = temp_dir.path().join("sessions.json");

        // Write a v2 format file manually
        let v2_content = r#"{
            "version": 2,
            "sessions": {
                "session-1": {
                    "name": "First Session",
                    "status": "working",
                    "working_since": "2026-02-08T12:00:00Z"
                }
            }
        }"#;
        std::fs::write(&file_path, v2_content).unwrap();

        // Load with JsonSessionStore - should auto-migrate
        let store = JsonSessionStore::new(&config).await.unwrap();
        let sessions = store.load().await.unwrap();
        let projects = store.load_projects().await.unwrap();

        // Verify migration worked
        assert_eq!(sessions.len(), 1);
        assert!(projects.is_empty());

        let s1 = sessions.get("session-1").unwrap();
        assert_eq!(s1.name, "First Session");
        assert_eq!(s1.status, SessionStatus::Working);
        assert!(s1.working_since.is_some());
        assert!(s1.project_id.is_none()); // new field defaults to None

        // Verify file was rewritten as v3
        let content = std::fs::read_to_string(&file_path).unwrap();
        let parsed: SessionStoreV3 = serde_json::from_str(&content).unwrap();
        assert_eq!(parsed.version, 3);
    }

    #[tokio::test]
    async fn test_project_crud() {
        let temp_dir = TempDir::new().unwrap();
        let config = test_config(temp_dir.path().to_str().unwrap());

        let store = JsonSessionStore::new(&config).await.unwrap();

        // Initially empty
        let projects = store.load_projects().await.unwrap();
        assert!(projects.is_empty());

        // Save a project
        let project = PersistedProject {
            name: "My Project".to_string(),
            created_at: Utc::now(),
        };
        store.save_project("proj-1", &project).await.unwrap();

        // Load and verify
        let projects = store.load_projects().await.unwrap();
        assert_eq!(projects.len(), 1);
        assert_eq!(projects.get("proj-1").unwrap().name, "My Project");

        // Update project
        let updated = PersistedProject {
            name: "Updated Project".to_string(),
            created_at: project.created_at,
        };
        store.save_project("proj-1", &updated).await.unwrap();

        let projects = store.load_projects().await.unwrap();
        assert_eq!(projects.get("proj-1").unwrap().name, "Updated Project");

        // Remove project
        store.remove_project("proj-1").await.unwrap();
        let projects = store.load_projects().await.unwrap();
        assert!(projects.is_empty());
    }

    #[tokio::test]
    async fn test_session_project_id() {
        let temp_dir = TempDir::new().unwrap();
        let config = test_config(temp_dir.path().to_str().unwrap());

        let store = JsonSessionStore::new(&config).await.unwrap();

        // Create a project
        let project = PersistedProject {
            name: "My Project".to_string(),
            created_at: Utc::now(),
        };
        store.save_project("proj-1", &project).await.unwrap();

        // Create a session with project_id
        let mut state = PersistedSessionState::with_name("My Session".to_string());
        state.project_id = Some("proj-1".to_string());
        store.save("session-1", &state).await.unwrap();

        // Load and verify
        let sessions = store.load().await.unwrap();
        assert_eq!(sessions.get("session-1").unwrap().project_id, Some("proj-1".to_string()));

        // Remove project - should clear session's project_id
        store.remove_project("proj-1").await.unwrap();

        let sessions = store.load().await.unwrap();
        assert!(sessions.get("session-1").unwrap().project_id.is_none());
    }
}
