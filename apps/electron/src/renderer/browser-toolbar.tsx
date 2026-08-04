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
  useRef,
  useState,
  type ReactNode,
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
  EyeOff,
  PanelRightClose,
  Star,
  Trash2,
  X,
  XCircle,
} from 'lucide-react'
import { BrowserControls } from '@craft-agent/ui'
import { HeaderIconButton } from '@/components/ui/HeaderIconButton'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  StyledDropdownMenuContent,
  StyledDropdownMenuItem,
} from '@/components/ui/styled-dropdown'
import './index.css'

// This is a standalone entry (browser-toolbar.html) — i18n must be initialized
// here or BrowserControls and the menu below render raw translation keys.
setupI18n([LanguageDetector, initReactI18next])

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
  isPanel?: boolean
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
      removeBookmark: (bookmarkId: string) => Promise<BrowserBookmark[]>
      setMenuGeometry: (open: boolean, height?: number) => Promise<void>
      hideWindow: () => Promise<void>
      closeWindowEntirely: () => Promise<void>
      onStateUpdate: (callback: (state: ToolbarState) => void) => () => void
      onThemeColor: (callback: (color: string | null) => void) => () => void
      onBookmarksChanged: (callback: (bookmarks: BrowserBookmark[]) => void) => () => void
      onForceCloseMenu: (callback: (payload: { reason?: string }) => void) => () => void
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
  const [bookmarksLoading, setBookmarksLoading] = useState(true)
  const [bookmarksError, setBookmarksError] = useState<string | null>(null)
  const [bookmarksOpen, setBookmarksOpen] = useState(false)
  const [windowMenuOpen, setWindowMenuOpen] = useState(false)
  const menuContentRef = useRef<HTMLDivElement | null>(null)

  const api = window.browserToolbar
  const isPanel = state.isPanel === true
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
  const menuOpen = bookmarksOpen || windowMenuOpen
  const bookmarkActionLabel = t(
    isBookmarked
      ? 'browser.removeCurrentBookmark'
      : 'browser.bookmarkCurrentPage',
  )
  const bookmarksLabel = t('browser.bookmarks')

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
    setBookmarksLoading(true)
    setBookmarksError(null)
    try {
      setBookmarks(await api.listBookmarks())
    } catch (error) {
      console.error('[BrowserToolbar] Failed to load bookmarks:', error)
      setBookmarksError(t('browser.bookmarksUnavailable'))
    } finally {
      setBookmarksLoading(false)
    }
  }, [api, t])

  useEffect(() => {
    void loadBookmarks()
  }, [loadBookmarks])

  useEffect(() => {
    if (!api) return
    return api.onBookmarksChanged((nextBookmarks) => {
      setBookmarks(nextBookmarks)
      setBookmarksError(null)
      setBookmarksLoading(false)
    })
  }, [api])

  useEffect(() => {
    if (!api) return
    return api.onForceCloseMenu(() => {
      setBookmarksOpen(false)
      setWindowMenuOpen(false)
    })
  }, [api])

  useEffect(() => {
    if (!api) return

    if (!menuOpen) {
      void api.setMenuGeometry(false, 0)
      return
    }

    // Prime expansion immediately to avoid a constrained first measurement.
    void api.setMenuGeometry(true, bookmarksOpen ? 420 : 120)

    const sendGeometry = () => {
      const height = Math.ceil(menuContentRef.current?.getBoundingClientRect().height ?? 0)
      void api.setMenuGeometry(true, height)
    }

    const frame = requestAnimationFrame(sendGeometry)
    const observer = new ResizeObserver(sendGeometry)

    if (menuContentRef.current) {
      observer.observe(menuContentRef.current)
    }

    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
      void api.setMenuGeometry(false, 0)
    }
  }, [api, bookmarksOpen, menuOpen])

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
    setBookmarksError(null)
    try {
      const result = await api.toggleBookmark()
      setBookmarks(result.bookmarks)
    } catch (error) {
      console.error('[BrowserToolbar] Failed to toggle bookmark:', error)
      setBookmarksError(t('browser.bookmarksUnavailable'))
      setBookmarksOpen(true)
    }
  }, [api, isBookmarkable, t])

  const handleRemoveBookmark = useCallback(async (bookmarkId: string) => {
    if (!api) return
    setBookmarksError(null)
    try {
      setBookmarks(await api.removeBookmark(bookmarkId))
    } catch (error) {
      console.error('[BrowserToolbar] Failed to remove bookmark:', error)
      setBookmarksError(t('browser.bookmarksUnavailable'))
    }
  }, [api, t])

  const handleOpenBookmark = useCallback((bookmark: BrowserBookmark) => {
    setBookmarksOpen(false)
    void api?.navigate(bookmark.url)
  }, [api])

  const handleBookmarksOpenChange = useCallback((open: boolean) => {
    setBookmarksOpen(open)
    if (!open) return
    setWindowMenuOpen(false)
    void loadBookmarks()
  }, [loadBookmarks])

  const handleWindowMenuOpenChange = useCallback((open: boolean) => {
    setWindowMenuOpen(open)
    if (open) setBookmarksOpen(false)
  }, [])

  const handleHideWindow = useCallback(() => {
    setWindowMenuOpen(false)
    void api?.hideWindow()
  }, [api])

  const handleCloseWindowEntirely = useCallback(() => {
    setWindowMenuOpen(false)
    void api?.closeWindowEntirely()
  }, [api])

  const toolbarButtonClassName = themeColor
    ? ''
    : 'bg-background shadow-minimal hover:bg-foreground/5'
  const toolbarButtonStyle = themeColor
    ? { color: 'var(--tb-fg)' }
    : undefined

  let bookmarksMenuContent: ReactNode
  if (bookmarksLoading) {
    bookmarksMenuContent = (
      <div className="px-2 py-6 text-center text-xs text-muted-foreground">
        {t('common.loading')}
      </div>
    )
  } else if (bookmarksError) {
    bookmarksMenuContent = (
      <div className="max-w-[300px] whitespace-normal px-2 py-6 text-center text-xs text-destructive">
        {bookmarksError}
      </div>
    )
  } else if (bookmarks.length === 0) {
    bookmarksMenuContent = (
      <div className="flex max-w-[300px] flex-col items-center gap-1.5 px-5 py-7 text-center">
        <Bookmark className="h-4 w-4 text-foreground/25" />
        <div className="text-xs font-medium text-foreground/70">
          {t('browser.noBookmarks')}
        </div>
        <div className="whitespace-normal text-[11px] leading-4 text-muted-foreground">
          {t('browser.bookmarksEmptyHint')}
        </div>
      </div>
    )
  } else {
    bookmarksMenuContent = (
      <div className="flex max-h-[320px] flex-col gap-0.5 overflow-y-auto">
        {bookmarks.map((bookmark) => {
          const removeBookmarkLabel = t('browser.removeBookmark', { title: bookmark.title })
          return (
            <div
              key={bookmark.id}
              className="group flex min-w-0 items-center gap-1 rounded-[6px] hover:bg-foreground/[0.03] focus-within:bg-foreground/[0.03]"
            >
              <button
                type="button"
                className="min-w-0 flex-1 px-2 py-1.5 text-left outline-none"
                onClick={() => handleOpenBookmark(bookmark)}
              >
                <div className="truncate text-xs font-medium text-foreground/80" title={bookmark.title}>
                  {bookmark.title}
                </div>
                <div className="truncate text-[10px] text-muted-foreground/70" title={bookmark.url}>
                  {new URL(bookmark.url).hostname}
                </div>
              </button>
              <button
                type="button"
                className="mr-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-[4px] text-muted-foreground opacity-60 outline-none hover:bg-foreground/5 hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring group-hover:opacity-100"
                aria-label={removeBookmarkLabel}
                title={removeBookmarkLabel}
                onClick={() => { void handleRemoveBookmark(bookmark.id) }}
              >
                <Trash2 className="h-3 w-3" />
              </button>
            </div>
          )
        })}
      </div>
    )
  }

  return (
    <>
      {/*
        Full-window outside-tap catcher while menu is open.
        Critical for draggable titlebar windows (Windows) where outside-click
        dismissal can be unreliable if events fall into app-region: drag zones.
      */}
      {menuOpen && (
        <div
          className="fixed inset-0 z-[90] titlebar-no-drag bg-black/[0.0039215686]"
          onPointerDown={(event) => {
            event.preventDefault()
            setBookmarksOpen(false)
            setWindowMenuOpen(false)
          }}
        />
      )}

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

            <DropdownMenu open={bookmarksOpen} onOpenChange={handleBookmarksOpenChange}>
              <DropdownMenuTrigger asChild>
                <HeaderIconButton
                  icon={<Bookmark className="h-3.5 w-3.5" />}
                  aria-label={bookmarksLabel}
                  title={bookmarksLabel}
                  className={toolbarButtonClassName}
                  style={toolbarButtonStyle}
                />
              </DropdownMenuTrigger>

              <StyledDropdownMenuContent
                ref={menuContentRef}
                align="end"
                side="bottom"
                sideOffset={6}
                minWidth="min-w-80"
                className="titlebar-no-drag z-[110] max-h-none overflow-visible p-1.5"
              >
                <div className="px-2 pb-1.5 pt-1 text-[11px] font-medium text-foreground/45">
                  {bookmarksLabel}
                </div>
                {bookmarksMenuContent}
              </StyledDropdownMenuContent>
            </DropdownMenu>

            <DropdownMenu open={windowMenuOpen} onOpenChange={handleWindowMenuOpenChange}>
              <DropdownMenuTrigger asChild>
                <HeaderIconButton
                  icon={<X className="h-3.5 w-3.5" />}
                  aria-label={t('browser.windowOptions')}
                  className={toolbarButtonClassName}
                  style={toolbarButtonStyle}
                />
              </DropdownMenuTrigger>

              <StyledDropdownMenuContent
                ref={menuContentRef}
                align="end"
                side="bottom"
                sideOffset={6}
                minWidth="min-w-44"
                className="titlebar-no-drag z-[110] max-h-none overflow-visible"
              >
                <StyledDropdownMenuItem onSelect={handleHideWindow}>
                  {isPanel ? (
                    <PanelRightClose className="h-3.5 w-3.5" />
                  ) : (
                    <EyeOff className="h-3.5 w-3.5" />
                  )}
                  {t(isPanel ? 'browser.closePanel' : 'browser.hideWindow')}
                </StyledDropdownMenuItem>
                <StyledDropdownMenuItem variant="destructive" onSelect={handleCloseWindowEntirely}>
                  <XCircle className="h-3.5 w-3.5" />
                  {t(isPanel ? 'browser.terminateBrowser' : 'browser.closeWindowEntirely')}
                </StyledDropdownMenuItem>
              </StyledDropdownMenuContent>
            </DropdownMenu>
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
