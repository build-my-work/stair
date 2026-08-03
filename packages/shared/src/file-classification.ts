/** Preview types supported by the shared file viewers. */
export type FilePreviewType =
  | 'image'
  | 'code'
  | 'markdown'
  | 'json'
  | 'text'
  | 'pdf'

export interface FileClassification {
  type: FilePreviewType | null
  canPreview: boolean
}

/** Project text files above this limit remain preview-only. */
export const MAX_EDITABLE_PROJECT_FILE_BYTES = 1024 * 1024

const IMAGE_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif',
])

const CODE_EXTENSIONS = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs',
  'py', 'rb', 'rs', 'go', 'java', 'kt', 'swift',
  'c', 'cpp', 'h', 'hpp', 'cs',
  'css', 'scss', 'less',
  'html', 'htm', 'xml',
  'yaml', 'yml', 'toml',
  'sh', 'bash', 'zsh', 'fish',
  'sql', 'graphql', 'dockerfile', 'makefile',
  'r', 'lua', 'perl', 'php',
  'vue', 'svelte', 'astro', 'prisma',
])

const CODE_BASENAMES = new Set(['dockerfile', 'makefile'])
const MARKDOWN_EXTENSIONS = new Set(['md', 'markdown', 'mdx'])
const JSON_EXTENSIONS = new Set(['json', 'jsonc', 'json5'])
const TEXT_EXTENSIONS = new Set([
  'txt', 'log', 'csv', 'tsv',
  'cfg', 'ini', 'conf',
  'env', 'env.local', 'env.development', 'env.production',
  'gitignore', 'gitattributes', 'editorconfig', 'npmrc', 'nvmrc',
  'rtf',
])
const TEXT_BASENAMES = new Set([
  '.env',
  '.gitignore',
  '.gitattributes',
  '.editorconfig',
  '.npmrc',
  '.nvmrc',
])
const PDF_EXTENSIONS = new Set(['pdf'])

const EXTERNAL_EXTENSIONS = new Set([
  'xlsx', 'xls', 'xlsm',
  'docx', 'doc',
  'pptx', 'ppt',
  'zip', 'tar', 'gz', 'rar', '7z',
  'dmg', 'pkg', 'exe', 'msi',
  'mp3', 'wav', 'flac', 'aac',
  'mp4', 'mov', 'avi', 'mkv',
  'heic', 'heif', 'tiff', 'tif',
])

function getBasename(filePath: string): string {
  return (filePath.split(/[\\/]/).pop() ?? filePath).toLowerCase()
}

function getExtension(basename: string): string {
  const dotIndex = basename.lastIndexOf('.')
  if (dotIndex <= 0) return ''
  return basename.slice(dotIndex + 1)
}

/**
 * Classify a path without inspecting its contents. SVG intentionally remains
 * an image, so it never gains the ordinary source-edit entry point.
 */
export function classifyFile(filePath: string): FileClassification {
  const basename = getBasename(filePath)
  const extension = getExtension(basename)

  if (IMAGE_EXTENSIONS.has(extension)) {
    return { type: 'image', canPreview: true }
  }
  if (CODE_BASENAMES.has(basename) || CODE_EXTENSIONS.has(extension)) {
    return { type: 'code', canPreview: true }
  }
  if (MARKDOWN_EXTENSIONS.has(extension)) {
    return { type: 'markdown', canPreview: true }
  }
  if (JSON_EXTENSIONS.has(extension)) {
    return { type: 'json', canPreview: true }
  }
  if (
    TEXT_BASENAMES.has(basename)
    || basename.startsWith('.env.')
    || TEXT_EXTENSIONS.has(extension)
  ) {
    return { type: 'text', canPreview: true }
  }
  if (PDF_EXTENSIONS.has(extension)) {
    return { type: 'pdf', canPreview: true }
  }

  return { type: null, canPreview: false }
}

export function isEditableProjectTextFile(filePath: string): boolean {
  const type = classifyFile(filePath).type
  return type === 'code'
    || type === 'markdown'
    || type === 'json'
    || type === 'text'
}

/** Extensions recognized by Markdown file-link detection. */
export const FILE_EXTENSIONS_PATTERN = [
  ...IMAGE_EXTENSIONS,
  ...CODE_EXTENSIONS,
  ...MARKDOWN_EXTENSIONS,
  ...JSON_EXTENSIONS,
  ...TEXT_EXTENSIONS,
  ...PDF_EXTENSIONS,
  ...EXTERNAL_EXTENSIONS,
].join('|')
