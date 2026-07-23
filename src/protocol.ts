export const PROTOCOL_VERSION = 1

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
  locator: QQMediaLocator
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
  parts: Array<{ type: 'text', text: string } | { type: 'media', media: QQMedia }>
  reactionContext?: QQReactionContext
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
  unreadCount?: number
  lastMessage?: QQMessage
  /** Last message read before QQ's first unread message. */
  readInboxMaxMessage?: QQMessage
}

export type QQEvent =
  | { type: 'message', conversation: QQConversation, message: QQMessage }
  | { type: 'message-delete', eventId: string, conversation: QQConversation, messageIds: string[], timestamp: number }
  | {
      type: 'message-reactions'
      eventId: string
      conversation: QQConversation
      target: { conversationId: string, messageId: string, targetId: string }
      context: QQReactionContext
      timestamp: number
    }

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
          format: 'static'
          mimeType: 'image/png'
          width: number
          height: number
          size?: number
          locator: { filePath: string }
        }
      }
}

export interface QQReactionContext {
  available: QQReactionDefinition[]
  reactions: Array<{ key: string, count: number, selected?: boolean }>
  maxSelected: number
}

export interface SendManifest {
  conversationId: string
  text?: string
  media?: Array<{
    kind: 'image' | 'file'
    name: string
    mimeType?: string
    size?: number
  }>
}

export interface HistoryQuery {
  cursor?: string
  limit?: number
  beforeId?: string
  afterId?: string
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
