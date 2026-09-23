import { createHash } from 'node:crypto'
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { isAbsolute, join, relative } from 'node:path'
import { deflateRawSync } from 'node:zlib'

export const REGRESSION_FIXTURE_VERSION = 'stair-regression-v1'

export type RegressionFixtureManifest = {
  version: string
  files: Array<{
    path: string
    bytes: number
    sha256: string
  }>
}

type ZipEntry = {
  name: string
  content: Buffer
}

const CRC32_TABLE = Array.from({ length: 256 }, (_, value) => {
  let crc = value
  for (let bit = 0; bit < 8; bit += 1) {
    crc = (crc & 1) === 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1
  }
  return crc >>> 0
})

function crc32(content: Buffer): number {
  let crc = 0xffffffff
  for (const byte of content) crc = CRC32_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function createZip(entries: ZipEntry[]): Buffer {
  const localParts: Buffer[] = []
  const centralParts: Buffer[] = []
  let localOffset = 0

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    const compressed = deflateRawSync(entry.content, { level: 9 })
    const checksum = crc32(entry.content)
    const localHeader = Buffer.alloc(30)
    localHeader.writeUInt32LE(0x04034b50, 0)
    localHeader.writeUInt16LE(20, 4)
    localHeader.writeUInt16LE(0x0800, 6)
    localHeader.writeUInt16LE(8, 8)
    localHeader.writeUInt16LE(0, 10)
    localHeader.writeUInt16LE(33, 12)
    localHeader.writeUInt32LE(checksum, 14)
    localHeader.writeUInt32LE(compressed.length, 18)
    localHeader.writeUInt32LE(entry.content.length, 22)
    localHeader.writeUInt16LE(name.length, 26)
    localHeader.writeUInt16LE(0, 28)
    localParts.push(localHeader, name, compressed)

    const centralHeader = Buffer.alloc(46)
    centralHeader.writeUInt32LE(0x02014b50, 0)
    centralHeader.writeUInt16LE(20, 4)
    centralHeader.writeUInt16LE(20, 6)
    centralHeader.writeUInt16LE(0x0800, 8)
    centralHeader.writeUInt16LE(8, 10)
    centralHeader.writeUInt16LE(0, 12)
    centralHeader.writeUInt16LE(33, 14)
    centralHeader.writeUInt32LE(checksum, 16)
    centralHeader.writeUInt32LE(compressed.length, 20)
    centralHeader.writeUInt32LE(entry.content.length, 24)
    centralHeader.writeUInt16LE(name.length, 28)
    centralHeader.writeUInt16LE(0, 30)
    centralHeader.writeUInt16LE(0, 32)
    centralHeader.writeUInt16LE(0, 34)
    centralHeader.writeUInt16LE(0, 36)
    centralHeader.writeUInt32LE(0, 38)
    centralHeader.writeUInt32LE(localOffset, 42)
    centralParts.push(centralHeader, name)

    localOffset += localHeader.length + name.length + compressed.length
  }

  const centralDirectory = Buffer.concat(centralParts)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralDirectory.length, 12)
  end.writeUInt32LE(localOffset, 16)
  end.writeUInt16LE(0, 20)
  return Buffer.concat([...localParts, centralDirectory, end])
}

function escapePdfText(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('(', '\\(').replaceAll(')', '\\)')
}

function createPdf(
  pageCount: number,
  options: { pageLabels?: boolean; outline?: boolean } = {},
): Buffer {
  const objects: string[] = []
  const pageIds: number[] = []
  const contentIds: number[] = []
  let nextId = 4
  for (let page = 0; page < pageCount; page += 1) {
    pageIds.push(nextId)
    contentIds.push(nextId + 1)
    nextId += 2
  }
  const outlinesId = options.outline ? nextId++ : null
  const outlineItemId = options.outline ? nextId++ : null
  const catalogParts = ['/Type /Catalog', '/Pages 2 0 R']
  if (options.pageLabels) catalogParts.push('/PageLabels << /Nums [0 << /S /r >>] >>')
  if (outlinesId) catalogParts.push(`/Outlines ${outlinesId} 0 R`, '/PageMode /UseOutlines')
  objects[1] = `<< ${catalogParts.join(' ')} >>`
  objects[2] = `<< /Type /Pages /Count ${pageCount} /Kids [${pageIds.map(id => `${id} 0 R`).join(' ')}] >>`
  objects[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'

  for (let page = 0; page < pageCount; page += 1) {
    const pageId = pageIds[page]!
    const contentId = contentIds[page]!
    const text = `STAIR PDF fixture page ${page + 1}`
    const stream = `BT /F1 18 Tf 72 720 Td (${escapePdfText(text)}) Tj ET\n`
    objects[pageId] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentId} 0 R >>`
    objects[contentId] = `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`
  }
  if (outlinesId && outlineItemId) {
    objects[outlinesId] = `<< /Type /Outlines /First ${outlineItemId} 0 R /Last ${outlineItemId} 0 R /Count 1 >>`
    objects[outlineItemId] = `<< /Title (Fixture chapter) /Parent ${outlinesId} 0 R /Dest [${pageIds[0]} 0 R /Fit] >>`
  }

  const chunks: Buffer[] = [Buffer.from('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n', 'latin1')]
  const offsets = Array.from({ length: objects.length }, () => 0)
  let byteOffset = chunks[0]!.length
  for (let id = 1; id < objects.length; id += 1) {
    const object = Buffer.from(`${id} 0 obj\n${objects[id]}\nendobj\n`, 'latin1')
    offsets[id] = byteOffset
    chunks.push(object)
    byteOffset += object.length
  }
  const xrefOffset = byteOffset
  const xref = [
    `xref\n0 ${objects.length}\n`,
    '0000000000 65535 f \n',
    ...offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`),
    `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`,
  ].join('')
  chunks.push(Buffer.from(xref, 'latin1'))
  return Buffer.concat(chunks)
}

const BROWSER_FIXTURE_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Stair Browser Regression Fixture</title>
  <style>
    body { margin: 0; font: 16px system-ui; }
    main { width: 2400px; min-height: 3000px; padding: 24px; background: linear-gradient(#fff, #def); }
    #marker { position: sticky; top: 0; display: inline-block; padding: 8px; background: #ffdf5d; }
    #far-edge { position: absolute; left: 2200px; top: 2600px; }
    dialog { width: 420px; min-height: 180px; }
  </style>
</head>
<body>
  <main>
    <strong id="marker">STAIR-BROWSER-FIXTURE-v1</strong>
    <p id="selection">Deterministic browser selection text for Stair references.</p>
    <label>Fixture input <input id="fixture-input" value="editable"></label>
    <p><a href="#far-edge">Jump to the far edge</a></p>
    <button id="open-modal">Open Modal</button>
    <div id="far-edge">Horizontal and vertical scroll target</div>
  </main>
  <dialog id="fixture-modal"><p>Occlusion fixture</p><button id="close-modal">Close</button></dialog>
  <script>
    const modal = document.querySelector('#fixture-modal');
    document.querySelector('#open-modal').addEventListener('click', () => modal.showModal());
    document.querySelector('#close-modal').addEventListener('click', () => modal.close());
  </script>
</body>
</html>
`

function listManifestFiles(
  root: string,
  ignoreRootManifest = false,
): RegressionFixtureManifest['files'] {
  const files: RegressionFixtureManifest['files'] = []
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const fullPath = join(directory, entry.name)
      const isIgnoredManifest = ignoreRootManifest
        && directory === root
        && entry.name === 'manifest.json'
        && entry.isFile()
      if (entry.isDirectory()) visit(fullPath)
      else if (entry.isFile() && !isIgnoredManifest) {
        const content = readFileSync(fullPath)
        files.push({
          path: relative(root, fullPath).split('\\').join('/'),
          bytes: content.length,
          sha256: createHash('sha256').update(content).digest('hex'),
        })
      } else if (!isIgnoredManifest) {
        throw new Error(
          `Regression fixture contains unsupported entry: ${relative(root, fullPath)}`,
        )
      }
    }
  }
  visit(root)
  return files.sort((left, right) => left.path.localeCompare(right.path))
}

export function generateRegressionFixtures(root: string): RegressionFixtureManifest {
  if (!isAbsolute(root)) throw new Error('Regression fixture output must be an absolute path')
  if (existsSync(root)) throw new Error(`Regression fixture output already exists: ${root}`)
  mkdirSync(root)
  const write = (path: string, content: string | Buffer) => {
    const fullPath = join(root, path)
    mkdirSync(join(fullPath, '..'), { recursive: true })
    writeFileSync(fullPath, content)
  }

  write('project-a/text/alpha.md', [
    '# STAIR alpha fixture',
    '',
    '[Open beta](./beta.md)',
    '[Open web](https://example.com/)',
    '',
  ].join('\n'))
  write('project-a/text/beta.md', '# STAIR beta fixture\n')
  write('project-a/text/conflict.md', 'initial conflict fixture\n')
  write('project-a/text/empty.txt', '')
  write('project-a/text/bom-crlf.txt', '\ufefffirst\r\nsecond\r\n')
  write('project-a/text/lf-multi-eof.txt', 'first\nsecond\n\n\n')
  write('project-a/text/.env.example', 'STAIR_FIXTURE=1\n')
  write('project-a/text/config.json', '{"fixture":true}\n')
  write('project-a/text/example.ts', 'export const fixture = true\n')
  write('project-a/text/editable-1m.txt', Buffer.alloc(1_048_576, 0x61))
  write('project-a/text/readonly-over-1m.txt', Buffer.alloc(1_048_577, 0x62))
  write('project-a/binary/unknown.bin', Buffer.from([0x00, 0x01, 0x7f, 0xff]))
  for (let index = 1; index <= 501; index += 1) {
    write(`project-a/tree/many/file-${String(index).padStart(3, '0')}.txt`, `${index}\n`)
  }
  write(
    'project-a/media/sample.png',
    Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'),
  )
  write('project-a/reader/sample.epub', createZip([
    { name: 'mimetype', content: Buffer.from('application/epub+zip') },
    {
      name: 'META-INF/container.xml',
      content: Buffer.from('<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>'),
    },
    {
      name: 'OEBPS/content.opf',
      content: Buffer.from('<?xml version="1.0" encoding="UTF-8"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="book-id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="book-id">stair-regression-v1</dc:identifier><dc:title>Stair Regression</dc:title><dc:language>en</dc:language></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/><item id="style" href="styles.css" media-type="text/css"/><item id="image" href="images/pixel.png" media-type="image/png"/></manifest><spine><itemref idref="chapter"/></spine></package>'),
    },
    {
      name: 'OEBPS/nav.xhtml',
      content: Buffer.from('<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>Contents</title></head><body><nav epub:type="toc" xmlns:epub="http://www.idpf.org/2007/ops"><ol><li><a href="chapter.xhtml">Fixture chapter</a></li></ol></nav></body></html>'),
    },
    {
      name: 'OEBPS/chapter.xhtml',
      content: Buffer.from('<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>Fixture</title><link rel="stylesheet" href="styles.css"/></head><body><h1 id="start">STAIR EPUB fixture</h1><p>Deterministic selectable EPUB text.</p><img src="images/pixel.png" alt="fixture pixel"/><p><a href="#start">Return to start</a></p></body></html>'),
    },
    { name: 'OEBPS/styles.css', content: Buffer.from('body{font-family:serif} h1{color:#b42318}') },
    {
      name: 'OEBPS/images/pixel.png',
      content: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'),
    },
  ]))
  write('project-a/reader/labeled.pdf', createPdf(3, { pageLabels: true, outline: true }))
  write('project-a/reader/unlabeled.pdf', createPdf(2))
  write('project-a/reader/long-240.pdf', createPdf(240, { outline: true }))
  const emptyDrawnix = `${JSON.stringify({
    type: 'drawnix',
    version: 1,
    source: 'web',
    elements: [],
    viewport: { zoom: 1 },
    theme: { themeColorMode: 'default' },
  }, null, 2)}\n`
  write('project-a/mindmap/board.drawnix', emptyDrawnix)
  write('project-a/notes/existing.md', '# Existing note target\n')
  write('project-b/text/project-b.md', '# STAIR Project B fixture\n')
  write('project-b/notes/existing.md', '# Project B note target\n')
  write('project-b/mindmap/board.drawnix', emptyDrawnix)
  write('browser/index.html', BROWSER_FIXTURE_HTML)

  const manifest: RegressionFixtureManifest = {
    version: REGRESSION_FIXTURE_VERSION,
    files: listManifestFiles(root),
  }
  writeFileSync(join(root, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  return manifest
}

export function copyRegressionProject(source: string, target: string): void {
  if (!isAbsolute(source) || !isAbsolute(target)) {
    throw new Error('Regression project source and target must be absolute paths')
  }
  if (!existsSync(source) || !statSync(source).isDirectory()) {
    throw new Error(`Regression project source is unavailable: ${source}`)
  }
  if (existsSync(target)) throw new Error(`Regression project target already exists: ${target}`)
  cpSync(source, target, { recursive: true, force: false, errorOnExist: true })
}

export function verifyRegressionProject(
  manifestPath: string,
  prefix: string,
  root: string,
): number {
  if (!isAbsolute(manifestPath) || !isAbsolute(root)) {
    throw new Error('Regression manifest and project root must be absolute paths')
  }
  const manifest = JSON.parse(
    readFileSync(manifestPath, 'utf8'),
  ) as RegressionFixtureManifest
  const expected = manifest.files
    .filter(file => file.path.startsWith(`${prefix}/`))
    .map(file => ({ ...file, path: file.path.slice(prefix.length + 1) }))
  const actual = listManifestFiles(root)
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Regression project does not match ${prefix} in ${manifestPath}`)
  }
  return actual.length
}

export function verifyRegressionBundle(manifestPath: string, root: string): number {
  if (!isAbsolute(manifestPath) || !isAbsolute(root)) {
    throw new Error('Regression manifest and bundle root must be absolute paths')
  }
  const manifest = JSON.parse(
    readFileSync(manifestPath, 'utf8'),
  ) as RegressionFixtureManifest
  const actual = listManifestFiles(root, true)
  if (JSON.stringify(actual) !== JSON.stringify(manifest.files)) {
    throw new Error(`Regression bundle does not match ${manifestPath}`)
  }
  return actual.length
}

export function startRegressionFixtureServer(root: string, port = 47891) {
  if (!isAbsolute(root)) throw new Error('Regression fixture root must be an absolute path')
  const pagePath = join(root, 'browser/index.html')
  const page = readFileSync(pagePath)
  if (!page.includes('STAIR-BROWSER-FIXTURE-v1')) {
    throw new Error(`Invalid Stair Browser fixture: ${pagePath}`)
  }
  return Bun.serve({
    hostname: '127.0.0.1',
    port,
    fetch(request) {
      const pathname = new URL(request.url).pathname
      if (pathname === '/health') {
        return Response.json({ version: REGRESSION_FIXTURE_VERSION })
      }
      if (pathname === '/' || pathname === '/index.html') {
        return new Response(page, { headers: { 'content-type': 'text/html; charset=utf-8' } })
      }
      return new Response('Not found', { status: 404 })
    },
  })
}

function readOption(name: string): string {
  const index = process.argv.indexOf(name)
  const value = index >= 0 ? process.argv[index + 1] : undefined
  if (!value) throw new Error(`Missing required option: ${name}`)
  return value
}

if (import.meta.main) {
  const command = process.argv[2]
  if (command === 'generate') {
    const manifest = generateRegressionFixtures(readOption('--out'))
    console.log(`Generated ${manifest.files.length} Stair regression fixture files.`)
  } else if (command === 'copy-project') {
    const target = readOption('--out')
    copyRegressionProject(readOption('--source'), target)
    console.log(`Copied Stair regression project to ${target}.`)
  } else if (command === 'verify-project') {
    const count = verifyRegressionProject(
      readOption('--manifest'),
      readOption('--prefix'),
      readOption('--root'),
    )
    console.log(`Verified ${count} Stair regression project files.`)
  } else if (command === 'verify-bundle') {
    const count = verifyRegressionBundle(
      readOption('--manifest'),
      readOption('--root'),
    )
    console.log(`Verified ${count} Stair regression fixture files.`)
  } else if (command === 'serve') {
    const portValue = process.argv.includes('--port') ? Number(readOption('--port')) : 47891
    if (!Number.isInteger(portValue) || portValue < 1 || portValue > 65_535) {
      throw new Error(`Invalid port: ${portValue}`)
    }
    startRegressionFixtureServer(readOption('--root'), portValue)
    console.log(`Serving Stair regression fixture at http://127.0.0.1:${portValue}/`)
  } else {
    throw new Error('Usage: stair-regression-fixtures.ts generate|copy-project|verify-project|verify-bundle|serve [options]')
  }
}
