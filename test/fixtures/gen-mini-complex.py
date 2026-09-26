"""生成 test/fixtures/mini-complex.pdb 与 mini-complex-full.pdb——两链 mini 复合物。

链 A：4×ALA（沿 x 轴）；链 B：4×ALA（y+4.0 偏移，与 A 存在 <5Å 接触）。
- mini-complex.pdb：仅含 N/CA/C 主链原子（轻量测试夹具刻意极简——接口/QC 代码按原子距离工作）。
- mini-complex-full.pdb：N/CA/C/O 完整主链（供真实 MPNN 等重推理路径使用；LigandMPNN 写回序列时
  按每残基 4 个骨架原子构造数组，缺 O 会触发 shape mismatch）。
运行：python test/fixtures/gen-mini-complex.py
"""
import os


def _ala_residue(lines, serial, chain, resseq, cx, cy, cz, with_oxygen=False):
    atoms = [
        ("N", cx - 0.6, cy + 0.35, cz),
        ("CA", cx, cy, cz),
        ("C", cx + 0.6, cy - 0.35, cz),
    ]
    if with_oxygen:
        atoms.append(("O", cx + 1.3, cy - 1.35, cz))
    for name, x, y, z in atoms:
        el = name[0]
        lines.append(
            f"ATOM  {serial:5d} {name:^4s} ALA {chain}{resseq:4d}    "
            f"{x:8.3f}{y:8.3f}{z:8.3f}  1.00  0.00          {el:>2s}"
        )
        serial += 1
    return serial


def _build(with_oxygen):
    lines = []
    serial = 1
    for i in range(4):
        serial = _ala_residue(lines, serial, "A", i + 1, i * 3.8, 0.0, 0.0, with_oxygen)
    for i in range(4):
        serial = _ala_residue(lines, serial, "B", i + 1, i * 3.8 + 1.5, 4.0, 0.0, with_oxygen)
    lines.append("END")
    return lines


def main():
    base = os.path.dirname(os.path.abspath(__file__))
    for filename, with_oxygen in (("mini-complex.pdb", False), ("mini-complex-full.pdb", True)):
        lines = _build(with_oxygen)
        dst = os.path.join(base, filename)
        with open(dst, "w", encoding="utf-8", newline="\n") as f:
            f.write("\n".join(lines) + "\n")
        print(f"wrote {dst} ({len(lines)} lines)")


if __name__ == "__main__":
    main()
