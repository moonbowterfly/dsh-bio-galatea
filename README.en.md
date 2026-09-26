# dsh-bio-galatea (G-series · Protein Structure Prediction & Design)

> **A protein-design toolbox for dsh / dsh-bio-genie** — sequence design, single-chain folding
> validation, interface screening and diversity selection, all on your local machine.
> Zero manual setup (private venv auto-bootstrap); adapts to CPU or small-VRAM GPUs.

**Galatea** (Γαλάτεια): the statue brought to life in Greek myth — a name for the
"structure-to-sequence" act of protein creation.

## What it solves

A standard protein-design pipeline (binders / enzymes / nanobodies) is scattered across a dozen
tools: ProteinMPNN for sequences, ESMFold for fold validation, interface analysis for binding
screening, clustering for candidate selection. This plugin gathers them into **16 semantic tools**
that agents in dsh (and the genie host) can call directly — with **explicit local boundaries**
(heavy co-folding is honestly redirected to external services instead of pretending capability).

## Quick start

```
1. Check state:   galatea_status
    → components (MPNN / ESMFold / analysis deps) and device (GPU/CPU)
2. Bootstrap:     galatea_setup(action="all")   # idempotent; esmfold weights ≈ 2.5 GB
3. Design:        galatea_mpnn                  # sequence design for a structure
   Validate fold: galatea_fold                  # single-chain structure prediction
   Screen:        galatea_interface             # complex-interface metrics (co-folding output)
   Phys-chem:     galatea_score                 # pI / net charge / hydrophobic moment / aggregation proxy
   Structure QC:  galatea_inspect               # clash / pLDDT distribution
   Diversity:     galatea_cluster               # identity clustering + representative set
   Contact consensus: galatea_contact_consensus # multi-model contact frequencies and anchors
   Contact clusters: galatea_contact_cluster    # target footprint Jaccard + frequency cosine, single-link
```

## The 16 tools

| Tool | Purpose | Typical time |
|---|---|---|
| `galatea_status` | Runtime state (components / device / interpreter) | seconds |
| `galatea_setup` | Zero-manual bootstrap (env / mpnn / esmfold / all) | minutes (esmfold 5–30 min) |
| `galatea_mpnn` | Sequence design (ProteinMPNN / SolubleMPNN / LigandMPNN) | CPU seconds–minutes |
| `galatea_fold` | Single-chain folding (ESMFold, CPU/GPU) | CPU minutes per chain |
| `galatea_interface` | Complex-interface analysis (contacts / H-bonds / salt bridges / buried area / pLDDT) | seconds–minutes |
| `galatea_score` | Sequence phys-chem scoring (pI / net charge / GRAVY / hydrophobic moment / aggregation proxy) | seconds |
| `galatea_inspect` | Structure QC (clash / pLDDT distribution) | seconds |
| `galatea_cluster` | Candidate clustering (diversity representative set) | seconds–minutes |
| `galatea_rank` | Candidate consensus ranking (equal-weight predictor mean + tiers) | seconds |
| `galatea_rank_aggregate` | Merge ranking batches into a global ranking CSV | seconds |
| `galatea_loop` | Multi-round campaign bookkeeping and deterministic next-round planning | seconds |
| `galatea_contact_consensus` | Multi-model residue/pair contact frequencies, Jaccard matrices and anchors; automatic chain roles are normalized to the first valid model and exposed in `chain_label_mappings`; design control only | seconds–minutes |
| `galatea_contact_cluster` | Single-link contact/pose clusters from same-target residue footprints (Jaccard + frequency-vector cosine); nearest neighbors and HHI/N_eff | seconds–minutes |
| `galatea_redesign` | Region-constrained binder redesign using contact, anchor, and rSASA regions | minutes |
| `galatea_refold` | ESMFold monomer refold metrics including the Cα fraction within 2 Å (F2Å) | CPU minutes |
| `galatea_ingest` | Ingest local PDB/CIF, CSV/JSON/JSONL, or inline candidates into a conflict-aware JSONL ledger | seconds–minutes |

## Candidate ledger (`galatea_ingest`)

Each candidate requires stable `target_id` and `design_id`; together they identify a record, so matching sequences from different targets remain separate. The ledger also stores `seq_sha1` and `sequence_group_id` without merging distinct design instances. Structures are objects containing the absolute path, file SHA256, explicit `role`, predictor/model/seed, and binder/target chains. A missing role becomes `other` with a warning. Scores stay in namespaced `raw_scores`; their `direction` and `version` metadata are written to the `<ledger>.schema.json` sidecar, with no unified quality score. Lineage resolves only explicit `parent_id` values. Missing parents remain as `DANGLING_PARENT` and resolve after a later append adds the parent; sequence similarity is never used to infer lineage.

## Hardware boundaries (stated honestly)

| Step | This plugin | External option (when local is not enough) |
|---|---|---|
| Sequence design | ✅ local (CPU is enough) | — |
| Single-chain fold validation | ✅ local (ESMFold, CPU / small GPU) | — |
| Interface / sequence analysis | ✅ local | — |
| Complex co-folding | ❌ (VRAM far beyond consumer grade) | AlphaFold Server / PXDesign / ColabFold / Tamarind |
| Large-VRAM backbone generation | ❌ | PXDesign / Tamarind / RFdiffusion (cloud) |

## Dependencies & credits

- [LigandMPNN / ProteinMPNN](https://github.com/dauparas/LigandMPNN) (MIT, Dauparas et al.) — sequence-design core (vendored into the plugin's private dir; weights from the official IPD public source)
- [ESMFold](https://github.com/facebookresearch/esm) (Meta, loaded via 🤗 transformers) — folding prediction
- [Biopython](https://biopython.org/) (Biopython License Agreement / BSD-3) — structure / sequence analysis
- Bootstrap driven by [uv](https://github.com/astral-sh/uv); zero manual install, system Python untouched

## License

MIT (this plugin itself). Third-party components: see "Dependencies & credits".

## 中文版

See [README.md](./README.md) for the Chinese-first documentation.

```bash
dsh plugin add @dsh-bio/dsh-bio-galatea
```
