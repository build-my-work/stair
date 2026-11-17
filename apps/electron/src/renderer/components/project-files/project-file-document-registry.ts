export type ProjectFileFlushImageWait = 'idle' | 'timeout'

export interface OpenProjectFileDocument {
  /** May resolve with Drawnix image-wait status (`idle` | `timeout`); other docs resolve void. */
  flush(): Promise<void | ProjectFileFlushImageWait>
}

const openDocuments = new Map<string, Set<OpenProjectFileDocument>>()

function documentKey(projectId: string, relativePath: string): string {
  return `${projectId}\0${relativePath}`
}

export function registerOpenProjectFileDocument(
  projectId: string,
  relativePath: string,
  document: OpenProjectFileDocument,
): () => void {
  const key = documentKey(projectId, relativePath)
  const documents = openDocuments.get(key) ?? new Set()
  documents.add(document)
  openDocuments.set(key, documents)

  return () => {
    const current = openDocuments.get(key)
    if (!current) return
    current.delete(document)
    if (current.size === 0) openDocuments.delete(key)
  }
}

async function flushDocuments(
  documents: Iterable<OpenProjectFileDocument>,
): Promise<ProjectFileFlushImageWait> {
  const results = await Promise.all(
    Array.from(new Set(documents), document => document.flush()),
  )
  return results.includes('timeout') ? 'timeout' : 'idle'
}

export async function flushOpenProjectFile(
  projectId: string,
  relativePath: string,
): Promise<ProjectFileFlushImageWait> {
  return flushDocuments(openDocuments.get(documentKey(projectId, relativePath)) ?? [])
}

export async function flushOpenProjectFilesForProject(
  projectId: string,
): Promise<ProjectFileFlushImageWait> {
  const documents: OpenProjectFileDocument[] = []
  for (const [key, current] of openDocuments) {
    if (key.startsWith(`${projectId}\0`)) documents.push(...current)
  }
  return flushDocuments(documents)
}

export async function flushOpenProjectFiles(): Promise<ProjectFileFlushImageWait> {
  return flushDocuments(Array.from(openDocuments.values()).flatMap(documents => [...documents]))
}
