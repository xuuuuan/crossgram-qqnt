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
  longNick?: string
  /** QQNT 6.9.99 moved global profile fields under coreInfo. */
  coreInfo?: {
    nick?: string
    avatarUrl?: string
    longNick?: string
  }
  baseInfo?: {
    longNick?: string
  }
}

export interface ProfileCoreAndBaseInfo {
  uid?: string
  uin?: string
  coreInfo?: {
    nick?: string
    avatarUrl?: string
  }
  baseInfo?: {
    longNick?: string
  }
}

export interface RecentContactInfo {
  id?: string
  contactId?: string
  sortField?: string
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
    pokeType?: number
    spokeSummary?: string
    vaspokeName?: string
  }
  replyElement?: {
    replayMsgId: string
    replayMsgSeq?: string
    replayMsgRootSeq?: string
    replayMsgRootMsgId?: string
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
    subElementType?: number
    revokeElement?: {
      operatorUid: string
      origMsgSenderUid: string
      isSelfOperate: boolean
      wording: string
    }
    jsonGrayTipElement?: { busiId?: string, recentAbstract: string, jsonStr: string }
    xmlElement?: { busiId?: string, content: string, templId?: string, members?: Map<string, string> }
    fileReceiptElement?: { fileName: string }
    feedMsgElement?: { content: string }
    proclamationElement?: { isSetProclamation: number }
    essenceElement?: { isSetEssence: number }
    buddyElement?: { type: number, elem?: { friendNick: string } }
    groupElement?: {
      type: number
      role: number
      groupName: string
      memberUid: string
      memberNick: string
      memberRemark: string
      adminUid: string
      adminNick: string
      adminRemark: string
      createGroup?: { memberInfo: Array<{ uid: string, name: string }> }
      memberAdd?: {
        showType: number
        otherAdd?: { uid: string, name: string }
        otherAddByOtherQRCode?: {
          inviter: { uid: string, name: string }
          invited: { uid: string, name: string }
        }
        otherAddByYourQRCode?: { uid: string, name: string }
        youAddByOtherQRCode?: { uid: string, name: string }
        otherInviteOther?: {
          inviter: { uid: string, name: string }
          invited: { uid: string, name: string }
        }
        otherInviteYou?: { uid: string, name: string }
        youInviteOther?: { uid: string, name: string }
      }
      shutUp?: {
        duration: string
        admin: { uid: string, card: string, name: string, role: number }
        member: { uid: string, card: string, name: string, role: number }
      }
    }
  }
  pttElement?: {
    duration: number | string
    fileName?: string
    filePath?: string
    fileSize?: number | string
    fileUuid?: string
    formatType?: number | string
    md5HexStr?: string
    text?: string
    waveAmplitudes?: number[]
  }
  videoElement?: {
    filePath?: string
    fileName: string
    videoMd5?: string
    thumbMd5?: string
    /** Duration in seconds. */
    fileTime: number
    thumbSize?: number
    /** 1 avi, 2 mp4, 3 wmv, 4 mkv, 5 rmvb, 6 rm, 7 asf, 8 mov, 9 mod, 10 ts, 11 mts. */
    fileFormat?: number
    fileSize?: string
    thumbWidth?: number
    thumbHeight?: number
    thumbPath?: Map<number, string>
    fileUuid?: string
    fileSubId?: string
    fileBizId?: number
    originVideoMd5?: string
    /** Native QQ video codec enum: 0 h264, 1 h265. */
    sourceVideoCodecFormat?: number
  }
  arkElement?: { bytesData: string }
  markdownElement?: { content: string }
  structLongMsgElement?: { xmlContent?: string, resId?: string }
  structMsgElement?: { xmlContent?: string }
  giphyElement?: { id: string }
  walletElement?: { name: string }
  liveGiftElement?: { kStrGiftName: string, kUInt64GiftNum: string }
  textGiftElement?: { giftName: string }
  calendarElement?: { summary: string, msg: string }
  avRecordElement?: {
    type?: number
    time?: string
    text?: string
    mainType?: number
    hasRead?: boolean
    extraType?: number
  }
  faceBubbleElement?: { content?: string, faceSummary?: string, oldVersionStr?: string }
  shareLocationElement?: { text?: string }
  tofuRecordElement?: {
    descriptionContent?: { title?: string }
    contentlist?: Array<{ title?: string }>
  }
  inlineKeyboardElement?: {
    botAppid: string
    rows: Array<{ buttons: Array<{
      id: string
      label: string
      visitedLabel: string
      style: number
      type: number
      clickLimit: number
      unsupportTips: string
      data: string
      atBotShowChannelList: boolean
      permissionType: number
      specifyRoleIds: string[]
      specifyTinyids: string[]
    }> }>
  }
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
  msgType?: number
  subMsgType?: number
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
  /** Per-record avatar identity retained by QQ for imported/forwarded messages. */
  avatarMeta?: string
  avatarFlag?: number
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
  fileDownType: number
  thumbSize: number
  filePath: string
  totalSize: string
  trasferStatus: number
}

export interface KernelMsgService {
  sendSsoCmdReqByContend?(
    command: string,
    payload: Uint8Array,
  ): Promise<Buffer | Uint8Array | {
    result?: number
    errMsg?: string
    rspbuffer?: Buffer | Uint8Array
  }>
  addKernelMsgListener(listener: unknown): string
  removeKernelMsgListener(listenerId: string): void
  sendMsg(msgId: string, peer: Contact, msgElements: MsgElement[], attrs: Map<number, unknown>): Promise<{ result: number, errMsg: string }>
  recallMsg(peer: Contact, msgIds: string[]): Promise<{ result: number, errMsg: string }>
  setSpecificMsgReadAndReport?(peer: Contact, msgId: string): Promise<{ result: number, errMsg: string }>
  deleteMsg(peer: Contact, msgIds: string[]): Promise<{ result: number, errMsg: string }>
  forwardMsg(msgIds: string[], source: Contact, destinations: Contact[], attrs: Map<number, unknown>): Promise<{ result: number, errMsg: string }>
  multiForwardMsg?(
    messages: Array<{ msgId: string, senderShowName?: string }>,
    source: Contact,
    destination: Contact,
  ): Promise<{ result: number, errMsg: string }>
  multiForwardMsgWithComment?(
    messages: Array<{ msgId: string, senderShowName?: string }>,
    source: Contact,
    destination: Contact,
    commentElements: MsgElement[],
    attrs: Map<number, unknown>,
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
  getSourceOfReplyMsg?(
    peer: Contact, msgId: string, sourceMsgSeq: string,
  ): Promise<{ result: number, errMsg: string, msgList: MsgRecord[] }>
  getSourceOfReplyMsgByClientSeqAndTime?(
    peer: Contact, msgId: string, msgClientSeq: string, msgTime: string,
  ): Promise<{ result: number, errMsg: string, msgList: MsgRecord[] }>
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
  clickInlineKeyboardButton?(info: {
    guildId: string
    peerId: string
    botAppid: string
    msgSeq: string
    buttonId: string
    callback_data: string
    dmFlag: number
    chatType: number
  }): Promise<{
    result: number
    errMsg: string
    status: number
    promptText: string
    promptType: number
    promptIcon: number
  }>
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
      /**
       * QQ 9.9.33 may return the installed market tabs through the legacy
       * roam table while leaving emojiNewTabs empty.
       */
      roamEmojiTab?: {
        timesTamp: number
        segmentFlag: number
        ordinaryTabinfoList: MarketStickerPackInfo[]
        magicTabinfoList: MarketStickerPackInfo[]
        smallTabinfoList: MarketStickerPackInfo[]
        epIds: number[]
      }
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
  fetchMarketEmotionJsonFile?(epId: number): Promise<{ result: number, errMsg: string }>
  fetchMarketEmoticonAioImage?(request: {
    epId: number
    eId: string
    name: string
    encryptKey: string
    width: number
    height: number
    jobType: number
  }): Promise<{ result: number, errMsg: string }>
  fetchMarketEmoticonAuthDetail?(request: {
    epId: number
    eId: string
    /** 0 = add to favorites, 1 = single-forward authorization. */
    scene: number
  }): Promise<{ result: number, errMsg: string }>
  getMarketEmoticonPath?(
    epId: number, eIds: string[], serviceType: number,
  ): Map<string, { isExist: boolean, path: string }> | Promise<{
    result: number
    errMsg: string
    pathMap: Map<string, { isExist: boolean, path: string }>
  }>
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
  getRecentContactList?(): Promise<{ result: number, errMsg: string }>
  getRecentContactListSync?(): {
    errCode: number
    errMsg: string
    sortedContactList: string[]
    changedList: RecentContactInfo[]
  }
  getRecentContactListSyncLimit?(count: number): {
    errCode: number
    errMsg: string
    sortedContactList: string[]
    changedList: RecentContactInfo[]
  }
  getRecentContactInfos(): Promise<{ result: number, errMsg: string, relation: RecentContactInfo[] }>
}

export interface SearchChatMsgsParams {
  chatInfo: { chatType: number, peerUid: string }
  searchFields: number
  filterMsgType: Array<{ type: number, subType: number[] }>
  filterSendersUid: string[]
  filterMsgFromTime: string
  filterMsgToTime: string
  pageLimit: number
}

export interface SearchMsgItem {
  msgId: string
  msgSeq: string
  msgTime: string
  senderUid: string
  senderUin: string
  senderNick: string
  msgRecord?: MsgRecord
}

export interface SearchMsgKeywordsResult {
  searchId: number
  hasMore: boolean
  resultItems: SearchMsgItem[]
}

export interface KernelSearchService {
  addKernelSearchListener(listener: unknown): string
  removeKernelSearchListener(listenerId: string): void
  searchChatMsgs(keywords: string[], params: SearchChatMsgsParams): number
  searchMoreChatMsgs(searchId: number): void
  cancelSearchChatMsgs(searchId: number, code: number, reason: string): void
}

export interface KernelBuddyService {
  addKernelBuddyListener(listener: unknown): string
  removeKernelBuddyListener(listenerId: string): void
  getBuddyList(force: boolean): Promise<{ result: number, errMsg: string }>
  getBuddyNick?(uids: string[]): Map<string, string>
  getBuddyRemark?(uids: string[]): Map<string, string>
}

export interface KernelProfileService {
  addKernelProfileListener(listener: unknown): string
  removeKernelProfileListener(listenerId: string): void
  getUserSimpleInfo(force: boolean, uids: string[]): Promise<{ result: number, errMsg: string }>
  getCoreAndBaseInfo?(callFrom: string, uids: string[]): Promise<Map<string, ProfileCoreAndBaseInfo>>
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
}

export interface KernelAVSDKService {
  addKernelAVSDKListener(listener: unknown): string
  removeKernelAVSDKListener(listenerId: string): void
  setActionFromAVSDK(action: number, bytes: Uint8Array): unknown
}

export interface KernelSession {
  getMsgService(): KernelMsgService
  getRecentContactService(): KernelRecentService
  getBuddyService(): KernelBuddyService
  getProfileService?(): KernelProfileService
  getGroupService(): KernelGroupService
  getSearchService?(): KernelSearchService
  getAVSDKService?(): KernelAVSDKService
  getRichMediaService(): KernelRichMediaService
  getSettingService?(): KernelSettingService
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

export interface KernelSettingService {
  getAutoLoginSwitch?(): Promise<{ result: number, errMsg: string, state: boolean }>
  setAutoLoginSwitch(state: boolean): Promise<{ result: number, errMsg: string }>
}

export interface QRCodeInfo {
  pngBase64QrcodeData: string
  qrcodeUrl: string
  expireTime: number
  pollTimeInterval: number
}

export interface QRCodeLoginResult {
  account: string
  mainAccount: string
  uin: string
  uid: string
  nickName: string
  gender: number
  age: number
  faceUrl: string
}

export interface KernelLoginListener {
  onLoginConnected?(): void
  onLoginDisConnected?(): void
  onLoginConnecting?(): void
  onQRCodeGetPicture?(info: QRCodeInfo): void
  onQRCodeLoginPollingStarted?(expireTime: number, pollTimeInterval: number): void
  onQRCodeSessionUserScaned?(code: number, avatarUrl: string): void
  onLoginState?(state: number): void
  onQRCodeLoginSucceed?(result: QRCodeLoginResult): void
  onQRCodeSessionFailed?(errorType: number, errorCode: number, errorMessage: string): void
  onLoginFailed?(errorType: number, info: { title: string, message: string }): void
  onUserLoggedIn?(uin: string): void
  onQRCodeSessionQuickLoginFailed?(code: number, errorMessage: string, result: QRCodeInfo): void
}

export interface KernelLoginService {
  get?(): KernelLoginService
  addKernelLoginListener(listener: KernelLoginListener): void
  removeKernelLoginListener?(listener: KernelLoginListener): void
  getQRCodePicture(): boolean
  startPolling(): boolean
  abortPolling?(): boolean
}

export interface KernelModule {
  NodeIQQNTWrapperSession: { prototype: { init(config: InitSessionConfig, ...args: unknown[]): unknown } }
  NodeIKernelMsgListener?: new (handlers: Record<string, (...args: never[]) => unknown>) => unknown
  NodeIKernelBuddyListener?: new (handlers: Record<string, (...args: never[]) => unknown>) => unknown
  NodeIKernelProfileListener?: new (handlers: Record<string, (...args: never[]) => unknown>) => unknown
  NodeIKernelGroupListener?: new (handlers: Record<string, (...args: never[]) => unknown>) => unknown
  NodeIKernelRecentContactListener?: new (handlers: Record<string, (...args: never[]) => unknown>) => unknown
  NodeIKernelSearchListener?: new (handlers: Record<string, (...args: never[]) => unknown>) => unknown
  NodeIKernelLoginService?: (new (...args: unknown[]) => KernelLoginService) & {
    get?(): KernelLoginService
    create?(): KernelLoginService
  }
  NodeIKernelLoginListener?: new (handlers: KernelLoginListener) => KernelLoginListener
  NodeIAVSDKListener?: new (handlers: Record<string, (...args: never[]) => unknown>) => unknown
}

export interface InitSessionConfig {
  selfUin: string
  selfUid: string
  // Some Linux QQ builds omit userPath at runtime even though the native
  // declaration historically exposed it. Callers must retain a separate
  // trusted root instead of assuming this field is always present.
  userPath?: string
}
