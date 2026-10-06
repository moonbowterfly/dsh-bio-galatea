import assert from 'node:assert/strict'
import { register } from 'node:module'

register('./dsh-tools-loader.mjs', import.meta.url)
const { registerTools, SETUP_ACTION_TIMEOUT_MS, SETUP_REGISTRATION_TIMEOUT_MS } =
  await import('../src/tools.js')
const tools = []
registerTools({ tools: { register(tool) { tools.push(tool); return () => {} } } })

const setup = tools.find((tool) => tool.name === 'galatea_setup')
assert.ok(setup, 'galatea_setup must be registered')
// Python 子步骤的最坏预算：env 600+1500+900s，mpnn 600+3×900s，esmfold 3000s。
assert.ok(SETUP_ACTION_TIMEOUT_MS.env > 3_000_000)
assert.ok(SETUP_ACTION_TIMEOUT_MS.mpnn > 3_300_000)
assert.ok(SETUP_ACTION_TIMEOUT_MS.esmfold > 3_000_000)
assert.ok(SETUP_ACTION_TIMEOUT_MS.all > 9_300_000)
assert.equal(setup.timeoutMs, SETUP_REGISTRATION_TIMEOUT_MS)
assert.ok(setup.timeoutMs >= SETUP_ACTION_TIMEOUT_MS.all + 60_000,
  `registered timeout ${setup.timeoutMs}ms is shorter than setup execution`)
console.log(`galatea_setup registered timeout: ${setup.timeoutMs}ms`)
