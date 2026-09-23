/**
 * Wire protocol for the `client:browser:invoke` capability.
 *
 * The remote `RemoteBrowserPaneManager` packages an `IBrowserPaneManager`
 * method call into a `BrowserCapabilityRequest` and the local dispatcher
 * (Electron main IPC) executes it on the real `BrowserPaneManager`.
 *
 * See docs/adr-transport-locality.md for the locality boundary definition.
 */

export const BROWSER_CAPABILITY_VERSION = 1

/**
 * Names map 1:1 to `IBrowserPaneManager` methods.
 * Positional `args` carry the method's arguments in declaration order.
 */
export type BrowserCapabilityMethod =
  // Lifecycle / instances
  | 'createForSession'
  | 'getOrCreateForSession'
  | 'focusBoundForSession'
  | 'destroyInstance'
  | 'destroyForSession'
  | 'beginProjectDeletion'
  | 'finishProjectDeletion'
  | 'getInstance'
  | 'listInstances'
  | 'bindSession'
  | 'unbindAllForSession'
  | 'setAgentControl'
  | 'clearAgentControl'
  | 'clearAgentControlForInstance'
  | 'clearVisualsForSession'
  | 'focus'
  | 'hide'
  // Navigation
  | 'navigate'
  | 'goBack'
  | 'goForward'
  // Interaction
  | 'getAccessibilitySnapshot'
  | 'clickElement'
  | 'clickAtCoordinates'
  | 'drag'
  | 'fillElement'
  | 'typeText'
  | 'selectOption'
  | 'sendKey'
  | 'scroll'
  | 'waitFor'
  | 'evaluate'
  // Clipboard
  | 'setClipboard'
  | 'getClipboard'
  // Capture / introspection
  | 'screenshot'
  | 'screenshotRegion'
  | 'getConsoleLogs'
  | 'getNetworkLogs'
  | 'windowResize'
  | 'getDownloads'
  | 'uploadFile'
  | 'detectSecurityChallenge'

export interface BrowserCapabilityRequest {
  /** Protocol version. Always `1` for now; bumped on breaking shape changes. */
  v: 1
  method: BrowserCapabilityMethod
  /** Positional args matching `IBrowserPaneManager[method]` signature. */
  args: unknown[]
  /** Owning session — used for owner-key namespacing on the client dispatcher. */
  sessionId: string
  /** Owning workspace — combined with `sessionId` to form the owner-key prefix. */
  workspaceId: string
}

export interface BrowserApplicationProjectContext {
  projectExists: boolean
  chatTargets: Array<{
    id: string
    title: string
    noteTargetPath: string | null
  }>
}

export interface BrowserApplicationProjectTarget {
  id: string
  title: string
}

export type BrowserApplicationCapabilityRequest =
  | {
      v: 1
      action: 'get-application-readiness'
      workspaceId: string
    }
  | {
      v: 1
      action: 'list-project-targets'
      workspaceId: string
    }
  | {
      v: 1
      action: 'get-project-context'
      workspaceId: string
      projectId: string
      /** Include this Browser's owner even when it is hidden from Chat selectors. */
      includeOwnerSessionId?: string
    }
  | {
      v: 1
      action: 'add-selection-note'
      requestId: string
      mode: 'current' | 'choose-target'
      workspaceId: string
      projectId: string
      sessionId: string | null
      source: import('@craft-agent/shared/protocol').BrowserSelectionSource
    }
  | {
      v: 1
      action: 'open-chat'
      workspaceId: string
      projectId: string
      sessionId: string
    }
  | {
      v: 1
      action: 'add-selection-to-chat'
      requestId: string
      workspaceId: string
      projectId: string
      sessionId: string
      source: import('@craft-agent/shared/protocol').BrowserSelectionSource
    }
  | {
      v: 1
      action: 'create-chat-from-selection'
      requestId: string
      workspaceId: string
      projectId: string
      source: import('@craft-agent/shared/protocol').BrowserSelectionSource
    }

export type BrowserApplicationCapabilityResponse =
  | BrowserApplicationProjectContext
  | { projectTargets: BrowserApplicationProjectTarget[] }
  | { applicationReady: boolean }
  | { ok: true }
  | { ok: true; noteTargetPath: string; sessionId: string | null }
  | { ok: false; reason: 'cancelled' }
  | { ok: true; sessionId: string; targetTitle: string }

/**
 * Wire shape for `screenshot` / `screenshotRegion` results.
 *
 * The local `BrowserScreenshotResult` carries a Node `Buffer` for `imageBuffer`,
 * which doesn't survive structured cloning over WS. The dispatcher converts
 * `Buffer → Uint8Array` here, and `RemoteBrowserPaneManager` converts it back.
 */
export interface ScreenshotResultWire {
  imageFormat: 'png' | 'jpeg'
  imageBytes: Uint8Array
  metadata?: Record<string, unknown>
}
