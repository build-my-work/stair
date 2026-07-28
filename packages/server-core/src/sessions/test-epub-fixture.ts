import { Buffer } from 'node:buffer'

/**
 * Minimal bounded EPUB ZIP for Session-layer tests. CRC values are left at
 * zero because the production validator checks structure and output limits,
 * while these tests only need a stable, valid archive identity.
 */
export function createMinimalEpubFixture(marker = 'default'): Buffer {
  const entries = [
    {
      name: 'mimetype',
      content: Buffer.from('application/epub+zip'),
    },
    {
      name: 'META-INF/container.xml',
      content: Buffer.from(`<container data-marker="${marker}"/>`),
    },
  ]
  const localParts: Buffer[] = []
  const centralParts: Buffer[] = []
  let localOffset = 0

  for (const entry of entries) {
    const name = Buffer.from(entry.name)
    const localHeader = Buffer.alloc(30)
    localHeader.writeUInt32LE(0x04034b50, 0)
    localHeader.writeUInt16LE(20, 4)
    localHeader.writeUInt16LE(0x800, 6)
    localHeader.writeUInt16LE(0, 8)
    localHeader.writeUInt32LE(entry.content.byteLength, 18)
    localHeader.writeUInt32LE(entry.content.byteLength, 22)
    localHeader.writeUInt16LE(name.byteLength, 26)
    const local = Buffer.concat([localHeader, name, entry.content])

    const centralHeader = Buffer.alloc(46)
    centralHeader.writeUInt32LE(0x02014b50, 0)
    centralHeader.writeUInt16LE(20, 4)
    centralHeader.writeUInt16LE(20, 6)
    centralHeader.writeUInt16LE(0x800, 8)
    centralHeader.writeUInt16LE(0, 10)
    centralHeader.writeUInt32LE(entry.content.byteLength, 20)
    centralHeader.writeUInt32LE(entry.content.byteLength, 24)
    centralHeader.writeUInt16LE(name.byteLength, 28)
    centralHeader.writeUInt32LE(localOffset, 42)
    const central = Buffer.concat([centralHeader, name])

    localParts.push(local)
    centralParts.push(central)
    localOffset += local.byteLength
  }

  const centralDirectory = Buffer.concat(centralParts)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(centralDirectory.byteLength, 12)
  eocd.writeUInt32LE(localOffset, 16)
  return Buffer.concat([...localParts, centralDirectory, eocd])
}
