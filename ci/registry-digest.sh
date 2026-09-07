#!/usr/bin/env bash

registry_digest() {
  local image="$1" manifest error_file digest
  error_file=$(mktemp)
  if manifest=$(docker buildx imagetools inspect --format '{{json .Manifest}}' "${image}" 2>"${error_file}"); then
    rm -f "${error_file}"
    digest=$(jq -er '.digest | select(type == "string" and test("^sha256:[a-f0-9]{64}$"))' <<<"${manifest}") \
      || { echo "::error::Invalid registry response for ${image}." >&2; return 1; }
    printf '%s\n' "${digest}"
  elif grep -Eiq '(^|[^[:alpha:]_])(manifest unknown|manifest_unknown|name_unknown)([^[:alpha:]_]|$)' "${error_file}" \
    || grep -Fqx -e "ERROR: ${image}: not found" -e "Error: ${image}: not found" -e "${image}: not found" "${error_file}"; then
    rm -f "${error_file}"
  else
    echo "::error::Cannot inspect ${image}; refusing to treat a registry error as absence." >&2
    cat "${error_file}" >&2
    rm -f "${error_file}"
    return 1
  fi
}

assert_image_identity() {
  local image="$1" digest="$2" revision="$3" image_config
  [[ "${digest}" =~ ^sha256:[0-9a-f]{64}$ && "${revision}" =~ ^[0-9a-f]{40}$ ]] \
    || { echo "::error::Invalid image identity." >&2; return 1; }
  : "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"
  image_config=$(docker buildx imagetools inspect --format '{{json .Image}}' "${image%:*}@${digest}") || return 1
  jq -e --arg revision "${revision}" --arg version "${image##*:}" \
    --arg source "${GITHUB_SERVER_URL:-https://github.com}/${GITHUB_REPOSITORY}" '
      [if has("config") then . else .[] end]
      | length > 0 and all(.[];
          .config.Labels["org.opencontainers.image.revision"] == $revision
          and .config.Labels["org.opencontainers.image.version"] == $version
          and .config.Labels["org.opencontainers.image.source"] == $source)
    ' <<<"${image_config}" >/dev/null \
    || { echo "::error::Image metadata does not match the selected source and version." >&2; return 1; }
}