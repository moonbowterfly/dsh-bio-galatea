# dsh-bio-galatea（G 系列 · 蛋白质结构预测与设计）

> **给 dsh / dsh-bio-genie 装上「蛋白质设计工具箱」**——本机即可完成序列设计、单链折叠验证、界面筛选与多样性选择；
> 零手动安装（私有 venv 一键自举），CPU / 小显存 GPU 自适应。

**Galatea**（伽拉忒亚）：希腊神话中被赋予生命的雕像——献给「从结构到序列」的蛋白质创造过程。

## 它解决什么问题

蛋白质设计（binder / 酶 / 纳米抗体）的标准流程散布在十几个工具里：设计序列要 ProteinMPNN、
验证折叠要 ESMFold、筛选结合要界面分析、选候选要聚类。本插件把它们收拢为 **19 个语义化工具**，
让 dsh 里的 agent（及 genie 宿主）直接调用——并**明确标注本机边界**（co-folding 等重算力环节
诚实指向外部服务，不伪装能力）。

## 安装

已发布 npm（`@dsh-bio/dsh-bio-galatea`；也可从 GitHub 源安装，纯 ESM 无构建步骤）：

```bash
# 0.1.x web / 有全局 CLI 时
dsh plugin --profile web add @dsh-bio/dsh-bio-galatea

# 无全局 CLI 时：
npx -y @deepseek-ai/dsh plugin --profile web add @dsh-bio/dsh-bio-galatea
```

**安装到 dsh 桌面端（0.2.0+，推荐）**——桌面端内置 dsh 命令与 pnpm，无需另装 Node/pnpm：

1. 先启动一次桌面端（初始化 `desktop` profile），**完全退出应用**；
2. 用桌面端自带 CLI 安装（Windows 默认安装路径）：

```powershell
& "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add @dsh-bio/dsh-bio-galatea
```

3. 重新打开桌面端生效（也可直接在桌面端内 **「插件」页**输入 `github:moonbowterfly/dsh-bio-galatea` 安装，无需退出应用）；打开后跑一次 `galatea_status` 确认组件与环境。

> 引擎兼容：0.1.x 与 0.2.0+（桌面端）均已实测——2026-10-01 桌面端 0.2.0-rc.2：19 个工具全量注册 + `galatea_status` 真实执行。

### 模型目录（可安装到其他磁盘）

大体积模型（ESMFold 权重约 2.5GB + MPNN 权重）默认位于 `~/.dsh/dsh-bio-galatea/models`（C 盘）。
可迁移到其他磁盘（省 C 盘空间；安装后随时可改）：

- **方式一（推荐）**：dsh 桌面端 → 设置面板「BioGenie」→「蛋白设计」页 →「模型目录」卡 → 填目标绝对路径 → **保存并应用**（写 `~/.dsh/dsh-bio-galatea/config.json`，立即生效）。
- **方式二（环境变量）**：`GALATEA_MODELS_DIR`（优先级最高，适合脚本化）。
- **方式三（手动）**：编辑 `~/.dsh/dsh-bio-galatea/config.json`：`{ "modelsDir": "F:/Models/AI_models" }`。

解析优先级：`GALATEA_MODELS_DIR` > `config.json.modelsDir` > `~/.dsh/dsh-bio-galatea/models`。
指向已含 `esmfold/`、`mpnn/` 的目录（如现有模型库）会**直接复用其中的权重**；指向空目录则下次
`galatea_setup` 会把模型下载/安装到新位置。修改**无需重启**——galatea 下一次工具调用即按新目录解析。

## 快速开始

```
1. 环境检查： galatea_status
    → 看组件（MPNN / ESMFold / 分析依赖）与设备（GPU/CPU）
2. 一键就绪： galatea_setup(action="all")    # 幂等，可重复跑；esmfold 权重约 2.5GB
3. 开始设计： galatea_mpnn                   # 给结构设计序列
   验证折叠： galatea_fold                   # 单链结构预测
   筛选界面： galatea_interface              # 复合物界面指标（输入 co-folding 产物）
   理化过滤： galatea_score                  # pI/净电荷/疏水矩/聚集代理
   结构检查： galatea_inspect                # clash / pLDDT 分布
   多样性：   galatea_cluster                # 同一性聚类 + 代表序列
   迭代控制： galatea_loop(action="log|next|status")  # 多轮台账与下一轮计划，不执行生成
   接触共识： galatea_contact_consensus             # 多模型界面频率、pair 和 anchor（不做排序）
   接触聚类： galatea_contact_cluster               # target footprint Jaccard + 频率向量 cosine 单链接
   组合选择： galatea_portfolio                     # 覆盖 floor、全局配额与风险约束；输出可审计四件套
   跨靶预算： galatea_budget                        # floor / exploit / reserve 三层给每个 target 分配整数配额
   覆盖审计： galatea_coverage                      # 检查 campaign 多样性 / quota，并可输出确定性 rescue 计划
   区域重设计： galatea_redesign                     # 按界面/anchor/骨架区域约束 MPNN
   复折叠救援： galatea_refold                       # 离开 target 后检查 binder 单体折叠
```

首次调用任一工具会启动后台 Python/torch 解释器探测，并立即返回 `PYTHON_PROBE_PENDING`；
稍后重试即可。若全部候选都缺 torch，计算工具返回 `PYTHON_TORCH_MISSING` 和安装提示；
仍可用 `galatea_status` / `galatea_setup(action="env")` 诊断和修复。手动安装或修改
`GALATEA_PYTHON` 后需重启 dsh；通过 `galatea_setup` 成功安装后会自动重新探测。

## 19 个工具一览

| 工具 | 用途 | 典型耗时 |
|---|---|---|
| `galatea_status` | 运行时状态（组件/设备/解释器） | 秒级 |
| `galatea_setup` | 零手动自举（env / mpnn / esmfold / all） | 分钟级（esmfold 5-30 分钟） |
| `galatea_mpnn` | 序列设计（ProteinMPNN / SolubleMPNN / LigandMPNN） | CPU 秒-分钟级 |
| `galatea_fold` | 单链结构预测（ESMFold，CPU/GPU） | CPU 分钟级/条 |
| `galatea_interface` | 复合物界面分析（接触/氢键/盐桥/埋藏面积/pLDDT） | 秒-分钟级 |
| `galatea_score` | 序列理化打分（pI/净电荷/GRAVY/疏水矩/聚集代理） | 秒级 |
| `galatea_inspect` | 结构 QC（clash / pLDDT 分布） | 秒级 |
| `galatea_cluster` | 候选聚类（多样性代表集） | 秒-分钟级 |
| `galatea_rank` | 候选共识排序（多预测器等权共识 + 分档） | 秒级 |
| `galatea_rank_aggregate` | 多批次排序结果聚合 → 统一排名 CSV | 秒级 |
| `galatea_loop` | 多轮设计战役记账、父本选择、停止建议与下一轮计划（不执行生成） | 秒级 |
| `galatea_contact_consensus` | 多模型界面残基/pair 频率、Jaccard 矩阵与 anchor（设计控制信号，不参与排序） | 秒-分钟级 |
| `galatea_contact_cluster` | target-side footprint Jaccard / 频率向量 cosine 单链接聚类，输出 pose/contact 簇、最近邻与 HHI/N_eff | 秒级-分钟级 |
| `galatea_redesign` | 区域约束重设计（冻结接触界面/anchor，支持 CORE/BOUNDARY/SURFACE） | 分钟级 |
| `galatea_refold` | ESMFold 单体复折叠；序列对齐 Cα RMSD、F2Å、pLDDT 与二级结构一致性 | CPU 分钟级 |
| `galatea_ingest` | 摄入本地 PDB/CIF、CSV/JSON/JSONL 或内联候选，按冲突策略写入统一 JSONL 台账 | 秒-分钟级 |
| `galatea_portfolio` | 按资格、靶点覆盖、多样性配额与风险上限确定性选择候选组合 | 秒-分钟级 |
| `galatea_budget` | 跨靶预算调度：三层配额、pilot shrinkage、密度门与 cap feasibility；handoff 仅产出 | 秒级 |
| `galatea_coverage` | Campaign 覆盖审计：检查 generator/contact/backbone family、未消费 generator 和 quota；可输出确定性 rescue 计划 | 秒级 |

## Campaign 覆盖审计（`galatea_coverage`）

输入候选 CSV/JSONL（唯一 `design_id`、`target_id`），可选当前选择集、每靶配额和 config。工具审计零覆盖、单 generator/contact/backbone family、未消费 generator 与 quota 执行情况。`rescue=true` 时只输出确定性的 ADD/REPLACE 计划，不修改选择集；列映射可适配 contact family 与分数字段名。工具只读取指定候选维度和排序分数，不读取湿实验标签，也不接入 loop 或 portfolio 消费。

## 跨靶预算调度（`galatea_budget`）

输入 target 汇总表（CSV/JSONL/JSON，必填 `target_id`；可选 `n_eligible`、`n_backbones`、`n_contact_clusters`、`pilot_attempts`、`pilot_passes`、`uncertainty`）、含 `total_budget` 的 config 和输出目录。工具按 preset 或显式份额建立 coverage floor、designability exploit（权重 `sqrt((pilot_passes+1)/(pilot_attempts+2))`）与 hard/uncertain reserve 三层整数池；当 `N<T` 时对最高 shrinkage 靶各分配一个名额。缺失的可选字段会告警并降低对应可行性报告能力。

默认 preset 为 `balanced`（20/65/15）；另有 `global-best-affinity`（15/70/15）、`multi-target-aggregate`（30/55/15）和 `per-target-coverage-heavy`（45/40/15）。contact-cap 只有 `q=N/T≤5`、非 `global-best-affinity` 且 `portfolio_v1_validated=true` 时才会生效；cap 不可行时明确建议放宽并记录 `CAP_RELAXED_INFEASIBLE`，配额超过可用池时记录 `QUOTA_EXCEEDS_POOL`，不会静默少交。输出 `budget_allocation.csv`、`budget_summary.json`、`budget_manifest.json` 和 `portfolio_handoff.json`；allocation 按 `target_id` 升序，`flags` 与 `reason_codes` 使用 JSON 数组字符串；handoff 本批仅产出，不由 portfolio 或 loop 消费。输入和输出均不包含湿实验标签。

## 候选组合选择（`galatea_portfolio`）

输入候选 CSV、JSONL 或 JSON 数组，至少包含 `design_id`、`target_id`，并提供 `consensus_percentile` 或 `consensus_score`。缺少百分位但有共识分时，工具按靶点计算 midrank 百分位；有 `sequence` 但没有 `sequence_group_id` 时，按 ingest 相同公式 `SHA1(target_id + "|" + sequence)` 派生。默认先排除 QC FAIL、同靶重复序列、缺必需字段和不可排序候选，再满足每靶覆盖 floor，最后让余下候选按靶内共识百分位、共识分和 design_id 竞争。

默认 `total_slots=500`、`min_targets=5`、每 backbone 最多 2 个、HIGH_RISK 上限为总 slots 的 10%；自动 lineage cap 为 `max(2, ceil(0.05 × est_target_slots))`。这些参数都可通过内联 `config` 对象或 JSON 文件调整。缺少可选多样性字段时，工具告警并让对应候选在该维度不受 cap 限制。调用需指定 `out` 目录；正常运行输出 `portfolio_selected.csv`、`portfolio_rejected.csv`、`portfolio_summary.json` 和 `portfolio_manifest.json`。Manifest 记录输入、配置哈希及三份 payload 文件的哈希；它不对自身做自引用哈希。该工具不读取实验标签、不访问网络，也不接入 `galatea_loop`。

## 候选摄入台账（`galatea_ingest`）

每条候选都需要稳定的 `target_id` 和 `design_id`；记录身份由两者共同确定，因此同一序列属于不同靶点时会保留为不同记录。台账另存 `seq_sha1` 与 `sequence_group_id`，相同序列不会合并不同设计实例。结构以对象记录绝对路径、文件 SHA256、显式 `role`、预测器/模型/seed 及 binder/target 链；未提供角色时记为 `other` 并告警。分数保留在 namespaced `raw_scores`，对应的 `direction` 与 `version` 写入 `<ledger>.schema.json` sidecar，不计算统一质量分。`parent_id` 只按显式 ID 解析；缺失父本保留为 `DANGLING_PARENT`，后续 append 补入父本后会重算谱系，不按序列相似度推断。

## 区域重设计与单体复折叠

`galatea_redesign` 接收 binder+target 复合物和 binder 链，binder-alone Shrake–Rupley SASA（probe 1.4 Å）按 Tien et al. MaxASA 归一化为 rSASA，并分为 CORE（≤0.10）、BOUNDARY（0.10–0.25）和 SURFACE（≥0.25）。报告界面是 ≤4 Å 重原子接触与 ΔSASA≥1 Å² 的并集；hard-freeze 使用 ≤4 Å 接触。shell 是 target 4–8 Å 与 interface 周围 6 Å 的结构壳并集。`interface-refine` 冻结接触界面，`anchor-preserving` 冻结频率≥0.7 的 anchor（缺频率时标记降级），`scaffold-rescue` 只冻结接触界面和显式 anchor，让其余 CORE/BOUNDARY/SURFACE 位点参与设计；CORE 突变比例 >0.35 会记 WARN，不拒绝候选。显式 `fixed_positions` / `design_positions` 覆盖 preset；结果含逐残基表，并写入 FASTA、JSON 元数据和 LigandMPNN 可读的固定残基清单。

`galatea_contact_consensus` 接收多份预测复合物 PDB/CIF，按 4 Å 重原子跨链接触汇总 binder/target 残基频率、稀疏 pair 频率、residue-set 与 edge-set Jaccard，并写出完整矩阵 artifact。coverage ≥8/≥6/<6 分别为 PASS/WARN/INSUFFICIENT；anchor 要求残基频率≥0.70 且至少一个 partner pair 频率≥0.50。链参数缺省时逐模型自动判定角色，汇总标签以按文件名排序的首个有效模型为准，并通过 `chain_label_mappings` 返回各模型原链 ID 到汇总标签的映射。该结果供 `galatea_loop` 的 anchor-fixed 操作与 redesign 使用，不是 ranking score。

`galatea_refold` 从复合物提取 binder 序列，用现有 ESMFold 流程进行单链预测，再按序列对齐比较参考和预测结构。除 RMSD、pLDDT 与 phi/psi 三态二级结构一致性外，还记录对齐 Cα 偏差 ≤2 Å 的比例 F2Å；F2Å 只作记录，不改变 verdict。现有阈值尚未校准，需经 `binder_eval` 校准后才能作为筛选条件。ESMFold 不可用或内存不足时会明确失败。

## 设计迭代（`galatea_loop`）

`galatea_loop` 是 predict-and-redesign 循环的决策与记账层；它只读写调用者指定的战役目录，不运行 MPNN、云端生成或预测。`action="log"` 接收非负 `round_id` 与候选列表，候选可带预测器分数字典或 `ipsae_min_*` 扁平分数，以及 `parent_id`、`sequence`、`structure_path`、`qc_status` 和 `flags`。结果分别写入 `campaign.json`、`rounds/round_<id>.json`；重复轮次必须显式设置 `overwrite=true`。

`action="next"` 对最近一轮按 `rank_tools` 的 skip-missing 等权均值计算共识，再将轮内共识转成并列值使用平均秩的降序百分位（最高为 1.0）。不确定性是可用预测器分数的总体标准差；少于两个分数时记为 0 并返回警告。资格门为 `qc_status != FAIL` 且百分位不低于 `min_consensus_pctl`。合格者按约 60/20/20 分入 exploitation（百分位 ≥0.80，单谱系最多一个）、uncertainty（百分位 ≥0.50 且不确定性达到本轮最近秩 Q75）和 diversity（剩余合格者贪心 max-min；先优先不同序列簇，再比较较短序列前缀的同一性距离）。序列簇由 `seq_analysis.cluster_sequences` 计算。父本目标数为 `min(max_parents, max(min_parents, cloud_budget_round // 6))`，合格候选不足时按实际数量输出原因。

每个父本的本地计划总数缺省 32，拆为 `fixed_interface_solublempnn` / `soluble_mpnn` / T=0.1 / 16 条、`anchor_fixed_solublempnn` / `soluble_mpnn` / T=0.12 / 8 条、`explore_mpnn` / `protein_mpnn` / T=0.25 / 8 条；云端每父本缺省计划 6 条。计划会注明缺少结构路径时界面冻结如何降级，以及缺少 contact-consensus 时 anchor 如何降级。谱系沿 `parent_id` 回溯；任一谱系连续两轮最佳百分位提升 <0.05 且没有新簇时列入 `stop_lineages`，不会再被选为父本。推广规则是子代百分位比父本至少高 0.05，或子代百分位 ≥0.90 且形成新簇。停止建议检查连续两轮推广率 <5%、连续两轮最佳百分位提升低于 `improvement_epsilon`、累计 ≥100 个高置信合格候选（百分位 ≥0.80）或达到 `max_rounds`。这些计划是确定性的占位建议，生成仍由 `galatea_mpnn` 或外部云平台完成。

常用默认参数：`cloud_budget_round=96`、`max_parents=16`、`min_parents=8`、`per_parent_local=32`、`cloud_per_parent=6`、`min_consensus_pctl=0.50`、`promotion_delta=0.05`、`max_rounds=6`、`improvement_epsilon=0.02`、`diversity_threshold=0.8`。`action="status"` 汇总各轮最佳/中位共识、候选与谱系数量、推广率、最新计划路径和继续/停止/补数据建议。

## 硬件边界（诚实声明）

| 环节 | 本插件 | 外部选项（当本机不足时） |
|---|---|---|
| 序列设计 | ✅ 本机（CPU 即可） | — |
| 单链折叠验证 | ✅ 本机（ESMFold，CPU/小 GPU） | — |
| 界面/序列分析 | ✅ 本机 | — |
| 复合物 co-folding | ❌（显存需求远超消费级） | AlphaFold Server / PXDesign / ColabFold / Tamarind |
| 大显存 backbone 生成 | ❌ | PXDesign / Tamarind / RFdiffusion（云） |

## 依赖与致谢

- [LigandMPNN / ProteinMPNN](https://github.com/dauparas/LigandMPNN)（MIT，Dauparas et al.）——序列设计内核（vendor 于插件私有目录，权重自 IPD 公开源获取）
- [ESMFold](https://github.com/facebookresearch/esm)（Meta，通过 🤗 transformers 加载）——折叠预测
- [Biopython](https://biopython.org/)（Biopython License Agreement / BSD-3）——结构/序列分析
- 自举由 [uv](https://github.com/astral-sh/uv) 驱动；零手动安装，不触碰系统 Python

## 许可

MIT（本插件自身）。第三方组件许可见上「依赖与致谢」。

## English

**dsh-bio-galatea** is the protein structure prediction & design member of the G-series dsh plugins.
Fifteen semantic tools cover sequence design (ProteinMPNN/SolubleMPNN/LigandMPNN), region-constrained
redesign, single-chain folding and refolding rescue, complex-interface analysis, sequence scoring,
structure QC, and diversity clustering — with zero-manual-setup (private venv auto-bootstrap) and honest capability
boundaries (heavy co-folding stays with external services). Designed to coexist with
dsh-bio-genie (`bio_*` tools) in the same dsh instance.

```bash
# from npm (also available from source: github:moonbowterfly/dsh-bio-galatea):
dsh plugin --profile web add @dsh-bio/dsh-bio-galatea

# desktop app (0.2.0+) — bundled CLI with --profile desktop:
#   & "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add @dsh-bio/dsh-bio-galatea
```
