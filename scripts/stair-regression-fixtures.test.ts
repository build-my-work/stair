import { afterEach, describe, expect, test } from 'bun:test'
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  REGRESSION_FIXTURE_VERSION,
  copyRegressionProject,
  generateRegressionFixtures,
  verifyRegressionBundle,
  verifyRegressionProject,
} from './stair-regression-fixtures'

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('Stair regression fixtures', () => {
  test('generates the complete deterministic fixture bundle and manifest', () => {
    const parent = mkdtempSync(join(tmpdir(), 'stair-regression-fixtures-'))
    temporaryDirectories.push(parent)
    const root = join(parent, 'bundle')

    const manifest = generateRegressionFixtures(root)
    const secondManifest = generateRegressionFixtures(join(parent, 'bundle-copy'))

    expect(manifest.version).toBe(REGRESSION_FIXTURE_VERSION)
    expect(secondManifest).toEqual(manifest)
    expect(manifest.files.map(file => file.path)).toContain('browser/index.html')
    expect(manifest.files.map(file => file.path)).toContain('project-a/reader/long-240.pdf')
    expect(statSync(join(root, 'project-a/text/editable-1m.txt')).size).toBe(1_048_576)
    expect(statSync(join(root, 'project-a/text/readonly-over-1m.txt')).size).toBe(1_048_577)
    expect(readdirSync(join(root, 'project-a/tree/many'))).toHaveLength(501)

    const epub = readFileSync(join(root, 'project-a/reader/sample.epub'))
    expect(epub.readUInt32LE(0)).toBe(0x04034b50)
    expect(epub.readUInt16LE(8)).toBe(8)
    expect(epub.subarray(30, 38).toString()).toBe('mimetype')

    const labeledPdf = readFileSync(join(root, 'project-a/reader/labeled.pdf'), 'latin1')
    expect(labeledPdf).toContain('/PageLabels')
    expect(labeledPdf).toContain('/Outlines')
    expect(labeledPdf.match(/\/Type \/Page\b/g)).toHaveLength(3)
    const longPdf = readFileSync(join(root, 'project-a/reader/long-240.pdf'), 'latin1')
    expect(longPdf.match(/\/Type \/Page\b/g)).toHaveLength(240)

    expect(readFileSync(join(root, 'browser/index.html'), 'utf8'))
      .toContain('STAIR-BROWSER-FIXTURE-v1')
    expect(JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'))).toEqual(manifest)
    expect(verifyRegressionBundle(join(root, 'manifest.json'), root))
      .toBe(manifest.files.length)
  })

  test('copies a pristine project fixture without overwriting an existing target', () => {
    const parent = mkdtempSync(join(tmpdir(), 'stair-regression-copy-'))
    temporaryDirectories.push(parent)
    const root = join(parent, 'bundle')
    generateRegressionFixtures(root)
    const target = join(parent, 'project-a-copy')

    copyRegressionProject(join(root, 'project-a'), target)

    expect(readFileSync(join(target, 'text/alpha.md'), 'utf8'))
      .toContain('STAIR alpha fixture')
    expect(verifyRegressionProject(
      join(root, 'manifest.json'),
      'project-a',
      target,
    )).toBeGreaterThan(500)
    expect(() => verifyRegressionProject(
      join(root, 'manifest.json'),
      'project-b',
      target,
    )).toThrow('does not match')
    expect(() => copyRegressionProject(join(root, 'project-a'), target))
      .toThrow('already exists')

    symlinkSync(
      join(target, 'text'),
      join(target, 'reparse-entry'),
      process.platform === 'win32' ? 'junction' : 'dir',
    )
    expect(() => verifyRegressionProject(
      join(root, 'manifest.json'),
      'project-a',
      target,
    )).toThrow('unsupported entry')
  })

  test.skipIf(process.platform === 'win32')(
    'rejects a symlink in place of the bundle root manifest',
    () => {
      const parent = mkdtempSync(join(tmpdir(), 'stair-regression-manifest-'))
      temporaryDirectories.push(parent)
      const root = join(parent, 'bundle')
      generateRegressionFixtures(root)
      const manifestPath = join(root, 'manifest.json')
      const externalManifestPath = join(parent, 'manifest.json')
      renameSync(manifestPath, externalManifestPath)
      symlinkSync(externalManifestPath, manifestPath)

      expect(() => verifyRegressionBundle(manifestPath, root))
        .toThrow('unsupported entry')
    },
  )

  test('rejects symlink or Windows junction entries in the fixture bundle', () => {
    const parent = mkdtempSync(join(tmpdir(), 'stair-regression-reparse-'))
    temporaryDirectories.push(parent)
    const root = join(parent, 'bundle')
    generateRegressionFixtures(root)
    symlinkSync(
      join(root, 'project-a'),
      join(root, 'reparse-entry'),
      process.platform === 'win32' ? 'junction' : 'dir',
    )

    expect(() => verifyRegressionBundle(join(root, 'manifest.json'), root))
      .toThrow('unsupported entry')
  })
})
