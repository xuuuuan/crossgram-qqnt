import { createHash } from 'node:crypto'
import type { MsgRecord } from './kernel-types.js'
import type { QQMultiForwardLocator } from './protocol.js'

export interface MultiForwardParticipant {
  id: string
  name: string
  alias?: string
  avatarUin?: string
  /** Avatar QQ archived for this author inside the merged forward. */
  avatarUrl?: string
}

/**
 * Resolve the authors of one downloaded merged-forward transcript without
 * trusting its native sender IDs. QQ assigns the same placeholder account to
 * unrelated authors in many imported bundles, so an identity is derived from
 * the record-owned name and avatar evidence instead.  That evidence includes
 * the per-record `multiTransInfo.fromFaceUrl` avatar, which is the only image
 * QQ keeps for an archived author.
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
    const faceUrl = archivedFaceUrl(record)
    // avatarMeta and the archived face URL are the per-author identity QQ
    // retains for imported records. A qlogo reference is still avatar evidence
    // when a real UIN is available; the name prevents a shared placeholder
    // avatar from merging unrelated people.
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

/**
 * Avatar URL QQ archived next to one merged-forward record.  It identifies the
 * original author even though the record's own sender account is a placeholder
 * shared with every other author of the same transcript.
 */
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
