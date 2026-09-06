#!/usr/bin/env bash

registry_digest() {
  local image="$1"
  local manifest error_file digest
  error_file=$(mktemp)
  if manifest=$(docker buildx imagetools inspect --format '{{json .Manifest}}' "${image}" 2>"${error_file}"); then
    rm -f "${error_file}"
    if ! digest=$(jq -er '.digest | select(type == "string" and test("^sha256:[a-f0-9]{64}$"))' <<<"${manifest}"); then
      echo "::error::Invalid registry response for ${image}." >&2
      return 1
    fi
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