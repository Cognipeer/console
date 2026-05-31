#!/usr/bin/env bash
#
# Build the agent and produce a release tarball at packages/gpu-agent/release/
# named cognipeer-gpu-agent-<version>-linux-x64.tar.gz. The tarball is what
# you upload to Azure Blob Storage and what install.sh consumes.
#
# Version defaults to the value in package.json; override with --version.
#
# Usage:
#   bash packages/gpu-agent/scripts/package.sh [--version X.Y.Z]
#

set -euo pipefail

cd "$(dirname "$0")/.."

VERSION=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --version) VERSION="$2"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

if [[ -z "${VERSION}" ]]; then
  VERSION=$(node -p "require('./package.json').version")
fi

echo "==> Building gpu-agent v${VERSION}"
npm run build --silent

STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT

cp dist/index.cjs "${STAGE}/cognipeer-gpu-agent"
cp scripts/install.sh "${STAGE}/install.sh"
cp README.md "${STAGE}/README.md"
chmod +x "${STAGE}/cognipeer-gpu-agent" "${STAGE}/install.sh"

mkdir -p release
OUT="release/cognipeer-gpu-agent-${VERSION}-linux-x64.tar.gz"
tar -C "${STAGE}" -czf "${OUT}" .
echo "==> Wrote ${OUT}"
echo "    size: $(du -h "${OUT}" | cut -f1)"
echo "    sha256: $(shasum -a 256 "${OUT}" | cut -d' ' -f1)"
