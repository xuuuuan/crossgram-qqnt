# Native Voice Call 跨平台逆向记录

## 目的、非目标与边界

本文记录 QQNT 原生语音通话控制面的可复现证据、假设和未知项，供 Linux 与 Windows 的同一实现目标交叉验证。最终架构必须通过 native control adapter 驱动原生控制面；**禁止以 GUI 自动化、模拟点击、窗口注入或依赖可见界面作为实现路径**。

本文不记录、也不尝试推导媒体内容、信令内容、账户或联系人身份资料。本文不是运行时探针操作手册，也不证明任一未列明的参数、返回值或生命周期结论。

## 隐私与安全红线

- 不采集、不写入、不提交账户标识、用户标识、关系标识、通话标识、房间标识或会话标识。
- 不保留原始 action/native bytes、payload、媒体、密钥、令牌、摘要或可逆序列化数据。
- 不把原生回调参数、内存内容、网络内容或崩溃转储写入日志或本文件。
- 任何运行时观测仅可使用下文定义的 metadata-only probe；不能为补齐参数语义而扩大采集范围。
- 发现意外敏感数据时，停止记录该数据，按项目安全流程处置；不得复制到 issue、提交信息、测试夹具或文档。

## Linux 样本身份与适用范围

| 组件 | 位置 | Build ID |
| --- | --- | --- |
| QQNT wrapper | `/opt/QQ/resources/app/wrapper.node` | `7e05de9b6882bf5d` |
| AVSDK plugin | `/opt/QQ/resources/app/avsdk/libAVSDKPlugin.so` | `d6159b6701b46683` |

以下 Linux VA 只对上表这对样本有效。它们不是跨版本契约、不是加载时绝对位置，也不能用于 Windows 样本。每次更换 QQNT 或 plugin，都必须重新固定身份并重新交叉验证。

## 证据分层

### Confirmed

- 上述两个 Linux Build ID 已只读核对。
- `libAVSDKPlugin.so` 的已导出符号包含 `QRTCServiceInterfaceWrapper` 的构造、析构、控制方法和回调方法；其 VA 与下表一致。
- 当前 TypeScript `KernelAVSDKService` 的受限桥接表面为 `addKernelAVSDKListener`、`removeKernelAVSDKListener` 与原生 `setActionFromAVSDK`；`KernelSession.getAVSDKService` 为可选入口。
- `wrapSession()` 缓存 AVSDK facade；监听器通过 `teeAVSDKService()` 复用既有 listener tee。
- bridge 不拦截、不观察或序列化 `setActionFromAVSDK` 的参数、返回值或异常；该原生方法保持原样调用。
- listener tee 保持 QQ 自身 listener 为唯一 native 注册，并在 JavaScript 层向 bridge tap 扇出受限的来电状态投影。
- 在本 Linux 样本的 wrapper 路径中，候选 QRTC service 从 wrapper receiver 的 `+0x260` 存储位置取得；该偏移只适用于本节列出的 Build ID。
- 该 service 的取得路径包含 singleton/getter、wrapper 持有的 storage 与 destructor 证据；这些证据只证明对象取得和清理路径，不能证明任一控制方法可安全调用。
- wrapper 与原生控制层之间存在 selector 驱动的 `CallCpp` 调度边界；已核对该边界的调用 ABI。selector 和 ABI 仅可用于在同一固定样本中辨认既有调用路径，不能作为新控制调用的参数契约。selector/signature 观察不证明 `0x4e26→5/9/10` 的业务策略，也不授权构造任何新调用。
- Task #70 已确认 `StartCall` JSON 的**有界核心字段类别/默认值**和 **parse→Request 路由**。完整 schema、枚举域、嵌套分支、所有权、语义范围及安全调用仍属未知；这些已确认事实不授权构造或执行调用。
- Task #84 已确认 registration 保存 raw callback、`CallCpp` 直接解析 raw singleton、PPP shutdown 仅做 key cleanup，且 service destruction 是独立路径。未建立 queue-post、owner-thread、in-flight admission、cancel 或 drain barrier；该结论不证明安全调用，live control 保持禁用。
- `QRTCRecvInviteInfo` 在已核对的 invite 路径中有 `+0x38` 的 sub-business 字段和 `+0x48` 的 original 字段。字段内容未记录，且两者均按 opaque metadata 处理。
- invite 路径中的 `QRTCRecvInviteInfo` 是栈上临时对象；其有效期不跨越当前处理帧，不能保存对象地址、借用其字段或在回调返回后使用它。

### Inferred

- `QRTCServiceInterfaceWrapper` 是 Linux 样本中候选的原生控制对象；方法名和相对 vtable 槽说明其覆盖发起、接受、邀请、拒绝和关闭等控制路径。
- 原生控制需要持有活动 `this` 与 opaque call context；不能把任一符号当成无状态 C 函数调用。
- `CallCpp` selector 可作为既有 wrapper 调度路径的辨认锚点，但 selector 到控制操作的完整映射和每个分支的参数语义仍未证明。
- 回调可用于状态门禁与清理，但回调顺序、线程模型、对象所有权以及重入规则尚未证明。

### 当前未知

| 项目 | 现状 | 处理边界 |
| --- | --- | --- |
| `StartCall` JSON | #70 已确认有界核心字段类别/默认值和 parse→Request 路由；完整 schema、枚举域、嵌套分支、所有权、语义范围及安全调用仍属未知 | 不构造、不记录、不猜测 JSON；live control 保持禁用。 |
| 各控制方法参数 | 完整参数语义、可空性、字符串/数组所有权未知 | 不把符号名、selector 或 `CallCpp` ABI 当作参数契约。 |
| `CallCpp` selector 映射 | selector 与每个控制操作、分支参数及错误语义的完整对应关系未知 | 不以已知 selector 构造新的派发调用。 |
| QQ PPP host 与最终 DSO | 已辨认 QQ PPP host 参与既有调用链；承载最终原生控制实现的 DSO 尚未独立确认 | 不把 host 归属等同于实现 DSO 归属；先固定模块身份和加载关系。 |
| host 线程与生命周期 | #84 只确认 registration 保存 raw callback、`CallCpp` 直接解析 raw singleton、PPP shutdown 仅做 key cleanup，且 service destruction 是独立路径；未建立 queue-post、owner-thread、in-flight admission、cancel 或 drain barrier | 不跨线程复用 receiver 或 context；不得把缺失的屏障当作已存在。live control 保持禁用。 |
| 返回值与错误模型 | 状态码、异常边界、同步/异步完成语义未知 | adapter 必须显式报告不支持，而不是伪造成功。 |
| call context 生命周期 | 创建者、销毁者、失效时机未知 | context 仅作为 opaque 值持有，不解码或持久化。 |
| invite info 生命周期 | `QRTCRecvInviteInfo` 在当前 invite 处理帧外是否有独立所有者未知；已知栈上临时实例不可逃逸 | 仅在当前帧中读取必要的受限 metadata；回调返回前撤销所有借用。 |
| 回调与控制的因果关系 | 回调是否恰好确认某次控制调用未知 | 状态门禁不得仅依赖名称相似性。 |

## JS `KernelAVSDKService` 观察表面

| 表面 | 当前代码中的作用 | 证据级别 |
| --- | --- | --- |
| `getAVSDKService?()` | 从 session 取得可选原生 AVSDK service | Confirmed |
| `addKernelAVSDKListener()` | 注册唯一的原生 listener | Confirmed |
| `removeKernelAVSDKListener()` | 移除已注册 listener | Confirmed |
| `setActionFromAVSDK()` | 保持原生调用；bridge 不拦截、观察或序列化其数据 | Confirmed |
| listener tee | 原生单注册、JavaScript 多 tap 扇出 | Confirmed |

这里的表面是观察与桥接边界，不是 native control adapter 的实现接口。不得据此假设它能构造、接受或关闭原生通话。

## QRTC 控制符号表

| 符号 | Linux VA | 相对 vtable 槽 | 分层 |
| --- | ---: | --- | --- |
| constructor | `0x53ef80` | — | Confirmed |
| destructor | `0x53f840` | — | Confirmed |
| `StartCall` | `0x545c40` | `+0x40` | Confirmed |
| `Accept` | `0x54c0a0` | `+0x48` | Confirmed |
| `Invite` | `0x54caf0` | `+0x58` | Confirmed |
| `Reject` | `0x54d360` | `+0x68` | Confirmed |
| `Close` | `0x54d6d0` | `+0x70` | Confirmed |
| `OnReceiveInvite` | `0x52f500` | — | Confirmed |
| `OnPeerReject` | `0x533070` | — | Confirmed |
| `OnPeerCancelInvite` | `0x533220` | — | Confirmed |
| `OnPeerAccept` | `0x533360` | — | Confirmed |
| `OnChatClosed` | `0x533ac0` | — | Confirmed |

此表仅记录 Task #66 已确认的符号定位。除本节为复现所必需的 Linux VA 外，不记录任何运行时内存位置。方法名称和槽位不能单独证明参数语义、成功条件或资源所有权。

## 当前参数语义

- Task #70 已确认 `StartCall` JSON 的有界核心字段类别/默认值和 parse→Request 路由；完整 schema、枚举域、嵌套分支、所有权、语义范围及安全调用仍属未知。不得构造、记录、猜测或执行调用；live control 保持禁用。
- `Accept`、`Invite`、`Reject`、`Close` 的参数语义当前未知。
- constructor/destructor 的对象初始化与销毁前置条件当前未知。
- 回调参数的类型、寿命与线程归属当前未知。

## Native control adapter 设计约束

native control adapter 应是独立的、显式失败的控制层，且满足以下约束：

1. **活动 `this`**：只从经验证的活动原生对象取得 receiver；不得临时构造、复制或以空 receiver 调用虚方法。
2. **opaque call context**：将通话上下文作为不可解码、不可序列化、不可记录的 opaque handle；不得从其中提取或保存身份资料。
3. **状态门禁**：每个控制请求必须经过受证据支持的状态转换门禁。未知状态、重复状态、过期 context 或并发 context 一律拒绝。
4. **清理**：终止、析构、session 失效或 adapter 关闭时，撤销本地 handle、取消待处理工作并停止 metadata-only probe；清理必须幂等。
5. **失败语义**：未验证的参数、对象、状态或平台 parity 只能返回“不支持/未验证”；不得回退到 GUI，也不得猜测调用约定。
6. **隔离**：adapter 失败不得改变现有 JS listener、未拦截的 native action 调用或媒体路径。
7. **live control 禁用**：在参数、线程归属、工作准入和销毁屏障均有独立证据前，所有 live control 入口必须保持禁用；不得拨号、接听、邀请、拒绝或关闭。

## #84 Host lifecycle 结论

以下为 #84 对既有 host 路径的最终结论：

- registration 保存 **raw callback**。
- `CallCpp` 直接解析 **raw singleton**。
- 未建立 queue-post、owner-thread、in-flight admission、cancel 或 drain barrier。
- PPP shutdown 只执行 key cleanup；service destruction 是独立的生命周期路径。

这些观察不构成跨线程或销毁期间调用的安全性证明，也不补足参数语义、对象所有权或控制准入条件。因此，在新增独立证据前，live control 保持禁用。

## Metadata-only probe

允许的记录字段必须同时满足“不可还原敏感内容”和“对状态验证必要”：

| 允许 | 禁止 |
| --- | --- |
| 样本 Build ID、模块文件名、平台、架构 | 账户、用户、关系、通话、房间或会话标识及其派生值 |
| callback 名称或受控枚举、来源类别、时间顺序号 | 原始 callback 参数、原始 action/native bytes、payload、媒体内容 |
| 参数数量、参数类型类别、二进制长度、截断布尔值 | 内容片段、字符串内容、序列化结果、摘要、token、密钥 |
| identifier-free probe：`same_thread` 布尔值、`in_flight` 整数、状态 `active`/`closing`/`destroyed` | 任何账户、用户、关系、通话、房间或会话标识，及可将这些状态关联至特定对象的值 |
| adapter 状态类别、允许/拒绝结果类别、清理是否执行 | 内存转储、指针值、运行时内存位置、网络内容 |

该 identifier-free probe 仅记录上述布尔值、整数和受控状态；不得附加 callback、singleton、service 或任一对象的标识符。probe 只用于验证对象生命周期、状态门禁和跨平台 parity；不得用于恢复协议或内容。live control 在证据补齐前保持禁用。

## 已有证据的复现边界

以下流程用于在固定样本上复核已经记录的对象与 ABI 证据。它不包含拨号、接听、邀请、拒绝、关闭、注入新调用或运行时内容采集。

### Linux

1. 仅对“Linux 样本身份与适用范围”中的两个 Build ID 复核 wrapper 与 AVSDK plugin 的身份；Build ID 不一致即停止，不复用本文件的 VA 或偏移。
2. 从既有 wrapper 调用链复核 `+0x260` service storage、singleton/getter、storage 和 destructor 的对象关系。记录结论类别，不记录对象地址或对象内容。
3. 复核 QQ PPP host 位于既有路径中，同时将最终控制实现 DSO 保持为未知，直到模块身份和加载关系有独立证据。
4. 以既有调用点复核 selector 与 `CallCpp` ABI 的匹配；只比较既有 receiver、调用约定和调度形状，不构造 selector、参数或新的 `CallCpp` 调用。
5. 在既有 invite 处理路径中复核 `QRTCRecvInviteInfo` 的 `+0x38` 与 `+0x48` 字段位置，以及栈上临时对象的帧内有效期。不得读取、保存或输出字段内容、地址或任何派生值。
6. 将 host 线程/队列、完整生命周期、完整 `StartCall` JSON schema 及其余控制参数继续标为未知；#70 已确认的有界核心字段类别/默认值和 parse→Request 路由不缩小这些边界。#84 未建立的 queue-post、owner-thread、in-flight admission、cancel 或 drain barrier 不能视为存在；live control 保持禁用。

### Windows

1. 固定目标 QQNT 版本并记录 `wrapper.node` 与 AVSDK DLL 的 PE hash、PDB/signature 信息、文件名、平台和架构；这些身份信息不得包含账户或会话资料。
2. 重新确认 wrapper、QQ PPP host（如存在）和候选 AVSDK DLL 的加载关系。Linux 的 `+0x260`、VA、DSO 归属、selector 映射和 ABI 不能直接移植。
3. 在 Windows 样本中独立复核 candidate 的对象获取/析构、selector 调度和调用 ABI，并单独确认最终 DSO。host 的存在不构成 DSO 归属证据。
4. 只有当 `QRTCRecvInviteInfo` 的布局与帧内生命周期在 Windows 样本中独立成立时，才可记录 Windows 结论；不得依据 Linux 偏移推断字段位置或保留 invite 对象。
5. 继续将 host 线程/生命周期、完整 `StartCall` JSON schema 与控制参数视为未验证；#70 已确认的有界核心字段类别/默认值和 parse→Request 路由不构成 Windows 证据。#84 的 host lifecycle 结论也不构成 Windows 证据。Windows 复核不得启动通话或采集任何内容；live control 保持禁用。

## Windows 复现流程

1. 固定目标 QQNT 版本，记录 `wrapper.node` 与 AVSDK DLL 的 PE hash、PDB/signature 信息、文件名、平台和架构。
2. 在该固定样本中识别 `wrapper.node` 与 AVSDK DLL；先确认加载关系，再开始静态交叉验证。
3. 以日志字符串、控制流和 vtable 相对槽为锚点搜索候选，不复用 Linux 绝对地址。
4. 不假设 Itanium mangling；Windows 符号、RTTI 和导出形式必须按 MSVC 工具链重新判定。
5. 按 MSVC x64 calling convention 审计 candidate 的 receiver、寄存器参数、stack/shadow space、返回约定和异常边界；不能把 Linux ABI 结论移植过去。
6. 将 ASLR 视为常态，将 CFG 视为调用可达性约束；任何间接调用路径都必须在目标样本中验证其合法性。
7. 逐项交叉验证 constructor、destructor、每个 callback 与每个 control method：符号/字符串锚点、控制流、vtable 相对槽、对象生命周期证据必须相互一致。
8. 只有 Windows 侧独立确认后，才可把该平台加入 adapter 支持矩阵；不能因 Linux 名称相似而宣称 parity。

## Windows parity checklist

| 检查项 | 通过标准 |
| --- | --- |
| 样本固定 | QQNT 版本、PE hash、PDB/signature 信息完整且可复核。 |
| 模块识别 | `wrapper.node` 与 AVSDK DLL 的身份和加载关系已确认。 |
| constructor / destructor | 两者均有独立的对象生命周期证据。 |
| callback | 每个候选回调均通过名称或字符串锚点、控制流和对象关系交叉验证。 |
| control methods | 每个候选控制方法均通过控制流与 vtable 相对槽交叉验证。 |
| ABI | MSVC x64 calling convention、异常边界、CFG 与 ASLR 限制均已按目标样本核对。 |
| 参数与 context | 参数语义、active `this` 和 opaque context 生命周期均有独立证据；否则仍为当前未知。 |
| probe | 仅启用 metadata-only 字段，且敏感字段审计通过。 |
| GUI | 实现路径不包含 GUI 自动化、点击模拟、窗口注入或可见界面依赖。 |

## 当前代码文件索引

| 文件 | 与本记录的关系 |
| --- | --- |
| `src/main.ts` | 包装 session 与 AVSDK facade；不拦截或观察 `setActionFromAVSDK`。 |
| `src/kernel-types.ts` | 声明 `KernelAVSDKService` 和可选 `getAVSDKService` 表面。 |
| `src/listener-tee.ts` | 为 AVSDK service 提供原生单注册、JavaScript tap 扇出。 |
| `src/qq-kernel.ts` | 注册 AVSDK listener，并处理受限的桥接观察、状态与清理。 |

## 更新规则

- 本文件是跨平台逆向记录的唯一持续更新位置；Task #68 和 Task #70 的结果必须追加到本文件，并标明样本身份、证据分层和验证方式。
- 只追加已核对事实、明确推断或当前未知；不得以 TODO 占位代替未知项。
- 每次新增 Linux VA、Windows 定位或 ABI 结论前，先核对对应样本身份；不得跨 Build ID、跨 PE hash 或跨平台复用结论。
- 每次更新后执行 markdown 基本检查、`git diff --check` 和敏感模式扫描；发现敏感内容即移除，不在本文件复述。
- Task #71 保持 `in_progress`，等待独立 reviewer 审阅；本文不自行批准或宣告完成。
