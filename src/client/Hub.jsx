/**
 * The Hub: this machine's Agent network control plane.
 *
 * The panel used to be one thing — the publish gate — and that was the right
 * shape while publishing was the only decision it held. It is not any more:
 * a remote Agent can now ask to start a conversation, and someone here has to
 * answer. A single scrolling page cannot hold "what is waiting for me" and
 * "what does this machine publish" without one of them burying the other.
 *
 * So: five tabs, from the local operator's point of view rather than the
 * protocol's —
 *
 *   Requests      what is waiting for me
 *   Agents        who I know
 *   Network       who knows whom
 *   Transactions  what we have exchanged (later)
 *   Me            who I am, and what leaves this machine
 *
 * The publish gate lives in Me, and the tab defaults to Me whenever there is
 * nothing waiting — the gate must stay the first thing an idle operator sees,
 * which is the entire reason it was put in the sidebar to begin with.
 *
 * One poller. The five tabs share the `/iflow/panel/state` read this component
 * already makes, rather than each waking up on its own timer.
 */

import React from 'react'

import { api } from './api.js'
import { AgentsTab } from './Agents.jsx'
import { NetworkMap } from './NetworkMap.jsx'
import { IFlowPanel } from './Panel.jsx'
import { ChatsTab } from './Chats.jsx'
import { RequestsTab } from './Requests.jsx'

const POLL_MS = 5000

const TABS = [
  { id: 'requests', label: '待处理' },
  { id: 'chats', label: '对话' },
  { id: 'agents', label: 'Agents' },
  { id: 'network', label: '网络' },
  { id: 'transactions', label: '交易' },
  { id: 'me', label: '我' },
]

/**
 * Deliberately not "coming soon".
 *
 * Task, contract and settlement grow out of a conversation rather than being
 * launched from a button (§20), so this tab stays empty until there is a real
 * exchange to show. Saying what will appear, and what has to happen first, is
 * more honest than a spinner.
 */
function Transactions() {
  return (
    <div className="ifp-card">
      <div className="ifp-card-head">
        <h3>还没有交易</h3>
      </div>
      <p>
        任务、报价、交付和结算都从对话里自然长出来，不是从一个按钮开始的。
        等这台机器和别的 Agent 之间真的发生过一笔，这里才会有东西。
      </p>
    </div>
  )
}

export function IFlowHub({ workspacePicker } = {}) {
  const [state, setState] = React.useState(null)
  const [error, setError] = React.useState(null)
  const [tab, setTab] = React.useState(null)

  const refresh = React.useCallback(async () => {
    try {
      const next = await api.state()
      setState(next)
      setError(null)
      return next
    } catch (err) {
      setError(err.message)
      return null
    }
  }, [])

  React.useEffect(() => {
    let cancelled = false
    const run = async () => {
      const next = await refresh()
      // Pick the landing tab once, from the first successful read: what is
      // waiting for a person beats what this machine is doing. After that the
      // choice is theirs, and a poll must never move it under their cursor.
      if (!cancelled) {
        setTab((current) => (current === null ? ((next?.conversationsPending ?? 0) > 0 ? 'requests' : 'me') : current))
      }
    }
    run()
    const timer = setInterval(refresh, POLL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [refresh])

  if (!state && error) {
    return (
      <div className="ifp-root">
        <div className="ifp-head">
          <h2>iFlow · 弗流</h2>
          <p>{error}</p>
        </div>
      </div>
    )
  }

  if (!state) {
    return (
      <div className="ifp-root">
        <div className="ifp-head">
          <h2>iFlow · 弗流</h2>
          <p>正在读取本机状态…</p>
        </div>
      </div>
    )
  }

  const pending = state.conversationsPending ?? 0
  const active = tab ?? 'me'

  return (
    <div className="ifp-root">
      <div className="ifp-head">
        <h2>iFlow · 弗流</h2>
        <p>这台机器是一个 Agent 网络节点。它自己决定跟谁说话，以及公开什么。</p>
      </div>

      <div className="ifp-tabs" role="tablist">
        {TABS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            role="tab"
            aria-selected={active === entry.id}
            className={`ifp-tab${active === entry.id ? ' on' : ''}`}
            onClick={() => setTab(entry.id)}
          >
            {entry.label}
            {entry.id === 'requests' && pending > 0 ? <span className="ifp-badge">{pending}</span> : null}
          </button>
        ))}
      </div>

      {active === 'requests' ? <RequestsTab onChanged={refresh} /> : null}
      {active === 'chats' ? <ChatsTab /> : null}
      {active === 'agents' ? <AgentsTab state={state} /> : null}
      {active === 'network' ? <NetworkMap /> : null}
      {active === 'transactions' ? <Transactions /> : null}
      {active === 'me' ? <IFlowPanel state={state} onChanged={refresh} workspacePicker={workspacePicker} /> : null}

      {error ? <div className="ifp-error">{error}</div> : null}
    </div>
  )
}
