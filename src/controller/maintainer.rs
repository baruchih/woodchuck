//! Maintainer session management
//!
//! Handles the self-healing maintainer: inbox processing, status, and deploy pipeline.

use std::path::{Path, PathBuf};
use chrono::Utc;
use tracing::info;

/// Write an inbox item to the inbox directory
pub async fn write_inbox_item(
    inbox_dir: &Path,
    source: &str,
    item_type: &str,
    message: &str,
) -> Result<PathBuf, std::io::Error> {
    tokio::fs::create_dir_all(inbox_dir).await?;

    let timestamp = Utc::now().format("%Y%m%d-%H%M%S");
    let safe_source = source.replace(|c: char| !c.is_alphanumeric() && c != '-' && c != '_', "-");
    let filename = format!("{}-{}.md", timestamp, safe_source);
    let filepath = inbox_dir.join(&filename);

    let content = format!(
        "# Inbox Item\n**From:** {}\n**Time:** {}\n**Type:** {}\n\n{}\n",
        source,
        Utc::now().to_rfc3339(),
        item_type,
        message,
    );

    tokio::fs::write(&filepath, content).await?;
    info!(file = %filename, source = %source, "Wrote inbox item");

    Ok(filepath)
}

/// Count pending inbox items
pub async fn count_inbox_items(inbox_dir: &Path) -> usize {
    let Ok(mut dir) = tokio::fs::read_dir(inbox_dir).await else {
        return 0;
    };

    let mut count = 0;
    while let Ok(Some(entry)) = dir.next_entry().await {
        let path = entry.path();
        if path.is_file() && path.extension().and_then(|e| e.to_str()) == Some("md") {
            count += 1;
        }
    }
    count
}

/// List inbox items (pending)
pub async fn list_inbox_items(inbox_dir: &Path) -> Vec<String> {
    let Ok(mut dir) = tokio::fs::read_dir(inbox_dir).await else {
        return Vec::new();
    };

    let mut items = Vec::new();
    while let Ok(Some(entry)) = dir.next_entry().await {
        let path = entry.path();
        if path.is_file() && path.extension().and_then(|e| e.to_str()) == Some("md") {
            if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                items.push(name.to_string());
            }
        }
    }
    items.sort();
    items
}

/// Get maintainer session ID (constant)
pub const MAINTAINER_SESSION_ID: &str = "woodchuck-maintainer";

/// Get the inbox directory path
pub fn inbox_dir(data_dir: &str) -> PathBuf {
    PathBuf::from(data_dir).join("inbox")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_write_inbox_item() {
        let dir = tempfile::tempdir().unwrap();
        let path = write_inbox_item(dir.path(), "test-session", "bug", "something broke").await.unwrap();

        assert!(path.exists());
        let content = tokio::fs::read_to_string(&path).await.unwrap();
        assert!(content.contains("test-session"));
        assert!(content.contains("bug"));
        assert!(content.contains("something broke"));
    }

    #[tokio::test]
    async fn test_write_inbox_item_sanitizes_source() {
        let dir = tempfile::tempdir().unwrap();
        let path = write_inbox_item(dir.path(), "bad/source\\name", "bug", "test").await.unwrap();

        let filename = path.file_name().unwrap().to_str().unwrap();
        assert!(!filename.contains('/'));
        assert!(!filename.contains('\\'));
    }

    #[tokio::test]
    async fn test_count_inbox_items() {
        let dir = tempfile::tempdir().unwrap();

        assert_eq!(count_inbox_items(dir.path()).await, 0);

        tokio::fs::write(dir.path().join("item1.md"), "content").await.unwrap();
        tokio::fs::write(dir.path().join("item2.md"), "content").await.unwrap();
        tokio::fs::write(dir.path().join("not-counted.txt"), "content").await.unwrap();

        assert_eq!(count_inbox_items(dir.path()).await, 2);
    }

    #[tokio::test]
    async fn test_list_inbox_items() {
        let dir = tempfile::tempdir().unwrap();

        tokio::fs::write(dir.path().join("b-item.md"), "content").await.unwrap();
        tokio::fs::write(dir.path().join("a-item.md"), "content").await.unwrap();

        let items = list_inbox_items(dir.path()).await;
        assert_eq!(items.len(), 2);
        // Should be sorted
        assert_eq!(items[0], "a-item.md");
        assert_eq!(items[1], "b-item.md");
    }

    #[tokio::test]
    async fn test_count_inbox_items_nonexistent_dir() {
        let dir = std::path::PathBuf::from("/tmp/nonexistent-woodchuck-test-dir");
        assert_eq!(count_inbox_items(&dir).await, 0);
    }

    #[test]
    fn test_inbox_dir() {
        let path = inbox_dir("/home/user/.woodchuck");
        assert_eq!(path, PathBuf::from("/home/user/.woodchuck/inbox"));
    }

    #[test]
    fn test_maintainer_session_id() {
        assert_eq!(MAINTAINER_SESSION_ID, "woodchuck-maintainer");
    }
}
