import { describe, expect, it } from 'bun:test'

import { createProjectFileImageDataUrl } from '../project-file-image'

describe('Project File image preview', () => {
  it('把二进制图片转换为当前 CSP 允许的 data URL', () => {
    expect(createProjectFileImageDataUrl(
      'image/png',
      new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
    )).toBe('data:image/png;base64,iVBORw==')
  })
})
