# dsh-bio-gem — 架构文档（M1 定稿 2026-08-29）

## 1. 定位一句话

dsh 平台的 **GEM 构建侧插件**：输入细菌全基因组（支持多质粒/多染色体），自动构建→验证→补洞→出报告（标准 SBML + 模型卡），产出后可被 dsh-bio-genie 现有消费工具（FBA/必需性/生产包络线/模型面板）直接加载使用。

硬性原则（沿袭 bio-genie）：**用户零手动安装、零自愈、通用化（不可本机特化）、结论可溯源**。

## 2. 决策记录（为什么这么设计）

| 日期 | 决策 | 依据 |
|---|---|---|
| 08-28 | 插件名 dsh-bio-gem；资产盘点：消费侧已就绪、补构建侧闭环 | 用户拍板 |
| 08-29 | 引擎路线：**任务门槛路由**（不是简单 auto）；落地节奏 **M1 CarveMe+补洞 → M2 gapseq WSL 桥 → M3 双引擎交叉** | 第三方 GLM 独立评估 + 本机实测（CarveMe AB 不生长=补洞是生存线；WSL 桥显著降级交付风险；Docker 非 WSL 替代）|
| 08-29 | MVP 工具集：gem_build / gem_validate（G1G2G3 必做，G4 条件、G5 抽检）/ gem_gapfind（L1L2L3）/ gem_gapfill（L1L2 规则自动）/ gem_report（薄版模型卡）；**gem_essentiality 不进首版** | 消费侧 bio_gene_knockout 已存在，避免重复实现 |
| 08-29 | 修正 GLM 建议：弃 μ 判据用 FBA 通量判据；pyrodigal 注释前端降 backlog；测试矩阵首版收敛 C58+2 公开株 | 本机输出口径为 objective_value；默认输入是带注释基因组 |

**裁决原则**：GLM 分析质量高但缺本机上下文（输出单位、输入形态、部署面=本机为主的现实），凡冲突处以本机实测与产品原则为准。

## 3. 工具契约（21 工具 ↔ Python 层；21 op + build CLI）

| 工具 | Python 层 | 阶段 |
|---|---|---|
| gem_build | build.py CLI（CarveMe M9 gapfill；fna 自动注释）| ✅ M1+模块 DONE（C58 63-70s）|
| gem_validate | op validate（G1-G6 + GATE_REGISTRY）| ✅ M1 DONE |
| gem_gapfind | op gapfind（L1-L3 分级 + 跨引擎介质归一化）| ✅ M1 DONE |
| gem_gapfill | op gapfill（L1/L2 规则 + provenance）| ✅ M1 DONE |
| gem_phenotype | op phenotype_fix（表型回填迭代）| ✅ A3 DONE |
| gem_essentiality | op essential_scan（FVA 预筛 + 手工敲除；预测自动入账本）| ✅ P0 DONE |
| gem_annotate | op annotate（官方优先 + pyrodigal）| ✅ P0 DONE |
| gem_gapseq | op gapseq（WSL 原子四步，可选项）| ✅ 桥全通 |
| gem_l3_fix | op l3_fix（L3 补洞：L3a 连通性 + L3b 白名单/BiGG；证据分级 + 预算闸门 + G6 回滚）| ✅ B' DONE（C58 Arabinose 0→0.851）|
| gem_report | op model_info（+ ledger_summary 基率摘要）| ✅ DONE |
| gem_media_resolve | op media_resolve（介质解析 RPC，消费侧统一入口）| ✅ DONE |
| gem_biomass | op biomass_inspect / biomass_apply（inspect 组分+对照参考；apply 覆盖表+三联对照+原文件不动回滚）| ✅ Q2 DONE（复位 delta 0.0）|
| gem_fluxscan | op fluxscan（通量区间制：FVA 区间+pFBA 点值+条件对区间分离判定，overlap=伪影禁止引用）| ✅ 阶段A-M1 DONE（C58 AB 0.519981 / 蔗糖 supplement 0.97077）|
| gem_sensitivity | op sensitivity（GAM×biomass 22 组合全量+稳定性三分类+单组分漂移；模型卡 robustness v3）| ✅ 阶段A-M2 DONE（基准复现 155）|
| gem_ledger | op ledger（prediction ledger：list/query/update；幂等追加式账本）| ✅ 阶段A-M3 DONE（C58 155+19 条幂等复跑）|
| gem_benchmark | op benchmark（通用基准对比：六关并列/生长[介质层两级策略]/biomass 探针/必需性对比含退化护栏/表型/账本回填/md 落盘；model 参数支持 bigg:&lt;id&gt; 下载）| ✅ 阶段B-B1/B2/B3 DONE |
| gem_secretion | op secretion（可分泌谱：production envelope；边界声明内置；wt<=EPS 退化护栏不登记）| ✅ 阶段C-C1 DONE（C58 85 可分泌）|
| gem_double_knockout | op double_knockout（双敲 v1：GPR 穷尽先验+全扫 max_pairs 预算；假设声明内置）| ✅ 阶段C-C2 DONE（Atu3364↔Atu4682 对应命中）|
| gem_enrichment | op enrichment（必需基因通路富集：超几何+BH FDR；无注释 annotation_unavailable 兜底）| ✅ 阶段C-C3 DONE（C58 55 条 FDR 显著）|
| gem_targets | op targets（靶点规范导出：11 字段锁定 schema；账本计数闭合；引物设计不做）| ✅ 阶段C-C4 DONE（258 行三类闭合）|
| gem_precursor_scan | op precursor_scan（阻塞前体分析：基线通量→可生长即返「无阻塞」；不生长则逐前体移除测试定位阻塞点）| ✅ 2026-09-11（E2E 绕道归因产出）|

> Python 分发器 `gem_ops.py` 共 **23 个 op**（annotate/benchmark/biomass_apply/biomass_inspect/double_knockout/enrichment/essential_scan/fluxscan/gapfill/gapfind/gapseq/l3_fix/ledger/media_resolve/model_info/phenotype_fix/precursor_scan/quality/sample/secretion/sensitivity/targets/validate）；`gem_build` 不经分发器，由 `build.py` CLI 直接调用（长任务，jobs.js 拉起）。
>
> **工具数（23）与 op 数（23）的关系**：不等且不是简单的 +1 —— `gem_biomass` 一个工具映射 `biomass_inspect` / `biomass_apply` 两个 op（工具 −1），而 `gem_build` 走 CLI 不占 op（工具 +1），两项相抵故数值相同。核验口径：`len(gem_ops.OPS)` 与 `grep -c 'ctx.tools.register(' src/tools.js`。

> **precursor_scan 的判据取舍（勿回退）**：初版曾用「全开交换下逐前体 demand 能否净生产」的**绝对可达性**判据，在教科书模型 e_coli_core 上把 atp_c/accoa_c/nad_c/nadph_c 误报为「结构缺失」（辅因子有循环补给路径，稳态下不净生产 ≠ 网络不能供给），故否决。现行判据为**相对判断**：先测基线通量，可生长即直接返回「无阻塞」；不生长才逐前体做移除测试，由「移除后是否恢复通量」直接定义阻塞点。验证锚：toy 单点阻塞模型（精确命中）、e_coli_core（growable，零误报）、iNX1344_v3（infeasible_or_constrained，与 agent 手工探索结论一致）。

> 其余工具层约定：附模型卡统一写入 `python/model_card.py`（lineage/verified_phenotypes/essential_genes/robustness v3）与往返保真自检 `python/roundtrip_check.py`；预测账本 `python/ledger.py`（一个模型一个账本：`~/.dsh/dsh-bio-gem/ledger/<模型名>.jsonl`，按模型 basename 分，显式 ledger_path 可覆盖；无参查询=聚合全局视图；旧全局 predictions.jsonl 已迁移为 legacy）。**生长/通量数值口径（阶段A-M4）**：所有产出生长/通量数值的工具输出均带 `units: mmol/gDW/h` 与单点 FBA 声明；条件间通量对比一律走 gem_fluxscan 区间分离判定（overlap=伪影禁止引用）。

## 4. 引擎路线（M1→M2→M3）

- **M1（已完成 08-29，C58 实测）**：CarveMe 纯 Windows（独立 venv ~/.dsh/dsh-bio-gem/venv-carveme + diamond PATH 注入）。输入（protein.faa）→ carve -g M9（54s）→ 精确 M9 介质（media_db 提取）G3 PASS（C58 测 0.782）→ 用户目标介质 resolve（跨引擎自然名）→ G3 FAIL 时 L1/L2 规则补洞 → 模型卡。**CarveMe 模型实测：M9 可生长；AB 目标介质 FAIL 且为 L3 内部路径（L1/L2 规则不可修）——诚实报告为已知边界（研究设计既有结论：CarveMe M9 补洞局限）。**
- **M2（2026-08-29 代码完成，doall 实测进行中）**：gapseq WSL2 桥（`python/gapseq_wsl.py`）。能力探测四件套（wsl/发行版/gapseq 版本/序列库注册 up-to-date——防假已装 UniProt 灾难）；新版 wsl.exe 输出 UTF-8（旧版 UTF-16LE，双解码兼容）；doall 哨兵文件轮询（30-60min，每 2min 进度 + 日志尾部旁观）；产物拷回 → 目标介质验证（AB 自然名）→ L1/L2 补洞闭环 → 模型卡。gem_build `engine` 参数（carveme|gapseq）+ 60min 超时。分发时采用**私有发行版**（wsl --import 自包含 bundle：R+gapseq+序列库 v1.5+哈希校验，版本钉死）。任务分步化（draft/build/transport/fill/adjust 每步落盘 → 断点续跑）待做。
- **M3**：双引擎交叉验证，产出**分歧清单**（两引擎不一致反应/基因 = 低置信区，需文献/实验校验）而非平均；可选集成 gemsembler（先验证成熟度）；所有比对按**反应级等价类**而非基因级（引擎 GPR 粒度不同）。

## 5. 验证关卡规格（HANDOFF-03 产品化 + G0）

| 关卡 | 内容 | 首版 | 判定线 |
|---|---|---|---|
| **G0** | **模型数据质量前置诊断**（`python/coherence.py`）：id 体系识别 + biomass 未映射前体 + 方向异常 | ✅ 2026-09-11 | 有未映射前体 → WARN（提示下游结论不可靠）；产物侧出现 ATP → FAIL |
| G1 | 加载统计 + 多复制子 locus_tag 唯一性 + GPR 覆盖 | ✅ | 可加载；无重复 ID；GPR 覆盖率报告 |
| G2 | 内部反应元素平衡（EX/DM/SK/boundary 排除）| ✅ | C/N/P/S 不平衡=0（FAIL/WARN），H/charge 单独报告；**公式覆盖率是 PASS 的作用域上界**——覆盖率 <90% 时即便被检查部分全平衡也降级 WARN 并给出 `coverage_scope_note`（2026-09-11 修：agent 实测发现覆盖率 68.35% 却判 PASS 是假阳性）|
| G3 | 生长真实性（声明培养基）| ✅ | 有碳源 objective_value>0；无碳 <1e-6；全关=0；与参照值比值≥99% 判 PASS |
| G4 | 底物表型对照 | 条件 | 有参照表才跑（内置 C58 39 底物作回归锚），不设阻塞阈值 |
| G5 | 必需基因抽检（≤30 基因）| 条件 | 有参照集才跑；映射覆盖 <80% 时 SKIP(WARN) |
| G6 | ATP 泄漏检测（全关交换后 ATP demand 应≈0）| ✅ | leak ≤0.01 判 PASS；ATP 解析走 id→name→formula 三级回退（跨 ID 体系）|

**G0 的由来（2026-09-10 E2E 实测）**：MetaCyc 风格 id 的公开模型（iNX1344_v3）上，
`gem_gapfind` 报 5 个 L3「内部通路缺口」，实为 biomass 前体未映射所致——agent 为逐个
证伪手写 cobra 代码 18 次。现 `gem_validate` 在 G1 之前输出 `g0`，`gem_gapfind` 返回
`coherence_warning` + `interpretation_guard`，把该结论前置给 agent。

> ⚠️ **G0 判据的取舍（勿回退）**：曾试过「biomass 元素配平」与「前体可达性（demand 逐前体
> FBA）」两条判据，均在教科书模型 e_coli_core 上误报（把它判 FAIL、把 atp_c/accoa_c 报成
> 「结构缺失」）故被否决——标准 biomass 方程代表大分子聚合，本就不配平。保留判据的标准是
> 「问题模型报出真问题 + 标准模型零误报」双向通过。

关卡 fail-fast 排序 G0→G1→G3→G2（便宜的先行）；gem_validate 保持**无状态**，同 run 可双跑（补洞前后 diff 写进模型卡）。

**判据口径**：FBA objective_value（mmol/gDW/h），不用 μ（h⁻¹）——模型输出单位即通量；C58 回归锚：gapseq AB=0.519981；补洞后 CarveMe 目标 ≥0.1 为软目标。

## 6. 缺口分级（gapfind/gapfill）

- **L1 缺交换**：培养基成分表 vs 模型 EX_ 列表的集合差 → 修复=补 EX_ 反应（完善环境定义，最安全）
- **L2 缺转运**：e0↔c0 区室连通性（代谢物在胞外存在但无转运反应入胞）→ 修复=补转运（GPR 可空，标注未表征）
- **L3 内部路径**：底物有交换+转运却无法达中心代谢 → 需文献反应（M1 报告清单，不自动补）

已知规律（P1 实测）：多数"不能利用某碳源"缺口是 L1/L2 而非 L3。
**2026-09-11 补充**：L3 清单须与 G0 一起解读——模型数据质量有问题时 L3 多为症状
（`find_gaps` 返回值已内置 `coherence_warning` 与 `interpretation_guard`）。

**防过补四闸门**：分级规则优先于 MILP（M1 不做 MILP）；新增反应数封顶（max_add=20）；逐条 provenance 打标（来源/原因/是否借自模板）；修复后强制重验 G3 + 生长值合理性上限告警（>1.0 时 WARN 过补嫌疑）。

## 7. 模型卡（sidecar JSON，与 SBML 同目录同名 .card.json）

```
{ engine, engine_version, db_version, command, started, finished,
  memote_like: {g1..g5}, gapfixes: [{type, reaction, reason, source}],
  growth: {medium, before, after}, mapping_coverage,
  replicons, warnings }
```
写盘用 cobra.io.write_sbml_model（cobra 0.32.1 无 Model.save_model——坑位记档）。

## 8. 后台任务（M1 基建，约 30% 工程量）

job 化 + 进度事件（粒度 ≤5s）+ 分步 checkpoint（每步落盘，可断点续跑）+ 结果可重入。引擎无关，M2 gapseq 直接复用。

## 9. 与 bio-genie 衔接

- 产出 SBML 落 `~/.dsh/dsh-bio-gem/models/<name>.xml`；模型卡同目录；
- 协议版 gem 的运行时状态由 gem 自己的 integration API 作为唯一事实源；BioGenie 不再并行直读 models/ledger/exports。仅 `legacy`（gem < 0.1.11）兼容视图允许文件系统摘要兜底，且必须标明只读。

### 9.1 托管领域扩展 integration v1（v0.1.11+）

- 固定 GET 端点：`/api/dsh-bio-gem/integration/health`（身份/协议协商，零 Python spawn、零写盘）和 `/api/dsh-bio-gem/integration/v1/status`（状态快照）。两者均用 `{ok,value}` / `{ok:false,code,message}` 信封。
- status 的唯一状态是 `ready` 或 `degraded`；三个稳定检查 ID 为 `python.cobra`、`runtime.carveme`、`runtime.gapseq`。模型、账本、导出仅返回摘要与最多 50 条条目。Python/cobra 维持 60 秒短缓存；WSL/gapseq 是非阻塞 stale-while-revalidate：首次以 `available: null`、`probing: true` 和 check=`warn` 表示后台探测中，缓存过期时先返回旧值并刷新，成功缓存 5 分钟、失败或超时最多缓存 60 秒后自动重试。
- 所有路由使用与 BioGenie 相同的 socket/Host/sec-fetch-site/Origin 四层 loopback 守卫。回传不包含 token、任意命令、任意 URL 或完整日志；remediation 仅为受控 `code` + `owner`，其中共享 WSL/gapseq 的 owner 是 genie、CarveMe 私有运行时的 owner 是 gem。
- 静态 Cordis `inject` 只声明 `tools`、`skills`；`webServer` 通过 `ctx.inject(['webServer'], cb)` 动态等待。无 webServer 时仍照常注册 23 个 `gem_*` 工具和 gem-expert skill；服务出现后才注册两条路由，并在约 8 秒后后台预热一次 status 缓存。gapseq 先做 `wsl.exe -l -q` 发行版预检，再用固定只读版本命令；子进程 stdin 使用 pipe 并立即关闭，避免 WSL 因 `stdin=ignore` 慢启动。gem 不注册浏览器设置入口，一级入口和五态 UI 由 BioGenie 唯一拥有。
- 本批严格只读：不实现 job API、安装/删除、配置 schema、自动修复或跨插件命令执行。

## 10. 验收（M1 最小可用判定线）

零手动干预下：**基因组进 → 四个消费工具（FBA/必需性/包络线/面板）不经修改即可用的 SBML 出**，且模型在声明培养基上生长为正；C58 端到端演示通过（build→面板可见→FBA 可跑→必需性可跑）；模型卡齐全（引擎/版本/补洞记录/验证结果，同输入重跑一致）；5-6 Mb 基因组 p95 ≤ 20 min。

## 附录 A：性能基准（阶段 A-M6，2026-08-30 本机实测，独占运行）

分析 Python 3.13.13 / cobra 0.32.1 / GLPK；C58=gapseq 2485 反应/1084 基因；iNX1344_v4=1441 反应/1344 基因。

| 项目 | C58 | iNX1344_v4 |
|---|---|---|
| model_info（读模+摘要） | 6.6s | 3.7s |
| validate G1-G6 | 7.9s（G3 PASS 0.519981） | 3.7s（G3 WARN，介质层不兼容见 M5） |
| essential_scan 全量（FVA 预筛+手工敲除） | ~50s（FVA 32.3s + 敲除 16.8s，818 候选） | ~30s（FVA 11.9s + 敲除 16.8s，1066 候选） |
| fluxscan 1 条件（读模+FBA+FVA+pFBA） | ~31s（FVA 24-42s 为主） | ~14s（FVA ~12s） |
| fluxscan 2 条件 1 对 | 63-72s | 28.5s |
| fluxscan 3 条件 3 对 | 123.3s | 未跑（介质层不兼容，点值无意义） |
| sensitivity 22 组合全量（每组合 wt+必需性重扫） | 2094.8s（~35min；grid 22×~95s） | 732.0s（~12min；grid 689s） |
| 单组分 ±25% 灵敏度 | 75 组分×2=150 次 FBA，54.4s | 47 组分×2=94 次 FBA，7.9s |
| 必需性漂移 top10（含生长探针） | 522.0s（含 7 刚性对跳过探针） | 33.8s（20/20 全部"不生长跳过"） |

> 注：FVA 占单条件耗时 ~75%；sensitivity 线性于组合数（每组合 fresh 读模+FVA+敲除循环）。GLPK 对个别扰动 LP 有病态停摆前科，sensitivity 内置 LP_TIMEOUT_S=30 护栏（见 docs/DECISIONS-阶段A.md M2-5）。
