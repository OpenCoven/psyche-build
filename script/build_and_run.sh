#!/usr/bin/env bash
set -euo pipefail

MODE="${1:-run}"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TAURI_DIR="$ROOT_DIR/native/desktop/psyche-build-tauri"
# Process name (CFBundleExecutable), used by pkill/pgrep. This is the cargo
# binary name, which the product rename did not change.
APP_NAME="psyche-build-tauri"
# The .app is named after `productName` in tauri.conf.json ("Psyche Build"),
# not after the binary. This used to be hardcoded — as `psyche.app` — and the
# comux -> psyche rename left it pointing at a bundle that is never produced,
# so every `run`/`--verify` built successfully and then died on `open`.
# Resolve it from disk instead, so the next rename cannot break this again.
APP_BUNDLE_DIR="$TAURI_DIR/src-tauri/target/debug/bundle/macos"
TAURI_CLI_VERSION="2.11.1"
LOCAL_TAURI_CLI="$ROOT_DIR/.codex/tools/tauri-cli/bin/cargo-tauri"

usage() {
  echo "usage: $0 [run|--debug|--logs|--telemetry|--verify]" >&2
}

stop_app() {
  pkill -x "$APP_NAME" >/dev/null 2>&1 || true
  local port_pid
  port_pid="$(lsof -tiTCP:1420 -sTCP:LISTEN -n -P 2>/dev/null || true)"
  if [[ -n "$port_pid" ]]; then
    kill $port_pid >/dev/null 2>&1 || true
  fi
}

is_tauri_v2() {
  local cli="$1"
  [[ -x "$cli" ]] && "$cli" --version 2>/dev/null | grep -q '^tauri-cli 2\.'
}

resolve_tauri_cli() {
  if is_tauri_v2 "$LOCAL_TAURI_CLI"; then
    echo "$LOCAL_TAURI_CLI"
    return
  fi
  if command -v cargo-tauri >/dev/null 2>&1 && is_tauri_v2 "$(command -v cargo-tauri)"; then
    command -v cargo-tauri
    return
  fi

  echo "Installing tauri-cli $TAURI_CLI_VERSION locally under .codex/tools..." >&2
  cargo install tauri-cli \
    --version "$TAURI_CLI_VERSION" \
    --locked \
    --root "$ROOT_DIR/.codex/tools/tauri-cli" >&2
  echo "$LOCAL_TAURI_CLI"
}

# Resolvers are assigned to a variable on their own line, never inlined as
# `cmd "$(resolve_x)"`. Under `set -e` a command substitution that fails as an
# *argument* does not abort the script — the exit status belongs to the outer
# command — so the failure is swallowed and the caller runs with an empty
# string. Splitting the declaration from the assignment matters too:
# `local cli="$(resolve)"` takes `local`'s exit status and masks the failure,
# while `local cli; cli="$(resolve)"` propagates it.
build_app_bundle() {
  local cli
  cli="$(resolve_tauri_cli)"
  (
    cd "$TAURI_DIR"
    "$cli" build --debug --bundles app --no-sign
  )
}

resolve_app_bundle() {
  local matches=("$APP_BUNDLE_DIR"/*.app)
  if [[ ${#matches[@]} -ne 1 || ! -d "${matches[0]}" ]]; then
    echo "expected exactly one .app bundle in $APP_BUNDLE_DIR, found: ${matches[*]}" >&2
    return 1
  fi
  printf '%s\n' "${matches[0]}"
}

open_app_bundle() {
  local bundle
  bundle="$(resolve_app_bundle)"
  /usr/bin/open -n "$bundle"
}

run_dev() {
  local cli
  cli="$(resolve_tauri_cli)"
  (
    cd "$TAURI_DIR"
    "$cli" dev --no-watch
  )
}

case "$MODE" in
  run)
    stop_app
    build_app_bundle
    open_app_bundle
    ;;
  --debug|debug)
    stop_app
    RUST_BACKTRACE=1 run_dev
    ;;
  --logs|logs)
    stop_app
    build_app_bundle
    open_app_bundle
    /usr/bin/log stream --info --style compact --predicate "process == \"$APP_NAME\""
    ;;
  --telemetry|telemetry)
    stop_app
    build_app_bundle
    open_app_bundle
    /usr/bin/log stream --info --style compact --predicate "process == \"$APP_NAME\""
    ;;
  --verify|verify)
    stop_app
    build_app_bundle
    open_app_bundle
    sleep 2
    pgrep -x "$APP_NAME" >/dev/null
    verified_bundle="$(resolve_app_bundle)"
    echo "verified $verified_bundle is running as $APP_NAME"
    ;;
  *)
    usage
    exit 2
    ;;
esac
