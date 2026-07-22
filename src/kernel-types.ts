export interface Contact {
  chatType: number
  peerUid: string
  guildId: string
}

export interface ProfileSimpleInfo {
  uid: string
  uin: string
  nick: string
  remark: string
  avatarUrl: string
}

export interface RecentContactInfo {
  chatType: number
  peerUid: string
  peerUin: string
  peerName: string
  remark: string
  avatarUrl: string
  unreadCnt: string
  msgId: string
}

export interface MemberInfo {
  uid: string
  uin: string
  nick: string
  remark: string
  cardName: string
  role: number
  avatarPath: string
}

export interface MsgElement {
  elementType: number
  elementId: string
  textElement?: { content: string }
  picElement?: {
    fileName: string
    fileSize: string
    picWidth: number
    picHeight: number
    md5HexStr: string
    sourcePath?: string
    fileUuid: string
    fileSubId: string
    fileBizId?: number
    originImageUrl?: string
    thumbPath?: Map<number, string>
  }
  fileElement?: {
    fileMd5: string
    fileName: string
    filePath: string
    fileSize: string
    file10MMd5: string
    fileSha: string
    fileSha3: string
    fileUuid: string
    fileSubId: string
    fileBizId?: number
  }
}

export interface MsgRecord {
  msgId: string
  chatType: number
  sendType: number
  senderUid: string
  senderUin: string
  peerUid: string
  peerUin: string
  peerName: string
  msgTime: string
  sendStatus: number
  sendRemarkName: string
  sendMemberName: string
  sendNickName: string
  elements: MsgElement[]
}

export interface FileTransNotifyInfo {
  fileModelId: string
  msgElementId: string
  msgId: string
  fileErrCode: string
  fileErrMsg: string
  filePath: string
  totalSize: string
  trasferStatus: number
}

export interface KernelMsgService {
  addKernelMsgListener(listener: unknown): string
  removeKernelMsgListener(listenerId: string): void
  sendMsg(msgId: string, peer: Contact, msgElements: MsgElement[], attrs: Map<number, unknown>): Promise<{ result: number, errMsg: string }>
  recallMsg(peer: Contact, msgIds: string[]): Promise<{ result: number, errMsg: string }>
  deleteMsg(peer: Contact, msgIds: string[]): Promise<{ result: number, errMsg: string }>
  forwardMsg(msgIds: string[], source: Contact, destinations: Contact[], attrs: Map<number, unknown>): Promise<{ result: number, errMsg: string }>
  getMsgs(peer: Contact, msgId: string, count: number, queryOrder: boolean): Promise<{ result: number, errMsg: string, msgList: MsgRecord[] }>
  getMsgsByMsgId(peer: Contact, msgIds: string[]): Promise<{ result: number, errMsg: string, msgList: MsgRecord[] }>
  getMsgUniqueId?(time: string): string
  getLatestDbMsgs?(params: { peer: Contact, cnt: number }): Promise<{ result: number, errMsg: string, msgList: MsgRecord[] }>
}

export interface KernelRecentService {
  getRecentContactInfos(): Promise<{ result: number, errMsg: string, relation: RecentContactInfo[] }>
}

export interface KernelBuddyService {
  addKernelBuddyListener(listener: unknown): string
  removeKernelBuddyListener(listenerId: string): void
  getBuddyList(force: boolean): Promise<{ result: number, errMsg: string }>
}

export interface KernelGroupService {
  addKernelGroupListener(listener: unknown): string
  removeKernelGroupListener(listenerId: string): void
  getGroupList(force: boolean): Promise<{ result: number, errMsg: string }>
  createMemberListScene(groupCode: string, scene: string): string
  destroyMemberListScene(sceneId: string): void
  getNextMemberList(sceneId: string, lastId: { uid: string, index: number }, count: number): Promise<{
    errCode: number
    errMsg: string
    result: { ids: Array<{ uid: string, index: number }>, infos: Map<string, MemberInfo>, finish: boolean }
  }>
}

export interface KernelRichMediaService {
  downloadFile(fileInfo: {
    fileModelId: string
    msgId: string
    elemId: string
    uuid: string
    subId: string
    fileName: string
    fileSize: string
    msgTime: string
    peerUid: string
    chatType: number
    md5: string
    md510m: string
    sha: string
    sha3: string
    bizType?: number
  }, downloadType: number, thumbSize: number, savePath: string): void
}

export interface KernelSession {
  getMsgService(): KernelMsgService
  getRecentContactService(): KernelRecentService
  getBuddyService(): KernelBuddyService
  getGroupService(): KernelGroupService
  getRichMediaService(): KernelRichMediaService
  getUixConvertService(): {
    getUid(uins: Set<string>): Promise<{ uidInfo: Map<string, string> }>
    getUin(uids: Set<string>): Promise<{ uinInfo: Map<string, string> }>
  }
}

export interface KernelModule {
  NodeIQQNTWrapperSession: { prototype: { init(config: InitSessionConfig, ...args: unknown[]): unknown } }
  NodeIKernelMsgListener?: new (handlers: Record<string, (...args: never[]) => unknown>) => unknown
  NodeIKernelBuddyListener?: new (handlers: Record<string, (...args: never[]) => unknown>) => unknown
  NodeIKernelGroupListener?: new (handlers: Record<string, (...args: never[]) => unknown>) => unknown
}

export interface InitSessionConfig {
  selfUin: string
  selfUid: string
  userPath: string
}
