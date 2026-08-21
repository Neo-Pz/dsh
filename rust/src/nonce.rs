//! Replay protection — the P1 "is this the first time" layer (DESIGN.md §2).
//!
//! TTL window (300s) + a sliding-window nonce cache. A request passes when:
//!   timestamp within TTL of now, AND nonce not seen before in the window.

use std::collections::VecDeque;
use std::time::{SystemTime, UNIX_EPOCH};

/// Default time-to-live for a signed request, seconds (DESIGN.md: 300).
pub const DEFAULT_TTL_SECS: u64 = 300;

/// A bounded nonce cache with window eviction.
#[derive(Debug)]
pub struct ReplayGuard {
    ttl_secs: u64,
    seen: VecDeque<(u64, String)>, // (timestamp, nonce)
    max_entries: usize,
}

impl Default for ReplayGuard {
    fn default() -> Self {
        Self::new(DEFAULT_TTL_SECS, 10_000)
    }
}

impl ReplayGuard {
    pub fn new(ttl_secs: u64, max_entries: usize) -> Self {
        Self {
            ttl_secs,
            seen: VecDeque::new(),
            max_entries,
        }
    }

    /// Evaluate one request. Ok(()) means accepted; Err carries the reason.
    pub fn check(&mut self, nonce: &str, timestamp: u64) -> Result<(), String> {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);

        // TTL window: reject too-old and too-future (clock skew tolerance 30s).
        if timestamp + 30 < now {
            return Err("STALE_TIMESTAMP".to_string());
        }
        if timestamp > now + 30 {
            return Err("FUTURE_TIMESTAMP".to_string());
        }
        let cutoff = now.saturating_sub(self.ttl_secs);

        // Drop expired entries from the front (timestamps ascend on insert).
        while let Some(front) = self.seen.front() {
            if front.0 < cutoff {
                self.seen.pop_front();
            } else {
                break;
            }
        }

        // Duplicate nonce within the window → replay.
        if self.seen.iter().any(|(_, n)| n == nonce) {
            return Err("REPLAY_DETECTED".to_string());
        }

        self.seen.push_back((timestamp, nonce.to_string()));
        if self.seen.len() > self.max_entries {
            self.seen.pop_front();
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn now() -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs()
    }

    #[test]
    fn accepts_fresh_once_rejects_replay() {
        let mut g = ReplayGuard::default();
        let t = now();
        assert!(g.check("n1", t).is_ok());
        assert_eq!(g.check("n1", t), Err("REPLAY_DETECTED".to_string()));
        assert!(g.check("n2", t).is_ok());
    }

    #[test]
    fn rejects_stale_and_future() {
        let mut g = ReplayGuard::default();
        assert_eq!(g.check("old", now() - 10_000), Err("STALE_TIMESTAMP".to_string()));
        assert_eq!(g.check("fut", now() + 10_000), Err("FUTURE_TIMESTAMP".to_string()));
    }
}
