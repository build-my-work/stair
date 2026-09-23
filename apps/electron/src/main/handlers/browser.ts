import {
  RPC_CHANNELS,
  type BrowserPaneCreateOptions,
  type BrowserPaneReconcileInput,
  type BrowserEmptyStateLaunchPayload,
} from '../../shared/types'
import type { WebSelectionReferenceV1 } from '@craft-agent/core/types'
import { getWorkspaces } from '@craft-agent/shared/config'
import type { BrowserScreenshotOptions } from '../browser-pane-manager'
import {
  pushTyped,
  type RequestContext,
  type RpcServer,
} from '@craft-agent/server-core/transport'
import { createBrowserApplicationRouter } from '../browser-application-router'
import type { HandlerDeps } from './handler-deps'

export const HANDLED_CHANNELS = [
  RPC_CHANNELS.browserPane.CREATE,
  RPC_CHANNELS.browserPane.RECONCILE,
  RPC_CHANNELS.browserPane.DESTROY,
  RPC_CHANNELS.browserPane.LIST,
  RPC_CHANNELS.browserPane.NAVIGATE,
  RPC_CHANNELS.browserPane.GO_BACK,
  RPC_CHANNELS.browserPane.GO_FORWARD,
  RPC_CHANNELS.browserPane.RELOAD,
  RPC_CHANNELS.browserPane.STOP,
  RPC_CHANNELS.browserPane.FOCUS,
  RPC_CHANNELS.browserPane.HIDE,
  RPC_CHANNELS.browserPane.OPEN_TARGET_CHAT,
  RPC_CHANNELS.browserPane.REVEAL_SELECTION,
  RPC_CHANNELS.browserPane.LAUNCH,
  RPC_CHANNELS.browserPane.SNAPSHOT,
  RPC_CHANNELS.browserPane.CLICK,
  RPC_CHANNELS.browserPane.FILL,
  RPC_CHANNELS.browserPane.SELECT,
  RPC_CHANNELS.browserPane.SCREENSHOT,
  RPC_CHANNELS.browserPane.EVALUATE,
  RPC_CHANNELS.browserPane.SCROLL,
] as const

export function registerBrowserHandlers(server: RpcServer, deps: HandlerDeps): void {
  const { browserPaneManager, platform } = deps
  if (!browserPaneManager) return

  const resolveWorkspace = (workspaceId: string) => getWorkspaces().find(workspace => (
    workspace.id === workspaceId
    || workspace.remoteServer?.remoteWorkspaceId === workspaceId
  )) ?? null

  const requireWorkspace = (ctx: RequestContext) => {
    if (!ctx.workspaceId) throw new Error('Browser window requires an owning Workspace')
    const workspace = resolveWorkspace(ctx.workspaceId)
    if (!workspace) throw new Error('Browser Workspace is unavailable')
    return workspace
  }

  const requireScope = (ctx: RequestContext, projectId: string) => {
    if (!projectId) throw new Error('Browser window requires an owning Project')
    const workspace = requireWorkspace(ctx)
    return { workspace, workspaceId: workspace.id, projectId }
  }

  const requireAuthorizedInstance = (
    ctx: RequestContext,
    instanceId: string,
    projectId: string,
  ) => {
    const scope = requireScope(ctx, projectId)
    const instance = browserPaneManager.listInstances().find(item => item.id === instanceId)
    if (
      !instance
      || instance.workspaceId !== scope.workspaceId
      || instance.projectId !== scope.projectId
    ) {
      throw new Error('Browser window does not belong to the active Project')
    }
    return instance
  }

  const applicationRouter = createBrowserApplicationRouter({
    server,
    windowManager: deps.windowManager,
    resolveWorkspace,
  })
  browserPaneManager.setApplicationService(applicationRouter.service)

  server.handle(RPC_CHANNELS.browserPane.CREATE, async (ctx, input: BrowserPaneCreateOptions) => {
    const scope = requireScope(ctx, input?.projectId)
    await applicationRouter.validateProjectTarget({
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      targetSessionId: input.targetSessionId,
      preferredClientId: ctx.clientId,
    })

    return browserPaneManager.createInstance(undefined, {
      show: input.show,
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      targetSessionId: input.targetSessionId,
      originWebContentsId: ctx.webContentsId,
    })
  })

  server.handle(RPC_CHANNELS.browserPane.RECONCILE, (ctx, input: BrowserPaneReconcileInput) => {
    const workspace = requireWorkspace(ctx)
    if (input.workspaceId !== workspace.id) {
      throw new Error('Browser reconcile belongs to another Workspace')
    }
    browserPaneManager.reconcileWorkspace(input.workspaceId, input)
  })

  server.handle(RPC_CHANNELS.browserPane.DESTROY, (ctx, id: string, projectId: string) => {
    requireAuthorizedInstance(ctx, id, projectId)
    browserPaneManager.destroyInstance(id)
  })

  server.handle(RPC_CHANNELS.browserPane.LIST, (ctx, projectId: string) => {
    const scope = requireScope(ctx, projectId)
    return browserPaneManager.listInstances().filter(instance => (
      instance.workspaceId === scope.workspaceId
      && instance.projectId === scope.projectId
    ))
  })

  server.handle(RPC_CHANNELS.browserPane.NAVIGATE, async (ctx, id: string, url: string, projectId: string) => {
    requireAuthorizedInstance(ctx, id, projectId)
    try {
      return await browserPaneManager.navigate(id, url)
    } catch (err) {
      platform.logger.error(`[browser-pane] navigate failed for ${id}:`, err)
      throw err
    }
  })

  server.handle(RPC_CHANNELS.browserPane.GO_BACK, async (ctx, id: string, projectId: string) => {
    requireAuthorizedInstance(ctx, id, projectId)
    try {
      return await browserPaneManager.goBack(id)
    } catch (err) {
      platform.logger.error(`[browser-pane] goBack failed for ${id}:`, err)
      throw err
    }
  })

  server.handle(RPC_CHANNELS.browserPane.GO_FORWARD, async (ctx, id: string, projectId: string) => {
    requireAuthorizedInstance(ctx, id, projectId)
    try {
      return await browserPaneManager.goForward(id)
    } catch (err) {
      platform.logger.error(`[browser-pane] goForward failed for ${id}:`, err)
      throw err
    }
  })

  server.handle(RPC_CHANNELS.browserPane.RELOAD, (ctx, id: string, projectId: string) => {
    requireAuthorizedInstance(ctx, id, projectId)
    browserPaneManager.reload(id)
  })

  server.handle(RPC_CHANNELS.browserPane.STOP, (ctx, id: string, projectId: string) => {
    requireAuthorizedInstance(ctx, id, projectId)
    browserPaneManager.stop(id)
  })

  server.handle(RPC_CHANNELS.browserPane.FOCUS, (ctx, id: string, projectId: string) => {
    requireAuthorizedInstance(ctx, id, projectId)
    browserPaneManager.focus(id)
  })

  server.handle(RPC_CHANNELS.browserPane.HIDE, (ctx, id: string, projectId: string) => {
    requireAuthorizedInstance(ctx, id, projectId)
    browserPaneManager.hide(id)
  })

  server.handle(RPC_CHANNELS.browserPane.OPEN_TARGET_CHAT, async (ctx, id: string, projectId: string) => {
    requireAuthorizedInstance(ctx, id, projectId)
    await browserPaneManager.openTargetSession(id)
  })

  server.handle(
    RPC_CHANNELS.browserPane.REVEAL_SELECTION,
    (ctx, reference: WebSelectionReferenceV1, browserId?: string) => {
      const scope = requireScope(ctx, reference.projectId)
      if (browserId) requireAuthorizedInstance(ctx, browserId, reference.projectId)
      return browserPaneManager.revealSelection(reference, {
        workspaceId: scope.workspaceId,
        browserId,
      })
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

  server.handle(RPC_CHANNELS.browserPane.SNAPSHOT, async (ctx, id: string, projectId: string) => {
    requireAuthorizedInstance(ctx, id, projectId)
    try {
      return await browserPaneManager.getAccessibilitySnapshot(id)
    } catch (err) {
      platform.logger.error(`[browser-pane] snapshot failed for ${id}:`, err)
      throw err
    }
  })

  server.handle(RPC_CHANNELS.browserPane.CLICK, async (ctx, id: string, ref: string, projectId: string) => {
    requireAuthorizedInstance(ctx, id, projectId)
    try {
      return await browserPaneManager.clickElement(id, ref)
    } catch (err) {
      platform.logger.error(`[browser-pane] click failed for ${id} ref=${ref}:`, err)
      throw err
    }
  })

  server.handle(RPC_CHANNELS.browserPane.FILL, async (ctx, id: string, ref: string, value: string, projectId: string) => {
    requireAuthorizedInstance(ctx, id, projectId)
    try {
      return await browserPaneManager.fillElement(id, ref, value)
    } catch (err) {
      platform.logger.error(`[browser-pane] fill failed for ${id} ref=${ref}:`, err)
      throw err
    }
  })

  server.handle(RPC_CHANNELS.browserPane.SELECT, async (ctx, id: string, ref: string, value: string, projectId: string) => {
    requireAuthorizedInstance(ctx, id, projectId)
    try {
      return await browserPaneManager.selectOption(id, ref, value)
    } catch (err) {
      platform.logger.error(`[browser-pane] select failed for ${id} ref=${ref}:`, err)
      throw err
    }
  })

  server.handle(RPC_CHANNELS.browserPane.SCREENSHOT, async (ctx, id: string, options: BrowserScreenshotOptions | undefined, projectId: string) => {
    requireAuthorizedInstance(ctx, id, projectId)
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

  server.handle(RPC_CHANNELS.browserPane.EVALUATE, async (ctx, id: string, expression: string, projectId: string) => {
    requireAuthorizedInstance(ctx, id, projectId)
    try {
      return await browserPaneManager.evaluate(id, expression)
    } catch (err) {
      platform.logger.error(`[browser-pane] evaluate failed for ${id}:`, err)
      throw err
    }
  })

  server.handle(RPC_CHANNELS.browserPane.SCROLL, async (ctx, id: string, direction: string, amount: number | undefined, projectId: string) => {
    requireAuthorizedInstance(ctx, id, projectId)
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

  browserPaneManager.onStateChange((info) => {
    const target = info.workspaceId
      ? { to: 'workspace' as const, workspaceId: info.workspaceId }
      : { to: 'all' as const }
    pushTyped(server, RPC_CHANNELS.browserPane.STATE_CHANGED, target, info)
  })

  browserPaneManager.onRemoved((id) => {
    pushTyped(server, RPC_CHANNELS.browserPane.REMOVED, { to: 'all' }, id)
  })

  browserPaneManager.onInteracted((id) => {
    pushTyped(server, RPC_CHANNELS.browserPane.INTERACTED, { to: 'all' }, id)
  })

}
