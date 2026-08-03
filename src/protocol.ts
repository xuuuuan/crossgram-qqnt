export const PROTOCOL_VERSION = 20

/** Local Unix-socket PCM media protocol. Audio frames use a 1-byte type plus a 4-byte big-endian length. */
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
/** Wire values for a 1-byte type plus a 4-byte big-endian payload length. */
export const PCM_MEDIA_FRAME_TYPES = {
  auth: 1,
  uplink: 2,
  ready: 0x80,
  downlink: 0x81,
} as const

export type QQPCMMediaFrameType = keyof typeof PCM_MEDIA_FRAME_TYPES
export interface QQPCMMediaFrame {
  type: QQPCMMediaFrameType
  /** Auth and ready payloads contain the protocol version; audio payloads are fixed 20 ms PCM frames. */
  payload: Uint8Array
}

export type QQChatType = 1 | 2

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
  kind: 'image' | 'file'
  fileName: string
  fileSize?: string
  filePath?: string
  fileUuid?: string
  fileSubId?: string
  fileBizId?: number
  md5?: string
  sha?: string
  sha3?: string
  /** MD5 of the first 10 MiB, required by QQ's private-file URL API. */
  file10MMd5?: string
  /** QQ's original CDN URL. The bridge replaces its expired RKey through OIDB. */
  originImageUrl?: string
  /** Present only for native QQ video elements. 0 h264, 1 h265. */
  videoCodecFormat?: number
  /** Numeric QQ account used to fetch a user avatar from the fixed qlogo endpoint. */
  avatarUin?: string
}

export interface QQMedia {
  id: string
  kind: 'image' | 'file'
  name?: string
  mimeType?: string
  size?: number
  width?: number
  height?: number
  /** Playback duration in seconds. Present for native QQ video elements. */
  duration?: number
  /** Native QQ thumbnail that can be fetched without downloading the full media. */
  preview?: {
    mimeType?: string
    size: number
    width: number
    height: number
    locator: QQMediaLocator
  }
  locator: QQMediaLocator
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
  }
  msgSeq?: string
  /** Telegram megagroup message ID; QQ group msgSeq is conversation-scoped and monotonic. */
  telegramMessageId?: number
  /** Telegram megagroup reply target taken directly from QQ replayMsgSeq. */
  telegramReplyToMessageId?: number
  /** Adapter-generated correlation token used to suppress only its own listener echo. */
  originRequestId?: string
  /** Opaque QQ msgId referenced by a native reply element. */
  replyToId?: string
  /** QQ gray-tip/poke projected as a Telegram service message by the relay. */
  serviceAction?: { type: 'custom', text: string }
  parts: Array<
    | QQTextPart
    | { type: 'media', media: QQMedia }
    | { type: 'sticker', sticker: QQSticker }
    | { type: 'multi-forward', title: string, preview?: string, locator: QQMultiForwardLocator }
    | { type: 'card', card: QQCard }
  >
  /** Per-message state only. The shared definition catalog has its own endpoint. */
  reactionContext?: QQReactionState
}

/** Structured QQ Ark/XML share rendered as a native preview by the relay. */
export interface QQCard {
  kind: 'mini-app' | 'link' | 'music' | 'contact' | 'location' | 'application'
  title: string
  description?: string
  source?: string
  /** Browser-compatible jump target. QQ-only deep links stay in the native payload. */
  url?: string
  /** Remote cover retained for clients that can materialize preview artwork. */
  thumbnailUrl?: string
}

export interface QQMultiForwardLocator {
  /** Physical QQ conversation containing the outermost merged-forward message. */
  conversationId: string
  /** Outermost QQ message ID; unchanged while opening nested forwards. */
  rootMessageId: string
  /** Nested merged-forward message ID. Omitted for the outermost level. */
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
  /** Native group size, when present in QQ's group profile snapshot. */
  participantCount?: number
  /** Current account's native group role (2 member, 3 admin, 4 owner). */
  selfRole?: 'owner' | 'administrator' | 'member'
  unreadCount?: number
  lastMessage?: QQMessage
  /** QQ's native cursor for the first unread message. */
  firstUnread?: { msgSeq: string, msgTime: string }
  /** Last message read before QQ's first unread message. */
  readInboxMaxMessage?: QQMessage
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

export type QQEvent =
  | { type: 'message', conversation: QQConversation, message: QQMessage }
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
            /** Opaque catalog key accepted only by the dedicated reaction asset endpoint. */
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
  /** QQNT exposes no reaction timestamp, so only the opaque actor ID is available. */
  recentActors?: Array<{ userId: string }>
}

export interface QQSendMediaSpec {
  kind: 'image' | 'file'
  name: string
  mimeType?: string
  size?: number
  /** Full-file hashes supplied by the relay so protocol upload needs no local staging pass. */
  md5?: string
  sha1?: string
  /** MD5 of the first min(10 MiB, file size), used by private-file upload. */
  file10MMd5?: string
  width?: number
  height?: number
  duration?: number
}

export type QQPreparedMedia =
  | {
      kind: 'image'
      fileUuid: string
      msgInfo: string
      compatQMsg?: string
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
  /** Absent when QQ reports that the bytes already exist on its CDN. */
  highway?: QQHighwayUpload
}

export interface SendManifest {
  conversationId: string
  text?: string
  textParts?: QQTextPart[]
  replyToId?: string
  originRequestId?: string
  sticker?: QQStickerReference
  /** Length-prefixed chunks terminated by a zero-length frame for each media item. */
  mediaFraming?: 'length-prefixed-v1'
  media?: QQSendMediaSpec[]
  /** CDN metadata returned by /uploads/prepare after the platform uploaded Highway bytes directly. */
  uploadedMedia?: QQPreparedMedia[]
}

export interface HistoryQuery {
  cursor?: string
  limit?: number
  beforeId?: string
  afterId?: string
  /** Native QQ sequence used only to open a chat around its unread boundary. */
  aroundUnreadSeq?: string
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
      /** Conversation-scoped group card; never overwrite the global name with it. */
      alias?: string
      avatarUrl?: string
      avatar?: QQMedia
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
  // QQ UID and group code are already stable opaque identifiers. Keeping the
  // native value also makes a direct conversation line up with its IM user.
  return peerUid
}

export function parseConversationId(value: string): { chatType: QQChatType, peerUid: string } {
  // Accept IDs emitted by older builds during a rolling restart. New responses
  // never add a synthetic chat-type prefix.
  const match = /^(1|2):(.+)$/.exec(value)
  if (match) return { chatType: Number(match[1]) as QQChatType, peerUid: match[2] }
  if (!value) throw new Error('invalid empty QQ conversation ID')
  return { chatType: /^\d+$/.test(value) ? 2 : 1, peerUid: value }
}
