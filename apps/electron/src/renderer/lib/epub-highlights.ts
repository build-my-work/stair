import type { EpubHighlightV1, EpubTocNode } from '@craft-agent/core/types'

export type CompareCfi = (left: string, right: string) => number

export interface EpubHighlightTreeNode {
  node: EpubTocNode
  highlights: EpubHighlightV1[]
  children: EpubHighlightTreeNode[]
}

export interface EpubHighlightTree {
  nodes: EpubHighlightTreeNode[]
  unmatched: EpubHighlightV1[]
}

export function compareEpubHighlights(
  left: EpubHighlightV1,
  right: EpubHighlightV1,
  compareCfi: CompareCfi,
): number {
  const leftSpine = left.spineIndex ?? Number.POSITIVE_INFINITY
  const rightSpine = right.spineIndex ?? Number.POSITIVE_INFINITY
  if (leftSpine !== rightSpine) return leftSpine - rightSpine

  try {
    const cfiOrder = compareCfi(left.cfiRange, right.cfiRange)
    if (cfiOrder !== 0) return cfiOrder
  } catch {
    // Invalid third-party CFI: fall through to stable server fields.
  }

  if (left.createdAt !== right.createdAt) return left.createdAt - right.createdAt
  return left.id.localeCompare(right.id)
}

export function buildEpubHighlightTree(
  toc: EpubTocNode[],
  highlights: EpubHighlightV1[],
  compareCfi: CompareCfi,
): EpubHighlightTree {
  const knownKeys = new Set<string>()
  const collectKeys = (nodes: EpubTocNode[]) => {
    for (const node of nodes) {
      knownKeys.add(node.key)
      collectKeys(node.children)
    }
  }
  collectKeys(toc)

  const byKey = new Map<string, EpubHighlightV1[]>()
  const unmatched: EpubHighlightV1[] = []
  for (const highlight of highlights) {
    const tocKey = [...highlight.tocPath]
      .reverse()
      .find(entry => knownKeys.has(entry.key))
      ?.key
    if (!tocKey) {
      unmatched.push(highlight)
      continue
    }
    const group = byKey.get(tocKey) ?? []
    group.push(highlight)
    byKey.set(tocKey, group)
  }

  const sort = (values: EpubHighlightV1[]) => [...values].sort(
    (left, right) => compareEpubHighlights(left, right, compareCfi),
  )
  const buildNodes = (nodes: EpubTocNode[]): EpubHighlightTreeNode[] => {
    const result: EpubHighlightTreeNode[] = []
    for (const node of nodes) {
      const children = buildNodes(node.children)
      const ownHighlights = sort(byKey.get(node.key) ?? [])
      if (children.length === 0 && ownHighlights.length === 0) continue
      result.push({ node, highlights: ownHighlights, children })
    }
    return result
  }

  return {
    nodes: buildNodes(toc),
    unmatched: sort(unmatched),
  }
}

function escapeMarkdownTitle(value: string): string {
  return value.replace(/([\\`*_[\]{}()#+\-.!|<>])/g, '\\$1')
}

function quoteMarkdown(value: string): string {
  return value
    .replaceAll('\r\n', '\n')
    .replaceAll('\r', '\n')
    .split('\n')
    .map(line => line ? `> ${line}` : '>')
    .join('\n')
}

function heading(title: string, tocDepth: number): string {
  const level = tocDepth + 2
  const escaped = escapeMarkdownTitle(title)
  return level <= 6 ? `${'#'.repeat(level)} ${escaped}` : `**${escaped}**`
}

export function buildEpubHighlightsMarkdown(input: {
  bookTitle?: string
  fileName: string
  toc: EpubTocNode[]
  highlights: EpubHighlightV1[]
  compareCfi: CompareCfi
}): string {
  if (input.highlights.length === 0) return ''

  const tree = buildEpubHighlightTree(
    input.toc,
    input.highlights,
    input.compareCfi,
  )
  const sections: string[] = [`# ${escapeMarkdownTitle(input.bookTitle?.trim() || input.fileName)}`]

  const renderNode = (entry: EpubHighlightTreeNode, depth: number): string[] => {
    return [
      heading(entry.node.title, depth),
      ...entry.highlights.map(highlight => quoteMarkdown(highlight.quote)),
      ...entry.children.flatMap(child => renderNode(child, depth + 1)),
    ]
  }

  for (const node of tree.nodes) sections.push(...renderNode(node, 0))

  if (tree.unmatched.length > 0) {
    sections.push('## 未识别章节')
    sections.push(...tree.unmatched.map(highlight => quoteMarkdown(highlight.quote)))
  }

  return `${sections.join('\n\n').trimEnd()}\n`
}
