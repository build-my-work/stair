export type ProjectTextFileKind = 'markdown' | 'json' | 'code' | 'text' | 'unknown'
export type ProjectFileKind = Exclude<ProjectTextFileKind, 'unknown'> | 'image' | 'epub' | 'pdf' | 'unknown'

const MARKDOWN_EXTENSIONS = new Set(['md', 'mdx', 'markdown'])
const JSON_EXTENSIONS = new Set(['json', 'jsonc', 'json5'])
const IMAGE_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif',
])
const CODE_EXTENSIONS = new Set([
  'astro', 'bash', 'c', 'cc', 'cjs', 'cpp', 'cs', 'css', 'fish', 'go', 'graphql',
  'h', 'hpp', 'htm', 'html', 'java', 'js', 'jsx', 'kt', 'less', 'lua', 'mjs',
  'perl', 'php', 'prisma', 'py', 'r', 'rb', 'rs', 'scss', 'sh', 'sql', 'svelte',
  'swift', 'toml', 'ts', 'tsx', 'vue', 'xml', 'yaml', 'yml', 'zsh',
])
const TEXT_EXTENSIONS = new Set([
  'cfg', 'conf', 'csv', 'editorconfig', 'env', 'gitattributes', 'gitignore', 'ini',
  'log', 'npmrc', 'nvmrc', 'properties', 'rtf', 'text', 'tsv', 'txt',
])
const CODE_BASENAMES = new Set(['dockerfile', 'makefile'])
const EXTENSIONLESS_TEXT_FILES = new Set([
  '.editorconfig', '.env', '.gitattributes', '.gitignore', '.npmrc', '.nvmrc',
  'license', 'readme',
])

function fileExtension(relativePath: string): string {
  const name = relativePath.split('/').at(-1)?.toLowerCase() ?? ''
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1) : ''
}

export function classifyProjectTextFile(relativePath: string): ProjectTextFileKind {
  const name = relativePath.split('/').at(-1)?.toLowerCase() ?? ''
  const extension = fileExtension(relativePath)
  if (CODE_BASENAMES.has(name)) return 'code'
  if (MARKDOWN_EXTENSIONS.has(extension)) return 'markdown'
  if (JSON_EXTENSIONS.has(extension)) return 'json'
  if (CODE_EXTENSIONS.has(extension)) return 'code'
  if (
    TEXT_EXTENSIONS.has(extension)
    || EXTENSIONLESS_TEXT_FILES.has(name)
    || name.startsWith('.env.')
  ) return 'text'
  return 'unknown'
}

export function classifyProjectFile(relativePath: string): ProjectFileKind {
  const extension = fileExtension(relativePath)
  if (IMAGE_EXTENSIONS.has(extension)) return 'image'
  if (extension === 'epub') return 'epub'
  if (extension === 'pdf') return 'pdf'
  return classifyProjectTextFile(relativePath)
}

export function isEditableProjectTextFile(relativePath: string): boolean {
  return classifyProjectTextFile(relativePath) !== 'unknown'
}
