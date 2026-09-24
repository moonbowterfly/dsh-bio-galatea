# DECISIONS-2026-08-29 — GLM 两轮评审裁决与路线固化

> 第三方 LLM（GLM）对纯 Windows 路线功能/架构的两轮评审；按"以实测为准、独立裁决"原则的采纳记录。

## 第一轮（功能拓展+优化）裁决

| 建议 | 裁决 | 备注 |
|---|---|---|
| P0 pyrodigal 注释（兑现"基因组→模型"承诺）| ✅ 原则采纳 | **待用户解锁**（用户已说暂不补注释步骤）；落地=官方注释优先+pyrodigal 兜底+meta 模式（<100kb 强制）|
| P0 G5 全量必需性扫描（FVA 预筛）| ✅ 采纳 | 排入路线；模型卡加必需基因章节（证据着色）|
| P1 gapseq 白名单 + L3 MILP 组合拳 | ✅ 采纳 | 白名单仅本地基准（license 见下）；L3 候选池=自建同源映射（license 干净）|
| P1 biomass 精修（参考对照）| ✅ 采纳但后置 | 级联重置验证基线风险；做成可选 --biomass-profile + before/after 三联对照 |
| P2 accession 下载 / P3 表型 schema / P3 差分 / P4 交叉 / P4 可视化 | ✅ 按序采纳 | 可视化=Escher JSON 导出（不做内嵌渲染）|
| 建模卡 RPC/架构优化 | ✅ 见第二轮 | — |
| 五道关卡→关卡注册器 + G6 ATP 泄漏 | ✅ **已实现** | G6 实测 C58 PASS（flux 0.0）|
| 防过补第五闸门（全局预算 <5%）| ✅ 采纳 | 表型回填/长期迭代防温水煮青蛙 |
| 证据分级枚举（sequence/literature/rule/math）| ✅ 采纳 | 白名单+MILP 落地后填充 model card |
| SBML 往返保真测试 | ✅ 采纳 | 进 smoke |

## 第二轮（7 问）裁决

1. **注释质量**：✅ 官方注释优先+pyrodigal 兜底；验证协议（预测蛋白覆盖率 85-92%、反应 delta<3%、生长差<5%）待解锁后实施。
2. **license**：✅ **分离消费**——seqDB 仅本地基准不分发；自建 UniProt→EC→BiGG 作可分发白名单/L3 候选池（license 干净）；止损 2 周；GPLv3 环绕注意。
3. **介质的共享形态**：✅ 单一 Python 来源 + RPC/CLI 子命令（不做双语言双包）；schema v2 采纳，**修正 units=mmol/gDW/h（非 1/h）**。
4. **modelseedpy**：✅ P2 交叉分歧清单主体（非并列引擎）；BiGG↔SEED 桥复用 MET_ALIAS 模式。
5. **G6**：✅ 已实现（ATP demand 全关最大化 >0.01 WARN）；补洞后必跑；注册器已内置。
6. **证据呈现**：✅ 分区+徽标+行着色+`--strict-evidence` 开关（不隐藏不全表高亮）。
7. **排期冲突**：✅ 衔接前置（schema v2/media_resolve RPC）归入 gem 内部工作流；genie 解锁即消费，gem 主线不阻塞。

## 落地状态

- [x] G6 ATP 泄漏关卡 + 关卡注册器（validate.py；C58 PASS 0.0）
- [ ] schema v2（supported_mediums/verified_phenotypes/model_lineage/evidence_summary）——unit 已定为 mmol/gDW/h
- [ ] G5 全量（FVA 预筛）——路线 P0
- [ ] 白名单 + L3 MILP + 证据分级——路线 P1（license 结论已定：自建映射）
- [ ] 注释步骤（pyrodigal）——**待用户解锁**
- [ ] genie 衔接（RPC 子命令）——待用户解锁