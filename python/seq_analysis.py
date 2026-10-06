"""序列分析：理化打分（score）+ 候选聚类（cluster）。

依赖：biopython（ProtParam）。疏水矩/聚集倾向为显式启发式实现（文档标注口径）。
"""
import math
from collections import Counter

# Eisenberg 共识疏水标度（用于疏水矩与聚集代理；值越大越疏水）
EISENBERG = {
    "A": 0.62, "R": -2.53, "N": -0.78, "D": -0.90, "C": 0.29, "Q": -0.85,
    "E": -0.74, "G": 0.48, "H": -0.40, "I": 1.38, "L": 1.06, "K": -1.50,
    "M": 0.64, "F": 1.19, "P": 0.12, "S": -0.18, "T": -0.05, "W": 0.81,
    "Y": 0.26, "V": 1.08,
}
HYDROPHOBIC = set("AVILMFWY")


def _clean_seq(seq):
    return "".join(c for c in str(seq).upper() if c in "ACDEFGHIKLMNPQRSTVWY")


def _hydrophobic_moment(seq, window=18):
    """疏水矩（Eisenberg 标度，100°/残基，滑窗取最大）。

    典型判读：两亲性螺旋 μ_h 高（>0.35 量级提示膜/界面两亲性）；无序序列低。
    """
    vals = [EISENBERG.get(c, 0.0) for c in seq]
    if len(vals) < 6:
        return None
    w = min(window, len(vals))
    best = 0.0
    for i in range(0, len(vals) - w + 1):
        hx = 0.0
        hy = 0.0
        for n, v in enumerate(vals[i:i + w]):
            ang = 2 * math.pi * n / 100.0
            hx += v * math.cos(ang)
            hy += v * math.sin(ang)
        mu = math.hypot(hx, hy) / w
        if mu > best:
            best = mu
    return round(best, 3)


def _aggregation_proxy(seq):
    """聚集倾向启发式代理（非 AGGRESCAN/TANGO——只有明确阈值判读意义）。

    组成：最长疏水连续段 + 最大 7 窗口 Eisenberg 均值 → 0-1 风险分。
    经验判读：<0.35 低；0.35-0.55 中；>0.55 高（建议关注/复检）。
    """
    run = max_run = 0
    for c in seq:
        if c in HYDROPHOBIC:
            run += 1
            max_run = max(max_run, run)
        else:
            run = 0
    vals = [EISENBERG.get(c, 0.0) for c in seq]
    w = 7
    best = -9.9
    if len(vals) >= w:
        for i in range(len(vals) - w + 1):
            m = sum(vals[i:i + w]) / w
            if m > best:
                best = m
    else:
        best = sum(vals) / len(vals) if vals else 0.0
    risk = min(1.0, (min(max_run, 12) / 12) * 0.5 + (max(0.0, best) / 1.2) * 0.5)
    return {
        "max_hydrophobic_run": max_run,
        "max_window7_eisenberg": round(best, 3),
        "risk_score": round(risk, 3),
    }


def _low_complexity(seq, window=20, entropy_threshold=2.0, run_threshold=6):
    """Local novelty pre-screen on cleaned residues; not an official novelty score.

    Positions are 1-based, inclusive, in the cleaned sequence. Only full windows
    are scored; shorter sequences still get the independent homopolymer check.
    Defaults can be tuned here without changing existing score op parameters.
    """
    # CH01 calibration (20 aa windows, Shannon entropy in bits):
    # rejected (80 aa): min=1.6814963295296753 at 15-34, max run=4;
    # passed (78 aa): min=2.7414460711655213 at 59-78, max run=3.
    # Strict H < 2.0 flags 7 rejected windows and 0 passed windows; run >= 6
    # alone misses the rejected case. These two cases do not validate official
    # novelty equivalence or a general-purpose rejection threshold.
    windows = []
    min_entropy = None
    for start in range(len(seq) - window + 1):
        counts = Counter(seq[start:start + window])
        entropy = -sum((n / window) * math.log2(n / window) for n in counts.values())
        min_entropy = entropy if min_entropy is None else min(min_entropy, entropy)
        if entropy < entropy_threshold:
            windows.append({
                "start": start + 1,
                "end": start + window,
                "entropy_bits": round(entropy, 6),
            })

    runs = []
    max_run = 0
    start = 0
    while start < len(seq):
        end = start + 1
        while end < len(seq) and seq[end] == seq[start]:
            end += 1
        length = end - start
        max_run = max(max_run, length)
        if length >= run_threshold:
            runs.append({"start": start + 1, "end": end,
                         "residue": seq[start], "length": length})
        start = end

    return {
        "flagged": bool(windows or runs),
        "window_size": window,
        "entropy_threshold_bits": entropy_threshold,
        "run_threshold": run_threshold,
        "min_entropy_bits": round(min_entropy, 6) if min_entropy is not None else None,
        "max_run": max_run,
        "windows": windows,
        "runs": runs,
    }


def score_sequences(sequences):
    """批量理化打分。返回 {"scores": [...], "note": ...}。"""
    from Bio.SeqUtils.ProtParam import ProteinAnalysis
    results = []
    for i, raw in enumerate(sequences):
        seq = _clean_seq(raw)
        if not seq:
            results.append({"index": i, "error": "no valid residues（非标准字符已剔除后为空）"})
            continue
        pa = ProteinAnalysis(seq)
        agg = _aggregation_proxy(seq)
        results.append({
            "index": i,
            "length": len(seq),
            "pI": round(pa.isoelectric_point(), 2),
            "net_charge_pH74": round(pa.charge_at_pH(7.4), 2),
            "gravy": round(pa.gravy(), 3),
            "aromaticity": round(pa.aromaticity(), 3),
            "molecular_weight_kda": round(pa.molecular_weight() / 1000.0, 2),
            "cys_count": seq.count("C"),
            "hydrophobic_moment_h18": _hydrophobic_moment(seq),
            "aggregation": agg,
            "low_complexity": _low_complexity(seq),
        })
    return {
        "scores": results,
        "note": "pI/净电荷/GRAVY 由 Biopython ProtParam 计算；疏水矩为 Eisenberg 标度滑窗实现；"
                "聚集倾向为显式启发式代理（非 AGGRESCAN/TANGO），只用其阈值判读（低<0.35/中0.35-0.55/高>0.55）。",
    }


def _sequence_identity_cleaned(a, b):
    """Identity for sequences already normalized by ``_clean_seq``."""
    length = min(len(a), len(b))
    if length == 0:
        return 0.0
    return sum(1 for index in range(length) if a[index] == b[index]) / length


def sequence_identity(sequence_a, sequence_b):
    """Return the same shorter-prefix identity used by ``cluster_sequences``."""
    return _sequence_identity_cleaned(_clean_seq(sequence_a), _clean_seq(sequence_b))


def cluster_sequences(sequences, threshold=0.8):
    """序列同一性聚类（贪心代表集）。

    规则：按输入顺序贪心——每条与已选代表比较；与某代表同一性 ≥ threshold 则入该簇
    （取同一性最高的簇），否则自成一簇（成为新代表）。输入顺序即优先级
    （建议按 score 降序输入，让高分序列优先成为代表）。
    """
    seqs = [_clean_seq(s) for s in sequences]
    n = len(seqs)
    if n > 2000:
        return {"ok": False, "error": f"序列过多（{n}）——请分批（单次上限 2000）"}
    lengths = [len(s) for s in seqs]
    note = None
    if len(set(lengths)) > 1:
        note = "检测到非等长序列：同一性按较短长度前缀比较（近似）；等长设计（同 backbone）结果最准。"

    reps = []          # 代表索引
    clusters = []      # [ [member indices], ... ]
    assign = [-1] * n

    for i in range(n):
        best_ci = -1
        best_id = -1.0
        for ci, ri in enumerate(reps):
            ident = _sequence_identity_cleaned(seqs[i], seqs[ri])
            if ident >= threshold and ident > best_id:
                best_id = ident
                best_ci = ci
        if best_ci < 0:
            reps.append(i)
            clusters.append([i])
            assign[i] = len(reps) - 1
        else:
            clusters[best_ci].append(i)
            assign[i] = best_ci

    out_clusters = []
    for ci, members in enumerate(clusters):
        out_clusters.append({
            "cluster_id": ci + 1,
            "size": len(members),
            "representative_index": reps[ci],
            "representative_seq": seqs[reps[ci]],
            "members": members,
        })
    out_clusters.sort(key=lambda c: -c["size"])
    return {
        "status": "ok",
        "n_sequences": n,
        "n_clusters": len(out_clusters),
        "threshold": float(threshold),
        "clusters": out_clusters,
        "note": note or f"同一性阈值 {threshold}：≥ 阈值视为同簇。",
    }
