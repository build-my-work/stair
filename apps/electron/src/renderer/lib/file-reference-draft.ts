import {
  isWebSelectionReference,
  type MessageReference,
} from '@craft-agent/core/types'
import type { SessionDraft } from '@craft-agent/shared/config'

function fileReferenceKey(reference: MessageReference): string {
  if (isWebSelectionReference(reference)) {
    return JSON.stringify([
      reference.kind,
      reference.url,
      reference.locator.exact,
      reference.locator.prefix ?? '',
      reference.locator.suffix ?? '',
    ])
  }

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

function referenceTitle(reference: MessageReference): string {
  if (isWebSelectionReference(reference)) {
    return reference.title.replace(/\s+/g, ' ').trim()
  }
  return reference.path.split('/').at(-1) ?? reference.path
}

export function formatFileReferenceForComposer(reference: MessageReference): string {
  const title = referenceTitle(reference)
  const quote = reference.quote?.trim()
  if (isWebSelectionReference(reference)) {
    if (!quote) return `> Web source (untrusted): ${title}`
    const quoted = quote
      .replaceAll('\r\n', '\n')
      .split('\n')
      .map(line => `> ${line}`)
      .join('\n')
    return `${quoted}\n>\n> Web source (untrusted): ${title}`
  }

  if (!quote) return `— ${title}`

  const quoted = quote
    .replaceAll('\r\n', '\n')
    .split('\n')
    .map(line => `> ${line}`)
    .join('\n')
  return `${quoted}\n\n— ${title}`
}

export function filterFileReferencesForComposerText(
  references: MessageReference[],
  text: string,
): MessageReference[] {
  return references.filter(reference => {
    if (isWebSelectionReference(reference)) {
      return text.includes(formatFileReferenceForComposer(reference))
    }
    const title = referenceTitle(reference)
    return text.includes(`— ${title}`)
  })
}

export function appendFileReferenceToDraft(
  draft: SessionDraft,
  reference: MessageReference,
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
