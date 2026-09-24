"""极简 FASTA 读写（不引入 biopython 依赖的最小实现）。"""


def read_fasta(path):
    """读 FASTA → [{"name": str, "seq": str}]（宽容处理空行/CRLF）。"""
    records = []
    name = None
    chunks = []
    with open(path, "r", encoding="utf-8", errors="replace") as fh:
        for line in fh:
            line = line.rstrip("\r\n")
            if not line:
                continue
            if line.startswith(">"):
                if name is not None:
                    records.append({"name": name, "seq": "".join(chunks)})
                name = line[1:].strip()
                chunks = []
            else:
                chunks.append(line.strip())
    if name is not None:
        records.append({"name": name, "seq": "".join(chunks)})
    return records


def write_fasta(path, records, width=60):
    """写 FASTA（records: [{"name","seq"}]；60 列换行）。"""
    with open(path, "w", encoding="utf-8") as fh:
        for rec in records:
            fh.write(f">{rec['name']}\n")
            seq = rec["seq"]
            for i in range(0, len(seq), width):
                fh.write(seq[i:i + width] + "\n")
