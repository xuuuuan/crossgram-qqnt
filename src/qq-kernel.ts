import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync, mkdirSync, statSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import type { Readable } from 'node:stream'
import { AsyncQueue, deferred } from './async.js'
import { log } from './log.js'
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
  private readonly messages = new Map<string, QQMessage[]>()
  private readonly pendingMessages = new Map<string, ReturnType<typeof deferred<MsgRecord>>>()
  private readonly pendingUnassigned: Array<{
    conversationId: string
    pending: ReturnType<typeof deferred<MsgRecord>>
  }> = []
  private readonly pendingDownloads = new Map<string, ReturnType<typeof deferred<FileTransNotifyInfo>>>()
  private listenerId?: string
  private buddyListenerId?: string
  private groupListenerId?: string
  private listenerRetry?: NodeJS.Timeout
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
    try {
      this.registerListeners()
      void this.refreshContacts().catch((error) => log('error', 'initial contact refresh failed', error))
    } catch {
      this.scheduleListenerRegistration()
    }
  }

  detach(): void {
    if (this.listenerRetry) clearTimeout(this.listenerRetry)
    this.listenerRetry = undefined
    const msgService = this.session?.getMsgService()
    const buddyService = this.session?.getBuddyService()
    const groupService = this.session?.getGroupService()
    if (msgService && this.listenerId) msgService.removeKernelMsgListener(this.listenerId)
    if (buddyService && this.buddyListenerId) buddyService.removeKernelBuddyListener(this.buddyListenerId)
    if (groupService && this.groupListenerId) groupService.removeKernelGroupListener(this.groupListenerId)
    this.listenerId = this.buddyListenerId = this.groupListenerId = undefined
    this.session = undefined
    for (const pending of this.pendingMessages.values()) pending.reject(new Error('QQNT session detached'))
    for (const pending of this.pendingDownloads.values()) pending.reject(new Error('QQNT session detached'))
    this.pendingMessages.clear()
    this.pendingUnassigned.splice(0)
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
    const recentService = session.getRecentContactService()
    const recent = await recentService.getRecentContactInfos()
    if (recent.result !== 0) throw new Error(`getRecentContactInfos: ${recent.errMsg} (${recent.result})`)
    for (const item of recent.relation) this.upsertRecent(item)
    // These methods deliver their actual data through listeners.
    await Promise.allSettled([
      session.getBuddyService().getBuddyList(false),
      session.getGroupService().getGroupList(false),
    ])
  }

  async getDialogs(cursor?: string, limit = 100): Promise<{ conversations: QQConversation[], nextCursor?: string }> {
    // A refresh failure must not erase/block the already subscribed recent
    // contact snapshot (QQ can transiently reject this call during startup).
    await this.refreshContacts().catch((error) => log('error', 'dialog refresh failed; using cache', error))
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
    const peer = contact(conversation)
    const modern = !service.getMsgUniqueId
    const request = !query.beforeId && !query.afterId && !query.cursor && service.getLatestDbMsgs
      ? modern
        ? (service.getLatestDbMsgs as unknown as (
            params: { peer: ReturnType<typeof contact>, cnt: number }, config: undefined
          ) => Promise<{ result: number, errMsg: string, msgList: MsgRecord[] }>)({ peer, cnt: limit }, undefined)
        : service.getLatestDbMsgs({ peer, cnt: limit })
      : modern
        ? (service.getMsgs as unknown as (params: {
            peer: ReturnType<typeof contact>, msgId: string, cnt: number, queryOrder: boolean
          }, config: undefined) => Promise<{ result: number, errMsg: string, msgList: MsgRecord[] }>)({
            peer, msgId: anchor, cnt: limit, queryOrder: !query.afterId,
          }, undefined)
        : service.getMsgs(peer, anchor, limit, !query.afterId)
    const response = await withTimeout(request, 5_000, 'QQ history request timed out').catch((error) => {
      if (query.beforeId || query.afterId || query.cursor) throw error
      return { result: 0, errMsg: '', msgList: [] as MsgRecord[] }
    })
    if (response.result !== 0) throw new Error(`getMsgs: ${response.errMsg} (${response.result})`)
    const messages = response.msgList.map((record) => this.mapMessage(record))
    if (!messages.length && !query.beforeId && !query.afterId && !query.cursor) {
      const cached = this.messages.get(conversation.id) ?? []
      return { messages: cached.slice(-limit).reverse() }
    }
    const last = response.msgList.at(-1)
    return { messages, nextCursor: messages.length === limit ? last?.msgId : undefined }
  }

  async getMessage(conversation: QQConversation, id: string): Promise<QQMessage | null> {
    const service = this.requireSession().getMsgService()
    const peer = contact(conversation)
    const response = service.getMsgUniqueId
      ? await service.getMsgsByMsgId(peer, [id])
      : await (service.getMsgsByMsgId as unknown as (params: {
          peer: ReturnType<typeof contact>, msgIds: string[]
        }, config: undefined) => Promise<{ result: number, errMsg: string, msgList: MsgRecord[] }>)(
          { peer, msgIds: [id] }, undefined,
        )
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
        elements.push(spec.kind === 'image'
          ? await imageElement(path, spec.name, size)
          : await fileElement(path, spec.name, size))
      } else {
        body.resume()
      }
      if (!elements.length) throw new Error('message must contain text or media')
      const service = this.requireSession().getMsgService()
      const startedAt = Math.floor(Date.now() / 1000)
      const id = service.getMsgUniqueId?.(String(Math.floor(Date.now() / 1000))) ?? '0'
      const pending = deferred<MsgRecord>()
      if (id === '0') this.pendingUnassigned.push({ conversationId: conversation.id, pending })
      else this.pendingMessages.set(id, pending)
      const peer = contact(conversation)
      // This is the raw native service, not QQ's renderer-side generated
      // object-parameter proxy. sendMsg uses four positional arguments.
      const result = await retryTransientInvalidArgumentResult(
        () => service.sendMsg(id, peer, elements, new Map()),
      )
      if (result.result !== 0) {
        this.pendingMessages.delete(id)
        removePending(this.pendingUnassigned, pending)
        throw new Error(`sendMsg: ${result.errMsg} (${result.result})`)
      }
      const pollController = new AbortController()
      const record = await withTimeout(Promise.race([
        pending.promise,
        this.pollSentMessage(conversation, manifest.text, startedAt, pollController.signal),
      ]), this.sendTimeoutMs, `QQ did not confirm message ${id}`)
        .finally(() => {
          pollController.abort()
          this.pendingMessages.delete(id)
          removePending(this.pendingUnassigned, pending)
        })
      return this.mapMessage(record)
    } finally {
      await Promise.all(cleanup.map((path) => rm(path, { force: true }).catch(() => undefined)))
    }
  }

  async deleteMessages(conversation: QQConversation, ids: string[], forEveryone: boolean): Promise<void> {
    const service = this.requireSession().getMsgService()
    const peer = contact(conversation)
    const modern = !service.getMsgUniqueId
    const result = forEveryone
      ? modern
        ? await (service.recallMsg as unknown as (params: {
            peer: ReturnType<typeof contact>, msgIds: string[]
          }, config: undefined) => Promise<{ result: number, errMsg: string }>)({ peer, msgIds: ids }, undefined)
        : await service.recallMsg(peer, ids)
      : modern
        ? await (service.deleteMsg as unknown as (params: {
            peer: ReturnType<typeof contact>, msgIds: string[]
          }, config: undefined) => Promise<{ result: number, errMsg: string }>)({ peer, msgIds: ids }, undefined)
        : await service.deleteMsg(peer, ids)
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
    const msgService = session.getMsgService()
    const buddyService = session.getBuddyService()
    const groupService = session.getGroupService()
    if (!msgService || !buddyService || !groupService) throw new Error('QQNT kernel services are not initialized yet')
    const msgListener = makeListener(kernel.NodeIKernelMsgListener, {
      onRecvMsg: (value: MsgRecord[] | { msgList: MsgRecord[] }) =>
        this.onMessages(Array.isArray(value) ? value : value.msgList),
      onAddSendMsg: (value: MsgRecord | { msgRecord: MsgRecord }) =>
        this.onMessages(['msgRecord' in value ? value.msgRecord : value]),
      onMsgInfoListUpdate: (value: MsgRecord[] | { msgList: MsgRecord[] }) =>
        this.onMessages(Array.isArray(value) ? value : value.msgList),
      onMsgRecall: (
        value: number | { chatType: number, peerUid: string, seq: string },
        peerUid?: string,
        seq?: string,
      ) => typeof value === 'object'
        ? this.onDelete(value.chatType, value.peerUid, [value.seq])
        : this.onDelete(value, peerUid!, [seq!]),
      onMsgDelete: (
        value: { chatType: number, peerUid: string } | {
          peer: { chatType: number, peerUid: string }
          msgIds: string[]
        },
        ids?: string[],
      ) => 'peer' in value
        ? this.onDelete(value.peer.chatType, value.peer.peerUid, value.msgIds)
        : this.onDelete(value.chatType, value.peerUid, ids ?? []),
      onRichMediaDownloadComplete: (value: FileTransNotifyInfo | { notifyInfo: FileTransNotifyInfo }) =>
        this.onDownload('notifyInfo' in value ? value.notifyInfo : value),
    })
    this.listenerId = msgService.addKernelMsgListener(msgListener)
    const buddyListener = makeListener(kernel.NodeIKernelBuddyListener, {
      onBuddyListChange: (value: Array<{ buddyList: ProfileSimpleInfo[] }> | {
        data: Array<{ buddyList: ProfileSimpleInfo[] }>
      }) => {
        const categories = Array.isArray(value) ? value : value.data
        for (const category of categories) for (const buddy of category.buddyList) this.upsertBuddy(buddy)
      },
      onBuddyInfoChange: (value: Map<string, ProfileSimpleInfo> | { infos: Map<string, ProfileSimpleInfo> }) => {
        const infos = value instanceof Map ? value : value.infos
        for (const buddy of infos.values()) this.upsertBuddy(buddy)
      },
    })
    this.buddyListenerId = buddyService.addKernelBuddyListener(buddyListener)
    const groupListener = makeListener(kernel.NodeIKernelGroupListener, {
      onGroupListUpdate: (
        value: number | {
          groupList: Array<{ groupCode: string, groupName: string, remarkName?: string, avatarUrl?: string }>
        },
        legacyGroups?: Array<{ groupCode: string, groupName: string, remarkName?: string, avatarUrl?: string }>,
      ) => {
        const groups = typeof value === 'object' ? value.groupList : legacyGroups ?? []
        for (const group of groups) {
          const id = conversationId(CHAT_GROUP, group.groupCode)
          const current = this.contacts.get(id)
          // Group membership is an address-book fact, not a recent dialog.
          if (!current) continue
          const item: QQConversation = {
            id, kind: 'group',
            title: group.remarkName || group.groupName || group.groupCode,
            peerUid: group.groupCode, peerUin: group.groupCode, chatType: CHAT_GROUP,
            avatarUrl: group.avatarUrl,
          }
          this.contacts.set(item.id, item)
        }
      },
    })
    this.groupListenerId = groupService.addKernelGroupListener(groupListener)
  }

  private scheduleListenerRegistration(attempt = 1): void {
    this.listenerRetry = setTimeout(() => {
      this.listenerRetry = undefined
      if (!this.session || this.listenerId) return
      try {
        this.registerListeners()
        log('info', 'QQNT kernel listeners registered')
        void this.refreshContacts().catch((error) => log('error', 'initial contact refresh failed', error))
      } catch (error) {
        if (attempt >= 120) {
          log('error', 'QQNT kernel services did not become ready', error)
          return
        }
        this.scheduleListenerRegistration(attempt + 1)
      }
    }, attempt === 1 ? 0 : 250)
  }

  private onMessages(records: MsgRecord[]): void {
    for (const record of records) {
      if (record.chatType !== CHAT_C2C && record.chatType !== CHAT_GROUP) continue
      if (record.senderUid === this.config?.selfUid || SEND_FROM_SELF.has(record.sendType)) {
        log('info', `outgoing message event id=${record.msgId} peer=${record.peerUid} status=${record.sendStatus}`)
      }
      const pending = this.pendingMessages.get(record.msgId)
      // onAddSendMsg already carries QQ's final server-facing msgId/elementId.
      // Some groups never emit a later sendStatus=2 update to this listener.
      if (pending && record.sendStatus >= 1 && record.msgId !== '0') {
        this.pendingMessages.delete(record.msgId)
        pending.resolve(record)
      } else if (record.sendStatus >= 1 && record.msgId !== '0') {
        const id = conversationId(record.chatType as 1 | 2, record.peerUid)
        const index = this.pendingUnassigned.findIndex((item) => item.conversationId === id)
        if (index >= 0) this.pendingUnassigned.splice(index, 1)[0].pending.resolve(record)
      }
      const conversation = this.conversationFromRecord(record)
      const message = this.mapMessage(record)
      this.rememberMessage(message)
      this.dispatch({ type: 'message', conversation, message })
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

  private rememberMessage(message: QQMessage): void {
    const messages = this.messages.get(message.conversationId) ?? []
    const existing = messages.findIndex((item) => item.id === message.id)
    if (existing >= 0) messages[existing] = message
    else messages.push(message)
    if (messages.length > 1_000) messages.splice(0, messages.length - 1_000)
    this.messages.set(message.conversationId, messages)
  }

  private async pollSentMessage(
    conversation: QQConversation,
    expectedText: string | undefined,
    startedAt: number,
    signal: AbortSignal,
  ): Promise<MsgRecord> {
    // Some QQ groups only emit the initial sendStatus=1 notification. Poll the
    // native DB until the final server-assigned message ID appears.
    await new Promise((resolve) => setTimeout(resolve, 300))
    while (true) {
      if (signal.aborted) throw signal.reason ?? new Error('send confirmation polling aborted')
      const cached = (this.messages.get(conversation.id) ?? []).slice(-20).reverse()
      let found = cached.find((message) =>
        message.outgoing
        && message.timestamp >= startedAt - 2
        && (expectedText === undefined || message.parts.some((part) => part.type === 'text' && part.text === expectedText)))
      if (!found) {
        const page = await withTimeout(
          this.getHistory(conversation, { limit: 20 }),
          2_000,
          'QQ history confirmation timed out',
        ).catch(() => ({ messages: [] }))
        found = page.messages.find((message) =>
          message.outgoing
          && message.timestamp >= startedAt - 2
          && (expectedText === undefined || message.parts.some((part) => part.type === 'text' && part.text === expectedText)))
      }
      if (found) return {
        msgId: found.id,
        chatType: conversation.chatType,
        sendType: 1,
        senderUid: found.senderId,
        senderUin: '',
        peerUid: conversation.peerUid,
        peerUin: conversation.peerUin,
        peerName: conversation.title,
        msgTime: String(found.timestamp),
        sendStatus: 2,
        sendRemarkName: '',
        sendMemberName: '',
        sendNickName: '',
        elements: found.parts.map((part, index): MsgElement => part.type === 'text'
          ? { elementType: ELEMENT_TEXT, elementId: found.sourceIds?.[index] ?? '', textElement: { content: part.text } }
          : { elementType: part.media.kind === 'image' ? ELEMENT_IMAGE : ELEMENT_FILE, elementId: part.media.id }),
      }
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
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
    // Do not project the complete friend list as dialogs. Buddy updates only
    // enrich conversations introduced by RecentContact or explicit resolve.
    if (!current) return
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

async function imageElement(path: string, name: string, size: number): Promise<MsgElement> {
  const md5 = await hashFile(path, 'md5')
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

async function fileElement(path: string, name: string, size: number): Promise<MsgElement> {
  const [md5, sha] = await Promise.all([hashFile(path, 'md5'), hashFile(path, 'sha1')])
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

async function hashFile(path: string, algorithm: string): Promise<string> {
  const hash = createHash(algorithm)
  for await (const chunk of createReadStream(path)) hash.update(chunk)
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

function makeListener(
  Constructor: (new (handlers: Record<string, (...args: never[]) => unknown>) => unknown) | undefined,
  handlers: Record<string, (...args: never[]) => unknown>,
): unknown {
  // QQNT 6.9.96 exports listener wrapper constructors. QQNT 6.9.98 accepts a
  // plain callback object directly and no longer exports those constructors.
  return Constructor ? new Constructor(handlers) : handlers
}

function removePending(
  list: Array<{ pending: ReturnType<typeof deferred<MsgRecord>> }>,
  pending: ReturnType<typeof deferred<MsgRecord>>,
): void {
  const index = list.findIndex((item) => item.pending === pending)
  if (index >= 0) list.splice(index, 1)
}

async function retryTransientInvalidArgument<T>(operation: () => Promise<T>): Promise<T> {
  let lastError: unknown
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await operation()
    } catch (error) {
      lastError = error
      if (!String(error).includes('Invalid argument') || attempt === 2) throw error
      await new Promise((resolve) => setTimeout(resolve, 300 * (attempt + 1)))
    }
  }
  throw lastError
}

async function retryTransientInvalidArgumentResult(
  operation: () => Promise<{ result: number, errMsg: string }>,
): Promise<{ result: number, errMsg: string }> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const result = await retryTransientInvalidArgument(operation)
    if (result.result === 0 || !result.errMsg.includes('Invalid argument') || attempt === 2) return result
    await new Promise((resolve) => setTimeout(resolve, 300 * (attempt + 1)))
  }
  throw new Error('unreachable')
}
