#!/usr/bin/env bash
set -euo pipefail
fixture=$(cd "$(dirname "$0")" && pwd -P)
repo=$(cd "$fixture/../.." && pwd -P)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
mkdir "$work/consumer"
cp "$fixture/adapter-lifecycle.pyz" "$work/adapter-lifecycle.pyz"
python=$(command -v python3)
node=$(command -v node)
pin=$("$python" -I - "$fixture/pin.json" "$work/adapter-lifecycle.pyz" <<'PY'
import hashlib, json, sys
from pathlib import Path
pin = json.loads(Path(sys.argv[1]).read_bytes())['sha256']
if hashlib.sha256(Path(sys.argv[2]).read_bytes()).hexdigest() != pin:
    raise SystemExit('pinned artifact digest mismatch')
print(pin)
PY
)
case "$(uname -s)" in
  Darwin) offline=(sandbox-exec -D "FIXTURE=$(cd "$work" && pwd -P)" -p '(version 1)(allow default)(deny network*)(allow network* (local unix-socket (subpath (param "FIXTURE"))))') ;;
  Linux) offline=(sudo -n unshare --net -- setpriv --reuid="$(id -u)" --regid="$(id -g)" --clear-groups) ;;
  *) echo "Requires a macOS or Linux offline sandbox" >&2; exit 1 ;;
esac
cd "$work/consumer"
clean=(/usr/bin/env -i HOME="$work" TMPDIR="$work" PATH=/usr/bin:/bin)
"${offline[@]}" "${clean[@]}" "$python" -I - <<'PY'
import errno, socket
try:
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
        sock.connect(('192.0.2.1', 9))
except OSError as exc:
    if exc.errno not in (errno.EPERM, errno.EACCES, errno.ENETUNREACH, errno.EHOSTUNREACH):
        raise
else:
    raise SystemExit('network isolation missing')
PY
"${offline[@]}" "${clean[@]}" "$python" -I "$work/adapter-lifecycle.pyz" --sha256 "$pin" -- "$node" --import "$repo/node_modules/tsx/dist/loader.mjs" "$fixture/adapter.mts"
