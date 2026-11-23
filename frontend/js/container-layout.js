//@ts-check
/// <reference path="./types/custom.d.ts" />

// ==========================================================================================
// Metadata-driven component groups with translucent layers and organic hulls
// ==========================================================================================

const ROOT = 'kubeview:containers'
const supportComponents = new Set([
  'nats',
  'prometheus',
  'postgres',
  'postgresql',
  'redis',
  'kafka',
  'rabbitmq',
  'mysql',
  'mariadb',
  'elasticsearch',
  'opensearch',
  'grafana',
  'loki',
  'tempo',
  'jaeger',
])

/**
 * @param {ContainerNode[]} nodes
 * @param {Resource[]} resources
 * @param {'light' | 'dark'} theme
 * @returns {{nodes: ContainerNode[], combos: ComponentCombo[]}}
 */
export function buildContainers(nodes, resources, theme) {
  const byId = new Map(resources.map((res) => [res.metadata.uid, res]))
  /** @type {Map<string, ComponentIdentity | null>} */
  const identities = new Map()
  const visiting = new Set()

  /**
   * @param {Resource} res
   * @returns {ComponentIdentity | null}
   */
  function identity(res) {
    const { uid, namespace = '', labels = {} } = res.metadata
    if (identities.has(uid)) return identities.get(uid)
    if (visiting.has(uid)) return null
    visiting.add(uid)
    /** @type {ComponentIdentity | null} */
    let result = null
    for (const owner of res.metadata.ownerReferences || []) {
      const parent = byId.get(owner.uid)
      if (parent) result = identity(parent)
      if (result) break
    }

    if (!result) {
      const app = labels['app.kubernetes.io/name'] || labels.app || labels['cnpg.io/cluster']
      const component = labels['app.kubernetes.io/component'] || labels.component || ''
      const instance = labels['app.kubernetes.io/instance'] || ''
      if (app || component) {
        const parts = [namespace, instance, app || '', component]
        const tokens = `${app || ''} ${component}`.toLowerCase().split(/[^a-z0-9]+/)
        result = {
          key: JSON.stringify(parts),
          label: [...new Set([instance, app, component].filter(Boolean))].join(' / '),
          supporting: Boolean(labels['cnpg.io/cluster']) || tokens.some((token) => supportComponents.has(token)),
        }
      }
    }
    visiting.delete(uid)
    identities.set(uid, result)
    return result
  }

  for (const res of resources) identity(res)

  // Services without application labels can still join the component selected by their pods.
  for (const res of resources) {
    if (identities.get(res.metadata.uid) || res.kind !== 'Service') continue
    const selector = Object.entries(res.spec?.selector || {})
    if (!selector.length) continue
    const matches = resources
      .filter(
        (pod) =>
          pod.kind === 'Pod' &&
          pod.metadata.namespace === res.metadata.namespace &&
          selector.every(([key, value]) => pod.metadata.labels?.[key] === value),
      )
      .map((pod) => identities.get(pod.metadata.uid))
    const keys = new Set(matches.map((match) => match?.key))
    if (keys.size === 1 && matches[0]) identities.set(res.metadata.uid, matches[0])
  }

  /** @type {Map<string, {label: string, supporting: boolean, nodes: ContainerNode[]}>} */
  const groups = new Map()
  for (const node of nodes) {
    if (node.style?.visibility === 'hidden') continue
    const group = identities.get(node.id) || { key: 'unmapped', label: 'Other resources (unmapped)', supporting: false }
    if (!groups.has(group.key)) groups.set(group.key, { ...group, nodes: [] })
    groups.get(group.key).nodes.push(node)
  }

  const dark = theme === 'dark'
  const layerFill = dark ? '#ffffff' : '#000000'
  /** @type {ComponentCombo[]} */
  const combos = []
  /** @type {Map<string, ContainerNode>} */
  const positioned = new Map()
  const columns = [false, true]
  if (groups.size) {
    combos.push({
      id: ROOT,
      style: {
        labelText: 'Kubernetes namespace - experimental containers',
        stroke: dark ? '#9aa8be' : '#68788e',
        fill: layerFill,
        fillOpacity: 0.012,
        strokeOpacity: 0.28,
        labelOpacity: 1,
        lineDash: [10, 8],
        padding: [85, 45, 45, 45],
      },
    })
  }
  for (const [column, supporting] of columns.entries()) {
    const columnId = `${ROOT}:${column}`
    const entries = [...groups.entries()].filter(([, group]) => group.supporting === supporting)
    entries.sort(([a], [b]) => a.localeCompare(b))
    if (!entries.length) continue
    combos.push({
      id: columnId,
      combo: ROOT,
      style: {
        labelText: supporting ? 'Supporting services' : 'Application components',
        fill: layerFill,
        fillOpacity: 0.018,
        strokeOpacity: 0.22,
        labelOpacity: 1,
        stroke: dark ? '#536179' : '#c1cbd9',
        padding: [75, 30, 30, 30],
      },
    })
    for (const [key, group] of entries) {
      const id = `${ROOT}:component:${key}`
      group.nodes.sort((a, b) => a.id.localeCompare(b.id))
      combos.push({
        id,
        combo: columnId,
        style: {
          labelText: group.label,
          fill: layerFill,
          fillOpacity: 0,
          strokeOpacity: 0,
          labelOpacity: 0,
          stroke: dark ? '#a8b2c4' : '#666666',
          padding: [110, 95, 95, 95],
        },
      })
      for (const node of group.nodes) {
        positioned.set(node.id, {
          id: node.id,
          combo: id,
        })
      }
    }
  }

  return {
    nodes: nodes.map((node) => positioned.get(node.id) || { id: node.id, combo: null }),
    combos,
  }
}

/**
 * Synchronize membership before drawing, without replacing nodes, edges or their selection state.
 * @param {any} graph
 * @param {Resource[]} resources
 * @param {Config} cfg
 */
export function syncContainers(graph, resources, cfg) {
  const next = buildContainers(graph.getNodeData(), resources, cfg.whiteBackground ? 'light' : cfg.theme)
  const existing = new Set(graph.getComboData().map((combo) => combo.id))
  graph.addComboData(next.combos.filter((combo) => !existing.has(combo.id)))
  graph.updateComboData(next.combos.filter((combo) => existing.has(combo.id)))
  graph.updateNodeData(next.nodes)
  const retained = new Set(next.combos.map((combo) => combo.id))
  // Detach nodes before deleting stale containers: G6 removes a combo's descendants too.
  graph.removeComboData([...existing].filter((id) => !retained.has(id)))
  graph.setPlugins([
    ...(graph.getOptions().plugins || []).filter((plugin) => !plugin.key?.startsWith(`${ROOT}:hull:`)),
    ...next.combos.filter((combo) => combo.id.startsWith(`${ROOT}:component:`)).map((combo) => ({
      type: 'hull',
      key: `${ROOT}:hull:${combo.id}`,
      members: next.nodes.filter((node) => node.combo === combo.id).map((node) => node.id),
      corner: 'smooth',
      concavity: 2,
      padding: Math.min(Math.max(55, cfg.spacing / 2), 90),
      fill: combo.style.fill,
      fillOpacity: 0.035,
      pointerEvents: 'none',
      zIndex: -1,
      stroke: combo.style.stroke,
      strokeOpacity: 0.65,
      lineWidth: 1.5,
      labelText: combo.style.labelText,
      labelFill: cfg.whiteBackground || cfg.theme === 'light' ? '#242a38' : '#ffffff',
      labelFontSize: 18,
      labelBackground: false,
      labelPlacement: 'top',
      labelOpacity: 1,
    })),
  ])
}

/** @param {any} graph */
export function drawContainerHulls(graph) {
  for (const plugin of graph.getOptions().plugins || []) {
    if (plugin.key?.startsWith(`${ROOT}:hull:`)) graph.getPluginInstance(plugin.key).drawHull()
  }
}

/** @param {any} graph */
export function clearContainers(graph) {
  graph.setPlugins((plugins) => plugins.filter((plugin) => !plugin.key?.startsWith(`${ROOT}:hull:`)))
  graph.updateNodeData(graph.getNodeData().map((node) => ({ id: node.id, combo: null })))
  graph.removeComboData(graph.getComboData().map((combo) => combo.id))
}
