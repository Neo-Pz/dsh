/**
 * "Me" — who this machine is, and what leaves it.
 *
 * One decision lives on this page: should this machine's facts be public. The
 * layout follows the boundary the product is built on —
 *
 *     install  →  local discovery (no login, no network, nobody can see it)
 *                     ↓  ← a person crosses this, knowingly
 *                 publish  →  a public AgentCard and redacted facts
 *
 * — so the page shows what has been discovered locally first, states plainly
 * that it is private, and only then offers the button. The button does not
 * publish: it opens a list of exactly what would leave this machine, what is
 * redacted, and what never leaves at all. Someone should be able to decline
 * after reading it, and be no worse off.
 *
 * This is now a tab rather than the whole panel, so it takes `state` from the
 * Hub instead of polling for itself — but it is still the tab the Hub lands on
 * when nothing is waiting, because the gate has to stay findable.
 */

import React from 'react'

import { api } from './api.js'
import { DeclareSection } from './Declare.jsx'
import { Ago, Card } from './ui.jsx'

/**
 * What crossing the boundary actually means, itemised.
 *
 * Written as three kinds rather than a paragraph, because the question someone
 * is really asking is "what of mine becomes visible" — and the answer that
 * matters most is the third column: the things that never leave regardless.
 */
function Consent({ onCancel, onAccept, busy }) {
  return (
    <div className="ifp-card ifp-consent">
      <h3>上线前，请确认这台机器会公开什么</h3>
      <ul className="ifp-list">
        <li>
          <span className="ifp-tag up">会上传</span>
          <span>Agent 的标识、能力、公开 AgentCard 与 DID</span>
        </li>
        <li>
          <span className="ifp-tag up">会上传</span>
          <span>任务、工具调用、审批的<b>结构</b>——谁、何时、什么状态、用了哪个工具</span>
        </li>
        <li>
          <span className="ifp-tag hidden">会脱敏</span>
          <span>任务标题、各类原因说明，离开这台机器前替换为标记，原文留在本机</span>
        </li>
        <li>
          <span className="ifp-tag never">永不离开</span>
          <span>文件内容、工具参数、prompt、模型凭据与 API key、身份私钥</span>
        </li>
        <li>
          <span className="ifp-tag never">永不离开</span>
          <span>对话内容、对话与本地 Session 的绑定、工作目录路径</span>
        </li>
      </ul>
      <p className="ifp-muted">
        上线后随时可以下线。已经上传的事实不会自动撤回——网络中其他节点可能已经读过它们。
      </p>
      <div className="ifp-actions">
        <button className="ifp-btn primary" onClick={onAccept} disabled={busy}>
          {busy ? '正在取码…' : '我明白了，继续'}
        </button>
        <button className="ifp-btn" onClick={onCancel} disabled={busy}>
          取消
        </button>
      </div>
    </div>
  )
}

/** The code, and what to do with it. */
function Claim({ claim, onCancel }) {
  return (
    <div className="ifp-card ifp-consent">
      <h3>在浏览器里确认这台机器</h3>
      <p>打开下面的地址，输入这串短码：</p>
      <div className="ifp-code">{claim.userCode}</div>
      <p>
        <a href={claim.verificationUrl} target="_blank" rel="noreferrer">
          {claim.verificationUrl}
        </a>
      </p>
      <p className="ifp-muted">
        确认之后这里会自动完成，不需要回来点任何东西。短码十分钟后失效，过期就重新点一次上线。
      </p>
      <div className="ifp-actions">
        <button className="ifp-btn" onClick={onCancel}>
          取消
        </button>
      </div>
    </div>
  )
}

/**
 * The session directory is a local operator decision, not an Agent fact.
 * DSH composes either a browser directory flow or a native picker. The panel
 * detects that capability instead of assuming the native API is usable; direct
 * entry remains available when neither interaction service exists. Saving never moves old sessions: each existing
 * ConversationBinding keeps its original cwd.
 */
function pickerErrorCode(error) {
  return error?.rpcError?.code ?? error?.code
}

function pickerCapability(error) {
  return error?.rpcError?.details?.capability ?? error?.details?.capability
}

/** The in-app counterpart to DSH's browse capability. */
function DirectoryBrowser({ picker, startPath, busy, onPicked, onCancel }) {
  const [listing, setListing] = React.useState(null)
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState(null)
  const requestRef = React.useRef(0)

  const load = React.useCallback(async (path) => {
    if (typeof picker?.listDirectory !== 'function') {
      setError('此 DSH 部署没有可用的目录浏览器；可以直接输入绝对路径。')
      return
    }
    const request = requestRef.current + 1
    requestRef.current = request
    setLoading(true)
    setError(null)
    try {
      const next = await picker.listDirectory(path)
      if (request !== requestRef.current) return
      setListing(next)
    } catch (cause) {
      if (request !== requestRef.current) return
      // `listDirectory` deliberately rejects under the native capability. In
      // that case — and only that case — ask the OS picker for a path.
      if (pickerErrorCode(cause) === 'directory-picker-unavailable'
        && pickerCapability(cause) === 'native'
        && typeof picker?.pickNativeDirectory === 'function') {
        try {
          const selected = await picker.pickNativeDirectory()
          if (request !== requestRef.current) return
          if (selected) await onPicked(selected)
          else onCancel()
          return
        } catch (nativeCause) {
          if (request === requestRef.current) setError(nativeCause?.message ?? '无法打开系统文件夹选择器。')
          return
        }
      }
      setError(cause?.message ?? '无法读取目录；可以直接输入绝对路径。')
    } finally {
      if (request === requestRef.current) setLoading(false)
    }
  }, [onCancel, onPicked, picker])

  React.useEffect(() => {
    void load(startPath || undefined)
    return () => { requestRef.current += 1 }
  }, [load, startPath])

  const entries = (listing?.entries ?? []).filter((entry) => !entry.hidden)
  return (
    <div className="ifp-directory-browser" role="dialog" aria-label="选择会话工作目录">
      <p className="ifp-muted">浏览 Host 上的目录，选择后新 Agent 对话会写入该文件夹。</p>
      {listing ? (
        <>
          <div className="ifp-directory-crumbs">
            {(listing.crumbs ?? []).map((crumb) => (
              <button key={crumb.path} className="ifp-link" disabled={busy || loading} onClick={() => void load(crumb.path)}>{crumb.name || crumb.path}</button>
            ))}
          </div>
          <p className="ifp-mono ifp-wrap">{listing.path}</p>
          <div className="ifp-directory-list">
            {entries.map((entry) => (
              <button key={entry.path} className="ifp-directory-entry" disabled={busy || loading} onClick={() => void load(entry.path)}>{entry.name}</button>
            ))}
            {entries.length === 0 ? <p className="ifp-muted">这个文件夹没有可浏览的子文件夹。</p> : null}
          </div>
          <div className="ifp-actions">
            <button className="ifp-btn primary" disabled={busy || loading} onClick={() => void onPicked(listing.path)}>选择此文件夹</button>
            <button className="ifp-btn" disabled={busy || loading} onClick={onCancel}>取消</button>
          </div>
        </>
      ) : null}
      {loading ? <p className="ifp-muted">正在读取目录…</p> : null}
      {error ? <p className="ifp-error">{error}</p> : null}
    </div>
  )
}

function ConversationWorkspace({ value, defaultValue, confirmed, elsewhere, busy, onSave, picker }) {
  const [editing, setEditing] = React.useState(false)
  const [browsing, setBrowsing] = React.useState(false)
  const [path, setPath] = React.useState(value ?? defaultValue ?? '')
  const [error, setError] = React.useState(null)
  const current = value ?? defaultValue ?? '—'

  React.useEffect(() => { setPath(value ?? defaultValue ?? '') }, [value, defaultValue])

  const save = async (next) => {
    setError(null)
    try {
      await onSave(next)
      setEditing(false)
      return true
    } catch (cause) {
      setError(cause?.message ?? '工作目录保存失败，请重试。')
      return false
    }
  }

  const choose = () => {
    if (!picker?.listDirectory && !picker?.pickNativeDirectory) return
    setError(null)
  }

  const picked = async (next) => {
    if (await save(next)) setBrowsing(false)
  }

  return (
    <Card title={confirmed ? '会话工作目录' : '先确认会话工作目录'} tone={confirmed ? 'on' : 'warn'}>
      {!confirmed ? (
        <p>
          iFlow 会在这个文件夹下创建后续 Agent 对话的普通 DSH Session。默认是当前 DSH 工作区；确认前不会新建会话。
        </p>
      ) : (
        <p className="ifp-muted">新对话会写入这里；已有对话仍留在它们原来的文件夹，不会被移动或删除。</p>
      )}
      <p className="ifp-mono ifp-wrap">{current}</p>
      {/*
        Filing conversations somewhere other than the DSH workspace this panel
        is open in is correct — it is what was asked for. But DSH groups its
        session list by folder, so those conversations show up under 未分组
        from here, and the only reading available to someone looking at that is
        that something broke. Naming it turns a mystery back into a setting.
      */}
      {elsewhere ? (
        <p className="ifp-warn">
          这个目录不是你当前打开的 DSH 工作区（{defaultValue}）。对话会正常创建在上面那个目录里，
          但在这里的会话列表中会显示为「未分组」——因为 DSH 按文件夹分组。
          想让它们出现在当前工作区，把上面改成 <span className="ifp-mono">{defaultValue}</span> 即可；
          已有对话不会被移动。
        </p>
      ) : null}
      {editing ? (
        <div className="ifp-actions">
          <input className="ifp-input ifp-mono" value={path} onChange={(event) => setPath(event.target.value)} placeholder="C:\\path\\to\\workspace" autoComplete="off" />
          <button className="ifp-btn primary" disabled={busy || !path.trim()} onClick={() => save(path.trim())}>保存</button>
          <button className="ifp-btn" disabled={busy} onClick={() => setEditing(false)}>取消</button>
        </div>
      ) : (
        <div className="ifp-actions">
          {!confirmed ? <button className="ifp-btn primary" disabled={busy} onClick={() => save(defaultValue)}>使用默认工作区</button> : null}
          {picker?.listDirectory || picker?.pickNativeDirectory ? <button className="ifp-btn" disabled={busy} onClick={() => { choose(); setBrowsing(true) }}>选择文件夹</button> : null}
          <button className="ifp-btn" disabled={busy} onClick={() => setEditing(true)}>{confirmed ? '修改路径' : '输入路径'}</button>
        </div>
      )}
      {browsing ? <DirectoryBrowser picker={picker} startPath={value ?? defaultValue} busy={busy} onPicked={picked} onCancel={() => setBrowsing(false)} /> : null}
      {error ? <p className="ifp-error">{error}</p> : null}
    </Card>
  )
}

/**
 * Agents a person allowed to keep messaging this node.
 *
 * Here rather than in the posture card below it, which is deliberately
 * read-only and says so: that file is hand-edited policy, and this list is what
 * accumulated from clicking 接受. Something granted by a click has to be
 * findable and withdrawable by one, or it is not really a decision.
 */
function AllowedPairs({ pairs, onChanged }) {
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState(null)

  const revoke = async (pair) => {
    setBusy(true)
    setError(null)
    try {
      const result = await api.revokePair(pair.localAgentDid, pair.peerAgentDid)
      if (result && result.ok === false) throw new Error(result.error ?? '撤销失败')
      if (onChanged) await onChanged()
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  if (pairs.length === 0) {
    return (
      <Card title="已授权的 Agent" tone="off">
        <p className="ifp-muted">
          还没有。第一次有人联系时你在「待处理」里同意，就会出现在这里——之后那对 Agent
          可以一直说话，不再每次来问你。
        </p>
      </Card>
    )
  }

  return (
    <Card title={`已授权的 Agent（${pairs.length}）`}>
      <p className="ifp-muted">
        这些 Agent 可以直接给你发消息，不再进「待处理」。
        授权只包括发消息——跑工具、花钱、验收任务都是分开的事，这里没有授予。
      </p>
      <ul className="ifp-list">
        {pairs.map((pair) => (
          <li key={`${pair.localAgentDid}|${pair.peerAgentDid}`}>
            <div className="ifp-req-main">
              <b>{pair.peerLabel || '未署名的 Agent'}</b>
              <div className="ifp-muted ifp-mono ifp-wrap">{pair.peerAgentDid}</div>
              {pair.grantedAt ? (
                <div className="ifp-muted">
                  你在 <Ago at={pair.grantedAt} /> 同意的
                </div>
              ) : null}
            </div>
            {/* Withdrawing keeps the history but pauses the live thread. The
                next inbound message returns to Requests for a new decision. */}
            <button className="ifp-btn" disabled={busy} onClick={() => revoke(pair)}>
              撤销
            </button>
          </li>
        ))}
      </ul>
      {error ? <div className="ifp-error">{error}</div> : null}
    </Card>
  )
}

export function IFlowPanel({ state, onChanged, workspacePicker }) {
  const [error, setError] = React.useState(null)
  const [stage, setStage] = React.useState('idle') // idle | consent | claiming
  const [claim, setClaim] = React.useState(null)
  const [busy, setBusy] = React.useState(false)
  const [webLoginCode, setWebLoginCode] = React.useState('')
  const [webLoginResult, setWebLoginResult] = React.useState(null)

  const refresh = React.useCallback(async () => {
    if (onChanged) await onChanged()
  }, [onChanged])

  // While a claim is outstanding the edge is waiting on a human in another
  // window, so this polls faster and stops the moment it resolves.
  React.useEffect(() => {
    if (stage !== 'claiming' || !claim) return undefined
    let cancelled = false
    const timer = setInterval(async () => {
      try {
        const result = await api.claimPoll()
        if (cancelled) return
        if (result.state === 'issued') {
          setStage('idle')
          setClaim(null)
          refresh()
        } else if (result.state === 'expired' || result.state === 'unknown' || result.state === 'none') {
          setStage('idle')
          setClaim(null)
          setError('短码已过期，请重新点一次上线')
        }
      } catch (err) {
        if (!cancelled) setError(err.message)
      }
    }, claim.intervalMs ?? 3000)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [stage, claim, refresh])

  const startClaim = async () => {
    setBusy(true)
    setError(null)
    try {
      const result = await api.claimStart()
      if (!result.ok) throw new Error(result.error ?? '取码失败')
      setClaim(result)
      setStage('claiming')
    } catch (err) {
      setError(err.message)
      setStage('idle')
    } finally {
      setBusy(false)
    }
  }

  const act = async (fn) => {
    setBusy(true)
    setError(null)
    try {
      await fn()
      await refresh()
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  const publishing = state.publishing
  const identityReady = state.identity && state.identity.ready
  const conversationWorkspace = state.conversationWorkspace ?? {}

  return (
    <>
      <Card title="这个节点">
        <div className="ifp-kv">
          <div>
            <b>{state.alias ?? '未命名'}</b>
            <span className="ifp-muted">别名</span>
          </div>
          <div>
            <b className="ifp-mono">{state.nodeId ?? '尚未就绪'}</b>
            <span className="ifp-muted">节点 ID</span>
          </div>
          <div>
            <b className="ifp-mono ifp-wrap">{state.workspaceRoot ?? '—'}</b>
            <span className="ifp-muted">工作目录（永不离开本机）</span>
          </div>
        </div>
      </Card>

      <ConversationWorkspace
        value={conversationWorkspace.path}
        defaultValue={conversationWorkspace.defaultPath ?? state.workspaceRoot}
        confirmed={conversationWorkspace.confirmed === true}
        elsewhere={conversationWorkspace.elsewhere === true}
        busy={busy}
        picker={workspacePicker}
        onSave={(path) => act(async () => {
          const result = await api.setConversationWorkspace(path)
          if (!result.ok) throw new Error(result.error ?? '工作目录保存失败')
        })}
      />

      <Card title="本地发现" tone="on">
        <div className="ifp-row">
          <div className="ifp-metric">
            {state.localAgents}
            <small>个本地 Agent</small>
          </div>
        </div>
        <p>
          这些是插件在本机观察到的 Agent。{publishing ? '' : '目前没有任何人能看到它们——发现是纯本地的，不登录、不联网。'}
        </p>
      </Card>

      <DeclareSection
        principal={state.principal ?? null}
        agents={state.declaredAgents ?? []}
        availablePrincipals={state.availablePrincipals ?? []}
        principalMigration={state.principalMigration ?? null}
        busy={busy}
        onDeclarePrincipal={(label) =>
          act(async () => {
            const result = await api.declarePrincipal(label)
            if (!result.ok) throw new Error(result.error ?? '声明失败')
          })
        }
        onBindPrincipal={(principalId) =>
          act(async () => {
            const result = await api.bindPrincipal(principalId)
            if (!result.ok) throw new Error(result.error ?? '绑定失败')
          })
        }
        onMigratePrincipal={(input) =>
          act(async () => {
            const result = await api.migratePrincipal(input)
            if (!result.ok) throw new Error(result.error ?? '迁移失败')
          })
        }
        onDeclareAgent={(input) =>
          act(async () => {
            const result = await api.declareAgent(input)
            if (!result.ok) throw new Error(result.error ?? '声明失败')
          })
        }
      />

      <Card title="iFlowOne Web 登录" tone={webLoginResult ? 'on' : undefined}>
        <p>
          在 iFlowOne Web 发起登录后，把网页显示的短码填在这里。这个节点会用当前稳定 Principal
          的 Authority 确认登录，并只提交本机可代表的 Agent；私钥不会离开本机。
        </p>
        <div className="ifp-actions">
          <input
            className="ifp-input ifp-mono"
            value={webLoginCode}
            onChange={(event) => setWebLoginCode(event.target.value.toUpperCase())}
            placeholder="ABCD-2345"
            maxLength={16}
            autoComplete="off"
          />
          <button
            className="ifp-btn primary"
            disabled={busy || webLoginCode.trim().length < 8 || !state.principal}
            onClick={() =>
              act(async () => {
                const result = await api.confirmWebLogin(webLoginCode.trim())
                if (!result.ok) throw new Error(result.error ?? 'Web 登录确认失败')
                setWebLoginResult(result)
                setWebLoginCode('')
              })
            }
          >
            确认网页登录
          </button>
        </div>
        {!state.principal ? <p className="ifp-muted">请先声明或绑定一个稳定 Principal。</p> : null}
        {webLoginResult ? (
          <p className="ifp-muted">已确认；返回 iFlowOne Web，网页会自动完成登录。</p>
        ) : null}
        {state.webIntents?.queued ? (
          <p className="ifp-muted">本地有 {state.webIntents.queued} 条 Intent 正在等待 Agent 可用或网络恢复。</p>
        ) : null}
      </Card>

      <Card
        title="节点密钥"
        tone={identityReady && state.signing ? 'on' : identityReady ? 'warn' : 'off'}
        actions={
          identityReady && state.signing ? null : (
            <button className="ifp-btn" disabled={busy} onClick={() => act(api.fetchIdentity)}>
              修复身份
            </button>
          )
        }
      >
        {identityReady ? (
          <>
            <p className="ifp-mono">{state.identity.did}</p>
            <p>
              {state.signing
                ? '这台机器观察到的事实，在产生时就被签名，离开本机后仍可被独立验证。声明出来的 Agent 各自用自己的密钥签名。'
                : '密钥存在，但当前无法签名——事实会被记录为未签名，无法在本机之外被证明。'}
            </p>
          </>
        ) : (
          <p>
            这个节点还没有可用的身份，事实会被记录为未签名。
            {state.identity && state.identity.error ? (
              <>
                <br />
                <span className="ifp-muted">{state.identity.error}</span>
              </>
            ) : null}
          </p>
        )}
      </Card>

      {stage === 'consent' ? (
        <Consent busy={busy} onCancel={() => setStage('idle')} onAccept={startClaim} />
      ) : null}

      {stage === 'claiming' && claim ? (
        <Claim
          claim={claim}
          onCancel={() => {
            setStage('idle')
            setClaim(null)
          }}
        />
      ) : null}

      {stage === 'idle' ? (
        <Card
          title={publishing ? '已上线' : '未上线'}
          tone={publishing ? 'on' : 'off'}
          actions={
            publishing ? (
              <>
                <button className="ifp-btn danger" disabled={busy} onClick={() => act(api.stop)}>
                  下线
                </button>
                <button
                  className="ifp-btn"
                  disabled={busy}
                  onClick={() => {
                    const next = publishing.visibility === 'full' ? 'structural' : 'full'
                    if (
                      next === 'full' &&
                      !window.confirm('切换到「完整文本」后，任务标题和原因说明会原样上传，不再脱敏。确定吗？')
                    ) {
                      return
                    }
                    act(() => api.setVisibility(next))
                  }}
                >
                  {publishing.visibility === 'full' ? '改回脱敏上传' : '改为完整文本上传'}
                </button>
              </>
            ) : (
              <button className="ifp-btn primary" disabled={busy} onClick={() => setStage('consent')}>
                上线
              </button>
            )
          }
        >
          {publishing ? (
            <>
              <p>
                正在向 <span className="ifp-mono">{publishing.url}</span> 发布事实，
                {publishing.visibility === 'full' ? '包含完整文本（未脱敏）。' : '自由文本已脱敏。'}
              </p>
              <p>
                <b>{state.pendingFacts}</b> 条事实待发送。
                {state.pendingFacts > 0 ? '它们排在本机队列里，网络恢复后会自动补发。' : ''}
              </p>
            </>
          ) : (
            <p>
              这台机器的事实只存在本地日志里，一条都没有离开过。
              {state.pendingFacts > 0 ? `已累积 ${state.pendingFacts} 条，上线后会补发。` : ''}
            </p>
          )}
        </Card>
      ) : null}

      <AllowedPairs pairs={state.allowedPairs ?? []} onChanged={onChanged} />

      <Card title="这个节点接受什么">
        <p className="ifp-muted">
          以下是安全姿态，只在配置文件里更改——面板故意不提供开关。
        </p>
        <div className="ifp-posture">
          <div>
            <b>
              {state.trust?.default === 'auto'
                ? '自动接受任何对话'
                : state.trust?.default === 'reject'
                  ? '拒绝所有新对话'
                  : '新对话需要你同意'}
            </b>
            <span className="ifp-muted">
              trust.json · 已信任 {state.trust?.autoPeers ?? 0} · 已屏蔽 {state.trust?.blocked ?? 0}
            </span>
          </div>
          <div>
            <b>{state.posture.acceptCommands ? '接受远程命令' : '不接受远程命令'}</b>
            <span className="ifp-muted">acceptCommands</span>
          </div>
          <div>
            <b>{state.posture.routeApprovals ? '远程可参与审批' : '审批仅限本地'}</b>
            <span className="ifp-muted">routeApprovals</span>
          </div>
          <div>
            <b>{state.posture.authEnabled ? '已设置访问令牌' : '未设置访问令牌'}</b>
            <span className="ifp-muted">iflow_set_token</span>
          </div>
          <div>
            <b className="ifp-mono">
              {state.posture.boundHost}:{state.posture.port}
            </b>
            <span className="ifp-muted">
              {state.posture.boundHost === '0.0.0.0' ? '监听所有网卡' : '仅本机'}
            </span>
          </div>
        </div>
      </Card>

      {error ? <div className="ifp-error">{error}</div> : null}
    </>
  )
}
