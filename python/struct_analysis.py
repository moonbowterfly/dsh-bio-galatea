"""结构分析：复合物界面分析（interface）+ 结构 QC（inspect）。

依赖：biopython（Bio.PDB）+ numpy。全部为只读分析，不改动输入文件。
约定：残基标签格式 "<chain><resseq>"（如 "A45"）；距离单位 Å。
"""
import os

PHOBIC = set("AVILMFWY")


def _aa1(resname):
    from Bio.Data.PDBData import protein_letters_3to1
    try:
        return protein_letters_3to1.get(resname.strip().upper(), "X")
    except Exception:
        return "X"


def _load_first_model(pdb_path):
    from Bio.PDB import PDBParser
    parser = PDBParser(QUIET=True)
    structure = parser.get_structure("galatea", pdb_path)
    return next(iter(structure))


def _residue_label(residue):
    chain = residue.get_parent().id
    return f"{chain}{residue.id[1]}{residue.id[2].strip()}"


def _heavy_atoms(chains):
    atoms = []
    for chain in chains:
        for atom in chain.get_atoms():
            name = atom.get_name()
            if name.startswith("H") or (atom.element and atom.element.upper() == "H"):
                continue
            atoms.append(atom)
    return atoms


def _parse_chains_arg(arg, default):
    if not arg:
        return list(default)
    return [c.strip() for c in str(arg).split(",") if c.strip()]


def analyze_interface(pdb, partner_a=None, partner_b=None, contact_cutoff=5.0):
    """复合物界面分析（筛选核心）。返回结构化指标 dict。"""
    model = _load_first_model(pdb)
    all_chains = {chain.id: chain for chain in model.get_chains()}
    chain_ids = list(all_chains.keys())
    if len(chain_ids) < 2:
        return {"ok": False, "error": f"结构只有 {len(chain_ids)} 条链，无法做界面分析"}

    a_ids = _parse_chains_arg(partner_a, chain_ids[:1])
    b_ids = _parse_chains_arg(partner_b, chain_ids[1:2])
    missing = [c for c in a_ids + b_ids if c not in all_chains]
    if missing:
        return {"ok": False, "error": f"链不存在: {missing}（现有链 {chain_ids}）"}

    atoms_a = _heavy_atoms([all_chains[c] for c in a_ids])
    atoms_b = _heavy_atoms([all_chains[c] for c in b_ids])
    if not atoms_a or not atoms_b:
        return {"ok": False, "error": "链组原子收集为空"}

    # 跨组接触（KD-tree）
    from Bio.PDB import NeighborSearch
    ns = NeighborSearch(atoms_a + atoms_b)
    raw_pairs = ns.search_all(float(contact_cutoff), level="A")
    contact_pairs = {}
    hbonds = 0
    salt_bridges = 0
    for at1, at2 in raw_pairs:
        ch1 = at1.get_parent().get_parent().id
        ch2 = at2.get_parent().get_parent().id
        in_a1, in_a2 = ch1 in a_ids, ch2 in a_ids
        if in_a1 == in_a2:
            continue  # 只保留跨组
        if in_a2:
            at1, at2 = at2, at1
        # 同残基完全跳过（侧链自接触）
        r1 = at1.get_parent()
        r2 = at2.get_parent()
        if r1 is r2:
            continue
        key = (_residue_label(r1), _residue_label(r2))
        contact_pairs[key] = contact_pairs.get(key, 0) + 1

        # 氢键（粗判：N/O 对 < 3.5Å，不校验角度）
        e1, e2 = (at1.element or "").upper(), (at2.element or "").upper()
        dist = 0.0
        try:
            dist = float(at1 - at2)
        except Exception:
            pass
        if dist and dist <= 3.5:
            if {e1, e2} & {"N", "O"} and e1 != "C" and e2 != "C":
                if (e1 in ("N", "O")) and (e2 in ("N", "O")):
                    hbonds += 1
        # 盐桥（正电侧链 N vs 负电侧链 O < 4.0Å）
        pos_atoms = {"NZ", "NH1", "NH2", "NE"}
        neg_atoms = {"OD1", "OD2", "OE1", "OE2", "ND1", "NE2"}
        n1, n2 = at1.get_name(), at2.get_name()
        if dist and dist <= 4.0:
            if (n1 in pos_atoms and n2 in neg_atoms) or (n2 in pos_atoms and n1 in neg_atoms):
                salt_bridges += 1

    # 界面残基（按组）
    iface_a, iface_b = set(), set()
    for (ra, rb) in contact_pairs:
        iface_a.add(ra)
        iface_b.add(rb)

    # SASA 埋藏面积（Shrake-Rupley；重解析三次模型分别计算）
    sasa_info = None
    sasa_note = None
    try:
        sasa_info = _buried_sasa(pdb, a_ids, b_ids)
    except Exception as e:
        sasa_note = f"SASA 计算失败（{type(e).__name__}: {e}）——界面面积未计入"

    # pLDDT（B-factor 口径探测）
    plddt_info = _plddt_stats(model, iface_a, iface_b, a_ids, b_ids)

    # 聚合输出
    pair_items = sorted(contact_pairs.items(), key=lambda kv: -kv[1])
    result = {
        "status": "ok",
        "pdb": pdb,
        "chains": chain_ids,
        "partner_a": a_ids,
        "partner_b": b_ids,
        "contact_cutoff": float(contact_cutoff),
        "n_contact_pairs_residue_level": len(contact_pairs),
        "n_contacts_atom_level": sum(contact_pairs.values()),
        "n_hbonds": hbonds,
        "n_salt_bridges": salt_bridges,
        "interface_residues": {
            "partner_a_count": len(iface_a),
            "partner_b_count": len(iface_b),
            "partner_a_list": sorted(iface_a),
            "partner_b_list": sorted(iface_b),
        },
        "top_contacts": [
            {"pair": f"{ra}–{rb}", "atom_contacts": cnt} for (ra, rb), cnt in pair_items[:30]
        ],
        "sasa": sasa_info,
        "plddt": plddt_info,
        "notes": [
            "氢键为距离粗判（<3.5Å N/O 对，未校验角度）；盐桥为侧链带电原子对 <4.0Å。",
            "接触数随 cutoff 增大；跨结构对比请使用同一 cutoff。",
        ] + ([sasa_note] if sasa_note else []),
    }
    return result


def _buried_sasa(pdb, a_ids, b_ids):
    """ΔSASA = SASA(A) + SASA(B) − SASA(AB)，单位 Å²（Shrake-Rupley）。"""
    from Bio.PDB import PDBParser
    from Bio.PDB.SASA import ShrakeRupley
    parser = PDBParser(QUIET=True)

    def _sasa_total(keep_chains):
        structure = parser.get_structure("g", pdb)
        model = next(iter(structure))
        for chain in list(model.get_chains()):
            if chain.id not in keep_chains:
                model.detach_child(chain.id)
        sr = ShrakeRupley()
        sr.compute(model, level="A")
        total = 0.0
        for chain in model.get_chains():
            for atom in chain.get_atoms():
                total += getattr(atom, "sasa", 0.0) or 0.0
        return total

    a_only = _sasa_total(set(a_ids))
    b_only = _sasa_total(set(b_ids))
    both = _sasa_total(set(a_ids) | set(b_ids))
    buried = a_only + b_only - both
    return {
        "partner_a_only": round(a_only, 1),
        "partner_b_only": round(b_only, 1),
        "complex_total": round(both, 1),
        "buried_area": round(buried, 1),
        "method": "Shrake-Rupley (biopython)",
    }


def _plddt_stats(model, iface_a, iface_b, a_ids, b_ids):
    ca_bfactors = {}
    for chain in model.get_chains():
        for residue in chain:
            for atom in residue:
                if atom.get_name() == "CA":
                    ca_bfactors[_residue_label(residue)] = float(atom.get_bfactor())
    if not ca_bfactors:
        return None
    vals = list(ca_bfactors.values())
    looks_like_plddt = all(0.0 <= v <= 100.0 for v in vals) and max(vals) > 1.0
    interface_vals = [ca_bfactors[k] for k in list(iface_a) + list(iface_b) if k in ca_bfactors]
    chain_means = {}
    for cid in a_ids + b_ids:
        cvals = [v for k, v in ca_bfactors.items() if k.startswith(cid)]
        if cvals:
            chain_means[cid] = round(sum(cvals) / len(cvals), 2)
    return {
        "scale_looks_like_plddt": looks_like_plddt,
        "global_mean": round(sum(vals) / len(vals), 2),
        "interface_mean": round(sum(interface_vals) / len(interface_vals), 2) if interface_vals else None,
        "chain_means": chain_means,
        "note": None if looks_like_plddt else "B-factor 不在 0-100 范围——非 pLDDT 标度（可能是实验结构或含其他标注）",
    }


def inspect_structure(pdb):
    """结构 QC：链/长度/原子数、clash、pLDDT 分布。"""
    model = _load_first_model(pdb)
    chains_info = []
    all_atoms = []
    for chain in model.get_chains():
        heavy = [a for a in chain.get_atoms()
                 if not (a.get_name().startswith("H") or (a.element and a.element.upper() == "H"))]
        residues = [r for r in chain if r.id[0] == " "]
        chains_info.append({
            "id": chain.id,
            "residues": len(residues),
            "atoms": len(heavy),
        })
        all_atoms.extend(heavy)

    # clash 检测（<1.5Å；跳过同残基与相邻残基）
    from Bio.PDB import NeighborSearch
    ns = NeighborSearch(all_atoms)
    pairs = ns.search_all(1.5, level="A")
    clashes = []
    for at1, at2 in pairs:
        r1, r2 = at1.get_parent(), at2.get_parent()
        c1, c2 = r1.get_parent().id, r2.get_parent().id
        if r1 is r2:
            continue
        if c1 == c2 and abs(r1.id[1] - r2.id[1]) <= 1:
            continue
        try:
            dist = float(at1 - at2)
        except Exception:
            continue
        clashes.append({
            "a": f"{_residue_label(r1)}:{at1.get_name()}",
            "b": f"{_residue_label(r2)}:{at2.get_name()}",
            "distance": round(dist, 2),
        })
    clashes.sort(key=lambda c: c["distance"])

    # pLDDT 分布（CA B-factor）
    ca_vals = []
    for chain in model.get_chains():
        for residue in chain:
            for atom in residue:
                if atom.get_name() == "CA":
                    ca_vals.append(float(atom.get_bfactor()))
    plddt = None
    if ca_vals:
        looks = all(0.0 <= v <= 100.0 for v in ca_vals) and max(ca_vals) > 1.0
        s = sorted(ca_vals)

        def _pct(p):
            idx = min(len(s) - 1, max(0, int(round(p / 100 * (len(s) - 1)))))
            return round(s[idx], 2)

        plddt = {
            "scale_looks_like_plddt": looks,
            "n_residues_ca": len(ca_vals),
            "mean": round(sum(ca_vals) / len(ca_vals), 2),
            "percentiles": {"p10": _pct(10), "p25": _pct(25), "p50": _pct(50), "p75": _pct(75), "p90": _pct(90)},
            "fraction_below_70": round(sum(1 for v in ca_vals if v < 70) / len(ca_vals), 3),
            "note": None if looks else "B-factor 不在 0-100 范围——非 pLDDT 标度",
        }

    verdict_bits = []
    if clashes:
        verdict_bits.append(f"{len(clashes)} 处 <1.5Å 原子 clash")
    if plddt and plddt.get("scale_looks_like_plddt") and plddt["mean"] < 70:
        verdict_bits.append("平均 pLDDT <70（低置信）")
    verdict = "；".join(verdict_bits) if verdict_bits else "未发现明显几何异常"

    return {
        "status": "ok",
        "pdb": pdb,
        "chains": chains_info,
        "total_atoms": len(all_atoms),
        "clash_cutoff": 1.5,
        "n_clashes": len(clashes),
        "worst_clashes": clashes[:20],
        "plddt": plddt,
        "verdict": verdict,
    }
