import { randomUUID } from 'node:crypto'
import { RPC_CHANNELS } from '@craft-agent/shared/protocol'
import { getWorkspaceByNameOrId } from '@craft-agent/shared/config'
import { loadSource, loadWorkspaceSources, getSourceCredentialManager, type LoadedSource } from '@craft-agent/shared/sources'
import { createPendingFlow, type OAuthFlowWaiter, type PendingOAuthFlow, type PreparedOAuthFlow } from '@craft-agent/shared/auth'
import { pushTyped, type RpcServer } from '@craft-agent/server-core/transport'
import type { HandlerDeps } from '../handler-deps'
import type { IOAuthFlowStore } from '../oauth-flow-store-interface'
import type { ISessionManager } from '../session-manager-interface'

export const HANDLED_CHANNELS = [
  RPC_CHANNELS.oauth.START,
  RPC_CHANNELS.oauth.COMPLETE,
  RPC_CHANNELS.oauth.CANCEL,
  RPC_CHANNELS.oauth.STATUS,
  RPC_CHANNELS.oauth.REVOKE,
] as const

type OAuthCompletionResult = { success: boolean; error?: string; email?: string }

// OAuth authorization codes are single use. Concurrent callbacks must share the
// whole completion, including its card updates, after checking caller ownership.
const completingFlows = new WeakMap<PendingOAuthFlow, Promise<OAuthCompletionResult>>()
const clientResources = new Map<string, { active: boolean; deps: HandlerDeps }>()

/** Disconnect retires runtime authority, retaining the durable cards for explicit retry. */
export function cleanupOAuthClientResources(clientId: string): void {
  const resource = clientResources.get(clientId)
  if (!resource) return
  resource.active = false
  clientResources.delete(clientId)
  for (const flow of resource.deps.oauthFlowStore.removeOwnedByClient(clientId)) {
    for (const binding of [flow, ...flow.waiters]) {
      if (!binding.sessionId || !binding.authRequestId || !binding.authOwnerToken) continue
      void resource.deps.sessionManager.releaseAuthRequestOwner(binding.sessionId, binding.authRequestId, binding.authOwnerToken)
        .catch(error => resource.deps.platform.logger.error('[OAuth] Could not persist disconnected auth owner release', error))
    }
  }
}

/**
 * Complete an OAuth flow: validate state, exchange code for tokens, store credentials.
 *
 * Shared between the `oauth:complete` RPC handler (called by Electron) and the
 * `/api/oauth/callback` HTTP route (called by the relay for WebUI).
 *
 * A successful sign-in answers every session in the workspace that is waiting on the
 * source, not just the one whose card started the flow.
 *
 * @param opts.clientId - RPC client ID (for ownership validation). Omit for HTTP callback.
 * @param opts.workspaceId - Workspace ID (for ownership validation). Omit for HTTP callback.
 */
export async function completeOAuthFlow(opts: {
  code: string
  state: string
  flowStore: Pick<IOAuthFlowStore, 'getByState' | 'remove'>
  credManager: { exchangeAndStore(...args: any[]): Promise<any> }
  sessionManager: Pick<ISessionManager, 'completeAuthRequest' | 'completeAuthRequestsForSource'>
  pushSourcesChanged: (workspaceId: string) => void
  logger: { info(msg: string): void; }
  clientId?: string
  workspaceId?: string | null
}): Promise<OAuthCompletionResult> {
  const { code, state, flowStore, credManager, sessionManager, pushSourcesChanged, logger } = opts

  const flow = flowStore.getByState(state)
  if (!flow) throw new Error('Unknown or expired OAuth flow')

  // When called via RPC, enforce ownership. HTTP callbacks skip this (state is sufficient auth).
  if (opts.clientId !== undefined) {
    if (flow.ownerClientId !== opts.clientId) throw new Error('OAuth flow owned by different client')
  }
  if (opts.workspaceId != null) {
    if (flow.workspaceId !== opts.workspaceId) throw new Error('Workspace mismatch')
  }

  const pending = completingFlows.get(flow)
  if (pending) return pending

  const completion = (async (): Promise<OAuthCompletionResult> => {
    let result: OAuthCompletionResult
    try {
      result = await credManager.exchangeAndStore(flow.source, flow.provider, {
        code,
        codeVerifier: flow.codeVerifier,
        tokenEndpoint: flow.tokenEndpoint,
        clientId: flow.clientId,
        clientSecret: flow.clientSecret,
        redirectUri: flow.redirectUri,
        resource: flow.resource,
      })
    } catch (err) {
      // End the flow anyway so clients waiting on it stop waiting
      flowStore.remove(state, { success: false, error: err instanceof Error ? err.message : String(err) })
      throw err
    }

    // Cancellation/restart can win while the provider exchange is in flight. Credentials
    // may have been saved, but that old flow no longer has authority to resume any card.
    if (flowStore.getByState(state) !== flow) return { success: false, error: 'OAuth flow was cancelled or already completed.' }

    // Ending the flow is how clients that joined it learn the result
    flowStore.remove(state, { success: result.success, error: result.error, email: result.email })

    if (result.success) {
      // Carry exact ownership of the cards that explicitly started or joined this flow.
      const boundRequests = [flow, ...(flow.waiters ?? [])].flatMap(({ sessionId, authRequestId, authOwnerToken }) =>
        sessionId && authRequestId ? [{ sessionId, authRequestId, ...(authOwnerToken ? { authOwnerToken } : {}) }] : [],
      )
      const resumed = await sessionManager.completeAuthRequestsForSource(
        flow.workspaceId, flow.sourceSlug, { email: result.email }, boundRequests,
      )
      if (resumed.length > 1) logger.info(`[OAuth] ${flow.sourceSlug} sign-in answered ${resumed.length} sessions`)
    } else if (flow.sessionId && flow.authRequestId) {
      // A failed exchange fails only the card that started the flow; cards that joined it
      // stay pending so the user can try again
      await sessionManager.completeAuthRequest(flow.sessionId, {
        requestId: flow.authRequestId,
        sourceSlug: flow.sourceSlug,
        success: false,
        error: result.error,
      }, flow.authOwnerToken)
    }

    // Push source status update to all clients in this workspace
    pushSourcesChanged(flow.workspaceId)

    logger.info(`[OAuth] Flow complete for ${flow.sourceSlug} (success=${result.success})`)
    return result
  })()
  completingFlows.set(flow, completion)
  try {
    return await completion
  } finally {
    completingFlows.delete(flow)
  }
}

/** What oauth:start answers: a new flow to open in the browser, or the live one to wait on. */
export type OAuthStartResponse =
  | { joined: true; flowId: string; expiresInMs: number }
  | { authUrl: string; state: string; flowId: string; expiresInMs: number }

/**
 * Start a sign-in for a source, or join the live one: single flight per (workspace, source),
 * so parallel sessions that need the same sign-in share one flow. A caller that arrives while
 * it is live gets `{ joined: true }`, opens nothing, and polls oauth:status until it ends.
 * Exported for tests; the oauth:start handler resolves the workspace and source first.
 */
export function createOAuthFlowStarter(deps: {
  flowStore: IOAuthFlowStore
  prepare: (source: LoadedSource, options: { callbackPort?: number; callbackUrl?: string }) => Promise<PreparedOAuthFlow>
  logger: { info(msg: string): void }
}) {
  const { flowStore, prepare, logger } = deps
  // Starts still preparing their flow (MCP discovery is a network round trip), so a second
  // start for the same source waits for that flow instead of racing it with another
  const preparing = new Map<string, Promise<unknown>>()

  return async function startOAuthFlow(request: {
    workspaceId: string
    clientId: string
    source: LoadedSource
    sourceSlug: string
    callbackPort?: number
    callbackUrl?: string
    sessionId?: string
    authRequestId?: string
    authOwnerToken?: string
    /** Rechecked after every provider/discovery wait before publishing a flow. */
    assertCurrent?: () => void
    /** The client can wait on a live flow (older clients always get their own) */
    joinLive?: boolean
    /** Replace the live flow, e.g. after its sign-in window was lost */
    restart?: boolean
  }): Promise<OAuthStartResponse> {
    const { workspaceId, clientId, source, sourceSlug, sessionId, authRequestId, restart } = request

    const key = `${workspaceId}\u0000${sourceSlug}`
    if (request.joinLive && !restart) {
      // Only yield when there is something to wait for: until this start registers its own
      // preparation below, a concurrent start must not slip past this check too
      const pending = preparing.get(key)
      if (pending) await pending.catch(() => {})
      request.assertCurrent?.()
      const live = flowStore.getLiveForSource(workspaceId, sourceSlug)
      if (live) {
        flowStore.join(live.state, { clientId, sessionId, authRequestId,
          ...(request.authOwnerToken ? { authOwnerToken: request.authOwnerToken } : {}) })
        logger.info(`[OAuth] Joined live flow for ${sourceSlug} (flow=${live.flowId}, waiters=${live.waiters.length})`)
        return { joined: true, flowId: live.flowId, expiresInMs: live.expiresAt - Date.now() }
      }
    }

    const preparation = (async () => {
      const prepared = await prepare(source, { callbackPort: request.callbackPort, callbackUrl: request.callbackUrl })
      request.assertCurrent?.()

      // Starting over ends the live flow; its cards carry over so they complete with the new one
      let waiters: OAuthFlowWaiter[] = []
      const replaced = restart ? flowStore.getLiveForSource(workspaceId, sourceSlug) : null
      if (replaced) {
        flowStore.remove(replaced.state, { success: false, error: 'The sign-in was restarted.' })
        waiters = [{ clientId: replaced.ownerClientId, sessionId: replaced.sessionId, authRequestId: replaced.authRequestId,
          ...(replaced.authOwnerToken ? { authOwnerToken: replaced.authOwnerToken } : {}) }, ...replaced.waiters]
          .filter(w => w.sessionId && w.authRequestId && !(w.sessionId === sessionId && w.authRequestId === authRequestId))
      }

      const flow = createPendingFlow({
        flowId: randomUUID(),
        state: prepared.state,
        codeVerifier: prepared.codeVerifier,
        redirectUri: prepared.redirectUri,
        source,
        clientId: prepared.clientId,
        clientSecret: prepared.clientSecret,
        tokenEndpoint: prepared.tokenEndpoint,
        resource: prepared.resource,
        provider: prepared.provider,
        ownerClientId: clientId,
        workspaceId,
        sourceSlug,
        sessionId,
        authRequestId,
        ...(request.authOwnerToken ? { authOwnerToken: request.authOwnerToken } : {}),
        waiters,
      })
      flowStore.store(flow)
      logger.info(`[OAuth] Flow ${replaced ? 'restarted' : 'started'} for ${sourceSlug} (flow=${flow.flowId})`)
      return { flow, authUrl: prepared.authUrl }
    })()

    preparing.set(key, preparation)
    try {
      const { flow, authUrl } = await preparation
      return { authUrl, state: flow.state, flowId: flow.flowId, expiresInMs: flow.expiresAt - Date.now() }
    } finally {
      if (preparing.get(key) === preparation) preparing.delete(key)
    }
  }
}

export function registerOAuthHandlers(server: RpcServer, deps: HandlerDeps): void {
  const log = deps.platform.logger
  const flowStore = deps.oauthFlowStore
  const credManager = getSourceCredentialManager()
  const startOAuthFlow = createOAuthFlowStarter({
    flowStore,
    prepare: (source, options) => credManager.prepareOAuth(source, options),
    logger: log,
  })

  // ── oauth:start ──────────────────────────────────────────────
  server.handle(RPC_CHANNELS.oauth.START, async (ctx, args: {
    sourceSlug: string
    callbackPort?: number
    callbackUrl?: string
    sessionId?: string
    authRequestId?: string
    joinLive?: boolean
    restart?: boolean
  }) => {
    const { sourceSlug } = args

    if (!ctx.workspaceId) {
      throw new Error('No workspace bound to this client')
    }

    const workspace = getWorkspaceByNameOrId(ctx.workspaceId)
    if (!workspace) {
      throw new Error(`Workspace not found: ${ctx.workspaceId}`)
    }

    const source = loadSource(workspace.rootPath, sourceSlug)
    if (!source) {
      throw new Error(`Source not found: ${sourceSlug}`)
    }

    if (!!args.sessionId !== !!args.authRequestId) throw new Error('Both sessionId and authRequestId are required for an auth card')
    const resource = clientResources.get(ctx.clientId) ?? { active: true, deps }
    clientResources.set(ctx.clientId, resource)
    let authOwnerToken: string | undefined
    const assertCurrent = () => {
      if (!resource.active) throw new Error('AUTH_CLIENT_DISCONNECTED: Sign in again to continue.')
      if (authOwnerToken && !deps.sessionManager.isAuthRequestCurrent(args.sessionId!, args.authRequestId!, authOwnerToken)) {
        throw new Error('AUTH_REQUEST_CANCELLED')
      }
    }
    try {
      authOwnerToken = args.sessionId && args.authRequestId
        ? await deps.sessionManager.prepareAuthRequest(args.sessionId, args.authRequestId, ctx.workspaceId, sourceSlug, ctx.clientId)
        : undefined
      assertCurrent()
      const result = await startOAuthFlow({ ...args, workspaceId: ctx.workspaceId, clientId: ctx.clientId, source, authOwnerToken, assertCurrent })
      assertCurrent()
      return result
    } catch (error) {
      if (!resource.active && args.sessionId && args.authRequestId && authOwnerToken) {
        await deps.sessionManager.releaseAuthRequestOwner(args.sessionId, args.authRequestId, authOwnerToken)
      }
      throw error
    }
  })

  // ── oauth:complete ───────────────────────────────────────────
  server.handle(RPC_CHANNELS.oauth.COMPLETE, async (ctx, args: {
    flowId: string
    code: string
    state: string
  }) => {
    const { flowId, code, state } = args

    // Validate flowId match before delegating
    const flow = flowStore.getByState(state)
    if (!flow) throw new Error('Unknown or expired OAuth flow')
    if (flow.flowId !== flowId) throw new Error('Flow ID mismatch')

    return completeOAuthFlow({
      code,
      state,
      flowStore,
      credManager,
      sessionManager: deps.sessionManager,
      pushSourcesChanged: (workspaceId) => {
        const ws = getWorkspaceByNameOrId(workspaceId)
        const sources = ws ? loadWorkspaceSources(ws.rootPath) : []
        pushTyped(server, RPC_CHANNELS.sources.CHANGED, { to: 'workspace', workspaceId }, workspaceId, sources)
      },
      logger: log,
      clientId: ctx.clientId,
      workspaceId: ctx.workspaceId,
    })
  })

  // ── oauth:cancel ─────────────────────────────────────────────
  server.handle(RPC_CHANNELS.oauth.CANCEL, async (ctx, args: {
    flowId: string
    state: string
    /** Why the owner gave up (provider error, timeout) — reported to clients that joined */
    error?: string
  }) => {
    const { flowId, state, error } = args
    const flow = flowStore.getByState(state)
    if (flow && flow.flowId === flowId && flow.ownerClientId === ctx.clientId) {
      flowStore.remove(state, error ? { success: false, error } : undefined)
      await Promise.all([flow, ...flow.waiters].map(binding => binding.sessionId && binding.authRequestId
        ? deps.sessionManager.completeAuthRequest(binding.sessionId, {
          requestId: binding.authRequestId, sourceSlug: flow.sourceSlug, success: false, cancelled: true,
        }, binding.authOwnerToken)
        : Promise.resolve()))
      log.info(`[OAuth] Flow cancelled for ${flow.sourceSlug}`)
    }
  })

  // ── oauth:status ─────────────────────────────────────────────
  // Polled by clients that joined a flow: still live, or how it ended.
  server.handle(RPC_CHANNELS.oauth.STATUS, async (ctx, args: { flowId: string }) => {
    if (!ctx.workspaceId) {
      throw new Error('No workspace bound to this client')
    }
    return flowStore.getStatus(args.flowId, ctx.workspaceId)
  })

  // ── oauth:revoke ─────────────────────────────────────────────
  server.handle(RPC_CHANNELS.oauth.REVOKE, async (ctx, args: {
    sourceSlug: string
  }) => {
    const { sourceSlug } = args

    if (!ctx.workspaceId) {
      throw new Error('No workspace bound to this client')
    }

    const workspace = getWorkspaceByNameOrId(ctx.workspaceId)
    if (!workspace) {
      throw new Error(`Workspace not found: ${ctx.workspaceId}`)
    }

    const source = loadSource(workspace.rootPath, sourceSlug)
    if (!source) {
      throw new Error(`Source not found: ${sourceSlug}`)
    }

    await credManager.delete(source)
    credManager.markSourceNeedsReauth(source, 'Signed out by user')

    // Push source status update
    const revokeSources = loadWorkspaceSources(workspace.rootPath)
    pushTyped(server, RPC_CHANNELS.sources.CHANGED, { to: 'workspace', workspaceId: ctx.workspaceId }, ctx.workspaceId, revokeSources)

    log.info(`[OAuth] Revoked credentials for ${sourceSlug}`)
    return { success: true }
  })
}
