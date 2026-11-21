//! Save to Drive
//!
//! Uploads files and folders from a session to Google Drive through rclone.
//! Setup is one rclone remote (default name `gdrive`), created on the Mac with:
//!
//!   rclone config create gdrive drive scope=drive.file
//!
//! Files land in `<destination>/<project>/<name>`. The destination defaults to
//! `gdrive:Woodchuck` and can be changed with the WOODCHUCK_DRIVE_DEST env var.

use std::path::{Path, PathBuf};
use std::time::Duration;

use tokio::process::Command;
use tracing::{info, warn};

const DEFAULT_DESTINATION: &str = "gdrive:Woodchuck";
const UPLOAD_TIMEOUT: Duration = Duration::from_secs(15 * 60);
const STATUS_TIMEOUT: Duration = Duration::from_secs(10);

/// Folder contents that are never worth uploading (same as the folder zip)
const EXCLUDES: &[&str] = &[".git/**", "node_modules/**", ".DS_Store"];

/// Where saved files go, e.g. "gdrive:Woodchuck"
pub fn destination() -> String {
    std::env::var("WOODCHUCK_DRIVE_DEST")
        .ok()
        .map(|d| d.trim().trim_end_matches('/').to_string())
        .filter(|d| d.contains(':'))
        .unwrap_or_else(|| DEFAULT_DESTINATION.to_string())
}

/// The remote part of a destination, e.g. "gdrive:" for "gdrive:Woodchuck"
fn remote_name(dest: &str) -> &str {
    match dest.find(':') {
        Some(i) => &dest[..=i],
        None => dest,
    }
}

/// Find rclone. Woodchuck runs from launchd, whose PATH lacks Homebrew.
fn rclone_path() -> Option<PathBuf> {
    for p in ["/opt/homebrew/bin/rclone", "/usr/local/bin/rclone"] {
        let p = PathBuf::from(p);
        if p.is_file() {
            return Some(p);
        }
    }
    std::env::var_os("PATH").and_then(|paths| {
        std::env::split_paths(&paths)
            .map(|dir| dir.join("rclone"))
            .find(|p| p.is_file())
    })
}

#[derive(Debug, Clone)]
pub struct DriveStatus {
    pub available: bool,
    pub destination: String,
    /// Why it isn't available, with what to do about it
    pub reason: Option<String>,
}

/// Whether saving to Drive is set up
pub async fn status() -> DriveStatus {
    let destination = destination();
    let unavailable = |reason: String| DriveStatus {
        available: false,
        destination: destination.clone(),
        reason: Some(reason),
    };

    let Some(rclone) = rclone_path() else {
        return unavailable("rclone isn't installed (brew install rclone)".to_string());
    };

    let output = tokio::time::timeout(
        STATUS_TIMEOUT,
        Command::new(&rclone).arg("listremotes").output(),
    )
    .await;
    let remotes = match output {
        Ok(Ok(out)) if out.status.success() => String::from_utf8_lossy(&out.stdout).to_string(),
        Ok(Ok(out)) => {
            return unavailable(format!(
                "rclone listremotes failed: {}",
                String::from_utf8_lossy(&out.stderr).trim()
            ))
        }
        Ok(Err(e)) => return unavailable(format!("couldn't run rclone: {e}")),
        Err(_) => return unavailable("rclone listremotes timed out".to_string()),
    };

    let remote = remote_name(&destination);
    if !remotes.lines().any(|l| l.trim() == remote) {
        return unavailable(format!(
            "no rclone remote named {remote} (run: rclone config create {} drive scope=drive.file)",
            remote.trim_end_matches(':')
        ));
    }

    DriveStatus {
        available: true,
        destination,
        reason: None,
    }
}

/// Upload a file or folder to `<destination>/<project>/<name>`.
/// Returns the Drive path it was saved to.
pub async fn upload(local: &Path, project: &str) -> Result<String, String> {
    let rclone = rclone_path().ok_or("rclone isn't installed")?;
    let name = local
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .ok_or("invalid path")?;
    let target = format!("{}/{}/{}", destination(), project, name);

    let mut cmd = Command::new(&rclone);
    if local.is_dir() {
        // copy = contents of the folder into target (creates it)
        cmd.arg("copy").arg(local).arg(&target);
        for pattern in EXCLUDES {
            cmd.arg("--exclude").arg(pattern);
        }
    } else {
        // copyto = this exact file name, replacing an older copy
        cmd.arg("copyto").arg(local).arg(&target);
    }
    cmd.kill_on_drop(true);

    info!(local = %local.display(), target = %target, "Saving to Drive");
    let output = tokio::time::timeout(UPLOAD_TIMEOUT, cmd.output())
        .await
        .map_err(|_| "upload timed out".to_string())?
        .map_err(|e| format!("couldn't run rclone: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        // rclone logs are long; the last line is the useful one
        let last = stderr.lines().rev().find(|l| !l.trim().is_empty()).unwrap_or("unknown error");
        warn!(target = %target, error = %stderr.trim(), "Save to Drive failed");
        return Err(last.trim().to_string());
    }
    Ok(target)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_remote_name() {
        assert_eq!(remote_name("gdrive:Woodchuck"), "gdrive:");
        assert_eq!(remote_name("gdrive:"), "gdrive:");
        assert_eq!(remote_name("other:a/b"), "other:");
    }

    /// End to end against a local-folder rclone remote standing in for Drive.
    /// The only test that touches these env vars, so setting them is safe.
    #[tokio::test]
    async fn test_status_and_upload_with_local_remote() {
        if rclone_path().is_none() {
            eprintln!("rclone not installed, skipping");
            return;
        }
        let dir = tempfile::TempDir::new().unwrap();
        let dest_root = dir.path().join("drive");
        std::env::set_var("RCLONE_CONFIG_WCTEST_TYPE", "local");

        // Remote missing
        std::env::set_var("WOODCHUCK_DRIVE_DEST", "nosuchremote:Woodchuck");
        let s = status().await;
        assert!(!s.available);
        assert!(s.reason.unwrap().contains("nosuchremote:"));

        std::env::set_var("WOODCHUCK_DRIVE_DEST", format!("wctest:{}/", dest_root.display()));
        let s = status().await;
        assert!(s.available, "{:?}", s.reason);

        // A file
        let project = dir.path().join("proj");
        std::fs::create_dir_all(project.join("docs/node_modules/x")).unwrap();
        std::fs::write(project.join("notes.md"), "v1").unwrap();
        let saved = upload(&project.join("notes.md"), "proj").await.unwrap();
        assert!(saved.ends_with("/proj/notes.md"), "{saved}");
        assert_eq!(std::fs::read_to_string(dest_root.join("proj/notes.md")).unwrap(), "v1");

        // Saving again replaces it
        std::fs::write(project.join("notes.md"), "v2").unwrap();
        upload(&project.join("notes.md"), "proj").await.unwrap();
        assert_eq!(std::fs::read_to_string(dest_root.join("proj/notes.md")).unwrap(), "v2");

        // A folder, without node_modules
        std::fs::write(project.join("docs/a.txt"), "a").unwrap();
        std::fs::write(project.join("docs/node_modules/x/big.js"), "x").unwrap();
        upload(&project.join("docs"), "proj").await.unwrap();
        assert!(dest_root.join("proj/docs/a.txt").is_file());
        assert!(!dest_root.join("proj/docs/node_modules").exists());

        std::env::remove_var("WOODCHUCK_DRIVE_DEST");
        std::env::remove_var("RCLONE_CONFIG_WCTEST_TYPE");
    }
}
