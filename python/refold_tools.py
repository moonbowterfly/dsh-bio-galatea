"""Single-chain ESMFold rescue check with sequence-aligned C-alpha metrics."""
import json
import math
import os


SS_METHOD = "dihedral-3state-v1"
VERDICT_THRESHOLDS = {
    "pass": {"monomer_ca_rmsd_max_angstrom": 2.0, "esmfold_plddt_mean_min": 0.80},
    "watch": {"monomer_ca_rmsd_max_angstrom": 3.5},
}
UNCALIBRATED_NOTES = "未校准：阈值仅供排序参考，须经 binder_eval 校准后方可作为过滤依据"


def _parse_structure(path):
    from Bio.PDB import MMCIFParser, PDBParser

    extension = os.path.splitext(path)[1].lower()
    parser = MMCIFParser(QUIET=True) if extension in (".cif", ".mmcif") else PDBParser(QUIET=True)
    structure = parser.get_structure("galatea_refold", path)
    return next(iter(structure))


def _protein_residues(chain):
    from Bio.PDB.Polypeptide import is_aa

    return [residue for residue in chain if is_aa(residue, standard=False)]


def _residue_label(residue):
    from struct_analysis import _residue_label as label_residue

    return label_residue(residue)


def _residue_sequence(residues):
    from struct_analysis import _aa1

    return "".join(_aa1(residue.resname) for residue in residues)


def _select_chain(model, requested_chain=None, allow_single_fallback=False, role="structure"):
    chains = {chain.id: chain for chain in model.get_chains()
              if _protein_residues(chain)}
    if requested_chain is not None and requested_chain in chains:
        return chains[requested_chain]
    if allow_single_fallback and len(chains) == 1:
        return next(iter(chains.values()))
    if requested_chain is None and len(chains) == 1:
        return next(iter(chains.values()))
    if requested_chain is not None:
        raise ValueError(f"{role} chain {requested_chain!r} not found; available protein chains: {list(chains)}")
    raise ValueError(f"{role} must contain exactly one protein chain when no chain is specified")


def extract_sequence(structure_path, chain_id):
    if not structure_path or not os.path.isfile(structure_path):
        raise ValueError(f"structure_path not found: {structure_path}")
    model = _parse_structure(structure_path)
    chain = _select_chain(model, chain_id, role="structure")
    sequence = _residue_sequence(_protein_residues(chain))
    if not sequence or "X" in sequence:
        raise ValueError(f"binder chain {chain_id!r} has no complete standard amino-acid sequence")
    return sequence


def classify_secondary_structure(chain):
    """Classify residues from phi/psi: H=(-57±30,-47±30), E=(-139±30,135±30), else C."""
    from Bio.PDB.Polypeptide import PPBuilder

    result = {}
    for peptide in PPBuilder().build_peptides(chain):
        for residue, (phi, psi) in zip(peptide, peptide.get_phi_psi_list()):
            if phi is None or psi is None:
                continue
            phi_deg, psi_deg = math.degrees(float(phi)), math.degrees(float(psi))
            # Use the conventional angle centers and a closed ±30 degree window.
            if abs(phi_deg - (-57.0)) <= 30.0 and abs(psi_deg - (-47.0)) <= 30.0:
                state = "helix"
            elif abs(phi_deg - (-139.0)) <= 30.0 and abs(psi_deg - 135.0) <= 30.0:
                state = "strand"
            else:
                state = "coil"
            result[residue] = state
    return result


def _sequence_alignment_pairs(reference_sequence, model_sequence):
    from Bio.Align import PairwiseAligner

    aligner = PairwiseAligner()
    aligner.mode = "global"
    aligner.match_score = 2.0
    aligner.mismatch_score = -1.0
    aligner.open_gap_score = -3.0
    aligner.extend_gap_score = -0.5
    alignment = aligner.align(reference_sequence, model_sequence)[0]
    pairs = []
    for (ref_start, ref_end), (model_start, model_end) in zip(*alignment.aligned):
        span = min(ref_end - ref_start, model_end - model_start)
        pairs.extend((ref_start + offset, model_start + offset) for offset in range(span))
    return pairs


def _percentile(values, percentile):
    if not values:
        return None
    values = sorted(values)
    position = (len(values) - 1) * percentile
    lower = int(math.floor(position))
    upper = int(math.ceil(position))
    if lower == upper:
        return values[lower]
    fraction = position - lower
    return values[lower] * (1.0 - fraction) + values[upper] * fraction


def _plddt_summary(chain):
    raw = [float(residue["CA"].get_bfactor()) for residue in _protein_residues(chain)
           if "CA" in residue]
    if not raw:
        return {"mean": None, "min": None, "p10": None, "p50": None}
    values = [value / 100.0 if value > 1.0 else value for value in raw]
    return {
        "mean": round(sum(values) / len(values), 4),
        "min": round(min(values), 4),
        "p10": round(_percentile(values, 0.10), 4),
        "p50": round(_percentile(values, 0.50), 4),
    }


def _ss_agreement(reference_chain, model_chain, residue_pairs):
    reference_ss = classify_secondary_structure(reference_chain)
    model_ss = classify_secondary_structure(model_chain)
    paired_states = []
    for ref_index, model_index, ref_residue, model_residue in residue_pairs:
        ref_state = reference_ss.get(ref_residue)
        model_state = model_ss.get(model_residue)
        if ref_state is not None and model_state is not None:
            paired_states.append((ref_state, model_state))
    by_state = {}
    for state in ("helix", "strand", "coil"):
        ref_items = [model_state for ref_state, model_state in paired_states if ref_state == state]
        by_state[state] = round(sum(item == state for item in ref_items) / len(ref_items), 4) if ref_items else None
    by_state["overall"] = (round(sum(ref_state == model_state for ref_state, model_state in paired_states) /
                                  len(paired_states), 4) if paired_states else None)
    return by_state


def compare_structures(reference_path, model_path, reference_chain=None, model_chain=None,
                       allow_reference_single_fallback=False):
    """Align C-alpha atoms by global sequence alignment and calculate refold metrics."""
    for path, label in ((reference_path, "reference"), (model_path, "folded model")):
        if not path or not os.path.isfile(path):
            raise ValueError(f"{label} structure not found: {path}")
    reference_model = _parse_structure(reference_path)
    folded_model = _parse_structure(model_path)
    reference = _select_chain(reference_model, reference_chain,
                              allow_single_fallback=allow_reference_single_fallback,
                              role="reference")
    predicted = _select_chain(folded_model, model_chain, role="folded model")
    reference_residues = _protein_residues(reference)
    predicted_residues = _protein_residues(predicted)
    reference_sequence = _residue_sequence(reference_residues)
    predicted_sequence = _residue_sequence(predicted_residues)
    index_pairs = _sequence_alignment_pairs(reference_sequence, predicted_sequence)
    atom_pairs = []
    labeled_pairs = []
    for ref_index, model_index in index_pairs:
        ref_residue = reference_residues[ref_index]
        model_residue = predicted_residues[model_index]
        if "CA" not in ref_residue or "CA" not in model_residue:
            continue
        atom_pairs.append((ref_residue["CA"], model_residue["CA"]))
        labeled_pairs.append((ref_index, model_index, ref_residue, model_residue))
    if not atom_pairs:
        raise ValueError("no sequence-aligned C-alpha atoms are available")

    from Bio.PDB import Superimposer
    superimposer = Superimposer()
    superimposer.set_atoms([pair[0] for pair in atom_pairs], [pair[1] for pair in atom_pairs])
    # Apply the rigid transform to the whole chain so backbone dihedrals remain intact
    # for the secondary-structure comparison below.
    superimposer.apply(list(predicted.get_atoms()))
    deviations = []
    for (ref_atom, model_atom), (_, _, ref_residue, _) in zip(atom_pairs, labeled_pairs):
        deviation = float(ref_atom - model_atom)
        deviations.append({"residue": _residue_label(ref_residue), "deviation": deviation})
    deviations.sort(key=lambda item: (-item["deviation"], item["residue"]))

    plddt = _plddt_summary(predicted)
    rmsd = float(superimposer.rms)
    fraction_ca_within_2a = sum(item["deviation"] <= 2.0 for item in deviations) / len(atom_pairs)
    warnings = []
    if len(reference_residues) != len(predicted_residues):
        warnings.append("reference and folded sequence lengths differ; metrics use sequence-aligned C-alpha pairs")
    if len(atom_pairs) < min(len(reference_residues), len(predicted_residues)):
        warnings.append("some aligned residues lack a C-alpha atom and were omitted")
    metrics = {
        "monomer_ca_rmsd": round(rmsd, 4),
        "fraction_ca_within_2A": round(fraction_ca_within_2a, 4),
        "n_aligned": len(atom_pairs),
        "length_ref": len(reference_residues),
        "length_model": len(predicted_residues),
        "esmfold_plddt": plddt,
        "ss_agreement": _ss_agreement(reference, predicted, labeled_pairs),
        "ss_method": SS_METHOD,
        "top_deviations": [
            {"residue": item["residue"], "deviation": round(item["deviation"], 3)}
            for item in deviations[:10]
        ],
        "warnings": warnings,
    }
    if rmsd <= VERDICT_THRESHOLDS["pass"]["monomer_ca_rmsd_max_angstrom"] and \
            plddt["mean"] is not None and plddt["mean"] >= VERDICT_THRESHOLDS["pass"]["esmfold_plddt_mean_min"]:
        tier = "pass"
    elif rmsd <= VERDICT_THRESHOLDS["watch"]["monomer_ca_rmsd_max_angstrom"]:
        tier = "watch"
    else:
        tier = "rescue_suggested"
    verdict = {
        "tier": tier,
        "thresholds": VERDICT_THRESHOLDS,
        "calibrated": False,
        "notes": UNCALIBRATED_NOTES,
    }
    return {"metrics": metrics, "verdict": verdict}


def run_refold(args, data_root, default_out_dir):
    try:
        structure_path = args.get("structure_path")
        binder_chain = args.get("binder_chain")
        if not structure_path or not os.path.isfile(structure_path):
            return {"ok": False, "error": f"structure_path not found: {structure_path}"}
        if binder_chain is None or str(binder_chain).strip() == "":
            return {"ok": False, "error": "binder_chain is required"}
        binder_chain = str(binder_chain).strip()
        reference_path = args.get("reference_binder_path") or structure_path
        if not os.path.isfile(reference_path):
            return {"ok": False, "error": f"reference_binder_path not found: {reference_path}"}

        complex_model = _parse_structure(structure_path)
        complex_chains = {chain.id: chain for chain in complex_model.get_chains()
                          if _protein_residues(chain)}
        if len(complex_chains) < 2:
            return {"ok": False, "error": "structure_path must contain binder and target protein chains"}
        complex_binder = _select_chain(complex_model, binder_chain, role="complex")
        reference_model = _parse_structure(reference_path)
        _select_chain(
            reference_model,
            binder_chain,
            allow_single_fallback=bool(args.get("reference_binder_path")),
            role="reference",
        )

        sequence = args.get("sequence")
        if sequence is None or not str(sequence).strip():
            sequence = _residue_sequence(_protein_residues(complex_binder))
            if not sequence or "X" in sequence:
                return {"ok": False, "error": f"binder chain {binder_chain!r} has no complete standard amino-acid sequence"}
        else:
            sequence = "".join(str(sequence).split()).upper()
            if not sequence or any(letter not in "ACDEFGHIKLMNPQRSTVWY" for letter in sequence):
                return {"ok": False, "error": "sequence must contain standard one-letter amino-acid codes only"}
        keep_pdb = args.get("keep_pdb", True)
        if not isinstance(keep_pdb, bool):
            return {"ok": False, "error": "keep_pdb must be a boolean"}

        out_dir = args.get("out_dir") or default_out_dir("refold")
        os.makedirs(out_dir, exist_ok=True)
        from fold_esm import fold_sequences
        previous_no_bytecode = os.environ.get("PYTHONDONTWRITEBYTECODE")
        os.environ["PYTHONDONTWRITEBYTECODE"] = "1"
        try:
            fold_result = fold_sequences([sequence], out_dir=out_dir, device="auto", data_root=data_root)
        finally:
            if previous_no_bytecode is None:
                os.environ.pop("PYTHONDONTWRITEBYTECODE", None)
            else:
                os.environ["PYTHONDONTWRITEBYTECODE"] = previous_no_bytecode
        results = fold_result.get("results") or []
        if fold_result.get("status") != "ok" or not results or not results[0].get("pdb"):
            return {
                "ok": False,
                "error": "ESMFold did not produce a folded structure",
                "fold": fold_result,
            }
        folded_path = results[0]["pdb"]
        comparison = compare_structures(
            reference_path,
            folded_path,
            reference_chain=binder_chain,
            allow_reference_single_fallback=bool(args.get("reference_binder_path")),
        )
        metrics_path = os.path.join(out_dir, "refold_metrics.json")
        files = {
            "folded_structure": folded_path if keep_pdb else None,
            "metrics_json": metrics_path,
        }
        if not keep_pdb:
            try:
                os.remove(folded_path)
            except OSError as exc:
                return {"ok": False, "error": f"could not remove folded structure: {exc}"}
        payload = {
            "ok": True,
            "metrics": comparison["metrics"],
            "verdict": comparison["verdict"],
            "files": files,
        }
        with open(metrics_path, "w", encoding="utf-8") as fh:
            json.dump(payload, fh, ensure_ascii=False, indent=2)
        return payload
    except Exception as exc:
        return {"ok": False, "error": f"{type(exc).__name__}: {exc}"}
