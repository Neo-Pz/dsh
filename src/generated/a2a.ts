// GENERATED from iFlow Connect/packages/iflow-protocol/src/a2a.ts; SHA256 9a5204323e39becb7e2bdb75b372f2b45a831d0a3ec479e05e9306f5f190af75
// Regenerate: node ../iflow-connect/scripts/sync-connect-snapshots.mjs. Do not edit.
/** A2A JSON-RPC and text projections. No transport or host event vocabulary. */
export const TERMINAL_TASK_STATES = new Set([
  'TASK_STATE_COMPLETED', 'TASK_STATE_FAILED', 'TASK_STATE_CANCELED', 'TASK_STATE_REJECTED',
])
export type RpcId = string | number | null
export interface RpcResult<T> { jsonrpc: '2.0'; id: RpcId | undefined; result: T }
export interface RpcError { jsonrpc: '2.0'; id: RpcId; error: { code: number; message: string; data?: unknown } }
export interface RpcException extends Error { rpcCode: number; rpcData?: unknown }

export function rpcResult<T>(id: RpcId | undefined, result: T): RpcResult<T> { return { jsonrpc: '2.0', id, result } }
export function rpcError(id: RpcId | undefined, code: number, message: string, data?: unknown): RpcError {
  const error: RpcError['error'] = { code, message }
  if (data !== undefined) error.data = data
  return { jsonrpc: '2.0', id: id === undefined ? null : id, error }
}
export function rpcException(code: number, message: string, data?: unknown): RpcException {
  const err = new Error(message) as RpcException
  err.rpcCode = code
  err.rpcData = data
  return err
}
export function errorInfo(reason: string): Array<{ '@type': string; reason: string; domain: string }> {
  return [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason, domain: 'a2a-protocol.org' }]
}
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value) }
export function partsText(parts: unknown): string {
  if (!Array.isArray(parts)) return ''
  const chunks: string[] = []
  for (const part of parts) {
    if (!object(part)) continue
    if (typeof part.text === 'string') chunks.push(part.text)
    else if (part.data !== undefined) chunks.push(JSON.stringify(part.data))
    else if (typeof part.url === 'string') chunks.push(part.url)
  }
  return chunks.join('\n')
}
export function messageText(message: unknown): string { return object(message) ? partsText(message.parts) : '' }
/** Preserve artifact-first behavior, including nonempty terminal rejection text. */
export function taskText(task: unknown): string {
  if (!object(task)) return ''
  const artifacts = Array.isArray(task.artifacts) && task.artifacts.length > 0
    ? task.artifacts.map((a: unknown) => object(a) ? partsText(a.parts) : '').filter((text: string) => text.length > 0).join('\n\n')
    : ''
  if (artifacts) return artifacts
  const status = object(task.status) ? task.status : undefined
  return status && object(status.message) ? partsText(status.message.parts) : ''
}
