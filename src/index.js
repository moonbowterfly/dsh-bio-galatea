// dsh-bio-galatea — Cordis 插件主模块
// 注入 tools（14 语义化工具：status/setup/mpnn/fold/interface/score/inspect/cluster/rank/rank_aggregate/loop/contact_consensus/redesign/refold）
// + skills（galatea-expert）。蛋白质结构预测与设计域（G 系列第四员）。
import { registerTools } from './tools.js'
import { registerSkills } from './skills.js'
import { registerIntegrationRoutes, createIntegrationService } from './integration.js'

/** Cordis 插件名（cordis.patch.yml row id 同名）。 */
export const name = 'dsh-bio-galatea'

/**
 * 静态注入只列**必选**服务（数组形式是 cordis 唯一支持的「服务名列表」写法；
 * `{ required, optional }` 的对象形式会被 cordis 当成「服务名 → 配置」字典，
 * 导致插件永远 pending —— dsh-bio-gem 实测：dsh boot 报
 * `@dsh-bio/dsh-bio-galatea: pending (waiting for services: required, optional)`）。
 *
 * `webServer` 是**可选**服务（非 web 部署不提供），改用 apply 内的动态注入
 * `ctx.inject(['webServer'], cb)`（官方 dsh 插件同款模式）：服务可用时注册
 * 只读 integration 路由，不可用时全部工具与 skill 照常注册。
 */
export const inject = ['tools', 'skills']

/**
 * 装配插件。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function apply(ctx) {
  registerTools(ctx)
  registerSkills(ctx)

  const service = createIntegrationService()
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => registerIntegrationRoutes(webCtx, { service }), 'dsh-bio-galatea: integration API routes')
    // 延迟预热（**不在插件加载期**执行，不阻塞启动）：启动 ~8s 后后台跑一次只读探测，
    // 让面板首次打开即命中缓存，避免首次冷探测被消费端超时截断。
    const warmup = setTimeout(() => { void service.status().catch(() => {}) }, 8_000)
    webCtx.effect(() => () => clearTimeout(warmup), 'dsh-bio-galatea: runtime probe warm-up')
  })
}
