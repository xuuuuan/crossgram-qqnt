/** HTTP 协议版本号，仅在新增能力时递增，供 `platform-qqnt` 按版本协商兼容。 */
export const PROTOCOL_VERSION = 35

/** 本地 Unix socket PCM 音频流协议，帧头为 1 字节类型 + 4 字节大端长度。 */
export const PCM_MEDIA_PROTOCOL_VERSION = 1
export const PCM_MEDIA_SAMPLE_RATE = 48_000
export const PCM_MEDIA_CHANNELS = 1
export const PCM_MEDIA_SAMPLE_FORMAT = 's16le'
export const PCM_MEDIA_FRAME_DURATION_MS = 20
export const PCM_MEDIA_FRAME_BYTES =
  (PCM_MEDIA_SAMPLE_RATE *
    PCM_MEDIA_CHANNELS *
    2 *
    PCM_MEDIA_FRAME_DURATION_MS) /
  1_000
export const PCM_MEDIA_FRAME_TYPES = {
  auth: 1,
  uplink: 2,
  ready: 0x80,
  downlink: 0x81,
} as const

export type QQPCMMediaFrameType = keyof typeof PCM_MEDIA_FRAME_TYPES
export interface QQPCMMediaFrame {
  type: QQPCMMediaFrameType
  /** auth/ready 载荷包含协议版本；uplink/downlink 为固定 20ms PCM 帧。 */
  payload: Uint8Array
}

/** 1 私聊，2 群聊，8 电脑数据线，134 手机数据线。 */
export type QQChatType = 1 | 2 | 8 | 134

export interface QQContact {
  chatType: QQChatType
  peerUid: string
  peerUin: string
  name: string
  avatarUrl?: string
}

export interface QQMediaLocator {
  messageId: string
  elementId: string
  chatType: QQChatType
  peerUid: string
  kind: 'image' | 'file' | 'voice'
  fileName: string
  fileSize?: string
  /** 延迟转码语音的原始 PTT 路径。 */
  sourcePath?: string
  sourceSize?: number
  sourceMtimeMs?: number
  filePath?: string
  fileUuid?: string
  fileSubId?: string
  fileBizId?: number
  md5?: string
  sha?: string
  sha3?: string
  /** 前 10 MiB 数据的 MD5，私聊文件下载直链必填。 */
  file10MMd5?: string
  /** 原始图片 CDN URL，需通过 OIDB 刷新过期 RKey。 */
  originImageUrl?: string
  /** QQ 图片 CDN 规格：0 原图，198/720 缩略图。 */
  imageSpec?: 0 | 198 | 720
  /** 仅原生视频元素包含：0 H.264，1 H.265。 */
  videoCodecFormat?: number
  /** 用于拼接 qlogo 头像接口的 QQ 号。 */
  avatarUin?: string
  /** QQNT 返回的按 UID 索引的头像 URL。 */
  avatarUrl?: string
}

export interface QQMedia {
  id: string
  kind: 'image' | 'file'
  /** 是否为录制的 PTT 语音。 */
  voice?: boolean
  name?: string
  mimeType?: string
  size?: number
  width?: number
  height?: number
  /** 视频或语音时长（秒）。 */
  duration?: number
  /** PTT 语音转文字结果。 */
  transcript?: string
  preview?: {
    mimeType?: string
    size: number
    width: number
    height: number
    locator: QQMediaLocator
  }
  locator: QQMediaLocator
}

export interface QQGroupFile {
  type: 'file'
  id: string
  parentId: string
  name: string
  size: number
  uploadTime: number
  modifyTime: number
  expiresAt?: number
  downloadCount: number
  uploaderId: string
  uploaderName: string
  busId: number
  media: QQMedia
}

export interface QQGroupFileFolder {
  type: 'folder'
  id: string
  parentId: string
  name: string
  createTime: number
  modifyTime: number
  creatorId: string
  creatorName: string
  fileCount: number
}

export interface QQGroupFilePage {
  items: Array<QQGroupFile | QQGroupFileFolder>
  nextCursor?: string
  total?: number
}

export type QQStickerReference =
  | {
      kind: 'sysface'
      faceId: string
      faceType: number
      name: string
      packId?: string
      stickerId?: string
      sourceType?: number
      stickerType?: number
      resultId?: string
      imageType?: number
      width?: number
      height?: number
      animated: true
      url?: string
    }
  | {
      kind: 'market'
      packageId: string
      stickerId: string
      name: string
      key: string
      width: number
      height: number
      animated: boolean
      mimeType?: 'image/gif' | 'image/apng' | 'image/png'
      staticPath?: string
      staticSize?: number
      dynamicPath?: string
      favoriteResId?: string
    }
  | {
      kind: 'favorite'
      resId: string
      path: string
      name: string
      md5?: string
      size?: number
      width?: number
      height?: number
      animated: boolean
      mimeType?: 'image/gif' | 'image/apng' | 'image/png' | 'image/jpeg' | 'image/webp' | 'image/bmp'
      url?: string
      locator?: QQMediaLocator
    }

export interface QQSticker {
  stickerId: string
  packId?: string
  title?: string
  format: 'static' | 'animated'
  mimeType: string
  width?: number
  height?: number
  size?: number
  version?: number
  reference: QQStickerReference
}

export interface QQStickerPackSummary {
  packId: string
  title: string
  count?: number
  version?: number
}

export interface QQStickerPack extends QQStickerPackSummary {
  stickers: QQSticker[]
}

export interface QQServiceMember {
  /** 成员 UID。 */
  id: string
  name?: string
}

export type QQServiceAction =
  | { type: 'custom', text: string }
  | { type: 'phone-call' }
  | {
      /** 群成员入群通知（对应灰条 `groupElement.memberAdd`）。 */
      type: 'members-joined'
      text: string
      members: QQServiceMember[]
      actor?: QQServiceMember
      viaInviteLink?: true
    }

export interface QQMessage {
  id: string
  sourceIds?: string[]
  conversationId: string
  senderId: string
  timestamp: number
  outgoing: boolean
  sender?: {
    id: string
    numericId?: string
    name: string
    alias?: string
    avatar?: QQMedia
    bot?: true
  }
  msgSeq?: string
  /** 群聊单调递增的 msgSeq，直接映射为 Telegram megagroup 消息 ID。 */
  telegramMessageId?: number
  /** 从 `replayMsgSeq` 提取的群聊回复目标消息 ID。 */
  telegramReplyToMessageId?: number
  /** 发送方生成的关联 token，用于过滤本端 listener 回显。 */
  originRequestId?: string
  replyToId?: string
  serviceAction?: QQServiceAction
  parts: Array<
    | QQTextPart
    | { type: 'markdown', content: string }
    | { type: 'inline-keyboard', keyboard: QQInlineKeyboard }
    | { type: 'media', media: QQMedia }
    | { type: 'sticker', sticker: QQSticker }
    | { type: 'multi-forward', title: string, preview?: string, locator: QQMultiForwardLocator }
    | { type: 'card', card: QQCard }
  >
  reactionContext?: QQReactionState
}

export interface QQInlineKeyboard {
  botAppid: string
  rows: Array<{ buttons: QQInlineKeyboardButton[] }>
}

export interface QQInlineKeyboardButton {
  id: string
  label: string
  visitedLabel: string
  style: number
  type: number
  clickLimit: number
  unsupportTips: string
  data: string
  atBotShowChannelList: boolean
  permissionType: number
  specifyRoleIds: string[]
  specifyTinyids: string[]
}

/** Ark/XML 卡片消息的解析结果。 */
export interface QQCard {
  kind: 'mini-app' | 'link' | 'music' | 'contact' | 'location' | 'application'
  title: string
  description?: string
  source?: string
  /** 仅保留 HTTP/HTTPS 链接，忽略 QQ 私有 scheme。 */
  url?: string
  thumbnailUrl?: string
  /** Official group-invite cards (bizsrc=qun.invite): accepts the invite via operateSysNotify. */
  groupInvite?: QQGroupInvite
}

/** Parameters of an official "邀请你加入群聊" card's mqqapi jump link. */
export interface QQGroupInvite {
  groupCode: string
  /** Notify seq; operateSysNotify resolves the invitation by it. */
  msgSeq: string
}

export interface QQMultiForwardLocator {
  conversationId: string
  /** 最外层合并转发的 msgId，打开嵌套转发时保持不变。 */
  rootMessageId: string
  /** 嵌套合并转发的父消息 ID，最外层不填。 */
  parentMessageId?: string
}

export interface QQTextPart {
  type: 'text'
  text: string
  entities?: Array<
    | {
        type: 'mention'
        offset: number
        length: number
        userId: string
        numericId?: string
      }
    | {
        type: 'qq-face'
        offset: number
        length: number
        faceId: string
        faceType: number
      }
  >
}

export interface QQConversation {
  id: string
  kind: 'direct' | 'group'
  title: string
  peerUid: string
  peerUin: string
  chatType: QQChatType
  avatarUrl?: string
  avatar?: QQMedia
  participantCount?: number
  /** 当前账号在群内的角色（原生值：2 成员，3 管理员，4 群主）。 */
  selfRole?: 'owner' | 'administrator' | 'member'
  /** 原生 GroupMsgMask 值。 */
  groupMsgMask?: number
  unreadCount?: number
  lastMessage?: QQMessage
  firstUnread?: { msgSeq: string, msgTime: string }
  /** 首条未读消息之前的最后一条已读消息。 */
  readInboxMaxMessage?: QQMessage
}

export type QQRequestKind = 'friend' | 'group-join'
export type QQRequestStatus = 'pending' | 'accepted' | 'rejected'

export interface QQRequest {
  id: string
  kind: QQRequestKind
  status: QQRequestStatus
  requester: { id: string, name?: string }
  group?: { id: string, name?: string }
  message?: string
  timestamp?: string | number
  /** 来自被过滤的好友申请通道。 */
  source?: 'doubt'
  /** 被过滤好友申请的拦截原因。 */
  reason?: string
}

export interface QQPokeRequest {
  /** 被戳用户的 UID，默认为会话对端。 */
  userId?: string
  /** 连戳次数（1..10），默认为 1。 */
  count?: number
}

export interface QQPokeResult {
  count: number
  /** QQ 写入会话的戳一戳灰条消息（若已捕获）。 */
  message?: QQMessage
}

export interface QQRequestPage {
  requests: QQRequest[]
  nextCursor?: string
}

export interface QQRequestEvent {
  type: 'request'
  request: QQRequest
}

export interface QQCallSignalEvent {
  type: 'call-signal'
  version: 1
  signal: 'incoming' | 'accept-requested' | 'refuse-requested' | 'logout-requested' | 'ended'
  media: 'voice' | 'unknown'
  callId: string
  conversation: QQConversation
  timestamp: number
}

export interface QQVoiceTranscriptEvent {
  type: 'voice-transcript'
  eventId: string
  conversation: QQConversation
  messageId: string
  transcript: string
  timestamp: number
}

export type QQEvent =
  | QQRequestEvent
  | { type: 'message', conversation: QQConversation, message: QQMessage }
  | { type: 'message-edit', eventId: string, conversation: QQConversation, message: QQMessage }
  | { type: 'message-delete', eventId: string, conversation: QQConversation, messageIds: string[], timestamp: number }
  | {
      type: 'message-reactions'
      eventId: string
      conversation: QQConversation
      target: { conversationId: string, messageId: string, targetId: string }
      context: QQReactionState
      timestamp: number
    }
  | QQCallSignalEvent
  | QQVoiceTranscriptEvent

export interface QQReactionDefinition {
  key: string
  title?: string
  presentation:
    | { type: 'emoji', emoticon: string }
    | {
        type: 'custom'
        alt: string
        resource: {
          version: number
          format: 'static' | 'video'
          mimeType: 'image/png' | 'video/webm'
          width: number
          height: number
          size?: number
          locator: {
            reactionKey: string
          }
        }
      }
}

export interface QQReactionContext {
  available: QQReactionDefinition[]
  reactions: QQReactionSummary[]
  maxSelected: number
}

export interface QQReactionState {
  reactions: QQReactionSummary[]
  maxSelected: number
}

export interface QQReactionSummary {
  key: string
  count: number
  selected?: boolean
  recentActors?: Array<{ userId: string }>
}

export interface QQReactionActorPage {
  state: QQReactionState
  actors: Array<{ reactionKey: string, actor: { userId: string } }>
  nextOffset?: string
}

export interface QQSendMediaSpec {
  kind: 'image' | 'video' | 'file' | 'voice'
  name: string
  mimeType?: string
  size?: number
  md5?: string
  sha1?: string
  /** 每 1 MiB 边界处的 SHA-1 中间状态及最终摘要。 */
  sha1Checkpoints?: string[]
  /** 前 min(10 MiB, 文件大小) 的 MD5，用于私聊文件上传。 */
  file10MMd5?: string
  width?: number
  height?: number
  duration?: number
  thumbnail?: {
    size: number
    md5: string
    sha1: string
    width: number
    height: number
  }
}

export type QQPreparedMedia =
  | {
      kind: 'image'
      fileUuid: string
      msgInfo: string
      compatQMsg?: string
    }
  | {
      kind: 'video'
      fileUuid: string
      msgInfo: string
    }
  | {
      kind: 'file'
      fileUuid: string
      fileHash?: string
      exists: boolean
      commandId: 71 | 95
    }

export interface QQHighwayUpload {
  servers: Array<{ host: string, port: number }>
  ticket: string
  extendInfo: string
  selfUin: string
  commandId: number
  sequenceStart: number
  blockSize: number
  fileSize: number
  fileMd5: string
}

export interface QQMediaUploadPlan {
  prepared: QQPreparedMedia
  /** 秒传命中时为空。 */
  highway?: QQHighwayUpload
  auxiliaryHighways?: Array<{
    role: 'thumbnail'
    /** 仅在使用默认兜底缩略图时返回字节数据。 */
    bytes?: string
    highway: QQHighwayUpload
  }>
}

export interface SendManifest {
  conversationId: string
  text?: string
  textParts?: QQTextPart[]
  replyToId?: string
  replyToSequence?: string
  originRequestId?: string
  sticker?: QQStickerReference
  /** 每个媒体流以长度前缀分块传输，并以 0 长度帧结尾。 */
  mediaFraming?: 'length-prefixed-v1'
  media?: QQSendMediaSpec[]
  /** 调用方直传 Highway 后，由 `/uploads/prepare` 返回的 CDN 元数据。 */
  uploadedMedia?: QQPreparedMedia[]
  /**
   * 按顺序排列的图文混排内容，设置后替代 `text`/`textParts` 与 `media`/`uploadedMedia`；
   * 请求体中的媒体流仍按此处 `media` 出现的顺序读取。
   */
  parts?: QQSendPart[]
}

export type QQSendPart =
  | { type: 'text', text: string, entities?: QQTextPart['entities'] }
  | {
      type: 'media'
      media: QQSendMediaSpec
      prepared?: QQPreparedMedia
    }

export interface QQFlashTransferUploadFile {
  source: 'upload'
  name: string
  size: number
}

export interface QQFlashTransferUploadedFile {
  source: 'uploaded'
  name: string
  size: number
  md5: string
  sha1: string
}

export interface QQFlashTransferQQMediaFile {
  source: 'qq-media'
  name: string
  size: number
  locator: QQMediaLocator
}

export type QQFlashTransferFile =
  | QQFlashTransferUploadFile
  | QQFlashTransferUploadedFile
  | QQFlashTransferQQMediaFile

/**
 * 闪传创建清单。仅 `source: 'upload'` 会从请求体读取对应媒体流；
 * `uploaded` 与 `qq-media` 直接通过 MD5/SHA-1 走秒传复用。
 */
export interface QQFlashTransferManifest {
  name?: string
  files: QQFlashTransferFile[]
  framing: 'length-prefixed-v1'
}

export interface QQFlashTransferResult {
  fileSetId: string
  shareLink: string
  expiresAt?: number
}

export interface HistoryQuery {
  cursor?: string
  limit?: number
  beforeId?: string
  afterId?: string
  /** 围绕未读边界加载历史消息的起始 msgSeq。 */
  aroundUnreadSeq?: string
  /** 未指定锚点时直接加载最新一页，忽略未读边界。 */
  latest?: boolean
}

export interface SearchQuery {
  query: string
  cursor?: string
  limit?: number
  fromUserId?: string
  minTimestamp?: number
  maxTimestamp?: number
  mediaKind?: 'image' | 'file'
}

export interface SearchPage {
  messages: QQMessage[]
  nextCursor?: string
}

export interface MemberPage {
  members: Array<{
    user: {
      id: string
      numericId?: string
      name: string
      /** 群名片（仅限当前群，不覆盖全局昵称）。 */
      alias?: string
      avatarUrl?: string
      avatar?: QQMedia
      bot?: true
    }
    role: 'owner' | 'administrator' | 'member'
  }>
  total?: number
  nextCursor?: string
}

export interface BridgeStatus {
  protocolVersion: number
  ready: boolean
  selfUin?: string
  selfUid?: string
}

export function conversationId(chatType: QQChatType, peerUid: string): string {
  if (chatType === 8 || chatType === 134) return `device:${chatType}:${peerUid}`
  return peerUid
}

export function parseConversationId(value: string): { chatType: QQChatType, peerUid: string } {
  const device = /^device:(8|134):(.+)$/.exec(value)
  if (device) return { chatType: Number(device[1]) as QQChatType, peerUid: device[2] }
  // 兼容旧版本带 `1:` / `2:` 前缀的会话 ID。
  const match = /^(1|2):(.+)$/.exec(value)
  if (match) return { chatType: Number(match[1]) as QQChatType, peerUid: match[2] }
  if (!value) throw new Error('invalid empty QQ conversation ID')
  return { chatType: /^\d+$/.test(value) ? 2 : 1, peerUid: value }
}
