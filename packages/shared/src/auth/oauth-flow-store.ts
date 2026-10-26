/**
 * OAuthFlowStore — in-memory store for pending OAuth flows.
 *
 * Lives server-side. Never serialized, never sent to clients.
 * Keyed by `state` (CSRF token) for O(1) lookup on oauth:complete.
 * 5-minute TTL with lazy + periodic cleanup.
 *
 * Single flight: the newest flow per (workspace, source) is indexed so oauth:start
 * can let a second caller join it instead of opening another browser sign-in.
 * Ended flows leave a short-lived outcome for the clients that joined them.
 */

import type { LoadedSource } from '../sources/types.ts';
import type { OAuthProvider } from './oauth-flow-types.ts';

const FLOW_TTL_MS = 5 * 60 * 1000; // 5 minutes
const CLEANUP_INTERVAL_MS = 60 * 1000; // sweep every minute
/** How long a joined client can still read how a flow ended (it polls every couple of seconds). */
const OUTCOME_TTL_MS = 2 * 60 * 1000;

/** A caller that asked to sign in to a source while a flow for it was already live. */
export interface OAuthFlowWaiter {
  clientId: string;
  sessionId?: string;
  authRequestId?: string;
  authOwnerToken?: string;
}

/** How a flow ended, as reported to the clients that joined it. */
export interface OAuthFlowOutcome {
  success: boolean;
  error?: string;
  email?: string;
}

export type OAuthFlowStatus =
  | { live: true; expiresInMs: number }
  | { live: false; outcome?: OAuthFlowOutcome };

export interface PendingOAuthFlow {
  flowId: string;
  state: string;
  codeVerifier: string;
  redirectUri: string;
  source: LoadedSource;
  clientId: string;
  clientSecret?: string;
  tokenEndpoint: string;
  /** RFC 8707 resource indicator carried from prepare into the token exchange */
  resource?: string;
  provider: OAuthProvider;

  // Binding fields — validated on oauth:complete
  ownerClientId: string;
  workspaceId: string;
  sourceSlug: string;

  // Optional session binding (when initiated from auth request card)
  sessionId?: string;
  authRequestId?: string;
  authOwnerToken?: string;

  /** Callers that joined this flow instead of starting their own */
  waiters: OAuthFlowWaiter[];

  createdAt: number;
  expiresAt: number;
}

const EXPIRED: OAuthFlowOutcome = { success: false, error: 'The sign-in expired before it was completed.' };
const ENDED: OAuthFlowOutcome = { success: false, error: 'The sign-in was cancelled.' };

function sourceKey(workspaceId: string, sourceSlug: string): string {
  return `${workspaceId}\u0000${sourceSlug}`;
}

export class OAuthFlowStore {
  private flows = new Map<string, PendingOAuthFlow>();
  /** (workspace, source) → state of the newest flow for it */
  private liveBySource = new Map<string, string>();
  /** flowId → how it ended, for joined clients polling oauth:status */
  private outcomes = new Map<string, OAuthFlowOutcome & { workspaceId: string; endedAt: number }>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.cleanupTimer = setInterval(() => this.cleanup(), CLEANUP_INTERVAL_MS);
  }

  /** Store a flow and make it the one new callers for its source join (older ones stay completable). */
  store(flow: PendingOAuthFlow): void {
    this.flows.set(flow.state, flow);
    this.liveBySource.set(sourceKey(flow.workspaceId, flow.sourceSlug), flow.state);
  }

  getByState(state: string): PendingOAuthFlow | null {
    const flow = this.flows.get(state);
    if (!flow) return null;

    // Check expiry lazily
    if (Date.now() > flow.expiresAt) {
      this.end(flow, EXPIRED);
      return null;
    }

    return flow;
  }

  /** The live flow a new sign-in for this source should join, if any. */
  getLiveForSource(workspaceId: string, sourceSlug: string): PendingOAuthFlow | null {
    const state = this.liveBySource.get(sourceKey(workspaceId, sourceSlug));
    return state ? this.getByState(state) : null;
  }

  /** Record a caller waiting on a live flow. Returns the flow, or null if it is gone. */
  join(state: string, waiter: OAuthFlowWaiter): PendingOAuthFlow | null {
    const flow = this.getByState(state);
    if (!flow) return null;
    const known = flow.waiters.some(w =>
      w.clientId === waiter.clientId && w.sessionId === waiter.sessionId && w.authRequestId === waiter.authRequestId
      && w.authOwnerToken === waiter.authOwnerToken,
    );
    if (!known) flow.waiters.push(waiter);
    return flow;
  }

  /**
   * End a flow. Joined clients learn `outcome` from getStatus() for a short while;
   * omitting it reports a cancellation.
   */
  remove(state: string, outcome: OAuthFlowOutcome = ENDED): PendingOAuthFlow | null {
    const flow = this.flows.get(state);
    if (!flow) return null;
    this.end(flow, outcome);
    return flow;
  }

  /** Revoke a disconnected owner's flows and remove its bindings from other live flows. */
  removeOwnedByClient(clientId: string): PendingOAuthFlow[] {
    const removed: PendingOAuthFlow[] = [];
    for (const flow of this.flows.values()) {
      if (flow.ownerClientId === clientId) {
        this.end(flow, { success: false, error: 'The sign-in client disconnected. Sign in again to continue.' });
        removed.push(flow);
      } else {
        flow.waiters = flow.waiters.filter(waiter => waiter.clientId !== clientId);
      }
    }
    return removed;
  }

  /** Whether a flow is still live, or how it ended — scoped to the caller's workspace. */
  getStatus(flowId: string, workspaceId: string): OAuthFlowStatus {
    for (const flow of this.flows.values()) {
      if (flow.flowId !== flowId || flow.workspaceId !== workspaceId) continue;
      if (this.getByState(flow.state)) return { live: true, expiresInMs: flow.expiresAt - Date.now() };
      break;
    }
    const ended = this.outcomes.get(flowId);
    if (!ended || ended.workspaceId !== workspaceId) return { live: false };
    const { success, error, email } = ended;
    return { live: false, outcome: { success, error, email } };
  }

  /** Prune expired entries. Called on interval + lazily on access. */
  cleanup(): void {
    const now = Date.now();
    for (const flow of this.flows.values()) {
      if (now > flow.expiresAt) this.end(flow, EXPIRED);
    }
    for (const [flowId, ended] of this.outcomes) {
      if (now - ended.endedAt > OUTCOME_TTL_MS) this.outcomes.delete(flowId);
    }
  }

  /** Stop the periodic cleanup timer (for graceful shutdown). */
  dispose(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.flows.clear();
    this.liveBySource.clear();
    this.outcomes.clear();
  }

  /** Number of pending flows (for diagnostics). */
  get size(): number {
    return this.flows.size;
  }

  private end(flow: PendingOAuthFlow, outcome: OAuthFlowOutcome): void {
    this.flows.delete(flow.state);
    const key = sourceKey(flow.workspaceId, flow.sourceSlug);
    if (this.liveBySource.get(key) === flow.state) {
      // Another flow for the source may still be live (an older client or a restart race
      // started one too); new callers join the newest of those.
      let next: PendingOAuthFlow | undefined;
      for (const other of this.flows.values()) {
        if (sourceKey(other.workspaceId, other.sourceSlug) !== key || Date.now() > other.expiresAt) continue;
        if (!next || other.createdAt >= next.createdAt) next = other;
      }
      if (next) this.liveBySource.set(key, next.state);
      else this.liveBySource.delete(key);
    }
    this.outcomes.set(flow.flowId, { ...outcome, workspaceId: flow.workspaceId, endedAt: Date.now() });
  }
}

/**
 * Create a PendingOAuthFlow with default TTL.
 * Convenience helper used by the oauth:start handler.
 */
export function createPendingFlow(
  params: Omit<PendingOAuthFlow, 'createdAt' | 'expiresAt' | 'waiters'> & { waiters?: OAuthFlowWaiter[] }
): PendingOAuthFlow {
  const now = Date.now();
  return {
    ...params,
    waiters: params.waiters ?? [],
    createdAt: now,
    expiresAt: now + FLOW_TTL_MS,
  };
}
