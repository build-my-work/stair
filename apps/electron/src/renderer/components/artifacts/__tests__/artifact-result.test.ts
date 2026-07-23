import { describe, expect, it } from 'bun:test'

import {
  parseSavedArtifactResult,
  parseSavedArtifactToolResult,
} from '../artifact-result'

describe('saved artifact tool results', () => {
  it('extracts the durable artifact locator from the session tool result', () => {
    expect(parseSavedArtifactResult({
      toolName: 'save_project_artifact',
      content: 'Saved project artifact: {"artifactId":"artifact-1","projectId":"project-1","title":"第 3 章学习笔记","kind":"project-artifact"}',
    })).toEqual({
      artifactId: 'artifact-1',
      projectId: 'project-1',
      title: '第 3 章学习笔记',
    })
  })

  it('accepts the MCP-prefixed tool name emitted by session tool providers', () => {
    expect(parseSavedArtifactResult({
      toolName: 'mcp__session__save_project_artifact',
      content: 'Saved project artifact: {"artifactId":"artifact-2","projectId":"project-1","title":"CPU 虚拟化","kind":"project-artifact"}',
    })).toEqual({
      artifactId: 'artifact-2',
      projectId: 'project-1',
      title: 'CPU 虚拟化',
    })
  })

  it('ignores unrelated or malformed tool output', () => {
    expect(parseSavedArtifactResult({ toolName: 'read', content: '{}' })).toBeNull()
    expect(parseSavedArtifactResult({
      toolName: 'save_project_artifact',
      content: 'Saved project artifact: {"artifactId":"../bad","kind":"project-artifact"}',
    })).toBeNull()
  })

  it('announces only successful save tool results', () => {
    const result = 'Saved project artifact: {"artifactId":"artifact-3","projectId":"project-1","title":"进程笔记","kind":"project-artifact"}'

    expect(parseSavedArtifactToolResult({
      toolName: 'mcp__session__save_project_artifact',
      result,
    })).toEqual({
      artifactId: 'artifact-3',
      projectId: 'project-1',
      title: '进程笔记',
    })
    expect(parseSavedArtifactToolResult({
      toolName: 'mcp__session__save_project_artifact',
      result,
      isError: true,
    })).toBeNull()
  })
})
