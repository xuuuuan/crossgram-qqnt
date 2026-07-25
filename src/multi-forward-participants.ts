import { createHash } from 'node:crypto'
import type { MsgRecord } from './kernel-types.js'
import type { QQMultiForwardLocator } from './protocol.js'

export interface MultiForwardParticipant {
  id: string
  name: string
  alias?: string
  avatarUin?: string
}

/**
 * Resolve the authors of one downloaded merged-forward transcript without
 * trusting its native sender IDs. QQ assigns the same placeholder account to
 * unrelated authors in many imported bundles, so an identity is derived from
 * the record-owned name and avatar evidence instead.
 *
 * IDs are deterministic within one transcript and intentionally differ across
 * transcripts. They can therefore be exposed as temporary peers without ever
 * colliding with the live QQ address book.
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
    // avatarMeta is the only per-author identity QQ retains for many imported
    // records. A qlogo reference is still avatar evidence when a real UIN is
    // available; the name prevents a shared placeholder avatar from merging
    // unrelated people.
    const avatarIdentity = record.avatarMeta?.trim()
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

function normalizeIdentity(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase('zh-CN')
}
