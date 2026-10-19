# crossgram-qqnt (`qqnt-bridge`)

基于 QQNT PC 客户端的本地桥接服务：注入 QQNT Electron 主进程，将 QQNT 内核能力通过带鉴权的 HTTP 与 WebSocket 接口暴露给 Crossgram。

默认监听 `http://127.0.0.1:18767/v1`。

## 核心能力

- **消息**：发送文字、图片、文件、语音（PTT/Silk 转码），拉取历史记录，撤回消息，标记已读，逐条/合并转发及多选转发内容展开，戳一戳，语音转文字。
- **会话与成员**：会话列表/详情/搜索、好友列表、群成员分页、按 QQ 号/群号解析会话、设置管理员、禁言与踢人、群文件浏览。
- **媒体与闪传**：通过原生 OIDB 发包刷新 RKey 获取图片/视频/文件 CDN 直链；Highway 流式分块上传；QQ 闪传文件集创建（已有媒体秒传 / 新文件流式上传）。
- **表情与回应**：QQ 收藏表情、商城贴纸、系统黄脸；消息表情回应读写与自定义回应图标读取。
- **登录与事件**：无头二维码登录、自动登录保活、好友/加群申请处理、WebSocket 实时事件流（`/v1/events/ws`）及语音通话本地 PCM 网关。

## 快速开始

### Linux x86_64（systemd）

```sh
curl -fsSL https://raw.githubusercontent.com/xuuuuan/crossgram-qqnt/main/deploy/install.sh | sudo sh
```

Debian/Ubuntu 会自动下载官方 Linux QQ `.deb`；Fedora/RHEL、Arch、openSUSE 请先安装官方 Linux QQ 再运行安装脚本。安装器会自动配置依赖（Xvfb、D-Bus、ffmpeg、qrencode 等）、创建 `qqnt-bridge` 系统用户并启动 `qqnt-bridge.service`。

常用运维命令：

```sh
sudo qqntctl qr                    # 终端打印登录二维码
sudo qqntctl qr --png /tmp/qq-login.png
sudo qqntctl status                # 查看桥接与登录状态
sudo qqntctl logs                  # 查看服务日志
sudo qqntctl logout                # 切换账号（仅移除登录票据，保留聊天数据）
sudo qqntctl update                # 升级到最新 Release
```

自定义 QQ 安装路径：

```sh
curl -fsSL https://raw.githubusercontent.com/xuuuuan/crossgram-qqnt/main/deploy/install.sh \
  | sudo env QQNT_BINARY=/path/to/qq QQNT_RESOURCES_DIR=/path/to/resources sh
```

更多 Linux 部署说明见 [`deploy/README.md`](deploy/README.md)。

### Nix 启动

```sh
nix build .#qqnt-bridge-assets
# 参数依次为：[DATA_DIR] [DISPLAY] [VNC_PORT] [NOVNC_PORT] [MEDIA_SOCKET] [BRIDGE_ENV]
# VNC_PORT=0 关闭 VNC（默认）；需要排障时再改成 5900
nix run .#qqnt -- /srv/qqnt/primary 99 0 6080 /run/qqnt-media/primary/qqnt-media.sock
```

VNC 默认关闭（`QQNT_VNC_PORT=0`，端口 0 即禁用）：扫码登录走 `qqntctl qr`，VNC 只是无显示器时看界面/排障（比如好友请求弹窗）的兜底。需要时用 `QQNT_VNC_PORT=5900 nix run .#qqnt -- ...` 打开（也可以直接传第 3 个位置参数），默认只监听 `127.0.0.1`（x11vnc 没有密码）；要从其它机器访问再用 `QQNT_VNC_BIND` 覆盖，并自行加防火墙或 VNC 密码。

### Windows 本地调试

需要先安装 Rust 工具链与 Node.js / pnpm：

```powershell
pnpm install --frozen-lockfile
pnpm build
$env:QQNT_BRIDGE_PACKET_ADDON = Join-Path $PSScriptRoot 'dist\qqnt_packet.win32-x64-msvc.node'
.\start.ps1
```

## 构建与测试

```sh
pnpm install --frozen-lockfile
pnpm generate:proto              # 从 proto/qqnt/packet.proto 生成 TypeScript
pnpm build:native                # 编译 Rust 原生发包插件
pnpm build                       # 构建原生插件与 esbuild 产物到 dist/
pnpm package                     # 打包当前平台的 release/debug 注入包
pnpm test                        # 运行 Vitest 与 Rust cargo test
pnpm test:e2e                    # 针对运行中的 bridge 执行端到端测试
```

## 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `QQNT_BRIDGE_HOST` | `127.0.0.1` | HTTP/WebSocket 监听地址 |
| `QQNT_BRIDGE_PORT` | `18767` | HTTP 端口（WebSocket 默认复用该端口 Upgrade） |
| `QQNT_BRIDGE_TOKEN` | 空 | 鉴权 Token（设置后请求需带 `Authorization: Bearer <token>`） |
| `QQNT_BRIDGE_WS_HOST` | 同 `QQNT_BRIDGE_HOST` | 独立 WebSocket 监听地址 |
| `QQNT_BRIDGE_WS_PORT` | 空 | 独立 WebSocket 端口（未设置时复用 HTTP 端口） |
| `QQNT_BRIDGE_LOG` | 平台相关 | 日志文件路径 |
| `QQNT_BRIDGE_SLOW_HTTP_LOG` | 日志目录下 | 慢请求日志路径 |
| `QQNT_BRIDGE_LOG_MAX_BYTES` | `67108864` | 单个日志文件轮转上限（64 MiB） |
| `QQNT_BRIDGE_LOG_BACKUPS` | `3` | 日志轮转保留份数 |
| `QQNT_BRIDGE_AUTO_LOGIN` | `1` | 设为 `0` 关闭自动登录 |
| `QQNT_BRIDGE_MANAGE_LOGIN` | `1` | 设为 `0` 关闭自动请求二维码 |
| `QQNT_BRIDGE_PACKET_ADDON` | 自动使用内嵌版本 | 显式指定 `qqnt_packet.*.node` 路径 |
| `QQNT_BRIDGE_MEDIA_GATEWAY` | 空 | 设为 `1` 启用本地语音 PCM 媒体网关 |
| `QQNT_BRIDGE_MEDIA_SOCKET` | `/run/qq-pulse/qqnt-media.sock` | PCM 媒体网关 Unix Socket 路径 |
| `QQNT_BRIDGE_MEDIA_MIC_SINK` | `qq_mic_sink` | PulseAudio 虚拟麦克风 Sink 名称 |

## API 概览

所有接口均以 `/v1` 为前缀（详细请求/响应结构见 Crossgram 主仓的 `packages/platform-crossgram/PROTOCOL.md`）：

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/v1/status` | 桥接、内核与登录状态 |
| `GET` | `/v1/login/status` | 登录状态 |
| `GET` | `/v1/login/qrcode.png` | 登录二维码 PNG |
| `GET` | `/v1/login/qrcode/url` | 登录二维码 URL |
| `POST` | `/v1/login/qrcode/refresh` | 刷新登录二维码 |
| `GET` | `/v1/events/ws` | WebSocket 事件流 |
| `GET` | `/v1/dialogs` | 会话列表 |
| `GET` | `/v1/contacts` | 好友列表 |
| `GET` | `/v1/users/:uid` | 查询用户信息 |
| `POST` | `/v1/users/:userId/block` | 拉黑或解除拉黑用户 |
| `GET` | `/v1/conversations/resolve` | 按 QQ 号/群号解析会话 |
| `GET` | `/v1/conversations/:id` | 会话详情 |
| `GET` | `/v1/conversations/:id/history` | 历史消息；`beforeSeq` 按 msgSeq 向前读取并返回原始 `sequenceRange`（协议 36 起） |
| `GET` | `/v1/conversations/:id/members` | 群成员分页 |
| `GET` | `/v1/conversations/:id/files` | 群文件列表 |
| `POST` | `/v1/conversations/:id/members/:userId/moderate` | 群成员管理（管理员/禁言/踢人） |
| `POST` | `/v1/conversations/1\|2/:peerUin/notification-mask` | 设置群消息通知策略 |
| `POST` | `/v1/uploads/prepare` | 预检媒体上传（秒传判定与 Highway 计划） |
| `POST` | `/v1/flash-transfers` | 创建 QQ 闪传文件集并返回分享链接 |
| `POST` | `/v1/messages` | 发送消息（通过 `x-qqnt-manifest` 传递清单） |
| `POST` | `/v1/messages/delete` | 撤回消息 |
| `POST` | `/v1/messages/get` | 按 ID 获取消息 |
| `POST` | `/v1/messages/forward` | 转发消息 |
| `POST` | `/v1/messages/multi-forward` | 获取合并转发内容 |
| `POST` | `/v1/messages/read` | 标记已读 |
| `POST` | `/v1/messages/poke` | 发送戳一戳 |
| `POST` | `/v1/messages/transcribe` | 语音转文字 |
| `POST` | `/v1/messages/inline-callback` | 触发机器人内联按钮回调 |
| `GET` | `/v1/reactions/catalog` | 可用回应目录 |
| `GET` | `/v1/messages/reactions` | 获取消息回应状态 |
| `POST` | `/v1/messages/reactions` | 设置消息回应 |
| `GET` | `/v1/messages/reactions/list` | 回应成员列表 |
| `POST` | `/v1/reactions/asset` | 自定义回应图标字节 |
| `GET` | `/v1/stickers/packs` | 贴纸包列表 |
| `GET` | `/v1/stickers/saved` | 收藏表情列表 |
| `GET` | `/v1/stickers/:id` | 单个贴纸元数据 |
| `POST` | `/v1/stickers/saved` | 添加或移除收藏表情 |
| `POST` | `/v1/stickers/asset` | 贴纸资源字节（支持 Range） |
| `POST` | `/v1/files/direct-url` | 获取图片/视频/文件直链（自动刷新 RKey） |
| `POST` | `/v1/files/asset` | 媒体字节流下载（支持 Range） |
| `GET` | `/v1/requests` | 好友与加群请求分页 |
| `POST` | `/v1/requests/:id/resolve` | 同意或拒绝请求 |
| `POST` | `/v1/calls/media-lease` | 获取通话 PCM 媒体租约 |
| `POST` | `/v1/calls/control` | 控制语音通话（接听/拒绝/挂断） |
