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

/**
 * Work a remote Agent handed back, waiting on a decision here.
 *
 * Deliberately its own block rather than another pair of buttons on the row.
 * Accepting a conversation and accepting the work are different agreements
 * made at different moments, and a row that offered both would invite ruling on
 * work by clicking the thing that means "yes, we can talk".
 */
function DeliveryRuling({ conversationId, delivery, busy, onDecide }) {
  const [reason, setReason] = React.useState('')
  const [sendingBack, setSendingBack] = React.useState(false)

  return (
    <div className="ifp-delivery">
      <div className="ifp-delivery-head">
        <span className="ifp-tag up">等你验收</span>
        <span className="ifp-muted">
          对方交回了结果 · <Ago at={delivery.receivedAt} />
        </span>
      </div>
      <p className="ifp-muted">
        答复在这条对话的本地 Session 里，读完再决定。在你决定之前，这件事对双方都还没有结束。
      </p>
      {sendingBack ? (
        <div className="ifp-field">
          <span>退回的理由（对方会看到）</span>
          <input
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="哪里不对，或还缺什么"
            maxLength={200}
          />
        </div>
      ) : null}
      <div className="ifp-req-actions">
        {sendingBack ? (
          <>
            <button
              className="ifp-btn danger"
              disabled={busy || reason.trim().length === 0}
              onClick={() => onDecide(conversationId, delivery.deliveryId, 'reject', reason.trim())}
            >
              确认退回
            </button>
            <button className="ifp-btn" disabled={busy} onClick={() => setSendingBack(false)}>
              取消
            </button>
          </>
        ) : (
          <>
            <button
              className="ifp-btn primary"
              disabled={busy}
              onClick={() => onDecide(conversationId, delivery.deliveryId, 'accept')}
            >
              验收
            </button>
            {/* Sending back needs a reason, so it opens a field rather than
                firing — the far side has nothing to act on without one. */}
            <button className="ifp-btn" disabled={busy} onClick={() => setSendingBack(true)}>
              退回…
            </button>
          </>
        )}
      </div>
    </div>
  )
}

function Row({ conversation, busy, onAccept, onReject, onDecideDelivery }) {
  const waiting = conversation.state === 'pending'
  const reauthorization = waiting && conversation.communicationState === 'reauthorization_required'
  const deliveries = conversation.deliveries ?? []
  return (
    <li className={`ifp-req${waiting ? ' waiting' : ''}`}>
      <div className="ifp-req-main">
        <div className="ifp-req-head">
          <span className={`ifp-tag ${STATE_TONE[conversation.state] ?? 'hidden'}`}>
            {reauthorization ? '等待重新授权' : (STATE_LABEL[conversation.state] ?? conversation.state)}
          </span>
          <b>{conversation.peer ?? '未署名的 Agent'}</b>
          <span className="ifp-muted">
            <Ago at={conversation.updatedAt} />
          </span>
        </div>
        {conversation.preview ? <p className="ifp-req-preview">“{conversation.preview}”</p> : null}
        {reauthorization ? (
          <p className="ifp-warn">
            通信许可已撤销，原来的本地 Session 与聊天历史仍保留；接受后才恢复这一对 Agent 的通信。
          </p>
        ) : null}
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
      {deliveries.map((delivery) => (
        <DeliveryRuling
          key={delivery.deliveryId}
          conversationId={conversation.conversationId}
          delivery={delivery}
          busy={busy}
          onDecide={onDecideDelivery}
        />
      ))}
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

  // Only what is actually waiting on a person.
  //
  // This page answers one question — may this Agent contact me — and an
  // accepted thread has already answered it. Listing every conversation here
  // made the page read as a contradiction ("nothing to handle", then thirty
  // items) and buried the one row that did need someone. Talking to an Agent
  // you already allowed belongs in the normal DSH session list and in Chats.
  //
  // Deliveries are the exception, and a different question: whether the WORK is
  // accepted, not whether the Agent may speak. Those still need a person, so
  // they stay.
  const pending = conversations.filter((c) => c.state === 'pending')
  const awaitingRuling = conversations.filter(
    (c) => c.state !== 'pending' && (c.deliveries ?? []).length > 0,
  )
  const sorted = [...pending, ...awaitingRuling].sort((a, b) => {
    const aWaiting = a.state === 'pending' ? 0 : 1
    const bWaiting = b.state === 'pending' ? 0 : 1
    if (aWaiting !== bWaiting) return aWaiting - bWaiting
    return String(b.updatedAt).localeCompare(String(a.updatedAt))
  })

  if (conversations.length === 0) {
    return (
      <Card title="还没有人联系过这台机器" tone="off">
        <p>
          别的 Agent 找上门时会出现在这里。第一条消息不会直接跑起来——它先停在这里等你答复，
          所以陌生人无法让这台机器烧掉一个 token。
        </p>
      </Card>
    )
  }

  if (sorted.length === 0) {
    return (
      <Card title="没有待处理的事" tone="on">
        <p>
          第一次联系需要你同意，之后这对 Agent 就能一直聊下去，不再回到这里。
          已经在进行的对话在 DSH 的会话列表里，也在 iFlowOne 的 Chats 里。
        </p>
      </Card>
    )
  }

  return (
    <>
      <Card
        title={pending.length > 0 ? `${pending.length} 条等你答复` : `${awaitingRuling.length} 件等你验收`}
        tone="warn"
      >
        <p>
          {pending.length > 0
            ? '接受之后才会创建或恢复本地 Session、才会有模型开始处理。首次同意后，这对 Agent 的消息直接进来；若你后来撤销通信许可，下一条会回到这里等待重新授权。'
            : '对方把活交回来了，等你决定收不收。这跟允许对方说话是两件事。'}
        </p>
        <ul className="ifp-list ifp-reqs">
          {sorted.map((conversation) => (
            <Row
              key={conversation.conversationId}
              conversation={conversation}
              busy={busy}
              onAccept={(id) => answer(() => api.acceptConversation(id))}
              onReject={(id) => answer(() => api.rejectConversation(id))}
              onDecideDelivery={(conversationId, deliveryId, decision, reason) =>
                answer(() => api.decideDelivery(conversationId, deliveryId, decision, reason))
              }
            />
          ))}
        </ul>
      </Card>
      {error ? <div className="ifp-error">{error}</div> : null}
    </>
  )
}
