/**
 * The panel, actually rendered.
 *
 * `client-bundle.test.mjs` checks the bundle's shape — how it registers, what
 * it must not carry, how big it may be. None of that would notice a component
 * that throws on first paint or a tab that renders nothing, and the Hub is
 * five tabs of React that a person only sees inside DSH's web app, where a
 * mistake surfaces in someone else's browser with no stack trace worth reading.
 *
 * So this mounts the REAL `lib/client.js` in jsdom, with the real React, and
 * clicks through it. The panel's backend is stubbed at `fetch`, which is the
 * boundary the browser half actually has.
 *
 * `react`, `react-dom` and `jsdom` are devDependencies. They are not bundled:
 * the build lists react as host-provided and `client-bundle.test.mjs` asserts
 * the bundle requires it rather than inlining it.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { createRequire } from 'node:module'

const require_ = createRequire(import.meta.url)
const { JSDOM } = require_('jsdom')
const React = require_('react')
const ReactDOMClient = require_('react-dom/client')

const CLIENT = join(import.meta.dirname, '..', 'lib', 'client.js')

/** What the panel's routes answer. Mutated per test to drive a state. */
const responses = {
  '/iflow/panel/state': null,
  '/iflow/panel/conversations': null,
  '/iflow/panel/network': null,
}

function baseState(overrides = {}) {
  return {
    edgeReady: true,
    identity: { ready: true, did: 'did:key:zNode', error: null },
    signing: true,
    localAgents: 2,
    journal: { nodeId: 'node-1', lastSeq: 12, syncedSeq: 12 },
    pendingFacts: 0,
    publishing: null,
    principal: { did: 'did:key:zPrincipal', label: 'Acme' },
    declaredAgents: [
      { agentId: 'writer', label: 'Writer', did: 'did:key:zWriter', capabilities: ['iflow.cap:task.run'] },
    ],
    alias: 'if-lt',
    nodeId: 'node-1',
    workspaceRoot: 'F:/work',
    peers: [{ name: 'if-lt-b', url: 'http://192.168.1.20:3080', tokenSet: true, healthy: true, lastSeen: Date.now() }],
    conversationsPending: 2,
    relay: { configured: true, canSeal: true },
    trust: { default: 'ask', autoPeers: 1, blocked: 0 },
    posture: { acceptCommands: false, routeApprovals: false, authEnabled: false, boundHost: '127.0.0.1', port: 3080 },
    ...overrides,
  }
}

const PENDING_CONVERSATION = {
  conversationId: 'conv-1',
  peer: 'if-lt-b',
  peerDid: 'did:key:zPeer',
  state: 'pending',
  preview: '你能帮我分析这个 CSV 吗？',
  boundSession: null,
  createdAt: '2026-08-24T10:00:00.000Z',
  updatedAt: '2026-08-24T10:00:00.000Z',
}

const GRAPH = {
  ok: true,
  selfAgentId: 'node-1',
  nodes: [
    { id: 'node-1', kind: 'agent', label: 'if-lt', status: 'online' },
    { id: 'peer-b', kind: 'agent', label: 'if-lt-b', status: 'offline' },
    { id: 'peer-c', kind: 'agent', label: 'a-very-long-agent-name-here', status: 'online' },
  ],
  edges: [
    { id: 'rel:node-1->peer-b:contacted', source: 'node-1', target: 'peer-b', kind: 'contact', label: 'contacted ×3' },
    { id: 'rel:node-1->peer-c:worked_with', source: 'node-1', target: 'peer-c', kind: 'collaboration', label: 'worked_with' },
  ],
}

let dom
let slots
let container
let root

/** Let effects and their fetches settle. */
async function settle(times = 6) {
  for (let i = 0; i < times; i++) {
    await React.act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5))
    })
  }
}

/**
 * Mount fresh.
 *
 * Rendering the same component type again only re-renders it, and these
 * components fetch in a `[]`-dependency effect — so without unmounting first,
 * every test after the first asserts against the previous test's state and
 * passes or fails for the wrong reason.
 */
async function mount(Component, props = {}) {
  await React.act(async () => {
    root.render(null)
  })
  await React.act(async () => {
    root.render(React.createElement(Component, props))
  })
  await settle()
}

const tabs = () => [...container.querySelectorAll('.ifp-tab')]
const activeTab = () => container.querySelector('.ifp-tab.on')?.textContent ?? ''

async function clickTab(label) {
  const tab = tabs().find((element) => element.textContent.startsWith(label))
  assert.ok(tab, `no tab labelled ${label}; saw ${tabs().map((t) => t.textContent).join(' | ')}`)
  await React.act(async () => {
    tab.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  })
  await settle()
}

before(() => {
  dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://127.0.0.1:3080/',
  })
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  // Plain assignment throws: navigator is getter-only on Node's global.
  Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true })
  globalThis.HTMLElement = dom.window.HTMLElement
  globalThis.Element = dom.window.Element
  globalThis.Node = dom.window.Node
  globalThis.IS_REACT_ACT_ENVIRONMENT = true

  globalThis.fetch = async (path) => {
    const body = responses[path] ?? { ok: true }
    return { ok: true, status: 200, json: async () => body }
  }

  // Load the bundle the way DSH's module loader does.
  let descriptor
  dom.window.__ModuleLoader__ = { load: (loaded) => { descriptor = loaded } }
  // eslint-disable-next-line no-new-func
  new Function('window', readFileSync(CLIENT, 'utf8'))(dom.window)
  assert.ok(descriptor, 'the bundle did not register with the module loader')

  const plugin = descriptor.factory((name) => {
    if (name === 'react') return React
    if (name === 'react/jsx-runtime') return require_('react/jsx-runtime')
    if (name === 'react-dom') return require_('react-dom')
    if (name === 'react-dom/client') return ReactDOMClient
    return {}
  })

  slots = new Map()
  plugin.apply({
    slots: {
      inject: (_name, fn) => fn(),
      register: (spec, Component) => {
        slots.set(spec.name, Component)
        return () => {}
      },
    },
  })

  container = dom.window.document.getElementById('root')
  root = ReactDOMClient.createRoot(container)
})

after(async () => {
  // Every one of these components polls on an interval. Unmount so their
  // cleanup runs — otherwise the timers keep Node alive and the suite hangs
  // after the last assertion has already passed.
  await React.act(async () => {
    root.unmount()
  })
  dom.window.close()
})

describe('the sidebar button', () => {
  it('leads with what is waiting for a person', async () => {
    // Outranks publish status on purpose: a held conversation is a remote
    // Agent blocked until someone here answers, and the publish state is a
    // standing fact they can read whenever.
    responses['/iflow/panel/state'] = baseState({ conversationsPending: 2 })
    await mount(slots.get('sidebar.footer.action'), { wide: true })
    assert.match(container.textContent, /2 条待处理/)
  })

  it('falls back to publish status when nothing is waiting', async () => {
    responses['/iflow/panel/state'] = baseState({ conversationsPending: 0 })
    await mount(slots.get('sidebar.footer.action'), { wide: true })
    assert.match(container.textContent, /未上线/)
  })
})

describe('the Hub', () => {
  before(() => {
    responses['/iflow/panel/state'] = baseState()
    responses['/iflow/panel/conversations'] = { ok: true, conversations: [PENDING_CONVERSATION] }
    responses['/iflow/panel/network'] = GRAPH
  })

  it('renders all five tabs', async () => {
    await mount(slots.get('settings.section'))
    assert.equal(tabs().length, 5, tabs().map((t) => t.textContent).join(' | '))
  })

  it('lands on Requests when something is waiting, and badges the count', async () => {
    await mount(slots.get('settings.section'))
    assert.match(activeTab(), /^待处理/)
    assert.equal(container.querySelector('.ifp-badge')?.textContent, '2')
  })

  it('shows the held conversation with its excerpt and both answers', async () => {
    await mount(slots.get('settings.section'))
    assert.match(container.textContent, /你能帮我分析这个 CSV 吗？/)
    assert.ok(container.querySelector('.ifp-req.waiting'), 'a pending row should be marked')
    assert.match(container.textContent, /接受/)
    assert.match(container.textContent, /拒绝/)
  })

  it('shows peers and declared Agents', async () => {
    await mount(slots.get('settings.section'))
    await clickTab('Agents')
    assert.match(container.textContent, /if-lt-b/)
    assert.match(container.textContent, /192\.168\.1\.20/)
    assert.match(container.textContent, /Writer/)
  })

  it('draws one node per Agent and one line per relationship', async () => {
    await mount(slots.get('settings.section'))
    await clickTab('网络')
    const svg = container.querySelector('svg.ifp-map')
    assert.ok(svg, 'the star map did not render')
    assert.equal(svg.querySelectorAll('circle').length, 3)
    assert.equal(svg.querySelectorAll('line').length, 2)
    // `cx="NaN"` is not an error anywhere — it renders as an empty box.
    for (const circle of svg.querySelectorAll('circle')) {
      for (const attribute of ['cx', 'cy']) {
        assert.ok(Number.isFinite(Number(circle.getAttribute(attribute))), `${attribute} is not a number`)
      }
    }
  })

  it('says what Transactions is waiting for rather than showing a spinner', async () => {
    await mount(slots.get('settings.section'))
    await clickTab('交易')
    assert.match(container.textContent, /还没有交易/)
  })

  it('keeps the publish gate and the node identity in Me', async () => {
    await mount(slots.get('settings.section'))
    await clickTab('我')
    assert.match(container.textContent, /未上线/)
    assert.match(container.textContent, /node-1/)
    assert.match(container.textContent, /F:\/work/)
    assert.match(container.textContent, /新对话需要你同意/)
  })
})

describe('with nothing waiting', () => {
  before(() => {
    responses['/iflow/panel/state'] = baseState({ conversationsPending: 0 })
    responses['/iflow/panel/conversations'] = { ok: true, conversations: [] }
    responses['/iflow/panel/network'] = { ...GRAPH, edges: [] }
  })

  it('lands on Me, so the publish gate stays the first thing an idle operator sees', async () => {
    await mount(slots.get('settings.section'))
    assert.equal(activeTab(), '我')
  })

  it('explains the empty inbox instead of showing an empty list', async () => {
    await mount(slots.get('settings.section'))
    await clickTab('待处理')
    assert.match(container.textContent, /还没有人联系过这台机器/)
  })

  it('says there are no relationships rather than drawing a lonely dot', async () => {
    await mount(slots.get('settings.section'))
    await clickTab('网络')
    assert.match(container.textContent, /还没有和任何 Agent 打过交道/)
    assert.equal(container.querySelector('svg.ifp-map'), null)
  })
})

describe('when the backend is unreachable', () => {
  it('says so instead of rendering a broken panel', async () => {
    const working = globalThis.fetch
    globalThis.fetch = async () => {
      throw new Error('edge not up yet')
    }
    try {
      await mount(slots.get('settings.section'))
      assert.match(container.textContent, /edge not up yet/)
    } finally {
      globalThis.fetch = working
    }
  })
})
