// A separate process keeps the compatibility peer's version independent of
// the current client. Only the protocol constant is replaced: WS dispatch,
// handlers and draft/session storage are the production implementations.
import { mock } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const profile = process.env.CRAFT_CONFIG_DIR
if (!profile?.includes('stair-plan-protocol-profile-')) throw new Error('Disposable profile required')
const protocol = await import('@craft-agent/shared/protocol')
mock.module('@craft-agent/shared/protocol', () => ({ ...protocol, PROTOCOL_VERSION: '2.0' }))
const { getSessionDraft, setSessionDraftContent } = await import('@craft-agent/shared/config')
const { createWorkspaceAtPath } = await import('@craft-agent/shared/workspaces')
const { saveSession, sessionPersistenceQueue, getSessionFilePath } = await import('@craft-agent/shared/sessions')
const { SessionManager, createManagedSession } = await import('../../sessions/SessionManager')
const { registerSettingsHandlers } = await import('../../handlers/rpc/settings')
const { WsRpcServer } = await import('../server')

const root = join(profile, 'workspace')
const workspace = { ...createWorkspaceAtPath(root, 'Version 2 compatibility host'), rootPath: root }
const id = 'legacy-host-session'
const sm = new SessionManager()
const managed = createManagedSession({ id, name: 'Preserved Chat', projectId: workspace.defaultProjectId }, workspace, { messagesLoaded: true })
;(sm as unknown as { sessions: Map<string, typeof managed> }).sessions.set(id, managed)
await saveSession({ id, name: 'Preserved Chat', projectId: managed.projectId, workspaceRootPath: root,
  createdAt: 1, lastUsedAt: 1, messages: [],
  tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, contextTokens: 0, costUsd: 0 } })
setSessionDraftContent(id, { text: 'Version 2 host draft must survive' })
const draftPath = join(profile, 'drafts.json')
const sessionPath = getSessionFilePath(root, id)
const beforeDraft = readFileSync(draftPath, 'utf8')
const beforeSession = readFileSync(sessionPath, 'utf8')
const calls: string[] = []
const server = new WsRpcServer({ host: '127.0.0.1', port: 0 })
const handle = server.handle.bind(server)
server.handle = (channel, handler) => handle(channel, (ctx, ...args) => {
  calls.push(channel)
  return handler(ctx, ...args)
})
registerSettingsHandlers(server, { sessionManager: sm, platform: { logger: console } } as never)
await server.listen()
process.on('message', async message => {
  if (message === 'inspect') {
    process.send?.({ type: 'snapshot', calls, draft: getSessionDraft(id),
      draftUnchanged: beforeDraft === readFileSync(draftPath, 'utf8'),
      sessionUnchanged: beforeSession === readFileSync(sessionPath, 'utf8') })
  } else if (message === 'stop') {
    await sessionPersistenceQueue.flushAll()
    server.close()
    process.disconnect?.()
  }
})
process.send?.({ type: 'ready', port: server.port, workspaceId: workspace.id, sessionId: id })
