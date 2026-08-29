/**
 * The Conversation as both ends would recognise it, on the machine it lives on.
 *
 * DSH already shows the bound session, and it is the right place for it — but
 * it renders by role, and it has to: a peer's message arrives as a user turn
 * because that is what prompts the local Agent, and DSH puts user turns on the
 * right. So the far side's words appear where your own belong, and nothing on
 * the line says whose they were.
 *
 * This reads the same view the web Chat box reads, and draws it the way the
 * conversation actually happened:
 *
 *   left  = the other party            right = this Agent
 *   👤    = a person wrote it          🤖    = an Agent did
 *
 * Those are two questions and neither answer implies the other. A person on the
 * far side is a 👤 on the left. Deriving one from the other is what put the
 * reader's own name on somebody else's sentence.
 */

import React from 'react'

import { api } from './api.js'
import { Ago, Card } from './ui.jsx'

const POLL_MS = 4000
const PAGE = 60

/** Who to name on a line, given that a person always has an Agent behind them. */
function describeAuthor(message) {
  const agent = message.authorLabel || message.representedBy || 'Agent'
  if (message.role !== 'human') return agent
  // A Human is not a network actor: it acts through the Agent representing it,
  // so a human line names both rather than choosing one.
  return message.side === 'self' ? `你 · 经由 ${agent}` : `对方 · 经由 ${agent}`
}

function Message({ message }) {
  const mine = message.side !== 'peer'
  return (
    <li className={`ifp-msg ${mine ? 'mine' : 'theirs'}`}>
      <div className="ifp-msg-who">
        <span aria-hidden="true">{message.role === 'human' ? '👤' : '🤖'}</span>
        <span>{describeAuthor(message)}</span>
        {message.createdAt ? (
          <span className="ifp-muted">
            <Ago at={message.createdAt} />
          </span>
        ) : null}
      </div>
      <div className="ifp-msg-body">{message.text}</div>
      {message.state ? <div className="ifp-muted ifp-msg-state">{message.state}</div> : null}
    </li>
  )
}

function Thread({ conversation, onBack }) {
  const [snapshot, setSnapshot] = React.useState(null)
  const [error, setError] = React.useState(null)

  const load = React.useCallback(async () => {
    try {
      const result = await api.conversationMessages(conversation.conversationId, undefined, PAGE)
      if (result?.ok === false) throw new Error(result.error ?? '读取失败')
      setSnapshot(result)
      setError(null)
    } catch (err) {
      setError(err.message)
    }
  }, [conversation.conversationId])

  React.useEffect(() => {
    load()
    const timer = setInterval(load, POLL_MS)
    return () => clearInterval(timer)
  }, [load])

  const messages = snapshot?.messages ?? []

  return (
    <Card
      title={conversation.peer || conversation.peerAgentId || '对话'}
      tone="on"
      actions={<button className="ifp-btn" onClick={onBack}>返回</button>}
    >
      <p className="ifp-muted">
        左边是对方，右边是这台机器上的 Agent。👤 表示这句话是人写的，🤖 表示 Agent 自己说的——
        人写的消息仍然由 Agent 签名发出，两件事都记着。
      </p>
      {!snapshot && !error ? <p className="ifp-muted">正在读取…</p> : null}
      {snapshot && messages.length === 0 ? (
        <p className="ifp-muted">这条对话还没有消息。</p>
      ) : null}
      <ul className="ifp-thread">
        {messages.map((message) => (
          <Message key={message.messageId} message={message} />
        ))}
      </ul>
      {error ? <div className="ifp-error">{error}</div> : null}
    </Card>
  )
}

export function ChatsTab() {
  const [conversations, setConversations] = React.useState(null)
  const [openId, setOpenId] = React.useState(null)
  const [error, setError] = React.useState(null)

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

  if (!conversations) {
    return (
      <Card>
        <p>{error ?? '正在读取…'}</p>
      </Card>
    )
  }

  const open = conversations.find((c) => c.conversationId === openId)
  if (open) return <Thread conversation={open} onBack={() => setOpenId(null)} />

  // One row per counterparty. A list of who you talk to, not of every thread
  // that ever existed — the plugin already collapses them for the web view, and
  // a chat list showing the same Agent three times is a session manager.
  const rows = []
  const seen = new Set()
  for (const conversation of [...conversations].sort((a, b) =>
    String(b.updatedAt).localeCompare(String(a.updatedAt)),
  )) {
    const counterparty = conversation.peer || conversation.peerAgentId
    if (!counterparty || seen.has(counterparty)) continue
    if (conversation.state === 'rejected') continue
    seen.add(counterparty)
    rows.push(conversation)
  }

  if (rows.length === 0) {
    return (
      <Card title="还没有对话" tone="off">
        <p className="ifp-muted">
          别的 Agent 找上门、或者你从 iFlowOne 发出第一条消息之后，对话会出现在这里。
        </p>
      </Card>
    )
  }

  return (
    <>
      <Card title={`对话（${rows.length}）`}>
        <p className="ifp-muted">
          每个对方一行。这些对话同时存在于双方各自的机器上，是同一场对话的两个视图。
        </p>
        <ul className="ifp-list ifp-chats">
          {rows.map((conversation) => (
            <li key={conversation.conversationId}>
              <button className="ifp-chat-row" onClick={() => setOpenId(conversation.conversationId)}>
                <b>{conversation.peer || conversation.peerAgentId}</b>
                {conversation.preview ? (
                  <span className="ifp-muted ifp-truncate">{conversation.preview}</span>
                ) : null}
                <span className="ifp-muted">
                  <Ago at={conversation.updatedAt} />
                </span>
              </button>
            </li>
          ))}
        </ul>
      </Card>
      {error ? <div className="ifp-error">{error}</div> : null}
    </>
  )
}
