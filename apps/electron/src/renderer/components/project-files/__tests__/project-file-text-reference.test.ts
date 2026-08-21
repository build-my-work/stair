import { describe, expect, it } from 'bun:test'

import {
  buildTextProjectFileReference,
  resolveTextQuoteOffset,
} from '../project-file-text-reference'

const fingerprint = `sha256:${'a'.repeat(64)}` as const

describe('文本 Project File 引用', () => {
  it('保留精确选区、上下文和稳定来源身份', () => {
    expect(buildTextProjectFileReference({
      projectId: 'project-a',
      relativePath: 'docs/readme.md',
      sourceFingerprint: fingerprint,
      fileName: 'readme.md',
      fullText: 'before  selected text  after',
      selectionStart: 8,
      selectionEnd: 23,
    })).toEqual({
      version: 1,
      kind: 'project-file',
      projectId: 'project-a',
      relativePath: 'docs/readme.md',
      sourceFingerprint: fingerprint,
      fileName: 'readme.md',
      quote: 'selected text',
      contextBefore: 'before  ',
      contextAfter: '  after',
      locator: {
        type: 'text-quote',
        exact: 'selected text',
        prefix: 'before  ',
        suffix: '  after',
        start: 8,
        end: 21,
      },
    })
  })

  it('reveal 优先使用原 offset，内容重复时再用前后文消歧', () => {
    const text = 'one target A; two target B'
    expect(resolveTextQuoteOffset(text, {
      type: 'text-quote',
      exact: 'target',
      prefix: 'two ',
      suffix: ' B',
      start: 18,
      end: 24,
    })).toBe(18)

    expect(resolveTextQuoteOffset(text, {
      type: 'text-quote',
      exact: 'target',
      prefix: 'two ',
      suffix: ' B',
      start: 0,
      end: 6,
    })).toBe(18)
  })

  it('有消歧上下文但所有候选都不匹配时不跳到错误位置', () => {
    expect(resolveTextQuoteOffset('one target A; two target B', {
      type: 'text-quote',
      exact: 'target',
      prefix: 'missing prefix',
      suffix: 'missing suffix',
      start: 0,
      end: 6,
    })).toBeNull()

    expect(resolveTextQuoteOffset('one target A; two target B', {
      type: 'text-quote',
      exact: 'target',
      start: 0,
      end: 6,
    })).toBe(4)
  })

  it('拒绝空选区和超出正文的 offset', () => {
    expect(() => buildTextProjectFileReference({
      projectId: 'project-a',
      relativePath: 'notes.txt',
      sourceFingerprint: fingerprint,
      fileName: 'notes.txt',
      fullText: 'hello',
      selectionStart: 5,
      selectionEnd: 5,
    })).toThrow('Select some text first')
  })
})
