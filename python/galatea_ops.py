"""dsh-bio-galatea Python 操作层 — JSON 协议分发器（蛋白质结构预测与设计）。

协议与 dsh-bio-genie/bio_ops.py、dsh-bio-gem/gem_ops.py 同族：
  TS 侧通过 stdin 发送 {"op": "...", "args": {...}}，
  本脚本执行后将 {"ok": true, "result": ...} 或 {"ok": false, "error": "..."} 写到 stdout。

契约（bridge 层继承）：
  - 捕获所有代码异常后恒返回 ok:true，traceback 写 stderr（带 "Traceback (most recent call last)" 头）——
    代码级失败判定必须在 TS 侧检测该头 → needs_repair=true。
  - 输出前 _sanitize_json 递归规范化（-0.0→0.0, NaN/inf→null），规避 dsh snapshot 校验。
  - 三流强制 UTF-8（Windows GBK 坑；stdin 也必须重设——graft 实测教训：漏 stdin 导致
    非 ASCII 参数被 GBK 误解码 → surrogates not allowed）。

op 一览（v0.1）：
  status     运行时状态（解释器/组件/设备/数据目录）
  setup      零手动自举（env | mpnn | esmfold | all；幂等可重入）
  mpnn       序列设计（ProteinMPNN / SolubleMPNN / LigandMPNN）
  fold       单链结构预测（ESMFold，CPU/GPU 自适应）
  interface  复合物界面分析（接触/氢键/盐桥/SASA/pLDDT）
  score      序列理化打分（批量）
  inspect    结构 QC（链/几何异常/pLDDT 分布）
  cluster    候选聚类（同一性矩阵 + 贪心代表集）
"""
import json
import os
import sys
import time
import traceback

# Windows 下 sys.stdin/stdout/stderr 默认按 GBK（locale）编解码，而 Node 侧以 UTF-8 写入/读取。
# 不显式重配置会导致中文参数/结果损坏。三个流都要重设（stdin 尤其易漏——graft 实测教训）。
sys.stdin.reconfigure(encoding="utf-8")
sys.stdout.reconfigure(encoding="utf-8")
sys.stderr.reconfigure(encoding="utf-8", errors="replace")

# Python -I isolated 模式下脚本目录不进 sys.path——显式插入以导入同目录模块
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

DATA_ROOT = os.path.join(os.path.expanduser("~"), ".dsh", "dsh-bio-galatea")


def _sanitize_json(obj):
    """递归规范化：-0.0 -> 0.0, NaN/inf -> None（dsh snapshotToolValue 只接受 lossless JSON）。"""
    if isinstance(obj, float):
        if obj != obj or obj in (float("inf"), float("-inf")):
            return None
        if obj == 0.0 and str(obj).startswith("-"):
            return 0.0
        return obj
    if isinstance(obj, dict):
        return {k: _sanitize_json(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_sanitize_json(v) for v in obj]
    return obj


def default_out_dir(prefix):
    """默认输出目录：~/.dsh/dsh-bio-galatea/out/<prefix>_<时间戳>（自动创建）。"""
    path = os.path.join(DATA_ROOT, "out", f"{prefix}_{time.strftime('%Y%m%d_%H%M%S')}")
    os.makedirs(path, exist_ok=True)
    return path


# ---------------------------------------------------------------------------
# op: status — 运行时状态（解释器/组件/设备/数据目录）
# ---------------------------------------------------------------------------
def op_status(args):
    from components import probe_status
    return {"ok": True, "result": probe_status(DATA_ROOT)}


# ---------------------------------------------------------------------------
# op: setup — 零手动自举（env | mpnn | esmfold | all；幂等）
# ---------------------------------------------------------------------------
def op_setup(args):
    from components import run_setup
    action = args.get("action") or "all"
    if action not in ("env", "mpnn", "esmfold", "all"):
        return {"ok": False, "error": f"invalid action: {action}（可选 env/mpnn/esmfold/all）"}
    return {"ok": True, "result": run_setup(action, force=bool(args.get("force")), data_root=DATA_ROOT)}


# ---------------------------------------------------------------------------
# op: mpnn — 序列设计（inverse folding）
# ---------------------------------------------------------------------------
def op_mpnn(args):
    from mpnn_design import design_sequences
    pdb = args.get("pdb")
    if not pdb or not os.path.exists(pdb):
        return {"ok": False, "error": f"pdb file not found: {pdb}"}
    out_dir = args.get("out_dir") or default_out_dir("mpnn")
    return {"ok": True, "result": design_sequences(
        pdb=pdb,
        out_dir=out_dir,
        chains=args.get("chains"),
        fixed_residues=args.get("fixed_residues"),
        num_seqs=int(args.get("num_seqs") or 16),
        batch_size=int(args.get("batch_size") or 1),
        temperature=float(args.get("temperature") if args.get("temperature") is not None else 0.1),
        model=args.get("model") or "protein_mpnn",
        seed=int(args.get("seed") or 0),
        data_root=DATA_ROOT,
    )}


# ---------------------------------------------------------------------------
# op: fold — 单链结构预测（ESMFold）
# ---------------------------------------------------------------------------
def op_fold(args):
    from fold_esm import fold_sequences
    sequences = args.get("sequences") or []
    fasta = args.get("fasta")
    if fasta and os.path.exists(fasta):
        from seqio_lite import read_fasta
        sequences = [rec["seq"] for rec in read_fasta(fasta)]
    sequences = [s.strip().upper() for s in sequences if s and s.strip()]
    if not sequences:
        return {"ok": False, "error": "no sequences provided (sequences 或 fasta 二选一)"}
    if len(sequences) > 8:
        return {"ok": False, "error": f"too many sequences: {len(sequences)}（单次上限 8 条，请分批）"}
    out_dir = args.get("out_dir") or default_out_dir("fold")
    return {"ok": True, "result": fold_sequences(
        sequences=sequences,
        out_dir=out_dir,
        device=args.get("device") or "auto",
        data_root=DATA_ROOT,
    )}


# ---------------------------------------------------------------------------
# op: interface — 复合物界面分析
# ---------------------------------------------------------------------------
def op_interface(args):
    from struct_analysis import analyze_interface
    pdb = args.get("complex_pdb")
    if not pdb or not os.path.exists(pdb):
        return {"ok": False, "error": f"complex pdb file not found: {pdb}"}
    return {"ok": True, "result": analyze_interface(
        pdb=pdb,
        partner_a=args.get("partner_a"),
        partner_b=args.get("partner_b"),
        contact_cutoff=float(args.get("contact_cutoff") or 5.0),
    )}


# ---------------------------------------------------------------------------
# op: score — 序列理化打分（批量）
# ---------------------------------------------------------------------------
def op_score(args):
    from seq_analysis import score_sequences
    sequences = args.get("sequences") or []
    fasta = args.get("fasta")
    if fasta and os.path.exists(fasta):
        from seqio_lite import read_fasta
        records = read_fasta(fasta)
        sequences = [rec["seq"] for rec in records]
    elif sequences:
        records = None
    sequences = [s.strip().upper() for s in sequences if s and s.strip()]
    if not sequences:
        return {"ok": False, "error": "no sequences provided (sequences 或 fasta 二选一)"}
    return {"ok": True, "result": score_sequences(sequences)}


# ---------------------------------------------------------------------------
# op: inspect — 结构 QC
# ---------------------------------------------------------------------------
def op_inspect(args):
    from struct_analysis import inspect_structure
    pdb = args.get("pdb")
    if not pdb or not os.path.exists(pdb):
        return {"ok": False, "error": f"pdb file not found: {pdb}"}
    return {"ok": True, "result": inspect_structure(pdb)}


# ---------------------------------------------------------------------------
# op: cluster — 候选聚类（同一性矩阵 + 贪心代表集）
# ---------------------------------------------------------------------------
def op_cluster(args):
    from seq_analysis import cluster_sequences
    sequences = args.get("sequences") or []
    fasta = args.get("fasta")
    if fasta and os.path.exists(fasta):
        from seqio_lite import read_fasta
        sequences = [rec["seq"] for rec in read_fasta(fasta)]
    sequences = [s.strip().upper() for s in sequences if s and s.strip()]
    if not sequences:
        return {"ok": False, "error": "no sequences provided (sequences 或 fasta 二选一)"}
    return {"ok": True, "result": cluster_sequences(
        sequences, threshold=float(args.get("threshold") or 0.8))}


OPS = {
    "status": op_status,
    "setup": op_setup,
    "mpnn": op_mpnn,
    "fold": op_fold,
    "interface": op_interface,
    "score": op_score,
    "inspect": op_inspect,
    "cluster": op_cluster,
}


def main():
    line = sys.stdin.read()
    try:
        req = json.loads(line)
        op = req.get("op", "")
        args = req.get("args", {}) or {}
    except Exception:
        # 协议级失败：返回 ok:false + 说明
        print(json.dumps({"ok": False, "error": "protocol error: invalid JSON on stdin"}))
        return
    fn = OPS.get(op)
    if fn is None:
        print(json.dumps({"ok": False, "error": f"unknown op: {op}"}))
        return
    try:
        out = fn(args)
        if isinstance(out, dict) and "ok" in out:
            print(json.dumps(_sanitize_json(out), ensure_ascii=False))
        else:
            print(json.dumps(_sanitize_json({"ok": True, "result": out}), ensure_ascii=False))
    except Exception as e:
        # 捕获所有异常，恒返回 ok:true（traceback 写 stderr 头，TS 侧检测）
        sys.stderr.write("Traceback (most recent call last):\n")
        traceback.print_exc(file=sys.stderr)
        print(json.dumps({"ok": True, "result": None,
                          "error_hint": f"op {op} failed: {type(e).__name__}: {e}"},
                         ensure_ascii=False))


if __name__ == "__main__":
    main()
