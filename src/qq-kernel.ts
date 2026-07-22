import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync, mkdirSync, statSync } from 'node:fs'
import { readFile, rm, stat } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'
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
  type QQMedia, type QQMediaLocator, type QQMessage, type QQReactionContext, type QQReactionDefinition, type SendManifest,
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
  private readonly groups = new Map<string, { name: string, avatarUrl?: string }>()
  private buddySnapshotLoaded = false
  private readonly messages = new Map<string, QQMessage[]>()
  private reactionDefinitions: QQReactionDefinition[] = []
  private readonly reactionByKey = new Map<string, QQReactionDefinition>()
  private readonly pendingMessages = new Map<string, ReturnType<typeof deferred<MsgRecord>>>()
  private readonly pendingUnassigned: Array<{
    conversationId: string
    pending: ReturnType<typeof deferred<MsgRecord>>
    minimumStatus: number
    startedAt: number
    expectedText?: string
    expectedMediaName?: string
    expectedMediaKind?: 'image' | 'file'
  }> = []
  private readonly pendingDownloads = new Map<string, ReturnType<typeof deferred<FileTransNotifyInfo>>>()
  private readonly pendingReactions = new Map<string, ReturnType<typeof deferred<QQReactionContext>>>()
  private listenerId?: string
  private buddyListenerId?: string
  private groupListenerId?: string
  private recentListenerId?: string
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
    // A native wrapper can be re-initialized after logout/account switching.
    // Never leak the previous account's seen peers into the new address book.
    this.contacts.clear()
    this.users.clear()
    this.groups.clear()
    this.messages.clear()
    this.buddySnapshotLoaded = false
    this.kernel = kernel
    this.session = session
    this.config = config
    this.users.set(config.selfUid, {
      id: config.selfUid,
      numericId: config.selfUin,
      name: config.selfUin,
    })
    try {
      this.registerListeners()
      void this.initializePlatformData()
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
    const recentService = this.session?.getRecentContactService()
    if (msgService && this.listenerId) msgService.removeKernelMsgListener(this.listenerId)
    if (buddyService && this.buddyListenerId) buddyService.removeKernelBuddyListener(this.buddyListenerId)
    if (groupService && this.groupListenerId) groupService.removeKernelGroupListener(this.groupListenerId)
    if (recentService?.removeKernelRecentContactListener && this.recentListenerId) {
      recentService.removeKernelRecentContactListener(this.recentListenerId)
    }
    this.listenerId = this.buddyListenerId = this.groupListenerId = undefined
    this.session = undefined
    for (const pending of this.pendingMessages.values()) pending.reject(new Error('QQNT session detached'))
    for (const pending of this.pendingDownloads.values()) pending.reject(new Error('QQNT session detached'))
    this.pendingMessages.clear()
    this.pendingUnassigned.splice(0)
    this.pendingDownloads.clear()
    for (const pending of this.pendingReactions.values()) pending.reject(new Error('QQNT session detached'))
    this.pendingReactions.clear()
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
    let recentError: unknown
    try {
      const recent = await recentService.getRecentContactInfos()
      if (recent.result !== 0) throw new Error(`getRecentContactInfos: ${recent.errMsg} (${recent.result})`)
      for (const item of recent.relation) this.upsertRecent(item)
    } catch (error) {
      recentError = error
    }
    // These methods deliver their actual data through listeners.
    await Promise.allSettled([
      this.requestBuddyList(),
      this.requestGroupList(),
    ])
    if (recentError) throw recentError
  }

  async getDialogs(cursor?: string, limit = 100): Promise<{ conversations: QQConversation[], nextCursor?: string }> {
    // A refresh failure must not erase/block the already subscribed recent
    // contact snapshot (QQ can transiently reject this call during startup).
    if (!this.contacts.size) {
      await withTimeout(this.refreshContacts(), 5_000, 'QQ dialog refresh timed out')
        .catch((error) => log('error', 'dialog refresh failed; using cache', error))
    }
    const dialogs = [...this.contacts.values()]
    const offset = parseCursor(cursor)
    const page = await Promise.all(dialogs.slice(offset, offset + clamp(limit, 1, 500))
      .map((conversation) => this.withConversationAvatar(conversation)))
    return {
      conversations: page,
      nextCursor: offset + page.length < dialogs.length ? String(offset + page.length) : undefined,
    }
  }

  async getContacts(cursor?: string, limit = 500): Promise<{
    users: Array<{ id: string, numericId?: string, name: string, avatar?: QQMedia }>
    nextCursor?: string
  }> {
    // getBuddyList delivers the full address book through onBuddyListChange.
    for (let attempt = 0; !this.buddySnapshotLoaded && attempt < 10; attempt++) {
      try {
        await withTimeout(this.requestBuddyList(), 2_000, 'QQ buddy refresh timed out')
      } catch {
        // QQ can reject duplicate refreshes while its own UI is fetching. The
        // listener-maintained full buddy snapshot remains authoritative.
      }
      if (!this.buddySnapshotLoaded) await new Promise((resolve) => setTimeout(resolve, 250))
    }
    const all = [...this.users.values()].sort((left, right) => left.name.localeCompare(right.name))
    const offset = parseCursor(cursor)
    const selected = all.slice(offset, offset + clamp(limit, 1, 1_000))
    // Bounded concurrency avoids a native thundering herd while ensuring a
    // cold-cache miss does not stay permanent.
    const users = await mapConcurrent(selected, 4, async (user) => ({
      ...user,
      avatar: await this.userAvatar(user.id),
    }))
    return { users, nextCursor: offset + users.length < all.length ? String(offset + users.length) : undefined }
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

  getConversationDetails(id: string): Promise<QQConversation> {
    return this.withConversationAvatar(this.getConversation(id))
  }

  async resolveConversation(chatType: 1 | 2, numericId: string): Promise<QQConversation> {
    const known = [...this.contacts.values()].find((item) => item.chatType === chatType && item.peerUin === numericId)
    if (known) return this.withConversationAvatar(known)
    if (chatType === CHAT_GROUP) {
      const created: QQConversation = {
        id: conversationId(CHAT_GROUP, numericId), kind: 'group', title: numericId,
        peerUid: numericId, peerUin: numericId, chatType: CHAT_GROUP,
      }
      this.contacts.set(created.id, created)
      return this.withConversationAvatar(created)
    }
    const buddy = [...this.users.values()].find((user) => user.numericId === numericId)
    if (buddy) {
      const created: QQConversation = {
        id: conversationId(CHAT_C2C, buddy.id), kind: 'direct', title: buddy.name,
        peerUid: buddy.id, peerUin: numericId, chatType: CHAT_C2C,
      }
      this.contacts.set(created.id, created)
      return this.withConversationAvatar(created)
    }
    const converted = await retryTransientInvalidArgument(
      () => this.requireSession().getUixConvertService().getUid(new Set([numericId])),
    )
    const peerUid = converted.uidInfo.get(numericId)
    if (!peerUid) throw new Error(`QQ user ${numericId} could not be resolved to a UID`)
    const created: QQConversation = {
      id: conversationId(CHAT_C2C, peerUid), kind: 'direct', title: numericId,
      peerUid, peerUin: numericId, chatType: CHAT_C2C,
    }
    this.contacts.set(created.id, created)
    return this.withConversationAvatar(created)
  }

  async getHistory(conversation: QQConversation, query: HistoryQuery = {}): Promise<{ messages: QQMessage[], nextCursor?: string }> {
    const service = this.requireSession().getMsgService()
    const limit = clamp(query.limit ?? 50, 1, 100)
    const anchor = query.beforeId ?? query.afterId ?? query.cursor ?? '0'
    const peer = contact(conversation)
    const initial = !query.beforeId && !query.afterId && !query.cursor
    let response: { result: number, errMsg: string, msgList: MsgRecord[] }
    try {
      const request = Promise.resolve().then(() => initial && service.getLatestDbMsgs
        ? service.getLatestDbMsgs(peer, limit)
        : service.getMsgs(peer, anchor, limit, !query.afterId))
      response = await withTimeout(request, 5_000, 'QQ history request timed out')
      // Some QQNT releases expose getLatestDbMsgs but return an initialization
      // error for it. getMsgs(peer, "0", ...) is the documented equivalent.
      if (initial && response.result !== 0) {
        response = await withTimeout(
          service.getMsgs(peer, '0', limit, true),
          5_000,
          'QQ history fallback request timed out',
        )
      }
    } catch (error) {
      if (!initial) throw error
      response = await withTimeout(
        service.getMsgs(peer, '0', limit, true),
        5_000,
        'QQ history fallback request timed out',
      ).catch((fallbackError) => {
        log('error', 'QQ history requests failed; using cache', error, fallbackError)
        return { result: 0, errMsg: '', msgList: [] as MsgRecord[] }
      })
    }
    if (response.result !== 0) {
      if (!query.beforeId && !query.afterId && !query.cursor) {
        const cached = this.messages.get(conversation.id) ?? []
        return { messages: cached.slice(-limit).reverse() }
      }
      throw new Error(`getMsgs: ${response.errMsg} (${response.result})`)
    }
    const messages = response.msgList.map((record) => this.mapMessage(record))
    for (const message of messages) this.rememberMessage(message)
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
    const response = await service.getMsgsByMsgId(peer, [id])
    if (response.result !== 0) throw new Error(`getMsgsByMsgId: ${response.errMsg} (${response.result})`)
    if (!response.msgList[0]) return null
    const message = this.mapMessage(response.msgList[0])
    this.rememberMessage(message)
    return message
  }

  async send(manifest: SendManifest, body: Readable): Promise<QQMessage> {
    const conversation = this.getConversation(manifest.conversationId)
    const elements: MsgElement[] = []
    if (manifest.text) elements.push(textElement(manifest.text))
    const cleanup: string[] = []
    let preserveUntil: number | undefined
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
          ? imageElement(path)
          : await fileElement(path, spec.name, size))
      } else {
        body.resume()
      }
      if (!elements.length) throw new Error('message must contain text or media')
      const service = this.requireSession().getMsgService()
      const startedAt = Math.floor(Date.now() / 1000)
      const id = service.getMsgUniqueId?.(String(Math.floor(Date.now() / 1000))) ?? '0'
      const pending = deferred<MsgRecord>()
      if (id === '0') this.pendingUnassigned.push({
        conversationId: conversation.id,
        pending,
        minimumStatus: 1,
        startedAt,
        expectedText: manifest.text,
        expectedMediaName: manifest.media?.[0]?.name,
        expectedMediaKind: manifest.media?.[0]?.kind,
      })
      else this.pendingMessages.set(id, pending)
      const peer = contact(conversation)
      // This is the raw native service, not QQ's renderer-side generated
      // object-parameter proxy. sendMsg uses four positional arguments.
      const nativeSend = retryTransientInvalidArgumentResult(
        () => withTimeout(
          service.sendMsg(id, peer, elements, new Map()),
          5_000,
          'QQ sendMsg timed out',
        ),
      )
      const result = await Promise.race([
        nativeSend,
        pending.promise.then(() => ({ result: 0, errMsg: '' })),
      ])
      if (result.result !== 0) {
        this.pendingMessages.delete(id)
        removePending(this.pendingUnassigned, pending)
        throw new Error(`sendMsg: ${result.errMsg} (${result.result})`)
      }
      const pollController = new AbortController()
      const confirmationPoll = manifest.media?.length
        ? new Promise<MsgRecord>(() => undefined)
        : this.pollSentMessage(conversation, manifest.text, startedAt, pollController.signal)
      const record = await withTimeout(Promise.race([
        pending.promise,
        confirmationPoll,
      ]), this.sendTimeoutMs, `QQ did not confirm message ${id}`)
        .finally(() => {
          pollController.abort()
          this.pendingMessages.delete(id)
          removePending(this.pendingUnassigned, pending)
        })
      const message = this.mapMessage(record)
      if (manifest.media?.length && cleanup[0]) {
        const media = message.parts.find((part) => part.type === 'media')
        if (media?.type === 'media') {
          media.media.locator.filePath = cleanup[0]
          media.media.size ??= manifest.media[0].size
          preserveUntil = Date.now() + 10 * 60_000
        }
      }
      return message
    } finally {
      if (preserveUntil) {
        const delay = Math.max(0, preserveUntil - Date.now())
        for (const path of cleanup) {
          const timer = setTimeout(() => void rm(path, { force: true }).catch(() => undefined), delay)
          timer.unref()
        }
      } else {
        await Promise.all(cleanup.map((path) => rm(path, { force: true }).catch(() => undefined)))
      }
    }
  }

  async deleteMessages(conversation: QQConversation, ids: string[], forEveryone: boolean): Promise<void> {
    const service = this.requireSession().getMsgService()
    const peer = contact(conversation)
    const result = forEveryone
      ? await service.recallMsg(peer, ids)
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
    if (cached) return { ...cached, avatar: await this.userAvatar(uid) }
    const numeric = await this.requireSession().getUixConvertService().getUin(new Set([uid]))
    const numericId = numeric.uinInfo.get(uid)
    return numericId ? { id: uid, numericId, name: numericId, avatar: await this.userAvatar(uid) } : null
  }

  getReactionCatalog(): QQReactionContext {
    return { available: this.reactionDefinitions, reactions: [], maxSelected: 20 }
  }

  async getMessageReactions(conversation: QQConversation, messageId: string): Promise<QQReactionContext> {
    const message = (this.messages.get(conversation.id) ?? []).find((item) => item.id === messageId)
      ?? await withTimeout(this.getMessage(conversation, messageId), 5_000, 'QQ reaction lookup timed out')
    return message?.reactionContext ?? this.getReactionCatalog()
  }

  async setMessageReactions(
    conversation: QQConversation,
    messageId: string,
    reactionKeys: readonly string[],
  ): Promise<QQReactionContext> {
    const service = this.requireSession().getMsgService()
    if (!service.setMsgEmojiLikes) throw new Error('QQ reactions are unavailable in this QQNT build')
    const message = (this.messages.get(conversation.id) ?? []).find((item) => item.id === messageId)
      ?? await this.getMessage(conversation, messageId)
    if (!message) throw new Error(`QQ reaction target not found: ${messageId}`)
    const current = new Set((message.reactionContext?.reactions ?? []).filter((item) => item.selected)
      .map((item) => item.key))
    const desired = new Set(reactionKeys)
    const pendingKey = `${conversation.id}\u0000${message.id}`
    try {
      for (const key of new Set([...current, ...desired])) {
        if (current.has(key) === desired.has(key)) continue
        const [emojiType, emojiId] = splitReactionKey(key)
        const event = deferred<QQReactionContext>()
        this.pendingReactions.set(pendingKey, event)
        let completed = false
        let lastError: unknown
        for (let attempt = 0; !completed && attempt < 5; attempt++) {
          const native = Promise.resolve().then(() => service.setMsgEmojiLikes!(
            contact(conversation), message.msgSeq ?? message.id, emojiId, emojiType, desired.has(key),
          )).then((result) => {
            if (result.result !== 0) throw new Error(`setMsgEmojiLikes: ${result.errMsg} (${result.result})`)
          })
          try {
            await withTimeout(
              Promise.race([native, event.promise.then(() => undefined)]),
              5_000,
              'QQ reaction update timed out',
            )
            completed = true
          } catch (error) {
            lastError = error
            if (attempt < 4) await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)))
          }
        }
        if (!completed) throw lastError
        this.pendingReactions.delete(pendingKey)
      }
      const previous = new Map((message.reactionContext?.reactions ?? []).map((item) => [item.key, item]))
      const reactions = [...new Set([...previous.keys(), ...desired])].flatMap((key) => {
        const item = previous.get(key)
        const wasSelected = item?.selected ?? false
        const selected = desired.has(key)
        const count = Math.max(0, (item?.count ?? 0) + Number(selected) - Number(wasSelected))
        return count || selected ? [{ key, count, selected: selected || undefined }] : []
      })
      message.reactionContext = { available: this.reactionDefinitions, reactions, maxSelected: 20 }
      this.rememberMessage(message)
      return message.reactionContext
    } finally {
      this.pendingReactions.delete(pendingKey)
    }
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
    const recentService = session.getRecentContactService()
    if (!msgService || !buddyService || !groupService) throw new Error('QQNT kernel services are not initialized yet')
    const msgListener = makeListener(kernel.NodeIKernelMsgListener, {
      onRecvMsg: (value: MsgRecord[] | { msgList: MsgRecord[] }) =>
        this.onMessages(Array.isArray(value) ? value : value.msgList),
      onAddSendMsg: (value: MsgRecord | { msgRecord: MsgRecord }) =>
        this.onMessages(['msgRecord' in value ? value.msgRecord : value]),
      onMsgInfoListUpdate: (value: MsgRecord[] | { msgList: MsgRecord[] }) =>
        this.onMessages(Array.isArray(value) ? value : value.msgList, true),
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
        this.buddySnapshotLoaded = true
        log('info', `buddy list update received: ${categories.reduce((sum, item) => sum + item.buddyList.length, 0)} users`)
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
          this.groups.set(group.groupCode, {
            name: group.remarkName || group.groupName || group.groupCode,
            avatarUrl: group.avatarUrl,
          })
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
    if (recentService.addKernelRecentContactListener) {
      const recentListener = makeListener(kernel.NodeIKernelRecentContactListener, {
        onRecentContactListChanged: (value: string[] | RecentContactInfo[] | {
          changedList: RecentContactInfo[]
        }, legacyChanged?: RecentContactInfo[]) => {
          const changed = Array.isArray(value)
            ? (typeof value[0] === 'string' ? legacyChanged ?? [] : value as RecentContactInfo[])
            : value.changedList ?? legacyChanged ?? []
          for (const item of changed) this.upsertRecent(item)
        },
        onRecentContactListChangedVer2: (value: Array<{ changedList?: RecentContactInfo[] }> | {
          changedRecentContactLists?: Array<{ changedList?: RecentContactInfo[] }>
        }) => {
          const lists = Array.isArray(value) ? value : value.changedRecentContactLists ?? []
          for (const list of lists) {
            for (const item of list.changedList ?? []) this.upsertRecent(item)
          }
        },
      })
      this.recentListenerId = recentService.addKernelRecentContactListener(recentListener)
    }
  }

  private scheduleListenerRegistration(attempt = 1): void {
    this.listenerRetry = setTimeout(() => {
      this.listenerRetry = undefined
      if (!this.session || this.listenerId) return
      try {
        this.registerListeners()
        log('info', 'QQNT kernel listeners registered')
        void this.initializePlatformData()
      } catch (error) {
        if (attempt >= 120) {
          log('error', 'QQNT kernel services did not become ready', error)
          return
        }
        this.scheduleListenerRegistration(attempt + 1)
      }
    }, attempt === 1 ? 0 : 250)
  }

  private async requestBuddyList(): Promise<void> {
    const method = this.requireSession().getBuddyService().getBuddyList
      .bind(this.requireSession().getBuddyService())
    let result: unknown
    try {
      result = await method(true)
    } catch (firstError) {
      try {
        result = await (method as unknown as (params: { force_update: boolean }) => Promise<unknown>)({
          force_update: true,
        })
      } catch {
        throw firstError
      }
    }
    this.consumeBuddyPayload(result)
  }

  private async initializePlatformData(): Promise<void> {
    void this.ensureReactionCatalog()
    await this.refreshContacts().catch((error) => log('error', 'initial contact refresh failed', error))
  }

  private async ensureReactionCatalog(): Promise<void> {
    for (let attempt = 0; this.session && !this.reactionDefinitions.length; attempt++) {
      try {
        await withTimeout(this.loadReactionCatalog(), 5_000, 'QQ reaction catalog request timed out')
        if (this.reactionDefinitions.length) return
      } catch (error) {
        if (attempt % 6 === 0) log('error', 'reaction catalog load failed; retrying', error)
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000))
    }
  }

  private async requestGroupList(): Promise<void> {
    const method = this.requireSession().getGroupService().getGroupList
      .bind(this.requireSession().getGroupService())
    try {
      await method(false)
    } catch (firstError) {
      try {
        await (method as unknown as (params: { forceFetch: boolean }) => Promise<unknown>)({
          forceFetch: false,
        })
      } catch {
        throw firstError
      }
    }
  }

  private consumeBuddyPayload(value: unknown): void {
    if (!value || typeof value !== 'object') return
    const object = value as {
      data?: unknown
      categories?: unknown
      buddyList?: unknown
    }
    const candidate = object.data ?? object.categories
    if (Array.isArray(candidate)) {
      this.buddySnapshotLoaded = true
      for (const category of candidate) {
        if (!category || typeof category !== 'object') continue
        const buddies = (category as { buddyList?: unknown }).buddyList
        if (Array.isArray(buddies)) for (const buddy of buddies) this.upsertBuddy(buddy as ProfileSimpleInfo)
      }
    } else if (Array.isArray(object.buddyList)) {
      this.buddySnapshotLoaded = true
      for (const buddy of object.buddyList) this.upsertBuddy(buddy as ProfileSimpleInfo)
    }
  }

  private onMessages(records: MsgRecord[], informationUpdate = false): void {
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
        const index = this.pendingUnassigned.findIndex((item) =>
          item.conversationId === id
          && record.sendStatus >= item.minimumStatus
          && Number(record.msgTime) >= item.startedAt - 2
          && (!item.expectedText || record.elements.some((element) =>
            element.textElement?.content === item.expectedText))
          && (!item.expectedMediaKind || record.elements.some((element) =>
            item.expectedMediaKind === 'image' ? Boolean(element.picElement) : Boolean(element.fileElement)))
          && (!item.expectedMediaName || record.elements.some((element) =>
            element.fileElement?.fileName === item.expectedMediaName
            || element.picElement?.fileName === item.expectedMediaName)
            || item.expectedMediaKind === 'image'))
        if (index >= 0) this.pendingUnassigned.splice(index, 1)[0].pending.resolve(record)
      }
      const conversation = this.conversationFromRecord(record)
      const message = this.mapMessage(record)
      const previous = (this.messages.get(message.conversationId) ?? []).find((item) => item.id === message.id)
      this.rememberMessage(message)
      const reactionsChanged = previous
        && JSON.stringify(previous.reactionContext?.reactions) !== JSON.stringify(message.reactionContext?.reactions)
      if (reactionsChanged || informationUpdate && record.emojiLikesList !== undefined) {
        this.pendingReactions.get(`${conversation.id}\u0000${message.id}`)?.resolve(
          message.reactionContext ?? this.getReactionCatalog(),
        )
        this.dispatch({
          type: 'message-reactions',
          eventId: `reaction:${message.id}:${record.msgSeq ?? Date.now()}`,
          conversation,
          target: { conversationId: conversation.id, messageId: message.id, targetId: message.id },
          context: message.reactionContext ?? this.getReactionCatalog(),
          timestamp: message.timestamp,
        })
      } else if (!previous) {
        this.dispatch({ type: 'message', conversation, message })
      }
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
    const user = item.chatType === CHAT_C2C ? this.users.get(item.peerUid) : undefined
    const group = item.chatType === CHAT_GROUP ? this.groups.get(item.peerUin || item.peerUid) : undefined
    const conversation: QQConversation = {
      id: conversationId(item.chatType, item.peerUid),
      kind: item.chatType === CHAT_GROUP ? 'group' : 'direct',
      title: user?.name || group?.name || item.remark || item.peerName || item.peerUin || item.peerUid,
      peerUid: item.peerUid,
      peerUin: item.peerUin || (item.chatType === CHAT_GROUP ? item.peerUid : ''),
      chatType: item.chatType,
      avatarUrl: user?.avatarUrl || group?.avatarUrl || item.avatarUrl,
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
      msgSeq: record.msgSeq,
      parts,
      reactionContext: this.mapReactionContext(record),
    }
  }

  private mapReactionContext(record: MsgRecord): QQReactionContext {
    const reactions = (record.emojiLikesList ?? []).flatMap((item) => {
      const nativeKey = reactionKey(item.emojiType, item.emojiId)
      const key = this.reactionByKey.get(nativeKey)?.key ?? nativeKey
      return this.reactionByKey.has(nativeKey) || !this.reactionDefinitions.length
        ? [{ key, count: Number(item.likesCnt) || 0, selected: item.isClicked || undefined }]
        : []
    })
    return { available: this.reactionDefinitions, reactions, maxSelected: 20 }
  }

  private async loadReactionCatalog(): Promise<void> {
    const service = this.requireSession().getMsgService()
    const localRoot = this.findLocalReactionRoot()
    let configPath = localRoot ? join(localRoot, 'face_config.json') : ''
    let facePath = localRoot ? join(localRoot, 'sysface_res') : ''
    if (!configPath || !existsSync(configPath) || !existsSync(facePath)) {
      if (!service.getEmojiResourcePath) return
      const [configResult, faceResult] = await Promise.all([
        service.getEmojiResourcePath(0),
        service.getEmojiResourcePath(1),
      ])
      if (configResult.result !== 0 || faceResult.result !== 0) {
        throw new Error(`getEmojiResourcePath: ${configResult.errMsg || faceResult.errMsg}`)
      }
      configPath = configResult.resourcePath
      facePath = faceResult.resourcePath
    }
    const config = JSON.parse(await readFile(configPath, 'utf8')) as {
      sysface?: Array<{ QSid: string, QDes?: string, QHide?: string }>
      emoji?: Array<{ QSid: string, QCid?: string, AQLid?: string, QDes?: string, QHide?: string }>
    }
    const definitions: QQReactionDefinition[] = []
    const aliases = new Map<string, QQReactionDefinition>()
    for (const item of config.emoji ?? []) {
      if (item.QHide === '1' || !item.QSid) continue
      const emojiId = item.QCid || item.AQLid
      if (!emojiId) continue
      const definition: QQReactionDefinition = {
        key: reactionKey('2', emojiId),
        title: cleanFaceName(item.QDes),
        presentation: { type: 'emoji', emoticon: item.QSid },
      }
      definitions.push(definition)
      if (item.QCid) aliases.set(reactionKey('2', item.QCid), definition)
      if (item.AQLid) aliases.set(reactionKey('2', item.AQLid), definition)
    }
    for (const item of config.sysface ?? []) {
      if (item.QHide === '1') continue
      const filePath = join(facePath, 'static', `s${item.QSid}.png`)
      if (!existsSync(filePath)) continue
      const info = await stat(filePath)
      definitions.push({
        key: reactionKey('1', item.QSid),
        title: cleanFaceName(item.QDes),
        presentation: {
          type: 'custom',
          alt: `[${cleanFaceName(item.QDes) || item.QSid}]`,
          resource: {
            version: Math.trunc(info.mtimeMs),
            format: 'static',
            mimeType: 'image/png',
            width: 200,
            height: 200,
            size: info.size,
            locator: { filePath },
          },
        },
      })
    }
    this.reactionDefinitions = definitions
    this.reactionByKey.clear()
    for (const definition of definitions) this.reactionByKey.set(definition.key, definition)
    for (const [key, definition] of aliases) this.reactionByKey.set(key, definition)
    log('info', `loaded ${definitions.length} QQ reaction definitions`)
  }

  private findLocalReactionRoot(): string | undefined {
    const userPath = this.config?.userPath
    if (!userPath) return
    const candidates = [
      join(dirname(userPath), 'global', 'nt_data', 'Emoji', 'emoji-resource'),
      join(userPath, '..', 'global', 'nt_data', 'Emoji', 'emoji-resource'),
      join(userPath, '..', '..', 'global', 'nt_data', 'Emoji', 'emoji-resource'),
    ]
    return candidates.find((candidate) => existsSync(join(candidate, 'face_config.json')))
  }

  private async userAvatar(uid: string, force = true): Promise<QQMedia | undefined> {
    const service = this.requireSession().getAvatarService?.()
    if (!service) return
    try {
      let filePath = service.getAvatarPath(uid, 0)
      if (force && (!filePath || !existsSync(filePath))) {
        await service.forceDownloadAvatar(uid, 0).catch(() => undefined)
        filePath = await waitForAvatarPath(() => service.getAvatarPath(uid, 0))
      }
      return filePath && existsSync(filePath) ? avatarMedia(`user:${uid}`, filePath) : undefined
    } catch {
      return
    }
  }

  private async withConversationAvatar(conversation: QQConversation): Promise<QQConversation> {
    const service = this.requireSession().getAvatarService?.()
    if (!service) return conversation
    try {
      let avatar: QQMedia | undefined
      if (conversation.chatType === CHAT_C2C) {
        avatar = await this.userAvatar(conversation.peerUid)
      } else {
        let filePath = service.getGroupAvatarPath(conversation.peerUin || conversation.peerUid, 0)
          || service.getConfGroupAvatarPath(conversation.peerUin || conversation.peerUid)
        if (!filePath || !existsSync(filePath)) {
          await service.forceDownloadGroupAvatar(conversation.peerUin || conversation.peerUid, 0).catch(() => undefined)
          filePath = await waitForAvatarPath(() =>
            service.getGroupAvatarPath(conversation.peerUin || conversation.peerUid, 0)
            || service.getConfGroupAvatarPath(conversation.peerUin || conversation.peerUid))
        }
        if (filePath && existsSync(filePath)) avatar = avatarMedia(`group:${conversation.peerUid}`, filePath)
      }
      return avatar ? { ...conversation, avatar } : conversation
    } catch {
      return conversation
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

function imageElement(path: string): MsgElement {
  return {
    elementType: ELEMENT_IMAGE,
    elementId: '',
    picElement: {
      picSubType: 0,
      fileName: '',
      fileSize: '0',
      picWidth: 0,
      picHeight: 0,
      original: true,
      md5HexStr: '',
      sourcePath: path,
      fileUuid: '',
      fileSubId: '',
      thumbFileSize: 0,
      originImageMd5: '',
      storeID: 0,
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

async function waitForAvatarPath(resolvePath: () => string, timeoutMs = 3_000): Promise<string> {
  const deadline = Date.now() + timeoutMs
  let filePath = resolvePath()
  while ((!filePath || !existsSync(filePath)) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100))
    filePath = resolvePath()
  }
  return filePath
}

async function mapConcurrent<T, R>(items: readonly T[], concurrency: number, map: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  async function worker(): Promise<void> {
    while (next < items.length) {
      const index = next++
      results[index] = await map(items[index])
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()))
  return results
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
  list: Array<{ pending: ReturnType<typeof deferred<MsgRecord>>, minimumStatus: number }>,
  pending: ReturnType<typeof deferred<MsgRecord>>,
): void {
  const index = list.findIndex((item) => item.pending === pending)
  if (index >= 0) list.splice(index, 1)
}

async function retryTransientInvalidArgument<T>(operation: () => Promise<T>): Promise<T> {
  let lastError: unknown
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      return await operation()
    } catch (error) {
      lastError = error
      if (!isTransientNativeError(error) || attempt === 9) throw error
      await new Promise((resolve) => setTimeout(resolve, 200 * (attempt + 1)))
    }
  }
  throw lastError
}

function isTransientNativeError(error: unknown): boolean {
  const message = String(error)
  return message.includes('Invalid argument') || message.includes('timed out')
}

async function retryTransientInvalidArgumentResult(
  operation: () => Promise<{ result: number, errMsg: string }>,
): Promise<{ result: number, errMsg: string }> {
  for (let attempt = 0; attempt < 10; attempt++) {
    const result = await retryTransientInvalidArgument(operation)
    if (result.result === 0 || !result.errMsg.includes('Invalid argument') || attempt === 9) return result
    await new Promise((resolve) => setTimeout(resolve, 200 * (attempt + 1)))
  }
  throw new Error('unreachable')
}

function avatarMedia(id: string, filePath: string): QQMedia {
  const size = statSync(filePath).size
  return {
    id: `avatar:${id}`,
    kind: 'image',
    name: basename(filePath),
    size,
    locator: {
      messageId: `avatar:${id}`,
      elementId: `avatar:${id}`,
      chatType: id.startsWith('group:') ? 2 : 1,
      peerUid: id.slice(id.indexOf(':') + 1),
      kind: 'image',
      fileName: basename(filePath),
      fileSize: String(size),
      filePath,
    },
  }
}

function reactionKey(emojiType: string, emojiId: string): string {
  return `${emojiType}:${emojiId}`
}

function splitReactionKey(key: string): [string, string] {
  const separator = key.indexOf(':')
  if (separator <= 0) throw new Error(`invalid QQ reaction key: ${key}`)
  return [key.slice(0, separator), key.slice(separator + 1)]
}

function cleanFaceName(value?: string): string | undefined {
  const name = value?.replace(/^\//, '').trim()
  return name || undefined
}
