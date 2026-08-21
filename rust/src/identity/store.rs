//! Identity persistence — the local trust-root store (P1).
//!
//! Reads/writes `~/.iflow/identity.json`. P1 stores the secret key as a file
//! protected by OS permissions (0600) — full at-rest encryption and TPM/HSM
//! binding are later hardening (per DESIGN.md §2 boundary note).

use std::collections::HashMap;
use std::fs;
use std::io;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::identity::did_key::DidKey;

/// Storage marker: P1 uses a plaintext-dev store behind OS file permissions.
pub const STORAGE_PLAINTEXT_DEV: &str = "plaintext-dev";

/// One persisted identity record.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct StoredIdentity {
    pub did: DidKey,
    /// 32-byte Ed25519 secret key (local only, never exported).
    pub secret_key: Vec<u8>,
    pub label: String,
    pub created_at: String,
    pub storage: String,
    #[serde(default)]
    pub metadata: HashMap<String, String>,
}

impl StoredIdentity {
    /// Reconstruct the signing key from the stored secret bytes.
    pub fn signing_key(&self) -> Result<ed25519_dalek::SigningKey, String> {
        let bytes: [u8; 32] = self
            .secret_key
            .as_slice()
            .try_into()
            .map_err(|_| "stored secret key is not 32 bytes".to_string())?;
        Ok(ed25519_dalek::SigningKey::from_bytes(&bytes))
    }
}

/// The identity file location: `~/.iflow/identity.json` (DSH_HOME-style dir).
pub fn identity_path() -> PathBuf {
    let home = std::env::var("IFLOW_HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .or_else(|_| std::env::var("HOME"))
        .unwrap_or_else(|_| ".".to_string());
    PathBuf::from(home).join(".iflow").join("identity.json")
}

/// Persist the identity, creating `~/.iflow` and protecting the file.
pub fn save(identity: &StoredIdentity) -> io::Result<()> {
    let path = identity_path();
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    let json = serde_json::to_string_pretty(identity)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
    fs::write(&path, json)?;
    // Best-effort OS permission hardening (no-op on platforms without it).
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).ok();
    }
    Ok(())
}

/// Load the persisted identity, if any.
pub fn load() -> io::Result<Option<StoredIdentity>> {
    let path = identity_path();
    if !path.exists() {
        return Ok(None);
    }
    let text = fs::read_to_string(&path)?;
    serde_json::from_str(&text)
        .map(Some)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))
}
