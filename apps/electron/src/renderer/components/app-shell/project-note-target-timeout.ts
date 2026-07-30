const PROJECT_NOTE_TARGET_TIMEOUT_MS = 5_000

export async function withProjectNoteTargetTimeout<T>(
  request: Promise<T>,
  timeoutMs = PROJECT_NOTE_TARGET_TIMEOUT_MS,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      reject(new Error('Setting the Add Note target timed out. Try again.'))
    }, timeoutMs)
  })

  try {
    return await Promise.race([request, timeoutPromise])
  } finally {
    if (timeout !== undefined) clearTimeout(timeout)
  }
}
