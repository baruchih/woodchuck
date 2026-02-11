//! Folder business logic
//!
//! Handles creating project folders and cloning git repositories.

use std::path::Path;

use tracing::{info, instrument, warn};

use crate::config::Config;
use crate::model::error::{ModelError, Result};
use crate::model::types::CreateFolderParams;
use crate::utils::GitClient;

// =============================================================================
// Validation
// =============================================================================

/// Validate a folder name.
///
/// Rules:
/// - Must not be empty
/// - Must not start with `-` or `.`
/// - Must not contain `/`, `\`, or null bytes
/// - Only alphanumeric, hyphens, underscores, and dots allowed
pub fn validate_folder_name(name: &str) -> Result<()> {
    if name.is_empty() {
        return Err(ModelError::InvalidInput("Folder name must not be empty".to_string()));
    }

    if name.starts_with('-') || name.starts_with('.') {
        return Err(ModelError::InvalidInput(
            "Folder name must not start with '-' or '.'".to_string(),
        ));
    }

    // Only allow alphanumeric, hyphens, underscores, and dots
    for ch in name.chars() {
        if !ch.is_alphanumeric() && ch != '-' && ch != '_' && ch != '.' {
            return Err(ModelError::InvalidInput(format!(
                "Folder name contains invalid character: '{}'",
                ch
            )));
        }
    }

    Ok(())
}

/// Validate a git URL for cloning.
///
/// Rules:
/// - Must not start with `-` (option injection)
/// - Must be HTTPS (`https://`) or SSH shorthand (`git@host:path`)
/// - Rejects `file://`, `ext::`, `ssh://`, `http://` schemes
pub fn validate_git_url(url: &str) -> Result<()> {
    if url.is_empty() {
        return Err(ModelError::InvalidInput("Git URL must not be empty".to_string()));
    }

    if url.starts_with('-') {
        return Err(ModelError::InvalidInput(
            "Git URL must not start with '-'".to_string(),
        ));
    }

    // Block dangerous schemes
    let lower = url.to_lowercase();
    if lower.starts_with("file://") {
        return Err(ModelError::InvalidInput(
            "file:// URLs are not allowed".to_string(),
        ));
    }
    if lower.starts_with("ext::") {
        return Err(ModelError::InvalidInput(
            "ext:: transport is not allowed".to_string(),
        ));
    }
    if lower.starts_with("ssh://") {
        return Err(ModelError::InvalidInput(
            "ssh:// URLs are not allowed; use git@host:path format instead".to_string(),
        ));
    }
    if lower.starts_with("http://") {
        return Err(ModelError::InvalidInput(
            "http:// URLs are not allowed; use HTTPS instead".to_string(),
        ));
    }

    // Allow HTTPS URLs
    if lower.starts_with("https://") {
        return Ok(());
    }

    // Allow SSH shorthand: git@host:user/repo.git
    // Pattern: starts with "git@", has host between @ and :, has path after :
    if lower.starts_with("git@") && url.contains(':') {
        // Extract host (between @ and :) and path (after :)
        let after_at = &url[4..]; // skip "git@"
        if let Some(colon_pos) = after_at.find(':') {
            let host = &after_at[..colon_pos];
            let path = &after_at[colon_pos + 1..];
            // Host must not be empty, path must not be empty or start with /
            if !host.is_empty() && !path.is_empty() && !path.starts_with('/') {
                return Ok(());
            }
        }
    }

    Err(ModelError::InvalidInput(
        "Invalid git URL. Use HTTPS (https://...) or SSH (git@host:path) format".to_string(),
    ))
}

/// Extract repository name from a git URL.
///
/// Examples:
/// - `https://github.com/user/repo.git` -> `repo`
/// - `https://github.com/user/repo` -> `repo`
/// - `https://github.com/user/repo/` -> `repo`
/// - `git@github.com:user/repo.git` -> `repo`
/// - `git@github.com:user/repo` -> `repo`
pub fn repo_name_from_url(url: &str) -> Option<String> {
    let trimmed = url.trim_end_matches('/');

    // For SSH shorthand (git@host:user/repo.git), split on ':' then '/'
    let last_segment = if trimmed.starts_with("git@") && trimmed.contains(':') {
        // git@github.com:user/repo.git -> user/repo.git -> repo.git
        trimmed.split(':').next_back()?.rsplit('/').next()?
    } else {
        // HTTPS: https://github.com/user/repo.git -> repo.git
        trimmed.rsplit('/').next()?
    };

    let name = last_segment.strip_suffix(".git").unwrap_or(last_segment);

    if name.is_empty() {
        None
    } else {
        Some(name.to_string())
    }
}

/// Classify a git clone error from stderr into a user-friendly ModelError.
///
/// Maps known git error patterns to either GitCloneError (user issue)
/// or GitError (server issue).
pub fn classify_git_error(stderr: &str) -> ModelError {
    let lower = stderr.to_lowercase();

    if lower.contains("repository not found")
        || lower.contains("could not read from remote repository")
    {
        return ModelError::GitCloneError("Repository not found. Check the URL and access permissions.".to_string());
    }

    if lower.contains("authentication failed")
        || lower.contains("could not read username")
    {
        return ModelError::GitCloneError(
            "Authentication failed. The repository may be private.".to_string(),
        );
    }

    if lower.contains("could not resolve host") {
        return ModelError::GitCloneError(
            "Could not resolve host. Check your network connection and URL.".to_string(),
        );
    }

    if lower.contains("already exists and is not an empty directory") {
        return ModelError::FolderAlreadyExists(
            "Target directory already exists".to_string(),
        );
    }

    if lower.contains("not a git repository") {
        return ModelError::GitCloneError(
            "The URL does not point to a valid git repository.".to_string(),
        );
    }

    // Default: log the raw stderr server-side and return a generic message
    warn!(stderr = %stderr.trim(), "Unclassified git clone error");
    ModelError::GitCloneError("Git clone failed. Check the URL and try again.".to_string())
}

// =============================================================================
// Main Logic
// =============================================================================

/// List project folders (non-hidden directories) in the projects directory.
///
/// Returns sorted list of full paths.
pub fn list_folders(config: &Config) -> Result<Vec<String>> {
    let entries = std::fs::read_dir(&config.projects_dir)
        .map_err(|e| ModelError::IoError(format!("Failed to read projects directory: {}", e)))?;

    let mut folders = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            if let Some(name) = path.file_name() {
                if let Some(name_str) = name.to_str() {
                    // Skip hidden directories
                    if !name_str.starts_with('.') {
                        folders.push(path.to_string_lossy().to_string());
                    }
                }
            }
        }
    }

    folders.sort();
    Ok(folders)
}

/// Create a project folder (empty or by cloning a git repository).
///
/// Returns the full path to the created folder on success.
#[instrument(skip(git, config))]
pub async fn create_folder(
    git: &(impl GitClient + ?Sized),
    config: &Config,
    params: CreateFolderParams,
) -> Result<String> {
    match params {
        CreateFolderParams::Create { name } => {
            validate_folder_name(&name)?;

            let full_path = Path::new(&config.projects_dir).join(&name);
            let full_path_str = full_path.to_string_lossy().to_string();

            if full_path.exists() {
                return Err(ModelError::FolderAlreadyExists(name));
            }

            std::fs::create_dir(&full_path).map_err(|e| {
                ModelError::IoError(format!("Failed to create folder '{}': {}", name, e))
            })?;

            info!(name = %name, path = %full_path_str, "Created folder");
            Ok(full_path_str)
        }
        CreateFolderParams::Clone { url, name } => {
            validate_git_url(&url)?;

            // Determine folder name: explicit name, or extract from URL
            let folder_name = match name {
                Some(n) => {
                    validate_folder_name(&n)?;
                    n
                }
                None => repo_name_from_url(&url).ok_or_else(|| {
                    ModelError::InvalidInput(
                        "Could not determine folder name from URL. Provide an explicit name.".to_string(),
                    )
                })?,
            };

            let full_path = Path::new(&config.projects_dir).join(&folder_name);
            let full_path_str = full_path.to_string_lossy().to_string();

            if full_path.exists() {
                return Err(ModelError::FolderAlreadyExists(folder_name));
            }

            let output = git.clone_repo(&url, &full_path_str).await?;

            if !output.success {
                return Err(classify_git_error(&output.stderr));
            }

            info!(name = %folder_name, url = %url, path = %full_path_str, "Cloned repository");
            Ok(full_path_str)
        }
    }
}

// =============================================================================
// Unit Tests
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    // -------------------------------------------------------------------------
    // validate_folder_name
    // -------------------------------------------------------------------------

    #[test]
    fn test_validate_folder_name_valid() {
        assert!(validate_folder_name("my-project").is_ok());
        assert!(validate_folder_name("my_project").is_ok());
        assert!(validate_folder_name("project123").is_ok());
        assert!(validate_folder_name("a.b.c").is_ok());
        assert!(validate_folder_name("A").is_ok());
    }

    #[test]
    fn test_validate_folder_name_empty() {
        assert!(validate_folder_name("").is_err());
    }

    #[test]
    fn test_validate_folder_name_leading_dash() {
        assert!(validate_folder_name("-bad").is_err());
    }

    #[test]
    fn test_validate_folder_name_leading_dot() {
        assert!(validate_folder_name(".hidden").is_err());
    }

    #[test]
    fn test_validate_folder_name_slash() {
        assert!(validate_folder_name("a/b").is_err());
    }

    #[test]
    fn test_validate_folder_name_backslash() {
        assert!(validate_folder_name("a\\b").is_err());
    }

    #[test]
    fn test_validate_folder_name_null() {
        assert!(validate_folder_name("a\0b").is_err());
    }

    #[test]
    fn test_validate_folder_name_special_chars() {
        assert!(validate_folder_name("a b").is_err()); // space
        assert!(validate_folder_name("a@b").is_err());
        assert!(validate_folder_name("a!b").is_err());
        assert!(validate_folder_name("a$b").is_err());
    }

    // -------------------------------------------------------------------------
    // validate_git_url
    // -------------------------------------------------------------------------

    #[test]
    fn test_validate_git_url_valid_https() {
        assert!(validate_git_url("https://github.com/user/repo.git").is_ok());
        assert!(validate_git_url("https://gitlab.com/user/repo").is_ok());
    }

    #[test]
    fn test_validate_git_url_empty() {
        assert!(validate_git_url("").is_err());
    }

    #[test]
    fn test_validate_git_url_leading_dash() {
        assert!(validate_git_url("-https://evil.com").is_err());
    }

    #[test]
    fn test_validate_git_url_file_scheme() {
        assert!(validate_git_url("file:///etc/passwd").is_err());
    }

    #[test]
    fn test_validate_git_url_ext_scheme() {
        assert!(validate_git_url("ext::sh -c evil").is_err());
    }

    #[test]
    fn test_validate_git_url_ssh_scheme() {
        // ssh:// scheme is blocked, use git@ shorthand instead
        assert!(validate_git_url("ssh://git@github.com/user/repo").is_err());
    }

    #[test]
    fn test_validate_git_url_ssh_shorthand() {
        // git@host:path format is allowed
        assert!(validate_git_url("git@github.com:user/repo.git").is_ok());
        assert!(validate_git_url("git@gitlab.com:user/repo").is_ok());
        assert!(validate_git_url("git@bitbucket.org:team/project.git").is_ok());
    }

    #[test]
    fn test_validate_git_url_http_scheme() {
        assert!(validate_git_url("http://github.com/user/repo").is_err());
    }

    #[test]
    fn test_validate_git_url_random_string() {
        assert!(validate_git_url("not-a-url").is_err());
    }

    #[test]
    fn test_validate_git_url_invalid_ssh_format() {
        // git@ without proper format should fail
        assert!(validate_git_url("git@github.com").is_err()); // no colon
        assert!(validate_git_url("git@:repo").is_err()); // no host
    }

    // -------------------------------------------------------------------------
    // repo_name_from_url
    // -------------------------------------------------------------------------

    #[test]
    fn test_repo_name_basic() {
        assert_eq!(
            repo_name_from_url("https://github.com/user/repo.git"),
            Some("repo".to_string())
        );
    }

    #[test]
    fn test_repo_name_no_git_suffix() {
        assert_eq!(
            repo_name_from_url("https://github.com/user/repo"),
            Some("repo".to_string())
        );
    }

    #[test]
    fn test_repo_name_trailing_slash() {
        assert_eq!(
            repo_name_from_url("https://github.com/user/repo/"),
            Some("repo".to_string())
        );
    }

    #[test]
    fn test_repo_name_git_suffix_trailing_slash() {
        assert_eq!(
            repo_name_from_url("https://github.com/user/repo.git/"),
            Some("repo".to_string())
        );
    }

    #[test]
    fn test_repo_name_empty_url() {
        // Edge case: no path
        assert_eq!(repo_name_from_url(""), Some("".to_string()).filter(|s| !s.is_empty()));
    }

    #[test]
    fn test_repo_name_ssh_shorthand() {
        assert_eq!(
            repo_name_from_url("git@github.com:user/repo.git"),
            Some("repo".to_string())
        );
    }

    #[test]
    fn test_repo_name_ssh_no_git_suffix() {
        assert_eq!(
            repo_name_from_url("git@github.com:user/repo"),
            Some("repo".to_string())
        );
    }

    #[test]
    fn test_repo_name_ssh_nested_path() {
        assert_eq!(
            repo_name_from_url("git@github.com:org/team/repo.git"),
            Some("repo".to_string())
        );
    }

    // -------------------------------------------------------------------------
    // classify_git_error
    // -------------------------------------------------------------------------

    #[test]
    fn test_classify_repo_not_found() {
        let err = classify_git_error("fatal: repository 'https://x.com/y/z' not found");
        assert!(matches!(err, ModelError::GitCloneError(_)));
    }

    #[test]
    fn test_classify_auth_failed() {
        let err = classify_git_error("fatal: Authentication failed for ...");
        assert!(matches!(err, ModelError::GitCloneError(_)));
    }

    #[test]
    fn test_classify_host_not_resolved() {
        let err = classify_git_error("fatal: unable to access '...': Could not resolve host: x.com");
        assert!(matches!(err, ModelError::GitCloneError(_)));
    }

    #[test]
    fn test_classify_already_exists() {
        let err = classify_git_error(
            "fatal: destination path 'foo' already exists and is not an empty directory",
        );
        assert!(matches!(err, ModelError::FolderAlreadyExists(_)));
    }

    #[test]
    fn test_classify_unknown() {
        let err = classify_git_error("some random git error");
        assert!(matches!(err, ModelError::GitCloneError(_)));
    }

    // -------------------------------------------------------------------------
    // create_folder (with mocks)
    // -------------------------------------------------------------------------

    use crate::utils::git::mock::MockGit;

    fn test_config(dir: &str) -> Config {
        Config {
            http_port: 3000,
            ws_port: 3001,
            log_level: "info".to_string(),
            projects_dir: dir.to_string(),
            data_dir: "/tmp/woodchuck".to_string(),
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
    async fn test_create_folder_create_action() {
        let tmp = tempfile::tempdir().unwrap();
        let config = test_config(tmp.path().to_str().unwrap());
        let git = MockGit::success();

        let result = create_folder(&git, &config, CreateFolderParams::Create {
            name: "my-project".to_string(),
        })
        .await;

        assert!(result.is_ok());
        let path = result.unwrap();
        assert!(path.ends_with("my-project"));
        assert!(Path::new(&path).is_dir());
    }

    #[tokio::test]
    async fn test_create_folder_create_already_exists() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir(tmp.path().join("existing")).unwrap();
        let config = test_config(tmp.path().to_str().unwrap());
        let git = MockGit::success();

        let result = create_folder(&git, &config, CreateFolderParams::Create {
            name: "existing".to_string(),
        })
        .await;

        assert!(matches!(result, Err(ModelError::FolderAlreadyExists(_))));
    }

    #[tokio::test]
    async fn test_create_folder_create_invalid_name() {
        let tmp = tempfile::tempdir().unwrap();
        let config = test_config(tmp.path().to_str().unwrap());
        let git = MockGit::success();

        let result = create_folder(&git, &config, CreateFolderParams::Create {
            name: "../escape".to_string(),
        })
        .await;

        assert!(matches!(result, Err(ModelError::InvalidInput(_))));
    }

    #[tokio::test]
    async fn test_create_folder_clone_action() {
        let tmp = tempfile::tempdir().unwrap();
        let config = test_config(tmp.path().to_str().unwrap());
        let git = MockGit::success();

        let result = create_folder(&git, &config, CreateFolderParams::Clone {
            url: "https://github.com/user/my-repo.git".to_string(),
            name: None,
        })
        .await;

        assert!(result.is_ok());
        let path = result.unwrap();
        assert!(path.ends_with("my-repo"));
    }

    #[tokio::test]
    async fn test_create_folder_clone_explicit_name() {
        let tmp = tempfile::tempdir().unwrap();
        let config = test_config(tmp.path().to_str().unwrap());
        let git = MockGit::success();

        let result = create_folder(&git, &config, CreateFolderParams::Clone {
            url: "https://github.com/user/repo.git".to_string(),
            name: Some("custom-name".to_string()),
        })
        .await;

        assert!(result.is_ok());
        let path = result.unwrap();
        assert!(path.ends_with("custom-name"));
    }

    #[tokio::test]
    async fn test_create_folder_clone_invalid_url() {
        let tmp = tempfile::tempdir().unwrap();
        let config = test_config(tmp.path().to_str().unwrap());
        let git = MockGit::success();

        // ssh:// scheme is blocked (use git@ shorthand instead)
        let result = create_folder(&git, &config, CreateFolderParams::Clone {
            url: "ssh://git@github.com/user/repo".to_string(),
            name: None,
        })
        .await;

        assert!(matches!(result, Err(ModelError::InvalidInput(_))));
    }

    #[tokio::test]
    async fn test_create_folder_clone_ssh_shorthand() {
        let tmp = tempfile::tempdir().unwrap();
        let config = test_config(tmp.path().to_str().unwrap());
        let git = MockGit::success();

        // git@ shorthand is allowed
        let result = create_folder(&git, &config, CreateFolderParams::Clone {
            url: "git@github.com:user/my-repo.git".to_string(),
            name: None,
        })
        .await;

        assert!(result.is_ok());
        let path = result.unwrap();
        assert!(path.ends_with("my-repo"));
    }

    #[tokio::test]
    async fn test_create_folder_clone_failure() {
        let tmp = tempfile::tempdir().unwrap();
        let config = test_config(tmp.path().to_str().unwrap());
        let git = MockGit::failure("fatal: repository 'https://github.com/x/y' not found");

        let result = create_folder(&git, &config, CreateFolderParams::Clone {
            url: "https://github.com/x/y.git".to_string(),
            name: None,
        })
        .await;

        assert!(matches!(result, Err(ModelError::GitCloneError(_))));
    }

    #[tokio::test]
    async fn test_create_folder_clone_git_error() {
        let tmp = tempfile::tempdir().unwrap();
        let config = test_config(tmp.path().to_str().unwrap());
        let git = MockGit::error();

        let result = create_folder(&git, &config, CreateFolderParams::Clone {
            url: "https://github.com/x/y.git".to_string(),
            name: None,
        })
        .await;

        assert!(matches!(result, Err(ModelError::GitError(_))));
    }

    #[tokio::test]
    async fn test_create_folder_clone_already_exists() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir(tmp.path().join("repo")).unwrap();
        let config = test_config(tmp.path().to_str().unwrap());
        let git = MockGit::success();

        let result = create_folder(&git, &config, CreateFolderParams::Clone {
            url: "https://github.com/user/repo.git".to_string(),
            name: None,
        })
        .await;

        assert!(matches!(result, Err(ModelError::FolderAlreadyExists(_))));
    }
}
