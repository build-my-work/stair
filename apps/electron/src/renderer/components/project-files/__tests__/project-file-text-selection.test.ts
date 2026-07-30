import { describe, expect, it } from 'bun:test'
import {
  isProjectFileSelectionReferenceV1,
} from '@craft-agent/core'
import { buildProjectFileSelectionReference } from '../ProjectFileTextSelection'

describe('buildProjectFileSelectionReference', () => {
  it('creates a fingerprint-bound text quote selection', () => {
    const reference = buildProjectFileSelectionReference({
      projectId: 'project-1',
      relativePath: 'docs/source.md',
      metadata: {
        projectId: 'project-1',
        relativePath: 'docs/source.md',
        name: 'source.md',
        mimeType: 'text/markdown',
        byteLength: 100,
        lastModifiedMs: 1,
      },
      sourceFingerprint: `sha256:${'a'.repeat(64)}`,
      selection: {
        quote: 'selected text',
        start: 7,
        end: 20,
        prefix: 'before ',
        suffix: ' after',
        anchorRect: {} as DOMRect,
      },
    })

    expect(reference.locator).toEqual({
      type: 'text-quote',
      exact: 'selected text',
      prefix: 'before ',
      suffix: ' after',
      start: 7,
      end: 20,
    })
    expect(isProjectFileSelectionReferenceV1(reference)).toBe(true)
  })
})
