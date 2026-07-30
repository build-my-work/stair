import { describe, expect, it } from 'bun:test';
import type { SessionToolContext } from '../context.ts';
import { handleMindmapRead } from './mindmap-read.ts';
import { handleMindmapUpdate } from './mindmap-update.ts';

describe('mind-map session tools', () => {
  it('reads the live Board snapshot through the session callback', async () => {
    const calls: string[] = [];
    const ctx = {
      readMindmap: async (relativePath: string) => {
        calls.push(relativePath);
        return {
          relativePath,
          changeSeq: 3,
          roots: [{ id: 'root', topic: 'Tutorial', children: [] }],
        };
      },
    } as unknown as SessionToolContext;

    const result = await handleMindmapRead(ctx, {
      relativePath: 'maps/tutorial.drawnix',
    });

    expect(result.isError).toBe(false);
    expect(calls).toEqual(['maps/tutorial.drawnix']);
    expect(result.content[0]?.text).toContain('"changeSeq": 3');
    expect(result.content[0]?.text).toContain('"topic": "Tutorial"');
  });

  it('passes the stale-read guard and operations through unchanged', async () => {
    const requests: unknown[] = [];
    const ctx = {
      updateMindmap: async (request: unknown) => {
        requests.push(request);
        return {
          relativePath: 'maps/tutorial.drawnix',
          changeSeq: 4,
          roots: [],
        };
      },
    } as unknown as SessionToolContext;
    const request = {
      relativePath: 'maps/tutorial.drawnix',
      expectedChangeSeq: 3,
      operations: [{
        type: 'insert_child' as const,
        parentId: 'root',
        topic: 'New topic',
      }],
    };

    const result = await handleMindmapUpdate(ctx, request);

    expect(result.isError).toBe(false);
    expect(requests).toEqual([request]);
    expect(result.content[0]?.text).toContain('"changeSeq": 4');
  });

  it('returns explicit tool errors when no open-Board callback is available', async () => {
    const ctx = {} as SessionToolContext;

    const read = await handleMindmapRead(ctx, {
      relativePath: 'maps/tutorial.drawnix',
    });
    const update = await handleMindmapUpdate(ctx, {
      relativePath: 'maps/tutorial.drawnix',
      expectedChangeSeq: 0,
      operations: [{ type: 'populate_empty', markdown: '# Tutorial' }],
    });

    expect(read.isError).toBe(true);
    expect(read.content[0]?.text).toContain('mindmap_read is not available');
    expect(update.isError).toBe(true);
    expect(update.content[0]?.text).toContain('mindmap_update is not available');
  });

  it('surfaces a closed-board failure without claiming an update occurred', async () => {
    const ctx = {
      updateMindmap: async () => {
        throw new Error(
          'MINDMAP_NOT_OPEN: Open maps/tutorial.drawnix in Project Files first.',
        );
      },
    } as unknown as SessionToolContext;

    const result = await handleMindmapUpdate(ctx, {
      relativePath: 'maps/tutorial.drawnix',
      expectedChangeSeq: 0,
      operations: [{ type: 'populate_empty', markdown: '# Tutorial' }],
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('MINDMAP_NOT_OPEN');
    expect(result.content[0]?.text).toContain('Open maps/tutorial.drawnix');
  });
});
