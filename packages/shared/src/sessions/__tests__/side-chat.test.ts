import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { createSession, getOrCreateLatestSession, listSessions, loadSession } from '../storage'
import { isPrimaryNavigableSession, isStandaloneNavigableSession } from '../navigation'

describe('side chat session metadata', () => {
  let workspaceRoot: string

  beforeEach(() => {
    workspaceRoot = join(tmpdir(), `craft-side-chat-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    mkdirSync(workspaceRoot, { recursive: true })
  })

  afterEach(() => {
    if (existsSync(workspaceRoot)) rmSync(workspaceRoot, { recursive: true })
  })

  it('round-trips side-chat association and explicit empty-session runtime config', async () => {
    const created = await createSession(workspaceRoot, {
      name: 'Side chat',
      workingDirectory: '/tmp/operating-systems',
      permissionMode: 'allow-all',
      enabledSourceSlugs: ['books'],
      model: 'glm-4.5',
      llmConnection: 'zhipu',
      thinkingLevel: 'high',
      projectId: 'operating-systems',
      sideChatForSessionId: 'main-session',
      originMessageId: 'message-42',
    })

    const stored = loadSession(workspaceRoot, created.id)
    const listed = listSessions(workspaceRoot).find(session => session.id === created.id)

    expect(stored).toMatchObject({
      sideChatForSessionId: 'main-session',
      originMessageId: 'message-42',
      model: 'glm-4.5',
      llmConnection: 'zhipu',
      thinkingLevel: 'high',
      enabledSourceSlugs: ['books'],
    })
    expect(listed).toMatchObject({
      sideChatForSessionId: 'main-session',
      originMessageId: 'message-42',
      model: 'glm-4.5',
      llmConnection: 'zhipu',
      thinkingLevel: 'high',
    })
  })

  it('never restores a side chat as the primary latest session', async () => {
    const side = await createSession(workspaceRoot, {
      sideChatForSessionId: 'deleted-or-external-main',
    })

    const latest = await getOrCreateLatestSession(workspaceRoot)

    expect(latest.id).not.toBe(side.id)
    expect(latest.sideChatForSessionId).toBeUndefined()
  })

  it('persists an explicit no-working-directory choice for restart hydration', async () => {
    const created = await createSession(workspaceRoot, { workingDirectoryMode: 'none' })

    expect(loadSession(workspaceRoot, created.id)?.workingDirectoryMode).toBe('none')
    expect(listSessions(workspaceRoot)[0]?.workingDirectoryMode).toBe('none')
  })
})

describe('isPrimaryNavigableSession', () => {
  it('keeps ordinary sessions navigable', () => {
    expect(isPrimaryNavigableSession({ hidden: false })).toBe(true)
  })

  it('excludes hidden and side-chat sessions from primary navigation', () => {
    expect(isPrimaryNavigableSession({ hidden: true })).toBe(false)
    expect(isPrimaryNavigableSession({ sideChatForSessionId: 'main-session' })).toBe(false)
  })

  it('keeps Project sessions out of the standalone Sessions branch', () => {
    expect(isStandaloneNavigableSession({ hidden: false })).toBe(true)
    expect(isStandaloneNavigableSession({ projectId: 'operating-systems' })).toBe(false)
    expect(isStandaloneNavigableSession({ sideChatForSessionId: 'main-session' })).toBe(false)
  })
})
