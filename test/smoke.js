// test/smoke.js — dsh-bio-galatea 回归冒烟（node 直测 Python 层，不依赖 dsh）
// 用法: node test/smoke.js [--heavy]
//   L1 协议/逻辑测试（总是跑）：status 结构 / cluster 聚类 / 错误契约（不做假成功）
//   L2 组件测试（biopython 就绪才跑，否则 SKIP）：score / interface / inspect（用 fixture 结构）
//   L3 重组件测试（--heavy 且组件就绪才跑）：mpnn（真实设计）/ fold（真实折叠）
//
// 解释器选择链（与 src/python.js 对齐）：GALATEA_PYTHON > 私有 venv > CONDA_PREFIX > 兜底
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')
const PYDIR = join(REPO, 'python')
const FIXTURE = join(REPO, 'test', 'fixtures', 'mini-complex.pdb')
const DATA_ROOT = join(homedir(), '.dsh', 'dsh-bio-galatea')
const HEAVY = process.argv.includes('--heavy')

function pickPython() {
  if (process.env.GALATEA_PYTHON && existsSync(process.env.GALATEA_PYTHON)) return process.env.GALATEA_PYTHON
  const wx = join(DATA_ROOT, 'venv', 'Scripts', 'python.exe')
  const px = join(DATA_ROOT, 'venv', 'bin', 'python')
  if (process.platform === 'win32' && existsSync(wx)) return wx
  if (existsSync(px)) return px
  if (process.env.CONDA_PREFIX) {
    const c = join(process.env.CONDA_PREFIX, process.platform === 'win32' ? 'python.exe' : 'bin/python')
    if (existsSync(c)) return c
  }
  return process.platform === 'win32' ? 'python.exe' : 'python3'
}

const PY = pickPython()

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

function runOp(op, args, timeoutMs = 180000) {
  return new Promise((resolve) => {
    const cp = spawn(PY, ['-B', '-I', join(PYDIR, 'galatea_ops.py')], { cwd: PYDIR, windowsHide: true })
    let out = ''
    let err = ''
    cp.stdout.on('data', (d) => { out += d })
    cp.stderr.on('data', (d) => { err += d })
    const timer = setTimeout(() => { try { cp.kill() } catch {} }, timeoutMs)
    cp.on('close', (code) => {
      clearTimeout(timer)
      let json = null
      try { json = JSON.parse(out.trim().split('\n').pop()) } catch {}
      resolve({ code, out, err, json })
    })
    cp.stdin.write(JSON.stringify({ op, args }))
    cp.stdin.end()
  })
}

console.log(`smoke: python = ${PY}`)
console.log(`smoke: fixture = ${existsSync(FIXTURE) ? 'ok' : 'MISSING (run test/fixtures/gen-mini-complex.py)'}`)
console.log()

// ── L1 协议 / 逻辑 ──────────────────────────────────────────────────────────
console.log('L1 协议与逻辑')

{
  const r = await runOp('status', {})
  check('status: JSON 协议收尾', r.code === 0 && r.json !== null, `code=${r.code}`)
  check('status: ok=true 且有 result', r.json?.ok === true && !!r.json?.result)
  check('status: python.executable 字段', typeof r.json?.result?.python?.executable === 'string')
  check('status: components 三块（analysis/mpnn/esmfold）',
    !!r.json?.result?.components?.analysis && !!r.json?.result?.components?.mpnn && !!r.json?.result?.components?.esmfold)
  check('status: device 字段', !!r.json?.result?.device)
}

{
  const r = await runOp('cluster', {
    // 0,1 相同；2 完全不相关；3 与 0 差 2/11=0.818 < 0.9 → 三簇
    sequences: ['MKTAYIAKQRQ', 'MKTAYIAKQRQ', 'LKDEPQRTVA', 'MKTAYIAKQAA'],
    threshold: 0.9,
  })
  const res = r.json?.result
  check('cluster: 4 序列 → 3 簇（0,1 同簇；2/3 各独簇@0.9）', res?.n_clusters === 3, `got ${res?.n_clusters}`)
  check('cluster: 簇结构完整', Array.isArray(res?.clusters) && res.clusters.every((c) => c.representative_seq && Array.isArray(c.members)))
}

{
  const r = await runOp('cluster', { sequences: ['ACDEFGHIKL', 'ACDEFGHIKL'], threshold: 0.5 })
  check('cluster: 完全相同 → 1 簇', r.json?.result?.n_clusters === 1)
}

{
  const r = await runOp('rank.consensus', {
    candidates: JSON.stringify([
      { candidate_id: 'c1', ipsae_min_p1: 0.9, ipsae_min_p2: 0.8 },
      { candidate_id: 'c2', ipsae_min_p1: 0.5, ipsae_min_p2: 0.4 },
      { candidate_id: 'c3', ipsae_min_p1: 0.7, ipsae_min_p2: 0.6 },
    ]),
  })
  const res = r.json?.result
  check('rank: 共识均值（c1=0.85）与排序', res?.ranking?.[0]?.candidate_id === 'c1' &&
    Math.abs((res?.ranking?.[0]?.consensus ?? 0) - 0.85) < 1e-9, JSON.stringify(res?.ranking?.[0]).slice(0, 160))
  check('rank: strong 档（0.85 ≥ 0.73）', res?.ranking?.[0]?.tier === 'strong')
  check('rank: 全表排序单调不增', Array.isArray(res?.ranking) &&
    res.ranking.every((row, i) => i === 0 || res.ranking[i - 1].consensus >= row.consensus))
}

{
  const outCsv = join(tmpdir(), `galatea-rank-smoke-${Date.now()}.csv`)
  const r = await runOp('rank.aggregate', {
    batches: JSON.stringify([
      { batch_id: 'b1', candidates: [{ candidate_id: 'x1', ipsae_min_p1: 0.9 }, { candidate_id: 'x2', ipsae_min_p1: 0.3 }] },
      { batch_id: 'b2', candidates: [{ candidate_id: 'y1', ipsae_min_p1: 0.7 }, { candidate_id: 'y2', ipsae_min_p1: 0.5 }] },
    ]),
    output_csv: outCsv,
  })
  const res = r.json?.result
  check('rank.aggregate: 2 批 4 候选 → 全局重排 + CSV 落盘', res?.n_batches === 2 &&
    res?.ranking?.length === 4 && existsSync(outCsv), `n=${res?.ranking?.length}`)
  check('rank.aggregate: 跨批首位（x1=0.9）', res?.ranking?.[0]?.candidate_id === 'x1')
  try { rmSync(outCsv, { force: true }) } catch {}
}

{
  const campaignDir = mkdtempSync(join(tmpdir(), 'galatea-loop-smoke-'))
  const emptyCampaignDir = mkdtempSync(join(tmpdir(), 'galatea-loop-empty-'))
  const sequenceBase = 'ACDEFGHIKLMNPQRSTVWY'.repeat(3)
  function loopCandidates(roundIndex) {
    const candidates = Array.from({ length: 18 }, (_, index) => {
      const center = 0.40 + index * 0.025 + roundIndex * 0.006
      const spread = index % 3 === 0 ? 0.12 : 0.01
      const sequence = sequenceBase.split('')
      for (let mutation = 0; mutation < index * 7; mutation++) {
        sequence[(mutation * 7 + index) % sequence.length] = 'ACDEFGHIKLMNPQRSTVWY'[(index + mutation) % 20]
      }
      return {
        candidate_id: `${roundIndex ? 'y' : 'x'}${index}`,
        ...(roundIndex ? { parent_id: `x${index}` } : {}),
        scores: { p1: center + spread, p2: center - spread },
        sequence: sequence.join(''),
        qc_status: index % 2 ? 'PASS' : 'WARN',
      }
    })
    candidates.push({
      candidate_id: `fail_${roundIndex}`,
      ...(roundIndex ? { parent_id: 'x0' } : {}),
      scores: { p1: 0.999, p2: 0.999 },
      sequence: sequenceBase,
      qc_status: 'FAIL',
    })
    return candidates
  }

  try {
    const firstLog = await runOp('loop', {
      action: 'log', campaign_dir: campaignDir,
      round: { round_id: 0, candidates: loopCandidates(0), notes: 'synthetic round zero' },
    })
    const secondLog = await runOp('loop', {
      action: 'log', campaign_dir: campaignDir,
      round: { round_id: 1, candidates: loopCandidates(1), notes: 'synthetic round one' },
    })
    check('loop.log: 两轮登记并建立 rounds 索引', firstLog.json?.ok === true &&
      secondLog.json?.ok === true && secondLog.json?.rounds_total === 2)

    const duplicate = await runOp('loop', {
      action: 'log', campaign_dir: campaignDir,
      round: { round_id: 1, candidates: loopCandidates(1) },
    })
    check('loop.log: 重复 round_id 明确报错', duplicate.json?.ok === false &&
      /already exists/.test(duplicate.json?.error || ''))

    const nextArgs = { action: 'next', campaign_dir: campaignDir }
    const next = await runOp('loop', nextArgs)
    const plan = next.json?.round_plan
    const parents = plan?.parents || []
    const localCounts = parents[0]?.operators?.map((operator) => operator.n) || []
    check('loop.next: 父本目标落在 [min_parents,max_parents]',
      parents.length >= 8 && parents.length <= 16, `n=${parents.length}`)
    check('loop.next: 本地与云端配额总和正确',
      parents.every((parent) => parent.n_local === 32 && parent.n_cloud === 6 &&
        parent.operators.reduce((sum, operator) => sum + operator.n, 0) === 32) &&
      plan?.budget?.local_sequences === parents.length * 32 &&
      plan?.budget?.cloud_predictions === parents.length * 6,
      JSON.stringify(plan?.budget))
    check('loop.next: FAIL 候选被资格门挡在所有父本池外',
      plan?.eligibility?.excluded_qc_fail === 1 && parents.every((parent) => !parent.candidate_id.startsWith('fail_')))
    check('loop.next: 默认本地操作配额为 16/8/8',
      JSON.stringify(localCounts) === JSON.stringify([16, 8, 8]), JSON.stringify(localCounts))
    console.log('  synthetic campaign sample:', JSON.stringify({
      round: plan?.round,
      n_parents: parents.length,
      first_parent: parents[0] && {
        candidate_id: parents[0].candidate_id,
        role: parents[0].role,
        n_local: parents[0].n_local,
        n_cloud: parents[0].n_cloud,
      },
      budget: plan?.budget,
    }))

    const nextAgain = await runOp('loop', nextArgs)
    check('loop.next: 同输入双跑输出深度相等',
      nextAgain.json?.ok === true && JSON.stringify(next.json) === JSON.stringify(nextAgain.json))

    const status = await runOp('loop', { action: 'status', campaign_dir: campaignDir })
    check('loop.status: 汇总两轮、谱系、推广统计和最新计划路径',
      status.json?.ok === true && status.json?.status?.rounds === 2 &&
      status.json?.status?.n_lineages > 0 &&
      Array.isArray(status.json?.status?.promoted_rate_per_round) &&
      status.json?.status?.latest_plan_path === next.json?.plan_path)

    writeFileSync(join(emptyCampaignDir, 'campaign.json'), JSON.stringify({
      schema_version: 1, campaign_id: 'empty', rounds: [], operator_stats: {},
    }))
    const emptyNext = await runOp('loop', { action: 'next', campaign_dir: emptyCampaignDir })
    check('loop.next: 空战役明确报错', emptyNext.json?.ok === false &&
      /no logged rounds/.test(emptyNext.json?.error || ''))
  } finally {
    rmSync(campaignDir, { recursive: true, force: true })
    rmSync(emptyCampaignDir, { recursive: true, force: true })
  }
}

{
  const r = await runOp('rank.consensus', { candidates: 'not-json-plain-string' })
  check('rank: 非法输入不做假成功', !(r.json?.ok === true && r.json?.result != null), JSON.stringify(r.json).slice(0, 140))
}

{
  // 错误契约：未知 op 不得伪装成功（允许 ok:false 或 ok:true+error_hint+result:null）
  const r = await runOp('definitely_not_an_op', {})
  const noFalseSuccess = !(r.json?.ok === true && r.json?.result != null && !r.json?.error_hint)
  check('错误契约: 未知 op 不做假成功', r.code === 0 && r.json !== null && noFalseSuccess, JSON.stringify(r.json).slice(0, 160))
}

// ── L2 组件测试（biopython） ─────────────────────────────────────────────────
console.log()
console.log('L2 组件（biopython 分析链）')

const bioProbe = await runOp('score', { sequences: ['MKTAYIAKQRQ'] })
const hasBio = bioProbe.json?.result != null && Array.isArray(bioProbe.json?.result?.scores)
if (!hasBio) {
  skip('score: 序列理化打分', `biopython 不可用（${(bioProbe.json?.error_hint || bioProbe.err || '').slice(0, 100)}）`)
} else {
  const s = bioProbe.json.result.scores[0]
  check('score: length 正确', s?.length === 11)
  check('score: pI 在 0-14 合理区间', typeof s?.pI === 'number' && s.pI >= 0 && s.pI <= 14, `pI=${s?.pI}`)
  check('score: 含电荷与疏水字段', typeof s?.gravy === 'number' && (s?.net_charge !== undefined || s?.net_charge_pH74 !== undefined || s?.net_charge_pH7_4 !== undefined), JSON.stringify(Object.keys(s || {})).slice(0, 220))
}

if (!existsSync(FIXTURE)) {
  skip('interface: fixture 缺失', 'run test/fixtures/gen-mini-complex.py')
} else if (!hasBio) {
  skip('interface: 复合物界面分析', 'biopython 不可用')
} else {
  const r = await runOp('interface', { complex_pdb: FIXTURE, partner_a: 'A', partner_b: 'B' })
  const res = r.json?.result
  check('interface: 两链识别', JSON.stringify(res?.chains || []) === JSON.stringify(['A', 'B']), JSON.stringify(res?.chains))
  check('interface: 检出链间接触（fixture 设计为有接触）', (res?.n_contacts_atom_level ?? 0) > 0, `n_contacts_atom_level=${res?.n_contacts_atom_level}`)
  check('interface: SASA 埋藏面积为正', (res?.sasa?.buried_area ?? 0) > 0, `buried=${res?.sasa?.buried_area}`)
}

if (existsSync(FIXTURE) && hasBio) {
  const r = await runOp('inspect', { pdb: FIXTURE })
  const res = r.json?.result
  check('inspect: 链清单与原子数', Array.isArray(res?.chains) && res.chains.length === 2 && (res?.total_atoms ?? 0) === 24, JSON.stringify({ chains: res?.chains?.length, atoms: res?.total_atoms }))
} else if (!hasBio) {
  skip('inspect: 结构 QC', 'biopython 不可用')
}

// ── L3 重组件（--heavy） ─────────────────────────────────────────────────────
console.log()
if (!HEAVY) {
  skip('mpnn: 真实序列设计', '默认跳过（--heavy 且 mpnn 组件就绪时运行）')
  skip('fold: 真实折叠', '默认跳过（--heavy 且 esmfold 就绪时运行）')
} else {
  const st = await runOp('status', {})
  const mpnnReady = st.json?.result?.components?.mpnn?.ready === true
  if (!mpnnReady) {
    skip('mpnn: 真实序列设计', '组件未就绪（galatea_setup action=mpnn）')
  } else if (!existsSync(join(REPO, 'test', 'fixtures', '1ubq.pdb'))) {
    skip('mpnn: 真实序列设计', 'fixture 1ubq.pdb 缺失')
  } else {
    const r = await runOp('mpnn', { pdb: join(REPO, 'test', 'fixtures', '1ubq.pdb'), num_seqs: 2, temperature: 0.1 }, 600000)
    const res = r.json?.result
    check('mpnn: 产出 >=2 条设计序列', (res?.num_designs ?? 0) >= 2, JSON.stringify(r.json).slice(0, 200))
    const seqs = res?.designs?.map((d) => d.seq) || []
    check('mpnn: 序列全部合法（单字母氨基酸）', seqs.length > 0 && seqs.every((s) => /^[ACDEFGHIKLMNPQRSTVWY]+$/.test(s)))
    check('mpnn: overall_confidence 解析到位', seqs.length > 0 && res?.designs?.every((d) => typeof d.overall_confidence === 'number'))
    check('mpnn: native 序列已分离', typeof res?.native?.seq === 'string' && res.native.seq.length === 76)
  }

  const esmReady = st.json?.result?.components?.esmfold?.ready === true
  if (!esmReady) {
    skip('fold: 真实折叠', '组件未就绪（galatea_setup action=esmfold）')
  } else {
    const r = await runOp('fold', { sequences: ['MKTAYIAKQRQISFVKSHFSRQDILDLWIYHTQGYFPDWQNY'], device: 'cpu' }, 1500000)
    const res = r.json?.result
    const rec = res?.results?.[0]
    check('fold: 产出 PDB 与 pLDDT', !!rec?.pdb && typeof rec?.mean_plddt === 'number', JSON.stringify(r.json).slice(0, 200))
    check('fold: PDB 文件落盘', !!rec?.pdb && existsSync(rec.pdb))
  }
}

console.log()
console.log(`smoke: ${passed} pass / ${failed} fail / ${skipped} skip`)
if (failed > 0) process.exitCode = 1
