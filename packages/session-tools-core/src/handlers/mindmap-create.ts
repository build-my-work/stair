import type { MindmapCreateRequest, SessionToolContext } from '../context.ts';
import type { ToolResult } from '../types.ts';
import { errorResponse, successResponse } from '../response.ts';

export type MindmapCreateArgs = MindmapCreateRequest;

export async function handleMindmapCreate(
  ctx: SessionToolContext,
  args: MindmapCreateArgs,
): Promise<ToolResult> {
  if (!ctx.createMindmap) {
    return errorResponse('mindmap_create is not available in this context.');
  }
  try {
    return successResponse(JSON.stringify(await ctx.createMindmap(args), null, 2));
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return errorResponse(`Failed to create the mind map: ${message}`);
  }
}
