import { describe, expect, it } from 'bun:test';

import { parseMarkdownChapters } from './markdown.ts';

describe('parseMarkdownChapters', () => {
  it('returns a flat chapter list whose content includes nested sections', () => {
    const lines = [
      '# Course',
      'opening',
      '',
      '## Basics',
      'basic body',
      '',
      '### Detail',
      'detail body',
      '',
      '## Practice',
      'practice body',
      '',
      '# Appendix',
      'end',
    ];

    const chapters = parseMarkdownChapters(lines.join('\n'), 'Fallback');

    expect(chapters.map(({ id, title, level, order, locator }) => ({
      id,
      title,
      level,
      order,
      locator,
    }))).toEqual([
      { id: 'course', title: 'Course', level: 1, order: 0, locator: { format: 'markdown', startLine: 1, endLine: 12 } },
      { id: 'basics', title: 'Basics', level: 2, order: 1, locator: { format: 'markdown', startLine: 4, endLine: 9 } },
      { id: 'detail', title: 'Detail', level: 3, order: 2, locator: { format: 'markdown', startLine: 7, endLine: 9 } },
      { id: 'practice', title: 'Practice', level: 2, order: 3, locator: { format: 'markdown', startLine: 10, endLine: 12 } },
      { id: 'appendix', title: 'Appendix', level: 1, order: 4, locator: { format: 'markdown', startLine: 13, endLine: 14 } },
    ]);
    expect(chapters[0]?.content).toBe(lines.slice(0, 12).join('\n') + '\n');
    expect(chapters[1]?.content).toBe(lines.slice(3, 9).join('\n') + '\n');
    expect(chapters[2]?.content).toBe(lines.slice(6, 9).join('\n') + '\n');
    expect(chapters[3]?.content).toBe(lines.slice(9, 12).join('\n') + '\n');
    expect(chapters[4]?.content).toBe(lines.slice(12).join('\n'));
  });

  it('ignores heading-like lines inside backtick and tilde fences', () => {
    const markdown = [
      '# Visible',
      '```markdown',
      '# Hidden',
      '````',
      '~~~',
      '## Also hidden',
      '~~~',
      '# Next',
      'body',
    ].join('\n');

    const chapters = parseMarkdownChapters(markdown, 'Fallback');

    expect(chapters.map(({ title, locator }) => ({ title, locator }))).toEqual([
      { title: 'Visible', locator: { format: 'markdown', startLine: 1, endLine: 7 } },
      { title: 'Next', locator: { format: 'markdown', startLine: 8, endLine: 9 } },
    ]);
  });

  it('creates deterministic unique ids for duplicate and non-Latin titles', () => {
    const markdown = [
      '# Repeat',
      '## Repeat',
      '# Repeat',
      '# 中文 标题',
      '# 中文 标题',
    ].join('\n');

    const first = parseMarkdownChapters(markdown, 'Fallback');
    const second = parseMarkdownChapters(markdown, 'Fallback');

    expect(first.map((chapter) => chapter.id)).toEqual([
      'repeat',
      'repeat-2',
      'repeat-3',
      '中文-标题',
      '中文-标题-2',
    ]);
    expect(second.map((chapter) => chapter.id)).toEqual(first.map((chapter) => chapter.id));
  });

  it('falls back to one caller-named chapter when the document has no headings', () => {
    const markdown = 'plain text\nwith another line';

    expect(parseMarkdownChapters(markdown, 'Imported lesson')).toEqual([
      {
        id: 'imported-lesson',
        title: 'Imported lesson',
        level: 1,
        order: 0,
        locator: { format: 'markdown', startLine: 1, endLine: 2 },
        content: markdown,
      },
    ]);
  });

  it('recognizes only valid one-to-six-marker ATX headings', () => {
    const markdown = [
      '   ## Spaced heading ##',
      '####### Too many hashes',
      '#missing-space',
      '    # Indented code',
      '###### Deep heading',
    ].join('\n');

    const chapters = parseMarkdownChapters(markdown, 'Fallback');

    expect(chapters.map(({ title, level, locator }) => ({ title, level, locator }))).toEqual([
      { title: 'Spaced heading', level: 2, locator: { format: 'markdown', startLine: 1, endLine: 5 } },
      { title: 'Deep heading', level: 6, locator: { format: 'markdown', startLine: 5, endLine: 5 } },
    ]);
  });

  it('preserves CRLF line endings and excludes a terminal newline from endLine', () => {
    const markdown = '# One\r\nbody\r\n# Two\r\nmore\r\n';

    const chapters = parseMarkdownChapters(markdown, 'Fallback');

    expect(chapters[0]).toMatchObject({ locator: { format: 'markdown', startLine: 1, endLine: 2 }, content: '# One\r\nbody\r\n' });
    expect(chapters[1]).toMatchObject({ locator: { format: 'markdown', startLine: 3, endLine: 4 }, content: '# Two\r\nmore\r\n' });
  });
});
