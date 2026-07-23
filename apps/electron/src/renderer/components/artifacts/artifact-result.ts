export interface SavedArtifactResult {
  artifactId: string
  projectId: string
  title: string
}

interface ToolActivityResult {
  toolName?: string
  content?: string
}

interface SavedArtifactToolResult {
  toolName?: string
  result?: string
  isError?: boolean
}

const RESULT_PREFIX = 'Saved project artifact:'
const ARTIFACT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

export function parseSavedArtifactResult(activity: ToolActivityResult): SavedArtifactResult | null {
  const toolName = activity.toolName?.toLowerCase().replace(/^mcp__session__/, '')
  if (toolName !== 'save_project_artifact') return null
  const content = activity.content?.trim()
  if (!content) return null

  const json = content.startsWith(RESULT_PREFIX)
    ? content.slice(RESULT_PREFIX.length).trim()
    : content
  try {
    const value = JSON.parse(json) as Record<string, unknown>
    if (
      value.kind !== 'project-artifact'
      || typeof value.artifactId !== 'string'
      || !ARTIFACT_ID_PATTERN.test(value.artifactId)
      || typeof value.projectId !== 'string'
      || value.projectId.length === 0
      || typeof value.title !== 'string'
      || value.title.trim().length === 0
    ) {
      return null
    }
    return {
      artifactId: value.artifactId,
      projectId: value.projectId,
      title: value.title,
    }
  } catch {
    return null
  }
}

export function parseSavedArtifactToolResult(
  event: SavedArtifactToolResult,
): SavedArtifactResult | null {
  if (event.isError === true) return null
  return parseSavedArtifactResult({
    toolName: event.toolName,
    content: event.result,
  })
}
