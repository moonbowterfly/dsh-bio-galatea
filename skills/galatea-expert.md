---
name: galatea-expert
description: "蛋白质结构预测与设计主指引（Galatea 插件）：工具分层选择、设计筛选工作流、CPU/GPU 边界纪律。"
language: python
---

# galatea-expert — 蛋白质结构预测与设计主指引

> 插件：dsh-bio-galatea（G 系列蛋白质工具域）｜ 14 工具：`galatea_status / setup / mpnn / fold / interface / score / inspect / cluster / rank / rank_aggregate / loop / contact_consensus / redesign / refold`
> 定位：**本机可承担**的蛋白质设计计算（序列设计、单链折叠、界面与序列分析、聚类）；
> **不承担**重型 co-folding（AF2/AF3/Boltz 复合物预测——走外部服务，产物回本插件分析）。

## 一、第一步永远是环境决策

任何蛋白质任务开始前：

1. **`galatea_status`** —— 看：解释器/torch、组件（MPNN 代码与权重 / ESMFold 权重 / 分析依赖 biopython）、设备（GPU 还是 CPU）。
2. 缺什么装什么：**`galatea_setup`**（action=env / mpnn / esmfold / all；**幂等**，重复调用安全）。
   - `action=esmfold` 约 2.5GB 下载（5-30 分钟）：**耐心等待一次，勿重复调用**。
3. 按需进入具体任务。

## 二、工具决策树

| 需求 | 工具 | 关键参数与备注 |
|---|---|---|
| 有结构，要设计序列（inverse folding） | `galatea_mpnn` | `chains` 指定设计链（如 binder 链 "A"）；`model`：protein_mpnn（默认）/ soluble_mpnn（溶解度优先）/ ligand_mpnn（含配体界面）；`temperature` 0.1 保守、0.3 多样 |
| 有序列，要预测单链结构 | `galatea_fold` | ESMFold；1-8 条/次；`device`=auto 默认；CPU 分钟级/条 |
| 有复合物结构，要评估结合界面 | `galatea_interface` | 输入 co-folding 产物（外部生成）；输出接触/氢键/盐桥/埋藏面积/pLDDT 分带 |
| 序列质量过滤（批量） | `galatea_score` | pI/净电荷/GRAVY/疏水矩/**聚集代理**（阈值判读：低<0.35 / 中 0.35-0.55 / 高>0.55） |
| 结构质量检查 | `galatea_inspect` | clash（<1.5Å）+ pLDDT 分位；提交前 QC |
| 大量候选要选多样性代表 | `galatea_cluster` | 同一性聚类（缺省 0.8）+ 贪心代表集；输入按 score 降序让高分优先当代表 |
| 多预测器分数 → 共识挑高分（排序） | `galatea_rank` | 输入候选表（JSON 文本或 CSV 路径；分数列前缀缺省 `ipsae_min_`）；输出共识分 + 档位（strong≥0.73 / medium≥0.65 / weak≥0.2）+ 排名；数据口径：共识 top10-20% 命中富集约 2.3x |
| 多批结果合并统一排名 | `galatea_rank_aggregate` | `batches`（前序结果 / 候选数组 / CSV 路径混合）→ 全局重排 + `output_csv` 落盘（必填） |
| 已有多轮候选，规划下一轮 | `galatea_loop` | `action=log/next/status`；登记候选分数与 parent_id，按资格门、谱系、模型不确定性和序列簇生成下一轮计划；只记账和规划，不执行生成 |
| 多个预测复合物要找稳定界面与 anchor | `galatea_contact_consensus` | `models` 或 `models_dir`+`glob`；汇总残基/pair 频率与 residue/edge Jaccard；链参数缺省时按角色统一不同模型的链 ID，并返回 `chain_label_mappings`；coverage <6 时不返回 anchors；仅作设计控制，不参与排序 |
| 有 binder+target 结构，要按区域约束重设计 | `galatea_redesign` | `binder_chain` 与 `mode` 必填推荐；interface-refine hard-freeze ≤4 Å 接触，anchor-preserving 需接触频率（≥0.7 冻结），scaffold-rescue 固定接触与显式 anchor、允许 CORE 改动；三态 rSASA 区域 + 双 shell；`fixed_positions` / `design_positions` 覆盖 preset |
| 想确认 binder 离开 target 后能否折回参考构象 | `galatea_refold` | `structure_path` + `binder_chain`；可覆盖 `sequence` / `reference_binder_path`；输出 RMSD、F2Å、pLDDT 与二级结构；F2Å 仅记录，现有阈值尚未校准 |

## 三、典型工作流

### A. 设计-筛选循环（binder / 酶等通用）
```
1. 结构准备：外部 backbone 生成（RFdiffusion 类）或天然/实验结构 → 本地 PDB
2. galatea_mpnn     设计 N 条候选序列（先 16 条试探，可行再放大）
3. galatea_score    批量理化过滤（剔高聚集/异常电荷）
4. [外部] co-folding 预测复合物（AlphaFold Server / PXDesign / ColabFold）
5. galatea_interface 界面指标排序筛选（接触数/氢键/盐桥/埋藏面积/pLDDT）
6. galatea_cluster   选多样性代表（提交/验证集合）
7. galatea_inspect   最终候选结构 QC
```

### B. 快速序列验证（无复合物需求）
`galatea_fold`（预测）→ `galatea_inspect`（QC）→ `galatea_score`（理化）。

### C. 已有设计批量处理
FASTA 进 → `galatea_score`（过滤）→ `galatea_cluster`（去冗余）→ 小批量 `galatea_fold` + `galatea_inspect`（抽检）。

### D. 迭代循环（多轮 predict-&-redesign）

`galatea_loop` 管理多轮父本筛选与计划，不会调用 MPNN 或云平台。先用 `action="log"` 登记每一轮的候选分数、QC 状态、序列和子代的 `parent_id`；每轮结果要保留可追溯的 `candidate_id`。然后用 `action="next"` 读取最近一轮，按共识百分位与 QC 资格门选择 exploitation、uncertainty、diversity 父本，并把本地 16/8/8 操作配额、云端预测占位、谱系停止与战役停止建议写入 `plans/round_<n>_plan.json`。根据计划手动运行 `galatea_mpnn` 和已选云端服务，整理结果后再 `log` 下一轮。`action="status"` 随时查看战役摘要。重复登记同一 round_id 会报错；确需替换时显式传 `overwrite=true`。

父本资格是 `qc_status != FAIL` 且轮内共识百分位达到 `min_consensus_pctl`。缺少多个预测器时 uncertainty 会回退为 0 并在计划中提醒；没有结构或有效 contact-consensus 输入时，计划会标记界面冻结或 anchor 策略降级。有效输入会把该候选的 `anchor_residues` 写入 parent，并记录 coverage status。停止建议应与实验目标一起判读；`galatea_loop` 不会自动执行任何生成。

### E. 区域约束重设计与复折叠救援

多模型预测完成后，可先对 `predicted_*.cif` 调用 `galatea_contact_consensus`，检查 residue/pair 频率、两类 Jaccard 与 artifact 矩阵；结果里的 `contact_frequencies` 可直接输入 redesign，loop 也会把同候选的有效 anchor 列表接入 parent。coverage 不足时保持已有降级行为，不把低覆盖 anchor 当作可靠输入。

对已有复合物 binder 进行保守重设计时，用 `galatea_redesign` 输入复合物与 binder 链。它在 binder-alone 坐标上以 1.4 Å probe 做 Shrake–Rupley SASA，再按 Tien et al. (2013) MaxASA 计算 rSASA：CORE ≤0.10、BOUNDARY (0.10,0.25)、SURFACE ≥0.25。报告 interface 是 ≤4 Å 接触与 ΔSASA≥1 Å² 的并集，但 hard-freeze 优先使用接触；shell 是 target 4–8 Å 与距离任一 interface binder residue ≤6 Å 的并集。选 `interface-refine` 保留接触、`anchor-preserving` 保留高频接触 anchor、`scaffold-rescue` 固定接触与显式 anchor，允许改动 CORE 以修复 scaffold，或用 `full-explore` 扩大探索；CORE mutation fraction >0.35 会记 WARN，不拒绝候选。先核对返回的 regions/residue_table/fixed mask，再查看 FASTA 与元数据。固定/设计位置可显式覆盖 preset。

对一个或多个设计序列评估脱靶后的单体折叠时，运行 `galatea_refold`。它复用本地 ESMFold，按序列对齐参考结构，输出 Cα RMSD、偏差 ≤2 Å 的对齐 Cα 比例 F2Å、pLDDT 分位数、phi/psi 三态二级结构一致性及偏差最大的 10 个残基。F2Å 只作记录，不进入排序或 gate；其他阈值尚未校准。ESMFold 权重不可用或内存不足时结果会明确失败，不会返回假成功。

## 四、硬件边界与纪律（本机 4GB GPU / CPU 场景）

- **本机可承担**：序列设计（MPNN——CPU 秒-分钟级）；单链 ESMFold（CPU 分钟级/条）；界面/序列/聚类分析（轻量）。
- **必须外部**：复合物 co-folding（AF2/AF3/Boltz——显存需求远超 4GB）。报告时明确说「需外部服务」并给选项，不要伪装能力。
- **长任务**：`setup(esmfold)` 与 `fold` 可能运行数分钟——**一次调用、耐心等待**；不要连续重复调用。
- **设备**：`device=auto` 自动选；4GB GPU 跑 ESMFold 时 worker 自动用小 chunk（16）。
- **数字纪律**：结构指标/分数只引用工具真实输出；跨结构对比用同一参数（如 contact_cutoff）。

## 五、与其他 G 系列插件的协作

- 序列/结构数据的获取与通用分析用 **genie 的 `bio_*`** 工具（NCBI/UniProt 检索、序列统计等）；蛋白质设计专用步骤用本插件 `galatea_*`。
- 代谢建模（gem）/基因编辑（graft）与本插件同实例共存，各自域独立。

## 六、故障排查

| 症状 | 处理 |
|---|---|
| `galatea_status` 显示 `python.torch` missing | 运行 `galatea_setup(action="env")` |
| `runtime.mpnn` missing | 运行 `galatea_setup(action="mpnn")` |
| `runtime.esmfold` missing | 运行 `galatea_setup(action="esmfold")`（大下载） |
| `galatea_mpnn` 报「run.py 退出码非 0」 | 看返回的 stderr_tail；常见：输入 PDB 链名不匹配 / 权重缺失 |
| `galatea_fold` 报 OOM | 减少序列数/缩短序列；或强制 `device=cpu` |
| 网络（mpnn/esmfold 下载失败） | 检查网络；esmfold 可设 `HF_ENDPOINT=https://hf-mirror.com` 后重试 |
