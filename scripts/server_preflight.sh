#!/usr/bin/env bash
set -euo pipefail

# Read-only gate for the documented shared server. It never kills or modifies other jobs.
TARGET_GPU_UUID="${TARGET_GPU_UUID:-GPU-e4099e8f-7881-b850-cbc8-a9cfe310809c}"
MIN_HOST_FREE_GIB="${MIN_HOST_FREE_GIB:-64}"
MIN_CGROUP_FREE_GIB="${MIN_CGROUP_FREE_GIB:-32}"
MIN_FREE_DISK_GIB="${MIN_FREE_DISK_GIB:-100}"
MIN_FREE_GPU_MIB="${MIN_FREE_GPU_MIB:-25600}"
MAX_GPU_UTIL="${MAX_GPU_UTIL:-5}"

bytes_to_gib() { awk -v bytes="$1" 'BEGIN {printf "%d", bytes/1024/1024/1024}'; }

echo "== host =="
hostname
date -Is
echo "== memory =="
free -h
echo "== cgroup =="
cat /sys/fs/cgroup/memory.max
cat /sys/fs/cgroup/memory.current
echo "== disk =="
df -h .
echo "== gpu snapshot 1 =="
nvidia-smi --query-gpu=index,uuid,name,memory.total,memory.used,memory.free,utilization.gpu \
  --format=csv,noheader,nounits
echo "== active compute processes (read only) =="
nvidia-smi --query-compute-apps=gpu_uuid,pid,process_name,used_memory --format=csv,noheader || true

HOST_FREE_GIB="$(free -b | awk '/^Mem:/ {printf "%d", $7/1024/1024/1024}')"
CGROUP_MAX="$(cat /sys/fs/cgroup/memory.max)"
CGROUP_CURRENT="$(cat /sys/fs/cgroup/memory.current)"
if [[ "$CGROUP_MAX" == "max" ]]; then
  CGROUP_FREE_GIB="$HOST_FREE_GIB"
else
  CGROUP_FREE_GIB="$(bytes_to_gib "$((CGROUP_MAX - CGROUP_CURRENT))")"
fi
FREE_DISK_GIB="$(df -Pk . | awk 'NR==2 {printf "%d", $4/1024/1024}')"

read -r GPU_FREE_MIB GPU_UTIL < <(
  nvidia-smi --query-gpu=uuid,memory.free,utilization.gpu --format=csv,noheader,nounits |
    awk -F',' -v uuid="$TARGET_GPU_UUID" '{gsub(/ /,"",$1); if ($1==uuid) {gsub(/ /,"",$2); gsub(/ /,"",$3); print $2, $3}}'
)
if [[ -z "${GPU_FREE_MIB:-}" ]]; then
  echo "BLOCKED: target GPU UUID is not visible: $TARGET_GPU_UUID" >&2
  exit 19
fi

if (( HOST_FREE_GIB < MIN_HOST_FREE_GIB )); then
  echo "BLOCKED: host available memory ${HOST_FREE_GIB} GiB < ${MIN_HOST_FREE_GIB} GiB" >&2
  exit 20
fi
if (( CGROUP_FREE_GIB < MIN_CGROUP_FREE_GIB )); then
  echo "BLOCKED: cgroup free memory ${CGROUP_FREE_GIB} GiB < ${MIN_CGROUP_FREE_GIB} GiB" >&2
  exit 21
fi
if (( FREE_DISK_GIB < MIN_FREE_DISK_GIB )); then
  echo "BLOCKED: disk free ${FREE_DISK_GIB} GiB < ${MIN_FREE_DISK_GIB} GiB" >&2
  exit 22
fi
if (( GPU_FREE_MIB < MIN_FREE_GPU_MIB )); then
  echo "BLOCKED: GPU free memory ${GPU_FREE_MIB} MiB < ${MIN_FREE_GPU_MIB} MiB" >&2
  exit 23
fi
if (( GPU_UTIL > MAX_GPU_UTIL )); then
  echo "BLOCKED: GPU utilization ${GPU_UTIL}% > ${MAX_GPU_UTIL}%" >&2
  exit 24
fi

echo "Sampling target GPU again in 10 seconds..."
sleep 10
read -r GPU_FREE_MIB_2 GPU_UTIL_2 < <(
  nvidia-smi --query-gpu=uuid,memory.free,utilization.gpu --format=csv,noheader,nounits |
    awk -F',' -v uuid="$TARGET_GPU_UUID" '{gsub(/ /,"",$1); if ($1==uuid) {gsub(/ /,"",$2); gsub(/ /,"",$3); print $2, $3}}'
)
if (( GPU_FREE_MIB_2 < MIN_FREE_GPU_MIB || GPU_UTIL_2 > MAX_GPU_UTIL )); then
  echo "BLOCKED: second GPU sample no longer satisfies the gate" >&2
  exit 25
fi
echo "PASS: resource gate satisfied. Run one process tree with batch=1 and workers=0."
