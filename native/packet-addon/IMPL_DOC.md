# QQNT 原生发包与直链维护文档

> 适用版本：QQNT 9.9.33-51552  
> 最后更新：2026-07-25  
> 相关仓库：`D:\qqnt-bridge`

## 1. 目的

本文档记录 `D:\qqnt-bridge` 中 QQNT 原生发包（`sendSsoCmdReqByContend`）、RKey 刷新和图片直链获取的实现原理与维护方法。

当 QQ 升级导致以下任意功能失效时，可参照本文档定位并修复：

- 图片直链无法获取（`/v1/files/direct-url` 返回 404）
- 发包日志出现 `result=145 请求包解析失败`
- QQ 主进程在 bridge 加载后崩溃
- 响应回包中 `rspbuffer` 始终为空

---

## 2. 架构概览

```
┌─────────────────────────────────────────────────────────────┐
│  TypeScript 层                                             │
│  ┌─────────────────┐    ┌─────────────────────────────┐   │
│  │ QQPacketClient  │───▶│ loadPacketAddon()           │   │
│  │ - getImageUrl() │    │   └─ installSendHook()      │   │
│  │ - fetchRkeys()  │    │   └─ encode/decode RKey     │   │
│  └─────────────────┘    └─────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
                               │
                               ▼ napi-rs
┌─────────────────────────────────────────────────────────────┐
│  Rust native addon (qqnt_packet.win32-x64-msvc.node)      │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ 定位器 (locator.rs)                                 │   │
│  │  • 安全快照: VirtualQuery + 只读页拷贝              │   │
│  │  • anchor: 断言字符串 → RIP xref → .pdata owner    │   │
│  │  • converter: send wrapper 内相邻 direct call      │   │
│  │  • response: promise helper → callback table →     │   │
│  │    callback entry → dispatcher → thunk             │   │
│  └─────────────────────────────────────────────────────┘   │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ Hook 层 (hook.rs)                                   │   │
│  │  • send converter: 保留 Buffer 二进制              │   │
│  │  • response callback: 提取 rspbuffer 为 Buffer     │   │
│  └─────────────────────────────────────────────────────┘   │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ 协议层 (proto.rs)                                   │   │
│  │  • OidbEnvelope (0x9067_202)                       │   │
│  │  • FetchRkey 请求/响应编解码                        │   │
│  └─────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

---

## 3. 核心数据结构

### 3.1 QQ 内部字符串布局

QQNT `wrapper.node` 中字符串对象有两种形态，所有内部字符串（错误消息、响应 bytes）均使用此布局：

```cpp
// 短字符串 (tag 低位为 0)
struct ShortString {
    uintptr_t tag;      // tag >> 1 == length, 最低位为 0
    uint8_t   data[...]; // 紧跟在 tag 之后
};

// 堆字符串 (tag 低位为 1)
struct HeapString {
    uintptr_t tag;      // 最低位为 1
    uintptr_t length;   // +8
    uint8_t*  data;     // +16
};
```

### 3.2 响应回调状态布局

`sendSsoCmdReqByContend` 的 Promise 回调中，`task` 指针布局如下：

```cpp
// task 指向一个回调上下文
struct ResponseTask {
    uint8_t  padding[0x10];   // vtable / refcount
    void*    state;           // +0x10: 指向 SharedState
    // ... 其他字段
};

// SharedState 布局
struct SharedState {
    // ... 前 0x18 字节 (refcount, 等)
    napi_env     env;         // +0x18
    napi_deferred deferred;   // +0x20
    // ... 后续字段
};

// 回调在 task 上直接读取响应字段
struct ResponseFields {
    // 从 task + 0x18 开始
    int32_t      result;      // +0x18
    uint8_t      errMsg[];    // +0x20: QQ 内部字符串 (errMsg)
    uint8_t      rspbuffer[]; // +0x38: QQ 内部字符串 (响应二进制)
};
```

### 3.3 FetchRkey 协议

**命令**：`OidbSvcTrpcTcp.0x9067_202`

**请求 Body**（编码后的十六进制样本）：

```
08e7a00210ca01221c0a130a05080110ca011206a80602b006011a02080222050a030a14026001
```

**请求字段**（Protobuf）：

```protobuf
message FetchRkeyRequest {
    MultiMediaRequestHead request_head = 1;
    DownloadRkeyRequest   download_rkey = 4;
}

message DownloadRkeyRequest {
    repeated int32 types = 1;  // 10=私聊, 20=群聊, 2=其他
}
```

**响应**：

```protobuf
message FetchRkeyResponse {
    RkeyData data = 4;
}

message RkeyData {
    repeated RkeyInfo rkeys = 1;
}

message RkeyInfo {
    string rkey = 1;
    uint64 ttl = 2;
    uint32 created_at = 4;
    uint32 kind = 5;  // 10=私聊, 20=群聊
}
```

---

## 4. 动态定位链

所有定位均在 `locator.rs` 中实现，**不依赖硬编码 RVA**。

### 4.1 安全快照

为避免直接扫描 `wrapper.node` 内存时访问到 `PAGE_NOACCESS/PAGE_GUARD` 页面导致 QQ 崩溃，必须通过 `VirtualQuery` 遍历并仅复制可读页面：

```rust
// 仅复制满足以下条件的区域：
// - State == MEM_COMMIT
// - Protect 可读 (PAGE_READONLY / PAGE_READWRITE / PAGE_EXECUTE_READ 等)
// - 不含 PAGE_GUARD 或 PAGE_NOACCESS
```

### 4.2 send wrapper 定位

1. **anchor 字符串**：  
   `assertion (argc == 2) failed: NodeIKernelMsgService::sendSsoCmdReqByContend needs 2 arguments`

2. 在 `.rdata` 中查找该字符串，得到 anchor RVA。

3. 在 `.text` 中查找 RIP-relative `lea` 指令 xref（`4x 8d 05 ...`），找到引用 anchor 的指令 RVA。

4. 用 `.pdata` 中的 RuntimeFunction 表，找到包含该 xref 的函数的起始 RVA —— 即 `sendSsoCmdReqByContend` wrapper。

### 4.3 converter 定位

在 send wrapper 内查找相邻的两条 `call` 指令，它们调用同一个目标，且相距 8~32 字节。该目标即为参数转换函数（`sub_180bddf8f`）。

### 4.4 response callback 定位

从 send wrapper 出发，沿以下调用链定位响应回调：

1. **promise helper**：send wrapper 内，在 converter 调用之后的 `call`，目标是一个独立的函数（如 `sub_180f9affb`）。

2. **constructor**：promise helper 内调用的函数（如 `sub_180fc7a5b`），它负责创建响应对象。

3. **callback table**：在 constructor 中，查找 RIP-relative `lea` 指令，目标落在 `.rdata` 段。该地址指向一个 vtable/回调表。

4. **callback entry**：从回调表的 `+8` 位置读取 64 位指针，减去模块基址得到 callback entry RVA。

5. **dispatcher**：在 callback entry 中查找 `call` 指令，目标函数为 dispatcher。

6. **thunk**：在 dispatcher 中查找 RIP-relative `lea`，目标为 thunk 地址。该 thunk 模式为 `48 8b 09 e9 <rel32>`（`mov rcx, [rcx]; jmp`）。

7. **response callback**：解析 thunk 中的 `jmp` 目标，即实际响应回调函数。

---

## 5. Hook 实现细节

### 5.1 Send Converter Hook

**目标**：`sub_180bddf8f`（或动态定位的等效函数）

**行为**：

1. 检查传入的 `napi_value` 是否为 Buffer（`napi_is_buffer`）。
2. 若是 Buffer，取数据和长度（`napi_get_buffer_info`）。
3. 构造一个同长度的 ASCII 字符串占位，交给原转换函数分配内部字符串。
4. 用 Buffer 原始字节覆盖内部字符串的数据区域。

**关键约束**：必须使用原转换函数来分配内部字符串对象，以确保内存由 QQNT 自身管理。

### 5.2 Response Callback Hook

**目标**：动态定位的 response callback（如 `0x237b2f1`）

**行为**：

1. 从 `task + 0x10` 读取 SharedState，从中取出 `napi_env` 和 `napi_deferred`。
2. 从 `task + 0x18` 读取 `result` 字段（int32）。
3. 从 `task + 0x20` 读取 `errMsg` 内部字符串 → 转为 JS string。
4. 从 `task + 0x38` 读取 `rspbuffer` 内部字符串 → 转为 Node Buffer（`napi_create_buffer_copy`）。
5. 构造 `{ result, errMsg, rspbuffer }` 对象，resolve Promise。

**长度上限**：

```rust
const MAX_RESPONSE_BYTES: usize = 16 * 1024 * 1024;
const MAX_ERROR_BYTES: usize = 1024 * 1024;
```

超过上限时放弃 hook，交由原回调处理。

---

## 6. 失效排查流程

### 6.1 快速诊断

| 现象 | 可能原因 | 检查步骤 |
|------|----------|----------|
| QQ 启动崩溃 | `VirtualQuery` 快照失败或读取到非法区域 | 检查 `snapshot_readable_image` 日志，确认没有 `PAGE_NOACCESS` 被读入 |
| 发包返回 `result=145` | send converter hook 未生效 | 检查日志是否输出 `QQNT packet hook installed`；确认 `converterRva` 非零 |
| 发包返回 `result=0, bytes=0` | response callback hook 未命中 | 检查日志中的 `responseRva`；确认原 callback 是否被调用 |
| 直链返回 404 | RKey 解码失败或 URL appid 选择错误 | 检查 `QQ packet response` 日志中 `bytes` 是否 > 0；检查 `rspbuffer` 能否正常解码 |
| CDN 返回 403 | RKey 过期或类型错误 | 检查 TTL 和 kind 是否匹配（私聊 10，群聊 20） |

### 6.2 升级后定位更新流程

当 QQ 升级后，按以下步骤更新定位规则：

#### Step 1: 获取新 wrapper.node

```powershell
# 找到新版本目录
Get-ChildItem "Y:\Program Files\Tencent\QQNT\versions" -Directory | Sort-Object LastWriteTime

# 备份当前 .bndb
Copy-Item "Y:\Program Files\Tencent\QQNT\versions\9.9.33-51552\resources\app\wrapper.node.bndb" .\wrapper.node.backup.bndb

# 拷贝新 wrapper.node 到分析目录
Copy-Item "Y:\Program Files\Tencent\QQNT\versions\<新版>\resources\app\wrapper.node" .\wrapper.node.new
```

#### Step 2: 用 Binary Ninja 打开新文件

- 若已有 `.bndb`，可尝试复用（若分析失败则重新创建）。
- 确保 `.rdata`、`.text`、`.pdata` 段已加载且函数分析完成。

#### Step 3: 验证 send wrapper

在 Binary Ninja 中搜索字符串：

```
assertion (argc == 2) failed: NodeIKernelMsgService::sendSsoCmdReqByContend needs 2 arguments
```

找到该字符串后：

1. 查看 `xrefs`，找到 RIP-relative 引用。
2. 该引用所在函数即为新的 send wrapper。
3. 记录其起始 RVA。

#### Step 4: 验证 converter

在 send wrapper 中：

1. 找到相邻的两个 `call` 指令，它们调用同一目标，间距 8~32 字节。
2. 该目标即为新的 converter 函数。
3. 验证其逻辑：应包含对 `napi_coerce_to_string` 或同类转换的调用。

#### Step 5: 追踪 response callback

1. 在 send wrapper 中找到 converter 调用之后的 `call`，该目标为 promise helper。
2. 在 promise helper 中找到 `call`，目标为 constructor。
3. 在 constructor 中找 `lea` 到 `.rdata` 的指令，目标为 callback table。
4. 从 callback table `+8` 读取指针，得到 callback entry。
5. 在 callback entry 中找 `call`，目标为 dispatcher。
6. 在 dispatcher 中找 `lea` 到某个 thunk，thunk 模式为 `48 8b 09 e9 <rel32>`。
7. 解析 `jmp` 目标，得到 response callback。

#### Step 6: 用 Frida 验证（可选）

```javascript
// attach 到 QQ.exe 后
var wrapper = Process.findModuleByName("wrapper.node");
console.log("base: " + wrapper.base);

// 验证 send wrapper 偏移
var sendWrapper = wrapper.base.add(<新RVA>);
Interceptor.attach(sendWrapper, {
    onEnter: function(args) {
        console.log("sendSsoCmdReqByContend called");
        console.log("arg0: " + args[0]);
        console.log("arg1: " + args[1]);
    }
});

// 验证 response callback
var responseCb = wrapper.base.add(<responseRva>);
Interceptor.attach(responseCb, {
    onEnter: function(args) {
        console.log("response callback called, task=" + args[0]);
    }
});
```

#### Step 7: 更新定位规则（如有必要）

若定位器无法自动匹配新版本：

- 检查 `first_nearby_repeated_call_target` 的 call 间距阈值是否需要调整（当前 8~32 字节）。
- 检查 `response_callback_from_send_wrapper` 中 promise helper 的查找边界（当前 0x1000）。
- 检查 `indirect_rcx_jump_target` 的 thunk 模式是否发生变化。

#### Step 8: 回归验证

```powershell
# 运行 Rust 单元测试
cargo test --manifest-path native/packet-addon/Cargo.toml

# 运行 TS 单元测试
pnpm exec vitest run src/packet-client.test.ts

# 启动 QQ 后运行 live e2e
$env:QQNT_BRIDGE_E2E='1'
pnpm exec vitest run src/e2e.test.ts -t "refreshes a QQ image RKey"
```

---

## 7. 诊断基线（当前 9.9.33-51552）

| 名称 | RVA | 说明 |
|------|-----|------|
| send wrapper | `0xf9ad18` | `sendSsoCmdReqByContend` |
| anchor 字符串 | `0x468f5ad` | 断言字符串 |
| converter | `0xbddf8f` | 参数转换函数 |
| promise helper | `0xf9affb` | send wrapper 后调用的 helper |
| constructor | `0xfc7a5b` | 创建响应对象 |
| callback table | `0x4007968` | `.rdata` 中的回调表 |
| callback entry | `0x237b064` | 回调入口 |
| dispatcher | `0x237b1cc` | 回调分发 |
| thunk | `0x237b5a0` | `48 8b 09 e9` thunk |
| response callback | `0x237b2f1` | 实际响应回调 |

**注意**：以上 RVA 仅用于诊断对照，**不能**作为硬编码逻辑。定位器应始终保持动态推导。

---

## 8. 安全规则

1. **只读内存快照**：必须通过 `VirtualQuery` 过滤可读页面，禁止直接对 `wrapper.node` 做 `slice`。
2. **Hook 失败即关闭下载**：若 `installSendHook` 抛出异常，`QQPacketClient` 应返回 `undefined`；上层不得回退到 `downloadRichMedia` 本地落盘。
3. **长度上限**：响应字节和错误消息必须有长度上限，防止恶意/异常回包导致 OOM。
4. **替换 `.node` 前先结束 QQ**：`start.ps1` 已包含 `Stop-Process -Name QQ`，避免 `EBUSY`。
5. **测试隔离**：Rust 单测和 TS 单元测试均使用 mock，不依赖真实 QQ。

---

## 9. 常用验证命令

```powershell
# 检查 bridge 状态
curl.exe http://127.0.0.1:18767/v1/status

# 触发直链请求（真实图片）
node -e "
fetch('http://127.0.0.1:18767/v1/files/direct-url', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    messageId: '7666383158988150809',
    elementId: '7666383158988150808',
    chatType: 2,
    peerUid: '1002974327',
    kind: 'image',
    fileName: 'A1A07C530F47B8C3946C881C509D4C22.jpg',
    fileSize: '164882',
    fileUuid: '',
    originImageUrl: '/download?appid=1407&fileid=EhSduvhPaULWrCWdqKW-X9MN8t6jsxiSiAog_wooqYPctLftlQMyBHByb2RQgL2jAVoQ5faoiM59PRBAPHo86fwa43oCYReCAQJuag&spec=0'
  })
}).then(r => r.json()).then(console.log)
"

# 查看 hook 日志
Get-Content -LiteralPath 'Y:\Users\<user>\AppData\Local\qqnt-bridge\qqnt-bridge.log' -Tail 100 | Select-String -Pattern "hook|packet|direct-url"
```

---

## 10. 相关文件路径

| 文件 | 路径 |
|------|------|
| 定位器 | `D:\qqnt-bridge\native\packet-addon\src\locator.rs` |
| Hook 实现 | `D:\qqnt-bridge\native\packet-addon\src\hook.rs` |
| PE 解析 | `D:\qqnt-bridge\native\packet-addon\src\pe.rs` |
| 协议编解码 | `D:\qqnt-bridge\native\packet-addon\src\proto.rs` |
| TypeScript 客户端 | `D:\qqnt-bridge\src\packet-client.ts` |
| Live e2e | `D:\qqnt-bridge\src\e2e.test.ts` |
| 启动脚本 | `D:\qqnt-bridge\start.ps1` |
| QQ wrapper | `Y:\Program Files\Tencent\QQNT\versions\9.9.33-51552\resources\app\wrapper.node` |
| QQ 主程序 | `Y:\Program Files\Tencent\QQNT\QQ.exe` |
| Bridge 日志 | `Y:\Users\<user>\AppData\Local\qqnt-bridge\qqnt-bridge.log` |

---

## 11. 维护记录

| 日期 | 版本 | 变更说明 |
|------|------|----------|
| 2026-07-25 | 9.9.33-51552 | 初始文档，基于当前实现记录 |
