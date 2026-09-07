#!/usr/bin/env bash
set -euo pipefail

: "${IMAGE_REF:?IMAGE_REF is required}"
: "${SOURCE_COMMIT_SHA:?SOURCE_COMMIT_SHA is required}"
: "${GITHUB_OUTPUT:?GITHUB_OUTPUT is required}"
ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
source "${ROOT_DIR}/registry-digest.sh"

VERSION_DIGEST=$(registry_digest "${IMAGE_REF}")
if [[ -z "${VERSION_DIGEST}" ]]; then
  echo "reuse=false" >> "${GITHUB_OUTPUT}"
  exit 0
fi
assert_image_identity "${IMAGE_REF}" "${VERSION_DIGEST}" "${SOURCE_COMMIT_SHA}"
{
  echo "reuse=true"
  echo "digest=${VERSION_DIGEST}"
} >> "${GITHUB_OUTPUT}"