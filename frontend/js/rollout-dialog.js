//@ts-check
/// <reference path="./types/custom.d.ts" />

// ==========================================================================================
// Declarative Deployment rollout: dry-run preview followed by a separate apply confirmation.
// The parent Alpine component supplies namespace, config, and rollout capability.
// ==========================================================================================

export default () => ({
  manifest: `apiVersion: apps/v1
kind: Deployment
metadata:
  name: example
spec:
  replicas: 1
  selector:
    matchLabels:
      app: example
  template:
    metadata:
      labels:
        app: example
    spec:
      containers:
        - name: example
          image: nginx:stable
`,
  preview: '',
  previewManifest: '',
  previewNamespace: '',
  result: '',
  error: '',
  busy: false,
  confirmApply: false,
  revision: 0,
  /** @type {AbortController | null} */
  controller: null,

  init() {
    this.$watch('manifest', () => this.invalidatePreview())
    this.$watch('namespace', () => this.invalidatePreview())
    this.$watch('cfg.refreshMode', () => {
      if (this.cfg.refreshMode === 'offline') this.invalidatePreview()
    })
    this.$watch('rolloutsEnabled', () => this.invalidatePreview())
    this.$watch('showRolloutDialog', (open) => {
      if (!open) this.invalidatePreview()
    })
  },

  get canPreview() {
    return !!(this.rolloutsEnabled && this.namespace && this.cfg.refreshMode !== 'offline' && this.manifest.trim() && !this.busy)
  },

  get canApply() {
    return !!(this.canPreview && this.preview && this.previewManifest === this.manifest && this.previewNamespace === this.namespace)
  },

  invalidatePreview() {
    this.revision++
    this.controller?.abort()
    this.controller = null
    this.busy = false
    this.preview = ''
    this.previewManifest = ''
    this.previewNamespace = ''
    this.confirmApply = false
    this.error = ''
    this.result = ''
  },

  /**
   * @param {boolean} dryRun
   */
  async submit(dryRun) {
    if (dryRun ? !this.canPreview : !this.canApply || !this.confirmApply) return

    const manifest = this.manifest
    const namespace = this.namespace
    const revision = this.revision
    const controller = new AbortController()
    this.controller = controller
    this.busy = true
    this.error = ''
    this.result = ''
    if (dryRun) {
      this.preview = ''
      this.confirmApply = false
    }

    try {
      const response = await fetch(`api/rollout/${encodeURIComponent(namespace)}?dryRun=${dryRun}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ manifest }),
        signal: controller.signal,
      })
      const text = await response.text()
      let data
      try {
        data = JSON.parse(text)
      } catch {
        throw new Error(`Invalid server response (HTTP ${response.status})`)
      }
      if (!response.ok) throw new Error(data.detail || data.title || `HTTP ${response.status}: ${response.statusText}`)
      if (controller.signal.aborted || revision !== this.revision || namespace !== this.namespace || manifest !== this.manifest) return
      const deployment = data?.deployment || data
      if (!deployment || deployment.kind !== 'Deployment' || !deployment.metadata?.name) {
        throw new Error('The server did not return a Deployment object')
      }

      if (dryRun) {
        this.preview = JSON.stringify(deployment, null, 2)
        this.previewManifest = manifest
        this.previewNamespace = namespace
        this.confirmApply = false
      } else {
        this.preview = ''
        this.confirmApply = false
        this.result = JSON.stringify(deployment, null, 2)
      }
    } catch (err) {
      if (!controller.signal.aborted && revision === this.revision) {
        this.error = err.message
        console.error('💥 Deployment rollout failed:', err)
      }
    } finally {
      if (revision === this.revision) {
        this.busy = false
        this.controller = null
      }
    }
  },
})
