import type { ImportedChapter } from './types.ts';

interface SourceLine {
  text: string;
  startOffset: number;
  lineNumber: number;
}

interface MarkdownHeading {
  title: string;
  level: number;
  startOffset: number;
  lineNumber: number;
}

interface Fence {
  marker: '`' | '~';
  length: number;
}

/**
 * Parse Markdown ATX headings into independently selectable, flat chapters.
 *
 * Each chapter starts at its heading and ends immediately before the next
 * heading at the same or a higher level. Consequently, parent chapter content
 * includes all of its nested sections. Line numbers are one-based and
 * inclusive.
 */
export function parseMarkdownChapters(markdown: string, fallbackTitle: string): ImportedChapter[] {
  const lines = splitSourceLines(markdown);
  const headings = findHeadings(lines, fallbackTitle);

  if (headings.length === 0) {
    return [{
      id: chapterIdBase(fallbackTitle, 1),
      title: fallbackTitle,
      level: 1,
      order: 0,
      locator: {
        format: 'markdown',
        startLine: 1,
        endLine: lines[lines.length - 1]!.lineNumber,
      },
      content: markdown,
    }];
  }

  const usedIds = new Set<string>();

  return headings.map((heading, index) => {
    const boundary = headings
      .slice(index + 1)
      .find((candidate) => candidate.level <= heading.level);
    const endOffset = boundary?.startOffset ?? markdown.length;
    const endLine = boundary?.lineNumber
      ? boundary.lineNumber - 1
      : lines[lines.length - 1]!.lineNumber;

    return {
      id: uniqueChapterId(chapterIdBase(heading.title, heading.lineNumber), usedIds),
      title: heading.title,
      level: heading.level,
      order: index,
      locator: {
        format: 'markdown' as const,
        startLine: heading.lineNumber,
        endLine,
      },
      content: markdown.slice(heading.startOffset, endOffset),
    };
  });
}

function splitSourceLines(source: string): SourceLine[] {
  if (source.length === 0) {
    return [{ text: '', startOffset: 0, lineNumber: 1 }];
  }

  const lines: SourceLine[] = [];
  let lineStart = 0;
  let lineNumber = 1;

  for (let index = 0; index < source.length; index += 1) {
    const code = source.charCodeAt(index);
    if (code !== 10 && code !== 13) continue;

    lines.push({
      text: source.slice(lineStart, index),
      startOffset: lineStart,
      lineNumber,
    });

    if (code === 13 && source.charCodeAt(index + 1) === 10) index += 1;
    lineStart = index + 1;
    lineNumber += 1;
  }

  // A terminal newline closes the preceding line; it does not create an extra
  // source line for range display.
  if (lineStart < source.length) {
    lines.push({
      text: source.slice(lineStart),
      startOffset: lineStart,
      lineNumber,
    });
  }

  return lines;
}

function findHeadings(lines: SourceLine[], fallbackTitle: string): MarkdownHeading[] {
  const headings: MarkdownHeading[] = [];
  let fence: Fence | undefined;

  for (const line of lines) {
    if (fence) {
      if (isFenceClose(line.text, fence)) fence = undefined;
      continue;
    }

    fence = parseFenceOpen(line.text);
    if (fence) continue;

    const heading = parseAtxHeading(line.text);
    if (!heading) continue;

    headings.push({
      title: heading.title || fallbackTitle,
      level: heading.level,
      startOffset: line.startOffset,
      lineNumber: line.lineNumber,
    });
  }

  return headings;
}

function parseFenceOpen(line: string): Fence | undefined {
  const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
  const markerRun = match?.[1];
  if (!markerRun) return undefined;

  const marker = markerRun[0] as Fence['marker'];
  if (marker === '`' && match[2]?.includes('`')) return undefined;

  return { marker, length: markerRun.length };
}

function isFenceClose(line: string, fence: Fence): boolean {
  const match = /^ {0,3}(`+|~+)[\t ]*$/.exec(line);
  const markerRun = match?.[1];
  return markerRun?.[0] === fence.marker && markerRun.length >= fence.length;
}

function parseAtxHeading(line: string): { title: string; level: number } | undefined {
  const match = /^ {0,3}(#{1,6})(?:[\t ]+(.*)|[\t ]*)$/.exec(line);
  const markerRun = match?.[1];
  if (!markerRun) return undefined;

  let title = (match[2] ?? '').trim();
  if (/^#+$/.test(title)) {
    title = '';
  } else {
    title = title.replace(/[\t ]+#+$/, '').trimEnd();
  }

  return { title, level: markerRun.length };
}

function chapterIdBase(title: string, lineNumber: number): string {
  const slug = title
    .normalize('NFKC')
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');

  return slug || `chapter-${lineNumber}`;
}

function uniqueChapterId(base: string, usedIds: Set<string>): string {
  if (!usedIds.has(base)) {
    usedIds.add(base);
    return base;
  }

  let suffix = 2;
  while (usedIds.has(`${base}-${suffix}`)) suffix += 1;

  const id = `${base}-${suffix}`;
  usedIds.add(id);
  return id;
}
