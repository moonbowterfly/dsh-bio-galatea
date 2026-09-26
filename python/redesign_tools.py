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
SHELL_CUTOFF_ANGSTROM = 8.0
CORE_SASA_CUTOFF_ANGSTROM2 = 20.0
ANCHOR_FREQUENCY_CUTOFF = 0.7


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
    return element != "H" and not atom.get_name().strip().upper().startswith("H")


def _protein_residues(chain):
    from Bio.PDB.Polypeptide import is_aa

    return [residue for residue in chain if is_aa(residue, standard=False)]


def _residue_label(residue):
    from struct_analysis import _residue_label as label_residue

    return label_residue(residue)


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
    """Calculate deterministic binder regions using heavy-atom neighbors and per-residue SASA."""
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

    # NeighborSearch mirrors struct_analysis.py. Target atoms are indexed once, then
    # each binder atom is queried at the two task-defined cutoffs.
    from Bio.PDB import NeighborSearch
    target_search = NeighborSearch(target_atoms)
    interface = set()
    near_target = set()
    for residue in binder_residues:
        label = _residue_label(residue)
        for atom in residue.get_atoms():
            if not _is_heavy(atom):
                continue
            if target_search.search(atom.coord, INTERFACE_CUTOFF_ANGSTROM, level="A"):
                interface.add(label)
                near_target.add(label)
            elif target_search.search(atom.coord, SHELL_CUTOFF_ANGSTROM, level="A"):
                near_target.add(label)

    # Shrake-Rupley at residue level assigns SASA to each residue in the complex.
    from Bio.PDB.SASA import ShrakeRupley
    ShrakeRupley().compute(model, level="R")
    core = set()
    surface = set()
    for residue in binder_residues:
        label = _residue_label(residue)
        sasa = getattr(residue, "sasa", None)
        if sasa is None or not math.isfinite(float(sasa)):
            raise ValueError(f"SASA unavailable for binder residue {label}")
        (core if float(sasa) < CORE_SASA_CUTOFF_ANGSTROM2 else surface).add(label)

    frequency_map = _load_contact_frequencies(contact_frequencies, contact_frequencies_path)
    binder_labels = [_residue_label(residue) for residue in binder_residues]
    binder_set = set(binder_labels)
    anchors = {label for label, frequency in (frequency_map or {}).items()
               if label in binder_set and frequency >= ANCHOR_FREQUENCY_CUTOFF}
    shell = near_target - interface
    ordered = lambda values: [label for label in binder_labels if label in values]
    regions = {
        "interface": ordered(interface),
        "anchor": ordered(anchors),
        "shell": ordered(shell),
        "core": ordered(core),
        "surface": ordered(surface),
    }
    return {
        "regions": regions,
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

    interface = set(regions["interface"])
    anchor = set(regions["anchor"])
    shell = set(regions["shell"])
    core = set(regions["core"])
    surface = set(regions["surface"])
    if effective_mode == "interface-refine":
        initially_designable = all_positions - interface
    elif effective_mode == "anchor-preserving":
        initially_designable = all_positions - anchor
    elif effective_mode == "scaffold-rescue":
        # Interface/core freezing wins where the disjoint geometric partitions overlap.
        initially_designable = (shell | surface) - (interface | core)
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
            designs.append({
                "design_id": item.get("id"),
                "sequence": sequence,
                "model": model,
                "temperature": temperature,
                "n_mutations_vs_wildtype": mutations,
                "redesigned_count": len(plan["design_positions"]),
            })

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
                "mode", "requested_mode", "degraded", "degraded_reason", "regions", "counts")},
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
