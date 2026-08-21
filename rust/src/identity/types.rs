//! Identity data model (M1).
//!
//! `AgentIdentity` is the durable, zero-chain identity record. By design it
//! carries NO chain_id, NO wallet_address, and NO on-chain nonce — the trust
//! root is the local Ed25519 key. P3 economic attachments (ERC-8004, Safe,
//! x402) will be composed ON TOP via a separate EconomicAttachment layer,
//! never by extending this struct.

use std::collections::HashMap;

use ed25519_dalek::SigningKey;

use super::did_key::DidKey;

/// The locally stored agent identity.
///
/// `secret_key` is kept encrypted-at-rest in later milestones (M2+); M1 stores
/// it in the development (plaintext) store with an explicit marker so it can
/// never be silently upgraded to "secure".
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct AgentIdentity {
    /// The `did:key:z...` identifier — the machine-verifiable identity.
    pub did: DidKey,
    /// 32-byte Ed25519 secret key (local only, never exported).
    pub secret_key: Vec<u8>,
    /// Human-readable label only (e.g. "if-lt"). Not a trust input.
    pub label: String,
    /// Creation timestamp (RFC 3339).
    pub created_at: String,
    /// Storage format marker; M1 = "plaintext-dev".
    pub storage: String,
    /// Arbitrary human-readable metadata (no trust semantics).
    #[serde(default)]
    pub metadata: HashMap<String, String>,
}

impl AgentIdentity {
    /// Reconstruct the signing key from the stored secret bytes.
    pub fn signing_key(&self) -> Result<SigningKey, String> {
        let bytes: [u8; 32] = self
            .secret_key
            .as_slice()
            .try_into()
            .map_err(|_| "stored secret key is not 32 bytes".to_string())?;
        Ok(SigningKey::from_bytes(&bytes))
    }
}
