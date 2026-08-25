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

function PrincipalForm({ busy, availablePrincipals, onDeclare, onBind }) {
  const [label, setLabel] = React.useState('')

  return (
    <div className="ifp-card ifp-consent">
      <h3>先声明「谁在负责」</h3>
      <p>
        这台机器上的每个 Agent 都要有一个负责人——一个人或一个组织。
        它持有一把密钥，用来签发授权给下面的 Agent；将来对外达成的协议，也由这把密钥签字。
      </p>
      <p className="ifp-muted">
        Principal 是稳定的人或组织身份；签名密钥只是可轮换的 Authority。
        Authority 保存在用户级 <span className="ifp-mono">~/.iflowone/</span>，Workspace 只保存绑定。
      </p>
      {availablePrincipals?.length > 0 ? (
        <div className="ifp-field">
          <span>绑定已有 Principal</span>
          <ul className="ifp-list">
            {availablePrincipals.map((principal) => (
              <li key={principal.principalId}>
                <span>
                  <b>{principal.label || 'Principal'}</b>
                  <br />
                  <span className="ifp-mono ifp-muted ifp-wrap">{principal.principalId}</span>
                </span>
                <button className="ifp-btn" disabled={busy} onClick={() => onBind(principal.principalId)}>
                  绑定到此 Workspace
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <label className="ifp-field">
        <span>{availablePrincipals?.length ? '或者创建新的 Principal' : '名称（可以是你的名字或公司名）'}</span>
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

function PrincipalMigration({ migration, busy, onMigrate }) {
  const [confirmed, setConfirmed] = React.useState(false)
  if (!migration || migration.state === 'ambiguous') {
    return (
      <div className="ifp-card ifp-consent">
        <h3>Principal 迁移已暂停</h3>
        <p>
          {migration
            ? '同一 Authority DID 对应多个稳定 Principal，插件不会猜测应该绑定哪一个。请先修复用户级 Principal Registry。'
            : '无法生成旧 Principal 的迁移计划。插件不会在缺少明确计划时修改任何身份数据。'}
        </p>
        {migration?.candidates?.map((principalId) => (
          <p className="ifp-mono ifp-wrap" key={principalId}>{principalId}</p>
        ))}
      </div>
    )
  }
  if (migration.state !== 'required') return null
  return (
    <div className="ifp-card ifp-consent">
      <h3>需要迁移旧 Principal</h3>
      <p>
        旧版本把 Principal 密钥放在当前 Workspace。迁移会先备份旧密钥和 Agent 声明，再把它复制到用户级
        iFlowOne 身份库；旧密钥不会被删除。
      </p>
      <p className="ifp-mono ifp-wrap">{migration.legacyAuthorityDid}</p>
      <p className="ifp-muted">
        {migration.action === 'bind-existing'
          ? `这把 Authority 已属于 ${migration.targetPrincipalId}，将绑定到同一个稳定 Principal。`
          : '这把 Authority 尚未登记，将创建一个新的稳定 Principal。'}
        {' '}现有 Agent：{migration.agentCount ?? 0}。
      </p>
      <label className="ifp-cap">
        <input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />
        <span>我已核对上面的 Authority DID，并同意创建本地备份后迁移</span>
      </label>
      <div className="ifp-actions">
        <button
          className="ifp-btn primary"
          disabled={busy || !confirmed}
          onClick={() => onMigrate({
            expectedAuthorityDid: migration.legacyAuthorityDid,
            targetPrincipalId: migration.targetPrincipalId || undefined,
          })}
        >
          {busy ? '正在备份并迁移…' : '备份并迁移'}
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

export function DeclareSection({
  principal,
  agents,
  availablePrincipals,
  principalMigration,
  busy,
  onDeclarePrincipal,
  onBindPrincipal,
  onMigratePrincipal,
  onDeclareAgent,
}) {
  const [adding, setAdding] = React.useState(false)

  if (principal?.legacy) {
    return <PrincipalMigration migration={principalMigration} busy={busy} onMigrate={onMigratePrincipal} />
  }

  if (!principal) {
    return (
      <PrincipalForm
        busy={busy}
        availablePrincipals={availablePrincipals}
        onDeclare={onDeclarePrincipal}
        onBind={onBindPrincipal}
      />
    )
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
        <p className="ifp-mono ifp-wrap">{principal.principalId}</p>
        <p className="ifp-muted">
          Authority v{principal.authorityVersion} · <span className="ifp-mono">{principal.authorityDid}</span>
          <br />这台机器上的 Agent 由它授权；换 Workspace 不会创建新的 Principal。
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
