//! Request signing — the P1 "who wrote this" layer.
//!
//! Signs the canonical request line:
//!   `method\npath\nsha256(body)\nnonce\ntimestamp`
//!
//! Together with nonce + timestamp (see `nonce.rs`) this answers:
//!   - who wrote this (signature verifies against the issuer did)
//!   - is this the first time (nonce + sliding window)

use sha2::{Digest, Sha256};

use crate::identity::did_key::{sign, DidKey};

/// One signed request envelope.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct SignedRequest {
    pub method: String,
    pub path: String,
    pub body_sha256: String,
    pub nonce: String,
    pub timestamp: u64,
    pub signature: String,
    pub signer: DidKey,
}

/// Canonical bytes signed for a request.
pub fn canonical(method: &str, path: &str, body_sha256: &str, nonce: &str, timestamp: u64) -> Vec<u8> {
    format!("{method}\n{path}\n{body_sha256}\n{nonce}\n{timestamp}").into_bytes()
}

/// SHA-256 hex digest of a body.
pub fn sha256_hex(body: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(body);
    hex(&hasher.finalize())
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Build and sign a request envelope.
pub fn build(
    signing: &ed25519_dalek::SigningKey,
    did: &DidKey,
    method: &str,
    path: &str,
    body: &[u8],
    nonce: &str,
    timestamp: u64,
) -> SignedRequest {
    let body_sha256 = sha256_hex(body);
    let canon = canonical(method, path, &body_sha256, nonce, timestamp);
    let sig = sign(signing, &canon);
    SignedRequest {
        method: method.to_string(),
        path: path.to_string(),
        body_sha256,
        nonce: nonce.to_string(),
        timestamp,
        signature: hex(&sig),
        signer: did.clone(),
    }
}

/// Verify a signed request against its signer did (P1: signature + window
/// handled separately in the gateway — nonce checking lives in `nonce.rs`).
pub fn verify(req: &SignedRequest) -> Result<(), String> {
    let canon = canonical(&req.method, &req.path, &req.body_sha256, &req.nonce, req.timestamp);
    let sig_bytes = decode_hex(&req.signature)
        .ok_or_else(|| "signature is not valid hex".to_string())?;
    let sig: [u8; 64] = sig_bytes
        .try_into()
        .map_err(|_| "signature is not 64 bytes".to_string())?;
    req.signer.verify(&canon, &sig)
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

    #[test]
    fn sign_verify_roundtrip() {
        let (did, signing) = generate();
        let body = b"{\"prompt\":\"hello\"}";
        let req = build(&signing, &did, "POST", "/a2a", body, "nonce-1", 1_700_000_000);
        assert!(verify(&req).is_ok());
        // tamper body digest
        let mut bad = req.clone();
        bad.body_sha256 = sha256_hex(b"tampered");
        assert!(verify(&bad).is_err());
        // tamper nonce
        let mut bad2 = req.clone();
        bad2.nonce = "nonce-2".into();
        assert!(verify(&bad2).is_err());
    }
}
