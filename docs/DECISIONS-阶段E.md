# DECISIONS-阶段E — genie 接入期（E4 弹性批次）实测结论与决策

> 2026-08-31 阶段 E「genie 接入 gem + 全面实战验证」弹性批次。执行与证据：`D:/Program/Zcode/gem-verify/work/e/`。

## E4a 引擎对照（CarveMe vs gapseq，同基因组 C58）— 正式归因

benchmark 全量对比（AB，essential_full=true，231.3s，export_md 落盘 `e4a_benchmark_report.md`）：

| 维度 | CarveMe (C58_carveme_test.xml) | gapseq (C58.xml) |
|---|---|---|
| 规模 | 1495 基因 / 3109 反应 / 1981 代谢物 | 1084 基因 / 2485 反应 / 2062 代谢物 |
| AB 生长 | 0.624132 | 0.519981（锚点精确复现） |
| biomass 结构 | `Growth` 显式 57 组分，GAM=53.95（in-biomass），断供 0 | `bio1` 81 组分，GAM=40.0，**断供 7**（cpd00166/01997/03422/11493/12370/15665/15666） |
| 必需性（全量） | 90/1276 | 155/818 |
| 表型（19 底物 sole） | 11/19 = 57.9% | 11/19 = 57.9%（**Arabinose 双双失败**——两引擎独立重建同缺 L3 阿拉伯糖分解路径） |

必需性差异分解（identity+gene.name 映射，覆盖 88.89%）：intersection 68 / a_only 12 / b_only 87。
**归因**：差异主体不是命名空间映射噪声，而是两引擎的通路覆盖与 biomass 结构差异（gapseq bio1 更大更严——
81 组分含 7 个模型内不可净产前体，敲除网络对前体供给更敏感→必需集更大）。

## E4b 跨命名空间基因映射桥 — 原型结论（不并入插件）

前提修正：任务书设定"覆盖率从 0 提升"，实测 identity+gene.name 已达 **88.89%**（80/90）——前提过时。
EC 等价类桥原型（`work/e/e4b_ec_bridge_probe.py` + `e4b_bridge_crossref.py`）：

- gapseq 侧 EC 索引 848 个（反应 id/annotation 提取）
- 10 个未映射必需基因中 6 条 EC→gapseq-essential 命中；**唯一靶规则**（多候选拒绝）下可信桥 2 条：
  NC_003062_2_847→NC_003063_2_595（4 EC 同靶）、NC_003063_2_888→NC_003062_2_1639
- 覆盖率 0.8889 → **0.9111**（+2.2pp）；剩余未映射多为模型内容差（gapseq 无对应基因），非命名空间问题

**决策**：不并入 benchmark 映射层。理由：收益 ≤2pp、EC→多候选歧义需二次证据消歧、错误映射会污染必需性对比结论。
原型脚本留存可复跑；若未来接入 Atu 旧 locus 桥（GFF/tbl 资产），应与本 EC 桥合并为"二级映射策略"并带 evidence 标注。

## E4c 双敲全扫先验排序 — 已实现（v0.1.1）

见 commit 8736690。诚实结论：C58 上全部 18 对 SL 均为 GPR 穷尽型同工酶对（先验区），扫描区排序无可测收益；
改动是其他模型的期望改进（共享反应数降序=冗余暴露先验），零回归（18/18 集合一致）。

## E4d iNX1344_v4 断供 5 组分诊断深化 — 可行性报告（不修模型）

demand 探针（全交换开放 lb=-10）复现 5 断供前体：**M00155_c / M00336_c / M00342_c / M01051_c / M02908_c**。

关键事实（`work/e/e4d_inx_probe.py` + `e4d_inx_neighborhood.py`）：

1. 仅 M00342（Sn-Glycero-3-phosphoethanolamine，C5H14NO6P）在模型内有 name+formula；
   其余 4 个是**裸 MetaCyc M-ID**（无 name/formula/annotation）——修复前必须先做化合物身份解析（外部证据，不可臆造）。
2. 邻域分析：5 个断供物由 Rnxatu0461-0470/Rnxatu0577（反应名内嵌 MetaCyc R0xxxxx id）连成**内部互连的孤岛子网络**——
   断供根因是孤岛与核心代谢之间缺上游供给连接，不是 biomass 化学计量错误。
3. 修复路径可行性 = 中：①MetaCyc 身份解析（4 个裸 ID）；②孤岛边界死端代谢物定位；③按 MetaCyc 通路补连接反应（需文献证据分级）。
   属"补路径"而非"补公式"；G6 能量泄漏哨兵必须随补随测。

## 接入记录（genie 侧）

genie preset persona.md 增代谢模型能力域路由段（commit e38c561）+ docs/plugin-integration.md 契约 v1（64dae29）+
bio_python 桥 exitCode 校验（06c8c05，genie 0.6.25）。路由生效、契约传导（prediction_id/status 引用与账本 grep 一致）
经真实 agent 会话验证，详见 `D:/Program/Zcode/gem-verify/phaseE-report.md`。
