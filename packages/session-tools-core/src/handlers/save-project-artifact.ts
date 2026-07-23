import type {
  SaveProjectArtifactToolInput,
  SessionToolContext,
} from '../context.ts';
import { errorResponse } from '../response.ts';
import type { ToolResult } from '../types.ts';

export async function handleSaveProjectArtifact(
  ctx: SessionToolContext,
  args: SaveProjectArtifactToolInput,
): Promise<ToolResult> {
  if (!ctx.saveProjectArtifact) {
    return errorResponse('save_project_artifact is not available in this context. Bind this session to a Project first.');
  }

  try {
    const saved = await ctx.saveProjectArtifact(args);
    const payload = {
      artifactId: saved.artifactId,
      projectId: saved.projectId,
      title: saved.title,
      kind: 'project-artifact',
    } as const;
    return {
      content: [{ type: 'text', text: `Saved project artifact: ${JSON.stringify(payload)}` }],
      structuredContent: payload,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return errorResponse(`Failed to save project artifact: ${message}`);
  }
}
