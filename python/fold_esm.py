"""单链结构预测编排（ESMFold）——spawn _fold_worker.py 子进程执行推理。

设计：模型加载（数 GB 内存）与推理隔离在一次性子进程；本模块负责
输入准备、进程编排、结果收集与错误报告。
权重来源：models/esmfold（私有，setup(action="esmfold")）优先；
缺省回退 HF 缓存（from_pretrained('facebook/esmfold_v1') 由 transformers 自行定位）。
"""
import json
import os
import subprocess
import sys

from components import _venv_python

WORKER = os.path.join(os.path.dirname(os.path.abspath(__file__)), "_fold_worker.py")


def fold_sequences(sequences, out_dir, device="auto", data_root=None, chunk_size=None):
    """fold 主入口（供 op_fold 调用）。返回结构化结果 dict。"""
    data_root = data_root or os.path.join(os.path.expanduser("~"), ".dsh", "dsh-bio-galatea")
    os.makedirs(out_dir, exist_ok=True)

    # 解释器与权重路径
    venv_py = _venv_python(data_root)
    runner = venv_py if os.path.exists(venv_py) else sys.executable
    model_dir = os.path.join(data_root, "models", "esmfold")

    def _dir_has_weights(base):
        # 仅在"权重真实落位"（大文件存在）时使用私有目录；仅 config、或下载中（.cache）不算
        if not os.path.isdir(base):
            return False
        for f in os.listdir(base):
            if f.endswith((".bin", ".safetensors")) and not f.endswith(".incomplete"):
                try:
                    if os.path.getsize(os.path.join(base, f)) > 100 * 1024 * 1024:
                        return True
                except OSError:
                    pass
        return False

    model_ref = model_dir if _dir_has_weights(model_dir) else "facebook/esmfold_v1"

    # 输入文件（避免超长命令行）
    input_path = os.path.join(out_dir, "_fold_input.json")
    with open(input_path, "w", encoding="utf-8") as fh:
        json.dump({"sequences": sequences, "model_ref": model_ref, "device": device,
                   "chunk_size": chunk_size}, fh, ensure_ascii=False)

    cmd = [runner, WORKER, input_path, out_dir]
    try:
        proc = subprocess.run(
            cmd, capture_output=True, text=True, encoding="utf-8", errors="replace",
            timeout=1700,
        )
    except subprocess.TimeoutExpired:
        return {"ok": False, "error": "ESMFold 推理超时（>1700s）——请减少序列数或缩短序列",
                "out_dir": out_dir}

    result_path = os.path.join(out_dir, "_fold_result.json")
    if proc.returncode != 0 or not os.path.exists(result_path):
        return {
            "ok": False,
            "error": f"fold worker 退出码 {proc.returncode}",
            "stderr_tail": (proc.stderr or "")[-1500:],
            "stdout_tail": (proc.stdout or "")[-600:],
            "runner": runner,
        }

    with open(result_path, "r", encoding="utf-8") as fh:
        result = json.load(fh)
    result["out_dir"] = out_dir
    result["model_ref"] = model_ref
    return result
