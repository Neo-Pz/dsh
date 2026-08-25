/**
 * The DSH implementation of iFlow's `Signer` and `Verifier` ports.
 *
 * Key material never enters this process. The Rust `iflow-id` binary holds the
 * Ed25519 key and performs every operation; this file only decides WHICH bytes
 * get signed, and those bytes are settled by `iflow-protocol`'s canonical form.
 * That split is deliberate: two implementations of "what to sign" would drift,
 * and the network would fail with signature errors nobody could localise.
 *
 * Bytes travel through a scratch file rather than argv because Windows argv has
 * a hard length limit and a canonical event easily exceeds it.
 */

/**
 * @param run    invoke iflow-id with args, returning stdout (throws on non-zero).
 *               Takes an optional key directory: this node holds one key per
 *               declared Agent, so which key signs is part of the request.
 * @param writeScratch  persist bytes and return the path the binary should read
 * @param resolveHome   which key directory a signing context belongs to, or
 *                      undefined when this node holds no such key
 */
export function createIflowIdSigner({ run, writeScratch, logger, resolveHome }) {
  let cachedDid

  return {
    async did() {
      if (cachedDid) return cachedDid
      const out = await run(['show', '--json'])
      cachedDid = JSON.parse(out).did
      return cachedDid
    },

    /**
     * Sign as whoever the context names.
     *
     * With no context, or a context this node has no key for, the behaviour
     * differs sharply and on purpose:
     *
     *   no context        the node's own key — the single-identity case, and
     *                     every caller that predates declared Agents
     *   known identity    that identity's key
     *   unknown identity  REFUSE
     *
     * The refusal is the point. Substituting another key would attribute the
     * event to an Agent whose operator never signed it; the journal treats a
     * signing failure as "record it unsigned", and an unprovable fact is a far
     * better answer than a falsely attributed one.
     */
    async sign(bytes, context) {
      const named = context && (context.did || context.agentId)
      let home
      if (named && resolveHome) {
        home = resolveHome(context)
        if (!home) {
          throw new Error(
            `no key on this node for ${context.did ?? context.agentId}; refusing to sign as another identity`,
          )
        }
      }

      const path = await writeScratch('signable.bin', bytes)
      const out = await run(['sign-blob', path], home)
      const parsed = JSON.parse(out)
      if (!home && !cachedDid) cachedDid = parsed.signerDid
      return base64urlDecode(parsed.signature)
    },
  }
}

export function createIflowIdVerifier({ run, writeScratch, logger }) {
  return {
    async verify(bytes, signature, signerDid) {
      const path = await writeScratch('verifiable.bin', bytes)
      try {
        await run(['verify-blob', path, base64urlEncode(signature), signerDid])
        return true
      } catch (error) {
        // A non-zero exit is the binary's verdict — an invalid signature — not
        // a transport failure, so it is reported as `false` rather than thrown.
        // Anything else (missing binary, unreadable scratch) is logged, because
        // silently answering "not verified" would hide a broken toolchain.
        const message = String(error?.message ?? error)
        if (!/verification failed|signature error/i.test(message)) {
          logger?.warn?.(`iFlow: signature check could not run: ${message}`)
        }
        return false
      }
    },
  }
}

function base64urlEncode(bytes) {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return Buffer.from(binary, 'binary').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function base64urlDecode(text) {
  return new Uint8Array(Buffer.from(text.replace(/-/g, '+').replace(/_/g, '/'), 'base64'))
}
