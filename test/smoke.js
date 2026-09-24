// test/smoke.js — dsh-bio-gem 回归冒烟（node 直测 Python 层，不依赖 dsh）
// 用法: node test/smoke.js [--skip-build] [--require-assets] [--assets-root <dir>]
//   --skip-build      跳过 build 单测（默认跑，耗时 ~70s）
//   --require-assets  资产缺失时以非零退出（CI 严格模式）；默认 SKIP 且退出 0
//   --assets-root     显式指定模型资产根目录（设了就不再回退内置候选；CI/测试注入点）
// 资产解析（2026-09-19 审计修复）：
//   模型资产已从 F:\A_NGJ plan 迁至 F:\Biodata\Old\A_NGJ plan——旧实现硬编码单一路径，
//   迁移后 smoke 直接 OSError 崩溃而不是给出可读结论。现在多候选自动发现 + 缺资产 SKIP：
//   优先级 = --assets-root > DSH_BIO_GEM_ASSETS 环境变量 > 内置候选（按新→旧）。
//   注意：缺资产 ≠ 回归失败——相关检查标记 SKIP，退出码由 --require-assets 决定。
// 断言（C58 回归锚）：
//   model_info  : 1084 基因 / 2492 反应
//   validate    : G1 PASS / G3 PASS 0.519981（AB 自然名介质）
//   gapfind     : 蔗糖缺口 L1 检出 EX_cpd00076_e0
//   gapfill     : 自动补洞 >=1 项，修复后蔗糖可生长
//   build      : protein.faa -> M9 G3 PASS（growth>0）[--skip-build 可跳过]
import { spawn } from 'node:child_process'
import { existsSync, writeFileSync, mkdtempSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const PY = process.env.GEM_PYTHON || 'C:/Users/shuai/miniconda3/python.exe'
const REPO = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const PYDIR = join(REPO, 'python')

// ── 资产解析（多候选 + 显式覆盖；2026-09-19 审计修复）────────────────────────
const argv = process.argv.slice(2)
const argVal = (flag) => {
  const i = argv.indexOf(flag)
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null
}
const explicitRoot = argVal('--assets-root') || process.env.DSH_BIO_GEM_ASSETS || null
const ASSET_ROOTS = explicitRoot
  ? [explicitRoot]
  : [
      'F:/Biodata/Old/A_NGJ plan/Zcode',    // 2026-09 之后的实际位置
      'F:/A_NGJ plan/Zcode',                // 历史位置（迁移前）
    ]

function findAsset(relativeCandidates) {
  for (const root of ASSET_ROOTS) {
    for (const rel of relativeCandidates) {
      const p = join(root, rel)
      if (existsSync(p)) return p
    }
  }
  return null
}

const C58 = findAsset(['models/gapseq_C58/C58.xml'])
const C58P1 = findAsset(['models/gapseq_C58/C58_P1.xml'])
const INX4 = findAsset(['models/iNX1344_v4.xml'])
// FAA 是 build 产物（独立于项目模型目录）：显式 root 模式下在 root 内找，否则用默认路径
const FAA = explicitRoot
  ? findAsset(['C58_protein.faa'])
  : (process.env.DSH_BIO_GEM_FAA || 'D:/Program/hermes/temp/gem_build_test/C58_protein.faa')

const HAS_MAIN = Boolean(C58 && C58P1)
const HAS_INX4 = Boolean(INX4)
const ASSET_HINT = explicitRoot
  ? `资产根目录 ${explicitRoot}`
  : `候选目录 ${ASSET_ROOTS.join(' | ')}（可用 --assets-root 或 DSH_BIO_GEM_ASSETS 覆盖）`

// 默认账本（一个模型一个账本：~/.dsh/dsh-bio-gem/ledger/<模型文件名>.jsonl，命名规则与
// python/ledger.py 的 model_ledger_path 同步）——账本缺失/为空时，enrichment 的基因输入
// 与 targets 的数据源为空（2026-09-10 dsh 重建后本机曾缺失，已从 gem-verify 快照恢复）。
// 缺账本 → 相关检查 SKIP（新环境/CI 不误报为回归失败）。
const LEDGER_DIR = join(homedir(), '.dsh', 'dsh-bio-gem', 'ledger')
function ledgerReady(modelPath) {
  if (!modelPath) return false
  const base = modelPath.split(/[\\/]/).pop().replace(/\.[^.]+$/, '')
  const p = join(LEDGER_DIR, base + '.jsonl')
  try { return existsSync(p) && readFileSync(p, 'utf8').trim().length > 0 } catch { return false }
}

const AB = {
  'D-Glucose': -5, 'NH3': -10, 'O2': -12.5, 'CO2': -15, 'H+': -20, 'H2O': -100,
  'Phosphate': -10, 'Sulfate': -10, 'Cl-': -10, 'Mn2+': -10, 'Zn2+': -10, 'Co2+': -10,
  'Ni2+': -1, 'Fe3+': -0.1, 'Fe2+': -10, 'Ca2+': -10, 'Cu2+': -10, 'K+': -10,
  'Mg2+': -10, 'Na+': -10,
}

let passed = 0
let failed = 0
let skipped = 0
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ✅ ${name}`) }
  else { failed++; console.log(`  ❌ ${name} ${detail}`) }
}
function skip(name, reason) {
  skipped++
  console.log(`  ⏭️  SKIP ${name} — ${reason}`)
}

function runPy(script, payload, viaFile = false) {
  return new Promise((resolve, reject) => {
    const pf = join(tmpdir(), `gem-smoke-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.json`)
    const args = ['-I', join(PYDIR, script)]
    if (viaFile) {
      writeFileSync(pf, JSON.stringify(payload))
      args.push(pf)
    }
    const cp = spawn(PY, args, { cwd: PYDIR, windowsHide: true })
    let out = ''
    let err = ''
    cp.stdout.on('data', (d) => { out += d })
    cp.stderr.on('data', (d) => { err += d })
    cp.on('close', (code, signal) => {
      // 桥契约：脚本异常也以 JSON 收尾、exit 0；非零退出/被杀 = 契约破坏（即使有合法 JSON）
      // （2026-09-19 审计：旧实现只看 traceback/JSON，异常退出被静默吞掉）
      if (code !== 0 || signal) {
        return reject(new Error(`${script} 非正常退出 (code=${code}, signal=${signal ?? 'null'}): ${err.slice(-300)}`))
      }
      if (err.includes('Traceback')) return reject(new Error(err.slice(-500)))
      const txt = out.trim()
      let parsed = null
      try {
        parsed = JSON.parse(txt)          // 整段（gapfind/gapfill 多行 indent JSON）
      } catch {
        const lines = txt.split(/\r?\n/).filter(Boolean)
        try {
          parsed = JSON.parse(lines[lines.length - 1])  // 单行 bridge 协议
        } catch (e) {
          return reject(new Error(`bad JSON from ${script}: ${txt.slice(-300)}`))
        }
      }
      resolve(parsed)
    })
    cp.on('error', reject)
    if (!viaFile) {
      cp.stdin.write(JSON.stringify(payload))
      cp.stdin.end()
    }
  })
}

async function main() {
  const skipBuild = process.argv.includes('--skip-build')
  const requireAssets = process.argv.includes('--require-assets')
  console.log('dsh-bio-gem smoke (C58 回归锚)')
  console.log(`  资产: C58=${C58 ?? '缺失'} | C58_P1=${C58P1 ?? '缺失'} | iNX1344_v4=${INX4 ?? '缺失'} | faa=${FAA ?? '缺失'}`)

  if (HAS_MAIN) {
    // 1) model_info —— 注意：断言目标为 C58_P1.xml（P1 补洞版，2492 反应）；VM系 C58.xml 为 2485（见 zcode 验证报告 D7）
    const mi = await runPy('gem_ops.py', { op: 'model_info', args: { model: C58P1 } })
    check('model_info: 1084 基因', mi?.result?.genes === 1084, `got ${mi?.result?.genes}`)
    check('model_info: 2492 反应', mi?.result?.reactions === 2492, `got ${mi?.result?.reactions}`)
    check('model_info: 4 复制子', Object.keys(mi?.result?.replicons ?? {}).length === 4,
      JSON.stringify(mi?.result?.replicons))

    // 2) validate
    const v = await runPy('gem_ops.py', { op: 'validate', args: { model: C58, medium: AB, reference_growth: 0.519981 } })
    const g3 = v?.result?.g3 ?? {}
    check('validate: G1 PASS', v?.result?.g1?.status === 'PASS', v?.result?.g1?.status)
    check('validate: G3 PASS + 0.519981', g3.status === 'PASS' && Math.abs(g3.growth_medium - 0.519981) < 1e-4,
      `${g3.status} ${g3.growth_medium}`)
    check('validate: 无碳源 = 0', Math.abs(g3.growth_no_carbon) < 1e-6, g3.growth_no_carbon)

    // 3) gapfind（蔗糖缺口）— viaFile（gapfind 读 argv 文件）
    const gf = await runPy('gapfind.py', { model: C58, medium: { ...AB, Sucrose: -10 }, substrates: ['Sucrose'] }, true)
    const l1missing = (gf?.L1 ?? []).some((x) => x.exchange === 'EX_cpd00076_e0' || x.type === 'exchange_unresolved_name' || x.type === 'exchange_missing_name')
    check('gapfind: 蔗糖 L1 缺口检出', l1missing, JSON.stringify(gf?.L1))

    // 3b) 跨引擎介质解析护栏：O2 不得误配到 Acetoin（2026-08-29 回归：子串回退防误伤）
    //     修复：existsSync 判断必须在调用**之前**（旧实现先调用后判断，模型缺失时先抛栈再 skip）
    const carveModel = explicitRoot
      ? findAsset(['C58_carveme_test.xml'])
      : (existsSync('D:/Program/hermes/temp/gem_build_test/C58_carveme_test.xml')
          ? 'D:/Program/hermes/temp/gem_build_test/C58_carveme_test.xml' : null)
    if (carveModel) {
      const cev = await runPy('gapfind.py', { model: carveModel, medium: { medium_name: 'AB' } }, true)
      const rx = cev?.resolved_exchanges ?? []
      check('解析护栏: 含 EX_o2_e', rx.includes('EX_o2_e'), JSON.stringify(rx))
      check('解析护栏: 不含 EX_actn__R_e（O2 误配回归）', !rx.includes('EX_actn__R_e'), JSON.stringify(rx))
      check('解析护栏: medium_unresolved 空', (cev?.medium_unresolved ?? []).length === 0,
        JSON.stringify(cev?.medium_unresolved))
    } else {
      skip('CarveMe 解析护栏', '临时模型 C58_carveme_test.xml 不存在')
    }

    // 4) gapfill（补洞 + 修复后生长验证）
    const tmp = mkdtempSync(join(tmpdir(), 'gem-smoke-'))
    const out = join(tmp, 'gf.xml')
    const gfill = await runPy('gapfill.py', { model: C58, medium: { ...AB, Sucrose: -10 }, out }, true)
    const applied = (gfill?.applied ?? []).length
    check('gapfill: 自动补洞 >=1', applied >= 1, `applied=${applied}`)
    if (gfill?.out && existsSync(gfill.out)) {
      const v2 = await runPy('gem_ops.py', { op: 'validate', args: { model: gfill.out, medium: { ...AB, Sucrose: -10 } } })
      const g3b = v2?.result?.g3 ?? {}
      check('gapfill 后: 蔗糖介质 G3 PASS', g3b.status === 'PASS' && g3b.growth_medium > 0.1,
        `${g3b.status} ${g3b.growth_medium}`)
      check('gapfill 后: 蔗糖生长≈0.97077', Math.abs(g3b.growth_medium - 0.97077) < 0.01,
        `${g3b.growth_medium}`)
    }
  } else {
    skip('model_info / validate / gapfind / gapfill（主组）', `C58 或 C58_P1 未找到 — ${ASSET_HINT}`)
  }

  // 5) build（可用 --skip-build 跳过；完整 ~30-80s）
  if (!skipBuild && FAA && existsSync(FAA)) {
    const tmp2 = mkdtempSync(join(tmpdir(), 'gem-smoke-build-'))
    const pr = join(tmp2, 'progress.jsonl')
    const b = await new Promise((resolve, reject) => {
      const cp = spawn(PY, ['-u', join(PYDIR, 'build.py'), '--input', FAA, '--name', 'smoke_test',
        '--out-dir', tmp2, '--progress', pr])
      let out = ''
      let err = ''
      cp.stdout.on('data', (d) => { out += d })
      cp.stderr.on('data', (d) => { err += d })
      cp.on('close', (code) => {
        try {
          const lines = out.trim().split(/\r?\n/).filter(Boolean)
          resolve(JSON.parse(lines[lines.length - 1]))
        } catch (e) { reject(new Error(`build parse fail: ${out.slice(-300)} ${err.slice(-300)}`)) }
      })
      cp.on('error', reject)
    })
    const r = b?.result
    check('build: M9 G3 PASS', r?.validations_m9?.g3 === 'PASS', JSON.stringify(r?.validations_m9))
    check('build: M9 growth > 0', (r?.growth_g3_m9 ?? 0) > 0, r?.growth_g3_m9)
    check('build: 模型卡生成', !!r?.card, r?.card)
  } else if (!skipBuild) {
    skip('build（protein.faa -> M9）', `C58_protein.faa 不存在（${FAA ?? '未解析到'}）`)
  }

  // 6) l3_fix（B' 后半）：op 协议 + 防过补第五闸门 + 工具注册计数（不跑 L3 MILP，保持冒烟秒级）
  const l3p = await runPy('gem_ops.py', { op: 'l3_fix', args: {} })
  check('l3_fix: op 协议（缺 model 明确报错）',
    l3p?.ok === false && /model file not found/.test(l3p?.error || ''), JSON.stringify(l3p))
  const bg = await runPy('budget.py', { n_reactions: 2485, prior_added: 123, planned: 2 })
  check('l3_fix: 防过补第五闸门（124 预算超限 confirm_required）',
    bg?.error === 'budget_exceeded' && bg?.confirm_required === true, JSON.stringify(bg))
  const toolsSrc = readFileSync(join(REPO, 'src', 'tools.js'), 'utf8')
  const nReg = (toolsSrc.match(/ctx\.tools\.register\(/g) || []).length
  // 注意：这是源码正则计数（防手滑删注册）；**真注册验证**由 npm test 接线的
  // test/optional-injection.js（真实 plugin.apply()）承担——2026-09-19 审计 III-6。
  check('tools: 23 个语义化工具注册（源码计数）', nReg === 23, `got ${nReg}`)

  // 7) Q2 工程质量件：SBML 往返保真（GPR 防丢）+ 模型卡 v2 selftest
  if (HAS_MAIN) {
    const rt = await runPy('roundtrip_check.py', { model: C58 })
    check('往返保真: 计数一致 + GPR 无丢失（≥5 复合 GPR 精确对比）',
      rt?.ok === true && rt?.gpr_diffs === 0 && (rt?.gpr_compared ?? 0) >= 5,
      JSON.stringify(rt?.counts) + ` gpr=${rt?.gpr_total} compared=${rt?.gpr_compared} diffs=${rt?.gpr_diffs}`)
  } else {
    skip('往返保真（roundtrip_check）', 'C58 未找到')
  }
  const cardOk = await new Promise((resolve, reject) => {
    const cp = spawn(PY, ['-I', join(PYDIR, 'model_card.py'), '--selftest'], { cwd: PYDIR, windowsHide: true })
    let o = ''
    cp.stdout.on('data', (d) => { o += d })
    cp.on('close', () => {
      try { resolve(JSON.parse(o.trim().split(/\r?\n/).filter(Boolean).pop())) }
      catch (e) { reject(new Error('card selftest parse fail: ' + o.slice(-200))) }
    })
    cp.on('error', reject)
  })
  check('模型卡 v2: selftest（init/append 版本递增/legacy 迁移/phenotype/essential 形状）',
    cardOk?.ok === true && cardOk?.result?.selftest === 'pass', JSON.stringify(cardOk))

  // 8) M1 fluxscan：区间分离判定单测（锁定公式）+ op 协议 + 真实单条件锚点（~35s）
  const fsSelf = await new Promise((resolve, reject) => {
    const cp = spawn(PY, ['-I', join(PYDIR, 'fluxscan.py'), '--selftest'], { cwd: PYDIR, windowsHide: true })
    let o = ''
    cp.stdout.on('data', (d) => { o += d })
    cp.on('close', () => {
      try { resolve(JSON.parse(o.trim().split(/\r?\n/).filter(Boolean).pop())) }
      catch (e) { reject(new Error('fluxscan selftest parse fail: ' + o.slice(-200))) }
    })
    cp.on('error', reject)
  })
  check('fluxscan: 区间分离判定单测（锁定公式 分离/重叠/零通量/负向/精确边界/容差）',
    fsSelf?.ok === true && fsSelf?.result?.selftest === 'pass' && (fsSelf?.result?.cases ?? 0) >= 10,
    JSON.stringify(fsSelf))
  const fsp = await runPy('gem_ops.py', { op: 'fluxscan', args: {} })
  check('fluxscan: op 协议（缺 model 明确报错）',
    fsp?.ok === false && /model file not found/.test(fsp?.error || ''), JSON.stringify(fsp))
  if (HAS_MAIN) {
    const fsx = await runPy('gem_ops.py', {
      op: 'fluxscan',
      args: { model: C58, conditions: [{ name: 'AB', medium: { medium_name: 'AB' } }] },
    })
    check('fluxscan: AB 单条件 growth 0.519981（区间制路径）',
      fsx?.result?.conditions?.[0] && Math.abs(fsx.result.conditions[0].growth - 0.519981) < 1e-9,
      JSON.stringify(fsx?.result?.conditions?.[0]))
    check('fluxscan: 输出口径声明（units + fraction 0.9999）',
      fsx?.result?.units === 'mmol/gDW/h' && fsx?.result?.fraction_of_optimum === 0.9999,
      JSON.stringify({ units: fsx?.result?.units, f: fsx?.result?.fraction_of_optimum }))
  } else {
    skip('fluxscan: 真实条件锚点', 'C58 未找到')
  }

  // 9) M2 sensitivity：稳定性三分类 selftest + probe（GAM 载体定位，秒级）
  const sensSelf = await new Promise((resolve, reject) => {
    const cp = spawn(PY, ['-I', join(PYDIR, 'sensitivity.py'), '--selftest'], { cwd: PYDIR, windowsHide: true })
    let o = ''
    cp.stdout.on('data', (d) => { o += d })
    cp.on('close', () => {
      try { resolve(JSON.parse(o.trim().split(/\r?\n/).filter(Boolean).pop())) }
      catch (e) { reject(new Error('sensitivity selftest parse fail: ' + o.slice(-200))) }
    })
    cp.on('error', reject)
  })
  check('sensitivity: 稳定性三分类 selftest（always/conditional/never）',
    sensSelf?.ok === true && sensSelf?.result?.selftest === 'pass', JSON.stringify(sensSelf))
  if (HAS_MAIN) {
    const sensProbe = await runPy('gem_ops.py', {
      op: 'sensitivity', args: { model: C58, action: 'probe' },
    })
    check('sensitivity: probe 定位 GAM 载体（bio1 内部 stub，GAM_ORIG=40）',
      sensProbe?.result?.biomass_rxn === 'bio1' && sensProbe?.result?.carrier_type === 'inside_biomass'
      && Math.abs((sensProbe?.result?.gam_orig ?? 0) - 40.0) < 1e-6,
      JSON.stringify(sensProbe?.result))
  } else {
    skip('sensitivity: probe', 'C58 未找到')
  }

  // 10) M3 ledger：幂等/容错 selftest + gem_report 账本摘要 e2e（临时账本，含坏行）
  const ledSelf = await new Promise((resolve, reject) => {
    const cp = spawn(PY, ['-I', join(PYDIR, 'ledger.py'), '--selftest'], { cwd: PYDIR, windowsHide: true })
    let o = ''
    cp.stdout.on('data', (d) => { o += d })
    cp.on('close', () => {
      try { resolve(JSON.parse(o.trim().split(/\r?\n/).filter(Boolean).pop())) }
      catch (e) { reject(new Error('ledger selftest parse fail: ' + o.slice(-200))) }
    })
    cp.on('error', reject)
  })
  check('ledger: selftest（登记/幂等/前缀 query/update/坏行容错）',
    ledSelf?.ok === true && ledSelf?.result?.selftest === 'pass', JSON.stringify(ledSelf))
  const tmpLedgerDir = mkdtempSync(join(tmpdir(), 'gem-smoke-ledger-'))
  const tmpLedger = join(tmpLedgerDir, 'predictions.jsonl')
  writeFileSync(tmpLedger, [
    JSON.stringify({ prediction_id: 'P0001', type: 'essentiality', content: 'g1 在 AB 培养基下必需',
      model: C58 ?? '(n/a)', condition: 'AB', status: 'unverified', evidence_tier: 'EVIDENCE_rule' }),
    JSON.stringify({ prediction_id: 'P0002', type: 'phenotype', content: '底物 X 预测生长',
      model: C58 ?? '(n/a)', condition: 'AB/sole', status: 'literature_supported', evidence_tier: 'EVIDENCE_literature' }),
    '{"corrupt line...\n',
  ].join('\n'))
  if (HAS_MAIN) {
    const miLedger = await runPy('gem_ops.py', { op: 'model_info', args: { model: C58P1, ledger_path: tmpLedger } })
    check('gem_report: ledger_summary（2 行 + by_status/by_type + corrupt 1 不阻塞 + deprecated_count 字段）',
      miLedger?.result?.ledger_summary?.total === 2
      && miLedger?.result?.ledger_summary?.corrupt_rows === 1
      && miLedger?.result?.ledger_summary?.by_status?.unverified === 1
      && miLedger?.result?.ledger_summary?.by_status?.literature_supported === 1
      && typeof miLedger?.result?.ledger_summary?.deprecated_count === 'number'
      && typeof miLedger?.result?.ledger_context === 'string',
      JSON.stringify(miLedger?.result?.ledger_summary))
  } else {
    skip('gem_report: ledger_summary e2e', 'C58_P1 未找到')
  }
  const ledUpdate = await runPy('gem_ops.py', { op: 'ledger', args: { action: 'update',
    prediction_id: 'P0002', status: 'experimentally_verified', ledger_path: tmpLedger } })
  check('gem_ledger: op update（P0002 -> experimentally_verified）',
    ledUpdate?.ok === true && ledUpdate?.result?.row?.status === 'experimentally_verified',
    JSON.stringify(ledUpdate))
  const ledQuery = await runPy('gem_ops.py', { op: 'ledger', args: { action: 'query',
    status: 'experimentally_verified', ledger_path: tmpLedger } })
  check('gem_ledger: op query（更新后可过滤）',
    ledQuery?.ok === true && ledQuery?.result?.matched === 1, JSON.stringify(ledQuery?.result?.matched))

  // 11) 阶段A遗留修正：退化护栏（wt<=EPS 必需性判定恒真 -> 不登记 ledger）
  if (HAS_INX4) {
    const tmpDegDir = mkdtempSync(join(tmpdir(), 'gem-smoke-deg-'))
    const tmpDegLedger = join(tmpDegDir, 'predictions.jsonl')
    const deg = await runPy('gem_ops.py', { op: 'essential_scan', args: { model: INX4, ledger_path: tmpDegLedger } })
    check('退化护栏: v4 wt=0 不登记（degraded=true, appended=0, skipped_degraded=1066, 账本文件未创建）',
      deg?.result?.ledger_registration?.degraded === true
      && deg?.result?.ledger_registration?.appended === 0
      && deg?.result?.ledger_registration?.skipped_degraded === 1066
      && !existsSync(tmpDegLedger),
      JSON.stringify(deg?.result?.ledger_registration))
  } else {
    skip('退化护栏（essential_scan v4）', 'iNX1344_v4.xml 未找到')
  }

  // 12) 阶段B-B1：介质两级策略（C58 零影响 + v4 boundary 回退）+ gem_benchmark 自检用例
  if (HAS_MAIN) {
    const mrC58 = await runPy('gem_ops.py', { op: 'media_resolve', args: { model: C58, medium: { medium_name: 'AB' } } })
    check('介质两级策略: C58 boundary_style=false（零影响硬保证）且 20 EX/0 unresolved',
      mrC58?.result?.boundary_style === false && (mrC58?.result?.resolved_exchanges ?? []).length === 20
      && (mrC58?.result?.unresolved ?? []).length === 0,
      JSON.stringify({ bs: mrC58?.result?.boundary_style, n: mrC58?.result?.resolved_exchanges?.length }))
  } else {
    skip('介质两级策略（C58）', 'C58 未找到')
  }
  if (HAS_INX4) {
    const mrV4 = await runPy('gem_ops.py', { op: 'media_resolve', args: { model: INX4, medium: { medium_name: 'AB' } } })
    check('介质两级策略: v4 boundary 回退启用（boundary_style=true，resolved==15，含规范展示名）',
      mrV4?.result?.boundary_style === true && (mrV4?.result?.resolved_exchanges ?? []).length === 15
      && (mrV4?.result?.resolved_display ?? []).some((s) => s.includes('boundary-derived')),
      JSON.stringify({ bs: mrV4?.result?.boundary_style, n: mrV4?.result?.resolved_exchanges?.length,
        sample: (mrV4?.result?.resolved_display ?? []).slice(0, 2) }))
  } else {
    skip('介质两级策略（v4）', 'iNX1344_v4.xml 未找到')
  }
  if (HAS_MAIN) {
    const benchSelf = await runPy('gem_ops.py', {
      op: 'benchmark',
      args: { model_a: C58, model_b: C58P1, medium: { medium_name: 'AB' },
              phenotype_table: 'D:/Program/hermes/temp/gem_test_phenotype.tsv',
              ledger_refs: false },
    })
    const bs = benchSelf?.result ?? {}
    const bSuc = (bs.phenotype?.table ?? []).find((r) => r.substrate === 'Sucrose')
    check('benchmark 自检 C58 vs C58_P1: 反应差方向正确（P1 多 7: 2492>2485）',
      bs?.reproducibility?.a?.reactions === 2485 && bs?.reproducibility?.b?.reactions === 2492,
      JSON.stringify({ a: bs?.reproducibility?.a?.reactions, b: bs?.reproducibility?.b?.reactions }))
    check('benchmark 自检: 蔗糖条件生长差已知方向（A sole 0 vs B 0.97077）',
      bSuc && bSuc.a_predicted === 0 && Math.abs((bSuc.b_growth ?? 0) - 0.97077) < 0.01,
      JSON.stringify(bSuc))
    check('benchmark 自检: 必需性一致（a_count==b_count 且 a_only/b_only 均空，映射 identity 覆盖 1.0）',
      bs?.essentiality?.a_count === bs?.essentiality?.b_count
      && (bs?.essentiality?.a_only ?? ['x']).length === 0
      && (bs?.essentiality?.b_only ?? ['x']).length === 0
      && bs?.essentiality?.mapping?.coverage_ratio === 1.0,
      JSON.stringify({ a: bs?.essentiality?.a_count, b: bs?.essentiality?.b_count,
        ao: bs?.essentiality?.a_only?.length, bo: bs?.essentiality?.b_only?.length,
        cov: bs?.essentiality?.mapping?.coverage_ratio }))
  } else {
    skip('benchmark 自检（C58 vs C58_P1）', '主模型未找到')
  }
  const benchProto = await runPy('gem_ops.py', { op: 'benchmark', args: { model_a: 'NOPE.xml' } })
  check('benchmark: op 协议（model_a 不存在明确报错）',
    benchProto?.ok === false && /model_a file not found/.test(benchProto?.error || ''), JSON.stringify(benchProto))

  // 13) 阶段C-C1：gem_secretion 可分泌谱（真实小用例 C58 ~23s + 退化护栏 + op 协议）
  const secProto = await runPy('gem_ops.py', { op: 'secretion', args: {} })
  check('secretion: op 协议（缺 model 明确报错）',
    secProto?.ok === false && /model file not found/.test(secProto?.error || ''), JSON.stringify(secProto))
  const tmpSecDir = mkdtempSync(join(tmpdir(), 'gem-smoke-sec-'))
  const tmpSecLedger = join(tmpSecDir, 'predictions.jsonl')
  if (HAS_MAIN) {
    const secC58 = await runPy('gem_ops.py', {
      op: 'secretion',
      args: { model: C58, medium: { medium_name: 'AB' }, ledger_path: tmpSecLedger },
    })
    check('secretion: C58 真实谱（85 可分泌，边界声明内置，H2O/CO2 可行）',
      secC58?.result?.secretable_count === 85
      && /未考虑毒性\/渗透压\/调控/.test(secC58?.result?.boundary_note || '')
      && (secC58?.result?.results ?? []).some((r) => r.met_id === 'cpd00001_e0' && r.feasible)
      && (secC58?.result?.results ?? []).some((r) => r.met_id === 'cpd00011_e0' && r.feasible),
      JSON.stringify({ n: secC58?.result?.secretable_count, t: secC58?.result?.timing_seconds }))
    check('secretion: 账本登记（85 条 type=secretion，幂等）',
      secC58?.result?.ledger_registration?.appended === 85,
      JSON.stringify(secC58?.result?.ledger_registration))
  } else {
    skip('secretion: C58 真实谱', 'C58 未找到')
  }
  if (HAS_INX4) {
    const degV4 = await runPy('gem_ops.py', {
      op: 'secretion', args: { model: INX4, ledger_path: join(tmpSecDir, 'deg.jsonl') },
    })
    check('secretion: 退化护栏（v4 wt=0 -> degenerate=true 不扫描不登记）',
      degV4?.result?.degenerate === true && degV4?.result?.results === undefined
      && !existsSync(join(tmpSecDir, 'deg.jsonl')),
      JSON.stringify(degV4?.result?.degenerate_note?.slice(0, 60)))
  } else {
    skip('secretion: 退化护栏（v4）', 'iNX1344_v4.xml 未找到')
  }

  // 14) 阶段C-C2：gem_double_knockout 双敲（op 协议 + 退化护栏 + 预算语义；真实锚点 Atu3364-Atu4682
  //     模型内对应 NC_003063_2_1618/352 见 phaseC 报告，smoke 不重跑全量 4min）
  const dkProto = await runPy('gem_ops.py', { op: 'double_knockout', args: {} })
  check('double_knockout: op 协议（缺 model 明确报错）',
    dkProto?.ok === false && /model file not found/.test(dkProto?.error || ''), JSON.stringify(dkProto))
  if (HAS_INX4) {
    const degDk = await runPy('gem_ops.py', {
      op: 'double_knockout', args: { model: INX4, ledger_path: join(tmpSecDir, 'dk.jsonl') },
    })
    check('double_knockout: 退化护栏（v4 wt=0 -> degenerate=true 不扫描不登记）',
      degDk?.result?.degenerate === true && degDk?.result?.results === undefined
      && !existsSync(join(tmpSecDir, 'dk.jsonl')),
      JSON.stringify(degDk?.result?.degenerate_note?.slice(0, 60)))
  } else {
    skip('double_knockout: 退化护栏（v4）', 'iNX1344_v4.xml 未找到')
  }

  // 15) 阶段C-C3：gem_enrichment 通路富集（真实 C58 ~3s + 无注释兜底）
  if (HAS_MAIN && ledgerReady(C58)) {
    const enr = await runPy('gem_ops.py', {
      op: 'enrichment', args: { model: C58, export_csv: join(tmpSecDir, 'enr.csv') },
    })
    check('enrichment: C58 真实富集（通路注释可用，388 通路，FDR 字段存在，肽聚糖/TCA 类核心通路在列）',
      enr?.result?.annotation_unavailable === false
      && enr?.result?.pathways_tested === 388
      && (enr?.result?.results ?? []).every((r) => typeof r.p_value === 'number' && typeof r.fdr === 'number')
      && (enr?.result?.results ?? []).some((r) => r.pathway.includes('PEPTIDOGLYCANSYN')),
      JSON.stringify({ tested: enr?.result?.pathways_tested, sig: enr?.result?.significant_count_fdr05 }))
  } else if (HAS_MAIN) {
    skip('enrichment: C58 真实富集', `默认账本缺失/为空（${join(LEDGER_DIR, 'C58.jsonl')}）——富集输入基因来自账本`)
  } else {
    skip('enrichment: C58 真实富集', 'C58 未找到')
  }
  const imlPath = join(homedir(), '.dsh', 'dsh-bio-gem', 'models', 'bigg_iML1515.xml')
  if (existsSync(imlPath)) {
    const enrIm = await runPy('gem_ops.py', { op: 'enrichment', args: { model: imlPath } })
    check('enrichment: 无注释模型兜底（iML1515 annotation_unavailable=true 不伪造通路）',
      enrIm?.result?.annotation_unavailable === true && enrIm?.result?.groups_found === 0,
      JSON.stringify(enrIm?.result?.note?.slice(0, 50)))
  } else {
    skip('enrichment: 无注释兜底（iML1515）', `本地模型不存在（${imlPath}）`)
  }

  // 16) 阶段C-C4：gem_targets 靶点规范导出（真实账本三类闭合 + schema）
  if (HAS_MAIN && ledgerReady(C58)) {
    const tgt = await runPy('gem_ops.py', {
      op: 'targets',
      args: { model: C58, export_path: join(tmpSecDir, 'targets.csv') },
    })
    check('targets: 三类导出与账本计数闭合（closure per type 全 true；基线 258 行必在）',
      Object.values(tgt?.result?.count_closure ?? {}).every((c) => c.closed === true)
      && tgt?.result?.exported_count >= 258
      && tgt?.result?.schema_fields?.length >= 8,
      JSON.stringify(tgt?.result?.count_closure))
    check('targets: schema 行样例（三类各 >=1 行，target_id T0001 递增，source 带账本 ID）',
      (tgt?.result?.rows ?? []).filter((r) => r.type === 'essentiality').length >= 1
      && (tgt?.result?.rows ?? []).filter((r) => r.type === 'synthetic_lethal').length >= 1
      && (tgt?.result?.rows ?? []).filter((r) => r.type === 'secretion').length >= 1
      && tgt?.result?.rows?.[0]?.target_id === 'T0001'
      && /^ledger:P\d+$/.test(tgt?.result?.rows?.[0]?.source || ''),
      JSON.stringify(tgt?.result?.rows?.[0]))
  } else if (HAS_MAIN) {
    skip('targets: 靶点规范导出', `默认账本缺失/为空（${join(LEDGER_DIR, 'C58.jsonl')}）——导出数据源为账本`)
  } else {
    skip('targets: 靶点规范导出', 'C58 未找到')
  }

  console.log(`\n结果: ${passed} 通过 / ${failed} 失败 / ${skipped} 跳过`)
  if (skipped > 0) {
    console.log(`提示: ${skipped} 项因资产缺失被跳过${requireAssets ? '（--require-assets 模式：视为失败）' : ''}`)
  }
  process.exit(failed ? 1 : (requireAssets && skipped ? 1 : 0))
}

main().catch((e) => { console.error('smoke 异常:', e.message); process.exit(1) })
