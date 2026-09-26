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
