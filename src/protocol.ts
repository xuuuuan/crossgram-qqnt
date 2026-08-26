export const PROTOCOL_VERSION = 31

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

/** QQ buddy/group chats plus the desktop/mobile data-line device sessions. */
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
  /** For prepared voice media, the trusted original PTT identity. */
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
  /** MD5 of the first 10 MiB, required by QQ's private-file URL API. */
  file10MMd5?: string
  /** QQ's original CDN URL. The bridge replaces its expired RKey through OIDB. */
  originImageUrl?: string
  /** QQ image CDN tier. 0 is original; 198 and 720 are QQ's native thumbnail specifications. */
  imageSpec?: 0 | 198 | 720
  /** Present only for native QQ video elements. 0 h264, 1 h265. */
  videoCodecFormat?: number
  /** Numeric QQ account used to fetch a user avatar from the fixed qlogo endpoint. */
  avatarUin?: string
  /** UID-scoped avatar URL returned by QQNT when the legacy UIN endpoint has no image. */
  avatarUrl?: string
}

export interface QQMedia {
  id: string
  kind: 'image' | 'file'
  /** Recorded PTT rather than an ordinary audio file. */
  voice?: boolean
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
  /** QQ service message rendered by the relay as a Telegram MessageService. */
  serviceAction?: { type: 'custom', text: string } | { type: 'phone-call' }
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
  /** Raw QQ GroupMsgMask value; no notification behavior is inferred from it. */
  groupMsgMask?: number
  unreadCount?: number
  lastMessage?: QQMessage
  /** QQ's native cursor for the first unread message. */
  firstUnread?: { msgSeq: string, msgTime: string }
  /** Last message read before QQ's first unread message. */
  readInboxMaxMessage?: QQMessage
}

export type QQRequestKind = 'friend' | 'group-join'
export type QQRequestStatus = 'pending' | 'accepted' | 'rejected'

/** Native QQ friend and administrator-approved group admission request. */
export interface QQRequest {
  /** Stable opaque identifier; it does not expose QQNT's action payload. */
  id: string
  kind: QQRequestKind
  status: QQRequestStatus
  requester: { id: string, name?: string }
  group?: { id: string, name?: string }
  message?: string
  timestamp?: string | number
  /** `doubt` requests come from QQ's filtered-notification channel. */
  source?: 'doubt'
  /** QQ's original reason for filtering a doubt friend request. */
  reason?: string
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
  /** Full-file hashes supplied by the relay so protocol upload needs no local staging pass. */
  md5?: string
  sha1?: string
  /** QQ cumulative SHA-1 states for each 1 MiB boundary, followed by the final digest. */
  sha1Checkpoints?: string[]
  /** MD5 of the first min(10 MiB, file size), used by private-file upload. */
  file10MMd5?: string
  width?: number
  height?: number
  duration?: number
  /** Relay-extracted JPEG frame used by QQ's native video element. */
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
  /** Absent when QQ reports that the bytes already exist on its CDN. */
  highway?: QQHighwayUpload
  /** Small bridge-owned companion assets, such as a video's thumbnail. */
  auxiliaryHighways?: Array<{
    role: 'thumbnail'
    /** Present only when the bridge must provide its generic fallback thumbnail. */
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
  /** Length-prefixed chunks terminated by a zero-length frame for each media item. */
  mediaFraming?: 'length-prefixed-v1'
  media?: QQSendMediaSpec[]
  /** CDN metadata returned by /uploads/prepare after the platform uploaded Highway bytes directly. */
  uploadedMedia?: QQPreparedMedia[]
}

/** One file uploaded from the caller into a QQ Flash Transfer file set. */
export interface QQFlashTransferUploadFile {
  source: 'upload'
  name: string
  size: number
}

/** One file whose bytes were already streamed into QQ's file CDN. */
export interface QQFlashTransferUploadedFile {
  source: 'uploaded'
  name: string
  size: number
  md5: string
  sha1: string
}

/** One existing QQ media file reused through QQ's remote MD5/SHA-1 identity. */
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
 * Hybrid reuse/upload contract for POST /v1/flash-transfers.
 *
 * Only `source: 'upload'` entries consume a length-prefixed body item. Existing
 * QQ media and preflight-uploaded bytes are reused through QQ's protocol-level
 * fast-upload identity without reading local cache bytes or crossing the body.
 */
export interface QQFlashTransferManifest {
  name?: string
  files: QQFlashTransferFile[]
  framing: 'length-prefixed-v1'
}

export interface QQFlashTransferResult {
  fileSetId: string
  shareLink: string
  /** Absolute Unix timestamp in milliseconds when QQ exposes one. */
  expiresAt?: number
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
  if (chatType === 8 || chatType === 134) return `device:${chatType}:${peerUid}`
  // QQ UID and group code are already stable opaque identifiers. Keeping the
  // native value also makes a direct conversation line up with its IM user.
  return peerUid
}

export function parseConversationId(value: string): { chatType: QQChatType, peerUid: string } {
  const device = /^device:(8|134):(.+)$/.exec(value)
  if (device) return { chatType: Number(device[1]) as QQChatType, peerUid: device[2] }
  // Accept IDs emitted by older builds during a rolling restart. New responses
  // never add a synthetic chat-type prefix.
  const match = /^(1|2):(.+)$/.exec(value)
  if (match) return { chatType: Number(match[1]) as QQChatType, peerUid: match[2] }
  if (!value) throw new Error('invalid empty QQ conversation ID')
  return { chatType: /^\d+$/.test(value) ? 2 : 1, peerUid: value }
}
