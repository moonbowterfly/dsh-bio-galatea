# DECISIONS — 2026-09-21 升级批次（外部评审裁决后 Phase 1）

> 本批决策依据：`D:\Program\dsh-plug-develop\21-gem升级-裁决与实施方案.md`（GPT/DS 双评审 + 本机 8 项实测核验）。
> 记录本批次的**语义演进与架构决策**，供下游与后续批次参考。

## D1. growth 单位演进：mmol/gDW/h → 1/h（数值不变）

**决策**：growth / growth_rate / wt_growth / before-after 生长 等**比生长量**字段的单位标注由
`mmol/gDW/h` 改为 `1/h`；反应通量类保持 `mmol/gDW/h`。

**依据**（实测 + 社区约定）：
- C58 的 bio1（Bacterial Gram-negative biomass reaction）产物系数 = 1.0 —— biomass 反应已按
  **1 gDW 归一化**；此时其通量数值 = 比生长速率 μ（h⁻¹），这是 COBRA 社区的标准解读
  （biomass flux through a normalized biomass reaction equals the specific growth rate）。
- 外部评审（GPT）指出原标注 `mmol/gDW/h` 对 biomass 反应在语义上不准确 → 列为 P0。
- straindesign 官方文档同样以 `growth rates above 0.5/h` 表述（旁证）。

**边界**：对**未归一化**的 biomass 反应（产物系数 ≠ 1）growth 应以 mmol/gDW/h 解读——见
validate 的 units.note 表述。数值本身在任何情况下不变，本决策只纠标注。

**影响面**：python/ 12 个模块（23 处）+ src/tools.js（16 处口径文案统一）+ 本文档；
`model_card.GROWTH_UNITS` 同步演进（旧卡兼容：growth_units 字段照读，数值口径不变）。

## D2. 能力单源（capabilities.json → /v1/capabilities → 宿主动态消费）

**决策**：工具清单与能力元数据（cost_class / network / mutability / requires）以
`src/capabilities.js` 的 `TOOLS_MANIFEST` 为**唯一事实源**：
- integration API 新增 `GET /v1/capabilities`（features 声明 `capabilities`）；
- 宿主 dsh-bio-genie 的 `handleDomainRequest` 在对方声明该 feature 时拉取并透传
  （失败静默降级到静态清单 `GEM_TOOLS`——它已降级为 fallback 视图）；
- 机器门：`test/check-capabilities.mjs`（manifest ↔ 真实注册一致）+
  `test/check-counts.mjs`（文档计数 ↔ manifest 一致）。

**背景**：原「工具数变化需同步 ≥12 处」是两评审共同指出的工程债；本决策把它变成
「单源 + 两道机器门」，文档数字仍手写但有门兜底。

## D3. CarveMe 零手动部署（bootstrap_carveme.py）

**决策**：`gem_build(engine=carveme)` 首次调用自动完成运行时部署（幂等）：
uv venv（uv 探测链：`GEM_UV` → genie 自举 uv → PATH）→ `uv pip install carveme` →
下载 GitHub 官方 diamond 二进制（**固定 v2.2.8**，3.4MB）→ deep smoke → manifest 记录。

**关键设计**：
- **快速路径**：`carve.exe + diamond.exe + manifest.json` 齐备时秒过（实测 0.34s，不做子进程冒烟）；
- 部署与复验才做 deep smoke（实测全量部署 45s：venv 31s + diamond 下载数秒 + 冒烟）；
- 下载通道：直连 → 环境代理（HTTPS_PROXY/HTTP_PROXY）→ 失败给可执行指引（含手动放置路径）；
- 这就是 P0「装完插件 ≠ 构建可用」的根治：契约要求用户零手动安装。

## D4. gem_sample 的边界设计（全空间 vs 受限）

**决策**：默认采样**全 feasible space**（ACHR），但 `boundary` 字段**强制输出**边界声明；
近最优生长状态必须显式传 `growth_floor_fraction`（如 0.9）。

**依据**（本机实测）：C58 全空间采样 bio1 max ≈ 0.017 vs FBA 最优 0.7134（差 2 个数量级）——
全空间均匀分布 ≠ 生物学上有意义的活跃状态；不声明边界就是「做了但没用」的典型。

**Windows 约束**：默认 ACHR（无多进程依赖，实测 init ~172s、采样秒级）；OptGP 在 Windows
下实验性——不可用时**显式安全拒绝**（不触发多进程陷阱）。

## D5. quality_index（gem-qi-v1）不是 MEMOTE 分数

**决策**：`gem_quality` 输出 `quality_index`（0-100 启发式聚合）+ 分项 raw_metrics +
failed_checks + not_assessable_checks；**禁止**作为单一质量结论引用（notes 内置声明）。

**依据**：两评审共识——MEMOTE 的价值在其可分解测试体系；聚合分容易被误用。
评分规则（写死在 `python/quality.py` 常量）：见 WEIGHTS / 阈值常量与 note 输出。
**不安装 MEMOTE 整体**（PyPI 0.17.0 仅声明兼容到 Py3.11；本机 Py3.13 风险）。

## D6. 本批新增工具（2）

| 工具 | capability | cost_class | 说明 |
|---|---|---|---|
| `gem_quality` | `gem.validate.quality-report` | medium | 质量审计（blocked/环路/平衡/孤儿/覆盖/连通性）|
| `gem_sample` | `gem.analysis.sampling` | heavy | 通量空间采样（ACHR/OptGP；边界声明）|

工具数 21 → 23；op 数 21 → 23。两门（check-capabilities / check-counts）同步更新。
