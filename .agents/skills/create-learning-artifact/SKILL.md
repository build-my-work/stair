---
name: create-learning-artifact
description: Create or update durable, cited Markdown learning artifacts from EPUB, PDF, Markdown, code, or selected passages in the current Project. Use when the user explicitly asks for reusable reading notes, chapter summaries, concept explanations, review sheets, or question-and-answer notes that should be saved as an Artifact.
---

# Create Learning Artifact

Turn the user's current reading context into a reusable Markdown result, then persist it with `save_project_artifact`.

## Workflow

1. Confirm the requested outcome from the conversation. Do not invent an artifact when the user only asks a transient question.
2. Use the structured file references attached to user messages as the source of truth. Preserve every available project-relative path and locator.
3. Read exactly one matching template:
   - Reading note, chapter summary, concept map, or review sheet: `references/reading-note.md`
   - Question-and-answer note or misconception review: `references/qa-note.md`
4. Synthesize in your own words. Distinguish the source's claims from your explanation, and do not fabricate quotations, chapter names, page numbers, or locators.
5. Call `save_project_artifact` with a specific title, complete Markdown, the chosen template ID, and all references actually used.
6. Tell the user what was saved. The application will render the returned Artifact card; do not claim a disk path.

## Reference Rules

- Pass only project-relative paths already provided by the application.
- Copy each locator without alteration.
- Include `quote` only when the application supplied the selected text.
- Cite the readable source in the Markdown near the claim it supports. The structured reference remains the authoritative jump target.
- Exclude unused references.

## Quality Bar

- Prefer a compact hierarchy over a transcript.
- Explain relationships and implications, not just definitions.
- Add review prompts that can be answered from the note.
- Mark uncertainty explicitly when the supplied context is incomplete.
- Never write directly to the working directory; use only `save_project_artifact`.
