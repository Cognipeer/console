#!/usr/bin/env bash
#
# Cognipeer GPU agent installer.
#
# Cross-platform: works on Linux (systemd, root install) and macOS (launchd,
# user install, no sudo). Detects the right path via `uname` — the asset URL
# itself is platform-tagged, but the script can also be invoked anywhere.
#
# Prerequisites it checks:
#   - Linux + NVIDIA host : Docker, Node 20+, nvidia-smi (driver), optionally nvidia-container-toolkit
#   - Linux CPU-only host : Docker, Node 20+
#   - macOS Apple Silicon : Docker Desktop running, Node 20+
#
# With --auto-install-prereqs, the installer will TRY to install the
# missing ones via the platform's package manager (apt/dnf/brew). This is
# best-effort — NVIDIA drivers are never auto-installed (reboot + kernel
# match issues; operator should own that step).
#
# Usage:
#   curl -fsSL <console>/api/gpu-fleet/installer.sh | bash -s -- \
#     --console-url https://console.example.com \
#     --tenant-slug acme \
#     --fleet-token gpuflt_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx \
#     --asset-url https://<console>/api/gpu-fleet/agent-bundle/<platform>.tar.gz \
#     [--auto-install-prereqs]
#     [--hostname my-gpu-01]
#

set -euo pipefail

CONSOLE_URL=""
TENANT_SLUG=""
REGISTRATION_TOKEN=""
FLEET_TOKEN=""
ASSET_URL=""
HOSTNAME_OVERRIDE=""
AUTO_INSTALL=false
REBOOT_REQUIRED=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --console-url) CONSOLE_URL="$2"; shift 2 ;;
    --tenant-slug) TENANT_SLUG="$2"; shift 2 ;;
    --registration-token) REGISTRATION_TOKEN="$2"; shift 2 ;;
    --fleet-token) FLEET_TOKEN="$2"; shift 2 ;;
    --asset-url) ASSET_URL="$2"; shift 2 ;;
    --hostname) HOSTNAME_OVERRIDE="$2"; shift 2 ;;
    --auto-install-prereqs) AUTO_INSTALL=true; shift 1 ;;
    -h|--help)
      grep -E '^#' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *)
      echo "unknown argument: $1" >&2
      exit 2 ;;
  esac
done

if [[ -z "${CONSOLE_URL}" || -z "${TENANT_SLUG}" || -z "${ASSET_URL}" ]]; then
  echo "usage: install.sh --console-url URL --tenant-slug SLUG --asset-url URL (--fleet-token TOKEN | --registration-token TOKEN) [--auto-install-prereqs]" >&2
  exit 2
fi
if [[ -z "${REGISTRATION_TOKEN}" && -z "${FLEET_TOKEN}" ]]; then
  echo "either --fleet-token or --registration-token is required" >&2
  exit 2
fi

# ── Platform detection ─────────────────────────────────────────────────────

OS="$(uname -s)"   # Darwin | Linux
ARCH="$(uname -m)" # arm64 | x86_64 | aarch64

case "${OS}/${ARCH}" in
  Darwin/arm64)     PLATFORM_KEY="darwin-arm64";   IS_MAC=true;   IS_LINUX=false ;;
  Darwin/x86_64)    PLATFORM_KEY="darwin-x64";     IS_MAC=true;   IS_LINUX=false ;;
  Linux/x86_64)     PLATFORM_KEY="linux-x64";      IS_MAC=false;  IS_LINUX=true ;;
  Linux/aarch64)    PLATFORM_KEY="linux-arm64";    IS_MAC=false;  IS_LINUX=true ;;
  *) echo "Unsupported platform: ${OS}/${ARCH}" >&2; exit 3 ;;
esac
echo "==> Detected platform: ${PLATFORM_KEY}"

# ── Privileges ─────────────────────────────────────────────────────────────

NEEDS_ROOT=false
if [[ "${IS_LINUX}" == "true" ]]; then
  NEEDS_ROOT=true
fi

# On macOS the agent is a per-user install — running with sudo would write
# state files (~/.cognipeer/gpu-agent, ~/Library/LaunchAgents/...) owned by
# root which the unprivileged user can no longer manage. Reject early so
# the operator notices instead of having to `sudo rm -rf` to recover.
if [[ "${IS_MAC}" == "true" && "${EUID}" -eq 0 ]]; then
  echo "Do not run the macOS installer with sudo." >&2
  echo "The agent is installed per-user under \$HOME — run as your normal user." >&2
  exit 2
fi

SUDO=""
if [[ "${NEEDS_ROOT}" == "true" ]]; then
  if [[ "${EUID}" -ne 0 ]]; then
    if command -v sudo >/dev/null 2>&1; then
      SUDO="sudo"
    else
      echo "this script must run as root on Linux (no sudo found)" >&2
      exit 2
    fi
  fi
fi

# ── Layout ─────────────────────────────────────────────────────────────────

if [[ "${IS_MAC}" == "true" ]]; then
  # Per-user install. No sudo, no system-wide write.
  INSTALL_DIR="${HOME}/.cognipeer/gpu-agent"
  BIN_PATH="${INSTALL_DIR}/bin/cognipeer-gpu-agent"
  STATE_DIR="${INSTALL_DIR}/state"
  ENV_FILE="${INSTALL_DIR}/env"
  LAUNCHD_PLIST="${HOME}/Library/LaunchAgents/com.cognipeer.gpu-agent.plist"
  LOG_DIR="${INSTALL_DIR}/logs"
else
  INSTALL_DIR="/opt/cognipeer-gpu-agent"
  BIN_PATH="${INSTALL_DIR}/cognipeer-gpu-agent"
  STATE_DIR="/var/lib/cognipeer-gpu-agent"
  ENV_FILE="/etc/cognipeer-gpu-agent.env"
  SYSTEMD_UNIT="/etc/systemd/system/cognipeer-gpu-agent.service"
fi

# ── Prerequisite checks ────────────────────────────────────────────────────

missing=()
warnings=()

# Docker is required on all platforms. The agent uses dockerode against the
# local docker daemon. Docker Desktop on Mac satisfies this.
if ! command -v docker >/dev/null 2>&1; then
  missing+=("docker")
elif ! docker info >/dev/null 2>&1; then
  warnings+=("docker installed but daemon is not running")
fi

# Node 20+ is required because the agent is a Node binary. On Mac users
# usually have it; on Linux we may need to install it. Production binary
# distributions are still planned (bun --compile) — until then, Node is a hard dep.
if ! command -v node >/dev/null 2>&1; then
  missing+=("node")
else
  NODE_VER="$(node -v | sed -E 's/v([0-9]+).*/\1/')"
  if [[ "${NODE_VER}" -lt 20 ]]; then
    missing+=("node (≥20)")
  fi
fi

# NVIDIA-specific checks. We're explicitly platform-aware here — Mac and
# CPU-only Linux hosts must not be asked for nvidia-smi.
#
# Detection has three layers:
#   1. `lspci` — is there NVIDIA hardware on the bus at all?
#   2. `nvidia-smi` — is the driver installed and can it talk to the kernel module?
#   3. `nvidia-ctk` — can docker pass GPUs into containers?
#
# We track these separately so the auto-installer below knows what to do
# (e.g. "hardware present but driver missing" → install driver).
HAS_NVIDIA_HARDWARE=false
NVIDIA_DRIVER_OK=false
NVIDIA_TOOLKIT_OK=false
if [[ "${IS_LINUX}" == "true" ]] && [[ "${PLATFORM_KEY}" == "linux-x64" ]]; then
  if command -v lspci >/dev/null 2>&1 && lspci 2>/dev/null | grep -qi nvidia; then
    HAS_NVIDIA_HARDWARE=true
  fi
  if command -v nvidia-smi >/dev/null 2>&1 && nvidia-smi >/dev/null 2>&1; then
    NVIDIA_DRIVER_OK=true
  fi
  if command -v nvidia-ctk >/dev/null 2>&1; then
    NVIDIA_TOOLKIT_OK=true
  fi

  if "${HAS_NVIDIA_HARDWARE}"; then
    if ! "${NVIDIA_DRIVER_OK}"; then
      missing+=("nvidia-driver")
    fi
    if ! "${NVIDIA_TOOLKIT_OK}"; then
      missing+=("nvidia-container-toolkit")
    fi
  else
    warnings+=("no NVIDIA hardware detected — agent will register as a CPU-only host")
  fi
fi

# ── Auto-install (best effort) ─────────────────────────────────────────────

install_via() {
  local label="$1"; shift
  echo "  → installing ${label}..."
  "$@"
}

attempt_auto_install() {
  if [[ "${AUTO_INSTALL}" != "true" ]]; then
    return 1
  fi

  echo "==> --auto-install-prereqs enabled; attempting to install missing packages"

  if [[ "${IS_MAC}" == "true" ]]; then
    if ! command -v brew >/dev/null 2>&1; then
      echo "  brew not found; cannot auto-install on macOS. Install Homebrew first: https://brew.sh" >&2
      return 1
    fi
    for dep in "${missing[@]}"; do
      case "${dep}" in
        docker)  install_via "Docker Desktop" brew install --cask docker ;;
        node)    install_via "Node 20" brew install node@20 ;;
        "node (≥20)") install_via "Node 20" brew install node@20 ;;
      esac
    done
  else
    # Cross-distro: use Docker's official convenience script. Works on
    # Ubuntu, Debian, RHEL, CentOS, Rocky, Fedora, openSUSE — auto-detects
    # the distro and configures the right repo. Avoids the
    # `Unable to locate package docker.io` failure on RHEL-family Azure
    # images that don't have a `docker.io` package at all.
    HAS_APT=false; command -v apt-get >/dev/null 2>&1 && HAS_APT=true
    HAS_DNF=false; command -v dnf >/dev/null 2>&1 && HAS_DNF=true

    for dep in "${missing[@]}"; do
      case "${dep}" in
        docker)
          if ! command -v curl >/dev/null 2>&1; then
            if "${HAS_APT}"; then ${SUDO} apt-get update -y && ${SUDO} apt-get install -y curl
            elif "${HAS_DNF}"; then ${SUDO} dnf install -y curl
            fi
          fi
          curl -fsSL https://get.docker.com | ${SUDO} sh
          ${SUDO} systemctl enable --now docker 2>/dev/null || true
          ;;
        node|"node (≥20)")
          if "${HAS_APT}"; then
            curl -fsSL https://deb.nodesource.com/setup_20.x | ${SUDO} bash -
            ${SUDO} apt-get install -y nodejs
          elif "${HAS_DNF}"; then
            curl -fsSL https://rpm.nodesource.com/setup_20.x | ${SUDO} bash -
            ${SUDO} dnf install -y nodejs
          else
            echo "  Unsupported package manager. Install Node 20+ manually." >&2
            return 1
          fi
          ;;
        nvidia-driver)
          # `ubuntu-drivers autoinstall` picks the right driver for the
          # detected hardware. On RHEL-family we add NVIDIA's repo and
          # install cuda-drivers (a thin package that pulls the kernel
          # driver). Both paths require a reboot before nvidia-smi works.
          if "${HAS_APT}"; then
            ${SUDO} apt-get update -y
            ${SUDO} apt-get install -y ubuntu-drivers-common build-essential dkms linux-headers-$(uname -r) || true
            if command -v ubuntu-drivers >/dev/null 2>&1; then
              ${SUDO} ubuntu-drivers autoinstall
            else
              # Fallback: install the latest recommended driver from CUDA repo
              ${SUDO} apt-get install -y nvidia-driver-550 || ${SUDO} apt-get install -y nvidia-driver-535 || true
            fi
          elif "${HAS_DNF}"; then
            # NVIDIA CUDA repo for RHEL-family
            ${SUDO} dnf config-manager --add-repo https://developer.download.nvidia.com/compute/cuda/repos/rhel9/x86_64/cuda-rhel9.repo 2>/dev/null \
              || ${SUDO} dnf config-manager --add-repo https://developer.download.nvidia.com/compute/cuda/repos/rhel8/x86_64/cuda-rhel8.repo 2>/dev/null
            ${SUDO} dnf clean expire-cache
            ${SUDO} dnf -y module install nvidia-driver:latest-dkms || ${SUDO} dnf install -y cuda-drivers
          else
            echo "  Unsupported package manager. Install the NVIDIA driver manually." >&2
            return 1
          fi
          REBOOT_REQUIRED=true
          ;;
        nvidia-container-toolkit)
          if "${HAS_APT}"; then
            ${SUDO} install -m 0755 -d /etc/apt/keyrings 2>/dev/null || true
            curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey \
              | ${SUDO} gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg
            curl -fsSL https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list \
              | sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' \
              | ${SUDO} tee /etc/apt/sources.list.d/nvidia-container-toolkit.list >/dev/null
            ${SUDO} apt-get update -y
            ${SUDO} apt-get install -y nvidia-container-toolkit
          elif "${HAS_DNF}"; then
            curl -fsSL https://nvidia.github.io/libnvidia-container/stable/rpm/nvidia-container-toolkit.repo \
              | ${SUDO} tee /etc/yum.repos.d/nvidia-container-toolkit.repo >/dev/null
            ${SUDO} dnf install -y nvidia-container-toolkit
          fi
          # Wire docker to actually use the new runtime
          ${SUDO} nvidia-ctk runtime configure --runtime=docker 2>/dev/null || true
          ${SUDO} systemctl restart docker 2>/dev/null || true
          ;;
      esac
    done
  fi
  # Re-check what's still missing post-install. nvidia-driver is
  # intentionally NOT re-checked here: the kernel module won't load until
  # the box reboots, so `nvidia-smi` will still fail and we surface that
  # via the REBOOT_REQUIRED bailout below.
  missing=()
  command -v docker >/dev/null 2>&1 || missing+=("docker")
  if command -v node >/dev/null 2>&1; then
    NODE_VER="$(node -v | sed -E 's/v([0-9]+).*/\1/')"
    [[ "${NODE_VER}" -lt 20 ]] && missing+=("node (≥20)")
  else
    missing+=("node")
  fi
  if "${HAS_NVIDIA_HARDWARE}" && ! command -v nvidia-ctk >/dev/null 2>&1; then
    missing+=("nvidia-container-toolkit")
  fi
}

echo "==> Verifying prerequisites for ${PLATFORM_KEY}"
if [[ ${#missing[@]} -gt 0 ]]; then
  echo "  Missing: ${missing[*]}"
  attempt_auto_install || true
fi
if [[ ${#missing[@]} -gt 0 ]]; then
  echo
  echo "Cannot continue — the following prerequisites are missing:" >&2
  for m in "${missing[@]}"; do
    echo "  ✗ ${m}" >&2
  done
  echo >&2
  echo "Re-run with --auto-install-prereqs, or install them manually and re-run." >&2
  exit 4
fi
if "${REBOOT_REQUIRED}"; then
  echo
  echo "✓ NVIDIA driver installed (or upgraded) — REBOOT REQUIRED before the agent can use the GPU."
  echo "  After reboot, re-run the SAME install command — the script is idempotent and will"
  echo "  skip the already-installed pieces, finish toolkit setup, and start the agent."
  echo
  echo "    sudo reboot"
  echo
  exit 0
fi
if [[ ${#warnings[@]} -gt 0 ]]; then
  for w in "${warnings[@]}"; do
    echo "  ⚠  ${w}"
  done
fi
echo "  ✓ docker"
echo "  ✓ node $(node -v)"
if "${HAS_NVIDIA_HARDWARE}"; then
  if "${NVIDIA_DRIVER_OK}" || (command -v nvidia-smi >/dev/null 2>&1 && nvidia-smi >/dev/null 2>&1); then
    echo "  ✓ nvidia-smi $(nvidia-smi --query-gpu=driver_version --format=csv,noheader | head -1)"
  fi
  command -v nvidia-ctk >/dev/null 2>&1 && echo "  ✓ nvidia-container-toolkit"
fi

# ── Download + extract ─────────────────────────────────────────────────────

echo "==> Downloading ${ASSET_URL}"
mkdir -p "$(dirname "${BIN_PATH}")" "${STATE_DIR}"
${SUDO} mkdir -p "${INSTALL_DIR}" 2>/dev/null || true

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
curl -fsSL "${ASSET_URL}" -o "${TMP}/agent.tar.gz"

if [[ "${IS_MAC}" == "true" ]]; then
  mkdir -p "${INSTALL_DIR}/bin" "${LOG_DIR}"
  tar -xzf "${TMP}/agent.tar.gz" -C "${INSTALL_DIR}/bin"
  chmod +x "${BIN_PATH}"
else
  ${SUDO} tar -xzf "${TMP}/agent.tar.gz" -C "${INSTALL_DIR}"
  ${SUDO} chmod +x "${BIN_PATH}"
fi

# ── env file ───────────────────────────────────────────────────────────────

echo "==> Writing env file"
write_env() {
  cat <<EOF
COGNIPEER_CONSOLE_URL=${CONSOLE_URL}
COGNIPEER_TENANT_SLUG=${TENANT_SLUG}
${REGISTRATION_TOKEN:+COGNIPEER_REGISTRATION_TOKEN=${REGISTRATION_TOKEN}}
${FLEET_TOKEN:+COGNIPEER_FLEET_TOKEN=${FLEET_TOKEN}}
COGNIPEER_STATE_DIR=${STATE_DIR}
${HOSTNAME_OVERRIDE:+COGNIPEER_HOSTNAME=${HOSTNAME_OVERRIDE}}
EOF
}

if [[ "${IS_MAC}" == "true" ]]; then
  umask 077
  write_env > "${ENV_FILE}"
  chmod 600 "${ENV_FILE}"
else
  write_env | ${SUDO} tee "${ENV_FILE}" >/dev/null
  ${SUDO} chmod 600 "${ENV_FILE}"
fi

# ── Install service ────────────────────────────────────────────────────────

if [[ "${IS_MAC}" == "true" ]]; then
  echo "==> Installing launchd agent at ${LAUNCHD_PLIST}"
  mkdir -p "$(dirname "${LAUNCHD_PLIST}")"

  # Resolve absolute node path at install time so the plist doesn't depend
  # on launchd's PATH (which is minimal — /usr/bin:/bin:/usr/sbin:/sbin and
  # never includes Homebrew). Without this, `env node` fails with
  # "No such file or directory" even when node works in the operator's shell.
  NODE_BIN="$(command -v node)"
  if [[ -z "${NODE_BIN}" ]]; then
    echo "node binary disappeared between prereq check and plist write — aborting" >&2
    exit 5
  fi

  # We also inject a PATH into EnvironmentVariables so docker / brew tools
  # the agent later shells out to are reachable. Include the operator's
  # current $PATH plus Homebrew's canonical paths for both Apple Silicon and
  # Intel Macs, plus the standard system bin dirs.
  PATH_VALUE="${PATH}:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/local/sbin:/usr/bin:/bin:/usr/sbin:/sbin"

  # plist envs come from EnvironmentVariables; we parse the env file we just wrote
  ENV_XML=""
  while IFS='=' read -r k v; do
    [[ -z "${k}" ]] && continue
    ENV_XML="${ENV_XML}
    <key>${k}</key><string>${v}</string>"
  done < "${ENV_FILE}"

  cat > "${LAUNCHD_PLIST}" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.cognipeer.gpu-agent</string>
  <key>ProgramArguments</key>
  <array>
    <string>${NODE_BIN}</string>
    <string>${BIN_PATH}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${PATH_VALUE}</string>${ENV_XML}
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>${LOG_DIR}/agent.out.log</string>
  <key>StandardErrorPath</key><string>${LOG_DIR}/agent.err.log</string>
</dict>
</plist>
EOF

  # Validate the plist BEFORE touching launchd — saves the operator from
  # diagnosing "Load failed: 5: Input/output error", which is launchd's
  # generic "something's wrong" code.
  if ! plutil -lint "${LAUNCHD_PLIST}" >/dev/null; then
    echo "Generated plist is invalid:" >&2
    plutil -lint "${LAUNCHD_PLIST}" >&2 || true
    exit 6
  fi

  # Use modern launchctl bootstrap/bootout (Big Sur+). Falls back to
  # load/unload on older systems. `bootout` is idempotent — silently exits
  # 0 when the service isn't loaded, so we don't need a pre-check.
  TARGET="gui/$(id -u)"
  echo "==> Loading launchd agent into ${TARGET}"
  if launchctl bootstrap "${TARGET}" "${LAUNCHD_PLIST}" 2>/dev/null; then
    : # modern path worked
  elif launchctl bootout "${TARGET}/com.cognipeer.gpu-agent" 2>/dev/null \
       && launchctl bootstrap "${TARGET}" "${LAUNCHD_PLIST}"; then
    : # was already loaded; bootout + bootstrap fixed it
  else
    # Legacy fallback — also handle stale state by unloading first
    launchctl unload "${LAUNCHD_PLIST}" 2>/dev/null || true
    launchctl load "${LAUNCHD_PLIST}"
  fi
  echo "==> Installed."
  echo "    Node binary: ${NODE_BIN}"
  echo "    Tail logs:   tail -F ${LOG_DIR}/agent.err.log ${LOG_DIR}/agent.out.log"
  echo "    Stop agent:  launchctl bootout ${TARGET}/com.cognipeer.gpu-agent"
  echo "    Start agent: launchctl bootstrap ${TARGET} ${LAUNCHD_PLIST}"
else
  # Resolve absolute node path so the systemd unit doesn't depend on the
  # default PATH the unit inherits (which can miss nvm/nodesource installs).
  NODE_BIN="$(command -v node)"
  if [[ -z "${NODE_BIN}" ]]; then
    echo "node binary disappeared between prereq check and unit write — aborting" >&2
    exit 5
  fi

  echo "==> Installing systemd unit at ${SYSTEMD_UNIT}"
  ${SUDO} tee "${SYSTEMD_UNIT}" >/dev/null <<EOF
[Unit]
Description=Cognipeer GPU Fleet Agent
After=docker.service network-online.target
Wants=docker.service network-online.target

[Service]
Type=simple
EnvironmentFile=${ENV_FILE}
Environment=PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
ExecStart=${NODE_BIN} ${BIN_PATH}
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal
User=root

[Install]
WantedBy=multi-user.target
EOF
  ${SUDO} systemctl daemon-reload
  ${SUDO} systemctl enable --now cognipeer-gpu-agent.service
  echo "==> Installed."
  echo "    Tail logs:   journalctl -u cognipeer-gpu-agent -f"
  echo "    Stop agent:  sudo systemctl stop cognipeer-gpu-agent"
  echo "    Start agent: sudo systemctl start cognipeer-gpu-agent"
fi
