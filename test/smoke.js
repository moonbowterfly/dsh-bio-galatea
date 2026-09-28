// test/smoke.js — dsh-bio-galatea 回归冒烟（node 直测 Python 层，不依赖 dsh）
// 用法: node test/smoke.js [--heavy]
//   L1 协议/逻辑测试（总是跑）：status 结构 / cluster 聚类 / 错误契约（不做假成功）
//   L2 组件测试（biopython 就绪才跑，否则 SKIP）：score / interface / inspect（用 fixture 结构）
//   L3 重组件测试（--heavy 且组件就绪才跑）：mpnn（真实设计）/ fold（真实折叠）
//
// 解释器选择链（与 src/python.js 对齐）：GALATEA_PYTHON > 私有 venv > CONDA_PREFIX > 兜底
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

function runOpWithHashSeed(op, args, seed, timeoutMs = 180000) {
  return new Promise((resolve) => {
    // Deliberately omit -I here so Python honors different PYTHONHASHSEED values.
    const cp = spawn(PY, ['-B', join(PYDIR, 'galatea_ops.py')], {
      cwd: PYDIR, windowsHide: true,
      env: { ...process.env, PYTHONHASHSEED: String(seed) },
    })
    let out = ''
    let err = ''
    const timer = setTimeout(() => { try { cp.kill() } catch {} }, timeoutMs)
    cp.stdout.on('data', (d) => { out += d })
    cp.stderr.on('data', (d) => { err += d })
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

function runPythonSnippet(source, timeoutMs = 180000) {
  return new Promise((resolve) => {
    const cp = spawn(PY, ['-B', '-I', '-c', source], { cwd: PYDIR, windowsHide: true })
    let out = ''
    let err = ''
    const timer = setTimeout(() => { try { cp.kill() } catch {} }, timeoutMs)
    cp.stdout.on('data', (d) => { out += d })
    cp.stderr.on('data', (d) => { err += d })
    cp.on('close', (code) => {
      clearTimeout(timer)
      let json = null
      try { json = JSON.parse(out.trim().split('\n').pop()) } catch {}
      resolve({ code, out, err, json })
    })
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
  const temp = mkdtempSync(join(tmpdir(), 'galatea-contact-cluster-smoke-'))
  const out = join(temp, 'clusters.json')
  const t1 = join(temp, 'T1')
  const artifactPaths = {}
  function writeArtifact(targetDir, id, residues, targetId = undefined) {
    const dir = join(temp, targetDir)
    const path = join(dir, `contact_consensus_${id}_jaccard.json`)
    const pair_frequency = Object.fromEntries(residues.flatMap(([label, frequency]) => [
      [`B1|${label}`, frequency], [`B2|${label}`, frequency / 2],
    ]))
    mkdirSync(dir, { recursive: true })
    writeFileSync(path, JSON.stringify({
      candidate_id: id, ...(targetId ? { target_id: targetId } : {}),
      pair_frequency, anchor_residues: ['B42'],
    }))
    artifactPaths[id] = path
  }
  const labels = (start, end, prefix = 'A') => Array.from(
    { length: end - start + 1 }, (_, index) => [`${prefix}${start + index}`, 1])
  writeArtifact('T1', 'A', labels(1, 10))
  writeArtifact('T1', 'B', [...labels(1, 1), ...Array.from({ length: 6 }, (_, index) => [`A${index + 2}`, 0.5])])
  writeArtifact('T1', 'C', [...labels(1, 6), ['A11', 1]])
  writeArtifact('T1', 'D', labels(1, 10))
  writeArtifact('T1', 'E', labels(1, 10, 'X'))

  try {
    const args = { artifacts: Object.values(artifactPaths), out }
    const first = await runOp('contact_cluster', args)
    const firstBytes = readFileSync(out)
    const output = JSON.parse(firstBytes.toString('utf8'))
    const byId = Object.fromEntries(output.candidates.map((candidate) => [candidate.design_id, candidate]))
    check('contact_cluster: 5 个合成 artifact，target Jaccard 精确值与跨 target 配对数',
      first.json?.ok === true && output.summary.n_candidates === 5 &&
      byId.A.nearest_contact_jaccard === 1.0 && byId.E.nearest_contact_jaccard === 0.0 &&
      Math.abs(byId.B.nearest_contact_jaccard - 0.75) < 1e-12 &&
      byId.B.target_footprint_freq.A1 === 1.0 && byId.B.target_footprint_freq.A2 === 0.5 &&
      output.summary.n_within_target_pairs === 10 &&
      output.summary.n_cross_target_pairs_compared === 0,
      JSON.stringify({ result: first.json, summary: output.summary, candidates: byId }))
    const partialPath = join(temp, 'partial-overlap.json')
    const partial = await runOp('contact_cluster', {
      artifacts: [artifactPaths.A, artifactPaths.C], out: partialPath,
    })
    const partialOutput = JSON.parse(readFileSync(partialPath, 'utf8'))
    check('contact_cluster: 部分重叠 Jaccard 精确为 6/11',
      partial.json?.ok === true && partialOutput.candidates.every((candidate) =>
        Math.abs(candidate.nearest_contact_jaccard - 6 / 11) < 1e-12))
    check('contact_cluster: 边界 cosine=0.80 与 Jaccard=0.70 均入簇',
      Math.abs(byId.B.nearest_pose_cosine - Math.sqrt(0.7)) < 1e-12 &&
      output.clusters.contact.some((cluster) => JSON.stringify(cluster.members) === JSON.stringify(['A', 'B', 'C', 'D'])) &&
      output.clusters.pose.some((cluster) => JSON.stringify(cluster.members) === JSON.stringify(['A', 'B', 'C', 'D'])),
      JSON.stringify({ cosine: byId.B.nearest_pose_cosine, clusters: output.clusters }))
    check('contact_cluster: 单链接传递（A~B、B~C，A~C<0.70）与 nearest tie-break',
      byId.E.nearest_neighbor_id === 'A' && byId.E.nearest_contact_jaccard === 0.0 &&
      output.clusters.contact.some((cluster) => JSON.stringify(cluster.members) === JSON.stringify(['A', 'B', 'C', 'D'])) &&
      output.clusters.contact.some((cluster) => JSON.stringify(cluster.members) === JSON.stringify(['E'])))
    const boundaryPath = join(temp, 'boundary.json')
    const boundary = await runOp('contact_cluster', {
      artifacts: [artifactPaths.A, artifactPaths.B], out: boundaryPath,
    })
    const boundaryOutput = JSON.parse(readFileSync(boundaryPath, 'utf8'))
    check('contact_cluster: 两候选恰好 Jaccard=0.70 / cosine=0.80 时边界入簇',
      boundary.json?.ok === true && boundaryOutput.clusters.contact.length === 1 &&
      boundaryOutput.clusters.pose.length === 1 &&
      boundaryOutput.candidates.every((candidate) => candidate.nearest_contact_jaccard === 0.7 &&
        Math.abs(candidate.nearest_pose_cosine - 0.8) < 1e-12),
      JSON.stringify({ result: boundary.json, output: boundaryOutput }))

    const acrossTargets = await runOp('contact_cluster', {
      artifacts: [
        (writeArtifact('TX', 'X', labels(1, 5), 'target-X'), artifactPaths.X),
        (writeArtifact('TY', 'Y', labels(1, 5), 'target-Y'), artifactPaths.Y),
      ], out: join(temp, 'cross-target.json'),
    })
    const cross = JSON.parse(readFileSync(join(temp, 'cross-target.json'), 'utf8'))
    const digestX = createHash('sha1').update('X').digest('hex').slice(0, 12)
    const digestY = createHash('sha1').update('Y').digest('hex').slice(0, 12)
    check('contact_cluster: 跨 target 各自单点簇、nearest=null、单点簇 ID 稳定',
      acrossTargets.json?.ok === true && cross.summary.n_within_target_pairs === 0 &&
      cross.candidates.every((candidate) => candidate.nearest_neighbor_id === null &&
        candidate.nearest_contact_jaccard === null && candidate.nearest_pose_cosine === null) &&
      cross.clusters.contact.some((cluster) => cluster.cluster_id === `cc_${digestX}`) &&
      cross.clusters.contact.some((cluster) => cluster.cluster_id === `cc_${digestY}`),
      JSON.stringify({ result: acrossTargets.json, output: cross, expected: [digestX, digestY] }))

    const again = await runOp('contact_cluster', args)
    check('contact_cluster: 同输入双跑输出文件逐字节一致',
      again.json?.ok === true && firstBytes.equals(readFileSync(out)))

    const dryPath = join(temp, 'dry-run.json')
    const dryRun = await runOp('contact_cluster', { ...args, out: dryPath, dry_run: true })
    check('contact_cluster: dry_run 返回 summary 且不写输出文件',
      dryRun.json?.ok === true && dryRun.json?.result?.dry_run === true &&
      !!dryRun.json?.result?.summary && !existsSync(dryPath))

    const zero = await runOp('contact_cluster', { artifacts: [], out })
    const one = await runOp('contact_cluster', { artifacts: [artifactPaths.A], out })
    const badJson = join(t1, 'contact_consensus_bad_jaccard.json')
    writeFileSync(badJson, '{ bad json')
    const malformed = await runOp('contact_cluster', {
      artifacts: [artifactPaths.A, badJson], out: join(temp, 'bad.json'),
    })
    check('contact_cluster: 0/1 artifact 与坏 JSON 均为结构化 ok:false',
      zero.json?.ok === false && one.json?.ok === false && malformed.json?.ok === false)
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
}

{
  // contact_cluster: 跨进程确定性回归（PYTHONHASHSEED）——
  // cosine 求和若按 set 迭代顺序累加，会随 Python 逐进程哈希随机化产生 ULP 级差异，
  // 使 nearest_pose_cosine 跨运行不可复现。此处用两个固定种子各跑一次，要求逐字节一致。
  const temp = mkdtempSync(join(tmpdir(), 'galatea-contact-cluster-seed-'))
  function seedRun(seed, outPath) {
    return new Promise((resolve) => {
      const cp = spawn(PY, ['-B', join(PYDIR, 'galatea_ops.py')], {
        cwd: PYDIR, windowsHide: true, env: { ...process.env, PYTHONHASHSEED: seed },
      })
      let out = ''
      let err = ''
      cp.stdout.on('data', (d) => { out += d })
      cp.stderr.on('data', (d) => { err += d })
      const timer = setTimeout(() => { try { cp.kill() } catch {} }, 120000)
      cp.on('close', (code) => {
        clearTimeout(timer)
        let json = null
        try { json = JSON.parse(out.trim().split('\n').pop()) } catch {}
        resolve({ code, out, err, json })
      })
      cp.stdin.write(JSON.stringify({
        op: 'contact_cluster',
        args: { artifacts: [join(temp, 'seed-a.json'), join(temp, 'seed-b.json')], out: outPath },
      }))
      cp.stdin.end()
    })
  }
  try {
    // 60 个非精确二进制小数频率 + 混合量级极小项 → 求和顺序敏感
    const labels = Array.from({ length: 60 }, (_, i) => `A${i + 1}`)
    const pair1 = {}
    const pair2 = {}
    labels.forEach((label, i) => {
      pair1[`B1|${label}`] = ((i * 37) % 97 + 1) / 97
      pair1[`B2|${label}`] = (((i * 53) % 89 + 1) / 89) / 3
      pair2[`B1|${label}`] = ((i * 71) % 83 + 1) / 83
      pair2[`B2|${label}`] = (((i * 29) % 79 + 1) / 79) / 7
    })
    Array.from({ length: 5 }, (_, i) => `Z${i + 1}`).forEach((label, i) => {
      pair1[`B1|${label}`] = 10 ** -(i + 6)
      pair2[`B1|${label}`] = ((i * 13) % 17 + 1) / 17
    })
    writeFileSync(join(temp, 'seed-a.json'), JSON.stringify({
      candidate_id: 'c1', target_id: 'T1', pair_frequency: pair1, anchor_residues: ['B42'] }))
    writeFileSync(join(temp, 'seed-b.json'), JSON.stringify({
      candidate_id: 'c2', target_id: 'T1', pair_frequency: pair2, anchor_residues: ['B42'] }))
    const r1 = await seedRun('1', join(temp, 'out-s1.json'))
    const r2 = await seedRun('2', join(temp, 'out-s2.json'))
    const ok = r1.code === 0 && r2.code === 0 && r1.json?.ok === true && r2.json?.ok === true
    const bytes1 = ok ? readFileSync(join(temp, 'out-s1.json')) : Buffer.alloc(0)
    const bytes2 = ok ? readFileSync(join(temp, 'out-s2.json')) : Buffer.alloc(0)
    check('contact_cluster: 输出与 PYTHONHASHSEED 无关（双 seed 逐字节一致；cosine 求和规范化）',
      ok && bytes1.length > 0 && bytes1.equals(bytes2),
      JSON.stringify({ code1: r1.code, code2: r2.code,
        sha1: createHash('sha256').update(bytes1).digest('hex').slice(0, 16),
        sha2: createHash('sha256').update(bytes2).digest('hex').slice(0, 16) }))
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
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
  const contactCampaignDir = mkdtempSync(join(tmpdir(), 'galatea-loop-contact-smoke-'))
  const insufficientCampaignDir = mkdtempSync(join(tmpdir(), 'galatea-loop-insufficient-smoke-'))
  const emptyCampaignDir = mkdtempSync(join(tmpdir(), 'galatea-loop-empty-'))
  const sequenceBase = 'ACDEFGHIKLMNPQRSTVWY'.repeat(3)
  function loopCandidates(roundIndex, withContactConsensus = false, contactStatus = 'PASS') {
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
        ...(withContactConsensus ? {
          contact_consensus: {
            anchor_residues: contactStatus === 'INSUFFICIENT' ? [] : ['B42'],
            status: contactStatus,
          },
        } : {}),
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
    check('loop.next: 缺少 contact-consensus 时保留 anchor 降级 note',
      parents.every((parent) => !Array.isArray(parent.anchor_residues) &&
        parent.operator_notes.some((note) => note.includes('no contact-consensus input'))))
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

    const contactLog = await runOp('loop', {
      action: 'log', campaign_dir: contactCampaignDir,
      round: { round_id: 0, candidates: loopCandidates(0, true), notes: 'synthetic contact-consensus round' },
    })
    const contactNext = await runOp('loop', { action: 'next', campaign_dir: contactCampaignDir })
    const contactParents = contactNext.json?.round_plan?.parents || []
    check('loop.next: valid contact-consensus carries candidate anchors and status note',
      contactLog.json?.ok === true && contactParents.length > 0 &&
      contactParents.every((parent) => JSON.stringify(parent.anchor_residues) === JSON.stringify(['B42']) &&
        parent.operator_notes.some((note) => note === 'anchor residues from contact-consensus (n=1, status=PASS)')))
    const insufficientLog = await runOp('loop', {
      action: 'log', campaign_dir: insufficientCampaignDir,
      round: { round_id: 0, candidates: loopCandidates(0, true, 'INSUFFICIENT') },
    })
    const insufficientNext = await runOp('loop', { action: 'next', campaign_dir: insufficientCampaignDir })
    const insufficientParents = insufficientNext.json?.round_plan?.parents || []
    check('loop.next: INSUFFICIENT contact-consensus carries no anchors and keeps degrade note',
      insufficientLog.json?.ok === true && insufficientParents.length > 0 &&
      insufficientParents.every((parent) => Array.isArray(parent.anchor_residues) &&
        parent.anchor_residues.length === 0 &&
        parent.operator_notes.some((note) => note.includes('no contact-consensus input'))))

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
    rmSync(contactCampaignDir, { recursive: true, force: true })
    rmSync(insufficientCampaignDir, { recursive: true, force: true })
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

if (existsSync(FIXTURE) && hasBio) {
  const snippet = `
import json, os, sys, tempfile
sys.path.insert(0, ${JSON.stringify(PYDIR)})
import numpy as np
from Bio.PDB import Atom, Chain, MMCIFIO, Model, PDBIO, PDBParser, Residue, Structure
import redesign_tools
from redesign_tools import (_core_mutation_fraction, _structural_region, build_redesign_plan,
                            calculate_regions, run_redesign, write_fixed_residues)
from refold_tools import classify_secondary_structure, compare_structures, run_refold
from contact_tools import run_contact_consensus
from cluster_tools import run_contact_cluster
import mpnn_design

fixture = ${JSON.stringify(FIXTURE)}
one_ubq = ${JSON.stringify(join(REPO, 'test', 'fixtures', '1ubq.pdb'))}
base = build_redesign_plan(fixture, 'A', mode='interface-refine')
labels = base['counts']['binder'] and [*base['fixed_positions'], *base['design_positions']]
binder = [res for res in PDBParser(QUIET=True).get_structure('x', fixture)[0]['A']
          if res.id[0] == ' ']
from struct_analysis import _residue_label
all_labels = [_residue_label(res) for res in binder]
assert set(base['fixed_positions']) == set(base['regions']['interface_contact'])
assert set(base['design_positions']) == set(all_labels) - set(base['regions']['interface_contact'])
assert set(base['regions']['interface_contact']).isdisjoint(base['regions']['target_shell'])
assert set(base['regions']['interface_contact']).isdisjoint(base['regions']['structural_shell'])
assert set(base['regions']['core']).isdisjoint(base['regions']['boundary'])
assert set(base['regions']['core']).isdisjoint(base['regions']['surface'])
assert set(base['regions']['boundary']).isdisjoint(base['regions']['surface'])
assert set(base['regions']['core']) | set(base['regions']['boundary']) | set(base['regions']['surface']) == set(all_labels)
assert set(base['regions']['interface']) == set(base['regions']['interface_contact']) | set(base['regions']['interface_buried'])
assert len(base['residue_table']) == len(all_labels)
assert all({'chain', 'resid', 'aa', 'sasa', 'rsasa', 'structural_region', 'min_target_dist',
            'interface_contact', 'delta_sasa', 'interface_buried', 'target_shell',
            'structural_shell', 'anchor'} <= set(row) for row in base['residue_table'])
assert [_structural_region(value) for value in (0.10, 0.1001, 0.2499, 0.25)] == [
    'CORE', 'BOUNDARY', 'BOUNDARY', 'SURFACE']

def new_structure(name):
    structure = Structure.Structure(name)
    model = Model.Model(0)
    structure.add(model)
    return structure, model

def add_ca(chain, resid, xyz, serial, element='C'):
    residue = Residue.Residue((' ', resid, ' '), 'ALA', ' ')
    atom_name = 'CA' if element == 'C' else 'H'
    residue.add(Atom.Atom(atom_name, np.asarray(xyz, dtype=np.float32), 1.0, 1.0,
                          ' ', f'{atom_name:>4}', serial, element=element))
    chain.add(residue)

with tempfile.TemporaryDirectory(prefix='galatea-region-v2-smoke-') as temp:
    toy, toy_model = new_structure('region-v2')
    target = Chain.Chain('A'); binder_chain_obj = Chain.Chain('B')
    toy_model.add(target); toy_model.add(binder_chain_obj)
    add_ca(target, 1, (0, 0, 0), 1)
    add_ca(binder_chain_obj, 1, (3, 0, 0), 2)
    add_ca(binder_chain_obj, 2, (0, 7, 0), 3)
    add_ca(binder_chain_obj, 3, (9, 0, 0), 4)
    io = PDBIO(); io.set_structure(toy)
    toy_path = os.path.join(temp, 'shells.pdb'); io.save(toy_path)
    toy_regions = calculate_regions(toy_path, 'B', 'A')
    toy_rows = {row['label']: row for row in toy_regions['residue_table']}
    assert toy_regions['regions']['target_shell'] == ['B2']
    assert toy_regions['regions']['structural_shell'] == ['B3']
    assert set(toy_regions['regions']['shell']) == {'B2', 'B3'}
    assert toy_rows['B1']['interface_contact'] is True
    assert toy_rows['B1']['delta_sasa'] >= 1.0 and toy_rows['B1']['interface_buried'] is True
    assert 'B1' in toy_regions['regions']['interface']
    assert toy_rows['B3']['min_target_dist'] > 8.0

actual_region_data = calculate_regions(fixture, 'A')
core_label = next(label for label in all_labels
                  if label not in set(actual_region_data['regions']['interface_contact'])
                  and label not in set(actual_region_data['regions']['anchor']))
synthetic_region_data = dict(actual_region_data)
synthetic_regions = dict(actual_region_data['regions'])
synthetic_regions['core'] = [core_label]
synthetic_regions['boundary'] = []
synthetic_regions['surface'] = [label for label in all_labels if label != core_label]
synthetic_region_data['regions'] = synthetic_regions
synthetic_region_data['counts'] = {name: len(values) for name, values in synthetic_regions.items()}
original_calculate_regions = redesign_tools.calculate_regions
redesign_tools.calculate_regions = lambda *args, **kwargs: synthetic_region_data
try:
    scaffold_core = build_redesign_plan(fixture, 'A', mode='scaffold-rescue')
finally:
    redesign_tools.calculate_regions = original_calculate_regions
assert core_label in scaffold_core['design_positions'] and core_label not in scaffold_core['fixed_positions']
core_fraction = _core_mutation_fraction('ACDE', 'TCDE', ['A1', 'A2', 'A3', 'A4'], ['A1', 'A2'])
assert core_fraction == 0.5

freq = {all_labels[0]: 0.9, all_labels[-1]: 0.2}
anchor = build_redesign_plan(fixture, 'A', mode='anchor-preserving', contact_frequencies=freq)
anchor_expected = {all_labels[0]}
assert set(anchor['fixed_positions']) == anchor_expected
assert set(anchor['design_positions']) == set(all_labels) - anchor_expected
degraded = build_redesign_plan(fixture, 'A', mode='anchor-preserving')
assert degraded['mode'] == 'interface-refine' and degraded['degraded'] is True
assert degraded['degraded_reason'] == 'no contact frequencies'

scaffold = build_redesign_plan(fixture, 'A', mode='scaffold-rescue')
scaffold_fixed = set(scaffold['regions']['interface_contact']) | set(scaffold['regions']['anchor'])
assert set(scaffold['fixed_positions']) == scaffold_fixed
assert set(scaffold['design_positions']) == set(all_labels) - scaffold_fixed
assert not set(scaffold['fixed_positions']) & set(scaffold['design_positions'])
full = build_redesign_plan(fixture, 'A', mode='full-explore')
assert not full['fixed_positions'] and set(full['design_positions']) == set(all_labels)

explicit_design = next((label for label in all_labels if label != all_labels[0]), None)
explicit = build_redesign_plan(fixture, 'A', mode='interface-refine',
                               fixed_positions=[all_labels[0]], design_positions=[explicit_design])
assert all_labels[0] in explicit['fixed_positions'] and explicit_design in explicit['design_positions']
same = build_redesign_plan(fixture, 'A', mode='interface-refine')
assert base == same

with tempfile.TemporaryDirectory(prefix='galatea-mask-smoke-') as temp:
    mask_path = os.path.join(temp, 'fixed_residues.txt')
    write_fixed_residues(mask_path, base['fixed_positions'])
    mask_tokens = open(mask_path, encoding='utf-8').read().split()
    assert mask_tokens == base['fixed_positions']

with tempfile.TemporaryDirectory(prefix='galatea-mpnn-wrapper-smoke-') as root:
    vendor = os.path.join(root, 'vendor', 'LigandMPNN')
    checkpoint = os.path.join(root, 'models', 'mpnn', 'solublempnn_v_48_020.pt')
    os.makedirs(vendor); os.makedirs(os.path.dirname(checkpoint))
    open(os.path.join(vendor, 'run.py'), 'w', encoding='utf-8').close()
    open(checkpoint, 'w', encoding='utf-8').close()
    captured = []
    mock_design_seq = 'ACDF'
    def fake_run(command, **kwargs):
        captured.append((command, kwargs))
        out_folder = command[command.index('--out_folder') + 1]
        os.makedirs(os.path.join(out_folder, 'seqs'), exist_ok=True)
        with open(os.path.join(out_folder, 'seqs', 'mock.fa'), 'w', encoding='utf-8') as fh:
            fh.write('>native,T=0.1,seed=7\\nACDE\\n>sample,id=1,T=0.1,seed=7,overall_confidence=0.9,seq_rec=0.75\\n' + mock_design_seq + '\\n')
        from types import SimpleNamespace
        return SimpleNamespace(returncode=0, stdout='', stderr='')
    original_run = mpnn_design.subprocess.run
    original_pick_runner = mpnn_design._pick_runner
    mpnn_design.subprocess.run = fake_run
    mpnn_design._pick_runner = lambda _: (sys.executable, 'smoke-mock')
    try:
        masked_result = mpnn_design.design_sequences_with_masks(
            fixture, os.path.join(root, 'direct'), 'A', ['A2'], ['A1', 'A3'],
            num_seqs=1, temperature=0.1, model='soluble_mpnn', seed=7, data_root=root)
        masked_command, masked_kwargs = captured[-1]
        assert masked_command[masked_command.index('--fixed_residues') + 1] == 'A2'
        assert masked_command[masked_command.index('--redesigned_residues') + 1] == 'A1 A3'
        assert masked_kwargs['env']['PYTHONDONTWRITEBYTECODE'] == '1'
        legacy_result = mpnn_design.design_sequences(
            fixture, os.path.join(root, 'legacy'), chains='A', fixed_residues=['A2'],
            num_seqs=1, model='soluble_mpnn', seed=7, data_root=root)
        legacy_command, legacy_kwargs = captured[-1]
        assert '--fixed_residues' in legacy_command and '--redesigned_residues' not in legacy_command
        assert legacy_kwargs['env'] is None
        redesign_result = run_redesign({
            'structure_path': fixture, 'binder_chain': 'A', 'mode': 'interface-refine',
            'n_sequences': 1, 'seed': 7, 'out_dir': os.path.join(root, 'redesign-output'),
        }, root, lambda _: os.path.join(root, 'default'))
        assert redesign_result['ok'] is True
        assert os.path.isfile(redesign_result['files']['meta_json'])
        assert os.path.isfile(redesign_result['files']['fixed_residues'])
        output_mask = open(redesign_result['files']['fixed_residues'], encoding='utf-8').read().split()
        assert output_mask == redesign_result['fixed_positions']
        output_meta = json.load(open(redesign_result['files']['meta_json'], encoding='utf-8'))
        assert output_meta['seed'] == 7 and output_meta['designs'][0]['redesigned_count'] == len(redesign_result['designs'][0]['sequence']) - 3
        all_fixed = run_redesign({
            'structure_path': fixture, 'binder_chain': 'A', 'mode': 'interface-refine',
            'fixed_positions': all_labels, 'n_sequences': 1, 'seed': 7,
            'out_dir': os.path.join(root, 'redesign-allfixed'),
        }, root, lambda _: os.path.join(root, 'default'))
        assert all_fixed['ok'] is True and all_fixed['design_positions'] == []
        assert all_fixed['warnings'] and '无可设计位点' in all_fixed['warnings'][0]

        mutant = list('ACDE')
        core_index = all_labels.index(core_label)
        mutant[core_index] = 'W' if mutant[core_index] != 'W' else 'A'
        mock_design_seq = ''.join(mutant)
        original_calc = redesign_tools.calculate_regions
        redesign_tools.calculate_regions = lambda *args, **kwargs: synthetic_region_data
        try:
            core_warning = run_redesign({
                'structure_path': fixture, 'binder_chain': 'A', 'mode': 'scaffold-rescue',
                'n_sequences': 1, 'seed': 7, 'out_dir': os.path.join(root, 'redesign-core-warning'),
            }, root, lambda _: os.path.join(root, 'default'))
        finally:
            redesign_tools.calculate_regions = original_calc
            mock_design_seq = 'ACDF'
        assert core_warning['ok'] is True
        assert core_warning['designs'][0]['core_mutation_fraction'] == 1.0
        assert any(warning.startswith('WARN: core_mutation_fraction=') for warning in core_warning['warnings'])
    finally:
        mpnn_design.subprocess.run = original_run
        mpnn_design._pick_runner = original_pick_runner

same_metrics = compare_structures(fixture, fixture, reference_chain='A', model_chain='A')
assert same_metrics['metrics']['monomer_ca_rmsd'] < 1e-6
assert same_metrics['metrics']['fraction_ca_within_2A'] == 1.0
assert same_metrics['metrics']['n_aligned'] == same_metrics['metrics']['length_ref']

with tempfile.TemporaryDirectory(prefix='galatea-refold-smoke-') as temp:
    parser = PDBParser(QUIET=True)
    perturbed_structure = parser.get_structure('perturbed', fixture)
    chain = perturbed_structure[0]['A']
    for index, residue in enumerate([res for res in chain if res.id[0] == ' ']):
        if 'CA' in residue:
            residue['CA'].coord[1] += (0.15 if index % 2 else -0.15)
    io = PDBIO(); io.set_structure(perturbed_structure)
    perturbed_path = os.path.join(temp, 'perturbed.pdb'); io.save(perturbed_path)
    perturbed = compare_structures(fixture, perturbed_path, reference_chain='A', model_chain='A')
    assert 0.0 < perturbed['metrics']['monomer_ca_rmsd'] < 1.0
    assert 0.0 <= perturbed['metrics']['fraction_ca_within_2A'] <= 1.0

    outlier_structure = parser.get_structure('outlier', fixture)
    outlier_chain = outlier_structure[0]['A']
    first_ca = next(residue['CA'] for residue in outlier_chain if 'CA' in residue)
    first_ca.coord[0] += 20.0
    io.set_structure(outlier_structure)
    outlier_path = os.path.join(temp, 'outlier.pdb'); io.save(outlier_path)
    outlier = compare_structures(fixture, outlier_path, reference_chain='A', model_chain='A')
    expected_f2 = sum(row['deviation'] <= 2.0 for row in outlier['metrics']['top_deviations']) / outlier['metrics']['n_aligned']
    assert outlier['metrics']['fraction_ca_within_2A'] == round(expected_f2, 4)
    assert outlier['metrics']['fraction_ca_within_2A'] < 1.0

    shorter_structure = parser.get_structure('shorter', fixture)
    shorter_chain = shorter_structure[0]['A']
    residues = [res for res in shorter_chain if res.id[0] == ' ']
    for residue in residues[-2:]: shorter_chain.detach_child(residue.id)
    io.set_structure(shorter_structure)
    shorter_path = os.path.join(temp, 'shorter.pdb'); io.save(shorter_path)
    shorter = compare_structures(fixture, shorter_path, reference_chain='A', model_chain='A')
    assert shorter['metrics']['length_ref'] > shorter['metrics']['length_model']
    assert shorter['metrics']['n_aligned'] <= shorter['metrics']['length_model']
    assert shorter['metrics']['warnings']

ubq = PDBParser(QUIET=True).get_structure('ubq', one_ubq)[0]
ubq_chain = next(chain for chain in ubq if any(res.id[0] == ' ' for res in chain))
ss = classify_secondary_structure(ubq_chain)
ss_counts = {state: sum(value == state for value in ss.values()) for state in ('helix', 'strand', 'coil')}
assert ss_counts['helix'] > 0 and ss_counts['strand'] > 0

contact_summary = {}
with tempfile.TemporaryDirectory(prefix='galatea-contact-consensus-smoke-') as temp:
    contact_paths = []
    for index in range(10):
        structure, model = new_structure(f'contact-{index}')
        target_chain_obj = Chain.Chain('A'); binder_chain_obj = Chain.Chain('B')
        model.add(target_chain_obj); model.add(binder_chain_obj)
        add_ca(target_chain_obj, 1, (0, 0, 0), 1)
        add_ca(target_chain_obj, 2, (20, 0, 0), 2)
        add_ca(target_chain_obj, 3, (100, 0, 0), 3)
        add_ca(target_chain_obj, 4, (300, 0, 0), 10)
        binder_1 = (3, 0, 0) if index < 5 else (23, 0, 0) if index < 7 else (50, 0, 0)
        binder_2 = (23, 0, 0) if index < 8 else (70, 0, 0)
        binder_3 = (104, 0, 0) if index == 0 else (103, 0, 0) if index < 4 else (3, 0, 0) if index < 7 else (150, 0, 0)
        add_ca(binder_chain_obj, 1, binder_1, 4)
        add_ca(binder_chain_obj, 2, binder_2, 5)
        add_ca(binder_chain_obj, 3, binder_3, 6)
        if index >= 8:
            add_ca(target_chain_obj, 5, binder_1, 7, element='H')
            add_ca(target_chain_obj, 6, binder_2, 8, element='H')
            add_ca(target_chain_obj, 7, binder_3, 9, element='H')
        io = PDBIO(); io.set_structure(structure)
        path = os.path.join(temp, f'model_{index:02d}.pdb')
        io.save(path); contact_paths.append(path)

    cif_structure, cif_model = new_structure('cif-no-occupancy')
    cif_target = Chain.Chain('A'); cif_binder = Chain.Chain('B')
    cif_model.add(cif_target); cif_model.add(cif_binder)
    add_ca(cif_target, 1, (0, 0, 0), 1)
    add_ca(cif_binder, 1, (3, 0, 0), 2)
    cif_path = os.path.join(temp, 'missing-occupancy.cif')
    cif_io = MMCIFIO(); cif_io.set_structure(cif_structure); cif_io.save(cif_path)
    with open(cif_path, 'r', encoding='utf-8') as handle:
        cif_lines = handle.readlines()
    cif_loop = next(index for index, line in enumerate(cif_lines) if line.strip().lower() == 'loop_' and
                    any(row.startswith('_atom_site.') for row in cif_lines[index + 1:index + 40]))
    cif_headers = []
    cif_data_start = cif_loop + 1
    while cif_data_start < len(cif_lines) and cif_lines[cif_data_start].lstrip().startswith('_'):
        cif_headers.append(cif_lines[cif_data_start].strip().split()[0])
        cif_data_start += 1
    occupancy_index = cif_headers.index('_atom_site.occupancy')
    cif_lines = [line for index, line in enumerate(cif_lines) if index != cif_loop + 1 + occupancy_index]
    for index in range(cif_data_start - 1, len(cif_lines)):
        line = cif_lines[index]
        if not line.strip() or line.strip().startswith('#'):
            break
        tokens = line.split()
        if tokens and tokens[0] in ('ATOM', 'HETATM'):
            del tokens[occupancy_index]
            cif_lines[index] = ' '.join(tokens) + chr(10)
    with open(cif_path, 'w', encoding='utf-8') as handle:
        handle.writelines(cif_lines)
    no_occupancy = run_contact_consensus({
        'models': [cif_path], 'binder_chain': 'B', 'target_chain': 'A',
        'artifact_path': os.path.join(temp, 'no-occupancy.json'),
    })
    assert no_occupancy['ok'] is True
    assert no_occupancy['result']['coverage'] == {'expected_models': 1, 'valid_models': 1}
    assert no_occupancy['result']['pair_contacts']['B1|A1'] == 1.0

    def run_contact(paths, artifact_name, **extra):
        return run_contact_consensus({
            'models': paths, 'binder_chain': 'B', 'target_chain': 'A',
            'candidate_id': artifact_name,
            'artifact_path': os.path.join(temp, artifact_name + '.json'), **extra,
        })

    mixed_paths = []
    for index, (binder_id, target_ids) in enumerate((('C', ('A', 'B')), ('A', ('B', 'C')))):
        mixed_structure, mixed_model = new_structure(f'mixed-chain-{index}')
        mixed_chains = {chain_id: Chain.Chain(chain_id) for chain_id in ('A', 'B', 'C')}
        for chain_id in ('A', 'B', 'C'):
            mixed_model.add(mixed_chains[chain_id])
        first_target, second_target = target_ids
        add_ca(mixed_chains[first_target], 1, (0, 0, 0), 1)
        add_ca(mixed_chains[first_target], 2, (0, 40, 0), 2)
        add_ca(mixed_chains[second_target], 1, (20, 0, 0), 3)
        add_ca(mixed_chains[second_target], 2, (20, 40, 0), 4)
        add_ca(mixed_chains[binder_id], 1, (3, 0, 0), 5)
        mixed_io = PDBIO(); mixed_io.set_structure(mixed_structure)
        mixed_path = os.path.join(temp, f'mixed_{index:02d}.pdb')
        mixed_io.save(mixed_path); mixed_paths.append(mixed_path)
    mixed_auto = run_contact_consensus({
        'models': mixed_paths,
        'artifact_path': os.path.join(temp, 'mixed-auto.json'),
    })
    mixed_result = mixed_auto['result']
    assert mixed_auto['ok'] is True
    assert mixed_result['coverage'] == {'expected_models': 2, 'valid_models': 2}
    assert mixed_result['binder_residues'] == {
        'C1': {'contact_freq': 1.0, 'max_pair_freq': 1.0, 'median_min_dist_A': 3.0, 'anchor': False},
    }
    assert mixed_result['pair_contacts'] == {'C1|A1': 1.0}
    assert mixed_result['jaccard'] == {
        'residue_mean': 1.0, 'residue_min': 1.0, 'edge_mean': 1.0, 'edge_min': 1.0,
    }
    assert mixed_result['chain_assignments']['mixed_01.pdb'] == {
        'binder_chain': 'A', 'target_chains': ['B', 'C'],
    }
    assert mixed_result['chain_label_mappings']['mixed_01.pdb'] == {
        'binder_chain': {'source': 'A', 'canonical': 'C'},
        'target_chains': {'B': 'A', 'C': 'B'},
    }

    three = run_contact([contact_paths[0], contact_paths[1], contact_paths[8]], 'three-model')
    assert three['ok'] is True
    three_result = three['result']
    assert three_result['coverage'] == {'expected_models': 3, 'valid_models': 3}
    assert three_result['status'] == 'INSUFFICIENT' and three_result['anchor_residues'] == []
    assert three_result['binder_residues']['B1']['contact_freq'] == 0.6667
    assert three_result['binder_residues']['B1']['max_pair_freq'] == 0.6667
    assert three_result['pair_contacts']['B1|A1'] == 0.6667
    assert three_result['target_residues']['A1']['contact_freq'] == 0.6667
    assert three_result['jaccard'] == {
        'residue_mean': 0.3333, 'residue_min': 0.0, 'edge_mean': 0.3333, 'edge_min': 0.0,
    }
    matrix_path = three_result['artifact_path']
    with open(matrix_path, 'rb') as fh: first_artifact = fh.read()
    three_again = run_contact([contact_paths[0], contact_paths[1], contact_paths[8]], 'three-model')
    with open(matrix_path, 'rb') as fh: second_artifact = fh.read()
    assert three_again == three and first_artifact == second_artifact
    matrices = json.loads(first_artifact.decode('utf-8'))
    assert len(matrices['residue_jaccard']) == len(matrices['edge_jaccard']) == 3

    full_contact = run_contact(contact_paths, 'ten-model')['result']
    legacy_cluster_a = run_contact(contact_paths, 'legacy-cluster-a')['result']['artifact_path']
    legacy_cluster_b = run_contact(contact_paths, 'legacy-cluster-b')['result']['artifact_path']
    legacy_cluster_out = os.path.join(temp, 'legacy-clusters.json')
    legacy_cluster = run_contact_cluster({
        'artifacts': [legacy_cluster_a, legacy_cluster_b], 'out': legacy_cluster_out,
    })
    with open(legacy_cluster_out, 'r', encoding='utf-8') as handle:
        legacy_cluster_json = json.load(handle)
    assert legacy_cluster['ok'] is True and legacy_cluster_json['summary']['n_candidates'] == 2
    assert legacy_cluster_json['clusters']['contact'][0]['members'] == ['legacy-cluster-a', 'legacy-cluster-b']
    assert all('LEGACY_ARTIFACT_REANALYZED_MODELS' in row['warnings']
               for row in legacy_cluster_json['candidates'])
    assert all('LEGACY_ARTIFACT_CUTOFF_ASSUMED_4A' in row['warnings']
               for row in legacy_cluster_json['candidates'])
    assert all(row['binder_anchor_set'] == ['B1', 'B2'] for row in legacy_cluster_json['candidates'])
    warn = run_contact(contact_paths[:6] + [contact_paths[8]], 'seven-model')['result']
    insufficient = run_contact(contact_paths[:4] + [contact_paths[8]], 'five-model')['result']
    assert full_contact['coverage'] == {'expected_models': 10, 'valid_models': 10}
    assert full_contact['status'] == 'PASS' and full_contact['anchor_residues'] == ['B1', 'B2']
    assert full_contact['binder_residues']['B1']['contact_freq'] == 0.7
    assert full_contact['binder_residues']['B1']['max_pair_freq'] == 0.5
    assert full_contact['binder_residues']['B1']['anchor'] is True
    assert full_contact['binder_residues']['B3']['contact_freq'] == 0.7
    assert full_contact['binder_residues']['B3']['max_pair_freq'] == 0.4
    assert full_contact['binder_residues']['B3']['anchor'] is False
    assert full_contact['pair_contacts']['B1|A1'] == 0.5
    assert full_contact['pair_contacts']['B1|A2'] == 0.2
    assert full_contact['pair_contacts']['B3|A3'] == 0.4
    assert full_contact['pair_contacts']['B3|A1'] == 0.3
    assert warn['coverage'] == {'expected_models': 7, 'valid_models': 7}
    assert warn['status'] == 'WARN' and warn['anchor_residues'] == ['B1', 'B2', 'B3']
    assert insufficient['coverage'] == {'expected_models': 5, 'valid_models': 5}, insufficient
    assert insufficient['status'] == 'INSUFFICIENT' and insufficient['anchor_residues'] == []
    assert insufficient['binder_residues']['B1']['contact_freq'] == 0.8

    auto = run_contact_consensus({
        'models': contact_paths[:2], 'artifact_path': os.path.join(temp, 'auto.json'),
    })
    assert auto['ok'] is True
    assert all(row['binder_chain'] == 'B' and row['target_chains'] == ['A']
               for row in auto['result']['chain_assignments'].values())
    by_glob = run_contact_consensus({
        'models_dir': temp, 'glob': 'model_0[0-7].pdb', 'binder_chain': 'B', 'target_chain': 'A',
        'artifact_path': os.path.join(temp, 'glob.json'),
    })
    assert by_glob['ok'] is True and by_glob['result']['coverage']['expected_models'] == 8
    empty_models = run_contact_consensus({'models': []})
    duplicate_models = run_contact_consensus({
        'models': [contact_paths[0], contact_paths[0]], 'binder_chain': 'B', 'target_chain': 'A',
    })
    bad_path = os.path.join(temp, 'invalid.pdb')
    open(bad_path, 'w', encoding='utf-8').write('')
    unreadable = run_contact_consensus({'models': [bad_path], 'binder_chain': 'B', 'target_chain': 'A'})
    assert empty_models['ok'] is False and unreadable['ok'] is False
    contact_summary = {
        'three_model_freq': three_result['binder_residues']['B1']['contact_freq'],
        'three_model_pair_freq': three_result['pair_contacts']['B1|A1'],
        'three_model_jaccard': three_result['jaccard'],
        'full_status': full_contact['status'], 'full_valid': full_contact['coverage']['valid_models'],
        'full_anchors': full_contact['anchor_residues'], 'warn_status': warn['status'],
        'insufficient_status': insufficient['status'], 'artifact_path': matrix_path,
        'deterministic': three_again == three and first_artifact == second_artifact,
        'bad_inputs_ok': empty_models['ok'] is False and duplicate_models['ok'] is False and unreadable['ok'] is False,
        'missing_occupancy_valid': no_occupancy['result']['coverage']['valid_models'] == 1,
        'auto_mixed_labels_consistent': mixed_auto['ok'] is True and
            mixed_result['binder_residues'].get('C1', {}).get('contact_freq') == 1.0 and
            mixed_result['chain_label_mappings']['mixed_01.pdb']['binder_chain'] == {
                'source': 'A', 'canonical': 'C'},
        'legacy_artifact_clustered': legacy_cluster['ok'] is True and
            legacy_cluster_json['summary']['n_candidates'] == 2 and
            all('LEGACY_ARTIFACT_REANALYZED_MODELS' in row['warnings']
                for row in legacy_cluster_json['candidates']) and
            all('LEGACY_ARTIFACT_CUTOFF_ASSUMED_4A' in row['warnings']
                for row in legacy_cluster_json['candidates']),
        'artifact_written': os.path.isfile(matrix_path),
    }
import fold_esm
original_fold_sequences = fold_esm.fold_sequences
fold_esm.fold_sequences = lambda *args, **kwargs: {
    'status': 'failed', 'results': [], 'errors': [{'error': 'synthetic ESMFold unavailable'}],
}
try:
    with tempfile.TemporaryDirectory(prefix='galatea-refold-failure-smoke-') as temp:
        fold_failure = run_refold({
            'structure_path': fixture, 'binder_chain': 'A', 'out_dir': temp,
        }, temp, lambda _: temp)
        assert fold_failure['ok'] is False and 'did not produce' in fold_failure['error']
finally:
    fold_esm.fold_sequences = original_fold_sequences
print(json.dumps({
    'base': base, 'anchor': anchor, 'degraded': degraded, 'scaffold': scaffold,
    'full': full, 'explicit': explicit, 'mask_tokens': mask_tokens,
    'toy_regions': toy_regions, 'scaffold_core': scaffold_core,
    'core_fraction': core_fraction, 'core_warning': core_warning,
    'mpnn_wrapper': {'masked_ok': masked_result.get('status') == 'ok',
                     'masked_fixed': masked_command[masked_command.index('--fixed_residues') + 1],
                     'masked_design': masked_command[masked_command.index('--redesigned_residues') + 1],
                     'legacy_ok': legacy_result.get('status') == 'ok',
                     'legacy_has_redesigned': '--redesigned_residues' in legacy_command,
                     'redesign_ok': redesign_result['ok'],
                     'redesign_files': redesign_result['files']},
    'same_metrics': same_metrics, 'perturbed_metrics': perturbed, 'outlier_metrics': outlier,
    'shorter_metrics': shorter, 'ubq_ss_counts': ss_counts,
    'contact_summary': contact_summary,
    'fold_failure': fold_failure, 'warnings_empty': all_fixed['warnings'],
}))
`
  const r = await runPythonSnippet(snippet)
  const sample = r.json
  check('redesign: contact/shell definitions and three rSASA regions partition binder',
    r.code === 0 && !!sample?.base &&
    JSON.stringify(sample.base.regions.interface_contact.filter((x) => sample.base.regions.target_shell.includes(x) || sample.base.regions.structural_shell.includes(x))) === '[]' &&
    sample.base.counts.binder === sample.base.regions.core.length + sample.base.regions.boundary.length + sample.base.regions.surface.length,
    r.err.slice(-240))
  check('redesign: known rSASA cutoffs and per-residue SASA/interface table',
    !!sample?.base?.residue_table && sample.base.residue_table.length === sample.base.counts.binder &&
    sample.base.residue_table.every((row) => typeof row.rsasa === 'number' && typeof row.delta_sasa === 'number' &&
      typeof row.interface_contact === 'boolean' && typeof row.interface_buried === 'boolean'))
  check('redesign: ΔSASA interface union and independent target/structural shell definitions',
    !!sample?.toy_regions && sample.toy_regions.regions.target_shell.includes('B2') &&
    sample.toy_regions.regions.structural_shell.includes('B3') &&
    !sample.toy_regions.regions.target_shell.includes('B3') &&
    sample.toy_regions.regions.interface_contact.includes('B1') &&
    sample.toy_regions.regions.interface_buried.includes('B1'))
  check('redesign: four preset masks and explicit position overrides',
    !!sample?.anchor && !!sample?.scaffold && !!sample?.full && !!sample?.explicit &&
    sample.anchor.fixed_positions.length === sample.anchor.regions.anchor.length &&
    sample.full.counts.fixed === 0 && sample.explicit.counts.fixed >= 1,
    r.err.slice(-240))
  check('redesign: scaffold-rescue leaves CORE residues designable',
    !!sample?.scaffold_core && sample.scaffold_core.design_positions.includes(sample.scaffold_core.regions.core[0]) &&
    !sample.scaffold_core.fixed_positions.includes(sample.scaffold_core.regions.core[0]))
  check('redesign: CORE mutation fraction >0.35 is recorded as WARN without rejection',
    sample?.core_fraction === 0.5 && sample?.core_warning?.ok === true &&
    sample.core_warning.designs[0].core_mutation_fraction === 1.0 &&
    sample.core_warning.warnings.some((warning) => warning.startsWith('WARN: core_mutation_fraction=')))
  check('redesign: missing contact frequencies degrades anchor mode explicitly',
    sample?.degraded?.mode === 'interface-refine' && sample.degraded.degraded === true &&
    sample.degraded.degraded_reason === 'no contact frequencies')
  check('redesign: deterministic region calculation and LigandMPNN fixed mask format',
    !!sample?.mask_tokens && JSON.stringify(sample.mask_tokens) === JSON.stringify(sample.base.fixed_positions))
  check('redesign: MPNN receives exact fixed/design masks and legacy mpnn keeps its command shape',
    sample?.mpnn_wrapper?.masked_ok === true && sample.mpnn_wrapper.masked_fixed.length > 0 &&
    sample.mpnn_wrapper.masked_design.length > 0 && sample.mpnn_wrapper.legacy_ok === true &&
    sample.mpnn_wrapper.legacy_has_redesigned === false && sample.mpnn_wrapper.redesign_ok === true)
  check('redesign: empty design set raises an explicit warning',
    Array.isArray(sample?.warnings_empty) && sample.warnings_empty.length > 0 && /无可设计位点/.test(sample.warnings_empty[0]))
  console.log('  mini-complex redesign sample:', JSON.stringify({
    regions: sample?.base?.regions, counts: sample?.base?.counts,
    fixed_positions: sample?.base?.fixed_positions, design_positions: sample?.base?.design_positions,
  }))
  check('refold: self-alignment RMSD≈0 and aligned Cα count is complete',
    sample?.same_metrics?.metrics?.monomer_ca_rmsd < 1e-6 &&
    sample.same_metrics.metrics.n_aligned === sample.same_metrics.metrics.length_ref)
  check('refold: deterministic coordinate perturbation yields finite nonzero RMSD',
    sample?.perturbed_metrics?.metrics?.monomer_ca_rmsd > 0 &&
    sample.perturbed_metrics.metrics.monomer_ca_rmsd < 1.0)
  check('refold: F2Å is the aligned Cα fraction within 2 Å',
    sample?.same_metrics?.metrics?.fraction_ca_within_2A === 1.0 &&
    sample?.outlier_metrics?.metrics?.fraction_ca_within_2A >= 0 &&
    sample.outlier_metrics.metrics.fraction_ca_within_2A < 1.0)
  check('refold: unequal lengths align available residues and report warning',
    sample?.shorter_metrics?.metrics?.length_ref > sample?.shorter_metrics?.metrics?.length_model &&
    sample.shorter_metrics.metrics.n_aligned <= sample.shorter_metrics.metrics.length_model &&
    sample.shorter_metrics.metrics.warnings.length > 0)
  check('refold: dihedral three-state classifier finds helix and strand in 1ubq',
    sample?.ubq_ss_counts?.helix > 0 && sample.ubq_ss_counts.strand > 0,
    JSON.stringify(sample?.ubq_ss_counts))
  check('refold: ESMFold failure returns explicit error without a success result',
    sample?.fold_failure?.ok === false && /did not produce/.test(sample.fold_failure.error || ''))
  check('contact_consensus: residue, pair and dual-Jaccard layers with 2/3 frequency',
    sample?.contact_summary?.three_model_freq === 0.6667 &&
    sample.contact_summary.three_model_pair_freq === 0.6667 &&
    sample.contact_summary.three_model_jaccard?.residue_mean === 0.3333 &&
    sample.contact_summary.three_model_jaccard?.edge_mean === 0.3333 &&
    sample.contact_summary.three_model_jaccard?.edge_min === 0)
  check('contact_consensus: coverage, inclusive anchor thresholds, deterministic matrices and structured errors',
    sample?.contact_summary?.full_status === 'PASS' && sample.contact_summary.full_valid === 10 &&
    JSON.stringify(sample.contact_summary.full_anchors) === JSON.stringify(['B1', 'B2']) &&
    sample.contact_summary.warn_status === 'WARN' && sample.contact_summary.insufficient_status === 'INSUFFICIENT' &&
    sample.contact_summary.deterministic === true && sample.contact_summary.bad_inputs_ok === true &&
    sample.contact_summary.missing_occupancy_valid === true &&
    sample.contact_summary.artifact_written === true)
  check('contact_consensus: auto chain-role normalization preserves cross-model residue identities',
    sample?.contact_summary?.auto_mixed_labels_consistent === true)
  check('contact_cluster: legacy contact-consensus artifacts reanalyze model paths and preserve anchors',
    sample?.contact_summary?.legacy_artifact_clustered === true)
  console.log('  mini-complex refold alignment sample:', JSON.stringify({
    metrics: sample?.same_metrics?.metrics, verdict: sample?.same_metrics?.verdict,
  }))
  const missing = await runOp('redesign', { structure_path: join(REPO, 'test', 'fixtures', 'missing.pdb'), binder_chain: 'A' })
  const badChain = await runOp('redesign', { structure_path: FIXTURE, binder_chain: 'Z' })
  check('redesign: missing structure and invalid chain return clean errors',
    missing.json?.ok === false && badChain.json?.ok === false &&
    /not found/.test(missing.json?.error || '') && /not found/.test(badChain.json?.error || ''))
} else {
  skip('redesign/refold: synthetic structure helpers', 'fixture 或 biopython 不可用')
}

// ── L3 重组件（--heavy） ─────────────────────────────────────────────────────
console.log()
// G1 ingest v0: local sources, deterministic ledger, conflicts, and failure shapes.
console.log()
console.log('G1 ingest')
if (existsSync(FIXTURE) && hasBio) {
  const ingestSnippet = `
import csv, hashlib, json, os, shlex, sys, tempfile
from pathlib import Path
sys.path.insert(0, ${JSON.stringify(PYDIR)})
from Bio.PDB import MMCIFIO, PDBParser
from contact_tools import _parse_model, _protein_residues
from ingest_tools import FIELDS, run_ingest

fixture = ${JSON.stringify(FIXTURE)}
checks = {}
def mark(name, ok, detail=''):
    checks[name] = {'ok': bool(ok), 'detail': str(detail)}
def read_row(path, index=0):
    return json.loads(Path(path).read_text(encoding='utf-8').splitlines()[index])
def write(path, content):
    with open(path, 'w', encoding='utf-8', newline='') as handle:
        handle.write(content)

with tempfile.TemporaryDirectory(prefix='galatea-ingest-smoke-') as temp:
    root = Path(temp)
    model = _parse_model(fixture)
    chains = [(str(chain.id), _protein_residues(chain)) for chain in model.get_chains()]
    expected_chain = sorted(chains, key=lambda item: (len(item[1]), item[0].casefold(), item[0]))[0][0]
    pdb_ledger = root / 'structure.jsonl'
    pdb_result = run_ingest({'structures':[fixture], 'ledger':str(pdb_ledger), 'mode':'replace',
                            'target_id':'target1', 'structure_role':'cofold'})
    pdb_row = read_row(pdb_ledger) if pdb_ledger.exists() else {}
    mark('structure', pdb_result.get('ok') and pdb_row.get('binder_chain') == expected_chain and
         bool(pdb_row.get('sequence')) and pdb_row.get('seq_sha1') == hashlib.sha1(pdb_row['sequence'].encode()).hexdigest(),
         {'expected_chain':expected_chain,'actual_chain':pdb_row.get('binder_chain'),'length':len(pdb_row.get('sequence') or '')})
    structure_object = pdb_row.get('structures',[{}])[0]
    mark('schema_paths', set(pdb_row) == set(FIELDS) and structure_object.get('path') == os.path.realpath(fixture) and
         os.path.isabs(pdb_row.get('provenance',{}).get('source_path','')))
    mark('structure_object_role_enum', set(structure_object) == {'path','sha256','role','predictor','model','seed','binder_chain','target_chains'} and
         structure_object.get('role') == 'cofold' and len(structure_object.get('sha256','')) == 64 and
         structure_object.get('binder_chain') == pdb_row.get('binder_chain') and isinstance(structure_object.get('target_chains'),list))
    default_role_ledger = root / 'default-role.jsonl'
    default_role_result = run_ingest({'structures':[fixture], 'ledger':str(default_role_ledger), 'mode':'replace',
                                      'target_id':'target1'})
    default_role_row = read_row(default_role_ledger) if default_role_ledger.exists() else {}
    mark('default_role_warning', default_role_result.get('ok') and
         default_role_row.get('structures',[{}])[0].get('role') == 'other' and
         any('role unresolved' in warning for warning in default_role_result.get('warnings',[])))

    cif_path = root / 'missing-occupancy.cif'
    cif_ledger = root / 'missing-occupancy.jsonl'
    cif_ok = False
    cif_detail = ''
    try:
        structure = PDBParser(QUIET=True).get_structure('mini', fixture)
        writer = MMCIFIO(); writer.set_structure(structure); writer.save(str(cif_path))
        lines = cif_path.read_text(encoding='utf-8').splitlines(keepends=True)
        removed = False
        for loop_start, line in enumerate(lines):
            if line.strip().lower() != 'loop_':
                continue
            end = loop_start + 1
            while end < len(lines) and lines[end].lstrip().startswith('_'):
                end += 1
            headers = [item.strip().split()[0] for item in lines[loop_start + 1:end]]
            if '_atom_site.occupancy' not in headers:
                continue
            occ_index = headers.index('_atom_site.occupancy')
            row_index = end
            while row_index < len(lines):
                stripped = lines[row_index].strip()
                if not stripped or stripped.startswith('#') or stripped.lower() == 'loop_' or stripped.startswith('_'):
                    break
                values = shlex.split(stripped)
                if len(values) != len(headers):
                    raise ValueError('MMCIFIO atom_site row did not match its header')
                del values[occ_index]
                lines[row_index] = ' '.join(values) + ('\\n' if lines[row_index].endswith('\\n') else '')
                row_index += 1
            del lines[loop_start + 1 + occ_index]
            removed = True
            break
        write(cif_path, ''.join(lines))
        cif_result = run_ingest({'structures':[str(cif_path)], 'ledger':str(cif_ledger), 'mode':'replace',
                                 'target_id':'target1', 'structure_role':'cofold'})
        cif_row = read_row(cif_ledger) if cif_ledger.exists() else {}
        cif_ok = removed and cif_result.get('ok') and cif_row.get('sequence') == pdb_row.get('sequence')
        cif_detail = {'occupancy_removed':removed,'chain':cif_row.get('binder_chain'),'length':len(cif_row.get('sequence') or '')}
    except Exception as exc:
        cif_detail = type(exc).__name__ + ': ' + str(exc)
    mark('missing_occupancy_cif', cif_ok, cif_detail)

    write(root/'candidates.csv', 'design_id,sequence,generator,model_score\\ncsv1,ACD,gen_csv,1.25\\n')
    write(root/'candidates.json', json.dumps([{'design_id':'json1','sequence':'EFG'}]))
    write(root/'candidates.jsonl', json.dumps({'design_id':'jsonl1','sequence':'HIK'}) + '\\n')
    file_results = {}
    for ext in ('csv','json','jsonl'):
        ledger = root/(ext+'.jsonl')
        result = run_ingest({'candidates_file':str(root/('candidates.'+ext)), 'ledger':str(ledger), 'mode':'replace',
                             'target_id':'target1',
                             'score_schema':{'gen_csv.model_score':{'direction':'lower_better','version':'v1'}}})
        file_results[ext] = bool(result.get('ok') and ledger.exists() and read_row(ledger).get('design_id') == ext+'1')
    mark('candidate_formats', all(file_results.values()), file_results)
    mark('csv_score_column', read_row(root/'csv.jsonl').get('raw_scores',{}).get('gen_csv.model_score') == 1.25)

    record_ledger = root/'records.jsonl'
    record_result = run_ingest({'records':[{'design_id':'direct1','sequence':'ACD','generator':'local'}],
                                'ledger':str(record_ledger),'mode':'replace','target_id':'target1',
                                'target_sequence':'M K T'})
    direct = read_row(record_ledger) if record_ledger.exists() else {}
    mark('records_schema_defaults', record_result.get('ok') and set(direct) == set(FIELDS) and
         direct.get('binder_chain') is None and direct.get('backbone_id') is None and direct.get('hotspot_set') == [] and
         direct.get('raw_scores') == {} and direct.get('structures') == [] and direct.get('provenance',{}).get('source_type') == 'records')
    mark('known_sha1', direct.get('seq_sha1') == '5c8072153f0ee1a27d9b8b1166fed8bb1c4b853f')
    mark('target_identity_and_source_uid', direct.get('target_id') == 'target1' and
         direct.get('target_sha256') == hashlib.sha256(b'MKT').hexdigest() and
         direct.get('sequence_group_id') == hashlib.sha1(b'target1|ACD').hexdigest() and
         direct.get('source_uid') == 'local::target1:direct1' and len(direct.get('source_batch_id','')) == 16)

    first = {'design_id':'dup','sequence':'AAA','generator':'first','raw_scores':{'shared':1},'hotspot_set':['H1']}
    later = {'design_id':'dup','sequence':'BBB','generator':'last','raw_scores':{'shared':2,'later':3},'hotspot_set':['H1','H2']}
    conflicts = {}
    for policy in ('error','keep_first','keep_last','merge'):
        ledger = root/('conflict-'+policy+'.jsonl')
        conflicts[policy] = run_ingest({'records':[first,later], 'ledger':str(ledger), 'mode':'replace', 'on_conflict':policy,
                                        'target_id':'target1', 'score_namespace':'test',
                                        'score_schema':{'test.shared':{'direction':'higher_better','version':'v1'},
                                                        'test.later':{'direction':'lower_better','version':'v1'}}})
    first_row = read_row(root/'conflict-keep_first.jsonl')
    last_row = read_row(root/'conflict-keep_last.jsonl')
    merge_row = read_row(root/'conflict-merge.jsonl')
    error = conflicts['error']
    mark('conflict_error', error.get('ok') is False and error.get('stats',{}).get('n_conflict') == 1 and
         error.get('stats',{}).get('conflicts',[{}])[0].get('design_id') == 'dup' and not (root/'conflict-error.jsonl').exists())
    mark('conflict_keep_first', first_row.get('sequence') == 'AAA' and first_row.get('generator') == 'first')
    mark('conflict_keep_last', last_row.get('sequence') == 'BBB' and last_row.get('generator') == 'last')
    mark('conflict_merge', merge_row.get('sequence') == 'AAA' and merge_row.get('raw_scores') == {'test.shared':1,'test.later':3} and
         merge_row.get('hotspot_set') == ['H1','H2'])

    append_ledger = root/'append.jsonl'
    appended_first = run_ingest({'records':[{'design_id':'z','sequence':'AAA'},{'design_id':'a','sequence':'CCC'},{'design_id':'c','sequence':'DDD'}],
                                 'ledger':str(append_ledger),'mode':'replace','target_id':'target1'})
    appended_second = run_ingest({'records':[{'design_id':'b','sequence':'EEE'},{'design_id':'a','sequence':'GGG'}],
                                  'ledger':str(append_ledger),'mode':'append','on_conflict':'keep_last','target_id':'target1'})
    appended = [json.loads(line) for line in append_ledger.read_text(encoding='utf-8').splitlines()]
    mark('append_and_sort', appended_first.get('ok') and appended_second.get('ok') and
         appended_second.get('stats',{}).get('n_new') == 1 and appended_second.get('stats',{}).get('n_conflict') == 1 and
         appended_second.get('stats',{}).get('n_written') == 4 and
         [row['design_id'] for row in appended] == ['a','b','c','z'] and appended[0]['sequence'] == 'GGG')

    stable_records = [{'design_id':'Z','sequence':'ACD'},{'design_id':'a','sequence':'EFG'}]
    stable_a = root/'stable-a.jsonl'; stable_b = root/'stable-b.jsonl'
    stable_result_a = run_ingest({'records':stable_records,'ledger':str(stable_a),'mode':'replace','target_id':'target1'})
    stable_result_b = run_ingest({'records':stable_records,'ledger':str(stable_b),'mode':'replace','target_id':'target1'})
    mark('deterministic_bytes', stable_result_a.get('ok') and stable_result_b.get('ok') and
         stable_a.read_bytes() == stable_b.read_bytes() and
         Path(str(stable_a)+'.schema.json').read_bytes() == Path(str(stable_b)+'.schema.json').read_bytes())

    bad_csv = root/'bad.csv'; write(bad_csv, '')
    missing_id = run_ingest({'records':[{'sequence':'ACD'}],'ledger':str(root/'missing-id.jsonl'),'target_id':'target1'})
    empty_source = run_ingest({'records':[],'ledger':str(root/'empty.jsonl'),'target_id':'target1'})
    malformed_csv = run_ingest({'candidates_file':str(bad_csv),'ledger':str(root/'bad-csv.jsonl'),'target_id':'target1'})
    missing_path = run_ingest({'structures':[str(root/'absent.pdb')],'ledger':str(root/'missing-path.jsonl'),'target_id':'target1'})
    mark('bad_inputs', all(item.get('ok') is False for item in (missing_id,empty_source,malformed_csv,missing_path)),
         {key:item.get('error') for key,item in [('missing_id',missing_id),('empty',empty_source),('bad_csv',malformed_csv),('missing_path',missing_path)]})

    score_file = root/'scores.csv'
    write(score_file, 'design_id,score,flag\\nscore1,2.5,x\\n')
    score_ledger = root/'scores-ledger.jsonl'
    score_result = run_ingest({'records':[{'design_id':'score1','sequence':'ACD','raw_scores':{'score':'original'}}],
                               'scores_file':str(score_file),'ledger':str(score_ledger),'mode':'replace',
                               'target_id':'target1','source':'scorer','score_namespace':'scorer',
                               'score_schema':{'scorer.score':{'direction':'lower_better','version':'v1'},
                                               'scorer.flag':{'direction':'higher_better','version':'v1'}}})
    score_row = read_row(score_ledger) if score_ledger.exists() else {}
    score_schema_sidecar = json.loads(Path(str(score_ledger)+'.schema.json').read_text(encoding='utf-8'))
    mark('scores_join', score_result.get('ok') and score_row.get('raw_scores') == {'scorer.score':'original','scorer.flag':'x'} and
         score_row.get('provenance',{}).get('scores_path') == os.path.realpath(score_file) and
         score_schema_sidecar.get('score_schema_by_batch',{}).get(score_row.get('source_batch_id')) ==
         {'scorer.score':{'direction':'lower_better','version':'v1'},'scorer.flag':{'direction':'higher_better','version':'v1'}})
    dry_path = root/'dry-run.jsonl'
    dry = run_ingest({'records':[{'design_id':'dry','sequence':'ACD'}],'ledger':str(dry_path),'dry_run':True,'target_id':'target1'})
    mark('dry_run', dry.get('ok') and dry.get('stats',{}).get('n_written') == 1 and not dry_path.exists())

    identity_path = root/'target-identity.jsonl'
    identity = run_ingest({'records':[{'design_id':'same','target_id':'t1','sequence':'ACD'},
                                      {'design_id':'same','target_id':'t2','sequence':'ACD'}],
                           'ledger':str(identity_path),'mode':'replace'})
    identity_rows = [json.loads(line) for line in identity_path.read_text(encoding='utf-8').splitlines()] if identity_path.exists() else []
    mark('same_sequence_different_targets_stay_distinct', identity.get('ok') and len(identity_rows) == 2 and
         identity_rows[0].get('seq_sha1') == identity_rows[1].get('seq_sha1') and
         identity_rows[0].get('sequence_group_id') != identity_rows[1].get('sequence_group_id'))

    lineage_path = root/'lineage.jsonl'
    child = run_ingest({'records':[{'design_id':'child','target_id':'t1','sequence':'ACD','parent_id':'parent'}],
                        'ledger':str(lineage_path),'mode':'replace'})
    child_row = read_row(lineage_path) if lineage_path.exists() else {}
    dangling_ok = (child.get('ok') and child_row.get('lineage_status') == 'DANGLING_PARENT' and
                   child_row.get('lineage_root') is None and
                   any(item.startswith('DANGLING_PARENT:') for item in child.get('warnings',[])))
    parent = run_ingest({'records':[{'design_id':'parent','target_id':'t1','sequence':'EFG'}],
                         'ledger':str(lineage_path),'mode':'append'})
    lineage_rows = [json.loads(line) for line in lineage_path.read_text(encoding='utf-8').splitlines()] if lineage_path.exists() else []
    child_row = next((item for item in lineage_rows if item['design_id'] == 'child'), {})
    parent_row = next((item for item in lineage_rows if item['design_id'] == 'parent'), {})
    mark('dangling_parent_is_kept_then_resolved', dangling_ok and parent.get('ok') and
         child_row.get('lineage_status') == 'RESOLVED' and child_row.get('lineage_root') == 'parent' and child_row.get('lineage_depth') == 1 and
         parent_row.get('lineage_status') == 'ROOT' and parent_row.get('lineage_depth') == 0)

    cycle_path = root/'cycle.jsonl'
    cycle = run_ingest({'records':[{'design_id':'x','target_id':'t1','sequence':'ACD','parent_id':'y'},
                                   {'design_id':'y','target_id':'t1','sequence':'EFG','parent_id':'x'}],
                        'ledger':str(cycle_path),'mode':'replace'})
    bad_role = run_ingest({'structures':[fixture],'ledger':str(root/'bad-role.jsonl'),'target_id':'t1','structure_role':'guess'})
    mark('lineage_cycle_and_invalid_role_rejected', cycle.get('ok') is False and 'LINEAGE_CYCLE' in cycle.get('error','') and
         bad_role.get('ok') is False and 'invalid structure_role' in bad_role.get('error',''))

print(json.dumps({'checks':checks}, ensure_ascii=False))
`
  const r = await runPythonSnippet(ingestSnippet)
  const checks = r.json?.checks || {}
  if (!r.json) console.log('  ingest unit output:', (r.err || r.out || '').slice(-500))
  check('ingest: structures source, automatic shortest chain, schema, and absolute paths', checks.structure?.ok && checks.schema_paths?.ok,
    JSON.stringify(checks.structure?.detail))
  check('ingest: structures are checksummed objects with a valid explicit role', checks.structure_object_role_enum?.ok)
  check('ingest: missing structure role defaults to other with a warning', checks.default_role_warning?.ok)
  check('ingest: CIF occupancy-missing fixture uses fallback parser', checks.missing_occupancy_cif?.ok,
    JSON.stringify(checks.missing_occupancy_cif?.detail))
  check('ingest: CSV / JSON / JSONL and CSV raw score columns', checks.candidate_formats?.ok && checks.csv_score_column?.ok,
    JSON.stringify(checks.candidate_formats?.detail))
  check('ingest: records schema defaults and known SHA1', checks.records_schema_defaults?.ok && checks.known_sha1?.ok)
  check('ingest: target identity, target hash, sequence group, source UID, and batch ID', checks.target_identity_and_source_uid?.ok)
  check('ingest: error / keep_first / keep_last / merge conflict policies', checks.conflict_error?.ok &&
    checks.conflict_keep_first?.ok && checks.conflict_keep_last?.ok && checks.conflict_merge?.ok)
  check('ingest: append 3 then 2 with one conflict and stable sort', checks.append_and_sort?.ok,
    JSON.stringify(checks.append_and_sort?.detail))
  check('ingest: same input to two paths is byte-identical', checks.deterministic_bytes?.ok)
  check('ingest: missing ID / empty source / malformed CSV / missing path return ok:false', checks.bad_inputs?.ok,
    JSON.stringify(checks.bad_inputs?.detail))
  check('ingest: scores join preserves existing keys and records source path', checks.scores_join?.ok)
  check('ingest: dry_run previews without writing', checks.dry_run?.ok)
  check('ingest: same sequence across targets remains two candidate identities', checks.same_sequence_different_targets_stay_distinct?.ok)
  check('ingest: dangling parent is retained and resolves when parent arrives', checks.dangling_parent_is_kept_then_resolved?.ok)
  check('ingest: cycles and unknown structure roles are rejected', checks.lineage_cycle_and_invalid_role_rejected?.ok)
} else {
  skip('ingest: structure and file format unit coverage', 'fixture or biopython unavailable')
}

{
  const bridgeDir = mkdtempSync(join(tmpdir(), 'galatea-ingest-op-'))
  const ledger = join(bridgeDir, 'bridge.jsonl')
  const r = await runOp('ingest', { records: [{ design_id: 'bridge1', sequence: 'ACD' }], ledger, mode: 'replace', target_id: 'target1' })
  check('ingest: registered op writes one ledger row', r.code === 0 && r.json?.ok === true &&
    r.json?.stats?.n_written === 1 && existsSync(ledger), JSON.stringify(r.json))
  rmSync(bridgeDir, { recursive: true, force: true })
}

// G6 portfolio v0: eligibility, coverage floors, diversity caps, output and determinism.
console.log('G6 portfolio')
{
  const temp = mkdtempSync(join(tmpdir(), 'galatea-portfolio-smoke-'))
  const defaultConfig = {
    total_slots: 10, min_targets: 0, per_target_min: 0, per_target_max: null,
    max_per_backbone: 0, max_per_lineage: 0, max_per_pose_cluster: 0,
    max_per_sequence_cluster: 0, max_per_contact_cluster: 0,
    high_risk_fraction_max: 1, exact_sequence_max_per_target: 0,
  }
  const csvCell = (value) => {
    if (value === null || value === undefined) return ''
    const text = String(value)
    return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
  }
  function writeCandidates(name, rows) {
    const fields = [...new Set(rows.flatMap((row) => Object.keys(row)))]
    const content = [fields.join(','), ...rows.map((row) => fields.map((field) => csvCell(row[field])).join(','))].join('\n') + '\n'
    const path = join(temp, `${name}.csv`)
    writeFileSync(path, content, 'utf8')
    return path
  }
  function candidate(design_id, target_id, percentile, extra = {}) {
    return {
      design_id, target_id, consensus_percentile: percentile, consensus_score: percentile,
      qc_status: 'PASS', sequence: `SEQ_${design_id}`, ...extra,
    }
  }
  async function portfolio(name, rows, config = {}) {
    const candidates = writeCandidates(name, rows)
    const out = join(temp, `${name}-out`)
    const result = await runOp('portfolio', {
      candidates, config: { ...defaultConfig, ...config }, out,
    })
    return { ...result, out, candidates }
  }
  const readSelected = (out) => readFileSync(join(out, 'portfolio_selected.csv'), 'utf8')
  const readRejected = (out) => readFileSync(join(out, 'portfolio_rejected.csv'), 'utf8')

  try {
    const dedup = await portfolio('dedup', [
      candidate('dup-low', 'T1', 0.4, { sequence: 'SAME' }),
      candidate('dup-best', 'T1', 0.9, { sequence: 'SAME' }),
      candidate('other', 'T1', 0.7),
    ], { total_slots: 2, exact_sequence_max_per_target: 1 })
    check('portfolio: exact same-target sequence keeps rank-first candidate', dedup.json?.ok === true &&
      readSelected(dedup.out).includes('dup-best') && !readSelected(dedup.out).includes('dup-low') &&
      readRejected(dedup.out).includes('duplicate_sequence'))
    check('portfolio: derived sequence_group_id matches ingest SHA1 formula',
      readSelected(dedup.out).includes('sequence_group_id') &&
      readSelected(dedup.out).includes(createHash('sha1').update('T1|SAME').digest('hex')))

    const capCases = [
      ['backbone', 'backbone_id', 'max_per_backbone'],
      ['lineage', 'lineage_id', 'max_per_lineage'],
      ['pose', 'pose_cluster_id', 'max_per_pose_cluster'],
      ['sequence_cluster', 'sequence_cluster_id', 'max_per_sequence_cluster'],
      ['contact', 'contact_cluster_id', 'max_per_contact_cluster'],
    ]
    for (const [label, field, configKey] of capCases) {
      const capConfig = { total_slots: 3, [configKey]: 1 }
      if (configKey === 'max_per_lineage') capConfig[configKey] = 1
      const result = await portfolio(`cap-${label}`, [
        candidate(`${label}-a`, 'T1', 0.9, { [field]: 'shared' }),
        candidate(`${label}-b`, 'T1', 0.8, { [field]: 'shared' }),
        candidate(`${label}-c`, 'T1', 0.7, { [field]: 'other' }),
      ], capConfig)
      const capName = label === 'pose' ? 'pose_cluster' : label === 'contact' ? 'contact_cluster' : label
      check(`portfolio: ${label} cap skips a blocked candidate`, result.json?.ok === true &&
        result.json?.result?.summary?.cap_skip_counts?.global_competition?.[capName] >= 1 &&
        readRejected(result.out).includes(`cap_blocked:${capName}`))
    }

    const autoLineage = await portfolio('lineage-auto', Array.from({ length: 6 }, (_, index) =>
      candidate(`lin-${index + 1}`, 'T1', 0.99 - index * 0.01, { lineage_id: 'L1' })),
    { total_slots: 100, max_per_lineage: null })
    check('portfolio: automatic lineage cap = max(2, ceil(5% × 100)) = 5',
      autoLineage.json?.result?.summary?.config?.max_per_lineage === 5 &&
      autoLineage.json?.result?.summary?.stage_stats?.global_competition?.selected === 5 &&
      autoLineage.json?.result?.summary?.cap_skip_counts?.global_competition?.lineage === 1)

    const risk = await portfolio('risk-cap', [
      candidate('risk-a', 'T1', 0.99, { expression_risk: 'high_risk' }),
      candidate('risk-b', 'T1', 0.98, { expression_risk: 'HIGH_RISK' }),
      candidate('risk-c', 'T1', 0.97, { expression_risk: 'High_Risk' }),
      candidate('risk-low', 'T1', 0.2, { expression_risk: 'LOW' }),
    ], { total_slots: 10, high_risk_fraction_max: 0.2 })
    check('portfolio: case-insensitive HIGH_RISK fraction cap applies',
      risk.json?.result?.summary?.config?.derived?.max_high_risk === 2 &&
      risk.json?.result?.summary?.coverage?.per_target?.T1 === 3 &&
      risk.json?.result?.summary?.cap_skip_counts?.global_competition?.high_risk === 1)

    const targetCap = await portfolio('target-cap', [
      candidate('target-a', 'T1', 0.9), candidate('target-b', 'T1', 0.8), candidate('target-c', 'T1', 0.7),
    ], { total_slots: 3, per_target_max: 1 })
    check('portfolio: per_target_max blocks excess candidates and reports shortfall',
      targetCap.json?.result?.summary?.coverage?.per_target?.T1 === 1 &&
      targetCap.json?.result?.summary?.counts?.slots_shortfall === 2 &&
      targetCap.json?.result?.summary?.cap_skip_counts?.global_competition?.per_target_max === 2)

    const floor = await portfolio('floor-cap', [
      candidate('a-top', 'A', 0.99, { backbone_id: 'shared' }),
      candidate('a-next', 'A', 0.8, { backbone_id: 'A2' }),
      candidate('b-top', 'B', 0.98, { backbone_id: 'shared' }),
      candidate('b-next', 'B', 0.7, { backbone_id: 'B2' }),
    ], { total_slots: 3, min_targets: 2, max_per_backbone: 1 })
    check('portfolio: Stage 1 floor continues after backbone cap blocks first candidate',
      floor.json?.result?.summary?.stage_stats?.coverage_floor?.selected === 2 &&
      floor.json?.result?.summary?.cap_skip_counts?.coverage_floor?.backbone === 1 &&
      floor.json?.result?.summary?.coverage?.per_target?.A === 2 &&
      floor.json?.result?.summary?.coverage?.per_target?.B === 1)

    const coverage = await portfolio('coverage', [
      candidate('a1', 'A', 0.9), candidate('a2', 'A', 0.8),
      candidate('b1', 'B', 0.89), candidate('b2', 'B', 0.79),
      candidate('c1', 'C', 0.88), candidate('c2', 'C', 0.78),
    ], { total_slots: 2, min_targets: 2 })
    const impossible = await portfolio('coverage-impossible', [candidate('only-a', 'A', 0.9)], { min_targets: 2 })
    check('portfolio: min_targets coverage floor selects two distinct targets',
      coverage.json?.result?.summary?.coverage?.n_targets_selected === 2 && coverage.json?.result?.summary?.flags?.length === 0)
    check('portfolio: min_targets above eligible targets returns structured ok:false', impossible.json?.ok === false &&
      /exceeds eligible target count/.test(impossible.json?.error || ''))

    const missingDimensions = await portfolio('missing-dimensions', [
      candidate('known', 'T1', 0.9, {
        backbone_id: 'B1', lineage_id: 'L1', pose_cluster_id: 'P1',
        sequence_cluster_id: 'S1', contact_cluster_id: 'C1', expression_risk: 'LOW',
      }),
      candidate('unknown', 'T1', 0.8, { sequence: '' }),
    ], {
      total_slots: 2, max_per_backbone: 1, max_per_lineage: 1, max_per_pose_cluster: 1,
      max_per_sequence_cluster: 1, max_per_contact_cluster: 1, exact_sequence_max_per_target: 1,
      high_risk_fraction_max: 0.5,
    })
    const missingWarnings = missingDimensions.json?.result?.summary?.warnings?.join('\n') || ''
    check('portfolio: missing optional dimensions warn and leave those candidates uncapped',
      ['backbone_id', 'lineage_id', 'pose_cluster_id', 'sequence_cluster_id', 'contact_cluster_id',
        'sequence_group_id', 'expression_risk'].every((field) => missingWarnings.includes(field)))

    const midrank = await portfolio('midrank', [
      candidate('z-tie', 'T1', null, { consensus_percentile: '', consensus_score: 0.9 }),
      candidate('a-tie', 'T1', null, { consensus_percentile: '', consensus_score: 0.9 }),
      candidate('low', 'T1', null, { consensus_percentile: '', consensus_score: 0.1 }),
    ], { total_slots: 1 })
    check('portfolio: score fallback computes target midranks and design_id tie-break',
      midrank.json?.ok === true && readSelected(midrank.out).includes('a-tie') &&
      Math.abs((midrank.json?.result?.summary?.counts?.selected ?? 0) - 1) === 0 &&
      readSelected(midrank.out).includes('0.6666666666666666'))

    const deterministic1 = await portfolio('deterministic-1', [
      candidate('d1', 'T1', 0.9, { backbone_id: 'B1' }), candidate('d2', 'T1', 0.8, { backbone_id: 'B1' }),
      candidate('d3', 'T1', 0.7, { backbone_id: 'B2' }),
    ], { total_slots: 2, max_per_backbone: 1 })
    const deterministic2 = await portfolio('deterministic-2', [
      candidate('d1', 'T1', 0.9, { backbone_id: 'B1' }), candidate('d2', 'T1', 0.8, { backbone_id: 'B1' }),
      candidate('d3', 'T1', 0.7, { backbone_id: 'B2' }),
    ], { total_slots: 2, max_per_backbone: 1 })
    const quartet = ['portfolio_selected.csv', 'portfolio_rejected.csv', 'portfolio_summary.json', 'portfolio_manifest.json']
    check('portfolio: four output files are byte-identical across independent processes',
      deterministic1.json?.ok === true && deterministic2.json?.ok === true && quartet.every((file) =>
        readFileSync(join(deterministic1.out, file)).equals(readFileSync(join(deterministic2.out, file)))))

    const badInputs = [
      ['empty table', () => writeFileSync(join(temp, 'bad-empty.csv'), '', 'utf8')],
      ['missing design_id column', () => writeFileSync(join(temp, 'bad-id-column.csv'), 'target_id,consensus_score\nT1,0.5\n', 'utf8')],
      ['duplicate design_id', () => writeCandidates('bad-duplicate', [candidate('same', 'T1', 0.9), candidate('same', 'T2', 0.8)])],
      ['all not_rankable', () => writeCandidates('bad-rankable', [candidate('nr1', 'T1', null, { consensus_percentile: '', consensus_score: '' })])],
    ]
    for (const [label, prepare] of badInputs) {
      prepare()
      const name = label === 'empty table' ? 'bad-empty' : label === 'missing design_id column' ? 'bad-id-column' : label === 'duplicate design_id' ? 'bad-duplicate' : 'bad-rankable'
      const r = await runOp('portfolio', { candidates: join(temp, `${name}.csv`), out: join(temp, `${name}-out`), config: defaultConfig })
      check(`portfolio: ${label} returns structured ok:false`, r.code === 0 && r.json?.ok === false && typeof r.json?.error === 'string')
    }
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
}

// G8-lite coverage v0: hand-calculated coverage snapshots and rescue plan.
console.log('G8-lite coverage')
{
  const temp = mkdtempSync(join(tmpdir(), 'galatea-coverage-smoke-'))
  const candidates = join(temp, 'manual-candidates.csv')
  const selection = join(temp, 'selection.json')
  const quota = join(temp, 'quota.json')
  const out = join(temp, 'rescue-out')
  const rows = [
    ['T1', 'd1', 'G1', 'B1', 'F1', '0.90'],
    ['T1', 'd2', 'G1', 'B2', 'F1', '0.80'],
    ['T1', 'd3', 'G2', 'B3', 'F2', '0.70'],
    ['T1', 'd4', 'G2', 'B4', 'F2', '0.60'],
    ['T2', 'd5', 'G1', 'B1', 'F1', '0.50'],
    ['T2', 'd6', 'G1', 'B1', 'F1', '0.40'],
    ['T4', 'd7', 'G1', 'B1', 'F1', '0.90'],
    ['T4', 'd8', 'G1', 'B2', 'F1', '0.80'],
    ['T4', 'd9', 'G1', 'B3', 'F1', '0.70'],
    ['T4', 'd10', 'G2', 'B4', 'F2', '0.10'],
    ['T5', 'e1', 'G1', 'B1', 'F1', '0.90'],
    ['T5', 'e2', 'G1', 'B2', 'F1', '0.80'],
    ['T5', 'e3', 'G2', 'B3', 'F2', '0.70'],
    ['T5', 'e4', 'G2', 'B4', 'F2', '0.60'],
  ]
  writeFileSync(candidates, [
    'target_id,design_id,generator,backbone_id,contact_cluster_id,consensus_score,wet_label',
    ...rows.map((row) => row.join(',') + ',DO_NOT_READ_OR_USE'),
  ].join('\n') + '\n', 'utf8')
  writeFileSync(selection, JSON.stringify(['d1', 'd2', 'd3', 'd5', 'd7', 'd8', 'e1', 'e2', 'x1']), 'utf8')
  writeFileSync(quota, JSON.stringify({ T1: 3, T2: 2, T3: 1, T4: 2, T5: 2 }), 'utf8')
  const config = { out, rescue: true }
  const files = [
    'coverage_audit.csv', 'coverage_summary.json', 'coverage_manifest.json',
    'rescue_plan.json', 'rescue_plan.csv',
  ]
  try {
    const args = { candidates, selection, quota, config }
    const result = await runOp('coverage', args)
    check('coverage: manual T1-T5 fixture completes', result.json?.ok === true, JSON.stringify(result.json))
    const audit = readFileSync(join(out, 'coverage_audit.csv'), 'utf8')
    const summary = JSON.parse(readFileSync(join(out, 'coverage_summary.json'), 'utf8'))
    const rescue = JSON.parse(readFileSync(join(out, 'rescue_plan.json'), 'utf8'))
    const manifest = JSON.parse(readFileSync(join(out, 'coverage_manifest.json'), 'utf8'))
    check('coverage: unknown selection ID and unconsumed-generator detail',
      JSON.stringify(summary.selection_unknown_ids) === JSON.stringify(['x1']) &&
      JSON.stringify(summary.unconsumed_generators) === JSON.stringify([['T5', 'G2', 2, 0.5]]))
    check('coverage: rescue adds d6 and replaces d8→d10 / e2→e3',
      JSON.stringify(rescue.actions.map((action) => [
        action.action, action.target_id, action.add_design_id,
        action.replace_design_id, action.reason_code,
      ])) === JSON.stringify([
        ['ADD', 'T2', 'd6', null, 'QUOTA_UNDERFILLED'],
        ['REPLACE', 'T4', 'd10', 'd8', 'SINGLE_CONTACT_FAMILY'],
        ['REPLACE', 'T5', 'e3', 'e2', 'SINGLE_CONTACT_FAMILY'],
      ]) &&
      JSON.stringify(rescue.counts) === JSON.stringify({ add: 1, replace: 2, unresolvable: 3 }))
    check('coverage: audit includes all five targets and excludes label values',
      ['T1', 'T2', 'T3', 'T4', 'T5'].every((target) => audit.includes(target + ',')) &&
      files.every((file) => !readFileSync(join(out, file), 'utf8').includes('DO_NOT_READ_OR_USE')))
    check('coverage: manifest hashes every emitted non-manifest artifact',
      Object.entries(manifest.outputs).length === 4 &&
      Object.entries(manifest.outputs).every(([file, hash]) =>
        createHash('sha256').update(readFileSync(join(out, file))).digest('hex') === hash))

    const auditLines = audit.trimEnd().split('\n').map((line) => line.split(','))
    const auditFields = auditLines[0]
    const auditByTarget = Object.fromEntries(auditLines.slice(1).map((values) => [
      values[0], Object.fromEntries(auditFields.map((field, index) => [field, values[index]])),
    ]))
    const expectedAudit = {
      T1: ['4', '3', '3', '2', '4', '2', '2', '3', '2', ''],
      T2: ['2', '1', '2', '1', '1', '1', '1', '1', '1', 'QUOTA_UNDERFILLED'],
      T3: ['0', '0', '1', '0', '0', '0', '0', '0', '0', 'QUOTA_UNDERFILLED;ZERO_CANDIDATES'],
      T4: ['4', '2', '2', '2', '4', '2', '1', '2', '1', 'SINGLE_CONTACT_FAMILY;SINGLE_GENERATOR'],
      T5: ['4', '2', '2', '2', '4', '2', '1', '2', '1',
        'GENERATOR_UNCONSUMED;SINGLE_CONTACT_FAMILY;SINGLE_GENERATOR'],
    }
    const checkedAuditFields = [
      'n_candidates', 'n_selected', 'K_t', 'n_generators_pool', 'n_backbones_pool',
      'n_contact_families_pool', 'n_generators_sel', 'n_backbones_sel',
      'n_contact_families_sel', 'flags',
    ]
    check('coverage: T1-T5 per-column counts and sorted flags match the hand calculation',
      Object.keys(expectedAudit).every((target) => JSON.stringify(
        checkedAuditFields.map((field) => auditByTarget[target]?.[field]),
      ) === JSON.stringify(expectedAudit[target])),
      JSON.stringify(auditByTarget))
    check('coverage: exact T2/T3 unresolvable list',
      JSON.stringify(rescue.unresolvable) === JSON.stringify([
        { check: 'contact', reason_code: 'NO_ALTERNATIVE_CONTACT_FAMILY', target_id: 'T2' },
        { check: 'generator', reason_code: 'NO_ALTERNATIVE_GENERATOR', target_id: 'T2' },
        { check: 'quota', reason_code: 'QUOTA_POOL_EXHAUSTED', target_id: 'T3' },
      ]),
      JSON.stringify(rescue.unresolvable))

    const firstBytes = Object.fromEntries(files.map((file) => [
      file, readFileSync(join(out, file)),
    ]))
    const second = await runOpWithHashSeed('coverage', args, 991)
    check('coverage: all five artifacts match across independent processes and hash seeds',
      result.json?.ok === true && second.json?.ok === true && files.every((file) =>
        firstBytes[file].equals(readFileSync(join(out, file)))))

    const missingSelection = await runOp('coverage', {
      candidates, config: { out: join(temp, 'missing-selection'), rescue: true },
    })
    check('coverage: rescue without selection returns structured ok:false',
      missingSelection.code === 0 && missingSelection.json?.ok === false &&
      missingSelection.json?.reason_code === 'INVALID_INPUT')

    const duplicate = join(temp, 'duplicate.csv')
    writeFileSync(duplicate, 'design_id,target_id\nd1,T1\nd1,T2\n', 'utf8')
    const duplicateResult = await runOp('coverage', {
      candidates: duplicate, config: { out: join(temp, 'duplicate-out') },
    })
    check('coverage: duplicate design_id returns structured ok:false',
      duplicateResult.code === 0 && duplicateResult.json?.ok === false)

    const missingTarget = join(temp, 'missing-target.csv')
    writeFileSync(missingTarget, 'design_id,other\nd1,T1\n', 'utf8')
    const missingResult = await runOp('coverage', {
      candidates: missingTarget, config: { out: join(temp, 'missing-target-out') },
    })
    check('coverage: missing target_id returns structured ok:false',
      missingResult.code === 0 && missingResult.json?.ok === false)

    const missingDesign = join(temp, 'missing-design.csv')
    writeFileSync(missingDesign, 'other,target_id\nx,T1\n', 'utf8')
    const missingDesignResult = await runOp('coverage', {
      candidates: missingDesign, config: { out: join(temp, 'missing-design-out') },
    })
    check('coverage: missing design_id returns structured ok:false',
      missingDesignResult.code === 0 && missingDesignResult.json?.ok === false)

    const badQuota = join(temp, 'bad-quota.json')
    writeFileSync(badQuota, JSON.stringify({ T1: 1.5 }), 'utf8')
    const badQuotaResult = await runOp('coverage', {
      candidates, quota: badQuota, config: { out: join(temp, 'bad-quota-out') },
    })
    check('coverage: non-integer K_t returns structured ok:false',
      badQuotaResult.code === 0 && badQuotaResult.json?.ok === false)

    const noGenerator = join(temp, 'no-generator.csv')
    writeFileSync(noGenerator,
      'design_id,target_id,backbone_id,contact_cluster_id\na,T1,B1,F1\nb,T1,B1,F1\n', 'utf8')
    const degraded = await runOp('coverage', {
      candidates: noGenerator, config: { out: join(temp, 'degraded-out') },
    })
    const degradedSummary = JSON.parse(readFileSync(
      join(temp, 'degraded-out', 'coverage_summary.json'), 'utf8',
    ))
    check('coverage: missing generator column warns and skips SINGLE_GENERATOR',
      degraded.json?.ok === true &&
      degradedSummary.warnings.includes('MISSING_COLUMN_GENERATOR') &&
      degradedSummary.targets.per_target.T1.n_generators_pool === null &&
      !degradedSummary.targets.per_target.T1.flags.includes('SINGLE_GENERATOR'))

    const cappedOut = join(temp, 'capped-out')
    const capped = await runOp('coverage', {
      candidates, selection, quota,
      config: { out: cappedOut, rescue: true, max_actions: 0 },
    })
    const cappedPlan = JSON.parse(readFileSync(join(cappedOut, 'rescue_plan.json'), 'utf8'))
    const cappedSummary = JSON.parse(readFileSync(join(cappedOut, 'coverage_summary.json'), 'utf8'))
    check('coverage: max_actions stops before the first action and records a warning',
      capped.json?.ok === true && cappedPlan.actions.length === 0 &&
      cappedSummary.warnings.includes('MAX_ACTIONS_REACHED'))

    const oneCandidate = join(temp, 'one-candidate.csv')
    const conflictingSelection = join(temp, 'conflicting-selection.csv')
    writeFileSync(oneCandidate,
      'design_id,target_id,generator,backbone_id,contact_cluster_id\nd1,T1,G1,B1,F1\n', 'utf8')
    writeFileSync(conflictingSelection, 'design_id,target_id\nd1,T9\n', 'utf8')
    const conflictOut = join(temp, 'conflict-out')
    const conflict = await runOp('coverage', {
      candidates: oneCandidate, selection: conflictingSelection,
      config: { out: conflictOut },
    })
    const conflictSummary = JSON.parse(readFileSync(join(conflictOut, 'coverage_summary.json'), 'utf8'))
    check('coverage: pool target wins over a conflicting selection target_id',
      conflict.json?.ok === true &&
      JSON.stringify(Object.keys(conflictSummary.targets.per_target)) === JSON.stringify(['T1']) &&
      conflictSummary.warnings.includes('SELECTION_TARGET_CONFLICTS_POOL_WINS'))

    const mappedCandidates = join(temp, 'mapped-candidates.csv')
    const mappedSelection = join(temp, 'mapped-selection.json')
    const mappedOut = join(temp, 'mapped-out')
    writeFileSync(mappedCandidates, [
      'design_id,target_id,generator,backbone_id,target_footprint_cluster_id,ipsae_score',
      'a,T1,G1,B1,F1,0.90',
      'b,T1,G1,B2,F1,0.80',
      'c,T1,G2,B3,F2,0.70',
      'd,T1,G3,B4,F3,0.60',
    ].join('\n') + '\n', 'utf8')
    writeFileSync(mappedSelection, JSON.stringify(['a', 'b']), 'utf8')
    const mapped = await runOp('coverage', {
      candidates: mappedCandidates, selection: mappedSelection,
      config: {
        out: mappedOut,
        rescue: true,
        columns: { contact: 'target_footprint_cluster_id', score: 'ipsae_score' },
      },
    })
    const mappedPlan = JSON.parse(readFileSync(join(mappedOut, 'rescue_plan.json'), 'utf8'))
    check('coverage: custom contact and score column mappings drive deterministic rescue',
      mapped.json?.ok === true && mappedPlan.actions.length === 1 &&
      mappedPlan.actions[0].action === 'REPLACE' &&
      mappedPlan.actions[0].replace_design_id === 'b' &&
      mappedPlan.actions[0].add_design_id === 'c')
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
}

// G7 budget v0: cross-target integer allocation, feasibility and deterministic artifacts.
console.log('G7 budget')
{
  const temp = mkdtempSync(join(tmpdir(), 'galatea-budget-smoke-'))
  const headers = ['target_id', 'pilot_attempts', 'pilot_passes', 'n_eligible', 'n_backbones', 'n_contact_clusters', 'uncertainty']
  const cell = (value) => {
    if (value === null || value === undefined) return ''
    const text = String(value)
    return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
  }
  function writeTargets(name, rows, extraFields = []) {
    const fields = [...new Set([...headers, ...extraFields, ...rows.flatMap((row) => Object.keys(row))])]
    const content = [fields.join(','), ...rows.map((row) => fields.map((field) => cell(row[field])).join(','))].join('\n') + '\n'
    const path = join(temp, `${name}.csv`)
    writeFileSync(path, content, 'utf8')
    return path
  }
  async function budget(name, rows, config, extraFields = []) {
    const targets = writeTargets(name, rows, extraFields)
    const out = join(temp, `${name}-out`)
    const result = await runOp('budget', { targets, config, out })
    return { ...result, targets, out }
  }
  const readSummary = (out) => JSON.parse(readFileSync(join(out, 'budget_summary.json'), 'utf8'))
  const parseCsv = (text) => {
    const lines = text.trimEnd().split('\n')
    const parseLine = (line) => {
      const cells = []
      let value = ''
      let quoted = false
      for (let i = 0; i < line.length; i++) {
        const char = line[i]
        if (quoted) {
          if (char === '"' && line[i + 1] === '"') { value += '"'; i++ }
          else if (char === '"') quoted = false
          else value += char
        } else if (char === '"') quoted = true
        else if (char === ',') { cells.push(value); value = '' }
        else value += char
      }
      cells.push(value)
      return cells
    }
    const fields = parseLine(lines[0])
    return lines.slice(1).map((line) => Object.fromEntries(parseLine(line).map((value, index) => [fields[index], value])))
  }
  const files = ['budget_allocation.csv', 'budget_summary.json', 'budget_manifest.json', 'portfolio_handoff.json']

  try {
    const fixtureRows = [
      { target_id: 't1', pilot_attempts: 24, pilot_passes: 20, n_eligible: 50 },
      { target_id: 't2', pilot_attempts: 24, pilot_passes: 12, n_eligible: 40 },
      { target_id: 't3', pilot_attempts: 24, pilot_passes: 6, n_eligible: 45 },
      { target_id: 't4', pilot_attempts: 24, pilot_passes: 2, n_eligible: 30, n_backbones: 6 },
      { target_id: 't5', pilot_attempts: 12, pilot_passes: 0, n_eligible: 12 },
    ]
    const fixture = await budget('manual-fixture', fixtureRows, { total_budget: 100, preset: 'balanced' })
    const manual = fixture.json?.result?.summary
    const allocationRows = fixture.json?.ok === true
      ? parseCsv(readFileSync(join(fixture.out, 'budget_allocation.csv'), 'utf8'))
      : []
    const byId = Object.fromEntries(allocationRows.map((row) => [row.target_id, row]))
    const roundedRates = Object.fromEntries(allocationRows.map((row) => [row.target_id, Number(Number(row.r_tilde).toFixed(10))]))
    check('budget: manual fixture reproduces r_tilde to 10 decimals', JSON.stringify(roundedRates) ===
      JSON.stringify({ t1: 0.8076923077, t2: 0.5, t3: 0.2692307692, t4: 0.1153846154, t5: 0.0714285714 }))
    check('budget: manual fixture pools and each tier quota match hand calculation',
      manual?.tiers?.floor_pool === 20 && manual?.tiers?.exploit_pool === 65 && manual?.tiers?.reserve_pool === 15 &&
      JSON.stringify(Object.fromEntries(allocationRows.map((row) => [row.target_id, Number(row.floor_q)]))) ===
        JSON.stringify({ t1: 4, t2: 4, t3: 4, t4: 4, t5: 4 }) &&
      JSON.stringify(Object.fromEntries(allocationRows.map((row) => [row.target_id, Number(row.exploit_q)]))) ===
        JSON.stringify({ t1: 22, t2: 17, t3: 12, t4: 8, t5: 6 }) &&
      JSON.stringify(Object.fromEntries(allocationRows.map((row) => [row.target_id, Number(row.reserve_q)]))) ===
        JSON.stringify({ t1: 0, t2: 0, t3: 5, t4: 5, t5: 5 }))
    check('budget: manual fixture K_t is {26,21,21,17,15}, sum=100 and classes match',
      JSON.stringify(manual?.allocation?.per_target) === JSON.stringify({ t1: 26, t2: 21, t3: 21, t4: 17, t5: 15 }) &&
      Object.values(manual?.allocation?.per_target || {}).reduce((sum, quota) => sum + quota, 0) === 100 &&
      JSON.stringify(manual?.classes) === JSON.stringify({ soft: ['t1', 't2'], uncertain: ['t3'], hard: ['t4', 't5'] }))
    check('budget: t4 backbone cap relaxes to 3 and t5 reports pool overflow',
      manual?.feasibility?.bb_cap?.per_target?.t4?.cap === 3 &&
      manual?.feasibility?.bb_cap?.per_target?.t4?.reason === 'CAP_RELAXED_INFEASIBLE' &&
      byId.t5?.flags === '["QUOTA_EXCEEDS_POOL"]' && manual?.achievable_total === 97)
    check('budget: q=20 closes contact-cap gate; target rows are sorted by target_id',
      manual?.totals?.q_density === 20 && manual?.feasibility?.contact_cap?.would_enable === false &&
      allocationRows.map((row) => row.target_id).join(',') === 't1,t2,t3,t4,t5')

    const presetExpected = [
      ['global-best-affinity', 15],
      ['multi-target-aggregate', 30],
      ['per-target-coverage-heavy', 45],
    ]
    for (const [preset, expectedFloor] of presetExpected) {
      const result = await budget(`preset-${preset}`, fixtureRows, { total_budget: 100, preset })
      const summary = result.json?.result?.summary
      check(`budget: ${preset} floor pool=${expectedFloor} and quotas still sum to 100`,
        summary?.tiers?.floor_pool === expectedFloor &&
        Object.values(summary?.allocation?.per_target || {}).reduce((sum, quota) => sum + quota, 0) === 100)
    }

    const contactRows = Array.from({ length: 15 }, (_, index) => ({
      target_id: `T${String(index + 1).padStart(2, '0')}`,
      n_eligible: 100, n_backbones: 100, n_contact_clusters: 100,
      pilot_attempts: 0, pilot_passes: 0,
    }))
    const gated = await budget('contact-would', contactRows, { total_budget: 60 })
    const effective = await budget('contact-effective', contactRows, { total_budget: 60, portfolio_v1_validated: true })
    const affinity = await budget('contact-affinity', contactRows, {
      total_budget: 60, preset: 'global-best-affinity', portfolio_v1_validated: true,
    })
    const contactRelaxRows = contactRows.map((row) => ({ ...row, n_contact_clusters: 2 }))
    const contactRelax = await budget('contact-relax', contactRelaxRows, { total_budget: 60 })
    check('budget: contact gate opens at q=4, effective waits for portfolio-v1 validation',
      gated.json?.result?.summary?.totals?.q_density === 4 &&
      gated.json?.result?.summary?.feasibility?.contact_cap?.would_enable === true &&
      gated.json?.result?.summary?.feasibility?.contact_cap?.effective === false &&
      effective.json?.result?.summary?.feasibility?.contact_cap?.effective === true)
    check('budget: affinity preset closes contact gate and infeasible contact clusters recommend cap=2',
      affinity.json?.result?.summary?.feasibility?.contact_cap?.would_enable === false &&
      Object.values(contactRelax.json?.result?.summary?.feasibility?.contact_cap?.feasibility?.per_target || {}).some((item) =>
        item.feasible === false && item.cap_recommended === 2 && item.reason === 'CAP_RELAXED_INFEASIBLE'))

    const allSoftRows = [
      { target_id: 'A', pilot_attempts: 24, pilot_passes: 20 },
      { target_id: 'B', pilot_attempts: 24, pilot_passes: 19 },
      { target_id: 'C', pilot_attempts: 24, pilot_passes: 18 },
    ]
    const softFallback = await budget('reserve-fallback', allSoftRows, {
      total_budget: 30, class_rule: 'absolute', soft_threshold: 0.7, hard_threshold: 0.2,
    })
    check('budget: all-soft reserve falls back to weighted allocation and flags use',
      softFallback.json?.result?.summary?.classes?.hard?.length === 0 &&
      softFallback.json?.result?.summary?.reserve?.fallback_used === true &&
      softFallback.json?.result?.summary?.flags?.includes('RESERVE_FALLBACK_USED'))

    const noPilotRows = ['A', 'B', 'C'].map((target_id) => ({ target_id, pilot_attempts: 0, pilot_passes: 0 }))
    const noPilot = await budget('no-pilot', noPilotRows, { total_budget: 30 })
    const noPilotAllocation = parseCsv(readFileSync(join(noPilot.out, 'budget_allocation.csv'), 'utf8'))
    check('budget: no-pilot targets have r_tilde=0.5, all uncertain, and share reserve evenly',
      noPilot.json?.result?.summary?.classes?.uncertain?.length === 3 &&
      noPilot.json?.result?.summary?.reserve?.eligible?.length === 3 &&
      noPilotAllocation.every((row) => Number(row.r_tilde) === 0.5) &&
      JSON.stringify(Object.fromEntries(noPilotAllocation.map((row) => [row.target_id, Number(row.reserve_q)]))) ===
        JSON.stringify({ A: 2, B: 2, C: 1 }))

    const underRows = [
      { target_id: 'A', pilot_attempts: 2, pilot_passes: 2 },
      { target_id: 'B', pilot_attempts: 2, pilot_passes: 1 },
      { target_id: 'C', pilot_attempts: 2, pilot_passes: 0 },
    ]
    const under = await budget('below-target-count', underRows, { total_budget: 2 })
    check('budget: N<T assigns one each to the top N and flags uncovered targets',
      under.json?.result?.summary?.flags?.includes('BUDGET_BELOW_TARGET_COUNT') &&
      JSON.stringify(under.json?.result?.summary?.allocation?.per_target) === JSON.stringify({ A: 1, B: 1, C: 0 }))

    const absolute = await budget('absolute-classes', [
      { target_id: 'soft', pilot_attempts: 24, pilot_passes: 20 },
      { target_id: 'middle', pilot_attempts: 0, pilot_passes: 0 },
      { target_id: 'hard', pilot_attempts: 24, pilot_passes: 0 },
    ], { total_budget: 30, class_rule: 'absolute', soft_threshold: 0.7, hard_threshold: 0.2 })
    check('budget: absolute thresholds classify against r_tilde',
      JSON.stringify(absolute.json?.result?.summary?.classes) ===
        JSON.stringify({ soft: ['soft'], uncertain: ['middle'], hard: ['hard'] }))

    const minimalTargets = join(temp, 'minimal-with-unrecognized-label.csv')
    writeFileSync(minimalTargets, 'target_id,wet_lab_label\nT1,DO_NOT_READ_OR_USE\n', 'utf8')
    const minimalOut = join(temp, 'minimal-with-unrecognized-label-out')
    const minimal = await runOp('budget', { targets: minimalTargets, config: { total_budget: 1 }, out: minimalOut })
    check('budget: missing optional target fields warn but do not fail; unknown wet-label column is absent from outputs',
      minimal.json?.ok === true &&
      minimal.json?.result?.summary?.warnings?.some((warning) => warning.includes('n_eligible')) &&
      !files.some((file) => readFileSync(join(minimalOut, file), 'utf8').includes('DO_NOT_READ_OR_USE')))

    const customShares = await budget('custom-shares', fixtureRows, {
      total_budget: 100, floor_fraction: 0.20000000001,
      exploit_fraction: 0.65, reserve_fraction: 0.14999999989,
    })
    const effectiveShares = customShares.json?.result?.summary?.config
    check('budget: explicit shares within 1e-9 are accepted and normalized to one',
      customShares.json?.ok === true && Math.abs(
        effectiveShares.floor_fraction + effectiveShares.exploit_fraction + effectiveShares.reserve_fraction - 1,
      ) < 1e-12)

    const deterministicTargets = writeTargets('deterministic-input', fixtureRows)
    const deterministicArgs1 = { targets: deterministicTargets, config: { total_budget: 100 }, out: join(temp, 'seed-17') }
    const deterministicArgs2 = { targets: deterministicTargets, config: { total_budget: 100 }, out: join(temp, 'seed-991') }
    const [deterministic1, deterministic2] = await Promise.all([
      runOpWithHashSeed('budget', deterministicArgs1, 17),
      runOpWithHashSeed('budget', deterministicArgs2, 991),
    ])
    check('budget: four output artifacts are byte-identical across processes and hash seeds',
      deterministic1.json?.ok === true && deterministic2.json?.ok === true && files.every((file) =>
        readFileSync(join(deterministicArgs1.out, file)).equals(readFileSync(join(deterministicArgs2.out, file)))))

    const missingTargetColumn = join(temp, 'bad-target-column.csv')
    writeFileSync(missingTargetColumn, 'other_id\nT1\n', 'utf8')
    const badCases = [
      ['missing target_id column', missingTargetColumn, { total_budget: 5 }],
      ['duplicate target_id', writeTargets('bad-target-duplicate', [{ target_id: 'same' }, { target_id: 'same' }]), { total_budget: 5 }],
      ['missing total_budget', writeTargets('bad-budget-missing', [{ target_id: 'T1' }]), {}],
      ['non-positive total_budget', writeTargets('bad-budget-zero', [{ target_id: 'T1' }]), { total_budget: 0 }],
      ['illegal preset', writeTargets('bad-preset', [{ target_id: 'T1' }]), { total_budget: 1, preset: 'unknown' }],
      ['partial explicit shares', writeTargets('bad-shares', [{ target_id: 'T1' }]), { total_budget: 1, floor_fraction: 0.2 }],
    ]
    for (const [label, targets, config] of badCases) {
      const result = await runOp('budget', { targets, config, out: join(temp, `bad-${label}`) })
      check(`budget: ${label} returns structured ok:false`, result.code === 0 &&
        result.json?.ok === false && result.json?.reason_code === 'INVALID_INPUT' && typeof result.json?.error === 'string')
    }
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
}

if (!HEAVY) {
  skip('mpnn: 真实序列设计', '默认跳过（--heavy 且 mpnn 组件就绪时运行）')
  skip('fold: 真实折叠', '默认跳过（--heavy 且 esmfold 就绪时运行）')
  skip('refold: ESMFold 单体复折叠', '默认跳过模型推理；L2 验证对齐与指标，无假成功路径')
  skip('redesign: 真实区域重设计', '默认跳过（--heavy 且 mpnn 组件就绪时运行）')
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

  const fullFixture = join(REPO, 'test', 'fixtures', 'mini-complex-full.pdb')
  if (!mpnnReady) {
    skip('redesign: 真实区域重设计', '组件未就绪（galatea_setup action=mpnn）')
  } else if (!existsSync(fullFixture)) {
    skip('redesign: 真实区域重设计', 'fixture mini-complex-full.pdb 缺失')
  } else {
    const r = await runOp('redesign', {
      structure_path: fullFixture, binder_chain: 'A', mode: 'interface-refine',
      fixed_positions: ['A1', 'A2'], design_positions: ['A3', 'A4'], n_sequences: 2, seed: 0,
    }, 600000)
    const res = r.json?.result
    check('redesign: 真实 MPNN 接受显式 mask 并回读一致', res?.ok === true && (res?.designs?.length ?? 0) >= 2 &&
      JSON.stringify(res?.fixed_positions) === JSON.stringify(['A1', 'A2']) &&
      JSON.stringify(res?.design_positions) === JSON.stringify(['A3', 'A4']))
    const rseqs = res?.designs?.map((d) => d.sequence) || []
    check('redesign: 真实序列合法', rseqs.length > 0 && rseqs.every((s) => /^[ACDEFGHIKLMNPQRSTVWY]+(:[ACDEFGHIKLMNPQRSTVWY]+)?$/.test(s)))
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
