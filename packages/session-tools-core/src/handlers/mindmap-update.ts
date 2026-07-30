import type {
  MindmapUpdateRequest,
  SessionToolContext,
} from '../context.ts';
import type { ToolResult } from '../types.ts';
import { errorResponse, successResponse } from '../response.ts';

export type MindmapUpdateArgs = MindmapUpdateRequest;

export async function handleMindmapUpdate(
  ctx: SessionToolContext,
  args: MindmapUpdateArgs,
): Promise<ToolResult> {
  if (!ctx.updateMindmap) {
    return errorResponse('mindmap_update is not available in this context.');
  }

  try {
    const snapshot = await ctx.updateMindmap(args);
    return successResponse(JSON.stringify(snapshot, null, 2));
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return errorResponse(`Failed to update the open mind map: ${message}`);
  }
}
