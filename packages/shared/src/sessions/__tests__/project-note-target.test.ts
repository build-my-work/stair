import { describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readSessionHeader, readSessionHeaderAsync } from '../jsonl'
import { SESSION_PERSISTENT_FIELDS } from '../types'
import { pickSessionFields } from '../utils'

describe('Session Project note target persistence', () => {
  it('persists the Session-scoped current and recent targets', () => {
    expect(SESSION_PERSISTENT_FIELDS).toContain('projectNoteTargetPath')
    expect(SESSION_PERSISTENT_FIELDS)
      .toContain('projectNoteTargetRootFingerprint')
    expect(SESSION_PERSISTENT_FIELDS).toContain('projectNoteRecentTargetPaths')
    expect(pickSessionFields({
      id: 'session-1',
      projectId: 'project-1',
      projectNoteTargetPath: 'notes/research.md',
      projectNoteTargetRootFingerprint: 'root-fingerprint',
      projectNoteRecentTargetPaths: [
        'notes/research.md',
        'notes/earlier.md',
      ],
      unrelatedRuntimeValue: true,
    })).toEqual({
      id: 'session-1',
      projectId: 'project-1',
      projectNoteTargetPath: 'notes/research.md',
      projectNoteTargetRootFingerprint: 'root-fingerprint',
      projectNoteRecentTargetPaths: [
        'notes/research.md',
        'notes/earlier.md',
      ],
    })
  })

  it('reads a header containing five maximum-scale recent paths', async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), 'session-note-header-'))
    const sessionFile = join(sessionDir, 'session.jsonl')
    const recentPaths = Array.from(
      { length: 5 },
      (_, index) => `${index}-${'a'.repeat(1_700)}.md`,
    )
    const header = {
      id: 'session-long-header',
      workspaceRootPath: '/tmp/workspace',
      createdAt: 1,
      lastUsedAt: 1,
      projectId: 'project-1',
      projectNoteTargetPath: recentPaths[0],
      projectNoteTargetRootFingerprint: 'root-fingerprint',
      projectNoteRecentTargetPaths: recentPaths,
      messageCount: 0,
    }

    try {
      const serialized = `${JSON.stringify(header)}\n`
      expect(Buffer.byteLength(serialized, 'utf8')).toBeGreaterThan(8 * 1024)
      writeFileSync(sessionFile, serialized)

      expect(readSessionHeader(sessionFile)?.projectNoteRecentTargetPaths)
        .toEqual(recentPaths)
      await expect(readSessionHeaderAsync(sessionFile))
        .resolves.toMatchObject({ projectNoteRecentTargetPaths: recentPaths })
    } finally {
      rmSync(sessionDir, { recursive: true, force: true })
    }
  })
})
