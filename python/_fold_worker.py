"""ESMFold 推理 worker（独立子进程执行；被 fold_esm.py spawn）。

用法：python _fold_worker.py <input.json> <out_dir>
input.json: {"sequences": [...], "model_ref": "<local dir or HF id>", "device": "auto|cpu|cuda", "chunk_size": null|int}

产出：
  <out_dir>/<idx>_<n>aa.pdb   每条序列的预测结构
  <out_dir>/_fold_result.json {results:[{index,name,pdb,length,mean_plddt,ptm}], errors:[...], device_used, model_ref}

注意：本文件由主进程 spawn，stdout/stderr 会被收集；异常向上抛（非零退出）。
"""
import json
import os
import sys
import traceback


def main():
    input_path, out_dir = sys.argv[1], sys.argv[2]
    with open(input_path, "r", encoding="utf-8") as fh:
        cfg = json.load(fh)
    sequences = cfg["sequences"]
    model_ref = cfg["model_ref"]
    device_pref = cfg.get("device") or "auto"
    chunk = cfg.get("chunk_size")

    import torch
    from transformers import AutoTokenizer, EsmForProteinFolding

    if device_pref == "auto":
        device = "cuda" if torch.cuda.is_available() else "cpu"
    else:
        device = device_pref
        if device == "cuda" and not torch.cuda.is_available():
            raise RuntimeError("device=cuda 但 torch.cuda.is_available() 为 False")

    tokenizer = AutoTokenizer.from_pretrained(model_ref)
    model = EsmForProteinFolding.from_pretrained(model_ref, low_cpu_mem_usage=True)
    model = model.eval()
    if device == "cuda":
        model = model.cuda()
        # 小显存保护：chunk 降低激活内存（4GB 卡建议 16-32）
        if chunk is None:
            chunk = 16
    else:
        if chunk is None:
            chunk = 64
    try:
        model.set_chunk_size(int(chunk))
    except Exception:
        pass  # 旧版本无该接口时忽略（大序列可能 OOM，报错由上层呈现）

    results = []
    errors = []
    for idx, seq in enumerate(sequences):
        try:
            with torch.no_grad():
                out = model.infer_pdb(seq) if hasattr(model, "infer_pdb") else None
            if out is None:
                # transformers 路径：tokenizer + model(**inputs) 再 output_to_pdb
                inputs = tokenizer([seq], return_tensors="pt", add_special_tokens=False)
                inputs = {k: v.to(device) for k, v in inputs.items()}
                with torch.no_grad():
                    output = model(**inputs)
                pdb_str = model.output_to_pdb(output)[0]
                plddt = output["plddt"]
                ptm = float(output["ptm"].mean().item()) if "ptm" in output else None
                mean_plddt = float(plddt.mean().item())
            else:
                pdb_str = out
                mean_plddt = None
                ptm = None
            name = f"{idx:02d}_{len(seq)}aa"
            pdb_path = os.path.join(out_dir, name + ".pdb")
            with open(pdb_path, "w", encoding="utf-8") as fh:
                fh.write(pdb_str if isinstance(pdb_str, str) else str(pdb_str))
            results.append({
                "index": idx, "name": name, "pdb": pdb_path,
                "length": len(seq), "mean_plddt": mean_plddt, "ptm": ptm,
            })
        except Exception as e:
            errors.append({"index": idx, "length": len(seq),
                           "error": f"{type(e).__name__}: {e}"})

    with open(os.path.join(out_dir, "_fold_result.json"), "w", encoding="utf-8") as fh:
        json.dump({
            "status": "ok" if results else "failed",
            "results": results,
            "errors": errors,
            "device_used": device,
            "model_ref": model_ref,
        }, fh, ensure_ascii=False)
    print(f"FOLD_DONE results={len(results)} errors={len(errors)}")


if __name__ == "__main__":
    try:
        main()
    except Exception:
        traceback.print_exc()
        sys.exit(1)
