import { Readable } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { KernelModule, KernelSession, MsgRecord } from './kernel-types.js'
import { QQKernelBridge } from './qq-kernel.js'
import { QQBridgeServer } from './server.js'

function fixture() {
  let msgHandlers: Record<string, (...args: unknown[]) => unknown> = {}
  const sentBodies: Buffer[] = []
  const message: MsgRecord = {
    msgId: 'm1', chatType: 1, sendType: 1, senderUid: 'self', senderUin: '10000',
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
    getMsgsByMsgId: vi.fn(async () => ({ result: 0, errMsg: '', msgList: [message] })),
  }
  const recent = {
    getRecentContactInfos: vi.fn(async () => ({
      result: 0, errMsg: '', relation: [{
        chatType: 1, peerUid: 'uid-1715311957', peerUin: '1715311957', peerName: 'xuuuuan',
        remark: '', avatarUrl: '', unreadCnt: '0', msgId: 'm1',
      }],
    })),
  }
  const buddy = {
    addKernelBuddyListener: vi.fn(() => 'buddy-listener'), removeKernelBuddyListener: vi.fn(),
    getBuddyList: vi.fn(async () => ({ result: 0, errMsg: '' })),
  }
  const group = {
    addKernelGroupListener: vi.fn(() => 'group-listener'), removeKernelGroupListener: vi.fn(),
    getGroupList: vi.fn(async () => ({ result: 0, errMsg: '' })),
    createMemberListScene: vi.fn(() => 'scene'), destroyMemberListScene: vi.fn(),
    getNextMemberList: vi.fn(async () => ({
      errCode: 0, errMsg: '', result: {
        ids: [{ uid: 'member', index: 1 }],
        infos: new Map([['member', {
          uid: 'member', uin: '42', nick: 'Member', remark: '', cardName: '', role: 2, avatarPath: '',
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
    getUixConvertService: () => ({
      getUid: async () => ({ uidInfo: new Map([['1715311957', 'uid-1715311957']]) }),
      getUin: async () => ({ uinInfo: new Map([['uid-1715311957', '1715311957']]) }),
    }),
  } as unknown as KernelSession
  return { kernel, session, msg, sentBodies }
}

describe('QQKernelBridge', () => {
  it('maps dialogs/history and confirms sends from the native listener', async () => {
    const f = fixture()
    const bridge = new QQKernelBridge()
    bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: '/tmp' })
    const dialogs = await bridge.getDialogs()
    expect(dialogs.conversations[0]).toMatchObject({
      id: '1:uid-1715311957', peerUin: '1715311957', title: 'xuuuuan',
    })
    const history = await bridge.getHistory(dialogs.conversations[0])
    expect(history.messages[0]).toMatchObject({ id: 'm1', parts: [{ type: 'text', text: 'hello' }] })
    const sent = await bridge.send({
      conversationId: dialogs.conversations[0].id, text: 'hello',
    }, Readable.from([]))
    expect(sent.id).toBe('m1')
    expect(f.msg.sendMsg).toHaveBeenCalledOnce()
  })

  it('streams request bytes into QQ staging without collecting a body Buffer', async () => {
    const f = fixture()
    const bridge = new QQKernelBridge()
    bridge.attach(f.kernel, f.session, { selfUin: '10000', selfUid: 'self', userPath: '/tmp' })
    const chunks = [Buffer.alloc(64 * 1024, 0x61), Buffer.alloc(64 * 1024, 0x62)]
    await bridge.send({
      conversationId: '1:uid-1715311957',
      media: [{ kind: 'file', name: 'stream.bin', size: chunks.reduce((sum, chunk) => sum + chunk.length, 0) }],
    }, Readable.from(chunks))
    expect(f.sentBodies).toEqual([Buffer.concat(chunks)])
  })
})

describe('QQBridgeServer', () => {
  let server: QQBridgeServer | undefined
  afterEach(async () => server?.stop())

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
      conversationId: '1:uid-1715311957', text: 'via HTTP',
    })).toString('base64url')
    const response = await fetch(`${base}/messages`, {
      method: 'POST', headers: { 'x-qqnt-manifest': manifest }, body: new Uint8Array(),
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ id: 'm1' })
  })
})
