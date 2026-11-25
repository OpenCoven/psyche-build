#!/usr/bin/env bash
set -euo pipefail
umask 077
fixture=$(cd "$(dirname "$0")" && pwd -P)
work=$(mktemp -d /tmp/build-binding.XXXXXXXX)
trap 'rm -rf "$work"' EXIT
work=$(cd "$work" && pwd -P)
case "$(uname -s)/$(uname -m)" in
  Darwin/arm64)
    target=aarch64-apple-darwin
    offline=(sandbox-exec -D "WORK=$work" -p '(version 1)(allow default)(deny network*)(allow network* (local unix-socket (subpath (param "WORK"))))')
    ;;
  Linux/x86_64)
    target=x86_64-unknown-linux-gnu
    offline=(sudo -n unshare --net -- setpriv --reuid="$(id -u)" --regid="$(id -g)" --clear-groups)
    ;;
  *) echo "Requires an arm64 macOS or x86_64 Linux offline sandbox" >&2; exit 1 ;;
esac
node=$(command -v node)
python=$(command -v python3)
mkdir -p "$work/consumer"
cd "$work/consumer"
"${offline[@]}" /usr/bin/env -i HOME="$work" TMPDIR="$work" PATH=/usr/bin:/bin "$python" -I - "$fixture" "$work" "$target" "$node" <<'PY'
import errno
import hashlib
import io
import json
import os
from pathlib import Path
import socket
import sys
import tarfile

fixture, work, target, node = sys.argv[1:]
fixture = Path(fixture)
def probe(family, address):
    try:
        with socket.socket(family, socket.SOCK_DGRAM) as sock:
            sock.connect((address, 9))
    except OSError as exc:
        if exc.errno in (errno.EAFNOSUPPORT, errno.EPROTONOSUPPORT):
            return "family_unavailable"
        if exc.errno in (errno.EPERM, errno.EACCES, errno.ENETUNREACH, errno.EHOSTUNREACH):
            return "blocked_or_unreachable"
        raise
    raise SystemExit("network isolation missing")


probes = {"ipv4_udp": probe(socket.AF_INET, "192.0.2.1"), "ipv6_udp": probe(socket.AF_INET6, "2001:db8::1")}
pin = json.loads((fixture / "pin.json").read_bytes())
archive = (fixture / ("verify-build-binding-" + target + ".tar.gz")).read_bytes()
actual = hashlib.sha256(archive).hexdigest()
if actual != pin["targets"][target]["sha256"]:
    raise SystemExit("pinned verifier archive digest mismatch")
kit = Path(work) / "kit"
with tarfile.open(fileobj=io.BytesIO(archive), mode="r:gz") as tar:
    for name in ("bin/verify-build-binding", "golden/request.json"):
        matches = [entry for entry in tar if entry.name == name]
        if len(matches) != 1 or not matches[0].isfile():
            raise SystemExit("expected one regular file at " + name)
        path = kit / name
        path.parent.mkdir(exist_ok=True, parents=True)
        path.write_bytes(tar.extractfile(matches[0]).read())
        path.chmod(0o500 if name.startswith("bin/") else 0o400)
print(json.dumps({"target": target, "producer": pin["source_commit"], "archive_sha256": actual, "ip_probes": probes}), flush=True)
os.execv(sys.executable, [sys.executable, "-I", str(fixture / "canary.py"), str(kit), node])
PY
