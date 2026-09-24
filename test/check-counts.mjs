/**
 * check-counts.mjs — 文档-代码计数一致性检查（防「改一处漏三处」）。
 *
 * 真值来源（不硬编码）：
 *   工具数 = src/capabilities.js 的 TOOLS_MANIFEST.length（单源）
 *   op 数  = python/galatea_ops.py 的 OPS 注册数（"x": op_x 字面量 + OPS["x"]= 赋值，去重）
 *
 * 断言各处文档声称与真值一致；「没找到」报 WARN（显式化，不静默通过）。
 * Run: node test/check-counts.mjs
 */
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TOOLS_MANIFEST } from '../src/capabilities.js'

const ROOT = join(fileURLToPath(import.meta.url), '..', '..')

function read(p) {
  return existsSync(join(ROOT, p)) ? readFileSync(join(ROOT, p), 'utf8') : ''
}

// ---- 真值 ----
const toolCount = TOOLS_MANIFEST.length

const opsSrc = read('python/galatea_ops.py')
const opsNames = new Set([
  ...[...opsSrc.matchAll(/^\s*"([a-z0-9_]+)":\s*op_/gm)].map((m) => m[1]),   // OPS = { "x": op_x, ... }
  ...[...opsSrc.matchAll(/OPS\["([a-z0-9_]+)"\]\s*=/g)].map((m) => m[1]),      // OPS["x"] = op_x
])
const opCount = opsNames.size

console.log('代码实证真值：')
console.log(`  语义化工具 = ${toolCount}（capabilities.js TOOLS_MANIFEST）`)
console.log(`  op 数      = ${opCount}（galatea_ops.py OPS 注册）`)
console.log()

let pass = 0
let fail = 0
let warned = 0
let skipped = 0

function assertCount(file, re, truth, label) {
  const txt = read(file)
  if (!txt) {
    console.log(`SKIP  ${label}（文件不存在: ${file}）`)
    skipped += 1
    return
  }
  const found = [...txt.matchAll(re)].map((m) => Number(m[1]))
  const uniq = [...new Set(found)]
  if (uniq.length === 0) {
    console.log(`WARN  ${label}：${file} 未出现该计数表述（本项检查未覆盖，非通过）`)
    warned += 1
    return
  }
  const bad = uniq.filter((n) => n !== truth)
  if (bad.length === 0) {
    console.log(`PASS  ${label}：出现 [${uniq.join(', ')}]，与真值 ${truth} 一致`)
    pass += 1
  } else {
    console.log(`FAIL  ${label}：出现 [${uniq.join(', ')}]，其中 ${bad.join(', ')} ≠ 真值 ${truth}`)
    fail += 1
  }
}

// ---- 断言点（工具数） ----
assertCount('README.md', /收拢为 \*\*(\d+) 个语义化工具\*\*/g, toolCount, 'README 工具数（收拢为 N 个语义化工具）')
assertCount('README.md', /## (\d+) 个工具一览/g, toolCount, 'README 工具一览标题')
assertCount('docs/ARCHITECTURE.md', /(\d+) 语义化工具（`defineTool`）/g, toolCount, 'ARCHITECTURE tools.js 工具数')
assertCount('docs/ARCHITECTURE.md', /工具 \/ op 对照（(\d+) 工具/g, toolCount, 'ARCHITECTURE 工具/op 对照（工具数）')
assertCount('src/index.js', /（(\d+) 语义化工具：/g, toolCount, 'index.js 头注释工具数')
assertCount('src/tools.js', /工具层（defineTool 注册，(\d+) 语义化工具/g, toolCount, 'tools.js 头注释工具数')
assertCount('skills/galatea-expert.md', /｜ (\d+) 工具：/g, toolCount, 'galatea-expert skill 工具数')

// ---- 断言点（op 数与一致性） ----
assertCount('docs/ARCHITECTURE.md', /工具 \/ op 对照（\d+ 工具 = (\d+) op）/g, opCount, 'ARCHITECTURE 工具/op 对照（op 数）')

// 工具数 = op 数（1:1 对照设计约束；双方真值直接比较）
if (toolCount !== opCount) {
  console.log(`FAIL  工具数（${toolCount}）≠ op 数（${opCount}）——1:1 对照设计被破坏`)
  fail += 1
} else {
  console.log(`PASS  工具数（${toolCount}）与 op 数（${opCount}）1:1 对照一致`)
  pass += 1
}

console.log()
console.log(`check-counts: ${pass} pass / ${fail} fail / ${warned} warn / ${skipped} skip`)
if (fail > 0) process.exitCode = 1
