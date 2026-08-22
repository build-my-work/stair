import {
  existsSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { getWorkspaceByNameOrId } from '@craft-agent/shared/config'
import { loadWorkspaceProjects } from '@craft-agent/shared/projects'
import { RPC_CHANNELS } from '@craft-agent/shared/protocol'
import { loadSession } from '@craft-agent/shared/sessions'
import {
  WORKBENCH_LAYOUT_VERSION,
  normalizeWorkbenchLayoutDocument,
  type PersistedWorkbenchLayoutDocument,
  type WorkbenchLayoutValidation,
} from '@craft-agent/shared/workbench-layout'
import type { RequestContext, RpcServer } from '../../transport'
import type { HandlerDeps } from '../handler-deps'

export const WORKBENCH_LAYOUT_FILE = 'workbench-layout.json'
const MAX_WORKBENCH_LAYOUT_BYTES = 1024 * 1024

export const HANDLED_CHANNELS = [
  RPC_CHANNELS.workbenchLayout.READ,
  RPC_CHANNELS.workbenchLayout.WRITE,
] as const

function resolveWorkspaceRoot(context: RequestContext, deps: HandlerDeps): string {
  const workspaceId = context.workspaceId
    ?? (context.webContentsId == null
      ? null
      : deps.windowManager?.getWorkspaceForWindow(context.webContentsId))
  if (!workspaceId) throw new Error('No active Workspace is associated with this request')
  const workspace = getWorkspaceByNameOrId(workspaceId)
  if (!workspace) throw new Error('Active Workspace is unavailable')
  return workspace.rootPath
}

function validationForWorkspace(rootPath: string): WorkbenchLayoutValidation {
  const projectIds = new Set(loadWorkspaceProjects(rootPath).map(project => project.config.id))
  const sessionProjects = new Map<string, string | null>()
  return {
    isProjectAvailable: projectId => projectIds.has(projectId),
    isSessionAvailable: (projectId, sessionId) => {
      if (!sessionProjects.has(sessionId)) {
        sessionProjects.set(sessionId, loadSession(rootPath, sessionId)?.projectId ?? null)
      }
      return sessionProjects.get(sessionId) === projectId
    },
  }
}

function emptyDocument(): PersistedWorkbenchLayoutDocument {
  return { version: WORKBENCH_LAYOUT_VERSION, layoutsByProject: {} }
}

function readWorkbenchLayout(rootPath: string): PersistedWorkbenchLayoutDocument {
  const filePath = join(rootPath, WORKBENCH_LAYOUT_FILE)
  if (!existsSync(filePath)) return emptyDocument()
  try {
    const stats = statSync(filePath)
    if (!stats.isFile() || stats.size > MAX_WORKBENCH_LAYOUT_BYTES) return emptyDocument()
    return normalizeWorkbenchLayoutDocument(
      JSON.parse(readFileSync(filePath, 'utf8')),
      validationForWorkspace(rootPath),
    )
  } catch {
    return emptyDocument()
  }
}

function writeWorkbenchLayout(
  rootPath: string,
  value: unknown,
): PersistedWorkbenchLayoutDocument {
  const document = normalizeWorkbenchLayoutDocument(value, validationForWorkspace(rootPath))
  const content = `${JSON.stringify(document, null, 2)}\n`
  if (Buffer.byteLength(content, 'utf8') > MAX_WORKBENCH_LAYOUT_BYTES) {
    throw new Error('Workbench layout exceeds the 1 MiB storage limit')
  }
  const filePath = join(rootPath, WORKBENCH_LAYOUT_FILE)
  const temporaryPath = `${filePath}.tmp`
  try {
    writeFileSync(temporaryPath, content, { encoding: 'utf8', mode: 0o600 })
    renameSync(temporaryPath, filePath)
  } catch (error) {
    try { unlinkSync(temporaryPath) } catch { /* already absent */ }
    throw error
  }
  return document
}

export function registerWorkbenchLayoutHandlers(server: RpcServer, deps: HandlerDeps): void {
  server.handle(RPC_CHANNELS.workbenchLayout.READ, context => (
    readWorkbenchLayout(resolveWorkspaceRoot(context, deps))
  ))
  server.handle(RPC_CHANNELS.workbenchLayout.WRITE, (context, value) => (
    writeWorkbenchLayout(resolveWorkspaceRoot(context, deps), value)
  ))
}
