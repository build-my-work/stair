import type { ImportedChapter, ImportedTextbook } from '@craft-agent/shared/learning'

export function resolveLessonLanguage(
  textbook: ImportedTextbook,
  interfaceLanguage: string,
): string {
  return textbook.language?.trim() || interfaceLanguage
}

export function buildLessonKickoff(
  textbook: ImportedTextbook,
  chapter: ImportedChapter,
  interfaceLanguage: string,
): string {
  const safeContent = chapter.content.replace(/<\s*\/\s*learning_material\s*>/gi, '&lt;/learning_material&gt;')
  const lessonLanguage = resolveLessonLanguage(textbook, interfaceLanguage)

  return `<learning_session>
<textbook>${escapeXml(textbook.title)}</textbook>
<chapter>${escapeXml(chapter.title)}</chapter>
<source>${escapeXml(textbook.sourceFilename)}</source>
</learning_session>

<learning_material>
${safeContent}
</learning_material>

Teach this lesson in "${escapeXml(lessonLanguage)}". Ask exactly one diagnostic question first.`
}

function escapeXml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}
