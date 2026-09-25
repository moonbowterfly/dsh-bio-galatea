// dsh-bio-galatea — 工具层（defineTool 注册，10 语义化工具，v0.1）
// 全部执行走 python/galatea_ops.py（JSON stdin 协议）。
// op 与工具对照（1:1）：status/setup/mpnn/fold/interface/score/inspect/cluster（同名）；rank.consensus→galatea_rank；rank.aggregate→galatea_rank_aggregate。
import { defineTool } from '@deepseek-ai/dsh-tools'
import { isAbsolute } from 'node:path'
import { callGalatea } from './python.js'

/** 校验输入存在（绝对路径或用户给定路径）。 */
function requirePath(v, label) {
  if (!v) throw new Error(`${label} required`)
  if (!isAbsolute(v)) throw new Error(`${label} 必须是绝对路径: ${v}`)
  return v
}

/** galatea_ops 通用工具工厂（同步 op）。timeoutMs 可为 number 或 (args) => number。 */
function galateaTool(opts) {
  return defineTool({
    name: opts.name,
    description: opts.description,
    parameters: opts.parameters,
    timeoutMs: typeof opts.timeoutMs === 'function' ? 900_000 : (opts.timeoutMs ?? 300_000),
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args) {
      const timeoutMs = typeof opts.timeoutMs === 'function' ? opts.timeoutMs(args) : (opts.timeoutMs ?? 300_000)
      return callGalatea(opts.op, args, { timeoutMs })
    },
  })
}

export function registerTools(ctx) {
  const disposers = []

  // ---------------------------------------------------------------------
  // galatea_status — 运行时状态（解释器/torch/组件/设备）
  // ---------------------------------------------------------------------
  disposers.push(ctx.tools.register(galateaTool({
    name: 'galatea_status',
    description:
      '蛋白质工具运行时状态一览：Python 解释器选择（含来源）、torch 版本与 GPU 可用性、组件可用性（LigandMPNN 代码与权重 / ESMFold 权重 / biopython 分析依赖）、数据目录。' +
      '用于回答「本机现在能跑什么」「为什么 galatea_mpnn/fold 不可用」并给出修复指引（galatea_setup 对应 action）。' +
      '触发词：蛋白质工具状态、ESMFold 装好了吗、MPNN 可用吗、GPU 能用吗、galatea 状态。',
    parameters: {},
    op: 'status',
    timeoutMs: 120_000,
  })))

  // ---------------------------------------------------------------------
  // galatea_setup — 零手动自举（env / mpnn / esmfold）
  // ---------------------------------------------------------------------
  disposers.push(ctx.tools.register(galateaTool({
    name: 'galatea_setup',
    description:
      '蛋白质工具链零手动自举（幂等：已就绪步骤自动跳过，可安全重复调用）：' +
      'action=env：创建插件私有 venv（~/.dsh/dsh-bio-galatea/venv）并安装 torch(CPU)+transformers+biopython+prody（数分钟）；' +
      'action=mpnn：获取 LigandMPNN 代码（MIT）+ 核心权重（proteinmpnn/solublempnn/ligandmpnn，几十 MB）；' +
      'action=esmfold：下载 ESMFold 权重（约 2.5GB，5-30 分钟——**耐心等待，勿重复调用**）；' +
      'action=all：以上全部。首次使用前运行一次即可。触发词：安装蛋白质工具、设置蛋白质环境、下载模型权重、初始化 galatea。',
    parameters: {
      action: {
        type: 'string',
        enum: ['env', 'mpnn', 'esmfold', 'all'],
        description: '自举目标：env=私有 venv+依赖 / mpnn=MPNN 代码与权重 / esmfold=ESMFold 权重 / all=全部',
      },
      force: { type: 'boolean', description: '强制重装（缺省 false，幂等跳过已就绪步骤）' },
    },
    op: 'setup',
    timeoutMs: (args) => (args?.action === 'env' ? 1_200_000 : 3_600_000),
  })))

  // ---------------------------------------------------------------------
  // galatea_mpnn — 序列设计（inverse folding）
  // ---------------------------------------------------------------------
  disposers.push(ctx.tools.register(galateaTool({
    name: 'galatea_mpnn',
    description:
      '序列设计（inverse folding）：给定蛋白质结构（binder backbone / 复合物 / 天然结构），用 ProteinMPNN / SolubleMPNN / LigandMPNN 设计候选序列。' +
      '输入 pdb（绝对路径）+ 要设计的链（chains，如 "A"）；输出候选序列（带 score，越高越好，已按序排列）+ FASTA 落盘。' +
      'model 选择：protein_mpnn（默认，蛋白-蛋白界面）、soluble_mpnn（优先溶解度）、ligand_mpnn（含配体/核酸/金属界面）。' +
      '温度：0.1 保守（高同一性）；0.3 多样（探索）。批量建议：CPU 时 batch_size=1（缺省）；num_seqs 典型 8-96。' +
      '触发词：设计序列、反折叠、inverse folding、给这个结构设计序列、ProteinMPNN、序列优化。',
    parameters: {
      pdb: { type: 'string', required: true, description: '输入结构文件绝对路径（PDB）' },
      chains: { type: 'string', description: '要设计的链（如 "A" 或 "A,B"）；缺省=全部链' },
      fixed_residues: {
        type: 'array', items: { type: 'string' },
        description: '可选：固定不设计的残基（如 ["A45","A46"]，链+残基号）',
      },
      num_seqs: { type: 'number', description: '设计候选数（缺省 16）' },
      batch_size: { type: 'number', description: '每批条数（缺省 1，CPU 友好；GPU 可调大如 8-16）' },
      temperature: { type: 'number', description: '采样温度（缺省 0.1；0.3=多样）' },
      model: {
        type: 'string',
        enum: ['protein_mpnn', 'soluble_mpnn', 'ligand_mpnn'],
        description: '模型选择：protein_mpnn（默认）/ soluble_mpnn / ligand_mpnn',
      },
      seed: { type: 'number', description: '随机种子（缺省 0，复现性）' },
      out_dir: { type: 'string', description: '输出目录（缺省 ~/.dsh/dsh-bio-galatea/out/mpnn_<时间戳>）' },
    },
    op: 'mpnn',
    timeoutMs: 600_000,
  })))

  // ---------------------------------------------------------------------
  // galatea_fold — 单链结构预测（ESMFold）
  // ---------------------------------------------------------------------
  disposers.push(ctx.tools.register(galateaTool({
    name: 'galatea_fold',
    description:
      '单链结构预测（ESMFold）：输入蛋白质序列（1-8 条），输出预测结构 PDB + mean pLDDT + pTM。' +
      '用于设计候选的快速折叠验证（序列能否折叠成稳定结构）。' +
      '设备：device=auto 优先 GPU（若可用），否则 CPU（较慢——CPU 约分钟级/条，据此规划批量）。' +
      '注意：ESMFold 是单链预测；复合物/结合界面评估请用外部服务（AlphaFold Server / PXDesign / ColabFold）产出的复合物结构，再用 galatea_interface 分析。' +
      '触发词：预测结构、折叠、ESMFold、看看这条序列的结构、结构验证、fold。',
    parameters: {
      sequences: {
        type: 'array', items: { type: 'string' },
        description: '蛋白质序列列表（单字母氨基酸），1-8 条',
      },
      fasta: { type: 'string', description: '或：FASTA 文件绝对路径（与 sequences 二选一）' },
      device: {
        type: 'string', enum: ['auto', 'cpu', 'cuda'],
        description: '计算设备：auto（缺省，有 GPU 用 GPU）/ cpu / cuda',
      },
      out_dir: { type: 'string', description: '输出目录（缺省 ~/.dsh/dsh-bio-galatea/out/fold_<时间戳>）' },
    },
    op: 'fold',
    timeoutMs: 1_800_000,
  })))

  // ---------------------------------------------------------------------
  // galatea_interface — 复合物界面分析
  // ---------------------------------------------------------------------
  disposers.push(ctx.tools.register(galateaTool({
    name: 'galatea_interface',
    description:
      '复合物界面分析（筛选核心）：输入复合物结构（如 AF2/AF3/PXDesign 输出），计算链间界面指标——' +
      '界面残基对、接触数（<5Å）、氢键、盐桥、埋藏 SASA（Shrake-Rupley）、界面/全局 pLDDT（B-factor 标度自动判定），输出可对比的筛选指标。' +
      '链组用 partner_a/partner_b 指定（如 "A" 与 "B"；或 "A,B" 与 "C"）。缺省按前两条链拆分。' +
      '触发词：界面分析、结合面、接触分析、氢键、盐桥、SASA、界面残基、结合质量、binder 筛选。',
    parameters: {
      complex_pdb: { type: 'string', required: true, description: '复合物结构文件绝对路径' },
      partner_a: { type: 'string', description: '链组 A（如 "A"；多个逗号分隔）；缺省=第一条链' },
      partner_b: { type: 'string', description: '链组 B（如 "B"）；缺省=第二条链' },
      contact_cutoff: { type: 'number', description: '接触距离阈值 Å（缺省 5.0）' },
    },
    op: 'interface',
    timeoutMs: 240_000,
  })))

  // ---------------------------------------------------------------------
  // galatea_score — 序列理化打分
  // ---------------------------------------------------------------------
  disposers.push(ctx.tools.register(galateaTool({
    name: 'galatea_score',
    description:
      '序列理化性质批量打分：长度、pI、净电荷（pH 7.4）、GRAVY 疏水性、疏水矩（Eisenberg 标度，界面/两亲性倾向）、聚集倾向（启发式代理，有阈值判读）、半胱氨酸计数、分子量。' +
      '用于设计候选的快速质量过滤（剔除高聚集倾向/异常电荷的候选）。也接受 FASTA 文件路径。' +
      '触发词：序列打分、理化性质、pI、净电荷、疏水性、聚集倾向、候选过滤。',
    parameters: {
      sequences: { type: 'array', items: { type: 'string' }, description: '蛋白质序列列表（与 fasta 二选一）' },
      fasta: { type: 'string', description: '或：FASTA 文件绝对路径' },
    },
    op: 'score',
    timeoutMs: 90_000,
  })))

  // ---------------------------------------------------------------------
  // galatea_inspect — 结构 QC
  // ---------------------------------------------------------------------
  disposers.push(ctx.tools.register(galateaTool({
    name: 'galatea_inspect',
    description:
      '结构 QC 检查：链/长度/原子数、几何异常（原子 clash 计数，<1.5Å）、pLDDT 分布（分位 + 低置信比例），输出可读 QC 结论。' +
      '输入任意 PDB（预测或实验结构）。用于提交前检查设计结构质量。' +
      '触发词：结构检查、QC、结构质量、clash、几何异常、pLDDT 分布。',
    parameters: {
      pdb: { type: 'string', required: true, description: '结构文件绝对路径' },
    },
    op: 'inspect',
    timeoutMs: 180_000,
  })))

  // ---------------------------------------------------------------------
  // galatea_cluster — 候选聚类（多样性选择）
  // ---------------------------------------------------------------------
  disposers.push(ctx.tools.register(galateaTool({
    name: 'galatea_cluster',
    description:
      '候选聚类（序列同一性矩阵 + 贪心代表集）：输入大量设计序列（序列列表或 FASTA），输出聚类分组与代表序列。' +
      '用于从大规模设计中选「多样性代表」提交（避免提交一堆近似重复）。threshold 为同一性阈值（缺省 0.8，即 ≥80% 视为同簇）；输入顺序即优先级（建议按 score 降序，高分序列优先当代表）。' +
      '触发词：聚类、多样性、去冗余、代表序列、选几条不一样的设计。',
    parameters: {
      sequences: { type: 'array', items: { type: 'string' }, description: '序列列表（与 fasta 二选一）' },
      fasta: { type: 'string', description: '或：FASTA 文件绝对路径' },
      threshold: { type: 'number', description: '同一性阈值（缺省 0.8）' },
    },
    op: 'cluster',
    timeoutMs: 300_000,
  })))

  // ---------------------------------------------------------------------
  // galatea_rank — 候选共识排序（多预测器等权共识；确定性，无学习融合）
  // ---------------------------------------------------------------------
  disposers.push(ctx.tools.register(galateaTool({
    name: 'galatea_rank',
    description:
      '候选共识排序（确定性等权共识，无学习融合）：输入候选表（结构化 JSON 或 CSV 文件），每个候选带一组预测器分数（列名如 ipsae_min_* 或 {predictor: score} 字典），' +
      '输出共识均值（即各分数算术平均）+ 分档（strong≥0.73 / medium≥0.65 / weak≥0.2 / reject<0.2）+ 全局排名 + 覆盖率统计。' +
      '实测口径（1,440 条真实湿实验回测）：共识分 top10-20% 的命中富集约 2.3x——用于从大量候选里挑高分个体。多批次结果合并请用 galatea_rank_aggregate。' +
      '触发词：排序候选、共识打分、挑高分、排个序、top 候选、candidate ranking。',
    parameters: {
      candidates: { type: 'string', description: '候选数据 JSON 文本（与 csv_path 二选一）。数组：[{"candidate_id":"c1","ipsae_min_p1":0.9,"ipsae_min_p2":0.8}, ...]；或紧凑对象 {"c1":{"p1":0.9},"c2":{"p1":0.5}}；也接受 {"scores":{...}} 嵌套或 {"ranking":[...]} 前序结果' },
      csv_path: { type: 'string', description: '或：候选表 CSV 绝对路径（表头含 id 列 + 预测器分数列）' },
      score_prefix: { type: 'string', description: '分数列前缀（缺省 ipsae_min_，作用于 CSV 列与扁平 JSON 字段）' },
    },
    op: 'rank.consensus',
    timeoutMs: 120_000,
  })))

  // ---------------------------------------------------------------------
  // galatea_rank_aggregate — 多批次排序结果聚合（全局统一重排 + CSV）
  // ---------------------------------------------------------------------
  disposers.push(ctx.tools.register(galateaTool({
    name: 'galatea_rank_aggregate',
    description:
      '多批次共识排序结果聚合：把若干批次（galatea_rank 前序结果 / 候选数组 / CSV 路径 / 文件路径混合）合并为统一全局排名并写出 CSV。' +
      '跨批次使用同一确定性排序规则（不平均批内排名）；输出重复 candidate_id 检查。批内 rank 不沿用——每个候选在全表中只排一次。' +
      '触发词：合并批次、聚合排序、多批汇总、统一排名。',
    parameters: {
      batches: { type: 'string', description: '批次 JSON 文本（数组）：元素可为 CSV 路径字符串 / 候选数组 / {"batch_id":"b1","candidates":[...] 或 "csv_path":"..." 或 "ranking":[...]}' },
      output_csv: { type: 'string', description: '合并结果 CSV 输出绝对路径（必填）' },
      overwrite: { type: 'boolean', description: '覆盖已存在的 output_csv（缺省 false）' },
    },
    op: 'rank.aggregate',
    timeoutMs: 300_000,
  })))

  return () => disposers.forEach((d) => d())
}
