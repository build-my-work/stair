import { describe, expect, it } from 'bun:test'
import {
  flushOpenProjectFile,
  flushOpenProjectFiles,
  notifyOpenProjectFileChanged,
  registerOpenProjectFileDocument,
} from '../project-file-document-registry'

describe('open Project File document registry', () => {
  it('flushes and refreshes every view registered for the exact file', async () => {
    const events: string[] = []
    const first = {
      flush: async () => { events.push('flush:first') },
      onExternalChange: () => { events.push('change:first') },
    }
    const second = {
      flush: async () => { events.push('flush:second') },
      onExternalChange: () => { events.push('change:second') },
    }
    const other = {
      flush: async () => { events.push('flush:other') },
    }
    const unregisterFirst = registerOpenProjectFileDocument(
      'project-1',
      'notes.md',
      first,
    )
    const unregisterSecond = registerOpenProjectFileDocument(
      'project-1',
      'notes.md',
      second,
    )
    const unregisterOther = registerOpenProjectFileDocument(
      'project-1',
      'other.txt',
      other,
    )

    try {
      await flushOpenProjectFile('project-1', 'notes.md')
      await notifyOpenProjectFileChanged('project-1', 'notes.md')
      expect(events.sort()).toEqual([
        'change:first',
        'change:second',
        'flush:first',
        'flush:second',
      ])

      events.length = 0
      unregisterFirst()
      await flushOpenProjectFiles()
      expect(events.sort()).toEqual(['flush:other', 'flush:second'])
    } finally {
      unregisterFirst()
      unregisterSecond()
      unregisterOther()
    }
  })
})
