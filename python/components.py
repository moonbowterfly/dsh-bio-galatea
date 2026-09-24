"""组件探测与自举（status / setup 的后端）。

设计原则（继承 G 系列「零手动」精神）：
  - setup 幂等可重入：已就绪的步骤自动跳过；force=True 强制重装。
  - 全部下载走公开源（IPD / GitHub codeload / HuggingFace），无账号依赖。
  - 网络失败如实报错（error 字符串携带命令与 stderr 尾部），不吞错。
  - 目录布局（全部在插件私有空间）：
      ~/.dsh/dsh-bio-galatea/
      ├── venv/                 # 私有 Python 环境（torch CPU + 依赖）
      ├── vendor/LigandMPNN/    # LigandMPNN 代码（MIT）
      ├── models/mpnn/*.pt      # MPNN 权重（IPD 公开源）
      └── models/esmfold/       # ESMFold 权重（HF facebook/esmfold_v1）
"""
import json
import os
import shutil
import subprocess
import sys
import tarfile
import tempfile


# ---------------------------------------------------------------------------
# 工具函数
# ---------------------------------------------------------------------------
def _venv_python(data_root):
    venv = os.path.join(data_root, "venv")
    if os.name == "nt":
        return os.path.join(venv, "Scripts", "python.exe")
    return os.path.join(venv, "bin", "python")


def _run(cmd, timeout=1800, cwd=None, env=None):
    """运行外部命令；返回 (ok, stdout_tail, stderr_tail, returncode)。"""
    try:
        proc = subprocess.run(
            cmd, capture_output=True, text=True, encoding="utf-8", errors="replace",
            timeout=timeout, cwd=cwd, env=env, shell=False,
        )
        return proc.returncode == 0, (proc.stdout or "")[-2000:], (proc.stderr or "")[-2000:], proc.returncode
    except subprocess.TimeoutExpired:
        return False, "", f"timeout after {timeout}s: {' '.join(str(c) for c in cmd[:3])}", -1
    except FileNotFoundError as e:
        return False, "", f"executable not found: {e}", -1


def _has_module(python_exe, module):
    """探测 python_exe 能否导入 module（子进程隔离，不污染本进程）。"""
    ok, _out, _err, _rc = _run([python_exe, "-I", "-c", f"import {module}"], timeout=60)
    return ok


def _curl_download(url, dst, timeout=1800):
    """curl 下载（Windows 10+ / 各平台均自带 curl；失败返回 False）。"""
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    tmp = dst + ".part"
    ok, _out, err, _rc = _run([
        "curl", "-L", "--fail", "--retry", "3", "--retry-delay", "5",
        "--connect-timeout", "30", "-o", tmp, url,
    ], timeout=timeout)
    if ok and os.path.exists(tmp) and os.path.getsize(tmp) > 0:
        os.replace(tmp, dst)
        return True, ""
    if os.path.exists(tmp):
        try:
            os.remove(tmp)
        except OSError:
            pass
    return False, err


# ---------------------------------------------------------------------------
# status 探测
# ---------------------------------------------------------------------------
def probe_status(data_root):
    """运行时状态：解释器 / 组件 / 设备 / 数据目录。全部为只读探测。"""
    import importlib.util

    info = {
        "data_root": data_root,
        "python": {"executable": sys.executable, "version": sys.version.split()[0]},
        "components": {},
        "device": {},
    }

    # torch（本解释器）
    try:
        import torch
        info["device"] = {
            "torch_version": torch.__version__,
            "cuda_available": bool(torch.cuda.is_available()),
            "device_name": torch.cuda.get_device_name(0) if torch.cuda.is_available() else "cpu",
        }
    except Exception as e:  # pragma: no cover - 环境态
        info["device"] = {"torch_error": f"{type(e).__name__}: {e}"}

    # analysis 依赖
    info["components"]["analysis"] = {
        "biopython": importlib.util.find_spec("Bio") is not None,
        "numpy": importlib.util.find_spec("numpy") is not None,
        "prody": importlib.util.find_spec("prody") is not None,
    }

    # MPNN 代码 + 权重
    vendor = os.path.join(data_root, "vendor", "LigandMPNN")
    mpnn_code = os.path.exists(os.path.join(vendor, "run.py"))
    weights_dir = os.path.join(data_root, "models", "mpnn")
    weights = []
    if os.path.isdir(weights_dir):
        weights = sorted(f for f in os.listdir(weights_dir) if f.endswith(".pt"))
    info["components"]["mpnn"] = {
        "code_ready": mpnn_code,
        "vendor_dir": vendor,
        "weights": weights,
        "ready": mpnn_code and len(weights) > 0,
    }

    # ESMFold 权重（私有目录优先，HF 缓存兜底）
    esm_dir = os.path.join(data_root, "models", "esmfold")
    esm_files = []
    if os.path.isdir(esm_dir):
        esm_files = sorted(f for f in os.listdir(esm_dir) if f.endswith((".bin", ".safetensors", ".pt")))
    esm_source = "galatea-private" if esm_files else None
    if not esm_files:
        hf_home = os.environ.get("HF_HOME") or os.path.join(os.path.expanduser("~"), ".cache", "huggingface")
        hub = os.path.join(hf_home, "hub")
        if os.path.isdir(hub):
            hits = [d for d in os.listdir(hub) if "esmfold" in d.lower()]
            if hits:
                esm_source = "hf-cache"
    info["components"]["esmfold"] = {
        "weights_dir": esm_dir,
        "weights": esm_files,
        "source": esm_source,
        "ready": bool(esm_files) or esm_source == "hf-cache",
    }
    return info


# ---------------------------------------------------------------------------
# setup 自举（幂等）
# ---------------------------------------------------------------------------
MPNN_WEIGHTS_BASE = "https://files.ipd.uw.edu/pub/ligandmpnn/"
# 核心三件套（覆盖三模型默认档）；如需更多温度档可后续扩展
MPNN_CORE_WEIGHTS = [
    "proteinmpnn_v_48_020.pt",
    "solublempnn_v_48_020.pt",
    "ligandmpnn_v_32_020_25.pt",
]
LIGANDMPNN_TARBALL = "https://codeload.github.com/dauparas/LigandMPNN/tar.gz/refs/heads/main"

# env 步骤的 pip 包（分析 + 折叠运行时）
ENV_PACKAGES = ["numpy", "biopython", "prody", "transformers", "accelerate", "safetensors", "huggingface_hub"]


def _mirror_env():
    """尊重用户环境变量；未设置时给中国网络一个默认镜像（清华 PyPI）。
    - UV_DEFAULT_INDEX / PIP_INDEX_URL 已有则不改。
    - HF_ENDPOINT 已有则不改（esmfold 下载用）。"""
    env = os.environ.copy()
    if not env.get("UV_DEFAULT_INDEX") and not env.get("PIP_INDEX_URL"):
        env["UV_DEFAULT_INDEX"] = "https://pypi.tuna.tsinghua.edu.cn/simple"
    return env


def setup_env(data_root, force=False):
    """创建私有 venv 并安装依赖（uv 优先；fallback python -m venv + pip）。"""
    venv_dir = os.path.join(data_root, "venv")
    py = _venv_python(data_root)
    if os.path.exists(py) and not force:
        if _has_module(py, "torch") and _has_module(py, "transformers"):
            return {"status": "already", "python": py, "note": "私有环境已就绪（torch + transformers 可导入）。"}
    os.makedirs(data_root, exist_ok=True)
    env = _mirror_env()
    steps = []

    uv = shutil.which("uv")
    if uv:
        ok, out, err, _rc = _run([uv, "venv", venv_dir, "--python", "3.12", "--allow-existing"], timeout=300, env=env)
        steps.append({"step": "uv venv", "ok": ok, "detail": (err or out)[-400:]})
        if ok:
            # torch CPU 专用源（避免拉 CUDA 大包）
            ok_t, out_t, err_t, _rc2 = _run(
                [uv, "pip", "install", "--python", py, "torch",
                 "--index-url", "https://download.pytorch.org/whl/cpu"],
                timeout=1500, env=env)
            steps.append({"step": "install torch (cpu)", "ok": ok_t, "detail": (err_t or out_t)[-400:]})
            if ok_t:
                ok_p, out_p, err_p, _rc3 = _run(
                    [uv, "pip", "install", "--python", py, *ENV_PACKAGES],
                    timeout=900, env=env)
                steps.append({"step": "install deps", "ok": ok_p, "detail": (err_p or out_p)[-400:]})
    else:
        ok, out, err, _rc = _run([sys.executable, "-m", "venv", venv_dir], timeout=600, env=env)
        steps.append({"step": "python -m venv", "ok": ok, "detail": (err or out)[-400:]})
        if ok:
            ok_t, out_t, err_t, _rc2 = _run(
                [py, "-m", "pip", "install", "torch",
                 "--index-url", "https://download.pytorch.org/whl/cpu"],
                timeout=1500, env=env)
            steps.append({"step": "pip install torch (cpu)", "ok": ok_t, "detail": (err_t or out_t)[-400:]})
            if ok_t:
                ok_p, out_p, err_p, _rc3 = _run([py, "-m", "pip", "install", *ENV_PACKAGES], timeout=900, env=env)
                steps.append({"step": "pip install deps", "ok": ok_p, "detail": (err_p or out_p)[-400:]})

    all_ok = all(s["ok"] for s in steps) if steps else False
    result = {
        "status": "installed" if all_ok else "failed",
        "python": py,
        "steps": steps,
    }
    if all_ok and not _has_module(py, "torch"):
        result["status"] = "failed"
        result["note"] = "torch 安装后仍无法导入（请查看 steps 详情）。"
    return result


def setup_mpnn(data_root, force=False):
    """获取 LigandMPNN 代码（codeload tarball）+ 核心权重（IPD 公开源）。"""
    vendor_dir = os.path.join(data_root, "vendor")
    lm_dir = os.path.join(vendor_dir, "LigandMPNN")
    weights_dir = os.path.join(data_root, "models", "mpnn")
    steps = []

    # 1) 代码
    code_ready = os.path.exists(os.path.join(lm_dir, "run.py"))
    if code_ready and not force:
        steps.append({"step": "code", "ok": True, "detail": "already", "dir": lm_dir})
    else:
        os.makedirs(vendor_dir, exist_ok=True)
        with tempfile.TemporaryDirectory() as tmp:
            tarball = os.path.join(tmp, "ligandmpnn.tar.gz")
            ok, err = _curl_download(LIGANDMPNN_TARBALL, tarball, timeout=600)
            if not ok:
                steps.append({"step": "code", "ok": False,
                              "detail": f"tarball 下载失败（codeload.github.com 不可达？）：{err[-300:]}"})
            else:
                try:
                    with tarfile.open(tarball, "r:gz") as tf:
                        tf.extractall(tmp)
                    extracted = [d for d in os.listdir(tmp) if d.startswith("LigandMPNN-")]
                    if not extracted:
                        raise RuntimeError("tarball 内容缺少 LigandMPNN-* 顶层目录")
                    src = os.path.join(tmp, extracted[0])
                    if os.path.exists(lm_dir):
                        shutil.rmtree(lm_dir)
                    shutil.move(src, lm_dir)
                    steps.append({"step": "code", "ok": True, "detail": "installed", "dir": lm_dir})
                except Exception as e:
                    steps.append({"step": "code", "ok": False, "detail": f"解压失败：{type(e).__name__}: {e}"})

    # 2) 权重
    os.makedirs(weights_dir, exist_ok=True)
    weight_steps = []
    for name in MPNN_CORE_WEIGHTS:
        dst = os.path.join(weights_dir, name)
        if os.path.exists(dst) and os.path.getsize(dst) > 1_000_000 and not force:
            weight_steps.append({"file": name, "ok": True, "detail": "already"})
            continue
        ok, err = _curl_download(MPNN_WEIGHTS_BASE + name, dst, timeout=900)
        weight_steps.append({"file": name, "ok": ok, "detail": "downloaded" if ok else err[-300:]})
    weights_ok = all(w["ok"] for w in weight_steps)
    steps.append({"step": "weights", "ok": weights_ok, "files": weight_steps})

    all_ok = all(s["ok"] for s in steps)
    return {
        "status": "installed" if all_ok else "partial" if any(s["ok"] for s in steps) else "failed",
        "vendor_dir": lm_dir,
        "weights_dir": weights_dir,
        "steps": steps,
    }


def setup_esmfold(data_root, force=False):
    """下载 ESMFold 权重（facebook/esmfold_v1）到私有目录。

    用私有 venv 的 python（含 huggingface_hub）执行 snapshot_download；
    venv 不存在时提示先跑 env。HF_ENDPOINT 环境变量可指向镜像（hf-mirror.com）。
    """
    target = os.path.join(data_root, "models", "esmfold")
    py = _venv_python(data_root)
    if not os.path.exists(py):
        return {"status": "failed", "note": "私有 venv 不存在——请先运行 galatea_setup(action=\"env\")。",
                "target": target}
    if not force and os.path.isdir(target):
        files = [f for f in os.listdir(target) if f.endswith((".bin", ".safetensors"))]
        if files:
            return {"status": "already", "target": target, "files": files[:10]}

    env = _mirror_env()
    os.makedirs(target, exist_ok=True)
    code = (
        "from huggingface_hub import snapshot_download;"
        f"snapshot_download('facebook/esmfold_v1', local_dir=r'{target}');"
        "print('DOWNLOAD_OK')"
    )
    ok, out, err, _rc = _run([py, "-c", code], timeout=3000, env=env)
    if ok and "DOWNLOAD_OK" in (out or ""):
        return {"status": "installed", "target": target}
    hint = err[-500:] if err else out[-300:]
    mirror_hint = "（如网络不通，可设置环境变量 HF_ENDPOINT=https://hf-mirror.com 后重试）"
    return {"status": "failed", "target": target, "detail": hint + mirror_hint}


def run_setup(action, force=False, data_root=None):
    """按 action 顺序执行自举步骤（幂等）。"""
    data_root = data_root or os.path.join(os.path.expanduser("~"), ".dsh", "dsh-bio-galatea")
    results = {"action": action, "data_root": data_root}
    if action in ("env", "all"):
        results["env"] = setup_env(data_root, force=force)
        if action == "all" and results["env"]["status"] == "failed":
            results["stopped_at"] = "env（后续步骤依赖私有 venv，请修复后重跑）"
            return results
    if action in ("mpnn", "all"):
        results["mpnn"] = setup_mpnn(data_root, force=force)
    if action in ("esmfold", "all"):
        results["esmfold"] = setup_esmfold(data_root, force=force)
    results["summary"] = {
        k: v.get("status") for k, v in results.items()
        if isinstance(v, dict) and "status" in v
    }
    return results
