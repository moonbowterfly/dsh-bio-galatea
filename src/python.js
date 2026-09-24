// python.js — dsh-bio-galatea Python 子进程调用器（JSON stdin 协议）
// bridge 契约同 dsh-bio-genie / dsh-bio-gem：stdout 最后一行是 JSON；stderr 含
// "Traceback (most recent call last)" 头 = 代码级失败（恒 ok:true 时靠它判定）。
import { spawn, spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'
import os from 'node:os'

const PYTHON_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'python')

/**
 * 候选解释器，按优先级（**通用化，不写死任何本机路径**）：
 *
 *   1. `GALATEA_PYTHON`        — 用户显式指定，最高优先级
 *   2. galatea 私有自举环境      — `$DSH_HOME/dsh-bio-galatea/venv`
 *      `galatea setup` 自举（uv venv + torch/transformers/biopython）——**推荐路径**：
 *      本插件的重量级依赖（torch）与用户环境隔离，不污染系统 Python。
 *   3. 宿主插件自举环境          — `$DSH_HOME/dsh-bio-genie/python-env`
 *      genie 环境若恰好含 torch（用户自行安装过）也可复用。
 *   4. `CONDA_PREFIX`          — 当前激活的 conda 环境（通用信号，非硬编码路径）
 *   5. `python`                — PATH 兜底
 *
 * 探测标准 = `import torch` 可执行（本插件全部计算工具的共同硬依赖）。
 * 命中仅代表「Python 数值栈可用」；细分组件（transformers / MPNN 权重 /
 * ESMFold 权重）由 galatea_status / galatea_setup 管理，缺失时给出可执行的修复指引。
 */
export function pythonCandidates() {
  const list = []
  if (process.env.GALATEA_PYTHON) list.push({ path: process.env.GALATEA_PYTHON, source: 'GALATEA_PYTHON' })

  const dshHome = process.env.DSH_HOME ?? join(os.homedir(), '.dsh')
  const privateVenv = join(dshHome, 'dsh-bio-galatea', 'venv')
  list.push({
    path: process.platform === 'win32'
      ? join(privateVenv, 'Scripts', 'python.exe')
      : join(privateVenv, 'bin', 'python'),
    source: 'galatea-private',
  })

  const hosted = join(dshHome, 'dsh-bio-genie', 'python-env')
  list.push({
    path: process.platform === 'win32'
      ? join(hosted, 'Scripts', 'python.exe')
      : join(hosted, 'bin', 'python'),
    source: 'genie-hosted',
  })

  if (process.env.CONDA_PREFIX) {
    list.push({
      path: process.platform === 'win32'
        ? join(process.env.CONDA_PREFIX, 'python.exe')
        : join(process.env.CONDA_PREFIX, 'bin', 'python'),
      source: 'CONDA_PREFIX',
    })
  }

  list.push({ path: 'python', source: 'PATH' })
  return list
}

function candidates() {
  return pythonCandidates().map((candidate) => candidate.path)
}

/** torch 是本插件全部计算工具的共同硬依赖：探测解释器能否 import torch。 */
function hasTorch(exe) {
  try {
    const r = spawnSync(exe, ['-I', '-c', 'import torch'], {
      timeout: 30_000, windowsHide: true, stdio: 'ignore',
    })
    return r.status === 0
  } catch {
    return false
  }
}

let cachedExe = null

/**
 * 选定解释器（进程内缓存）。
 *
 * 不做「路径存在即采用」的浅判断——落在一个没有 torch 的解释器上时，
 * 工具只会抛 ModuleNotFoundError 而用户无从判断该装到哪里。这里逐个探测
 * `import torch`，让选择结果可解释（可视化由宿主面板 + galatea_status 承担）。
 *
 * 注：刻意不在插件加载期调用本函数（探测有秒级开销，会拖慢宿主启动）。
 */
export function pythonExe() {
  if (cachedExe) return cachedExe
  for (const c of candidates()) {
    if (!c) continue
    if (c !== 'python' && !existsSync(c)) continue
    if (hasTorch(c)) {
      cachedExe = c
      return c
    }
  }
  cachedExe = 'python'
  return cachedExe
}

/** op 名 → 对外工具名（v0.1 全部同名；保留映射层以便后续特殊命名）。 */
const OP_TOOL = {}

function toolNameFor(op) {
  return OP_TOOL[op] ?? `galatea_${op}`
}

/**
 * 与 dsh-bio-genie 的溯源契约对齐：工具输出挂 `_provenance` 背书字段。
 *
 * genie 侧的计算防火墙台账据此与回复里的数值声明对账；统一在**唯一出口**
 * （callGalatea）盖章，避免逐个工具遗漏。不改动已有 _provenance（幂等）。
 */
export function stampProvenance(tool, value) {
  if (value && typeof value === 'object' && !Array.isArray(value) && value._provenance === undefined) {
    value._provenance = { tool, at: new Date().toISOString() }
  }
  return value
}

/** 调用 galatea_ops.py（op 协议）：{op, args} -> result；异常/代码级失败抛 Error。 */
export function callGalatea(op, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const py = pythonExe()
    const script = join(PYTHON_DIR, 'galatea_ops.py')
    const cp = spawn(py, ['-I', script], { cwd: PYTHON_DIR, windowsHide: true })
    let out = ''
    let err = ''
    cp.stdout.on('data', (d) => { out += d })
    cp.stderr.on('data', (d) => { err += d })
    cp.on('error', (e) => reject(new Error(`python spawn failed (${py}): ${e.message}`)))
    const timer = opts.timeoutMs
      ? setTimeout(() => { cp.kill(); reject(new Error(`galatea op ${op} timeout after ${opts.timeoutMs}ms`)) }, opts.timeoutMs)
      : null
    cp.on('close', (code) => {
      if (timer) clearTimeout(timer)
      const lines = out.trim().split(/\r?\n/).filter(Boolean)
      if (!lines.length) {
        return reject(new Error(`galatea_ops.py produced no output (op=${op}, python=${py}); stderr: ${err.slice(-400)}`))
      }
      if (err.includes('Traceback (most recent call last)')) {
        return reject(new Error(`galatea op ${op} code-level failure: ${err.slice(-400)}`))
      }
      let parsed
      try {
        parsed = JSON.parse(lines[lines.length - 1])
      } catch (e) {
        return reject(new Error(`galatea op ${op} bad JSON: ${lines[lines.length - 1].slice(0, 300)}`))
      }
      if (parsed.ok === false) return reject(new Error(parsed.error || `galatea op ${op} failed (ok:false)`))
      // setup 可能创建/更新私有 venv——使解释器选择缓存失效，下一次调用重新探测
      if (op === 'setup') cachedExe = null
      resolve(stampProvenance(toolNameFor(op), parsed.result))
    })
    cp.stdin.write(JSON.stringify({ op, args }))
    cp.stdin.end()
  })
}

export { PYTHON_DIR }
