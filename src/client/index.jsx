/**
 * The plugin's browser half.
 *
 * DSH mounts plugin UI by loading this bundle into its web app and letting it
 * register components into named slots. `settings.section` is a whole page with
 * its own navigation row — the right home for a surface someone visits
 * deliberately, once, to decide whether this machine joins the network. It is
 * not a thing to put in the conversation dock where it would be clicked by
 * accident.
 */

import React from 'react'

import { IFlowPanel } from './Panel.jsx'
import { insertStyles } from './styles.js'

/** DSH offers no icon option on a slot registration, so the mark is drawn here. */
function Mark() {
  return React.createElement(
    'svg',
    { width: 16, height: 16, viewBox: '0 0 16 16', 'aria-hidden': true },
    React.createElement('rect', { x: 1, y: 1, width: 14, height: 14, rx: 4, fill: '#2f6df6' }),
    React.createElement('path', { d: 'M5 5.5h6M5 8h4M5 10.5h5', stroke: '#fff', strokeWidth: 1.4, strokeLinecap: 'round' }),
  )
}

export const inject = ['slots']

export function apply(ctx) {
  const disposeStyles = insertStyles()

  const disposeSection = ctx.slots.inject('settings.section', () =>
    ctx.slots.register(
      {
        name: 'settings.section',
        id: 'iflow',
        order: 60,
        // A thunk, so the label re-reads if the host's locale changes rather
        // than freezing whatever was current at registration.
        label: () => 'iFlow · 弗流',
      },
      IFlowPanel,
    ),
  )

  return () => {
    disposeSection?.()
    disposeStyles()
  }
}

export { IFlowPanel, Mark }
