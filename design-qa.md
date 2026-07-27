# EPUB selection toolbar design QA

## Evidence

- Source visual truth: `/var/folders/pw/87rv66m91h9g710rc68z0c740000gn/T/codex-clipboard-268f751a-3453-4ec5-bb65-af7dc7d75075.png`
- Rendered implementation: `/var/folders/pw/87rv66m91h9g710rc68z0c740000gn/T/com.openai.sky.CUAService/Electron Screenshot 2026-07-22 at 3.34.32 PM.jpeg`
- Combined focused comparison: `/Users/zhihu/.codex/visualizations/2026/07/21/019f848e-0009-7e31-95eb-6f57d19692ea/epub-selection-toolbar-comparison.png`
- Viewport: Electron window at 1195 x 768 CSS px, light theme.
- Source pixels: 770 x 173. The source has no declared CSS size or density.
- Implementation pixels: 1195 x 768. Computer Use captured the logical Electron viewport at the same pixel dimensions; no additional density conversion was applied.
- Focused normalization: the implementation region was cropped to 630 x 240 and scaled to 770 x 293, then stacked below the 770 x 173 source without changing either region's aspect ratio.
- State: project `os`, chapter `第3章 关于虚拟化的对话`, text `学生：桃子？（不可思议）` selected, contextual toolbar open, one pre-existing persisted red wavy underline visible.

## Full-view comparison evidence

The source only specifies the focused selection interaction, so full-screen layout fidelity cannot be compared directly. The full Electron capture was checked for the relevant integration concerns: the toolbar is anchored beside the selected text, remains inside the reader viewport, does not cover persistent reader controls, and does not disturb the EPUB layout. No clipping or layout regression is visible.

## Focused region comparison evidence

The combined comparison shows the source above and the implementation below. The implementation preserves the source's compact dark floating surface, rounded corners, icon treatment, and placement adjacent to selected text. Intentional product deviations are:

- Only Copy and Wavy underline remain because those are the two implemented actions.
- Visible labels were removed at the user's request; accessible names remain available to assistive technology.
- The reader keeps the product's existing light theme instead of copying the source app's dark reading theme.

## Required fidelity surfaces

- Fonts and typography: there is no visible toolbar copy in the final state. EPUB typography remains untouched; screen-reader-only labels do not affect layout.
- Spacing and layout rhythm: the 88 x 44 toolbar, two equal icon targets, one divider, 8 px selection gap, and rounded dark surface read as a single compact control without covering the selection.
- Colors and visual tokens: the toolbar uses the existing neutral dark treatment with high-contrast icons. Saved highlights use the requested `#ef4444` red wavy underline.
- Image quality and asset fidelity: no raster assets or custom-drawn symbols were introduced. Copy and Waves use the repository's existing Lucide icon library and render sharply.
- Copy and content: no visible instructional text remains. Accessible names are localized as Copy and Wavy underline.

## Findings

No actionable P0, P1, or P2 visual differences remain. The missing source actions and labels are intentional scope changes, not fidelity regressions.

Residual test gap: component-level DOM tests do not currently assert the toolbar's accessible names or click sequence. The coordinate logic, red wavy CSS, storage path, and RPC behavior are covered by the existing automated suite.

## Primary interactions tested

- Dragged inside the EPUB iframe and confirmed the contextual toolbar appeared next to the selection.
- Activated the Copy icon, confirmed the toolbar dismissed, and verified the clipboard contained exactly `学生：桃子？（不可思议）`.
- Confirmed the user's persisted underline count remained one after QA; no temporary highlight was left behind.

## Comparison history

1. P1: the original bottom confirmation bar could be outside the visible reader viewport. It was replaced with a toolbar anchored to the EPUB selection. Post-fix evidence showed the toolbar beside selected text.
2. P2 after user clarification: the first contextual toolbar still displayed action labels. Visible text was removed, width was reduced to 88 px, and the accessible labels were retained off-screen. The final combined comparison shows only the Copy and Wavy underline icons.

## Implementation checklist

- [x] Compact icon-only contextual toolbar.
- [x] Copy action works and dismisses the toolbar.
- [x] Wavy underline action remains connected to persisted highlights.
- [x] Red wavy underline is visible in the reader.
- [x] Automated regression checks pass.

final result: passed
