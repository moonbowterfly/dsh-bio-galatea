/**
 * Integration protocol unit tests (dsh-bio-galatea).
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

/** 全就绪 fixture：MPNN 代码 + 权重、ESMFold 权重、输出目录。 */
function makeDataRoot() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'galatea-integration-'))
  mkdirSync(join(dataRoot, 'vendor', 'LigandMPNN'), { recursive: true })
  writeFileSync(join(dataRoot, 'vendor', 'LigandMPNN', 'run.py'), '# stub')
  mkdirSync(join(dataRoot, 'models', 'mpnn'), { recursive: true })
  writeFileSync(join(dataRoot, 'models', 'mpnn', 'proteinmpnn_v_48_020.pt'), 'x'.repeat(1024))
  writeFileSync(join(dataRoot, 'models', 'mpnn', 'solublempnn_v_48_020.pt'), 'y'.repeat(2048))
  mkdirSync(join(dataRoot, 'models', 'esmfold'), { recursive: true })
  writeFileSync(join(dataRoot, 'models', 'esmfold', 'model.safetensors'), 'z'.repeat(4096))
  mkdirSync(join(dataRoot, 'out'), { recursive: true })
  writeFileSync(join(dataRoot, 'out', 'run-1.json'), '{}')
  writeFileSync(join(dataRoot, 'out', 'run-2.json'), '{}')
  return dataRoot
}

await test('health exposes the frozen protocol identity without a runtime probe', async () => {
  assert.equal(typeof integration?.createIntegrationService, 'function')
  let runtimeProbes = 0
  const service = integration.createIntegrationService({
    probePython: async () => { runtimeProbes += 1; return { selected: null, candidates: [] } },
    probeAnalysis: async () => { runtimeProbes += 1; return null },
  })
  const response = await service.health()

  assert.deepEqual(response, {
    ok: true,
    value: {
      pluginId: 'dsh-bio-galatea',
      pluginVersion: '0.1.0',
      protocolMajor: 1,
      protocolMinors: [0],
      features: [
        'status',
        'capabilities',
        'weight-store',
        'outputs',
        'device-probe',
        'runtime-mpnn',
        'runtime-esmfold',
      ],
    },
  })
  assert.equal(runtimeProbes, 0)
})

await test('status reports the four required checks and bounded asset summaries', async () => {
  assert.equal(typeof integration?.createIntegrationService, 'function')
  const dataRoot = makeDataRoot()
  try {
    const service = integration.createIntegrationService({
      dataRoot,
      now: () => 1_700_000_000_000,
      probePython: async () => ({
        selected: { path: 'python', source: 'PATH', torchVersion: '2.14.0' },
        candidates: [{ path: 'python', source: 'PATH', exists: true }],
      }),
      probeAnalysis: async () => 'ok',
      probeDeviceFn: async () => ({ mode: 'cpu' }),
    })
    await service.status()
    await nextTurn()
    const response = await service.status()

    assert.equal(response.ok, true)
    assert.equal(response.value.state, 'ready')
    assert.deepEqual(response.value.checks.map((check) => [check.id, check.status]), [
      ['python.torch', 'ok'],
      ['runtime.analysis', 'ok'],
      ['runtime.mpnn', 'ok'],
      ['runtime.esmfold', 'ok'],
    ])
    assert.equal(response.value.data.weights.fileCount, 3)
    const mpnnComponent = response.value.data.weights.components
      .find((component) => component.component === 'mpnn')
    assert.equal(mpnnComponent.fileCount, 2)
    assert.equal(response.value.data.outputs.count, 2)
    assert.deepEqual(response.value.remediations, [])
    assert.ok(response.value.env.device)
  } finally {
    rmSync(dataRoot, { recursive: true, force: true })
  }
})

await test('status caches Python and analysis probes for sixty seconds', async () => {
  assert.equal(typeof integration?.createIntegrationService, 'function')
  let clock = 1_700_000_000_000
  let pythonProbes = 0
  let analysisProbes = 0
  const service = integration.createIntegrationService({
    now: () => clock,
    probePython: async () => {
      pythonProbes += 1
      // selected 非空 → readAnalysis 才会真正调用 probeAnalysis（无解释器时短路是设计行为）
      return { selected: { path: 'python', source: 'PATH', torchVersion: '2.14.0' }, candidates: [] }
    },
    probeAnalysis: async () => {
      analysisProbes += 1
      return 'ok'
    },
  })

  await service.status()
  await nextTurn()
  await service.status()
  assert.equal(pythonProbes, 1)
  assert.equal(analysisProbes, 1)

  clock += 60_001
  await service.status()
  assert.equal(pythonProbes, 2)
  assert.equal(analysisProbes, 2)
})

await test('degraded checks expose controlled remediation codes and a degraded state', async () => {
  assert.equal(typeof integration?.createIntegrationService, 'function')
  const dataRoot = mkdtempSync(join(tmpdir(), 'galatea-integration-empty-'))
  const prevHF = process.env.HF_HOME
  process.env.HF_HOME = join(dataRoot, 'no-hf')
  try {
    const service = integration.createIntegrationService({
      dataRoot,
      probePython: async () => ({ selected: null, candidates: [] }),
      probeAnalysis: async () => null,
    })
    await service.status()
    await nextTurn()
    const response = await service.status()

    assert.equal(response.value.state, 'degraded')
    assert.deepEqual(response.value.checks.map((check) => [check.id, check.status]), [
      ['python.torch', 'missing'],
      ['runtime.analysis', 'missing'],
      ['runtime.mpnn', 'missing'],
      ['runtime.esmfold', 'missing'],
    ])
    const codes = response.value.remediations.map((remediation) => remediation.code)
    assert.ok(codes.includes('galatea.setup-env'))
    assert.ok(codes.includes('galatea.setup-mpnn'))
    assert.ok(codes.includes('galatea.setup-esmfold'))
    assert.ok(response.value.remediations.every((remediation) => remediation.owner === 'galatea'))
  } finally {
    if (prevHF === undefined) delete process.env.HF_HOME
    else process.env.HF_HOME = prevHF
    rmSync(dataRoot, { recursive: true, force: true })
  }
})

await test('capabilities exposes the fourteen-tool manifest with dependency marking', async () => {
  assert.equal(typeof integration?.createIntegrationService, 'function')
  const dataRoot = mkdtempSync(join(tmpdir(), 'galatea-integration-caps-'))
  const prevHF = process.env.HF_HOME
  process.env.HF_HOME = join(dataRoot, 'no-hf')
  try {
    const service = integration.createIntegrationService({
      dataRoot,
      probePython: async () => ({ selected: null, candidates: [] }),
      probeAnalysis: async () => null,
    })
    await service.status()
    await nextTurn()
    const response = await service.capabilities()

    assert.equal(response.ok, true)
    assert.equal(response.value.plugin_id, 'dsh-bio-galatea')
    assert.equal(response.value.plugin_version, '0.1.0')
    assert.equal(response.value.tool_count, 14)
    assert.equal(response.value.tools.length, 14)
    const names = response.value.tools.map((tool) => tool.name)
    for (const expected of ['galatea_status', 'galatea_setup', 'galatea_mpnn', 'galatea_fold', 'galatea_interface', 'galatea_score', 'galatea_inspect', 'galatea_cluster', 'galatea_rank', 'galatea_rank_aggregate', 'galatea_loop', 'galatea_contact_consensus', 'galatea_redesign', 'galatea_refold']) {
      assert.ok(names.includes(expected), `missing tool ${expected}`)
    }
    // 缺依赖工具被标为 unavailable 并列出缺失项（python.torch 缺失 → mpnn/fold 不可用）
    const mpnn = response.value.tools.find((tool) => tool.name === 'galatea_mpnn')
    assert.equal(mpnn.status, 'unavailable')
    assert.ok(mpnn.missing_dependencies.includes('python.torch'))
  } finally {
    if (prevHF === undefined) delete process.env.HF_HOME
    else process.env.HF_HOME = prevHF
    rmSync(dataRoot, { recursive: true, force: true })
  }
})

await test('integration routes register three endpoints and reject non-loopback callers', async () => {
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
    service: integration.createIntegrationService({
      probePython: async () => ({ selected: null, candidates: [] }),
      probeAnalysis: async () => null,
    }),
  })
  try {
    assert.deepEqual(routes.map((route) => route.path), [
      '/api/dsh-bio-galatea/integration/health',
      '/api/dsh-bio-galatea/integration/v1/status',
      '/api/dsh-bio-galatea/integration/v1/capabilities',
    ])
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
      status: async () => { throw new Error('GALATEA_API_TOKEN=should-not-leak') },
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
