export interface DrawnixMindmapNode {
  id: string
  topic: string
  note?: string
  children: DrawnixMindmapNode[]
}

export interface DrawnixMindmapSnapshot {
  relativePath: string
  changeSeq: number
  roots: DrawnixMindmapNode[]
}

export type DrawnixMindmapOperation =
  | { type: 'populate_empty'; markdown: string }
  | { type: 'insert_child'; parentId: string; topic: string }
  | { type: 'insert_sibling'; nodeId: string; topic: string }
  | { type: 'set_topic'; nodeId: string; topic: string }
  | { type: 'set_note'; nodeId: string; note: string }

interface DrawnixBoardCapabilityBase {
  v: 1
  projectId: string
  relativePath: string
}

export interface DrawnixBoardReadCapabilityRequest
  extends DrawnixBoardCapabilityBase {
  action: 'read'
}

export interface DrawnixBoardCreateCapabilityRequest
  extends DrawnixBoardCapabilityBase {
  action: 'create'
  markdown: string
}

export interface DrawnixBoardUpdateCapabilityRequest
  extends DrawnixBoardCapabilityBase {
  action: 'update'
  expectedChangeSeq: number
  operations: DrawnixMindmapOperation[]
}

export type DrawnixBoardCapabilityRequest =
  | DrawnixBoardCreateCapabilityRequest
  | DrawnixBoardReadCapabilityRequest
  | DrawnixBoardUpdateCapabilityRequest

export type DrawnixBoardCapabilityResponse =
  | { ok: true; snapshot: DrawnixMindmapSnapshot }
  | { ok: false; error: { code: string; message: string } }

/** Side-effect-free discovery, carried on its own capability for old-client safety. */
export type DrawnixBoardDiscoveryRequest = DrawnixBoardCapabilityBase

export type DrawnixBoardDiscoveryResponse =
  | { ok: true; boardCount: number; canCreate: boolean }
  | { ok: false; error: { code: string; message: string } }
