import * as React from 'react'
import * as ReactDOM from 'react-dom'
import {
  ChevronRight,
  CornerDownRight,
  MessageSquarePlus,
  MessageSquareQuote,
  NotebookPen,
} from 'lucide-react'
import {
  Island,
  IslandContentView,
  IslandFollowUpContentView,
  type IslandTransitionConfig,
} from '../ui'
import { cn } from '../../lib/utils'
import { clampIslandAnchorX, getDefaultIslandWidthEstimate } from './island-motion'
import { useTranslation } from 'react-i18next'

export type AnnotationIslandView = 'compact' | 'confirm-follow-up'
export type AnnotationIslandMode = 'edit' | 'view'

export interface AnnotationIslandMenuProps {
  anchor: { x: number; y: number } | null
  sourceKey: string
  replayNonce: number
  isVisible: boolean
  /** Render via React portal to document.body (default). Disable inside modal/dialog contexts. */
  usePortal?: boolean
  activeView: AnnotationIslandView
  mode: AnnotationIslandMode
  draft: string
  onDraftChange: (next: string) => void
  onOpenFollowUp: () => void
  onAddChat?: () => void
  onAddNewChat?: () => void
  onAddNote?: () => void
  onAddNoteTo?: () => void
  onCancel: () => void
  onRequestBack?: () => boolean
  onRequestEdit: () => void
  onSubmit: (value: string) => void
  onSubmitAndSend?: (value: string) => void
  onDelete?: () => void
  sendMessageKey?: 'enter' | 'cmd-enter'
  transitionConfig: IslandTransitionConfig
  onExitComplete?: () => void
  zIndex?: React.CSSProperties['zIndex']
  overlayZIndex?: React.CSSProperties['zIndex']
}

export function AnnotationIslandMenu({
  anchor,
  sourceKey,
  replayNonce,
  isVisible,
  activeView,
  mode,
  draft,
  onDraftChange,
  onOpenFollowUp,
  onAddChat,
  onAddNewChat,
  onAddNote,
  onAddNoteTo,
  onCancel,
  onRequestBack,
  onRequestEdit,
  onSubmit,
  onSubmitAndSend,
  onDelete,
  sendMessageKey = 'enter',
  transitionConfig,
  onExitComplete,
  zIndex = 'var(--z-island, 400)',
  overlayZIndex,
  usePortal = true,
}: AnnotationIslandMenuProps) {
  const { t } = useTranslation()
  const menuRef = React.useRef<HTMLDivElement>(null)
  const [activeViewSize, setActiveViewSize] = React.useState<{ width: number; height: number } | null>(null)

  // Keep blocker behind the island menu when consumers pass a custom numeric zIndex
  // (for example TurnCard uses zIndex=50). Otherwise fall back to the semantic island token.
  const resolvedOverlayZIndex = React.useMemo<React.CSSProperties['zIndex']>(() => {
    if (overlayZIndex != null) return overlayZIndex
    if (typeof zIndex === 'number') return zIndex - 1
    return 'var(--z-island-overlay, 390)'
  }, [overlayZIndex, zIndex])

  const anchorX = React.useMemo(() => {
    if (typeof window === 'undefined') return 0
    if (!anchor) return window.innerWidth / 2

    const width = activeViewSize?.width ?? getDefaultIslandWidthEstimate()
    return clampIslandAnchorX(anchor.x, width)
  }, [anchor, activeViewSize])

  if (!anchor) return null

  const menuNode = (
    <div
      ref={menuRef}
      data-ca-annotation-island="true"
      className="fixed"
      style={{
        zIndex,
        left: anchorX,
        top: Math.max(36, anchor.y),
        transform: 'translate(-50%, -100%)',
      }}
    >
      <Island
        key={sourceKey}
        activeViewId={activeView}
        radius={12}
        className="border-border/40 bg-background/75 backdrop-blur-xl backdrop-saturate-150 shadow-strong"
        onActiveViewSizeChange={setActiveViewSize}
        isVisible={isVisible}
        onExitComplete={onExitComplete}
        replayEntryKey={`${sourceKey}:${replayNonce}`}
        replayOnVisible="always"
        transitionConfig={transitionConfig}
        dialogBehavior="back-or-close"
        onRequestBack={onRequestBack}
        onRequestClose={onCancel}
        overlayZIndex={resolvedOverlayZIndex}
      >
        <IslandContentView id="compact" anchorX="center" anchorY="bottom">
          <div className="p-1 flex items-center gap-1">
            <button
              type="button"
              onClick={onOpenFollowUp}
              className={cn(
                'h-[30px] px-2.5 rounded-[8px] text-[13px] font-medium inline-flex items-center gap-1.5',
                'text-foreground/85 hover:text-foreground hover:bg-foreground/5',
                'focus:outline-none focus-visible:ring-1 focus-visible:ring-ring'
              )}
            >
              <CornerDownRight className="h-3.5 w-3.5" />
              <span>{t('chat.followUp')}</span>
            </button>
            {onAddNote && (
              <div className="flex items-center">
                <button
                  type="button"
                  onClick={onAddNote}
                  className={cn(
                    'inline-flex h-[30px] items-center gap-1.5 rounded-l-[8px] px-2.5 text-[13px] font-medium',
                    'text-foreground/85 hover:bg-foreground/5 hover:text-foreground focus:outline-none focus-visible:ring-1 focus-visible:ring-ring',
                    !onAddNoteTo && 'rounded-r-[8px]',
                  )}
                >
                  <NotebookPen className="h-3.5 w-3.5" />
                  <span>{t('reference.addNote')}</span>
                </button>
                {onAddNoteTo && (
                  <button
                    type="button"
                    title={t('projectNoteTarget.chooseFile')}
                    aria-label={t('projectNoteTarget.chooseFile')}
                    onClick={onAddNoteTo}
                    className="inline-flex h-[30px] items-center rounded-r-[8px] border-l border-border/45 px-1.5 text-foreground/70 hover:bg-foreground/5 hover:text-foreground focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  >
                    <ChevronRight className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
            )}
            {onAddChat && (
              <button
                type="button"
                onClick={onAddChat}
                className="inline-flex h-[30px] items-center gap-1.5 rounded-[8px] px-2.5 text-[13px] font-medium text-foreground/85 hover:bg-foreground/5 hover:text-foreground focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                <MessageSquareQuote className="h-3.5 w-3.5" />
                <span>{t('reference.addChat')}</span>
              </button>
            )}
            {onAddNewChat && (
              <button
                type="button"
                onClick={onAddNewChat}
                className="inline-flex h-[30px] items-center gap-1.5 rounded-[8px] px-2.5 text-[13px] font-medium text-foreground/85 hover:bg-foreground/5 hover:text-foreground focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                <MessageSquarePlus className="h-3.5 w-3.5" />
                <span>{t('reference.newChat')}</span>
              </button>
            )}
          </div>
        </IslandContentView>

        <IslandFollowUpContentView
          id="confirm-follow-up"
          mode={mode}
          value={draft}
          onValueChange={onDraftChange}
          onCancel={onCancel}
          onRequestEdit={onRequestEdit}
          onSubmit={onSubmit}
          onSubmitAndSend={onSubmitAndSend}
          onDelete={onDelete}
          title={t('chat.followUp')}
          submitLabel={t('common.save')}
          placeholder={t('chat.annotationPlaceholder')}
          maxInputHeight={320}
          sendMessageKey={sendMessageKey}
          lockScroll
          blockOutsideInteraction
        />
      </Island>
    </div>
  )

  return usePortal ? ReactDOM.createPortal(menuNode, document.body) : menuNode
}
