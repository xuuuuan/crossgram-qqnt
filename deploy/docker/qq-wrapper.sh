#!/bin/sh
set -eu

# 在 run-headless.sh 已有的参数后追加 QQNT_BRIDGE_QQ_FLAGS。
exec "${QQNT_QQ_BINARY:-/opt/QQ/qq}" "$@" ${QQNT_BRIDGE_QQ_FLAGS:-}
