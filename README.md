# dsh-bio-gem

**基因组尺度代谢模型（GEM）构建插件**：输入细菌全基因组（支持多质粒/多染色体），自动构建 → 验证 → 补洞 → 出报告（标准 SBML + 模型卡），产出后可由 dsh-bio-genie 现有消费工具（FBA / 基因必需性 / 生产包络线 / 模型管理面板）直接加载使用。

Genome-scale metabolic model builder for dsh: genome in, validated SBML out.

## 📦 安装

本插件已发布为 npm 包 **`@dsh-bio/dsh-bio-gem`**（纯 ESM，无构建步骤），也可直接从 GitHub 源或本地目录安装。

### 0. 环境要求

| 组件 | 要求 | 用途 |
|------|------|------|
| dsh 引擎 | 0.1.x（`npx -y @deepseek-ai/dsh --version` 可查） | 宿主 |
| Node.js | ≥ 22.19 或 ≥ 24（见 `package.json` 的 `engines`） | 宿主 |
| Python | 3.10+，且装 **`cobra`** | 分析/验证/补洞/账本/基准/导出 —— 除 `gem_build` 外的 22 个工具 |
| `pyrodigal` | 装在同一个 Python 环境（可选但建议） | 裸基因组自动注释兜底（`gem_annotate` / fna 输入） |
| **CarveMe** | 独立 venv `~/.dsh/dsh-bio-gem/venv-carveme`，含 `carve.exe` + **`diamond.exe`** | `gem_build`（carveme 引擎） |
| WSL2 + gapseq | 可选，按本机拓扑（见第 4 节） | `gem_build`（gapseq 引擎） |

> **Python 环境从哪来（v0.1.4 起）**：解释器探测顺序为
> `GEM_PYTHON` → **宿主 `dsh-bio-genie` 的自举环境** → `CONDA_PREFIX` → `PATH` 中的 `python`，
> 且会**逐个探测该解释器能否 `import cobra`**（不盲选）。
>
> 因此：**装了 dsh-bio-genie 就无需任何额外配置** —— genie 的自举环境自带 cobra
> （属它的第一层依赖），gem 直接复用。只有**未装 genie** 时才需要按第 2 步自备解释器。
>
> `gem_build`（构建侧）另有重依赖（CarveMe + `diamond`，或 WSL2 + gapseq），见第 3、4 步，
> 这部分不与 genie 共享环境。

### 1. 安装插件

```sh
# 方式一：从 npm 安装（推荐，已发布预置包）
npx -y @deepseek-ai/dsh plugin --profile web add @dsh-bio/dsh-bio-gem

# 方式二：从 GitHub 安装（拉源码；本插件纯 ESM 无构建步骤，可直接加载）
npx -y @deepseek-ai/dsh plugin --profile web add github:moonbowterfly/dsh-bio-gem

# 方式三：从本地目录安装（开发调试）
npx -y @deepseek-ai/dsh plugin --profile web add ./dsh-bio-gem
```

- 本机若已全局安装 dsh CLI，把 `npx -y @deepseek-ai/dsh` 换成 `dsh` 即可。
- `--profile <name>` 是**必填选项**（不传报 `required option '--profile <name>' not specified`）；Web 端固定用 `web`。
- 安装完**重启 dsh web 服务**（关掉原窗口，重新双击启动入口）。
- **引擎兼容（2026-09-19）**：经 dsh **0.1.5-rc.2** 走廊逐卡走查（v0.1.3-alpha.2 → 0.1.5-rc.2 共 55 张变更卡核对：零适配命中）与实机验证（工具注册 / 代谢建模面板 / 账本与模型数据）。
- 版本刚发布时可能短时间拉不到：registry 首次分发有几分钟延迟，`pnpm` 还可能缓存住 404。遇到 `ERR_PNPM_FETCH_404 ... is not in the npm registry` 时等几分钟重试，或在命令末尾追加 `--registry https://registry.npmjs.org/` 绕过缓存。

验证插件层已生效（不用启动服务）：

```sh
npx -y @deepseek-ai/dsh --profile web --dump-config | grep dsh-bio-gem
```

### 2. 准备分析用 Python（cobra）—— 装了 genie 就跳过

**已安装 `@dsh-bio/dsh-bio-genie` 时本节可跳过**：gem 自动复用 genie 的自举环境
（`$DSH_HOME/dsh-bio-genie/python-env`），其中 cobra 属 genie 的第一层依赖，无需任何配置。

未装 genie 时，自备一个装了 cobra 的解释器：

```sh
# uv 建独立 venv 并安装（推荐）
uv venv --python 3.11 "$HOME/.dsh/dsh-bio-gem/venv"
uv pip install --python "$HOME/.dsh/dsh-bio-gem/venv/Scripts/python.exe" cobra pyrodigal
```

用 `GEM_PYTHON` 指向它（**dsh 进程的环境变量，必须在启动 dsh 之前设置**）：

```bat
:: cmd（写进启动脚本即可）
set GEM_PYTHON=%USERPROFILE%\.dsh\dsh-bio-gem\venv\Scripts\python.exe
```

```powershell
# PowerShell：永久（对之后新开的终端与快捷方式生效）
setx GEM_PYTHON "$env:USERPROFILE\.dsh\dsh-bio-gem\venv\Scripts\python.exe"

# 或临时（仅当前窗口）
$env:GEM_PYTHON = "$env:USERPROFILE\.dsh\dsh-bio-gem\venv\Scripts\python.exe"
```

> 插件**不会盲选**解释器：它按上述顺序逐个探测 `import cobra`，选中第一个可用的并缓存。
> 若候选全都不含 cobra，工具会显式报 `ModuleNotFoundError: cobra` 并附带候选探测结果，
> 而不是静默落到一个不可用的解释器上。

### 3. 准备 CarveMe（构建引擎）

```sh
# ① 独立 venv（勿并入系统 Python，也不要并入 dsh-bio-genie 的环境）
uv venv --python 3.11 "$HOME/.dsh/dsh-bio-gem/venv-carveme"
uv pip install --python "$HOME/.dsh/dsh-bio-gem/venv-carveme/Scripts/python.exe" carveme

# ② diamond 是 CarveMe 的外部分比对引擎，不在 Python 包里，必须单独放进来
curl -L -o diamond.zip https://github.com/bbuchfink/diamond/releases/latest/download/diamond-windows.zip
unzip -o diamond.zip diamond.exe -d "$HOME/.dsh/dsh-bio-gem/venv-carveme/Scripts/"

# ③ 验证（两个可执行文件应同在 venv 的 Scripts/ 下）
"$HOME/.dsh/dsh-bio-gem/venv-carveme/Scripts/carve.exe" --version
"$HOME/.dsh/dsh-bio-gem/venv-carveme/Scripts/diamond.exe" --version
```

两个实测坑（都真实踩到过）：

- 命令名是 **`carve`**，不是 `carveme`。
- **缺 diamond 不报错、不产文件**：`carve` 只打一行 `Unable to run diamond (make sure diamond is available in your PATH)`，**退出码 0、输出目录为空**。构建失败又找不到原因时，先确认 `diamond.exe` 就在 `carve.exe` 旁边。
- 插件已把 venv 的 `Scripts/` 注入子进程 PATH，无需激活 venv。

### 4.（可选）gapseq 引擎（WSL2）

`gem_build` 的 `engine=gapseq` 走 WSL2 桥（`gem_gapseq` 原子四步：setup / launch / status / fetch），质量档耗时 30-60 分钟/模型，非必需——默认的 `engine=carveme` 已能出可验证模型。桥按本机拓扑实现（WSL2 + `/opt/miniforge3` conda 环境 `gapseq` + 本地序列库），换机器需改 `python/gapseq_wsl.py` 顶部常量，故目前**视为实验性可选能力**。没有 WSL2 不影响其余 22 个工具与 carveme 构建。

### 5. 自检（仓库源码目录内）

```sh
# 冒烟：不依赖 dsh，直测 Python 层 + 工具注册表
# 断言锚定本机 C58 夹具路径（见 test/smoke.js 顶部常量），换机器先改路径
GEM_PYTHON=<你的-cobra-python> node test/smoke.js --skip-build   # 跳过 ~70s 的 build 单测
GEM_PYTHON=<你的-cobra-python> node test/smoke.js                # 含 build 单测
# 托管领域扩展的只读 integration 协议（无需 dsh 实例）
node test/integration.js
```

### 6. 与 dsh-bio-genie 协同

两个插件职责互补、可同时安装（各自独立 bundle patch 行，互不冲突）：

| 插件 | 职责 |
|------|------|
| **dsh-bio-gem**（本插件） | **造模型**：基因组 → 构建 → 验证 → 补洞 → 模型卡 |
| dsh-bio-genie | **用模型**：FBA / 基因必需性 / 生产包络线 / 模型管理面板，外加全量生信分析工具 |

装好 genie 后，其 agent 常驻 persona 已内置 GEM 能力域路由，「建模型 / 建模 / 补洞」类需求会自动转给 `gem_*` 工具。

#### 托管领域扩展集成协议（v0.1.11+）

当 gem 与 BioGenie 运行在同一 dsh Web 实例时，gem 提供两个**固定、只读、loopback-only** 的端点：

```text
GET /api/dsh-bio-gem/integration/health
GET /api/dsh-bio-gem/integration/v1/status
```

- 两端点统一返回 `{ ok: true, value }` 或 `{ ok: false, code, message }`；health 只声明插件身份与协议能力，绝不启动 Python 或写盘。
- status 返回模型/账本/导出的限量摘要、解释器与构建引擎的只读检查；`state` 仅为 `ready` 或 `degraded`。Python/cobra 仍在进程内短缓存；WSL/gapseq 则采用非阻塞 stale-while-revalidate：首次返回 `available: null` / `probing` 与 `warn`，后台完成后才转为 `ok` 或 `missing`，不会把 status 响应拖到超时。
- gapseq 成功结果缓存 5 分钟；失败或超时最多缓存 60 秒后自动重试。探测先用固定的 `wsl.exe -l -q` 预检目标发行版，再运行固定只读版本命令；插件在 webServer 出现约 8 秒后后台预热一次，加载期不探测、不阻塞启动。
- 非 loopback、跨站或 Origin/Host 不一致的请求一律得到 `403`；端点不返回 token、任意命令、任意 URL 或完整日志。修复建议只有受控 `code` + `owner`。
- **设置入口和五态显示属于 BioGenie 面板**，gem 不注册自己的设置页。BioGenie 结合本地安装探测与上述端点显示 `not-installed` / `legacy` / `installed-unavailable` / `incompatible` / `degraded` / `ready`；旧 gem 仅有文件系统只读兼容视图。
- 本批不提供 job、安装、删除、配置或其他写 API；这些操作必须等后续的显式用户动作协议。

### 7. 卸载

```sh
npx -y @deepseek-ai/dsh plugin --profile web remove dsh-bio-gem
```

运行时数据都落在 `~/.dsh/dsh-bio-gem/`（`models/` 模型、`ledger/` 预测账本、`jobs/` 构建任务、`venv*` 环境），**卸载不会删除**，需要清理请手动删除该目录。

### Installation (English quickstart)

```sh
# 1) install the plugin into the web profile, then restart dsh
npx -y @deepseek-ai/dsh plugin --profile web add @dsh-bio/dsh-bio-gem
# (or from source: github:moonbowterfly/dsh-bio-gem)

# 2) analysis Python needs cobra (+ pyrodigal for the annotation fallback)
uv venv --python 3.11 "$HOME/.dsh/dsh-bio-gem/venv"
uv pip install --python "$HOME/.dsh/dsh-bio-gem/venv/Scripts/python.exe" cobra pyrodigal
# point the plugin at it BEFORE starting dsh (dsh reads process env):
#   PowerShell: setx GEM_PYTHON "$env:USERPROFILE\.dsh\dsh-bio-gem\venv\Scripts\python.exe"

# 3) build engine: CarveMe in a dedicated venv + the external `diamond` binary
uv venv --python 3.11 "$HOME/.dsh/dsh-bio-gem/venv-carveme"
uv pip install --python "$HOME/.dsh/dsh-bio-gem/venv-carveme/Scripts/python.exe" carveme
curl -L -o diamond.zip https://github.com/bbuchfink/diamond/releases/latest/download/diamond-windows.zip
unzip -o diamond.zip diamond.exe -d "$HOME/.dsh/dsh-bio-gem/venv-carveme/Scripts/"

# 4) verify the plugin layer is registered (no server needed)
npx -y @deepseek-ai/dsh --profile web --dump-config | grep dsh-bio-gem
```

CarveMe + diamond are required only by `gem_build`; the other 20 tools need nothing but a `cobra`-enabled Python.

## 工具（20）

| 工具 | 作用 | 状态 |
|---|---|---|
| `gem_report` | 模型摘要（基因/反应/区室/复制子分布）+ 预测账本基率摘要（ledger_summary）| ✅ |
| `gem_validate` | 六道关卡 G1-G6（加载/元素平衡/生长真实性/表型(条件)/必需性抽检(条件)/ATP 泄漏）| ✅ |
| `gem_gapfind` | 缺口分级诊断（L1 缺交换 / L2 缺转运 / L3 内部路径）| ✅ |
| `gem_gapfill` | 规则级补洞（L1/L2 自动，provenance 打标，防过补四闸门）| ✅ |
| `gem_l3_fix` | L3 内部路径补洞（L3a 连通性/L3b 白名单+BiGG 反应式；证据分级 + 防过补第五闸门）| ✅ C58 阿拉伯糖 0→0.851 |
| `gem_biomass` | biomass 精修（inspect 组分/对照参考；apply 覆盖表+三联对照+回滚）| ✅ 复位 delta 0.0 |
| `gem_phenotype` | 表型回填迭代（G4 sole 检测 → L1/L2 修复 → L3 报告 → 匹配率对比）| ✅ |
| `gem_essentiality` | 全量必需基因扫描（FVA 预筛 + 手工敲除）| ✅ C58: 必需 155 |
| `gem_annotate` | 基因组→蛋白（官方优先 + pyrodigal 兜底，纯 Windows）| ✅ pyrodigal 5330 |
| `gem_build` | CarveMe/gapseq 双引擎构建（fna/faa；后台 job + 进度；M9 或目标介质验证闭环）| ✅ carveme 70s / fna 全链 63.5s / gapseq 实测中 |
| `gem_gapseq` | gapseq 原子四步（WSL 可选：setup/launch/status/fetch）| ✅ 本机全通 |
| `gem_media_resolve` | 跨引擎介质解析 RPC（自然名→EX ID；消费侧统一入口）| ✅ AB→20 EX |
| `gem_fluxscan` | 通量区间制（FVA 区间+pFBA 点值；条件对比区间分离判定，overlap=伪影禁止引用）| ✅ C58 AB 0.519981 / 蔗糖 supplement 0.97077 |
| `gem_sensitivity` | 结构性灵敏度（GAM×biomass 22 组合全量+稳定性三分类+单组分漂移+模型卡鲁棒性 v3）| ✅ C58 基准复现 155 |
| `gem_ledger` | 预测账本（essentiality/phenotype 自动登记；幂等；list/query/update；基率追踪）| ✅ C58 155+19 条幂等复跑 |
| `gem_benchmark` | 通用基准对比（两模型六关并列/生长/biomass 断供探针/必需性对比[退化护栏]/表型/账本回填；介质层两级策略；支持 bigg:&lt;id&gt; 下载）| ✅ B1 自检 C58 vs C58_P1；B2 C58 vs iNX1344_v4；B3 bigg:iML1515 |
| `gem_secretion` | 可分泌代谢物谱（production envelope 扫描；边界声明=纯拓扑 LP；wt<=EPS 退化护栏）| ✅ C58: 182 候选 85 可分泌 |
| `gem_double_knockout` | 双敲 v1 合成致死（GPR 穷尽先验+全扫预算；假设生成声明内置）| ✅ C58: Atu3364↔Atu4682 对应命中 |
| `gem_enrichment` | 必需基因通路富集（超几何+BH FDR；通路源=SBML groups；无注释诚实兜底）| ✅ C58: 388 通路 55 显著 |
| `gem_targets` | 靶点清单规范导出（账本三类 -> 锁定 schema CSV/JSON；计数闭合）| ✅ C58: 258 行三类闭合 |
| `gem_precursor_scan` | 阻塞前体分析（模型为什么不长：基线通量→可生长即返无阻塞；不生长则逐前体移除测试定位阻塞点）| ✅ 2026-09-11 新增 |
| `gem_quality` | 模型质量报告（gem-qi-v1：blocked/环路(fastcc 方向锥)/元素平衡/孤儿与死端/覆盖/连通性 + 启发式聚合分；分项与 failed_checks 为准）| ✅ C58+AB: qi 67.23 / blocked 1032 / cyclic 289 |
| `gem_sample` | 通量空间采样（ACHR 默认 / OptGP 大样本；growth_floor_fraction 受限空间；全空间 vs 受限边界声明）| ✅ C58+AB: 全空间 median 0.019 / floor-0.9 min 0.468 |

架构/决策见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)、[docs/DECISIONS-2026-08-29.md](docs/DECISIONS-2026-08-29.md)。

## 开发速查

```bash
# Python 层直测（需 Python + cobra，推荐显式指定解释器）
echo '{"op":"model_info","args":{"model":"path.xml"}}' | "$GEM_PYTHON" -I python/gem_ops.py
"$GEM_PYTHON" -u python/build.py --input proteins.faa --name X --progress p.jsonl --medium-json '{...}'

# 独立脚本模式（gapfind/gapfill）
"$GEM_PYTHON" -I python/gapfind.py payload.json
"$GEM_PYTHON" -I python/gapfill.py payload.json
```

依赖：`cobra`（分析，需装在插件探测到的 Python 里）；`carveme` + `diamond`（构建，独立 venv `~/.dsh/dsh-bio-gem/venv-carveme`）。安装步骤见上文第 2、3 节。

## 验收（C58 回归锚）

- `gem_validate` 对 C58.xml：G1 PASS / G2 WARN(仅 bio1 已知边界) / G3 PASS(0.519981) / G4 PASS(17/19) / G5 PASS
- gapfind→gapfill 闭环：原版 C58.xml + 蔗糖培养基 → 自动补交换/转运 → 蔗糖生长 0.97077（与手工 P1 补洞一致）
- gem_build 端到端（C58 protein.faa）：carve M9 gapfill 54s → 精确 M9 介质 G3 PASS 0.782 → AB 目标介质 resolve 20/20，G3 FAIL（L3 内部路径，已记录为 CarveMe 已知边界）

## 许可

MIT（工程层，见 [LICENSE](LICENSE)）；引擎 CarveMe/gapseq 以独立子进程调用分发，版本记录入模型卡，自带许可边界。
