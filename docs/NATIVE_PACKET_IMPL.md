# QQNT 原生发包、直传与直链技术文档

本文记录 `qqnt-bridge` 中原生 SSO/OIDB 发包（`sendSsoCmdReqByContend` Hook）、RKey 刷新、媒体直链与 Highway 协议直传的实现原理及 QQ 升级后的排障方法。

---

## 1. 架构概览

```text
TypeScript 层 (src/packet-client.ts, src/upload-protocol.ts)
  ├── getImageUrl() / fetchRkeys()   ──► OidbSvcTrpcTcp.0x9067_202 (刷新私聊/群聊 RKey)
  ├── sendPoke()                     ──► OidbSvcTrpcTcp.0xED3_1 (戳一戳)
  └── Highway 直传 / 闪传协议         ──► 0x11c4/0x11c5, 0x6d6_0, 0xe37_1700, HttpConn.0x6ff_501
         │
         ▼ N-API (native/packet-addon)
Rust 原生插件 (qqnt_packet.*.node)
  ├── locator.rs : 扫描 wrapper.node 只读页，通过断言字符串 XRef 动态定位函数（无硬编码 RVA）
  ├── hook.rs    : Hook 参数转换器（保留 Buffer 二进制）与响应回调（提取 rspbuffer）
  └── proto.rs   : OIDB 信封与 Protobuf 编解码
```

---

## 2. 核心协议与内存布局

### 2.1 媒体协议直传与闪传

- **普通图片/文件直传**：根据预检提供的 MD5、SHA-1 与前 10 MiB MD5，先通过 `0x11c4/0x11c5`（图片）、`0x6d6_0`（群文件）或 `0xe37_1700`（私聊文件）申请上传，再通过 `HttpConn.0x6ff_501` 获取 Highway Ticket，按 1 MiB 分块直传，最后通过 `MessageSvc.PbSendMsg` 发送，全程不落盘临时文件。
- **QQ 闪传**：通过 `0x93cf/0x93d0/0x93db` 创建文件集，已有 QQ 媒体直接复用远端哈希走 `0x12a9_100` 秒传，新上传文件走 `sliceupload` 分片上传，最后通过 `0x12a9_103` 与 `0x93d1_1` 完成文件集并获取分享链接。

### 2.2 QQNT 内部字符串布局（`wrapper.node`）

`wrapper.node` 中的内部字符串（错误消息、响应二进制 `rspbuffer`）采用 SSO（短字符串优化）布局：

```cpp
// 短字符串 (tag 最低位为 0，长度为 tag >> 1)
struct ShortString {
    uintptr_t tag;
    uint8_t   data[];
};

// 堆字符串 (tag 最低位为 1)
struct HeapString {
    uintptr_t tag;
    uintptr_t length; // +0x08
    uint8_t*  data;   // +0x10
};
```

### 2.3 响应回调 Task 布局

`sendSsoCmdReqByContend` 的异步回调上下文 `task` 指针布局：

```cpp
struct ResponseTask {
    uint8_t padding[0x10];
    void*   state;        // +0x10 -> SharedState (+0x18: napi_env, +0x20: napi_deferred)
    int32_t result;       // +0x18
    uint8_t errMsg[];     // +0x20 (QQ 内部字符串)
    uint8_t rspbuffer[];  // +0x38 (QQ 内部字符串，响应原始字节)
};
```

### 2.4 FetchRkey（`OidbSvcTrpcTcp.0x9067_202`）

```protobuf
message FetchRkeyRequest {
    MultiMediaRequestHead request_head = 1;
    DownloadRkeyRequest   download_rkey = 4; // types: 10=私聊, 20=群聊, 2=其他
}

message RkeyInfo {
    string rkey = 1;
    uint64 ttl = 2;
    uint32 created_at = 4;
    uint32 kind = 5; // 10=私聊, 20=群聊
}
```

### 2.5 戳一戳（`OidbSvcTrpcTcp.0xED3_1`）

```protobuf
message PokeRequest {
    uint32 uin = 1;        // 被戳 QQ 号
    uint32 group_uin = 2;  // 群戳填群号，私聊填 0
    uint32 friend_uin = 5; // 私聊填好友 QQ 号，群戳填 0
    uint32 ext = 6;        // 固定为 0
}
```

---

## 3. 动态定位链（`locator.rs` / `elf.rs` / `pe.rs`）

定位器在内存只读快照上根据特征自动推导目标函数地址，**不依赖硬编码 RVA**：

1. **安全内存快照**：Windows 下通过 `VirtualQuery`（Linux 下解析 ELF 段）仅拷贝已提交的可读内存页，跳过 `PAGE_NOACCESS` / `PAGE_GUARD` 防止崩溃。
2. **定位 Send Wrapper**：在只读数据段搜索断言字符串 `assertion (argc == 2) failed: NodeIKernelMsgService::sendSsoCmdReqByContend needs 2 arguments`，通过代码段 RIP-relative `lea` 交叉引用与函数帧表（`.pdata` / `.eh_frame`）反推外层函数起点。
3. **定位 Converter**：在 Send Wrapper 内寻找间距 8~32 字节、调用同一目标函数的两条相邻 `call`，目标即为参数转换函数。
4. **定位 Response Callback**：从 Send Wrapper 内 Converter 之后的 `call`（Promise Helper）→ Constructor → `.rdata` 回调虚表 → 分发器 Thunk，最终定位到解析 `result`/`errMsg`/`rspbuffer` 的响应回调函数。

---

## 4. Hook 行为（`hook.rs`）

- **Send Converter Hook**：当传入参数是 Node `Buffer` 时，先构造等长 ASCII 占位字符串交由原函数分配 QQ 内部字符串内存，再将 `Buffer` 原始二进制字节覆写进去，避免 UTF-8 编码损坏 Protobuf 二进制数据。
- **Response Callback Hook**：直接从 `task` 结构体读取 `result`、`errMsg` 与 `rspbuffer`（限制最大响应 16 MiB），封装为 `{ result, errMsg, rspbuffer: Buffer }` 并 Resolve Promise。

---

## 5. 故障排查

| 现象 | 常见原因 | 排查方式 |
|---|---|---|
| QQ 启动即崩溃 | 内存快照读到了不可访问页 | 检查 `snapshot_readable_image` 与段权限过滤 |
| 发包返回 `result=145` | Send Converter Hook 未命中，二进制被当成 UTF-8 破坏 | 检查日志 `QQNT packet hook installed` 及 `converterRva` |
| 发包返回 `result=0, bytes=0` | Response Callback Hook 未命中 | 检查 `responseRva` 定位结果 |
| `/v1/files/direct-url` 返回 404 | RKey 刷新失败或 `appid` 不匹配 | 检查 `QQ packet response` 的 `rspbuffer` 长度与解码结果 |

验证命令：

```sh
cargo test --manifest-path native/packet-addon/Cargo.toml
pnpm exec vitest run src/packet-client.test.ts
```
