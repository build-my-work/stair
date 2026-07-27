import {
  RPC_CHANNELS,
  type BrowserPaneCreateOptions,
  type BrowserEmptyStateLaunchPayload,
  type BrowserPaneHostBounds,
} from '../../shared/types'
import type { BrowserScreenshotOptions } from '../browser-pane-manager'
import { pushTyped, type RpcServer } from '@craft-agent/server-core/transport'
import type { WebSelectionReference } from '@craft-agent/core/types'
import type { HandlerDeps } from './handler-deps'

export const HANDLED_CHANNELS = [
  RPC_CHANNELS.browserPane.CREATE,
  RPC_CHANNELS.browserPane.DESTROY,
  RPC_CHANNELS.browserPane.LIST,
  RPC_CHANNELS.browserPane.NAVIGATE,
  RPC_CHANNELS.browserPane.GO_BACK,
  RPC_CHANNELS.browserPane.GO_FORWARD,
  RPC_CHANNELS.browserPane.RELOAD,
  RPC_CHANNELS.browserPane.STOP,
  RPC_CHANNELS.browserPane.FOCUS,
  RPC_CHANNELS.browserPane.ATTACH,
  RPC_CHANNELS.browserPane.DETACH,
  RPC_CHANNELS.browserPane.UPDATE_BOUNDS,
  RPC_CHANNELS.browserPane.LAUNCH,
  RPC_CHANNELS.browserPane.SNAPSHOT,
  RPC_CHANNELS.browserPane.CLICK,
  RPC_CHANNELS.browserPane.FILL,
  RPC_CHANNELS.browserPane.SELECT,
  RPC_CHANNELS.browserPane.SCREENSHOT,
  RPC_CHANNELS.browserPane.EVALUATE,
  RPC_CHANNELS.browserPane.SCROLL,
  RPC_CHANNELS.browserPane.REVEAL_SELECTION,
] as const

export function registerBrowserHandlers(server: RpcServer, deps: HandlerDeps): void {
  const { browserPaneManager, platform, windowManager } = deps
  if (!browserPaneManager) return

  const isWindowOwnedLearningBrowser = (
    info: ReturnType<typeof browserPaneManager.listInstances>[number],
  ): boolean => (
    info.ownerType === 'manual'
    && info.ownerSessionId === null
    && typeof info.originWebContentsId === 'number'
  )

  server.handle(RPC_CHANNELS.browserPane.CREATE, (ctx, input?: string | BrowserPaneCreateOptions) => {
    // Stamp the window with the requester's workspace so manual UI-opened
    // tabs stay scoped to the workspace where the user clicked. If
    // ctx.workspaceId is null (no workspace context — e.g. CLI / agent
    // harness), the window stays globally visible (legacy behavior).
    const workspaceId = ctx.workspaceId ?? null
    const originWebContentsId = ctx.webContentsId ?? null

    if (typeof input === 'string') {
      return browserPaneManager.createInstance(input, { workspaceId, originWebContentsId })
    }

    if (input?.bindToSessionId) {
      return browserPaneManager.createForSession(input.bindToSessionId, {
        show: input.show ?? false,
        workspaceId,
        originWebContentsId,
      })
    }

    return browserPaneManager.createInstance(input?.id, {
      show: input?.show,
      workspaceId,
      originWebContentsId,
      selectionSessionId: input?.selectionSessionId ?? null,
    })
  })

  server.handle(RPC_CHANNELS.browserPane.DESTROY, (ctx, id: string) => {
    browserPaneManager.destroyInstance(id, ctx.webContentsId ?? null)
  })

  server.handle(RPC_CHANNELS.browserPane.LIST, (ctx) => {
    // Workspace isolation remains renderer-side so remote-mirror workspace ids
    // keep working. Window-owned learning browsers are the exception: a native
    // BrowserView cannot be attached to or destroyed from a sibling Craft
    // window, so only its originating renderer may list it.
    return browserPaneManager.listInstances().filter(info => (
      !isWindowOwnedLearningBrowser(info)
      || info.originWebContentsId === ctx.webContentsId
    ))
  })

  server.handle(RPC_CHANNELS.browserPane.NAVIGATE, async (_ctx, id: string, url: string) => {
    try {
      return await browserPaneManager.navigate(id, url)
    } catch (err) {
      platform.logger.error(`[browser-pane] navigate failed for ${id}:`, err)
      throw err
    }
  })

  server.handle(RPC_CHANNELS.browserPane.GO_BACK, async (_ctx, id: string) => {
    try {
      return await browserPaneManager.goBack(id)
    } catch (err) {
      platform.logger.error(`[browser-pane] goBack failed for ${id}:`, err)
      throw err
    }
  })

  server.handle(RPC_CHANNELS.browserPane.GO_FORWARD, async (_ctx, id: string) => {
    try {
      return await browserPaneManager.goForward(id)
    } catch (err) {
      platform.logger.error(`[browser-pane] goForward failed for ${id}:`, err)
      throw err
    }
  })

  server.handle(RPC_CHANNELS.browserPane.RELOAD, (_ctx, id: string) => {
    browserPaneManager.reload(id)
  })

  server.handle(RPC_CHANNELS.browserPane.STOP, (_ctx, id: string) => {
    browserPaneManager.stop(id)
  })

  server.handle(RPC_CHANNELS.browserPane.FOCUS, (_ctx, id: string) => {
    browserPaneManager.focus(id)
  })

  server.handle(
    RPC_CHANNELS.browserPane.ATTACH,
    (ctx, id: string, bounds: BrowserPaneHostBounds) => {
      if (!ctx.webContentsId) {
        throw new Error('Embedding a browser requires a local Craft window')
      }
      if (!browserPaneManager.attachToHost) {
        throw new Error('Embedded browser hosting is unavailable in this process')
      }
      browserPaneManager.attachToHost(id, ctx.webContentsId, bounds)
    },
  )

  server.handle(RPC_CHANNELS.browserPane.DETACH, (ctx, id: string) => {
    if (!ctx.webContentsId) {
      throw new Error('Detaching an embedded browser requires a local Craft window')
    }
    if (!browserPaneManager.detachFromHost) {
      throw new Error('Embedded browser hosting is unavailable in this process')
    }
    browserPaneManager.detachFromHost(id, ctx.webContentsId)
  })

  server.handle(
    RPC_CHANNELS.browserPane.UPDATE_BOUNDS,
    (ctx, id: string, bounds: BrowserPaneHostBounds) => {
      if (!ctx.webContentsId) {
        throw new Error('Resizing an embedded browser requires a local Craft window')
      }
      if (!browserPaneManager.updateHostBounds) {
        throw new Error('Embedded browser hosting is unavailable in this process')
      }
      browserPaneManager.updateHostBounds(id, bounds, ctx.webContentsId)
    },
  )

  server.handle(RPC_CHANNELS.browserPane.LAUNCH, async (ctx, payload: BrowserEmptyStateLaunchPayload) => {
    try {
      return await browserPaneManager.handleEmptyStateLaunchFromRenderer(ctx.webContentsId!, payload)
    } catch (err) {
      platform.logger.error('[browser-pane] empty-state launch IPC failed:', err)
      throw err
    }
  })

  server.handle(RPC_CHANNELS.browserPane.SNAPSHOT, async (_ctx, id: string) => {
    try {
      return await browserPaneManager.getAccessibilitySnapshot(id)
    } catch (err) {
      platform.logger.error(`[browser-pane] snapshot failed for ${id}:`, err)
      throw err
    }
  })

  server.handle(RPC_CHANNELS.browserPane.CLICK, async (_ctx, id: string, ref: string) => {
    try {
      return await browserPaneManager.clickElement(id, ref)
    } catch (err) {
      platform.logger.error(`[browser-pane] click failed for ${id} ref=${ref}:`, err)
      throw err
    }
  })

  server.handle(RPC_CHANNELS.browserPane.FILL, async (_ctx, id: string, ref: string, value: string) => {
    try {
      return await browserPaneManager.fillElement(id, ref, value)
    } catch (err) {
      platform.logger.error(`[browser-pane] fill failed for ${id} ref=${ref}:`, err)
      throw err
    }
  })

  server.handle(RPC_CHANNELS.browserPane.SELECT, async (_ctx, id: string, ref: string, value: string) => {
    try {
      return await browserPaneManager.selectOption(id, ref, value)
    } catch (err) {
      platform.logger.error(`[browser-pane] select failed for ${id} ref=${ref}:`, err)
      throw err
    }
  })

  server.handle(RPC_CHANNELS.browserPane.SCREENSHOT, async (_ctx, id: string, options?: BrowserScreenshotOptions) => {
    try {
      const result = await browserPaneManager.screenshot(id, options)
      return {
        base64: result.imageBuffer.toString('base64'),
        imageFormat: result.imageFormat,
        metadata: result.metadata,
      }
    } catch (err) {
      platform.logger.error(`[browser-pane] screenshot failed for ${id}:`, err)
      throw err
    }
  })

  server.handle(RPC_CHANNELS.browserPane.EVALUATE, async (_ctx, id: string, expression: string) => {
    try {
      return await browserPaneManager.evaluate(id, expression)
    } catch (err) {
      platform.logger.error(`[browser-pane] evaluate failed for ${id}:`, err)
      throw err
    }
  })

  server.handle(RPC_CHANNELS.browserPane.SCROLL, async (_ctx, id: string, direction: string, amount?: number) => {
    const validDirections = ['up', 'down', 'left', 'right']
    if (!validDirections.includes(direction)) {
      throw new Error(`Invalid scroll direction: ${direction}`)
    }
    try {
      return await browserPaneManager.scroll(id, direction as 'up' | 'down' | 'left' | 'right', amount)
    } catch (err) {
      platform.logger.error(`[browser-pane] scroll failed for ${id}:`, err)
      throw err
    }
  })

  server.handle(
    RPC_CHANNELS.browserPane.REVEAL_SELECTION,
    (ctx, reference: WebSelectionReference, selectionSessionId?: string) => (
      browserPaneManager.revealSelection(reference, {
        workspaceId: ctx.workspaceId,
        originWebContentsId: ctx.webContentsId,
        selectionSessionId,
      })
    ),
  )

  // Forward browser events to locally-connected renderers. Workspace isolation
  // stays renderer-side, while window-owned learning browsers are routed only
  // to their originating renderer.
  //
  // We can't route STATE_CHANGED to `{ to: 'workspace', workspaceId }` here
  // because the broadcast routing uses the client's transport-level workspaceId
  // (the local Craft Agents window's id, set by `updateClientWorkspace`),
  // while remote-bridged instances are stamped with the remote server's
  // workspaceId. The two never match, so a workspace-targeted broadcast would
  // silently fail to reach the renderer. Broadcast to all + renderer filtering
  // remains the contract for standalone/Agent browsers.
  browserPaneManager.onStateChange((info) => {
    if (isWindowOwnedLearningBrowser(info)) {
      const clientId = windowManager?.getClientIdForWindow(info.originWebContentsId!)
      if (!clientId) {
        platform.logger.warn(
          `[browser-pane] dropping window-owned browser state without an originating renderer instanceId=${info.id}`,
        )
        return
      }
      pushTyped(
        server,
        RPC_CHANNELS.browserPane.STATE_CHANGED,
        { to: 'client', clientId },
        info,
      )
      return
    }
    pushTyped(server, RPC_CHANNELS.browserPane.STATE_CHANGED, { to: 'all' }, info)
  })

  browserPaneManager.onRemoved((id) => {
    pushTyped(server, RPC_CHANNELS.browserPane.REMOVED, { to: 'all' }, id)
  })

  browserPaneManager.onInteracted((id) => {
    pushTyped(server, RPC_CHANNELS.browserPane.INTERACTED, { to: 'all' }, id)
  })

  browserPaneManager.onSelectionAsk((payload, targetClientId) => {
    if (!targetClientId) {
      platform.logger.warn(
        `[browser-pane] dropping selection Ask event without an originating renderer instanceId=${payload.instanceId}`,
      )
      return
    }
    server.push(
      RPC_CHANNELS.browserPane.SELECTION_ASK,
      { to: 'client', clientId: targetClientId },
      payload,
    )
  })
}
