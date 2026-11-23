//@ts-check
/// <reference path="./types/custom.d.ts" />

// ==========================================================================================
// Client-side configuration management for KubeView using local storage
// ==========================================================================================

/** @type {Config | null}*/
let config = null

/** @type {{ value: EdgeStyle, label: string }[]} */
export const edgeStyles = [
  { value: 'line', label: 'straight' },
  { value: 'polyline', label: 'polyline' },
  { value: 'quadratic', label: 'quadratic curve' },
  { value: 'cubic', label: 'cubic curve' },
  { value: 'cubic-horizontal', label: 'horizontal curve' },
  { value: 'cubic-vertical', label: 'vertical curve' },
]

/** @type {Config}*/
const defaultConfig = {
  theme: 'dark',
  whiteBackground: true,
  edgeStyle: 'cubic-vertical',
  refreshMode: 'live',
  debug: false,
  shortenNames: true,
  spacing: 100,
  hideEmptyReplicaSets: false,
  resFilter: [
    'Pod',
    'Deployment',
    'ReplicaSet',
    'StatefulSet',
    'DaemonSet',
    'Job',
    'CronJob',
    'Service',
    'Ingress',
    // 'ConfigMap',
    // 'PersistentVolumeClaim',
    // 'HorizontalPodAutoscaler',
  ],
}

/**
 * Gets the configuration object from local storage.
 * @returns {Config} The configuration object.
 */
export function getConfig() {
  if (config !== null) return config

  // Set the default client ID to a random value
  if (!localStorage.getItem('kubeviewConfig')) {
    localStorage.setItem('kubeviewConfig', JSON.stringify(defaultConfig))

    config = defaultConfig
    return config
  }

  // Get the config from local storage
  const cfg = JSON.parse(localStorage.getItem('kubeviewConfig') || 'null')
  config = {
    ...defaultConfig,
    ...cfg,
  }
  // Offline only lasts for this page session, so reloading can always fetch initial data.
  if (!['live', 'manual', '15s', '1m'].includes(config.refreshMode)) config.refreshMode = 'manual'
  if (!edgeStyles.some(({ value }) => value === config?.edgeStyle)) {
    console.error('💥 Unsupported saved edge style:', config.edgeStyle)
    config.edgeStyle = defaultConfig.edgeStyle
  }
  return config || defaultConfig
}

/**
 * Save the configuration object to local storage
 * @param {Config} newConfig
 */
export async function saveConfig(newConfig) {
  // Weird bug where spacing is a string instead of a number
  newConfig.spacing = parseInt(`${newConfig.spacing}`) || 100

  // Set the config in local storage
  localStorage.setItem('kubeviewConfig', JSON.stringify(newConfig))
  config = newConfig
}
