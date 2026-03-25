//! Deploy Settings Persistence
//!
//! Stores deploy branch configuration and deploy history to disk.
//! Uses atomic writes (temp file + rename) for safety.

use std::collections::VecDeque;
use std::path::PathBuf;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use tokio::fs;
use tracing::{info, warn};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeploySettings {
    pub deploy_branch: String,
}

impl Default for DeploySettings {
    fn default() -> Self {
        Self {
            deploy_branch: "main".to_string(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeployEvent {
    pub timestamp: DateTime<Utc>,
    pub branch: String,
    pub commit: String,
    pub outcome: DeployOutcome,
    pub trigger: DeployTrigger,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DeployOutcome {
    Success,
    Failed(String),
    Reverted(String),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DeployTrigger {
    Auto,
    Manual,
    Local,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct DeployHistory {
    pub entries: VecDeque<DeployEvent>,
}

const MAX_HISTORY_ENTRIES: usize = 20;
const MAX_CONSECUTIVE_FAILURES: u32 = 3;

/// Load deploy settings from disk, returning defaults if not found.
pub async fn load_settings(data_dir: &str) -> DeploySettings {
    let path = PathBuf::from(data_dir).join("deploy-settings.json");
    match fs::read_to_string(&path).await {
        Ok(content) => match serde_json::from_str(&content) {
            Ok(settings) => settings,
            Err(e) => {
                warn!(error = %e, "Failed to parse deploy settings, using defaults");
                DeploySettings::default()
            }
        },
        Err(_) => DeploySettings::default(),
    }
}

/// Save deploy settings to disk using atomic write (temp + rename).
pub async fn save_settings(data_dir: &str, settings: &DeploySettings) {
    let path = PathBuf::from(data_dir).join("deploy-settings.json");
    let temp_path = PathBuf::from(data_dir).join("deploy-settings.json.tmp");

    let content = match serde_json::to_string_pretty(settings) {
        Ok(c) => c,
        Err(e) => {
            warn!(error = %e, "Failed to serialize deploy settings");
            return;
        }
    };

    if let Err(e) = fs::write(&temp_path, &content).await {
        warn!(error = %e, "Failed to write deploy settings temp file");
        return;
    }

    if let Err(e) = fs::rename(&temp_path, &path).await {
        warn!(error = %e, "Failed to rename deploy settings file");
    } else {
        info!("Saved deploy settings");
    }
}

/// Load deploy history from disk, returning empty if not found.
pub async fn load_history(data_dir: &str) -> DeployHistory {
    let path = PathBuf::from(data_dir).join("deploy-history.json");
    match fs::read_to_string(&path).await {
        Ok(content) => match serde_json::from_str(&content) {
            Ok(history) => history,
            Err(e) => {
                warn!(error = %e, "Failed to parse deploy history, using empty");
                DeployHistory::default()
            }
        },
        Err(_) => DeployHistory::default(),
    }
}

/// Append a deploy event to history, truncating to MAX_HISTORY_ENTRIES.
pub async fn append_history(data_dir: &str, event: DeployEvent) {
    let mut history = load_history(data_dir).await;
    history.entries.push_back(event);

    // Truncate oldest entries
    while history.entries.len() > MAX_HISTORY_ENTRIES {
        history.entries.pop_front();
    }

    let path = PathBuf::from(data_dir).join("deploy-history.json");
    let temp_path = PathBuf::from(data_dir).join("deploy-history.json.tmp");

    let content = match serde_json::to_string_pretty(&history) {
        Ok(c) => c,
        Err(e) => {
            warn!(error = %e, "Failed to serialize deploy history");
            return;
        }
    };

    if let Err(e) = fs::write(&temp_path, &content).await {
        warn!(error = %e, "Failed to write deploy history temp file");
        return;
    }

    if let Err(e) = fs::rename(&temp_path, &path).await {
        warn!(error = %e, "Failed to rename deploy history file");
    }
}

/// Count recent consecutive failures on the given branch (from newest).
/// Stops counting at the first non-failure or different branch.
pub fn consecutive_failures_on_branch(history: &DeployHistory, branch: &str) -> u32 {
    let mut count = 0;
    for event in history.entries.iter().rev() {
        if event.branch != branch {
            break;
        }
        match &event.outcome {
            DeployOutcome::Failed(_) => count += 1,
            _ => break,
        }
    }
    count
}

/// Returns true if the branch has hit MAX_CONSECUTIVE_FAILURES and is not "main".
pub fn should_auto_revert(history: &DeployHistory, branch: &str) -> bool {
    if branch == "main" {
        return false;
    }
    consecutive_failures_on_branch(history, branch) >= MAX_CONSECUTIVE_FAILURES
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_event(branch: &str, outcome: DeployOutcome) -> DeployEvent {
        DeployEvent {
            timestamp: Utc::now(),
            branch: branch.to_string(),
            commit: "abc123".to_string(),
            outcome,
            trigger: DeployTrigger::Auto,
        }
    }

    #[test]
    fn test_consecutive_failures_empty() {
        let history = DeployHistory::default();
        assert_eq!(consecutive_failures_on_branch(&history, "feature"), 0);
    }

    #[test]
    fn test_consecutive_failures_mixed() {
        let mut history = DeployHistory::default();
        history
            .entries
            .push_back(make_event("feature", DeployOutcome::Success));
        history
            .entries
            .push_back(make_event("feature", DeployOutcome::Failed("err".into())));
        history
            .entries
            .push_back(make_event("feature", DeployOutcome::Failed("err".into())));
        assert_eq!(consecutive_failures_on_branch(&history, "feature"), 2);
    }

    #[test]
    fn test_consecutive_failures_stops_at_success() {
        let mut history = DeployHistory::default();
        history
            .entries
            .push_back(make_event("feature", DeployOutcome::Failed("err".into())));
        history
            .entries
            .push_back(make_event("feature", DeployOutcome::Success));
        history
            .entries
            .push_back(make_event("feature", DeployOutcome::Failed("err".into())));
        assert_eq!(consecutive_failures_on_branch(&history, "feature"), 1);
    }

    #[test]
    fn test_consecutive_failures_stops_at_different_branch() {
        let mut history = DeployHistory::default();
        history
            .entries
            .push_back(make_event("other", DeployOutcome::Failed("err".into())));
        history
            .entries
            .push_back(make_event("feature", DeployOutcome::Failed("err".into())));
        assert_eq!(consecutive_failures_on_branch(&history, "feature"), 1);
    }

    #[test]
    fn test_should_auto_revert_main_never() {
        let mut history = DeployHistory::default();
        for _ in 0..5 {
            history
                .entries
                .push_back(make_event("main", DeployOutcome::Failed("err".into())));
        }
        assert!(!should_auto_revert(&history, "main"));
    }

    #[test]
    fn test_should_auto_revert_feature_branch() {
        let mut history = DeployHistory::default();
        for _ in 0..3 {
            history
                .entries
                .push_back(make_event("feature", DeployOutcome::Failed("err".into())));
        }
        assert!(should_auto_revert(&history, "feature"));
    }

    #[test]
    fn test_should_auto_revert_not_enough_failures() {
        let mut history = DeployHistory::default();
        for _ in 0..2 {
            history
                .entries
                .push_back(make_event("feature", DeployOutcome::Failed("err".into())));
        }
        assert!(!should_auto_revert(&history, "feature"));
    }

    #[tokio::test]
    async fn test_load_save_settings() {
        let dir = tempfile::tempdir().unwrap();
        let data_dir = dir.path().to_str().unwrap();

        // Default when no file exists
        let settings = load_settings(data_dir).await;
        assert_eq!(settings.deploy_branch, "main");

        // Save and reload
        let settings = DeploySettings {
            deploy_branch: "develop".to_string(),
        };
        save_settings(data_dir, &settings).await;

        let loaded = load_settings(data_dir).await;
        assert_eq!(loaded.deploy_branch, "develop");
    }

    #[tokio::test]
    async fn test_load_save_history() {
        let dir = tempfile::tempdir().unwrap();
        let data_dir = dir.path().to_str().unwrap();

        // Empty when no file exists
        let history = load_history(data_dir).await;
        assert!(history.entries.is_empty());

        // Append and reload
        let event = make_event("main", DeployOutcome::Success);
        append_history(data_dir, event).await;

        let history = load_history(data_dir).await;
        assert_eq!(history.entries.len(), 1);
    }

    #[tokio::test]
    async fn test_history_truncation() {
        let dir = tempfile::tempdir().unwrap();
        let data_dir = dir.path().to_str().unwrap();

        // Append more than MAX_HISTORY_ENTRIES
        for i in 0..25 {
            let event = DeployEvent {
                timestamp: Utc::now(),
                branch: "main".to_string(),
                commit: format!("commit-{}", i),
                outcome: DeployOutcome::Success,
                trigger: DeployTrigger::Auto,
            };
            append_history(data_dir, event).await;
        }

        let history = load_history(data_dir).await;
        assert_eq!(history.entries.len(), MAX_HISTORY_ENTRIES);
        // Oldest should have been trimmed — first remaining should be commit-5
        assert_eq!(history.entries.front().unwrap().commit, "commit-5");
    }
}
