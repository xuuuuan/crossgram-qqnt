#!/bin/sh
set -eu

export QQNT_QQ_BINARY=${QQNT_BINARY:-/opt/QQ/qq}
if [ -n "${QQNT_BRIDGE_QQ_FLAGS:-}" ]; then
  export QQNT_BINARY=/usr/local/libexec/qqnt-bridge/qq-wrapper.sh
else
  export QQNT_BINARY=$QQNT_QQ_BINARY
fi
export QQNT_BRIDGE_HOST=${QQNT_BRIDGE_HOST:-0.0.0.0}
export QQNT_BRIDGE_PORT=${QQNT_BRIDGE_PORT:-18767}
export QQNT_BRIDGE_STATE_DIR=${QQNT_BRIDGE_STATE_DIR:-/var/lib/qqnt-bridge}
export QQNT_BRIDGE_ENV_FILE=${QQNT_BRIDGE_ENV_FILE:-$QQNT_BRIDGE_STATE_DIR/qqnt-bridge.env}
export QQNT_BRIDGE_LOG=${QQNT_BRIDGE_LOG:-$QQNT_BRIDGE_STATE_DIR/log/qqnt-bridge.log}
export QQNT_BRIDGE_SLOW_HTTP_LOG=${QQNT_BRIDGE_SLOW_HTTP_LOG:-$QQNT_BRIDGE_STATE_DIR/log/slow-http.log}
export HOME=$QQNT_BRIDGE_STATE_DIR
export DISPLAY=${QQNT_DISPLAY:-:99}
export QQNT_BRIDGE_RUNNER=${QQNT_BRIDGE_RUNNER:-/usr/local/libexec/qqnt-bridge/run-headless.sh}

if [ ! -x "$QQNT_BINARY" ]; then
  echo "QQ executable is missing: $QQNT_BINARY" >&2
  exit 2
fi

mkdir -p "$QQNT_BRIDGE_STATE_DIR" "$QQNT_BRIDGE_STATE_DIR/log" "$QQNT_BRIDGE_STATE_DIR/backups"
chmod 0700 "$QQNT_BRIDGE_STATE_DIR" "$QQNT_BRIDGE_STATE_DIR/log" "$QQNT_BRIDGE_STATE_DIR/backups" 2>/dev/null || true

umask 077
{
  echo "QQNT_BRIDGE_HOST=$QQNT_BRIDGE_HOST"
  echo "QQNT_BRIDGE_PORT=$QQNT_BRIDGE_PORT"
  echo "QQNT_BRIDGE_TOKEN=${QQNT_BRIDGE_TOKEN:-}"
  printf 'QQNT_BINARY="%s"\n' "$QQNT_BINARY"
  echo "QQNT_BRIDGE_STATE_DIR=$QQNT_BRIDGE_STATE_DIR"
  echo "QQNT_BRIDGE_HEADLESS=${QQNT_BRIDGE_HEADLESS:-1}"
} > "$QQNT_BRIDGE_ENV_FILE"
chmod 0600 "$QQNT_BRIDGE_ENV_FILE"

echo "Starting qqnt-bridge on $QQNT_BRIDGE_HOST:$QQNT_BRIDGE_PORT"
exec "$QQNT_BRIDGE_RUNNER"
