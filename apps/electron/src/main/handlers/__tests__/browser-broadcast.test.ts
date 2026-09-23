/**
 * Browser handler authorization and application-service tests.
 */

import { describe, it, expect, beforeEach, mock } from 'bun:test'
import {
  CLIENT_BROWSER_APPLICATION_INVOKE,
  type BrowserApplicationCapabilityRequest,
  type RpcServer,
} from '@craft-agent/server-core/transport'
import type { HandlerDeps } from '../handler-deps'
import type {
  BrowserInstanceInfo,
  Session,
} from '@craft-agent/shared/protocol'
import { RPC_CHANNELS } from '@craft-agent/shared/protocol'
import type { BrowserApplicationService } from '../../browser-pane-manager'
import { createBrowserApplicationRouter } from '../../browser-application-router'

mock.module('electron', () => ({
  ipcMain: { handle: () => {}, on: () => {} },
}))
mock.module('@craft-agent/shared/config', () => ({
  getWorkspaces: () => [
    { id: 'workspace-a', rootPath: '/tmp/workspace-a' },
    {
      id: 'local-remote',
      rootPath: '/tmp/local-remote',
      remoteServer: {
        url: 'wss://remote.example',
        token: 'token',
        remoteWorkspaceId: 'remote-workspace',
      },
    },
  ],
  getWorkspaceByNameOrId: (workspaceId: string) => {
    if (workspaceId === 'workspace-a') {
      return { id: workspaceId, rootPath: '/tmp/workspace-a' }
    }
    if (workspaceId === 'local-remote') {
      return {
        id: workspaceId,
        rootPath: '/tmp/local-remote',
        remoteServer: {
          url: 'wss://remote.example',
          token: 'token',
          remoteWorkspaceId: 'remote-workspace',
        },
      }
    }
    return null
  },
}))

type HandlerFn = (...args: unknown[]) => unknown
type Push = { channel: string; target: unknown; args: unknown[] }

interface Recorder {
  server: RpcServer
  handlers: Map<string, HandlerFn>
  pushes: Push[]
  invokeClient: ReturnType<typeof mock>
}

let capabilitySessions: Session[] = []

function makeServer(
  invokeClientImpl: (clientId: string, channel: string, request: unknown) => unknown = async (_clientId, channel, request) => {
    if (channel !== CLIENT_BROWSER_APPLICATION_INVOKE) return undefined
    const capability = request as BrowserApplicationCapabilityRequest
    if (capability.action === 'get-application-readiness') return { applicationReady: true }
    if (capability.action === 'get-project-context') {
      return {
        projectExists: capability.projectId === 'project-a',
        chatTargets: capabilitySessions
          .filter(session => (
            session.projectId === capability.projectId
            && session.hidden !== true
            && session.isArchived !== true
          ))
          .map(session => ({
            id: session.id,
            title: session.name?.trim() || session.preview?.trim() || session.id,
            noteTargetPath: session.projectNoteTargetPath ?? null,
          })),
      }
    }
    if (capability.action === 'create-chat-from-selection') {
      return { ok: true, sessionId: 'new-chat', targetTitle: 'New Chat' }
    }
    return { ok: true }
  },
): Recorder {
  const handlers = new Map<string, HandlerFn>()
  const pushes: Push[] = []
  const invokeClient = mock(async (clientId: string, channel: string, request: unknown) => {
    if (channel === CLIENT_BROWSER_APPLICATION_INVOKE) {
      const capability = request as BrowserApplicationCapabilityRequest
      if (capability.action === 'get-project-context' && capabilitySessions.length > 0) {
        return {
          projectExists: capability.projectId === 'project-a',
          chatTargets: capabilitySessions
            .filter(session => (
              session.projectId === capability.projectId
              && session.hidden !== true
              && session.isArchived !== true
            ))
            .map(session => ({
              id: session.id,
              title: session.name?.trim() || session.preview?.trim() || session.id,
              noteTargetPath: session.projectNoteTargetPath ?? null,
            })),
        }
      }
    }
    return invokeClientImpl(clientId, channel, request)
  })
  const server: RpcServer = {
    handle(channel, handler) {
      handlers.set(channel, handler as HandlerFn)
    },
    push(channel, target, ...args) {
      pushes.push({ channel, target, args })
    },
    invokeClient,
    hasClientCapability(_clientId, capability) {
      return capability === CLIENT_BROWSER_APPLICATION_INVOKE
    },
    findClientsWithCapability() {
      return capabilitySessions.length > 0 ? ['client-default'] : []
    },
  }
  return { server, handlers, pushes, invokeClient }
}

function makeInstance(id: string, overrides?: Partial<BrowserInstanceInfo>): BrowserInstanceInfo {
  return {
    id,
    url: 'https://example.com',
    title: 'Example',
    favicon: null,
    isLoading: false,
    canGoBack: false,
    canGoForward: false,
    targetSessionId: null,
    boundSessionId: null,
    ownerType: 'manual',
    ownerSessionId: null,
    isVisible: true,
    agentControlActive: false,
    themeColor: null,
    workspaceId: null,
    projectId: null,
    ...overrides,
  }
}

function makeDeps(opts: {
  instances: BrowserInstanceInfo[]
  captureStateCb?: (cb: (info: BrowserInstanceInfo) => void) => void
  captureRemovedCb?: (cb: (id: string) => void) => void
  captureInteractedCb?: (cb: (id: string) => void) => void
  captureApplicationService?: (service: BrowserApplicationService) => void
  captureCreate?: (id: string | undefined, options: unknown) => string
  captureReconcile?: (workspaceId: string, input: unknown) => void
  sessions?: Session[]
  clientIdForWindow?: (hostId: number) => string | undefined
  windowForWorkspace?: (workspaceId: string) => unknown
  focusOrCreateWindow?: (workspaceId: string) => unknown
  focusWindowForClient?: (clientId: string) => boolean
  workspaceForWindow?: (hostId: number) => string | undefined
}): HandlerDeps {
  capabilitySessions = opts.sessions ?? []
  return {
    sessionManager: {
      waitForInit: async () => {},
      getSessions: (workspaceId?: string) => (opts.sessions ?? [])
        .filter(session => !workspaceId || session.workspaceId === workspaceId),
      getSession: async (sessionId: string) => (
        (opts.sessions ?? []).find(session => session.id === sessionId) ?? null
      ),
    } as unknown as HandlerDeps['sessionManager'],
    platform: {
      appRootPath: '',
      resourcesPath: '',
      isPackaged: false,
      appVersion: '0.0.0-test',
      isDebugMode: false,
      logger: console,
      imageProcessor: {
        getMetadata: async () => null,
        process: async () => Buffer.from(''),
      },
    },
    windowManager: {
      getClientIdForWindow: opts.clientIdForWindow ?? (() => null),
      getWorkspaceForWindow: opts.workspaceForWindow ?? (() => null),
      getWindowByWorkspace: opts.windowForWorkspace ?? (() => null),
      focusOrCreateWindow: opts.focusOrCreateWindow ?? (() => null),
      focusWindowForClient: opts.focusWindowForClient ?? (() => false),
    } as HandlerDeps['windowManager'],
    browserPaneManager: {
      listInstances: () => opts.instances,
      createInstance: (id: string | undefined, options: unknown) => (
        opts.captureCreate?.(id, options) ?? id ?? 'browser-created'
      ),
      reconcileWorkspace: (workspaceId: string, input: unknown) => (
        opts.captureReconcile?.(workspaceId, input)
      ),
      onStateChange: (cb: (info: BrowserInstanceInfo) => void) => opts.captureStateCb?.(cb),
      onRemoved: (cb: (id: string) => void) => opts.captureRemovedCb?.(cb),
      onInteracted: (cb: (id: string) => void) => opts.captureInteractedCb?.(cb),
      setApplicationService: (service: BrowserApplicationService) => (
        opts.captureApplicationService?.(service)
      ),
    } as unknown as NonNullable<HandlerDeps['browserPaneManager']>,
    oauthFlowStore: {} as HandlerDeps['oauthFlowStore'],
  }
}

describe('browser handler — workspace filtering', () => {
  let recorder: Recorder

  beforeEach(() => {
    capabilitySessions = []
    recorder = makeServer()
  })

  describe('STATE_CHANGED broadcast target', () => {
    it('routes a Project-owned Browser to its canonical local Workspace', async () => {
      let captured: ((info: BrowserInstanceInfo) => void) | null = null
      const { registerBrowserHandlers } = await import('../browser')
      registerBrowserHandlers(
        recorder.server,
        makeDeps({
          instances: [],
          captureStateCb: (cb) => { captured = cb },
        }),
      )

      expect(captured).not.toBeNull()
      captured!(makeInstance('b-ws', { workspaceId: 'ws-1' }))
      expect(recorder.pushes).toHaveLength(1)
      expect(recorder.pushes[0].target).toEqual({ to: 'workspace', workspaceId: 'ws-1' })

      captured!(makeInstance('b-unbound', { workspaceId: null }))
      expect(recorder.pushes).toHaveLength(2)
      expect(recorder.pushes[1].target).toEqual({ to: 'all' })
    })
  })

  describe('REMOVED / INTERACTED stay broadcast-to-all', () => {
    it('REMOVED uses { to: "all" } even when the entry was workspace-scoped', async () => {
      let captured: ((id: string) => void) | null = null
      const { registerBrowserHandlers } = await import('../browser')
      registerBrowserHandlers(
        recorder.server,
        makeDeps({
          instances: [],
          captureRemovedCb: (cb) => { captured = cb },
        }),
      )

      captured!('b-removed')

      expect(recorder.pushes).toHaveLength(1)
      expect(recorder.pushes[0].target).toEqual({ to: 'all' })
      // Payload is id-only — workspaces that never saw the entry simply no-op.
      expect(recorder.pushes[0].args).toEqual(['b-removed'])
    })

    it('INTERACTED uses { to: "all" }', async () => {
      let captured: ((id: string) => void) | null = null
      const { registerBrowserHandlers } = await import('../browser')
      registerBrowserHandlers(
        recorder.server,
        makeDeps({
          instances: [],
          captureInteractedCb: (cb) => { captured = cb },
        }),
      )

      captured!('b-interacted')

      expect(recorder.pushes).toHaveLength(1)
      expect(recorder.pushes[0].target).toEqual({ to: 'all' })
    })
  })

  describe('LIST handler', () => {
    function callListHandler(workspaceId: string | null, projectId: string): BrowserInstanceInfo[] {
      const listChannel = Array.from(recorder.handlers.keys())
        .find((ch) => ch.endsWith(':list') && ch.includes('browser'))
      if (!listChannel) throw new Error('LIST handler not registered')
      const handler = recorder.handlers.get(listChannel)!
      return handler(
        { clientId: 'c1', workspaceId, webContentsId: null },
        projectId,
      ) as BrowserInstanceInfo[]
    }

    it('returns only instances in the authorized Workspace and Project', async () => {
      const instances = [
        makeInstance('project-a', { workspaceId: 'workspace-a', projectId: 'project-a' }),
        makeInstance('project-b', { workspaceId: 'workspace-a', projectId: 'project-b' }),
        makeInstance('other-workspace', { workspaceId: 'workspace-b', projectId: 'project-a' }),
        makeInstance('unbound', { workspaceId: null }),
      ]
      const { registerBrowserHandlers } = await import('../browser')
      registerBrowserHandlers(recorder.server, makeDeps({ instances }))

      expect(callListHandler('workspace-a', 'project-a').map((i) => i.id))
        .toEqual(['project-a'])
      expect(() => callListHandler(null, 'project-a'))
        .toThrow('owning Workspace')
    })
  })

  it('rejects an action against a Browser in another Project', async () => {
    const focus = mock(() => {})
    const { registerBrowserHandlers } = await import('../browser')
    registerBrowserHandlers(recorder.server, {
      ...makeDeps({
        instances: [makeInstance('project-b', {
          workspaceId: 'workspace-a',
          projectId: 'project-b',
        })],
      }),
      browserPaneManager: {
        ...makeDeps({ instances: [] }).browserPaneManager,
        listInstances: () => [makeInstance('project-b', {
          workspaceId: 'workspace-a',
          projectId: 'project-b',
        })],
        focus,
      } as unknown as NonNullable<HandlerDeps['browserPaneManager']>,
    })

    const handler = recorder.handlers.get(RPC_CHANNELS.browserPane.FOCUS)!
    expect(() => handler(
      { clientId: 'c1', workspaceId: 'workspace-a', webContentsId: null },
      'project-b',
      'project-a',
    )).toThrow('does not belong to the active Project')
    expect(focus).not.toHaveBeenCalled()
  })

  it('rejects a stale authoritative snapshot from another Workspace', async () => {
    const reconcile = mock(() => {})
    const { registerBrowserHandlers } = await import('../browser')
    registerBrowserHandlers(recorder.server, makeDeps({
      instances: [],
      captureReconcile: reconcile,
    }))

    const handler = recorder.handlers.get(RPC_CHANNELS.browserPane.RECONCILE)!
    expect(() => handler(
      { clientId: 'c1', workspaceId: 'workspace-a', webContentsId: null },
      { workspaceId: 'local-remote', projectIds: ['project-a'] },
    )).toThrow('another Workspace')
    expect(reconcile).not.toHaveBeenCalled()
  })

  describe('independent Browser application service', () => {
    const session = (
      id: string,
      projectId: string,
      overrides?: Partial<Session>,
    ): Session => ({
      id,
      workspaceId: 'workspace-a',
      workspaceName: 'Workspace A',
      projectId,
      name: id,
      lastMessageAt: 1,
      messages: [],
      isProcessing: false,
      ...overrides,
    })

    it('lists switchable Projects through the Browser application boundary', async () => {
      recorder = makeServer(async (_clientId, channel, request) => {
        if (channel !== CLIENT_BROWSER_APPLICATION_INVOKE) {
          throw new Error(`Unexpected capability: ${channel}`)
        }
        const capability = request as BrowserApplicationCapabilityRequest
        if (capability.action === 'list-project-targets') {
          return {
            projectTargets: [
              { id: 'project-a', title: 'Project A' },
              { id: 'project-b', title: 'Project B' },
            ],
          }
        }
        throw new Error(`Unexpected action: ${capability.action}`)
      })
      let service: BrowserApplicationService | null = null
      const { registerBrowserHandlers } = await import('../browser')
      registerBrowserHandlers(recorder.server, makeDeps({
        instances: [],
        sessions: [session('target', 'project-a')],
        captureApplicationService: value => { service = value },
      }))

      await expect(service!.listProjectTargets({ workspaceId: 'workspace-a' }))
        .resolves.toEqual([
          { id: 'project-a', title: 'Project A' },
          { id: 'project-b', title: 'Project B' },
        ])
    })

    it('offers only visible Chats from the Browser Project', async () => {
      let service: BrowserApplicationService | null = null
      const { registerBrowserHandlers } = await import('../browser')
      registerBrowserHandlers(recorder.server, makeDeps({
        instances: [],
        sessions: [
          session('target', 'project-a'),
          session('other-project', 'project-b'),
          session('hidden', 'project-a', { hidden: true }),
          session('archived', 'project-a', { isArchived: true }),
        ],
        captureApplicationService: value => { service = value },
      }))

      expect(await service!.listChatTargets({
        workspaceId: 'workspace-a',
        projectId: 'project-a',
      })).toEqual([{ id: 'target', title: 'target', noteTargetPath: null }])
    })

    it('validates a Browser target through the application routing boundary', async () => {
      const deps = makeDeps({
        instances: [],
        sessions: [
          session('target', 'project-a'),
          session('other-project', 'project-b'),
        ],
      })
      const router = createBrowserApplicationRouter({
        server: recorder.server,
        windowManager: deps.windowManager,
        resolveWorkspace: workspaceId => (
          workspaceId === 'workspace-a' ? { id: workspaceId } : null
        ),
      })

      await expect(router.validateProjectTarget({
        workspaceId: 'workspace-a',
        projectId: 'project-a',
        targetSessionId: 'target',
        preferredClientId: 'client-default',
      })).resolves.toBeUndefined()
      await expect(router.validateProjectTarget({
        workspaceId: 'workspace-a',
        projectId: 'project-a',
        targetSessionId: 'other-project',
        preferredClientId: 'client-default',
      })).rejects.toThrow('Target Chat is not available in this Project')
    })

    it('rejects creating a Browser with a target Chat from another Project', async () => {
      const create = mock(() => 'browser-created')
      const { registerBrowserHandlers } = await import('../browser')
      registerBrowserHandlers(recorder.server, makeDeps({
        instances: [],
        sessions: [session('other-project', 'project-b')],
        captureCreate: create,
      }))

      const handler = recorder.handlers.get(RPC_CHANNELS.browserPane.CREATE)!
      await expect(handler(
        { clientId: 'c1', workspaceId: 'workspace-a', webContentsId: null },
        { projectId: 'project-a', targetSessionId: 'other-project' },
      )).rejects.toThrow('Target Chat is not available in this Project')
      expect(create).not.toHaveBeenCalled()
    })

    it('uses the active remote Workspace client for Project and Chat data', async () => {
      recorder = makeServer(async (_clientId, channel, request) => {
        if (channel !== CLIENT_BROWSER_APPLICATION_INVOKE) {
          throw new Error(`Unexpected capability: ${channel}`)
        }
        const capability = request as BrowserApplicationCapabilityRequest
        if (capability.action === 'get-project-context') {
          return {
            projectExists: true,
            chatTargets: [{ id: 'remote-chat', title: 'Remote Chat', noteTargetPath: null }],
          }
        }
        if (capability.action === 'get-application-readiness') {
          return { applicationReady: true }
        }
        if (capability.action === 'create-chat-from-selection') {
          return { ok: true, sessionId: 'remote-new', targetTitle: 'New Chat' }
        }
        return { ok: true }
      })
      const create = mock(() => 'remote-browser')
      let service: BrowserApplicationService | null = null
      const { registerBrowserHandlers } = await import('../browser')
      registerBrowserHandlers(recorder.server, makeDeps({
        instances: [],
        captureCreate: create,
        captureApplicationService: value => { service = value },
        clientIdForWindow: () => 'remote-client',
        windowForWorkspace: () => ({
          webContents: { id: 42 },
          isDestroyed: () => false,
          isMinimized: () => false,
          show: () => {},
          focus: () => {},
        }),
      }))

      const createHandler = recorder.handlers.get(RPC_CHANNELS.browserPane.CREATE)!
      await expect(createHandler(
        { clientId: 'remote-client', workspaceId: 'local-remote', webContentsId: 42 },
        { projectId: 'project-a', targetSessionId: 'remote-chat' },
      )).resolves.toBe('remote-browser')
      expect(create).toHaveBeenCalledWith(undefined, expect.objectContaining({
        workspaceId: 'local-remote',
        projectId: 'project-a',
        targetSessionId: 'remote-chat',
      }))

      await expect(service!.listChatTargets({
        workspaceId: 'local-remote',
        projectId: 'project-a',
      })).resolves.toEqual([{ id: 'remote-chat', title: 'Remote Chat', noteTargetPath: null }])

      await expect(service!.openChat({
        workspaceId: 'local-remote',
        projectId: 'project-a',
        sessionId: 'remote-chat',
      })).resolves.toBeUndefined()
      expect(recorder.invokeClient).toHaveBeenCalledWith(
        'remote-client',
        CLIENT_BROWSER_APPLICATION_INVOKE,
        {
          v: 1,
          action: 'open-chat',
          workspaceId: 'local-remote',
          projectId: 'project-a',
          sessionId: 'remote-chat',
        },
      )

      await expect(service!.applySelection({
        requestId: 'request-add-chat',
        action: 'add-chat',
        workspaceId: 'local-remote',
        projectId: 'project-a',
        sessionId: 'remote-chat',
        source: {
          url: 'https://example.com',
          title: 'Example',
          quote: 'selected',
          locator: { type: 'web-text-quote', exact: 'selected' },
        },
      })).resolves.toEqual({
        sessionId: 'remote-chat',
        targetTitle: 'Remote Chat',
        noteTargetPath: null,
      })
      expect(recorder.invokeClient).toHaveBeenCalledWith(
        'remote-client',
        CLIENT_BROWSER_APPLICATION_INVOKE,
        expect.objectContaining({ action: 'add-selection-to-chat', sessionId: 'remote-chat' }),
      )

      await expect(service!.applySelection({
        requestId: 'request-new-chat',
        action: 'new-chat',
        workspaceId: 'local-remote',
        projectId: 'project-a',
        sessionId: null,
        source: {
          url: 'https://example.com',
          title: 'Example',
          quote: 'selected',
          locator: { type: 'web-text-quote', exact: 'selected' },
        },
      })).resolves.toEqual({
        sessionId: 'remote-new',
        targetTitle: 'New Chat',
        noteTargetPath: null,
      })
    })

    it('creates a Chat without loading existing Chat context', async () => {
      let projectContextReads = 0
      recorder = makeServer(async (_clientId, channel, request) => {
        if (channel !== CLIENT_BROWSER_APPLICATION_INVOKE) {
          throw new Error(`Unexpected capability: ${channel}`)
        }
        const capability = request as BrowserApplicationCapabilityRequest
        if (capability.action === 'get-application-readiness') {
          return { applicationReady: true }
        }
        if (capability.action === 'get-project-context') {
          projectContextReads += 1
          return new Promise(() => {})
        }
        if (capability.action === 'create-chat-from-selection') {
          return { ok: true, sessionId: 'new-chat', targetTitle: 'New Chat' }
        }
        throw new Error(`Unexpected action: ${capability.action}`)
      })
      let service: BrowserApplicationService | null = null
      const { registerBrowserHandlers } = await import('../browser')
      registerBrowserHandlers(recorder.server, makeDeps({
        instances: [],
        captureApplicationService: value => { service = value },
        clientIdForWindow: () => 'local-client',
        windowForWorkspace: () => ({
          webContents: { id: 42 },
          isDestroyed: () => false,
        }),
      }))

      const result = await Promise.race([
        service!.applySelection({
          requestId: 'request-new-chat-without-context',
          action: 'new-chat',
          workspaceId: 'workspace-a',
          projectId: 'project-a',
          sessionId: null,
          source: {
            url: 'https://example.com',
            title: 'Example',
            quote: 'selected',
            locator: { type: 'web-text-quote', exact: 'selected' },
          },
        }),
        Bun.sleep(100).then(() => ({ timeout: true as const })),
      ])

      expect(result).toEqual({
        sessionId: 'new-chat',
        targetTitle: 'New Chat',
        noteTargetPath: null,
      })
      expect(projectContextReads).toBe(0)
    })

    it('opens the Note picker without loading existing Chat context', async () => {
      let projectContextReads = 0
      recorder = makeServer(async (_clientId, channel, request) => {
        if (channel !== CLIENT_BROWSER_APPLICATION_INVOKE) {
          throw new Error(`Unexpected capability: ${channel}`)
        }
        const capability = request as BrowserApplicationCapabilityRequest
        if (capability.action === 'get-application-readiness') {
          return { applicationReady: true }
        }
        if (capability.action === 'get-project-context') {
          projectContextReads += 1
          return new Promise(() => {})
        }
        if (capability.action === 'add-selection-note') {
          return { ok: true, noteTargetPath: 'notes/research.md', sessionId: null }
        }
        throw new Error(`Unexpected action: ${capability.action}`)
      })
      const show = mock(() => {})
      const focus = mock(() => {})
      const focusWindowForClient = mock(() => true)
      let service: BrowserApplicationService | null = null
      const { registerBrowserHandlers } = await import('../browser')
      registerBrowserHandlers(recorder.server, makeDeps({
        instances: [],
        captureApplicationService: value => { service = value },
        clientIdForWindow: () => 'local-client',
        windowForWorkspace: () => ({
          webContents: { id: 42 },
          isDestroyed: () => false,
          isMinimized: () => false,
          show,
          focus,
        }),
        focusWindowForClient,
      }))

      const result = await Promise.race([
        service!.applySelection({
          requestId: 'request-choose-note-without-context',
          action: 'choose-note-target',
          workspaceId: 'workspace-a',
          projectId: 'project-a',
          sessionId: null,
          source: {
            url: 'https://example.com',
            title: 'Example',
            quote: 'selected',
            locator: { type: 'web-text-quote', exact: 'selected' },
          },
        }),
        Bun.sleep(100).then(() => ({ timeout: true as const })),
      ])

      expect(result).toEqual({
        sessionId: null,
        targetTitle: null,
        noteTargetPath: 'notes/research.md',
      })
      expect(projectContextReads).toBe(0)
      expect(recorder.invokeClient).toHaveBeenCalledWith(
        'local-client',
        CLIENT_BROWSER_APPLICATION_INVOKE,
        expect.objectContaining({
          action: 'add-selection-note',
          mode: 'choose-target',
          sessionId: null,
        }),
        expect.objectContaining({ timeoutMs: null }),
      )
      expect(focusWindowForClient).toHaveBeenCalledWith('local-client')
      expect(show).not.toHaveBeenCalled()
      expect(focus).not.toHaveBeenCalled()
    })

    it('restores a Workspace window before applying a Browser selection', async () => {
      let readinessChecks = 0
      recorder = makeServer(async (_clientId, channel, request) => {
        if (channel !== CLIENT_BROWSER_APPLICATION_INVOKE) {
          throw new Error(`Unexpected capability: ${channel}`)
        }
        const capability = request as BrowserApplicationCapabilityRequest
        if (capability.action === 'get-application-readiness') {
          readinessChecks += 1
          return { applicationReady: readinessChecks >= 2 }
        }
        if (capability.action === 'add-selection-to-chat') return { ok: true }
        throw new Error(`Unexpected action: ${capability.action}`)
      })
      const restoredWindow = {
        webContents: { id: 84 },
        isDestroyed: () => false,
      }
      const focusOrCreateWindow = mock(() => restoredWindow)
      recorder.server.findClientsWithCapability = () => []
      let service: BrowserApplicationService | null = null
      const { registerBrowserHandlers } = await import('../browser')
      registerBrowserHandlers(recorder.server, makeDeps({
        instances: [],
        sessions: [session('target', 'project-a')],
        captureApplicationService: value => { service = value },
        windowForWorkspace: () => null,
        focusOrCreateWindow,
        clientIdForWindow: hostId => hostId === 84 ? 'restored-client' : undefined,
      }))

      await expect(service!.applySelection({
        requestId: 'request-restored-chat',
        action: 'add-chat',
        workspaceId: 'workspace-a',
        projectId: 'project-a',
        sessionId: 'target',
        source: {
          url: 'https://example.com',
          title: 'Example',
          quote: 'selected',
          locator: { type: 'web-text-quote', exact: 'selected' },
        },
      })).resolves.toEqual({
        sessionId: 'target',
        targetTitle: 'target',
        noteTargetPath: null,
      })
      expect(focusOrCreateWindow).toHaveBeenCalledWith('workspace-a')
      expect(readinessChecks).toBe(2)
      expect(recorder.invokeClient).toHaveBeenCalledWith(
        'restored-client',
        CLIENT_BROWSER_APPLICATION_INVOKE,
        expect.objectContaining({ action: 'add-selection-to-chat' }),
      )
    })

    it('adds a Chat reference through one ready window in the Workspace', async () => {
      recorder = makeServer(async (_clientId, channel, request) => {
        if (channel !== CLIENT_BROWSER_APPLICATION_INVOKE) {
          throw new Error(`Unexpected capability: ${channel}`)
        }
        const capability = request as BrowserApplicationCapabilityRequest
        if (capability.action === 'get-application-readiness') {
          return { applicationReady: true }
        }
        if (capability.action === 'add-selection-to-chat') return { ok: true }
        throw new Error(`Unexpected action: ${capability.action}`)
      })
      recorder.server.findClientsWithCapability = (_capability, options) => (
        options?.workspaceId === 'workspace-a' ? ['client-a', 'client-b'] : []
      )
      let service: BrowserApplicationService | null = null
      const { registerBrowserHandlers } = await import('../browser')
      registerBrowserHandlers(recorder.server, makeDeps({
        instances: [],
        sessions: [session('target', 'project-a')],
        captureApplicationService: value => { service = value },
      }))

      await expect(service!.applySelection({
        requestId: 'request-ready-chat',
        action: 'add-chat',
        workspaceId: 'workspace-a',
        projectId: 'project-a',
        sessionId: 'target',
        source: {
          url: 'https://example.com',
          title: 'Example',
          quote: 'selected',
          locator: { type: 'web-text-quote', exact: 'selected' },
        },
      })).resolves.toEqual({
        sessionId: 'target',
        targetTitle: 'target',
        noteTargetPath: null,
      })
      const addCalls = recorder.invokeClient.mock.calls.filter(call => (
        (call[2] as BrowserApplicationCapabilityRequest).action === 'add-selection-to-chat'
      ))
      expect(addCalls).toEqual([[
        'client-a',
        CLIENT_BROWSER_APPLICATION_INVOKE,
        expect.objectContaining({ action: 'add-selection-to-chat' }),
      ]])
    })

    it('does not wait for an unresponsive window when another window is ready', async () => {
      recorder = makeServer(async (clientId, channel, request) => {
        if (channel !== CLIENT_BROWSER_APPLICATION_INVOKE) {
          throw new Error(`Unexpected capability: ${channel}`)
        }
        const capability = request as BrowserApplicationCapabilityRequest
        if (capability.action === 'get-application-readiness') {
          if (clientId === 'hung-client') return new Promise(() => {})
          return { applicationReady: true }
        }
        if (capability.action === 'add-selection-to-chat') return { ok: true }
        throw new Error(`Unexpected action: ${capability.action}`)
      })
      recorder.server.findClientsWithCapability = () => ['hung-client', 'ready-client']
      let service: BrowserApplicationService | null = null
      const { registerBrowserHandlers } = await import('../browser')
      registerBrowserHandlers(recorder.server, makeDeps({
        instances: [],
        sessions: [session('target', 'project-a')],
        captureApplicationService: value => { service = value },
      }))

      await expect(service!.applySelection({
        requestId: 'request-fallback-chat',
        action: 'add-chat',
        workspaceId: 'workspace-a',
        projectId: 'project-a',
        sessionId: 'target',
        source: {
          url: 'https://example.com',
          title: 'Example',
          quote: 'selected',
          locator: { type: 'web-text-quote', exact: 'selected' },
        },
      })).resolves.toEqual(expect.objectContaining({ sessionId: 'target' }))
      expect(recorder.invokeClient).toHaveBeenCalledWith(
        'ready-client',
        CLIENT_BROWSER_APPLICATION_INVOKE,
        expect.objectContaining({ action: 'add-selection-to-chat' }),
      )
    })

    it('does not wait for an unresponsive origin window when another window is ready', async () => {
      recorder = makeServer(async (clientId, channel, request) => {
        if (channel !== CLIENT_BROWSER_APPLICATION_INVOKE) {
          throw new Error(`Unexpected capability: ${channel}`)
        }
        const capability = request as BrowserApplicationCapabilityRequest
        if (capability.action === 'get-project-context') {
          return {
            projectExists: true,
            chatTargets: [{ id: 'target', title: 'target', noteTargetPath: null }],
          }
        }
        if (capability.action === 'get-application-readiness') {
          if (clientId === 'hung-origin') return new Promise(() => {})
          return { applicationReady: true }
        }
        if (capability.action === 'add-selection-to-chat') return { ok: true }
        throw new Error(`Unexpected action: ${capability.action}`)
      })
      recorder.server.findClientsWithCapability = () => ['hung-origin', 'ready-client']
      let service: BrowserApplicationService | null = null
      const { registerBrowserHandlers } = await import('../browser')
      registerBrowserHandlers(recorder.server, makeDeps({
        instances: [],
        captureApplicationService: value => { service = value },
        clientIdForWindow: hostId => hostId === 101 ? 'hung-origin' : undefined,
        workspaceForWindow: hostId => hostId === 101 ? 'workspace-a' : undefined,
      }))

      await expect(service!.applySelection({
        requestId: 'request-origin-fallback',
        action: 'add-chat',
        workspaceId: 'workspace-a',
        projectId: 'project-a',
        sessionId: 'target',
        originWebContentsId: 101,
        source: {
          url: 'https://example.com',
          title: 'Example',
          quote: 'selected',
          locator: { type: 'web-text-quote', exact: 'selected' },
        },
      })).resolves.toEqual(expect.objectContaining({ sessionId: 'target' }))
      expect(recorder.invokeClient).toHaveBeenCalledWith(
        'ready-client',
        CLIENT_BROWSER_APPLICATION_INVOKE,
        expect.objectContaining({ action: 'add-selection-to-chat' }),
      )
    })

    it('keeps awaiting the only origin client after the preferred grace period', async () => {
      const calls = new Map<string, number>()
      recorder = makeServer(async (clientId, channel, request) => {
        if (channel !== CLIENT_BROWSER_APPLICATION_INVOKE || clientId !== 'only-client') {
          throw new Error('Unexpected capability client')
        }
        const capability = request as BrowserApplicationCapabilityRequest
        calls.set(capability.action, (calls.get(capability.action) ?? 0) + 1)
        if (
          capability.action === 'get-project-context'
          || capability.action === 'get-application-readiness'
        ) {
          await Bun.sleep(275)
        }
        if (capability.action === 'get-project-context') {
          return {
            projectExists: true,
            chatTargets: [{ id: 'target', title: 'target', noteTargetPath: null }],
          }
        }
        if (capability.action === 'get-application-readiness') return { applicationReady: true }
        if (capability.action === 'add-selection-to-chat') return { ok: true }
        throw new Error(`Unexpected action: ${capability.action}`)
      })
      recorder.server.findClientsWithCapability = () => ['only-client']
      let service: BrowserApplicationService | null = null
      const { registerBrowserHandlers } = await import('../browser')
      registerBrowserHandlers(recorder.server, makeDeps({
        instances: [],
        captureApplicationService: value => { service = value },
        clientIdForWindow: hostId => hostId === 102 ? 'only-client' : undefined,
        workspaceForWindow: hostId => hostId === 102 ? 'workspace-a' : undefined,
      }))

      await expect(service!.applySelection({
        requestId: 'request-slow-only-origin',
        action: 'add-chat',
        workspaceId: 'workspace-a',
        projectId: 'project-a',
        sessionId: 'target',
        originWebContentsId: 102,
        source: {
          url: 'https://example.com',
          title: 'Example',
          quote: 'selected',
          locator: { type: 'web-text-quote', exact: 'selected' },
        },
      })).resolves.toEqual(expect.objectContaining({ sessionId: 'target' }))
      expect(calls.get('get-project-context')).toBe(1)
      expect(calls.get('get-application-readiness')).toBe(1)
      expect(calls.get('add-selection-to-chat')).toBe(1)
    })

    it('focuses the exact ready renderer that owns the shared Note picker', async () => {
      recorder = makeServer(async (clientId, channel, request) => {
        if (channel !== CLIENT_BROWSER_APPLICATION_INVOKE) {
          throw new Error(`Unexpected capability: ${channel}`)
        }
        const capability = request as BrowserApplicationCapabilityRequest
        if (capability.action === 'get-application-readiness') {
          if (clientId === 'hung-client') return new Promise(() => {})
          return { applicationReady: true }
        }
        if (capability.action === 'add-selection-note') {
          return { ok: true, noteTargetPath: 'notes/ready.md', sessionId: 'target' }
        }
        throw new Error(`Unexpected action: ${capability.action}`)
      })
      recorder.server.findClientsWithCapability = () => ['hung-client', 'ready-client']
      const focusWindowForClient = mock(() => true)
      let service: BrowserApplicationService | null = null
      const { registerBrowserHandlers } = await import('../browser')
      registerBrowserHandlers(recorder.server, makeDeps({
        instances: [],
        sessions: [session('target', 'project-a')],
        captureApplicationService: value => { service = value },
        focusWindowForClient,
      }))

      await expect(service!.applySelection({
        requestId: 'request-ready-note',
        action: 'choose-note-target',
        workspaceId: 'workspace-a',
        projectId: 'project-a',
        sessionId: 'target',
        source: {
          url: 'https://example.com',
          title: 'Example',
          quote: 'selected',
          locator: { type: 'web-text-quote', exact: 'selected' },
        },
      })).resolves.toEqual(expect.objectContaining({ noteTargetPath: 'notes/ready.md' }))
      expect(focusWindowForClient).toHaveBeenCalledWith('ready-client')
      expect(recorder.invokeClient).toHaveBeenCalledWith(
        'ready-client',
        CLIENT_BROWSER_APPLICATION_INVOKE,
        expect.objectContaining({ action: 'add-selection-note' }),
        expect.objectContaining({ timeoutMs: null }),
      )
    })

    it('waits for a restored Workspace client before opening the target Chat', async () => {
      const restoredWindow = {
        webContents: { id: 91 },
        isDestroyed: () => false,
        isMinimized: () => false,
        show: mock(() => {}),
        focus: mock(() => {}),
      }
      const focusOrCreateWindow = mock(() => restoredWindow)
      recorder.server.findClientsWithCapability = () => []
      let service: BrowserApplicationService | null = null
      const { registerBrowserHandlers } = await import('../browser')
      registerBrowserHandlers(recorder.server, makeDeps({
        instances: [],
        sessions: [session('target', 'project-a')],
        captureApplicationService: value => { service = value },
        windowForWorkspace: () => null,
        focusOrCreateWindow,
        clientIdForWindow: hostId => hostId === 91 ? 'restored-client' : undefined,
      }))

      await expect(service!.openChat({
        workspaceId: 'workspace-a',
        projectId: 'project-a',
        sessionId: 'target',
      })).resolves.toBeUndefined()

      expect(focusOrCreateWindow).toHaveBeenCalledWith('workspace-a')
      expect(recorder.invokeClient).toHaveBeenCalledWith(
        'restored-client',
        CLIENT_BROWSER_APPLICATION_INVOKE,
        {
          v: 1,
          action: 'open-chat',
          workspaceId: 'workspace-a',
          projectId: 'project-a',
          sessionId: 'target',
        },
      )
    })
  })
})
