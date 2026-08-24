/**
 * Where the star map puts things.
 *
 * Extracted from the component because it is the only real logic in the panel
 * and it is pure — a test can check it without a DOM, a React, or a bundle.
 * Everything else up there is markup.
 *
 * The layout is deterministic on purpose. A force simulation would move nodes
 * between renders, so an agent would not be where the operator last saw it,
 * and with the handful of peers a single machine actually knows a circle reads
 * better anyway. It also costs nothing: the client bundle may not carry a
 * graph library (test/client-bundle.test.mjs), and this is the whole reason
 * that constraint is affordable.
 */

export const MAP_SIZE = 340
export const MAP_CENTRE = MAP_SIZE / 2
export const MAP_RADIUS = 128

/**
 * Self at the centre, everyone else evenly around it, starting at 12 o'clock
 * and going clockwise.
 *
 * Returns a plain object keyed by agent id rather than a Map so the caller can
 * look up a position while rendering without a null dance.
 */
export function layoutAgents(nodes, selfAgentId, size = MAP_SIZE, radius = MAP_RADIUS) {
  const centre = size / 2
  const positions = {}
  if (!Array.isArray(nodes)) return positions

  const others = nodes.filter((node) => node && node.id !== selfAgentId)
  if (selfAgentId && nodes.some((node) => node && node.id === selfAgentId)) {
    positions[selfAgentId] = { x: centre, y: centre }
  }
  others.forEach((node, index) => {
    const angle = (index / Math.max(1, others.length)) * Math.PI * 2 - Math.PI / 2
    positions[node.id] = {
      x: centre + Math.cos(angle) * radius,
      y: centre + Math.sin(angle) * radius,
    }
  })
  return positions
}

/** Keep a node label short enough not to collide with its neighbours. */
export function shortenLabel(label, max = 16) {
  if (typeof label !== 'string') return ''
  return label.length > max ? `${label.slice(0, max - 1)}…` : label
}
