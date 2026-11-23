import assert from 'node:assert/strict'
import { webcrypto } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { createContext, SourceTextModule, SyntheticModule } from 'node:vm'

const source = await readFile(new URL('../js/events.js', import.meta.url), 'utf8')
const resource = { kind: 'Pod', metadata: { uid: 'pod-1', name: 'pod-1' } }
const message = { data: JSON.stringify(resource) }

async function page({ crypto = webcrypto, storage, updateResource } = {}) {
  const streams = []
  const mutations = []
  const layouts = []
  const states = []
  const window = new EventTarget()
  window.addEventListener('connectionStateChange', (event) => states.push(event.detail.state))

  class EventSource {
    readyState = 0
    handlers = {}
    closeCalls = 0

    constructor(url) {
      this.url = url
      streams.push(this)
    }

    addEventListener(name, handler) {
      this.handlers[name] = handler
    }

    close() {
      this.closeCalls++
      this.readyState = 2
    }
  }

  const context = createContext({
    crypto,
    EventSource,
    window,
    CustomEvent,
    console: { log() {}, error() {} },
    localStorage: storage,
    sessionStorage: storage,
  })
  const imports = {
    './config.js': { getConfig: () => ({ debug: false }) },
    './graph.js': {
      addResource: (res) => mutations.push(['add', res]),
      removeResource: (res) => mutations.push(['delete', res]),
      updateResource: updateResource ?? ((res) => mutations.push(['update', res])),
      layout: async () => layouts.push('layout'),
    },
  }
  const module = new SourceTextModule(source, { context })
  await module.link((specifier) => {
    assert.ok(Object.hasOwn(imports, specifier), `Unexpected import: ${specifier}`)
    const values = imports[specifier]
    return new SyntheticModule(
      Object.keys(values),
      function () {
        for (const [name, value] of Object.entries(values)) this.setExport(name, value)
      },
      { context },
    )
  })
  await module.evaluate()
  return { events: module.namespace, streams, mutations, layouts, states }
}

test('tabs with identical inherited storage use independent page IDs without reading or writing storage', async () => {
  let storageAccesses = 0
  const storage = {
    getItem() {
      storageAccesses++
      return 'inherited-client'
    },
    setItem() {
      storageAccesses++
    },
  }
  const first = await page({ storage })
  const duplicate = await page({ storage })
  const reloaded = await page({ storage })
  const pages = [first, duplicate, reloaded]
  const ids = pages.map(({ events }) => events.getClientId())
  assert.equal(new Set(ids).size, pages.length)
  assert.ok(ids.every((id) => /^[0-9a-f-]{36}$/.test(id)))

  for (const [index, { events, streams }] of pages.entries()) {
    assert.equal(events.getClientId(), ids[index])
    events.initEventStreaming()
    events.initEventStreaming()
    assert.equal(streams.length, 1)
    assert.equal(new URL(streams[0].url, 'https://kubeview.test/').searchParams.get('clientID'), ids[index])
    events.stopEventStreaming()
    events.initEventStreaming()
    assert.equal(streams.length, 2)
    assert.equal(events.getClientId(), ids[index])
    assert.equal(streams[1].url, streams[0].url)
    events.stopEventStreaming()
  }
  assert.equal(storageAccesses, 0)
})

test('page IDs also remain independent and stable without crypto or randomUUID', async () => {
  for (const crypto of [null, {}]) {
    const first = await page({ crypto })
    const duplicate = await page({ crypto })
    const id = first.events.getClientId()
    assert.ok(id)
    assert.notEqual(id, duplicate.events.getClientId())
    assert.equal(first.events.getClientId(), id)
  }
})

test('reconnects reuse one stream and explicit stop ignores stale resources and connection callbacks', async () => {
  const { events, streams, mutations, layouts, states } = await page()
  events.initEventStreaming()
  events.initEventStreaming()
  const original = streams[0]
  original.readyState = 1
  original.onopen()
  assert.equal(states.at(-1), 'connected')

  for (const type of ['add', 'update', 'delete']) await original.handlers[type](message)
  assert.deepEqual(mutations.map(([type]) => type), ['add', 'update', 'delete'])
  assert.equal(layouts.length, 3)

  original.readyState = 0
  original.onerror({})
  assert.equal(states.at(-1), 'disconnected')
  events.initEventStreaming()
  assert.equal(streams.length, 1, 'EventSource owns automatic reconnection')
  original.readyState = 1
  original.onopen()
  assert.equal(states.at(-1), 'connected')

  events.stopEventStreaming()
  events.stopEventStreaming()
  assert.equal(original.closeCalls, 1)
  assert.equal(states.at(-1), 'paused')

  async function emitStaleEvents() {
    const stateCount = states.length
    for (const type of ['add', 'update', 'delete']) await original.handlers[type](message)
    original.onopen()
    original.onerror({})
    assert.equal(states.length, stateCount)
    assert.equal(mutations.length, 3)
    assert.equal(layouts.length, 3)
  }

  await emitStaleEvents()
  assert.equal(streams.length, 1, 'Stopped/offline streams must not be recreated by callbacks')
  events.initEventStreaming()
  assert.equal(streams.length, 2)
  assert.equal(states.at(-1), 'connecting')
  await emitStaleEvents()
  const current = streams[1]
  current.readyState = 1
  current.onopen()
  await current.handlers.add(message)
  assert.equal(mutations.length, 4)
  assert.equal(states.at(-1), 'connected')
  events.stopEventStreaming()
})

test('updates finish before layout, and an update finishing after stop cannot trigger a stale layout', async () => {
  const pending = []
  const { events, streams, layouts } = await page({
    updateResource: () => new Promise((resolve) => pending.push(resolve)),
  })
  events.initEventStreaming()
  const firstUpdate = streams[0].handlers.update(message)
  assert.equal(layouts.length, 0)
  pending.shift()()
  await firstUpdate
  assert.equal(layouts.length, 1)

  const staleUpdate = streams[0].handlers.update(message)
  events.stopEventStreaming()
  events.initEventStreaming()
  pending.shift()()
  await staleUpdate
  assert.equal(layouts.length, 1)
  events.stopEventStreaming()
})
