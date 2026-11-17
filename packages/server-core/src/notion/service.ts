import { buildApiAuthHeaders } from '@craft-agent/session-tools-core/api-auth';
import type { NotionBinding, NotionPage, NotionWriteInput } from '@craft-agent/session-tools-core/notion';
import { loadSource, getSourceCredentialManager } from '@craft-agent/shared/sources';
import { notionPageId, notionPageUrl } from '@craft-agent/shared/notion';

type Parent = { type: string; page_id?: string; block_id?: string; database_id?: string; data_source_id?: string };
type Entity = {
  id: string;
  object: string;
  parent?: Parent;
  archived?: boolean;
  is_archived?: boolean;
  in_trash?: boolean;
  properties?: Record<string, { type?: string; title?: Array<{ plain_text?: string }> }>;
  type?: string;
  has_children?: boolean;
  child_page?: { title: string };
  child_database?: { title: string };
};
export type NotionDocument = NotionPage & { markdown: string; truncated: boolean; unknown_block_ids: string[] };

/** One REST path for the tree and Project tools; the base URL is never caller-controlled. */
export class ProjectNotionService {
  private requests = 0;
  constructor(
    readonly binding: NotionBinding,
    private readonly headers: Record<string, string>,
    private readonly request: typeof fetch = fetch,
  ) {}

  private async api<T>(path: string, body?: unknown): Promise<T> {
    if (++this.requests > 1000) throw new Error('NOTION_REQUEST_LIMIT: Narrow the page selection and try again.');
    const writing = body !== undefined;
    let response: Response;
    try {
      response = await this.request(`https://api.notion.com/v1/${path}`, {
        method: writing ? 'PATCH' : 'GET',
        headers: this.headers,
        body: writing ? JSON.stringify(body) : undefined,
        redirect: 'error',
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      throw new Error(writing
        ? 'NOTION_WRITE_UNKNOWN: The write result is unknown. Read the page before attempting another write.'
        : 'NOTION_UNAVAILABLE: Could not reach Notion.');
    }
    if (!response.ok) {
      if (writing && response.status >= 500) throw new Error('NOTION_WRITE_UNKNOWN: Read the page before retrying this write.');
      if (response.status === 429) throw new Error(`NOTION_RATE_LIMIT: Retry after ${response.headers.get('Retry-After') ?? 'a few'} seconds.`);
      // Never forward response bodies which can contain page text or credentials.
      throw new Error(`NOTION_API_${response.status}: Check the connection and page access.`);
    }
    try { return await response.json() as T; }
    catch { throw new Error(writing ? 'NOTION_WRITE_UNKNOWN: Read the page before retrying.' : 'NOTION_INVALID_RESPONSE'); }
  }

  async page(pageId: string): Promise<Entity> {
    const page = await this.api<Entity>(`pages/${notionPageId(pageId)}`);
    if (page.object !== 'page' || page.archived || page.is_archived || page.in_trash) throw new Error('NOTION_PAGE_UNAVAILABLE');
    return page;
  }

  async assertWithinRoot(pageId: string): Promise<Entity> {
    const first = await this.page(pageId);
    let current = first;
    const visited = new Set<string>();
    const root = notionPageId(this.binding.rootPageId);
    while (true) {
      const id = notionPageId(current.id);
      if (id === root) return first;
      if (visited.has(id)) throw new Error('NOTION_INVALID_PARENT: Parent cycle detected.');
      visited.add(id);
      const parent = current.parent;
      if (parent?.type === 'page_id' && parent.page_id) {
        current = await this.page(parent.page_id);
      } else if (parent?.type === 'block_id' && parent.block_id) {
        current = await this.api<Entity>(`blocks/${notionPageId(parent.block_id)}`);
      } else {
        throw new Error('NOTION_OUTSIDE_PROJECT: Choose a page below this Project’s Notion root. Database records are not supported.');
      }
    }
  }

  async children(pageId = this.binding.rootPageId): Promise<NotionPage[]> {
    await this.assertWithinRoot(pageId);
    const queue = [notionPageId(pageId)];
    const visited = new Set<string>();
    const pages: NotionPage[] = [];
    for (let i = 0; i < queue.length; i++) {
      const blockId = queue[i]!;
      if (visited.has(blockId)) continue;
      visited.add(blockId);
      let cursor: string | undefined;
      const cursors = new Set<string>();
      do {
        const query = new URLSearchParams({ page_size: '100' });
        if (cursor) query.set('start_cursor', cursor);
        const result = await this.api<{ results: Entity[]; has_more: boolean; next_cursor: string | null }>(`blocks/${blockId}/children?${query}`);
        if (!Array.isArray(result.results)) throw new Error('NOTION_INVALID_RESPONSE');
        for (const block of result.results) {
          if (block.archived || block.in_trash) continue;
          if (block.type === 'child_page' || block.type === 'child_database') {
            pages.push({
              pageId: notionPageId(block.id),
              title: block.child_page?.title ?? block.child_database?.title ?? '',
              url: notionPageUrl(block.id),
              kind: block.type === 'child_page' ? 'page' : 'database',
            });
          } else if (block.has_children) queue.push(notionPageId(block.id));
        }
        cursor = result.has_more ? result.next_cursor ?? undefined : undefined;
        if (result.has_more && (!cursor || cursors.has(cursor))) throw new Error('NOTION_INVALID_PAGINATION');
        if (cursor) cursors.add(cursor);
      } while (cursor);
    }
    return pages;
  }

  async read(pageId: string): Promise<NotionDocument> {
    const page = await this.assertWithinRoot(pageId);
    const result = await this.api<{ markdown: string; truncated: boolean; unknown_block_ids: string[] }>(`pages/${notionPageId(pageId)}/markdown?markdown_version=v2`);
    if (typeof result.markdown !== 'string') throw new Error('NOTION_INVALID_RESPONSE');
    const title = Object.values(page.properties ?? {}).find(value => value.type === 'title')?.title
      ?.map(text => text.plain_text ?? '').join('') ?? '';
    return { pageId: notionPageId(page.id), title, url: notionPageUrl(page.id), kind: 'page', ...result };
  }

  async write(input: NotionWriteInput, assertCurrent: () => Promise<void>): Promise<NotionDocument> {
    if (typeof input.content !== 'string' || (!input.content && input.oldText === undefined) || Buffer.byteLength(input.content, 'utf8') > 200_000) throw new Error('NOTION_INVALID_CONTENT: Write between 1 and 200000 UTF-8 bytes.');
    const doc = await this.read(input.expectedPageId);
    if (doc.truncated || doc.unknown_block_ids?.length) throw new Error('NOTION_INCOMPLETE_PAGE: Cannot safely modify incomplete content.');
    if (input.oldText !== undefined) {
      if (!input.oldText || doc.markdown.split(input.oldText).length !== 2) throw new Error('NOTION_TEXT_CHANGED: The text must match exactly once. Read the page again.');
    }
    // The desktop check runs immediately before dispatch, after all REST reads.
    await assertCurrent();
    const result = await this.api<{ markdown: string; truncated: boolean; unknown_block_ids: string[]; warnings?: unknown[] }>(`pages/${doc.pageId}/markdown`, {
      markdown_version: 'v2',
      ...(input.oldText === undefined
        ? { type: 'insert_content', insert_content: { content: input.content, position: { type: 'end' } } }
        : { type: 'update_content', update_content: { content_updates: [{ old_str: input.oldText, new_str: input.content }] } }),
    });
    return { ...doc, ...result };
  }
}

export async function projectNotionService(workspaceRoot: string, binding: NotionBinding): Promise<ProjectNotionService> {
  if (!binding || typeof binding.sourceSlug !== 'string' || !/^[a-z0-9][a-z0-9_-]*$/i.test(binding.sourceSlug)) throw new Error('NOTION_INVALID_CONNECTION');
  notionPageId(binding.rootPageId);
  const source = loadSource(workspaceRoot, binding.sourceSlug);
  if (source?.config.type !== 'api' || source.config.api?.authType !== 'bearer'
    || source.config.api.baseUrl.replace(/\/+$/, '') !== 'https://api.notion.com') {
    throw new Error('NOTION_INVALID_CONNECTION: Choose a Notion API Source with https://api.notion.com and bearer authentication.');
  }
  const credential = await getSourceCredentialManager().getApiCredential(source);
  if (typeof credential !== 'string' || !credential) throw new Error('NOTION_AUTH_REQUIRED: Set the API Source credential in Stair.');
  return new ProjectNotionService(binding, buildApiAuthHeaders({ type: 'bearer' }, credential, { 'Notion-Version': '2026-03-11' }));
}
