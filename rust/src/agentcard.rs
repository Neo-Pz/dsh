//! AgentCard JWS signing/verification (DESIGN.md P1: "AgentCard JWS").
//!
//! Signs the canonical AgentCard JSON so a peer can verify "this capability
//! list was indeed published by the issuer". Follows the JWS flattened JSON
//! shape (protected header + payload + signature), using the same local
//! Ed25519 trust root — no external chain state.

use base64::Engine;
use ed25519_dalek::{Signer, SigningKey, VerifyingKey};
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::identity::did_key::DidKey;

/// The JWS protected header (base64url-encoded JSON before signing).
fn protected_header(did: &DidKey, timestamp: u64) -> String {
    let header = serde_json::json!({
        "alg": "EdDSA",
        "typ": "JWT",
        "kid": did.0.clone(),
        "iat": timestamp,
    });
    base64url(&serde_json::to_vec(&header).unwrap_or_default())
}

/// Base64url (no padding).
pub fn base64url(bytes: &[u8]) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

/// Canonical payload bytes for signing: the AgentCard JSON, serialized
/// deterministically (sorted keys), so verification is stable across writers.
pub fn canonical_agentcard(card: &Value) -> Vec<u8> {
    serde_json::to_vec(&sort_json(card)).unwrap_or_default()
}

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

/// A signed AgentCard (JWS flattened JSON serialization).
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct SignedAgentCard {
    pub payload: String,     // base64url(canonical AgentCard JSON)
    pub protected: String,   // base64url(header JSON)
    pub signature: String,   // base64url(Ed25519 signature over header||payload)
    pub signer: DidKey,
}

impl SignedAgentCard {
    /// Sign a canonical AgentCard JSON.
    pub fn sign(card: &Value, signing: &SigningKey, did: &DidKey) -> Self {
        let payload = canonical_agentcard(card);
        let payload_b64 = base64url(&payload);
        let timestamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let protected = protected_header(did, timestamp);
        let signing_input = format!("{protected}.{payload_b64}");
        let sig: ed25519_dalek::Signature = signing.sign(signing_input.as_bytes());
        Self {
            payload: payload_b64,
            protected,
            signature: base64url(&sig.to_bytes()),
            signer: did.clone(),
        }
    }

    /// Recover and verify the payload against the declared signer did.
    pub fn verify_and_payload(&self) -> Result<Value, String> {
        let signing_input = format!("{}.{}", self.protected, self.payload);
        let sig_bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode(&self.signature)
            .map_err(|e| format!("bad signature b64: {e}"))?;
        let sig: [u8; 64] = sig_bytes
            .try_into()
            .map_err(|_| "signature not 64 bytes".to_string())?;
        let vk: VerifyingKey = self.signer.verifying_key()?;
        let sig = ed25519_dalek::Signature::from_bytes(&sig);
        vk.verify_strict(signing_input.as_bytes(), &sig)
            .map_err(|e| format!("AgentCard signature invalid: {e}"))?;
        let payload_bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode(&self.payload)
            .map_err(|e| format!("bad payload b64: {e}"))?;
        serde_json::from_slice(&payload_bytes).map_err(|e| format!("bad payload json: {e}"))
    }
}

/// Convenience: full SHA-256 fingerprint helper for audit records.
pub fn fingerprint(card_json: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(card_json);
    hasher
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::identity::did_key::generate;

    #[test]
    fn agentcard_sign_verify() {
        let (did, signing) = generate();
        let card = serde_json::json!({
            "name": "DSH Agent (iFlow)",
            "skills": [{"id": "agent-task"}],
            "version": "1.0.0"
        });
        let signed = SignedAgentCard::sign(&card, &signing, &did);
        let recovered = signed.verify_and_payload().expect("verify");
        // payload must round-trip the canonical card
        assert_eq!(recovered, sort_json(&card));
        // signer did must be the one who signed
        assert_eq!(signed.signer, did);
    }

    #[test]
    fn tampered_card_fails() {
        let (did, signing) = generate();
        let card = serde_json::json!({"name": "A"});
        let mut signed = SignedAgentCard::sign(&card, &signing, &did);
        // tamper payload
        signed.payload = base64url(&canonical_agentcard(&serde_json::json!({"name": "B"})));
        assert!(signed.verify_and_payload().is_err());
    }
}
