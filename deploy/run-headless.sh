#!/bin/sh
set -eu

if [ -z "${QQNT_BINARY:-}" ] || [ ! -x "$QQNT_BINARY" ]; then
  echo "QQNT_BINARY is not an executable file: ${QQNT_BINARY:-<unset>}" >&2
  exit 1
fi

for command_name in Xvfb dbus-run-session curl; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "required command is missing: $command_name" >&2
    exit 1
  fi
done

display=${QQNT_DISPLAY:-:99}
session_tool=${QQNT_BRIDGE_SESSION_TOOL:-/usr/local/libexec/qqnt-bridge/session-state.sh}
ready_timeout=${QQNT_BRIDGE_SESSION_READY_TIMEOUT_SECONDS:-120}
stabilize_seconds=${QQNT_BRIDGE_SESSION_STABILIZE_SECONDS:-15}
curl_command=${QQNT_BRIDGE_CURL:-curl}
base="http://${QQNT_BRIDGE_HOST:-127.0.0.1}:${QQNT_BRIDGE_PORT:-18767}"
auth="Authorization: Bearer ${QQNT_BRIDGE_TOKEN:-}"

Xvfb "$display" -screen 0 1280x720x24 -nolisten tcp &
xvfb_pid=$!
qq_pid=

stop_qq() {
  [ -n "$qq_pid" ] || return 0
  if kill -0 "$qq_pid" 2>/dev/null; then
    kill "$qq_pid" 2>/dev/null || true
    tries=0
    while kill -0 "$qq_pid" 2>/dev/null && [ "$tries" -lt 20 ]; do
      sleep 1
      tries=$((tries + 1))
    done
    if kill -0 "$qq_pid" 2>/dev/null; then kill -KILL "$qq_pid" 2>/dev/null || true; fi
  fi
  wait "$qq_pid" 2>/dev/null || true
  qq_pid=
}

cleanup() {
  trap - EXIT HUP INT TERM
  stop_qq
  kill "$xvfb_pid" >/dev/null 2>&1 || true
  wait "$xvfb_pid" 2>/dev/null || true
}
trap cleanup EXIT HUP INT TERM
export DISPLAY=$display
sleep 1

start_qq() {
  dbus-run-session -- "$QQNT_BINARY" --no-sandbox --disable-gpu --disable-dev-shm-usage &
  qq_pid=$!
}

bridge_ready() {
  "$curl_command" -fsS -H "$auth" "$base/v1/status" 2>/dev/null \
    | grep -q '"ready":true'
}

wait_for_ready() {
  tries=0
  while [ "$tries" -lt "$ready_timeout" ]; do
    if ! kill -0 "$qq_pid" 2>/dev/null; then return 1; fi
    if bridge_ready; then
      stable=0
      while [ "$stable" -lt "$stabilize_seconds" ]; do
        sleep 1
        if ! kill -0 "$qq_pid" 2>/dev/null || ! bridge_ready; then return 1; fi
        stable=$((stable + 1))
      done
      if [ -x "$session_tool" ]; then
        "$session_tool" save-lkg \
          || echo "warning: failed to save QQNT last-known-good login state" >&2
      fi
      return 0
    fi
    tries=$((tries + 1))
    sleep 1
  done
  return 1
}

wait_for_qq() {
  set +e
  wait "$qq_pid"
  status=$?
  set -e
  qq_pid=
  return "$status"
}

start_qq
if wait_for_ready; then
  if wait_for_qq; then exit 0; else status=$?; exit "$status"; fi
fi

if kill -0 "$qq_pid" 2>/dev/null \
  && [ "${QQNT_BRIDGE_SESSION_RECOVERY:-1}" != 0 ] \
  && [ -x "$session_tool" ] \
  && "$session_tool" has-lkg; then
  echo "QQNT did not restore its account; recovering the last-known-good login state" >&2
  stop_qq
  "$session_tool" restore-lkg
  start_qq
  if wait_for_ready; then
    if wait_for_qq; then exit 0; else status=$?; exit "$status"; fi
  fi
  echo "QQNT login recovery was attempted once but the account is still not ready" >&2
fi

if wait_for_qq; then exit 0; else status=$?; exit "$status"; fi
