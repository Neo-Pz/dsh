/**
 * Outbound sync — the only code that sends this machine's facts anywhere.
 *
 * It lives in the open-source half on purpose. An adapter that uploads what it
 * observed is exactly the part nobody should have to take on trust, so the
 * rules are here, in one file, readable by the person deciding whether to turn
 * it on:
 *
 *   - It is OFF unless an operator configures a Community URL and token.
 *     Installing the plugin does not publish anything.
 *   - It only ever POSTs. The Community is dialled out to; it never dials in,
 *     and nothing here opens a port or accepts a connection.
 *   - It uploads the outbox, which is the Origin Journal filtered to facts —
 *     never files, never tool arguments, never prompts, never credentials.
 *   - Before anything leaves, free text is redacted unless the operator asked
 *     for `full`. What was removed is named in the envelope rather than
 *     silently dropped.
 */

/**
 * Payload keys that carry human-written text rather than structure.
 *
 * Everything else an event holds is an id, a name, a state or a timestamp, and
 * those are what the projections are built from. Redacting these therefore
 * costs the network nothing it uses, while a task title is exactly the field
 * that leaks what someone is working on — and `text`, the body of an
 * agent-to-agent message, is the most revealing field this node ever holds.
 */
const FREE_TEXT_KEYS = ['title', 'reason', 'text']

const REDACTED = '[redacted at origin]'

/**
 * Return the event as it should leave this machine.
 *
 * A redacted event is NOT the signed original, and it says so: the origin
 * signature at `evidence.signature` is dropped and a `redaction` note takes its
 * place. Keeping a signature over a body that no longer matches would be worse
 * than having none — a verifier would report a forgery, which is precisely the
 * wrong answer, and an accusation against a node that did nothing wrong.
 *
 * The signed original never moves. It stays in this node's journal, which is
 * where an audit that needs the full text has to look, with the node's consent.
 */
export function redactEvent(event, visibility) {
  if (visibility === 'full') return event

  const payload = event.payload
  if (!payload || typeof payload !== 'object') return event

  const removed = FREE_TEXT_KEYS.filter((key) => typeof payload[key] === 'string' && payload[key].length > 0)
  if (removed.length === 0) return event

  const redactedPayload = { ...payload }
  for (const key of removed) redactedPayload[key] = REDACTED

  const copy = { ...event, payload: redactedPayload }

  // The signature lives at `evidence.signature`, and it covers the body that is
  // about to change. Leaving it on a redacted event would make a verifier
  // report a FORGERY — a much worse answer than "unsigned", and a false
  // accusation against the node that honestly reported the fact.
  if (copy.evidence && copy.evidence.signature) {
    const { signature, ...rest } = copy.evidence
    copy.evidence = rest
  }

  copy.redaction = {
    fields: removed.map((key) => `payload.${key}`),
    reason: 'free text is not published by default; the signed original stays on the origin node',
  }
  return copy
}

/**
 * A `SyncSink` that publishes to an iFlowOne Community.
 *
 * The contract the outbox relies on: publishing an event that was already
 * accepted is a normal retry, and the sink must report it accepted again so
 * the queue can drain. The Community deduplicates on the event's own id, so
 * that holds without any state here.
 */
export function createCommunitySink(options) {
  const base = options.url.replace(/\/+$/, '')
  const visibility = options.visibility === 'full' ? 'full' : 'structural'

  return {
    async publish(events) {
      const body = events.map((event) => JSON.stringify(redactEvent(event, visibility))).join('\n')

      const response = await fetch(`${base}/v1/edge/events`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-ndjson',
          Authorization: `Bearer ${options.token}`,
        },
        body,
      })

      if (!response.ok) {
        // Throwing leaves every event queued. An upload we cannot confirm is an
        // upload that has not happened.
        throw new Error(`community returned ${response.status} for /v1/edge/events`)
      }

      const result = await response.json()
      const accepted = Array.isArray(result?.acceptedEventIds) ? result.acceptedEventIds : []
      return { acceptedEventIds: accepted }
    },
  }
}

/**
 * Flush the outbox to a Community on a timer, and once at startup.
 *
 * Returns a disposer. Failures are logged and left queued — a Community outage
 * must never disturb local work, which is the first of the five failure tests.
 */
export function startCommunitySync(ctx, edge, options) {
  const sink = createCommunitySink(options)
  const everyMs = Number.isFinite(options.intervalMs) && options.intervalMs > 0 ? options.intervalMs : 60_000

  // The outbox holds ids; the journal holds the facts. Reading the body from
  // the journal keeps one copy of every fact rather than two that can drift.
  const resolveEvent = (eventId) => edge.journal.all().find((event) => event.id === eventId)

  /**
   * Move the journal's `syncedSeq` up to what has actually been delivered.
   *
   * The outbox tracks delivery per event; the journal keeps a single watermark,
   * and nothing was connecting them — so `/iflow/edge/status` reported
   * `syncedSeq: 0` on a node whose entire outbox had drained, which reads as
   * "nothing has ever synced".
   *
   * The watermark is the last CONTIGUOUS delivered sequence: everything below
   * the lowest still-queued event. Using the highest delivered seq instead
   * would claim a gap was synced the moment one late event slipped past an
   * earlier one.
   */
  const advanceWatermark = async () => {
    const pending = edge.outbox.pending()
    const watermark = pending.length === 0
      ? edge.journal.lastSeq
      : Math.min(...pending.map((entry) => entry.seq)) - 1
    if (watermark > edge.journal.syncedSeq) {
      await edge.journal.markSynced(watermark)
    }
  }

  let running = false
  const flush = async () => {
    if (running) return
    running = true
    try {
      const result = await edge.outbox.flush(sink, resolveEvent)
      if (result.attempted > 0) {
        console.log(
          `iFlow sync: ${result.delivered}/${result.attempted} facts accepted by ${options.url}` +
            (result.error ? ` (${result.error})` : ''),
        )
      }
      await advanceWatermark()
    } catch (err) {
      console.error('iFlow sync failed (facts stay queued):', err && err.message ? err.message : err)
    } finally {
      running = false
    }
  }

  void flush()
  const timer = setInterval(() => void flush(), everyMs)
  // A timer that only waits to upload must not be a reason for the process to
  // stay alive. Without this the host cannot exit while sync is armed, which
  // shows up as a runtime that will not shut down and as test runs that hang.
  if (typeof timer.unref === 'function') timer.unref()
  return () => clearInterval(timer)
}
