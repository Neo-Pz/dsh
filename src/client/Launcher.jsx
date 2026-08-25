/**
 * The always-visible way in.
 *
 * A publish gate buried in Settings is a gate nobody finds. This sits beside
 * Settings in the sidebar and states the one thing about this machine that a
 * person needs at a glance — is it publishing — then opens the panel over the
 * app when they want to act on it.
 *
 * The label is the status, not a product name. "iFlow" tells you nothing you
 * did not already know; "未上线" answers the question the button exists for.
 */

import React from 'react'

import { api } from './api.js'

const REFRESH_MS = 15000

function Dot({ tone }) {
  return React.createElement('span', { className: `ifp-dot ${tone}` })
}

export function IFlowLauncher({ wide, onOpen }) {
  const [publishing, setPublishing] = React.useState(null)
  const [pending, setPending] = React.useState(0)
  const [reachable, setReachable] = React.useState(true)

  React.useEffect(() => {
    let cancelled = false
    const read = async () => {
      try {
        const state = await api.state()
        if (cancelled) return
        setPublishing(state.publishing)
        // Free: this read was already happening for the publish status, so
        // showing that somebody is waiting costs no extra request.
        setPending(state.conversationsPending ?? 0)
        setReachable(true)
      } catch {
        // The edge starts asynchronously and can be a moment behind the UI.
        // Saying nothing is better than claiming a state we could not read.
        if (!cancelled) setReachable(false)
      }
    }
    read()
    const timer = setInterval(read, REFRESH_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [])

  // Something waiting on a person outranks everything else this button could
  // say. Publishing state is a standing fact you can read whenever; a held
  // conversation is a remote Agent blocked until someone here answers.
  const waiting = reachable && pending > 0
  const tone = !reachable ? 'off' : waiting ? 'warn' : publishing ? 'on' : 'warn'
  const label = !reachable
    ? 'iFlow'
    : waiting
      ? `iFlow · ${pending} 条待处理`
      : publishing
        ? 'iFlow 已上线'
        : 'iFlow 未上线'
  const title = waiting
    ? `${pending} 个 Agent 在等你答复`
    : publishing
      ? `正在向 ${publishing.url} 发布事实`
      : '这台机器的事实还没有离开过本机'

  return (
    <button
      type="button"
      className={`ifp-launcher${wide ? '' : ' narrow'}`}
      onClick={onOpen}
      title={title}
    >
      <Dot tone={tone} />
      {wide === false ? null : <span className="ifp-launcher-label">{label}</span>}
      {/* Narrow rail: the label is hidden, so the count is the only signal. */}
      {waiting && wide === false ? <span className="ifp-badge">{pending}</span> : null}
    </button>
  )
}

/**
 * The panel, over the app.
 *
 * `shell.overlay` is a frame-wide layer shared with other plugins, so this
 * renders nothing at all when closed rather than an invisible box that eats
 * clicks meant for the app underneath.
 */
export function IFlowOverlay({ open, onClose, children }) {
  React.useEffect(() => {
    if (!open) return undefined
    const onKey = (event) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  return React.createElement(
    'div',
    {
      className: 'ifp-scrim',
      onClick: (event) => {
        // Only a click on the scrim itself closes; a click that started inside
        // the panel must not dismiss the consent list someone is reading.
        if (event.target === event.currentTarget) onClose()
      },
    },
    React.createElement(
      'div',
      { className: 'ifp-sheet', role: 'dialog', 'aria-label': 'iFlow' },
      React.createElement(
        'button',
        { type: 'button', className: 'ifp-close', onClick: onClose, 'aria-label': '关闭' },
        '×',
      ),
      children,
    ),
  )
}
