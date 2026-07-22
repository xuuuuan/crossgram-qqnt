import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync, mkdirSync, statSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import type { Readable } from 'node:stream'
import { AsyncQueue, deferred } from './async.js'
import type {
  FileTransNotifyInfo, InitSessionConfig, KernelModule, KernelSession, MemberInfo, MsgElement, MsgRecord,
  ProfileSimpleInfo, RecentContactInfo,
} from './kernel-types.js'
import {
  conversationId, parseConversationId, type HistoryQuery, type MemberPage, type QQConversation, type QQEvent,
  type QQMedia, type QQMediaLocator, type QQMessage, type SendManifest,
} from './protocol.js'

const CHAT_C2C = 1
const CHAT_GROUP = 2
const ELEMENT_TEXT = 1
const ELEMENT_IMAGE = 2
const ELEMENT_FILE = 3
const SEND_FROM_SELF = new Set([1, 2])
const MEMBER_ADMIN = 3
const MEMBER_OWNER = 4

export interface QQKernelOptions {
  tempPath?: string
  sendTimeoutMs?: number
  downloadTimeoutMs?: number
}

export class QQKernelBridge {
  readonly events = new Set<AsyncQueue<QQEvent>>()
  private session?: KernelSession
  private kernel?: KernelModule
  private config?: InitSessionConfig
  private readonly contacts = new Map<string, QQConversation>()
  private readonly users = new Map<string, { id: string, numericId?: string, name: string, avatarUrl?: string }>()
  private readonly pendingMessages = new Map<string, ReturnType<typeof deferred<MsgRecord>>>()
  private readonly pendingDownloads = new Map<string, ReturnType<typeof deferred<FileTransNotifyInfo>>>()
  private listenerId?: string
  private buddyListenerId?: string
  private groupListenerId?: string
  private readonly tempPath: string
  private readonly sendTimeoutMs: number
  private readonly downloadTimeoutMs: number

  constructor(options: QQKernelOptions = {}) {
    this.tempPath = options.tempPath ?? join(process.env.TMPDIR ?? '/tmp', 'qqnt-mtproto-bridge')
    this.sendTimeoutMs = options.sendTimeoutMs ?? 60_000
    this.downloadTimeoutMs = options.downloadTimeoutMs ?? 120_000
    mkdirSync(this.tempPath, { recursive: true })
  }

  get status() {
    return {
      ready: Boolean(this.session),
      selfUin: this.config?.selfUin,
      selfUid: this.config?.selfUid,
    }
  }

  attach(kernel: KernelModule, session: KernelSession, config: InitSessionConfig): void {
    this.detach()
    this.kernel = kernel
    this.session = session
    this.config = config
    this.registerListeners()
    void this.refreshContacts()
  }

  detach(): void {
    if (this.session && this.listenerId) this.session.getMsgService().removeKernelMsgListener(this.listenerId)
    if (this.session && this.buddyListenerId) this.session.getBuddyService().removeKernelBuddyListener(this.buddyListenerId)
    if (this.session && this.groupListenerId) this.session.getGroupService().removeKernelGroupListener(this.groupListenerId)
    this.listenerId = this.buddyListenerId = this.groupListenerId = undefined
    this.session = undefined
    for (const pending of this.pendingMessages.values()) pending.reject(new Error('QQNT session detached'))
    for (const pending of this.pendingDownloads.values()) pending.reject(new Error('QQNT session detached'))
    this.pendingMessages.clear()
    this.pendingDownloads.clear()
  }

  subscribe(): AsyncQueue<QQEvent> {
    const queue = new AsyncQueue<QQEvent>()
    this.events.add(queue)
    return queue
  }

  unsubscribe(queue: AsyncQueue<QQEvent>): void {
    this.events.delete(queue)
    queue.close()
  }

  async refreshContacts(): Promise<void> {
    const session = this.requireSession()
    const recent = await session.getRecentContactService().getRecentContactInfos()
    if (recent.result !== 0) throw new Error(`getRecentContactInfos: ${recent.errMsg} (${recent.result})`)
    for (const item of recent.relation) this.upsertRecent(item)
    // These methods deliver their actual data through listeners.
    await Promise.allSettled([
      session.getBuddyService().getBuddyList(false),
      session.getGroupService().getGroupList(false),
    ])
  }

  async getDialogs(cursor?: string, limit = 100): Promise<{ conversations: QQConversation[], nextCursor?: string }> {
    await this.refreshContacts()
    const dialogs = [...this.contacts.values()]
    const offset = parseCursor(cursor)
    const page = dialogs.slice(offset, offset + clamp(limit, 1, 500))
    return {
      conversations: page,
      nextCursor: offset + page.length < dialogs.length ? String(offset + page.length) : undefined,
    }
  }

  getConversation(id: string): QQConversation {
    const known = this.contacts.get(id)
    if (known) return known
    const { chatType, peerUid } = parseConversationId(id)
    return {
      id, kind: chatType === CHAT_GROUP ? 'group' : 'direct', title: peerUid,
      peerUid, peerUin: chatType === CHAT_GROUP ? peerUid : '', chatType,
    }
  }

  async resolveConversation(chatType: 1 | 2, numericId: string): Promise<QQConversation> {
    await this.refreshContacts()
    const known = [...this.contacts.values()].find((item) => item.chatType === chatType && item.peerUin === numericId)
    if (known) return known
    if (chatType === CHAT_GROUP) {
      const created: QQConversation = {
        id: conversationId(CHAT_GROUP, numericId), kind: 'group', title: numericId,
        peerUid: numericId, peerUin: numericId, chatType: CHAT_GROUP,
      }
      this.contacts.set(created.id, created)
      return created
    }
    const converted = await this.requireSession().getUixConvertService().getUid(new Set([numericId]))
    const peerUid = converted.uidInfo.get(numericId)
    if (!peerUid) throw new Error(`QQ user ${numericId} could not be resolved to a UID`)
    const created: QQConversation = {
      id: conversationId(CHAT_C2C, peerUid), kind: 'direct', title: numericId,
      peerUid, peerUin: numericId, chatType: CHAT_C2C,
    }
    this.contacts.set(created.id, created)
    return created
  }

  async getHistory(conversation: QQConversation, query: HistoryQuery = {}): Promise<{ messages: QQMessage[], nextCursor?: string }> {
    const service = this.requireSession().getMsgService()
    const limit = clamp(query.limit ?? 50, 1, 100)
    const anchor = query.beforeId ?? query.afterId ?? query.cursor ?? '0'
    const response = await service.getMsgs(contact(conversation), anchor, limit, !query.afterId)
    if (response.result !== 0) throw new Error(`getMsgs: ${response.errMsg} (${response.result})`)
    const messages = response.msgList.map((record) => this.mapMessage(record))
    const last = response.msgList.at(-1)
    return { messages, nextCursor: messages.length === limit ? last?.msgId : undefined }
  }

  async getMessage(conversation: QQConversation, id: string): Promise<QQMessage | null> {
    const response = await this.requireSession().getMsgService().getMsgsByMsgId(contact(conversation), [id])
    if (response.result !== 0) throw new Error(`getMsgsByMsgId: ${response.errMsg} (${response.result})`)
    return response.msgList[0] ? this.mapMessage(response.msgList[0]) : null
  }

  async send(manifest: SendManifest, body: Readable): Promise<QQMessage> {
    const conversation = this.getConversation(manifest.conversationId)
    const elements: MsgElement[] = []
    if (manifest.text) elements.push(textElement(manifest.text))
    const cleanup: string[] = []
    try {
      if (manifest.media?.length) {
        if (manifest.media.length !== 1) throw new Error('the streaming endpoint accepts exactly one media item per request')
        const spec = manifest.media[0]
        const path = join(this.tempPath, `${randomUUID()}${safeExtension(spec.name)}`)
        cleanup.push(path)
        await pipeline(body, createWriteStream(path, { flags: 'wx' }))
        const size = statSync(path).size
        if (spec.size !== undefined && size !== spec.size) {
          throw new Error(`incomplete upload: expected ${spec.size} bytes, received ${size}`)
        }
        elements.push(spec.kind === 'image' ? imageElement(path, spec.name, size) : fileElement(path, spec.name, size))
      } else {
        body.resume()
      }
      if (!elements.length) throw new Error('message must contain text or media')
      const service = this.requireSession().getMsgService()
      const id = service.getMsgUniqueId(String(Math.floor(Date.now() / 1000)))
      const pending = deferred<MsgRecord>()
      this.pendingMessages.set(id, pending)
      const result = await service.sendMsg(id, contact(conversation), elements, new Map())
      if (result.result !== 0) {
        this.pendingMessages.delete(id)
        throw new Error(`sendMsg: ${result.errMsg} (${result.result})`)
      }
      const record = await withTimeout(pending.promise, this.sendTimeoutMs, `QQ did not confirm message ${id}`)
      return this.mapMessage(record)
    } finally {
      await Promise.all(cleanup.map((path) => rm(path, { force: true }).catch(() => undefined)))
    }
  }

  async deleteMessages(conversation: QQConversation, ids: string[], forEveryone: boolean): Promise<void> {
    const service = this.requireSession().getMsgService()
    const result = forEveryone
      ? await service.recallMsg(contact(conversation), ids)
      : await service.deleteMsg(contact(conversation), ids)
    if (result.result !== 0) throw new Error(`${forEveryone ? 'recallMsg' : 'deleteMsg'}: ${result.errMsg} (${result.result})`)
  }

  async forwardMessages(source: QQConversation, ids: string[], destination: QQConversation): Promise<void> {
    const result = await this.requireSession().getMsgService().forwardMsg(
      ids, contact(source), [contact(destination)], new Map(),
    )
    if (result.result !== 0) throw new Error(`forwardMsg: ${result.errMsg} (${result.result})`)
  }

  async getUser(uid: string) {
    const cached = this.users.get(uid)
    if (cached) return cached
    const numeric = await this.requireSession().getUixConvertService().getUin(new Set([uid]))
    const numericId = numeric.uinInfo.get(uid)
    return numericId ? { id: uid, numericId, name: numericId } : null
  }

  async getMembers(conversation: QQConversation, cursor?: string, limit = 100): Promise<MemberPage> {
    if (conversation.chatType !== CHAT_GROUP) return { members: [], total: 0 }
    const service = this.requireSession().getGroupService()
    const scene = service.createMemberListScene(conversation.peerUin || conversation.peerUid, `mtproto-${randomUUID()}`)
    try {
      const start = decodeMemberCursor(cursor)
      const response = await service.getNextMemberList(scene, start, clamp(limit, 1, 500))
      if (response.errCode !== 0) throw new Error(`getNextMemberList: ${response.errMsg} (${response.errCode})`)
      const members = response.result.ids.flatMap(({ uid }) => {
        const info = response.result.infos.get(uid)
        return info ? [mapMember(info)] : []
      })
      return {
        members,
        total: response.result.finish ? members.length : undefined,
        nextCursor: response.result.finish ? undefined : encodeMemberCursor(response.result.ids.at(-1)),
      }
    } finally {
      service.destroyMemberListScene(scene)
    }
  }

  async openMedia(locator: QQMediaLocator, offset = 0, limit?: number): Promise<Readable> {
    let path = locator.filePath
    if (!path || !existsSync(path)) path = await this.downloadMedia(locator)
    const size = statSync(path).size
    const end = limit === undefined ? size - 1 : Math.min(size - 1, offset + Math.max(0, limit) - 1)
    return createReadStream(path, { start: Math.max(0, offset), end })
  }

  private async downloadMedia(locator: QQMediaLocator): Promise<string> {
    const key = `${locator.messageId}:${locator.elementId}`
    const pending = deferred<FileTransNotifyInfo>()
    this.pendingDownloads.set(key, pending)
    const directory = join(this.tempPath, 'downloads')
    mkdirSync(directory, { recursive: true })
    this.requireSession().getRichMediaService().downloadFile({
      fileModelId: '',
      msgId: locator.messageId,
      elemId: locator.elementId,
      uuid: locator.fileUuid ?? '',
      subId: locator.fileSubId ?? '',
      fileName: locator.fileName,
      fileSize: locator.fileSize ?? '0',
      msgTime: '0',
      peerUid: locator.peerUid,
      chatType: locator.chatType,
      md5: locator.md5 ?? '',
      md510m: '',
      sha: locator.sha ?? '',
      sha3: locator.sha3 ?? '',
      bizType: locator.fileBizId,
    }, 1, 0, directory)
    const completed = await withTimeout(pending.promise, this.downloadTimeoutMs, `QQ media download timed out: ${key}`)
    if (completed.fileErrCode !== '0' && completed.fileErrCode !== '') {
      throw new Error(`QQ media download failed: ${completed.fileErrMsg} (${completed.fileErrCode})`)
    }
    if (!completed.filePath || !existsSync(completed.filePath)) throw new Error('QQ media download completed without a file')
    return completed.filePath
  }

  private registerListeners(): void {
    const session = this.requireSession()
    const kernel = this.kernel!
    const msgListener = new kernel.NodeIKernelMsgListener({
      onRecvMsg: (records: MsgRecord[]) => this.onMessages(records),
      onAddSendMsg: (record: MsgRecord) => this.onMessages([record]),
      onMsgInfoListUpdate: (records: MsgRecord[]) => this.onMessages(records),
      onMsgRecall: (chatType: number, peerUid: string, seq: string) => this.onDelete(chatType, peerUid, [seq]),
      onMsgDelete: (peer: { chatType: number, peerUid: string }, ids: string[]) => this.onDelete(peer.chatType, peer.peerUid, ids),
      onRichMediaDownloadComplete: (info: FileTransNotifyInfo) => this.onDownload(info),
    } as never)
    this.listenerId = session.getMsgService().addKernelMsgListener(msgListener)
    const buddyListener = new kernel.NodeIKernelBuddyListener({
      onBuddyListChange: (categories: Array<{ buddyList: ProfileSimpleInfo[] }>) => {
        for (const category of categories) for (const buddy of category.buddyList) this.upsertBuddy(buddy)
      },
      onBuddyInfoChange: (infos: Map<string, ProfileSimpleInfo>) => {
        for (const buddy of infos.values()) this.upsertBuddy(buddy)
      },
    } as never)
    this.buddyListenerId = session.getBuddyService().addKernelBuddyListener(buddyListener)
    const groupListener = new kernel.NodeIKernelGroupListener({
      onGroupListUpdate: (_type: number, groups: Array<{
        groupCode: string, groupName: string, remarkName?: string, avatarUrl?: string
      }>) => {
        for (const group of groups) {
          const item: QQConversation = {
            id: conversationId(CHAT_GROUP, group.groupCode), kind: 'group',
            title: group.remarkName || group.groupName || group.groupCode,
            peerUid: group.groupCode, peerUin: group.groupCode, chatType: CHAT_GROUP,
            avatarUrl: group.avatarUrl,
          }
          this.contacts.set(item.id, item)
        }
      },
    } as never)
    this.groupListenerId = session.getGroupService().addKernelGroupListener(groupListener)
  }

  private onMessages(records: MsgRecord[]): void {
    for (const record of records) {
      if (record.chatType !== CHAT_C2C && record.chatType !== CHAT_GROUP) continue
      const pending = this.pendingMessages.get(record.msgId)
      if (pending && record.sendStatus >= 2) {
        this.pendingMessages.delete(record.msgId)
        pending.resolve(record)
      }
      const conversation = this.conversationFromRecord(record)
      this.dispatch({ type: 'message', conversation, message: this.mapMessage(record) })
    }
  }

  private onDelete(chatType: number, peerUid: string, ids: string[]): void {
    if (chatType !== CHAT_C2C && chatType !== CHAT_GROUP) return
    const id = conversationId(chatType, peerUid)
    const conversation = this.contacts.get(id) ?? this.getConversation(id)
    this.dispatch({
      type: 'message-delete',
      eventId: `delete:${chatType}:${peerUid}:${ids.join(',')}:${Date.now()}`,
      conversation,
      messageIds: ids,
      timestamp: Math.floor(Date.now() / 1000),
    })
  }

  private onDownload(info: FileTransNotifyInfo): void {
    const pending = this.pendingDownloads.get(`${info.msgId}:${info.msgElementId}`)
    if (!pending) return
    this.pendingDownloads.delete(`${info.msgId}:${info.msgElementId}`)
    pending.resolve(info)
  }

  private dispatch(event: QQEvent): void {
    for (const queue of this.events) queue.push(event)
  }

  private upsertRecent(item: RecentContactInfo): void {
    if (item.chatType !== CHAT_C2C && item.chatType !== CHAT_GROUP) return
    const conversation: QQConversation = {
      id: conversationId(item.chatType, item.peerUid),
      kind: item.chatType === CHAT_GROUP ? 'group' : 'direct',
      title: item.remark || item.peerName || item.peerUin || item.peerUid,
      peerUid: item.peerUid,
      peerUin: item.peerUin || (item.chatType === CHAT_GROUP ? item.peerUid : ''),
      chatType: item.chatType,
      avatarUrl: item.avatarUrl,
      unreadCount: Number(item.unreadCnt) || 0,
    }
    this.contacts.set(conversation.id, conversation)
  }

  private upsertBuddy(buddy: ProfileSimpleInfo): void {
    const user = {
      id: buddy.uid, numericId: buddy.uin, name: buddy.remark || buddy.nick || buddy.uin, avatarUrl: buddy.avatarUrl,
    }
    this.users.set(buddy.uid, user)
    const id = conversationId(CHAT_C2C, buddy.uid)
    const current = this.contacts.get(id)
    this.contacts.set(id, {
      id, kind: 'direct', title: user.name, peerUid: buddy.uid, peerUin: buddy.uin,
      chatType: CHAT_C2C, avatarUrl: buddy.avatarUrl, unreadCount: current?.unreadCount,
      lastMessage: current?.lastMessage,
    })
  }

  private conversationFromRecord(record: MsgRecord): QQConversation {
    const id = conversationId(record.chatType as 1 | 2, record.peerUid)
    const current = this.contacts.get(id)
    const conversation: QQConversation = {
      id,
      kind: record.chatType === CHAT_GROUP ? 'group' : 'direct',
      title: current?.title || record.peerName || record.peerUin || record.peerUid,
      peerUid: record.peerUid,
      peerUin: current?.peerUin || record.peerUin || (record.chatType === CHAT_GROUP ? record.peerUid : ''),
      chatType: record.chatType as 1 | 2,
      avatarUrl: current?.avatarUrl,
      unreadCount: current?.unreadCount,
    }
    conversation.lastMessage = this.mapMessage(record)
    this.contacts.set(id, conversation)
    return conversation
  }

  private mapMessage(record: MsgRecord): QQMessage {
    const parts: QQMessage['parts'] = []
    for (const element of record.elements ?? []) {
      if (element.elementType === ELEMENT_TEXT && element.textElement?.content) {
        parts.push({ type: 'text', text: element.textElement.content })
      } else {
        const media = mapMedia(record, element)
        if (media) parts.push({ type: 'media', media })
      }
    }
    return {
      id: record.msgId,
      sourceIds: record.elements?.map((element) => element.elementId).filter(Boolean),
      conversationId: conversationId(record.chatType as 1 | 2, record.peerUid),
      senderId: record.senderUid || record.senderUin,
      timestamp: Number(record.msgTime) || Math.floor(Date.now() / 1000),
      outgoing: SEND_FROM_SELF.has(record.sendType) || record.senderUid === this.config?.selfUid,
      parts,
    }
  }

  private requireSession(): KernelSession {
    if (!this.session) throw new Error('QQNT kernel is not ready')
    return this.session
  }
}

function contact(conversation: QQConversation) {
  return { chatType: conversation.chatType, peerUid: conversation.peerUid, guildId: '' }
}

function textElement(text: string): MsgElement {
  return {
    elementType: ELEMENT_TEXT,
    elementId: '',
    textElement: { content: text, atType: 0, atUid: '', atTinyId: '', atNtUid: '' } as never,
  }
}

function imageElement(path: string, name: string, size: number): MsgElement {
  const md5 = hashFile(path, 'md5')
  return {
    elementType: ELEMENT_IMAGE,
    elementId: '',
    picElement: {
      picSubType: 0,
      fileName: name,
      fileSize: String(size),
      picWidth: 0,
      picHeight: 0,
      original: true,
      md5HexStr: md5,
      sourcePath: path,
      fileUuid: '',
      fileSubId: '',
      thumbFileSize: 0,
      originImageMd5: md5,
    } as never,
  }
}

function fileElement(path: string, name: string, size: number): MsgElement {
  const md5 = hashFile(path, 'md5')
  const sha = hashFile(path, 'sha1')
  return {
    elementType: ELEMENT_FILE,
    elementId: '',
    fileElement: {
      fileMd5: md5,
      fileName: name,
      filePath: path,
      fileSize: String(size),
      file10MMd5: md5,
      fileSha: sha,
      fileSha3: sha,
      fileUuid: '',
      fileSubId: '',
    },
  }
}

function hashFile(path: string, algorithm: string): string {
  const hash = createHash(algorithm)
  const fd = createReadStream(path)
  // Files have already arrived on disk. This synchronous-looking helper is
  // intentionally avoided; hash small metadata while streaming via readFile
  // would duplicate the whole file. QQ accepts blank hashes and computes them.
  fd.destroy()
  return hash.digest('hex')
}

function mapMedia(record: MsgRecord, element: MsgElement): QQMedia | undefined {
  const base = {
    messageId: record.msgId,
    elementId: element.elementId,
    chatType: record.chatType as 1 | 2,
    peerUid: record.peerUid,
  }
  if (element.picElement) {
    const picture = element.picElement
    const local = picture.sourcePath || [...(picture.thumbPath?.values() ?? [])][0]
    return {
      id: element.elementId || `${record.msgId}:image`,
      kind: 'image',
      name: picture.fileName,
      size: numberOrUndefined(picture.fileSize),
      width: picture.picWidth || undefined,
      height: picture.picHeight || undefined,
      locator: {
        ...base, kind: 'image', fileName: picture.fileName, fileSize: picture.fileSize,
        filePath: local, fileUuid: picture.fileUuid, fileSubId: picture.fileSubId,
        fileBizId: picture.fileBizId, md5: picture.md5HexStr,
      },
    }
  }
  if (element.fileElement) {
    const file = element.fileElement
    return {
      id: element.elementId || `${record.msgId}:file`,
      kind: 'file',
      name: file.fileName,
      size: numberOrUndefined(file.fileSize),
      locator: {
        ...base, kind: 'file', fileName: file.fileName, fileSize: file.fileSize,
        filePath: file.filePath, fileUuid: file.fileUuid, fileSubId: file.fileSubId,
        fileBizId: file.fileBizId, md5: file.fileMd5, sha: file.fileSha, sha3: file.fileSha3,
      },
    }
  }
}

function mapMember(info: MemberInfo): MemberPage['members'][number] {
  return {
    user: { id: info.uid, numericId: info.uin, name: info.cardName || info.remark || info.nick || info.uin },
    role: info.role === MEMBER_OWNER ? 'owner' : info.role === MEMBER_ADMIN ? 'administrator' : 'member',
  }
}

function parseCursor(value?: string): number {
  const parsed = Number(value ?? 0)
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.trunc(value)))
}

function numberOrUndefined(value?: string): number | undefined {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined
}

function safeExtension(name: string): string {
  const extension = extname(basename(name)).replace(/[^.a-zA-Z0-9]/g, '')
  return extension.slice(0, 16)
}

function encodeMemberCursor(value?: { uid: string, index: number }): string | undefined {
  return value ? Buffer.from(JSON.stringify(value)).toString('base64url') : undefined
}

function decodeMemberCursor(value?: string): { uid: string, index: number } {
  if (!value) return { uid: '', index: 0 }
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString()) as { uid?: unknown, index?: unknown }
    return {
      uid: typeof parsed.uid === 'string' ? parsed.uid : '',
      index: typeof parsed.index === 'number' ? parsed.index : 0,
    }
  } catch {
    throw new Error('invalid member cursor')
  }
}

async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms) }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
