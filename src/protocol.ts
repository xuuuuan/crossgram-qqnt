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
  parts: Array<{ type: 'text', text: string } | { type: 'media', media: QQMedia }>
}

export interface QQConversation {
  id: string
  kind: 'direct' | 'group'
  title: string
  peerUid: string
  peerUin: string
  chatType: QQChatType
  avatarUrl?: string
  unreadCount?: number
  lastMessage?: QQMessage
}

export type QQEvent =
  | { type: 'message', conversation: QQConversation, message: QQMessage }
  | { type: 'message-delete', eventId: string, conversation: QQConversation, messageIds: string[], timestamp: number }

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
    user: { id: string, numericId?: string, name: string, avatarUrl?: string }
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
  return `${chatType}:${peerUid}`
}

export function parseConversationId(value: string): { chatType: QQChatType, peerUid: string } {
  const match = /^(1|2):(.+)$/.exec(value)
  if (!match) throw new Error(`invalid QQ conversation ID: ${value}`)
  return { chatType: Number(match[1]) as QQChatType, peerUid: match[2] }
}
