"""生成 test/fixtures/mini-complex.pdb——两链 mini 复合物（接口/QC 测试夹具）。

链 A：4×ALA（沿 x 轴）；链 B：4×ALA（y+4.0 偏移，与 A 存在 <5Å 接触）。
仅含 N/CA/C 主链原子（测试夹具刻意极简——接口代码按原子距离工作，不依赖完整结构）。
运行：python test/fixtures/gen-mini-complex.py
"""
import os


def _ala_residue(lines, serial, chain, resseq, cx, cy, cz):
    atoms = [
        ("N", cx - 0.6, cy + 0.35, cz),
        ("CA", cx, cy, cz),
        ("C", cx + 0.6, cy - 0.35, cz),
    ]
    for name, x, y, z in atoms:
        el = name[0]
        lines.append(
            f"ATOM  {serial:5d} {name:^4s} ALA {chain}{resseq:4d}    "
            f"{x:8.3f}{y:8.3f}{z:8.3f}  1.00  0.00          {el:>2s}"
        )
        serial += 1
    return serial


def main():
    lines = []
    serial = 1
    for i in range(4):
        serial = _ala_residue(lines, serial, "A", i + 1, i * 3.8, 0.0, 0.0)
    for i in range(4):
        serial = _ala_residue(lines, serial, "B", i + 1, i * 3.8 + 1.5, 4.0, 0.0)
    lines.append("END")

    dst = os.path.join(os.path.dirname(os.path.abspath(__file__)), "mini-complex.pdb")
    with open(dst, "w", encoding="utf-8", newline="\n") as f:
        f.write("\n".join(lines) + "\n")
    print(f"wrote {dst} ({len(lines)} lines)")


if __name__ == "__main__":
    main()
