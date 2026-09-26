"""区域约束式 binder 重设计；MPNN 推理复用 mpnn_design 的现有封装。"""
import json
import math
import os


PRESET_TEMPERATURES = {
    "interface-refine": 0.10,
    "anchor-preserving": 0.12,
    "scaffold-rescue": 0.10,
    "full-explore": 0.25,
}
INTERFACE_CUTOFF_ANGSTROM = 4.0
TARGET_SHELL_CUTOFF_ANGSTROM = 8.0
STRUCTURAL_SHELL_CUTOFF_ANGSTROM = 6.0
SASA_PROBE_RADIUS_ANGSTROM = 1.4
CORE_RSASA_CUTOFF = 0.10
SURFACE_RSASA_CUTOFF = 0.25
INTERFACE_BURIED_CUTOFF_ANGSTROM2 = 1.0
ANCHOR_FREQUENCY_CUTOFF = 0.7

# Tien et al. (2013), PLoS ONE 8(11):e80635, Table 1, ALLOWED-region
# theoretical MaxASA values from Gly-X-Gly tripeptides (Å²).
MAX_ASA_ANGSTROM2 = {
    "A": 129.0, "R": 274.0, "N": 195.0, "D": 193.0, "C": 167.0,
    "Q": 225.0, "E": 223.0, "G": 104.0, "H": 224.0, "I": 197.0,
    "L": 201.0, "K": 236.0, "M": 224.0, "F": 240.0, "P": 159.0,
    "S": 155.0, "T": 172.0, "W": 285.0, "Y": 263.0, "V": 174.0,
}


def _parse_structure(path):
    from Bio.PDB import MMCIFParser, PDBParser

    extension = os.path.splitext(path)[1].lower()
    parser = MMCIFParser(QUIET=True) if extension in (".cif", ".mmcif") else PDBParser(QUIET=True)
    structure = parser.get_structure("galatea_redesign", path)
    return next(iter(structure))


def _parse_chain_ids(value, default):
    if value is None or value == "":
        return list(default)
    if isinstance(value, (list, tuple)):
        result = [str(item).strip() for item in value if str(item).strip()]
    else:
        result = [part.strip() for part in str(value).split(",") if part.strip()]
    if len(result) != len(set(result)):
        raise ValueError("chain IDs must be unique")
    return result


def _is_heavy(atom):
    element = (atom.element or "").strip().upper()
    name = atom.get_name().strip().upper().lstrip("0123456789")
    return element not in ("H", "D") and not name.startswith("H")


def _protein_residues(chain):
    from Bio.PDB.Polypeptide import is_aa

    return [residue for residue in chain if is_aa(residue, standard=False)]


def _residue_label(residue):
    from struct_analysis import _residue_label as label_residue

    return label_residue(residue)


def _structural_region(rsasa):
    if rsasa <= CORE_RSASA_CUTOFF:
        return "CORE"
    if rsasa < SURFACE_RSASA_CUTOFF:
        return "BOUNDARY"
    return "SURFACE"


def _minimum_distance(atom_coords, other_coords):
    """Return the exact minimum Cartesian distance between two small atom sets."""
    import numpy as np

    left = np.asarray(atom_coords, dtype=float)
    right = np.asarray(other_coords, dtype=float)
    delta = left[:, None, :] - right[None, :, :]
    return float(np.sqrt(np.sum(delta * delta, axis=2)).min())


def _sasa_by_residue(model, keep_chains):
    """Compute residue SASA after copying the unchanged coordinates and pruning chains."""
    from copy import deepcopy
    from Bio.PDB.SASA import ShrakeRupley

    isolated = deepcopy(model)
    for chain in list(isolated.get_chains()):
        if chain.id not in keep_chains:
            isolated.detach_child(chain.id)
    ShrakeRupley(probe_radius=SASA_PROBE_RADIUS_ANGSTROM).compute(isolated, level="R")
    return {
        _residue_label(residue): float(residue.sasa)
        for chain in isolated.get_chains()
        for residue in _protein_residues(chain)
    }


def _core_mutation_fraction(native_sequence, designed_sequence, binder_positions, core_positions):
    """Measure sequence changes at CORE positions; a missing output position counts as changed."""
    core_positions = set(core_positions)
    if not core_positions:
        return 0.0
    native = str(native_sequence or "").replace(" ", "").split(":", 1)[0].upper()
    designed = str(designed_sequence or "").replace(" ", "").split(":", 1)[0].upper()
    indices = {label: index for index, label in enumerate(binder_positions)}
    changed = 0
    for label in core_positions:
        index = indices.get(label)
        if index is None or index >= len(native) or index >= len(designed) or native[index] != designed[index]:
            changed += 1
    return changed / len(core_positions)


def _load_contact_frequencies(contact_frequencies=None, contact_frequencies_path=None):
    if contact_frequencies is not None and contact_frequencies_path:
        raise ValueError("provide contact_frequencies or contact_frequencies_path, not both")
    if contact_frequencies_path:
        if not os.path.isfile(contact_frequencies_path):
            raise ValueError(f"contact_frequencies_path not found: {contact_frequencies_path}")
        with open(contact_frequencies_path, "r", encoding="utf-8") as fh:
            contact_frequencies = json.load(fh)
    if contact_frequencies is None:
        return None
    if not isinstance(contact_frequencies, dict):
        raise ValueError("contact_frequencies must be a JSON object mapping residue labels to frequencies")
    values = {}
    for label, value in contact_frequencies.items():
        try:
            frequency = float(value)
        except (TypeError, ValueError):
            raise ValueError(f"contact frequency for {label} must be numeric") from None
        if not math.isfinite(frequency) or not 0.0 <= frequency <= 1.0:
            raise ValueError(f"contact frequency for {label} must be between 0 and 1")
        values[str(label)] = frequency
    return values


def calculate_regions(structure_path, binder_chain, target_chain=None,
                      contact_frequencies=None, contact_frequencies_path=None):
    """Calculate deterministic binder regions, binder-alone rSASA and complex burial."""
    if not structure_path or not os.path.isfile(structure_path):
        raise ValueError(f"structure_path not found: {structure_path}")
    model = _parse_structure(structure_path)
    chains = {chain.id: chain for chain in model.get_chains()}
    if binder_chain is None or str(binder_chain).strip() == "":
        raise ValueError("binder_chain is required")
    binder_chain = str(binder_chain).strip()
    if binder_chain not in chains:
        raise ValueError(f"binder chain {binder_chain!r} not found; available chains: {list(chains)}")

    target_ids = _parse_chain_ids(target_chain, [cid for cid in chains if cid != binder_chain])
    if not target_ids:
        raise ValueError("target_chain is empty; provide at least one non-binder chain")
    if binder_chain in target_ids:
        raise ValueError("binder_chain must not be included in target_chain")
    missing = [cid for cid in target_ids if cid not in chains]
    if missing:
        raise ValueError(f"target chain(s) not found: {missing}; available chains: {list(chains)}")

    binder_residues = _protein_residues(chains[binder_chain])
    if not binder_residues:
        raise ValueError(f"binder chain {binder_chain!r} contains no amino-acid residues")
    target_atoms = [atom for cid in target_ids for residue in chains[cid]
                    for atom in residue.get_atoms() if _is_heavy(atom)]
    binder_atoms = [atom for residue in binder_residues for atom in residue.get_atoms() if _is_heavy(atom)]
    if not binder_atoms or not target_atoms:
        raise ValueError("binder or target chain has no heavy atoms")

    target_coords = [atom.coord for atom in target_atoms]
    binder_heavy_atoms = {
        _residue_label(residue): [atom for atom in residue.get_atoms() if _is_heavy(atom)]
        for residue in binder_residues
    }
    min_target_dist = {
        label: _minimum_distance([atom.coord for atom in atoms], target_coords)
        for label, atoms in binder_heavy_atoms.items()
    }
    interface_contact = {
        label for label, distance in min_target_dist.items()
        if distance <= INTERFACE_CUTOFF_ANGSTROM
    }
    target_shell = {
        label for label, distance in min_target_dist.items()
        if INTERFACE_CUTOFF_ANGSTROM < distance <= TARGET_SHELL_CUTOFF_ANGSTROM
    }

    # Compare binder-alone and binder+target SASA at the same coordinates. The
    # complex calculation deliberately keeps only the selected binder and target chains.
    complex_sasa = _sasa_by_residue(model, {binder_chain, *target_ids})
    binder_sasa = _sasa_by_residue(model, {binder_chain})
    core = set()
    boundary = set()
    surface = set()
    delta_sasa = {}
    rsasa_by_label = {}
    sasa_by_label = {}
    aa_by_label = {}
    for residue in binder_residues:
        label = _residue_label(residue)
        sasa = binder_sasa.get(label)
        complex_area = complex_sasa.get(label)
        if sasa is None or complex_area is None or not math.isfinite(sasa) or not math.isfinite(complex_area):
            raise ValueError(f"SASA unavailable for binder residue {label}")
        from struct_analysis import _aa1
        aa = _aa1(residue.resname)
        max_asa = MAX_ASA_ANGSTROM2.get(aa)
        if max_asa is None:
            raise ValueError(f"MaxASA unavailable for amino acid {aa!r} at {label}")
        rsasa = sasa / max_asa
        region = _structural_region(rsasa)
        {"CORE": core, "BOUNDARY": boundary, "SURFACE": surface}[region].add(label)
        sasa_by_label[label] = sasa
        rsasa_by_label[label] = rsasa
        aa_by_label[label] = aa
        delta_sasa[label] = sasa - complex_area

    interface_buried = {
        label for label, delta in delta_sasa.items()
        if delta >= INTERFACE_BURIED_CUTOFF_ANGSTROM2
    }
    interface = interface_contact | interface_buried
    interface_labels = [label for label in binder_heavy_atoms if label in interface]
    interface_atoms = [atom for label in interface_labels for atom in binder_heavy_atoms[label]]
    structural_shell = set()
    if interface_atoms:
        interface_coords = [atom.coord for atom in interface_atoms]
        for label, atoms in binder_heavy_atoms.items():
            if label in interface:
                continue
            if _minimum_distance([atom.coord for atom in atoms], interface_coords) <= STRUCTURAL_SHELL_CUTOFF_ANGSTROM:
                structural_shell.add(label)
    shell = target_shell | structural_shell

    frequency_map = _load_contact_frequencies(contact_frequencies, contact_frequencies_path)
    binder_labels = [_residue_label(residue) for residue in binder_residues]
    binder_set = set(binder_labels)
    anchors = {label for label, frequency in (frequency_map or {}).items()
               if label in binder_set and frequency >= ANCHOR_FREQUENCY_CUTOFF}
    ordered = lambda values: [label for label in binder_labels if label in values]
    regions = {
        "interface": ordered(interface),
        "anchor": ordered(anchors),
        "shell": ordered(shell),
        "core": ordered(core),
        "surface": ordered(surface),
        "boundary": ordered(boundary),
        "target_shell": ordered(target_shell),
        "structural_shell": ordered(structural_shell),
        "interface_buried": ordered(interface_buried),
        # Redesign masks use this hard-freeze set; `interface` above is the union
        # for reporting and therefore can also include ΔSASA-only residues.
        "interface_contact": ordered(interface_contact),
    }
    residue_table = []
    for residue in binder_residues:
        label = _residue_label(residue)
        residue_table.append({
            "label": label,
            "chain": binder_chain,
            "resid": residue.id[1],
            "insertion_code": residue.id[2].strip(),
            "aa": aa_by_label[label],
            "sasa": round(sasa_by_label[label], 3),
            "rsasa": round(rsasa_by_label[label], 4),
            "structural_region": _structural_region(rsasa_by_label[label]),
            "min_target_dist": round(min_target_dist[label], 3),
            "interface_contact": label in interface_contact,
            "delta_sasa": round(delta_sasa[label], 3),
            "interface_buried": label in interface_buried,
            "target_shell": label in target_shell,
            "structural_shell": label in structural_shell,
            "anchor": label in anchors,
        })
    return {
        "regions": regions,
        "residue_table": residue_table,
        "binder_positions": binder_labels,
        "target_chains": target_ids,
        "counts": {name: len(labels) for name, labels in regions.items()},
    }


def _validate_positions(values, known, name):
    if values is None:
        return set()
    if not isinstance(values, list):
        raise ValueError(f"{name} must be an array of chain+residue labels")
    result = {str(value).strip() for value in values}
    if "" in result:
        raise ValueError(f"{name} contains an empty residue label")
    missing = sorted(result - known)
    if missing:
        raise ValueError(f"{name} contains residues not found in binder_chain: {missing}")
    return result


def build_redesign_plan(structure_path, binder_chain, mode="interface-refine", target_chain=None,
                        contact_frequencies=None, contact_frequencies_path=None,
                        fixed_positions=None, design_positions=None, **region_switches):
    if mode not in PRESET_TEMPERATURES:
        raise ValueError(f"invalid mode {mode!r}; choose one of {list(PRESET_TEMPERATURES)}")
    region_data = calculate_regions(
        structure_path, binder_chain, target_chain,
        contact_frequencies=contact_frequencies,
        contact_frequencies_path=contact_frequencies_path,
    )
    positions = region_data["binder_positions"]
    all_positions = set(positions)
    regions = region_data["regions"]
    effective_mode = mode
    degraded = False
    degraded_reason = None
    if mode == "anchor-preserving" and contact_frequencies is None and not contact_frequencies_path:
        effective_mode = "interface-refine"
        degraded = True
        degraded_reason = "no contact frequencies"

    interface = set(regions["interface_contact"])
    anchor = set(regions["anchor"])
    shell = set(regions["shell"])
    core = set(regions["core"])
    surface = set(regions["surface"])
    if effective_mode == "interface-refine":
        initially_designable = all_positions - interface
    elif effective_mode == "anchor-preserving":
        initially_designable = all_positions - anchor
    elif effective_mode == "scaffold-rescue":
        # Keep hard interface contacts and explicit anchors fixed; let MPNN repair
        # buried, boundary and exposed scaffold positions alike.
        initially_designable = all_positions - (interface | anchor)
    else:
        initially_designable = set(all_positions)

    region_sets = {
        "interface": interface,
        "shell": shell,
        "surface": surface,
        "core": core,
    }
    forced_fixed = set()
    forced_design = set()
    for name, residue_set in region_sets.items():
        value = region_switches.get(f"design_{name}")
        if value is None:
            continue
        if not isinstance(value, bool):
            raise ValueError(f"design_{name} must be a boolean")
        (forced_design if value else forced_fixed).update(residue_set)
    conflict = forced_fixed & forced_design
    if conflict:
        raise ValueError(f"conflicting region switches for residues: {sorted(conflict)}")
    initially_designable.difference_update(forced_fixed)
    initially_designable.update(forced_design)

    explicit_fixed = _validate_positions(fixed_positions, all_positions, "fixed_positions")
    explicit_design = _validate_positions(design_positions, all_positions, "design_positions")
    overlap = explicit_fixed & explicit_design
    if overlap:
        raise ValueError(f"fixed_positions and design_positions overlap: {sorted(overlap)}")
    initially_designable.difference_update(explicit_fixed)
    initially_designable.update(explicit_design)
    fixed = all_positions - initially_designable
    ordered = lambda values: [label for label in positions if label in values]

    return {
        "mode": effective_mode,
        "requested_mode": mode,
        "degraded": degraded,
        "degraded_reason": degraded_reason,
        "regions": regions,
        "residue_table": region_data["residue_table"],
        "binder_positions": positions,
        "counts": {
            **region_data["counts"],
            "binder": len(positions),
            "fixed": len(fixed),
            "design": len(initially_designable),
        },
        "fixed_positions": ordered(fixed),
        "design_positions": ordered(initially_designable),
        "target_chains": region_data["target_chains"],
    }


def write_fixed_residues(path, positions):
    """Write the whitespace-separated residue tokens accepted by LigandMPNN CLI."""
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(" ".join(positions) + "\n")
    return path


def run_redesign(args, data_root, default_out_dir):
    try:
        structure_path = args.get("structure_path")
        binder_chain = args.get("binder_chain")
        mode = args.get("mode") or "interface-refine"
        plan = build_redesign_plan(
            structure_path=structure_path,
            binder_chain=binder_chain,
            target_chain=args.get("target_chain"),
            mode=mode,
            contact_frequencies=args.get("contact_frequencies"),
            contact_frequencies_path=args.get("contact_frequencies_path"),
            fixed_positions=args.get("fixed_positions"),
            design_positions=args.get("design_positions"),
            **{key: args.get(key) for key in (
                "design_interface", "design_shell", "design_surface", "design_core")},
        )
        out_dir = args.get("out_dir") or default_out_dir("redesign")
        os.makedirs(out_dir, exist_ok=True)
        fixed_path = os.path.join(out_dir, "fixed_residues.txt")
        write_fixed_residues(fixed_path, plan["fixed_positions"])
        warnings = []
        if not plan["design_positions"]:
            warnings.append("当前设置下无可设计位点（design_positions 为空）：MPNN 将保留全部残基不变")

        model = args.get("model") or "soluble_mpnn"
        if model not in ("soluble_mpnn", "protein_mpnn"):
            return {"ok": False, "error": "model must be soluble_mpnn or protein_mpnn"}
        raw_n_sequences = args.get("n_sequences")
        n_sequences = 16 if raw_n_sequences is None else int(raw_n_sequences)
        if n_sequences < 1:
            return {"ok": False, "error": "n_sequences must be at least 1"}
        seed = int(args.get("seed") or 0)
        raw_batch_size = args.get("batch_size")
        batch_size = 1 if raw_batch_size is None else int(raw_batch_size)
        if batch_size < 1:
            return {"ok": False, "error": "batch_size must be at least 1"}
        temperature = args.get("temperature")
        if temperature is None:
            temperature = PRESET_TEMPERATURES[plan["mode"]]
        temperature = float(temperature)
        if not math.isfinite(temperature) or temperature <= 0:
            return {"ok": False, "error": "temperature must be a positive finite number"}

        from mpnn_design import design_sequences_with_masks
        mpnn_out_dir = os.path.join(out_dir, "mpnn")
        mpnn_result = design_sequences_with_masks(
            pdb=structure_path,
            out_dir=mpnn_out_dir,
            chains=str(binder_chain),
            fixed_residues=plan["fixed_positions"],
            redesigned_residues=plan["design_positions"],
            num_seqs=n_sequences,
            batch_size=batch_size,
            temperature=temperature,
            model=model,
            seed=seed,
            data_root=data_root,
        )
        if mpnn_result.get("ok") is False:
            return {"ok": False, "error": mpnn_result.get("error", "MPNN redesign failed"),
                    "mpnn": mpnn_result}

        native = (mpnn_result.get("native") or {}).get("seq") or ""
        designs = []
        for item in mpnn_result.get("designs", []):
            sequence = str(item.get("seq") or "")
            compared = min(len(native), len(sequence))
            mutations = sum(native[index] != sequence[index] for index in range(compared))
            mutations += abs(len(native) - len(sequence))
            core_mutation_fraction = _core_mutation_fraction(
                native, sequence, plan["binder_positions"], plan["regions"]["core"])
            designs.append({
                "design_id": item.get("id"),
                "sequence": sequence,
                "model": model,
                "temperature": temperature,
                "n_mutations_vs_wildtype": mutations,
                "redesigned_count": len(plan["design_positions"]),
                "core_mutation_fraction": round(core_mutation_fraction, 4),
            })
            if core_mutation_fraction > 0.35:
                warnings.append(
                    f"WARN: core_mutation_fraction={core_mutation_fraction:.4f} exceeds 0.35 for design {item.get('id')}"
                )

        meta_path = os.path.join(out_dir, "redesign_meta.json")
        metadata = {
            "structure_path": os.path.abspath(structure_path),
            "binder_chain": str(binder_chain),
            "target_chains": plan["target_chains"],
            "mode": plan["mode"],
            "requested_mode": plan["requested_mode"],
            "degraded": plan["degraded"],
            "degraded_reason": plan["degraded_reason"],
            "regions": plan["regions"],
            "residue_table": plan["residue_table"],
            "counts": plan["counts"],
            "fixed_positions": plan["fixed_positions"],
            "design_positions": plan["design_positions"],
            "model": model,
            "temperature": temperature,
            "seed": seed,
            "n_sequences_requested": n_sequences,
            "warnings": warnings,
            "designs": designs,
        }
        with open(meta_path, "w", encoding="utf-8") as fh:
            json.dump(metadata, fh, ensure_ascii=False, indent=2)

        return {
            "ok": True,
            **{key: plan[key] for key in (
                "mode", "requested_mode", "degraded", "degraded_reason", "regions", "residue_table", "counts")},
            "fixed_positions": plan["fixed_positions"],
            "design_positions": plan["design_positions"],
            "warnings": warnings,
            "designs": designs,
            "files": {
                "fasta": mpnn_result.get("fasta"),
                "meta_json": meta_path,
                "fixed_residues": fixed_path,
            },
            "out_dir": out_dir,
        }
    except Exception as exc:
        return {"ok": False, "error": f"{type(exc).__name__}: {exc}"}
