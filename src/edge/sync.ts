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
 * those are what the projections are built from. Redacting these two therefore
 * costs the network nothing it uses, while a task title is exactly the field
 * that leaks what someone is working on.
 */
const FREE_TEXT_KEYS = ['title', 'reason']

const REDACTED = '[redacted at origin]'

/**
 * Return the event as it should leave this machine.
 *
 * A redacted event is NOT the signed original, and it says so: the signature is
 * dropped and a `redaction` note takes its place. Keeping a signature over a
 * body that no longer matches it would be worse than having none — a verifier
 * would report a forgery, which is precisely the wrong answer.
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
  delete copy.signature
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
    } catch (err) {
      console.error('iFlow sync failed (facts stay queued):', err && err.message ? err.message : err)
    } finally {
      running = false
    }
  }

  void flush()
  const timer = setInterval(() => void flush(), everyMs)
  return () => clearInterval(timer)
}
