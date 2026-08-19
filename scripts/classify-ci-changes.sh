#!/usr/bin/env bash
set -euo pipefail

: "${GITHUB_OUTPUT:?GITHUB_OUTPUT is required}"

event_name="${GITHUB_EVENT_NAME:-pull_request}"
base_sha="${BASE_SHA:-}"
head_sha="${HEAD_SHA:-}"

desktop=true
ios=true
typescript=true
classification_complete=false

valid_sha() {
  [[ "$1" =~ ^[0-9a-fA-F]{40}$ ]]
}

changed_paths=()
if valid_sha "$head_sha" && [[ "$base_sha" != "$(printf '0%.0s' {1..40})" ]] && valid_sha "$base_sha"; then
  if ! git rev-parse --verify "$base_sha^{commit}" >/dev/null 2>&1 ||
    ! git rev-parse --verify "$head_sha^{commit}" >/dev/null 2>&1; then
    git fetch --no-tags origin "$base_sha" "$head_sha" >/dev/null 2>&1 || true
  fi

  if git rev-parse --verify "$base_sha^{commit}" >/dev/null 2>&1 &&
    git rev-parse --verify "$head_sha^{commit}" >/dev/null 2>&1; then
    if [[ "$event_name" == "pull_request" ]]; then
      while IFS= read -r -d '' path; do
        changed_paths+=("$path")
      done < <(git diff --no-renames --name-only -z "$base_sha...$head_sha")
      classification_complete=true
    elif [[ "$event_name" == "push" ]]; then
      while IFS= read -r -d '' path; do
        changed_paths+=("$path")
      done < <(git diff --no-renames --name-only -z "$base_sha" "$head_sha")
      classification_complete=true
    fi
  fi
fi

if "$classification_complete"; then
  desktop=false
  ios=false
  typescript=false

  if [ "${#changed_paths[@]}" -gt 0 ]; then
    for path in "${changed_paths[@]}"; do
      [[ -n "$path" ]] || continue
      case "$path" in
        .github/*|package.json|pnpm-lock.yaml|pnpm-workspace.yaml|rust-toolchain.toml)
          desktop=true
          ios=true
          typescript=true
          ;;
        native/desktop/*|Cargo.toml|Cargo.lock|scripts/build-macos-app.mjs)
          desktop=true
          ;;
        __tests__/tauri*)
          desktop=true
          typescript=true
          ;;
        native/ios/*|protocol-fixtures/*|src/control/*|src/services/bridge/*|scripts/generate-protocol-fixtures.ts|scripts/app-store-connect.mjs)
          ios=true
          typescript=true
          ;;
        docs/*|src/*|scripts/*|__tests__/*)
          typescript=true
          ;;
        *)
          desktop=true
          ios=true
          typescript=true
          ;;
      esac
    done
  fi
fi

printf 'desktop=%s\n' "$desktop" >> "$GITHUB_OUTPUT"
printf 'ios=%s\n' "$ios" >> "$GITHUB_OUTPUT"
printf 'typescript=%s\n' "$typescript" >> "$GITHUB_OUTPUT"
