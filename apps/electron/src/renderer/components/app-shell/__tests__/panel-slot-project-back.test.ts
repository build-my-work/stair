import { describe, expect, it, mock } from 'bun:test'

Object.assign(globalThis, {
  window: {
    location: {
      protocol: 'file:',
    },
    electronAPI: {
      getRuntimeEnvironment: () => 'electron',
    },
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => true,
  },
})

mock.module('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({
  default: '',
}))
mock.module('pdfjs-dist', () => ({
  GlobalWorkerOptions: { workerSrc: '' },
  getDocument: () => ({}),
}))
mock.module('electron-log/renderer', () => ({
  default: {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  },
}))
mock.module('@/context/ThemeContext', () => ({
  useTheme: () => ({
    resolvedTheme: 'light',
    theme: 'light',
  }),
}))
mock.module('@/pages/ProjectFilePage', () => ({
  default: () => null,
}))
mock.module('../MainContentPanel', () => ({
  MainContentPanel: () => null,
}))

const { getCompactProjectBackRoute } = await import('../PanelSlot')

describe('getCompactProjectBackRoute', () => {
  it('returns the owning project root for a project session', () => {
    expect(getCompactProjectBackRoute(
      {
        kind: 'navigation',
        viewRoute: 'projects/project/operating-systems/session/session-1',
      },
    )).toBe('projects/project/operating-systems')
  })

  it('does not rewrite a project root or ordinary session route', () => {
    expect(getCompactProjectBackRoute(
      {
        kind: 'navigation',
        viewRoute: 'projects/project/operating-systems',
      },
    )).toBeNull()
    expect(getCompactProjectBackRoute(
      {
        kind: 'navigation',
        viewRoute: 'allSessions/session/session-1',
      },
    )).toBeNull()
  })

  it('leaves Project File routes to their explicit compact Back behavior', () => {
    expect(getCompactProjectBackRoute(
      {
        kind: 'projectFile',
        projectId: 'project-1',
        relativePath: 'README.md',
        contextRoute: 'projects/project/operating-systems/session/session-1',
      },
    )).toBeNull()
  })
})
