# Linux 无头部署说明

`qqnt-bridge` 以独立低权限用户 `qqnt-bridge` 在 `dbus-run-session` 与 `Xvfb` 下运行官方 Linux QQ，监听 `127.0.0.1:18767` 并自动生成随机 Bearer Token（保存在 `/etc/qqnt-bridge.env`）。

## 1. 一键安装

```sh
curl -fsSL https://raw.githubusercontent.com/xuuuuan/crossgram-qqnt/master/deploy/install.sh | sudo sh
```

- Debian/Ubuntu 会自动下载并安装官方 Linux QQ `.deb`。
- Fedora/RHEL、Arch、openSUSE 请先从 <https://im.qq.com/linuxqq/index.shtml> 安装 Linux QQ（不要使用无法原地注入的 AppImage），再执行安装脚本。
- 若 QQ 安装在非标准路径（默认自动检测 `/opt/QQ/qq`、`/usr/local/bin/qq`、`/usr/bin/qq`），可显式指定：
  ```sh
  curl -fsSL https://raw.githubusercontent.com/xuuuuan/crossgram-qqnt/master/deploy/install.sh \
    | sudo env QQNT_BINARY=/path/to/qq QQNT_RESOURCES_DIR=/path/to/resources sh
  ```

## 2. 日常管理（`qqntctl`）

```sh
sudo qqntctl qr                    # 终端打印登录二维码
sudo qqntctl qr --png /tmp/qqnt-login.png
sudo qqntctl status                # 查看服务与登录状态
sudo qqntctl logs                  # 查看实时日志
sudo qqntctl logout                # 登出并切换账号（移走登录票据与恢复快照，保留聊天数据库）
sudo qqntctl update                # 下载最新 Release 并原地升级（失败自动回滚登录快照）
sudo qqntctl update debug          # 切换到 Debug 构建包
```

## 3. 自动登录与会话恢复

- 扫码登录成功后，桥接端会自动调用 `setAutoLoginSwitch(true)` 开启自动登录。
- 账号稳定就绪 15 秒后，启动脚本会将 `auth`、全局登录库和 MMKV 配置备份为最近可用快照（Last-Known-Good），并自动关闭主窗口以节省内存（后台内核保持运行）。
- 若后续重启卡在二维码界面超过 2 分钟，启动脚本会自动恢复该快照并重试一次。
- systemd 服务默认限制内存上限为 `800M`（`MemoryMax=800M`），每 7 天自动周期性重启一次（`RuntimeMaxSec=7d`）。

## 4. 登录 HTTP 接口

与主 API 共用同一个 Bearer Token：
- `GET /v1/login/status`
- `GET /v1/login/qrcode.png`
- `GET /v1/login/qrcode/url`
- `POST /v1/login/qrcode/refresh`
