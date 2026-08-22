import { describe, expect, it } from 'bun:test'
import {
  DEFAULT_WORKBENCH_PANEL_RATIO,
  normalizeWorkbenchLayoutDocument,
} from './index'

const validation = {
  isProjectAvailable: (projectId: string) => projectId === 'project-a',
  isSessionAvailable: (projectId: string, sessionId: string) => (
    projectId === 'project-a'
    && ['session-a', 'session-target'].includes(sessionId)
  ),
}

describe('Workbench layout document', () => {
  it('drops only invalid Projects and Panel entries', () => {
    expect(normalizeWorkbenchLayoutDocument({
      version: 1,
      layoutsByProject: {
        'project-a': {
          primary: {
            id: 'primary-a',
            kind: 'session',
            sessionId: 'session-a',
            widthRatio: 2,
          },
          auxiliary: [
            {
              id: 'missing-session',
              kind: 'session',
              sessionId: 'session-missing',
              widthRatio: 1,
            },
            {
              id: 'file-a',
              kind: 'project-file',
              relativePath: 'docs/guide.md',
              presentation: 'preview',
              chatTargetSessionId: 'session-missing',
              widthRatio: 'broken',
            },
            {
              id: 'browser-a',
              kind: 'browser',
              url: 'https://example.com/',
              title: 'Example',
              chatTargetSessionId: 'session-target',
              widthRatio: 1,
            },
          ],
          previewPanelId: 'missing-preview',
          focusedPanelId: 'missing-session',
        },
        'project-missing': {
          primary: null,
          auxiliary: [],
          previewPanelId: null,
          focusedPanelId: null,
        },
      },
    }, validation)).toEqual({
      version: 1,
      layoutsByProject: {
        'project-a': {
          primary: {
            id: 'primary-a',
            kind: 'session',
            sessionId: 'session-a',
            widthRatio: 2,
          },
          auxiliary: [
            {
              id: 'file-a',
              kind: 'project-file',
              relativePath: 'docs/guide.md',
              presentation: 'preview',
              chatTargetSessionId: null,
              widthRatio: DEFAULT_WORKBENCH_PANEL_RATIO,
            },
            {
              id: 'browser-a',
              kind: 'browser',
              url: 'https://example.com/',
              title: 'Example',
              chatTargetSessionId: 'session-target',
              widthRatio: 1,
            },
          ],
          previewPanelId: 'file-a',
          focusedPanelId: 'primary-a',
        },
      },
    })
  })

  it('rejects an unknown document version without replacing valid storage', () => {
    expect(normalizeWorkbenchLayoutDocument({
      version: 2,
      layoutsByProject: {
        'project-a': { primary: null, auxiliary: [] },
      },
    }, validation)).toEqual({ version: 1, layoutsByProject: {} })
  })

  it('does not impose a visible Panel cap', () => {
    const auxiliary = Array.from({ length: 12 }, (_, index) => ({
      id: `file-${index}`,
      kind: 'project-file',
      relativePath: `docs/${index}.md`,
      presentation: 'explicit',
      chatTargetSessionId: null,
      widthRatio: 1,
    }))
    const document = normalizeWorkbenchLayoutDocument({
      version: 1,
      layoutsByProject: {
        'project-a': {
          primary: null,
          auxiliary,
          previewPanelId: null,
          focusedPanelId: 'file-11',
        },
      },
    }, validation)

    expect(document.layoutsByProject['project-a']?.auxiliary).toHaveLength(12)
    expect(document.layoutsByProject['project-a']?.focusedPanelId).toBe('file-11')
  })
})
