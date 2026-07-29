# Headless QQNT deployment

The default deployment is intentionally not a container. QQ already bundles a
large Electron runtime; adding a container does not reduce that cost. The
service runs QQ as an unprivileged user under `dbus-run-session` and Xvfb. Xvfb
is the only always-on GUI helper and normally uses only a few MiB.

## One-line install (Debian/Ubuntu x86_64)

```sh
curl -fsSL https://raw.githubusercontent.com/xuuuuan/crossgram-qqnt/master/deploy/install.sh | sudo sh
```

The installer downloads Tencent's current official `.deb`, the latest bridge
release, creates a dedicated `qqnt-bridge` user, and enables the systemd unit.
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
