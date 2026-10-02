/** Shared A2A projections live in Connect; DSH event blocks remain here. */
export { TERMINAL_TASK_STATES, rpcResult, rpcError, rpcException, errorInfo, messageText, partsText, taskText } from '../generated/a2a.ts'

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

