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
  msgSeq?: string
  msgTime?: string
  senderUid?: string
  senderUin?: string
  abstractContent?: Array<{
    elementType: number
    content?: string
    custom_content?: string
    fileName?: string
  }>
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

export interface GroupProfileInfo {
  groupCode: string
  groupName: string
  remarkName?: string
  memberCount?: number
  memberNum?: number
  memberRole?: number
  cmdUinPrivilege?: number
}

export interface MsgElement {
  elementType: number
  elementId: string
  textElement?: {
    content: string
    atType?: number
    atUid?: string
    atTinyId?: string
    atNtUid?: string
  }
  faceElement?: {
    faceIndex: number
    faceText?: string
    faceType: number
    packId?: string
    stickerId?: string
    sourceType?: number
    stickerType?: number
    resultId?: string
    imageType?: number
  }
  replyElement?: {
    replayMsgId: string
    replayMsgSeq?: string
    sourceMsgIdInRecords?: string
    replyMsgClientSeq?: string
    replyMsgTime?: string
    sourceMsgText?: string
    sourceMsgTextElems: unknown[]
    replyMsgRevokeType: number
    sourceMsgIsIncPic: boolean
    sourceMsgExpired: boolean
  }
  multiForwardMsgElement?: {
    xmlContent?: string
    resId?: string
    fileName?: string
  }
  grayTipElement?: {
    revokeElement?: {
      operatorUid: string
      origMsgSenderUid: string
      isSelfOperate: boolean
      wording: string
    }
    jsonGrayTipElement?: { recentAbstract: string, jsonStr: string }
    xmlElement?: { content: string }
    fileReceiptElement?: { fileName: string }
    feedMsgElement?: { content: string }
  }
  pttElement?: { duration: number, text?: string }
  videoElement?: { fileName: string, fileTime: number }
  arkElement?: { bytesData: string }
  markdownElement?: { content: string }
  structLongMsgElement?: { xmlContent?: string, resId?: string }
  structMsgElement?: { xmlContent?: string }
  giphyElement?: { id: string }
  walletElement?: { name: string }
  liveGiftElement?: { kStrGiftName: string, kUInt64GiftNum: string }
  textGiftElement?: { giftName: string }
  calendarElement?: { summary: string, msg: string }
  avRecordElement?: { text: string, time: string }
  faceBubbleElement?: { content?: string, faceSummary?: string, oldVersionStr?: string }
  shareLocationElement?: { text?: string }
  tofuRecordElement?: {
    descriptionContent?: { title?: string }
    contentlist?: Array<{ title?: string }>
  }
  inlineKeyboardElement?: { rows: Array<{ buttons: Array<{ label: string }> }> }
  picElement?: {
    fileName: string
    fileSize: string
    picWidth: number
    picHeight: number
    md5HexStr: string
    sourcePath?: string
    fileUuid: string
    fileSubId: string
    originImageMd5?: string
    thumbFileSize?: number
    original?: boolean
    fileBizId?: number
    originImageUrl?: string
    thumbPath?: Map<number, string>
    picSubType?: number
    picType?: number
  }
  marketFaceElement?: MarketFaceElement
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

export interface MarketFaceElement {
  itemType: number
  faceInfo: number
  emojiPackageId: number
  subType: number
  mediaType: number
  imageWidth: number
  imageHeight: number
  faceName?: string
  emojiId?: string
  key?: string
  emojiType?: number
  staticFacePath?: string
  dynamicFacePath?: string
}

export interface CustomEmotionData {
  emoPath: string
  isExist: boolean
  resId: string
  url: string
  md5: string
  emoOriginalPath: string
  thumbPath: string
  isAPNG: boolean
  isMarkFace: boolean
  eId: string
  epId: string
  desc: string
}

export interface MarketStickerPackInfo {
  epId: number
  wordingId: number
  tabType: number
  tabName: string
}

export interface BottomEmojiTabInfo {
  epId: number
  wordingId: number
  bottomEmojitabType: number
  tabName: string
  isHide: boolean
}

export interface MsgRecord {
  msgId: string
  msgSeq?: string
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
  records?: MsgRecord[]
  emojiLikesList?: Array<{
    emojiId: string
    emojiType: string
    likesCnt: string
    isClicked: boolean
  }>
}

export interface EmojiLikesUserInfo {
  /** Opaque QQ user identifier returned by the reaction member-list API. */
  tinyId: string
  nickName: string
  headUrl: string
}

export interface ContactMsgBoxInfo {
  contact: Contact
  firstUnreadMsgInfo?: {
    msgSeq: string
    msgTime: string
  }
  unreadCnt?: string
}

export interface FileTransNotifyInfo {
  fileModelId: string
  msgElementId: string
  msgId: string
  fileErrCode: string
  fileErrMsg: string
  fileSrvErrCode?: string
  clientMsg?: string
  step?: number
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
  multiForwardMsg?(
    messages: Array<{ msgId: string, senderShowName?: string }>,
    source: Contact,
    destination: Contact,
  ): Promise<{ result: number, errMsg: string }>
  getMultiMsg?(
    peer: Contact,
    rootMsgId: string,
    parentMsgId: string,
  ): Promise<{ result: number, errMsg: string, msgList: MsgRecord[] }>
  getMsgs(peer: Contact, msgId: string, count: number, queryOrder: boolean): Promise<{ result: number, errMsg: string, msgList: MsgRecord[] }>
  getMsgsIncludeSelf?(peer: Contact, msgId: string, count: number, queryOrder: boolean): Promise<{ result: number, errMsg: string, msgList: MsgRecord[] }>
  getAioFirstViewLatestMsgs?(peer: Contact, count: number): Promise<{
    result: number
    errMsg: string
    msgList: MsgRecord[]
    needContinueGetMsg: boolean
  }>
  getMsgsBySeqAndCount?(
    peer: Contact, msgSeq: string, count: number, queryOrder: boolean, includeDeleteMsg: boolean,
  ): Promise<{ result: number, errMsg: string, msgList: MsgRecord[] }>
  getMsgsByMsgId(peer: Contact, msgIds: string[]): Promise<{ result: number, errMsg: string, msgList: MsgRecord[] }>
  getMsgUniqueId?(time: string): string
  getLatestDbMsgs?(peer: Contact, count: number): Promise<{ result: number, errMsg: string, msgList: MsgRecord[] }>
  getFirstUnreadMsgSeq?(peer: Contact): Promise<{ result: number, errMsg: string, seq: string }>
  getABatchOfContactMsgBoxInfo?(contacts: Contact[]): Promise<{
    result: number
    errMsg: string
    contactMsgBoxInfos: ContactMsgBoxInfo[]
  }>
  getEmojiResourcePath?(type: number): Promise<{ result: number, errMsg: string, resourcePath: string }>
  getRichMediaFilePath?(
    elementType: number, elementSubType: number, md5HexStr: string, fileName: string,
    fileType: number, thumbSize: number, needCreate: boolean,
  ): string
  getRichMediaFilePathForMobileQQSend?(pathInfo: {
    elementType: number
    elementSubType: number
    md5HexStr: string
    fileName: string
    downloadType: number
    thumbSize: number
    file_uuid: string
    needCreate: boolean
  }): string
  setMsgEmojiLikes?(
    peer: Contact,
    msgSeq: string,
    emojiId: string,
    emojiType: string,
    setEmoji: boolean,
  ): Promise<{ result: number, errMsg: string }>
  getMsgEmojiLikesList?(
    peer: Contact,
    msgSeq: string,
    emojiId: string,
    emojiType: string,
    cookie: string,
    bForward: boolean,
    number: number,
  ): Promise<{
    result: number
    errMsg: string
    emojiLikesList: EmojiLikesUserInfo[]
    cookie: string
    isLastPage: boolean
    isFirstPage: boolean
  }>
  fetchFavEmojiList?(
    resId: string, count: number, backwardFetch: boolean, forceRefresh: boolean,
  ): Promise<{ result: number, errMsg: string, emojiInfoList: CustomEmotionData[] }>
  addFavEmoji?(request: {
    emojiId: string
    packageId: number
    emojiPath: string
    fileSize: string
    fileName: string
    md5: string
    isMarkFace: boolean
    isOrigin: boolean
  }): Promise<{ result: number, errMsg: string, isExist: number }>
  deleteFavEmoji?(resIds: string[]): Promise<{ result: number, errMsg: string }>
  fetchMarketEmoticonList?(timeStamp: number, segmentFlag: number): Promise<{
    result: number
    errMsg: string
    marketEmoticonInfo: {
      roamEmojiTab: {
        timesTamp: number
        segmentFlag: number
        ordinaryTabinfoList: MarketStickerPackInfo[]
        magicTabinfoList: MarketStickerPackInfo[]
        smallTabinfoList: MarketStickerPackInfo[]
        epIds: number[]
      }
    }
  }>
  fetchBottomEmojiTableList?(request: {
    commonReqInfo: { appVersion: string, businessId: number }
    timeStamp: number
    segmentFlag: number
  }): Promise<{
    result: number
    errMsg: string
    marketEmoticonInfo: {
      segmentFlag: number
      emojiNewTabs: BottomEmojiTabInfo[]
    }
  }>
  fetchMarketEmoticonShowImage?(request: {
    epId: number
    wordingId: string
    type: number
    name: string
    valid: boolean
  }): Promise<{ result: number, errMsg: string }>
  fetchMarketEmoticonAioImage?(request: {
    epId: number
    eId: string
    name: string
    encryptKey: string
    width: number
    height: number
    jobType: number
  }): Promise<{ result: number, errMsg: string }>
  getMarketEmoticonPath?(
    epId: number, eIds: string[], serviceType: number,
  ): Map<string, { isExist: boolean, path: string }>
  getMarketEmoticonEncryptKeys?(
    epId: number, eIds: string[],
  ): Promise<{ result: number, errMsg: string, encryptKeyMap: Map<string, string> }>
  getFavMarketEmoticonInfo?(
    epId: number, eId: string,
  ): Promise<{ result: number, errMsg: string, favMarketEmoticonInfo: {
    eId: string
    width: number
    height: number
    faceName: string
  } }>
}

export interface KernelRecentService {
  addKernelRecentContactListener?(listener: unknown): string
  removeKernelRecentContactListener?(listenerId: string): void
  getRecentContactInfos(): Promise<{ result: number, errMsg: string, relation: RecentContactInfo[] }>
}

export interface KernelBuddyService {
  addKernelBuddyListener(listener: unknown): string
  removeKernelBuddyListener(listenerId: string): void
  getBuddyList(force: boolean): Promise<{ result: number, errMsg: string }>
  getBuddyNick?(uids: string[]): Map<string, string>
  getBuddyRemark?(uids: string[]): Map<string, string>
}

export interface KernelGroupService {
  addKernelGroupListener(listener: unknown): string
  removeKernelGroupListener(listenerId: string): void
  getGroupList(force: boolean): Promise<{ result: number, errMsg: string }>
  getGroupDetailInfo?(groupCode: string, source: number): Promise<{ result: number, errMsg: string }>
  createMemberListScene(groupCode: string, scene: string): string
  destroyMemberListScene(sceneId: string): void
  getNextMemberList(sceneId: string, lastId: { uid: string, index: number }, count: number): Promise<{
    errCode: number
    errMsg: string
    result: { ids: Array<{ uid: string, index: number }>, infos: Map<string, MemberInfo>, finish: boolean }
  }>
}

export interface KernelRichMediaService {
  getRichMediaFileDir?(elementType: number, downType: number, isTemp: boolean): string
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
  getAvatarService?(): {
    getAvatarPath(uid: string, size: number): string
    forceDownloadAvatar(uid: string, size: number): Promise<{ result: number, errMsg: string }>
    getGroupAvatarPath(groupCode: string, size: number): string
    getConfGroupAvatarPath(groupCode: string): string
    forceDownloadGroupAvatar(groupCode: string, size: number): Promise<{ result: number, errMsg: string }>
  }
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
  NodeIKernelRecentContactListener?: new (handlers: Record<string, (...args: never[]) => unknown>) => unknown
}

export interface InitSessionConfig {
  selfUin: string
  selfUid: string
  userPath: string
}
