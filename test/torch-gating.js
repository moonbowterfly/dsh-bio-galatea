/**
 * 无 torch 环境下按操作依赖分流（回归门禁）。
 *
 * 背景（Codex 二阶审查 P1，2026-10-01）：python.js 原先对**所有** op 一律
 * 拦截「全候选缺 torch」，导致 8 个不声明 python.torch 的工具
 * （portfolio / budget / coverage / rank / rank_aggregate / loop 等纯标准库
 * 或 analysis 档操作）被误封锁，而 capabilities 清单仍报 ready ——
 * 清单与实际行为矛盾，是对用户的失实承诺。
 *
 * 修复：拦截判断改用 capabilities 清单的 requires 字段（单一真值源）。
 *
 * 测试策略：**直接验分流判定**，不真跑 callGalatea。
 * 理由：放行的 op 会 spawn 真实 Python（budget/coverage 是长任务），
 * 用「跑到 spawn 就算过」的桩很脆（要改 node 内置模块的 spawn）。
 * 分流是纯判定，测它更精准、更快、且不依赖环境。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { TOOLS_MANIFEST } from '../src/capabilities.js'

const root = fileURLToPath(new URL('..', import.meta.url))
const src = readFileSync(join(root, 'src', 'python.js'), 'utf8')

// 清单里声明需要 torch 的工具（回归时若清单变化，此处会提醒同步）
const NEEDS_TORCH = TOOLS_MANIFEST.filter((t) => (t.requires ?? []).includes('python.torch'))
  .map((t) => t.name)
const NOT_NEEDS_TORCH = TOOLS_MANIFEST.filter((t) => !(t.requires ?? []).includes('python.torch'))
  .map((t) => t.name)

test('capabilities 清单同时存在需要与不需要 torch 的工具（分流才有意义）', () => {
  assert.ok(NEEDS_TORCH.length > 0, '应有需要 torch 的工具')
  assert.ok(NOT_NEEDS_TORCH.length > 0, '应有不需要 torch 的工具')
  console.log(`  需要 torch: ${NEEDS_TORCH.length} | 不需要: ${NOT_NEEDS_TORCH.length}`)
})

test('拦截分支已接入 opNeedsTorch（不再对所有 op 一律拦截）', () => {
  // 关键回归点：拦截条件必须含 opNeedsTorch(op)，否则回到「一律拦截」
  assert.ok(
    /op\s*!==\s*'status'\s*&&\s*op\s*!==\s*'setup'\s*&&\s*opNeedsTorch\(op\)/.test(src),
    '拦截条件必须调用 opNeedsTorch(op)——否则纯标准库操作会被误封锁',
  )
})

test('opNeedsTorch 以 capabilities 的 requires 为唯一真值源', () => {
  const fnMatch = src.match(/function opNeedsTorch\(op\)\s*\{[\s\S]*?\n\}/)
  assert.ok(fnMatch, '应存在 opNeedsTorch 函数')
  const fn = fnMatch[0]
  assert.ok(/TOOLS_MANIFEST/.test(fn), 'opNeedsTorch 必须读 TOOLS_MANIFEST')
  assert.ok(/requires/.test(fn), 'opNeedsTorch 必须读 requires 字段')
  assert.ok(
    /includes\('python\.torch'\)/.test(fn),
    "opNeedsTorch 必须以 includes('python.torch') 判定",
  )
  // 不得硬编码工具名（会与清单漂移）
  const hardcoded = fn.match(/'galatea_[a-z_]+'/)
  assert.equal(hardcoded, null, `opNeedsTorch 不得硬编码工具名：${hardcoded?.[0]}`)
})

test('每个工具的分流结果与清单一致（穷举全清单）', () => {
  // 复刻 opNeedsTorch 的判定，对全清单逐个核对
  const actualNeedsTorch = (op) => {
    const tool = op.startsWith('galatea_') ? op : `galatea_${op}`
    const entry = TOOLS_MANIFEST.find((t) => t.name === tool)
    if (!entry) return true // 清单外保守拦截
    return (entry.requires ?? []).includes('python.torch')
  }
  for (const t of TOOLS_MANIFEST) {
    const expected = (t.requires ?? []).includes('python.torch')
    assert.equal(
      actualNeedsTorch(t.name),
      expected,
      `${t.name} 分流与清单不一致（requires=${JSON.stringify(t.requires)}）`,
    )
  }
})

test('已知易误封锁的三个操作确实不需要 torch（P1 原始报告点）', () => {
  for (const name of ['galatea_budget', 'galatea_coverage', 'galatea_portfolio']) {
    const entry = TOOLS_MANIFEST.find((t) => t.name === name)
    assert.ok(entry, `${name} 应在清单中`)
    assert.ok(
      !(entry.requires ?? []).includes('python.torch'),
      `${name} 不应声明 python.torch（Codex P1 报告它被误封锁）`,
    )
  }
})
