import { Readable } from 'node:stream'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ContactMsgBoxInfo, FileTransNotifyInfo, KernelModule, KernelSession, MsgRecord } from './kernel-types.js'
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
    fetchFavEmojiList: vi.fn(async () => ({ result: 0, errMsg: '', emojiInfoList: [] })),
    addFavEmoji: vi.fn(async () => ({ result: 0, errMsg: '', isExist: 0 })),
    deleteFavEmoji: vi.fn(async () => ({ result: 0, errMsg: '' })),
    fetchMarketEmoticonList: vi.fn(async () => ({
      result: 0, errMsg: '', marketEmoticonInfo: { roamEmojiTab: {
        timesTamp: 1, segmentFlag: -1, ordinaryTabinfoList: [], magicTabinfoList: [],
        smallTabinfoList: [], epIds: [],
      } },
    })),
    fetchMarketEmoticonShowImage: vi.fn(async () => ({ result: 0, errMsg: '' })),
    fetchMarketEmoticonAioImage: vi.fn(async () => ({ result: 0, errMsg: '' })),
    getMarketEmoticonPath: vi.fn(() => new Map()),
    getMarketEmoticonEncryptKeys: vi.fn(async () => ({ result: 0, errMsg: '', encryptKeyMap: new Map() })),
    getFavMarketEmoticonInfo: vi.fn(async () => ({
      result: 0, errMsg: '', favMarketEmoticonInfo: { eId: '', width: 240, height: 240, faceName: '' },
    })),
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
  const richMedia = { downloadFile: vi.fn() }
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
    getRichMediaService: () => richMedia,
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
    kernel, session, msg, recent, group, richMedia, message, sentBodies,
    emitMessages(records: MsgRecord[]) {
      msgHandlers.onMsgInfoListUpdate?.(records)
    },
    emitReceived(records: MsgRecord[]) {
      msgHandlers.onRecvMsg?.(records)
    },
    emitSent(record: MsgRecord) {
      msgHandlers.onAddSendMsg?.(record)
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
      lastMessage: { id: 'm1', parts: [{ type: 'text', text: 'hello preview' }] },
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

  it('maps and sends native mention and reply elements without parsing opaque IDs', async () => {
    const f = fixture()
    f.message.elements = [{
      elementType: 7, elementId: 'reply', replyElement: {
        replayMsgId: 'opaque-original', sourceMsgTextElems: [], replyMsgRevokeType: 0,
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
      queueMicrotask(() => f.emitMessages([{ ...f.message, sendStatus: 2 }]))
      return { result: 0, errMsg: '' }
    })
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
    expect(f.msg.sendMsg).toHaveBeenCalledWith('m1', expect.anything(), [
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

  it('lists, decrypts, sends, and maps QQ market stickers', async () => {
    const f = fixture()
    const directory = await mkdtemp(join(tmpdir(), 'qqnt-market-sticker-'))
    tempPaths.push(directory)
    const detailPath = join(directory, 'pack.json')
    const staticPath = join(directory, 'sticker.png')
    const dynamicPath = join(directory, 'sticker.gif.encrypt')
    await writeFile(detailPath, JSON.stringify({
      isApng: 1,
      imgs: [{ id: 'emoji-a', name: 'Wave', wWidthInPhone: 320, wHeightInPhone: 180 }],
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
    f.msg.getMarketEmoticonPath.mockImplementation((epId, ids, serviceType) => {
      if (serviceType === 1) return new Map([[String(epId), { isExist: true, path: detailPath }]])
      if (serviceType === 3) return new Map(ids.map((id: string) => [id, { isExist: true, path: staticPath }]))
      if (serviceType === 5) return new Map(ids.map((id: string) => [id, { isExist: true, path: dynamicPath }]))
      return new Map()
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
      bridge.openMedia(locator, 0, 4),
      bridge.openMedia(locator, 4, 4),
      bridge.openMedia(locator, 8, 4),
      bridge.openMedia(locator, 12, 4),
    ])
    expect(f.richMedia.downloadFile).toHaveBeenCalledOnce()
    f.emitDownload({
      fileModelId: '', msgId: locator.messageId, msgElementId: locator.elementId,
      fileErrCode: '0', fileErrMsg: '', filePath: downloadedPath, totalSize: '16', trasferStatus: 4,
    })

    const ranges = await Promise.all((await pendingStreams).map(readStream))
    expect(ranges.map((bytes) => bytes.toString())).toEqual(['abcd', 'efgh', 'ijkl', 'mnop'])

    const sameContent = await bridge.openMedia({
      ...locator, messageId: 'another-message', elementId: 'another-element', fileUuid: 'another-uuid',
      md5: 'abcdef',
    }, 2, 6)
    expect((await readStream(sameContent)).toString()).toBe('cdefgh')
    expect(f.richMedia.downloadFile).toHaveBeenCalledOnce()
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
            format: 'video', mimeType: 'video/webm', locator: { filePath: join(staticPath, 's14.png'), assetKey: 'sysface/s14.webm' },
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
    const bridge = new QQKernelBridge()
    bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: '/tmp' })
    server = new QQBridgeServer(bridge, { port: 0 })
    await server.start()
    const { port } = server.address()
    const base = `http://127.0.0.1:${port}/v1`
    await expect(fetch(`${base}/status`).then((response) => response.json())).resolves.toMatchObject({
      protocolVersion: 6, ready: true, selfUin: '10000',
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

  it('serves concurrent media ranges through one native download', async () => {
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
    const open = (offset: number, limit: number) => fetch(`${base}/media/open`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-qqnt-offset': String(offset),
        'x-qqnt-limit': String(limit),
      },
      body: JSON.stringify(locator),
    })

    const pendingResponses = [0, 4, 8, 12].map((offset) => open(offset, 4))
    await vi.waitFor(() => expect(f.richMedia.downloadFile).toHaveBeenCalledOnce())
    f.emitDownload({
      fileModelId: '', msgId: locator.messageId, msgElementId: locator.elementId,
      fileErrCode: '0', fileErrMsg: '', filePath: downloadedPath, totalSize: '16', trasferStatus: 4,
    })
    const responses = await Promise.all(pendingResponses)
    expect(responses.map((response) => response.status)).toEqual([200, 200, 200, 200])
    const ranges = await Promise.all(responses.map(async (response) => Buffer.from(await response.arrayBuffer()).toString()))
    expect(ranges).toEqual(['abcd', 'efgh', 'ijkl', 'mnop'])

    const cached = await open(2, 6)
    expect(Buffer.from(await cached.arrayBuffer()).toString()).toBe('cdefgh')
    expect(f.richMedia.downloadFile).toHaveBeenCalledOnce()
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
