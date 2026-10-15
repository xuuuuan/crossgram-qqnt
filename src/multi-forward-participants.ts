import { createHash } from 'node:crypto'
import type { MsgRecord } from './kernel-types.js'
import type { QQMultiForwardLocator } from './protocol.js'

export interface MultiForwardParticipant {
  id: string
  name: string
  alias?: string
  avatarUin?: string
  avatarUrl?: string
}

/**
 * 解析合并转发子消息的发送者。QQ 在许多导入的合并转发中会给不同发送者分配相同的占位账号，
 * 因此需根据消息自身的昵称与头像（`avatarMeta`、`multiTransInfo.fromFaceUrl`）派生虚拟发送者 ID，
 * 并按转发作用域隔离，避免与真实通讯录冲突。
 */
export function resolveMultiForwardParticipants(
  locator: QQMultiForwardLocator,
  records: readonly MsgRecord[],
): Map<MsgRecord, MultiForwardParticipant> {
  const scope = JSON.stringify([
    locator.conversationId,
    locator.rootMessageId,
    locator.parentMessageId ?? '',
  ])
  const participants = new Map<string, MultiForwardParticipant>()
  const result = new Map<MsgRecord, MultiForwardParticipant>()

  for (const record of records) {
    const name = participantName(record)
    const faceUrl = archivedFaceUrl(record)
    const avatarIdentity = [record.avatarMeta?.trim(), faceUrl].filter(Boolean).join('|')
      || (/^\d+$/.test(record.senderUin) ? `qlogo:${record.senderUin}` : '')
    const fingerprint = JSON.stringify([
      normalizeIdentity(name),
      avatarIdentity,
    ])
    let participant = participants.get(fingerprint)
    if (!participant) {
      participant = {
        id: `qqnt-multi-forward-participant:${createHash('sha256')
          .update(scope)
          .update('\0')
          .update(fingerprint)
          .digest('hex')
          .slice(0, 32)}`,
        name,
        alias: record.sendMemberName?.trim() || undefined,
        avatarUin: /^\d+$/.test(record.senderUin) ? record.senderUin : undefined,
        avatarUrl: faceUrl,
      }
      participants.set(fingerprint, participant)
    }
    result.set(record, participant)
  }
  return result
}

function participantName(record: MsgRecord): string {
  return record.sendNickName?.trim()
    || record.sendRemarkName?.trim()
    || record.sendMemberName?.trim()
    || 'QQ用户'
}

function archivedFaceUrl(record: MsgRecord): string | undefined {
  const value = record.multiTransInfo?.fromFaceUrl?.trim()
  if (!value) return
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : undefined
  } catch {
    return
  }
}

function normalizeIdentity(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase('zh-CN')
}
