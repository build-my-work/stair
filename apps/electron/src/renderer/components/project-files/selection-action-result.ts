export type ReaderSelectionActionResult = boolean | void

export function shouldDismissReaderSelection(
  result?: ReaderSelectionActionResult,
): boolean {
  return result !== false
}
