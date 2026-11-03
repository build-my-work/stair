import { describe, expect, it } from 'bun:test';
import type { MindmapUpdateRequest, SessionToolContext } from '../context.ts';
import { handleMindmapCreate } from './mindmap-create.ts';
import { handleMindmapRead } from './mindmap-read.ts';
import { handleMindmapUpdate } from './mindmap-update.ts';
import { MindmapUpdateSchema } from '../tool-defs.ts';

describe('mind-map session tools', () => {
  it('accepts detailed notes and explicit removal without weakening the update guard', () => {
    const request: MindmapUpdateRequest = {
      relativePath: 'maps/notes.drawnix',
      expectedChangeSeq: 4,
      operations: [{ type: 'set_note', nodeId: 'root', note: '细节\n笔记' }],
    };
    expect(MindmapUpdateSchema.parse(request)).toEqual(request);
    expect(MindmapUpdateSchema.safeParse({
      ...request,
      operations: [{ type: 'set_note', nodeId: 'root', note: '' }],
    }).success).toBe(true);
    expect(MindmapUpdateSchema.safeParse({ ...request, expectedChangeSeq: undefined }).success).toBe(false);
    expect(MindmapUpdateSchema.safeParse({
      ...request,
      operations: [{ type: 'set_note', nodeId: 'root', note: 42 }],
    }).success).toBe(false);
  });

  it('creates a native mind map through the session callback', async () => {
    const requests: unknown[] = [];
    const ctx = {
      createMindmap: async (request: unknown) => {
        requests.push(request);
        return {
          relativePath: 'mindmaps/tutorial.drawnix',
          changeSeq: 0,
          roots: [{ id: 'root', topic: 'Tutorial', children: [] }],
        };
      },
    } as unknown as SessionToolContext;
    const request = {
      relativePath: 'mindmaps/tutorial.drawnix',
      markdown: '# Tutorial',
    };

    const result = await handleMindmapCreate(ctx, request);

    expect(result.isError).toBe(false);
    expect(result.content[0]?.text).toContain('mindmaps/tutorial.drawnix');
    expect(requests).toEqual([request]);
  });

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
    expect((await handleMindmapCreate(unavailable, {
      relativePath: 'mindmaps/tutorial.drawnix',
      markdown: '# Tutorial',
    })).isError).toBe(true);
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
