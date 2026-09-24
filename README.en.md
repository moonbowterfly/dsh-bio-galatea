# dsh-bio-galatea (G-series · Protein Structure Prediction & Design)

> **A protein-design toolbox for dsh / dsh-bio-genie** — sequence design, single-chain folding
> validation, interface screening and diversity selection, all on your local machine.
> Zero manual setup (private venv auto-bootstrap); adapts to CPU or small-VRAM GPUs.

**Galatea** (Γαλάτεια): the statue brought to life in Greek myth — a name for the
"structure-to-sequence" act of protein creation.

## What it solves

A standard protein-design pipeline (binders / enzymes / nanobodies) is scattered across a dozen
tools: ProteinMPNN for sequences, ESMFold for fold validation, interface analysis for binding
screening, clustering for candidate selection. This plugin gathers them into **8 semantic tools**
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
```

## The 8 tools

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
