# PPAPI host passive metadata probe

This is an authorized, local-only interoperability diagnostic for one QQ Linux installation. It is a separate native `cdylib`; it is not N-API and it does not add anything to the public bridge API.

## What it does

`libqqnt_ppapi_host.so` exports only `dlopen@GLIBC_2.2.5`. Its constructor reads bounded process metadata and becomes permanently inert unless both conditions are exact:

- `/proc/self/exe` is `/opt/QQ/qq`.
- A NUL-delimited argument is exactly `--type=ppapi`.

For every other process it only forwards `dlopen` to glibc and produces no records. It never opens AVSDK itself, registers callbacks, patches code/GOT, uses `LD_AUDIT`, calls `dlclose`, substitutes a handle, or exposes a control/call method.

For the PPAPI role, the wrapper always calls glibc first and returns its exact result. It then considers only the fixed AVSDK pathname, after validating the fixed descriptor-backed root-owned/non-group-or-world-writable ELF against the pinned Build ID and SHA-256. The returned handle must resolve to the exact fixed link map, a unique base-namespace mapping, bounded loader flags, and an executable-origin caller. Any failure only disables observation; forwarding remains available.

The at-most-two fixed 16-byte `PPV1` records contain only the following JSON projection:

```json
{"role_ppapi":false,"preload_active":false,"forward_resolved":false,"observed":false,"unique":false,"build_match":false,"namespace_class":3,"flags_class":2,"caller_class":3,"observation_count":0,"error_category":0}
```

The collector is a one-way `AF_UNIX`/`SOCK_SEQPACKET` sink at `/tmp/crossgram-ppapi-observer/records.sock`. It creates and validates its `0700` directory, creates a `0600` socket, checks `SO_PEERCRED` for the same UID, accepts no protocol commands, prints one fixed-schema JSON object to stdout, and persists nothing. A missing collector is a nonblocking dropped send and cannot change QQ loader behavior.

The existing browser/N-API loader probe remains preserved elsewhere in the codebase, but it is **not PPAPI evidence** and must not be used to infer PPAPI host loading behavior.

## Build and synthetic verification

From the repository root:

```sh
chmod +x scripts/build-ppapi-host.sh native/ppapi-host/tests/synthetic-preload.sh
scripts/build-ppapi-host.sh
```

The script runs formatting, unit tests, Clippy, a synthetic fake-DSO `dlopen` forwarding test with and without `--type=ppapi`, and ELF export/hardening/privacy checks. It neither accesses an installed QQ/AVSDK nor uses network access. The native lockfile was also scanned with temporary Nix-provided `cargo-audit` during review.

## Passive deployment procedure

Do not run this procedure until independent security review of task #128 has approved it.

1. Build the artifact and retain its absolute path:

   ```sh
   repo=/root/crossgram/.worktrees/qqnt-voice-call
   "$repo/scripts/build-ppapi-host.sh"
   probe="$repo/native/ppapi-host/target/release/libqqnt_ppapi_host.so"
   collector="$repo/native/ppapi-host/target/release/ppapi-host-collector"
   ```

2. In a separate terminal, start the collector first. It waits passively and prints only one record after a qualifying observation:

   ```sh
   "$collector"
   ```

3. The only supported PM2 target is the existing application named exactly `qq`. Do **not** use `pm2 restart --update-env`: it does not replace the stored process definition safely. The operational script uses only the fixed `/root/.nix-profile/bin/pm2` entry, validates its root/current-UID-owned `0777` profile symlink, then resolves and requires a root/current-UID-owned, non-writable executable under `/nix/store/.../bin/pm2`. It accepts no PM2 path override. First snapshot the precise saved `qq` environment, executable, interpreter, CWD, and argv; the snapshot is mode `0600` beneath a mode-`0700` state directory:

   ```sh
   "$repo/scripts/ppapi-host-pm2.mjs" snapshot
   ```

4. After the collector is waiting, replace only that process definition by deleting and starting `qq` with the saved exact launcher grammar: `/usr/bin/env -i [NAME=VALUE ...] /usr/bin/setsid --wait /opt/QQ/qq [ordinary args ...]`. The PM2 environment remains byte-for-byte the saved environment and must not contain `LD_PRELOAD`; the script inserts exactly one validated `LD_PRELOAD=/absolute/real.so` assignment immediately after the one exact `-i` argv option. It rejects `--`, all other env options such as `-S`/`-u`, duplicate `-i`, duplicate or malformed assignment names, missing/ambiguous launcher boundaries, non-string argv values, other `setsid`/QQ paths, and any pre-existing preload in either PM2 environment or env-i argv. Verification parses the same exact grammar and requires the saved executable, argv insertion position/count, CWD, interpreter, and full PM2 environment to match exactly. The script never acts on another app name:

   ```sh
   "$repo/scripts/ppapi-host-pm2.mjs" install "$probe"
   ```

5. Allow that one replacement, then wait passively for the collector result. Do not invoke a call, send loader commands, or attach another probe.

6. Roll back by deleting and starting only `qq` from the saved exact original arguments and environment. The script asserts that `LD_PRELOAD` is absent from both stored PM2 environment and env-i assignment argv afterwards:

   ```sh
   "$repo/scripts/ppapi-host-pm2.mjs" rollback
   rm -rf /tmp/crossgram-ppapi-observer
   ```

No deployment or restart is performed by this repository or these instructions.
