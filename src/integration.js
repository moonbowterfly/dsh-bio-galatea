import { spawn } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { pythonCandidates } from './python.js'
import { TOOLS_MANIFEST, buildCapabilitiesReport } from './capabilities.js'

/**
 * dsh-bio-galatea — hosted-domain integration protocol v1 (read-only batch).
 *
 * This module deliberately has no import-time probes: loading the plugin and
 * serving /health must never spawn Python or modify the data directory.
 */

export const INTEGRATION_PREFIX = '/api/dsh-bio-galatea/integration'
export const PROTOCOL_MAJOR = 1
export const PROTOCOL_MINORS = [0]
export const RUNTIME_PROBE_CACHE_MS = 60_000
/** 失败结果（含超时）只缓存 60s，让后台尽快重试（冷启动类失败是暂时性状态）。 */
export const FAILED_PROBE_CACHE_MS = 60_000
export const INTEGRATION_FEATURES = [
  'status',
  'capabilities',
  'weight-store',
  'outputs',
  'device-probe',
  'runtime-mpnn',
  'runtime-esmfold',
]

const PLUGIN_ID = 'dsh-bio-galatea'
// 版本号从 package.json 实时读，避免 bump 版本时漏改此处导致 /health 自报旧版本
// （曾报 0.1.2 而磁盘已是 0.1.3；重启无效、非缓存，是真实的第二真值源缺陷）。
const PLUGIN_VERSION = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
).version

export function defaultDataRoot() {
  const dshHome = process.env.DSH_HOME ?? join(os.homedir(), '.dsh')
  return join(dshHome, 'dsh-bio-galatea')
}

/**
 * 解析模型目录（允许把大体积模型安装到其他磁盘，或由 BioGenie 设置面板配置）：
 *   GALATEA_MODELS_DIR env > <root>/config.json 的 modelsDir 字段 > <root>/models。
 * 每次调用重新解析（改配置后无需重启——python 侧 resolve_models_dir 与之一致）。
 */
export function resolveModelsDir(root) {
  const envDir = process.env.GALATEA_MODELS_DIR
  if (envDir && envDir.trim()) return { dir: envDir.trim(), source: 'env' }
  try {
    const cfgPath = join(root, 'config.json')
    if (existsSync(cfgPath)) {
      const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'))
      if (cfg && typeof cfg.modelsDir === 'string' && cfg.modelsDir.trim()) {
        return { dir: cfg.modelsDir.trim(), source: 'config' }
      }
    }
  } catch { /* 无配置或坏配置 → 默认 */ }
  return { dir: join(root, 'models'), source: 'default' }
}

function listFiles(dir, predicate = () => true) {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && predicate(entry.name))
      .map((entry) => {
        const fullPath = join(dir, entry.name)
        const stat = statSync(fullPath)
        return {
          name: entry.name,
          sizeBytes: stat.size,
          modifiedAt: stat.mtime.toISOString(),
        }
      })
      .sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt))
  } catch {
    return []
  }
}

function boundedSummary(dir, predicate) {
  const all = listFiles(dir, predicate)
  return { count: all.length, items: all.slice(0, 50) }
}

/** 权重目录摘要：按组件分组（mpnn/、esmfold/）统计文件数与字节数（modelsDir=已解析的模型根）。 */
function weightsSummary(modelsDir) {
  const components = ['mpnn', 'esmfold']
  const items = []
  let totalBytes = 0
  let totalFiles = 0
  for (const component of components) {
    const dir = join(modelsDir, component)
    const files = listFiles(dir)
    const bytes = files.reduce((acc, file) => acc + file.sizeBytes, 0)
    totalBytes += bytes
    totalFiles += files.length
    items.push({
      component,
      dir,
      fileCount: files.length,
      sizeBytes: bytes,
      files: files.slice(0, 20).map((file) => ({ name: file.name, sizeBytes: file.sizeBytes })),
    })
  }
  return { dir: modelsDir, fileCount: totalFiles, sizeBytes: totalBytes, components: items }
}

/** LigandMPNN 供应商代码 + ProteinMPNN 权重（runtime.mpnn 检查项）。 */
function mpnnStatus(root, modelsDir) {
  const vendor = join(root, 'vendor', 'LigandMPNN')
  const codeOk = existsSync(join(vendor, 'run.py'))
  const weightsDir = join(modelsDir, 'mpnn')
  const weights = listFiles(weightsDir, (name) => name.endsWith('.pt'))
  const available = codeOk && weights.length > 0
  let hint
  if (available) {
    hint = `LigandMPNN 代码就绪（${vendor}）；MPNN 权重 ${weights.length} 个。`
  } else if (!codeOk && weights.length === 0) {
    hint = 'LigandMPNN 代码与 MPNN 权重均缺失 → 运行 galatea_setup(action="mpnn")。'
  } else if (!codeOk) {
    hint = 'LigandMPNN 代码缺失（权重已就绪）→ 运行 galatea_setup(action="mpnn")。'
  } else {
    hint = 'MPNN 权重缺失（代码已就绪）→ 运行 galatea_setup(action="mpnn")。'
  }
  return { available, codeOk, weightsCount: weights.length, vendorDir: vendor, hint }
}

/** ESMFold 权重（runtime.esmfold 检查项）——私有目录优先，HF 缓存兜底探测。 */
function esmfoldStatus(modelsDir) {
  const weightsDir = join(modelsDir, 'esmfold')
  const files = listFiles(weightsDir, (name) => /\.(safetensors|bin|pt)$/.test(name))
  let available = files.length > 0
  let source = available ? 'galatea-private' : null
  if (!available) {
    // transformers 默认缓存兜底：~/.cache/huggingface/hub 下的 esmfold 模型目录
    const hfHome = process.env.HF_HOME ?? join(os.homedir(), '.cache', 'huggingface')
    const hubDir = join(hfHome, 'hub')
    try {
      const entries = readdirSync(hubDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && /esmfold/i.test(entry.name))
        .map((entry) => entry.name)
      if (entries.length > 0) {
        available = true
        source = 'hf-cache'
      }
    } catch { /* hub 目录不存在即视为未命中 */ }
  }
  const hint = available
    ? `ESMFold 权重可读（来源：${source}，${files.length || '缓存'} 项）。`
    : 'ESMFold 权重缺失 → 运行 galatea_setup(action="esmfold")（约 2.5GB 下载）。'
  return { available, source, weightsCount: files.length, weightsDir, hint }
}

function statusCheck(id, status, detail) {
  return { id, status, detail }
}

function remediationsFor(checks) {
  const codes = new Set(checks.filter((check) => check.status !== 'ok').map((check) => check.id))
  const remediations = []
  if (codes.has('python.torch')) {
    remediations.push({
      code: 'galatea.setup-env', owner: 'galatea',
      detail: '运行 galatea_setup(action="env") 创建私有 venv 并安装 torch 依赖。',
    })
  }
  if (codes.has('runtime.analysis')) {
    remediations.push({
      code: 'galatea.setup-env', owner: 'galatea',
      detail: '分析类工具需要 biopython/numpy：运行 galatea_setup(action="env")。',
    })
  }
  if (codes.has('runtime.mpnn')) {
    remediations.push({
      code: 'galatea.setup-mpnn', owner: 'galatea',
      detail: '运行 galatea_setup(action="mpnn") 获取 LigandMPNN 代码与权重。',
    })
  }
  if (codes.has('runtime.esmfold')) {
    remediations.push({
      code: 'galatea.setup-esmfold', owner: 'galatea',
      detail: '运行 galatea_setup(action="esmfold") 下载 ESMFold 权重（约 2.5GB）。',
    })
  }
  return remediations
}

/** Read only the installed torch version; output and failures stay local. */
function probeTorchVersion(executable) {
  return new Promise((resolve) => {
    let settled = false
    let timer = null
    const finish = (value) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolve(value)
    }
    try {
      const child = spawn(executable, ['-I', '-c', 'import torch; print(torch.__version__)'], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      })
      let stdout = ''
      child.stdout?.on('data', (chunk) => { stdout += chunk.toString('utf8') })
      child.on('error', () => finish(null))
      child.on('close', (code) => finish(code === 0 ? stdout.trim() || 'available' : null))
      timer = setTimeout(() => {
        try { child.kill() } catch { /* already exited */ }
        finish(null)
      }, 60_000)
    } catch {
      finish(null)
    }
  })
}

/**
 * find_spec 快探测（不加载模块）：biopython + numpy 可用性（runtime.analysis 检查项）。
 *
 * 返回值三态，**不可把探测失败折叠成"缺失"**：
 *   'ok' / 'available' → 依赖就绪
 *   'missing'          → 解释器正常回答，确实缺 biopython / numpy
 *   'probe-failed'     → 探测本身没跑成（spawn 失败 / 解释器异常退出 / 超时 / 同步抛异常）
 * 折叠成 null 会让 20s 超时或系统繁忙被显示成"biopython / numpy 缺失"，属失实陈述。
 */
function probeAnalysisDeps(executable) {
  return new Promise((resolve) => {
    let settled = false
    let timer = null
    const finish = (value) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolve(value)
    }
    const code = "import importlib.util as u; print('ok' if u.find_spec('Bio') and u.find_spec('numpy') else 'missing')"
    try {
      const child = spawn(executable, ['-I', '-c', code], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      })
      let stdout = ''
      child.stdout?.on('data', (chunk) => { stdout += chunk.toString('utf8') })
      child.on('error', () => finish('probe-failed'))
      child.on('close', (code2) => {
        if (code2 !== 0) return finish('probe-failed')
        const reported = stdout.trim()
        // 解释器正常退出但没有可识别输出：同样属于"探测失败"而非"缺依赖"。
        if (!reported) return finish('probe-failed')
        finish(reported === 'missing' ? 'missing' : 'ok')
      })
      timer = setTimeout(() => {
        try { child.kill() } catch { /* already exited */ }
        finish('probe-failed')
      }, 20_000)
    } catch {
      finish('probe-failed')
    }
  })
}

async function probePythonEnvironment(candidateProvider, fileExists, probeTorch) {
  const candidates = candidateProvider().map((candidate) => ({
    ...candidate,
    exists: candidate.path === 'python' ? true : fileExists(candidate.path),
  }))
  let selected = null
  for (const candidate of candidates) {
    if (!candidate.exists) continue
    let torchVersion = null
    try {
      torchVersion = await probeTorch(candidate.path)
    } catch { /* individual candidate failures are an expected degraded state */ }
    if (torchVersion) {
      selected = {
        path: candidate.path,
        source: candidate.source,
        torchVersion,
      }
      break
    }
  }
  return {
    selected,
    candidates,
    note: selected ? undefined : '所有候选均未通过 import torch 的只读探测。',
  }
}

/** GPU 设备探测（nvidia-smi 只读查询；无 NVIDIA GPU / 无驱动时返回 available:false）。 */
function probeDevice() {
  return new Promise((resolve) => {
    let settled = false
    let timer = null
    const finish = (value) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolve(value)
    }
    try {
      const child = spawn('nvidia-smi', [
        '--query-gpu=name,memory.total,driver_version', '--format=csv,noheader',
      ], {
        windowsHide: true,
        // wsl.exe 除外场景：nvidia-smi 用 pipe stdin 无损（与 gem 的 WSL 实测一致，保持 pipe）
        stdio: ['pipe', 'pipe', 'ignore'],
      })
      child.stdin?.end()
      let stdout = ''
      child.stdout?.on('data', (chunk) => {
        if (stdout.length < 512) stdout += chunk.toString('utf8').slice(0, 512 - stdout.length)
      })
      child.on('error', () => finish({ cuda: false, detail: 'nvidia-smi 不可用（无 NVIDIA GPU 或未安装驱动）。' }))
      child.on('close', (code) => {
        const line = stdout.trim().split(/\r?\n/)[0]?.trim()
        if (code === 0 && line) {
          const [name, memory, driver] = line.split(',').map((part) => part.trim())
          const vramGb = memory ? Number.parseFloat(memory) / 1024 : null
          finish({
            cuda: true,
            name,
            vramGb: Number.isFinite(vramGb) ? Math.round(vramGb * 10) / 10 : null,
            driver,
            detail: `${name}（${memory}，driver ${driver}）`,
          })
        } else {
          finish({ cuda: false, detail: 'nvidia-smi 查询失败（无 NVIDIA GPU）。' })
        }
      })
      timer = setTimeout(() => {
        try { child.kill() } catch { /* already exited */ }
        finish({ cuda: false, detail: 'nvidia-smi 探测超时。' })
      }, 15_000)
    } catch {
      finish({ cuda: false, detail: 'nvidia-smi 探测未完成。' })
    }
  })
}

function writeJson(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'referrer-policy': 'no-referrer',
  })
  res.end(JSON.stringify(body))
}

/**
 * Loopback + same-origin guard copied from the host integration boundary.
 *
 * It independently verifies socket address, Host, browser cross-site intent,
 * and Origin when one is present. Loopback alone is not treated as a general
 * authorization mechanism for future write routes.
 */
export function isLoopbackRequest(req) {
  const address = req.socket?.remoteAddress
  if (address !== '127.0.0.1' && address !== '::1' && address !== '::ffff:127.0.0.1') return false
  const host = req.headers?.host
  if (typeof host !== 'string') return false
  let hostUrl
  try {
    hostUrl = new URL(`http://${host}`)
  } catch {
    return false
  }
  if (hostUrl.hostname !== '127.0.0.1' && hostUrl.hostname !== 'localhost' && hostUrl.hostname !== '[::1]') return false
  if (req.headers?.['sec-fetch-site'] === 'cross-site') return false
  const origin = req.headers?.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

function guardedGet(handler) {
  return async (req, res) => {
    if (!isLoopbackRequest(req)) {
      return writeJson(res, 403, {
        ok: false,
        code: 'loopback-required',
        message: 'loopback requests only',
      })
    }
    if (req.method !== 'GET') {
      return writeJson(res, 405, {
        ok: false,
        code: 'method-not-allowed',
        message: `method not allowed: ${req.method}`,
      })
    }
    try {
      const response = await handler()
      if (response?.ok !== true) {
        return writeJson(res, 500, {
          ok: false,
          code: 'internal',
          message: 'integration endpoint failed',
        })
      }
      return writeJson(res, 200, response)
    } catch {
      return writeJson(res, 500, {
        ok: false,
        code: 'internal',
        message: 'integration endpoint failed',
      })
    }
  }
}

/** Register the fixed read-only integration routes when webServer exists. */
export function registerIntegrationRoutes(ctx, options = {}) {
  const webServer = options.webServer ?? ctx?.webServer
  if (!webServer?.register) return () => {}
  const service = options.service ?? createIntegrationService(options)
  const routes = [
    {
      kind: 'exact',
      path: `${INTEGRATION_PREFIX}/health`,
      handler: guardedGet(() => service.health()),
    },
    {
      kind: 'exact',
      path: `${INTEGRATION_PREFIX}/v1/status`,
      handler: guardedGet(() => service.status()),
    },
    {
      kind: 'exact',
      path: `${INTEGRATION_PREFIX}/v1/capabilities`,
      handler: guardedGet(() => service.capabilities()),
    },
  ]
  const disposers = routes.map((route) => webServer.register(route))
  return () => {
    for (const dispose of disposers) dispose?.()
  }
}

/**
 * Create the stateless portion of the integration API.
 *
 * Options exist solely to make protocol behavior testable without a dsh host;
 * production callers use the package defaults.
 */
export function createIntegrationService(options = {}) {
  const pluginVersion = options.pluginVersion ?? PLUGIN_VERSION
  const dataRoot = options.dataRoot ?? defaultDataRoot()
  const now = options.now ?? Date.now
  const candidateProvider = options.pythonCandidates ?? pythonCandidates
  const fileExists = options.fileExists ?? existsSync
  const probeTorch = options.probeTorch ?? probeTorchVersion
  const probeAnalysis = options.probeAnalysis ?? probeAnalysisDeps
  const probePython = options.probePython
    ?? (() => probePythonEnvironment(candidateProvider, fileExists, probeTorch))
  const probeDeviceFn = options.probeDeviceFn ?? probeDevice

  let cachedPython = null
  let cachedPythonAt = 0
  let pendingPython = null
  let cachedAnalysis = null
  let cachedAnalysisAt = 0
  let pendingAnalysis = null
  let cachedDevice = null
  let cachedDeviceAt = 0
  let pendingDevice = null

  /** Python 探测快（≈3s）且有 60s 缓存：保持同步等待，语义简单。 */
  function readPython() {
    const current = now()
    if (cachedPython && current - cachedPythonAt < RUNTIME_PROBE_CACHE_MS) return Promise.resolve(cachedPython)
    if (pendingPython) return pendingPython
    pendingPython = Promise.resolve()
      .then(probePython)
      .then((value) => {
        cachedPython = value
        cachedPythonAt = now()
        return value
      })
      .finally(() => { pendingPython = null })
    return pendingPython
  }

  /** analysis 依赖探测（find_spec 快查）；结果随解释器选择变化，缓存 60s。 */
  function readAnalysis(selectedExecutable) {
    const current = now()
    if (cachedAnalysis && current - cachedAnalysisAt < RUNTIME_PROBE_CACHE_MS) return Promise.resolve(cachedAnalysis)
    // 无解释器 = 确定性的"就绪条件不成立"；探针失败是"判不出来"，两者不可混同。
    if (!selectedExecutable) return Promise.resolve('missing')
    if (pendingAnalysis) return pendingAnalysis
    pendingAnalysis = Promise.resolve()
      .then(() => probeAnalysis(selectedExecutable))
      .then((value) => {
        // 旧版探针可能回传 null（探测失败），归一为显式态，避免下游当成"缺依赖"。
        const normalized = value === null ? 'probe-failed' : value
        cachedAnalysis = normalized
        cachedAnalysisAt = now()
        return normalized
      })
      .catch(() => 'probe-failed')
      .finally(() => { pendingAnalysis = null })
    return pendingAnalysis
  }

  /** 设备探测：失败结果只缓存 60s（驱动/GPU 状态可能变化）。 */
  function readDevice() {
    const current = now()
    if (cachedDevice && current - cachedDeviceAt < RUNTIME_PROBE_CACHE_MS) return Promise.resolve(cachedDevice)
    if (pendingDevice) return pendingDevice
    pendingDevice = Promise.resolve()
      .then(probeDeviceFn)
      .then((value) => {
        cachedDevice = value
        cachedDeviceAt = now()
        return value
      })
      .catch(() => cachedDevice)
      .finally(() => { pendingDevice = null })
    return pendingDevice
  }

  /** 依赖检查（status 与 capabilities 共用；语义与既有 status 一致）。 */
  async function collectChecks() {
    const python = await readPython()
    const [analysis, device] = await Promise.all([
      readAnalysis(python.selected?.path),
      readDevice(),
    ])
    const models = resolveModelsDir(dataRoot)
    const mpnn = mpnnStatus(dataRoot, models.dir)
    const esmfold = esmfoldStatus(models.dir)
    const checks = [
      statusCheck(
        'python.torch',
        python.selected ? 'ok' : 'missing',
        python.selected
          ? `torch ${python.selected.torchVersion ?? 'available'} @ ${python.selected.path}`
          : '未找到可 import torch 的 Python 解释器。',
      ),
      statusCheck(
        'runtime.analysis',
        // 三态：探测未完成 → warn（判不出来，不谎报缺失）；
        // 无解释器 → missing；解释器可用但明确报缺 → missing。
        analysis === 'probe-failed' ? 'warn'
          : (analysis === 'ok' || analysis === 'available' ? 'ok' : 'missing'),
        analysis === 'probe-failed'
          ? '分析依赖探测未完成（解释器无响应、超时或启动失败），状态待下次探测确认。'
          : !python.selected
            ? '未找到可用的 Python 解释器，分析类工具不可用。'
            : analysis === 'ok' || analysis === 'available'
              ? 'biopython 与 numpy 可用（分析类工具就绪）。'
              : 'biopython / numpy 缺失（分析类工具不可用）。',
      ),
      statusCheck(
        'runtime.mpnn',
        mpnn.available ? 'ok' : 'missing',
        mpnn.hint,
      ),
      statusCheck(
        'runtime.esmfold',
        esmfold.available ? 'ok' : 'missing',
        esmfold.hint,
      ),
    ]
    return { python, analysis, device, mpnn, esmfold, checks, models }
  }

  return {
    async health() {
      return {
        ok: true,
        value: {
          pluginId: PLUGIN_ID,
          pluginVersion,
          protocolMajor: PROTOCOL_MAJOR,
          protocolMinors: PROTOCOL_MINORS,
          features: INTEGRATION_FEATURES,
        },
      }
    },

    async capabilities() {
      const { checks } = await collectChecks()
      return { ok: true, value: buildCapabilitiesReport({ pluginVersion, checks }) }
    },

    async status() {
      const { python, analysis, device, mpnn, esmfold, checks, models } = await collectChecks()
      return {
        ok: true,
        value: {
          state: checks.every((check) => check.status === 'ok') ? 'ready' : 'degraded',
          generatedAt: new Date(now()).toISOString(),
          pluginVersion,
          features: INTEGRATION_FEATURES,
          checks,
          data: {
            weights: weightsSummary(models.dir),
            modelsDir: { dir: models.dir, source: models.source },
            outputs: boundedSummary(join(dataRoot, 'out')),
          },
          env: {
            python,
            components: { mpnn, esmfold, analysis },
            device,
          },
          remediations: remediationsFor(checks),
        },
      }
    },
  }
}
