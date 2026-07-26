import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync, mkdirSync, statSync } from 'node:fs'
import { open as openFile, readFile, rm, stat } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import { AsyncQueue, deferred } from './async.js'
import { markBridgeListener } from './listener-tee.js'
import { log } from './log.js'
import { resolveMultiForwardParticipants } from './multi-forward-participants.js'
import { QQPacketClient, type QQPacketClientOptions } from './packet-client.js'
import type { DirectMessagePart } from './upload-protocol.js'
import type {
  CustomEmotionData, EmojiLikesUserInfo, FileTransNotifyInfo, GroupProfileInfo, InitSessionConfig, KernelModule, KernelSession,
  MarketStickerPackInfo, MemberInfo, MsgElement, MsgRecord, ProfileSimpleInfo, RecentContactInfo, SearchMsgKeywordsResult,
} from './kernel-types.js'
import {
  conversationId, parseConversationId, type HistoryQuery, type MemberPage, type QQCard, type QQConversation, type QQEvent,
  type QQMedia, type QQMediaLocator, type QQMessage, type QQMultiForwardLocator, type QQReactionContext, type QQReactionDefinition, type QQReactionState,
  type QQSticker, type QQStickerPack, type QQStickerPackSummary, type QQStickerReference, type QQTextPart, type SearchPage, type SearchQuery, type SendManifest,
} from './protocol.js'

const CHAT_C2C = 1
const CHAT_GROUP = 2
const ELEMENT_TEXT = 1
const ELEMENT_IMAGE = 2
const ELEMENT_FILE = 3
const ELEMENT_FACE = 6
const ELEMENT_REPLY = 7
const ELEMENT_MARKET_FACE = 11
const ELEMENT_MULTI_FORWARD = 16
const SEND_FROM_SELF = new Set([1, 2])
const MEMBER_ADMIN = 3
const MEMBER_OWNER = 4
const MEMBER_SCENE_TTL_MS = 5 * 60_000
const MEMBER_SCENE_LIMIT = 64
// Keep this in sync with Telegram's account-level reaction catalog. QQ emoji
// outside this set are exposed as custom reactions backed by QQ's own icon.
const TELEGRAM_STANDARD_REACTIONS = new Set([
  '❤', '👍', '👎', '🔥', '🥰', '👏', '😁', '🤔', '🤯', '😱', '🤬', '😢', '🎉', '🤩', '🤮', '💩',
  '🙏', '👌', '🕊', '🤡', '🥱', '🥴', '😍', '🐳', '❤‍🔥', '🌚', '🌭', '💯', '🤣', '⚡', '🍌', '🏆',
  '💔', '🤨', '😐', '🍓', '🍾', '💋', '🖕', '😈', '😴', '😭', '🤓', '👻', '👨‍💻', '👀', '🎃',
  '🙈', '😇', '😨', '🤝', '✍', '🤗', '🫡', '🎅', '🎄', '☃', '💅', '🤪', '🗿', '🆒', '💘', '🙉',
  '🦄', '😘', '💊', '🙊', '😎', '👾', '🤷‍♂', '🤷', '🤷‍♀', '😡', '😂',
])

export interface QQKernelOptions {
  tempPath?: string
  sendTimeoutMs?: number
  userResolveTimeoutMs?: number
  packetClient?: QQPacketClientOptions
}

interface SearchContext {
  searchId: number
  fingerprint: string
  buffer: QQMessage[]
  hasMore: boolean
  lastUsed: number
  busy: boolean
}

interface MessageMappingContext {
  multiForwardRootId?: string
  multiForwardConversationId?: string
  sender?: NonNullable<QQMessage['sender']>
  outgoing?: boolean
}

interface MessagePosition {
  id: string
  timestamp: number
  msgSeq?: string
}

export class QQKernelBridge {
  readonly events = new Set<AsyncQueue<QQEvent>>()
  private readonly recentEvents: Array<{ id: string, event: QQEvent }> = []
  private readonly eventIds = new WeakMap<object, string>()
  private eventSequence = 0
  private session?: KernelSession
  private kernel?: KernelModule
  private config?: InitSessionConfig
  private msgService?: ReturnType<KernelSession['getMsgService']>
  private buddyService?: ReturnType<KernelSession['getBuddyService']>
  private profileService?: NonNullable<ReturnType<NonNullable<KernelSession['getProfileService']>>>
  private groupService?: ReturnType<KernelSession['getGroupService']>
  private recentService?: ReturnType<KernelSession['getRecentContactService']>
  private searchService?: NonNullable<ReturnType<NonNullable<KernelSession['getSearchService']>>>
  private avatarService?: NonNullable<ReturnType<NonNullable<KernelSession['getAvatarService']>>>
  private packetClient?: QQPacketClient
  private readonly contacts = new Map<string, QQConversation>()
  private readonly recentContactIds = new Map<string, string>()
  private readonly recentTopMessages = new Map<string, MessagePosition>()
  private recentContactOrder: string[] = []
  private readonly users = new Map<string, {
    id: string, numericId?: string, name: string, avatarUrl?: string, signature?: string
  }>()
  private readonly seenUsers = new Map<string, {
    id: string, numericId?: string, name: string, avatarUrl?: string, signature?: string
  }>()
  private readonly groups = new Map<string, {
    name: string
    avatarUrl?: string
    participantCount?: number
    selfRole?: MemberPage['members'][number]['role']
  }>()
  private readonly avatarCache = new Map<string, QQMedia>()
  private buddySnapshotLoaded = false
  private readonly messages = new Map<string, QQMessage[]>()
  private reactionDefinitions: QQReactionDefinition[] = []
  private readonly reactionByKey = new Map<string, QQReactionDefinition>()
  private readonly reactionAssets = new Map<string, { path: string, mimeType: 'image/png' | 'image/apng' }>()
  private reactionCatalogPromise?: Promise<void>
  private reactionEventSequence = 0
  private readonly stickerPacks = new Map<string, QQStickerPack>()
  private readonly stickerPackInfo = new Map<string, MarketStickerPackInfo>()
  private readonly stickers = new Map<string, QQSticker>()
  private readonly pendingMessages = new Map<string, ReturnType<typeof deferred<MsgRecord>>>()
  private readonly pendingAcceptances = new Map<string, ReturnType<typeof deferred<void>>>()
  private readonly pendingMinimumStatuses = new Map<string, number>()
  private readonly messageOrigins = new Map<string, string>()
  private readonly resolvedReplyTargets = new Map<string, string>()
  private readonly pendingMergedForwards: Array<{ conversationId: string, startedAt: number }> = []
  private readonly pendingUnassigned: Array<{
    conversationId: string
    pending: ReturnType<typeof deferred<MsgRecord>>
    accepted: ReturnType<typeof deferred<void>>
    minimumStatus: number
    startedAt: number
    expectedText?: string
    expectedMediaName?: string
    expectedMediaKind?: 'image' | 'file' | 'sticker'
    originRequestId?: string
    assignedMessageId?: string
  }> = []
  private readonly pendingReactions = new Map<string, ReturnType<typeof deferred<QQReactionState>>>()
  private readonly pendingGroupProfiles = new Map<string, ReturnType<typeof deferred<void>>>()
  private readonly pendingUserProfiles = new Map<string, ReturnType<typeof deferred<void>>>()
  private readonly pendingMemberPages = new Map<string, ReturnType<typeof deferred<{
    ids: Array<{ uid: string, index: number }>
    infos: Map<string, MemberInfo>
    finish: boolean
  }>>>()
  private readonly memberScenes = new Map<string, { conversationId: string, lastUsed: number }>()
  private readonly groupProfileAttempts = new Map<string, number>()
  private unreadBatchState = ''
  private unreadBatchPromise?: Promise<void>
  private listenerId?: string
  private buddyListenerId?: string
  private profileListenerId?: string
  private groupListenerId?: string
  private recentListenerId?: string
  private searchListenerId?: string
  private readonly pendingRecentListUpdates = new Set<() => void>()
  private readonly pendingSearchPages = new Map<number, ReturnType<typeof deferred<SearchMsgKeywordsResult>>>()
  private readonly earlySearchPages = new Map<number, SearchMsgKeywordsResult>()
  private readonly searchContexts = new Map<string, SearchContext>()
  private listenerRetry?: NodeJS.Timeout
  private readonly tempPath: string
  private readonly sendTimeoutMs: number
  private readonly userResolveTimeoutMs: number
  private readonly packetClientOptions: QQPacketClientOptions

  constructor(options: QQKernelOptions = {}) {
    this.tempPath = options.tempPath ?? join(process.env.TMPDIR ?? '/tmp', 'qqnt-mtproto-bridge')
    this.sendTimeoutMs = options.sendTimeoutMs ?? 60_000
    this.userResolveTimeoutMs = options.userResolveTimeoutMs ?? 2_000
    this.packetClientOptions = options.packetClient ?? {}
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
    log('info', `bridge attach start selfUin=${config.selfUin} selfUid=${config.selfUid} listenerConstructors=msg:${Boolean(kernel.NodeIKernelMsgListener)},buddy:${Boolean(kernel.NodeIKernelBuddyListener)},group:${Boolean(kernel.NodeIKernelGroupListener)},recent:${Boolean(kernel.NodeIKernelRecentContactListener)}`)
    // A native wrapper can be re-initialized after logout/account switching.
    // Never leak the previous account's seen peers into the new address book.
    this.contacts.clear()
    this.recentContactIds.clear()
    this.recentTopMessages.clear()
    this.recentContactOrder = []
    this.users.clear()
    this.seenUsers.clear()
    this.groups.clear()
    this.avatarCache.clear()
    this.resolvedReplyTargets.clear()
    this.groupProfileAttempts.clear()
    this.unreadBatchState = ''
    this.unreadBatchPromise = undefined
    this.messages.clear()
    this.messageOrigins.clear()
    this.reactionDefinitions = []
    this.reactionByKey.clear()
    this.reactionAssets.clear()
    this.reactionCatalogPromise = undefined
    this.stickerPacks.clear()
    this.stickerPackInfo.clear()
    this.stickers.clear()
    this.buddySnapshotLoaded = false
    this.kernel = kernel
    this.session = session
    this.config = config
    mkdirSync(this.stagingPath(), { recursive: true })
    this.users.set(config.selfUid, {
      id: config.selfUid,
      numericId: config.selfUin,
      name: config.selfUin,
    })
    this.seenUsers.set(config.selfUid, {
      id: config.selfUid,
      numericId: config.selfUin,
      name: config.selfUin,
    })
    try {
      this.registerListeners()
      log('info', `bridge attach complete selfUin=${config.selfUin}`)
      void this.initializePlatformData()
    } catch (error) {
      log('error', 'initial native listener registration failed; scheduling retry', error)
      this.scheduleListenerRegistration()
    }
  }

  detach(): void {
    if (this.listenerRetry) clearTimeout(this.listenerRetry)
    this.listenerRetry = undefined
    this.resolveRecentListUpdates()
    const msgService = this.msgService
    const buddyService = this.buddyService
    const profileService = this.profileService
    const groupService = this.groupService
    const recentService = this.recentService
    const searchService = this.searchService
    if (this.listenerId || this.buddyListenerId || this.profileListenerId || this.groupListenerId || this.recentListenerId || this.searchListenerId) {
      log('info', `bridge detach listeners msg=${this.listenerId ?? ''} buddy=${this.buddyListenerId ?? ''} profile=${this.profileListenerId ?? ''} group=${this.groupListenerId ?? ''} recent=${this.recentListenerId ?? ''} search=${this.searchListenerId ?? ''}`)
    }
    if (msgService && this.listenerId) safeRemoveListener('message', this.listenerId, () => msgService.removeKernelMsgListener(this.listenerId!))
    if (buddyService && this.buddyListenerId) safeRemoveListener('buddy', this.buddyListenerId, () => buddyService.removeKernelBuddyListener(this.buddyListenerId!))
    if (profileService && this.profileListenerId) safeRemoveListener('profile', this.profileListenerId, () => profileService.removeKernelProfileListener(this.profileListenerId!))
    if (groupService && this.groupListenerId) safeRemoveListener('group', this.groupListenerId, () => groupService.removeKernelGroupListener(this.groupListenerId!))
    if (recentService?.removeKernelRecentContactListener && this.recentListenerId) {
      safeRemoveListener('recent', this.recentListenerId, () => recentService.removeKernelRecentContactListener!(this.recentListenerId!))
    }
    if (searchService && this.searchListenerId) {
      safeRemoveListener('search', this.searchListenerId, () => searchService.removeKernelSearchListener(this.searchListenerId!))
    }
    for (const context of this.searchContexts.values()) {
      safeCancelSearch(searchService, context.searchId, 'session detached')
    }
    if (groupService) {
      for (const scene of this.memberScenes.keys()) this.destroyMemberScene(groupService, scene)
    }
    this.memberScenes.clear()
    this.listenerId = this.buddyListenerId = this.profileListenerId = this.groupListenerId = undefined
    this.searchListenerId = undefined
    this.msgService = undefined
    this.buddyService = undefined
    this.profileService = undefined
    this.groupService = undefined
    this.recentService = undefined
    this.searchService = undefined
    this.avatarService = undefined
    this.packetClient = undefined
    this.session = undefined
    this.recentEvents.splice(0)
    for (const pending of this.pendingMessages.values()) pending.reject(new Error('QQNT session detached'))
    for (const accepted of this.pendingAcceptances.values()) accepted.resolve()
    for (const item of this.pendingUnassigned) {
      item.pending.reject(new Error('QQNT session detached'))
      item.accepted.resolve()
    }
    for (const pending of this.pendingSearchPages.values()) pending.reject(new Error('QQNT session detached'))
    this.pendingMessages.clear()
    this.pendingAcceptances.clear()
    this.pendingMinimumStatuses.clear()
    this.pendingUnassigned.splice(0)
    this.pendingSearchPages.clear()
    this.earlySearchPages.clear()
    this.searchContexts.clear()
    for (const pending of this.pendingReactions.values()) pending.reject(new Error('QQNT session detached'))
    this.pendingReactions.clear()
    for (const pending of this.pendingGroupProfiles.values()) pending.reject(new Error('QQNT session detached'))
    this.pendingGroupProfiles.clear()
    for (const pending of this.pendingUserProfiles.values()) pending.reject(new Error('QQNT session detached'))
    this.pendingUserProfiles.clear()
    for (const pending of this.pendingMemberPages.values()) pending.reject(new Error('QQNT session detached'))
    this.pendingMemberPages.clear()
    this.reactionAssets.clear()
  }

  subscribe(lastEventId?: string): AsyncQueue<QQEvent> {
    const queue = new AsyncQueue<QQEvent>()
    this.events.add(queue)
    if (lastEventId) {
      const cursor = this.recentEvents.findIndex((item) => item.id === lastEventId)
      const replay = cursor >= 0 ? this.recentEvents.slice(cursor + 1) : this.recentEvents
      log(cursor >= 0 ? 'info' : 'warn', `event replay requested lastEventId=${JSON.stringify(lastEventId)} cursorFound=${cursor >= 0} replay=${replay.length} buffered=${this.recentEvents.length}`)
      for (const item of replay) queue.push(item.event)
    }
    return queue
  }

  eventId(event: QQEvent): string | undefined {
    return this.eventIds.get(event)
  }

  unsubscribe(queue: AsyncQueue<QQEvent>): void {
    this.events.delete(queue)
    queue.close()
  }

  async refreshContacts(): Promise<void> {
    const session = this.requireSession()
    const recentService = session.getRecentContactService()
    let recentError: unknown
    if (recentService.getRecentContactList) {
      log('info', 'native API start name=getRecentContactList')
      // QQNT returns only an acknowledgement here. The refreshed rows arrive
      // asynchronously through the recent-contact listener, so do not read
      // the small startup cache (often eight rows) before that callback lands.
      const recentListUpdate = this.waitForRecentListUpdate(1_500)
      try {
        const loaded = await recentService.getRecentContactList()
        log('info', `native API complete name=getRecentContactList result=${loaded.result} err=${JSON.stringify(loaded.errMsg)}`)
        if (loaded.result !== 0) {
          recentListUpdate.cancel()
          log('warn', `getRecentContactList did not load the full dialog list: ${loaded.errMsg} (${loaded.result})`)
        } else {
          await recentListUpdate.promise
        }
      } catch (error) {
        recentListUpdate.cancel()
        // Older kernels may expose a stub with an incompatible implementation.
        // getRecentContactInfos below remains a useful cache fallback.
        log('error', 'full recent contact refresh failed; using cached infos', error)
      }
    }
    log('info', 'native API start name=getRecentContactsSnapshot')
    try {
      // The unbounded legacy snapshot only materializes the small UI cache on
      // current QQNT builds (typically 8-10 rows), even though its sorted ID
      // list contains every recent conversation. The count-aware variant
      // returns the matching RecentContactInfo rows, including each top msgId.
      const snapshot = recentService.getRecentContactListSyncLimit?.(500)
        ?? recentService.getRecentContactListSync?.()
      if (snapshot?.errCode === 0) {
        this.consumeRecentContactList(snapshot.sortedContactList, snapshot.changedList)
        log('info', `native API complete name=getRecentContactListSync contacts=${snapshot.changedList.length} ordered=${snapshot.sortedContactList.length}`)
      } else {
        log('info', 'native API fallback name=getRecentContactInfos')
        const recent = await recentService.getRecentContactInfos()
        log('info', `native API complete name=getRecentContactInfos result=${recent.result} err=${JSON.stringify(recent.errMsg)} contacts=${recent.relation.length}`)
        if (recent.result !== 0) throw new Error(`getRecentContactInfos: ${recent.errMsg} (${recent.result})`)
        for (const item of recent.relation) this.upsertRecent(item)
      }
    } catch (error) {
      recentError = error
    }
    // These methods deliver their actual data through listeners.
    await Promise.allSettled([
      this.requestBuddyList(),
      this.requestGroupList(),
    ])
    log('info', `contact refresh complete dialogs=${this.contacts.size} users=${this.users.size} groups=${this.groups.size}`)
    if (recentError) throw recentError
  }

  async getDialogs(cursor?: string, limit = 100, afterId?: string): Promise<{
    conversations: QQConversation[]
    nextCursor?: string
    total: number
  }> {
    // A refresh failure must not erase/block the already subscribed recent
    // contact snapshot (QQ can transiently reject this call during startup).
    if (!this.contacts.size) {
      await withTimeout(this.refreshContacts(), 5_000, 'QQ dialog refresh timed out')
        .catch((error) => log('error', 'dialog refresh failed; using cache', error))
    }
    const orderedIds = new Set(this.recentContactOrder)
    const dialogs = [
      ...this.recentContactOrder.flatMap((id) => {
        const conversation = this.contacts.get(id)
        return conversation ? [conversation] : []
      }),
      ...[...this.contacts.values()].filter((conversation) => !orderedIds.has(conversation.id)),
    ]
    const afterIndex = afterId ? dialogs.findIndex((dialog) => dialog.id === afterId) : -1
    const offset = afterId ? (afterIndex < 0 ? 0 : afterIndex + 1) : parseCursor(cursor)
    const selected = dialogs.slice(offset, offset + clamp(limit, 1, 500))
    const hydrated = await mapConcurrent(selected, 8, (conversation) => this.hydrateRecentTopMessage(conversation))
    await this.refreshUnreadMarkers(hydrated)
    const page = await mapConcurrent(hydrated, 8, async (conversation) => {
      if (conversation.chatType === CHAT_GROUP && isFallbackTitle(conversation.title, conversation.peerUin || conversation.peerUid)) {
        await this.ensureGroupProfile(conversation.peerUin || conversation.peerUid).catch((error) =>
          log('error', `group profile fallback failed group=${conversation.peerUin || conversation.peerUid}`, error))
      }
      const current = this.contacts.get(conversation.id) ?? conversation
      return this.withConversationAvatar(current, false)
    })
    return {
      conversations: page,
      nextCursor: offset + page.length < dialogs.length ? String(offset + page.length) : undefined,
      total: dialogs.length,
    }
  }

  async getContacts(cursor?: string, limit = 500): Promise<{
    users: Array<{ id: string, numericId?: string, name: string, signature?: string, avatar?: QQMedia }>
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
    this.enrichBuddyNames()
    const all = [...this.users.values()].sort((left, right) => {
      if (left.id === this.config?.selfUid) return -1
      if (right.id === this.config?.selfUid) return 1
      return left.name.localeCompare(right.name)
    })
    const offset = parseCursor(cursor)
    const selected = all.slice(offset, offset + clamp(limit, 1, 1_000))
    // Bounded concurrency avoids a native thundering herd while ensuring a
    // cold-cache miss does not stay permanent.
    const users = await mapConcurrent(selected, 4, async (user) => ({
      ...user,
      avatar: await this.userAvatar(user.id, false),
    }))
    return { users, nextCursor: offset + users.length < all.length ? String(offset + users.length) : undefined }
  }

  getConversation(id: string): QQConversation {
    const known = this.contacts.get(id)
    if (known) return known
    const { chatType, peerUid } = parseConversationId(id)
    return this.mergeConversation({
      id, kind: chatType === CHAT_GROUP ? 'group' : 'direct', title: peerUid,
      peerUid, peerUin: chatType === CHAT_GROUP ? peerUid : '', chatType,
    })
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
      this.mergeConversation(created)
      await this.ensureGroupProfile(numericId).catch((error) =>
        log('error', `group profile resolve failed group=${numericId}`, error))
      return this.withConversationAvatar(this.contacts.get(created.id) ?? created)
    }
    const buddy = [...this.users.values()].find((user) => user.numericId === numericId)
    if (buddy) {
      const created: QQConversation = {
        id: conversationId(CHAT_C2C, buddy.id), kind: 'direct', title: buddy.name,
        peerUid: buddy.id, peerUin: numericId, chatType: CHAT_C2C,
      }
      this.mergeConversation(created)
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
    this.mergeConversation(created)
    return this.withConversationAvatar(created)
  }

  async getHistory(conversation: QQConversation, query: HistoryQuery = {}): Promise<{ messages: QQMessage[], nextCursor?: string }> {
    const service = this.requireMsgService()
    const limit = clamp(query.limit ?? 50, 1, 200)
    const anchor = query.beforeId ?? query.afterId ?? query.cursor ?? '0'
    const peer = contact(conversation)
    const initial = !query.beforeId && !query.afterId && !query.cursor
    const unreadSeq = query.aroundUnreadSeq || (initial ? conversation.firstUnread?.msgSeq : undefined)
    let response: { result: number, errMsg: string, msgList: MsgRecord[] }
    const primaryName = unreadSeq && service.getMsgsBySeqAndCount
      ? 'getMsgsBySeqAndCount(unread)'
      : initial
      ? conversation.chatType === CHAT_GROUP && service.getAioFirstViewLatestMsgs
        ? 'getAioFirstViewLatestMsgs'
        : service.getMsgsIncludeSelf ? 'getMsgsIncludeSelf' : service.getLatestDbMsgs ? 'getLatestDbMsgs' : 'getMsgs'
      : service.getMsgsIncludeSelf ? 'getMsgsIncludeSelf' : 'getMsgs'
    log('info', `native API start name=${primaryName} conversation=${conversation.id} anchor=${anchor} limit=${limit} after=${Boolean(query.afterId)}`)
    try {
      if (unreadSeq && service.getMsgsBySeqAndCount) {
        response = await this.unreadHistory(service, conversation, unreadSeq, limit)
      } else if (initial && conversation.chatType === CHAT_GROUP && service.getAioFirstViewLatestMsgs) {
        response = await this.firstViewHistory(service, conversation, limit)
      } else if (initial) {
        response = await this.latestHistoryFallback(service, peer, limit)
      } else {
        const count = service.getMsgsIncludeSelf ? Math.min(200, limit + 1) : limit
        response = await withTimeout(
          retryHistoryCall(() => service.getMsgsIncludeSelf
            ? service.getMsgsIncludeSelf(peer, anchor, count, !query.afterId)
            : service.getMsgs(peer, anchor, count, !query.afterId)),
          5_000,
          'QQ history request timed out',
        )
        if (service.getMsgsIncludeSelf) {
          response = { ...response, msgList: response.msgList.filter((record) => record.msgId !== anchor).slice(0, limit) }
        }
      }
      // Some QQNT releases expose getLatestDbMsgs but return an initialization
      // error for it. getMsgs(peer, "0", ...) is the documented equivalent.
      if (initial && response.result !== 0) {
        log('info', `native API fallback name=getMsgs conversation=${conversation.id} previousResult=${response.result}`)
        response = await withTimeout(
          service.getMsgs(peer, '0', limit, true),
          450,
          'QQ history fallback request timed out',
        )
      }
    } catch (error) {
      if (!initial) throw error
      log('error', `QQ history request failed; using cache conversation=${conversation.id}`, error)
      response = { result: 0, errMsg: '', msgList: [] }
    }
    if (response.result !== 0) {
      if (!query.beforeId && !query.afterId && !query.cursor) {
        const cached = this.messages.get(conversation.id) ?? []
        return { messages: cached.slice(-limit).reverse() }
      }
      throw new Error(`getMsgs: ${response.errMsg} (${response.result})`)
    }
    log('info', `native API complete name=history conversation=${conversation.id} result=${response.result} err=${JSON.stringify(response.errMsg)} messages=${response.msgList.length}`)
    const visibleRecords = response.msgList.filter((record) => !isRecalledRecord(record))
    await this.resolveReplyTargets(visibleRecords)
    await this.resolveGrayTipUsers(visibleRecords)
    const messages = visibleRecords.map((record) => this.mapMessage(record))
    for (const message of messages) this.rememberMessage(message)
    if (!messages.length && !query.beforeId && !query.afterId && !query.cursor) {
      const cached = this.messages.get(conversation.id) ?? []
      return { messages: cached.slice(-limit).reverse() }
    }
    const last = response.msgList.at(-1)
    return { messages, nextCursor: messages.length === limit ? last?.msgId : undefined }
  }

  private async latestHistoryFallback(
    service: ReturnType<KernelSession['getMsgService']>,
    peer: ReturnType<typeof contact>,
    limit: number,
  ): Promise<{ result: number, errMsg: string, msgList: MsgRecord[] }> {
    const request = service.getMsgsIncludeSelf
      ? () => service.getMsgsIncludeSelf!(peer, '0', limit, true)
      : service.getLatestDbMsgs
        ? () => service.getLatestDbMsgs!(peer, limit)
        : () => service.getMsgs(peer, '0', limit, true)
    return withTimeout(retryHistoryCall(request), 2_000, 'QQ history request timed out')
  }

  private async firstViewHistory(
    service: ReturnType<KernelSession['getMsgService']>,
    conversation: QQConversation,
    limit: number,
  ): Promise<{ result: number, errMsg: string, msgList: MsgRecord[] }> {
    const peer = contact(conversation)
    const started = Date.now()
    // QQ does not await getAioFirstViewLatestMsgs by itself. ChatStore starts
    // the local-first-view and include-self paths together, races them, and
    // keeps local data only when it is already a complete screen.
    const local = retryHistoryCall(() => service.getAioFirstViewLatestMsgs!(peer, limit))
    const remote = retryHistoryCall(() => service.getMsgsIncludeSelf
      ? service.getMsgsIncludeSelf(peer, '0', limit, true)
      : service.getMsgs(peer, '0', limit, true))
    const settledLocal = local.then(
      (value) => ({ source: 'local' as const, value }),
      (error) => ({ source: 'local' as const, error }),
    )
    const settledRemote = remote.then(
      (value) => ({ source: 'remote' as const, value }),
      (error) => ({ source: 'remote' as const, error }),
    )
    const first = await withTimeout(
      Promise.race([settledLocal, settledRemote]),
      450,
      'QQ first-screen history request timed out',
    )
    if (
      first.source === 'local'
      && 'value' in first
      && first.value.result === 0
      && first.value.msgList.length >= limit
      && !first.value.needContinueGetMsg
    ) {
      log('info', `native API complete name=firstViewRace conversation=${conversation.id} source=local durationMs=${Date.now() - started} messages=${first.value.msgList.length}`)
      return first.value
    }
    const remoteResult = first.source === 'remote' ? first : await withTimeout(
      settledRemote,
      Math.max(1, 450 - (Date.now() - started)),
      'QQ first-screen remote history request timed out',
    )
    if ('error' in remoteResult) throw remoteResult.error
    log('info', `native API complete name=firstViewRace conversation=${conversation.id} source=remote durationMs=${Date.now() - started} messages=${remoteResult.value.msgList.length}`)
    return remoteResult.value
  }

  async getMessage(conversation: QQConversation, id: string): Promise<QQMessage | null> {
    const record = await this.getMessageRecord(conversation, id)
    if (!record) return null
    await this.resolveReplyTargets([record])
    await this.resolveGrayTipUsers([record])
    const message = this.mapMessage(record)
    this.rememberMessage(message)
    return message
  }

  async markRead(conversation: QQConversation, messageId: string): Promise<void> {
    const service = this.requireMsgService()
    if (!service.setSpecificMsgReadAndReport) {
      throw new Error('QQNT does not expose setSpecificMsgReadAndReport')
    }
    log('info', `native API start name=setSpecificMsgReadAndReport conversation=${conversation.id} message=${messageId}`)
    const result = await withTimeout(
      service.setSpecificMsgReadAndReport(contact(conversation), messageId),
      5_000,
      'QQ mark-read request timed out',
    )
    if (result.result !== 0) {
      throw new Error(`setSpecificMsgReadAndReport: ${result.errMsg} (${result.result})`)
    }
    this.unreadBatchState = ''
    this.unreadBatchPromise = undefined
    log('info', `native API complete name=setSpecificMsgReadAndReport conversation=${conversation.id} message=${messageId}`)
  }

  private async hydrateRecentTopMessage(conversation: QQConversation): Promise<QQConversation> {
    const target = this.recentTopMessages.get(conversation.id)
    if (!target || conversation.lastMessage?.id === target.id) return conversation
    if (conversation.lastMessage && compareMessagePosition(conversation.lastMessage, target) >= 0) {
      return conversation
    }
    try {
      const message = await this.getMessage(conversation, target.id)
      if (!message) {
        log('warn', `recent top message unavailable conversation=${conversation.id} message=${target.id}`)
        return conversation
      }
      const latest = latestMessage(conversation.lastMessage, message)
      return latest === conversation.lastMessage
        ? conversation
        : this.mergeConversation({ ...conversation, lastMessage: latest })
    } catch (error) {
      // A recent-contact abstract is lossy and must never be persisted as a
      // substitute for a real message. Keep the last hydrated message and let
      // the next dialogs request retry this native lookup.
      log('warn', `recent top message hydration failed conversation=${conversation.id} message=${target.id}`, error)
      return conversation
    }
  }

  async searchMessages(conversation: QQConversation, query: SearchQuery): Promise<SearchPage> {
    const service = this.requireSearchService()
    const limit = clamp(query.limit ?? 50, 1, 200)
    const fingerprint = JSON.stringify({
      conversationId: conversation.id,
      query: query.query,
      fromUserId: query.fromUserId ?? '',
      minTimestamp: query.minTimestamp ?? 0,
      maxTimestamp: query.maxTimestamp ?? 0,
      mediaKind: query.mediaKind ?? '',
    })
    this.pruneSearchContexts(service)

    let token = query.cursor
    let context = token ? this.searchContexts.get(token) : undefined
    if (token && !context) throw new Error('QQ search cursor is invalid or expired')
    if (context && context.fingerprint !== fingerprint) throw new Error('QQ search cursor does not match this query')
    if (context?.busy) throw new Error('QQ search cursor is already in use')

    let firstPage: SearchMsgKeywordsResult | undefined
    if (!context) {
      log('info', `native API start name=searchChatMsgs conversation=${conversation.id} query=${JSON.stringify(query.query)} limit=${limit}`)
      const searchId = service.searchChatMsgs(query.query ? [query.query] : [], {
        chatInfo: { chatType: conversation.chatType, peerUid: conversation.peerUid },
        searchFields: 0,
        filterMsgType: [],
        filterSendersUid: query.fromUserId ? [query.fromUserId] : [],
        filterMsgFromTime: String(query.minTimestamp ?? 0),
        filterMsgToTime: String(query.maxTimestamp ?? 0),
        pageLimit: limit,
      })
      firstPage = await this.waitForSearchPage(searchId)
      context = {
        searchId, fingerprint, buffer: [], hasMore: firstPage.hasMore,
        lastUsed: Date.now(), busy: false,
      }
      token = randomUUID()
      this.searchContexts.set(token, context)
    }

    context.busy = true
    try {
      let page = firstPage
      const messages: QQMessage[] = []
      for (let requestCount = 0; requestCount < 100 && messages.length < limit; requestCount++) {
        if (page) {
          context.hasMore = page.hasMore
          const mapped = await this.mapSearchResult(conversation, page)
          context.buffer.push(...mapped.filter((message) => matchesSearchMedia(message, query.mediaKind)))
          page = undefined
        }
        while (context.buffer.length && messages.length < limit) messages.push(context.buffer.shift()!)
        if (messages.length >= limit || !context.hasMore) break
        page = await this.waitForSearchPage(context.searchId, () => {
          service.searchMoreChatMsgs(context!.searchId)
        })
      }
      context.lastUsed = Date.now()
      const hasMore = context.buffer.length > 0 || context.hasMore
      if (!hasMore) {
        this.searchContexts.delete(token!)
        safeCancelSearch(service, context.searchId, 'search completed')
      }
      log('info', `native API complete name=searchChatMsgs conversation=${conversation.id} searchId=${context.searchId} messages=${messages.length} more=${hasMore}`)
      return { messages, nextCursor: hasMore ? token : undefined }
    } finally {
      context.busy = false
    }
  }

  private async mapSearchResult(
    conversation: QQConversation,
    result: SearchMsgKeywordsResult,
  ): Promise<QQMessage[]> {
    const records = new Map<string, MsgRecord>()
    const missing: string[] = []
    for (const item of result.resultItems) {
      if (item.msgRecord?.msgId) records.set(item.msgId, item.msgRecord)
      else if (item.msgId) missing.push(item.msgId)
    }
    if (missing.length) {
      const loaded = await retryTransientInvalidArgument(
        () => this.requireMsgService().getMsgsByMsgId(contact(conversation), missing),
      )
      if (loaded.result !== 0) throw new Error(`getMsgsByMsgId(search): ${loaded.errMsg} (${loaded.result})`)
      for (const record of loaded.msgList) records.set(record.msgId, record)
    }
    const ordered = result.resultItems.flatMap((item) => {
      const record = records.get(item.msgId)
      return record && !isRecalledRecord(record) ? [record] : []
    })
    await this.resolveReplyTargets(ordered)
    await this.resolveGrayTipUsers(ordered)
    return ordered.map((record) => {
      const message = this.mapMessage(record)
      this.rememberMessage(message)
      return message
    })
  }

  private async waitForSearchPage(
    searchId: number,
    trigger?: () => void,
  ): Promise<SearchMsgKeywordsResult> {
    const early = this.earlySearchPages.get(searchId)
    if (early) {
      this.earlySearchPages.delete(searchId)
      return early
    }
    const pending = deferred<SearchMsgKeywordsResult>()
    if (this.pendingSearchPages.has(searchId)) throw new Error(`QQ search ${searchId} already has a pending page`)
    this.pendingSearchPages.set(searchId, pending)
    try {
      trigger?.()
      return await withTimeout(pending.promise, 5_000, 'QQ search request timed out')
    } finally {
      if (this.pendingSearchPages.get(searchId) === pending) this.pendingSearchPages.delete(searchId)
    }
  }

  private onSearchPage(result: SearchMsgKeywordsResult): void {
    const pending = this.pendingSearchPages.get(result.searchId)
    if (pending) {
      this.pendingSearchPages.delete(result.searchId)
      pending.resolve(result)
      return
    }
    this.earlySearchPages.delete(result.searchId)
    this.earlySearchPages.set(result.searchId, result)
    while (this.earlySearchPages.size > 64) {
      const oldest = this.earlySearchPages.keys().next().value as number | undefined
      if (oldest === undefined) break
      this.earlySearchPages.delete(oldest)
    }
  }

  private pruneSearchContexts(service: NonNullable<typeof this.searchService>): void {
    const expiredBefore = Date.now() - 5 * 60_000
    for (const [token, context] of this.searchContexts) {
      if (context.lastUsed >= expiredBefore && this.searchContexts.size <= 64) continue
      this.searchContexts.delete(token)
      safeCancelSearch(service, context.searchId, 'search cursor expired')
    }
  }

  async getRawMessageRecord(conversation: QQConversation, id: string): Promise<MsgRecord | null> {
    const service = this.requireMsgService()
    const response = await retryTransientInvalidArgument(
      () => service.getMsgsByMsgId(contact(conversation), [id]),
    )
    if (response.result !== 0) throw new Error(`getMsgsByMsgId: ${response.errMsg} (${response.result})`)
    return response.msgList[0] ?? null
  }

  async getRawMessagesAroundSeq(conversation: QQConversation, seq: string, count = 20): Promise<{
    before: { result: number, errMsg: string, count: number }
    after: { result: number, errMsg: string, count: number }
    messages: MsgRecord[]
  }> {
    const service = this.requireMsgService()
    if (!service.getMsgsBySeqAndCount) throw new Error('getMsgsBySeqAndCount is unavailable in this QQNT build')
    const peer = contact(conversation)
    const selectedCount = clamp(count, 1, 200)
    const [before, after] = await Promise.all([
      retryHistoryCall(() => service.getMsgsBySeqAndCount!(peer, seq, selectedCount, true, true)),
      retryHistoryCall(() => service.getMsgsBySeqAndCount!(peer, seq, selectedCount, false, true)),
    ])
    const records = new Map<string, MsgRecord>()
    for (const record of [...before.msgList, ...after.msgList]) records.set(record.msgId, record)
    return {
      before: { result: before.result, errMsg: before.errMsg, count: before.msgList.length },
      after: { result: after.result, errMsg: after.errMsg, count: after.msgList.length },
      messages: [...records.values()].sort((left, right) => {
        const seqOrder = BigInt(left.msgSeq || '0') - BigInt(right.msgSeq || '0')
        if (seqOrder) return seqOrder < 0n ? -1 : 1
        return Number(left.msgTime) - Number(right.msgTime)
      }),
    }
  }

  async getMultiForwardMessages(locator: QQMultiForwardLocator): Promise<QQMessage[]> {
    const service = this.requireMsgService()
    if (!service.getMultiMsg) throw new Error('getMultiMsg is unavailable in this QQNT build')
    const conversation = this.getConversation(locator.conversationId)
    const parentMessageId = locator.parentMessageId ?? locator.rootMessageId
    log('info', `native API start name=getMultiMsg conversation=${conversation.id} root=${locator.rootMessageId} parent=${parentMessageId}`)
    let response = await retryTransientInvalidArgument(() => service.getMultiMsg!(
      contact(conversation), locator.rootMessageId, parentMessageId,
    ))
    log('info', `native API complete name=getMultiMsg conversation=${conversation.id} root=${locator.rootMessageId} parent=${parentMessageId} result=${response.result} err=${JSON.stringify(response.errMsg)} messages=${response.msgList.length}`)
    // QQ normally indexes nested bundles by (outer root, nested record). Some
    // forwarded bundles keep the nested resource attached to its original
    // message instead, in which case QQ's normal lookup reports Data Not
    // Existed even though (nested record, nested record) is still readable.
    if (response.result !== 0 && parentMessageId !== locator.rootMessageId) {
      log('info', `native API retry name=getMultiMsg conversation=${conversation.id} root=${parentMessageId} parent=${parentMessageId} reason=nested-resource-fallback`)
      const fallback = await retryTransientInvalidArgument(() => service.getMultiMsg!(
        contact(conversation), parentMessageId, parentMessageId,
      ))
      log('info', `native API complete name=getMultiMsg conversation=${conversation.id} root=${parentMessageId} parent=${parentMessageId} result=${fallback.result} err=${JSON.stringify(fallback.errMsg)} messages=${fallback.msgList.length} fallback=true`)
      if (fallback.result === 0) response = fallback
    }
    if (response.result !== 0) throw new Error(`getMultiMsg: ${response.errMsg} (${response.result})`)
    const records = response.msgList.filter((record) => !isRecalledRecord(record))
    const participants = resolveMultiForwardParticipants(locator, records)
    return records.map((record) => {
      const participant = participants.get(record)!
      return this.mapMessage(record, {
        multiForwardRootId: locator.rootMessageId,
        multiForwardConversationId: locator.conversationId,
        sender: {
          id: participant.id,
          name: participant.name,
          alias: participant.alias,
          avatar: participant.avatarUin
            ? qlogoAvatarMedia(participant.id, participant.avatarUin)
            : undefined,
        },
        // A merged-forward transcript is an archive. Even the current QQ
        // account is a participant in that archive, not the live account peer.
        outgoing: false,
      })
    })
  }

  private async getMessageRecord(conversation: QQConversation, id: string): Promise<MsgRecord | null> {
    const service = this.requireMsgService()
    const peer = contact(conversation)
    log('info', `native API start name=getMsgsByMsgId conversation=${conversation.id} message=${id}`)
    const response = await retryTransientInvalidArgument(() => service.getMsgsByMsgId(peer, [id]))
    log('info', `native API complete name=getMsgsByMsgId conversation=${conversation.id} message=${id} result=${response.result} err=${JSON.stringify(response.errMsg)} records=${response.msgList.length}`)
    if (response.result !== 0) throw new Error(`getMsgsByMsgId: ${response.errMsg} (${response.result})`)
    const record = response.msgList.find((item) => item.msgId === id)
    return record && !isRecalledRecord(record) ? record : null
  }

  async getStickerPacks(cursor?: string, limit = 100): Promise<{
    packs: QQStickerPackSummary[]
    nextCursor?: string
  }> {
    await this.loadStickerPackCatalog()
    const offset = parseCursor(cursor)
    const packs = [...this.stickerPackInfo.values()].map((item) => ({
      packId: String(item.epId), title: item.tabName || String(item.epId), version: 1,
      count: this.stickerPacks.get(String(item.epId))?.stickers.length,
    }))
    const selected = packs.slice(offset, offset + clamp(limit, 1, 200))
    return {
      packs: selected,
      nextCursor: offset + selected.length < packs.length ? String(offset + selected.length) : undefined,
    }
  }

  async getStickerPack(packId: string): Promise<QQStickerPack | null> {
    const cached = this.stickerPacks.get(packId)
    if (cached) return cached
    await this.loadStickerPackCatalog()
    const info = this.stickerPackInfo.get(packId)
    const service = this.requireMsgService()
    if (!service.getMarketEmoticonPath) return null
    const epId = info?.epId ?? Number(packId)
    if (!Number.isSafeInteger(epId) || epId <= 0) return null
    const downloaded = service.fetchMarketEmotionJsonFile
      ? await service.fetchMarketEmotionJsonFile(epId)
      : info && service.fetchMarketEmoticonShowImage
        ? await service.fetchMarketEmoticonShowImage({
            epId,
            wordingId: String(info.wordingId),
            type: info.tabType,
            name: info.tabName,
            valid: true,
          })
        : null
    if (!downloaded) return null
    if (downloaded.result !== 0) {
      throw new Error(`fetchMarketEmotionJsonFile: ${downloaded.errMsg} (${downloaded.result})`)
    }
    const jsonPath = (await this.getMarketEmoticonPaths(epId, [], 1)).get(packId)?.path
    if (!jsonPath || !existsSync(jsonPath)) throw new Error(`QQ sticker pack ${packId} has no detail JSON`)
    const detail = JSON.parse(await readFile(jsonPath, 'utf8')) as {
      name?: string
      isApng?: number
      imgs?: Array<{
        id?: string
        name?: string
        wWidthInPhone?: number
        wHeightInPhone?: number
        isApng?: number | boolean
      }>
    }
    const rows = (detail.imgs ?? []).filter((item): item is {
      id: string
      name?: string
      wWidthInPhone?: number
      wHeightInPhone?: number
      isApng?: number | boolean
    } => Boolean(item.id))
    const ids = rows.map((item) => item.id)
    const [staticPaths, dynamicPaths, keys] = await Promise.all([
      this.getMarketEmoticonPaths(epId, ids, 3),
      this.getMarketEmoticonPaths(epId, ids, 5),
      service.getMarketEmoticonEncryptKeys?.(epId, ids),
    ])
    const keyMap = keys?.result === 0 ? keys.encryptKeyMap : new Map<string, string>()
    const stickers = rows.map((item): QQSticker => {
      const staticPath = staticPaths.get(item.id)?.path || undefined
      const dynamicPath = dynamicPaths.get(item.id)?.path || undefined
      const animated = detail.isApng === 1 || Boolean(item.isApng) || info?.tabType === 3 || Boolean(dynamicPath)
      const reference: QQStickerReference = {
        kind: 'market', packageId: packId, stickerId: item.id,
        name: item.name || info?.tabName || '[表情]', key: keyMap.get(item.id) ?? '',
        width: positiveInteger(item.wWidthInPhone, 240),
        height: positiveInteger(item.wHeightInPhone, 240),
        animated,
        staticPath,
        dynamicPath,
      }
      const sticker: QQSticker = {
        stickerId: marketStickerId(packId, item.id), packId, title: item.name || info.tabName,
        format: animated ? 'animated' : 'static',
        mimeType: animated ? 'image/gif' : 'image/png',
        width: reference.width, height: reference.height, version: 1, reference,
      }
      this.stickers.set(sticker.stickerId, sticker)
      return sticker
    })
    const pack: QQStickerPack = {
      packId, title: info?.tabName || detail.name || packId, version: 1, count: stickers.length, stickers,
    }
    this.stickerPacks.set(packId, pack)
    return pack
  }

  async getSticker(stickerId: string): Promise<QQSticker | null> {
    const cached = this.stickers.get(stickerId)
    if (cached) return cached
    const market = parseMarketStickerId(stickerId)
    if (market) {
      return (await this.getStickerPack(market.packageId))?.stickers
        .find((item) => item.stickerId === stickerId) ?? null
    }
    if (stickerId.startsWith('favorite:')) {
      let cursor: string | undefined
      do {
        const page = await this.getSavedStickers(cursor, 200)
        const found = page.stickers.find((item) => item.stickerId === stickerId)
        if (found) return found
        cursor = page.nextCursor
      } while (cursor)
    }
    return null
  }

  async getSavedStickers(cursor?: string, limit = 200): Promise<{
    stickers: QQSticker[]
    nextCursor?: string
  }> {
    const service = this.requireMsgService()
    if (!service.fetchFavEmojiList) return { stickers: [] }
    const result = await service.fetchFavEmojiList(cursor ?? '', clamp(limit, 1, 200), true, false)
    if (result.result !== 0) throw new Error(`fetchFavEmojiList: ${result.errMsg} (${result.result})`)
    const stickers = await mapConcurrent(result.emojiInfoList, 8, (item) => this.mapFavoriteSticker(item))
    for (const sticker of stickers) this.stickers.set(sticker.stickerId, sticker)
    return {
      stickers,
      nextCursor: stickers.length >= clamp(limit, 1, 200)
        ? result.emojiInfoList.at(-1)?.resId || undefined
        : undefined,
    }
  }

  async openSticker(reference: QQStickerReference): Promise<{
    stream: Readable
    mimeType: string
    size?: number
  }> {
    if (reference.kind === 'sysface') {
      const resolved = reference.url
        ? undefined
        : await this.packetClientForSession().getSysFace(reference.faceId)
      const url = reference.url || resolved?.url
      if (!url) throw new Error(`QQ system face resource is unavailable: ${reference.faceId}`)
      if (resolved) {
        reference.url = resolved.url
        reference.name ||= resolved.name
        reference.packId ??= String(resolved.aniStickerPackId)
        reference.stickerId ??= String(resolved.aniStickerId)
        reference.stickerType ??= resolved.aniStickerType
        reference.width ??= positiveInteger(resolved.width, 240)
        reference.height ??= positiveInteger(resolved.height, 240)
      }
      const response = await fetch(url)
      if (!response.ok || !response.body) {
        throw new Error(`QQ system face download failed: ${response.status}`)
      }
      return {
        stream: Readable.fromWeb(response.body),
        mimeType: systemFaceMimeType(url, response.headers.get('content-type')),
        size: numberOrUndefined(response.headers.get('content-length') ?? undefined),
      }
    }
    if (reference.kind === 'favorite') {
      if (reference.path && existsSync(reference.path)) {
        return {
          stream: fileStream(reference.path, false),
          mimeType: imageMimeType(reference.path, reference.animated),
          size: statSync(reference.path).size,
        }
      }
      if (reference.locator) {
        const direct = await this.getDirectUrl(reference.locator)
        if (!direct) throw new Error(`QQ favorite sticker direct URL is unavailable: ${reference.resId}`)
        const response = await fetch(direct.url)
        if (!response.ok || !response.body) {
          throw new Error(`QQ favorite sticker download failed: ${response.status}`)
        }
        return {
          stream: Readable.fromWeb(response.body),
          mimeType: imageMimeType(reference.name, reference.animated),
          size: reference.size,
        }
      }
      throw new Error(`QQ favorite sticker file is missing: ${reference.resId}`)
    }
    const resolved = await this.resolveMarketStickerPath(reference)
    return {
      stream: fileStream(resolved.path, resolved.encrypted),
      mimeType: resolved.animated ? 'image/gif' : imageMimeType(resolved.path, false),
      size: statSync(resolved.path).size,
    }
  }

  async setSavedSticker(reference: QQStickerReference, saved: boolean): Promise<void> {
    if (reference.kind === 'sysface') throw new Error('QQ system faces cannot be added to favorites')
    const service = this.requireMsgService()
    if (!saved) {
      if (!service.deleteFavEmoji) throw new Error('QQ favorite deletion is unavailable')
      const resId = reference.kind === 'favorite'
        ? reference.resId
        : reference.favoriteResId ?? await this.findFavoriteResId(reference)
      if (!resId) return
      const result = await service.deleteFavEmoji([resId])
      if (result.result !== 0) throw new Error(`deleteFavEmoji: ${result.errMsg} (${result.result})`)
      return
    }
    if (!service.addFavEmoji) throw new Error('QQ favorite creation is unavailable')
    const path = reference.kind === 'favorite'
      ? reference.path
      : (await this.resolveMarketStickerPath(reference)).path
    if (!path) throw new Error('QQ sticker has no native file path')
    const result = await service.addFavEmoji(reference.kind === 'market' ? {
      emojiId: reference.stickerId, packageId: Number(reference.packageId), emojiPath: path,
      fileSize: '0', fileName: '', md5: '', isMarkFace: true, isOrigin: false,
    } : {
      emojiId: '', packageId: 0, emojiPath: path,
      fileSize: String(reference.size ?? (existsSync(path) ? statSync(path).size : 0)),
      fileName: reference.name, md5: reference.md5 ?? '', isMarkFace: false, isOrigin: true,
    })
    if (result.result !== 0) throw new Error(`addFavEmoji: ${result.errMsg} (${result.result})`)
  }

  async send(manifest: SendManifest, body: Readable): Promise<QQMessage> {
    const conversation = this.getConversation(manifest.conversationId)
    const peerUin = await this.requireProtocolPeerUin(conversation)
    const protocolParts: DirectMessagePart[] = []
    if (manifest.replyToId) protocolParts.push(await this.directReplyPart(conversation, manifest.replyToId))
    if (manifest.textParts?.length) {
      for (const part of manifest.textParts) protocolParts.push(...directTextParts(part))
    } else if (manifest.text) protocolParts.push({ kind: 'text', text: manifest.text })
    const cleanup: string[] = []
    const sentMediaPaths: Array<string | undefined> = []
    let preserveUntil: number | undefined
    try {
      if (manifest.sticker && manifest.media?.length) throw new Error('a message cannot contain both sticker and media')
      if (manifest.sticker?.kind === 'sysface') {
        this.stickers.set(sysFaceStickerId(manifest.sticker.faceId), stickerFromReference(manifest.sticker))
        protocolParts.push({ kind: 'face', face: {
          faceId: Number(manifest.sticker.faceId), faceType: manifest.sticker.faceType,
          packId: manifest.sticker.packId, stickerId: manifest.sticker.stickerId,
          sourceType: manifest.sticker.sourceType, stickerType: manifest.sticker.stickerType,
          resultId: manifest.sticker.resultId,
        } })
      } else if (manifest.sticker?.kind === 'market') {
        this.stickers.set(marketStickerId(
          manifest.sticker.packageId, manifest.sticker.stickerId,
        ), stickerFromReference(manifest.sticker))
        protocolParts.push({ kind: 'market-face', face: {
          name: manifest.sticker.name, emojiId: manifest.sticker.stickerId,
          packageId: Number(manifest.sticker.packageId), key: manifest.sticker.key,
          width: manifest.sticker.width, height: manifest.sticker.height,
        } })
      } else if (manifest.sticker?.kind === 'favorite') {
        this.stickers.set(favoriteStickerId(manifest.sticker.resId), stickerFromReference(manifest.sticker))
        const stickerPath = manifest.sticker.path && existsSync(manifest.sticker.path)
          ? manifest.sticker.path
          : ''
        if (!stickerPath) {
          throw new Error(`QQ favorite sticker file is missing: ${manifest.sticker.resId}`)
        }
        const size = statSync(stickerPath).size
        const [md5, sha1] = await Promise.all([
          hashFile(stickerPath, 'md5'), hashFile(stickerPath, 'sha1'),
        ])
        const uploaded = await this.packetClientForSession().uploadImage(
          conversation.chatType as 1 | 2,
          conversation.peerUid,
          this.requireConfig().selfUin,
          {
            name: manifest.sticker.name, size, md5, sha1,
            width: manifest.sticker.width, height: manifest.sticker.height,
            picType: imagePicType(manifest.sticker.name), picSubType: 1,
          },
          createReadStream(stickerPath),
        )
        protocolParts.push({ kind: 'image', upload: uploaded })
      }
      if (manifest.media?.length) {
        if (manifest.media.length > 1 && manifest.mediaFraming !== 'length-prefixed-v1') {
          throw new Error('multiple media items require length-prefixed-v1 framing')
        }
        const reader = manifest.mediaFraming === 'length-prefixed-v1' ? new FramedUploadReader(body) : undefined
        for (const [index, spec] of manifest.media.entries()) {
          const mediaBody = reader ? reader.media(index) : body
          let path: string | undefined
          let size = spec.size
          let md5 = spec.md5
          let sha1 = spec.sha1
          let file10MMd5 = spec.file10MMd5
          let dimensions = spec.width && spec.height
            ? { width: spec.width, height: spec.height }
            : undefined
          let uploadBody: AsyncIterable<Uint8Array> = mediaBody
          const requiresStaging = size === undefined || !md5 || !sha1
            || (spec.kind === 'file' && !file10MMd5)
          if (requiresStaging) {
            const stagingRoot = this.stagingPath(spec.kind)
            mkdirSync(stagingRoot, { recursive: true })
            path = join(stagingRoot, `${randomUUID()}${safeExtension(spec.name)}`)
            cleanup.push(path)
            await pipeline(mediaBody, createWriteStream(path, { flags: 'wx' }))
            const actualSize = statSync(path).size
            if (size !== undefined && actualSize !== size) {
              throw new Error(`incomplete upload ${index}: expected ${size} bytes, received ${actualSize}`)
            }
            size = actualSize
            const hashes = await Promise.all([
              md5 ? Promise.resolve(md5) : hashFile(path, 'md5'),
              sha1 ? Promise.resolve(sha1) : hashFile(path, 'sha1'),
              spec.kind === 'file' && !file10MMd5 ? hashFilePrefix(path, 'md5', 10 * 1024 * 1024) : Promise.resolve(file10MMd5),
              spec.kind === 'image' && !dimensions ? imageFileDimensions(path) : Promise.resolve(dimensions),
            ])
            ;[md5, sha1, file10MMd5, dimensions] = hashes
            uploadBody = createReadStream(path)
          }
          if (size === undefined || !md5 || !sha1) throw new Error(`media ${index} metadata is incomplete`)
          if (spec.kind === 'image') {
            const uploaded = await this.packetClientForSession().uploadImage(
              conversation.chatType as 1 | 2,
              conversation.peerUid,
              this.requireConfig().selfUin,
              {
                name: spec.name, size, md5, sha1,
                width: dimensions?.width, height: dimensions?.height, picType: imagePicType(spec.name),
              },
              uploadBody,
            )
            sentMediaPaths.push(path)
            protocolParts.push({ kind: 'image', upload: uploaded })
            continue
          }
          if (!file10MMd5) throw new Error(`file ${index} metadata is incomplete`)
          const config = this.requireConfig()
          const uploaded = await this.packetClientForSession().uploadFile(
            conversation.chatType as 1 | 2,
            conversation.peerUid,
            config.selfUin,
            config.selfUid,
            { name: spec.name, size, md5, sha1, file10MMd5 },
            uploadBody,
          )
          sentMediaPaths.push(path)
          protocolParts.push({
            kind: 'file', upload: uploaded,
            spec: { name: spec.name, size, md5, sha1, file10MMd5 },
          })
        }
        await reader?.finish()
      } else {
        body.resume()
      }
      if (!protocolParts.length) throw new Error('message must contain text, media, or sticker')
      const startedAt = Math.floor(Date.now() / 1000)
      const id = '0'
      const pending = deferred<MsgRecord>()
      const accepted = deferred<void>()
      const minimumStatus = manifest.media?.length || manifest.sticker ? 2 : 1
      this.pendingUnassigned.push({
        conversationId: conversation.id,
        pending,
        accepted,
        minimumStatus,
        startedAt,
        expectedText: manifest.textParts?.map((part) => part.text).join('') || manifest.text,
        expectedMediaName: manifest.media?.[0]?.name,
        expectedMediaKind: manifest.sticker ? 'sticker' : manifest.media?.[0]?.kind,
        originRequestId: manifest.originRequestId,
      })
      log('info', `protocol API start name=MessageSvc.PbSendMsg conversation=${conversation.id} parts=${protocolParts.length} minimumStatus=${minimumStatus}`)
      const sendRequest = this.packetClientForSession().sendDirectMessage(
        conversation.chatType as 1 | 2,
        conversation.peerUid,
        peerUin,
        protocolParts,
        this.requireConfig().selfUid,
      )
      const sendResponse = await Promise.race([
        sendRequest,
        pending.promise.then(() => undefined),
      ])
      if (!sendResponse) {
        log('info', `protocol API callback arrived before response name=MessageSvc.PbSendMsg conversation=${conversation.id}`)
      }
      log('info', `protocol API accepted name=MessageSvc.PbSendMsg conversation=${conversation.id} message=${id}`)
      const pollController = new AbortController()
      const confirmationPoll = this.pollSentMessage(
        conversation,
        manifest.textParts?.map((part) => part.text).join('') || manifest.text,
        startedAt,
        manifest.sticker ? 'sticker' : manifest.media?.[0]?.kind,
        manifest.media?.[0]?.name,
        minimumStatus,
        pollController.signal,
        sendResponse
          ? String(conversation.chatType === CHAT_C2C
              ? sendResponse.clientSequence || sendResponse.sequence
              : sendResponse.sequence || sendResponse.clientSequence)
          : undefined,
      )
      const record = await withTimeout(Promise.race([
        pending.promise,
        confirmationPoll,
      ]), this.sendTimeoutMs, `QQ did not confirm message ${id}`)
        .finally(() => {
          pollController.abort()
          this.pendingMessages.delete(id)
          this.pendingAcceptances.delete(id)
          this.pendingMinimumStatuses.delete(id)
          removePending(this.pendingUnassigned, pending)
        })
      this.rememberMessageOrigin(record.msgId, manifest.originRequestId)
      const message = this.mapMessage(record)
      log('info', `protocol API confirmed name=MessageSvc.PbSendMsg conversation=${conversation.id} requestedMessage=${id} confirmedMessage=${message.id} status=${record.sendStatus}`)
      if (manifest.media?.length && sentMediaPaths.length) {
        const mediaParts = message.parts.filter((part) => part.type === 'media')
        for (const [index, media] of mediaParts.entries()) {
          const spec = manifest.media[index]
          const path = sentMediaPaths[index]
          if (!spec || !path || media.type !== 'media') continue
          media.media.locator.filePath = path
          media.media.size ??= spec.size
          media.media.width ??= spec.width
          media.media.height ??= spec.height
          media.media.duration ??= spec.duration
          media.media.mimeType ??= spec.mimeType
        }
        preserveUntil = Date.now() + 10 * 60_000
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

  private async refreshUnreadMarkers(conversations: readonly QQConversation[]): Promise<void> {
    const service = this.requireMsgService()
    if (!service.getABatchOfContactMsgBoxInfo) return
    if (!conversations.length) return
    const state = conversations.map((conversation) =>
      `${conversation.id}:${conversation.unreadCount}:${conversation.lastMessage?.id ?? ''}`).join('|')
    if (state !== this.unreadBatchState) {
      this.unreadBatchState = state
      this.unreadBatchPromise = this.loadUnreadMarkers(service, conversations)
    }
    await this.unreadBatchPromise
  }

  private async loadUnreadMarkers(
    service: ReturnType<KernelSession['getMsgService']>,
    conversations: readonly QQConversation[],
  ): Promise<void> {
    try {
      log('info', `native API start name=getABatchOfContactMsgBoxInfo contacts=${conversations.length}`)
      const response = await withTimeout(
        retryHistoryCall(() => service.getABatchOfContactMsgBoxInfo!(conversations.map(contact))),
        450,
        'QQ batch unread request timed out',
      )
      if (response.result !== 0) throw new Error(`getABatchOfContactMsgBoxInfo: ${response.errMsg} (${response.result})`)
      const infos = new Map(response.contactMsgBoxInfos.map((info) => [
        `${info.contact.chatType}:${info.contact.peerUid}`,
        info,
      ]))
      let found = 0
      for (const conversation of conversations) {
        const info = infos.get(`${conversation.chatType}:${conversation.peerUid}`)
        if (!info) continue
        const unreadCount = Number(info.unreadCnt) || 0
        const marker = info.firstUnreadMsgInfo
        const firstUnread = unreadCount > 0 && marker?.msgSeq && marker.msgSeq !== '0'
          ? marker
          : undefined
        this.mergeConversation({
          ...conversation,
          unreadCount,
          firstUnread,
          readInboxMaxMessage: unreadCount > 0 ? conversation.readInboxMaxMessage : undefined,
        })
        if (firstUnread) found++
      }
      this.unreadBatchState = conversations.map((conversation) => {
        const current = this.contacts.get(conversation.id) ?? conversation
        return `${current.id}:${current.unreadCount}:${current.lastMessage?.id ?? ''}`
      }).join('|')
      log('info', `native API complete name=getABatchOfContactMsgBoxInfo contacts=${conversations.length} markers=${found}`)
    } catch (error) {
      // Allow the next request to retry instead of permanently caching a
      // transient native failure.
      this.unreadBatchState = ''
      this.unreadBatchPromise = undefined
      log('warn', 'QQ batch unread lookup failed', error)
    }
  }

  private async unreadHistory(
    service: ReturnType<KernelSession['getMsgService']>,
    conversation: QQConversation,
    unreadSeq: string,
    limit: number,
  ): Promise<{ result: number, errMsg: string, msgList: MsgRecord[] }> {
    const peer = contact(conversation)
    const count = Math.max(2, Math.ceil(limit / 2) + 1)
    const call = async (queryOrder: boolean) => {
      const started = Date.now()
      try {
        const result = await retryHistoryCall(
          () => service.getMsgsBySeqAndCount!(peer, unreadSeq, count, queryOrder, false),
        )
        log('info', `native API complete name=getMsgsBySeqAndCount(unread) conversation=${conversation.id} direction=${queryOrder ? 'before' : 'after'} durationMs=${Date.now() - started} result=${result.result} messages=${result.msgList.length}`)
        return result
      } catch (error) {
        log('warn', `QQ unread history direction failed conversation=${conversation.id} direction=${queryOrder ? 'before' : 'after'} durationMs=${Date.now() - started}`, error)
        return undefined
      }
    }
    // Match QQ's ChatMsgArea.getRangeMsgs: it fetches both sides of msgSeq
    // concurrently. Waiting for them serially doubles cold roaming latency.
    const [before, after] = await withTimeout(
      Promise.all([call(true), call(false)]),
      450,
      'QQ unread history request timed out',
    )
    // QQ returns kNoMoreMsg (2004000) together with the final non-empty
    // page. The official client consumes that page instead of discarding it.
    const successful = [before, after].filter((item) => item && (item.result === 0 || item.msgList.length > 0))
    if (!successful.length) {
      return before ?? after ?? { result: -1, errMsg: 'unread history unavailable', msgList: [] }
    }
    const records = new Map<string, MsgRecord>()
    for (const result of successful) {
      for (const record of result!.msgList) records.set(record.msgId, record)
    }
    const msgList = [...records.values()]
      .sort((left, right) => Number(right.msgTime) - Number(left.msgTime))
      .slice(0, limit)
    const previous = before?.result === 0
      ? before.msgList
        .filter((record) => record.msgSeq !== unreadSeq)
        .sort((left, right) => Number(right.msgTime) - Number(left.msgTime))[0]
      : undefined
    if (previous) {
      const readInboxMaxMessage = this.mapMessage(previous)
      this.rememberMessage(readInboxMaxMessage)
      this.mergeConversation({ ...conversation, readInboxMaxMessage })
      log('info', `native API complete name=readMarker conversation=${conversation.id} firstUnreadSeq=${unreadSeq} readMessage=${readInboxMaxMessage.id}`)
    }
    return { result: 0, errMsg: '', msgList }
  }

  async deleteMessages(conversation: QQConversation, ids: string[], forEveryone: boolean): Promise<void> {
    const service = this.requireMsgService()
    const peer = contact(conversation)
    log('info', `native API start name=${forEveryone ? 'recallMsg' : 'deleteMsg'} conversation=${conversation.id} messages=${ids.join(',')}`)
    const result = forEveryone
      ? await service.recallMsg(peer, ids)
      : await service.deleteMsg(peer, ids)
    if (result.result !== 0) throw new Error(`${forEveryone ? 'recallMsg' : 'deleteMsg'}: ${result.errMsg} (${result.result})`)
    log('info', `native API complete name=${forEveryone ? 'recallMsg' : 'deleteMsg'} conversation=${conversation.id} result=${result.result} err=${JSON.stringify(result.errMsg)}`)
  }

  async forwardMessages(
    source: QQConversation,
    ids: string[],
    destination: QQConversation,
    merged = false,
  ): Promise<QQMessage[]> {
    if (!ids.length) return []
    const service = this.requireMsgService()
    const before = new Set((await this.latestRecords(destination, 50)).map((record) => record.msgId))
    const startedAt = Math.floor(Date.now() / 1000)
    const api = merged ? 'multiForwardMsg' : 'forwardMsg'
    log('info', `native API start name=${api} from=${source.id} to=${destination.id} messages=${ids.join(',')}`)
    const pendingMerged = merged ? { conversationId: destination.id, startedAt } : undefined
    if (pendingMerged) this.pendingMergedForwards.push(pendingMerged)
    try {
      let result: { result: number, errMsg: string }
      if (merged) {
        if (!service.multiForwardMsgWithComment && !service.multiForwardMsg) {
          throw new Error('multiForwardMsg is unavailable in this QQNT build')
        }
        const records = await service.getMsgsByMsgId(contact(source), ids)
        if (records.result !== 0) throw new Error(`getMsgsByMsgId: ${records.errMsg} (${records.result})`)
        const byId = new Map(records.msgList.map((record) => [record.msgId, record]))
        const messages = ids.map((msgId) => {
          const record = byId.get(msgId)
          return {
            msgId,
            senderShowName: record
              ? record.sendRemarkName || record.sendMemberName || record.sendNickName || record.senderUin
              : undefined,
          }
        })
        result = service.multiForwardMsgWithComment
          ? await service.multiForwardMsgWithComment(
            messages, contact(source), contact(destination), [], new Map(),
          )
          : await service.multiForwardMsg!(messages, contact(source), contact(destination))
      } else {
        result = await service.forwardMsg(ids, contact(source), [contact(destination)], new Map())
      }
      if (result.result !== 0) throw new Error(`${api}: ${result.errMsg} (${result.result})`)
      const messages = await this.waitForForwardedMessages(
        destination, before, merged ? 1 : ids.length, startedAt, merged,
      )
      log('info', `native API complete name=${api} from=${source.id} to=${destination.id} result=${result.result} messages=${messages.map((item) => item.id).join(',')} err=${JSON.stringify(result.errMsg)}`)
      return messages
    } finally {
      if (pendingMerged) {
        const index = this.pendingMergedForwards.indexOf(pendingMerged)
        if (index >= 0) this.pendingMergedForwards.splice(index, 1)
      }
    }
  }

  async getUser(uid: string) {
    let cached = this.seenUsers.get(uid) ?? this.users.get(uid)
    if (cached && (isFallbackUserName(cached) || cached.signature === undefined)) {
      await this.ensureUserProfiles([uid]).catch((error) =>
        log('error', `QQ profile resolve failed uid=${uid}; using cached fallback`, error))
      cached = this.seenUsers.get(uid) ?? this.users.get(uid)
    }
    if (cached) return { ...cached, avatar: await this.userAvatar(uid, false) }
    let numericId: string | undefined
    try {
      const numeric = await withTimeout(
        retryTransientInvalidArgument(
          () => Promise.resolve().then(() => this.requireSession().getUixConvertService().getUin(new Set([uid]))),
        ),
        this.userResolveTimeoutMs,
        `QQ user resolve timed out: ${uid}`,
      )
      numericId = numeric.uinInfo.get(uid)
    } catch (error) {
      log('error', `QQ user resolve failed uid=${uid}; using opaque fallback`, error)
    }
    const user = { id: uid, numericId, name: numericId ?? uid }
    this.rememberSeenUser(user)
    await this.ensureUserProfiles([uid]).catch((error) =>
      log('error', `QQ profile resolve failed uid=${uid}; using opaque fallback`, error))
    const resolved = this.seenUsers.get(uid) ?? user
    return {
      ...resolved,
      avatar: await this.userAvatar(uid, false),
    }
  }

  async getReactionCatalog(): Promise<QQReactionContext> {
    if (!this.reactionDefinitions.length) {
      await withTimeout(this.loadReactionCatalogOnce(), 5_000, 'QQ reaction catalog request timed out')
    }
    return { available: this.reactionDefinitions, reactions: [], maxSelected: 20 }
  }

  async openReactionResource(
    reactionKey: string,
    range: { offset?: number, limit?: number } = {},
  ): Promise<{ stream: Readable, mimeType: string, size: number, offset: number, length: number } | undefined> {
    if (!this.reactionDefinitions.length) await this.getReactionCatalog()
    const resource = this.reactionAssets.get(reactionKey)
    if (!resource || !existsSync(resource.path)) return
    const size = statSync(resource.path).size
    const offset = Math.max(0, Math.trunc(range.offset ?? 0))
    const available = Math.max(0, size - offset)
    const requested = range.limit === undefined ? available : Math.max(0, Math.trunc(range.limit))
    const length = Math.min(available, requested)
    return {
      stream: length
        ? createReadStream(resource.path, { start: offset, end: offset + length - 1 })
        : Readable.from([]),
      mimeType: resource.mimeType,
      size,
      offset,
      length,
    }
  }

  async getMessageReactions(conversation: QQConversation, messageId: string): Promise<QQReactionState> {
    if (conversation.chatType !== CHAT_GROUP) return { reactions: [], maxSelected: 0 }
    const record = await withTimeout(
      this.getMessageRecord(conversation, messageId),
      5_000,
      'QQ reaction lookup timed out',
    )
    if (!record) return { reactions: [], maxSelected: 20 }
    const message = this.mapMessage(record)
    const previous = (this.messages.get(conversation.id) ?? []).find((item) => item.id === messageId)
    if (record.emojiLikesList === undefined && previous?.reactionContext) {
      message.reactionContext = previous.reactionContext
    }
    if (message.reactionContext) {
      message.reactionContext = await this.withReactionActors(conversation, record, message.reactionContext)
    }
    this.rememberMessage(message)
    return message.reactionContext ?? { reactions: [], maxSelected: 20 }
  }

  private async withReactionActors(
    conversation: QQConversation,
    record: MsgRecord,
    state: QQReactionState,
  ): Promise<QQReactionState> {
    const service = this.requireMsgService()
    if (!service.getMsgEmojiLikesList || !record.msgSeq) return state
    const nativeByKey = new Map((record.emojiLikesList ?? []).map((item) => [
      this.reactionByKey.get(reactionKey(item.emojiType, item.emojiId))?.key
        ?? reactionKey(item.emojiType, item.emojiId),
      item,
    ]))
    const reactions = await mapConcurrent(state.reactions, 4, async (reaction) => {
      const native = nativeByKey.get(reaction.key)
      if (!native || reaction.count <= 0) return reaction
      try {
        const actors = await this.getReactionActors(
          conversation, record.msgSeq!, native.emojiId, native.emojiType,
        )
        return { ...reaction, recentActors: actors.map((actor) => ({ userId: actor.tinyId })) }
      } catch (error) {
        log('error', `reaction actor lookup failed conversation=${conversation.id} message=${record.msgId} emoji=${native.emojiType}:${native.emojiId}`, error)
        return reaction
      }
    })
    return { ...state, reactions }
  }

  private async getReactionActors(
    conversation: QQConversation,
    msgSeq: string,
    emojiId: string,
    emojiType: string,
  ): Promise<EmojiLikesUserInfo[]> {
    const service = this.requireMsgService()
    if (!service.getMsgEmojiLikesList) return []
    const actors = new Map<string, EmojiLikesUserInfo>()
    let cookie = ''
    for (let page = 0; page < 10 && actors.size < 100; page++) {
      log('info', `native API start name=getMsgEmojiLikesList conversation=${conversation.id} seq=${msgSeq} emoji=${emojiType}:${emojiId} page=${page + 1}`)
      const result = await service.getMsgEmojiLikesList(
        contact(conversation), msgSeq, emojiId, emojiType, cookie, false, 10,
      )
      log('info', `native API complete name=getMsgEmojiLikesList conversation=${conversation.id} seq=${msgSeq} emoji=${emojiType}:${emojiId} result=${result.result} actors=${result.emojiLikesList.length} last=${result.isLastPage} err=${JSON.stringify(result.errMsg)}`)
      if (result.result !== 0) throw new Error(`getMsgEmojiLikesList: ${result.errMsg} (${result.result})`)
      for (const actor of result.emojiLikesList) {
        if (!actor.tinyId || actors.has(actor.tinyId)) continue
        actors.set(actor.tinyId, actor)
      }
      if (result.isLastPage || result.emojiLikesList.length === 0 || result.cookie === cookie) break
      cookie = result.cookie
    }
    return this.normalizeReactionActors([...actors.values()].slice(0, 100))
  }

  private async normalizeReactionActors(actors: EmojiLikesUserInfo[]): Promise<EmojiLikesUserInfo[]> {
    const numericIds = [...new Set(actors.map((actor) => actor.tinyId).filter((id) => /^\d+$/.test(id)))]
    const opaqueIds = [...new Set(actors.map((actor) => actor.tinyId).filter((id) => !/^\d+$/.test(id)))]
    const [uidInfo, uinInfo] = await Promise.all([
      numericIds.length
        ? retryTransientInvalidArgument(() => this.requireSession().getUixConvertService().getUid(new Set(numericIds)))
          .then((value) => value.uidInfo)
          .catch((error) => {
            log('error', `reaction actor UID conversion failed uins=${numericIds.join(',')}`, error)
            return new Map<string, string>()
          })
        : new Map<string, string>(),
      opaqueIds.length
        ? retryTransientInvalidArgument(() => this.requireSession().getUixConvertService().getUin(new Set(opaqueIds)))
          .then((value) => value.uinInfo)
          .catch((error) => {
            log('error', `reaction actor UIN conversion failed uids=${opaqueIds.join(',')}`, error)
            return new Map<string, string>()
          })
        : new Map<string, string>(),
    ])
    const normalized = new Map<string, EmojiLikesUserInfo>()
    for (const actor of actors) {
      const numericId = /^\d+$/.test(actor.tinyId) ? actor.tinyId : uinInfo.get(actor.tinyId)
      const id = numericId ? uidInfo.get(numericId) ?? actor.tinyId : actor.tinyId
      if (normalized.has(id)) continue
      const previous = this.seenUsers.get(id) ?? this.users.get(id)
      this.rememberSeenUser({
        id,
        numericId,
        name: actor.nickName || previous?.name || numericId || id,
        avatarUrl: actor.headUrl || previous?.avatarUrl,
      })
      normalized.set(id, { ...actor, tinyId: id })
    }
    await this.ensureUserProfiles([...normalized.keys()]).catch((error) =>
      log('error', `reaction actor profile resolve failed users=${[...normalized.keys()].join(',')}`, error))
    return [...normalized.values()]
  }

  async setMessageReactions(
    conversation: QQConversation,
    messageId: string,
    reactionKeys: readonly string[],
  ): Promise<QQReactionState> {
    if (conversation.chatType !== CHAT_GROUP) throw new Error('QQ reactions are unavailable in direct conversations')
    const service = this.requireMsgService()
    if (!service.setMsgEmojiLikes) throw new Error('QQ reactions are unavailable in this QQNT build')
    const cached = (this.messages.get(conversation.id) ?? []).find((item) => item.id === messageId)
    // onAddSendMsg may expose a temporary group msgSeq at sendStatus=1. The
    // stable msgId can already be returned to callers, but reaction writes must
    // refresh the record and use QQ's final msgSeq.
    let record = await withTimeout(
      this.getMessageRecord(conversation, messageId),
      5_000,
      'QQ reaction target refresh timed out',
    ).catch(() => null)
    // Both getMsgsByMsgId and the first-view cache can briefly retain the
    // optimistic record. Poll the database view until QQ publishes the final
    // sendStatus/msgSeq, bounded to keep older builds responsive.
    for (let attempt = 0; record?.sendStatus === 1 && attempt < 8; attempt++) {
      const latest = await this.latestRecords(conversation, 20).catch(() => [])
      const candidate = latest.find((item) => item.msgId === messageId)
      if (candidate && candidate.sendStatus >= 2) {
        record = candidate
        break
      }
      await delay(200)
      record = await this.getMessageRecord(conversation, messageId).catch(() => record)
    }
    const message = record ? this.mapMessage(record) : cached ?? null
    if (!message) throw new Error(`QQ reaction target not found: ${messageId}`)
    const current = new Set((message.reactionContext?.reactions ?? []).filter((item) => item.selected)
      .map((item) => item.key))
    const desired = new Set(reactionKeys)
    const stateChanged = current.size !== desired.size || [...current].some((key) => !desired.has(key))
    const pendingKey = `${conversation.id}\u0000${message.id}`
    try {
      for (const key of new Set([...current, ...desired])) {
        if (current.has(key) === desired.has(key)) continue
        const [emojiType, emojiId] = splitReactionKey(key)
        const event = deferred<QQReactionState>()
        this.pendingReactions.set(pendingKey, event)
        let completed = false
        let lastError: unknown
        for (let attempt = 0; !completed && attempt < 5; attempt++) {
          log('info', `native API start name=setMsgEmojiLikes conversation=${conversation.id} message=${message.id} seq=${message.msgSeq ?? message.id} emoji=${emojiType}:${emojiId} selected=${desired.has(key)} attempt=${attempt + 1}`)
          const native = Promise.resolve().then(() => service.setMsgEmojiLikes!(
            contact(conversation), message.msgSeq ?? message.id, emojiId, emojiType, desired.has(key),
          )).then((result) => {
            // QQ reports an idempotent add as an error even though the desired
            // state has already been reached (commonly after a retry).
            if (result.result === 65002 && desired.has(key)) return
            if (result.result !== 0) throw new Error(`setMsgEmojiLikes: ${result.errMsg} (${result.result})`)
          })
          try {
            await withTimeout(
              Promise.race([native, event.promise.then(() => undefined)]),
              5_000,
              'QQ reaction update timed out',
            )
            completed = true
            log('info', `native API complete name=setMsgEmojiLikes conversation=${conversation.id} message=${message.id} emoji=${emojiType}:${emojiId} selected=${desired.has(key)} attempt=${attempt + 1}`)
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
      message.reactionContext = { reactions, maxSelected: 20 }
      this.rememberMessage(message)
      // Some QQNT builds apply setMsgEmojiLikes without emitting
      // onMsgInfoListUpdate. Publish the confirmed local state immediately;
      // a later native snapshot remains authoritative and harmlessly repeats it.
      if (stateChanged) this.dispatch({
        type: 'message-reactions',
        eventId: `reaction-local:${message.id}:${Date.now()}`,
        conversation,
        target: { conversationId: conversation.id, messageId: message.id, targetId: message.id },
        context: message.reactionContext,
        timestamp: Math.floor(Date.now() / 1000),
      })
      return message.reactionContext
    } finally {
      this.pendingReactions.delete(pendingKey)
    }
  }

  async getMembers(conversation: QQConversation, cursor?: string, limit = 100): Promise<MemberPage> {
    if (conversation.chatType !== CHAT_GROUP) return { members: [], total: 0 }
    const service = this.requireGroupService()
    this.pruneMemberScenes(service)
    const start = decodeMemberCursor(cursor)
    let scene = start.scene
    if (scene && this.memberScenes.get(scene)?.conversationId !== conversation.id) {
      throw new Error('member cursor expired')
    }
    if (!scene) {
      scene = service.createMemberListScene(conversation.peerUin || conversation.peerUid, `mtproto-${randomUUID()}`)
      this.memberScenes.set(scene, { conversationId: conversation.id, lastUsed: Date.now() })
    } else {
      this.memberScenes.get(scene)!.lastUsed = Date.now()
    }
    const requested = clamp(limit, 1, 500)
    // QQ's own member-list UI requests at least 30. Current native builds can
    // return a false terminal empty page for smaller `num` values, so prefetch
    // the native minimum and expose only the caller's requested window.
    // Keep native work bounded even when Telegram asks for a 100-200 member
    // window. Returning fewer rows than requested is valid for a cursor page,
    // and lets the next Telegram offset advance from the emitted cursor.
    const nativeLimit = 30
    log('info', `native API start name=getNextMemberList conversation=${conversation.id} scene=${scene} cursor=${cursor ?? ''} limit=${requested} nativeLimit=${nativeLimit}`)
    const listenerPage = deferred<{
      ids: Array<{ uid: string, index: number }>
      infos: Map<string, MemberInfo>
      finish: boolean
    }>()
    this.pendingMemberPages.set(scene, listenerPage)
    let keepScene = false
    try {
      const nativeStart = { uid: start.uid, index: start.index }
      const response = await service.getNextMemberList(scene, nativeStart, nativeLimit)
      if (response.errCode !== 0) throw new Error(`getNextMemberList: ${response.errMsg} (${response.errCode})`)
      let result = response.result
      if (!result.ids.length && (conversation.participantCount ?? 0) > 0) {
        try {
          result = await withTimeout(listenerPage.promise, 3_000, 'QQ member list listener timed out')
          log('info', `native callback selected name=onMemberListChange conversation=${conversation.id} scene=${scene} ids=${result.ids.length} finish=${result.finish}`)
        } catch (error) {
          log('error', `native member list callback unavailable conversation=${conversation.id} scene=${scene}`, error)
        }
      }
      log('info', `native API complete name=getNextMemberList conversation=${conversation.id} scene=${scene} result=${response.errCode} err=${JSON.stringify(response.errMsg)} ids=${result.ids.length} finish=${result.finish}`)
      const selectedIds = result.ids.slice(0, requested)
      const members = selectedIds.flatMap(({ uid }) => {
        const info = result.infos.get(uid)
        if (!info) return []
        const member = mapMember(info)
        this.rememberSeenUser(member.user)
        return [member]
      })
      const hasMore = selectedIds.length < result.ids.length || !result.finish
      const last = selectedIds.at(-1)
      // A native scene is stateful. Recreating it for every HTTP page makes
      // current QQNT builds restart at page one even when lastId is supplied.
      // Also refuse a non-advancing native cursor so a caller cannot spin on
      // the same page forever.
      const advances = Boolean(last && (last.uid !== start.uid || last.index !== start.index))
      keepScene = hasMore && advances
      return {
        members,
        total: conversation.participantCount
          ?? (result.finish ? Math.max(0, start.index) + result.ids.length : undefined),
        nextCursor: keepScene ? encodeMemberCursor(last, scene) : undefined,
      }
    } finally {
      this.pendingMemberPages.delete(scene)
      if (!keepScene) {
        this.memberScenes.delete(scene)
        this.destroyMemberScene(service, scene, conversation.id)
      }
    }
  }

  private pruneMemberScenes(service: ReturnType<KernelSession['getGroupService']>): void {
    const now = Date.now()
    for (const [scene, state] of this.memberScenes) {
      if (now - state.lastUsed <= MEMBER_SCENE_TTL_MS && this.memberScenes.size <= MEMBER_SCENE_LIMIT) continue
      this.memberScenes.delete(scene)
      this.destroyMemberScene(service, scene, state.conversationId)
    }
  }

  private destroyMemberScene(
    service: ReturnType<KernelSession['getGroupService']>,
    scene: string,
    conversationId = this.memberScenes.get(scene)?.conversationId ?? '',
  ): void {
    try {
      service.destroyMemberListScene(scene)
      log('info', `native API complete name=destroyMemberListScene conversation=${conversationId} scene=${scene}`)
    } catch (error) {
      log('error', `native member list scene cleanup failed conversation=${conversationId} scene=${scene}`, error)
    }
  }

  async getDirectUrl(locator: QQMediaLocator): Promise<{ url: string, expiresAt: number } | undefined> {
    return this.packetClientForSession().getMediaDirectUrl(locator, this.requireConfig().selfUid)
  }

  private registerListeners(): void {
    const session = this.requireSession()
    const kernel = this.kernel!
    const msgService = session.getMsgService()
    const buddyService = session.getBuddyService()
    const groupService = session.getGroupService()
    const recentService = session.getRecentContactService()
    if (!msgService || !buddyService || !groupService) throw new Error('QQNT kernel services are not initialized yet')
    this.msgService = msgService
    this.buddyService = buddyService
    this.groupService = groupService
    this.recentService = recentService
    try {
      this.profileService = session.getProfileService?.()
    } catch {
      this.profileService = undefined
    }
    try {
      this.avatarService = session.getAvatarService?.()
    } catch {
      this.avatarService = undefined
    }
    try {
      this.searchService = session.getSearchService?.()
    } catch {
      this.searchService = undefined
    }
    const msgListener = markBridgeListener(makeListener(
      'NodeIKernelMsgListener',
      kernel.NodeIKernelMsgListener,
      {
      onRecvMsg: (value: MsgRecord[] | { msgList: MsgRecord[] }) =>
        void this.onMessages(normalizeMessageRecords(value), 'onRecvMsg'),
      onAddSendMsg: (value: MsgRecord | { msgRecord: MsgRecord }) =>
        void this.onMessages(normalizeSingleMessageRecord(value), 'onAddSendMsg'),
      onMsgInfoListUpdate: (value: MsgRecord[] | { msgList: MsgRecord[] }) =>
        void this.onMessages(normalizeMessageRecords(value), 'onMsgInfoListUpdate'),
      onMsgRecall: (
        value: number | { chatType: number, peerUid: string, seq: string },
        peerUid?: string,
        seq?: string,
      ) => typeof value === 'object'
        ? this.onRecall(value.chatType, value.peerUid, value.seq)
        : this.onRecall(value, peerUid!, seq!),
      onMsgDelete: (
        value: { chatType: number, peerUid: string } | {
          peer: { chatType: number, peerUid: string }
          msgIds: string[]
        },
        ids?: string[],
      ) => 'peer' in value
        ? this.onDelete(value.peer.chatType, value.peer.peerUid, value.msgIds)
        : this.onDelete(value.chatType, value.peerUid, ids ?? []),
      onRichMediaUploadComplete: (value: FileTransNotifyInfo | { notifyInfo: FileTransNotifyInfo }) => {
        const info = 'notifyInfo' in value ? value.notifyInfo : value
        const details = `msg=${info.msgId} status=${info.trasferStatus} error=${info.fileErrCode} server=${info.fileSrvErrCode ?? ''} step=${info.step ?? ''}`
        if (info.fileErrCode && info.fileErrCode !== '0') {
          log('error', `QQ media upload failed ${details}: ${info.clientMsg || info.fileErrMsg}`)
        } else {
          log('info', `QQ media upload completed ${details}`)
        }
      },
      },
    ))
    this.listenerId = msgService.addKernelMsgListener(msgListener)
    log('info', `native listener registered service=message id=${this.listenerId || '<empty>'}`)
    const buddyListener = markBridgeListener(makeListener('NodeIKernelBuddyListener', kernel.NodeIKernelBuddyListener, {
      onBuddyListChange: (value: Array<{ buddyList: ProfileSimpleInfo[] }> | {
        data: Array<{ buddyList: ProfileSimpleInfo[] }>
      }) => {
        const categories = Array.isArray(value) ? value : value.data
        log('info', `buddy list update received: ${categories.reduce((sum, item) => sum + item.buddyList.length, 0)} users`)
        this.replaceBuddySnapshot(categories)
        this.enrichBuddyNames()
      },
      onBuddyInfoChange: (value: Map<string, ProfileSimpleInfo> | { infos: Map<string, ProfileSimpleInfo> }) => {
        const infos = value instanceof Map ? value : value.infos
        log('info', `buddy info update received: ${infos.size} users`)
        // QQ emits profile changes for strangers that merely appeared in a
        // group or message. Only the full buddy snapshot may add contacts.
        for (const buddy of infos.values()) {
          this.rememberSeenUser({
            id: buddy.uid,
            numericId: buddy.uin,
            name: buddy.remark || buddy.nick || buddy.uin,
            avatarUrl: buddy.avatarUrl,
          })
          if (this.users.has(buddy.uid)) this.upsertBuddy(buddy)
        }
      },
    }))
    this.buddyListenerId = buddyService.addKernelBuddyListener(buddyListener)
    log('info', `native listener registered service=buddy id=${this.buddyListenerId || '<empty>'}`)
    if (this.profileService) {
      const profileListener = markBridgeListener(makeListener(
        'NodeIKernelProfileListener',
        kernel.NodeIKernelProfileListener,
        {
          onProfileSimpleChanged: (value: Map<string, ProfileSimpleInfo> | {
            profiles: Map<string, ProfileSimpleInfo>
          }) => {
            const profiles = value instanceof Map ? value : value.profiles
            log('info', `profile update received: ${profiles.size} users`)
            for (const profile of profiles.values()) this.upsertProfile(profile)
          },
        },
      ))
      this.profileListenerId = this.profileService.addKernelProfileListener(profileListener)
      log('info', `native listener registered service=profile id=${this.profileListenerId || '<empty>'}`)
    }
    const groupListener = markBridgeListener(makeListener('NodeIKernelGroupListener', kernel.NodeIKernelGroupListener, {
      onGroupListUpdate: (
        value: number | {
          groupList: Array<{
            groupCode: string
            groupName: string
            remarkName?: string
            avatarUrl?: string
            memberCount?: number
            memberRole?: number
          }>
        },
        legacyGroups?: Array<{
          groupCode: string
          groupName: string
          remarkName?: string
          avatarUrl?: string
          memberCount?: number
          memberRole?: number
        }>,
      ) => {
        const groups = typeof value === 'object' && value ? value.groupList ?? [] : legacyGroups ?? []
        log('info', `group list update received: type=${typeof value === 'number' ? value : 'object'} groups=${groups.length}`)
        for (const group of groups) {
          this.upsertGroupProfile(group)
        }
      },
      onGroupDetailInfoChange: (value: GroupProfileInfo | { groupDetail: GroupProfileInfo }) => {
        const group = value && 'groupDetail' in value ? value.groupDetail : value
        if (!group?.groupCode) return
        log('info', `group detail update received: group=${group.groupCode} name=${JSON.stringify(group.groupName || '')}`)
        this.upsertGroupProfile(group)
        this.pendingGroupProfiles.get(group.groupCode)?.resolve()
      },
      onGroupAllInfoChange: (value: GroupProfileInfo | { groupAll: GroupProfileInfo }) => {
        const group = value && 'groupAll' in value ? value.groupAll : value
        if (!group?.groupCode) return
        log('info', `group all-info update received: group=${group.groupCode} name=${JSON.stringify(group.groupName || '')}`)
        this.upsertGroupProfile(group)
        this.pendingGroupProfiles.get(group.groupCode)?.resolve()
      },
      onMemberListChange: (info: {
        sceneId: string
        ids: Array<{ uid: string, index: number }>
        infos: Map<string, MemberInfo>
        hasNext: boolean
      }) => {
        this.pendingMemberPages.get(info.sceneId)?.resolve({
          ids: info.ids,
          infos: info.infos,
          finish: !info.hasNext,
        })
      },
    }))
    this.groupListenerId = groupService.addKernelGroupListener(groupListener)
    log('info', `native listener registered service=group id=${this.groupListenerId || '<empty>'}`)
    if (recentService.addKernelRecentContactListener) {
      const recentListener = markBridgeListener(makeListener('NodeIKernelRecentContactListener', kernel.NodeIKernelRecentContactListener, {
        onRecentContactListChanged: (value: string[] | RecentContactInfo[] | {
          changedList: RecentContactInfo[]
        }, legacyChanged?: RecentContactInfo[]) => {
          const sorted = Array.isArray(value) && typeof value[0] === 'string' ? value as string[] : undefined
          const changed = Array.isArray(value)
            ? (typeof value[0] === 'string' ? legacyChanged ?? [] : value as RecentContactInfo[])
            : value.changedList ?? legacyChanged ?? []
          log('info', `recent contact update received: version=1 changed=${changed.length}`)
          this.consumeRecentContactList(sorted, changed)
          this.resolveRecentListUpdates()
        },
        onRecentContactListChangedVer2: (value: Array<{ sortedContactList?: string[], changedList?: RecentContactInfo[] }> | {
          changedRecentContactLists?: Array<{ sortedContactList?: string[], changedList?: RecentContactInfo[] }>
        }) => {
          const lists = Array.isArray(value) ? value : value.changedRecentContactLists ?? []
          const changed = lists.flatMap((item) => item.changedList ?? [])
          log('info', `recent contact update received: version=2 lists=${lists.length} changed=${changed.length} messages=${changed.map((item) => `${item.chatType}:${item.peerUid}:${item.msgSeq ?? ''}:${item.msgId || '<none>'}`).join(',') || '<none>'}`)
          for (const list of lists) {
            this.consumeRecentContactList(list.sortedContactList, list.changedList ?? [])
          }
          this.resolveRecentListUpdates()
        },
      }))
      this.recentListenerId = recentService.addKernelRecentContactListener(recentListener)
      log('info', `native listener registered service=recent id=${this.recentListenerId || '<empty>'}`)
    }
    if (this.searchService) {
      const searchListener = markBridgeListener(makeListener(
        'NodeIKernelSearchListener',
        kernel.NodeIKernelSearchListener,
        {
          onSearchMsgKeywordsResult: (
            value: SearchMsgKeywordsResult | { result: SearchMsgKeywordsResult },
          ) => this.onSearchPage('resultItems' in value ? value : value.result),
        },
      ))
      this.searchListenerId = this.searchService.addKernelSearchListener(searchListener)
      log('info', `native listener registered service=search id=${this.searchListenerId || '<empty>'}`)
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

  private waitForRecentListUpdate(timeoutMs: number): { promise: Promise<void>, cancel: () => void } {
    if (!this.recentListenerId) return { promise: Promise.resolve(), cancel() {} }
    let finish!: () => void
    const promise = new Promise<void>((resolve) => { finish = resolve })
    const timer = setTimeout(finish, timeoutMs)
    const waiter = () => {
      clearTimeout(timer)
      this.pendingRecentListUpdates.delete(waiter)
      finish()
    }
    this.pendingRecentListUpdates.add(waiter)
    return { promise, cancel: waiter }
  }

  private resolveRecentListUpdates(): void {
    for (const resolve of [...this.pendingRecentListUpdates]) resolve()
  }

  private consumeRecentContactList(sortedContactList: string[] | undefined, changedList: RecentContactInfo[]): void {
    for (const item of changedList) {
      this.upsertRecent(item)
      if (item.chatType !== CHAT_C2C && item.chatType !== CHAT_GROUP) continue
      const id = conversationId(item.chatType as 1 | 2, item.peerUid)
      if (item.contactId) this.recentContactIds.set(item.contactId, id)
      if (item.id) this.recentContactIds.set(item.id, id)
    }
    if (!sortedContactList?.length) return
    const ordered = sortedContactList.flatMap((contactId) => {
      const id = this.recentContactIds.get(contactId)
      return id ? [id] : []
    })
    if (ordered.length) this.recentContactOrder = [...new Set(ordered)]
  }

  private async requestBuddyList(): Promise<void> {
    const buddyService = this.requireBuddyService()
    const method = buddyService.getBuddyList.bind(buddyService)
    let result: unknown
    log('info', 'native API start name=getBuddyList force=true')
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
    log('info', `native API complete name=getBuddyList payload=${summarizeNativeResult(result)}`)
    this.consumeBuddyPayload(result)
  }

  private async initializePlatformData(): Promise<void> {
    void this.ensureReactionCatalog()
    if (this.config?.selfUid) {
      await this.ensureUserProfiles([this.config.selfUid]).catch((error) =>
        log('error', 'initial self profile refresh failed', error))
    }
    await this.refreshContacts().catch((error) => log('error', 'initial contact refresh failed', error))
  }

  private async ensureUserProfiles(uids: string[]): Promise<void> {
    const service = this.profileService
    if (!service) return
    const unique = [...new Set(uids.filter((uid) => uid && !/^\d+$/.test(uid)))]
    if (!unique.length) return
    const created: string[] = []
    for (const uid of unique) {
      if (this.pendingUserProfiles.has(uid)) continue
      this.pendingUserProfiles.set(uid, deferred<void>())
      created.push(uid)
    }
    const waits = unique.flatMap((uid) => {
      const pending = this.pendingUserProfiles.get(uid)
      return pending ? [pending.promise] : []
    })
    try {
      if (created.length) {
        log('info', `native API start name=getUserSimpleInfo force=false users=${created.join(',')}`)
        const result = await service.getUserSimpleInfo(false, created)
        log('info', `native API complete name=getUserSimpleInfo result=${result.result} err=${JSON.stringify(result.errMsg)} users=${created.join(',')}`)
        if (result.result !== 0) {
          const error = new Error(`getUserSimpleInfo: ${result.errMsg} (${result.result})`)
          for (const uid of created) this.pendingUserProfiles.get(uid)?.reject(error)
        } else if (service.getCoreAndBaseInfo) {
          log('info', `native API start name=getCoreAndBaseInfo users=${created.join(',')}`)
          try {
            const profiles = await withTimeout(
              service.getCoreAndBaseInfo('nodeStore', created),
              this.userResolveTimeoutMs,
              'QQ core/base profile request timed out',
            )
            for (const [uid, profile] of profiles) {
              this.upsertProfile({
                uid: profile.uid || uid,
                uin: profile.uin || '',
                nick: profile.coreInfo?.nick || '',
                remark: '',
                avatarUrl: profile.coreInfo?.avatarUrl || '',
                coreInfo: profile.coreInfo,
                baseInfo: profile.baseInfo,
              })
            }
            log('info', `native API complete name=getCoreAndBaseInfo users=${profiles.size}`)
          } catch (error) {
            log('error', `getCoreAndBaseInfo failed users=${created.join(',')}; using simple profile`, error)
          }
        }
      }
      await withTimeout(Promise.all(waits).then(() => undefined), 1_500, 'QQ user profile listener timed out')
    } finally {
      for (const uid of created) this.pendingUserProfiles.delete(uid)
    }
  }

  private async ensureReactionCatalog(): Promise<void> {
    for (let attempt = 0; this.session && !this.reactionDefinitions.length; attempt++) {
      try {
        await withTimeout(this.loadReactionCatalogOnce(), 5_000, 'QQ reaction catalog request timed out')
        if (this.reactionDefinitions.length) return
      } catch (error) {
        if (attempt % 6 === 0) log('error', 'reaction catalog load failed; retrying', error)
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000))
    }
  }

  private async loadReactionCatalogOnce(): Promise<void> {
    if (this.reactionDefinitions.length) return
    if (this.reactionCatalogPromise) return this.reactionCatalogPromise
    const pending = this.loadReactionCatalog()
    this.reactionCatalogPromise = pending
    try {
      await pending
    } finally {
      if (this.reactionCatalogPromise === pending) this.reactionCatalogPromise = undefined
    }
  }

  private async requestGroupList(): Promise<void> {
    const groupService = this.requireGroupService()
    const method = groupService.getGroupList.bind(groupService)
    log('info', 'native API start name=getGroupList force=false')
    try {
      const result = await method(false)
      log('info', `native API complete name=getGroupList payload=${summarizeNativeResult(result)}`)
    } catch (firstError) {
      try {
        const result = await (method as unknown as (params: { forceFetch: boolean }) => Promise<unknown>)({
          forceFetch: false,
        })
        log('info', `native API complete name=getGroupList form=object payload=${summarizeNativeResult(result)}`)
      } catch {
        throw firstError
      }
    }
  }

  private async ensureGroupProfile(groupCode: string): Promise<void> {
    const known = this.groups.get(groupCode)
    if (known && !isFallbackTitle(known.name, groupCode)) return
    const existing = this.pendingGroupProfiles.get(groupCode)
    if (existing) return withTimeout(existing.promise, 2_000, `QQ group profile request timed out: ${groupCode}`)
    const lastAttempt = this.groupProfileAttempts.get(groupCode) ?? 0
    if (Date.now() - lastAttempt < 30_000) return
    const method = this.requireGroupService().getGroupDetailInfo
    if (!method) return
    this.groupProfileAttempts.set(groupCode, Date.now())
    const pending = deferred<void>()
    this.pendingGroupProfiles.set(groupCode, pending)
    log('info', `native API start name=getGroupDetailInfo group=${groupCode} source=5`)
    try {
      const result = await method.call(this.requireGroupService(), groupCode, 5)
      log('info', `native API complete name=getGroupDetailInfo group=${groupCode} result=${result.result} err=${JSON.stringify(result.errMsg)}`)
      if (result.result !== 0) throw new Error(`getGroupDetailInfo: ${result.errMsg} (${result.result})`)
      await withTimeout(pending.promise, 1_000, `QQ group detail listener timed out: ${groupCode}`)
    } finally {
      if (this.pendingGroupProfiles.get(groupCode) === pending) this.pendingGroupProfiles.delete(groupCode)
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
      const categories = candidate.flatMap((category) => {
        if (!category || typeof category !== 'object') return []
        const buddies = (category as { buddyList?: unknown }).buddyList
        return Array.isArray(buddies) ? [{ buddyList: buddies as ProfileSimpleInfo[] }] : []
      })
      this.replaceBuddySnapshot(categories)
    } else if (Array.isArray(object.buddyList)) {
      this.replaceBuddySnapshot([{ buddyList: object.buddyList as ProfileSimpleInfo[] }])
    }
  }

  private async onMessages(
    records: MsgRecord[],
    source: 'onRecvMsg' | 'onAddSendMsg' | 'onMsgInfoListUpdate',
  ): Promise<void> {
    log('info', `native message batch source=${source} count=${records.length}`)
    await this.resolveReplyTargets(records)
    await this.resolveGrayTipUsers(records)
    for (const record of records) {
      if (record.chatType !== CHAT_C2C && record.chatType !== CHAT_GROUP) continue
      this.rememberRecordSender(record)
      const outgoing = record.senderUid === this.config?.selfUid || SEND_FROM_SELF.has(record.sendType)
      log('info', `native message event source=${source} id=${record.msgId} seq=${record.msgSeq ?? ''} peer=${record.peerUid} chatType=${record.chatType} outgoing=${outgoing} status=${record.sendStatus} elements=${record.elements?.length ?? 0} reactions=${record.emojiLikesList?.length ?? 0}`)
      if (isRecalledRecord(record)) {
        this.onDelete(record.chatType, record.peerUid, [record.msgId])
        continue
      }
      const pending = this.pendingMessages.get(record.msgId)
      if (record.sendStatus >= 1) this.pendingAcceptances.get(record.msgId)?.resolve()
      if (pending && record.sendStatus === 0) {
        this.pendingMessages.delete(record.msgId)
        pending.reject(new Error(`QQ send failed: ${record.msgId}`))
      } else if (pending
        && record.sendStatus >= (this.pendingMinimumStatuses.get(record.msgId) ?? 1)
        && record.msgId !== '0') {
        this.pendingMessages.delete(record.msgId)
        pending.resolve(record)
      } else if (record.msgId !== '0') {
        const id = conversationId(record.chatType as 1 | 2, record.peerUid)
        let index = this.pendingUnassigned.findIndex((item) => item.assignedMessageId === record.msgId)
        if (index < 0) index = this.pendingUnassigned.findIndex((item) =>
          !item.assignedMessageId
          && item.conversationId === id
          && Number(record.msgTime) >= item.startedAt - 2
          && (!item.expectedText || recordTextContent(record) === item.expectedText)
          && (!item.expectedMediaKind || record.elements.some((element) =>
            matchesElementKind(element, item.expectedMediaKind!)))
          && (!item.expectedMediaName || record.elements.some((element) =>
            element.fileElement?.fileName === item.expectedMediaName
            || element.picElement?.fileName === item.expectedMediaName)
            || item.expectedMediaKind === 'image'))
        // Current QQNT builds can return no usable ID from getMsgUniqueId().
        // Their first onAddSendMsg callback for images and stickers also omits
        // the completed media element, so content matching cannot identify the
        // pending send yet. Claim the oldest same-conversation send while this
        // authoritative add callback is in flight; later status updates then
        // keep using the assigned native ID instead of publishing an originless
        // local echo before the HTTP send response completes.
        if (index < 0 && outgoing && source === 'onAddSendMsg' && record.sendStatus >= 1) {
          index = this.pendingUnassigned.findIndex((item) =>
            !item.assignedMessageId
            && item.conversationId === id)
        }
        // A failure callback can contain only a placeholder or no media
        // element. Associate it with the oldest same-conversation request so
        // the HTTP send fails immediately instead of waiting for a timeout.
        if (index < 0 && outgoing && record.sendStatus === 0) {
          index = this.pendingUnassigned.findIndex((item) =>
            !item.assignedMessageId
            && item.conversationId === id)
        }
        if (index >= 0) {
          this.pendingUnassigned[index].assignedMessageId ??= record.msgId
          this.rememberMessageOrigin(record.msgId, this.pendingUnassigned[index].originRequestId)
        }
        if (index >= 0 && record.sendStatus >= 1) this.pendingUnassigned[index].accepted.resolve()
        if (index >= 0 && record.sendStatus === 0) {
          this.pendingUnassigned.splice(index, 1)[0].pending.reject(new Error('QQ send failed'))
        } else if (index >= 0 && record.sendStatus >= this.pendingUnassigned[index].minimumStatus) {
          this.pendingUnassigned.splice(index, 1)[0].pending.resolve(record)
        }
      }
      const conversation = this.conversationFromRecord(record)
      const message = this.mapMessage(record)
      const pendingMerged = outgoing && this.pendingMergedForwards.some((item) =>
        item.conversationId === conversation.id
        && Number(record.msgTime) >= item.startedAt - 1)
      if (pendingMerged && !isMultiForwardRecord(record)) {
        log('info', `native merged-forward placeholder deferred source=${source} id=${record.msgId} peer=${record.peerUid} status=${record.sendStatus}`)
        continue
      }
      if (source === 'onRecvMsg' && !message.outgoing) {
        log('info', receivedMessageSummary(conversation, message))
      }
      const previous = (this.messages.get(message.conversationId) ?? []).find((item) => item.id === message.id)
      // Some info updates only mutate delivery/media metadata and omit the
      // reaction field altogether. Absence is not an authoritative clear.
      if (record.emojiLikesList === undefined && previous?.reactionContext) {
        message.reactionContext = previous.reactionContext
      }
      if (record.sendStatus === 0) {
        if (previous) {
          this.forgetMessage(message)
          this.dispatch({
            type: 'message-delete',
            eventId: `send-failed:${message.id}:${Date.now()}`,
            conversation,
            messageIds: [message.id],
            timestamp: Math.floor(Date.now() / 1000),
          })
        }
        log('error', `native message rejected id=${record.msgId} peer=${record.peerUid} source=${source}`)
        continue
      }
      this.rememberMessage(message)
      const reactionsChanged = Boolean(previous)
        && JSON.stringify(previous?.reactionContext?.reactions) !== JSON.stringify(message.reactionContext?.reactions)
      if (source === 'onMsgInfoListUpdate' && record.emojiLikesList !== undefined) {
        this.pendingReactions.get(`${conversation.id}\u0000${message.id}`)?.resolve(
          message.reactionContext ?? { reactions: [], maxSelected: 20 },
        )
      }
      if (!previous) {
        this.dispatch({ type: 'message', conversation, message })
      } else if (reactionsChanged) {
        this.dispatch({
          type: 'message-reactions',
          // msgSeq is immutable, so it cannot identify successive mutations.
          // A process-local suffix keeps the delivery journal from suppressing
          // the second reaction update on the same QQ message.
          eventId: `reaction:${message.id}:${Date.now()}:${++this.reactionEventSequence}`,
          conversation,
          target: { conversationId: conversation.id, messageId: message.id, targetId: message.id },
          context: message.reactionContext ?? { reactions: [], maxSelected: 20 },
          timestamp: Math.floor(Date.now() / 1000),
        })
      } else {
        log('info', `native message duplicate suppressed source=${source} id=${message.id} peer=${record.peerUid} status=${record.sendStatus}`)
      }
      const reactionGrayTipSeq = reactionGrayTipSequence(record)
      if (reactionGrayTipSeq) {
        await this.refreshReactionsFromGrayTip(conversation, reactionGrayTipSeq).catch((error) => {
          log('error', `reaction gray-tip refresh failed conversation=${conversation.id} seq=${reactionGrayTipSeq}`, error)
        })
      }
    }
  }

  private async refreshReactionsFromGrayTip(
    conversation: QQConversation,
    msgSeq: string,
  ): Promise<void> {
    const cached = (this.messages.get(conversation.id) ?? [])
      .find((message) => message.msgSeq === msgSeq && !message.serviceAction)
    const service = this.requireMsgService()
    let record: MsgRecord | undefined
    if (cached) {
      const response = await retryTransientInvalidArgument(() =>
        service.getMsgsByMsgId(contact(conversation), [cached.id]))
      record = response.msgList.find((item) => item.msgId === cached.id)
    } else if (service.getMsgsBySeqAndCount) {
      const peer = contact(conversation)
      const responses = await Promise.all([true, false].map((queryOrder) =>
        retryHistoryCall(() => service.getMsgsBySeqAndCount!(peer, msgSeq, 4, queryOrder, true))))
      record = responses.flatMap((response) => response.msgList)
        .find((item) => item.msgSeq === msgSeq && !isGrayTipRecord(item) && !isRecalledRecord(item))
    }
    if (!record) {
      log('warn', `reaction gray-tip target lookup failed conversation=${conversation.id} seq=${msgSeq}`)
      return
    }

    const targetRecord = record
    const previous = cached
      ?? (this.messages.get(conversation.id) ?? []).find((message) => message.id === targetRecord.msgId)
    const refreshed = this.mapMessage(targetRecord)
    if (targetRecord.emojiLikesList === undefined && previous?.reactionContext) {
      refreshed.reactionContext = previous.reactionContext
    }
    this.rememberMessage(refreshed)
    if (JSON.stringify(previous?.reactionContext?.reactions)
      === JSON.stringify(refreshed.reactionContext?.reactions)) return
    if (!refreshed.reactionContext) return

    this.dispatch({
      type: 'message-reactions',
      eventId: `reaction-graytip:${refreshed.id}:${Date.now()}:${++this.reactionEventSequence}`,
      conversation,
      target: { conversationId: conversation.id, messageId: refreshed.id, targetId: refreshed.id },
      context: refreshed.reactionContext,
      timestamp: Math.floor(Date.now() / 1000),
    })
  }

  private onDelete(chatType: number, peerUid: string, ids: string[]): void {
    if (chatType !== CHAT_C2C && chatType !== CHAT_GROUP) return
    const uniqueIds = [...new Set(ids.filter(Boolean))]
    if (!uniqueIds.length) return
    log('info', `native message delete chatType=${chatType} peer=${peerUid} messages=${ids.join(',')}`)
    const id = conversationId(chatType, peerUid)
    const conversation = this.contacts.get(id) ?? this.getConversation(id)
    const cached = this.messages.get(id)
    if (cached) {
      for (const messageId of uniqueIds) {
        const message = cached.find((item) => item.id === messageId)
        if (message) this.forgetMessage(message)
      }
    }
    this.dispatch({
      type: 'message-delete',
      eventId: `delete:${chatType}:${peerUid}:${uniqueIds.join(',')}:${Date.now()}`,
      conversation,
      messageIds: uniqueIds,
      timestamp: Math.floor(Date.now() / 1000),
    })
  }

  private onRecall(chatType: number, peerUid: string, msgSeq: string): void {
    if (chatType !== CHAT_C2C && chatType !== CHAT_GROUP || !msgSeq) return
    const id = conversationId(chatType, peerUid)
    const cached = (this.messages.get(id) ?? []).find((message) => message.msgSeq === msgSeq)
    if (cached) {
      this.onDelete(chatType, peerUid, [cached.id])
      return
    }
    const service = this.requireMsgService()
    if (!service.getMsgsBySeqAndCount) {
      log('warn', `native recall could not resolve msgSeq=${msgSeq} peer=${peerUid}: getMsgsBySeqAndCount unavailable`)
      return
    }
    const peer = { chatType, peerUid, guildId: '' }
    void retryHistoryCall(() => service.getMsgsBySeqAndCount!(peer, msgSeq, 1, true, true))
      .then((result) => {
        const record = result.msgList.find((item) => item.msgSeq === msgSeq) ?? result.msgList[0]
        if (!record?.msgId) {
          log('warn', `native recall could not resolve msgSeq=${msgSeq} peer=${peerUid}: result=${result.result}`)
          return
        }
        this.onDelete(chatType, peerUid, [record.msgId])
      })
      .catch((error) => log('error', `native recall lookup failed msgSeq=${msgSeq} peer=${peerUid}`, error))
  }

  private dispatch(event: QQEvent): void {
    const eventId = String(++this.eventSequence)
    this.eventIds.set(event, eventId)
    this.recentEvents.push({ id: eventId, event })
    if (this.recentEvents.length > 2_048) this.recentEvents.splice(0, this.recentEvents.length - 2_048)
    log('info', `bridge event dispatch ${eventSummary(event)} eventId=${eventId} subscribers=${this.events.size}`)
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

  private forgetMessage(message: QQMessage): void {
    const messages = this.messages.get(message.conversationId)
    if (!messages) return
    const index = messages.findIndex((item) => item.id === message.id)
    if (index >= 0) messages.splice(index, 1)
    if (!messages.length) this.messages.delete(message.conversationId)
  }

  private async pollSentMessage(
    conversation: QQConversation,
    expectedText: string | undefined,
    startedAt: number,
    expectedMediaKind: 'image' | 'file' | 'sticker' | undefined,
    expectedMediaName: string | undefined,
    minimumStatus: number,
    signal: AbortSignal,
    sequenceHint?: string,
  ): Promise<MsgRecord> {
    // Some QQ groups omit the final listener notification. Text sends are
    // accepted at kSending=1, while media must reach kSuccess=2 so an upload
    // failure cannot escape as a successful HTTP response.
    await new Promise((resolve) => setTimeout(resolve, 300))
    const service = this.requireMsgService()
    while (true) {
      if (signal.aborted) throw signal.reason ?? new Error('send confirmation polling aborted')
      if (sequenceHint && sequenceHint !== '0' && service.getMsgsBySeqAndCount) {
        const hinted = await withTimeout(
          Promise.resolve().then(() => service.getMsgsBySeqAndCount!(
            contact(conversation), sequenceHint, 1, true, true,
          )),
          2_000,
          'QQ sequence confirmation timed out',
        ).catch((error) => {
          log('error', `send sequence confirmation failed conversation=${conversation.id} seq=${sequenceHint}`, error)
          return { result: -1, errMsg: '', msgList: [] as MsgRecord[] }
        })
        const found = hinted.msgList.find((record) =>
          record.senderUid === this.config?.selfUid || SEND_FROM_SELF.has(record.sendType))
        if (found?.sendStatus === 0) throw new Error(`QQ send failed: ${found.msgId}`)
        if (found && found.sendStatus >= minimumStatus) return found
      }
      const response = await withTimeout(
        Promise.resolve().then(() => service.getLatestDbMsgs
          ? service.getLatestDbMsgs(contact(conversation), 20)
          : service.getMsgs(contact(conversation), '0', 20, true)),
        2_000,
        'QQ history confirmation timed out',
        ).catch((error) => {
          log('error', `send confirmation poll failed conversation=${conversation.id}`, error)
          return { result: -1, errMsg: '', msgList: [] as MsgRecord[] }
        })
      const found = response.msgList.find((record) =>
        Number(record.msgTime) >= startedAt - 2
        && (record.senderUid === this.config?.selfUid || SEND_FROM_SELF.has(record.sendType))
        && (expectedText === undefined || recordTextContent(record) === expectedText)
        && (expectedMediaKind === undefined || record.elements.some((element) =>
          matchesElementKind(element, expectedMediaKind)))
        && (expectedMediaName === undefined || expectedMediaKind === 'image' || record.elements.some((element) =>
          element.fileElement?.fileName === expectedMediaName)))
      if (found?.sendStatus === 0) throw new Error(`QQ send failed: ${found.msgId}`)
      if (found && found.sendStatus >= minimumStatus) return found
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
  }

  private upsertRecent(item: RecentContactInfo): void {
    if (item.chatType !== CHAT_C2C && item.chatType !== CHAT_GROUP) return
    if (item.chatType === CHAT_C2C) {
      this.rememberSeenUser({
        id: item.peerUid,
        numericId: item.peerUin || undefined,
        name: item.peerName || item.remark || item.peerUin || item.peerUid,
        avatarUrl: item.avatarUrl,
      })
    }
    const user = item.chatType === CHAT_C2C ? this.users.get(item.peerUid) : undefined
    const group = item.chatType === CHAT_GROUP ? this.groups.get(item.peerUin || item.peerUid) : undefined
    const current = this.contacts.get(conversationId(item.chatType, item.peerUid))
    const id = conversationId(item.chatType, item.peerUid)
    if (item.msgId) {
      const candidate: MessagePosition = {
        id: item.msgId,
        timestamp: validTimestamp(item.msgTime),
        msgSeq: item.msgSeq,
      }
      const previous = this.recentTopMessages.get(id)
      if (!previous || previous.id === candidate.id || compareMessagePosition(candidate, previous) > 0) {
        this.recentTopMessages.set(id, candidate)
      }
    }
    const conversation: QQConversation = {
      id,
      kind: item.chatType === CHAT_GROUP ? 'group' : 'direct',
      title: user?.name || group?.name || item.remark || item.peerName || item.peerUin || item.peerUid,
      peerUid: item.peerUid,
      peerUin: item.peerUin || (item.chatType === CHAT_GROUP ? item.peerUid : ''),
      chatType: item.chatType,
      avatarUrl: user?.avatarUrl || group?.avatarUrl || item.avatarUrl,
      unreadCount: Number(item.unreadCnt) || 0,
      // abstractContent is only QQ's lossy UI summary (for example `[图片]`).
      // Never expose it as a QQMessage: getDialogs hydrates msgId through the
      // message service, while a delayed recent callback cannot replace a
      // newer real message already received from the message listener.
      lastMessage: current?.lastMessage,
      firstUnread: Number(item.unreadCnt) > 0 ? current?.firstUnread : undefined,
      readInboxMaxMessage: Number(item.unreadCnt) > 0 ? current?.readInboxMaxMessage : undefined,
    }
    this.mergeConversation(conversation)
  }

  private upsertBuddy(buddy: ProfileSimpleInfo): void {
    const previous = this.users.get(buddy.uid) ?? this.seenUsers.get(buddy.uid)
    const signature = buddy.baseInfo?.longNick ?? buddy.coreInfo?.longNick ?? buddy.longNick
    const user = {
      id: buddy.uid, numericId: buddy.uin, name: buddy.remark || buddy.nick || buddy.uin, avatarUrl: buddy.avatarUrl,
      signature: signature !== undefined ? signature : previous?.signature,
    }
    this.users.set(buddy.uid, user)
    this.rememberSeenUser({
      ...user,
      // A QQ nickname is global; the local buddy remark remains contact-only.
      name: buddy.nick || buddy.remark || buddy.uin,
    })
    const id = conversationId(CHAT_C2C, buddy.uid)
    const current = this.contacts.get(id)
    // Do not project the complete friend list as dialogs. Buddy updates only
    // enrich conversations introduced by RecentContact or explicit resolve.
    if (!current) return
    this.mergeConversation({
      id, kind: 'direct', title: user.name, peerUid: buddy.uid, peerUin: buddy.uin,
      chatType: CHAT_C2C, avatarUrl: buddy.avatarUrl, unreadCount: current?.unreadCount,
      lastMessage: current?.lastMessage,
    })
  }

  private upsertProfile(profile: ProfileSimpleInfo): void {
    if (!profile.uid) return
    const previous = this.seenUsers.get(profile.uid) ?? this.users.get(profile.uid)
    const profileName = profile.coreInfo?.nick || profile.nick
    const profileAvatarUrl = profile.coreInfo?.avatarUrl || profile.avatarUrl
    const profileSignature = profile.baseInfo?.longNick ?? profile.coreInfo?.longNick ?? profile.longNick
    const user = {
      ...previous,
      id: profile.uid,
      numericId: profile.uin || previous?.numericId,
      name: profileName || previous?.name || profile.uin || profile.uid,
      avatarUrl: profileAvatarUrl || previous?.avatarUrl,
      signature: profileSignature !== undefined ? profileSignature : previous?.signature,
    }
    // ProfileService is authoritative for the global QQ nickname. Message
    // records and buddy remarks must not make the same user oscillate between
    // account number, contact remark, and nickname.
    this.seenUsers.set(profile.uid, user)
    if (profile.uid === this.config?.selfUid || this.users.has(profile.uid)) {
      const contact = this.users.get(profile.uid)
      this.users.set(profile.uid, {
        ...user,
        name: profile.uid === this.config?.selfUid
          ? user.name
          : contact?.name || profile.remark || user.name,
      })
    }
    this.pendingUserProfiles.get(profile.uid)?.resolve()
  }

  private upsertGroupProfile(group: GroupProfileInfo & { avatarUrl?: string }): void {
    const name = group.remarkName || group.groupName || group.groupCode
    const previous = this.groups.get(group.groupCode)
    this.groups.set(group.groupCode, {
      name: !isFallbackTitle(name, group.groupCode) ? name : previous?.name || name,
      avatarUrl: group.avatarUrl || previous?.avatarUrl,
      participantCount: group.memberCount ?? group.memberNum ?? previous?.participantCount,
      selfRole: mapMemberRole(group.memberRole ?? group.cmdUinPrivilege) ?? previous?.selfRole,
    })
    const id = conversationId(CHAT_GROUP, group.groupCode)
    if (!this.contacts.has(id)) return
    this.mergeConversation({
      id,
      kind: 'group',
      title: name,
      peerUid: group.groupCode,
      peerUin: group.groupCode,
      chatType: CHAT_GROUP,
      avatarUrl: group.avatarUrl,
      participantCount: group.memberCount ?? group.memberNum,
      selfRole: mapMemberRole(group.memberRole ?? group.cmdUinPrivilege),
    })
  }

  private mergeConversation(next: QQConversation): QQConversation {
    const current = this.contacts.get(next.id)
    const peerKey = next.chatType === CHAT_GROUP
      ? next.peerUin || current?.peerUin || next.peerUid
      : next.peerUid
    const profileTitle = next.chatType === CHAT_GROUP
      ? this.groups.get(peerKey)?.name
      : this.users.get(next.peerUid)?.name
    const title = firstUsefulTitle(peerKey, profileTitle, next.title, current?.title, next.peerUin, next.peerUid)
    const cacheKey = `${next.chatType === CHAT_C2C ? 'user' : 'group'}:${peerKey}`
    const avatar = next.avatar ?? current?.avatar ?? this.avatarCache.get(cacheKey) ?? avatarMedia(cacheKey)
    this.avatarCache.set(cacheKey, avatar)
    const merged: QQConversation = {
      ...current,
      ...next,
      title,
      peerUin: next.peerUin || current?.peerUin || (next.chatType === CHAT_GROUP ? next.peerUid : ''),
      avatarUrl: next.avatarUrl || current?.avatarUrl,
      avatar,
      participantCount: next.participantCount
        ?? current?.participantCount
        ?? (next.chatType === CHAT_GROUP ? this.groups.get(peerKey)?.participantCount : undefined),
      selfRole: next.selfRole
        ?? current?.selfRole
        ?? (next.chatType === CHAT_GROUP ? this.groups.get(peerKey)?.selfRole : undefined),
      unreadCount: next.unreadCount ?? current?.unreadCount,
      lastMessage: next.lastMessage ?? current?.lastMessage,
    }
    this.contacts.set(merged.id, merged)
    return merged
  }

  private replaceBuddySnapshot(categories: Array<{ buddyList: ProfileSimpleInfo[] }>): void {
    const buddies = categories.flatMap((category) => category.buddyList)
    const keep = new Set(buddies.map((buddy) => buddy.uid))
    if (this.config?.selfUid) keep.add(this.config.selfUid)
    for (const uid of this.users.keys()) if (!keep.has(uid)) this.users.delete(uid)
    for (const buddy of buddies) this.upsertBuddy(buddy)
    this.buddySnapshotLoaded = true
  }

  private enrichBuddyNames(): void {
    const service = this.requireBuddyService()
    const uids = [...this.users.keys()].filter((uid) => uid !== this.config?.selfUid)
    if (!uids.length) return
    let nicks = new Map<string, string>()
    let remarks = new Map<string, string>()
    try {
      nicks = service.getBuddyNick?.(uids) ?? nicks
      remarks = service.getBuddyRemark?.(uids) ?? remarks
    } catch (error) {
      log('error', 'buddy name enrichment failed', error)
      return
    }
    for (const uid of uids) {
      const user = this.users.get(uid)
      if (!user) continue
      const name = remarks.get(uid) || nicks.get(uid) || user.name
      if (!name || name === user.name) continue
      this.users.set(uid, { ...user, name })
      const conversation = this.contacts.get(uid)
      if (conversation) this.mergeConversation({ ...conversation, title: name })
    }
  }

  private rememberRecordSender(record: MsgRecord): void {
    if (!record.senderUid) return
    this.rememberSeenUser({
      id: record.senderUid,
      numericId: record.senderUin || undefined,
      name: record.sendNickName || record.sendRemarkName || record.senderUin || record.senderUid,
    })
  }

  private rememberSeenUser(
    candidate: { id: string, numericId?: string, name: string, avatarUrl?: string, signature?: string },
  ): void {
    if (!candidate.id) return
    const current = this.seenUsers.get(candidate.id)
    const currentFallback = !current?.name || current.name === current.id || current.name === current.numericId
    const candidateFallback = !candidate.name || candidate.name === candidate.id || candidate.name === candidate.numericId
    const keepStableSelfName = candidate.id === this.config?.selfUid && current && !currentFallback
    this.seenUsers.set(candidate.id, {
      ...current,
      ...candidate,
      numericId: candidate.numericId || current?.numericId,
      name: keepStableSelfName
        ? current.name
        : !candidateFallback || currentFallback ? candidate.name : current!.name,
      avatarUrl: candidate.avatarUrl || current?.avatarUrl,
      signature: candidate.signature !== undefined ? candidate.signature : current?.signature,
    })
  }

  private conversationFromRecord(record: MsgRecord): QQConversation {
    const id = conversationId(record.chatType as 1 | 2, record.peerUid)
    const current = this.contacts.get(id)
    const message = this.mapMessage(record)
    const conversation: QQConversation = {
      id,
      kind: record.chatType === CHAT_GROUP ? 'group' : 'direct',
      title: current?.title || record.peerName || record.peerUin || record.peerUid,
      peerUid: record.peerUid,
      peerUin: current?.peerUin || record.peerUin || (record.chatType === CHAT_GROUP ? record.peerUid : ''),
      chatType: record.chatType as 1 | 2,
      avatarUrl: current?.avatarUrl,
      avatar: current?.avatar,
      unreadCount: current?.unreadCount,
      lastMessage: latestMessage(current?.lastMessage, message),
    }
    return this.mergeConversation(conversation)
  }

  private mapMessage(record: MsgRecord, context: MessageMappingContext = {}): QQMessage {
    if (!context.sender) this.rememberRecordSender(record)
    let senderId = context.sender?.id ?? (record.senderUid || record.senderUin)
    const parts: QQMessage['parts'] = []
    let replyToId: string | undefined
    let serviceAction: QQMessage['serviceAction']
    for (const element of record.elements ?? []) {
      const mappedSticker = mapSticker(record, element)
      if (mappedSticker) {
        const sticker = mergeKnownSticker(this.stickers.get(mappedSticker.stickerId), mappedSticker)
        this.stickers.set(sticker.stickerId, sticker)
        parts.push({ type: 'sticker', sticker })
      } else if (element.elementType === ELEMENT_TEXT && element.textElement?.content) {
        const text = element.textElement
        const mentionedId = text.atNtUid || text.atUid
        parts.push({
          type: 'text', text: text.content,
          entities: text.atType === 2 && mentionedId ? [{
            type: 'mention', offset: 0, length: text.content.length,
            userId: mentionedId, numericId: text.atUid || undefined,
          }] : undefined,
        })
      } else if (element.elementType === ELEMENT_FACE && element.faceElement) {
        const text = element.faceElement.faceType === 5
          ? element.faceElement.spokeSummary || element.faceElement.vaspokeName
            || element.faceElement.faceText || '[戳一戳]'
          : element.faceElement.faceText || `[QQ表情 ${element.faceElement.faceIndex}]`
        if (element.faceElement.faceType === 5) {
          serviceAction = { type: 'custom', text }
        } else {
          parts.push({
            type: 'text', text,
            entities: [{
              type: 'qq-face', offset: 0, length: text.length,
              faceId: String(element.faceElement.faceIndex), faceType: element.faceElement.faceType,
            }],
          })
        }
      } else if (element.elementType === ELEMENT_REPLY && element.replyElement) {
        replyToId = this.resolvedReplyTargets.get(record.msgId)
          ?? replyTargetId(record, element.replyElement)
          ?? replyToId
      } else if (element.elementType === ELEMENT_MULTI_FORWARD && element.multiForwardMsgElement) {
        parts.push({
          type: 'multi-forward',
          title: multiForwardTitle(element.multiForwardMsgElement),
          preview: multiForwardPreview(element.multiForwardMsgElement),
          locator: {
            conversationId: context.multiForwardConversationId
              ?? conversationId(record.chatType as 1 | 2, record.peerUid),
            rootMessageId: context.multiForwardRootId ?? record.msgId,
            ...(context.multiForwardRootId ? { parentMessageId: record.msgId } : {}),
          },
        })
      } else if (isArkMultiForwardRecord(record) && element.arkElement) {
        parts.push({
          type: 'multi-forward',
          title: arkMultiForwardTitle(element.arkElement.bytesData),
          preview: arkMultiForwardPreview(element.arkElement.bytesData),
          locator: {
            conversationId: context.multiForwardConversationId
              ?? conversationId(record.chatType as 1 | 2, record.peerUid),
            rootMessageId: context.multiForwardRootId ?? record.msgId,
            ...(context.multiForwardRootId ? { parentMessageId: record.msgId } : {}),
          },
        })
      } else {
        const card = structuredCard(element)
        if (card) {
          parts.push({ type: 'card', card })
          continue
        }
        if (element.grayTipElement) {
          const action = grayTipAction(
            element.grayTipElement,
            this.config?.selfUid,
            (uid) => this.seenUsers.get(uid)?.name ?? this.users.get(uid)?.name,
          )
          serviceAction = { type: 'custom', text: action.text }
          if ((!senderId || senderId === '0') && action.actorId) senderId = action.actorId
          continue
        }
        const media = mapMedia(record, element)
        if (media) parts.push({ type: 'media', media })
        else {
          const fallback = fallbackElementText(element, this.config?.selfUid)
          if (fallback) parts.push({ type: 'text', text: fallback })
        }
      }
    }
    const sender = this.seenUsers.get(senderId) ?? this.users.get(senderId)
    const nativeReply = record.elements?.find((element) => element.replyElement)?.replyElement
    return {
      id: record.msgId,
      conversationId: conversationId(record.chatType as 1 | 2, record.peerUid),
      senderId,
      sender: context.sender ?? {
        id: senderId,
        numericId: sender?.numericId || record.senderUin || undefined,
        name: sender?.name || record.sendNickName || record.sendRemarkName || record.senderUin || record.senderUid,
        alias: record.chatType === CHAT_GROUP ? record.sendMemberName || undefined : undefined,
        avatar: /^\d+$/.test(sender?.numericId || record.senderUin)
          ? qlogoAvatarMedia(senderId, sender?.numericId || record.senderUin)
          : undefined,
      },
      timestamp: Number(record.msgTime) || Math.floor(Date.now() / 1000),
      outgoing: context.outgoing
        ?? (SEND_FROM_SELF.has(record.sendType) || record.senderUid === this.config?.selfUid),
      msgSeq: record.msgSeq,
      // Gray tips (poke, joins, reaction notices, etc.) reuse the msgSeq of a
      // related content message, so only content messages can claim msgSeq as
      // their Telegram megagroup message ID.
      telegramMessageId: record.chatType === CHAT_GROUP && !serviceAction
        ? telegramMessageId(record.msgSeq)
        : undefined,
      telegramReplyToMessageId: record.chatType === CHAT_GROUP
        ? telegramMessageId(nativeReply?.replayMsgSeq)
        : undefined,
      originRequestId: this.messageOrigins.get(record.msgId),
      replyToId,
      serviceAction,
      parts,
      reactionContext: record.chatType === CHAT_GROUP && record.emojiLikesList?.length
        ? this.mapReactionState(record)
        : undefined,
    }
  }

  private async resolveGrayTipUsers(records: readonly MsgRecord[]): Promise<void> {
    const users = new Set<string>()
    for (const record of records) {
      for (const element of record.elements ?? []) {
        const json = element.grayTipElement?.jsonGrayTipElement?.jsonStr
        if (!json) continue
        try {
          const parsed = JSON.parse(json) as { items?: Array<{ type?: unknown, uid?: unknown, nm?: unknown }> }
          for (const item of parsed.items ?? []) {
            if (item.type !== 'qq' || typeof item.uid !== 'string' || !item.uid) continue
            if (item.uid === this.config?.selfUid || this.seenUsers.has(item.uid) || this.users.has(item.uid)) continue
            if (typeof item.nm === 'string' && item.nm) {
              this.rememberSeenUser({ id: item.uid, name: item.nm })
            } else {
              users.add(item.uid)
            }
          }
        } catch {}
      }
    }
    if (users.size) await this.ensureUserProfiles([...users]).catch((error) =>
      log('error', `gray-tip user profile resolve failed users=${[...users].join(',')}`, error))
  }

  private async resolveReplyTargets(records: MsgRecord[]): Promise<void> {
    const batchBySeq = new Map(records.flatMap((record) => {
      if (!record.msgSeq) return []
      const conversation = conversationId(record.chatType as 1 | 2, record.peerUid)
      return [[`${conversation}\u0000${record.msgSeq}`, record.msgId] as const]
    }))
    const cachedBySeq = new Map(records.flatMap((record) => {
      const conversation = conversationId(record.chatType as 1 | 2, record.peerUid)
      return (this.messages.get(conversation) ?? []).flatMap((message) =>
        message.msgSeq ? [[`${conversation}\u0000${message.msgSeq}`, message.id] as const] : [])
    }))
    await Promise.all(records.map(async (record) => {
      // QQ group msgSeq is the Telegram megagroup message ID, so group replies
      // never need a target msgId lookup.
      if (record.chatType === CHAT_GROUP) return
      if (this.resolvedReplyTargets.has(record.msgId)) return
      const reply = record.elements?.find((element) => element.replyElement)?.replyElement
      if (!reply) return
      const conversation = conversationId(record.chatType as 1 | 2, record.peerUid)
      const local = reply.replayMsgSeq
        ? batchBySeq.get(`${conversation}\u0000${reply.replayMsgSeq}`)
          ?? cachedBySeq.get(`${conversation}\u0000${reply.replayMsgSeq}`)
        : undefined
      if (local) {
        this.resolvedReplyTargets.set(record.msgId, local)
        return
      }
      const direct = replyTargetId(record, reply)
      if (direct) {
        this.resolvedReplyTargets.set(record.msgId, direct)
        return
      }
      if (reply.sourceMsgExpired) return
      const service = this.requireMsgService()
      const peer = contact(this.getConversation(conversation))
      try {
        const response = reply.replayMsgSeq && reply.replayMsgSeq !== '0' && service.getMsgsBySeqAndCount
          ? await withTimeout(
            retryHistoryCall(() => service.getMsgsBySeqAndCount!(peer, reply.replayMsgSeq!, 1, true, true)),
            2_000,
            'QQ reply source request timed out',
          )
          : reply.replyMsgClientSeq && reply.replyMsgTime && service.getSourceOfReplyMsgByClientSeqAndTime
            ? await withTimeout(
              service.getSourceOfReplyMsgByClientSeqAndTime(
                peer, record.msgId, reply.replyMsgClientSeq, reply.replyMsgTime,
              ),
              2_000,
              'QQ C2C reply source request timed out',
            )
            : undefined
        const target = response?.result === 0
          ? response.msgList.find((item) => !reply.replayMsgSeq || item.msgSeq === reply.replayMsgSeq)?.msgId
          : undefined
        if (target && target !== '0') this.resolvedReplyTargets.set(record.msgId, target)
      } catch (error) {
        log('error', `QQ reply source resolve failed message=${record.msgId} peer=${record.peerUid}`, error)
      }
    }))
  }

  private mapReactionState(record: MsgRecord): QQReactionState {
    const reactions = (record.emojiLikesList ?? []).flatMap((item) => {
      const nativeKey = reactionKey(item.emojiType, item.emojiId)
      const key = this.reactionByKey.get(nativeKey)?.key ?? nativeKey
      // Cloud-control catalogs can lag behind the message payload. Never turn
      // a real native reaction into an empty state merely because its visual
      // definition is not present in this QQNT build.
      return [{ key, count: Number(item.likesCnt) || 0, selected: item.isClicked || undefined }]
    })
    return { reactions, maxSelected: 20 }
  }

  private async loadReactionCatalog(): Promise<void> {
    const service = this.requireMsgService()
    const localRoot = this.findLocalReactionRoot()
    let configPath = localRoot ? join(localRoot, 'face_config.json') : ''
    let facePath = localRoot ? join(localRoot, 'sysface_res') : ''
    let emojiPath = localRoot ? join(localRoot, 'emoji_res') : ''
    if (!configPath || !existsSync(configPath) || !existsSync(facePath) || !existsSync(emojiPath)) {
      if (!service.getEmojiResourcePath) return
      const [configResult, faceResult, emojiResult] = await Promise.all([
        service.getEmojiResourcePath(0),
        service.getEmojiResourcePath(1),
        service.getEmojiResourcePath(2),
      ])
      if (configResult.result !== 0 || faceResult.result !== 0 || emojiResult.result !== 0) {
        throw new Error(`getEmojiResourcePath: ${configResult.errMsg || faceResult.errMsg || emojiResult.errMsg}`)
      }
      configPath = configResult.resourcePath
      facePath = faceResult.resourcePath
      emojiPath = emojiResult.resourcePath
    }
    const config = JSON.parse(await readFile(configPath, 'utf8')) as {
      sysface?: Array<{ QSid: string, QDes?: string, QHide?: string }>
      emoji?: Array<{ QSid: string, QCid?: string, AQLid?: string, QDes?: string, QHide?: string }>
    }
    const definitions: QQReactionDefinition[] = []
    const aliases = new Map<string, QQReactionDefinition>()
    const assets = new Map<string, { path: string, mimeType: 'image/png' | 'image/apng' }>()
    for (const item of config.emoji ?? []) {
      if (item.QHide === '1' || !item.QSid) continue
      const emojiId = item.QCid || item.AQLid
      if (!emojiId) continue
      const nativeKey = reactionKey('2', emojiId)
      let definition: QQReactionDefinition
      if (TELEGRAM_STANDARD_REACTIONS.has(item.QSid)) {
        definition = {
          key: nativeKey,
          title: cleanFaceName(item.QDes),
          presentation: { type: 'emoji', emoticon: item.QSid },
        }
      } else {
        const filePath = join(emojiPath, `emoji_${item.AQLid?.padStart(3, '0')}.png`)
        if (!item.AQLid || !existsSync(filePath)) continue
        const info = await stat(filePath)
        const dimensions = pngDimensions(await readFile(filePath))
        definition = {
          key: nativeKey,
          title: cleanFaceName(item.QDes),
          presentation: {
            type: 'custom',
            alt: item.QSid,
            resource: {
              version: Math.trunc(info.mtimeMs),
              format: 'static',
              mimeType: 'image/png',
              width: dimensions?.width ?? 56,
              height: dimensions?.height ?? 56,
              size: info.size,
              locator: { reactionKey: nativeKey },
            },
          },
        }
        assets.set(nativeKey, { path: filePath, mimeType: 'image/png' })
      }
      definitions.push(definition)
      if (item.QCid) aliases.set(reactionKey('2', item.QCid), definition)
      if (item.AQLid) aliases.set(reactionKey('2', item.AQLid), definition)
    }
    for (const item of config.sysface ?? []) {
      if (item.QHide === '1') continue
      const filePath = join(facePath, 'static', `s${item.QSid}.png`)
      if (!existsSync(filePath)) continue
      const animatedPath = join(facePath, 'apng', `s${item.QSid}.png`)
      const animated = existsSync(animatedPath)
      const info = await stat(animated ? animatedPath : filePath)
      const dimensions = pngDimensions(await readFile(filePath))
      const key = reactionKey('1', item.QSid)
      definitions.push({
        key,
        title: cleanFaceName(item.QDes),
        presentation: {
          type: 'custom',
          // Telegram expects CustomEmoji.alt to be a fallback emoji, not a
          // localized label. The QQ title remains available separately.
          alt: '🙂',
          resource: {
            version: Math.trunc(info.mtimeMs),
            format: animated ? 'video' : 'static',
            mimeType: animated ? 'video/webm' : 'image/png',
            width: dimensions?.width ?? 128,
            height: dimensions?.height ?? 128,
            size: animated ? undefined : info.size,
            locator: { reactionKey: key },
          },
        },
      })
      assets.set(key, {
        path: animated ? animatedPath : filePath,
        mimeType: animated ? 'image/apng' : 'image/png',
      })
    }
    this.reactionDefinitions = definitions
    this.reactionByKey.clear()
    this.reactionAssets.clear()
    for (const [key, asset] of assets) this.reactionAssets.set(key, asset)
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
    const cacheKey = `user:${uid}`
    const numericId = this.seenUsers.get(uid)?.numericId
      ?? this.users.get(uid)?.numericId
      ?? (uid === this.config?.selfUid ? this.config.selfUin : undefined)
    if (numericId && /^\d+$/.test(numericId)) {
      const avatar = qlogoAvatarMedia(uid, numericId)
      this.avatarCache.set(cacheKey, avatar)
      return avatar
    }
    const cached = this.avatarCache.get(cacheKey)
    if (cached && !force && hasAvatarFile(cached)) return cached
    try {
      const service = this.getAvatarService()
      if (!service) return cached ?? avatarMedia(cacheKey)
      let filePath = service.getAvatarPath(uid, 0)
      log('info', `avatar lookup kind=user peer=${uid} force=${force} cached=${Boolean(cached)} path=${JSON.stringify(filePath || '')}`)
      if (force && (!filePath || !existsSync(filePath))) {
        const result = await service.forceDownloadAvatar(uid, 0).catch((error) => {
          log('error', `avatar force download threw kind=user peer=${uid}`, error)
          return undefined
        })
        if (result) log('info', `avatar force download complete kind=user peer=${uid} result=${result.result} err=${JSON.stringify(result.errMsg)}`)
        filePath = await waitForAvatarPath(() => service.getAvatarPath(uid, 0))
      }
      if (filePath && existsSync(filePath)) {
        const avatar = avatarMedia(cacheKey, filePath)
        this.avatarCache.set(cacheKey, avatar)
        return avatar
      }
      const placeholder = cached ?? avatarMedia(cacheKey)
      this.avatarCache.set(cacheKey, placeholder)
      return placeholder
    } catch (error) {
      log('error', `avatar lookup failed kind=user peer=${uid}`, error)
      const placeholder = cached ?? avatarMedia(cacheKey)
      this.avatarCache.set(cacheKey, placeholder)
      return placeholder
    }
  }

  private async withConversationAvatar(conversation: QQConversation, force = true): Promise<QQConversation> {
    const peerKey = conversation.chatType === CHAT_GROUP ? conversation.peerUin || conversation.peerUid : conversation.peerUid
    const cacheKey = `${conversation.chatType === CHAT_C2C ? 'user' : 'group'}:${peerKey}`
    const cached = conversation.avatar ?? this.avatarCache.get(cacheKey)
    if (cached && !force && hasAvatarFile(cached)) return this.mergeConversation({ ...conversation, avatar: cached })
    try {
      const service = this.getAvatarService()
      if (!service) {
        const placeholder = cached ?? avatarMedia(cacheKey)
        this.avatarCache.set(cacheKey, placeholder)
        return this.mergeConversation({ ...conversation, avatar: placeholder })
      }
      let avatar: QQMedia | undefined
      if (conversation.chatType === CHAT_C2C) {
        avatar = await this.userAvatar(conversation.peerUid, force)
      } else {
        let filePath = service.getGroupAvatarPath(peerKey, 0) || service.getConfGroupAvatarPath(peerKey)
        log('info', `avatar lookup kind=group peer=${peerKey} force=${force} cached=${Boolean(cached)} path=${JSON.stringify(filePath || '')}`)
        if (force && (!filePath || !existsSync(filePath))) {
          const result = await service.forceDownloadGroupAvatar(peerKey, 0).catch((error) => {
            log('error', `avatar force download threw kind=group peer=${peerKey}`, error)
            return undefined
          })
          if (result) log('info', `avatar force download complete kind=group peer=${peerKey} result=${result.result} err=${JSON.stringify(result.errMsg)}`)
          filePath = await waitForAvatarPath(() =>
            service.getGroupAvatarPath(peerKey, 0) || service.getConfGroupAvatarPath(peerKey))
        }
        if (filePath && existsSync(filePath)) {
          avatar = avatarMedia(cacheKey, filePath)
          this.avatarCache.set(cacheKey, avatar)
        }
      }
      const result = avatar ?? cached ?? avatarMedia(cacheKey)
      this.avatarCache.set(cacheKey, result)
      return this.mergeConversation({ ...conversation, avatar: result })
    } catch (error) {
      log('error', `avatar lookup failed kind=${conversation.kind} peer=${peerKey}`, error)
      const placeholder = cached ?? avatarMedia(cacheKey)
      this.avatarCache.set(cacheKey, placeholder)
      return this.mergeConversation({ ...conversation, avatar: placeholder })
    }
  }

  private requireSession(): KernelSession {
    if (!this.session) throw new Error('QQNT kernel is not ready')
    return this.session
  }

  private requireConfig(): InitSessionConfig {
    if (!this.config) throw new Error('QQNT kernel is not ready')
    return this.config
  }

  private packetClientForSession(): QQPacketClient {
    return this.packetClient ??= new QQPacketClient(
      this.requireSession().getMsgService(), this.packetClientOptions,
    )
  }

  private async directReplyPart(
    conversation: QQConversation,
    messageId: string,
  ): Promise<DirectMessagePart> {
    let source: MsgRecord | undefined
    try {
      const result = await this.requireMsgService().getMsgsByMsgId(contact(conversation), [messageId])
      if (result.result === 0) source = result.msgList.find((record) => record.msgId === messageId)
    } catch (error) {
      log('warn', `QQ reply source lookup failed message=${messageId}`, error)
    }
    const config = this.requireConfig()
    return { kind: 'reply', reply: {
      messageId,
      sequence: source?.msgSeq,
      clientSequence: source?.msgSeq,
      senderUin: source?.senderUin,
      senderUid: source?.senderUid,
      receiverUid: source
        ? (SEND_FROM_SELF.has(source.sendType) || source.senderUid === config.selfUid
            ? conversation.peerUid
            : config.selfUid)
        : undefined,
      time: validTimestamp(source?.msgTime) || undefined,
    } }
  }

  private stagingPath(kind?: 'image' | 'file'): string {
    if (kind === 'image') {
      try {
        const nativeDir = this.requireSession().getRichMediaService().getRichMediaFileDir?.(
          ELEMENT_IMAGE, 1, true,
        )
        if (nativeDir) return join(nativeDir, '.qqnt-bridge-staging')
      } catch {
        // Fall through to the account-private staging directory.
      }
    }
    return this.config?.userPath
      ? join(this.config.userPath, '.qqnt-bridge-staging')
      : this.tempPath
  }

  private async requireProtocolPeerUin(conversation: QQConversation): Promise<string> {
    if (conversation.chatType === CHAT_GROUP) return conversation.peerUin || conversation.peerUid
    if (conversation.peerUin) return conversation.peerUin
    const cached = this.users.get(conversation.peerUid)?.numericId
      ?? this.seenUsers.get(conversation.peerUid)?.numericId
    if (cached) {
      this.mergeConversation({ ...conversation, peerUin: cached })
      return cached
    }
    const converted = await retryTransientInvalidArgument(
      () => this.requireSession().getUixConvertService().getUin(new Set([conversation.peerUid])),
    )
    const peerUin = converted.uinInfo.get(conversation.peerUid)
    if (!peerUin) throw new Error(`QQ user ${conversation.peerUid} could not be resolved to a UIN`)
    this.mergeConversation({ ...conversation, peerUin })
    return peerUin
  }

  private rememberMessageOrigin(messageId: string, originRequestId?: string): void {
    if (!originRequestId || !messageId || messageId === '0') return
    this.messageOrigins.delete(messageId)
    this.messageOrigins.set(messageId, originRequestId)
    while (this.messageOrigins.size > 1024) {
      const oldest = this.messageOrigins.keys().next().value as string | undefined
      if (!oldest) break
      this.messageOrigins.delete(oldest)
    }
  }

  private requireMsgService(): ReturnType<KernelSession['getMsgService']> {
    return this.msgService ??= this.requireSession().getMsgService()
  }

  private requireBuddyService(): ReturnType<KernelSession['getBuddyService']> {
    return this.buddyService ??= this.requireSession().getBuddyService()
  }

  private requireGroupService(): ReturnType<KernelSession['getGroupService']> {
    return this.groupService ??= this.requireSession().getGroupService()
  }

  private requireSearchService(): NonNullable<ReturnType<NonNullable<KernelSession['getSearchService']>>> {
    const service = this.searchService ?? this.requireSession().getSearchService?.()
    if (!service) throw new Error('QQ message search is unavailable in this QQNT build')
    return this.searchService = service
  }

  private getAvatarService(): NonNullable<ReturnType<NonNullable<KernelSession['getAvatarService']>>> | undefined {
    if (this.avatarService) return this.avatarService
    try {
      return this.avatarService = this.requireSession().getAvatarService?.()
    } catch {
      return
    }
  }

  private async loadStickerPackCatalog(): Promise<void> {
    if (this.stickerPackInfo.size) return
    const service = this.requireMsgService()
    if (service.fetchBottomEmojiTableList) {
      let segment = 0
      let sameSegmentTimes = 0
      for (let page = 0; page < 100; page++) {
        const result = await service.fetchBottomEmojiTableList({
          commonReqInfo: { appVersion: '', businessId: 0 },
          timeStamp: 0,
          segmentFlag: segment,
        })
        if (result.result !== 0) {
          throw new Error(`fetchBottomEmojiTableList: ${result.errMsg} (${result.result})`)
        }
        const table = result.marketEmoticonInfo
        const legacyTable = (table as typeof table & { roamEmojiTab?: {
          ordinaryTabinfoList?: unknown[], magicTabinfoList?: unknown[], smallTabinfoList?: unknown[]
        } }).roamEmojiTab
        log('info', `native API complete name=fetchBottomEmojiTableList segment=${segment} next=${table.segmentFlag} tabs=${table.emojiNewTabs?.length ?? 0} legacyTabs=${(legacyTable?.ordinaryTabinfoList?.length ?? 0) + (legacyTable?.magicTabinfoList?.length ?? 0) + (legacyTable?.smallTabinfoList?.length ?? 0)} keys=${JSON.stringify(Object.keys(table))}`)
        for (const item of table.emojiNewTabs ?? []) {
          if (item.isHide || item.bottomEmojitabType !== 0) continue
          this.stickerPackInfo.set(String(item.epId), {
            epId: item.epId,
            wordingId: item.wordingId,
            tabType: item.bottomEmojitabType,
            tabName: item.tabName,
          })
        }
        if (table.segmentFlag === -1) return
        sameSegmentTimes = table.segmentFlag === segment ? sameSegmentTimes + 1 : 0
        if (sameSegmentTimes >= 4) return
        segment = table.segmentFlag
      }
      throw new Error('QQ bottom sticker table pagination exceeded 100 pages')
    }
    if (!service.fetchMarketEmoticonList) return
    let timestamp = 0
    let segment = 0
    let sameSegmentTimes = 0
    for (let page = 0; page < 100; page++) {
      const result = await service.fetchMarketEmoticonList(timestamp, segment)
      if (result.result !== 0) throw new Error(`fetchMarketEmoticonList: ${result.errMsg} (${result.result})`)
      const tab = result.marketEmoticonInfo.roamEmojiTab
      for (const item of [
        ...(tab.ordinaryTabinfoList ?? []),
        ...(tab.magicTabinfoList ?? []),
        ...(tab.smallTabinfoList ?? []),
      ]) this.stickerPackInfo.set(String(item.epId), item)
      timestamp = tab.timesTamp
      if (tab.segmentFlag === -1) return
      sameSegmentTimes = tab.segmentFlag === segment ? sameSegmentTimes + 1 : 0
      // Current QQ clients accept several pages with the same segment marker. The
      // timestamp still advances, while the marker may only change after a batch.
      // Match their bounded retry behavior so a stuck native response cannot loop.
      if (sameSegmentTimes >= 4) return
      segment = tab.segmentFlag
    }
    throw new Error('QQ sticker pack pagination exceeded 100 pages')
  }

  private async mapFavoriteSticker(item: CustomEmotionData): Promise<QQSticker> {
    const service = this.requireMsgService()
    if (item.isMarkFace && item.epId && item.eId) {
      const packageId = item.epId
      const epId = Number(packageId)
      const [details, keys] = await Promise.all([
        service.getFavMarketEmoticonInfo?.(epId, item.eId),
        service.getMarketEmoticonEncryptKeys?.(epId, [item.eId]),
      ])
      const info = details?.result === 0 ? details.favMarketEmoticonInfo : undefined
      const animated = item.isAPNG || extname(item.emoOriginalPath || item.emoPath).toLowerCase() === '.gif'
      const reference: QQStickerReference = {
        kind: 'market', packageId, stickerId: item.eId,
        name: info?.faceName || item.desc || '[表情]',
        key: keys?.result === 0 ? keys.encryptKeyMap.get(item.eId) ?? '' : '',
        width: positiveInteger(info?.width, 240), height: positiveInteger(info?.height, 240),
        animated,
        staticPath: item.thumbPath || item.emoPath || undefined,
        dynamicPath: item.emoOriginalPath || item.emoPath || undefined,
        favoriteResId: item.resId,
      }
      return {
        stickerId: marketStickerId(packageId, item.eId), packId: packageId,
        title: reference.name, format: animated ? 'animated' : 'static',
        mimeType: animated ? 'image/gif' : imageMimeType(reference.staticPath ?? '', false),
        width: reference.width, height: reference.height, version: 1, reference,
      }
    }
    const path = [item.emoOriginalPath, item.emoPath, item.thumbPath].find((value) => value && existsSync(value))
      ?? (item.emoOriginalPath || item.emoPath || item.thumbPath)
    const animated = item.isAPNG || /\.(?:gif|apng)$/i.test(path)
    const dimensions = path && existsSync(path) ? await imageFileDimensions(path) : undefined
    const reference: QQStickerReference = {
      kind: 'favorite', resId: item.resId, path,
      name: basename(path) || `${item.resId}.${animated ? 'gif' : 'png'}`,
      md5: item.md5 || undefined,
      size: path && existsSync(path) ? statSync(path).size : undefined,
      width: dimensions?.width, height: dimensions?.height, animated,
    }
    return {
      stickerId: favoriteStickerId(item.resId), title: item.desc || undefined,
      format: animated ? 'animated' : 'static', mimeType: imageMimeType(path, animated),
      width: dimensions?.width, height: dimensions?.height, size: reference.size,
      version: 1, reference,
    }
  }

  private async resolveMarketStickerPath(reference: Extract<QQStickerReference, { kind: 'market' }>): Promise<{
    path: string
    encrypted: boolean
    animated: boolean
  }> {
    if (reference.animated && reference.dynamicPath && existsSync(reference.dynamicPath)) {
      return { path: reference.dynamicPath, encrypted: true, animated: true }
    }
    const service = this.requireMsgService()
    const epId = Number(reference.packageId)
    const dynamic = service.getMarketEmoticonPath
      ? (await this.getMarketEmoticonPaths(epId, [reference.stickerId], 5)).get(reference.stickerId)
      : undefined
    if (reference.animated && dynamic?.isExist && dynamic.path && existsSync(dynamic.path)) {
      reference.dynamicPath = dynamic.path
      return { path: dynamic.path, encrypted: true, animated: true }
    }
    if (service.fetchMarketEmoticonAioImage) {
      const result = await service.fetchMarketEmoticonAioImage({
        epId, eId: reference.stickerId, name: reference.name, encryptKey: reference.key,
        width: reference.width, height: reference.height, jobType: 0,
      })
      if (result.result !== 0) throw new Error(`fetchMarketEmoticonAioImage: ${result.errMsg} (${result.result})`)
      if (service.getMarketEmoticonPath) {
        // Telegram Desktop commonly prefetches every document in a set at
        // once. QQ serializes those downloads internally, so a later item can
        // finish well after fetchMarketEmoticonAioImage has accepted it.
        for (let attempt = 0; attempt < 300; attempt++) {
          const downloaded = (await this.getMarketEmoticonPaths(epId, [reference.stickerId], 5))
            .get(reference.stickerId)
          if (reference.animated && downloaded?.path && existsSync(downloaded.path)) {
            reference.dynamicPath = downloaded.path
            return { path: downloaded.path, encrypted: true, animated: true }
          }
          if (attempt < 299) await delay(100)
        }
      }
    }
    let staticPath = reference.staticPath
    if (!staticPath && service.getMarketEmoticonPath) {
      staticPath = (await this.getMarketEmoticonPaths(epId, [reference.stickerId], 4))
        .get(reference.stickerId)?.path
        || (await this.getMarketEmoticonPaths(epId, [reference.stickerId], 3))
          .get(reference.stickerId)?.path
    }
    if (!staticPath || !existsSync(staticPath)) {
      throw new Error(`QQ market sticker file is missing: ${reference.packageId}/${reference.stickerId}`)
    }
    reference.staticPath = staticPath
    return { path: staticPath, encrypted: false, animated: false }
  }

  private async getMarketEmoticonPaths(
    epId: number,
    eIds: string[],
    serviceType: number,
  ): Promise<Map<string, { isExist: boolean, path: string }>> {
    const method = this.requireMsgService().getMarketEmoticonPath
    if (!method) return new Map()
    const response = await method(epId, eIds, serviceType)
    if (response instanceof Map) return response
    if (response.result !== 0) {
      throw new Error(`getMarketEmoticonPath: ${response.errMsg} (${response.result})`)
    }
    return response.pathMap
  }

  private async findFavoriteResId(
    reference: Extract<QQStickerReference, { kind: 'market' }>,
  ): Promise<string | undefined> {
    const service = this.requireMsgService()
    if (!service.fetchFavEmojiList) return
    let cursor = ''
    for (let page = 0; page < 20; page++) {
      const result = await service.fetchFavEmojiList(cursor, 200, true, false)
      if (result.result !== 0) throw new Error(`fetchFavEmojiList: ${result.errMsg} (${result.result})`)
      const found = result.emojiInfoList.find((item) =>
        item.isMarkFace && item.epId === reference.packageId && item.eId === reference.stickerId)
      if (found) return found.resId
      const next = result.emojiInfoList.at(-1)?.resId
      if (result.emojiInfoList.length < 200 || !next || next === cursor) return
      cursor = next
    }
  }

  private async latestRecords(conversation: QQConversation, limit: number): Promise<MsgRecord[]> {
    const service = this.requireMsgService()
    if (service.getLatestDbMsgs) {
      const result = await service.getLatestDbMsgs(contact(conversation), limit)
      if (result.result === 0) return result.msgList
    }
    const result = await service.getMsgs(contact(conversation), '0', limit, true)
    return result.result === 0 ? result.msgList : []
  }

  private async waitForForwardedMessages(
    conversation: QQConversation,
    before: Set<string>,
    expected: number,
    startedAt: number,
    requireMergedCard = false,
  ): Promise<QQMessage[]> {
    const deadline = Date.now() + Math.min(this.sendTimeoutMs, 20_000)
    do {
      const records = await this.latestRecords(conversation, Math.max(50, expected * 4))
      const forwarded = records.filter((record) =>
        !before.has(record.msgId)
        && Number(record.msgTime) >= startedAt - 1
        && (SEND_FROM_SELF.has(record.sendType) || record.senderUid === this.config?.selfUid)
        && (!requireMergedCard || record.sendStatus >= 2 && isMultiForwardRecord(record)))
      if (forwarded.length >= expected) {
        return forwarded.slice(0, expected).reverse().map((record) => {
          const message = this.mapMessage(record)
          this.rememberMessage(message)
          return message
        })
      }
      await delay(100)
    } while (Date.now() < deadline)
    throw new Error(`QQ did not expose ${expected} ${requireMergedCard ? 'merged-forward card' : 'forwarded message'}(s) in ${conversation.id}`)
  }
}

function contact(conversation: QQConversation) {
  return { chatType: conversation.chatType, peerUid: conversation.peerUid, guildId: '' }
}

function latestMessage(current: QQMessage | undefined, candidate: QQMessage): QQMessage {
  if (!current || current.id === candidate.id) return candidate
  return compareMessagePosition(candidate, current) > 0 ? candidate : current
}

function compareMessagePosition(left: MessagePosition, right: MessagePosition): number {
  const leftSeq = numericSequence(left.msgSeq)
  const rightSeq = numericSequence(right.msgSeq)
  if (leftSeq !== undefined && rightSeq !== undefined && leftSeq !== rightSeq) {
    return leftSeq > rightSeq ? 1 : -1
  }
  if (left.timestamp !== right.timestamp) return left.timestamp > right.timestamp ? 1 : -1
  return 0
}

function numericSequence(value: string | undefined): bigint | undefined {
  return value && /^\d+$/.test(value) ? BigInt(value) : undefined
}

function validTimestamp(value: string | undefined): number {
  const timestamp = Number(value)
  return Number.isFinite(timestamp) && timestamp > 0 ? Math.trunc(timestamp) : 0
}

function matchesSearchMedia(message: QQMessage, kind: SearchQuery['mediaKind']): boolean {
  return !kind || message.parts.some((part) => part.type === 'media' && part.media.kind === kind)
}

function safeCancelSearch(
  service: NonNullable<ReturnType<NonNullable<KernelSession['getSearchService']>>> | undefined,
  searchId: number,
  reason: string,
): void {
  if (!service) return
  try {
    service.cancelSearchChatMsgs(searchId, 2, reason)
  } catch (error) {
    log('error', `cancelSearchChatMsgs failed searchId=${searchId}`, error)
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

class FramedUploadReader {
  private readonly iterator: AsyncIterator<unknown>
  private buffered = Buffer.alloc(0)
  private ended = false

  constructor(body: Readable) {
    this.iterator = body[Symbol.asyncIterator]()
  }

  async *media(index: number): AsyncIterable<Buffer> {
    while (true) {
      const header = await this.readExactly(4, `media ${index} frame header`)
      const length = header.readUInt32BE(0)
      if (length === 0) return
      if (length > 1024 * 1024) throw new Error(`media ${index} frame is too large: ${length}`)
      yield await this.readExactly(length, `media ${index} frame body`)
    }
  }

  async finish(): Promise<void> {
    if (this.buffered.length) throw new Error(`framed upload has ${this.buffered.length} trailing bytes`)
    const next = await this.iterator.next()
    if (!next.done && Buffer.byteLength(next.value as Uint8Array)) {
      throw new Error('framed upload has trailing data')
    }
    this.ended = true
  }

  private async readExactly(length: number, description: string): Promise<Buffer> {
    while (this.buffered.length < length && !this.ended) {
      const next = await this.iterator.next()
      if (next.done) {
        this.ended = true
        break
      }
      const chunk = Buffer.isBuffer(next.value) ? next.value : Buffer.from(next.value as Uint8Array)
      if (!chunk.length) continue
      this.buffered = this.buffered.length ? Buffer.concat([this.buffered, chunk]) : chunk
    }
    if (this.buffered.length < length) {
      throw new Error(`incomplete framed upload while reading ${description}`)
    }
    const output = this.buffered.subarray(0, length)
    this.buffered = this.buffered.subarray(length)
    return output
  }
}

function directTextParts(part: QQTextPart): DirectMessagePart[] {
  const entities = (part.entities ?? [])
    .filter((entity) => entity.offset >= 0 && entity.length > 0
      && entity.offset + entity.length <= part.text.length)
    .sort((left, right) => left.offset - right.offset)
  if (!entities.length) return part.text ? [{ kind: 'text', text: part.text }] : []
  const parts: DirectMessagePart[] = []
  let offset = 0
  for (const entity of entities) {
    if (entity.offset < offset) continue
    if (entity.offset > offset) parts.push({ kind: 'text', text: part.text.slice(offset, entity.offset) })
    const content = part.text.slice(entity.offset, entity.offset + entity.length)
    if (entity.type === 'mention') {
      parts.push({
        kind: 'mention', text: content,
        userUid: entity.userId, userUin: entity.numericId,
      })
    } else {
      const faceIndex = Number(entity.faceId)
      if (!Number.isInteger(faceIndex) || faceIndex < 0) parts.push({ kind: 'text', text: content })
      else parts.push({ kind: 'face', face: { faceId: faceIndex, faceType: entity.faceType || 1 } })
    }
    offset = entity.offset + entity.length
  }

  if (offset < part.text.length) parts.push({ kind: 'text', text: part.text.slice(offset) })
  return parts
}

async function imageFileDimensions(path: string): Promise<{ width: number, height: number } | undefined> {
  const handle = await openFile(path, 'r')
  try {
    const header = Buffer.alloc(256 * 1024)
    const { bytesRead } = await handle.read(header, 0, header.length, 0)
    return encodedImageDimensions(header.subarray(0, bytesRead))
  } finally {
    await handle.close()
  }
}

async function hashFile(path: string, algorithm: string): Promise<string> {
  const hash = createHash(algorithm)
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

async function hashFilePrefix(path: string, algorithm: string, limit: number): Promise<string> {
  const hash = createHash(algorithm)
  if (limit <= 0) return hash.digest('hex')
  for await (const chunk of createReadStream(path, { start: 0, end: limit - 1 })) hash.update(chunk)
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
    const animated = isAnimatedPicture(picture)
    return {
      id: element.elementId || `${record.msgId}:image`,
      kind: 'image',
      name: picture.fileName,
      size: numberOrUndefined(picture.fileSize),
      width: picture.picWidth || undefined,
      height: picture.picHeight || undefined,
      mimeType: imageMimeType(picture.fileName, animated),
      locator: {
        ...base, kind: 'image', fileName: picture.fileName, fileSize: picture.fileSize,
        // A thumbPath can point at a thumbnail that QQ is still writing. It is
        // not a valid substitute for the original requested by this locator.
        filePath: picture.sourcePath, fileUuid: picture.fileUuid, fileSubId: picture.fileSubId,
        fileBizId: picture.fileBizId, md5: picture.md5HexStr,
        originImageUrl: picture.originImageUrl,
      },
    }
  }

  if (element.videoElement) {
    const video = element.videoElement
    return {
      id: element.elementId || `${record.msgId}:video`,
      kind: 'file',
      name: video.fileName,
      mimeType: videoMimeType(video.fileName, video.fileFormat),
      size: numberOrUndefined(video.fileSize),
      width: video.thumbWidth || undefined,
      height: video.thumbHeight || undefined,
      duration: Number.isFinite(video.fileTime) && video.fileTime >= 0 ? video.fileTime : undefined,
      locator: {
        ...base, kind: 'file', fileName: video.fileName, fileSize: video.fileSize,
        filePath: video.filePath, fileUuid: video.fileUuid, fileSubId: video.fileSubId,
        fileBizId: video.fileBizId, md5: video.videoMd5 || video.originVideoMd5,
        videoCodecFormat: video.sourceVideoCodecFormat ?? 0,
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
        file10MMd5: file.file10MMd5,
      },
    }
  }
}

function mapSticker(record: MsgRecord, element: MsgElement): QQSticker | undefined {
  const face = element.faceElement
  if (element.elementType === ELEMENT_FACE && face && (face.faceType === 3 || face.faceType === 4)) {
    const faceId = String(face.faceIndex)
    const reference: QQStickerReference = {
      kind: 'sysface', faceId, faceType: face.faceType,
      name: face.faceText || `[QQ表情 ${faceId}]`,
      packId: face.packId, stickerId: face.stickerId,
      sourceType: face.sourceType, stickerType: face.stickerType,
      resultId: face.resultId, imageType: face.imageType,
      animated: true,
    }
    return {
      stickerId: sysFaceStickerId(faceId), title: reference.name,
      format: 'animated', mimeType: 'image/apng',
      width: 240, height: 240, version: 1, reference,
    }
  }
  const market = element.marketFaceElement
  if (element.elementType === ELEMENT_MARKET_FACE && market?.emojiId) {
    const packageId = String(market.emojiPackageId)
    const animated = market.emojiType === 2 || Boolean(market.dynamicFacePath)
    const reference: QQStickerReference = {
      kind: 'market', packageId, stickerId: market.emojiId,
      name: market.faceName?.replace(/^\[|\]$/g, '') || '[表情]', key: market.key ?? '',
      width: positiveInteger(market.imageWidth, 240),
      height: positiveInteger(market.imageHeight, 240),
      animated, staticPath: market.staticFacePath, dynamicPath: market.dynamicFacePath,
    }
    return {
      stickerId: marketStickerId(packageId, market.emojiId), packId: packageId,
      title: reference.name, format: animated ? 'animated' : 'static',
      mimeType: animated ? 'image/gif' : 'image/png',
      width: reference.width, height: reference.height, version: 1, reference,
    }
  }
  const picture = element.picElement
  if (!picture || !isStickerPicture(picture)) return
  const media = mapMedia(record, element)
  if (!media) return
  const animated = isAnimatedPicture(picture)
  const resId = picture.md5HexStr || element.elementId || `${record.msgId}:image`
  const reference: QQStickerReference = {
    kind: 'favorite', resId,
    path: picture.sourcePath || [...(picture.thumbPath?.values() ?? [])][0] || '',
    name: picture.fileName || `${resId}.${animated ? 'gif' : 'png'}`,
    md5: picture.md5HexStr || undefined,
    size: numberOrUndefined(picture.fileSize), width: picture.picWidth || undefined,
    height: picture.picHeight || undefined, animated, locator: media.locator,
  }
  return {
    stickerId: favoriteStickerId(resId), format: animated ? 'animated' : 'static',
    mimeType: imageMimeType(picture.fileName, animated), width: reference.width,
    height: reference.height, size: reference.size, version: 1, reference,
  }
}

function stickerFromReference(reference: QQStickerReference): QQSticker {
  if (reference.kind === 'sysface') {
    return {
      stickerId: sysFaceStickerId(reference.faceId),
      title: reference.name,
      format: 'animated',
      mimeType: systemFaceMimeType(reference.url ?? '', undefined),
      width: reference.width ?? 240,
      height: reference.height ?? 240,
      version: 1,
      reference,
    }
  }
  if (reference.kind === 'market') {
    return {
      stickerId: marketStickerId(reference.packageId, reference.stickerId),
      packId: reference.packageId,
      title: reference.name,
      format: reference.animated ? 'animated' : 'static',
      mimeType: reference.animated ? 'image/gif' : 'image/png',
      width: reference.width,
      height: reference.height,
      version: 1,
      reference,
    }
  }
  return {
    stickerId: favoriteStickerId(reference.resId),
    title: reference.name,
    format: reference.animated ? 'animated' : 'static',
    mimeType: imageMimeType(reference.name, reference.animated),
    width: reference.width,
    height: reference.height,
    size: reference.size,
    version: 1,
    reference,
  }
}

function mergeKnownSticker(known: QQSticker | undefined, current: QQSticker): QQSticker {
  if (!known || known.reference.kind !== current.reference.kind) return current
  const animated = known.format === 'animated' || current.format === 'animated'
  if (known.reference.kind === 'sysface' && current.reference.kind === 'sysface') {
    const reference: QQStickerReference = {
      ...known.reference,
      ...current.reference,
      name: current.reference.name || known.reference.name,
      packId: current.reference.packId || known.reference.packId,
      stickerId: current.reference.stickerId || known.reference.stickerId,
      sourceType: current.reference.sourceType ?? known.reference.sourceType,
      stickerType: current.reference.stickerType ?? known.reference.stickerType,
      resultId: current.reference.resultId || known.reference.resultId,
      imageType: current.reference.imageType ?? known.reference.imageType,
      width: current.reference.width ?? known.reference.width,
      height: current.reference.height ?? known.reference.height,
      url: current.reference.url || known.reference.url,
      animated: true,
    }
    return {
      ...known,
      ...current,
      title: current.title || known.title,
      format: 'animated',
      mimeType: current.mimeType || known.mimeType,
      width: current.width ?? known.width,
      height: current.height ?? known.height,
      reference,
    }
  }
  if (known.reference.kind === 'market' && current.reference.kind === 'market') {
    const reference: QQStickerReference = {
      ...known.reference,
      ...current.reference,
      name: current.reference.name || known.reference.name,
      key: current.reference.key || known.reference.key,
      animated,
      staticPath: current.reference.staticPath || known.reference.staticPath,
      dynamicPath: current.reference.dynamicPath || known.reference.dynamicPath,
      favoriteResId: current.reference.favoriteResId || known.reference.favoriteResId,
    }
    return {
      ...known,
      ...current,
      title: current.title || known.title,
      format: animated ? 'animated' : 'static',
      mimeType: animated ? 'image/gif' : current.mimeType,
      reference,
    }
  }
  if (known.reference.kind === 'favorite' && current.reference.kind === 'favorite') {
    const reference: QQStickerReference = {
      ...known.reference,
      ...current.reference,
      path: current.reference.path || known.reference.path,
      name: current.reference.name || known.reference.name,
      animated,
      locator: current.reference.locator || known.reference.locator,
    }
    return {
      ...known,
      ...current,
      title: current.title || known.title,
      format: animated ? 'animated' : 'static',
      mimeType: imageMimeType(reference.name, animated),
      reference,
    }
  }
  return current
}

function sysFaceStickerId(faceId: string): string {
  return `sysface:${faceId}`
}

function systemFaceMimeType(url: string, contentType: string | null | undefined): string {
  const normalized = contentType?.split(';', 1)[0]?.trim().toLowerCase()
  if (normalized?.startsWith('image/') || normalized === 'application/json') return normalized
  if (/\.gif(?:$|[?#])/i.test(url)) return 'image/gif'
  if (/\.json(?:$|[?#])/i.test(url)) return 'application/json'
  return 'image/apng'
}

function mapMember(info: MemberInfo): MemberPage['members'][number] {
  return {
    user: {
      id: info.uid,
      numericId: info.uin,
      name: info.nick || info.remark || info.uin,
      alias: info.cardName || undefined,
      avatar: /^\d+$/.test(info.uin) ? qlogoAvatarMedia(info.uid, info.uin) : undefined,
    },
    role: info.role === MEMBER_OWNER ? 'owner' : info.role === MEMBER_ADMIN ? 'administrator' : 'member',
  }
}

function mapMemberRole(role?: number): MemberPage['members'][number]['role'] | undefined {
  if (role === MEMBER_OWNER) return 'owner'
  if (role === MEMBER_ADMIN) return 'administrator'
  if (role === 2) return 'member'
  return undefined
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

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && value! > 0 ? value! : fallback
}

function marketStickerId(packageId: string, stickerId: string): string {
  return `market:${packageId}:${stickerId}`
}

function parseMarketStickerId(value: string): { packageId: string, stickerId: string } | undefined {
  if (!value.startsWith('market:')) return
  const separator = value.indexOf(':', 'market:'.length)
  if (separator < 0) return
  return { packageId: value.slice('market:'.length, separator), stickerId: value.slice(separator + 1) }
}

function favoriteStickerId(resId: string): string {
  return `favorite:${resId}`
}

function matchesElementKind(element: MsgElement, kind: 'image' | 'file' | 'sticker'): boolean {
  if (kind === 'file') return Boolean(element.fileElement)
  if (kind === 'sticker') {
    return Boolean(element.marketFaceElement)
      || Boolean(element.faceElement && (element.faceElement.faceType === 3 || element.faceElement.faceType === 4))
      || Boolean(element.picElement && isStickerPicture(element.picElement))
  }
  return Boolean(element.picElement)
}

function imageMimeType(path: string, animated: boolean): string {
  const extension = extname(path).toLowerCase()
  if (extension === '.gif') return 'image/gif'
  if (animated) return 'image/apng'
  if (extension === '.webp') return 'image/webp'
  if (extension === '.jpg' || extension === '.jpeg') return 'image/jpeg'
  if (extension === '.bmp') return 'image/bmp'
  return 'image/png'
}

function videoMimeType(path: string, format?: number): string {
  const byFormat: Record<number, string> = {
    1: 'video/x-msvideo', 2: 'video/mp4', 3: 'video/x-ms-wmv', 4: 'video/x-matroska',
    5: 'application/vnd.rn-realmedia-vbr', 6: 'application/vnd.rn-realmedia',
    7: 'video/x-ms-asf', 8: 'video/quicktime', 9: 'video/mod', 10: 'video/mp2t', 11: 'video/mp2t',
  }
  if (format && byFormat[format]) return byFormat[format]
  const extension = extname(path).toLowerCase()
  if (extension === '.avi') return 'video/x-msvideo'
  if (extension === '.wmv') return 'video/x-ms-wmv'
  if (extension === '.mkv') return 'video/x-matroska'
  if (extension === '.mov') return 'video/quicktime'
  if (extension === '.ts' || extension === '.mts') return 'video/mp2t'
  if (extension === '.webm') return 'video/webm'
  return 'video/mp4'
}

function isAnimatedPicture(picture: NonNullable<MsgElement['picElement']>): boolean {
  return [2000, 2001].includes(picture.picType ?? 0) || /\.(?:gif|apng)$/i.test(picture.fileName)
}

function isStickerPicture(picture: NonNullable<MsgElement['picElement']>): boolean {
  // QQ renders only normal pictures (0) and QZone pictures (5) as regular
  // photos. Every other current/future subtype is an expression. Animated
  // pictures are rendered as animated expressions even when their subtype is 0.
  const subtype = picture.picSubType ?? 0
  return isAnimatedPicture(picture) || (subtype !== 0 && subtype !== 5)
}

function fileStream(path: string, encrypted: boolean): Readable {
  if (!encrypted) return createReadStream(path)
  return Readable.from((async function* () {
    let position = 0
    for await (const source of createReadStream(path)) {
      const chunk = Buffer.from(source)
      for (let index = 0; index < chunk.length; index++, position++) {
        if (position % 50 < 20) chunk[index] = ~chunk[index]!
      }
      yield chunk
    }
  })())
}

function safeExtension(name: string): string {
  const extension = extname(basename(name)).replace(/[^.a-zA-Z0-9]/g, '')
  return extension.slice(0, 16)
}

function encodeMemberCursor(value: { uid: string, index: number } | undefined, scene: string): string | undefined {
  return value ? Buffer.from(JSON.stringify({ ...value, scene })).toString('base64url') : undefined
}

function decodeMemberCursor(value?: string): { uid: string, index: number, scene?: string } {
  if (!value) return { uid: '', index: 0 }
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString()) as {
      uid?: unknown
      index?: unknown
      scene?: unknown
    }
    return {
      uid: typeof parsed.uid === 'string' ? parsed.uid : '',
      index: typeof parsed.index === 'number' ? parsed.index : 0,
      scene: typeof parsed.scene === 'string' ? parsed.scene : undefined,
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
  name: string,
  Constructor: (new (handlers: Record<string, (...args: never[]) => unknown>) => unknown) | undefined,
  handlers: Record<string, (...args: never[]) => unknown>,
): unknown {
  // QQNT 6.9.96 exports listener wrapper constructors. QQNT 6.9.98 accepts a
  // plain callback object directly and no longer exports those constructors.
  const protectedHandlers = Object.fromEntries(Object.entries(handlers).map(([event, handler]) => [event, (...args: unknown[]) => {
    log('info', `native callback listener=${name} event=${event} ${summarizeCallbackArgs(args)}`)
    try {
      const result = (handler as (...values: unknown[]) => unknown)(...args)
      if (result && typeof (result as PromiseLike<unknown>).then === 'function') {
        void Promise.resolve(result).catch((error) => log('error', `native callback rejected listener=${name} event=${event}`, error))
      }
      return result
    } catch (error) {
      log('error', `native callback failed listener=${name} event=${event}`, error)
      return undefined
    }
  }])) as Record<string, (...args: never[]) => unknown>
  return Constructor ? new Constructor(protectedHandlers) : protectedHandlers
}

function normalizeMessageRecords(value: MsgRecord[] | { msgList?: MsgRecord[] } | null | undefined): MsgRecord[] {
  if (Array.isArray(value)) return value
  return value?.msgList ?? []
}

function normalizeSingleMessageRecord(value: MsgRecord | { msgRecord?: MsgRecord } | null | undefined): MsgRecord[] {
  if (!value) return []
  if ('msgId' in value) return [value]
  return value.msgRecord ? [value.msgRecord] : []
}

function recordTextContent(record: MsgRecord): string {
  return (record.elements ?? []).map((element) =>
    element.textElement?.content
    ?? element.faceElement?.faceText
    ?? '').join('')
}

function isRecalledRecord(record: MsgRecord): boolean {
  return record.elements?.some((element) => element.grayTipElement?.revokeElement) ?? false
}

function multiForwardTitle(element: NonNullable<MsgElement['multiForwardMsgElement']>): string {
  const xmlTitle = element.xmlContent?.match(/<title\b[^>]*>(?:<!\[CDATA\[([\s\S]*?)\]\]>|([\s\S]*?))<\/title>/i)
  const title = decodeXmlText(xmlTitle?.[1] ?? xmlTitle?.[2] ?? '').trim()
  if (title) return title
  const fileName = element.fileName?.trim()
  if (fileName && !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(fileName)) return fileName
  return '聊天记录'
}

function multiForwardPreview(
  element: NonNullable<MsgElement['multiForwardMsgElement']>,
): string | undefined {
  const match = element.xmlContent
    ?.match(/<summary\b[^>]*>(?:<!\[CDATA\[([\s\S]*?)\]\]>|([\s\S]*?))<\/summary>/i)
  return normalizeMultiForwardPreview(match?.[1] ?? match?.[2] ?? '') || undefined
}

function normalizeMultiForwardPreview(value: string): string {
  return decodeXmlText(value.replace(/<br\s*\/?\s*>/gi, '\n').replace(/<[^>]+>/g, ' '))
    .split(/\r?\n/)
    .map((line) => line.replace(/[\t ]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
}

function decodeXmlText(text: string): string {
  return text.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[\da-f]+);/gi, (entity, code: string) => {
    if (code[0] === '#') {
      const value = code[1]?.toLowerCase() === 'x'
        ? Number.parseInt(code.slice(2), 16)
        : Number.parseInt(code.slice(1), 10)
      return Number.isFinite(value) ? String.fromCodePoint(value) : entity
    }
    return ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" })[code.toLowerCase()] ?? entity
  })
}

function fallbackElementText(element: MsgElement, selfUid?: string): string {
  if (element.pttElement) {
    const transcript = element.pttElement.text?.trim()
    return transcript ? `[语音] ${transcript}` : element.pttElement.duration > 0
      ? `[语音 ${element.pttElement.duration}秒]`
      : '[语音]'
  }
  if (element.videoElement) return element.videoElement.fileName
    ? `[视频] ${element.videoElement.fileName}`
    : '[视频]'
  if (element.markdownElement?.content) return element.markdownElement.content
  if (element.arkElement?.bytesData) {
    const summary = structuredContentSummary(element.arkElement.bytesData)
    return summary || '[卡片消息]'
  }
  const xml = element.structLongMsgElement?.xmlContent || element.structMsgElement?.xmlContent
  if (xml) return xmlText(xml) || '[结构化消息]'
  if (element.giphyElement) return '[GIF]'
  if (element.walletElement) return element.walletElement.name || '[红包/转账]'
  if (element.liveGiftElement) {
    const count = element.liveGiftElement.kUInt64GiftNum
    return `[礼物] ${element.liveGiftElement.kStrGiftName}${count ? ` ×${count}` : ''}`
  }
  if (element.textGiftElement) return `[礼物] ${element.textGiftElement.giftName}`
  if (element.calendarElement) {
    return [element.calendarElement.summary, element.calendarElement.msg].filter(Boolean).join(' ')
      || '[日程]'
  }
  if (element.avRecordElement) {
    return element.avRecordElement.text || (element.avRecordElement.time
      ? `[通话 ${element.avRecordElement.time}]` : '[通话]')
  }
  if (element.faceBubbleElement) {
    return element.faceBubbleElement.content || element.faceBubbleElement.faceSummary
      || element.faceBubbleElement.oldVersionStr || '[互动表情]'
  }
  if (element.shareLocationElement) return element.shareLocationElement.text || '[位置]'
  if (element.tofuRecordElement) {
    const text = [element.tofuRecordElement.descriptionContent, ...(element.tofuRecordElement.contentlist ?? [])]
      .map((item) => item?.title).filter(Boolean).join(' ')
    return text || '[应用消息]'
  }
  if (element.inlineKeyboardElement) {
    const labels = element.inlineKeyboardElement.rows.flatMap((row) => row.buttons.map((button) => button.label))
    return labels.length ? `[按钮] ${labels.join(' / ')}` : '[交互按钮]'
  }
  return `[暂不支持的消息 ${element.elementType}]`
}

function grayTipAction(
  gray: NonNullable<MsgElement['grayTipElement']>,
  selfUid?: string,
  resolveUser: (uid: string) => string | undefined = () => undefined,
): { text: string, actorId?: string } {
  const json = jsonGrayTipText(gray.jsonGrayTipElement, selfUid, resolveUser)
  return {
    text: groupGrayTipText(gray.groupElement, selfUid)
    || (gray.buddyElement?.type === 1 ? '你们已成功添加为好友，现在可以开始聊天了。' : '')
    || json.text
    || xmlGrayTipText(gray.xmlElement)
    || gray.feedMsgElement?.content
    || (gray.proclamationElement
      ? gray.proclamationElement.isSetProclamation ? '群公告已更新' : '群公告已取消' : '')
    || (gray.essenceElement
      ? gray.essenceElement.isSetEssence ? '消息已设为精华' : '消息已移出精华' : '')
    || (gray.fileReceiptElement?.fileName ? `[文件回执] ${gray.fileReceiptElement.fileName}` : '')
    || genericGrayTipText(gray)
    || '[系统消息]',
    actorId: json.actorId,
  }
}

function jsonGrayTipText(
  gray: { recentAbstract: string, jsonStr: string } | undefined,
  selfUid?: string,
  resolveUser: (uid: string) => string | undefined = () => undefined,
): { text: string, actorId?: string } {
  if (!gray) return { text: '' }
  try {
    const parsed = JSON.parse(gray.jsonStr) as {
      items?: Array<{ type?: unknown, uid?: unknown, txt?: unknown, nm?: unknown }>
    }
    const actorId = parsed.items?.find((item) => item.type === 'qq' && typeof item.uid === 'string')?.uid as string | undefined
    const text = parsed.items?.map((item) => {
      if (item.type === 'qq' && typeof item.uid === 'string') {
        return item.uid === selfUid ? '你' : resolveUser(item.uid) || (typeof item.nm === 'string' ? item.nm : '') || item.uid
      }
      return typeof item.txt === 'string' ? item.txt : typeof item.nm === 'string' ? item.nm : ''
    })
      .join('').trim()
    return { text: text || gray.recentAbstract || structuredContentSummary(gray.jsonStr), actorId }
  } catch {
    return { text: gray.recentAbstract || structuredContentSummary(gray.jsonStr) }
  }
}

function genericGrayTipText(gray: NonNullable<MsgElement['grayTipElement']>): string {
  return findStructuredString(gray, new Set([
    'wording', 'content', 'text', 'summary', 'recentabstract', 'tips', 'warningtips', 'message',
    'richcontent', 'senderrichcontent', 'receiverrichcontent', 'postscript', 'friendnick', 'txt', 'nm',
  ]))
}

function xmlGrayTipText(xml?: { content: string, members?: Map<string, string> }): string {
  if (!xml?.content) return ''
  const parts: string[] = []
  for (const match of xml.content.matchAll(/<(qq|nor)\b([^>]*)\/?\s*>/gi)) {
    const attributes = match[2] ?? ''
    if (match[1]?.toLowerCase() === 'qq') {
      const uid = xmlAttribute(attributes, 'uin')
      const display = xml.members?.get(uid) || xmlAttribute(attributes, 'name')
        || xmlAttribute(attributes, 'nick') || xmlAttribute(attributes, 'jp')
      if (display) parts.push(display)
    } else {
      const text = xmlAttribute(attributes, 'txt')
      if (text) parts.push(text)
    }
  }
  return parts.join('').trim() || xmlText(xml.content)
}

function xmlAttribute(attributes: string, name: string): string {
  const match = new RegExp(`\\b${name}=(?:"([^"]*)"|'([^']*)')`, 'i').exec(attributes)
  return decodeXmlText(match?.[1] ?? match?.[2] ?? '')
}

function groupGrayTipText(
  group: NonNullable<MsgElement['grayTipElement']>['groupElement'],
  selfUid?: string,
): string {
  if (!group) return ''
  const name = (member?: { uid: string, name: string }) =>
    member?.uid === selfUid ? '你' : member?.name || member?.uid || ''
  const roleName = (uid: string, remark: string, nick: string) =>
    uid === selfUid ? '你' : remark || nick || uid
  if (group.type === 1) {
    const add = group.memberAdd
    if (!add) return '有新成员加入了群聊'
    if (add.showType === 1) return '你已经是群成员了。'
    if (add.showType === 2 && add.otherAddByOtherQRCode) {
      return `${name(add.otherAddByOtherQRCode.invited)}通过扫描${name(add.otherAddByOtherQRCode.inviter)}分享的二维码加入了群聊。`
    }
    if (add.showType === 3) return `${name(add.otherAddByYourQRCode)}通过扫描你分享的二维码加入了群聊。`
    if (add.showType === 4) return `你通过扫描${name(add.youAddByOtherQRCode)}分享的二维码加入了群聊。`
    if (add.showType === 5 && add.otherInviteOther) {
      return `${name(add.otherInviteOther.inviter)}邀请${name(add.otherInviteOther.invited)}加入了群聊。`
    }
    if (add.showType === 6) return `${name(add.otherInviteYou)}邀请你加入了群聊。`
    if (add.showType === 7) return `你邀请${name(add.youInviteOther)}加入了群聊。`
    return `${name(add.otherAdd) || '有新成员'}加入了群聊。`
  }
  if (group.type === 2) return '该群已被群主解散'
  if (group.type === 3) return '你已被移出群聊'
  if (group.type === 4) {
    const members = group.createGroup?.memberInfo.map(name).filter(Boolean).join('、')
    return members ? `你邀请了${members}加入群聊。` : '群聊已创建'
  }
  if (group.type === 5) {
    const operator = roleName(group.memberUid, group.memberRemark, group.memberNick)
    return `${operator || '管理员'}修改了群名称为“${group.groupName}”`
  }
  if (group.type === 6) return '你已屏蔽该群聊消息'
  if (group.type === 7) return '你已取消屏蔽该群聊消息'
  if (group.type === 8 && group.shutUp) return groupShutUpText(group.shutUp, selfUid)
  if (group.type === 9) return '由于该群长时间未活跃，已被系统自动回收'
  if (group.type === 10) return '该群已被群主解散或被删除'
  return ''
}

function groupShutUpText(
  shutUp: NonNullable<NonNullable<NonNullable<MsgElement['grayTipElement']>['groupElement']>['shutUp']>,
  selfUid?: string,
): string {
  const display = (member: { uid: string, card: string, name: string }) =>
    member.uid === selfUid ? '你' : member.card || member.name || member.uid
  if (!shutUp.member.uid) return `${display(shutUp.admin)}${shutUp.duration === '0' ? '关闭' : '开启'}了全员禁言`
  if (shutUp.duration === '0') return `${display(shutUp.member)}被${display(shutUp.admin)}解除禁言`
  return `${display(shutUp.member)}被${display(shutUp.admin)}禁言${formatDuration(Number(shutUp.duration))}`
}

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return ''
  const parts: string[] = []
  const days = Math.floor(seconds / 86_400)
  const hours = Math.floor(seconds % 86_400 / 3_600)
  const minutes = Math.floor(seconds % 3_600 / 60)
  const remaining = seconds % 60
  if (days) parts.push(`${days}天`)
  if (hours) parts.push(`${hours}小时`)
  if (minutes) parts.push(`${minutes}分钟`)
  if (remaining) parts.push(`${remaining}秒`)
  return parts.join('')
}

function structuredContentSummary(value: string | undefined): string {
  if (!value) return ''
  try {
    const parsed = JSON.parse(value) as unknown
    const card = arkCard(parsed)
    if (card) return cardFallbackText(card)
    const preferred = findStructuredString(parsed, new Set([
      'prompt', 'desc', 'description', 'summary', 'title', 'text', 'content', 'brief',
    ]))
    return preferred || ''
  } catch {
    return xmlText(value)
  }
}

function structuredCard(element: MsgElement): QQCard | undefined {
  if (element.arkElement?.bytesData) {
    try {
      const card = arkCard(JSON.parse(element.arkElement.bytesData) as unknown)
      if (card) return card
    } catch {
      // Malformed Ark payloads keep using the conservative text fallback.
    }
  }
  const xml = element.structLongMsgElement?.xmlContent || element.structMsgElement?.xmlContent
  return xml ? xmlCard(xml) : undefined
}

function arkCard(value: unknown): QQCard | undefined {
  const root = recordValue(value)
  if (!root) return
  const app = stringValue(root.app)
  const meta = recordValue(root.meta)
  if (!meta) return
  const candidates = Object.entries(meta).flatMap(([key, item]) => {
    const record = recordValue(item)
    return record ? [{ key: key.toLowerCase(), record }] : []
  })
  if (!candidates.length) return

  const miniApp = app === 'com.tencent.miniapp.lua' || app.startsWith('com.tencent.miniapp_')
  const selected = candidates.find(({ key }) => key === 'miniapp')
    ?? candidates.find(({ key }) => key === 'detail_1')
    ?? candidates.find(({ key }) => key === 'news')
    ?? candidates[0]!
  const { key, record } = selected
  const legacyMiniApp = miniApp && key === 'detail_1'
  const source = firstString(record, ['source', 'tag', 'site_name', 'appName'])
    || (legacyMiniApp ? stringValue(record.title) : '')
  const title = (legacyMiniApp ? stringValue(record.desc) : stringValue(record.title))
    || firstString(record, ['name', 'summary', 'desc'])
    || stripCardPrompt(stringValue(root.prompt))
    || source
  if (!title) return
  const description = legacyMiniApp ? '' : firstString(record, ['desc', 'description', 'summary', 'brief'])
  const url = firstWebUrl(record, [
    'qqdocurl', 'pcJumpUrl', 'jumpUrl', 'url', 'webUrl', 'shareUrl',
  ]) || firstWebUrl(root, ['jumpUrl', 'url'])
  const thumbnailUrl = firstWebUrl(record, [
    'preview', 'previewUrl', 'imageUrl', 'image', 'cover', 'coverUrl', 'icon', 'iconUrl', 'avatar',
  ])
  const kind: QQCard['kind'] = miniApp ? 'mini-app'
    : key.includes('music') ? 'music'
      : key.includes('contact') ? 'contact'
        : key.includes('location') ? 'location'
          : url ? 'link' : 'application'
  return compactCard({ kind, title, description, source, url, thumbnailUrl })
}

function xmlCard(xml: string): QQCard | undefined {
  const title = xmlTagText(xml, ['title'])
  const description = xmlTagText(xml, ['summary', 'desc'])
  const sourceTag = /<source\b([^>]*)>/i.exec(xml)
  const source = sourceTag ? xmlAttribute(sourceTag[1] ?? '', 'name') : ''
  const msg = /<msg\b([^>]*)>/i.exec(xml)
  const msgAttributes = msg?.[1] ?? ''
  const brief = xmlAttribute(msgAttributes, 'brief').replace(/^\[[^\]]+\]\s*/, '')
  const url = firstHttpUrl([
    xmlAttribute(msgAttributes, 'url'), xmlAttribute(msgAttributes, 'actionData'),
    xmlAttribute(msgAttributes, 'actiondata'),
  ])
  const picture = /<(?:picture|img)\b([^>]*)>/i.exec(xml)
  const thumbnailUrl = picture
    ? firstHttpUrl(['cover', 'src', 'url'].map((name) => xmlAttribute(picture[1] ?? '', name)))
    : undefined
  const resolvedTitle = title || brief || source
  if (!resolvedTitle) return
  return compactCard({
    kind: url ? 'link' : 'application', title: resolvedTitle,
    description, source, url, thumbnailUrl,
  })
}

function compactCard(card: QQCard): QQCard {
  return {
    kind: card.kind,
    title: card.title,
    ...(card.description && card.description !== card.title ? { description: card.description } : {}),
    ...(card.source && card.source !== card.title ? { source: card.source } : {}),
    ...(card.url ? { url: card.url } : {}),
    ...(card.thumbnailUrl ? { thumbnailUrl: card.thumbnailUrl } : {}),
  }
}

function cardFallbackText(card: QQCard): string {
  const label = card.kind === 'mini-app' ? '[小程序]' : '[卡片]'
  return [card.source ? `${label} ${card.source}` : label, card.title, card.description, card.url]
    .filter((item, index, values) => item && values.indexOf(item) === index)
    .join('\n')
}

function stripCardPrompt(value: string): string {
  return value.replace(/^\[[^\]]+\]\s*/, '').trim()
}

function firstString(record: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const found = Object.entries(record).find(([candidate]) => candidate.toLowerCase() === key.toLowerCase())
    const value = stringValue(found?.[1])
    if (value) return value
  }
  return ''
}

function firstWebUrl(record: Record<string, unknown>, keys: string[]): string | undefined {
  return firstHttpUrl(keys.map((key) => firstString(record, [key])))
}

function firstHttpUrl(values: string[]): string | undefined {
  return values.find((value) => /^https?:\/\/\S+$/i.test(value))
}

function xmlTagText(xml: string, tags: string[]): string {
  for (const tag of tags) {
    const match = new RegExp(`<${tag}\\b[^>]*>(?:<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>|([\\s\\S]*?))<\\/${tag}>`, 'i').exec(xml)
    const value = decodeXmlText((match?.[1] ?? match?.[2] ?? '').replace(/<[^>]+>/g, ' '))
      .replace(/\s+/g, ' ').trim()
    if (value) return value
  }
  return ''
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function findStructuredString(value: unknown, preferredKeys: Set<string>, depth = 0): string {
  if (depth > 5 || value === null || value === undefined) return ''
  if (typeof value === 'string') return value.trim()
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findStructuredString(item, preferredKeys, depth + 1)
      if (found) return found
    }
    return ''
  }
  if (typeof value !== 'object') return ''
  const entries = Object.entries(value as Record<string, unknown>)
  for (const [key, item] of entries) {
    if (!preferredKeys.has(key.toLowerCase())) continue
    const found = findStructuredString(item, preferredKeys, depth + 1)
    if (found) return found
  }
  for (const [, item] of entries) {
    const found = findStructuredString(item, preferredKeys, depth + 1)
    if (found) return found
  }
  return ''
}

function xmlText(value: string | undefined): string {
  if (!value) return ''
  const attribute = /\b(?:summary|brief|title|desc)=(?:"([^"]+)"|'([^']+)')/i.exec(value)
  const text = attribute?.[1] || attribute?.[2]
    || value.replace(/<[^>]+>/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
  return text.replace(/\s+/g, ' ').trim()
}

function summarizeCallbackArgs(args: unknown[]): string {
  const summary = args.map((value) => {
    if (Array.isArray(value)) return `array(${value.length})`
    if (value instanceof Map) return `map(${value.size})`
    if (value && typeof value === 'object') return `object(${Object.keys(value).slice(0, 8).join(',')})`
    return `${typeof value}(${String(value).slice(0, 80)})`
  })
  return `argc=${args.length} args=[${summary.join(';')}]`
}

function receivedMessageSummary(conversation: QQConversation, message: QQMessage): string {
  const sender = message.sender?.alias || message.sender?.name || message.sender?.numericId || message.senderId
  const senderId = message.sender?.numericId || message.senderId
  const content = message.parts.length
    ? message.parts.map((part) => part.type === 'text'
      ? JSON.stringify(truncateLogText(part.text))
      : part.type === 'sticker'
        ? `[sticker id=${JSON.stringify(part.sticker.stickerId)}]`
        : part.type === 'card'
          ? `[card kind=${part.card.kind} title=${JSON.stringify(truncateLogText(part.card.title))}]`
          : part.type === 'multi-forward'
            ? `[multi-forward title=${JSON.stringify(truncateLogText(part.title))}]`
            : `[${part.media.kind === 'image' ? 'image' : 'file'} name=${JSON.stringify(part.media.name || '')} size=${part.media.size ?? '?'}]`)
      .join(' ')
    : '[empty]'
  return `received message conversation=${JSON.stringify(conversation.title)}(${conversation.id}) sender=${JSON.stringify(sender)}(${senderId}) seq=${message.msgSeq ?? ''} id=${message.id} content=${content}`
}

function truncateLogText(value: string, limit = 500): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}…`
}

function summarizeNativeResult(value: unknown): string {
  if (!value || typeof value !== 'object') return `${typeof value}:${String(value)}`
  const object = value as { result?: unknown, errMsg?: unknown, data?: unknown }
  const data = Array.isArray(object.data) ? `array(${object.data.length})` : typeof object.data
  return `result=${String(object.result ?? '<none>')} err=${JSON.stringify(String(object.errMsg ?? ''))} data=${data}`
}

function safeRemoveListener(service: string, id: string, remove: () => void): void {
  try {
    remove()
    log('info', `native listener removed service=${service} id=${id}`)
  } catch (error) {
    log('error', `native listener removal failed service=${service} id=${id}`, error)
  }
}

function eventSummary(event: QQEvent): string {
  if (event.type === 'message') {
    return `type=message conversation=${event.conversation.id} title=${JSON.stringify(event.conversation.title)} avatar=${event.conversation.avatar?.id ?? '<none>'} message=${event.message.id} outgoing=${event.message.outgoing}`
  }
  if (event.type === 'message-delete') {
    return `type=message-delete conversation=${event.conversation.id} title=${JSON.stringify(event.conversation.title)} avatar=${event.conversation.avatar?.id ?? '<none>'} messages=${event.messageIds.join(',')}`
  }
  return `type=message-reactions conversation=${event.conversation.id} title=${JSON.stringify(event.conversation.title)} avatar=${event.conversation.avatar?.id ?? '<none>'} message=${event.target.messageId} reactions=${event.context.reactions.length}`
}

function hasAvatarFile(avatar: QQMedia): boolean {
  return Boolean(avatar.locator.filePath && existsSync(avatar.locator.filePath))
}

function isFallbackTitle(title: string | undefined, peerKey: string): boolean {
  return !title?.trim() || title.trim() === peerKey
}

function isFallbackUserName(user: { id: string, numericId?: string, name: string }): boolean {
  return !user.name || user.name === user.id || user.name === user.numericId
}

function firstUsefulTitle(peerKey: string, ...candidates: Array<string | undefined>): string {
  for (const candidate of candidates) {
    const title = candidate?.trim()
    if (title && title !== peerKey) return title
  }
  return candidates.find((candidate) => candidate?.trim())?.trim() || peerKey
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

async function retryHistoryCall<T>(operation: () => Promise<T>): Promise<T> {
  let lastError: unknown
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await operation()
    } catch (error) {
      lastError = error
      if (!isTransientNativeError(error) || attempt === 2) throw error
      await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)))
    }
  }
  throw lastError
}

function isTransientNativeError(error: unknown): boolean {
  const message = String(error)
  return message.includes('Invalid argument') || message.includes('timed out')
}

function avatarMedia(id: string, filePath?: string): QQMedia {
  const size = filePath ? statSync(filePath).size : undefined
  return {
    id: `avatar:${id}`,
    kind: 'image',
    name: filePath ? basename(filePath) : undefined,
    size,
    locator: {
      messageId: `avatar:${id}`,
      elementId: `avatar:${id}`,
      chatType: id.startsWith('group:') ? 2 : 1,
      peerUid: id.slice(id.indexOf(':') + 1),
      kind: 'image',
      fileName: filePath ? basename(filePath) : `avatar-${id.slice(id.indexOf(':') + 1)}`,
      fileSize: size === undefined ? undefined : String(size),
      filePath,
    },
  }
}

function qlogoAvatarMedia(uid: string, uin: string): QQMedia {
  const id = `user:${uid}`
  return {
    id: `avatar:${id}`,
    kind: 'image',
    name: `${uin}.jpg`,
    mimeType: 'image/jpeg',
    locator: {
      messageId: `avatar:${id}`,
      elementId: `avatar:${id}`,
      chatType: CHAT_C2C,
      peerUid: uid,
      kind: 'image',
      fileName: `${uin}.jpg`,
      avatarUin: uin,
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

function replyTargetId(
  record: MsgRecord,
  reply: NonNullable<MsgElement['replyElement']>,
): string | undefined {
  for (const id of [reply.replayMsgId, reply.replayMsgRootMsgId]) {
    if (id && id !== '0') return id
  }
  // sourceMsgIdInRecords identifies QQNT's nested snapshot, which can have a
  // different msgId from the real top-level source. Keep it only as a legacy
  // fallback when the corresponding nested record was not actually supplied.
  if (reply.sourceMsgIdInRecords && reply.sourceMsgIdInRecords !== '0'
    && !record.records?.some((item) => item.msgId === reply.sourceMsgIdInRecords)) {
    return reply.sourceMsgIdInRecords
  }
  return undefined
}

function telegramMessageId(value?: string): number | undefined {
  if (!value || !/^\d+$/.test(value)) return
  const id = Number(value)
  return Number.isSafeInteger(id) && id > 0 && id <= 0x7fffffff ? id : undefined
}

function reactionGrayTipSequence(record: MsgRecord): string | undefined {
  if (record.chatType !== CHAT_GROUP) return
  const xml = record.elements.find((element) =>
    element.grayTipElement?.xmlElement?.templId === '10382')?.grayTipElement?.xmlElement
  if (!xml) return
  return xmlTagAttribute(xml.content, 'url', 'msgseq') || record.msgSeq
}

function xmlTagAttribute(xml: string, tag: string, attribute: string): string {
  const match = new RegExp(`<${tag}\\b([^>]*)`, 'i').exec(xml)
  return match ? xmlAttribute(match[1] ?? '', attribute) : ''
}

function isGrayTipRecord(record: MsgRecord): boolean {
  return record.elements.some((element) => Boolean(element.grayTipElement))
}

function isMultiForwardRecord(record: MsgRecord): boolean {
  return isArkMultiForwardRecord(record)
    || record.elements.some((element) =>
      element.elementType === ELEMENT_MULTI_FORWARD && Boolean(element.multiForwardMsgElement))
}

function isArkMultiForwardRecord(record: MsgRecord): boolean {
  return record.msgType === 11 && record.subMsgType === 7
    && record.elements.some((element) => Boolean(element.arkElement))
}

function arkMultiForwardTitle(bytesData: string): string {
  try {
    const value = JSON.parse(bytesData) as { prompt?: unknown }
    if (typeof value.prompt === 'string' && value.prompt.trim()) return value.prompt.trim()
  } catch {
    // Keep an addressable card even if a future QQ build changes the payload.
  }
  return '聊天记录'
}

function arkMultiForwardPreview(bytesData: string): string | undefined {
  try {
    const root = recordValue(JSON.parse(bytesData) as unknown)
    const meta = recordValue(root?.meta)
    for (const value of Object.values(meta ?? {})) {
      const detail = recordValue(value)
      const news = detail?.news
      if (!Array.isArray(news)) continue
      const lines = news.map((item) => {
        const record = recordValue(item)
        return record ? firstString(record, ['text', 'summary', 'desc', 'title']) : ''
      }).filter(Boolean)
      if (lines.length) return lines.join('\n')
    }
  } catch {
    // Future QQ payloads can omit or reshape the native preview list.
  }
  return undefined
}

function pngDimensions(bytes: Uint8Array): { width: number, height: number } | undefined {
  if (bytes.length < 24
    || bytes[0] !== 0x89 || bytes[1] !== 0x50 || bytes[2] !== 0x4e || bytes[3] !== 0x47) return
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const width = view.getUint32(16)
  const height = view.getUint32(20)
  return width > 0 && height > 0 ? { width, height } : undefined
}

function encodedImageDimensions(bytes: Uint8Array): { width: number, height: number } | undefined {
  return pngDimensions(bytes) ?? gifDimensions(bytes) ?? jpegDimensions(bytes) ?? webpDimensions(bytes)
}

function gifDimensions(bytes: Uint8Array): { width: number, height: number } | undefined {
  if (bytes.length < 10) return
  const signature = String.fromCharCode(...bytes.subarray(0, 6))
  if (signature !== 'GIF87a' && signature !== 'GIF89a') return
  return positiveDimensions(readU16LE(bytes, 6), readU16LE(bytes, 8))
}

function jpegDimensions(bytes: Uint8Array): { width: number, height: number } | undefined {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return
  let offset = 2
  while (offset + 3 < bytes.length) {
    while (offset < bytes.length && bytes[offset] !== 0xff) offset++
    while (offset < bytes.length && bytes[offset] === 0xff) offset++
    if (offset >= bytes.length) return
    const marker = bytes[offset++]!
    if (marker === 0xd8 || marker === 0xd9 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue
    if (offset + 2 > bytes.length) return
    const length = readU16BE(bytes, offset)
    if (length < 2 || offset + length > bytes.length) return
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return positiveDimensions(readU16BE(bytes, offset + 5), readU16BE(bytes, offset + 3))
    }
    offset += length
  }
}

function webpDimensions(bytes: Uint8Array): { width: number, height: number } | undefined {
  if (bytes.length < 30 || ascii(bytes, 0, 4) !== 'RIFF' || ascii(bytes, 8, 4) !== 'WEBP') return
  const chunk = ascii(bytes, 12, 4)
  if (chunk === 'VP8X') return positiveDimensions(readU24LE(bytes, 24) + 1, readU24LE(bytes, 27) + 1)
  if (chunk === 'VP8 ' && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
    return positiveDimensions(readU16LE(bytes, 26) & 0x3fff, readU16LE(bytes, 28) & 0x3fff)
  }
  if (chunk === 'VP8L' && bytes[20] === 0x2f) {
    const bits = (bytes[21]! | bytes[22]! << 8 | bytes[23]! << 16 | bytes[24]! << 24) >>> 0
    return positiveDimensions((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1)
  }
}

function positiveDimensions(width: number, height: number): { width: number, height: number } | undefined {
  return width > 0 && height > 0 ? { width, height } : undefined
}

function imagePicType(name: string): number {
  const extension = name.split('.').at(-1)?.toLowerCase()
  return ({
    jpg: 0, jpeg: 1000, png: 1001, webp: 1002, sharpp: 1004,
    bmp: 1005, gif: 2000, apng: 2001,
  } as Record<string, number | undefined>)[extension ?? ''] ?? 4
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + length))
}

function readU16BE(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! * 0x100 + bytes[offset + 1]!
}

function readU16LE(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! + bytes[offset + 1]! * 0x100
}

function readU24LE(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! + bytes[offset + 1]! * 0x100 + bytes[offset + 2]! * 0x10000
}
