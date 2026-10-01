import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import { callGalatea, createPythonResolver, probeTorchAsync } from '../src/python.js'

test('first calls report probing immediately and share one lazy probe; ready cache is synchronous', async () => {
  let probes = 0
  let finishProbe
  const resolver = createPythonResolver({
    candidateProvider: () => ['mock-python'],
    fileExists: () => true,
    probeTorch: () => {
      probes += 1
      return new Promise((resolve) => { finishProbe = resolve })
    },
  })

  assert.equal(probes, 0, 'module/factory creation must not probe')
  const first = await callGalatea('fold', {}, { resolver })
  const concurrent = await callGalatea('score', {}, { resolver })
  assert.equal(first.ok, false)
  assert.equal(first.code, 'PYTHON_PROBE_PENDING')
  assert.equal(first.state, 'probing')
  assert.equal(first.retry_after_ms, 1_000)
  assert.equal(first._provenance.tool, 'galatea_fold')
  assert.equal(concurrent.code, 'PYTHON_PROBE_PENDING')
  assert.equal(probes, 0, 'pending response must be delivered before probing starts')
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(probes, 1, 'concurrent first calls must not repeat import torch')

  finishProbe(true)
  await resolver.whenSettled()
  assert.equal(resolver.pythonExe(), 'mock-python')
  assert.equal(resolver.pythonExe(), 'mock-python')
  assert.equal(probes, 1, 'cache hits must not probe again')
})

test('all candidates failing gives a structured install hint and caches the missing state', async () => {
  const tried = []
  const resolver = createPythonResolver({
    candidateProvider: () => ['first-python', 'second-python', 'python'],
    fileExists: () => true,
    probeTorch: async (exe) => { tried.push(exe); return false },
  })

  assert.equal((await callGalatea('mpnn', {}, { resolver })).code, 'PYTHON_PROBE_PENDING')
  await resolver.whenSettled()
  const missing = await callGalatea('mpnn', {}, { resolver })
  assert.equal(missing.ok, false)
  assert.equal(missing.code, 'PYTHON_TORCH_MISSING')
  assert.equal(missing.state, 'missing')
  assert.deepEqual(missing.missing_dependencies, ['python.torch'])
  assert.match(missing.install_hint, /galatea_setup\(action="env"\)/)
  assert.equal(missing._provenance.tool, 'galatea_mpnn')
  assert.deepEqual(tried, ['first-python', 'second-python', 'python'])
  assert.throws(() => resolver.pythonExe(), { code: 'PYTHON_TORCH_MISSING' })
  assert.deepEqual(tried, ['first-python', 'second-python', 'python'], 'missing state must be cached')
})

test('asynchronous probe times out without blocking the event loop', async () => {
  const child = new EventEmitter()
  let killed = 0
  child.kill = () => { killed += 1 }
  const result = probeTorchAsync('mock-python', {
    spawnProcess: (_exe, args, options) => {
      assert.deepEqual(args, ['-I', '-c', 'import torch'])
      assert.equal(options.windowsHide, true)
      return child
    },
    timeoutMs: 10,
  })
  let tickRan = false
  await new Promise((resolve) => setImmediate(() => { tickRan = true; resolve() }))
  assert.equal(tickRan, true)
  assert.equal(await result, false)
  assert.equal(killed, 1)
})

test('invalidate prevents an old in-flight probe from overwriting a new result', async () => {
  const finishes = []
  const resolver = createPythonResolver({
    candidateProvider: () => ['mock-python'],
    fileExists: () => true,
    probeTorch: () => new Promise((resolve) => { finishes.push(resolve) }),
  })
  assert.throws(() => resolver.pythonExe(), { code: 'PYTHON_PROBE_PENDING' })
  await new Promise((resolve) => setImmediate(resolve))
  resolver.invalidate()
  assert.throws(() => resolver.pythonExe(), { code: 'PYTHON_PROBE_PENDING' })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(finishes.length, 2)
  finishes[1](true)
  await resolver.whenSettled()
  finishes[0](false)
  await Promise.resolve()
  assert.equal(resolver.pythonExe(), 'mock-python')
})
