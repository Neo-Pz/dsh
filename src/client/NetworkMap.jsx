/**
 * Who knows whom.
 *
 * Nodes are Agents and edges are relationships — not tasks, not sessions, not
 * log lines. A graph drawn from work in progress shows what a machine is busy
 * with; a graph drawn from AgentRelation shows what a network is made of, and
 * only the second one is worth a tab. The server already filters to agent
 * nodes and `rel:` edges, so nothing else can arrive here to be drawn.
 *
 * WHY THIS IS HAND-DRAWN
 *
 * The client bundle may not carry cytoscape or reactflow — together they are
 * about 550KB, more than twice this entire plugin — and the rule is enforced by
 * test/client-bundle.test.mjs. That is a real constraint, but it costs less
 * than it sounds: with a handful of agents a deterministic circle is easier to
 * read than a force layout, and it never drifts between renders, so a node is
 * where you last saw it. This is a hundred lines and no dependency.
 *
 * When a force-directed view is genuinely needed, it belongs in the iFlowOne
 * web app, which has no such budget.
 */

import React from 'react'

import { api } from './api.js'
import { MAP_SIZE, layoutAgents, shortenLabel } from './map-layout.ts'
import { Card } from './ui.jsx'

const POLL_MS = 10000

/** Matches the edge kinds projectNetworkGraph derives from an AgentRelation. */
const EDGE_COLOR = {
  trust: '#a855f7',
  contact: '#94a3b8',
  collaboration: '#10b981',
  delegation: '#3b82f6',
  transaction: '#f59e0b',
}

const EDGE_LABEL = {
  trust: '信任',
  contact: '联系过',
  collaboration: '协作过',
  delegation: '委托过',
  transaction: '交易过',
}

export function NetworkMap() {
  const [graph, setGraph] = React.useState(null)
  const [error, setError] = React.useState(null)

  React.useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const result = await api.network()
        if (!cancelled) {
          setGraph(result)
          setError(null)
        }
      } catch (err) {
        if (!cancelled) setError(err.message)
      }
    }
    load()
    const timer = setInterval(load, POLL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [])

  if (!graph) {
    return (
      <Card>
        <p>{error ?? '正在读取…'}</p>
      </Card>
    )
  }

  // An empty graph is said plainly rather than drawn as a lonely dot. A circle
  // with one node in it looks like a rendering bug, not like "no relationships
  // yet", and the difference matters when someone is deciding whether the
  // feature works.
  if (graph.edges.length === 0) {
    return (
      <Card title="还没有和任何 Agent 打过交道" tone="off">
        <p>
          这张图画的是关系，不是任务。和别的 Agent 有过一次对话、一次委托或一次交易之后，
          这里才会出现连线——它来自真实发生过的事，不是从通讯录推出来的。
        </p>
      </Card>
    )
  }

  const positions = layoutAgents(graph.nodes, graph.selfAgentId)
  const kinds = [...new Set(graph.edges.map((e) => e.kind))]

  return (
    <>
      <Card title={`${graph.nodes.length} 个 Agent · ${graph.edges.length} 条关系`}>
        <svg className="ifp-map" viewBox={`0 0 ${MAP_SIZE} ${MAP_SIZE}`} role="img" aria-label="Agent 关系图">
          {graph.edges.map((edge) => {
            const from = positions[edge.source]
            const to = positions[edge.target]
            if (!from || !to) return null
            return (
              <line
                key={edge.id}
                x1={from.x}
                y1={from.y}
                x2={to.x}
                y2={to.y}
                stroke={EDGE_COLOR[edge.kind] ?? '#94a3b8'}
                strokeWidth="1.5"
              >
                <title>{edge.label ?? edge.kind}</title>
              </line>
            )
          })}
          {graph.nodes.map((node) => {
            const at = positions[node.id]
            if (!at) return null
            const isSelf = node.id === graph.selfAgentId
            return (
              <g key={node.id}>
                <circle
                  cx={at.x}
                  cy={at.y}
                  r={isSelf ? 9 : 6}
                  fill={isSelf ? '#2f6df6' : 'var(--dsw-alias-bg-overlay, #fff)'}
                  stroke={isSelf ? '#2f6df6' : '#94a3b8'}
                  strokeWidth="1.5"
                >
                  <title>{`${node.label}${node.status ? ` · ${node.status}` : ''}`}</title>
                </circle>
                <text
                  x={at.x}
                  y={at.y - (isSelf ? 15 : 12)}
                  textAnchor="middle"
                  className={`ifp-map-label${isSelf ? ' self' : ''}`}
                >
                  {shortenLabel(node.label)}
                </text>
              </g>
            )
          })}
        </svg>

        <ul className="ifp-legend">
          {kinds.map((kind) => (
            <li key={kind}>
              <span className="ifp-legend-dash" style={{ background: EDGE_COLOR[kind] ?? '#94a3b8' }} />
              {EDGE_LABEL[kind] ?? kind}
            </li>
          ))}
        </ul>
        <p className="ifp-muted">
          连线上的 ×N 是这段关系被重复确认的次数，不是评分。
        </p>
      </Card>
      {error ? <div className="ifp-error">{error}</div> : null}
    </>
  )
}
