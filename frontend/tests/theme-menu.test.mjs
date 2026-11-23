import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import test from 'node:test'
import { createContext, runInNewContext, SourceTextModule, SyntheticModule } from 'node:vm'

const require = createRequire(import.meta.url)
const { Graph, ComboCombinedLayout, Hull, getExtension, getExtensions } = require('../ext/g6.min.js')

async function loadApp(theme = 'dark', preferences = {}) {
  const components = new Map()
  const errors = []
  const savedThemes = []
  let savedConfig = JSON.stringify({ theme, spacing: 100, resFilter: ['Service', 'Pod'], refreshMode: 'manual', ...preferences })
  const localStorage = { getItem: () => savedConfig, setItem: (_key, value) => { savedConfig = value } }
  const document = { documentElement: { dataset: { theme } } }
  const context = createContext({
    window: { addEventListener() {} },
    document,
    localStorage,
    console: { log() {}, error: (...args) => errors.push(args) },
    setInterval,
    clearInterval,
    AbortController,
    URL,
    Set,
  })
  const configModule = new SourceTextModule(await readFile(new URL('../js/config.js', import.meta.url), 'utf8'), { context })
  await configModule.link(() => assert.fail('Config should not import dependencies'))
  await configModule.evaluate()
  const cfg = configModule.namespace.getConfig()

  class HeadlessGraph extends Graph {
    draws = 0
    failDraw = false

    constructor(options) {
      super(options)
      // Only the real model and style controller are needed; no canvas services.
      for (const service of ['batch', 'plugin', 'viewport', 'transform', 'animation', 'layout', 'behavior']) {
        this.context[service] = {}
      }
      this.initRuntime()
      this.context.plugin.setPlugins = () => {}
      this.context.element.draw = () => {
        this.context.element.computeStyle()
      }
    }

    async draw() {
      this.draws++
      if (this.failDraw) {
        this.failDraw = false
        throw new Error('Drawing failed')
      }
      this.context.element.computeStyle()
    }

    async layout() {
      assert.fail('Appearance changes must not relayout the graph')
    }

    async fitView() {
      assert.fail('Appearance changes must not reset the viewport')
    }
  }

  const dependencies = {
    '../ext/alpinejs.esm.min.js': { default: { data: (name, factory) => components.set(name, factory), start() {} } },
    '../ext/g6-esm.js': { Graph: HeadlessGraph, GraphEvent: {} },
    './config.js': {
      ...configModule.namespace,
      saveConfig: async (config) => {
        savedThemes.push(config.theme)
        await configModule.namespace.saveConfig(config)
      },
    },
    './events.js': { getClientId() {}, initEventStreaming() {}, stopEventStreaming() {} },
    './graph.js': { addResource() {}, updateResource() {}, processLinks() {}, layout() {} },
    './cache.js': { clearCache() {}, queryRes: () => [] },
    '../ext/toast.js': { showToast() {} },
    './graph-utils.js': { fitToVisible() {}, getLayout: () => ({}), nodeVisByLabel() {} },
    './side-panel.js': { default() {} },
    './events-dialog.js': { default() {} },
    './rollout-dialog.js': { default() {} },
  }
  const source = await readFile(new URL('../js/main.js', import.meta.url), 'utf8')
  const module = new SourceTextModule(source, { context })
  await module.link(async (specifier) => {
    if (specifier === './container-layout.js') {
      const containers = new SourceTextModule(await readFile(new URL('../js/container-layout.js', import.meta.url), 'utf8'), { context })
      await containers.link(() => assert.fail('Container layout should not import dependencies'))
      return containers
    }
    const exports = dependencies[specifier]
    assert.ok(exports, `Unexpected dependency: ${specifier}`)
    return new SyntheticModule(Object.keys(exports), function () {
      for (const [name, value] of Object.entries(exports)) this.setExport(name, value)
    }, { context })
  })
  await module.evaluate()
  return {
    app: components.get('mainApp')(), graph: module.namespace.graph, cfg, document, errors, savedThemes,
    getSavedConfig: () => JSON.parse(savedConfig),
  }
}

function assertReadable(graph, type, id, theme) {
  const data = type === 'node' ? graph.getNodeData(id) : graph.getEdgeData(id)
  graph.context.element.computeStyle()
  const style = graph.context.element.getElementComputedStyle(type, data)
  assert.equal(style.labelFill, theme === 'dark' ? '#ffffff' : '#242a38')
  assert.equal(style.labelFillOpacity, 1)
  assert.equal(style.labelOpacity, 1)
  assert.equal(style.labelBackground, true)
  assert.equal(style.labelBackgroundOpacity, 1)
  assert.notEqual(style.labelFill, style.labelBackgroundFill)
  assert.ok(contrast(style.labelFill, style.labelBackgroundFill) >= 4.5)
  assert.ok(style.labelText)
  if (type === 'node') {
    assert.equal(style.badgeFill, style.labelFill)
    assert.equal(style.badgeFontFamily, style.labelFontFamily)
    assert.equal(style.badgeFontSize, style.labelFontSize)
    assert.equal(style.badgeFontWeight, style.labelFontWeight)
    assert.equal(style.badgeBackground, false)
  }
}

test('real G6 ports match resource labels through theme and selection changes without badge backgrounds', async () => {
  for (const initialTheme of ['dark', 'light']) {
    const { app, graph, cfg, document } = await loadApp(initialTheme, { whiteBackground: false })
    graph.setData({
      nodes: [
        { id: 'svc', style: { x: 120, y: 80, labelText: 'metrics', labelFill: initialTheme === 'dark' ? '#ffffff' : '#242a38',
          badges: [{ text: '9090', placement: 'top' }] } },
        { id: 'pod', style: { x: 200, y: 240, labelText: 'app' } },
        { id: 'hidden', style: { labelText: 'filtered', visibility: 'hidden' } },
      ],
      edges: [{ id: 'network', source: 'svc', target: 'pod', style: { labelText: '' } }],
    })
    for (let cycle = 0; cycle < 4; cycle++) {
      for (const selected of [true, false]) {
        await graph.setElementState({
          svc: selected ? ['selected'] : ['unselected'],
          pod: selected ? ['unselected'] : ['selected'],
          network: selected ? ['selected'] : ['unselected'],
        }, false)
        const states = graph.getElementState('svc')
        await app.toggleTheme()
        assert.equal(graph.getTheme(), cfg.theme)
        assert.equal(document.documentElement.dataset.theme, cfg.theme)
        for (const id of ['svc', 'pod']) assertReadable(graph, 'node', id, cfg.theme)
        assert.equal(graph.getEdgeData('network').style.labelText, '')
        assert.deepEqual(graph.getElementState('svc'), states)
        assert.equal(graph.getNodeData('svc').style.x, 120)
        assert.equal(graph.getNodeData('svc').style.y, 80)
        assert.equal(graph.getNodeData('svc').style.badges[0].text, '9090')
        assert.equal(graph.getNodeData('hidden').style.visibility, 'hidden')
      }
    }
    graph.addNodeData([{ id: 'new', style: { labelText: 'new resource' } }])
    assertReadable(graph, 'node', 'new', cfg.theme)
  }
})

test('a failed theme redraw restores the graph, document and saved preference', async () => {
  const { app, graph, cfg, document, errors, savedThemes } = await loadApp('dark', { whiteBackground: false })
  graph.addNodeData([{ id: 'svc', style: { labelText: 'metrics' } }])
  graph.failDraw = true
  await app.toggleTheme()
  assert.equal(cfg.theme, 'dark')
  assert.equal(document.documentElement.dataset.theme, 'dark')
  assert.equal(graph.getTheme(), 'dark')
  assert.deepEqual(savedThemes, ['light', 'dark'])
  assert.equal(errors.length, 1)
  assertReadable(graph, 'node', 'svc', 'dark')
})

test('white canvas is independent of the UI theme and keeps existing and future G6 resources readable', async () => {
  for (const initialTheme of ['dark', 'light']) {
    const { app, graph, cfg, document, getSavedConfig } = await loadApp(initialTheme)
    assert.equal(cfg.whiteBackground, true, 'Older saved settings default to a white canvas')
    assert.equal(graph.getTheme(), 'light')
    assert.equal(document.documentElement.dataset.theme, initialTheme)
    graph.setData({
      nodes: [
        { id: 'svc', style: { x: 120, y: 80, labelText: 'metrics', labelFill: '#242a38',
          badges: [{ text: '9090', placement: 'top' }] } },
        { id: 'pod', style: { labelText: 'app' } },
        { id: 'hidden', style: { labelText: 'filtered', visibility: 'hidden' } },
      ],
      edges: [{ id: 'network', source: 'svc', target: 'pod', style: { labelText: '' } }],
    })
    for (const id of ['svc', 'pod']) assertReadable(graph, 'node', id, 'light')
    app.searchQuery = 'metrics'
    app.showEventsDialog = true
    for (const whiteBackground of [true, false, true, false]) {
      const previousTheme = cfg.theme
      const previousStates = graph.getElementState('svc')
      if (cfg.whiteBackground !== whiteBackground) await app.toggleWhiteBackground()
      assert.equal(app.isChangingBackground, false)
      const canvasTheme = whiteBackground ? 'light' : cfg.theme
      assert.equal(graph.getTheme(), canvasTheme)
      assert.equal(cfg.theme, previousTheme)
      assert.equal(document.documentElement.dataset.theme, previousTheme)
      assert.deepEqual(graph.getElementState('svc'), previousStates)
      for (const id of ['svc', 'pod']) assertReadable(graph, 'node', id, canvasTheme)
      assert.equal(
        graph.context.element.getElementComputedStyle('edge', graph.getEdgeData('network')).stroke,
        canvasTheme === 'dark' ? '#a8b2c4' : '#666666',
      )
      for (const selected of [true, false]) {
        await graph.setElementState({
          svc: selected ? ['selected'] : ['unselected'],
          pod: selected ? ['unselected'] : ['selected'],
          network: selected ? ['selected'] : ['unselected'],
        }, false)
        const states = graph.getElementState('svc')
        await app.toggleTheme()
        const canvasTheme = whiteBackground ? 'light' : cfg.theme
        assert.equal(graph.getTheme(), canvasTheme)
        assert.equal(cfg.whiteBackground, whiteBackground)
        assert.equal(document.documentElement.dataset.theme, cfg.theme)
        graph.updateNodeData([{ id: 'pod', style: { labelText: 'updated app' } }])
        graph.addNodeData([{ id: 'future', style: { labelText: 'live service', badges: [{ text: '8080', placement: 'top' }] } }])
        graph.addEdgeData([{ id: 'future-link', source: 'svc', target: 'future' }])
        for (const id of ['svc', 'pod', 'future']) assertReadable(graph, 'node', id, canvasTheme)
        for (const id of ['network', 'future-link']) {
          const style = graph.context.element.getElementComputedStyle('edge', graph.getEdgeData(id))
          assert.equal(style.stroke, canvasTheme === 'dark' ? '#a8b2c4' : '#666666')
          assert.equal(style.strokeOpacity, 1)
          assert.equal(style.endArrow, true)
          assert.ok(contrast(style.stroke, canvasTheme === 'dark' ? '#0a0b0d' : '#ffffff') >= 3)
          assert.equal(style.labelBackgroundFill, canvasTheme === 'dark' ? '#20232b' : '#ffffff')
        }
        graph.removeEdgeData(['future-link'])
        graph.removeNodeData(['future'])
        assert.deepEqual(graph.getElementState('svc'), states)
        assert.equal(graph.getNodeData('svc').style.x, 120)
        assert.equal(graph.getNodeData('svc').style.y, 80)
        assert.equal(graph.getNodeData('svc').style.badges[0].text, '9090')
        assert.equal(graph.getNodeData('hidden').style.visibility, 'hidden')
        assert.equal(app.searchQuery, 'metrics')
        assert.equal(app.showEventsDialog, true)
      }
      assert.equal(getSavedConfig().whiteBackground, whiteBackground)
    }
    const reloaded = await loadApp(cfg.theme, getSavedConfig())
    assert.equal(reloaded.cfg.whiteBackground, false)
    assert.equal(reloaded.graph.getTheme(), cfg.theme)
    assert.equal(reloaded.document.documentElement.dataset.theme, cfg.theme)
  }
})

test('a failed background redraw restores the white canvas without changing the UI theme', async () => {
  const { app, graph, cfg, document, errors, getSavedConfig } = await loadApp()
  graph.addNodeData([{ id: 'svc', style: { labelText: 'metrics', badges: [{ text: '9090', placement: 'top' }] } }])
  graph.failDraw = true
  await app.toggleWhiteBackground()
  assert.equal(app.isChangingBackground, false)
  assert.equal(cfg.whiteBackground, true)
  assert.equal(getSavedConfig().whiteBackground, true)
  assert.equal(cfg.theme, 'dark')
  assert.equal(document.documentElement.dataset.theme, 'dark')
  assert.equal(graph.getTheme(), 'light')
  assert.equal(errors.length, 1)
  assertReadable(graph, 'node', 'svc', 'light')
})

test('real G6 container cleanup never cascades into resource nodes, edges or selection', async () => {
  const context = createContext({})
  const containers = new SourceTextModule(await readFile(new URL('../js/container-layout.js', import.meta.url), 'utf8'), { context })
  await containers.link(() => assert.fail('Unexpected container dependency'))
  await containers.evaluate()
  const { syncContainers, clearContainers } = containers.namespace
  const { graph, cfg } = await loadApp('light')
  graph.setData({
    nodes: [{ id: 'api', states: ['selected'] }, { id: 'metrics' }],
    edges: [{ id: 'link', source: 'api', target: 'metrics' }],
  })
  const resources = ['api', 'metrics'].map((uid) => ({
    kind: 'Pod', metadata: { uid, labels: { 'app.kubernetes.io/name': uid === 'api' ? 'example' : 'prometheus' } },
  }))
  syncContainers(graph, resources, cfg)
  assert.equal(graph.getComboData().length, 5)
  graph.updateNodeData([{ id: 'metrics', style: { visibility: 'hidden' } }])
  syncContainers(graph, resources, cfg)
  assert.equal(graph.getComboData().length, 3)
  assert.equal(graph.getNodeData().length, 2)
  assert.equal(graph.getEdgeData().length, 1)
  assert.equal(graph.getNodeData('metrics').combo, null)
  clearContainers(graph)
  assert.equal(graph.getComboData().length, 0)
  assert.equal(graph.getNodeData().length, 2)
  assert.equal(graph.getEdgeData().length, 1)
  assert.deepEqual(graph.getElementState('api'), ['selected'])
})

test('real G6 compound force positions group members organically and produces smooth hull paths', async () => {
  const context = createContext({})
  const utils = new SourceTextModule(await readFile(new URL('../js/graph-utils.js', import.meta.url), 'utf8'), { context })
  await utils.link(() => new SyntheticModule(['getConfig'], function () {
    this.setExport('getConfig', () => ({ spacing: 100 }))
  }, { context }))
  await utils.evaluate()
  const layout = new ComboCombinedLayout({
    ...utils.namespace.getLayout('containers'),
    // G6's adapter supplies this mapping when it runs the native layout.
    node: (node) => ({ isCombo: node.isCombo }),
  })
  try {
    await layout.execute({
      nodes: [{ id: 'group', isCombo: true }, ...['a', 'b', 'c'].map((id) => ({ id, parentId: 'group' }))],
      edges: [{ source: 'a', target: 'b' }, { source: 'b', target: 'c' }],
    })
    const nodes = layout.model.nodes().filter((node) => node.id !== 'group')
    assert.ok(nodes.every((node) => Number.isFinite(node.x) && Number.isFinite(node.y)))
    assert.ok(new Set(nodes.map((node) => node.x)).size > 1)
    assert.ok(new Set(nodes.map((node) => node.y)).size > 1)
    for (const [index, node] of nodes.entries()) {
      for (const other of nodes.slice(index + 1)) assert.ok(Math.hypot(node.x - other.x, node.y - other.y) > 100)
    }
    const hull = new Hull({
      graph: {
        on() {}, off() {},
        getNodeData: (id) => ({ id, style: nodes.find((node) => node.id === id) }),
        getElementRenderBounds: () => ({ halfExtents: [75, 75] }),
      },
    }, { members: nodes.map((node) => node.id), corner: 'smooth', concavity: 2, padding: 30, fillOpacity: 0 })
    const path = hull.getHullPath()
    assert.ok(path.some((segment) => segment[0] === 'C'))
    assert.ok(path.every((segment) => segment.slice(1).every(Number.isFinite)))
    assert.equal(hull.options.fillOpacity, 0)
    hull.unbindEvents()
  } finally {
    layout.destroy()
  }
})

test('edge styles update existing and future G6 edges without losing graph state and survive theme changes and reload', async () => {
  const { app, graph, cfg, getSavedConfig } = await loadApp()
  assert.equal(graph.getOptions().edge.type, 'cubic-vertical')
  graph.setData({
    nodes: [
      { id: 'svc', style: { x: 120, y: 80, labelText: 'metrics' } },
      { id: 'pod', style: { x: 240, y: 200, labelText: 'app' } },
      { id: 'hidden', style: { visibility: 'hidden' } },
    ],
    edges: [{ id: 'network', source: 'svc', target: 'pod', states: ['selected'], style: { labelText: '' } }],
  })
  await graph.setElementState({ svc: ['selected'] }, false)
  app.searchQuery = 'metrics'
  app.showEventsDialog = true
  const expectedTypes = Object.keys(getExtensions('edge')).filter((type) => type !== 'cubic-radial').sort()
  assert.deepEqual(Array.from(app.edgeStyles, ({ value }) => value).sort(), expectedTypes)

  for (const { value } of app.edgeStyles) {
    cfg.edgeStyle = value
    await app.applyEdgeStyle()
    assert.equal(app.isChangingEdgeStyle, false)
    assert.equal(getSavedConfig().edgeStyle, value)
    for (const id of ['network', 'new']) {
      if (id === 'new') {
        graph.addEdgeData([{ id, source: 'pod', target: 'svc' }])
        await graph.draw()
      }
      const edge = graph.getEdgeData(id)
      const type = graph.context.element.getElementType('edge', edge)
      assert.equal(type, value)
      assert.ok(getExtension('edge', type))
      const style = graph.context.element.getElementComputedStyle('edge', edge)
      assert.equal(style.endArrow, true)
      assert.equal(style.router?.type || false, value === 'polyline' ? 'orth' : false)
    }
    graph.removeEdgeData(['new'])
    await app.toggleTheme()
    assert.equal(graph.getOptions().edge.type, value)
    assert.equal(graph.getNodeData('svc').style.x, 120)
    assert.equal(graph.getNodeData('svc').style.y, 80)
    assert.equal(graph.getNodeData('hidden').style.visibility, 'hidden')
    assert.deepEqual(graph.getElementState('svc'), ['selected'])
    assert.deepEqual(graph.getElementState('network'), ['selected'])
    assert.equal(app.searchQuery, 'metrics')
    assert.equal(app.showEventsDialog, true)
    const reloaded = await loadApp(cfg.theme, getSavedConfig())
    assert.equal(reloaded.graph.getOptions().edge.type, value)
    assert.equal(reloaded.graph.getOptions().edge.style.router?.type || false, value === 'polyline' ? 'orth' : false)
  }
})

test('failed or unsupported edge style changes restore the previous graph and saved preference', async () => {
  for (const failure of ['draw', 'unsupported']) {
    const { app, graph, cfg, errors, getSavedConfig } = await loadApp('dark', { edgeStyle: 'polyline' })
    cfg.edgeStyle = failure === 'unsupported' ? 'cubic-radial' : 'line'
    graph.failDraw = failure === 'draw'
    await app.applyEdgeStyle()
    assert.equal(cfg.edgeStyle, 'polyline')
    assert.equal(graph.getOptions().edge.type, 'polyline')
    assert.equal(graph.getOptions().edge.style.router.type, 'orth')
    assert.equal(getSavedConfig().edgeStyle, 'polyline')
    assert.equal(app.isChangingEdgeStyle, false)
    assert.equal(errors.length, 1)
  }
})

test('the top bar keeps refresh and graph export while layout and graph actions stay in the sidebar', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8')
  const topMenu = html.slice(html.indexOf('navbar-brand'), html.indexOf('<div class="navbar-start">'))
  const topActions = html.slice(html.indexOf('<div class="navbar-actions"'), html.indexOf('</nav>'))
  const sidebar = html.slice(html.indexOf('<aside class="app-controls"'), html.indexOf('</aside>'))
  const css = await readFile(new URL('../css/main.css', import.meta.url), 'utf8')

  assert.match(topMenu, /is-justify-content-space-between/)
  assert.match(topMenu, /ml-auto/)
  assert.match(topMenu, /@click="toggleTheme\(\)"/)
  assert.match(topMenu, /id="clusterSelect"/)
  assert.match(topActions, /@click="refreshAll\(\)"/)
  assert.match(topActions, /@click="toolbarSavePNG\(\)"/)
  assert.match(topActions, /title="graph export"/)
  assert.match(topActions, /aria-label="graph export"/)
  assert.doesNotMatch(topActions, /<span>Graph export<\/span>/)
  assert.doesNotMatch(topActions, /<span>Export<\/span>/)
  assert.doesNotMatch(topActions, /toolbarDagreLayout|toolbarForceLayout|toolbarFit|showEventsDialog|showRolloutDialog/)
  assert.match(sidebar, /toolbarDagreLayout/)
  assert.match(sidebar, /toolbarForceLayout/)
  assert.match(sidebar, /toolbarFit/)
  assert.match(sidebar, /showEventsDialog/)
  assert.match(sidebar, /for="edgeStyle">edge style</)
  assert.match(sidebar, /id="edgeStyle" x-model="cfg.edgeStyle" @change="applyEdgeStyle\(\)"/)
  assert.match(sidebar, /x-for="style in edgeStyles"/)
  assert.doesNotMatch(topActions, /edgeStyle|applyEdgeStyle/)
  assert.match(sidebar, />view</)
  assert.match(sidebar, />filter</)
  assert.match(sidebar, />graph</)
  assert.match(css, /\.app-controls\s*\{[^}]*text-transform:\s*lowercase/s)
  assert.equal((html.match(/id="clusterSelect"/g) || []).length, 1)
})

test('cluster selection is an inline combobox with live destination and offline state, not a dialog', async () => {
  const { app } = await loadApp()
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8')
  const select = html.match(/<select[^>]*id="clusterSelect"[^>]*>[\s\S]*?<\/select>/)?.[0]
  assert.ok(select)
  assert.match(select, /aria-label="Cluster"/)
  assert.doesNotMatch(html, /showClustersDialog|clusters-dialog/)
  assert.equal('showClustersDialog' in app, false)
  const evaluate = (attribute) => runInNewContext(select.match(new RegExp(`${attribute}="([^"]+)"`))[1], app)
  assert.equal(evaluate(':disabled'), true)
  assert.equal(evaluate('x-text'), 'offline')
  app.serviceMetadata.clusterHost = 'https://demo-cluster.example.test:6443'
  app.dataConnected = true
  assert.equal(evaluate(':disabled'), false)
  assert.equal(evaluate(':value'), app.serviceMetadata.clusterHost)
  assert.equal(evaluate(':title'), app.serviceMetadata.clusterHost)
  assert.equal(evaluate('x-text'), 'demo-cluster')
  app.cfg.refreshMode = 'offline'
  assert.equal(evaluate('x-text'), 'offline')
  assert.equal(evaluate(':value'), app.serviceMetadata.clusterHost)
})

test('the copyright button still opens About with working close actions', async () => {
  const { app } = await loadApp()
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8')
  const about = await readFile(new URL('../fragments/about-dialog.html', import.meta.url), 'utf8')
  const aboutButton = html.match(/<button[^>]*class="[^"]*about-button[^"]*"[^>]*>/s)?.[0]
  assert.ok(aboutButton)
  assert.equal(app.showAboutDialog, false)
  runInNewContext(aboutButton.match(/@click="([^"]+)"/)[1], app)
  assert.equal(app.showAboutDialog, true)
  assert.match(about, /x-show="showAboutDialog"/)
  for (const [, action] of about.matchAll(/@click="([^"]+)"/g)) {
    app.showAboutDialog = true
    runInNewContext(action, app)
    assert.equal(app.showAboutDialog, false)
  }
})

async function buttonStyles() {
  const css = await readFile(new URL('../css/main.css', import.meta.url), 'utf8')
  const rules = [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)]
  return (selector) => {
    const matches = rules.filter((match) => match[1].trim().split(/,\s*\n/).includes(selector))
    assert.ok(matches.length, `Missing style rule: ${selector}`)
    return Object.fromEntries(matches.flatMap((rule) => rule[2].trim().split(';').filter((entry) => entry.trim())).map((entry) => {
      const colon = entry.indexOf(':')
      return [entry.slice(0, colon).trim(), entry.slice(colon + 1).trim()]
    }))
  }
}

test('the quick white-background button tracks its saved preference without changing UI surfaces', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8')
  const sidebar = html.slice(html.indexOf('<aside class="app-controls"'), html.indexOf('</aside>'))
  const button = sidebar.match(/<button[^>]*@click="toggleWhiteBackground\(\)"[^>]*>[\s\S]*?<\/button>/)?.[0]
  const canvas = html.match(/<div id="mainView"[^>]*>/)?.[0]
  assert.ok(button)
  assert.ok(canvas)
  assert.match(button, /type="button"/)
  assert.match(button, /<span>white background<\/span>/)
  assert.match(button, /:disabled="isLoading \|\| isChangingBackground"/)
  const { app, cfg, document } = await loadApp('dark')
  for (const pressed of [true, false, true]) {
    if (cfg.whiteBackground !== pressed) await app.toggleWhiteBackground()
    assert.equal(runInNewContext(button.match(/:aria-pressed="([^"]+)"/)[1], app), pressed)
    assert.equal(runInNewContext(`(${button.match(/:class="([^"]+)"/)[1]})`, app)['is-selected'], pressed)
    assert.equal(runInNewContext(`(${canvas.match(/:class="([^"]+)"/)[1]})`, app)['theme-background'], !pressed)
    assert.equal(document.documentElement.dataset.theme, 'dark')
  }
  const rule = await buttonStyles()
  assert.equal(rule('#mainView')['background-color'], '#ffffff')
  assert.equal(rule('#mainView.theme-background')['background-color'], 'var(--graph-background)')
  assert.equal(rule('body')['background-color'], 'var(--graph-background)')
})

function contrast(first, second) {
  const luminance = (hex) => {
    if (hex.length === 4) hex = `#${[...hex.slice(1)].map((digit) => digit.repeat(2)).join('')}`
    const channels = hex.slice(1).match(/../g).map((channel) => {
      const value = Number.parseInt(channel, 16) / 255
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
    })
    return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722
  }
  const values = [luminance(first), luminance(second)].sort((a, b) => b - a)
  return (values[0] + 0.05) / (values[1] + 0.05)
}

test('button palettes keep text, disabled labels, close glyphs and focus indicators readable in both themes', async () => {
  const rule = await buttonStyles()
  for (const theme of ['dark', 'light', 'dark']) {
    const palette = { ...rule('html'), ...(theme === 'light' ? rule("html[data-theme='light']") : {}) }
    const resolve = (value) => value.replace(/var\((--[\w-]+)\)/g, (_, name) => resolve(palette[name]))
    assert.equal(palette['color-scheme'], theme)
    for (const surface of ['--controls-background', '--button-hover-background', '--button-active-background']) {
      const background = resolve(palette[surface])
      for (const foreground of ['--text-color', '--muted-text-color']) {
        assert.ok(contrast(resolve(palette[foreground]), background) >= 4.5, `${theme}: ${foreground} on ${surface}`)
      }
      assert.ok(contrast(palette['--button-focus-color'], background) >= 3, `${theme}: focus on ${surface}`)
    }
  }
})

test('buttons and close controls use theme colours across interaction, selection, loading and disabled states', async () => {
  const rule = await buttonStyles()
  for (const selector of ['body .button', 'body button.delete', 'body button.modal-close']) {
    assert.equal(rule(selector)['background-color'], 'var(--controls-background) !important')
    assert.equal(rule(selector).color, 'var(--text-color) !important')
    assert.equal(rule(`${selector}:focus-visible`).outline, '2px solid var(--button-focus-color)')
  }
  const controls = 'body :is(.button, button.delete, button.modal-close)'
  const enabled = `${controls}:not(:disabled):not([disabled]):not(.is-loading)`
  assert.equal(rule(`${enabled}:hover`)['background-color'], 'var(--button-hover-background) !important')
  assert.equal(rule(`${enabled}:is(:active, .is-active)`)['background-color'], 'var(--button-active-background) !important')
  assert.equal(rule('body .button.is-outlined')['background-color'], 'transparent !important')
  assert.equal(rule('.app-controls .button.is-selected')['box-shadow'], 'inset 0 -3px var(--muted-text-color)')
  assert.equal(rule('.app-controls .button.is-selected')['font-weight'], '700')
  assert.equal(rule('body .button.is-focused').outline, '2px solid var(--button-focus-color)')
  assert.equal(rule('body .button.is-loading').color, 'transparent !important')
  assert.equal(rule('body .button.is-loading::after')['border-color'],
    'transparent transparent var(--text-color) var(--text-color) !important')
  assert.equal(rule('body .button.is-loading:is(:disabled, [disabled])').color, 'transparent !important')
  const disabled = rule(`${controls}:is(:disabled, [disabled])`)
  assert.equal(disabled.color, 'var(--muted-text-color) !important')
  assert.equal(disabled.opacity, '1')
  for (const control of ['delete', 'modal-close']) {
    for (const pseudo of ['before', 'after']) {
      assert.equal(rule(`body button.${control}::${pseudo}`)['background-color'], 'var(--text-color)')
    }
  }
})

test('refresh controls share the button palette without losing compact lowercase styling', async () => {
  const rule = await buttonStyles()
  assert.equal(rule('.refresh-control')['background-color'], 'var(--controls-background)')
  assert.equal(rule('.refresh-control').color, 'var(--text-color)')
  assert.equal(rule('.refresh-control select').color, 'inherit')
  assert.equal(rule('.refresh-control select')['color-scheme'], undefined)
  assert.equal(rule('.refresh-control select:not(:disabled):hover')['background-color'], 'var(--button-hover-background)')
  assert.equal(rule('.refresh-control select:not(:disabled):active')['background-color'], 'var(--button-active-background)')
  assert.equal(rule('.refresh-control > :focus-visible').outline, '2px solid var(--button-focus-color)')
  assert.equal(rule('.refresh-control select:disabled').color, 'var(--muted-text-color) !important')
  assert.equal(rule('body .button')['text-transform'], 'lowercase')
  assert.equal(rule('.navbar-actions .button').width, 'max-content')
})

test('cluster controls, dialog surfaces and success notifications use neutral theme colours', async () => {
  const rule = await buttonStyles()
  assert.equal(rule('.cluster-select select')['background-color'], 'var(--controls-background)')
  assert.equal(rule('.cluster-select select').color, 'var(--text-color)')
  assert.equal(rule('.cluster-select select:focus-visible').outline, '2px solid var(--button-focus-color)')
  assert.equal(rule('.cluster-select select:disabled').color, 'var(--muted-text-color) !important')
  for (const selector of ['.modal-card-head', '.modal-card-foot', 'body .toast.success']) {
    assert.equal(rule(selector)['background-color'], 'var(--controls-background)')
  }
  assert.equal(rule('.modal-card-title').color, 'var(--text-color)')
  assert.equal(rule('.modal-card-body')['background-color'], 'var(--menu-background)')
  assert.equal(rule('.modal-card-body').color, 'var(--text-color)')
  assert.equal(rule('body .toast.success').color, 'var(--text-color)')
  for (const name of ['about', 'events', 'logs', 'rollout']) {
    const fragment = await readFile(new URL(`../fragments/${name}-dialog.html`, import.meta.url), 'utf8')
    assert.doesNotMatch(fragment, /has-background-primary|has-text-black/)
  }
})
