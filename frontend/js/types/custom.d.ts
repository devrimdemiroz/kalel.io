// Whoa wait, what is a TypeScript file doing in a JavaScript project?
// This is a workaround to allow TypeScript to understand the types used in the JavaScript code.
// VSCode will use this file to provide type checking & intellisense via JSDoc comments. Neat eh?

declare type ResNode = {
  id: string
  style: {
    src: string
    labelText: string
    labelFill: string
    visibility: 'visible' | 'hidden'
    badges: Array<{ text: string; placement: string; offsetY: number }>
  }
  data: {
    kind: string
    ip: string | null
    filterVisible: boolean
  }
}

declare type EdgeStyle = 'line' | 'polyline' | 'quadratic' | 'cubic' | 'cubic-horizontal' | 'cubic-vertical'

declare type ContainerNode = {
  id: string
  combo?: string | null
  style?: { visibility?: string; x?: number; y?: number }
}

declare type ComponentIdentity = {
  key: string
  label: string
  supporting: boolean
}

declare type ComponentCombo = {
  id: string
  combo?: string
  style: {
    labelText: string
    stroke: string
    fill?: string
    fillOpacity: number
    strokeOpacity: number
    labelOpacity: number
    lineDash?: number[]
    padding: number[]
  }
}

declare type Config = {
  theme: 'dark' | 'light'
  whiteBackground: boolean
  edgeStyle: EdgeStyle
  refreshMode: 'live' | 'manual' | 'offline' | '15s' | '1m'
  debug: boolean
  shortenNames: boolean
  resFilter: string[]
  spacing: number
  hideEmptyReplicaSets: boolean
}

// Represents a generic Kubernetes resource
// See all those `any` down there, yeah, I know, but I'm not mapping every single field of every single k8s resource
declare type Resource = {
  kind: string
  metadata: {
    uid: string
    name: string
    namespace: string
    creationTimestamp: string
    deletionTimestamp: string | null
    labels: Record<string, string>
    annotations: Record<string, string>
    ownerReferences: Array<{
      uid: string
    }>
  }
  spec: any
  status: any
  subsets?: any // Only on Endpoints
  endpoints?: any // Only on EndpointSlices
  ports?: Array<{ port?: number | null; protocol?: string }> // Only on EndpointSlices
  data?: any // For Secret and ConfigMap
}

declare type EventResource = {
  lastTimestamp: string
  eventTime: string
  message: string
  reason: string
  count: number
  metadata: {
    creationTimestamp: string
  }
}

declare type PanelData = {
  id: string
  kind: string
  icon: string
  props: Record<string, string>
  containers: Record<string, any>
  labels: Record<string, string>
  annotations: Record<string, string>
}
