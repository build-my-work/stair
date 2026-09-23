import { describe, expect, it } from 'bun:test'
import { Linter } from 'eslint'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

for (const path of [
  '../no-inline-source-auth-check.cjs',
  '../../../../packages/shared/eslint-rules/no-inline-source-auth-check.cjs',
]) {
  describe(`source auth rule: ${path}`, () => {
    const rule = require(path)
    for (const [code, count] of [
      ['source.config.isAuthenticated = false', 0],
      ["source.config['isAuthenticated'] = true", 0],
      ['if (source.config.isAuthenticated) connect()', 1],
      ["if (source.config['isAuthenticated']) connect()", 1],
      ['if (isSourceUsable(source)) connect()', 0],
    ] as const) {
      it(code, () => {
        const linter = new Linter({ configType: 'eslintrc' })
        linter.defineRule('source-auth', rule)
        const messages = linter.verify(code, {
          parserOptions: { ecmaVersion: 'latest' },
          rules: { 'source-auth': 'error' },
        }, 'source.ts')
        expect(messages).toHaveLength(count)
      })
    }
  })
}
