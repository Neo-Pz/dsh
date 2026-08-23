//! Delegation grant — the P2 "user authorizes an agent" layer (DESIGN.md §3).
//!
//! P1 answered "who wrote this" (did:key identity + request signing). P2
//! answers "may this agent act ON BEHALF of this human, and to what extent":
//! a human signs a grant that names an agent as delegate, scoped to a set of
//! capabilities, a budget, an expiry, and a trust LEVEL (L0–L3).
//!
//! ```text
//! human (did:key, offline) ──sign grant──▶ ua (agent did:key)
//!   "ua may act for me: scope X, budget ¥Y, until 2026-12-31, level L2"
//! ua presents { action, grant_ref, grant } — ifo verifies:
//!   ua signature (P1) + grant signature (P2) + scope/budget/level/expiry
//! ```
//!
//! This is the machine-verifiable "authorization is present" record. It uses
//! the SAME Ed25519 trust root as P1; it never introduces a chain or a
//! wallet. Level semantics (who is allowed to say "yes") live in `level`.
//!
//! # V20 hardening (P2-GRANT-PROTOCOL §5, §6)
//!
//! Beyond the V19 fields, a grant now declares a **signature-root strength**
//! (`issuer_root`, §1.2) so a weak root (H1 = agent-custodial) can never
//! mint an L1+ grant, a **declarative capability set** (`capabilities` +
//! `deny`, §3) so the technical scope is portable and namespace-prefixed,
//! and a **check-at-use revocation registry** (Reg-L, §6.2) consulted at
//! decision time rather than by revoke-broadcast. A weak root may be lifted
//! by an explicit `root_ack` — but only one signed by an H2+ root (§1.3),
//! so "a low root cannot self-elevate".
//!
//! Additive fields use `skip_serializing_if` so a V19 grant (which lacks
//! them) still canonicalizes to identical bytes and keeps a valid
//! `grant_id` — the protocol change is strictly cumulative.

use ed25519_dalek::SigningKey;
use serde_json::Value;

use crate::identity::did_key::{sign, DidKey};

/// Human-readable business-scope names inside a grant (deprecated alias).
///
/// V20 splits the old `scope` into a *technical* `capabilities` set and a
/// *semantic* `business_scope`. `scope` is retained as the deprecated alias
/// of `business_scope` for backward compatibility, and doubles as the
/// technical fallback when `capabilities` is absent (a V19 grant).
pub type Scope = Vec<String>;

/// Default revocation-propagation grace window (seconds). Used when a grant
/// does not declare its own `revocation_grace`; it is the tolerance for a
/// registry to sync, never a license to keep acting (§6.2).
pub const DEFAULT_REVOCATION_GRACE: u64 = 60;

/// Authorization LEVEL (DESIGN.md §3.3). Higher = more consequential.
///
/// L0 routine dialogue/quote/progress — pre-authorized.
/// L1 transaction (accept offer, small deposit) — auto within grant scope.
/// L2 contract (confirm bill, accept settlement, accept terms) — grant + an
///    explicit authorization flag.
/// L3 major (large payment, long-term mandate, liability, legal) — the HUMAN
///    must authorize in person; an agent may only REQUEST, never consent.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum Level {
    L0,
    L1,
    L2,
    L3,
}

impl Level {
    pub fn parse(s: &str) -> Result<Self, String> {
        match s.to_uppercase().as_str() {
            "L0" | "0" => Ok(Level::L0),
            "L1" | "1" => Ok(Level::L1),
            "L2" | "2" => Ok(Level::L2),
            "L3" | "3" => Ok(Level::L3),
            _ => Err(format!("invalid level: {s}")),
        }
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            Level::L0 => "L0",
            Level::L1 => "L1",
            Level::L2 => "L2",
            Level::L3 => "L3",
        }
    }
}

/// The signature-root form of the *issuer* (P2-GRANT-PROTOCOL §1.2).
///
/// The strength of the root bounds how strong a grant the issuer may mint:
///   H1 `agent-custodial` (key held by the agent) → L0 only.
///   H2 `webauthn` / `hwkey` (key held by a user authenticator) → L2.
///   H3 `ca` / `kyc` (real-identity chain) → L3.
#[derive(Clone, Debug, Default, serde::Serialize, serde::Deserialize)]
pub struct RootStrength {
    /// Root kind: `agent-custodial` | `webauthn` | `hwkey` | `ca` | `kyc`.
    #[serde(default)]
    pub kind: String,
    /// Optional WebAuthn attestation / certificate chain (base64url).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attestation: Option<String>,
    /// Optional trusted-identity reference (H3 only).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kyc_ref: Option<String>,
    /// Capability of the specific credential, for rotation/revocation.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key_ref: Option<String>,
}

impl RootStrength {
    /// True when the root was not declared (legacy grant).
    pub fn is_empty(&self) -> bool {
        self.kind.is_empty()
    }

    /// The strongest level this root can authorize on its own.
    pub fn max_level(&self) -> Level {
        max_level_for_root(&self.kind)
    }
}

/// One technical capability in the grant scope (P2-GRANT-PROTOCOL §3).
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct Capability {
    /// Namespace-prefixed capability ID, e.g. `iflow.cap:fs.read`.
    pub id: String,
    /// Optional runtime-specific limits (maxBytes, maxCalls, maxDurationSec…).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limits: Option<Value>,
}

/// An explicit H2+ signature-root confirmation that lifts a weak-root grant
/// (P2-GRANT-PROTOCOL §1.3, ruling #1). "A low root cannot self-elevate": the
/// `ack_root` must itself be H2+, `ack_level` must be within that root's cap,
/// and `signature` must verify against the `setter` did:key.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct RootAck {
    pub ack_level: Level,
    pub ack_root: RootStrength,
    pub setter: DidKey,
    pub signature: String,
}

/// The unsigned grant body — what the human attests.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct GrantBody {
    /// The human (issuer) did:key.
    pub issuer: DidKey,
    /// Issuer subject kind (`agent` | `human`); empty = unknown/legacy.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub issuer_kind: String,
    /// Issuer signature-root strength (bounds the grant level).
    #[serde(default, skip_serializing_if = "RootStrength::is_empty")]
    pub issuer_root: RootStrength,
    /// The agent (delegate) did:key this grant authorizes.
    pub delegate: DidKey,
    /// Declarative technical capability set (cross-runtime portable).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub capabilities: Vec<Capability>,
    /// Explicitly-denied capability IDs (take priority over `capabilities`).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub deny: Vec<String>,
    /// Semantic business/scope label (not technically enforced).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub business_scope: Scope,
    /// Deprecated alias of `business_scope`; also the technical fallback for
    /// V19 grants that carry no `capabilities`.
    #[serde(default)]
    pub scope: Scope,
    /// Budget cap in the smallest unit; `None` = no budget bound (L0/L3 use).
    #[serde(default)]
    pub budget: Option<u64>,
    /// Unix seconds after which the grant is void.
    pub expires_at: u64,
    /// Authorization level of the most consequential action permitted.
    pub level: Level,
    /// Revocation-propagation tolerance (seconds); `0` = use the default.
    #[serde(default, skip_serializing_if = "u64_is_zero")]
    pub revocation_grace: u64,
    /// `grant_id` of the grant this one transparently renews (if any).
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub renews: String,
    /// Human label for the grant (e.g. "daily ops").
    #[serde(default)]
    pub label: String,
    /// Created-at unix seconds.
    pub created_at: u64,
    /// Fresh challenge bound to the signing moment (anti-replay, L2/L3).
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub nonce: String,
    /// Optional H2+ root-confirmation lifting a weak root.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub root_ack: Option<RootAck>,
}

/// A signed delegation grant. `body` is the canonical JSON; `signature` is
/// the human's Ed25519 signature over `body`'s canonical (sorted-key) bytes.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct DelegationGrant {
    pub body: GrantBody,
    pub signature: String,
    /// Hash of the canonical body — the stable grant reference (`grant_ref`).
    pub grant_id: String,
}

impl GrantBody {
    /// Canonical bytes for signing: sorted-key JSON so verification is stable
    /// across writers (same approach as AgentCard signing).
    pub fn canonical(&self) -> Vec<u8> {
        let v = serde_json::to_value(self).unwrap_or(Value::Null);
        serde_json::to_vec(&sort_json(&v)).unwrap_or_default()
    }

    /// SHA-256 hex of the canonical body (stable grant id).
    pub fn id(&self) -> String {
        crate::signing::sha256_hex(&self.canonical())
    }
}

/// Sort a JSON value's object keys recursively (deterministic canonical form).
fn sort_json(v: &Value) -> Value {
    match v {
        Value::Object(map) => {
            let mut sorted: Vec<(String, Value)> = map
                .iter()
                .map(|(k, val)| (k.clone(), sort_json(val)))
                .collect();
            sorted.sort_by(|a, b| a.0.cmp(&b.0));
            Value::Object(sorted.into_iter().collect())
        }
        Value::Array(items) => Value::Array(items.iter().map(sort_json).collect()),
        other => other.clone(),
    }
}

/// `true` when a field is zero — used to omit zero-valued optional fields from
/// the canonical form so a grant that did not set them keeps a stable id.
fn u64_is_zero(v: &u64) -> bool {
    *v == 0
}

/// Extra, additive fields a grant builder may set beyond the V19 basics.
#[derive(Clone, Debug, Default)]
pub struct GrantSpec {
    pub issuer_kind: String,
    pub issuer_root: RootStrength,
    pub capabilities: Vec<Capability>,
    pub deny: Vec<String>,
    pub business_scope: Scope,
    pub revocation_grace: u64,
    pub renews: String,
    pub nonce: String,
    pub root_ack: Option<RootAck>,
}

/// Build and sign a grant with the issuer's signing key. Convenience wrapper
/// seeding a [`GrantSpec::default`] (no root strength, no capabilities) —
/// equivalent to a V19 grant.
pub fn build_grant(
    signing: &SigningKey,
    issuer: &DidKey,
    delegate: &DidKey,
    scope: Scope,
    budget: Option<u64>,
    expires_at: u64,
    level: Level,
    label: &str,
    created_at: u64,
) -> DelegationGrant {
    build_grant_full(
        signing,
        issuer,
        delegate,
        scope,
        budget,
        expires_at,
        level,
        label,
        created_at,
        GrantSpec::default(),
    )
}

/// Build and sign a grant with the full [`GrantSpec`] (root strength,
/// capabilities, deny, root_ack, nonce, renewal chain, revocation grace).
pub fn build_grant_full(
    signing: &SigningKey,
    issuer: &DidKey,
    delegate: &DidKey,
    scope: Scope,
    budget: Option<u64>,
    expires_at: u64,
    level: Level,
    label: &str,
    created_at: u64,
    spec: GrantSpec,
) -> DelegationGrant {
    let body = GrantBody {
        issuer: issuer.clone(),
        issuer_kind: spec.issuer_kind,
        issuer_root: spec.issuer_root,
        delegate: delegate.clone(),
        capabilities: spec.capabilities,
        deny: spec.deny,
        business_scope: spec.business_scope,
        scope,
        budget,
        expires_at,
        level,
        revocation_grace: spec.revocation_grace,
        renews: spec.renews,
        label: label.to_string(),
        created_at,
        nonce: spec.nonce,
        root_ack: spec.root_ack,
    };
    let canon = body.canonical();
    let sig = sign(signing, &canon);
    let grant_id = body.id();
    DelegationGrant {
        body,
        signature: hex(&sig),
        grant_id,
    }
}

/// Verify a grant's signature against its ISSUER did.
pub fn verify_grant_signature(grant: &DelegationGrant) -> Result<(), String> {
    let canon = grant.body.canonical();
    let sig_bytes = decode_hex(&grant.signature)
        .ok_or_else(|| "grant signature is not valid hex".to_string())?;
    let sig: [u8; 64] = sig_bytes
        .try_into()
        .map_err(|_| "grant signature is not 64 bytes".to_string())?;
    grant.body.issuer.verify(&canon, &sig)
}

/// Recompute and check the grant_id matches the canonical body.
pub fn check_grant_id(grant: &DelegationGrant) -> Result<(), String> {
    let recomputed = grant.body.id();
    if recomputed != grant.grant_id {
        return Err(format!("grant_id mismatch: expected {recomputed}, got {}", grant.grant_id));
    }
    Ok(())
}

/// Result of a full delegation check (who, scope, level, time).
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct GrantDecision {
    pub ok: bool,
    pub level: String,
    pub reason: Option<String>,
}

/// The strongest level a given signature-root kind may authorize.
fn max_level_for_root(kind: &str) -> Level {
    match kind {
        "webauthn" | "hwkey" => Level::L2,
        "ca" | "kyc" => Level::L3,
        // agent-custodial — and any unknown/absent root — cap at L0
        // (fail-closed): a weak or undeclared root must not mint L1+.
        _ => Level::L0,
    }
}

/// The canonical bytes over which a [`RootAck`]'s signer signs (excludes the
/// signature itself, so the signature never signs its own placeholder).
fn ack_canonical(ack: &RootAck) -> Vec<u8> {
    let mut v = serde_json::to_value(ack).unwrap_or(Value::Null);
    if let Value::Object(map) = &mut v {
        map.remove("signature");
    }
    serde_json::to_vec(&sort_json(&v)).unwrap_or_default()
}

/// Verify a root_ack: its ack_root must be H2+ (L2 cap or better), ack_level
/// must be within that cap, and the ack signature must verify against the
/// ack setter's did:key. Returns the level the ack actually confirms.
pub fn verify_root_ack(ack: &RootAck) -> Result<Level, String> {
    let ack_cap = ack.ack_root.max_level();
    if ack.ack_level > ack_cap {
        return Err(format!(
            "root_ack root {:?} caps at {:?}, cannot ack {:?}",
            ack.ack_root.kind, ack_cap, ack.ack_level
        ));
    }
    let canon = ack_canonical(ack);
    let sig_bytes = decode_hex(&ack.signature)
        .ok_or_else(|| "root_ack signature is not valid hex".to_string())?;
    let sig: [u8; 64] = sig_bytes
        .try_into()
        .map_err(|_| "root_ack signature is not 64 bytes".to_string())?;
    ack.setter.verify(&canon, &sig)?;
    Ok(ack.ack_level)
}

/// True if `id` is a well-formed namespace-prefixed capability ID (§3.2).
///
/// Accepts `*` (all), `iflow.cap:<domain>.<op>` (e.g. `iflow.cap:fs.read`),
/// and the namespace wildcard `iflow.cap:<domain>.*`. No bare free-form IDs;
/// admission of new IDs is governed by the community registry (ruling #2).
pub fn valid_capability_id(id: &str) -> bool {
    if id == "*" {
        return true;
    }
    let Some(rest) = id.strip_prefix("iflow.cap:") else {
        return false;
    };
    let seg = rest.strip_suffix(".*").unwrap_or(rest);
    if seg.is_empty() {
        return false;
    }
    seg.split('.').all(|part| {
        !part.is_empty()
            && part.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-' || b == b'_')
    })
}

/// Match an action against a capability pattern (exact, namespace-prefix, or
/// `ns.*`/`*` wildcard). A bare prefix matches only on a `.`/`:` boundary, so
/// `iflow.cap:fs` does not match `iflow.cap:fsx`.
fn capability_matches(pattern: &str, action: &str) -> bool {
    if pattern == "*" || pattern == action {
        return true;
    }
    if let Some(prefix) = pattern.strip_suffix(".*") {
        return action.starts_with(prefix) && action.len() > prefix.len();
    }
    if action.starts_with(pattern) && action.len() > pattern.len() {
        let next = action.as_bytes()[pattern.len()];
        return next == b'.' || next == b':';
    }
    false
}

/// Full verification of a grant for a specific action, at `now`.
///
/// Order: signature → id → expiry → root-strength → level → scope.
/// (Budget and revocation are layered on by [`evaluate_with_budget`] and
/// [`evaluate_full`] respectively.)
pub fn evaluate(
    grant: &DelegationGrant,
    action_scope: &str,
    required_level: Level,
    now: u64,
) -> GrantDecision {
    if let Err(e) = verify_grant_signature(grant) {
        return reject("grant signature invalid", &grant.body.level, &e);
    }
    if let Err(e) = check_grant_id(grant) {
        return reject("grant_id mismatch", &grant.body.level, &e);
    }
    if now > grant.body.expires_at {
        return reject("grant expired", &grant.body.level, &String::new());
    }
    // Root strength bounds the grant's own declared level (§5 step 5). A weak
    // or undeclared root may be lifted only by a valid H2+ root_ack.
    let mut cap = grant.body.issuer_root.max_level();
    if let Some(ack) = &grant.body.root_ack {
        match verify_root_ack(ack) {
            // The ack confirms the level, and the ack root itself caps the lift.
            Ok(ack_level) => cap = cap.max(ack_level),
            Err(e) => return reject("root_ack invalid", &grant.body.level, &e),
        }
    }
    if grant.body.level > cap {
        return reject(
            "ROOT_TOO_WEAK_FOR_LEVEL",
            &grant.body.level,
            &format!(
                "issuer_root {:?} caps at {:?}; grant level is {:?}",
                grant.body.issuer_root.kind, cap, grant.body.level
            ),
        );
    }
    if grant.body.level < required_level {
        return reject(
            "grant level too low",
            &grant.body.level,
            &format!("need {required_level:?}, grant is {:?}", grant.body.level),
        );
    }
    if !action_scope.is_empty() {
        // `deny` takes priority over any allow.
        if !grant.body.deny.is_empty()
            && grant.body.deny.iter().any(|d| capability_matches(d, action_scope))
        {
            return reject(
                "OUT_OF_SCOPE (deny)",
                &grant.body.level,
                &format!("action '{action_scope}' matches a deny entry {:?}", grant.body.deny),
            );
        }
        let granted = if !grant.body.capabilities.is_empty() {
            grant.body.capabilities.iter().any(|c| capability_matches(&c.id, action_scope))
        } else if !grant.body.scope.is_empty() {
            grant.body.scope.iter().any(|s| capability_matches(s, action_scope))
        } else {
            // No technical scope declared → baseline agent.run only (§3.2).
            capability_matches("iflow.cap:agent.run", action_scope)
        };
        if !granted {
            return reject(
                "OUT_OF_SCOPE",
                &grant.body.level,
                &format!(
                    "action '{action_scope}' not covered by grant scope (capabilities {:?}, legacy scope {:?})",
                    grant.body.capabilities.iter().map(|c| c.id.clone()).collect::<Vec<_>>(),
                    grant.body.scope
                ),
            );
        }
    }
    GrantDecision { ok: true, level: grant.body.level.as_str().to_string(), reason: None }
}

/// Like [`evaluate`], but also enforces the grant's budget cap.
///
/// `spent` is the budget already consumed under this grant; `action_cost` is
/// the cost of the action about to run. If the grant declares a budget and
/// `spent + action_cost > budget`, the action is REJECTED with REASON_EXCEEDS.
/// Grants without a budget (Option::None) enforce nothing here.
pub fn evaluate_with_budget(
    grant: &DelegationGrant,
    action_scope: &str,
    required_level: Level,
    now: u64,
    spent: f64,
    action_cost: f64,
) -> GrantDecision {
    let base = evaluate(grant, action_scope, required_level, now);
    if !base.ok {
        return base;
    }
    if let Some(budget) = grant.body.budget {
        let budget_f = budget as f64;
        if spent > budget_f || (spent + action_cost) > budget_f {
            return reject(
                "grant budget exceeded",
                &grant.body.level,
                &format!("spent {spent:.8} + cost {action_cost:.8} > budget {budget_f:.8}"),
            );
        }
    }
    GrantDecision { ok: true, level: grant.body.level.as_str().to_string(), reason: None }
}

// ── Check-at-use revocation registry (Reg-L, §6.2) ──────────────────────────

/// One revocation record in the local (Reg-L) registry.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct RevocationEntry {
    pub grant_id: String,
    pub revoke_time: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub revoke_root: Option<String>,
}

/// The local revocation registry. Reg-C (chain/consensus) entries are synced
/// into this list asynchronously; the check-at-use rule consults only what the
/// local node already believes is revoked, so a not-yet-synced Reg-C revoke is
/// simply not seen (and a seen one always takes effect).
#[derive(Clone, Debug, Default, serde::Serialize, serde::Deserialize)]
pub struct RevocationRegistry {
    #[serde(default)]
    pub entries: Vec<RevocationEntry>,
}

/// The verdict for a grant at decision time against the registry.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RevokeVerdict {
    /// `now < revoke_time` — not yet in effect; allow.
    NotRevoked,
    /// `revoke_time <= now <= effective_revoke` — the grace window: L0 may
    /// still act (with a recorded warning); L1+ is refused.
    Grace,
    /// `now > effective_revoke` — refused regardless of level.
    Revoked,
}

/// The registry file under a given node home.
///
/// Pure on purpose: where "the node" is, is the caller's business. A path
/// builder that reads the environment can only be tested by mutating global
/// state, which races every other test in the process.
pub fn registry_path_in(node_home: &std::path::Path) -> std::path::PathBuf {
    node_home.join(".iflow").join("revocations.json")
}

/// The registry file location: `<node-home>/.iflow/revocations.json`.
///
/// Deliberately NOT per-identity. One machine now holds several keys — a
/// principal plus one per declared agent — and a revocation that only applied
/// to the key that recorded it would be trivially defeated by acting as
/// another agent on the same machine. A revocation is a statement about a
/// grant, not about a signer.
pub fn registry_path() -> std::path::PathBuf {
    registry_path_in(std::path::Path::new(&crate::node_home()))
}

/// Load the local revocation registry (empty when the file is absent).
pub fn load_registry() -> Result<RevocationRegistry, String> {
    let path = registry_path();
    if !path.exists() {
        return Ok(RevocationRegistry::default());
    }
    let text = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    serde_json::from_str(&text).map_err(|e| e.to_string())
}

/// Persist the local revocation registry.
pub fn save_registry(reg: &RevocationRegistry) -> Result<(), String> {
    let path = registry_path();
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(reg).map_err(|e| e.to_string())?;
    std::fs::write(&path, json).map_err(|e| e.to_string())
}

/// Append a revocation to the local registry (idempotent by grant_id).
pub fn record_revoke(grant_id: &str, revoke_time: u64, revoke_root: Option<&str>) -> Result<(), String> {
    let mut reg = load_registry()?;
    if !reg.entries.iter().any(|e| e.grant_id == grant_id) {
        reg.entries.push(RevocationEntry {
            grant_id: grant_id.to_string(),
            revoke_time,
            revoke_root: revoke_root.map(|s| s.to_string()),
        });
        save_registry(&reg)?;
    }
    Ok(())
}

/// The revocation verdict for `grant_id` at `now`, within `grace` seconds.
pub fn revocation_verdict(
    registry: &RevocationRegistry,
    grant_id: &str,
    now: u64,
    grace: u64,
) -> RevokeVerdict {
    if let Some(entry) = registry.entries.iter().find(|e| e.grant_id == grant_id) {
        let effective = entry.revoke_time.saturating_add(grace);
        if now < entry.revoke_time {
            return RevokeVerdict::NotRevoked;
        }
        if now <= effective {
            return RevokeVerdict::Grace;
        }
        return RevokeVerdict::Revoked;
    }
    RevokeVerdict::NotRevoked
}

/// Like [`evaluate_with_budget`], but for the check-at-use path — consults the
/// revocation registry at decision time. This is the function `grant eval`
/// uses; `grant verify` stays pure (signature + id).
pub fn evaluate_full(
    grant: &DelegationGrant,
    action_scope: &str,
    required_level: Level,
    now: u64,
    spent: f64,
    action_cost: f64,
    registry: &RevocationRegistry,
) -> GrantDecision {
    let base = evaluate_with_budget(grant, action_scope, required_level, now, spent, action_cost);
    if !base.ok {
        return base;
    }
    let grace = if grant.body.revocation_grace == 0 {
        DEFAULT_REVOCATION_GRACE
    } else {
        grant.body.revocation_grace
    };
    match revocation_verdict(registry, &grant.grant_id, now, grace) {
        RevokeVerdict::Revoked => reject(
            "REVOKED",
            &grant.body.level,
            &format!("grant {} was revoked at decision time", grant.grant_id),
        ),
        RevokeVerdict::Grace => {
            // In the grace window the grant is semantically revoked: L0 may
            // finish (warned); L1+ is refused (fail-closed).
            if grant.body.level >= Level::L1 {
                reject(
                    "REVOKED (grace window)",
                    &grant.body.level,
                    &format!("grant {} revoked; within revocation_grace", grant.grant_id),
                )
            } else {
                GrantDecision {
                    ok: true,
                    level: grant.body.level.as_str().to_string(),
                    reason: Some("revoked-grace: L0 allowed within revocation_grace".to_string()),
                }
            }
        }
        RevokeVerdict::NotRevoked => {
            GrantDecision { ok: true, level: grant.body.level.as_str().to_string(), reason: None }
        }
    }
}

fn reject(reason: &str, level: &Level, detail: &str) -> GrantDecision {
    GrantDecision {
        ok: false,
        level: level.as_str().to_string(),
        reason: Some(if detail.is_empty() { reason.to_string() } else { format!("{reason}: {detail}") }),
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn decode_hex(s: &str) -> Option<Vec<u8>> {
    if s.len() % 2 != 0 {
        return None;
    }
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).ok())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::identity::did_key::generate;

    fn h2_root() -> RootStrength {
        RootStrength { kind: "hwkey".to_string(), ..Default::default() }
    }

    /// A revocation must bind the machine, not the key that recorded it.
    ///
    /// One node now holds several identities — a principal plus one key per
    /// declared agent, each in its own `--home`. The registry used to live
    /// beside the identity, so a grant revoked while acting as one agent was
    /// still honoured while acting as another, on the same machine. That is not
    /// a revocation; it is a suggestion.
    #[test]
    fn revocation_registry_is_node_wide_not_per_identity() {
        let node = std::path::Path::new("/machine");
        let agent_a = node.join("agents").join("a");
        let agent_b = node.join("agents").join("b");

        // Two identities on one machine resolve to one registry.
        assert_eq!(registry_path_in(node), registry_path_in(node));
        assert_ne!(registry_path_in(node), registry_path_in(&agent_a));
        assert_ne!(registry_path_in(&agent_a), registry_path_in(&agent_b));

        // And it lives under the node, never under a key.
        let registry = registry_path_in(node);
        assert!(registry.starts_with(node));
        assert!(!registry.starts_with(&agent_a));
        assert!(registry.ends_with("revocations.json"));
    }

    #[test]
    fn grant_roundtrip_verify() {
        let (human, human_key) = generate();
        let (agent, _) = generate();
        // L1 grant under an H2 root (H1/absent root would cap at L0).
        let spec = GrantSpec {
            issuer_kind: "human".to_string(),
            issuer_root: h2_root(),
            ..Default::default()
        };
        let grant = build_grant_full(
            &human_key,
            &human,
            &agent,
            vec!["dialogue".into(), "quote".into()],
            Some(1000),
            2_000_000_000,
            Level::L1,
            "daily ops",
            1_700_000_000,
            spec,
        );
        assert!(verify_grant_signature(&grant).is_ok());
        assert!(check_grant_id(&grant).is_ok());
        // L1 action in scope, before expiry → ok
        let d = evaluate(&grant, "quote", Level::L0, 1_700_000_000);
        assert!(d.ok, "expected ok, got {:?}", d.reason);
        // action outside scope → reject
        let d2 = evaluate(&grant, "pay", Level::L0, 1_700_000_000);
        assert!(!d2.ok);
        // level too high for grant → reject
        let d3 = evaluate(&grant, "dialogue", Level::L3, 1_700_000_000);
        assert!(!d3.ok);
        // expired → reject
        let d4 = evaluate(&grant, "dialogue", Level::L0, 2_000_000_001);
        assert!(!d4.ok);
    }

    #[test]
    fn tampered_grant_fails() {
        let (human, human_key) = generate();
        let (agent, _) = generate();
        let (attacker, _) = generate();
        let mut grant = build_grant(
            &human_key,
            &human,
            &agent,
            vec!["dialogue".into()],
            None,
            2_000_000_000,
            Level::L0,
            "test",
            1_700_000_000,
        );
        // tamper: swap the delegate to an attacker did (must fail signature)
        grant.body.delegate = attacker.clone();
        assert!(verify_grant_signature(&grant).is_err());
        // tamper: widen scope to "pay" (must fail signature)
        grant.body.delegate = agent.clone();
        grant.body.scope = vec!["pay".into()];
        assert!(verify_grant_signature(&grant).is_err());
    }

    #[test]
    fn level_ordering() {
        assert!(Level::L2 > Level::L0);
        assert!(Level::L3 > Level::L2);
        assert_eq!(Level::parse("L1").unwrap(), Level::L1);
        assert_eq!(Level::parse("2").unwrap(), Level::L2);
        assert!(Level::parse("L9").is_err());
    }

    #[test]
    fn budget_enforced() {
        let (human, human_key) = generate();
        let (agent, _) = generate();
        // budget 1000, under an H2 root so an L1 grant is allowed.
        let spec = GrantSpec { issuer_root: h2_root(), ..Default::default() };
        let grant = build_grant_full(
            &human_key,
            &human,
            &agent,
            vec!["dialogue".into()],
            Some(1000),
            2_000_000_000,
            Level::L1,
            "daily ops",
            1_700_000_000,
            spec,
        );
        // within budget → ok
        let d = evaluate_with_budget(&grant, "dialogue", Level::L0, 1_700_000_000, 0.0, 500.0);
        assert!(d.ok, "expected ok, got {:?}", d.reason);
        // at budget limit (spent exactly budget) → ok for cost 0
        let d2 = evaluate_with_budget(&grant, "dialogue", Level::L0, 1_700_000_000, 1000.0, 0.0);
        assert!(d2.ok);
        // over budget (spent + cost > budget) → reject
        let d3 = evaluate_with_budget(&grant, "dialogue", Level::L0, 1_700_000_000, 600.0, 500.0);
        assert!(!d3.ok, "expected reject, got {:?}", d3.reason);
        // spent already over → reject even with cost 0
        let d4 = evaluate_with_budget(&grant, "dialogue", Level::L0, 1_700_000_000, 1001.0, 0.0);
        assert!(!d4.ok);
    }

    #[test]
    fn no_budget_no_limit() {
        let (human, human_key) = generate();
        let (agent, _) = generate();
        let spec = GrantSpec { issuer_root: h2_root(), ..Default::default() };
        let grant = build_grant_full(
            &human_key,
            &human,
            &agent,
            vec!["dialogue".into()],
            None, // no budget
            2_000_000_000,
            Level::L1,
            "ops",
            1_700_000_000,
            spec,
        );
        let d = evaluate_with_budget(&grant, "dialogue", Level::L0, 1_700_000_000, 1e9, 1e9);
        assert!(d.ok, "no-budget grant must not enforce budget, got {:?}", d.reason);
    }

    #[test]
    fn weak_root_cannot_mint_high_level() {
        let (human, human_key) = generate();
        let (agent, _) = generate();
        // A grant with no issuer_root (legacy) defaults to H1 → L0 cap.
        let grant = build_grant(
            &human_key,
            &human,
            &agent,
            vec!["dialogue".into()],
            None,
            2_000_000_000,
            Level::L1,
            "ops",
            1_700_000_000,
        );
        let d = evaluate(&grant, "dialogue", Level::L0, 1_700_000_000);
        assert!(!d.ok, "H1 root must not mint an L1 grant");
        assert!(d.reason.unwrap().starts_with("ROOT_TOO_WEAK_FOR_LEVEL"));
    }

    #[test]
    fn root_ack_lifts_weak_root() {
        let (human, human_key) = generate();
        let (agent, _) = generate();
        let (h2, h2_key) = generate();
        // H1 grant requesting L2; the H1 body itself is signed by the issuer.
        let mut ack = RootAck {
            ack_level: Level::L2,
            ack_root: h2_root(),
            setter: h2.clone(),
            signature: String::new(),
        };
        let canon = ack_canonical(&ack);
        let sig = crate::identity::did_key::sign(&h2_key, &canon);
        ack.signature = hex(&sig);
        let spec = GrantSpec {
            issuer_kind: "human".to_string(),
            issuer_root: RootStrength { kind: "agent-custodial".to_string(), ..Default::default() },
            capabilities: vec![Capability { id: "iflow.cap:fs.write".into(), limits: None }],
            root_ack: Some(ack),
            ..Default::default()
        };
        let grant = build_grant_full(
            &human_key,
            &human,
            &agent,
            vec![],
            None,
            2_000_000_000,
            Level::L2,
            "lifted",
            1_700_000_000,
            spec,
        );
        // L2 action within capabilities → ok (the ack lifts the H1 root).
        let d = evaluate(&grant, "iflow.cap:fs.write", Level::L0, 1_700_000_000);
        assert!(d.ok, "expected root-ack lift to allow L2, got {:?}", d.reason);
    }

    #[test]
    fn capability_scope_and_deny() {
        let (human, human_key) = generate();
        let (agent, _) = generate();
        let spec = GrantSpec {
            issuer_root: h2_root(),
            capabilities: vec![
                Capability { id: "iflow.cap:fs.read".into(), limits: None },
                Capability { id: "iflow.cap:fs.write".into(), limits: None },
            ],
            deny: vec!["iflow.cap:fs.write".into()],
            ..Default::default()
        };
        let grant = build_grant_full(
            &human_key,
            &human,
            &agent,
            vec![],
            None,
            2_000_000_000,
            Level::L1,
            "fs",
            1_700_000_000,
            spec,
        );
        // deny beats allow → fs.write is refused
        let d = evaluate(&grant, "iflow.cap:fs.write", Level::L0, 1_700_000_000);
        assert!(!d.ok, "deny must override allow");
        assert!(d.reason.unwrap().contains("deny"));
        // allowed capability
        let d2 = evaluate(&grant, "iflow.cap:fs.read", Level::L0, 1_700_000_000);
        assert!(d2.ok, "expected fs.read allowed, got {:?}", d2.reason);
        // unlisted capability → out of scope
        let d3 = evaluate(&grant, "iflow.cap:web.fetch", Level::L0, 1_700_000_000);
        assert!(!d3.ok);
    }

    #[test]
    fn no_scope_grants_baseline_agent_run() {
        let (human, human_key) = generate();
        let (agent, _) = generate();
        let grant = build_grant(
            &human_key,
            &human,
            &agent,
            vec![],
            None,
            2_000_000_000,
            Level::L0,
            "baseline",
            1_700_000_000,
        );
        // No capabilities/scope → only the baseline capability is granted.
        let d = evaluate(&grant, "iflow.cap:agent.run", Level::L0, 1_700_000_000);
        assert!(d.ok, "baseline agent.run must be granted, got {:?}", d.reason);
        let d2 = evaluate(&grant, "iflow.cap:shell.exec", Level::L0, 1_700_000_000);
        assert!(!d2.ok, "unlisted capability must be refused");
    }

    #[test]
    fn revocation_verdict_and_grace() {
        let (human, human_key) = generate();
        let (agent, _) = generate();
        let grant = build_grant(
            &human_key,
            &human,
            &agent,
            vec!["dialogue".into()],
            None,
            2_000_000_000,
            Level::L1,
            "ops",
            1_700_000_000,
        );
        let reg = RevocationRegistry {
            entries: vec![RevocationEntry {
                grant_id: grant.grant_id.clone(),
                revoke_time: 1_700_000_100,
                revoke_root: None,
            }],
        };
        // before revoke_time → NotRevoked
        assert_eq!(
            revocation_verdict(&reg, &grant.grant_id, 1_700_000_050, DEFAULT_REVOCATION_GRACE),
            RevokeVerdict::NotRevoked
        );
        // within grace window → Grace
        assert_eq!(
            revocation_verdict(&reg, &grant.grant_id, 1_700_000_150, DEFAULT_REVOCATION_GRACE),
            RevokeVerdict::Grace
        );
        // after grace → Revoked
        assert_eq!(
            revocation_verdict(&reg, &grant.grant_id, 1_700_000_170, DEFAULT_REVOCATION_GRACE),
            RevokeVerdict::Revoked
        );
        // unknown id → NotRevoked
        assert_eq!(
            revocation_verdict(&reg, "other", 1_700_000_170, DEFAULT_REVOCATION_GRACE),
            RevokeVerdict::NotRevoked
        );
    }

    #[test]
    fn grant_roundtrip_is_backward_compatible() {
        let (human, human_key) = generate();
        let (agent, _) = generate();
        // `build_grant` seeds no new fields; canonical must be stable/valid.
        let grant = build_grant(
            &human_key,
            &human,
            &agent,
            vec!["dialogue".into()],
            None,
            2_000_000_000,
            Level::L0,
            "legacy",
            1_700_000_000,
        );
        assert!(verify_grant_signature(&grant).is_ok());
        assert!(check_grant_id(&grant).is_ok());
    }
}
