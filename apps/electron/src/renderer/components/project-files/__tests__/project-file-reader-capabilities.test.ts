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
const textSelectionSource = readFileSync(
  new URL('../ProjectFileTextSelection.tsx', import.meta.url),
  'utf8',
)
const selectionToolbarSource = readFileSync(
  new URL('../ProjectFileReaderSelectionToolbar.tsx', import.meta.url),
  'utf8',
)

describe('Project File Reader legacy capabilities', () => {
  it('保留图片预览和完整 Project 相对路径', () => {
    expect(pageSource).toContain("kind === 'epub' || kind === 'pdf' || kind === 'image'")
    expect(pageSource).toContain('src={imageUrl}')
    expect(pageSource).toContain('{relativePath}')
  })

  it('Project File New Chat 固定来源锚点，并在失败时清理引用后删除 Session', () => {
    expect(pageSource).toContain('const source = { panelId, projectId, relativePath }')
    expect(pageSource).toContain('openSessionInNewPanel(child.id, { afterProjectFile: source })')
    expect(pageSource.indexOf('onReferencesChange(child.id, [])'))
      .toBeLessThan(pageSource.indexOf('await onDeleteSession(child.id, true)'))
  })

  it('Reader 滚动或 resize 时收起旧选区，并限制窄 Panel 工具条宽度', () => {
    expect(textSelectionSource).toContain("addEventListener('scroll', dismiss, true)")
    expect(textSelectionSource).toContain("addEventListener('resize', dismiss)")
    expect(selectionToolbarSource).toContain('max-w-[var(--radix-popover-content-available-width)]')
    expect(selectionToolbarSource).toContain('flex-wrap')
  })

  it('引用来源 fingerprint 已变化时给出定位失败反馈', () => {
    expect(pageSource).toContain("toast.error(t('reference.couldNotOpenSelection'))")
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
