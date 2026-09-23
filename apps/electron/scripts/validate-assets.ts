/**
 * Verify the assets copied into dist/resources before packaging.
 */

import { existsSync, readdirSync } from 'node:fs'

const REQUIRED_ASSET_DIRS = [
  { path: 'dist/resources/themes', minFiles: 1, description: 'preset themes' },
  { path: 'dist/resources/docs', minFiles: 1, description: 'documentation' },
  { path: 'dist/resources/permissions', minFiles: 1, description: 'default permissions' },
  { path: 'dist/resources/tool-icons', minFiles: 1, description: 'tool icons' },
]

let hasErrors = false

console.log('Validating bundled assets...\n')

for (const { path, minFiles, description } of REQUIRED_ASSET_DIRS) {
  if (!existsSync(path)) {
    console.error(`MISSING: ${path} (${description})`)
    hasErrors = true
    continue
  }

  const files = readdirSync(path)
  if (files.length < minFiles) {
    console.error(`EMPTY: ${path} has ${files.length} files, expected at least ${minFiles}`)
    hasErrors = true
    continue
  }

  console.log(`OK: ${path} (${files.length} files)`)
}

if (hasErrors) {
  console.error('\nAsset validation failed.')
  process.exit(1)
}

console.log('\nAll required assets are present.')
