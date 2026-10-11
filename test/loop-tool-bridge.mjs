import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { callGalatea } from '../src/python.js'

function resolvePython() {
  const candidates = [...new Set([process.env.GALATEA_PYTHON, process.env.PYTHON, 'python', 'py'].filter(Boolean))]
  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ['-I', '-c', 'import sys; print(sys.version_info[0])'], {
      encoding: 'utf8', windowsHide: true, timeout: 10_000,
    })
    if (probe.status === 0 && probe.stdout.trim() === '3') return candidate
  }
  throw new Error(`no usable Python 3 interpreter among ${candidates.join(', ')}`)
}

const metadata = {
  p1: {
    model_family: 'proxy', model_version: '1', score_metric: 'proxy',
    score_version: '1', direction: 'higher', unit: 'score',
  },
}

function round() {
  return {
    round_id: 0,
    predictor_metadata: metadata,
    candidates: [{
      candidate_id: 'bridge-candidate-0',
      sequence: 'ACDEFGHIKLMNPQRSTVWYACDEFGHIKLMNPQRSTVWY',
      qc_status: 'PASS',
      scores: { p1: 0.5 },
    }],
  }
}

test('galatea_loop delivers log, status and next payloads through the TS Python consumer', async () => {
  const campaign = mkdtempSync(join(tmpdir(), 'galatea-loop-tool-bridge-'))
  const resolver = { pythonExe: resolvePython, invalidate() {} }
  try {
    const logged = await callGalatea('loop', { action: 'log', campaign_dir: campaign, round: round() }, { resolver })
    assert.ok(logged && typeof logged === 'object', 'TS consumer must receive an object from the result envelope')
    assert.equal(logged.ok, undefined, 'transport ok must not leak into the tool payload')
    assert.equal(logged.round_id, 0)
    assert.equal(logged._provenance.tool, 'galatea_loop')
    assert.equal(existsSync(join(campaign, 'rounds', 'round_0.json')), true)

    const status = await callGalatea('loop', { action: 'status', campaign_dir: campaign }, { resolver })
    assert.equal(status.ok, undefined, 'status must be parsed from the result envelope')
    assert.equal(status.status.policy_version, 'galatea.loop.v3')
    assert.ok(Array.isArray(status.status.promoted_rate_per_round))

    const next = await callGalatea('loop', { action: 'next', campaign_dir: campaign }, { resolver })
    assert.equal(next.ok, undefined, 'next must be parsed from the result envelope')
    assert.equal(next.round_plan.policy_version, 'galatea.loop.v3')
    assert.equal(existsSync(next.plan_path), true)
    const plan = JSON.parse(readFileSync(next.plan_path, 'utf8'))
    assert.equal(plan.round_plan.policy_version, 'galatea.loop.v3')

    await assert.rejects(
      callGalatea('loop', { action: 'invalid', campaign_dir: campaign }, { resolver }),
      /invalid action/i,
    )
  } finally {
    rmSync(campaign, { recursive: true, force: true })
  }
})
