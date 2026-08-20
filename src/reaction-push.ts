import { fromBinary } from '@bufbuild/protobuf'
import {
  GroupReactionNotifySchema,
  PushMessageEnvelopeSchema,
  PushMessageSchema,
} from './generated/qqnt/packet_pb.js'

const GROUP_EVENT_TYPE = 732
const GROUP_EVENT_SUB_TYPE = 16
const GROUP_REACTION_NOTIFY_SUB_TYPE = 35
const GROUP_NOTIFY_PREFIX_BYTES = 7

export interface QQGroupReactionPush {
  groupUin: string
  messageSequence: string
  operatorUid: string
  code: string
  currentCount: number
  operation: 'add' | 'remove'
}

/** Decode QQ's unsolicited OlPush group-reaction notification. */
export function decodeGroupReactionPush(value: unknown): QQGroupReactionPush | undefined {
  const bytes = callbackBytes(value)
  if (!bytes?.length) return
  const contents: Uint8Array[] = []
  try {
    const envelope = fromBinary(PushMessageEnvelopeSchema, bytes)
    const message = envelope.message
    if (message?.contentHead?.type === GROUP_EVENT_TYPE
      && message.contentHead.subType === GROUP_EVENT_SUB_TYPE
      && message.body?.msgContent.length) contents.push(message.body.msgContent)
  } catch {}
  try {
    const message = fromBinary(PushMessageSchema, bytes)
    if (message.contentHead?.type === GROUP_EVENT_TYPE
      && message.contentHead.subType === GROUP_EVENT_SUB_TYPE
      && message.body?.msgContent.length) contents.push(message.body.msgContent)
  } catch {}
  contents.push(bytes)
  for (const content of contents) {
    const decoded = decodeNotifyContent(content)
    if (decoded) return decoded
  }
}

function decodeNotifyContent(content: Uint8Array): QQGroupReactionPush | undefined {
  for (const bytes of content.length > GROUP_NOTIFY_PREFIX_BYTES
    ? [content.subarray(GROUP_NOTIFY_PREFIX_BYTES), content]
    : [content]) {
    try {
      const notify = fromBinary(GroupReactionNotifySchema, bytes)
      const reaction = notify.reaction?.data?.data
      const target = reaction?.target
      const data = reaction?.data
      if (notify.subType !== GROUP_REACTION_NOTIFY_SUB_TYPE
        || notify.groupUin <= 0n
        || !target?.sequence
        || !data?.code
        || !data.operatorUid
        || (data.operation !== 1 && data.operation !== 2)) continue
      return {
        groupUin: notify.groupUin.toString(),
        messageSequence: target.sequence.toString(),
        operatorUid: data.operatorUid,
        code: data.code,
        currentCount: data.currentCount,
        operation: data.operation === 1 ? 'add' : 'remove',
      }
    } catch {}
  }
}

function callbackBytes(value: unknown): Uint8Array | undefined {
  if (value instanceof Uint8Array) return value
  if (Array.isArray(value)
    && value.every((item) => Number.isInteger(item) && item >= -128 && item <= 255)) {
    return Uint8Array.from(value, (item) => item & 0xff)
  }
  if (!value || typeof value !== 'object') return
  const wrapped = value as { msgBuf?: unknown, data?: unknown, bytes?: unknown }
  for (const candidate of [wrapped.msgBuf, wrapped.data, wrapped.bytes]) {
    if (candidate === value) continue
    const bytes = callbackBytes(candidate)
    if (bytes) return bytes
  }
}
