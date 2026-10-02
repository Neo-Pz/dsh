// GENERATED from iFlow Connect/packages/iflow-protocol/src/ard.ts; SHA256 9a2d6ea51d695bbb8085af92fdf6e4b3822bd2ace37f5b6d63b310031c4791ff
// Regenerate: node ../iflow-connect/scripts/sync-connect-snapshots.mjs. Do not edit.
/** ARD v0.91 interoperability profile. Source: ard-spec at b76f235.
 * Discovery is evidence, never an execution grant. No network or runtime imports.
 */
export const ARD_CONTEXT = 'https://agenticresourcediscovery.org/context/v1'
export const ARD_NAMESPACE = 'https://agenticresourcediscovery.org/ns#'
export const ARD_A2A_TYPE = 'application/a2a-agent-card+json'
export const ARD_REGISTRY_TYPE = 'application/ai-registry+json'
export const ARD_SPEC_VERSION = '0.91'

export type ArdContext = string | Record<string, unknown> | Array<string | Record<string, unknown>>
export interface ArdEntry {
  '@context'?: ArdContext
  identifier: string
  displayName: string
  type: string
  url?: string
  data?: unknown
  description?: string
  representativeQueries?: string[]
  capabilities?: string[]
  tags?: string[]
  version?: string
  updatedAt?: string
  metadata?: Record<string, unknown>
  trustManifest?: Record<string, unknown> & { identity: string }
  [term: string]: unknown
}
export interface ArdManifest { entries: ArdEntry[] }
export interface ArdSearchRequest {
  query: { '@context'?: ArdContext; text: string; filter?: Record<string, string | string[]> }
  federation?: 'auto' | 'none' | 'referrals'
  pageSize?: number
  pageToken?: string
}
export type ArdSearchResult = Partial<ArdEntry> & { identifier: string; score?: number }
export interface ArdSearchResponse {
  results: ArdSearchResult[]
  referrals?: ArdEntry[]
  pageToken?: string
}
/** Explicitly public, operator-authored profile. The card names one Agent. */
export interface AgentDiscoveryProfile {
  description: string
  representativeQueries: string[]
  tags: string[]
  card: {
    name: string
    description: string
    version: string
    supportedInterfaces: Array<{ url: string; protocolBinding: 'JSONRPC'; protocolVersion: string }>
    capabilities: { streaming: boolean; pushNotifications: boolean; extendedAgentCard: boolean }
    defaultInputModes: string[]
    defaultOutputModes: string[]
    skills: Array<{ id: string; name: string; description: string; tags: string[]; examples: string[] }>
    identity: { did: string; agentId: string }
  }
}
export interface DiscoverySearchIntent { version: 1; kind: 'discovery.search'; request: ArdSearchRequest }
export interface DiscoverySearchView {
  version: 1
  kind: 'discovery.results'
  ownAgentId: string
  registry: string
  matching: 'keyword'
  response: ArdSearchResponse
}
export interface DiscoveryErrorView { version: 1; kind: 'discovery.error'; ownAgentId: string; code: 'search_unavailable'; message: string }

export class ArdValidationError extends Error {
  readonly code = 'invalid_ard_request'
  constructor(message: string) { super(message); this.name = 'ArdValidationError' }
}
export function ardObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}
const string = (v: unknown, max = 2048): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= max
const strings = (v: unknown, count = 64): v is string[] => Array.isArray(v) && v.length <= count && v.every((s) => string(s, 256))
export function validateArdEntry(value: unknown): { valid: boolean; errors: string[]; warnings: string[] } {
  const errors: string[] = []; const warnings: string[] = []
  if (!ardObject(value)) return { valid: false, errors: ['entry must be an object'], warnings }
  if (!string(value.identifier, 1024) || !/^urn:air:[a-zA-Z0-9.-]+:[a-zA-Z0-9._:-]+:[a-zA-Z0-9._-]+$/.test(value.identifier)) errors.push('identifier must be a domain-anchored urn:air')
  if (!string(value.displayName, 256)) errors.push('displayName is required')
  if (!string(value.type, 256) || !/^[\w!#$&^_.+-]+\/[\w!#$&^_.+-]+(?:\s*;[^\r\n]+)?$/.test(value.type)) errors.push('type must be a media type')
  if (Object.hasOwn(value, 'url') === Object.hasOwn(value, 'data')) errors.push('exactly one of url and data is required')
  if (Object.hasOwn(value, 'url')) {
    try { if (!string(value.url) || !new URL(value.url).protocol) errors.push('url must be absolute') } catch { errors.push('url must be absolute') }
  }
  for (const field of ['capabilities', 'tags', 'representativeQueries']) {
    if (value[field] !== undefined && !strings(value[field])) errors.push(`${field} must be an array of strings`)
  }
  if (!Array.isArray(value.representativeQueries) || value.representativeQueries.length < 2 || value.representativeQueries.length > 5) warnings.push('representativeQueries should contain 2–5 examples')
  if (value.trustManifest !== undefined && (!ardObject(value.trustManifest) || !string(value.trustManifest.identity))) errors.push('trustManifest.identity is required')
  return { valid: errors.length === 0, errors, warnings }
}

/** Publication permits HTTPS public routes only; credentials and local addresses never become catalog data. */
export function isPublicArdUrl(value: unknown): value is string {
  if (!string(value)) return false
  try {
    const url = new URL(value)
    const host = url.hostname.toLowerCase()
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return false
    if (!host.includes('.') || host.endsWith('.local') || host.endsWith('.localhost') || host.endsWith('.internal') || host.includes(':')) return false
    if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
      const [a, b] = host.split('.').map(Number)
      if (a === 0 || a === 10 || a === 127 || a! >= 224 || (a === 169 && b === 254) || (a === 172 && b! >= 16 && b! <= 31) || (a === 192 && b === 168) || (a === 100 && b! >= 64 && b! <= 127)) return false
    }
    return true
  } catch { return false }
}
export function validateAgentDiscoveryProfile(value: unknown, agentId: string, did: string): value is AgentDiscoveryProfile {
  if (!ardObject(value) || !string(value.description) || !strings(value.representativeQueries, 5) || value.representativeQueries.length < 2 || !strings(value.tags, 20)) return false
  const card = value.card
  if (!ardObject(card) || !ardObject(card.identity) || card.identity.agentId !== agentId || card.identity.did !== did) return false
  if (!string(card.name, 256) || card.description !== value.description || !string(card.version, 64)) return false
  if (!Array.isArray(card.supportedInterfaces) || card.supportedInterfaces.length !== 1) return false
  const route = card.supportedInterfaces[0]
  if (!ardObject(route) || !isPublicArdUrl(route.url) || route.protocolBinding !== 'JSONRPC' || route.protocolVersion !== '1.0') return false
  if (!ardObject(card.capabilities) || card.capabilities.streaming !== false || card.capabilities.pushNotifications !== false || card.capabilities.extendedAgentCard !== false) return false
  if (!strings(card.defaultInputModes) || !strings(card.defaultOutputModes) || !Array.isArray(card.skills) || card.skills.length === 0 || card.skills.length > 20) return false
  return card.skills.every((skill) => ardObject(skill) && string(skill.id, 128) && string(skill.name, 256) && string(skill.description) && strings(skill.tags, 20) && strings(skill.examples, 5))
}

const TERM_IRIS: Record<string, string> = Object.fromEntries([
  'identifier', 'displayName', 'description', 'tags', 'capabilities', 'version', 'updatedAt', 'metadata', 'trustManifest', 'url', 'data', 'representativeQueries',
].map((term) => [term, ARD_NAMESPACE + term]))
TERM_IRIS.type = ARD_NAMESPACE + 'mediaType'
/** Bounded JSON-LD context profile: pinned base context + inline aliases. Never fetch remote contexts. */
function effectiveContext(context?: ArdContext): Record<string, string> {
  const terms: Record<string, string> = { ...TERM_IRIS, ard: ARD_NAMESPACE, '@vocab': ARD_NAMESPACE }
  const layers = context === undefined ? [] : Array.isArray(context) ? context : [context]
  if (layers.length > 8) throw new ArdValidationError('too many context layers')
  for (const layer of layers) {
    if (layer === ARD_CONTEXT) continue
    if (!ardObject(layer) || Object.keys(layer).length > 64) throw new ArdValidationError('only the ARD base context and inline contexts are supported')
    for (const [key, definition] of Object.entries(layer)) {
      const id = typeof definition === 'string' ? definition : ardObject(definition) && typeof definition['@id'] === 'string' ? definition['@id'] : undefined
      if (!id) throw new ArdValidationError('unsupported JSON-LD context definition')
      terms[key] = id
    }
  }
  return terms
}
function expandTerm(key: string, terms: Record<string, string>, seen = new Set<string>()): string {
  if (seen.has(key)) throw new ArdValidationError('cyclic context definition')
  if (key.startsWith('https://') || key.startsWith('http://')) return key
  seen.add(key)
  const definition = terms[key]
  if (definition && definition !== key) return expandTerm(definition, terms, seen)
  const colon = key.indexOf(':')
  if (colon > 0) {
    const prefix = key.slice(0, colon)
    if (terms[prefix]) return expandTerm(terms[prefix]!, terms, seen) + key.slice(colon + 1)
    return key
  }
  return (terms['@vocab'] ?? ARD_NAMESPACE) + key
}
export function parseArdSearchRequest(value: unknown): ArdSearchRequest {
  if (!ardObject(value) || !ardObject(value.query) || !string(value.query.text)) throw new ArdValidationError('query.text must contain 1–2048 characters')
  if (Object.keys(value).some((key) => !['query', 'pageSize', 'pageToken', 'federation'].includes(key)) || Object.keys(value.query).some((key) => !['text', 'filter', '@context'].includes(key))) throw new ArdValidationError('unsupported search request field')
  if (value.pageSize !== undefined && (!Number.isInteger(value.pageSize) || Number(value.pageSize) < 1 || Number(value.pageSize) > 100)) throw new ArdValidationError('pageSize must be an integer from 1–100')
  if (value.pageToken !== undefined && !string(value.pageToken, 4096)) throw new ArdValidationError('invalid pageToken')
  if (value.federation !== undefined && !['auto', 'none', 'referrals'].includes(String(value.federation))) throw new ArdValidationError('invalid federation mode')
  const terms = effectiveContext(value.query['@context'] as ArdContext | undefined)
  const filter = value.query.filter
  if (filter !== undefined) {
    if (!ardObject(filter) || Object.keys(filter).length > 16) throw new ArdValidationError('filter must be an object with at most 16 constraints')
    for (const [key, expected] of Object.entries(filter)) {
      const iri = expandTerm(key, terms)
      if (key !== 'publisher' && !Object.values(TERM_IRIS).includes(iri)) throw new ArdValidationError(`unsupported filter term: ${key}`)
      if (!string(expected, 256) && (!strings(expected, 32) || expected.length === 0)) throw new ArdValidationError('filter values must be strings or nonempty string arrays')
    }
  }
  return JSON.parse(JSON.stringify(value)) as ArdSearchRequest
}
export function matchesArdFilter(entry: ArdEntry, request: ArdSearchRequest): boolean {
  const queryTerms = effectiveContext(request.query['@context'])
  const entryTerms = effectiveContext(entry['@context'])
  return Object.entries(request.query.filter ?? {}).every(([key, expected]) => {
    const wanted = Array.isArray(expected) ? expected : [expected]
    if (key === 'publisher') return wanted.includes(entry.identifier.split(':')[2]!)
    const iri = expandTerm(key, queryTerms)
    const values = Object.entries(entry).filter(([term]) => !term.startsWith('@') && expandTerm(term, entryTerms) === iri).flatMap(([, v]) => Array.isArray(v) ? v : [v])
    return values.some((actual) => typeof actual === 'string' && wanted.includes(actual))
  })
}
/** Deterministic first-stage recall. Score represents keyword relevance only. */
export function rankArdEntries(entries: readonly ArdEntry[], request: ArdSearchRequest): ArdSearchResult[] {
  const tokens = [...new Set(request.query.text.toLocaleLowerCase('en').match(/[\p{L}\p{N}]+/gu) ?? [])]
  if (tokens.length === 0) return []
  return entries.filter((entry) => matchesArdFilter(entry, request)).map((entry) => {
    const haystack = [entry.displayName, entry.description ?? '', ...(entry.representativeQueries ?? []), ...(entry.capabilities ?? []), ...(entry.tags ?? [])].join(' ').toLocaleLowerCase('en')
    return { ...entry, score: tokens.filter((token) => haystack.includes(token)).length / tokens.length }
  }).filter((entry) => entry.score > 0).sort((a, b) => b.score - a.score || (a.identifier < b.identifier ? -1 : a.identifier > b.identifier ? 1 : 0))
}
export function isArdSearchResponse(value: unknown): value is ArdSearchResponse {
  if (!ardObject(value) || !Array.isArray(value.results) || value.results.length > 100 || (value.pageToken !== undefined && !string(value.pageToken, 4096))) return false
  return value.results.every((item) => ardObject(item) && string(item.identifier, 1024) && /^urn:air:/.test(item.identifier) && (item.score === undefined || (typeof item.score === 'number' && Number.isFinite(item.score) && item.score >= 0 && item.score <= 1)) && (item.displayName === undefined || string(item.displayName, 256)) && (item.description === undefined || string(item.description)) && (item.capabilities === undefined || strings(item.capabilities)) && (item.tags === undefined || strings(item.tags)) && (item.metadata === undefined || ardObject(item.metadata)))
}
