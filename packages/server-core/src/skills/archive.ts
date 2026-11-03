import { crc32 } from 'node:zlib'
import { fromBuffer, type Entry } from 'yauzl'
import { validateBundleFile, type BundleFile } from '@craft-agent/shared/utils/bundle-files'

/** Read in memory, never extract unchecked archive paths onto the host filesystem. */
export function readSkillArchive(buffer: Buffer, onSymbolicLink?: (path: string) => void): Promise<BundleFile[]> {
  if (buffer.length > 20 * 1024 * 1024) throw new Error('ZIP exceeds 20 MB')
  return new Promise((resolve, reject) => {
    fromBuffer(buffer, { lazyEntries: true, validateEntrySizes: true, strictFileNames: true }, (error, zip) => {
      if (error) { reject(error); return }
      const files: BundleFile[] = []
      const names = new Set<string>()
      let bytes = 0
      let settled = false
      const fail = (error: Error) => {
        if (settled) return
        settled = true
        zip.close()
        reject(error)
      }
      zip.on('error', fail)
      zip.on('end', () => { if (!settled) { settled = true; resolve(files) } })
      if (zip.entryCount > 10000) { fail(new Error('Archive contains too many entries')); return }
      zip.on('entry', (entry: Entry) => {
        if (settled) return
        const name = entry.fileName
        const mode = (entry.externalFileAttributes >>> 16) & 0xf000
        const path = name.endsWith('/') ? name.slice(0, -1) : name
        const invalid = validateBundleFile({ relativePath: path, size: 0, contentBase64: '' })
        if (invalid || path.split('/').some(p => p === '.' || /[\x00-\x1f:]/.test(p) || /[. ]$/.test(p))
          || names.has(path.toLowerCase())) {
          fail(new Error(invalid ?? 'Invalid or duplicate archive path: ' + path)); return
        }
        names.add(path.toLowerCase())
        const excluded = path.split('/').some(p => ['.git', 'node_modules', '__MACOSX'].includes(p))
        if (entry.isEncrypted()) { fail(new Error('Encrypted archives are not supported')); return }
        // GitHub archives contain the whole repository. Record links without reading them so
        // the caller can reject links within the selected skill after resolving its directory.
        if (mode === 0xa000 && onSymbolicLink) {
          if (!excluded) onSymbolicLink(path)
          zip.readEntry(); return
        }
        if (mode && mode !== 0x8000 && mode !== 0x4000) {
          fail(new Error('Archives with symbolic links or special files are not supported')); return
        }
        if (name.endsWith('/') || excluded) {
          zip.readEntry(); return
        }
        if (entry.uncompressedSize > 40 * 1024 * 1024 || bytes + entry.uncompressedSize > 100 * 1024 * 1024) {
          fail(new Error('Expanded archive exceeds 100 MB or a file exceeds 40 MB')); return
        }
        zip.openReadStream(entry, (error, stream) => {
          if (error) { fail(error); return }
          const chunks: Buffer[] = []
          let size = 0
          let checksum = 0
          stream.on('error', fail)
          stream.on('data', (chunk: Buffer) => {
            checksum = crc32(chunk, checksum)
            size += chunk.length
            bytes += chunk.length
            if (size > 40 * 1024 * 1024 || bytes > 100 * 1024 * 1024) {
              stream.destroy()
              fail(new Error('Expanded archive exceeds size limit'))
            } else chunks.push(chunk)
          })
          stream.on('end', () => {
            if (settled) return
            if (checksum !== entry.crc32) { fail(new Error('Archive CRC checksum mismatch')); return }
            files.push({ relativePath: name, contentBase64: Buffer.concat(chunks).toString('base64'), size, executable: Boolean((entry.externalFileAttributes >>> 16) & 0o111) })
            zip.readEntry()
          })
        })
      })
      zip.readEntry()
    })
  })
}
