import type { FileReference } from '@craft-agent/core/types'
import type { SessionDraft } from '@craft-agent/shared/config'

function fileReferenceKey(reference: FileReference): string {
  const locator = reference.locator
  switch (locator.type) {
    case 'epub-cfi':
      return `${reference.projectId}\0${reference.path}\0epub-cfi\0${locator.cfiRange}`
    case 'pdf-page':
      return `${reference.projectId}\0${reference.path}\0pdf-page\0${locator.page}`
    case 'text-range':
      return `${reference.projectId}\0${reference.path}\0text-range\0${locator.startLine}\0${locator.endLine}`
  }
}

export function formatFileReferenceForComposer(reference: FileReference): string {
  const title = reference.path.split('/').at(-1) ?? reference.path
  const quote = reference.quote?.trim()
  if (!quote) return `— ${title}`

  const quoted = quote
    .replaceAll('\r\n', '\n')
    .split('\n')
    .map(line => `> ${line}`)
    .join('\n')
  return `${quoted}\n\n— ${title}`
}

export function filterFileReferencesForComposerText(
  references: FileReference[],
  text: string,
): FileReference[] {
  return references.filter(reference => {
    const title = reference.path.split('/').at(-1) ?? reference.path
    return text.includes(`— ${title}`)
  })
}

export function appendFileReferenceToDraft(
  draft: SessionDraft,
  reference: FileReference,
): SessionDraft {
  const references = draft.references ?? []
  const key = fileReferenceKey(reference)
  if (references.some(item => fileReferenceKey(item) === key)) return draft

  const citation = formatFileReferenceForComposer(reference)
  return {
    ...draft,
    text: draft.text ? `${draft.text}\n\n${citation}` : citation,
    references: [...references, reference],
  }
}
