export type WorkspaceFileKind = 'epub' | 'pdf' | 'markdown' | 'image' | 'text' | 'external'

const IMAGE_EXTENSIONS = new Set(['avif', 'bmp', 'gif', 'ico', 'jpeg', 'jpg', 'png', 'svg', 'webp'])
const TEXT_EXTENSIONS = new Set([
  'c', 'cc', 'cfg', 'conf', 'cpp', 'cs', 'css', 'csv', 'env', 'go', 'graphql',
  'h', 'hpp', 'html', 'ini', 'java', 'js', 'json', 'jsx', 'kt', 'less', 'log',
  'lua', 'm', 'mm', 'php', 'plist', 'properties', 'proto', 'py', 'rb', 'rs',
  'scss', 'sh', 'sql', 'svelte', 'swift', 'toml', 'ts', 'tsx', 'txt', 'vue',
  'xml', 'yaml', 'yml', 'zsh',
])
const TEXT_FILENAMES = new Set([
  'dockerfile', 'gemfile', 'makefile', 'procfile', 'readme', 'license', '.gitignore',
])

function extension(path: string): string {
  const name = path.split('/').at(-1)?.toLowerCase() ?? ''
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1) : ''
}

export function getWorkspaceFileKind(path: string): WorkspaceFileKind {
  const ext = extension(path)
  const name = path.split('/').at(-1)?.toLowerCase() ?? ''
  if (ext === 'epub') return 'epub'
  if (ext === 'pdf') return 'pdf'
  if (ext === 'md' || ext === 'markdown' || ext === 'mdx') return 'markdown'
  if (IMAGE_EXTENSIONS.has(ext)) return 'image'
  if (TEXT_EXTENSIONS.has(ext) || TEXT_FILENAMES.has(name)) return 'text'
  return 'external'
}

export function getWorkspaceFileLanguage(path: string): string {
  const name = path.split('/').at(-1)?.toLowerCase() ?? ''
  if (name === 'dockerfile') return 'dockerfile'
  if (name === 'makefile') return 'makefile'
  return extension(path) || 'text'
}
