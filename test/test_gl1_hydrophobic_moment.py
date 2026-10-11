# test_gl1_hydrophobic_moment.py — GL-1 疏水矩公式修正定向测试
# 运行：<galatea-python> -I test/test_gl1_hydrophobic_moment.py
# 独立参考公式在测试内自行实现（不调用待测 helper），确保交叉核验。
import sys
import os
import math

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "python"))

from seq_analysis import (score_sequences, _hydrophobic_moment, HYDROPHOBIC_MOMENT_METHOD,
                          EISENBERG, _clean_seq)

FAILURES = []


def check(name, cond, detail=""):
    if cond:
        print(f"  PASS  {name}")
    else:
        print(f"  FAIL  {name}  {detail}")
        FAILURES.append(name)


def ref_moment_v2(seq, window=18):
    """独立参考实现：100°/残基，滑窗取 max，min length 6，3 位小数。"""
    vals = [EISENBERG.get(c, 0.0) for c in seq]
    if len(vals) < 6:
        return None
    w = min(window, len(vals))
    best = 0.0
    step = math.radians(100.0)
    for i in range(0, len(vals) - w + 1):
        hx = sum(v * math.cos(step * n) for n, v in enumerate(vals[i:i + w]))
        hy = sum(v * math.sin(step * n) for n, v in enumerate(vals[i:i + w]))
        mu = math.hypot(hx, hy) / w
        best = max(best, mu)
    return round(best, 3)


def ref_moment_v1(seq, window=18):
    """历史错误公式（3.6°/残基 = 2πn/100）——仅作数值对照证明「v1 ≠ v2」。"""
    vals = [EISENBERG.get(c, 0.0) for c in seq]
    if len(vals) < 6:
        return None
    w = min(window, len(vals))
    best = 0.0
    for i in range(0, len(vals) - w + 1):
        hx = sum(v * math.cos(2 * math.pi * n / 100.0) for n, v in enumerate(vals[i:i + w]))
        hy = sum(v * math.sin(2 * math.pi * n / 100.0) for n, v in enumerate(vals[i:i + w]))
        mu = math.hypot(hx, hy) / w
        best = max(best, mu)
    return round(best, 3)


print("[1] ALALALALALALALALAL（18 A）：v2 ≈ 0，v1 ≈ 0.796")
seq18 = "ALALALALALALALALAL"
v2 = _hydrophobic_moment(seq18)
v1 = ref_moment_v1(seq18)
check("v2 ≈ 0", v2 == 0.0, f"v2={v2}")
check("v1 ≈ 0.796", abs(v1 - 0.796) < 1e-3, f"v1={v1}")
check("v2 != v1（修复确实改变结果）", v2 != v1, f"v2={v2} v1={v1}")

print("[2] 长度边界：5 / 6 / 18 / 19 / >18")
check("length 5 -> None（min 6）", _hydrophobic_moment("AAAAA") is None)
check("length 6 -> 数值", isinstance(_hydrophobic_moment("AAAAAA"), float))
check("length 18 -> 数值", isinstance(_hydrophobic_moment("A" * 18), float))
check("length 19 -> window=min(18,19)=18 多窗", isinstance(_hydrophobic_moment("A" * 19), float))
long_seq = "AL" * 30  # 60 aa，多窗口
check("length >18 多窗口 max", _hydrophobic_moment(long_seq) == ref_moment_v2(long_seq),
      f"{_hydrophobic_moment(long_seq)} vs {ref_moment_v2(long_seq)}")

print("[3] 随机序列：v2 与独立 100° 公式逐位一致")
import random
random.seed(42)
for _ in range(50):
    n = random.randint(6, 40)
    s = "".join(random.choice("ACDEFGHIKLMNPQRSTVWY") for _ in range(n))
    a, b = _hydrophobic_moment(s), ref_moment_v2(s)
    if a != b:
        check(f"seq {s}: v2 == ref", False, f"{a} vs {b}")
        break
else:
    check("50 条随机序列 v2 == 独立参考", True)

print("[4] 方法元数据：version=2 / 100°/残基")
check("method version == 2", HYDROPHOBIC_MOMENT_METHOD["version"] == "2")
check("angle == 100 度/残基", HYDROPHOBIC_MOMENT_METHOD["angle_deg_per_residue"] == 100)
check("min_length == 6", HYDROPHOBIC_MOMENT_METHOD["min_length"] == 6)
check("window == 18", HYDROPHOBIC_MOMENT_METHOD["window"] == 18)

print("[5] 真实 1UBQ 设计 FASTA：逐 record 与独立公式对照 + native/design 区分")
fasta = r"D:/Program/dsh/g-series-e2e-20261004/ubiquitin_mpnn_4candidates.fasta"
# 该 FASTA 头部含 GBK 编码的破折号（非 UTF-8），用容错读取（序列本身是 ASCII）
with open(fasta, "rb") as f:
    raw_bytes = f.read()
raw = raw_bytes.decode("utf-8", errors="replace")
# 手工解析 record（独立于被测模块的 split_fasta）
records = []
cur_id, cur_seq = None, []
for line in raw.splitlines():
    if line.startswith(">"):
        if cur_id is not None:
            records.append((cur_id, "".join(cur_seq)))
        cur_id = line[1:].strip()
        cur_seq = []
    else:
        cur_seq.append(line.strip())
if cur_id is not None:
    records.append((cur_id, "".join(cur_seq)))
check("FASTA 有 5 条 record", len(records) == 5, f"n={len(records)}")

res = score_sequences([seq for _, seq in records])
check("score_sequences 返回 5 条", len(res["scores"]) == 5, f"n={len(res['scores'])}")

for i, (rid, seq) in enumerate(records):
    s = res["scores"][i]
    expect = ref_moment_v2(_clean_seq(seq))
    got = s.get("hydrophobic_moment_h18")
    check(f"record[{i}] {rid.split()[0]}: h18 == 独立 100° 公式",
          got == expect, f"got={got} expect={expect}")
    check(f"record[{i}] method 元数据存在且 version=2",
          s.get("hydrophobic_moment_method", {}).get("version") == "2")

native_idx = next(i for i, (rid, _) in enumerate(records) if "native" in rid)
design_idx = 0
print(f"  native h18={res['scores'][native_idx]['hydrophobic_moment_h18']}  "
      f"design1 h18={res['scores'][design_idx]['hydrophobic_moment_h18']}")
check("native 与 design 是不同记录（未混淆）",
      records[native_idx][0].startswith("ubiquitin_native")
      and not records[design_idx][0].startswith("ubiquitin_native"))

print("[6] 其他 ProtParam 字段基线行为不变（pI/gravy 存在且数值非 None）")
s0 = res["scores"][0]
check("pI 存在", isinstance(s0.get("pI"), float))
check("gravy 存在", isinstance(s0.get("gravy"), float))
check("molecular_weight_kda 存在", isinstance(s0.get("molecular_weight_kda"), float))
check("low_complexity 字段保留", "low_complexity" in s0)

print(f"\n{'=' * 60}")
print(f"GL-1 定向测试：{'ALL PASS' if not FAILURES else 'FAILED ' + str(len(FAILURES))}")
if FAILURES:
    print("失败项：", FAILURES)
    sys.exit(1)
sys.exit(0)
