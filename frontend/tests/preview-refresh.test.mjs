import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { createContext, SourceTextModule } from 'node:vm'

async function preview({ enabled = true, search = '?preview=1', hostname = '127.0.0.1' } = {}) {
  const timers = new Map()
  let reloads = 0
  let safe = true
  let editing = false
  const module = new SourceTextModule(await readFile(new URL('../js/preview-refresh.js', import.meta.url), 'utf8'), {
    context: createContext({
      URLSearchParams,
      window: { location: { search, hostname, reload: () => reloads++ } },
      document: { activeElement: { closest: () => editing } },
      setInterval: (callback, delay) => { timers.set(1, { callback, delay }); return 1 },
      clearInterval: (id) => timers.delete(id),
    }),
  })
  await module.link(() => assert.fail('Unexpected preview import'))
  await module.evaluate()
  const stop = module.namespace.startPreviewRefresh(enabled, () => safe)
  return {
    timers, stop,
    reloads: () => reloads,
    setSafe: (value) => { safe = value },
    setEditing: (value) => { editing = value },
  }
}

test('preview reload requires server development mode, an explicit query opt-in, and loopback', async () => {
  for (const options of [{ enabled: false }, { search: '' }, { search: '?preview=0' }, { hostname: 'example.test' }]) {
    const app = await preview(options)
    assert.equal(app.timers.size, 0)
    app.stop()
  }
})

test('preview reload uses 30 seconds, pauses while unsafe or editing, and can be stopped', async () => {
  const app = await preview()
  assert.equal(app.timers.size, 1)
  const { callback, delay } = app.timers.get(1)
  assert.equal(delay, 30000)
  app.setSafe(false)
  callback()
  app.setSafe(true)
  app.setEditing(true)
  callback()
  assert.equal(app.reloads(), 0)
  app.setEditing(false)
  callback()
  assert.equal(app.reloads(), 1)
  app.stop()
  assert.equal(app.timers.size, 0)
})
