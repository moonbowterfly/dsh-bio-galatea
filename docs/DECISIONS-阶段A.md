# DECISIONS — 阶段 A：可信度内核六批次（2026-08-30）

> 记录阶段 A（M1 fluxscan / M2 sensitivity / M3 ledger / M4 消费方升级 / M5 iNX1344 前哨 / M6 基准与文档）的每个设计决策与依据。背景：L1/L2 已做到行业上游，短板在 L3（通量分布）/L4（定量速率）呈现——单点 FBA 通量取决于求解器顶点，跨条件点值 diff 是伪影。本阶段让 L3 通量一律区间制、L2 必需性变稳定性谱、所有预测进账本可追踪。

## M1 gem_fluxscan（通量区间制）

| # | 决策 | 依据 |
|---|---|---|
| M1-1 | **语义按 bsp 锁稿一字不改**（fva_min/fva_max/pfba 三件套；区间分离判定公式；overlap=伪影禁止引用） | 任务书明确"语义已锁定，建议写报告由 bsp 裁决" |
| M1-2 | **fraction_of_optimum 默认 0.9999 而非 1.0** | 1.0 时数值噪声会使个别区间变空/变窄（求解器在最优面顶点的抖动）；0.9999 留 0.01% 最优性余量换区间稳健性，对生长影响 <0.01% |
| M1-3 | **tolerance 默认 1e-6 mmol/gDW/h** | 与必需性判定 EPS 同量级；区间间隙须 > 容差才判分离——防止把求解器噪声当成"硬结论"。判定公式 `ua+tol<lb → b_higher; ub+tol<la → a_higher; 否则 overlap` |
| M1-4 | **判定与输出/CSV 同用 6 位舍入值**（而非 raw 值判定、展示舍入） | 自洽性：用户可从展示值直接复核判定。6 位舍入误差（≤5e-7）< 容差（1e-6），不改变科学结论。若 bsp 偏好 raw 判定，改一行 |
| M1-5 | **每 condition 独立 `silent_read_sbml` 重读模型**，不用 cobra Model 深拷贝 | 深拷贝共享底层求解器状态有交叉污染风险；读模仅 4s，22 组合级成本可忽略（M2 实测 fresh 模型还规避了 GLPK 病态停摆，见 M2-5） |
| M1-6 | **`reactions` 子集仅收窄 comparisons/summary 且两者同口径**；FVA/pFBA 恒全模型 | 任务书明确"禁止 summary 全模型 vs comparisons 子集矛盾"；FVA 全模型算一次，子集只是输出过滤，无性能收益可图 |
| M1-7 | **only_diff 只过滤 comparisons，summary 仍全口径计数** | summary 的 total/overlapping 描述整个 scope 才有意义；任务书未明说，按"summary 与 scope 同口径"原则实现并报告 |
| M1-8 | **conditions.name 唯一校验（重复直接报错）** | 任务书锁定要求；pairs 引用条件名，重名会使引用歧义 |
| M1-9 | **任务书容差单测第 5 组与锁定公式矛盾——按公式实现，差异上报** | 公式 `ua+tol<lb` 要求间隙>tol；样例 `[1.0,1.0000005] vs [1.000001,2.0]` 间隙 5e-7 < tol 1e-6，公式判 overlap 而任务书写"分离"。公式是保守科学语义（防噪声造假硬结论），判"分离"需要反语义的 `ua<lb+tol`（会让"接触"样例变 b_higher，与第 2 组矛盾）。已按公式实现并双容差断言（1e-6→overlap；1e-7→b_higher 证明容差机制生效）。**待 bsp 裁决** |

## M2 gem_sensitivity（结构性灵敏度）

| # | 决策 | 依据 |
|---|---|---|
| M2-1 | **GAM 载体探索结论：C58 载体在 biomass 方程 bio1 内部**（81 组分中 ATP 水解 stub 五元组：ATP -40.165476 / H2O -34.922907 / ADP +40.0 / Pi +39.992706 / H+ +40.0，GAM_ORIG=40.0 以 ADP 系数为净水电解量），非独立 ATPM（全模型无 lb>0 维持反应） | 公式级（元素组成）识别跨命名空间通用（ModelSEED/BiGG/MetaCyc 都适用），不依赖 id 约定 |
| M2-2 | **正交化实现**：biomass 组分缩放排除 5 元 GAM stub 与 Biomass 产物（连接 objective 的汇组分）；GAM 网格只动 stub（等比缩放 X/GAM_ORIG，保留 stub 内部记账不对称如 ATP-40.165 vs ADP+40） | 任务书要求"biomass 变体与 GAM 网格正交不混淆"；等比缩放保持 gapseq stub 的内部比例，可逆、可解释 |
| M2-3 | **biomass 组分缩放语义 = 75 个原料/副产系数 ×f，Biomass 产物系数保持 +1.0** | 若把产物也缩放，growth 恰好等比缩放（平凡结论）；保持产物=1 才是真正的"组成不确定→生长响应"问题，且与 GAM 轴正交 |
| M2-4 | **网格 = 3 biomass 档 × 7 GAM 档 = 21 扫点 + 1 基准（不扰动）= 22 组合**；每组合 wt growth + 必需性重扫（复用 essential_scan 拆出的 `setup_model_medium`/`scan_essentiality`） | 任务书锁定；基准与 essential_scan 完全同参数 → **实测精确复现 155（155 vs 155 EXACT MATCH）**；(1.0, gam=40) 扫点与基准互证（0.519981/155 双一致，stub×40/40=1.0 无扰动的数学必然） |
| M2-5 | **GLPK 病态停摆护栏 LP_TIMEOUT_S=30**（optlang configuration.timeout）+ 扰动后不生长的组分跳过必需性漂移 | 实测两次全量扫描卡死于特定扰动 LP（GLPK 单纯形停摆）；30s 上限对正常 <0.05s 的 LP 是 600× 余量，永不误伤。刚性组分对（ACP↔apo-ACP 等 7 个）任一 ±25% 使 biomass 方程不可满足 → growth=0 → 必需性判定退化为"全候选必需"，漂移无意义 |
| M2-6 | **CSV 导出容错**（跳过行无 essential_count 的 KeyError 曾致 45min 全量在导出步崩溃） | 教训：长任务的所有输出步骤必须 try/except 或缺省键兼容，不能让已完成 95% 的计算死在最后一行 |
| M2-7 | **稳定性三分类**：always（22/22 组合必需）/ conditionally / never；基准 155 ⊆ always∪conditional 硬断言 | 任务书锁定断言（基准在网格内故必成立）；C58 实测 always=155 / conditional=0 / never=929——必需集对该网格完全鲁棒 |
| M2-8 | **模型卡 robustness 章节 = schema v3**（v2 + robustness 字段，只增；`_ensure_v2` 接受 v3 不降级）；无 card 不造卡 | 向后兼容：读卡方按 JSON 字段访问，v2 消费方忽略 robustness 即可；C58/C58_P1 无卡 → card_robustness_written=false 如实报告 |

## M3 gem_ledger（prediction ledger）

| # | 决策 | 依据 |
|---|---|---|
| M3-1 | **追加式 JSONL**（`~/.dsh/dsh-bio-gem/ledger/predictions.jsonl`，目录不存在则创建）+ 幂等哈希去重（model+condition+type+content 的 sha256） | 任务书锁定；幂等使"每次扫描自动登记"可安全重复执行（实测 155 条复跑 appended=0/skipped=155） |
| M3-2 | **evidence_tier 取支撑反应 evidence 集合中最高者，优先级 literature > sequence > rule > math；无标注默认 EVIDENCE_rule 并注明** | 任务书锁定优先级。注意与插件既有分级的表述差异：l3_fix 语境里 sequence（白名单直接对应）> math；ledger 的序以任务书为准，且 C58 实测全部默认 EVIDENCE_rule（l3_fix 数学连接反应无 GPR，不落入必需基因的支撑集），差异未实际生效 |
| M3-3 | **update 重写文件但逐行保留（坏行原样写回，不删行）** | 任务书"全部只读/追加/更新，不删行"+ 完整性要求；重写时先按行解析，解析失败的行原样保留 |
| M3-4 | **gem_report 增加 ledger_summary{total,by_status,by_type,corrupt_rows} + ledger_context 基率披露** | 基率披露措辞（zcode 建议稿，供裁决）："预测账本共 N 条（其中 M 条 unverified）：全部为模型推导预测（essentiality/phenotype 等），实验或文献兑现前不应当作事实引用；状态分布即预测可信度基率，回填后 by_status 向 literature_supported/experimentally_verified 迁移。" |
| M3-5 | **gem_ledger 与 gem_report 均支持 `ledger_path` 覆盖默认路径** | 任务书明确（测试用临时路径不必写用户目录）；生产默认路径不变 |

## M4 消费方升级（声明式，非自动区间化）

| # | 决策 | 依据 |
|---|---|---|
| M4-1 | **声明式升级而非自动区间化**：既有工具输出加 `units` + `point_value_note` 声明（指向 gem_fluxscan），而不把每个工具的内部计算改成区间制 | 任务书锁定"严格只增不改"；自动区间化会改变所有既有输出的形状/成本（FVA 是 pFBA 的 25 倍耗时），且各工具的定位（验证/补洞/必需性）本就不是条件对比。取舍：声明在输出侧、区间化集中在 fluxscan 一个工具 |
| M4-2 | 声明覆盖面：validate G3/G4 每行、l3_fix before/after/l3a/l3b、biomass apply 三联对照 growth、essentiality wt_growth 输出字段；tools.js 七个产出生长数值的工具 description 追加统一句 | 任务书 6 条清单 + "各工具 description"按产出生长数值者解释（validate/gapfind/build/phenotype/essentiality/l3_fix/biomass；新三工具 M1-M3 出生即带） |
| M4-3 | skill 硬规则 #6「通量区间制：无区间不点数」+ 决策树补 gem_fluxscan/gem_sensitivity/gem_ledger 三行 | 决策树此前 6/12 覆盖的选型断层教训（D2）；工具数增至 15 后决策树全量同步 |

## M5 iNX1344_v4 前哨（阶段 B 前哨，不做正式基准对比）

| # | 决策/发现 | 依据 |
|---|---|---|
| M5-1 | **路径确认**：`F:/A_NGJ plan/Zcode/models/` 下修复链 `iNX1344_fixed.xml → v2 → v3 → v4.xml`（终点 1.9MB）；原始发布 `iNX1344_raw/mpp13032-sup-0009-DataS1.xml` cobra 直接加载失败（CobraSBMLError） | 任务书要求先 ls 确认真实路径再引用 |
| M5-2 | **v4 状态**：1441 反应 / 1344 基因 / 1106 代谢物；MetaCyc 风格 `RnxatuXXXX`/`M00XXX_c` ID + Atu 基因座；objective=Rnxatu0132（52 组分 biomass，即 biomass 本体）；区室 c/e（名字为空）；756/1106 代谢物有名 | 任务书要求确认可加载/ID 体系/计数/biomass 状态 |
| M5-3 | **GAM 检测适配**：v4 的 GAM 载体实际在 biomass 内（ATP -25.633 / ADP+Pi+H+ 各 +24.78，GAM_ORIG=24.78），但 H2O（M00001_c）公式缺失 → 公式级检测漏判 → 误落独立载体分支且谷氨酰胺合成酶（含额外底物的 ATP 水解反应）误命中。修复：h2o 量级回退（与 GAM 净水电解量差 <5% 的未分类能量级组分补判）+ 独立载体判据收紧为"反应内全部代谢物均为能量 stub 角色"（纯 ATPM） | 适配进 `find_biomass_gam`（C58 锚点不受影响——其 h2o 公式命中）；两个误判模式都记档 |
| M5-4 | **核心发现：v4 交换层与介质机制不兼容**——全部 1441 反应 `Rnx` 前缀、无 EX_/DM_/SK_ 体系，交换由 161 个 boundary 单代谢物反应承担；`build_ex_index`（EX_ 前缀）索引为空 → 任何自然名/预设介质 0 解析 → 全交换清零后 growth 恒 0 | fluxscan AB vs M9 实测：两条件各 20 项全 unresolved、growth 0/0、pair 全 overlap（1441 行）。工具本身跑通无崩溃， medium 契约（EX_ 中心）是跨模型边界 |
| M5-5 | **根因诊断：v4 结构性不生长**——161 个 boundary 全开放（lb=-1000）FBA 仍为 0；逐组分 demand 探针定位 5 个不可净产的 biomass 组分：M02908_c / M01051_c / M00342_c(Sn-Glycero-3-phosphoethanolamine，脂质) / M00336_c / M00155_c（多为无名无公式代谢物，脂质/聚合物家族；与原始模型"脂质 μ_max=0"诊断一致） | 全 boundary 开放 + 逐组分 demand 可行性测试（work/m5_probe_inx4.py 可复核） |
| M5-6 | **必需性退化警示**：v4 essential_scan wt=0 → 1066/1066 候选全判"必需"（判定式 v<EPS 在 wt=0 时恒真）。sensitivity 增加 `baseline_growth_degenerate` 字段 + WARN：基准 wt≤0 时 essential 集无生物学意义，结果仅证明工具跑通 | 前哨发现的工具层固化：防止阶段 B 拿退化基线做对比 |
| M5-7 | **M5 定位 = 前哨不修复**：发现清单进阶段 B 建议（交换层规范化/5 组分补路径/ID 桥），不实现 | 任务书"范围外：正式 iNX1344 基准对比表"；避免在共享介质代码上做临时特化 |

## M6 基准与文档

| # | 决策 | 依据 |
|---|---|---|
| M6-1 | 性能基准表口径：stderr/日志分段计时 + 整段 wall time；同机独占运行（避免后台任务竞争 skew） | 见报告性能基准表 |
| M6-2 | 文档纪律校验以 grep 计数为准（ctx.tools.register / OPS 键 / 决策树覆盖 / README 工具表 / smoke 断言数） | 三轮验证方法论：文档计数漂移是常态，逐项点数核对 |
