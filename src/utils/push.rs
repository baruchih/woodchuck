//! Web Push notification client
//!
//! Sends push notifications via the Web Push protocol when Claude needs attention.

use async_trait::async_trait;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;
use tracing::{debug, info, instrument, warn};
use web_push::{
    ContentEncoding, IsahcWebPushClient, SubscriptionInfo, VapidSignatureBuilder,
    WebPushClient as WpClient, WebPushMessageBuilder,
};

use crate::config::Config;
use crate::model::error::ModelError;

// =============================================================================
// Types
// =============================================================================

/// Web Push subscription keys from the browser
#[derive(Debug, Clone, serde::Deserialize, serde::Serialize)]
pub struct PushSubscriptionKeys {
    pub p256dh: String,
    pub auth: String,
}

/// Web Push subscription info from the browser
#[derive(Debug, Clone, serde::Deserialize, serde::Serialize)]
pub struct PushSubscription {
    pub endpoint: String,
    pub keys: PushSubscriptionKeys,
}

/// Maximum number of push subscriptions allowed
const MAX_SUBSCRIPTIONS: usize = 100;

/// Allowed push service domains
const ALLOWED_PUSH_DOMAINS: &[&str] = &[
    "fcm.googleapis.com",
    "push.services.mozilla.com",
    "push.apple.com",
    "updates.push.services.mozilla.com",
    "updates-autopush.stage.mozaws.net",
    "updates-autopush.dev.mozaws.net",
];

/// Validate that an endpoint URL is from a known push service
fn is_valid_push_endpoint(endpoint: &str) -> bool {
    if let Ok(url) = url::Url::parse(endpoint) {
        if url.scheme() != "https" {
            return false;
        }
        if let Some(host) = url.host_str() {
            return ALLOWED_PUSH_DOMAINS.iter().any(|domain| {
                host == *domain || host.ends_with(&format!(".{}", domain))
            });
        }
    }
    false
}

/// In-memory store for push subscriptions
#[derive(Debug, Default)]
pub struct PushStore {
    /// Map of endpoint -> subscription
    subscriptions: RwLock<HashMap<String, PushSubscription>>,
}

impl PushStore {
    /// Create a new empty store
    pub fn new() -> Self {
        Self::default()
    }

    /// Add a subscription
    /// Returns Ok(()) if added, Err with reason if rejected
    pub async fn add(&self, subscription: PushSubscription) -> Result<(), ModelError> {
        // Validate endpoint URL
        if !is_valid_push_endpoint(&subscription.endpoint) {
            return Err(ModelError::ValidationError(
                "Invalid push endpoint: must be HTTPS from a known push service".to_string(),
            ));
        }

        let endpoint = subscription.endpoint.clone();
        let mut subs = self.subscriptions.write().await;

        // Check subscription limit (unless this is a re-subscription)
        if !subs.contains_key(&endpoint) && subs.len() >= MAX_SUBSCRIPTIONS {
            return Err(ModelError::ValidationError(format!(
                "Maximum subscription limit ({}) reached",
                MAX_SUBSCRIPTIONS
            )));
        }

        subs.insert(endpoint, subscription);
        info!(count = subs.len(), "Subscription added");
        Ok(())
    }

    /// Remove a subscription by endpoint
    pub async fn remove(&self, endpoint: &str) {
        let mut subs = self.subscriptions.write().await;
        subs.remove(endpoint);
        info!(count = subs.len(), "Subscription removed");
    }

    /// Get all subscriptions
    pub async fn get_all(&self) -> Vec<PushSubscription> {
        let subs = self.subscriptions.read().await;
        subs.values().cloned().collect()
    }

    /// Get subscription count
    pub async fn count(&self) -> usize {
        let subs = self.subscriptions.read().await;
        subs.len()
    }
}

// =============================================================================
// Trait
// =============================================================================

/// Trait for web push operations
#[async_trait]
pub trait WebPushClient: Send + Sync {
    /// Send a push notification to a specific subscription
    async fn send(&self, subscription: &PushSubscription, payload: &str)
        -> Result<(), ModelError>;

    /// Send a push notification to all subscribers
    async fn send_to_all(&self, payload: &str) -> Result<(), ModelError>;

    /// Check if web push is enabled
    fn is_enabled(&self) -> bool;

    /// Get the public VAPID key (for client-side subscription)
    fn public_key(&self) -> Option<String>;

    /// Subscribe to push notifications
    async fn subscribe(&self, subscription: PushSubscription) -> Result<(), ModelError>;

    /// Unsubscribe from push notifications
    async fn unsubscribe(&self, endpoint: &str);
}

// =============================================================================
// Real Implementation
// =============================================================================

/// Real web push implementation using the web-push crate
pub struct WebPush {
    /// VAPID private key (base64-encoded URL-safe)
    private_key: Option<String>,
    /// VAPID public key (base64-encoded URL-safe)
    public_key: Option<String>,
    /// Subscription store
    store: Arc<PushStore>,
    /// HTTP client for sending push messages
    client: Option<IsahcWebPushClient>,
}

impl std::fmt::Debug for WebPush {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("WebPush")
            .field("enabled", &self.is_enabled())
            .field("public_key", &self.public_key.as_ref().map(|_| "[redacted]"))
            .finish()
    }
}

impl WebPush {
    /// Create new web push client from config
    pub fn new(config: &Config) -> Self {
        let client = IsahcWebPushClient::new().ok();
        if client.is_none() {
            warn!("Failed to create web push HTTP client");
        }

        Self {
            private_key: config.vapid_private_key.clone(),
            public_key: config.vapid_public_key.clone(),
            store: Arc::new(PushStore::new()),
            client,
        }
    }

    /// Create a disabled web push client
    pub fn disabled() -> Self {
        Self {
            private_key: None,
            public_key: None,
            store: Arc::new(PushStore::new()),
            client: None,
        }
    }
}

#[async_trait]
impl WebPushClient for WebPush {
    #[instrument(skip(self, payload))]
    async fn send(
        &self,
        subscription: &PushSubscription,
        payload: &str,
    ) -> Result<(), ModelError> {
        if !self.is_enabled() {
            debug!("Web push disabled, skipping");
            return Ok(());
        }

        let private_key = self
            .private_key
            .as_ref()
            .ok_or_else(|| ModelError::NotificationError("VAPID private key not set".to_string()))?;

        let client = self
            .client
            .as_ref()
            .ok_or_else(|| ModelError::NotificationError("Web push client not available".to_string()))?;

        // Build subscription info
        let subscription_info = SubscriptionInfo::new(
            &subscription.endpoint,
            &subscription.keys.p256dh,
            &subscription.keys.auth,
        );

        // Build VAPID signature from base64 private key
        let sig = VapidSignatureBuilder::from_base64(private_key, &subscription_info)
            .map_err(|e| ModelError::NotificationError(format!("Failed to parse VAPID key: {}", e)))?
            .build()
            .map_err(|e| {
                ModelError::NotificationError(format!("Failed to build VAPID signature: {}", e))
            })?;

        // Build the push message
        let mut builder = WebPushMessageBuilder::new(&subscription_info);
        builder.set_vapid_signature(sig);
        builder.set_payload(ContentEncoding::Aes128Gcm, payload.as_bytes());

        let message = builder.build().map_err(|e| {
            ModelError::NotificationError(format!("Failed to build push message: {}", e))
        })?;

        // Send the push notification
        client.send(message).await.map_err(|e| {
            ModelError::NotificationError(format!("Failed to send push notification: {}", e))
        })?;

        debug!(endpoint = %subscription.endpoint, "Push notification sent");
        Ok(())
    }

    #[instrument(skip(self, payload))]
    async fn send_to_all(&self, payload: &str) -> Result<(), ModelError> {
        if !self.is_enabled() {
            debug!("Web push disabled, skipping");
            return Ok(());
        }

        let subscriptions = self.store.get_all().await;
        let count = subscriptions.len();

        if count == 0 {
            info!("No push subscriptions registered, skipping notification");
            return Ok(());
        }

        info!(count = count, "Sending push to all subscribers");

        let mut errors = Vec::new();
        let mut stale_endpoints = Vec::new();

        for subscription in subscriptions {
            if let Err(e) = self.send(&subscription, payload).await {
                let error_str = e.to_string();
                // Check for 410 Gone - subscription expired/unsubscribed
                if error_str.contains("410") || error_str.contains("expired") {
                    info!(endpoint = %subscription.endpoint, "Removing expired push subscription");
                    stale_endpoints.push(subscription.endpoint.clone());
                } else {
                    warn!(endpoint = %subscription.endpoint, error = %e, "Failed to send push");
                }
                errors.push(e);
            }
        }

        // Remove stale subscriptions
        for endpoint in stale_endpoints {
            self.store.remove(&endpoint).await;
        }

        // Return error if all sends failed
        if errors.len() == count && !errors.is_empty() {
            return Err(ModelError::NotificationError(
                "All push notifications failed".to_string(),
            ));
        }

        Ok(())
    }

    fn is_enabled(&self) -> bool {
        self.private_key.is_some() && self.public_key.is_some() && self.client.is_some()
    }

    fn public_key(&self) -> Option<String> {
        self.public_key.clone()
    }

    async fn subscribe(&self, subscription: PushSubscription) -> Result<(), ModelError> {
        self.store.add(subscription).await
    }

    async fn unsubscribe(&self, endpoint: &str) {
        self.store.remove(endpoint).await;
    }
}

// =============================================================================
// Noop Implementation
// =============================================================================

/// No-op web push client (for when web push is disabled)
#[derive(Debug, Clone, Default)]
pub struct NoopWebPush;

#[async_trait]
impl WebPushClient for NoopWebPush {
    async fn send(
        &self,
        _subscription: &PushSubscription,
        _payload: &str,
    ) -> Result<(), ModelError> {
        Ok(())
    }

    async fn send_to_all(&self, _payload: &str) -> Result<(), ModelError> {
        Ok(())
    }

    fn is_enabled(&self) -> bool {
        false
    }

    fn public_key(&self) -> Option<String> {
        None
    }

    async fn subscribe(&self, _subscription: PushSubscription) -> Result<(), ModelError> {
        Ok(())
    }

    async fn unsubscribe(&self, _endpoint: &str) {}
}

// =============================================================================
// Unit Tests
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_web_push_disabled() {
        let push = WebPush::disabled();
        assert!(!push.is_enabled());
        assert!(push.public_key().is_none());
    }

    #[tokio::test]
    async fn test_noop_web_push() {
        let push = NoopWebPush;
        assert!(!push.is_enabled());
        assert!(push.public_key().is_none());

        // Should succeed without doing anything
        let result = push.send_to_all("test payload").await;
        assert!(result.is_ok());
    }

    #[tokio::test]
    async fn test_push_store() {
        let store = PushStore::new();

        assert_eq!(store.count().await, 0);

        let sub = PushSubscription {
            endpoint: "https://fcm.googleapis.com/push/123".to_string(),
            keys: PushSubscriptionKeys {
                p256dh: "test-p256dh".to_string(),
                auth: "test-auth".to_string(),
            },
        };

        store.add(sub.clone()).await.unwrap();
        assert_eq!(store.count().await, 1);

        let all = store.get_all().await;
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].endpoint, "https://fcm.googleapis.com/push/123");

        store.remove("https://fcm.googleapis.com/push/123").await;
        assert_eq!(store.count().await, 0);
    }

    #[tokio::test]
    async fn test_push_store_dedup() {
        let store = PushStore::new();

        let sub = PushSubscription {
            endpoint: "https://fcm.googleapis.com/push/123".to_string(),
            keys: PushSubscriptionKeys {
                p256dh: "test-p256dh".to_string(),
                auth: "test-auth".to_string(),
            },
        };

        // Adding the same subscription twice should deduplicate
        store.add(sub.clone()).await.unwrap();
        store.add(sub.clone()).await.unwrap();
        assert_eq!(store.count().await, 1);
    }

    #[tokio::test]
    async fn test_push_store_invalid_endpoint() {
        let store = PushStore::new();

        // Invalid endpoint (not a known push service)
        let sub = PushSubscription {
            endpoint: "https://evil.com/push/123".to_string(),
            keys: PushSubscriptionKeys {
                p256dh: "test-p256dh".to_string(),
                auth: "test-auth".to_string(),
            },
        };

        let result = store.add(sub).await;
        assert!(result.is_err());
        assert_eq!(store.count().await, 0);
    }

    #[tokio::test]
    async fn test_push_store_http_endpoint_rejected() {
        let store = PushStore::new();

        // HTTP endpoint should be rejected (must be HTTPS)
        let sub = PushSubscription {
            endpoint: "http://fcm.googleapis.com/push/123".to_string(),
            keys: PushSubscriptionKeys {
                p256dh: "test-p256dh".to_string(),
                auth: "test-auth".to_string(),
            },
        };

        let result = store.add(sub).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_push_store_subscription_limit() {
        let store = PushStore::new();

        // Add MAX_SUBSCRIPTIONS subscriptions
        for i in 0..MAX_SUBSCRIPTIONS {
            let sub = PushSubscription {
                endpoint: format!("https://fcm.googleapis.com/push/{}", i),
                keys: PushSubscriptionKeys {
                    p256dh: "test-p256dh".to_string(),
                    auth: "test-auth".to_string(),
                },
            };
            store.add(sub).await.unwrap();
        }

        assert_eq!(store.count().await, MAX_SUBSCRIPTIONS);

        // Adding one more should fail
        let sub = PushSubscription {
            endpoint: "https://fcm.googleapis.com/push/extra".to_string(),
            keys: PushSubscriptionKeys {
                p256dh: "test-p256dh".to_string(),
                auth: "test-auth".to_string(),
            },
        };
        let result = store.add(sub).await;
        assert!(result.is_err());
        assert_eq!(store.count().await, MAX_SUBSCRIPTIONS);
    }

    #[test]
    fn test_valid_push_endpoints() {
        // Valid endpoints
        assert!(is_valid_push_endpoint("https://fcm.googleapis.com/fcm/send/abc"));
        assert!(is_valid_push_endpoint("https://push.services.mozilla.com/wpush/v1/xyz"));
        assert!(is_valid_push_endpoint("https://push.apple.com/abc"));
        assert!(is_valid_push_endpoint("https://updates.push.services.mozilla.com/wpush/v2/test"));

        // Invalid endpoints
        assert!(!is_valid_push_endpoint("https://evil.com/push/123"));
        assert!(!is_valid_push_endpoint("http://fcm.googleapis.com/push/123")); // HTTP not HTTPS
        assert!(!is_valid_push_endpoint("https://notfcm.googleapis.com/push/123"));
        assert!(!is_valid_push_endpoint("not-a-url"));
    }
}
