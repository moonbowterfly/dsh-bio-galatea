/**
 * check-capabilities.mjs — 强制 capabilities.js 的 TOOLS_MANIFEST 与 tools.js 真实注册集合一致。
 *
 * 这是「工具数变化需同步 ≥12 处」工程债的机器门：MANIFEST 是 integration API（/v1/capabilities）
 * 与 genie 宿主消费的单源，一旦漂移（新增工具漏登记 / 删除工具留幽灵），本脚本报红。
 *
 * Run: node --import ./test/register-dsh-tools.mjs test/check-capabilities.mjs
 */
import assert from 'node:assert/strict'
import { TOOLS_MANIFEST } from '../src/capabilities.js'

const plugin = await import('../src/index.js')

const registered = []
const ctx = {
  tools: { register: (def) => { registered.push(def.name); return () => {} } },
  skills: { register: () => () => {} },
  inject: () => () => {},
}

const originalSetTimeout = globalThis.setTimeout
const originalClearTimeout = globalThis.clearTimeout
globalThis.setTimeout = () => ({ mockTimer: true })
globalThis.clearTimeout = () => {}

try {
  plugin.apply(ctx)
} finally {
  globalThis.setTimeout = originalSetTimeout
  globalThis.clearTimeout = originalClearTimeout
}

const manifestNames = TOOLS_MANIFEST.map((t) => t.name)
const regSet = new Set(registered)
const manSet = new Set(manifestNames)

const missingInManifest = [...regSet].filter((n) => !manSet.has(n))
const phantomInManifest = [...manSet].filter((n) => !regSet.has(n))
const duplicates = manifestNames.filter((n, i) => manifestNames.indexOf(n) !== i)

console.log(`registered tools: ${registered.length} | manifest entries: ${manifestNames.length}`)
if (missingInManifest.length) console.log('  registered but NOT in manifest:', missingInManifest)
if (phantomInManifest.length) console.log('  in manifest but NOT registered:', phantomInManifest)
if (duplicates.length) console.log('  duplicate manifest entries:', duplicates)

assert.equal(missingInManifest.length, 0,
  `工具已注册但未登记进 capabilities.js：${missingInManifest.join(', ')}`)
assert.equal(phantomInManifest.length, 0,
  `capabilities.js 有幽灵条目（无对应注册工具）：${phantomInManifest.join(', ')}`)
assert.equal(duplicates.length, 0, `capabilities.js 重复条目：${duplicates.join(', ')}`)

// 元数据完整性（枚举值合法性）
const COST = new Set(['light', 'medium', 'heavy'])
const NET = new Set(['none', 'optional', 'required'])
const MUT = new Set(['read_only', 'writes_output', 'model_mutating'])
const STATUS = new Set(['ready', 'experimental', 'data-not-initialized'])
for (const t of TOOLS_MANIFEST) {
  for (const k of ['capability', 'category', 'cost_class', 'network', 'mutability', 'summary', 'status']) {
    assert.ok(t[k], `${t.name}: 缺字段 ${k}`)
  }
  assert.ok(COST.has(t.cost_class), `${t.name}: cost_class 非法值 ${t.cost_class}`)
  assert.ok(NET.has(t.network), `${t.name}: network 非法值 ${t.network}`)
  assert.ok(MUT.has(t.mutability), `${t.name}: mutability 非法值 ${t.mutability}`)
  assert.ok(STATUS.has(t.status), `${t.name}: status 非法值 ${t.status}`)
  assert.ok(t.capability.startsWith('gem.'), `${t.name}: capability 应以 gem. 前缀（${t.capability}）`)
}

console.log(`✓ capabilities manifest 与 ${registered.length} 个注册工具一致（含元数据枚举校验）`)
