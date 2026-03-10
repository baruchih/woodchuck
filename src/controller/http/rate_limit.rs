//! Simple in-process rate limiting middleware
//!
//! Token bucket rate limiter for write endpoints.
//! Since Woodchuck is a single-user app, we use a global bucket
//! rather than per-IP tracking.

use std::sync::Arc;
use std::time::Instant;

use axum::extract::State;
use axum::http::StatusCode;
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use tokio::sync::Mutex;

/// Rate limiter state
#[derive(Clone)]
pub struct RateLimiter {
    inner: Arc<Mutex<TokenBucket>>,
}

struct TokenBucket {
    tokens: f64,
    max_tokens: f64,
    refill_rate: f64, // tokens per second
    last_refill: Instant,
}

impl RateLimiter {
    /// Create a new rate limiter
    ///
    /// - `max_tokens`: burst capacity
    /// - `refill_rate`: tokens added per second
    pub fn new(max_tokens: f64, refill_rate: f64) -> Self {
        Self {
            inner: Arc::new(Mutex::new(TokenBucket {
                tokens: max_tokens,
                max_tokens,
                refill_rate,
                last_refill: Instant::now(),
            })),
        }
    }

    /// Try to consume one token. Returns true if allowed.
    pub async fn try_acquire(&self) -> bool {
        let mut bucket = self.inner.lock().await;
        let now = Instant::now();
        let elapsed = now.duration_since(bucket.last_refill).as_secs_f64();
        bucket.tokens = (bucket.tokens + elapsed * bucket.refill_rate).min(bucket.max_tokens);
        bucket.last_refill = now;

        if bucket.tokens >= 1.0 {
            bucket.tokens -= 1.0;
            true
        } else {
            false
        }
    }
}

/// Create a rate limiter with no tokens remaining (for testing)
#[cfg(test)]
pub fn new_exhausted(max_tokens: f64, refill_rate: f64) -> RateLimiter {
    RateLimiter {
        inner: Arc::new(Mutex::new(TokenBucket {
            tokens: 0.0,
            max_tokens,
            refill_rate,
            last_refill: Instant::now(),
        })),
    }
}

/// Axum middleware that enforces rate limiting
pub async fn rate_limit_middleware(
    State(limiter): State<RateLimiter>,
    request: axum::extract::Request,
    next: Next,
) -> Response {
    if limiter.try_acquire().await {
        next.run(request).await
    } else {
        (StatusCode::TOO_MANY_REQUESTS, "Rate limit exceeded").into_response()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_acquire_within_burst() {
        let limiter = RateLimiter::new(5.0, 1.0);
        // Should succeed 5 times (burst capacity)
        for _ in 0..5 {
            assert!(limiter.try_acquire().await);
        }
    }

    #[tokio::test]
    async fn test_acquire_exhausted_after_burst() {
        let limiter = RateLimiter::new(3.0, 0.0); // no refill
        assert!(limiter.try_acquire().await);
        assert!(limiter.try_acquire().await);
        assert!(limiter.try_acquire().await);
        // 4th should fail
        assert!(!limiter.try_acquire().await);
    }

    #[tokio::test]
    async fn test_tokens_refill_over_time() {
        let limiter = RateLimiter::new(2.0, 100.0); // 100 tokens/sec
        // Drain all tokens
        assert!(limiter.try_acquire().await);
        assert!(limiter.try_acquire().await);
        assert!(!limiter.try_acquire().await);

        // Wait for refill
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;

        // Should have refilled (~5 tokens, capped at 2)
        assert!(limiter.try_acquire().await);
    }

    #[tokio::test]
    async fn test_tokens_capped_at_max() {
        let limiter = RateLimiter::new(2.0, 1000.0); // very fast refill
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;

        // Should only allow burst capacity (2), not more
        assert!(limiter.try_acquire().await);
        assert!(limiter.try_acquire().await);
        assert!(!limiter.try_acquire().await);
    }

    #[tokio::test]
    async fn test_exhausted_limiter() {
        let limiter = new_exhausted(5.0, 0.0); // no refill
        assert!(!limiter.try_acquire().await);
    }

    #[tokio::test]
    async fn test_clone_shares_state() {
        let limiter = RateLimiter::new(2.0, 0.0);
        let limiter2 = limiter.clone();

        assert!(limiter.try_acquire().await);
        assert!(limiter2.try_acquire().await);
        // Both exhausted now (shared state)
        assert!(!limiter.try_acquire().await);
        assert!(!limiter2.try_acquire().await);
    }
}
