import type {
  SaveProjectArtifactToolInput,
  SavedProjectArtifactResult,
} from '@craft-agent/session-tools-core'
import type { FileReference } from '@craft-agent/core/types'
import {
  getProjectArtifact,
  loadProjectById,
  saveProjectArtifact,
} from '@craft-agent/shared/projects'
import { loadSession } from '@craft-agent/shared/sessions'

interface SessionProjectArtifactContext {
  workspaceRootPath: string
  sessionId: string
  projectId: string
}

export async function saveSessionProjectArtifact(
  context: SessionProjectArtifactContext,
  input: SaveProjectArtifactToolInput,
): Promise<SavedProjectArtifactResult> {
  const project = loadProjectById(context.workspaceRootPath, context.projectId)
  if (!project) throw new Error(`Project ${context.projectId} not found`)
  const existing = input.artifactId
    ? getProjectArtifact(context.workspaceRootPath, project.config.slug, input.artifactId)
    : null
  const references = resolveTrustedReferences(
    context,
    input.references,
    existing?.references ?? [],
  )

  const artifact = saveProjectArtifact(context.workspaceRootPath, project.config.slug, {
    id: input.artifactId,
    sourceSessionId: resolveArtifactSourceSessionId(existing?.sourceSessionId, context.sessionId),
    title: input.title,
    markdown: input.markdown,
    templateId: input.templateId,
    references,
  })

  return {
    artifactId: artifact.id,
    projectId: artifact.projectId,
    title: artifact.title,
  }
}

export function resolveArtifactSourceSessionId(
  existingSourceSessionId: string | undefined,
  currentSessionId: string,
): string {
  return existingSourceSessionId ?? currentSessionId
}

function resolveTrustedReferences(
  context: SessionProjectArtifactContext,
  references: SaveProjectArtifactToolInput['references'],
  existingReferences: readonly FileReference[],
): FileReference[] {
  if (references.length === 0) return []

  const trustedByLocation = new Map<string, FileReference>()
  for (const reference of existingReferences) {
    const key = referenceLocationKey(reference.path, reference.locator)
    if (key) trustedByLocation.set(key, reference)
  }

  const storedSession = loadSession(context.workspaceRootPath, context.sessionId)
  for (const message of storedSession?.messages ?? []) {
    if (message.type !== 'user') continue
    for (const reference of message.references ?? []) {
      if (reference.projectId !== context.projectId) continue
      const key = referenceLocationKey(reference.path, reference.locator)
      if (key) trustedByLocation.set(key, reference)
    }
  }

  return references.map((reference, index) => {
    const key = referenceLocationKey(reference.path, reference.locator)
    const trusted = key ? trustedByLocation.get(key) : undefined
    if (!trusted) {
      throw new Error(`Artifact reference at index ${index} is not backed by a trusted user reference`)
    }
    return trusted
  })
}

function referenceLocationKey(
  path: unknown,
  locator: unknown,
): string | undefined {
  if (typeof path !== 'string' || !locator || typeof locator !== 'object') return undefined
  const value = locator as Partial<FileReference['locator']>
  if (value.type === 'epub-cfi' && typeof value.cfiRange === 'string') {
    return JSON.stringify([path, value.type, value.cfiRange])
  }
  if (value.type === 'pdf-page' && Number.isInteger(value.page)) {
    return JSON.stringify([path, value.type, value.page])
  }
  if (
    value.type === 'text-range'
    && Number.isInteger(value.startLine)
    && Number.isInteger(value.endLine)
  ) {
    return JSON.stringify([path, value.type, value.startLine, value.endLine])
  }
  return undefined
}
