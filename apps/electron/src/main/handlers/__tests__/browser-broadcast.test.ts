/**
 * Tests for browser handler broadcast + LIST.
 *
 * Workspace isolation contract: enforced renderer-side via
 * filterInstancesForWorkspace (which handles both the local and remote-mirror
 * workspace ids). Standalone/Agent events stay broadcast to all local
 * renderers, while window-owned learning browsers are routed and listed only
 * for their originating renderer.
 *
 * The reason: a renderer's transport-level workspaceId is always the *local*
 * Craft Agents window's id (set by updateClientWorkspace), but remote-bridged
 * tabs are stamped with the *remote* server's workspaceId. A workspace-scoped
 * broadcast or LIST filter would silently drop those events because the two
 * ids never match. The renderer knows both ids and filters correctly.
 */

import { describe, it, expect, beforeEach, mock } from 'bun:test'
import type { RpcServer } from '@craft-agent/server-core/transport'
import type { HandlerDeps } from '../handler-deps'
import type { BrowserInstanceInfo } from '@craft-agent/shared/protocol'
import { RPC_CHANNELS } from '../../../shared/types'
import type { BrowserSelectionAskPayload } from '../../../shared/browser-selection'

mock.module('electron', () => ({
  ipcMain: { handle: () => {}, on: () => {} },
}))

type HandlerFn = (...args: unknown[]) => unknown
type Push = { channel: string; target: unknown; args: unknown[] }

interface Recorder {
  server: RpcServer
  handlers: Map<string, HandlerFn>
  pushes: Push[]
}

function makeServer(): Recorder {
  const handlers = new Map<string, HandlerFn>()
  const pushes: Push[] = []
  const server: RpcServer = {
    handle(channel, handler) {
      handlers.set(channel, handler as HandlerFn)
    },
    push(channel, target, ...args) {
      pushes.push({ channel, target, args })
    },
    async invokeClient() {},
    hasClientCapability() { return false },
    findClientsWithCapability() { return [] },
  }
  return { server, handlers, pushes }
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
    boundSessionId: null,
    ownerType: 'manual',
    ownerSessionId: null,
    isVisible: true,
    agentControlActive: false,
    themeColor: null,
    workspaceId: null,
    ...overrides,
  }
}

function makeDeps(opts: {
  instances: BrowserInstanceInfo[]
  captureStateCb?: (cb: (info: BrowserInstanceInfo) => void) => void
  captureRemovedCb?: (cb: (id: string) => void) => void
  captureInteractedCb?: (cb: (id: string) => void) => void
  captureSelectionAskCb?: (
    cb: (payload: BrowserSelectionAskPayload, targetClientId: string | null) => void,
  ) => void
  clientIdForWebContents?: (webContentsId: number) => string | undefined
  onDestroy?: (id: string, requestingWebContentsId?: number | null) => void
  onAttach?: (id: string, hostWebContentsId: number, bounds: {
    x: number
    y: number
    width: number
    height: number
  }) => void
  onDetach?: (id: string, hostWebContentsId?: number) => void
  onUpdateBounds?: (id: string, bounds: {
    x: number
    y: number
    width: number
    height: number
  }, hostWebContentsId?: number) => void
}): HandlerDeps {
  return {
    sessionManager: {} as HandlerDeps['sessionManager'],
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
      getClientIdForWindow: opts.clientIdForWebContents ?? (() => undefined),
    } as HandlerDeps['windowManager'],
    browserPaneManager: {
      listInstances: () => opts.instances,
      destroyInstance: opts.onDestroy ?? (() => {}),
      onStateChange: (cb: (info: BrowserInstanceInfo) => void) => opts.captureStateCb?.(cb),
      onRemoved: (cb: (id: string) => void) => opts.captureRemovedCb?.(cb),
      onInteracted: (cb: (id: string) => void) => opts.captureInteractedCb?.(cb),
      onSelectionAsk: (
        cb: (payload: BrowserSelectionAskPayload, targetClientId: string | null) => void,
      ) => opts.captureSelectionAskCb?.(cb),
      attachToHost: opts.onAttach,
      detachFromHost: opts.onDetach,
      updateHostBounds: opts.onUpdateBounds,
    } as unknown as NonNullable<HandlerDeps['browserPaneManager']>,
    oauthFlowStore: {} as HandlerDeps['oauthFlowStore'],
  }
}

describe('browser handler — workspace filtering', () => {
  let recorder: Recorder

  beforeEach(() => {
    recorder = makeServer()
  })

  describe('STATE_CHANGED broadcast target', () => {
    it('always broadcasts to all renderers (workspace-aware-filtering happens in the renderer)', async () => {
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
      // Workspace-stamped instance broadcasts to all (renderer will filter).
      captured!(makeInstance('b-ws', { workspaceId: 'ws-1' }))
      expect(recorder.pushes).toHaveLength(1)
      expect(recorder.pushes[0].target).toEqual({ to: 'all' })

      // Unbound instance also broadcasts to all.
      captured!(makeInstance('b-unbound', { workspaceId: null }))
      expect(recorder.pushes).toHaveLength(2)
      expect(recorder.pushes[1].target).toEqual({ to: 'all' })
    })

    it('routes a window-owned learning browser only to its originating renderer', async () => {
      let captured: ((info: BrowserInstanceInfo) => void) | null = null
      const { registerBrowserHandlers } = await import('../browser')
      registerBrowserHandlers(
        recorder.server,
        makeDeps({
          instances: [],
          clientIdForWebContents: id => id === 42 ? 'client-origin' : undefined,
          captureStateCb: (cb) => { captured = cb },
        }),
      )

      const info = makeInstance('embedded-local', {
        hostMode: 'embedded',
        originWebContentsId: 42,
        embeddedHostWebContentsId: 42,
      })
      captured!(info)

      expect(recorder.pushes).toEqual([{
        channel: RPC_CHANNELS.browserPane.STATE_CHANGED,
        target: { to: 'client', clientId: 'client-origin' },
        args: [info],
      }])
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

  describe('selection Ask targeting', () => {
    it('pushes only to the originating renderer client', async () => {
      let captured: ((
        payload: BrowserSelectionAskPayload,
        targetClientId: string | null,
      ) => void) | null = null
      const { registerBrowserHandlers } = await import('../browser')
      registerBrowserHandlers(
        recorder.server,
        makeDeps({
          instances: [],
          captureSelectionAskCb: (cb) => { captured = cb },
        }),
      )

      const payload: BrowserSelectionAskPayload = {
        eventId: 'selection-1',
        target: 'main',
        instanceId: 'browser-1',
        reference: {
          kind: 'web-selection',
          url: 'https://example.com',
          title: 'Example',
          quote: 'selected',
          locator: { type: 'text-quote', exact: 'selected' },
        },
        boundSessionId: null,
        selectionSessionId: null,
        workspaceId: 'ws-1',
      }
      captured!(payload, 'client-origin')

      expect(recorder.pushes).toEqual([{
        channel: RPC_CHANNELS.browserPane.SELECTION_ASK,
        target: { to: 'client', clientId: 'client-origin' },
        args: [payload],
      }])
    })

    it('does not broadcast when the origin client cannot be resolved', async () => {
      let captured: ((
        payload: BrowserSelectionAskPayload,
        targetClientId: string | null,
      ) => void) | null = null
      const { registerBrowserHandlers } = await import('../browser')
      registerBrowserHandlers(
        recorder.server,
        makeDeps({
          instances: [],
          captureSelectionAskCb: (cb) => { captured = cb },
        }),
      )

      captured!({
        eventId: 'selection-2',
        target: 'main',
        instanceId: 'browser-2',
        reference: {
          kind: 'web-selection',
          url: 'https://example.com',
          title: 'Example',
          quote: 'selected',
          locator: { type: 'text-quote', exact: 'selected' },
        },
        boundSessionId: null,
        selectionSessionId: null,
        workspaceId: null,
      }, null)

      expect(recorder.pushes).toHaveLength(0)
    })
  })

  describe('embedded host routing', () => {
    it('uses the requesting renderer as the host and forwards surface bounds', async () => {
      const calls: unknown[] = []
      const { registerBrowserHandlers } = await import('../browser')
      registerBrowserHandlers(
        recorder.server,
        makeDeps({
          instances: [],
          onAttach: (...args) => calls.push(['attach', ...args]),
          onDetach: (...args) => calls.push(['detach', ...args]),
          onUpdateBounds: (...args) => calls.push(['bounds', ...args]),
        }),
      )
      const bounds = { x: 220, y: 60, width: 900, height: 700 }
      const context = { webContentsId: 42, workspaceId: 'ws-learning' }

      recorder.handlers.get(RPC_CHANNELS.browserPane.ATTACH)!(context, 'browser-1', bounds)
      recorder.handlers.get(RPC_CHANNELS.browserPane.UPDATE_BOUNDS)!(context, 'browser-1', bounds)
      recorder.handlers.get(RPC_CHANNELS.browserPane.DETACH)!(context, 'browser-1')

      expect(calls).toEqual([
        ['attach', 'browser-1', 42, bounds],
        ['bounds', 'browser-1', bounds, 42],
        ['detach', 'browser-1', 42],
      ])
    })

    it('rejects attach requests that do not originate from a local renderer', async () => {
      const { registerBrowserHandlers } = await import('../browser')
      registerBrowserHandlers(
        recorder.server,
        makeDeps({
          instances: [],
          onAttach: () => {},
        }),
      )

      expect(() => recorder.handlers.get(RPC_CHANNELS.browserPane.ATTACH)!(
        { webContentsId: null, workspaceId: 'ws-learning' },
        'browser-1',
        { x: 0, y: 0, width: 800, height: 700 },
      )).toThrow('requires a local Craft window')
    })

    it('forwards the requesting renderer when destroying an embedded browser', async () => {
      const calls: unknown[] = []
      const { registerBrowserHandlers } = await import('../browser')
      registerBrowserHandlers(
        recorder.server,
        makeDeps({
          instances: [],
          onDestroy: (...args) => calls.push(args),
        }),
      )

      recorder.handlers.get(RPC_CHANNELS.browserPane.DESTROY)!(
        { webContentsId: 42, workspaceId: 'ws-learning' },
        'browser-1',
      )

      expect(calls).toEqual([['browser-1', 42]])
    })
  })

  describe('LIST handler', () => {
    function callListHandler(
      workspaceId: string | null,
      webContentsId: number | null = null,
    ): BrowserInstanceInfo[] {
      const listChannel = Array.from(recorder.handlers.keys())
        .find((ch) => ch.endsWith(':list') && ch.includes('browser'))
      if (!listChannel) throw new Error('LIST handler not registered')
      const handler = recorder.handlers.get(listChannel)!
      return handler({ clientId: 'c1', workspaceId, webContentsId }) as BrowserInstanceInfo[]
    }

    it('returns ALL instances regardless of ctx.workspaceId (renderer filters)', async () => {
      // The server-side filter is intentionally absent: ctx.workspaceId is the
      // local Craft Agents window's workspace id, but remote-bridged tabs are
      // stamped with the remote server's workspace id. Filtering here would
      // hide those tabs. The renderer applies filterInstancesForWorkspace,
      // which accepts both ids.
      const instances = [
        makeInstance('local-tab', { workspaceId: 'local-ws' }),
        makeInstance('remote-tab', { workspaceId: 'remote-ws' }),
        makeInstance('unbound', { workspaceId: null }),
      ]
      const { registerBrowserHandlers } = await import('../browser')
      registerBrowserHandlers(recorder.server, makeDeps({ instances }))

      expect(callListHandler('local-ws').map((i) => i.id).sort()).toEqual([
        'local-tab',
        'remote-tab',
        'unbound',
      ])
      expect(callListHandler(null).map((i) => i.id).sort()).toEqual([
        'local-tab',
        'remote-tab',
        'unbound',
      ])
    })

    it('returns a window-owned learning browser only to its originating renderer', async () => {
      const instances = [
        makeInstance('owned-by-42', {
          hostMode: 'embedded',
          originWebContentsId: 42,
          embeddedHostWebContentsId: 42,
        }),
        makeInstance('owned-by-84', {
          hostMode: 'embedded',
          originWebContentsId: 84,
          embeddedHostWebContentsId: 84,
        }),
        makeInstance('released-agent', {
          originWebContentsId: 84,
          ownerSessionId: 'agent-session',
        }),
      ]
      const { registerBrowserHandlers } = await import('../browser')
      registerBrowserHandlers(recorder.server, makeDeps({ instances }))

      expect(callListHandler('ws-learning', 42).map(item => item.id).sort()).toEqual([
        'owned-by-42',
        'released-agent',
      ])
      expect(callListHandler('ws-learning', 84).map(item => item.id).sort()).toEqual([
        'owned-by-84',
        'released-agent',
      ])
    })
  })
})
