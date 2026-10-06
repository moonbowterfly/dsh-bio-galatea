// python.js — dsh-bio-galatea Python 子进程调用器（JSON stdin 协议）
// bridge 契约同 dsh-bio-genie / dsh-bio-gem：stdout 最后一行是 JSON；stderr 含
// "Traceback (most recent call last)" 头 = 代码级失败（恒 ok:true 时靠它判定）。
import { spawn, spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { access } from 'node:fs/promises'
import os from 'node:os'
import { TOOLS_MANIFEST } from './capabilities.js'

const PYTHON_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'python')

/** Abort/timeout 时终止整个 Python 子进程树，避免 setup 的下载器继续写盘。 */
export function terminateProcessTree(child) {
  if (!child.pid || child.exitCode !== null) return
  if (process.platform === 'win32') {
    const taskkill = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe')
    const result = spawnSync(taskkill, ['/PID', String(child.pid), '/T', '/F'], {
      windowsHide: true, encoding: 'utf8', timeout: 10_000,
    })
    if (result.error || result.status !== 0) {
      throw new Error(`taskkill failed for PID ${child.pid}: ${result.error?.message
        ?? (result.stderr || result.stdout || `exit ${result.status}`).trim().slice(0, 300)}`)
    }
    return
  }
  process.kill(-child.pid, 'SIGTERM')
}

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

const TORCH_PROBE_TIMEOUT_MS = 30_000
const PROBE_PENDING = 'PYTHON_PROBE_PENDING'
const TORCH_MISSING = 'PYTHON_TORCH_MISSING'
// 导出供测试断言「缺 torch 时哪些操作被拦截、哪些放行」——见 test/torch-gating.js
export { TORCH_MISSING as TORCH_MISSING_CODE }
const TORCH_INSTALL_HINT = '运行 galatea_setup(action="env") 安装私有 Python/torch 环境（成功后自动重探）；若手动安装或修改 GALATEA_PYTHON，请重启 dsh 后再调用 galatea_status 检查。'

async function fileExistsAsync(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

/** 单候选 import torch 探测；超时立即判失败并继续下一个候选，不阻塞 Node 主线程。 */
export function probeTorchAsync(exe, { spawnProcess = spawn, timeoutMs = TORCH_PROBE_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    let child
    let timer
    let settled = false
    const finish = (ok) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolve(ok)
    }
    try {
      child = spawnProcess(exe, ['-I', '-c', 'import torch'], {
        windowsHide: true, stdio: 'ignore',
      })
      child.once('error', () => finish(false))
      child.once('close', (code) => finish(code === 0))
      timer = setTimeout(() => {
        try { child.kill() } catch { /* process may have exited */ }
        finish(false)
      }, timeoutMs)
    } catch {
      finish(false)
    }
  })
}

/**
 * 惰性、单飞的解释器选择。同步读取已就绪的缓存；首次请求只启动异步探测并
 * 返回可识别的状态错误。setup 成功后 generation 失效旧探测，避免旧结果覆写新环境。
 */
export function createPythonResolver({
  candidateProvider = candidates,
  fileExists = fileExistsAsync,
  probeTorch = probeTorchAsync,
} = {}) {
  let cachedExe = null
  let state = 'idle'
  let generation = 0
  let pending = null

  function startProbe() {
    if (state !== 'idle') return
    state = 'probing'
    const currentGeneration = generation
    // 放到下一事件循环轮次：调用方先收到“探测中”，也不在插件加载期预热。
    pending = new Promise((resolve) => setImmediate(resolve)).then(async () => {
      for (const exe of candidateProvider()) {
        if (!exe) continue
        try {
          if (exe !== 'python' && !(await fileExists(exe))) continue
          if (await probeTorch(exe)) return exe
        } catch { /* 一个候选失败不影响后续候选 */ }
      }
      return null
    }).then((exe) => {
      if (generation !== currentGeneration) return
      cachedExe = exe
      state = exe ? 'ready' : 'missing'
    }).catch(() => {
      if (generation === currentGeneration) state = 'missing'
    }).finally(() => {
      if (generation === currentGeneration) pending = null
    })
  }

  return {
    pythonExe() {
      if (cachedExe) return cachedExe
      if (state === 'missing') {
        const error = new Error('没有找到可 import torch 的 Python 解释器。')
        error.code = TORCH_MISSING
        error.install_hint = TORCH_INSTALL_HINT
        throw error
      }
      startProbe()
      const error = new Error('Python/torch 解释器正在异步探测；稍后重试此工具。')
      error.code = PROBE_PENDING
      throw error
    },
    invalidate() {
      generation += 1
      cachedExe = null
      state = 'idle'
      pending = null
    },
    whenSettled() { return pending ?? Promise.resolve() },
  }
}

const defaultResolver = createPythonResolver()

/**
 * 同步读取已选定解释器（进程内缓存）；首次调用启动异步探测并抛带 code 的
 * “探测中”状态，所有候选失败时抛带 install_hint 的缺失状态。
 *
 * 不做「路径存在即采用」的浅判断——落在一个没有 torch 的解释器上时，
 * 工具只会抛 ModuleNotFoundError 而用户无从判断该装到哪里。这里逐个探测
 * `import torch`，让选择结果可解释（可视化由宿主面板 + galatea_status 承担）。
 *
 * 注：刻意不在插件加载期调用本函数（探测有秒级开销，会拖慢宿主启动）。
 */
export function pythonExe() {
  return defaultResolver.pythonExe()
}

/** op 名 → 对外工具名（rank 两 op 各自对应一个工具）。 */
const OP_TOOL = {
  'rank.consensus': 'galatea_rank',
  'rank.aggregate': 'galatea_rank_aggregate',
}

function toolNameFor(op) {
  return OP_TOOL[op] ?? `galatea_${op}`
}

/**
 * 该 op 是否真正需要 torch。
 *
 * 单一真值源 = capabilities 清单的 `requires` 字段：只有显式声明
 * `python.torch` 的操作才算需要 torch。这与清单对 agent 公开的
 * `status: 'ready'` 保持一致——清单说ready 的操作在无 torch 环境下
 * 也必须能跑（纯标准库即可），否则就是对用户的失实承诺。
 */
function opNeedsTorch(op) {
  const tool = toolNameFor(op)
  const entry = TOOLS_MANIFEST.find((t) => t.name === tool)
  if (!entry) {
    // 清单里没有该工具：保守拦截（避免为不存在的操作放宽）
    return true
  }
  return (entry.requires ?? []).includes('python.torch')
}

function probeStateResult(op, error) {
  const missing = error.code === TORCH_MISSING
  return stampProvenance(toolNameFor(op), {
    ok: false,
    code: error.code,
    state: missing ? 'missing' : 'probing',
    message: error.message,
    ...(missing
      ? { missing_dependencies: ['python.torch'], install_hint: TORCH_INSTALL_HINT }
      : { retry_after_ms: 1_000 }),
  })
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
    if (opts.signal?.aborted) {
      reject(opts.signal.reason ?? new Error(`galatea op ${op} aborted`))
      return
    }
    const resolver = opts.resolver ?? defaultResolver
    let py
    let missingFallback = false
    try {
      py = resolver.pythonExe()
    } catch (error) {
      if (error.code === PROBE_PENDING) {
        resolve(probeStateResult(op, error))
        return
      }
      if (error.code !== TORCH_MISSING) {
        reject(error)
        return
      }
      // status/setup 是诊断与修复入口；全候选缺 torch 时沿用原来的 PATH 兜底。
      // ⚠️ 2026-10-01 修正（Codex 二阶审查 P1）：原逻辑对**所有** op 一律拦截，
      //导致 8 个不声明 python.torch 的工具（portfolio/budget/coverage/rank/
      // rank_aggregate/loop 等纯标准库或 analysis 档操作）被误封锁，而
      // capabilities 清单仍报 ready —— 清单与实际行为矛盾。
      // 现按清单的 requires 精确判断：只有真正需要 torch 的操作才拦截，
      // 其余操作回退到 PATH 上的任意 Python（纯标准库即可运行）。
      if (op !== 'status' && op !== 'setup' && opNeedsTorch(op)) {
        resolve(probeStateResult(op, error))
        return
      }
      py = 'python'
      missingFallback = true
    }
    const script = join(PYTHON_DIR, 'galatea_ops.py')
    let cp
    try {
      cp = (opts.spawnProcess ?? spawn)(py, ['-I', script], {
        cwd: PYTHON_DIR, windowsHide: true, detached: process.platform !== 'win32',
      })
    } catch (error) {
      if (missingFallback) {
        resolve(probeStateResult(op, {
          code: TORCH_MISSING,
          message: `没有找到可运行的 Python 解释器：${error.message}`,
        }))
      } else {
        reject(new Error(`python spawn failed (${py}): ${error.message}`))
      }
      return
    }
    let out = ''
    let err = ''
    cp.stdout.on('data', (d) => { out += d })
    cp.stderr.on('data', (d) => { err += d })
    const spawnFailure = (e) => {
      if (missingFallback) {
        resolve(probeStateResult(op, {
          code: TORCH_MISSING,
          message: `没有找到可运行的 Python 解释器：${e.message}`,
        }))
      } else {
        reject(new Error(`python spawn failed (${py}): ${e.message}`))
      }
    }
    cp.on('error', spawnFailure)
    cp.stdin.on('error', spawnFailure)
    const failWithTreeStop = (reason) => {
      try {
        terminateProcessTree(cp)
        reject(reason)
      } catch (error) {
        reject(new Error(`galatea op ${op} cancellation failed: ${error.message}`, { cause: reason }))
      }
    }
    const timer = opts.timeoutMs
      ? setTimeout(() => failWithTreeStop(new Error(`galatea op ${op} timeout after ${opts.timeoutMs}ms`)), opts.timeoutMs)
      : null
    const onAbort = () => {
      if (timer) clearTimeout(timer)
      failWithTreeStop(opts.signal.reason ?? new Error(`galatea op ${op} aborted`))
    }
    if (opts.signal) opts.signal.addEventListener('abort', onAbort, { once: true })
    cp.on('close', (code) => {
      if (timer) clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
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
      if (op === 'setup') resolver.invalidate()
      resolve(stampProvenance(toolNameFor(op), parsed.result))
    })
    try {
      cp.stdin.write(JSON.stringify({ op, args }))
      cp.stdin.end()
    } catch (error) {
      spawnFailure(error)
    }
  })
}

export { PYTHON_DIR }
