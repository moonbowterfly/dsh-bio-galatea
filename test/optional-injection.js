/**
 * Verify that optional webServer support never blocks gem tool registration.
 *
 * Run: node --import ./test/register-dsh-tools.mjs test/optional-injection.js
 */
import assert from 'node:assert/strict'

const plugin = await import('../src/index.js')

assert.deepEqual(plugin.inject, ['tools', 'skills'])

let toolRegistrations = 0
let skillRegistrations = 0
const routes = []
let dynamicInjection = null
const ctx = {
  tools: { register: () => { toolRegistrations += 1; return () => {} } },
  skills: { register: () => { skillRegistrations += 1; return () => {} } },
  inject: (deps, callback) => {
    dynamicInjection = { deps, callback }
    return () => {}
  },
}

const originalSetTimeout = globalThis.setTimeout
const originalClearTimeout = globalThis.clearTimeout
const scheduled = []
const cleared = []
globalThis.setTimeout = (callback, delay) => {
  const timer = { callback, delay }
  scheduled.push(timer)
  return timer
}
globalThis.clearTimeout = (timer) => { cleared.push(timer) }

try {
  plugin.apply(ctx)
  assert.equal(toolRegistrations, 10)
  assert.equal(skillRegistrations, 1)
  assert.equal(routes.length, 0)
  assert.deepEqual(dynamicInjection?.deps, ['webServer'])

  const disposers = []
  const webCtx = {
    webServer: {
      register: (route) => {
        routes.push(route)
        return () => routes.splice(routes.indexOf(route), 1)
      },
    },
    effect: (callback) => {
      const dispose = callback()
      if (typeof dispose === 'function') disposers.push(dispose)
      return dispose
    },
  }
  dynamicInjection.callback(webCtx)
  assert.deepEqual(routes.map((route) => route.path), [
    '/api/dsh-bio-galatea/integration/health',
    '/api/dsh-bio-galatea/integration/v1/status',
    '/api/dsh-bio-galatea/integration/v1/capabilities',
  ])
  assert.deepEqual(scheduled.map((timer) => timer.delay), [8_000])

  disposers.at(-1)()
  assert.deepEqual(cleared, [scheduled[0]])
} finally {
  globalThis.setTimeout = originalSetTimeout
  globalThis.clearTimeout = originalClearTimeout
}

console.log('✓ dynamic webServer injection leaves all 10 galatea tools active')
