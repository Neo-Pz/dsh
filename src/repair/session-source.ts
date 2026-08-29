/**
 * Repairing sessions this plugin damaged before it knew better.
 *
 * `appendRemoteAgent` wrote `source: { provider, model }` with no `kind`. DSH
 * validates every persisted assistant message on load and requires `kind` to be
 * exactly `model`, so the append succeeded, the reply appeared on screen, and
 * the session became unloadable — surfacing days later as
 *
 *   SessionPersistenceCorruptionError: session event at seq 7
 *   message has invalid source
 *
 * The emitting bug is fixed. This is the other half: a session already written
 * stays written, and one bad field should not cost somebody their history.
 *
 * Deliberately narrow. It repairs the shape THIS plugin is known to have
 * produced — an assistant message whose source names iflow as the provider and
 * is missing `kind` — and reports anything else without touching it. Guessing
 * at data we did not write would be repairing by overwriting, and a wrong guess
 * here is indistinguishable from the truth afterwards.
 *
 * The store belongs to DSH. Nothing here runs without being asked, every repair
 * writes a backup first, and a dry run is the default.
 */

/** What this plugin wrote, and what DSH needs it to have written. */
const OUR_PROVIDER = 'iflow'

export interface SessionFinding {
  seq: number
  type: string
  reason: string
  repairable: boolean
}

/**
 * Read one decoded session's events and say what is wrong with them.
 *
 * Takes parsed events rather than a path so the judgement can be tested without
 * a filesystem, and so the caller owns the decompression — sessions are stored
 * as CONCATENATED zstd frames, and a decoder that stops after the first one
 * reports a clean bill of health for every session it looks at.
 */
export function inspectEvents(events: readonly unknown[]): SessionFinding[] {
  const findings: SessionFinding[] = []
  for (const raw of events) {
    const event = raw as Record<string, unknown>
    const type = typeof event.type === 'string' ? event.type : ''
    if (type !== 'user/message' && type !== 'assistant/message' && type !== 'tool/result') continue

    const data = event.data as Record<string, unknown> | undefined
    const message = (type === 'user/message' ? data : (data?.message as Record<string, unknown>)) ?? undefined
    const seq = typeof event.seq === 'number' ? event.seq : -1
    if (!message || typeof message !== 'object') {
      findings.push({ seq, type, reason: 'the event carries no message', repairable: false })
      continue
    }

    const source = message.source as Record<string, unknown> | undefined
    if (!source || typeof source !== 'object') {
      findings.push({ seq, type, reason: 'the message has no source at all', repairable: false })
      continue
    }

    const kind = source.kind
    if (typeof kind === 'string' && kind !== '') {
      // A present kind can still be the wrong one for the event type, and DSH
      // checks that too — but naming the right one would be a guess.
      if (type === 'assistant/message' && kind !== 'model') {
        findings.push({ seq, type, reason: `assistant message claims source.kind "${kind}"`, repairable: false })
      }
      continue
    }

    // Missing `kind`. Ours is recognisable: we are the only writer that names
    // iflow as the provider of a remote agent's reply.
    const ours = type === 'assistant/message' && source.provider === OUR_PROVIDER && typeof source.model === 'string'
    findings.push({
      seq,
      type,
      reason: ours
        ? 'written by an older iFlow: an assistant source with no kind'
        : 'source has no kind, and was not written by iFlow',
      repairable: ours,
    })
  }
  return findings
}

/**
 * Return the events with the repairable ones fixed.
 *
 * Pure, and returns a new array: the caller decides whether anything is written,
 * and a repair that mutated its input would make a dry run indistinguishable
 * from the real thing.
 */
export function repairEvents(events: readonly unknown[]): { events: unknown[]; repaired: number[] } {
  const repairable = new Set(inspectEvents(events).filter((f) => f.repairable).map((f) => f.seq))
  if (repairable.size === 0) return { events: [...events], repaired: [] }

  const repaired: number[] = []
  const next = events.map((raw) => {
    const event = raw as Record<string, unknown>
    if (typeof event.seq !== 'number' || !repairable.has(event.seq)) return raw
    const data = event.data as Record<string, unknown>
    const message = data.message as Record<string, unknown>
    repaired.push(event.seq)
    return {
      ...event,
      data: {
        ...data,
        message: {
          ...message,
          // Exactly what the fixed `appendRemoteAgent` writes. The provider and
          // model already there are kept — they are the true ones, and only the
          // kind was missing. Spread first so `kind` is what this line says it
          // is, rather than whatever a future looser predicate lets through.
          source: { ...(message.source as Record<string, unknown>), kind: 'model' },
        },
      },
    }
  })
  return { events: next, repaired }
}
