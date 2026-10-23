#!/usr/bin/env bash
# Build the Cognipeer web + browser testing sandbox image (web-e2e template).
# Run once per runner host (or push to a registry your runners can pull from).
set -euo pipefail
TAG="${SANDBOX_WEB_E2E_TAG:-cognipeer/sandbox-web-e2e:latest}"
DIR="$(cd "$(dirname "$0")/.." && pwd)"
echo "Building ${TAG} ..."
docker build -t "${TAG}" --build-arg "BASE_IMAGE=${SANDBOX_BASE_TAG:-cognipeer/sandbox-base:latest}" "${DIR}/docker/sandbox-web-e2e"
echo "Done. Image: ${TAG}"
docker run --rm --entrypoint sh "${TAG}" -c 'echo "playwright: $(playwright --version)"; echo "ffmpeg: $(ffmpeg -version | head -1)"'
