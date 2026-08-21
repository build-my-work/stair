import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'bun:test'

const pageSource = readFileSync(
  new URL('../../../pages/ProjectFilePage.tsx', import.meta.url),
  'utf8',
)
const epubSource = readFileSync(
  new URL('../ProjectFileEpubReader.tsx', import.meta.url),
  'utf8',
)
const pdfSource = readFileSync(
  new URL('../ProjectFilePdfReader.tsx', import.meta.url),
  'utf8',
)

describe('Project File Reader legacy capabilities', () => {
  it('保留图片预览和完整 Project 相对路径', () => {
    expect(pageSource).toContain("kind === 'epub' || kind === 'pdf' || kind === 'image'")
    expect(pageSource).toContain('src={imageUrl}')
    expect(pageSource).toContain('{relativePath}')
  })

  it('保留 EPUB 作者、目录分组和 Markdown 导出', () => {
    expect(epubSource).toContain('epubMetadata.creator?.trim()')
    expect(epubSource).toContain('buildEpubHighlightTree')
    expect(epubSource).toContain('buildEpubHighlightsMarkdown')
    expect(epubSource).toContain('saveTextFile')
  })

  it('保留 PDF 高亮 Markdown 导出', () => {
    expect(pdfSource).toContain('buildPdfHighlightsMarkdown')
    expect(pdfSource).toContain('getPdfHighlightsSuggestedFilename')
    expect(pdfSource).toContain('saveTextFile')
  })
})
