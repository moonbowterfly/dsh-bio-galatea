# dsh-bio-galatea (G-series · Protein Structure Prediction & Design)

> **A protein-design toolbox for dsh / dsh-bio-genie** — sequence design, single-chain folding
> validation, interface screening and diversity selection, all on your local machine.
> Zero manual setup (private venv auto-bootstrap); adapts to CPU or small-VRAM GPUs.

**Galatea** (Γαλάτεια): the statue brought to life in Greek myth — a name for the
"structure-to-sequence" act of protein creation.

## What it solves

A standard protein-design pipeline (binders / enzymes / nanobodies) is scattered across a dozen
tools: ProteinMPNN for sequences, ESMFold for fold validation, interface analysis for binding
screening, clustering for candidate selection. This plugin gathers them into **19 semantic tools**
that agents in dsh (and the genie host) can call directly — with **explicit local boundaries**
(heavy co-folding is honestly redirected to external services instead of pretending capability).

### Model directory (can live on another drive)

Large weights (ESMFold ~2.5GB + MPNN checkpoints) default to `~/.dsh/dsh-bio-galatea/models` (on C:).
You can move them to another drive at any time:

- **Way 1 (recommended)**: dsh desktop app → Settings → "BioGenie" → "Protein Design" page → "Model directory" card → enter an absolute path → **Save & apply** (writes `~/.dsh/dsh-bio-galatea/config.json`; effective immediately).
- **Way 2 (env)**: `GALATEA_MODELS_DIR` (highest priority).
- **Way 3 (manual)**: edit `~/.dsh/dsh-bio-galatea/config.json`: `{ "modelsDir": "F:/Models/AI_models" }`.

Priority: `GALATEA_MODELS_DIR` > `config.json.modelsDir` > the default. Pointing at a directory that already
contains `esmfold/` and `mpnn/` reuses those weights directly; pointing at an empty directory makes the next
`galatea_setup` download there. **No restart needed** — the next tool call resolves the new directory.

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
   Portfolio:       galatea_portfolio            # coverage floors, global caps and auditable outputs
   Cross-target budget: galatea_budget            # floor / exploit / reserve quotas per target
   Coverage audit: galatea_coverage               # audit campaign diversity and optionally plan deterministic rescue
```

## The 19 tools

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
| `galatea_portfolio` | Deterministic selection under target coverage, diversity caps and risk limits | seconds–minutes |
| `galatea_budget` | Cross-target budget allocation with three tiers, pilot shrinkage, density and cap feasibility checks | seconds |
| `galatea_coverage` | Campaign audit for generator/contact/backbone coverage, unconsumed generators and quota execution; optional deterministic rescue plan | seconds |

## Campaign coverage audit (`galatea_coverage`)

Provide a candidate CSV/JSONL with unique `design_id` and `target_id`, plus optional selection, per-target quota, and config inputs. The tool audits zero coverage, single-generator/contact/backbone-family selections, unconsumed generators, and quota execution. With `rescue=true`, it writes a deterministic ADD/REPLACE plan without changing the selection. It reads only the explicitly configured candidate dimensions and score column; wet-lab labels are not read, and the output is not consumed by loop or portfolio.

## Cross-target budget scheduling (`galatea_budget`)

Provide a target summary table (CSV/JSONL/JSON; required `target_id`; optional `n_eligible`, `n_backbones`, `n_contact_clusters`, `pilot_attempts`, `pilot_passes`, and `uncertainty`), a config with required `total_budget`, and an output directory. The scheduler builds integer coverage-floor, designability-exploit (weight `sqrt((pilot_passes+1)/(pilot_attempts+2))`), and hard/uncertain-reserve pools from a preset or explicit shares. If `N<T`, the top shrinkage targets receive one slot each. Missing optional fields produce warnings and reduce the corresponding feasibility reporting.

The default `balanced` preset uses 20/65/15; `global-best-affinity`, `multi-target-aggregate`, and `per-target-coverage-heavy` use 15/70/15, 30/55/15, and 45/40/15. A contact cap is effective only when `q=N/T≤5`, the preset is not `global-best-affinity`, and `portfolio_v1_validated=true`. Infeasible caps receive an explicit relaxation recommendation and `CAP_RELAXED_INFEASIBLE`; quotas above the eligible pool receive `QUOTA_EXCEEDS_POOL` and are never silently reduced. The four outputs are `budget_allocation.csv`, `budget_summary.json`, `budget_manifest.json`, and `portfolio_handoff.json`; allocation rows sort by `target_id`, while `flags` and `reason_codes` use JSON-array CSV cells. This version only emits the handoff and does not connect it to portfolio or loop. No wet-lab labels are read or used.

## Constraint-first portfolios (`galatea_portfolio`)

Provide a candidate CSV, JSONL, or JSON array with `design_id`, `target_id`, and either `consensus_percentile` or `consensus_score`. Missing percentiles are computed as within-target midranks when consensus scores are available. When `sequence_group_id` is absent but `sequence` is present, the selector derives it with the same `SHA1(target_id + "|" + sequence)` formula as ingest. It then applies QC and required-field eligibility, exact-sequence deduplication, a per-target coverage floor, and global competition by within-target percentile, consensus score, and design ID.

Defaults include 500 total slots, 5 minimum targets, a backbone cap of 2, and a 10% HIGH_RISK ceiling. The automatic lineage cap is `max(2, ceil(0.05 × estimated target slots))`. All limits can be changed through an inline `config` object or JSON config file. Missing optional dimensions generate warnings and leave candidates without that value unrestricted on the dimension. Set `out` to write `portfolio_selected.csv`, `portfolio_rejected.csv`, `portfolio_summary.json`, and `portfolio_manifest.json`. The manifest hashes the input, effective config, and three payload files; it does not self-hash. The selector does not read wet-lab labels, access the network, or feed `galatea_loop`.

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
# from GitHub source (this package is not on npm yet):
dsh plugin --profile web add github:moonbowterfly/dsh-bio-galatea

# desktop app (0.2.0+) — bundled CLI with --profile desktop:
#   & "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add github:moonbowterfly/dsh-bio-galatea
```
