#!/bin/sh
set -eu

if [ -z "${QQNT_BINARY:-}" ] || [ ! -x "$QQNT_BINARY" ]; then
  echo "QQNT_BINARY is not an executable file: ${QQNT_BINARY:-<unset>}" >&2
  exit 1
fi

for command_name in Xvfb dbus-run-session; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "required command is missing: $command_name" >&2
    exit 1
  fi
done

display=${QQNT_DISPLAY:-:99}
Xvfb "$display" -screen 0 1280x720x24 -nolisten tcp &
xvfb_pid=$!
cleanup() {
  kill "$xvfb_pid" >/dev/null 2>&1 || true
  wait "$xvfb_pid" 2>/dev/null || true
}
trap cleanup EXIT HUP INT TERM
export DISPLAY=$display
sleep 1

set +e
dbus-run-session -- "$QQNT_BINARY" --no-sandbox --disable-gpu --disable-dev-shm-usage
status=$?
set -e
exit "$status"
