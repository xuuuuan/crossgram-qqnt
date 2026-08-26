import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'

export async function embeddedPacketAddonDefines(path) {
  const bytes = await readFile(path)
  return {
    __QQNT_BRIDGE_EMBEDDED_PACKET_ADDON_BASE64__: JSON.stringify(bytes.toString('base64')),
    __QQNT_BRIDGE_EMBEDDED_PACKET_ADDON_FILENAME__: JSON.stringify(basename(path)),
    __QQNT_BRIDGE_EMBEDDED_PACKET_ADDON_SHA256__: JSON.stringify(
      createHash('sha256').update(bytes).digest('hex'),
    ),
  }
}
