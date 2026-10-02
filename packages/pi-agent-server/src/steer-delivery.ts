import { AsyncLocalStorage } from 'node:async_hooks';
import type { AgentSession, AgentSessionEvent } from '@earendil-works/pi-coding-agent';

type SteerReceipt = { type: 'steer_consumed' | 'steer_rejected'; id: string };
type PendingSteer = { id: string; queued: number; consumed: number; admitted: boolean; failed: boolean };

/** The request was rejected before starting or caching an SDK cancellation. */
export class UnknownSteerIdsError extends Error {
  readonly code = 'unknown_steer_ids';

  constructor(readonly unknownIds: string[]) {
    super('Pi steering cancellation contains unknown input identities');
  }
}

/** Tracks the SDK's transformed steering queue without replacing its input/extension pipeline. */
export class PiSteerDelivery {
  private readonly input = new AsyncLocalStorage<PendingSteer>();
  private readonly pending = new Map<string, PendingSteer>();
  private readonly knownIds = new Set<string>();
  private readonly cancelledIds = new Set<string>();
  private readonly admissions = new Set<Promise<void>>();
  private queued: Array<{ text: string; owner?: PendingSteer }> = [];
  private snapshot: readonly string[] = [];
  private accepting = false;
  private initialMessagePending = false;
  private turnId?: string;
  private settlement?: { id: string; steerIds: string[]; promise: Promise<string[]> };
  private readonly unsubscribe: () => void;

  constructor(private readonly session: AgentSession, private readonly send: (receipt: SteerReceipt) => void) {
    this.unsubscribe = session.subscribe(event => this.observe(event));
  }

  beginTurn(turnId: string): void {
    if (this.pending.size > 0) throw new Error('Previous Pi steering delivery is unresolved');
    this.accepting = true;
    this.turnId = turnId;
    this.settlement = undefined;
    this.knownIds.clear();
    this.cancelledIds.clear();
    this.initialMessagePending = true;
    this.snapshot = [...this.session.getSteeringMessages()];
    this.queued = this.snapshot.map(text => ({ text }));
  }

  async enqueue(id: string, message: string, turnId: string): Promise<void> {
    if (turnId === this.turnId && this.knownIds.has(id)) {
      if (this.cancelledIds.has(id)) this.send({ type: 'steer_rejected', id });
      else if (!this.pending.has(id)) this.send({ type: 'steer_consumed', id });
      return;
    }
    if (!this.accepting || turnId !== this.turnId) {
      this.send({ type: 'steer_rejected', id });
      return;
    }
    const entry: PendingSteer = { id, queued: 0, consumed: 0, admitted: false, failed: false };
    this.knownIds.add(id);
    this.pending.set(id, entry);
    // queue_update is emitted inside SDK steer(), after extension/template expansion.
    // Async context identifies our submission even when another extension queues input
    // while this submission waits. No request marker is added to the model's text.
    const admission = this.input.run(entry, async () => {
      try {
        await this.session.steer(message);
      } catch {
        entry.failed = true;
      }
      entry.admitted = true;
      if (entry.failed && entry.queued === 0) {
        this.pending.delete(id);
        this.cancelledIds.add(id);
        this.send({ type: 'steer_rejected', id });
      } else if (entry.queued > 0 && entry.consumed === entry.queued) {
        this.pending.delete(id);
        this.send({ type: 'steer_consumed', id });
      }
    });
    this.admissions.add(admission);
    try {
      await admission;
    } finally {
      this.admissions.delete(admission);
    }
  }

  private observe(event: AgentSessionEvent): void {
    if (event.type === 'queue_update') {
      const next = event.steering;
      if (next.length > this.snapshot.length && this.snapshot.every((text, index) => next[index] === text)) {
        const owner = this.input.getStore();
        for (const text of next.slice(this.snapshot.length)) {
          this.queued.push({ text, owner });
          if (owner) owner.queued++;
        }
      }
      this.snapshot = next;
      return;
    }
    if (event.type !== 'message_start' || event.message.role !== 'user') return;
    // The main prompt may have the same text as a steer submitted during startup.
    // It owns its separate prompt_accepted receipt, never a steering receipt.
    if (this.initialMessagePending) {
      this.initialMessagePending = false;
      return;
    }
    const content = event.message.content;
    const text = typeof content === 'string' ? content
      : content.filter(part => part.type === 'text').map(part => part.text).join('');
    // SDK steering is FIFO; identical texts retain distinct host request identities.
    const index = this.queued.findIndex(entry => entry.text === text);
    if (index === -1) return;
    const { owner } = this.queued.splice(index, 1)[0]!;
    if (!owner || this.pending.get(owner.id) !== owner) return;
    owner.consumed++;
    if (owner.admitted && owner.consumed === owner.queued) {
      this.pending.delete(owner.id);
      this.send({ type: 'steer_consumed', id: owner.id });
    }
  }

  settle(request: { id: string; turnId: string; steerIds: string[] }): Promise<string[]> {
    if (request.turnId !== this.turnId) return Promise.reject(new Error('Pi steering cancellation belongs to a different turn'));
    if (this.settlement) {
      if (request.id !== this.settlement.id || JSON.stringify(request.steerIds) !== JSON.stringify(this.settlement.steerIds)) {
        return Promise.reject(new Error('Pi steering cancellation identity mismatch'));
      }
      return this.settlement.promise.then(ids => [...ids]);
    }
    const unknownIds = request.steerIds.filter(id => !this.knownIds.has(id));
    if (unknownIds.length > 0) return Promise.reject(new UnknownSteerIdsError(unknownIds));
    if ([...this.pending.keys()].some(id => !request.steerIds.includes(id))) {
      return Promise.reject(new Error('Pi steering cancellation contains unknown input identities'));
    }
    this.accepting = false;
    const promise = this.settleTurn(request.steerIds);
    this.settlement = { id: request.id, steerIds: [...request.steerIds], promise };
    return promise.then(ids => [...ids]);
  }

  private async settleTurn(steerIds: string[]): Promise<string[]> {
    await Promise.all([...this.admissions]);
    // abort waits for SDK message listeners. Their consumption receipts have
    // already been written to stdout before the caller sends steers_settled.
    await this.session.abort();
    this.session.clearQueue();
    this.queued = [];
    this.snapshot = [];
    const unresolved = [...this.pending.values()];
    if (unresolved.some(entry => entry.consumed > 0 || !entry.failed && entry.queued === 0)) {
      throw new Error('Pi steering input was handled or partially consumed; delivery is uncertain');
    }
    this.pending.clear();
    for (const entry of unresolved) this.cancelledIds.add(entry.id);
    return steerIds.filter(id => this.cancelledIds.has(id));
  }

  dispose(): void {
    this.accepting = false;
    this.unsubscribe();
  }
}
