//! Sealing a message so a relay can carry it without reading it.
//!
//! iFlow's relay is a point-to-point forwarding layer. It routes, it queues
//! while the recipient is offline, and it deletes on delivery. What it must
//! never be is a place where everyone's conversations are legible — including
//! to whoever operates it, and to whoever later reads its backups.
//!
//! So the relay carries an opaque blob. This module makes that blob.
//!
//! # The construction
//!
//! An anonymous sealed box, the shape libsodium calls `crypto_box_seal`:
//!
//! ```text
//! ephemeral X25519 keypair  (fresh per message)
//! shared   = X25519(ephemeral_secret, recipient_public)
//! key      = HKDF-SHA256(shared, salt = ephemeral_pub || recipient_pub,
//!                        info = "iflow-envelope-v1")
//! payload  = ChaCha20-Poly1305(key, nonce = 0, plaintext, aad = context)
//! sealed   = "v1" || ephemeral_pub || payload
//! ```
//!
//! A zero nonce is correct here and not a shortcut: the key is derived from a
//! keypair that exists for exactly one message, so the (key, nonce) pair can
//! never repeat. Carrying a random nonce would add bytes and one more thing to
//! get wrong.
//!
//! # Why anonymous, when we know who is sending
//!
//! Sealing gives confidentiality. It deliberately does NOT identify the
//! sender: that is what the detached Ed25519 signature over the envelope
//! already does (`signing.rs`, the P1 layer). Composing two primitives that
//! each do one thing beats one primitive doing both badly — and it means the
//! recipient authenticates the sender by the same rule whether the message
//! arrived over the relay or straight over A2A.
//!
//! # aad: what the ciphertext is bound to
//!
//! The caller passes the envelope's routing metadata as additional
//! authenticated data. Decryption then fails if a relay moves a ciphertext to
//! a different conversation, a different recipient or a different message id.
//! Without it, a relay it cannot read is still a relay that can shuffle.
//!
//! # One key, two uses
//!
//! The X25519 keys are derived from the node's existing Ed25519 identity, the
//! same way libsodium's `crypto_sign_ed25519_pk_to_curve25519` does. Using one
//! keypair for both signing and key agreement is a documented trade-off rather
//! than an accident: it means an Agent's `did:key` is the only thing a peer
//! needs to encrypt to, with no second key to publish, rotate or get wrong.
//! The alternative — a separate encryption key in the AgentCard — is a real
//! option later, and nothing in the wire format prevents it.

use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{ChaCha20Poly1305, Nonce};
use curve25519_dalek::edwards::CompressedEdwardsY;
use ed25519_dalek::{SigningKey, VerifyingKey};
use hkdf::Hkdf;
use sha2::Sha256;
use x25519_dalek::{EphemeralSecret, PublicKey, StaticSecret};

use crate::identity::did_key::DidKey;

/// Wire version, first two bytes of every sealed blob.
const VERSION: &[u8; 2] = b"v1";

/// Domain separation for the KDF. A key derived here can never collide with
/// one derived for some other iFlow purpose from the same shared secret.
const HKDF_INFO: &[u8] = b"iflow-envelope-v1";

const EPHEMERAL_PUB_LEN: usize = 32;

/// An Ed25519 verifying key as its X25519 counterpart.
///
/// Ed25519 public keys live on a twisted Edwards curve; X25519 wants the
/// birationally equivalent Montgomery form. `to_montgomery` is that map.
fn public_to_x25519(vk: &VerifyingKey) -> Result<PublicKey, String> {
    let compressed = CompressedEdwardsY(vk.to_bytes());
    let point = compressed
        .decompress()
        .ok_or_else(|| "public key is not a valid curve point".to_string())?;
    Ok(PublicKey::from(point.to_montgomery().to_bytes()))
}

/// An Ed25519 signing key as its X25519 counterpart.
///
/// `to_scalar_bytes` returns the clamped scalar Ed25519 derives from the seed,
/// which is exactly the private half X25519 needs.
fn secret_to_x25519(signing: &SigningKey) -> StaticSecret {
    StaticSecret::from(signing.to_scalar_bytes())
}

/// Derive the message key from a completed exchange.
fn derive_key(shared: &[u8; 32], ephemeral_pub: &[u8; 32], recipient_pub: &[u8; 32]) -> [u8; 32] {
    let mut salt = Vec::with_capacity(64);
    salt.extend_from_slice(ephemeral_pub);
    salt.extend_from_slice(recipient_pub);
    let hk = Hkdf::<Sha256>::new(Some(&salt), shared);
    let mut key = [0u8; 32];
    hk.expand(HKDF_INFO, &mut key)
        .expect("32 bytes is a valid HKDF output length");
    key
}

/// Seal `plaintext` so only the holder of `recipient`'s key can read it.
///
/// `aad` binds the result to its envelope: pass the routing metadata, and pass
/// exactly the same bytes to `open`.
pub fn seal(recipient: &DidKey, plaintext: &[u8], aad: &[u8]) -> Result<Vec<u8>, String> {
    let recipient_vk = recipient.verifying_key()?;
    let recipient_x = public_to_x25519(&recipient_vk)?;

    let ephemeral_secret = EphemeralSecret::random_from_rng(rand::rngs::OsRng);
    let ephemeral_pub = PublicKey::from(&ephemeral_secret);
    let shared = ephemeral_secret.diffie_hellman(&recipient_x);

    let key = derive_key(shared.as_bytes(), ephemeral_pub.as_bytes(), recipient_x.as_bytes());
    let cipher = ChaCha20Poly1305::new((&key).into());
    // Safe because the ephemeral key is used for exactly one message, so this
    // (key, nonce) pair cannot recur.
    let nonce = Nonce::from_slice(&[0u8; 12]);
    let ciphertext = cipher
        .encrypt(nonce, Payload { msg: plaintext, aad })
        .map_err(|_| "encryption failed".to_string())?;

    let mut out = Vec::with_capacity(VERSION.len() + EPHEMERAL_PUB_LEN + ciphertext.len());
    out.extend_from_slice(VERSION);
    out.extend_from_slice(ephemeral_pub.as_bytes());
    out.extend_from_slice(&ciphertext);
    Ok(out)
}

/// Open a blob sealed to this key.
///
/// Fails — rather than returning anything — when the blob was sealed to
/// someone else, was tampered with, or arrived under different routing
/// metadata than it was sealed with.
pub fn open(signing: &SigningKey, sealed: &[u8], aad: &[u8]) -> Result<Vec<u8>, String> {
    if sealed.len() < VERSION.len() + EPHEMERAL_PUB_LEN {
        return Err("sealed envelope is too short".to_string());
    }
    if &sealed[..VERSION.len()] != VERSION {
        return Err(format!(
            "unsupported envelope version {:?}; this node speaks v1",
            String::from_utf8_lossy(&sealed[..VERSION.len()])
        ));
    }
    let mut ephemeral_bytes = [0u8; EPHEMERAL_PUB_LEN];
    ephemeral_bytes.copy_from_slice(&sealed[VERSION.len()..VERSION.len() + EPHEMERAL_PUB_LEN]);
    let ephemeral_pub = PublicKey::from(ephemeral_bytes);
    let ciphertext = &sealed[VERSION.len() + EPHEMERAL_PUB_LEN..];

    let secret = secret_to_x25519(signing);
    let own_pub = PublicKey::from(&secret);
    let shared = secret.diffie_hellman(&ephemeral_pub);

    let key = derive_key(shared.as_bytes(), ephemeral_pub.as_bytes(), own_pub.as_bytes());
    let cipher = ChaCha20Poly1305::new((&key).into());
    let nonce = Nonce::from_slice(&[0u8; 12]);
    cipher
        .decrypt(nonce, Payload { msg: ciphertext, aad })
        .map_err(|_| "could not open this envelope: it was not sealed for this identity, or it was altered".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::identity::did_key::{did_from_verifying, generate};

    fn identity() -> (DidKey, SigningKey) {
        generate()
    }

    #[test]
    fn seals_and_opens_for_the_intended_recipient() {
        let (_sender_did, _sender) = identity();
        let (recipient_did, recipient) = identity();

        let message = b"can you analyse this CSV?";
        let aad = b"conv-1|msg-1";
        let sealed = seal(&recipient_did, message, aad).expect("seal");
        let opened = open(&recipient, &sealed, aad).expect("open");
        assert_eq!(opened, message);
    }

    #[test]
    fn the_relay_sees_no_plaintext() {
        let (recipient_did, _recipient) = identity();
        let message = b"the quick brown fox";
        let sealed = seal(&recipient_did, message, b"").expect("seal");
        // The blob a relay would store must not contain the message.
        assert!(
            !sealed.windows(message.len()).any(|w| w == message),
            "plaintext survived into the sealed envelope"
        );
    }

    #[test]
    fn nobody_else_can_open_it() {
        let (recipient_did, _recipient) = identity();
        let (_other_did, other) = identity();
        let sealed = seal(&recipient_did, b"private", b"").expect("seal");
        assert!(open(&other, &sealed, b"").is_err(), "a third party opened the envelope");
    }

    #[test]
    fn a_tampered_ciphertext_is_refused() {
        let (recipient_did, recipient) = identity();
        let mut sealed = seal(&recipient_did, b"transfer 10", b"").expect("seal");
        let last = sealed.len() - 1;
        sealed[last] ^= 0x01;
        assert!(open(&recipient, &sealed, b"").is_err(), "tampering was not detected");
    }

    #[test]
    fn a_swapped_ephemeral_key_is_refused() {
        let (recipient_did, recipient) = identity();
        let mut sealed = seal(&recipient_did, b"hello", b"").expect("seal");
        sealed[2] ^= 0xff;
        assert!(open(&recipient, &sealed, b"").is_err(), "a substituted ephemeral key was accepted");
    }

    #[test]
    fn the_relay_cannot_move_a_message_to_another_conversation() {
        // The whole point of the aad: a relay that cannot read a message must
        // also not be able to redeliver it as a different one.
        let (recipient_did, recipient) = identity();
        let sealed = seal(&recipient_did, b"yes, go ahead", b"conv-1|msg-1").expect("seal");
        assert!(open(&recipient, &sealed, b"conv-2|msg-1").is_err(), "conversation was swappable");
        assert!(open(&recipient, &sealed, b"conv-1|msg-2").is_err(), "message id was swappable");
        assert!(open(&recipient, &sealed, b"").is_err(), "aad could simply be dropped");
    }

    #[test]
    fn every_sealing_differs_even_for_the_same_message() {
        // A fresh ephemeral key per message: two sealings of one plaintext must
        // not be linkable by a relay comparing bytes.
        let (recipient_did, _recipient) = identity();
        let a = seal(&recipient_did, b"same", b"").expect("seal");
        let b = seal(&recipient_did, b"same", b"").expect("seal");
        assert_ne!(a, b);
    }

    #[test]
    fn version_is_declared_and_checked() {
        let (recipient_did, recipient) = identity();
        let mut sealed = seal(&recipient_did, b"hello", b"").expect("seal");
        assert_eq!(&sealed[..2], b"v1");
        sealed[0] = b'v';
        sealed[1] = b'9';
        let error = open(&recipient, &sealed, b"").expect_err("a future version must not be guessed at");
        assert!(error.contains("v1"), "the error should say what this node speaks: {error}");
    }

    #[test]
    fn a_truncated_envelope_is_refused_rather_than_panicking() {
        let (recipient_did, recipient) = identity();
        let sealed = seal(&recipient_did, b"hello", b"").expect("seal");
        for cut in [0usize, 1, 2, 10, 33] {
            assert!(open(&recipient, &sealed[..cut], b"").is_err(), "accepted a {cut}-byte envelope");
        }
    }

    #[test]
    fn the_x25519_keys_agree_in_both_directions() {
        // Sealing derives the recipient's X25519 public key from their did;
        // opening derives it from their secret. If those two disagree the
        // scheme silently fails to decrypt, so pin it directly.
        let (did, signing) = identity();
        let from_did = public_to_x25519(&did.verifying_key().unwrap()).unwrap();
        let from_secret = PublicKey::from(&secret_to_x25519(&signing));
        assert_eq!(from_did.as_bytes(), from_secret.as_bytes());
        // And that the did really is this key's did.
        assert_eq!(did_from_verifying(&signing.verifying_key()), did);
    }
}
