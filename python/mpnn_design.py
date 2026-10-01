"""序列设计（ProteinMPNN / SolubleMPNN / LigandMPNN 包装）。

包装策略：spawn vendor 的 LigandMPNN run.py（独立子进程——模型权重加载与推理
互不污染；也便于超时控制与失败隔离）。输出解析自 out_folder/seqs/*.fa。

依赖：vendor/LigandMPNN（MIT，setup(action="mpnn") 获取）+ models/mpnn/*.pt 权重。
运行解释器：优先 galatea 私有 venv（含 torch/prody），否则当前解释器。
"""
import glob
import os
import re
import subprocess
import sys

from components import _venv_python, resolve_models_dir

# model_type → (checkpoint 参数名, 权重文件名)
MODEL_SPECS = {
    "protein_mpnn": ("checkpoint_protein_mpnn", "proteinmpnn_v_48_020.pt"),
    "soluble_mpnn": ("checkpoint_soluble_mpnn", "solublempnn_v_48_020.pt"),
    "ligand_mpnn": ("checkpoint_ligand_mpnn", "ligandmpnn_v_32_020_25.pt"),
}

_KV_RE = re.compile(r"([A-Za-z_][A-Za-z0-9_/]*)\s*=\s*([-+]?[0-9]*\.?[0-9]+(?:[eE][-+]?[0-9]+)?)")


def _pick_runner(data_root):
    """选择运行 run.py 的解释器：私有 venv 优先（torch+prody 干净），否则当前解释器。"""
    venv_py = _venv_python(data_root)
    if os.path.exists(venv_py):
        return venv_py, "galatea-private"
    return sys.executable, "current-python"


def _parse_fa_headers(fasta_path):
    """解析 LigandMPNN 输出 fasta。

    典型 header："T=0.1, sample=1, score=0.7291, global_score=0.9330, seq_recovery=0.5736"
    LigandMPNN 还写 overall_confidence / ligand_confidence。
    返回 [{"name","seq","values":{k:float}}...]。
    """
    records = []
    name = None
    chunks = []
    vals = {}
    with open(fasta_path, "r", encoding="utf-8", errors="replace") as fh:
        for line in fh:
            line = line.rstrip("\r\n")
            if not line:
                continue
            if line.startswith(">"):
                if name is not None:
                    records.append({"name": name, "seq": "".join(chunks), "values": vals})
                header = line[1:].strip()
                name = header
                vals = {m.group(1): float(m.group(2)) for m in _KV_RE.finditer(header)}
                chunks = []
            else:
                chunks.append(line.strip())
    if name is not None:
        records.append({"name": name, "seq": "".join(chunks), "values": vals})
    return records


def design_sequences(pdb, out_dir, chains=None, fixed_residues=None, num_seqs=16,
                     batch_size=1, temperature=0.1, model="protein_mpnn", seed=0,
                     data_root=None, redesigned_residues=None, disable_bytecode=False):
    """序列设计主入口（供 op_mpnn 调用）。返回结构化结果 dict。"""
    data_root = data_root or os.path.join(os.path.expanduser("~"), ".dsh", "dsh-bio-galatea")
    if model not in MODEL_SPECS:
        return {"ok": False, "error": f"unknown model: {model}（可选 {'/'.join(MODEL_SPECS)}）"}

    vendor_dir = os.path.join(data_root, "vendor", "LigandMPNN")
    run_py = os.path.join(vendor_dir, "run.py")
    if not os.path.exists(run_py):
        return {"ok": False, "error": "LigandMPNN 代码未就绪 → 先运行 galatea_setup(action=\"mpnn\")",
                "vendor_dir": vendor_dir}

    ckpt_arg, ckpt_file = MODEL_SPECS[model]
    models_dir, _ = resolve_models_dir(data_root)
    checkpoint = os.path.join(models_dir, "mpnn", ckpt_file)
    if not os.path.exists(checkpoint):
        return {"ok": False, "error": f"权重缺失: {checkpoint} → 先运行 galatea_setup(action=\"mpnn\")"}

    os.makedirs(out_dir, exist_ok=True)
    batch_size = max(1, int(batch_size))
    num_seqs = max(1, int(num_seqs))
    n_batches = max(1, -(-num_seqs // batch_size))  # ceil

    runner, runner_source = _pick_runner(data_root)
    cmd = [
        runner, run_py,
        "--pdb_path", os.path.abspath(pdb),
        "--out_folder", os.path.abspath(out_dir),
        "--model_type", model,
        f"--{ckpt_arg}", checkpoint,
        "--seed", str(int(seed)),
        "--temperature", str(float(temperature)),
        "--batch_size", str(batch_size),
        "--number_of_batches", str(n_batches),
        "--verbose", "0",
    ]
    if chains:
        cmd += ["--chains_to_design", str(chains)]
    if fixed_residues:
        items = fixed_residues if isinstance(fixed_residues, str) else " ".join(fixed_residues)
        cmd += ["--fixed_residues", items]
    if redesigned_residues:
        items = redesigned_residues if isinstance(redesigned_residues, str) else " ".join(redesigned_residues)
        cmd += ["--redesigned_residues", items]

    try:
        run_env = None
        if disable_bytecode:
            run_env = os.environ.copy()
            run_env["PYTHONDONTWRITEBYTECODE"] = "1"
        proc = subprocess.run(
            cmd, capture_output=True, text=True, encoding="utf-8", errors="replace",
            cwd=vendor_dir, timeout=540, env=run_env,
        )
    except subprocess.TimeoutExpired:
        return {"ok": False, "error": "MPNN 运行超时（>540s）——可减少 num_seqs 或稍后重试",
                "command": " ".join(cmd[:6]) + " ..."}

    if proc.returncode != 0:
        return {
            "ok": False,
            "error": f"run.py 退出码 {proc.returncode}",
            "stderr_tail": (proc.stderr or "")[-1200:],
            "stdout_tail": (proc.stdout or "")[-600:],
            "runner": runner_source,
        }

    fasta_files = sorted(glob.glob(os.path.join(out_dir, "seqs", "*.fa")))
    designs = []
    native = None
    for fa in fasta_files:
        for rec in _parse_fa_headers(fa):
            v = rec["values"]
            # LigandMPNN fasta 结构：第 1 条为参数行 + 原生序列（无 id=），
            # 其后为设计样本（含 id=、overall_confidence、seq_rec）。
            if "id" not in v:
                native = {"seq": rec["seq"], "length": len(rec["seq"]), "name": rec["name"]}
                continue
            designs.append({
                "id": int(v["id"]),
                "seq": rec["seq"],
                "length": len(rec["seq"]),
                "overall_confidence": v.get("overall_confidence"),
                "ligand_confidence": v.get("ligand_confidence"),
                "seq_recovery": v.get("seq_rec") if v.get("seq_rec") is not None else v.get("seq_recovery"),
                "temperature": v.get("T"),
                "sample": v.get("sample"),
                "score": v.get("score"),            # 旧版字段（向后兼容）
                "global_score": v.get("global_score"),
            })

    if not designs:
        return {"ok": False, "error": "run.py 成功退出但未产出序列（检查输入 PDB 是否含设计链）",
                "out_dir": out_dir, "stdout_tail": (proc.stdout or "")[-600:]}

    def _rank_key(d):
        for k in ("overall_confidence", "score"):
            if d.get(k) is not None:
                return d[k]
        return -1.0

    designs.sort(key=_rank_key, reverse=True)
    return {
        "status": "ok",
        "model": model,
        "temperature": float(temperature),
        "seed": int(seed),
        "num_designs": len(designs),
        "designs": designs,
        "native": native,
        "fasta": fasta_files[0] if fasta_files else None,
        "out_dir": out_dir,
        "seqs_dir": os.path.join(out_dir, "seqs"),
        "backbones_dir": os.path.join(out_dir, "backbones"),
        "runner": runner_source,
        "note": "overall_confidence=模型对整条序列的平均置信度（越高越好）；"
                "seq_recovery=与原生序列在可设计位置的同一性；温度越高多样性越大。"
                "designs 已按 overall_confidence 降序；backbones/ 下为对应设计骨架 PDB。",
    }


def design_sequences_with_masks(pdb, out_dir, chains, fixed_residues,
                               redesigned_residues, num_seqs=16, batch_size=1,
                               temperature=0.1, model="protein_mpnn", seed=0,
                               data_root=None):
    """按显式固定/可设计位点采样；仍复用 design_sequences 的 LigandMPNN 链路。"""
    return design_sequences(
        pdb=pdb,
        out_dir=out_dir,
        chains=chains,
        fixed_residues=fixed_residues,
        redesigned_residues=redesigned_residues,
        num_seqs=num_seqs,
        batch_size=batch_size,
        temperature=temperature,
        model=model,
        seed=seed,
        data_root=data_root,
        disable_bytecode=True,
    )
