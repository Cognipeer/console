#!/usr/bin/env bash
set -euo pipefail

: "${GH_TOKEN:?GH_TOKEN is required}"
: "${COMMUNITY_TAG:?COMMUNITY_TAG is required}"
: "${COMMUNITY_SHA:?COMMUNITY_SHA is required}"
: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"
: "${CONSOLE_EE_REPOSITORY:?CONSOLE_EE_REPOSITORY is required}"
[[ "${COMMUNITY_SHA}" =~ ^[0-9a-f]{40}$ ]] || { echo "::error::Invalid Community commit SHA." >&2; exit 1; }

for attempt in {1..180}; do
  COMPAT=$(curl --fail --silent --show-error --connect-timeout 10 --max-time 30 \
    --header "Authorization: Bearer ${GH_TOKEN}" \
    --header "Accept: application/vnd.github.raw+json" \
    --header "X-GitHub-Api-Version: 2022-11-28" \
    "${GITHUB_API_URL:-https://api.github.com}/repos/${CONSOLE_EE_REPOSITORY}/contents/COMPAT.json?ref=main")
  jq -e 'type == "object" and (.communityRef | type == "string")' <<<"${COMPAT}" >/dev/null
  if jq -e --arg repo "${GITHUB_REPOSITORY}" --arg tag "${COMMUNITY_TAG}" --arg sha "${COMMUNITY_SHA}" \
    '.communityRepo == $repo and .communityRef == $tag and .communitySha == $sha' <<<"${COMPAT}" >/dev/null; then
    exit 0
  fi
  if [[ "${attempt}" -lt 180 ]]; then sleep 10; fi
done
echo "::error::Console Enterprise did not pin the exact Community tag and commit." >&2
exit 1