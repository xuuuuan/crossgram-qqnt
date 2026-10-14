# Linux 无头部署说明

`qqnt-bridge` 以独立低权限用户 `qqnt-bridge` 在 `dbus-run-session` 与 `Xvfb` 下运行官方 Linux QQ，监听 `127.0.0.1:18767` 并自动生成随机 Bearer Token（保存在 `/etc/qqnt-bridge.env`）。

## 1. 一键安装

```sh
curl -fsSL https://raw.githubusercontent.com/xuuuuan/crossgram-qqnt/main/deploy/install.sh | sudo sh
```

- Debian/Ubuntu 会自动下载并安装官方 Linux QQ `.deb`。
- Fedora/RHEL、Arch、openSUSE 请先从 <https://im.qq.com/linuxqq/index.shtml> 安装 Linux QQ（不要使用无法原地注入的 AppImage），再执行安装脚本。
- 若 QQ 安装在非标准路径（默认自动检测 `/opt/QQ/qq`、`/usr/local/bin/qq`、`/usr/bin/qq`），可显式指定：
  ```sh
  curl -fsSL https://raw.githubusercontent.com/xuuuuan/crossgram-qqnt/main/deploy/install.sh \
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

## 5. 容器镜像

本仓按 release tag 自动构建并发布 `ghcr.io/xuuuuan/crossgram-qqnt:<tag>` 与 `:latest`，仅 amd64（官方 Linux QQ 只提供 amd64 包）。构建直接使用该 tag 的 release 产物，因此不需要 Rust 工具链。

```sh
docker run -d --name qqnt-bridge -v qqnt-bridge:/var/lib/qqnt-bridge \
  -e QQNT_BRIDGE_TOKEN=... ghcr.io/xuuuuan/crossgram-qqnt:latest
docker exec qqnt-bridge qqntctl qr
```

- 容器以低权限用户 `qqnt` 运行，状态在 `/var/lib/qqnt-bridge`，API 监听容器内 `0.0.0.0:18767`。
- 自带健康检查 `qqntctl status`（启动后 3 分钟内为 `starting`）：`docker ps` 可见，`docker compose up --wait` 会等它；Kubernetes 忽略 Docker 健康检查，需自行配置同样的 exec 探针。
- GHCR 新包默认私有：设为 public 才能匿名拉取，否则先 `docker login ghcr.io`。
- 查看镜像内容：`docker exec qqnt-bridge cat /opt/qqnt-bridge/VERSION /opt/qqnt-bridge/SOURCE_URL`、`docker exec qqnt-bridge dpkg-query -W linuxqq`。

| 构建参数 | 默认值 | 说明 |
| --- | --- | --- |
| `QQ_DEB_URL` | Linux QQ `3.2.34-53644`（`qqdl.gtimg.cn`） | 换其他版本；官网地址返回 `403` 时改用镜像站 |
| `WITH_FFMPEG` | `1` | 语音消息转码；设 `0` 省 185 MB |
| `WITH_AVSDK` | `0` | 语音/视频通话（还需额外的 voice-worker），+49 MB |
| `QQNT_BRIDGE_ARCHIVE_URL` | 本仓最新 release 产物 | 指定其他注入包 |
| `QQNT_BRIDGE_VERSION` | `unknown` | 写入 `/opt/qqnt-bridge/VERSION` 的值 |

- 默认体积 960 MB（关掉 ffmpeg 后 775 MB）：保留 ALSA、Xvfb、D-Bus、`qrencode`、ffmpeg 与 QQ，删除图标主题、文档、AVSDK，以及 deb 经 `libgbm1` 带入的 GPU 驱动栈（无头 `--disable-gpu` 不会加载）。基础镜像保持 Ubuntu：同一份 deb 在 Debian 12 上要手工补 `libgbm1`，体积反而更大（908 MB）。
- release 任务会把产物地址固定到当前 tag 并写入版本号，因为 `releases/latest` 会命中缓存层、可能装进旧注入。手动运行该 workflow 并选择 tag，配合 `qq-deb-url` 输入（或仓库变量 `QQ_DEB_URL`）可把同一份注入配到另一个 Linux QQ 版本。
- 所有构建与发布任务都受 `PUBLISH_IMAGES` 变量控制，默认发布：只放源码、不想消耗 Actions 分钟的仓库执行 `gh variable set PUBLISH_IMAGES --body false` 即可全部跳过；fork 无需配置，会推到自己 namespace 下。
