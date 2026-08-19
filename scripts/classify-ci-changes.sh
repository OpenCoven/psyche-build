#!/usr/bin/env bash
set -euo pipefail

: "${GITHUB_OUTPUT:?GITHUB_OUTPUT is required}"
: "${GITHUB_EVENT_NAME:=pull_request}"
: "${BASE_SHA:=}"
: "${HEAD_SHA:=}"

desktop=true
ios=true
package=true

if [[ "$GITHUB_EVENT_NAME" == "pull_request" && -n "$BASE_SHA" && -n "$HEAD_SHA" ]]; then
  if git rev-parse --verify "$BASE_SHA^{commit}" >/dev/null 2>&1 && git rev-parse --verify "$HEAD_SHA^{commit}" >/dev/null 2>&1; then
    if git diff --name-only --no-renames "$BASE_SHA...$HEAD_SHA" -- >/dev/null; then
      desktop=false
      ios=false
      package=false

      while IFS= read -r -d '' path; do
        [[ -n "$path" ]] || continue
        case "$path" in
          .github/workflows/*|.github/actions/*|package.json|pnpm-lock.yaml|pnpm-workspace.yaml|rust-toolchain.toml|scripts/classify-ci-changes.sh)
            desktop=true
            ios=true
            package=true
            ;;
          native/desktop/*|frontend/*|packages/*|Cargo.toml|Cargo.lock|vitest.config.ts|vitest.smoke.config.ts|__tests__/tauri*|scripts/build-macos-app.mjs)
            desktop=true
            ;;
          native/ios/*|scripts/generate-protocol-fixtures.ts|scripts/app-store-connect.mjs)
            ios=true
            ;;
          src/control/*|src/daemon/*|src/mcp/*|src/orchestration/*|src/services/bridge/*|src/workspace/*|src/actions/types.ts|src/utils/fileBrowser.ts|protocol-fixtures/*)
            desktop=true
            ios=true
            ;;
          *)
            ;;
        esac

        case "$path" in
          .github/workflows/*|.github/actions/*|package.json|pnpm-lock.yaml|pnpm-workspace.yaml|tsconfig*.json|psyche|scripts/*|src/*|packages/*|README.md|CHANGELOG.md|CONTRIBUTING.md|LICENSE|docs/README.md|docs/AGENT-SURFACE-CONTROL.md|docs/BREAKING-CHANGES.md|docs/BRIDGE-SECURITY.md|docs/INTEGRATIONS.md|docs/PRODUCT-SPEC.md|docs/RELEASE.md|docs/SMOKE.md)
            package=true
            ;;
          *)
            ;;
        esac
      done < <(git diff --name-only -z --no-renames "$BASE_SHA...$HEAD_SHA" --)
    fi
  fi
fi

{
  printf 'desktop=%s\n' "$desktop"
  printf 'ios=%s\n' "$ios"
  printf 'package=%s\n' "$package"
} >> "$GITHUB_OUTPUT"
