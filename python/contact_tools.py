"""Deterministic residue/pair contact consensus across predicted complex models."""
import glob as globlib
import json
import math
import os
import re
import statistics
import tempfile


DEFAULT_CUTOFF_ANGSTROM = 4.0
SUPPORTED_EXTENSIONS = {".pdb", ".ent", ".cif", ".mmcif"}
ANCHOR_CONTACT_FREQUENCY = 0.70
ANCHOR_PAIR_FREQUENCY = 0.50


def _protein_residues(chain):
    from Bio.PDB.Polypeptide import is_aa

    return [residue for residue in chain if is_aa(residue, standard=False)]


def _is_heavy(atom):
    element = (atom.element or "").strip().upper()
    atom_name = atom.get_name().strip().upper().lstrip("0123456789")
    return element not in ("H", "D") and not atom_name.startswith("H")


def _residue_label(residue):
    chain = residue.get_parent().id
    return f"{chain}{residue.id[1]}{residue.id[2].strip()}"


def _parse_chain_ids(value, name):
    if value is None or value == "":
        return None
    if isinstance(value, (list, tuple)):
        result = [str(item).strip() for item in value if str(item).strip()]
    else:
        result = [part.strip() for part in str(value).split(",") if part.strip()]
    if not result:
        raise ValueError(f"{name} must contain at least one chain ID")
    if len(result) != len(set(result)):
        raise ValueError(f"{name} chain IDs must be unique")
    return result


def _parse_model(path):
    from Bio.PDB import MMCIFParser, PDBParser

    extension = os.path.splitext(path)[1].lower()
    if extension not in SUPPORTED_EXTENSIONS:
        raise ValueError(f"unsupported structure extension {extension!r}; expected PDB or CIF")
    if extension in (".cif", ".mmcif"):
        parser = MMCIFParser(QUIET=True)
        try:
            structure = parser.get_structure("galatea_contact_consensus", path)
        except KeyError as exc:
            if exc.args != ("_atom_site.occupancy",):
                raise
            structure = _parse_mmcif_without_occupancy(path, MMCIFParser)
    else:
        structure = PDBParser(QUIET=True).get_structure("galatea_contact_consensus", path)
    return next(iter(structure))


def _parse_mmcif_without_occupancy(path, parser_type):
    """Parse valid atom_site loops that omit the optional occupancy column."""
    with open(path, "r", encoding="utf-8") as handle:
        lines = handle.readlines()

    atom_headers = None
    data_start = None
    for index, line in enumerate(lines):
        if line.strip().lower() != "loop_":
            continue
        headers = []
        cursor = index + 1
        while cursor < len(lines) and lines[cursor].lstrip().startswith("_"):
            headers.append(lines[cursor].strip().split()[0])
            cursor += 1
        if any(header.startswith("_atom_site.") for header in headers):
            atom_headers = headers
            data_start = cursor
            break
    if atom_headers is None or "_atom_site.occupancy" in atom_headers:
        raise ValueError("could not normalize CIF atom_site occupancy column")

    rows_end = data_start
    while rows_end < len(lines):
        stripped = lines[rows_end].strip()
        if not stripped:
            rows_end += 1
            continue
        if stripped.startswith("#") or stripped.lower() == "loop_" or stripped.startswith("_") or stripped.lower().startswith(("data_", "save_")):
            break
        row = lines[rows_end]
        tokens = re.findall(r"\S+", row.rstrip("\r\n"))
        if len(tokens) != len(atom_headers):
            raise ValueError("cannot add default CIF occupancy: atom_site rows must contain one value per column")
        newline = "\r\n" if row.endswith("\r\n") else "\n" if row.endswith("\n") else ""
        lines[rows_end] = row[:-len(newline)] + " 1.0" + newline if newline else row + " 1.0"
        rows_end += 1

    if rows_end == data_start:
        raise ValueError("cannot add default CIF occupancy: atom_site loop has no rows")
    header_newline = "\r\n" if lines[data_start - 1].endswith("\r\n") else "\n"
    lines.insert(data_start, "_atom_site.occupancy" + header_newline)
    with tempfile.TemporaryDirectory(prefix="galatea-contact-cif-") as temp_dir:
        normalized_path = os.path.join(temp_dir, os.path.basename(path))
        with open(normalized_path, "w", encoding="utf-8", newline="") as handle:
            handle.writelines(lines)
        structure = parser_type(QUIET=True).get_structure("galatea_contact_consensus", normalized_path)
    return structure


def _resolve_chains(model, binder_chain=None, target_chain=None):
    protein_chains = {
        chain.id: chain for chain in model.get_chains()
        if _protein_residues(chain)
    }
    if len(protein_chains) < 2:
        raise ValueError(f"model must contain at least two protein chains; found {list(protein_chains)}")

    binder_id = str(binder_chain).strip() if binder_chain is not None and str(binder_chain).strip() else None
    target_ids = _parse_chain_ids(target_chain, "target_chain")
    if binder_id is not None and binder_id not in protein_chains:
        raise ValueError(f"binder chain {binder_id!r} not found; available protein chains: {list(protein_chains)}")
    if target_ids is not None:
        missing = [chain_id for chain_id in target_ids if chain_id not in protein_chains]
        if missing:
            raise ValueError(f"target chain(s) not found: {missing}; available protein chains: {list(protein_chains)}")

    if binder_id is None:
        candidates = [chain_id for chain_id in protein_chains if target_ids is None or chain_id not in target_ids]
        if not candidates:
            raise ValueError("could not infer binder_chain: no protein chain remains outside target_chain")
        if len(candidates) == 1:
            binder_id = candidates[0]
        else:
            shortest = min(len(_protein_residues(protein_chains[chain_id])) for chain_id in candidates)
            shortest_ids = [chain_id for chain_id in candidates
                            if len(_protein_residues(protein_chains[chain_id])) == shortest]
            if len(shortest_ids) != 1:
                raise ValueError(f"could not infer binder_chain unambiguously; candidate chains: {candidates}")
            binder_id = shortest_ids[0]

    if target_ids is None:
        target_ids = [chain_id for chain_id in protein_chains if chain_id != binder_id]
    if binder_id in target_ids:
        raise ValueError("binder_chain must not be included in target_chain")
    if not target_ids:
        raise ValueError("target_chain must contain at least one chain besides binder_chain")
    return protein_chains[binder_id], [protein_chains[chain_id] for chain_id in target_ids], target_ids


def _minimum_distance(atom_coords, other_coords):
    import numpy as np

    left = np.asarray(atom_coords, dtype=float)
    right = np.asarray(other_coords, dtype=float)
    delta = left[:, None, :] - right[None, :, :]
    return float(np.sqrt(np.sum(delta * delta, axis=2)).min())


def _analyze_model(path, binder_chain, target_chain, cutoff):
    from Bio.PDB import NeighborSearch

    model = _parse_model(path)
    binder, targets, target_ids = _resolve_chains(model, binder_chain, target_chain)
    binder_residues = _protein_residues(binder)
    target_residues = [residue for chain in targets for residue in _protein_residues(chain)]
    binder_atoms_by_label = {
        _residue_label(residue): [atom for atom in residue.get_atoms() if _is_heavy(atom)]
        for residue in binder_residues
    }
    target_atoms = [atom for residue in target_residues for atom in residue.get_atoms() if _is_heavy(atom)]
    if not target_atoms or any(not atoms for atoms in binder_atoms_by_label.values()):
        raise ValueError("binder or target chain has no heavy atoms")

    target_coords = [atom.coord for atom in target_atoms]
    target_search = NeighborSearch(target_atoms)
    edges = set()
    min_distances = {}
    for residue in binder_residues:
        binder_label = _residue_label(residue)
        binder_atoms = binder_atoms_by_label[binder_label]
        min_distances[binder_label] = _minimum_distance([atom.coord for atom in binder_atoms], target_coords)
        for atom in binder_atoms:
            for target_atom in target_search.search(atom.coord, cutoff, level="A"):
                edges.add((binder_label, _residue_label(target_atom.get_parent())))

    binder_order = [_residue_label(residue) for residue in binder_residues]
    target_order = [_residue_label(residue) for residue in target_residues]
    return {
        "path": os.path.abspath(path),
        "binder_chain": binder.id,
        "target_chains": target_ids,
        "binder_order": binder_order,
        "target_order": target_order,
        "edges": edges,
        "min_distances": min_distances,
    }


def _jaccard(left, right):
    union = left | right
    # Treat identical empty sets as identical; a model pair with one empty set
    # still scores zero and can never supply anchor contacts.
    return len(left & right) / len(union) if union else 1.0


def _mean_min(values):
    return round(sum(values) / len(values), 4) if values else None


def _ordered_union(model_rows, key):
    ordering = {}
    for row in model_rows:
        for index, label in enumerate(row[key]):
            ordering.setdefault(label, index)
    return sorted(ordering, key=lambda label: (ordering[label], label))


def _remap_label(label, chain_mapping):
    for source_chain in sorted(chain_mapping, key=lambda value: (-len(value), value)):
        if label.startswith(source_chain):
            return f"{chain_mapping[source_chain]}{label[len(source_chain):]}"
    return label


def _normalize_auto_chain_labels(labels, model_rows, auto_binder, auto_target, requested_target_ids):
    """Align residue labels by chain role when auto-detection finds changing IDs."""
    reference = model_rows[0]
    canonical_binder = reference["binder_chain"] if auto_binder else model_rows[0]["binder_chain"]
    canonical_targets = list(requested_target_ids or reference["target_chains"])
    canonical_targets_sorted = sorted(canonical_targets, key=lambda value: (value.casefold(), value))
    mappings = {}
    for model_id, row in zip(labels, model_rows):
        binder_label = canonical_binder if auto_binder else row["binder_chain"]
        binder_mapping = {row["binder_chain"]: binder_label}
        if auto_target:
            source_targets_sorted = sorted(row["target_chains"], key=lambda value: (value.casefold(), value))
            if len(source_targets_sorted) != len(canonical_targets_sorted):
                raise ValueError("auto-detected target chain count changed between models")
            target_mapping = dict(zip(source_targets_sorted, canonical_targets_sorted))
        else:
            target_mapping = {chain_id: chain_id for chain_id in row["target_chains"]}
        chain_mapping = {**binder_mapping, **target_mapping}

        row["binder_order"] = [_remap_label(label, chain_mapping) for label in row["binder_order"]]
        row["target_order"] = [_remap_label(label, chain_mapping) for label in row["target_order"]]
        row["min_distances"] = {
            _remap_label(label, chain_mapping): distance
            for label, distance in row["min_distances"].items()
        }
        row["edges"] = {
            (_remap_label(binder, chain_mapping), _remap_label(target, chain_mapping))
            for binder, target in row["edges"]
        }
        mappings[model_id] = {
            "binder_chain": {"source": row["binder_chain"], "canonical": binder_label},
            "target_chains": {
                source: target_mapping[source] for source in row["target_chains"]
            },
        }
    return mappings, {
        "model": labels[0],
        "binder_chain": canonical_binder,
        "target_chains": canonical_targets,
    }


def _model_ids(paths):
    names = [os.path.basename(path) for path in paths]
    frequencies = {name: names.count(name) for name in names}
    ids = []
    for path, name in zip(paths, names):
        if frequencies[name] == 1:
            ids.append(name)
        else:
            ids.append(os.path.join(os.path.basename(os.path.dirname(path)), name).replace("\\", "/"))
    if len(ids) != len(set(ids)):
        ids = [path.replace("\\", "/") for path in paths]
    return ids


def _resolve_model_paths(args):
    models = args.get("models")
    models_dir = args.get("models_dir")
    if models is not None and models_dir:
        raise ValueError("provide models or models_dir, not both")
    if models is not None:
        if not isinstance(models, list):
            raise ValueError("models must be a list of file paths")
        paths = [os.path.abspath(os.path.expanduser(str(path))) for path in models if str(path).strip()]
    elif models_dir:
        directory = os.path.abspath(os.path.expanduser(str(models_dir)))
        if not os.path.isdir(directory):
            raise ValueError(f"models_dir not found: {directory}")
        patterns = args.get("glob") or ["*.pdb", "*.ent", "*.cif", "*.mmcif"]
        if isinstance(patterns, str):
            patterns = [patterns]
        if not isinstance(patterns, list) or not patterns or any(not str(pattern).strip() for pattern in patterns):
            raise ValueError("glob must be a non-empty pattern string or list of patterns")
        paths = []
        for pattern in patterns:
            paths.extend(globlib.glob(os.path.join(directory, str(pattern)), recursive=True))
        paths = [os.path.abspath(path) for path in paths if os.path.isfile(path)]
    else:
        raise ValueError("provide models or models_dir with glob")
    paths = sorted(paths, key=lambda path: (os.path.basename(path).casefold(), os.path.basename(path), path.casefold(), path))
    if not paths:
        raise ValueError("no model files found")
    return paths


def _default_candidate_id(args, paths):
    explicit = args.get("candidate_id")
    if explicit is not None and str(explicit).strip():
        return str(explicit).strip()
    if args.get("models_dir"):
        directory = os.path.abspath(str(args["models_dir"]))
    else:
        directory = os.path.commonpath([os.path.dirname(path) for path in paths])
    return os.path.basename(directory.rstrip(os.sep)) or "candidate"


def _default_artifact_path(args, paths, candidate_id):
    explicit = args.get("artifact_path")
    if explicit is not None and not str(explicit).strip():
        raise ValueError("artifact_path must not be empty")
    if explicit:
        return os.path.abspath(os.path.expanduser(str(explicit)))
    if args.get("models_dir"):
        directory = os.path.abspath(str(args["models_dir"]))
    else:
        directory = os.path.commonpath([os.path.dirname(path) for path in paths])
    safe_id = "".join(char if char.isalnum() or char in "-_." else "_" for char in candidate_id)
    return os.path.join(directory, f"contact_consensus_{safe_id}_jaccard.json")


def _write_artifact(path, payload):
    directory = os.path.dirname(path)
    os.makedirs(directory, exist_ok=True)
    temp_path = None
    try:
        with tempfile.NamedTemporaryFile("w", encoding="utf-8", newline="\n", dir=directory,
                                         prefix=os.path.basename(path) + ".", suffix=".tmp", delete=False) as fh:
            temp_path = fh.name
            json.dump(payload, fh, ensure_ascii=False, indent=2)
            fh.write("\n")
        os.replace(temp_path, path)
    finally:
        if temp_path and os.path.exists(temp_path):
            try:
                os.remove(temp_path)
            except OSError:
                pass


def run_contact_consensus(args):
    """Summarize residue contacts and pairwise interface stability without ranking."""
    try:
        if not isinstance(args, dict):
            return {"ok": False, "error": "args must be an object"}
        cutoff = args.get("cutoff", DEFAULT_CUTOFF_ANGSTROM)
        if isinstance(cutoff, bool):
            return {"ok": False, "error": "cutoff must be a positive finite number"}
        try:
            cutoff = float(cutoff)
        except (TypeError, ValueError):
            return {"ok": False, "error": "cutoff must be a positive finite number"}
        if not math.isfinite(cutoff) or cutoff <= 0:
            return {"ok": False, "error": "cutoff must be a positive finite number"}

        binder_chain = args.get("binder_chain")
        if binder_chain is not None and not str(binder_chain).strip():
            binder_chain = None
        target_chain = args.get("target_chain")
        if target_chain is not None and target_chain == "":
            target_chain = None
        # Validate the scalar/list shape before attempting any structure parsing.
        if binder_chain is not None and isinstance(binder_chain, (list, tuple, dict)):
            return {"ok": False, "error": "binder_chain must be one chain ID"}
        requested_target_ids = _parse_chain_ids(target_chain, "target_chain")
        auto_binder = binder_chain is None
        auto_target = requested_target_ids is None
        paths = _resolve_model_paths(args)
        canonical_paths = [os.path.normcase(os.path.realpath(path)) for path in paths]
        if len(canonical_paths) != len(set(canonical_paths)):
            return {"ok": False, "error": "models contains duplicate file paths"}

        valid = []
        errors = []
        for path in paths:
            try:
                valid.append(_analyze_model(path, binder_chain, target_chain, cutoff))
            except Exception as exc:
                errors.append({"model": os.path.basename(path), "error": f"{type(exc).__name__}: {exc}"})
        expected_models = len(paths)
        valid_models = len(valid)
        if valid_models == 0:
            first_error = errors[0]["error"] if errors else "no models were parsed"
            return {
                "ok": False,
                "error": f"no valid models ({expected_models} expected): {first_error}",
                "coverage": {"expected_models": expected_models, "valid_models": 0},
                "model_errors": errors,
            }

        if valid_models >= 8:
            status = "PASS"
        elif valid_models >= 6:
            status = "WARN"
        else:
            status = "INSUFFICIENT"
        labels = _model_ids([row["path"] for row in valid])
        # Rebuild the rows in model-ID order (model IDs are derived from sorted paths,
        # but this also makes duplicate-basename handling explicit and deterministic).
        id_rows = sorted(zip(labels, valid), key=lambda pair: (pair[0].casefold(), pair[0]))
        labels = [pair[0] for pair in id_rows]
        valid = [pair[1] for pair in id_rows]
        chain_label_mappings, canonical_chain_assignment = _normalize_auto_chain_labels(
            labels, valid, auto_binder, auto_target, requested_target_ids)

        binder_labels = _ordered_union(valid, "binder_order")
        target_labels = _ordered_union(valid, "target_order")
        binder_order = {label: index for index, label in enumerate(binder_labels)}
        target_order = {label: index for index, label in enumerate(target_labels)}
        pair_counts = {}
        binder_counts = {label: 0 for label in binder_labels}
        target_counts = {label: 0 for label in target_labels}
        residue_sets = []
        edge_sets = []
        all_min_distances = {label: [] for label in binder_labels}
        for row in valid:
            edges = row["edges"]
            binder_contacted = {binder for binder, _ in edges}
            target_contacted = {target for _, target in edges}
            for edge in edges:
                pair_counts[edge] = pair_counts.get(edge, 0) + 1
            for label in binder_contacted:
                binder_counts[label] += 1
            for label in target_contacted:
                target_counts[label] += 1
            residue_sets.append(binder_contacted | target_contacted)
            edge_sets.append(edges)
            for label, distance in row["min_distances"].items():
                all_min_distances.setdefault(label, []).append(distance)

        pair_frequency = {edge: count / valid_models for edge, count in pair_counts.items()}
        max_pair_frequency = {label: 0.0 for label in binder_labels}
        for (binder_label, _), frequency in pair_frequency.items():
            max_pair_frequency[binder_label] = max(max_pair_frequency.get(binder_label, 0.0), frequency)
        binder_residues = {}
        contact_frequencies = {}
        anchor_residues = []
        for label in sorted(binder_labels, key=lambda value: (binder_order[value], value)):
            contact_frequency = binder_counts.get(label, 0) / valid_models
            max_frequency = max_pair_frequency.get(label, 0.0)
            is_anchor = status != "INSUFFICIENT" and \
                contact_frequency >= ANCHOR_CONTACT_FREQUENCY and max_frequency >= ANCHOR_PAIR_FREQUENCY
            distances = all_min_distances.get(label, [])
            median_distance = statistics.median(distances) if distances else None
            binder_residues[label] = {
                "contact_freq": round(contact_frequency, 4),
                "max_pair_freq": round(max_frequency, 4),
                "median_min_dist_A": round(median_distance, 3) if median_distance is not None else None,
                "anchor": is_anchor,
            }
            contact_frequencies[label] = round(contact_frequency, 4)
            if is_anchor:
                anchor_residues.append(label)

        target_residues = {
            label: {"contact_freq": round(target_counts[label] / valid_models, 4)}
            for label in sorted(target_labels, key=lambda value: (target_order[value], value))
            if target_counts[label] > 0
        }
        pair_contacts = {
            f"{binder}|{target}": round(frequency, 4)
            for (binder, target), frequency in sorted(
                pair_frequency.items(),
                key=lambda item: (binder_order[item[0][0]], target_order[item[0][1]], item[0]),
            )
        }

        residue_matrix = {}
        edge_matrix = {}
        residue_values = []
        edge_values = []
        for i, model_id in enumerate(labels):
            residue_matrix[model_id] = {}
            edge_matrix[model_id] = {}
            for j, other_id in enumerate(labels):
                residue_score = _jaccard(residue_sets[i], residue_sets[j])
                edge_score = _jaccard(edge_sets[i], edge_sets[j])
                residue_matrix[model_id][other_id] = round(residue_score, 4)
                edge_matrix[model_id][other_id] = round(edge_score, 4)
                if i < j:
                    residue_values.append(residue_score)
                    edge_values.append(edge_score)
        jaccard = {
            "residue_mean": _mean_min(residue_values),
            "residue_min": round(min(residue_values), 4) if residue_values else None,
            "edge_mean": _mean_min(edge_values),
            "edge_min": round(min(edge_values), 4) if edge_values else None,
        }
        candidate_id = _default_candidate_id(args, paths)
        artifact_path = _default_artifact_path(args, paths, candidate_id)
        artifact = {
            "schema_version": "1.0",
            "candidate_id": candidate_id,
            "canonical_chain_assignment": canonical_chain_assignment,
            "models": [
                {
                    "model": model_id,
                    "path": row["path"],
                    "binder_chain": row["binder_chain"],
                    "target_chains": row["target_chains"],
                    "chain_label_mapping": chain_label_mappings[model_id],
                }
                for model_id, row in zip(labels, valid)
            ],
            "chain_label_mappings": chain_label_mappings,
            "residue_jaccard": residue_matrix,
            "edge_jaccard": edge_matrix,
        }
        _write_artifact(artifact_path, artifact)
        chain_assignments = {
            model_id: {"binder_chain": row["binder_chain"], "target_chains": row["target_chains"]}
            for model_id, row in zip(labels, valid)
        }
        result = {
            "schema_version": "1.0",
            "candidate_id": candidate_id,
            "params": {
                "heavy_atom_cutoff_A": cutoff,
                "binder_chain": str(binder_chain).strip() if binder_chain is not None else "auto",
                "target_chain": target_chain if target_chain is not None else "auto",
            },
            "coverage": {"expected_models": expected_models, "valid_models": valid_models},
            "binder_residues": binder_residues,
            "target_residues": target_residues,
            "pair_contacts": pair_contacts,
            "jaccard": jaccard,
            "anchor_residues": anchor_residues if status != "INSUFFICIENT" else [],
            "contact_frequencies": contact_frequencies,
            "status": status,
            "model_ids": labels,
            "chain_assignments": chain_assignments,
            "canonical_chain_assignment": canonical_chain_assignment,
            "chain_label_mappings": chain_label_mappings,
            "model_errors": errors,
            "artifact_path": artifact_path,
        }
        return {"ok": True, "result": result}
    except (OSError, TypeError, ValueError) as exc:
        return {"ok": False, "error": str(exc)}
    except Exception as exc:
        return {"ok": False, "error": f"{type(exc).__name__}: {exc}"}
