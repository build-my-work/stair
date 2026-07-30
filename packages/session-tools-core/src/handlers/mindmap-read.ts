import type { SessionToolContext } from '../context.ts';
import type { ToolResult } from '../types.ts';
import { errorResponse, successResponse } from '../response.ts';

export interface MindmapReadArgs {
  relativePath: string;
}

export async function handleMindmapRead(
  ctx: SessionToolContext,
  args: MindmapReadArgs,
): Promise<ToolResult> {
  if (!ctx.readMindmap) {
    return errorResponse('mindmap_read is not available in this context.');
  }

  try {
    const snapshot = await ctx.readMindmap(args.relativePath);
    return successResponse(JSON.stringify(snapshot, null, 2));
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return errorResponse(`Failed to read the open mind map: ${message}`);
  }
}
