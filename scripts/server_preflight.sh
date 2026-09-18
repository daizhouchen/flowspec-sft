#!/usr/bin/env bash
set -euo pipefail

# Read-only gate for a shared multi-GPU host. It never kills or modifies other jobs.
PROJECT_ROOT="${PROJECT_ROOT:-/data2/jiangjiaqi}"
TARGET_GPU_UUID="${TARGET_GPU_UUID:-}"
MIN_HOST_FREE_GIB="${MIN_HOST_FREE_GIB:-64}"
MIN_CGROUP_FREE_GIB="${MIN_CGROUP_FREE_GIB:-32}"
MIN_FREE_DISK_GIB="${MIN_FREE_DISK_GIB:-100}"
MIN_FREE_GPU_MIB="${MIN_FREE_GPU_MIB:-25600}"
MAX_GPU_UTIL="${MAX_GPU_UTIL:-5}"
MAX_LOAD_PER_CPU_PERCENT="${MAX_LOAD_PER_CPU_PERCENT:-75}"

bytes_to_gib() { awk -v bytes="$1" 'BEGIN {printf "%d", bytes/1024/1024/1024}'; }

echo "== host =="
hostname
date -Is
echo "== memory =="
free -h
echo "== cgroup =="
cat /sys/fs/cgroup/memory.max
cat /sys/fs/cgroup/memory.current
echo "== project storage =="
if [[ ! -d "$PROJECT_ROOT" ]]; then
  echo "BLOCKED: required project root does not exist: $PROJECT_ROOT" >&2
  exit 18
fi
df -h "$PROJECT_ROOT"
echo "== gpu snapshot 1 =="
nvidia-smi --query-gpu=index,uuid,name,memory.total,memory.used,memory.free,utilization.gpu \
  --format=csv,noheader,nounits
echo "== active compute processes (read only) =="
nvidia-smi --query-compute-apps=gpu_uuid,pid,process_name,used_memory --format=csv,noheader || true

CPU_COUNT="$(nproc)"
LOAD_ONE="$(awk '{print $1}' /proc/loadavg)"
if ! awk -v load="$LOAD_ONE" -v cpus="$CPU_COUNT" -v percent="$MAX_LOAD_PER_CPU_PERCENT" \
  'BEGIN {exit !(load < cpus * percent / 100)}'; then
  echo "BLOCKED: one-minute load ${LOAD_ONE} exceeds ${MAX_LOAD_PER_CPU_PERCENT}% of ${CPU_COUNT} CPUs" >&2
  exit 19
fi

HOST_FREE_GIB="$(free -b | awk '/^Mem:/ {printf "%d", $7/1024/1024/1024}')"
CGROUP_MAX="$(cat /sys/fs/cgroup/memory.max)"
CGROUP_CURRENT="$(cat /sys/fs/cgroup/memory.current)"
if [[ "$CGROUP_MAX" == "max" ]]; then
  CGROUP_FREE_GIB="$HOST_FREE_GIB"
else
  CGROUP_FREE_GIB="$(bytes_to_gib "$((CGROUP_MAX - CGROUP_CURRENT))")"
fi
FREE_DISK_GIB="$(df -Pk "$PROJECT_ROOT" | awk 'NR==2 {printf "%d", $4/1024/1024}')"

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

GPU_ROWS="$(nvidia-smi --query-gpu=uuid,memory.free,utilization.gpu --format=csv,noheader,nounits)"
if [[ -n "$TARGET_GPU_UUID" ]]; then
  read -r SELECTED_GPU_UUID GPU_FREE_MIB GPU_UTIL < <(
    awk -F',' -v uuid="$TARGET_GPU_UUID" '
      {gsub(/ /,"",$1); gsub(/ /,"",$2); gsub(/ /,"",$3); if ($1==uuid) print $1, $2, $3}' \
      <<< "$GPU_ROWS"
  )
else
  read -r SELECTED_GPU_UUID GPU_FREE_MIB GPU_UTIL < <(
    awk -F',' -v min_free="$MIN_FREE_GPU_MIB" -v max_util="$MAX_GPU_UTIL" '
      {gsub(/ /,"",$1); gsub(/ /,"",$2); gsub(/ /,"",$3); if ($2>=min_free && $3<=max_util) print $1, $2, $3}' \
      <<< "$GPU_ROWS" | sort -k2,2nr | head -n1
  )
fi
if [[ -z "${SELECTED_GPU_UUID:-}" ]]; then
  echo "BLOCKED: no visible GPU satisfies free-memory and utilization limits" >&2
  exit 23
fi
if (( GPU_FREE_MIB < MIN_FREE_GPU_MIB || GPU_UTIL > MAX_GPU_UTIL )); then
  echo "BLOCKED: selected GPU does not satisfy the gate" >&2
  exit 24
fi

echo "Sampling selected GPU again in 10 seconds..."
sleep 10
read -r GPU_FREE_MIB_2 GPU_UTIL_2 < <(
  nvidia-smi --query-gpu=uuid,memory.free,utilization.gpu --format=csv,noheader,nounits |
    awk -F',' -v uuid="$SELECTED_GPU_UUID" '
      {gsub(/ /,"",$1); if ($1==uuid) {gsub(/ /,"",$2); gsub(/ /,"",$3); print $2, $3}}'
)
if (( GPU_FREE_MIB_2 < MIN_FREE_GPU_MIB || GPU_UTIL_2 > MAX_GPU_UTIL )); then
  echo "BLOCKED: second GPU sample no longer satisfies the gate" >&2
  exit 25
fi
echo "PASS: SELECTED_GPU_UUID=$SELECTED_GPU_UUID"
echo "Run one process tree with batch=1, workers=0 and at most two CPU threads."
