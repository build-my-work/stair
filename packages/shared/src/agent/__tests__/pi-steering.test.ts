import { afterEach, expect, test } from 'bun:test';
import { PiAgent } from '../pi-agent.ts';
import { PiSteerDelivery } from '../../../../pi-agent-server/src/steer-delivery.ts';

const agents: PiAgent[] = [];

function makeAgent() {
  const agent = new PiAgent({
    provider: 'pi', isHeadless: true,
    workspace: { id: 'pi-steering-test', name: 'Test', rootPath: '/tmp/pi-steering-test' } as any,
  });
  agents.push(agent);
  const sent: Record<string, any>[] = [];
  const internal = agent as any;
  internal._isProcessing = true;
  internal.steeringTurnId = 'turn-test';
  internal.subprocess = { stdin: { writable: true } };
  internal.send = (message: Record<string, any>) => { sent.push(message); };
  return { agent, internal, sent };
}

afterEach(() => {
  for (const agent of agents.splice(0)) {
    (agent as any).subprocess = null;
    agent.destroy();
  }
});

test('Pi retains host steer identities until the matching SDK consumption receipt and cancellation barrier', async () => {
  const { agent, internal, sent } = makeAgent();
  expect(agent.redirect('identical text', { messageId: 'first' })).toBe(true);
  expect(agent.redirect('identical text', { messageId: 'second' })).toBe(true);
  expect(sent[0]).toMatchObject({ type: 'steer', messageId: 'first' });
  expect(sent[1]).toMatchObject({ type: 'steer', messageId: 'second' });
  expect(sent[0]!.id).not.toBe(sent[1]!.id);

  internal.handleLine(JSON.stringify({ type: 'steer_consumed', id: sent[0]!.id }));
  internal.handleLine(JSON.stringify({ type: 'steer_consumed', id: 'stale-receipt' }));
  expect(agent.takePendingSteers()).toEqual([]);
  const settled = agent.settlePendingSteers();
  const barrier = sent.at(-1)!;
  expect(barrier).toMatchObject({ type: 'settle_steers', steerIds: [sent[1]!.id] });
  internal.handleLine(JSON.stringify({ type: 'steers_settled', id: barrier.id, success: true, pendingIds: [sent[1]!.id] }));
  await settled;
  expect(agent.takePendingSteers()).toEqual([{ message: 'identical text', messageId: 'second' }]);
  expect(agent.takePendingSteers()).toEqual([]);
});

test('Stop waits for late consumption receipts and retains the immutable recovery snapshot for both consumers', async () => {
  const { agent, internal, sent } = makeAgent();
  agent.redirect('already consumed', { messageId: 'consumed' });
  agent.redirect('still waiting', { messageId: 'waiting' });
  const first = agent.settlePendingSteers();
  const second = agent.settlePendingSteers();
  const barrier = sent.at(-1)!;
  internal.handleLine(JSON.stringify({ type: 'steer_consumed', id: sent[0]!.id }));
  internal.handleLine(JSON.stringify({ type: 'steers_settled', id: barrier.id, success: true, pendingIds: [sent[1]!.id] }));
  const recovered = await first;
  expect(agent.takePendingSteers()).toEqual([{ message: 'still waiting', messageId: 'waiting' }]);
  recovered[0]!.message = 'caller mutation';
  expect(await second).toEqual([{ message: 'still waiting', messageId: 'waiting' }]);
  expect(await agent.settlePendingSteers()).toEqual([{ message: 'still waiting', messageId: 'waiting' }]);
  expect(sent.filter(message => message.type === 'settle_steers')).toHaveLength(1);
});

test('a timed-out cancellation retries the same identity and does not invent undelivered input', async () => {
  const { agent, internal, sent } = makeAgent();
  internal.steerSettlementTimeoutMs = 5;
  agent.redirect('uncertain', { messageId: 'host-input' });
  await expect(agent.settlePendingSteers()).rejects.toThrow('timed out');
  const first = sent.at(-1)!;
  expect(agent.takePendingSteers()).toEqual([]);
  const retry = agent.settlePendingSteers();
  expect(sent.at(-1)).toEqual(first);
  internal.handleLine(JSON.stringify({ type: 'steers_settled', id: first.id, success: true, pendingIds: [sent[0]!.id] }));
  expect(await retry).toEqual([{ message: 'uncertain', messageId: 'host-input' }]);
});

test('stale cancellation responses and progress cannot confirm a different input', async () => {
  const { agent, internal, sent } = makeAgent();
  agent.redirect('pending', { messageId: 'pending' });
  const cancelled = agent.settlePendingSteers();
  const barrier = sent.at(-1)!;
  internal.handleLine(JSON.stringify({ type: 'steers_settled', id: 'older-barrier', success: true, pendingIds: [sent[0]!.id] }));
  internal.handleLine(JSON.stringify({ type: 'prompt_accepted', id: 'other-prompt' }));
  expect(agent.takePendingSteers()).toEqual([]);
  internal.handleLine(JSON.stringify({ type: 'steers_settled', id: barrier.id, success: true, pendingIds: [sent[0]!.id] }));
  await cancelled;
  // Once cancellation has confirmed ownership, a stale producer receipt cannot discard it.
  internal.handleLine(JSON.stringify({ type: 'steer_consumed', id: sent[0]!.id }));
  expect(agent.takePendingSteers()).toEqual([{ message: 'pending', messageId: 'pending' }]);
});

test('subprocess loss during cancellation leaves delivery unknown', async () => {
  const { agent, internal } = makeAgent();
  agent.redirect('pending', { messageId: 'pending' });
  const cancelled = agent.settlePendingSteers();
  internal.handleSubprocessExit(1, null);
  await expect(cancelled).rejects.toThrow('before steering delivery was confirmed');
  expect(agent.takePendingSteers()).toEqual([]);
});

test('an early rejected steer remains in the cancellation snapshot after another consumer drains it', async () => {
  const { agent, internal, sent } = makeAgent();
  agent.redirect('rejected', { messageId: 'rejected' });
  agent.redirect('pending', { messageId: 'pending' });
  internal.handleLine(JSON.stringify({ type: 'steer_rejected', id: sent[0]!.id }));
  expect(agent.takePendingSteers()).toEqual([{ message: 'rejected', messageId: 'rejected' }]);
  const cancelled = agent.settlePendingSteers();
  const barrier = sent.at(-1)!;
  internal.handleLine(JSON.stringify({ type: 'steers_settled', id: barrier.id, success: true, pendingIds: [sent[1]!.id] }));
  expect(await cancelled).toEqual([
    { message: 'rejected', messageId: 'rejected' },
    { message: 'pending', messageId: 'pending' },
  ]);
});

test('a rejected input drained while cancellation is in flight does not invalidate its matching response', async () => {
  const { agent, internal, sent } = makeAgent();
  agent.redirect('rejected', { messageId: 'rejected' });
  agent.redirect('pending', { messageId: 'pending' });
  const cancelled = agent.settlePendingSteers();
  const barrier = sent.at(-1)!;
  internal.handleLine(JSON.stringify({ type: 'steer_rejected', id: sent[0]!.id }));
  expect(agent.takePendingSteers()).toEqual([{ message: 'rejected', messageId: 'rejected' }]);
  internal.handleLine(JSON.stringify({ type: 'steers_settled', id: barrier.id, success: true, pendingIds: [sent[0]!.id, sent[1]!.id] }));
  expect(await cancelled).toEqual([
    { message: 'rejected', messageId: 'rejected' },
    { message: 'pending', messageId: 'pending' },
  ]);
});

test('the public generator emits late delivery receipts and recovery before complete', async () => {
  const { agent, internal, sent } = makeAgent();
  internal.ensureSubprocess = async () => {};
  internal.send = (message: Record<string, any>) => {
    sent.push(message);
    if (message.type === 'prompt') {
      agent.redirect('consumed', { messageId: 'consumed' });
      agent.redirect('waiting', { messageId: 'waiting' });
      internal.eventQueue.enqueue({ type: 'complete' });
      internal.eventQueue.complete();
    } else if (message.type === 'settle_steers') {
      internal.handleLine(JSON.stringify({ type: 'steer_consumed', id: message.steerIds[0] }));
      internal.handleLine(JSON.stringify({ type: 'steers_settled', id: message.id, success: true, pendingIds: [message.steerIds[1]] }));
    }
  };
  const events: any[] = [];
  for await (const event of internal.chatImpl('initial')) events.push(event);
  expect(events).toEqual([
    { type: 'steer_accepted', messageId: 'consumed' },
    { type: 'steer_undelivered', message: 'waiting', messageId: 'waiting' },
    { type: 'complete' },
  ]);
});

test.each(['before barrier', 'after barrier', 'timeout retry', 'after barrier timeout retry'] as const)(
  'startup rejection received %s does not prevent a later queued input from being cancelled', async (timing) => {
    const { agent, internal, sent } = makeAgent();
    let observe: (event: any) => void = () => {};
    const queue: string[] = [];
    let aborts = 0;
    let holdResponses = timing.startsWith('after barrier');
    let dropSettlement = timing.endsWith('timeout retry');
    const responses: Record<string, any>[] = [];
    const jobs: Promise<void>[] = [];
    const respond = (response: Record<string, any>) => {
      if (response.type === 'steers_settled' && dropSettlement) { dropSettlement = false; return; }
      if (holdResponses) responses.push(response);
      else internal.handleLine(JSON.stringify(response));
    };
    const child = new PiSteerDelivery({
      subscribe: (callback: typeof observe) => { observe = callback; return () => {}; },
      getSteeringMessages: () => queue,
      steer: async (text: string) => { queue.push(text); observe({ type: 'queue_update', steering: [...queue] }); },
      abort: async () => { aborts++; },
      clearQueue: () => { queue.length = 0; observe({ type: 'queue_update', steering: [] }); },
    } as any, respond);
    internal.send = (command: Record<string, any>) => {
      sent.push(command);
      if (command.type === 'steer') jobs.push(child.enqueue(command.id, command.message, command.turnId));
      if (command.type === 'settle_steers') jobs.push(child.settle(command as any).then(
        pendingIds => respond({ type: 'steers_settled', id: command.id, success: true, pendingIds }),
        error => respond({ type: 'steers_settled', id: command.id, success: false, errorMessage: error.message,
          errorCode: error.code, unknownIds: error.unknownIds }),
      ));
    };
    try {
      // handlePrompt awaits session/compaction setup before beginTurn. The
      // concurrent stdin steer handler explicitly refuses this early input.
      agent.redirect('startup input', { messageId: 'early' });
      await Promise.all(jobs);
      child.beginTurn('turn-test');
      agent.redirect('queued input', { messageId: 'later' });
      await Promise.all(jobs);
      expect(queue).toEqual(['queued input']);
      if (timing.endsWith('timeout retry')) internal.steerSettlementTimeoutMs = 5;
      let cancelling = agent.settlePendingSteers();
      const firstBarrier = sent.at(-1)!;
      if (timing.startsWith('after barrier')) {
        await Promise.all(jobs);
        expect(aborts).toBe(0);
        holdResponses = false;
        for (const response of responses) internal.handleLine(JSON.stringify(response));
      }
      if (timing.endsWith('timeout retry')) {
        await expect(cancelling).rejects.toThrow('timed out');
        cancelling = agent.settlePendingSteers();
        expect(sent.at(-1)).toEqual(firstBarrier);
      }
      expect(await cancelling).toEqual([
        { message: 'startup input', messageId: 'early' },
        { message: 'queued input', messageId: 'later' },
      ]);
      expect(queue).toEqual([]);
      expect(aborts).toBe(1);
      const barriers = sent.filter(command => command.type === 'settle_steers');
      expect(barriers).toHaveLength(timing === 'before barrier' ? 1 : timing === 'after barrier timeout retry' ? 3 : 2);
      if (timing.startsWith('after barrier')) expect(barriers.at(-1)!.id).not.toBe(firstBarrier.id);
    } finally {
      child.dispose();
    }
  },
);

test('an unknown identity without its matching rejection receipt cannot reset the cancellation request', async () => {
  const { agent, internal, sent } = makeAgent();
  agent.redirect('uncertain input', { messageId: 'input' });
  agent.redirect('still waiting', { messageId: 'waiting' });
  const cancelling = agent.settlePendingSteers();
  const barrier = sent.at(-1)!;
  internal.handleLine(JSON.stringify({ type: 'steers_settled', id: barrier.id, success: false,
    errorCode: 'unknown_steer_ids', unknownIds: [sent[0]!.id], errorMessage: 'identity unknown' }));
  expect(agent.takePendingSteers()).toEqual([]);
  // A duplicate response cannot revive an attempt already rejected, even if
  // the missing receipt arrives before the promise's cleanup microtask.
  internal.handleLine(JSON.stringify({ type: 'steer_rejected', id: sent[0]!.id }));
  internal.handleLine(JSON.stringify({ type: 'steers_settled', id: barrier.id, success: false,
    errorCode: 'unknown_steer_ids', unknownIds: [sent[0]!.id], errorMessage: 'identity unknown' }));
  await expect(cancelling).rejects.toThrow('identity unknown');
  expect(agent.takePendingSteers()).toEqual([{ message: 'uncertain input', messageId: 'input' }]);
  expect(sent.filter(command => command.type === 'settle_steers')).toHaveLength(1);
});
