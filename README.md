# qqnt-bridge

qqnt-bridge 是一个本地流式桥接服务：它注入 QQNT Electron 主进程，把 QQNT 内核能力以带鉴权的 HTTP/WebSocket API 暴露给 `mtproto-relay`（Crossgram 的 Telegram ↔ QQ 桥）。Linux x86_64 上提供一等公民的 headless systemd 部署；Windows/macOS 支持本地构建后注入开发调试。

主页 / 仓库：<https://github.com/xuuuuan/crossgram-qqnt>

默认监听 `http://127.0.0.1:18767/v1`，API 根路径为 `/v1`。

## 主要能力

- **消息**：发送文本、图片、文件、语音（PTT/Silk 转码），拉取历史记录，删除消息，标记已读，转发与合并转发，多选转发内容解析。
- **会话与联系人**：会话列表/详情/成员分页，联系人分页，按 UID 查询用户，按 QQ 号解析会话。
- **媒体**：通过原生 OIDB 发包刷新 RKey，获取图片/文件直链；本地媒体资产流式下载，支持 HTTP Range；表情资产读取。
- **表情与回应**：QQ 收藏表情、商城表情、系统表情；消息回应读取、设置与回应资产。
- **登录**：无头二维码登录、登录状态、二维码 PNG/URL、刷新二维码、自动登录开关。
- **好友/群请求**：好友请求与加群请求的分页查询及同意/拒绝。
- **事件**：WebSocket 事件流 `/v1/events/ws`。
- **通话媒体**：本地 PCM 媒体网关租约（`/v1/calls/media-lease`），供语音通话媒体面使用；原生 AVSDK 来电状态通过 listener tee 做有界投影。
- **群通知屏蔽**：读取/设置群消息屏蔽（群助手/免打扰等）。

## 工作原理

```
mtproto-relay / Crossgram
        │ HTTP + WebSocket (Bearer token)
        ▼
qqnt-bridge HTTP server (src/server.ts)
        │
        ▼
QQKernelBridge (src/qq-kernel.ts)
        │
        ├─ listener tee / login controller / packet client
        ├─ native packet addon (Rust, napi-rs)
        │    └─ hook QQNT sendSsoCmdReqByContend 收发二进制，
        │       实现 OIDB 发包、RKey 刷新、图片/文件直链与 Highway 上传
        └─ PCM media gateway (本地 Unix socket, 48kHz s16le 20ms 帧)
```

注入方式：Linux 发行包用 `deploy/loader.cjs` 生成小型 `app.asar` 放到 `resources/app.asar`，启动时把 `appPath` 指回腾讯原始 `resources/app`，再加载 bridge 入口与官方 `app_launcher/index.js`。bridge 入口通过 `Module._load` 与 `process.dlopen` 包装 QQNT 内核模块，不修改原生对象，只替换导出对象并通过 construct proxy 观察 session 初始化。

## 快速开始

### Linux x86_64（systemd，推荐）

```sh
curl -fsSL https://raw.githubusercontent.com/xuuuuan/crossgram-qqnt/master/deploy/install.sh | sudo sh
```

Debian/Ubuntu 会尝试自动下载腾讯官方 Linux QQ `.deb`；Fedora/RHEL、Arch、openSUSE 请先安装官方 Linux QQ，再运行安装脚本。脚本会安装依赖（Xvfb、D-Bus、ffmpeg、qrencode 等），创建 `qqnt-bridge` 系统用户，写入 `/etc/qqnt-bridge.env`（含随机 Bearer token，权限 `0600`），并启用 `qqnt-bridge.service`。

安装后：

```sh
sudo qqntctl qr                    # 终端打印登录二维码
sudo qqntctl qr --png /tmp/qq-login.png
sudo qqntctl status                # 查看桥接与登录状态
sudo qqntctl logs                  # 跟踪服务日志
sudo qqntctl logout                # 切换账号（仅移除登录态，不删聊天数据）
sudo qqntctl update                # 升级到最新 release
```

自定义 QQ 安装路径：

```sh
curl -fsSL https://raw.githubusercontent.com/xuuuuan/crossgram-qqnt/master/deploy/install.sh \
  | sudo env QQNT_BINARY=/path/to/qq QQNT_RESOURCES_DIR=/path/to/resources sh
```

更多部署细节见 [`deploy/README.md`](deploy/README.md)。

### Windows / macOS（本地构建注入）

```sh
pnpm install --frozen-lockfile
pnpm build
```

- Windows：先确认原生 Rust 工具链可用，`pnpm build` 会构建 native packet addon 并生成 `dist/`。随后：

  ```powershell
  $env:QQNT_BRIDGE_PACKET_ADDON = Join-Path $PSScriptRoot 'dist\qqnt_packet.win32-x64-msvc.node'
  .\start.ps1
  ```

- macOS：`start.sh` 会把 `dist/main.js` 复制到 `/Applications/QQ.app/Contents/Resources/app/main.js` 后启动 QQ。

> Windows/macOS 路径目前以开发调试为主；生产环境建议使用 Linux headless 部署。

## 构建与测试

```sh
pnpm install --frozen-lockfile   # 安装依赖
pnpm generate:proto              # 从 proto/qqnt/packet.proto 生成 TypeScript
pnpm build:native                # 编译 Rust native packet addon
pnpm build                       # native + esbuild bundle + 复制 addon 到 dist
pnpm package                     # 为当前平台打 release/debug tar.gz 包
pnpm package:release             # 只打 release 注入包
pnpm package:debug               # 只打 debug 注入包
pnpm test                        # vitest + Rust cargo test
pnpm test:e2e                    # 针对运行中 bridge 的端到端测试
```

`pnpm package` 会调用 `scripts/package-injection.mjs`，构建注入用 `app.asar`，并把 `deploy/` 下的 `qqntctl`、`install.sh`、`run-headless.sh`、`session-state.sh`、`qqnt-bridge.service` 一并打入 `dist/packages/qqnt-bridge-<platform>-<arch>-<mode>.tar.gz`。

## 环境变量

### 核心运行时

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `QQNT_BRIDGE_HOST` | `127.0.0.1` | HTTP/WebSocket 监听地址。 |
| `QQNT_BRIDGE_PORT` | `18767` | HTTP 端口；WebSocket 默认通过同一端口的 upgrade 提供。 |
| `QQNT_BRIDGE_TOKEN` | 空 | 设置后所有 HTTP/WebSocket 请求必须携带 `Authorization: Bearer <token>`。安装器会生成随机 token。 |
| `QQNT_BRIDGE_WS_HOST` | 同 `QQNT_BRIDGE_HOST` | 独立 WebSocket 服务监听地址。 |
| `QQNT_BRIDGE_WS_PORT` | 空 | 设置后 WebSocket 使用独立端口，否则复用 HTTP 端口 upgrade。 |
| `QQNT_BRIDGE_LOG` | 平台相关 | 日志文件路径。 |
| `QQNT_BRIDGE_SLOW_HTTP_LOG` | 日志目录下 | 慢 HTTP 请求日志路径。 |
| `QQNT_BRIDGE_LOG_MAX_BYTES` | `67108864` | 单个日志文件轮转大小。 |
| `QQNT_BRIDGE_LOG_BACKUPS` | `3` | 日志备份数量。 |
| `QQNT_BRIDGE_COLOR` / `NO_COLOR` | 空 | `QQNT_BRIDGE_COLOR=0` 或设置 `NO_COLOR` 时关闭控制台颜色。 |
| `QQNT_BRIDGE_AUTO_LOGIN` | `1` | 设为 `0` 关闭自动登录。 |
| `QQNT_BRIDGE_MANAGE_LOGIN` | `1` | 设为 `0` 关闭自动请求二维码。 |
| `QQNT_BRIDGE_PACKET_ADDON` | 自动定位 | 指定 `qqnt_packet.*.node` native addon 路径。 |
| `QQNT_BRIDGE_MEDIA_GATEWAY` | 空 | 设为 `1` 启用本地 PCM 媒体网关。 |
| `QQNT_BRIDGE_MEDIA_SOCKET` | `/run/qq-pulse/qqnt-media.sock` | PCM 媒体网关 Unix socket 路径。 |
| `QQNT_BRIDGE_MEDIA_MIC_SINK` | `qq_mic_sink` | PCM 媒体网关 PulseAudio 麦克风 sink。 |
| `QQNT_BRIDGE_GROUP_JOIN_CONTRACT_PROBE` | 空 | 设为 `1` 启用加群契约探测。 |
| `QQNT_BRIDGE_GROUP_JOIN_WRAPPER_PATH` | `/opt/QQ/resources/app/wrapper.node` | 加群契约探测使用的 `wrapper.node` 路径。 |

### E2E 测试

| 变量 | 说明 |
| --- | --- |
| `QQNT_BRIDGE_E2E` | 设为 `1` 启用端到端测试。 |
| `QQNT_BRIDGE_URL` | 测试目标 API 基地址，默认 `http://127.0.0.1:18767/v1`。 |
| `QQNT_BRIDGE_E2E_FILE` | 用于文件直链测试的本地文件路径。 |
| `QQNT_BRIDGE_E2E_MARKET_STICKER` | 用于商城表情测试的贴纸 ID。 |

### 部署脚本

安装器、`run-headless.sh`、`qqntctl` 还使用 `QQNT_BINARY`、`QQNT_RESOURCES_DIR`、`QQNT_BRIDGE_STATE_DIR`、`QQNT_BRIDGE_HEADLESS`、`QQNT_BRIDGE_CLOSE_MAIN_WINDOW` 等变量，见 [`deploy/README.md`](deploy/README.md)。

## API 概览

所有接口都以 `/v1` 为前缀。配置了 `QQNT_BRIDGE_TOKEN` 时，请求需携带：

```http
Authorization: Bearer <QQNT_BRIDGE_TOKEN>
```

未配置 token 时本地服务无鉴权。生产安装器默认生成并配置 token。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/v1/status` | 桥接、内核与登录状态。 |
| `GET` | `/v1/login/status` | 登录状态。 |
| `GET` | `/v1/login/qrcode.png` | 登录二维码 PNG。 |
| `GET` | `/v1/login/qrcode/url` | 登录二维码 URL（供终端 qrencode 渲染）。 |
| `POST` | `/v1/login/qrcode/refresh` | 刷新登录二维码。 |
| `GET` | `/v1/events/ws` | WebSocket 事件流（`Upgrade` 请求）。 |
| `POST` | `/v1/calls/media-lease` | 获取通话 PCM 媒体租约。 |
| `GET` | `/v1/requests` | 分页查询好友/加群请求。 |
| `POST` | `/v1/requests/:id/resolve` | 同意或拒绝请求。 |
| `GET` | `/v1/dialogs` | 会话列表。 |
| `GET` | `/v1/contacts` | 联系人分页。 |
| `GET` | `/v1/users/:uid` | 查询用户信息。 |
| `GET` | `/v1/conversations/resolve` | 按 QQ 号解析会话。 |
| `GET` | `/v1/conversations/:id` | 会话详情。 |
| `GET` | `/v1/conversations/:id/history` | 历史消息。 |
| `GET` | `/v1/conversations/:id/members` | 群成员分页。 |
| `GET` | `/v1/conversations/:id/search` | 会话内搜索。 |
| `POST` | `/v1/conversations/1\|2/:peerUin/notification-mask` | 设置群消息屏蔽。 |
| `POST` | `/v1/uploads/prepare` | 准备媒体上传（返回 Highway/直传计划）。 |
| `POST` | `/v1/messages` | 发送消息（正文通过 `x-qqnt-manifest` 传递）。 |
| `POST` | `/v1/messages/delete` | 删除消息。 |
| `POST` | `/v1/messages/get` | 按 ID 获取消息。 |
| `POST` | `/v1/messages/forward` | 转发消息。 |
| `POST` | `/v1/messages/multi-forward` | 获取多选转发内容。 |
| `GET` | `/v1/messages/reactions` | 获取消息回应。 |
| `POST` | `/v1/messages/reactions` | 设置消息回应。 |
| `GET` | `/v1/messages/reactions/list` | 回应成员列表。 |
| `POST` | `/v1/messages/read` | 标记已读。 |
| `GET` | `/v1/stickers/packs` | 表情包列表。 |
| `GET` | `/v1/stickers/saved` | 收藏表情。 |
| `GET` | `/v1/stickers/:id` | 单个表情。 |
| `POST` | `/v1/stickers/asset` | 表情资产（支持 Range）。 |
| `POST` | `/v1/stickers/saved` | 设置收藏表情。 |
| `POST` | `/v1/files/direct-url` | 图片/文件直链（自动刷新 RKey）。 |
| `POST` | `/v1/files/asset` | 媒体资产流式下载（支持 Range）。 |
| `POST` | `/v1/reactions/asset` | 回应图标资产。 |
| `GET` | `/v1/group-join/probe` | 加群契约探测状态（要求 token）。 |

## 目录结构

```
.
├── deploy/                  # Linux headless 部署：systemd、安装器、qqntctl、loader
├── docs/                    # 原生实现研究文档
│   ├── NATIVE_PACKET_IMPL.md
│   └── NATIVE_VOICE_CALL.md
├── native/
│   ├── packet-addon/        # Rust napi-rs 原生发包/RKey/直链 addon
│   └── ppapi-host/          # PPAPI AVSDK loader 元数据观测宿主
├── proto/qqnt/              # Protobuf 定义
├── scripts/                 # 构建、打包、镜像同步脚本
├── src/                     # TypeScript 源码（注入入口、HTTP server、内核桥接）
├── package.json
├── pnpm-lock.yaml
└── pnpm-workspace.yaml
```

## 文档索引

- [`deploy/README.md`](deploy/README.md)：Linux headless 部署、`qqntctl` 命令与账号切换/恢复策略。
- [`docs/NATIVE_PACKET_IMPL.md`](docs/NATIVE_PACKET_IMPL.md)：QQNT 原生发包、RKey 刷新、图片直链与 Highway 上传的实现与维护记录。
- [`docs/NATIVE_VOICE_CALL.md`](docs/NATIVE_VOICE_CALL.md)：原生语音通话控制面的跨平台逆向记录、证据分层与安全边界。

## 安全说明

- 服务默认只绑定 `127.0.0.1`。需要远程访问时请使用 SSH 隧道，不要直接把 `QQNT_BRIDGE_HOST` 暴露到公网。
- 生产安装器会生成随机 Bearer token 并写入权限为 `0600` 的 `/etc/qqnt-bridge.env`；本地调试若未设置 `QQNT_BRIDGE_TOKEN` 则无鉴权。
- 日志会脱敏群号/加群目标等敏感路由；日志文件同样只保存在本地。
- bridge 不拦截、不观察、不序列化原生 AVSDK action 数据；通话媒体租约与来电状态投影遵循最小化采集边界。
