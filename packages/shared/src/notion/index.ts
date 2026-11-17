export type { NotionBinding, NotionPage, NotionHostRequest, NotionHostState } from '@craft-agent/session-tools-core/notion';

export const NOTION_HOSTS = ['notion.so', 'www.notion.so', 'notion.com', 'www.notion.com', 'app.notion.com'];

/** Canonicalize only Notion UUIDs; never interpret an arbitrary URL as a page. */
export function notionPageId(value: string): string {
  const compact = value.replaceAll('-', '');
  if (!/^[a-f0-9]{32}$/i.test(compact)) throw new Error('NOTION_INVALID_PAGE: A Notion page ID is required.');
  return compact.toLowerCase().replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5');
}

export function notionPageIdFromUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || !NOTION_HOSTS.includes(url.hostname)) return null;
    // A peek page can differ from the page in the pathname. Require a full page.
    if (url.searchParams.has('p')) return null;
    const match = url.pathname.match(/(?:^|[/-])([a-f0-9]{32}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})\/?$/i);
    return match ? notionPageId(match[1]!) : null;
  } catch { return null; }
}

export function parseNotionPage(value: string): string {
  return notionPageIdFromUrl(value.trim()) ?? notionPageId(value.trim());
}

export function notionPageUrl(pageId: string): string {
  return `https://www.notion.so/${notionPageId(pageId).replaceAll('-', '')}`;
}

export const NOTION_PARTITION = 'persist:project-notion'
export type NotionViewRequest = { projectId: string } & (
  | { action: 'attach'; guestId: number; theme: 'light' | 'dark' }
  | { action: 'theme'; theme: 'light' | 'dark' }
  | { action: 'open'; pageId: string; agent?: boolean }
  | { action: 'current' }
  | { action: 'close' }
);

export interface NotionViewState {
  pageId: string | null
  revision: string
  title: string
  url: string
  loading: boolean
  error: string | null
}
