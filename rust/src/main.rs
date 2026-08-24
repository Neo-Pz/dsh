//! iFlow trust root (P1 + P2) — `iflow-id` CLI.
//!
//! Zero-chain identity & request-signing reference implementation:
//!   create            generate & persist a did:key identity
//!   show [--json]     print the public identity (never the secret)
//!   sign-blob <file>  detached Ed25519 signature over a file's exact bytes
//!   verify-blob <file> <signature> <did>   verify such a signature
//!   seal <recipient-did> <plaintext-file> <out-file> [aad]  seal for a peer
//!   open <sealed-file> <out-file> [aad]    open an envelope sealed to this node
//!   sign <method> <path> <body>   build a signed request envelope
//!   verify <json>     verify a signed request envelope
//!   agentcard-sign <card.json>    sign an AgentCard (JWS)
//!   agentcard-verify <signed.json> verify a signed AgentCard
//!   replay-check <nonce> <timestamp>   check a request against the window
//!   grant create <delegate> <scope> <level> <expiry> [--budget N] [--label S]
//!        [--capabilities CSV] [--deny CSV] [--root KIND] [--issuer-kind S]
//!        [--nonce S] [--renews GRANT_ID] [--ack-setter DID] [--ack-level LVL] [--ack-root KIND]
//!   grant verify <grant.json>          verify a delegation grant
//!   grant eval <grant.json> <action> <level> <now>   full delegation check (incl. revocation)
//!   grant revoke <grant_id> [--root DID]   record a revocation (Reg-L)
//!   grant status <grant_id>            show the local revocation verdict
//!   usage record <task> <from> <model> <in> <out> [--cache-read N] [--cache-write N] [--duration N]
//!   usage report [--from DID] [--model M]    aggregate usage + cost report

mod agentcard;
mod envelope;
mod grant;
mod identity;
mod nonce;
mod pricing;
mod signing;
mod usage;

use base64::Engine as _;
use std::collections::HashMap;
use std::io::Read;

use agentcard::SignedAgentCard;
use grant::{Capability, GrantSpec, Level, RevokeVerdict, RootAck, RootStrength};
use identity::did_key::DidKey;
use identity::store::{self, STORAGE_PLAINTEXT_DEV, StoredIdentity};

/// Where node-wide state lives: `IFLOW_NODE_HOME`, falling back to the identity
/// home so a single-identity install is unaffected.
pub fn node_home() -> String {
    std::env::var("IFLOW_NODE_HOME")
        .or_else(|_| std::env::var("IFLOW_HOME"))
        .or_else(|_| std::env::var("USERPROFILE"))
        .or_else(|_| std::env::var("HOME"))
        .unwrap_or_else(|_| ".".to_string())
}

fn main() {
    let mut args: Vec<String> = std::env::args().collect();
    // --home <dir> overrides the IDENTITY-store location (IFLOW_HOME) so a
    // sandboxed runtime (e.g. the DSH plugin) can keep ~/.iflow inside its own
    // workspace root. Set as an env var so every module picks it up.
    //
    // --node-home <dir> overrides where NODE-WIDE state lives (IFLOW_NODE_HOME):
    // the revocation registry and the pricing table. These two are not
    // properties of a key.
    //
    // The distinction exists because one machine now holds several identities —
    // a principal plus one key per declared agent, each in its own home. If the
    // revocation registry followed the identity, a grant revoked while acting as
    // one agent would still be honoured while acting as another, on the same
    // machine, which is not a revocation at all. `--node-home` defaults to
    // `--home`, so a single-identity install behaves exactly as before.
    let mut home: Option<String> = None;
    let mut node_home: Option<String> = None;
    let mut i = 1;
    while i < args.len() {
        if args[i] == "--home" && i + 1 < args.len() {
            home = Some(args[i + 1].clone());
            args.remove(i);
            args.remove(i);
        } else if args[i] == "--node-home" && i + 1 < args.len() {
            node_home = Some(args[i + 1].clone());
            args.remove(i);
            args.remove(i);
        } else {
            i += 1;
        }
    }
    if let Some(h) = home.clone() {
        std::env::set_var("IFLOW_HOME", h);
    }
    if let Some(n) = node_home.or(home) {
        std::env::set_var("IFLOW_NODE_HOME", n);
    }
    if args.len() < 2 {
        print_usage();
        std::process::exit(1);
    }
    let result = match args[1].as_str() {
        "create" => cmd_create(&args[2..]),
        "show" => cmd_show(&args[2..]),
        "sign-blob" => cmd_sign_blob(&args[2..]),
        "verify-blob" => cmd_verify_blob(&args[2..]),
        "seal" => cmd_seal(&args[2..]),
        "open" => cmd_open(&args[2..]),
        "sign" => cmd_sign(&args[2..]),
        "sign-file" => cmd_sign_file(&args[2..]),
        "verify" => cmd_verify(&args[2..]),
        "agentcard-sign" => cmd_agentcard_sign(&args[2..]),
        "agentcard-verify" => cmd_agentcard_verify(&args[2..]),
        "replay-check" => cmd_replay_check(&args[2..]),
        "grant" => cmd_grant(&args[2..]),
        "usage" => cmd_usage(&args[2..]),
        "help" | "--help" | "-h" => {
            print_usage();
            Ok(())
        }
        other => Err(format!("unknown command: {other}")),
    };
    match result {
        Ok(()) => {}
        Err(e) => {
            eprintln!("error: {e}");
            std::process::exit(1);
        }
    }
}

fn print_usage() {
    println!(
        "iflow-id — iFlow trust root (P1 + P2)\n\
         \n\
         usage:\n\
         \x20 iflow-id [--home <dir>] [--node-home <dir>] <command> [args...]\n\
         \n\
         \x20 --home <dir>        identity store location (default ~/.iflow)\n\
         \x20 --node-home <dir>   node-wide state: revocations, pricing.\n\
         \x20                     Defaults to --home. Set it when one machine\n\
         \x20                     holds several identities, so a revocation\n\
         \x20                     cannot be sidestepped by signing as another.\n\
         \n\
         commands:\n\
         \x20 create [label]          generate & persist did:key identity\n\
         \x20 show                     show public identity\n\
         \x20 sign <method> <path> <body>\n\
         \x20                              sign a request envelope (JSON out)\n\
         \x20 sign-file <method> <path> <body-file>\n\
         \x20                              sign a request envelope, body read from file\n\
         \x20 verify <envelope.json>   verify a request envelope\n\
         \x20 seal <recipient-did> <plaintext-file> <out-file> [aad]\n\
         \x20                              seal a message so only that peer can read it.\n\
         \x20                              [aad] binds it to its routing metadata, so a\n\
         \x20                              relay cannot redeliver it as another message.\n\
         \x20 open <sealed-file> <out-file> [aad]\n\
         \x20                              open an envelope sealed to this identity\n\
         \x20 agentcard-sign <card.json>\n\
         \x20                              sign an AgentCard (JWS JSON out)\n\
         \x20 agentcard-verify <signed.json>\n\
         \x20                              verify a signed AgentCard\n\
         \x20 replay-check <nonce> <timestamp>\n\
         \x20                              check nonce+timestamp window\n\
         \n\
         delegation grants (P2):\n\
         \x20 grant create <delegate> <scope-csv> <level> <expiry-ts> [--budget N] [--label S]\n\
         \x20      [--capabilities CSV] [--deny CSV] [--root KIND] [--issuer-kind S]\n\
         \x20      [--nonce S] [--renews GRANT_ID] [--ack-setter DID] [--ack-level LVL] [--ack-root KIND]\n\
         \x20      issue a signed delegation grant from the local identity\n\
         \x20 grant verify <grant.json>       verify a grant's signature + id\n\
         \x20 grant eval <grant.json> <action-scope> <level> <now>\n\
         \x20      full check: signature, id, expiry, root-strength, level, scope, budget, revocation\n\
         \x20 grant revoke <grant_id> [--root DID]\n\
         \x20      record a revocation in the local (Reg-L) registry\n\
         \x20 grant status <grant_id>         show the local revocation verdict\n\
         \n\
         token usage (P4):\n\
         \x20 usage record <task> <from> <model> <input> <output> [--cache-read N] [--cache-write N] [--duration N]\n\
         \x20      record one task's token usage + cost (idempotent fingerprint)\n\
         \x20 usage report [--from DID] [--model M]\n\
         \x20      aggregate usage + cost report"
    );
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn cmd_create(args: &[String]) -> Result<(), String> {
    let label = args.first().cloned().unwrap_or_else(|| "agent".to_string());
    if store::load().map_err(|e| e.to_string())?.is_some() {
        return Err("an identity already exists; remove ~/.iflow/identity.json to regenerate".into());
    }
    let (did, signing) = identity::did_key::generate();
    let identity = StoredIdentity {
        did: did.clone(),
        secret_key: signing.to_bytes().to_vec(),
        label: label.clone(),
        created_at: format!("{:?}", std::time::SystemTime::now()),
        storage: STORAGE_PLAINTEXT_DEV.to_string(),
        metadata: HashMap::new(),
    };
    store::save(&identity).map_err(|e| e.to_string())?;
    println!("created identity:");
    println!("  did:      {did}");
    println!("  label:    {label}");
    println!("  storage:  {STORAGE_PLAINTEXT_DEV} (file-protected, ~/.iflow/identity.json)");
    println!("  note:     secret key never leaves this machine");
    Ok(())
}

fn load_identity() -> Result<StoredIdentity, String> {
    store::load()
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "no identity yet; run `iflow-id create` first".to_string())
}

fn cmd_show(args: &[String]) -> Result<(), String> {
    let identity = load_identity()?;

    // Machine-readable output exists so callers stop scraping the human text
    // below with regular expressions — a format nobody promised to keep.
    if args.iter().any(|a| a == "--json") {
        let out = serde_json::json!({
            "did": identity.did,
            "label": identity.label,
            "storage": identity.storage,
            "publicKey": hex(&identity.signing_key()?.verifying_key().to_bytes()),
        });
        println!("{}", serde_json::to_string(&out).map_err(|e| e.to_string())?);
        return Ok(());
    }

    println!("did:      {}", identity.did);
    println!("label:    {}", identity.label);
    println!("created:  {}", identity.created_at);
    println!("storage:  {}", identity.storage);
    println!(
        "public key: {}",
        hex(&identity.signing_key()?.verifying_key().to_bytes())
    );
    Ok(())
}

/// Sign a file's exact bytes, detached.
///
/// Unlike `sign` and `sign-file`, this imposes NO envelope of its own: the
/// caller decides what the bytes mean. That is what an event journal needs —
/// the canonical form of an event is settled by `iflow-protocol`, and the
/// signer must not wrap it in a second, different structure.
fn cmd_sign_blob(args: &[String]) -> Result<(), String> {
    let file = match args {
        [f] => f.clone(),
        _ => return Err("usage: iflow-id sign-blob <file>".into()),
    };
    let bytes = std::fs::read(&file).map_err(|e| format!("cannot read {file}: {e}"))?;
    let identity = load_identity()?;
    let signing = identity.signing_key()?;
    let signature = identity::did_key::sign(&signing, &bytes);
    let out = serde_json::json!({
        "alg": "EdDSA",
        "signerDid": identity.did,
        "signature": agentcard::base64url(&signature),
    });
    println!("{}", serde_json::to_string(&out).map_err(|e| e.to_string())?);
    Ok(())
}

/// Verify a detached signature over a file's exact bytes.
///
/// Exits non-zero on any failure so a caller can branch on the exit code alone,
/// and also prints the verdict as JSON for callers that read stdout.
fn cmd_verify_blob(args: &[String]) -> Result<(), String> {
    let (file, signature, did) = match args {
        [f, s, d] => (f.clone(), s.clone(), d.clone()),
        _ => return Err("usage: iflow-id verify-blob <file> <signature> <did>".into()),
    };
    let bytes = std::fs::read(&file).map_err(|e| format!("cannot read {file}: {e}"))?;
    let raw = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(signature.as_bytes())
        .map_err(|e| format!("signature is not base64url: {e}"))?;
    let sig: [u8; 64] = raw
        .try_into()
        .map_err(|_| "signature must be 64 bytes".to_string())?;

    DidKey(did.clone()).verify(&bytes, &sig)?;
    let out = serde_json::json!({ "ok": true, "signerDid": did });
    println!("{}", serde_json::to_string(&out).map_err(|e| e.to_string())?);
    Ok(())
}

/// Seal a message so only `recipient` can read it.
///
/// Everything travels as files rather than argv: a message body easily exceeds
/// the Windows command-line limit, and the same reasoning already governs
/// `sign-file`. The `aad` is small and routing-only, so it stays an argument.
fn cmd_seal(args: &[String]) -> Result<(), String> {
    let (did, plaintext_file, out_file, aad) = match args {
        [d, p, o] => (d.clone(), p.clone(), o.clone(), String::new()),
        [d, p, o, a] => (d.clone(), p.clone(), o.clone(), a.clone()),
        _ => return Err("usage: iflow-id seal <recipient-did> <plaintext-file> <out-file> [aad]".into()),
    };
    let plaintext =
        std::fs::read(&plaintext_file).map_err(|e| format!("cannot read {plaintext_file}: {e}"))?;
    let sealed = envelope::seal(&DidKey(did.clone()), &plaintext, aad.as_bytes())?;
    std::fs::write(&out_file, &sealed).map_err(|e| format!("cannot write {out_file}: {e}"))?;
    let out = serde_json::json!({
        "ok": true,
        "recipientDid": did,
        "bytes": sealed.len(),
        "path": out_file,
    });
    println!("{}", serde_json::to_string(&out).map_err(|e| e.to_string())?);
    Ok(())
}

/// Open an envelope sealed to this node's identity.
///
/// Exits non-zero when the envelope was not for this identity, was altered, or
/// arrived under different routing metadata than it was sealed with — so a
/// caller can branch on the exit code without parsing anything.
fn cmd_open(args: &[String]) -> Result<(), String> {
    let (sealed_file, out_file, aad) = match args {
        [s, o] => (s.clone(), o.clone(), String::new()),
        [s, o, a] => (s.clone(), o.clone(), a.clone()),
        _ => return Err("usage: iflow-id open <sealed-file> <out-file> [aad]".into()),
    };
    let sealed = std::fs::read(&sealed_file).map_err(|e| format!("cannot read {sealed_file}: {e}"))?;
    let identity = load_identity()?;
    let signing = identity.signing_key()?;
    let plaintext = envelope::open(&signing, &sealed, aad.as_bytes())?;
    std::fs::write(&out_file, &plaintext).map_err(|e| format!("cannot write {out_file}: {e}"))?;
    let out = serde_json::json!({
        "ok": true,
        "recipientDid": identity.did,
        "bytes": plaintext.len(),
        "path": out_file,
    });
    println!("{}", serde_json::to_string(&out).map_err(|e| e.to_string())?);
    Ok(())
}

fn cmd_sign(args: &[String]) -> Result<(), String> {
    let (method, path, body) = match args {
        [m, p, b] => (m.clone(), p.clone(), b.clone()),
        _ => return Err("usage: iflow-id sign <method> <path> <body>".into()),
    };
    let identity = load_identity()?;
    let signing = identity.signing_key()?;
    let nonce = format!("{:x}", rand::random::<u128>());
    let envelope = signing::build(
        &signing,
        &identity.did,
        &method,
        &path,
        body.as_bytes(),
        &nonce,
        now_secs(),
    );
    println!(
        "{}",
        serde_json::to_string_pretty(&envelope).map_err(|e| e.to_string())?
    );
    Ok(())
}

fn cmd_sign_file(args: &[String]) -> Result<(), String> {
    let (method, path, body_file) = match args {
        [m, p, f] => (m.clone(), p.clone(), f.clone()),
        _ => return Err("usage: iflow-id sign-file <method> <path> <body-file>".into()),
    };
    let body = std::fs::read(body_file).map_err(|e| format!("cannot read body file: {e}"))?;
    let identity = load_identity()?;
    let signing = identity.signing_key()?;
    let nonce = format!("{:x}", rand::random::<u128>());
    let envelope = signing::build(
        &signing,
        &identity.did,
        &method,
        &path,
        &body,
        &nonce,
        now_secs(),
    );
    println!(
        "{}",
        serde_json::to_string_pretty(&envelope).map_err(|e| e.to_string())?
    );
    Ok(())
}

fn read_stdin() -> Result<String, String> {
    let mut buf = String::new();
    std::io::stdin()
        .read_to_string(&mut buf)
        .map_err(|e| e.to_string())?;
    Ok(buf.trim().to_string())
}

fn cmd_verify(args: &[String]) -> Result<(), String> {
    let json = if let Some(path) = args.first() {
        std::fs::read_to_string(path).map_err(|e| e.to_string())?
    } else {
        read_stdin()?
    };
    let envelope: signing::SignedRequest =
        serde_json::from_str(&json).map_err(|e| format!("bad envelope json: {e}"))?;
    signing::verify(&envelope)?;
    println!("signature OK (signer: {})", envelope.signer);
    Ok(())
}

fn cmd_agentcard_sign(args: &[String]) -> Result<(), String> {
    let json = if let Some(path) = args.first() {
        std::fs::read_to_string(path).map_err(|e| e.to_string())?
    } else {
        read_stdin()?
    };
    let card: serde_json::Value =
        serde_json::from_str(&json).map_err(|e| format!("bad card json: {e}"))?;
    let identity = load_identity()?;
    let signing = identity.signing_key()?;
    let signed = SignedAgentCard::sign(&card, &signing, &identity.did);
    println!(
        "{}",
        serde_json::to_string_pretty(&signed).map_err(|e| e.to_string())?
    );
    Ok(())
}

fn cmd_agentcard_verify(args: &[String]) -> Result<(), String> {
    let json = if let Some(path) = args.first() {
        std::fs::read_to_string(path).map_err(|e| e.to_string())?
    } else {
        read_stdin()?
    };
    let signed: SignedAgentCard =
        serde_json::from_str(&json).map_err(|e| format!("bad signed card json: {e}"))?;
    let payload = signed.verify_and_payload()?;
    println!("AgentCard signature OK (signer: {})", signed.signer);
    println!(
        "payload: {}",
        serde_json::to_string_pretty(&payload).map_err(|e| e.to_string())?
    );
    Ok(())
}

fn cmd_replay_check(args: &[String]) -> Result<(), String> {
    let (nonce, ts) = match args {
        [n, t] => (
            n.clone(),
            t.parse::<u64>().map_err(|_| "timestamp must be u64")?,
        ),
        _ => return Err("usage: iflow-id replay-check <nonce> <timestamp>".into()),
    };
    // Persistent nonce cache across CLI invocations (~/.iflow/nonces.json).
    let cache_path = identity::store::identity_path()
        .parent()
        .map(|d| d.join("nonces.json"))
        .ok_or_else(|| "cannot locate ~/.iflow".to_string())?;
    let mut seen: Vec<(u64, String)> = if cache_path.exists() {
        serde_json::from_str(&std::fs::read_to_string(&cache_path).map_err(|e| e.to_string())?)
            .unwrap_or_default()
    } else {
        Vec::new()
    };
    let now = now_secs();
    let cutoff = now.saturating_sub(nonce::DEFAULT_TTL_SECS);
    seen.retain(|(t, _)| *t >= cutoff);
    if seen.iter().any(|(_, n)| n == &nonce) {
        return Err("REPLAY_DETECTED".to_string());
    }
    if ts + 30 < now {
        return Err("STALE_TIMESTAMP".to_string());
    }
    if ts > now + 30 {
        return Err("FUTURE_TIMESTAMP".to_string());
    }
    seen.push((ts, nonce));
    if let Some(dir) = cache_path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    std::fs::write(
        &cache_path,
        serde_json::to_string(&seen).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    println!("OK: accepted");
    Ok(())
}

// ── P2 delegation grants ───────────────────────────────────────────────────

fn cmd_grant(args: &[String]) -> Result<(), String> {
    let sub = args.first().map(|s| s.as_str()).unwrap_or("help");
    match sub {
        "create" => cmd_grant_create(&args[1..]),
        "verify" => cmd_grant_verify(&args[1..]),
        "eval" => cmd_grant_eval(&args[1..]),
        "revoke" => cmd_grant_revoke(&args[1..]),
        "status" => cmd_grant_status(&args[1..]),
        _ => Err("usage: iflow-id grant <create|verify|eval|revoke|status> [args...]".into()),
    }
}

fn parse_flag(args: &[String], flag: &str) -> Option<String> {
    let mut i = 0;
    while i < args.len() {
        if args[i] == flag && i + 1 < args.len() {
            return Some(args[i + 1].clone());
        }
        i += 1;
    }
    None
}

/// grant create <delegate> <scope-csv> <level> <expiry-ts>
///   [--budget N] [--label S] [--capabilities CSV] [--deny CSV] [--root KIND]
///   [--issuer-kind S] [--nonce S] [--renews GRANT_ID]
///   [--ack-setter DID] [--ack-level LVL] [--ack-root KIND] [--ack-sig HEX]
fn cmd_grant_create(args: &[String]) -> Result<(), String> {
    // positional: delegate, scope-csv, level, expiry-ts (first 4)
    let positional: Vec<&String> = args.iter().filter(|a| !a.starts_with("--")).collect();
    if positional.len() < 4 {
        return Err("usage: grant create <delegate> <scope-csv> <level> <expiry-ts> [--budget N] [--label S] [--capabilities CSV] [--deny CSV] [--root KIND] [--issuer-kind S] [--nonce S] [--renews GRANT_ID] [--ack-setter DID] [--ack-level LVL] [--ack-root KIND] [--ack-sig HEX]".into());
    }
    let delegate = positional[0].to_string();
    let scope_csv = positional[1].to_string();
    let level_str = positional[2].to_string();
    let expiry = positional[3]
        .parse::<u64>()
        .map_err(|_| "expiry must be unix seconds (u64)".to_string())?;

    let delegate_did = DidKey(delegate.clone());
    // ensure delegate did parses as a valid did:key so we don't sign junk
    delegate_did.parse().map_err(|e| format!("invalid delegate did: {e}"))?;

    let level = Level::parse(&level_str)?;
    let scope: Vec<String> = parse_csv(&scope_csv);
    let budget = parse_flag(args, "--budget").and_then(|b| b.parse::<u64>().ok());
    let label = parse_flag(args, "--label").unwrap_or_else(|| "delegation".to_string());

    // ── V20 additive fields ────────────────────────────────────────────
    let issuer_kind = parse_flag(args, "--issuer-kind").unwrap_or_default();
    let root_kind = parse_flag(args, "--root").unwrap_or_default();
    let nonce = parse_flag(args, "--nonce").unwrap_or_default();
    let renews = parse_flag(args, "--renews").unwrap_or_default();
    let revocation_grace = parse_flag(args, "--grace")
        .and_then(|g| g.parse::<u64>().ok())
        .unwrap_or(0);

    // capabilities / deny: namespace-prefixed IDs only (reject bare free-form).
    let raw_caps = parse_csv(&parse_flag(args, "--capabilities").unwrap_or_default());
    if raw_caps.iter().any(|c| !grant::valid_capability_id(c)) {
        return Err("invalid capability ID: must be 'iflow.cap:<domain>.<op>' (or '*'); bare free-form is rejected".into());
    }
    let capabilities: Vec<Capability> = raw_caps
        .into_iter()
        .map(|id| Capability { id, limits: None })
        .collect();
    let raw_deny = parse_csv(&parse_flag(args, "--deny").unwrap_or_default());
    if raw_deny.iter().any(|d| !grant::valid_capability_id(d)) {
        return Err("invalid deny ID: must be 'iflow.cap:<domain>.<op>' (or '*'); bare free-form is rejected".into());
    }

    // Optional H2+ root-ack that lifts a weak root. The ack must be complete
    // and verify against the ack setter — the CLI never forges a foreign ack.
    let root_ack = build_root_ack_from_flags(args)?;

    let issuer_root = RootStrength { kind: root_kind.clone(), ..Default::default() };
    let cap = issuer_root.max_level();
    if level > cap {
        let acked = root_ack.as_ref().map(|a| a.ack_level >= level).unwrap_or(false);
        if !acked {
            return Err(format!(
                "root '{root_kind}' caps at {:?} but grant level is {:?}; specify --root <webauthn|hwkey|ca|kyc> or a valid --ack-*",
                cap, level
            ));
        }
    }

    let spec = GrantSpec {
        issuer_kind,
        issuer_root,
        capabilities,
        deny: raw_deny,
        business_scope: scope.clone(),
        revocation_grace,
        renews,
        nonce,
        root_ack,
    };

    let identity = load_identity()?;
    let signing = identity.signing_key()?;
    let created_at = now_secs();
    let grant = grant::build_grant_full(
        &signing,
        &identity.did,
        &delegate_did,
        scope,
        budget,
        expiry,
        level,
        &label,
        created_at,
        spec,
    );
    println!(
        "{}",
        serde_json::to_string_pretty(&grant).map_err(|e| e.to_string())?
    );
    eprintln!(
        "// grant_id: {}\n// issuer: {}\n// delegate: {}\n// level: {}\n// capabilities: {:?}\n// business_scope: {:?}\n// expires_at: {}",
        grant.grant_id,
        identity.did,
        delegate,
        level.as_str(),
        grant.body.capabilities.iter().map(|c| c.id.clone()).collect::<Vec<_>>(),
        grant.body.business_scope,
        expiry
    );
    Ok(())
}

/// Split a comma-separated flag value into trimmed, non-empty strings.
fn parse_csv(s: &str) -> Vec<String> {
    s.split(',')
        .map(|x| x.trim().to_string())
        .filter(|x| !x.is_empty())
        .collect()
}

/// Build an optional [`RootAck`] from `--ack-setter/--ack-level/--ack-root/--ack-sig`.
/// Requires all four; verifies the signature against the ack setter.
fn build_root_ack_from_flags(args: &[String]) -> Result<Option<RootAck>, String> {
    let setter = parse_flag(args, "--ack-setter");
    let ack_level = parse_flag(args, "--ack-level");
    let ack_root = parse_flag(args, "--ack-root");
    let ack_sig = parse_flag(args, "--ack-sig");
    let any = setter.is_some() || ack_level.is_some() || ack_root.is_some() || ack_sig.is_some();
    if !any {
        return Ok(None);
    }
    let (setter, ack_level, ack_root, ack_sig) = match (setter, ack_level, ack_root, ack_sig) {
        (Some(s), Some(l), Some(r), Some(sig)) => (s, l, r, sig),
        _ => return Err("root-ack requires --ack-setter, --ack-level, --ack-root and --ack-sig (all present)".into()),
    };
    let setter_did = DidKey(setter.clone());
    setter_did.parse().map_err(|e| format!("invalid ack-setter did: {e}"))?;
    let ack = RootAck {
        ack_level: Level::parse(&ack_level)?,
        ack_root: RootStrength { kind: ack_root, ..Default::default() },
        setter: setter_did,
        signature: ack_sig,
    };
    grant::verify_root_ack(&ack)?;
    Ok(Some(ack))
}

/// grant verify <grant.json>
fn cmd_grant_verify(args: &[String]) -> Result<(), String> {
    let json = if let Some(path) = args.first() {
        std::fs::read_to_string(path).map_err(|e| e.to_string())?
    } else {
        read_stdin()?
    };
    let grant: grant::DelegationGrant =
        serde_json::from_str(&json).map_err(|e| format!("bad grant json: {e}"))?;
    grant::verify_grant_signature(&grant)?;
    grant::check_grant_id(&grant)?;
    println!("grant signature OK (issuer: {})", grant.body.issuer);
    println!("grant_id: {}", grant.grant_id);
    Ok(())
}

/// grant eval <grant.json> <action-scope> <level> <now> [--spent F] [--cost F]
fn cmd_grant_eval(args: &[String]) -> Result<(), String> {
    if args.len() < 4 {
        return Err("usage: grant eval <grant.json> <action-scope> <level> <now> [--spent F] [--cost F]".into());
    }
    let json = std::fs::read_to_string(&args[0]).map_err(|e| e.to_string())?;
    let grant: grant::DelegationGrant =
        serde_json::from_str(&json).map_err(|e| format!("bad grant json: {e}"))?;
    let action = args[1].to_string();
    let level = Level::parse(&args[2])?;
    let now = args[3].parse::<u64>().map_err(|_| "now must be u64".to_string())?;
    let spent: f64 = parse_flag(args, "--spent").and_then(|v| v.parse::<f64>().ok()).unwrap_or(0.0);
    let cost: f64 = parse_flag(args, "--cost").and_then(|v| v.parse::<f64>().ok()).unwrap_or(0.0);
    // Check-at-use: load the local (Reg-L) registry so a revocation is seen at
    // decision time, within the grant's declared (or default) grace window.
    let registry = grant::load_registry()?;
    let d = grant::evaluate_full(&grant, &action, level, now, spent, cost, &registry);
    if d.ok {
        let note = match d.reason.as_deref() {
            Some(r) if r.starts_with("revoked-grace") => " (grace window: L0 allowed)",
            _ => "",
        };
        println!("GRANT OK (level {}){}", d.level, note);
        Ok(())
    } else {
        // Non-zero exit so a host (the DSH plugin) can treat a rejected grant
        // as a hard failure, not a "passed" result.
        Err(format!("GRANT REJECT: {}", d.reason.unwrap_or_else(|| "unknown".to_string())))
    }
}

/// grant revoke <grant_id> [--root DID] — record a revocation (Reg-L).
fn cmd_grant_revoke(args: &[String]) -> Result<(), String> {
    let grant_id = args.first().cloned().unwrap_or_default();
    if grant_id.is_empty() {
        return Err("usage: grant revoke <grant_id> [--root DID]".into());
    }
    let root = parse_flag(args, "--root");
    grant::record_revoke(&grant_id, now_secs(), root.as_deref())?;
    println!("grant {grant_id} revoked (Reg-L, at {})", now_secs());
    Ok(())
}

/// grant status <grant_id> — show the local revocation verdict.
fn cmd_grant_status(args: &[String]) -> Result<(), String> {
    let grant_id = args.first().cloned().unwrap_or_default();
    if grant_id.is_empty() {
        return Err("usage: grant status <grant_id>".into());
    }
    let registry = grant::load_registry()?;
    let grace = grant::DEFAULT_REVOCATION_GRACE;
    let verdict = grant::revocation_verdict(&registry, &grant_id, now_secs(), grace);
    let label = match verdict {
        RevokeVerdict::NotRevoked => "not revoked",
        RevokeVerdict::Grace => "revoked (within revocation_grace)",
        RevokeVerdict::Revoked => "revoked",
    };
    println!("grant {grant_id}: {label}");
    Ok(())
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

// ── token usage metering (P4 / DESIGN §4.2) ────────────────────────────────

/// Pricing table path: `<node-home>/.iflow/pricing.json`.
///
/// Node-wide, not per-identity: a rate card describes what this machine's
/// compute costs, which does not change because a different key is signing.
fn pricing_path() -> std::path::PathBuf {
    std::path::PathBuf::from(node_home()).join(".iflow").join("pricing.json")
}

fn cmd_usage(args: &[String]) -> Result<(), String> {
    let sub = args.first().map(|s| s.as_str()).unwrap_or("report");
    match sub {
        "record" => cmd_usage_record(&args[1..]),
        "report" => cmd_usage_report(&args[1..]),
        _ => Err("usage: iflow-id usage <record|report> [args...]".into()),
    }
}

/// Usage record <task> <from> <model> <input> <output> [--cache-read N] [--cache-write N] [--duration N]
fn cmd_usage_record(args: &[String]) -> Result<(), String> {
    let positional: Vec<&String> = args.iter().filter(|a| !a.starts_with("--")).collect();
    if positional.len() < 5 {
        return Err("usage: usage record <task> <from> <model> <input> <output> [--cache-read N] [--cache-write N] [--duration N]".into());
    }
    let task = positional[0].to_string();
    let from = positional[1].to_string();
    let model = positional[2].to_string();
    let input: u64 = positional[3].parse().map_err(|_| "input must be u64")?;
    let output: u64 = positional[4].parse().map_err(|_| "output must be u64")?;
    let cache_read = parse_flag(args, "--cache-read").and_then(|v| v.parse::<u64>().ok()).unwrap_or(0);
    let cache_write = parse_flag(args, "--cache-write").and_then(|v| v.parse::<u64>().ok()).unwrap_or(0);
    let duration: u64 = parse_flag(args, "--duration").and_then(|v| v.parse::<u64>().ok()).unwrap_or(0);

    let pricing = pricing::PricingTable::load(&pricing_path());
    let now = now_secs();
    let started = now.saturating_sub(duration / 1000);
    let tokens = pricing::Tokens { input, output, cache_read, cache_write };
    let rec = usage::TaskUsage::record(&task, &from, &model, tokens, &pricing, started, now, duration);
    let written = usage::append_if_new(&rec).map_err(|e| format!("write usage log: {e}"))?;
    if written {
        println!(
            "recorded task {task}: {} tokens (in {input}, out {output}, cr {cache_read}, cw {cache_write}), cost ${:.8}",
            rec.tokens.total(),
            rec.cost.total_cost
        );
    } else {
        println!("duplicate task {task} skipped (fingerprint already exists): {}", rec.fingerprint);
    }
    println!("fingerprint: {}", rec.fingerprint);
    Ok(())
}

/// Usage report [--from DID] [--model M]
fn cmd_usage_report(args: &[String]) -> Result<(), String> {
    let from = parse_flag(args, "--from").unwrap_or_default();
    let model = parse_flag(args, "--model").unwrap_or_default();
    let rows = usage::load_all();
    let a = usage::aggregate(&rows, &from, &model);
    println!(
        "usage report ({} rows):\n  tasks: {}\n  tokens: {} (in {}, out {}, cr {}, cw {})\n  total cost: ${:.8}",
        rows.len(),
        a.tasks,
        a.total_tokens,
        a.total_input_tokens,
        a.total_output_tokens,
        a.total_cache_read_tokens,
        a.total_cache_write_tokens,
        a.total_cost
    );
    if !a.by_model.is_empty() {
        println!("  by model:");
        let mut models: Vec<_> = a.by_model.iter().collect();
        models.sort_by(|x, y| y.1.cost.partial_cmp(&x.1.cost).unwrap_or(std::cmp::Ordering::Equal));
        for (name, m) in models {
            println!("    {name}: tasks {}, tokens {}, cost ${:.8}", m.tasks, m.tokens, m.cost);
        }
    }
    if !a.by_from.is_empty() {
        println!("  by from:");
        let mut froms: Vec<_> = a.by_from.iter().collect();
        froms.sort_by(|x, y| y.1.cost.partial_cmp(&x.1.cost).unwrap_or(std::cmp::Ordering::Equal));
        for (did, f) in froms {
            println!("    {did}: tasks {}, tokens {}, cost ${:.8}", f.tasks, f.tokens, f.cost);
        }
    }
    Ok(())
}
