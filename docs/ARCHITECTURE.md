# dsh-bio-galatea 架构（v0.1）

> G 系列第四员（genie / gem / graft / **galatea**）：蛋白质结构预测与设计域。
> 宿主 = dsh-bio-genie（同实例工具共存，无运行时依赖）；与 gem/graft 独立安装、独立发布、独立生命周期。

## 0. 定位与边界

**做什么**（本机 CPU / 小显存 GPU 可完成）：
- 序列设计（inverse folding）：ProteinMPNN / SolubleMPNN / LigandMPNN
- 单链结构预测：ESMFold（CPU/GPU 自适应）
- 复合物界面分析：接触 / 氢键 / 盐桥 / 埋藏 SASA / pLDDT 分带
- 多模型界面接触一致性：残基与 pair 频率、Jaccard 矩阵、设计 anchor（不参与 ranking）
- 序列理化打分、结构 QC（clash / pLDDT 分布）、候选聚类（多样性代表集）

**不做什么**（明确边界；报告时如实说明「需外部服务」，不伪装能力）：
- 复合物 co-folding（AF2 / AF3 / Boltz / Protenix——显存需求远超消费级）→ 外部（AlphaFold Server / PXDesign / ColabFold）
- 大显存 backbone 生成（RFdiffusion / BindCraft 类）→ 外部服务
- MSA 重型管线（ESMFold 单序列设计上与 MSA 无关，本插件不走该路径）

## 1. 双层结构

### src/（Cordis 插件半，随 dsh 主进程加载）

| 文件 | 职责 |
|---|---|
| `index.js` | 主模块：`inject=['tools','skills']`（仅必选）；`webServer` 走 apply 内动态注入（非 web 部署时工具照常注册） |
| `tools.js` | 19 语义化工具（`defineTool`）；**parameters/schema 是 agent 可见能力的唯一真相** |
| `capabilities.js` | `TOOLS_MANIFEST` 单源（工具清单 + cost_class/network/mutability 元数据），供 integration 与宿主消费 |
| `integration.js` | hosted-domain 集成协议 v1：`/health`、`/v1/status`、`/v1/capabilities`（loopback-only 三层守卫） |
| `python.js` | 解释器解析链 + `callGalatea`（JSON stdin 协议）+ `stampProvenance` |
| `skills.js` | `galatea-expert` skill 注册（ctx.skills.register） |

### python/（计算半，每次调用独立子进程）

| 文件 | 职责 |
|---|---|
| `galatea_ops.py` | 协议分发器（19 op）；三流 UTF-8；`_sanitize_json`；异常契约（结构化业务错误 + stderr Traceback 头） |
| `coverage_tools.py` | Campaign 覆盖审计与确定性 rescue 计划；只读取候选维度，不读取实验标签、不接入 loop/portfolio |
| `budget_tools.py` | 跨靶三层整数预算调度、pilot shrinkage 分类、cap feasibility 与原子化 handoff 四件套；不消费实验标签 |
| `components.py` | 组件探测（status）+ 零手动自举（setup：env / mpnn / esmfold，幂等） |
| `mpnn_design.py` | MPNN 包装：spawn vendor LigandMPNN `run.py` + 输出解析（seqs/*.fa） |
| `redesign_tools.py` | binder 区域/接触/SASA 计算、preset mask 生成与 MPNN 重设计编排 |
| `contact_tools.py` | 多模型重原子接触图、残基/pair 频率与 residue/edge Jaccard 矩阵；自动链角色归一到首个有效模型并返回映射；不计算排序分数 |
| `fold_esm.py` + `_fold_worker.py` | ESMFold 编排 + 推理 worker（模型加载隔离在一次性子进程） |
| `refold_tools.py` | ESMFold 单体复折叠、序列对齐 Cα RMSD/F2Å、pLDDT、phi/psi 二级结构指标 |
| `ingest_tools.py` | 本地结构/候选文件摄入、design_id 冲突处理与确定性 JSONL 台账写入 |
| `struct_analysis.py` | 界面分析（interface）+ 结构 QC（inspect）；biopython |
| `seq_analysis.py` | 序列理化打分（score）+ 聚类（cluster） |
| `seqio_lite.py` | FASTA 读写（最小实现） |
| `loop_tools.py` | 迭代战役记账与确定性计划：复用 rank 共识和序列聚类；不执行生成 |
| `portfolio_tools.py` | 三阶段约束贪心组合选择、coverage/cap 统计及原子化四件套输出；不读取实验标签 |

## 2. 数据目录（全部在插件私有空间）

```
~/.dsh/dsh-bio-galatea/
├── venv/                # 私有 Python 环境（uv 自举：torch CPU + transformers + biopython + prody）
├── vendor/LigandMPNN/   # LigandMPNN 代码（MIT；codeload tarball 获取）
├── models/
│   ├── mpnn/*.pt        # MPNN 权重（IPD 公开源；核心三件套）
│   └── esmfold/         # ESMFold 权重（HF facebook/esmfold_v1，约 2.5GB）
└── out/                 # 默认输出（可被工具 out_dir 参数覆盖）
```

## 3. 解释器解析链（python.js）

1. `GALATEA_PYTHON`（显式指定，最高优先级）
2. **私有 venv**（`~/.dsh/dsh-bio-galatea/venv`，推荐路径）
3. genie-hosted（`~/.dsh/dsh-bio-genie/python-env`，若含 torch 可复用）
4. `CONDA_PREFIX`（通用 conda 信号）
5. `python`（PATH 兜底）

选择标准 = 逐候选 `import torch` 成功（每候选 30 秒超时）。首次工具调用才启动异步单飞探测；
本次调用立即返回 `PYTHON_PROBE_PENDING`，稍后重试。选中解释器后进程内缓存，后续调用同步读取；
全部候选失败时计算工具返回 `PYTHON_TORCH_MISSING`、`missing_dependencies` 和 `install_hint`。
`galatea_status` / `galatea_setup` 仍可沿原有 PATH Python 兜底诊断、安装；`setup` 成功后缓存失效，
下一次调用重新探测。外部手动安装或环境变量变化后需重启 dsh 才能清除进程内缺失缓存。
插件加载期不启动此探测。

## 4. 工具 / op 对照（19 工具 = 19 op）

| 工具 | op | capability | 说明 |
|---|---|---|---|
| `galatea_status` | status | system | 运行时状态（解释器/组件/设备） |
| `galatea_setup` | setup | system | 零手动自举（env/mpnn/esmfold/all，幂等） |
| `galatea_mpnn` | mpnn | design | 序列设计（ProteinMPNN/SolubleMPNN/LigandMPNN） |
| `galatea_fold` | fold | predict | 单链折叠（ESMFold） |
| `galatea_interface` | interface | screening | 复合物界面分析 |
| `galatea_score` | score | screening | 序列理化打分 |
| `galatea_inspect` | inspect | analysis | 结构 QC |
| `galatea_cluster` | cluster | analysis | 候选聚类 |
| `galatea_rank` | rank.consensus | screening | 候选共识排序（等权共识 + 分档 strong≥0.73） |
| `galatea_rank_aggregate` | rank.aggregate | screening | 多批次聚合 → 全局排名 CSV |
| `galatea_loop` | loop | design | 多轮设计战役记账、父本筛选、停止建议与下一轮计划；不执行生成 |
| `galatea_contact_consensus` | contact_consensus | design | 多模型接触频率与 Jaccard 矩阵、anchor；只作设计控制信号 |
| `galatea_contact_cluster` | contact_cluster | design | target-side footprint Jaccard + 频率向量 cosine 单链接聚类；跨 target 不比较 |
| `galatea_redesign` | redesign | design | 区域约束式 MPNN 重设计（contact/anchor/双 shell/CORE/BOUNDARY/SURFACE masks） |
| `galatea_refold` | refold | qc | binder 单体复折叠救援检查（RMSD/F2Å/pLDDT/二级结构；阈值未校准） |
| `galatea_ingest` | ingest | design | 摄入本地多源候选并写入统一 JSONL 台账；以 target_id + design_id 标识记录、结构带哈希与 role、分数 schema 写 sidecar、只解析显式 parent_id |
| `galatea_portfolio` | portfolio | design | 资格过滤 → 靶点覆盖 floor → 共识百分位全局竞争；约束配置化并输出 selected/rejected/summary/manifest |
| `galatea_budget` | budget | design | 跨靶 floor/exploit/reserve 整数配额、密度门与 cap feasibility；输出 handoff，不接消费 |
| `galatea_coverage` | coverage | design | Campaign 覆盖审计：generator/contact/backbone family、未消费 generator 与 quota；可输出确定性 rescue 计划 |

## 5. 集成协议（宿主消费，v1 只读）

- 端点：`GET /api/dsh-bio-galatea/integration/health`、`/v1/status`、`/v1/capabilities`；信封 `{ok:true,value}` / `{ok:false,code,message}`。
- checks（状态判定项）：`python.torch` / `runtime.analysis` / `runtime.mpnn` / `runtime.esmfold`。
- 五态模型沿用 genie 契约 v2（not-installed / legacy / installed-unavailable / incompatible / degraded / ready）。
- 慢探测非阻塞（stale-while-revalidate + 60s 缓存）；`health` 零副作用。

## 6. 纪律

- **超时双保险**：TS 层 `timeoutMs` > Python 内部子进程超时（Python 先返回结构化错误，TS 不会盲目杀进程）。
- **数字可溯源**：工具输出经 `stampProvenance` 盖 `_provenance`；无工具输出的数字不得写入结论。
- **长任务**：`setup(esmfold)`（约 2.5GB）与 `fold`（CPU 分钟级/条）单次调用耐心等待；**勿重复调用**。
- **测试门**：`check-capabilities.mjs`（工具清单一致）+ `check-counts.mjs`（文档计数）+ `smoke.js`（op/注册）+ `integration.js`（协议 mock）。
