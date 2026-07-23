import { describe, expect, it } from 'bun:test';

import type { SessionToolContext } from '../context.ts';
import { SESSION_TOOL_REGISTRY } from '../tool-defs.ts';
import { handleSaveProjectArtifact } from './save-project-artifact.ts';

const args = {
  title: 'Scheduling notes',
  markdown: '# Scheduling\n\nRound-robin trades latency for fairness.',
  templateId: 'reading-note',
  references: [{
    path: '操作系统导论（异步图书） .epub',
    quote: 'Round-robin runs each process for a time slice.',
    locator: { type: 'epub-cfi' as const, cfiRange: 'epubcfi(/6/4!/4/2,/1:0,/1:4)' },
  }],
};

describe('save_project_artifact', () => {
  it('is a blocked write tool and never accepts a caller-selected project or disk path', () => {
    const definition = SESSION_TOOL_REGISTRY.get('save_project_artifact');
    expect(definition?.safeMode).toBe('block');
    expect(definition?.executionMode).toBe('registry');

    const parsed = definition!.inputSchema.safeParse({
      ...args,
      projectId: 'untrusted-project',
      projectSlug: '../../outside',
      outputPath: '/tmp/note.md',
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data).not.toHaveProperty('projectId');
      expect(parsed.data).not.toHaveProperty('projectSlug');
      expect(parsed.data).not.toHaveProperty('outputPath');
    }
  });

  it('delegates persistence to the trusted session capability and returns a durable card payload', async () => {
    let received: unknown;
    const context = {
      saveProjectArtifact: async (input: unknown) => {
        received = input;
        return { artifactId: 'artifact_12345678', projectId: 'proj_12345678', title: 'Scheduling notes' };
      },
    } as SessionToolContext;

    const result = await handleSaveProjectArtifact(context, args);

    expect(received).toEqual(args);
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual({
      artifactId: 'artifact_12345678',
      projectId: 'proj_12345678',
      title: 'Scheduling notes',
      kind: 'project-artifact',
    });
    expect(result.content[0]?.text).toContain('artifact_12345678');
  });

  it('fails clearly when the session is not bound to the persistence capability', async () => {
    const result = await handleSaveProjectArtifact({} as SessionToolContext, args);
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('not available');
  });
});
