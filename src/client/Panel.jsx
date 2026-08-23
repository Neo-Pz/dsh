/**
 * The publish gate.
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
 */

import React from 'react'

import { api } from './api.js'

const POLL_IDLE_MS = 5000

function Card({ title, tone, children, actions }) {
  return (
    <div className="ifp-card">
      <div className="ifp-card-head">
        {tone ? <span className={`ifp-dot ${tone}`} /> : null}
        <h3>{title}</h3>
      </div>
      {children}
      {actions ? <div className="ifp-actions">{actions}</div> : null}
    </div>
  )
}

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

export function IFlowPanel() {
  const [state, setState] = React.useState(null)
  const [error, setError] = React.useState(null)
  const [stage, setStage] = React.useState('idle') // idle | consent | claiming
  const [claim, setClaim] = React.useState(null)
  const [busy, setBusy] = React.useState(false)

  const refresh = React.useCallback(async () => {
    try {
      setState(await api.state())
      setError(null)
    } catch (err) {
      setError(err.message)
    }
  }, [])

  React.useEffect(() => {
    refresh()
    const timer = setInterval(refresh, POLL_IDLE_MS)
    return () => clearInterval(timer)
  }, [refresh])

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

  if (!state) {
    return (
      <div className="ifp-root">
        <div className="ifp-head">
          <h2>iFlow · 弗流</h2>
          <p>{error ?? '正在读取本机状态…'}</p>
        </div>
      </div>
    )
  }

  const publishing = state.publishing
  const identityReady = state.identity && state.identity.ready

  return (
    <div className="ifp-root">
      <div className="ifp-head">
        <h2>iFlow · 弗流</h2>
        <p>
          这台机器是一个 Agent 网络节点。装上插件本身不发布任何东西——下面这个开关才是。
        </p>
      </div>

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

      <Card
        title="身份"
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
                ? '事实在产生时就由这个身份签名，离开本机后仍可被独立验证。'
                : '身份存在，但当前无法签名——事实会被记录为未签名，无法在本机之外被证明。'}
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

      <Card title="这个节点接受什么">
        <p className="ifp-muted">
          以下是安全姿态，只在配置文件里更改——面板故意不提供开关。
        </p>
        <div className="ifp-posture">
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
    </div>
  )
}
