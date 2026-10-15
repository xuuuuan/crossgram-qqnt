# QQNT 原生语音通话控制面逆向记录

本文记录 QQNT 原生语音通话（AVSDK / QRTC）控制面的静态分析结论与设计约束。语音通话控制必须通过原生层实现，禁止依赖 GUI 自动化或窗口模拟点击。

## 1. Linux 样本基线

| 组件 | 路径 | Build ID |
|---|---|---|
| QQNT Wrapper | `/opt/QQ/resources/app/wrapper.node` | `7e05de9b6882bf5d` |
| AVSDK Plugin | `/opt/QQ/resources/app/avsdk/libAVSDKPlugin.so` | `d6159b6701b46683` |

> 以下虚拟地址（VA）与结构体偏移仅对应上述 Build ID，跨版本或跨平台（Windows PE）不可直接复用。

## 2. JS 层 `KernelAVSDKService` 桥接边界

| 方法 / 组件 | 作用 |
|---|---|
| `session.getAVSDKService?()` | 获取原生 AVSDK 服务实例 |
| `addKernelAVSDKListener()` / `removeKernelAVSDKListener()` | 注册/移除底层监听器 |
| `setActionFromAVSDK()` | 原生状态动作入口，透传调用，不拦截或篡改参数 |
| `listener-tee.ts` | 保持 QQ 自身监听器为唯一原生注册，在 JS 层向 Bridge 扇出来电事件 |

## 3. `libAVSDKPlugin.so` 静态符号与偏移映射

### 3.1 `QRTCServiceInterfaceWrapper` 符号表

| 符号 | Linux VA | 相对 vtable 槽 |
|---|---:|---|
| constructor | `0x53ef80` | — |
| destructor | `0x53f840` | — |
| `StartCall` | `0x545c40` | `+0x40` |
| `Accept` | `0x54c0a0` | `+0x48` |
| `Invite` | `0x54caf0` | `+0x58` |
| `Reject` | `0x54d360` | `+0x68` |
| `Close` | `0x54d6d0` | `+0x70` |
| `OnReceiveInvite` | `0x52f500` | — |
| `OnPeerReject` | `0x533070` | — |
| `OnPeerCancelInvite` | `0x533220` | — |
| `OnPeerAccept` | `0x533360` | — |
| `OnChatClosed` | `0x533ac0` | — |

### 3.2 单例与对象关系

| 项目 | 位置 | 说明 |
|---|---|---|
| Wrapper 单例存储 | global `0x1413a18` | `QRTCServiceInterfaceWrapper::GetInstance()` |
| QRTC Service 单例指针 | global `0x1416438` | `qav::service_interface::g_QRTCService` |
| Wrapper → Service 指针 | `wrapper + 0x260` | 指向 `qav::service_interface::QRTCService` |
| Service 工厂 / 构造 / vtable | `0x782830` / `0x7828b0` / `0x13ca440` | `GetQRTCInstance()` 及 `QRTCService` 构造与虚表 |
| Service 析构与销毁 | `0x7835c0` / `0x783a10` / `0x782880` | 析构函数与 `DestroyQRTCInstance()` |
| `QRTCRecvInviteInfo` | `+0x38` (sub-business), `+0x48` (original) | 栈上临时对象，严禁跨回调帧保存指针 |

## 4. 控制层约束

- **对象与线程安全**：底层 `CallCpp` 直接读取裸单例与裸回调指针，无内置跨线程队列或析构屏障；任何原生控制调用必须验证活动 `this` 指针与所属线程。
- **不透明上下文**：通话上下文仅作为不透明句柄持有，不持久化敏感身份信息。
- **关联源码**：`src/main.ts`、`src/kernel-types.ts`、`src/listener-tee.ts`、`src/qq-kernel.ts`。
