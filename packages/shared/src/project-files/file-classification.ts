export type ProjectTextFileKind = 'markdown' | 'json' | 'code' | 'text' | 'unknown'

const MARKDOWN_EXTENSIONS = new Set(['md', 'mdx', 'markdown'])
const JSON_EXTENSIONS = new Set(['json', 'jsonc', 'json5'])
const CODE_EXTENSIONS = new Set([
  'c', 'cc', 'cpp', 'cs', 'css', 'go', 'h', 'hpp', 'html', 'java', 'js', 'jsx',
  'kt', 'lua', 'mjs', 'php', 'py', 'rb', 'rs', 'scss', 'sh', 'sql', 'svelte',
  'swift', 'toml', 'ts', 'tsx', 'vue', 'xml', 'yaml', 'yml', 'zsh',
])
const TEXT_EXTENSIONS = new Set([
  'cfg', 'conf', 'csv', 'editorconfig', 'env', 'gitattributes', 'gitignore', 'ini',
  'log', 'npmrc', 'properties', 'rtf', 'text', 'tsv', 'txt',
])
const EXTENSIONLESS_TEXT_FILES = new Set([
  'dockerfile', 'license', 'makefile', 'readme',
])

function fileExtension(relativePath: string): string {
  const name = relativePath.split('/').at(-1)?.toLowerCase() ?? ''
  const dot = name.lastIndexOf('.')
  return dot >= 0 ? name.slice(dot + 1) : ''
}

export function classifyProjectTextFile(relativePath: string): ProjectTextFileKind {
  const name = relativePath.split('/').at(-1)?.toLowerCase() ?? ''
  const extension = fileExtension(relativePath)
  if (MARKDOWN_EXTENSIONS.has(extension)) return 'markdown'
  if (JSON_EXTENSIONS.has(extension)) return 'json'
  if (CODE_EXTENSIONS.has(extension)) return 'code'
  if (TEXT_EXTENSIONS.has(extension) || EXTENSIONLESS_TEXT_FILES.has(name)) return 'text'
  return 'unknown'
}

export function isEditableProjectTextFile(relativePath: string): boolean {
  return classifyProjectTextFile(relativePath) !== 'unknown'
}
