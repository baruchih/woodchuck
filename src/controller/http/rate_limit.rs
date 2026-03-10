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
