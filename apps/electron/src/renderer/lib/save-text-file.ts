import type {
  SaveTextFileRequest,
  SaveTextFileResponse,
} from '@craft-agent/shared/protocol'

const FALLBACK_FILENAME = 'highlights.md'
const MAX_SAFE_FILENAME_BYTES = 200
const WINDOWS_RESERVED_BASENAME = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i

function truncateUtf8(value: string, maxBytes: number): string {
  const encoder = new TextEncoder()
  let bytes = 0
  let result = ''

  for (const character of value) {
    const characterBytes = encoder.encode(character).byteLength
    if (bytes + characterBytes > maxBytes) break
    bytes += characterBytes
    result += character
  }

  return result
}

export function safeSuggestedTextFilename(value: string): string {
  let filename = value
    .trim()
    .replace(/[\u0000-\u001f\u007f/\\<>:"|?*]+/g, '_')
    .replace(/[.\s]+$/g, '')

  if (!filename || filename === '.' || filename === '..' || /^_+$/.test(filename)) {
    filename = FALLBACK_FILENAME
  }

  const extensionIndex = filename.lastIndexOf('.')
  const extension = extensionIndex > 0 ? filename.slice(extensionIndex) : ''
  const stem = extension ? filename.slice(0, extensionIndex) : filename
  if (WINDOWS_RESERVED_BASENAME.test(stem)) {
    filename = `_${filename}`
  }

  const extensionBytes = new TextEncoder().encode(extension).byteLength
  if (extension && extensionBytes < MAX_SAFE_FILENAME_BYTES) {
    const truncatedStem = truncateUtf8(
      filename.slice(0, filename.length - extension.length),
      MAX_SAFE_FILENAME_BYTES - extensionBytes,
    )
    filename = `${truncatedStem}${extension}`
  } else {
    filename = truncateUtf8(filename, MAX_SAFE_FILENAME_BYTES)
  }

  return filename || FALLBACK_FILENAME
}

/**
 * Save UTF-8 text through the desktop's native Save dialog or, in the web
 * runtime, through one browser download. No destination path is accepted.
 */
export async function saveTextFile(
  request: SaveTextFileRequest,
): Promise<SaveTextFileResponse> {
  const normalizedRequest = {
    suggestedName: safeSuggestedTextFilename(request.suggestedName),
    content: request.content,
  }

  if (window.electronAPI.getRuntimeEnvironment() === 'electron') {
    return window.electronAPI.saveTextFile(normalizedRequest)
  }

  const mimeType = normalizedRequest.suggestedName.toLowerCase().endsWith('.md')
    ? 'text/markdown;charset=utf-8'
    : 'text/plain;charset=utf-8'
  const url = URL.createObjectURL(new Blob([normalizedRequest.content], { type: mimeType }))
  const anchor = document.createElement('a')

  try {
    anchor.href = url
    anchor.download = normalizedRequest.suggestedName
    anchor.style.display = 'none'
    document.body.appendChild(anchor)
    anchor.click()
  } finally {
    anchor.remove()
    URL.revokeObjectURL(url)
  }

  return { saved: true }
}
