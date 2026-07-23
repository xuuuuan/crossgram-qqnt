import { Readable } from 'node:stream'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ContactMsgBoxInfo, KernelModule, KernelSession, MsgRecord } from './kernel-types.js'
import { QQKernelBridge } from './qq-kernel.js'
import { QQBridgeServer } from './server.js'

function fixture() {
  let msgHandlers: Record<string, (...args: unknown[]) => unknown> = {}
  let buddyHandlers: Record<string, (...args: unknown[]) => unknown> = {}
  let groupHandlers: Record<string, (...args: unknown[]) => unknown> = {}
  let avatarPath = '/dev/null'
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
      const file = elements.find((element: { fileElement?: { filePath: string }, picElement?: { sourcePath?: string } }) =>
        element.fileElement || element.picElement)
      if (file) {
        const { readFile } = await import('node:fs/promises')
        sentBodies.push(await readFile(file.fileElement?.filePath ?? file.picElement.sourcePath))
      }
      queueMicrotask(() => msgHandlers.onAddSendMsg?.(message))
      return { result: 0, errMsg: '' }
    }),
    recallMsg: vi.fn(async () => ({ result: 0, errMsg: '' })),
    deleteMsg: vi.fn(async () => ({ result: 0, errMsg: '' })),
    forwardMsg: vi.fn(async () => ({ result: 0, errMsg: '', detailErr: new Map() })),
    getMsgs: vi.fn(async () => ({ result: 0, errMsg: '', msgList: [message] })),
    getMsgsIncludeSelf: undefined as import('./kernel-types.js').KernelMsgService['getMsgsIncludeSelf'],
    getLatestDbMsgs: vi.fn(async () => ({ result: 0, errMsg: '', msgList: [message] })),
    getAioFirstViewLatestMsgs: undefined as import('./kernel-types.js').KernelMsgService['getAioFirstViewLatestMsgs'],
    getFirstUnreadMsgSeq: vi.fn(async () => ({ result: 4, errMsg: '', seq: '0' })),
    getABatchOfContactMsgBoxInfo: vi.fn(async () => ({
      result: 0, errMsg: '', contactMsgBoxInfos: [] as ContactMsgBoxInfo[],
    })),
    getMsgsBySeqAndCount: vi.fn(async () => ({ result: 0, errMsg: '', msgList: [message] })),
    getMsgsByMsgId: vi.fn(async () => ({ result: 0, errMsg: '', msgList: [message] })),
    setMsgEmojiLikes: vi.fn(async () => ({ result: 0, errMsg: '' })),
  }
  const recent = {
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
  class Listener {
    handlers: typeof msgHandlers
    constructor(handlers: typeof msgHandlers) { this.handlers = handlers }
  }
  const kernel = {
    NodeIQQNTWrapperSession: { prototype: { init() {} } },
    NodeIKernelMsgListener: Listener,
    NodeIKernelBuddyListener: Listener,
    NodeIKernelGroupListener: Listener,
  } as unknown as KernelModule
  const session = {
    getMsgService: () => msg,
    getRecentContactService: () => recent,
    getBuddyService: () => buddy,
    getGroupService: () => group,
    getRichMediaService: () => ({ downloadFile: vi.fn() }),
    getAvatarService: () => ({
      getAvatarPath: () => avatarPath, forceDownloadAvatar: async () => ({ result: 0, errMsg: '' }),
      getGroupAvatarPath: () => avatarPath, getConfGroupAvatarPath: () => '',
      forceDownloadGroupAvatar: async () => ({ result: 0, errMsg: '' }),
    }),
    getUixConvertService: () => ({
      getUid: async () => ({ uidInfo: new Map([['1715311957', 'uid-1715311957']]) }),
      getUin: async () => ({ uinInfo: new Map([['uid-1715311957', '1715311957']]) }),
    }),
  } as unknown as KernelSession
  return {
    kernel, session, msg, recent, message, sentBodies,
    emitMessages(records: MsgRecord[]) {
      msgHandlers.onMsgInfoListUpdate?.(records)
    },
    emitReceived(records: MsgRecord[]) {
      msgHandlers.onRecvMsg?.(records)
    },
    emitSent(record: MsgRecord) {
      msgHandlers.onAddSendMsg?.(record)
    },
    emitBuddyList(categories: Array<{ buddyList: unknown[] }>) {
      buddyHandlers.onBuddyListChange?.(categories)
    },
    emitBuddyInfo(infos: Map<string, unknown>) {
      buddyHandlers.onBuddyInfoChange?.(infos)
    },
    emitGroupList(groups: Array<{ groupCode: string, groupName: string, remarkName?: string }>) {
      groupHandlers.onGroupListUpdate?.(1, groups)
    },
    setAvatarPath(path: string) {
      avatarPath = path
    },
  }
}

describe('QQKernelBridge', () => {
  it('maps dialogs/history and confirms sends from the native listener', async () => {
    const f = fixture()
    const bridge = new QQKernelBridge()
    bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: '/tmp' })
    const dialogs = await bridge.getDialogs()
    expect(dialogs.conversations[0]).toMatchObject({
      id: 'uid-1715311957', peerUin: '1715311957', title: 'xuuuuan',
      lastMessage: { id: 'm1', parts: [{ type: 'text', text: 'hello preview' }] },
    })
    const history = await bridge.getHistory(dialogs.conversations[0])
    expect(history.messages[0]).toMatchObject({ id: 'm1', parts: [{ type: 'text', text: 'hello' }] })
    expect(f.msg.getLatestDbMsgs).toHaveBeenCalledWith(expect.objectContaining({
      chatType: 1, peerUid: 'uid-1715311957',
    }), 50)
    f.msg.sendMsg.mockImplementationOnce(async () => {
      queueMicrotask(() => f.emitMessages([{ ...f.message, sendStatus: 1 }]))
      return { result: 0, errMsg: '' }
    })
    const sent = await bridge.send({
      conversationId: dialogs.conversations[0].id, text: 'hello',
    }, Readable.from([]))
    expect(sent.id).toBe('m1')
    expect(f.msg.sendMsg).toHaveBeenCalledOnce()
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
          avatar: { id: 'avatar:group:1058754719', locator: { filePath: '/dev/null' } },
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

  it('streams a ranged qlogo avatar from the fixed QQ endpoint', async () => {
    const requested = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      expect(String(input)).toBe('https://q1.qlogo.cn/g?b=qq&nk=42&s=640')
      expect(init?.headers).toEqual({ range: 'bytes=10-11' })
      return new Response(Uint8Array.from([1, 2]), { status: 206 })
    })
    vi.stubGlobal('fetch', requested)
    try {
      const bridge = new QQKernelBridge()
      const stream = await bridge.openMedia({
        messageId: 'avatar:user:member',
        elementId: 'avatar:user:member',
        chatType: 1,
        peerUid: 'member',
        kind: 'image',
        fileName: '42.jpg',
        avatarUin: '42',
      }, 10, 2)
      const chunks: Buffer[] = []
      for await (const chunk of stream) chunks.push(Buffer.from(chunk))
      expect(Buffer.concat(chunks)).toEqual(Buffer.from([1, 2]))
      expect(requested).toHaveBeenCalledOnce()
    } finally {
      vi.unstubAllGlobals()
    }
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

    f.setAvatarPath('/dev/null')
    const second = await bridge.getDialogs()
    expect(second.conversations.find((item) => item.id === '1058754719')?.avatar?.locator.filePath).toBe('/dev/null')
  })

  it('writes multiple reactions sequentially and emits updates for history messages', async () => {
    const f = fixture()
    const bridge = new QQKernelBridge()
    bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: '/tmp' })
    const conversation = (await bridge.getDialogs()).conversations[0]
    await bridge.getHistory(conversation)
    await expect(bridge.setMessageReactions(conversation, 'm1', ['2:128522', '1:14']))
      .resolves.toMatchObject({ reactions: [
        { key: '2:128522', selected: true },
        { key: '1:14', selected: true },
      ] })
    expect(f.msg.setMsgEmojiLikes.mock.calls).toEqual([
      [expect.objectContaining({ peerUid: 'uid-1715311957' }), 'seq1', '128522', '2', true],
      [expect.objectContaining({ peerUid: 'uid-1715311957' }), 'seq1', '14', '1', true],
    ])

    const events = bridge.subscribe()[Symbol.asyncIterator]()
    f.emitMessages([{
      ...f.message,
      emojiLikesList: [{ emojiType: '2', emojiId: '128522', likesCnt: '3', isClicked: true }],
    }])
    await expect(events.next()).resolves.toMatchObject({
      value: { type: 'message-reactions', context: { reactions: [{ key: '2:128522', count: 3 }] } },
    })
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
    const bridge = new QQKernelBridge()
    bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: '/tmp' })
    server = new QQBridgeServer(bridge, { port: 0 })
    await server.start()
    const { port } = server.address()
    const base = `http://127.0.0.1:${port}/v1`
    await expect(fetch(`${base}/status`).then((response) => response.json())).resolves.toMatchObject({
      protocolVersion: 1, ready: true, selfUin: '10000',
    })
    await expect(fetch(`${base}/dialogs`).then((response) => response.json())).resolves.toMatchObject({
      conversations: [{ peerUin: '1715311957' }],
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
