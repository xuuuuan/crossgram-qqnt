#!/usr/bin/env bash
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
manifest="$root/native/ppapi-host/Cargo.toml"

cargo fmt --manifest-path "$manifest" --check
cargo test --manifest-path "$manifest"
cargo clippy --manifest-path "$manifest" --all-targets -- -D warnings
cargo build --release --manifest-path "$manifest"
"$root/native/ppapi-host/tests/synthetic-preload.sh"
# Restore the production profile after the synthetic test profile build.
cargo build --release --manifest-path "$manifest"

library="$root/native/ppapi-host/target/release/libqqnt_ppapi_host.so"
collector="$root/native/ppapi-host/target/release/ppapi-host-collector"
patchelf_bin=${PATCHELF:-$(command -v patchelf || true)}
if [ -z "$patchelf_bin" ]; then
  patchelf_bin=$(find /nix/store -path '*/bin/patchelf' -type f -print -quit 2>/dev/null || true)
fi
[ -n "$patchelf_bin" ] || { printf '%s\n' 'patchelf is required to remove build RPATHs' >&2; exit 1; }
"$patchelf_bin" --remove-rpath "$library"
"$patchelf_bin" --remove-rpath "$collector"
readelf --dyn-syms --wide "$library" | grep -Eq '[[:space:]]dlopen@@GLIBC_2\.2\.5$'
! readelf --dyn-syms --wide "$library" | grep -Eq '[[:space:]](ppapi_dlopen_dispatch|ppapi_dlopen_impl)$'
readelf -dW "$library" | grep -Eq 'BIND_NOW'
! readelf -dW "$library" | grep -Eq '(RPATH|RUNPATH)'
readelf -lW "$library" | grep -Eq 'GNU_RELRO'
env -i PATH=/usr/bin:/bin LD_LIBRARY_PATH= LD_DEBUG=libs ldd "$library" >/dev/null 2>"$root/native/ppapi-host/target/ld-debug.log"
! grep -Eq 'RUNPATH|RPATH|native/ppapi-host/target' "$root/native/ppapi-host/target/ld-debug.log"
! strings "$library" | grep -Eiq '(argv|pid|uid|thread id|call data|pointer|handle)'
