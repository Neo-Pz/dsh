//! Task usage recording — iFlow's token metering layer (DESIGN §4.2).
//!
//! One `TaskUsage` row = one iFlow task's token consumption, with cost and an
//! idempotency fingerprint so a task replay never double-counts. Data source is
//! DSH's own TokenUsage (per assistant message), NOT a re-implementation: iFlow
//! is a layer, and meter reads what DSH already produced.
//!
//! Economic fields (cost / price_source / fingerprint) are recorded NOW so the
//! P3 economy layer can consume them without re-deriving from history.
//!
//! Persistence is a JSONL append log under `~/.iflow/usage/` — lightweight,
//! no DB, machine-readable, and append-only for auditability. Each line is one
//! JSON `TaskUsage`; aggregation reads the log and folds.

use std::collections::HashMap;
use std::path::PathBuf;

use sha2::{Digest, Sha256};

use crate::pricing::{compute_cost, CostBreakdown, PricingTable, Tokens};

/// One task's recorded usage.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct TaskUsage {
    /// iFlow task id — the idempotency key.
    pub task_id: String,
    /// Initiating agent did:key (who consumed the tokens).
    pub from_did: String,
    /// Model that served the task (e.g. deepseek-v4-flash).
    pub model: String,
    /// Disjoint token buckets (input is uncached only).
    pub tokens: Tokens,
    /// Per-bucket cost + total (USD), from pricing table at record time.
    pub cost: CostBreakdown,
    /// Provenance of the price used (pricing table source tag).
    pub price_source: String,
    /// Idempotency fingerprint: sha256(task_id | model | from_did | total cost).
    pub fingerprint: String,
    /// Unix seconds the task started / ended.
    pub started_at: u64,
    pub ended_at: u64,
    /// Rough task duration in ms (meta; not a trust input).
    pub duration_ms: u64,
}

impl TaskUsage {
    /// Build a usage record, computing cost from the pricing table and stamping
    /// a content fingerprint (deterministic → same task+usage yields same id).
    pub fn record(
        task_id: &str,
        from_did: &str,
        model: &str,
        tokens: Tokens,
        pricing: &PricingTable,
        started_at: u64,
        ended_at: u64,
        duration_ms: u64,
    ) -> Self {
        let price = pricing.price(model);
        let cost = compute_cost(&tokens, price);
        let fingerprint = fingerprint_for(task_id, from_did, model, &tokens, &cost);
        TaskUsage {
            task_id: task_id.to_string(),
            from_did: from_did.to_string(),
            model: model.to_string(),
            tokens,
            cost,
            price_source: pricing.source.clone(),
            fingerprint,
            started_at,
            ended_at,
            duration_ms,
        }
    }
}

/// Deterministic fingerprint over the record's identity + amounts. Two recordings
/// of the same task with the same tokens produce the same fingerprint, so a
/// caller (or the plugin) can reject a replayed write.
pub fn fingerprint_for(task_id: &str, from_did: &str, model: &str, tokens: &Tokens, cost: &CostBreakdown) -> String {
    let raw = format!(
        "{}|{}|{}|{}|{}|{}|{}|{:.8}|{:.8}|{:.8}|{:.8}|{:.8}|{}",
        task_id,
        from_did,
        model,
        tokens.input,
        tokens.output,
        tokens.cache_read,
        tokens.cache_write,
        cost.input_cost,
        cost.output_cost,
        cost.cache_read_cost,
        cost.cache_write_cost,
        cost.total_cost,
        tokens.total(),
    );
    let mut h = Sha256::new();
    h.update(raw.as_bytes());
    hex(&h.finalize())
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

// ── persistence: JSONL append log ───────────────────────────────────────────

/// The usage log location: `~/.iflow/usage/usage.jsonl`. Matches the identity
/// store's home resolution (IFLOW_HOME first, then USERPROFILE/HOME).
pub fn usage_log_path() -> PathBuf {
    let home = std::env::var("IFLOW_HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .or_else(|_| std::env::var("HOME"))
        .unwrap_or_else(|_| ".".to_string());
    PathBuf::from(home).join(".iflow").join("usage").join("usage.jsonl")
}

/// Append one usage row as a JSONL line (creating the dir if needed).
pub fn append(usage: &TaskUsage) -> Result<(), String> {
    let path = usage_log_path();
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let line = serde_json::to_string(usage).map_err(|e| e.to_string())?;
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| e.to_string())?;
    use std::io::Write;
    writeln!(file, "{line}").map_err(|e| e.to_string())?;
    Ok(())
}

/// Append a usage row ONLY if a row with the same fingerprint does not already
/// exist. Returns `Ok(true)` when written, `Ok(false)` when skipped as a
/// duplicate (idempotency protection against task replay double-billing).
pub fn append_if_new(usage: &TaskUsage) -> Result<bool, String> {
    let existing = load_all();
    if existing.iter().any(|r| r.fingerprint == usage.fingerprint) {
        return Ok(false);
    }
    append(usage).map_err(|e| e)?;
    Ok(true)
}

/// Read all usage rows as a vector (skip malformed lines, keep the rest).
pub fn load_all() -> Vec<TaskUsage> {
    let path = usage_log_path();
    let content = match std::fs::read_to_string(&path) {
        Ok(c) => c,
        Err(_) => return Vec::new(),
    };
    content
        .lines()
        .filter(|l| !l.trim().is_empty())
        .filter_map(|l| serde_json::from_str::<TaskUsage>(l).ok())
        .collect()
}

/// Aggregate usage rows into a report.
#[derive(Clone, Debug, Default, serde::Serialize, serde::Deserialize)]
pub struct UsageAggregate {
    pub tasks: u64,
    pub total_input_tokens: u64,
    pub total_output_tokens: u64,
    pub total_cache_read_tokens: u64,
    pub total_cache_write_tokens: u64,
    pub total_tokens: u64,
    pub total_cost: f64,
    pub by_model: HashMap<String, ModelAggregate>,
    pub by_from: HashMap<String, FromAggregate>,
}

#[derive(Clone, Debug, Default, serde::Serialize, serde::Deserialize)]
pub struct ModelAggregate {
    pub tasks: u64,
    pub tokens: u64,
    pub cost: f64,
}

#[derive(Clone, Debug, Default, serde::Serialize, serde::Deserialize)]
pub struct FromAggregate {
    pub tasks: u64,
    pub tokens: u64,
    pub cost: f64,
}

/// Fold all rows into a report. A `from_filter`/`model_filter` of "" means no
/// filter; other values narrow to that did/model.
pub fn aggregate(rows: &[TaskUsage], from_filter: &str, model_filter: &str) -> UsageAggregate {
    let mut out = UsageAggregate::default();
    for r in rows {
        if !from_filter.is_empty() && r.from_did != from_filter { continue; }
        if !model_filter.is_empty() && r.model != model_filter { continue; }
        out.tasks += 1;
        out.total_input_tokens += r.tokens.input;
        out.total_output_tokens += r.tokens.output;
        out.total_cache_read_tokens += r.tokens.cache_read;
        out.total_cache_write_tokens += r.tokens.cache_write;
        out.total_tokens += r.tokens.total();
        out.total_cost += r.cost.total_cost;

        let m = out.by_model.entry(r.model.clone()).or_default();
        m.tasks += 1;
        m.tokens += r.tokens.total();
        m.cost += r.cost.total_cost;

        let f = out.by_from.entry(r.from_did.clone()).or_default();
        f.tasks += 1;
        f.tokens += r.tokens.total();
        f.cost += r.cost.total_cost;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pricing::{ModelPrice, PricingTable};
    use std::collections::HashMap;
    use std::sync::Mutex;

    // Serialize tests that write/read the usage log: they share a process-wide
    // IFLOW_HOME env var, so parallel tests would overwrite each other's dir.
    static USAGE_LOCK: Mutex<()> = Mutex::new(());

    fn pricing() -> PricingTable {
        let mut m = HashMap::new();
        m.insert("deepseek-v4-flash".to_string(), ModelPrice { input: 0.28, output: 0.42, cache_read: 0.014, cache_write: 0.28 });
        PricingTable { models: m, source: "test".into(), updated_at: 1 }
    }

    fn row(task_id: &str, from: &str, model: &str, tokens: Tokens, p: &PricingTable) -> TaskUsage {
        TaskUsage::record(task_id, from, model, tokens, p, 100, 200, 50)
    }

    #[test]
    fn record_computes_cost_and_fingerprint() {
        let p = pricing();
        let toks = Tokens { input: 1_000_000, output: 500_000, cache_read: 0, cache_write: 0 };
        let u = row("t1", "did:a", "deepseek-v4-flash", toks.clone(), &p);
        assert!((u.cost.input_cost - 0.28).abs() < 1e-9);
        assert!((u.cost.output_cost - 0.21).abs() < 1e-9);
        assert_eq!(u.tokens.total(), 1_500_000);
        assert_eq!(u.fingerprint.len(), 64);
        // same inputs → same fingerprint (idempotency)
        let u2 = row("t1", "did:a", "deepseek-v4-flash", toks.clone(), &p);
        assert_eq!(u.fingerprint, u2.fingerprint);
        // different task id → different fingerprint
        let u3 = row("t2", "did:a", "deepseek-v4-flash", toks.clone(), &p);
        assert_ne!(u.fingerprint, u3.fingerprint);
    }

    #[test]
    fn aggregate_folds_correctly() {
        let p = pricing();
        let rows = vec![
            row("t1", "did:a", "deepseek-v4-flash", Tokens { input: 1_000_000, output: 0, cache_read: 0, cache_write: 0 }, &p),
            row("t2", "did:b", "deepseek-v4-flash", Tokens { input: 0, output: 1_000_000, cache_read: 0, cache_write: 0 }, &p),
            row("t3", "did:a", "other-model", Tokens { input: 100, output: 100, cache_read: 0, cache_write: 0 }, &p),
        ];
        let a = aggregate(&rows, "", "");
        assert_eq!(a.tasks, 3);
        assert!((a.total_cost - (0.28 + 0.42 + 0.0)).abs() < 1e-9);
        assert_eq!(a.by_model.len(), 2);
        assert!((a.by_model["deepseek-v4-flash"].cost - 0.70).abs() < 1e-9);
        // filter by from = did:a
        let af = aggregate(&rows, "did:a", "");
        assert_eq!(af.tasks, 2);
        // filter by model
        let am = aggregate(&rows, "", "deepseek-v4-flash");
        assert_eq!(am.tasks, 2);
    }

    #[test]
    fn usage_jsonl_roundtrip() {
        let _guard = USAGE_LOCK.lock().unwrap();
        let dir = std::env::temp_dir().join(format!("iflow-usage-roundtrip-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::env::set_var("IFLOW_HOME", &dir);
        let p = pricing();
        append(&row("t1", "did:a", "deepseek-v4-flash", Tokens { input: 10, output: 5, cache_read: 0, cache_write: 0 }, &p)).unwrap();
        append(&row("t2", "did:b", "deepseek-v4-flash", Tokens { input: 3, output: 2, cache_read: 0, cache_write: 0 }, &p)).unwrap();
        let all = load_all();
        assert_eq!(all.len(), 2);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn append_if_new_dedups() {
        let _guard = USAGE_LOCK.lock().unwrap();
        let dir = std::env::temp_dir().join(format!("iflow-dedup-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::env::set_var("IFLOW_HOME", &dir);
        let p = pricing();
        let r = row("t1", "did:a", "deepseek-v4-flash", Tokens { input: 10, output: 5, cache_read: 0, cache_write: 0 }, &p);
        // first write → true (new)
        assert!(append_if_new(&r).unwrap());
        // same fingerprint again → false (duplicate skipped)
        assert!(!append_if_new(&r).unwrap());
        // different task → true
        let r2 = row("t2", "did:a", "deepseek-v4-flash", Tokens { input: 10, output: 5, cache_read: 0, cache_write: 0 }, &p);
        assert!(append_if_new(&r2).unwrap());
        let all = load_all();
        assert_eq!(all.len(), 2);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
