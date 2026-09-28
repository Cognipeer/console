#!/usr/bin/env bash
# Canonical copy lives in kogniser-crm/release-ci/. Product repos keep a
# byte-identical copy at ci/notify-release-crm.sh; change it only here.
#
# Reports a release step to the CRM release webhook (contract v3). The CRM
# answer becomes the step outcome:
#   managed   CRM tracks the delivery. Outputs release_id, execution_id and
#             expected_digest (the canonical build this delivery must ship).
#   observed  CRM recorded a branch build it binds to releases on its own.
#   unmanaged CRM has no record (manual tag, unknown target), is not
#             configured, is unreachable, or answered a 4xx that is not its
#             own rejection (proxy, wrong URL, secret mismatch). Warns and
#             continues.
#   rejected  CRM refused the delivery. Fails the step.
#
# Required env: PRODUCT, TARGET_KEY, CRM_ENVIRONMENT, COMMIT_SHA,
#   RELEASE_STATUS, RUN_URL, GITHUB_REPOSITORY.
# Optional env: WEBHOOK_URL, WEBHOOK_SECRET, RELEASE_VERSION, CHART_VERSION,
#   IMAGE_REF, IMMUTABLE_REF, REQUIRE_BUILD_ARTIFACT=true.
set -euo pipefail

CONTRACT_VERSION=3

: "${PRODUCT:?PRODUCT is required}"
: "${TARGET_KEY:?TARGET_KEY is required}"
: "${CRM_ENVIRONMENT:?CRM_ENVIRONMENT is required}"
: "${COMMIT_SHA:?COMMIT_SHA is required}"
: "${RELEASE_STATUS:?RELEASE_STATUS is required}"
: "${RUN_URL:?RUN_URL is required}"
: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"

write_outputs() {
  [[ -n "${GITHUB_OUTPUT:-}" ]] || return 0
  {
    echo "crm_mode=$1"
    echo "release_id=$2"
    echo "execution_id=$3"
    echo "expected_digest=$4"
  } >> "${GITHUB_OUTPUT}"
}

unmanaged() {
  echo "::warning::CRM ${TARGET_KEY} ${RELEASE_VERSION:-}: $1 CRM kaydi olmadan devam ediliyor."
  write_outputs unmanaged "" "" ""
  exit 0
}

rejected() {
  echo "::error::CRM ${TARGET_KEY} ${RELEASE_VERSION:-} teslimatini reddetti: $1"
  exit 1
}

if [[ -z "${WEBHOOK_URL:-}" || -z "${WEBHOOK_SECRET:-}" ]]; then
  unmanaged "RELEASE_WEBHOOK_URL / RELEASE_WEBHOOK_SECRET tanimli degil."
fi

# Unset secrets leave dangling separators in composed references.
[[ "${IMAGE_REF:-}" == *: ]] && IMAGE_REF=""
[[ "${IMMUTABLE_REF:-}" == *@ ]] && IMMUTABLE_REF=""
if [[ -n "${IMMUTABLE_REF:-}" && ! "${IMMUTABLE_REF}" =~ ^[^[:space:]@]+@sha256:[0-9a-f]{64}$ ]]; then
  if [[ "${RELEASE_STATUS}" == "failed" ]]; then
    IMMUTABLE_REF=""
  else
    echo "::error::IMMUTABLE_REF gecerli bir image digest'i icermiyor."
    exit 1
  fi
fi

PAYLOAD_FILE=$(mktemp)
RESPONSE_FILE=$(mktemp)
trap 'rm -f "${PAYLOAD_FILE}" "${RESPONSE_FILE}"' EXIT

jq -n \
  --argjson contractVersion "${CONTRACT_VERSION}" \
  --arg product "${PRODUCT}" \
  --arg repo "${GITHUB_REPOSITORY}" \
  --arg targetKey "${TARGET_KEY}" \
  --arg environment "${CRM_ENVIRONMENT}" \
  --arg version "${RELEASE_VERSION:-}" \
  --arg chartVersion "${CHART_VERSION:-}" \
  --arg commitSha "${COMMIT_SHA}" \
  --arg imageRef "${IMAGE_REF:-}" \
  --arg immutableRef "${IMMUTABLE_REF:-}" \
  --arg status "${RELEASE_STATUS}" \
  --arg actor "${GITHUB_ACTOR:-github-actions}" \
  --arg runUrl "${RUN_URL}" \
  '{
    contractVersion: $contractVersion,
    product: $product,
    repo: $repo,
    targetKey: $targetKey,
    environment: $environment,
    version: (if $version == "" then null else $version end),
    chartVersion: (if $chartVersion == "" then null else $chartVersion end),
    commitSha: $commitSha,
    imageRef: (if $imageRef == "" then null else $imageRef end),
    immutableRef: (if $immutableRef == "" then null else $immutableRef end),
    status: $status,
    actor: $actor,
    runUrl: $runUrl
  }' > "${PAYLOAD_FILE}"

SIGNATURE=$(openssl dgst -sha256 -hmac "${WEBHOOK_SECRET}" -hex "${PAYLOAD_FILE}" | sed 's/^.* //')

HTTP_CODE=$(curl --retry 3 --retry-delay 2 --retry-max-time 60 \
  --connect-timeout 10 --max-time 30 \
  --silent --show-error \
  --request POST "${WEBHOOK_URL}" \
  --header "Content-Type: application/json" \
  --header "X-Cognipeer-Signature: sha256=${SIGNATURE}" \
  --data-binary "@${PAYLOAD_FILE}" \
  --output "${RESPONSE_FILE}" \
  --write-out '%{http_code}') || HTTP_CODE=000

response_field() {
  jq -r "$1 // empty" "${RESPONSE_FILE}" 2>/dev/null || true
}

case "${HTTP_CODE}" in
  2??) ;;
  4??)
    [[ "$(response_field '.mode')" == "rejected" ]] \
      && rejected "$(response_field '.error') (HTTP ${HTTP_CODE})"
    unmanaged "CRM HTTP ${HTTP_CODE} dondu ($(response_field '.error // .reason' | head -c 120)), teslimati reddetmedi."
    ;;
  *) unmanaged "CRM'e ulasilamadi (HTTP ${HTTP_CODE})." ;;
esac

# A CRM that predates v3 records the callback but cannot confirm it.
if [[ "$(response_field '.contractVersion')" != "${CONTRACT_VERSION}" ]]; then
  unmanaged "CRM v${CONTRACT_VERSION} sozlesmesini desteklemiyor."
fi

case "$(response_field '.mode')" in
  managed) ;;
  observed)
    write_outputs observed "" "" ""
    echo "CRM recorded ${PRODUCT}/${TARGET_KEY} build ${RELEASE_VERSION:-}: ${RELEASE_STATUS}."
    exit 0
    ;;
  *) unmanaged "CRM bu teslimati takip etmiyor ($(response_field '.reason // "no_release"'))." ;;
esac

jq -e --arg target "${TARGET_KEY}" --arg environment "${CRM_ENVIRONMENT}" '
  .status == "recorded"
  and (.releaseId | type == "string" and test("^[A-Za-z0-9-]+$"))
  and (.executionId | type == "string" and test("^[A-Za-z0-9-]+$"))
  and .targetKey == $target and .environmentKey == $environment
' "${RESPONSE_FILE}" >/dev/null \
  || rejected "CRM cevabi secili hedef ve ortamla uyusmuyor."

EXPECTED_DIGEST=$(response_field '.expectedDigest')
if [[ "${REQUIRE_BUILD_ARTIFACT:-false}" == "true" && "${RELEASE_STATUS}" != "failed" \
  && ! "${EXPECTED_DIGEST}" =~ ^sha256:[0-9a-f]{64}$ ]]; then
  rejected "CRM canonical build digest'ini vermedi."
fi

write_outputs managed "$(response_field '.releaseId')" "$(response_field '.executionId')" "${EXPECTED_DIGEST}"
echo "CRM recorded ${PRODUCT}/${TARGET_KEY} ${RELEASE_VERSION:-}: ${RELEASE_STATUS}."
