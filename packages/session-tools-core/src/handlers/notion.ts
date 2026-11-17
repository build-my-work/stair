import type { SessionToolContext } from '../context.ts'
import type { NotionToolCallbacks, NotionReadInput, NotionWriteInput } from '../notion.ts'
import { successResponse, errorResponse } from '../response.ts'

async function runNotionTool(ctx: SessionToolContext, operation: (notion: NotionToolCallbacks) => Promise<unknown>) {
  if (!ctx.notion) return errorResponse('Notion is unavailable in this session.')
  try {
    return successResponse(JSON.stringify(await operation(ctx.notion)))
  } catch (error) {
    return errorResponse(String(error))
  }
}

export function handleNotionOpen(ctx: SessionToolContext, args: { pageId: string }) {
  return runNotionTool(ctx, notion => notion.open(args.pageId))
}

export function handleNotionRead(ctx: SessionToolContext, args: NotionReadInput) {
  return runNotionTool(ctx, notion => notion.read(args))
}

export function handleNotionWrite(ctx: SessionToolContext, args: NotionWriteInput) {
  return runNotionTool(ctx, notion => notion.write(args))
}
