/**
 * Who this machine speaks for.
 *
 * Identity has two layers, and this is where a person creates both. The order
 * is not a formality: an Agent with no Principal behind it cannot be held to
 * anything it agrees to, so the form for declaring one does not appear until a
 * Principal exists.
 *
 * What the UI has to convey, and what most identity forms get wrong: these
 * actions mint keys. The Principal key in particular is the root every grant on
 * this node hangs off — replacing it would orphan all of them — so it is
 * created once, deliberately, with that stated up front rather than discovered
 * later.
 */

import React from 'react'

import { api } from './api.js'

/** `iflow.cap:<domain>.<op>` — the same vocabulary grants and quotes use. */
const SUGGESTED_CAPABILITIES = [
  'iflow.cap:task.run',
  'iflow.cap:tool.call',
  'iflow.cap:a2a.receive',
]

function PrincipalForm({ busy, onDeclare }) {
  const [label, setLabel] = React.useState('')

  return (
    <div className="ifp-card ifp-consent">
      <h3>先声明「谁在负责」</h3>
      <p>
        这台机器上的每个 Agent 都要有一个负责人——一个人或一个组织。
        它持有一把密钥，用来签发授权给下面的 Agent；将来对外达成的协议，也由这把密钥签字。
      </p>
      <p className="ifp-muted">
        这把密钥是这个节点上所有授权的根，只创建一次。换掉它会让已经签发的授权全部失效。
        密钥保存在本机 <span className="ifp-mono">.iflow/principal/</span>，不会离开这台机器。
      </p>
      <label className="ifp-field">
        <span>名称（对外显示，可以是你的名字或公司名）</span>
        <input
          value={label}
          onChange={(event) => setLabel(event.target.value)}
          placeholder="例如：张三 / Acme Ltd"
          maxLength={64}
        />
      </label>
      <div className="ifp-actions">
        <button className="ifp-btn primary" disabled={busy || !label.trim()} onClick={() => onDeclare(label.trim())}>
          {busy ? '正在生成密钥…' : '声明负责人'}
        </button>
      </div>
    </div>
  )
}

function AgentForm({ busy, onDeclare, onCancel }) {
  const [agentId, setAgentId] = React.useState('')
  const [label, setLabel] = React.useState('')
  const [capabilities, setCapabilities] = React.useState(SUGGESTED_CAPABILITIES.slice(0, 1))

  const toggle = (cap) =>
    setCapabilities((current) => (current.includes(cap) ? current.filter((c) => c !== cap) : [...current, cap]))

  const idValid = /^[a-z0-9][a-z0-9-]{0,62}$/i.test(agentId)

  return (
    <div className="ifp-card ifp-consent">
      <h3>声明一个 Agent</h3>
      <p>
        一个 Agent 是这台机器对外的一个角色：它有自己的密钥和身份，别人可以发现它、跟它对接、把活派给它。
        声明之后，负责人会给它签一张授权，写明它能做什么、到什么时候为止。
      </p>
      <label className="ifp-field">
        <span>标识（网络上的地址，字母数字和连字符）</span>
        <input
          value={agentId}
          onChange={(event) => setAgentId(event.target.value)}
          placeholder="例如：frontend-review"
          maxLength={63}
        />
      </label>
      <label className="ifp-field">
        <span>显示名</span>
        <input
          value={label}
          onChange={(event) => setLabel(event.target.value)}
          placeholder="例如：前端审阅"
          maxLength={64}
        />
      </label>
      <div className="ifp-field">
        <span>能力（授权里会写死这些，超出范围的请求会被拒绝）</span>
        <div className="ifp-caps">
          {SUGGESTED_CAPABILITIES.map((cap) => (
            <label key={cap} className="ifp-cap">
              <input type="checkbox" checked={capabilities.includes(cap)} onChange={() => toggle(cap)} />
              <span className="ifp-mono">{cap}</span>
            </label>
          ))}
        </div>
      </div>
      <div className="ifp-actions">
        <button
          className="ifp-btn primary"
          disabled={busy || !idValid || capabilities.length === 0}
          onClick={() => onDeclare({ agentId: agentId.trim(), label: label.trim() || agentId.trim(), capabilities })}
        >
          {busy ? '正在生成密钥并签授权…' : '声明并签授权'}
        </button>
        <button className="ifp-btn" disabled={busy} onClick={onCancel}>
          取消
        </button>
      </div>
      {agentId && !idValid ? <div className="ifp-error">标识只能包含字母、数字和连字符，且以字母或数字开头</div> : null}
    </div>
  )
}

export function DeclareSection({ principal, agents, busy, onDeclarePrincipal, onDeclareAgent }) {
  const [adding, setAdding] = React.useState(false)

  if (!principal) {
    return <PrincipalForm busy={busy} onDeclare={onDeclarePrincipal} />
  }

  return (
    <>
      <div className="ifp-card">
        <div className="ifp-card-head">
          <span className="ifp-dot on" />
          <h3>负责人</h3>
        </div>
        <p>
          <b>{principal.label}</b>
        </p>
        <p className="ifp-mono">{principal.did}</p>
        <p className="ifp-muted">
          这台机器上的 Agent 都由它签发授权。对外达成的协议由它签字才算数。
        </p>
      </div>

      <div className="ifp-card">
        <div className="ifp-card-head">
          <span className={`ifp-dot ${agents.length > 0 ? 'on' : 'off'}`} />
          <h3>Agent（{agents.length}）</h3>
        </div>

        {agents.length === 0 ? (
          <p>
            还没有声明任何 Agent。声明之前，这台机器在网络上没有可以被委派的角色。
          </p>
        ) : (
          <ul className="ifp-list">
            {agents.map((agent) => (
              <li key={agent.agentId}>
                <span className="ifp-tag never">{agent.agentId}</span>
                <span>
                  <b>{agent.label}</b>
                  <br />
                  <span className="ifp-mono ifp-muted">{agent.did}</span>
                  <br />
                  <span className="ifp-muted">
                    {(agent.capabilities ?? []).join('、') || '无声明能力'} · 授权 {String(agent.grantRef).slice(0, 12)}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        )}

        {adding ? null : (
          <div className="ifp-actions">
            <button className="ifp-btn" disabled={busy} onClick={() => setAdding(true)}>
              声明一个 Agent
            </button>
          </div>
        )}
      </div>

      {adding ? (
        <AgentForm
          busy={busy}
          onCancel={() => setAdding(false)}
          onDeclare={async (input) => {
            await onDeclareAgent(input)
            setAdding(false)
          }}
        />
      ) : null}
    </>
  )
}
