/**
 * Browser Toolbar — React entry point
 *
 * Renders the shared BrowserControls component inside a chromeless
 * BrowserWindow. Communicates with the main process via a dedicated
 * preload script (browser-toolbar preload).
 */

import React, {
  useCallback,
  useEffect,
  useState,
} from 'react'
import ReactDOM from 'react-dom/client'
import { useTranslation, initReactI18next } from 'react-i18next'
import LanguageDetector from 'i18next-browser-languagedetector'
import { setupI18n } from '@craft-agent/shared/i18n'
import type {
  BrowserBookmark,
  ToggleBrowserBookmarkResult,
} from '@craft-agent/shared/browser-bookmarks'
import {
  Bookmark,
  FolderKanban,
  MessageSquareMore,
  NotebookPen,
  PanelLeftOpen,
  Star,
  X,
} from 'lucide-react'
import { BrowserControls } from '@craft-agent/ui'
import { HeaderIconButton } from '@/components/ui/HeaderIconButton'
import './index.css'

// This is a standalone entry (browser-toolbar.html) — i18n must be initialized
// here or BrowserControls renders raw translation keys.
document.title = __APP_PRODUCT_NAME__
setupI18n([LanguageDetector, initReactI18next], { productName: __APP_PRODUCT_NAME__ })

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface ToolbarState {
  url: string
  title: string
  isLoading: boolean
  canGoBack: boolean
  canGoForward: boolean
  themeColor?: string | null
  targetSessionId?: string | null
  targetChatTitle?: string | null
  targetNotePath?: string | null
  selectionFeedback?: {
    kind: 'success' | 'error'
    message: string
  } | null
  canChooseTargetChat?: boolean
  projectId?: string | null
  projectTitle?: string | null
  canChooseProject?: boolean
}

declare global {
  interface Window {
    browserToolbar: {
      instanceId: string
      navigate: (url: string) => Promise<void>
      goBack: () => Promise<void>
      goForward: () => Promise<void>
      reload: () => Promise<void>
      stop: () => Promise<void>
      listBookmarks: () => Promise<BrowserBookmark[]>
      toggleBookmark: () => Promise<ToggleBrowserBookmarkResult>
      showMenu: (kind: 'bookmarks' | 'projects' | 'chats' | 'window') => Promise<void>
      openTargetChat: () => Promise<void>
      onStateUpdate: (callback: (state: ToolbarState) => void) => () => void
      onThemeColor: (callback: (color: string | null) => void) => () => void
      onBookmarksChanged: (callback: (bookmarks: BrowserBookmark[]) => void) => () => void
    }
  }
}

/* ------------------------------------------------------------------ */
/*  App                                                                */
/* ------------------------------------------------------------------ */

function BrowserToolbarApp() {
  const { t } = useTranslation()
  const [state, setState] = useState<ToolbarState>({
    url: 'about:blank',
    title: 'New Tab',
    isLoading: false,
    canGoBack: false,
    canGoForward: false,
  })
  const [themeColor, setThemeColor] = useState<string | null>(null)
  const [bookmarks, setBookmarks] = useState<BrowserBookmark[]>([])

  const api = window.browserToolbar
  const isBookmarkable = (() => {
    try {
      const protocol = new URL(state.url).protocol
      return protocol === 'http:' || protocol === 'https:'
    } catch {
      return false
    }
  })()
  const isBookmarked = isBookmarkable
    && bookmarks.some(bookmark => bookmark.url === state.url)
  const bookmarkActionLabel = t(
    isBookmarked
      ? 'browser.removeCurrentBookmark'
      : 'browser.bookmarkCurrentPage',
  )
  const bookmarksLabel = t('browser.bookmarks')
  const chooseTargetChatLabel = t('browser.chooseTargetChat')
  const openTargetChatLabel = t('browser.openTargetChat')
  const windowOptionsLabel = t('browser.windowOptions')
  const targetChatLabel = state.targetChatTitle ?? chooseTargetChatLabel
  const projectLabel = state.projectTitle ?? state.projectId ?? t('tasks.project')
  const projectActionLabel = `${t('tasks.project')}: ${projectLabel}`
  const targetNoteLabel = state.projectId
    ? (state.targetNotePath ?? t('projectNoteTarget.chooseFile'))
    : null

  useEffect(() => {
    if (!api) return
    return api.onStateUpdate((s) => {
      setState(s)
      // Sync theme color from full state push (initial load / reconnection)
      if ('themeColor' in s) {
        setThemeColor((s as ToolbarState).themeColor ?? null)
      }
    })
  }, [api])

  useEffect(() => {
    if (!api) return
    return api.onThemeColor(setThemeColor)
  }, [api])

  const loadBookmarks = useCallback(async () => {
    if (!api) return
    try {
      setBookmarks(await api.listBookmarks())
    } catch (error) {
      console.error('[BrowserToolbar] Failed to load bookmarks:', error)
    }
  }, [api])

  useEffect(() => {
    void loadBookmarks()
  }, [loadBookmarks])

  useEffect(() => {
    if (!api) return
    return api.onBookmarksChanged((nextBookmarks) => {
      setBookmarks(nextBookmarks)
    })
  }, [api])

  const handleNavigate = useCallback((url: string) => {
    void api?.navigate(url)
  }, [api])

  const handleGoBack = useCallback(() => {
    void api?.goBack()
  }, [api])

  const handleGoForward = useCallback(() => {
    void api?.goForward()
  }, [api])

  const handleReload = useCallback(() => {
    void api?.reload()
  }, [api])

  const handleStop = useCallback(() => {
    void api?.stop()
  }, [api])

  const handleToggleBookmark = useCallback(async () => {
    if (!api || !isBookmarkable) return
    try {
      const result = await api.toggleBookmark()
      setBookmarks(result.bookmarks)
    } catch (error) {
      console.error('[BrowserToolbar] Failed to toggle bookmark:', error)
    }
  }, [api, isBookmarkable])

  const toolbarButtonClassName = themeColor
    ? ''
    : 'bg-background shadow-minimal hover:bg-foreground/5'
  const toolbarButtonStyle = themeColor
    ? { color: 'var(--tb-fg)' }
    : undefined

  return (
    <>
      <BrowserControls
        url={state.url}
        loading={state.isLoading}
        canGoBack={state.canGoBack}
        canGoForward={state.canGoForward}
        onNavigate={handleNavigate}
        onGoBack={handleGoBack}
        onGoForward={handleGoForward}
        onReload={handleReload}
        onStop={handleStop}
        trailingContent={(
          <div className="ml-2 flex items-center gap-1.5 titlebar-no-drag">
            {state.selectionFeedback && (
              <span
                role="status"
                title={state.selectionFeedback.message}
                className={`max-w-[260px] truncate rounded-[4px] px-2 py-1 text-[11px] ${
                  state.selectionFeedback.kind === 'error'
                    ? 'bg-destructive/10 text-destructive'
                    : 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
                }`}
              >
                {state.selectionFeedback.message}
              </span>
            )}

            <HeaderIconButton
              icon={(
                <Star
                  className="h-3.5 w-3.5"
                  fill={isBookmarked ? 'currentColor' : 'none'}
                />
              )}
              aria-label={bookmarkActionLabel}
              title={bookmarkActionLabel}
              disabled={!isBookmarkable}
              onClick={() => { void handleToggleBookmark() }}
              className={toolbarButtonClassName}
              style={toolbarButtonStyle}
            />

            <HeaderIconButton
              icon={<Bookmark className="h-3.5 w-3.5" />}
              aria-label={bookmarksLabel}
              title={bookmarksLabel}
              className={toolbarButtonClassName}
              style={toolbarButtonStyle}
              onClick={() => { void api?.showMenu('bookmarks') }}
            />

            <button
              type="button"
              aria-label={projectActionLabel}
              title={projectActionLabel}
              disabled={!state.projectId || state.canChooseProject === false}
              className={`inline-flex h-7 max-w-[140px] items-center gap-1.5 rounded-[4px] px-2 text-[11px] text-muted-foreground transition-colors hover:bg-foreground/3 hover:text-foreground disabled:opacity-70 ${toolbarButtonClassName}`}
              style={toolbarButtonStyle}
              onClick={() => { void api?.showMenu('projects') }}
            >
              <FolderKanban className="h-3.5 w-3.5 shrink-0" />
              <span className="truncate">{projectLabel}</span>
            </button>

            <button
              type="button"
              aria-label={targetChatLabel}
              title={targetChatLabel}
              disabled={state.canChooseTargetChat === false}
              className={`inline-flex h-7 max-w-[140px] items-center gap-1.5 rounded-[4px] px-2 text-[11px] text-muted-foreground transition-colors hover:bg-foreground/3 hover:text-foreground disabled:opacity-70 ${toolbarButtonClassName}`}
              style={toolbarButtonStyle}
              onClick={() => { void api?.showMenu('chats') }}
            >
              <MessageSquareMore className="h-3.5 w-3.5 shrink-0" />
              <span className="truncate">{targetChatLabel}</span>
            </button>

            {targetNoteLabel && (
              <span
                aria-label={targetNoteLabel}
                title={targetNoteLabel}
                className="inline-flex h-7 max-w-[140px] items-center gap-1.5 rounded-[4px] px-2 text-[11px] text-muted-foreground"
                style={toolbarButtonStyle}
              >
                <NotebookPen className="h-3.5 w-3.5 shrink-0" />
                <span className="truncate">{targetNoteLabel}</span>
              </span>
            )}

            <HeaderIconButton
              icon={<PanelLeftOpen className="h-3.5 w-3.5" />}
              aria-label={openTargetChatLabel}
              title={openTargetChatLabel}
              disabled={!state.targetSessionId}
              className={toolbarButtonClassName}
              style={toolbarButtonStyle}
              onClick={() => { void api?.openTargetChat() }}
            />

            <HeaderIconButton
              icon={<X className="h-3.5 w-3.5" />}
              aria-label={windowOptionsLabel}
              className={toolbarButtonClassName}
              style={toolbarButtonStyle}
              onClick={() => { void api?.showMenu('window') }}
            />
          </div>
        )}
        themeColor={themeColor}
        urlBarClassName="max-w-[600px]"
        className="titlebar-drag-region bg-background"
      />
    </>
  )
}

/* ------------------------------------------------------------------ */
/*  Mount                                                              */
/* ------------------------------------------------------------------ */

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserToolbarApp />
  </React.StrictMode>,
)
