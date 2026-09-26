// dsh-bio-galatea — 工具层（defineTool 注册，14 语义化工具，v0.1）
// 全部执行走 python/galatea_ops.py（JSON stdin 协议）。
// op 与工具对照（1:1）：status/setup/mpnn/fold/interface/score/inspect/cluster/loop/redesign/refold（同名）；rank.consensus→galatea_rank；rank.aggregate→galatea_rank_aggregate。
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

  // ---------------------------------------------------------------------
  // galatea_loop — 设计战役迭代控制（log / next / status；不执行生成）
  // ---------------------------------------------------------------------
  disposers.push(ctx.tools.register(galateaTool({
    name: 'galatea_loop',
    description:
      '蛋白质设计战役迭代控制与轮次台账：log 登记候选结果，next 按历史共识、QC、谱系和序列簇确定性地产出下一轮计划，status 汇总进展与停止建议。' +
      '它只记账和规划，不执行 MPNN、云端生成或预测。next 计划包括 exploitation/uncertainty/diversity 父本池、本地操作配额与云端预测占位。' +
      '触发词：迭代控制、下一轮怎么设计、轮次台账、设计循环、iteration、predict-and-redesign。',
    parameters: {
      action: {
        type: 'string', required: true, enum: ['log', 'next', 'status'],
        description: 'log=登记一轮 / next=生成下一轮确定性计划 / status=查看战役摘要',
      },
      campaign_dir: { type: 'string', required: true, description: '战役目录绝对路径；campaign.json 与 rounds/、plans/ 写入此目录' },
      round: {
        type: 'object', description: 'action=log 必填的轮次数据', additionalProperties: true,
        properties: {
          round_id: { type: 'integer', required: true, minimum: 0, description: '非负轮次编号' },
          candidates: {
            type: 'array', required: true, description: '候选结果列表',
            items: {
              type: 'object', additionalProperties: true,
              properties: {
                candidate_id: { type: 'string', required: true },
                scores: { type: 'object', additionalProperties: true, description: '预测器到分数的映射；也接受 ipsae_min_* 扁平分数字段' },
                parent_id: { type: 'string' }, sequence: { type: 'string' },
                structure_path: { type: 'string' },
                qc_status: { type: 'string', enum: ['PASS', 'WARN', 'FAIL'] },
                flags: { type: 'object', additionalProperties: true },
              },
            },
          },
          notes: { description: '本轮说明（可选 JSON 值）' },
        },
      },
      overwrite: { type: 'boolean', description: 'log 重复 round_id 时显式覆盖；缺省 false' },
      params: {
        type: 'object', additionalProperties: true, description: 'action=next 的可选策略参数',
        properties: {
          cloud_budget_round: { type: 'integer', description: '每轮云端预测预算（默认 96）' },
          max_parents: { type: 'integer', description: '父本上限（默认 16）' },
          min_parents: { type: 'integer', description: '父本下限（默认 8）' },
          per_parent_local: { type: 'integer', description: '每父本本地序列预算（默认 32）' },
          cloud_per_parent: { type: 'integer', description: '每父本云端预测数（默认 6）' },
          min_consensus_pctl: { type: 'number', description: '最低共识百分位（默认 0.50）' },
          promotion_delta: { type: 'number', description: '推广所需百分位提升（默认 0.05）' },
          max_rounds: { type: 'integer', description: '停止建议的最大轮数（默认 6）' },
          improvement_epsilon: { type: 'number', description: '最佳百分位停滞阈值（默认 0.02）' },
          diversity_threshold: { type: 'number', description: '序列簇同一性阈值（默认 0.8）' },
        },
      },
    },
    op: 'loop',
    timeoutMs: 120_000,
  })))

  // galatea_contact_consensus: 多模型接触一致性（设计控制信号，不做排序）
  disposers.push(ctx.tools.register(galateaTool({
    name: 'galatea_contact_consensus',
    description:
      '对一组预测复合物 PDB/CIF 计算跨链重原子接触一致性：输出 binder/target 残基频率、稀疏残基对频率、残基集与接触边 Jaccard、anchor 列表及完整矩阵 artifact。' +
      '只供设计控制、anchor 选择与界面稳定性检查，不参与 candidate ranking。链缺省时逐模型按蛋白链长度识别角色，并以首个有效模型为 residue-label 基准，返回 chain_label_mappings；覆盖不足会明确标记 INSUFFICIENT。' +
      '触发词：接触一致性、contact consensus、多模型界面稳定性、anchor residues。',
    parameters: {
      models: { type: 'array', items: { type: 'string' }, description: 'PDB/CIF 文件绝对路径列表（与 models_dir 二选一）' },
      models_dir: { type: 'string', description: '或：包含模型文件的目录；缺省 glob 匹配 PDB/CIF' },
      glob: { type: 'string', description: 'models_dir 内的文件模式，如 predicted_*_1to2.cif；缺省匹配 PDB/CIF' },
      binder_chain: { type: 'string', description: 'binder 链 ID；缺省时按蛋白链长度唯一最短者自动推断' },
      target_chain: { type: 'string', description: 'target 链 ID，多个用逗号分隔；缺省为 binder 外的所有蛋白链' },
      cutoff: { type: 'number', exclusiveMinimum: 0, description: '跨链重原子接触距离 Å，缺省 4.0' },
      candidate_id: { type: 'string', description: '候选 ID；缺省从模型目录名推断' },
      artifact_path: { type: 'string', description: '完整 residue/edge Jaccard 矩阵 JSON 输出路径；缺省写入模型目录' },
      additionalProperties: true,
    },
    op: 'contact_consensus',
    timeoutMs: 300_000,
  })))

  // galatea_redesign: 区域约束式 binder 重设计
  disposers.push(ctx.tools.register(galateaTool({
    name: 'galatea_redesign',
    description:
      '按结构区域约束重设计 binder 序列：识别 interface、anchor、shell、core、surface，按 preset 和显式残基覆盖生成 fixed/redesigned mask，再通过 LigandMPNN 采样。' +
      '支持 interface-refine、anchor-preserving、scaffold-rescue、full-explore；缺 contact frequencies 时 anchor-preserving 会降级并标注。' +
      '触发词：区域约束重设计、redesign、固定界面、界面保留重设计、表面重设计、anchor 保留、冻结残基。',
    parameters: {
      structure_path: { type: 'string', required: true, description: '复合物 PDB/CIF 结构文件绝对路径' },
      binder_chain: { type: 'string', required: true, description: '待重设计的 binder 链 ID' },
      target_chain: { type: 'string', description: '可选 target 链 ID，多个链用逗号分隔；缺省时除 binder 外均作为 target' },
      mode: { type: 'string', enum: ['interface-refine', 'anchor-preserving', 'scaffold-rescue', 'full-explore'], description: '重设计 preset；缺省 interface-refine' },
      contact_frequencies: { type: 'object', additionalProperties: { type: 'number' }, description: '可选残基接触频率映射，如 {"A42":0.9}' },
      contact_frequencies_path: { type: 'string', description: '或接触频率 JSON 文件绝对路径；与 contact_frequencies 二选一' },
      fixed_positions: { type: 'array', items: { type: 'string' }, description: '显式冻结残基，如 ["A12","A15"]；优先于 preset' },
      design_positions: { type: 'array', items: { type: 'string' }, description: '显式设计残基，如 ["B3"]；优先于 preset' },
      design_interface: { type: 'boolean', description: '显式设置 interface 区域是否设计' },
      design_shell: { type: 'boolean', description: '显式设置 shell 区域是否设计' },
      design_surface: { type: 'boolean', description: '显式设置 surface 区域是否设计' },
      design_core: { type: 'boolean', description: '显式设置 core 区域是否设计' },
      model: { type: 'string', enum: ['soluble_mpnn', 'protein_mpnn'], description: 'MPNN 模型，缺省 soluble_mpnn' },
      n_sequences: { type: 'integer', minimum: 1, description: '生成候选数，缺省 16' },
      batch_size: { type: 'integer', minimum: 1, description: 'MPNN 批大小，缺省 1' },
      temperature: { type: 'number', exclusiveMinimum: 0, description: '采样温度；缺省按 preset 为 0.10、0.12 或 0.25' },
      seed: { type: 'integer', description: '固定随机种子，缺省 0' },
      out_dir: { type: 'string', description: '输出目录绝对路径；缺省 ~/.dsh/dsh-bio-galatea/out/redesign_<时间戳>' },
      additionalProperties: true,
    },
    op: 'redesign',
    timeoutMs: 600_000,
  })))

  // galatea_refold: binder 单体复折叠救援检查
  disposers.push(ctx.tools.register(galateaTool({
    name: 'galatea_refold',
    description:
      '检查 binder 离开 target 后能否折回参考构象：从复合物提取 binder 序列，调用 ESMFold 单链复折叠，再按序列对齐比较 Cα RMSD、pLDDT、二级结构一致性和偏差最大的残基。' +
      'ESMFold 不可用或内存不足时明确失败；结果阈值标记为未校准，仅供排序参考。' +
      '触发词：复折叠、单体结构检查、离开 target 还折得回吗、refold、monomer RMSD、折叠一致性。',
    parameters: {
      structure_path: { type: 'string', required: true, description: 'binder+target 复合物 PDB/CIF 文件绝对路径' },
      binder_chain: { type: 'string', required: true, description: 'binder 链 ID' },
      sequence: { type: 'string', description: '可选 binder 序列；缺省从复合物结构提取' },
      reference_binder_path: { type: 'string', description: '可选参考构象 PDB/CIF 文件，覆盖复合物中的 binder 构象' },
      out_dir: { type: 'string', description: '输出目录绝对路径；缺省 ~/.dsh/dsh-bio-galatea/out/refold_<时间戳>' },
      keep_pdb: { type: 'boolean', description: '是否保留 ESMFold 单体结构，缺省 true' },
      additionalProperties: true,
    },
    op: 'refold',
    timeoutMs: 1_800_000,
  })))

  return () => disposers.forEach((d) => d())
}
