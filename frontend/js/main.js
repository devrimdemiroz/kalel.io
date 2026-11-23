//@ts-check
/// <reference path="./types/custom.d.ts" />

// ==========================================================================================
// Main JavaScript entry point for KubeView
// Handles the main G6 graph and data load from the server
// Provides functions to add, update, and remove resources from the graph
// ==========================================================================================
import Alpine from '../ext/alpinejs.esm.min.js'
import { Graph, GraphEvent } from '../ext/g6-esm.js'

import { edgeStyles, getConfig, saveConfig } from './config.js'
import { getClientId, initEventStreaming, stopEventStreaming } from './events.js'
import { addResource, updateResource, processLinks, layout } from './graph.js'
import { clearCache, queryRes } from './cache.js'
import { showToast } from '../ext/toast.js'
import { fitToVisible, getLayout, nodeVisByLabel } from './graph-utils.js'
import { clearContainers, drawContainerHulls, syncContainers } from './container-layout.js'
import sidePanel from './side-panel.js'
import eventsDialog from './events-dialog.js'
import rolloutDialog from './rollout-dialog.js'

/** @type {ReturnType<typeof setInterval> | null} */
let refreshTimer = null
/** @type {Set<AbortController>} */
const dataRequests = new Set()
let dataRevision = 0
const labelFontFamily = 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
const initialGraphTheme = getConfig().whiteBackground ? 'light' : getConfig().theme

/**
 * Keep labels opaque in both normal and selection states.
 * @param {'light' | 'dark'} theme
 */
function graphThemeStyles(theme) {
  const dark = theme === 'dark'
  return {
    labelFill: dark ? '#ffffff' : '#242a38',
    labelOpacity: 1,
    labelFillOpacity: 1,
    labelBackground: true,
    labelBackgroundFill: dark ? '#20232b' : '#ffffff',
    labelBackgroundOpacity: 1,
    badgeFill: dark ? '#ffffff' : '#242a38',
    badgeBackground: false,
  }
}

/**
 * Refresh cached resources while retaining existing graph nodes and their state.
 * @param {Record<string, Resource[]>} data
 * @param {Set<string>} existingNodeIds
 */
async function populateResources(data, existingNodeIds) {
  clearCache()
  for (const resources of Object.values(data)) {
    for (const res of resources || []) {
      if (existingNodeIds.has(res.metadata.uid)) {
        await updateResource(res)
      } else {
        addResource(res)
      }
    }
  }

  // Resolve links only after every resource is present.
  for (const resources of Object.values(data)) {
    for (const res of resources || []) processLinks(res)
  }
}

// Global G6 graph instance
export const graph = new Graph({
  container: 'mainView',
  data: {},
  zoomRange: [0.1, 10],
  padding: 25,
  animation: {
    duration: 250,
    delay: 0,
  },
  background: 'transparent',
  theme: initialGraphTheme,

  // Node defaults
  node: {
    type: 'image',
    style: {
      size: 100,
      ...graphThemeStyles(initialGraphTheme),
      labelFontSize: 20,
      labelFontFamily,
      labelFontWeight: 500,
      labelPlacement: 'bottom',
      labelWordWrap: false,
      labelMaxWidth: 260,
      labelMaxLines: 2,
      stroke: '#fff',
      lineWidth: 2,
      fillOpacity: 0.5,
      cursor: 'pointer',
      haloStroke: '#3153D5',
      badgeFontSize: 20,
      badgeFontFamily: labelFontFamily,
      badgeFontWeight: 500,
      badgePadding: 0,
    },
    state: {
      selected: {
        ...graphThemeStyles(initialGraphTheme),
        halo: true,
        haloLineWidth: 12,
        haloStrokeOpacity: 0.8,
        labelFontSize: 20,
        labelFontWeight: 700,
        badgeFontWeight: 700,
      },
      unselected: graphThemeStyles(initialGraphTheme),
    },
  },

  edge: {
    type: getConfig().edgeStyle,
    style: {
      ...graphThemeStyles(initialGraphTheme),
      endArrow: true,
      endArrowSize: 16,
      lineWidth: 4,
      router: getConfig().edgeStyle === 'polyline' ? { type: 'orth' } : false,
      stroke: initialGraphTheme === 'dark' ? '#a8b2c4' : '#666666',
      labelFontSize: 14,
      labelPadding: [2, 4],
      labelOffsetY: -10,
    },
    state: {
      selected: graphThemeStyles(initialGraphTheme),
      unselected: graphThemeStyles(initialGraphTheme),
    },
  },

  combo: {
    type: 'rect',
    style: {
      pointerEvents: 'none',
      radius: 12,
      lineWidth: 2,
      labelPlacement: 'top-left',
      labelTextAlign: 'left',
      labelTextBaseline: 'top',
      labelOffsetY: 18,
      labelOffsetX: 16,
      labelFontSize: 22,
      labelFontWeight: 600,
      labelFontFamily,
      labelFill: initialGraphTheme === 'dark' ? '#ffffff' : '#242a38',
    },
  },

  layout: getLayout('structured'),

  behaviors: [
    'drag-canvas',
    'drag-element',
    {
      type: 'zoom-canvas',
      sensitivity: 0.4,
    },
    {
      type: 'click-select',
      key: 'click-select-1',
      unselectedState: 'unselected',
    },
  ],
})

graph.on(GraphEvent.AFTER_DRAW, () => drawContainerHulls(graph))

/**
 * Update appearance only; retain positions, visibility, labels and selection.
 * @param {'light' | 'dark'} theme
 */
function applyGraphTheme(theme) {
  const canvasTheme = getConfig().whiteBackground ? 'light' : theme
  const styles = graphThemeStyles(canvasTheme)
  const { node, edge } = graph.getOptions()
  graph.setTheme(canvasTheme)
  graph.setNode({
    ...node,
    style: { ...node.style, ...styles },
    state: {
      ...node.state,
      selected: { ...node.state?.selected, ...styles },
      unselected: { ...node.state?.unselected, ...styles },
    },
  })
  graph.setEdge({
    ...edge,
    style: { ...edge.style, ...styles, stroke: canvasTheme === 'dark' ? '#a8b2c4' : '#666666' },
    state: {
      ...edge.state,
      selected: { ...edge.state?.selected, ...styles },
      unselected: { ...edge.state?.unselected, ...styles },
    },
  })
  graph.updateNodeData(
    graph.getNodeData().map((node) => ({
      id: node.id,
      style: { labelFill: styles.labelFill },
    })),
  )
  const { combo } = graph.getOptions()
  graph.setCombo({ ...combo, style: { ...combo.style, labelFill: styles.labelFill } })
  document.documentElement.dataset.theme = theme
}

/** @param {EdgeStyle} edgeStyle */
function applyGraphEdgeStyle(edgeStyle) {
  const { edge } = graph.getOptions()
  graph.setEdge({
    ...edge,
    type: edgeStyle,
    style: { ...edge.style, router: edgeStyle === 'polyline' ? { type: 'orth' } : false },
  })
}

window.addEventListener('resize', () => {
  graph.resize()
})

// Alpine.js component for the main application
Alpine.data('mainApp', () => ({
  // ===== Application state ================================
  errorMessage: '',
  /** @type {string[] | null} */
  namespaces: null,
  namespace: '',
  showWelcome: true,
  isLoading: false,
  isInitializing: true,
  isRefreshing: false,
  isChangingEdgeStyle: false,
  isChangingBackground: false,
  initialLayoutComplete: false,
  activeLayout: 'structured',
  isChangingLayout: false,
  renderedNamespace: '',
  showAboutDialog: false,
  cfg: getConfig(),
  edgeStyles,
  resourceFilterGroups: [
    {
      name: 'workloads',
      resources: [
        { kind: 'Pod', label: 'pods' },
        { kind: 'Deployment', label: 'deployments' },
        { kind: 'ReplicaSet', label: 'replicasets' },
        { kind: 'StatefulSet', label: 'statefulsets' },
        { kind: 'DaemonSet', label: 'daemonsets' },
        { kind: 'Job', label: 'jobs' },
        { kind: 'CronJob', label: 'cronjobs' },
      ],
    },
    {
      name: 'networking',
      resources: [
        { kind: 'Service', label: 'services' },
        { kind: 'Ingress', label: 'ingresses' },
      ],
    },
    {
      name: 'configuration',
      resources: [{ kind: 'ConfigMap', label: 'configmaps' }],
    },
    {
      name: 'storage & scaling',
      resources: [
        { kind: 'PersistentVolumeClaim', label: 'volume claims' },
        { kind: 'HorizontalPodAutoscaler', label: 'autoscalers' },
      ],
    },
  ],
  searchQuery: '',
  showEventsDialog: false,
  showLogsDialog: false,
  showRolloutDialog: false,
  rolloutsEnabled: false,
  logs: '',
  connState: 'connecting', // 'connecting', 'connected', 'disconnected'
  connStateClass: 'is-warning',
  dataConnected: false,

  /** @type {Record<string, string>} */
  serviceMetadata: {
    clusterHost: '',
    version: '',
    buildInfo: '',
    clusterMode: '',
  },

  get connectionLabel() {
    const connected = this.cfg.refreshMode === 'live' ? this.connState === 'connected' : this.dataConnected
    return this.cfg.refreshMode !== 'offline' && connected && this.serviceMetadata.clusterHost ? this.connectionDestination : 'offline'
  },

  get connectionDestination() {
    if (!this.serviceMetadata.clusterHost) return ''
    try {
      const destination = new URL(this.serviceMetadata.clusterHost).hostname.split('.')[0]
      return destination.length > 18 ? `${destination.slice(0, 9)}...${destination.slice(-6)}` : destination
    } catch (err) {
      console.error('💥 Invalid cluster endpoint:', err)
      return 'Unknown cluster'
    }
  },

  // ===== Functions ============================================

  /**
   * All app initialization logic is here, called automatically by Alpine.js
   */
  async init() {
    document.documentElement.dataset.theme = this.cfg.theme
    const navbar = document.querySelector('.app-navbar')
    if (navbar) {
      const updateNavbarHeight = () => {
        document.documentElement.style.setProperty('--navbar-height', `${navbar.getBoundingClientRect().height}px`)
        graph.resize()
      }
      new ResizeObserver(updateNavbarHeight).observe(navbar)
      updateNavbarHeight()
    }

    console.log('🚀 Initializing KubeView...')
    console.log(`🙍 ClientID ${getClientId()}`)

    // Syncs us with the connection state in events.js
    window.addEventListener('connectionStateChange', (event) => {
      const newState = /** @type {CustomEvent} */ (event).detail.state
      if (this.cfg.refreshMode === 'live' && newState === 'connected' && this.connState === 'disconnected' && !this.isInitializing) {
        showToast('Reconnected to the server!\nResuming live updates', 3000, 'top-center', 'success')
        this.fetchNamespace()
      }

      if (this.connState === 'connected' && newState === 'disconnected') {
        showToast('Disconnected from the server!\nLive updates are paused', 3000, 'top-center', 'error')
      }

      switch (newState) {
        case 'connecting':
          this.connStateClass = 'is-warning'
          break
        case 'connected':
          this.connStateClass = 'is-success'
          break
        case 'disconnected':
          this.connStateClass = 'is-danger'
          break
        case 'paused':
          this.connStateClass = 'is-grey'
          break
        default:
          this.connStateClass = 'is-warning'
      }

      this.connState = newState
    })

    // Apply search to new and renamed resources before the SSE batch is drawn.
    window.addEventListener('resourceGraphUpdated', () => {
      nodeVisByLabel(graph, this.searchQuery.trim().toLowerCase())
      this.syncContainerView()
    })

    this.$watch('searchQuery', (query) => this.filterView(query))

    this.$watch('namespace', () => {
      console.log(`🔄 Namespace changed to: ${this.namespace}`)
      if (this.isInitializing || this.isRefreshing || this.cfg.refreshMode === 'offline') return

      dataRevision++
      for (const controller of dataRequests) controller.abort()
      this.isLoading = false
      return this.fetchNamespace()
    })

    this.$watch('cfg.refreshMode', () => this.configureRefreshMode(true))

    // Check if the URL has a namespace parameter
    const urlParams = new URLSearchParams(window.location.search)
    const queryNs = urlParams.get('ns') || ''
    if (queryNs) {
      this.showWelcome = false
      this.namespace = queryNs
    }

    // Load the initial namespaces
    await this.refreshNamespaces()
    if (this.namespace) await this.fetchNamespace()
    this.isInitializing = false
    this.configureRefreshMode()

    // Handle post render event to show a toast if no nodes are present
    graph.on(GraphEvent.AFTER_RENDER, () => {
      if (graph.getNodeData().length === 0) {
        showToast('No resources found in this namespace\nCheck your filter settings', 3000, 'top-center', 'warning')
      }
    })
  },

  /**
   * @param {boolean} [refreshNow]
   */
  configureRefreshMode(refreshNow = false) {
    if (refreshTimer !== null) clearInterval(refreshTimer)
    refreshTimer = null

    if (this.cfg.refreshMode === 'live') {
      initEventStreaming()
    } else {
      stopEventStreaming()
      if (this.cfg.refreshMode === 'offline') {
        dataRevision++
        for (const controller of dataRequests) controller.abort()
        this.isLoading = false
        this.dataConnected = false
      }

      const delay = this.cfg.refreshMode === '15s' ? 15000 : this.cfg.refreshMode === '1m' ? 60000 : 0
      if (delay) refreshTimer = setInterval(() => this.refreshAll(), delay)
    }

    saveConfig(this.cfg)
    if (refreshNow && !this.isInitializing && !['manual', 'offline'].includes(this.cfg.refreshMode)) this.refreshAll()
  },

  /**
   * Fetch the list of namespaces from the server
   */
  async refreshNamespaces() {
    if (this.cfg.refreshMode === 'offline') return
    const controller = new AbortController()
    dataRequests.add(controller)
    let res
    try {
      res = await fetch('api/namespaces', { signal: controller.signal })
      if (!res.ok) throw new Error(`HTTP error ${res.status}: ${res.statusText}`)

      const data = await res.json()
      if (controller.signal.aborted || this.cfg.refreshMode === 'offline') return
      this.dataConnected = true
      this.namespaces = data.namespaces || []
      this.rolloutsEnabled = data.rolloutsEnabled === true
      this.serviceMetadata.clusterHost = data.clusterHost || ''
      this.serviceMetadata.version = data.version || ''
      this.serviceMetadata.buildInfo = data.buildInfo || ''
      this.serviceMetadata.clusterMode = data.mode || ''

      // if single namespace is returned, set it as the current namespace
      if (this.namespaces && this.namespaces.length === 1) {
        this.namespace = this.namespaces[0]
      }
    } catch (err) {
      if (controller.signal.aborted) return
      this.dataConnected = false
      await this.showError(`Failed to fetch namespaces: ${err.message}`, res)
      return
    } finally {
      dataRequests.delete(controller)
    }

    console.log(`📚 Found ${this.namespaces ? this.namespaces.length : 0} namespaces in cluster`)
  },

  /**
   * Refresh all data in the application
   * This will refresh the list of namespaces AND fetch the current namespace data
   */
  async refreshAll() {
    if (this.cfg.refreshMode === 'offline' || this.isLoading || this.isRefreshing) return
    this.isRefreshing = true
    try {
      await this.refreshNamespaces()
      if (this.namespace) await this.fetchNamespace()
    } finally {
      this.isRefreshing = false
    }
  },

  /**
   * Display an error message in the UI and log it to the console
   * @param {string} message
   * @param {Response | undefined} res
   */
  async showError(message, res) {
    this.errorMessage = message
    if (!res) {
      console.error(message)
    } else {
      try {
        const data = await res.json()
        this.errorMessage += `\n${JSON.stringify(data, null, 2) || 'No additional error information provided'}`
        console.error('API error', data)
      } catch {
        console.error('💥 Failed to read API error response')
      }
    }

    this.showWelcome = false
    this.isLoading = false
  },

  /**
   * Main function to fetch & parse the namespace data and populate the graph
   * Preserve the current view when refreshing the same namespace.
   * @param {boolean} [reset]
   */
  async fetchNamespace(reset = false) {
    if (this.cfg.refreshMode === 'offline' || !this.namespace) return
    this.errorMessage = ''

    if (this.isLoading) {
      console.warn('⚠️ Fetch already in progress, ignoring new request')
      return
    }

    this.isLoading = true
    const namespace = this.namespace
    const revision = dataRevision
    const controller = new AbortController()
    dataRequests.add(controller)

    let data
    let res
    try {
      res = await fetch(`api/fetch/${encodeURIComponent(namespace)}?clientID=${encodeURIComponent(getClientId())}`, {
        signal: controller.signal,
      })
      if (!res.ok) throw new Error(`HTTP error ${res.status}: ${res.statusText}`)
      data = await res.json()
    } catch (err) {
      if (revision === dataRevision) this.isLoading = false
      if (controller.signal.aborted) return
      this.dataConnected = false
      await this.showError(`Failed to fetch namespace data: ${err.message}`, res)
      return
    } finally {
      dataRequests.delete(controller)
    }

    try {
      if (revision !== dataRevision || this.cfg.refreshMode === 'offline' || namespace !== this.namespace) return
      this.dataConnected = true
      this.showWelcome = false
      window.history.replaceState({}, '', `?ns=${encodeURIComponent(namespace)}`)
      await this.renderNamespace(data, reset || this.renderedNamespace !== namespace)
      this.renderedNamespace = namespace
      if (!this.initialLayoutComplete && graph.getNodeData().length > 0) {
        // Seed Organic with the same painted Structured positions as a manual toolbar click.
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
        if (!this.initialLayoutComplete && revision === dataRevision && namespace === this.namespace && this.cfg.refreshMode !== 'offline') {
          if (this.activeLayout !== 'containers') await this.toolbarForceLayout()
          this.initialLayoutComplete = true
          await fitToVisible(graph, true)
        }
      }
    } catch (e) {
      console.error('💥 Error rendering graph:', e)
    } finally {
      if (revision === dataRevision) this.isLoading = false
    }
  },

  /**
   * @param {Record<string, Resource[]>} data
   * @param {boolean} replaceGraph
   */
  async renderNamespace(data, replaceGraph) {
    const previousNodes = replaceGraph ? [] : graph.getNodeData()
    const previousNodeIds = new Set(previousNodes.map((node) => node.id))
    const previousEdgeIds = new Set(replaceGraph ? [] : graph.getEdgeData().map((edge) => edge.id))
    if (replaceGraph) {
      this.searchQuery = ''
      await graph.clear()
      window.dispatchEvent(new CustomEvent('closePanel'))
    } else {
      const resourceIds = new Set(Object.values(data).flatMap((resources) => resources || []).map((res) => res.metadata.uid))
      graph.removeEdgeData([...previousEdgeIds])
      graph.removeNodeData(previousNodes.filter((node) => !resourceIds.has(node.id)).map((node) => node.id))
    }

    if (this.cfg.debug) console.log('📦 Fetched data:', data)

    await populateResources(data, previousNodeIds)

    nodeVisByLabel(graph, this.searchQuery.trim().toLowerCase())
    this.syncContainerView()
    if (replaceGraph) {
      await graph.render()
      await fitToVisible(graph, true)
    } else {
      await graph.draw()
      const nodes = graph.getNodeData()
      const edges = graph.getEdgeData()
      if (
        nodes.length !== previousNodeIds.size ||
        nodes.some((node) => !previousNodeIds.has(node.id)) ||
        edges.length !== previousEdgeIds.size ||
        edges.some((edge) => !previousEdgeIds.has(edge.id))
      ) {
        await graph.layout()
      }
    }
  },

  /**
   * Search for resources in the graph based on a query string
   * Filters nodes by their labelText property, hiding non-matching nodes
   * @param {string} query The search term to filter nodes by
   */
  async filterView(query) {
    query = query.trim().toLowerCase()

    // Filters the graph nodes and edges based on the provided label query
    const visCount = nodeVisByLabel(graph, query)

    // Re-layout the graph to organize visible nodes
    await layout()

    // Show toast with filter results
    if (visCount === 0 && graph.getNodeData().length > 0) {
      showToast(`No nodes found matching "${query}"`, 2000, 'top-center', 'warning')
    } else if (query === '') {
      showToast('Filter cleared, showing all nodes and edges', 2000, 'top-center', 'info')
    } else {
      showToast(`Found ${visCount} node(s) matching "${query}"`, 2000, 'top-center', 'info')
    }
  },

  async applyViewOptions() {
    await saveConfig(this.cfg)
    for (const res of queryRes(() => true)) await updateResource(res)
    nodeVisByLabel(graph, this.searchQuery.trim().toLowerCase())
    graph.setLayout(getLayout(this.activeLayout))
    this.syncContainerView()
    await graph.draw()
    if (graph.getNodeData().length > 0) await graph.layout()
  },

  async saveViewPreferences() {
    await saveConfig(this.cfg)
  },

  async applyEdgeStyle() {
    const previousStyle = graph.getOptions().edge.type
    this.isChangingEdgeStyle = true
    try {
      if (!edgeStyles.some(({ value }) => value === this.cfg.edgeStyle)) {
        throw new Error(`Unsupported edge style: ${this.cfg.edgeStyle}`)
      }
      applyGraphEdgeStyle(this.cfg.edgeStyle)
      await graph.draw()
      await saveConfig(this.cfg)
    } catch (err) {
      this.cfg.edgeStyle = previousStyle
      console.error('💥 Failed to change edge style:', err)
      showToast(`Failed to change edge style: ${err.message}`, 3000, 'top-center', 'error')
      try {
        applyGraphEdgeStyle(previousStyle)
        await graph.draw()
        await saveConfig(this.cfg)
      } catch (restoreErr) {
        console.error('💥 Failed to restore edge style:', restoreErr)
        showToast(`Failed to restore edge style: ${restoreErr.message}`, 3000, 'top-center', 'error')
      }
    } finally {
      this.isChangingEdgeStyle = false
    }
  },

  async setResourceFilter(kind, enabled) {
    const selected = new Set(this.cfg.resFilter)
    if (enabled) selected.add(kind)
    else selected.delete(kind)
    this.cfg.resFilter = [...selected]
    await this.applyResourceFilters()
  },

  async applyResourceFilters() {
    await saveConfig(this.cfg)
    for (const res of queryRes(() => true)) await updateResource(res)
    nodeVisByLabel(graph, this.searchQuery.trim().toLowerCase())
    await layout()
  },

  async toggleTheme() {
    const previousTheme = this.cfg.theme
    this.cfg.theme = previousTheme === 'light' ? 'dark' : 'light'

    try {
      await saveConfig(this.cfg)
      applyGraphTheme(this.cfg.theme)
      this.syncContainerView()
      await graph.draw()
    } catch (err) {
      this.cfg.theme = previousTheme
      console.error('💥 Failed to change theme:', err)
      showToast(`Failed to change theme: ${err.message}`, 3000, 'top-center', 'error')
      try {
        await saveConfig(this.cfg)
        applyGraphTheme(previousTheme)
        this.syncContainerView()
        await graph.draw()
      } catch (restoreErr) {
        console.error('💥 Failed to restore theme:', restoreErr)
        showToast(`Failed to restore theme: ${restoreErr.message}`, 3000, 'top-center', 'error')
      }
    }
  },

  async toggleWhiteBackground() {
    const previousBackground = this.cfg.whiteBackground
    this.cfg.whiteBackground = !previousBackground
    this.isChangingBackground = true

    try {
      await saveConfig(this.cfg)
      applyGraphTheme(this.cfg.theme)
      this.syncContainerView()
      await graph.draw()
    } catch (err) {
      this.cfg.whiteBackground = previousBackground
      console.error('💥 Failed to change graph background:', err)
      showToast(`Failed to change graph background: ${err.message}`, 3000, 'top-center', 'error')
      try {
        await saveConfig(this.cfg)
        applyGraphTheme(this.cfg.theme)
        this.syncContainerView()
        await graph.draw()
      } catch (restoreErr) {
        console.error('💥 Failed to restore graph background:', restoreErr)
        showToast(`Failed to restore graph background: ${restoreErr.message}`, 3000, 'top-center', 'error')
      }
    } finally {
      this.isChangingBackground = false
    }
  },

  async toolbarFit() {
    await fitToVisible(graph, true)
  },

  async toolbarForceLayout() {
    await this.changeLayout('organic')
  },

  async toolbarDagreLayout() {
    await this.changeLayout('structured')
  },

  async toolbarContainersLayout() {
    await this.changeLayout('containers')
  },

  syncContainerView() {
    if (this.activeLayout === 'containers') syncContainers(graph, queryRes(() => true), this.cfg)
  },

  /** @param {'structured' | 'organic' | 'containers'} name */
  async changeLayout(name) {
    if (this.isChangingLayout) return
    const previousLayout = this.activeLayout
    this.isChangingLayout = true
    this.initialLayoutComplete = true
    try {
      graph.stopLayout()
      if (this.activeLayout === 'containers' && name !== 'containers') clearContainers(graph)
      this.activeLayout = name
      graph.setLayout(getLayout(name))
      const { node } = graph.getOptions()
      graph.setNode({ ...node, style: { ...node.style, labelWordWrap: name === 'containers' } })
      this.syncContainerView()
      if (name === 'containers') {
        if (graph.getNodeData().length > 0) await graph.layout()
        await graph.draw()
        await fitToVisible(graph, true)
      } else if (graph.getNodeData().length > 0) {
        await graph.layout()
      }
    } catch (err) {
      console.error('💥 Failed to change graph layout:', err)
      showToast(`Failed to change graph layout: ${err.message}`, 3000, 'top-center', 'error')
      try {
        this.activeLayout = previousLayout
        if (previousLayout !== 'containers') clearContainers(graph)
        graph.setLayout(getLayout(previousLayout))
        const { node } = graph.getOptions()
        graph.setNode({ ...node, style: { ...node.style, labelWordWrap: previousLayout === 'containers' } })
        this.syncContainerView()
        await graph.draw()
      } catch (restoreErr) {
        console.error('💥 Failed to restore graph layout:', restoreErr)
        showToast(`Failed to restore graph layout: ${restoreErr.message}`, 3000, 'top-center', 'error')
      }
    } finally {
      this.isChangingLayout = false
    }
  },

  async toolbarSavePNG() {
    const imageData = await graph.toDataURL({
      type: 'image/png',
    })

    const a = document.createElement('a')
    a.href = imageData
    a.download = `kubeview-${this.namespace}.png`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(imageData)
  },
}))

// Register sub child-components
Alpine.data('sidePanel', sidePanel)
Alpine.data('eventsDialog', eventsDialog)
Alpine.data('rolloutDialog', rolloutDialog)

// Initialize & start!
Alpine.start()
