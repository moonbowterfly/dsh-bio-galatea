/**
 * Integration protocol unit tests.
 *
 * Run: node test/integration.js
 */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

let integration
try {
  integration = await import('../src/integration.js')
} catch {
  integration = null
}

let failed = 0

async function test(name, fn) {
  try {
    await fn()
    console.log(`✓ ${name}`)
  } catch (error) {
    failed += 1
    console.error(`✗ ${name}`)
    console.error(error.stack || error.message)
  }
}

function deferred() {
  let resolve
  let reject
  const promise = new Promise((nextResolve, nextReject) => {
    resolve = nextResolve
    reject = nextReject
  })
  return { promise, resolve, reject }
}

function nextTurn() {
  return new Promise((resolve) => setImmediate(resolve))
}

async function invokeRoute(handler, options = {}) {
  let status = null
  let headers = null
  let payload = null
  const req = {
    method: options.method ?? 'GET',
    socket: { remoteAddress: options.remoteAddress ?? '127.0.0.1' },
    headers: {
      host: options.host ?? '127.0.0.1:3080',
      ...(options.headers ?? {}),
    },
  }
  const res = {
    writeHead(nextStatus, nextHeaders) {
      status = nextStatus
      headers = nextHeaders
    },
    end(nextPayload) { payload = nextPayload },
  }
  await handler(req, res)
  return { status, headers, body: JSON.parse(payload) }
}

await test('health exposes the frozen protocol identity without a runtime probe', async () => {
  assert.equal(typeof integration?.createIntegrationService, 'function')
  let runtimeProbes = 0
  const service = integration.createIntegrationService({
    probePython: async () => { runtimeProbes += 1; return { selected: null, candidates: [] } },
    probeGapseq: async () => { runtimeProbes += 1; return { available: false } },
  })
  const response = await service.health()

  assert.deepEqual(response, {
    ok: true,
    value: {
      pluginId: 'dsh-bio-gem',
      pluginVersion: '0.1.12',
      protocolMajor: 1,
      protocolMinors: [0],
      features: [
        'status',
        'model-store',
        'ledger',
        'exports',
        'carveme-runtime',
        'gapseq-probe',
      ],
    },
  })
  assert.equal(runtimeProbes, 0)
})

await test('status reports the three required checks and bounded asset summaries', async () => {
  assert.equal(typeof integration?.createIntegrationService, 'function')
  const dataRoot = mkdtempSync(join(tmpdir(), 'gem-integration-'))
  try {
    mkdirSync(join(dataRoot, 'models'))
    mkdirSync(join(dataRoot, 'ledger'))
    mkdirSync(join(dataRoot, 'exports'))
    mkdirSync(join(dataRoot, 'venv-carveme', 'Scripts'), { recursive: true })
    writeFileSync(join(dataRoot, 'models', 'C58.xml'), '<sbml />')
    for (let index = 0; index < 50; index += 1) {
      writeFileSync(join(dataRoot, 'models', `extra-${index}.xml`), '<sbml />')
    }
    writeFileSync(join(dataRoot, 'ledger', 'C58.jsonl'), '{"prediction_id":"P0001"}\n')
    writeFileSync(join(dataRoot, 'exports', 'targets.json'), '[]')
    writeFileSync(join(dataRoot, 'venv-carveme', 'Scripts', 'carve.exe'), '')
    writeFileSync(join(dataRoot, 'venv-carveme', 'Scripts', 'diamond.exe'), '')

    const service = integration.createIntegrationService({
      dataRoot,
      now: () => 1_700_000_000_000,
      probePython: async () => ({
        selected: { path: 'python', source: 'PATH', cobraVersion: '0.32.1' },
        candidates: [{ path: 'python', source: 'PATH', exists: true }],
      }),
      probeGapseq: async () => ({ available: true, detail: 'gapseq 2.1.0' }),
    })
    const first = await service.status()
    const firstGapseq = first.value.checks.find((check) => check.id === 'runtime.gapseq')
    assert.equal(first.value.env.engines.gapseq.available, null)
    assert.equal(firstGapseq.status, 'warn')

    await nextTurn()
    const response = await service.status()

    assert.equal(response.ok, true)
    assert.equal(response.value.state, 'ready')
    assert.deepEqual(response.value.checks.map((check) => [check.id, check.status]), [
      ['python.cobra', 'ok'],
      ['runtime.carveme', 'ok'],
      ['runtime.gapseq', 'ok'],
    ])
    assert.equal(response.value.data.models.count, 51)
    assert.equal(response.value.data.models.items.length, 50)
    assert.equal(response.value.data.ledger.count, 1)
    assert.equal(response.value.data.ledger.totalEntries, 1)
    assert.equal(response.value.data.exports.count, 1)
    assert.deepEqual(response.value.env.python.selected, {
      path: 'python', source: 'PATH', cobraVersion: '0.32.1',
    })
    assert.equal(response.value.env.engines.carveme.available, true)
    assert.equal(response.value.env.engines.gapseq.available, true)
    assert.deepEqual(response.value.remediations, [])
  } finally {
    rmSync(dataRoot, { recursive: true, force: true })
  }
})

await test('status keeps Python cached for sixty seconds and successful gapseq cached longer', async () => {
  assert.equal(typeof integration?.createIntegrationService, 'function')
  let clock = 1_700_000_000_000
  let pythonProbes = 0
  let gapseqProbes = 0
  const service = integration.createIntegrationService({
    now: () => clock,
    probePython: async () => {
      pythonProbes += 1
      return { selected: null, candidates: [] }
    },
    probeGapseq: async () => {
      gapseqProbes += 1
      return { available: true, detail: 'available' }
    },
  })

  await service.status()
  await nextTurn()
  await service.status()
  assert.equal(pythonProbes, 1)
  assert.equal(gapseqProbes, 1)

  clock += 60_001
  await service.status()
  assert.equal(pythonProbes, 2)
  assert.equal(gapseqProbes, 1)
})

await test('degraded checks expose only controlled remediation codes and owners', async () => {
  assert.equal(typeof integration?.createIntegrationService, 'function')
  const dataRoot = mkdtempSync(join(tmpdir(), 'gem-integration-remediation-'))
  try {
    const service = integration.createIntegrationService({
      dataRoot,
      probePython: async () => ({ selected: null, candidates: [] }),
      probeGapseq: async () => ({ available: false, detail: 'not configured' }),
    })
    const response = await service.status()
    assert.equal(response.value.state, 'degraded')
    assert.deepEqual(response.value.remediations.map(({ code, owner }) => ({ code, owner })), [
      { code: 'genie.bootstrap-python', owner: 'genie' },
      { code: 'gem.install-carveme-runtime', owner: 'gem' },
      { code: 'genie.install-wsl-gapseq', owner: 'genie' },
    ])
  } finally {
    rmSync(dataRoot, { recursive: true, force: true })
  }
})

await test('status uses the ordered gem Python candidates to expose cobra availability', async () => {
  assert.equal(typeof integration?.createIntegrationService, 'function')
  const cobraCalls = []
  const service = integration.createIntegrationService({
    pythonCandidates: () => [
      { path: 'missing-python', source: 'GEM_PYTHON' },
      { path: 'usable-python', source: 'genie-hosted' },
    ],
    fileExists: (path) => path === 'usable-python',
    probeCobra: async (path) => {
      cobraCalls.push(path)
      return '0.32.1'
    },
    probeGapseq: async () => ({ available: true, detail: 'available' }),
  })

  const response = await service.status()
  assert.deepEqual(response.value.env.python.candidates, [
    { path: 'missing-python', source: 'GEM_PYTHON', exists: false },
    { path: 'usable-python', source: 'genie-hosted', exists: true },
  ])
  assert.deepEqual(response.value.env.python.selected, {
    path: 'usable-python', source: 'genie-hosted', cobraVersion: '0.32.1',
  })
  assert.deepEqual(cobraCalls, ['usable-python'])
})

await test('gapseq first status is probing and the fixed read-only command later parses its version', async () => {
  assert.equal(typeof integration?.createIntegrationService, 'function')
  const calls = []
  const longProbe = deferred()
  const service = integration.createIntegrationService({
    probePython: async () => ({ selected: null, candidates: [] }),
    isWindows: true,
    runGapseqProbe: (command, args) => {
      calls.push({ command, args })
      if (args[0] === '-l') return Promise.resolve({ ok: true, stdout: 'Ubuntu-22.04\n' })
      return longProbe.promise
    },
  })

  const first = await service.status()
  const firstCheck = first.value.checks.find((check) => check.id === 'runtime.gapseq')
  assert.equal(first.value.env.engines.gapseq.available, null)
  assert.equal(first.value.env.engines.gapseq.probing, true)
  assert.equal(firstCheck.status, 'warn')

  await nextTurn()
  assert.deepEqual(calls[0], { command: 'wsl.exe', args: ['-l', '-q'] })
  assert.equal(calls[1].command, 'wsl.exe')
  assert.deepEqual(calls[1].args.slice(0, 7), ['-d', 'Ubuntu-22.04', '-u', 'root', '--', 'bash', '-lc'])
  assert.match(calls[1].args[7], /gapseq -v/)
  assert.doesNotMatch(calls[1].args[7], /install|update|download/i)

  longProbe.resolve({ ok: true, stdout: 'gapseq version: 2.1.0' })
  await nextTurn()
  const settled = await service.status()
  const settledCheck = settled.value.checks.find((check) => check.id === 'runtime.gapseq')
  assert.equal(settled.value.env.engines.gapseq.available, true)
  assert.equal(settledCheck.status, 'ok')
  assert.match(settledCheck.detail, /2\.1\.0/)
})

await test('gapseq distro preflight does not start a long probe when no target distro exists', async () => {
  assert.equal(typeof integration?.createIntegrationService, 'function')
  const calls = []
  const service = integration.createIntegrationService({
    probePython: async () => ({ selected: null, candidates: [] }),
    isWindows: true,
    runGapseqProbe: async (command, args) => {
      calls.push({ command, args })
      return { ok: true, stdout: '' }
    },
  })

  await service.status()
  await nextTurn()
  assert.deepEqual(calls, [{ command: 'wsl.exe', args: ['-l', '-q'] }])
})

await test('failed gapseq probes use a sixty-second cooldown before an automatic retry', async () => {
  assert.equal(typeof integration?.createIntegrationService, 'function')
  let clock = 1_700_000_000_000
  let longProbeCalls = 0
  const service = integration.createIntegrationService({
    now: () => clock,
    probePython: async () => ({ selected: null, candidates: [] }),
    isWindows: true,
    runGapseqProbe: async (_command, args) => {
      if (args[0] === '-l') return { ok: true, stdout: 'Ubuntu-22.04\n' }
      longProbeCalls += 1
      return { ok: false, timeout: true, stdout: '' }
    },
  })

  const first = await service.status()
  assert.equal(first.value.env.engines.gapseq.available, null)
  await nextTurn()
  const failed = await service.status()
  assert.equal(failed.value.env.engines.gapseq.available, false)
  assert.equal(longProbeCalls, 1)

  clock += 59_999
  await service.status()
  await nextTurn()
  assert.equal(longProbeCalls, 1)

  clock += 2
  const stale = await service.status()
  assert.equal(stale.value.env.engines.gapseq.available, false)
  await nextTurn()
  assert.equal(longProbeCalls, 2)
})

await test('integration routes allow loopback health and reject non-loopback callers', async () => {
  assert.equal(typeof integration?.registerIntegrationRoutes, 'function')
  const routes = []
  const ctx = {
    webServer: {
      register(route) {
        routes.push(route)
        return () => routes.splice(routes.indexOf(route), 1)
      },
    },
  }
  const dispose = integration.registerIntegrationRoutes(ctx, {
    service: integration.createIntegrationService(),
  })
  try {
    const health = routes.find((route) => route.path.endsWith('/health'))
    assert.ok(health)
    const allowed = await invokeRoute(health.handler)
    assert.equal(allowed.status, 200)
    assert.equal(allowed.body.ok, true)

    const denied = await invokeRoute(health.handler, { remoteAddress: '203.0.113.7' })
    assert.equal(denied.status, 403)
    assert.deepEqual(denied.body, {
      ok: false,
      code: 'loopback-required',
      message: 'loopback requests only',
    })
  } finally {
    dispose()
  }
})

await test('status route returns a safe failure envelope when a probe fails', async () => {
  assert.equal(typeof integration?.registerIntegrationRoutes, 'function')
  const routes = []
  const ctx = { webServer: { register: (route) => { routes.push(route); return () => {} } } }
  const dispose = integration.registerIntegrationRoutes(ctx, {
    service: {
      health: async () => ({ ok: true, value: {} }),
      status: async () => { throw new Error('GEM_API_TOKEN=should-not-leak') },
    },
  })
  try {
    const status = routes.find((route) => route.path.endsWith('/v1/status'))
    let response
    try {
      response = await invokeRoute(status.handler)
    } catch (error) {
      response = { error }
    }
    assert.equal(response.status, 500)
    assert.deepEqual(response.body, {
      ok: false,
      code: 'internal',
      message: 'integration endpoint failed',
    })
    assert.doesNotMatch(JSON.stringify(response.body), /should-not-leak/)
  } finally {
    dispose()
  }
})

if (failed) process.exitCode = 1
