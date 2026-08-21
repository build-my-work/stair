import {
  MAX_REFERENCE_CONTEXT_CHARS,
  MAX_REFERENCE_QUOTE_CHARS,
  type ProjectFileReferenceV1,
  type SourceFingerprint,
  type TextQuoteLocatorV1,
} from '@craft-agent/core'

export function buildTextProjectFileReference(input: {
  projectId: string
  relativePath: string
  sourceFingerprint: SourceFingerprint
  fileName: string
  fullText: string
  selectionStart: number
  selectionEnd: number
}): ProjectFileReferenceV1 {
  if (
    !Number.isSafeInteger(input.selectionStart)
    || !Number.isSafeInteger(input.selectionEnd)
    || input.selectionStart < 0
    || input.selectionEnd > input.fullText.length
    || input.selectionEnd <= input.selectionStart
  ) {
    throw new Error('Select some text first.')
  }

  const selectedText = input.fullText.slice(input.selectionStart, input.selectionEnd)
  const quote = selectedText.trim()
  if (!quote) throw new Error('Select some text first.')
  if (quote.length > MAX_REFERENCE_QUOTE_CHARS) {
    throw new Error('The selection is too long. Select 4,000 characters or fewer.')
  }

  const leadingWhitespace = selectedText.length - selectedText.trimStart().length
  const start = input.selectionStart + leadingWhitespace
  const end = start + quote.length
  const contextBefore = input.fullText.slice(
    Math.max(0, start - MAX_REFERENCE_CONTEXT_CHARS),
    start,
  )
  const contextAfter = input.fullText.slice(
    end,
    end + MAX_REFERENCE_CONTEXT_CHARS,
  )

  return {
    version: 1,
    kind: 'project-file',
    projectId: input.projectId,
    relativePath: input.relativePath,
    sourceFingerprint: input.sourceFingerprint,
    fileName: input.fileName,
    quote,
    ...(contextBefore ? { contextBefore } : {}),
    ...(contextAfter ? { contextAfter } : {}),
    locator: {
      type: 'text-quote',
      exact: quote,
      ...(contextBefore ? { prefix: contextBefore } : {}),
      ...(contextAfter ? { suffix: contextAfter } : {}),
      start,
      end,
    },
  }
}

export function resolveTextQuoteOffset(
  fullText: string,
  locator: TextQuoteLocatorV1,
): number | null {
  if (
    fullText.slice(locator.start, locator.end) === locator.exact
    && locator.end - locator.start === locator.exact.length
  ) {
    return locator.start
  }

  let bestOffset: number | null = null
  let bestScore = -1
  const hasContext = Boolean(locator.prefix || locator.suffix)
  let offset = fullText.indexOf(locator.exact)
  while (offset >= 0) {
    const prefixMatches = locator.prefix
      ? fullText.slice(0, offset).endsWith(locator.prefix)
      : false
    const suffixMatches = locator.suffix
      ? fullText.slice(offset + locator.exact.length).startsWith(locator.suffix)
      : false
    const score = Number(prefixMatches) + Number(suffixMatches)
    if (score > bestScore) {
      bestOffset = offset
      bestScore = score
    }
    offset = fullText.indexOf(locator.exact, offset + 1)
  }
  return hasContext && bestScore === 0 ? null : bestOffset
}
