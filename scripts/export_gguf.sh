#!/usr/bin/env bash
set -euo pipefail

# CPU-only export. Keep every path below the shared-server project root.
ROOT="${FLOWSPEC_ROOT:-/home/jiangjiaqi/zcdai}"
PROJECT="$ROOT/flowspec-sft"
PYTHON="${FLOWSPEC_PYTHON:-$ROOT/envs/flowspec-py310/bin/python}"
EXPORT_ENV="${FLOWSPEC_EXPORT_ENV:-$ROOT/envs/llama-cpp-export}"
EXPORT_PYTHON="$EXPORT_ENV/bin/python"
MODEL="${FLOWSPEC_MODEL:-Qwen/Qwen3-1.7B}"
ADAPTER="${FLOWSPEC_ADAPTER:-$PROJECT/artifacts/qwen3-1.7b-qlora-compact}"
MERGED="${FLOWSPEC_MERGED:-$PROJECT/artifacts/qwen3-1.7b-flowspec-merged}"
GGUF_DIR="${FLOWSPEC_GGUF_DIR:-$PROJECT/artifacts/gguf}"
LLAMA_CPP="${FLOWSPEC_LLAMA_CPP:-$ROOT/tools/llama.cpp}"

export PYTHONNOUSERSITE=1
export OMP_NUM_THREADS="${OMP_NUM_THREADS:-2}"
export MKL_NUM_THREADS="${MKL_NUM_THREADS:-2}"
export OPENBLAS_NUM_THREADS="${OPENBLAS_NUM_THREADS:-2}"
export NUMEXPR_NUM_THREADS="${NUMEXPR_NUM_THREADS:-2}"
export HF_HOME="${HF_HOME:-$ROOT/cache/huggingface}"
export PIP_CACHE_DIR="${PIP_CACHE_DIR:-$ROOT/cache/pip}"

mkdir -p "$GGUF_DIR" "$ROOT/tools"
cd "$PROJECT"

"$PYTHON" scripts/merge_adapter.py \
  --model "$MODEL" --adapter "$ADAPTER" --output "$MERGED"

if [[ ! -d "$LLAMA_CPP/.git" ]]; then
  git clone --depth 1 https://github.com/ggml-org/llama.cpp.git "$LLAMA_CPP"
fi

if [[ ! -x "$EXPORT_PYTHON" ]]; then
  "$PYTHON" -m venv "$EXPORT_ENV"
fi
"$EXPORT_PYTHON" -m pip install --disable-pip-version-check \
  -r "$LLAMA_CPP/requirements.txt"
cmake -S "$LLAMA_CPP" -B "$LLAMA_CPP/build" \
  -DGGML_CUDA=OFF -DLLAMA_CURL=OFF -DCMAKE_BUILD_TYPE=Release
cmake --build "$LLAMA_CPP/build" --target llama-quantize -j2

F16="$GGUF_DIR/flowspec-qwen3-1.7b-f16.gguf"
Q4="$GGUF_DIR/flowspec-qwen3-1.7b-q4_k_m.gguf"
"$EXPORT_PYTHON" "$LLAMA_CPP/convert_hf_to_gguf.py" \
  "$MERGED" --outfile "$F16" --outtype f16
"$LLAMA_CPP/build/bin/llama-quantize" "$F16" "$Q4" Q4_K_M 2

sha256sum "$Q4" > "$Q4.sha256"
ls -lh "$F16" "$Q4" "$Q4.sha256"

if [[ "${FLOWSPEC_CLEAN_INTERMEDIATE:-0}" == "1" ]]; then
  rm -f "$F16"
  rm -rf "$MERGED"
fi
