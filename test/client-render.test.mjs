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
    principal: {
      principalId: 'iflow:principal:11111111-1111-4111-8111-111111111111',
      authorityDid: 'did:key:zPrincipal',
      authorityVersion: 1,
      label: 'Acme',
    },
    principalMigration: { state: 'complete' },
    availablePrincipals: [],
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
let nativePickerCalls = 0
const browseCalls = []

const DIRECTORY_LISTINGS = {
  'F:/work': {
    path: 'F:/work',
    home: 'F:/work',
    crumbs: [{ name: 'work', path: 'F:/work', hidden: false }],
    entries: [{ name: 'agent-chats', path: 'F:/work/agent-chats', hidden: false }],
    truncated: false,
  },
  'F:/work/agent-chats': {
    path: 'F:/work/agent-chats',
    home: 'F:/work',
    crumbs: [
      { name: 'work', path: 'F:/work', hidden: false },
      { name: 'agent-chats', path: 'F:/work/agent-chats', hidden: false },
    ],
    entries: [],
    truncated: false,
  },
}

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
    workspaces: {
      listDirectory: async (path) => {
        browseCalls.push(path)
        return DIRECTORY_LISTINGS[path ?? 'F:/work']
      },
      // This deployment deliberately serves browse, exactly the configuration
      // that used to fail when iFlow called the native-only API first.
      pickDirectory: async () => {
        nativePickerCalls += 1
        throw new Error('host.pickDirectory needs the native capability')
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

  it('renders every tab, by name', async () => {
    // Counting them said "five" and nothing about which five, so adding one
    // failed with a number instead of a name. The labels are what a person
    // navigates by.
    await mount(slots.get('settings.section'))
    const labels = tabs().map((tab) => tab.textContent.replace(/\d+$/, ''))
    assert.deepEqual(labels, ['待处理', '对话', 'Agents', '网络', '交易', '我'])
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

  it('calls a revoked pair what it is: a re-authorization, not a new stranger', async () => {
    responses['/iflow/panel/conversations'] = {
      ok: true,
      conversations: [{
        ...PENDING_CONVERSATION,
        communicationState: 'reauthorization_required',
        peer: 'wwee',
      }],
    }
    await mount(slots.get('settings.section'))
    assert.match(container.textContent, /等待重新授权/)
    assert.match(container.textContent, /通信许可已撤销/)

    responses['/iflow/panel/conversations'] = { ok: true, conversations: [PENDING_CONVERSATION] }
  })

  it('shows only what is actually waiting on a person', async () => {
    // This page answers one question: may this Agent contact me. A thread that
    // was already accepted has answered it, and listing it here both read as a
    // contradiction and buried the row that did need someone.
    responses['/iflow/panel/state'] = baseState({ conversationsPending: 1 })
    responses['/iflow/panel/conversations'] = {
      ok: true,
      conversations: [
        { ...PENDING_CONVERSATION, conversationId: 'conv-new', state: 'pending', peer: 'stranger' },
        { ...PENDING_CONVERSATION, conversationId: 'conv-old', state: 'accepted', peer: 'weww' },
        { ...PENDING_CONVERSATION, conversationId: 'conv-done', state: 'closed', peer: 'if-dsk' },
      ],
    }
    await mount(slots.get('settings.section'))
    await clickTab('待处理')

    assert.match(container.textContent, /1 条等你答复/)
    assert.match(container.textContent, /stranger/)
    assert.equal(container.textContent.includes('weww'), false, 'an accepted thread is still listed here')
    assert.equal(container.textContent.includes('if-dsk'), false, 'a closed thread is still listed here')

    responses['/iflow/panel/state'] = baseState()
    responses['/iflow/panel/conversations'] = { ok: true, conversations: [PENDING_CONVERSATION] }
  })

  it('says the permission is standing, not per message', async () => {
    // The whole reason the list shrank: accepting once allows the pair, so a
    // person should not expect to see them here again.
    responses['/iflow/panel/state'] = baseState({ conversationsPending: 0 })
    responses['/iflow/panel/conversations'] = {
      ok: true,
      conversations: [{ ...PENDING_CONVERSATION, conversationId: 'conv-old', state: 'accepted', peer: 'weww' }],
    }
    await mount(slots.get('settings.section'))
    await clickTab('待处理')

    assert.match(container.textContent, /没有待处理的事/)
    assert.match(container.textContent, /不再回到这里/)

    responses['/iflow/panel/state'] = baseState()
    responses['/iflow/panel/conversations'] = { ok: true, conversations: [PENDING_CONVERSATION] }
  })

  it('offers a ruling on work handed back, separately from accepting the thread', async () => {
    // Accepting a conversation and accepting the work are different agreements
    // made at different times. If they ever share a control, someone rules on
    // work by clicking the thing that means "yes, we can talk".
    responses['/iflow/panel/state'] = baseState({ conversationsPending: 0 })
    responses['/iflow/panel/conversations'] = {
      ok: true,
      conversations: [
        {
          ...PENDING_CONVERSATION,
          conversationId: 'conv-d',
          state: 'accepted',
          peer: 'if-lt-b',
          deliveries: [{ deliveryId: 'del-1', taskId: 'task-1', receivedAt: '2026-08-24T10:00:00.000Z' }],
        },
      ],
    }
    await mount(slots.get('settings.section'))
    await clickTab('待处理')

    assert.match(container.textContent, /等你验收/)
    assert.match(container.textContent, /验收/)
    assert.match(container.textContent, /退回/)
    // The thread is already accepted, so the conversation's own answers are gone
    // and only the ruling is on offer.
    assert.equal(container.querySelector('.ifp-req.waiting'), null)

    responses['/iflow/panel/state'] = baseState()
    responses['/iflow/panel/conversations'] = { ok: true, conversations: [PENDING_CONVERSATION] }
  })

  it('will not send work back without a reason', async () => {
    // The far side has nothing to act on without one, and the domain requires
    // it. Enforced in the UI too, so the refusal is not a round trip.
    responses['/iflow/panel/state'] = baseState({ conversationsPending: 0 })
    responses['/iflow/panel/conversations'] = {
      ok: true,
      conversations: [
        {
          ...PENDING_CONVERSATION,
          conversationId: 'conv-d',
          state: 'accepted',
          deliveries: [{ deliveryId: 'del-1', taskId: 'task-1', receivedAt: '2026-08-24T10:00:00.000Z' }],
        },
      ],
    }
    await mount(slots.get('settings.section'))
    await clickTab('待处理')

    const openSendBack = [...container.querySelectorAll('button')].find((b) => b.textContent.startsWith('退回'))
    assert.ok(openSendBack, 'no way to send work back')
    await React.act(async () => {
      openSendBack.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
    })

    const confirm = [...container.querySelectorAll('button')].find((b) => b.textContent === '确认退回')
    assert.ok(confirm, 'the reason step did not open')
    assert.equal(confirm.disabled, true, 'work could be sent back with no reason given')

    responses['/iflow/panel/state'] = baseState()
    responses['/iflow/panel/conversations'] = { ok: true, conversations: [PENDING_CONVERSATION] }
  })

  it('says when conversations are being filed outside the workspace you are looking at', async () => {
    // Filing them where they were asked to go is correct. But DSH groups its
    // session list by folder, so they show up under 未分组 from here, and the
    // only reading available to someone looking at that is that something broke.
    responses['/iflow/panel/state'] = baseState({
      conversationWorkspace: {
        path: 'F:/work/dsh-wechat',
        defaultPath: 'F:/work',
        confirmed: true,
        elsewhere: true,
      },
    })
    await mount(slots.get('settings.section'))
    await clickTab('我')

    assert.match(container.textContent, /不是你当前打开的 DSH 工作区/)
    assert.match(container.textContent, /未分组/)
    // And it says what to do about it, including that nothing gets moved.
    assert.match(container.textContent, /已有对话不会被移动/)

    responses['/iflow/panel/state'] = baseState()
  })

  it('says nothing when the two are the same folder', async () => {
    // A warning that is always on is furniture.
    responses['/iflow/panel/state'] = baseState({
      conversationWorkspace: { path: 'F:/work', defaultPath: 'F:/work', confirmed: true, elsewhere: false },
    })
    await mount(slots.get('settings.section'))
    await clickTab('我')

    assert.equal(container.textContent.includes('不是你当前打开的 DSH 工作区'), false)

    responses['/iflow/panel/state'] = baseState()
  })

  it('lists Agents allowed to keep messaging, and offers to take it back', async () => {
    // Something granted by a click has to be findable and withdrawable by one,
    // or it is not really a decision — it is a consequence.
    responses['/iflow/panel/state'] = baseState({
      allowedPairs: [
        {
          localAgentDid: 'did:key:zLocal',
          peerAgentDid: 'did:key:zPeer',
          peerLabel: 'wwee',
          grantedAt: '2026-08-24T10:00:00.000Z',
        },
      ],
    })
    await mount(slots.get('settings.section'))
    await clickTab('我')

    assert.match(container.textContent, /已授权的 Agent（1）/)
    assert.match(container.textContent, /wwee/)
    // States the boundary where someone reads it: allowing messages is not
    // allowing anything else.
    assert.match(container.textContent, /跑工具、花钱、验收任务都是分开的事/)
    assert.ok(
      [...container.querySelectorAll('button')].some((b) => b.textContent === '撤销'),
      'no way to withdraw a standing permission',
    )

    responses['/iflow/panel/state'] = baseState()
  })

  it('says how permission gets granted when none has been', async () => {
    responses['/iflow/panel/state'] = baseState({ allowedPairs: [] })
    await mount(slots.get('settings.section'))
    await clickTab('我')

    assert.match(container.textContent, /还没有/)
    assert.match(container.textContent, /不再每次来问你/)

    responses['/iflow/panel/state'] = baseState()
  })

  it('draws a conversation with the other party on the left, whoever wrote it', async () => {
    // DSH's own session view cannot do this and should not be blamed for it: a
    // peer's message has to arrive as a user turn to prompt the local Agent,
    // and DSH puts user turns on the right. This view reads the authorship the
    // plugin records instead.
    responses['/iflow/panel/conversations'] = {
      ok: true,
      conversations: [{ ...PENDING_CONVERSATION, conversationId: 'conv-x', state: 'accepted', peer: 'if-lt-b' }],
    }
    responses['/iflow/panel/conversations/messages'] = {
      ok: true,
      conversationId: 'conv-x',
      messages: [
        {
          messageId: 'm1', side: 'peer', role: 'human', authorLabel: 'if-lt-b',
          text: '他们那边有人打的字', createdAt: '2026-08-24T10:00:00.000Z',
        },
        {
          messageId: 'm2', side: 'self', role: 'human', authorLabel: 'GenOnA',
          text: '我打的字', createdAt: '2026-08-24T10:01:00.000Z',
        },
        {
          messageId: 'm3', side: 'self', role: 'agent', authorLabel: 'GenOnA',
          text: '我的 Agent 自己说的', createdAt: '2026-08-24T10:02:00.000Z',
        },
      ],
      nextCursor: '3',
    }
    await mount(slots.get('settings.section'))
    await clickTab('对话')
    const row = [...container.querySelectorAll('button')].find((b) => b.textContent.includes('if-lt-b'))
    assert.ok(row, 'the counterparty is not listed')
    await React.act(async () => {
      row.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
    })
    await settle()

    const lines = [...container.querySelectorAll('.ifp-msg')]
    assert.equal(lines.length, 3)

    // A person on the far side: human badge, and still on the left.
    assert.ok(lines[0].classList.contains('theirs'), 'the other party is not on the left')
    assert.match(lines[0].textContent, /👤/)
    assert.match(lines[0].textContent, /对方 · 经由 if-lt-b/)

    // My own typing: same badge, other side, and both names on it.
    assert.ok(lines[1].classList.contains('mine'))
    assert.match(lines[1].textContent, /你 · 经由 GenOnA/)

    // My Agent speaking for itself: no person, just the Agent.
    assert.ok(lines[2].classList.contains('mine'))
    assert.match(lines[2].textContent, /🤖/)
    assert.equal(lines[2].textContent.includes('经由'), false, 'an Agent’s own words were attributed to a person')

    responses['/iflow/panel/conversations'] = { ok: true, conversations: [PENDING_CONVERSATION] }
  })

  it('marks a paused Chat as non-sendable without hiding its history', async () => {
    responses['/iflow/panel/conversations'] = {
      ok: true,
      conversations: [{
        ...PENDING_CONVERSATION,
        state: 'active', peer: 'wwee', communicationState: 'reauthorization_required',
      }],
    }
    await mount(slots.get('settings.section'))
    await clickTab('对话')
    const row = [...container.querySelectorAll('button')].find((button) => button.textContent.includes('wwee'))
    assert.ok(row)
    await React.act(async () => row.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })))
    await settle()
    assert.match(container.textContent, /通信许可已撤销/)
    assert.match(container.textContent, /不能发送/)

    responses['/iflow/panel/conversations'] = { ok: true, conversations: [PENDING_CONVERSATION] }
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

  it('uses the Host browse capability for a conversation folder before native picking', async () => {
    const previous = responses['/iflow/panel/state']
    responses['/iflow/panel/state'] = baseState({
      conversationsPending: 0,
      conversationWorkspace: { path: 'F:/work', defaultPath: 'F:/work', confirmed: false },
    })
    nativePickerCalls = 0
    browseCalls.length = 0
    try {
      await mount(slots.get('settings.section'))
      const choose = [...container.querySelectorAll('button')].find((button) => button.textContent === '选择文件夹')
      assert.ok(choose, 'the local workspace control should offer the composed picker')
      await React.act(async () => {
        choose.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
      })
      await settle()
      assert.deepEqual(browseCalls, ['F:/work'])
      assert.equal(nativePickerCalls, 0, 'browse deployments must not call the native-only API')
      assert.match(container.textContent, /agent-chats/)
    } finally {
      responses['/iflow/panel/state'] = previous
    }
  })

  it('requires an explicit confirmation before migrating a legacy Principal', async () => {
    const current = responses['/iflow/panel/state']
    responses['/iflow/panel/state'] = baseState({
      principal: {
        legacy: true,
        principalId: null,
        authorityDid: 'did:key:zLegacy',
        authorityVersion: 1,
        label: 'Legacy owner',
      },
      principalMigration: {
        state: 'required',
        action: 'import-new',
        legacyAuthorityDid: 'did:key:zLegacy',
        agentCount: 1,
      },
    })
    try {
      await mount(slots.get('settings.section'))
      await clickTab('我')
      assert.match(container.textContent, /需要迁移旧 Principal/)
      assert.match(container.textContent, /did:key:zLegacy/)
      const migrate = [...container.querySelectorAll('button')].find((button) => button.textContent.includes('备份并迁移'))
      assert.ok(migrate)
      assert.equal(migrate.disabled, true, 'the DID acknowledgement is not optional')
    } finally {
      responses['/iflow/panel/state'] = current
    }
  })

  it('stops instead of guessing when one Authority maps to multiple Principals', async () => {
    const current = responses['/iflow/panel/state']
    responses['/iflow/panel/state'] = baseState({
      principal: {
        legacy: true,
        principalId: null,
        authorityDid: 'did:key:zAmbiguous',
        authorityVersion: 1,
        label: 'Legacy owner',
      },
      principalMigration: {
        state: 'ambiguous',
        legacyAuthorityDid: 'did:key:zAmbiguous',
        candidates: ['iflow:principal:first-owner', 'iflow:principal:second-owner'],
      },
    })
    try {
      await mount(slots.get('settings.section'))
      await clickTab('我')
      assert.match(container.textContent, /迁移已暂停/)
      assert.match(container.textContent, /不会猜测/)
      assert.equal(
        [...container.querySelectorAll('button')].some((button) => button.textContent.includes('迁移')),
        false,
      )
    } finally {
      responses['/iflow/panel/state'] = current
    }
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
