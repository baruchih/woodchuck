//! Git command wrapper
//!
//! Provides a trait for git operations and a real implementation.
//! The trait enables mocking for tests.

use std::time::Duration;

use async_trait::async_trait;
use tokio::process::Command;
use tracing::{debug, instrument};

use crate::model::error::ModelError;

/// Maximum time allowed for a git clone operation
const CLONE_TIMEOUT: Duration = Duration::from_secs(120);

/// Output from a git clone command
#[derive(Debug, Clone)]
pub struct GitCloneOutput {
    /// Whether the clone succeeded
    pub success: bool,

    /// Stderr output (contains error messages on failure)
    pub stderr: String,
}

/// Trait for git operations
///
/// Abstracts git commands for testability.
#[async_trait]
pub trait GitClient: Send + Sync {
    /// Clone a repository to a target directory
    async fn clone_repo(&self, url: &str, target: &str) -> Result<GitCloneOutput, ModelError>;
}

/// Real git implementation
#[derive(Debug, Clone, Default)]
pub struct Git;

impl Git {
    pub fn new() -> Self {
        Self
    }
}

#[async_trait]
impl GitClient for Git {
    #[instrument(skip(self))]
    async fn clone_repo(&self, url: &str, target: &str) -> Result<GitCloneOutput, ModelError> {
        let output = tokio::time::timeout(
            CLONE_TIMEOUT,
            Command::new("git")
                .arg("clone")
                .arg("--")
                .arg(url)
                .arg(target)
                .output(),
        )
        .await
        .map_err(|_| {
            ModelError::GitCloneError(format!(
                "Git clone timed out after {}s",
                CLONE_TIMEOUT.as_secs()
            ))
        })?
        .map_err(|e| ModelError::GitError(format!("Failed to run git: {}", e)))?;

        let stderr = String::from_utf8_lossy(&output.stderr).to_string();

        if output.status.success() {
            debug!(url = %url, target = %target, "Cloned repository");
        }

        Ok(GitCloneOutput {
            success: output.status.success(),
            stderr,
        })
    }
}

/// Maximum time allowed for a git branch detection
const BRANCH_TIMEOUT: Duration = Duration::from_secs(3);

/// Detect the current git branch of a folder.
///
/// Returns `Some(branch_name)` if the folder is a git repository and
/// branch detection succeeds, `None` otherwise.
pub async fn detect_git_branch(folder: &str) -> Option<String> {
    if folder.is_empty() {
        return None;
    }

    let output = tokio::time::timeout(
        BRANCH_TIMEOUT,
        Command::new("git")
            .arg("-C")
            .arg(folder)
            .arg("rev-parse")
            .arg("--abbrev-ref")
            .arg("HEAD")
            .output(),
    )
    .await
    .ok()?  // timeout → None
    .ok()?; // spawn failure → None

    if !output.status.success() {
        return None;
    }

    let branch = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if branch.is_empty() {
        None
    } else {
        debug!(folder = %folder, branch = %branch, "Detected git branch");
        Some(branch)
    }
}

/// Get the current HEAD commit hash of a git repository.
///
/// Returns `Some(hash)` if the folder is a git repo, `None` otherwise.
pub async fn get_head_commit(folder: &str) -> Option<String> {
    if folder.is_empty() {
        return None;
    }

    let output = tokio::time::timeout(
        BRANCH_TIMEOUT,
        Command::new("git")
            .arg("-C")
            .arg(folder)
            .arg("rev-parse")
            .arg("HEAD")
            .output(),
    )
    .await
    .ok()?
    .ok()?;

    if !output.status.success() {
        return None;
    }

    let hash = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if hash.is_empty() {
        None
    } else {
        debug!(folder = %folder, hash = %hash, "Got HEAD commit");
        Some(hash)
    }
}

// =============================================================================
// Mock Implementation for Tests
// =============================================================================

#[cfg(test)]
pub mod mock {
    use super::*;
    use std::sync::Arc;
    use tokio::sync::Mutex;

    /// Mock git client for testing
    #[derive(Debug, Clone)]
    pub struct MockGit {
        /// Pre-configured result to return from clone_repo
        result: Arc<Mutex<Option<GitCloneOutput>>>,
    }

    impl MockGit {
        /// Create a mock that returns a successful clone
        pub fn success() -> Self {
            Self {
                result: Arc::new(Mutex::new(Some(GitCloneOutput {
                    success: true,
                    stderr: String::new(),
                }))),
            }
        }

        /// Create a mock that returns a failed clone with the given stderr
        pub fn failure(stderr: &str) -> Self {
            Self {
                result: Arc::new(Mutex::new(Some(GitCloneOutput {
                    success: false,
                    stderr: stderr.to_string(),
                }))),
            }
        }

        /// Create a mock that returns an error (git not found)
        pub fn error() -> Self {
            Self {
                result: Arc::new(Mutex::new(None)),
            }
        }
    }

    #[async_trait]
    impl GitClient for MockGit {
        async fn clone_repo(&self, _url: &str, _target: &str) -> Result<GitCloneOutput, ModelError> {
            let result = self.result.lock().await;
            match result.as_ref() {
                Some(output) => Ok(output.clone()),
                None => Err(ModelError::GitError("git: command not found".to_string())),
            }
        }
    }
}

// =============================================================================
// Unit Tests
// =============================================================================

#[cfg(test)]
mod tests {
    use super::mock::MockGit;
    use super::*;

    #[tokio::test]
    async fn test_mock_git_success() {
        let mock = MockGit::success();
        let result = mock.clone_repo("https://github.com/user/repo.git", "/tmp/repo").await.unwrap();
        assert!(result.success);
        assert!(result.stderr.is_empty());
    }

    #[tokio::test]
    async fn test_mock_git_failure() {
        let mock = MockGit::failure("fatal: repository not found");
        let result = mock.clone_repo("https://github.com/user/repo.git", "/tmp/repo").await.unwrap();
        assert!(!result.success);
        assert!(result.stderr.contains("repository not found"));
    }

    #[tokio::test]
    async fn test_mock_git_error() {
        let mock = MockGit::error();
        let result = mock.clone_repo("https://github.com/user/repo.git", "/tmp/repo").await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_detect_git_branch_empty_folder() {
        let result = detect_git_branch("").await;
        assert!(result.is_none());
    }

    #[tokio::test]
    async fn test_detect_git_branch_nonexistent() {
        let result = detect_git_branch("/tmp/nonexistent-folder-abc123xyz").await;
        assert!(result.is_none());
    }
}
