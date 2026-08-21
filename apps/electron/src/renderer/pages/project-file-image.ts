const BINARY_CHUNK_SIZE = 0x8000

export function createProjectFileImageDataUrl(
  mimeType: string,
  bytes: Uint8Array,
): string {
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += BINARY_CHUNK_SIZE) {
    binary += String.fromCharCode(...bytes.subarray(
      offset,
      Math.min(bytes.length, offset + BINARY_CHUNK_SIZE),
    ))
  }
  return `data:${mimeType};base64,${btoa(binary)}`
}
