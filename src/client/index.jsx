/**
 * The plugin's browser half.
 *
 * DSH mounts plugin UI by loading this bundle into its web app and letting it
 * register components into named slots. Three seats, one surface:
 *
 *   sidebar.footer.action  a button beside Settings that says whether this
 *                          machine is publishing, and opens the panel
 *   shell.overlay          the panel itself, over the app
 *   settings.section       the same panel as a settings page, for someone who
 *                          goes looking rather than acting
 *
 * The button carries the state because the answer to "is my machine
 * publishing" should not require opening anything, and because a gate nobody
 * can find is a gate that does not work. The overlay is where the decision is
 * actually taken — the consent list needs room, and it should sit above the
 * app rather than behind two clicks of navigation.
 */

import React from 'react'

import { IFlowLauncher, IFlowOverlay } from './Launcher.jsx'
import { IFlowHub } from './Hub.jsx'
import { insertStyles } from './styles.js'

/**
 * Open/closed, shared between two independently mounted slot entries.
 *
 * The button and the overlay are separate registrations in separate parts of
 * the tree, so the state cannot live in either of them. A module-level store
 * with subscribers is the smallest thing that lets one open the other.
 */
function createOpenState() {
  let open = false
  const listeners = new Set()
  return {
    get: () => open,
    set(next) {
      open = next
      for (const listener of listeners) listener(open)
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

function useOpen(store) {
  return React.useSyncExternalStore(store.subscribe, store.get, store.get)
}

export const inject = ['slots', 'workspaces']

export function apply(ctx) {
  const disposeStyles = insertStyles()
  const openState = createOpenState()

  function LauncherEntry(props) {
    return <IFlowLauncher wide={props.wide} onOpen={() => openState.set(true)} />
  }

  function OverlayEntry() {
    const open = useOpen(openState)
    return (
      <IFlowOverlay open={open} onClose={() => openState.set(false)}>
        <IFlowHub pickWorkspace={() => ctx.workspaces?.pickDirectory?.()} />
      </IFlowOverlay>
    )
  }

  const disposeLauncher = ctx.slots.inject('sidebar.footer.action', () =>
    ctx.slots.register({ name: 'sidebar.footer.action', id: 'iflow', order: 20 }, LauncherEntry),
  )

  const disposeOverlay = ctx.slots.inject('shell.overlay', () =>
    ctx.slots.register({ name: 'shell.overlay', id: 'iflow-panel', order: 30 }, OverlayEntry),
  )

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
      () => <IFlowHub pickWorkspace={() => ctx.workspaces?.pickDirectory?.()} />,
    ),
  )

  return () => {
    disposeSection?.()
    disposeOverlay?.()
    disposeLauncher?.()
    disposeStyles()
  }
}

export { IFlowHub }
