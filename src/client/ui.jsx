/**
 * The two presentational pieces every tab shares.
 *
 * Small on purpose. A plugin panel that grows its own design system is a
 * plugin panel that stops looking like the app it lives in — the styles here
 * resolve to DSH's own `--dsw-alias-*` tokens, and the shapes are the two the
 * panel actually repeats.
 */

import React from 'react'

export function Card({ title, tone, children, actions }) {
  return (
    <div className="ifp-card">
      {title ? (
        <div className="ifp-card-head">
          {tone ? <span className={`ifp-dot ${tone}`} /> : null}
          <h3>{title}</h3>
        </div>
      ) : null}
      {children}
      {actions ? <div className="ifp-actions">{actions}</div> : null}
    </div>
  )
}

/**
 * "3 分钟前" rather than a timestamp.
 *
 * For everything this panel shows — when a peer was last reachable, when
 * someone started waiting for an answer — the useful question is how long,
 * not when.
 */
export function Ago({ at }) {
  if (!at) return <span className="ifp-muted">从未</span>
  const then = typeof at === 'number' ? at : Date.parse(at)
  if (!Number.isFinite(then)) return <span className="ifp-muted">未知</span>
  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000))
  if (seconds < 60) return <span>刚刚</span>
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return <span>{minutes} 分钟前</span>
  const hours = Math.round(minutes / 60)
  if (hours < 24) return <span>{hours} 小时前</span>
  return <span>{Math.round(hours / 24)} 天前</span>
}
