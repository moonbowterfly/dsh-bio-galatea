// dsh-bio-galatea — capabilities 单源（single source of truth for tool manifest & capability metadata）
//
// 目的（继承 dsh-bio-gem 的架构决策，2026-09-21）：
//   1. 工具清单/能力分级/成本与副作用元数据集中一处，供 integration API（/v1/capabilities）
//      与 genie 宿主侧动态消费——消灭「工具数变化需同步 ≥12 处」的手工漂移。
//   2. 校验脚本 test/check-capabilities.mjs 强制本 MANIFEST 与 tools.js 真实注册集合一致。
//
// 同步纪律：新增/删除工具时同步本文件（对应 category / capability / cost_class / network /
// mutability / summary），否则 check-capabilities 会报红。
//
// cost_class:  light  (<10s)  | medium (10s–2min) | heavy (>2min)
// network:     none | optional | required
// mutability:  read_only | writes_output | model_mutating
// status:      ready | experimental | data-not-initialized  （依赖级状态由 integration 动态覆盖）
// requires:    动态依赖 id 列表（对齐 integration status 的 check id；缺省即 ready）

export const TOOLS_MANIFEST = [
  // ---- system ----
  { name: 'galatea_status', capability: 'galatea.system.status', category: 'system',
    cost_class: 'light', network: 'none', mutability: 'read_only', status: 'ready',
    summary: '运行时状态：解释器/torch/组件（MPNN 代码与权重 / ESMFold 权重）/设备（GPU/CPU）一览 + 缺失项修复指引' },
  { name: 'galatea_setup', capability: 'galatea.system.setup', category: 'system',
    cost_class: 'heavy', network: 'required', mutability: 'writes_output', status: 'ready',
    summary: '零手动自举（action: env | mpnn | esmfold | all）：私有 venv + torch 依赖 + 模型权重下载，幂等可重入' },

  // ---- design（构建） ----
  { name: 'galatea_mpnn', capability: 'galatea.design.sequence', category: 'design',
    cost_class: 'medium', network: 'none', mutability: 'writes_output', status: 'ready',
    requires: ['python.torch', 'runtime.mpnn'],
    summary: '序列设计（inverse folding）：ProteinMPNN / SolubleMPNN / LigandMPNN——给定结构设计序列候选（batch + 温度 + 固定残基）' },

  // ---- predict（预测） ----
  { name: 'galatea_fold', capability: 'galatea.predict.fold', category: 'predict',
    cost_class: 'heavy', network: 'none', mutability: 'writes_output', status: 'ready',
    requires: ['python.torch', 'runtime.esmfold'],
    summary: '单链结构预测（ESMFold，CPU/GPU 自适应）：序列 → PDB + pLDDT/pTM（短序列设计验证）' },

  // ---- screening（筛选） ----
  { name: 'galatea_interface', capability: 'galatea.screen.interface', category: 'screening',
    cost_class: 'light', network: 'none', mutability: 'read_only', status: 'ready',
    requires: ['runtime.analysis'],
    summary: '复合物界面分析：链间接触/氢键/盐桥/SASA/界面残基 + pLDDT 分带统计（复合物结构 → 筛选指标）' },
  { name: 'galatea_score', capability: 'galatea.screen.sequence-scoring', category: 'screening',
    cost_class: 'light', network: 'none', mutability: 'read_only', status: 'ready',
    requires: ['runtime.analysis'],
    summary: '序列理化打分（批量）：pI / 净电荷 / GRAVY / 疏水矩 / 聚集倾向 / 半胱氨酸计数' },

  // ---- analysis（分析） ----
  { name: 'galatea_inspect', capability: 'galatea.analyze.structure-qc', category: 'analysis',
    cost_class: 'light', network: 'none', mutability: 'read_only', status: 'ready',
    requires: ['runtime.analysis'],
    summary: '结构检查（QC）：链/长度/几何异常（原子 clash）/pLDDT 分布，输出可读结论' },
  { name: 'galatea_cluster', capability: 'galatea.analyze.cluster', category: 'analysis',
    cost_class: 'medium', network: 'none', mutability: 'read_only', status: 'ready',
    requires: ['runtime.analysis'],
    summary: '候选聚类（序列同一性矩阵 + 贪心代表集）：设计多样性选择，输出代表序列' },
  { name: 'galatea_rank', capability: 'galatea.screen.rank', category: 'screening',
    cost_class: 'light', network: 'none', mutability: 'read_only', status: 'ready',
    summary: '候选共识排序（确定性等权共识 + 分档 + 统计）：多预测器分数 → 共识分/档位/排名（1,440 条湿实验口径：top10-20% 命中富集约 2.3x）' },
  { name: 'galatea_rank_aggregate', capability: 'galatea.screen.rank-aggregate', category: 'screening',
    cost_class: 'light', network: 'none', mutability: 'writes_output', status: 'ready',
    summary: '多批次排序结果聚合：合并为统一全局排名 CSV（跨批同一确定性排序规则 + 重复 id 检查）' },
  { name: 'galatea_loop', capability: 'galatea.design.iterate', category: 'design',
    cost_class: 'light', network: 'none', mutability: 'writes_output', status: 'ready',
    summary: '多轮设计战役控制：登记轮次、评估父本与谱系、输出确定性 predict-and-redesign 计划（不执行生成）' },

  { name: 'galatea_redesign', capability: 'galatea.design.redesign', category: 'design',
    cost_class: 'heavy', network: 'none', mutability: 'writes_output', status: 'ready',
    requires: ['python.torch', 'runtime.mpnn'],
    summary: '区域约束式 binder 重设计：按 interface、anchor、shell、core、surface 计算固定与可设计残基，再用 MPNN 生成候选' },
  { name: 'galatea_refold', capability: 'galatea.qc.refold', category: 'qc',
    cost_class: 'heavy', network: 'none', mutability: 'writes_output', status: 'ready',
    requires: ['python.torch', 'runtime.esmfold'],
    summary: 'binder 单体复折叠救援检查：ESMFold 折叠后与参考构象做序列对齐 Cα RMSD、pLDDT 与二级结构一致性评估' },
]

export const CONTRACT_VERSION = '1'

/** 组装 capabilities 报告（静态 manifest + 动态依赖状态覆盖）。 */
export function buildCapabilitiesReport({ pluginVersion, checks = [] } = {}) {
  const checkStatus = new Map(checks.map((c) => [c.id, c.status]))
  const tools = TOOLS_MANIFEST.map((t) => {
    const missingDeps = (t.requires ?? []).filter((id) => {
      const st = checkStatus.get(id)
      return st !== undefined && st !== 'ok'
    })
    const effectiveStatus = missingDeps.length > 0 ? 'unavailable' : (t.status ?? 'ready')
    return {
      name: t.name,
      capability: t.capability,
      category: t.category,
      cost_class: t.cost_class,
      network: t.network,
      mutability: t.mutability,
      status: effectiveStatus,
      summary: t.summary,
      ...(t.requires ? { requires: t.requires } : {}),
      ...(missingDeps.length > 0 ? { missing_dependencies: missingDeps } : {}),
    }
  })
  return {
    contract_version: CONTRACT_VERSION,
    plugin_id: 'dsh-bio-galatea',
    plugin_version: pluginVersion,
    tool_count: tools.length,
    tools,
  }
}
