//@ts-check
/// <reference path="./types/custom.d.ts" />

// ==========================================================================================
// Event streaming for Kubernetes resources
// Handles SSE events from the server and updates the graph accordingly
// These are *not* the same as Kubernetes events, which are handled in events-dialog.js
// ==========================================================================================
import { layout, removeResource, addResource, updateResource } from './graph.js'
import { getConfig } from './config.js'

let state = 'connecting' // 'connecting', 'connected', 'disconnected', 'paused'
/** @type {EventSource | null} */
let updateStream = null
// Module state is unique even when a duplicated tab inherits browser storage.
const clientID =
  globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`

/**
 * Get the client ID shared by fetch requests and SSE for this page runtime only.
 * @returns {string} The client ID
 */
export function getClientId() {
  return clientID
}

/**
 * Set up the event streaming connection to receive live updates
 * from the server for Kubernetes resources
 */
export function initEventStreaming() {
  if (updateStream) return

  console.log('🌐 Opening event stream...')
  const stream = new EventSource(`updates?clientID=${encodeURIComponent(getClientId())}`, {})
  updateStream = stream
  state = 'connecting'
  notifyStateChange()

  // Handle resource add events from the server
  stream.addEventListener('add', async function (event) {
    if (updateStream !== stream) return

    /** @type {Resource} */
    let res
    try {
      res = JSON.parse(event.data)
    } catch (err) {
      console.error('💥 Error parsing event data:', err)
      return
    }

    if (getConfig().debug) console.log('⬆️ Add resource:', res.kind, res.metadata.name)

    addResource(res)
    await layout()
  })

  // Handle resource delete events from the server
  stream.addEventListener('delete', async function (event) {
    if (updateStream !== stream) return

    /** @type {Resource} */
    let res
    try {
      res = JSON.parse(event.data)
    } catch (err) {
      console.error('💥 Error parsing event data:', err)
      return
    }

    if (getConfig().debug) console.log('☠️ Delete resource:', res.kind, res.metadata.name)

    removeResource(res)
    await layout()
  })

  // Handle resource update events from the server
  stream.addEventListener('update', async function (event) {
    if (updateStream !== stream) return

    /** @type {Resource} */
    let res
    try {
      res = JSON.parse(event.data)
    } catch (err) {
      console.error('💥 Error parsing event data:', err)
      return
    }

    if (getConfig().debug) console.log('⬆️ Update resource:', res.kind, res.metadata.name)

    await updateResource(res)
    if (updateStream !== stream) return

    await layout()
  })

  // Notify when the stream is connected
  stream.onopen = function () {
    if (updateStream !== stream) return
    console.log('✅ Event stream ready:', stream.readyState === 1)

    if (stream.readyState === 1) {
      state = 'connected'
    }

    notifyStateChange()
  }

  stream.onerror = function (event) {
    if (updateStream !== stream) return
    console.error('‼️ Event stream error:', event)
    state = 'disconnected'
    notifyStateChange()
  }
}

/**
 * Close the stream, including its automatic reconnect attempts.
 */
export function stopEventStreaming() {
  const stream = updateStream
  updateStream = null
  stream?.close()
  state = 'paused'
  notifyStateChange()
}

function notifyStateChange() {
  const stateEvent = new CustomEvent('connectionStateChange', {
    detail: { state },
  })

  window.dispatchEvent(stateEvent)
}
