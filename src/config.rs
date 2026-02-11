//! Service configuration
//!
//! Loaded from environment variables at startup.
//! Accessible by all layers (service.rs, model, controller).

use std::env;
use thiserror::Error;

// =============================================================================
// Errors
// =============================================================================

#[derive(Error, Debug)]
pub enum ConfigError {
    #[error("Missing required environment variable: {0}")]
    MissingEnvVar(String),

    #[error("Invalid value for {field}: {message}")]
    InvalidValue { field: String, message: String },

    #[error("Failed to parse {field}: {message}")]
    ParseError { field: String, message: String },
}

// =============================================================================
// Main Config
// =============================================================================

/// Service configuration loaded from environment variables
#[derive(Debug, Clone)]
pub struct Config {
    /// HTTP server port
    pub http_port: u16,

    /// WebSocket server port (can be same as HTTP)
    pub ws_port: u16,

    /// Logging level
    pub log_level: String,

    /// Directory containing project folders
    pub projects_dir: String,

    /// Directory for persistent data (session names, etc.)
    pub data_dir: String,

    /// ntfy server URL (optional)
    pub ntfy_server: Option<String>,

    /// ntfy topic (optional)
    pub ntfy_topic: Option<String>,

    /// VAPID private key for web push (optional, base64-encoded)
    pub vapid_private_key: Option<String>,

    /// VAPID public key for web push (optional, base64-encoded)
    pub vapid_public_key: Option<String>,

    /// Graceful shutdown timeout in seconds
    pub shutdown_timeout_secs: u64,

    /// Static files directory for PWA
    pub static_dir: String,

    /// CORS allowed origins (comma-separated, or "*" for any)
    pub cors_origins: String,

    /// Bind address for HTTP server
    pub bind_addr: String,

    /// TLS certificate path (optional - enables HTTPS)
    pub tls_cert: Option<String>,

    /// TLS private key path (optional - requires tls_cert)
    pub tls_key: Option<String>,

    /// External URL for the Woodchuck server (used by hooks)
    /// Defaults to http://localhost:{http_port}
    pub external_url: String,
}

impl Config {
    /// Load configuration from environment variables
    pub fn from_env() -> Result<Self, ConfigError> {
        let projects_dir = env::var("PROJECTS_DIR").unwrap_or_else(|_| {
            // Default to ~/projects
            env::var("HOME")
                .map(|h| format!("{}/projects", h))
                .unwrap_or_else(|_| "/tmp/projects".to_string())
        });

        let data_dir = env::var("DATA_DIR").unwrap_or_else(|_| {
            // Default to ~/.woodchuck
            env::var("HOME")
                .map(|h| format!("{}/.woodchuck", h))
                .unwrap_or_else(|_| "/tmp/woodchuck".to_string())
        });

        let http_port: u16 = parse_env_or_default("HTTP_PORT", 3000)?;

        // External URL defaults to http://localhost:{http_port}
        let external_url = env::var("WOODCHUCK_EXTERNAL_URL")
            .unwrap_or_else(|_| format!("http://localhost:{}", http_port));

        Ok(Self {
            http_port,
            ws_port: parse_env_or_default("WS_PORT", 3001)?,
            log_level: env::var("LOG_LEVEL").unwrap_or_else(|_| "info".to_string()),
            projects_dir,
            data_dir,
            ntfy_server: optional_env("NTFY_SERVER"),
            ntfy_topic: optional_env("NTFY_TOPIC"),
            vapid_private_key: optional_env("VAPID_PRIVATE_KEY"),
            vapid_public_key: optional_env("VAPID_PUBLIC_KEY"),
            shutdown_timeout_secs: parse_env_or_default("SHUTDOWN_TIMEOUT_SECS", 5)?,
            static_dir: env::var("STATIC_DIR").unwrap_or_else(|_| "app/dist".to_string()),
            cors_origins: env::var("CORS_ORIGINS").unwrap_or_else(|_| "*".to_string()),
            bind_addr: env::var("BIND_ADDR").unwrap_or_else(|_| "0.0.0.0".to_string()),
            tls_cert: optional_env("TLS_CERT"),
            tls_key: optional_env("TLS_KEY"),
            external_url,
        })
    }

    /// Check if notifications are enabled
    pub fn notifications_enabled(&self) -> bool {
        self.ntfy_server.is_some() && self.ntfy_topic.is_some()
    }

    /// Check if web push is enabled
    pub fn web_push_enabled(&self) -> bool {
        self.vapid_private_key.is_some() && self.vapid_public_key.is_some()
    }

    /// Check if TLS is enabled
    pub fn tls_enabled(&self) -> bool {
        self.tls_cert.is_some() && self.tls_key.is_some()
    }
}

// =============================================================================
// Helpers
// =============================================================================

fn optional_env(name: &str) -> Option<String> {
    env::var(name).ok().filter(|s| !s.is_empty())
}

fn parse_env_or_default<T>(name: &str, default: T) -> Result<T, ConfigError>
where
    T: std::str::FromStr,
    T::Err: std::fmt::Display,
{
    match env::var(name) {
        Ok(val) => val.parse().map_err(|e: T::Err| ConfigError::ParseError {
            field: name.to_string(),
            message: e.to_string(),
        }),
        Err(_) => Ok(default),
    }
}

// =============================================================================
// Unit Tests
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_optional_env() {
        // Test with unset var - should return None
        assert!(optional_env("NONEXISTENT_VAR_12345").is_none());
    }

    #[test]
    fn test_parse_env_or_default() {
        // Test default value
        let result: Result<u16, ConfigError> =
            parse_env_or_default("NONEXISTENT_VAR_12345", 8080);
        assert_eq!(result.unwrap(), 8080);
    }
}
