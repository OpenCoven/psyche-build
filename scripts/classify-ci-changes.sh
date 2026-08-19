#!/usr/bin/env bash
set -euo pipefail

: "${GITHUB_OUTPUT:?GITHUB_OUTPUT is required}"
: "${GITHUB_EVENT_NAME:=pull_request}"
: "${BASE_SHA:=}"
: "${HEAD_SHA:=}"

desktop=true
ios=true

if [[ "$GITHUB_EVENT_NAME" == "pull_request" && -n "$BASE_SHA" && -n "$HEAD_SHA" ]]; then
  if git rev-parse --verify "$BASE_SHA^{commit}" >/dev/null 2>&1 && git rev-parse --verify "$HEAD_SHA^{commit}" >/dev/null 2>&1; then
    desktop=false
    ios=false
    while IFS= read -r path; do
      [[ -z "$path" ]] && continue
      case "$path" in
        .github/workflows/*|.github/actions/*|package.json|pnpm-lock.yaml|pnpm-workspace.yaml|rust-toolchain.toml)
          desktop=true
          ios=true
          ;;
        native/desktop/*|frontend/*|packages/*|Cargo.toml|Cargo.lock|__tests__/tauri*|scripts/build-macos-app.mjs)
          desktop=true
          ;;
        native/ios/*|scripts/generate-protocol-fixtures.ts|scripts/app-store-connect.mjs)
          ios=true
          ;;
        src/control/*|src/daemon/*|src/mcp/*|src/orchestration/*|protocol-fixtures/*)
          desktop=true
          ios=true
          ;;
        *)
          ;;
      esac
    done < <(git diff --name-only "$BASE_SHA...$HEAD_SHA")
  fi
fi

printf 'desktop=%s\n' "$desktop" >> "$GITHUB_OUTPUT"
printf 'ios=%s\n' "$ios" >> "$GITHUB_OUTPUT"
