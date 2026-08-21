//! did:key identity root — the zero-chain trust anchor of iFlow (M1).
//!
//! Implements the W3C `did:key` method for Ed25519:
//!   `did:key:z` + base58btc( multicodec(0xed 0x01) || 32-byte public key )
//!
//! Deliberately free of any chain/wallet/gas concept: the trust root is the
//! local Ed25519 key pair. Chain addresses may attach later (P3) via an
//! EconomicAttachment layer, never by modifying this type.

use ed25519_dalek::{Signature, Signer, SigningKey, VerifyingKey};
use std::fmt;

/// The multicodec prefix for an Ed25519 public key (0xed, 0x01).
pub const ED25519_PUB_MULTICODEC: [u8; 2] = [0xed, 0x01];

/// A W3C `did:key` identifier, e.g. `did:key:z6Mk...`.
#[derive(Clone, Debug, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
pub struct DidKey(pub String);

impl fmt::Display for DidKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl DidKey {
    /// Parse a `did:key:z<base58btc>` string into the raw 32-byte public key.
    pub fn parse(&self) -> Result<[u8; 32], String> {
        let rest = self
            .0
            .strip_prefix("did:key:z")
            .ok_or_else(|| format!("invalid did:key prefix in {}", self.0))?;
        let decoded = bs58::decode(rest)
            .into_vec()
            .map_err(|e| format!("base58 decode failed: {e}"))?;
        if decoded.len() != 34 || decoded[0] != ED25519_PUB_MULTICODEC[0] || decoded[1] != ED25519_PUB_MULTICODEC[1] {
            return Err(format!("not an Ed25519 did:key (multicodec mismatch)"));
        }
        let mut key = [0u8; 32];
        key.copy_from_slice(&decoded[2..]);
        Ok(key)
    }

    /// Reconstruct the verifying key from this did.
    pub fn verifying_key(&self) -> Result<VerifyingKey, String> {
        VerifyingKey::from_bytes(&self.parse()?).map_err(|e| format!("invalid verifying key: {e}"))
    }

    /// Verify a 64-byte Ed25519 signature over `message` against this did.
    pub fn verify(&self, message: &[u8], signature: &[u8; 64]) -> Result<(), String> {
        let vk = self.verifying_key()?;
        let sig = Signature::from_bytes(signature);
        vk.verify_strict(message, &sig)
            .map_err(|e| format!("signature verification failed: {e}"))
    }
}

/// Encode a 32-byte Ed25519 public key with its multicodec prefix.
pub fn multicodec_encode(public_key: &[u8; 32]) -> Vec<u8> {
    let mut out = Vec::with_capacity(34);
    out.extend_from_slice(&ED25519_PUB_MULTICODEC);
    out.extend_from_slice(public_key);
    out
}

/// Derive a `did:key` from a verifying key.
pub fn did_from_verifying(vk: &VerifyingKey) -> DidKey {
    let encoded = bs58::encode(multicodec_encode(&vk.to_bytes())).into_string();
    DidKey(format!("did:key:z{encoded}"))
}

/// Generate a fresh Ed25519 identity and its `did:key`.
pub fn generate() -> (DidKey, SigningKey) {
    let mut csprng = rand::rngs::OsRng;
    let signing = SigningKey::generate(&mut csprng);
    let did = did_from_verifying(&signing.verifying_key());
    (did, signing)
}

/// Sign `message` with the signing key, returning the 64-byte signature.
pub fn sign(signing: &SigningKey, message: &[u8]) -> [u8; 64] {
    let sig: Signature = signing.sign(message);
    sig.to_bytes()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generate_did_roundtrip_verify() {
        let (did, signing) = generate();
        // did must be well-formed
        assert!(did.0.starts_with("did:key:z"), "unexpected did: {}", did.0);

        let message = b"iFlow trust root handshake";
        let signature = sign(&signing, message);
        assert!(did.verify(message, &signature).is_ok(), "valid signature rejected");

        // tampered message must fail
        assert!(did.verify(b"tampered", &signature).is_err(), "tampered accepted");

        // tampered signature must fail
        let mut bad = signature;
        bad[0] ^= 0xff;
        assert!(did.verify(message, &bad).is_err(), "tampered sig accepted");
    }

    #[test]
    fn did_key_encoding_stable() {
        let (did, _) = generate();
        let key = did.parse().expect("parse own did");
        assert_eq!(key.len(), 32);
        let vk = did.verifying_key().expect("reconstruct vk");
        assert_eq!(vk.to_bytes(), key);
    }

    #[test]
    fn rejects_non_ed25519() {
        // wrong multicodec prefix (secp256k1 would be 0xe7,0x01)
        let mut bogus_bytes = [0u8; 34];
        bogus_bytes[0] = 0xe7;
        bogus_bytes[1] = 0x01;
        let bogus = format!("did:key:z{}", bs58::encode(bogus_bytes).into_string());
        let did = DidKey(bogus);
        assert!(did.parse().is_err());
    }
}
