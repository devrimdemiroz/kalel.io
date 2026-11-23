import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { createContext, SourceTextModule, SyntheticModule } from 'node:vm'

const quietConsole = { log() {}, warn() {}, error() {} }

async function loadModule(file, imports = {}, globals = {}) {
  const context = createContext({
    console: quietConsole,
    AbortController,
    CustomEvent,
    URL,
    URLSearchParams,
    ...globals,
  })
  const module = new SourceTextModule(await readFile(new URL(file, import.meta.url), 'utf8'), { context })
  await module.link(async (specifier) => {
    if (specifier === './container-layout.js') {
      const containers = new SourceTextModule(await readFile(new URL('../js/container-layout.js', import.meta.url), 'utf8'), { context })
      await containers.link(() => assert.fail('Container layout should not import dependencies'))
      return containers
    }
    assert.ok(Object.hasOwn(imports, specifier), `Unexpected import: ${specifier}`)
    const exports = imports[specifier]
    return new SyntheticModule(
      Object.keys(exports),
      function () {
        for (const [name, value] of Object.entries(exports)) this.setExport(name, value)
      },
      { context },
    )
  })
  await module.evaluate()
  return module.namespace
}

function storage(initial = {}) {
  const values = new Map(Object.entries(initial))
  return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) }
}

test('SSE initialization is idempotent and stopped streams cannot mutate resources or reconnect state', async () => {
  const sources = []
  const resources = []
  const states = []
  const window = new EventTarget()
  window.addEventListener('connectionStateChange', (event) => states.push(event.detail.state))
  class EventSource {
    readyState = 1
    handlers = {}
    closed = false
    constructor(url) {
      this.url = url
      sources.push(this)
    }
    addEventListener(name, handler) {
      this.handlers[name] = handler
    }
    close() {
      this.closed = true
    }
  }
  const events = await loadModule(
    '../js/events.js',
    {
      './graph.js': {
        layout: async () => {},
        addResource: (res) => resources.push(res),
        removeResource() {},
        updateResource() {},
      },
      './config.js': { getConfig: () => ({ debug: false }) },
    },
    { EventSource, window, localStorage: storage({ clientId: 'test-client' }) },
  )

  events.initEventStreaming()
  events.initEventStreaming()
  assert.equal(sources.length, 1)
  sources[0].onopen()
  await sources[0].handlers.add({ data: JSON.stringify({ kind: 'Pod', metadata: { name: 'one' } }) })
  assert.equal(resources.length, 1)
  events.stopEventStreaming()
  events.stopEventStreaming()
  assert.equal(sources[0].closed, true)
  await sources[0].handlers.add({ data: '{}' })
  sources[0].onopen()
  sources[0].onerror({})
  assert.equal(resources.length, 1)
  assert.equal(states.at(-1), 'paused')
  events.initEventStreaming()
  assert.equal(sources.length, 2)
})

test('saved Offline mode restores as Manual, while interval and Live preferences survive reload', async () => {
  for (const [savedMode, expectedMode] of [['offline', 'manual'], ['live', 'live'], ['15s', '15s'], ['1m', '1m']]) {
    const config = await loadModule('../js/config.js', {}, {
      localStorage: storage({ kubeviewConfig: JSON.stringify({ refreshMode: savedMode }) }),
    })
    assert.equal(config.getConfig().refreshMode, expectedMode)
  }
})

test('new and older preferences default to a white canvas and remember an explicit opt-out', async () => {
  for (const saved of [null, JSON.stringify({ theme: 'dark', edgeStyle: 'polyline' })]) {
    const localStorage = storage(saved ? { kubeviewConfig: saved } : {})
    const config = await loadModule('../js/config.js', {}, { localStorage })
    const cfg = config.getConfig()
    assert.equal(cfg.whiteBackground, true)
    cfg.whiteBackground = false
    await config.saveConfig(cfg)
    const reloaded = await loadModule('../js/config.js', {}, { localStorage })
    assert.equal(reloaded.getConfig().whiteBackground, false)
    assert.equal(reloaded.getConfig().theme, 'dark')
  }
})

test('view preferences survive reload, including Debug, numeric spacing, and optional resource filters', async () => {
  const localStorage = storage()
  const config = await loadModule('../js/config.js', {}, { localStorage })
  const cfg = config.getConfig()
  Object.assign(cfg, {
    edgeStyle: 'polyline',
    debug: true,
    shortenNames: false,
    spacing: '175',
    hideEmptyReplicaSets: true,
    resFilter: ['Pod', 'ConfigMap', 'PersistentVolumeClaim', 'HorizontalPodAutoscaler'],
  })
  await config.saveConfig(cfg)
  const reloaded = await loadModule('../js/config.js', {}, { localStorage })
  const saved = reloaded.getConfig()
  assert.equal(saved.debug, true)
  assert.equal(saved.edgeStyle, 'polyline')
  assert.equal(saved.shortenNames, false)
  assert.equal(saved.spacing, 175)
  assert.equal(saved.hideEmptyReplicaSets, true)
  assert.deepEqual(Array.from(saved.resFilter), ['Pod', 'ConfigMap', 'PersistentVolumeClaim', 'HorizontalPodAutoscaler'])
})

test('live resource layout redraws without fitting or resetting the viewport', async () => {
  const calls = []
  const window = new EventTarget()
  let filterUpdates = 0
  window.addEventListener('resourceGraphUpdated', () => filterUpdates++)
  const viewport = { zoom: 0.3, position: [40, 120] }
  const graph = {
    viewport,
    draw: async () => calls.push('draw'),
    stopLayout: () => calls.push('stop'),
    layout: async () => calls.push('layout'),
    fitView: async () => assert.fail('Live updates must not fit the view'),
    fitCenter: async () => assert.fail('Live updates must not center the view'),
  }
  const { layout } = await loadModule('../js/graph.js', {
    './cache.js': { findResByName() {}, queryRes() {}, remove() {}, store() {} },
    './config.js': { getConfig: () => ({}) },
    './main.js': { graph },
  }, { window })
  await layout()
  assert.deepEqual(calls, ['draw'])
  assert.equal(filterUpdates, 1)
  assert.equal(graph.viewport, viewport)
})

test('resource filtering hides an existing node without removing its topology or cached resource', async () => {
  const resources = new Map([['pod-1', { kind: 'Pod' }]])
  const graph = {
    nodes: [{ id: 'pod-1' }],
    edges: [{ id: 'pod-service', source: 'pod-1', target: 'service-1' }],
    getNodeData(id) {
      return id === undefined ? this.nodes : this.nodes.find((node) => node.id === id)
    },
    updateNodeData(nodes) {
      this.nodes = nodes
    },
    removeEdgeData(selector) {
      const ids = selector(this.edges)
      this.edges = this.edges.filter((edge) => !ids.includes(edge.id))
    },
    removeNodeData(ids) {
      this.nodes = this.nodes.filter((node) => !ids.includes(node.id))
    },
  }
  const cfg = { resFilter: ['Service'], hideEmptyReplicaSets: false }
  const { updateResource } = await loadModule('../js/graph.js', {
    './cache.js': {
      findResByName() {},
      queryRes() { return [] },
      remove: (id) => resources.delete(id),
      store: (resource) => resources.set(resource.metadata.uid, resource),
    },
    './config.js': { getConfig: () => cfg },
    './main.js': { graph },
  })

  await updateResource({ kind: 'Pod', metadata: { uid: 'pod-1', name: 'pod-1' } })

  assert.equal(graph.nodes.length, 1)
  assert.equal(graph.nodes[0].data.filterVisible, false)
  assert.equal(graph.nodes[0].style.visibility, 'hidden')
  assert.equal(graph.edges.length, 1)
  assert.equal(resources.has('pod-1'), true)
})

const pod = (id, owners = []) => ({
  kind: 'Pod',
  metadata: { uid: id, name: id, ownerReferences: owners.map((uid) => ({ uid })) },
})

async function portGraph(resources, cfg = {}) {
  const cache = new Map(resources.map((res) => [res.metadata.uid, res]))
  const nodes = new Map(resources.filter((res) => !['Endpoints', 'EndpointSlice'].includes(res.kind)).map((res) => [
    res.metadata.uid, { id: res.metadata.uid, style: {} },
  ]))
  const edges = new Map()
  const graph = {
    getNodeData: (id) => id === undefined ? [...nodes.values()] : nodes.get(id),
    addNodeData: (items) => items.forEach((item) => nodes.set(item.id, item)),
    updateNodeData: (items) => items.forEach((item) => nodes.set(item.id, item)),
    getEdgeData: () => [...edges.values()],
    addEdgeData: (items) => items.forEach((item) => {
      assert.equal(edges.has(item.id), false, 'Edges must be updated, not duplicated')
      edges.set(item.id, item)
    }),
    updateEdgeData: (items) => items.forEach((item) => edges.set(item.id, { ...edges.get(item.id), ...item })),
  }
  const module = await loadModule('../js/graph.js', {
    './cache.js': {
      findResByName: (kind, name) => [...cache.values()].find((res) => res.kind === kind && res.metadata.name === name),
      queryRes: (predicate) => [...cache.values()].filter(predicate),
      store: (res) => cache.set(res.metadata.uid, res),
      remove: (id) => cache.delete(id),
    },
    './config.js': { getConfig: () => cfg },
    './main.js': { graph },
  }, { window: new EventTarget() })
  return { ...module, nodes, edges, cache, graph }
}

test('new and updated resource labels follow the canvas without losing selection, coordinates, or badges', async () => {
  const cfg = { theme: 'dark', whiteBackground: true }
  const service = { kind: 'Service', metadata: { uid: 'svc', name: 'metrics' }, spec: { ports: [{ port: 9090 }] } }
  const { addResource, updateResource, nodes } = await portGraph([], cfg)
  addResource(service)
  assert.equal(nodes.get('svc').style.labelFill, '#242a38')
  Object.assign(nodes.get('svc').style, { x: 120, y: 240 })
  nodes.get('svc').states = ['selected']

  for (const [theme, whiteBackground, fill] of [
    ['dark', false, '#ffffff'],
    ['light', false, '#242a38'],
    ['dark', true, '#242a38'],
    ['light', true, '#242a38'],
  ]) {
    Object.assign(cfg, { theme, whiteBackground })
    await updateResource(service)
    const uid = `new-${theme}-${whiteBackground}`
    addResource({ ...service, metadata: { uid, name: uid } })
    assert.equal(nodes.get('svc').style.labelFill, fill)
    assert.equal(nodes.get(uid).style.labelFill, fill)
    assert.equal(nodes.get('svc').style.x, 120)
    assert.equal(nodes.get('svc').style.y, 240)
    assert.deepEqual(Array.from(nodes.get('svc').states), ['selected'])
    assert.equal(nodes.get('svc').style.badges[0].text, '9090')
    const missing = `missing-${uid}`
    await updateResource({ ...service, metadata: { uid: missing, name: missing } })
    assert.equal(nodes.get(missing).style.labelFill, fill)
  }
})

test('empty-set and kind filters stay applied when search clears and restore nodes and edges without losing state', async () => {
  const resource = { kind: 'ReplicaSet', metadata: { uid: 'rs', name: 'rs' }, status: { replicas: 0 } }
  const child = { ...pod('child', ['rs']), status: {} }
  const cfg = { resFilter: ['ReplicaSet', 'Pod'], hideEmptyReplicaSets: false, theme: 'dark' }
  const { addResource, updateResource, nodes, edges, cache, graph } = await portGraph([], cfg)
  const { nodeVisByLabel } = await loadModule('../js/graph-utils.js', { './config.js': { getConfig: () => cfg } })
  addResource(resource)
  addResource(child)
  nodes.get('rs').states = ['selected']
  Object.assign(nodes.get('rs').style, { x: 41, y: 62 })

  cfg.hideEmptyReplicaSets = true
  await updateResource(resource)
  nodeVisByLabel(graph, '')
  assert.equal(nodes.get('rs').style.visibility, 'hidden')
  assert.equal(nodes.get('child').style.visibility, 'visible')
  assert.equal(edges.get('rs.child').style.visibility, 'hidden')
  assert.equal(cache.get('rs'), resource)
  assert.equal(nodes.get('rs').style.x, 41)
  assert.deepEqual(Array.from(nodes.get('rs').states), ['selected'])

  cfg.hideEmptyReplicaSets = false
  await updateResource(resource)
  nodeVisByLabel(graph, 'child')
  assert.equal(nodes.get('rs').style.visibility, 'hidden')
  nodeVisByLabel(graph, '')
  assert.equal(nodes.get('rs').style.visibility, 'visible')
  assert.equal(edges.get('rs.child').style.visibility, 'visible')

  cfg.resFilter = ['Pod']
  await updateResource(resource)
  nodeVisByLabel(graph, '')
  assert.equal(nodes.get('rs').style.visibility, 'hidden')
  assert.equal(edges.get('rs.child').style.visibility, 'hidden')
  assert.equal(nodes.size, 2)
})

test('only Services show their exposed ports, without duplicating container or backend ports', async () => {
  const service = {
    kind: 'Service', metadata: { uid: 'svc', name: 'metrics' },
    spec: { ports: [{ port: 9090, targetPort: 9191 }, { port: 9090 }, { port: 5353, protocol: 'UDP' }, { port: 0 }, {}] },
  }
  const app = {
    ...pod('app'), status: {}, spec: { containers: [{ ports: [{ containerPort: 9191 }] }] },
  }
  const workloads = ['Deployment', 'ReplicaSet', 'StatefulSet', 'DaemonSet', 'Job', 'CronJob'].map((kind) => ({
    kind, metadata: { uid: kind, name: kind }, status: {},
    spec: kind === 'CronJob' ? { jobTemplate: { spec: { template: { spec: app.spec } } } } : { template: { spec: app.spec } },
  }))
  const ingress = {
    kind: 'Ingress', metadata: { uid: 'ing', name: 'ing' },
    spec: { defaultBackend: { service: { name: 'metrics', port: { number: 9090 } } } },
  }
  const resources = [service, app, ...workloads, ingress]
  const { addResource, updateResource, nodes } = await portGraph(resources)
  for (const res of resources) addResource(res)
  assert.equal(nodes.get('svc').style.labelText, 'metrics')
  assert.equal(nodes.get('svc').style.badges[0].text, '9090, 5353/UDP')
  assert.equal(nodes.get('svc').style.badges[0].placement, 'top')
  for (const res of resources.filter((resource) => resource.kind !== 'Service')) {
    assert.equal(nodes.get(res.metadata.uid).style.badges.length, 0, `${res.kind} must not repeat Service ports`)
  }
  nodes.get('app').style.badges = [{ text: '9191', placement: 'top' }]
  await updateResource(app)
  assert.equal(nodes.get('app').style.badges.length, 0)
  await updateResource({ ...service, spec: { ports: [{ port: 8080, targetPort: 9191 }] } })
  assert.equal(nodes.get('svc').style.badges[0].text, '8080')
  await updateResource({ ...service, spec: { ports: [] } })
  assert.equal(nodes.get('svc').style.badges.length, 0)
})

test('Ingress links keep named and numbered backends connected without repeated port labels', async () => {
  const service = {
    kind: 'Service', metadata: { uid: 'svc', name: 'metrics' },
    spec: { ports: [{ name: 'metrics', port: 9090 }, { name: 'secure', port: 9443 }] },
  }
  const backend = (port) => ({ service: { name: 'metrics', port } })
  const ingress = {
    kind: 'Ingress', metadata: { uid: 'ing', name: 'ing' },
    spec: { defaultBackend: backend({ name: 'metrics' }),
      rules: [{ http: { paths: [{ backend: backend({ number: 9443 }) }, { backend: backend({ number: 9443 }) }] } }] },
  }
  const { addResource, processLinks, updateResource, edges, nodes } = await portGraph([service, ingress])
  addResource(ingress)
  assert.equal(edges.size, 1)
  assert.equal(edges.get('ing.svc').style.labelText, '')
  assert.equal(nodes.get('ing').style.badges.length, 0)
  await updateResource({ ...service, spec: { ports: [{ name: 'metrics', port: 9191 }, { name: 'secure', port: 9443 }] } })
  assert.equal(nodes.get('svc').style.badges[0].text, '9191, 9443')
  assert.equal(edges.get('ing.svc').style.labelText, '')
  processLinks({ ...ingress, spec: { defaultBackend: backend({ name: 'metrics' }) } })
  assert.equal(edges.size, 1)
  assert.equal(edges.get('ing.svc').style.labelText, '')
  processLinks({ ...ingress, spec: { defaultBackend: backend(undefined) } })
  assert.equal(edges.get('ing.svc').style.labelText, '')
})

test('Endpoint and EndpointSlice updates preserve links while ports stay only on their Service', async () => {
  const service = { kind: 'Service', metadata: { uid: 'svc', name: 'metrics' }, spec: { ports: [{ port: 80, targetPort: 9090 }] } }
  const app = { ...pod('app'), status: { podIP: '192.0.2.10' } }
  const slice = {
    kind: 'EndpointSlice', metadata: { uid: 'slice', name: 'slice', labels: { 'kubernetes.io/service-name': 'metrics' } },
    ports: [{ port: 9090 }], endpoints: [{ addresses: ['192.0.2.10'] }],
  }
  const { addResource, updateResource, processLinks, edges, nodes, cache } = await portGraph([service, app])
  addResource(service)
  addResource(slice)
  assert.equal(edges.get('svc.app').style.labelText, '')
  await updateResource({ ...slice, ports: [{ port: 5353, protocol: 'UDP' }] })
  assert.equal(edges.size, 1)
  assert.equal(edges.get('svc.app').style.labelText, '')
  assert.equal(nodes.get('svc').style.badges[0].text, '80')
  assert.equal(cache.get('slice').ports[0].port, 5353)
  assert.equal(nodes.has('slice'), false)
  addResource({ ...slice, metadata: { ...slice.metadata, uid: 'slice-two' }, ports: [{ port: 9443 }] })
  assert.equal(edges.get('svc.app').style.labelText, '')
  await updateResource({ ...slice, ports: [] })
  assert.equal(edges.get('svc.app').style.labelText, '')
  const endpoints = {
    kind: 'Endpoints', metadata: { uid: 'ep', name: 'metrics' },
    subsets: [9090, 9443].map((port) => ({ ports: [{ port }], addresses: [{ ip: '192.0.2.10' }] })),
  }
  edges.get('svc.app').style.labelText = '9090, 9443'
  processLinks(endpoints)
  assert.equal(edges.get('svc.app').style.labelText, '')
  await updateResource({ ...endpoints, subsets: [{ addresses: [{ ip: '192.0.2.10' }] }] })
  assert.equal(edges.get('svc.app').style.labelText, '')
  assert.equal(cache.has('ep'), true)
  processLinks({ ...app, metadata: { ...app.metadata, ownerReferences: [{ uid: 'svc' }] } })
  assert.equal(edges.get('svc.app').style.labelText, '')
})

async function mainApp({ namespaces = ['team'], resources = { Pod: [pod('existing')] }, clusterHost = '' } = {}) {
  const components = new Map()
  const timers = new Map()
  const watchers = new Map()
  const timeline = []
  const requests = []
  const cfg = {
    theme: 'dark',
    edgeStyle: 'cubic-vertical',
    refreshMode: 'manual',
    debug: false,
    resFilter: ['Pod', 'Deployment'],
    spacing: 100,
    shortenNames: true,
    hideEmptyReplicaSets: false,
  }
  const window = new EventTarget()
  window.location = { search: '' }
  window.history = { replaceState() {} }
  let nextTimer = 0
  let streamStarts = 0
  let streamStops = 0
  let resourceResponse
  let graph
  const cachedResources = new Map()
  const layoutSeeds = []
  const graphUtils = await loadModule('../js/graph-utils.js', { './config.js': { getConfig: () => cfg } })
  const { edgeStyles } = await loadModule('../js/config.js', {}, { localStorage: storage() })
  class Graph {
    constructor(options) {
      graph = this
      this.options = options
      this.nodes = []
      this.edges = []
      this.combos = []
      this.viewport = { zoom: 1, position: [0, 0] }
      timeline.push(['initial', options.layout.type])
    }
    on() {}
    async clear() {
      timeline.push('clear')
      this.nodes = []
      this.edges = []
      this.combos = []
    }
    async render() {
      timeline.push('render')
      for (const [index, node] of this.nodes.entries()) node.style.x = index * 100
    }
    getNodeData() {
      return this.nodes
    }
    updateNodeData(nodes) {
      for (const patch of nodes) {
        const node = this.nodes.find((item) => item.id === patch.id)
        if (node) Object.assign(node, { ...patch, style: { ...node.style, ...patch.style } })
      }
    }
    getEdgeData() {
      return this.edges
    }
    removeNodeData(ids) {
      this.nodes = this.nodes.filter((node) => !ids.includes(node.id))
    }
    removeEdgeData(ids) {
      this.edges = this.edges.filter((edge) => !ids.includes(edge.id))
    }
    getComboData() {
      return this.combos
    }
    setPlugins(plugins) {
      this.options.plugins = typeof plugins === 'function' ? plugins(this.options.plugins || []) : plugins
    }
    addComboData(combos) {
      this.combos.push(...combos)
    }
    updateComboData(combos) {
      for (const combo of combos) Object.assign(this.combos.find((item) => item.id === combo.id), combo)
    }
    removeComboData(ids) {
      this.combos = this.combos.filter((combo) => !ids.includes(combo.id))
    }
    stopLayout() {}
    async draw() {
      timeline.push('draw')
    }
    async layout() {
      timeline.push('applyLayout')
      layoutSeeds.push(this.nodes.map((node) => ({ id: node.id, x: node.style.x })))
    }
    setLayout(layout) {
      this.options.layout = layout
      timeline.push(['layout', layout.type])
    }
    getOptions() {
      return this.options
    }
    setNode(node) {
      this.options.node = node
    }
    setEdge(edge) {
      this.options.edge = edge
    }
    setCombo(combo) {
      this.options.combo = combo
    }
    setTheme(theme) {
      this.options.theme = theme
    }
  }
  const processLinks = (resource) => {
    for (const owner of resource.metadata.ownerReferences || []) {
      if (!graph.nodes.some((node) => node.id === owner.uid)) continue
      const id = `${owner.uid}-${resource.metadata.uid}`
      if (!graph.edges.some((edge) => edge.id === id)) graph.edges.push({ id })
    }
  }
  const imports = {
    '../ext/alpinejs.esm.min.js': { default: { data: (name, factory) => components.set(name, factory), start() {} } },
    '../ext/g6-esm.js': { Graph, GraphEvent: {} },
    './config.js': {
      edgeStyles,
      getConfig: () => cfg,
      saveConfig: async (newConfig) => {
        newConfig.spacing = parseInt(`${newConfig.spacing}`) || 100
      },
    },
    './events.js': {
      getClientId: () => 'client',
      initEventStreaming: () => streamStarts++,
      stopEventStreaming: () => streamStops++,
    },
    './graph.js': {
      addResource(resource) {
        cachedResources.set(resource.metadata.uid, resource)
        graph.nodes.push({ id: resource.metadata.uid, style: { labelText: resource.metadata.name } })
      },
      async updateResource(resource) {
        cachedResources.set(resource.metadata.uid, resource)
        const node = graph.nodes.find((node) => node.id === resource.metadata.uid)
        node.style.labelText = resource.metadata.name
        node.data = { filterVisible: cfg.resFilter.includes(resource.kind) }
      },
      processLinks,
      layout: async () => {},
    },
    './cache.js': {
      clearCache: () => cachedResources.clear(),
      queryRes: (predicate) => [...cachedResources.values()].filter(predicate),
    },
    '../ext/toast.js': { showToast() {} },
    './graph-utils.js': {
      getLayout: (name) => {
        const options = graphUtils.getLayout(name)
        return { ...options, type: options.type === 'antv-dagre' ? 'dagre' : 'force' }
      },
      fitToVisible: async () => timeline.push('fit'),
      nodeVisByLabel(_graph, query) {
        for (const node of graph.nodes) {
          node.style.visibility = node.data?.filterVisible !== false && node.style.labelText.includes(query) ? 'visible' : 'hidden'
        }
      },
    },
    './side-panel.js': { default() {} },
    './events-dialog.js': { default() {} },
    './rollout-dialog.js': { default() {} },
  }
  await loadModule('../js/main.js', imports, {
    window,
    document: { documentElement: { dataset: {} }, querySelector: () => null },
    BroadcastChannel: class {
      postMessage() {}
    },
    requestAnimationFrame: (callback) => {
      timeline.push('paint')
      callback(0)
    },
    setInterval: (callback, delay) => {
      timers.set(++nextTimer, { callback, delay })
      return nextTimer
    },
    clearInterval: (id) => timers.delete(id),
    fetch: async (url, options) => {
      requests.push({ url, options })
      if (url !== 'api/namespaces' && resourceResponse) return resourceResponse()
      return {
        ok: true,
        json: async () => url === 'api/namespaces' ? { namespaces, rolloutsEnabled: true, clusterHost } : resources,
      }
    },
  })
  const app = components.get('mainApp')()
  app.$watch = (key, callback) => watchers.set(key, callback)
  return {
    app, cfg, timers, timeline, requests, watchers, graph, window, layoutSeeds, cachedResources,
    streams: () => ({ starts: streamStarts, stops: streamStops }),
    setResourceResponse: (callback) => { resourceResponse = callback },
  }
}

test('containers map owners, selectors and labels without moving nodes, grouping releases or inventing nodes', async () => {
  const { buildContainers } = await loadModule('../js/container-layout.js')
  const resource = (uid, kind, app, component, instance = 'demo') => ({
    kind, metadata: { uid, name: uid, namespace: 'team', labels: {
      'app.kubernetes.io/name': app, 'app.kubernetes.io/component': component, 'app.kubernetes.io/instance': instance,
    } },
  })
  const server = resource('server', 'Deployment', 'example', 'server')
  const replica = { ...pod('replica', ['server']), kind: 'ReplicaSet' }
  const child = { ...pod('child', ['replica']), metadata: { ...pod('child', ['replica']).metadata, namespace: 'team', labels: { role: 'api' } } }
  const service = { kind: 'Service', metadata: { uid: 'svc', namespace: 'team' }, spec: { selector: { role: 'api' } } }
  const resources = [server, replica, child, service,
    resource('nats', 'StatefulSet', 'example', 'nats'),
    resource('release-two', 'Deployment', 'example', 'server', 'second'),
    pod('unknown'), resource('hidden', 'Deployment', 'example', 'hidden')]
  const nodes = resources.map((res) => ({ id: res.metadata.uid, style: { visibility: res.metadata.uid === 'hidden' ? 'hidden' : 'visible' } }))
  const result = buildContainers(nodes, resources, 'light')
  const indexed = new Map(result.nodes.map((node) => [node.id, node]))
  const groupOf = (id) => result.combos.find((combo) => combo.id === indexed.get(id).combo)
  for (const id of ['replica', 'child', 'svc']) assert.equal(indexed.get(id).combo, indexed.get('server').combo)
  assert.notEqual(indexed.get('release-two').combo, indexed.get('server').combo)
  assert.match(groupOf('unknown').style.labelText, /unmapped/)
  assert.equal(indexed.get('nats').style, undefined)
  assert.equal(indexed.get('server').style, undefined)
  const root = result.combos.find((combo) => !combo.combo)
  const layers = result.combos.filter((combo) => combo.id === root.id || combo.combo === root.id)
  assert.equal(layers.length, 3)
  for (const layer of layers) {
    assert.equal(layer.style.fill, '#000000')
    assert.ok(layer.style.fillOpacity > 0 && layer.style.fillOpacity < 0.05)
    assert.ok(layer.style.strokeOpacity > 0 && layer.style.strokeOpacity < 0.5)
    assert.equal(layer.style.labelOpacity, 1)
  }
  for (const component of result.combos.filter((combo) => combo.id.includes(':component:'))) {
    assert.equal(component.style.fillOpacity, 0)
    assert.equal(component.style.strokeOpacity, 0)
    assert.ok(Math.min(...component.style.padding.slice(1)) >= 90)
  }
  assert.ok(buildContainers(nodes, resources, 'dark').combos.every((combo) => combo.style.fill === '#ffffff'))
  assert.equal(indexed.get('hidden').combo, null)
  assert.equal(result.nodes.length, nodes.length)
  assert.equal(result.combos.some((combo) => /postgres/i.test(combo.style.labelText)), false)
  assert.deepEqual(
    JSON.parse(JSON.stringify(buildContainers([...nodes].reverse(), [...resources].reverse(), 'light').combos)),
    JSON.parse(JSON.stringify(result.combos)),
  )
})

test('container view refreshes and filters membership, follows themes and exits without losing resource nodes', async () => {
  const { app, graph, cfg, window, cachedResources, requests } = await mainApp()
  await app.init()
  const count = graph.nodes.length
  const requestCount = requests.length
  await app.toolbarContainersLayout()
  assert.equal(app.activeLayout, 'containers')
  assert.equal(graph.combos.length, 3)
  assert.equal(graph.nodes.length, count)
  const root = graph.combos[0].id
  assert.ok(graph.combos.find((combo) => combo.id === root).style.fillOpacity > 0)
  assert.equal(graph.options.plugins[0].fill, '#ffffff')
  assert.ok(graph.options.plugins[0].fillOpacity > 0 && graph.options.plugins[0].fillOpacity < 0.08)
  assert.ok(graph.options.plugins[0].padding >= 55)
  graph.nodes[0].data = { filterVisible: false }
  window.dispatchEvent(new CustomEvent('resourceGraphUpdated'))
  assert.equal(graph.combos.length, 0)
  assert.equal(graph.nodes[0].combo, null)
  graph.nodes[0].data.filterVisible = true
  window.dispatchEvent(new CustomEvent('resourceGraphUpdated'))
  assert.equal(graph.combos.length, 3)
  cfg.whiteBackground = false
  await app.toggleWhiteBackground()
  assert.equal(cfg.theme, 'dark')
  assert.equal(graph.options.plugins[0].stroke, '#666666')
  assert.equal(graph.options.plugins[0].fill, '#000000')
  assert.ok(graph.options.plugins[0].fillOpacity > 0 && graph.options.plugins[0].fillOpacity < 0.08)
  assert.equal(graph.options.plugins[0].pointerEvents, 'none')
  assert.equal(graph.options.plugins[0].corner, 'smooth')
  await app.toggleWhiteBackground()
  assert.equal(cfg.theme, 'dark')
  assert.equal(graph.options.plugins[0].stroke, '#a8b2c4')
  assert.equal(graph.options.plugins[0].fill, '#ffffff')
  await app.toggleTheme()
  assert.equal(cfg.theme, 'light')
  assert.equal(graph.options.plugins[0].stroke, '#666666')
  assert.equal(graph.options.plugins[0].fill, '#000000')
  const res = cachedResources.get('existing')
  res.metadata.labels = { 'app.kubernetes.io/name': 'prometheus' }
  window.dispatchEvent(new CustomEvent('resourceGraphUpdated'))
  assert.equal(graph.combos[1].style.labelText, 'Supporting services')
  await app.toolbarDagreLayout()
  assert.equal(app.activeLayout, 'structured')
  assert.equal(graph.combos.length, 0)
  assert.equal(graph.options.plugins.length, 0)
  assert.equal(graph.nodes.length, count)
  assert.equal(graph.nodes[0].combo, null)
  assert.equal(requests.length, requestCount)
})

test('container layout uses force placement inside every group rather than a fixed grid', async () => {
  const { getLayout } = await loadModule('../js/graph-utils.js', { './config.js': { getConfig: () => ({ spacing: 170 }) } })
  const options = getLayout('containers')
  assert.equal(options.type, 'combo-combined')
  assert.equal(options.layout.type, 'force')
  assert.equal(options.layout.preventOverlap, true)
  assert.equal(options.layout.nodeSpacing, 170)
})

test('fitting a filtered container view includes the outer boundary and its title', async () => {
  const { fitToVisible } = await loadModule('../js/graph-utils.js', { './config.js': { getConfig: () => ({}) } })
  let ratio
  let translation
  const graph = {
    getNodeData: () => [{ id: 'visible', style: {} }, { id: 'hidden', style: { visibility: 'hidden' } }],
    getComboData: () => [{ id: 'outer' }, { id: 'inner', combo: 'outer' }],
    getElementPosition: () => [0, 0],
    getElementRenderBounds: (id) => {
      assert.equal(id, 'outer')
      return { min: [-300, -200, 0], max: [300, 200, 0] }
    },
    getSize: () => [1000, 800],
    getZoom: () => 1,
    getViewportCenter: () => [500, 400],
    zoomBy: async (value) => { ratio = value },
    getViewportByCanvas: (point) => point,
    translateBy: async (value) => { translation = value },
    fitView: () => assert.fail('Hidden nodes must not be fitted'),
  }
  await fitToVisible(graph, false)
  assert.ok(ratio * 600 < 1000)
  assert.ok(ratio * 400 < 800)
  assert.deepEqual(Array.from(translation), [500, 400])
})

test('startup paints Structured then runs the shared Organic action once with the rendered positions', async () => {
  const { app, timeline, requests, layoutSeeds } = await mainApp()
  const organic = app.toolbarForceLayout.bind(app)
  let organicCalls = 0
  app.toolbarForceLayout = async () => { organicCalls++; await organic() }
  await app.init()
  assert.deepEqual(timeline, [
    ['initial', 'dagre'], 'clear', 'render', 'fit', 'paint', 'paint', ['layout', 'force'], 'applyLayout', 'fit',
  ])
  assert.equal(organicCalls, 1)
  assert.equal(app.activeLayout, 'organic')
  assert.deepEqual(layoutSeeds, [[{ id: 'existing', x: 0 }]])
  assert.equal(requests.length, 2)
  assert.equal(app.rolloutsEnabled, true)
  timeline.length = 0
  await app.fetchNamespace()
  assert.deepEqual(timeline, ['draw'])
  assert.equal(organicCalls, 1)
})

test('startup Organic waits for the first populated namespace, including a namespace selected after init', async () => {
  const { app, timeline, graph, setResourceResponse } = await mainApp({ namespaces: ['one', 'two'], resources: {} })
  await app.init()
  assert.equal(app.initialLayoutComplete, false)
  app.namespace = 'one'
  await app.fetchNamespace()
  assert.equal(app.initialLayoutComplete, false)
  assert.equal(graph.options.layout.type, 'dagre')
  setResourceResponse(async () => ({ ok: true, json: async () => ({ Pod: [pod('first')] }) }))
  timeline.length = 0
  await app.fetchNamespace()
  assert.deepEqual(timeline.slice(-5), ['paint', 'paint', ['layout', 'force'], 'applyLayout', 'fit'])
  assert.equal(app.initialLayoutComplete, true)
})

test('manual layout changes preserve graph data, selection, filtering, open panels, and viewport without fetching or fitting', async () => {
  const { app, graph, requests, timeline, window } = await mainApp()
  await app.init()
  app.searchQuery = 'existing'
  app.showEventsDialog = true
  const node = graph.nodes[0]
  node.states = ['selected']
  node.style.visibility = 'hidden'
  const viewport = { zoom: 0.35, position: [51, 123] }
  graph.viewport = viewport
  let panelCloses = 0
  window.addEventListener('closePanel', () => panelCloses++)
  const requestCount = requests.length
  timeline.length = 0
  await app.toolbarDagreLayout()
  assert.equal(app.activeLayout, 'structured')
  await app.toolbarForceLayout()
  assert.equal(app.activeLayout, 'organic')
  assert.deepEqual(timeline, [['layout', 'dagre'], 'applyLayout', ['layout', 'force'], 'applyLayout'])
  assert.equal(graph.nodes[0], node)
  assert.deepEqual(node.states, ['selected'])
  assert.equal(node.style.visibility, 'hidden')
  assert.equal(graph.viewport, viewport)
  assert.equal(app.searchQuery, 'existing')
  assert.equal(app.showEventsDialog, true)
  assert.equal(panelCloses, 0)
  assert.equal(requests.length, requestCount)
  await app.toolbarDagreLayout()
  timeline.length = 0
  await app.fetchNamespace()
  assert.equal(graph.options.layout.type, 'dagre')
  assert.deepEqual(timeline, ['draw'])
})

test('filter changes persist and update visibility without fetching or clearing the graph', async () => {
  const { app, cfg, graph, requests, timeline } = await mainApp()
  await app.init()
  graph.viewport = { zoom: 0.4, position: [18, 60] }
  const viewport = graph.viewport
  const requestCount = requests.length
  timeline.length = 0

  await app.setResourceFilter('Deployment', false)

  assert.deepEqual(Array.from(cfg.resFilter), ['Pod'])
  assert.equal(requests.length, requestCount)
  assert.deepEqual(timeline, [])
  assert.equal(graph.nodes[0].style.visibility, 'visible')
  await app.setResourceFilter('Pod', false)
  assert.equal(graph.nodes[0].style.visibility, 'hidden')
  assert.equal(requests.length, requestCount)
  assert.equal(graph.viewport, viewport)
})

test('view option changes update spacing and refresh labels without replacing the graph', async () => {
  const { app, cfg, graph, timeline } = await mainApp()
  await app.init()
  graph.viewport = { zoom: 0.4, position: [18, 60] }
  const viewport = graph.viewport
  timeline.length = 0

  cfg.spacing = '160'
  cfg.shortenNames = false
  await app.applyViewOptions()

  assert.equal(graph.options.layout.nodeSize, 160)
  assert.deepEqual(timeline, [['layout', 'force'], 'draw', 'applyLayout'])
  await app.toolbarDagreLayout()
  assert.equal(graph.options.layout.nodeSize, 160)
  await app.toolbarForceLayout()
  assert.equal(graph.options.layout.nodeSize, 160)
  assert.equal(graph.viewport, viewport)
})

test('theme switching updates colors without rerunning layout or resetting the viewport', async () => {
  const { app, cfg, graph, timeline } = await mainApp()
  await app.init()
  const position = { x: graph.nodes[0].style.x, y: 120 }
  Object.assign(graph.nodes[0].style, position)
  graph.viewport = { zoom: 0.3, position: [20, 70] }
  const viewport = graph.viewport
  timeline.length = 0
  await app.toggleTheme()
  assert.equal(cfg.theme, 'light')
  assert.equal(graph.options.node.style.labelFill, '#242a38')
  assert.equal(graph.nodes[0].style.labelFill, '#242a38')
  await app.toggleTheme()
  assert.equal(cfg.theme, 'dark')
  assert.equal(graph.options.node.style.labelFill, '#ffffff')
  assert.equal(graph.nodes[0].style.labelFill, '#ffffff')
  assert.equal(graph.options.node.state.selected.labelFontWeight, 700)
  assert.equal(graph.options.node.style.badgeFontSize, graph.options.node.style.labelFontSize)
  assert.deepEqual(timeline, ['draw', 'draw'])
  assert.equal(graph.viewport, viewport)
  assert.equal(graph.nodes[0].style.x, position.x)
  assert.equal(graph.nodes[0].style.y, position.y)
})

test('same-namespace refresh updates resources and stale links in place, preserving selection and viewport', async () => {
  const { app, graph, timeline, cachedResources, setResourceResponse, window } = await mainApp({
    resources: { Pod: [pod('owner'), pod('existing', ['owner']), pod('deleted')] },
  })
  await app.init()
  const existing = graph.nodes.find((node) => node.id === 'existing')
  existing.states = ['selected']
  app.searchQuery = 'existing'
  graph.viewport = { zoom: 0.4, position: [10, 20] }
  const viewport = graph.viewport
  let panelCloses = 0
  window.addEventListener('closePanel', () => panelCloses++)
  setResourceResponse(async () => ({
    ok: true,
    json: async () => ({ Pod: [pod('owner'), pod('existing'), pod('new', ['existing'])] }),
  }))
  timeline.length = 0
  await app.fetchNamespace()
  assert.deepEqual(timeline, ['draw', 'applyLayout'])
  assert.equal(graph.nodes.find((node) => node.id === 'existing'), existing)
  assert.deepEqual(existing.states, ['selected'])
  assert.equal(app.searchQuery, 'existing')
  assert.equal(graph.nodes.find((node) => node.id === 'new').style.visibility, 'hidden')
  assert.equal(graph.viewport, viewport)
  assert.equal(panelCloses, 0)
  assert.deepEqual([...cachedResources.keys()], ['owner', 'existing', 'new'])
  assert.deepEqual(graph.edges, [{ id: 'existing-new' }])
  timeline.length = 0
  await app.fetchNamespace()
  assert.deepEqual(timeline, ['draw'])
  app.namespace = 'another'
  timeline.length = 0
  await app.fetchNamespace()
  assert.deepEqual(timeline, ['clear', 'render', 'fit'])
  assert.equal(panelCloses, 1)
  assert.equal(app.searchQuery, '')
  assert.equal(graph.options.layout.type, 'force')
})

test('initial SSE connection does not refetch the already rendered graph; an actual reconnect does', async () => {
  const { app, cfg, window, requests } = await mainApp()
  cfg.refreshMode = 'live'
  await app.init()
  const initialRequests = requests.length
  const connect = (state) => window.dispatchEvent(new CustomEvent('connectionStateChange', { detail: { state } }))
  connect('connected')
  assert.equal(requests.length, initialRequests)
  connect('disconnected')
  connect('connected')
  assert.equal(requests.length, initialRequests + 1)
})

test('connection status shows a shortened cluster destination without its domain or port', async () => {
  const { app, cfg } = await mainApp()
  cfg.refreshMode = 'live'
  app.connState = 'connected'
  assert.equal(app.connectionLabel, 'offline')
  assert.equal(app.connectionDestination, '')
  app.serviceMetadata.clusterHost = 'https://demo-cluster.example.test:6443'
  assert.equal(app.connectionDestination, 'demo-cluster')
  assert.equal(app.connectionLabel, 'demo-cluster')
  app.serviceMetadata.clusterHost = 'https://development-north-cluster.example.test'
  assert.equal(app.connectionDestination, 'developme...luster')
  assert.equal(app.connectionLabel, 'developme...luster')
  app.connState = 'disconnected'
  assert.equal(app.connectionLabel, 'offline')
  app.connState = 'connected'
  cfg.refreshMode = 'offline'
  assert.equal(app.connectionLabel, 'offline')
  cfg.refreshMode = '15s'
  assert.equal(app.connectionLabel, 'offline')
})

test('polling and manual modes report successful HTTP connectivity, failures and explicit Offline report offline', async () => {
  for (const mode of ['manual', '15s', '1m']) {
    const { app, cfg, setResourceResponse } = await mainApp({ clusterHost: 'https://demo-cluster.example.test:6443' })
    cfg.refreshMode = mode
    await app.init()
    assert.equal(app.connectionLabel, 'demo-cluster')

    setResourceResponse(() => { throw new Error('Connection refused') })
    await app.fetchNamespace()
    assert.equal(app.connectionLabel, 'offline')
    assert.equal(app.isLoading, false)

    setResourceResponse(async () => ({ ok: true, json: async () => ({ Pod: [pod('existing')] }) }))
    await app.fetchNamespace()
    assert.equal(app.connectionLabel, 'demo-cluster')
    assert.equal(app.errorMessage, '')

    cfg.refreshMode = 'offline'
    app.configureRefreshMode()
    assert.equal(app.connectionLabel, 'offline')
    cfg.refreshMode = 'manual'
    app.configureRefreshMode()
    assert.equal(app.connectionLabel, 'offline')
    await app.fetchNamespace()
    assert.equal(app.connectionLabel, 'demo-cluster')
  }
})

test('refresh modes clear previous timers, stop SSE, and Offline preserves the graph without any fetch', async () => {
  const { app, cfg, timers, requests, timeline, streams } = await mainApp()
  await app.init()
  cfg.refreshMode = '15s'
  app.configureRefreshMode()
  assert.equal(timers.size, 1)
  assert.equal([...timers.values()][0].delay, 15000)
  app.configureRefreshMode()
  assert.equal(timers.size, 1)
  cfg.refreshMode = '1m'
  app.configureRefreshMode()
  assert.equal(timers.size, 1)
  assert.equal([...timers.values()][0].delay, 60000)
  cfg.refreshMode = 'live'
  app.configureRefreshMode()
  assert.equal(timers.size, 0)
  assert.equal(streams().starts, 1)
  cfg.refreshMode = 'offline'
  app.configureRefreshMode()
  const requestCount = requests.length
  timeline.length = 0
  await app.refreshNamespaces()
  await app.fetchNamespace()
  await app.refreshAll()
  assert.equal(requests.length, requestCount)
  assert.deepEqual(timeline, [])
  assert.equal(timers.size, 0)
  cfg.refreshMode = 'manual'
  app.configureRefreshMode()
  await app.refreshAll()
  assert.equal(requests.length, requestCount + 2)
  assert.equal(timers.size, 0)
})

test('switching Offline aborts pending namespace data and ignores even a late successful response', async () => {
  const { app, cfg, requests, timeline, setResourceResponse } = await mainApp()
  await app.init()
  let resolveResponse
  setResourceResponse(() => new Promise((resolve) => { resolveResponse = resolve }))
  const pending = app.fetchNamespace()
  assert.equal(app.isLoading, true)
  cfg.refreshMode = 'offline'
  app.configureRefreshMode()
  assert.equal(requests.at(-1).options.signal.aborted, true)
  assert.equal(app.isLoading, false)
  timeline.length = 0
  resolveResponse({ ok: true, json: async () => ({ Pod: [] }) })
  await pending
  assert.deepEqual(timeline, [])
})

async function rollout(fetch) {
  const module = await loadModule('../js/rollout-dialog.js', {}, { fetch })
  const dialog = module.default()
  dialog.cfg = { refreshMode: 'manual' }
  dialog.namespace = 'team'
  dialog.rolloutsEnabled = true
  const watchers = new Map()
  dialog.$watch = (key, handler) => watchers.set(key, handler)
  dialog.init()
  return { dialog, watchers }
}

const deployment = { apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: 'example', namespace: 'team' } }
const response = (data, ok = true) => ({ ok, status: ok ? 200 : 403, text: async () => JSON.stringify(data) })

test('rollouts require dry-run preview, a separate confirmation, and an unchanged namespace and manifest', async () => {
  const requests = []
  const { dialog } = await rollout(async (url, options) => {
    requests.push({ url, options })
    return response(deployment)
  })
  await dialog.submit(false)
  assert.equal(requests.length, 0)
  await dialog.submit(true)
  assert.equal(requests[0].url, 'api/rollout/team?dryRun=true')
  assert.equal(requests[0].options.method, 'POST')
  assert.deepEqual(JSON.parse(requests[0].options.body), { manifest: dialog.manifest })
  assert.equal(JSON.parse(dialog.preview).kind, 'Deployment')
  await dialog.submit(false)
  assert.equal(requests.length, 1)
  dialog.confirmApply = true
  dialog.namespace = 'other'
  await dialog.submit(false)
  assert.equal(requests.length, 1)
  dialog.namespace = 'team'
  dialog.manifest += '\n'
  await dialog.submit(false)
  assert.equal(requests.length, 1)
  await dialog.submit(true)
  dialog.confirmApply = true
  await dialog.submit(false)
  assert.equal(requests.at(-1).url, 'api/rollout/team?dryRun=false')
  assert.equal(JSON.parse(dialog.result).kind, 'Deployment')
  assert.equal(dialog.canApply, false)
})

test('disabled and Offline rollouts make no requests; leaving Offline requires a new preview', async () => {
  let count = 0
  const { dialog, watchers } = await rollout(async () => {
    count++
    return response(deployment)
  })
  dialog.rolloutsEnabled = false
  await dialog.submit(true)
  assert.equal(count, 0)
  dialog.rolloutsEnabled = true
  await dialog.submit(true)
  dialog.confirmApply = true
  dialog.cfg.refreshMode = 'offline'
  watchers.get('cfg.refreshMode')()
  await dialog.submit(true)
  await dialog.submit(false)
  assert.equal(count, 1)
  assert.equal(dialog.preview, '')
  dialog.cfg.refreshMode = 'manual'
  assert.equal(dialog.canApply, false)
})

test('failed or stale dry-run responses never authorize Apply and server error text stays plain', async () => {
  let resolveResponse
  const { dialog, watchers } = await rollout(() => new Promise((resolve) => { resolveResponse = resolve }))
  const pending = dialog.submit(true)
  dialog.namespace = 'other'
  watchers.get('namespace')()
  resolveResponse(response(deployment))
  await pending
  assert.equal(dialog.preview, '')
  assert.equal(dialog.canApply, false)
  assert.equal(dialog.busy, false)

  const failed = await rollout(async () => response({ detail: '<script>not executable</script>' }, false))
  await failed.dialog.submit(true)
  assert.equal(failed.dialog.error, '<script>not executable</script>')
  assert.equal(failed.dialog.canApply, false)
})
