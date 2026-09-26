"""Deterministic target-side contact footprint and pose clustering."""
import glob as globlib
import hashlib
import json
import math
import os
import tempfile


DEFAULT_JACCARD_THRESHOLD = 0.70
DEFAULT_COSINE_THRESHOLD = 0.80
DEFAULT_ARTIFACT_GLOB = "contact_consensus_*.json"
DEFAULT_CONTACT_CUTOFF_ANGSTROM = 4.0


def _number(value, name):
    if isinstance(value, bool):
        raise ValueError(f"{name} must be a finite number between 0 and 1")
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        raise ValueError(f"{name} must be a finite number between 0 and 1")
    if not math.isfinite(parsed) or parsed < 0 or parsed > 1:
        raise ValueError(f"{name} must be a finite number between 0 and 1")
    return parsed


def _resolve_artifact_paths(args):
    artifacts = args.get("artifacts")
    artifacts_dir = args.get("artifacts_dir")
    if artifacts is not None and artifacts_dir:
        raise ValueError("provide artifacts or artifacts_dir, not both")
    if artifacts is not None:
        if not isinstance(artifacts, list):
            raise ValueError("artifacts must be a list of contact-consensus JSON paths")
        paths = [os.path.abspath(os.path.expanduser(str(path)))
                 for path in artifacts if str(path).strip()]
    elif artifacts_dir:
        directory = os.path.abspath(os.path.expanduser(str(artifacts_dir)))
        if not os.path.isdir(directory):
            raise ValueError(f"artifacts_dir not found: {directory}")
        patterns = args.get("glob") or [DEFAULT_ARTIFACT_GLOB]
        if isinstance(patterns, str):
            patterns = [patterns]
        if not isinstance(patterns, list) or not patterns or any(not str(item).strip() for item in patterns):
            raise ValueError("glob must be a non-empty pattern string or list of patterns")
        paths = []
        for pattern in patterns:
            paths.extend(globlib.glob(os.path.join(directory, str(pattern)), recursive=True))
        paths = [os.path.abspath(path) for path in paths if os.path.isfile(path)]
    else:
        raise ValueError("provide artifacts or artifacts_dir with glob")

    paths = sorted(paths, key=lambda path: (path.casefold(), path))
    if len(paths) < 2:
        raise ValueError(f"at least 2 contact-consensus artifacts are required; found {len(paths)}")
    canonical = [os.path.normcase(os.path.realpath(path)) for path in paths]
    if len(canonical) != len(set(canonical)):
        raise ValueError("artifacts contains duplicate file paths")
    for path in paths:
        if not os.path.isfile(path):
            raise ValueError(f"artifact not found: {path}")
    return paths


def _design_id(artifact, path, warnings):
    for key in ("design_id", "designId", "candidate_id", "candidateId"):
        value = artifact.get(key)
        if value is not None and str(value).strip():
            return str(value).strip()
    name = os.path.basename(path)
    prefix = "contact_consensus_"
    suffix = "_jaccard.json"
    if name.startswith(prefix) and name.endswith(suffix):
        inferred = name[len(prefix):-len(suffix)]
    else:
        inferred = os.path.splitext(name)[0]
    if not inferred:
        raise ValueError(f"cannot infer design_id from artifact filename: {path}")
    warnings.append("DESIGN_ID_FROM_FILENAME")
    return inferred


def _target_id(artifact, path, warnings):
    for key in ("target_id", "targetId"):
        value = artifact.get(key)
        if value is not None and str(value).strip():
            return str(value).strip()
    inferred = os.path.basename(os.path.dirname(path).rstrip(os.sep))
    if not inferred:
        raise ValueError(f"cannot infer target_id from artifact directory: {path}")
    warnings.append("TARGET_ID_FROM_DIRECTORY")
    return inferred


def _parse_pair_frequencies(value):
    """Read pair-frequency mappings without changing their target-side semantics."""
    if isinstance(value, dict):
        entries = []
        for edge, frequency in value.items():
            if isinstance(frequency, dict):
                for target_label, nested_frequency in frequency.items():
                    entries.append((str(edge), str(target_label), nested_frequency))
            else:
                entries.append((str(edge), None, frequency))
    elif isinstance(value, list):
        entries = []
        for row in value:
            if not isinstance(row, dict):
                raise ValueError("pair_frequency list entries must be objects")
            binder = row.get("binder_label", row.get("binder"))
            target = row.get("target_label", row.get("target"))
            frequency = row.get("pair_frequency", row.get("frequency"))
            if binder is None or target is None:
                raise ValueError("pair_frequency entries require binder_label and target_label")
            entries.append((str(binder), str(target), frequency))
    else:
        raise ValueError("pair_frequency must be an object or list")

    pair_frequency = {}
    for first, second, frequency in entries:
        if second is None:
            if "|" not in first:
                raise ValueError(f"pair_frequency key must be 'binder|target': {first}")
            binder_label, target_label = first.split("|", 1)
        else:
            binder_label, target_label = first, second
            if "|" in binder_label and target_label is not None:
                binder_label, parsed_target = binder_label.split("|", 1)
                if not parsed_target:
                    raise ValueError("pair_frequency target label must not be empty")
                target_label = parsed_target
        binder_label = binder_label.strip()
        target_label = target_label.strip()
        if not binder_label or not target_label:
            raise ValueError("pair_frequency labels must not be empty")
        parsed_frequency = _number(frequency, "pair_frequency")
        pair_frequency[(binder_label, target_label)] = max(
            pair_frequency.get((binder_label, target_label), 0.0), parsed_frequency)
    return pair_frequency


def _recompute_legacy_contact_data(artifact):
    """Rebuild omitted frequencies from the models listed by legacy G4 artifacts."""
    models = artifact.get("models")
    if not isinstance(models, list) or not models:
        raise ValueError("legacy contact-consensus artifact has no models for frequency reconstruction")

    from contact_tools import _analyze_model, _remap_label, ANCHOR_CONTACT_FREQUENCY, ANCHOR_PAIR_FREQUENCY

    pair_counts = {}
    binder_contact_counts = {}
    for model in models:
        if not isinstance(model, dict):
            raise ValueError("legacy artifact models entries must be objects")
        model_path = model.get("path")
        binder_chain = model.get("binder_chain")
        target_chains = model.get("target_chains")
        if not model_path or not binder_chain or not target_chains:
            raise ValueError("legacy artifact model requires path, binder_chain, and target_chains")
        mapping = model.get("chain_label_mapping") or {}
        chain_mapping = {}
        binder_mapping = mapping.get("binder_chain") or {}
        if binder_mapping.get("source") is not None and binder_mapping.get("canonical") is not None:
            chain_mapping[str(binder_mapping["source"])] = str(binder_mapping["canonical"])
        for source, canonical in (mapping.get("target_chains") or {}).items():
            chain_mapping[str(source)] = str(canonical)

        analyzed = _analyze_model(
            os.path.abspath(os.path.expanduser(str(model_path))),
            binder_chain,
            target_chains,
            DEFAULT_CONTACT_CUTOFF_ANGSTROM,
        )
        edges = {
            (_remap_label(binder, chain_mapping), _remap_label(target, chain_mapping))
            for binder, target in analyzed["edges"]
        }
        for edge in edges:
            pair_counts[edge] = pair_counts.get(edge, 0) + 1
        for binder_label in {binder for binder, _ in edges}:
            binder_contact_counts[binder_label] = binder_contact_counts.get(binder_label, 0) + 1

    n_models = len(models)
    pair_frequency = {edge: count / n_models for edge, count in pair_counts.items()}
    max_pair_frequency = {}
    for (binder_label, _), frequency in pair_frequency.items():
        max_pair_frequency[binder_label] = max(max_pair_frequency.get(binder_label, 0.0), frequency)
    anchors = []
    if n_models >= 6:
        for binder_label in sorted(binder_contact_counts):
            contact_frequency = binder_contact_counts[binder_label] / n_models
            if (contact_frequency >= ANCHOR_CONTACT_FREQUENCY and
                    max_pair_frequency.get(binder_label, 0.0) >= ANCHOR_PAIR_FREQUENCY):
                anchors.append(binder_label)
    return pair_frequency, anchors


def _candidate_from_artifact(path):
    try:
        with open(path, "r", encoding="utf-8") as handle:
            artifact = json.load(handle)
    except (OSError, json.JSONDecodeError) as exc:
        raise ValueError(f"cannot read contact-consensus artifact {path}: {exc}")
    if not isinstance(artifact, dict):
        raise ValueError(f"contact-consensus artifact must contain a JSON object: {path}")

    warnings = []
    design_id = _design_id(artifact, path, warnings)
    target_id = _target_id(artifact, path, warnings)
    pair_data = artifact.get("pair_frequency", artifact.get("pair_contacts"))
    anchor_data = artifact.get("anchor_residues")
    if pair_data is None or not isinstance(anchor_data, list):
        pair_frequency, reconstructed_anchors = _recompute_legacy_contact_data(artifact)
        if pair_data is None:
            pair_data = pair_frequency
        if not isinstance(anchor_data, list):
            anchor_data = reconstructed_anchors
        warnings.append("LEGACY_ARTIFACT_REANALYZED_MODELS")
        warnings.append("LEGACY_ARTIFACT_CUTOFF_ASSUMED_4A")
    else:
        pair_frequency = _parse_pair_frequencies(pair_data)

    if isinstance(pair_data, dict) and all(isinstance(key, tuple) for key in pair_data):
        pair_frequency = pair_data
    else:
        pair_frequency = _parse_pair_frequencies(pair_data)

    target_footprint_freq = {}
    for (_, target_label), frequency in pair_frequency.items():
        if frequency > 0:
            target_footprint_freq[target_label] = max(
                target_footprint_freq.get(target_label, 0.0), frequency)
    target_contact_set = sorted(target_footprint_freq)
    binder_anchor_set = sorted({str(label).strip() for label in anchor_data if str(label).strip()})
    return {
        "design_id": design_id,
        "target_id": target_id,
        "target_contact_set": target_contact_set,
        "target_footprint_freq": {label: target_footprint_freq[label] for label in sorted(target_footprint_freq)},
        "binder_anchor_set": binder_anchor_set,
        "warnings": sorted(set(warnings)),
    }


def _jaccard(left, right):
    union = left | right
    return len(left & right) / len(union) if union else 1.0


def _cosine(left, right):
    labels = set(left) | set(right)
    dot = sum(left.get(label, 0.0) * right.get(label, 0.0) for label in labels)
    left_norm = math.sqrt(sum(value * value for value in left.values()))
    right_norm = math.sqrt(sum(value * value for value in right.values()))
    if left_norm == 0 or right_norm == 0:
        return 0.0
    return dot / (left_norm * right_norm)


def _connected_components(ids, similarity, threshold):
    parent = {design_id: design_id for design_id in ids}

    def find(item):
        while parent[item] != item:
            parent[item] = parent[parent[item]]
            item = parent[item]
        return item

    def union(left, right):
        root_left = find(left)
        root_right = find(right)
        if root_left == root_right:
            return
        first, second = sorted((root_left, root_right))
        parent[second] = first

    for index, left in enumerate(ids):
        for right in ids[index + 1:]:
            # Inclusive cutoffs should remain inclusive after floating-point cosine math
            # (for example, the exact 0.80 fixture can evaluate as 0.7999999999999998).
            if similarity(left, right) + 1e-12 >= threshold:
                union(left, right)

    groups = {}
    for design_id in ids:
        groups.setdefault(find(design_id), []).append(design_id)
    return sorted((sorted(members) for members in groups.values()), key=lambda members: members[0])


def _cluster_id(prefix, members):
    member_key = "|".join(sorted(members))
    digest = hashlib.sha1(member_key.encode("utf-8")).hexdigest()[:12]
    return f"{prefix}_{digest}"


def _cluster_rows(components, target_by_id, prefix):
    return [
        {"cluster_id": _cluster_id(prefix, members),
         "target_id": target_by_id[members[0]],
         "members": members}
        for members in components
    ]


def _distribution_summary(components, n_candidates):
    sizes = [len(members) for members in components]
    hhi = sum((size / n_candidates) ** 2 for size in sizes) if n_candidates else 0.0
    return {
        "cluster_count": len(components),
        "hhi": round(hhi, 8),
        "n_eff": round(1.0 / hhi, 8) if hhi else 0.0,
        "singleton_rate": round(sum(size == 1 for size in sizes) / n_candidates, 8) if n_candidates else 0.0,
    }


def _summary_for_group(candidates, contact_components, pose_components):
    n_candidates = len(candidates)
    distribution_contact = _distribution_summary(contact_components, n_candidates)
    distribution_pose = _distribution_summary(pose_components, n_candidates)
    return {
        "n_candidates": n_candidates,
        "n_within_target_pairs": n_candidates * (n_candidates - 1) // 2,
        "contact_cluster_count": distribution_contact["cluster_count"],
        "pose_cluster_count": distribution_pose["cluster_count"],
        "singleton_rate": distribution_contact["singleton_rate"],
        "contact_singleton_rate": distribution_contact["singleton_rate"],
        "pose_singleton_rate": distribution_pose["singleton_rate"],
        "contact_hhi": distribution_contact["hhi"],
        "pose_hhi": distribution_pose["hhi"],
        "contact_n_eff": distribution_contact["n_eff"],
        "pose_n_eff": distribution_pose["n_eff"],
    }


def _build_output(candidates, jaccard_threshold, cosine_threshold):
    by_id = {candidate["design_id"]: candidate for candidate in candidates}
    target_by_id = {candidate["design_id"]: candidate["target_id"] for candidate in candidates}
    grouped = {}
    for candidate in candidates:
        grouped.setdefault(candidate["target_id"], []).append(candidate["design_id"])
    for ids in grouped.values():
        ids.sort()

    contact_components = []
    pose_components = []
    for target_id in sorted(grouped):
        ids = grouped[target_id]
        contact_components.extend(_connected_components(
            ids,
            lambda left, right: _jaccard(
                set(by_id[left]["target_contact_set"]), set(by_id[right]["target_contact_set"])),
            jaccard_threshold,
        ))
        pose_components.extend(_connected_components(
            ids,
            lambda left, right: _cosine(
                by_id[left]["target_footprint_freq"], by_id[right]["target_footprint_freq"]),
            cosine_threshold,
        ))
    contact_components.sort(key=lambda members: members[0])
    pose_components.sort(key=lambda members: members[0])
    contact_cluster_by_id = {
        design_id: _cluster_id("cc", members)
        for members in contact_components for design_id in members
    }
    pose_cluster_by_id = {
        design_id: _cluster_id("pc", members)
        for members in pose_components for design_id in members
    }

    for candidate in candidates:
        candidate["contact_cluster_id"] = contact_cluster_by_id[candidate["design_id"]]
        candidate["target_footprint_cluster_id"] = contact_cluster_by_id[candidate["design_id"]]
        candidate["pose_cluster_id"] = pose_cluster_by_id[candidate["design_id"]]
        same_target = [other for other in candidates
                       if other["target_id"] == candidate["target_id"] and
                       other["design_id"] != candidate["design_id"]]
        contact_neighbors = [
            (_jaccard(set(candidate["target_contact_set"]), set(other["target_contact_set"])), other["design_id"])
            for other in same_target
        ]
        pose_neighbors = [
            (_cosine(candidate["target_footprint_freq"], other["target_footprint_freq"]), other["design_id"])
            for other in same_target
        ]
        if contact_neighbors:
            best_contact = sorted(contact_neighbors, key=lambda row: (-row[0], row[1]))[0]
            best_pose = sorted(pose_neighbors, key=lambda row: (-row[0], row[1]))[0]
            candidate["nearest_contact_jaccard"] = best_contact[0]
            candidate["nearest_pose_cosine"] = best_pose[0]
            candidate["nearest_neighbor_id"] = best_contact[1]
            candidate["nearest_contact_neighbor_id"] = best_contact[1]
            candidate["nearest_pose_neighbor_id"] = best_pose[1]
        else:
            candidate["nearest_contact_jaccard"] = None
            candidate["nearest_pose_cosine"] = None
            candidate["nearest_neighbor_id"] = None
            candidate["nearest_contact_neighbor_id"] = None
            candidate["nearest_pose_neighbor_id"] = None

    by_target_contact = {}
    by_target_pose = {}
    for target_id, ids in grouped.items():
        by_target_contact[target_id] = [members for members in contact_components
                                        if target_by_id[members[0]] == target_id]
        by_target_pose[target_id] = [members for members in pose_components
                                     if target_by_id[members[0]] == target_id]
    n_candidates = len(candidates)
    summary = _summary_for_group(candidates, contact_components, pose_components)
    total_pairs = n_candidates * (n_candidates - 1) // 2
    n_within_target_pairs = sum(len(ids) * (len(ids) - 1) // 2 for ids in grouped.values())
    summary.update({
        "n_within_target_pairs": n_within_target_pairs,
        "n_cross_target_pairs_compared": 0,
        "n_cross_target_pairs_excluded": total_pairs - n_within_target_pairs,
        "per_target": {
            target_id: _summary_for_group(
                [by_id[design_id] for design_id in ids],
                by_target_contact[target_id],
                by_target_pose[target_id],
            )
            for target_id, ids in sorted(grouped.items())
        },
    })
    return {
        "schema_version": "1.0",
        "jaccard_threshold": jaccard_threshold,
        "cosine_threshold": cosine_threshold,
        "candidates": candidates,
        "clusters": {
            "contact": _cluster_rows(contact_components, target_by_id, "cc"),
            "pose": _cluster_rows(pose_components, target_by_id, "pc"),
        },
        "summary": summary,
    }


def _atomic_write(path, payload):
    directory = os.path.dirname(path)
    os.makedirs(directory, exist_ok=True)
    temp_path = None
    try:
        with tempfile.NamedTemporaryFile(
            "w", encoding="utf-8", newline="\n", dir=directory,
            prefix=os.path.basename(path) + ".", suffix=".tmp", delete=False,
        ) as handle:
            temp_path = handle.name
            handle.write(json.dumps(payload, ensure_ascii=False, sort_keys=True, indent=2))
            handle.write("\n")
        os.replace(temp_path, path)
    finally:
        if temp_path and os.path.exists(temp_path):
            try:
                os.remove(temp_path)
            except OSError:
                pass


def run_contact_cluster(args):
    """Cluster contact-consensus candidates by target-side footprint."""
    try:
        if not isinstance(args, dict):
            return {"ok": False, "error": "args must be an object"}
        jaccard_threshold = _number(args.get("jaccard_threshold", DEFAULT_JACCARD_THRESHOLD), "jaccard_threshold")
        cosine_threshold = _number(args.get("cosine_threshold", DEFAULT_COSINE_THRESHOLD), "cosine_threshold")
        dry_run = args.get("dry_run", False)
        if not isinstance(dry_run, bool):
            return {"ok": False, "error": "dry_run must be a boolean"}
        out = args.get("out")
        if out is None or not str(out).strip():
            return {"ok": False, "error": "out is required"}
        out_path = os.path.abspath(os.path.expanduser(str(out)))
        paths = _resolve_artifact_paths(args)
        canonical_out = os.path.normcase(os.path.realpath(out_path))
        if canonical_out in {os.path.normcase(os.path.realpath(path)) for path in paths}:
            return {"ok": False, "error": "out must not overwrite an input artifact"}

        candidates = [_candidate_from_artifact(path) for path in paths]
        candidates.sort(key=lambda candidate: candidate["design_id"])
        design_ids = [candidate["design_id"] for candidate in candidates]
        if len(design_ids) != len(set(design_ids)):
            return {"ok": False, "error": "design_id values must be unique across artifacts"}

        output = _build_output(candidates, jaccard_threshold, cosine_threshold)
        if dry_run:
            return {"ok": True, "result": {"dry_run": True, "summary": output["summary"]}}
        _atomic_write(out_path, output)
        return {"ok": True, "result": {"out": out_path, "summary": output["summary"]}}
    except (OSError, TypeError, ValueError) as exc:
        return {"ok": False, "error": str(exc)}
    except Exception as exc:
        return {"ok": False, "error": f"{type(exc).__name__}: {exc}"}
