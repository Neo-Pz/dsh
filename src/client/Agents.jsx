/**
 * Who this machine knows.
 *
 * Two different kinds of Agent, kept apart because confusing them is how a
 * network view starts lying:
 *
 *   declared here  — Agents this operator created, each holding a key of its
 *                    own, bound to the Principal by a signed grant. These are
 *                    identities this machine can *speak as*.
 *   registered peers — remote endpoints someone added by name and URL. These
 *                    are machines this one can *speak to*.
 *
 * Reachability is a snapshot, not an asset: it is stamped at start-up and
 * refreshed only when someone asks, because probing every peer on a timer is
 * a scheduled port-scan of other people's machines.
 */

import React from 'react'

import { api } from './api.js'
import { Ago, Card } from './ui.jsx'

function Peer({ peer }) {
  const tone = peer.healthy === true ? 'on' : peer.healthy === false ? 'off' : 'warn'
  const label = peer.healthy === true ? '在线' : peer.healthy === false ? '离线' : '未探测'
  return (
    <li>
      <span className={`ifp-dot ${tone}`} />
      <span>
        <b>{peer.name}</b>
        {peer.tokenSet ? <span className="ifp-tag never">已设令牌</span> : null}
        <br />
        <span className="ifp-mono ifp-muted ifp-wrap">{peer.url}</span>
        <br />
        <span className="ifp-muted">
          {label} · 最后可见 <Ago at={peer.lastSeen} />
        </span>
      </span>
    </li>
  )
}

export function AgentsTab({ state }) {
  const [peers, setPeers] = React.useState(null)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState(null)

  // Start from the Hub's polled snapshot; replace it only when a probe returns
  // something fresher, so switching to this tab never blanks the list.
  const shown = peers ?? state.peers ?? []
  const declared = state.declaredAgents ?? []

  const probe = async () => {
    setBusy(true)
    setError(null)
    try {
      const result = await api.probePeers()
      setPeers(result.peers ?? [])
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <Card
        title={`已注册的对端（${shown.length}）`}
        actions={
          <button className="ifp-btn" disabled={busy} onClick={probe}>
            {busy ? '正在探测…' : '刷新在线状态'}
          </button>
        }
      >
        {shown.length === 0 ? (
          <p>
            还没有注册任何对端。用 <span className="ifp-mono">iflow_add_peer</span> 添加一台机器的名字和地址，
            之后就能和它上面的 Agent 对话。
          </p>
        ) : (
          <ul className="ifp-list">
            {shown.map((peer) => (
              <Peer key={peer.name} peer={peer} />
            ))}
          </ul>
        )}
      </Card>

      <Card title={`这台机器声明的 Agent（${declared.length}）`}>
        {declared.length === 0 ? (
          <p>
            还没有声明任何 Agent。在「我」里先声明一个 Principal，再声明 Agent——
            每个 Agent 会拿到自己的密钥，由 Principal 签发的授权把两者绑在一起。
          </p>
        ) : (
          <ul className="ifp-list">
            {declared.map((agent) => (
              <li key={agent.agentId}>
                <span className="ifp-tag never">{agent.agentId}</span>
                <span>
                  <b>{agent.label}</b>
                  <br />
                  <span className="ifp-mono ifp-muted ifp-wrap">{agent.did}</span>
                  <br />
                  <span className="ifp-muted">
                    {(agent.capabilities ?? []).join('、') || '无声明能力'}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {error ? <div className="ifp-error">{error}</div> : null}
    </>
  )
}
