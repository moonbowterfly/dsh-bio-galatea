// run-galatea-pytest.mjs — 用 galatea 运行时候选解释器跑一个 Python 测试文件，
// 退出码透传（测试失败 → 非零退出，形成闸门）。
// 说明：GL-1/GL-3/GL-2 定向测试只需 biopython/标准库，不依赖 torch，
//       故按 pythonCandidates() 顺序选第一个能 import Bio 的解释器（同步探测），
//       不触发 src/python.js 的异步 torch 探测。
// 用法：node test/run-galatea-pytest.mjs test/test_gl1_hydrophobic_moment.py
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { existsSync } from 'node:fs'
import { pythonCandidates } from '../src/python.js'

const testFile = process.argv[2]
if (!testFile) {
  console.error('usage: node test/run-galatea-pytest.mjs <test.py>')
  process.exit(2)
}
const repo = join(dirname(fileURLToPath(import.meta.url)), '..')
const abs = join(repo, testFile)

function hasBio(exe) {
  try {
    const r = spawnSync(exe, ['-I', '-c', 'import Bio'], { timeout: 30_000, windowsHide: true, stdio: 'ignore' })
    return r.status === 0
  } catch {
    return false
  }
}

let exe = null
for (const c of pythonCandidates()) {
  if (!c.path) continue
  if (c.path !== 'python' && !existsSync(c.path)) continue
  if (hasBio(c.path)) { exe = c.path; break }
}
if (!exe) {
  console.error('[run-galatea-pytest] 找不到可 import Bio 的解释器')
  process.exit(2)
}

const r = spawnSync(exe, ['-I', '-B', abs], {
  cwd: repo, stdio: 'inherit',
  env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
})
if (r.status !== 0) {
  console.error(`\n[run-galatea-pytest] ${testFile} FAILED (interpreter=${exe}, exit=${r.status})`)
  process.exit(r.status ?? 1)
}
console.log(`\n[run-galatea-pytest] ${testFile} PASS (interpreter=${exe})`)
