export interface OpenProjectFileDocument {
  flush(): Promise<void>
  onExternalChange?(): void | Promise<void>
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

export async function flushOpenProjectFiles(): Promise<void> {
  const documents = new Set(
    Array.from(openDocuments.values()).flatMap(current => Array.from(current)),
  )
  await Promise.all(Array.from(documents, document => document.flush()))
}

export async function flushOpenProjectFile(
  projectId: string,
  relativePath: string,
): Promise<void> {
  const documents = openDocuments.get(documentKey(projectId, relativePath))
  if (!documents) return
  await Promise.all(Array.from(documents, document => document.flush()))
}

export async function notifyOpenProjectFileChanged(
  projectId: string,
  relativePath: string,
): Promise<void> {
  const documents = openDocuments.get(documentKey(projectId, relativePath))
  if (!documents) return
  await Promise.all(Array.from(documents, document => document.onExternalChange?.()))
}
