//! Utility modules
//!
//! Low-level wrappers for external services:
//! - tmux: Terminal multiplexer commands
//! - notify: ntfy.sh push notifications
//! - push: Web Push notifications
//! - session_store: Session name persistence
//! - hooks: Claude Code hook injection

pub mod git;
pub mod hooks;
pub mod notify;
pub mod push;
pub mod session_store;
pub mod tmux;

// Re-exports
pub use git::{detect_git_branch, Git, GitClient};
pub use hooks::inject_hooks;
pub use notify::{NoopNtfy, Ntfy, NtfyClient};
pub use push::{NoopWebPush, PushSubscription, PushSubscriptionKeys, WebPush, WebPushClient};
pub use session_store::{JsonSessionStore, NoopSessionStore, PersistedProject, PersistedSessionState, SessionStore};
pub use tmux::{Tmux, TmuxClient};
