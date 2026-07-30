#!/bin/sh
set -eu

umask 077
state_dir=${QQNT_BRIDGE_STATE_DIR:-/var/lib/qqnt-bridge}
config_root=${QQNT_BRIDGE_CONFIG_ROOT:-$state_dir/.config/qqnt-bridge-injection}
backup_root=${QQNT_BRIDGE_SESSION_BACKUP_DIR:-$state_dir/backups/session}
lkg_archive=$backup_root/last-known-good.tar.gz

case "$config_root" in
  "$state_dir"/.config/qqnt-bridge-injection) ;;
  *) echo "refusing unexpected QQNT config root: $config_root" >&2; exit 1 ;;
esac

copy_tree_if_present() {
  relative=$1
  if [ -e "$config_root/$relative" ]; then
    mkdir -p "$snapshot_dir/$(dirname -- "$relative")"
    cp -a "$config_root/$relative" "$snapshot_dir/$relative"
  fi
}

save_snapshot() {
  archive=$1
  mkdir -p "$backup_root" "$(dirname -- "$archive")"
  chmod 0700 "$backup_root"
  snapshot_dir=$(mktemp -d "$backup_root/.snapshot.XXXXXX")
  trap 'rm -rf -- "$snapshot_dir"' EXIT HUP INT TERM

  copy_tree_if_present auth
  copy_tree_if_present global/nt_data/Login
  copy_tree_if_present global/nt_data/mmkv
  copy_tree_if_present global/nt_data/msf
  mkdir -p "$snapshot_dir/global/nt_data/nt_db"
  found_login_db=0
  for name in login.db login.db-wal login.db-shm login.db-journal; do
    if [ -f "$config_root/global/nt_data/nt_db/$name" ]; then
      cp -a "$config_root/global/nt_data/nt_db/$name" "$snapshot_dir/global/nt_data/nt_db/$name"
      found_login_db=1
    fi
  done
  if [ "$found_login_db" -eq 0 ]; then
    rmdir "$snapshot_dir/global/nt_data/nt_db" 2>/dev/null || true
    rmdir "$snapshot_dir/global/nt_data" 2>/dev/null || true
    rmdir "$snapshot_dir/global" 2>/dev/null || true
  fi
  if ! find "$snapshot_dir" -mindepth 1 -print -quit | grep -q .; then
    echo "no QQNT login state is available to snapshot" >&2
    exit 1
  fi

  temporary=$archive.tmp.$$
  rm -f -- "$temporary"
  tar -czf "$temporary" -C "$snapshot_dir" .
  chmod 0600 "$temporary"
  mv -f -- "$temporary" "$archive"
  rm -rf -- "$snapshot_dir"
  trap - EXIT HUP INT TERM
}

restore_snapshot() {
  archive=$1
  if [ ! -f "$archive" ]; then
    echo "QQNT login snapshot is missing: $archive" >&2
    exit 1
  fi
  mkdir -p "$config_root/global/nt_data/nt_db"
  rm -rf -- \
    "$config_root/auth" \
    "$config_root/global/nt_data/Login" \
    "$config_root/global/nt_data/mmkv" \
    "$config_root/global/nt_data/msf"
  rm -f -- \
    "$config_root/global/nt_data/nt_db/login.db" \
    "$config_root/global/nt_data/nt_db/login.db-wal" \
    "$config_root/global/nt_data/nt_db/login.db-shm" \
    "$config_root/global/nt_data/nt_db/login.db-journal"
  tar -xzf "$archive" -C "$config_root"
  if [ "$(id -u)" -eq 0 ] && id qqnt-bridge >/dev/null 2>&1; then
    chown -R qqnt-bridge:qqnt-bridge "$config_root"
  fi
}

case "${1:-}" in
  save)
    test -n "${2:-}" || { echo "usage: session-state.sh save ARCHIVE" >&2; exit 2; }
    save_snapshot "$2"
    ;;
  save-lkg)
    save_snapshot "$lkg_archive"
    ;;
  restore)
    test -n "${2:-}" || { echo "usage: session-state.sh restore ARCHIVE" >&2; exit 2; }
    restore_snapshot "$2"
    ;;
  restore-lkg)
    restore_snapshot "$lkg_archive"
    ;;
  has-lkg)
    test -f "$lkg_archive"
    ;;
  lkg-path)
    printf '%s\n' "$lkg_archive"
    ;;
  *)
    echo "usage: session-state.sh {save ARCHIVE|save-lkg|restore ARCHIVE|restore-lkg|has-lkg|lkg-path}" >&2
    exit 2
    ;;
esac
