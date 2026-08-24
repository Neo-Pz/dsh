/**
 * The control panel's HTTP face.
 *
 * These are the routes behind the "go online" button. They exist because the
 * decision they carry — publish this machine's facts, or stop — belongs to a
 * person, and a person should not have to edit a config file and restart a
 * process to make it.
 *
 * ── Why every write here refuses a remote caller ──
 *
 * DSH's web server can be bound to 0.0.0.0 (this plugin's own docs tell
 * operators to do exactly that so a second machine can reach the A2A endpoint).
 * A route that publishes this machine with one POST, reachable from the LAN, is
 * a route that lets anyone on the network publish it for you. So the panel
 * answers its own machine only: loopback, or a caller holding the node's bearer
 * token. The panel controls this computer; it talks to this computer.
 */

/**
 * Is this request from the machine the panel is running on?
 *
 * Node reports IPv4-mapped IPv6 for loopback in some configurations
 * (`::ffff:127.0.0.1`), so the string is normalised before comparison rather
 * than matched exactly.
 */
export function isLoopbackRequest(request) {
  const address = request?.socket?.remoteAddress
  if (typeof address !== 'string' || address.length === 0) {
    // No address means no proof of origin. Refuse: a write path is not the
    // place to give the benefit of the doubt.
    return false
  }
  const normalised = address.replace(/^::ffff:/i, '')
  return normalised === '127.0.0.1' || normalised === '::1' || normalised === 'localhost' || normalised.startsWith('127.')
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let text = ''
    request.on('data', (chunk) => {
      text += chunk.toString('utf8')
      // A control-panel request is a few hundred bytes. Anything larger is not
      // one, and streaming it into memory would be the bug.
      if (text.length > 64 * 1024) reject(new Error('body too large'))
    })
    request.on('end', () => resolve(text))
    request.on('error', reject)
  })
}

async function readJson(request) {
  const text = await readBody(request)
  if (!text.trim()) return {}
  return JSON.parse(text)
}

function send(response, status, body) {
  const text = JSON.stringify(body)
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  })
  response.end(text)
}

/**
 * Install the panel routes.
 *
 * `deps` is the whole surface the panel is allowed to touch — deliberately
 * narrow. It cannot reach the command channel, the peer registry, or anything
 * else: this is the publish gate, not a remote console.
 */
export function installPanelRoutes(ctx, webServer, deps) {
  const guard = (handler, { write }) => async (request, response) => {
    if (write && !isLoopbackRequest(request) && !deps.authorizeRemote(request)) {
      return send(response, 403, {
        error: 'the iFlow panel answers this machine only',
        detail:
          'This request did not come from the local machine. Open the panel in DSH on the machine you want to publish.',
      })
    }
    try {
      await handler(request, response)
    } catch (err) {
      const message = err && err.message ? err.message : String(err)
      send(response, 500, { error: message })
    }
  }

  const routes = [
    ['/iflow/panel/state', 'GET', guard(async (_request, response) => {
      send(response, 200, await deps.state())
    }, { write: false })],

    ['/iflow/panel/claim/start', 'POST', guard(async (_request, response) => {
      send(response, 200, await deps.claimStart())
    }, { write: true })],

    ['/iflow/panel/claim/poll', 'POST', guard(async (request, response) => {
      const body = await readJson(request)
      send(response, 200, await deps.claimPoll(body))
    }, { write: true })],

    ['/iflow/panel/publish/stop', 'POST', guard(async (_request, response) => {
      send(response, 200, await deps.stopPublishing())
    }, { write: true })],

    ['/iflow/panel/visibility', 'POST', guard(async (request, response) => {
      const body = await readJson(request)
      send(response, 200, await deps.setVisibility(body.visibility))
    }, { write: true })],

    ['/iflow/panel/identity/fetch', 'POST', guard(async (_request, response) => {
      send(response, 200, await deps.fetchIdentity())
    }, { write: true })],

    ['/iflow/panel/principal/declare', 'POST', guard(async (request, response) => {
      const body = await readJson(request)
      send(response, 200, await deps.declarePrincipal(body.label))
    }, { write: true })],

    ['/iflow/panel/agents/declare', 'POST', guard(async (request, response) => {
      const body = await readJson(request)
      send(response, 200, await deps.declareAgent(body))
    }, { write: true })],

    // The Requests inbox: what is waiting on the person at this machine, and
    // the two answers they can give. Accepting is what creates a session and
    // lets a remote agent's message reach a model, so it is a write and takes
    // the loopback guard like every other one.
    //
    // Read is local-only too, unlike the projections: the list carries the
    // message excerpt and the bound local session id, neither of which appears
    // in `/iflow/projection/requests` precisely because that one is shareable.
    ['/iflow/panel/conversations', 'GET', guard(async (_request, response) => {
      send(response, 200, await deps.listConversations())
    }, { write: true })],

    ['/iflow/panel/conversations/accept', 'POST', guard(async (request, response) => {
      const body = await readJson(request)
      send(response, 200, await deps.acceptConversation(body.conversationId))
    }, { write: true })],

    ['/iflow/panel/conversations/reject', 'POST', guard(async (request, response) => {
      const body = await readJson(request)
      send(response, 200, await deps.rejectConversation(body.conversationId, body.reason))
    }, { write: true })],

    // The relationship graph the Hub's Network tab draws. Guarded like the rest
    // of the panel rather than served as a projection: who this machine has
    // talked to is not the same kind of fact as what it published, and the
    // panel has exactly one access rule.
    ['/iflow/panel/network', 'GET', guard(async (_request, response) => {
      send(response, 200, await deps.networkMap())
    }, { write: true })],

    // Reachability on demand. Kept off the polled `/state` payload on purpose:
    // probing every peer on a 15-second timer is a scheduled port-scan.
    ['/iflow/panel/peers/probe', 'POST', guard(async (_request, response) => {
      send(response, 200, await deps.probePeers())
    }, { write: true })],
  ]

  for (const [path, method, handler] of routes) {
    ctx.effect(() =>
      webServer.register({
        kind: 'exact',
        path,
        handler: async (request, response) => {
          if (request.method === 'OPTIONS') {
            // Same-origin only: the panel ships inside DSH's own web app. No
            // cross-origin allowance is granted, which is the point.
            response.writeHead(204, { Allow: `${method}, OPTIONS` })
            return response.end()
          }
          if (request.method !== method) {
            return send(response, 405, { error: `use ${method}` })
          }
          return handler(request, response)
        },
      }),
    )
  }
}
