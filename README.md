# dsh-bio-galatea（G 系列 · 蛋白质结构预测与设计）

> **给 dsh / dsh-bio-genie 装上「蛋白质设计工具箱」**——本机即可完成序列设计、单链折叠验证、界面筛选与多样性选择；
> 零手动安装（私有 venv 一键自举），CPU / 小显存 GPU 自适应。

**Galatea**（伽拉忒亚）：希腊神话中被赋予生命的雕像——献给「从结构到序列」的蛋白质创造过程。

## 它解决什么问题

蛋白质设计（binder / 酶 / 纳米抗体）的标准流程散布在十几个工具里：设计序列要 ProteinMPNN、
验证折叠要 ESMFold、筛选结合要界面分析、选候选要聚类。本插件把它们收拢为 **8 个语义化工具**，
让 dsh 里的 agent（及 genie 宿主）直接调用——并**明确标注本机边界**（co-folding 等重算力环节
诚实指向外部服务，不伪装能力）。

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
```

## 8 个工具一览

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
Eight semantic tools — sequence design (ProteinMPNN/SolubleMPNN/LigandMPNN), single-chain folding
(ESMFold, CPU/GPU adaptive), complex-interface analysis, sequence scoring, structure QC, and
diversity clustering — with zero-manual-setup (private venv auto-bootstrap) and honest capability
boundaries (heavy co-folding stays with external services). Designed to coexist with
dsh-bio-genie (`bio_*` tools) in the same dsh instance.

```bash
dsh plugin add @dsh-bio/dsh-bio-galatea
```
