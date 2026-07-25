import { Readable } from 'node:stream'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import type { ContactMsgBoxInfo, FileTransNotifyInfo, KernelModule, KernelSession, MsgRecord } from './kernel-types.js'
import type { PacketAddon } from './packet-addon.js'
import { QQKernelBridge } from './qq-kernel.js'
import { QQBridgeServer } from './server.js'

const avatarFixturePath = process.platform === 'win32' ? process.execPath : '/dev/null'

function fixture() {
  let msgHandlers: Record<string, (...args: unknown[]) => unknown> = {}
  let buddyHandlers: Record<string, (...args: unknown[]) => unknown> = {}
  let profileHandlers: Record<string, (...args: unknown[]) => unknown> = {}
  let groupHandlers: Record<string, (...args: unknown[]) => unknown> = {}
  let searchHandlers: Record<string, (...args: unknown[]) => unknown> = {}
  const profileInfos = new Map<string, {
    uid: string, uin: string, nick: string, remark: string, avatarUrl: string
    coreInfo?: { nick?: string, avatarUrl?: string }
  }>([['self', { uid: 'self', uin: '10000', nick: 'Self', remark: '', avatarUrl: '' }]])
  let avatarPath = avatarFixturePath
  const sentBodies: Buffer[] = []
  const message: MsgRecord = {
    msgId: 'm1', msgSeq: 'seq1', chatType: 1, sendType: 1, senderUid: 'self', senderUin: '10000',
    peerUid: 'uid-1715311957', peerUin: '1715311957', peerName: 'xuuuuan',
    msgTime: '1800000000', sendStatus: 2, sendRemarkName: '', sendMemberName: '',
    sendNickName: 'Self', elements: [{ elementType: 1, elementId: 'e1', textElement: { content: 'hello' } }],
  }
  const msg = {
    addKernelMsgListener: vi.fn((listener: { handlers?: typeof msgHandlers }) => {
      msgHandlers = listener.handlers ?? listener as unknown as typeof msgHandlers
      return 'msg-listener'
    }),
    removeKernelMsgListener: vi.fn(),
    getMsgUniqueId: vi.fn(() => 'm1'),
    sendMsg: vi.fn(async (_id, _peer, elements) => {
      const files = elements.filter((element: { fileElement?: { filePath: string }, picElement?: { sourcePath?: string } }) =>
        element.fileElement || element.picElement)
      for (const file of files) {
        const { readFile } = await import('node:fs/promises')
        sentBodies.push(await readFile(file.fileElement?.filePath ?? file.picElement.sourcePath))
      }
      queueMicrotask(() => msgHandlers.onAddSendMsg?.(message))
      return { result: 0, errMsg: '' }
    }),
    recallMsg: vi.fn(async () => ({ result: 0, errMsg: '' })),
    deleteMsg: vi.fn(async () => ({ result: 0, errMsg: '' })),
    forwardMsg: vi.fn(async () => ({ result: 0, errMsg: '', detailErr: new Map() })),
    multiForwardMsg: vi.fn(async () => ({ result: 0, errMsg: '' })),
    multiForwardMsgWithComment: vi.fn(async () => ({ result: 0, errMsg: '' })),
    getMultiMsg: vi.fn(async () => ({ result: 0, errMsg: '', msgList: [message] })),
    getMsgs: vi.fn(async () => ({ result: 0, errMsg: '', msgList: [message] })),
    getMsgsIncludeSelf: undefined as import('./kernel-types.js').KernelMsgService['getMsgsIncludeSelf'],
    getLatestDbMsgs: vi.fn(async () => ({ result: 0, errMsg: '', msgList: [message] })),
    getAioFirstViewLatestMsgs: undefined as import('./kernel-types.js').KernelMsgService['getAioFirstViewLatestMsgs'],
    getFirstUnreadMsgSeq: vi.fn(async () => ({ result: 4, errMsg: '', seq: '0' })),
    getABatchOfContactMsgBoxInfo: vi.fn(async () => ({
      result: 0, errMsg: '', contactMsgBoxInfos: [] as ContactMsgBoxInfo[],
    })),
    getRichMediaFilePath: vi.fn(() => ''),
    downloadRichMedia: vi.fn(),
    getMsgsBySeqAndCount: vi.fn(async () => ({ result: 0, errMsg: '', msgList: [message] })),
    getMsgsByMsgId: vi.fn(async () => ({ result: 0, errMsg: '', msgList: [message] })),
    getSourceOfReplyMsg: vi.fn(async () => ({ result: 0, errMsg: '', msgList: [] as MsgRecord[] })),
    getSourceOfReplyMsgByClientSeqAndTime: vi.fn(async () => ({
      result: 0, errMsg: '', msgList: [] as MsgRecord[],
    })),
    setMsgEmojiLikes: vi.fn(async () => ({ result: 0, errMsg: '' })),
    getMsgEmojiLikesList: vi.fn(async () => ({
      result: 0, errMsg: '', emojiLikesList: [], cookie: '', isLastPage: true, isFirstPage: true,
    })),
    fetchFavEmojiList: vi.fn(async () => ({ result: 0, errMsg: '', emojiInfoList: [] })),
    addFavEmoji: vi.fn(async () => ({ result: 0, errMsg: '', isExist: 0 })),
    deleteFavEmoji: vi.fn(async () => ({ result: 0, errMsg: '' })),
    fetchMarketEmoticonList: vi.fn(async () => ({
      result: 0, errMsg: '', marketEmoticonInfo: { roamEmojiTab: {
        timesTamp: 1, segmentFlag: -1, ordinaryTabinfoList: [], magicTabinfoList: [],
        smallTabinfoList: [], epIds: [],
      } },
    })),
    fetchBottomEmojiTableList: undefined as import('./kernel-types.js').KernelMsgService['fetchBottomEmojiTableList'],
    fetchMarketEmoticonShowImage: vi.fn(async () => ({ result: 0, errMsg: '' })),
    fetchMarketEmotionJsonFile: undefined,
    fetchMarketEmoticonAioImage: vi.fn(async () => ({ result: 0, errMsg: '' })),
    getMarketEmoticonPath: vi.fn(() => new Map()),
    getMarketEmoticonEncryptKeys: vi.fn(async () => ({ result: 0, errMsg: '', encryptKeyMap: new Map() })),
    getFavMarketEmoticonInfo: vi.fn(async () => ({
      result: 0, errMsg: '', favMarketEmoticonInfo: { eId: '', width: 240, height: 240, faceName: '' },
    })),
  }
  const recent = {
    getRecentContactList: vi.fn(async () => ({ result: 0, errMsg: '' })),
    getRecentContactInfos: vi.fn(async () => ({
      result: 0, errMsg: '', relation: [{
        chatType: 1, peerUid: 'uid-1715311957', peerUin: '1715311957', peerName: 'xuuuuan',
        remark: '', avatarUrl: '', unreadCnt: '0', msgId: 'm1', msgTime: '1800000000',
        senderUid: 'uid-1715311957', senderUin: '1715311957',
        abstractContent: [{ elementType: 1, content: 'hello preview' }],
      }],
    })),
  }
  const buddy = {
    addKernelBuddyListener: vi.fn((listener: { handlers?: typeof buddyHandlers }) => {
      buddyHandlers = listener.handlers ?? listener as unknown as typeof buddyHandlers
      return 'buddy-listener'
    }), removeKernelBuddyListener: vi.fn(),
    getBuddyList: vi.fn(async () => ({ result: 0, errMsg: '' })),
    getBuddyNick: vi.fn((uids: string[]) => new Map(uids.map((uid) => [uid, `nick-${uid}`]))),
    getBuddyRemark: vi.fn(() => new Map<string, string>()),
  }
  const profile = {
    addKernelProfileListener: vi.fn((listener: { handlers?: typeof profileHandlers }) => {
      profileHandlers = listener.handlers ?? listener as unknown as typeof profileHandlers
      return 'profile-listener'
    }),
    removeKernelProfileListener: vi.fn(),
    getUserSimpleInfo: vi.fn(async (_force: boolean, uids: string[]) => {
      queueMicrotask(() => profileHandlers.onProfileSimpleChanged?.(new Map(uids.map((uid) => [
        uid,
        profileInfos.get(uid) ?? { uid, uin: '', nick: '', remark: '', avatarUrl: '' },
      ]))))
      return { result: 0, errMsg: '' }
    }),
  }
  const group = {
    addKernelGroupListener: vi.fn((listener: { handlers?: typeof groupHandlers }) => {
      groupHandlers = listener.handlers ?? listener as unknown as typeof groupHandlers
      return 'group-listener'
    }), removeKernelGroupListener: vi.fn(),
    getGroupList: vi.fn(async () => ({ result: 0, errMsg: '' })),
    createMemberListScene: vi.fn(() => 'scene'), destroyMemberListScene: vi.fn(),
    getNextMemberList: vi.fn(async () => ({
      errCode: 0, errMsg: '', result: {
        ids: [{ uid: 'member', index: 1 }],
        infos: new Map([['member', {
          uid: 'member', uin: '42', nick: 'Personal Name', remark: '',
          cardName: 'Group Alias', role: 2, avatarPath: '',
        }]]),
        finish: true,
      },
    })),
  }
  const search = {
    addKernelSearchListener: vi.fn((listener: { handlers?: typeof searchHandlers }) => {
      searchHandlers = listener.handlers ?? listener as unknown as typeof searchHandlers
      return 'search-listener'
    }),
    removeKernelSearchListener: vi.fn(),
    searchChatMsgs: vi.fn((
      _keywords: string[], _params: import('./kernel-types.js').SearchChatMsgsParams,
    ) => 71),
    searchMoreChatMsgs: vi.fn((_searchId: number) => {}),
    cancelSearchChatMsgs: vi.fn((_searchId: number, _code: number, _reason: string) => {}),
  }
  const richMedia = {
    getVideoPlayUrl: vi.fn(async () => ({
      result: 0, errMsg: '', urlResult: {
        domainUrl: [{ url: 'https://video.example/clip', isHttps: true, httpsDomain: '' }],
        v4IpUrl: [], v6IpUrl: [], videoCodecFormat: 0,
      },
    })),
  }
  const uix = {
    getUid: vi.fn(async (uins: Set<string>) => ({ uidInfo: new Map([...uins].flatMap((uin) => {
      if (uin === '1715311957') return [[uin, 'uid-1715311957']]
      if (uin === '3998401572') return [[uin, 'actor-uid']]
      return []
    })) })),
    getUin: vi.fn(async () => ({ uinInfo: new Map([['uid-1715311957', '1715311957']]) })),
  }
  class Listener {
    handlers: typeof msgHandlers
    constructor(handlers: typeof msgHandlers) { this.handlers = handlers }
  }
  const kernel = {
    NodeIQQNTWrapperSession: { prototype: { init() {} } },
    NodeIKernelMsgListener: Listener,
    NodeIKernelBuddyListener: Listener,
    NodeIKernelProfileListener: Listener,
    NodeIKernelGroupListener: Listener,
    NodeIKernelSearchListener: Listener,
  } as unknown as KernelModule
  const session = {
    getMsgService: () => msg,
    getRecentContactService: () => recent,
    getBuddyService: () => buddy,
    getProfileService: () => profile,
    getGroupService: () => group,
    getSearchService: () => search,
    getRichMediaService: () => richMedia,
    getAvatarService: () => ({
      getAvatarPath: () => avatarPath, forceDownloadAvatar: async () => ({ result: 0, errMsg: '' }),
      getGroupAvatarPath: () => avatarPath, getConfGroupAvatarPath: () => '',
      forceDownloadGroupAvatar: async () => ({ result: 0, errMsg: '' }),
    }),
    getUixConvertService: () => uix,
  } as unknown as KernelSession
  return {
    kernel, session, msg, recent, profile, group, search, richMedia, uix, message, sentBodies,
    emitMessages(records: MsgRecord[]) {
      msgHandlers.onMsgInfoListUpdate?.(records)
    },
    emitReceived(records: MsgRecord[]) {
      msgHandlers.onRecvMsg?.(records)
    },
    emitSent(record: MsgRecord) {
      msgHandlers.onAddSendMsg?.(record)
    },
    emitRecall(chatType: number, peerUid: string, msgSeq: string) {
      msgHandlers.onMsgRecall?.(chatType, peerUid, msgSeq)
    },
    emitDownload(info: FileTransNotifyInfo) {
      msgHandlers.onRichMediaDownloadComplete?.(info)
    },
    emitBuddyList(categories: Array<{ buddyList: unknown[] }>) {
      buddyHandlers.onBuddyListChange?.(categories)
    },
    emitBuddyInfo(infos: Map<string, unknown>) {
      buddyHandlers.onBuddyInfoChange?.(infos)
    },
    setProfile(info: {
      uid: string, uin: string, nick: string, remark: string, avatarUrl: string
      coreInfo?: { nick?: string, avatarUrl?: string }
    }) {
      profileInfos.set(info.uid, info)
    },
    emitGroupList(groups: Array<{
      groupCode: string
      groupName: string
      remarkName?: string
      memberCount?: number
      memberRole?: number
    }>) {
      groupHandlers.onGroupListUpdate?.(1, groups)
    },
    emitMemberList(info: {
      sceneId: string
      ids: Array<{ uid: string, index: number }>
      infos: Map<string, unknown>
      hasNext: boolean
    }) {
      groupHandlers.onMemberListChange?.(info)
    },
    emitSearch(result: import('./kernel-types.js').SearchMsgKeywordsResult) {
      searchHandlers.onSearchMsgKeywordsResult?.(result)
    },
    setAvatarPath(path: string) {
      avatarPath = path
    },
  }
}

async function readStream(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks)
}

describe('QQKernelBridge', () => {
  const tempPaths: string[] = []
  afterEach(async () => {
    await Promise.all(tempPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })))
  })

  it('maps dialogs/history and confirms sends from the native listener', async () => {
    const f = fixture()
    const bridge = new QQKernelBridge()
    bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: '/tmp' })
    const dialogs = await bridge.getDialogs()
    expect(dialogs.conversations[0]).toMatchObject({
      id: 'uid-1715311957', peerUin: '1715311957', title: 'xuuuuan',
    })
    expect(dialogs.conversations[0].lastMessage).toMatchObject({
      id: 'm1', parts: [{ type: 'text', text: 'hello preview' }],
    })
    const history = await bridge.getHistory(dialogs.conversations[0])
    expect(history.messages[0]).toMatchObject({ id: 'm1', parts: [{ type: 'text', text: 'hello' }] })
    expect(f.msg.getLatestDbMsgs).toHaveBeenCalledWith(expect.objectContaining({
      chatType: 1, peerUid: 'uid-1715311957',
    }), 50)
    f.msg.sendMsg.mockImplementationOnce(async () => {
      queueMicrotask(() => f.emitMessages([{ ...f.message, sendStatus: 2 }]))
      return { result: 0, errMsg: '' }
    })
    const sent = await bridge.send({
      conversationId: dialogs.conversations[0].id, text: 'hello', originRequestId: 'relay-send-1',
    }, Readable.from([]))
    expect(sent).toMatchObject({ id: 'm1', originRequestId: 'relay-send-1' })
    expect(sent.sourceIds).toBeUndefined()
    expect(f.msg.getMsgUniqueId).toHaveBeenCalledWith(expect.stringMatching(/^\d{13}$/))
    expect(f.msg.sendMsg).toHaveBeenCalledOnce()
  })

  it('loads the authoritative self profile before exposing the account and keeps it stable', async () => {
    const f = fixture()
    f.setProfile({
      uid: 'self', uin: '10000', nick: '', remark: '', avatarUrl: '',
      coreInfo: { nick: 'Canonical Self' },
    })
    const bridge = new QQKernelBridge()
    bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: '/tmp' })

    await expect(bridge.getUser('self')).resolves.toMatchObject({
      id: 'self', numericId: '10000', name: 'Canonical Self',
      avatar: { locator: { avatarUin: '10000' } },
    })
    f.emitMessages([{ ...f.message, sendNickName: 'A transient message name' }])
    await expect(bridge.getUser('self')).resolves.toMatchObject({ name: 'Canonical Self' })
  })

  it('uses recent abstracts as top-message previews and bounds a missing UID lookup', async () => {
    const f = fixture()
    f.recent.getRecentContactInfos.mockResolvedValue({
      result: 0,
      errMsg: '',
      relation: [{
        chatType: 2, peerUid: '1058754719', peerUin: '1058754719', peerName: 'Test Group',
        remark: '', avatarUrl: '', unreadCnt: '0', msgId: 'group-preview', msgTime: '1800000000',
        senderUid: 'u_group_member', senderUin: '42',
        abstractContent: [{ elementType: 1, content: 'group preview' }],
      }],
    })
    const bridge = new QQKernelBridge({ userResolveTimeoutMs: 20 })
    bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: '/tmp' })

    const dialogs = await bridge.getDialogs()
    expect(dialogs.conversations).toMatchObject([{ id: '1058754719', title: 'Test Group' }])
    expect(dialogs.conversations[0].lastMessage).toMatchObject({
      id: 'group-preview', senderId: 'u_group_member', timestamp: 1_800_000_000,
      telegramMessageId: undefined,
      parts: [{ type: 'text', text: 'group preview' }],
    })
    expect(f.uix.getUin).not.toHaveBeenCalled()

    f.uix.getUin.mockImplementationOnce(() => new Promise(() => {}))
    await expect(bridge.getUser('u_hung')).resolves.toMatchObject({
      id: 'u_hung', name: 'u_hung', avatar: { id: 'avatar:user:u_hung' },
    })
  })

  it('loads the full recent-contact list and paginates dialogs after an opaque ID', async () => {
    const f = fixture()
    f.recent.getRecentContactInfos.mockResolvedValue({
      result: 0,
      errMsg: '',
      relation: [
        { chatType: 2, peerUid: 'group-a', peerUin: 'group-a', peerName: 'A' },
        { chatType: 2, peerUid: 'group-b', peerUin: 'group-b', peerName: 'B' },
        { chatType: 2, peerUid: 'group-c', peerUin: 'group-c', peerName: 'C' },
      ],
    } as Awaited<ReturnType<typeof f.recent.getRecentContactInfos>>)
    const bridge = new QQKernelBridge()
    bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: '/tmp' })

    const first = await bridge.getDialogs(undefined, 1)
    const second = await bridge.getDialogs(undefined, 1, first.conversations[0].id)

    expect(f.recent.getRecentContactList).toHaveBeenCalled()
    expect(first.conversations.map((item) => item.id)).toEqual(['group-a'])
    expect(first.nextCursor).toBe('1')
    expect(second.conversations.map((item) => item.id)).toEqual(['group-b'])
    expect(second.nextCursor).toBe('2')
  })

  it('searches a conversation with native filters and preserves buffered pagination', async () => {
    const f = fixture()
    const bridge = new QQKernelBridge()
    bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: '/tmp' })
    const conversation = bridge.getConversation('uid-1715311957')
    const records = [
      { ...f.message, msgId: 'search-1', msgTime: '1700000020' },
      { ...f.message, msgId: 'search-2', msgTime: '1700000010' },
    ]
    f.search.searchChatMsgs.mockImplementation((keywords, params) => {
      expect(keywords).toEqual(['needle'])
      expect(params).toMatchObject({
        chatInfo: { chatType: 1, peerUid: 'uid-1715311957' },
        filterSendersUid: ['sender'], filterMsgFromTime: '100', filterMsgToTime: '200', pageLimit: 1,
      })
      queueMicrotask(() => f.emitSearch({
        searchId: 71, hasMore: false,
        resultItems: records.map((msgRecord) => ({
          msgId: msgRecord.msgId, msgSeq: msgRecord.msgSeq ?? '', msgTime: msgRecord.msgTime,
          senderUid: msgRecord.senderUid, senderUin: msgRecord.senderUin, senderNick: msgRecord.sendNickName,
          msgRecord,
        })),
      }))
      return 71
    })

    const first = await bridge.searchMessages(conversation, {
      query: 'needle', limit: 1, fromUserId: 'sender', minTimestamp: 100, maxTimestamp: 200,
    })
    expect(first.messages.map((message) => message.id)).toEqual(['search-1'])
    expect(first.nextCursor).toEqual(expect.any(String))

    const second = await bridge.searchMessages(conversation, {
      query: 'needle', cursor: first.nextCursor, limit: 1,
      fromUserId: 'sender', minTimestamp: 100, maxTimestamp: 200,
    })
    expect(second).toMatchObject({ messages: [{ id: 'search-2' }] })
    expect(second.nextCursor).toBeUndefined()
    expect(f.search.searchMoreChatMsgs).not.toHaveBeenCalled()
    expect(f.search.cancelSearchChatMsgs).toHaveBeenCalledWith(71, 2, 'search completed')
  })

  it('continues native search until a requested media result is found', async () => {
    const f = fixture()
    const bridge = new QQKernelBridge()
    bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: '/tmp' })
    const conversation = bridge.getConversation('uid-1715311957')
    f.search.searchChatMsgs.mockImplementation(() => {
      queueMicrotask(() => f.emitSearch({
        searchId: 71, hasMore: true,
        resultItems: [{
          msgId: 'text-only', msgSeq: '1', msgTime: '10', senderUid: 'self', senderUin: '10000',
          senderNick: 'Self', msgRecord: { ...f.message, msgId: 'text-only' },
        }],
      }))
      return 71
    })
    f.search.searchMoreChatMsgs.mockImplementation(() => {
      queueMicrotask(() => f.emitSearch({
        searchId: 71, hasMore: false,
        resultItems: [{
          msgId: 'image', msgSeq: '2', msgTime: '20', senderUid: 'self', senderUin: '10000',
          senderNick: 'Self', msgRecord: { ...f.message, msgId: 'image', elements: [{
            elementType: 2, elementId: 'picture', picElement: {
              fileName: 'result.png', fileSize: '4', picWidth: 16, picHeight: 16,
              md5HexStr: 'md5', fileUuid: 'uuid', fileSubId: '', picSubType: 0,
            },
          }] },
        }],
      }))
    })

    const page = await bridge.searchMessages(conversation, {
      query: '', limit: 1, mediaKind: 'image',
    })
    expect(page).toMatchObject({ messages: [{ id: 'image', parts: [{ type: 'media' }] }] })
    expect(page.nextCursor).toBeUndefined()
    expect(f.search.searchMoreChatMsgs).toHaveBeenCalledWith(71)
  })

  it('paginates the complete ordered recent-contact snapshot instead of the small infos cache', async () => {
    const f = fixture()
    const full = Array.from({ length: 230 }, (_, index) => ({
      id: `contact-${index}`,
      contactId: `contact-${index}`,
      sortField: String(1_000 - index),
      chatType: 2 as const,
      peerUid: `group-${index}`,
      peerUin: `group-${index}`,
      peerName: `Group ${index}`,
    }))
    f.recent.getRecentContactInfos.mockResolvedValue({
      result: 0, errMsg: '', relation: full.slice(0, 8),
    } as Awaited<ReturnType<typeof f.recent.getRecentContactInfos>>)
    Object.assign(f.recent, { getRecentContactListSync: () => ({
      errCode: 0,
      errMsg: '',
      sortedContactList: full.map((item) => item.contactId),
      changedList: full,
    }) })
    const bridge = new QQKernelBridge()
    bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: '/tmp' })

    const first = await bridge.getDialogs(undefined, 100)
    const second = await bridge.getDialogs(first.nextCursor, 100)
    const third = await bridge.getDialogs(second.nextCursor, 100)

    expect(first.conversations).toHaveLength(100)
    expect(first.total).toBe(230)
    expect(first.conversations[0]?.id).toBe('group-0')
    expect(first.nextCursor).toBe('100')
    expect(second.conversations[0]?.id).toBe('group-100')
    expect(second.nextCursor).toBe('200')
    expect(third.conversations).toHaveLength(30)
    expect(third.nextCursor).toBeUndefined()
  })

  it('prefers the count-aware recent snapshot over the truncated legacy cache', async () => {
    const f = fixture()
    const full = Array.from({ length: 230 }, (_, index) => ({
      id: `contact-${index}`,
      contactId: `contact-${index}`,
      sortField: String(1_000 - index),
      chatType: 2 as const,
      peerUid: `group-${index}`,
      peerUin: `group-${index}`,
      peerName: `Group ${index}`,
      remark: '', avatarUrl: '', unreadCnt: '0',
      msgId: `message-${index}`, msgSeq: String(index + 1), msgTime: String(1_800_000_000 - index),
      senderUid: `member-${index}`, senderUin: '',
      abstractContent: [{ elementType: 1, content: `Preview ${index}` }],
    }))
    const getRecentContactListSyncLimit = vi.fn(() => ({
      errCode: 0,
      errMsg: '',
      sortedContactList: full.map((item) => item.contactId),
      changedList: full,
    }))
    Object.assign(f.recent, {
      getRecentContactListSyncLimit,
      getRecentContactListSync: vi.fn(() => ({
        errCode: 0, errMsg: '',
        sortedContactList: full.map((item) => item.contactId),
        changedList: full.slice(0, 8),
      })),
    })
    const bridge = new QQKernelBridge()
    bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: '/tmp' })

    const page = await bridge.getDialogs(undefined, 100)

    expect(getRecentContactListSyncLimit).toHaveBeenCalledWith(500)
    expect(page.total).toBe(230)
    expect(page.conversations[99]).toMatchObject({
      id: 'group-99',
      lastMessage: { id: 'message-99', parts: [{ type: 'text', text: 'Preview 99' }] },
    })
  })

  it('waits for the asynchronous full recent-contact callback before returning dialogs', async () => {
    const f = fixture()
    let recentHandlers: Record<string, (...args: unknown[]) => unknown> = {}
    class RecentListener {
      handlers: typeof recentHandlers
      constructor(handlers: typeof recentHandlers) { this.handlers = handlers }
    }
    Object.assign(f.kernel, { NodeIKernelRecentContactListener: RecentListener })
    Object.assign(f.recent, {
      addKernelRecentContactListener(listener: { handlers?: typeof recentHandlers }) {
        recentHandlers = listener.handlers ?? listener as unknown as typeof recentHandlers
        return 'recent-listener'
      },
      removeKernelRecentContactListener() {},
    })
    const full = Array.from({ length: 12 }, (_, index) => ({
      chatType: 2 as const,
      peerUid: `group-${index}`,
      peerUin: `group-${index}`,
      peerName: `Group ${index}`,
    }))
    f.recent.getRecentContactInfos.mockResolvedValue({
      result: 0, errMsg: '', relation: full.slice(0, 8),
    } as Awaited<ReturnType<typeof f.recent.getRecentContactInfos>>)
    const recentTimers: NodeJS.Timeout[] = []
    f.recent.getRecentContactList.mockImplementation(async () => {
      recentTimers.push(setTimeout(() => recentHandlers.onRecentContactListChanged?.(full), 10))
      return { result: 0, errMsg: '' }
    })
    const bridge = new QQKernelBridge()
    bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: '/tmp' })

    const dialogs = await bridge.getDialogs()

    expect(dialogs.conversations).toHaveLength(12)
    for (const timer of recentTimers) clearTimeout(timer)
    bridge.detach()
  })

  it('maps and sends native mention and reply elements without parsing opaque IDs', async () => {
    const f = fixture()
    f.message.elements = [{
      elementType: 7, elementId: 'reply', replyElement: {
        replayMsgId: '0', sourceMsgIdInRecords: 'opaque-original',
        sourceMsgTextElems: [], replyMsgRevokeType: 0,
        sourceMsgIsIncPic: false, sourceMsgExpired: false,
      },
    }, {
      elementType: 1, elementId: 'mention', textElement: {
        content: '@Alice', atType: 2, atUid: '12345', atTinyId: '', atNtUid: 'u_opaque_alice',
      },
    }, { elementType: 6, elementId: 'face', faceElement: {
      faceIndex: 14, faceText: '[微笑]', faceType: 1,
    } }, { elementType: 1, elementId: 'text', textElement: { content: ' hello' } }]
    const bridge = new QQKernelBridge()
    bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: '/tmp' })

    const history = await bridge.getHistory(bridge.getConversation('uid-1715311957'))
    expect(history.messages[0]).toMatchObject({
      replyToId: 'opaque-original',
      parts: [{
        type: 'text', text: '@Alice',
        entities: [{ type: 'mention', offset: 0, length: 6, userId: 'u_opaque_alice', numericId: '12345' }],
      }, {
        type: 'text', text: '[微笑]',
        entities: [{ type: 'qq-face', offset: 0, length: 4, faceId: '14', faceType: 1 }],
      }, { type: 'text', text: ' hello' }],
    })

    f.msg.sendMsg.mockImplementationOnce(async () => {
      queueMicrotask(() => f.emitMessages([{ ...f.message, sendStatus: 2, elements: [
        { elementType: 7, elementId: 'reply', replyElement: {
          replayMsgId: 'opaque-original', sourceMsgTextElems: [], replyMsgRevokeType: 0,
          sourceMsgIsIncPic: false, sourceMsgExpired: false,
        } },
        { elementType: 1, elementId: 'prefix', textElement: { content: 'hi ' } },
        { elementType: 1, elementId: 'mention', textElement: {
          content: '@Alice', atType: 2, atUid: '12345', atTinyId: '', atNtUid: 'u_opaque_alice',
        } },
        { elementType: 6, elementId: 'face', faceElement: {
          faceIndex: 14, faceText: '[微笑]', faceType: 1,
        } },
        { elementType: 1, elementId: 'suffix', textElement: { content: '!' } },
      ] }]))
      return { result: 0, errMsg: '' }
    })
    f.msg.getMsgUniqueId.mockReturnValueOnce('0')
    await bridge.send({
      conversationId: 'uid-1715311957', replyToId: 'opaque-original',
      textParts: [{
        type: 'text', text: 'hi @Alice[微笑]!',
        entities: [
          { type: 'mention', offset: 3, length: 6, userId: 'u_opaque_alice', numericId: '12345' },
          { type: 'qq-face', offset: 9, length: 4, faceId: '14', faceType: 1 },
        ],
      }],
    }, Readable.from([]))
    expect(f.msg.sendMsg).toHaveBeenCalledWith('0', expect.anything(), [
      expect.objectContaining({ elementType: 7, replyElement: expect.objectContaining({ replayMsgId: 'opaque-original' }) }),
      expect.objectContaining({ elementType: 1, textElement: expect.objectContaining({ content: 'hi ', atType: 0 }) }),
      expect.objectContaining({
        elementType: 1,
        textElement: expect.objectContaining({ content: '@Alice', atType: 2, atUid: '12345', atNtUid: 'u_opaque_alice' }),
      }),
      expect.objectContaining({
        elementType: 6, faceElement: expect.objectContaining({ faceIndex: 14, faceText: '[微笑]', faceType: 1 }),
      }),
      expect.objectContaining({ elementType: 1, textElement: expect.objectContaining({ content: '!', atType: 0 }) }),
    ], expect.any(Map))
  })

  it('resolves received group and C2C reply targets when QQNT only exposes sequence metadata', async () => {
    const f = fixture()
    const original = { ...f.message, msgId: 'opaque-source', msgSeq: 'source-seq' }
    const reply = { ...f.message, msgId: 'reply', msgSeq: 'reply-seq', elements: [{
      elementType: 7, elementId: 'reply-element', replyElement: {
        replayMsgId: '0', replayMsgSeq: 'source-seq', sourceMsgIdInRecords: '0',
        sourceMsgTextElems: [], replyMsgRevokeType: 0,
        sourceMsgIsIncPic: false, sourceMsgExpired: false,
      },
    }, { elementType: 1, elementId: 'text', textElement: { content: 'group reply' } }],
    } satisfies MsgRecord
    f.msg.getLatestDbMsgs.mockResolvedValueOnce({ result: 0, errMsg: '', msgList: [reply] })
    f.msg.getMsgsBySeqAndCount.mockResolvedValueOnce({ result: 0, errMsg: '', msgList: [original] })
    const bridge = new QQKernelBridge()
    bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: '/tmp' })

    await expect(bridge.getHistory(bridge.getConversation('uid-1715311957'))).resolves.toMatchObject({
      messages: [{ id: 'reply', replyToId: 'opaque-source' }],
    })
    expect(f.msg.getMsgsBySeqAndCount).toHaveBeenCalledWith(
      expect.objectContaining({ peerUid: 'uid-1715311957' }), 'source-seq', 1, true, true,
    )

    const c2cReply = { ...reply, msgId: 'c2c-reply', elements: [{
      elementType: 7, elementId: 'reply-element', replyElement: {
        replayMsgId: '0', sourceMsgIdInRecords: '0', replyMsgClientSeq: 'client-seq', replyMsgTime: '1700000000',
        sourceMsgTextElems: [], replyMsgRevokeType: 0,
        sourceMsgIsIncPic: false, sourceMsgExpired: false,
      },
    }] } satisfies MsgRecord
    f.msg.getSourceOfReplyMsgByClientSeqAndTime.mockResolvedValueOnce({
      result: 0, errMsg: '', msgList: [original],
    })
    f.msg.getMsgsByMsgId.mockResolvedValueOnce({ result: 0, errMsg: '', msgList: [c2cReply] })
    await expect(bridge.getMessage(bridge.getConversation('uid-1715311957'), 'c2c-reply')).resolves.toMatchObject({
      id: 'c2c-reply', replyToId: 'opaque-source',
    })
    expect(f.msg.getSourceOfReplyMsgByClientSeqAndTime).toHaveBeenCalledWith(
      expect.objectContaining({ peerUid: 'uid-1715311957' }), 'c2c-reply', 'client-seq', '1700000000',
    )
  })

  it('maps group message and reply sequences directly to Telegram IDs without loading the target', async () => {
    const f = fixture()
    const original = {
      ...f.message, chatType: 2, peerUid: '1058754719', peerUin: '1058754719',
      msgId: 'real-source', msgSeq: '5850632',
    } satisfies MsgRecord
    const nested = { ...original, msgId: 'nested-copy', records: [] }
    const reply = { ...original, msgId: 'reply', msgSeq: '5850634', records: [nested], elements: [{
      elementType: 7, elementId: 'reply-element', replyElement: {
        replayMsgId: '0', replayMsgSeq: '5850632', sourceMsgIdInRecords: 'nested-copy',
        sourceMsgTextElems: [], replyMsgRevokeType: 0,
        sourceMsgIsIncPic: false, sourceMsgExpired: false,
      },
    }] } satisfies MsgRecord
    f.msg.getLatestDbMsgs.mockResolvedValueOnce({ result: 0, errMsg: '', msgList: [reply, original] })
    const bridge = new QQKernelBridge()
    bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: '/tmp' })

    await expect(bridge.getHistory(bridge.getConversation('1058754719'))).resolves.toMatchObject({
      messages: [
        { id: 'reply', telegramMessageId: 5850634, telegramReplyToMessageId: 5850632 },
        { id: 'real-source', telegramMessageId: 5850632 },
      ],
    })
    expect(f.msg.getMsgsBySeqAndCount).not.toHaveBeenCalled()
    expect(f.msg.getSourceOfReplyMsg).not.toHaveBeenCalled()
  })

  it('resolves an adjacent direct reply from the same batch without loading its target', async () => {
    const f = fixture()
    const original = { ...f.message, msgId: 'direct-source', msgSeq: '101' } satisfies MsgRecord
    const reply = { ...f.message, msgId: 'direct-reply', msgSeq: '102', elements: [{
      elementType: 7, elementId: 'reply-element', replyElement: {
        replayMsgId: '0', replayMsgSeq: '101', sourceMsgIdInRecords: 'nested-copy',
        sourceMsgTextElems: [], replyMsgRevokeType: 0,
        sourceMsgIsIncPic: false, sourceMsgExpired: false,
      },
    }] } satisfies MsgRecord
    f.msg.getLatestDbMsgs.mockResolvedValueOnce({ result: 0, errMsg: '', msgList: [reply, original] })
    const bridge = new QQKernelBridge()
    bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: '/tmp' })

    await expect(bridge.getHistory(bridge.getConversation('uid-1715311957'))).resolves.toMatchObject({
      messages: [{ id: 'direct-reply', replyToId: 'direct-source' }, { id: 'direct-source' }],
    })
    expect(f.msg.getMsgsBySeqAndCount).not.toHaveBeenCalled()
    expect(f.msg.getSourceOfReplyMsgByClientSeqAndTime).not.toHaveBeenCalled()
  })

  it('prefers the real replay message ID over QQNT records snapshot IDs', async () => {
    const f = fixture()
    f.message.elements = [{
      elementType: 7, elementId: 'reply', replyElement: {
        replayMsgId: 'real-source', sourceMsgIdInRecords: 'nested-copy',
        sourceMsgTextElems: [], replyMsgRevokeType: 0,
        sourceMsgIsIncPic: false, sourceMsgExpired: false,
      },
    }]
    f.message.records = [{ ...f.message, msgId: 'nested-copy', msgSeq: 'source-seq', records: [] }]
    const bridge = new QQKernelBridge()
    bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: '/tmp' })

    await expect(bridge.getHistory(bridge.getConversation('uid-1715311957'))).resolves.toMatchObject({
      messages: [{ replyToId: 'real-source' }],
    })
  })

  it('maps poke, member changes, mute notices, and generic gray tips to service actions', async () => {
    const f = fixture()
    const record = (msgId: string, element: MsgRecord['elements'][number]): MsgRecord => ({
      ...f.message, msgId, msgSeq: '123', chatType: 2,
      peerUid: '1058754719', peerUin: '1058754719', peerName: 'Test Group', elements: [element],
    })
    f.msg.getLatestDbMsgs.mockResolvedValueOnce({ result: 0, errMsg: '', msgList: [
      record('poke', { elementType: 6, elementId: 'poke', faceElement: {
        faceIndex: 0, faceType: 5, spokeSummary: 'Alice戳了戳你',
      } }),
      record('json-poke', { elementType: 8, elementId: 'json-poke', grayTipElement: {
        jsonGrayTipElement: {
          busiId: '1061', recentAbstract: '',
          jsonStr: JSON.stringify({ items: [
            { type: 'qq', uid: 'self', nm: '' },
            { type: 'img' },
            { type: 'nor', txt: '戳了戳' },
            { type: 'qq', uid: 'bob', nm: 'Bob' },
            { type: 'nor', txt: '的猫耳' },
          ] }),
        },
      } }),
      record('join', { elementType: 8, elementId: 'join', grayTipElement: {
        groupElement: {
          type: 1, role: 0, groupName: '', memberUid: '', memberNick: '', memberRemark: '',
          adminUid: '', adminNick: '', adminRemark: '', memberAdd: {
            showType: 5,
            otherInviteOther: {
              inviter: { uid: 'alice', name: 'Alice' },
              invited: { uid: 'bob', name: 'Bob' },
            },
          },
        },
      } }),
      record('mute', { elementType: 8, elementId: 'mute', grayTipElement: {
        groupElement: {
          type: 8, role: 0, groupName: '', memberUid: '', memberNick: '', memberRemark: '',
          adminUid: '', adminNick: '', adminRemark: '', shutUp: {
            duration: '3661',
            admin: { uid: 'admin', card: '管理员', name: 'Admin', role: 3 },
            member: { uid: 'self', card: 'Self', name: 'Self', role: 2 },
          },
        },
      } }),
      record('json', { elementType: 8, elementId: 'json', grayTipElement: {
        jsonGrayTipElement: {
          recentAbstract: 'fallback',
          jsonStr: JSON.stringify({ items: [{ txt: '安全提醒：' }, { nm: '请修改密码' }] }),
        },
      } }),
      record('generic', { elementType: 8, elementId: 'generic', grayTipElement: {
        walletGrayTipElement: { receiverRichContent: '你领取了红包' },
      } as unknown as NonNullable<MsgRecord['elements'][number]['grayTipElement']> }),
      record('xml', { elementType: 8, elementId: 'xml', grayTipElement: {
        xmlElement: {
          content: '<gtip><qq uin="alice" jp="123"/><nor txt="邀请"/><qq uin="bob" jp="456"/><nor txt="加入了群聊。"/></gtip>',
          members: new Map([['alice', 'Alice'], ['bob', 'Bob']]),
        },
      } }),
    ] })
    const bridge = new QQKernelBridge()
    bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: '/tmp' })

    const messages = (await bridge.getHistory(bridge.getConversation('1058754719'))).messages
    expect(messages.map((message) => ({ parts: message.parts, serviceAction: message.serviceAction }))).toMatchObject([
      { parts: [], serviceAction: { type: 'custom', text: 'Alice戳了戳你' } },
      { parts: [], serviceAction: { type: 'custom', text: '你戳了戳Bob的猫耳' } },
      { parts: [], serviceAction: { type: 'custom', text: 'Alice邀请Bob加入了群聊。' } },
      { parts: [], serviceAction: { type: 'custom', text: '你被管理员禁言1小时1分钟1秒' } },
      { parts: [], serviceAction: { type: 'custom', text: '安全提醒：请修改密码' } },
      { parts: [], serviceAction: { type: 'custom', text: '你领取了红包' } },
      { parts: [], serviceAction: { type: 'custom', text: 'Alice邀请Bob加入了群聊。' } },
    ])
    expect(messages.every((message) => message.telegramMessageId === undefined)).toBe(true)
  })

  it('deletes recalled messages by msgId for both recall callback shapes', async () => {
    const f = fixture()
    const bridge = new QQKernelBridge()
    bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: '/tmp' })
    await bridge.getHistory(bridge.getConversation('uid-1715311957'))
    const events = bridge.subscribe()[Symbol.asyncIterator]()

    f.emitRecall(1, 'uid-1715311957', 'seq1')
    await expect(events.next()).resolves.toMatchObject({
      value: { type: 'message-delete', messageIds: ['m1'] },
    })

    f.msg.getMsgsBySeqAndCount.mockResolvedValueOnce({
      result: 0, errMsg: '', msgList: [{ ...f.message, msgId: 'm2', msgSeq: 'seq2' }],
    })
    f.emitRecall(1, 'uid-1715311957', 'seq2')
    await expect(events.next()).resolves.toMatchObject({
      value: { type: 'message-delete', messageIds: ['m2'] },
    })
  })

  it('turns recalled gray-tip replacements into message-delete events', async () => {
    const f = fixture()
    const bridge = new QQKernelBridge()
    bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: '/tmp' })
    await bridge.getHistory(bridge.getConversation('uid-1715311957'))
    const events = bridge.subscribe()[Symbol.asyncIterator]()
    f.emitMessages([{ ...f.message, elements: [{
      elementType: 8,
      elementId: 'revoke',
      grayTipElement: {
        revokeElement: {
          operatorUid: 'self', origMsgSenderUid: 'self', isSelfOperate: true, wording: '',
        },
      },
    }] }])
    await expect(events.next()).resolves.toMatchObject({
      value: { type: 'message-delete', messageIds: ['m1'] },
    })
  })

  it('hides recalled records, maps native videos, and renders unsupported elements as text fallbacks', async () => {
    const f = fixture()
    f.msg.getLatestDbMsgs.mockResolvedValueOnce({
      result: 0, errMsg: '', msgList: [
        { ...f.message, msgId: 'recalled', elements: [{
          elementType: 8, elementId: 'revoke', grayTipElement: { revokeElement: {
            operatorUid: 'peer', origMsgSenderUid: 'peer', isSelfOperate: false, wording: '',
          } },
        }] },
        { ...f.message, msgId: 'fallbacks', elements: [
          { elementType: 4, elementId: 'voice', pttElement: { duration: 3, text: '转写内容' } },
          { elementType: 5, elementId: 'video', videoElement: {
            filePath: '/missing/clip.mp4', fileName: 'clip.mp4', fileTime: 4,
            fileFormat: 2, fileSize: '1048576', thumbWidth: 1280, thumbHeight: 720,
            videoMd5: 'video-md5', fileUuid: 'video-uuid', fileSubId: 'video-sub-id', fileBizId: 4601,
            sourceVideoCodecFormat: 1,
          } },
          { elementType: 10, elementId: 'ark', arkElement: {
            bytesData: JSON.stringify({ meta: { news: { title: '卡片标题' } } }),
          } },
          { elementType: 14, elementId: 'markdown', markdownElement: { content: '**Markdown**' } },
          { elementType: 999, elementId: 'unknown' },
        ] },
      ],
    })
    const bridge = new QQKernelBridge()
    bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: '/tmp' })
    const history = await bridge.getHistory(bridge.getConversation('uid-1715311957'))
    expect(history.messages).toHaveLength(1)
    expect(history.messages[0]).toMatchObject({ id: 'fallbacks', parts: [
      { type: 'text', text: '[语音] 转写内容' },
      { type: 'media', media: {
        id: 'video', kind: 'file', name: 'clip.mp4', mimeType: 'video/mp4',
        size: 1048576, width: 1280, height: 720, duration: 4,
        locator: {
          messageId: 'fallbacks', elementId: 'video', chatType: 1, peerUid: 'uid-1715311957',
          kind: 'file', fileName: 'clip.mp4', fileSize: '1048576', filePath: '/missing/clip.mp4',
          fileUuid: 'video-uuid', fileSubId: 'video-sub-id', fileBizId: 4601, md5: 'video-md5',
          videoCodecFormat: 1,
        },
      } },
      { type: 'text', text: '卡片标题' },
      { type: 'text', text: '**Markdown**' },
      { type: 'text', text: '[暂不支持的消息 999]' },
    ] })
  })

  it('includes mini-app source, title, and web links in Ark fallbacks', async () => {
    const f = fixture()
    f.message.elements = [{
      elementType: 10, elementId: 'legacy-mini-app', arkElement: { bytesData: JSON.stringify({
        app: 'com.tencent.miniapp_01', prompt: '[QQ小程序] 腾讯文档',
        meta: { detail_1: {
          title: '腾讯文档', desc: '项目排期',
          url: 'mqqapi://miniapp/open?appid=1108338344',
          qqdocurl: 'https://docs.qq.com/sheet/example',
        } },
      }) },
    }, {
      elementType: 10, elementId: 'rich-mini-app', arkElement: { bytesData: JSON.stringify({
        app: 'com.tencent.miniapp.lua', meta: { miniapp: {
          source: '示例小程序', title: '分享标题', desc: '分享描述',
          jumpUrl: 'https://m.q.qq.com/a/s/example',
          pcJumpUrl: 'https://m.q.qq.com/a/s/example',
        } },
      }) },
    }]
    const bridge = new QQKernelBridge()
    bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: '/tmp' })

    await expect(bridge.getHistory(bridge.getConversation('uid-1715311957'))).resolves.toMatchObject({
      messages: [{ parts: [{
        type: 'text', text: '[小程序] 腾讯文档\n项目排期\nhttps://docs.qq.com/sheet/example',
      }, {
        type: 'text', text: '[小程序] 示例小程序\n分享标题\n分享描述\nhttps://m.q.qq.com/a/s/example',
      }] }],
    })
  })

  it('uses one batch unread lookup and loads only the opened chat around its unread boundary', async () => {
    const f = fixture()
    const previous = { ...f.message, msgId: 'm0', msgSeq: 'seq0', msgTime: '1799999999' }
    f.recent.getRecentContactInfos.mockResolvedValue({
      result: 0,
      errMsg: '',
      relation: [{
        chatType: 1, peerUid: 'uid-1715311957', peerUin: '1715311957', peerName: 'xuuuuan',
        remark: '', avatarUrl: '', unreadCnt: '0', msgId: 'm1', msgTime: '1800000000',
        senderUid: 'uid-1715311957', senderUin: '1715311957',
        abstractContent: [{ elementType: 1, content: 'hello preview' }],
      }],
    })
    f.msg.getABatchOfContactMsgBoxInfo.mockResolvedValueOnce({
      result: 0,
      errMsg: '',
      contactMsgBoxInfos: [{
        contact: { chatType: 1, peerUid: 'uid-1715311957', guildId: '' },
        firstUnreadMsgInfo: { msgSeq: 'seq1', msgTime: '1800000000' },
        unreadCnt: '7',
      }],
    })
    f.msg.getMsgsBySeqAndCount
      .mockResolvedValueOnce({ result: 0, errMsg: '', msgList: [previous, f.message] })
      .mockResolvedValueOnce({ result: 0, errMsg: '', msgList: [f.message] })
    const bridge = new QQKernelBridge()
    bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: '/tmp' })

    const dialogs = await bridge.getDialogs()

    expect(dialogs.conversations[0]).toMatchObject({
      unreadCount: 7,
      firstUnread: { msgSeq: 'seq1', msgTime: '1800000000' },
    })
    expect(dialogs.conversations[0].readInboxMaxMessage).toBeUndefined()
    expect(f.msg.getABatchOfContactMsgBoxInfo).toHaveBeenCalledOnce()
    expect(f.msg.getMsgsBySeqAndCount).not.toHaveBeenCalled()

    await bridge.getHistory(dialogs.conversations[0])

    expect(f.msg.getMsgsBySeqAndCount).toHaveBeenCalledWith(
      expect.objectContaining({ peerUid: 'uid-1715311957' }),
      'seq1',
      26,
      true,
      false,
    )
    expect(f.msg.getMsgsBySeqAndCount).toHaveBeenCalledWith(
      expect.objectContaining({ peerUid: 'uid-1715311957' }),
      'seq1',
      26,
      false,
      false,
    )
    expect((await bridge.getDialogs()).conversations[0]).toMatchObject({
      readInboxMaxMessage: { id: 'm0', msgSeq: 'seq0' },
    })
    expect(f.msg.getABatchOfContactMsgBoxInfo).toHaveBeenCalledOnce()
  })

  it('uses single forward for one source message and merged forward for multiple messages', async () => {
    const f = fixture()
    const bridge = new QQKernelBridge()
    bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: '/tmp' })
    await bridge.getDialogs()
    const conversation = bridge.getConversation('uid-1715311957')
    const forwarded = {
      ...f.message, msgId: 'forwarded-1', msgTime: String(Math.floor(Date.now() / 1000)),
      elements: [{ elementType: 1, elementId: 'forwarded-text', textElement: { content: 'forwarded' } }],
    }
    f.msg.getLatestDbMsgs
      .mockResolvedValueOnce({ result: 0, errMsg: '', msgList: [f.message] })
      .mockResolvedValueOnce({ result: 0, errMsg: '', msgList: [forwarded, f.message] })
    await expect(bridge.forwardMessages(conversation, ['m1'], conversation)).resolves.toMatchObject([
      { id: 'forwarded-1', parts: [{ type: 'text', text: 'forwarded' }] },
    ])
    expect(f.msg.forwardMsg).toHaveBeenCalledWith(['m1'], expect.anything(), [expect.anything()], expect.any(Map))

    const merged = {
      ...forwarded, msgId: 'merged-1', msgType: 11, subMsgType: 7,
      elements: [{
        elementType: 10, elementId: 'merged',
        arkElement: { bytesData: JSON.stringify({
          app: 'com.tencent.multimsg', prompt: 'Alice & Bob 的聊天记录',
        }) },
      }],
    }
    const placeholder = {
      ...merged,
      msgType: 2, subMsgType: 0,
      elements: [{
        elementType: 1, elementId: 'merged-placeholder', textElement: { content: '[聊天记录]' },
      }],
    }
    const accepted = { ...merged, sendStatus: 1 }
    const events = bridge.subscribe()[Symbol.asyncIterator]()
    f.msg.getLatestDbMsgs
      .mockResolvedValueOnce({ result: 0, errMsg: '', msgList: [forwarded, f.message] })
      .mockResolvedValueOnce({ result: 0, errMsg: '', msgList: [placeholder, forwarded, f.message] })
      .mockResolvedValueOnce({ result: 0, errMsg: '', msgList: [accepted, forwarded, f.message] })
      .mockResolvedValueOnce({ result: 0, errMsg: '', msgList: [merged, forwarded, f.message] })
    f.msg.getMsgsByMsgId.mockResolvedValueOnce({
      result: 0, errMsg: '', msgList: [f.message, { ...f.message, msgId: 'm2', sendNickName: 'Alice' }],
    })
    f.msg.multiForwardMsgWithComment.mockImplementationOnce(async () => {
      f.emitSent(placeholder)
      queueMicrotask(() => f.emitMessages([merged]))
      return { result: 0, errMsg: '' }
    })
    await expect(bridge.forwardMessages(conversation, ['m1', 'm2'], conversation, true)).resolves.toMatchObject([
      { id: 'merged-1', parts: [{
        type: 'multi-forward', title: 'Alice & Bob 的聊天记录',
        locator: { conversationId: 'uid-1715311957', rootMessageId: 'merged-1' },
      }] },
    ])
    await expect(events.next()).resolves.toMatchObject({ value: {
      type: 'message', message: { id: 'merged-1', parts: [{ type: 'multi-forward' }] },
    } })
    expect(f.msg.multiForwardMsgWithComment).toHaveBeenCalledWith([
      { msgId: 'm1', senderShowName: 'Self' },
      { msgId: 'm2', senderShowName: 'Alice' },
    ], expect.anything(), expect.anything(), [], expect.any(Map))
    expect(f.msg.multiForwardMsg).not.toHaveBeenCalled()

    const nested = {
      ...f.message, msgId: 'nested-1',
      elements: [{
        elementType: 16, elementId: 'nested',
        multiForwardMsgElement: { fileName: '嵌套聊天记录', resId: 'nested-res' },
      }],
    }
    f.msg.getMultiMsg.mockResolvedValueOnce({ result: 0, errMsg: '', msgList: [nested] })
    await expect(bridge.getMultiForwardMessages({
      conversationId: 'uid-1715311957', rootMessageId: 'merged-1',
    })).resolves.toMatchObject([{
      id: 'nested-1', parts: [{
        type: 'multi-forward', title: '嵌套聊天记录',
        locator: {
          conversationId: 'uid-1715311957', rootMessageId: 'merged-1', parentMessageId: 'nested-1',
        },
      }],
    }])
    expect(f.msg.getMultiMsg).toHaveBeenCalledWith(expect.anything(), 'merged-1', 'merged-1')

    f.msg.getMultiMsg
      .mockResolvedValueOnce({ result: 4, errMsg: 'Data Not Existed!', msgList: [] })
      .mockResolvedValueOnce({ result: 0, errMsg: '', msgList: [nested] })
    await expect(bridge.getMultiForwardMessages({
      conversationId: 'uid-1715311957', rootMessageId: 'merged-1', parentMessageId: 'nested-1',
    })).resolves.toMatchObject([{ id: 'nested-1' }])
    expect(f.msg.getMultiMsg).toHaveBeenNthCalledWith(2, expect.anything(), 'merged-1', 'nested-1')
    expect(f.msg.getMultiMsg).toHaveBeenNthCalledWith(3, expect.anything(), 'nested-1', 'nested-1')
  })

  it('creates transcript-scoped virtual participants from forwarded names and avatars', async () => {
    const f = fixture()
    const bridge = new QQKernelBridge()
    bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: '/tmp' })
    await bridge.getDialogs()
    const forwarded = [
      {
        ...f.message, msgId: 'forward-alice-1', senderUid: 'placeholder', senderUin: '1094950020',
        sendType: 1, sendNickName: 'Alice', sendMemberName: '', avatarMeta: 'avatar-a',
      },
      {
        ...f.message, msgId: 'forward-alice-2', senderUid: 'placeholder', senderUin: '1094950020',
        sendType: 0, sendNickName: ' Alice ', sendMemberName: '', avatarMeta: 'avatar-a',
      },
      {
        ...f.message, msgId: 'forward-bob', senderUid: 'placeholder', senderUin: '1094950020',
        sendType: 0, sendNickName: 'Bob', sendMemberName: '', avatarMeta: 'avatar-b',
      },
      {
        ...f.message, msgId: 'forward-other-alice', senderUid: 'placeholder', senderUin: '1094950020',
        sendType: 0, sendNickName: 'Alice', sendMemberName: '', avatarMeta: 'avatar-b',
      },
    ] satisfies MsgRecord[]
    f.msg.getMultiMsg.mockResolvedValue({ result: 0, errMsg: '', msgList: forwarded })
    const locator = { conversationId: 'uid-1715311957', rootMessageId: 'merged-virtual' }

    const first = await bridge.getMultiForwardMessages(locator)
    const repeated = await bridge.getMultiForwardMessages(locator)
    const otherTranscript = await bridge.getMultiForwardMessages({
      ...locator, rootMessageId: 'merged-other',
    })

    expect(first.map((message) => message.senderId)).toEqual([
      first[0]!.senderId,
      first[0]!.senderId,
      first[2]!.senderId,
      first[3]!.senderId,
    ])
    expect(new Set(first.map((message) => message.senderId)).size).toBe(3)
    expect(first[0]!.senderId).toMatch(/^qqnt-multi-forward-participant:[0-9a-f]{32}$/)
    expect(first.map((message) => message.outgoing)).toEqual([false, false, false, false])
    expect(first.map((message) => message.sender?.numericId)).toEqual([
      undefined, undefined, undefined, undefined,
    ])
    expect(repeated.map((message) => message.senderId)).toEqual(first.map((message) => message.senderId))
    expect(otherTranscript.map((message) => message.senderId)).not.toEqual(first.map((message) => message.senderId))
  })

  it('uses include-self for current QQ direct-chat history', async () => {
    const f = fixture()
    f.msg.getMsgsIncludeSelf = vi.fn(async () => ({
      result: 0, errMsg: '', msgList: [f.message],
    }))
    f.msg.getAioFirstViewLatestMsgs = vi.fn(async () => ({
      result: 0, errMsg: '', msgList: [f.message], needContinueGetMsg: false,
    }))
    const bridge = new QQKernelBridge()
    bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: '/tmp' })
    const [conversation] = (await bridge.getDialogs()).conversations

    await expect(bridge.getHistory(conversation)).resolves.toMatchObject({
      messages: [{ id: 'm1' }],
    })
    expect(f.msg.getMsgsIncludeSelf).toHaveBeenCalledOnce()
    expect(f.msg.getAioFirstViewLatestMsgs).not.toHaveBeenCalled()
    expect(f.msg.getLatestDbMsgs).not.toHaveBeenCalled()
  })

  it('races QQ group first-view cache with include-self instead of waiting on a stuck cache call', async () => {
    const f = fixture()
    f.msg.getAioFirstViewLatestMsgs = vi.fn(() => new Promise<never>(() => {}))
    f.msg.getMsgsIncludeSelf = vi.fn(async () => ({
      result: 0, errMsg: '', msgList: [{ ...f.message, chatType: 2, peerUid: '565265554', peerUin: '565265554' }],
    }))
    const bridge = new QQKernelBridge()
    bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: '/tmp' })

    await expect(bridge.getHistory(bridge.getConversation('565265554'))).resolves.toMatchObject({
      messages: [{ id: 'm1', conversationId: '565265554' }],
    })
    expect(f.msg.getAioFirstViewLatestMsgs).toHaveBeenCalledOnce()
    expect(f.msg.getMsgsIncludeSelf).toHaveBeenCalledOnce()
  })

  it('streams request bytes into QQ staging without collecting a body Buffer', async () => {
    const f = fixture()
    const bridge = new QQKernelBridge()
    bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: '/tmp' })
    const chunks = [Buffer.alloc(64 * 1024, 0x61), Buffer.alloc(64 * 1024, 0x62)]
    await bridge.send({
      conversationId: 'uid-1715311957',
      media: [{ kind: 'file', name: 'stream.bin', size: chunks.reduce((sum, chunk) => sum + chunk.length, 0) }],
    }, Readable.from(chunks))
    expect(f.sentBodies).toEqual([Buffer.concat(chunks)])
  })

  it('sends images with real source metadata and rejects kSendFailed', async () => {
    const f = fixture()
    const bridge = new QQKernelBridge()
    bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: '/tmp' })
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      'base64',
    )
    f.msg.sendMsg.mockImplementation(async () => {
      setTimeout(() => f.emitMessages([{ ...f.message, sendStatus: 0 }]), 5)
      return { result: 0, errMsg: '' }
    })

    await expect(bridge.send({
      conversationId: 'uid-1715311957',
      media: [{ kind: 'image', name: 'tiny.png', size: png.length }],
    }, Readable.from([png]))).rejects.toThrow('QQ send failed')
    expect(f.msg.sendMsg).toHaveBeenCalledWith(
      'm1', expect.objectContaining({ peerUid: 'uid-1715311957' }), [expect.objectContaining({
        picElement: expect.objectContaining({
          fileSize: String(png.length), picWidth: 1, picHeight: 1,
          md5HexStr: 'e44e7ecfec99356632c13cd3eaa3e250',
        }),
      })], expect.any(Map),
    )
  })

  it('uses declared JPEG dimensions and type for the native image element', async () => {
    const f = fixture()
    const bridge = new QQKernelBridge()
    bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: '/tmp' })
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9])
    f.msg.sendMsg.mockImplementation(async () => {
      queueMicrotask(() => f.emitMessages([{ ...f.message, sendStatus: 2 }]))
      return { result: 0, errMsg: '' }
    })

    await bridge.send({
      conversationId: 'uid-1715311957',
      media: [{ kind: 'image', name: 'wide.jpeg', size: jpeg.length, width: 1096, height: 892 }],
    }, Readable.from([jpeg]))

    expect(f.msg.sendMsg).toHaveBeenCalledWith(
      'm1', expect.objectContaining({ peerUid: 'uid-1715311957' }), [expect.objectContaining({
        picElement: expect.objectContaining({ picWidth: 1096, picHeight: 892, picType: 1000 }),
      })], expect.any(Map),
    )
  })

  it('streams multiple framed images into one native message without joining their buffers', async () => {
    const f = fixture()
    const bridge = new QQKernelBridge()
    bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: '/tmp' })
    const first = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      'base64',
    )
    const second = Buffer.from(first)
    second[second.length - 1] ^= 1
    const frame = (bytes: Buffer) => [
      Buffer.from([0, 0, 0, bytes.length]), bytes, Buffer.alloc(4),
    ]
    f.msg.sendMsg.mockImplementationOnce(async (_id, _peer, elements) => {
      queueMicrotask(() => f.emitMessages([{ ...f.message, sendStatus: 2, elements }]))
      return { result: 0, errMsg: '' }
    })

    const sent = await bridge.send({
      conversationId: 'uid-1715311957', mediaFraming: 'length-prefixed-v1',
      media: [
        { kind: 'image', name: 'first.png', size: first.length },
        { kind: 'image', name: 'second.png', size: second.length },
      ],
    }, Readable.from([...frame(first), ...frame(second)]))

    expect(f.msg.sendMsg).toHaveBeenCalledWith(
      'm1', expect.anything(), [
        expect.objectContaining({ picElement: expect.objectContaining({ md5HexStr: 'e44e7ecfec99356632c13cd3eaa3e250' }) }),
        expect.objectContaining({ picElement: expect.objectContaining({ md5HexStr: '5b118909b999cf913eb2ab9e8972fbe0' }) }),
      ], expect.any(Map),
    )
    expect(sent.parts.filter((part) => part.type === 'media')).toHaveLength(2)
  })

  it('lists, decrypts, sends, and maps QQ market stickers', async () => {
    const f = fixture()
    const directory = await mkdtemp(join(tmpdir(), 'qqnt-market-sticker-'))
    tempPaths.push(directory)
    const detailPath = join(directory, 'pack.json')
    const staticPath = join(directory, 'sticker.png')
    const dynamicPath = join(directory, 'sticker.gif.encrypt')
    await writeFile(detailPath, JSON.stringify({
      name: 'Downloaded QQ Waves',
      isApng: 0,
      imgs: [{ id: 'emoji-a', name: 'Wave', wWidthInPhone: 320, wHeightInPhone: 180, isApng: 1 }],
    }))
    await writeFile(staticPath, Buffer.from('static'))
    const gif = Buffer.from('GIF89a-decrypted-sticker')
    await writeFile(dynamicPath, gif.map((byte, index) => index % 50 < 20 ? ~byte : byte))
    f.msg.fetchMarketEmoticonList.mockResolvedValue({
      result: 0, errMsg: '', marketEmoticonInfo: { roamEmojiTab: {
        timesTamp: 7, segmentFlag: -1,
        ordinaryTabinfoList: [{ epId: 42, wordingId: 9, tabType: 3, tabName: 'QQ Waves' }],
        magicTabinfoList: [], smallTabinfoList: [], epIds: [42],
      } },
    })
    f.msg.getMarketEmoticonPath.mockImplementation(async (epId, ids, serviceType) => {
      let pathMap = new Map<string, { isExist: boolean, path: string }>()
      if (serviceType === 1) pathMap = new Map([[String(epId), { isExist: true, path: detailPath }]])
      if (serviceType === 3) pathMap = new Map(ids.map((id: string) => [id, { isExist: true, path: staticPath }]))
      if (serviceType === 5) pathMap = new Map(ids.map((id: string) => [id, { isExist: true, path: dynamicPath }]))
      return { result: 0, errMsg: '', pathMap }
    })
    f.msg.getMarketEmoticonEncryptKeys.mockResolvedValue({
      result: 0, errMsg: '', encryptKeyMap: new Map([['emoji-a', 'secret']]),
    })
    const bridge = new QQKernelBridge()
    bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: directory })

    await expect(bridge.getStickerPacks()).resolves.toMatchObject({
      packs: [{ packId: '42', title: 'QQ Waves' }],
    })
    const pack = await bridge.getStickerPack('42')
    expect(pack).toMatchObject({
      packId: '42', count: 1,
      stickers: [{ stickerId: 'market:42:emoji-a', format: 'animated', width: 320, height: 180 }],
    })
    expect(await readStream((await bridge.openSticker(pack!.stickers[0].reference)).stream)).toEqual(gif)

    const record = {
      ...f.message,
      sendStatus: 2,
      elements: [{
        elementType: 11, elementId: 'market-element',
        marketFaceElement: {
          itemType: 6, faceInfo: 1, emojiPackageId: 42, subType: 3, mediaType: 0,
          imageWidth: 320, imageHeight: 180, faceName: '[Wave]', emojiId: 'emoji-a',
          key: 'secret', emojiType: 2, staticFacePath: staticPath, dynamicFacePath: dynamicPath,
        },
      }],
    } satisfies MsgRecord
    f.msg.sendMsg.mockImplementation(async () => {
      queueMicrotask(() => f.emitMessages([record]))
      return { result: 0, errMsg: '' }
    })
    const sent = await bridge.send({
      conversationId: 'uid-1715311957', sticker: pack!.stickers[0].reference,
    }, Readable.from([]))
    expect(f.msg.sendMsg).toHaveBeenCalledWith(
      'm1', expect.anything(), [expect.objectContaining({
        elementType: 11,
        marketFaceElement: expect.objectContaining({ emojiPackageId: 42, emojiId: 'emoji-a', key: 'secret' }),
      })], expect.any(Map),
    )
    expect(sent.parts).toMatchObject([{ type: 'sticker', sticker: { stickerId: 'market:42:emoji-a' } }])

    await rm(dynamicPath)
    f.msg.fetchMarketEmoticonAioImage.mockImplementation(async () => {
      await writeFile(dynamicPath, gif.map((byte, index) => index % 50 < 20 ? ~byte : byte))
      return { result: 0, errMsg: '' }
    })
    expect(await readStream((await bridge.openSticker(pack!.stickers[0].reference)).stream)).toEqual(gif)
    expect(f.msg.fetchMarketEmoticonAioImage).toHaveBeenCalledWith(expect.objectContaining({ jobType: 0 }))

    // A received market sticker can belong to a pack that is not installed and
    // therefore absent from the bottom emoji catalog. Resolve it directly by
    // its opaque package ID through the current QQ API.
    f.msg.fetchMarketEmotionJsonFile = vi.fn(async () => ({ result: 0, errMsg: '' }))
    await expect(bridge.getStickerPack('43')).resolves.toMatchObject({
      packId: '43', title: 'Downloaded QQ Waves',
      stickers: [{ packId: '43', stickerId: 'market:43:emoji-a' }],
    })
    expect(f.msg.fetchMarketEmotionJsonFile).toHaveBeenCalledWith(43)
  })

  it('maps every QQ expression picture subtype as a sticker and keeps only normal/QZone pictures as media', async () => {
    const f = fixture()
    f.message.elements = Array.from({ length: 14 }, (_, picSubType) => ({
      elementType: 2,
      elementId: `picture-${picSubType}`,
      picElement: {
        fileName: `${picSubType}.png`, fileSize: '4', picWidth: 32, picHeight: 32,
        md5HexStr: `md5-${picSubType}`, fileUuid: `uuid-${picSubType}`, fileSubId: '', picSubType,
      },
    }))
    const bridge = new QQKernelBridge()
    bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: '/tmp' })

    const [message] = (await bridge.getHistory(bridge.getConversation('uid-1715311957'))).messages
    expect(message.parts.filter((part) => part.type === 'media')).toMatchObject([
      { media: { name: '0.png' } }, { media: { name: '5.png' } },
    ])
    expect(message.parts.filter((part) => part.type === 'sticker')).toHaveLength(12)
  })

  it('does not expose a QQ thumbnail path as the original image', async () => {
    const f = fixture()
    f.message.elements = [{
      elementType: 2, elementId: 'picture-with-thumb',
      picElement: {
        fileName: 'original.png', fileSize: '1024', picWidth: 32, picHeight: 32,
        md5HexStr: 'image-md5', fileUuid: 'image-uuid', fileSubId: '', picSubType: 0,
        originImageUrl: 'https://multimedia.nt.qq.com.cn/download?appid=1407&fileid=image&rkey=expired',
        thumbPath: new Map([[0, '/tmp/incomplete-thumbnail.png']]),
      },
    }]
    const bridge = new QQKernelBridge()
    bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: '/tmp' })

    const [message] = (await bridge.getHistory(bridge.getConversation('uid-1715311957'))).messages
    expect(message.parts).toMatchObject([{
      type: 'media', media: { locator: {
        filePath: undefined, fileUuid: 'image-uuid',
        originImageUrl: 'https://multimedia.nt.qq.com.cn/download?appid=1407&fileid=image&rkey=expired',
      } },
    }])
  })

  it('maps animated pictures as animated stickers even with a normal picture subtype', async () => {
    const f = fixture()
    f.message.elements = [{
      elementType: 2, elementId: 'animated-picture',
      picElement: {
        fileName: 'expression.jpg', fileSize: '4', picWidth: 32, picHeight: 32,
        md5HexStr: 'animated-md5', fileUuid: 'animated-uuid', fileSubId: '', picSubType: 0, picType: 2000,
      },
    }]
    const bridge = new QQKernelBridge()
    bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: '/tmp' })

    const [message] = (await bridge.getHistory(bridge.getConversation('uid-1715311957'))).messages
    expect(message.parts).toMatchObject([{
      type: 'sticker', sticker: { format: 'animated', mimeType: 'image/apng' },
    }])
  })

  it('accepts repeated sticker catalog segment markers like the QQ client', async () => {
    const f = fixture()
    f.msg.fetchMarketEmoticonList
      .mockResolvedValueOnce({
        result: 0, errMsg: '', marketEmoticonInfo: { roamEmojiTab: {
          timesTamp: 1, segmentFlag: 0,
          ordinaryTabinfoList: [{ epId: 41, wordingId: 0, tabType: 0, tabName: 'First' }],
          magicTabinfoList: [], smallTabinfoList: [], epIds: [41],
        } },
      })
      .mockResolvedValueOnce({
        result: 0, errMsg: '', marketEmoticonInfo: { roamEmojiTab: {
          timesTamp: 2, segmentFlag: 0,
          ordinaryTabinfoList: [{ epId: 42, wordingId: 0, tabType: 0, tabName: 'Second' }],
          magicTabinfoList: [], smallTabinfoList: [], epIds: [42],
        } },
      })
      .mockResolvedValueOnce({
        result: 0, errMsg: '', marketEmoticonInfo: { roamEmojiTab: {
          timesTamp: 3, segmentFlag: -1,
          ordinaryTabinfoList: [{ epId: 43, wordingId: 0, tabType: 0, tabName: 'Last' }],
          magicTabinfoList: [], smallTabinfoList: [], epIds: [43],
        } },
      })
    const bridge = new QQKernelBridge()
    bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: '/tmp' })

    await expect(bridge.getStickerPacks()).resolves.toMatchObject({
      packs: [{ packId: '41' }, { packId: '42' }, { packId: '43' }],
    })
    expect(f.msg.fetchMarketEmoticonList).toHaveBeenNthCalledWith(2, 1, 0)
    expect(f.msg.fetchMarketEmoticonList).toHaveBeenNthCalledWith(3, 2, 0)
  })

  it('uses the current QQ bottom emoji table and exposes visible market packs', async () => {
    const f = fixture()
    f.msg.fetchBottomEmojiTableList = vi.fn()
      .mockResolvedValueOnce({
        result: 0, errMsg: '', marketEmoticonInfo: {
          segmentFlag: 7,
          emojiNewTabs: [
            { epId: 51, wordingId: 1, bottomEmojitabType: 0, tabName: 'Installed', isHide: false },
            { epId: 52, wordingId: 2, bottomEmojitabType: 0, tabName: 'Hidden', isHide: true },
            { epId: 2, wordingId: 3, bottomEmojitabType: 6, tabName: 'QQ Faces', isHide: false },
          ],
        },
      })
      .mockResolvedValueOnce({
        result: 0, errMsg: '', marketEmoticonInfo: {
          segmentFlag: -1,
          emojiNewTabs: [
            { epId: 53, wordingId: 4, bottomEmojitabType: 0, tabName: 'Second', isHide: false },
          ],
        },
      })
    const bridge = new QQKernelBridge()
    bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: '/tmp' })

    await expect(bridge.getStickerPacks()).resolves.toMatchObject({
      packs: [
        { packId: '51', title: 'Installed' },
        { packId: '53', title: 'Second' },
      ],
    })
    expect(f.msg.fetchBottomEmojiTableList).toHaveBeenNthCalledWith(2, {
      commonReqInfo: { appVersion: '', businessId: 0 }, timeStamp: 0, segmentFlag: 7,
    })
    expect(f.msg.fetchMarketEmoticonList).not.toHaveBeenCalled()
  })

  it('lists and mutates QQ favorite stickers through the native collection', async () => {
    const f = fixture()
    const directory = await mkdtemp(join(tmpdir(), 'qqnt-favorite-sticker-'))
    tempPaths.push(directory)
    const path = join(directory, 'favorite.png')
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      'base64',
    )
    await writeFile(path, png)
    f.msg.fetchFavEmojiList.mockResolvedValue({
      result: 0, errMsg: '', emojiInfoList: [{
        emoPath: path, isExist: true, resId: 'fav-res', url: '', md5: 'fav-md5',
        emoOriginalPath: path, thumbPath: path, isAPNG: false, isMarkFace: false,
        eId: '', epId: '', desc: 'Saved image',
      }],
    })
    const bridge = new QQKernelBridge()
    bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: directory })

    const page = await bridge.getSavedStickers()
    expect(page.stickers).toMatchObject([{
      stickerId: 'favorite:fav-res', format: 'static', width: 1, height: 1,
    }])
    const reference = page.stickers[0].reference
    await bridge.setSavedSticker(reference, true)
    expect(f.msg.addFavEmoji).toHaveBeenCalledWith(expect.objectContaining({
      emojiPath: path, isMarkFace: false, md5: 'fav-md5',
    }))
    await bridge.setSavedSticker(reference, false)
    expect(f.msg.deleteFavEmoji).toHaveBeenCalledWith(['fav-res'])
  })

  it('stages favorite stickers with their final subtype and preserves the collection file', async () => {
    const f = fixture()
    const directory = await mkdtemp(join(tmpdir(), 'qqnt-favorite-send-'))
    tempPaths.push(directory)
    const sourcePath = join(directory, 'favorite.png')
    const nativePath = join(directory, 'native', 'favorite.png')
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      'base64',
    )
    await writeFile(sourcePath, png)
    await mkdir(join(directory, 'native'))
    await writeFile(nativePath, Buffer.from('stale cache entry'))
    f.msg.getRichMediaFilePath.mockReturnValue(nativePath)
    const bridge = new QQKernelBridge()
    bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: directory })

    await bridge.send({
      conversationId: 'uid-1715311957',
      sticker: {
        kind: 'favorite', resId: 'fav-res', path: sourcePath, name: 'favorite.png',
        width: 1, height: 1, animated: false,
      },
    }, Readable.from([]))

    expect(f.msg.getRichMediaFilePath).toHaveBeenCalledWith(
      2, 1, 'e44e7ecfec99356632c13cd3eaa3e250',
      'e44e7ecfec99356632c13cd3eaa3e250.png', 1, 0, true,
    )
    expect(f.msg.sendMsg).toHaveBeenCalledWith(
      'm1', expect.anything(), [expect.objectContaining({
        picElement: expect.objectContaining({
          picSubType: 1, md5HexStr: 'e44e7ecfec99356632c13cd3eaa3e250', sourcePath: nativePath,
        }),
      })], expect.any(Map),
    )
    expect(f.sentBodies).toEqual([png])
    await expect(readFile(sourcePath)).resolves.toEqual(png)
  })

  it('returns every buddy as a contact without adding the full buddy list to dialogs', async () => {
    const f = fixture()
    const bridge = new QQKernelBridge()
    bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: '/tmp' })
    f.emitBuddyList([{ buddyList: [
      { uid: 'friend-a', uin: '1', nick: 'A', remark: '', avatarUrl: '' },
      { uid: 'friend-b', uin: '2', nick: 'B', remark: '', avatarUrl: '' },
    ] }])
    f.emitBuddyInfo(new Map([
      ['friend-a', { uid: 'friend-a', uin: '1', nick: 'Updated A', remark: '', avatarUrl: '' }],
      ['stranger', { uid: 'stranger', uin: '999', nick: 'Seen in a group', remark: '', avatarUrl: '' }],
    ]))
    const contacts = await bridge.getContacts()
    expect(contacts.users.map((user) => user.id)).toEqual(['self', 'friend-a', 'friend-b'])
    expect(contacts.users.find((user) => user.id === 'friend-a')?.name).toBe('nick-friend-a')
    const dialogs = await bridge.getDialogs()
    expect(dialogs.conversations.map((item) => item.id)).toEqual(['uid-1715311957'])

    f.emitBuddyList([{ buddyList: [
      { uid: 'friend-a', uin: '1', nick: 'A', remark: '', avatarUrl: '' },
    ] }])
    await expect(bridge.getContacts()).resolves.toMatchObject({
      users: [{ id: 'self' }, { id: 'friend-a' }],
    })
  })

  it('keeps the canonical group name and avatar on message events', async () => {
    const f = fixture()
    const bridge = new QQKernelBridge()
    bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: '/tmp' })
    await bridge.resolveConversation(2, '1058754719')
    f.emitGroupList([{ groupCode: '1058754719', groupName: 'Bridge Test Group' }])
    const events = bridge.subscribe()[Symbol.asyncIterator]()

    f.emitReceived([{
      ...f.message,
      msgId: 'group-incoming',
      chatType: 2,
      sendType: 0,
      senderUid: 'member',
      senderUin: '42',
      peerUid: '1058754719',
      peerUin: '1058754719',
      peerName: '',
      sendNickName: 'Personal Name',
      sendMemberName: 'Group Alias',
    }])

    await expect(events.next()).resolves.toMatchObject({
      value: {
        type: 'message',
        conversation: {
          id: '1058754719',
          title: 'Bridge Test Group',
          avatar: { id: 'avatar:group:1058754719', locator: { filePath: avatarFixturePath } },
        },
        message: {
          sender: {
            id: 'member',
            numericId: '42',
            name: 'Personal Name',
            alias: 'Group Alias',
            avatar: { locator: { avatarUin: '42' } },
          },
        },
      },
    })
  })

  it('replays events emitted after the last acknowledged stream event', async () => {
    const f = fixture()
    const bridge = new QQKernelBridge()
    bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: '/tmp' })
    const firstQueue = bridge.subscribe()
    const firstEvents = firstQueue[Symbol.asyncIterator]()

    f.emitReceived([{ ...f.message, msgId: 'replay-1', msgSeq: '101' }])
    const first = await firstEvents.next()
    expect(first.done).toBe(false)
    const lastEventId = bridge.eventId(first.value!)
    expect(lastEventId).toBeTruthy()
    bridge.unsubscribe(firstQueue)

    f.emitReceived([{ ...f.message, msgId: 'replay-2', msgSeq: '102' }])
    const replayed = bridge.subscribe(lastEventId)[Symbol.asyncIterator]()
    await expect(replayed.next()).resolves.toMatchObject({
      value: { type: 'message', message: { id: 'replay-2', msgSeq: '102' } },
    })
  })

  it('keeps a group member personal name and alias separate and adds a qlogo avatar', async () => {
    const f = fixture()
    const bridge = new QQKernelBridge()
    bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: '/tmp' })
    const page = await bridge.getMembers(bridge.getConversation('1058754719'))
    expect(page.members).toMatchObject([{
      user: {
        id: 'member',
        numericId: '42',
        name: 'Personal Name',
        alias: 'Group Alias',
        avatar: {
          id: 'avatar:user:member',
          mimeType: 'image/jpeg',
          locator: { avatarUin: '42' },
        },
      },
    }])
    await expect(bridge.getUser('member')).resolves.toMatchObject({
      id: 'member',
      name: 'Personal Name',
      avatar: { locator: { avatarUin: '42' } },
    })
  })

  it('keeps native member cursors opaque and reports the group profile total on every page', async () => {
    const f = fixture()
    f.group.getNextMemberList
      .mockResolvedValueOnce({
        errCode: 0, errMsg: '', result: {
          ids: [{ uid: 'member-a', index: 1 }, { uid: 'member-b', index: 2 }],
          infos: new Map([
            ['member-a', {
              uid: 'member-a', uin: '1', nick: 'A', remark: '', cardName: '', role: 2, avatarPath: '',
            }],
            ['member-b', {
              uid: 'member-b', uin: '2', nick: 'B', remark: '', cardName: '', role: 2, avatarPath: '',
            }],
          ]),
          finish: false,
        },
      })
      .mockResolvedValueOnce({
        errCode: 0, errMsg: '', result: {
          ids: [{ uid: 'member-c', index: 3 }],
          infos: new Map([['member-c', {
            uid: 'member-c', uin: '3', nick: 'C', remark: '', cardName: '', role: 3, avatarPath: '',
          }]]),
          finish: true,
        },
      })
    const bridge = new QQKernelBridge()
    bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: '/tmp' })
    await bridge.resolveConversation(2, '1058754719')
    f.emitGroupList([{
      groupCode: '1058754719', groupName: 'Bridge Test Group', memberCount: 3, memberRole: 4,
    }])
    expect(bridge.getConversation('1058754719')).toMatchObject({
      participantCount: 3, selfRole: 'owner',
    })

    const first = await bridge.getMembers(bridge.getConversation('1058754719'), undefined, 2)
    const second = await bridge.getMembers(bridge.getConversation('1058754719'), first.nextCursor, 2)
    expect(first).toMatchObject({ total: 3, members: [{ user: { id: 'member-a' } }, { user: { id: 'member-b' } }] })
    expect(second).toMatchObject({
      total: 3, members: [{ user: { id: 'member-c' }, role: 'administrator' }],
    })
    expect(second.nextCursor).toBeUndefined()
    expect(f.group.getNextMemberList).toHaveBeenNthCalledWith(1, 'scene', { uid: '', index: 0 }, 30)
    expect(f.group.getNextMemberList).toHaveBeenNthCalledWith(
      2, 'scene', { uid: 'member-b', index: 2 }, 30,
    )
    expect(f.group.createMemberListScene).toHaveBeenCalledTimes(1)
    expect(f.group.destroyMemberListScene).toHaveBeenCalledTimes(1)
    expect(f.group.destroyMemberListScene).toHaveBeenCalledWith('scene')
  })

  it('terminates a member chain when QQ returns a non-advancing page', async () => {
    const f = fixture()
    const repeated = {
      errCode: 0, errMsg: '', result: {
        ids: [{ uid: 'member-a', index: 1 }, { uid: 'member-b', index: 2 }],
        infos: new Map([
          ['member-a', {
            uid: 'member-a', uin: '1', nick: 'A', remark: '', cardName: '', role: 2, avatarPath: '',
          }],
          ['member-b', {
            uid: 'member-b', uin: '2', nick: 'B', remark: '', cardName: '', role: 2, avatarPath: '',
          }],
        ]),
        finish: false,
      },
    }
    f.group.getNextMemberList.mockResolvedValue(repeated)
    const bridge = new QQKernelBridge()
    bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: '/tmp' })

    const first = await bridge.getMembers(bridge.getConversation('1058754719'), undefined, 2)
    const repeatedPage = await bridge.getMembers(
      bridge.getConversation('1058754719'), first.nextCursor, 2,
    )

    expect(first.nextCursor).toEqual(expect.any(String))
    expect(repeatedPage.nextCursor).toBeUndefined()
    expect(f.group.createMemberListScene).toHaveBeenCalledTimes(1)
    expect(f.group.destroyMemberListScene).toHaveBeenCalledTimes(1)
  })

  it('uses the member-list listener when a cold native request returns an empty snapshot', async () => {
    const f = fixture()
    f.group.getNextMemberList.mockResolvedValueOnce({
      errCode: 0, errMsg: '', result: { ids: [], infos: new Map(), finish: true },
    })
    const bridge = new QQKernelBridge()
    bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: '/tmp' })
    await bridge.resolveConversation(2, '1058754719')
    f.emitGroupList([{
      groupCode: '1058754719', groupName: 'Bridge Test Group', memberCount: 2, memberRole: 4,
    }])
    const page = bridge.getMembers(bridge.getConversation('1058754719'), undefined, 1)
    f.emitMemberList({
      sceneId: 'scene',
      ids: [{ uid: 'member-a', index: 1 }, { uid: 'member-b', index: 2 }],
      infos: new Map([
        ['member-a', {
          uid: 'member-a', uin: '1', nick: 'A', remark: '', cardName: '', role: 2, avatarPath: '',
        }],
        ['member-b', {
          uid: 'member-b', uin: '2', nick: 'B', remark: '', cardName: '', role: 2, avatarPath: '',
        }],
      ]),
      hasNext: false,
    })
    await expect(page).resolves.toMatchObject({
      total: 2,
      members: [{ user: { id: 'member-a' } }],
      nextCursor: expect.any(String),
    })
  })

  it('streams a complete qlogo avatar from the fixed QQ endpoint', async () => {
    const requested = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      expect(String(input)).toBe('https://q1.qlogo.cn/g?b=qq&nk=42&s=640')
      expect(init?.headers).toBeUndefined()
      return new Response(Uint8Array.from([1, 2]), { status: 200 })
    })
    vi.stubGlobal('fetch', requested)
    try {
      const bridge = new QQKernelBridge()
      const stream = await bridge.downloadFile({
        messageId: 'avatar:user:member',
        elementId: 'avatar:user:member',
        chatType: 1,
        peerUid: 'member',
        kind: 'image',
        fileName: '42.jpg',
        avatarUin: '42',
      })
      const chunks: Buffer[] = []
      for await (const chunk of stream) chunks.push(Buffer.from(chunk))
      expect(Buffer.concat(chunks)).toEqual(Buffer.from([1, 2]))
      expect(requested).toHaveBeenCalledOnce()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('streams local reaction resources without enqueueing a native message download', async () => {
    const f = fixture()
    const directory = await mkdtemp(join(tmpdir(), 'qqnt-reaction-resource-'))
    tempPaths.push(directory)
    const resourcePath = join(directory, 'reaction.png')
    await writeFile(resourcePath, 'local-reaction')
    const bridge = new QQKernelBridge({ tempPath: directory })
    bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: '/tmp' })

    const stream = await bridge.downloadFile({
      messageId: `reaction:${resourcePath}`, elementId: `reaction:${resourcePath}`,
      chatType: 1, peerUid: '', kind: 'image', fileName: 'reaction.png',
      filePath: resourcePath, fileSize: '14',
    })

    expect((await readStream(stream)).toString()).toBe('local-reaction')
    expect(f.msg.downloadRichMedia).not.toHaveBeenCalled()
  })

  it('coalesces concurrent native media downloads and reuses the completed path', async () => {
    const f = fixture()
    const directory = await mkdtemp(join(tmpdir(), 'qqnt-media-singleflight-'))
    tempPaths.push(directory)
    const downloadedPath = join(directory, 'downloaded.bin')
    await writeFile(downloadedPath, 'abcdefghijklmnop')
    const bridge = new QQKernelBridge({ tempPath: directory })
    bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: '/tmp' })
    const locator = {
      messageId: 'download-message', elementId: 'download-element', chatType: 2 as const,
      peerUid: 'group', kind: 'file' as const, fileName: 'downloaded.bin', fileSize: '16',
      filePath: join(directory, 'missing.bin'), fileUuid: 'download-uuid', md5: 'ABCDEF',
    }

    const pendingStreams = Promise.all([
      bridge.downloadFile(locator),
      bridge.downloadFile({ ...locator, md5: 'different-locator-snapshot' }),
      bridge.downloadFile(locator),
      bridge.downloadFile(locator),
    ])
    await vi.waitFor(() => expect(f.msg.downloadRichMedia).toHaveBeenCalledOnce())
    expect(f.msg.downloadRichMedia).toHaveBeenCalledWith({
      fileModelId: '0', downSourceType: 0, downloadSourceType: 0, triggerType: 1,
      msgId: locator.messageId, chatType: locator.chatType, peerUid: locator.peerUid,
      elementId: locator.elementId, thumbSize: 0, downloadType: 1, filePath: '',
    })
    f.emitDownload({
      fileModelId: '', msgId: locator.messageId, msgElementId: locator.elementId,
      fileErrCode: '0', fileErrMsg: '', fileDownType: 1, thumbSize: 0,
      filePath: downloadedPath, totalSize: '16', trasferStatus: 4,
    })

    const files = await Promise.all((await pendingStreams).map(readStream))
    expect(files.map((bytes) => bytes.toString())).toEqual(Array(4).fill('abcdefghijklmnop'))

    const sameContent = await bridge.downloadFile({
      ...locator, messageId: 'another-message', elementId: 'another-element', fileUuid: 'another-uuid',
      md5: 'abcdef',
    })
    expect((await readStream(sameContent)).toString()).toBe('abcdefghijklmnop')
    expect(f.msg.downloadRichMedia).toHaveBeenCalledOnce()
  })

  it('does not resolve an original download with a concurrent thumbnail callback', async () => {
    const f = fixture()
    const directory = await mkdtemp(join(tmpdir(), 'qqnt-media-callback-match-'))
    tempPaths.push(directory)
    const thumbnailPath = join(directory, 'thumbnail.jpg')
    const originalPath = join(directory, 'original.jpg')
    await writeFile(thumbnailPath, 'thumb')
    await writeFile(originalPath, 'original')
    const bridge = new QQKernelBridge({ tempPath: directory })
    bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: '/tmp' })
    const locator = {
      messageId: 'parallel-message', elementId: 'parallel-element', chatType: 2 as const,
      peerUid: 'group', kind: 'image' as const, fileName: 'original.jpg',
      filePath: thumbnailPath, fileUuid: 'parallel-uuid',
    }

    let settled = false
    const pending = bridge.downloadFile(locator).then((stream) => {
      settled = true
      return stream
    })
    await vi.waitFor(() => expect(f.msg.downloadRichMedia).toHaveBeenCalledOnce())
    f.emitDownload({
      fileModelId: '', msgId: locator.messageId, msgElementId: locator.elementId,
      fileErrCode: '0', fileErrMsg: '', fileDownType: 2, thumbSize: 720,
      filePath: thumbnailPath, totalSize: '5', trasferStatus: 4,
    })
    await Promise.resolve()
    expect(settled).toBe(false)

    f.emitDownload({
      fileModelId: '', msgId: locator.messageId, msgElementId: locator.elementId,
      fileErrCode: '0', fileErrMsg: '', fileDownType: 1, thumbSize: 0,
      filePath: originalPath, totalSize: '8', trasferStatus: 4,
    })
    expect((await readStream(await pending)).toString()).toBe('original')
  })

  it('uses QQ download completion for images without parsing the completed file', async () => {
    const f = fixture()
    const directory = await mkdtemp(join(tmpdir(), 'qqnt-media-native-complete-'))
    tempPaths.push(directory)
    const downloadedPath = join(directory, 'downloaded.jpg')
    // QQ is authoritative here: valid QQ image payloads are not required to
    // satisfy a bridge-side JPEG/PNG parser after the native success event.
    const complete = Buffer.alloc(173_994, 0x61)
    await writeFile(downloadedPath, complete)
    const bridge = new QQKernelBridge({ tempPath: directory })
    bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: '/tmp' })
    const locator = {
      messageId: 'incomplete-message', elementId: 'incomplete-element', chatType: 2 as const,
      peerUid: 'group', kind: 'image' as const, fileName: 'downloaded.jpg',
      fileSize: String(complete.length), filePath: downloadedPath, fileUuid: 'incomplete-uuid',
    }

    const pending = bridge.downloadFile(locator)
    await vi.waitFor(() => expect(f.msg.downloadRichMedia).toHaveBeenCalledOnce())
    f.emitDownload({
      fileModelId: '', msgId: locator.messageId, msgElementId: locator.elementId,
      fileErrCode: '0', fileErrMsg: '', fileDownType: 1, thumbSize: 0, filePath: downloadedPath,
      totalSize: String(complete.length), trasferStatus: 4,
    })

    expect(await readStream(await pending)).toEqual(complete)
  })

  it('publishes a first-seen info update as a message even with an empty reaction list', async () => {
    const f = fixture()
    const bridge = new QQKernelBridge()
    bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: '/tmp' })
    const events = bridge.subscribe()[Symbol.asyncIterator]()

    f.emitMessages([{ ...f.message, msgId: 'first-info', sendType: 0, senderUid: 'friend', emojiLikesList: [] }])

    await expect(events.next()).resolves.toMatchObject({
      value: { type: 'message', message: { id: 'first-info' } },
    })
  })

  it('retracts an optimistic outgoing event when QQ later rejects it', async () => {
    const f = fixture()
    const bridge = new QQKernelBridge()
    bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: '/tmp' })
    const events = bridge.subscribe()[Symbol.asyncIterator]()

    f.emitSent({ ...f.message, msgId: 'eventually-failed', sendStatus: 1 })
    f.emitMessages([{ ...f.message, msgId: 'eventually-failed', sendStatus: 0 }])

    await expect(events.next()).resolves.toMatchObject({
      value: { type: 'message', message: { id: 'eventually-failed' } },
    })
    await expect(events.next()).resolves.toMatchObject({
      value: { type: 'message-delete', messageIds: ['eventually-failed'] },
    })
  })

  it('rechecks an unresolved group-avatar placeholder instead of caching the miss forever', async () => {
    const f = fixture()
    const bridge = new QQKernelBridge()
    bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: '/tmp' })
    f.setAvatarPath('')
    bridge.getConversation('1058754719')
    const first = await bridge.getDialogs()
    expect(first.conversations.find((item) => item.id === '1058754719')?.avatar?.locator.filePath).toBeUndefined()

    const resolvedPath = process.platform === 'win32' ? process.execPath : '/dev/null'
    f.setAvatarPath(resolvedPath)
    const second = await bridge.getDialogs()
    expect(second.conversations.find((item) => item.id === '1058754719')?.avatar?.locator.filePath).toBe(resolvedPath)
  })

  it('writes multiple reactions sequentially and emits updates for history messages', async () => {
    const f = fixture()
    const bridge = new QQKernelBridge()
    bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: '/tmp' })
    const conversation = await bridge.resolveConversation(2, '1058754719')
    const groupMessage = {
      ...f.message,
      chatType: 2 as const,
      peerUid: '1058754719',
      peerUin: '1058754719',
    }
    f.msg.getMsgsByMsgId.mockResolvedValue({ result: 0, errMsg: '', msgList: [groupMessage] })
    f.msg.getLatestDbMsgs.mockResolvedValue({ result: 0, errMsg: '', msgList: [groupMessage] })
    await bridge.getHistory(conversation)
    await expect(bridge.setMessageReactions(conversation, 'm1', ['2:128522', '1:14']))
      .resolves.toMatchObject({ reactions: [
        { key: '2:128522', selected: true },
        { key: '1:14', selected: true },
      ] })
    expect(f.msg.setMsgEmojiLikes.mock.calls).toEqual([
      [expect.objectContaining({ peerUid: '1058754719' }), 'seq1', '128522', '2', true],
      [expect.objectContaining({ peerUid: '1058754719' }), 'seq1', '14', '1', true],
    ])

    const events = bridge.subscribe()[Symbol.asyncIterator]()
    f.emitMessages([{
      ...groupMessage,
      emojiLikesList: [{ emojiType: '2', emojiId: '128522', likesCnt: '3', isClicked: true }],
    }])
    await expect(events.next()).resolves.toMatchObject({
      value: { type: 'message-reactions', context: { reactions: [{ key: '2:128522', count: 3 }] } },
    })
    const state = await bridge.getMessageReactions(conversation, 'm1')
    expect(state).not.toHaveProperty('available')
  })

  it('loads and exposes the users behind each reaction', async () => {
    const f = fixture()
    const bridge = new QQKernelBridge()
    bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: '/tmp' })
    const conversation = await bridge.resolveConversation(2, '1058754719')
    const groupMessage = {
      ...f.message,
      chatType: 2 as const,
      peerUid: '1058754719',
      peerUin: '1058754719',
      emojiLikesList: [{ emojiType: '2', emojiId: '128522', likesCnt: '3', isClicked: false }],
    }
    f.msg.getMsgsByMsgId.mockResolvedValue({ result: 0, errMsg: '', msgList: [groupMessage] })
    f.msg.getMsgEmojiLikesList
      .mockResolvedValueOnce({
        result: 0, errMsg: '', cookie: 'next', isFirstPage: true, isLastPage: false,
        emojiLikesList: [
          { tinyId: 'actor-a', nickName: 'Alice', headUrl: 'https://example.com/a.jpg' },
          { tinyId: 'actor-b', nickName: 'Bob', headUrl: '' },
        ],
      })
      .mockResolvedValueOnce({
        result: 0, errMsg: '', cookie: 'done', isFirstPage: false, isLastPage: true,
        emojiLikesList: [
          { tinyId: 'actor-b', nickName: 'Bob', headUrl: '' },
          { tinyId: 'actor-c', nickName: 'Carol', headUrl: '' },
        ],
      })

    await expect(bridge.getMessageReactions(conversation, 'm1')).resolves.toMatchObject({
      reactions: [{
        key: '2:128522', count: 3,
        recentActors: [{ userId: 'actor-a' }, { userId: 'actor-b' }, { userId: 'actor-c' }],
      }],
    })
    expect(f.msg.getMsgEmojiLikesList.mock.calls).toEqual([
      [expect.objectContaining({ peerUid: '1058754719' }), 'seq1', '128522', '2', '', false, 10],
      [expect.objectContaining({ peerUid: '1058754719' }), 'seq1', '128522', '2', 'next', false, 10],
    ])
    await expect(bridge.getUser('actor-a')).resolves.toMatchObject({
      id: 'actor-a', name: 'Alice', avatarUrl: 'https://example.com/a.jpg',
    })
  })

  it('normalizes numeric reaction actors to QQ UIDs and exposes profile names and qlogo avatars', async () => {
    const f = fixture()
    f.setProfile({
      uid: 'actor-uid', uin: '3998401572', nick: '', remark: '', avatarUrl: '', coreInfo: { nick: 'Alice' },
    })
    const bridge = new QQKernelBridge()
    bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: '/tmp' })
    const conversation = await bridge.resolveConversation(2, '1058754719')
    const groupMessage = {
      ...f.message,
      chatType: 2 as const,
      peerUid: '1058754719',
      peerUin: '1058754719',
      emojiLikesList: [{ emojiType: '2', emojiId: '128522', likesCnt: '1', isClicked: false }],
    }
    f.msg.getMsgsByMsgId.mockResolvedValue({ result: 0, errMsg: '', msgList: [groupMessage] })
    f.msg.getMsgEmojiLikesList.mockResolvedValue({
      result: 0, errMsg: '', cookie: '', isFirstPage: true, isLastPage: true,
      emojiLikesList: [{ tinyId: '3998401572', nickName: '3998401572', headUrl: '' }],
    })

    await expect(bridge.getMessageReactions(conversation, 'm1')).resolves.toMatchObject({
      reactions: [{ recentActors: [{ userId: 'actor-uid' }] }],
    })
    await expect(bridge.getUser('actor-uid')).resolves.toMatchObject({
      id: 'actor-uid', numericId: '3998401572', name: 'Alice',
      avatar: { locator: { avatarUin: '3998401572' } },
    })
  })

  it('preserves uncatalogued reactions and gives successive native updates unique event IDs', async () => {
    const f = fixture()
    const bridge = new QQKernelBridge()
    bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: '/tmp' })
    const conversation = await bridge.resolveConversation(2, '1058754719')
    const groupMessage = {
      ...f.message,
      chatType: 2 as const,
      peerUid: '1058754719',
      peerUin: '1058754719',
    }
    f.msg.getLatestDbMsgs.mockResolvedValue({ result: 0, errMsg: '', msgList: [groupMessage] })
    await bridge.getHistory(conversation)
    const events = bridge.subscribe()[Symbol.asyncIterator]()

    f.emitMessages([{
      ...groupMessage,
      emojiLikesList: [{ emojiType: '2', emojiId: '999999', likesCnt: '1', isClicked: false }],
    }])
    const first = await events.next()
    expect(first.value).toMatchObject({
      type: 'message-reactions',
      context: { reactions: [{ key: '2:999999', count: 1 }] },
    })

    f.emitMessages([{
      ...groupMessage,
      emojiLikesList: [{ emojiType: '2', emojiId: '999999', likesCnt: '2', isClicked: false }],
    }])
    const second = await events.next()
    expect(second.value).toMatchObject({
      type: 'message-reactions',
      context: { reactions: [{ key: '2:999999', count: 2 }] },
    })
    expect(second.value && 'eventId' in second.value ? second.value.eventId : undefined)
      .not.toBe(first.value && 'eventId' in first.value ? first.value.eventId : undefined)

    f.emitMessages([{ ...groupMessage, sendStatus: 3 }])
    await expect(bridge.getMessageReactions(conversation, groupMessage.msgId)).resolves.toMatchObject({
      reactions: [{ key: '2:999999', count: 2 }],
    })
  })

  it('loads animated sysfaces and non-Telegram QQ emoji as custom reaction resources', async () => {
    const root = await mkdtemp(join(tmpdir(), 'qqnt-reactions-'))
    tempPaths.push(root)
    const resourceRoot = join(root, 'global', 'nt_data', 'Emoji', 'emoji-resource')
    const staticPath = join(resourceRoot, 'sysface_res', 'static')
    const animatedPath = join(resourceRoot, 'sysface_res', 'apng')
    const emojiPath = join(resourceRoot, 'emoji_res')
    await Promise.all([
      mkdir(staticPath, { recursive: true }),
      mkdir(animatedPath, { recursive: true }),
      mkdir(emojiPath, { recursive: true }),
    ])
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+X1n0WQAAAABJRU5ErkJggg==',
      'base64',
    )
    await Promise.all([
      writeFile(join(resourceRoot, 'face_config.json'), JSON.stringify({
        emoji: [{ QSid: '😊', QCid: '128522', AQLid: '0', QDes: '/嘿嘿' }],
        sysface: [{ QSid: '14', QDes: '/微笑' }],
      })),
      writeFile(join(staticPath, 's14.png'), png),
      writeFile(join(animatedPath, 's14.png'), png),
      writeFile(join(emojiPath, 'emoji_000.png'), png),
    ])
    const f = fixture()
    const bridge = new QQKernelBridge()
    bridge.attach(f.kernel, f.session, {
      selfUin: '10000', selfUid: 'self', userPath: join(root, 'account'),
    })
    await vi.waitFor(async () => expect((await bridge.getReactionCatalog()).available).toHaveLength(2))

    expect((await bridge.getReactionCatalog()).available).toEqual(expect.arrayContaining([
      expect.objectContaining({
        key: '2:128522',
        presentation: expect.objectContaining({
          type: 'custom', alt: '😊',
          resource: expect.objectContaining({ format: 'static', mimeType: 'image/png' }),
        }),
      }),
      expect.objectContaining({
        key: '1:14',
        presentation: expect.objectContaining({
          type: 'custom', alt: '🙂',
          resource: expect.objectContaining({
            format: 'video', mimeType: 'video/webm', locator: { filePath: join(animatedPath, 's14.png') },
          }),
        }),
      }),
    ]))
  })

  it('does not expose or write reactions in direct conversations', async () => {
    const f = fixture()
    const bridge = new QQKernelBridge()
    bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: '/tmp' })
    const conversation = (await bridge.getDialogs()).conversations[0]

    await expect(bridge.getMessageReactions(conversation, 'm1'))
      .resolves.toEqual({ reactions: [], maxSelected: 0 })
    await expect(bridge.setMessageReactions(conversation, 'm1', ['1:14']))
      .rejects.toThrow('unavailable in direct conversations')
    expect(f.msg.setMsgEmojiLikes).not.toHaveBeenCalled()
  })

  it('uses the final group msgSeq and accepts an idempotent reaction add', async () => {
    const f = fixture()
    const bridge = new QQKernelBridge()
    bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: '/tmp' })
    const conversation = await bridge.resolveConversation(2, '1058754719')
    const optimistic = {
      ...f.message, msgId: 'group-message', msgSeq: 'old-seq', chatType: 2,
      peerUid: '1058754719', peerUin: '1058754719', sendStatus: 1,
    }
    const confirmed = { ...optimistic, msgSeq: 'final-seq', sendStatus: 2 }
    f.msg.getMsgsByMsgId.mockResolvedValue({ result: 0, errMsg: '', msgList: [optimistic] })
    f.msg.getLatestDbMsgs.mockResolvedValue({ result: 0, errMsg: '', msgList: [confirmed] })
    f.msg.setMsgEmojiLikes.mockResolvedValue({ result: 65002, errMsg: '已经设置过该表情' })
    const events = bridge.subscribe()[Symbol.asyncIterator]()

    await expect(bridge.setMessageReactions(conversation, 'group-message', ['1:14']))
      .resolves.toMatchObject({ reactions: [{ key: '1:14', selected: true }] })
    expect(f.msg.setMsgEmojiLikes).toHaveBeenCalledWith(
      expect.objectContaining({ chatType: 2, peerUid: '1058754719' }),
      'final-seq', '14', '1', true,
    )
    await expect(events.next()).resolves.toMatchObject({
      value: {
        type: 'message-reactions',
        target: { conversationId: '1058754719', messageId: 'group-message' },
        context: { reactions: [{ key: '1:14', selected: true }] },
      },
    })
  })
})

describe('QQBridgeServer', () => {
  let server: QQBridgeServer | undefined
  const tempPaths: string[] = []
  afterEach(async () => {
    await server?.stop()
    await Promise.all(tempPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })))
  })

  it('serves status, dialogs, and a chunked send endpoint', async () => {
    const f = fixture()
    f.search.searchChatMsgs.mockImplementation(() => {
      queueMicrotask(() => f.emitSearch({
        searchId: 71, hasMore: false, resultItems: [{
          msgId: 'http-search', msgSeq: '7', msgTime: '1700000000', senderUid: 'self',
          senderUin: '10000', senderNick: 'Self', msgRecord: { ...f.message, msgId: 'http-search' },
        }],
      }))
      return 71
    })
    const bridge = new QQKernelBridge()
    bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: '/tmp' })
    server = new QQBridgeServer(bridge, { port: 0 })
    await server.start()
    const { port } = server.address()
    const base = `http://127.0.0.1:${port}/v1`
    await expect(fetch(`${base}/status`).then((response) => response.json())).resolves.toMatchObject({
      protocolVersion: 14, ready: true, selfUin: '10000',
    })
    await expect(fetch(`${base}/dialogs`).then((response) => response.json())).resolves.toMatchObject({
      conversations: [{ peerUin: '1715311957' }],
    })
    await expect(fetch(`${base}/conversations/uid-1715311957/search?q=hello&limit=10`)
      .then((response) => response.json())).resolves.toMatchObject({
      messages: [{ id: 'http-search' }],
    })
    const manifest = Buffer.from(JSON.stringify({
      conversationId: 'uid-1715311957', text: 'via HTTP',
    })).toString('base64url')
    const response = await fetch(`${base}/messages`, {
      method: 'POST', headers: { 'x-qqnt-manifest': manifest }, body: new Uint8Array(),
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ id: 'm1' })
  })

  it('streams events over WebSocket, resumes by event id, and removes closed subscribers', async () => {
    const f = fixture()
    const bridge = new QQKernelBridge()
    bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: '/tmp' })
    server = new QQBridgeServer(bridge, { port: 0 })
    await server.start()
    const base = `http://127.0.0.1:${server.address().port}/v1`
    await expect(fetch(`${base}/events`)).resolves.toMatchObject({ status: 404 })

    const firstSocket = new WebSocket(base.replace('http:', 'ws:') + '/events/ws')
    await once(firstSocket, 'open')
    expect(bridge.events.size).toBe(1)
    const firstFrame = once(firstSocket, 'message')
    f.emitReceived([{
      ...f.message, msgId: 'ws-first', msgSeq: '100', sendType: 0,
      senderUid: 'friend', senderUin: '42', sendNickName: 'Friend',
    }])
    const [firstRaw] = await firstFrame
    const first = JSON.parse(firstRaw.toString())
    expect(first).toMatchObject({ id: '1', event: { type: 'message', message: { id: 'ws-first' } } })
    firstSocket.close()
    await once(firstSocket, 'close')
    await vi.waitFor(() => expect(bridge.events.size).toBe(0))

    const observation = bridge.subscribe()
    const observed = observation[Symbol.asyncIterator]().next()
    f.emitReceived([{
      ...f.message, msgId: 'ws-second', msgSeq: '101', sendType: 0,
      senderUid: 'friend', senderUin: '42', sendNickName: 'Friend',
    }])
    await observed
    bridge.unsubscribe(observation)
    const resumedSocket = new WebSocket(base.replace('http:', 'ws:') + '/events/ws?lastEventId=1')
    const [secondRaw] = await once(resumedSocket, 'message')
    const second = JSON.parse(secondRaw.toString())
    expect(second).toMatchObject({ id: '2', event: { type: 'message', message: { id: 'ws-second' } } })
    resumedSocket.close()
    await once(resumedSocket, 'close')
    await vi.waitFor(() => expect(bridge.events.size).toBe(0))
  })

  it('can listen for WebSocket events on a separately configured address', async () => {
    const f = fixture()
    const bridge = new QQKernelBridge()
    bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: '/tmp' })
    server = new QQBridgeServer(bridge, { port: 0, webSocketPort: 0 })
    await server.start()

    const httpAddress = server.address()
    const webSocketAddress = server.webSocketAddress()
    expect(webSocketAddress.port).not.toBe(httpAddress.port)
    await expect(fetch(`http://127.0.0.1:${webSocketAddress.port}/v1/events/ws`))
      .resolves.toMatchObject({ status: 426 })

    const socket = new WebSocket(`ws://127.0.0.1:${webSocketAddress.port}/v1/events/ws`)
    await once(socket, 'open')
    expect(bridge.events.size).toBe(1)
    socket.close()
    await once(socket, 'close')
    await vi.waitFor(() => expect(bridge.events.size).toBe(0))
  })

  it('serves complete files and coalesces concurrent native downloads', async () => {
    const f = fixture()
    const directory = await mkdtemp(join(tmpdir(), 'qqnt-media-http-singleflight-'))
    tempPaths.push(directory)
    const downloadedPath = join(directory, 'downloaded.bin')
    await writeFile(downloadedPath, 'abcdefghijklmnop')
    const bridge = new QQKernelBridge({ tempPath: directory })
    bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: '/tmp' })
    server = new QQBridgeServer(bridge, { port: 0 })
    await server.start()
    const base = `http://127.0.0.1:${server.address().port}/v1`
    const locator = {
      messageId: 'http-message', elementId: 'http-element', chatType: 2,
      peerUid: 'group', kind: 'file', fileName: 'downloaded.bin', fileSize: '16',
      filePath: join(directory, 'missing.bin'), fileUuid: 'http-uuid', md5: '1234abcd',
    }
    const download = () => fetch(`${base}/files/download`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(locator),
    })

    const pendingResponses = Array.from({ length: 4 }, download)
    await vi.waitFor(() => expect(f.msg.downloadRichMedia).toHaveBeenCalledOnce())
    f.emitDownload({
      fileModelId: '', msgId: locator.messageId, msgElementId: locator.elementId,
      fileErrCode: '0', fileErrMsg: '', fileDownType: 1, thumbSize: 0,
      filePath: downloadedPath, totalSize: '16', trasferStatus: 4,
    })
    const responses = await Promise.all(pendingResponses)
    expect(responses.map((response) => response.status)).toEqual([200, 200, 200, 200])
    const files = await Promise.all(responses.map(async (response) => Buffer.from(await response.arrayBuffer()).toString()))
    expect(files).toEqual(Array(4).fill('abcdefghijklmnop'))

    const cached = await download()
    expect(Buffer.from(await cached.arrayBuffer()).toString()).toBe('abcdefghijklmnop')
    const ranged = await fetch(`${base}/files/download`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', range: 'bytes=5-8' },
      body: JSON.stringify(locator),
    })
    expect(ranged.status).toBe(206)
    expect(ranged.headers.get('accept-ranges')).toBe('bytes')
    expect(ranged.headers.get('content-range')).toBe('bytes 5-8/16')
    expect(ranged.headers.get('content-length')).toBe('4')
    expect(Buffer.from(await ranged.arrayBuffer()).toString()).toBe('fghi')
    const beyondEnd = await fetch(`${base}/files/download`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', range: 'bytes=16-' },
      body: JSON.stringify(locator),
    })
    expect(beyondEnd.status).toBe(416)
    expect(beyondEnd.headers.get('content-range')).toBe('bytes */16')
    expect((await fetch(`${base}/media/open`, { method: 'POST' })).status).toBe(404)
    expect(f.msg.downloadRichMedia).toHaveBeenCalledOnce()
  })

  it('resolves a native video play URL with domain candidates first', async () => {
    const f = fixture()
    f.richMedia.getVideoPlayUrl.mockResolvedValueOnce({
      result: 0, errMsg: '', urlResult: {
        domainUrl: [{ url: 'https://media.example/domain.mp4?token=secret', isHttps: true, httpsDomain: '' }],
        v4IpUrl: [{ url: 'https://192.0.2.10/ip.mp4', isHttps: true, httpsDomain: 'cdn.example' }],
        v6IpUrl: [], videoCodecFormat: 1,
      },
    })
    const bridge = new QQKernelBridge()
    bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: '/tmp' })
    server = new QQBridgeServer(bridge, { port: 0 })
    await server.start()
    const response = await fetch(`http://127.0.0.1:${server.address().port}/v1/files/play-url`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        messageId: 'video-message', elementId: 'video-element', chatType: 2, peerUid: 'group',
        kind: 'file', fileName: 'clip.mp4', videoCodecFormat: 1,
      }),
    })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ url: 'https://media.example/domain.mp4?token=secret' })
    expect(f.richMedia.getVideoPlayUrl).toHaveBeenCalledWith(
      { chatType: 2, peerUid: 'group', guildId: '' },
      'video-message', 'video-element', 1, 2,
    )
    expect(f.msg.downloadRichMedia).not.toHaveBeenCalled()
  })

  it('serves an image direct URL through the xref-verified packet path', async () => {
    const f = fixture()
    const sendPacket = vi.fn(async () => ({ rspbuffer: Buffer.from('fetch-rkey-response') }))
    Object.assign(f.msg, { sendSsoCmdReqByContend: sendPacket })
    const addon: PacketAddon = {
      sendPacket: vi.fn((send, command, payload) => send(command, payload)),
      encodeFetchRkeyRequest: vi.fn(() => ({
        command: 'OidbSvcTrpcTcp.0x9067_202', payload: Buffer.from('fetch-rkey-request'),
      })),
      decodeFetchRkeyResponse: vi.fn(() => [{
        value: '&rkey=fresh-group', ttlSeconds: '3600', createdAt: 1_800_000_000, kind: 20,
      }]),
      refreshImageUrl: vi.fn((original, rkey) => {
        const url = new URL(original)
        url.searchParams.set('rkey', rkey.replace(/^&?rkey=/, ''))
        return url.toString()
      }),
      locateSendBinding: vi.fn(() => ({
        moduleBase: '0x180000000', anchorRva: 0x100, xrefRva: 0x200, functionRva: 0x180,
      })),
    }
    const bridge = new QQKernelBridge({
      packetClient: { addon, now: () => 1_800_000_000_000 },
    })
    bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: '/tmp' })
    server = new QQBridgeServer(bridge, { port: 0 })
    await server.start()
    const base = `http://127.0.0.1:${server.address().port}/v1/files/direct-url`
    const response = await fetch(base, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        messageId: 'image-message', elementId: 'image-element', chatType: 2, peerUid: 'group',
        kind: 'image', fileName: 'image.jpg',
        originImageUrl: 'https://multimedia.nt.qq.com.cn/download?appid=1407&fileid=image&rkey=expired',
      }),
    })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      url: 'https://multimedia.nt.qq.com.cn/download?appid=1407&fileid=image&rkey=fresh-group',
    })
    expect(sendPacket).toHaveBeenCalledWith(
      'OidbSvcTrpcTcp.0x9067_202', Buffer.from('fetch-rkey-request'),
    )
    expect(addon.locateSendBinding).toHaveBeenCalledOnce()
    expect(f.msg.downloadRichMedia).not.toHaveBeenCalled()

    const unsupported = await fetch(base, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        messageId: 'file-message', elementId: 'file-element', chatType: 2, peerUid: 'group',
        kind: 'file', fileName: 'document.bin',
      }),
    })
    expect(unsupported.status).toBe(404)
    expect(sendPacket).toHaveBeenCalledOnce()
  })

  it('warns once per normalized slow HTTP route', async () => {
    const f = fixture()
    const bridge = new QQKernelBridge()
    bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: '/tmp' })
    const directory = await mkdtemp(join(tmpdir(), 'qqnt-bridge-server-'))
    tempPaths.push(directory)
    const path = join(directory, 'slow.log')
    server = new QQBridgeServer(bridge, {
      port: 0,
      slowRequestThresholdMs: -1,
      slowRequestPath: path,
    })
    await server.start()
    const { port } = server.address()
    await fetch(`http://127.0.0.1:${port}/v1/status`)
    await fetch(`http://127.0.0.1:${port}/v1/status`)

    const lines = (await readFile(path, 'utf8')).trim().split('\n')
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0])).toMatchObject({
      route: '/v1/status',
      method: 'GET',
      status: 200,
      completed: true,
    })
  })
})
