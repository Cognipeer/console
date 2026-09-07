#!/usr/bin/env bash
set -euo pipefail

: "${WEBHOOK_URL:?WEBHOOK_URL is required}"
: "${WEBHOOK_SECRET:?WEBHOOK_SECRET is required}"
: "${COMMIT_SHA:?COMMIT_SHA is required}"
: "${RELEASE_VERSION:?RELEASE_VERSION is required}"
: "${RELEASE_STATUS:?RELEASE_STATUS is required}"
: "${RUN_URL:?RUN_URL is required}"

PAYLOAD_FILE=$(mktemp)
RESPONSE_FILE=$(mktemp)
trap 'rm -f "${PAYLOAD_FILE}" "${RESPONSE_FILE}"' EXIT
IMMUTABLE_REF=""
if [[ -n "${IMAGE_DIGEST:-}" ]]; then
  [[ "${IMAGE_DIGEST}" =~ ^sha256:[0-9a-f]{64}$ ]] || { echo "::error::Invalid Community digest." >&2; exit 1; }
  IMMUTABLE_REF="ghcr.io/cognipeer/console@${IMAGE_DIGEST}"
fi
if [[ "${RELEASE_STATUS}" == "succeeded" && -z "${IMMUTABLE_REF}" ]]; then
  echo "::error::Community success requires an immutable image digest." >&2
  exit 1
fi
jq -n \
  --arg repo "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}" \
  --arg version "${RELEASE_VERSION}" --arg commitSha "${COMMIT_SHA}" \
  --arg immutableRef "${IMMUTABLE_REF}" --arg status "${RELEASE_STATUS}" \
  --arg actor "${GITHUB_ACTOR:-github-actions}" --arg runUrl "${RUN_URL}" \
  '{
    requireExecution: true, product: "console", targetKey: "community", environment: "artifacts",
    repo: $repo, version: $version, commitSha: $commitSha,
    imageRef: ("ghcr.io/cognipeer/console:" + $version),
    immutableRef: (if $immutableRef == "" then null else $immutableRef end),
    status: $status, actor: $actor, runUrl: $runUrl
  }' > "${PAYLOAD_FILE}"
SIGNATURE=$(openssl dgst -sha256 -hmac "${WEBHOOK_SECRET}" -hex "${PAYLOAD_FILE}" | sed 's/^.* //')
curl --retry 3 --retry-delay 2 --retry-max-time 30 \
  --connect-timeout 10 --max-time 30 --fail-with-body --silent --show-error \
  --request POST "${WEBHOOK_URL}" \
  --header "Content-Type: application/json" \
  --header "X-Cognipeer-Signature: sha256=${SIGNATURE}" \
  --data-binary "@${PAYLOAD_FILE}" --output "${RESPONSE_FILE}"
jq -e '
  .contractVersion == 2 and .status == "recorded"
  and (.releaseId | type == "string" and test("^[A-Za-z0-9-]+$"))
  and (.executionId | type == "string" and test("^[A-Za-z0-9-]+$"))
  and .targetKey == "community" and .environmentKey == "artifacts"
' "${RESPONSE_FILE}" >/dev/null \
  || { echo "::error::CRM did not confirm the Community release execution." >&2; exit 1; }
echo "CRM recorded Community ${RELEASE_VERSION}: ${RELEASE_STATUS}."