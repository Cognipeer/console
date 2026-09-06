#!/usr/bin/env bash
set -euo pipefail

: "${IMAGE_REF:?IMAGE_REF is required}"
: "${SOURCE_SHA_REF:?SOURCE_SHA_REF is required}"
: "${GITHUB_OUTPUT:?GITHUB_OUTPUT is required}"
ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
source "${ROOT_DIR}/registry-digest.sh"

VERSION_DIGEST=$(registry_digest "${IMAGE_REF}")
SOURCE_DIGEST=$(registry_digest "${SOURCE_SHA_REF}")
if [[ -n "${VERSION_DIGEST}" ]]; then
  [[ "${VERSION_DIGEST}" == "${SOURCE_DIGEST}" ]] \
    || { echo "::error::${IMAGE_REF} does not belong to the selected source SHA."; exit 1; }
elif [[ -n "${SOURCE_DIGEST}" ]]; then
  docker buildx imagetools create --prefer-index=false --progress plain \
    --tag "${IMAGE_REF}" "${SOURCE_SHA_REF}@${SOURCE_DIGEST}"
  VERSION_DIGEST=$(registry_digest "${IMAGE_REF}")
  [[ "${VERSION_DIGEST}" == "${SOURCE_DIGEST}" ]] \
    || { echo "::error::Restoring the version tag changed the source digest."; exit 1; }
else
  echo "reuse=false" >> "${GITHUB_OUTPUT}"
  exit 0
fi

{
  echo "reuse=true"
  echo "digest=${VERSION_DIGEST}"
} >> "${GITHUB_OUTPUT}"