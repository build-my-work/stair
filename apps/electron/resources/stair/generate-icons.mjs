import { execFileSync } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const resourceDir = dirname(fileURLToPath(import.meta.url))
const iconSvg = join(resourceDir, 'icon.svg')
const iconPng = join(resourceDir, 'icon.png')
const iconIcns = join(resourceDir, 'icon.icns')
const iconIco = join(resourceDir, 'icon.ico')
const dmgSvg = join(resourceDir, 'dmg-background.svg')
const dmgTiff = join(resourceDir, 'dmg-background.tiff')

await sharp(iconSvg).resize(1024, 1024).png().toFile(iconPng)
await sharp(dmgSvg).resize(540, 380).tiff().toFile(dmgTiff)

const temporaryRoot = mkdtempSync(join(tmpdir(), 'stair-icons-'))
const iconsetDir = join(temporaryRoot, 'Stair.iconset')
mkdirSync(iconsetDir)

try {
  const sizes = [16, 32, 128, 256, 512]
  for (const size of sizes) {
    await sharp(iconSvg)
      .resize(size, size)
      .png()
      .toFile(join(iconsetDir, `icon_${size}x${size}.png`))
    await sharp(iconSvg)
      .resize(size * 2, size * 2)
      .png()
      .toFile(join(iconsetDir, `icon_${size}x${size}@2x.png`))
  }

  execFileSync('iconutil', ['-c', 'icns', iconsetDir, '-o', iconIcns])
  execFileSync(
    'ffmpeg',
    [
      '-y',
      '-loglevel',
      'error',
      '-i',
      iconPng,
      '-vf',
      'scale=256:256',
      iconIco,
    ],
    { stdio: 'ignore' },
  )
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true })
}
