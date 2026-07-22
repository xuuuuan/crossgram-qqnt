# QQNT MTProto Bridge 当前进度与后续计划

更新时间：2026-07-22

## 1. 总体目标

项目由两部分组成：

1. `qqnt-bridge`
   - 注入 QQNT 主进程。
   - Hook `wrapper.node` 并获取 QQNT Kernel session。
   - 在 `127.0.0.1:18767` 提供本地流式协议服务。

2. `mtproto-relay-cordis/packages/platform-qqnt`
   - 连接 `qqnt-bridge`。
   - 实现 `@mtproto-relay/bridge` 的 `IMPlatform`。
   - 将 QQ 联系人、最近会话、消息、媒体、头像和 reactions 投影到 MTProto。

关联文档和参考路径见 `AGENTS.md`。

## 2. 已完成内容

### 2.1 QQNT 注入

- 已兼容新版 QQNT 的：
  - `process.dlopen()` node-loader。
  - `NodeIQQNTWrapperSession.getNTWrapperSession()`。
  - 只读 native prototype。
- 使用 module exports facade 和 native session Proxy，不直接修改只读 prototype。
- 同时保留旧版 constructor/listener wrapper 兼容逻辑。
- Native method 始终绑定原始 native receiver。
- 注入日志写入：

```text
/Users/xuuuuan/Library/Containers/com.tencent.qq/Data/Library/Logs/qqnt-bridge.log
```

### 2.2 本地协议服务

当前已有：

- `/v1/status`
- `/v1/dialogs`
- `/v1/contacts`
- `/v1/conversations/resolve`
- `/v1/conversations/:id`
- `/v1/conversations/:id/history`
- `/v1/conversations/:id/members`
- `/v1/users/:id`
- `/v1/messages`
- `/v1/messages/delete`
- `/v1/messages/forward`
- `/v1/messages/reactions`
- `/v1/reactions/catalog`
- `/v1/media/open`
- `/v1/events` SSE

协议特性：

- 上传使用流式 request body。
- 下载使用 `offset`/`limit` 和流式 response。
- SSE handler 顺序执行，保留背压。
- 支持可选 bearer token。
- 请求超时和 QQNT transient `Invalid argument` 有重试/缓存 fallback。

### 2.3 流式媒体

- Adapter 直接消费 `IMMediaSource.stream()`。
- 不在 Adapter 中构造完整文件 Buffer。
- QQ native API 只能使用路径，因此 QQ 主进程增量写 staging file。
- 普通成功/失败路径会清理 staging file。
- 已发送媒体为了支持 Telegram 立即预览/回读，暂时保留 staging file 10 分钟后清理。
- 下载支持 ranged stream。
- 已实现上传和下载进度。

### 2.4 Contacts 与 dialogs 分离

语义已经纠正为：

- `contacts`：完整 QQ 好友列表，来自 Buddy Service。
- `dialogs`：QQ 最近会话列表，来自 RecentContact Service。
- Buddy List 只补充联系人资料，不直接加入 dialogs。
- Group List 只补充群资料，不直接加入 dialogs。
- 显式 resolve 的用户/群允许加入内部 conversation cache，但不伪造为最近会话。

真实 QQNT 验证过：

- Buddy listener 一次返回 17 个好友。
- `/v1/contacts?limit=500` 能返回完整好友页。
- 联系人使用 QQ UID 作为 opaque ID，数字 QQ 号保存在 `numericId`/metadata。

### 2.5 对话列表与历史消息

- 已实现 recent dialogs 分页。
- 已实现 QQ native history 拉取。
- history native 请求可能同步抛错或挂起，已加入：
  - 5 秒请求超时。
  - live message cache fallback。
  - native 非零错误时的当前页 cache fallback。
- RecentContact listener 已接入，用于持续更新 dialogs cache。
- 消息 ID、source element ID 和 QQ `msgSeq` 均保持 opaque string。

### 2.6 头像

- 用户头像：
  - `getAvatarPath`
  - `forceDownloadAvatar`
- 群头像：
  - `getGroupAvatarPath`
  - `getConfGroupAvatarPath`
  - `forceDownloadGroupAvatar`
- 用户、群和联系人头像通过统一 `IMMedia` 暴露。
- 头像读取走 `/v1/media/open` ranged stream。
- 批量 contacts 查询只使用已有本地头像，避免并发触发大量 native 下载。
- 单用户和对话详情允许按需触发头像下载。
- 已真实验证头像 range 下载 128 字节成功。

### 2.7 QQ 云控 reactions

已确认 QQ 的 reaction 资源机制：

- 云控配置：

```text
getEmojiResourcePath(0)
```

- SysFace 资源：

```text
getEmojiResourcePath(1)
static/s{QSid}.png
```

- 本地云控资源目录可直接从 QQ global data 下的
  `Emoji/emoji-resource/face_config.json` 发现，避免 native API 偶发挂起。
- 当前真实账号加载到 247 个 reaction definitions。
- Unicode emoji：
  - QQ key 使用 `2:{QCid/AQLid}`。
  - Telegram presentation 使用云控 `QSid` Unicode 字符。
- QQ SysFace：
  - QQ key 使用 `1:{QSid}`。
  - 暴露为 custom emoji。
  - 资源来自云控下载的 PNG。
- 已有 reaction 状态来自 `MsgRecord.emojiLikesList`。
- 写入使用：

```text
setMsgEmojiLikes(peer, msgSeq, emojiId, emojiType, setEmoji)
```

- reaction 更新通过 `onMsgInfoListUpdate` 的完整 `MsgRecord` 检测，并转换成
  `message-reactions` 事件。
- reaction native promise 偶发不返回时，会和 reaction update event 竞速，并进行有限重试。
- 已单独真实验证：
  - reaction catalog。
  - SysFace range 下载。
  - 群消息添加 reaction。

### 2.8 IMPlatform Adapter

`packages/platform-qqnt` 已实现：

- `subscribe`
- `getDialogs`
- `getContacts`
- `getHistory`
- `getUser`
- `getConversationMembers`
- `getConversationMember`
- `sendMessage`
- `deleteMessages`
- `downloadMedia`
- `getAvailableReactions`
- `getMessageReactions`
- `setMessageReactions`
- `downloadReactionResource`

Capability 已声明：

- text/image/file/mixed send
- groups
- members
- user/conversation avatars
- delete
- reaction read/write/events

当前 edit 和 forward 在 IMPlatform capability 中仍声明为 unsupported，避免返回无法确认最终消息 ID 的伪成功。

### 2.9 Bridge contacts 契约

已扩展 `IMPlatform`：

```ts
getContacts?(session, query): Promise<IMUserPage>
```

`contacts.getContacts` 现在优先使用平台完整 address book，不再只能从 direct dialogs 推导。

平台未实现 `getContacts` 时仍保留原有 direct-dialog fallback。

## 3. 测试现状

### 3.1 已通过

`qqnt-bridge`：

- Vitest 单元测试：4 个通过。
- 覆盖：
  - dialogs/history 映射。
  - send confirmation。
  - 流式 staging。
  - contacts 与 dialogs 分离。
  - HTTP server。

`platform-qqnt`：

- Vitest 单元测试：7 个通过。
- 覆盖：
  - upload streaming/progress。
  - short source failure。
  - SSE 背压。
  - ID/member 映射。
  - contacts/avatar 映射。
  - reaction catalog/read/write 映射。
  - ranged media download。

真实 QQNT 分项 E2E 已分别通过：

- 完整 contacts 获取。
- contacts avatar range 下载。
- QQ reaction catalog。
- SysFace reaction resource range 下载。
- 群消息 reaction 写入。
- 私聊和两个允许群的文本发送。
- 文件流式上传。
- 文件 ranged 下载。

### 3.2 最后一次组合 E2E

最后一次执行完整组合 E2E 时，用户中断了测试命令。

中断前已经完成的最新修复：

- outbound pending message 增加内容、时间和媒体名匹配，避免其他消息事件误确认。
- media send 必须等待 `sendStatus >= 2`。
- media staging file 在成功后保留 10 分钟用于立即回读。
- history 同步 native throw 现在会进入 Promise/fallback。
- 群头像 native `Invalid argument` 不再让 resolve 失败。
- reaction cloud catalog 改为优先读取本地云控文件，不再依赖可能挂起的 native resource path API。

因此必须重新执行一次完整组合 E2E，才能确认这些最后改动整体通过。

## 4. 当前已知问题

### 4.1 QQ native API 并发稳定性

QQNT native service 在短时间连续进行以下操作时可能出现：

- `Invalid argument`
- Promise 长时间不返回
- listener 先返回最终状态，但 method promise 不返回

目前已对 send、history、contacts 和 reactions 做了不同程度的：

- event/promise race
- timeout
- retry
- cache fallback

仍需要通过完整组合 E2E 继续检查是否还有遗漏的 native 调用。

### 4.2 运行中的 Cordis 会干扰 E2E

此前本机已有 `pnpm dev`/Cordis worker 和 Materialgram 连接，启用 `platform-qqnt`
后会同时读取媒体、请求历史或发送请求，显著增加 native API 并发并干扰 E2E。

完整 E2E 前应：

1. 停止 Cordis dev worker 和 MTProto 测试客户端，或临时禁用 `app.yml` 中的 qqnt entry。
2. 重启 QQ。
3. 等待 `/v1/status` ready。
4. 再运行 E2E。

不要在不知道用户意图时永久修改 `app.yml` 的 enabled/disabled 状态。

### 4.3 Static custom reaction MIME

QQ SysFace 原始资源是 PNG，目前 `IMReactionResource` 已扩展支持 `image/png`。

还需要实际观察目标 Telegram Desktop/Materialgram 对 custom emoji PNG document 的显示效果。
如果客户端要求 WebP，则需要增加真正的流式/文件式 PNG -> WebP 转换，不能仅伪造 MIME。

### 4.4 Reaction actor list

目前 capability：

```text
actorList: false
```

QQ 提供 `getMsgEmojiLikesList`，但尚未接入到 bridge 的 actor list RPC。

### 4.5 Contact 名称

部分 Buddy listener 数据只返回 UID/UIN，昵称可能暂时回退为数字 QQ 号。

后续可以批量使用：

- `getBuddyNick`
- `getBuddyRemark`

补全联系人展示名，同时避免逐个 native 调用。

## 5. 接下来要做

### P0：完成最终验证

1. 停止可能干扰 QQNT API 的 Cordis/Materialgram 测试进程。
2. `pnpm test && pnpm build`
3. `./start.sh`
4. 确认：

```sh
curl http://127.0.0.1:18767/v1/status
curl 'http://127.0.0.1:18767/v1/contacts?limit=500'
curl 'http://127.0.0.1:18767/v1/dialogs?limit=100'
curl http://127.0.0.1:18767/v1/reactions/catalog
```

5. 运行完整 E2E：

```sh
QQNT_BRIDGE_E2E=1 \
QQNT_BRIDGE_E2E_FILE=/tmp/qqnt-bridge-e2e.bin \
pnpm --filter @mtproto-relay/platform-qqnt exec \
vitest run src/e2e.test.ts --reporter=verbose
```

安全限制必须保持：

- 私聊仅 `1715311957`
- 群聊仅 `1058754719`、`1084013940`

### P1：补充 bridge contacts 测试

- 在 `packages/bridge/src/dialogs.test.ts` 增加：
  - `getContacts` 优先平台 address book。
  - contacts 不要求出现在 dialogs。
  - contact avatar 能注册 `photoId` 并通过 `upload.getFile` 读取。

### P1：补充 reaction 事件单测

- qqnt-bridge：
  - `emojiLikesList` -> reaction context。
  - 同 message ID reaction 变化 -> `message-reactions`，而不是重复 `message`。
  - pending reaction event race。
- platform-qqnt：
  - `WireEvent.message-reactions` -> `IMEvent.message-reactions`。
  - custom PNG ranged resource progress 单调递增。

### P1：补全联系人名字

- Buddy full list 后批量获取 remark/nick。
- 保持 contacts 全量与 dialogs recent 的边界。

### P2：Reaction actor list

- 接入 `getMsgEmojiLikesList`。
- 分页读取 reaction 用户。
- 映射到 `recentActors`。
- 验证 Telegram `messages.getMessageReactionsList`。

### P2：客户端 custom emoji 兼容验证

- 在 Materialgram 中确认：
  - reaction panel 是否显示 QQ SysFace。
  - custom reaction document 是否能下载和渲染。
  - PNG 是否被客户端接受。
- 如不接受，增加 PNG -> WebP 转换。

### P2：性能与并发

- 给 QQ native service 增加按 service 分类的串行队列，代替分散的 retry。
- 避免超时后遗留的 native Promise 持续占用服务。
- 为 contacts/avatar/reaction catalog 增加有版本号的缓存。

## 6. 提交状态

上一阶段已有提交：

`qqnt-bridge`：

```text
2d57a85 bridge: add streaming QQNT kernel server
b00a9b3 kernel: support modern QQNT hooks and durable logs
```

该仓库没有配置 Git remote，之前只能 commit，不能 push。

`mtproto-relay-cordis`：

```text
7b44ec1 platform-qqnt: implement streaming QQ IMPlatform
```

已 push 到 `origin/main`。

本轮 contacts/avatar/reactions/bridge contract/AGENTS/PLAN 修改尚未 commit。

提交前必须：

1. 完成 P0 完整 E2E。
2. 检查两个仓库 `git diff`。
3. 分仓库提交，message 使用 `scope: detail`。
4. Relay 仓库 push；qqnt-bridge 若仍无 remote，明确记录无法 push。
