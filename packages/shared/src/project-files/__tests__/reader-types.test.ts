import { describe, expect, it } from 'bun:test'

import {
  classifyProjectFile,
  isSourceFingerprint,
  type ProjectFileOpenIntent,
} from '..'

describe('Project File Reader 类型边界', () => {
  it('把 EPUB、PDF 和旧版图片格式分流到二进制 Reader', () => {
    expect(classifyProjectFile('books/guide.epub')).toBe('epub')
    expect(classifyProjectFile('papers/report.PDF')).toBe('pdf')
    expect(classifyProjectFile('notes/plan.md')).toBe('markdown')
    expect(classifyProjectFile('assets/image.png')).toBe('image')
    expect(classifyProjectFile('assets/icon.svg')).toBe('image')
  })

  it('保留旧 Stair 支持的文本和代码扩展名', () => {
    for (const path of [
      'script.cjs', 'styles.less', 'scripts/build.bash', 'query.graphql',
      'analysis.r', 'site/page.astro', 'schema.prisma', 'public/index.htm',
    ]) {
      expect(classifyProjectFile(path)).toBe('code')
    }
    for (const path of [
      '.env', '.gitignore', '.gitattributes', '.editorconfig', '.npmrc', '.nvmrc',
    ]) {
      expect(classifyProjectFile(path)).toBe('text')
    }
    expect(classifyProjectFile('.env.production')).toBe('text')
  })

  it('不把仅由点号开头的文件名误判为二进制 Reader', () => {
    expect(classifyProjectFile('.pdf')).toBe('unknown')
    expect(classifyProjectFile('.png')).toBe('unknown')
    expect(classifyProjectFile('.epub')).toBe('unknown')
  })

  it('open intent 同时携带精确来源 fingerprint 和稳定 locator', () => {
    const expectedFingerprint = `sha256:${'a'.repeat(64)}` as const
    const intent: ProjectFileOpenIntent = {
      expectedFingerprint,
      locator: { type: 'epub-cfi', cfiRange: 'epubcfi(/6/2!/4/2)' },
    }
    expect(isSourceFingerprint(intent.expectedFingerprint)).toBe(true)
    expect(intent.locator.type).toBe('epub-cfi')
  })
})
