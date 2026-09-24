// skills.js — dsh-bio-galatea skill 注册（galatea-expert 主 skill）
// 工具选择决策树 + 工作流 + 边界纪律；遵循 dsh-bio-genie 注册模式（ctx.skills.register）。
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const SKILLS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'skills')

export function registerSkills(ctx) {
  const disposers = []
  let content = ''
  try {
    content = readFileSync(join(SKILLS_DIR, 'galatea-expert.md'), 'utf8')
  } catch {
    content = `Skill body missing from plugin package (skills/galatea-expert.md)。`
  }
  disposers.push(ctx.skills.register({
    name: 'galatea-expert',
    description:
      '蛋白质结构预测与设计主指引：工具分层选择（galatea_status/setup/mpnn/fold/interface/score/inspect/cluster）、' +
      '「序列设计 → 结构预测 → 界面筛选 → 多样性聚类」工作流、CPU/GPU 设备边界与本机资源纪律。' +
      '任何蛋白质设计 / 折叠 / 筛选 / inverse folding 需求先加载本 skill。',
    whenToUse:
      '用户提出蛋白质序列设计 / inverse folding / ProteinMPNN / LigandMPNN / 结构预测 / ESMFold / 蛋白质折叠 / ' +
      '结合界面分析 / ipSAE / 设计候选筛选 / 候选聚类 / 蛋白质构建等需求时。',
    source: 'custom',
    provider: 'dsh-bio-galatea',
    content,
  }))
  return () => disposers.forEach((d) => d())
}
