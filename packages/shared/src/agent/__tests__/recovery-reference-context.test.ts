import { describe, expect, it } from 'bun:test';

import type { RecoveryMessage } from '../core/types.ts';
import { TestAgent, createMockBackendConfig } from './test-utils.ts';

const referenceContext = [
  '<stair_reference_data trust="untrusted">',
  JSON.stringify([{ relativePath: 'docs/guide.md', quote: 'q'.repeat(2_000) }], null, 2),
  '</stair_reference_data>',
].join('\n');

class RecoveryContextTestAgent extends TestAgent {
  getRecoveryContextForTest(): string | null {
    return this.buildRecoveryContext();
  }

  getBranchSeedContextForTest(messages: RecoveryMessage[]): string | null {
    return this.buildBranchSeedContext(messages);
  }
}

function expectIntactReferenceContext(output: string | null): void {
  expect(output).not.toBeNull();
  expect(output).toContain(referenceContext);
  expect(output?.match(/<stair_reference_data trust="untrusted">/g)).toHaveLength(1);
  expect(output?.match(/<\/stair_reference_data>/g)).toHaveLength(1);
}

describe('recovery reference context', () => {
  it('keeps reference data intact when BaseAgent truncates recovery content', () => {
    const agent = new RecoveryContextTestAgent(createMockBackendConfig({
      getRecoveryMessages: () => [{
        type: 'user',
        content: 'visible '.repeat(300),
        referenceContext,
      }],
    }));

    const output = agent.getRecoveryContextForTest();

    expect(output).toContain('...[truncated]');
    expectIntactReferenceContext(output);
  });

  it('keeps reference data intact when BaseAgent truncates branch seed content', () => {
    const agent = new RecoveryContextTestAgent(createMockBackendConfig());

    const output = agent.getBranchSeedContextForTest([{
      type: 'user',
      content: 'visible '.repeat(300),
      referenceContext,
    }]);

    expect(output).toContain('...[truncated]');
    expectIntactReferenceContext(output);
  });

  it('keeps reference data intact when PromptBuilder truncates recovery content', () => {
    const builder = new RecoveryContextTestAgent(createMockBackendConfig()).getPromptBuilder();

    const output = builder.buildRecoveryContext([{
      type: 'user',
      content: 'visible '.repeat(300),
      referenceContext,
    }]);

    expect(output).toContain('...[truncated]');
    expectIntactReferenceContext(output);
  });
});
