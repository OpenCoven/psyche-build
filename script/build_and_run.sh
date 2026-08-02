#!/usr/bin/env bash
set -euo pipefail

MODE="${1:-run}"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TAURI_DIR="$ROOT_DIR/native/macos/psyche-build-tauri"
APP_NAME="psyche-build-tauri"
APP_BUNDLE="$TAURI_DIR/src-tauri/target/debug/bundle/macos/psyche.app"
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

build_app_bundle() {
  local cli="$1"
  (
    cd "$TAURI_DIR"
    "$cli" build --debug --bundles app --no-sign
  )
}

open_app_bundle() {
  /usr/bin/open -n "$APP_BUNDLE"
}

run_dev() {
  local cli="$1"
  (
    cd "$TAURI_DIR"
    "$cli" dev --no-watch
  )
}

case "$MODE" in
  run)
    stop_app
    build_app_bundle "$(resolve_tauri_cli)"
    open_app_bundle
    ;;
  --debug|debug)
    stop_app
    RUST_BACKTRACE=1 run_dev "$(resolve_tauri_cli)"
    ;;
  --logs|logs)
    stop_app
    build_app_bundle "$(resolve_tauri_cli)"
    open_app_bundle
    /usr/bin/log stream --info --style compact --predicate "process == \"$APP_NAME\""
    ;;
  --telemetry|telemetry)
    stop_app
    build_app_bundle "$(resolve_tauri_cli)"
    open_app_bundle
    /usr/bin/log stream --info --style compact --predicate "process == \"$APP_NAME\""
    ;;
  --verify|verify)
    stop_app
    build_app_bundle "$(resolve_tauri_cli)"
    open_app_bundle
    sleep 2
    pgrep -x "$APP_NAME" >/dev/null
    echo "verified $APP_BUNDLE is running as $APP_NAME"
    ;;
  *)
    usage
    exit 2
    ;;
esac
