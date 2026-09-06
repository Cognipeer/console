#!/usr/bin/env bash
set -euo pipefail

: "${COMMUNITY_TAG:?COMMUNITY_TAG is required}"
: "${CONSOLE_EE_REPOSITORY:?CONSOLE_EE_REPOSITORY is required}"
for attempt in {1..180}; do
  COMMUNITY_REF=$(gh api "repos/${CONSOLE_EE_REPOSITORY}/contents/COMPAT.json?ref=main" \
    --jq .content | tr -d '\n' | base64 --decode | jq -r .communityRef)
  if [[ "${COMMUNITY_REF}" == "${COMMUNITY_TAG}" ]]; then
    exit 0
  fi
  if [[ "${attempt}" -lt 180 ]]; then sleep 10; fi
done
echo "::error::Console Enterprise compatibility pin was not observed for ${COMMUNITY_TAG}."
exit 1