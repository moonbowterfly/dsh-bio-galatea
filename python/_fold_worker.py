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


def _available_ram_gib():
    """可用物理内存（GiB）。Windows 走 GlobalMemoryStatusEx；失败返回 None。"""
    try:
        import ctypes

        class MEMORYSTATUSEX(ctypes.Structure):
            _fields_ = [
                ("dwLength", ctypes.c_ulong),
                ("dwMemoryLoad", ctypes.c_ulong),
                ("ullTotalPhys", ctypes.c_ulonglong),
                ("ullAvailPhys", ctypes.c_ulonglong),
                ("ullTotalPageFile", ctypes.c_ulonglong),
                ("ullAvailPageFile", ctypes.c_ulonglong),
                ("ullTotalVirtual", ctypes.c_ulonglong),
                ("ullAvailVirtual", ctypes.c_ulonglong),
                ("ullAvailExtendedVirtual", ctypes.c_ulonglong),
            ]

        st = MEMORYSTATUSEX()
        st.dwLength = ctypes.sizeof(MEMORYSTATUSEX)
        if ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(st)):
            return st.ullAvailPhys / (1024 ** 3)
    except Exception:
        pass
    return None


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

    # 内存预检：ESMFold bf16 加载约需 6.6 GiB 连续可用内存；不足时明确报错，
    # 避免 Windows 内存压力下的系统级崩溃（access violation，无 traceback 不可诊断）。
    avail = _available_ram_gib()
    # 阈值依据实测：6.06 GiB 可用时 bf16 加载 + 推理可成功（low_cpu_mem_usage + 分页）；
    # 低于 ~2 GiB 时曾在加载阶段出现系统级 access violation（不可诊断崩溃）。
    # 环境变量 GALATEA_FOLD_MIN_RAM_GIB 可覆盖阈值（显式承担崩溃风险时使用）。
    try:
        min_ram = float(os.environ.get("GALATEA_FOLD_MIN_RAM_GIB", "6.0"))
    except ValueError:
        min_ram = 6.0
    if avail is not None and avail < min_ram:
        raise RuntimeError(
            f"可用物理内存不足（{avail:.1f} GiB < {min_ram:g} GiB 阈值）：ESMFold（bf16）加载约需 6.6 GiB，"
            "低内存下会触发系统级崩溃而无法诊断。请关闭其他大内存程序后重试。"
        )

    tokenizer = AutoTokenizer.from_pretrained(model_ref)
    # 内存纪律：esmfold_v1 检查点内 ESM-2 主干为 fp16、folding trunk 为 fp32；
    # 全 fp32 加载 ≈13.1 GiB（14-16GB 内存笔记本会 OOM），bf16/fp16 ≈6.6 GiB。
    # CPU 用 bfloat16（原生支持、动态范围与 fp32 同级）；GPU 按 bf16 支持选择。
    if device == "cuda":
        torch_dtype = torch.bfloat16 if torch.cuda.is_bf16_supported() else torch.float16
    else:
        torch_dtype = torch.bfloat16
    model = EsmForProteinFolding.from_pretrained(
        model_ref, low_cpu_mem_usage=True, torch_dtype=torch_dtype
    )
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
                # 高层 API：内部完成 tokenization 与 dtype 处理（transformers ≥5 推荐路径）。
                # 手动 tokenizer+forward 在 5.x 下有 one_hot dtype 兼容问题（RuntimeError），弃用。
                out = model.infer(seq)
            if out is None:
                raise RuntimeError("模型缺少 infer() 接口，无法推理")
            plddt = out["plddt"]
            mean_plddt = float(plddt[0, : len(seq)].float().mean().item()) if "plddt" in out else None
            ptm = float(out["ptm"].mean().item()) if "ptm" in out else None
            # numpy 不支持 bfloat16 → 导出 PDB 前把 bf16 张量转回 fp32（仅导出用途）
            out_for_pdb = {k: (v.float() if torch.is_tensor(v) and v.dtype == torch.bfloat16 else v)
                           for k, v in out.items()}
            pdb_str = model.output_to_pdb(out_for_pdb)[0]
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
