import { createHash } from 'node:crypto'
import { Readable } from 'node:stream'
import { once } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify, types } from 'node:util'
import { create, toBinary } from '@bufbuild/protobuf'
import { afterEach, describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import { GroupMsgMask, type ContactMsgBoxInfo, type KernelBuddyService, type KernelGroupService, type KernelModule, type KernelMsgService, type KernelRichMediaService, type KernelSession, type MsgElement, type MsgRecord } from './kernel-types.js'
import type { PacketAddon } from './packet-addon.js'
import { parseConversationId, type QQEvent, type QQStickerReference } from './protocol.js'
import { QQKernelBridge } from './qq-kernel.js'
import { QQBridgeServer } from './server.js'
import { QQPacketClient } from './packet-client.js'
import {
  HIGHWAY_BLOCK_SIZE, QQMediaUploadRejectedError, type DirectMessagePart,
} from './upload-protocol.js'
import { encodePtt } from './silk-audio.js'
import { GroupReactionNotifySchema, PushMessageEnvelopeSchema } from './generated/qqnt/packet_pb.js'

const execFileAsync = promisify(execFile)
const avatarFixturePath = process.platform === 'win32' ? process.execPath : '/dev/null'
const GROUP_JOIN_WRAPPER_MARKERS = [
  'getGroupInfoForJoinGroup needs 0 arguments',
  'queryJoinGroupCanNoVerify needs 4 arguments',
  'reqToJoinGroup needs 2 arguments',
  'joinGroup needs 3 arguments',
].join('\n')

function groupReactionPushBytes(options: {
  groupUin?: bigint
  messageSequence?: bigint
  operatorUid?: string
  code?: string
  currentCount?: number
  operation?: 1 | 2
} = {}): Uint8Array {
  const notify = toBinary(GroupReactionNotifySchema, create(GroupReactionNotifySchema, {
    groupUin: options.groupUin ?? 1_058_754_719n,
    subType: 35,
    reaction: { data: { data: {
      target: { sequence: options.messageSequence ?? 799_177n },
      data: {
        code: options.code ?? '10068',
        currentCount: options.currentCount ?? 1,
        operatorUid: options.operatorUid ?? 'actor-a',
        operation: options.operation ?? 1,
      },
    } } },
  }))
  return toBinary(PushMessageEnvelopeSchema, create(PushMessageEnvelopeSchema, {
    message: {
      contentHead: { type: 732, subType: 16 },
      body: { msgContent: Uint8Array.from([...new Uint8Array(7), ...notify]) },
    },
  }))
}

function completePng(width: number, height: number, padding = 0): Buffer {
  const bytes = Buffer.alloc(24 + padding + 12)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes)
  bytes.writeUInt32BE(13, 8)
  bytes.write('IHDR', 12, 'ascii')
  bytes.writeUInt32BE(width, 16)
  bytes.writeUInt32BE(height, 20)
  Buffer.from([0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82])
    .copy(bytes, bytes.length - 12)
  return bytes
}

function framedUpload(...files: Uint8Array[]): Buffer {
  const chunks: Buffer[] = []
  for (const file of files) {
    const bytes = Buffer.from(file)
    const header = Buffer.alloc(4)
    header.writeUInt32BE(bytes.length)
    chunks.push(header, bytes, Buffer.alloc(4))
  }
  return Buffer.concat(chunks)
}

function packetAddonFixture(): PacketAddon {
  const binding = {
    moduleBase: '0x180000000', profile: 'xref-v1', timeDateStamp: 0x1122_3344,
    sizeOfImage: 0x678000, anchorRva: 0x100, xrefRva: 0x200, functionRva: 0x180,
    converterRva: 0x300, responseRva: 0x400,
  }
  return {
    sendPacket: vi.fn((send, command, payload) => send(command, payload)),
    encodeFetchRkeyRequest: vi.fn(() => ({ command: '', payload: Buffer.alloc(0) })),
    decodeFetchRkeyResponse: vi.fn(() => []),
    encodeFetchSysFacesRequest: vi.fn(() => ({ command: '', payload: Buffer.alloc(0) })),
    decodeFetchSysFacesResponse: vi.fn(() => []),
    encodeVideoDownloadRequest: vi.fn(() => ({ command: '', payload: Buffer.alloc(0) })),
    decodeVideoDownloadResponse: vi.fn(() => ({ url: '', ttlSeconds: 0, createdAt: 0 })),
    encodeGroupFileDownloadRequest: vi.fn(() => ({ command: '', payload: Buffer.alloc(0) })),
    decodeGroupFileDownloadResponse: vi.fn(() => ({ url: '', ttlSeconds: 0, createdAt: 0 })),
    encodePrivateFileDownloadRequest: vi.fn(() => ({ command: '', payload: Buffer.alloc(0) })),
    decodePrivateFileDownloadResponse: vi.fn(() => ({ url: '', ttlSeconds: 0, createdAt: 0 })),
    refreshImageUrl: vi.fn((url) => url),
    probePacketBinding: vi.fn(() => ({
      moduleBase: binding.moduleBase, modulePath: '/qqnt/wrapper.node', profile: 'linux-xref-v1',
      buildId: 'build-id', sha256: 'sha256', nameSlotRva: '0x1', bindingNameRva: '0x2',
      bindingName: 'sendSsoCmdReqByContend', napiCallbackSlotRva: '0x3', napiCallbackRva: '0x4',
      napiCallbackFingerprint: 'fingerprint', responseActionSlotRva: '0x5', responseActionRva: '0x6',
      responseActionFingerprint: 'fingerprint', converterRva: '0x7', converterFingerprint: 'fingerprint',
      resolveActionRva: '0x8', resolveActionFingerprint: 'fingerprint',
    })),
    locateSendBinding: vi.fn(() => binding),
    installSendHook: vi.fn(() => binding),
  }
}

function testProtocolElements(part: DirectMessagePart): MsgElement[] {
  if (part.kind === 'text') return [{
    elementType: 1, elementId: '',
    textElement: { content: part.text, atType: 0, atUid: '', atTinyId: '', atNtUid: '' },
  }]
  if (part.kind === 'mention') return [{
    elementType: 1, elementId: '',
    textElement: {
      content: part.text, atType: 2, atUid: part.userUin ?? '', atTinyId: '', atNtUid: part.userUid,
    },
  }]
  if (part.kind === 'face') return [{
    elementType: 6, elementId: '', faceElement: {
      faceIndex: part.face.faceId, faceText: '[表情]', faceType: part.face.faceType,
      packId: part.face.packId, stickerId: part.face.stickerId,
      sourceType: part.face.sourceType, stickerType: part.face.stickerType,
      resultId: part.face.resultId,
    },
  }]
  if (part.kind === 'market-face') return [{
    elementType: 11, elementId: '', marketFaceElement: {
      itemType: 6, faceInfo: 1, emojiPackageId: part.face.packageId,
      subType: 3, mediaType: 0, imageWidth: part.face.width ?? 300,
      imageHeight: part.face.height ?? 300, faceName: part.face.name,
      emojiId: part.face.emojiId, key: part.face.key,
    },
  }]
  if (part.kind === 'reply') return [{
    elementType: 7, elementId: '', replyElement: {
      replayMsgId: part.reply.messageId, replayMsgSeq: part.reply.sequence,
      replyMsgClientSeq: part.reply.clientSequence, replyMsgTime: part.reply.time ? String(part.reply.time) : undefined,
      sourceMsgTextElems: [], replyMsgRevokeType: 0,
      sourceMsgIsIncPic: false, sourceMsgExpired: false,
    },
  }]
  if (part.kind === 'image') return [{
    elementType: 2, elementId: 'image-element', picElement: {
      fileName: part.upload.fileUuid, fileSize: '0', fileUuid: part.upload.fileUuid,
      fileSubId: '', md5HexStr: '', picWidth: 0, picHeight: 0,
    },
  }]
  if (part.kind === 'video') return [{
    elementType: 5, elementId: 'video-element', videoElement: {
      fileName: part.upload.fileUuid, fileSize: '0', fileUuid: part.upload.fileUuid,
      filePath: '', fileTime: 0, fileFormat: 2, thumbPath: new Map(),
    },
  }]
  return [{
    elementType: 3, elementId: 'file-element', fileElement: {
      fileName: part.spec.name, fileSize: String(part.spec.size), filePath: '',
      fileUuid: part.upload.fileUuid, fileSubId: '', fileMd5: part.spec.md5,
      fileSha: part.spec.sha1, fileSha3: '', file10MMd5: part.spec.file10MMd5,
    },
  }]
}

function fixture() {
  let msgHandlers: Record<string, (...args: unknown[]) => unknown> = {}
  let buddyHandlers: Record<string, (...args: unknown[]) => unknown> = {}
  const buddyHandlerHistory: Array<Record<string, (...args: unknown[]) => unknown>> = []
  let profileHandlers: Record<string, (...args: unknown[]) => unknown> = {}
  let groupHandlers: Record<string, (...args: unknown[]) => unknown> = {}
  const groupHandlerHistory: Array<Record<string, (...args: unknown[]) => unknown>> = []
  let searchHandlers: Record<string, (...args: unknown[]) => unknown> = {}
  let avsdkHandlers: Record<string, (...args: unknown[]) => unknown> = {}
  let avsdkAvailable = true
  const profileInfos = new Map<string, {
    uid: string, uin: string, nick: string, remark: string, avatarUrl: string
    longNick?: string
    coreInfo?: { nick?: string, avatarUrl?: string, longNick?: string }
    baseInfo?: { longNick?: string }
  }>([['self', { uid: 'self', uin: '10000', nick: 'Self', remark: '', avatarUrl: '' }]])
  let avatarPath = avatarFixturePath
  const forceDownloadAvatar = vi.fn(async () => ({ result: 0, errMsg: '' }))
  const avatarUrls = new Map<string, string>()
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
    generateMsgUniqueId: vi.fn(() => 'generated-m1'),
    getMsgUniqueId: vi.fn(() => 'm1'),
    sendSsoCmdReqByContend: vi.fn<NonNullable<KernelMsgService['sendSsoCmdReqByContend']>>(),
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
    setSpecificMsgReadAndReport: vi.fn(async () => ({ result: 0, errMsg: '' })),
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
    getRichMediaFilePathForGuild: vi.fn<NonNullable<KernelMsgService['getRichMediaFilePathForGuild']>>(() => ''),
    getMsgsBySeqAndCount: vi.fn(async () => ({ result: 0, errMsg: '', msgList: [message] })),
    getMsgsByMsgId: vi.fn(async () => ({ result: 0, errMsg: '', msgList: [message] })),
    getSourceOfReplyMsg: vi.fn(async () => ({ result: 0, errMsg: '', msgList: [] as MsgRecord[] })),
    getSourceOfReplyMsgByClientSeqAndTime: vi.fn(async () => ({
      result: 0, errMsg: '', msgList: [] as MsgRecord[],
    })),
    setMsgEmojiLikes: vi.fn(async () => ({ result: 0, errMsg: '' })),
    getMsgEmojiLikesList: vi.fn<NonNullable<KernelMsgService['getMsgEmojiLikesList']>>(async () => ({
      result: 0, errMsg: '', emojiLikesList: [], cookie: '', isLastPage: true, isFirstPage: true,
    })),
    fetchFavEmojiList: vi.fn<NonNullable<KernelMsgService['fetchFavEmojiList']>>(async () => ({
      result: 0, errMsg: '', emojiInfoList: [],
    })),
    addFavEmoji: vi.fn<NonNullable<KernelMsgService['addFavEmoji']>>(async () => ({
      result: 0, errMsg: '', isExist: 0,
    })),
    deleteFavEmoji: vi.fn(async () => ({ result: 0, errMsg: '' })),
    fetchMarketEmoticonList: vi.fn<NonNullable<KernelMsgService['fetchMarketEmoticonList']>>(async () => ({
      result: 0, errMsg: '', marketEmoticonInfo: { roamEmojiTab: {
        timesTamp: 1, segmentFlag: -1, ordinaryTabinfoList: [], magicTabinfoList: [],
        smallTabinfoList: [], epIds: [],
      } },
    })),
    fetchBottomEmojiTableList: undefined as import('./kernel-types.js').KernelMsgService['fetchBottomEmojiTableList'],
    fetchMarketEmoticonShowImage: vi.fn(async () => ({ result: 0, errMsg: '' })),
    fetchMarketEmotionJsonFile: undefined as KernelMsgService['fetchMarketEmotionJsonFile'],
    fetchMarketEmoticonAioImage: vi.fn(async () => ({ result: 0, errMsg: '' })),
    getMarketEmoticonPath: vi.fn<NonNullable<KernelMsgService['getMarketEmoticonPath']>>(() => new Map()),
    getMarketEmoticonEncryptKeys: vi.fn(async () => ({ result: 0, errMsg: '', encryptKeyMap: new Map() })),
    fetchMarketEmoticonAuthDetail: vi.fn(async () => ({ result: 0, errMsg: '' })),
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
      buddyHandlerHistory.push(buddyHandlers)
      return 'buddy-listener'
    }), removeKernelBuddyListener: vi.fn(),
    getBuddyList: vi.fn(async () => ({ result: 0, errMsg: '' })),
    getBuddyReq: vi.fn<NonNullable<KernelBuddyService['getBuddyReq']>>(async () => ({ buddyReqs: [] })),
    getDoubtBuddyReq: undefined as KernelBuddyService['getDoubtBuddyReq'],
    approvalFriendRequest: vi.fn<NonNullable<KernelBuddyService['approvalFriendRequest']>>(async () => ({ result: 0, errMsg: '' })),
    getBuddyNick: vi.fn((uids: string[]) => new Map(uids.map((uid) => [uid, `nick-${uid}`]))),
    getBuddyRemark: vi.fn(() => new Map<string, string>()),
    getAvatarUrl: vi.fn((uids: string[], sizeType: number) => {
      expect(sizeType).toBe(2)
      return new Map(uids.flatMap((uid) => avatarUrls.has(uid) ? [[uid, avatarUrls.get(uid)!]] : []))
    }),
  }
  const profile = {
    addKernelProfileListener: vi.fn((listener: { handlers?: typeof profileHandlers }) => {
      profileHandlers = listener.handlers ?? listener as unknown as typeof profileHandlers
      return 'profile-listener'
    }),
    removeKernelProfileListener: vi.fn(),
    getUserSimpleInfo: vi.fn(async (_force: boolean, uids: string[]) => {
      queueMicrotask(() => profileHandlers.onProfileSimpleChanged?.(new Map(uids.map((uid) => {
        const { baseInfo: _baseInfo, ...simple } = profileInfos.get(uid)
          ?? { uid, uin: '', nick: '', remark: '', avatarUrl: '' }
        return [uid, simple]
      }))))
      return { result: 0, errMsg: '' }
    }),
    getCoreAndBaseInfo: vi.fn(async (_callFrom: string, uids: string[]) => new Map(uids.map((uid) => {
      const info = profileInfos.get(uid) ?? { uid, uin: '', nick: '', remark: '', avatarUrl: '' }
      return [uid, {
        uid: info.uid,
        uin: info.uin,
        coreInfo: { nick: info.coreInfo?.nick || info.nick, avatarUrl: info.coreInfo?.avatarUrl || info.avatarUrl },
        baseInfo: info.baseInfo,
      }]
    }))),
  }
  const group = {
    addKernelGroupListener: vi.fn((listener: { handlers?: typeof groupHandlers }) => {
      groupHandlers = listener.handlers ?? listener as unknown as typeof groupHandlers
      groupHandlerHistory.push(groupHandlers)
      return 'group-listener'
    }), removeKernelGroupListener: vi.fn(),
    getGroupList: vi.fn(async () => ({ result: 0, errMsg: '' })),
    getSingleScreenNotifies: vi.fn<NonNullable<KernelGroupService['getSingleScreenNotifies']>>(async () => ({ notifies: [] })),
    operateSysNotify: vi.fn<NonNullable<KernelGroupService['operateSysNotify']>>(async () => ({ result: 0, errMsg: '' })),
    getGroupDetailInfo: vi.fn<NonNullable<KernelGroupService['getGroupDetailInfo']>>(async () => ({ result: 0, errMsg: '' })),
    getGroupMsgMask: vi.fn<NonNullable<KernelGroupService['getGroupMsgMask']>>(async () => {
      queueMicrotask(() => groupHandlers.onGroupsMsgMaskResult?.([]))
      return { result: 0, errMsg: 'success' }
    }),
    setGroupMsgMask: vi.fn<NonNullable<KernelGroupService['setGroupMsgMask']>>(async () => ({ result: 0, errMsg: 'success' })),
    modifyMemberRole: vi.fn<NonNullable<KernelGroupService['modifyMemberRole']>>(async () => ({ result: 0, errMsg: 'success' })),
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
  const avsdk = {
    addKernelAVSDKListener: vi.fn((listener: { handlers?: typeof avsdkHandlers }) => {
      avsdkHandlers = listener.handlers ?? listener as unknown as typeof avsdkHandlers
      return 'avsdk-listener'
    }),
    removeKernelAVSDKListener: vi.fn(),
  }
  const richMedia = {
    getGroupFileList: vi.fn<NonNullable<KernelRichMediaService['getGroupFileList']>>(async () => {
      queueMicrotask(() => msgHandlers.onGroupFileInfoUpdate?.({
        retCode: 0, retMsg: '', clientWording: '', isEnd: true,
        item: [], allFileCount: 0, nextIndex: 0, reqId: 1,
      }))
      return { result: 0, errMsg: '' }
    }),
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
    NodeIAVSDKListener: Listener,
  } as unknown as KernelModule
  const session = {
    getMsgService: () => msg,
    getRecentContactService: () => recent,
    getBuddyService: () => buddy,
    getProfileService: () => profile,
    getGroupService: () => group,
    getSearchService: () => search,
    getAVSDKService: vi.fn(() => avsdkAvailable ? avsdk : undefined),
    getRichMediaService: () => richMedia,
    getAvatarService: () => ({
      getAvatarPath: () => avatarPath, forceDownloadAvatar,
      getGroupAvatarPath: () => avatarPath, getConfGroupAvatarPath: () => '',
      forceDownloadGroupAvatar: async () => ({ result: 0, errMsg: '' }),
    }),
    getUixConvertService: () => uix,
  } as unknown as KernelSession
  const imageUpload = vi.spyOn(QQPacketClient.prototype, 'uploadImage')
    .mockImplementation(async (_chat, _peer, _self, spec, source) => {
      const chunks: Buffer[] = []
      for await (const chunk of source) chunks.push(Buffer.from(chunk))
      sentBodies.push(Buffer.concat(chunks))
      return {
        fileUuid: spec.name, ipv4s: [], msgInfo: Buffer.from('msg-info'), msgInfoBodies: [],
      }
    })
  const fileUpload = vi.spyOn(QQPacketClient.prototype, 'uploadFile')
    .mockImplementation(async (_chat, _peer, _selfUin, _selfUid, spec, source) => {
      const chunks: Buffer[] = []
      for await (const chunk of source) chunks.push(Buffer.from(chunk))
      sentBodies.push(Buffer.concat(chunks))
      return { fileUuid: spec.name, fileHash: 'file-hash', exists: true, commandId: 95 }
    })
  const protocolSend = vi.spyOn(QQPacketClient.prototype, 'sendDirectMessage')
    .mockImplementation(async (chatType, peerUid, peerUin, parts) => {
      const elements = parts.flatMap(testProtocolElements)
      queueMicrotask(() => msgHandlers.onAddSendMsg?.({
        ...message, chatType, peerUid, peerUin, sendStatus: 2, elements,
      }))
      return { sequence: 1n, clientSequence: 2n, sendTime: 3 }
    })
  const groupFilePublish = vi.spyOn(QQPacketClient.prototype, 'publishGroupFile')
    .mockImplementation(async (peerUin, fileUuid) => {
      queueMicrotask(() => msgHandlers.onAddSendMsg?.({
        ...message, chatType: 2, peerUid: peerUin, peerUin, sendStatus: 2,
        elements: [{
          elementType: 3, elementId: 'file-element', fileElement: {
            fileName: fileUuid, fileSize: '4', filePath: '', fileUuid, fileSubId: '',
            fileMd5: '', fileSha: '', fileSha3: '', file10MMd5: '',
          },
        }],
      }))
      return { published: true }
    })
  const flashApplyFileset = vi.spyOn(QQPacketClient.prototype, 'applyFlashTransferFileset')
    .mockResolvedValue({
      fileSetId: 'fileset-1', uploadKey: 'fileset-1',
      shareLink: 'https://qfile.qq.com/q/share-code', expiresAt: 2_000_000_000_000,
    })
  const flashCommitFiles = vi.spyOn(QQPacketClient.prototype, 'commitFlashTransferFiles').mockResolvedValue()
  const flashCompleteFileset = vi.spyOn(QQPacketClient.prototype, 'completeFlashTransferFileset').mockResolvedValue()
  const flashPrepareUpload = vi.spyOn(QQPacketClient.prototype, 'prepareFlashTransferUpload')
    .mockResolvedValue({ fileId: 'server-file-id', uploadTime: 1, expireLeftTime: 2 })
  const flashUploadFile = vi.spyOn(QQPacketClient.prototype, 'uploadFlashTransferFile')
    .mockImplementation(async (_file, _prepared, source) => { for await (const _chunk of source) {} })
  const flashApplyUpload = vi.spyOn(QQPacketClient.prototype, 'applyFlashTransferUpload').mockResolvedValue()
  const flashSetReady = vi.spyOn(QQPacketClient.prototype, 'setFlashTransferFilesetReady').mockResolvedValue()
  return {
    kernel, session, msg, recent, buddy, profile, group, search, avsdk, richMedia, uix, message, sentBodies,
    forceDownloadAvatar,
    imageUpload, fileUpload, protocolSend, groupFilePublish,
    flashApplyFileset, flashCommitFiles, flashCompleteFileset, flashPrepareUpload,
    flashUploadFile, flashApplyUpload, flashSetReady,
    emitMessages(records: MsgRecord[]) {
      return msgHandlers.onMsgInfoListUpdate?.(records)
    },
    emitReceived(records: MsgRecord[]) {
      msgHandlers.onRecvMsg?.(records)
    },
    emitS2C(bytes: Uint8Array) {
      return msgHandlers.onRecvS2CMsg?.([...bytes])
    },
    emitSent(record: MsgRecord) {
      return msgHandlers.onAddSendMsg?.(record)
    },
    emitRecall(chatType: number, peerUid: string, msgSeq: string) {
      msgHandlers.onMsgRecall?.(chatType, peerUid, msgSeq)
    },
    emitDelete(chatType: number, peerUid: string, ids: string[]) {
      msgHandlers.onMsgDelete?.({ chatType, peerUid }, ids)
    },
    emitBuddyList(categories: Array<{ buddyList: unknown[] }>) {
      buddyHandlers.onBuddyListChange?.(categories)
    },
    emitBuddyInfo(infos: Map<string, unknown>) {
      buddyHandlers.onBuddyInfoChange?.(infos)
    },
    emitBuddyRequests(buddyReqs: unknown[]) {
      return buddyHandlers.onBuddyReqChange?.({ unreadNums: buddyReqs.length, buddyReqs })
    },
    emitDoubtBuddyRequests(payload: { reqId: string, cookie?: string, doubtList: unknown[] }) {
      return buddyHandlers.onDoubtBuddyReqChange?.(payload)
    },
    emitHistoricalBuddyRequests(index: number, buddyReqs: unknown[]) {
      return buddyHandlerHistory[index]?.onBuddyReqChange?.({ unreadNums: buddyReqs.length, buddyReqs })
    },
    setProfile(info: {
      uid: string, uin: string, nick: string, remark: string, avatarUrl: string
      longNick?: string
      coreInfo?: { nick?: string, avatarUrl?: string, longNick?: string }
      baseInfo?: { longNick?: string }
    }) {
      profileInfos.set(info.uid, info)
    },
    emitGroupList(groups: Array<{
      groupCode: string
      groupName: string
      remarkName?: string
      memberCount?: number
      memberRole?: number
      cmdUinMsgMask?: number
    }>) {
      groupHandlers.onGroupListUpdate?.(1, groups)
    },
    emitGroupRequests(doubt: boolean, notifies: unknown[], nextStartSeq = '') {
      return groupHandlers.onGroupSingleScreenNotifies?.(doubt, nextStartSeq, notifies)
    },
    emitHistoricalGroupRequests(index: number, doubt: boolean, notifies: unknown[], nextStartSeq = '') {
      return groupHandlerHistory[index]?.onGroupSingleScreenNotifies?.(doubt, nextStartSeq, notifies)
    },
    emitGroupRequestPayload(doubt: boolean, payload: unknown) {
      return groupHandlers.onGroupSingleScreenNotifies?.(doubt, payload)
    },
    emitGroupRequestUpdate(doubt: boolean, notifies: unknown[]) {
      return groupHandlers.onGroupNotifiesUpdated?.(doubt, notifies)
    },
    emitGroupMsgMasks(masks: Array<{ groupCode?: string, msgMask?: number }>) {
      groupHandlers.onGroupsMsgMaskResult?.(masks)
    },
    emitGroupDetail(group: {
      groupCode: string
      groupName: string
      remarkName?: string
      memberCount?: number
      memberRole?: number
    }) {
      groupHandlers.onGroupDetailInfoChange?.(group)
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
    emitGroupFiles(result: import('./kernel-types.js').GroupFileListResult) {
      msgHandlers.onGroupFileInfoUpdate?.(result)
    },
    emitAVSDK(callback: string, ...args: unknown[]) {
      if (callback === 'OnInviteActionToAVSDK' && !types.isProxy(args[0]) && args[0] && typeof args[0] === 'object') {
        const invite = args[0]
        const relation = Object.getOwnPropertyDescriptor(invite, 'relation_id')
        const type = Object.getOwnPropertyDescriptor(invite, 'invite_type')
        const from = Object.getOwnPropertyDescriptor(invite, 'from_uid')
        if (typeof relation?.value === 'string' && typeof type?.value === 'number' && (!from || typeof from.value === 'string')) {
          const payload = typeof args[2] === 'string' ? args[2] : Buffer.isBuffer(args[2]) ? args[2].toString('base64') : 'test tuple payload'
          return avsdkHandlers[callback]?.({
            relation_id: relation.value, invite_type: type.value, from_uid: typeof from?.value === 'string' ? from.value : 'uid-1715311957',
          }, 0, payload)
        }
      }
      return avsdkHandlers[callback]?.(...args)
    },
    emitLegacyAVSDK(callback: string, ...args: unknown[]) {
      return avsdkHandlers[callback]?.(...args)
    },
    setAVSDKAvailable(value: boolean) {
      avsdkAvailable = value
    },
    setAvatarPath(path: string) {
      avatarPath = path
    },
    setAvatarUrl(uid: string, url: string) {
      avatarUrls.set(uid, url)
    },
  }
}

async function readStream(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks)
}

async function nextCallSignal(events: AsyncIterator<QQEvent>): Promise<Extract<QQEvent, { type: 'call-signal' }>> {
  for (;;) {
    const event = await events.next()
    if (event.done) throw new Error('event subscription closed before call signal')
    if (event.value.type === 'call-signal') return event.value
  }
}

describe('QQKernelBridge', () => {
  const tempPaths: string[] = []
  afterEach(async () => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
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
      id: 'm1', parts: [{ type: 'text', text: 'hello' }],
    })
    expect(f.msg.getMsgsByMsgId).toHaveBeenCalledWith(expect.objectContaining({
      chatType: 1, peerUid: 'uid-1715311957',
    }), ['m1'])
    const history = await bridge.getHistory(dialogs.conversations[0])
    expect(history.messages[0]).toMatchObject({ id: 'm1', parts: [{ type: 'text', text: 'hello' }] })
    expect(f.msg.getLatestDbMsgs).toHaveBeenCalledWith(expect.objectContaining({
      chatType: 1, peerUid: 'uid-1715311957',
    }), 50)
    const sent = await bridge.send({
      conversationId: dialogs.conversations[0].id, text: 'hello', originRequestId: 'relay-send-1',
    }, Readable.from([]))
    expect(sent).toMatchObject({ id: 'm1', originRequestId: 'relay-send-1' })
    expect(sent.sourceIds).toBeUndefined()
    expect(f.msg.getMsgUniqueId).not.toHaveBeenCalled()
    expect(f.protocolSend).toHaveBeenCalledWith(
      1, 'uid-1715311957', '1715311957', [{ kind: 'text', text: 'hello' }], 'self',
    )
    expect(f.msg.sendMsg).not.toHaveBeenCalled()
  })

  it('rejects a flash-transfer stream whose framed bytes do not match the declared file size', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'qqnt-flash-unit-'))
    tempPaths.push(directory)
    const f = fixture()
    const bridge = new QQKernelBridge({ tempPath: directory })
    bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: directory })

    await expect(bridge.createFlashTransfer({
      framing: 'length-prefixed-v1', files: [{ source: 'upload', name: 'short.txt', size: 5 }],
    }, Readable.from(framedUpload(Buffer.from('abc'))))).rejects.toThrow(/size mismatch/)
    expect(f.flashApplyFileset).not.toHaveBeenCalled()
  })

  it('rejects QQ flash-transfer reuse without remote MD5 and SHA-1 identity', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'qqnt-flash-unit-'))
    tempPaths.push(directory)
    const f = fixture()
    const bridge = new QQKernelBridge({ tempPath: join(directory, 'bridge-cache') })
    bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: directory })

    await expect(bridge.createFlashTransfer({
      framing: 'length-prefixed-v1',
      files: [{
        source: 'qq-media', name: 'outside.bin', size: 7,
        locator: {
          messageId: 'm1', elementId: 'e1', chatType: 1, peerUid: 'friend',
          kind: 'file', fileName: 'outside.bin', filePath: 'C:\\QQ\\cache\\outside.bin',
        },
      }],
    }, Readable.from([]))).rejects.toThrow(/no reusable MD5\/SHA-1 identity/)
    expect(f.flashApplyFileset).not.toHaveBeenCalled()
  })

  it('uses QQ little-endian intermediate SHA-1 states for multi-slice flash uploads', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'qqnt-flash-sha1-'))
    tempPaths.push(directory)
    const f = fixture()
    f.flashPrepareUpload.mockResolvedValue({
      rkey: 'slice-rkey', fileId: 'server-file-id', uploadTime: 1, expireLeftTime: 2,
    })
    let capturedState: Buffer[] = []
    f.flashUploadFile.mockImplementation(async (_file, _prepared, source, state) => {
      capturedState = state.map(Buffer.from)
      for await (const _chunk of source) {}
    })
    const bridge = new QQKernelBridge({ tempPath: directory })
    bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: directory })
    const content = Buffer.from('crossgram-pure-protocol-flash-'.repeat(60_000)).subarray(0, 1_468_006)
    const first = content.subarray(0, 1024 * 1024)
    const second = content.subarray(first.length)
    const frame = (chunk: Buffer) => {
      const header = Buffer.alloc(4)
      header.writeUInt32BE(chunk.length)
      return Buffer.concat([header, chunk])
    }

    await bridge.createFlashTransfer({
      framing: 'length-prefixed-v1',
      files: [{ source: 'upload', name: 'multi.bin', size: content.length }],
    }, Readable.from(Buffer.concat([frame(first), frame(second), Buffer.alloc(4)])))

    expect(capturedState.map((value) => value.toString('hex'))).toEqual([
      'e78253d3828f255c741fdc97a9c929dd5ae0a724',
      createHash('sha1').update(content).digest('hex'),
    ])
  })

  it('leaves the static group-join wrapper probe off without reading native candidates', async () => {
    const f = fixture()
    const candidates = [
      'getGroupInfoForJoinGroup', 'queryJoinGroupCanNoVerify', 'reqToJoinGroup', 'joinGroup',
    ] as const
    let candidateReads = 0
    const trackedGroup = new Proxy(f.group, {
      get(target, property, receiver) {
        if (candidates.includes(property as typeof candidates[number])) candidateReads++
        return Reflect.get(target, property, receiver)
      },
    })
    ;(f.session as unknown as { getGroupService: () => KernelGroupService }).getGroupService =
      () => trackedGroup as KernelGroupService
    const bridge = new QQKernelBridge()
    bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: '/tmp' })

    await expect(bridge.getGroupJoinContractProbe()).resolves.toEqual({
      enabled: false,
      surfaceComplete: false,
      contractVerified: false,
      writeEnabled: false,
      methods: [],
    })
    expect(candidateReads).toBe(0)
  })

  it.runIf(process.platform === 'linux')('probes only an explicit inert wrapper fixture without reading native candidates', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'qqnt-group-join-wrapper-'))
    tempPaths.push(directory)
    const path = join(directory, 'wrapper.node')
    const wrapper = Buffer.from([
      'getGroupInfoForJoinGroup needs 0 arguments',
      'queryJoinGroupCanNoVerify needs 4 arguments',
      'reqToJoinGroup needs 2 arguments',
      'joinGroup needs 3 arguments',
      'unexpectedNativeMethod needs 9 arguments',
    ].join('\n'), 'ascii')
    await writeFile(path, wrapper)
    vi.stubEnv('QQNT_BRIDGE_GROUP_JOIN_CONTRACT_PROBE', '1')
    vi.stubEnv('QQNT_BRIDGE_GROUP_JOIN_WRAPPER_PATH', path)
    const f = fixture()
    const candidates = [
      'getGroupInfoForJoinGroup', 'queryJoinGroupCanNoVerify', 'reqToJoinGroup', 'joinGroup',
    ] as const
    let candidateReads = 0
    const trackedGroup = new Proxy(f.group, {
      get(target, property, receiver) {
        if (candidates.includes(property as typeof candidates[number])) candidateReads++
        return Reflect.get(target, property, receiver)
      },
    })
    ;(f.session as unknown as { getGroupService: () => KernelGroupService }).getGroupService =
      () => trackedGroup as KernelGroupService
    const bridge = new QQKernelBridge()
    bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: '/tmp' })

    const probe = await bridge.getGroupJoinContractProbe()
    expect(probe).toMatchObject({
      enabled: true,
      surfaceComplete: true,
      contractVerified: false,
      writeEnabled: false,
      methods: [
        { name: 'getGroupInfoForJoinGroup', present: true, argumentCount: 0 },
        { name: 'queryJoinGroupCanNoVerify', present: true, argumentCount: 4 },
        { name: 'reqToJoinGroup', present: true, argumentCount: 2 },
        { name: 'joinGroup', present: true, argumentCount: 3 },
      ],
      wrapperIdentity: {
        sha256: createHash('sha256').update(wrapper).digest('hex'),
        size: wrapper.length,
      },
      hostRuntime: { node: expect.any(String) },
    })
    expect(JSON.stringify(probe)).not.toContain(path)
    expect(JSON.stringify(probe)).not.toContain('unexpectedNativeMethod')
    expect(candidateReads).toBe(0)
  })

  it.runIf(process.platform === 'linux')('returns detached static wrapper probe snapshots and fails closed for invalid fixtures', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'qqnt-group-join-wrapper-'))
    tempPaths.push(directory)
    const validPath = join(directory, 'wrapper.node')
    const valid = Buffer.from(GROUP_JOIN_WRAPPER_MARKERS, 'ascii')
    await writeFile(validPath, valid)
    vi.stubEnv('QQNT_BRIDGE_GROUP_JOIN_CONTRACT_PROBE', '1')
    vi.stubEnv('QQNT_BRIDGE_GROUP_JOIN_WRAPPER_PATH', validPath)
    const bridge = new QQKernelBridge()
    const first = await bridge.getGroupJoinContractProbe()
    first.methods[0].present = false
    first.wrapperIdentity!.sha256 = 'mutated'
    first.hostRuntime!.node = 'mutated'
    const second = await bridge.getGroupJoinContractProbe()
    expect(second.methods[0].present).toBe(true)
    expect(second.wrapperIdentity).toEqual({
      sha256: createHash('sha256').update(valid).digest('hex'), size: valid.length,
    })
    expect(second.hostRuntime?.node).toBe(process.versions.node)

    const missingMarkerPath = join(directory, 'missing-marker.node')
    await writeFile(missingMarkerPath, 'getGroupInfoForJoinGroup')
    vi.stubEnv('QQNT_BRIDGE_GROUP_JOIN_WRAPPER_PATH', missingMarkerPath)
    const missingMarker = await new QQKernelBridge().getGroupJoinContractProbe()
    expect(missingMarker).toMatchObject({ enabled: true, surfaceComplete: false })
    expect(missingMarker.wrapperIdentity).toBeDefined()

    vi.stubEnv('QQNT_BRIDGE_GROUP_JOIN_WRAPPER_PATH', directory)
    await expect(new QQKernelBridge().getGroupJoinContractProbe()).resolves.toMatchObject({
      enabled: true, surfaceComplete: false, methods: [],
    })

    const oversizedPath = join(directory, 'oversized.node')
    await writeFile(oversizedPath, Buffer.alloc(32 * 1024 * 1024 + 1))
    vi.stubEnv('QQNT_BRIDGE_GROUP_JOIN_WRAPPER_PATH', oversizedPath)
    await expect(new QQKernelBridge().getGroupJoinContractProbe()).resolves.toMatchObject({
      enabled: true, surfaceComplete: false, methods: [],
    })
  })

  it.runIf(process.platform !== 'linux')('fails closed for explicit wrapper fixtures outside Linux', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'qqnt-group-join-wrapper-'))
    tempPaths.push(directory)
    const path = join(directory, 'wrapper.node')
    await writeFile(path, GROUP_JOIN_WRAPPER_MARKERS, 'ascii')
    vi.stubEnv('QQNT_BRIDGE_GROUP_JOIN_CONTRACT_PROBE', '1')
    vi.stubEnv('QQNT_BRIDGE_GROUP_JOIN_WRAPPER_PATH', path)

    await expect(new QQKernelBridge().getGroupJoinContractProbe()).resolves.toEqual({
      enabled: true,
      surfaceComplete: false,
      contractVerified: false,
      writeEnabled: false,
      methods: [],
    })
  })

  it.runIf(process.platform === 'linux')('uses a nonblocking no-follow wrapper handle and single-flight cache', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'qqnt-group-join-wrapper-linux-'))
    tempPaths.push(directory)
    vi.stubEnv('QQNT_BRIDGE_GROUP_JOIN_CONTRACT_PROBE', '1')
    const within = <T>(promise: Promise<T>) => Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => setTimeout(() => reject(new Error('wrapper probe timed out')), 1_000)),
    ])

    const fifo = join(directory, 'wrapper.fifo')
    await execFileAsync('mkfifo', [fifo])
    vi.stubEnv('QQNT_BRIDGE_GROUP_JOIN_WRAPPER_PATH', fifo)
    await expect(within(new QQKernelBridge().getGroupJoinContractProbe())).resolves.toMatchObject({
      enabled: true, surfaceComplete: false, methods: [],
    })

    const fifoLink = join(directory, 'wrapper-fifo-link.node')
    await symlink(fifo, fifoLink)
    vi.stubEnv('QQNT_BRIDGE_GROUP_JOIN_WRAPPER_PATH', fifoLink)
    await expect(within(new QQKernelBridge().getGroupJoinContractProbe())).resolves.toMatchObject({
      enabled: true, surfaceComplete: false, methods: [],
    })

    const regular = join(directory, 'wrapper.node')
    await writeFile(regular, GROUP_JOIN_WRAPPER_MARKERS, 'ascii')
    const regularLink = join(directory, 'wrapper-regular-link.node')
    await symlink(regular, regularLink)
    vi.stubEnv('QQNT_BRIDGE_GROUP_JOIN_WRAPPER_PATH', regularLink)
    await expect(within(new QQKernelBridge().getGroupJoinContractProbe())).resolves.toMatchObject({
      enabled: true, surfaceComplete: false, methods: [],
    })

    vi.stubEnv('QQNT_BRIDGE_GROUP_JOIN_WRAPPER_PATH', regular)
    const probes = await Promise.all(Array.from({ length: 8 }, () => new QQKernelBridge().getGroupJoinContractProbe()))
    expect(probes).toEqual(Array.from({ length: 8 }, () => expect.objectContaining({
      enabled: true, surfaceComplete: true,
    })))
    await rm(regular)
    // A completed once-per-process cache must serve concurrent callers without
    // opening or reading the now-absent wrapper again.
    await expect(Promise.all(Array.from({ length: 8 }, () => new QQKernelBridge().getGroupJoinContractProbe())))
      .resolves.toEqual(Array.from({ length: 8 }, () => expect.objectContaining({
        enabled: true, surfaceComplete: true,
      })))
  })

  it('emits an incoming call signal for an uncached direct peer', async () => {
    const f = fixture()
    f.recent.getRecentContactInfos.mockResolvedValue({ result: 0, errMsg: '', relation: [] })
    const bridge = new QQKernelBridge()
    const subscription = bridge.subscribe()
    const events = subscription[Symbol.asyncIterator]()
    try {
      bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: '/tmp' })
      f.emitAVSDK('OnInviteActionToAVSDK', {
        relation_id: '20001', invite_type: 1, from_uid: 'fixture-incoming-peer',
      }, 0, 'fixture-call-payload')

      await expect(nextCallSignal(events)).resolves.toMatchObject({
        signal: 'incoming',
        conversation: {
          id: 'fixture-incoming-peer', kind: 'direct', peerUid: 'fixture-incoming-peer', peerUin: '20001',
        },
      })
    } finally {
      bridge.unsubscribe(subscription)
      bridge.detach()
    }
  })

  it('controls only the exact active call through QQ renderer handlers', async () => {
    const f = fixture()
    const control = vi.fn().mockResolvedValue(undefined)
    const bridge = new QQKernelBridge({ callController: { control } })
    const subscription = bridge.subscribe()
    const events = subscription[Symbol.asyncIterator]()
    try {
      bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: '/tmp' })
      f.emitAVSDK('OnInviteActionToAVSDK', {
        relation_id: '1715311957', invite_type: 1, from_uid: 'uid-1715311957',
      }, 0, 'renderer-control')
      const incoming = await nextCallSignal(events)

      await expect(bridge.controlCall('stale-call', 'accept')).rejects
        .toThrow('not authorized')
      expect(control).not.toHaveBeenCalled()
      await expect(bridge.controlCall(incoming.callId, 'accept')).resolves.toBeUndefined()
      expect(control).toHaveBeenCalledOnce()
      expect(control).toHaveBeenCalledWith('accept')
      await expect(nextCallSignal(events)).resolves.toMatchObject({
        signal: 'accept-requested', callId: incoming.callId,
      })

      await expect(bridge.controlCall(incoming.callId, 'hangup')).resolves.toBeUndefined()
      expect(control).toHaveBeenLastCalledWith('hangup')
      await expect(nextCallSignal(events)).resolves.toMatchObject({
        signal: 'logout-requested', callId: incoming.callId,
      })
    } finally {
      bridge.unsubscribe(subscription)
      bridge.detach()
    }
  })

  it.each([
    'QQNT_BRIDGE_AVSDK_TAP',
    'QQNT_BRIDGE_AVSDK_RAW',
    'QQNT_BRIDGE_AVSDK_ACTION_PROBE',
  ])('ignores %s while retaining the safe incoming-call projection', async (flag) => {
    vi.stubEnv(flag, '1')
    const f = fixture()
    const bridge = new QQKernelBridge()
    const subscription = bridge.subscribe()
    const events = subscription[Symbol.asyncIterator]()
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: '/tmp' })
      expect(f.avsdk.addKernelAVSDKListener).toHaveBeenCalledOnce()
      f.emitAVSDK('OnInviteActionToAVSDK', {
        relation_id: '1715311957', invite_type: 1, from_uid: 'uid-1715311957',
      }, 0, '')
      await expect(nextCallSignal(events)).resolves.toMatchObject({
        type: 'call-signal', signal: 'incoming', media: 'voice',
      })
      expect((subscription as unknown as { values: QQEvent[] }).values).toEqual([])
      const messages = consoleLog.mock.calls.map(([message]) => String(message)).join('\n')
      expect(messages).not.toContain('native-avsdk')
      expect(messages).not.toContain('avsdk-action')
    } finally {
      bridge.unsubscribe(subscription)
      bridge.detach()
    }
  })

  it('retries listener registration when the AVSDK service becomes available later', async () => {
    vi.useFakeTimers()
    const f = fixture()
    f.setAVSDKAvailable(false)
    const bridge = new QQKernelBridge()
    try {
      bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: '/tmp' })
      expect(f.avsdk.addKernelAVSDKListener).not.toHaveBeenCalled()
      f.setAVSDKAvailable(true)
      await vi.advanceTimersByTimeAsync(250)
      expect(f.avsdk.addKernelAVSDKListener).toHaveBeenCalledOnce()
    } finally {
      bridge.detach()
      vi.useRealTimers()
    }
  })

  it('confirms private packet sends by the returned client sequence without a listener callback', async () => {
    const f = fixture()
    f.protocolSend.mockResolvedValueOnce({ sequence: 0n, clientSequence: 1684n, sendTime: 3 })
    f.msg.getMsgsBySeqAndCount.mockResolvedValueOnce({
      result: 0, errMsg: '', msgList: [{ ...f.message, msgSeq: '1684' }],
    })
    const bridge = new QQKernelBridge()
    bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: '/tmp' })

    const sent = await bridge.send({
      conversationId: 'uid-1715311957', text: 'hello', originRequestId: 'relay-private-sequence',
    }, Readable.from([]))

    expect(sent).toMatchObject({ id: 'm1', originRequestId: 'relay-private-sequence' })
    expect(f.msg.getMsgsBySeqAndCount).toHaveBeenCalledWith(expect.objectContaining({
      chatType: 1, peerUid: 'uid-1715311957',
    }), '1684', 1, true, true)
    expect(f.msg.getLatestDbMsgs).not.toHaveBeenCalled()
    expect(f.msg.sendMsg).not.toHaveBeenCalled()
  })

  it.each([
    {
      kind: 'image',
      manifest: (png: Buffer) => ({
        conversationId: 'uid-1715311957', originRequestId: 'relay-image-send',
        media: [{ kind: 'image' as const, name: 'echo.png', size: png.length }],
      }),
      body: (png: Buffer) => Readable.from([png]),
    },
    {
      kind: 'sticker',
      manifest: () => ({
        conversationId: 'uid-1715311957', originRequestId: 'relay-sticker-send',
        sticker: {
          kind: 'sysface' as const, faceId: '476', faceType: 3, name: '/不是吧',
          packId: '3', stickerId: '476', sourceType: 1, stickerType: 2,
          resultId: 'result-476', imageType: 1, animated: true as const,
        },
      }),
      body: () => Readable.from([]),
    },
  ])('correlates an incomplete $kind add callback before publishing its local echo', async ({ kind, manifest, body }) => {
    const f = fixture()
    f.msg.getMsgUniqueId.mockReturnValue('0')
    const bridge = new QQKernelBridge()
    bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: '/tmp' })
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      'base64',
    )
    const messageId = `${kind}-native-id`
    f.protocolSend.mockImplementationOnce(async (_chat, _peerUid, _peerUin, parts) => {
      const elements = parts.flatMap(testProtocolElements)
      queueMicrotask(async () => {
        await f.emitSent({
          ...f.message, msgId: messageId, msgTime: '0', sendStatus: 1,
          // QQ's first media callback can expose only a renderer placeholder.
          elements: [{ elementType: 1, elementId: 'placeholder', textElement: { content: `[${kind}]` } }],
        })
        await f.emitMessages([{ ...f.message, msgId: messageId, sendStatus: 2, elements }])
      })
      return { sequence: 1n, clientSequence: 2n, sendTime: 3 }
    })
    const subscription = bridge.subscribe()
    const nextEvent = subscription[Symbol.asyncIterator]().next()

    const sent = await bridge.send(manifest(png), body(png))
    const event = await nextEvent
    bridge.unsubscribe(subscription)

    expect(sent).toMatchObject({ id: messageId, originRequestId: `relay-${kind}-send` })
    expect(event.value).toMatchObject({
      type: 'message',
      message: { id: messageId, originRequestId: `relay-${kind}-send`, outgoing: true },
    })
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

  it('loads a root longNick for an already named buddy and preserves it across partial updates', async () => {
    const f = fixture()
    const bridge = new QQKernelBridge()
    bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: '/tmp' })
    f.emitBuddyList([{ buddyList: [{
      uid: 'friend', uin: '10001', nick: 'Friend', remark: '', avatarUrl: '',
    }] }])
    f.setProfile({
      uid: 'friend', uin: '10001', nick: 'Friend', remark: '', avatarUrl: '', longNick: 'Root signature',
    })

    await expect(bridge.getUser('friend')).resolves.toMatchObject({
      name: 'Friend', signature: 'Root signature',
    })
    expect(f.profile.getUserSimpleInfo).toHaveBeenCalledWith(false, ['friend'])
    await expect(bridge.getContacts()).resolves.toMatchObject({
      users: expect.arrayContaining([expect.objectContaining({ id: 'friend', signature: 'Root signature' })]),
    })
    await bridge.getUser('friend')
    expect(f.profile.getUserSimpleInfo.mock.calls.filter(([, uids]) => uids[0] === 'friend')).toHaveLength(1)

    f.emitBuddyInfo(new Map([['friend', {
      uid: 'friend', uin: '10001', nick: 'Friend', remark: '', avatarUrl: '',
    }]]))
    await expect(bridge.getUser('friend')).resolves.toMatchObject({ signature: 'Root signature' })
    f.emitBuddyInfo(new Map([['friend', {
      uid: 'friend', uin: '10001', nick: 'Friend', remark: '', avatarUrl: '', longNick: '',
    }]]))
    await expect(bridge.getUser('friend')).resolves.toMatchObject({ signature: '' })
    expect(f.profile.getUserSimpleInfo.mock.calls.filter(([, uids]) => uids[0] === 'friend')).toHaveLength(1)
  })

  it('preserves a profile signature when the buddy snapshot arrives later without longNick', async () => {
    const f = fixture()
    const bridge = new QQKernelBridge()
    bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: '/tmp' })
    f.setProfile({
      uid: 'late-buddy', uin: '10003', nick: 'Profile Friend', remark: '', avatarUrl: '', longNick: 'Early signature',
    })

    await expect(bridge.getUser('late-buddy')).resolves.toMatchObject({ signature: 'Early signature' })
    f.emitBuddyList([{ buddyList: [{
      uid: 'late-buddy', uin: '10003', nick: 'Buddy Friend', remark: '', avatarUrl: '',
    }] }])
    await expect(bridge.getContacts()).resolves.toMatchObject({
      users: expect.arrayContaining([expect.objectContaining({ id: 'late-buddy', signature: 'Early signature' })]),
    })
  })

  it('loads longNick from coreInfo profiles', async () => {
    const f = fixture()
    const bridge = new QQKernelBridge()
    bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: '/tmp' })
    f.setProfile({
      uid: 'core', uin: '10002', nick: '', remark: '', avatarUrl: '',
      coreInfo: { nick: 'Core Friend', longNick: 'Core signature' },
    })

    await expect(bridge.getUser('core')).resolves.toMatchObject({
      name: 'Core Friend', signature: 'Core signature',
    })
  })

  it('loads the real QQNT signature from getCoreAndBaseInfo baseInfo', async () => {
    const f = fixture()
    const bridge = new QQKernelBridge()
    bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: '/tmp' })
    f.setProfile({
      uid: 'base', uin: '10004', nick: 'Base Friend', remark: '', avatarUrl: '',
      baseInfo: { longNick: 'Base signature' },
    })

    await expect(bridge.getUser('base')).resolves.toMatchObject({
      name: 'Base Friend', signature: 'Base signature',
    })
    expect(f.profile.getCoreAndBaseInfo).toHaveBeenCalledWith('nodeStore', ['base'])
  })

  it('keeps simple-profile signatures when core/base enrichment fails or times out', async () => {
    const rejected = fixture()
    rejected.profile.getCoreAndBaseInfo.mockRejectedValue(new Error('unsupported'))
    rejected.setProfile({
      uid: 'root-fallback', uin: '10005', nick: 'Root Fallback', remark: '', avatarUrl: '',
      longNick: 'Root fallback signature',
    })
    const rejectedBridge = new QQKernelBridge({ userResolveTimeoutMs: 20 })
    rejectedBridge.attach(rejected.kernel, rejected.session, {
      selfUin: '10000', selfUid: 'self', userPath: '/tmp',
    })
    await expect(rejectedBridge.getUser('root-fallback')).resolves.toMatchObject({
      signature: 'Root fallback signature',
    })

    const timedOut = fixture()
    timedOut.profile.getCoreAndBaseInfo.mockImplementation(() => new Promise(() => {}))
    timedOut.setProfile({
      uid: 'core-fallback', uin: '10006', nick: '', remark: '', avatarUrl: '',
      coreInfo: { nick: 'Core Fallback', longNick: 'Core fallback signature' },
    })
    const timedOutBridge = new QQKernelBridge({ userResolveTimeoutMs: 20 })
    timedOutBridge.attach(timedOut.kernel, timedOut.session, {
      selfUin: '10000', selfUid: 'self', userPath: '/tmp',
    })
    await expect(timedOutBridge.getUser('core-fallback')).resolves.toMatchObject({
      signature: 'Core fallback signature',
    })
  })

  it('hydrates a recent image abstract from the real message and bounds a missing UID lookup', async () => {
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
    const actualImage: MsgRecord = {
      ...f.message,
      msgId: 'group-preview', msgSeq: '42', chatType: 2,
      peerUid: '1058754719', peerUin: '1058754719', peerName: 'Test Group',
      senderUid: 'u_group_member', senderUin: '42', sendType: 2,
      elements: [{ elementType: 2, elementId: 'actual-picture', picElement: {
        fileName: 'actual.png', fileSize: '4', picWidth: 16, picHeight: 16,
        md5HexStr: 'actual-md5', fileUuid: 'actual-uuid', fileSubId: '', picSubType: 0,
      } }],
    }
    f.msg.getMsgsByMsgId.mockResolvedValue({ result: 0, errMsg: '', msgList: [actualImage] })
    const bridge = new QQKernelBridge({ userResolveTimeoutMs: 20 })
    bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: '/tmp' })

    const dialogs = await bridge.getDialogs()
    expect(dialogs.conversations).toMatchObject([{ id: '1058754719', title: 'Test Group' }])
    expect(dialogs.conversations[0].lastMessage).toMatchObject({
      id: 'group-preview', senderId: 'u_group_member', timestamp: 1_800_000_000,
      telegramMessageId: 42,
      parts: [{ type: 'media', media: { kind: 'image', name: 'actual.png' } }],
    })
    expect(JSON.stringify(dialogs.conversations[0].lastMessage)).not.toContain('group preview')
    await bridge.getDialogs()
    expect(f.msg.getMsgsByMsgId).toHaveBeenCalledOnce()
    expect(f.uix.getUin).not.toHaveBeenCalled()

    f.uix.getUin.mockImplementationOnce(() => new Promise(() => {}))
    await expect(bridge.getUser('u_hung')).resolves.toMatchObject({
      id: 'u_hung', name: 'u_hung', avatar: { id: 'avatar:user:u_hung' },
    })
  })

  it('marks an opaque message read through the native QQ API', async () => {
    const f = fixture()
    const bridge = new QQKernelBridge()
    bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: '/tmp' })
    const conversation = bridge.getConversation('uid-1715311957')

    await bridge.markRead(conversation, 'opaque-message-id')

    expect(f.msg.setSpecificMsgReadAndReport).toHaveBeenCalledWith({
      chatType: 1, peerUid: 'uid-1715311957', guildId: '',
    }, 'opaque-message-id')
    f.msg.setSpecificMsgReadAndReport.mockResolvedValueOnce({ result: 5, errMsg: 'denied' })
    await expect(bridge.markRead(conversation, 'denied')).rejects.toThrow(
      'setSpecificMsgReadAndReport: denied (5)',
    )
  })

  it('treats QQ Data Not Existed mark-read responses as idempotent success', async () => {
    const f = fixture()
    f.msg.setSpecificMsgReadAndReport.mockResolvedValueOnce({
      result: 4, errMsg: 'Data Not Existed!',
    })
    const bridge = new QQKernelBridge()
    bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: '/tmp' })

    await expect(bridge.markRead(
      bridge.getConversation('uid-1715311957'), 'already-gone',
    )).resolves.toBeUndefined()
  })

  it('keeps the newest real message when an older info update arrives later', async () => {
    const f = fixture()
    const bridge = new QQKernelBridge()
    bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: '/tmp' })
    await bridge.getDialogs()
    const events = bridge.subscribe()[Symbol.asyncIterator]()
    const newer: MsgRecord = {
      ...f.message,
      msgId: 'm2', msgSeq: '2', msgTime: '1800000002', sendType: 2,
      senderUid: 'friend', senderUin: '20000',
      elements: [{ elementType: 1, elementId: 'newer', textElement: { content: 'newest real message' } }],
    }
    const older: MsgRecord = {
      ...f.message,
      msgId: 'm-old', msgSeq: '1', msgTime: '1799999999',
      elements: [{ elementType: 1, elementId: 'older', textElement: { content: 'late old update' } }],
    }

    f.emitReceived([newer])
    await events.next()
    f.emitMessages([older])
    await events.next()

    expect((await bridge.getDialogs()).conversations[0].lastMessage).toMatchObject({
      id: 'm2', msgSeq: '2', parts: [{ type: 'text', text: 'newest real message' }],
    })
    await events.return?.()
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

  it('exposes QQ data-line sessions as device conversations with native history', async () => {
    const f = fixture()
    const deviceMessage: MsgRecord = {
      ...f.message,
      msgId: 'device-message',
      chatType: 8,
      peerUid: 'device-peer',
      peerUin: '',
      peerName: '我的手机',
      elements: [{ elementType: 1, elementId: 'device-text', textElement: { content: 'saved' } }],
    }
    f.recent.getRecentContactInfos.mockResolvedValue({
      result: 0,
      errMsg: '',
      relation: [{
        chatType: 8, peerUid: 'device-peer', peerUin: '', peerName: '我的手机',
        remark: '', avatarUrl: '', unreadCnt: '0', msgId: 'device-message', msgTime: '1800000000',
        senderUid: 'self', senderUin: '10000', abstractContent: [],
      }],
    })
    f.msg.getMsgsByMsgId.mockResolvedValue({ result: 0, errMsg: '', msgList: [deviceMessage] })
    f.msg.getLatestDbMsgs.mockResolvedValue({ result: 0, errMsg: '', msgList: [deviceMessage] })
    const bridge = new QQKernelBridge()
    bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: '/tmp' })

    const dialogs = await bridge.getDialogs()
    expect(dialogs.conversations).toMatchObject([{
      id: 'device:8:device-peer', kind: 'direct', title: '我的手机', chatType: 8,
      avatar: undefined,
      lastMessage: { id: 'device-message', conversationId: 'device:8:device-peer' },
    }])
    await expect(bridge.getHistory(dialogs.conversations[0])).resolves.toMatchObject({
      messages: [{ id: 'device-message', conversationId: 'device:8:device-peer' }],
    })
    expect(f.msg.getLatestDbMsgs).toHaveBeenCalledWith(
      { chatType: 8, peerUid: 'device-peer', guildId: '' }, 50,
    )
  })

  it('sends text and images to a data-line session through the native QQ API', async () => {
    const f = fixture()
    const root = await mkdtemp(join(tmpdir(), 'qqnt-device-send-'))
    tempPaths.push(root)
    const bridge = new QQKernelBridge({ tempPath: root })
    bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: root })
    const conversation = bridge.getConversation('device:8:device-peer')
    let sequence = 0
    f.msg.sendMsg.mockImplementation(async (_id, peer, elements) => {
      expect(peer).toMatchObject({ chatType: 8, peerUid: 'device-peer', guildId: 'generated-m1' })
      const record: MsgRecord = {
        ...f.message,
        msgId: `device-sent-${++sequence}`,
        msgSeq: String(sequence),
        chatType: 8,
        peerUid: 'device-peer',
        peerUin: '',
        peerName: '我的设备',
        sendStatus: 2,
        elements,
      }
      queueMicrotask(() => f.emitSent(record))
      return { result: 0, errMsg: '' }
    })

    await expect(bridge.send(
      { conversationId: conversation.id, text: 'keep this' }, Readable.from([]),
    )).resolves.toMatchObject({
      conversationId: 'device:8:device-peer',
      parts: [{ type: 'text', text: 'keep this' }],
    })
    const png = completePng(7, 9)
    await expect(bridge.send({
      conversationId: conversation.id,
      media: [{ kind: 'image', name: 'saved.png', width: 7, height: 9 }],
    }, Readable.from(png))).resolves.toMatchObject({
      conversationId: 'device:8:device-peer',
      parts: [{ type: 'media', media: { kind: 'image', name: 'saved.png', width: 7, height: 9 } }],
    })
    expect(f.msg.sendMsg).toHaveBeenCalledTimes(2)
    expect(f.protocolSend).not.toHaveBeenCalled()
    const image = f.msg.sendMsg.mock.calls[1]![2][0]?.picElement
    expect(image).toMatchObject({
      fileName: 'saved.png', fileSize: String(png.length), picWidth: 7, picHeight: 9,
      md5HexStr: createHash('md5').update(png).digest('hex'), original: true,
    })
    expect(await readFile(image!.sourcePath!)).toEqual(png)
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

  it('lists native QQ group folders and files with downloadable media locators', async () => {
    const f = fixture()
    f.richMedia.getGroupFileList.mockImplementation(async (_groupCode, params) => {
      queueMicrotask(() => f.emitGroupFiles({
        retCode: 0, retMsg: '', clientWording: '', isEnd: false,
        allFileCount: 3, nextIndex: 2, reqId: 7,
        item: [{
          peerId: '1058754719', type: 2,
          folderInfo: {
            folderId: 'folder-a', parentFolderId: '', folderName: '资料',
            createTime: 100, modifyTime: 110, createUin: '42', creatorName: 'Alice',
            totalFileCount: 2, modifyUin: '42', modifyName: 'Alice', usedSpace: '9',
          },
        }, {
          peerId: '1058754719', type: 1,
          fileInfo: {
            fileModelId: 'model-a', fileId: 'uuid-a', fileName: 'manual.pdf', fileSize: '9',
            busId: 102, uploadedSize: '9', uploadTime: 200, deadTime: 0, modifyTime: 210,
            downloadTimes: 4, sha: 'sha', sha3: 'sha3', md5: 'md5', uploaderLocalPath: '',
            uploaderName: 'Bob', uploaderUin: '43', parentFolderId: '', localPath: '',
            transStatus: 0, transType: 0, elementId: 'element-a', isFolder: false,
          },
        }],
      }))
      expect(params).toMatchObject({ startIndex: 0, fileCount: 2, sortType: 1, sortOrder: 2 })
      return { result: 0, errMsg: '' }
    })
    const bridge = new QQKernelBridge()
    bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: '/tmp' })

    const page = await bridge.getGroupFiles(bridge.getConversation('2:1058754719'), { limit: 2 })

    expect(page).toMatchObject({
      total: 3, nextCursor: '2',
      items: [{ type: 'folder', id: 'folder-a', name: '资料' }, {
        type: 'file', id: 'uuid-a', name: 'manual.pdf', size: 9,
        media: { locator: {
          chatType: 2, peerUid: '1058754719', fileUuid: 'uuid-a', fileBizId: 102,
          fileName: 'manual.pdf', fileSize: '9', kind: 'file',
        } },
      }],
    })
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
      remark: '', avatarUrl: '', unreadCnt: '0', msgId: '', msgTime: '',
      senderUid: '', senderUin: '', abstractContent: [],
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
    f.msg.getMsgsByMsgId.mockImplementation(async (...args: unknown[]) => {
      const [peer, ids] = args as [{ peerUid: string }, string[]]
      const index = Number(ids[0]?.replace('message-', ''))
      return {
        result: 0, errMsg: '', msgList: [{
          ...f.message,
          msgId: ids[0], msgSeq: String(index + 1), msgTime: String(1_800_000_000 - index),
          chatType: 2, peerUid: peer.peerUid, peerUin: peer.peerUid, peerName: `Group ${index}`,
          elements: [{
            elementType: 1, elementId: `actual-${index}`, textElement: { content: `Actual ${index}` },
          }],
        }],
      }
    })
    const bridge = new QQKernelBridge()
    bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: '/tmp' })

    const page = await bridge.getDialogs(undefined, 100)

    expect(getRecentContactListSyncLimit).toHaveBeenCalledWith(500)
    expect(page.total).toBe(230)
    expect(page.conversations[99]).toMatchObject({
      id: 'group-99',
      lastMessage: { id: 'message-99', parts: [{ type: 'text', text: 'Actual 99' }] },
    })
    expect(f.msg.getMsgsByMsgId).toHaveBeenCalledTimes(100)
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
    expect(f.protocolSend).toHaveBeenCalledWith(
      1, 'uid-1715311957', '1715311957', [
        expect.objectContaining({ kind: 'reply', reply: expect.objectContaining({ messageId: 'opaque-original' }) }),
        { kind: 'text', text: 'hi ' },
        { kind: 'mention', text: '@Alice', userUid: 'u_opaque_alice', userUin: '12345' },
        { kind: 'face', face: { faceId: 14, faceType: 1 } },
        { kind: 'text', text: '!' },
      ], 'self',
    )
    expect(f.msg.sendMsg).not.toHaveBeenCalled()
  })

  it('maps QQ animated system faces as stickers, opens their catalog asset, and round-trips metadata', async () => {
    const f = fixture()
    f.message.elements = [{
      elementType: 6, elementId: 'large-face', faceElement: {
        faceIndex: 476, faceText: '/不是吧', faceType: 3,
        packId: '3', stickerId: '476', sourceType: 1, stickerType: 2,
        resultId: 'result-476', imageType: 1,
      },
    }]
    const addon = packetAddonFixture()
    addon.encodeFetchSysFacesRequest = vi.fn(() => ({
      command: 'OidbSvcTrpcTcp.0x9154_1', payload: Buffer.from('catalog-request'),
    }))
    addon.decodeFetchSysFacesResponse = vi.fn(() => [{
      faceId: '476', name: '/不是吧', url: 'https://face.qq.example/476.png',
      aniStickerType: 2, aniStickerPackId: 3, aniStickerId: 476, width: 320, height: 180,
    }])
    f.msg.sendSsoCmdReqByContend = vi.fn(async () => ({
      result: 0, errMsg: '', rspbuffer: Buffer.from('catalog-response'),
    }))
    const apng = Buffer.from('animated-system-face')
    vi.stubGlobal('fetch', vi.fn(async () => new Response(apng, {
      headers: { 'content-type': 'image/apng', 'content-length': String(apng.length) },
    })))
    const bridge = new QQKernelBridge({ packetClient: { addon } })
    bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: '/tmp' })

    const history = await bridge.getHistory(bridge.getConversation('uid-1715311957'))
    expect(history.messages[0].parts).toEqual([{ type: 'sticker', sticker: expect.objectContaining({
      stickerId: 'sysface:476', format: 'animated', mimeType: 'image/apng',
      reference: expect.objectContaining({
        kind: 'sysface', faceId: '476', faceType: 3, name: '/不是吧',
        packId: '3', stickerId: '476', sourceType: 1, stickerType: 2,
        resultId: 'result-476', imageType: 1, animated: true,
      }),
    }) }])
    const reference = history.messages[0].parts[0].type === 'sticker'
      ? history.messages[0].parts[0].sticker.reference
      : undefined
    expect(reference).toBeDefined()
    const asset = await bridge.openSticker(reference!)
    expect(asset).toMatchObject({ mimeType: 'image/apng', size: apng.length })
    expect(await readStream(asset.stream)).toEqual(apng)
    expect(reference).toMatchObject({
      kind: 'sysface', url: 'https://face.qq.example/476.png', width: 320, height: 180,
    })
    expect(f.msg.sendSsoCmdReqByContend).toHaveBeenCalledWith(
      'OidbSvcTrpcTcp.0x9154_1', Buffer.from('catalog-request'),
    )

    f.msg.getMsgUniqueId.mockReturnValueOnce('0')
    const sent = await bridge.send({ conversationId: 'uid-1715311957', sticker: reference! }, Readable.from([]))
    expect(f.protocolSend).toHaveBeenCalledWith(
      1, 'uid-1715311957', '1715311957', [{ kind: 'face', face: {
        faceId: 476, faceType: 3, packId: '3', stickerId: '476',
        sourceType: 1, stickerType: 2, resultId: 'result-476',
      } }], 'self',
    )
    expect(f.msg.sendMsg).not.toHaveBeenCalled()
    expect(sent.parts).toMatchObject([{ type: 'sticker', sticker: {
      stickerId: 'sysface:476', reference: {
        kind: 'sysface', faceId: '476', packId: '3', stickerId: '476',
        sourceType: 1, stickerType: 2, resultId: 'result-476', imageType: 1,
        url: 'https://face.qq.example/476.png', width: 320, height: 180,
      },
    } }])
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

  it('drops zero-peer sidecars while preserving the paired group service message', async () => {
    const f = fixture()
    const bridge = new QQKernelBridge()
    bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: '/tmp' })
    const queue = bridge.subscribe()
    const events = queue[Symbol.asyncIterator]()

    const serviceMessage: MsgRecord = {
      ...f.message,
      msgId: 'group-service', msgSeq: '3890313', chatType: 2,
      sendType: 0,
      peerUid: '810303476', peerUin: '810303476', peerName: 'BeatSaber',
      senderUid: '0', senderUin: '0', sendNickName: '0',
      elements: [{
        elementType: 8, elementId: 'notice', grayTipElement: {
          proclamationElement: { isSetProclamation: 1 },
        },
      }],
    }
    const invalidSidecar: MsgRecord = {
      ...serviceMessage,
      msgId: 'group-service-sidecar', peerUid: '0', peerUin: '0', peerName: '0', elements: [],
    }

    f.emitReceived([invalidSidecar, serviceMessage])

    await expect(events.next()).resolves.toMatchObject({
      value: {
        type: 'message',
        conversation: { id: '810303476', title: 'BeatSaber' },
        message: {
          id: 'group-service', conversationId: '810303476',
          serviceAction: { type: 'custom', text: '群公告已更新' },
        },
      },
    })
    await expect(bridge.getDialogs()).resolves.toMatchObject({
      conversations: expect.not.arrayContaining([{ id: '0' }]),
    })
    bridge.unsubscribe(queue)
  })

  it('maps AV record elements to structured phone-call service actions', async () => {
    const f = fixture()
    f.message.elements = [{
      elementType: 21,
      elementId: 'av-record',
      avRecordElement: {
        type: 1, time: 'unknown', text: '通话未接听', mainType: 2, hasRead: false, extraType: 3,
      },
    }]
    const bridge = new QQKernelBridge()
    bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: '/tmp' })

    await expect(bridge.getHistory(bridge.getConversation('uid-1715311957'))).resolves.toMatchObject({
      messages: [{ parts: [], serviceAction: { type: 'phone-call' } }],
    })
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

  it('deduplicates repeated native deletes by conversation and sorted message IDs until the TTL expires', async () => {
    const f = fixture()
    let now = 1_000
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    const bridge = new QQKernelBridge({ deleteDedupTtlMs: 100 })
    bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: '/tmp' })
    const queue = bridge.subscribe()
    const events = queue[Symbol.asyncIterator]()

    for (let index = 0; index < 6; index++) {
      f.emitDelete(2, 'group-a', index % 2 ? ['message-b', 'message-a'] : ['message-a', 'message-b'])
    }
    const first = await events.next()
    expect(first).toMatchObject({ value: {
      type: 'message-delete', conversation: { id: 'group-a' }, messageIds: ['message-a', 'message-b'],
    } })
    const noReplay = bridge.subscribe(bridge.eventId(first.value!)!)
    expect(bridge.consumeReplayEvent(noReplay)).toBeUndefined()
    bridge.unsubscribe(noReplay)

    f.emitDelete(2, 'group-b', ['message-a', 'message-b'])
    await expect(events.next()).resolves.toMatchObject({
      value: { type: 'message-delete', conversation: { id: 'group-b' } },
    })
    now += 101
    f.emitDelete(2, 'group-a', ['message-b', 'message-a'])
    await expect(events.next()).resolves.toMatchObject({
      value: { type: 'message-delete', conversation: { id: 'group-a' } },
    })

    bridge.detach()
    bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: '/tmp' })
    f.emitDelete(2, 'group-a', ['message-a', 'message-b'])
    await expect(events.next()).resolves.toMatchObject({
      value: { type: 'message-delete', conversation: { id: 'group-a' } },
    })
    bridge.unsubscribe(queue)
  })

  it('prepares trusted Silk PTT as stable OGG metadata and serves exact ranged bytes', async () => {
    const f = fixture()
    const root = await mkdtemp(join(tmpdir(), 'qqnt-voice-source-'))
    tempPaths.push(root)
    const wav = join(root, 'voice.wav')
    const silk = join(root, 'voice.silk')
    await execFileAsync('ffmpeg', ['-nostdin', '-y', '-v', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=24000:cl=mono', '-t', '0.04', wav])
    await encodePtt(wav, silk)
    f.message.elements = [{ elementType: 4, elementId: 'voice', pttElement: {
      duration: 1, fileName: 'voice.silk', filePath: silk, fileSize: String((await readFile(silk)).length),
    } }]
    const bridge = new QQKernelBridge({ tempPath: join(root, 'cache-root') })
    bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: root })

    const history = await bridge.getHistory(bridge.getConversation('uid-1715311957'))
    const part = history.messages[0]!.parts[0]
    expect(part?.type).toBe('media')
    if (!part || part.type !== 'media') throw new Error('expected prepared voice media')
    expect(part.media).toMatchObject({ voice: true, name: 'voice.ogg', mimeType: 'audio/ogg', duration: 1 })
    expect(part.media.size).toBeGreaterThan(0)
    expect(part.media.locator).toMatchObject({ kind: 'voice', sourcePath: silk, fileSize: String(part.media.size) })
    const opened = await bridge.openMedia(part.media.locator, { offset: 1, limit: 4 })
    expect(opened).toMatchObject({ mimeType: 'audio/ogg', size: part.media.size, offset: 1, length: 4 })
    expect(await readStream(opened!.stream)).toEqual((await readFile(part.media.locator.filePath!)).subarray(1, 5))
  })

  it('recreates a cleared voice cache from an unchanged persisted locator source', async () => {
    const f = fixture()
    const root = await mkdtemp(join(tmpdir(), 'qqnt-voice-reopen-'))
    tempPaths.push(root)
    const wav = join(root, 'voice.wav')
    const silk = join(root, 'voice.silk')
    await execFileAsync('ffmpeg', ['-nostdin', '-y', '-v', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=24000:cl=mono', '-t', '0.04', wav])
    await encodePtt(wav, silk)
    f.message.elements = [{ elementType: 4, elementId: 'voice', pttElement: {
      duration: 1, fileName: 'voice.silk', filePath: silk, fileSize: String((await readFile(silk)).length),
    } }]
    const options = { selfUin: '10000', selfUid: 'self', userPath: root }
    const bridge = new QQKernelBridge({ tempPath: join(root, 'cache-root') })
    bridge.attach(f.kernel, f.session, options)
    const part = (await bridge.getHistory(bridge.getConversation('uid-1715311957'))).messages[0]!.parts[0]
    if (!part || part.type !== 'media') throw new Error('expected prepared voice media')
    const locator = { ...part.media.locator }
    const firstPath = locator.filePath
    bridge.detach()
    bridge.attach(f.kernel, f.session, options)

    const opened = await bridge.openMedia(locator)
    expect(opened).toMatchObject({ mimeType: 'audio/ogg', size: part.media.size })
    expect(locator.filePath).toBe(firstPath)
    const bytes = await readStream(opened!.stream)
    expect(bytes).toHaveLength(part.media.size!)
    expect(bytes).not.toEqual(await readFile(silk))

    bridge.detach()
    await writeFile(silk, Buffer.from('changed'))
    bridge.attach(f.kernel, f.session, options)
    await expect(bridge.openMedia(locator)).resolves.toBeUndefined()
  })

  it('renders missing, untrusted, and symlink-escaped PTT paths as text fallbacks', async () => {
    const f = fixture()
    const root = await mkdtemp(join(tmpdir(), 'qqnt-voice-trusted-'))
    const outside = await mkdtemp(join(tmpdir(), 'qqnt-voice-outside-'))
    tempPaths.push(root, outside)
    const outsidePath = join(outside, 'voice.silk')
    const linkPath = join(root, 'escaped.silk')
    await writeFile(outsidePath, Buffer.from('not trusted'))
    await symlink(outsidePath, linkPath)
    f.message.elements = [
      { elementType: 4, elementId: 'missing', pttElement: { duration: 1, filePath: join(root, 'missing.silk') } },
      { elementType: 4, elementId: 'outside', pttElement: { duration: 2, filePath: outsidePath } },
      { elementType: 4, elementId: 'escape', pttElement: { duration: 3, filePath: linkPath } },
    ]
    const bridge = new QQKernelBridge({ tempPath: join(root, 'cache-root') })
    bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: root })

    const history = await bridge.getHistory(bridge.getConversation('uid-1715311957'))
    expect(history.messages[0]!.parts).toEqual([
      { type: 'text', text: '[语音 1秒]' },
      { type: 'text', text: '[语音 2秒]' },
      { type: 'text', text: '[语音 3秒]' },
    ])
  })

  it('falls back from an invalid trusted PTT and removes failed conversion artifacts', async () => {
    const f = fixture()
    const root = await mkdtemp(join(tmpdir(), 'qqnt-voice-invalid-'))
    tempPaths.push(root)
    const invalid = join(root, 'invalid.silk')
    await writeFile(invalid, Buffer.from('not-a-voice'))
    f.message.elements = [{ elementType: 4, elementId: 'voice', pttElement: {
      duration: 4, fileName: 'invalid.silk', filePath: invalid, fileSize: '11',
    } }]
    const bridge = new QQKernelBridge({ tempPath: join(root, 'cache-root') })
    bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: root })

    await expect(bridge.getHistory(bridge.getConversation('uid-1715311957'))).resolves.toMatchObject({
      messages: [{ parts: [{ type: 'text', text: '[语音 4秒]' }] }],
    })
    await expect(readdir(join(root, 'cache-root', 'voice-cache'))).resolves.toEqual([])
  })

  it('rejects oversized inbound PTT before decoding or fallback transcoding', async () => {
    const f = fixture()
    const root = await mkdtemp(join(tmpdir(), 'qqnt-voice-oversized-'))
    tempPaths.push(root)
    const oversized = join(root, 'oversized.silk')
    await writeFile(oversized, Buffer.alloc(0))
    await truncate(oversized, 32 * 1024 * 1024 + 1)
    f.message.elements = [{ elementType: 4, elementId: 'voice', pttElement: {
      duration: 4, fileName: 'oversized.silk', filePath: oversized, fileSize: String(32 * 1024 * 1024 + 1),
    } }]
    const bridge = new QQKernelBridge({ tempPath: join(root, 'cache-root') })
    bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: root })

    await expect(bridge.getHistory(bridge.getConversation('uid-1715311957'))).resolves.toMatchObject({
      messages: [{ parts: [{ type: 'text', text: '[语音 4秒]' }] }],
    })
    await expect(readdir(join(root, 'cache-root', 'voice-cache'))).resolves.toEqual([])
  })

  it('rejects voice manifests with either reply identity before accepting bytes', async () => {
    const f = fixture()
    const bridge = new QQKernelBridge()
    bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: '/tmp' })
    for (const manifest of [
      { conversationId: 'uid-1715311957', replyToId: 'message', media: [{ kind: 'voice' as const, name: 'voice.ogg' }] },
      { conversationId: 'uid-1715311957', replyToSequence: '42', media: [{ kind: 'voice' as const, name: 'voice.ogg' }] },
    ]) {
      await expect(bridge.send(manifest, Readable.from(Uint8Array.of(1)))).rejects.toThrow('voice messages cannot be replies')
    }
    expect(f.msg.sendMsg).not.toHaveBeenCalled()
  })

  it('sends one OGG voice item through the native PTT element with seconds duration', async () => {
    const f = fixture()
    const root = await mkdtemp(join(tmpdir(), 'qqnt-voice-send-'))
    tempPaths.push(root)
    const ogg = join(root, 'voice.ogg')
    const stagedSilk = join(root, 'qq-media', 'voice.silk')
    await mkdir(dirname(stagedSilk), { recursive: true })
    await execFileAsync('ffmpeg', ['-nostdin', '-y', '-v', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=24000:cl=mono', '-t', '0.04', ogg])
    f.msg.getRichMediaFilePathForGuild.mockImplementationOnce((file) => {
      expect(file).toMatchObject({
        md5HexStr: expect.stringMatching(/^[0-9a-f]{32}$/),
        fileName: expect.stringMatching(/\.silk$/),
        elementType: 4,
        elementSubType: 0,
        thumbSize: 0,
        needCreate: true,
        downloadType: 1,
        file_uuid: '',
      })
      return stagedSilk
    })
    f.msg.sendMsg.mockImplementationOnce(async (id, peer, elements) => {
      expect(id).toBe('0')
      expect(peer).toMatchObject({ chatType: 1, peerUid: 'uid-1715311957', guildId: 'generated-m1' })
      const ptt = elements[0]?.pttElement
      expect(ptt).toMatchObject({
        fileName: expect.stringMatching(/\.silk$/),
        filePath: stagedSilk,
        md5HexStr: expect.stringMatching(/^[0-9a-f]{32}$/),
        fileSize: expect.stringMatching(/^[1-9]\d*$/),
        duration: expect.any(Number),
        formatType: 1,
        voiceType: 1,
        voiceChangeType: 0,
        canConvert2Text: true,
        waveAmplitudes: expect.any(Array),
        fileSubId: '',
        playState: 1,
        autoConvertText: 0,
        storeID: 0,
        otherBusinessInfo: { aiVoiceType: 0 },
      })
      expect((await readFile(ptt!.filePath!)).length).toBe(Number(ptt!.fileSize))
      queueMicrotask(() => f.emitSent({ ...f.message, sendStatus: 2, elements: [{
        elementType: 4, elementId: 'voice', pttElement: { filePath: ptt!.filePath, fileName: 'voice.silk', fileSize: '1', duration: ptt!.duration },
      }] }))
      return { result: 0, errMsg: '' }
    })
    const bridge = new QQKernelBridge({ tempPath: join(root, 'cache-root') })
    bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: root })

    const sent = await bridge.send({
      conversationId: 'uid-1715311957', media: [{ kind: 'voice', name: 'voice.ogg', mimeType: 'audio/ogg' }],
    }, Readable.from(await readFile(ogg)))
    expect(f.msg.generateMsgUniqueId).toHaveBeenCalledWith(1, expect.stringMatching(/^\d+$/))
    expect(f.msg.sendMsg).toHaveBeenCalledOnce()
    const voice = sent.parts.find((part) => part.type === 'media' && part.media.voice)
    expect(voice).toBeDefined()
    if (!voice || voice.type !== 'media') throw new Error('expected prepared sent voice media')
    const voiceFilePath = voice.media.locator.filePath
    if (!voiceFilePath) throw new Error('expected prepared sent voice path')
    expect(voiceFilePath.replaceAll('\\', '/')).toMatch(/voice-cache\/[^/]+\.ogg$/)
    expect(voiceFilePath).not.toMatch(/\.silk$/)
    const opened = await bridge.openMedia(voice.media.locator)
    expect(opened).toMatchObject({ mimeType: 'audio/ogg', size: voice.media.size })
    const bytes = await readStream(opened!.stream)
    expect(bytes).toEqual(await readFile(voiceFilePath))
    expect(bytes).toHaveLength(voice.media.size!)
  })

  it('hides recalled records, maps native videos, and renders unsupported elements as text fallbacks', async () => {
    const f = fixture()
    const videoThumbnailDir = await mkdtemp(join(tmpdir(), 'qqnt-video-thumb-'))
    const videoThumbnailPath = join(videoThumbnailDir, 'preview.jpg')
    await writeFile(videoThumbnailPath, Buffer.from([0xff, 0xd8, 0xff, 0xd9]))
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
            thumbSize: 4, thumbMd5: 'thumb-md5', thumbPath: new Map([[0, videoThumbnailPath]]),
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
        preview: {
          mimeType: 'image/jpeg', size: 4, width: 1280, height: 720,
          locator: {
            messageId: 'fallbacks', elementId: 'video', chatType: 1, peerUid: 'uid-1715311957',
            kind: 'image', fileName: 'preview.jpg',
            fileSize: '4', filePath: videoThumbnailPath, md5: 'thumb-md5',
          },
        },
        locator: {
          messageId: 'fallbacks', elementId: 'video', chatType: 1, peerUid: 'uid-1715311957',
          kind: 'file', fileName: 'clip.mp4', fileSize: '1048576', filePath: '/missing/clip.mp4',
          fileUuid: 'video-uuid', fileSubId: 'video-sub-id', fileBizId: 4601, md5: 'video-md5',
          videoCodecFormat: 1,
        },
      } },
      { type: 'card', card: { kind: 'application', title: '卡片标题' } },
      { type: 'text', text: '**Markdown**' },
      { type: 'text', text: '[暂不支持的消息 999]' },
    ] })
    await rm(videoThumbnailDir, { recursive: true, force: true })
  })

  it('parses legacy and current mini-app Ark payloads into structured cards', async () => {
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
      messages: [{ parts: [{ type: 'card', card: {
        kind: 'mini-app', source: '腾讯文档', title: '项目排期',
        url: 'https://docs.qq.com/sheet/example',
      } }, { type: 'card', card: {
        kind: 'mini-app', source: '示例小程序', title: '分享标题', description: '分享描述',
        url: 'https://m.q.qq.com/a/s/example',
      } }] }],
    })
  })

  it('parses generic Ark shares and legacy XML structure messages into structured cards', async () => {
    const f = fixture()
    f.message.elements = [{
      elementType: 10, elementId: 'news-card', arkElement: { bytesData: JSON.stringify({
        app: 'com.tencent.structmsg', prompt: '[分享] 新闻', meta: { news: {
          tag: '示例资讯', title: '结构化分享标题', desc: '结构化分享摘要',
          jumpUrl: 'https://example.com/articles/42',
          preview: 'https://cdn.example.com/cover.jpg',
        } },
      }) },
    }, {
      elementType: 12, elementId: 'xml-card', structMsgElement: { xmlContent:
        '<msg serviceID="1" brief="[分享] XML 摘要" url="https://example.com/xml">'
        + '<item><picture cover="https://cdn.example.com/xml.jpg"/>'
        + '<title><![CDATA[XML 分享标题]]></title><summary>XML 分享描述</summary></item>'
        + '<source name="XML 来源"/></msg>',
      },
    }]
    const bridge = new QQKernelBridge()
    bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: '/tmp' })

    await expect(bridge.getHistory(bridge.getConversation('uid-1715311957'))).resolves.toMatchObject({
      messages: [{ parts: [{ type: 'card', card: {
        kind: 'link', source: '示例资讯', title: '结构化分享标题', description: '结构化分享摘要',
        url: 'https://example.com/articles/42', thumbnailUrl: 'https://cdn.example.com/cover.jpg',
      } }, { type: 'card', card: {
        kind: 'link', source: 'XML 来源', title: 'XML 分享标题', description: 'XML 分享描述',
        url: 'https://example.com/xml', thumbnailUrl: 'https://cdn.example.com/xml.jpg',
      } }] }],
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
    const optimisticForward = {
      ...f.message, msgId: 'forwarded-1', msgTime: String(Math.floor(Date.now() / 1000)),
      msgSeq: '463083', sendStatus: 1,
      elements: [{ elementType: 1, elementId: 'forwarded-text', textElement: { content: 'forwarded' } }],
    }
    const forwarded = { ...optimisticForward, msgSeq: '463084', sendStatus: 2 }
    f.msg.getLatestDbMsgs
      .mockResolvedValueOnce({ result: 0, errMsg: '', msgList: [f.message] })
      .mockResolvedValueOnce({ result: 0, errMsg: '', msgList: [optimisticForward, f.message] })
      .mockResolvedValueOnce({ result: 0, errMsg: '', msgList: [forwarded, f.message] })
    await expect(bridge.forwardMessages(conversation, ['m1'], conversation)).resolves.toMatchObject([
      {
        id: 'forwarded-1', msgSeq: '463084',
        parts: [{ type: 'text', text: 'forwarded' }],
      },
    ])
    expect(f.msg.forwardMsg).toHaveBeenCalledWith(['m1'], expect.anything(), [expect.anything()], expect.any(Map))

    const merged = {
      ...forwarded, msgId: 'merged-1', msgType: 11, subMsgType: 7,
      elements: [{
        elementType: 10, elementId: 'merged',
        arkElement: { bytesData: JSON.stringify({
          app: 'com.tencent.multimsg', prompt: 'Alice & Bob 的聊天记录',
          meta: { detail: { news: [{ text: 'Alice: hello' }, { text: 'Bob: world' }] } },
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
        preview: 'Alice: hello\nBob: world',
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
      ...f.message, msgId: 'nested-1', chatType: 1, peerUid: 'archived-direct-peer',
      elements: [{
        elementType: 16, elementId: 'nested',
        multiForwardMsgElement: {
          fileName: '嵌套聊天记录', resId: 'nested-res',
          xmlContent: '<msg><item><summary><![CDATA[Carol: 图片\nDave: 收到]]></summary></item></msg>',
        },
      }],
    }
    f.msg.getMultiMsg.mockResolvedValueOnce({ result: 0, errMsg: '', msgList: [nested] })
    await expect(bridge.getMultiForwardMessages({
      conversationId: 'uid-1715311957', rootMessageId: 'merged-1',
    })).resolves.toMatchObject([{
      id: 'nested-1', parts: [{
        type: 'multi-forward', title: '嵌套聊天记录',
        preview: 'Carol: 图片\nDave: 收到',
        locator: {
          // Nested archive records retain their original peer. The locator must
          // keep using the physical conversation that contains the outer card.
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

  it('prefers detailed XML merged-forward summaries over the generic message count', async () => {
    const f = fixture()
    const bridge = new QQKernelBridge()
    bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: '/tmp' })
    await bridge.getDialogs()
    const forwarded = {
      ...f.message, msgId: 'xml-forward',
      elements: [{
        elementType: 16, elementId: 'xml-forward-element',
        multiForwardMsgElement: {
          fileName: 'QQ用户的聊天记录', resId: 'xml-forward-resource',
          xmlContent: '<msg><item>'
            + '<title><![CDATA[QQ用户的聊天记录]]></title>'
            + '<summary><![CDATA[查看7条转发消息]]></summary>'
            + '<summary><![CDATA[Alice: 第一条<br/>Bob: 第二条 &amp; 回复]]></summary>'
            + '<summary>Carol: 第三条</summary>'
            + '</item></msg>',
        },
      }],
    }
    f.msg.getMultiMsg.mockResolvedValueOnce({ result: 0, errMsg: '', msgList: [forwarded] })

    await expect(bridge.getMultiForwardMessages({
      conversationId: 'uid-1715311957', rootMessageId: 'xml-forward',
    })).resolves.toMatchObject([{
      id: 'xml-forward', parts: [{
        type: 'multi-forward', title: 'QQ用户的聊天记录',
        preview: 'Alice: 第一条\nBob: 第二条 & 回复\nCarol: 第三条',
      }],
    }])
  })

  it('defers merged-forward voice conversion until the media is opened', async () => {
    const f = fixture()
    const root = await mkdtemp(join(tmpdir(), 'qqnt-merged-voice-'))
    tempPaths.push(root)
    const wav = join(root, 'voice.wav')
    const silk = join(root, 'voice.silk')
    await execFileAsync('ffmpeg', [
      '-nostdin', '-y', '-v', 'error', '-f', 'lavfi', '-i',
      'anullsrc=r=24000:cl=mono', '-t', '0.04', wav,
    ])
    await encodePtt(wav, silk)
    const sourceSize = (await readFile(silk)).length
    const forwarded = {
      ...f.message,
      msgId: 'merged-voice',
      elements: [{ elementType: 4, elementId: 'voice', pttElement: {
        duration: 1, fileName: 'voice.silk', filePath: silk, fileSize: String(sourceSize),
      } }],
    }
    f.msg.getMultiMsg.mockResolvedValueOnce({ result: 0, errMsg: '', msgList: [forwarded] })
    const cacheRoot = join(root, 'cache-root')
    const bridge = new QQKernelBridge({ tempPath: cacheRoot })
    bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: root })
    await bridge.getDialogs()

    const [message] = await bridge.getMultiForwardMessages({
      conversationId: 'uid-1715311957', rootMessageId: 'merged-root',
    })
    const part = message!.parts[0]
    if (!part || part.type !== 'media') throw new Error('expected deferred merged-forward voice media')
    expect(part.media).toMatchObject({
      voice: true, name: 'voice.ogg', mimeType: 'audio/ogg', duration: 1,
      locator: {
        kind: 'voice', sourcePath: silk, sourceSize,
      },
    })
    expect(part.media.size).toBeUndefined()
    expect(part.media.locator.filePath).toBeUndefined()
    await expect(readdir(join(cacheRoot, 'voice-cache'))).resolves.toEqual([])

    const opened = await bridge.openMedia(part.media.locator)
    expect(opened).toMatchObject({ mimeType: 'audio/ogg', offset: 0 })
    expect(opened!.size).toBeGreaterThan(0)
    expect(await readStream(opened!.stream)).toHaveLength(opened!.size)
    await expect(readdir(join(cacheRoot, 'voice-cache'))).resolves.toHaveLength(1)
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
    f.protocolSend.mockImplementation(async () => {
      setTimeout(() => f.emitMessages([{ ...f.message, sendStatus: 0 }]), 5)
      return { sequence: 1n, clientSequence: 2n, sendTime: 3 }
    })

    await expect(bridge.send({
      conversationId: 'uid-1715311957',
      media: [{ kind: 'image', name: 'tiny.png', size: png.length }],
    }, Readable.from([png]))).rejects.toThrow('QQ send failed')
    expect(f.imageUpload).toHaveBeenCalledWith(
      1, 'uid-1715311957', '10000', expect.objectContaining({
        name: 'tiny.png', size: png.length, width: 1, height: 1,
        md5: 'e44e7ecfec99356632c13cd3eaa3e250',
      }), expect.anything(),
    )
  })

  it('uses declared JPEG dimensions and type for the native image element', async () => {
    const f = fixture()
    const bridge = new QQKernelBridge()
    bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: '/tmp' })
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9])
    await bridge.send({
      conversationId: 'uid-1715311957',
      media: [{ kind: 'image', name: 'wide.jpeg', size: jpeg.length, width: 1096, height: 892 }],
    }, Readable.from([jpeg]))

    expect(f.imageUpload).toHaveBeenCalledWith(
      1, 'uid-1715311957', '10000', expect.objectContaining({
        name: 'wide.jpeg', width: 1096, height: 892, picType: 1000,
      }), expect.anything(),
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
    const sent = await bridge.send({
      conversationId: 'uid-1715311957', mediaFraming: 'length-prefixed-v1',
      media: [
        { kind: 'image', name: 'first.png', size: first.length },
        { kind: 'image', name: 'second.png', size: second.length },
      ],
    }, Readable.from([...frame(first), ...frame(second)]))

    expect(f.imageUpload).toHaveBeenNthCalledWith(
      1, 1, 'uid-1715311957', '10000',
      expect.objectContaining({ name: 'first.png', md5: 'e44e7ecfec99356632c13cd3eaa3e250' }),
      expect.anything(),
    )
    expect(f.imageUpload).toHaveBeenNthCalledWith(
      2, 1, 'uid-1715311957', '10000',
      expect.objectContaining({ name: 'second.png', md5: '5b118909b999cf913eb2ab9e8972fbe0' }),
      expect.anything(),
    )
    expect(f.protocolSend.mock.calls.at(-1)?.[3]).toHaveLength(2)
    expect(sent.parts.filter((part) => part.type === 'media')).toHaveLength(2)
  })

  it('publishes a hashed group file through CDN upload and OidbSvcTrpcTcp.0x6d9_4', async () => {
    const f = fixture()
    const file = Buffer.from([4, 5, 6, 7])
    const received: Buffer[] = []
    const fileUpload = vi.spyOn(QQPacketClient.prototype, 'uploadFile')
      .mockImplementation(async (_chat, _peer, _uin, _uid, _spec, source) => {
        for await (const chunk of source) received.push(Buffer.from(chunk))
        return { fileUuid: 'direct.bin', exists: true, commandId: 71 }
      })
    const bridge = new QQKernelBridge()
    bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: '/tmp' })

    await bridge.send({
      conversationId: '1058754719',
      media: [{
        kind: 'file', name: 'direct.bin', size: file.length,
        md5: 'a6b8537b97d58b417d3dfdd1030b15d2', sha1: '13a936c521299ecb9702d0b63e6458171f926bba',
        file10MMd5: 'a6b8537b97d58b417d3dfdd1030b15d2',
      }],
    }, Readable.from([file]))

    expect(Buffer.concat(received)).toEqual(file)
    expect(fileUpload).toHaveBeenCalledOnce()
    expect(f.groupFilePublish).toHaveBeenCalledWith('1058754719', 'direct.bin')
    expect(f.protocolSend).not.toHaveBeenCalled()
    expect(f.msg.sendMsg).not.toHaveBeenCalled()
    expect(f.sentBodies).toEqual([])
  })

  it('rejects group file captions before uploading to QQ CDN', async () => {
    const f = fixture()
    const bridge = new QQKernelBridge()
    bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: '/tmp' })

    await expect(bridge.send({
      conversationId: '1058754719', text: 'caption',
      media: [{ kind: 'file', name: 'direct.bin', size: 4 }],
    }, Readable.from([Buffer.from('file')]))).rejects.toThrow('exactly one file without a caption')
    expect(f.fileUpload).not.toHaveBeenCalled()
    expect(f.groupFilePublish).not.toHaveBeenCalled()
  })

  it('returns a direct Highway plan and sends its uploaded image metadata with an empty body', async () => {
    const f = fixture()
    const prepare = vi.spyOn(QQPacketClient.prototype, 'prepareImageUpload').mockResolvedValue({
      upload: {
        fileUuid: 'prepared-image', ipv4s: [{ host: '127.0.0.1', port: 8080 }],
        msgInfo: Buffer.from('prepared-msg-info'), msgInfoBodies: [Buffer.from('body')],
        compatQMsg: Buffer.from('compat'), ukey: 'ukey',
      },
      highway: {
        session: { ticket: Buffer.from('ticket'), servers: [{ host: '127.0.0.1', port: 8080 }] },
        extendInfo: Buffer.from('extend'), commandId: 1003, sequenceStart: 41,
      },
    })
    const bridge = new QQKernelBridge()
    bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: '/tmp' })
    const media = {
      kind: 'image' as const, name: 'direct.png', size: 3,
      md5: '5289df737df57326fcdd22597afb1fac', sha1: '7037807198c22a7d2b0807371d763779a84fdfcf',
      width: 1, height: 1,
    }

    const plan = await bridge.prepareMediaUpload('uid-1715311957', media)
    expect(plan).toEqual({
      prepared: {
        kind: 'image', fileUuid: 'prepared-image',
        msgInfo: Buffer.from('prepared-msg-info').toString('base64url'),
        compatQMsg: Buffer.from('compat').toString('base64url'),
      },
      highway: {
        servers: [{ host: '127.0.0.1', port: 8080 }],
        ticket: Buffer.from('ticket').toString('base64url'),
        extendInfo: Buffer.from('extend').toString('base64url'),
        selfUin: '10000', commandId: 1003, sequenceStart: 41,
        blockSize: HIGHWAY_BLOCK_SIZE, fileSize: 3,
        fileMd5: '5289df737df57326fcdd22597afb1fac',
      },
    })
    const sent = await bridge.send({
      conversationId: 'uid-1715311957', media: [media], uploadedMedia: [plan.prepared],
    }, Readable.from([]))

    expect(sent).toMatchObject({ id: 'm1', parts: [{ type: 'media', media: { kind: 'image' } }] })
    expect(prepare).toHaveBeenCalledWith(1, 'uid-1715311957', expect.objectContaining({
      name: 'direct.png', size: 3, picType: 1001,
    }))
    expect(f.imageUpload).not.toHaveBeenCalled()
    expect(f.protocolSend).toHaveBeenCalledWith(
      1, 'uid-1715311957', '1715311957', [expect.objectContaining({
        kind: 'image', upload: expect.objectContaining({
          fileUuid: 'prepared-image', msgInfo: Buffer.from('prepared-msg-info'),
        }),
      })], 'self',
    )
    expect(f.msg.sendMsg).not.toHaveBeenCalled()
  })

  it('returns dual Highway video plans and sends the prepared video through PbSendMsg', async () => {
    const f = fixture()
    const thumbnail = {
      size: 321, md5: '00112233445566778899aabbccddeeff',
      sha1: '00112233445566778899aabbccddeeff00112233', width: 320, height: 180,
    }
    const prepare = vi.spyOn(QQPacketClient.prototype, 'prepareVideoUpload').mockResolvedValue({
      upload: {
        fileUuid: 'prepared-video', thumbnailFileUuid: 'prepared-thumbnail',
        msgInfo: Buffer.from('prepared-video-msg-info'), msgInfoBodies: [Buffer.from('video'), Buffer.from('thumb')],
        videoUkey: 'video-ukey', videoIpv4s: [{ host: '127.0.0.1', port: 8080 }],
        thumbnailUkey: 'thumb-ukey', thumbnailIpv4s: [{ host: '127.0.0.1', port: 8080 }],
      },
      thumbnail,
      highway: {
        session: { ticket: Buffer.from('ticket'), servers: [{ host: '127.0.0.1', port: 8080 }] },
        extendInfo: Buffer.from('video-extend'), commandId: 1001, sequenceStart: 41,
      },
      thumbnailHighway: {
        session: { ticket: Buffer.from('ticket'), servers: [{ host: '127.0.0.1', port: 8080 }] },
        extendInfo: Buffer.from('thumb-extend'), commandId: 1002, sequenceStart: 42,
      },
    })
    const bridge = new QQKernelBridge()
    bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: '/tmp' })
    const media = {
      kind: 'video' as const, name: 'clip.mp4', mimeType: 'video/mp4', size: 3,
      md5: '5289df737df57326fcdd22597afb1fac', sha1: '7037807198c22a7d2b0807371d763779a84fdfcf',
      width: 320, height: 180, duration: 2, thumbnail,
    }

    const plan = await bridge.prepareMediaUpload('uid-1715311957', media)
    expect(plan).toEqual({
      prepared: {
        kind: 'video', fileUuid: 'prepared-video',
        msgInfo: Buffer.from('prepared-video-msg-info').toString('base64url'),
      },
      highway: {
        servers: [{ host: '127.0.0.1', port: 8080 }],
        ticket: Buffer.from('ticket').toString('base64url'),
        extendInfo: Buffer.from('video-extend').toString('base64url'),
        selfUin: '10000', commandId: 1001, sequenceStart: 41,
        blockSize: HIGHWAY_BLOCK_SIZE, fileSize: 3,
        fileMd5: '5289df737df57326fcdd22597afb1fac',
      },
      auxiliaryHighways: [{
        role: 'thumbnail',
        highway: {
          servers: [{ host: '127.0.0.1', port: 8080 }],
          ticket: Buffer.from('ticket').toString('base64url'),
          extendInfo: Buffer.from('thumb-extend').toString('base64url'),
          selfUin: '10000', commandId: 1002, sequenceStart: 42,
          blockSize: HIGHWAY_BLOCK_SIZE, fileSize: thumbnail.size,
          fileMd5: thumbnail.md5,
        },
      }],
    })
    const sent = await bridge.send({
      conversationId: 'uid-1715311957', text: 'caption', media: [media], uploadedMedia: [plan.prepared],
    }, Readable.from([]))

    expect(sent).toMatchObject({ id: 'm1', parts: expect.any(Array) })
    expect(prepare).toHaveBeenCalledWith(1, 'uid-1715311957', expect.objectContaining({
      name: 'clip.mp4', mimeType: 'video/mp4', size: 3, width: 320, height: 180, duration: 2,
      thumbnail,
    }))
    expect(f.protocolSend).toHaveBeenCalledWith(
      1, 'uid-1715311957', '1715311957', [
        { kind: 'text', text: 'caption' },
        expect.objectContaining({
          kind: 'video', upload: expect.objectContaining({
            fileUuid: 'prepared-video', msgInfo: Buffer.from('prepared-video-msg-info'),
          }),
        }),
      ], 'self',
    )
    expect(f.fileUpload).not.toHaveBeenCalled()
    expect(f.groupFilePublish).not.toHaveBeenCalled()
    expect(f.msg.sendMsg).not.toHaveBeenCalled()
  })

  it('finalizes private preuploaded file metadata before PbSendMsg', async () => {
    const f = fixture()
    const complete = vi.spyOn(QQPacketClient.prototype, 'completeFileUpload')
      .mockImplementation(async (_chatType, _peerUid, _selfUid, upload) => {
        upload.privateMetadata = {
          field1: 1, field6: 6, field7: Buffer.from('seven'), field8: Buffer.from('eight'), timestamp1: 9,
        }
      })
    const bridge = new QQKernelBridge()
    bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: '/tmp' })
    const media = {
      kind: 'file' as const, name: 'direct.bin', size: 4,
      md5: 'a6b8537b97d58b417d3dfdd1030b15d2', sha1: '13a936c521299ecb9702d0b63e6458171f926bba',
      file10MMd5: 'a6b8537b97d58b417d3dfdd1030b15d2',
    }
    await bridge.send({
      conversationId: 'uid-1715311957', media: [media], uploadedMedia: [{
        kind: 'file', fileUuid: 'prepared-file', fileHash: 'file-hash', exists: false, commandId: 95,
      }],
    }, Readable.from([]))

    expect(complete).toHaveBeenCalledWith(1, 'uid-1715311957', 'self', expect.objectContaining({
      fileUuid: 'prepared-file', fileHash: 'file-hash', commandId: 95,
    }))
    expect(f.fileUpload).not.toHaveBeenCalled()
    expect(f.msg.sendMsg).not.toHaveBeenCalled()
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
      imgs: [{ id: 'emoji-a', wWidthInPhone: 320, wHeightInPhone: 180, isApng: 1 }],
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
      packs: [
        { packId: 'qq-favorites', title: 'QQ 收藏表情', count: 0 },
        { packId: '42', title: 'QQ Waves' },
      ],
    })
    const pack = await bridge.getStickerPack('42')
    expect(pack).toMatchObject({
      packId: '42', count: 1,
      stickers: [{
        stickerId: 'market:42:emoji-a', format: 'animated', mimeType: 'image/gif',
        width: 320, height: 180,
      }],
    })
    const opened = await bridge.openSticker(pack!.stickers[0].reference)
    expect(opened.mimeType).toBe('image/gif')
    expect(await readStream(opened.stream)).toEqual(gif)

    let favoritePath: string | undefined
    f.msg.addFavEmoji.mockImplementation(async (request) => {
      favoritePath = request.emojiPath
      expect(request).toMatchObject({
        emojiId: 'emoji-a', packageId: 42, isMarkFace: true, isOrigin: false,
      })
      expect(request.emojiPath).not.toBe(dynamicPath)
      expect(await readFile(request.emojiPath)).toEqual(gif)
      return { result: 0, errMsg: '', isExist: 0 }
    })
    await bridge.setSavedSticker(pack!.stickers[0].reference, true)
    expect(f.msg.fetchMarketEmoticonAuthDetail).toHaveBeenCalledWith({
      epId: 42, eId: 'emoji-a', scene: 0,
    })
    expect(favoritePath).toBeDefined()
    expect(existsSync(favoritePath!)).toBe(false)

    const record = {
      ...f.message,
      sendStatus: 2,
      elements: [{
        elementType: 11, elementId: 'market-element',
        marketFaceElement: {
          itemType: 6, faceInfo: 1, emojiPackageId: 42, subType: 3, mediaType: 0,
          imageWidth: 320, imageHeight: 180, faceName: '[Wave]', emojiId: 'emoji-a',
          // QQ's send confirmation can omit both animation hints even though
          // the submitted market face remains animated for other clients.
          key: '', staticFacePath: staticPath,
        },
      }],
    } satisfies MsgRecord
    f.protocolSend.mockImplementation(async () => {
      queueMicrotask(() => f.emitMessages([record]))
      return { sequence: 1n, clientSequence: 2n, sendTime: 3 }
    })
    const sent = await bridge.send({
      conversationId: 'uid-1715311957', sticker: pack!.stickers[0].reference,
    }, Readable.from([]))
    expect(f.protocolSend).toHaveBeenCalledWith(
      1, 'uid-1715311957', '1715311957', [{ kind: 'market-face', face: expect.objectContaining({
        packageId: 42, emojiId: 'emoji-a', key: 'secret',
      }) }], 'self',
    )
    expect(f.msg.sendMsg).not.toHaveBeenCalled()
    expect(sent.parts).toMatchObject([{ type: 'sticker', sticker: {
      stickerId: 'market:42:emoji-a', format: 'animated', mimeType: 'image/gif',
      reference: { animated: true, key: 'secret', dynamicPath },
    } }])

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
      stickers: [{ packId: '43', stickerId: 'market:43:emoji-a', title: 'Downloaded QQ Waves' }],
    })
    expect(f.msg.fetchMarketEmotionJsonFile).toHaveBeenCalledWith(43)
    await expect(bridge.getStickerPacks()).resolves.toMatchObject({
      packs: [
        { packId: 'qq-favorites' },
        { packId: '42', title: 'QQ Waves' },
        { packId: '43', title: 'Downloaded QQ Waves', count: 1 },
      ],
    })
  })

  it('serializes concurrent QQ market downloads and refreshes missing encryption keys', async () => {
    const f = fixture()
    const directory = await mkdtemp(join(tmpdir(), 'qqnt-market-queue-'))
    tempPaths.push(directory)
    const gif = Buffer.from('GIF89a-queued-market-sticker')
    const encrypted = gif.map((byte, index) => index % 50 < 20 ? ~byte : byte)
    const paths = new Map([
      ['first', join(directory, 'first.gif.encrypt')],
      ['second', join(directory, 'second.gif.encrypt')],
    ])
    let active = 0
    let maxActive = 0
    f.msg.getMarketEmoticonPath.mockImplementation(async (_epId, ids, serviceType) => ({
      result: 0, errMsg: '',
      pathMap: new Map(ids.map((id: string) => [id, {
        isExist: serviceType === 5 && existsSync(paths.get(id)!),
        path: serviceType === 5 ? paths.get(id)! : '',
      }])),
    }))
    f.msg.getMarketEmoticonEncryptKeys = vi.fn(async (_epId: number, ids: string[]) => ({
      result: 0, errMsg: '', encryptKeyMap: new Map(ids.map((id) => [id, `key-${id}`])),
    }))
    f.msg.fetchMarketEmoticonAioImage = vi.fn(async (request: {
      epId: number
      eId: string
      name: string
      encryptKey: string
      width: number
      height: number
      jobType: number
    }) => {
      active++
      maxActive = Math.max(maxActive, active)
      try {
        expect(request.encryptKey).toBe(`key-${request.eId}`)
        await new Promise((resolve) => setTimeout(resolve, 10))
        await writeFile(paths.get(request.eId)!, encrypted)
        return { result: 0, errMsg: '' }
      } finally {
        active--
      }
    })
    const bridge = new QQKernelBridge()
    bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: directory })
    const reference = (stickerId: string): QQStickerReference => ({
      kind: 'market', packageId: '42', stickerId, name: stickerId, key: '',
      width: 240, height: 240, animated: true, mimeType: 'image/gif',
    })

    const [first, second] = await Promise.all([
      bridge.openSticker(reference('first')),
      bridge.openSticker(reference('second')),
    ])

    expect(maxActive).toBe(1)
    expect(f.msg.fetchMarketEmoticonAioImage).toHaveBeenCalledTimes(2)
    expect(await readStream(first.stream)).toEqual(gif)
    expect(await readStream(second.stream)).toEqual(gif)
  })

  it('detects encrypted APNG market bytes for both pack and received-message sticker metadata', async () => {
    const f = fixture()
    const directory = await mkdtemp(join(tmpdir(), 'qqnt-market-apng-'))
    tempPaths.push(directory)
    const detailPath = join(directory, 'pack.json')
    const staticPath = join(directory, 'sticker.png')
    const dynamicPath = join(directory, 'sticker.gif.encrypt')
    const apng = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAwAAAAICAYAAADN5B7xAAAACXBIWXMAAAABAAAAAQBPJcTWAAAACGFjVEwAAAACAAAAAPONk3AAAAAaZmNUTAAAAAAAAAAMAAAACAAAAAAAAAAAAAEACgAAGya3gAAAABRJREFUeJxj+MPA8J8UzDCqgRYaAJjXviFq8lROAAAAGmZjVEwAAAABAAAADAAAAAgAAAAAAAAAAAABAAoAAIBVXVQAAAAXZmRBVAAAAAJ4nGNgYPj7nzQ8qoEGGgAlJ76BvcErGQAAAABJRU5ErkJggg==',
      'base64',
    )
    await writeFile(detailPath, JSON.stringify({
      name: 'APNG Pack', isApng: 1,
      imgs: [{ id: 'apng-a', wWidthInPhone: 320, wHeightInPhone: 180, isApng: 1 }],
    }))
    await writeFile(staticPath, Buffer.from('static'))
    await writeFile(dynamicPath, apng.map((byte, index) => index % 50 < 20 ? ~byte : byte))
    f.msg.fetchMarketEmoticonList.mockResolvedValue({
      result: 0, errMsg: '', marketEmoticonInfo: { roamEmojiTab: {
        timesTamp: 7, segmentFlag: -1,
        ordinaryTabinfoList: [{ epId: 44, wordingId: 9, tabType: 3, tabName: 'APNG Pack' }],
        magicTabinfoList: [], smallTabinfoList: [], epIds: [44],
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
      result: 0, errMsg: '', encryptKeyMap: new Map([['apng-a', 'secret']]),
    })
    f.message.elements = [{
      elementType: 11, elementId: 'market-apng', marketFaceElement: {
        itemType: 6, faceInfo: 1, emojiPackageId: 44, subType: 3, mediaType: 0,
        imageWidth: 320, imageHeight: 180, faceName: '[APNG]', emojiId: 'apng-a',
        emojiType: 2, key: 'secret', staticFacePath: staticPath, dynamicFacePath: dynamicPath,
      },
    }]
    const bridge = new QQKernelBridge()
    bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: directory })

    await bridge.getStickerPacks()
    const pack = await bridge.getStickerPack('44')
    expect(pack).toMatchObject({
      stickers: [{
        stickerId: 'market:44:apng-a', format: 'animated', mimeType: 'image/apng',
        reference: { mimeType: 'image/apng', dynamicPath },
      }],
    })
    const [message] = (await bridge.getHistory(bridge.getConversation('uid-1715311957'))).messages
    expect(message.parts).toMatchObject([{ type: 'sticker', sticker: {
      stickerId: 'market:44:apng-a', format: 'animated', mimeType: 'image/apng',
      reference: { mimeType: 'image/apng', dynamicPath },
    } }])
    const asset = await bridge.openSticker(pack!.stickers[0].reference)
    expect(asset.mimeType).toBe('image/apng')
    expect(await readStream(asset.stream)).toEqual(apng)

    // QQ's outgoing confirmation can omit APNG hints after the local dynamic
    // cache path has disappeared. Keep the MIME from the submitted document;
    // inferring again from the historical `.gif.encrypt` path would otherwise
    // downgrade this exact APNG sticker to image/gif in updateNewMessage.
    await rm(dynamicPath)
    const echo = {
      ...f.message,
      sendStatus: 2,
      elements: [{
        elementType: 11, elementId: 'market-apng-echo', marketFaceElement: {
          itemType: 6, faceInfo: 1, emojiPackageId: 44, subType: 3, mediaType: 0,
          imageWidth: 320, imageHeight: 180, faceName: '[APNG]', emojiId: 'apng-a',
          key: '', staticFacePath: staticPath,
        },
      }],
    } satisfies MsgRecord
    f.protocolSend.mockImplementation(async () => {
      queueMicrotask(() => f.emitMessages([echo]))
      return { sequence: 1n, clientSequence: 2n, sendTime: 3 }
    })
    const sent = await bridge.send({
      conversationId: 'uid-1715311957', sticker: pack!.stickers[0].reference,
    }, Readable.from([]))
    expect(sent.parts).toMatchObject([{ type: 'sticker', sticker: {
      stickerId: 'market:44:apng-a', format: 'animated', mimeType: 'image/apng',
      reference: { mimeType: 'image/apng' },
    } }])
  })

  it('persists byte-sniffed GIF and APNG market MIME across a bridge restart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'qqnt-market-mime-cache-'))
    tempPaths.push(directory)
    const cacheDir = join(directory, 'mime-cache')
    const detailPath = join(directory, 'pack.json')
    const staticPath = join(directory, 'sticker.png')
    const gifPath = join(directory, 'gif.gif.encrypt')
    const apngPath = join(directory, 'apng.gif.encrypt')
    const gif = Buffer.from('GIF89a-persisted-animation')
    const apng = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAwAAAAICAYAAADN5B7xAAAACXBIWXMAAAABAAAAAQBPJcTWAAAACGFjVEwAAAACAAAAAPONk3AAAAAaZmNUTAAAAAAAAAAMAAAACAAAAAAAAAAAAAEACgAAGya3gAAAABRJREFUeJxj+MPA8J8UzDCqgRYaAJjXviFq8lROAAAAGmZjVEwAAAABAAAADAAAAAgAAAAAAAAAAAABAAoAAIBVXVQAAAAXZmRBVAAAAAJ4nGNgYPj7nzQ8qoEGGgAlJ76BvcErGQAAAABJRU5ErkJggg==',
      'base64',
    )
    await writeFile(detailPath, JSON.stringify({
      name: 'Persistent MIME Pack', isApng: 0,
      imgs: [
        { id: 'gif-a', wWidthInPhone: 200, wHeightInPhone: 200 },
        { id: 'apng-a', wWidthInPhone: 200, wHeightInPhone: 200 },
      ],
    }))
    await writeFile(staticPath, Buffer.from('static'))
    await writeFile(gifPath, gif.map((byte, index) => index % 50 < 20 ? ~byte : byte))
    await writeFile(apngPath, apng.map((byte, index) => index % 50 < 20 ? ~byte : byte))

    const configure = (f: ReturnType<typeof fixture>) => {
      f.msg.fetchMarketEmoticonList.mockResolvedValue({
        result: 0, errMsg: '', marketEmoticonInfo: { roamEmojiTab: {
          timesTamp: 1, segmentFlag: -1,
          ordinaryTabinfoList: [{ epId: 45, wordingId: 1, tabType: 3, tabName: 'Persistent MIME Pack' }],
          magicTabinfoList: [], smallTabinfoList: [], epIds: [45],
        } },
      })
      f.msg.getMarketEmoticonPath.mockImplementation(async (epId, ids, serviceType) => {
        let pathMap = new Map<string, { isExist: boolean, path: string }>()
        if (serviceType === 1) pathMap = new Map([[String(epId), { isExist: true, path: detailPath }]])
        if (serviceType === 3) pathMap = new Map(ids.map((id: string) => [id, { isExist: true, path: staticPath }]))
        if (serviceType === 5) pathMap = new Map(ids.map((id: string) => [
          id, { isExist: existsSync(id === 'gif-a' ? gifPath : apngPath), path: id === 'gif-a' ? gifPath : apngPath },
        ]))
        return { result: 0, errMsg: '', pathMap }
      })
    }

    const firstFixture = fixture()
    configure(firstFixture)
    const first = new QQKernelBridge({ marketStickerMimeCacheDir: cacheDir })
    first.attach(firstFixture.kernel, firstFixture.session, {
      selfUin: '10000', selfUid: 'self', userPath: directory,
    })
    await first.getStickerPacks()
    await expect(first.getStickerPack('45')).resolves.toMatchObject({
      stickers: [
        { stickerId: 'market:45:gif-a', mimeType: 'image/gif', reference: { mimeType: 'image/gif' } },
        { stickerId: 'market:45:apng-a', mimeType: 'image/apng', reference: { mimeType: 'image/apng' } },
      ],
    })
    await expect(readFile(join(cacheDir, '10000.json'), 'utf8')).resolves.toContain(
      '"market:45:apng-a": "image/apng"',
    )

    await Promise.all([rm(gifPath), rm(apngPath)])
    const secondFixture = fixture()
    configure(secondFixture)
    secondFixture.msg.fetchMarketEmoticonAioImage = vi.fn(async () => {
      throw new Error('cached MIME must not redownload the asset')
    })
    const second = new QQKernelBridge({ marketStickerMimeCacheDir: cacheDir })
    second.attach(secondFixture.kernel, secondFixture.session, {
      selfUin: '10000', selfUid: 'self', userPath: directory,
    })
    await second.getStickerPacks()
    await expect(second.getStickerPack('45')).resolves.toMatchObject({
      stickers: [
        { stickerId: 'market:45:gif-a', mimeType: 'image/gif', reference: { mimeType: 'image/gif' } },
        { stickerId: 'market:45:apng-a', mimeType: 'image/apng', reference: { mimeType: 'image/apng' } },
      ],
    })
    expect(secondFixture.msg.fetchMarketEmoticonAioImage).not.toHaveBeenCalled()
  })

  it('byte-sniffs and persists favorite GIF, JPEG, PNG, and APNG MIME through asset open and send echo', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'qqnt-favorite-mime-cache-'))
    tempPaths.push(directory)
    const cacheDir = join(directory, 'mime-cache')
    const gif = Buffer.from('GIF89a-favorite-animation')
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, ...Buffer.from('JFIF-favorite')])
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      'base64',
    )
    const apng = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAwAAAAICAYAAADN5B7xAAAACXBIWXMAAAABAAAAAQBPJcTWAAAACGFjVEwAAAACAAAAAPONk3AAAAAaZmNUTAAAAAAAAAAMAAAACAAAAAAAAAAAAAEACgAAGya3gAAAABRJREFUeJxj+MPA8J8UzDCqgRYaAJjXviFq8lROAAAAGmZjVEwAAAABAAAADAAAAAgAAAAAAAAAAAABAAoAAIBVXVQAAAAXZmRBVAAAAAJ4nGNgYPj7nzQ8qoEGGgAlJ76BvcErGQAAAABJRU5ErkJggg==',
      'base64',
    )
    const paths = new Map([
      ['gif-favorite', join(directory, 'gif-wrong.jpg')],
      ['jpeg-favorite', join(directory, 'jpeg-wrong.png')],
      ['png-favorite', join(directory, 'png-animated-hint.gif')],
      ['apng-favorite', join(directory, 'apng-wrong.jpg')],
    ])
    await Promise.all([
      writeFile(paths.get('gif-favorite')!, gif),
      writeFile(paths.get('jpeg-favorite')!, jpeg),
      writeFile(paths.get('png-favorite')!, png),
      writeFile(paths.get('apng-favorite')!, apng),
    ])
    const configure = (f: ReturnType<typeof fixture>) => {
      f.msg.fetchFavEmojiList.mockResolvedValue({
        result: 0, errMsg: '', emojiInfoList: [...paths].map(([resId, path]) => ({
          emoPath: path, emoOriginalPath: path, thumbPath: path,
          isExist: existsSync(path), resId, url: '', md5: resId === 'gif-favorite' ? 'gif-md5' : resId,
          // A false APNG hint must not hide real acTL bytes, while the static
          // PNG filename deliberately carries a misleading animated suffix.
          isAPNG: false, isMarkFace: false, eId: '', epId: '', desc: resId,
        })),
      })
    }

    const firstFixture = fixture()
    configure(firstFixture)
    const first = new QQKernelBridge({ marketStickerMimeCacheDir: cacheDir })
    first.attach(firstFixture.kernel, firstFixture.session, {
      selfUin: '10000', selfUid: 'self', userPath: directory,
    })
    const firstPack = await first.getStickerPack('qq-favorites')
    expect(firstPack).not.toBeNull()
    const firstStickers = firstPack!.stickers
    expect(firstStickers).toMatchObject([
      { stickerId: 'favorite:gif-favorite', format: 'animated', mimeType: 'image/gif', reference: { mimeType: 'image/gif', animated: true } },
      { stickerId: 'favorite:jpeg-favorite', format: 'static', mimeType: 'image/jpeg', reference: { mimeType: 'image/jpeg', animated: false } },
      { stickerId: 'favorite:png-favorite', format: 'static', mimeType: 'image/png', reference: { mimeType: 'image/png', animated: false } },
      { stickerId: 'favorite:apng-favorite', format: 'animated', mimeType: 'image/apng', reference: { mimeType: 'image/apng', animated: true } },
    ])
    for (const [index, expected] of [gif, jpeg, png, apng].entries()) {
      const opened = await first.openSticker(firstStickers[index]!.reference)
      const chunks: Buffer[] = []
      for await (const chunk of opened.stream) chunks.push(Buffer.from(chunk))
      expect(Buffer.concat(chunks)).toEqual(expected)
      expect(opened.mimeType).toBe(firstStickers[index]!.mimeType)
    }

    const gifReference = firstStickers[0]!.reference
    firstFixture.protocolSend.mockImplementationOnce(async (chatType, peerUid, peerUin) => {
      queueMicrotask(() => firstFixture.emitSent({
        ...firstFixture.message, chatType, peerUid, peerUin, sendStatus: 2,
        elements: [{ elementType: 2, elementId: 'gif-image', picElement: {
          fileName: 'still-wrong.jpg', fileSize: String(gif.length), sourcePath: paths.get('gif-favorite'),
          fileUuid: 'gif-uuid', fileSubId: '', md5HexStr: 'gif-md5',
          picWidth: 1, picHeight: 1, picSubType: 1,
        } }],
      }))
      return { sequence: 1n, clientSequence: 2n, sendTime: 3 }
    })
    const sent = await first.send({ conversationId: 'uid-1715311957', sticker: gifReference }, Readable.from([]))
    expect(firstFixture.imageUpload).toHaveBeenCalledWith(
      1, 'uid-1715311957', '10000', expect.objectContaining({ picType: 2000 }), expect.anything(),
    )
    expect(sent.parts).toMatchObject([{ type: 'sticker', sticker: {
      stickerId: 'favorite:gif-md5', format: 'animated', mimeType: 'image/gif',
      reference: { mimeType: 'image/gif', animated: true },
    } }])

    const cached = JSON.parse(await readFile(join(cacheDir, '10000.json'), 'utf8')) as {
      mimeTypes: Record<string, string>
    }
    expect(cached.mimeTypes).toMatchObject({
      'favorite:gif-favorite': 'image/gif',
      'favorite:jpeg-favorite': 'image/jpeg',
      'favorite:png-favorite': 'image/png',
      'favorite:apng-favorite': 'image/apng',
    })

    await Promise.all([...paths.values()].map((path) => rm(path)))
    const secondFixture = fixture()
    configure(secondFixture)
    const second = new QQKernelBridge({ marketStickerMimeCacheDir: cacheDir })
    second.attach(secondFixture.kernel, secondFixture.session, {
      selfUin: '10000', selfUid: 'self', userPath: directory,
    })
    await expect(second.getStickerPack('qq-favorites')).resolves.toMatchObject({
      stickers: [
        { stickerId: 'favorite:gif-favorite', format: 'animated', mimeType: 'image/gif' },
        { stickerId: 'favorite:jpeg-favorite', format: 'static', mimeType: 'image/jpeg' },
        { stickerId: 'favorite:png-favorite', format: 'static', mimeType: 'image/png' },
        { stickerId: 'favorite:apng-favorite', format: 'animated', mimeType: 'image/apng' },
      ],
    })
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
        sourcePath: '/qq/cache/original.png',
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

  it('exposes QQ\'s 720-tier image as a remote direct-link preview without reading thumbPath', async () => {
    const f = fixture()
    f.message.elements = [{
      elementType: 2, elementId: 'picture-with-native-tiers',
      picElement: {
        fileName: 'original.jpg', fileSize: '320332', picWidth: 2832, picHeight: 1280,
        md5HexStr: 'image-md5', fileUuid: 'image-uuid', fileSubId: '', picSubType: 0,
        thumbFileSize: 82341,
        originImageUrl: 'https://multimedia.nt.qq.com.cn/download?appid=1407&fileid=image&rkey=expired',
        thumbPath: new Map([[0, '/missing/image_0.jpg'], [720, '/missing/image_720.jpg']]),
      },
    }]
    const bridge = new QQKernelBridge()
    bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: '/tmp' })

    const [message] = (await bridge.getHistory(bridge.getConversation('uid-1715311957'))).messages
    const part = message.parts[0]
    if (part?.type !== 'media' || !part.media.preview) throw new Error('expected native image preview')
    expect(part.media).toMatchObject({
      width: 2832,
      height: 1280,
      preview: {
        width: 1280, height: 579, size: 82341,
        locator: {
          fileName: 'original.jpg', filePath: undefined, fileSize: '82341', imageSpec: 720,
          originImageUrl: 'https://multimedia.nt.qq.com.cn/download?appid=1407&fileid=image&rkey=expired',
        },
      },
      locator: { filePath: undefined, fileUuid: 'image-uuid', imageSpec: 0 },
    })
    await expect(bridge.openMedia(part.media.preview.locator)).resolves.toBeUndefined()
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
      packs: [
        { packId: 'qq-favorites', count: 0 },
        { packId: '41' }, { packId: '42' }, { packId: '43' },
      ],
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
        { packId: 'qq-favorites', title: 'QQ 收藏表情', count: 0 },
        { packId: '51', title: 'Installed' },
        { packId: '53', title: 'Second' },
      ],
    })
    expect(f.msg.fetchBottomEmojiTableList).toHaveBeenNthCalledWith(2, {
      commonReqInfo: { appVersion: '', businessId: 0 }, timeStamp: 0, segmentFlag: 7,
    })
    expect(f.msg.fetchMarketEmoticonList).not.toHaveBeenCalled()
  })

  it('falls back to the roam market table when the current bottom table is empty', async () => {
    const f = fixture()
    f.msg.fetchBottomEmojiTableList = vi.fn(async () => ({
      result: 0, errMsg: '', marketEmoticonInfo: {
        segmentFlag: -1, emojiNewTabs: [],
      },
    }))
    f.msg.fetchMarketEmoticonList.mockResolvedValue({
      result: 0, errMsg: '', marketEmoticonInfo: { roamEmojiTab: {
        timesTamp: 1, segmentFlag: -1,
        ordinaryTabinfoList: [{ epId: 11474, wordingId: 9, tabType: 3, tabName: 'Installed Market Pack' }],
        magicTabinfoList: [], smallTabinfoList: [], epIds: [11474],
      } },
    })
    const bridge = new QQKernelBridge()
    bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: '/tmp' })

    await expect(bridge.getStickerPacks()).resolves.toMatchObject({
      packs: [
        { packId: 'qq-favorites', title: 'QQ 收藏表情', count: 0 },
        { packId: '11474', title: 'Installed Market Pack' },
      ],
    })
    expect(f.msg.fetchBottomEmojiTableList).toHaveBeenCalledTimes(1)
    expect(f.msg.fetchMarketEmoticonList).toHaveBeenCalledWith(0, 0)
  })

  it('accepts installed market tabs returned inside the current API roam table', async () => {
    const f = fixture()
    f.msg.fetchBottomEmojiTableList = vi.fn(async () => ({
      result: 0, errMsg: '', marketEmoticonInfo: {
        segmentFlag: -1, emojiNewTabs: [], roamEmojiTab: {
          timesTamp: 1, segmentFlag: -1,
          ordinaryTabinfoList: [{ epId: 11474, wordingId: 9, tabType: 3, tabName: 'Nested Installed Pack' }],
          magicTabinfoList: [], smallTabinfoList: [], epIds: [11474],
        },
      },
    }))
    const bridge = new QQKernelBridge()
    bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: '/tmp' })

    await expect(bridge.getStickerPacks()).resolves.toMatchObject({
      packs: [
        { packId: 'qq-favorites' },
        { packId: '11474', title: 'Nested Installed Pack' },
      ],
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
        emoPath: path, isExist: true, resId: 'fav-res', url: 'https://cdn.example/fav-res.png', md5: 'fav-md5',
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
    expect(f.msg.fetchFavEmojiList).toHaveBeenCalledWith('', 200, true, true)
    const reference = page.stickers[0].reference
    expect(reference).toMatchObject({ url: 'https://cdn.example/fav-res.png' })
    await bridge.setSavedSticker(reference, true)
    expect(f.msg.addFavEmoji).toHaveBeenCalledWith(expect.objectContaining({
      emojiPath: path, isMarkFace: false, md5: 'fav-md5',
    }))
    await bridge.setSavedSticker(reference, false)
    expect(f.msg.deleteFavEmoji).toHaveBeenCalledWith(['fav-res'])
  })

  it('probes and caches missing remote favorite dimensions without downloading the full asset', async () => {
    const f = fixture()
    const png = completePng(512, 286)
    const gif = Buffer.alloc(10)
    gif.write('GIF89a', 0, 'ascii')
    gif.writeUInt16LE(320, 6)
    gif.writeUInt16LE(180, 8)
    f.msg.fetchFavEmojiList.mockResolvedValue({
      result: 0, errMsg: '', emojiInfoList: [{
        emoPath: '', isExist: false, resId: 'remote-png', url: 'https://cdn.example/remote.png', md5: 'png-md5',
        emoOriginalPath: '', thumbPath: '', isAPNG: false, isMarkFace: false,
        eId: '', epId: '', desc: 'Wide PNG',
      }, {
        emoPath: '', isExist: false, resId: 'remote-gif', url: 'https://cdn.example/remote.gif', md5: 'gif-md5',
        emoOriginalPath: '', thumbPath: '', isAPNG: false, isMarkFace: false,
        eId: '', epId: '', desc: 'Wide GIF',
      }],
    })
    const fetchAsset = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
      const bytes = String(input).endsWith('.gif') ? gif : png
      const total = String(input).endsWith('.gif') ? 98_765 : 12_345
      return new Response(bytes, {
        status: 206,
        headers: {
          'content-type': String(input).endsWith('.gif') ? 'image/gif' : 'image/png',
          'content-range': `bytes 0-${bytes.length - 1}/${total}`,
        },
      })
    })
    vi.stubGlobal('fetch', fetchAsset)
    const bridge = new QQKernelBridge()
    bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: '/tmp' })

    const first = await bridge.getSavedStickers()
    const second = await bridge.getSavedStickers()

    expect(first.stickers).toMatchObject([{
      stickerId: 'favorite:remote-png', format: 'static', mimeType: 'image/png',
      width: 512, height: 286, size: 12_345, version: 2,
      reference: { width: 512, height: 286, size: 12_345, mimeType: 'image/png' },
    }, {
      stickerId: 'favorite:remote-gif', format: 'animated', mimeType: 'image/gif',
      width: 320, height: 180, size: 98_765, version: 2,
      reference: { width: 320, height: 180, size: 98_765, mimeType: 'image/gif' },
    }])
    expect(second.stickers).toMatchObject(first.stickers)
    expect(fetchAsset).toHaveBeenCalledTimes(2)
    for (const [, init] of fetchAsset.mock.calls) {
      expect(init).toMatchObject({ headers: { range: 'bytes=0-262143' } })
      expect(init?.signal).toBeInstanceOf(AbortSignal)
    }
  })

  it('keeps an unavailable remote favorite in the collection when metadata probing fails', async () => {
    const f = fixture()
    f.msg.fetchFavEmojiList.mockResolvedValue({
      result: 0, errMsg: '', emojiInfoList: [{
        emoPath: '', isExist: false, resId: 'unavailable', url: 'https://cdn.example/unavailable.png', md5: '',
        emoOriginalPath: '', thumbPath: '', isAPNG: false, isMarkFace: false,
        eId: '', epId: '', desc: 'Unavailable',
      }],
    })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 503 })))
    const bridge = new QQKernelBridge()
    bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: '/tmp' })

    await expect(bridge.getSavedStickers()).resolves.toMatchObject({
      stickers: [{ stickerId: 'favorite:unavailable', width: undefined, height: undefined }],
    })
  })

  it('refreshes only the first page of the native QQ favorite collection', async () => {
    const f = fixture()
    const bridge = new QQKernelBridge()
    bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: '/tmp' })

    await bridge.getSavedStickers(undefined, 40)
    await bridge.getSavedStickers('next-favorite', 40)

    expect(f.msg.fetchFavEmojiList).toHaveBeenNthCalledWith(1, '', 40, true, true)
    expect(f.msg.fetchFavEmojiList).toHaveBeenNthCalledWith(2, 'next-favorite', 40, true, false)
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

    expect(f.msg.getRichMediaFilePath).not.toHaveBeenCalled()
    expect(f.imageUpload).toHaveBeenCalledWith(
      1, 'uid-1715311957', '10000', expect.objectContaining({
        name: 'favorite.png', size: png.length, picSubType: 1,
        md5: 'e44e7ecfec99356632c13cd3eaa3e250',
      }), expect.anything(),
    )
    expect(f.protocolSend).toHaveBeenCalledWith(
      1, 'uid-1715311957', '1715311957', [expect.objectContaining({ kind: 'image' })], 'self',
    )
    expect(f.msg.sendMsg).not.toHaveBeenCalled()
    expect(f.sentBodies).toEqual([png])
    await expect(readFile(sourcePath)).resolves.toEqual(png)
  })

  it('downloads and stages a remote-only favorite sticker before native send', async () => {
    const f = fixture()
    const directory = await mkdtemp(join(tmpdir(), 'qqnt-remote-favorite-send-'))
    tempPaths.push(directory)
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      'base64',
    )
    const fetch = vi.fn(async () => new Response(png, {
      headers: { 'content-type': 'image/png', 'content-length': String(png.length) },
    }))
    vi.stubGlobal('fetch', fetch)
    const bridge = new QQKernelBridge()
    bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: directory })

    await bridge.send({
      conversationId: 'uid-1715311957',
      sticker: {
        kind: 'favorite', resId: 'remote-favorite', path: join(directory, 'missing.png'),
        url: 'https://cdn.example/remote-favorite.png', name: 'remote-favorite.png', animated: false,
      },
    }, Readable.from([]))

    expect(fetch).toHaveBeenCalledWith('https://cdn.example/remote-favorite.png')
    expect(f.imageUpload).toHaveBeenCalledWith(
      1, 'uid-1715311957', '10000', expect.objectContaining({
        name: 'remote-favorite.png', size: png.length, picSubType: 1,
        md5: 'e44e7ecfec99356632c13cd3eaa3e250', picType: 1001,
      }), expect.anything(),
    )
    expect(f.sentBodies).toEqual([png])
  })

  it.each(['', ' \t '])('fails closed for blank user ID %j', async (uid) => {
    const f = fixture()
    const bridge = new QQKernelBridge()
    bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: '/tmp' })
    f.uix.getUin.mockClear()
    f.profile.getUserSimpleInfo.mockClear()

    await expect(bridge.getUser(uid)).resolves.toBeUndefined()

    expect(f.uix.getUin).not.toHaveBeenCalled()
    expect(f.profile.getUserSimpleInfo).not.toHaveBeenCalled()
  })

  it('filters blank UIDs from the buddy snapshot', async () => {
    const f = fixture()
    const bridge = new QQKernelBridge()
    bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: '/tmp' })
    f.emitBuddyList([{ buddyList: [
      { uid: '', uin: '1', nick: 'Empty', remark: '', avatarUrl: '' },
      { uid: ' \t ', uin: '2', nick: 'Blank', remark: '', avatarUrl: '' },
      { uid: 'friend', uin: '3', nick: 'Friend', remark: '', avatarUrl: '' },
    ] }])

    await expect(bridge.getContacts()).resolves.toMatchObject({
      users: expect.arrayContaining([expect.objectContaining({ id: 'friend' })]),
    })
    const users = (bridge as unknown as { users: Map<string, unknown> }).users
    expect(users.has('')).toBe(false)
    expect(users.has(' \t ')).toBe(false)
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

  it.each([
    ['placeholder-undefined', '10001', ' \tUnDeFiNeD '],
    ['placeholder-null', '10002', ' NuLl '],
  ])('does not expose a literal placeholder name through getContacts or getUser', async (uid, uin, name) => {
    const f = fixture()
    f.buddy.getBuddyNick.mockReturnValue(new Map())
    const bridge = new QQKernelBridge()
    bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: '/tmp' })
    f.emitBuddyList([{ buddyList: [{ uid, uin, nick: name, remark: '', avatarUrl: '' }] }])

    await expect(bridge.getContacts()).resolves.toMatchObject({
      users: expect.arrayContaining([expect.objectContaining({ id: uid, name: uin })]),
    })
    const user = await bridge.getUser(uid)
    if (!user) throw new Error(`Expected getUser(${uid}) to return a user`)
    expect(user).toMatchObject({ id: uid })
    expect(user.name.trim().toLowerCase()).not.toMatch(/^(undefined|null)$/)
  })

  it('exposes the verified QQ group message mask values', () => {
    expect(GroupMsgMask).toMatchObject({
      UNSPECIFIED: 0,
      NOTIFY: 1,
      ASSISTANT: 2,
      SHIELD: 3,
      RECEIVE: 4,
    })
  })

  it('caches the group message mask callback for group conversations', () => {
    const f = fixture()
    const bridge = new QQKernelBridge()
    bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: '/tmp' })

    expect(f.group.getGroupMsgMask).toHaveBeenCalledTimes(1)
    f.emitGroupMsgMasks([{ groupCode: '1058754719', msgMask: GroupMsgMask.RECEIVE }])

    expect(bridge.getConversation('1058754719')).toMatchObject({
      kind: 'group', groupMsgMask: GroupMsgMask.RECEIVE,
    })
  })

  it.each(['mask-before-profile', 'profile-before-mask'] as const)(
    'materializes an assistant group when masks arrive %s',
    async (order) => {
      const f = fixture()
      const bridge = new QQKernelBridge()
      bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: '/tmp' })
      const group = { groupCode: '1058754719', groupName: 'Bridge Test Group' }
      const mask = [{ groupCode: group.groupCode, msgMask: GroupMsgMask.ASSISTANT }]

      if (order === 'mask-before-profile') {
        f.emitGroupMsgMasks(mask)
        f.emitGroupList([group])
      } else {
        f.emitGroupList([group])
        f.emitGroupMsgMasks(mask)
      }

      await expect(bridge.getDialogs()).resolves.toMatchObject({
        conversations: [expect.objectContaining({
          id: group.groupCode,
          kind: 'group',
          title: group.groupName,
          groupMsgMask: GroupMsgMask.ASSISTANT,
        })],
      })
    },
  )

  it('waits for a delayed group mask callback before returning the first dialog page', async () => {
    const f = fixture()
    f.group.getGroupMsgMask.mockImplementation(async () => {
      setTimeout(() => f.emitGroupMsgMasks([
        { groupCode: '1058754719', msgMask: GroupMsgMask.ASSISTANT },
      ]), 25)
      return { result: 0, errMsg: 'success' }
    })
    const bridge = new QQKernelBridge()
    bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: '/tmp' })
    f.emitGroupList([{ groupCode: '1058754719', groupName: 'Delayed Assistant Group' }])

    await expect(bridge.getDialogs()).resolves.toMatchObject({
      conversations: expect.arrayContaining([expect.objectContaining({
        id: '1058754719', groupMsgMask: GroupMsgMask.ASSISTANT,
      })]),
    })
  })

  it('retries a failed initial group mask request within the same initialization', async () => {
    const f = fixture()
    let calls = 0
    f.group.getGroupMsgMask.mockImplementation(async () => {
      calls++
      if (calls === 1) return { result: -1, errMsg: 'retry' }
      queueMicrotask(() => f.emitGroupMsgMasks([
        { groupCode: '1058754719', msgMask: GroupMsgMask.ASSISTANT },
      ]))
      return { result: 0, errMsg: 'success' }
    })
    const bridge = new QQKernelBridge()
    bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: '/tmp' })
    f.emitGroupList([{ groupCode: '1058754719', groupName: 'Retried Assistant Group' }])

    await expect(bridge.getDialogs()).resolves.toMatchObject({
      conversations: [expect.objectContaining({ id: '1058754719' })],
    })
    expect(calls).toBe(2)
  })

  it('retries group masks on a later contact refresh after initial failures', async () => {
    const f = fixture()
    let calls = 0
    f.group.getGroupMsgMask.mockImplementation(async () => {
      calls++
      if (calls <= 2) return { result: -1, errMsg: 'retry' }
      queueMicrotask(() => f.emitGroupMsgMasks([
        { groupCode: '1058754719', msgMask: GroupMsgMask.ASSISTANT },
      ]))
      return { result: 0, errMsg: 'success' }
    })
    const bridge = new QQKernelBridge()
    bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: '/tmp' })
    f.emitGroupList([{ groupCode: '1058754719', groupName: 'Later Assistant Group' }])
    await new Promise<void>((resolve) => setImmediate(resolve))

    await bridge.refreshContacts()

    expect(calls).toBe(3)
    await expect(bridge.getDialogs()).resolves.toMatchObject({
      conversations: expect.arrayContaining([expect.objectContaining({ id: '1058754719' })]),
    })
  })

  it('removes only assistant-materialized groups when their mask changes', async () => {
    const f = fixture()
    const bridge = new QQKernelBridge()
    bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: '/tmp' })
    f.emitGroupMsgMasks([{ groupCode: '1058754719', msgMask: GroupMsgMask.ASSISTANT }])
    f.emitGroupList([{ groupCode: '1058754719', groupName: 'Assistant Group' }])
    f.emitGroupMsgMasks([{ groupCode: '1058754719', msgMask: GroupMsgMask.NOTIFY }])

    await expect(bridge.getDialogs()).resolves.not.toMatchObject({
      conversations: [expect.objectContaining({ id: '1058754719' })],
    })
  })

  it('removes assistant-materialized groups when a profile mask leaves assistant', async () => {
    const f = fixture()
    const bridge = new QQKernelBridge()
    bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: '/tmp' })
    f.emitGroupMsgMasks([{ groupCode: '1058754719', msgMask: GroupMsgMask.ASSISTANT }])
    f.emitGroupList([{ groupCode: '1058754719', groupName: 'Assistant Group' }])
    f.emitGroupList([{
      groupCode: '1058754719', groupName: 'Assistant Group', cmdUinMsgMask: GroupMsgMask.NOTIFY,
    }])

    await expect(bridge.getDialogs()).resolves.not.toMatchObject({
      conversations: [expect.objectContaining({ id: '1058754719' })],
    })
  })

  it('keeps recent groups when their assistant mask changes', async () => {
    const f = fixture()
    f.recent.getRecentContactInfos.mockResolvedValue({
      result: 0, errMsg: '', relation: [{
        chatType: 2, peerUid: '1058754719', peerUin: '1058754719', peerName: 'Recent Group',
        remark: '', avatarUrl: '', unreadCnt: '0', msgId: 'm1', msgTime: '1800000000',
        senderUid: 'member', senderUin: '42', abstractContent: [],
      }],
    })
    const bridge = new QQKernelBridge()
    bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: '/tmp' })
    f.emitGroupMsgMasks([{ groupCode: '1058754719', msgMask: GroupMsgMask.ASSISTANT }])
    f.emitGroupList([{ groupCode: '1058754719', groupName: 'Recent Group' }])
    await bridge.refreshContacts()
    f.emitGroupMsgMasks([{ groupCode: '1058754719', msgMask: GroupMsgMask.NOTIFY }])

    await expect(bridge.getDialogs()).resolves.toMatchObject({
      conversations: expect.arrayContaining([expect.objectContaining({
        id: '1058754719', groupMsgMask: GroupMsgMask.NOTIFY,
      })]),
    })
  })

  it('keeps explicitly resolved groups when their assistant mask changes', async () => {
    const f = fixture()
    const bridge = new QQKernelBridge()
    bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: '/tmp' })
    f.emitGroupMsgMasks([{ groupCode: '1058754719', msgMask: GroupMsgMask.ASSISTANT }])
    f.emitGroupList([{ groupCode: '1058754719', groupName: 'Resolved Group' }])
    await bridge.resolveConversation(2, '1058754719')
    f.emitGroupMsgMasks([{ groupCode: '1058754719', msgMask: GroupMsgMask.NOTIFY }])

    await expect(bridge.getDialogs()).resolves.toMatchObject({
      conversations: [expect.objectContaining({
        id: '1058754719', groupMsgMask: GroupMsgMask.NOTIFY,
      })],
    })
  })

  it('preserves unknown raw masks and ignores incomplete callback items', () => {
    const f = fixture()
    const bridge = new QQKernelBridge()
    bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: '/tmp' })
    f.emitGroupMsgMasks([
      { groupCode: '1058754719', msgMask: 99 },
      { groupCode: 'incomplete' },
      { msgMask: GroupMsgMask.ASSISTANT },
    ])
    f.emitGroupList([{
      groupCode: '2000000000', groupName: 'Unknown Profile Mask', cmdUinMsgMask: 98,
    }])

    expect(bridge.getConversation('1058754719')).toMatchObject({ groupMsgMask: 99 })
    expect(bridge.getConversation('2000000000')).toMatchObject({ groupMsgMask: 98 })
  })

  it('setGroupMsgMask updates the cache and conversation immediately on success', async () => {
    const f = fixture()
    const bridge = new QQKernelBridge()
    bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: '/tmp' })
    f.emitGroupList([{ groupCode: '1058754719', groupName: 'Bridge Test Group' }])
    f.emitGroupMsgMasks([{ groupCode: '1058754719', msgMask: GroupMsgMask.NOTIFY }])

    await bridge.setGroupMsgMask('1058754719', GroupMsgMask.SHIELD)

    expect(f.group.setGroupMsgMask).toHaveBeenCalledWith('1058754719', GroupMsgMask.SHIELD)
    expect(bridge.getConversation('1058754719')).toMatchObject({
      id: '1058754719',
      kind: 'group',
      groupMsgMask: GroupMsgMask.SHIELD,
    })
  })

  it('setGroupMsgMask leaves the assistant materialization path when leaving ASSISTANT', async () => {
    const f = fixture()
    const bridge = new QQKernelBridge()
    bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: '/tmp' })
    f.emitGroupMsgMasks([{ groupCode: '1058754719', msgMask: GroupMsgMask.ASSISTANT }])
    f.emitGroupList([{ groupCode: '1058754719', groupName: 'Assistant Group' }])

    await bridge.setGroupMsgMask('1058754719', GroupMsgMask.NOTIFY)

    expect(bridge.getConversation('1058754719')).toMatchObject({
      id: '1058754719',
      groupMsgMask: GroupMsgMask.NOTIFY,
    })
  })

  it('setGroupMsgMask throws when the native setter fails and keeps the prior mask', async () => {
    const f = fixture()
    const bridge = new QQKernelBridge()
    bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: '/tmp' })
    f.emitGroupList([{ groupCode: '1058754719', groupName: 'Bridge Test Group' }])
    f.emitGroupMsgMasks([{ groupCode: '1058754719', msgMask: GroupMsgMask.NOTIFY }])
    f.group.setGroupMsgMask.mockResolvedValue({ result: -1, errMsg: 'denied' })

    await expect(bridge.setGroupMsgMask('1058754719', GroupMsgMask.SHIELD))
      .rejects.toThrow(/setGroupMsgMask: denied \(-1\)/)
    expect(bridge.getConversation('1058754719')).toMatchObject({ groupMsgMask: GroupMsgMask.NOTIFY })
  })

  it('setGroupMsgMask throws a clear error when the native setter is unavailable', async () => {
    const f = fixture()
    const bridge = new QQKernelBridge()
    bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: '/tmp' })
    f.group.setGroupMsgMask = undefined as unknown as typeof f.group.setGroupMsgMask

    await expect(bridge.setGroupMsgMask('1058754719', GroupMsgMask.SHIELD))
      .rejects.toThrow(/setGroupMsgMask/)
  })

  it('setGroupMsgMask defers to a later listener callback without double-applying the local value', async () => {
    const f = fixture()
    const bridge = new QQKernelBridge()
    bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: '/tmp' })
    f.emitGroupList([{ groupCode: '1058754719', groupName: 'Bridge Test Group' }])
    f.emitGroupMsgMasks([{ groupCode: '1058754719', msgMask: GroupMsgMask.NOTIFY }])

    await bridge.setGroupMsgMask('1058754719', GroupMsgMask.SHIELD)
    // Native callback arrives later with the authoritative value; it overwrites.
    f.emitGroupMsgMasks([{ groupCode: '1058754719', msgMask: GroupMsgMask.RECEIVE }])

    expect(bridge.getConversation('1058754719')).toMatchObject({ groupMsgMask: GroupMsgMask.RECEIVE })
  })

  it('refreshes a placeholder group dialog title through getDialogs', async () => {
    const f = fixture()
    f.recent.getRecentContactInfos.mockResolvedValue({
      result: 0, errMsg: '', relation: [{
        chatType: 2, peerUid: '1058754719', peerUin: '1058754719', peerName: ' NuLl ', remark: '',
        avatarUrl: '', unreadCnt: '0', msgId: 'm1', msgTime: '1800000000', senderUid: 'member', senderUin: '42',
        abstractContent: [],
      }],
    })
    f.group.getGroupDetailInfo.mockImplementation(async (groupCode, _source) => {
      f.emitGroupDetail({ groupCode, groupName: 'Bridge Test Group' })
      return { result: 0, errMsg: '' }
    })
    const bridge = new QQKernelBridge()
    bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: '/tmp' })

    const dialogs = await bridge.getDialogs()

    expect(f.group.getGroupDetailInfo).toHaveBeenCalledWith('1058754719', 5)
    expect(dialogs.conversations).toContainEqual(expect.objectContaining({
      id: '1058754719', title: 'Bridge Test Group',
    }))
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

  it('keeps a group member personal name and alias separate and uses a QQNT direct avatar URL on profile resolve', async () => {
    const f = fixture()
    f.setAvatarUrl('member', 'https://thirdqq.qlogo.cn/avatar/member/140')
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
      avatar: { locator: { avatarUrl: 'https://thirdqq.qlogo.cn/avatar/member/140' } },
    })
  })

  it('prefers the UID-scoped QQNT avatar URL over the legacy UIN qlogo endpoint', async () => {
    const f = fixture()
    const bridge = new QQKernelBridge()
    f.setAvatarUrl('special-avatar', 'https://thirdqq.qlogo.cn/avatar/special/140')
    bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: '/tmp' })
    f.emitBuddyList([{ buddyList: [{
      uid: 'special-avatar', uin: '472247053', nick: 'Be Amdish', remark: '', avatarUrl: '',
    }] }])

    const contacts = await bridge.getContacts()
    expect(contacts.users.find((user) => user.id === 'special-avatar')?.avatar).toMatchObject({
      locator: {
        avatarUrl: 'https://thirdqq.qlogo.cn/avatar/special/140',
        peerUid: 'special-avatar',
      },
    })
    expect(contacts.users.find((user) => user.id === 'special-avatar')?.avatar?.locator)
      .not.toHaveProperty('avatarUin')
    expect(f.forceDownloadAvatar).not.toHaveBeenCalled()
    expect(f.buddy.getAvatarUrl).toHaveBeenCalledWith(['special-avatar'], 2)
  })

  it('keeps qlogo as the zero-copy fallback when QQNT has no UID-scoped avatar URL', async () => {
    const f = fixture()
    const bridge = new QQKernelBridge()
    f.setAvatarPath('')
    bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: '/tmp' })
    f.emitBuddyList([{ buddyList: [{
      uid: 'ordinary-avatar', uin: '123456789', nick: 'Ordinary', remark: '', avatarUrl: '',
    }] }])

    await expect(bridge.getUser('ordinary-avatar')).resolves.toMatchObject({
      avatar: { locator: { avatarUin: '123456789' } },
    })
    expect(f.forceDownloadAvatar).not.toHaveBeenCalled()
  })

  it('maps administrator promotion and demotion to QQ native member roles', async () => {
    const f = fixture()
    const bridge = new QQKernelBridge()
    bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: '/tmp' })
    const conversation = bridge.getConversation('1058754719')

    await bridge.setMemberRole(conversation, 'member/opaque', 'administrator')
    await bridge.setMemberRole(conversation, 'member/opaque', 'member')

    expect(f.group.modifyMemberRole).toHaveBeenNthCalledWith(1, '1058754719', 'member/opaque', 3)
    expect(f.group.modifyMemberRole).toHaveBeenNthCalledWith(2, '1058754719', 'member/opaque', 2)
  })

  it('fails closed when QQ cannot mutate a member role', async () => {
    const f = fixture()
    const bridge = new QQKernelBridge()
    bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: '/tmp' })
    const group = bridge.getConversation('1058754719')

    f.group.modifyMemberRole.mockResolvedValueOnce({ result: 120101005, errMsg: 'not owner' })
    await expect(bridge.setMemberRole(group, 'member', 'administrator'))
      .rejects.toThrow('modifyMemberRole: not owner (120101005)')

    const direct = { ...group, id: '1:member', kind: 'direct' as const, chatType: 1 as const }
    await expect(bridge.setMemberRole(direct, 'member', 'administrator'))
      .rejects.toThrow('member roles are only supported for group conversations')
    expect(f.group.modifyMemberRole).toHaveBeenCalledTimes(1)
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

  it('publishes first-seen reaction info with only the inline actor preview', async () => {
    const f = fixture()
    const bridge = new QQKernelBridge()
    bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: '/tmp' })
    const events = bridge.subscribe()[Symbol.asyncIterator]()
    f.msg.getMsgEmojiLikesList.mockResolvedValue({
      result: 0, errMsg: '', cookie: 'next', isFirstPage: true, isLastPage: false,
      emojiLikesList: [
        { tinyId: 'actor-a', nickName: 'Alice', headUrl: 'https://example.com/a.jpg' },
        { tinyId: 'actor-b', nickName: 'Bob', headUrl: '' },
        { tinyId: 'actor-c', nickName: 'Carol', headUrl: '' },
      ],
    })

    f.emitMessages([{
      ...f.message,
      chatType: 2,
      peerUid: '1058754719',
      peerUin: '1058754719',
      emojiLikesList: [{ emojiType: '2', emojiId: '128522', likesCnt: '5', isClicked: false }],
    }])

    await expect(events.next()).resolves.toMatchObject({
      value: { type: 'message', message: { id: f.message.msgId } },
    })
    await expect(events.next()).resolves.toMatchObject({
      value: {
        type: 'message-reactions',
        target: { messageId: f.message.msgId },
        context: {
          reactions: [{
            key: '2:128522',
            count: 5,
            recentActors: [
              { userId: 'actor-a' }, { userId: 'actor-b' }, { userId: 'actor-c' },
            ],
          }],
        },
      },
    })
    expect(f.msg.getMsgEmojiLikesList).toHaveBeenCalledWith(
      expect.objectContaining({ peerUid: '1058754719' }), 'seq1', '128522', '2', '', false, 3,
    )
  })

  it('applies pushed group reactions to a cached message without polling or gray tips', async () => {
    const f = fixture()
    const bridge = new QQKernelBridge()
    vi.spyOn(bridge as unknown as { initializePlatformData(): Promise<void> }, 'initializePlatformData').mockResolvedValue()
    bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: '/tmp' })
    const conversation = bridge.getConversation('1058754719')
    const target = {
      ...f.message,
      msgId: 'pushed-reaction-target', msgSeq: '799177', chatType: 2 as const,
      peerUid: '1058754719', peerUin: '1058754719', sendType: 0,
      senderUid: 'member-a', senderUin: '42', emojiLikesList: [],
    }
    f.msg.getLatestDbMsgs.mockResolvedValue({ result: 0, errMsg: '', msgList: [target] })
    await bridge.getHistory(conversation)
    f.msg.getMsgsByMsgId.mockClear()
    f.msg.getMsgsBySeqAndCount.mockClear()
    const events = bridge.subscribe()[Symbol.asyncIterator]()

    f.emitS2C(groupReactionPushBytes({ operatorUid: 'actor-a', currentCount: 1 }))
    await expect(events.next()).resolves.toMatchObject({ value: {
      type: 'message-reactions',
      eventId: expect.stringMatching(/^reaction-push:pushed-reaction-target:/),
      target: { messageId: 'pushed-reaction-target' },
      context: {
        reactions: [{ key: '2:10068', count: 1, recentActors: [{ userId: 'actor-a' }] }],
      },
    } })

    f.emitS2C(groupReactionPushBytes({ operatorUid: 'actor-b', currentCount: 2 }))
    await expect(events.next()).resolves.toMatchObject({ value: {
      type: 'message-reactions',
      context: { reactions: [{
        key: '2:10068', count: 2,
        recentActors: [{ userId: 'actor-b' }, { userId: 'actor-a' }],
      }] },
    } })

    f.emitS2C(groupReactionPushBytes({ operatorUid: 'actor-a', currentCount: 1, operation: 2 }))
    await expect(events.next()).resolves.toMatchObject({ value: {
      type: 'message-reactions',
      context: { reactions: [{ count: 1, recentActors: [{ userId: 'actor-b' }] }] },
    } })

    f.emitS2C(groupReactionPushBytes({ operatorUid: 'actor-b', currentCount: 0, operation: 2 }))
    await expect(events.next()).resolves.toMatchObject({ value: {
      type: 'message-reactions', context: { reactions: [], maxSelected: 20 },
    } })
    expect(f.msg.getMsgsByMsgId).not.toHaveBeenCalled()
    expect(f.msg.getMsgsBySeqAndCount).not.toHaveBeenCalled()
  })

  it('preserves other reaction kinds and updates the selected state from self pushes', async () => {
    const f = fixture()
    const bridge = new QQKernelBridge()
    vi.spyOn(bridge as unknown as { initializePlatformData(): Promise<void> }, 'initializePlatformData').mockResolvedValue()
    bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: '/tmp' })
    const conversation = bridge.getConversation('1058754719')
    const target = {
      ...f.message,
      msgId: 'self-pushed-reaction-target', msgSeq: '799177', chatType: 2 as const,
      peerUid: '1058754719', peerUin: '1058754719', emojiLikesList: [
        { emojiType: '1', emojiId: '424', likesCnt: '2', isClicked: false },
      ],
    }
    f.msg.getLatestDbMsgs.mockResolvedValue({ result: 0, errMsg: '', msgList: [target] })
    await bridge.getHistory(conversation)
    const events = bridge.subscribe()[Symbol.asyncIterator]()

    f.emitS2C(groupReactionPushBytes({ operatorUid: 'self', currentCount: 1 }))
    await expect(events.next()).resolves.toMatchObject({ value: {
      type: 'message-reactions',
      context: { reactions: [
        { key: '1:424', count: 2 },
        { key: '2:10068', count: 1, selected: true, recentActors: [{ userId: 'self' }] },
      ] },
    } })

    f.emitS2C(groupReactionPushBytes({ operatorUid: 'self', currentCount: 0, operation: 2 }))
    await expect(events.next()).resolves.toMatchObject({ value: {
      type: 'message-reactions',
      context: { reactions: [{ key: '1:424', count: 2 }] },
    } })
  })

  it('resolves an uncached reaction-push target by its group sequence', async () => {
    const f = fixture()
    const bridge = new QQKernelBridge()
    vi.spyOn(bridge as unknown as { initializePlatformData(): Promise<void> }, 'initializePlatformData').mockResolvedValue()
    bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: '/tmp' })
    const target = {
      ...f.message,
      msgId: 'cold-pushed-reaction-target', msgSeq: '799178', chatType: 2 as const,
      peerUid: '1058754719', peerUin: '1058754719', sendType: 0,
      senderUid: 'member-a', senderUin: '42', emojiLikesList: [],
    }
    f.msg.getMsgsBySeqAndCount.mockResolvedValue({ result: 0, errMsg: '', msgList: [target] })
    const events = bridge.subscribe()[Symbol.asyncIterator]()

    f.emitS2C(groupReactionPushBytes({
      messageSequence: 799_178n, code: '424', operatorUid: 'actor-a', currentCount: 1,
    }))

    await expect(events.next()).resolves.toMatchObject({ value: {
      type: 'message-reactions',
      target: { messageId: 'cold-pushed-reaction-target' },
      context: { reactions: [{ key: '1:424', count: 1, recentActors: [{ userId: 'actor-a' }] }] },
    } })
    expect(f.msg.getMsgsBySeqAndCount.mock.calls).toEqual([
      [expect.objectContaining({ peerUid: '1058754719' }), '799178', 4, true, true],
      [expect.objectContaining({ peerUid: '1058754719' }), '799178', 4, false, true],
    ])
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

  it('publishes an edit when QQ replaces an optimistic group sequence with the final value', async () => {
    const f = fixture()
    const bridge = new QQKernelBridge()
    bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: '/tmp' })
    const events = bridge.subscribe()[Symbol.asyncIterator]()
    const optimistic = {
      ...f.message, msgId: 'finalized-sequence', msgSeq: '463083', chatType: 2,
      peerUid: '1058754719', peerUin: '1058754719', sendStatus: 1,
    }
    const confirmed = { ...optimistic, msgSeq: '463084', sendStatus: 2 }

    await f.emitSent(optimistic)
    await f.emitMessages([confirmed])

    await expect(events.next()).resolves.toMatchObject({
      value: {
        type: 'message',
        message: { id: 'finalized-sequence', msgSeq: '463083', telegramMessageId: 463083 },
      },
    })
    await expect(events.next()).resolves.toMatchObject({
      value: {
        type: 'message-edit',
        eventId: expect.stringMatching(/^message-info:finalized-sequence:/),
        message: { id: 'finalized-sequence', msgSeq: '463084', telegramMessageId: 463084 },
      },
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
      [expect.objectContaining({ peerUid: '1058754719' }), 'seq1', '128522', '2', '', false, 3],
      [expect.objectContaining({ peerUid: '1058754719' }), 'seq1', '128522', '2', 'next', false, 1],
    ])
    await expect(bridge.getUser('actor-a')).resolves.toMatchObject({
      id: 'actor-a', name: 'Alice', avatarUrl: 'https://example.com/a.jpg',
    })
  })

  it('falls back to the persisted group sequence when QQNT no longer resolves a message id', async () => {
    const f = fixture()
    const bridge = new QQKernelBridge()
    bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: '/tmp' })
    const conversation = await bridge.resolveConversation(2, '1058754719')
    const groupMessage = {
      ...f.message,
      msgId: 'current-id',
      msgSeq: '411715',
      chatType: 2 as const,
      peerUid: '1058754719',
      peerUin: '1058754719',
      emojiLikesList: [{ emojiType: '2', emojiId: '128522', likesCnt: '4', isClicked: false }],
    }
    f.msg.getMsgsByMsgId.mockResolvedValue({ result: 0, errMsg: '', msgList: [] })
    f.msg.getMsgsBySeqAndCount.mockResolvedValue({ result: 0, errMsg: '', msgList: [groupMessage] })
    f.msg.getMsgEmojiLikesList.mockResolvedValue({
      result: 0, errMsg: '', cookie: 'more', isFirstPage: true, isLastPage: false,
      emojiLikesList: [
        { tinyId: 'actor-a', nickName: 'Alice', headUrl: '' },
        { tinyId: 'actor-b', nickName: 'Bob', headUrl: '' },
        { tinyId: 'actor-c', nickName: 'Carol', headUrl: '' },
        { tinyId: 'actor-d', nickName: 'Dave', headUrl: '' },
      ],
    })

    await expect(bridge.getMessageReactions(conversation, 'stale-id', '411715'))
      .resolves.toMatchObject({
        reactions: [{
          key: '2:128522', count: 4,
          recentActors: [
            { userId: 'actor-a' }, { userId: 'actor-b' }, { userId: 'actor-c' },
          ],
        }],
      })
    expect(f.msg.getMsgsBySeqAndCount).toHaveBeenCalledWith(
      expect.objectContaining({ peerUid: '1058754719' }), '411715', 1, true, true,
    )
    expect(f.msg.getMsgEmojiLikesList).toHaveBeenCalledWith(
      expect.objectContaining({ peerUid: '1058754719' }), '411715', '128522', '2', '', false, 3,
    )
  })

  it('continues reaction actor pages from the opaque Telegram offset', async () => {
    const f = fixture()
    const bridge = new QQKernelBridge()
    bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: '/tmp' })
    const conversation = await bridge.resolveConversation(2, '1058754719')
    const groupMessage = {
      ...f.message,
      chatType: 2 as const,
      peerUid: '1058754719',
      peerUin: '1058754719',
      emojiLikesList: [{ emojiType: '2', emojiId: '128522', likesCnt: '5', isClicked: false }],
    }
    f.msg.getMsgsByMsgId.mockResolvedValue({ result: 0, errMsg: '', msgList: [groupMessage] })
    f.msg.getMsgEmojiLikesList
      .mockResolvedValueOnce({
        result: 0, errMsg: '', cookie: 'next', isFirstPage: true, isLastPage: false,
        emojiLikesList: [
          { tinyId: 'actor-a', nickName: 'Alice', headUrl: '' },
          { tinyId: 'actor-b', nickName: 'Bob', headUrl: '' },
        ],
      })
      .mockResolvedValueOnce({
        result: 0, errMsg: '', cookie: 'done', isFirstPage: false, isLastPage: true,
        emojiLikesList: [
          { tinyId: 'actor-c', nickName: 'Carol', headUrl: '' },
          { tinyId: 'actor-d', nickName: 'Dave', headUrl: '' },
          { tinyId: 'actor-e', nickName: 'Eve', headUrl: '' },
        ],
      })

    const first = await bridge.getMessageReactionActors(
      conversation, 'm1', '2:128522', undefined, 2,
    )
    expect(first).toMatchObject({
      state: { reactions: [{ key: '2:128522', count: 5 }] },
      actors: [
        { reactionKey: '2:128522', actor: { userId: 'actor-a' } },
        { reactionKey: '2:128522', actor: { userId: 'actor-b' } },
      ],
      nextOffset: expect.any(String),
    })
    const second = await bridge.getMessageReactionActors(
      conversation, 'm1', '2:128522', first.nextOffset, 3,
    )
    expect(second).toMatchObject({
      actors: [
        { reactionKey: '2:128522', actor: { userId: 'actor-c' } },
        { reactionKey: '2:128522', actor: { userId: 'actor-d' } },
        { reactionKey: '2:128522', actor: { userId: 'actor-e' } },
      ],
    })
    expect(second.nextOffset).toBeUndefined()
    expect(f.msg.getMsgEmojiLikesList.mock.calls).toEqual([
      [expect.objectContaining({ peerUid: '1058754719' }), 'seq1', '128522', '2', '', false, 2],
      [expect.objectContaining({ peerUid: '1058754719' }), 'seq1', '128522', '2', 'next', false, 3],
    ])
  })

  it('normalizes numeric reaction actors to QQ UIDs and uses their QQNT direct avatar URLs', async () => {
    const f = fixture()
    f.setAvatarUrl('actor-uid', 'https://thirdqq.qlogo.cn/avatar/actor/140')
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
      avatar: { locator: { avatarUrl: 'https://thirdqq.qlogo.cn/avatar/actor/140' } },
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

    const catalog = await bridge.getReactionCatalog()
    expect(catalog.available).toEqual(expect.arrayContaining([
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
            format: 'video', mimeType: 'video/webm', size: png.length,
            locator: { reactionKey: '1:14' },
          }),
        }),
      }),
    ]))
    expect(JSON.stringify(catalog)).not.toContain(root)
    const resource = await bridge.openReactionResource('1:14', { offset: 1, limit: 3 })
    expect(resource).toMatchObject({ mimeType: 'image/apng', size: png.length, offset: 1, length: 3 })
    expect(await readStream(resource!.stream)).toEqual(png.subarray(1, 4))
    await expect(bridge.openReactionResource('unknown')).resolves.toBeUndefined()
  })

  it('discovers the injected global reaction resources through XDG_CONFIG_HOME', async () => {
    const root = await mkdtemp(join(tmpdir(), 'qqnt-reactions-xdg-'))
    tempPaths.push(root)
    const configRoot = join(root, '.config')
    const resourceRoot = join(
      configRoot, 'qqnt-bridge-injection', 'global', 'nt_data', 'Emoji', 'emoji-resource',
    )
    await Promise.all([
      mkdir(join(resourceRoot, 'sysface_res'), { recursive: true }),
      mkdir(join(resourceRoot, 'emoji_res'), { recursive: true }),
    ])
    await writeFile(join(resourceRoot, 'face_config.json'), JSON.stringify({
      emoji: [{ QSid: '👍', QCid: '76', AQLid: '76', QDes: '/赞' }],
      sysface: [],
    }))
    vi.stubEnv('XDG_CONFIG_HOME', configRoot)
    const f = fixture()
    const bridge = new QQKernelBridge()
    bridge.attach(f.kernel, f.session, {
      selfUin: '10000', selfUid: 'self', userPath: join(configRoot, 'QQ'),
    })

    await expect(bridge.getReactionCatalog()).resolves.toMatchObject({
      available: [{ key: '2:76', presentation: { type: 'emoji', emoticon: '👍' } }],
      maxSelected: 20,
    })
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


  it('maps only native pending requests, publishes listener updates, and resolves them idempotently', async () => {
    const f = fixture()
    f.buddy.getBuddyReq.mockResolvedValue({ buddyReqs: [
      { friendUid: 'friend-uid', reqTime: '11', isInitiator: false, isDecide: false, friendNick: 'Friend', extWords: 'hello' },
      { friendUid: 'outgoing-uid', reqTime: '12', isInitiator: true, isDecide: false },
    ] })
    f.group.getSingleScreenNotifies.mockImplementation(async (doubt, startSeq) => (
      !doubt && !startSeq
        ? { notifies: [
          { seq: '21', type: 7, status: 1, group: { groupCode: '123', groupName: 'Group' }, user1: { uid: 'join-uid', nickName: 'Joiner' }, postscript: 'please join', actionTime: '22' },
          { seq: '22', type: 7, status: 2, group: { groupCode: '123' }, user1: { uid: 'resolved-uid' } },
          { seq: '23', type: 8, status: 1, group: { groupCode: '123' }, user1: { uid: 'other-uid' } },
        ] }
        : { notifies: [] }
    ))
    const bridge = new QQKernelBridge()
    bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: '/tmp' })

    const page = await bridge.getRequests()
    expect(page.requests).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'friend', status: 'pending', requester: { id: 'friend-uid', name: 'Friend' }, message: 'hello' }),
      expect.objectContaining({ kind: 'group-join', status: 'pending', requester: { id: 'join-uid', name: 'Joiner' }, group: { id: '123', name: 'Group' } }),
    ]))
    expect(page.requests).toHaveLength(2)

    const events = bridge.subscribe()[Symbol.asyncIterator]()
    f.emitBuddyRequests([
      { friendUid: 'friend-uid', reqTime: '11', isInitiator: false, isDecide: false, friendNick: 'Friend', extWords: 'hello' },
      { friendUid: 'live-uid', reqTime: '13', isInitiator: false, isDecide: false },
    ])
    await expect(events.next()).resolves.toMatchObject({
      value: { type: 'request', request: { kind: 'friend', requester: { id: 'live-uid' }, status: 'pending' } },
    })

    const friend = page.requests.find((request) => request.kind === 'friend')!
    await expect(bridge.resolveRequest(friend.id, 'accept')).resolves.toMatchObject({ status: 'accepted' })
    expect(f.buddy.approvalFriendRequest).toHaveBeenCalledWith({ friendUid: 'friend-uid', reqTime: '11', accept: true })
    await expect(bridge.resolveRequest(friend.id, 'accept')).resolves.toMatchObject({ status: 'accepted' })
    await expect(bridge.resolveRequest(friend.id, 'reject')).rejects.toThrow('different action')

    const group = page.requests.find((request) => request.kind === 'group-join')!
    await expect(bridge.resolveRequest(group.id, 'reject')).resolves.toMatchObject({ status: 'rejected' })
    expect(f.group.operateSysNotify).toHaveBeenCalledWith(false, {
      operateType: 2,
      targetMsg: { seq: '21', type: 7, groupCode: '123', postscript: 'please join' },
    })
  })

  it('reads filtered friend requests through their correlated doubt channel without approving them', async () => {
    const f = fixture()
    const regular = { friendUid: 'same-user', reqTime: '11', isInitiator: false, isDecide: false }
    f.buddy.getBuddyReq.mockResolvedValue({ buddyReqs: [regular] })
    const getDoubtBuddyReq = vi.fn<NonNullable<KernelBuddyService['getDoubtBuddyReq']>>(async () => ({ result: 0, errMsg: '' }))
    f.buddy.getDoubtBuddyReq = getDoubtBuddyReq
    const bridge = new QQKernelBridge()
    vi.spyOn(bridge as unknown as { initializePlatformData(): Promise<void> }, 'initializePlatformData').mockResolvedValue()
    bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: '/tmp' })

    const listed = bridge.getRequests('friend')
    await vi.waitFor(() => expect(f.buddy.getBuddyReq).toHaveBeenCalledWith())
    await vi.waitFor(() => expect(getDoubtBuddyReq).toHaveBeenCalledOnce())
    const [reqId, count, cookie] = getDoubtBuddyReq.mock.calls[0]
    expect([count, cookie]).toEqual([100, ''])

    f.emitDoubtBuddyRequests({
      reqId: 'stale-request', doubtList: [{ uid: 'stale-user', reqTime: '10', nick: 'Stale' }],
    })
    f.emitDoubtBuddyRequests({
      reqId, doubtList: [{ uid: 'same-user', reqTime: '11', nick: 'Filtered', msg: 'please add me', reason: 'QQ 风险提示' }],
    })
    const page = await listed
    const doubt = page.requests.find((request) => request.source === 'doubt')!
    const normal = page.requests.find((request) => request.source === undefined)!
    expect(page.requests).toHaveLength(2)
    expect(doubt).toMatchObject({
      kind: 'friend', status: 'pending', requester: { id: 'same-user', name: 'Filtered' },
      message: 'please add me', reason: 'QQ 风险提示', timestamp: '11', source: 'doubt',
    })
    expect(doubt.id).not.toBe(normal.id)
    await expect(bridge.resolveRequest(doubt.id, 'accept')).rejects.toThrow(
      'filtered QQ friend requests must be handled in the QQ client',
    )
    expect(f.buddy.approvalFriendRequest).not.toHaveBeenCalled()
  })

  it('coalesces concurrent friend refreshes across normal and doubt channels', async () => {
    const f = fixture()
    f.buddy.getBuddyReq.mockResolvedValue({ buddyReqs: [
      { friendUid: 'regular', reqTime: '1', isInitiator: false, isDecide: false },
    ] })
    const getDoubtBuddyReq = vi.fn<NonNullable<KernelBuddyService['getDoubtBuddyReq']>>(async (reqId) => ({
      reqId, doubtList: [{ uid: 'filtered', reqTime: '2', nick: 'Filtered' }],
    }))
    f.buddy.getDoubtBuddyReq = getDoubtBuddyReq
    const bridge = new QQKernelBridge()
    vi.spyOn(bridge as unknown as { initializePlatformData(): Promise<void> }, 'initializePlatformData').mockResolvedValue()
    bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: '/tmp' })

    const [first, second] = await Promise.all([bridge.getRequests('friend'), bridge.getRequests('friend')])
    expect(f.buddy.getBuddyReq).toHaveBeenCalledOnce()
    expect(getDoubtBuddyReq).toHaveBeenCalledOnce()
    expect(first.requests).toEqual(second.requests)
    expect(first.requests).toHaveLength(2)
    expect(new Set(first.requests.map((request) => request.id)).size).toBe(2)
  })

  it('ignores timed-out doubt callbacks without contaminating the next friend refresh', async () => {
    vi.useFakeTimers()
    try {
      const f = fixture()
      f.buddy.getBuddyReq.mockResolvedValue({ buddyReqs: [] })
      const getDoubtBuddyReq = vi.fn<NonNullable<KernelBuddyService['getDoubtBuddyReq']>>(async () => ({ result: 0, errMsg: '' }))
      f.buddy.getDoubtBuddyReq = getDoubtBuddyReq
      const bridge = new QQKernelBridge()
      vi.spyOn(bridge as unknown as { initializePlatformData(): Promise<void> }, 'initializePlatformData').mockResolvedValue()
      bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: '/tmp' })

      const timedOut = bridge.getRequests('friend')
      const rejected = expect(timedOut).rejects.toThrow('QQNT request refresh failed')
      await Promise.resolve()
      const firstReqId = getDoubtBuddyReq.mock.calls[0][0]
      await vi.advanceTimersByTimeAsync(1_500)
      await rejected

      let settled = false
      const retried = bridge.getRequests('friend').then((page) => { settled = true; return page })
      await Promise.resolve()
      expect(getDoubtBuddyReq).toHaveBeenCalledTimes(2)
      const secondReqId = getDoubtBuddyReq.mock.calls[1][0]
      f.emitDoubtBuddyRequests({
        reqId: firstReqId, doubtList: [{ uid: 'late', reqTime: '1', nick: 'Late' }],
      })
      await Promise.resolve()
      expect(settled).toBe(false)
      f.emitDoubtBuddyRequests({
        reqId: secondReqId, doubtList: [{ uid: 'fresh', reqTime: '2', nick: 'Fresh' }],
      })
      await expect(retried).resolves.toMatchObject({
        requests: [{ requester: { id: 'fresh' }, source: 'doubt' }],
      })
      expect((await bridge.getRequests('friend')).requests.map((request) => request.requester.id)).toEqual(['fresh'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('ignores request callbacks queued by a detached attachment', async () => {
    const f = fixture()
    f.buddy.getBuddyReq.mockResolvedValue({ buddyReqs: [] })
    f.group.getSingleScreenNotifies.mockResolvedValue({ notifies: [] })
    const bridge = new QQKernelBridge()
    vi.spyOn(bridge as unknown as { initializePlatformData(): Promise<void> }, 'initializePlatformData').mockResolvedValue()
    bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'account-a', userPath: '/tmp' })
    bridge.detach()
    bridge.attach(f.kernel, f.session, { selfUin: '20000', selfUid: 'account-b', userPath: '/tmp' })
    await bridge.getRequests()
    const events = bridge.subscribe()[Symbol.asyncIterator]()

    f.emitHistoricalBuddyRequests(0, [{ friendUid: 'account-a-friend', reqTime: '1', isInitiator: false, isDecide: false }])
    f.emitHistoricalGroupRequests(0, false, [
      { seq: '1', type: 7, status: 1, group: { groupCode: '123' }, user1: { uid: 'account-a-joiner' } },
    ])
    await new Promise(setImmediate)
    expect((await bridge.getRequests()).requests).toEqual([])
    const received = await Promise.race([
      events.next(),
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 10)),
    ])
    expect(received).toBe('timeout')
  })

  it('uses stable non-reversible request IDs', async () => {
    const records = [
      { friendUid: 'uid-secret-one', reqTime: '111', isInitiator: false, isDecide: false },
      { friendUid: 'uid-secret-two', reqTime: '222', isInitiator: false, isDecide: false },
    ]
    const leftFixture = fixture()
    leftFixture.buddy.getBuddyReq.mockResolvedValue({ buddyReqs: records })
    const left = new QQKernelBridge()
    vi.spyOn(left as unknown as { initializePlatformData(): Promise<void> }, 'initializePlatformData').mockResolvedValue()
    left.attach(leftFixture.kernel, leftFixture.session, { selfUin: '10000', selfUid: 'self', userPath: '/tmp' })
    const leftIds = (await left.getRequests('friend')).requests.map((request) => request.id)

    const rightFixture = fixture()
    rightFixture.buddy.getBuddyReq.mockResolvedValue({ buddyReqs: records })
    const right = new QQKernelBridge()
    vi.spyOn(right as unknown as { initializePlatformData(): Promise<void> }, 'initializePlatformData').mockResolvedValue()
    right.attach(rightFixture.kernel, rightFixture.session, { selfUin: '10000', selfUid: 'self', userPath: '/tmp' })
    const rightIds = (await right.getRequests('friend')).requests.map((request) => request.id)

    expect(leftIds).toEqual(rightIds)
    expect(new Set(leftIds).size).toBe(2)
    for (const id of leftIds) {
      expect(Buffer.from(id.slice('request:'.length), 'base64url').toString('utf8')).not.toContain('uid-secret')
      expect(id).not.toContain('111')
      expect(id).not.toContain('222')
    }
  })

  it('times out hung native request getters and permits retry', async () => {
    for (const kind of ['friend', 'group-join'] as const) {
      vi.useFakeTimers()
      try {
        const f = fixture()
        if (kind === 'friend') {
          f.buddy.getBuddyReq.mockImplementationOnce(() => new Promise(() => {}))
            .mockResolvedValue({ buddyReqs: [] })
        } else {
          f.group.getSingleScreenNotifies.mockImplementationOnce(() => new Promise(() => {}))
            .mockResolvedValue({ notifies: [] })
        }
        const bridge = new QQKernelBridge()
        vi.spyOn(bridge as unknown as { initializePlatformData(): Promise<void> }, 'initializePlatformData').mockResolvedValue()
        bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: '/tmp' })
        const hung = bridge.getRequests(kind)
        const rejected = expect(hung).rejects.toThrow('QQNT request refresh failed')
        await vi.advanceTimersByTimeAsync(1_500)
        await rejected
        await expect(bridge.getRequests(kind)).resolves.toMatchObject({ requests: [] })
      } finally {
        vi.useRealTimers()
      }
    }
  })

  it('rejects a resolution completed after detach and reattach', async () => {
    const f = fixture()
    f.buddy.getBuddyReq.mockResolvedValue({ buddyReqs: [
      { friendUid: 'friend', reqTime: '1', isInitiator: false, isDecide: false },
    ] })
    let resolveApproval!: (value: unknown) => void
    f.buddy.approvalFriendRequest.mockImplementationOnce(() => new Promise((resolve) => { resolveApproval = resolve }))
    const bridge = new QQKernelBridge()
    vi.spyOn(bridge as unknown as { initializePlatformData(): Promise<void> }, 'initializePlatformData').mockResolvedValue()
    bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: '/tmp' })
    const request = (await bridge.getRequests('friend')).requests[0]
    const resolution = bridge.resolveRequest(request.id, 'accept')
    bridge.detach()
    bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: '/tmp' })
    resolveApproval({ result: 0, errMsg: '' })
    await expect(resolution).rejects.toThrow('session changed')
  })

  it('waits for each native request source independently', async () => {
    const f = fixture()
    f.buddy.getBuddyReq.mockResolvedValue({ result: 0, errMsg: '' })
    f.group.getSingleScreenNotifies.mockResolvedValue({ result: 0, errMsg: '' })
    const bridge = new QQKernelBridge()
    vi.spyOn(bridge as unknown as { initializePlatformData(): Promise<void> }, 'initializePlatformData').mockResolvedValue()
    bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: '/tmp' })
    let settled = false
    const listed = bridge.getRequests().then((page) => { settled = true; return page })
    await Promise.resolve()
    expect(f.buddy.getBuddyReq).toHaveBeenCalledOnce()
    expect(f.group.getSingleScreenNotifies).toHaveBeenCalledOnce()

    f.emitGroupRequests(true, [], 'wrong-queue-cursor')
    f.emitBuddyRequests([{ friendUid: 'friend', reqTime: '1', isInitiator: false, isDecide: false }])
    await Promise.resolve()
    expect(settled).toBe(false)
    f.emitGroupRequests(false, [])
    await new Promise(setImmediate)
    expect(f.group.getSingleScreenNotifies).toHaveBeenCalledTimes(2)
    expect(f.group.getSingleScreenNotifies).toHaveBeenLastCalledWith(true, '', 100)
    expect(settled).toBe(false)
    f.emitGroupRequests(true, [])
    await expect(listed).resolves.toMatchObject({ requests: [{ kind: 'friend' }] })
  })

  it('ignores delayed group pages and live deltas while waiting for the active page', async () => {
    const f = fixture()
    const calls: Array<{ doubt: boolean, startSeq: string }> = []
    f.group.getSingleScreenNotifies.mockImplementation(async (doubt, startSeq) => {
      calls.push({ doubt, startSeq })
      if (doubt) return { notifies: [] }
      return { result: 0, errMsg: '' }
    })
    const bridge = new QQKernelBridge()
    vi.spyOn(bridge as unknown as { initializePlatformData(): Promise<void> }, 'initializePlatformData').mockResolvedValue()
    bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: '/tmp' })
    let settled = false
    const listed = bridge.getRequests('group-join').then((page) => { settled = true; return page })
    await Promise.resolve()
    expect(calls).toEqual([{ doubt: false, startSeq: '' }])

    const page1 = [{ seq: '1', type: 7, status: 1, group: { groupCode: '123' }, user1: { uid: 'page-one' } }]
    f.emitGroupRequests(false, page1, 'page-2')
    await new Promise(setImmediate)
    expect(calls).toEqual([{ doubt: false, startSeq: '' }, { doubt: false, startSeq: 'page-2' }])

    f.emitGroupRequests(false, page1, 'page-2')
    f.emitGroupRequestUpdate(false, [{ seq: 'live', type: 7, status: 1, group: { groupCode: '123' }, user1: { uid: 'live' } }])
    await new Promise(setImmediate)
    expect(calls).toHaveLength(2)
    expect(settled).toBe(false)

    f.emitGroupRequests(false, [{ seq: '2', type: 7, status: 1, group: { groupCode: '123' }, user1: { uid: 'page-two' } }])
    await expect(listed).resolves.toMatchObject({
      requests: expect.arrayContaining([
        expect.objectContaining({ requester: { id: 'page-one' } }),
        expect.objectContaining({ requester: { id: 'page-two' } }),
      ]),
    })
  })

  it('drains both paginated native group request queues and preserves blank postscript for approval', async () => {
    const f = fixture()
    const calls: Array<{ doubt: boolean, startSeq: string }> = []
    f.group.getSingleScreenNotifies.mockImplementation(async (doubt, startSeq) => {
      calls.push({ doubt, startSeq })
      if (!doubt && startSeq === '') return {
        nextStartSeq: 'false-next',
        notifies: [{ seq: '1', type: 7, status: 1, group: { groupCode: '100' }, user1: { uid: 'false-first' } }],
      }
      if (!doubt && startSeq === 'false-next') return {
        notifies: [{ seq: '2', type: 7, status: 1, group: { groupCode: '100' }, user1: { uid: 'false-second' } }],
      }
      if (doubt && startSeq === '') return {
        nextStartSeq: 'true-next',
        notifies: [{ seq: '3', type: 7, status: 1, group: { groupCode: '200' }, user1: { uid: 'true-first' } }],
      }
      return {
        notifies: [{ seq: '4', type: 7, status: 1, group: { groupCode: '200' }, user1: { uid: 'true-second' } }],
      }
    })
    const bridge = new QQKernelBridge()
    vi.spyOn(bridge as unknown as { initializePlatformData(): Promise<void> }, 'initializePlatformData').mockResolvedValue()
    bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: '/tmp' })

    const page = await bridge.getRequests('group-join')
    expect(calls).toEqual([
      { doubt: false, startSeq: '' }, { doubt: false, startSeq: 'false-next' },
      { doubt: true, startSeq: '' }, { doubt: true, startSeq: 'true-next' },
    ])
    expect(page).not.toHaveProperty('nativeNextStartSeq')
    expect(page.requests.map((request) => request.requester.id).sort()).toEqual([
      'false-first', 'false-second', 'true-first', 'true-second',
    ])
    const events = bridge.subscribe()[Symbol.asyncIterator]()
    f.emitGroupRequests(false, [
      { seq: '5', type: 7, status: 1, group: { groupCode: '100' }, user1: { uid: 'listener-user' } },
    ])
    await expect(events.next()).resolves.toMatchObject({
      value: { type: 'request', request: { kind: 'group-join', requester: { id: 'listener-user' } } },
    })
    const blankPostscript = page.requests.find((request) => request.requester.id === 'false-first')!
    await bridge.resolveRequest(blankPostscript.id, 'accept')
    expect(f.group.operateSysNotify).toHaveBeenCalledWith(false, {
      operateType: 1,
      targetMsg: { seq: '1', type: 7, groupCode: '100', postscript: ' ' },
    })
  })

  it('rejects repeated group pagination cursors for either doubt queue', async () => {
    for (const failingDoubt of [false, true]) {
      const f = fixture()
      f.group.getSingleScreenNotifies.mockImplementation(async (doubt, startSeq) => {
        if (doubt !== failingDoubt) return { notifies: [] }
        return { nextStartSeq: startSeq || 'repeat', notifies: [] }
      })
      const bridge = new QQKernelBridge()
      vi.spyOn(bridge as unknown as { initializePlatformData(): Promise<void> }, 'initializePlatformData').mockResolvedValue()
      bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: '/tmp' })
      await expect(bridge.getRequests('group-join')).rejects.toThrow('QQNT request refresh failed')
    }
  })

  it('rejects a group pagination continuation after the page limit', async () => {
    const f = fixture()
    let falsePages = 0
    f.group.getSingleScreenNotifies.mockImplementation(async (doubt) => {
      if (doubt) return { notifies: [] }
      falsePages++
      return { nextStartSeq: String(falsePages), notifies: [] }
    })
    const bridge = new QQKernelBridge()
    vi.spyOn(bridge as unknown as { initializePlatformData(): Promise<void> }, 'initializePlatformData').mockResolvedValue()
    bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: '/tmp' })
    await expect(bridge.getRequests('group-join')).rejects.toThrow('QQNT request refresh failed')
    expect(falsePages).toBe(100)
  })

  it('shares the initial friend refresh with an immediate request list call', async () => {
    const f = fixture()
    let resolveBuddy!: (value: unknown) => void
    f.buddy.getBuddyReq.mockImplementationOnce(() => new Promise((resolve) => { resolveBuddy = resolve }))
    const bridge = new QQKernelBridge()
    vi.spyOn(bridge as unknown as { refreshContacts(): Promise<void> }, 'refreshContacts').mockResolvedValue()
    bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: '/tmp' })
    const page = bridge.getRequests('friend')
    await Promise.resolve()
    expect(f.buddy.getBuddyReq).toHaveBeenCalledOnce()
    resolveBuddy({ buddyReqs: [] })
    await page
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(f.buddy.getBuddyReq).toHaveBeenCalledOnce()
  })

  it('serializes concurrent friend and group request resolutions', async () => {
    const f = fixture()
    f.buddy.getBuddyReq.mockResolvedValue({ buddyReqs: [
      { friendUid: 'friend', reqTime: '1', isInitiator: false, isDecide: false },
    ] })
    f.group.getSingleScreenNotifies.mockResolvedValue({ notifies: [
      { seq: '2', type: 7, status: 1, group: { groupCode: '123' }, user1: { uid: 'joiner' } },
      { seq: '3', type: 7, status: 1, group: { groupCode: '123' }, user1: { uid: 'retry-joiner' } },
    ] })
    const bridge = new QQKernelBridge()
    vi.spyOn(bridge as unknown as { initializePlatformData(): Promise<void> }, 'initializePlatformData').mockResolvedValue()
    bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: '/tmp' })
    const requests = (await bridge.getRequests()).requests
    const friend = requests.find((request) => request.kind === 'friend')!
    const group = requests.find((request) => request.kind === 'group-join' && request.requester.id === 'joiner')!
    const retryGroup = requests.find((request) => request.kind === 'group-join' && request.requester.id === 'retry-joiner')!

    let resolveFriend!: (value: unknown) => void
    f.buddy.approvalFriendRequest.mockImplementationOnce(() => new Promise((resolve) => { resolveFriend = resolve }))
    const friendAccept = bridge.resolveRequest(friend.id, 'accept')
    const friendSameAction = bridge.resolveRequest(friend.id, 'accept')
    const friendOppositeAction = bridge.resolveRequest(friend.id, 'reject')
    expect(f.buddy.approvalFriendRequest).toHaveBeenCalledOnce()
    resolveFriend({ result: 0, errMsg: '' })
    await expect(friendAccept).resolves.toMatchObject({ status: 'accepted' })
    await expect(friendSameAction).resolves.toMatchObject({ status: 'accepted' })
    await expect(friendOppositeAction).rejects.toThrow('different action')
    expect(f.buddy.approvalFriendRequest).toHaveBeenCalledOnce()

    let resolveGroup!: (value: unknown) => void
    f.group.operateSysNotify.mockImplementationOnce(() => new Promise((resolve) => { resolveGroup = resolve }))
    const groupAccept = bridge.resolveRequest(group.id, 'accept')
    const groupOppositeAction = bridge.resolveRequest(group.id, 'reject')
    expect(f.group.operateSysNotify).toHaveBeenCalledOnce()
    resolveGroup({ result: 0, errMsg: '' })
    await expect(groupAccept).resolves.toMatchObject({ status: 'accepted' })
    await expect(groupOppositeAction).rejects.toThrow('different action')
    expect(f.group.operateSysNotify).toHaveBeenCalledOnce()

    f.group.operateSysNotify.mockRejectedValueOnce(new Error('temporary native failure'))
      .mockResolvedValueOnce({ result: 0, errMsg: '' })
    await expect(bridge.resolveRequest(retryGroup.id, 'accept')).rejects.toThrow('native request rejected')
    await expect(bridge.resolveRequest(retryGroup.id, 'accept')).resolves.toMatchObject({ status: 'accepted' })
    expect(f.group.operateSysNotify).toHaveBeenCalledTimes(3)
  })

  it('reconciles friend snapshots and publishes resolved group requests', async () => {
    const f = fixture()
    f.buddy.getBuddyReq.mockResolvedValue({ buddyReqs: [
      { friendUid: 'first', reqTime: '1', isInitiator: false, isDecide: false },
      { friendUid: 'stale', reqTime: '2', isInitiator: false, isDecide: false },
    ] })
    f.group.getSingleScreenNotifies.mockImplementation(async (doubt) => (
      doubt ? { notifies: [] } : { notifies: [
        { seq: '3', type: 7, status: 1, group: { groupCode: '123' }, user1: { uid: 'accepted-joiner' } },
        { seq: '4', type: 7, status: 1, group: { groupCode: '123' }, user1: { uid: 'rejected-joiner' } },
        { seq: '5', type: 7, status: 1, group: { groupCode: '123' }, user1: { uid: 'ignored-joiner' } },
      ] }
    ))
    const bridge = new QQKernelBridge()
    bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: '/tmp' })
    await bridge.getRequests()
    const events = bridge.subscribe()[Symbol.asyncIterator]()

    f.emitBuddyRequests([{ friendUid: 'first', reqTime: '1', isInitiator: false, isDecide: true, isAgreed: true }])
    await expect(events.next()).resolves.toMatchObject({
      value: { type: 'request', request: { requester: { id: 'first' }, status: 'accepted' } },
    })
    expect((await bridge.getRequests('friend')).requests).toMatchObject([
      { requester: { id: 'first' }, status: 'accepted' },
    ])

    f.emitGroupRequestUpdate(false, [{ seq: '3', type: 7, status: 2 }])
    await expect(events.next()).resolves.toMatchObject({
      value: { type: 'request', request: { requester: { id: 'accepted-joiner' }, status: 'accepted' } },
    })
    f.emitGroupRequestUpdate(false, [{ seq: '4', type: 7, status: 3 }])
    await expect(events.next()).resolves.toMatchObject({
      value: { type: 'request', request: { requester: { id: 'rejected-joiner' }, status: 'rejected' } },
    })
    f.emitGroupRequestUpdate(false, [
      { seq: '5', type: 7, status: 4 },
      { seq: 'unknown-accepted', type: 7, status: 2 },
      { seq: 'unknown-rejected', type: 7, status: 3 },
    ])
    expect((await bridge.getRequests('group-join')).requests).toEqual([
      expect.objectContaining({ requester: { id: 'accepted-joiner' }, status: 'accepted' }),
      expect.objectContaining({ requester: { id: 'rejected-joiner' }, status: 'rejected' }),
    ])
    const received = await Promise.race([
      events.next(),
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 10)),
    ])
    expect(received).toBe('timeout')
  })

  it('loads the group snapshot after a friend-only request list', async () => {
    const f = fixture()
    f.buddy.getBuddyReq.mockResolvedValue({ buddyReqs: [
      { friendUid: 'friend', reqTime: '1', isInitiator: false, isDecide: false },
    ] })
    f.group.getSingleScreenNotifies.mockImplementation(async (doubt) => (
      doubt ? { notifies: [] } : { notifies: [
        { seq: '2', type: 7, status: 1, group: { groupCode: '123' }, user1: { uid: 'joiner' } },
      ] }
    ))
    const bridge = new QQKernelBridge()
    vi.spyOn(bridge as unknown as { initializePlatformData(): Promise<void> }, 'initializePlatformData').mockResolvedValue()
    bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: '/tmp' })

    await bridge.getRequests('friend')
    expect(f.buddy.getBuddyReq).toHaveBeenCalledOnce()
    expect(f.group.getSingleScreenNotifies).not.toHaveBeenCalled()
    await expect(bridge.getRequests('group-join')).resolves.toMatchObject({
      requests: [{ kind: 'group-join', group: { id: '123' } }],
    })
    expect(f.group.getSingleScreenNotifies).toHaveBeenCalledTimes(2)
  })

  it('loads the friend snapshot after a group-only request list', async () => {
    const f = fixture()
    f.buddy.getBuddyReq.mockResolvedValue({ buddyReqs: [
      { friendUid: 'friend', reqTime: '1', isInitiator: false, isDecide: false },
    ] })
    f.group.getSingleScreenNotifies.mockImplementation(async (doubt) => (
      doubt ? { notifies: [] } : { notifies: [
        { seq: '2', type: 7, status: 1, group: { groupCode: '123' }, user1: { uid: 'joiner' } },
      ] }
    ))
    const bridge = new QQKernelBridge()
    vi.spyOn(bridge as unknown as { initializePlatformData(): Promise<void> }, 'initializePlatformData').mockResolvedValue()
    bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: '/tmp' })

    await bridge.getRequests('group-join')
    expect(f.group.getSingleScreenNotifies).toHaveBeenCalledTimes(2)
    expect(f.buddy.getBuddyReq).not.toHaveBeenCalled()
    await expect(bridge.getRequests('friend')).resolves.toMatchObject({
      requests: [{ kind: 'friend', requester: { id: 'friend' } }],
    })
    expect(f.buddy.getBuddyReq).toHaveBeenCalledOnce()
  })

  it('reports unavailable request APIs without using message paths', async () => {
    const f = fixture()
    delete (f.buddy as { getBuddyReq?: unknown }).getBuddyReq
    delete (f.group as { getSingleScreenNotifies?: unknown }).getSingleScreenNotifies
    const bridge = new QQKernelBridge()
    bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: '/tmp' })
    await expect(bridge.getRequests()).rejects.toThrow('request API is unavailable')
  })

  it('revokes active call media on detach and account switch without logging the call ID', async () => {
    const f = fixture()
    const revokeCallLeases = vi.fn()
    const bridge = new QQKernelBridge({ mediaGateway: {
      issueLease: vi.fn(), revokeCallLeases,
    } })
    const events = bridge.subscribe()[Symbol.asyncIterator]()
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {})
    const emitIncoming = (suffix: string) => f.emitAVSDK('OnInviteActionToAVSDK', {
      relation_id: '1715311957', invite_type: 1, from_uid: 'uid-1715311957',
    }, 0, `native-${suffix}-must-not-log`)
    try {
      bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: '/tmp' })
      emitIncoming('detach')
      const detached = await nextCallSignal(events)
      bridge.detach()
      expect(revokeCallLeases).toHaveBeenCalledTimes(1)
      expect(revokeCallLeases).toHaveBeenLastCalledWith(detached.callId)

      bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: '/tmp' })
      emitIncoming('switch')
      const switched = await nextCallSignal(events)
      bridge.attach(f.kernel, f.session, { selfUin: '20000', selfUid: 'self-2', userPath: '/tmp' })
      expect(revokeCallLeases).toHaveBeenCalledTimes(2)
      expect(revokeCallLeases).toHaveBeenLastCalledWith(switched.callId)
      expect(consoleLog.mock.calls.map(([message]) => String(message)).join('\n')).not.toContain('native-')
    } finally {
      bridge.detach()
    }
  })
})

describe('QQBridgeServer', () => {
  let server: QQBridgeServer | undefined
  const tempPaths: string[] = []
  afterEach(async () => {
    await server?.stop()
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
    await Promise.all(tempPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })))
  })

  it('reuses QQ remote identities and streams only new files through the flash slice protocol', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'qqnt-flash-server-'))
    tempPaths.push(directory)
    const f = fixture()
    f.flashPrepareUpload
      .mockResolvedValueOnce({ fileId: 'remote-id', uploadTime: 1, expireLeftTime: 2 })
      .mockResolvedValueOnce({ rkey: 'slice-rkey', fileId: 'upload-id', uploadTime: 3, expireLeftTime: 4 })
    const uploaded: Array<{ name: string, body: Buffer, state: Buffer[] }> = []
    f.flashUploadFile.mockImplementation(async (file, _prepared, source, state) => {
      const chunks: Buffer[] = []
      for await (const chunk of source) chunks.push(Buffer.from(chunk))
      uploaded.push({ name: file.name, body: Buffer.concat(chunks), state: state.map(Buffer.from) })
    })
    const bridge = new QQKernelBridge({ tempPath: directory })
    bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: directory })
    server = new QQBridgeServer(bridge, { port: 0 })
    await server.start()
    const manifest = {
      name: 'Telegram files', framing: 'length-prefixed-v1',
      files: [{
        source: 'qq-media', name: 'cached-qq.bin', size: 4,
        locator: {
          messageId: 'm1', elementId: 'e1', chatType: 1, peerUid: 'friend',
          kind: 'file', fileName: 'cached-qq.bin', fileSize: '4',
          filePath: 'Z:\\QQ\\cache\\does-not-need-to-exist.bin',
          md5: '11'.repeat(16), sha: '22'.repeat(20),
        },
      }, { source: 'upload', name: 'alpha.txt', size: 5 }],
    }

    const response = await fetch(`http://127.0.0.1:${server.address().port}/v1/flash-transfers`, {
      method: 'POST',
      headers: {
        'x-qqnt-flash-manifest': Buffer.from(JSON.stringify(manifest)).toString('base64url'),
      },
      body: framedUpload(Buffer.from('alpha')),
    })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      fileSetId: 'fileset-1', shareLink: 'https://qfile.qq.com/q/share-code', expiresAt: 2_000_000_000_000,
    })
    expect(f.flashApplyFileset).toHaveBeenCalledWith(expect.objectContaining({
      name: 'Telegram files',
      uploader: { uin: '10000', uid: 'self', nickname: 'Self' },
      files: [
        expect.objectContaining({ name: 'cached-qq.bin', size: 4, md5: '11'.repeat(16), sha1: '22'.repeat(20) }),
        expect.objectContaining({
          name: 'alpha.txt', size: 5,
          md5: createHash('md5').update('alpha').digest('hex'),
          sha1: createHash('sha1').update('alpha').digest('hex'),
        }),
      ],
    }))
    expect(f.flashCommitFiles).toHaveBeenCalledTimes(1)
    expect(f.flashCompleteFileset).toHaveBeenCalledTimes(1)
    expect(f.flashPrepareUpload).toHaveBeenCalledTimes(2)
    expect(uploaded).toEqual([{
      name: 'alpha.txt', body: Buffer.from('alpha'),
      state: [createHash('sha1').update('alpha').digest()],
    }])
    expect(f.flashApplyUpload).toHaveBeenCalledTimes(2)
    expect(f.flashSetReady).toHaveBeenCalledTimes(1)
    expect(f.flashCommitFiles.mock.invocationCallOrder[0]).toBeLessThan(f.flashCompleteFileset.mock.invocationCallOrder[0]!)
    expect(f.flashCompleteFileset.mock.invocationCallOrder[0]).toBeLessThan(f.flashPrepareUpload.mock.invocationCallOrder[0]!)
    expect(f.flashApplyUpload.mock.invocationCallOrder.at(-1)).toBeLessThan(f.flashSetReady.mock.invocationCallOrder[0]!)
  })

  it('advertises protocol flash support and never downloads a QQ remote cache miss', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'qqnt-flash-protocol-'))
    tempPaths.push(directory)
    const f = fixture()
    f.flashPrepareUpload.mockResolvedValue({
      rkey: 'remote-content-not-found', fileId: 'new-id', uploadTime: 1, expireLeftTime: 2,
    })
    const bridge = new QQKernelBridge({ tempPath: directory })
    bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: directory })
    server = new QQBridgeServer(bridge, { port: 0 })
    await server.start()
    const base = `http://127.0.0.1:${server.address().port}/v1`

    await expect(fetch(`${base}/status`).then((response) => response.json())).resolves.toMatchObject({
      protocolVersion: 29, ready: true, flashTransferSupported: true,
    })
    const manifest = {
      name: 'remote reuse', framing: 'length-prefixed-v1',
      files: [{
        source: 'qq-media', name: 'remote.bin', size: 5,
        locator: {
          messageId: 'm1', elementId: 'e1', chatType: 1, peerUid: 'friend',
          kind: 'file', fileName: 'remote.bin', fileSize: '5',
          filePath: 'Z:\\QQ\\cache\\remote.bin', md5: '11'.repeat(16), sha: '22'.repeat(20),
        },
      }],
    }
    const response = await fetch(`${base}/flash-transfers`, {
      method: 'POST',
      headers: {
        'x-qqnt-flash-manifest': Buffer.from(JSON.stringify(manifest)).toString('base64url'),
      },
      body: Buffer.alloc(0),
    })

    expect(response.status).toBe(502)
    await expect(response.json()).resolves.toEqual({
      error: 'QQ remote media cannot be reused without downloading it: remote.bin',
    })
    expect(f.flashUploadFile).not.toHaveBeenCalled()
  })

  it.runIf(process.platform === 'linux')('requires a configured bearer token for the inert wrapper probe and redacts encoded targets', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'qqnt-group-join-server-'))
    tempPaths.push(directory)
    const wrapperPath = join(directory, 'wrapper.node')
    await writeFile(wrapperPath, GROUP_JOIN_WRAPPER_MARKERS, 'ascii')
    vi.stubEnv('QQNT_BRIDGE_GROUP_JOIN_CONTRACT_PROBE', '1')
    vi.stubEnv('QQNT_BRIDGE_GROUP_JOIN_WRAPPER_PATH', wrapperPath)
    const f = fixture()
    const candidates = [
      'getGroupInfoForJoinGroup', 'queryJoinGroupCanNoVerify', 'reqToJoinGroup', 'joinGroup',
    ] as const
    const methods = candidates.map(() => vi.fn(function () { return 'native-group-service-secret' }))
    for (const [index, name] of candidates.entries()) {
      ;(f.group as Record<string, unknown>)[name] = methods[index]
    }
    const bridge = new QQKernelBridge()
    bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: '/tmp' })
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {})
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    server = new QQBridgeServer(bridge, { port: 0 })
    await server.start()
    const unsecuredBase = `http://127.0.0.1:${server.address().port}/v1`
    expect((await fetch(`${unsecuredBase}/group-join/probe`)).status).toBe(503)
    expect(await (await fetch(`${unsecuredBase}/status`)).json()).not.toHaveProperty('groupJoinContractProbe')
    await server.stop()
    const slowPath = join(directory, 'slow.log')
    server = new QQBridgeServer(bridge, {
      port: 0, token: 'probe-token', slowRequestThresholdMs: -1, slowRequestPath: slowPath,
    })
    await server.start()
    const base = `http://127.0.0.1:${server.address().port}/v1`

    expect((await fetch(`${base}/group-join/probe`)).status).toBe(401)
    expect((await fetch(`${base}/group-join/probe`, {
      headers: { authorization: 'Bearer wrong-token' },
    })).status).toBe(401)
    const status = await fetch(`${base}/status`, { headers: { authorization: 'Bearer probe-token' } })
    expect(status.status).toBe(200)
    expect(await status.json()).not.toHaveProperty('groupJoinContractProbe')

    const probe = await fetch(`${base}/group-join/probe`, { headers: { authorization: 'Bearer probe-token' } })
    expect(probe.status).toBe(200)
    const result = await probe.json() as { methods: Array<{ name: string }>, wrapperIdentity?: unknown }
    expect(result.methods.map((method) => method.name)).toEqual(candidates)
    expect(result.wrapperIdentity).toBeDefined()
    expect(JSON.stringify(result)).not.toContain(wrapperPath)
    expect(JSON.stringify(result)).not.toContain('native-group-service-secret')

    for (const path of [
      '/v1%2fgroups%2Fjoin%3Fmint',
      '/v1%2Fgroups%2fjoin%3Bmint',
      '/v1%252fgroups%252Fjoin%253Fmint',
      '/v1%252Fgroups%252fjoin%253Bmint',
      '/v1%25252525252Fgroups%25252525252Fjoin%253Fmint',
      '/v1/groups/join%ZZmint',
      '/%76%31/groups/join%ZZmint',
    ]) {
      expect((await fetch(`${base.slice(0, -3)}${path}?target=native-group-service-secret`, {
        headers: { authorization: 'Bearer probe-token' },
      })).status).toBe(404)
    }
    const logs = [consoleLog, consoleWarn]
      .flatMap((spy) => spy.mock.calls.map(([message]) => String(message)))
      .join('\n')
    const slowLogs = await readFile(slowPath, 'utf8')
    expect(logs).toContain('target="/v1/groups/join"')
    expect(`${logs}\n${slowLogs}`).not.toContain('native-group-service-secret')
    for (const method of methods) expect(method).not.toHaveBeenCalled()
  })

  it('returns a non-success response when the initial native request getter fails', async () => {
    const f = fixture()
    f.buddy.getBuddyReq.mockResolvedValue({ result: 1, errMsg: 'native unavailable' })
    const bridge = new QQKernelBridge()
    vi.spyOn(bridge as unknown as { initializePlatformData(): Promise<void> }, 'initializePlatformData').mockResolvedValue()
    bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: '/tmp' })
    server = new QQBridgeServer(bridge, { port: 0 })
    await server.start()

    const response = await fetch(`http://127.0.0.1:${server.address().port}/v1/requests?kind=friend`)
    expect(response.status).toBe(502)
    expect((await response.json() as { error: string }).error).toContain('QQNT request refresh failed:')
  })

  it('rejects filtered friend request resolution over HTTP without approvalFriendRequest', async () => {
    const f = fixture()
    f.buddy.getBuddyReq.mockResolvedValue({ buddyReqs: [] })
    f.buddy.getDoubtBuddyReq = vi.fn<NonNullable<KernelBuddyService['getDoubtBuddyReq']>>(async (reqId) => ({
      reqId, doubtList: [{ uid: 'filtered', reqTime: '1', nick: 'Filtered' }],
    }))
    const bridge = new QQKernelBridge()
    vi.spyOn(bridge as unknown as { initializePlatformData(): Promise<void> }, 'initializePlatformData').mockResolvedValue()
    bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: '/tmp' })
    server = new QQBridgeServer(bridge, { port: 0 })
    await server.start()
    const base = `http://127.0.0.1:${server.address().port}/v1/requests`
    const page = await (await fetch(`${base}?kind=friend`)).json() as { requests: Array<{ id: string }> }

    const response = await fetch(`${base}/${encodeURIComponent(page.requests[0].id)}/resolve`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'accept' }),
    })
    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({
      error: 'filtered QQ friend requests must be handled in the QQ client',
    })
    expect(f.buddy.approvalFriendRequest).not.toHaveBeenCalled()
  })

  it('maps rejected friend and group native resolutions to safe 502 responses', async () => {
    const f = fixture()
    f.buddy.getBuddyReq.mockResolvedValue({ buddyReqs: [
      { friendUid: 'friend', reqTime: '1', isInitiator: false, isDecide: false },
    ] })
    f.group.getSingleScreenNotifies.mockImplementation(async (doubt) => (
      doubt ? { notifies: [] } : { notifies: [
        { seq: '2', type: 7, status: 1, group: { groupCode: '123' }, user1: { uid: 'joiner' } },
      ] }
    ))
    f.buddy.approvalFriendRequest.mockRejectedValue(new Error('friend native secret'))
    f.group.operateSysNotify.mockRejectedValue(new Error('group native secret'))
    const bridge = new QQKernelBridge()
    bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: '/tmp' })
    server = new QQBridgeServer(bridge, { port: 0 })
    await server.start()
    const base = `http://127.0.0.1:${server.address().port}/v1/requests`
    const friend = await (await fetch(`${base}?kind=friend`)).json() as { requests: Array<{ id: string }> }
    const group = await (await fetch(`${base}?kind=group-join`)).json() as { requests: Array<{ id: string }> }
    for (const id of [friend.requests[0].id, group.requests[0].id]) {
      const response = await fetch(`${base}/${encodeURIComponent(id)}/resolve`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'accept' }),
      })
      expect(response.status).toBe(502)
      await expect(response.json()).resolves.toEqual({ error: 'QQNT request resolution failed' })
    }
  })

  it('maps native friend and group resolution errors to safe 502 responses', async () => {
    const f = fixture()
    f.buddy.getBuddyReq.mockResolvedValue({ buddyReqs: [
      { friendUid: 'friend', reqTime: '1', isInitiator: false, isDecide: false },
    ] })
    f.group.getSingleScreenNotifies.mockImplementation(async (doubt) => (
      doubt ? { notifies: [] } : { notifies: [
        { seq: '2', type: 7, status: 1, group: { groupCode: '123' }, user1: { uid: 'joiner' } },
      ] }
    ))
    f.buddy.approvalFriendRequest.mockResolvedValue({ result: 1, errMsg: 'sensitive native detail' })
    f.group.operateSysNotify.mockResolvedValue({ result: 2, errMsg: 'sensitive native detail' })
    const bridge = new QQKernelBridge()
    bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: '/tmp' })
    server = new QQBridgeServer(bridge, { port: 0 })
    await server.start()
    const base = `http://127.0.0.1:${server.address().port}/v1/requests`
    const friend = await (await fetch(`${base}?kind=friend`)).json() as { requests: Array<{ id: string }> }
    const group = await (await fetch(`${base}?kind=group-join`)).json() as { requests: Array<{ id: string }> }
    for (const id of [friend.requests[0].id, group.requests[0].id]) {
      const response = await fetch(`${base}/${encodeURIComponent(id)}/resolve`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'accept' }),
      })
      expect(response.status).toBe(502)
      await expect(response.json()).resolves.toEqual({ error: 'QQNT request resolution failed' })
    }
  })

  it('rejects an empty user ID before resolving a user', async () => {
    const f = fixture()
    const bridge = new QQKernelBridge()
    bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: '/tmp' })
    const getUser = vi.spyOn(bridge, 'getUser')
    server = new QQBridgeServer(bridge, { port: 0 })
    await server.start()

    const response = await fetch(`http://127.0.0.1:${server.address().port}/v1/users/`)

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({ error: 'user ID is required' })
    expect(getUser).not.toHaveBeenCalled()
  })

  it('resolves a UID-scoped QQNT avatar URL through the authenticated direct-url API', async () => {
    const f = fixture()
    const bridge = new QQKernelBridge()
    f.setAvatarUrl('uid-1715311957', 'https://thirdqq.qlogo.cn/avatar/http/140')
    bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: '/tmp' })
    f.emitBuddyList([{ buddyList: [{
      uid: 'uid-1715311957', uin: '1715311957', nick: 'xuuuuan', remark: '', avatarUrl: '',
    }] }])
    server = new QQBridgeServer(bridge, { port: 0 })
    await server.start()
    const base = `http://127.0.0.1:${server.address().port}/v1`

    const resolvedResponse = await fetch(`${base}/conversations/resolve?kind=direct&id=1715311957`)
    expect(resolvedResponse.status).toBe(200)
    const resolved = await resolvedResponse.json() as {
      avatar: { locator: Record<string, unknown> }
    }
    expect(resolved.avatar.locator).toMatchObject({
      peerUid: 'uid-1715311957', avatarUrl: 'https://thirdqq.qlogo.cn/avatar/http/140',
    })
    expect(resolved.avatar.locator).not.toHaveProperty('avatarUin')
    expect(f.forceDownloadAvatar).not.toHaveBeenCalled()

    const userResponse = await fetch(`${base}/users/uid-1715311957`)
    expect(userResponse.status).toBe(200)
    await expect(userResponse.json()).resolves.toMatchObject({
      id: 'uid-1715311957', numericId: '1715311957',
      avatar: { locator: { avatarUrl: 'https://thirdqq.qlogo.cn/avatar/http/140' } },
    })

    const direct = await fetch(`${base}/files/direct-url`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(resolved.avatar.locator),
    })
    expect(direct.status).toBe(200)
    await expect(direct.json()).resolves.toEqual({
      url: 'https://thirdqq.qlogo.cn/avatar/http/140', expiresAt: Number.MAX_SAFE_INTEGER,
    })
  })

  it('issues media leases only to an authorized active call and fails closed otherwise', async () => {
    const f = fixture()
    const issueLease = vi.fn(({ callId }: { callId: string }) => ({
      version: 1, socketPath: '/run/qq-pulse/qqnt-media.sock', leaseId: 'a'.repeat(32), token: Buffer.alloc(32, 7), expiry: 123,
    }))
    const revokeCallLeases = vi.fn()
    const bridge = new QQKernelBridge({ mediaGateway: { issueLease, revokeCallLeases } })
    const subscription = bridge.subscribe()
    const events = subscription[Symbol.asyncIterator]()
    bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: '/tmp' })
    server = new QQBridgeServer(bridge, { port: 0, token: 'bridge-token' })
    await server.start()
    const endpoint = `http://127.0.0.1:${server.address().port}/v1/calls/media-lease`
    const request = (callId: unknown, token = 'bridge-token') => fetch(endpoint, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ callId }),
    })

    expect((await request('inactive-call', 'wrong-token')).status).toBe(401)
    expect((await request('inactive-call')).status).toBe(403)
    f.emitAVSDK('OnInviteActionToAVSDK', {
      relation_id: '1715311957', invite_type: 1, from_uid: 'uid-1715311957',
    }, 0, 'media-lease-carrier')
    const incoming = await nextCallSignal(events)

    expect((await request('wrong-call')).status).toBe(403)
    const issued = await request(incoming.callId)
    expect(issued.status).toBe(200)
    await expect(issued.json()).resolves.toEqual({
      version: 1, socketPath: '/run/qq-pulse/qqnt-media.sock', leaseId: 'a'.repeat(32),
      token: Buffer.alloc(32, 7).toString('base64url'), expiry: 123,
    })
    expect(issueLease).toHaveBeenCalledWith({ callId: incoming.callId })

    f.emitAVSDK('onS2CActionToAVSDK', { destroyReason: 1 }, 14)
    await expect(nextCallSignal(events)).resolves.toMatchObject({ signal: 'ended', callId: incoming.callId })
    expect((await request(incoming.callId)).status).toBe(403)
    expect(revokeCallLeases).toHaveBeenCalledWith(incoming.callId)
    f.emitAVSDK('onS2CActionToAVSDK', { destroyReason: 1 }, 14)
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(revokeCallLeases).toHaveBeenCalledTimes(1)
    bridge.unsubscribe(subscription)
    bridge.detach()
    await server.stop()

    const disabled = new QQKernelBridge()
    disabled.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: '/tmp' })
    server = new QQBridgeServer(disabled, { port: 0, token: 'bridge-token' })
    await server.start()
    const unavailable = await fetch(`http://127.0.0.1:${server.address().port}/v1/calls/media-lease`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer bridge-token' },
      body: JSON.stringify({ callId: 'inactive-call' }),
    })
    expect(unavailable.status).toBe(503)
    await expect(unavailable.json()).resolves.toEqual({ error: 'media lease unavailable' })
    disabled.detach()
  })

  it('controls only the exact active call through the authenticated HTTP route', async () => {
    const f = fixture()
    const control = vi.fn().mockResolvedValue(undefined)
    const bridge = new QQKernelBridge({ callController: { control } })
    const subscription = bridge.subscribe()
    const events = subscription[Symbol.asyncIterator]()
    bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: '/tmp' })
    server = new QQBridgeServer(bridge, { port: 0, token: 'bridge-token' })
    await server.start()
    const endpoint = `http://127.0.0.1:${server.address().port}/v1/calls/control`
    const request = (callId: unknown, operation: unknown, token = 'bridge-token') => fetch(endpoint, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ callId, operation }),
    })

    expect((await request('inactive', 'accept', 'wrong')).status).toBe(401)
    expect((await request('inactive', 'answer')).status).toBe(400)
    expect((await request('inactive', 'accept')).status).toBe(403)
    f.emitAVSDK('OnInviteActionToAVSDK', {
      relation_id: '1715311957', invite_type: 1, from_uid: 'uid-1715311957',
    }, 0, 'http-renderer-control')
    const incoming = await nextCallSignal(events)

    expect((await request('stale-call', 'accept')).status).toBe(403)
    const accepted = await request(incoming.callId, 'accept')
    expect(accepted.status).toBe(200)
    await expect(accepted.json()).resolves.toEqual({ ok: true })
    expect(control).toHaveBeenCalledOnce()
    expect(control).toHaveBeenCalledWith('accept')

    expect((await request(incoming.callId, 'hangup')).status).toBe(200)
    expect(control).toHaveBeenLastCalledWith('hangup')
    bridge.unsubscribe(subscription)
    bridge.detach()
  })

  it('redacts media lease query values from every request log target', async () => {
    const f = fixture()
    const bridge = new QQKernelBridge()
    bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: '/tmp' })
    const directory = await mkdtemp(join(tmpdir(), 'qqnt-bridge-server-'))
    tempPaths.push(directory)
    const slowRequestPath = join(directory, 'slow.log')
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {})
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    server = new QQBridgeServer(bridge, { port: 0, slowRequestThresholdMs: -1, slowRequestPath })
    await server.start()
    const callId = 'query-call-id-must-not-log'

    const response = await fetch(`http://127.0.0.1:${server.address().port}/v1/calls/media-lease?callId=${callId}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{',
    })

    expect(response.status).toBe(500)
    const messages = [
      ...consoleLog.mock.calls, ...consoleWarn.mock.calls, ...consoleError.mock.calls,
    ].map(([message]) => String(message)).filter((message) => message.includes('HTTP request') || message.includes('slow HTTP request'))
    expect(messages).toEqual(expect.arrayContaining([
      expect.stringContaining('HTTP request start'),
      expect.stringContaining('HTTP request complete'),
      expect.stringContaining('HTTP request failed'),
      expect.stringContaining('slow HTTP request'),
    ]))
    for (const message of messages) expect(message).toContain('target="/v1/calls/media-lease"')
    expect(messages.join('\n')).not.toContain(callId)
    const [slowRecord] = (await readFile(slowRequestPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
    expect(slowRecord).toMatchObject({ target: '/v1/calls/media-lease', route: '/v1/calls/media-lease' })
    expect(JSON.stringify(slowRecord)).not.toContain(callId)
  })

  it('rejects oversized voice bodies before staging, including chunked requests', async () => {
    const f = fixture()
    const root = await mkdtemp(join(tmpdir(), 'qqnt-voice-http-limit-'))
    tempPaths.push(root)
    const bridge = new QQKernelBridge({ tempPath: join(root, 'cache-root'), voiceInputLimitBytes: 4 })
    bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: root })
    server = new QQBridgeServer(bridge, { port: 0 })
    await server.start()
    const endpoint = `http://127.0.0.1:${server.address().port}/v1/messages`
    const manifest = Buffer.from(JSON.stringify({
      conversationId: 'uid-1715311957', media: [{ kind: 'voice', name: 'voice.ogg' }],
    })).toString('base64url')

    const declared = await fetch(endpoint, {
      method: 'POST', headers: { 'x-qqnt-manifest': manifest, 'content-length': '5' }, body: Uint8Array.of(1, 2, 3, 4, 5),
    })
    expect(declared.status).toBe(413)

    const chunked = await fetch(endpoint, {
      method: 'POST', headers: { 'x-qqnt-manifest': manifest },
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(Uint8Array.of(1, 2, 3))
          controller.enqueue(Uint8Array.of(4, 5, 6))
          controller.close()
        },
      }),
      duplex: 'half',
    } as RequestInit & { duplex: 'half' })
    expect(chunked.status).toBe(500)
    await expect(chunked.json()).resolves.toMatchObject({ error: expect.stringContaining('voice input exceeds') })
    await expect(readdir(join(root, '.qqnt-bridge-staging', 'voice')).catch(() => [])).resolves.toEqual([])
    expect(f.msg.sendMsg).not.toHaveBeenCalled()
  })

  it('serves a data-line dialog, history, and native send through the HTTP API', async () => {
    const f = fixture()
    const deviceRecord: MsgRecord = {
      ...f.message,
      msgId: 'device-http-message',
      chatType: 134,
      peerUid: 'mobile-device',
      peerUin: '',
      peerName: '我的电脑',
      elements: [{ elementType: 1, elementId: 'text', textElement: { content: 'from device' } }],
    }
    f.recent.getRecentContactInfos.mockResolvedValue({
      result: 0,
      errMsg: '',
      relation: [{
        chatType: 134, peerUid: 'mobile-device', peerUin: '', peerName: '我的电脑',
        remark: '', avatarUrl: '', unreadCnt: '0', msgId: deviceRecord.msgId,
        msgTime: deviceRecord.msgTime, senderUid: 'self', senderUin: '10000', abstractContent: [],
      }],
    })
    f.msg.getMsgsByMsgId.mockResolvedValue({ result: 0, errMsg: '', msgList: [deviceRecord] })
    f.msg.getLatestDbMsgs.mockResolvedValue({ result: 0, errMsg: '', msgList: [deviceRecord] })
    f.msg.sendMsg.mockImplementationOnce(async (_id, peer, elements) => {
      expect(peer).toMatchObject({ chatType: 134, peerUid: 'mobile-device' })
      queueMicrotask(() => f.emitSent({
        ...deviceRecord, msgId: 'device-http-sent', sendStatus: 2, elements,
      }))
      return { result: 0, errMsg: '' }
    })
    const bridge = new QQKernelBridge()
    bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: '/tmp' })
    server = new QQBridgeServer(bridge, { port: 0 })
    await server.start()
    const base = `http://127.0.0.1:${server.address().port}/v1`

    const dialogsResponse = await fetch(`${base}/dialogs`)
    expect(dialogsResponse.status).toBe(200)
    await expect(dialogsResponse.json()).resolves.toMatchObject({
      conversations: [{ id: 'device:134:mobile-device', title: '我的电脑', chatType: 134 }],
    })
    const historyResponse = await fetch(
      `${base}/conversations/${encodeURIComponent('device:134:mobile-device')}/history?limit=20`,
    )
    expect(historyResponse.status).toBe(200)
    await expect(historyResponse.json()).resolves.toMatchObject({
      messages: [{ id: 'device-http-message', conversationId: 'device:134:mobile-device' }],
    })
    const manifest = Buffer.from(JSON.stringify({
      conversationId: 'device:134:mobile-device', text: 'saved over HTTP',
    })).toString('base64url')
    const sendResponse = await fetch(`${base}/messages`, {
      method: 'POST', headers: { 'x-qqnt-manifest': manifest }, body: new Uint8Array(),
    })
    expect(sendResponse.status).toBe(200)
    await expect(sendResponse.json()).resolves.toMatchObject({
      id: 'device-http-sent', conversationId: 'device:134:mobile-device',
      parts: [{ type: 'text', text: 'saved over HTTP' }],
    })
    expect(f.protocolSend).not.toHaveBeenCalled()
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
      protocolVersion: 29, ready: true, selfUin: '10000',
    })
    const dialogs = await fetch(`${base}/dialogs`)
    expect(dialogs.status).toBe(200)
    expect(dialogs.headers.get('cache-control')).toBe('private, no-cache')
    expect(dialogs.headers.get('vary')).toBe('authorization')
    const dialogsEtag = dialogs.headers.get('etag')
    expect(dialogsEtag).toMatch(/^"[A-Za-z0-9_-]+"$/)
    await expect(dialogs.json()).resolves.toMatchObject({
      conversations: [{ peerUin: '1715311957' }],
    })
    const unchangedDialogs = await fetch(`${base}/dialogs`, {
      headers: { 'if-none-match': dialogsEtag! },
    })
    expect(unchangedDialogs.status).toBe(304)
    expect(unchangedDialogs.headers.get('etag')).toBe(dialogsEtag)
    expect(await unchangedDialogs.text()).toBe('')
    const history = await fetch(`${base}/conversations/uid-1715311957/history?limit=20`)
    expect(history.status).toBe(200)
    const historyEtag = history.headers.get('etag')
    expect(historyEtag).toMatch(/^"[A-Za-z0-9_-]+"$/)
    await history.json()
    const unchangedHistory = await fetch(`${base}/conversations/uid-1715311957/history?limit=20`, {
      headers: { 'if-none-match': historyEtag! },
    })
    expect(unchangedHistory.status).toBe(304)
    expect(unchangedHistory.headers.get('etag')).toBe(historyEtag)
    expect(await unchangedHistory.text()).toBe('')
    await expect(fetch(`${base}/conversations/uid-1715311957/search?q=hello&limit=10`)
      .then((response) => response.json())).resolves.toMatchObject({
      messages: [{ id: 'http-search' }],
    })
    await expect(fetch(`${base}/conversations/${encodeURIComponent('2:1058754719')}/group-files?limit=20`)
      .then((response) => response.json())).resolves.toEqual({ items: [], total: 0 })
    expect(f.richMedia.getGroupFileList).toHaveBeenCalledWith('1058754719', expect.objectContaining({
      startIndex: 0, fileCount: 20,
    }))
    const prepare = vi.spyOn(bridge, 'prepareMediaUpload').mockResolvedValueOnce({
      prepared: { kind: 'image', fileUuid: 'http-prepared', msgInfo: 'bXNn' },
    })
    const uploadPlan = await fetch(`${base}/uploads/prepare`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ conversationId: 'uid-1715311957', media: {
        kind: 'image', name: 'http.png', size: 3,
        md5: '5289df737df57326fcdd22597afb1fac', sha1: '7037807198c22a7d2b0807371d763779a84fdfcf',
      } }),
    })
    expect(uploadPlan.status).toBe(200)
    await expect(uploadPlan.json()).resolves.toEqual({
      prepared: { kind: 'image', fileUuid: 'http-prepared', msgInfo: 'bXNn' },
    })
    expect(prepare).toHaveBeenCalledWith('uid-1715311957', expect.objectContaining({
      kind: 'image', name: 'http.png', size: 3,
    }))
    prepare.mockRejectedValueOnce(new QQMediaUploadRejectedError(
      'QQ group file upload preparation failed: 永久空间不足, 请清理文件列表后重试 (-403)',
    ))
    const rejectedUpload = await fetch(`${base}/uploads/prepare`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ conversationId: '1058754719', media: {
        kind: 'file', name: 'full.bin', size: 3,
        md5: '5289df737df57326fcdd22597afb1fac', sha1: '7037807198c22a7d2b0807371d763779a84fdfcf',
      } }),
    })
    expect(rejectedUpload.status).toBe(422)
    await expect(rejectedUpload.json()).resolves.toEqual({
      error: 'QQ group file upload preparation failed: 永久空间不足, 请清理文件列表后重试 (-403)',
    })
    const manifest = Buffer.from(JSON.stringify({
      conversationId: 'uid-1715311957', text: 'via HTTP',
    })).toString('base64url')
    const response = await fetch(`${base}/messages`, {
      method: 'POST', headers: { 'x-qqnt-manifest': manifest }, body: new Uint8Array(),
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ id: 'm1' })
    const read = await fetch(`${base}/messages/read`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ conversationId: 'uid-1715311957', messageId: 'm1' }),
    })
    expect(read.status).toBe(200)
    await expect(read.json()).resolves.toEqual({ ok: true })
    expect(f.msg.setSpecificMsgReadAndReport).toHaveBeenCalledWith(
      expect.objectContaining({ chatType: 1, peerUid: 'uid-1715311957' }), 'm1',
    )
    f.msg.setSpecificMsgReadAndReport.mockResolvedValueOnce({
      result: 4, errMsg: 'Data Not Existed!',
    })
    const repeatedRead = await fetch(`${base}/messages/read`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ conversationId: 'uid-1715311957', messageId: 'already-gone' }),
    })
    expect(repeatedRead.status).toBe(200)
    await expect(repeatedRead.json()).resolves.toEqual({ ok: true })
  })

  it('returns and negatively caches missing favorite sticker assets as HTTP 404', async () => {
    const f = fixture()
    const bridge = new QQKernelBridge({ stickerMissingCacheTtlMs: 10_000 })
    bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: '/tmp' })
    vi.spyOn(bridge, 'getDirectUrl').mockResolvedValue({
      url: 'https://cdn.invalid/missing-favorite.png', expiresAt: Date.now() + 60_000,
    })
    const originalFetch = globalThis.fetch
    const fetchAsset = vi.fn(async () => new Response(null, { status: 404 }))
    vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) =>
      String(input).startsWith('https://cdn.invalid/')
        ? fetchAsset()
        : originalFetch(input, init))
    server = new QQBridgeServer(bridge, { port: 0 })
    await server.start()
    const base = `http://127.0.0.1:${server.address().port}/v1`
    const body = JSON.stringify({
      kind: 'favorite', resId: 'missing-favorite', path: '', name: 'missing.png', animated: false,
      locator: {
        messageId: 'sticker-message', elementId: 'sticker-element', chatType: 2,
        peerUid: 'group', kind: 'image', fileName: 'missing.png', fileUuid: 'missing-uuid',
      },
    })

    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await fetch(`${base}/stickers/asset`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body,
      })
      expect(response.status).toBe(404)
      await expect(response.json()).resolves.toMatchObject({ error: expect.stringContaining('favorite sticker') })
    }
    expect(fetchAsset).toHaveBeenCalledOnce()
  })

  it('streams a QQ favorite from its native CDN URL when the local collection file is absent', async () => {
    const f = fixture()
    const bridge = new QQKernelBridge()
    bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: '/tmp' })
    const originalFetch = globalThis.fetch
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47])
    const fetchAsset = vi.fn(async () => new Response(bytes, {
      status: 200, headers: { 'content-type': 'image/png', 'content-length': String(bytes.length) },
    }))
    vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) =>
      String(input) === 'https://cdn.example/favorite.png'
        ? fetchAsset()
        : originalFetch(input, init))
    server = new QQBridgeServer(bridge, { port: 0 })
    await server.start()
    const base = `http://127.0.0.1:${server.address().port}/v1`

    const response = await fetch(`${base}/stickers/asset`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
        kind: 'favorite', resId: 'cdn-favorite', path: '/missing/favorite.png',
        name: 'favorite.png', animated: false, url: 'https://cdn.example/favorite.png',
      }),
    })

    expect(response.status).toBe(200)
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes)
    expect(fetchAsset).toHaveBeenCalledOnce()
  })

  it('preserves a remote QQ favorite aspect ratio across the HTTP collection pipeline', async () => {
    const f = fixture()
    f.msg.fetchFavEmojiList.mockResolvedValue({
      result: 0, errMsg: '', emojiInfoList: [{
        emoPath: '/missing/wide.png', isExist: false, resId: 'wide-favorite',
        url: 'https://cdn.example/wide-favorite.png', md5: 'wide-md5',
        emoOriginalPath: '', thumbPath: '', isAPNG: false, isMarkFace: false,
        eId: '', epId: '', desc: 'Wide favorite',
      }],
    })
    const originalFetch = globalThis.fetch
    const png = completePng(640, 360)
    const fetchAsset = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response(png, {
      status: 206,
      headers: {
        'content-type': 'image/png',
        'content-range': `bytes 0-${png.length - 1}/54321`,
      },
    }))
    vi.spyOn(globalThis, 'fetch').mockImplementation((input: string | URL | Request, init?: RequestInit) =>
      String(input) === 'https://cdn.example/wide-favorite.png'
        ? fetchAsset(input, init)
        : originalFetch(input, init))
    const bridge = new QQKernelBridge()
    bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: '/tmp' })
    server = new QQBridgeServer(bridge, { port: 0 })
    await server.start()

    const response = await fetch(`http://127.0.0.1:${server.address().port}/v1/stickers/saved`)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      stickers: [{
        stickerId: 'favorite:wide-favorite', width: 640, height: 360, size: 54_321, version: 2,
        reference: { width: 640, height: 360, size: 54_321, mimeType: 'image/png' },
      }],
    })
    expect(fetchAsset).toHaveBeenCalledWith(
      'https://cdn.example/wide-favorite.png',
      expect.objectContaining({ headers: { range: 'bytes=0-262143' } }),
    )
  })

  it('decrypts an animated market sticker across the HTTP favorite pipeline', async () => {
    const f = fixture()
    const directory = await mkdtemp(join(tmpdir(), 'qqnt-http-favorite-market-'))
    tempPaths.push(directory)
    const dynamicPath = join(directory, 'market.gif.encrypt')
    const gif = Buffer.from('GIF89a-http-favorite')
    await writeFile(dynamicPath, gif.map((byte, index) => index % 50 < 20 ? ~byte : byte))
    let favoritePath: string | undefined
    f.msg.addFavEmoji.mockImplementation(async (request) => {
      favoritePath = request.emojiPath
      expect(await readFile(request.emojiPath)).toEqual(gif)
      return { result: 0, errMsg: '', isExist: 0 }
    })
    const bridge = new QQKernelBridge()
    bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: directory })
    server = new QQBridgeServer(bridge, { port: 0 })
    await server.start()

    const response = await fetch(`http://127.0.0.1:${server.address().port}/v1/stickers/saved`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
        saved: true,
        reference: {
          kind: 'market', packageId: '42', stickerId: 'emoji-a', name: '[Wave]', key: 'secret',
          width: 320, height: 180, animated: true, dynamicPath,
        },
      }),
    })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ ok: true })
    expect(f.msg.addFavEmoji).toHaveBeenCalledWith(expect.objectContaining({
      emojiId: 'emoji-a', packageId: 42, isMarkFace: true,
    }))
    expect(favoritePath).toBeDefined()
    expect(existsSync(favoritePath!)).toBe(false)
  })

  it('keeps image and sticker origin IDs across the HTTP-to-WebSocket send pipeline', async () => {
    const f = fixture()
    f.msg.getMsgUniqueId.mockReturnValue('0')
    let sendIndex = 0
    f.protocolSend.mockImplementation(async (_chatType, _peerUid, _peerUin, parts) => {
      const elements = parts.flatMap(testProtocolElements)
      const messageId = `media-http-${++sendIndex}`
      queueMicrotask(async () => {
        await f.emitSent({
          ...f.message, msgId: messageId, msgTime: '0', sendStatus: 1,
          elements: [{ elementType: 1, elementId: 'placeholder', textElement: { content: '[媒体]' } }],
        })
        await f.emitMessages([{ ...f.message, msgId: messageId, sendStatus: 2, elements }])
      })
      return { sequence: BigInt(sendIndex), clientSequence: BigInt(sendIndex), sendTime: 0 }
    })
    const bridge = new QQKernelBridge()
    bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: '/tmp' })
    server = new QQBridgeServer(bridge, { port: 0 })
    await server.start()
    const base = `http://127.0.0.1:${server.address().port}/v1`
    const socket = new WebSocket(base.replace('http:', 'ws:') + '/events/ws')
    await once(socket, 'open')
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      'base64',
    )
    const cases = [
      {
        kind: 'image', originRequestId: 'http-image-origin', body: png,
        manifest: {
          conversationId: 'uid-1715311957', originRequestId: 'http-image-origin',
          media: [{ kind: 'image', name: 'http-echo.png', size: png.length }],
        },
      },
      {
        kind: 'sticker', originRequestId: 'http-sticker-origin', body: new Uint8Array(),
        manifest: {
          conversationId: 'uid-1715311957', originRequestId: 'http-sticker-origin',
          sticker: {
            kind: 'sysface', faceId: '476', faceType: 3, name: '/不是吧', animated: true,
            packId: '3', stickerId: '476', sourceType: 1, stickerType: 2,
          },
        },
      },
    ]

    for (const item of cases) {
      const nextFrame = once(socket, 'message')
      const response = await fetch(`${base}/messages`, {
        method: 'POST',
        headers: { 'x-qqnt-manifest': Buffer.from(JSON.stringify(item.manifest)).toString('base64url') },
        body: item.body,
      })
      const responseMessage = await response.json() as { id: string, originRequestId?: string }
      const [raw] = await nextFrame
      const frame = JSON.parse(raw.toString())

      expect(response.status).toBe(200)
      expect(responseMessage).toMatchObject({ originRequestId: item.originRequestId })
      expect(frame).toMatchObject({ event: {
        type: 'message',
        message: { id: responseMessage.id, originRequestId: item.originRequestId, outgoing: true },
      } })
    }
    socket.close()
    await once(socket, 'close')
  })

  it('serves a hydrated image as the dialog top message instead of QQ recent abstract text', async () => {
    const f = fixture()
    f.recent.getRecentContactInfos.mockResolvedValue({
      result: 0, errMsg: '', relation: [{
        chatType: 2, peerUid: 'image-group', peerUin: 'image-group', peerName: 'Image Group',
        remark: '', avatarUrl: '', unreadCnt: '0', msgId: 'image-top',
        msgTime: '1800000088', senderUid: 'member', senderUin: '42',
        abstractContent: [{ elementType: 2, content: '[图片]' }],
      }],
    })
    f.msg.getMsgsByMsgId.mockResolvedValue({
      result: 0, errMsg: '', msgList: [{
        ...f.message,
        msgId: 'image-top', msgSeq: '88', msgTime: '1800000088', chatType: 2,
        peerUid: 'image-group', peerUin: 'image-group', peerName: 'Image Group',
        senderUid: 'member', senderUin: '42', sendType: 2,
        elements: [{ elementType: 2, elementId: 'image-element', picElement: {
          fileName: 'top.jpg', fileSize: '1024', picWidth: 640, picHeight: 480,
          md5HexStr: 'top-md5', fileUuid: 'top-uuid', fileSubId: '', picSubType: 0,
        } }],
      }],
    })
    const bridge = new QQKernelBridge()
    bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: '/tmp' })
    server = new QQBridgeServer(bridge, { port: 0 })
    await server.start()
    const url = `http://127.0.0.1:${server.address().port}/v1/dialogs`

    const first = await fetch(url).then((response) => response.json()) as {
      conversations: Array<{ lastMessage?: { parts: unknown[] } }>
    }
    expect(first.conversations[0]?.lastMessage).toMatchObject({
      id: 'image-top', msgSeq: '88',
      parts: [{ type: 'media', media: { kind: 'image', name: 'top.jpg', width: 640, height: 480 } }],
    })
    expect(JSON.stringify(first)).not.toContain('[图片]')

    await fetch(url)
    expect(f.msg.getMsgsByMsgId).toHaveBeenCalledOnce()
  })

  it('passes opaque reaction actor offsets through the HTTP API', async () => {
    const f = fixture()
    const bridge = new QQKernelBridge()
    bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: '/tmp' })
    const message = {
      ...f.message,
      chatType: 2 as const,
      peerUid: '1058754719',
      peerUin: '1058754719',
      emojiLikesList: [{ emojiType: '2', emojiId: '128522', likesCnt: '2', isClicked: false }],
    }
    f.msg.getMsgsByMsgId.mockResolvedValue({ result: 0, errMsg: '', msgList: [message] })
    f.msg.getMsgEmojiLikesList
      .mockResolvedValueOnce({
        result: 0, errMsg: '', cookie: 'next', isFirstPage: true, isLastPage: false,
        emojiLikesList: [{ tinyId: 'actor-a', nickName: 'Alice', headUrl: '' }],
      })
      .mockResolvedValueOnce({
        result: 0, errMsg: '', cookie: 'done', isFirstPage: false, isLastPage: true,
        emojiLikesList: [{ tinyId: 'actor-b', nickName: 'Bob', headUrl: '' }],
      })
    server = new QQBridgeServer(bridge, { port: 0 })
    await server.start()
    const base = `http://127.0.0.1:${server.address().port}/v1/messages/reactions/list`
    const first = await fetch(`${base}?conversationId=1058754719&messageId=m1&reactionKey=2%3A128522&limit=1`)
      .then((response) => response.json()) as { actors: unknown[], nextOffset?: string }
    expect(first).toMatchObject({
      actors: [{ reactionKey: '2:128522', actor: { userId: 'actor-a' } }],
      nextOffset: expect.any(String),
    })
    const second = await fetch(`${base}?conversationId=1058754719&messageId=m1&reactionKey=2%3A128522&limit=1&offset=${encodeURIComponent(first.nextOffset!)}`)
      .then((response) => response.json())
    expect(second).toMatchObject({
      actors: [{ reactionKey: '2:128522', actor: { userId: 'actor-b' } }],
    })
  })

  it('passes the persisted message sequence through reaction HTTP lookups', async () => {
    const f = fixture()
    const bridge = new QQKernelBridge()
    bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: '/tmp' })
    const message = {
      ...f.message,
      msgId: 'current-id',
      msgSeq: '411715',
      chatType: 2 as const,
      peerUid: '1058754719',
      peerUin: '1058754719',
      emojiLikesList: [{ emojiType: '2', emojiId: '128522', likesCnt: '1', isClicked: false }],
    }
    f.msg.getMsgsByMsgId.mockResolvedValue({ result: 0, errMsg: '', msgList: [] })
    f.msg.getMsgsBySeqAndCount.mockResolvedValue({ result: 0, errMsg: '', msgList: [message] })
    f.msg.getMsgEmojiLikesList.mockResolvedValue({
      result: 0, errMsg: '', cookie: '', isFirstPage: true, isLastPage: true,
      emojiLikesList: [{ tinyId: 'actor-a', nickName: 'Alice', headUrl: '' }],
    })
    server = new QQBridgeServer(bridge, { port: 0 })
    await server.start()
    const base = `http://127.0.0.1:${server.address().port}/v1/messages/reactions`
    const response = await fetch(
      `${base}?conversationId=1058754719&messageId=stale-id&messageSequence=411715`,
    ).then((value) => value.json())

    expect(response).toMatchObject({
      reactions: [{ key: '2:128522', recentActors: [{ userId: 'actor-a' }] }],
    })
    expect(f.msg.getMsgsBySeqAndCount).toHaveBeenCalledWith(
      expect.objectContaining({ peerUid: '1058754719' }), '411715', 1, true, true,
    )
  })

  it('streams an S2C-pushed reaction over WebSocket', async () => {
    const f = fixture()
    const bridge = new QQKernelBridge()
    vi.spyOn(bridge as unknown as { initializePlatformData(): Promise<void> }, 'initializePlatformData').mockResolvedValue()
    bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: '/tmp' })
    const conversation = bridge.getConversation('1058754719')
    const target = {
      ...f.message,
      msgId: 'ws-pushed-reaction-target', msgSeq: '799177', chatType: 2 as const,
      peerUid: '1058754719', peerUin: '1058754719', sendType: 0,
      senderUid: 'member-a', senderUin: '42', emojiLikesList: [],
    }
    f.msg.getLatestDbMsgs.mockResolvedValue({ result: 0, errMsg: '', msgList: [target] })
    await bridge.getHistory(conversation)
    server = new QQBridgeServer(bridge, { port: 0 })
    await server.start()
    const socket = new WebSocket(`ws://127.0.0.1:${server.address().port}/v1/events/ws`)
    await once(socket, 'open')
    const frame = once(socket, 'message')

    f.emitS2C(groupReactionPushBytes({ operatorUid: 'actor-a', currentCount: 1 }))

    const [raw] = await frame
    expect(JSON.parse(raw.toString())).toMatchObject({ event: {
      type: 'message-reactions',
      eventId: expect.stringMatching(/^reaction-push:ws-pushed-reaction-target:/),
      target: { messageId: 'ws-pushed-reaction-target' },
      context: { reactions: [{ key: '2:10068', count: 1 }] },
    } })
    socket.close()
    await once(socket, 'close')
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

  it('bounds stale-cursor replay, yields in batches, samples logs, and keeps the subscriber live', async () => {
    const f = fixture()
    const bridge = new QQKernelBridge()
    bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: '/tmp' })
    const observation = bridge.subscribe()
    const observed = observation[Symbol.asyncIterator]()
    const records = Array.from({ length: 600 }, (_, index) => ({
      ...f.message,
      msgId: `buffered-${index}`,
      msgSeq: String(index + 1),
      sendType: 0,
      senderUid: 'friend',
      senderUin: '42',
      sendNickName: 'Friend',
    }))
    f.emitReceived(records)
    for (let index = 0; index < records.length; index++) await observed.next()
    bridge.unsubscribe(observation)

    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {})
    server = new QQBridgeServer(bridge, { port: 0 })
    await server.start()
    const socket = new WebSocket(
      `ws://127.0.0.1:${server.address().port}/v1/events/ws?lastEventId=evicted-cursor`,
    )
    const frames: Array<{ id: string, event: { message?: { id?: string } } }> = []
    socket.on('message', (raw) => frames.push(JSON.parse(raw.toString())))

    await once(socket, 'open')
    await vi.waitFor(() => expect(frames).toHaveLength(512), { timeout: 5_000 })
    expect(frames[0]?.event.message?.id).toBe('buffered-88')
    expect(frames.at(-1)?.event.message?.id).toBe('buffered-599')
    expect(socket.readyState).toBe(WebSocket.OPEN)
    expect(bridge.events.size).toBe(1)

    f.emitReceived([{
      ...f.message, msgId: 'after-replay', msgSeq: '601', sendType: 0,
      senderUid: 'friend', senderUin: '42', sendNickName: 'Friend',
    }])
    await vi.waitFor(() => expect(frames).toHaveLength(513))
    expect(frames.at(-1)?.event.message?.id).toBe('after-replay')
    const writes = consoleLog.mock.calls.filter(([message]) =>
      String(message).includes('WebSocket event write request='))
    // 512 replay frames are sampled at 1, 100, 200, 300, 400, 500 and 512;
    // the following live frame is intentionally logged normally.
    expect(writes).toHaveLength(8)

    socket.close()
    await once(socket, 'close')
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

  it('serves only user-data media paths through the authenticated asset route', async () => {
    const f = fixture()
    const bridge = new QQKernelBridge()
    const root = await mkdtemp(join(tmpdir(), 'qqnt-media-asset-'))
    const path = join(root, 'preview.png')
    await writeFile(path, Buffer.from('preview'))
    bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: root })
    server = new QQBridgeServer(bridge, { port: 0 })
    await server.start()
    const base = `http://127.0.0.1:${server.address().port}/v1`

    const response = await fetch(`${base}/files/asset`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', range: 'bytes=1-4' },
      body: JSON.stringify({
        messageId: 'message', elementId: 'preview', chatType: 2, peerUid: 'group',
        kind: 'image', fileName: 'preview.png', filePath: path,
      }),
    })

    expect(response.status).toBe(206)
    expect(response.headers.get('content-range')).toBe('bytes 1-4/7')
    expect(Buffer.from(await response.arrayBuffer()).toString()).toBe('revi')
    const denied = await fetch(`${base}/files/asset`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        messageId: 'message', elementId: 'outside', chatType: 2, peerUid: 'group',
        kind: 'file', fileName: basename(process.execPath), filePath: process.execPath,
      }),
    })
    expect(denied.status).toBe(404)
    await rm(root, { recursive: true, force: true })
  })

  it('uses the Linux account config directory as a trusted media root when QQ omits userPath', async () => {
    const f = fixture()
    const bridge = new QQKernelBridge()
    const home = await mkdtemp(join(tmpdir(), 'qqnt-media-home-'))
    const root = join(home, '.config')
    const path = join(root, 'nt_data', 'Video', 'Thumb', 'preview.png')
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, Buffer.from('preview'))
    vi.stubEnv('XDG_CONFIG_HOME', '')
    vi.stubEnv('HOME', home)
    bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self' })
    server = new QQBridgeServer(bridge, { port: 0 })
    await server.start()
    const base = `http://127.0.0.1:${server.address().port}/v1`

    const response = await fetch(`${base}/files/asset`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        messageId: 'message', elementId: 'preview', chatType: 2, peerUid: 'group',
        kind: 'image', fileName: 'preview.png', filePath: path,
      }),
    })
    expect(response.status).toBe(200)
    expect(Buffer.from(await response.arrayBuffer()).toString()).toBe('preview')

    const denied = await fetch(`${base}/files/asset`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        messageId: 'message', elementId: 'outside', chatType: 2, peerUid: 'group',
        kind: 'file', fileName: basename(process.execPath), filePath: process.execPath,
      }),
    })
    expect(denied.status).toBe(404)
    await rm(home, { recursive: true, force: true })
  })

  it('serves only catalog-keyed reaction assets with byte ranges', async () => {
    const f = fixture()
    const bridge = new QQKernelBridge()
    bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: '/tmp' })
    const open = vi.spyOn(bridge, 'openReactionResource').mockResolvedValue({
      stream: Readable.from(Buffer.from('bcd')), mimeType: 'image/png',
      size: 5, offset: 1, length: 3,
    })
    server = new QQBridgeServer(bridge, { port: 0 })
    await server.start()
    const base = `http://127.0.0.1:${server.address().port}/v1`

    const response = await fetch(`${base}/reactions/asset`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', range: 'bytes=1-3' },
      body: JSON.stringify({ reactionKey: '1:14', filePath: 'C:\\should-not-be-readable' }),
    })

    expect(response.status).toBe(206)
    expect(response.headers.get('content-range')).toBe('bytes 1-3/5')
    expect(Buffer.from(await response.arrayBuffer()).toString()).toBe('bcd')
    expect(open).toHaveBeenCalledWith('1:14', { offset: 1, limit: 3 })
  })

  it('serves sticker assets with byte ranges', async () => {
    const f = fixture()
    const bridge = new QQKernelBridge()
    bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: '/tmp' })
    const open = vi.spyOn(bridge, 'openSticker').mockResolvedValue({
      stream: Readable.from(Buffer.from('abcdefgh')), mimeType: 'image/png', size: 8,
    })
    server = new QQBridgeServer(bridge, { port: 0 })
    await server.start()
    const base = `http://127.0.0.1:${server.address().port}/v1`

    const response = await fetch(`${base}/stickers/asset`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', range: 'bytes=2-5' },
      body: JSON.stringify({
        kind: 'favorite', resId: 'saved', path: '/saved/sticker.png', name: 'sticker.png', animated: false,
      }),
    })

    expect(response.status).toBe(206)
    expect(response.headers.get('content-range')).toBe('bytes 2-5/8')
    expect(response.headers.get('content-length')).toBe('4')
    expect(Buffer.from(await response.arrayBuffer()).toString()).toBe('cdef')
    expect(open).toHaveBeenCalledOnce()
  })

  it('destroys the sticker source when the HTTP client abandons its response', async () => {
    const f = fixture()
    const bridge = new QQKernelBridge()
    bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: '/tmp' })
    let sourceClosed = false
    const source = new Readable({
      read() { this.push(Buffer.alloc(64 * 1024, 0x5a)) },
    })
    source.once('close', () => { sourceClosed = true })
    vi.spyOn(bridge, 'openSticker').mockResolvedValue({
      stream: source, mimeType: 'image/png', size: 16 * 1024 * 1024,
    })
    server = new QQBridgeServer(bridge, { port: 0 })
    await server.start()
    const response = await fetch(`http://127.0.0.1:${server.address().port}/v1/stickers/asset`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        kind: 'favorite', resId: 'saved', path: '/saved/sticker.png', name: 'sticker.png', animated: false,
      }),
    })
    const reader = response.body!.getReader()
    await reader.read()
    await reader.cancel()

    await vi.waitFor(() => expect(sourceClosed).toBe(true))
  })

  it('serves a packet-resolved video direct URL and its expiry', async () => {
    const originalPlatform = process.platform
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    try {
    const f = fixture()
    const sendPacket = vi.fn(async () => ({ rspbuffer: Buffer.from('video-response') }))
    Object.assign(f.msg, { sendSsoCmdReqByContend: sendPacket })
    const addon = packetAddonFixture()
    addon.encodeVideoDownloadRequest = vi.fn(() => ({
      command: 'OidbSvcTrpcTcp.0x11ea_200', payload: Buffer.from('video-request'),
    }))
    addon.decodeVideoDownloadResponse = vi.fn(() => ({
      url: 'https://media.example/domain.mp4?token=secret', ttlSeconds: 60, createdAt: 1_800_000_000,
    }))
    const bridge = new QQKernelBridge({ packetClient: { addon, now: () => 1_800_000_000_000 } })
    bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: '/tmp' })
    server = new QQBridgeServer(bridge, { port: 0 })
    await server.start()
    const response = await fetch(`http://127.0.0.1:${server.address().port}/v1/files/direct-url`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        messageId: 'video-message', elementId: 'video-element', chatType: 2, peerUid: '1002974327',
        kind: 'file', fileName: 'clip.mp4', fileUuid: 'video-uuid', videoCodecFormat: 1,
      }),
    })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      url: 'https://media.example/domain.mp4?token=secret', expiresAt: 1_800_000_054_000,
    })
    expect(sendPacket).toHaveBeenCalledWith('OidbSvcTrpcTcp.0x11ea_200', Buffer.from('video-request'))
    } finally {
      Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
    }
  })

  it('serves an image direct URL through the xref-verified packet path', async () => {
    const originalPlatform = process.platform
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    try {
    const f = fixture()
    const sendPacket = vi.fn(async () => ({ rspbuffer: Buffer.from('fetch-rkey-response') }))
    Object.assign(f.msg, { sendSsoCmdReqByContend: sendPacket })
    const addon: PacketAddon = {
      ...packetAddonFixture(),
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
      expiresAt: 1_800_003_570_000,
    })
    expect(sendPacket).toHaveBeenCalledWith(
      'OidbSvcTrpcTcp.0x9067_202', Buffer.from('fetch-rkey-request'),
    )
    expect(addon.installSendHook).toHaveBeenCalledOnce()

    const unsupported = await fetch(base, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        messageId: 'file-message', elementId: 'file-element', chatType: 2, peerUid: 'group',
        kind: 'file', fileName: 'document.bin',
      }),
    })
    expect(unsupported.status).toBe(404)
    expect(sendPacket).toHaveBeenCalledOnce()
    } finally {
      Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
    }
  })

  it('exposes native requests through the dedicated HTTP contract', async () => {
    const f = fixture()
    f.buddy.getBuddyReq.mockResolvedValue({ buddyReqs: [
      { friendUid: 'friend-uid', reqTime: '11', isInitiator: false, isDecide: false },
    ] })
    const bridge = new QQKernelBridge()
    bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: '/tmp' })
    server = new QQBridgeServer(bridge, { port: 0 })
    await server.start()
    const base = `http://127.0.0.1:${server.address().port}/v1/requests`

    const listed = await fetch(`${base}?kind=friend`)
    expect(listed.status).toBe(200)
    const page = await listed.json() as { requests: Array<{ id: string, kind: string }> }
    expect(page.requests).toHaveLength(1)
    expect(page.requests[0].kind).toBe('friend')

    const resolved = await fetch(`${base}/${encodeURIComponent(page.requests[0].id)}/resolve`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'accept' }),
    })
    expect(resolved.status).toBe(200)
    await expect(resolved.json()).resolves.toMatchObject({ status: 'accepted' })
    expect(f.buddy.approvalFriendRequest).toHaveBeenCalledWith({ friendUid: 'friend-uid', reqTime: '11', accept: true })

    const repeated = await fetch(`${base}/${encodeURIComponent(page.requests[0].id)}/resolve`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'accept' }),
    })
    expect(repeated.status).toBe(200)
    const conflict = await fetch(`${base}/${encodeURIComponent(page.requests[0].id)}/resolve`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'reject' }),
    })
    expect(conflict.status).toBe(409)
    expect((await fetch(`${base}?kind=other`)).status).toBe(400)
    expect((await fetch(`${base}?limit=0`)).status).toBe(400)
    expect((await fetch(`${base}/missing/resolve`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'accept' }),
    })).status).toBe(404)
  })

  it('uses authenticated request boundary cursors across list mutations', async () => {
    const f = fixture()
    const buddies = [
      { friendUid: 'z1', reqTime: '1', isInitiator: false, isDecide: false },
      { friendUid: 'z2', reqTime: '2', isInitiator: false, isDecide: false },
    ]
    f.buddy.getBuddyReq.mockResolvedValue({ buddyReqs: buddies })
    const bridge = new QQKernelBridge()
    bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: '/tmp' })
    server = new QQBridgeServer(bridge, { port: 0 })
    await server.start()
    const base = `http://127.0.0.1:${server.address().port}/v1/requests`

    const firstResponse = await fetch(`${base}?kind=friend&limit=1`)
    const first = await firstResponse.json() as { requests: Array<{ id: string }>, nextCursor: string }
    expect(first.nextCursor).toBeTruthy()
    const allFirst = await fetch(`${base}?limit=1`)
    const allPage = await allFirst.json() as { nextCursor: string }
    expect((await fetch(`${base}?cursor=${encodeURIComponent(allPage.nextCursor)}`)).status).toBe(200)

    const inserted = Array.from({ length: 32 }, (_, index) => ({
      friendUid: `inserted-${index}`, reqTime: '0', isInitiator: false, isDecide: false,
    }))
    f.emitBuddyRequests([...inserted, ...buddies])
    const current = await (await fetch(`${base}?kind=friend&limit=500`)).json() as { requests: Array<{ id: string }> }
    const expected = current.requests.filter((request) => request.id > first.requests[0].id).map((request) => request.id)
    expect(current.requests.some((request) => request.id < first.requests[0].id)).toBe(true)
    const secondResponse = await fetch(`${base}?kind=friend&cursor=${encodeURIComponent(first.nextCursor)}&limit=500`)
    const second = await secondResponse.json() as { requests: Array<{ id: string }> }
    expect(second.requests.map((request) => request.id)).toEqual(expected)

    expect((await fetch(`${base}?kind=group-join&cursor=${encodeURIComponent(first.nextCursor)}`)).status).toBe(400)
    expect((await fetch(`${base}?kind=friend&cursor=malformed`)).status).toBe(400)
    const forged = `${first.nextCursor.slice(0, -1)}${first.nextCursor.endsWith('A') ? 'B' : 'A'}`
    expect((await fetch(`${base}?kind=friend&cursor=${encodeURIComponent(forged)}`)).status).toBe(400)
  })

  it('returns unavailable when no native request API exists', async () => {
    const f = fixture()
    delete (f.buddy as { getBuddyReq?: unknown }).getBuddyReq
    delete (f.group as { getSingleScreenNotifies?: unknown }).getSingleScreenNotifies
    const bridge = new QQKernelBridge()
    bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: '/tmp' })
    server = new QQBridgeServer(bridge, { port: 0 })
    await server.start()
    const response = await fetch(`http://127.0.0.1:${server.address().port}/v1/requests`)
    expect(response.status).toBe(503)
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

  describe('notification-mask endpoint', () => {
    it('updates the group mask and returns 200 on success', async () => {
      const f = fixture()
      const bridge = new QQKernelBridge()
      bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: '/tmp' })
      f.emitGroupList([{ groupCode: '1058754719', groupName: 'Bridge Test Group' }])
      f.emitGroupMsgMasks([{ groupCode: '1058754719', msgMask: GroupMsgMask.NOTIFY }])
      server = new QQBridgeServer(bridge, { port: 0 })
      await server.start()
      const endpoint = `http://127.0.0.1:${server.address().port}/v1/conversations/2/1058754719/notification-mask`

      const response = await fetch(endpoint, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ msgMask: GroupMsgMask.SHIELD }),
      })

      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toEqual({
        ok: true, chatType: 2, peerUin: '1058754719', msgMask: GroupMsgMask.SHIELD,
      })
      expect(f.group.setGroupMsgMask).toHaveBeenCalledWith('1058754719', GroupMsgMask.SHIELD)
      expect(bridge.getConversation('1058754719')).toMatchObject({ groupMsgMask: GroupMsgMask.SHIELD })
    })

    it('rejects an out-of-range msgMask with 400', async () => {
      const f = fixture()
      const bridge = new QQKernelBridge()
      bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: '/tmp' })
      server = new QQBridgeServer(bridge, { port: 0 })
      await server.start()
      const endpoint = `http://127.0.0.1:${server.address().port}/v1/conversations/2/1058754719/notification-mask`

      const response = await fetch(endpoint, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ msgMask: 7 }),
      })

      expect(response.status).toBe(400)
      await expect(response.json()).resolves.toEqual({ error: 'msgMask must be one of 0, 1, 2, 3, 4' })
      expect(f.group.setGroupMsgMask).not.toHaveBeenCalled()
    })

    it('rejects a non-group chatType with 400', async () => {
      const f = fixture()
      const bridge = new QQKernelBridge()
      bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: '/tmp' })
      server = new QQBridgeServer(bridge, { port: 0 })
      await server.start()
      const endpoint = `http://127.0.0.1:${server.address().port}/v1/conversations/1/1058754719/notification-mask`

      const response = await fetch(endpoint, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ msgMask: GroupMsgMask.SHIELD }),
      })

      expect(response.status).toBe(400)
      await expect(response.json()).resolves.toEqual({ error: 'notification mask is only supported for group conversations' })
      expect(f.group.setGroupMsgMask).not.toHaveBeenCalled()
    })

    it('maps a native setter failure to 502', async () => {
      const f = fixture()
      const bridge = new QQKernelBridge()
      bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: '/tmp' })
      f.emitGroupList([{ groupCode: '1058754719', groupName: 'Bridge Test Group' }])
      f.emitGroupMsgMasks([{ groupCode: '1058754719', msgMask: GroupMsgMask.NOTIFY }])
      f.group.setGroupMsgMask.mockResolvedValue({ result: -1, errMsg: 'denied' })
      server = new QQBridgeServer(bridge, { port: 0 })
      await server.start()
      const endpoint = `http://127.0.0.1:${server.address().port}/v1/conversations/2/1058754719/notification-mask`

      const response = await fetch(endpoint, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ msgMask: GroupMsgMask.SHIELD }),
      })

      expect(response.status).toBe(502)
      const body = await response.json() as { error: string }
      expect(body.error).toMatch(/setGroupMsgMask: denied/)
    })

    it('maps an unavailable native setter to 503', async () => {
      const f = fixture()
      const bridge = new QQKernelBridge()
      bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: '/tmp' })
      f.group.setGroupMsgMask = undefined as unknown as typeof f.group.setGroupMsgMask
      server = new QQBridgeServer(bridge, { port: 0 })
      await server.start()
      const endpoint = `http://127.0.0.1:${server.address().port}/v1/conversations/2/1058754719/notification-mask`

      const response = await fetch(endpoint, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ msgMask: GroupMsgMask.SHIELD }),
      })

      expect(response.status).toBe(503)
      const body = await response.json() as { error: string }
      expect(body.error).toMatch(/setGroupMsgMask/)
    })
  })

  describe('member-role endpoint', () => {
    it('promotes and demotes an encoded QQ member through the native API', async () => {
      const f = fixture()
      const bridge = new QQKernelBridge()
      bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: '/tmp' })
      server = new QQBridgeServer(bridge, { port: 0 })
      await server.start()
      const base = `http://127.0.0.1:${server.address().port}/v1/conversations/${encodeURIComponent('2:1058754719')}/members/${encodeURIComponent('member/opaque')}/role`

      const promote = await fetch(base, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ role: 'administrator' }),
      })
      const demote = await fetch(base, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ role: 'member' }),
      })

      expect(promote.status).toBe(200)
      await expect(promote.json()).resolves.toEqual({
        ok: true, conversationId: '2:1058754719', userId: 'member/opaque', role: 'administrator',
      })
      expect(demote.status).toBe(200)
      expect(f.group.modifyMemberRole).toHaveBeenNthCalledWith(1, '1058754719', 'member/opaque', 3)
      expect(f.group.modifyMemberRole).toHaveBeenNthCalledWith(2, '1058754719', 'member/opaque', 2)
    })

    it('rejects invalid roles before invoking QQ and maps native denial to 502', async () => {
      const f = fixture()
      const bridge = new QQKernelBridge()
      bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: '/tmp' })
      server = new QQBridgeServer(bridge, { port: 0 })
      await server.start()
      const endpoint = `http://127.0.0.1:${server.address().port}/v1/conversations/${encodeURIComponent('2:1058754719')}/members/member/role`

      const invalid = await fetch(endpoint, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ role: 'owner' }),
      })
      expect(invalid.status).toBe(400)
      expect(f.group.modifyMemberRole).not.toHaveBeenCalled()

      f.group.modifyMemberRole.mockResolvedValueOnce({ result: 120101005, errMsg: 'not owner' })
      const denied = await fetch(endpoint, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ role: 'administrator' }),
      })
      expect(denied.status).toBe(502)
      await expect(denied.json()).resolves.toEqual({
        error: 'modifyMemberRole: not owner (120101005)',
      })
    })
  })
})
