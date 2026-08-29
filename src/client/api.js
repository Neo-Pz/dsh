/**
 * The panel's calls into its own Node half.
 *
 * Same origin — the panel is served inside DSH's web app, and the routes it
 * talks to are registered on DSH's own web server — so there is no base URL to
 * configure and no credential to hold. That is deliberate: a control surface
 * whose address can be pointed somewhere else is a control surface that can be
 * pointed at someone else's machine.
 */

async function call(path, { method = 'GET', body } = {}) {
  const response = await fetch(path, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    // Never cache a control surface: a stale "you are publishing" is worse than
    // a slow one.
    cache: 'no-store',
  })

  let payload
  try {
    payload = await response.json()
  } catch {
    payload = {}
  }

  if (!response.ok) {
    const message = payload && payload.error ? payload.error : `request failed (${response.status})`
    const error = new Error(message)
    error.status = response.status
    error.detail = payload && payload.detail
    throw error
  }
  return payload
}

export const api = {
  state: () => call('/iflow/panel/state'),
  claimStart: () => call('/iflow/panel/claim/start', { method: 'POST' }),
  claimPoll: () => call('/iflow/panel/claim/poll', { method: 'POST' }),
  stop: () => call('/iflow/panel/publish/stop', { method: 'POST' }),
  setVisibility: (visibility) => call('/iflow/panel/visibility', { method: 'POST', body: { visibility } }),
  setConversationWorkspace: (path) =>
    call('/iflow/panel/conversation-workspace', { method: 'POST', body: { path } }),
  fetchIdentity: () => call('/iflow/panel/identity/fetch', { method: 'POST' }),
  declarePrincipal: (label) => call('/iflow/panel/principal/declare', { method: 'POST', body: { label } }),
  bindPrincipal: (principalId) => call('/iflow/panel/principal/bind', { method: 'POST', body: { principalId } }),
  principalMigrationPlan: () => call('/iflow/panel/principal/migration/plan', { method: 'POST' }),
  migratePrincipal: (input) => call('/iflow/panel/principal/migration/execute', { method: 'POST', body: input }),
  declareAgent: (input) => call('/iflow/panel/agents/declare', { method: 'POST', body: input }),
  confirmWebLogin: (userCode) =>
    call('/iflow/panel/web-login/confirm', { method: 'POST', body: { userCode } }),

  // Conversations: the inbox, and the two answers a person can give it.
  conversations: () => call('/iflow/panel/conversations'),
  acceptConversation: (conversationId) =>
    call('/iflow/panel/conversations/accept', { method: 'POST', body: { conversationId } }),
  rejectConversation: (conversationId, reason) =>
    call('/iflow/panel/conversations/reject', { method: 'POST', body: { conversationId, reason } }),

  // Ruling on work a remote Agent handed back. Not the same act as accepting
  // the conversation: agreeing to talk is not agreeing the work is done.
  decideDelivery: (conversationId, deliveryId, decision, reason) =>
    call('/iflow/panel/deliveries/decide', {
      method: 'POST',
      body: { conversationId, deliveryId, decision, reason },
    }),

  network: () => call('/iflow/panel/network'),
  probePeers: () => call('/iflow/panel/peers/probe', { method: 'POST' }),
}
