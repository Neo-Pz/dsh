/**
 * A2A wire shapes and the text extraction around them.
 *
 * Pure functions only — no transport, no runtime, no plugin state. Everything
 * here is about turning A2A's `parts` arrays and DSH's content blocks into the
 * plain text the two sides actually exchange.
 */

/** Task states from which no further transition is possible. */
export const TERMINAL_TASK_STATES = new Set([
  'TASK_STATE_COMPLETED',
  'TASK_STATE_FAILED',
  'TASK_STATE_CANCELED',
  'TASK_STATE_REJECTED',
])

export function rpcResult(id, result) { return { jsonrpc: '2.0', id, result } }
function rpcError(id, code, message, data) {
  const error = { code, message }
  if (data !== undefined) error.data = data
  return { jsonrpc: '2.0', id: id === undefined ? null : id, error }
}

export function rpcException(code, message, data) {
  const err = new Error(message)
  err.rpcCode = code
  err.rpcData = data
  return err
}

export function errorInfo(reason) {
  return [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason, domain: 'a2a-protocol.org' }]
}

export function messageText(message) {
  if (!message || !Array.isArray(message.parts)) return ''
  const chunks = []
  for (const part of message.parts) {
    if (!part || typeof part !== 'object') continue
    if (typeof part.text === 'string') chunks.push(part.text)
    else if (part.data !== undefined) chunks.push(JSON.stringify(part.data))
    else if (typeof part.url === 'string') chunks.push(part.url)
  }
  return chunks.join('\n')
}

export function partsText(parts) {
  if (!Array.isArray(parts)) return ''
  const chunks = []
  for (const part of parts) {
    if (!part || typeof part !== 'object') continue
    if (typeof part.text === 'string') chunks.push(part.text)
    else if (part.data !== undefined) chunks.push(JSON.stringify(part.data))
    else if (typeof part.url === 'string') chunks.push(part.url)
  }
  return chunks.join('\n')
}

export function taskText(task) {
  const fromArtifacts = task.artifacts && task.artifacts.length > 0
    ? task.artifacts.map((a) => partsText(a.parts)).filter((t) => t.length > 0).join('\n\n')
    : ''
  if (fromArtifacts) return fromArtifacts
  const statusMessage = task.status && task.status.message ? task.status.message : undefined
  return statusMessage ? partsText(statusMessage.parts) : ''
}

export function blocksToText(blocks) {
  return blocks
    .filter((b) => b && typeof b === 'object' && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n')
}

export function foldOutput(events) {
  let last
  const partial = []
  for (const event of events) {
    if (event && event.type === 'assistant/message') {
      const content = event.data && event.data.message ? event.data.message.content : undefined
      if (Array.isArray(content) && content.length > 0) last = content
    } else if (event && event.type === 'assistant/chunk' && event.data && event.data.chunk
      && event.data.chunk.type === 'text-delta' && typeof event.data.chunk.text === 'string') {
      partial.push(event.data.chunk.text)
    }
  }
  if (last !== undefined) return last
  const text = partial.join('')
  return text.length > 0 ? [{ type: 'text', text }] : []
}

export function eventText(d) {
  try {
    if (!d || !Array.isArray(d.content)) return ''
    return d.content.map(b => (b && typeof b.text === 'string' ? b.text : '')).join('')
  } catch (err) { return '' }
}

