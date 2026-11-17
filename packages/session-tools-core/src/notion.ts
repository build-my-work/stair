/** Project Notion contracts shared by the tool registry, server and desktop. */
export interface NotionBinding {
  sourceSlug: string;
  rootPageId: string;
}

export interface NotionPage {
  pageId: string;
  title: string;
  url: string;
  kind: 'page' | 'database';
}

export type NotionReadInput = {
  pageId?: string;
  children?: boolean;
};

export type NotionWriteInput = {
  expectedPageId: string;
  content: string;
  /** Omit to append. Otherwise replace this exact, unique text. */
  oldText?: string;
};

export interface NotionToolCallbacks {
  open(pageId: string): Promise<unknown>;
  read(input: NotionReadInput): Promise<unknown>;
  write(input: NotionWriteInput): Promise<unknown>;
}

/** No credentials cross this desktop capability bridge. */
export type NotionHostRequest = {
  workspaceId: string;
  projectId: string;
} & (
  | { action: 'discover' }
  | { action: 'open'; pageId: string }
  | { action: 'current' }
);

export interface NotionHostState {
  hasPanel: boolean;
  canOpen: boolean;
  pageId: string | null;
  /** Changes on panel recreation/navigation; guards stale read → write. */
  revision: string | null;
}
