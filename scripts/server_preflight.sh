#!/usr/bin/env bash
set -euo pipefail

# Read-only resource gate for a shared single-GPU server.
MIN_FREE_GPU_MIB="${MIN_FREE_GPU_MIB:-10000}"
MIN_FREE_DISK_GIB="${MIN_FREE_DISK_GIB:-20}"

echo "== host =="
hostname
date -Is
echo "== memory =="
free -h
echo "== disk =="
df -h .
echo "== gpu =="
nvidia-smi --query-gpu=index,name,memory.total,memory.used,memory.free,utilization.gpu \
  --format=csv,noheader,nounits
echo "== active compute processes (read only) =="
nvidia-smi --query-compute-apps=pid,process_name,used_memory --format=csv,noheader || true

FREE_GPU_MIB="$(nvidia-smi --query-gpu=memory.free --format=csv,noheader,nounits | head -n1 | tr -d ' ')"
FREE_DISK_GIB="$(df -Pk . | awk 'NR==2 {printf "%d", $4/1024/1024}')"

if (( FREE_GPU_MIB < MIN_FREE_GPU_MIB )); then
  echo "BLOCKED: GPU free memory ${FREE_GPU_MIB} MiB < ${MIN_FREE_GPU_MIB} MiB" >&2
  exit 20
fi
if (( FREE_DISK_GIB < MIN_FREE_DISK_GIB )); then
  echo "BLOCKED: disk free ${FREE_DISK_GIB} GiB < ${MIN_FREE_DISK_GIB} GiB" >&2
  exit 21
fi
echo "PASS: resource gate satisfied; run one training process only."
