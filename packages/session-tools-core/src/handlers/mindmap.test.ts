import { describe, expect, it } from 'bun:test';
import type { SessionToolContext } from '../context.ts';
import { handleMindmapRead } from './mindmap-read.ts';
import { handleMindmapUpdate } from './mindmap-update.ts';

describe('mind-map session tools', () => {
  it('reads and updates the live board through session callbacks', async () => {
    const reads: string[] = [];
    const updates: unknown[] = [];
    const ctx = {
      readMindmap: async (relativePath: string) => {
        reads.push(relativePath);
        return {
          relativePath,
          changeSeq: 3,
          roots: [{ id: 'root', topic: 'Tutorial', children: [] }],
        };
      },
      updateMindmap: async (request: unknown) => {
        updates.push(request);
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

    const read = await handleMindmapRead(ctx, {
      relativePath: 'maps/tutorial.drawnix',
    });
    const update = await handleMindmapUpdate(ctx, request);

    expect(read.isError).toBe(false);
    expect(read.content[0]?.text).toContain('"changeSeq": 3');
    expect(update.isError).toBe(false);
    expect(reads).toEqual(['maps/tutorial.drawnix']);
    expect(updates).toEqual([request]);
  });

  it('fails explicitly when the board callback is unavailable or closed', async () => {
    const unavailable = {} as SessionToolContext;
    expect((await handleMindmapRead(unavailable, {
      relativePath: 'maps/tutorial.drawnix',
    })).isError).toBe(true);

    const closed = {
      updateMindmap: async () => {
        throw new Error('MINDMAP_NOT_OPEN: Open maps/tutorial.drawnix first.');
      },
    } as unknown as SessionToolContext;
    const result = await handleMindmapUpdate(closed, {
      relativePath: 'maps/tutorial.drawnix',
      expectedChangeSeq: 0,
      operations: [{ type: 'populate_empty', markdown: '# Tutorial' }],
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('MINDMAP_NOT_OPEN');
  });
});
