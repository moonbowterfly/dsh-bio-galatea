/**
 * Integration protocol unit tests (dsh-bio-galatea).
 *
 * Run: node test/integration.js
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const PACKAGE_VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version

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
      pluginVersion: PACKAGE_VERSION,
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

await test('capabilities exposes the nineteen-tool manifest with dependency marking', async () => {
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
    assert.equal(response.value.plugin_version, PACKAGE_VERSION)
    assert.equal(response.value.tool_count, 19)
    assert.equal(response.value.tools.length, 19)
    const names = response.value.tools.map((tool) => tool.name)
    for (const expected of ['galatea_status', 'galatea_setup', 'galatea_mpnn', 'galatea_fold', 'galatea_interface', 'galatea_score', 'galatea_inspect', 'galatea_cluster', 'galatea_rank', 'galatea_rank_aggregate', 'galatea_loop', 'galatea_contact_consensus', 'galatea_contact_cluster', 'galatea_redesign', 'galatea_refold', 'galatea_ingest', 'galatea_portfolio', 'galatea_budget']) {
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

const PYTHON_DIR = fileURLToPath(new URL('../python/', import.meta.url))
const PRIVATE_PYTHON = join(homedir(), '.dsh', 'dsh-bio-galatea', 'venv',
  process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
const CONDA_PYTHON = process.env.CONDA_PREFIX && join(process.env.CONDA_PREFIX,
  process.platform === 'win32' ? 'python.exe' : 'bin/python')
const SCORE_PYTHON = [process.env.GALATEA_PYTHON, PRIVATE_PYTHON, CONDA_PYTHON]
  .find((path) => path && existsSync(path)) ?? (process.platform === 'win32' ? 'python.exe' : 'python3')

function checkSequenceAnalysis(source) {
  const result = spawnSync(SCORE_PYTHON, ['-B', '-I', '-c', `
import sys
sys.path.insert(0, sys.argv[1])
from seq_analysis import score_sequences, _low_complexity
HIGH_RISK = 'TGIPAVIQVLEQQLAAAEALLAQLEAQLAAAEAASGGDDDTNGNNNNDNNPAGVFSMLIIKVLSEIALLKKRLKVLKAKI'
PASSED = 'EKSLVEKALEEAYKLFEEILPELVKLSPHEAYETIKKKFTELAKKVPFSEEEYYEFMAKVIVLEWEAWVKVMEEKAKE'
${source}
`, PYTHON_DIR], { encoding: 'utf8', timeout: 30_000, windowsHide: true })
  assert.ifError(result.error)
  assert.equal(result.status, 0, result.stderr || result.stdout)
}

await test('low complexity: CH01 rejected=true / passed=false with measured entropy', () => {
  checkSequenceAnalysis(`
high, passed = [row['low_complexity'] for row in score_sequences([HIGH_RISK, PASSED])['scores']]
# 20 aa calibration: rejected minimum 1.6814963295296753 bits (15-34),
# passed minimum 2.7414460711655213 bits (59-78); longest runs 4 / 3.
assert high['flagged'] is True and passed['flagged'] is False
assert high['min_entropy_bits'] == 1.681496
assert passed['min_entropy_bits'] == 2.741446
assert high['max_run'] == 4 and passed['max_run'] == 3
assert len(high['windows']) == 7 and passed['windows'] == []
assert high['runs'] == [] and passed['runs'] == []
assert {'start': 15, 'end': 34, 'entropy_bits': 1.681496} in high['windows']
`)
})

await test('low complexity: homopolymer, clean, short and exact threshold boundaries', () => {
  checkSequenceAnalysis(`
same, clean, short, six, single = [row['low_complexity'] for row in score_sequences(
    ['A' * 20, 'ACDEFGHIKLMNPQRSTVWY', 'ACD', 'AAAAAA', 'A'])['scores']]
assert same['flagged'] is True and same['min_entropy_bits'] == 0.0
assert same['windows'] == [{'start': 1, 'end': 20, 'entropy_bits': 0.0}]
assert same['runs'] == [{'start': 1, 'end': 20, 'residue': 'A', 'length': 20}]
assert clean['flagged'] is False and clean['min_entropy_bits'] == 4.321928
assert clean['windows'] == [] and clean['runs'] == []
assert short['flagged'] is False and short['min_entropy_bits'] is None
assert short['windows'] == [] and short['runs'] == []
assert six['flagged'] is True and six['windows'] == []
assert six['runs'] == [{'start': 1, 'end': 6, 'residue': 'A', 'length': 6}]
assert single['flagged'] is False and single['min_entropy_bits'] is None
assert _low_complexity('AAAAA')['flagged'] is False
assert _low_complexity('ACDE' * 5)['min_entropy_bits'] == 2.0
assert _low_complexity('ACDE' * 5)['flagged'] is False  # strict H < 2.0
assert _low_complexity('ACDE' * 5, entropy_threshold=2.01)['flagged'] is True
assert _low_complexity('AAAAA', run_threshold=5)['flagged'] is True
assert _low_complexity('AAAAAA', run_threshold=7)['flagged'] is False
assert _low_complexity('AA', window=2)['flagged'] is True
`)
})

await test('score sequences: frozen legacy fields and invalid-input behavior remain unchanged', () => {
  checkSequenceAnalysis(`
# Exact score snapshots from the clean master@61c4fea baseline.
expected = [
    {'index': 0, 'length': 80, 'pI': 4.85, 'net_charge_pH74': -2.8,
     'gravy': 0.186, 'aromaticity': 0.013, 'molecular_weight_kda': 8.31,
     'cys_count': 0, 'hydrophobic_moment_h18': 0.599,
     'aggregation': {'max_hydrophobic_run': 4, 'max_window7_eisenberg': 0.936, 'risk_score': 0.557}},
    {'index': 1, 'length': 78, 'pI': 4.93, 'net_charge_pH74': -6.32,
     'gravy': -0.45, 'aromaticity': 0.128, 'molecular_weight_kda': 9.34,
     'cys_count': 0, 'hydrophobic_moment_h18': 0.369,
     'aggregation': {'max_hydrophobic_run': 4, 'max_window7_eisenberg': 0.641, 'risk_score': 0.434}},
]
result = score_sequences([HIGH_RISK, PASSED])
assert set(result) == {'scores', 'note'}
for row in result['scores']:
    assert 'low_complexity' in row
    del row['low_complexity']
assert result['scores'] == expected
assert result['note'] == ('pI/净电荷/GRAVY 由 Biopython ProtParam 计算；疏水矩为 Eisenberg 标度滑窗实现；'
                          '聚集倾向为显式启发式代理（非 AGGRESCAN/TANGO），只用其阈值判读（低<0.35/中0.35-0.55/高>0.55）。')
assert score_sequences(['', 'xxx!?'])['scores'] == [
    {'index': i, 'error': 'no valid residues（非标准字符已剔除后为空）'} for i in range(2)]
assert score_sequences([])['scores'] == []
assert score_sequences([' ac d!? ']) == score_sequences(['ACD'])
`)
})

await test('score op: JSON bridge exposes low complexity for both CH01 cases', () => {
  checkSequenceAnalysis(`
import json
import subprocess
from pathlib import Path
request = {'op': 'score', 'args': {'sequences': [HIGH_RISK, PASSED]}}
process = subprocess.run([sys.executable, '-B', '-I', str(Path(sys.argv[1]) / 'galatea_ops.py')],
                         input=json.dumps(request), text=True, encoding='utf-8', capture_output=True, check=True)
assert 'Traceback' not in process.stderr, process.stderr
response = json.loads(process.stdout.strip().splitlines()[-1])
assert response == {'ok': True, 'result': score_sequences([HIGH_RISK, PASSED])}
`)
})

if (failed) process.exitCode = 1
