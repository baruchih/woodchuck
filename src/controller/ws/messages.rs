//! WebSocket message types
//!
//! Client-to-server and server-to-client message definitions.

use serde::{Deserialize, Serialize};

// =============================================================================
// Client Messages
// =============================================================================

/// Messages from client to server
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ClientMessage {
    /// Subscribe to session output
    Subscribe { session_id: String },

    /// Unsubscribe from session output
    Unsubscribe { session_id: String },

    /// Send input to a session
    Input {
        session_id: String,
        text: String,
        /// When true, send text literally without appending Enter (for raw terminal keystroke passthrough)
        #[serde(default)]
        raw: bool,
    },

    /// Resize a session's terminal
    Resize {
        session_id: String,
        cols: u16,
        rows: u16,
    },

    /// Request full session list
    GetSessions {
        #[serde(default)]
        request_id: Option<String>,
    },

    /// Request single session detail
    GetSession {
        session_id: String,
        #[serde(default)]
        request_id: Option<String>,
    },

    /// Create a new session
    CreateSession {
        name: String,
        folder: String,
        #[serde(default)]
        prompt: String,
        #[serde(default)]
        request_id: Option<String>,
    },

    /// Delete a session
    DeleteSession {
        session_id: String,
        #[serde(default)]
        request_id: Option<String>,
    },

    /// Update session metadata (rename, project, tags)
    UpdateSession {
        session_id: String,
        #[serde(default)]
        name: Option<String>,
        #[serde(default)]
        project_id: Option<Option<String>>,
        #[serde(default)]
        tags: Option<Vec<String>>,
        #[serde(default)]
        request_id: Option<String>,
    },
}

// =============================================================================
// Server Messages
// =============================================================================

/// Messages from server to client
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ServerMessage {
    /// New output chunk from a session
    Output {
        session_id: String,
        content: String,
        timestamp: String,
    },

    /// Session status changed
    Status {
        session_id: String,
        status: String,
        timestamp: String,
    },

    /// Error occurred
    Error {
        session_id: String,
        message: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        request_id: Option<String>,
    },

    /// Session ended (tmux session terminated)
    SessionEnded {
        session_id: String,
        timestamp: String,
    },

    /// Subscription confirmed
    Subscribed {
        session_id: String,
        current_output: String,
        status: String,
    },

    /// Unsubscription confirmed
    Unsubscribed { session_id: String },

    /// Full session list (response to get_sessions or broadcast on change)
    Sessions {
        sessions: Vec<crate::model::types::Session>,
        #[serde(skip_serializing_if = "Option::is_none")]
        request_id: Option<String>,
    },

    /// Single session detail with output
    SessionDetail {
        session: crate::model::types::Session,
        #[serde(skip_serializing_if = "Option::is_none")]
        recent_output: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        request_id: Option<String>,
    },

    /// Broadcast: session was created
    SessionCreated {
        session: crate::model::types::Session,
    },

    /// Broadcast: session was deleted
    SessionDeleted { session_id: String },

    /// Broadcast: session metadata was updated
    SessionUpdated {
        session_id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        name: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        project_id: Option<String>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        tags: Vec<String>,
    },

    /// Acknowledgment for mutations
    Ack {
        request_id: String,
        success: bool,
    },
}

// =============================================================================
// Unit Tests
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_client_message_deserialize_subscribe() {
        let json = r#"{"type": "subscribe", "session_id": "test"}"#;
        let msg: ClientMessage = serde_json::from_str(json).unwrap();
        match msg {
            ClientMessage::Subscribe { session_id } => assert_eq!(session_id, "test"),
            _ => panic!("Expected Subscribe message"),
        }
    }

    #[test]
    fn test_client_message_deserialize_input() {
        let json = r#"{"type": "input", "session_id": "test", "text": "yes"}"#;
        let msg: ClientMessage = serde_json::from_str(json).unwrap();
        match msg {
            ClientMessage::Input { session_id, text, raw } => {
                assert_eq!(session_id, "test");
                assert_eq!(text, "yes");
                assert!(!raw);
            }
            _ => panic!("Expected Input message"),
        }
    }

    #[test]
    fn test_client_message_deserialize_resize() {
        let json = r#"{"type": "resize", "session_id": "test", "cols": 120, "rows": 40}"#;
        let msg: ClientMessage = serde_json::from_str(json).unwrap();
        match msg {
            ClientMessage::Resize {
                session_id,
                cols,
                rows,
            } => {
                assert_eq!(session_id, "test");
                assert_eq!(cols, 120);
                assert_eq!(rows, 40);
            }
            _ => panic!("Expected Resize message"),
        }
    }

    #[test]
    fn test_server_message_serialize_output() {
        let msg = ServerMessage::Output {
            session_id: "test".to_string(),
            content: "hello".to_string(),
            timestamp: "2025-02-03T10:00:00Z".to_string(),
        };
        let json = serde_json::to_string(&msg).unwrap();
        assert!(json.contains("\"type\":\"output\""));
        assert!(json.contains("\"session_id\":\"test\""));
    }

    #[test]
    fn test_server_message_serialize_status() {
        let msg = ServerMessage::Status {
            session_id: "test".to_string(),
            status: "waiting".to_string(),
            timestamp: "2025-02-03T10:00:00Z".to_string(),
        };
        let json = serde_json::to_string(&msg).unwrap();
        assert!(json.contains("\"type\":\"status\""));
        assert!(json.contains("\"status\":\"waiting\""));
    }
}
