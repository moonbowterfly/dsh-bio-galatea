import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { TOOLS_MANIFEST, buildCapabilitiesReport } from '../src/capabilities.js'
import { createIntegrationService } from '../src/integration.js'

const fixture = JSON.parse(readFileSync(new URL('./fixtures/capabilities-dependency-cases.json', import.meta.url), 'utf8'))
const pluginVersion = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version

test('capabilities required IDs match the checks emitted by integration status', async () => {
  const service = createIntegrationService({
    dataRoot: fileURLToPath(new URL('./fixtures/', import.meta.url)),
    probePython: async () => ({ selected: null, candidates: [] }),
    probeAnalysis: async () => null,
    probeDeviceFn: async () => null,
  })
  const response = await service.status()
  assert.equal(response.ok, true)
  const collectedIds = response.value.checks.map((check) => check.id)
  const requiredIds = [...new Set(TOOLS_MANIFEST.flatMap((tool) => tool.requires ?? []))]
  assert.equal(collectedIds.length, new Set(collectedIds).size, 'duplicate status check IDs')
  assert.deepEqual([...collectedIds].sort(), requiredIds.sort(), 'requires must match actual collected checks')

  const dependent = TOOLS_MANIFEST.filter((tool) => tool.requires?.includes(fixture.dependency_id))
  assert.ok(dependent.length > 0, 'fixture dependency must be used by a tool')
  for (const scenario of fixture.cases) {
    await test(scenario.name, () => {
      const checks = collectedIds
        .filter((id) => scenario.override !== null || id !== fixture.dependency_id)
        .map((id) => ({ id, status: id === fixture.dependency_id ? scenario.override : 'ok' }))
      const report = buildCapabilitiesReport({ pluginVersion, checks })
      assert.equal(report.plugin_version, pluginVersion)
      for (const tool of report.tools) {
        const manifest = TOOLS_MANIFEST.find((entry) => entry.name === tool.name)
        const usesDependency = manifest.requires?.includes(fixture.dependency_id)
        assert.equal(tool.status, usesDependency ? scenario.expected_status : manifest.status, tool.name)
        if (scenario.expected_status === 'unavailable' && usesDependency) {
          assert.deepEqual(tool.missing_dependencies, [fixture.dependency_id], tool.name)
          assert.equal(tool.unknown_dependencies, undefined, tool.name)
        }
        if (scenario.expected_status === 'unknown' && usesDependency) {
          assert.deepEqual(tool.unknown_dependencies, [fixture.dependency_id], tool.name)
          assert.equal(tool.missing_dependencies, undefined, tool.name)
        }
        if (!usesDependency || scenario.expected_status === 'ready') {
          assert.equal(tool.missing_dependencies, undefined, tool.name)
          assert.equal(tool.unknown_dependencies, undefined, tool.name)
        }
      }
    })
  }
})
