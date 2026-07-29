import { describe, expect, it } from 'bun:test'
import {
  deserializePanelLayoutV1,
  MAX_ENCODED_PANEL_LAYOUT_BYTES,
  MAX_PANEL_LAYOUT_ENTRIES,
  serializePanelLayoutV1,
  type SerializedPanelLayoutV1,
} from '../panel-layout-codec'
import type { PanelContentRoute } from '../../../shared/routes'

const navigation = (
  viewRoute: 'allSessions/session/s1' | 'projects/project/demo',
): PanelContentRoute => ({ kind: 'navigation', viewRoute })

function encodeUnknown(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value))
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/u, '')
}

describe('PanelLayoutV1 codec', () => {
  it('round-trips duplicate navigation routes with physical owner and focus', () => {
    const route = navigation('allSessions/session/s1')
    const encoded = serializePanelLayoutV1([
      { id: 'owner-a', route, proportion: 0.2 },
      { id: 'owner-b', route, proportion: 0.3 },
      {
        id: 'file-a',
        route: {
          kind: 'projectFile',
          projectId: 'project-1',
          relativePath: '书籍/Operating Systems, V2: notes.epub',
          contextRoute: 'allSessions/session/s1',
        },
        proportion: 0.5,
        ownerPanelId: 'owner-a',
        chatTargetSessionId: 'session-2',
      },
    ], 'owner-b')

    expect(encoded).not.toBeNull()
    expect(deserializePanelLayoutV1(encoded!)).toEqual({
      version: 1,
      entries: [
        { key: 'p0', route, proportion: 0.2 },
        { key: 'p1', route, proportion: 0.3 },
        {
          key: 'p2',
          route: {
            kind: 'projectFile',
            projectId: 'project-1',
            relativePath: '书籍/Operating Systems, V2: notes.epub',
            contextRoute: 'allSessions/session/s1',
          },
          proportion: 0.5,
          ownerKey: 'p0',
          chatTargetSessionId: 'session-2',
        },
      ],
      focusedKey: 'p1',
    })
  })

  it('round-trips an orphan without manufacturing an owner', () => {
    const encoded = serializePanelLayoutV1([
      {
        id: 'file',
        route: {
          kind: 'projectFile',
          projectId: 'project-1',
          relativePath: 'book.epub',
          contextRoute: 'projects/project/demo',
        },
        proportion: 1,
      },
    ], 'file')

    expect(deserializePanelLayoutV1(encoded!))
      .toEqual({
        version: 1,
        entries: [{
          key: 'p0',
          route: {
            kind: 'projectFile',
            projectId: 'project-1',
            relativePath: 'book.epub',
            contextRoute: 'projects/project/demo',
          },
          proportion: 1,
        }],
        focusedKey: 'p0',
      })
  })

  it.each([
    ['wrong version', { version: 2, entries: [], focusedKey: 'p0' }],
    [
      'duplicate key',
      {
        version: 1,
        entries: [
          { key: 'p0', route: navigation('projects/project/demo'), proportion: 1 },
          { key: 'p0', route: navigation('projects/project/demo'), proportion: 1 },
        ],
        focusedKey: 'p0',
      },
    ],
    [
      'missing focus',
      {
        version: 1,
        entries: [
          { key: 'p0', route: navigation('projects/project/demo'), proportion: 1 },
        ],
        focusedKey: 'missing',
      },
    ],
    [
      'missing owner',
      {
        version: 1,
        entries: [{
          key: 'p0',
          route: {
            kind: 'projectFile',
            projectId: 'project-1',
            relativePath: 'book.epub',
            contextRoute: 'projects/project/demo',
          },
          proportion: 1,
          ownerKey: 'missing',
        }],
        focusedKey: 'p0',
      },
    ],
    [
      'owner is a file',
      {
        version: 1,
        entries: [
          {
            key: 'p0',
            route: {
              kind: 'projectFile',
              projectId: 'project-1',
              relativePath: 'book.epub',
              contextRoute: 'projects/project/demo',
            },
            proportion: 0.5,
          },
          {
            key: 'p1',
            route: {
              kind: 'projectFile',
              projectId: 'project-1',
              relativePath: 'notes.md',
              contextRoute: 'projects/project/demo',
            },
            proportion: 0.5,
            ownerKey: 'p0',
          },
        ],
        focusedKey: 'p1',
      },
    ],
    [
      'invalid route',
      {
        version: 1,
        entries: [{
          key: 'p0',
          route: { kind: 'navigation', viewRoute: 'action/new-session' },
          proportion: 1,
        }],
        focusedKey: 'p0',
      },
    ],
    [
      'chat target on a navigation panel',
      {
        version: 1,
        entries: [{
          key: 'p0',
          route: navigation('projects/project/demo'),
          proportion: 1,
          chatTargetSessionId: 'session-2',
        }],
        focusedKey: 'p0',
      },
    ],
    [
      'empty chat target',
      {
        version: 1,
        entries: [{
          key: 'p0',
          route: {
            kind: 'projectFile',
            projectId: 'project-1',
            relativePath: 'book.epub',
            contextRoute: 'projects/project/demo',
          },
          proportion: 1,
          chatTargetSessionId: '',
        }],
        focusedKey: 'p0',
      },
    ],
    [
      'non-canonical project file path',
      {
        version: 1,
        entries: [{
          key: 'p0',
          route: {
            kind: 'projectFile',
            projectId: 'project-1',
            relativePath: 'books//example.epub',
            contextRoute: 'projects/project/demo',
          },
          proportion: 1,
        }],
        focusedKey: 'p0',
      },
    ],
    [
      'invalid proportion',
      {
        version: 1,
        entries: [{
          key: 'p0',
          route: navigation('projects/project/demo'),
          proportion: 0,
        }],
        focusedKey: 'p0',
      },
    ],
  ])('rejects %s', (_name, value) => {
    expect(deserializePanelLayoutV1(encodeUnknown(value))).toBeNull()
  })

  it('enforces panel count and encoded-size bounds', () => {
    const tooMany = Array.from(
      { length: MAX_PANEL_LAYOUT_ENTRIES + 1 },
      (_, index) => ({
        id: `panel-${index}`,
        route: navigation('projects/project/demo'),
        proportion: 1,
      }),
    )
    expect(serializePanelLayoutV1(tooMany, 'panel-0')).toBeNull()
    expect(deserializePanelLayoutV1(
      'a'.repeat(MAX_ENCODED_PANEL_LAYOUT_BYTES + 1),
    )).toBeNull()
  })

  it('has the declared serializable schema', () => {
    const layout: SerializedPanelLayoutV1 = {
      version: 1,
      entries: [{
        key: 'p0',
        route: navigation('projects/project/demo'),
        proportion: 1,
      }],
      focusedKey: 'p0',
    }
    expect(deserializePanelLayoutV1(encodeUnknown(layout))).toEqual(layout)
  })

  it('round-trips a browser route without persisting page URL or cookie state', () => {
    const browserRoute: PanelContentRoute = {
      kind: 'browser',
      browserId: '6e8dbf54-6349-4ed8-bd4f-a93a0df15dbe',
      contextRoute: 'allSessions/session/s1',
    }
    const encoded = serializePanelLayoutV1([
      {
        id: 'anchor',
        route: navigation('allSessions/session/s1'),
        proportion: 0.5,
      },
      {
        id: 'browser',
        route: browserRoute,
        proportion: 0.5,
        ownerPanelId: 'anchor',
        chatTargetSessionId: 'session-2',
      },
    ], 'browser')

    expect(encoded).not.toBeNull()
    expect(deserializePanelLayoutV1(encoded!)).toEqual({
      version: 1,
      entries: [
        {
          key: 'p0',
          route: navigation('allSessions/session/s1'),
          proportion: 0.5,
        },
        {
          key: 'p1',
          route: browserRoute,
          proportion: 0.5,
          ownerKey: 'p0',
          chatTargetSessionId: 'session-2',
        },
      ],
      focusedKey: 'p1',
    })
  })

})
