/**
 * What is waiting for you.
 *
 * A remote Agent's first message does not reach a model. It is held — no
 * session, no tokens, no tools — until someone here says yes. That gate is
 * only worth having if answering it is easy, and until this tab existed the
 * only way to answer was to type a tool call into a chat.
 *
 * Deliberately not an activity feed. A feed answers "what happened", which is
 * a question you can ask later; this answers "what is blocked on me", which is
 * the only question that is urgent. Pending threads sort to the top and
 * everything else is history underneath them.
 */

import React from 'react'

import { api } from './api.js'
import { Ago, Card } from './ui.jsx'

const POLL_MS = 5000

const STATE_LABEL = {
  pending: '等你答复',
  accepted: '已接受',
  active: '进行中',
  rejected: '已拒绝',
  closed: '已结束',
}

const STATE_TONE = {
  pending: 'up',
  accepted: 'never',
  active: 'never',
  rejected: 'hidden',
  closed: 'hidden',
}

function Row({ conversation, busy, onAccept, onReject }) {
  const waiting = conversation.state === 'pending'
  return (
    <li className={`ifp-req${waiting ? ' waiting' : ''}`}>
      <div className="ifp-req-main">
        <div className="ifp-req-head">
          <span className={`ifp-tag ${STATE_TONE[conversation.state] ?? 'hidden'}`}>
            {STATE_LABEL[conversation.state] ?? conversation.state}
          </span>
          <b>{conversation.peer ?? '未署名的 Agent'}</b>
          <span className="ifp-muted">
            <Ago at={conversation.updatedAt} />
          </span>
        </div>
        {conversation.preview ? <p className="ifp-req-preview">“{conversation.preview}”</p> : null}
        <div className="ifp-muted ifp-mono ifp-wrap">
          {conversation.conversationId}
          {conversation.peerDid ? ` · ${conversation.peerDid}` : ''}
        </div>
      </div>
      {waiting ? (
        <div className="ifp-req-actions">
          <button className="ifp-btn primary" disabled={busy} onClick={() => onAccept(conversation.conversationId)}>
            接受
          </button>
          <button className="ifp-btn danger" disabled={busy} onClick={() => onReject(conversation.conversationId)}>
            拒绝
          </button>
        </div>
      ) : null}
    </li>
  )
}

export function RequestsTab({ onChanged }) {
  const [conversations, setConversations] = React.useState(null)
  const [error, setError] = React.useState(null)
  const [busy, setBusy] = React.useState(false)

  const load = React.useCallback(async () => {
    try {
      const result = await api.conversations()
      setConversations(result.conversations ?? [])
      setError(null)
    } catch (err) {
      setError(err.message)
    }
  }, [])

  React.useEffect(() => {
    load()
    const timer = setInterval(load, POLL_MS)
    return () => clearInterval(timer)
  }, [load])

  const answer = async (fn) => {
    setBusy(true)
    setError(null)
    try {
      const result = await fn()
      if (result && result.ok === false) throw new Error(result.error ?? '操作失败')
      await load()
      // The badge lives on the Hub's own poll; refresh it now so the count
      // drops the moment the person acts rather than up to five seconds later.
      if (onChanged) await onChanged()
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  if (!conversations) {
    return (
      <Card>
        <p>{error ?? '正在读取…'}</p>
      </Card>
    )
  }

  // Pending first, then most recently touched. Everything else is history.
  const sorted = [...conversations].sort((a, b) => {
    const aWaiting = a.state === 'pending' ? 0 : 1
    const bWaiting = b.state === 'pending' ? 0 : 1
    if (aWaiting !== bWaiting) return aWaiting - bWaiting
    return String(b.updatedAt).localeCompare(String(a.updatedAt))
  })
  const pending = sorted.filter((c) => c.state === 'pending')

  if (sorted.length === 0) {
    return (
      <Card title="还没有人联系过这台机器" tone="off">
        <p>
          别的 Agent 找上门时会出现在这里。第一条消息不会直接跑起来——它先停在这里等你答复，
          所以陌生人无法让这台机器烧掉一个 token。
        </p>
      </Card>
    )
  }

  return (
    <>
      <Card
        title={pending.length > 0 ? `${pending.length} 条等你答复` : '没有待处理的事'}
        tone={pending.length > 0 ? 'warn' : 'on'}
      >
        <p>
          {pending.length > 0
            ? '接受之后才会创建本地 Session、才会有模型开始处理。在此之前对方的消息只是停在这里。'
            : '所有对话都已经答复过了。'}
        </p>
        <ul className="ifp-list ifp-reqs">
          {sorted.map((conversation) => (
            <Row
              key={conversation.conversationId}
              conversation={conversation}
              busy={busy}
              onAccept={(id) => answer(() => api.acceptConversation(id))}
              onReject={(id) => answer(() => api.rejectConversation(id))}
            />
          ))}
        </ul>
      </Card>
      {error ? <div className="ifp-error">{error}</div> : null}
    </>
  )
}
