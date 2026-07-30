#!/bin/sh
set -eu

resolve_qq_binary() {
  if [ -n "${QQNT_BINARY:-}" ]; then
    if [ ! -x "$QQNT_BINARY" ]; then
      echo "QQNT_BINARY is not executable: $QQNT_BINARY" >&2
      return 1
    fi
    canonical_path "$QQNT_BINARY"
    return
  fi

  search_root=${QQNT_SEARCH_ROOT:-}
  for relative_path in /opt/QQ/qq /usr/local/bin/qq /usr/bin/qq; do
    candidate=$search_root$relative_path
    if [ -x "$candidate" ]; then
      canonical_path "$candidate"
      return
    fi
  done
  if [ -z "$search_root" ] && command -v qq >/dev/null 2>&1; then
    canonical_path "$(command -v qq)"
    return
  fi
  return 1
}

canonical_path() {
  if command -v readlink >/dev/null 2>&1; then
    resolved=$(readlink -f "$1" 2>/dev/null || true)
    if [ -n "$resolved" ]; then
      printf '%s\n' "$resolved"
      return
    fi
  fi
  directory=$(CDPATH= cd -- "$(dirname -- "$1")" && pwd -P)
  printf '%s/%s\n' "$directory" "$(basename -- "$1")"
}

if [ "${QQNT_BRIDGE_RESOLVE_ONLY:-0}" = 1 ]; then
  resolve_qq_binary
  exit
fi

if [ "$(id -u)" -ne 0 ]; then
  echo "run this installer as root: curl -fsSL .../install.sh | sudo sh" >&2
  exit 1
fi

case "$(uname -m)" in
  x86_64|amd64) bridge_arch=x64 ;;
  *) echo "qqnt-bridge currently supports Linux x86_64 only" >&2; exit 1 ;;
esac

repo=${QQNT_BRIDGE_REPO:-xuuuuan/crossgram-qqnt}
mode=${QQNT_BRIDGE_MODE:-release}
archive_url=${QQNT_BRIDGE_ARCHIVE_URL:-https://github.com/$repo/releases/latest/download/qqnt-bridge-linux-$bridge_arch-$mode.tar.gz}
tmp=$(mktemp -d)
trap 'rm -rf -- "$tmp"' EXIT HUP INT TERM

install_runtime_dependencies() {
  if command -v apt-get >/dev/null 2>&1; then
    package_manager=apt
    export DEBIAN_FRONTEND=noninteractive
    apt-get update
    apt-get install -y --no-install-recommends ca-certificates curl dbus-x11 qrencode xvfb
  elif command -v dnf >/dev/null 2>&1; then
    package_manager=dnf
    dnf install -y ca-certificates curl dbus-daemon qrencode xorg-x11-server-Xvfb shadow-utils
  elif command -v yum >/dev/null 2>&1; then
    package_manager=yum
    yum install -y ca-certificates curl dbus-daemon qrencode xorg-x11-server-Xvfb shadow-utils
  elif command -v pacman >/dev/null 2>&1; then
    package_manager=pacman
    pacman -Sy --needed --noconfirm ca-certificates curl dbus qrencode xorg-server-xvfb shadow
  elif command -v zypper >/dev/null 2>&1; then
    package_manager=zypper
    zypper --non-interactive install ca-certificates curl dbus-1 qrencode xorg-x11-server-Xvfb shadow
  else
    package_manager=manual
    echo "No supported package manager was found; checking preinstalled dependencies..." >&2
  fi
}

install_runtime_dependencies
missing_commands=
for command_name in curl tar Xvfb dbus-run-session qrencode systemctl getent groupadd useradd; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    missing_commands="$missing_commands $command_name"
  fi
done
if [ -n "$missing_commands" ]; then
  echo "missing required commands:$missing_commands" >&2
  echo "install the matching Xvfb, D-Bus, qrencode, curl, tar, systemd and shadow-utils packages, then rerun" >&2
  exit 1
fi

if ! qq_binary=$(resolve_qq_binary); then
  if [ "$package_manager" != apt ]; then
    echo "QQNT was not found on this distribution." >&2
    echo "Install Linux QQ from https://im.qq.com/linuxqq/index.shtml and rerun this script." >&2
    echo "If QQ is installed in a custom location, set QQNT_BINARY=/absolute/path/to/qq." >&2
    echo "Example: curl -fsSL <installer-url> | sudo env QQNT_BINARY=/absolute/path/to/qq sh" >&2
    exit 1
  fi
  qq_url=${QQNT_PACKAGE_URL:-}
  if [ -z "$qq_url" ]; then
    config=$(curl -fsSL --retry 3 https://cdn-go.cn/qq-web/im.qq.com_new/latest/rainbow/linuxConfig.js)
    qq_url=$(printf '%s' "$config" | sed -n 's/.*"x64DownloadUrl":{"deb":"\([^"]*\)".*/\1/p')
  fi
  if [ -z "$qq_url" ]; then
    echo "failed to discover the official QQ Linux deb URL; set QQNT_PACKAGE_URL" >&2
    exit 1
  fi
  echo "Downloading official QQ Linux package..."
  curl -fL --retry 3 -o "$tmp/qq.deb" "$qq_url"
  apt-get install -y "$tmp/qq.deb"
  if ! qq_binary=$(resolve_qq_binary); then
    echo "QQ was installed but its executable could not be found; set QQNT_BINARY=/absolute/path/to/qq" >&2
    exit 1
  fi
fi

qq_resources=${QQNT_RESOURCES_DIR:-$(dirname -- "$qq_binary")/resources}
if [ ! -d "$qq_resources" ]; then
  echo "QQ resources directory was not found: $qq_resources" >&2
  echo "Set QQNT_RESOURCES_DIR=/absolute/path/to/QQ/resources and rerun." >&2
  exit 1
fi

echo "Downloading qqnt-bridge $mode package..."
curl -fL --retry 3 -o "$tmp/bridge.tar.gz" "$archive_url"
mkdir "$tmp/bridge"
tar -xzf "$tmp/bridge.tar.gz" -C "$tmp/bridge"
test -f "$tmp/bridge/resources/app.asar"
test -f "$tmp/bridge/systemd/qqnt-bridge.service"
test -f "$tmp/bridge/bin/qqntctl"
test -f "$tmp/bridge/bin/install.sh"
test -f "$tmp/bridge/bin/run-headless.sh"
test -f "$tmp/bridge/bin/session-state.sh"

state_dir=${QQNT_BRIDGE_STATE_DIR:-/var/lib/qqnt-bridge}
was_ready=0
if systemctl cat qqnt-bridge.service >/dev/null 2>&1; then
  if command -v qqntctl >/dev/null 2>&1; then
    previous_status=$(qqntctl status 2>/dev/null || true)
    case "$previous_status" in *'"ready":true'*) was_ready=1 ;; esac
  fi
  systemctl stop qqnt-bridge.service
fi

install -d -m 0750 /var/lib/qqnt-bridge /var/lib/qqnt-bridge/log /var/lib/qqnt-bridge/backups
pre_update_snapshot=
if [ "$was_ready" -eq 1 ]; then
  install -d -m 0700 "$state_dir/backups/session"
  stamp=$(date +%Y%m%d-%H%M%S)
  pre_update_snapshot=$state_dir/backups/session/pre-update.$stamp.tar.gz
  QQNT_BRIDGE_STATE_DIR=$state_dir sh "$tmp/bridge/bin/session-state.sh" save "$pre_update_snapshot"
fi
if [ -f "$qq_resources/app.asar" ]; then
  stamp=$(date +%Y%m%d-%H%M%S)
  cp -a "$qq_resources/app.asar" "/var/lib/qqnt-bridge/backups/app.asar.$stamp"
fi
install -m 0644 "$tmp/bridge/resources/app.asar" "$qq_resources/app.asar"
if [ -d "$tmp/bridge/resources/app.asar.unpacked" ]; then
  cp -a "$tmp/bridge/resources/app.asar.unpacked" "$qq_resources/"
fi

if ! getent group qqnt-bridge >/dev/null; then groupadd --system qqnt-bridge; fi
if ! id qqnt-bridge >/dev/null 2>&1; then
  nologin_shell=$(command -v nologin || printf '/sbin/nologin')
  useradd --system --gid qqnt-bridge --home-dir /var/lib/qqnt-bridge --shell "$nologin_shell" qqnt-bridge
fi
chown -R qqnt-bridge:qqnt-bridge /var/lib/qqnt-bridge

if [ ! -f /etc/qqnt-bridge.env ]; then
  token=$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')
  umask 077
  {
    echo "QQNT_BRIDGE_HOST=${QQNT_BRIDGE_HOST:-127.0.0.1}"
    echo "QQNT_BRIDGE_PORT=${QQNT_BRIDGE_PORT:-18767}"
    echo "QQNT_BRIDGE_TOKEN=${QQNT_BRIDGE_TOKEN:-$token}"
    echo "QQNT_BRIDGE_LOG=/var/lib/qqnt-bridge/log/qqnt-bridge.log"
    echo "QQNT_BRIDGE_SLOW_HTTP_LOG=/var/lib/qqnt-bridge/log/slow-http.log"
    echo "QQNT_BRIDGE_AUTO_LOGIN=1"
    echo "QQNT_BRIDGE_MANAGE_LOGIN=1"
    echo "QQNT_BRIDGE_HEADLESS=1"
    echo "QQNT_BRIDGE_CLOSE_MAIN_WINDOW=1"
  } > /etc/qqnt-bridge.env
fi
grep -q '^QQNT_BRIDGE_HEADLESS=' /etc/qqnt-bridge.env || echo 'QQNT_BRIDGE_HEADLESS=1' >> /etc/qqnt-bridge.env
grep -q '^QQNT_BRIDGE_CLOSE_MAIN_WINDOW=' /etc/qqnt-bridge.env || echo 'QQNT_BRIDGE_CLOSE_MAIN_WINDOW=1' >> /etc/qqnt-bridge.env
escaped_qq_binary=$(printf '%s' "$qq_binary" | sed 's/\\/\\\\/g; s/"/\\"/g')
grep -v '^QQNT_BINARY=' /etc/qqnt-bridge.env > "$tmp/qqnt-bridge.env"
printf 'QQNT_BINARY="%s"\n' "$escaped_qq_binary" >> "$tmp/qqnt-bridge.env"
install -m 0600 "$tmp/qqnt-bridge.env" /etc/qqnt-bridge.env
chmod 0600 /etc/qqnt-bridge.env

install -m 0755 "$tmp/bridge/bin/qqntctl" /usr/local/bin/qqntctl
install -d -m 0755 /usr/local/libexec/qqnt-bridge
for helper in "$tmp/bridge/bin/"*; do
  helper_name=${helper##*/}
  case "$helper_name" in
    qqntctl|install.sh) continue ;;
  esac
  [ -f "$helper" ] || continue
  install -m 0755 "$helper" "/usr/local/libexec/qqnt-bridge/$helper_name"
done
install -m 0755 "$tmp/bridge/bin/install.sh" /usr/local/libexec/qqnt-bridge/install.sh
install -m 0644 "$tmp/bridge/systemd/qqnt-bridge.service" /etc/systemd/system/qqnt-bridge.service
systemctl daemon-reload
systemctl enable qqnt-bridge.service
systemctl restart qqnt-bridge.service

wait_for_ready() {
  tries=0
  limit=${QQNT_BRIDGE_UPDATE_READY_TIMEOUT_SECONDS:-180}
  while [ "$tries" -lt "$limit" ]; do
    current_status=$(qqntctl status 2>/dev/null || true)
    case "$current_status" in *'"ready":true'*) return 0 ;; esac
    tries=$((tries + 1))
    sleep 1
  done
  return 1
}

if [ "$was_ready" -eq 1 ] && ! wait_for_ready; then
  echo "QQNT did not restore the previous account after update; rolling back its login state" >&2
  systemctl stop qqnt-bridge.service
  QQNT_BRIDGE_STATE_DIR=$state_dir /usr/local/libexec/qqnt-bridge/session-state.sh restore "$pre_update_snapshot"
  systemctl restart qqnt-bridge.service
  if ! wait_for_ready; then
    echo "QQNT login state was restored, but the account is still not ready; service was left running" >&2
    exit 1
  fi
fi

echo
echo "qqnt-bridge is installed and bound to localhost."
echo "Show the login QR in this terminal: sudo qqntctl qr"
echo "Save it as PNG: sudo qqntctl qr --png /tmp/qqnt-login.png"
echo "Switch QQ accounts and print a new QR: sudo qqntctl logout"
echo "Inspect status: sudo qqntctl status"
echo "Install the latest bridge release later: sudo qqntctl update"
echo "QQ executable: $qq_binary"

if [ "${QQNT_BRIDGE_SHOW_QR:-1}" != 0 ]; then
  tries=0
  while [ "$tries" -lt 60 ]; do
    status_json=$(qqntctl status 2>/dev/null || true)
    case "$status_json" in
      *'"ready":true'*) break ;;
      *'"login":{'*)
        echo
        echo "QQ is not logged in. Scan this QR code:"
        qqntctl qr || echo "Run 'sudo qqntctl qr' to retry." >&2
        break
        ;;
    esac
    tries=$((tries + 1))
    sleep 1
  done
fi
