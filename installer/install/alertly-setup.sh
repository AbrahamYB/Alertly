#!/usr/bin/env sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ROOT_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
CONFIG_DIR="$ROOT_DIR/config"
CONFIG_FILE="$CONFIG_DIR/installation.json"
HISTORY_FILE="$CONFIG_DIR/installation-history.jsonl"

read_os_value() {
  key="$1"
  if [ -r /etc/os-release ]; then
    value=$(sed -n "s/^${key}=//p" /etc/os-release | head -n 1)
    value=${value#\"}; value=${value%\"}
    printf '%s' "$value"
  fi
}

json_escape() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g; s/\t/\\t/g'
}

DISTRO=$(read_os_value ID); DISTRO=${DISTRO:-linux}
DISTRO_VERSION=$(read_os_value VERSION_ID); DISTRO_VERSION=${DISTRO_VERSION:-unknown}
ARCH=$(uname -m 2>/dev/null || printf unknown)
CPU=$(sed -n 's/^model name[[:space:]]*:[[:space:]]*//p' /proc/cpuinfo 2>/dev/null | head -n 1); CPU=${CPU:-Unknown CPU}
CORES=$(getconf _NPROCESSORS_ONLN 2>/dev/null || printf 1)
MEMORY_MB=$(awk '/MemTotal/ {printf "%d", $2 / 1024}' /proc/meminfo 2>/dev/null || printf 0)
GRAPHICS=$(command -v lspci >/dev/null 2>&1 && lspci | grep -Ei 'vga|3d|display' || true)
GPU_BRANDS=""
printf '%s' "$GRAPHICS" | grep -qi nvidia && GPU_BRANDS="nvidia"
printf '%s' "$GRAPHICS" | grep -Eqi 'advanced micro devices|amd/ati|radeon' && GPU_BRANDS="${GPU_BRANDS}${GPU_BRANDS:+,}amd"
printf '%s' "$GRAPHICS" | grep -qi intel && GPU_BRANDS="${GPU_BRANDS}${GPU_BRANDS:+,}intel"
DOCKER=false; command -v docker >/dev/null 2>&1 && DOCKER=true
SYSTEMD=false; command -v systemctl >/dev/null 2>&1 && SYSTEMD=true

print_detection() {
  cat <<EOF
Operating system: $DISTRO $DISTRO_VERSION ($ARCH)
CPU: $CPU ($CORES logical cores)
Memory: $MEMORY_MB MB
GPU: ${GRAPHICS:-No GPU reported by the operating system}
Docker available: $DOCKER
systemd available: $SYSTEMD
EOF
}

if [ "${1:-}" = "--detect" ]; then
  print_detection
  exit 0
fi

choose() {
  prompt="$1"; shift
  printf '\n%s\n' "$prompt" >&2
  index=1
  for option in "$@"; do
    printf '  %s. %s\n' "$index" "$option" >&2
    index=$((index + 1))
  done
  printf 'Choose [1]: ' >&2
  IFS= read -r answer
  answer=${answer:-1}
  case "$answer" in *[!0-9]*|'') printf 'Invalid selection.\n' >&2; exit 2;; esac
  [ "$answer" -ge 1 ] && [ "$answer" -le "$#" ] || { printf 'Invalid selection.\n' >&2; exit 2; }
  eval "printf '%s' \"\${$answer}\""
}

printf '\nAlertly guided setup\nHardware is detected locally and is not uploaded.\n\n'
print_detection

PROFILE_LABEL=$(choose "Installation profile" "Demo / current Alertly" "Organization")
case "$PROFILE_LABEL" in Demo*) PROFILE=demo;; *) PROFILE=organization;; esac

if [ "$PROFILE" = organization ]; then
  METHOD_LABEL=$(choose "Installation method" "Docker Compose" "Contained native Linux" "Split deployment with remote workers")
else
  METHOD_LABEL=$(choose "Installation method" "Docker Compose" "Contained native Linux")
fi
case "$METHOD_LABEL" in Docker*) METHOD=docker;; Contained*) METHOD=native;; *) METHOD=split;; esac

set --
printf '%s' "$GPU_BRANDS" | grep -q nvidia && set -- "$@" "NVIDIA GPU"
printf '%s' "$GPU_BRANDS" | grep -q amd && set -- "$@" "AMD GPU"
printf '%s' "$GPU_BRANDS" | grep -q intel && set -- "$@" "Intel GPU"
set -- "$@" "CPU only"
[ "$METHOD" = split ] && set -- "$@" "Remote worker decides"
ACCEL_LABEL=$(choose "Media processing" "$@")
case "$ACCEL_LABEL" in NVIDIA*) ACCEL=nvidia;; AMD*) ACCEL=amd;; Intel*) ACCEL=intel;; Remote*) ACCEL=remote;; *) ACCEL=cpu;; esac

REVISION=1
if [ -r "$CONFIG_FILE" ]; then
  OLD_REVISION=$(sed -n 's/.*"revision"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$CONFIG_FILE" | head -n 1)
  [ -n "$OLD_REVISION" ] && REVISION=$((OLD_REVISION + 1))
fi
UPDATED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
STORAGE=local; [ "$PROFILE" = organization ] && STORAGE=s3-compatible
WORKER_MODE=local; [ "$METHOD" = split ] && WORKER_MODE=remote
NATIVE_LAYOUT=null
if [ "$METHOD" = native ]; then
  NATIVE_LAYOUT='{"root":"/opt/alertly","releases":"/opt/alertly/releases","current":"/opt/alertly/current","runtime":"/opt/alertly/runtime","shared":"/opt/alertly/shared","externalFootprint":["/etc/systemd/system/alertly.service"]}'
fi

mkdir -p "$CONFIG_DIR"
umask 027
cat > "$CONFIG_FILE.tmp" <<EOF
{
  "schemaVersion": 1,
  "revision": $REVISION,
  "updatedAt": "$UPDATED_AT",
  "choices": { "profile": "$PROFILE", "method": "$METHOD", "acceleration": "$ACCEL" },
  "detected": {
    "platform": "linux",
    "architecture": "$(json_escape "$ARCH")",
    "distribution": "$(json_escape "$DISTRO")",
    "distributionVersion": "$(json_escape "$DISTRO_VERSION")",
    "cpuBrand": "$(json_escape "$CPU")",
    "cpuCores": $CORES,
    "memoryMb": $MEMORY_MB,
    "gpuBrands": "$(json_escape "$GPU_BRANDS")",
    "dockerAvailable": $DOCKER,
    "systemdAvailable": $SYSTEMD
  },
  "services": {
    "queue": { "backend": "postgres", "durable": true },
    "storage": { "backend": "$STORAGE" },
    "worker": { "mode": "$WORKER_MODE", "acceleration": "$ACCEL" }
  },
  "nativeLayout": $NATIVE_LAYOUT,
  "installState": "configured"
}
EOF
mv "$CONFIG_FILE.tmp" "$CONFIG_FILE"
printf '{"at":"%s","schemaVersion":1,"revision":%s,"choices":{"profile":"%s","method":"%s","acceleration":"%s"}}\n' "$UPDATED_AT" "$REVISION" "$PROFILE" "$METHOD" "$ACCEL" >> "$HISTORY_FILE"

printf '\nConfiguration saved as revision %s.\n' "$REVISION"
printf 'No services were changed. The apply step will always show its plan before making changes.\n'

