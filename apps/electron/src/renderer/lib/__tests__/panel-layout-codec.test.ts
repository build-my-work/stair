import { describe, expect, it } from 'bun:test'
import type { PanelContentRoute } from '../../../shared/routes'
import {
  deserializePanelLayout,
  MAX_ENCODED_PANEL_LAYOUT_BYTES,
  MAX_PANEL_LAYOUT_ENTRIES,
  serializePanelLayout,
  type SerializedPanelLayoutV2,
} from '../panel-layout-codec'

const navigation = (
  viewRoute: 'allSessions/session/s1' | 'projects/project/demo',
): PanelContentRoute => ({ kind: 'navigation', viewRoute })

const epubRoute: PanelContentRoute = {
  kind: 'projectFile',
  projectId: 'project-1',
  relativePath: '书籍/Operating Systems, V2: notes.epub',
  contextRoute: 'allSessions/session/s1',
}

function encodeUnknown(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value))
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/u, '')
}

describe('PanelLayoutV2 codec', () => {
  it('round-trips independent ratios, physical owner, Chat target, and focus', () => {
    const route = navigation('allSessions/session/s1')
    const encoded = serializePanelLayout([
      { id: 'owner-a', route, widthRatio: 0.47 },
      { id: 'owner-b', route, widthRatio: 0.55 },
      {
        id: 'file-a',
        route: epubRoute,
        widthRatio: 0.7,
        ownerPanelId: 'owner-a',
        chatTargetSessionId: 'session-2',
      },
    ], 'owner-b')

    expect(encoded).not.toBeNull()
    expect(deserializePanelLayout(encoded!)).toEqual({
      version: 2,
      entries: [
        { key: 'p0', route, widthRatio: 0.47 },
        { key: 'p1', route, widthRatio: 0.55 },
        {
          key: 'p2',
          route: epubRoute,
          widthRatio: 0.7,
          ownerKey: 'p0',
          chatTargetSessionId: 'session-2',
        },
      ],
      focusedKey: 'p1',
    })
  })

  it('round-trips an orphan without manufacturing an owner', () => {
    const encoded = serializePanelLayout([
      { id: 'file', route: epubRoute, widthRatio: 0.7 },
    ], 'file')

    expect(deserializePanelLayout(encoded!)).toEqual({
      version: 2,
      entries: [{
        key: 'p0',
        route: epubRoute,
        widthRatio: 0.7,
      }],
      focusedKey: 'p0',
    })
  })

  it('rejects a V1 proportion layout so navigation uses its safe fallback', () => {
    expect(deserializePanelLayout(encodeUnknown({
      version: 1,
      entries: [{
        key: 'p0',
        route: navigation('projects/project/demo'),
        proportion: 1,
      }],
      focusedKey: 'p0',
    }))).toBeNull()
  })

  it('rejects the temporary V2 pixel-width shape', () => {
    expect(deserializePanelLayout(encodeUnknown({
      version: 2,
      entries: [{
        key: 'p0',
        route: navigation('projects/project/demo'),
        basisPx: 560,
      }],
      focusedKey: 'p0',
    }))).toBeNull()
  })

  it.each([
    [
      'duplicate key',
      {
        version: 2,
        entries: [
          { key: 'p0', route: navigation('projects/project/demo'), widthRatio: 0.47 },
          { key: 'p0', route: navigation('projects/project/demo'), widthRatio: 0.47 },
        ],
        focusedKey: 'p0',
      },
    ],
    [
      'missing focus',
      {
        version: 2,
        entries: [
          { key: 'p0', route: navigation('projects/project/demo'), widthRatio: 0.47 },
        ],
        focusedKey: 'missing',
      },
    ],
    [
      'missing owner',
      {
        version: 2,
        entries: [{
          key: 'p0',
          route: epubRoute,
          widthRatio: 0.7,
          ownerKey: 'missing',
        }],
        focusedKey: 'p0',
      },
    ],
    [
      'owner is a file',
      {
        version: 2,
        entries: [
          { key: 'p0', route: epubRoute, widthRatio: 0.7 },
          {
            key: 'p1',
            route: {
              ...epubRoute,
              relativePath: 'notes.md',
            },
            widthRatio: 0.47,
            ownerKey: 'p0',
          },
        ],
        focusedKey: 'p1',
      },
    ],
    [
      'invalid route',
      {
        version: 2,
        entries: [{
          key: 'p0',
          route: { kind: 'navigation', viewRoute: 'action/new-session' },
          widthRatio: 0.47,
        }],
        focusedKey: 'p0',
      },
    ],
    [
      'Chat target on a navigation panel',
      {
        version: 2,
        entries: [{
          key: 'p0',
          route: navigation('projects/project/demo'),
          widthRatio: 0.47,
          chatTargetSessionId: 'session-2',
        }],
        focusedKey: 'p0',
      },
    ],
    [
      'empty Chat target',
      {
        version: 2,
        entries: [{
          key: 'p0',
          route: epubRoute,
          widthRatio: 0.7,
          chatTargetSessionId: '',
        }],
        focusedKey: 'p0',
      },
    ],
    [
      'non-canonical project file path',
      {
        version: 2,
        entries: [{
          key: 'p0',
          route: {
            ...epubRoute,
            relativePath: 'books//example.epub',
          },
          widthRatio: 0.7,
        }],
        focusedKey: 'p0',
      },
    ],
    [
      'zero ratio',
      {
        version: 2,
        entries: [{
          key: 'p0',
          route: navigation('projects/project/demo'),
          widthRatio: 0,
        }],
        focusedKey: 'p0',
      },
    ],
    [
      'negative ratio',
      {
        version: 2,
        entries: [{
          key: 'p0',
          route: navigation('projects/project/demo'),
          widthRatio: -0.1,
        }],
        focusedKey: 'p0',
      },
    ],
    [
      'legacy proportion alongside a ratio',
      {
        version: 2,
        entries: [{
          key: 'p0',
          route: navigation('projects/project/demo'),
          widthRatio: 0.47,
          proportion: 1,
        }],
        focusedKey: 'p0',
      },
    ],
    [
      'string ratio',
      {
        version: 2,
        entries: [{
          key: 'p0',
          route: navigation('projects/project/demo'),
          widthRatio: '0.47',
        }],
        focusedKey: 'p0',
      },
    ],
  ])('rejects %s', (_name, value) => {
    expect(deserializePanelLayout(encodeUnknown(value))).toBeNull()
  })

  it('enforces panel count and encoded-size bounds', () => {
    const tooMany = Array.from(
      { length: MAX_PANEL_LAYOUT_ENTRIES + 1 },
      (_, index) => ({
        id: `panel-${index}`,
        route: navigation('projects/project/demo'),
        widthRatio: 0.47,
      }),
    )
    expect(serializePanelLayout(tooMany, 'panel-0')).toBeNull()
    expect(deserializePanelLayout(
      'a'.repeat(MAX_ENCODED_PANEL_LAYOUT_BYTES + 1),
    )).toBeNull()
  })

  it('has the declared V2 schema', () => {
    const layout: SerializedPanelLayoutV2 = {
      version: 2,
      entries: [{
        key: 'p0',
        route: navigation('projects/project/demo'),
        widthRatio: 0.47,
      }],
      focusedKey: 'p0',
    }
    expect(deserializePanelLayout(encodeUnknown(layout))).toEqual(layout)
  })

  it('round-trips a browser route without page URL or cookie state', () => {
    const browserRoute: PanelContentRoute = {
      kind: 'browser',
      browserId: '6e8dbf54-6349-4ed8-bd4f-a93a0df15dbe',
      contextRoute: 'allSessions/session/s1',
    }
    const encoded = serializePanelLayout([
      {
        id: 'anchor',
        route: navigation('allSessions/session/s1'),
        widthRatio: 0.47,
      },
      {
        id: 'browser',
        route: browserRoute,
        widthRatio: 0.63,
        ownerPanelId: 'anchor',
        chatTargetSessionId: 'session-2',
      },
    ], 'browser')

    expect(deserializePanelLayout(encoded!)).toEqual({
      version: 2,
      entries: [
        {
          key: 'p0',
          route: navigation('allSessions/session/s1'),
          widthRatio: 0.47,
        },
        {
          key: 'p1',
          route: browserRoute,
          widthRatio: 0.63,
          ownerKey: 'p0',
          chatTargetSessionId: 'session-2',
        },
      ],
      focusedKey: 'p1',
    })
  })
})
