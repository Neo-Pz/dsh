/**
 * Can the identity binary on this machine do what this plugin needs?
 *
 * The binary is cached at `<workspace>/.iflow/bin/` on purpose, so a plugin
 * upgrade does not lose it. That is right for "do not re-download every time"
 * and wrong the moment the binary gains a command: the cached copy is found
 * first, the new one is never fetched, and a feature that shipped in the
 * plugin fails at runtime against a binary from before it existed.
 *
 * A version number would not settle it on its own, because a binary can also
 * arrive from a hand copy or a developer's `cargo build`. So the question
 * asked is not "which version is this" but "can it do the thing", answered the
 * same way whatever its provenance.
 */

/** What this plugin needs, and what stops working without each one. */
export const IFI_CAPABILITIES = Object.freeze({
  '--node-home': 'keep revocations and pricing node-wide across Agent identities',
  seal: 'sealing messages for the relay',
  open: 'opening messages from the relay',
})

/**
 * Does this `help` output advertise this command?
 *
 * The command at the start of a line, followed by an argument placeholder.
 * The placeholder is what separates a usage line from prose — `help` wraps
 * descriptions, and one wrapped line in the current text begins "seal a
 * message so only that peer can read it", which a looser match reads as proof
 * that `seal` exists.
 *
 * Wrong in the permissive direction means believing a feature is available and
 * failing later with a confusing subprocess error; wrong the other way means
 * one unnecessary download. The bias is deliberate.
 */
export function helpAdvertises(help, command) {
  if (typeof help !== 'string' || help.length === 0) return false
  return new RegExp(`^\\s+${command}\\s+[<\\[]`, 'm').test(help)
}

/** Which required commands this binary does not have. */
export function missingCapabilities(help) {
  return Object.keys(IFI_CAPABILITIES).filter((command) => !helpAdvertises(help, command))
}

/**
 * What to tell someone whose binary is behind their plugin.
 *
 * Three causes, and only two are the operator's to fix. Saying so matters: the
 * advice used to be "delete it and re-fetch", which loops forever when the
 * published Release is what is behind, and leaves someone repeating a step
 * that cannot possibly work.
 */
export function staleBinaryAdvice(binPath, cachePath, missing) {
  const cannot = missing.map((command) => IFI_CAPABILITIES[command]).join(' or ')
  return [
    `iFlow: the identity binary at ${binPath} is older than this plugin — it cannot ${cannot}.`,
    'Everything else works. One of three things is true:',
    `  · a stale cached copy — delete ${cachePath} and run iflow_fetch_identity`,
    '  · a local build you would rather use — point IFLOW_ID_PATH at it',
    '  · the published Release has not caught up with this plugin — nothing on this',
    '    machine fixes that; a new binary has to be tagged and built first',
  ].join('\n')
}
