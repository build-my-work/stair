import { describe, expect, it, mock } from 'bun:test'
import type { ProjectFileRequest } from '@craft-agent/shared/protocol'

mock.module('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({
  default: '',
}))
mock.module('pdfjs-dist', () => ({
  GlobalWorkerOptions: { workerSrc: '' },
  getDocument: () => ({}),
}))
mock.module('@/context/ThemeContext', () => ({
  useTheme: () => ({
    resolvedMode: 'light',
    shikiTheme: 'github-light',
  }),
}))

const {
  getProjectFileKind,
  loadProjectFilePreview,
} = await import('../ProjectFilePage')

describe('ProjectFilePage classification', () => {
  it.each([
    ['books/os.epub', 'epub'],
    ['docs/guide.pdf', 'pdf'],
    ['images/cover.png', 'image'],
    ['README.md', 'markdown'],
    ['src/index.ts', 'code'],
    ['data/config.json', 'json'],
    ['notes/todo.txt', 'text'],
    ['archive.zip', 'unknown'],
  ] as const)('classifies %s as %s', (path, expected) => {
    expect(getProjectFileKind(path)).toBe(expected)
  })

  it.each([
    ['epub', true, 'binary', 'readProjectFileBinary'],
    ['markdown', true, 'text', 'readProjectFileText'],
    ['unknown', false, 'unsupported', null],
  ] as const)(
    'routes %s previews through the matching Project-scoped reader when supported',
    async (kind, canPreview, expectedType, expectedMethod) => {
      const calls: Array<{
        method: string
        request: ProjectFileRequest
      }> = []
      const api: Pick<
        Window['electronAPI'],
        'readProjectFileBinary' | 'readProjectFileText'
      > = {
        readProjectFileBinary: async (request) => {
          calls.push({ method: 'readProjectFileBinary', request })
          return {} as Awaited<ReturnType<Window['electronAPI']['readProjectFileBinary']>>
        },
        readProjectFileText: async (request) => {
          calls.push({ method: 'readProjectFileText', request })
          return {} as Awaited<ReturnType<Window['electronAPI']['readProjectFileText']>>
        },
      }
      const request = {
        projectId: 'project-1',
        relativePath: 'books/os.epub',
      }

      const result = await loadProjectFilePreview(
        request,
        kind,
        canPreview,
        api,
      )

      expect(result.type).toBe(expectedType)
      expect(calls).toEqual(
        expectedMethod ? [{ method: expectedMethod, request }] : [],
      )
    },
  )
})
