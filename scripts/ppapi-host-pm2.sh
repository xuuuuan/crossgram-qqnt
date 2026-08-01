#!/usr/bin/env bash
set -euo pipefail
script_dir=$(cd "$(dirname "$0")" && pwd -P)
exec /usr/bin/env node "$script_dir/ppapi-host-pm2.mjs" "$@"
