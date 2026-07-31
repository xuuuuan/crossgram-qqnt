#!/usr/bin/env bash
set -euo pipefail

root=$(cd "$(dirname "$0")/../../.." && pwd)
manifest="$root/native/ppapi-host/Cargo.toml"
test_root=/tmp/crossgram-ppapi-host
socket_dir=/tmp/crossgram-ppapi-observer
cleanup() { rm -rf "$test_root" "$socket_dir"; }
trap cleanup EXIT
cleanup
mkdir -p "$test_root/avsdk"

cargo build --manifest-path "$manifest" --features synthetic-profile
cat >"$test_root/fake.c" <<'C'
int fake_value(void) { return 7; }
C
cat >"$test_root/host.c" <<'C'
#include <dlfcn.h>
#include <stdlib.h>
extern void *dlopen(const char *, int);
__asm__(".symver dlopen,dlopen@GLIBC_2.2.5");
int main(void) {
  void *first = dlopen("/tmp/crossgram-ppapi-host/avsdk/libAVSDKPlugin.so", RTLD_NOW | RTLD_LOCAL);
  void *second = dlopen("/tmp/crossgram-ppapi-host/avsdk/libAVSDKPlugin.so", RTLD_NOW | RTLD_LOCAL);
  if (first == NULL || second == NULL || first != second) return 1;
  if (dlsym(first, "fake_value") == NULL) return 2;
  dlclose(second);
  dlclose(first);
  return 0;
}
C
cc -shared -fPIC -Wl,-z,now,-z,relro -o "$test_root/avsdk/libAVSDKPlugin.so" "$test_root/fake.c"
cc -Wl,-z,now,-z,relro -o "$test_root/QQ" "$test_root/host.c" -ldl
library="$root/native/ppapi-host/target/debug/libqqnt_ppapi_host.so"

# Exact non-PPAPI role emits no record even if a private receiver is present.
python3 - "$socket_dir" "$test_root/QQ" "$library" <<'PY'
import os, socket, subprocess, sys
root, host, preload = sys.argv[1:]
os.mkdir(root, 0o700)
sock = socket.socket(socket.AF_UNIX, socket.SOCK_SEQPACKET)
sock.bind(root + '/records.sock')
os.chmod(root + '/records.sock', 0o600)
sock.listen(1)
sock.settimeout(.25)
subprocess.run([host], env={'PATH': os.environ['PATH'], 'LD_PRELOAD': preload}, check=True)
try:
    sock.accept()
    raise SystemExit('non-PPAPI process emitted a record')
except TimeoutError:
    pass
sock.close()
os.unlink(root + '/records.sock')
os.rmdir(root)
PY

# Qualifying exact PPAPI role with no collector must remain transparent.
env -i PATH="$PATH" LD_PRELOAD="$library" "$test_root/QQ" --type=ppapi

# The real collector receives a fixed identity-mismatch record from the exact
# synthetic profile. This proves the qualifying path, not the inert path.
"$root/native/ppapi-host/target/debug/ppapi-host-collector" >"$test_root/record.json" &
collector=$!
for _ in $(seq 1 100); do [ -S "$socket_dir/records.sock" ] && break; sleep 0.01; done
[ -S "$socket_dir/records.sock" ]
[ "$(stat -c '%a' "$socket_dir")" = 700 ]
[ "$(stat -c '%a' "$socket_dir/records.sock")" = 600 ]
env -i PATH="$PATH" LD_PRELOAD="$library" "$test_root/QQ" --type=ppapi
wait "$collector"
grep -Fx '{"role_ppapi":true,"preload_active":true,"forward_resolved":true,"observed":true,"unique":false,"build_match":false,"namespace_class":1,"flags_class":1,"caller_class":1,"observation_count":1,"error_category":1}' "$test_root/record.json"
[ ! -e "$socket_dir/records.sock" ]

# The collector rejects malformed records and unlinks its socket on this error.
"$root/native/ppapi-host/target/debug/ppapi-host-collector" >/dev/null 2>&1 &
collector=$!
for _ in $(seq 1 100); do [ -S "$socket_dir/records.sock" ] && break; sleep 0.01; done
python3 -c 'import socket; s=socket.socket(socket.AF_UNIX, socket.SOCK_SEQPACKET); s.connect("/tmp/crossgram-ppapi-observer/records.sock"); s.send(b"x" * 17); s.close()'
if wait "$collector"; then exit 1; fi
[ ! -e "$socket_dir/records.sock" ]
