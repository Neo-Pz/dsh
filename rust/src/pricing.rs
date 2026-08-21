//! Model pricing — the "how much do these tokens cost" layer for iFlow usage.
//!
//! iFlow is payment-channel-agnostic: cost = tokens × model unit price. The
//! unit price comes from a maintainable `pricing.json` (the deployment's own
//! rate card), NOT from an upstream provider's internal catalog. Structure
//! mirrors pi-ai's `ModelCost` (input/output/cacheRead/cacheWrite) so a
//! deployment that does have pi-ai prices can copy them in, but iFlow never
//! depends on pi-ai (DeepSeek has no price there, verified).
//!
//! Price semantics (all per 1,000,000 tokens, USD):
//!   input     — uncached input tokens (includes reasoning? see model note)
//!   output    — generated output tokens
//!   cacheRead — cache-hit input tokens   (billed separately, discounted)
//!   cacheWrite— cache-miss tokens written to cache (billed, often = input)
//!
//! Tokens are DISJOINT: input is uncached only; cached input is counted as
//! cacheRead/cacheWrite. This matches DSH's TokenUsage contract.

use std::collections::HashMap;
use std::path::PathBuf;

/// Cost buckets for one model, per million tokens.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct ModelPrice {
    /// USD per 1M uncached input tokens.
    pub input: f64,
    /// USD per 1M output tokens.
    pub output: f64,
    /// USD per 1M cache-read (cache-hit) input tokens.
    #[serde(default)]
    pub cache_read: f64,
    /// USD per 1M cache-write (cache-miss stored) input tokens.
    #[serde(default)]
    pub cache_write: f64,
}

impl Default for ModelPrice {
    fn default() -> Self {
        Self { input: 0.0, output: 0.0, cache_read: 0.0, cache_write: 0.0 }
    }
}

impl ModelPrice {
    pub fn total(&self) -> f64 {
        self.input + self.output + self.cache_read + self.cache_write
    }
}

/// The pricing document: `{ "models": { "<id>": ModelPrice }, "source": "..." }`.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct PricingTable {
    #[serde(default)]
    pub models: HashMap<String, ModelPrice>,
    /// Provenance tag for audit (e.g. "deepseek-official-2026-08").
    #[serde(default)]
    pub source: String,
    /// Snapshot timestamp when this table was created/updated.
    #[serde(default)]
    pub updated_at: u64,
}

impl Default for PricingTable {
    fn default() -> Self {
        Self { models: HashMap::new(), source: String::new(), updated_at: 0 }
    }
}

impl PricingTable {
    /// Load from a JSON path, falling back to an empty table on parse error
    /// (so a missing/partial rate card never crashes usage recording).
    pub fn load(path: &PathBuf) -> Self {
        std::fs::read_to_string(path)
            .ok()
            .and_then(|text| serde_json::from_str(&text).ok())
            .unwrap_or_default()
    }

    /// Resolve a model's price; unknown models get the zero table (cost 0,
    /// recorded as such — "no price known" is a fact, not a crash).
    pub fn price(&self, model: &str) -> &ModelPrice {
        self.models.get(model).unwrap_or(&ZERO_PRICE)
    }
}

static ZERO_PRICE: ModelPrice = ModelPrice { input: 0.0, output: 0.0, cache_read: 0.0, cache_write: 0.0 };

// ── cost calculation ───────────────────────────────────────────────────────

/// Token counts (disjoint buckets), matching DSH's TokenUsage.
#[derive(Clone, Debug, Default, serde::Serialize, serde::Deserialize)]
pub struct Tokens {
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_write: u64,
}

impl Tokens {
    pub fn total(&self) -> u64 {
        self.input + self.output + self.cache_read + self.cache_write
    }
}

/// Per-bucket cost breakdown for one usage row.
#[derive(Clone, Debug, Default, serde::Serialize, serde::Deserialize)]
pub struct CostBreakdown {
    pub input_cost: f64,
    pub output_cost: f64,
    pub cache_read_cost: f64,
    pub cache_write_cost: f64,
    pub total_cost: f64,
}

/// Cost = bucket tokens / 1M × bucket price. Uses f64; per 1M prices are
/// quoted to enough digits that summing stays stable at 8 decimals.
pub fn compute_cost(tokens: &Tokens, price: &ModelPrice) -> CostBreakdown {
    let input_cost = tokens.input as f64 / 1_000_000.0 * price.input;
    let output_cost = tokens.output as f64 / 1_000_000.0 * price.output;
    let cache_read_cost = tokens.cache_read as f64 / 1_000_000.0 * price.cache_read;
    let cache_write_cost = tokens.cache_write as f64 / 1_000_000.0 * price.cache_write;
    let total_cost = input_cost + output_cost + cache_read_cost + cache_write_cost;
    CostBreakdown { input_cost, output_cost, cache_read_cost, cache_write_cost, total_cost }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn table() -> PricingTable {
        let mut m = HashMap::new();
        m.insert("deepseek-v4-flash".to_string(), ModelPrice { input: 0.28, output: 0.42, cache_read: 0.014, cache_write: 0.28 });
        PricingTable { models: m, source: "test".into(), updated_at: 1 }
    }

    #[test]
    fn cost_buckets_disjoint_and_summed() {
        let t = table();
        let toks = Tokens { input: 1_000_000, output: 500_000, cache_read: 200_000, cache_write: 100_000 };
        let c = compute_cost(&toks, t.price("deepseek-v4-flash"));
        assert!((c.input_cost - 0.28).abs() < 1e-9);
        assert!((c.output_cost - 0.21).abs() < 1e-9);
        assert!((c.cache_read_cost - 0.0028).abs() < 1e-9);
        assert!((c.cache_write_cost - 0.028).abs() < 1e-9);
        let total = c.input_cost + c.output_cost + c.cache_read_cost + c.cache_write_cost;
        assert!((total - c.total_cost).abs() < 1e-9);
    }

    #[test]
    fn unknown_model_zero_cost_not_crash() {
        let t = table();
        let toks = Tokens { input: 10, output: 5, cache_read: 0, cache_write: 0 };
        let c = compute_cost(&toks, t.price("no-such-model"));
        assert_eq!(c.total_cost, 0.0);
    }

    #[test]
    fn pricing_roundtrip_json() {
        let t = table();
        let json = serde_json::to_string(&t).unwrap();
        let back: PricingTable = serde_json::from_str(&json).unwrap();
        assert!((back.price("deepseek-v4-flash").input - 0.28).abs() < 1e-9);
    }
}
