#!/usr/bin/env bash
# Build the Cognipeer Sandbox base image used by the default template.
# Run once per runner host (or push to a registry your runners can pull from).
set -euo pipefail
TAG="${SANDBOX_BASE_TAG:-cognipeer/sandbox-base:latest}"
DIR="$(cd "$(dirname "$0")/.." && pwd)"
echo "Building ${TAG} ..."
docker build -t "${TAG}" "${DIR}/docker/sandbox-base"
echo "Done. Image: ${TAG}"
docker run --rm --entrypoint sh "${TAG}" -c 'echo "git: $(git --version)"; echo "python: $(python3 --version)"; echo "node: $(node --version)"'
