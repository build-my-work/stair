import { afterAll, expect, spyOn, test } from 'bun:test'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Reference, StoredMessage } from '@craft-agent/core/types'

if (process.env.STAIR_BRANCH_COPY_TEST_CHILD !== '1') throw new Error('Requires isolated branch test profile')
const profile = mkdtempSync(join(tmpdir(), 'stair-branch-copy-'))
process.env.CRAFT_CONFIG_DIR = profile
copyFileSync(join(import.meta.dir, '../../../../apps/electron/resources/config-defaults.json'), join(profile, 'config-defaults.json'))
const { CONFIG_DIR } = await import('../../../shared/src/config/paths.ts')
if (CONFIG_DIR !== profile) throw new Error('Requires isolated config module cache')
const { saveConfig } = await import('../../../shared/src/config/storage.ts')
const { createWorkspaceAtPath } = await import('../../../shared/src/workspaces/storage.ts')
const { saveSessionStrict, loadSession, getSessionPath, listSessions, sessionPersistenceQueue } = await import('../../../shared/src/sessions/index.ts')
const { SessionManager } = await import('./SessionManager.ts')
const workspaceRoot = join(profile, 'workspace')
const workspace = createWorkspaceAtPath(workspaceRoot, 'Branch copy regression')
saveConfig({
  workspaces: [{ ...workspace, rootPath: workspaceRoot }], activeWorkspaceId: workspace.id, activeSessionId: null,
  defaultLlmConnection: 'offline-pi', llmConnections: [{ slug: 'offline-pi', name: 'Offline Pi',
    providerType: 'pi_compat', authType: 'api_key', createdAt: 1, defaultModel: 'pi/branch-test', models: ['branch-test'],
    baseUrl: 'http://127.0.0.1:1', customEndpoint: { api: 'openai-completions' } }],
})
afterAll(async () => {
  await sessionPersistenceQueue.flushAll()
  rmSync(profile, { recursive: true, force: true })
})

async function setup(id: string) {
  const path = getSessionPath(workspaceRoot, id)
  mkdirSync(join(path, 'attachments'), { recursive: true })
  const attachmentPath = join(path, 'attachments', 'source.txt')
  writeFileSync(attachmentPath, 'ORIGINAL-ATTACHMENT-BYTES')
  const planPath = join(path, 'plans', 'historical.md')
  const reference: Reference = { version: 1, kind: 'project-file', projectId: workspace.defaultProjectId,
    relativePath: 'text.txt', fileName: 'text.txt', sourceFingerprint: `sha256:${'0'.repeat(64)}`,
    quote: 'Quoted literal path: ' + planPath,
    locator: { type: 'text-quote', exact: 'Quoted literal path: ' + planPath, start: 0, end: 'Quoted literal path: '.length + planPath.length } }
  const messages: StoredMessage[] = [
    { id: 'original-user', type: 'user', content: 'Original body mentions ' + planPath,
      references: [reference], attachments: [{ id: 'attachment-1', type: 'text', name: 'source.txt',
        mimeType: 'text/plain', size: 25, storedPath: attachmentPath }] },
    { id: 'submit-tool', type: 'tool', content: 'Plan submitted', toolName: 'mcp__session__SubmitPlan', toolUseId: 'plan-call', toolInput: { planPath } },
    { id: 'original-plan', type: 'plan', content: '# Historical snapshot\n' + planPath, planPath },
    { id: 'selected-reply', type: 'assistant', content: 'Original reply points at ' + planPath },
    { id: 'future-input', type: 'user', content: 'FUTURE-MUST-NOT-BE-COPIED' },
  ]
  await saveSessionStrict({ id, projectId: workspace.defaultProjectId, workspaceRootPath: workspaceRoot,
    createdAt: 1, lastUsedAt: 1, llmConnection: 'offline-pi', model: 'pi/branch-test', sdkSessionId: 'parent-sdk',
    messages, tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, contextTokens: 0, costUsd: 0 } })
  const sm = new SessionManager()
  sm.setEventSink(() => {})
  // The SDK cutoff has its own real-worker tests. This seam keeps this test at
  // host/storage creation, without credentials or network requests.
  spyOn(sm as any, 'getOrCreateAgent').mockImplementation(async (managed: any) => {
    managed.agent = { supportsBranching: true, ensureBranchReady: async () => {}, destroy: () => {} }
    return managed.agent
  })
  return { sm, path, messages, attachmentPath }
}

test('historical text and reference snapshots stay exact; plan and attachment files are usable', async () => {
  const f = await setup('parent-success')
  const parentBefore = readFileSync(join(f.path, 'session.jsonl'), 'utf8')
  const child = await f.sm.createSession(workspace.id, { branchFromSessionId: 'parent-success', branchFromMessageId: 'selected-reply', llmConnection: 'offline-pi' })
  const stored = loadSession(workspaceRoot, child.id)!
  expect(stored.messages).toHaveLength(4)
  expect(stored.projectId).toBe(workspace.defaultProjectId)
  for (let index = 0; index < 4; index++) expect(stored.messages[index]!.content).toBe(f.messages[index]!.content)
  expect(stored.messages[0]!.references).toEqual(f.messages[0]!.references)
  expect(stored.messages[1]!.toolInput).toEqual(f.messages[1]!.toolInput)
  const copiedPlan = stored.messages[2]!
  expect(copiedPlan.toolUseId).toBe('plan-call')
  expect(copiedPlan.planPath).toStartWith(getSessionPath(workspaceRoot, child.id))
  expect(readFileSync(copiedPlan.planPath!, 'utf8')).toBe(copiedPlan.content)
  const copiedAttachment = stored.messages[0]!.attachments![0]!
  expect(copiedAttachment.storedPath).toStartWith(getSessionPath(workspaceRoot, child.id))
  expect(readFileSync(copiedAttachment.storedPath, 'utf8')).toBe('ORIGINAL-ATTACHMENT-BYTES')
  expect(readFileSync(join(f.path, 'session.jsonl'), 'utf8')).toBe(parentBefore)
})

test('a missing owned attachment rejects the branch and rolls back its storage', async () => {
  const f = await setup('parent-missing')
  rmSync(f.attachmentPath)
  const before = new Set(listSessions(workspaceRoot).map(session => session.id))
  await expect(f.sm.createSession(workspace.id, { branchFromSessionId: 'parent-missing', branchFromMessageId: 'selected-reply', llmConnection: 'offline-pi' })).rejects.toThrow()
  expect(new Set(listSessions(workspaceRoot).map(session => session.id))).toEqual(before)
})

test('an owned attachment symlink cannot copy a file outside the parent session', async () => {
  const f = await setup('parent-symlink')
  const outside = join(profile, 'outside-parent.txt')
  writeFileSync(outside, 'DO-NOT-COPY-OUTSIDE-SESSION')
  rmSync(f.attachmentPath)
  symlinkSync(outside, f.attachmentPath)
  const before = new Set(listSessions(workspaceRoot).map(session => session.id))
  await expect(f.sm.createSession(workspace.id, { branchFromSessionId: 'parent-symlink', branchFromMessageId: 'selected-reply', llmConnection: 'offline-pi' })).rejects.toThrow('Invalid branch attachment path')
  expect(new Set(listSessions(workspaceRoot).map(session => session.id))).toEqual(before)
})

test('expired derived previews do not block copying an intact attachment', async () => {
  const f = await setup('parent-preview')
  const parent = loadSession(workspaceRoot, 'parent-preview')!
  parent.messages[0]!.attachments![0]!.thumbnailPath = join(f.path, 'attachments', 'expired.png')
  await saveSessionStrict(parent)
  const child = await f.sm.createSession(workspace.id, { branchFromSessionId: 'parent-preview', branchFromMessageId: 'selected-reply', llmConnection: 'offline-pi' })
  const attachment = loadSession(workspaceRoot, child.id)!.messages[0]!.attachments![0]!
  expect(attachment.thumbnailPath).toBeUndefined()
  expect(readFileSync(attachment.storedPath, 'utf8')).toBe('ORIGINAL-ATTACHMENT-BYTES')
})
