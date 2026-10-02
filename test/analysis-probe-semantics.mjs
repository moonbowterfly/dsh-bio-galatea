/**
 * 探测失败 ≠ 依赖缺失（runtime.analysis 语义契约）。
 *
 * probeAnalysisDeps 的 spawn 失败 / 解释器异常退出 / 20s 超时 / 同步抛异常
 * 原本都归为 null，collectChecks 再把 null 判成 missing 并断言
 * "biopython / numpy 缺失"——把"判不出来"说成"确认缺失"。gapseq 一侧
 * 同类判断已在 gem 里先落地为 warn（"探测进行中"），此处与之对齐。
 *
 * 变异锚点：把 'probe-failed' 改回 null，或把 warn 改回 missing，本测试必须报红。
 */
import assert from 'node:assert/strict'
import { createIntegrationService } from '../src/integration.js'
import { buildCapabilitiesReport } from '../src/capabilities.js'

const ALL_IDS = ['python.torch', 'runtime.analysis', 'runtime.mpnn', 'runtime.esmfold']

function statusOf(checks, id) {
  return checks.find((c) => c.id === id)
}

/** 用注入的解释器与探针构造一次 status 快照。 */
async function probe({ python, analysis }) {
  const service = createIntegrationService({
    pythonCandidates: () => [{ path: python }],
    fileExists: () => true,
    probePython: async () => ({
      selected: { path: python, torchVersion: '2.9.0' },
      candidates: [],
      diagnostics: [],
    }),
    probeAnalysis: analysis,
    probeDeviceFn: async () => ({ device: 'cpu', torchDevice: 'cpu' }),
  })
  return (await service.status()).value
}

let passed = 0
async function test(name, run) {
  await run()
  passed += 1
  console.log(`  ok   ${name}`)
}

await test('探针抛异常 → runtime.analysis 为 warn 且不谎报缺失', async () => {
  const value = await probe({
    python: 'C:/fake/python.exe',
    analysis: async () => { throw new Error('模拟探针崩溃') },
  })
  const check = statusOf(value.checks, 'runtime.analysis')
  assert.equal(check.status, 'warn')
  assert.doesNotMatch(check.detail, /biopython \/ numpy 缺失/)
  assert.match(check.detail, /探测未完成/)
  // torch 探针成功，不应连坐成 degraded 之外的更严重状态
  assert.equal(statusOf(value.checks, 'python.torch').status, 'ok')
  // 有 warn 即 degraded（域可用但非就绪），不是 ready 也不是不可用
  assert.equal(value.state, 'degraded')
})

await test('探针回传 null（旧版形态）→ 归一为 probe-failed，不当作缺失', async () => {
  const value = await probe({
    python: 'C:/fake/python.exe',
    analysis: async () => null,
  })
  const check = statusOf(value.checks, 'runtime.analysis')
  assert.equal(check.status, 'warn')
  assert.doesNotMatch(check.detail, /biopython \/ numpy 缺失/)
})

await test('解释器确实缺依赖 → 保持 missing（原语义不被削弱）', async () => {
  const value = await probe({
    python: 'C:/fake/python.exe',
    analysis: async () => 'missing',
  })
  const check = statusOf(value.checks, 'runtime.analysis')
  assert.equal(check.status, 'missing')
  assert.match(check.detail, /biopython \/ numpy 缺失/)
})

await test('依赖就绪 → ok（零误报）', async () => {
  const value = await probe({
    python: 'C:/fake/python.exe',
    analysis: async () => 'ok',
  })
  const check = statusOf(value.checks, 'runtime.analysis')
  assert.equal(check.status, 'ok')
  assert.match(check.detail, /biopython 与 numpy 可用/)
})

await test('capabilities：warn 不得被折成 unavailable', () => {
  const warnChecks = ALL_IDS.map((id) => ({
    id,
    status: id === 'runtime.analysis' ? 'warn' : 'ok',
  }))
  const report = buildCapabilitiesReport({ pluginVersion: '0.0.0', checks: warnChecks })
  const iface = report.tools.find((tool) => tool.name === 'galatea_interface')
  assert.equal(iface.status, 'unknown')
  const fold = report.tools.find((tool) => tool.name === 'galatea_fold')
  assert.equal(fold.status, 'ready', '不依赖 analysis 的工具不应被连坐')
})

await test('capabilities：确认 missing 仍是 unavailable', () => {
  const missingChecks = ALL_IDS.map((id) => ({
    id,
    status: id === 'runtime.analysis' ? 'missing' : 'ok',
  }))
  const report = buildCapabilitiesReport({ pluginVersion: '0.0.0', checks: missingChecks })
  const iface = report.tools.find((tool) => tool.name === 'galatea_interface')
  assert.equal(iface.status, 'unavailable')
})

await test('capabilities：全 ok 无新增 unknown / unavailable', () => {
  const okChecks = ALL_IDS.map((id) => ({ id, status: 'ok' }))
  const report = buildCapabilitiesReport({ pluginVersion: '0.0.0', checks: okChecks })
  const bad = report.tools.filter((t) => t.status === 'unknown' || t.status === 'unavailable')
  assert.deepEqual(bad, [], `不应有降级工具：${bad.map((t) => t.name).join(', ')}`)
})

console.log(`analysis-probe-semantics: ${passed} passed, 0 failed`)