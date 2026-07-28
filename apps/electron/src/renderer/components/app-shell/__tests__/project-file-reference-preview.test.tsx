import { describe, expect, it, mock } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import type {
  MessageReference,
  StoredAttachment,
} from '@craft-agent/core'

mock.module('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({
  default: '',
}))
mock.module('pdfjs-dist', () => ({
  GlobalWorkerOptions: { workerSrc: '' },
  getDocument: () => ({}),
}))
mock.module('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}))

const { AttachmentPreview } = await import('../AttachmentPreview')
const { UserMessageBubble } = await import('@craft-agent/ui')

const reference: MessageReference = {
  version: 1,
  kind: 'project-file',
  projectId: 'project-1',
  relativePath: 'books/operating-systems.epub',
  sourceFingerprint: `sha256:${'a'.repeat(64)}`,
  fileName: 'operating-systems.epub',
  quote: 'The selected passage',
  chapterKey: 'toc:0.1',
  chapterTitle: 'Chapter 2',
  tocPath: [{
    key: 'toc:0.1',
    title: 'Chapter 2',
    orderPath: [0, 1],
    href: 'chapter-2.xhtml',
  }],
  locator: {
    type: 'epub-cfi',
    cfiRange: 'epubcfi(/6/4!/4/2:0)',
  },
}

const attachment: StoredAttachment = {
  id: 'attachment-1',
  type: 'pdf',
  name: 'notes.pdf',
  mimeType: 'application/pdf',
  size: 128,
  storedPath: '/tmp/notes.pdf',
}

function render(node: React.ReactNode): string {
  return renderToStaticMarkup(node)
}

describe('Project File reference previews', () => {
  it('renders a reference-only AttachmentPreview with a remove control', () => {
    const html = render(
      <AttachmentPreview
        attachments={[]}
        references={[reference]}
        onRemove={() => {}}
        onRemoveReference={() => {}}
      />,
    )

    expect(html).toContain('operating-systems.epub')
    expect(html).toContain('Chapter 2')
    expect(html).toContain('The selected passage')
    expect(html).toContain(
      'aria-label="Remove reference from operating-systems.epub"',
    )
  })

  it('keeps the reference visible but hides removal while disabled', () => {
    const html = render(
      <AttachmentPreview
        attachments={[]}
        references={[reference]}
        onRemove={() => {}}
        onRemoveReference={() => {}}
        disabled
      />,
    )

    expect(html).toContain('operating-systems.epub')
    expect(html).not.toContain('aria-label="Remove reference')
  })

  it('renders a reference-only UserMessageBubble without an empty body', () => {
    const html = render(
      <UserMessageBubble
        content=""
        references={[reference]}
        onReferenceClick={() => {}}
      />,
    )

    expect(html).toContain('operating-systems.epub')
    expect(html).toContain('Chapter 2')
    expect(html).toContain('The selected passage')
    expect(html).toContain(
      'aria-label="Open reference from operating-systems.epub"',
    )
    expect(html).not.toContain('markdown-content')
  })

  it('ignores references outside the current schema', () => {
    const html = render(
      <UserMessageBubble
        content="Existing message"
        references={[{
          projectId: 'project-1',
          path: 'legacy.epub',
          quote: 'Old reference',
          locator: reference.locator,
        } as unknown as MessageReference]}
        onReferenceClick={() => {}}
      />,
    )

    expect(html).toContain('Existing message')
    expect(html).not.toContain('Old reference')
  })

  it('renders content, an attachment, and a reference together', () => {
    const html = render(
      <UserMessageBubble
        content="Review this section."
        attachments={[attachment]}
        references={[reference]}
        onFileClick={() => {}}
        onReferenceClick={() => {}}
      />,
    )

    expect(html).toContain('Review this section.')
    expect(html).toContain('notes.pdf')
    expect(html).toContain('operating-systems.epub')
    expect(html).toContain(
      'aria-label="Open reference from operating-systems.epub"',
    )
    expect(html.match(/aria-label="Open reference from/g)).toHaveLength(1)
    expect(html).toContain('markdown-content')
  })
})
