import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'bun:test'

describe('Project Files tree legacy capabilities', () => {
  it('wires search and ordinary file/directory creation to the current RPC API', () => {
    const source = readFileSync(
      new URL('../ProjectFilesTree.tsx', import.meta.url),
      'utf8',
    )
    expect(source).toContain('window.electronAPI.searchProjectFiles')
    expect(source).toContain('window.electronAPI.createProjectFile')
    expect(source).toContain('window.electronAPI.createProjectDirectory')
  })
})
