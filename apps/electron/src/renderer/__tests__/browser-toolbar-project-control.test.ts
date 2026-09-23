import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'

const source = readFileSync(
  new URL('../browser-toolbar.tsx', import.meta.url),
  'utf8',
)

describe('Browser toolbar Project control', () => {
  it('shows the current Project and opens the native Project menu', () => {
    expect(source).toContain(
      "const projectLabel = state.projectTitle ?? state.projectId ?? t('tasks.project')",
    )
    expect(source).toContain('aria-label={projectActionLabel}')
    expect(source).toContain("onClick={() => { void api?.showMenu('projects') }}")
  })

  it('keeps the selector locked for a session-owned Browser', () => {
    expect(source).toContain(
      'disabled={!state.projectId || state.canChooseProject === false}',
    )
  })

  it('shows the Note target whenever the Browser has a Project', () => {
    expect(source).toContain('const targetNoteLabel = state.projectId')
  })
})
