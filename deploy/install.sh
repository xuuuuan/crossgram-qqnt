#!/bin/sh
set -eu

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

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends ca-certificates curl dbus-x11 qrencode xvfb

if [ ! -x /opt/QQ/qq ]; then
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
fi

echo "Downloading qqnt-bridge $mode package..."
curl -fL --retry 3 -o "$tmp/bridge.tar.gz" "$archive_url"
mkdir "$tmp/bridge"
tar -xzf "$tmp/bridge.tar.gz" -C "$tmp/bridge"
test -f "$tmp/bridge/resources/app.asar"
test -f "$tmp/bridge/systemd/qqnt-bridge.service"
test -f "$tmp/bridge/bin/qqntctl"

install -d -m 0750 /var/lib/qqnt-bridge /var/lib/qqnt-bridge/log /var/lib/qqnt-bridge/backups
if [ -f /opt/QQ/resources/app.asar ]; then
  stamp=$(date +%Y%m%d-%H%M%S)
  cp -a /opt/QQ/resources/app.asar "/var/lib/qqnt-bridge/backups/app.asar.$stamp"
fi
install -m 0644 "$tmp/bridge/resources/app.asar" /opt/QQ/resources/app.asar
if [ -d "$tmp/bridge/resources/app.asar.unpacked" ]; then
  cp -a "$tmp/bridge/resources/app.asar.unpacked" /opt/QQ/resources/
fi

if ! getent group qqnt-bridge >/dev/null; then groupadd --system qqnt-bridge; fi
if ! id qqnt-bridge >/dev/null 2>&1; then
  useradd --system --gid qqnt-bridge --home-dir /var/lib/qqnt-bridge --shell /usr/sbin/nologin qqnt-bridge
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
chmod 0600 /etc/qqnt-bridge.env

install -m 0755 "$tmp/bridge/bin/qqntctl" /usr/local/bin/qqntctl
install -m 0644 "$tmp/bridge/systemd/qqnt-bridge.service" /etc/systemd/system/qqnt-bridge.service
systemctl daemon-reload
systemctl enable --now qqnt-bridge.service

echo
echo "qqnt-bridge is installed and bound to localhost."
echo "Show the login QR in this terminal: sudo qqntctl qr"
echo "Save it as PNG: sudo qqntctl qr --png /tmp/qqnt-login.png"
echo "Inspect status: sudo qqntctl status"
