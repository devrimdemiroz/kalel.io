//@ts-check
/// <reference path="./types/custom.d.ts" />

// ==========================================================================================
// Opt-in local development reloads; never interrupt editing or an offline/rollout session.
// ==========================================================================================

/**
 * @param {boolean} enabled Development capability advertised by the server.
 * @param {() => boolean} canReload Whether application state is safe to reload.
 * @returns {() => void} Stop the preview timer.
 */
export function startPreviewRefresh(enabled, canReload) {
  if (!enabled || new URLSearchParams(window.location.search).get('preview') !== '1') return () => {}
  if (!['localhost', '127.0.0.1', '[::1]'].includes(window.location.hostname)) return () => {}

  const timer = setInterval(() => {
    if (!canReload() || document.activeElement?.closest('input, textarea, select, [contenteditable="true"]')) return
    window.location.reload()
  }, 30000)

  return () => clearInterval(timer)
}
