import { create, fromBinary, toBinary } from '@bufbuild/protobuf'
import { describe, expect, it } from 'vitest'
import {
  GroupReactionNotifySchema,
  PushMessageEnvelopeSchema,
  PushMessageSchema,
} from './generated/qqnt/packet_pb.js'
import { decodeGroupReactionPush } from './reaction-push.js'

function reactionPush(overrides: {
  type?: number
  subType?: number
  notifySubType?: number
  operation?: number
} = {}): Uint8Array {
  const notify = toBinary(GroupReactionNotifySchema, create(GroupReactionNotifySchema, {
    groupUin: 1_058_754_719n,
    subType: overrides.notifySubType ?? 35,
    reaction: { data: { data: {
      target: { sequence: 799_177n },
      data: {
        code: '10068', currentCount: 2, operatorUid: 'u_actor', operation: overrides.operation ?? 1,
      },
    } } },
  }))
  return toBinary(PushMessageEnvelopeSchema, create(PushMessageEnvelopeSchema, {
    message: {
      contentHead: { type: overrides.type ?? 732, subType: overrides.subType ?? 16 },
      body: { msgContent: Uint8Array.from([0, 0, 0, 0, 0, 0, notify.length, ...notify]) },
    },
  }))
}

describe('QQ group reaction push decoder', () => {
  it('decodes an OlPush add notification from the native S2C byte array', () => {
    expect(decodeGroupReactionPush([...reactionPush()])).toEqual({
      groupUin: '1058754719',
      messageSequence: '799177',
      operatorUid: 'u_actor',
      code: '10068',
      currentCount: 2,
      operation: 'add',
    })
  })

  it('accepts the wrapped callback shape and decodes removals', () => {
    expect(decodeGroupReactionPush({ msgBuf: reactionPush({ operation: 2 }) })).toMatchObject({
      currentCount: 2,
      operation: 'remove',
    })
  })

  it('accepts inner PushMessage and direct msgContent callback payloads', () => {
    const outer = reactionPush()
    const message = fromBinary(PushMessageEnvelopeSchema, outer).message!
    expect(decodeGroupReactionPush(toBinary(PushMessageSchema, message))).toMatchObject({
      groupUin: '1058754719', messageSequence: '799177',
    })
    expect(decodeGroupReactionPush(message.body!.msgContent)).toMatchObject({
      operatorUid: 'u_actor', code: '10068',
    })
  })

  it('rejects unrelated, truncated, and malformed push payloads', () => {
    expect(decodeGroupReactionPush(reactionPush({ type: 166 }))).toBeUndefined()
    expect(decodeGroupReactionPush(reactionPush({ subType: 17 }))).toBeUndefined()
    expect(decodeGroupReactionPush(reactionPush({ notifySubType: 34 }))).toBeUndefined()
    expect(decodeGroupReactionPush(reactionPush({ operation: 3 }))).toBeUndefined()
    expect(decodeGroupReactionPush(Uint8Array.of(0xff, 0xff))).toBeUndefined()
  })
})
