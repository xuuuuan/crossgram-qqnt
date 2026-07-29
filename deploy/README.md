# Headless QQNT deployment

The default deployment is intentionally not a container. QQ already bundles a
large Electron runtime; adding a container does not reduce that cost. The
service runs QQ as an unprivileged user under `dbus-run-session` and Xvfb. Xvfb
is the only always-on GUI helper and normally uses only a few MiB.

## One-line install (Linux x86_64 with systemd)

```sh
curl -fsSL https://raw.githubusercontent.com/xuuuuan/crossgram-qqnt/master/deploy/install.sh | sudo sh
```

On Debian/Ubuntu, the installer downloads Tencent's current official `.deb`.
On Fedora/RHEL, Arch and openSUSE, install Linux QQ from
<https://im.qq.com/linuxqq/index.shtml> first; the script installs the small
runtime dependencies, finds QQ, creates a dedicated `qqnt-bridge` user, and
enables the systemd unit.

The usual `/opt/QQ/qq`, `/usr/local/bin/qq` and `/usr/bin/qq` locations are
detected automatically. For a custom installation, specify the executable
and, only when it is not beside the executable, its resources directory:

```sh
curl -fsSL https://raw.githubusercontent.com/xuuuuan/crossgram-qqnt/master/deploy/install.sh \
  | sudo env QQNT_BINARY=/path/to/qq QQNT_RESOURCES_DIR=/path/to/resources sh
```

The QQ executable and resources must be readable by the dedicated
`qqnt-bridge` service user. AppImages are not injectable in place; install an
unpacked/native package or point the variables at an extracted QQ tree.
The API listens on `127.0.0.1:18767` with a random bearer token by default.

```sh
sudo qqntctl qr
sudo qqntctl qr --png /tmp/qqnt-login.png
sudo qqntctl status
sudo qqntctl logs
sudo qqntctl update
```

After a successful scan, the bridge calls QQNT's native
`setAutoLoginSwitch(true)` setting. QQ should then reuse its stored ticket on
subsequent service restarts. In headless mode it closes the largest visible QQ
window 15 seconds after the account session becomes ready, while keeping QQ's
background/kernel processes alive. This behavior is gated by
`QQNT_BRIDGE_HEADLESS=1`; ordinary Windows injection does not enable it.

The systemd unit restarts QQ every seven days (`RuntimeMaxSec=7d`) and also
restarts it if the whole service cgroup exceeds 800 MiB (`MemoryMax=800M`).

`sudo qqntctl update` downloads the latest release, preserves the existing
`/etc/qqnt-bridge.env`, login data and backups, then restarts the service.
Running the one-line installer again performs the same in-place upgrade. Use
`sudo qqntctl update debug` to switch to the latest debug package. Set
`QQNT_BRIDGE_ARCHIVE_URL` when running the installer to use a local/custom
build, or `QQNT_PACKAGE_URL` to pin an official QQ package.

## HTTP login endpoints

All endpoints use the same bearer token as the bridge API:

- `GET /v1/login/status`
- `GET /v1/login/qrcode.png`
- `GET /v1/login/qrcode/url`
- `POST /v1/login/qrcode/refresh`

Keep the API on localhost and use an SSH tunnel when remote access is needed.
