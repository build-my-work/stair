import type {
  DrawnixBoardCapabilityRequest,
  DrawnixBoardCapabilityResponse,
  EventSink,
  RpcServer,
} from '@craft-agent/server-core/transport'
import {
  CLIENT_BROWSER_INVOKE,
  CLIENT_DRAWNIX_BOARD_DISCOVER,
  CLIENT_DRAWNIX_BOARD_INVOKE,
  requestClientBrowserInvoke,
  requestClientDrawnixBoardDiscovery,
  requestClientDrawnixBoardInvoke,
} from '@craft-agent/server-core/transport'
import type { ISessionManager, IBrowserPaneManager, ExecutePromptAutomationInput } from '@craft-agent/server-core/handlers'
import { RemoteBrowserPaneManager } from './RemoteBrowserPaneManager'
import { validateFilePath, getWorkspaceAllowedDirs } from '@craft-agent/server-core/handlers'
import { createScopedLogger, CONSOLE_LOGGER, type PlatformServices, type Logger } from '@craft-agent/server-core/runtime'
import { basename, dirname, isAbsolute, join, relative, sep } from 'path'
import { existsSync } from 'fs'
import { readFile, writeFile, mkdir, realpath, copyFile } from 'fs/promises'
import { randomUUID } from 'node:crypto'
import { type AgentEvent, type ChatOptions, getPermissionMode, setPermissionMode, setGuardedModeActiveResolver, clampPermissionMode, planExecutionMode, parsePermissionMode, hydratePreviousPermissionMode, getPermissionModeDiagnostics, type PermissionMode, unregisterSessionScopedToolCallbacks, mergeSessionScopedToolCallbacks, AbortReason, type AuthRequest, type AuthResult, type CredentialAuthRequest, type BrowserWindowFns, generateConversationSummary, resolveKeepBackgroundTasksAlive } from '@craft-agent/shared/agent'
import {
  resolveSessionConnection,
  createBackendFromConnection,
  resolveBackendContext,
  createBackendFromResolvedContext,
  cleanupSourceRuntimeArtifacts,
  providerTypeToAgentProvider,
  type AgentBackend,
  type BackendHostRuntimeContext,
  type PostInitResult,
} from '@craft-agent/shared/agent/backend'
import { getLlmConnection, getLlmConnections, getDefaultLlmConnection, getDefaultThinkingLevel, purgeSessionDraft, resetManagedAnthropicAuthEnvVars, resolveMidStreamBehavior, getPersistedUiLanguage, resolveTitleLanguageName, hasAppliedDraftRestore, consumeSessionDraftForPlan, getPlanDraftConsumption, restoreSessionDraftAtomic, retirePlanDraftConsumption } from '@craft-agent/shared/config'
import type { MidStreamBehavior } from '@craft-agent/shared/config'
import { PrivilegedExecutionBroker } from '@craft-agent/server-core/services'
import { isValidWorkingDirectory } from '../utils/path-validation'
import { InitGate } from '@craft-agent/server-core/domain'
import { i18n } from '@craft-agent/shared/i18n'
import {
  getWorkspaces,
  getWorkspaceByNameOrId,
  loadConfigDefaults,
  loadPreferences,
  migrateLegacyCredentials,
  migrateLegacyLlmConnectionsConfig,
  migrateOrphanedDefaultConnections,
  MODEL_REGISTRY,
  type Workspace,
  type WorkspaceInfo,
} from '@craft-agent/shared/config'
import type { ActiveSessionInfo, ContentBadge, ContextUsageSnapshot, PermissionRisk, SessionProcessingStatus } from '@craft-agent/core/types'
import { referenceKey } from '@craft-agent/core/types'
import { loadWorkspaceConfig } from '@craft-agent/shared/workspaces'
import {
  // Session persistence functions
  listSessions as listStoredSessions,
  loadSession as loadStoredSession,
  saveSession as saveStoredSession,
  createSession as createStoredSession,
  getOrCreateSessionById as getOrCreateStoredSessionById,
  deleteSession as deleteStoredSession,
  deleteSessionAsync,
  updateSessionMetadata,
  canUpdateSdkCwd,
  getPendingPlanExecution as getStoredPendingPlanExecution,
  getSessionAttachmentsPath,
  getSessionPath as getSessionStoragePath,
  ensureSessionDir,
  getSessionFilePath,
  readSessionHeader,
  generateSessionId,
  sessionPersistenceQueue,
  getHeaderMetadataSignature,
  writeSessionJsonl,
  serializeSession,
  validateBundle,
  type SessionBundle,
  type DispatchMode,
  type StoredSession,
  type StoredMessage,
  type SessionMetadata,
  type SessionStatus,
  type SessionHeader,
  pickSessionFields,
} from '@craft-agent/shared/sessions'
import { serializeHeaderCredential, loadWorkspaceSources, loadAllSources, getSourcesBySlugs, isSourceUsable, type LoadedSource, type McpServerConfig, getSourcesNeedingAuth, getSourceCredentialManager, TokenRefreshManager } from '@craft-agent/shared/sources'
import { listTaskSlugs, parseTaskSpec, uniqueTaskSlug } from '@craft-agent/shared/tasks'
import { createTaskFromSpec } from '../tasks'
import { buildPagesToolCallbacks } from '../pages/tool-callbacks'
import { buildPrWatchToolCallbacks } from '../pr-watch/tool-callbacks'
import { prEntryId } from '@craft-agent/shared/pr-watch'
import { getPrAutoFixMonitor, getPrWatchRegistry } from '../handlers/rpc/pr-watch'
import { buildDecisionToolCallbacks } from '../decisions/tool-callbacks'
import { buildServersFromSources as buildServersFromSourcesShared } from '../sources/build-servers'
import { buildMcpSourceToolCallbacks } from '../sources/mcp-source-tool-callbacks'
import { ConfigWatcher, type ConfigWatcherCallbacks } from '@craft-agent/shared/config'
import { getValidClaudeOAuthToken } from '@craft-agent/shared/auth'
import { resolveAuthEnvVars } from '@craft-agent/shared/config'
import { toolMetadataStore, getLastApiError } from '@craft-agent/shared/interceptor'
import { isParentTaskTool } from '@craft-agent/shared/utils/toolNames'
import { redactBrowserPasswordFills } from '@craft-agent/shared/agent'
import { restoreFiles } from '@craft-agent/shared/utils/bundle-files'
import { getCredentialManager } from '@craft-agent/shared/credentials'
import { CraftMcpClient, McpClientPool, McpPoolServer } from '@craft-agent/shared/mcp'
import { type BrowserInstanceInfo, type Session, type SessionEvent, type FileAttachment, type SendMessageOptions, type UnreadSummary, type RemoteSessionTransferPayload, type ImportRemoteSessionTransferResult, type BackgroundTaskOutput, type StopBackgroundTaskResult, type BoundPr, type PrMonitorState, RPC_CHANNELS, generateMessageId } from '@craft-agent/shared/protocol'
import { launchOutputFile, readBackgroundTaskOutput } from './background-task-output'
import {
  isChatMessageReference,
  messageToStored,
  storedToMessage,
  type Message,
  type Reference,
  type StoredAttachment,
  type ToolDisplayMeta,
  type TokenUsage,
} from '@craft-agent/core/types'
import { formatPathsToRelative, formatToolInputPaths, perf, encodeIconToDataUrlAsync, getEmojiIcon, resetSummarizationClient, resolveToolIcon, readFileAttachment, selectSpreadMessages, normalizePath } from '@craft-agent/shared/utils'
import { loadAllSkills, loadSkillBySlug, invalidateSkillsCache, type LoadedSkill } from '@craft-agent/shared/skills'
import { invalidateContextFileCache } from '@craft-agent/shared/prompts/system'
import { getToolIconsDir, getMiniModel } from '@craft-agent/shared/config'
import { getDefaultSummarizationModel } from '@craft-agent/shared/config/models'
import type { SummarizeCallback } from '@craft-agent/shared/sources'
import { type ThinkingLevel, DEFAULT_THINKING_LEVEL, normalizeThinkingLevel } from '@craft-agent/shared/agent/thinking-levels'
import { evaluateAutoLabels, autoLabelMatchToEntry, newAutoLabelEntries, type AutoLabelMatch } from '@craft-agent/shared/labels/auto'
import { evaluateSemanticLabelsForMessage } from '../decisions/semantic-labels'
import { classifyTurnOutcome, TURN_OUTCOME_ATTENTION_STATUS } from '../decisions/turn-outcome'
import { isSmallTalk, titleNoLongerFits, TITLE_DRIFT_RECENT_MESSAGES } from '../decisions/smart-titles'
import { pickTurnThinkingLevel, recordThinkingFollowUp } from '../decisions/adaptive-thinking'
import { decideMidTurnDelivery, isContinuation } from '../decisions/mid-turn-messages'
import { candidatesUsedBy, collectSuggestionCandidates, formatSuggestionHint, pickSuggestion, suggestionFollowUp, wantsSuggestion, type SuggestionTrace } from '../decisions/suggestions'
import { isDecisionFeatureActive, type DecisionLayerFeature, type DecisionResult } from '@craft-agent/shared/decisions'
import { setLargeResultFilter } from '@craft-agent/shared/utils'
import { buildLargeResultFilter, finishLargeResultExcerpts, noteLargeResultFileUse } from '../decisions/large-results'
import { buildGuardedModeCheck } from '../decisions/guarded-mode'
import { buildSubagentModelPicker } from '../decisions/subagent-models'
import { assessPermissionRisks } from '../decisions/permission-risks'
import { checkAutomationCondition } from '../decisions/automation-condition'
import { listLabels, loadLabelConfig } from '@craft-agent/shared/labels/storage'
import { extractLabelId, resolveSessionLabels, findTaskItemLabelId, LabelEntrySet, canonicalizeSessionLabels, foldsValueCase, type LabelConfig } from '@craft-agent/shared/labels'
import { ensureLabelsExist, ensureTaskItemLabel } from '@craft-agent/shared/labels/crud'
import { loadStatusConfig } from '@craft-agent/shared/statuses/storage'
import { AutomationSystem, createPromptHistoryEntry, appendAutomationHistoryEntry, type AutomationSystemMetadataSnapshot, type PendingPrompt } from '@craft-agent/shared/automations'
import { buildBackendRuntimeSignature, buildRestartRequiredSignature, filterAttachmentsForModelInput } from './runtime-config'
import { validateArchiveTarget } from './archive-guards'
import { addTurnUsage, branchStartTotals, type BranchParent } from './turn-usage'
import {
  formatReferencesForModel,
  normalizeReferencesForSession,
  stripReferencesFromModelInput,
  validateProjectFileReferencesForSend,
  validateReferencesForSession,
} from './message-references'
import { buildRecoveryMessages } from './recovery-messages'
import { buildPlanApprovalMessage } from '@craft-agent/shared/sessions/plan-approval'

// Import from server-core domain utilities
import { sanitizeForTitle, shouldActivateBrowserOverlay, normalizeBrowserToolName, rollbackFailedBranchCreation, releaseBrowserOwnershipOnForcedStop } from '@craft-agent/server-core/domain'
import { resizeImageForAPI, resizeIconBuffer } from '@craft-agent/server-core/services'
export { sanitizeForTitle }

// Module-level platform ref — set once during init via setSessionPlatform()
let _platform: PlatformServices | null = null

// Scoped logger — upgraded from console fallback when setSessionPlatform() is called.
// Named `sessionLog` so all ~30 existing call sites remain unchanged.
let sessionLog: Logger = createScopedLogger(CONSOLE_LOGGER, 'session')

export function setSessionPlatform(platform: PlatformServices): void {
  _platform = platform
  sessionLog = createScopedLogger(platform.logger, 'session')
}

interface SessionRuntimeHooks {
  updateBadgeCount: (count: number) => void
  captureException: (error: unknown, context?: { errorSource?: string; sessionId?: string }) => void
  onSessionStarted: () => void
  onSessionStopped: () => void
}

const defaultSessionRuntimeHooks: SessionRuntimeHooks = {
  updateBadgeCount: () => {},
  onSessionStarted: () => {},
  onSessionStopped: () => {},
  captureException: (error, context) => {
    const err = error instanceof Error ? error : new Error(String(error))
    if (_platform?.captureError) {
      _platform.captureError(err)
      return
    }
    sessionLog.error('[runtime-hooks] captureException fallback:', {
      errorSource: context?.errorSource,
      sessionId: context?.sessionId,
      message: err.message,
      stack: err.stack,
    })
  },
}

let sessionRuntimeHooks: SessionRuntimeHooks = defaultSessionRuntimeHooks

export function setSessionRuntimeHooks(hooks: Partial<SessionRuntimeHooks>): void {
  sessionRuntimeHooks = {
    ...sessionRuntimeHooks,
    ...hooks,
  }
}

function buildBackendHostRuntimeContext(): BackendHostRuntimeContext {
  if (!_platform) throw new Error('setSessionPlatform() must be called before session creation')
  return {
    appRootPath: _platform.appRootPath,
    resourcesPath: _platform.resourcesPath,
    isPackaged: _platform.isPackaged,
  }
}

/**
 * Feature flags for agent behavior
 */
export const AGENT_FLAGS = {
  /** Default modes enabled for new sessions */
  defaultModesEnabled: true,
} as const

export function filterBrowserWindowsForChat(
  windows: BrowserInstanceInfo[],
  scope: { workspaceId: string; projectId: string; sessionId: string },
): BrowserInstanceInfo[] {
  return windows.filter(window => (
    window.workspaceId === scope.workspaceId
    && window.projectId === scope.projectId
    && window.ownerSessionId === scope.sessionId
  ))
}

const MAX_ADMIN_REMEMBER_MINUTES = 60
const MAX_ANNOTATIONS_PER_MESSAGE = 200
const MAX_ANNOTATION_JSON_BYTES = 32 * 1024

// Window during which fs.watch metadata-revert events from our own atomic write
// are ignored, so the watcher does not roll back the in-memory mutation we
// just persisted. See onSessionMetadataChange.
const METADATA_WRITE_GUARD_MS = 5000

/**
 * Text sent to the session when a plan is approved from outside the desktop
 * UI (e.g. Telegram button). Mirrors the English `plan.approved` i18n key
 * used by the desktop flow at `plan-approval-message.ts`. Not localized —
 * the agent reads this, not the end user.
 */
const PLAN_APPROVAL_MESSAGE = 'Plan approved, please execute.'

// validateSpawnAttachmentPath removed — use shared validateFilePath from @craft-agent/server-core/handlers

const PI_TURN_ANCHORS_VERSION = 1
const PI_TURN_ANCHORS_FILE = 'pi-turn-anchors.json'

interface PiTurnAnchorsIndex {
  version: number
  anchors: Record<string, string>
}

function getPiTurnAnchorsPath(sessionPath: string): string {
  return join(sessionPath, 'meta', PI_TURN_ANCHORS_FILE)
}

export async function loadPiTurnAnchors(sessionPath: string): Promise<PiTurnAnchorsIndex> {
  const filePath = getPiTurnAnchorsPath(sessionPath)
  try {
    const raw = await readFile(filePath, 'utf-8')
    const parsed = JSON.parse(raw) as Partial<PiTurnAnchorsIndex>
    const anchors = (parsed.anchors && typeof parsed.anchors === 'object') ? parsed.anchors : {}
    const normalized: Record<string, string> = {}
    for (const [messageId, anchor] of Object.entries(anchors)) {
      if (typeof messageId === 'string' && typeof anchor === 'string' && messageId && anchor) {
        normalized[messageId] = anchor
      }
    }
    return {
      version: PI_TURN_ANCHORS_VERSION,
      anchors: normalized,
    }
  } catch {
    return {
      version: PI_TURN_ANCHORS_VERSION,
      anchors: {},
    }
  }
}

async function getPiTurnAnchor(sessionPath: string, messageId: string): Promise<string | undefined> {
  if (!messageId) return undefined
  const index = await loadPiTurnAnchors(sessionPath)
  return index.anchors[messageId]
}

export async function savePiTurnAnchor(sessionPath: string, messageId: string, anchorId: string): Promise<void> {
  if (!messageId || !anchorId) return

  const index = await loadPiTurnAnchors(sessionPath)
  if (index.anchors[messageId] === anchorId) return

  index.anchors[messageId] = anchorId

  const filePath = getPiTurnAnchorsPath(sessionPath)
  await mkdir(join(sessionPath, 'meta'), { recursive: true })
  await writeFile(filePath, JSON.stringify(index), 'utf-8')
}

/**
 * Copy Pi turn anchors from the source session into the branch session,
 * filtered to the messages actually carried into the branch.
 *
 * Without this, branching a branch is silently lossy: the source branch's
 * sidecar contains no anchors for messages copied from its own parent, so a
 * downstream branch falls back to "full-history fork" — discarding the
 * branch cutoff and producing a session whose visible history doesn't match
 * what the LLM sees. See craft-agents-oss#782.
 */
export async function copyPiTurnAnchorsForBranch(
  sourceSessionPath: string,
  branchSessionPath: string,
  branchedMessageIds: Iterable<string>,
): Promise<void> {
  const index = await loadPiTurnAnchors(sourceSessionPath)
  if (Object.keys(index.anchors).length === 0) return
  const idSet = new Set(branchedMessageIds)
  const filtered: Record<string, string> = {}
  for (const [messageId, anchor] of Object.entries(index.anchors)) {
    if (idSet.has(messageId)) {
      filtered[messageId] = anchor
    }
  }
  if (Object.keys(filtered).length === 0) return
  await mkdir(join(branchSessionPath, 'meta'), { recursive: true })
  await writeFile(
    getPiTurnAnchorsPath(branchSessionPath),
    JSON.stringify({ version: PI_TURN_ANCHORS_VERSION, anchors: filtered }),
    'utf-8',
  )
}

const CLAUDE_TURN_ANCHORS_VERSION = 1
const CLAUDE_TURN_ANCHORS_FILE = 'claude-turn-anchors.json'

interface ClaudeTurnAnchorRecord {
  sdkSessionId: string
  sdkMessageUuid: string
}

interface ClaudeTurnAnchorsIndex {
  version: number
  anchors: Record<string, ClaudeTurnAnchorRecord>
}

function getClaudeTurnAnchorsPath(sessionPath: string): string {
  return join(sessionPath, 'meta', CLAUDE_TURN_ANCHORS_FILE)
}

function isClaudeMessageUuid(turnId: string): boolean {
  return /^msg_[A-Za-z0-9]+$/.test(turnId)
}

async function loadClaudeTurnAnchors(sessionPath: string): Promise<ClaudeTurnAnchorsIndex> {
  const filePath = getClaudeTurnAnchorsPath(sessionPath)
  try {
    const raw = await readFile(filePath, 'utf-8')
    const parsed = JSON.parse(raw) as Partial<ClaudeTurnAnchorsIndex>
    const anchors = (parsed.anchors && typeof parsed.anchors === 'object') ? parsed.anchors : {}
    const normalized: Record<string, ClaudeTurnAnchorRecord> = {}

    for (const [messageId, value] of Object.entries(anchors)) {
      if (!messageId || typeof messageId !== 'string') continue
      if (!value || typeof value !== 'object') continue
      const sdkSessionId = (value as { sdkSessionId?: unknown }).sdkSessionId
      const sdkMessageUuid = (value as { sdkMessageUuid?: unknown }).sdkMessageUuid
      if (typeof sdkSessionId === 'string' && sdkSessionId && typeof sdkMessageUuid === 'string' && sdkMessageUuid) {
        normalized[messageId] = { sdkSessionId, sdkMessageUuid }
      }
    }

    return {
      version: CLAUDE_TURN_ANCHORS_VERSION,
      anchors: normalized,
    }
  } catch {
    return {
      version: CLAUDE_TURN_ANCHORS_VERSION,
      anchors: {},
    }
  }
}

async function getClaudeTurnAnchor(sessionPath: string, messageId: string): Promise<ClaudeTurnAnchorRecord | undefined> {
  if (!messageId) return undefined
  const index = await loadClaudeTurnAnchors(sessionPath)
  return index.anchors[messageId]
}

async function saveClaudeTurnAnchor(
  sessionPath: string,
  messageId: string,
  sdkSessionId: string,
  sdkMessageUuid: string,
): Promise<void> {
  if (!messageId || !sdkSessionId || !sdkMessageUuid) return

  const index = await loadClaudeTurnAnchors(sessionPath)
  const previous = index.anchors[messageId]
  if (previous && previous.sdkSessionId === sdkSessionId && previous.sdkMessageUuid === sdkMessageUuid) return

  index.anchors[messageId] = {
    sdkSessionId,
    sdkMessageUuid,
  }

  const filePath = getClaudeTurnAnchorsPath(sessionPath)
  await mkdir(join(sessionPath, 'meta'), { recursive: true })
  await writeFile(filePath, JSON.stringify(index), 'utf-8')
}

/**
 * Build MCP and API servers from sources using the new unified modules.
 * Handles credential loading and server building in one step.
 * When auth errors occur, updates source configs to reflect actual state.
 *
 * @param sources - Sources to build servers for
 * @param sessionPath - Optional path to session folder for saving large API responses
 * @param tokenRefreshManager - Optional TokenRefreshManager for OAuth token refresh
 */
/**
 * Session-flavored wrapper around the shared builder: keeps the ~7 existing
 * call sites unchanged while routing logs through sessionLog. The
 * implementation lives in ../sources/build-servers.ts so the pages action
 * executor uses the exact same credential path.
 */
async function buildServersFromSources(
  sources: LoadedSource[],
  sessionPath?: string,
  tokenRefreshManager?: TokenRefreshManager,
  summarize?: SummarizeCallback
) {
  return buildServersFromSourcesShared(sources, sessionPath, tokenRefreshManager, summarize, sessionLog)
}

/**
 * Result of expired-credential refresh.
 */
interface RefreshExpiredCredentialsResult {
  /** Number of sources whose tokens were successfully refreshed */
  refreshedCount: number
  /** Sources that failed to refresh (for warning display) */
  failedSources: Array<{ slug: string; reason: string }>
}

/**
 * Refresh expired OAuth / renew-endpoint tokens for the given sources.
 *
 * Side effects (carried by `TokenRefreshManager.ensureFreshToken`):
 * - Success: source.config.isAuthenticated = true (in-memory + on disk).
 * - Failure: source.config.isAuthenticated = false + connectionStatus = 'needs_auth'
 *   (in-memory + on disk), so isSourceUsable() returns false and the source is
 *   excluded from intendedSlugs by callers.
 *
 * The caller is responsible for building servers AFTER this returns — that way
 * a single fresh build sees the correct credentials and the correct usable set.
 * Issue #710.
 */
async function refreshExpiredCredentials(
  sources: LoadedSource[],
  tokenRefreshManager: TokenRefreshManager
): Promise<RefreshExpiredCredentialsResult> {
  sessionLog.debug('[OAuth] Checking if any tokens need refresh')

  const needRefresh = await tokenRefreshManager.getSourcesNeedingRefresh(sources)
  if (needRefresh.length === 0) {
    return { refreshedCount: 0, failedSources: [] }
  }

  sessionLog.debug(`[OAuth] Refreshing ${needRefresh.length} source(s): ${needRefresh.map(s => s.config.slug).join(', ')}`)

  const { refreshed, failed } = await tokenRefreshManager.refreshSources(needRefresh)

  const failedSources = failed.map(({ source, reason }) => ({
    slug: source.config.slug,
    reason,
  }))

  return { refreshedCount: refreshed.length, failedSources }
}

/**
 * Resolve tool display metadata for a tool call.
 * Returns metadata with base64-encoded icon for viewer compatibility.
 *
 * @param toolName - Tool name from the event (e.g., "Skill", "mcp__linear__list_issues")
 * @param toolInput - Tool input (used for Skill tool to get skill identifier)
 * @param workspaceRootPath - Path to workspace for loading skills/sources
 * @param sources - Loaded sources for the workspace
 */
const BROWSER_TOOL_ICON_FILENAME = 'chrome.svg'
let browserToolIconDataUrlCache: string | null | undefined

async function getBrowserToolIconDataUrl(): Promise<string | undefined> {
  // Cache miss sentinel: undefined means "not computed yet"
  if (browserToolIconDataUrlCache !== undefined) {
    return browserToolIconDataUrlCache ?? undefined
  }

  try {
    const iconCandidates = [
      join(getToolIconsDir(), BROWSER_TOOL_ICON_FILENAME),
      // Dev fallback (before sync to ~/.craft-agent/tool-icons)
      join(process.cwd(), 'apps', 'electron', 'resources', 'tool-icons', BROWSER_TOOL_ICON_FILENAME),
      // Packaged fallback (app resources)
      join(process.resourcesPath, 'tool-icons', BROWSER_TOOL_ICON_FILENAME),
    ]

    for (const iconPath of iconCandidates) {
      if (!existsSync(iconPath)) continue
      const encoded = await encodeIconToDataUrlAsync(iconPath, { resize: resizeIconBuffer })
      if (encoded) {
        browserToolIconDataUrlCache = encoded
        return encoded
      }
    }

    browserToolIconDataUrlCache = null
  } catch {
    browserToolIconDataUrlCache = null
  }

  return browserToolIconDataUrlCache ?? undefined
}

async function resolveToolDisplayMeta(
  toolName: string,
  toolInput: Record<string, unknown> | undefined,
  workspaceRootPath: string,
  sources: LoadedSource[]
): Promise<ToolDisplayMeta | undefined> {
  // Check if it's an MCP tool (format: mcp__<serverSlug>__<toolName>)
  if (toolName.startsWith('mcp__')) {
    const parts = toolName.split('__')
    if (parts.length >= 3) {
      const serverSlug = parts[1]
      const toolSlug = parts.slice(2).join('__')

      // Internal MCP server tools (session)
      const internalMcpServers: Record<string, Record<string, string>> = {
        'session': {
          'SubmitPlan': 'Submit Plan',
          'call_llm': 'LLM Query',
          'config_validate': 'Validate Config',
          'skill_validate': 'Validate Skill',
          'mermaid_validate': 'Validate Mermaid',
          'source_test': 'Test Source',
          'source_oauth_trigger': 'OAuth',
          'source_google_oauth_trigger': 'Google Auth',
          'source_slack_oauth_trigger': 'Slack Auth',
          'source_microsoft_oauth_trigger': 'Microsoft Auth',
          'source_credential_prompt': 'Enter Credentials',
          'transform_data': 'Transform Data',
          'render_template': 'Render Template',
          'update_user_preferences': 'Update Preferences',
          'send_developer_feedback': 'Send Feedback',
          'browser_tool': 'Browser',
        },
      }

      const internalServer = internalMcpServers[serverSlug]
      if (internalServer) {
        const displayName = internalServer[toolSlug]
        if (displayName) {
          const normalizedBrowserTool = normalizeBrowserToolName(toolSlug)
          return {
            displayName,
            iconDataUrl: normalizedBrowserTool ? await getBrowserToolIconDataUrl() : undefined,
            category: 'native' as const,
          }
        }
      }

      // External source tools
      let sourceSlug = serverSlug

      // Special case: api-bridge server embeds source slug in tool name as "api_{slug}"
      // e.g., mcp__api-bridge__api_stripe → sourceSlug = "stripe"
      if (sourceSlug === 'api-bridge' && toolSlug.startsWith('api_')) {
        sourceSlug = toolSlug.slice(4)
      }

      const source = sources.find(s => s.config.slug === sourceSlug)
      if (source) {
        // Try file-based icon first, fall back to emoji icon from config
        const iconDataUrl = source.iconPath
          ? await encodeIconToDataUrlAsync(source.iconPath, { resize: resizeIconBuffer })
          : getEmojiIcon(source.config.icon)
        return {
          displayName: source.config.name,
          iconDataUrl,
          description: source.config.tagline,
          category: 'source' as const,
        }
      }
    }
    return undefined
  }

  // Check if it's the Skill tool
  if (toolName === 'Skill' && toolInput) {
    // Skill input has 'skill' param with format: "skillSlug" or "workspaceId:skillSlug"
    const skillParam = toolInput.skill as string | undefined
    if (skillParam) {
      // Extract skill slug (remove workspace prefix if present)
      const skillSlug = skillParam.includes(':') ? skillParam.split(':').pop() : skillParam
      if (skillSlug) {
        // Load skills and find the one being invoked
        try {
          const skills = loadAllSkills(workspaceRootPath)
          const skill = skills.find(s => s.slug === skillSlug)
          if (skill) {
            // Try file-based icon first, fall back to emoji icon from metadata
            const iconDataUrl = skill.iconPath
              ? await encodeIconToDataUrlAsync(skill.iconPath, { resize: resizeIconBuffer })
              : getEmojiIcon(skill.metadata.icon)
            return {
              displayName: skill.metadata.name,
              iconDataUrl,
              description: skill.metadata.description,
              category: 'skill' as const,
            }
          }
        } catch {
          // Skills loading failed, skip
        }
      }
    }
    return undefined
  }

  // CLI tool icon resolution for Bash commands
  // Parses the command string to detect known tools (git, npm, docker, etc.)
  // and resolves their brand icon from ~/.craft-agent/tool-icons/
  if (toolName === 'Bash' && toolInput?.command) {
    try {
      const toolIconsDir = getToolIconsDir()
      const match = resolveToolIcon(String(toolInput.command), toolIconsDir)
      if (match) {
        return {
          displayName: match.displayName,
          iconDataUrl: match.iconDataUrl,
          category: 'native' as const,
        }
      }
    } catch {
      // Icon resolution is best-effort — never crash the session for it
    }
  }

  // Native browser tool names (with Chrome icon)
  const normalizedBrowserToolName = normalizeBrowserToolName(toolName)
  if (normalizedBrowserToolName) {
    const browserDisplayName = normalizedBrowserToolName
      .split('_')
      .map((part, index) => (index === 0 ? part : part.charAt(0).toUpperCase() + part.slice(1)))
      .join(' ')
      .replace(/^browser\s+/i, 'Browser ')

    return {
      displayName: browserDisplayName,
      iconDataUrl: await getBrowserToolIconDataUrl(),
      category: 'native' as const,
    }
  }

  // Native tool display names (no icons - UI handles these with built-in icons)
  // This ensures toolDisplayMeta is always populated for consistent display
  const nativeToolNames: Record<string, string> = {
    'Read': 'Read',
    'Write': 'Write',
    'Edit': 'Edit',
    'Bash': 'Terminal',
    'Grep': 'Search',
    'Glob': 'Find Files',
    'Task': 'Agent',
    'Agent': 'Agent',
    'WebFetch': 'Fetch URL',
    'WebSearch': 'Web Search',
    'TodoWrite': 'Update Todos',
    'NotebookEdit': 'Edit Notebook',
    'KillShell': 'Kill Shell',
    'TaskOutput': 'Task Output',
  }

  const nativeDisplayName = nativeToolNames[toolName]
  if (nativeDisplayName) {
    return {
      displayName: nativeDisplayName,
      category: 'native' as const,
    }
  }

  // Unknown tool - no display metadata (will fall back to tool name in UI)
  return undefined
}

/** Agent type - unified backend interface for all providers */
type AgentInstance = AgentBackend

/**
 * Status of a background task in the main-process registry.
 * - `running`   — backgrounded and no terminal notification seen yet.
 * - `completed`/`failed`/`stopped` — a real SDK task_notification arrived.
 * - `orphaned`  — the turn that owned the task ended before a terminal
 *   notification arrived. With the (default) per-turn subprocess model the task
 *   almost certainly died with the subprocess, so reporting it as still
 *   "running" would be a lie. Once WS2 keep-alive is enabled these are no longer
 *   produced because the query outlives the turn.
 */
type BackgroundTaskStatus = 'running' | 'completed' | 'failed' | 'stopped' | 'orphaned'

/** A background task tracked from launch, for cross-subprocess status queries. */
interface RunningBackgroundTask {
  taskId: string
  toolUseId?: string
  intent?: string
  /** ms timestamp when the task was backgrounded */
  startTime: number
  /** ms timestamp of the last task_progress notification, if any */
  lastProgressAt?: number
  /** elapsed seconds from the most recent progress notification, if any */
  elapsedSeconds?: number
  status: BackgroundTaskStatus
  /** ms timestamp when the task reached a terminal/orphaned status */
  completedAt?: number
  /** turn that launched the task (used to orphan on that turn's completion) */
  turnId?: string
  /** Workflow run id (wf_...) — set when this task is a Workflow launch. */
  workflowId?: string
  /** Count of workflow sub-agents completed so far (Workflow tasks only). */
  agentsCompleted?: number
  /** What the session's agent launched: a background agent, a Workflow, a Bash command, or another task (Monitor, MCP...). */
  kind?: 'agent' | 'workflow' | 'shell' | 'task'
  /**
   * A completion for a task this session's agent did not launch (typically a subagent's own
   * background task). Its start time is unknown, and it never wakes the session.
   */
  untracked?: boolean
  /** The session's own task, but its launch was not seen: the start time is unknown. */
  startUnknown?: boolean
  /** The user stopped it from its chip: its `stopped` completion is expected, so it wakes nothing. */
  stopRequestedAt?: number
}

interface ManagedSession {
  id: string
  creationRequestId?: string
  workspace: Workspace
  agent: AgentInstance | null  // Lazy-loaded - null until first message
  messages: Message[]
  isProcessing: boolean
  /** Set when user requests stop - allows event loop to drain before clearing isProcessing */
  stopRequested?: boolean
  lastMessageAt: number
  streamingText: string
  /** Identity of the unfinished assistant text, used for retry discard boundaries. */
  streamingTurnId?: string
  // Incremented each time a new message starts processing.
  // Used to detect if a follow-up message has superseded the current one (stale-request guard).
  processingGeneration: number
  // NOTE: Parent-child tracking state (pendingTools, parentToolStack, toolToParentMap,
  // pendingTextParent) has been removed. CraftAgent now provides parentToolUseId
  // directly on all events using the SDK's authoritative parent_tool_use_id field.
  // See: packages/shared/src/agent/tool-matching.ts
  // Session name (user-defined or AI-generated)
  name?: string
  /** Last title the app set (initial or AI); a different `name` means the user or an external edit renamed it. */
  autoTitle?: string
  /** Smart titles: the first message was small talk, so the next request gets the title. */
  titleDeferred?: boolean
  /** Smart titles: user-message count at the last drift check. */
  titleCheckedAtUserCount?: number
  isFlagged: boolean
  /** Whether this session is archived */
  isArchived?: boolean
  /** Timestamp when session was archived (for retention policy) */
  archivedAt?: number
  /** Permission mode for this session ('safe', 'ask', 'guarded', 'allow-all') */
  permissionMode?: PermissionMode
  /** Previous permission mode (preserved across restarts for session_state modeTransition context) */
  previousPermissionMode?: PermissionMode
  /** Centralized MCP client pool for this session's source connections */
  mcpPool?: McpClientPool
  /** HTTP MCP server exposing pool tools to external SDK subprocesses */
  poolServer?: McpPoolServer
  // SDK session ID for conversation continuity
  sdkSessionId?: string
  /** Accept & Compact state; persisted with the session header. */
  pendingPlanExecution?: StoredSession['pendingPlanExecution']
  cancelledInputIds?: string[]
  restoredInputIds?: Record<string, string>
  // Token usage for display
  tokenUsage?: {
    inputTokens: number
    outputTokens: number
    totalTokens: number
    contextTokens: number
    costUsd: number
    cacheReadTokens?: number
    cacheCreationTokens?: number
    /** Model's context window size in tokens (from SDK modelUsage) */
    contextWindow?: number
    /** Current occupancy, separate from cumulative/billable counters. */
    contextUsage?: ContextUsageSnapshot
    /** Backend running totals already counted into costUsd/outputTokens (see `addTurnUsage`). */
    lastRunningTotals?: { costUsd: number; outputTokens: number }
  }
  // Session status (user-controlled) - determines open vs closed
  // Dynamic status ID referencing workspace status config
  sessionStatus?: string
  // Read/unread tracking - ID of last message user has read
  lastReadMessageId?: string
  /**
   * Explicit unread flag - single source of truth for NEW badge.
   * Set to true when assistant message completes while user is NOT viewing.
   * Set to false when user views the session (and not processing).
   */
  hasUnread?: boolean
  // Per-session source selection (slugs of enabled sources)
  enabledSourceSlugs?: string[]
  // Labels applied to this session (additive tags, many-per-session)
  labels?: string[]
  // Immutable workspace-scoped Project ownership.
  projectId: string
  // Session-scoped Add Note target metadata.
  projectNoteTargetPath?: string
  projectNoteRecentTargetPaths?: string[]
  // Parent session id — when set, this session is a subtask of the parent (undefined = top-level task)
  parentSessionId?: string
  // Kanban board column id ('todo' | 'in-progress' | 'done'); independent of sessionStatus
  kanbanColumn?: string
  // Tasks Conductor: slug of the task spec this session belongs to (orchestrator + child nodes)
  taskSlug?: string
  // Tasks Conductor: id of the run that spawned this child session (child nodes only)
  taskRunId?: string
  // Tasks Conductor: id of the DAG node this child session executes (child nodes only)
  taskNodeId?: string
  // Tasks Conductor: total DAG node count (orchestrator only) — stable board progress denominator
  taskNodeCount?: number
  // Tasks Conductor: hidden generate-time orchestrator awaiting validated adoption (off the board)
  taskDraft?: boolean
  // Working directory for this session (used by agent for bash commands)
  workingDirectory?: string
  // SDK cwd for session storage - set once at creation, never changes.
  // Ensures SDK can find session transcripts regardless of workingDirectory changes.
  sdkCwd?: string
  // Shared viewer URL (if shared via viewer)
  sharedUrl?: string
  // Shared session ID in viewer (for revoke)
  sharedId?: string
  // Model to use for this session (overrides global config if set)
  model?: string
  // LLM connection slug for this session (locked after first message)
  llmConnection?: string
  // Whether the connection is locked (cannot be changed after first agent creation)
  connectionLocked?: boolean
  // Thinking level for this session ('off', 'think', 'max')
  thinkingLevel?: ThinkingLevel
  // Coding mode: lean coding prompt + session-tool profile (fixed once the session has messages)
  codingMode?: boolean
  // Coding mode: PRs pinned to this session (chat-header PR carousel; see pr_bind / pr_unbind)
  boundPrs?: BoundPr[]
  // Coding mode: per-PR monitor state (auto-fix toggle + what it last acted on), keyed by PR id
  prMonitors?: Record<string, PrMonitorState>
  // System prompt preset for mini agents ('default' | 'mini')
  systemPromptPreset?: 'default' | 'mini' | string
  // Role/type of the last message (for badge display without loading messages)
  lastMessageRole?: 'user' | 'assistant' | 'plan' | 'tool' | 'error'
  // ID of the last final (non-intermediate) assistant message - pre-computed for unread detection
  lastFinalMessageId?: string
  // Turn baseline: last final assistant message ID at turn start (runtime-only, not persisted)
  turnStartFinalMessageId?: string
  // External session metadata updates seen while processing (applied after turn stop)
  pendingExternalMetadata?: SessionHeader
  // Guard: suppress external metadata revert after programmatic writes (setSessionStatus/setSessionLabels).
  // fs.watch fires during atomic write (unlink+rename) and can read stale data, reverting in-memory state.
  _metadataWriteGuardUntil?: number
  // Whether an async operation is ongoing (sharing, updating share, revoking, title regeneration)
  // Used for shimmer effect on session title
  isAsyncOperationOngoing?: boolean
  // Preview of first user message (for sidebar display fallback)
  preview?: string
  // When the session was first created (ms timestamp from JSONL header)
  createdAt?: number
  // Total message count (pre-computed in JSONL header for fast list loading)
  messageCount?: number
  // Message queue for handling new messages while processing
  // When a message arrives during processing, we interrupt and queue
  messageQueue: Array<{
    message: string
    attachments?: FileAttachment[]
    storedAttachments?: StoredAttachment[]
    options?: SendMessageOptions
    messageId?: string  // Pre-generated ID for matching with UI
    optimisticMessageId?: string  // Frontend's ID for reliable event matching
    /**
     * Mid-turn messages: replay together with this earlier entry (same request). A reference, not
     * a flag, so an entry spliced in between (a recovered steer) never gets merged by position.
     */
    mergeWith?: object
    /** Mid-turn messages: the pending continuation check that may set `mergeWith`. */
    continuationCheck?: Promise<void>
  }>
  // Original host payloads for backends that can return undelivered text steers.
  // Runtime-only; Pi retains these until a consumption receipt or cancellation snapshot.
  acceptedSteers?: Map<string, ManagedSession['messageQueue'][number]>
  // Map of taskId -> output info for background task results
  backgroundTaskOutputs: Map<string, { outputFile: string; summary: string; status: string; completedAt: number }>
  // Registry of background tasks (running + recently-terminal) for this session.
  // Unlike backgroundTaskOutputs (which only stores COMPLETED tasks for output
  // retrieval), this tracks tasks from the moment they are backgrounded, so a
  // cross-subprocess "status?" query can enumerate what is actually live. The
  // SDK's in-subprocess task tools cannot answer this: their state dies with the
  // subprocess at turn end, so this main-process registry is the real source of
  // truth for background-task status. See RunningBackgroundTask.
  backgroundTaskRegistry: Map<string, RunningBackgroundTask>
  // Whether messages have been loaded from disk (for lazy loading)
  messagesLoaded: boolean
  // Pending auth request tracking (for unified auth flow)
  pendingAuthRequestId?: string
  pendingAuthRequest?: AuthRequest
  pendingAuthOwner?: { generation: number; stopEpoch: number }
  // Serialize admission, never the long-running agent iterator or Stop itself.
  sendAdmissionTail?: Promise<void>
  pendingSendAdmissions?: Map<() => void, string | undefined>
  /** Resolves after the initial write or rollback, never after the provider turn. */
  pendingInputCommits?: Map<string, Promise<void>>
  stopBarrier?: Promise<void>
  // Auth retry tracking (for mid-session token expiry)
  // Store last sent message/attachments to enable retry after token refresh
  lastSentMessage?: string
  // IDs of the user bubbles the last send stands for (several for a merged replay);
  // auth retries preserve these identities when resending.
  lastSentMessageIds?: string[]
  // Merged replays in flight: first entry's message ID → IDs of every bubble it replays.
  replayMergedIds?: Map<string, string[]>
  // Scheduled replay owns the full payload until turn admission. An approval
  // keeps it until producer acknowledgement; Stop recovers the plan separately.
  pendingQueueReplay?: { entries: ManagedSession['messageQueue']; stopEpoch: number; processingGeneration?: number }
  lastSentAttachments?: FileAttachment[]
  lastSentStoredAttachments?: StoredAttachment[]
  lastSentOptions?: SendMessageOptions
  // Flag to prevent infinite retry loops (reset at start of each sendMessage)
  authRetryAttempted?: boolean
  // Flag indicating auth retry is in progress (to prevent complete handler from interfering)
  authRetryInProgress?: boolean
  // Whether this session is hidden from session list (e.g., mini edit sessions)
  hidden?: boolean
  // Nobody answers prompts here (CLI runs); in memory only. See isAttendedSession.
  unattended?: boolean
  // Incremented by every Stop (cancelProcessing). A turn captures it when it starts: a risk-badge
  // prompt or a turn start that sees it change was stopped meanwhile.
  stopEpoch?: number
  branchFromMessageId?: string
  // Branch context strategy:
  // - sdk-fork: provider-level fork from parent SDK session
  // - seeded-fresh-session: fresh backend session seeded with transcript up to branch cutoff
  branchContextStrategy?: 'sdk-fork' | 'seeded-fresh-session'
  // Parent session's SDK session ID (used only when branchContextStrategy === 'sdk-fork')
  branchFromSdkSessionId?: string
  // Parent session's storage path (used only when branchContextStrategy === 'sdk-fork')
  branchFromSessionPath?: string
  // Parent session's sdkCwd — needed so the fork subprocess uses the correct
  // ~/.claude/projects/{cwd-hash}/ directory to find the parent's session file.
  branchFromSdkCwd?: string
  // SDK assistant message UUID at the branch point — used as resumeSessionAt
  // to trim the forked conversation at the branch point.
  branchFromSdkTurnId?: string
  // One-shot flag for seeded branch mode - set true after first turn seed injection.
  branchSeedApplied?: boolean
  // One-shot hidden summary injected on the first turn after a remote transfer.
  transferredSessionSummary?: string
  // Whether the transferred-session summary has already been injected.
  transferredSessionSummaryApplied?: boolean
  // Continued from another session: its summary is still being generated (continueSessionInNewSession).
  // The first turn waits for it, at most HANDOFF_SUMMARY_WAIT_MS. Not persisted.
  pendingHandoffSummary?: Promise<void>
  // Token refresh manager for OAuth token refresh with rate limiting
  tokenRefreshManager: TokenRefreshManager
  // Metadata for sessions created by automations
  triggeredBy?: { automationName?: string; automationId?: string; event?: string; timestamp?: number; depth?: number }
  // Promise that resolves when the agent instance is ready (for title gen to await)
  agentReady?: Promise<void>
  agentReadyResolve?: () => void
  // Per-session env overrides for SDK subprocess (e.g., ANTHROPIC_BASE_URL).
  // Stored on managed session so it persists across agent recreations (auth-retry, etc.)
  envOverrides?: Record<string, string>
  // Runtime-affecting backend config signature captured when the live agent was created/refreshed.
  backendRuntimeSignature?: string
  // Capability/model snapshot belonging to the live runtime, not a later SAVE.
  backendRuntimeContext?: ReturnType<typeof resolveBackendContext>
  // Retire draft receipts only after the accepted handoff's cleared file is durable.
  pendingPlanReceiptRetirements?: Set<string>
  /**
   * Signature over fields that cannot be propagated via `update_runtime_config`
   * (see `runtime-config.ts:buildRestartRequiredSignature`). When this drifts,
   * the agent must be disposed + recreated rather than refreshed in place.
   */
  backendRestartSignature?: string
  // Whether the previous turn was interrupted (for context injection on next message).
  // Ephemeral — not persisted to disk. Cleared after one-shot injection.
  wasInterrupted?: boolean
  /**
   * Runtime-only: Pi SDK message id → Craft assistant message id.
   * Populated when a `text_complete` arrives carrying `sdkMessageId`, and read
   * when the follow-up `pi_turn_anchor` event arrives (deferred by one microtask
   * so the SDK's session-manager has updated its leaf — see craft-agents-oss#782).
   * Capped at PI_SDK_MESSAGE_ID_CACHE_LIMIT to bound memory in long sessions.
   */
  piSdkMessageToCraftMessage?: Map<string, string>
  // Source-activation auto-retry (craft-agents-oss#804). When a source activates
  // mid-turn, we re-send the original message with a "[<slug> activated]" suffix
  // after a short delay. The pending slot lets `sendMessage` dedup a duplicate
  // RPC from a legacy renderer that still ships the client-side auto_retry.
  autoRetryTimer?: ReturnType<typeof setTimeout>
  autoRetryPending?: {
    content: string
    /** The steer-carrying text the server's own retry sends (differs from `content` when steers were accepted). */
    retryContent?: string
    deadlineMs: number
    /** Persisted references from the interrupted user turn. */
    references?: Reference[]
    attachments?: FileAttachment[]
    storedAttachments?: StoredAttachment[]
    /** True after the first matching sendMessage consumes the slot; later matches drop. */
    committed: boolean
    /** Turn generation the continuation was scheduled for: ownership check for undelivered steers and cancellation. */
    scheduledGeneration?: number
    originalContent?: string
    sourceSlug?: string
    /** Full host payloads held for the continuation, recoverable until producer acknowledgement. */
    ownedSteers?: ManagedSession['messageQueue']
    deliveryMessageId?: string
  }
  /**
   * Exact content of the server's own auto-retry, set just before it calls sendMessage so the
   * retry is recognised: it runs hidden (the user already sees their message and the activation)
   * and triggers no per-message decision points.
   */
  pendingActivationResend?: string
  /** Messages steered into the running turn; an auto-retry carries them after the original request. */
  turnSteers?: string[]
  /** Thinking level adaptive thinking chose for the current request; an auto-retry keeps it. */
  turnThinkingOverride?: ThinkingLevel | null
  /**
   * The current request began with a message the user sent, not an app-generated hidden one (a
   * background-task wake-up). Source-activation and auth retries keep it.
   */
  turnFromUser?: boolean
  /** Suggestion hint sent with the current request; an auth retry sends it again. */
  turnSuggestionHint?: string | null
  /** Adaptive thinking's answer for the last user turn, for the next turn's `corrected`/`accepted` follow-up. */
  thinkingTrace?: DecisionResult
  /** Suggestions answer for the current request and the candidates it used, for the follow-up line. */
  suggestionTrace?: { trace: SuggestionTrace; used: Set<string> }
}

export function getSessionInSameProject<
  T extends { id: string; projectId: string; workspace: { id: string } },
>(
  sessions: ReadonlyMap<string, T>,
  caller: T,
  targetId: string,
): T {
  const target = sessions.get(targetId)
  if (!target) {
    throw new Error(`SESSION_NOT_FOUND: ${targetId}`)
  }
  if (target.workspace.id !== caller.workspace.id || target.projectId !== caller.projectId) {
    throw new Error(`CROSS_PROJECT_SESSION: ${targetId} is outside Project ${caller.projectId}`)
  }
  return target
}

const PI_SDK_MESSAGE_ID_CACHE_LIMIT = 256

export interface AutoRetryPendingHost {
  autoRetryPending?: {
    /** Legacy dedupe key: plain original + `[<slug> activated]` (what a v0.9.x renderer's own retry sends). */
    content: string
    /** The server's actual send when steers were accepted into the turn. */
    retryContent?: string
    deadlineMs: number
    references?: Reference[]
    committed: boolean
    /** Turn generation the continuation was scheduled for: ownership check for undelivered steers and cancellation. */
    scheduledGeneration?: number
    originalContent?: string
    sourceSlug?: string
    ownedSteers?: ManagedSession['messageQueue']
    deliveryMessageId?: string
  }
}

export function claimAutoRetryPending(
  host: AutoRetryPendingHost,
  message: string,
  nowMs = Date.now(),
): 'send' | 'drop' {
  const pending = host.autoRetryPending
  if (pending && (message === pending.content || message === pending.retryContent)) {
    if (nowMs < pending.deadlineMs) {
      if (pending.committed) return 'drop'
      pending.committed = true
      return 'send'
    }
    host.autoRetryPending = undefined
    return 'send'
  }

  if (pending && nowMs >= pending.deadlineMs) {
    host.autoRetryPending = undefined
  }

  return 'send'
}

/**
 * Remove trailing `[<slug> activated]` markers that earlier activation retries of
 * the same turn appended (`buildActivationRetryMessage`). The marker format is
 * owned by this module, so chained activations re-send the user's own request
 * with only the newest suffix instead of stacking markers.
 */
export function stripActivationRetrySuffixes(text: string): string {
  let current = text
  for (let i = 0; i < 8; i++) {
    const stripped = current.replace(/\n\n\[[^\]\n]{1,80} activated\]$/, '')
    if (stripped === current) break
    current = stripped
  }
  return current
}

/**
 * The interrupted turn's structured references, resolved from the turn identity
 * the SM itself recorded when it started the send: the union of the references
 * persisted on the turn's user messages (`lastSentMessageIds` — merged
 * continuation turns contribute several ids), falling back to the options
 * captured at send time. Identity-scoped on purpose: a continuation must never
 * pick references out of unrelated history.
 */
export function activationTurnReferences(
  messages: Message[],
  turnMessageIds: string[] | undefined,
  sendOptions: SendMessageOptions | undefined,
): Reference[] | undefined {
  const references: Reference[] = []
  const seen = new Set<string>()
  if (turnMessageIds?.length) {
    const ids = new Set(turnMessageIds)
    for (const message of messages) {
      if (message.role !== 'user' || !ids.has(message.id)) continue
      for (const reference of message.references ?? []) {
        const key = JSON.stringify(reference)
        if (!seen.has(key)) {
          seen.add(key)
          references.push(reference)
        }
      }
    }
    if (references.length) return references
  }
  return sendOptions?.references?.length ? sendOptions.references : undefined
}

/**
 * The source-activation auto-retry. `plain` is the original request plus the `[<slug> activated]`
 * suffix (also what a legacy renderer's own retry sends, so it is the dedupe key). `retry` is what
 * the server sends: corrections steered into the turn follow the original request, so the latest
 * instruction the model reads is the corrected one, not the request it replaced.
 * An empty original (references-only turn) sends the bare suffix: empty visible
 * text with live citations is a valid continuation.
 */
export function buildActivationRetryMessage(original: string, steers: readonly string[], sourceSlug: string): { plain: string; retry: string } {
  const suffix = `[${sourceSlug} activated]`
  const base = original.trim() ? original : ''
  const plain = base ? `${base}\n\n${suffix}` : suffix
  const kept = steers.filter(text => text.trim())
  return { plain, retry: kept.length > 0 ? (base ? `${base}\n\n${kept.join('\n\n')}\n\n${suffix}` : `${kept.join('\n\n')}\n\n${suffix}`) : plain }
}

/** Longest chain of automation-created sessions that may trigger further automations (loop guard). */
export const MAX_AUTOMATION_CHAIN_DEPTH = 3

/**
 * Whether someone can answer a prompt in this session: not an automation, task-run, hidden, mini
 * or unattended session. `unattended` marks `craft run` sessions and is inherited by sessions an
 * unattended session spawns (not by subtasks a user adds under it).
 */
export function isAttendedSession(managed: ManagedSession): boolean {
  return !(managed.triggeredBy || managed.taskRunId || managed.taskSlug || managed.hidden || managed.unattended
    || managed.systemPromptPreset === 'mini')
}

/**
 * Whether the session's conversation has started. The agent's system prompt and tool set are fixed
 * from then on (Claude pins the prompt per SDK session; the keep-alive query fixes its tools), so
 * per-session settings that shape them, like coding mode, can only change before this.
 */
export function hasConversationStarted(managed: Pick<ManagedSession, 'sdkSessionId' | 'messageCount' | 'messages'>): boolean {
  return !!managed.sdkSessionId
    || (managed.messageCount ?? 0) > 0
    || managed.messages.some(m => m.role === 'user')
}

/**
 * Create a ManagedSession from any session-like source (SessionMetadata, SessionConfig, StoredSession).
 * Spreads all matching fields from the source so new persistent fields automatically propagate.
 * Runtime-only fields get sensible defaults.
 */
export function createManagedSession(
  source: { id: string } & Partial<ManagedSession>,
  workspace: Workspace,
  overrides?: Partial<ManagedSession>,
): ManagedSession {
  const projectId = overrides?.projectId ?? source.projectId
  if (typeof projectId !== 'string' || !projectId.trim()) {
    throw new Error(`Session ${source.id} is missing projectId`)
  }

  const s = source as Record<string, unknown>
  const sourceFields = Object.fromEntries(
    Object.entries(s).filter(([, v]) => v !== undefined)
  ) as Partial<ManagedSession>

  if ('thinkingLevel' in sourceFields) {
    // TODO: Remove legacy 'think' normalization after old persisted session
    // headers have realistically aged out across upgrades.
    const normalizedThinkingLevel = normalizeThinkingLevel(sourceFields.thinkingLevel)
    if (normalizedThinkingLevel) {
      sourceFields.thinkingLevel = normalizedThinkingLevel
    } else {
      delete sourceFields.thinkingLevel
    }
  }

  const managed = {
    // Spread all session-like fields from source (id, name, permissionMode, labels, model, etc.)
    // This ensures new persistent fields automatically flow through without manual copying.
    ...sourceFields,
    // Runtime-only defaults (not persisted)
    workspace,
    agent: null,
    messages: [],
    isProcessing: false,
    lastMessageAt: (s.lastMessageAt ?? s.lastUsedAt ?? Date.now()) as number,
    streamingText: '',
    processingGeneration: 0,
    isFlagged: (s.isFlagged ?? false) as boolean,
    messageQueue: [],
    backgroundTaskOutputs: new Map(),
    backgroundTaskRegistry: new Map(),
    messagesLoaded: false,
    tokenRefreshManager: new TokenRefreshManager(getSourceCredentialManager(), {
      log: (msg) => sessionLog.debug(msg),
    }),
    // Caller overrides (permissionMode defaults, thinkingLevel, messagesLoaded, etc.)
    ...overrides,
    projectId,
  } as ManagedSession

  if (managed.branchFromMessageId && !managed.branchContextStrategy) {
    managed.branchContextStrategy = managed.branchFromSdkSessionId
      ? 'sdk-fork'
      : 'seeded-fresh-session'
  }

  if (managed.branchContextStrategy === 'seeded-fresh-session' && managed.branchSeedApplied === undefined) {
    // If an SDK session ID already exists, first turn has already happened.
    managed.branchSeedApplied = !!managed.sdkSessionId
  }

  return managed
}

/**
 * Resolve supportsBranching for a managed session.
 * Prefers the live agent instance; falls back to true for all backends.
 */
function resolveSupportsBranching(managed: ManagedSession): boolean {
  // If agent is live, use its instance property (authoritative)
  if (managed.agent) {
    return managed.agent.supportsBranching
  }

  return true // default: branching enabled for all backends
}

const DEFAULT_TOKEN_USAGE = {
  inputTokens: 0, outputTokens: 0, totalTokens: 0,
  contextTokens: 0, costUsd: 0,
}

/** Two bound PRs are the same pin when their host/owner/repo/number match (case-insensitive). */
function sameBoundPr(
  a: { host: string; owner: string; repo: string; number: number },
  b: { host: string; owner: string; repo: string; number: number },
): boolean {
  return a.number === b.number
    && a.host.toLowerCase() === b.host.toLowerCase()
    && a.owner.toLowerCase() === b.owner.toLowerCase()
    && a.repo.toLowerCase() === b.repo.toLowerCase()
}

/**
 * Convert a ManagedSession to a renderer-side Session object.
 * Uses pickSessionFields() for persistent fields so new fields propagate automatically.
 */
function managedToSession(m: ManagedSession, overrides?: Partial<Session>): Session {
  return {
    ...pickSessionFields(m),
    // Pre-computed fields from header (not in SESSION_PERSISTENT_FIELDS)
    preview: m.preview,
    lastMessageRole: m.lastMessageRole,
    tokenUsage: m.tokenUsage,
    messageCount: m.messageCount,
    lastFinalMessageId: m.lastFinalMessageId,
    // Runtime-only fields
    workspaceId: m.workspace.id,
    workspaceName: m.workspace.name,
    messages: [],
    isProcessing: m.isProcessing,
    sessionFolderPath: getSessionStoragePath(m.workspace.rootPath, m.id),
    supportsBranching: resolveSupportsBranching(m),
    ...overrides,
  } as Session
}

// Performance: Batch IPC delta events to reduce renderer load
const DELTA_BATCH_INTERVAL_MS = 50  // Flush batched deltas every 50ms

/**
 * How long the first turn of a session continued from another one (Coding mode switch) waits for
 * the earlier conversation's summary, which is generated in the background (a few seconds).
 */
const HANDOFF_SUMMARY_WAIT_MS = 30_000

interface PendingDelta {
  delta: string
  turnId?: string
}

/** Frame an app-generated message the agent receives as a user turn, so it is not mistaken for the user. */
export function labelSystemNotice(text: string): string {
  return [
    '<system-notification>',
    'Sent by Craft Agents automatically, not typed by the user. It is not a reply to, or approval of, anything you asked.',
    text,
    '</system-notification>',
  ].join('\n')
}

/**
 * In-process session-completion signal for the Tasks Conductor.
 *
 * Emitted once per turn from `onProcessingStopped` when the session's message
 * queue is empty (i.e. true completion, not a hand-off between queued turns),
 * carrying the stop `reason`. This is an internal, side-effect-free seam — it is
 * NOT a renderer event and NOT exposed to agents. A turn the user stopped is
 * `interrupted` (or `timeout` when it did not drain), never `complete`.
 */
export interface SessionCompletionEvent {
  sessionId: string
  workspaceId: string
  reason: 'complete' | 'interrupted' | 'error' | 'timeout'
  /** The final (non-intermediate) assistant message this turn produced, if any. */
  finalMessageId?: string
  /** That message's text. Absent when the turn produced none: never an earlier turn's reply. */
  finalText?: string
  /**
   * Background agents and Workflows the session launched that are still running after the turn.
   * Their completion wakes the session for another turn, so the work is not finished yet.
   * Background shells and other tasks (Monitor...) are not counted: they may never end.
   */
  backgroundWorkRunning?: number
  /** The turn answered a message the user sent; false for an app-generated one (a background-task wake-up). */
  fromUser?: boolean
  /** The session's cumulative token usage, so the Conductor can meter token_budget without re-fetching. */
  tokenUsage?: TokenUsage
}

export interface MidStreamDeliveryOutcome {
  shouldQueue: boolean
  wasInterrupted: boolean
}

/**
 * Translate backend delivery into queue/interruption semantics. Queue mode never
 * aborts the active turn; a failed steer does, and must annotate the replay.
 */
export function resolveMidStreamDeliveryOutcome(
  behavior: MidStreamBehavior,
  steered: boolean,
): MidStreamDeliveryOutcome {
  return {
    shouldQueue: !steered,
    wasInterrupted: behavior === 'steer' && !steered,
  }
}

/**
 * Whether a mid-stream text message should be steered into the live turn.
 * A manual compaction owns the turn without an agent loop to consume steers,
 * so the message is queued for replay after `complete` instead (OSS #1058).
 */
export function shouldAttemptMidStreamSteer(
  behavior: MidStreamBehavior,
  textOnly: boolean,
  agent: { isCompactionInFlight?: () => boolean } | null | undefined,
): boolean {
  if (behavior !== 'steer' || !textOnly || !agent) return false
  return agent.isCompactionInFlight?.() !== true
}

/**
 * Mid-turn messages: whether a queued entry is one half of a continued message, i.e. it continues
 * an entry still waiting in the queue or a waiting entry continues it. Such pairs replay together.
 */
export function isInQueuedContinuation(queue: ReadonlyArray<{ message: string; mergeWith?: object }>, entry: { message: string; mergeWith?: object }): boolean {
  return (entry.mergeWith !== undefined && queue.some(other => other === entry.mergeWith))
    || queue.some(other => other.mergeWith === entry)
}

/** Text redirects cannot carry attachments or options that affect model input. */
export function canSteerTextPayload(
  attachments?: FileAttachment[],
  storedAttachments?: StoredAttachment[],
  options?: SendMessageOptions,
): boolean {
  if (attachments?.length || storedAttachments?.length) return false
  return !Object.entries(options ?? {}).some(([key, value]) => {
    if (value === undefined || key === 'optimisticMessageId') return false
    if ((key === 'skillSlugs' || key === 'badges') && Array.isArray(value) && !value.length) return false
    if (key === 'hidden' && value === false) return false
    // Unknown future options conservatively use the full-payload path.
    return true
  })
}

export class SessionManager implements ISessionManager {
  private sessions: Map<string, ManagedSession> = new Map()
  /** Test seam for HANDOFF_SUMMARY_WAIT_MS. */
  private handoffSummaryWaitMs = HANDOFF_SUMMARY_WAIT_MS
  private sessionCreationRequests = new Map<string, {
    projectId?: string
    promise: Promise<Session>
  }>()
  // Delta batching for performance - reduces IPC events from 50+/sec to ~20/sec
  private pendingDeltas: Map<string, PendingDelta> = new Map()
  private deltaFlushTimers: Map<string, NodeJS.Timeout> = new Map()
  // Config watchers for live updates (sources, etc.) - one per workspace
  private configWatchers: Map<string, ConfigWatcher> = new Map()
  // Automation systems for workspace event automations - one per workspace (includes scheduler, diffing, and handlers)
  private automationSystems: Map<string, AutomationSystem> = new Map()
  // Pending credential request resolvers (keyed by requestId)
  private pendingCredentialResolvers: Map<string, (response: import('@craft-agent/shared/protocol').CredentialResponse) => void> = new Map()
  // Permission request metadata tracking (keyed by requestId)
  private pendingPermissionRequests: Map<string, {
    sessionId: string
    type?: 'bash' | 'file_write' | 'mcp_mutation' | 'api_mutation' | 'admin_approval'
    commandHash?: string
  }> = new Map()
  // Privileged approval binding + audit logger
  private privilegedExecutionBroker = new PrivilegedExecutionBroker(sessionLog)
  // Session-local admin remember windows (exact command hash binding)
  private adminRememberApprovals: Map<string, {
    createdAt: number
    expiresAt: number
    sourceRequestId: string
  }> = new Map()
  // Promise deduplication for lazy-loading messages (prevents race conditions)
  private messageLoadingPromises: Map<string, Promise<void>> = new Map()
  private emittedQueuedRestoreIds = new Set<string>()
  private sessionLifecycleQueues = new Map<string, Promise<void>>()
  /**
   * Track which session the user is actively viewing (per workspace).
   * Map of workspaceId -> sessionId. Used to determine if a session should be
   * marked as unread when assistant completes - if user is viewing it, don't mark unread.
   */
  private activeViewingSession: Map<string, string> = new Map()
  /** Coordinates startup initialization waiters from IPC handlers. */
  private initGate = new InitGate()
  /**
   * WS2 keep-alive flag (default ON, opt-out via `CRAFT_KEEP_BG_AGENTS_ALIVE=0`).
   * When true, a persistent streaming query keeps the subprocess alive across
   * turns so background sub-agents survive, and orphaning is suppressed. When
   * false (kill-switch), sub-agents are bound to a single turn's subprocess and
   * die at turn end, so markOrphanedBackgroundTasks() flips still-running registry
   * entries to `orphaned` on turn completion. Resolved via the shared
   * `resolveKeepBackgroundTasksAlive` so the main process and the Claude backend
   * can never disagree about whether keep-alive is on.
   */
  private readonly keepBackgroundTasksAlive: boolean = resolveKeepBackgroundTasksAlive()
  /**
   * Per-session in-flight runtime-refresh promise. Ensures `updateRuntimeConfig`
   * (or a dispose) cannot overlap with another refresh OR with a send-path
   * `getOrCreateAgent` on the same session. Without this serialization, a
   * `SAVE`-triggered refresh and a `sendMessage`-triggered refresh can both
   * see `agent.isProcessing()=false`, both fire `updateRuntimeConfig`, and the
   * subprocess can race the resulting `chat` against the still-pending update.
   */
  private agentRefreshLocks: Map<string, Promise<void>> = new Map()
  /** Monotonic clock to ensure strictly increasing message timestamps */
  private lastTimestamp = 0

  /**
   * Optional binder installed by the messaging-gateway bootstrap. When set,
   * `executePromptAutomation` calls it after creating a session whose matcher
   * declared `telegramTopic`, so the new session is bound to a Telegram forum
   * topic in the workspace's paired supergroup. Best-effort — failures must
   * not block the session.
   */
  private automationBinder?: (input: {
    workspaceId: string
    sessionId: string
    topicName: string
  }) => Promise<void>

  /**
   * Merge auto-label matches into the session's labels (valued entries as `id::value`,
   * plain ones as the bare id), persist and broadcast when anything changed. Labels the
   * session already has by meaning are skipped (`newAutoLabelEntries`), so case variants
   * and legacy `bug::bug` entries never pile up or fire LabelAdd again.
   */
  private applyAutoLabelMatches(managed: ManagedSession, matches: AutoLabelMatch[], labelTree: LabelConfig[]): void {
    if (matches.length === 0) return
    const existingLabels = managed.labels ?? []
    const newEntries = newAutoLabelEntries(existingLabels, matches, labelTree)
    if (newEntries.length === 0) return
    managed.labels = [...existingLabels, ...newEntries]
    this.persistSession(managed)
    this.sendEvent({
      type: 'labels_changed',
      sessionId: managed.id,
      labels: managed.labels,
    }, managed.workspace.id)
  }

  /**
   * Semantic auto-label rules (decision model). Off the turn's critical path: the
   * first await yields so even the settings read happens after the caller has
   * moved on. A session deleted while we waited is left alone, and a label the
   * user removed during the round trip is not re-added. Never throws.
   */
  private async applySemanticAutoLabels(managed: ManagedSession, message: string, labelTree: LabelConfig[]): Promise<void> {
    const labelsAtDispatch = [...(managed.labels ?? [])]
    try {
      await Promise.resolve()
      const matches = await evaluateSemanticLabelsForMessage(message, labelTree, {
        sessionId: managed.id,
        existingEntries: labelsAtDispatch,
        log: (line) => sessionLog.info(line),
      })
      if (matches.length === 0) return
      if (this.sessions.get(managed.id) !== managed) return
      // Present at dispatch → either still present (dedupe) or removed by the user since (respect it).
      const atDispatch = new LabelEntrySet(labelsAtDispatch, foldsValueCase(labelTree))
      const fresh = matches.filter(m => !atDispatch.has(autoLabelMatchToEntry(m)))
      this.applyAutoLabelMatches(managed, fresh, labelTree)
    } catch (e) {
      sessionLog.warn(`Semantic auto-label evaluation failed for session ${managed.id}:`, e)
    }
  }

  /**
   * Turn outcome (decision model, toggle `turnOutcome`): when a completed turn ends with
   * the agent asking the user something or giving up, move an open session to Needs
   * Review. Off the completion path; never throws, never touches a closed session, and
   * the answer is dropped if a new turn started meanwhile.
   */
  private async applyTurnOutcome(managed: ManagedSession, finalMessageId: string): Promise<void> {
    try {
      await Promise.resolve()
      const index = managed.messages.findIndex(m => m.id === finalMessageId)
      const reply = index === -1 ? undefined : managed.messages[index]?.content
      if (!reply) return
      let request: string | undefined
      for (let i = index - 1; i >= 0 && request === undefined; i--) {
        if (managed.messages[i]?.role === 'user') request = managed.messages[i]?.content
      }

      const result = await classifyTurnOutcome({ request, reply }, {
        sessionId: managed.id,
        log: (line) => sessionLog.info(line),
      })
      if (!result || result.outcome === 'finished') return
      // Dropped when a newer turn started or already finished meanwhile: it answers for that turn.
      if (this.sessions.get(managed.id) !== managed || managed.isProcessing) return
      if (this.getLastFinalAssistantMessageId(managed.messages) !== finalMessageId) return

      const statuses = loadStatusConfig(managed.workspace.rootPath).statuses
      const target = statuses.find(status => status.id === TURN_OUTCOME_ATTENTION_STATUS && status.category === 'open')
      const current = statuses.find(status => status.id === managed.sessionStatus)
      if (!target || managed.sessionStatus === target.id || current?.category === 'closed') return
      sessionLog.info(`Turn outcome ${result.outcome} (confidence ${result.confidence.toFixed(2)}): session ${managed.id} → ${target.id}`)
      await this.setSessionStatus(managed.id, target.id)
    } catch (e) {
      sessionLog.warn(`Turn outcome check failed for session ${managed.id}:`, e)
    }
  }

  /**
   * Automation loop guard. An automation never runs for an event about a session it created
   * itself: that session's own prompt (a semantic or regex label rule matching it, a label the
   * matcher puts on its sessions) would otherwise re-trigger it without end. Chains through
   * other automations stop at `MAX_AUTOMATION_CHAIN_DEPTH` sessions deep. Runs before the
   * semantic condition, so a loop costs no model call either.
   */
  private automationLoopGuard(pending: PendingPrompt): { run: true; depth: number } | { run: false; reason: string } {
    const payload = pending.eventPayload ?? {}
    const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : undefined
    const origin = sessionId ? this.sessions.get(sessionId)?.triggeredBy : undefined
    if (!origin) return { run: true, depth: 1 }
    // Sessions created before automation ids were recorded carry only the name.
    const sameAutomation = origin.automationId
      ? origin.automationId === pending.matcherId
      : !!origin.automationName && origin.automationName === pending.automationName
    if (sameAutomation) return { run: false, reason: 'the event is about a session this automation created (loop guard)' }
    const depth = (origin.depth ?? 1) + 1
    if (depth > MAX_AUTOMATION_CHAIN_DEPTH) {
      return { run: false, reason: `automation chain deeper than ${MAX_AUTOMATION_CHAIN_DEPTH} sessions (loop guard)` }
    }
    return { run: true, depth }
  }

  /**
   * Automation `semanticCondition` (decision model, toggle `automationConditions`). Without a
   * condition, or when the model is off, unavailable or fails, the prompt runs as it always did; a
   * "yes" probability below the condition's threshold (default 0.5) skips it. For session events the
   * question also sees the session's latest exchange (loaded first for sessions not opened yet).
   */
  private async shouldRunPromptAutomation(pending: PendingPrompt): Promise<{ run: boolean; reason?: string }> {
    if (!pending.semanticCondition) return { run: true }
    try {
      const payload = pending.eventPayload ?? {}
      const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : undefined
      const managed = sessionId ? this.sessions.get(sessionId) : undefined
      // Sessions changed from outside the app since launch have only their metadata in memory.
      if (managed) await this.ensureMessagesLoaded(managed)
      const lastContent = (role: 'user' | 'assistant') =>
        managed?.messages.findLast(message => message.role === role && !message.isIntermediate)?.content
      const verdict = await checkAutomationCondition(pending.semanticCondition, {
        event: pending.event ?? 'unknown',
        automationName: pending.automationName,
        payload,
        session: managed
          ? {
              name: managed.name,
              labels: managed.labels,
              status: managed.sessionStatus,
              lastUserMessage: lastContent('user'),
              lastAssistantMessage: lastContent('assistant'),
            }
          : undefined,
      }, { sessionId, matcherId: pending.matcherId, log: (line) => sessionLog.info(line) })
      if (!verdict || verdict.run) return { run: true }
      return { run: false, reason: `condition not met ("yes" probability ${verdict.probability.toFixed(2)})` }
    } catch (e) {
      sessionLog.warn('[Automations] Semantic condition check failed, running the automation:', e)
      return { run: true }
    }
  }

  /**
   * Run the prompt actions an automation event produced. Each prompt starts as soon as its own
   * `semanticCondition` (decision model) is judged, so prompts without one never wait on another
   * matcher's check. A matcher is judged once per batch, so its prompt actions all run or are all
   * skipped. Every outcome is written to the automation history.
   */
  private async runReadyPrompts(workspaceId: string, workspaceRootPath: string, readyPrompts: PendingPrompt[]): Promise<void> {
    const conditionChecks = new Map<string, Promise<{ run: boolean; reason?: string }>>()
    const checkCondition = (pending: PendingPrompt) => {
      if (!pending.semanticCondition || !pending.matcherId) return this.shouldRunPromptAutomation(pending)
      let check = conditionChecks.get(pending.matcherId)
      if (!check) conditionChecks.set(pending.matcherId, check = this.shouldRunPromptAutomation(pending))
      return check
    }
    const writeHistory = (entry: Parameters<typeof createPromptHistoryEntry>[0]) =>
      appendAutomationHistoryEntry(workspaceRootPath, createPromptHistoryEntry(entry))
        .catch(e => sessionLog.warn('[Automations] Failed to write history:', e))

    await Promise.all(readyPrompts.map(async (pending, idx) => {
      const guard = this.automationLoopGuard(pending)
      if (!guard.run) {
        sessionLog.info(`[Automations] ${pending.automationName ?? 'Automation'} skipped: ${guard.reason}`)
        if (pending.matcherId) void writeHistory({ matcherId: pending.matcherId, ok: true, prompt: pending.prompt, skipped: guard.reason })
        return
      }
      const verdict = await checkCondition(pending)
      if (!verdict.run) {
        sessionLog.info(`[Automations] ${pending.automationName ?? 'Automation'} skipped: ${verdict.reason}`)
        if (pending.matcherId) void writeHistory({ matcherId: pending.matcherId, ok: true, prompt: pending.prompt, skipped: verdict.reason })
        return
      }

      // Execute the prompt automation by creating a new session; history gets the session ID.
      try {
        const { sessionId } = await this.executePromptAutomation({
          workspaceId,
          workspaceRootPath,
          prompt: pending.prompt,
          labels: pending.labels,
          permissionMode: pending.permissionMode,
          mentions: pending.mentions,
          llmConnection: pending.llmConnection,
          model: pending.model,
          thinkingLevel: pending.thinkingLevel,
          automationName: pending.automationName,
          automationId: pending.matcherId,
          triggerEvent: pending.event,
          chainDepth: guard.depth,
          telegramTopic: pending.telegramTopic,
        })
        if (pending.matcherId) void writeHistory({ matcherId: pending.matcherId, ok: true, sessionId, prompt: pending.prompt })
        sessionLog.info(`[Automations] Created session ${sessionId} from prompt action`)
      } catch (error) {
        if (pending.matcherId) void writeHistory({ matcherId: pending.matcherId, ok: false, prompt: pending.prompt, error: String(error) })
        sessionLog.error(`[Automations] Failed to execute prompt action ${idx + 1}:`, error)
      }
    }))
  }

  /**
   * Smart titles (decision model, toggle `smartTitles`): a first message that is only small
   * talk gets no AI title; the next request is titled instead (see sendMessage).
   */
  private async generateTitleUnlessSmallTalk(managed: ManagedSession, message: string): Promise<void> {
    try {
      if (await isSmallTalk(message, { sessionId: managed.id, log: (line) => sessionLog.info(line) })) {
        managed.titleDeferred = true
        sessionLog.info(`[smart-titles] Small talk in session ${managed.id}: waiting for a request to title`)
        return
      }
    } catch (e) {
      sessionLog.warn(`[smart-titles] Small-talk check failed for session ${managed.id}:`, e)
    }
    await this.generateTitle(managed, message)
  }

  /**
   * Smart titles: every few user messages, refresh an automatic title that no longer
   * describes the conversation. Titles the user set are never touched.
   */
  private async refreshTitleIfDrifted(managed: ManagedSession): Promise<void> {
    try {
      if (!managed.name || managed.name !== managed.autoTitle || managed.titleDeferred) return
      // Auto-retries and nudges are hidden: they are not new user messages.
      const userMessages = managed.messages.filter(m => m.role === 'user' && !m.hidden).map(m => m.content)
      const checkedAt = managed.titleCheckedAtUserCount ?? 1
      if (userMessages.length < TITLE_DRIFT_RECENT_MESSAGES || userMessages.length - checkedAt < TITLE_DRIFT_RECENT_MESSAGES) return
      managed.titleCheckedAtUserCount = userMessages.length
      const drifted = await titleNoLongerFits(managed.name, userMessages, { sessionId: managed.id, log: (line) => sessionLog.info(line) })
      if (!drifted || managed.name !== managed.autoTitle || managed.isProcessing || this.sessions.get(managed.id) !== managed) return
      sessionLog.info(`[smart-titles] Title of session ${managed.id} no longer fits, refreshing`)
      await this.refreshTitle(managed.id, { onlyIfName: managed.name })
    } catch (e) {
      sessionLog.warn(`[smart-titles] Title drift check failed for session ${managed.id}:`, e)
    }
  }

  /**
   * Mid-turn messages: steer or queue, as judged against the request the running turn is
   * working on (the latest user message that is not waiting in the queue). `null` keeps the
   * connection's configured behaviour.
   */
  private async decideMidTurnDelivery(managed: ManagedSession, message: string, configured: 'steer' | 'queue'): Promise<'steer' | 'queue' | null> {
    try {
      const runningRequest = managed.messages.findLast(m => m.role === 'user' && !m.isQueued && !m.hidden)?.content
      const delivery = await decideMidTurnDelivery({ runningRequest, newMessage: message, configured }, {
        sessionId: managed.id,
        log: (line) => sessionLog.info(line),
      })
      if (delivery) sessionLog.info(`[mid-turn] Session ${managed.id}: ${delivery} (decision model)`)
      return delivery
    } catch (e) {
      sessionLog.warn(`[mid-turn] Delivery check failed for session ${managed.id}:`, e)
      return null
    }
  }

  /**
   * Mid-turn messages: judge in the background whether a newly queued plain-text message
   * continues the plain-text message queued just before it; if the answer arrives before the
   * replay, both are replayed as one turn (see processNextQueuedMessage). Otherwise nothing changes.
   */
  private async markQueuedContinuation(managed: ManagedSession, payload: ManagedSession['messageQueue'][number]): Promise<void> {
    try {
      const index = managed.messageQueue.indexOf(payload)
      const previous = index > 0 ? managed.messageQueue[index - 1] : undefined
      if (!previous || !canSteerTextPayload(previous.attachments, previous.storedAttachments, previous.options)) return
      if (!canSteerTextPayload(payload.attachments, payload.storedAttachments, payload.options)) return
      const same = await isContinuation(previous.message, payload.message, { sessionId: managed.id, log: (line) => sessionLog.info(line) })
      // Both must still be waiting, in the same order, when the answer arrives.
      const now = managed.messageQueue.indexOf(payload)
      if (same && now > 0 && managed.messageQueue[now - 1] === previous) payload.mergeWith = previous
    } catch (e) {
      sessionLog.warn(`[mid-turn] Continuation check failed for session ${managed.id}:`, e)
    }
  }

  /**
   * Mid-turn messages: a text message sent during a turn was recorded as queued. If the model
   * says it corrects the running work (or has no answer and the connection steers by default),
   * move it into the turn as a steer, but only while it is still waiting in the queue, the same
   * turn is running and the backend can take a steer without its abort fallback. Otherwise it stays
   * queued and replays after the turn, exactly as a queued message always did.
   *
   * Half of a continued message is never steered: its continuation check is awaited, and a message
   * that continues a queued one (or is continued by one) replays with it. Steering only
   * "call it X" out of "when you create the event later," / "call it X" delivered the second
   * half on its own, and without "later" it read as "create the event now".
   */
  private async steerQueuedIfDecided(
    managed: ManagedSession,
    payload: ManagedSession['messageQueue'][number],
    userMessage: Message,
    configured: 'steer' | 'queue',
  ): Promise<void> {
    let staged = false
    let handedOff = false
    try {
      const generation = managed.processingGeneration
      const stopEpoch = managed.stopEpoch ?? 0
      const [decided] = await Promise.all([
        this.decideMidTurnDelivery(managed, payload.message, configured),
        payload.continuationCheck,
      ])
      if ((decided ?? configured) !== 'steer') return
      if (isInQueuedContinuation(managed.messageQueue, payload)) {
        sessionLog.info('[mid-turn] Not steering part of a continued message; it replays with the rest', { sessionId: managed.id, messageId: payload.messageId })
        return
      }
      const agent = managed.agent
      if (!managed.messageQueue.includes(payload) || this.sessions.get(managed.id) !== managed || !managed.isProcessing
        || managed.processingGeneration !== generation || (managed.stopEpoch ?? 0) !== stopEpoch
        || managed.stopRequested || managed.stopBarrier || !agent?.canSteerNow?.()
        || payload.messageId !== userMessage.id || !managed.messages.includes(userMessage) || userMessage.queuedRestoreId) return

      // The queue owns a known unsubmitted input until this write completes.
      // Once handed to the SDK, a crash must recover it for manual review,
      // never mistake the older queued row for permission to send it again.
      staged = true
      userMessage.pendingDelivery = true
      this.persistSession(managed)
      await this.flushSessionStrict(managed.id)

      const index = managed.messageQueue.indexOf(payload)
      if (index === -1 || this.sessions.get(managed.id) !== managed || managed.agent !== agent || !managed.isProcessing
        || managed.processingGeneration !== generation || (managed.stopEpoch ?? 0) !== stopEpoch
        || managed.stopRequested || managed.stopBarrier || !agent.canSteerNow?.()
        || !managed.messages.includes(userMessage) || userMessage.queuedRestoreId
        || isInQueuedContinuation(managed.messageQueue, payload)) return

      managed.messageQueue.splice(index, 1)
      if (agent.takePendingSteers && payload.messageId) (managed.acceptedSteers ??= new Map()).set(payload.messageId, payload)
      handedOff = true
      if (!agent.redirect(payload.message, { messageId: payload.messageId })) {
        handedOff = false
        if (payload.messageId) managed.acceptedSteers?.delete(payload.messageId)
        managed.messageQueue.splice(index, 0, payload)  // canSteerNow promised otherwise; keep it queued
        return
      }
      ;(managed.turnSteers ??= []).push(payload.message)
      userMessage.isQueued = false
      userMessage.pendingDelivery = agent.settlePendingSteers ? true : undefined
      sessionLog.info('mid-stream send steered after decision', { sessionId: managed.id, messageId: payload.messageId })
      this.sendEvent({
        type: 'user_message',
        sessionId: managed.id,
        message: userMessage,
        status: 'accepted',
        optimisticMessageId: payload.optimisticMessageId,
      }, managed.workspace.id)
      this.persistSession(managed)
    } catch (e) {
      sessionLog.warn(`[mid-turn] Steering a queued message failed for session ${managed.id}:`, e)
    } finally {
      // Stop/replay may have taken ownership during the write. Only roll back
      // our own still-queued, definitely unsubmitted image.
      if (staged && !handedOff && this.sessions.get(managed.id) === managed
        && managed.messageQueue.includes(payload) && managed.messages.includes(userMessage) && !userMessage.queuedRestoreId) {
        userMessage.pendingDelivery = undefined
        this.persistSession(managed)
      }
    }
  }

  /** Suggestions follow-up: note the candidates a tool call or a source activation used. */
  private noteSuggestionUse(managed: ManagedSession, call: Parameters<typeof candidatesUsedBy>[1]): void {
    const tracked = managed.suggestionTrace
    if (!tracked) return
    for (const key of candidatesUsedBy(tracked.trace.candidates, call)) tracked.used.add(key)
  }

  /** Suggestions follow-up: record whether the request used the pick. Once per request. */
  private finishSuggestionTrace(managed: ManagedSession): void {
    const tracked = managed.suggestionTrace
    if (!tracked) return
    managed.suggestionTrace = undefined
    suggestionFollowUp(tracked.trace, tracked.used)
  }

  /** Synchronous toggle check for the decision points run here (a seam for tests). */
  private decisionFeatureActive(feature: DecisionLayerFeature): boolean {
    return isDecisionFeatureActive(feature)
  }

  /**
   * Decisions taken before a turn starts (toggles `adaptiveThinking` and `suggestions`). Started
   * before agent setup so the calls overlap it; each part is `null` when off, unsure or failed.
   */
  private startPreTurnDecisions(
    managed: ManagedSession,
    message: string,
    options?: SendMessageOptions,
    turn: { activationResend?: boolean; authRetry?: boolean; attachments?: FileAttachment[] } = {},
  ): Promise<{ thinkingOverride: ThinkingLevel | null; suggestionHint: string | null }> | null {
    // An auto-retry continues the same request: keep its thinking level, ask nothing again. An
    // auth retry re-sends the attempt the provider rejected, so it keeps that attempt's hint too.
    if (turn.activationResend || turn.authRetry) {
      const thinkingOverride = managed.turnThinkingOverride ?? null
      const suggestionHint = turn.authRetry ? managed.turnSuggestionHint ?? null : null
      return thinkingOverride || suggestionHint ? Promise.resolve({ thinkingOverride, suggestionHint }) : null
    }
    managed.turnThinkingOverride = null
    managed.turnSuggestionHint = null
    this.finishSuggestionTrace(managed)
    // Valid only while the last reply answers that turn: any other message in between drops it.
    const previousThinking = managed.thinkingTrace
    managed.thinkingTrace = undefined
    const log = (line: string) => sessionLog.info(line)
    const interactive = !managed.hidden && managed.systemPromptPreset !== 'mini'
    // A caller-chosen level for this turn wins and is kept for its retries (see the branch above).
    const explicitThinking = options?.thinkingLevel ?? null
    // Slash commands are instructions to the app, and hidden messages (background-task nudges) are
    // the app's own: neither is a request to rate, so they run at the session level.
    const rateThinking = !explicitThinking && interactive && !options?.hidden && !message.trim().startsWith('/') && this.decisionFeatureActive('adaptiveThinking')
    const suggest = interactive && !managed.taskRunId && !managed.taskSlug
      && this.decisionFeatureActive('suggestions') && wantsSuggestion(message, options)
    // Nothing to ask: the caller skips the await entirely.
    if (!rateThinking && !suggest) {
      if (!explicitThinking) return null
      managed.turnThinkingOverride = explicitThinking
      return Promise.resolve({ thinkingOverride: explicitThinking, suggestionHint: null })
    }

    // Adaptive thinking: a lower level for a simple turn, never above the session's. It reads the
    // message with the end of the previous reply and the attachments' names (never their content).
    const thinking = rateThinking
      ? pickTurnThinkingLevel({
          message,
          previousReply: managed.messages.findLast(m => m.role === 'assistant' && !m.isIntermediate)?.content,
          attachments: turn.attachments?.map(a => `${a.name} (${a.type}, ${Math.max(1, Math.round(a.size / 1024))} KB)`),
        }, managed.thinkingLevel ?? DEFAULT_THINKING_LEVEL, { sessionId: managed.id, log })
          .then(({ level, result }) => {
            if (previousThinking) recordThinkingFollowUp(previousThinking, result)
            if (result) managed.thinkingTrace = result
            if (level) sessionLog.info(`[adaptive-thinking] Session ${managed.id}: thinking ${level} for this turn`)
            return level
          })
          .catch((e) => {
            sessionLog.warn(`[adaptive-thinking] Check failed for session ${managed.id}:`, e)
            return null
          })
      : Promise.resolve(explicitThinking)

    // Suggestions: point the agent at a skill or usable inactive source the message plainly needs.
    const suggestion = suggest
      ? (async () => {
          const workspaceRoot = managed.workspace.rootPath
          const candidates = collectSuggestionCandidates({
            skills: loadAllSkills(workspaceRoot, managed.workingDirectory),
            sources: loadAllSources(workspaceRoot),
            activeSourceSlugs: managed.enabledSourceSlugs ?? [],
          })
          const { hint, trace } = await pickSuggestion(message, candidates, { sessionId: managed.id, log })
          // Kept until the request is over, to record whether the agent used the pick anyway.
          if (trace) managed.suggestionTrace = { trace, used: new Set() }
          if (!hint) return null
          sessionLog.info(`[suggestions] Session ${managed.id}: suggesting ${hint.kind} "${hint.slug}"`)
          return formatSuggestionHint(hint)
        })().catch((e) => {
          sessionLog.warn(`[suggestions] Check failed for session ${managed.id}:`, e)
          return null
        })
      : Promise.resolve(null)

    return Promise.all([thinking, suggestion]).then(([thinkingOverride, suggestionHint]) => {
      managed.turnThinkingOverride = thinkingOverride
      managed.turnSuggestionHint = suggestionHint
      return { thinkingOverride, suggestionHint }
    })
  }

  /**
   * Centralized setter for session processing state.
   * Automatically notifies the power manager on transitions (true→false, false→true)
   * so callers don't need to remember to call onSessionStarted/onSessionStopped.
   */
  private setProcessing(managed: ManagedSession, processing: boolean): void {
    const was = managed.isProcessing
    managed.isProcessing = processing
    if (!was && processing) {
      sessionRuntimeHooks.onSessionStarted()
    } else if (was && !processing) {
      sessionRuntimeHooks.onSessionStopped()
    }
  }

  /** Wait until initialize() has completed (sessions loaded from disk).
   *  Resolves immediately if already initialized. */
  waitForInit(): Promise<void> {
    return this.initGate.wait()
  }

  /**
   * Install the automation→topic binder. Wired by the messaging-gateway
   * bootstrap so SessionManager doesn't need to import the messaging
   * package (avoids a package-level circular dependency).
   */
  setAutomationBinder(
    fn: (input: { workspaceId: string; sessionId: string; topicName: string }) => Promise<void>,
  ): void {
    this.automationBinder = fn
  }

  private browserPaneManager: IBrowserPaneManager | null = null
  private enqueuePageThumbnailFn?: (req: { workspaceId: string; workspaceRootPath: string; slug: string }) => void
  private rpcServer: RpcServer | null = null
  private remoteBpms = new Map<string, RemoteBrowserPaneManager>()
  /** Pinned desktop client per session for `client:browser:invoke` routing. */
  private browserHostByCanvas = new Map<string, string>()
  /** Pinned desktop client per session for the visible Drawnix board bridge. */
  private drawnixHostBySession = new Map<string, string>()
  private eventSink: EventSink | null = null

  setEventSink(sink: EventSink): void {
    this.eventSink = sink
  }

  setBrowserPaneManager(bpm: IBrowserPaneManager): void {
    this.browserPaneManager = bpm
    bpm.setSessionPathResolver((sessionId) => this.getSessionPath(sessionId))
  }

  async beginBrowserProjectDeletion(
    workspaceId: string,
    projectId: string,
  ): Promise<void> {
    if (this.browserPaneManager) {
      this.browserPaneManager.beginProjectDeletion(workspaceId, projectId)
      return
    }

    const rpcServer = this.rpcServer
    if (!rpcServer) return
    const clientIds = rpcServer.findClientsWithCapability(
      CLIENT_BROWSER_INVOKE,
      { workspaceId },
    )
    const results = await Promise.allSettled(clientIds.map(clientId => requestClientBrowserInvoke(
      rpcServer,
      clientId,
      {
        v: 1,
        method: 'beginProjectDeletion',
        args: [workspaceId, projectId],
        sessionId: '__project_cleanup__',
        workspaceId,
      },
    )))
    const failure = results.find(result => result.status === 'rejected')
    if (failure?.status === 'rejected') throw failure.reason
  }

  async finishBrowserProjectDeletion(
    workspaceId: string,
    projectId: string,
    deleted: boolean,
  ): Promise<void> {
    if (this.browserPaneManager) {
      this.browserPaneManager.finishProjectDeletion(workspaceId, projectId, deleted)
      return
    }

    const rpcServer = this.rpcServer
    if (!rpcServer) return
    const clientIds = rpcServer.findClientsWithCapability(
      CLIENT_BROWSER_INVOKE,
      { workspaceId },
    )
    await Promise.all(clientIds.map(clientId => requestClientBrowserInvoke(
      rpcServer,
      clientId,
      {
        v: 1,
        method: 'finishProjectDeletion',
        args: [workspaceId, projectId, deleted],
        sessionId: '__project_cleanup__',
        workspaceId,
      },
    )))
  }

  async destroyBrowserWindowsForSession(
    workspaceId: string,
    sessionId: string,
  ): Promise<void> {
    if (this.browserPaneManager) {
      try {
        this.browserPaneManager.destroyForSession(sessionId, workspaceId)
      } catch (error) {
        sessionLog.warn(
          `Failed to clean up Browser windows for ${sessionId}: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
      return
    }

    const rpcServer = this.rpcServer
    if (!rpcServer) return
    const clientIds = rpcServer.findClientsWithCapability(
      CLIENT_BROWSER_INVOKE,
      { workspaceId },
    )
    const results = await Promise.allSettled(clientIds.map(clientId => requestClientBrowserInvoke(
      rpcServer,
      clientId,
      {
        v: 1,
        method: 'destroyForSession',
        args: [sessionId, workspaceId],
        sessionId,
        workspaceId,
      },
    )))
    for (const result of results) {
      if (result.status === 'rejected') {
        sessionLog.warn(
          `Failed to clean up a remote Browser window for ${sessionId}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`,
        )
      }
    }
  }

  /**
   * Inject the page thumbnail capturer (Electron main only — needs a
   * BrowserWindow). Headless/WebUI hosts never call this, so
   * {@link enqueuePageThumbnail} no-ops and tiles fall back to the placeholder.
   */
  setPageThumbnailer(fn: (req: { workspaceId: string; workspaceRootPath: string; slug: string }) => void): void {
    this.enqueuePageThumbnailFn = fn
  }

  /**
   * Request a (re)capture of a page's preview poster. Fire-and-forget: the
   * injected capturer queues it, writes thumbnail.jpg, and stamps page.json
   * (which broadcasts pages:changed). No-op when no capturer is injected.
   */
  enqueuePageThumbnail(workspaceId: string, workspaceRootPath: string, slug: string): void {
    this.enqueuePageThumbnailFn?.({ workspaceId, workspaceRootPath, slug })
  }

  /**
   * Provide the WS RPC server so remote clients can host browser tools.
   *
   * When called, the SM activates the remote-bridge code path: per-session
   * `RemoteBrowserPaneManager` instances are created lazily by
   * {@link getBrowserPaneManagerForSession}, and the browser-host client is
   * resolved via {@link getBrowserHostClient} with capability-aware fallback.
   *
   * Local Electron callers do not need to call this — they already
   * call `setBrowserPaneManager(bpm)` with the in-process BPM, which takes
   * precedence over the remote bridge in {@link getBrowserPaneManagerForSession}.
   */
  setRpcServer(server: RpcServer): void {
    this.rpcServer = server
    sessionLog.info('[browser-pane] setRpcServer called — remote browser bridge is now available')
  }

  /**
   * Resolve the {@link IBrowserPaneManager} that owns the user's local browser
   * for a given session. Returns:
   *
   * 1. The locally-injected `browserPaneManager` when present (Electron client co-located
   *    with the agent), regardless of session.
   * 2. A session-bound {@link RemoteBrowserPaneManager} when `rpcServer` is set.
   *    Cached in `remoteBpms` so repeat lookups don't allocate.
   * 3. `null` when there's neither a local BPM nor an RPC server.
   */
  getBrowserPaneManagerForSession(sid: string): IBrowserPaneManager | null {
    if (this.browserPaneManager) return this.browserPaneManager
    if (!this.rpcServer) return null

    const cached = this.remoteBpms.get(sid)
    if (cached) return cached

    const session = this.sessions.get(sid)
    if (!session) return null

    const bridge = new RemoteBrowserPaneManager({
      sessionId: sid,
      workspaceId: session.workspace.id,
      rpcServer: this.rpcServer,
      getHostClient: () => this.getBrowserHostClient(sid),
    })
    this.remoteBpms.set(sid, bridge)
    return bridge
  }

  /**
   * Record which desktop client should host this session's browser. Called
   * with `ctx.clientId` from the `sessions.sendMessage` RPC handler so the
   * agent's browser_* tools route back to the client that posted the message.
   *
   * No-op when `callerClientId` is undefined — preserves the existing pin
   * (lets reconnected clients continue holding the host role).
   */
  private setLastMessageClientId(sid: string, callerClientId: string | undefined): void {
    if (!callerClientId) return
    this.browserHostByCanvas.set(sid, callerClientId)
  }

  /**
   * Called by the transport bootstrap on `onClientDisconnected`. Drops any
   * pins held by `clientId` so the next browser tool call re-resolves via
   * {@link findClientsWithCapability} instead of trying to ship to a dead client.
   */
  onClientDisconnected(clientId: string): void {
    for (const [sid, pinned] of this.browserHostByCanvas) {
      if (pinned === clientId) this.browserHostByCanvas.delete(sid)
    }
    for (const [sid, pinned] of this.drawnixHostBySession) {
      if (pinned === clientId) this.drawnixHostBySession.delete(sid)
    }
    // A renderer can disconnect after receiving a queued-restore event but
    // before acknowledging the durable draft write. Re-arm those delivery
    // markers so the next cold Session load can safely replay them.
    this.emittedQueuedRestoreIds.clear()
  }

  onClientConnected(clientId: string, workspaceId: string | null): void {
    if (!this.eventSink || !workspaceId) return
    for (const managed of this.sessions.values()) {
      if (managed.workspace.id !== workspaceId || !managed.messagesLoaded) continue
      if (!managed.messages.some(message => message.queuedRestoreId)) continue
      const pendingRestores = new Map<string, Message[]>()
      for (const message of managed.messages) {
        if (message.role !== 'user' || !message.isQueued || !message.queuedRestoreId) continue
        const group = pendingRestores.get(message.queuedRestoreId) ?? []
        group.push(structuredClone(message))
        pendingRestores.set(message.queuedRestoreId, group)
      }
      // A failed Stop write may have left only an in-memory outbox. Never let
      // a reconnect persist its draft receipt ahead of the corresponding row.
      // Only this captured batch is covered by the write: another Stop may
      // create an outbox while it waits, and must own that batch's durability.
      void (async () => {
        this.persistSession(managed)
        await this.flushSessionStrict(managed.id)
        if (this.sessions.get(managed.id) !== managed || !this.eventSink) return
        for (const [queuedRestoreId, captured] of pendingRestores) {
          const messages = captured.filter(message => managed.messages.some(current =>
            current.id === message.id && current.isQueued && current.queuedRestoreId === queuedRestoreId))
          if (messages.length === 0) continue
          this.eventSink(
            RPC_CHANNELS.sessions.EVENT,
            { to: 'client', clientId },
            {
              type: 'interrupted',
              sessionId: managed.id,
              queuedMessages: messages.map(message => message.content),
              ...(messages.some(message => message.references?.length)
                ? { queuedReferences: messages.flatMap(message => message.references ?? []) }
                : {}),
              ...(messages.some(message => message.attachments?.length)
                ? { queuedAttachments: messages.flatMap(message => message.attachments ?? []) }
                : {}),
              queuedRestoreId,
              queuedMessageIds: messages.map(message => message.id),
            },
          )
          this.emittedQueuedRestoreIds.add(`${managed.id}\0${queuedRestoreId}`)
        }
      })().catch(error => {
        sessionLog.error(`Session ${managed.id}: queued-input recovery is waiting for storage`, error)
      })
    }
  }

  async withSessionLifecycleLock<T>(
    sessionId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.sessionLifecycleQueues.get(sessionId) ?? Promise.resolve()
    const result = previous.catch(() => {}).then(operation)
    const settled = result.then(() => {}, () => {})
    this.sessionLifecycleQueues.set(sessionId, settled)
    void settled.finally(() => {
      if (this.sessionLifecycleQueues.get(sessionId) === settled) {
        this.sessionLifecycleQueues.delete(sessionId)
      }
    })
    return result
  }

  /**
   * Pinned client first, with fallback to any connected client for the workspace
   * that advertises `client:browser:invoke`. The fallback handles reconnect-with-
   * new-clientId so the agent isn't stuck waiting for another user message.
   */
  private getBrowserHostClient(sid: string): string | null {
    if (!this.rpcServer) return null
    const pinned = this.browserHostByCanvas.get(sid)
    if (pinned && this.rpcServer.hasClientCapability(pinned, CLIENT_BROWSER_INVOKE)) {
      return pinned
    }
    const session = this.sessions.get(sid)
    if (!session) return null
    const candidates = this.rpcServer.findClientsWithCapability(
      CLIENT_BROWSER_INVOKE,
      { workspaceId: session.workspace.id },
    )
    const fallback = candidates[0]
    if (!fallback) return null
    this.browserHostByCanvas.set(sid, fallback)
    return fallback
  }

  private async requestDrawnixBoardForSession(
    sid: string,
    request: DrawnixBoardCapabilityRequest,
  ): Promise<DrawnixBoardCapabilityResponse | null> {
    const server = this.rpcServer
    const session = this.sessions.get(sid)
    if (!server || !session) return null
    const fail = (code: string, message: string): DrawnixBoardCapabilityResponse => {
      this.drawnixHostBySession.delete(sid)
      return { ok: false, error: { code, message } }
    }
    if (session.projectId !== request.projectId) {
      return fail('MINDMAP_PROJECT_MISMATCH', 'The Drawnix target must belong to the invoking Session Project.')
    }
    const candidates = server.findClientsWithCapability(
      CLIENT_DRAWNIX_BOARD_INVOKE,
      { workspaceId: session.workspace.id },
    )
    if (candidates.length === 0) return null
    // An older client may also have the board open. Ignoring it would make a
    // seemingly unique target unsafe, and probing it with a mutation is worse.
    if (candidates.some(clientId => !server.hasClientCapability(clientId, CLIENT_DRAWNIX_BOARD_DISCOVER))) {
      return fail('MINDMAP_DISCOVERY_UNAVAILABLE', 'Update or close older Stair windows before using Drawnix tools.')
    }
    try {
      const discovered = await Promise.all(candidates.map(async clientId => ({
        clientId,
        response: await requestClientDrawnixBoardDiscovery(server, clientId, {
          v: 1,
          projectId: request.projectId,
          relativePath: request.relativePath,
        }),
      })))
      if (this.rpcServer !== server || this.sessions.get(sid) !== session || session.projectId !== request.projectId) {
        return fail('MINDMAP_BOARD_UNAVAILABLE', 'The Session changed while locating its Drawnix canvas. Retry the operation.')
      }
      const connected = server.findClientsWithCapability(
        CLIENT_DRAWNIX_BOARD_INVOKE,
        { workspaceId: session.workspace.id },
      )
      if (connected.length !== candidates.length || connected.some(clientId => !candidates.includes(clientId))) {
        return fail('MINDMAP_BOARD_UNAVAILABLE', 'The connected Stair windows changed while locating the canvas. Retry the operation.')
      }
      let boardCount = 0
      const targets: string[] = []
      for (const { clientId, response } of discovered) {
        if (!response || typeof response.ok !== 'boolean') {
          return fail('MINDMAP_INVALID_RESPONSE', 'A Stair window returned an invalid Drawnix discovery response.')
        }
        if (!response.ok) return fail(response.error.code, response.error.message)
        if (!Number.isSafeInteger(response.boardCount) || response.boardCount < 0 || typeof response.canCreate !== 'boolean') {
          return fail('MINDMAP_INVALID_RESPONSE', 'A Stair window returned an invalid Drawnix discovery response.')
        }
        boardCount += response.boardCount
        if (request.action === 'create' ? response.canCreate : response.boardCount === 1) {
          targets.push(clientId)
        }
      }
      if (boardCount > 1 || targets.length > 1) {
        return fail(
          'MINDMAP_AMBIGUOUS_BOARD',
          request.action === 'create'
            ? 'Keep the target Project active in only one Stair window before creating its Drawnix canvas.'
            : `Close duplicate views of ${request.relativePath} before asking the Agent to read or modify it.`,
        )
      }
      if (targets.length === 0) {
        return fail(
          request.action === 'create' ? 'MINDMAP_PROJECT_NOT_ACTIVE' : 'MINDMAP_NOT_OPEN',
          request.action === 'create'
            ? 'Open the Session Project in Stair before creating its Drawnix mind map.'
            : `Open ${request.relativePath} in Project Files before asking the Agent to read or modify it.`,
        )
      }
      const clientId = targets[0]!
      // Never retry a board operation on another client: a mutation may have
      // completed even if the original client's reply is lost on disconnect.
      const response = await requestClientDrawnixBoardInvoke(server, clientId, request)
      if (response.ok) this.drawnixHostBySession.set(sid, clientId)
      else this.drawnixHostBySession.delete(sid)
      return response
    } catch (error) {
      return fail(
        typeof (error as { code?: unknown })?.code === 'string'
          ? (error as { code: string }).code
          : 'MINDMAP_BOARD_UNAVAILABLE',
        error instanceof Error ? error.message : String(error),
      )
    }
  }

  /** Returns a strictly increasing timestamp (ms). When Date.now() collides with
   *  the previous value, increments by 1 to preserve event ordering. */
  private monotonic(): number {
    const now = Date.now()
    this.lastTimestamp = now > this.lastTimestamp ? now : this.lastTimestamp + 1
    return this.lastTimestamp
  }

  private getAdminRememberKey(sessionId: string, commandHash: string): string {
    return `${sessionId}:${commandHash}`
  }

  private hasActiveAdminRememberApproval(sessionId: string, commandHash: string): boolean {
    const key = this.getAdminRememberKey(sessionId, commandHash)
    const entry = this.adminRememberApprovals.get(key)
    if (!entry) {
      return false
    }

    if (Date.now() > entry.expiresAt) {
      this.adminRememberApprovals.delete(key)
      this.privilegedExecutionBroker.auditEvent('privileged_remember_window_expired', {
        sessionId,
        commandHash,
        sourceRequestId: entry.sourceRequestId,
        expiresAt: entry.expiresAt,
      })
      return false
    }

    return true
  }

  private storeAdminRememberApproval(sessionId: string, commandHash: string, sourceRequestId: string, rememberForMinutes: number): void {
    const boundedMinutes = Math.min(Math.max(Math.floor(rememberForMinutes), 1), MAX_ADMIN_REMEMBER_MINUTES)
    const now = Date.now()
    const expiresAt = now + boundedMinutes * 60 * 1000

    this.adminRememberApprovals.set(this.getAdminRememberKey(sessionId, commandHash), {
      createdAt: now,
      expiresAt,
      sourceRequestId,
    })

    this.privilegedExecutionBroker.auditEvent('privileged_remember_window_stored', {
      sessionId,
      commandHash,
      sourceRequestId,
      rememberForMinutes: boundedMinutes,
      createdAt: now,
      expiresAt,
    })
  }

  private clearAdminRememberApprovalsForSession(sessionId: string): void {
    const prefix = `${sessionId}:`
    for (const key of this.adminRememberApprovals.keys()) {
      if (key.startsWith(prefix)) {
        this.adminRememberApprovals.delete(key)
      }
    }
  }

  private clearPendingPermissionRequestsForSession(sessionId: string): void {
    for (const [requestId, metadata] of this.pendingPermissionRequests.entries()) {
      if (metadata.sessionId === sessionId) {
        this.pendingPermissionRequests.delete(requestId)
      }
    }
  }

  /**
   * Apply external session header metadata to in-memory state and emit UI events.
   * Returns true if any in-memory metadata field changed.
   */
  private applyExternalSessionMetadata(managed: ManagedSession, header: SessionHeader): boolean {
    const sessionId = managed.id
    let changed = false

    // Labels (canonical form: a stale writer's `bug::Bug` must not resurface)
    const headerLabels = this.canonicalLabels(managed.workspace.rootPath, header.labels)
    const oldLabels = JSON.stringify(managed.labels ?? [])
    const newLabels = JSON.stringify(headerLabels ?? [])
    if (oldLabels !== newLabels) {
      managed.labels = headerLabels
      this.sendEvent({ type: 'labels_changed', sessionId, labels: headerLabels ?? [] }, managed.workspace.id)
      changed = true
    }

    // Flagged
    if ((managed.isFlagged ?? false) !== (header.isFlagged ?? false)) {
      managed.isFlagged = header.isFlagged ?? false
      this.sendEvent(
        { type: header.isFlagged ? 'session_flagged' : 'session_unflagged', sessionId },
        managed.workspace.id
      )
      changed = true
    }

    // Session status
    if (managed.sessionStatus !== header.sessionStatus) {
      managed.sessionStatus = header.sessionStatus
      this.sendEvent({ type: 'session_status_changed', sessionId, sessionStatus: header.sessionStatus ?? '' }, managed.workspace.id)
      changed = true
    }

    // Name
    if (managed.name !== header.name) {
      managed.name = header.name
      this.sendEvent({ type: 'name_changed', sessionId, name: header.name }, managed.workspace.id)
      changed = true
    }

    // Project ownership is immutable. Restore the authoritative in-memory value if an
    // external writer edits the header instead of adopting the invalid value.
    if (managed.projectId !== header.projectId) {
      sessionLog.error(`Rejected external projectId change for session ${sessionId}`, {
        currentProjectId: managed.projectId,
        attemptedProjectId: header.projectId,
      })
      changed = true
    }

    const oldProjectNoteTarget = JSON.stringify([
      managed.projectNoteTargetPath,
      managed.projectNoteRecentTargetPaths ?? [],
    ])
    const newProjectNoteTarget = JSON.stringify([
      header.projectNoteTargetPath,
      header.projectNoteRecentTargetPaths ?? [],
    ])
    if (oldProjectNoteTarget !== newProjectNoteTarget) {
      managed.projectNoteTargetPath = header.projectNoteTargetPath
      managed.projectNoteRecentTargetPaths = header.projectNoteRecentTargetPaths
      this.sendEvent({
        type: 'session_metadata_changed',
        sessionId,
        changes: {
          projectNoteTargetPath: header.projectNoteTargetPath ?? null,
          projectNoteRecentTargetPaths: header.projectNoteRecentTargetPaths ?? [],
        },
      }, managed.workspace.id)
      changed = true
    }

    // Kanban column (mutable via drag; reconcile external/multi-window changes)
    if (managed.kanbanColumn !== header.kanbanColumn) {
      managed.kanbanColumn = header.kanbanColumn
      changed = true
    }

    if (changed) {
      sessionLog.info(`External metadata change detected for session ${sessionId}`)

      // Prevent stale pending writes from reverting externally-updated metadata.
      sessionPersistenceQueue.cancel(sessionId)
      this.persistSession(managed)
    }

    return changed
  }

  /**
   * Set up ConfigWatcher for a workspace to broadcast live updates
   * (sources added/removed, guide.md changes, etc.)
   * Called eagerly at boot for all workspaces (automations/scheduler) and
   * on client connect (GET_WORKSPACE / SWITCH_WORKSPACE).
   * Idempotent — returns immediately if already watching.
   * workspaceId must be the global config ID (what the renderer knows).
   */
  setupConfigWatcher(workspaceRootPath: string, workspaceId: string): void {
    // Check if already watching this workspace
    if (this.configWatchers.has(workspaceRootPath)) {
      return // Already watching this workspace
    }

    sessionLog.info(`Setting up ConfigWatcher for workspace: ${workspaceId} (${workspaceRootPath})`)

    const callbacks: ConfigWatcherCallbacks = {
      onSourcesListChange: async (sources: LoadedSource[]) => {
        sessionLog.info(`Sources list changed in ${workspaceRootPath} (${sources.length} sources)`)
        this.broadcastSourcesChanged(workspaceId, sources)
        await this.reloadSourcesForWorkspace(workspaceRootPath)
      },
      onSourceChange: async (slug: string, source: LoadedSource | null) => {
        sessionLog.info(`Source '${slug}' changed:`, source ? 'updated' : 'deleted')
        const sources = loadWorkspaceSources(workspaceRootPath)
        this.broadcastSourcesChanged(workspaceId, sources)
        await this.reloadSourcesForWorkspace(workspaceRootPath)
      },
      onSourceGuideChange: (sourceSlug: string) => {
        sessionLog.info(`Source guide changed: ${sourceSlug}`)
        // Broadcast the updated sources list so sidebar picks up guide changes
        // Note: Guide changes don't require session source reload (no server changes)
        const sources = loadWorkspaceSources(workspaceRootPath)
        this.broadcastSourcesChanged(workspaceId, sources)
      },
      onStatusConfigChange: () => {
        sessionLog.info(`Status config changed in ${workspaceId}`)
        this.broadcastStatusesChanged(workspaceId)
      },
      onStatusIconChange: (_workspaceId: string, iconFilename: string) => {
        sessionLog.info(`Status icon changed: ${iconFilename} in ${workspaceId}`)
        this.broadcastStatusesChanged(workspaceId)
      },
      onLabelConfigChange: () => {
        sessionLog.info(`Label config changed in ${workspaceId}`)
        this.broadcastLabelsChanged(workspaceId)
        // Emit LabelConfigChange event via AutomationSystem
        const automationSystem = this.automationSystems.get(workspaceRootPath)
        if (automationSystem) {
          automationSystem.emitLabelConfigChange().catch((error) => {
            sessionLog.error(`[Automations] Failed to emit LabelConfigChange:`, error)
          })
        }
      },
      onAutomationsConfigChange: () => {
        sessionLog.info(`Automations config changed in ${workspaceId}`)
        // Reload automations config via AutomationSystem
        const automationSystem = this.automationSystems.get(workspaceRootPath)
        if (automationSystem) {
          const result = automationSystem.reloadConfig()
          if (result.errors.length === 0) {
            sessionLog.info(`Reloaded ${result.automationCount} automations for workspace ${workspaceId}`)
          } else {
            sessionLog.error(`Failed to reload automations for workspace ${workspaceId}:`, result.errors)
          }
        }
        // Notify renderer to re-read automations.json
        this.broadcastAutomationsChanged(workspaceId)
      },
      onPagesListChange: (pages) => {
        sessionLog.info(`Pages changed in ${workspaceId} (${pages.length} pages)`)
        // Rebuild the synthetic page-refresh cron matchers (page.json is the
        // completion marker, so this also fires after every refresh run)
        this.automationSystems.get(workspaceRootPath)?.reloadPageRefreshMatchers()
        this.broadcastPagesChanged(workspaceId, pages)
      },
      onLlmConnectionsChange: () => {
        sessionLog.info(`LLM connections changed in ${workspaceId}`)
        this.broadcastLlmConnectionsChanged()
      },
      onAppThemeChange: (theme) => {
        sessionLog.info(`App theme changed`)
        this.broadcastAppThemeChanged(theme)
      },
      onDefaultPermissionsChange: () => {
        sessionLog.info('Default permissions changed')
        this.broadcastDefaultPermissionsChanged()
      },
      onSkillsListChange: async (skills) => {
        sessionLog.info(`Skills list changed in ${workspaceRootPath} (${skills.length} skills)`)
        this.broadcastSkillsChanged(workspaceId, skills)
      },
      onSkillChange: async (slug, skill) => {
        sessionLog.info(`Skill '${slug}' changed:`, skill ? 'updated' : 'deleted')
        // Broadcast updated list to UI
        const { loadAllSkills } = await import('@craft-agent/shared/skills')
        const skills = loadAllSkills(workspaceRootPath)
        this.broadcastSkillsChanged(workspaceId, skills)
      },

      // Session metadata changes (edits to session.jsonl headers).
      // Detects changes from both internal writes (self) and external sources
      // (other instances, scripts, manual edits).
      onSessionMetadataChange: (sessionId, header) => {
        const managed = this.sessions.get(sessionId)
        if (!managed) return

        // Check if this is our own write echoing back via fs.watch().
        // Self-writes don't need in-memory sync (already up to date), but
        // still need to notify the automation system for event matching.
        const incomingSignature = getHeaderMetadataSignature(header)
        const lastWrittenSignature = sessionPersistenceQueue.getLastWrittenSignature(sessionId)
        const isSelfWrite = !!(lastWrittenSignature && incomingSignature === lastWrittenSignature)

        // For external writes: sync in-memory state + emit UI events.
        // Skip for self-writes to avoid feedback loops (especially on Windows
        // where fs.watch fires aggressively: unlink + rename = 2+ events).
        if (!isSelfWrite) {
          // Defer external metadata application when:
          // 1. Session is actively processing (agent running), OR
          // 2. Session was just written programmatically (set_session_status/labels tool)
          //    — fs.watch fires during atomic write (unlink+rename) and can read stale data
          const hasWriteGuard = managed._metadataWriteGuardUntil && Date.now() < managed._metadataWriteGuardUntil
          if (managed.isProcessing || hasWriteGuard) {
            managed.pendingExternalMetadata = header
            if (hasWriteGuard) {
              sessionLog.info(`Deferred external metadata update for session ${sessionId} (recent programmatic write)`)
            } else {
              sessionLog.info(`Deferred external metadata update for session ${sessionId} (processing active)`)
            }
          } else {
            this.applyExternalSessionMetadata(managed, header)
          }
        }

        // Always notify automation system — it does its own diffing and needs
        // to see both self-writes and external changes for event matching.
        const automationSystem = this.automationSystems.get(managed.workspace.rootPath)
        if (automationSystem) {
          automationSystem.updateSessionMetadata(sessionId, {
            permissionMode: header.permissionMode,
            labels: this.canonicalLabels(managed.workspace.rootPath, header.labels),
            isFlagged: header.isFlagged,
            sessionStatus: header.sessionStatus,
            sessionName: header.name,
          }).catch((error) => {
            sessionLog.error(`[Automations] Failed to update session metadata:`, error)
          })
        }
      },
    }

    const watcher = new ConfigWatcher(workspaceRootPath, callbacks)
    watcher.start()
    this.configWatchers.set(workspaceRootPath, watcher)

    // Initialize AutomationSystem for this workspace (includes scheduler, handlers, and event logging)
    if (!this.automationSystems.has(workspaceRootPath)) {
      const automationSystem = new AutomationSystem({
        workspaceRootPath,
        workspaceId,
        enableScheduler: true,
        onPromptsReady: (readyPrompts) => this.runReadyPrompts(workspaceId, workspaceRootPath, readyPrompts),
        onError: (event, error) => {
          sessionLog.error(`Automation failed for ${event}:`, error.message)
        },
      })
      this.automationSystems.set(workspaceRootPath, automationSystem)
      sessionLog.info(`Initialized AutomationSystem for workspace ${workspaceId}`)
    }
  }

  /**
   * Manually notify the ConfigWatcher of a file change.
   * Workaround for Bun's fs.watch on Linux not detecting atomic renames.
   */
  notifyConfigFileChange(workspaceRootPath: string, relativePath: string): void {
    const watcher = this.configWatchers.get(workspaceRootPath)
    watcher?.notifyFileChange(relativePath)
  }

  /**
   * Reload sources for all sessions in a workspace, skipping those currently processing.
   */
  private async reloadSourcesForWorkspace(workspaceRootPath: string): Promise<void> {
    for (const [_, managed] of this.sessions) {
      if (managed.workspace.rootPath === workspaceRootPath) {
        if (managed.isProcessing) {
          sessionLog.info(`Skipping source reload for session ${managed.id} (processing)`)
          continue
        }
        await this.reloadSessionSources(managed)
      }
    }
  }

  private broadcastSourcesChanged(workspaceId: string, sources: LoadedSource[]): void {
    if (!this.eventSink) return
    this.eventSink(RPC_CHANNELS.sources.CHANGED, { to: 'workspace', workspaceId }, workspaceId, sources)
  }

  private broadcastStatusesChanged(workspaceId: string): void {
    if (!this.eventSink) return
    sessionLog.info(`Broadcasting statuses changed for ${workspaceId}`)
    this.eventSink(RPC_CHANNELS.statuses.CHANGED, { to: 'workspace', workspaceId }, workspaceId)
  }

  private broadcastLabelsChanged(workspaceId: string): void {
    if (!this.eventSink) return
    sessionLog.info(`Broadcasting labels changed for ${workspaceId}`)
    this.eventSink(RPC_CHANNELS.labels.CHANGED, { to: 'workspace', workspaceId }, workspaceId)
  }

  private broadcastAutomationsChanged(workspaceId: string): void {
    if (!this.eventSink) return
    sessionLog.info(`Broadcasting automations changed for ${workspaceId}`)
    this.eventSink(RPC_CHANNELS.automations.CHANGED, { to: 'workspace', workspaceId }, workspaceId)
  }

  private broadcastAppThemeChanged(theme: import('@craft-agent/shared/config').ThemeOverrides | null): void {
    if (!this.eventSink) return
    sessionLog.info(`Broadcasting app theme changed`)
    this.eventSink(RPC_CHANNELS.theme.APP_CHANGED, { to: 'all' }, theme)
  }

  private broadcastLlmConnectionsChanged(): void {
    if (!this.eventSink) return
    sessionLog.info('Broadcasting LLM connections changed')
    this.eventSink(RPC_CHANNELS.llmConnections.CHANGED, { to: 'all' })
  }

  private broadcastSkillsChanged(workspaceId: string, skills: import('@craft-agent/shared/skills').LoadedSkill[]): void {
    if (!this.eventSink) return
    sessionLog.info(`Broadcasting skills changed (${skills.length} skills)`)
    this.eventSink(RPC_CHANNELS.skills.CHANGED, { to: 'workspace', workspaceId }, workspaceId, skills)
  }

  private broadcastPagesChanged(workspaceId: string, pages: import('@craft-agent/shared/pages').LoadedPage[]): void {
    if (!this.eventSink) return
    sessionLog.info(`Broadcasting pages changed (${pages.length} pages)`)
    this.eventSink(RPC_CHANNELS.pages.CHANGED, { to: 'workspace', workspaceId }, workspaceId, pages)
  }

  private broadcastDefaultPermissionsChanged(): void {
    if (!this.eventSink) return
    sessionLog.info('Broadcasting default permissions changed')
    this.eventSink(RPC_CHANNELS.permissions.DEFAULTS_CHANGED, { to: 'all' }, null)
  }

  /**
   * Reload sources for a session with an active agent.
   * Called by ConfigWatcher when source files change on disk.
   * If agent is null (session hasn't sent any messages), skip - fresh build happens on next message.
   */
  private async reloadSessionSources(managed: ManagedSession): Promise<void> {
    if (!managed.agent) return  // No agent = nothing to update (fresh build on next message)

    const workspaceRootPath = managed.workspace.rootPath
    sessionLog.info(`Reloading sources for session ${managed.id}`)

    // Reload all sources from disk
    const allSources = loadAllSources(workspaceRootPath)
    managed.agent.setAllSources(allSources)

    // Rebuild MCP and API servers for session's enabled sources
    const enabledSlugs = managed.enabledSourceSlugs || []
    const enabledSources = allSources.filter(s =>
      enabledSlugs.includes(s.config.slug) && isSourceUsable(s)
    )
    // Pass session path so large API responses can be saved to session folder
    const sessionPath = getSessionStoragePath(workspaceRootPath, managed.id)
    const { mcpServers, apiServers } = await buildServersFromSources(enabledSources, sessionPath, managed.tokenRefreshManager, managed.agent?.getSummarizeCallback())
    const intendedSlugs = enabledSources.map(s => s.config.slug)

    await managed.agent.setSourceServers(mcpServers, apiServers, intendedSlugs)

    sessionLog.info(`Sources reloaded for session ${managed.id}: ${Object.keys(mcpServers).length} MCP, ${Object.keys(apiServers).length} API`)
  }

  /**
   * Reinitialize authentication environment variables.
   * Call this after onboarding or settings changes to pick up new credentials.
   *
   * SECURITY NOTE: These env vars are propagated to the SDK subprocess via options.ts.
   * Bun's automatic .env loading is disabled in the subprocess (--env-file=/dev/null)
   * to prevent a user's project .env from injecting ANTHROPIC_API_KEY and overriding
   * OAuth auth — Claude Code prioritizes API key over OAuth token when both are set.
   * See: https://github.com/craft-ai-agents/craft-agents-oss/issues/39
   */
  /**
   * Reinitialize authentication environment variables.
   *
   * Uses the default LLM connection to determine which credentials to set.
   *
   * @param connectionSlug - Optional connection slug to use (overrides default)
   */
  async reinitializeAuth(connectionSlug?: string): Promise<void> {
    try {
      const manager = getCredentialManager()

      // Get the connection to use (explicit parameter or default)
      const slug = connectionSlug || getDefaultLlmConnection()
      if (!slug) {
        sessionLog.warn('No LLM connection slug available for reinitializeAuth')
      }
      const connection = slug ? getLlmConnection(slug) : null

      // Restore managed auth env vars to their baseline before applying this connection.
      resetManagedAnthropicAuthEnvVars()

      if (!connection) {
        sessionLog.error(`No LLM connection found for slug: ${slug}`)
        resetSummarizationClient()
        return
      }

      sessionLog.info(`Reinitializing auth for connection: ${slug} (${connection.authType})`)

      // Resolve auth env vars via shared utility (provider-agnostic)
      const result = await resolveAuthEnvVars(connection, slug!, manager, getValidClaudeOAuthToken)

      if (!result.success) {
        sessionLog.error(`Auth resolution failed for ${slug}: ${result.warning}`)
      } else {
        // Apply resolved env vars to process.env
        for (const [key, value] of Object.entries(result.envVars)) {
          process.env[key] = value
        }
        sessionLog.info(`Auth env vars set for connection: ${slug}`)
      }

      // Reset cached summarization client so it picks up new credentials/base URL
      resetSummarizationClient()
    } catch (error) {
      sessionLog.error('Failed to reinitialize auth:', error)
      throw error
    }
  }

  async initialize(): Promise<void> {
    // Large tool results (decision model, toggle `largeResults`): the process-wide filter keeps the
    // parts the agent's intent needs instead of a summary; it no-ops while the toggle is off.
    setLargeResultFilter(buildLargeResultFilter({ log: (line) => sessionLog.info(line) }))
    // Guarded mode behaves as Ask while its risk check cannot run (decision layer or feature off).
    setGuardedModeActiveResolver(() => isDecisionFeatureActive('guardedMode'))

    try {
      // Backfill missing `models` arrays on existing LLM connections
      migrateLegacyLlmConnectionsConfig()

      // Fix defaultLlmConnection if it points to a non-existent connection
      migrateOrphanedDefaultConnections()

      // Migrate legacy credentials to LLM connection format (one-time migration)
      // This ensures credentials saved before LLM connections are available via the new system
      await migrateLegacyCredentials()

      // Set up authentication environment variables (critical for SDK to work)
      await this.reinitializeAuth()

      // Eagerly activate ConfigWatcher + AutomationSystem for every workspace so
      // the scheduler and event handlers start at boot — not lazily on first
      // client connect. This is critical for headless servers where no UI may
      // ever connect, yet scheduled/event-driven automations must still fire.
      const workspaces = getWorkspaces()
      for (const workspace of workspaces) {
        this.setupConfigWatcher(workspace.rootPath, workspace.id)
      }

      // Load existing sessions from disk
      this.loadSessionsFromDisk()

      // Signal that initialization is complete — IPC handlers waiting on initGate will proceed
      this.initGate.markReady()
    } catch (error) {
      this.initGate.markFailed(error)
      throw error
    }
  }

  // Load all existing sessions from disk into memory (metadata only - messages are lazy-loaded)
  private loadSessionsFromDisk(): void {
    try {
      const workspaces = getWorkspaces()
      let totalSessions = 0

      // Iterate over each workspace and load its sessions
      for (const workspace of workspaces) {
        const workspaceRootPath = workspace.rootPath
        const sessionMetadata = listStoredSessions(workspaceRootPath)
        // Load workspace config once per workspace for default working directory
        const wsConfig = loadWorkspaceConfig(workspaceRootPath)
        const wsDefaultWorkingDir = wsConfig?.defaults?.workingDirectory
        // Label tree once per workspace: stored labels are read in canonical form (canonicalLabels)
        let labelTree: LabelConfig[] | undefined
        try { labelTree = listLabels(workspaceRootPath) } catch (e) { sessionLog.warn(`Could not read labels for ${workspaceRootPath}:`, e) }

        for (const meta of sessionMetadata) {
          try {
            // Create managed session from metadata only (messages lazy-loaded on demand)
            // This dramatically reduces memory usage at startup - messages are loaded
            // when getSession() is called for a specific session
            const managed = createManagedSession(meta, workspace, {
              // The header carries the session's explicit source selection (persisted at
              // creation / by setSessionSources). Seed it now so the renderer's very first
              // session list shows the right chips — sessions without one hydrate any legacy
              // body value on message load (see hydrateMessagesForColdPersist).
              enabledSourceSlugs: meta.enabledSourceSlugs,
              workingDirectory: meta.workingDirectory ?? wsDefaultWorkingDir,
            })

            // Older auto-labelling stored values on plain labels (`bug::bug`, `bug::Bug`) and empty values
            // (`trip::`). Read them in canonical form before the automation snapshot below, so the cleanup
            // fires no label events; the canonical list reaches disk with the session's next save.
            if (labelTree) managed.labels = this.canonicalLabels(workspaceRootPath, managed.labels, labelTree)

            // Migration: clear orphaned llmConnection references (e.g., after connection was deleted)
            if (managed.llmConnection) {
              const conn = resolveSessionConnection(managed.llmConnection, undefined)
              if (!conn) {
                sessionLog.warn(`Session ${meta.id} has orphaned llmConnection "${managed.llmConnection}", clearing`)
                managed.llmConnection = undefined
                managed.connectionLocked = false
              }
            }

            // Initialize mode-manager state for restored sessions even before agent creation.
            // This keeps diagnostics/effective mode aligned with persisted session metadata.
            setPermissionMode(meta.id, managed.permissionMode ?? 'ask', { changedBy: 'restore' })
            if (managed.previousPermissionMode) {
              hydratePreviousPermissionMode(meta.id, managed.previousPermissionMode)
            }

            this.sessions.set(meta.id, managed)

            // Initialize session metadata in AutomationSystem for diffing
            const automationSystem = this.automationSystems.get(workspaceRootPath)
            if (automationSystem) {
              automationSystem.setInitialSessionMetadata(meta.id, {
                permissionMode: meta.permissionMode,
                labels: managed.labels,
                isFlagged: meta.isFlagged,
                sessionStatus: meta.sessionStatus,
                sessionName: managed.name,
              })
            }

            totalSessions++
          } catch (error) {
            sessionLog.error(`Failed to load Session ${meta.id}; continuing with remaining Sessions:`, error)
          }
        }
      }

      sessionLog.info(`Loaded ${totalSessions} sessions from disk (metadata only)`)
    } catch (error) {
      sessionLog.error('Failed to load sessions from disk:', error)
    }
  }

  /**
   * A session's labels in canonical form for its workspace's label tree (canonicalizeSessionLabels):
   * how every label list read from disk or handed in by a writer is stored, so older auto-labelling's
   * `bug::bug` / `bug::Bug` / `trip::` read as `bug` / `trip` and duplicates never reach the UI,
   * automations or agents. Unchanged when the label config can't be read.
   */
  private canonicalLabels(workspaceRootPath: string, labels: string[] | undefined, labelTree?: LabelConfig[]): string[] | undefined {
    if (!labels?.length) return labels
    try {
      return canonicalizeSessionLabels(labels, labelTree ?? listLabels(workspaceRootPath))
    } catch (e) {
      sessionLog.warn('Could not canonicalize session labels:', e)
      return labels
    }
  }

  /** The session a branch was forked from: live in memory, else its header on disk. */
  private branchParent(managed: ManagedSession): BranchParent | null {
    if (!managed.branchFromSessionPath) return null
    const parentId = basename(managed.branchFromSessionPath)
    return this.sessions.get(parentId) ?? readSessionHeader(getSessionFilePath(managed.workspace.rootPath, parentId))
  }

  // Suppress fs.watch metadata-revert events for the window in which our own
  // atomic write completes. See onSessionMetadataChange.
  private setMetadataWriteGuard(managed: ManagedSession): void {
    managed._metadataWriteGuardUntil = Date.now() + METADATA_WRITE_GUARD_MS
  }

  /**
   * Persist a session to disk (async, with debouncing in the persistence queue).
   *
   * Cold-session path: if messages haven't been lazy-loaded yet, hydrate them
   * synchronously from the JSONL first — otherwise the snapshot we enqueue
   * would write `messages: []` over the real messages on disk. Hydration
   * deliberately does NOT touch persistent metadata fields (name, labels,
   * sessionStatus, llmConnection, ...) because the caller may have just
   * mutated them; the in-memory mutation must win over what's on disk.
   * `loadStoredSession` is synchronous (sync fs reads), so the entire path
   * stays sync — no microtask race window between the load and the enqueue.
   */
  private persistSession(managed: ManagedSession): void {
    if (this.sessions.get(managed.id) !== managed) return
    if (!managed.messagesLoaded) {
      this.hydrateMessagesForColdPersist(managed)
    }
    this.enqueuePersist(managed)
  }

  // Cold-persist hydration. Mirrors the messages/queue-recovery half of
  // loadMessagesFromDisk but skips the metadata field syncs. Sets
  // messagesLoaded=true so subsequent persistSession calls take the fast path.
  // Subsequent ensureMessagesLoaded calls also short-circuit, which is fine —
  // queue recovery has already run here.
  private hydrateMessagesForColdPersist(managed: ManagedSession): void {
    sessionLog.debug(`Cold-load triggered for persistSession on ${managed.id}`)
    const stored = loadStoredSession(managed.workspace.rootPath, managed.id)
    if (stored) {
      managed.messages = (stored.messages || []).map(storedToMessage)
      this.markUnacceptedInputForRestore(managed)
      managed.tokenUsage = stored.tokenUsage
      managed.pendingPlanExecution = this.reconcileStoredPendingPlanExecution(managed, stored)
      // Deferred-load fields (intentionally undefined after startup, see
      // loadSessionsFromDisk). Populate from disk only if not already set in
      // memory — a caller may have mutated them via setSessionSources etc.
      if (managed.enabledSourceSlugs === undefined) managed.enabledSourceSlugs = stored.enabledSourceSlugs
      if (managed.lastReadMessageId === undefined) managed.lastReadMessageId = stored.lastReadMessageId
      if (managed.hasUnread === undefined) managed.hasUnread = stored.hasUnread
      if (managed.sharedUrl === undefined) managed.sharedUrl = stored.sharedUrl
      if (managed.sharedId === undefined) managed.sharedId = stored.sharedId
      if (managed.transferredSessionSummary === undefined) managed.transferredSessionSummary = stored.transferredSessionSummary
      if (managed.transferredSessionSummaryApplied === undefined) managed.transferredSessionSummaryApplied = stored.transferredSessionSummaryApplied

      // Queue recovery: find orphaned queued messages from crash/restart and re-queue them.
      const orphanedQueued = managed.messages.filter(m =>
        m.role === 'user' && m.isQueued === true && !m.queuedRestoreId
        && !(managed.pendingPlanExecution?.failed && m.id === managed.pendingPlanExecution.approvalMessageId)
      )
      if (orphanedQueued.length > 0) {
        sessionLog.info(`Recovering ${orphanedQueued.length} queued message(s) for session ${managed.id}`)
        for (const msg of orphanedQueued) {
          managed.messageQueue.push({
            message: msg.content,
            messageId: msg.id,
            attachments: undefined,
            storedAttachments: msg.attachments,
            options: msg.references?.length ? { references: msg.references } : undefined,
          })
        }
        if (!managed.isProcessing && managed.messageQueue.length > 0) {
          setImmediate(() => {
            this.processNextQueuedMessage(managed.id)
          })
        }
      }
      sessionLog.debug(`Cold-hydrated ${managed.messages.length} messages for session ${managed.id}`)
    }
    managed.messagesLoaded = true
  }

  // Build the StoredSession snapshot and hand it to the persistence queue.
  // Caller must ensure `managed.messagesLoaded` is true.
  private enqueuePersist(managed: ManagedSession): void {
    try {
      // Filter out transient status messages (progress indicators like "Compacting...")
      // Error messages are now persisted with rich fields for diagnostics
      const persistableMessages = managed.messages.filter(m =>
        m.role !== 'status'
      )

      const storedSession: StoredSession = {
        ...pickSessionFields(managed),
        workspaceRootPath: managed.workspace.rootPath,
        createdAt: managed.createdAt ?? Date.now(),
        lastUsedAt: Date.now(),
        messages: persistableMessages.map(messageToStored),
        tokenUsage: managed.tokenUsage ?? DEFAULT_TOKEN_USAGE,
      } as StoredSession

      // Queue for async persistence with debouncing
      sessionPersistenceQueue.enqueue(storedSession)
    } catch (error) {
      sessionLog.error(`Failed to queue session ${managed.id} for persistence:`, error)
    }
  }

  // Flush a specific session immediately (call on session close/switch).
  // Cold-persist hydration is synchronous, so by the time we reach here the
  // queue already has an entry whenever persistSession was just called.
  async flushSession(sessionId: string): Promise<void> {
    if (this.sessions.get(sessionId)?.pendingPlanReceiptRetirements?.size) {
      await this.flushSessionStrict(sessionId).catch(error => sessionLog.error(`Session ${sessionId}: accepted handoff persistence is still pending`, error))
      return
    }
    await sessionPersistenceQueue.flush(sessionId)
  }

  /**
   * Flush with a durability guarantee: rejects when the session's last known
   * write failed, so lifecycle transitions (pending-plan claim/handoff,
   * compaction-failure cancellation) never report success that disk never saw.
   */
  private async flushSessionStrict(sessionId: string): Promise<void> {
    await sessionPersistenceQueue.flush(sessionId, { strict: true })
    const managed = this.sessions.get(sessionId)
    for (const executionId of managed?.pendingPlanReceiptRetirements ?? []) {
      retirePlanDraftConsumption(sessionId, executionId)
      managed!.pendingPlanReceiptRetirements!.delete(executionId)
    }
  }

  // Flush all pending sessions (call on app quit).
  async flushAllSessions(): Promise<void> {
    await sessionPersistenceQueue.flushAll({ strict: true })
  }

  // ============================================
  // Unified Auth Request Helpers
  // ============================================

  /**
   * Get human-readable description for auth request
   */
  private getAuthRequestDescription(request: AuthRequest): string {
    switch (request.type) {
      case 'credential':
        return `Authentication required for ${request.sourceName}`
      case 'oauth':
        return `OAuth authentication for ${request.sourceName}`
      case 'oauth-google':
        return `Sign in with Google for ${request.sourceName}`
      case 'oauth-slack':
        return `Sign in with Slack for ${request.sourceName}`
      case 'oauth-microsoft':
        return `Sign in with Microsoft for ${request.sourceName}`
    }
  }

  /**
   * Format auth result message to send back to agent
   */
  private formatAuthResultMessage(result: AuthResult): string {
    if (result.success) {
      let msg = `Authentication completed for ${result.sourceSlug}.`
      if (result.email) msg += ` Signed in as ${result.email}.`
      if (result.workspace) msg += ` Connected to workspace: ${result.workspace}.`
      msg += ' Credentials have been saved.'
      return msg
    }
    if (result.cancelled) {
      return `Authentication cancelled for ${result.sourceSlug}.`
    }
    return `Authentication failed for ${result.sourceSlug}: ${result.error || 'Unknown error'}`
  }


  /**
   * Complete an auth request and send result back to agent
   * This updates the auth message status and sends a faked user message
   */
  async completeAuthRequest(sessionId: string, result: AuthResult): Promise<void> {
    const managed = this.sessions.get(sessionId)
    if (!managed) {
      sessionLog.warn(`Cannot complete auth request - session ${sessionId} not found`)
      return
    }

    // A credential exchange may finish after Stop, a replacement request, or
    // a newer turn. Only the live request is allowed to resume this session.
    const request = managed.pendingAuthRequest
    const owner = managed.pendingAuthOwner
    if (!request || managed.pendingAuthRequestId !== result.requestId
      || request.requestId !== result.requestId || request.sourceSlug !== result.sourceSlug
      || owner && (owner.generation !== managed.processingGeneration || owner.stopEpoch !== (managed.stopEpoch ?? 0))) return

    // Find and update the pending auth-request message
    const authMessage = managed.messages.find(m =>
      m.role === 'auth-request' &&
      m.authRequestId === result.requestId &&
      m.authStatus === 'pending'
    )

    if (!authMessage) return
    if (authMessage) {
      authMessage.authStatus = result.success ? 'completed' :
                               result.cancelled ? 'cancelled' : 'failed'
      authMessage.authError = result.error
      authMessage.authEmail = result.email
      authMessage.authWorkspace = result.workspace
    }

    // Emit auth_completed event to update UI
    this.sendEvent({
      type: 'auth_completed',
      sessionId,
      requestId: result.requestId,
      success: result.success,
      cancelled: result.cancelled,
      error: result.error,
    }, managed.workspace.id)

    // Create faked user message with result
    const resultContent = this.formatAuthResultMessage(result)

    // Clear pending auth state
    managed.pendingAuthRequestId = undefined
    managed.pendingAuthRequest = undefined
    managed.pendingAuthOwner = undefined

    // Auto-enable the source in the session after successful auth
    if (result.success && result.sourceSlug) {
      const slugSet = new Set(managed.enabledSourceSlugs || [])
      if (!slugSet.has(result.sourceSlug)) {
        slugSet.add(result.sourceSlug)
        managed.enabledSourceSlugs = Array.from(slugSet)
        sessionLog.info(`Auto-enabled source ${result.sourceSlug} in session ${sessionId} after auth`)
      }

      // Clear any refresh cooldown so the source is immediately usable
      managed.tokenRefreshManager.clearCooldown(result.sourceSlug)
    }

    // Persist session with updated auth message and enabled sources
    this.persistSession(managed)

    // Send the result as a new message to resume conversation
    // Use empty arrays for attachments since this is a system-generated message
    if (!result.cancelled) await this.sendMessage(sessionId, resultContent, [], [], { hidden: true })

    sessionLog.info(`Auth request completed for ${result.sourceSlug}: ${result.success ? 'success' : 'failed'}`)
  }

  /**
   * One OAuth sign-in serves every session paused on the source: complete each session's
   * pending OAuth request for it in this workspace and resume it. `boundRequests` (the cards
   * that started or joined the sign-in) also count when their session no longer holds the
   * request in memory — `pendingAuthRequest` is not persisted, so a restart forgets it.
   * Resumed turns run in the background so sessions don't wait on each other's turns.
   */
  completeAuthRequestsForSource(
    workspaceId: string,
    sourceSlug: string,
    result: { email?: string; workspace?: string },
    boundRequests: Array<{ sessionId: string; authRequestId: string }> = [],
  ): string[] {
    const bound = new Map(boundRequests.map(r => [r.sessionId, r.authRequestId]))
    const resumed: string[] = []
    for (const managed of this.sessions.values()) {
      if (managed.workspace.id !== workspaceId) continue
      // The fresh tokens void any refresh-failure cooldown, whether or not the session was waiting
      managed.tokenRefreshManager.clearCooldown(sourceSlug)

      let requestId: string | undefined
      const pending = managed.pendingAuthRequest
      if (pending) {
        // A session holds one request at a time; answer it only if it is this source's sign-in
        if (pending.type !== 'credential' && pending.sourceSlug === sourceSlug) requestId = pending.requestId
      } else {
        const boundId = bound.get(managed.id)
        if (boundId && managed.messages.some(m =>
          m.role === 'auth-request' && m.authRequestId === boundId && m.authStatus === 'pending')) {
          requestId = boundId
        }
      }
      if (!requestId) continue

      resumed.push(managed.id)
      this.completeAuthRequest(managed.id, { requestId, sourceSlug, success: true, ...result })
        .catch(error => sessionLog.error(`Failed to resume session ${managed.id} after ${sourceSlug} sign-in:`, error))
    }
    return resumed
  }

  /**
   * Handle credential input from the UI (for non-OAuth auth)
   * Called when user submits credentials via the inline form
   */
  async handleCredentialInput(
    sessionId: string,
    requestId: string,
    response: import('@craft-agent/shared/protocol').CredentialResponse
  ): Promise<void> {
    const managed = this.sessions.get(sessionId)
    if (!managed?.pendingAuthRequest) {
      sessionLog.warn(`Cannot handle credential input - no pending auth request for session ${sessionId}`)
      return
    }

    const request = managed.pendingAuthRequest as CredentialAuthRequest
    if (request.requestId !== requestId) {
      sessionLog.warn(`Credential request ID mismatch: expected ${request.requestId}, got ${requestId}`)
      return
    }

    if (response.cancelled) {
      await this.completeAuthRequest(sessionId, {
        requestId,
        sourceSlug: request.sourceSlug,
        success: false,
        cancelled: true,
      })
      return
    }

    try {
      // Store credentials using existing workspace ID extraction pattern
      const credManager = getCredentialManager()
      // Extract workspace ID from root path (last segment of path)
      const wsId = basename(managed.workspace.rootPath) || managed.workspace.id

      if (request.mode === 'basic') {
        // Store value as JSON string {username, password} - credential-manager.ts parses it for basic auth
        await credManager.set(
          { type: 'source_basic', workspaceId: wsId, sourceId: request.sourceSlug },
          { value: JSON.stringify({ username: response.username, password: response.password }) }
        )
      } else if (request.mode === 'bearer') {
        await credManager.set(
          { type: 'source_bearer', workspaceId: wsId, sourceId: request.sourceSlug },
          { value: response.value! }
        )
      } else if (request.mode === 'multi-header') {
        // Store multi-header credentials as JSON { "DD-API-KEY": "...", "DD-APPLICATION-KEY": "..." }.
        // A single header matching the source's headerName is stored bare so it never
        // reaches the wire as a serialized object (#1067).
        await credManager.set(
          { type: 'source_apikey', workspaceId: wsId, sourceId: request.sourceSlug },
          { value: serializeHeaderCredential(response.headers ?? {}, request.headerName) }
        )
      } else {
        // header or query - both use API key storage
        await credManager.set(
          { type: 'source_apikey', workspaceId: wsId, sourceId: request.sourceSlug },
          { value: response.value! }
        )
      }

      // Update source config to mark as authenticated
      const { markSourceAuthenticated } = await import('@craft-agent/shared/sources')
      markSourceAuthenticated(managed.workspace.rootPath, request.sourceSlug)

      // Mark source as unseen so fresh guide is injected on next message
      if (managed.agent) {
        managed.agent.markSourceUnseen(request.sourceSlug)
      }

      await this.completeAuthRequest(sessionId, {
        requestId,
        sourceSlug: request.sourceSlug,
        success: true,
      })
    } catch (error) {
      sessionLog.error(`Failed to save credentials for ${request.sourceSlug}:`, error)
      await this.completeAuthRequest(sessionId, {
        requestId,
        sourceSlug: request.sourceSlug,
        success: false,
        error: error instanceof Error ? error.message : 'Failed to save credentials',
      })
    }
  }

  getWorkspaces(): Workspace[] {
    return getWorkspaces()
  }

  getWorkspacesInfo(): WorkspaceInfo[] {
    return getWorkspaces().map(({ rootPath, createdAt, ...info }) => info)
  }

  getActiveSessionCount(workspaceId?: string): number {
    let count = 0
    for (const managed of this.sessions.values()) {
      if (workspaceId && managed.workspace.id !== workspaceId) continue
      if (managed.isProcessing) count++
    }
    return count
  }

  getWorkspaceAutomationSummary(workspaceId: string): { automationCount: number; schedulerRunning: boolean } {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) return { automationCount: 0, schedulerRunning: false }

    const automationSystem = this.automationSystems.get(workspace.rootPath)
    if (!automationSystem) return { automationCount: 0, schedulerRunning: false }

    const config = automationSystem.getConfig()
    let automationCount = 0
    if (config) {
      for (const matchers of Object.values(config.automations)) {
        automationCount += matchers?.length ?? 0
      }
    }

    return {
      automationCount,
      // SchedulerService is running if the system was created with enableScheduler
      schedulerRunning: !automationSystem.isDisposed(),
    }
  }

  getActiveSessionsInfo(): ActiveSessionInfo[] {
    const result: ActiveSessionInfo[] = []
    for (const managed of this.sessions.values()) {
      if (!managed.isProcessing) continue

      let status: SessionProcessingStatus = 'processing'
      if (managed.stopRequested) status = 'idle'

      result.push({
        sessionId: managed.id,
        workspaceId: managed.workspace.id,
        workspaceName: managed.workspace.name,
        title: managed.name || undefined,
        status,
        triggeredBy: managed.triggeredBy
          ? { automationName: managed.triggeredBy.automationName ?? 'Unknown', timestamp: managed.triggeredBy.timestamp ?? 0 }
          : undefined,
        createdAt: managed.lastMessageAt,
      })
    }
    return result
  }

  /**
   * Reload all sessions from disk.
   * Used after importing sessions to refresh the in-memory session list.
   */
  reloadSessions(): void {
    this.loadSessionsFromDisk()
  }

  getSessions(workspaceId?: string): Session[] {
    // Returns session metadata only - messages are NOT included to save memory
    // Use getSession(id) to load messages for a specific session
    let sessions = Array.from(this.sessions.values())

    // Filter by workspace if specified (used when switching workspaces)
    if (workspaceId) {
      sessions = sessions.filter(m => m.workspace.id === workspaceId)
    }

    return sessions
      .map(m => managedToSession(m))
      .sort((a, b) => (b.lastMessageAt ?? 0) - (a.lastMessageAt ?? 0))
  }

  hasSession(sessionId: string, workspaceId?: string): boolean {
    const session = this.sessions.get(sessionId)
    return !!session && (!workspaceId || session.workspace.id === workspaceId)
  }

  /**
   * Aggregate unread state across all workspaces.
   * Excludes hidden and archived sessions from counts/indicators.
   */
  getUnreadSummary(): UnreadSummary {
    const byWorkspace: Record<string, number> = {}
    const hasUnreadByWorkspace: Record<string, boolean> = {}

    for (const workspace of getWorkspaces()) {
      byWorkspace[workspace.id] = 0
      hasUnreadByWorkspace[workspace.id] = false
    }

    for (const session of this.sessions.values()) {
      if (session.hidden || session.isArchived) continue
      if (!session.hasUnread) continue

      const workspaceId = session.workspace.id
      byWorkspace[workspaceId] = (byWorkspace[workspaceId] ?? 0) + 1
      hasUnreadByWorkspace[workspaceId] = true
    }

    const totalUnreadSessions = Object.values(byWorkspace).reduce((sum, count) => sum + count, 0)

    return {
      totalUnreadSessions,
      byWorkspace,
      hasUnreadByWorkspace,
    }
  }

  /**
   * Refresh badge count from current unread state.
   * Called by renderer on mount — ensures badge is set even if the initial
   * emitUnreadSummaryChanged() fired before the renderer was ready.
   */
  refreshBadge(): void {
    const summary = this.getUnreadSummary()
    sessionRuntimeHooks.updateBadgeCount(summary.totalUnreadSessions)
  }

  /**
   * Broadcast global unread summary to all workspace windows.
   */
  private emitUnreadSummaryChanged(): void {
    const summary = this.getUnreadSummary()

    // Update badge via runtime hook — host decides whether/how to render badges
    sessionRuntimeHooks.updateBadgeCount(summary.totalUnreadSessions)

    if (!this.eventSink) return

    // Broadcast to renderers for UI updates (session list dots, etc.)
    this.eventSink(RPC_CHANNELS.sessions.UNREAD_SUMMARY_CHANGED, { to: 'all' }, summary)
  }

  /**
   * Get a single session by ID with all messages loaded.
   * Used for lazy loading session messages when session is selected.
   * Messages are loaded from disk on first access to reduce memory usage.
   */
  async getSession(sessionId: string): Promise<Session | null> {
    const m = this.sessions.get(sessionId)
    if (!m) return null

    // Lazy-load messages from disk if not yet loaded
    await this.ensureMessagesLoaded(m)

    const pendingRestores = new Map<string, Message[]>()
    for (const message of m.messages) {
      if (message.role !== 'user' || !message.isQueued || !message.queuedRestoreId) continue
      const key = `${m.id}\0${message.queuedRestoreId}`
      if (this.emittedQueuedRestoreIds.has(key)) continue
      const group = pendingRestores.get(message.queuedRestoreId) ?? []
      group.push(structuredClone(message))
      pendingRestores.set(message.queuedRestoreId, group)
    }
    if (pendingRestores.size > 0) {
      // A successful flush covers this value snapshot, not outboxes created
      // concurrently while that flush is waiting on the previous disk write.
      this.persistSession(m)
      await this.flushSessionStrict(sessionId)
      if (this.sessions.get(sessionId) !== m) return null
    }

    if (this.eventSink) {
      for (const [queuedRestoreId, captured] of pendingRestores) {
        const key = `${m.id}\0${queuedRestoreId}`
        if (this.emittedQueuedRestoreIds.has(key)) continue
        const messages = captured.filter(message => m.messages.some(current =>
          current.id === message.id && current.isQueued && current.queuedRestoreId === queuedRestoreId))
        if (messages.length === 0) continue
        this.sendEvent({
          type: 'interrupted',
          sessionId: m.id,
          queuedMessages: messages.map(message => message.content),
          ...(messages.some(message => message.references?.length)
            ? { queuedReferences: messages.flatMap(message => message.references ?? []) }
            : {}),
          ...(messages.some(message => message.attachments?.length)
            ? { queuedAttachments: messages.flatMap(message => message.attachments ?? []) }
            : {}),
          queuedRestoreId,
          queuedMessageIds: messages.map(message => message.id),
        }, m.workspace.id)
        this.emittedQueuedRestoreIds.add(key)
      }
    }

    return managedToSession(m, { messages: m.messages })
  }

  /**
   * Ensure messages are loaded for a managed session.
   * Uses promise deduplication to prevent race conditions when multiple
   * concurrent calls (e.g., rapid session switches + message send) try
   * to load messages simultaneously.
   */
  private async ensureMessagesLoaded(managed: ManagedSession): Promise<void> {
    if (managed.messagesLoaded) return

    // Deduplicate concurrent loads - return existing promise if already loading
    const existingPromise = this.messageLoadingPromises.get(managed.id)
    if (existingPromise) {
      return existingPromise
    }

    const loadPromise = this.loadMessagesFromDisk(managed)
    this.messageLoadingPromises.set(managed.id, loadPromise)

    try {
      await loadPromise
    } finally {
      this.messageLoadingPromises.delete(managed.id)
    }
  }

  /**
   * Internal: Load messages from disk storage into the managed session.
   */
  private async loadMessagesFromDisk(managed: ManagedSession): Promise<void> {
    const storedSession = loadStoredSession(managed.workspace.rootPath, managed.id)
    if (storedSession) {
      managed.messages = (storedSession.messages || []).map(storedToMessage)
      this.markUnacceptedInputForRestore(managed)
      managed.tokenUsage = storedSession.tokenUsage
      managed.pendingPlanExecution = this.reconcileStoredPendingPlanExecution(managed, storedSession)
      managed.lastReadMessageId = storedSession.lastReadMessageId
      managed.hasUnread = storedSession.hasUnread  // Explicit unread flag for NEW badge state machine
      managed.enabledSourceSlugs = storedSession.enabledSourceSlugs
      managed.sharedUrl = storedSession.sharedUrl
      managed.sharedId = storedSession.sharedId
      // Sync name from disk - ensures title persistence across lazy loading
      managed.name = storedSession.name
      // Restore LLM connection state - ensures correct provider on resume
      if (storedSession.llmConnection) {
        managed.llmConnection = storedSession.llmConnection
      }
      if (storedSession.connectionLocked) {
        managed.connectionLocked = storedSession.connectionLocked
      }
      // Sync transferred session summary state from disk
      managed.transferredSessionSummary = storedSession.transferredSessionSummary
      managed.transferredSessionSummaryApplied = storedSession.transferredSessionSummaryApplied
      sessionLog.debug(`Lazy-loaded ${managed.messages.length} messages for session ${managed.id}`)

      // Queue recovery: find orphaned queued messages from crash/restart and re-queue them
      const orphanedQueued = managed.messages.filter(m =>
        m.role === 'user' && m.isQueued === true && !m.queuedRestoreId
        && !(managed.pendingPlanExecution?.failed && m.id === managed.pendingPlanExecution.approvalMessageId)
      )
      if (orphanedQueued.length > 0) {
        sessionLog.info(`Recovering ${orphanedQueued.length} queued message(s) for session ${managed.id}`)
        for (const msg of orphanedQueued) {
          managed.messageQueue.push({
            message: msg.content,
            messageId: msg.id,
            attachments: undefined,  // Attachments already stored on disk
            storedAttachments: msg.attachments,
            options: msg.references?.length ? { references: msg.references } : undefined,
          })
        }
        // Process queue when session becomes active (will be triggered by first message or interaction)
        // Use setImmediate to avoid blocking the load and allow session state to settle
        if (!managed.isProcessing && managed.messageQueue.length > 0) {
          setImmediate(() => {
            this.processNextQueuedMessage(managed.id)
          })
        }
      }
    }
    managed.messagesLoaded = true
  }

  /**
   * Get the filesystem path to a session's folder
   */
  getSessionPath(sessionId: string): string | null {
    const managed = this.sessions.get(sessionId)
    if (!managed) return null
    return getSessionStoragePath(managed.workspace.rootPath, sessionId)
  }

  async createSession(
    workspaceId: string,
    options?: import('@craft-agent/shared/protocol').CreateSessionOptions,
    // Transport concern, deliberately NOT on the wire DTO: by default every created session is
    // announced to the renderer (see notifySessionCreated). Callers that register the session
    // themselves — the `sessions:create` RPC adds it from the return value — pass
    // `{ emitCreatedEvent: false }` to avoid a redundant hydrate.
    internal?: { emitCreatedEvent?: boolean; idempotencyClaimed?: boolean },
  ): Promise<Session> {
    const creationRequestId = options?.creationRequestId?.trim()
    if (creationRequestId && !internal?.idempotencyClaimed) {
      if (creationRequestId.length > 128) {
        throw new Error('Invalid Session creation request id')
      }
      const existing = Array.from(this.sessions.values()).find(session => (
        session.workspace.id === workspaceId
        && session.creationRequestId === creationRequestId
      ))
      if (existing) {
        if (options?.projectId && existing.projectId !== options.projectId) {
          throw new Error('SESSION_CREATE_REQUEST_CONFLICT: request id belongs to another Project')
        }
        return managedToSession(existing)
      }

      const key = `${workspaceId}\0${creationRequestId}`
      const pending = this.sessionCreationRequests.get(key)
      if (pending) {
        if (options?.projectId && pending.projectId !== options.projectId) {
          throw new Error('SESSION_CREATE_REQUEST_CONFLICT: request id belongs to another Project')
        }
        return pending.promise
      }
      const request = this.createSession(workspaceId, options, {
        ...internal,
        idempotencyClaimed: true,
      })
      this.sessionCreationRequests.set(key, {
        projectId: options?.projectId,
        promise: request,
      })
      try {
        return await request
      } finally {
        if (this.sessionCreationRequests.get(key)?.promise === request) {
          this.sessionCreationRequests.delete(key)
        }
      }
    }
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) {
      throw new Error(`Workspace ${workspaceId} not found`)
    }

    // Get new session defaults from workspace config (with global fallback)
    // Options.permissionMode overrides the workspace default (used by EditPopover for auto-execute)
    const workspaceRootPath = workspace.rootPath
    const wsConfig = loadWorkspaceConfig(workspaceRootPath)
    if (!wsConfig) {
      throw new Error(`Invalid workspace: ${workspaceId}`)
    }
    const globalDefaults = loadConfigDefaults()

    // Read permission mode from workspace config, fallback to global defaults
    // Callers may pass canonical names (`craft run --mode execute`); an unknown mode would
    // otherwise fall through to Explore's checks, so it is rejected.
    const requestedPermissionMode = options?.permissionMode ? parsePermissionMode(options.permissionMode) : undefined
    if (options?.permissionMode && !requestedPermissionMode) {
      throw new Error(`Invalid permission mode: ${String(options.permissionMode)}. Valid values: explore, ask, guarded, execute`)
    }
    const defaultPermissionMode = requestedPermissionMode
      ?? wsConfig?.defaults?.permissionMode
      ?? globalDefaults.workspaceDefaults.permissionMode

    const userDefaultWorkingDir = wsConfig?.defaults?.workingDirectory || undefined
    // Resolve thinking level with caller-first precedence, matching permissionMode above:
    //   caller override → workspace default → global default.
    // normalizeThinkingLevel() tolerates undefined/unknown inputs.
    const defaultThinkingLevel =
      normalizeThinkingLevel(options?.thinkingLevel)
      ?? normalizeThinkingLevel(wsConfig?.defaults?.thinkingLevel)
      ?? getDefaultThinkingLevel()
    // Get default model from workspace config (used when no session-specific model is set)
    const defaultModel = wsConfig?.defaults?.model
    // Get default enabled sources from workspace config
    const defaultEnabledSourceSlugs = options?.enabledSourceSlugs ?? wsConfig?.defaults?.enabledSourceSlugs

    // Resolve model tier hints ('fast' / 'default') to actual model IDs.
    // EditPopover uses tier hints instead of hardcoded Anthropic model names
    // so the right model is selected regardless of the active LLM provider.
    let resolvedModelOption = options?.model || defaultModel
    if (resolvedModelOption === 'fast' || resolvedModelOption === 'default') {
      const tierConnection = resolveSessionConnection(
        options?.llmConnection,
        wsConfig?.defaults?.defaultLlmConnection,
      )
      if (tierConnection) {
        resolvedModelOption = resolvedModelOption === 'fast'
          ? (getMiniModel(tierConnection) ?? tierConnection.defaultModel ?? defaultModel)
          : (tierConnection.defaultModel ?? defaultModel)
      } else {
        resolvedModelOption = defaultModel
      }
    }

    // Resolve backend target early for branching policy checks.
    const targetBackendContext = resolveBackendContext({
      sessionConnectionSlug: options?.llmConnection,
      workspaceDefaultConnectionSlug: wsConfig?.defaults?.defaultLlmConnection,
      managedModel: resolvedModelOption,
    })
    const targetProviderType = targetBackendContext.connection?.providerType
      ?? (targetBackendContext.provider === 'pi' ? 'pi' : 'anthropic')
    const targetPiAuthProvider = targetBackendContext.connection?.piAuthProvider

    // Resolve working directory from options:
    // - 'user_default' or undefined: Use workspace's configured default
    // - 'none': No working directory (empty string means session folder only)
    // - Absolute path: Use as-is
    let resolvedWorkingDir: string | undefined
    if (options?.workingDirectory === 'none') {
      resolvedWorkingDir = undefined  // No working directory
    } else if (options?.workingDirectory === 'user_default' || options?.workingDirectory === undefined) {
      resolvedWorkingDir = userDefaultWorkingDir
    } else {
      resolvedWorkingDir = options.workingDirectory
    }

    // Validate branch request up-front so branch metadata is only set for valid branches.
    // This prevents creating sessions that claim to be branched but don't have copied history.
    // A branch keeps its parent's coding mode: an SDK fork carries the parent's pinned system prompt.
    let branchSourceCodingMode: boolean | undefined
    let validatedBranch: {
      sourceSessionId: string
      sourceMessageId: string
      sourceSession: StoredSession
      branchIdx: number
      branchContextStrategy: 'sdk-fork' | 'seeded-fresh-session'
      branchFromSdkSessionId?: string
      branchFromSessionPath?: string
      branchFromSdkCwd?: string
      branchFromSdkTurnId?: string
      sourceProvider?: 'anthropic' | 'pi'
    } | undefined

    if (options?.branchFromSessionId || options?.branchFromMessageId) {
      if (!options.branchFromSessionId || !options.branchFromMessageId) {
        sessionLog.warn('Branch validation failed: missing branchFromSessionId or branchFromMessageId', {
          workspaceId,
          branchFromSessionId: options.branchFromSessionId,
          branchFromMessageId: options.branchFromMessageId,
        })
        throw new Error('Invalid branch request: both branchFromSessionId and branchFromMessageId are required')
      }

      const sourceManaged = this.sessions.get(options.branchFromSessionId)
      if (sourceManaged) {
        if (sourceManaged.workspace.rootPath !== workspaceRootPath) {
          sessionLog.warn('Branch validation failed: source session belongs to different workspace', {
            workspaceId,
            targetWorkspaceRootPath: workspaceRootPath,
            sourceWorkspaceRootPath: sourceManaged.workspace.rootPath,
            branchFromSessionId: options.branchFromSessionId,
          })
          throw new Error('Invalid branch request: source session belongs to a different workspace')
        }

        // Flush source session to disk to ensure latest message list is available for branch copy.
        this.persistSession(sourceManaged)
        await sessionPersistenceQueue.flush(sourceManaged.id)
      }

      const sourceSession = loadStoredSession(workspaceRootPath, options.branchFromSessionId)
      branchSourceCodingMode = sourceManaged?.codingMode ?? sourceSession?.codingMode
      if (!sourceSession) {
        sessionLog.warn('Branch validation failed: source session not found on disk', {
          workspaceId,
          branchFromSessionId: options.branchFromSessionId,
        })
        throw new Error(`Invalid branch request: source session ${options.branchFromSessionId} not found`)
      }

      const sourceBackendContext = resolveBackendContext({
        sessionConnectionSlug: sourceManaged?.llmConnection || sourceSession.llmConnection,
        workspaceDefaultConnectionSlug: wsConfig?.defaults?.defaultLlmConnection,
        managedModel: sourceManaged?.model || sourceSession.model,
      })
      const sourceProviderType = sourceBackendContext.connection?.providerType
        ?? (sourceBackendContext.provider === 'pi' ? 'pi' : 'anthropic')
      const sourcePiAuthProvider = sourceBackendContext.connection?.piAuthProvider

      const providerMismatch = sourceBackendContext.provider !== targetBackendContext.provider
      const providerTypeMismatch = sourceProviderType !== targetProviderType
      const piAuthProviderMismatch =
        sourceBackendContext.provider === 'pi' && sourcePiAuthProvider !== targetPiAuthProvider

      if (providerMismatch || providerTypeMismatch || piAuthProviderMismatch) {
        sessionLog.warn('Branch validation failed: source and target providers are incompatible', {
          workspaceId,
          branchFromSessionId: options.branchFromSessionId,
          sourceProvider: sourceBackendContext.provider,
          sourceProviderType,
          sourcePiAuthProvider,
          targetProvider: targetBackendContext.provider,
          targetProviderType,
          targetPiAuthProvider,
        })
        throw new Error('Branching is only supported within the same provider/backend. Switch this panel connection and try again.')
      }

      const branchIdx = sourceSession.messages.findIndex(m => m.id === options.branchFromMessageId)
      if (branchIdx === -1) {
        sessionLog.warn('Branch validation failed: message not found in source session', {
          workspaceId,
          branchFromSessionId: options.branchFromSessionId,
          branchFromMessageId: options.branchFromMessageId,
        })
        throw new Error(`Invalid branch request: message ${options.branchFromMessageId} not found in source session`)
      }

      // New branches always use strict provider-level SDK fork semantics.
      // Seeded mode remains only for legacy sessions created before strict fork was enforced.
      const branchContextStrategy: 'sdk-fork' | 'seeded-fresh-session' = 'sdk-fork'

      const branchFromSdkSessionId = branchContextStrategy === 'sdk-fork'
        ? (sourceManaged?.sdkSessionId || sourceSession.sdkSessionId)
        : undefined
      const branchFromSessionPath = branchContextStrategy === 'sdk-fork'
        ? getSessionStoragePath(workspaceRootPath, options.branchFromSessionId)
        : undefined
      // Capture parent's sdkCwd so the child SDK subprocess can find the parent's
      // session file (stored under ~/.claude/projects/{cwd-hash}/).
      const branchFromSdkCwd = branchContextStrategy === 'sdk-fork'
        ? (sourceManaged?.sdkCwd || sourceSession.sdkCwd)
        : undefined

      // Provider-native branch anchor at branch point.
      // - Claude: assistant message UUID (resumeSessionAt), but only when anchor lineage
      //   matches the parent SDK session being resumed.
      // - Pi: session entry ID loaded from sidecar (pi-turn-anchors.json)
      const branchMessage = sourceSession.messages[branchIdx]
      let branchFromSdkTurnId: string | undefined
      if (branchContextStrategy === 'sdk-fork') {
        if (sourceBackendContext.provider === 'pi') {
          if (branchFromSessionPath) {
            branchFromSdkTurnId = await getPiTurnAnchor(branchFromSessionPath, options.branchFromMessageId)
            if (!branchFromSdkTurnId) {
              sessionLog.info('Pi branch anchor missing: requiring exact legacy SDK message match', {
                workspaceId,
                branchFromSessionId: options.branchFromSessionId,
                branchFromMessageId: options.branchFromMessageId,
              })
            }
          }
        } else if (sourceBackendContext.provider === 'anthropic') {
          if (branchFromSessionPath && branchFromSdkSessionId) {
            const anchor = await getClaudeTurnAnchor(branchFromSessionPath, options.branchFromMessageId)
            if (!anchor) {
              sessionLog.warn('Claude branch anchor missing: falling back to full-history fork for this branch', {
                workspaceId,
                branchFromSessionId: options.branchFromSessionId,
                branchFromMessageId: options.branchFromMessageId,
              })
            } else if (!anchor.sdkMessageUuid || !isClaudeMessageUuid(anchor.sdkMessageUuid)) {
              sessionLog.warn('Claude branch anchor malformed: falling back to full-history fork for this branch', {
                workspaceId,
                branchFromSessionId: options.branchFromSessionId,
                branchFromMessageId: options.branchFromMessageId,
                anchorSdkSessionId: anchor.sdkSessionId,
              })
            } else if (anchor.sdkSessionId !== branchFromSdkSessionId) {
              sessionLog.warn('Claude branch anchor lineage mismatch: falling back to full-history fork for this branch', {
                workspaceId,
                branchFromSessionId: options.branchFromSessionId,
                branchFromMessageId: options.branchFromMessageId,
                anchorSdkSessionId: anchor.sdkSessionId,
                parentSdkSessionId: branchFromSdkSessionId,
              })
            } else {
              branchFromSdkTurnId = anchor.sdkMessageUuid
            }
          }
        } else {
          branchFromSdkTurnId = branchMessage?.turnId
        }
      }

      if (branchContextStrategy === 'sdk-fork' && !branchFromSdkSessionId) {
        sessionLog.warn('Branch validation failed: sdk-fork requires parent SDK session ID', {
          workspaceId,
          branchFromSessionId: options.branchFromSessionId,
          sourceProvider: sourceBackendContext.provider,
          targetProvider: targetBackendContext.provider,
        })
        throw new Error('Cannot create branch yet: parent session SDK context is not initialized. Send one message in the parent session and try again.')
      }

      validatedBranch = {
        sourceSessionId: options.branchFromSessionId,
        sourceMessageId: options.branchFromMessageId,
        sourceSession,
        branchIdx,
        branchContextStrategy,
        branchFromSdkSessionId,
        branchFromSessionPath,
        branchFromSdkCwd,
        branchFromSdkTurnId,
        sourceProvider: sourceBackendContext.provider,
      }

      sessionLog.info('Branch validation succeeded', {
        workspaceId,
        branchFromSessionId: validatedBranch.sourceSessionId,
        branchFromMessageId: validatedBranch.sourceMessageId,
        branchContextStrategy: validatedBranch.branchContextStrategy,
        branchFromSdkSessionId: !!validatedBranch.branchFromSdkSessionId,
        copiedMessageCount: validatedBranch.branchIdx + 1,
      })
    }

    let parentProjectId: string | undefined
    if (options?.parentSessionId) {
      const parentManaged = this.sessions.get(options.parentSessionId)
      if (parentManaged && parentManaged.workspace.rootPath !== workspaceRootPath) {
        throw new Error('Invalid parent session: parent belongs to a different workspace')
      }
      const parent = parentManaged ?? loadStoredSession(workspaceRootPath, options.parentSessionId)
      if (!parent?.projectId) {
        throw new Error(`Invalid parent session: ${options.parentSessionId} not found`)
      }
      parentProjectId = parent.projectId
    }

    const branchProjectId = validatedBranch?.sourceSession.projectId
    if (parentProjectId && branchProjectId && parentProjectId !== branchProjectId) {
      throw new Error('CROSS_PROJECT_SESSION: branch source and parent belong to different Projects')
    }
    const inheritedProjectId = branchProjectId ?? parentProjectId
    if (options?.projectId && inheritedProjectId && options.projectId !== inheritedProjectId) {
      throw new Error('CROSS_PROJECT_SESSION: child Session must inherit its source Project')
    }

    const resolvedProjectId = options?.projectId ?? inheritedProjectId ?? wsConfig.defaultProjectId
    const { loadProjectById } = await import('@craft-agent/shared/projects')
    const project = loadProjectById(workspaceRootPath, resolvedProjectId)
    if (!project) {
      throw new Error(`Project ${resolvedProjectId} not found in workspace ${workspaceId}`)
    }
    if (
      (options?.workingDirectory === undefined || options?.workingDirectory === 'user_default') &&
      project.config.workingDirectory
    ) {
      resolvedWorkingDir = project.config.workingDirectory
    }

    // Use storage layer to create and persist the session
    const storedSession = await createStoredSession(workspaceRootPath, {
      creationRequestId,
      name: options?.name,
      permissionMode: defaultPermissionMode,
      workingDirectory: resolvedWorkingDir,
      hidden: options?.hidden,
      sessionStatus: options?.sessionStatus,
      // Automations, spawn_session and task flows hand in labels unvalidated: store them canonical
      labels: this.canonicalLabels(workspaceRootPath, options?.labels),
      isFlagged: options?.isFlagged,
      projectId: resolvedProjectId,
      parentSessionId: options?.parentSessionId,
      taskSlug: options?.taskSlug,
      taskRunId: options?.taskRunId,
      taskNodeId: options?.taskNodeId,
      taskDraft: options?.taskDraft,
      // Persist only an EXPLICIT selection (e.g. a task's spec.sources on its subtasks).
      // The workspace-default fallback stays dynamic — freezing it into the header would
      // pin every ordinary session to the defaults as of its creation time.
      enabledSourceSlugs: options?.enabledSourceSlugs,
    })

    // Branch: copy messages from source session up to and including the branch point
    if (validatedBranch) {
      const branchedStored = loadStoredSession(workspaceRootPath, storedSession.id)
      if (!branchedStored) {
        throw new Error(`Failed to load newly created session ${storedSession.id} for branch copy`)
      }

      const sourceMessages = validatedBranch.sourceSession.messages.slice(0, validatedBranch.branchIdx + 1)

      const sourceDir = normalizePath(getSessionStoragePath(workspaceRootPath, validatedBranch.sourceSessionId))
      const branchDir = normalizePath(getSessionStoragePath(workspaceRootPath, storedSession.id))
      try {
        let sourceRealDir: string | undefined
        branchedStored.messages = []
        for (const message of sourceMessages) {
          // Text, tool arguments and references describe the original event.
          // Relocate only owned files; replacing paths throughout JSON changes quotes.
          const copied: StoredMessage = { ...message }
          if (message.type === 'plan' && !copied.toolUseId) {
            copied.toolUseId = branchedStored.messages.slice().reverse().find(previous =>
              previous.type === 'tool' && previous.toolName?.includes('SubmitPlan'))?.toolUseId
          }
          if (message.planPath?.startsWith(`${sourceDir}/`)) {
            const planRelative = relative(sourceDir, message.planPath)
            if (planRelative === '..' || planRelative.startsWith(`..${sep}`) || isAbsolute(planRelative)) {
              throw new Error('Invalid branch plan path')
            }
            copied.planPath = join(branchDir, planRelative)
            await mkdir(dirname(copied.planPath), { recursive: true })
            // The card's captured plan is authoritative, including legacy cards
            // whose old branch lost the file or whose source file later changed.
            await writeFile(copied.planPath, message.content, 'utf-8')
          }
          if (message.attachments) {
            copied.attachments = []
            for (const attachment of message.attachments) {
              const copiedAttachment = { ...attachment }
              for (const key of ['storedPath', 'thumbnailPath', 'markdownPath'] as const) {
                const sourcePath = attachment[key]
                if (!sourcePath?.startsWith(`${sourceDir}/`)) continue
                const attachmentRelative = relative(sourceDir, sourcePath)
                if (attachmentRelative === '..' || attachmentRelative.startsWith(`..${sep}`) || isAbsolute(attachmentRelative)) {
                  throw new Error('Invalid branch attachment path')
                }
                let sourceRealPath: string
                try {
                  sourceRealPath = await realpath(sourcePath)
                } catch (error) {
                  // Derived previews can expire independently of the attachment.
                  if (key !== 'storedPath' && (error as NodeJS.ErrnoException).code === 'ENOENT') {
                    delete copiedAttachment[key]
                    continue
                  }
                  throw error
                }
                const ownedRelative = relative(sourceRealDir ??= await realpath(sourceDir), sourceRealPath)
                if (ownedRelative === '..' || ownedRelative.startsWith(`..${sep}`) || isAbsolute(ownedRelative)) {
                  throw new Error('Invalid branch attachment path')
                }
                const destination = join(branchDir, attachmentRelative)
                await mkdir(dirname(destination), { recursive: true })
                await copyFile(sourcePath, destination)
                copiedAttachment[key] = destination
              }
              copied.attachments.push(copiedAttachment)
            }
          }
          branchedStored.messages.push(copied)
        }
      } catch (error) {
        // No runtime session has been registered yet. Remove only this new child.
        deleteStoredSession(workspaceRootPath, storedSession.id)
        throw new Error(`Could not copy branch history: ${error instanceof Error ? error.message : String(error)}`)
      }

      branchedStored.branchFromMessageId = validatedBranch.sourceMessageId
      if (validatedBranch.branchContextStrategy === 'sdk-fork') {
        branchedStored.branchFromSdkSessionId = validatedBranch.branchFromSdkSessionId
        branchedStored.branchFromSessionPath = validatedBranch.branchFromSessionPath
        branchedStored.branchFromSdkCwd = validatedBranch.branchFromSdkCwd
        branchedStored.branchFromSdkTurnId = validatedBranch.branchFromSdkTurnId
      } else {
        delete branchedStored.branchFromSdkSessionId
        delete branchedStored.branchFromSessionPath
        delete branchedStored.branchFromSdkCwd
        delete branchedStored.branchFromSdkTurnId
      }
      await saveStoredSession(branchedStored)

      // Propagate the Pi turn-anchor sidecar into the branch so a downstream
      // branch can still resolve anchors for messages copied here from the
      // source. Without this step, branch-of-branch silently falls back to
      // full-history fork — see craft-agents-oss#782.
      if (
        validatedBranch.branchContextStrategy === 'sdk-fork' &&
        validatedBranch.sourceProvider === 'pi'
      ) {
        try {
          await copyPiTurnAnchorsForBranch(
            sourceDir,
            branchDir,
            branchedStored.messages.map((m) => m.id),
          )
        } catch (err) {
          sessionLog.warn('Failed to copy Pi turn-anchors sidecar to branch', {
            err,
            sourceSessionId: validatedBranch.sourceSessionId,
            branchSessionId: storedSession.id,
          })
        }
      }
    }

    // Resolve connection/provider/auth/model using the provider-agnostic backend resolver.
    // Reuse precomputed target context so branch validation and session construction share the same target identity.
    const resolvedContext = targetBackendContext
    const resolvedModel = resolvedContext.resolvedModel

    // Log mini agent session creation
    if (options?.systemPromptPreset === 'mini' || options?.model) {
      sessionLog.info(`🤖 Creating mini agent session: model=${resolvedModel}, systemPromptPreset=${options?.systemPromptPreset}`)
    }

    const isBranch = !!validatedBranch

    const managed = createManagedSession(storedSession, workspace, {
      permissionMode: defaultPermissionMode,
      workingDirectory: resolvedWorkingDir,
      model: resolvedModel,
      llmConnection: options?.llmConnection,
      thinkingLevel: defaultThinkingLevel,
      // Coding mode: branch source → caller → workspace default. Stored only when on, so default sessions stay unchanged.
      codingMode: (validatedBranch ? branchSourceCodingMode : options?.codingMode ?? wsConfig?.defaults?.codingMode) || undefined,
      systemPromptPreset: options?.systemPromptPreset,
      enabledSourceSlugs: defaultEnabledSourceSlugs,
      branchFromMessageId: validatedBranch?.sourceMessageId,
      branchContextStrategy: validatedBranch?.branchContextStrategy,
      branchFromSdkSessionId: validatedBranch?.branchFromSdkSessionId,
      branchFromSessionPath: validatedBranch?.branchFromSessionPath,
      branchFromSdkCwd: validatedBranch?.branchFromSdkCwd,
      branchFromSdkTurnId: validatedBranch?.branchFromSdkTurnId,
      branchSeedApplied: validatedBranch ? validatedBranch.branchContextStrategy === 'sdk-fork' : undefined,
      messagesLoaded: !isBranch,  // Branched sessions: lazy-load messages from JSONL
    })
    if (options?.unattended) managed.unattended = true

    // Eagerly load messages for branched sessions so the renderer gets the full
    // conversation immediately (needed for scroll-to-bottom on panel open)
    if (isBranch) {
      await this.ensureMessagesLoaded(managed)

      const requiresBranchPreflight = managed.branchContextStrategy === 'sdk-fork'
      if (requiresBranchPreflight) {
        // Enforce branch correctness at creation time.
        // A branch is only valid if backend context can be established now,
        // not deferred to the first user message.
        try {
          await this.getOrCreateAgent(managed)
          await managed.agent!.ensureBranchReady()
        } catch (error) {
          sessionLog.warn('Branch creation failed during backend preflight handshake', {
            workspaceId,
            sessionId: storedSession.id,
            branchFromSessionId: validatedBranch?.sourceSessionId,
            branchFromMessageId: validatedBranch?.sourceMessageId,
            branchContextStrategy: managed.branchContextStrategy,
            error: error instanceof Error ? error.message : String(error),
          })

          await rollbackFailedBranchCreation({
            managed,
            workspaceRootPath,
            sessionId: storedSession.id,
            deleteFromRuntimeSessions: (id) => {
              const m = this.sessions.get(id)
              if (m?.autoRetryTimer) {
                clearTimeout(m.autoRetryTimer)
                m.autoRetryTimer = undefined
              }
              if (m) m.autoRetryPending = undefined
              this.sessions.delete(id)
            },
            deleteStoredSession,
          })

          throw new Error(
            `Could not create branch: ${error instanceof Error ? error.message : String(error)}`
          )
        }
      }
    }

    // Initialize mode-manager state immediately to avoid UI/enforcement races
    // before the agent instance is lazily created.
    setPermissionMode(storedSession.id, managed.permissionMode ?? 'ask', { changedBy: 'restore' })
    if (managed.previousPermissionMode) {
      hydratePreviousPermissionMode(storedSession.id, managed.previousPermissionMode)
    }

    this.sessions.set(storedSession.id, managed)

    // Initialize session metadata in AutomationSystem for diffing
    const automationSystem = this.automationSystems.get(workspaceRootPath)
    if (automationSystem) {
      automationSystem.setInitialSessionMetadata(storedSession.id, {
        permissionMode: storedSession.permissionMode,
        labels: storedSession.labels,
        isFlagged: storedSession.isFlagged,
        sessionStatus: storedSession.sessionStatus,
        sessionName: managed.name,
      })
    }

    // Reserved "Task" label: task flows opt in so the tile (and its subtasks, which inherit the
    // parent's number) are filterable as tasks from the moment they exist. Applied before the
    // created-event so the renderer hydrates the label with the rest of the metadata. Fail-soft:
    // a label problem must never abort session creation.
    if (options?.applyTaskLabel) {
      try {
        await this.applyTaskLabel(storedSession.id, { parentSessionId: options?.parentSessionId })
      } catch (error) {
        sessionLog.warn('Failed to apply Task label to new session', {
          sessionId: storedSession.id,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }

    // Announce by default so the renderer hydrates full metadata (name, parentSessionId, …)
    // instead of fabricating a titleless "New Chat" from the first streamed event. Emitted at
    // the very end so a thrown branch-preflight failure above never announces an orphan.
    if (internal?.emitCreatedEvent !== false) {
      this.notifySessionCreated(workspaceId, storedSession.id, storedSession.projectId)
    }

    return managedToSession(managed, isBranch ? { messages: managed.messages } : undefined)
  }

  /**
   * Announce a session to the renderer so it hydrates full metadata (name, parentSessionId, …)
   * instead of fabricating a "New Chat" placeholder from the first streamed event.
   *
   * `createSession` calls this by default, so server-side creators get it for free. Use it
   * directly only for sessions built outside `createSession` (e.g. the SessionBundle import
   * path, which assembles a ManagedSession by hand). The renderer handler is idempotent.
   */
  notifySessionCreated(workspaceId: string, sessionId: string, projectId: string): void {
    this.sendEvent({ type: 'session_created', sessionId, projectId }, workspaceId)
  }

  /** Resolved working directory of a live session (used by the Tasks Conductor so child
   *  sessions inherit the orchestrator's cwd). Undefined if the session has none or is unknown. */
  getSessionWorkingDirectory(sessionId: string): string | undefined {
    return this.sessions.get(sessionId)?.workingDirectory
  }

  private async disposeManagedAgentRuntime(managed: ManagedSession, reason: string): Promise<void> {
    const sessionId = managed.id
    this.recoverPendingSteers(managed)

    if (managed.agent) {
      try {
        if (managed.agent.disposeForRestart) {
          await managed.agent.disposeForRestart()
        } else {
          managed.agent.dispose()
        }
      } catch (error) {
        sessionLog.warn(`Failed to dispose agent for ${sessionId} during ${reason}: ${error instanceof Error ? error.message : error}`)
      }
    }

    if (managed.poolServer) {
      try {
        await managed.poolServer.stop()
      } catch (error) {
        sessionLog.warn(`Failed to stop pool server for ${sessionId} during ${reason}: ${error instanceof Error ? error.message : error}`)
      }
    }

    if (managed.mcpPool) {
      try {
        await managed.mcpPool.disconnectAll()
      } catch (error) {
        sessionLog.warn(`Failed to disconnect MCP pool for ${sessionId} during ${reason}: ${error instanceof Error ? error.message : error}`)
      }
    }

    managed.agent = null
    managed.poolServer = undefined
    managed.mcpPool = undefined
    managed.envOverrides = undefined
    managed.agentReady = undefined
    managed.agentReadyResolve = undefined
    managed.backendRuntimeSignature = undefined
    managed.backendRuntimeContext = undefined
    managed.backendRestartSignature = undefined
    unregisterSessionScopedToolCallbacks(sessionId)
  }

  /**
   * Refresh an existing agent's runtime config in place when the session's
   * resolved connection signature has drifted from what the agent was created
   * with. No-ops when the agent doesn't exist, when the signature still
   * matches, or when the agent is mid-stream (the gate is `agent.isProcessing()`
   * — `managed.isProcessing` is not used because `sendMessage` flips it before
   * calling `getOrCreateAgent`, which would make every send-path refresh dead
   * code).
   *
   * Concurrency: per-session serialization via `agentRefreshLocks`. A second
   * caller (e.g. `sendMessage` arriving mid-`SAVE`-refresh) awaits the
   * in-flight refresh, then re-evaluates from the post-refresh state — so the
   * subsequent `agent.chat()` is sent only after the subprocess has applied
   * the runtime update (or the agent has been disposed for recreation).
   *
   * The helper distinguishes two kinds of drift:
   *   - Restart-required (provider/auth/slug/piAuthProvider): goes straight
   *     to dispose + recreate because `update_runtime_config` cannot fully
   *     re-route credential/provider state in a live subprocess.
   *   - In-place safe (model/baseUrl/customEndpoint/customModels): attempts
   *     `agent.updateRuntimeConfig` and falls back to dispose if the backend
   *     can't apply the update.
   */
  private async tryRefreshAgentRuntime(managed: ManagedSession, reason: string): Promise<void> {
    // Serialize against any in-flight refresh on this session. The waiter
    // doesn't propagate the prior call's errors — those are logged at the
    // origin call site.
    const inflight = this.agentRefreshLocks.get(managed.id)
    if (inflight) {
      await inflight.catch(() => undefined)
    }

    if (!managed.agent) return

    const workspaceConfig = loadWorkspaceConfig(managed.workspace.rootPath)
    const backendContext = resolveBackendContext({
      sessionConnectionSlug: managed.llmConnection,
      workspaceDefaultConnectionSlug: workspaceConfig?.defaults?.defaultLlmConnection,
      managedModel: managed.model,
    })
    const connection = backendContext.connection
    const sigInput = {
      connection,
      provider: backendContext.provider,
      authType: backendContext.authType,
      resolvedModel: backendContext.resolvedModel,
    }
    const runtimeSignature = buildBackendRuntimeSignature(sigInput)
    const restartSignature = buildRestartRequiredSignature(sigInput)

    if (!managed.backendRuntimeSignature || !managed.backendRestartSignature) {
      managed.backendRuntimeSignature = runtimeSignature
      managed.backendRestartSignature = restartSignature
      managed.backendRuntimeContext = backendContext
      return
    }

    const restartRequired = managed.backendRestartSignature !== restartSignature
    const runtimeChanged = managed.backendRuntimeSignature !== runtimeSignature

    if (!restartRequired && !runtimeChanged) return

    // Host turn ownership begins before backend chat (source setup/decision IO).
    // External SAVE defers; the send path refreshes before selecting its runtime.
    if (managed.agent.isProcessing() || managed.isProcessing && reason !== 'send-path refresh') {
      sessionLog.info(`Runtime config changed for ${managed.id}; deferring refresh until session is idle (${reason})`)
      return
    }

    const work = this.runAgentRuntimeRefresh(
      managed,
      backendContext,
      runtimeSignature,
      restartSignature,
      restartRequired,
      reason,
    )
    // Track the work so concurrent callers serialize. Swallow errors on the
    // tracked promise — the awaiter shouldn't get someone else's exception;
    // errors are logged inside `runAgentRuntimeRefresh`.
    const tracked = work.then(() => undefined, () => undefined)
    this.agentRefreshLocks.set(managed.id, tracked)
    try {
      await work
    } finally {
      // Concurrent callers awaited `tracked` before reaching this point and
      // each registered their own work serially, so the slot is always ours
      // to clear when our own work resolves.
      if (this.agentRefreshLocks.get(managed.id) === tracked) {
        this.agentRefreshLocks.delete(managed.id)
      }
    }
  }

  private async runAgentRuntimeRefresh(
    managed: ManagedSession,
    backendContext: ReturnType<typeof resolveBackendContext>,
    runtimeSignature: string,
    restartSignature: string,
    restartRequired: boolean,
    reason: string,
  ): Promise<void> {
    if (restartRequired) {
      sessionLog.info(`Restart-required field changed for session ${managed.id}; recreating backend runtime (${reason})`)
      await this.disposeManagedAgentRuntime(managed, 'restart-required runtime change')
      return
    }

    const connection = backendContext.connection
    let refreshed = false
    if (managed.agent?.updateRuntimeConfig) {
      try {
        refreshed = await managed.agent.updateRuntimeConfig({
          model: backendContext.resolvedModel,
          providerType: connection?.providerType,
          authType: backendContext.authType,
          runtime: connection ? {
            baseUrl: connection.baseUrl,
            piAuthProvider: connection.piAuthProvider,
            customEndpoint: connection.customEndpoint,
            customModels: connection.models?.map(model => {
              if (typeof model === 'string') return model
              const supportsImages = typeof model.supportsImages === 'boolean' ? model.supportsImages : undefined
              if (model.contextWindow || supportsImages !== undefined) {
                return {
                  id: model.id,
                  ...(model.contextWindow ? { contextWindow: model.contextWindow } : {}),
                  ...(supportsImages !== undefined ? { supportsImages } : {}),
                }
              }
              return model.id
            }),
          } : undefined,
        })
      } catch (error) {
        sessionLog.warn(`Runtime config in-place refresh failed for ${managed.id}: ${error instanceof Error ? error.message : error}`)
      }
    }

    if (refreshed) {
      managed.backendRuntimeSignature = runtimeSignature
      managed.backendRestartSignature = restartSignature
      managed.backendRuntimeContext = backendContext
      sessionLog.info(`Refreshed runtime config for session ${managed.id} (${reason})`)
    } else {
      sessionLog.info(`Recreating backend runtime for session ${managed.id} after config change (${reason})`)
      await this.disposeManagedAgentRuntime(managed, 'runtime config refresh')
    }
  }

  /**
   * Push a connection's runtime updates (e.g. `supportsImages` toggle) to every
   * active session that uses it. Called from the `llmConnections.SAVE` handler
   * so capability changes reach live Pi subprocesses immediately instead of
   * waiting for the next send to lazily notice the signature drift.
   */
  async refreshConnectionRuntime(connectionSlug: string): Promise<void> {
    for (const managed of this.sessions.values()) {
      if (managed.llmConnection !== connectionSlug) continue
      try {
        await this.tryRefreshAgentRuntime(managed, 'connection update')
      } catch (error) {
        sessionLog.warn(`refreshConnectionRuntime failed for ${managed.id}: ${error instanceof Error ? error.message : error}`)
      }
    }
  }

  /**
   * Get or create agent for a session (lazy loading)
   * Creates the appropriate backend agent based on LLM connection.
   *
   * Provider resolution order:
   * 1. session.llmConnection (locked after first message)
   * 2. workspace.defaults.defaultLlmConnection
   * 3. global defaultLlmConnection
   * 4. fallback: no connection configured
   */
  private async getOrCreateAgent(managed: ManagedSession): Promise<AgentInstance> {
    // Refresh runtime config in-place when the connection has drifted since
    // the agent was created. May null out `managed.agent` if the in-place
    // refresh fails, in which case the create branch below rebuilds it.
    await this.tryRefreshAgentRuntime(managed, 'send-path refresh')

    const workspaceConfig = loadWorkspaceConfig(managed.workspace.rootPath)
    const backendContext = resolveBackendContext({
      sessionConnectionSlug: managed.llmConnection,
      workspaceDefaultConnectionSlug: workspaceConfig?.defaults?.defaultLlmConnection,
      managedModel: managed.model,
    })
    const connection = backendContext.connection
    const sigInput = {
      connection,
      provider: backendContext.provider,
      authType: backendContext.authType,
      resolvedModel: backendContext.resolvedModel,
    }
    const runtimeSignature = buildBackendRuntimeSignature(sigInput)
    const restartSignature = buildRestartRequiredSignature(sigInput)

    if (!managed.agent) {
      const end = perf.start('agent.create', { sessionId: managed.id })

      // Lock the connection after first resolution
      // This ensures the session always uses the same provider
      if (connection && !managed.connectionLocked) {
        managed.llmConnection = connection.slug
        managed.connectionLocked = true
        sessionLog.info(`Locked session ${managed.id} to connection "${connection.slug}"`)
        this.persistSession(managed)

        // Keep renderer session capabilities in sync when auto-locking the connection.
        this.sendEvent({
          type: 'connection_changed',
          sessionId: managed.id,
          connectionSlug: connection.slug,
          supportsBranching: resolveSupportsBranching(managed),
        }, managed.workspace.id)
      }

      const provider = backendContext.provider
      if (connection) {
        sessionLog.info(`Using LLM connection "${connection.slug}" (${connection.providerType}) for session ${managed.id}`)
      } else {
        sessionLog.warn(`No LLM connection found for session ${managed.id}, using default anthropic provider`)
      }

      // Set session directory for tool metadata cross-process sharing.
      // The SDK subprocess reads CRAFT_SESSION_DIR to write tool-metadata.json;
      // the main process reads it via toolMetadataStore.setSessionDir().
      const sessionDirForMetadata = getSessionStoragePath(managed.workspace.rootPath, managed.id)
      process.env.CRAFT_SESSION_DIR = sessionDirForMetadata
      toolMetadataStore.setSessionDir(sessionDirForMetadata)

      // Set up agentReady promise so title generation can await agent creation
      managed.agentReady = new Promise<void>(r => { managed.agentReadyResolve = r })

      // ============================================================
      // Common setup: sources, MCP pool, session config
      // ============================================================

      const sessionPath = getSessionStoragePath(managed.workspace.rootPath, managed.id)
      const enabledSlugs = managed.enabledSourceSlugs || []
      const allSources = loadAllSources(managed.workspace.rootPath)
      const enabledSources = allSources.filter(s =>
        enabledSlugs.includes(s.config.slug) && isSourceUsable(s)
      )

      // Build server configs for enabled sources
      const { mcpServers, apiServers } = await buildServersFromSources(enabledSources, sessionPath, managed.tokenRefreshManager)

      // Create centralized MCP client pool (all backends use it)
      managed.mcpPool = new McpClientPool({ debug: (msg) => sessionLog.debug(msg), workspaceRootPath: managed.workspace.rootPath, sessionPath })

      // Backends that run as external subprocesses need an HTTP pool server
      let poolServerUrl: string | undefined
      if (backendContext.capabilities.needsHttpPoolServer) {
        managed.poolServer = new McpPoolServer(managed.mcpPool, { debug: (msg) => sessionLog.debug(msg) })
        managed.mcpPool.onToolsChanged = () => managed.poolServer?.notifyToolsChanged()
        poolServerUrl = await managed.poolServer.start()
        await managed.mcpPool.sync(mcpServers) // Ensure pool has tools before SDK connects
      }

      // Per-session env overrides
      const miniModel = connection ? (getMiniModel(connection) ?? connection.defaultModel) : undefined
      const envOverrides: Record<string, string> = {
        CRAFT_WORKSPACE_PATH: managed.workspace.rootPath,
        // Pass mini model to SDK subprocess so built-in tools like WebFetch
        // use the correct model for summarization (instead of hardcoded Haiku)
        ...(miniModel ? { ANTHROPIC_DEFAULT_HAIKU_MODEL: miniModel } : {}),
      }
      managed.envOverrides = envOverrides

      // ============================================================
      // Common session + callback config (identical for all backends)
      // ============================================================

      const sessionConfig = {
        id: managed.id,
        workspaceRootPath: managed.workspace.rootPath,
        sdkSessionId: managed.sdkSessionId,
        branchFromSdkSessionId: managed.branchContextStrategy === 'sdk-fork' ? managed.branchFromSdkSessionId : undefined,
        branchFromSessionPath: managed.branchContextStrategy === 'sdk-fork' ? managed.branchFromSessionPath : undefined,
        branchFromSdkCwd: managed.branchContextStrategy === 'sdk-fork' ? managed.branchFromSdkCwd : undefined,
        branchFromSdkTurnId: managed.branchContextStrategy === 'sdk-fork' ? managed.branchFromSdkTurnId : undefined,
        branchFromMessageId: managed.branchFromMessageId,
        createdAt: managed.lastMessageAt,
        lastUsedAt: managed.lastMessageAt,
        workingDirectory: managed.workingDirectory,
        sdkCwd: managed.sdkCwd,
        model: managed.model,
        llmConnection: managed.llmConnection,
        permissionMode: managed.permissionMode,
        previousPermissionMode: managed.previousPermissionMode,
        projectId: managed.projectId,
      }

      const onSdkSessionIdUpdate = (sdkSessionId: string) => {
        managed.sdkSessionId = sdkSessionId
        // Retire branch-only fork metadata now that child session is established
        if (managed.branchFromSdkSessionId) {
          sessionLog.info(`Branch fork established for ${managed.id}: child=${sdkSessionId}, retiring parent fork metadata (parent=${managed.branchFromSdkSessionId})`)
          const startTotals = branchStartTotals(this.branchParent(managed), managed.branchFromSdkSessionId)
          if (startTotals) managed.tokenUsage = { ...(managed.tokenUsage ?? DEFAULT_TOKEN_USAGE), lastRunningTotals: startTotals }
          managed.branchFromSdkSessionId = undefined
          managed.branchFromSdkCwd = undefined
          managed.branchFromSdkTurnId = undefined
        } else {
          sessionLog.info(`SDK session ID captured for ${managed.id}: ${sdkSessionId}`)
        }
        this.persistSession(managed)
        sessionPersistenceQueue.flush(managed.id)
      }

      const onSdkSessionIdCleared = () => {
        managed.sdkSessionId = undefined
        sessionLog.info(`SDK session ID cleared for ${managed.id} (resume recovery)`)
        this.persistSession(managed)
        sessionPersistenceQueue.flush(managed.id)
      }

      const onBranchForkInvalidated = () => {
        managed.sdkSessionId = undefined
        managed.branchFromSdkSessionId = undefined
        managed.branchFromSdkCwd = undefined
        managed.branchFromSdkTurnId = undefined
        sessionLog.info(`Branch fork invalidated for ${managed.id}: cleared all fork metadata`)
        this.persistSession(managed)
        sessionPersistenceQueue.flush(managed.id)
      }

      const getRecoveryMessages = () => {
        return buildRecoveryMessages(managed.messages, 6)
      }

      const getBranchFallbackMessages = () => {
        if (!managed.branchFromMessageId) return []
        return buildRecoveryMessages(managed.messages)
      }

      const getBranchSeedMessages = () => {
        if (managed.branchContextStrategy !== 'seeded-fresh-session') return []
        if (managed.branchSeedApplied) return []

        return buildRecoveryMessages(managed.messages)
      }

      const markBranchSeedApplied = () => {
        if (managed.branchContextStrategy !== 'seeded-fresh-session') return
        if (managed.branchSeedApplied) return
        managed.branchSeedApplied = true
        sessionLog.info('Branch seed context applied', {
          sessionId: managed.id,
          strategy: managed.branchContextStrategy,
        })
      }

      const getTransferredSessionSummary = () => {
        const summary = managed.transferredSessionSummaryApplied ? null : (managed.transferredSessionSummary ?? null)
        sessionLog.info(`[transfer-context] getTransferredSessionSummary for ${managed.id}: applied=${managed.transferredSessionSummaryApplied}, has_summary=${!!managed.transferredSessionSummary}, returning=${summary ? `${summary.length} chars` : 'null'}`)
        return summary
      }

      const markTransferredSessionSummaryApplied = () => {
        if (managed.transferredSessionSummaryApplied || !managed.transferredSessionSummary) return
        managed.transferredSessionSummaryApplied = true
        this.persistSession(managed)
        sessionLog.info('Transferred session summary applied', {
          sessionId: managed.id,
        })
      }

      // ============================================================
      // Construct backend via factory
      // ============================================================

      managed.agent = createBackendFromResolvedContext({
        context: backendContext,
        hostRuntime: buildBackendHostRuntimeContext(),
        coreConfig: {
        workspace: managed.workspace,
        miniModel,
        thinkingLevel: managed.thinkingLevel,
        session: sessionConfig,
        onSdkSessionIdUpdate,
        onSdkSessionIdCleared,
        onBranchForkInvalidated,
        getRecoveryMessages,
        getBranchFallbackMessages,
        getBranchSeedMessages,
        markBranchSeedApplied,
        getTransferredSessionSummary,
        markTransferredSessionSummaryApplied,
        mcpPool: managed.mcpPool,
        poolServerUrl,
        envOverrides,
        // Claude-specific
        isHeadless: !AGENT_FLAGS.defaultModesEnabled,
        skipConfigWatcher: true, // Server owns workspace-level ConfigWatcher — don't duplicate in agents
        automationSystem: this.automationSystems.get(managed.workspace.rootPath),
        systemPromptPreset: managed.systemPromptPreset,
        agentProfile: managed.codingMode ? 'coding' : undefined,
        debugMode: _platform?.isDebugMode ? { enabled: true, logFilePath: _platform.getLogFilePath?.() } : undefined,
        enable1MContext: await (async () => { const { getEnable1MContext } = await import('@craft-agent/shared/config/storage'); return getEnable1MContext(); })(),
        autoCompactWindow: await (async () => { const { getAutoCompactWindow } = await import('@craft-agent/shared/config/storage'); return getAutoCompactWindow(); })(),
        // Image resize callback — prevents oversized images from entering conversation history
        onImageResize: async (filePath: string, maxSizeBytes: number): Promise<string | null> => {
          try {
            const buffer = await readFile(filePath)
            const result = await resizeImageForAPI(buffer, { maxSizeBytes })
            if (!result) return null

            // Write to session tmp directory (cleaned up with session)
            const sessionTmpDir = join(sessionPath, 'tmp')
            await mkdir(sessionTmpDir, { recursive: true })
            const ext = result.format === 'jpeg' ? 'jpg' : 'png'
            const outPath = join(sessionTmpDir, `resized-${randomUUID()}.${ext}`)
            await writeFile(outPath, result.buffer)

            sessionLog.info(`Image resized for Read: ${(buffer.length / 1024 / 1024).toFixed(1)}MB → ${(result.buffer.length / 1024 / 1024).toFixed(1)}MB (→ ${result.width}×${result.height})`)
            return outPath
          } catch (err) {
            sessionLog.error('Image resize failed:', err)
            return null
          }
        },
        // Source configs for postInit() — backends set up their own bridge/config
        initialSources: {
          enabledSources,
          mcpServers,
          apiServers,
          enabledSlugs,
        },
        },
      }) as AgentInstance

      sessionLog.info(`Created ${provider} agent for session ${managed.id} (model: ${backendContext.resolvedModel})${managed.sdkSessionId ? ' (resuming)' : ''}`)

      // ============================================================
      // Post-construction: debug callback, auth callback, postInit()
      // ============================================================

      managed.agent.onDebug = (msg: string) => {
        const marker = '__PERMISSION_BLOCK__'
        if (msg.includes(marker)) {
          const idx = msg.indexOf(marker)
          const payloadRaw = msg.slice(idx + marker.length)
          try {
            const payload = JSON.parse(payloadRaw) as {
              sessionId: string
              toolName: string
              effectiveMode: string
              modeVersion: number
              changedBy: string
              changedAt: string
              reason: string
            }
            sessionLog.info('Tool blocked by permission mode', payload)
            return
          } catch {
            // fall through to plain logging when payload parsing fails
          }
        }

        sessionLog.info(msg)
      }

      // Unified auth callback — replaces per-backend onChatGptAuthRequired/onGithubAuthRequired
      managed.agent.onBackendAuthRequired = (reason: string) => {
        sessionLog.warn(`Backend auth required for session ${managed.id}: ${reason}`)
        this.sendEvent({
          type: 'info',
          sessionId: managed.id,
          message: `Authentication required: ${reason}`,
          level: 'error',
        }, managed.workspace.id)
      }

      // Run post-init (auth injection) — each backend handles its own
      const postInitResult = await managed.agent.postInit()
      if (postInitResult.authWarning) {
        sessionLog.warn(`Auth warning for session ${managed.id}: ${postInitResult.authWarning}`)
        this.sendEvent({
          type: 'info',
          sessionId: managed.id,
          message: postInitResult.authWarning,
          level: postInitResult.authWarningLevel || 'error',
        }, managed.workspace.id)
      }

      // Wire up large response handling in the MCP pool (all backends)
      if (managed.mcpPool && managed.agent) {
        managed.mcpPool.setSummarizeCallback(managed.agent.getSummarizeCallback())
      }

      // Wire Browser window tools into this Chat's callbacks.
      //
      // Always register when EITHER a local BPM is set OR an RPC server is
      // available (which lets `getBrowserPaneManagerForSession` lazily build a
      // RemoteBrowserPaneManager). Calls fail per-method with
      // BROWSER_NO_CAPABLE_CLIENT if no desktop client is connected, instead
      // of "tool unavailable".
      sessionLog.info('[browser-pane] BPF gate check', {
        sessionId: managed.id,
        hasLocalBpm: !!this.browserPaneManager,
        hasRpcServer: !!this.rpcServer,
      })
      if (this.browserPaneManager || this.rpcServer) {
        const sid = managed.id
        const bpm = this.getBrowserPaneManagerForSession(sid)
        if (!bpm) {
          throw new Error('Browser window manager unavailable despite passing the gate — this is a bug.')
        }
        sessionLog.info('[browser-pane] BPF block resolved BPM', {
          sessionId: sid,
          bpmKind: this.browserPaneManager === bpm ? 'local' : 'remote',
        })

        const workspaceId = managed.workspace.id
        const projectId = managed.projectId
        const listSessionWindows = async () => filterBrowserWindowsForChat(
          await bpm.listInstancesAsync(),
          { workspaceId, projectId, sessionId: sid },
        )
        const resolveSessionBrowserInstance = async (toolName: string, options?: { show?: boolean }): Promise<string> => {
          const instanceId = await bpm.createForSessionAsync(sid, {
            show: options?.show ?? false,
            workspaceId,
            projectId,
          })
          const info = await bpm.getInstanceAsync(instanceId)
          sessionLog.info(`[browser-pane] tool target resolved: ${toolName} session=${sid} instance=${instanceId} ownerType=${info?.ownerType ?? 'unknown'} ownerSessionId=${info?.ownerSessionId ?? 'none'} visible=${info?.isVisible ?? false}`)
          return instanceId
        }

        const resolveLifecycleWindowTarget = async (command: 'release' | 'close' | 'hide', requestedInstanceId?: string) => {
          const windows = await listSessionWindows()

          if (windows.length === 0) {
            return { windows, reason: 'No browser windows are available. Use "open" first.' }
          }

          const validateTarget = (target: (typeof windows)[number] | undefined) => {
            if (!target) {
              return { ok: false as const, reason: `Browser window "${requestedInstanceId}" not found. Use "windows" to list available windows.` }
            }

            if (target.workspaceId !== workspaceId || target.projectId !== projectId) {
              return { ok: false as const, reason: `Browser window "${target.id}" belongs to another Project.` }
            }

            if (target.ownerSessionId !== sid) {
              return { ok: false as const, reason: `Browser window "${target.id}" is not owned by this Chat.` }
            }

            return { ok: true as const, target }
          }

          if (requestedInstanceId) {
            const validated = validateTarget(windows.find((w) => w.id === requestedInstanceId))
            if (!validated.ok) {
              return { windows, reason: validated.reason }
            }
            return { windows, target: validated.target }
          }

          const fallbackTarget = windows.find((w) => w.boundSessionId === sid)
            ?? windows.find((w) => w.ownerSessionId === sid)

          if (!fallbackTarget) {
            return { windows, reason: `No ${command} target is currently associated with this session. Use "windows", then "${command} <id>".` }
          }

          const validated = validateTarget(fallbackTarget)
          if (!validated.ok) {
            return { windows, reason: validated.reason }
          }

          return { windows, target: validated.target }
        }

        sessionLog.info('[browser-pane] BPF registering browserWindowFns', { sessionId: sid })
        mergeSessionScopedToolCallbacks(sid, {
          browserWindowFns: {
            openWindow: async (options) => {
              const instanceId = options?.background
                ? await bpm.createForSessionAsync(sid, { show: false, workspaceId, projectId })
                : await bpm.focusBoundForSessionAsync(sid, { workspaceId, projectId })
              const info = await bpm.getInstanceAsync(instanceId)
              sessionLog.info(`[browser-pane] route decision: browser_open session=${sid} instance=${instanceId} background=${options?.background ?? false} ownerType=${info?.ownerType ?? 'unknown'} ownerSessionId=${info?.ownerSessionId ?? 'none'} visible=${info?.isVisible ?? false}`)
              return { instanceId }
            },
            navigate: async (url) => {
              const instanceId = await resolveSessionBrowserInstance('browser_navigate')
              return bpm.navigate(instanceId, url)
            },
            snapshot: async () => {
              const instanceId = await resolveSessionBrowserInstance('browser_snapshot')
              return bpm.getAccessibilitySnapshot(instanceId)
            },
            click: async (ref, options) => {
              const instanceId = await resolveSessionBrowserInstance('browser_click')
              return bpm.clickElement(instanceId, ref, options)
            },
            clickAt: async (x, y) => {
              const instanceId = await resolveSessionBrowserInstance('browser_click_at')
              return bpm.clickAtCoordinates(instanceId, x, y)
            },
            drag: async (x1, y1, x2, y2) => {
              const instanceId = await resolveSessionBrowserInstance('browser_drag')
              return bpm.drag(instanceId, x1, y1, x2, y2)
            },
            fill: async (ref, value) => {
              const instanceId = await resolveSessionBrowserInstance('browser_fill')
              return bpm.fillElement(instanceId, ref, value)
            },
            type: async (text) => {
              const instanceId = await resolveSessionBrowserInstance('browser_type')
              return bpm.typeText(instanceId, text)
            },
            select: async (ref, value) => {
              const instanceId = await resolveSessionBrowserInstance('browser_select')
              return bpm.selectOption(instanceId, ref, value)
            },
            setClipboard: async (text) => {
              const instanceId = await resolveSessionBrowserInstance('browser_set_clipboard')
              return bpm.setClipboard(instanceId, text)
            },
            getClipboard: async () => {
              const instanceId = await resolveSessionBrowserInstance('browser_get_clipboard')
              return bpm.getClipboard(instanceId)
            },
            screenshot: async (options) => {
              const instanceId = await resolveSessionBrowserInstance('browser_screenshot')
              return bpm.screenshot(instanceId, options)
            },
            screenshotRegion: async (options) => {
              const instanceId = await resolveSessionBrowserInstance('browser_screenshot_region')
              return bpm.screenshotRegion(instanceId, options)
            },
            getConsoleLogs: async (options) => {
              const instanceId = await resolveSessionBrowserInstance('browser_console')
              return bpm.getConsoleLogs(instanceId, options)
            },
            windowResize: async (options) => {
              const instanceId = await resolveSessionBrowserInstance('browser_window_resize')
              return bpm.windowResize(instanceId, options.width, options.height)
            },
            getNetworkLogs: async (options) => {
              const instanceId = await resolveSessionBrowserInstance('browser_network')
              return bpm.getNetworkLogs(instanceId, options)
            },
            waitFor: async (options) => {
              const instanceId = await resolveSessionBrowserInstance('browser_wait')
              return bpm.waitFor(instanceId, options)
            },
            sendKey: async (options) => {
              const instanceId = await resolveSessionBrowserInstance('browser_key')
              return bpm.sendKey(instanceId, options)
            },
            getDownloads: async (options) => {
              const instanceId = await resolveSessionBrowserInstance('browser_downloads')
              return bpm.getDownloads(instanceId, options)
            },
            upload: async (ref, filePaths) => {
              const instanceId = await resolveSessionBrowserInstance('browser_upload')
              return bpm.uploadFile(instanceId, ref, filePaths).then(() => {})
            },
            scroll: async (direction, amount) => {
              const instanceId = await resolveSessionBrowserInstance('browser_scroll')
              return bpm.scroll(instanceId, direction, amount)
            },
            goBack: async () => {
              const instanceId = await resolveSessionBrowserInstance('browser_back')
              return bpm.goBack(instanceId)
            },
            goForward: async () => {
              const instanceId = await resolveSessionBrowserInstance('browser_forward')
              return bpm.goForward(instanceId)
            },
            evaluate: async (expression) => {
              const instanceId = await resolveSessionBrowserInstance('browser_evaluate')
              return bpm.evaluate(instanceId, expression)
            },
            focusWindow: async (targetInstanceId) => {
              const windows = await listSessionWindows()
              if (windows.length === 0) {
                throw new Error('No browser windows available to focus. Use "open" first.')
              }

              const target = targetInstanceId
                ? windows.find(w => w.id === targetInstanceId)
                : windows.find(w => w.boundSessionId === sid || w.ownerSessionId === sid)

              if (!target) {
                if (targetInstanceId) {
                  throw new Error(`Browser window "${targetInstanceId}" not found. Use "windows" to list available windows.`)
                }
                throw new Error('No browser window is currently bound to this session. Use "open --foreground" to create or reuse one.')
              }

              if (
                target.workspaceId !== workspaceId
                || target.projectId !== projectId
                || target.ownerSessionId !== sid
              ) {
                throw new Error(`Browser window "${target.id}" is not owned by this Chat and Project.`)
              }

              if (!target.boundSessionId) {
                bpm.bindSession(target.id, sid, { workspaceId, projectId })
              }

              bpm.focus(target.id)
              const focused = await bpm.getInstanceAsync(target.id)
              return {
                instanceId: target.id,
                title: focused?.title ?? target.title,
                url: focused?.currentUrl ?? target.url,
              }
            },
            releaseControl: async (requestedInstanceId) => {
              if (requestedInstanceId === 'all') {
                const before = await listSessionWindows()
                const beforeActive = before.filter((w) => !!w.agentControlActive).length
                bpm.clearAgentControl(sid)
                const after = await listSessionWindows()
                const afterActive = after.filter((w) => !!w.agentControlActive).length
                const released = afterActive < beforeActive

                sessionLog.info(`[browser-pane] lifecycle release-all session=${sid} overlays=${beforeActive}->${afterActive}`)

                return {
                  action: released ? 'released' : 'noop',
                  requestedInstanceId,
                  affectedIds: released ? before.filter((w) => !!w.agentControlActive).map((w) => w.id) : [],
                  reason: released ? undefined : 'No active overlay was found for this session.',
                }
              }

              const resolution = await resolveLifecycleWindowTarget('release', requestedInstanceId)
              if (!resolution.target) {
                sessionLog.info(`[browser-pane] lifecycle release session=${sid} requested=${requestedInstanceId ?? 'auto'} result=noop reason=${resolution.reason}`)
                return {
                  action: 'noop',
                  requestedInstanceId,
                  affectedIds: [],
                  reason: resolution.reason,
                }
              }

              const result = bpm.clearAgentControlForInstance(resolution.target.id, sid)
              const action = result.released ? 'released' : 'noop'
              sessionLog.info(`[browser-pane] lifecycle release session=${sid} requested=${requestedInstanceId ?? 'auto'} resolved=${resolution.target.id} result=${action} reason=${result.reason ?? 'none'}`)

              return {
                action,
                requestedInstanceId,
                resolvedInstanceId: resolution.target.id,
                affectedIds: result.released ? [resolution.target.id] : [],
                reason: result.reason,
              }
            },
            closeWindow: async (requestedInstanceId) => {
              const resolution = await resolveLifecycleWindowTarget('close', requestedInstanceId)
              if (!resolution.target) {
                sessionLog.info(`[browser-pane] lifecycle close session=${sid} requested=${requestedInstanceId ?? 'auto'} result=noop reason=${resolution.reason}`)
                return {
                  action: 'noop',
                  requestedInstanceId,
                  affectedIds: [],
                  reason: resolution.reason,
                }
              }

              bpm.destroyInstance(resolution.target.id)
              sessionLog.info(`[browser-pane] lifecycle close session=${sid} requested=${requestedInstanceId ?? 'auto'} resolved=${resolution.target.id} result=closed`)

              return {
                action: 'closed',
                requestedInstanceId,
                resolvedInstanceId: resolution.target.id,
                affectedIds: [resolution.target.id],
              }
            },
            hideWindow: async (requestedInstanceId) => {
              const resolution = await resolveLifecycleWindowTarget('hide', requestedInstanceId)
              if (!resolution.target) {
                sessionLog.info(`[browser-pane] lifecycle hide session=${sid} requested=${requestedInstanceId ?? 'auto'} result=noop reason=${resolution.reason}`)
                return {
                  action: 'noop',
                  requestedInstanceId,
                  affectedIds: [],
                  reason: resolution.reason,
                }
              }

              bpm.hide(resolution.target.id)
              sessionLog.info(`[browser-pane] lifecycle hide session=${sid} requested=${requestedInstanceId ?? 'auto'} resolved=${resolution.target.id} result=hidden`)

              return {
                action: 'hidden',
                requestedInstanceId,
                resolvedInstanceId: resolution.target.id,
                affectedIds: [resolution.target.id],
              }
            },
            listWindows: async () => {
              return listSessionWindows()
            },
            detectChallenge: async () => {
              const instanceId = await resolveSessionBrowserInstance('browser_detect_challenge')
              return bpm.detectSecurityChallenge(instanceId)
            },
          } satisfies BrowserWindowFns,
        })
      }

      // Signal that the agent instance is ready (unblocks title generation)
      managed.agentReadyResolve?.()

      // Set up permission handler to forward requests to renderer
      // Guarded-mode risk check (decision model, toggle `guardedMode`), used only while the
      // session is in Guarded mode. Only sessions with someone to answer a prompt are checked:
      // automations, task runs and hidden/mini sessions run unattended, so they run as Execute.
      managed.agent.guardedModeCheck = buildGuardedModeCheck({
        sessionId: managed.id,
        log: (line) => sessionLog.info(line),
        isInteractive: () => isAttendedSession(managed),
      })
      // Subagent model choice (decision model, toggle `subagentModels`): the Claude agent asks it
      // for Agent calls that name no model; no answer leaves the Settings default in charge.
      managed.agent.subagentModelPicker = buildSubagentModelPicker({
        sessionId: managed.id,
        log: (line) => sessionLog.info(line),
      })

      managed.agent.onPermissionRequest = (request: {
        requestId: string;
        toolName: string;
        command?: string;
        description: string;
        type?: 'bash' | 'file_write' | 'mcp_mutation' | 'api_mutation' | 'admin_approval';
        appName?: string;
        reason?: string;
        impact?: string;
        requiresSystemPrompt?: boolean;
        rememberForMinutes?: number;
        commandHash?: string;
        approvalTtlSeconds?: number;
        canRemember?: boolean;
      }) => {
        sessionLog.info(`Permission request for session ${managed.id}:`, request.command)
        let brokerMetadata: {
          commandHash?: string
          approvalTtlSeconds?: number
        } = {}

        if (request.type === 'admin_approval' && request.command) {
          const brokerRequest = this.privilegedExecutionBroker.createRequest({
            requestId: request.requestId,
            sessionId: managed.id,
            command: request.command,
            reason: request.reason,
            impact: request.impact,
            approvalTtlSeconds: request.approvalTtlSeconds,
          })

          brokerMetadata = {
            commandHash: brokerRequest.commandHash,
            approvalTtlSeconds: brokerRequest.approvalTtlSeconds,
          }
        }

        const effectiveCommandHash = brokerMetadata.commandHash ?? request.commandHash

        this.pendingPermissionRequests.set(request.requestId, {
          sessionId: managed.id,
          type: request.type,
          commandHash: effectiveCommandHash,
        })

        if (request.type === 'admin_approval' && effectiveCommandHash && this.hasActiveAdminRememberApproval(managed.id, effectiveCommandHash)) {
          const brokerResult = this.privilegedExecutionBroker.resolveApproval(request.requestId, true, {
            expectedCommandHash: effectiveCommandHash,
          })

          this.pendingPermissionRequests.delete(request.requestId)

          if (brokerResult.ok) {
            this.privilegedExecutionBroker.auditEvent('privileged_auto_approved_remember_window', {
              sessionId: managed.id,
              requestId: request.requestId,
              commandHash: effectiveCommandHash,
            })
            const liveAgent = managed.agent
            if (liveAgent) {
              liveAgent.respondToPermission(request.requestId, true, false)
              return
            }
          }

          sessionLog.warn(`Remember-window auto-approval skipped for ${request.requestId}: ${brokerResult.reason}`)
        }

        const emitPrompt = (risks?: PermissionRisk[] | null) => {
          this.sendEvent({
            type: 'permission_request',
            sessionId: managed.id,
            request: {
              ...request,
              ...brokerMetadata,
              ...(risks && risks.length > 0 ? { risks } : {}),
              sessionId: managed.id,
            }
          }, managed.workspace.id)
        }

        // Admin prompts already explain reason and impact; everything else may get risk badges
        // from the decision model (toggle `riskBadges`). The prompt waits for them (bounded by the
        // background deadline). It is dropped if, meanwhile, the request was answered, the session
        // was stopped or deleted, or the agent was rebuilt; the agent side is then denied so nothing
        // waits on it. A new turn alone does not drop it: keep-alive background agents still wait.
        if (request.type === 'admin_approval' || !this.decisionFeatureActive('riskBadges')) {
          emitPrompt()
        } else {
          const askedIn = { agent: managed.agent, stopEpoch: managed.stopEpoch ?? 0 }
          void assessPermissionRisks(
            { toolName: request.toolName, description: request.description, command: request.command },
            { sessionId: managed.id, log: (line) => sessionLog.info(line) },
          ).catch(() => null).then((risks) => {
            if (!this.pendingPermissionRequests.has(request.requestId)) return
            const stale = managed.agent !== askedIn.agent || (managed.stopEpoch ?? 0) !== askedIn.stopEpoch
              || this.sessions.get(managed.id) !== managed
            if (stale) {
              this.pendingPermissionRequests.delete(request.requestId)
              try {
                askedIn.agent?.respondToPermission(request.requestId, false, false)
              } catch (e) {
                sessionLog.warn(`Denying dropped permission request ${request.requestId} failed:`, e)
              }
              sessionLog.info(`Permission request ${request.requestId} dropped: stopped or rebuilt while risk badges were computed`)
              return
            }
            emitPrompt(risks)
          })
        }
      }

      // Note: Credential requests now flow through onAuthRequest (unified auth flow)
      // The legacy onCredentialRequest callback has been removed from CraftAgent
      // Auth refresh for mid-session token expiry is handled by the error handler in sendMessage
      // which destroys/recreates the agent to get fresh credentials

      // Set up mode change handlers
      managed.agent.onPermissionModeChange = (mode) => {
        if (managed.permissionMode === mode) {
          return
        }

        managed.permissionMode = mode
        const diagnostics = getPermissionModeDiagnostics(managed.id)
        managed.previousPermissionMode = diagnostics.previousPermissionMode
        sessionLog.info('Permission mode changed (agent callback)', {
          sessionId: managed.id,
          permissionMode: mode,
          modeVersion: diagnostics.modeVersion,
          changedBy: diagnostics.lastChangedBy,
          changedAt: diagnostics.lastChangedAt,
        })
        this.sendEvent({
          type: 'permission_mode_changed',
          sessionId: managed.id,
          permissionMode: managed.permissionMode,
          modeVersion: diagnostics.modeVersion,
          changedBy: diagnostics.lastChangedBy,
          changedAt: diagnostics.lastChangedAt,
          previousPermissionMode: diagnostics.previousPermissionMode,
          transitionDisplay: diagnostics.transitionDisplay,
        }, managed.workspace.id)
      }

      // Wire up onPlanSubmitted to add plan message to conversation
      managed.agent.onPlanSubmitted = async (planPath) => {
        sessionLog.info(`Plan submitted for session ${managed.id}:`, planPath)
        try {
          // Read the plan file content
          const planContent = await readFile(planPath, 'utf-8')

          // Mark the SubmitPlan tool message as completed (it won't get a tool_result due to forceAbort)
          const submitPlanMsg = managed.messages.find(
            m => m.toolName?.includes('SubmitPlan') && m.toolStatus === 'executing'
          )
          if (submitPlanMsg) {
            submitPlanMsg.toolStatus = 'completed'
            submitPlanMsg.content = 'Plan submitted for review'
            submitPlanMsg.toolResult = 'Plan submitted for review'
          }

          // Create a plan message
          const planMessage = {
            id: `plan-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            role: 'plan' as const,
            content: planContent,
            timestamp: this.monotonic(),
            planPath,
            toolUseId: submitPlanMsg?.toolUseId,
          }

          // Add to session messages
          managed.messages.push(planMessage)

          // Update lastMessageRole for badge display
          managed.lastMessageRole = 'plan'

          // Send event to renderer
          this.sendEvent({
            type: 'plan_submitted',
            sessionId: managed.id,
            message: planMessage,
          }, managed.workspace.id)

          // Interrupt execution - plan presentation is a stopping point
          // The user needs to review and respond before continuing
          if (managed.isProcessing && managed.agent) {
            sessionLog.info(`Interrupting for plan submission in session ${managed.id}`)
            managed.agent.interruptForHandoff(AbortReason.PlanSubmitted)
            this.recoverPendingSteers(managed)
            this.setProcessing(managed, false)

            // Release browser overlay + session binding because the agent is no longer running.
            // Plan submission pauses execution until user review, so browser ownership should not remain locked.
            await releaseBrowserOwnershipOnForcedStop(
              (sid) => this.getBrowserPaneManagerForSession(sid),
              managed.id,
            )

            // Send complete event so renderer knows processing stopped (include tokenUsage for real-time updates)
            this.sendEvent({ type: 'complete', sessionId: managed.id, tokenUsage: managed.tokenUsage, backgroundTasksAlive: this.keepBackgroundTasksAlive }, managed.workspace.id)

            // Persist session state
            this.persistSession(managed)
          }
        } catch (error) {
          sessionLog.error(`Failed to read plan file:`, error)
        }
      }

      // Wire up onAuthRequest to add auth message to conversation and pause execution
      managed.agent.onAuthRequest = (request) => {
        sessionLog.info(`Auth request for session ${managed.id}:`, request.type, request.sourceSlug)

        // Create auth-request message
        const authMessage: Message = {
          id: generateMessageId(),
          role: 'auth-request',
          content: this.getAuthRequestDescription(request),
          timestamp: this.monotonic(),
          authRequestId: request.requestId,
          authRequestType: request.type,
          authSourceSlug: request.sourceSlug,
          authSourceName: request.sourceName,
          authStatus: 'pending',
          // Copy type-specific fields for credentials
          ...(request.type === 'credential' && {
            authCredentialMode: request.mode,
            authLabels: request.labels,
            authDescription: request.description,
            authHint: request.hint,
            authHeaderName: request.headerName,
            authHeaderNames: request.headerNames,
            authSourceUrl: request.sourceUrl,
            authPasswordRequired: request.passwordRequired,
          }),
        }

        // Add to session messages
        managed.messages.push(authMessage)

        // Store pending auth request for later resolution
        managed.pendingAuthRequestId = request.requestId
        managed.pendingAuthRequest = request
        managed.pendingAuthOwner = { generation: managed.processingGeneration, stopEpoch: managed.stopEpoch ?? 0 }

        // Interrupt execution (like SubmitPlan)
        if (managed.isProcessing && managed.agent) {
          sessionLog.info(`Interrupting for auth request in session ${managed.id}`)
          managed.agent.interruptForHandoff(AbortReason.AuthRequest)
          this.recoverPendingSteers(managed)
          this.setProcessing(managed, false)

          // Release browser overlay + session binding because the agent is paused awaiting user auth.
          void releaseBrowserOwnershipOnForcedStop(
            (sid) => this.getBrowserPaneManagerForSession(sid),
            managed.id,
          )

          // Send complete event so renderer knows processing stopped (include tokenUsage for real-time updates)
          this.sendEvent({ type: 'complete', sessionId: managed.id, tokenUsage: managed.tokenUsage, backgroundTasksAlive: this.keepBackgroundTasksAlive }, managed.workspace.id)
        }

        // Emit auth_request event to renderer
        this.sendEvent({
          type: 'auth_request',
          sessionId: managed.id,
          message: authMessage,
          request: request,
        }, managed.workspace.id)

        // Persist session state
        this.persistSession(managed)

        // OAuth flow is client-driven via performOAuth() (preload).
        // The UI calls window.electronAPI.performOAuth() when user clicks "Sign in".
      }

      // Wire up onSpawnSession to create independent sessions from agent tool calls
      managed.agent.onSpawnSession = async (request) => {
        sessionLog.info(`Spawn session request from session ${managed.id}:`, request.name || '(unnamed)')

        // A spawned Session never leaves the caller's Project — an explicit
        // projectId may only repeat it.
        if (request.projectId && request.projectId !== managed.projectId) {
          throw new Error('CROSS_PROJECT_SESSION: spawned Sessions must stay in the caller Project')
        }
        // The model picks the child's mode; it may be as strict as it likes but never looser
        // than this session's effective mode, or an Ask session could spawn an Execute child
        // without a prompt.
        const parentMode = getPermissionMode(managed.id)
        const permissionMode = clampPermissionMode(request.permissionMode, parentMode)
        if (request.permissionMode && permissionMode !== request.permissionMode) {
          sessionLog.warn(`Spawn session: lowered requested mode ${request.permissionMode} to ${permissionMode} (parent ${managed.id} runs in ${parentMode})`)
        }

        const session = await this.createSession(managed.workspace.id, {
          name: request.name,
          llmConnection: request.llmConnection ?? managed.llmConnection,
          model: request.model ?? managed.model,
          enabledSourceSlugs: request.enabledSourceSlugs ?? managed.enabledSourceSlugs,
          permissionMode,
          thinkingLevel: request.thinkingLevel ?? managed.thinkingLevel,
          labels: request.labels ?? managed.labels,
          workingDirectory: request.workingDirectory,
          projectId: managed.projectId,
          // Spawned sessions become subtasks of the spawning session.
          parentSessionId: managed.id,
          // Nobody watches a session an automation, task or CLI run spawns either.
          unattended: !isAttendedSession(managed) || undefined,
        })

        // Build FileAttachment[] from paths (if any)
        let fileAttachments: FileAttachment[] | undefined
        if (request.attachments?.length) {
          const attachments: FileAttachment[] = []
          for (const a of request.attachments) {
            try {
              const extraDirs = getWorkspaceAllowedDirs(managed.workspace.id)
              if (request.workingDirectory) extraDirs.push(request.workingDirectory)
              const safePath = await validateFilePath(a.path, extraDirs)
              const attachment = readFileAttachment(safePath)
              if (attachment) {
                if (a.name) attachment.name = a.name
                attachments.push(attachment)
              } else {
                sessionLog.warn(`Spawn session: attachment not found: ${a.path}`)
              }
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error)
              sessionLog.warn(`Spawn session: blocked attachment path ${a.path}: ${message}`)
            }
          }
          if (attachments.length > 0) fileAttachments = attachments
        }

        // (session_created is emitted by createSession above.)

        // Fire and forget — send the message but don't await completion
        this.sendMessage(session.id, request.prompt, fileAttachments).catch(err => {
          sessionLog.error(`Failed to send message to spawned session ${session.id}:`, err)
        })

        return {
          sessionId: session.id,
          name: session.name || request.name || session.id,
          status: 'started' as const,
          connection: session.llmConnection,
          model: session.model,
        }
      }

      // Wire up session self-management tools (set_session_labels, set_session_status, etc.)
      mergeSessionScopedToolCallbacks(managed.id, {
        setSessionLabelsFn: async (sessionId: string | undefined, labels: string[]) => {
          const target = sessionId
            ? getSessionInSameProject(this.sessions, managed, sessionId)
            : managed
          await this.setSessionLabels(target.id, labels)
        },
        setSessionStatusFn: async (sessionId: string | undefined, status: string) => {
          const target = sessionId
            ? getSessionInSameProject(this.sessions, managed, sessionId)
            : managed
          await this.setSessionStatus(target.id, status as SessionStatus)
        },
        // archive_session — archive/unarchive ANOTHER session by ID. Scoped to the
        // invoking session's workspace and blocked mid-turn (guard logic lives in
        // archive-guards.ts so it is unit-testable); delegates to the existing
        // archive/unarchive methods (which persist + emit events).
        archiveSessionFn: async (sessionId: string, archived: boolean) => {
          const target = getSessionInSameProject(this.sessions, managed, sessionId)
          const guardError = validateArchiveTarget(
            { workspaceId: target.workspace.id, isProcessing: target.isProcessing },
            managed.workspace.id,
            sessionId,
            archived
          )
          if (guardError) throw new Error(guardError)
          if (archived) {
            await this.archiveSession(sessionId)
          } else {
            await this.unarchiveSession(sessionId)
          }
        },
        // create_task — create a Task (board card + task.yaml + orchestrator session)
        // WITHOUT running it. Spec building happens here (not in session-tools-core,
        // which must stay dependency-free of @craft-agent/shared); the creation flow
        // itself is createTaskFromSpec, shared verbatim with the tasks:create RPC.
        createTaskFn: async (input) => {
          const ws = managed.workspace
          if (input.projectId && input.projectId !== managed.projectId) {
            throw new Error('CROSS_PROJECT_SESSION: created Tasks must stay in the caller Project')
          }
          // Slug is derived from the title and must never overwrite an existing task
          // (unlike the TaskEditor, where re-saving the same slug is the edit flow).
          const slug = uniqueTaskSlug(input.title, new Set(listTaskSlugs(ws.rootPath)))

          // Fail-soft reference checks: unknown slugs warn, they don't block creation
          // (matching the finish() philosophy in the tasks:create handler).
          const warnings: string[] = []
          if (input.sources?.length) {
            const available = new Set(loadWorkspaceSources(ws.rootPath).map(s => s.config.slug))
            const missing = input.sources.filter(s => !available.has(s))
            if (missing.length) warnings.push(`Unknown sources (kept in the spec, but they don't exist in this workspace): ${missing.join(', ')}`)
          }
          if (input.skills?.length) {
            // loadAllSkills matches dispatch-time [skill:slug] resolution (global + workspace).
            const available = new Set(loadAllSkills(ws.rootPath).map(s => s.slug))
            const missing = input.skills.filter(s => !available.has(s))
            if (missing.length) warnings.push(`Unknown skills (kept in the spec, but they don't exist in this workspace): ${missing.join(', ')}`)
          }

          // A spec requires ≥1 node; synthesize the single executable node from the
          // description. Multi-node DAG authoring stays with the TaskEditor/generate flow.
          const parsed = parseTaskSpec({
            id: slug,
            title: input.title,
            goal: input.description,
            ...(input.acceptanceCriteria ? { acceptance_criteria: input.acceptanceCriteria } : {}),
            project: managed.projectId,
            ...(input.workingDirectory ? { cwd: input.workingDirectory } : {}),
            ...(input.sources?.length ? { sources: input.sources } : {}),
            ...(input.skills?.length ? { skills: input.skills } : {}),
            ...(input.model || input.llmConnection
              ? { defaults: { ...(input.model ? { model: input.model } : {}), ...(input.llmConnection ? { llmConnection: input.llmConnection } : {}) } }
              : {}),
            nodes: [{ id: 'main', title: input.title, prompt: input.description }],
          })
          if (!parsed.success) {
            throw new Error(`Invalid task spec: ${parsed.error.issues.map(i => i.message).join('; ')}`)
          }

          const created = await createTaskFromSpec(this, ws.id, ws.rootPath, parsed.data)
          return { ...created, warnings: [...warnings, ...created.warnings] }
        },
        // project_memory_append — one O_APPEND write per note, so sessions sharing a
        // project never drop each other's notes (rewriting MEMORY.md from a
        // session-start snapshot did). The project is read at call time.
        appendProjectMemoryFn: async (input) => {
          if (!managed.projectId) throw new Error('This session is not bound to a project.')
          const { loadProjectById, appendProjectMemoryEntry } = await import('@craft-agent/shared/projects')
          const project = loadProjectById(managed.workspace.rootPath, managed.projectId)
          if (!project) throw new Error(`Project ${managed.projectId} not found.`)
          const who = (managed.name || managed.id).replace(/\s+/g, ' ').trim()
          return appendProjectMemoryEntry(managed.workspace.rootPath, project.config.slug, `${new Date().toISOString()} — ${who}`, input.note)
        },
        // Pages tools (list_pages/get_page/create_page/update_page/
        // write_page_data/delete_page) — grouped callbacks bound to the
        // invoking session's workspace. Storage flows are shared with the
        // pages RPC handlers; after each mutation we poke the watcher (Linux
        // atomic-rename workaround) and broadcast pages:changed, exactly like
        // those handlers do.
        pages: buildPagesToolCallbacks({
          workspaceId: managed.workspace.id,
          workspaceRootPath: managed.workspace.rootPath,
          log: (message: string) => sessionLog.info(message),
          onPagesMutated: async (pageSlug: string) => {
            this.notifyConfigFileChange(managed.workspace.rootPath, `pages/${pageSlug}/page.json`)
            const { loadWorkspacePages } = await import('@craft-agent/shared/pages')
            this.broadcastPagesChanged(managed.workspace.id, loadWorkspacePages(managed.workspace.rootPath))
          },
          onContentChanged: (pageSlug: string) => {
            this.enqueuePageThumbnail(managed.workspace.id, managed.workspace.rootPath, pageSlug)
          },
        }),
        // MCP source resources & prompts (source_list_resources/source_read_resource/
        // source_list_prompts/source_get_prompt). Pool and enabled sources are read
        // at call time: getOrCreateAgent replaces the pool when it recreates the agent.
        mcpSources: buildMcpSourceToolCallbacks({
          getPool: () => managed.mcpPool,
          getEnabledSourceSlugs: () => managed.enabledSourceSlugs,
        }),
        // Decision model (`decide`) — always wired; the callback re-checks the
        // Settings switch, the feature toggle and the key on every call, so an
        // agent that still advertises the tool after the user disabled it gets
        // a clear "not enabled" answer instead of a stale client.
        decide: buildDecisionToolCallbacks({
          sessionId: managed.id,
          log: (message: string) => sessionLog.info(message),
        }),
        // PR watcher tools (pr_status/pr_bind/pr_unbind/pr_set_auto_merge) — Coding mode. Bound to the
        // invoking session; the registry (handlers/rpc/pr-watch) owns the GitHub credentials and the
        // watcher, so tokens never reach the agent. getRegistry resolves the current instance at call
        // time (it is recreated when the RPC handlers re-register).
        prWatch: buildPrWatchToolCallbacks({
          sessionId: managed.id,
          sessionManager: this,
          getRegistry: getPrWatchRegistry,
          getAutoFixMonitor: getPrAutoFixMonitor,
        }),
        createMindmapFn: async (request) => {
          if (!managed.projectId) {
            throw new Error('MINDMAP_NO_PROJECT: This Session is not linked to a Project.')
          }
          const response = await this.requestDrawnixBoardForSession(managed.id, {
            v: 1,
            action: 'create',
            projectId: managed.projectId,
            relativePath: request.relativePath,
            markdown: request.markdown,
          })
          if (!response) {
            throw new Error('MINDMAP_NO_CLIENT: No connected Stair client can create a Drawnix board.')
          }
          if (!response.ok) {
            throw Object.assign(
              new Error(`${response.error.code}: ${response.error.message}`),
              { code: response.error.code },
            )
          }
          return response.snapshot
        },
        readMindmapFn: async (relativePath) => {
          if (!managed.projectId) {
            throw new Error('MINDMAP_NO_PROJECT: This Session is not linked to a Project.')
          }
          const response = await this.requestDrawnixBoardForSession(managed.id, {
            v: 1,
            action: 'read',
            projectId: managed.projectId,
            relativePath,
          })
          if (!response) {
            throw new Error('MINDMAP_NO_CLIENT: No connected Stair client can access an open Drawnix board.')
          }
          if (!response.ok) {
            throw Object.assign(
              new Error(`${response.error.code}: ${response.error.message}`),
              { code: response.error.code },
            )
          }
          return response.snapshot
        },
        updateMindmapFn: async (request) => {
          if (!managed.projectId) {
            throw new Error('MINDMAP_NO_PROJECT: This Session is not linked to a Project.')
          }
          const response = await this.requestDrawnixBoardForSession(managed.id, {
            v: 1,
            action: 'update',
            projectId: managed.projectId,
            relativePath: request.relativePath,
            expectedChangeSeq: request.expectedChangeSeq,
            operations: request.operations,
          })
          if (!response) {
            throw new Error('MINDMAP_NO_CLIENT: No connected Stair client can access an open Drawnix board.')
          }
          if (!response.ok) {
            throw Object.assign(
              new Error(`${response.error.code}: ${response.error.message}`),
              { code: response.error.code },
            )
          }
          return response.snapshot
        },
        getSessionInfoFn: (sessionId?: string) => {
          const targetId = sessionId ?? managed.id
          const session = getSessionInSameProject(this.sessions, managed, targetId)
          return {
            id: session.id,
            name: session.name ?? session.id,
            labels: session.labels ?? [],
            status: session.sessionStatus ?? 'todo',
            permissionMode: session.permissionMode ?? 'ask',
            createdAt: session.createdAt ?? 0,
            workingDirectory: session.workingDirectory,
            projectId: session.projectId,
            llmConnection: session.llmConnection,
            model: session.model,
            isActive: session.agent != null,
          }
        },
        listSessionsFn: (options) => {
          const DEFAULT_LIMIT = 20
          const MAX_LIMIT = 100
          const limit = Math.min(options?.limit ?? DEFAULT_LIMIT, MAX_LIMIT)
          const offset = options?.offset ?? 0

          let sessions = this.getSessions(managed.workspace.id)
            .filter(session => session.projectId === managed.projectId)

          // Filter
          if (options?.status) {
            sessions = sessions.filter(s => s.sessionStatus === options.status)
          }
          if (options?.label) {
            // By label id: valued entries (`priority::3`) carry the id before the separator
            sessions = sessions.filter(s => s.labels?.some(entry => entry === options.label || extractLabelId(entry) === options.label))
          }
          if (options?.search) {
            const needle = options.search.toLowerCase()
            sessions = sessions.filter(s => s.name?.toLowerCase().includes(needle))
          }

          // Sort
          const sortBy = options?.sortBy ?? 'recent'
          if (sortBy === 'recent') {
            sessions.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
          } else if (sortBy === 'name') {
            sessions.sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''))
          } else if (sortBy === 'status') {
            sessions.sort((a, b) => (a.sessionStatus ?? '').localeCompare(b.sessionStatus ?? ''))
          }

          const total = sessions.length

          // Paginate
          const page = sessions.slice(offset, offset + limit)

          return {
            total,
            returned: page.length,
            sessions: page.map(s => ({
              id: s.id,
              name: s.name ?? s.id,
              labels: s.labels ?? [],
              status: s.sessionStatus ?? 'todo',
              createdAt: s.createdAt ?? 0,
              projectId: s.projectId,
            })),
          }
        },
        listBackgroundTasksFn: (sessionId?: string) => {
          const target = getSessionInSameProject(this.sessions, managed, sessionId ?? managed.id)
          const now = Date.now()
          return this.listBackgroundTasks(target.id).map((t) => {
            // No known start (someone else's task, or an unseen launch): report that instead of "0 s".
            if (t.untracked || t.startUnknown) {
              return {
                taskId: t.taskId,
                ...(t.intent ? { intent: t.intent } : {}),
                ...(t.kind ? { kind: t.kind } : {}),
                status: t.status,
                completedAt: t.completedAt,
                ...(t.untracked ? { untracked: true } : {}),
              }
            }
            // Prefer wall-clock elapsed; running tasks tick off startTime, terminal
            // tasks freeze at completion. Fall back to the last progress value.
            const anchorEnd = t.status === 'running' ? now : (t.completedAt ?? now)
            const wallElapsed = Math.max(0, Math.round((anchorEnd - t.startTime) / 1000))
            return {
              taskId: t.taskId,
              intent: t.intent,
              ...(t.kind ? { kind: t.kind } : {}),
              status: t.status,
              startTime: t.startTime,
              elapsedSeconds: t.elapsedSeconds ?? wallElapsed,
              completedAt: t.completedAt,
            }
          })
        },
        resolveLabelsFn: (labels: string[]) => {
          const labelConfig = loadLabelConfig(managed.workspace.rootPath)
          return resolveSessionLabels(labels, labelConfig.labels)
        },
        resolveStatusFn: (status: string) => {
          const statusConfig = loadStatusConfig(managed.workspace.rootPath)
          const allStatuses = statusConfig.statuses
          const available = allStatuses.map(s => s.id)

          // Exact ID match
          const byId = allStatuses.find(s => s.id === status)
          if (byId) return { resolved: byId.id, available, category: byId.category }
          // Case-insensitive label → ID
          const byLabel = allStatuses.find(s => s.label.toLowerCase() === status.toLowerCase())
          if (byLabel) return { resolved: byLabel.id, available, category: byLabel.category }

          return { resolved: null, available }
        },
        sendAgentMessageFn: async (sessionId: string, message: string, attachments?: Array<{ path: string; name?: string }>) => {
          const target = getSessionInSameProject(this.sessions, managed, sessionId)
          // Build FileAttachment[] from paths (same pattern as spawn_session)
          let fileAttachments: FileAttachment[] | undefined
          if (attachments?.length) {
            const builtAttachments: FileAttachment[] = []
            for (const a of attachments) {
              try {
                const extraDirs = getWorkspaceAllowedDirs(managed.workspace.id)
                const safePath = await validateFilePath(a.path, extraDirs)
                const attachment = readFileAttachment(safePath)
                if (attachment) {
                  if (a.name) attachment.name = a.name
                  builtAttachments.push(attachment)
                }
              } catch (error) {
                const msg = error instanceof Error ? error.message : String(error)
                sessionLog.warn(`send_agent_message: blocked attachment path ${a.path}: ${msg}`)
              }
            }
            if (builtAttachments.length > 0) fileAttachments = builtAttachments
          }

          // Capture the target's busy state BEFORE delivery so the sender gets a
          // truthful ack. A busy (mid-turn) target queues the message and replays
          // it after the current turn (anthropic defaults to 'queue'); an idle
          // target starts processing immediately. sendMessage throws for an
          // unknown session — that rejection propagates to the handler's catch.
          const targetBusy = target.isProcessing === true
          await this.sendMessage(sessionId, message, fileAttachments)
          return {
            delivery: targetBusy ? ('queued' as const) : ('delivered' as const),
            targetBusy,
          }
        },
        activateSourceInSessionFn: async (sourceSlug: string) => {
          const cb = managed.agent?.onSourceActivationRequest
          if (!cb) {
            return { ok: false, reason: 'Agent has no activation callback wired' }
          }
          const ok = await cb(sourceSlug)
          if (!ok) {
            return {
              ok: false,
              reason: 'Activation failed — source may be unusable (disabled/unauthenticated) or server build failed. Check session logs.',
            }
          }
          // Both backends need the current turn to end before new tools are visible:
          // Claude SDK freezes mcpServers at query() start; Pi only picks up new proxy
          // tool defs on the next handlePrompt (`toolsChanged` flag in pi-agent-server).
          // Mark a pending restart on the agent — ClaudeAgent/PiAgent consume it after
          // the next tool_result, yield source_activated, and forceAbort. The
          // `source_activated` handler in this class then schedules a server-side
          // resend of the original user message with a "[{slug} activated]" suffix —
          // landing in a fresh turn with tools live (craft-agents-oss#804).
          const userMessage = managed.agent?.getCurrentTurnUserMessage?.() ?? ''
          if (userMessage) {
            managed.agent?.setPendingSourceActivationRestart({ sourceSlug, userMessage })
          }
          return { ok: true, availability: 'next-turn' as const }
        },
      })

      // WS2 keep-alive: forward background task events that arrive BETWEEN turns
      // (idle — no chat() generator consuming) into the normal event pipeline, so
      // the running-task registry + renderer chips reflect a completion even when
      // it lands while the session is idle. During a turn these events flow through
      // the chat() generator as usual; this only covers the idle gap. No-op unless
      // the backend supports a persistent cross-turn query (Claude keep-alive).
      managed.agent.setBackgroundEventSink?.((event: AgentEvent) => {
        void this.processEvent(managed, event)
      })

      // Wire up onSourceActivationRequest to auto-enable sources when agent tries to use them
      managed.agent.onSourceActivationRequest = async (sourceSlug: string): Promise<boolean> => {
        sessionLog.info(`Source activation request for session ${managed.id}:`, sourceSlug)

        const workspaceRootPath = managed.workspace.rootPath

        // Check if source is already enabled
        if (managed.enabledSourceSlugs?.includes(sourceSlug)) {
          sessionLog.info(`Source ${sourceSlug} already in enabledSourceSlugs, checking server status`)
          // Source is in the list but server might not be active (e.g., build failed previously)
        }

        // Load the source to check if it exists and is ready
        const sources = getSourcesBySlugs(workspaceRootPath, [sourceSlug])
        if (sources.length === 0) {
          sessionLog.warn(`Source ${sourceSlug} not found in workspace`)
          return false
        }

        const source = sources[0]

        // Check if source is usable (enabled and authenticated if auth is required)
        if (!isSourceUsable(source)) {
          sessionLog.warn(`Source ${sourceSlug} is not usable (disabled or requires authentication)`)
          return false
        }

        // Track whether we added this slug (for rollback on failure)
        const slugSet = new Set(managed.enabledSourceSlugs || [])
        const wasAlreadyEnabled = slugSet.has(sourceSlug)

        // Add to enabled sources if not already there
        if (!wasAlreadyEnabled) {
          slugSet.add(sourceSlug)
          managed.enabledSourceSlugs = Array.from(slugSet)
          sessionLog.info(`Added source ${sourceSlug} to session enabled sources`)
        }

        // Build server configs for all enabled sources
        const allEnabledSources = getSourcesBySlugs(workspaceRootPath, managed.enabledSourceSlugs || [])
        // Pass session path so large API responses can be saved to session folder
        const sessionPath = getSessionStoragePath(workspaceRootPath, managed.id)
        const { mcpServers, apiServers, errors } = await buildServersFromSources(allEnabledSources, sessionPath, managed.tokenRefreshManager, managed.agent?.getSummarizeCallback())

        if (errors.length > 0) {
          sessionLog.warn(`Source build errors during auto-enable:`, errors)
        }

        // Check if our target source was built successfully
        const sourceBuilt = sourceSlug in mcpServers || sourceSlug in apiServers
        if (!sourceBuilt) {
          sessionLog.warn(`Source ${sourceSlug} failed to build`)
          // Only remove if WE added it (not if it was already there)
          if (!wasAlreadyEnabled) {
            slugSet.delete(sourceSlug)
            managed.enabledSourceSlugs = Array.from(slugSet)
          }
          return false
        }

        // Apply source servers to the agent
        const intendedSlugs = allEnabledSources
          .filter(isSourceUsable)
          .map(s => s.config.slug)

        await managed.agent!.setSourceServers(mcpServers, apiServers, intendedSlugs)

        sessionLog.info(`Auto-enabled source ${sourceSlug} for session ${managed.id}`)

        // Persist session with updated enabled sources
        this.persistSession(managed)

        // Notify renderer of source change
        this.sendEvent({
          type: 'sources_changed',
          sessionId: managed.id,
          enabledSourceSlugs: managed.enabledSourceSlugs || [],
        }, managed.workspace.id)

        return true
      }

      // NOTE: Source reloading is now handled by ConfigWatcher callbacks
      // which detect filesystem changes and update all affected sessions.
      // See setupConfigWatcher() for the full reload logic.

      // Apply session-scoped permission mode to the newly created agent
      // This ensures the UI toggle state is reflected in the agent before first message
      if (managed.permissionMode) {
        setPermissionMode(managed.id, managed.permissionMode, { changedBy: 'restore' })
        if (managed.previousPermissionMode) {
          hydratePreviousPermissionMode(managed.id, managed.previousPermissionMode)
        }
        managed.agent!.setPermissionMode(managed.permissionMode)
        const diagnostics = getPermissionModeDiagnostics(managed.id)
        sessionLog.info('Applied permission mode to agent', {
          sessionId: managed.id,
          permissionMode: managed.permissionMode,
          modeVersion: diagnostics.modeVersion,
          changedBy: diagnostics.lastChangedBy,
          changedAt: diagnostics.lastChangedAt,
        })
      }
      managed.backendRuntimeSignature = runtimeSignature
      managed.backendRestartSignature = restartSignature
      managed.backendRuntimeContext = backendContext
      end()
    }
    return managed.agent
  }

  async flagSession(sessionId: string): Promise<void> {
    const managed = this.sessions.get(sessionId)
    if (managed) {
      managed.isFlagged = true
      // Persist in-memory state directly to avoid race with pending queue writes
      this.persistSession(managed)
      await this.flushSession(managed.id)
      // Notify all windows for this workspace
      this.sendEvent({ type: 'session_flagged', sessionId }, managed.workspace.id)
      // Workaround: Bun's fs.watch({ recursive: true }) on Linux doesn't track
      // directories created after the watcher started.
      // https://github.com/oven-sh/bun/issues/15939
      const watcher = this.configWatchers.get(managed.workspace.rootPath)
      watcher?.notifyFileChange(`sessions/${sessionId}/session.jsonl`)
    }
  }

  async unflagSession(sessionId: string): Promise<void> {
    const managed = this.sessions.get(sessionId)
    if (managed) {
      managed.isFlagged = false
      // Persist in-memory state directly to avoid race with pending queue writes
      this.persistSession(managed)
      await this.flushSession(managed.id)
      // Notify all windows for this workspace
      this.sendEvent({ type: 'session_unflagged', sessionId }, managed.workspace.id)
      // Workaround: Bun's fs.watch({ recursive: true }) on Linux doesn't track
      // directories created after the watcher started.
      // https://github.com/oven-sh/bun/issues/15939
      const watcher = this.configWatchers.get(managed.workspace.rootPath)
      watcher?.notifyFileChange(`sessions/${sessionId}/session.jsonl`)
    }
  }

  async archiveSession(sessionId: string): Promise<void> {
    const managed = this.sessions.get(sessionId)
    if (!managed) {
      sessionLog.warn(`archiveSession: unknown session ${sessionId} — no-op`)
    }
    if (managed) {
      managed.isArchived = true
      managed.archivedAt = Date.now()
      // Persist in-memory state directly to avoid race with pending queue writes
      this.persistSession(managed)
      await this.flushSession(managed.id)
      // Notify all windows for this workspace
      this.sendEvent({ type: 'session_archived', sessionId }, managed.workspace.id)
      this.emitUnreadSummaryChanged()
    }
  }

  async unarchiveSession(sessionId: string): Promise<void> {
    const managed = this.sessions.get(sessionId)
    if (!managed) {
      sessionLog.warn(`unarchiveSession: unknown session ${sessionId} — no-op`)
    }
    if (managed) {
      managed.isArchived = false
      managed.archivedAt = undefined
      // Persist in-memory state directly to avoid race with pending queue writes
      this.persistSession(managed)
      await this.flushSession(managed.id)
      // Notify all windows for this workspace
      this.sendEvent({ type: 'session_unarchived', sessionId }, managed.workspace.id)
      this.emitUnreadSummaryChanged()
    }
  }

  async setSessionStatus(sessionId: string, sessionStatus: SessionStatus): Promise<void> {
    const managed = this.sessions.get(sessionId)
    if (managed) {
      managed.sessionStatus = sessionStatus
      this.setMetadataWriteGuard(managed)
      // Persist in-memory state directly to avoid race with pending queue writes
      this.persistSession(managed)
      await this.flushSession(managed.id)
      // Notify all windows for this workspace
      this.sendEvent({ type: 'session_status_changed', sessionId, sessionStatus }, managed.workspace.id)
      // Workaround: Bun's fs.watch({ recursive: true }) on Linux doesn't track
      // directories created after the watcher started.
      // https://github.com/oven-sh/bun/issues/15939
      const watcher = this.configWatchers.get(managed.workspace.rootPath)
      watcher?.notifyFileChange(`sessions/${sessionId}/session.jsonl`)
    }
  }

  /**
   * Set the LLM connection for a session.
   * Can only be changed before the first message is sent (connection is locked after).
   * This determines which LLM provider/backend will be used for this session.
   */
  async setSessionConnection(sessionId: string, connectionSlug: string): Promise<void> {
    const managed = this.sessions.get(sessionId)
    if (!managed) {
      sessionLog.warn(`setSessionConnection: session ${sessionId} not found`)
      throw new Error(`Session ${sessionId} not found`)
    }

    // Only allow changing connection before first message (session hasn't started)
    if (managed.messages && managed.messages.length > 0) {
      sessionLog.warn(`setSessionConnection: cannot change connection after session has started (${sessionId})`)
      throw new Error('Cannot change connection after session has started')
    }

    // Validate connection exists
    const { getLlmConnection } = await import('@craft-agent/shared/config/storage')
    const connection = getLlmConnection(connectionSlug)
    if (!connection) {
      sessionLog.warn(`setSessionConnection: connection "${connectionSlug}" not found`)
      throw new Error(`LLM connection "${connectionSlug}" not found`)
    }

    managed.llmConnection = connectionSlug
    // Persist in-memory state directly to avoid race with pending queue writes
    this.persistSession(managed)
    await this.flushSession(managed.id)
    sessionLog.info(`Set LLM connection for session ${sessionId} to ${connectionSlug}`)

    // Notify UI that connection changed (triggers capabilities refresh)
    this.sendEvent({
      type: 'connection_changed',
      sessionId,
      connectionSlug,
      supportsBranching: resolveSupportsBranching(managed),
    }, managed.workspace.id)
  }

  // ============================================
  // Pending Plan Execution (Accept & Compact)
  // ============================================

  /**
   * Publish lifecycle transitions before taking the persistence snapshot.
   * Ordinary metadata saves must observe the same pending-plan image while
   * strict IO is in flight; a separate disk read/write would let their older
   * snapshots erase a preparation, undo readiness or resurrect an ACK.
   * Callers hold the lifecycle lock and have hydrated messages first.
   */
  private async commitPendingPlanExecution(
    managed: ManagedSession,
    next: ManagedSession['pendingPlanExecution'],
  ): Promise<void> {
    const previous = managed.pendingPlanExecution
    managed.pendingPlanExecution = next
    try {
      this.persistSession(managed)
      await this.flushSessionStrict(managed.id)
    } catch (error) {
      if (this.sessions.get(managed.id) === managed && managed.pendingPlanExecution === next) {
        managed.pendingPlanExecution = previous
        // Replace any concurrent metadata snapshot of the failed transition
        // with the rolled-back live image, preserving its other edits.
        this.persistSession(managed)
        await this.flushSessionStrict(managed.id).catch(rollbackError => {
          sessionLog.error(`Session ${managed.id}: pending plan rollback persistence failed`, rollbackError)
        })
      }
      throw error
    }
  }

  /**
   * Set pending plan execution state.
   * Called when user clicks "Accept & Compact" to persist the plan path
   * so execution can resume after compaction (even if page reloads).
   *
   * Runs inside the session lifecycle lock so preparation cannot interleave
   * with dispatch/cancel/compaction transitions, and REJECTS (never silently
   * succeeds) when the session or its stored record is missing, the strict
   * persistence write fails, or another unresolved pending intent or restore
   * outbox already exists for this session — a second acceptance would drop
   * the first one's consumed snapshot. The existing intent must be recovered
   * (scoped ACK) or executed first; the only replaceable records are the
   * ambiguous pre-identity dispatched records left inert by reconciliation.
   *
   * Fresh reference validation happens HERE, with the same strictness as a
   * normal sendMessage: structure, Project boundary, live source
   * Chat/message existence and Project-File fingerprints. Only a durably
   * accepted snapshot earns the continuation trust the later dispatch reuses;
   * a forged quote (e.g. from another Project) cannot bypass send validation
   * via prepare+dispatch. `approvalText` is the renderer-composed (localized)
   * approval message stored with the acceptance; it is ordinary user text,
   * and references are validated independently.
   */
  async setPendingPlanExecution(
    sessionId: string,
    planPath: string,
    draftInputSnapshot?: string,
    draftReferencesSnapshot?: Reference[],
    approvalText?: string,
    approvalBadges?: ContentBadge[],
  ): Promise<NonNullable<StoredSession['pendingPlanExecution']>> {
    return this.withSessionLifecycleLock(sessionId, async () => {
      const managed = this.sessions.get(sessionId)
      if (!managed) {
        throw new Error(`PENDING_PLAN_SESSION_MISSING: Session ${sessionId} not found`)
      }
      await this.ensureMessagesLoaded(managed)

      const previous = managed.pendingPlanExecution
      // A new acceptance must never drop an unrecoverable snapshot. Whether
      // the previous record's draft was consumed is read from the DURABLE
      // drafts-store receipt (the authoritative, atomic record) — never from
      // a client claim. A read failure rejects preparation outright: guessing
      // "unconsumed" on an IO error could drop a consumed snapshot.
      let previousConsumed = false
      if (previous?.executionId) {
        previousConsumed = (() => {
          const receipt = getPlanDraftConsumption(sessionId, previous.executionId)
          return receipt?.text === true || (receipt?.referenceKeys?.length ?? 0) > 0
        })()
      }
      // Replaceable: the ambiguous pre-identity dispatched record (inert by
      // reconciliation), or a crashed PREPARATION that consumed nothing (its
      // snapshot still lives in the user's draft). Everything else — a failed
      // restore outbox, a consumed record, a durably dispatched intent, an
      // already-compacted ready record — is unresolved and rejects.
      const previousUnresolved = previous && !(
        previous.executionDispatched === true && previous.executionId === undefined
        || previous.awaitingCompaction === true
          && !previous.executionDispatched
          && !previous.failed
          && !previousConsumed
      )
      if (previousUnresolved) {
        throw new Error(`PENDING_PLAN_EXISTS: Session ${sessionId} still has an unresolved Accept & Compact intent (executionId ${previous!.executionId ?? 'none'}); recover or execute it before starting a new one`)
      }

      const referenceTarget = {
        id: managed.id,
        workspaceId: managed.workspace.id,
        projectId: managed.projectId,
      }
      let references: Reference[] | undefined
      if (draftReferencesSnapshot?.length) {
        for (const reference of draftReferencesSnapshot) {
          if (!isChatMessageReference(reference)) continue
          const source = this.sessions.get(reference.sessionId)
          if (source) await this.ensureMessagesLoaded(source)
        }
        // Full fresh validation — identical to a first-class send.
        references = validateReferencesForSession(draftReferencesSnapshot, referenceTarget, sourceId => {
          const source = this.sessions.get(sourceId)
          return source ? {
            id: source.id,
            workspaceId: source.workspace.id,
            projectId: source.projectId,
            messages: source.messages,
          } : null
        })
        await validateProjectFileReferencesForSend(references, managed.workspace.rootPath)
      }

      // Flush a newly-created session if it has not reached disk yet. Existing
      // sessions are persisted from the live image below, also retrying an
      // earlier failed write instead of remaining stuck on its error marker.
      if (!loadStoredSession(managed.workspace.rootPath, sessionId)) {
        try {
          await this.flushSessionStrict(sessionId)
        } catch {
          // A failed initial write has consumed its queue entry. Retry that
          // live session image after filesystem recovery before accepting a
          // plan; a missing session without any creation/write still rejects.
          this.persistSession(managed)
          await this.flushSessionStrict(sessionId)
        }
      }
      if (!loadStoredSession(managed.workspace.rootPath, sessionId)) {
        throw new Error(`PENDING_PLAN_SESSION_MISSING: no stored session ${sessionId} to hold the pending plan record`)
      }
      const storedApproval = typeof approvalText === 'string' && approvalText.trim() ? approvalText : undefined
      const record: NonNullable<ManagedSession['pendingPlanExecution']> = {
        planPath,
        draftInputSnapshot,
        ...(references?.length ? { draftReferencesSnapshot: references } : {}),
        ...(storedApproval !== undefined ? { approvalMessage: storedApproval, ...(approvalBadges?.length ? { approvalBadges } : {}) } : {}),
        referencesValidated: true,
        awaitingCompaction: true,
        executionDispatched: false,
        executionId: randomUUID(),
        restoreId: randomUUID(),
      }
      await this.commitPendingPlanExecution(managed, record)
      sessionLog.info(`Session ${sessionId}: set pending plan execution for ${planPath}`)
      return record
    })
  }

  /**
   * Atomically consume the accepted plan's draft snapshot: the stored draft's
   * matching components are cleared and the EXACT receipt is recorded in the
   * SAME drafts-file write (consumeSessionDraftForPlan). This is the crash
   * boundary for preparation — either the receipt and the consumed draft land
   * together, or nothing changed and the snapshot still lives in the user's
   * draft (recovery then restores nothing, correctly). A boolean claim before
   * or after a separate client-side clear proves neither side.
   *
   * The renderer calls this instead of clearing locally first: it flushes its
   * outstanding local edits (so the store reflects live input), awaits this
   * result, and only then mirrors the consumed components in its local state —
   * skipping any component the user edited while the call was in flight.
   * IO failures reject: the client must NOT clear on failure.
   */
  async consumePendingPlanDraft(
    sessionId: string,
    executionId: string,
    local?: { content: import('@craft-agent/shared/config').DraftContent; mutation: import('@craft-agent/shared/config').DraftContentMutation },
  ): Promise<import('@craft-agent/shared/config').PlanDraftConsumption | null> {
    return this.withSessionLifecycleLock(sessionId, async () => {
      const managed = this.sessions.get(sessionId)
      if (!managed) return null
      await this.ensureMessagesLoaded(managed)
      const record = managed.pendingPlanExecution
      // A lost reply can be retried after cancellation. Return the committed
      // receipt even after another window restored and ACKed the outbox. The
      // renderer's writer checkpoint retains this proof until its next accept.
      if (getPlanDraftConsumption(sessionId, executionId)) {
        return consumeSessionDraftForPlan(sessionId, managed.projectId, executionId, {
          text: '', references: [],
        })
      }
      if (!record || record.executionId !== executionId) return null
      if (record.failed
        || record.executionDispatched || !record.awaitingCompaction || record.compactionTurn) return null
      // The record's OWN snapshot is authoritative — a client cannot aim
      // consumption at arbitrary text.
      const result = consumeSessionDraftForPlan(sessionId, managed.projectId, executionId, {
        text: record.draftInputSnapshot ?? '',
        references: record.draftReferencesSnapshot ?? [],
      }, local)
      sessionLog.info(`Session ${sessionId}: plan draft consumption (executionId ${executionId}) text=${result.receipt.text} references=${result.receipt.referenceKeys.length}`)
      return result
    })
  }

  /** Recover only components proven consumed by this host, never a client snapshot. */
  async restorePendingPlanDraft(
    sessionId: string,
    executionId: string,
    restoreId: string,
    local?: { content: import('@craft-agent/shared/config').DraftContent; mutation: import('@craft-agent/shared/config').DraftContentMutation },
  ): Promise<import('@craft-agent/shared/config').SessionDraftRestoreResult> {
    return this.withSessionLifecycleLock(sessionId, async () => {
      const managed = this.sessions.get(sessionId)
      if (!managed) throw new Error('PENDING_PLAN_SESSION_MISSING')
      await this.ensureMessagesLoaded(managed)
      const record = managed.pendingPlanExecution
      if (record?.executionId === executionId && record.restoreId === restoreId && record.failed) {
        const snapshot = this.pendingPlanRecoveryDraft(sessionId, record)
        return restoreSessionDraftAtomic(sessionId, managed.projectId, restoreId, snapshot, local, executionId)
      }
      // A second window or a lost RPC response can replay after the first ACK.
      // Its local edit still commits; the bound restore receipt prevents a
      // second snapshot and rejects a fabricated/foreign identity.
      if (hasAppliedDraftRestore(sessionId, restoreId, executionId)) {
        return restoreSessionDraftAtomic(sessionId, managed.projectId, restoreId, { text: '' }, local, executionId)
      }
      throw new Error('PENDING_PLAN_STALE: Recovery identity is not a failed pending plan')
    })
  }

  private pendingPlanRecoveryDraft(
    sessionId: string,
    record: NonNullable<ManagedSession['pendingPlanExecution']>,
  ): import('@craft-agent/shared/config').SessionDraft {
    const receipt = record.executionId ? getPlanDraftConsumption(sessionId, record.executionId) : null
    const keys = new Set(receipt?.referenceKeys ?? [])
    const references = (record.draftReferencesSnapshot ?? []).filter(reference => keys.has(referenceKey(reference)))
    return {
      text: receipt?.text ? record.draftInputSnapshot ?? '' : '',
      ...(references.length ? { references } : {}),
    }
  }

  /**
   * Mark compaction as complete for pending plan execution.
   *
   * `expectedExecutionId` is the record identity the caller observed: an
   * identified record is readied only by a call carrying its exact id, so a
   * legacy no-identity command can never authorize modern intent. The
   * completion must also belong to the record's own compaction turn: the
   * correlation captured when the /compact send started is compared against
   * the live turn emitting the event (the event pump only delivers a turn's
   * events while that turn is the live one), so a late completion from an
   * older or foreign compaction never readies a newer record. Correlation
   * gates the TRANSITION to ready; an already durably-ready record (including
   * a legacy one) is executed by dispatch without needing a correlation.
   */
  async markCompactionComplete(
    sessionId: string,
    expectedExecutionId?: string,
    originatingTurn?: { generation: number; stopEpoch: number },
  ): Promise<boolean> {
    return this.withSessionLifecycleLock(sessionId, async () => {
      const managed = this.sessions.get(sessionId)
      if (!managed) return false
      await this.ensureMessagesLoaded(managed)
      const record = managed.pendingPlanExecution
      const correlation = record?.compactionTurn
      if (!record || !correlation) {
        sessionLog.info(`Session ${sessionId}: compaction completion has no correlated pending plan; ignored`)
        return false
      }
      if (record.failed) {
        sessionLog.info(`Session ${sessionId}: compaction completion ignored — pending plan already terminally failed`)
        return false
      }
      if (record.executionId !== undefined && expectedExecutionId !== record.executionId) {
        sessionLog.info(`Session ${sessionId}: compaction completion identity mismatch; pending plan not readied`)
        return false
      }
      // The completion must belong to the turn that EMITTED the event — the
      // originating context captured by the send's execution, never re-derived
      // from the live generation at decision time.
      const emittingTurn = originatingTurn ?? { generation: managed.processingGeneration, stopEpoch: managed.stopEpoch ?? 0 }
      if (emittingTurn.generation !== correlation.generation || emittingTurn.stopEpoch !== correlation.stopEpoch) {
        sessionLog.info(`Session ${sessionId}: compaction completion is stale (emitting turn is not the record's compaction turn); pending plan not readied`)
        return false
      }
      if (!record.awaitingCompaction || record.executionDispatched) return false
      await this.commitPendingPlanExecution(managed, { ...record, awaitingCompaction: false })
      sessionLog.info(`Session ${sessionId}: compaction marked complete for pending plan`)
      return true
    })
  }

  /**
   * Mark pending plan execution as already dispatched from the UI.
   * LEGACY-ONLY escape hatch (an old renderer's claim-then-send flow): it can
   * only ever claim a pre-identity record; identified records are rejected
   * regardless of what identity is presented, because a claim without the
   * server-side durable approval handoff is a split handoff that can lose the
   * plan. Modern renderers use `dispatchPendingPlanExecution`.
   */
  async markPendingPlanExecutionDispatched(sessionId: string): Promise<boolean> {
    return this.withSessionLifecycleLock(sessionId, async () => {
      const managed = this.sessions.get(sessionId)
      if (!managed || managed.isProcessing) {
        sessionLog.info(`Session ${sessionId}: pending plan dispatch claim rejected (missing or busy)`)
        return false
      }
      await this.ensureMessagesLoaded(managed)
      const record = managed.pendingPlanExecution
      if (!record || record.executionId !== undefined || record.awaitingCompaction || record.executionDispatched || record.failed) return false
      try {
        await this.commitPendingPlanExecution(managed, { ...record, executionDispatched: true })
        return true
      } catch (error) {
        sessionLog.error(`Session ${sessionId}: legacy pending plan claim failed to persist`, error)
        return false
      }
    })
  }

  /**
   * Server-owned durable dispatch of an accepted plan ("Accept & Compact"
   * continuation). Replaces the renderer's claim→send→clear RPC split: the
   * whole acceptance is one server-side critical section.
   *
   * Phases:
   * 1. Under the lifecycle lock (after hydrating messages): identity recheck
   *    — the caller submits the executionId it actually observed; a
   *    no-identity or mismatched command on an identified record is stale.
   *    Ready = not awaiting compaction (correlation gated the transition; a
   *    durably-ready record — including a legacy one — needs no correlation).
   * 2. Reference validation OUTSIDE the lock: filesystem IO here must not
   *    block user input admission, and an await is not an authorization lock
   *    on user intent.
   * 3. COMMIT under the lock: hydrate, RE-READ the live record, and recheck
   *    identity, failure, dispatch state, idle and the turn generation
   *    captured in phase 1. A user message that admitted during the
   *    validation await cleared the record (safety valve) and started a new
   *    turn — the acceptance aborts with zero approval messages. Only then
   *    are the permission-mode switch and the durable handoff written: the
   *    approval user message is created queued and persisted TOGETHER with
   *    the dispatched flag and its `approvalMessageId` in ONE session-file
   *    write (strict flush; IO failure rolls back and stays retryable).
   * 4. The model turn starts outside the lock via the standard queued-message
   *    replay machinery; the record survives until genuine backend handoff
   *    (agent initialized), where sendMessage clears it scoped by the
   *    approval identity. Orphan-queue recovery and cold-load reconciliation
   *    re-queue a mid-delivery crash by the stable approvalMessageId.
   */
  async dispatchPendingPlanExecution(
    sessionId: string,
    executionId?: string,
    rpcContext?: { callerClientId?: string },
  ): Promise<{ ok: true } | { ok: false; reason: 'missing' | 'busy' | 'not-ready' | 'already-dispatched' | 'failed' | 'stale' | 'invalid-references' | 'persist-failed' }> {
    // Phase 1: identity + readiness under the lock, on the hydrated record.
    const admission = await this.withSessionLifecycleLock(sessionId, async () => {
      const managed = this.sessions.get(sessionId)
      if (!managed) return { ok: false as const, reason: 'missing' as const }
      await this.ensureMessagesLoaded(managed)
      const record = managed.pendingPlanExecution
      if (!record) return { ok: false as const, reason: 'missing' as const }
      if (record.executionId !== undefined && executionId !== record.executionId) {
        return { ok: false as const, reason: 'stale' as const }
      }
      if (managed.isProcessing) return { ok: false as const, reason: 'busy' as const }
      if (record.failed) return { ok: false as const, reason: 'failed' as const }
      if (record.awaitingCompaction) return { ok: false as const, reason: 'not-ready' as const }
      if (record.executionDispatched) return { ok: false as const, reason: 'already-dispatched' as const }
      return {
        ok: true as const,
        record,
        managed,
        scheduledGeneration: managed.processingGeneration,
        scheduledStopEpoch: managed.stopEpoch ?? 0,
      }
    })
    if (!admission.ok) return admission
    const { managed } = admission

    // Phase 2: validation outside the lock. Structure is re-normalized and
    // Project Files must still match their selection fingerprints (they can
    // change between accept and dispatch). Chat quotes were fully validated
    // (live source and message existence) at prepare time and persisted
    // durably — that durable acceptance is what earns their reuse here,
    // exactly like any other queued message.
    const referenceTarget = {
      id: managed.id,
      workspaceId: managed.workspace.id,
      projectId: managed.projectId,
    }
    let references: Reference[] = []
    if (admission.record.draftReferencesSnapshot?.length) {
      try {
        if (admission.record.referencesValidated === true) {
          references = normalizeReferencesForSession(admission.record.draftReferencesSnapshot, referenceTarget)
        } else {
          // Older ready records have no evidence of a prior host acceptance.
          // Hydrate their Chat sources and enforce fresh scope/message checks.
          for (const reference of admission.record.draftReferencesSnapshot) {
            if (!isChatMessageReference(reference)) continue
            const source = this.sessions.get(reference.sessionId)
            if (source) await this.ensureMessagesLoaded(source)
          }
          references = validateReferencesForSession(admission.record.draftReferencesSnapshot, referenceTarget, sourceId => {
            const source = this.sessions.get(sourceId)
            return source ? { id: source.id, workspaceId: source.workspace.id, projectId: source.projectId, messages: source.messages } : null
          })
        }
      } catch (error) {
        sessionLog.warn(`Session ${sessionId}: pending plan references failed normalization`, error)
        await this.cancelPendingPlanSuperseded(sessionId, admission.record)
        return { ok: false as const, reason: 'invalid-references' as const }
      }
      try {
        await validateProjectFileReferencesForSend(references, managed.workspace.rootPath)
      } catch (error) {
        sessionLog.warn(`Session ${sessionId}: pending plan references failed fresh validation`, error)
        await this.cancelPendingPlanSuperseded(sessionId, admission.record)
        return { ok: false as const, reason: 'invalid-references' as const }
      }
    }

    // Phase 3: commit. Everything re-read and rechecked under the lock.
    return this.withSessionLifecycleLock(sessionId, async () => {
      // The live managed record, re-read after the awaits (never a
      // pre-hydration or pre-await snapshot).
      const liveManaged = this.sessions.get(sessionId)
      if (!liveManaged) return { ok: false as const, reason: 'missing' as const }
      const record = liveManaged.pendingPlanExecution
      if (!record || record !== admission.record && record.executionId !== admission.record.executionId) {
        // Replaced or cleared while validation awaited (e.g. a user message's
        // safety valve cancelled the intent): the acceptance aborts.
        return { ok: false as const, reason: 'stale' as const }
      }
      if (record.executionId !== undefined && executionId !== record.executionId) {
        return { ok: false as const, reason: 'stale' as const }
      }
      if (liveManaged.isProcessing
        || liveManaged.processingGeneration !== admission.scheduledGeneration
        || (liveManaged.stopEpoch ?? 0) !== admission.scheduledStopEpoch) {
        // A new turn admitted (or a Stop landed) while validation awaited:
        // never commit or replay over live user intent.
        return { ok: false as const, reason: 'stale' as const }
      }
      if (record.failed) return { ok: false as const, reason: 'failed' as const }
      if (record.executionDispatched) return { ok: false as const, reason: 'already-dispatched' as const }

      // Leave Explore mode so the plan can run without prompts (back to Guarded
      // if the session came from it) — same policy as acceptPlan. The caller's
      // transport context pins browser-tool routing to the approving client,
      // exactly as a first-class SEND_MESSAGE does.
      if (rpcContext?.callerClientId) {
        this.setLastMessageClientId(sessionId, rpcContext.callerClientId)
      }
      if (liveManaged.permissionMode === 'safe') {
        this.setSessionPermissionMode(sessionId, planExecutionMode(liveManaged.previousPermissionMode))
      }

      const approvalText = record.approvalMessage?.trim()
        ? record.approvalMessage!
        : buildPlanApprovalMessage({ draftInput: record.draftInputSnapshot })
      const approvalMessageId = generateMessageId()
      const approvalMessage: Message = {
        id: approvalMessageId,
        role: 'user',
        content: approvalText,
        ...(record.approvalBadges?.length ? { badges: record.approvalBadges } : {}),
        timestamp: this.monotonic(),
        ...(references.length ? { references } : {}),
        isQueued: true,
      }
      liveManaged.messages.push(approvalMessage)
      liveManaged.messageQueue.push({
        message: approvalText,
        messageId: approvalMessageId,
        options: { ...(references.length ? { references } : {}), ...(record.approvalBadges?.length ? { badges: record.approvalBadges } : {}) },
      })
      record.executionDispatched = true
      record.approvalMessageId = approvalMessageId
      try {
        this.persistSession(liveManaged)
        await this.flushSessionStrict(liveManaged.id)
      } catch (error) {
        // The atomic handoff write failed: roll the in-memory acceptance back.
        // The record stays retryable — no dispatched flag was durably recorded.
        liveManaged.messages = liveManaged.messages.filter(message => message.id !== approvalMessageId)
        liveManaged.messageQueue = liveManaged.messageQueue.filter(entry => entry.messageId !== approvalMessageId)
        record.executionDispatched = false
        delete record.approvalMessageId
        if (this.sessions.get(sessionId) === liveManaged && liveManaged.pendingPlanExecution === record) {
          // A concurrent metadata write may already hold a copy of the
          // approval bubble. Correct the whole queued image before reporting
          // failure, so reboot cannot replay an acceptance that failed.
          this.persistSession(liveManaged)
          await this.flushSessionStrict(sessionId).catch(rollbackError => {
            sessionLog.error(`Session ${sessionId}: approval rollback persistence failed`, rollbackError)
          })
        }
        sessionLog.error(`Session ${sessionId}: pending plan durable acceptance failed`, error)
        return { ok: false as const, reason: 'persist-failed' as const }
      }

      // Stop closes admission synchronously, including while this write holds
      // the lifecycle lock. Persist cancellation before any queued replay can
      // start, so a restart cannot execute the stopped approval either.
      if ((liveManaged.stopEpoch ?? 0) !== admission.scheduledStopEpoch || liveManaged.stopRequested) {
        await this.cancelPendingPlanExecution(liveManaged, record)
        return { ok: false as const, reason: 'stale' as const }
      }

      this.sendEvent({
        type: 'user_message',
        sessionId,
        message: approvalMessage,
        status: 'queued',
      }, liveManaged.workspace.id)

      // Durable acceptance complete — the critical section ends here. The
      // replay path runs the model turn (setImmediate inside, so it cannot
      // execute while the lock is held); its send path performs the
      // backend-handoff cleanup scoped by the approval identity.
      this.processNextQueuedMessage(sessionId)
      sessionLog.info(`Session ${sessionId}: pending plan execution durably accepted (approval ${approvalMessageId})`)
      return { ok: true as const }
    })
  }

  /**
   * Cancel a pending plan at dispatch time because its references no longer
   * validate (files changed / structure invalid): the intent is superseded by
   * conditions, so it becomes a terminally failed restore outbox — the
   * consumed draft is recoverable through the standard outbox protocol. Runs
   * under the lifecycle lock with live-identity rechecks.
   */
  private async cancelPendingPlanSuperseded(
    sessionId: string,
    expected: NonNullable<ManagedSession['pendingPlanExecution']>,
  ): Promise<void> {
    await this.withSessionLifecycleLock(sessionId, async () => {
      const managed = this.sessions.get(sessionId)
      const record = managed?.pendingPlanExecution
      // A duplicate dispatch's late validation cannot cancel an approval
      // that another dispatch has already accepted durably.
      if (!managed || !record || record.executionId !== expected.executionId || record.executionDispatched) return
      await this.cancelPendingPlanExecution(managed, record)
    })
  }

  /**
   * Cancel a pending plan whose compaction failed (manual compaction_failed,
   * Stop during the compact, or a compaction that died with the process). The
   * record becomes TERMINALLY non-executable in memory first — a later
   * completion event can never re-authorize a known-failed operation, even if
   * persisting the marker fails — and then the failed record is kept as a
   * durable restore outbox: the renderer performs the ordered recovery (flush
   * local edits, then the idempotent atomic restore, then a scoped ACK that
   * clears the outbox). Until that ACK the snapshot stays recoverable;
   * reconnection re-delivers it through the pending-plan load. The host never
   * pre-applies the restore itself: an outstanding renderer write could wipe
   * it before the atomic restore commits, and the same restoreId would then
   * no-op. The delivered payload restores TEXT only when the renderer's
   * durable consumption receipt says the text was actually consumed — an
   * unconsumed snapshot still lives in the user's draft and re-appending it
   * would duplicate it.
   */
  private async cancelPendingPlanExecution(
    managed: ManagedSession,
    record: NonNullable<ManagedSession['pendingPlanExecution']>,
  ): Promise<void> {
    if (this.sessions.get(managed.id) !== managed || managed.pendingPlanExecution !== record) return
    // Terminal in memory BEFORE anything else, no matter what fails below.
    record.failed = true
    const cancelledStopEpoch = managed.stopEpoch ?? 0
    const cancelledReplay = !!record.approvalMessageId
      && managed.pendingQueueReplay?.entries[0]?.messageId === record.approvalMessageId
    // Release this approval's scheduled ownership before any await or ACK
    // can clear its failed record. Its callback must never execute it later.
    if (cancelledReplay) this.recoverPendingQueueReplay(managed)
    if (record.approvalMessageId) {
      managed.messageQueue = managed.messageQueue.filter(entry => entry.messageId !== record.approvalMessageId)
      const approval = managed.messages.find(message => message.id === record.approvalMessageId)
      if (approval) approval.isQueued = false
    }
    // The outbox needs both stable identities; legacy hydrated records may
    // lack them.
    record.executionId ??= randomUUID()
    record.restoreId ??= randomUUID()

    const persistFailure = async () => {
      this.persistSession(managed)
      await this.flushSessionStrict(managed.id)
    }
    try {
      await persistFailure()
    } catch (error) {
      sessionLog.error(`Session ${managed.id}: failed to persist non-executable pending plan state; will retry`, error)
      // Retryable: the in-memory flag already blocks this process, and the
      // retry (plus cold-load reconciliation) closes the window across reload.
      void this.withSessionLifecycleLock(managed.id, async () => {
        if (this.sessions.get(managed.id)?.pendingPlanExecution !== record || !record.failed) return
        await persistFailure().catch(() => {})
      }).catch(() => {})
    }
    if (this.sessions.get(managed.id) !== managed || managed.pendingPlanExecution !== record) return
    if (cancelledReplay && !managed.isProcessing && !managed.stopRequested
      && (managed.stopEpoch ?? 0) === cancelledStopEpoch) this.processNextQueuedMessage(managed.id)

    // Re-delivery of the recovery intent. Idempotent on the renderer side via
    // the durable restoreId; disconnected renderers are re-exposed through the
    // pending-plan load on their next mount. TEXT is restored only when the
    // durable drafts-store receipt says it was actually consumed — an
    // unconsumed snapshot still lives in the user's draft, and appending a
    // second copy is exactly what the receipt prevents. A receipt-read
    // failure must not be guessed: keep the failed outbox and let a later
    // re-delivery (duplicate event, cold-load) retry.
    let restored: import('@craft-agent/shared/config').SessionDraft
    try {
      restored = this.pendingPlanRecoveryDraft(managed.id, record)
    } catch (error) {
      sessionLog.error(`Session ${managed.id}: plan consumption receipt unreadable; deferring outbox re-delivery`, error)
      return
    }
    this.sendEvent({
      type: 'compaction_failed',
      sessionId: managed.id,
      executionId: record.executionId,
      restoreId: record.restoreId,
      ...(restored.text ? { text: restored.text } : {}),
      ...(restored.references?.length ? { references: restored.references } : {}),
    }, managed.workspace.id)
  }

  /**
   * Reconcile a stored pending-plan record at cold hydration (messages loaded
   * from disk — no turn of this process exists yet). All decisions are made by
   * persisted IDs (`approvalMessageId`, `failed`, `compactionTurn`), never by
   * content matching or timestamp guessing. Queue flags are normalized before
   * the orphan scan so unsent input is recovered in original arrival order.
   * Outbox recovery runs off the synchronous hydration path under the
   * lifecycle lock and re-checks the
   * CAPTURED session and record identity at run time — a session deleted or a
   * record replaced while the task was queued is never touched.
   */
  private reconcileStoredPendingPlanExecution(
    managed: ManagedSession,
    stored: StoredSession,
  ): StoredSession['pendingPlanExecution'] | undefined {
    const record = stored.pendingPlanExecution
    if (!record) return undefined
    const capturedExecutionId = record.executionId

    // Re-check that the live session AND record are still the ones hydrated
    // here: same identity (or both legacy), still in the same lifecycle state.
    const stillCurrentSession = () => this.sessions.get(managed.id) === managed
    const stillCurrentRecord = (currentRecord: NonNullable<ManagedSession['pendingPlanExecution']>, requireFailed: boolean) => {
      if (requireFailed !== (currentRecord.failed === true)) return false
      if (capturedExecutionId !== undefined) return currentRecord.executionId === capturedExecutionId
      return currentRecord.executionId === undefined
    }

    if (record.failed) {
      // Durable restore outbox: re-deliver the recovery intent to any
      // connected renderer. The record stays failed — non-executable — until
      // the scoped recovery ACK; it is never cleared by user input.
      setImmediate(() => {
        void this.withSessionLifecycleLock(managed.id, async () => {
          if (!stillCurrentSession()) return
          const currentRecord = managed.pendingPlanExecution
          if (!currentRecord || !stillCurrentRecord(currentRecord, true)) return
          await this.cancelPendingPlanExecution(managed, currentRecord)
        }).catch(error => sessionLog.error(`Session ${managed.id}: pending plan outbox re-delivery failed`, error))
      })
      return record
    }

    if (record.executionDispatched) {
      if (record.approvalMessageId) {
        const approval = (stored.messages ?? []).find(message => message.id === record.approvalMessageId)
        if (!approval) {
          // The durable claim was never written together with its approval
          // message: the acceptance never happened — make the record retryable.
          sessionLog.info(`Session ${managed.id}: dispatched pending plan has no persisted approval message; making record retryable`)
          return { ...record, executionDispatched: false }
        }
        if (approval.isQueued) {
          // The shared orphan scan re-queues and replays it; the
          // replay's send path clears the record at backend handoff.
          return record
        }
        // Not queued and the record survived: the crash happened mid-delivery,
        // before genuine backend handoff (which clears the record scoped by
        // the approval identity). Re-queue the SAME message id — at-least-once
        // delivery with at-most-once authorization, and no duplicate bubble
        // (replay re-stamps the existing message). A crash after handoff but
        // before its cleanup write replays once — the documented post-handoff
        // ambiguity boundary.
        // The shared orphan scan runs immediately after this reconciliation.
        // Mark the approval now so it joins later queued inputs in history
        // order, rather than appending it after their replay has started.
        const existing = managed.messages.find(message => message.id === record.approvalMessageId)
        if (existing) existing.isQueued = true
        return record
      }
      // Legacy record dispatched before identifiers existed: ambiguous, never
      // replayed (deliberate migration — no blind replay of unknown state).
      sessionLog.info(`Session ${managed.id}: legacy dispatched pending plan record left inert`)
      return record
    }

    if (record.awaitingCompaction) {
      // Close consumption admission synchronously: a delayed consume RPC must
      // not clear a draft after reboot reconciliation has cancelled its owner.
      record.failed = true
      // A /compact turn cannot survive the process boundary: the correlated
      // compaction is incomplete and must become non-executable (never ready).
      // The consumed draft is recovered through the outbox protocol above.
      setImmediate(() => {
        void this.withSessionLifecycleLock(managed.id, async () => {
          if (!stillCurrentSession()) return
          const currentRecord = managed.pendingPlanExecution
          if (!currentRecord || currentRecord.executionDispatched || !stillCurrentRecord(currentRecord, true)) return
          await this.cancelPendingPlanExecution(managed, currentRecord)
        }).catch(error => sessionLog.error(`Session ${managed.id}: pending plan cold-load cancellation failed`, error))
      })
      return record
    }

    return record
  }

  /**
   * Clear pending plan execution state — the scoped recovery ACK, or an
   * explicit cancel. Identity is checked BEFORE any live mutation (after
   * hydrating under the lock): an omitted or mismatched `executionId` never
   * deletes an identified record, and no pre-hydration snapshot can authorize
   * the mutation. A terminally FAILED record is only cleared once its restore
   * is durably applied (or nothing needed restoring): matching ids alone do
   * not prove the snapshot reached the drafts store, and an unapplied
   * snapshot must stay recoverable. Pre-identity (legacy) records may be
   * cleared by anyone, matching the documented migration.
   */
  async clearPendingPlanExecution(sessionId: string, executionId?: string): Promise<void> {
    await this.withSessionLifecycleLock(sessionId, async () => {
      const managed = this.sessions.get(sessionId)
      if (!managed) return
      await this.ensureMessagesLoaded(managed)
      const record = managed.pendingPlanExecution
      if (record) {
        if (record.executionId !== undefined && executionId !== record.executionId) {
          sessionLog.info(`Session ${sessionId}: pending plan clear ignored (identity mismatch${executionId === undefined ? ' — no-identity command on an identified record' : ''})`)
          return
        }
        if (!record.failed && record.approvalMessageId) return
        if (!record.failed && record.executionId) {
          const receipt = getPlanDraftConsumption(sessionId, record.executionId)
          if (receipt?.text || receipt?.referenceKeys.length) {
            await this.cancelPendingPlanExecution(managed, record)
            return
          }
        }
        if (record.failed) {
          // Only components the DURABLE receipt says were consumed need
          // restoring; a read failure keeps the outbox (never guess).
          let receipt: import('@craft-agent/shared/config').PlanDraftConsumptionReceipt | null = null
          try {
            receipt = record.executionId ? getPlanDraftConsumption(sessionId, record.executionId) : null
          } catch (error) {
            sessionLog.info(`Session ${sessionId}: pending plan recovery ACK ignored — receipt unreadable`, error)
            return
          }
          const needsTextRestore = receipt?.text === true && !!record.draftInputSnapshot?.trim()
          const needsReferenceRestore = (receipt?.referenceKeys?.length ?? 0) > 0 && !!record.draftReferencesSnapshot?.length
          if ((needsTextRestore || needsReferenceRestore) && record.restoreId
            && !hasAppliedDraftRestore(sessionId, record.restoreId, record.executionId)) {
            sessionLog.info(`Session ${sessionId}: pending plan recovery ACK ignored — restore ${record.restoreId} is not durably applied; snapshot stays recoverable`)
            return
          }
        }
      }
      if (record) await this.commitPendingPlanExecution(managed, undefined)
      if (record?.executionId) retirePlanDraftConsumption(sessionId, record.executionId)
      sessionLog.info(`Session ${sessionId}: cleared pending plan execution`)
    })
  }

  /**
   * Get pending plan execution state for a session.
   * Used on reload/init to check if we need to resume plan execution.
   */
  getPendingPlanExecution(sessionId: string): {
    planPath: string
    draftInputSnapshot?: string
    draftReferencesSnapshot?: Reference[]
    awaitingCompaction: boolean
    executionDispatched: boolean
    executionId?: string
    restoreId?: string
    compactionTurn?: { generation: number; stopEpoch: number }
    approvalMessageId?: string
    approvalMessage?: string
    consumed?: { text?: boolean; references?: boolean }
    failed?: boolean
  } | null {
    const managed = this.sessions.get(sessionId)
    if (!managed) return null
    const record = managed.pendingPlanExecution ?? getStoredPendingPlanExecution(managed.workspace.rootPath, sessionId)
    if (!record) return null
    const failed = record.failed || (!managed.messagesLoaded && record.awaitingCompaction)
    if (failed) {
      const restored = this.pendingPlanRecoveryDraft(sessionId, record)
      return { ...record, failed: true, draftInputSnapshot: restored.text || undefined,
        draftReferencesSnapshot: restored.references, executionDispatched: record.executionDispatched === true }
    }
    return { ...record, executionDispatched: record.executionDispatched === true }
  }

  /**
   * Dispatch a plan approval for a session, equivalent to the desktop
   * "Accept plan" button. Switches the session out of Explore mode (safe)
   * into allow-all (or back to Guarded, see `planExecutionMode`) if needed so the plan can execute without per-tool
   * prompts, then sends the approval message through the normal sendMessage
   * path.
   */
  async acceptPlan(sessionId: string, _planPath?: string): Promise<void> {
    const managed = this.sessions.get(sessionId)
    if (!managed) {
      sessionLog.warn(`acceptPlan: session ${sessionId} not found`)
      return
    }

    if (managed.permissionMode === 'safe') {
      this.setSessionPermissionMode(sessionId, planExecutionMode(managed.previousPermissionMode))
    }

    await this.sendMessage(sessionId, PLAN_APPROVAL_MESSAGE)
  }

  // ============================================
  // Session Sharing
  // ============================================

  /**
   * Share session to the web viewer
   * Uploads session data and returns shareable URL
   */
  async shareToViewer(sessionId: string): Promise<import('@craft-agent/shared/protocol').ShareResult> {
    const managed = this.sessions.get(sessionId)
    if (!managed) {
      return { success: false, error: 'Session not found' }
    }

    // Signal async operation start for shimmer effect
    managed.isAsyncOperationOngoing = true
    this.sendEvent({ type: 'async_operation', sessionId, isOngoing: true }, managed.workspace.id)

    try {
      // Load session directly from disk (already in correct format)
      const storedSession = loadStoredSession(managed.workspace.rootPath, sessionId)
      if (!storedSession) {
        return { success: false, error: 'Session file not found' }
      }

      const { VIEWER_URL } = await import('@craft-agent/shared/branding')
      const response = await fetch(`${VIEWER_URL}/s/api`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(storedSession)
      })

      if (!response.ok) {
        sessionLog.error(`Share failed with status ${response.status}`)
        if (response.status === 413) {
          return { success: false, error: 'Session file is too large to share' }
        }
        return { success: false, error: 'Failed to upload session' }
      }

      const data = await response.json() as { id: string; url: string }

      // Store shared info in session
      managed.sharedUrl = data.url
      managed.sharedId = data.id
      const workspaceRootPath = managed.workspace.rootPath
      await updateSessionMetadata(workspaceRootPath, sessionId, {
        sharedUrl: data.url,
        sharedId: data.id,
      })

      sessionLog.info(`Session ${sessionId} shared at ${data.url}`)
      // Notify all windows for this workspace
      this.sendEvent({ type: 'session_shared', sessionId, sharedUrl: data.url }, managed.workspace.id)
      return { success: true, url: data.url }
    } catch (error) {
      sessionLog.error('Share error:', error)
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
    } finally {
      // Signal async operation end
      managed.isAsyncOperationOngoing = false
      this.sendEvent({ type: 'async_operation', sessionId, isOngoing: false }, managed.workspace.id)
    }
  }

  /**
   * Update an existing shared session
   * Re-uploads session data to the same URL
   */
  async updateShare(sessionId: string): Promise<import('@craft-agent/shared/protocol').ShareResult> {
    const managed = this.sessions.get(sessionId)
    if (!managed) {
      return { success: false, error: 'Session not found' }
    }
    if (!managed.sharedId) {
      return { success: false, error: 'Session not shared' }
    }

    // Signal async operation start for shimmer effect
    managed.isAsyncOperationOngoing = true
    this.sendEvent({ type: 'async_operation', sessionId, isOngoing: true }, managed.workspace.id)

    try {
      // Load session directly from disk (already in correct format)
      const storedSession = loadStoredSession(managed.workspace.rootPath, sessionId)
      if (!storedSession) {
        return { success: false, error: 'Session file not found' }
      }

      const { VIEWER_URL } = await import('@craft-agent/shared/branding')
      const response = await fetch(`${VIEWER_URL}/s/api/${managed.sharedId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(storedSession)
      })

      if (!response.ok) {
        sessionLog.error(`Update share failed with status ${response.status}`)
        if (response.status === 413) {
          return { success: false, error: 'Session file is too large to share' }
        }
        return { success: false, error: 'Failed to update shared session' }
      }

      sessionLog.info(`Session ${sessionId} share updated at ${managed.sharedUrl}`)
      return { success: true, url: managed.sharedUrl }
    } catch (error) {
      sessionLog.error('Update share error:', error)
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
    } finally {
      // Signal async operation end
      managed.isAsyncOperationOngoing = false
      this.sendEvent({ type: 'async_operation', sessionId, isOngoing: false }, managed.workspace.id)
    }
  }

  /**
   * Revoke a shared session
   * Deletes from viewer and clears local shared state
   */
  async revokeShare(sessionId: string): Promise<import('@craft-agent/shared/protocol').ShareResult> {
    const managed = this.sessions.get(sessionId)
    if (!managed) {
      return { success: false, error: 'Session not found' }
    }
    if (!managed.sharedId) {
      return { success: false, error: 'Session not shared' }
    }

    // Signal async operation start for shimmer effect
    managed.isAsyncOperationOngoing = true
    this.sendEvent({ type: 'async_operation', sessionId, isOngoing: true }, managed.workspace.id)

    try {
      const { VIEWER_URL } = await import('@craft-agent/shared/branding')
      const response = await fetch(
        `${VIEWER_URL}/s/api/${managed.sharedId}`,
        { method: 'DELETE' }
      )

      if (!response.ok) {
        sessionLog.error(`Revoke failed with status ${response.status}`)
        return { success: false, error: 'Failed to revoke share' }
      }

      // Clear shared info
      delete managed.sharedUrl
      delete managed.sharedId
      const workspaceRootPath = managed.workspace.rootPath
      await updateSessionMetadata(workspaceRootPath, sessionId, {
        sharedUrl: undefined,
        sharedId: undefined,
      })

      sessionLog.info(`Session ${sessionId} share revoked`)
      // Notify all windows for this workspace
      this.sendEvent({ type: 'session_unshared', sessionId }, managed.workspace.id)
      return { success: true }
    } catch (error) {
      sessionLog.error('Revoke error:', error)
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
    } finally {
      // Signal async operation end
      managed.isAsyncOperationOngoing = false
      this.sendEvent({ type: 'async_operation', sessionId, isOngoing: false }, managed.workspace.id)
    }
  }

  // ============================================
  // Session Sources
  // ============================================

  /**
   * Update session's enabled sources
   * If agent exists, builds and applies servers immediately.
   * Otherwise, servers will be built fresh on next message.
   */
  async setSessionSources(sessionId: string, sourceSlugs: string[]): Promise<void> {
    const managed = this.sessions.get(sessionId)
    if (!managed) {
      throw new Error(`Session not found: ${sessionId}`)
    }

    const workspaceRootPath = managed.workspace.rootPath
    sessionLog.info(`Setting sources for session ${sessionId}:`, sourceSlugs)

    // Clean up credential cache for sources being disabled (security)
    // This removes decrypted tokens from disk when sources are no longer active
    const previousSlugs = new Set(managed.enabledSourceSlugs || [])
    const newSlugs = new Set(sourceSlugs)
    const disabledSlugs = [...previousSlugs].filter(prevSlug => !newSlugs.has(prevSlug))
    if (disabledSlugs.length > 0) {
      try {
        await cleanupSourceRuntimeArtifacts(workspaceRootPath, disabledSlugs)
      } catch (err) {
        sessionLog.warn(`Failed to clean up source runtime artifacts: ${err}`)
      }
    }

    // Store the selection
    managed.enabledSourceSlugs = sourceSlugs

    // If agent exists, build and apply servers immediately
    if (managed.agent) {
      const sources = getSourcesBySlugs(workspaceRootPath, sourceSlugs)
      // Pass session path so large API responses can be saved to session folder
      const sessionPath = getSessionStoragePath(workspaceRootPath, sessionId)
      const { mcpServers, apiServers, errors } = await buildServersFromSources(sources, sessionPath, managed.tokenRefreshManager, managed.agent.getSummarizeCallback())
      if (errors.length > 0) {
        sessionLog.warn(`Source build errors:`, errors)
      }

      // Set all sources for context (agent sees full list with descriptions, including built-ins)
      const allSources = loadAllSources(workspaceRootPath)
      managed.agent.setAllSources(allSources)

      // Set active source servers (tools are only available from these)
      const intendedSlugs = sources.filter(isSourceUsable).map(s => s.config.slug)

      await managed.agent.setSourceServers(mcpServers, apiServers, intendedSlugs)

      sessionLog.info(`Applied ${Object.keys(mcpServers).length} MCP + ${Object.keys(apiServers).length} API sources to active agent (${allSources.length} total)`)
    }

    // Persist the session with updated sources
    this.persistSession(managed)

    // Notify renderer of the source change
    this.sendEvent({
      type: 'sources_changed',
      sessionId,
      enabledSourceSlugs: sourceSlugs,
    }, managed.workspace.id)

    sessionLog.info(`Session ${sessionId} sources updated: ${sourceSlugs.length} sources`)
  }

  /**
   * Get the enabled source slugs for a session
   */
  getSessionSources(sessionId: string): string[] {
    const managed = this.sessions.get(sessionId)
    return managed?.enabledSourceSlugs ?? []
  }

  /**
   * Get the last final assistant message ID from a list of messages
   * A "final" message is one where:
   * - role === 'assistant' AND
   * - isIntermediate !== true (not commentary between tool calls)
   * Returns undefined if no final assistant message exists
   */
  private getLastFinalAssistantMessageId(messages: Message[]): string | undefined {
    // Iterate backwards to find the most recent final assistant message
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i]
      if (msg.role === 'assistant' && !msg.isIntermediate) {
        return msg.id
      }
    }
    return undefined
  }

  /**
   * Set which session the user is actively viewing.
   * Called when user navigates to a session. Used to determine whether to mark
   * new messages as unread - if user is viewing, don't mark unread.
   */
  setActiveViewingSession(sessionId: string | null, workspaceId: string): void {
    if (sessionId) {
      this.activeViewingSession.set(workspaceId, sessionId)
      // When user starts viewing a session that's not processing, clear unread
      const managed = this.sessions.get(sessionId)
      if (managed && !managed.isProcessing && managed.hasUnread) {
        this.markSessionRead(sessionId)
      }
    } else {
      this.activeViewingSession.delete(workspaceId)
    }
  }

  /**
   * Clear active viewing session for a workspace.
   * Called when all windows leave a workspace to ensure read/unread state is correct.
   */
  clearActiveViewingSession(workspaceId: string): void {
    this.activeViewingSession.delete(workspaceId)
  }

  /**
   * Check if a session is currently being viewed by the user
   */
  private isSessionBeingViewed(sessionId: string, workspaceId: string): boolean {
    return this.activeViewingSession.get(workspaceId) === sessionId
  }

  /**
   * Mark a session as read by setting lastReadMessageId and clearing hasUnread.
   * Called when user navigates to a session (and it's not processing).
   */
  async markSessionRead(sessionId: string): Promise<void> {
    const managed = this.sessions.get(sessionId)
    if (!managed) return

    // Only mark as read if not currently processing
    // (user is viewing but we want to wait for processing to complete)
    if (managed.isProcessing) return

    let needsPersist = false
    const updates: { lastReadMessageId?: string; hasUnread?: boolean } = {}

    // Update lastReadMessageId for legacy/manual unread functionality
    if (managed.messages.length > 0) {
      const lastFinalId = this.getLastFinalAssistantMessageId(managed.messages)
      if (lastFinalId && managed.lastReadMessageId !== lastFinalId) {
        managed.lastReadMessageId = lastFinalId
        updates.lastReadMessageId = lastFinalId
        needsPersist = true
      }
    }

    // Clear hasUnread flag (primary source of truth for NEW badge)
    if (managed.hasUnread) {
      managed.hasUnread = false
      updates.hasUnread = false
      needsPersist = true
    }

    // Persist changes
    if (needsPersist) {
      const workspaceRootPath = managed.workspace.rootPath
      await updateSessionMetadata(workspaceRootPath, sessionId, updates)
      this.emitUnreadSummaryChanged()
    }
  }

  /**
   * Mark a session as unread by setting hasUnread flag.
   * Called when user manually marks a session as unread via context menu.
   */
  async markSessionUnread(sessionId: string): Promise<void> {
    const managed = this.sessions.get(sessionId)
    if (managed) {
      managed.hasUnread = true
      managed.lastReadMessageId = undefined
      // Persist to disk
      const workspaceRootPath = managed.workspace.rootPath
      await updateSessionMetadata(workspaceRootPath, sessionId, { hasUnread: true, lastReadMessageId: undefined })
      this.emitUnreadSummaryChanged()
    }
  }

  /**
   * Mark all non-hidden, non-archived sessions in a workspace as read.
   * Called from "Mark All Read" context menu on "All Sessions".
   */
  async markAllSessionsRead(workspaceId: string): Promise<void> {
    const updates: Promise<void>[] = []
    for (const managed of this.sessions.values()) {
      if (managed.workspace.id !== workspaceId) continue
      if (managed.hidden || managed.isArchived) continue
      if (managed.isProcessing) continue
      if (!managed.hasUnread) continue
      managed.hasUnread = false
      updates.push(
        updateSessionMetadata(managed.workspace.rootPath, managed.id, { hasUnread: false })
      )
    }
    if (updates.length > 0) {
      await Promise.all(updates)
      this.emitUnreadSummaryChanged()
    }
  }

  async renameSession(sessionId: string, name: string): Promise<void> {
    const managed = this.sessions.get(sessionId)
    if (managed) {
      managed.name = name
      this.persistSession(managed)
      // Notify renderer of the name change
      this.sendEvent({ type: 'title_generated', sessionId, title: name }, managed.workspace.id)
      // Workaround: Bun's fs.watch({ recursive: true }) on Linux doesn't track
      // directories created after the watcher started.
      // https://github.com/oven-sh/bun/issues/15939
      const watcher = this.configWatchers.get(managed.workspace.rootPath)
      watcher?.notifyFileChange(`sessions/${sessionId}/session.jsonl`)
    }
  }

  /**
   * Regenerate the session title based on recent messages.
   * Uses the last few user messages to capture what the session has evolved into.
   * Automatically uses the same provider as the session (Claude or OpenAI).
   */
  /**
   * Regenerate the session title. `onlyIfName` (automatic refreshes) keeps a title the user set
   * while the new one was being generated.
   */
  async refreshTitle(sessionId: string, options?: { onlyIfName?: string }): Promise<{ success: boolean; title?: string; error?: string }> {
    sessionLog.info(`refreshTitle called for session ${sessionId}`)
    const managed = this.sessions.get(sessionId)
    if (!managed) {
      sessionLog.warn(`refreshTitle: Session ${sessionId} not found`)
      return { success: false, error: 'Session not found' }
    }

    // Ensure messages are loaded from disk (lazy loading support)
    await this.ensureMessagesLoaded(managed)

    // Select a spread of user messages (first, middle, last) to capture the session's purpose
    const allUserContents = managed.messages
      .filter((m) => m.role === 'user')
      .map((m) => m.content)
    const userMessages = selectSpreadMessages(allUserContents)

    sessionLog.info(`refreshTitle: Selected ${userMessages.length} spread messages from ${allUserContents.length} total`)

    if (userMessages.length === 0) {
      sessionLog.warn(`refreshTitle: No user messages found`)
      return { success: false, error: 'No user messages to generate title from' }
    }

    // Get the most recent assistant response
    const lastAssistantMsg = managed.messages
      .filter((m) => m.role === 'assistant' && !m.isIntermediate)
      .slice(-1)[0]

    const assistantResponse = lastAssistantMsg?.content ?? ''

    // Resolve title language from the explicitly persisted UI language (disk-backed,
    // race-free vs. main-process i18n async hydration); undefined => auto-detect (#885).
    const titleLanguage = resolveTitleLanguageName()
    const titleOptions = { language: titleLanguage }
    sessionLog.info(`[refreshTitle] language at call time`, {
      sessionId,
      persistedUiLanguage: getPersistedUiLanguage() ?? null,
      resolvedLanguage: i18n.resolvedLanguage ?? null,
      titleLanguage: titleLanguage ?? null,
    })

    // Use existing agent or create temporary one
    let agent: AgentInstance | null = managed.agent
    let isTemporary = false

    if (!agent && managed.llmConnection) {
      try {
        const connection = getLlmConnection(managed.llmConnection)
        const resolvedMiniModel = connection ? (getMiniModel(connection) ?? connection.defaultModel) : undefined

        agent = createBackendFromConnection(managed.llmConnection, {
          workspace: managed.workspace,
          // Preserve the selected model as a fallback if the account rejects its mini model.
          model: managed.model,
          miniModel: resolvedMiniModel,
          session: {
            id: `title-${managed.id}`,
            workspaceRootPath: managed.workspace.rootPath,
            projectId: managed.projectId,
            llmConnection: managed.llmConnection,
            createdAt: Date.now(),
            lastUsedAt: Date.now(),
          },
          isHeadless: true,
        }, buildBackendHostRuntimeContext()) as AgentInstance
        await agent.postInit()
        isTemporary = true
        sessionLog.info(`refreshTitle: Created temporary agent for session ${sessionId}`)
      } catch (error) {
        sessionLog.error(`refreshTitle: Failed to create temporary agent:`, error)
        return { success: false, error: 'Failed to create agent for title generation' }
      }
    }

    if (!agent) {
      sessionLog.warn(`refreshTitle: No agent and no connection for session ${sessionId}`)
      return { success: false, error: 'No agent available' }
    }

    sessionLog.info(`refreshTitle: Calling agent.regenerateTitle...`)


    // Notify renderer that title regeneration has started (for shimmer effect)
    managed.isAsyncOperationOngoing = true
    this.sendEvent({ type: 'async_operation', sessionId, isOngoing: true }, managed.workspace.id)
    // Keep legacy event for backward compatibility
    this.sendEvent({ type: 'title_regenerating', sessionId, isRegenerating: true }, managed.workspace.id)

    try {
      const title = await agent.regenerateTitle(userMessages, assistantResponse, titleOptions)
      sessionLog.info(`refreshTitle: regenerateTitle returned: ${title ? `"${title}"` : 'null'}`)
      if (title && options?.onlyIfName !== undefined && managed.name !== options.onlyIfName) {
        sessionLog.info(`refreshTitle: session ${sessionId} was renamed meanwhile, keeping "${managed.name}"`)
        this.sendEvent({ type: 'title_regenerating', sessionId, isRegenerating: false }, managed.workspace.id)
        return { success: false, error: 'Renamed meanwhile' }
      }
      if (title) {
        managed.name = title
        managed.autoTitle = title
        this.persistSession(managed)
        // title_generated will also clear isRegeneratingTitle via the event handler
        this.sendEvent({ type: 'title_generated', sessionId, title }, managed.workspace.id)
        sessionLog.info(`Refreshed title for session ${sessionId}: "${title}"`)
        return { success: true, title }
      }
      // Failed to generate - clear regenerating state
      this.sendEvent({ type: 'title_regenerating', sessionId, isRegenerating: false }, managed.workspace.id)
      return { success: false, error: 'Failed to generate title' }
    } catch (error) {
      // Error occurred - clear regenerating state
      this.sendEvent({ type: 'title_regenerating', sessionId, isRegenerating: false }, managed.workspace.id)
      const message = error instanceof Error ? error.message : 'Unknown error'
      sessionLog.error(`Failed to refresh title for session ${sessionId}:`, error)
      return { success: false, error: message }
    } finally {
      // Clean up temporary agent
      if (isTemporary && agent) {
        agent.destroy()
      }
      // Signal async operation end
      managed.isAsyncOperationOngoing = false
      this.sendEvent({ type: 'async_operation', sessionId, isOngoing: false }, managed.workspace.id)
    }
  }

  /**
   * Update the working directory for a session.
   *
   * If no messages have been sent yet (no SDK interaction), also updates sdkCwd
   * so the SDK will use the new path for transcript storage. This prevents the
   * confusing "bash shell runs from a different directory" warning when the user
   * changes the working directory before their first message.
   */
  updateWorkingDirectory(sessionId: string, path: string): void {
    const managed = this.sessions.get(sessionId)
    if (managed) {
      const validation = isValidWorkingDirectory(path)
      if (!validation.valid) {
        sessionLog.warn(`Session ${sessionId}: rejected working directory "${path}" — ${validation.reason}`)
        this.sendEvent({
          type: 'working_directory_error',
          sessionId,
          error: validation.reason!,
        }, managed.workspace.id)
        return
      }

      managed.workingDirectory = path

      // Invalidate filesystem caches that depend on working directory
      invalidateContextFileCache(path)
      invalidateSkillsCache()

      // Check if we can also update sdkCwd (safe if no SDK interaction yet)
      // Conditions: no messages sent AND no agent created yet (no SDK session)
      const shouldUpdateSdkCwd =
        managed.messages.length === 0 &&
        !managed.sdkSessionId &&
        !managed.agent

      if (shouldUpdateSdkCwd) {
        managed.sdkCwd = path
        sessionLog.info(`Session ${sessionId}: sdkCwd updated to ${path} (no prior interaction)`)
      }

      // Also update the agent's session config if agent exists
      if (managed.agent) {
        managed.agent.updateWorkingDirectory(path)
        // If agent exists but conditions still allow sdkCwd update (edge case),
        // update the agent's sdkCwd as well
        if (shouldUpdateSdkCwd) {
          managed.agent.updateSdkCwd(path)
        }
      }

      this.persistSession(managed)
      // Notify renderer of the working directory change
      this.sendEvent({ type: 'working_directory_changed', sessionId, workingDirectory: path }, managed.workspace.id)
    }
  }

  /**
   * Update the model for a session
   * Pass null to clear the session-specific model (will use global config)
   * @param connection - Optional LLM connection slug (only applied if not already locked)
   */
  async updateSessionModel(sessionId: string, workspaceId: string, model: string | null, connection?: string): Promise<void> {
    sessionLog.info(`[updateSessionModel] sessionId=${sessionId}, model=${model}, connection=${connection}`)
    const managed = this.sessions.get(sessionId)
    if (managed) {
      managed.model = model ?? undefined
      // Also update connection if provided and not already locked
      if (connection && !managed.connectionLocked) {
        managed.llmConnection = connection
      }
      // Persist to disk (include connection if it was updated)
      const updates: { model?: string; llmConnection?: string } = { model: model ?? undefined }
      if (connection && !managed.connectionLocked) {
        updates.llmConnection = connection
      }
      await updateSessionMetadata(managed.workspace.rootPath, sessionId, updates)
      // Update agent model if it already exists (takes effect on next query)
      if (managed.agent) {
        // Fallback chain: session model > workspace default > connection default
        const wsConfig = loadWorkspaceConfig(managed.workspace.rootPath)
        const sessionConn = resolveSessionConnection(managed.llmConnection, wsConfig?.defaults?.defaultLlmConnection)
        const effectiveModel = model ?? wsConfig?.defaults?.model ?? sessionConn?.defaultModel!
        sessionLog.info(`[updateSessionModel] Calling agent.setModel(${effectiveModel}) [agent exists=${!!managed.agent}, connectionLocked=${managed.connectionLocked}]`)
        managed.agent.setModel(effectiveModel)
      } else {
        sessionLog.info(`[updateSessionModel] No agent yet, model will apply on next agent creation`)
      }
      // Notify renderer of the model change
      this.sendEvent({ type: 'session_model_changed', sessionId, model }, managed.workspace.id)
      sessionLog.info(`Session ${sessionId} model updated to: ${model ?? '(global config)'}`)
    }
  }

  /**
   * Update the content of a specific message in a session
   * Used by preview window to save edited content back to the original message
   */
  updateMessageContent(sessionId: string, messageId: string, content: string): void {
    const managed = this.sessions.get(sessionId)
    if (!managed) {
      sessionLog.warn(`Cannot update message: session ${sessionId} not found`)
      return
    }

    const message = managed.messages.find(m => m.id === messageId)
    if (!message) {
      sessionLog.warn(`Cannot update message: message ${messageId} not found in session ${sessionId}`)
      return
    }

    // Update the message content
    message.content = content
    // Persist the updated session
    this.persistSession(managed)
    sessionLog.info(`Updated message ${messageId} content in session ${sessionId}`)
  }

  /**
   * Add an annotation to a message and persist the session.
   */
  addMessageAnnotation(sessionId: string, messageId: string, annotation: NonNullable<Message['annotations']>[number]): void {
    const managed = this.sessions.get(sessionId)
    if (!managed) {
      sessionLog.warn(`Cannot add annotation: session ${sessionId} not found`)
      return
    }

    const message = managed.messages.find(m => m.id === messageId)
    if (!message) {
      sessionLog.warn(`Cannot add annotation: message ${messageId} not found in session ${sessionId}`)
      return
    }

    if (!annotation?.id || !annotation?.target?.selectors?.length) {
      sessionLog.warn(`Cannot add annotation: invalid annotation payload for message ${messageId}`)
      return
    }

    if (annotation.target.source.messageId !== messageId) {
      sessionLog.warn(`Cannot add annotation: target source.messageId mismatch (${annotation.target.source.messageId} !== ${messageId})`)
      return
    }

    const safeAnnotation: NonNullable<Message['annotations']>[number] = {
      ...annotation,
      schemaVersion: 1,
      target: {
        ...annotation.target,
        source: {
          ...annotation.target.source,
          sessionId,
          messageId,
        },
      },
    }

    const annotationBytes = Buffer.byteLength(JSON.stringify(safeAnnotation), 'utf8')
    if (annotationBytes > MAX_ANNOTATION_JSON_BYTES) {
      sessionLog.warn(`Cannot add annotation: payload too large (${annotationBytes} bytes > ${MAX_ANNOTATION_JSON_BYTES}) on message ${messageId}`)
      return
    }

    const existing = message.annotations ?? []
    if (existing.some(a => a.id === safeAnnotation.id)) {
      sessionLog.warn(`Cannot add annotation: duplicate annotation id ${safeAnnotation.id} on message ${messageId}`)
      return
    }

    if (existing.length >= MAX_ANNOTATIONS_PER_MESSAGE) {
      sessionLog.warn(`Cannot add annotation: per-message limit reached (${MAX_ANNOTATIONS_PER_MESSAGE}) on message ${messageId}`)
      return
    }

    message.annotations = [...existing, safeAnnotation]
    this.persistSession(managed)
    this.sendEvent({ type: 'message_annotations_updated', sessionId, messageId, annotations: message.annotations }, managed.workspace.id)
  }

  /**
   * Patch an existing annotation on a message.
   */
  updateMessageAnnotation(
    sessionId: string,
    messageId: string,
    annotationId: string,
    patch: Partial<NonNullable<Message['annotations']>[number]>
  ): void {
    const managed = this.sessions.get(sessionId)
    if (!managed) {
      sessionLog.warn(`Cannot update annotation: session ${sessionId} not found`)
      return
    }

    const message = managed.messages.find(m => m.id === messageId)
    if (!message) {
      sessionLog.warn(`Cannot update annotation: message ${messageId} not found in session ${sessionId}`)
      return
    }

    const existing = message.annotations ?? []
    const idx = existing.findIndex(a => a.id === annotationId)
    if (idx === -1) {
      sessionLog.warn(`Cannot update annotation: annotation ${annotationId} not found on message ${messageId}`)
      return
    }

    if (patch.target?.source?.messageId && patch.target.source.messageId !== messageId) {
      sessionLog.warn(`Cannot update annotation: target source.messageId mismatch in patch (${patch.target.source.messageId} !== ${messageId})`)
      return
    }

    if (patch.target?.selectors && patch.target.selectors.length === 0) {
      sessionLog.warn(`Cannot update annotation: empty selectors patch for annotation ${annotationId} on message ${messageId}`)
      return
    }

    const current = existing[idx]!
    const updated = {
      ...current,
      ...patch,
      id: current.id,
      schemaVersion: current.schemaVersion,
      target: patch.target
        ? {
            ...current.target,
            ...patch.target,
            source: {
              ...current.target.source,
              ...(patch.target.source ?? {}),
              sessionId,
              messageId,
            },
          }
        : {
            ...current.target,
            source: {
              ...current.target.source,
              sessionId,
              messageId,
            },
          },
      updatedAt: Date.now(),
    }

    const updatedBytes = Buffer.byteLength(JSON.stringify(updated), 'utf8')
    if (updatedBytes > MAX_ANNOTATION_JSON_BYTES) {
      sessionLog.warn(`Cannot update annotation: payload too large (${updatedBytes} bytes > ${MAX_ANNOTATION_JSON_BYTES}) for annotation ${annotationId} on message ${messageId}`)
      return
    }

    const next = [...existing]
    next[idx] = updated
    message.annotations = next
    this.persistSession(managed)
    this.sendEvent({ type: 'message_annotations_updated', sessionId, messageId, annotations: message.annotations }, managed.workspace.id)
  }

  /**
   * Remove an annotation from a message and persist the session.
   */
  removeMessageAnnotation(sessionId: string, messageId: string, annotationId: string): void {
    const managed = this.sessions.get(sessionId)
    if (!managed) {
      sessionLog.warn(`Cannot remove annotation: session ${sessionId} not found`)
      return
    }

    const message = managed.messages.find(m => m.id === messageId)
    if (!message) {
      sessionLog.warn(`Cannot remove annotation: message ${messageId} not found in session ${sessionId}`)
      return
    }

    const existing = message.annotations ?? []
    if (!existing.some(a => a.id === annotationId)) {
      sessionLog.warn(`Cannot remove annotation: annotation ${annotationId} not found on message ${messageId}`)
      return
    }

    message.annotations = existing.filter(a => a.id !== annotationId)
    this.persistSession(managed)
    this.sendEvent({ type: 'message_annotations_updated', sessionId, messageId, annotations: message.annotations }, managed.workspace.id)
  }

  async deleteSession(sessionId: string): Promise<void> {
    return this.withSessionLifecycleLock(sessionId, () => this.deleteSessionLocked(sessionId))
  }

  private async deleteSessionLocked(sessionId: string): Promise<void> {
    const managed = this.sessions.get(sessionId)
    if (!managed) {
      sessionLog.warn(`Cannot delete session: ${sessionId} not found`)
      return
    }

    // Get workspace slug before deleting
    const workspaceRootPath = managed.workspace.rootPath

    // If processing is in progress, force-abort via Query.close() and wait for cleanup
    if (managed.isProcessing && managed.agent) {
      managed.agent.forceAbort(AbortReason.UserStop)
      // Brief wait for the query to finish tearing down before we delete session files.
      // Prevents file corruption from overlapping writes during rapid delete operations.
      await new Promise(resolve => setTimeout(resolve, 100))
    }

    // Revoke share if session was shared (prevent orphaned viewer copies)
    if (managed.sharedId) {
      try {
        const { VIEWER_URL } = await import('@craft-agent/shared/branding')
        const response = await fetch(
          `${VIEWER_URL}/s/api/${managed.sharedId}`,
          { method: 'DELETE', signal: AbortSignal.timeout(5000) }
        )
        if (!response.ok) {
          sessionLog.warn(`Failed to revoke share for ${sessionId}: HTTP ${response.status}`)
        } else {
          sessionLog.info(`Revoked share for deleted session ${sessionId}`)
        }
      } catch (error) {
        sessionLog.warn(`Failed to revoke share for ${sessionId}:`, error)
      }
    }

    // Clean up delta flush timers to prevent orphaned timers
    const timer = this.deltaFlushTimers.get(sessionId)
    if (timer) {
      clearTimeout(timer)
      this.deltaFlushTimers.delete(sessionId)
    }
    this.pendingDeltas.delete(sessionId)
    this.clearAdminRememberApprovalsForSession(sessionId)
    this.clearPendingPermissionRequestsForSession(sessionId)

    // Cancel any pending persistence write (session is being deleted, no need to save)
    sessionPersistenceQueue.cancel(sessionId)

    // Clean up session-scoped tool callbacks to prevent memory accumulation
    unregisterSessionScopedToolCallbacks(sessionId)

    // Make the Chat unavailable to Browser target validation before cleanup starts.
    // This prevents a new Browser from binding in the cleanup/delete race window.
    this.sessions.delete(sessionId)

    // Dispose agent to clean up ConfigWatchers, event listeners, MCP connections
    if (managed.agent) {
      try {
        managed.agent.dispose()
      } catch (error) {
        sessionLog.warn(`Failed to dispose agent for deleted session ${sessionId}:`, error)
      }
    }

    // Stop pool server (HTTP MCP server for external SDK subprocesses)
    if (managed.poolServer) {
      managed.poolServer.stop().catch(err => {
        sessionLog.warn(`Failed to stop pool server for ${sessionId}: ${err instanceof Error ? err.message : err}`)
      })
    }

    // Cancel any pending source-activation auto-retry timer (craft-agents-oss#804).
    if (managed.autoRetryTimer) {
      clearTimeout(managed.autoRetryTimer)
      managed.autoRetryTimer = undefined
    }
    managed.autoRetryPending = undefined

    // Clean up session metadata in AutomationSystem (prevents memory leak)
    const automationSystem = this.automationSystems.get(workspaceRootPath)
    if (automationSystem) {
      automationSystem.removeSessionMetadata(sessionId)
    }

    // Delete from disk too
    await deleteSessionAsync(workspaceRootPath, sessionId)
    purgeSessionDraft(sessionId)

    // Notify all windows for this workspace that the session was deleted
    this.sendEvent({ type: 'session_deleted', sessionId }, managed.workspace.id)
    this.emitUnreadSummaryChanged()

    // Clean up Browser windows only after the authoritative in-memory and disk
    // deletion is visible. A slow remote client must not leave a half-deleted Chat.
    await this.destroyBrowserWindowsForSession(managed.workspace.id, sessionId)
    this.remoteBpms.delete(sessionId)
    this.browserHostByCanvas.delete(sessionId)
    this.drawnixHostBySession.delete(sessionId)

    // Clean up attachments directory (handled by deleteStoredSession for workspace-scoped storage)
    sessionLog.info(`Deleted session ${sessionId}`)
  }

  /** Atomically choose host ownership or cancel a request whose RPC response was lost. */
  async reconcileInput(sessionId: string, clientMessageId: string): Promise<
    { state: 'owned'; messageId: string } | { state: 'not_accepted' }
  > {
    if (typeof clientMessageId !== 'string' || !clientMessageId || clientMessageId.length > 180) {
      throw new Error('Invalid input identity')
    }
    return this.withSessionLifecycleLock(sessionId, async () => {
      const managed = this.sessions.get(sessionId)
      if (!managed) throw new Error(`Session ${sessionId} not found`)
      if (!managed.messagesLoaded && !loadStoredSession(managed.workspace.rootPath, sessionId)) {
        throw new Error(`Cannot read input ownership for session ${sessionId}`)
      }
      await this.ensureMessagesLoaded(managed)
      if (this.sessions.get(sessionId) !== managed) throw new Error(`Session ${sessionId} was deleted`)
      // A staged row is not proof of ownership until its first write settles.
      // Validation with no row may be cancelled immediately, even if its IO is stuck.
      if (managed.messages.some(message => message.clientMessageId === clientMessageId)) {
        await managed.pendingInputCommits?.get(clientMessageId)
      }
      if (this.sessions.get(sessionId) !== managed) throw new Error(`Session ${sessionId} was deleted`)
      const owned = managed.messages.find(message => message.role === 'user' && message.clientMessageId === clientMessageId)
      const restoredMessageId = managed.restoredInputIds && Object.hasOwn(managed.restoredInputIds, clientMessageId)
        ? managed.restoredInputIds[clientMessageId] : undefined
      if (owned || restoredMessageId) {
        this.persistSession(managed)
        await this.flushSessionStrict(sessionId)
        return { state: 'owned', messageId: owned?.id ?? restoredMessageId! }
      }
      // Keep the tombstone even if the write fails. A retry must durably commit
      // it before reporting absence, and a late sender must never win meanwhile.
      if (!managed.cancelledInputIds?.includes(clientMessageId)) {
        (managed.cancelledInputIds ??= []).push(clientMessageId)
      }
      for (const [release, inputId] of managed.pendingSendAdmissions ?? []) {
        if (inputId === clientMessageId) release()
      }
      this.persistSession(managed)
      await this.flushSessionStrict(sessionId)
      return { state: 'not_accepted' }
    })
  }

  async sendMessage(
    sessionId: string,
    message: string,
    attachments?: FileAttachment[],
    storedAttachments?: StoredAttachment[],
    options?: SendMessageOptions,
    existingMessageId?: string,
    _isAuthRetry?: boolean,
    /**
     * Internal hook fired after the user message has been pushed to
     * `managed.messages` and persisted to disk, but before the model-streaming
     * work begins. The RPC handler uses this to send a synchronous "accepted"
     * ack to the client so a crash mid-stream doesn't lose the user message
     * (#616). Pre-persist errors still reject the outer promise as before.
     */
    onAck?: (messageId: string) => void,
    /**
     * Optional transport context. The `sessions.sendMessage` RPC handler passes
     * `{ callerClientId: ctx.clientId }` so the SM can pin the desktop client
     * that should host this session's browser tools. Pass undefined when calling
     * directly (tests, intra-server flows) to leave the existing pin in place.
     */
    rpcContext?: { callerClientId?: string },
    /**
     * Server-owned continuation context (source activation or auth retry). This
     * parameter is internal to the SM process: the SEND_MESSAGE RPC handler
     * never forwards it, so a renderer payload cannot forge it. Trust is
     * established by object identity against the live dedup slot — the
     * references were validated and persisted by the server when the
     * interrupted turn started.
     */
    internalContinuation?: { activationReferences?: Reference[]; authRetry?: { generation: number; stopEpoch: number } },
  ): Promise<void> {
    const managed = this.sessions.get(sessionId)
    if (!managed) {
      throw new Error(`Session ${sessionId} not found`)
    }
    const admissionEpoch = managed.stopEpoch ?? 0
    const clientMessageId = !existingMessageId && !_isAuthRetry ? options?.optimisticMessageId : undefined
    if (clientMessageId !== undefined && (!clientMessageId || clientMessageId.length > 180)) {
      throw new Error('Invalid input identity')
    }
    const previousAdmission = managed.sendAdmissionTail
    let resolveAdmission!: () => void
    const admission = new Promise<void>(resolve => { resolveAdmission = resolve })
    managed.sendAdmissionTail = admission
    const releaseAdmission = () => {
      managed.pendingSendAdmissions?.delete(releaseAdmission)
      const stopped = (managed.stopEpoch ?? 0) !== admissionEpoch
      if (managed.sendAdmissionTail === admission) managed.sendAdmissionTail = stopped ? undefined : previousAdmission
      // Cancelling B in A -> B -> C must not let C overtake the still-valid A.
      // Stop invalidates the entire epoch, so its new input may start afresh.
      if (previousAdmission && !stopped) void previousAdmission.then(resolveAdmission)
      else resolveAdmission()
    }
    ;(managed.pendingSendAdmissions ??= new Map()).set(releaseAdmission, clientMessageId)
    let resolveCommit!: () => void
    const commit = new Promise<void>(resolve => { resolveCommit = resolve })
    const finishCommit = () => {
      if (clientMessageId && managed.pendingInputCommits?.get(clientMessageId) === commit) {
        managed.pendingInputCommits.delete(clientMessageId)
      }
      resolveCommit()
    }
    let admittedMessage: Message | undefined
    let admittedGeneration: number | undefined
    let durable = false
    const acknowledge = (messageId: string) => { durable = true; finishCommit(); onAck?.(messageId) }
    const assertAdmission = () => {
      if (this.sessions.get(sessionId) !== managed || (managed.stopEpoch ?? 0) !== admissionEpoch
        || clientMessageId && managed.cancelledInputIds?.includes(clientMessageId)) {
        throw new Error('INPUT_CANCELLED: input was stopped before delivery')
      }
    }
    try {
      if (managed.stopBarrier) await managed.stopBarrier
      if (previousAdmission) await previousAdmission
      assertAdmission()
      const trackedPlanRecord = existingMessageId && managed.pendingPlanExecution?.approvalMessageId === existingMessageId
        ? managed.pendingPlanExecution
        : undefined
      const trackedApprovalExecutionId = trackedPlanRecord?.executionId
      const approvalStopEpoch = managed.stopEpoch ?? 0
      const authRetry = _isAuthRetry ? internalContinuation?.authRetry : undefined
      const ownsAuthRetry = () => (managed.stopEpoch ?? 0) === admissionEpoch
        && !(clientMessageId && managed.cancelledInputIds?.includes(clientMessageId))
        && (!authRetry || this.sessions.get(sessionId) === managed
        && managed.processingGeneration === authRetry.generation
        && (managed.stopEpoch ?? 0) === authRetry.stopEpoch && managed.authRetryInProgress === true)
      if (!ownsAuthRetry()) return
      const queueReplay = existingMessageId && managed.pendingQueueReplay?.entries[0]?.messageId === existingMessageId
        ? managed.pendingQueueReplay : undefined
      this.setLastMessageClientId(sessionId, rpcContext?.callerClientId)

      // Source-activation auto-retry dedup (craft-agents-oss#804). When the server
      // has just scheduled or committed a "[<slug> activated]" retry, drop a matching
      // duplicate that arrives from a legacy renderer still running the client-side
      // auto_retry. The first matching caller wins (server timer or legacy RPC,
      // whichever arrives first), subsequent matching calls within the deadline drop.
      //
      // Trust model for the retry's references: the primary path is the
      // server-owned continuation context, matched by object identity against the
      // live dedup slot (unforgeable from the RPC surface). The legacy plain/retry
      // content match below is only a compatibility adapter into the SAME
      // server-owned snapshot — never an independent source of trust.
      const autoRetryClaimedAt = Date.now()
      const pendingAutoRetry = managed.autoRetryPending
      const legacyMatch = pendingAutoRetry !== undefined
        && autoRetryClaimedAt < pendingAutoRetry.deadlineMs
        && (message === pendingAutoRetry.content || message === pendingAutoRetry.retryContent)
      // A persisted continuation's own queue replay is delivery, not a duplicate RPC.
      let activationResend = managed.pendingActivationResend !== undefined && managed.pendingActivationResend === message
        || existingMessageId !== undefined && pendingAutoRetry?.deliveryMessageId === existingMessageId
          && message === pendingAutoRetry.retryContent
      if (activationResend) {
        managed.pendingActivationResend = undefined
        if (managed.autoRetryPending) managed.autoRetryPending.committed = true
      }
      const continuationReferences = internalContinuation?.activationReferences !== undefined
        && pendingAutoRetry?.references === internalContinuation.activationReferences
        ? pendingAutoRetry.references
        : undefined
      if (!activationResend && claimAutoRetryPending(managed, message, autoRetryClaimedAt) === 'drop') {
        sessionLog.info(`sendMessage: dropped duplicate source-activation retry for ${sessionId}`)
        return
      }
      const activationSlot = activationResend || legacyMatch ? pendingAutoRetry : undefined
      if (activationSlot) {
        activationResend = true
        options = { ...options, hidden: true }
        if (managed.autoRetryTimer) clearTimeout(managed.autoRetryTimer)
        managed.autoRetryTimer = undefined
        if (activationSlot.scheduledGeneration === managed.processingGeneration) {
          this.recoverPendingSteers(managed)
          const owned = activationSlot.ownedSteers ??= []
          if (activationSlot.originalContent !== undefined && activationSlot.sourceSlug) {
            activationSlot.retryContent = buildActivationRetryMessage(
              activationSlot.originalContent, managed.turnSteers ?? [], activationSlot.sourceSlug,
            ).retry
          }
          const ids = [...(managed.lastSentMessageIds ?? []), ...owned.flatMap(steer => steer.messageId ? [steer.messageId] : [])]
          activationSlot.references = activationTurnReferences(managed.messages, ids, {
            references: activationSlot.references,
          })
        }
        message = activationSlot.retryContent ?? message
        attachments = activationSlot.attachments
        storedAttachments = activationSlot.storedAttachments
      }
      if (!activationResend && !_isAuthRetry) managed.turnFromUser = !options?.hidden
      const pendingAutoRetryReferences = activationSlot?.references ?? continuationReferences
        ?? (legacyMatch ? pendingAutoRetry?.references : undefined)
      if (pendingAutoRetryReferences) {
        options = {
          ...options,
          references: pendingAutoRetryReferences,
        }
      }

      // Clear any pending plan execution state when a new user message is sent.
      // The explicit /compact turn immediately after "Accept & Compact" is the
      // one exception: that command is what transitions the pending record from
      // awaiting → ready. Any other message remains a safety valve that cancels
      // it. The cancellation runs inside the session lifecycle lock so it shares
      // a serialized boundary with the pending-plan commit (a dispatch whose
      // validation is awaiting filesystem IO re-checks the live record under the
      // same lock and aborts when user intent has moved on) — identity-scoped on
      // the record captured HERE (a replacement created while this send was
      // starting is never blindly deleted). Records already committed to
      // execution (dispatched, delivery-tracked) are skipped: their approval is
      // durably enqueued ahead of this message and delivery owns the cleanup.
      // A terminally failed record is a durable restore outbox that new input
      // never clears; only the scoped recovery ACK removes it.
      const isCompactCommand = /^\/compact(\s|$)/i.test(message.trim())
      if (!isCompactCommand) {
        await this.withSessionLifecycleLock(sessionId, async () => {
          await this.ensureMessagesLoaded(managed)
          if (this.sessions.get(sessionId) !== managed || !ownsAuthRetry()) return
          const supersededPlan = managed.pendingPlanExecution
          if (
            supersededPlan
            && !supersededPlan.failed
            && supersededPlan.approvalMessageId === undefined
          ) {
            const receipt = supersededPlan.executionId ? getPlanDraftConsumption(sessionId, supersededPlan.executionId) : null
            if (receipt?.text || receipt?.referenceKeys.length) {
              await this.cancelPendingPlanExecution(managed, supersededPlan)
            } else {
              await this.commitPendingPlanExecution(managed, undefined)
              if (supersededPlan.executionId) retirePlanDraftConsumption(sessionId, supersededPlan.executionId)
            }
          }
        })
      }

      // Ensure messages are loaded before we try to add new ones
      await this.ensureMessagesLoaded(managed)
      if (this.sessions.get(sessionId) !== managed || !ownsAuthRetry()) return

      assertAdmission()
      if (!existingMessageId && options?.optimisticMessageId) {
        const restoredMessageId = managed.restoredInputIds && Object.hasOwn(managed.restoredInputIds, options.optimisticMessageId)
          ? managed.restoredInputIds[options.optimisticMessageId] : undefined
        if (restoredMessageId) {
          this.persistSession(managed)
          await this.flushSessionStrict(sessionId)
          assertAdmission()
          acknowledge(restoredMessageId)
          return
        }
        const accepted = managed.messages.find(candidate => candidate.role === 'user'
          && candidate.clientMessageId === options?.optimisticMessageId)
        if (accepted) {
          if (accepted.content !== message || JSON.stringify(accepted.references ?? []) !== JSON.stringify(options.references ?? [])
            || JSON.stringify(accepted.attachments ?? []) !== JSON.stringify(storedAttachments ?? [])) {
            throw new Error('INPUT_ID_CONFLICT: input identity belongs to a different payload')
          }
          this.persistSession(managed)
          await this.flushSessionStrict(sessionId)
          assertAdmission()
          acknowledge(accepted.id)
          return
        }
      }

      const existingUserMessage = existingMessageId
        ? managed.messages.find(candidate => (
            candidate.id === existingMessageId && candidate.role === 'user'
          ))
        : undefined
      if (existingMessageId && !existingUserMessage) {
        throw new Error(`Existing message ${existingMessageId} not found`)
      }
      // Cold replay has only stored metadata. Rebuild the payload from this
      // session's copied files before admission, preserving display and Office
      // paths required by the backend. Fresh caller metadata never grants reads.
      if (!attachments?.length && existingUserMessage?.attachments?.length) {
        const attachmentsRoot = await realpath(getSessionAttachmentsPath(managed.workspace.rootPath, sessionId))
        attachments = []
        storedAttachments = existingUserMessage.attachments
        for (const stored of storedAttachments) {
          const [storedPath, markdownPath] = await Promise.all([
            realpath(stored.storedPath),
            stored.markdownPath ? realpath(stored.markdownPath) : undefined,
          ])
          for (const filePath of [storedPath, markdownPath]) {
            if (!filePath) continue
            const within = relative(attachmentsRoot, filePath)
            if (within === '..' || within.startsWith(`..${sep}`) || isAbsolute(within)) {
              throw new Error(`Queued attachment is outside this session: ${stored.name}`)
            }
          }
          const attachment = readFileAttachment(storedPath, stored.type)
          if (!attachment) throw new Error(`Queued attachment could not be read: ${stored.name}`)
          attachment.name = stored.name
          attachment.mimeType = stored.mimeType
          attachment.storedPath = stored.storedPath
          if (markdownPath) attachment.markdownPath = stored.markdownPath
          attachments.push(attachment)
        }
      }
      const referenceValues = existingUserMessage?.references ?? options?.references
      const shouldReusePersistedReferences = Boolean(
        existingUserMessage || _isAuthRetry || pendingAutoRetryReferences,
      )

      if (referenceValues && !shouldReusePersistedReferences) {
        for (const reference of referenceValues) {
          if (!isChatMessageReference(reference)) continue
          const source = this.sessions.get(reference.sessionId)
          if (source) await this.ensureMessagesLoaded(source)
        }
      }
      const referenceTarget = {
        id: managed.id,
        workspaceId: managed.workspace.id,
        projectId: managed.projectId,
      }
      let references: Reference[] = []
      if (referenceValues) {
        references = shouldReusePersistedReferences
          ? normalizeReferencesForSession(referenceValues, referenceTarget)
          : validateReferencesForSession(
            referenceValues,
            referenceTarget,
            sourceId => {
              const source = this.sessions.get(sourceId)
              return source ? {
                id: source.id,
                workspaceId: source.workspace.id,
                projectId: source.projectId,
                messages: source.messages,
              } : null
            },
          )
      }
      if (!shouldReusePersistedReferences) {
        await validateProjectFileReferencesForSend(references, managed.workspace.rootPath)
      }
      if (this.sessions.get(sessionId) !== managed || !ownsAuthRetry()) return
      if (activationSlot && managed.autoRetryPending !== activationSlot) return
      if (queueReplay && (managed.pendingQueueReplay !== queueReplay
        || (managed.stopEpoch ?? 0) !== queueReplay.stopEpoch)) return
      const currentApproval = managed.pendingPlanExecution
      if (trackedPlanRecord && (
        this.sessions.get(sessionId) !== managed
        || !currentApproval
        || currentApproval.executionId !== trackedApprovalExecutionId
        || currentApproval.approvalMessageId !== existingMessageId
        || currentApproval.failed
        || !currentApproval.executionDispatched
        || (managed.stopEpoch ?? 0) !== approvalStopEpoch
        || managed.stopRequested
        || queueReplay && managed.pendingQueueReplay !== queueReplay
      )) return
      const messageForModel = formatReferencesForModel(message, references)
      const recoveredActivationSteers = !activationSlot && pendingAutoRetry
        && (!pendingAutoRetry.committed || (pendingAutoRetry.ownedSteers?.length ?? 0) > 0)
        ? this.recoverActivationSteers(managed, pendingAutoRetry)
        : false

      // If currently processing, behavior depends on the connection's
      // `midStreamBehavior` (resolved via {@link resolveMidStreamBehavior},
      // defaults to provider-appropriate value):
      //
      // - 'steer': try to deliver into the in-flight turn. Pi steers natively;
      //   Claude emulates via PreToolUse hook. If `redirect()` returns false
      //   (Claude with no live query, or backend can't steer), the backend has
      //   already called forceAbort(Redirect) and we queue for replay.
      // - 'queue': hold the message untouched; the current turn keeps running
      //   to natural completion; replay as a new turn afterwards. NO call to
      //   `agent.redirect()`, NO forceAbort, NO interruption.
      if (managed.isProcessing || managed.pendingQueueReplay && managed.pendingQueueReplay !== queueReplay
        || (!existingMessageId || recoveredActivationSteers) && managed.messageQueue.length > 0) {
        const connection = resolveSessionConnection(managed.llmConnection, undefined)
        // Fallback to 'steer' when no connection is resolvable — preserves
        // today's exact behavior (call redirect, take whatever it returns).
        const configured = connection ? resolveMidStreamBehavior(connection) : 'steer'
        // Mid-turn messages (decision model, toggle `midTurnMessages`): a text message is recorded as
        // queued right away, like any queued message, and the model decides in the background whether
        // it corrects the running work and should be steered in (steerQueuedIfDecided). Recording
        // first keeps send order and leaves the queue the single source of truth.
        const decideDelivery = !trackedPlanRecord && canSteerTextPayload(attachments, storedAttachments, options) && this.decisionFeatureActive('midTurnMessages')
        // An approval is its own authorized turn, never a steer into a different
        // request that won admission while its payload was being hydrated.
        const behavior = trackedPlanRecord || decideDelivery ? 'queue' : configured

        // Create user message for UI and persist queued delivery state so a
        // restart can recover messages that have not reached the model yet.
        const userMessage: Message = existingUserMessage ?? {
          id: generateMessageId(),
          clientMessageId: options?.optimisticMessageId,
          role: 'user',
          content: message,
          timestamp: this.monotonic(),
          attachments: storedAttachments,
          badges: options?.badges,
          ...(references.length > 0 ? { references } : {}),
          // Hidden system-generated messages reach the model but never render as a
          // transcript bubble (e.g. background-task-completion nudge).
          ...(options?.hidden ? { hidden: true } : {}),
        }
        if (!existingUserMessage) {
          if (clientMessageId) (managed.pendingInputCommits ??= new Map()).set(clientMessageId, commit)
          managed.messages.push(userMessage)
          admittedMessage = userMessage
        }
        // Publish to a consumable queue/SDK only after this queued image is durable.
        userMessage.isQueued = true
        // The next operation may hand this row to an SDK. A crash before the
        // delivery outcome is saved must recover it for review, never auto-replay.
        if (!userMessage.hidden) userMessage.pendingDelivery = true
        const steerGeneration = managed.processingGeneration
        this.persistSession(managed)
        await this.flushSessionStrict(managed.id)
        if (this.sessions.get(sessionId) !== managed) throw new Error('INPUT_CANCELLED: Chat was deleted before acceptance')
        acknowledge(userMessage.id)
        if (!ownsAuthRetry() || userMessage.queuedRestoreId) return
        if (activationSlot) activationSlot.deliveryMessageId = userMessage.id

        const agent = managed.agent
        // Redirect is text-only. Any semantic options/attachments use the normal
        // host queue, without aborting the current turn or dropping the payload.
        const textOnly = canSteerTextPayload(attachments, storedAttachments, options)
        // A manual compaction owns the turn: nothing consumes steers, so queue for
        // replay after `complete` instead of steering (OSS #1058). Not an interruption.
        const compactionInFlight = agent?.isCompactionInFlight?.() === true
        const attemptedSteer = managed.isProcessing && managed.processingGeneration === steerGeneration && !recoveredActivationSteers
          && shouldAttemptMidStreamSteer(behavior, textOnly, agent)
        // Steer the reference-formatted payload so cited context reaches the model.
        const steered = attemptedSteer && agent
          ? agent.redirect(messageForModel, { messageId: userMessage.id })
          : false
        const payload: ManagedSession['messageQueue'][number] = { message, attachments, storedAttachments, options, messageId: userMessage.id, optimisticMessageId: options?.optimisticMessageId }
        if (steered && agent?.takePendingSteers) {
          (managed.acceptedSteers ??= new Map()).set(userMessage.id, payload)
        }
        if (steered) (managed.turnSteers ??= []).push(message)
        sessionLog.info('mid-stream send', { sessionId, behavior, steered, textOnly, compactionInFlight, queueLengthBefore: managed.messageQueue.length })

        const delivery = resolveMidStreamDeliveryOutcome(attemptedSteer ? 'steer' : 'queue', steered)
        userMessage.isQueued = delivery.shouldQueue
        userMessage.pendingDelivery = steered && agent?.settlePendingSteers ? true : undefined

        // Emit to UI — 'accepted' iff a steer succeeded; 'queued' otherwise
        // (covers both queue-direct and queue-after-abort paths).
        this.sendEvent({
          type: 'user_message',
          sessionId,
          message: userMessage,
          status: delivery.shouldQueue ? 'queued' : 'accepted',
          optimisticMessageId: options?.optimisticMessageId
        }, managed.workspace.id)

        if (delivery.shouldQueue) {
          // Push for FIFO replay on next onProcessingStopped tick. Same shape
          // for both queue-direct (current turn still running) and
          // queue-after-abort (backend already aborted) — the replay path in
          // processNextQueuedMessage is identical.
          if (queueReplay) {
            managed.messageQueue.push(...queueReplay.entries)
            for (const entry of queueReplay.entries) {
              const queued = managed.messages.find(candidate => candidate.id === entry.messageId)
              if (queued) queued.isQueued = true
            }
          } else {
            managed.messageQueue.push(payload)
            if (this.decisionFeatureActive('midTurnMessages')) payload.continuationCheck = this.markQueuedContinuation(managed, payload)
          }
          if (decideDelivery) void this.steerQueuedIfDecided(managed, payload, userMessage, configured)
          // Only claim interruption when a steer attempt actually aborted the
          // in-flight turn. In 'queue' mode the current turn runs to natural
          // completion, so the replayed turn must NOT inject the "previous response
          // was interrupted" reminder (it would falsely tell the model its own
          // complete answer was cut off → confusion).
          if (delivery.wasInterrupted) managed.wasInterrupted = true
        }

        if (queueReplay && managed.pendingQueueReplay === queueReplay) managed.pendingQueueReplay = undefined

        this.persistSession(managed)
        try {
          await this.flushSessionStrict(managed.id)
        } catch (error) {
          // Initial ownership is already durable and the SDK may have consumed
          // this input. Keep retrying its outcome; do not reject it as a new send.
          this.persistSession(managed)
          this.sendEvent({ type: 'error', sessionId,
            error: `Input was accepted, but saving its delivery state failed: ${error instanceof Error ? error.message : String(error)}`,
          }, managed.workspace.id)
        }
        if (!managed.isProcessing && ownsAuthRetry() && !managed.stopBarrier) this.processNextQueuedMessage(sessionId)
        return
      }

      // Add user message with stored attachments for persistence
      // Skip if existingMessageId is provided (message was already created when queued)
      let userMessage: Message
      if (existingMessageId) {
        // Find existing message (already added when queued)
        userMessage = existingUserMessage!
      } else {
        // Create new message
        userMessage = {
          id: generateMessageId(),
          clientMessageId: options?.optimisticMessageId,
          role: 'user',
          content: message,
          timestamp: this.monotonic(),
          attachments: storedAttachments, // Include for persistence (has thumbnailBase64)
          badges: options?.badges,  // Include content badges (sources, skills with embedded icons)
          ...(references.length > 0 ? { references } : {}),
          // Hidden system-generated messages reach the model but never render as a
          // transcript bubble (e.g. background-task-completion nudge).
          ...(options?.hidden ? { hidden: true } : {}),
        }
        if (clientMessageId) (managed.pendingInputCommits ??= new Map()).set(clientMessageId, commit)
        managed.messages.push(userMessage)
        admittedMessage = userMessage
        if (!options?.hidden && !isCompactCommand) userMessage.pendingDelivery = true

        // Update lastMessageRole for badge display. Skip for hidden messages so the
        // session-list preview isn't briefly driven by an invisible system nudge.
        if (!options?.hidden) {
          managed.lastMessageRole = 'user'
        }

        // Persist + flush before announcing — the user message must be
        // genuinely on disk before we tell the renderer "accepted", and
        // `persistSession` is debounced (500ms). #616.
        this.persistSession(managed)
        await this.flushSessionStrict(managed.id)
        if (this.sessions.get(sessionId) !== managed) throw new Error('INPUT_CANCELLED: Chat was deleted before acceptance')
        acknowledge(userMessage.id)
        if (!ownsAuthRetry() || userMessage.queuedRestoreId) return

        // Emit user_message event so UI can confirm the optimistic message
        this.sendEvent({
          type: 'user_message',
          sessionId,
          message: userMessage,
          status: 'accepted',
          optimisticMessageId: options?.optimisticMessageId
        }, managed.workspace.id)

        // If this is the first user message and no title exists, set one immediately
        // AI generation will enhance it later, but we always have a title from the start
        // Automation sessions (triggeredBy set) already have a title and skip AI generation entirely
        const isFirstUserMessage = managed.messages.filter(m => m.role === 'user').length === 1
        // Smart titles: the first message was small talk; title this one if the name is still automatic.
        const titlesDeferredMessage = !isFirstUserMessage && !options?.hidden && managed.titleDeferred && managed.name === managed.autoTitle
        if ((isFirstUserMessage && !managed.name && !managed.triggeredBy) || titlesDeferredMessage) {
          managed.titleDeferred = false
          // Replace bracket mentions with their display labels (e.g. [skill:ws:commit] -> "Commit")
          // so titles show human-readable names instead of raw IDs
          let titleSource = message
          if (options?.badges) {
            for (const badge of options.badges) {
              if (badge.rawText && badge.label) {
                titleSource = titleSource.replace(badge.rawText, badge.label)
              }
            }
          }
          // Sanitize: strip any remaining bracket mentions, XML blocks, tags
          const sanitized = sanitizeForTitle(titleSource)
          const initialTitle = sanitized.slice(0, 50) + (sanitized.length > 50 ? '…' : '')
          managed.name = initialTitle
          managed.autoTitle = initialTitle
          this.persistSession(managed)
          // Flush immediately so disk is authoritative before notifying renderer
          await this.flushSession(managed.id)
          this.sendEvent({
            type: 'title_generated',
            sessionId,
            title: initialTitle,
          }, managed.workspace.id)

          // Generate AI title asynchronously using agent's SDK
          // (waits briefly for agent creation if needed)
          void this.generateTitleUnlessSmallTalk(managed, message)
        }
      }

      // Persistence/title setup yielded. Another send (including cold approval
      // recovery) may now own the turn. Preserve this already recorded input and
      // its message identity in FIFO instead of starting a second iterator.
      if (this.sessions.get(sessionId) !== managed || !ownsAuthRetry()) return
      if (queueReplay && (managed.pendingQueueReplay !== queueReplay
        || (managed.stopEpoch ?? 0) !== queueReplay.stopEpoch)) return
      if (managed.isProcessing || managed.pendingQueueReplay && managed.pendingQueueReplay !== queueReplay
        || !existingMessageId && managed.messageQueue.length > 0) {
        if (queueReplay) {
          managed.messageQueue.push(...queueReplay.entries)
          if (managed.pendingQueueReplay === queueReplay) managed.pendingQueueReplay = undefined
        } else {
          const payload = { message, attachments, storedAttachments, options, messageId: userMessage.id, optimisticMessageId: options?.optimisticMessageId }
          const arrivalIndex = managed.messages.indexOf(userMessage)
          const before = managed.messageQueue.findIndex(entry => {
            const queuedIndex = managed.messages.findIndex(candidate => candidate.id === entry.messageId)
            return queuedIndex > arrivalIndex
          })
          if (before < 0) managed.messageQueue.push(payload)
          else managed.messageQueue.splice(before, 0, payload)
        }
        const queuedIds = new Set(queueReplay?.entries.map(entry => entry.messageId) ?? [userMessage.id])
        for (const queued of managed.messages) {
          if (queuedIds.has(queued.id)) queued.isQueued = true
        }
        this.sendEvent({ type: 'user_message', sessionId, message: userMessage, status: 'queued', optimisticMessageId: options?.optimisticMessageId }, managed.workspace.id)
        this.persistSession(managed)
        await this.flushSession(managed.id)
        if (this.sessions.get(sessionId) === managed && !managed.isProcessing) this.processNextQueuedMessage(sessionId)
        return
      }

      // Evaluate auto-label rules against the user message (common path for both
      // fresh and queued messages). Regex rules run synchronously here; semantic
      // rules (decision model) run fire-and-forget so they never delay the turn,
      // and merge their matches when they arrive.
      // Hidden messages (auto-retries, system nudges) are not user-authored: they label nothing.
      if (!options?.hidden) {
        try {
          const labelTree = listLabels(managed.workspace.rootPath)
          this.applyAutoLabelMatches(managed, evaluateAutoLabels(message, labelTree, managed.labels ?? []), labelTree)
          void this.applySemanticAutoLabels(managed, message, labelTree)
        } catch (e) {
          sessionLog.warn(`Auto-label evaluation failed for session ${sessionId}:`, e)
        }
      }

      if (activationSlot) activationSlot.deliveryMessageId = userMessage.id
      managed.lastMessageAt = Date.now()
      this.setProcessing(managed, true)
      managed.streamingText = ''
      managed.streamingTurnId = undefined
      managed.processingGeneration++
      admittedGeneration = managed.processingGeneration
      if (queueReplay) queueReplay.processingGeneration = managed.processingGeneration
      if (authRetry) authRetry.generation = managed.processingGeneration
      managed.authRetryInProgress = false
      managed.turnStartFinalMessageId = this.getLastFinalAssistantMessageId(managed.messages)
      // A new turn: an auto-retry of this one already carries the earlier turn's steers.
      managed.turnSteers = []

      // Reset auth retry flag for this new message (allows one retry per message)
      // IMPORTANT: Skip reset if this is an auth retry call - the flag is already true
      // and resetting it would allow infinite retry loops
      // Admission retires authRetryInProgress; the generation now owns this turn.
      if (!_isAuthRetry) {
        managed.authRetryAttempted = false
      }

      // Store message/attachments for potential retry after auth refresh
      // (SDK subprocess caches token at startup, so if it expires mid-session,
      // we need to recreate the agent and retry the message)
      managed.lastSentMessage = message
      managed.lastSentAttachments = attachments
      managed.lastSentStoredAttachments = storedAttachments
      managed.lastSentOptions = options
      const replayedIds = existingMessageId ? managed.replayMergedIds?.get(existingMessageId) : undefined
      if (existingMessageId) managed.replayMergedIds?.delete(existingMessageId)
      managed.lastSentMessageIds = replayedIds ?? [userMessage.id]
      if (!trackedPlanRecord && !options?.hidden && !isCompactCommand) {
        for (const id of managed.lastSentMessageIds) {
          const original = managed.messages.find(candidate => candidate.id === id)
          if (original) original.pendingDelivery = true
        }
        this.persistSession(managed)
        await this.flushSessionStrict(sessionId)
        assertAdmission()
      }
      // The turn now owns delivery. Later input may queue while startup awaits IO.
      releaseAdmission()

      // Capture the generation to detect if a new request supersedes this one.
      // This prevents the finally block from clobbering state when a follow-up message arrives.
      const myGeneration = managed.processingGeneration
      // A Stop from now on (not a stale stopRequested flag) keeps this turn from starting.
      const turnStopEpoch = approvalStopEpoch

      // This send IS the pending plan's manual compaction turn: stamp the
      // correlation (generation + stop epoch) onto the record so the completion
      // and failure event paths can verify the event belongs to this record's
      // own /compact — a late or foreign compaction event can then neither
      // authorize nor cancel it. The stamp is tied to the record's durable
      // consumption receipt: the Accept & Compact flow atomically consumes the
      // draft BEFORE submitting /compact, so a receiptless record is not this
      // flow's compact (e.g. a stale /compact from a replaced acceptance) and
      // must never become ready off its completion. Persisted strictly and
      // immediately: the completion event's correlation check reads the stored
      // record.
      let compactionAcceptance: ManagedSession['pendingPlanExecution']
      if (isCompactCommand && managed.pendingPlanExecution && !managed.pendingPlanExecution.failed) {
        const compactRecord = managed.pendingPlanExecution
        const receiptPresent = compactRecord.executionId
          ? (() => { try { return getPlanDraftConsumption(sessionId, compactRecord.executionId!) !== null } catch { return false } })()
          : false
        if (!receiptPresent || options?.planExecutionId !== compactRecord.executionId) {
          sessionLog.info(`Session ${sessionId}: /compact does not correlate to the pending plan (no durable consumption receipt); readiness unaffected`)
        } else {
          compactionAcceptance = compactRecord
          compactRecord.compactionTurn = { generation: myGeneration, stopEpoch: turnStopEpoch }
          this.persistSession(managed)
          try {
            await this.flushSessionStrict(sessionId)
          } catch (error) {
            // The compact still runs; without a durable correlation its completion
            // cannot ready the plan and failure/reload paths recover the draft.
            sessionLog.error(`Session ${sessionId}: failed to persist pending plan compaction correlation`, error)
          }
        }
      }

      // Pre-enable sources required by invoked skills (Issue #249)
      // This eliminates the two-turn penalty where the agent discovers missing sources at runtime.
      // Uses targeted loadSkillBySlug() instead of loadAllSkills() to avoid O(N) filesystem scans.
      if (options?.skillSlugs?.length) {
        try {
          const workspaceRoot = managed.workspace.rootPath

          const requiredSources = new Set<string>()
          for (const slug of options.skillSlugs) {
            const skill = loadSkillBySlug(workspaceRoot, slug, managed.workingDirectory)
            if (skill?.metadata.requiredSources) {
              for (const src of skill.metadata.requiredSources) {
                requiredSources.add(src)
              }
            }
          }

          if (requiredSources.size > 0) {
            const currentSlugs = new Set(managed.enabledSourceSlugs || [])
            const toEnable: string[] = []
            const skipped: string[] = []
            const candidateSlugs = Array.from(requiredSources)
            const loadedSources = getSourcesBySlugs(workspaceRoot, candidateSlugs)
            const usableSources = new Set(
              loadedSources
                .filter(isSourceUsable)
                .map(source => source.config.slug)
            )

            for (const srcSlug of candidateSlugs) {
              if (currentSlugs.has(srcSlug)) continue
              if (usableSources.has(srcSlug)) {
                toEnable.push(srcSlug)
              } else {
                skipped.push(srcSlug)
              }
            }

            if (skipped.length > 0) {
              sessionLog.warn(`Skill requires sources that are not usable (missing or unauthenticated): ${skipped.join(', ')}`)
            }

            if (toEnable.length > 0) {
              managed.enabledSourceSlugs = [...(managed.enabledSourceSlugs || []), ...toEnable]
              sessionLog.info(`Pre-enabled sources for skill invocation: ${toEnable.join(', ')}`)
              this.persistSession(managed)
              this.sendEvent({
                type: 'sources_changed',
                sessionId,
                enabledSourceSlugs: managed.enabledSourceSlugs,
              }, managed.workspace.id)
            }
          }
        } catch (e) {
          sessionLog.warn(`Failed to pre-enable skill sources for session ${sessionId}:`, e)
        }
      }

      try {
        // Decision-model checks for this turn run while the agent is set up below.
        const preTurnDecisions = this.startPreTurnDecisions(managed, message, options, { activationResend, authRetry: _isAuthRetry, attachments })

        // Start perf span for entire sendMessage flow
        const sendSpan = perf.span('session.sendMessage', { sessionId })

        const workspaceRootPath = managed.workspace.rootPath
        const enabledSlugs = managed.enabledSourceSlugs ?? []
        const hasSources = enabledSlugs.length > 0

        // Load enabled sources up-front so we can refresh tokens BEFORE getOrCreateAgent
        // runs its internal cold-session build. Otherwise that build sees stale tokens
        // and emits AUTH_REQUIRED, causing a brief "needs_auth" UI flicker before the
        // post-build refresh restores state (#710).
        const sources: LoadedSource[] = hasSources
          ? getSourcesBySlugs(workspaceRootPath, enabledSlugs)
          : []

        if (hasSources && managed.tokenRefreshManager) {
          const refreshResult = await refreshExpiredCredentials(sources, managed.tokenRefreshManager)
          if (refreshResult.failedSources.length > 0) {
            sessionLog.warn('[OAuth] Some sources failed token refresh:', refreshResult.failedSources.map(f => f.slug))
          }
          if (refreshResult.refreshedCount > 0) {
            sendSpan.mark('oauth.refreshed')
          }
        }

        // Get or create the agent (lazy loading). Its internal cold-session build at
        // ~L2956 now sees fresh tokens (or correctly-needs_auth failed sources, since
        // ensureFreshToken mirrors the disk write to source.config in-memory).
        const agent = await this.getOrCreateAgent(managed)
        sendSpan.mark('agent.ready')

        // Always set all sources for context (even if none are enabled), including built-ins
        const allSources = loadAllSources(workspaceRootPath)
        agent.setAllSources(allSources)
        sendSpan.mark('sources.loaded')

        // Apply source servers if any are enabled
        if (hasSources) {
          const sessionPath = getSessionStoragePath(workspaceRootPath, sessionId)
          // Single fresh build — tokens already refreshed above.
          const { mcpServers, apiServers, errors } = await buildServersFromSources(sources, sessionPath, managed.tokenRefreshManager, agent.getSummarizeCallback())
          if (errors.length > 0) {
            sessionLog.warn(`Source build errors:`, errors)
          }

          const mcpCount = Object.keys(mcpServers).length
          const apiCount = Object.keys(apiServers).length
          if (mcpCount > 0 || apiCount > 0 || enabledSlugs.length > 0) {
            const usableSources = sources.filter(isSourceUsable)
            const intendedSlugs = usableSources.map(s => s.config.slug)
            await agent.setSourceServers(mcpServers, apiServers, intendedSlugs)
            sessionLog.info(`Applied ${mcpCount} MCP + ${apiCount} API sources to session ${sessionId} (${allSources.length} total)`)
          }
          sendSpan.mark('servers.applied')
        }

        // Continued from another session: the summary this first turn carries may still be generating
        // (the agent above was set up meanwhile).
        if (managed.pendingHandoffSummary) await this.waitForHandoffSummary(managed)

        try {
          sessionLog.info('Starting chat for session:', sessionId)
          sessionLog.info('Workspace:', JSON.stringify(managed.workspace, null, 2))
          sessionLog.info('Message:', message)
          sessionLog.info('Agent model:', agent.getModel())
          sessionLog.info('process.cwd():', process.cwd())

          // Process the message through the agent
          sessionLog.info('Calling agent.chat()...')
          if (attachments?.length) {
            sessionLog.info('Attachments:', attachments.length)
          }

          // Skills mentioned via @mentions are resolved by the UI layer (extractBadges
          // in mentions.ts), which injects fully-qualified names in the rawText.
          // No transformation needed here.

          // Ensure main process reads tool metadata from the correct session directory.
          // This must be set before each chat() call since multiple sessions share the process.
          const chatSessionDir = getSessionStoragePath(workspaceRootPath, sessionId)
          toolMetadataStore.setSessionDir(chatSessionDir)

          // Transient guidance for this turn (interruption notice, decision-model suggestion) travels
          // as `turnContext`: the model sees it after the message, in <system-reminder> tags, but it
          // is not part of the stored message nor of the resend after a source activation.
          const turnContext: string[] = []
          // A /compact turn takes no turn context, so the notice waits for the next real turn.
          if (managed.wasInterrupted && !isCompactCommand) {
            turnContext.push('<system-reminder>The previous assistant response was interrupted by the user and may be incomplete. Do not repeat or continue the interrupted response unless asked. Focus on the new message above.</system-reminder>')
            managed.wasInterrupted = false
          }

          const messageBackendContext = managed.backendRuntimeContext ?? resolveBackendContext({
            sessionConnectionSlug: managed.llmConnection,
            workspaceDefaultConnectionSlug: loadWorkspaceConfig(workspaceRootPath)?.defaults?.defaultLlmConnection,
            managedModel: managed.model,
          })
          const modelInputAttachments = filterAttachmentsForModelInput(
            attachments,
            messageBackendContext.connection,
            messageBackendContext.resolvedModel,
          )
          if (modelInputAttachments.omittedImages.length > 0) {
            const omittedNames = modelInputAttachments.omittedImages.map(a => a.name).join(', ')
            sessionLog.info(`Omitting ${modelInputAttachments.omittedImages.length} image attachment(s) from model input for ${messageBackendContext.resolvedModel}: ${omittedNames}`)
            this.sendEvent({
              type: 'info',
              sessionId,
              message: `Image attachment${modelInputAttachments.omittedImages.length === 1 ? '' : 's'} not sent because image input is disabled for ${messageBackendContext.resolvedModel}.`,
              level: 'warning',
            }, managed.workspace.id)
          }

          const { thinkingOverride, suggestionHint } = preTurnDecisions ? await preTurnDecisions : { thinkingOverride: null, suggestionHint: null }
          // Stopped, superseded or deleted while the agent was set up or the pre-turn checks ran: do not
          // start the turn.
          const stoppedMeanwhile = (managed.stopEpoch ?? 0) !== turnStopEpoch
          const superseded = managed.processingGeneration !== myGeneration
          const deleted = this.sessions.get(sessionId) !== managed
          if (stoppedMeanwhile || superseded || deleted) {
            sessionLog.info(`Turn for session ${sessionId} not started: ${deleted ? 'deleted' : superseded ? 'superseded' : 'stopped'} before it began`)
            sendSpan.mark('chat.not_started')
            if (deleted) return  // the finally block below cleans up
            sendSpan.end()
            if (!superseded) await this.onProcessingStopped(sessionId, 'interrupted', myGeneration)
            return
          }
          if (suggestionHint) turnContext.push(suggestionHint)
          // A /compact turn takes neither: trailing text would become compaction instructions.
          const chatOptions: ChatOptions = {
            ...(thinkingOverride ? { thinkingOverride } : {}),
            ...(turnContext.length > 0 && !isCompactCommand ? { turnContext: turnContext.join('\n\n') } : {}),
          }

          sendSpan.mark('chat.starting')
          const chatIterator = agent.chat(messageForModel, modelInputAttachments.attachments, Object.keys(chatOptions).length > 0 ? chatOptions : undefined)
          sessionLog.info('Got chat iterator, starting iteration...')

          let approvalHandoffMarked = false
          for await (const event of chatIterator) {
            // Handoff may start a new turn before the old SDK iterator settles.
            // Pending steers were transferred synchronously at the handoff boundary;
            // trailing old events must not complete or mutate the replacement turn.
            if (this.sessions.get(sessionId) !== managed || managed.processingGeneration !== myGeneration) {
              sendSpan.mark('chat.superseded')
              sendSpan.end()
              return
            }
            // Only a producer's acknowledgement proves this input was accepted.
            // Preflight/startup failures also emit errors and complete events.
            if (event.type === 'input_accepted' && !approvalHandoffMarked) {
              approvalHandoffMarked = true
              if ((managed.stopEpoch ?? 0) !== turnStopEpoch || managed.stopRequested) continue
              if (!trackedPlanRecord) {
                if (queueReplay && managed.pendingQueueReplay === queueReplay) managed.pendingQueueReplay = undefined
                for (const id of managed.lastSentMessageIds ?? []) {
                  const original = managed.messages.find(candidate => candidate.id === id)
                  if (!original) continue
                  original.pendingDelivery = undefined
                  original.isQueued = false
                  this.sendEvent({ type: 'user_message', sessionId, message: original, status: 'processing',
                    optimisticMessageId: original.clientMessageId ?? queueReplay?.entries.find(entry => entry.messageId === id)?.optimisticMessageId }, managed.workspace.id)
                }
                this.persistSession(managed)
                try { await this.flushSessionStrict(sessionId) }
                catch (error) {
                  sessionLog.error(`Session ${sessionId}: accepted input receipt could not be saved; retaining live acceptance`, error)
                  this.persistSession(managed)
                }
              }
              if (activationSlot?.deliveryMessageId === userMessage.id
                && (managed.stopEpoch ?? 0) === turnStopEpoch && !managed.stopRequested) {
                const delivered = activationSlot.ownedSteers ?? []
                activationSlot.ownedSteers = []
                for (const steer of delivered) {
                  const original = managed.messages.find(candidate => candidate.id === steer.messageId)
                  if (!original) continue
                  original.isQueued = false
                  this.sendEvent({ type: 'user_message', sessionId, message: original,
                    status: 'processing', optimisticMessageId: steer.optimisticMessageId }, managed.workspace.id)
                }
                if (delivered.length > 0) this.persistSession(managed)
              }
              if (existingMessageId && managed.pendingPlanExecution?.approvalMessageId === existingMessageId) {
                await this.withSessionLifecycleLock(sessionId, async () => {
                  const deliveredRecord = managed.pendingPlanExecution
                  if (this.sessions.get(sessionId) !== managed || deliveredRecord?.approvalMessageId !== existingMessageId
                    || deliveredRecord.executionId !== trackedApprovalExecutionId || deliveredRecord.failed
                    || managed.processingGeneration !== myGeneration || (managed.stopEpoch ?? 0) !== turnStopEpoch
                    || managed.stopRequested) return
                  if (queueReplay && managed.pendingQueueReplay === queueReplay) managed.pendingQueueReplay = undefined
                  for (const entry of queueReplay?.entries ?? []) {
                    const original = managed.messages.find(candidate => candidate.id === entry.messageId)
                    if (original) {
                      original.isQueued = false
                      this.sendEvent({ type: 'user_message', sessionId, message: original,
                        status: 'processing', optimisticMessageId: entry.optimisticMessageId }, managed.workspace.id)
                    }
                  }
                  // Acceptance cannot be rolled back after the provider owns the
                  // input. Keep live ownership retired even if the strict write
                  // fails; subsequent history writes retry the same cleared image.
                  managed.pendingPlanExecution = undefined
                  if (trackedApprovalExecutionId) (managed.pendingPlanReceiptRetirements ??= new Set()).add(trackedApprovalExecutionId)
                  this.persistSession(managed)
                  try {
                    await this.flushSessionStrict(sessionId)
                  } catch (error) {
                    sessionLog.error(`Session ${sessionId}: failed to persist accepted approval handoff; retrying with turn history`, error)
                    this.persistSession(managed)
                  }
                })
              }
            }
            if (event.type === 'input_accepted') continue
            if (event.type === 'steer_accepted') {
              const payload = managed.acceptedSteers?.get(event.messageId)
              const original = payload && managed.messages.find(candidate => candidate.id === event.messageId)
              if (original && original.pendingDelivery && !original.queuedRestoreId) {
                managed.acceptedSteers?.delete(event.messageId)
                original.pendingDelivery = undefined
                original.isQueued = false
                this.persistSession(managed)
                this.sendEvent({ type: 'user_message', sessionId, message: original,
                  status: 'processing', optimisticMessageId: payload.optimisticMessageId }, managed.workspace.id)
              }
              continue
            }
            // Log events (skip noisy text_delta)
            if (event.type !== 'text_delta') {
              if (event.type === 'tool_start') {
                sessionLog.info(`tool_start: ${event.toolName} (${event.toolUseId})`)
              } else if (event.type === 'tool_result') {
                sessionLog.info(`tool_result: ${event.toolUseId} isError=${event.isError}`)
              } else {
                sessionLog.info('Got event:', event.type)
              }
            }

            // Process the event first, carrying the ORIGINATING turn context
            // captured when this send's execution started — compaction
            // completion/failure correlation compares against the turn that
            // EMITTED the event, never a correlation re-derived from the live
            // record/generation at event time.
            await this.processEvent(managed, event, { generation: myGeneration, stopEpoch: turnStopEpoch })

            // Fallback: Capture SDK session ID if the onSdkSessionIdUpdate callback didn't fire.
            // Primary capture happens in getOrCreateAgent() via onSdkSessionIdUpdate callback,
            // which immediately flushes to disk. This fallback handles edge cases where the
            // callback might not fire (e.g., SDK version mismatch, callback not supported).
            if (!managed.sdkSessionId) {
              const sdkId = agent.getSessionId()
              if (sdkId) {
                managed.sdkSessionId = sdkId
                sessionLog.info(`Captured SDK session ID via fallback: ${sdkId}`)
                // Also flush here since we're in fallback mode
                this.persistSession(managed)
                sessionPersistenceQueue.flush(managed.id)
              }
            }

            // Handle complete event - SDK always sends this (even after interrupt)
            // This is the central place where processing ends
            if (event.type === 'complete') {
              // Skip normal completion handling if auth retry is in progress
              // The retry will handle its own completion
              if (managed.authRetryInProgress) {
                sessionLog.info('Chat completed but auth retry is in progress, skipping normal completion handling')
                sendSpan.mark('chat.complete.auth_retry_pending')
                sendSpan.end()
                return  // Exit function - retry will handle completion
              }

              // Auth/plan handoff paths already stopped processing and emitted a complete
              // event to the renderer. Ignore the backend's trailing complete to avoid
              // double cleanup and duplicate UI completion events.
              if (!managed.isProcessing) {
                sessionLog.info('Chat completed after explicit handoff/stop; skipping normal completion handling')
                sendSpan.mark('chat.complete.already_stopped')
                sendSpan.end()
                return
              }

              sessionLog.info('Chat completed via complete event')

              // Check if we got an assistant response in this turn
              // If not, the SDK may have hit context limits or other issues
              const lastAssistantMsg = [...managed.messages].reverse().find(m =>
                m.role === 'assistant' && !m.isIntermediate
              )
              const lastUserMsg = [...managed.messages].reverse().find(m => m.role === 'user')

              // If the last user message is newer than any assistant response, we got no reply
              // This can happen due to context overflow or API issues
              if (lastUserMsg && (!lastAssistantMsg || lastUserMsg.timestamp > lastAssistantMsg.timestamp)) {
                sessionLog.warn(`Session ${sessionId} completed without assistant response - possible context overflow or API issue`)

                // Check if there's a captured API error that explains the silent failure.
                // Pass explicit session path to avoid reading from the wrong session
                // (_sessionDir singleton can be clobbered by concurrent sessions).
                const sessionErrorPath = getSessionStoragePath(managed.workspace.rootPath, managed.id)
                const apiError = getLastApiError(sessionErrorPath)

                if (apiError && apiError.status === 400) {
                  const isImageError = apiError.message?.includes('image exceeds')

                  const errorMessage: Message = {
                    id: generateMessageId(),
                    role: 'error',
                    content: isImageError
                      ? `Image Too Large: ${apiError.message}`
                      : `Request Error: ${apiError.message}`,
                    timestamp: this.monotonic(),
                    errorCode: isImageError ? 'image_too_large' : 'invalid_request',
                    errorTitle: isImageError ? 'Image Too Large' : 'Invalid Request',
                    errorDetails: isImageError
                      ? ['An image in the conversation exceeds the 5 MB API limit.',
                         'This session cannot recover — the image is embedded in the history.',
                         'Please start a new session to continue.']
                      : [apiError.message],
                    errorCanRetry: false,
                  }
                  managed.messages.push(errorMessage)
                  this.sendEvent({
                    type: 'typed_error',
                    sessionId,
                    error: {
                      code: isImageError ? 'image_too_large' as const : 'invalid_request' as const,
                      title: errorMessage.errorTitle!,
                      message: apiError.message,
                      actions: [],
                      canRetry: false,
                      details: errorMessage.errorDetails,
                    },
                  }, managed.workspace.id)
                }
              }

              sendSpan.mark('chat.complete')
              sendSpan.end()
              // The backend also ends a turn the user stopped with `complete`. Reporting that as a
              // completion marked a stopped task step done with no output (found 2026-10-11).
              const stoppedDuringTurn = (managed.stopEpoch ?? 0) !== turnStopEpoch
              await this.onProcessingStopped(sessionId, stoppedDuringTurn ? 'interrupted' : 'complete', myGeneration)
              return  // Exit function, skip finally block (onProcessingStopped handles cleanup)
            }

            // NOTE: We no longer break early on !isProcessing or stopRequested.
            // After soft interrupt (forceAbort), the backend sets turnComplete=true which causes
            // the generator to yield remaining queued events and then complete naturally.
            // This ensures we don't lose in-flight messages.
          }

          if (managed.processingGeneration !== myGeneration) {
            sendSpan.mark('chat.superseded')
            sendSpan.end()
            return
          }
          // Loop exited - either via complete event (normal) or generator ended after soft interrupt
          if (!managed.isProcessing) {
            sessionLog.info('Chat loop exited after explicit handoff/stop')
            sendSpan.mark('chat.exit.already_stopped')
            sendSpan.end()
          } else if (managed.stopRequested) {
            sessionLog.info('Chat loop completed after stop request - events drained successfully')
            await this.onProcessingStopped(sessionId, 'interrupted', myGeneration)
          } else {
            sessionLog.info('Chat loop exited unexpectedly')
          }
        } catch (error) {
          if (managed.processingGeneration !== myGeneration) {
            sendSpan.mark('chat.superseded')
            sendSpan.end()
            return
          }
          // Check if this is an abort error (expected when interrupted)
          const isAbortError = error instanceof Error && (
            error.name === 'AbortError' ||
            error.message === 'Request was aborted.' ||
            error.message.includes('aborted')
          )

          if (isAbortError) {
            // Extract abort reason if available (safety net for unexpected abort propagation)
            const reason = (error as DOMException).cause as AbortReason | undefined

            sessionLog.info(`Chat aborted (reason: ${reason || 'unknown'})`)
            sendSpan.mark('chat.aborted')
            sendSpan.setMetadata('abort_reason', reason || 'unknown')
            sendSpan.end()

            // UI handoff paths (plan submission, auth request) handle their own cleanup
            // by setting isProcessing = false directly. All other abort reasons route
            // through onProcessingStopped for queue draining.
            if (reason === AbortReason.UserStop || reason === AbortReason.Redirect || reason === undefined) {
              await this.onProcessingStopped(sessionId, 'interrupted', myGeneration)
            }
          } else {
            sessionLog.error('Error in chat:', error)
            sessionLog.error('Error message:', error instanceof Error ? error.message : String(error))
            sessionLog.error('Error stack:', error instanceof Error ? error.stack : 'No stack')

            // Report chat/SDK errors via runtime hooks (Electron can forward to Sentry)
            sessionRuntimeHooks.captureException(error, { errorSource: 'chat', sessionId })

            sendSpan.mark('chat.error')
            sendSpan.setMetadata('error', error instanceof Error ? error.message : String(error))
            sendSpan.end()
            this.sendEvent({
              type: 'error',
              sessionId,
              error: error instanceof Error ? error.message : 'Unknown error'
            }, managed.workspace.id)
            // Handle error via centralized handler
            await this.onProcessingStopped(sessionId, 'error', myGeneration)
          }
        } finally {
          // Only handle cleanup for unexpected exits (loop break without complete event)
          // Normal completion returns early after calling onProcessingStopped
          // Errors are handled in catch block
          if (managed.isProcessing && managed.processingGeneration === myGeneration) {
            sessionLog.info('Finally block cleanup - unexpected exit')
            sendSpan.mark('chat.unexpected_exit')
            sendSpan.end()
            await this.onProcessingStopped(sessionId, 'interrupted', myGeneration)
          }
        }
      } finally {
        try {
          // Agent setup, pre-turn work and an iterator that ends without a manual
          // success are all failed compactions. None may strand a consumed draft.
          if (compactionAcceptance && compactionAcceptance.awaitingCompaction && !compactionAcceptance.failed
            && compactionAcceptance.compactionTurn?.generation === myGeneration) {
            await this.withSessionLifecycleLock(sessionId, async () => {
              if (this.sessions.get(sessionId) !== managed || managed.pendingPlanExecution !== compactionAcceptance) return
              if (!compactionAcceptance.awaitingCompaction || compactionAcceptance.failed) return
              await this.cancelPendingPlanExecution(managed, compactionAcceptance)
            })
          }
        } finally {
          // Setup can fail before the inner chat try/finally is reached. Every
          // admitted turn must settle without leaving a warm session stuck busy.
          if (this.sessions.get(sessionId) === managed && managed.isProcessing
            && managed.processingGeneration === myGeneration) {
            await this.onProcessingStopped(sessionId, 'error', myGeneration)
          }
        }
      }
    } catch (error) {
      if (!durable && admittedMessage && !admittedMessage.queuedRestoreId) {
        managed.messages = managed.messages.filter(candidate => candidate !== admittedMessage)
        managed.messageQueue = managed.messageQueue.filter(entry => entry.messageId !== admittedMessage?.id)
        this.persistSession(managed)
      }
      if (admittedGeneration !== undefined && managed.processingGeneration === admittedGeneration && managed.isProcessing) {
        await this.onProcessingStopped(sessionId, 'error', admittedGeneration)
      }
      throw error
    } finally {
      finishCommit()
      releaseAdmission()
    }
  }

  async cancelProcessing(sessionId: string, silent = false): Promise<void> {
    const managed = this.sessions.get(sessionId)
    if (managed?.stopBarrier) return managed.stopBarrier
    const stopRecord = managed?.pendingPlanExecution
    // The delivery tracker survives until producer acknowledgement. Hard Stop
    // also owns a queued approval or a replay still waiting for turn admission.
    const stoppingApproval = !silent && stopRecord?.executionDispatched && stopRecord.approvalMessageId && !stopRecord.failed
    if (!managed || !managed.isProcessing && !managed.autoRetryTimer && !managed.autoRetryPending?.ownedSteers?.length
      && managed.messageQueue.length === 0 && !stoppingApproval && !managed.pendingQueueReplay && !managed.authRetryInProgress && !managed.pendingAuthRequest
      && !managed.pendingSendAdmissions?.size) {
      return // Not processing, nothing to cancel
    }

    let releaseStop!: () => void
    let rejectStop!: (error: unknown) => void
    const stopBarrier = new Promise<void>((resolve, reject) => { releaseStop = resolve; rejectStop = reject })
    // The initiating caller gets the same failure through this method. Mark
    // the shared promise observed even when no duplicate Stop/send awaits it.
    void stopBarrier.catch(() => {})
    managed.stopBarrier = stopBarrier
    try {
      sessionLog.info('Cancelling processing for session:', sessionId, silent ? '(silent)' : '')

      // Close turn admission before any durability await. An agent startup
      // finishing while cancellation writes must not start the stopped turn.
      const stoppedEpoch = managed.stopEpoch ?? 0
      const stoppedGeneration = managed.processingGeneration
      managed.stopRequested = true
      managed.stopEpoch = stoppedEpoch + 1
      // Unblock a new epoch even if an old validation read never returns.
      for (const release of [...(managed.pendingSendAdmissions?.keys() ?? [])]) release()
      managed.authRetryInProgress = false
      if (managed.pendingAuthRequest) {
        const requestId = managed.pendingAuthRequestId
        const card = managed.messages.find(message => message.role === 'auth-request'
          && message.authRequestId === requestId && message.authStatus === 'pending')
        if (card) card.authStatus = 'cancelled'
        managed.pendingAuthRequest = undefined
        managed.pendingAuthRequestId = undefined
        managed.pendingAuthOwner = undefined
        if (requestId) this.sendEvent({ type: 'auth_completed', sessionId, requestId, success: false, cancelled: true }, managed.workspace.id)
        this.persistSession(managed)
      }
      // A Pi cancellation receipt is ordered after all earlier consumption receipts.
      // New turn admission waits for this barrier, so an old abort cannot hit it.
      const stoppedAgent = managed.agent
      // Keep background agents alive where the backend supports reply-only Stop.
      if (stoppedAgent && !stoppedAgent.stopTurn?.()) {
        stoppedAgent.forceAbort(AbortReason.UserStop)
      }
      if (stoppedAgent?.settlePendingSteers) {
        const undelivered = await stoppedAgent.settlePendingSteers()
        if (this.sessions.get(sessionId) !== managed) return
        const ids = new Set(undelivered.map(steer => steer.messageId))
        for (const id of managed.acceptedSteers?.keys() ?? []) {
          if (ids.has(id)) continue
          const delivered = managed.messages.find(message => message.id === id)
          if (delivered) delivered.pendingDelivery = undefined
          managed.acceptedSteers?.delete(id)
        }
        for (const steer of undelivered) this.recoverUndeliveredSteer(managed, steer)
      }
      this.recoverPendingQueueReplay(managed)
      for (const message of managed.messages) {
        if (message.role !== 'user' || (!message.pendingDelivery && !message.isQueued) || message.hidden || message.queuedRestoreId) continue
        message.pendingDelivery = undefined
        message.isQueued = true
        if (!managed.messageQueue.some(entry => entry.messageId === message.id)) {
          managed.messageQueue.push({ message: message.content, messageId: message.id,
            storedAttachments: message.attachments, options: { references: message.references } })
        }
      }
      managed.messageQueue.sort((a, b) => managed.messages.findIndex(m => m.id === a.messageId) - managed.messages.findIndex(m => m.id === b.messageId))
      // Transfer undelivered accepted input before aborting its backend, so the
      // queued-input restore below retains each original payload.
      this.recoverActivationSteers(managed)
      this.recoverPendingSteers(managed)
      if (stoppingApproval) {
        // The plan outbox restores its consumed snapshot. Restoring the
        // approval control message through the ordinary queue would duplicate it.
        managed.messageQueue = managed.messageQueue.filter(entry => entry.messageId !== stopRecord.approvalMessageId)
        const approval = managed.messages.find(message => message.id === stopRecord.approvalMessageId)
        if (approval) approval.isQueued = false
      }
      // Detach every stopped payload before abort or IO can let completion drain it.
      // Collect queued message text for input restoration before clearing
      const queuedTexts = managed.messageQueue.map(q => q.message)
      const queuedReferences = managed.messageQueue.flatMap(q => q.options?.references ?? [])
      const queuedAttachments = managed.messageQueue.flatMap(q => q.storedAttachments ?? [])

      const queuedMessageIds = Array.from(new Set(
        managed.messageQueue.map(q => q.messageId).filter((id): id is string => !!id)
      ))
      const queuedMessageIdSet = new Set(queuedMessageIds)

      // Clear queue - user explicitly stopped, don't process queued messages
      managed.messageQueue = []

      // Explicit Stop restores queued input into the draft. Keep the persisted
      // bubbles until the renderer confirms that draft persistence succeeded.
      // Silent redirects have no restore/ack handshake and retain their existing
      // queue cleanup behavior.
      const queuedRestoreId = !silent && queuedMessageIds.length > 0
        ? `input-${randomUUID()}`
        : undefined
      const pendingRestoreMessageIds: string[] = []
      if (queuedRestoreId) {
        for (const message of managed.messages) {
          if (message.role === 'user' && message.isQueued && queuedMessageIdSet.has(message.id)) {
            message.queuedRestoreId = queuedRestoreId
            pendingRestoreMessageIds.push(message.id)
          }
        }
      } else if (queuedMessageIds.length > 0) {
        managed.messages = managed.messages.filter(m => !queuedMessageIdSet.has(m.id))
      }

      // Track interruption so the next user message gets a context note
      // telling the LLM the previous response was cut short
      managed.wasInterrupted = true

      // Only show "Response interrupted" message when user explicitly clicked Stop
      // Silent mode is used when redirecting (sending new message while processing)
      let interruptedMessage: Message | undefined
      if (!silent) {
        interruptedMessage = {
          id: generateMessageId(),
          role: 'info',
          content: 'Response interrupted',
          timestamp: this.monotonic(),
        }
        managed.messages.push(interruptedMessage)
      }

      // Interrupt the backend at the same admission boundary. Recovery writes
      // may wait on IO; the stopped turn must not keep running during that wait.

      // A Stop during the manual /compact of an Accept & Compact kills the
      // compaction: funnel into the same failure path (mark non-executable,
      // restore the consumed draft idempotently, clear) instead of leaving a
      // plan awaiting a compaction that can no longer complete. A non-compact
      // message that caused a silent redirect already cleared the record via
      // sendMessage's safety valve, so this no-ops there.
      const stoppingCompaction = stopRecord && !stopRecord.executionDispatched && stopRecord.compactionTurn
        && managed.isProcessing && stopRecord.compactionTurn.generation === managed.processingGeneration
        && stopRecord.compactionTurn.stopEpoch === stoppedEpoch
      if (stopRecord && !stopRecord.failed && (stoppingCompaction || stoppingApproval)) {
        const stoppedExecutionId = stopRecord.executionId
        const stoppedTurn = stopRecord.compactionTurn
        const stoppedApprovalId = stopRecord.approvalMessageId
        await this.withSessionLifecycleLock(sessionId, async () => {
          // Readiness may publish a new image while its strict write is pending.
          // Stop still owns that compaction by execution/turn identity until the
          // active compact ends; an idle ready plan remains executable.
          const currentRecord = this.sessions.get(sessionId)?.pendingPlanExecution
          if (this.sessions.get(sessionId) !== managed || !currentRecord) return
          if (stoppedExecutionId !== undefined ? currentRecord.executionId !== stoppedExecutionId : currentRecord !== stopRecord) return
          if (stoppingApproval) {
            const sameApproval = currentRecord.approvalMessageId === stoppedApprovalId && currentRecord.executionDispatched
            const rolledBackApproval = currentRecord.approvalMessageId === undefined && !currentRecord.executionDispatched
            if (!sameApproval && !rolledBackApproval) return
          } else {
            if (currentRecord.executionDispatched || !stoppedTurn
              || currentRecord.compactionTurn?.generation !== stoppedTurn.generation
              || currentRecord.compactionTurn.stopEpoch !== stoppedTurn.stopEpoch) return
          }
          await this.cancelPendingPlanExecution(managed, currentRecord)
        }).catch(error => sessionLog.error(`Session ${sessionId}: Stop-funnel cancellation failed`, error))
      }

      if (pendingRestoreMessageIds.length > 0) {
        this.persistSession(managed)
        await this.flushSessionStrict(managed.id)
      }

      this.sendEvent({
        type: 'interrupted',
        sessionId,
        ...(interruptedMessage ? { message: interruptedMessage } : {}),
        // Include queued input so the renderer can restore it before acknowledging.
        ...(queuedTexts.length > 0 ? { queuedMessages: queuedTexts } : {}),
        ...(queuedReferences.length > 0 ? { queuedReferences } : {}),
        ...(queuedAttachments.length > 0 ? { queuedAttachments } : {}),
        ...(queuedRestoreId && pendingRestoreMessageIds.length > 0
          ? { queuedRestoreId, queuedMessageIds: pendingRestoreMessageIds }
          : {}),
      }, managed.workspace.id)

      // A pending retry can be stopped after its old iterator already closed.
      // No event pump remains to clear this flag for the next user turn.
      if (!managed.isProcessing) managed.stopRequested = false

      // Safety timeout: if event loop doesn't complete within 5 seconds, force cleanup
      // This handles cases where the generator gets stuck
      setTimeout(() => {
        if (this.sessions.get(sessionId) === managed && managed.processingGeneration === stoppedGeneration
          && (managed.stopEpoch ?? 0) === stoppedEpoch + 1 && managed.stopRequested && managed.isProcessing) {
          sessionLog.warn('Generator did not complete after stop request, forcing cleanup')
          void this.onProcessingStopped(sessionId, 'timeout', stoppedGeneration).catch(error => {
            sessionLog.error(`Session ${sessionId}: timed-out turn cleanup failed`, error)
          })
        }
      }, 5000)

      // NOTE: We don't clear isProcessing or send complete event here anymore.
      // The event loop will drain remaining events and call onProcessingStopped when done.
    } catch (error) {
      rejectStop(error)
      throw error
    } finally {
      if (managed.stopBarrier === stopBarrier) managed.stopBarrier = undefined
      releaseStop()
    }

  }

  async acknowledgeQueuedInputRestore(
    sessionId: string,
    restoreId: string,
    messageIds: string[],
  ): Promise<void> {
    if (!restoreId || !Array.isArray(messageIds) || messageIds.length === 0) return
    await this.withSessionLifecycleLock(sessionId, async () => {
      const managed = this.sessions.get(sessionId)
      if (!managed) return
      await this.ensureMessagesLoaded(managed)
      if (this.sessions.get(sessionId) !== managed) return
      const requested = new Set(messageIds)
      const removed = managed.messages.flatMap((message, index) => message.role === 'user'
        && message.queuedRestoreId === restoreId && requested.has(message.id) ? [{ message, index }] : [])
      if (!removed.length) return
      const ids = new Set(removed.map(entry => entry.message.id))
      managed.messages = managed.messages.filter(message => !ids.has(message.id))
      const previousReceipts = managed.restoredInputIds
      managed.restoredInputIds = { ...previousReceipts }
      for (const { message } of removed) {
        if (message.clientMessageId) managed.restoredInputIds = { ...managed.restoredInputIds, [message.clientMessageId]: message.id }
      }
      this.persistSession(managed)
      try {
        await this.flushSessionStrict(managed.id)
      } catch (error) {
        managed.restoredInputIds = previousReceipts
        // Keep the identity-scoped outbox retryable until its retirement is durable.
        // Concurrently appended history is retained; only our removed rows return.
        for (const { message, index } of removed) {
          if (!managed.messages.some(candidate => candidate.id === message.id)) managed.messages.splice(index, 0, message)
        }
        this.persistSession(managed)
        throw error
      }
      this.sendEvent({ type: 'queued_input_restored', sessionId,
        queuedRestoreId: restoreId, messageIds: [...ids] }, managed.workspace.id)
    })
  }

  /**
   * Attempt auth retry: refresh token, destroy agent, resend last message.
   * Shared by both typed_error and plain error auth-retry paths.
   * Returns true if retry was initiated, false if conditions not met.
   */
  private attemptAuthRetry(
    sessionId: string,
    managed: ManagedSession,
    workspaceId: string,
    failureErrorCode?: string,
  ): boolean {
    if (managed.authRetryAttempted || !managed.lastSentMessage) return false

    // The retry owns this failed turn, never a later send's live lastSent state.
    const retryMessage = managed.lastSentMessage
    const retryAttachments = managed.lastSentAttachments
    const retryStoredAttachments = managed.lastSentStoredAttachments
    const retryOptions = managed.lastSentOptions
    const retryMessageIds = [...(managed.lastSentMessageIds ?? [])]
    const authRetry = { generation: managed.processingGeneration, stopEpoch: managed.stopEpoch ?? 0 }
    const ownsRetry = () => this.sessions.get(sessionId) === managed
      && managed.processingGeneration === authRetry.generation && (managed.stopEpoch ?? 0) === authRetry.stopEpoch

    sessionLog.info(`Auth error detected, attempting token refresh and retry for session ${sessionId}`)
    managed.authRetryAttempted = true
    managed.authRetryInProgress = true

    // Emit lightweight info so the user sees progress instead of a scary red error
    this.sendEvent({
      type: 'info',
      sessionId,
      message: 'Token expired, refreshing session…',
      timestamp: this.monotonic(),
    }, workspaceId)

    setImmediate(async () => {
      if (!ownsRetry() || !managed.authRetryInProgress) return
      try {
        // 1. Reset summarization client so it picks up fresh credentials
        sessionLog.info(`[auth-retry] Resetting summarization client for session ${sessionId}`)
        resetSummarizationClient()

        // 2. Destroy the agent — the new agent's postInit() will refresh auth
        sessionLog.info(`[auth-retry] Destroying agent for session ${sessionId}`)
        this.recoverPendingSteers(managed)
        managed.agent = null

        // 3. Retry the captured payload using its existing durable bubbles. IDs
        // remain valid for references and a merged replay retains every bubble.
        sessionLog.info(`[auth-retry] Retrying message for session ${sessionId}`)
        this.setProcessing(managed, false)
        const retryMessageId = retryMessageIds[0]
        if (!retryMessageId) throw new Error('Auth retry has no original message')
        if (retryMessageIds.length > 1) (managed.replayMergedIds ??= new Map()).set(retryMessageId, retryMessageIds)
        await this.sendMessage(
          sessionId, retryMessage, retryAttachments, retryStoredAttachments, retryOptions,
          retryMessageId, true, undefined, undefined, { authRetry },
        )
        sessionLog.info(`[auth-retry] Retry completed for session ${sessionId}`)
      } catch (retryError) {
        if (!ownsRetry()) return
        managed.authRetryInProgress = false
        sessionLog.error(`[auth-retry] Failed to retry after auth refresh for session ${sessionId}:`, retryError)
        sessionRuntimeHooks.captureException(retryError, { errorSource: 'auth-retry', sessionId })
        const failedMessage: Message = {
          id: generateMessageId(),
          role: 'error',
          content: 'Authentication failed. Please check your credentials.',
          timestamp: this.monotonic(),
          errorCode: failureErrorCode,
        }
        managed.messages.push(failedMessage)
        this.sendEvent({
          type: 'error',
          sessionId,
          error: 'Authentication failed. Please check your credentials.',
          timestamp: failedMessage.timestamp,
        }, workspaceId)
        await this.onProcessingStopped(sessionId, 'error', authRetry.generation).catch(error => {
          sessionLog.error(`Session ${sessionId}: authentication retry cleanup failed`, error)
        })
      }
    })

    return true
  }

  /**
   * Listeners for the in-process session-completion seam (see SessionCompletionEvent).
   * Used by the Tasks Conductor; empty until something subscribes, so zero overhead otherwise.
   */
  private sessionCompletionListeners = new Set<(evt: SessionCompletionEvent) => void>()
  private readonly sessionActivityListeners = new Map<string, Set<() => void>>()

  /**
   * Subscribe to in-process session completion (Tasks Conductor seam).
   * Returns an unsubscribe function. Not a renderer event; not agent-facing.
   */
  onSessionComplete(listener: (evt: SessionCompletionEvent) => void): () => void {
    this.sessionCompletionListeners.add(listener)
    return () => {
      this.sessionCompletionListeners.delete(listener)
    }
  }

  /**
   * Subscribe to a session's activity: called for every event its agent emits (text, thinking,
   * tool calls, status). Lets a caller time out only a turn that has stalled, not one that is
   * slow but working. In-process only. Returns an unsubscribe function.
   */
  onSessionActivity(sessionId: string, listener: () => void): () => void {
    let listeners = this.sessionActivityListeners.get(sessionId)
    if (!listeners) {
      listeners = new Set()
      this.sessionActivityListeners.set(sessionId, listeners)
    }
    listeners.add(listener)
    return () => {
      const current = this.sessionActivityListeners.get(sessionId)
      current?.delete(listener)
      if (current?.size === 0) this.sessionActivityListeners.delete(sessionId)
    }
  }

  private notifySessionActivity(sessionId: string): void {
    const listeners = this.sessionActivityListeners.get(sessionId)
    if (!listeners) return
    for (const listener of [...listeners]) {
      try {
        listener()
      } catch (err) {
        sessionLog.error(`onSessionActivity listener threw for session ${sessionId}:`, err)
      }
    }
  }

  private emitSessionComplete(evt: SessionCompletionEvent): void {
    if (this.sessionCompletionListeners.size === 0) return
    // Iterate a snapshot: a listener that re-subscribes synchronously while handling this event
    // (the Conductor re-attaches its one-shot verdict listener before re-asking the orchestrator)
    // must see the NEXT completion, not be re-entered by this one. Live-Set iteration visits
    // entries added mid-loop, which re-asked the same reply up to MAX_UNPARSED_REASKS+1 times and
    // failed runs before the orchestrator could answer.
    for (const listener of [...this.sessionCompletionListeners]) {
      try {
        listener(evt)
      } catch (err) {
        sessionLog.error(`onSessionComplete listener threw for session ${evt.sessionId}:`, err)
      }
    }
  }

  /** Release a cancelled/failed continuation's full payloads into the existing FIFO. */
  private recoverActivationSteers(managed: ManagedSession, slot = managed.autoRetryPending): boolean {
    if (!slot) return false
    if (managed.autoRetryPending === slot) {
      if (managed.autoRetryTimer) clearTimeout(managed.autoRetryTimer)
      managed.autoRetryTimer = undefined
      managed.autoRetryPending = undefined
    }
    // Cancel the pending hidden delivery as well as its timer; it must not
    // reappear ahead of fresh input or through cold queue recovery.
    if (slot.deliveryMessageId) {
      managed.messageQueue = managed.messageQueue.filter(entry => entry.messageId !== slot.deliveryMessageId)
      const continuation = managed.messages.find(message => message.id === slot.deliveryMessageId)
      if (continuation?.hidden) continuation.isQueued = false
    }
    const before = managed.messageQueue.length
    const owned = slot.ownedSteers ?? []
    slot.ownedSteers = []
    for (const payload of owned) {
      if (!payload.messageId || managed.messageQueue.some(entry => entry.messageId === payload.messageId)) continue
      ;(managed.acceptedSteers ??= new Map()).set(payload.messageId, payload)
      this.recoverUndeliveredSteer(managed, { message: payload.message, messageId: payload.messageId })
    }
    // Do not drain a newer turn's backend when an older timer is cancelled.
    if (managed.processingGeneration === slot.scheduledGeneration && !managed.autoRetryPending) {
      this.recoverPendingSteers(managed)
    }
    return managed.messageQueue.length > before
  }

  /** Reconcile an accepted steer with its original bubble and full host payload. */
  private recoverUndeliveredSteer(managed: ManagedSession, steer: { message: string; messageId?: string }): void {
    const payload = steer.messageId ? managed.acceptedSteers?.get(steer.messageId) : undefined
    const liveSlot = managed.autoRetryPending
    const alreadyOwned = steer.messageId ? liveSlot?.ownedSteers?.some(entry => entry.messageId === steer.messageId) : false
    if (liveSlot && liveSlot.scheduledGeneration === managed.processingGeneration && (payload || alreadyOwned)) {
      if (payload && !alreadyOwned) (liveSlot.ownedSteers ??= []).push(payload)
      if (steer.messageId) managed.acceptedSteers?.delete(steer.messageId)
      const original = managed.messages.find(message => message.id === steer.messageId)
      if (original) {
        original.isQueued = true
        original.pendingDelivery = undefined
        this.sendEvent({ type: 'user_message', sessionId: managed.id, message: original,
          status: 'queued', optimisticMessageId: payload?.optimisticMessageId }, managed.workspace.id)
        this.persistSession(managed)
      }
      sessionLog.info(`Session ${managed.id}: undelivered steer ${steer.messageId ?? '(no id)'} owned by the source-activation continuation`)
      return
    }
    // Only identity-bearing steers have a recoverable payload. A steer without
    // a messageId (a pre-identity backend or a references-formatted message)
    // goes through the references-aware fallback instead.
    // Identity-bearing events are idempotent, including trailing events after Stop.
    if (!payload) {
      // A trailing event for an already-recovered (or Stop-cancelled) steer
      // must not duplicate. A steer without a messageId (a pre-identity backend
      // or a message-formatted references payload) recovers the original stored
      // message so structured references ride in the queue entry — the
      // model-formatted text with its internal `<stair_reference_data>` block
      // must never be re-queued.
      if (!steer.messageId) {
        const original = managed.messages.findLast(message => (
          message.role === 'user'
          && formatReferencesForModel(message.content, message.references ?? []) === steer.message
        ))
        if (original) {
          const replayOptions: SendMessageOptions = {
            ...(original.references?.length ? { references: original.references } : {}),
            ...(original.badges?.length ? { badges: original.badges } : {}),
            ...(original.hidden ? { hidden: true } : {}),
          }
          original.isQueued = true
          original.pendingDelivery = undefined
          managed.messageQueue.push({
            message: original.content,
            storedAttachments: original.attachments,
            options: Object.keys(replayOptions).length > 0 ? replayOptions : undefined,
            messageId: original.id,
          })
        } else {
          managed.messageQueue.push({ message: stripReferencesFromModelInput(steer.message) })
        }
        this.persistSession(managed)
      }
      return
    }
    if (steer.messageId) managed.acceptedSteers?.delete(steer.messageId)
    const existing = payload.messageId ? managed.messages.find(m => m.id === payload.messageId) : undefined
    if (existing) {
      existing.isQueued = true
      existing.pendingDelivery = undefined
      this.sendEvent({ type: 'user_message', sessionId: managed.id, message: existing,
        status: 'queued', optimisticMessageId: payload.optimisticMessageId }, managed.workspace.id)
    }
    // Recover into original arrival order, including attachment sends that were
    // already queued while this text steer was pending inside the backend.
    const index = existing ? managed.messages.indexOf(existing) : -1
    const before = index < 0 ? -1 : managed.messageQueue.findIndex(item => {
      const queuedIndex = managed.messages.findIndex(m => m.id === item.messageId)
      return queuedIndex > index
    })
    if (before < 0) managed.messageQueue.push(payload)
    else managed.messageQueue.splice(before, 0, payload)
    this.persistSession(managed)
  }

  /** Synchronous ownership transfer before a backend is paused or disposed. */
  private recoverPendingSteers(managed: ManagedSession): void {
    for (const steer of managed.agent?.takePendingSteers?.() ?? []) {
      this.recoverUndeliveredSteer(managed, steer)
    }
    if (!managed.agent?.settlePendingSteers) managed.acceptedSteers?.clear()
  }

  /** Recover scheduled input; a rejected first entry stays available for explicit Retry. */
  private recoverPendingQueueReplay(managed: ManagedSession, skipFailedFirst = false): void {
    const replay = managed.pendingQueueReplay
    if (!replay) return
    managed.pendingQueueReplay = undefined
    const firstId = replay.entries[0]?.messageId
    const isApproval = firstId !== undefined && managed.pendingPlanExecution?.approvalMessageId === firstId
    if (firstId) managed.replayMergedIds?.delete(firstId)
    if (isApproval || skipFailedFirst) {
      const approval = managed.messages.find(message => message.id === firstId)
      // An approval belongs to its plan outbox. A rejected ordinary entry
      // must leave automatic replay, retaining its bubble for explicit Retry.
      if (approval) {
        approval.isQueued = false
        if (skipFailedFirst && !isApproval) this.sendEvent({ type: 'user_message', sessionId: managed.id,
          message: approval, status: 'accepted', optimisticMessageId: replay.entries[0]?.optimisticMessageId }, managed.workspace.id)
      }
    }
    const following = isApproval || skipFailedFirst ? replay.entries.slice(1) : replay.entries
    managed.messageQueue = [...following, ...managed.messageQueue]
    for (const entry of following) {
      const queued = managed.messages.find(message => message.id === entry.messageId)
      if (queued) queued.isQueued = true
    }
  }

  /** Retire uncertain delivery into the existing durable, idempotent draft outbox. */
  private markUnacceptedInputForRestore(managed: ManagedSession, ownedIds?: Set<string>): Message[] {
    const messages = managed.messages.filter(message => message.role === 'user'
      && message.pendingDelivery && !message.hidden && !message.queuedRestoreId
      && (!ownedIds || ownedIds.has(message.id)))
    for (const message of messages) {
      message.pendingDelivery = undefined
      message.isQueued = true
      // Stable across a crash before this transition is flushed to disk.
      message.queuedRestoreId = `input-${message.id}`
    }
    const ids = new Set(messages.map(message => message.id))
    managed.messageQueue = managed.messageQueue.filter(entry => !entry.messageId || !ids.has(entry.messageId))
    if (managed.pendingQueueReplay?.entries.every(entry => entry.messageId && ids.has(entry.messageId))) {
      managed.pendingQueueReplay = undefined
    }
    return messages
  }

  /**
   * Central handler for when processing stops (any reason).
   * Single source of truth for cleanup and queue processing.
   *
   * @param sessionId - The session that stopped processing
   * @param reason - Why processing stopped ('complete' | 'interrupted' | 'error')
   */
  private async onProcessingStopped(
    sessionId: string,
    reason: 'complete' | 'interrupted' | 'error' | 'timeout',
    originatingGeneration?: number,
  ): Promise<void> {
    const managed = this.sessions.get(sessionId)
    if (!managed || originatingGeneration !== undefined && managed.processingGeneration !== originatingGeneration) return
    const generation = originatingGeneration ?? managed.processingGeneration
    const cleanupStopEpoch = managed.stopEpoch ?? 0
    const ownsCleanup = () => this.sessions.get(sessionId) === managed
      && managed.processingGeneration === generation && (managed.stopEpoch ?? 0) === cleanupStopEpoch

    sessionLog.info(`Processing stopped for session ${sessionId}: ${reason}`)
    // An aborted iterator may never deliver its final tool results. Settle the
    // host image before recovery IO, matching the renderer's terminal fallback
    // so a reload cannot revive tools from a stopped turn.
    if (reason !== 'complete') {
      const result = reason === 'error' ? 'Error occurred' : 'Interrupted'
      for (const message of managed.messages) {
        if (message.role !== 'tool' || message.toolResult !== undefined
          || message.toolStatus === 'completed' || message.toolStatus === 'error') continue
        message.toolStatus = 'error'
        message.toolResult = result
        message.isError = true
        if (message.toolUseId) {
          this.sendEvent({ type: 'tool_result', sessionId, toolUseId: message.toolUseId,
            toolName: message.toolName ?? 'unknown', result, isError: true,
            turnId: message.turnId, parentToolUseId: message.parentToolUseId,
            timestamp: message.timestamp }, managed.workspace.id)
        }
      }
    }
    // Retire processing before recovery IO, so a failed recovery write cannot
    // strand the session busy. The durable pending marker remains recoverable.
    this.setProcessing(managed, false)
    managed.stopRequested = false
    if (!managed.authRetryInProgress) {
      const undelivered = this.markUnacceptedInputForRestore(managed, new Set([
        ...(managed.lastSentMessageIds ?? []),
        ...(managed.acceptedSteers?.keys() ?? []),
      ])).map(message => structuredClone(message))
      if (undelivered.length) {
        this.persistSession(managed)
        let recoveryPersisted = false
        try {
          await this.flushSessionStrict(managed.id)
          recoveryPersisted = true
        } catch (error) {
          // The durable pending-delivery image still owns these inputs. Keep the stable
          // outbox in memory and retry its write, but never announce restoration before
          // that write succeeds. Cleanup must finish even when storage is unavailable.
          sessionLog.error(`Session ${sessionId}: input recovery persistence failed`, error)
          this.persistSession(managed)
          if (!ownsCleanup()) return
          reason = 'error'
          this.sendEvent({ type: 'error', sessionId,
            error: `Input recovery could not be saved: ${error instanceof Error ? error.message : String(error)}. The input is retained for recovery.`,
          }, managed.workspace.id)
        }
        if (!ownsCleanup()) return
        if (recoveryPersisted) {
          for (const message of undelivered) {
            if (!managed.messages.some(current => current.id === message.id
              && current.isQueued && current.queuedRestoreId === message.queuedRestoreId)) continue
            this.sendEvent({ type: 'interrupted', sessionId,
              queuedMessages: [message.content], queuedReferences: message.references,
              queuedAttachments: message.attachments, queuedRestoreId: message.queuedRestoreId,
              queuedMessageIds: [message.id] }, managed.workspace.id)
          }
        }
      }
    }
    const replayApprovalId = managed.pendingQueueReplay?.entries[0]?.messageId
    if (replayApprovalId && managed.lastSentMessageIds?.includes(replayApprovalId)) this.recoverPendingQueueReplay(managed)

    const activationSlot = managed.autoRetryPending
    if (activationSlot?.deliveryMessageId && activationSlot.ownedSteers?.length
      && managed.lastSentMessageIds?.includes(activationSlot.deliveryMessageId)) {
      // Setup or iterator failure before input acknowledgement never delivered the
      // continuation's owned input. Return it before normal queue draining.
      this.recoverActivationSteers(managed, activationSlot)
    }

    // Async producers retain unconfirmed delivery until their receipt arrives.
    if (!managed.agent?.settlePendingSteers) managed.acceptedSteers?.clear()

    // 1. Cleanup state
    this.setProcessing(managed, false)
    managed.stopRequested = false  // Reset for next turn
    // The scheduled auth retry owns continuation. Stop can still cancel this
    // idle interval, and a fresh send can supersede it before its callback runs.
    if (managed.authRetryInProgress) {
      this.persistSession(managed)
      return
    }
    // The request is over unless a source activation is about to re-send it.
    if (!managed.autoRetryTimer && managed.pendingActivationResend === undefined) {
      this.finishSuggestionTrace(managed)
      finishLargeResultExcerpts(managed.id)
    }

    // 1b. Orphan backstop: with the default per-turn subprocess model, any
    // background sub-agent still marked `running` dies when this turn's
    // subprocess is torn down. Flip those registry entries to `orphaned` so a
    // later "status?" query never reports a dead task as running. Suppressed
    // when WS2 keep-alive keeps the query alive across turns.
    this.markOrphanedBackgroundTasks(sessionId)

    const turnStartFinalMessageId = managed.turnStartFinalMessageId
    managed.turnStartFinalMessageId = undefined

    // Clear agent control overlay between turns. The session keeps browser
    // ownership (boundSessionId) — only the visual overlay is removed.
    // Full unbind happens below when the queue is empty (session truly done).
    const turnBpm = this.getBrowserPaneManagerForSession(sessionId)
    if (turnBpm) {
      // Same guard as the queue-empty teardown below: a remote BPM throw on a
      // headless server must not abort processing-stop handling.
      try {
        await turnBpm.clearVisualsForSession(sessionId)
      } catch (err) {
        sessionLog.warn(`Browser-pane visual clear failed for ${sessionId} (continuing):`, err)
      }
    }
    if (!ownsCleanup()) return

    // 2. Handle unread state based on whether user is viewing this session
    //    This is the explicit state machine for NEW badge:
    //    - If user is viewing: mark as read (they saw it complete)
    //    - If user is NOT viewing: mark as unread (they have new content)
    //    IMPORTANT: only apply this when the turn produced a NEW final assistant message.
    const isViewing = this.isSessionBeingViewed(sessionId, managed.workspace.id)
    const currentFinalMessageId = this.getLastFinalAssistantMessageId(managed.messages)
    const didReceiveNewFinalMessage = !!currentFinalMessageId && currentFinalMessageId !== turnStartFinalMessageId

    if (reason === 'complete' && didReceiveNewFinalMessage) {
      if (isViewing) {
        // User is watching - mark as read immediately
        await this.markSessionRead(sessionId)
        if (!ownsCleanup()) return
      } else {
        // User is not watching - mark as unread for NEW badge
        if (!managed.hasUnread) {
          managed.hasUnread = true
          await updateSessionMetadata(managed.workspace.rootPath, sessionId, { hasUnread: true })
          if (!ownsCleanup()) return
          this.emitUnreadSummaryChanged()
        }
      }
    }

    // 3. Auto-complete mini agent sessions to avoid session list clutter
    //    Mini agents are spawned from EditPopovers for quick config edits
    //    and should automatically move to 'done' when finished
    if (reason === 'complete' && managed.systemPromptPreset === 'mini' && managed.sessionStatus !== 'done') {
      sessionLog.info(`Auto-completing mini agent session ${sessionId}`)
      await this.setSessionStatus(sessionId, 'done')
      if (!ownsCleanup()) return
    }

    // 4. Apply deferred external metadata updates captured while processing.
    if (managed.pendingExternalMetadata) {
      const pendingHeader = managed.pendingExternalMetadata
      managed.pendingExternalMetadata = undefined
      sessionLog.info(`Applying deferred external metadata for session ${sessionId} after processing stop`)
      this.applyExternalSessionMetadata(managed, pendingHeader)
    }

    // A correlated manual compact continues on the host even when its input
    // Panel has been unmounted. The renderer remains a reload/reconnect wakeup;
    // the existing atomic dispatch rejects duplicate claims and Stop races.
    const compactedPlan = managed.pendingPlanExecution
    if (reason === 'complete' && compactedPlan && !compactedPlan.awaitingCompaction
      && !compactedPlan.executionDispatched && !compactedPlan.failed
      && compactedPlan.compactionTurn?.generation === generation
      && compactedPlan.compactionTurn.stopEpoch === cleanupStopEpoch
      && managed.messageQueue.length === 0 && !managed.pendingQueueReplay) {
      try {
        const handoff = await this.dispatchPendingPlanExecution(sessionId, compactedPlan.executionId)
        if (handoff.ok) return
      } catch (error) {
        sessionLog.warn(`Session ${sessionId}: compacted plan handoff failed; retained for recovery`, error)
      }
      if (!ownsCleanup()) return
    }

    // 5. Check queue and process or complete
    if (managed.messageQueue.length > 0) {
      // Has queued messages - process next
      this.processNextQueuedMessage(sessionId)
    } else {
      // Session is truly done — release active control while preserving the
      // Browser window's stable Chat and Project ownership for the next turn.
      const doneBpm = this.getBrowserPaneManagerForSession(sessionId)
      if (doneBpm) {
        // Teardown must never block completion. On a headless/WebUI server the BPM is
        // remote and these calls throw (BROWSER_NO_CAPABLE_CLIENT) when no desktop
        // browser client is connected — which previously aborted onProcessingStopped
        // before emitSessionComplete, hanging the Tasks Conductor completion seam.
        try {
          await doneBpm.clearVisualsForSession(sessionId)
          if (!ownsCleanup()) return
          doneBpm.unbindAllForSession(sessionId)
        } catch (err) {
          sessionLog.warn(`Browser-pane teardown failed for ${sessionId} (continuing to completion):`, err)
        }
      }
      if (!ownsCleanup()) return

      // No queue - emit complete to UI (include tokenUsage and hasUnread for state updates)
      this.sendEvent({
        type: 'complete',
        sessionId,
        tokenUsage: managed.tokenUsage,
        hasUnread: managed.hasUnread,  // Propagate unread state to renderer
        // WS2: when keep-alive keeps the persistent query open across turns, the
        // turn ending does NOT kill background sub-agents. Tell the renderer so its
        // chip orphan-backstop does not falsely flip live tasks to `orphaned`; a
        // real `task_completed` will arrive when the agent actually finishes.
        backgroundTasksAlive: this.keepBackgroundTasksAlive,
      }, managed.workspace.id)

      // Tasks Conductor seam: signal true completion (queue empty) with the stop
      // reason + this turn's final assistant message, so the Conductor can advance
      // the corresponding node. In-process only; never sent to the renderer/agents.
      const turnFinalMessageId = didReceiveNewFinalMessage ? currentFinalMessageId : undefined
      this.emitSessionComplete({
        sessionId,
        workspaceId: managed.workspace.id,
        reason,
        finalMessageId: turnFinalMessageId,
        finalText: turnFinalMessageId
          ? managed.messages.find(m => m.id === turnFinalMessageId)?.content
          : undefined,
        backgroundWorkRunning: this.countRunningBackgroundWork(managed),
        fromUser: managed.turnFromUser !== false,
        tokenUsage: managed.tokenUsage,
      })

      // Hidden/mini sessions have no status worth changing; task sessions are the Conductor's.
      if (reason === 'complete' && didReceiveNewFinalMessage && currentFinalMessageId
          && !managed.hidden && managed.systemPromptPreset !== 'mini' && !managed.taskRunId && !managed.taskSlug) {
        void this.applyTurnOutcome(managed, currentFinalMessageId)
        if (!managed.triggeredBy) void this.refreshTitleIfDrifted(managed)
      }
    }

    // 6. Always persist
    this.persistSession(managed)
  }

  /**
   * Process the next message in the queue.
   * Called by onProcessingStopped when queue has messages.
   */
  private processNextQueuedMessage(sessionId: string): void {
    const managed = this.sessions.get(sessionId)
    if (!managed || managed.messageQueue.length === 0 || managed.pendingQueueReplay) return

    const first = managed.messageQueue.shift()!
    // Mid-turn messages: entries judged to continue this one are replayed with it as one turn.
    const merged: typeof managed.messageQueue = []
    let last: object = first
    while (managed.messageQueue[0]?.mergeWith === last) {
      last = managed.messageQueue.shift()!
      merged.push(last as typeof first)
    }
    const next = merged.length > 0
      ? { ...first, message: [first, ...merged].map(entry => entry.message).join('\n\n') }
      : first
    const queueReplay: NonNullable<ManagedSession['pendingQueueReplay']> = { entries: [first, ...merged], stopEpoch: managed.stopEpoch ?? 0 }
    managed.pendingQueueReplay = queueReplay
    if (merged.length > 0 && first.messageId) {
      const ids = [first, ...merged].map(entry => entry.messageId).filter((id): id is string => !!id)
      ;(managed.replayMergedIds ??= new Map()).set(first.messageId, ids)
    }
    sessionLog.info('replay queued', {
      sessionId,
      messageId: next.messageId,
      mergedMessageIds: merged.length > 0 ? merged.map(entry => entry.messageId) : undefined,
      queueLengthAfterShift: managed.messageQueue.length,
    })

    // Update UI: queued → processing (merged continuations are delivered in the same turn)
    for (const entry of [first, ...merged]) {
      if (!entry.messageId) continue
      const existingMessage = managed.messages.find(m => m.id === entry.messageId)
      if (existingMessage) {
        // Scheduled replay still owns this input until admission (an approval
        // keeps ownership until producer acknowledgement). Stop can recover it.
        // Re-stamp so this replayed message sorts AFTER the previous turn's
        // finalized assistant reply. It was created mid-stream (an earlier
        // timestamp) while queued; groupMessagesByTurn sorts by timestamp, so
        // without this the prior turn's completed response would render BELOW it.
        existingMessage.timestamp = this.monotonic()
        this.persistSession(managed)

        this.sendEvent({
          type: 'user_message',
          sessionId,
          message: existingMessage,
          status: 'processing',
          optimisticMessageId: entry.optimisticMessageId
        }, managed.workspace.id)
      }
    }

    // Process message (use setImmediate to allow current stack to clear)
    setImmediate(() => {
      if (queueReplay && (this.sessions.get(sessionId) !== managed || managed.pendingQueueReplay !== queueReplay
        || (managed.stopEpoch ?? 0) !== queueReplay.stopEpoch
        || managed.pendingPlanExecution?.approvalMessageId === next.messageId && managed.pendingPlanExecution?.failed)) return
      this.sendMessage(
        sessionId,
        next.message,
        next.attachments,
        next.storedAttachments,
        next.options,
        next.messageId
      ).catch(err => {
        if (this.sessions.get(sessionId) !== managed || (managed.stopEpoch ?? 0) !== queueReplay.stopEpoch) return
        sessionLog.error('replay failed', {
          sessionId,
          messageId: next.messageId,
          error: err instanceof Error ? err.message : String(err),
        })
        // Report queued message failures via runtime hooks
        sessionRuntimeHooks.captureException(err, { errorSource: 'chat-queue', sessionId })
        if (queueReplay.processingGeneration !== undefined && managed.processingGeneration !== queueReplay.processingGeneration) {
          // This input failed, but a newer turn owns processing. Keep the
          // failure visible without sending a terminal error for that turn.
          const failedInput = managed.messages.find(message => message.id === next.messageId)?.content.replace(/\s+/g, ' ').trim() ?? ''
          const preview = failedInput.slice(0, 120) + (failedInput.length > 120 ? '…' : '')
          const warning: Message = {
            id: generateMessageId(),
            role: 'info',
            content: `Earlier queued input could not be sent${preview ? `: “${preview}”` : ''}. The original input remains in chat history; resend it to retry.`,
            timestamp: this.monotonic(),
            infoLevel: 'warning',
          }
          managed.messages.push(warning)
          this.persistSession(managed)
          this.sendEvent({ type: 'info', sessionId, message: warning.content, level: 'warning', timestamp: warning.timestamp }, managed.workspace.id)
          return
        }
        if (managed.pendingQueueReplay === queueReplay) this.recoverPendingQueueReplay(managed, true)
        // Surface a typed error so the UI can show a clear, actionable banner
        // instead of a generic "Unknown error" (#616).
        this.sendEvent({
          type: 'typed_error',
          sessionId,
          error: {
            code: 'queued_message_replay_failed',
            title: 'Queued message could not be sent',
            message: 'A message you sent while the agent was running could not be re-sent automatically. Tap retry to send it now.',
            actions: [{ key: 'r', label: 'Retry', action: 'retry' }],
            canRetry: true,
            originalError: err instanceof Error ? err.message : String(err),
          },
        }, managed.workspace.id)
        // An admitted replay settles in sendMessage's finally. A rejection
        // before admission may only drain an idle queue, never stop a newer turn.
        if (this.sessions.get(sessionId) === managed && !managed.isProcessing) this.processNextQueuedMessage(sessionId)
      })
    })
  }

  /**
   * Stop one background task (shell, agent or workflow) through the session's live agent (SDK
   * `stop_task`). The stopped status arrives as a task_completed event, which resolves the chip.
   * Without a live query the task cannot still be running: it ended with the subprocess that ran it.
   * (This replaced a `pgrep -f <command>` + SIGTERM that also killed same-command processes of other
   * sessions and projects.)
   */
  async stopBackgroundTask(sessionId: string, taskId: string): Promise<StopBackgroundTaskResult> {
    const managed = this.sessions.get(sessionId)
    if (!managed) return { success: false, error: 'Session not found' }
    const entry = managed.backgroundTaskRegistry.get(taskId)
    // Nothing alive to stop: record it, so status queries agree with the chip
    const notRunning = (): StopBackgroundTaskResult => {
      if (entry?.status === 'running') {
        entry.status = 'stopped'
        entry.completedAt = Date.now()
      }
      return { success: false, error: 'not-running' }
    }
    if (entry && entry.status !== 'running') return { success: false, error: 'not-running' }
    const stop = managed.agent?.stopBackgroundTask
    if (!stop) return notRunning()
    if (entry) entry.stopRequestedAt = Date.now()
    try {
      const stopped = await stop.call(managed.agent, taskId)
      sessionLog.info(`[bg-lifecycle] stop requested`, { sessionId, taskId, delivered: stopped })
      return stopped ? { success: true } : notRunning()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      // The CLI no longer knows the task (it finished, or died with an earlier subprocess), or the
      // query is gone: the task is not running — not a failure to report.
      if (/no task found|is not running|query closed|not running/i.test(message)) return notRunning()
      if (entry) entry.stopRequestedAt = undefined
      sessionLog.warn(`[bg-lifecycle] stop failed for task ${taskId}:`, error)
      return { success: false, error: 'failed' }
    }
  }

  /**
   * What a background task of the session has written so far, digested for the chip's card: a
   * shell's output tail, or an agent's latest message and recent steps. The file is the one the SDK
   * reported on completion, else the `<taskId>.output` named in the launching tool call's result
   * (see launchOutputFile). Null when there is nothing to read yet.
   */
  async getBackgroundTaskOutput(sessionId: string, taskId: string, kind?: 'agent' | 'shell' | 'workflow'): Promise<BackgroundTaskOutput | null> {
    const managed = this.sessions.get(sessionId)
    if (!managed) return null
    const path = this.backgroundTaskOutputFile(managed, taskId)
    if (!path) return null
    try {
      return await readBackgroundTaskOutput(path, kind)
    } catch (error) {
      sessionLog.debug(`[bg-lifecycle] no readable output for task ${taskId} (${path}):`, error)
      return null
    }
  }

  private backgroundTaskOutputFile(managed: ManagedSession, taskId: string): string | undefined {
    const reported = managed.backgroundTaskOutputs.get(taskId)?.outputFile
    if (reported) return reported
    const toolUseId = managed.backgroundTaskRegistry.get(taskId)?.toolUseId
    if (!toolUseId) return undefined
    const launch = managed.messages.find(message => message.toolUseId === toolUseId && message.toolResult)
    return launch?.toolResult ? launchOutputFile(launch.toolResult, taskId) : undefined
  }

  /**
   * Evict stale entries from both background-task maps to bound memory.
   * - backgroundTaskOutputs: completed outputs older than 1h (existing behavior).
   * - backgroundTaskRegistry: terminal/orphaned entries older than 1h. Running
   *   entries are never evicted here (they are resolved on completion or orphaned
   *   at turn end).
   */
  private evictStaleBackgroundTasks(managed: ManagedSession): void {
    const ONE_HOUR = 3_600_000
    const now = Date.now()
    for (const [tid, info] of managed.backgroundTaskOutputs) {
      if (now - info.completedAt > ONE_HOUR) {
        managed.backgroundTaskOutputs.delete(tid)
      }
    }
    for (const [tid, info] of managed.backgroundTaskRegistry) {
      if (info.status !== 'running' && info.completedAt && now - info.completedAt > ONE_HOUR) {
        managed.backgroundTaskRegistry.delete(tid)
      }
    }
  }

  /**
   * Mark still-running background tasks for a session as `orphaned`.
   *
   * Called when a turn finishes (onProcessingStopped). With the default per-turn
   * subprocess model, background sub-agents die when the query/subprocess is torn
   * down at turn end, but their terminal notifications may never arrive (or arrive
   * only on a later turn's subprocess). Marking them `orphaned` here keeps a
   * "status?" query truthful — it must never report a dead task as "running".
   *
   * No-op once WS2 keep-alive is enabled: with a persistent query the tasks
   * genuinely outlive the turn, so `keepBackgroundTasksAlive` short-circuits this.
   */
  private markOrphanedBackgroundTasks(sessionId: string): void {
    if (this.keepBackgroundTasksAlive) return
    const managed = this.sessions.get(sessionId)
    if (!managed) return
    const now = Date.now()
    let orphaned = 0
    for (const info of managed.backgroundTaskRegistry.values()) {
      if (info.status === 'running') {
        info.status = 'orphaned'
        info.completedAt = now
        orphaned++
      }
    }
    if (orphaned > 0) {
      sessionLog.info(`[bg-lifecycle] turn ended — orphaned ${orphaned} still-running background task(s)`, {
        sessionId,
      })
    }
  }

  /**
   * Background agents and Workflows the session's own agent launched that are still running.
   * Only keep-alive lets them outlive the turn (otherwise they were just marked orphaned), and
   * their completion wakes the idle session. Shells and other tasks are left out: a dev server or
   * a watcher may never end, and a task step must not wait for it.
   */
  private countRunningBackgroundWork(managed: ManagedSession): number {
    if (!this.keepBackgroundTasksAlive) return 0
    let running = 0
    for (const task of managed.backgroundTaskRegistry.values()) {
      if (task.status === 'running' && !task.untracked && (task.kind === 'agent' || task.kind === 'workflow')) running++
    }
    return running
  }

  /**
   * Enumerate background tasks for a session for a "status?" query.
   * Returns the main-process registry snapshot — the real source of truth across
   * subprocess boundaries (the SDK's in-subprocess task tools cannot see tasks
   * from a prior, torn-down subprocess).
   */
  listBackgroundTasks(sessionId: string): RunningBackgroundTask[] {
    const managed = this.sessions.get(sessionId)
    if (!managed) return []
    return Array.from(managed.backgroundTaskRegistry.values())
      .map((t) => ({ ...t }))
      .sort((a, b) => b.startTime - a.startTime)
  }

  /**
   * Respond to a pending permission request
   * Returns true if the response was delivered, false if agent/session is gone
   */
  respondToPermission(
    sessionId: string,
    requestId: string,
    allowed: boolean,
    alwaysAllow: boolean,
    options?: import('@craft-agent/shared/protocol').PermissionResponseOptions,
  ): boolean {
    const managed = this.sessions.get(sessionId)
    if (managed?.agent) {
      const requestMeta = this.pendingPermissionRequests.get(requestId)
      this.pendingPermissionRequests.delete(requestId)

      if (requestMeta?.type === 'admin_approval') {
        const brokerResult = this.privilegedExecutionBroker.resolveApproval(requestId, allowed, {
          expectedCommandHash: requestMeta.commandHash,
        })
        if (!brokerResult.ok) {
          sessionLog.warn(`Admin approval rejected by broker for ${requestId}: ${brokerResult.reason}`)
          // Broker rejection should fail closed.
          managed.agent.respondToPermission(requestId, false, false)
          return false
        }

        if (allowed && requestMeta.commandHash && options?.rememberForMinutes) {
          this.storeAdminRememberApproval(sessionId, requestMeta.commandHash, requestId, options.rememberForMinutes)
        }
      }

      sessionLog.info(`Permission response for ${requestId}: allowed=${allowed}, alwaysAllow=${alwaysAllow}`)
      managed.agent.respondToPermission(requestId, allowed, alwaysAllow)
      return true
    } else {
      sessionLog.warn(`Cannot respond to permission - no agent for session ${sessionId}`)
      return false
    }
  }

  /**
   * Respond to a pending credential request
   * Returns true if the response was delivered, false if no pending request found
   *
   * Supports both:
   * - New unified auth flow (via handleCredentialInput)
   * - Legacy callback flow (via pendingCredentialResolvers)
   */
  async respondToCredential(sessionId: string, requestId: string, response: import('@craft-agent/shared/protocol').CredentialResponse): Promise<boolean> {
    // First, check if this is a new unified auth flow request
    const managed = this.sessions.get(sessionId)
    if (managed?.pendingAuthRequest && managed.pendingAuthRequest.requestId === requestId) {
      sessionLog.info(`Credential response (unified flow) for ${requestId}: cancelled=${response.cancelled}`)
      await this.handleCredentialInput(sessionId, requestId, response)
      return true
    }

    // Fall back to legacy callback flow
    const resolver = this.pendingCredentialResolvers.get(requestId)
    if (resolver) {
      sessionLog.info(`Credential response (legacy flow) for ${requestId}: cancelled=${response.cancelled}`)
      resolver(response)
      this.pendingCredentialResolvers.delete(requestId)
      return true
    } else {
      sessionLog.warn(`Cannot respond to credential - no pending request for ${requestId}`)
      return false
    }
  }

  /**
   * Set the permission mode for a session ('safe', 'ask', 'guarded', 'allow-all')
   */
  setSessionPermissionMode(sessionId: string, mode: PermissionMode): void {
    const managed = this.sessions.get(sessionId)
    if (managed) {
      const previousManagedMode = managed.permissionMode ?? 'ask'
      const diagnosticsBefore = getPermissionModeDiagnostics(sessionId)
      const previousEffectiveMode = diagnosticsBefore.permissionMode

      // No-op only when BOTH managed state and mode-manager state already match.
      // If managed state matches but diagnostics drifted, heal authoritative mode state.
      if (previousManagedMode === mode && previousEffectiveMode === mode) {
        return
      }

      if (previousManagedMode === mode && previousEffectiveMode !== mode) {
        sessionLog.warn('Permission mode drift detected on same-mode update; reconciling authoritative mode state', {
          sessionId,
          managedMode: previousManagedMode,
          diagnosticsMode: previousEffectiveMode,
          targetMode: mode,
          modeVersion: diagnosticsBefore.modeVersion,
          changedBy: diagnosticsBefore.lastChangedBy,
        })
      }

      // Update in-memory managed mode first
      managed.permissionMode = mode

      // Reconcile mode-manager state for this specific session.
      if (previousEffectiveMode !== mode) {
        const changedBy = previousManagedMode === mode ? 'restore' : 'user'
        setPermissionMode(sessionId, mode, { changedBy })
      }

      const diagnostics = getPermissionModeDiagnostics(sessionId)
      managed.previousPermissionMode = diagnostics.previousPermissionMode
      sessionLog.info('Permission mode changed', {
        sessionId,
        permissionMode: mode,
        modeVersion: diagnostics.modeVersion,
        changedBy: diagnostics.lastChangedBy,
        changedAt: diagnostics.lastChangedAt,
      })

      // Forward to the agent instance so backends can propagate mode changes downstream.
      if (managed.agent) {
        managed.agent.setPermissionMode(mode)
      }

      this.sendEvent({
        type: 'permission_mode_changed',
        sessionId: managed.id,
        permissionMode: mode,
        modeVersion: diagnostics.modeVersion,
        changedBy: diagnostics.lastChangedBy,
        changedAt: diagnostics.lastChangedAt,
        previousPermissionMode: diagnostics.previousPermissionMode,
        transitionDisplay: diagnostics.transitionDisplay,
      }, managed.workspace.id)
      // Persist to disk
      this.persistSession(managed)
    }
  }

  /**
   * Get authoritative permission mode diagnostics for a session.
   * Used by renderer to reconcile optimistic/stale mode state.
   */
  getSessionPermissionModeState(sessionId: string): {
    permissionMode: PermissionMode
    previousPermissionMode?: PermissionMode
    transitionDisplay?: string
    modeVersion: number
    changedAt: string
    changedBy: 'user' | 'system' | 'restore' | 'automation' | 'unknown'
  } | null {
    const managed = this.sessions.get(sessionId)
    if (!managed) return null

    let diagnostics = getPermissionModeDiagnostics(sessionId)

    // Hydrate persisted transition context when mode-manager has been reset (e.g. app restart).
    if (managed.previousPermissionMode && !diagnostics.previousPermissionMode) {
      hydratePreviousPermissionMode(sessionId, managed.previousPermissionMode)
      diagnostics = getPermissionModeDiagnostics(sessionId)
    }

    // Heal restore races where mode-manager still has default state while
    // session metadata already has a persisted non-default mode.
    if (managed.permissionMode && diagnostics.permissionMode !== managed.permissionMode) {
      sessionLog.warn('Permission mode diagnostics mismatch, reconciling to managed session mode', {
        sessionId,
        managedMode: managed.permissionMode,
        diagnosticsMode: diagnostics.permissionMode,
        modeVersion: diagnostics.modeVersion,
        changedBy: diagnostics.lastChangedBy,
      })
      setPermissionMode(sessionId, managed.permissionMode, { changedBy: 'restore' })
      if (managed.previousPermissionMode) {
        hydratePreviousPermissionMode(sessionId, managed.previousPermissionMode)
      }
      diagnostics = getPermissionModeDiagnostics(sessionId)
    }

    managed.previousPermissionMode = diagnostics.previousPermissionMode

    return {
      permissionMode: diagnostics.permissionMode,
      previousPermissionMode: diagnostics.previousPermissionMode,
      transitionDisplay: diagnostics.transitionDisplay,
      modeVersion: diagnostics.modeVersion,
      changedAt: diagnostics.lastChangedAt,
      changedBy: diagnostics.lastChangedBy,
    }
  }

  /**
   * Set labels for a session (additive tags, many-per-session).
   * Labels are IDs referencing workspace labels/config.json.
   */
  async setSessionLabels(sessionId: string, labels: string[]): Promise<void> {
    const managed = this.sessions.get(sessionId)
    if (managed) {
      managed.labels = this.canonicalLabels(managed.workspace.rootPath, labels) ?? []
      this.setMetadataWriteGuard(managed)

      this.sendEvent({
        type: 'labels_changed',
        sessionId: managed.id,
        labels: managed.labels,
      }, managed.workspace.id)
      // Persist in-memory state directly to avoid race with pending queue writes
      this.persistSession(managed)
      await this.flushSession(managed.id)
      // Workaround: Bun's fs.watch({ recursive: true }) on Linux doesn't track
      // directories created after the watcher started.
      // https://github.com/oven-sh/bun/issues/15939
      const watcher = this.configWatchers.get(managed.workspace.rootPath)
      watcher?.notifyFileChange(`sessions/${sessionId}/session.jsonl`)
    }
  }

  async setSessionProjectNoteTarget(
    sessionId: string,
    projectId: string,
    relativePath: string,
  ): Promise<{ relativePath: string; recentPaths: string[] } | null> {
    const managed = this.sessions.get(sessionId)
    if (!managed || managed.projectId !== projectId) return null

    const recentPaths = [
      relativePath,
      ...(managed.projectNoteRecentTargetPaths ?? [])
        .filter(path => path !== relativePath),
    ].slice(0, 5)
    managed.projectNoteTargetPath = relativePath
    managed.projectNoteRecentTargetPaths = recentPaths
    this.setMetadataWriteGuard(managed)
    this.persistSession(managed)
    await this.flushSession(sessionId)

    const current = this.sessions.get(sessionId)
    if (
      current !== managed
      || current.projectId !== projectId
      || current.projectNoteTargetPath !== relativePath
    ) return null

    this.sendEvent({
      type: 'session_metadata_changed',
      sessionId,
      changes: {
        projectNoteTargetPath: managed.projectNoteTargetPath,
        projectNoteRecentTargetPaths: recentPaths,
      },
    }, managed.workspace.id)
    return { relativePath, recentPaths }
  }

  /**
   * Apply the reserved Task labeling to a session. Every task gets its own ITEM label —
   * a child of the root "Task" label named `TASK-<slug>-<N>` (plain boolean, no value) —
   * and the task's whole family carries that same item label, so one label filters one
   * task. Top-level sessions mint a fresh item label from their name; a session with
   * `parentSessionId` inherits the parent's item label — and a parent that lacks one (a
   * plain chat gaining its first subtask) is labeled in the same pass, so "becoming a
   * task" holds by construction. Idempotent: a session already carrying an item label
   * keeps it. Returns the resolved ITEM label id — slugs can collide-shift, so callers
   * MUST use it rather than deriving ids themselves.
   */
  async applyTaskLabel(
    sessionId: string,
    opts?: { parentSessionId?: string },
  ): Promise<{ labelId: string } | undefined> {
    const managed = this.sessions.get(sessionId)
    if (!managed) return undefined
    const rootPath = managed.workspace.rootPath

    const itemOf = (labels: string[] | undefined): string | undefined =>
      findTaskItemLabelId(labels, loadLabelConfig(rootPath).labels)
    const withItemEntry = (labels: string[] | undefined, itemId: string): string[] => [
      ...(labels ?? []).filter(entry => extractLabelId(entry) !== itemId),
      itemId,
    ]

    const existing = itemOf(managed.labels)
    if (existing) return { labelId: existing }

    let itemId: string
    const parent = opts?.parentSessionId ? this.sessions.get(opts.parentSessionId) : undefined
    if (parent) {
      const parentItem = itemOf(parent.labels)
      if (parentItem) {
        itemId = parentItem
      } else {
        itemId = ensureTaskItemLabel(rootPath, parent.name || 'task').itemId
        await this.setSessionLabels(parent.id, withItemEntry(parent.labels, itemId))
      }
    } else {
      itemId = ensureTaskItemLabel(rootPath, managed.name || 'task').itemId
    }

    await this.setSessionLabels(sessionId, withItemEntry(managed.labels, itemId))
    return { labelId: itemId }
  }

  /**
   * Set the kanban board column for a session ('todo' | 'in-progress' | 'done').
   * Pass `null` to clear (board falls back to the default column). Independent of sessionStatus.
   */
  async setKanbanColumn(sessionId: string, column: string | null): Promise<void> {
    const managed = this.sessions.get(sessionId)
    if (managed) {
      managed.kanbanColumn = column ?? undefined
      this.setMetadataWriteGuard(managed)

      this.persistSession(managed)
      await this.flushSession(managed.id)
      // Self-writes don't re-emit through the file watcher (kanbanColumn isn't in the header
      // signature), so push a live metadata event for the board to consume.
      this.sendEvent({ type: 'session_metadata_changed', sessionId, changes: { kanbanColumn: column ?? undefined } }, managed.workspace.id)
      const watcher = this.configWatchers.get(managed.workspace.rootPath)
      watcher?.notifyFileChange(`sessions/${sessionId}/session.jsonl`)
    }
  }

  /**
   * Record the total DAG node count on a Conductor orchestrator session. The board uses this as a
   * stable progress denominator so it doesn't grow as child sessions are spawned lazily at dispatch.
   */
  async setTaskNodeCount(sessionId: string, count: number): Promise<void> {
    const managed = this.sessions.get(sessionId)
    if (managed) {
      managed.taskNodeCount = count
      this.setMetadataWriteGuard(managed)

      this.persistSession(managed)
      await this.flushSession(managed.id)
      // Self-writes don't re-emit through the file watcher (taskNodeCount isn't in the header
      // signature), so push a live metadata event so the progress denominator updates immediately.
      this.sendEvent({ type: 'session_metadata_changed', sessionId, changes: { taskNodeCount: count } }, managed.workspace.id)
      const watcher = this.configWatchers.get(managed.workspace.rootPath)
      watcher?.notifyFileChange(`sessions/${sessionId}/session.jsonl`)
    }
  }

  /**
   * Promote a hidden generate-time orchestrator (`taskDraft`) into the real, board-visible
   * orchestrator for `taskSlug`. This is the single narrow path that lets "Generate → Create & Run"
   * reuse the draft session instead of minting a second top-level tile (#bug1).
   *
   * Returns `true` on success (including an idempotent re-adopt of the same slug). Returns `false`
   * — leaving the session untouched — when the session is missing, isn't a draft, or is already
   * bound to a *different* slug. Callers fall back to `createSession` on `false`.
   *
   * Deliberately does NOT touch tools/sources/capabilities: the orchestrator keeps everything it
   * was created with so it can still author/verify the run.
   */
  async adoptGeneratedTaskOrchestrator(
    sessionId: string,
    taskSlug: string,
    reconcile?: { workspaceId?: string; projectId?: string; name?: string; workingDirectory?: string; model?: string; llmConnection?: string; permissionMode?: PermissionMode },
  ): Promise<boolean> {
    return this.withSessionLifecycleLock(sessionId, async () => {
      const managed = this.sessions.get(sessionId)
      if (!managed) return false
      // Validate ownership even for idempotent binds; a repeated slug is not authorization.
      if (reconcile?.workspaceId && managed.workspace.id !== reconcile.workspaceId) {
        throw new Error('CROSS_WORKSPACE_SESSION: a Task and its Session must belong to the same Workspace')
      }
      if (reconcile?.projectId && managed.projectId !== reconcile.projectId) {
        throw new Error('CROSS_PROJECT_SESSION: a Task cannot change an existing Session\'s Project')
      }
      if (managed.taskSlug) return managed.taskSlug === taskSlug
      if (!managed.taskDraft) {
        sessionLog.warn('adoptGeneratedTaskOrchestrator: session is not a task draft', { sessionId, taskSlug })
        return false
      }
      // A metadata-only lookup must not let a cold Session look unused when deciding sdkCwd.
      await this.ensureMessagesLoaded(managed)
      if (this.sessions.get(sessionId) !== managed) return false

      const modelChanged = Boolean(reconcile?.model && reconcile.model !== managed.model)
      const connectionChanged = Boolean(reconcile?.llmConnection && !managed.connectionLocked && reconcile.llmConnection !== managed.llmConnection)
      const cwdChanged = Boolean(reconcile?.workingDirectory && reconcile.workingDirectory !== managed.workingDirectory)
      const modeChanged = Boolean(reconcile?.permissionMode && reconcile.permissionMode !== managed.permissionMode)
      const renamed = Boolean(reconcile?.name && reconcile.name !== managed.name)
      if (cwdChanged) {
        const validation = isValidWorkingDirectory(reconcile!.workingDirectory!)
        if (!validation.valid) throw new Error(`Invalid Task working directory: ${validation.reason}`)
      }

      const previous = {
        taskSlug: managed.taskSlug,
        taskDraft: managed.taskDraft,
        name: managed.name,
        model: managed.model,
        llmConnection: managed.llmConnection,
        workingDirectory: managed.workingDirectory,
        sdkCwd: managed.sdkCwd,
        permissionMode: managed.permissionMode,
        previousPermissionMode: managed.previousPermissionMode,
      }
      const staged = {
        taskSlug,
        taskDraft: false,
        name: renamed ? reconcile!.name! : previous.name,
        model: modelChanged ? reconcile!.model : previous.model,
        llmConnection: connectionChanged ? reconcile!.llmConnection : previous.llmConnection,
        workingDirectory: cwdChanged ? reconcile!.workingDirectory : previous.workingDirectory,
        sdkCwd: cwdChanged && managed.messages.length === 0 && !managed.sdkSessionId && !managed.agent
          ? reconcile!.workingDirectory : previous.sdkCwd,
        permissionMode: modeChanged ? reconcile!.permissionMode : previous.permissionMode,
        previousPermissionMode: modeChanged ? (previous.permissionMode ?? 'ask') : previous.previousPermissionMode,
      }
      Object.assign(managed, staged)
      this.setMetadataWriteGuard(managed)
      try {
        this.persistSession(managed)
        await this.flushSessionStrict(sessionId)
      } catch (error) {
        // Other metadata editors do not all take the lifecycle lock. Roll back only values
        // still owned by this write, preserving any later explicit edits while the I/O waited.
        for (const key of Object.keys(previous) as Array<keyof typeof previous>) {
          if (managed[key] === staged[key]) Object.assign(managed, { [key]: previous[key] })
        }
        this.setMetadataWriteGuard(managed)
        this.persistSession(managed)
        await this.flushSessionStrict(sessionId).catch(rollbackError => {
          sessionLog.warn('adoptGeneratedTaskOrchestrator: could not persist binding rollback', { sessionId, rollbackError })
        })
        throw error
      }

      // The binding is durable. Preserve the canonical live updates, but a runtime failure
      // must not turn this committed Task into a rejected RPC and roll back only its YAML.
      const runtimeUpdates: Array<() => void | Promise<void>> = []
      if (modelChanged) runtimeUpdates.push(() => {
        if (managed.model === staged.model) return this.updateSessionModel(sessionId, managed.workspace.id, staged.model!)
      })
      if (cwdChanged) runtimeUpdates.push(() => {
        if (managed.workingDirectory === staged.workingDirectory) this.updateWorkingDirectory(sessionId, staged.workingDirectory!)
      })
      if (modeChanged) runtimeUpdates.push(() => {
        if (managed.permissionMode !== staged.permissionMode) return
        // Let the canonical mutator retain its user-change signal and previous-mode history.
        managed.permissionMode = previous.permissionMode
        this.setSessionPermissionMode(sessionId, staged.permissionMode!)
      })
      if (connectionChanged) runtimeUpdates.push(() => this.tryRefreshAgentRuntime(managed, 'Task connection update'))
      for (const update of runtimeUpdates) {
        try {
          await update()
        } catch (error) {
          // Non-empty stale signatures use the existing send-path refresh/rebuild gate. An
          // active Agent is not disposed here; the next idle turn recreates the failed runtime.
          managed.backendRuntimeSignature = 'task-runtime-reconciliation-pending'
          managed.backendRestartSignature = 'task-runtime-reconciliation-pending'
          sessionLog.warn('adoptGeneratedTaskOrchestrator: Task saved; runtime refresh deferred', { sessionId, error })
        }
      }
      try {
        this.sendEvent({ type: 'session_metadata_changed', sessionId, changes: { taskDraft: false, taskSlug } }, managed.workspace.id)
        if (renamed) this.sendEvent({ type: 'name_changed', sessionId, name: managed.name }, managed.workspace.id)
        if (connectionChanged) {
          this.sendEvent({
            type: 'connection_changed', sessionId, connectionSlug: managed.llmConnection!,
            supportsBranching: resolveSupportsBranching(managed),
          }, managed.workspace.id)
        }
        this.configWatchers.get(managed.workspace.rootPath)?.notifyFileChange(`sessions/${sessionId}/session.jsonl`)
      } catch (error) {
        sessionLog.warn('adoptGeneratedTaskOrchestrator: Task saved; metadata notification failed', { sessionId, error })
      }
      sessionLog.info('adoptGeneratedTaskOrchestrator: promoted draft', { sessionId, taskSlug, renamed, modelChanged, connectionChanged, cwdChanged, modeChanged })
      return true
    })
  }

  /**
   * User-initiated bind of an *existing, visible* session (e.g. a quick-add tile) to a task slug.
   *
   * This is distinct from {@link adoptGeneratedTaskOrchestrator}, which is the narrow draft-only
   * promotion path. A quick-add tile is a normal non-draft session with no `taskSlug`; the draft
   * guard there correctly refuses it, so the editor's "save this spec onto this tile" flow needs
   * its own path. The guard in the adopt method stays untouched.
   *
   * Returns `true` on success (including an idempotent re-bind of the same slug). Returns `false`
   * — leaving the session untouched — when the session is missing or already bound to a *different*
   * slug. Callers MUST treat `false` as a hard error and must NOT fall back to creating a fresh
   * orchestrator (that would mint a duplicate tile).
   *
   * Unlike adopt, this reconciles `llmConnection` too (a fresh create sets it; adopt skips it) so
   * the bound tile doesn't render a stale backend.
   */
  async bindExistingSessionToTask(
    sessionId: string,
    taskSlug: string,
    reconcile?: { workspaceId?: string; projectId?: string; name?: string; workingDirectory?: string; model?: string; llmConnection?: string; permissionMode?: PermissionMode },
  ): Promise<boolean> {
    return this.withSessionLifecycleLock(sessionId, async () => {
      const managed = this.sessions.get(sessionId)
      if (!managed) return false
      // Validate ownership even for idempotent binds; a repeated slug is not authorization.
      if (reconcile?.workspaceId && managed.workspace.id !== reconcile.workspaceId) {
        throw new Error('CROSS_WORKSPACE_SESSION: a Task and its Session must belong to the same Workspace')
      }
      if (reconcile?.projectId && managed.projectId !== reconcile.projectId) {
        throw new Error('CROSS_PROJECT_SESSION: a Task cannot change an existing Session\'s Project')
      }
      if (managed.taskSlug) return managed.taskSlug === taskSlug

      // A metadata-only lookup must not let a cold Session look unused when deciding sdkCwd.
      await this.ensureMessagesLoaded(managed)
      if (this.sessions.get(sessionId) !== managed) return false

      const modelChanged = Boolean(reconcile?.model && reconcile.model !== managed.model)
      const connectionChanged = Boolean(reconcile?.llmConnection && !managed.connectionLocked && reconcile.llmConnection !== managed.llmConnection)
      const cwdChanged = Boolean(reconcile?.workingDirectory && reconcile.workingDirectory !== managed.workingDirectory)
      const modeChanged = Boolean(reconcile?.permissionMode && reconcile.permissionMode !== managed.permissionMode)
      const renamed = Boolean(reconcile?.name && reconcile.name !== managed.name)
      if (cwdChanged) {
        const validation = isValidWorkingDirectory(reconcile!.workingDirectory!)
        if (!validation.valid) throw new Error(`Invalid Task working directory: ${validation.reason}`)
      }

      const previous = {
        taskSlug: managed.taskSlug,
        taskDraft: managed.taskDraft,
        name: managed.name,
        model: managed.model,
        llmConnection: managed.llmConnection,
        workingDirectory: managed.workingDirectory,
        sdkCwd: managed.sdkCwd,
        permissionMode: managed.permissionMode,
        previousPermissionMode: managed.previousPermissionMode,
      }
      const staged = {
        taskSlug,
        taskDraft: false,
        name: renamed ? reconcile!.name! : previous.name,
        model: modelChanged ? reconcile!.model : previous.model,
        llmConnection: connectionChanged ? reconcile!.llmConnection : previous.llmConnection,
        workingDirectory: cwdChanged ? reconcile!.workingDirectory : previous.workingDirectory,
        sdkCwd: cwdChanged && managed.messages.length === 0 && !managed.sdkSessionId && !managed.agent
          ? reconcile!.workingDirectory : previous.sdkCwd,
        permissionMode: modeChanged ? reconcile!.permissionMode : previous.permissionMode,
        previousPermissionMode: modeChanged ? (previous.permissionMode ?? 'ask') : previous.previousPermissionMode,
      }
      Object.assign(managed, staged)
      this.setMetadataWriteGuard(managed)
      try {
        this.persistSession(managed)
        await this.flushSessionStrict(sessionId)
      } catch (error) {
        // Other metadata editors do not all take the lifecycle lock. Roll back only values
        // still owned by this write, preserving any later explicit edits while the I/O waited.
        for (const key of Object.keys(previous) as Array<keyof typeof previous>) {
          if (managed[key] === staged[key]) Object.assign(managed, { [key]: previous[key] })
        }
        this.setMetadataWriteGuard(managed)
        this.persistSession(managed)
        await this.flushSessionStrict(sessionId).catch(rollbackError => {
          sessionLog.warn('bindExistingSessionToTask: could not persist binding rollback', { sessionId, rollbackError })
        })
        throw error
      }

      // The binding is durable. Preserve the canonical live updates, but a runtime failure
      // must not turn this committed Task into a rejected RPC and roll back only its YAML.
      const runtimeUpdates: Array<() => void | Promise<void>> = []
      if (modelChanged) runtimeUpdates.push(() => {
        if (managed.model === staged.model) return this.updateSessionModel(sessionId, managed.workspace.id, staged.model!)
      })
      if (cwdChanged) runtimeUpdates.push(() => {
        if (managed.workingDirectory === staged.workingDirectory) this.updateWorkingDirectory(sessionId, staged.workingDirectory!)
      })
      if (modeChanged) runtimeUpdates.push(() => {
        if (managed.permissionMode !== staged.permissionMode) return
        // Let the canonical mutator retain its user-change signal and previous-mode history.
        managed.permissionMode = previous.permissionMode
        this.setSessionPermissionMode(sessionId, staged.permissionMode!)
      })
      if (connectionChanged) runtimeUpdates.push(() => this.tryRefreshAgentRuntime(managed, 'Task connection update'))
      for (const update of runtimeUpdates) {
        try {
          await update()
        } catch (error) {
          // Non-empty stale signatures use the existing send-path refresh/rebuild gate. An
          // active Agent is not disposed here; the next idle turn recreates the failed runtime.
          managed.backendRuntimeSignature = 'task-runtime-reconciliation-pending'
          managed.backendRestartSignature = 'task-runtime-reconciliation-pending'
          sessionLog.warn('bindExistingSessionToTask: Task saved; runtime refresh deferred', { sessionId, error })
        }
      }
      try {
        this.sendEvent({ type: 'session_metadata_changed', sessionId, changes: { taskDraft: false, taskSlug } }, managed.workspace.id)
        if (renamed) this.sendEvent({ type: 'name_changed', sessionId, name: managed.name }, managed.workspace.id)
        if (connectionChanged) {
          this.sendEvent({
            type: 'connection_changed', sessionId, connectionSlug: managed.llmConnection!,
            supportsBranching: resolveSupportsBranching(managed),
          }, managed.workspace.id)
        }
        this.configWatchers.get(managed.workspace.rootPath)?.notifyFileChange(`sessions/${sessionId}/session.jsonl`)
      } catch (error) {
        sessionLog.warn('bindExistingSessionToTask: Task saved; metadata notification failed', { sessionId, error })
      }
      sessionLog.info('bindExistingSessionToTask: bound existing session', { sessionId, taskSlug, renamed, modelChanged, connectionChanged, cwdChanged, modeChanged })
      return true
    })
  }

  /**
   * Set the thinking level for a session. See {@link ThinkingLevel} for valid values.
   * This is sticky and persisted across messages.
   */
  setSessionThinkingLevel(sessionId: string, level: ThinkingLevel): void {
    const managed = this.sessions.get(sessionId)
    if (managed) {
      // Update thinking level in managed session
      managed.thinkingLevel = level

      // Update the agent's thinking level if it exists
      if (managed.agent) {
        managed.agent.setThinkingLevel(level)
      }

      sessionLog.info(`Session ${sessionId}: thinking level set to ${level}`)
      // Persist to disk
      this.persistSession(managed)
    }
  }

  /**
   * Turn coding mode on or off: the lean coding system prompt and session-tool profile.
   * Only before the conversation starts (see {@link hasConversationStarted}); after that the UI
   * offers to continue in a new session instead, so this throws.
   */
  setSessionCodingMode(sessionId: string, enabled: boolean): void {
    const managed = this.sessions.get(sessionId)
    if (!managed || !!managed.codingMode === enabled) return
    if (hasConversationStarted(managed)) {
      throw new Error('Coding mode is fixed once a session has messages. Continue in a new session to switch it.')
    }

    // Stored only when on, so sessions that never use it keep an unchanged header
    managed.codingMode = enabled || undefined
    managed.agent?.setAgentProfile(enabled ? 'coding' : 'default')

    sessionLog.info(`Session ${sessionId}: coding mode ${enabled ? 'on' : 'off'}`)
    this.persistSession(managed)
    this.sendEvent({ type: 'coding_mode_changed', sessionId, codingMode: enabled }, managed.workspace.id)
  }

  /**
   * Continue a started session in a new one with coding mode set to `codingMode` (coding mode is
   * fixed once a conversation starts, see {@link setSessionCodingMode}). The new session keeps the
   * working directory, model, connection, thinking level, permission mode, sources and project, and
   * gets a summary of this conversation as one-shot hidden context on its first turn (the same
   * handoff remote transfers use). The source session is left untouched.
   *
   * The summary is a model call that takes seconds, so the new session is returned at once and the
   * summary is attached in the background (`attachHandoffSummary`); a first message sent before it
   * is ready waits for it in `sendMessage`.
   */
  async continueSessionInNewSession(sessionId: string, codingMode: boolean): Promise<{ sessionId: string }> {
    const managed = this.sessions.get(sessionId)
    if (!managed) throw new Error(`Session ${sessionId} not found`)

    const session = await this.createSession(managed.workspace.id, {
      permissionMode: managed.permissionMode,
      thinkingLevel: managed.thinkingLevel,
      workingDirectory: managed.workingDirectory ?? 'none',
      model: managed.model,
      llmConnection: managed.llmConnection,
      enabledSourceSlugs: managed.enabledSourceSlugs,
      projectId: managed.projectId,
      codingMode,
    })

    const created = this.sessions.get(session.id)
    if (created) {
      const pending: Promise<void> = this.attachHandoffSummary(managed, created).finally(() => {
        if (created.pendingHandoffSummary === pending) created.pendingHandoffSummary = undefined
      })
      created.pendingHandoffSummary = pending
    }
    sessionLog.info(`Session ${sessionId}: continued in ${session.id} with coding mode ${codingMode ? 'on' : 'off'}; summarizing the conversation in the background`)
    return { sessionId: session.id }
  }

  /** Wait for a continued session's handoff summary, at most `handoffSummaryWaitMs`. */
  private async waitForHandoffSummary(managed: ManagedSession): Promise<void> {
    const pending = managed.pendingHandoffSummary
    if (!pending) return
    const startedAt = Date.now()
    let timer: ReturnType<typeof setTimeout> | undefined
    const ready = await Promise.race([
      pending.then(() => true),
      new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), this.handoffSummaryWaitMs) }),
    ])
    clearTimeout(timer)
    sessionLog.info(`Session ${managed.id}: first turn waited ${Date.now() - startedAt} ms for the previous session's summary${ready ? '' : ', starting without it'}`)
  }

  /**
   * Summarize `source`'s conversation and give it to `target` as one-shot hidden context for its
   * first turn (`transferredSessionSummary`). Never throws: without a summary the new session just
   * starts without the earlier context.
   */
  private async attachHandoffSummary(source: ManagedSession, target: ManagedSession): Promise<void> {
    const startedAt = Date.now()
    try {
      const summary = await this.generateSessionHandoffSummary(source)
      // Deleted while the summary was generated
      if (this.sessions.get(target.id) !== target) return
      if (summary) {
        target.transferredSessionSummary = summary
        target.transferredSessionSummaryApplied = false
        this.persistSession(target)
        await sessionPersistenceQueue.flush(target.id)
      }
      sessionLog.info(`Session ${target.id}: summary of ${source.id} ${summary ? `ready (${summary.length} chars)` : 'empty'} after ${Date.now() - startedAt} ms`)
    } catch (error) {
      sessionLog.warn(`Session ${target.id}: summary of ${source.id} failed after ${Date.now() - startedAt} ms:`, error)
    }
  }

  /** Coding mode: PRs pinned to a session (chat-header PR carousel), in addedAt order. */
  getSessionBoundPrs(sessionId: string): BoundPr[] {
    return this.sessions.get(sessionId)?.boundPrs ?? []
  }

  /**
   * Pin a PR to a session (pr_bind). Deduped by host/owner/repo#number — re-binding an existing PR
   * refreshes its position — then persisted. Returns the new list (addedAt order).
   */
  bindPrToSession(sessionId: string, pr: BoundPr): BoundPr[] {
    const managed = this.sessions.get(sessionId)
    if (!managed) throw new Error(`Session ${sessionId} not found`)
    const next = [...(managed.boundPrs ?? []).filter(p => !sameBoundPr(p, pr)), pr].sort((a, b) => a.addedAt - b.addedAt)
    managed.boundPrs = next
    sessionLog.info(`Session ${sessionId}: bound PR ${pr.owner}/${pr.repo}#${pr.number} (${next.length} total)`)
    this.persistSession(managed)
    return next
  }

  /** Remove a pinned PR from a session (pr_unbind); persists and returns the new list. */
  unbindPrFromSession(sessionId: string, pr: { host: string; owner: string; repo: string; number: number }): BoundPr[] {
    const managed = this.sessions.get(sessionId)
    if (!managed) throw new Error(`Session ${sessionId} not found`)
    const next = (managed.boundPrs ?? []).filter(p => !sameBoundPr(p, pr))
    // Stored only when non-empty, so sessions that never bind keep an unchanged header (like codingMode)
    managed.boundPrs = next.length ? next : undefined
    // An unbound PR's auto-fix goes with it
    const monitorId = prEntryId(pr)
    if (managed.prMonitors?.[monitorId]) {
      const { [monitorId]: _dropped, ...rest } = managed.prMonitors
      managed.prMonitors = Object.keys(rest).length ? rest : undefined
    }
    sessionLog.info(`Session ${sessionId}: unbound PR ${pr.owner}/${pr.repo}#${pr.number} (${next.length} left)`)
    this.persistSession(managed)
    return next
  }

  /** Coding mode: per-PR monitor state (auto-fix), keyed by PR id. */
  getSessionPrMonitors(sessionId: string): Record<string, PrMonitorState> {
    return this.sessions.get(sessionId)?.prMonitors ?? {}
  }

  /**
   * Turn auto-fix (the PR card's Fix toggle) on or off for one PR of a session; persists and returns
   * the monitors. Turning it off keeps what the last run acted on, so turning it back on only fixes
   * feedback that is new since then.
   */
  setSessionPrAutoFix(sessionId: string, prId: string, enabled: boolean): Record<string, PrMonitorState> {
    const managed = this.sessions.get(sessionId)
    if (!managed) throw new Error(`Session ${sessionId} not found`)
    const monitors = { ...(managed.prMonitors ?? {}) }
    const entry: PrMonitorState = { ...(monitors[prId] ?? {}), autoFix: enabled || undefined }
    if (entry.autoFix || entry.lastFixAt) monitors[prId] = entry
    else delete monitors[prId]
    managed.prMonitors = Object.keys(monitors).length ? monitors : undefined
    sessionLog.info(`Session ${sessionId}: auto-fix ${enabled ? 'on' : 'off'} for ${prId}`)
    this.persistSession(managed)
    return managed.prMonitors ?? {}
  }

  /** Record an auto-fix run: when, and the review feedback (signature) it acted on. */
  recordPrAutoFixRun(sessionId: string, prId: string, signature: string[], at: number): void {
    const managed = this.sessions.get(sessionId)
    if (!managed) return
    managed.prMonitors = { ...(managed.prMonitors ?? {}), [prId]: { ...(managed.prMonitors?.[prId] ?? {}), lastFixAt: at, lastFixSignature: signature } }
    this.persistSession(managed)
  }

  /** A session's metadata without loading its messages (cheap, unlike getSession). */
  getSessionSnapshot(sessionId: string): Session | null {
    const managed = this.sessions.get(sessionId)
    return managed ? managedToSession(managed) : null
  }

  /**
   * Start a turn in an idle session with an app-generated notice: hidden (never a transcript bubble)
   * and labelled as sent by Craft Agents, not the user — the same path background-task completions
   * use. Returns false, sending nothing, when the session is missing or busy, so the caller can retry.
   */
  wakeIdleSessionWithNotice(sessionId: string, text: string): boolean {
    const managed = this.sessions.get(sessionId)
    if (!managed || managed.isProcessing) return false
    void this.sendMessage(sessionId, labelSystemNotice(text), [], [], { hidden: true }).catch((err) => {
      sessionLog.error(`Session ${sessionId}: failed to start a system-notice turn:`, err)
    })
    return true
  }

  /**
   * Generate an AI title for a session from the user's first message.
   * Uses the agent's generateTitle() method which handles provider-specific SDK calls.
   * If no agent exists, creates a temporary one using the session's connection.
   */
  private async generateTitle(managed: ManagedSession, userMessage: string): Promise<void> {
    sessionLog.info(`[generateTitle] Starting for session ${managed.id}`)

    // Use existing agent or create temporary one
    let agent: AgentInstance | null = managed.agent
    let isTemporary = false

    // Wait briefly for agent to be created (it's created concurrently)
    if (!agent) {
      let attempts = 0
      while (!managed.agent && attempts < 10) {
        await new Promise(resolve => setTimeout(resolve, 100))
        attempts++
      }
      agent = managed.agent
    }

    // If still no agent, create a temporary one using the session's connection
    if (!agent && managed.llmConnection) {
      try {
        const connection = getLlmConnection(managed.llmConnection)

        agent = createBackendFromConnection(managed.llmConnection, {
          workspace: managed.workspace,
          model: managed.model,
          miniModel: connection ? (getMiniModel(connection) ?? connection.defaultModel) : undefined,
          session: {
            id: `title-${managed.id}`,
            workspaceRootPath: managed.workspace.rootPath,
            projectId: managed.projectId,
            llmConnection: managed.llmConnection,
            createdAt: Date.now(),
            lastUsedAt: Date.now(),
          },
          isHeadless: true,
        }, buildBackendHostRuntimeContext()) as AgentInstance
        await agent.postInit()
        isTemporary = true
        sessionLog.info(`[generateTitle] Created temporary agent for session ${managed.id}`)
      } catch (error) {
        sessionLog.error(`[generateTitle] Failed to create temporary agent:`, error)
        return
      }
    }

    if (!agent) {
      sessionLog.warn(`[generateTitle] No agent and no connection for session ${managed.id}`)
      return
    }

    try {
      // Race-free language resolution from persisted UI language; undefined => auto-detect (#885).
      const titleLanguage = resolveTitleLanguageName()
      sessionLog.info(`[generateTitle] language at call time`, {
        sessionId: managed.id,
        persistedUiLanguage: getPersistedUiLanguage() ?? null,
        resolvedLanguage: i18n.resolvedLanguage ?? null,
        titleLanguage: titleLanguage ?? null,
      })
      const title = await agent.generateTitle(userMessage, { language: titleLanguage })
      if (title && managed.autoTitle !== undefined && managed.name !== managed.autoTitle) {
        // Renamed while the title was generating: the user's (or an external) name wins.
        sessionLog.info(`[generateTitle] Session ${managed.id} was renamed meanwhile, keeping "${managed.name}"`)
      } else if (title) {
        managed.name = title
        managed.autoTitle = title
        this.persistSession(managed)
        // Flush immediately to ensure disk is up-to-date before notifying renderer.
        // This prevents race condition where lazy loading reads stale disk data
        // (the persistence queue has a 500ms debounce).
        await this.flushSession(managed.id)
        // Now safe to notify renderer - disk is authoritative
        this.sendEvent({ type: 'title_generated', sessionId: managed.id, title }, managed.workspace.id)
        sessionLog.info(`Generated title for session ${managed.id}: "${title}"`)
      } else {
        sessionLog.warn(`Title generation returned null for session ${managed.id}`)
      }
    } catch (error) {
      sessionLog.error(`Failed to generate title for session ${managed.id}:`, error)

      // Surface quota/auth errors to the user — these indicate the main chat call will also fail
      const errorMsg = error instanceof Error ? error.message : String(error)
      if (errorMsg.includes('quota') || errorMsg.includes('429') || errorMsg.includes('401') || errorMsg.includes('insufficient')) {
        this.sendEvent({
          type: 'typed_error',
          sessionId: managed.id,
          error: {
            code: 'provider_error',
            title: 'API Error',
            message: `API error: ${errorMsg.slice(0, 200)}`,
            actions: [{ key: 'r', label: 'Retry', action: 'retry' }],
            canRetry: true,
          }
        }, managed.workspace.id)
      }
    } finally {
      // Clean up temporary agent
      if (isTemporary && agent) {
        agent.destroy()
      }
    }
  }

  private async processEvent(
    managed: ManagedSession,
    event: AgentEvent,
    /**
     * Turn context captured when the EMITTING send's execution started. The
     * compaction completion/failure paths compare the record's correlation
     * against THIS — a late event from an older turn can never authorize or
     * cancel a fresh record, no matter what the live generation is now.
     */
    originatingTurn?: { generation: number; stopEpoch: number },
  ): Promise<void> {
    const sessionId = managed.id
    const workspaceId = managed.workspace.id
    this.notifySessionActivity(sessionId)

    switch (event.type) {
      case 'text_delta':
        managed.streamingText += event.text
        managed.streamingTurnId = event.turnId
        // Queue delta for batched sending (performance: reduces IPC from 50+/sec to ~20/sec)
        this.queueDelta(sessionId, workspaceId, event.text, event.turnId)
        break

      case 'text_discard':
        // Discard, NEVER flush, the failed attempt's batch before announcing
        // backoff. Otherwise a delayed failed token can arrive after retry start.
        this.discardDelta(sessionId, event.turnId)
        if (managed.streamingTurnId === event.turnId) {
          managed.streamingText = ''
          managed.streamingTurnId = undefined
        }
        this.sendEvent({ ...event, sessionId }, workspaceId)
        break

      case 'retry':
        // Retry progress is transient; do not persist it as transcript history.
        this.sendEvent({ ...event, sessionId }, workspaceId)
        break

      case 'text_complete': {
        // Flush any pending deltas before sending complete (ensures renderer has all content)
        this.flushDelta(sessionId, workspaceId)

        const assistantMessage: Message = {
          id: generateMessageId(),
          role: 'assistant',
          content: event.text,
          timestamp: this.monotonic(),
          isIntermediate: event.isIntermediate,
          turnId: event.turnId,
          parentToolUseId: event.parentToolUseId,
        }
        managed.messages.push(assistantMessage)
        managed.streamingText = ''
        managed.streamingTurnId = undefined

        // Update lastMessageRole and lastFinalMessageId for badge/unread display (only for final messages)
        if (!event.isIntermediate) {
          managed.lastMessageRole = 'assistant'
          managed.lastFinalMessageId = assistantMessage.id

          const sessionPath = getSessionStoragePath(managed.workspace.rootPath, sessionId)

          // Claude branch-cutoff support: persist message UUID + SDK session lineage in sidecar.
          // Used to guard resumeSessionAt so we only send anchors valid for the parent SDK session.
          if (event.turnId && managed.sdkSessionId && isClaudeMessageUuid(event.turnId)) {
            try {
              await saveClaudeTurnAnchor(sessionPath, assistantMessage.id, managed.sdkSessionId, event.turnId)
            } catch (error) {
              sessionLog.warn(`Failed to persist Claude turn anchor for session ${sessionId}:`, error)
            }
          }

          // Pi branch-cutoff support: remember the SDK message id → Craft
          // assistant message id mapping. The actual anchor arrives as a
          // separate `pi_turn_anchor` event one microtask later — the SDK
          // updates its leaf only AFTER firing message_end (see #782).
          if (event.sdkMessageId) {
            let cache = managed.piSdkMessageToCraftMessage
            if (!cache) {
              cache = new Map()
              managed.piSdkMessageToCraftMessage = cache
            }
            cache.set(event.sdkMessageId, assistantMessage.id)
            // Prune oldest entries when over the cap. Map preserves insertion
            // order, so the first key is the oldest.
            if (cache.size > PI_SDK_MESSAGE_ID_CACHE_LIMIT) {
              const oldest = cache.keys().next().value
              if (oldest !== undefined) cache.delete(oldest)
            }
          }
        }

        this.sendEvent({ type: 'text_complete', sessionId, text: event.text, isIntermediate: event.isIntermediate, turnId: event.turnId, parentToolUseId: event.parentToolUseId, timestamp: assistantMessage.timestamp, messageId: assistantMessage.id }, workspaceId)

        // Persist session after complete message to prevent data loss on quit
        this.persistSession(managed)
        break
      }

      case 'pi_turn_anchor': {
        // Follow-up to a `text_complete` from the Pi backend, carrying the
        // correct leaf id captured AFTER the SDK appended its assistant entry
        // (the synchronous `message_end` listener could not see it — #782).
        // Look up the Craft assistant message id by SDK message id and
        // persist the anchor to the sidecar.
        const cache = managed.piSdkMessageToCraftMessage
        const craftMessageId = cache?.get(event.sdkMessageId)
        if (!craftMessageId) {
          sessionLog.debug(`pi_turn_anchor for unknown sdkMessageId=${event.sdkMessageId}; ignoring`)
          break
        }
        const sessionPath = getSessionStoragePath(managed.workspace.rootPath, sessionId)
        try {
          await savePiTurnAnchor(sessionPath, craftMessageId, event.sdkTurnAnchor)
        } catch (error) {
          sessionLog.warn(`Failed to persist Pi turn anchor for session ${sessionId}:`, error)
        }
        break
      }

      case 'tool_start': {
        this.noteSuggestionUse(managed, { toolName: event.toolName, input: event.input })
        noteLargeResultFileUse(managed.id, event.input)
        // Format tool input paths to relative for better readability
        const formattedToolInput = formatToolInputPaths(event.input, managed.workingDirectory)

        // Resolve call_llm model for TurnCard badge display.
        // Resolve call_llm model short names to full IDs for display.
        // Note: Pi sessions override the model in PiEventAdapter (call_llm always uses miniModel).
        if (event.toolName === 'mcp__session__call_llm' && formattedToolInput?.model) {
          const shortName = String(formattedToolInput.model)
          const modelDef = MODEL_REGISTRY.find(m => m.id === shortName)
            || MODEL_REGISTRY.find(m => m.shortName.toLowerCase() === shortName.toLowerCase())
            || MODEL_REGISTRY.find(m => m.name.toLowerCase() === shortName.toLowerCase())
          if (modelDef) {
            formattedToolInput.model = modelDef.id
          }
        }

        // Resolve tool display metadata (icon, displayName) for skills/sources
        // Only resolve when we have input (second event for SDK dual-event pattern)
        const workspaceRootPath = managed.workspace.rootPath
        let toolDisplayMeta: ToolDisplayMeta | undefined
        if (formattedToolInput && Object.keys(formattedToolInput).length > 0) {
          const allSources = loadAllSources(workspaceRootPath)
          toolDisplayMeta = await resolveToolDisplayMeta(event.toolName, formattedToolInput, workspaceRootPath, allSources)
        }

        // Check if a message with this toolUseId already exists FIRST
        // SDK sends two events per tool: first from stream_event (empty input),
        // second from assistant message (complete input)
        const existingStartMsg = managed.messages.find(m => m.toolUseId === event.toolUseId)
        const isDuplicateEvent = !!existingStartMsg

        // Use parentToolUseId directly from the event — CraftAgent resolves this
        // from SDK's parent_tool_use_id (authoritative, handles parallel Tasks correctly).
        // No stack or map needed; the event carries the correct parent from the start.
        const parentToolUseId = event.parentToolUseId

        // Track if we need to send an event to the renderer
        // Send on: first occurrence OR when we have new input data to update
        let shouldSendEvent = !isDuplicateEvent

        if (existingStartMsg) {
          // Update existing message with complete input (second event has full input)
          if (formattedToolInput && Object.keys(formattedToolInput).length > 0) {
            const hadInputBefore = existingStartMsg.toolInput && Object.keys(existingStartMsg.toolInput).length > 0
            existingStartMsg.toolInput = formattedToolInput
            // Send update event if we're adding input that wasn't there before
            if (!hadInputBefore) {
              shouldSendEvent = true
            }
          }
          // Also set parent if not already set
          if (parentToolUseId && !existingStartMsg.parentToolUseId) {
            existingStartMsg.parentToolUseId = parentToolUseId
          }
          // Set toolDisplayMeta if not already set (has base64 icon for viewer)
          if (toolDisplayMeta && !existingStartMsg.toolDisplayMeta) {
            existingStartMsg.toolDisplayMeta = toolDisplayMeta
          }
          // Update toolIntent if not already set (second event has intent from complete input)
          if (event.intent && !existingStartMsg.toolIntent) {
            existingStartMsg.toolIntent = event.intent
          }
          // Update toolDisplayName if not already set
          if (event.displayName && !existingStartMsg.toolDisplayName) {
            existingStartMsg.toolDisplayName = event.displayName
          }
        } else {
          // Add tool message immediately (will be updated on tool_result)
          // This ensures tool calls are persisted even if they don't complete
          const toolStartMessage: Message = {
            id: generateMessageId(),
            role: 'tool',
            content: `Running ${event.toolName}...`,
            timestamp: this.monotonic(),
            toolName: event.toolName,
            toolUseId: event.toolUseId,
            toolInput: formattedToolInput,
            toolStatus: 'executing',
            toolIntent: event.intent,
            toolDisplayName: event.displayName,
            toolDisplayMeta,  // Includes base64 icon for viewer compatibility
            turnId: event.turnId,
            parentToolUseId,
          }
          managed.messages.push(toolStartMessage)
        }

        // Activate browser agent control overlay on actionable browser tool starts.
        // Skip browser_tool help/release commands to avoid pointless overlay flashes.
        const shouldActivateOverlay = shouldActivateBrowserOverlay(
          event.toolName,
          formattedToolInput,
        )

        const overlayBpm = this.getBrowserPaneManagerForSession(sessionId)
        if (overlayBpm && shouldActivateOverlay) {
          // Ensure first browser action in a turn gets its Chat-owned window before overlay activation.
          overlayBpm.getOrCreateForSession(sessionId, {
            workspaceId,
            projectId: managed.projectId,
          })

          const resolvedDisplayName = toolDisplayMeta?.displayName
            ?? event.displayName
            ?? event.toolName
          overlayBpm.setAgentControl(
            sessionId,
            { displayName: resolvedDisplayName, intent: event.intent },
          )
        }

        // Send event to renderer on first occurrence OR when input data is updated
        if (shouldSendEvent) {
          const timestamp = existingStartMsg?.timestamp ?? this.monotonic()
          this.sendEvent({
            type: 'tool_start',
            sessionId,
            toolName: event.toolName,
            toolUseId: event.toolUseId,
            toolInput: formattedToolInput ?? {},
            toolIntent: event.intent,
            toolDisplayName: event.displayName,
            toolDisplayMeta,  // Includes base64 icon for viewer compatibility
            turnId: event.turnId,
            parentToolUseId,
            timestamp,
          }, workspaceId)
        }
        break
      }

      case 'tool_result': {
        // toolName comes directly from CraftAgent (resolved via ToolIndex)
        const toolName = event.toolName || 'unknown'

        // Format absolute paths to relative paths for better readability
        const rawFormattedResult = event.result ? formatPathsToRelative(event.result, managed.workingDirectory) : ''

        // Safety net: prevent massive tool results from bloating session JSONL (protects all backends)
        const MAX_PERSISTED_RESULT_CHARS = 200_000 // ~50K tokens
        const formattedResult = rawFormattedResult.length > MAX_PERSISTED_RESULT_CHARS
          ? rawFormattedResult.slice(0, MAX_PERSISTED_RESULT_CHARS) +
            `\n\n[Truncated for storage: ${rawFormattedResult.length.toLocaleString()} chars total]`
          : rawFormattedResult

        // Some backends omit explicit isError but still prefix with [ERROR].
        const inferredError = event.isError === true || /^\s*(\[ERROR\]|Error:|error:)/.test(formattedResult)

        // Update existing tool message (created on tool_start) instead of creating new one
        const existingToolMsg = managed.messages.find(m => m.toolUseId === event.toolUseId)
        // Track if already completed to avoid sending duplicate events
        const wasAlreadyComplete = existingToolMsg?.toolStatus === 'completed'

        sessionLog.info(`RESULT MATCH: toolUseId=${event.toolUseId}, found=${!!existingToolMsg}, toolName=${existingToolMsg?.toolName || toolName}, wasComplete=${wasAlreadyComplete}`)

        // parentToolUseId comes from CraftAgent (SDK-authoritative) or existing message
        const parentToolUseId = existingToolMsg?.parentToolUseId || event.parentToolUseId

        // A browser_tool fill's input still holds the typed value; once the result says the
        // field was a password, keep the value out of the transcript (stored, shown, shared).
        const redactedToolInput = existingToolMsg
          ? redactBrowserPasswordFills(existingToolMsg.toolName || toolName, existingToolMsg.toolInput, event.result)
          : undefined

        if (existingToolMsg) {
          // Keep lightweight status text in `content` and store full payload in `toolResult` only.
          existingToolMsg.toolResult = formattedResult
          existingToolMsg.toolStatus = inferredError ? 'error' : 'completed'
          existingToolMsg.isError = inferredError
          if (redactedToolInput) existingToolMsg.toolInput = redactedToolInput
          // If message doesn't have parent set, use event's parentToolUseId
          if (!existingToolMsg.parentToolUseId && event.parentToolUseId) {
            existingToolMsg.parentToolUseId = event.parentToolUseId
          }
        } else {
          // No matching tool_start found — create message from result.
          // This is normal for background subagent child tools where tool_result arrives
          // without a prior tool_start. If tool_start arrives later, findToolMessage will
          // locate this message by toolUseId and update it with input/intent/displayMeta.
          sessionLog.info(`RESULT WITHOUT START: toolUseId=${event.toolUseId}, toolName=${toolName} (creating message from result)`)
          const fallbackWorkspaceRootPath = managed.workspace.rootPath
          const fallbackSources = loadAllSources(fallbackWorkspaceRootPath)
          const fallbackToolDisplayMeta = await resolveToolDisplayMeta(toolName, undefined, fallbackWorkspaceRootPath, fallbackSources)

          const toolMessage: Message = {
            id: generateMessageId(),
            role: 'tool',
            content: '',
            timestamp: this.monotonic(),
            toolName: toolName,
            toolUseId: event.toolUseId,
            toolResult: formattedResult,
            toolStatus: inferredError ? 'error' : 'completed',
            toolDisplayMeta: fallbackToolDisplayMeta,
            parentToolUseId,
            isError: inferredError,
          }
          managed.messages.push(toolMessage)
        }

        // Send event to renderer if: (a) first completion, (b) result content changed
        // (e.g., safety net auto-completed with empty result, then real result arrived later),
        // or (c) the input was redacted, so the renderer replaces its copy from tool_start
        const resultChanged = wasAlreadyComplete && formattedResult && existingToolMsg?.toolResult !== formattedResult
        if (!wasAlreadyComplete || resultChanged || redactedToolInput) {
          // Use existing tool message timestamp, or fallback message timestamp for ordering
          const toolResultTimestamp = existingToolMsg?.timestamp ?? (managed.messages.find(m => m.toolUseId === event.toolUseId)?.timestamp)
          this.sendEvent({
            type: 'tool_result',
            sessionId,
            toolUseId: event.toolUseId,
            toolName: toolName,
            result: formattedResult,
            turnId: event.turnId,
            parentToolUseId,
            isError: inferredError,
            timestamp: toolResultTimestamp,
            ...(redactedToolInput ? { toolInput: redactedToolInput } : {}),
          }, workspaceId)
        }

        // Safety net: when a parent Task completes, mark all its still-pending child tools as completed.
        // This handles the case where child tool_result events never arrive (e.g., subagent internal tools
        // whose results aren't surfaced through the parent stream).
        if (isParentTaskTool(toolName) || toolName === 'TaskOutput') {
          const pendingChildren = managed.messages.filter(
            m => m.parentToolUseId === event.toolUseId
              && m.toolStatus !== 'completed'
              && m.toolStatus !== 'error'
          )
          for (const child of pendingChildren) {
            child.toolStatus = 'completed'
            child.toolResult = child.toolResult || ''
            sessionLog.info(`CHILD AUTO-COMPLETED: toolUseId=${child.toolUseId}, toolName=${child.toolName} (parent ${toolName} completed)`)
            this.sendEvent({
              type: 'tool_result',
              sessionId,
              toolUseId: child.toolUseId!,
              toolName: child.toolName || 'unknown',
              result: child.toolResult || '',
              turnId: child.turnId,
              parentToolUseId: event.toolUseId,
            }, workspaceId)
          }
        }

        // Persist session after tool completes to prevent data loss on quit
        this.persistSession(managed)
        break
      }

      case 'status':
        // A stopped turn already shows "Response interrupted"; a late backend status (e.g. the
        // agent's own "Interrupted") would only leave a stray streaming row behind.
        if (managed?.stopRequested) break
        this.sendEvent({
          type: 'status',
          sessionId,
          message: event.message,
          statusType: event.message.includes('Compacting') ? 'compacting' : undefined
        }, workspaceId)
        break

      case 'info': {
        const isCompactionComplete = event.message.startsWith('Compacted')
        const isManualCompactionComplete = isCompactionComplete && event.compactionTrigger === 'manual'
        const infoTimestamp = this.monotonic()

        // Persist compaction messages so they survive reload. Only a manual
        // command-correlated success marks Accept & Compact ready; automatic
        // compaction and SDK false-success command results must not execute a plan.
        if (isCompactionComplete) {
          const compactionMessage: Message = {
            id: generateMessageId(),
            role: 'info',
            content: event.message,
            timestamp: infoTimestamp,
            statusType: 'compaction_complete',
          }
          managed.messages.push(compactionMessage)

          if (isManualCompactionComplete) {
            // Only the pending record's OWN compaction turn may ready it. The
            // ORIGINATING context is the turn that emitted this event (the
            // live generation/stopEpoch of the running compaction turn) —
            // never a correlation derived from the stored record itself. The
            // lifecycle lock re-checks it against the current managed record.
            const marked = await this.markCompactionComplete(
              sessionId,
              managed.pendingPlanExecution?.executionId,
              originatingTurn ?? { generation: managed.processingGeneration, stopEpoch: managed.stopEpoch ?? 0 },
            )
            if (!marked) {
              sessionLog.info(`Session ${sessionId}: manual compaction complete did not ready a pending plan (missing, resolved, failed, or stale correlation)`)
            }
          }
        }

        this.sendEvent({
          type: 'info',
          sessionId,
          message: event.message,
          statusType: isCompactionComplete ? 'compaction_complete' : undefined,
          timestamp: infoTimestamp,
        }, workspaceId)
        break
      }

      case 'error': {
        // Skip errors after handoff (plan submission, auth request) — the SDK may emit
        // an error from the interrupted query after we've already stopped processing.
        if (!managed.isProcessing) {
          sessionLog.info('Skipping error event after handoff/stop:', event.message)
          break
        }

        // Skip abort errors - these are expected when force-aborting via Query.close()
        if (event.message.includes('aborted') || event.message.includes('AbortError')) {
          sessionLog.info('Skipping abort error event (expected during interrupt)')
          break
        }

        // Defensive: detect auth-expiry text in plain errors that weren't classified
        // as typed_error (e.g. Pi SDK error path or future provider changes).
        const lowerErr = event.message.toLowerCase()
        const isPlainAuthError =
          lowerErr.includes('token is expired') ||
          lowerErr.includes('authentication token is expired') ||
          lowerErr.includes('please try signing in again') ||
          (lowerErr.includes('401') && (lowerErr.includes('unauthorized') || lowerErr.includes('auth')))

        if (isPlainAuthError && this.attemptAuthRetry(sessionId, managed, workspaceId)) {
          break
        }

        // AgentEvent uses `message` not `error`
        const errorMessage: Message = {
          id: generateMessageId(),
          role: 'error',
          content: event.message,
          timestamp: this.monotonic()
        }
        managed.messages.push(errorMessage)
        this.sendEvent({ type: 'error', sessionId, error: event.message, timestamp: errorMessage.timestamp }, workspaceId)
        break
      }

      case 'typed_error':
        // Skip errors after handoff (plan submission, auth request)
        if (!managed.isProcessing) {
          sessionLog.info('Skipping typed_error event after handoff/stop:', event.error.message || event.error.title)
          break
        }

        // Skip abort errors - these are expected when force-aborting via Query.close()
        const typedErrorMsg = event.error.message || event.error.title || ''
        if (typedErrorMsg.includes('aborted') || typedErrorMsg.includes('AbortError')) {
          sessionLog.info('Skipping typed abort error event (expected during interrupt)')
          break
        }
        // Typed errors have structured information - send both formats for compatibility
        sessionLog.info('typed_error:', JSON.stringify(event.error, null, 2))

        // Check for auth errors that can be retried by refreshing the token
        // The SDK subprocess caches the token at startup, so if it expires mid-session,
        // we get invalid_api_key errors. We can fix this by:
        // 1. Resetting the summarization client cache
        // 2. Destroying the agent (new agent's postInit() refreshes the token)
        // 3. Retrying the message
        const isAuthError = event.error.code === 'invalid_api_key' ||
          event.error.code === 'expired_oauth_token'

        if (isAuthError && this.attemptAuthRetry(sessionId, managed, workspaceId, event.error.code)) {
          // Don't add error message or send to renderer - we're handling it via retry
          break
        }

        // Build rich error message with all diagnostic fields for persistence and UI display
        const typedErrorMessage: Message = {
          id: generateMessageId(),
          role: 'error',
          // Combine title and message for content display (handles undefined gracefully)
          content: [event.error.title, event.error.message].filter(Boolean).join(': ') || 'An error occurred',
          timestamp: this.monotonic(),
          // Rich error fields for diagnostics and retry functionality
          errorCode: event.error.code,
          errorTitle: event.error.title,
          errorDetails: event.error.details,
          errorOriginal: event.error.originalError,
          errorCanRetry: event.error.canRetry,
        }
        managed.messages.push(typedErrorMessage)
        // Send typed_error event with full structure for renderer to handle
        this.sendEvent({
          type: 'typed_error',
          sessionId,
          error: {
            code: event.error.code,
            title: event.error.title,
            message: event.error.message,
            actions: event.error.actions,
            canRetry: event.error.canRetry,
            details: event.error.details,
            originalError: event.error.originalError,
          },
          timestamp: typedErrorMessage.timestamp,
        }, workspaceId)
        break

      case 'task_backgrounded':
        // Record in the running-task registry so a cross-subprocess "status?"
        // query can enumerate live tasks (WS3). The renderer still shows the
        // chip via its own atom; this is the main-process source of truth.
        if (managed) {
          managed.backgroundTaskRegistry.set(event.taskId, {
            taskId: event.taskId,
            toolUseId: event.toolUseId,
            intent: event.intent,
            startTime: Date.now(),
            status: 'running',
            turnId: event.turnId,
            kind: event.kind === 'workflow' ? 'workflow' : event.kind === 'task' ? 'task' : 'agent',
            // Workflow launches carry a wf_ id + a live sub-agent completion count.
            ...(event.workflowId ? { workflowId: event.workflowId } : {}),
            ...(event.kind === 'workflow' ? { agentsCompleted: 0 } : {}),
          })
          sessionLog.info(`[bg-lifecycle] task backgrounded`, {
            sessionId,
            taskId: event.taskId,
            intent: event.intent,
            turnId: event.turnId,
          })
        }
        // Forward background task event directly to renderer
        this.sendEvent({
          ...event,
          sessionId,
        }, workspaceId)
        break

      case 'workflow_agent_completed':
        // One sub-agent of a running Workflow finished (SubagentStop, attributed
        // by wf_ id). Bump the owning workflow chip's completed count so the user
        // sees live fan-out progress. Lightweight: registry counter + renderer
        // forward, no persistence (this can fire dozens of times per workflow).
        if (managed) {
          for (const info of managed.backgroundTaskRegistry.values()) {
            if (info.workflowId && info.workflowId === event.workflowId) {
              info.agentsCompleted = (info.agentsCompleted ?? 0) + 1
              break
            }
          }
        }
        this.sendEvent({
          ...event,
          sessionId,
        }, workspaceId)
        break

      case 'task_activity': {
        // What a running background task is doing (the chip card's live line). Only tasks with a chip
        // (registered launches) are forwarded: a foreground subagent reports progress too.
        const info = managed?.backgroundTaskRegistry.get(event.taskId)
        if (!info || info.untracked) break
        info.lastProgressAt = Date.now()
        this.sendEvent({
          ...event,
          sessionId,
        }, workspaceId)
        break
      }

      case 'task_progress':
        // Update elapsed/last-progress on the registry entry (best-effort — the
        // async-by-default path may not emit progress; the renderer derives
        // elapsed from startTime as a fallback).
        if (managed) {
          // task_progress is keyed by toolUseId, not taskId — find the entry.
          for (const info of managed.backgroundTaskRegistry.values()) {
            if (info.toolUseId && info.toolUseId === event.toolUseId) {
              info.elapsedSeconds = event.elapsedSeconds
              info.lastProgressAt = Date.now()
              break
            }
          }
        }
        // Forward background task event directly to renderer
        this.sendEvent({
          ...event,
          sessionId,
        }, workspaceId)
        break

      case 'task_completed': {
        // Capture whether we'd already recorded a terminal result for this task
        // BEFORE mutating state below, so the idle auto-surface (further down)
        // fires at most once even if a duplicate terminal notification arrives.
        // A Workflow's completion notification may key on either the returned
        // Task ID (the registry key) or the wf_ run id, so fall back to a
        // workflowId match before giving up.
        const priorEntry = managed
          ? (managed.backgroundTaskRegistry.get(event.taskId)
            ?? [...managed.backgroundTaskRegistry.values()].find(t => t.workflowId === event.taskId))
          : undefined
        // Only the session's own tasks may wake it below: one registered at launch and still
        // running, or (launch unseen) one whose starting tool call was the agent's own. A
        // completion for anything else (a subagent's task) is recorded, never surfaced.
        const launchedHereAndRunning = priorEntry
          ? priorEntry.status === 'running' && !priorEntry.untracked
          : event.launchedHere === true

        // Store the output file for the chip's card (getBackgroundTaskOutput) and the wake-up nudge
        if (managed) {
          managed.backgroundTaskOutputs.set(event.taskId, {
            outputFile: event.outputFile || '',
            summary: event.summary || '',
            status: event.status,
            completedAt: Date.now(),
          })

          // Resolve the running-task registry entry to its terminal status so a
          // later "status?" query reflects reality instead of a stale "running".
          // Match by taskId, or by workflowId (a workflow may complete under its
          // wf_ run id rather than the returned Task ID).
          const running = managed.backgroundTaskRegistry.get(event.taskId)
            ?? [...managed.backgroundTaskRegistry.values()].find(t => t.workflowId === event.taskId)
          if (running) {
            running.status = event.status
            running.completedAt = Date.now()
          } else {
            // Terminal notification for a task whose launch this session never registered: a
            // subagent's own background task (untracked), or the agent's own task whose launch went
            // unseen. Record it so status queries stay truthful, without inventing a start time.
            const now = Date.now()
            managed.backgroundTaskRegistry.set(event.taskId, {
              taskId: event.taskId,
              ...(event.toolUseId ? { toolUseId: event.toolUseId } : {}),
              startTime: now,
              status: event.status,
              completedAt: now,
              ...(event.launchedHere ? { startUnknown: true } : { untracked: true }),
            })
          }
          sessionLog.info(`[bg-lifecycle] task completed`, {
            sessionId,
            taskId: event.taskId,
            status: event.status,
          })

          this.evictStaleBackgroundTasks(managed)
        }
        // Forward to renderer for UI update
        this.sendEvent({
          ...event,
          sessionId,
        }, workspaceId)

        // WS2 keep-alive: when a background agent finishes while the session is
        // IDLE, nobody is consuming its result — the main agent already ended its
        // turn, so the completion only updates the registry/chip and the findings
        // never make it back into the conversation ("the agent never returned the
        // result"). Wake the session with a system-generated follow-up so the agent
        // reads the output and presents it. During an active turn (isProcessing)
        // the terminal notification reaches the agent through the live stream, so
        // we skip then. Gated on keep-alive because only that mode delivers this
        // event between turns; guarded against duplicate notifications.
        // A stop the user asked for from the chip is not news to report back: it wakes nothing. A task
        // step still wakes, since its run waits for the turn that follows its background work.
        const stoppedByUser = event.status === 'stopped' && !!priorEntry?.stopRequestedAt && !managed?.taskRunId
        if (managed && this.keepBackgroundTasksAlive && !managed.isProcessing && launchedHereAndRunning && !stoppedByUser) {
          const taskIntent = priorEntry?.intent
          const outputFile = event.outputFile || managed.backgroundTaskOutputs.get(event.taskId)?.outputFile
          const label = taskIntent ? `"${taskIntent}"` : `task ${event.taskId}`
          const kind = priorEntry?.kind
          const what = kind === 'shell' ? 'background command' : kind === 'task' ? 'background task' : 'background agent'
          const nudge = kind === 'shell' || kind === 'task'
            ? (event.status === 'completed'
              ? [
                  `[background-task-completed] The ${what} you started (${label}) has finished.`,
                  outputFile ? `Its output is saved at: ${outputFile}` : '',
                  `Read that output and report the result to the user now. Do NOT start it again.`,
                ].filter(Boolean).join('\n')
              : [
                  `[background-task-${event.status}] The ${what} you started (${label}) ended with status "${event.status}".`,
                  outputFile ? `Any partial output is at: ${outputFile}.` : '',
                  `Briefly let the user know it did not complete successfully.`,
                ].filter(Boolean).join('\n'))
            : event.status === 'completed'
            // An agent's output file is its whole transcript (JSONL): reading it floods the context, and
            // the SDK's task notification already carries the result.
            ? [
                `[background-task-completed] The background agent you launched (${label}) has finished.`,
                `Its result is in the task notification. Present it to the user now, inline. Do NOT spawn another background agent.`,
                outputFile ? `Its output file (${outputFile}) is the agent's full transcript: do not read it whole; if the notification lacks something, read only its end.` : '',
              ].filter(Boolean).join('\n')
            : [
                `[background-task-${event.status}] The background agent you launched (${label}) ended with status "${event.status}".`,
                outputFile ? `Any partial output is at: ${outputFile}.` : '',
                `Briefly let the user know it did not complete successfully. Do NOT spawn another background agent.`,
              ].filter(Boolean).join('\n')
          sessionLog.info(`[bg-lifecycle] surfacing completed background task to idle session`, {
            sessionId,
            taskId: event.taskId,
            status: event.status,
          })
          // Ride the normal turn machinery (resume + persistence). `hidden: true`
          // keeps the nudge out of the transcript — the agent's response (the
          // presented result) renders as a normal assistant turn.
          // It rides in as a user message, so say plainly that nobody typed it: agents took
          // these for the user speaking, mid-task (found 2026-10-11).
          const framed = labelSystemNotice(nudge)
          void this.sendMessage(sessionId, framed, [], [], { hidden: true }).catch((err) => {
            sessionLog.error(`[bg-lifecycle] failed to surface completed task ${event.taskId}:`, err)
          })
        }
        break
      }

      case 'shell_backgrounded':
        // Track the agent's background command like a background agent (its shell id is the task
        // id its completion notification carries): real start time and intent in status queries,
        // and its completion can wake an idle session.
        if (managed) {
          const known = managed.backgroundTaskRegistry.get(event.shellId)
          const intent = event.intent ?? event.command?.slice(0, 120)
          if (known) {
            // It already finished (fast command): keep the terminal status, fill in what we know.
            // It is the agent's own after all, but its real start time was not seen.
            known.kind = 'shell'
            known.toolUseId ??= event.toolUseId
            known.intent ??= intent
            if (known.untracked) {
              known.untracked = false
              known.startUnknown = true
            }
          } else {
            managed.backgroundTaskRegistry.set(event.shellId, {
              taskId: event.shellId,
              toolUseId: event.toolUseId,
              ...(intent ? { intent } : {}),
              startTime: Date.now(),
              status: 'running',
              turnId: event.turnId,
              kind: 'shell',
            })
          }
        }
        // Forward to renderer
        this.sendEvent({
          ...event,
          sessionId,
        }, workspaceId)
        break

      case 'source_activated': {
        // A source was auto-activated mid-turn. The server schedules a re-send of the
        // original message with a "[<slug> activated]" suffix so headless deployments
        // (WebUI, docker server) chain activations the same way the renderer used to.
        // The renderer still receives the event to render activation feedback, but no
        // longer fires its own auto_retry (see processor.ts).
        sessionLog.info(`Source "${event.sourceSlug}" activated for session ${sessionId}, scheduling auto-retry`)

        // Authoritative continuation snapshot: the turn the SM itself is running.
        // sendMessage records `lastSentMessage` (composed visible text of the turn,
        // which is already free of the model-only reference block), `lastSentOptions`
        // and `lastSentMessageIds` when it starts a send, so the interrupted request
        // is resolved by identity, never by searching message history — an earlier
        // unrelated request can no longer be resurrected through a content match or a
        // fallback scan (review defect 1). Empty visible text is valid: a
        // references-only turn continues with its live citations.
        const snapshotReferences = managed && managed.lastSentMessage !== undefined
          ? activationTurnReferences(managed.messages, managed.lastSentMessageIds, managed.lastSentOptions)
          : undefined
        const resendMessage = managed?.lastSentMessage !== undefined
          ? stripActivationRetrySuffixes(managed.lastSentMessage)
          : stripReferencesFromModelInput(event.originalMessage ?? '')

        this.sendEvent({
          type: 'source_activated',
          sessionId,
          sourceSlug: event.sourceSlug,
          originalMessage: resendMessage,
        }, workspaceId)

        if (!managed) break
        this.noteSuggestionUse(managed, { activatedSource: event.sourceSlug })

        // No turn identity (the SM never started a send for this session) and an
        // empty capture: there is genuinely nothing authoritative to continue.
        // Skipping is the correct behavior — the old fallback that scanned history
        // for the last non-empty user message could resurrect an unrelated request.
        if (managed.lastSentMessage === undefined) {
          sessionLog.warn(`Source "${event.sourceSlug}" activated for session ${sessionId}, but no server-known turn to resend (no lastSentMessage identity); skipping auto-retry`)
          break
        }
        if (!resendMessage.trim() && !snapshotReferences?.length && !managed.lastSentAttachments?.length) {
          sessionLog.warn(`Source "${event.sourceSlug}" activated for session ${sessionId}, but the turn has no text and no references to resend; skipping auto-retry`)
          break
        }

        const { plain: messageWithSuffix, retry: retryMessage } = buildActivationRetryMessage(resendMessage, managed.turnSteers ?? [], event.sourceSlug)
        const messageCountAtSchedule = managed.messages.length
        const scheduledGeneration = managed.processingGeneration
        const scheduledStopEpoch = managed.stopEpoch ?? 0

        // Stash the retry payload so a duplicate sendMessage from a legacy renderer
        // (mixed-version rollout: new server + v0.9.5 Electron client) gets deduped.
        // The slot carries BOTH the plain dedupe key and the steer-carrying retry
        // text plus the turn's persisted (already validated) references, so the
        // legacy copy inherits the same server-owned snapshot. 2s window covers WS
        // latency tail on flaky mobile / proxy links.
        const slotReferences = snapshotReferences?.length ? [...snapshotReferences] : undefined
        const slot: NonNullable<ManagedSession['autoRetryPending']> = {
          content: messageWithSuffix,
          retryContent: retryMessage,
          deadlineMs: Date.now() + 2000,
          ...(slotReferences ? { references: slotReferences } : {}),
          committed: false,
          scheduledGeneration: managed.processingGeneration,
          originalContent: resendMessage,
          attachments: managed.lastSentAttachments,
          storedAttachments: managed.lastSentStoredAttachments,
          sourceSlug: event.sourceSlug,
        }
        managed.autoRetryPending = slot

        if (managed.autoRetryTimer) clearTimeout(managed.autoRetryTimer)
        managed.autoRetryTimer = setTimeout(() => {
          const current = this.sessions.get(sessionId)
          if (current !== managed || current.autoRetryPending !== slot) return
          current.autoRetryTimer = undefined

          // Superseded while the 100ms window was open: a user follow-up arrived
          // (message count grew), a new turn started (generation moved) or the user
          // stopped the session (stop epoch moved). A stale retry never fires.
          const acceptedIds = new Set([
            ...(slot.ownedSteers ?? []).flatMap(steer => steer.messageId ? [steer.messageId] : []),
            ...(current.acceptedSteers?.keys() ?? []),
          ])
          if (
            current.messages.slice(messageCountAtSchedule).some(message => !acceptedIds.has(message.id))
            || current.processingGeneration !== scheduledGeneration
            || (current.stopEpoch ?? 0) !== scheduledStopEpoch
            || current.stopRequested
          ) {
            sessionLog.info(`Auto-retry skipped for ${sessionId}: superseded (follow-up, Stop or new turn arrived first)`)
            this.recoverActivationSteers(current, slot)
            if (!current.isProcessing && current.messageQueue.length > 0) this.processNextQueuedMessage(sessionId)
            return
          }

          // Note: do NOT clear autoRetryPending here — sendMessage() needs to see it
          // so a legacy renderer's duplicate RPC arriving ~50ms later gets dropped.
          // The pending slot is cleared by the deadline check in sendMessage, by the
          // next matching sendMessage that drops as a duplicate, or by session deletion.
          // sendMessage captures any late accepted payloads and keeps their
          // original bubbles recoverable until the retry's producer acknowledgement.
          current.pendingActivationResend = retryMessage
          this.sendMessage(
            sessionId,
            retryMessage,
            undefined,
            undefined,
            { hidden: true },
            undefined,
            undefined,
            undefined,
            undefined,
            // Server-owned continuation identity: matched by object identity against
            // the live dedup slot inside sendMessage. Not a wire-expressible field —
            // the SEND_MESSAGE RPC handler never forwards this parameter, so a
            // renderer payload cannot forge persisted-reference reuse.
            { activationReferences: current.autoRetryPending?.references },
          ).catch(async err => {
            if (current.pendingActivationResend === retryMessage) current.pendingActivationResend = undefined
            if (this.sessions.get(sessionId) !== current) return
            this.recoverActivationSteers(current, slot)
            if (slot.deliveryMessageId && current.lastSentMessageIds?.includes(slot.deliveryMessageId) && current.isProcessing) {
              await this.onProcessingStopped(sessionId, 'error')
            } else if (!current.isProcessing && current.messageQueue.length > 0) {
              this.processNextQueuedMessage(sessionId)
            }
            sessionLog.error(`Auto-retry sendMessage failed for ${sessionId}:`, err)
          })
        }, 100)
        break
      }

      case 'context_usage': {
        if (!managed.tokenUsage) {
          managed.tokenUsage = {
            inputTokens: 0,
            outputTokens: 0,
            totalTokens: 0,
            contextTokens: 0,
            costUsd: 0,
          }
        }
        managed.tokenUsage.contextUsage = event.contextUsage
        this.sendEvent({
          type: 'usage_update',
          sessionId: managed.id,
          tokenUsage: {
            inputTokens: managed.tokenUsage.inputTokens,
            contextWindow: managed.tokenUsage.contextWindow,
            contextUsage: event.contextUsage,
          },
        }, workspaceId)
        this.persistSession(managed)
        break
      }

      case 'compaction_failed': {
        // An automatic (overflow) compaction failure never owns the Accept &
        // Compact pending record — only the manual command's failure does.
        if (event.compactionTrigger === 'automatic') {
          sessionLog.info(`Session ${sessionId}: automatic compaction failed (pending plan untouched)`)
          break
        }
        const record = managed.pendingPlanExecution
        if (!record || record.failed || record.executionDispatched) {
          sessionLog.info(`Session ${sessionId}: compaction failed with no correlated pending plan; nothing to cancel`)
          break
        }
        // Correlation: the ORIGINATING context is the turn that emitted this
        // failure (the live generation/stopEpoch). Only a failure belonging to
        // the record's own compaction turn may cancel it — a late failure from
        // an older or foreign turn (superseded by a Stop or a new turn, whose
        // own events/paths decide the record) must not. Records without a
        // recorded compaction turn (the /compact never started) have no
        // failure to correlate: leave them to their own turn's events or
        // reload reconciliation.
        if (!record.awaitingCompaction || !record.compactionTurn) break
        const failingTurn = originatingTurn ?? { generation: managed.processingGeneration, stopEpoch: managed.stopEpoch ?? 0 }
        if (
          record.compactionTurn.generation !== failingTurn.generation
          || record.compactionTurn.stopEpoch !== failingTurn.stopEpoch
        ) {
          sessionLog.info(`Session ${sessionId}: compaction failure is stale (emitting turn is not the record's compaction turn); pending plan untouched`)
          break
        }
        await this.withSessionLifecycleLock(sessionId, async () => {
          // Re-check the LIVE session after the lock wait: a deleteSession that
          // held the lock (its force-abort can emit this very event) must not
          // have its files recreated by a detached cancellation persisting.
          if (this.sessions.get(sessionId) !== managed || managed.pendingPlanExecution !== record || record.failed) return
          await this.cancelPendingPlanExecution(managed, record)
        })
        sessionLog.info(`Session ${sessionId}: compaction failed, cancelled pending plan execution and restored draft`)
        break
      }

      case 'complete':
        // Complete event from CraftAgent - accumulate usage from this turn
        // Actual 'complete' sent to renderer comes from the finally block in sendMessage
        if (event.usage) {
          // Initialize tokenUsage if not set
          if (!managed.tokenUsage) {
            managed.tokenUsage = {
              inputTokens: 0,
              outputTokens: 0,
              totalTokens: 0,
              contextTokens: 0,
              costUsd: 0,
            }
          }
          // inputTokens = current context size (full conversation sent this turn), NOT accumulated
          // Each API call sends the full conversation history, so we use the latest value
          managed.tokenUsage.inputTokens = event.usage.inputTokens
          // outputTokens and costUsd are accumulated across all turns (total session usage)
          addTurnUsage(managed.tokenUsage, event.usage)
          managed.tokenUsage.totalTokens = managed.tokenUsage.inputTokens + managed.tokenUsage.outputTokens
          // Cache tokens reflect current state, not accumulated
          managed.tokenUsage.cacheReadTokens = event.usage.cacheReadTokens ?? 0
          managed.tokenUsage.cacheCreationTokens = event.usage.cacheCreationTokens ?? 0
          // Update context window (use latest value - may change if model switches)
          if (event.usage.contextWindow) {
            managed.tokenUsage.contextWindow = event.usage.contextWindow
          }
        }
        break

      case 'usage_update':
        // Real-time usage update for context display during processing
        // Update managed session's tokenUsage with latest context size
        if (event.usage) {
          if (!managed.tokenUsage) {
            managed.tokenUsage = {
              inputTokens: 0,
              outputTokens: 0,
              totalTokens: 0,
              contextTokens: 0,
              costUsd: 0,
            }
          }
          // Update only inputTokens (current context size) - other fields accumulate on complete
          managed.tokenUsage.inputTokens = event.usage.inputTokens
          if (event.usage.contextWindow) {
            managed.tokenUsage.contextWindow = event.usage.contextWindow
          }

          // Send to renderer for immediate UI update
          this.sendEvent({
            type: 'usage_update',
            sessionId: managed.id,
            tokenUsage: {
              inputTokens: event.usage.inputTokens,
              contextWindow: event.usage.contextWindow,
              contextUsage: managed.tokenUsage.contextUsage,
            },
          }, workspaceId)
        }
        break

      case 'steer_undelivered':
        this.recoverUndeliveredSteer(managed, event)
        await this.flushSession(managed.id)
        break

      // Note: working_directory_changed is user-initiated only (via updateWorkingDirectory),
      // the agent no longer has a change_working_directory tool
    }
  }

  private readonly turnCompleteListeners = new Set<(sessionId: string) => void>()

  onTurnComplete(listener: (sessionId: string) => void): () => void {
    this.turnCompleteListeners.add(listener)
    return () => this.turnCompleteListeners.delete(listener)
  }

  private sendEvent(event: SessionEvent, workspaceId?: string): void {
    if (event.type === 'complete') {
      for (const listener of this.turnCompleteListeners) {
        try {
          listener(event.sessionId)
        } catch (error) {
          sessionLog.warn('turn-complete listener failed:', error)
        }
      }
    }
    if (!this.eventSink) {
      sessionLog.warn('Cannot send event - no event sink')
      return
    }

    if (!workspaceId) {
      sessionLog.warn(`Cannot send ${event.type} event - no workspaceId`)
      return
    }

    this.eventSink(RPC_CHANNELS.sessions.EVENT, { to: 'workspace', workspaceId }, event)
  }

  /**
   * Queue a text delta for batched sending (performance optimization)
   * Instead of sending 50+ IPC events per second, batches deltas and flushes every 50ms
   */
  private queueDelta(sessionId: string, workspaceId: string, delta: string, turnId?: string): void {
    const existing = this.pendingDeltas.get(sessionId)
    if (existing) {
      // Append to existing batch
      existing.delta += delta
      // Keep the latest turnId (should be the same, but just in case)
      if (turnId) existing.turnId = turnId
    } else {
      // Start new batch
      this.pendingDeltas.set(sessionId, { delta, turnId })
    }

    // Schedule flush if not already scheduled
    if (!this.deltaFlushTimers.has(sessionId)) {
      const timer = setTimeout(() => {
        this.flushDelta(sessionId, workspaceId)
      }, DELTA_BATCH_INTERVAL_MS)
      this.deltaFlushTimers.set(sessionId, timer)
    }
  }

  /** Remove a failed assistant's unsent batch without affecting another stream. */
  private discardDelta(sessionId: string, turnId: string): void {
    if (this.pendingDeltas.get(sessionId)?.turnId !== turnId) return
    const timer = this.deltaFlushTimers.get(sessionId)
    if (timer) clearTimeout(timer)
    this.deltaFlushTimers.delete(sessionId)
    this.pendingDeltas.delete(sessionId)
  }

  /**
   * Flush any pending deltas for a session (sends batched IPC event)
   * Called on timer or when streaming ends (text_complete)
   */
  private flushDelta(sessionId: string, workspaceId: string): void {
    // Clear the timer
    const timer = this.deltaFlushTimers.get(sessionId)
    if (timer) {
      clearTimeout(timer)
      this.deltaFlushTimers.delete(sessionId)
    }

    // Send batched delta if any
    const pending = this.pendingDeltas.get(sessionId)
    if (pending && pending.delta) {
      this.sendEvent({
        type: 'text_delta',
        sessionId,
        delta: pending.delta,
        turnId: pending.turnId
      }, workspaceId)
      this.pendingDeltas.delete(sessionId)
    }
  }

  /**
   * Execute a prompt automation by creating a new session and sending the prompt.
   *
   * The options-object form replaced the previous positional-args signature
   * once the param list outgrew readability — `thinkingLevel` was the trigger.
   * When `thinkingLevel` is omitted, `createSession` falls back to the
   * workspace default (then DEFAULT_THINKING_LEVEL).
   */
  async executePromptAutomation(
    input: ExecutePromptAutomationInput,
  ): Promise<{ sessionId: string }> {
    const {
      workspaceId,
      workspaceRootPath,
      prompt,
      labels,
      permissionMode,
      mentions,
      llmConnection,
      model,
      thinkingLevel,
      automationName,
      automationId,
      triggerEvent,
      chainDepth,
      telegramTopic,
      waitForCompletion,
    } = input

    // Warn if llmConnection was specified but doesn't resolve
    if (llmConnection) {
      const connection = resolveSessionConnection(llmConnection)
      if (!connection) {
        sessionLog.warn(`[Automations] llmConnection "${llmConnection}" not found, using default`)
      }
    }

    // Resolve @mentions to source/skill slugs
    const resolved = mentions ? this.resolveAutomationMentions(workspaceRootPath, mentions) : undefined

    // Ensure labels exist in workspace config before assigning to session
    const resolvedLabels = labels?.length
      ? ensureLabelsExist(workspaceRootPath, labels)
      : labels

    // Use automation name if provided, otherwise fall back to prompt snippet
    const fallback = `Automation: ${prompt.slice(0, 50)}${prompt.length > 50 ? '...' : ''}`
    const sessionName = automationName || fallback

    // Create a new session for this automation
    const session = await this.createSession(workspaceId, {
      name: sessionName,
      labels: resolvedLabels,
      permissionMode: permissionMode || 'safe',
      enabledSourceSlugs: resolved?.sourceSlugs,
      llmConnection,
      model,
      thinkingLevel,
    })

    // Populate triggeredBy metadata so title generation is explicitly skipped
    // and the session is identifiable as automation-initiated after reload
    const managed = this.sessions.get(session.id)
    if (managed) {
      managed.triggeredBy = { automationName, automationId, event: triggerEvent, depth: chainDepth ?? 1, timestamp: Date.now() }
      this.persistSession(managed)
    }

    // (session_created is emitted by createSession above; triggeredBy is set synchronously
    // before the renderer's hydrate round-trip resolves, so it is observed.)

    // Bind the new session to its Telegram forum topic if the matcher
    // declared `telegramTopic`. Done before `sendMessage` so the first
    // assistant tokens already route through the bound topic. Failure
    // is logged inside the binder; the session continues unbound.
    if (this.automationBinder && telegramTopic && telegramTopic.trim().length > 0) {
      try {
        await this.automationBinder({
          workspaceId,
          sessionId: session.id,
          topicName: telegramTopic.trim(),
        })
      } catch (err) {
        sessionLog.warn('[Automations] automation binder threw', {
          sessionId: session.id,
          telegramTopic,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }

    // Send the prompt.
    // Test runs pass `waitForCompletion: false` so we return as soon as the
    // session exists and the prompt is dispatched — otherwise the RPC blocks
    // until the entire turn (including tool calls) finishes and trips the 30s
    // client timeout (craft-agents-oss#943). The session streams live either
    // way; a background failure surfaces in the session UI and is logged here.
    if (waitForCompletion === false) {
      void this.sendMessage(session.id, prompt, undefined, undefined, {
        skillSlugs: resolved?.skillSlugs,
      }).catch((err) => {
        sessionLog.error('[Automations] background sendMessage failed for test run', {
          sessionId: session.id,
          error: err instanceof Error ? err.message : String(err),
        })
      })
      return { sessionId: session.id }
    }

    await this.sendMessage(session.id, prompt, undefined, undefined, {
      skillSlugs: resolved?.skillSlugs,
    })

    return { sessionId: session.id }
  }

  /**
   * Resolve @mentions in automation prompts to source and skill slugs
   */
  private resolveAutomationMentions(workspaceRootPath: string, mentions: string[]): { sourceSlugs: string[]; skillSlugs: string[] } | undefined {
    const sources = loadWorkspaceSources(workspaceRootPath)
    const skills = loadAllSkills(workspaceRootPath)
    const sourceSlugs: string[] = []
    const skillSlugs: string[] = []

    for (const mention of mentions) {
      if (sources.some(s => s.config.slug === mention)) {
        sourceSlugs.push(mention)
      } else if (skills.some(s => s.slug === mention)) {
        skillSlugs.push(mention)
      } else {
        sessionLog.warn(`[Automations] Unknown mention: @${mention}`)
      }
    }

    return (sourceSlugs.length > 0 || skillSlugs.length > 0) ? { sourceSlugs, skillSlugs } : undefined
  }

  // ============================================
  // Export / Import / Dispatch
  // ============================================

  /**
   * Summarize a session's conversation for a handoff into a fresh session: remote transfer and
   * "continue in a new session" (coding mode switch). Null when there is nothing to summarize.
   */
  private async generateSessionHandoffSummary(managed: ManagedSession): Promise<string | null> {
    await this.ensureMessagesLoaded(managed)

    const messages = managed.messages
      .filter(m => m.role === 'user' || m.role === 'assistant')
      .filter(m => !m.isIntermediate)
      .map(m => ({
        type: m.role as 'user' | 'assistant',
        content: m.content,
      }))

    if (messages.length === 0) return null

    const workspaceRootPath = managed.workspace.rootPath
    const wsConfig = loadWorkspaceConfig(workspaceRootPath)
    const defaultModel = wsConfig?.defaults?.model
    const backendContext = resolveBackendContext({
      sessionConnectionSlug: managed.llmConnection,
      workspaceDefaultConnectionSlug: wsConfig?.defaults?.defaultLlmConnection,
      managedModel: managed.model || defaultModel,
    })

    const miniModel = backendContext.connection
      ? (getMiniModel(backendContext.connection) ?? backendContext.connection.defaultModel ?? getDefaultSummarizationModel())
      : getDefaultSummarizationModel()

    const envOverrides: Record<string, string> = {
      CRAFT_WORKSPACE_PATH: workspaceRootPath,
      ...(miniModel ? { ANTHROPIC_DEFAULT_HAIKU_MODEL: miniModel } : {}),
    }

    const agent = createBackendFromResolvedContext({
      context: backendContext,
      hostRuntime: buildBackendHostRuntimeContext(),
      coreConfig: {
        workspace: managed.workspace,
        session: {
          id: `${managed.id}-remote-transfer-summary`,
          workspaceRootPath,
          projectId: managed.projectId,
          createdAt: Date.now(),
          lastUsedAt: Date.now(),
          workingDirectory: managed.workingDirectory,
          sdkCwd: managed.sdkCwd,
          model: managed.model,
          llmConnection: managed.llmConnection,
          permissionMode: managed.permissionMode,
          previousPermissionMode: managed.previousPermissionMode,
        },
        miniModel,
        envOverrides,
        isHeadless: true,
      },
      providerOptions: { piAuthProvider: backendContext.connection?.piAuthProvider },
    })

    try {
      return await generateConversationSummary(messages, agent.runMiniCompletion.bind(agent))
    } finally {
      agent.destroy()
    }
  }

  async exportRemoteSessionTransfer(sessionId: string, workspaceId: string): Promise<RemoteSessionTransferPayload | null> {
    const managed = this.sessions.get(sessionId)
    if (!managed) {
      sessionLog.warn(`[dispatch] Cannot export remote transfer: ${sessionId} not found`)
      return null
    }

    if (managed.workspace.id !== workspaceId) {
      sessionLog.warn(`[dispatch] Session ${sessionId} does not belong to workspace ${workspaceId}`)
      return null
    }

    if (managed.isProcessing) {
      sessionLog.warn(`[dispatch] Cannot export remote transfer ${sessionId}: still processing`)
      return null
    }

    this.persistSession(managed)
    await sessionPersistenceQueue.flush(sessionId)

    const summary = await this.generateSessionHandoffSummary(managed)
    if (!summary) {
      sessionLog.warn(`[dispatch] Failed to generate remote transfer summary for ${sessionId}`)
      return null
    }

    return {
      sourceSessionId: managed.id,
      name: managed.name,
      sessionStatus: managed.sessionStatus,
      labels: managed.labels,
      permissionMode: managed.permissionMode,
      summary,
    }
  }

  async importRemoteSessionTransfer(
    workspaceId: string,
    payload: RemoteSessionTransferPayload,
  ): Promise<ImportRemoteSessionTransferResult> {
    if (!payload || typeof payload !== 'object' || typeof payload.summary !== 'string' || !payload.summary.trim()) {
      throw new Error('Invalid remote session transfer payload')
    }

    const session = await this.createSession(workspaceId, {
      name: payload.name,
      permissionMode: payload.permissionMode,
      sessionStatus: payload.sessionStatus,
      labels: payload.labels,
    })

    const managed = this.sessions.get(session.id)
    if (!managed) {
      throw new Error(`Transferred session ${session.id} was not created`)
    }

    managed.transferredSessionSummary = payload.summary.trim()
    managed.transferredSessionSummaryApplied = false
    this.persistSession(managed)
    await sessionPersistenceQueue.flush(session.id)

    return { sessionId: session.id }
  }

  /**
   * Export a session as a portable SessionBundle.
   *
   * Steps:
   * 1. Validate session exists and resolve its workspace
   * 2. If session is processing, refuse (caller must stop it first)
   * 3. Flush pending persistence writes
   * 4. Serialize session directory into a bundle
   */
  async exportSession(sessionId: string, workspaceId: string): Promise<SessionBundle | null> {
    const managed = this.sessions.get(sessionId)
    if (!managed) {
      sessionLog.warn(`[dispatch] Cannot export session: ${sessionId} not found`)
      return null
    }

    if (managed.workspace.id !== workspaceId) {
      sessionLog.warn(`[dispatch] Session ${sessionId} does not belong to workspace ${workspaceId}`)
      return null
    }

    if (managed.isProcessing) {
      sessionLog.warn(`[dispatch] Cannot export session ${sessionId}: still processing`)
      return null
    }

    // Flush pending writes to ensure JSONL is up to date
    this.persistSession(managed)
    await sessionPersistenceQueue.flush(sessionId)

    const bundle = serializeSession(managed.workspace.rootPath, sessionId)
    if (!bundle) {
      sessionLog.error(`[dispatch] Failed to serialize session ${sessionId}`)
      return null
    }

    return bundle
  }

  /**
   * Import a session bundle into a target workspace.
   *
   * Steps:
   * 1. Validate bundle structure and target workspace
   * 2. Generate new session ID (fork) or use original (move)
   * 3. Create session directory and write JSONL + files
   * 4. Register session in-memory
   * 5. Emit session_created event
   * 6. Return new session ID and compatibility warnings
   */
  async importSession(
    workspaceId: string,
    bundle: SessionBundle,
    mode: DispatchMode,
  ): Promise<{ sessionId: string; warnings?: string[] }> {
    sessionLog.info(`[import] Starting import: workspaceId=${workspaceId}, mode=${mode}, bundleSessionId=${bundle?.session?.header?.id ?? 'unknown'}, files=${bundle?.files?.length ?? 0}`)

    if (!validateBundle(bundle)) {
      throw new Error('Invalid session bundle')
    }

    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) {
      throw new Error(`Workspace ${workspaceId} not found`)
    }

    sessionLog.info(`[import] Target workspace: "${workspace.name}" at ${workspace.rootPath}`)

    const warnings: string[] = []
    const workspaceRootPath = workspace.rootPath

    // Determine session ID
    const sessionId = mode === 'move'
      ? bundle.session.header.id
      : generateSessionId(workspaceRootPath)

    // Check for ID collision on move
    if (mode === 'move' && this.sessions.has(sessionId)) {
      throw new Error(`Session ${sessionId} already exists in target workspace`)
    }

    if (loadStoredSession(workspaceRootPath, sessionId)) {
      throw new Error(`Session ${sessionId} already exists in target workspace`)
    }

    // Reserve the target id through the normal storage constructor. This assigns the
    // target Workspace's default Project and serializes against Project deletion.
    const reserved = await getOrCreateStoredSessionById(workspaceRootPath, sessionId)
    const sessionDir = getSessionStoragePath(workspaceRootPath, sessionId)

    // Build the stored session from bundle data
    const header = bundle.session.header
    const storedSession: StoredSession = {
      id: sessionId,
      workspaceRootPath,
      projectId: reserved.projectId,
      sdkSessionId: header.sdkSessionId, // Preserved initially; fork logic below may clear it
      // Always regenerate sdkCwd for the target workspace.
      // The source sdkCwd points to a path on the originating server
      // which doesn't exist here (cross-server transfer).
      sdkCwd: getSessionStoragePath(workspaceRootPath, sessionId),
      name: header.name,
      createdAt: header.createdAt,
      lastUsedAt: Date.now(),
      lastMessageAt: header.lastMessageAt,
      isFlagged: header.isFlagged,
      permissionMode: header.permissionMode,
      previousPermissionMode: header.previousPermissionMode,
      sessionStatus: header.sessionStatus,
      labels: this.canonicalLabels(workspaceRootPath, header.labels),
      enabledSourceSlugs: header.enabledSourceSlugs,
      workingDirectory: header.workingDirectory,
      model: header.model,
      llmConnection: header.llmConnection,
      connectionLocked: header.connectionLocked,
      thinkingLevel: header.thinkingLevel,
      // Keeps the SDK session (and its pinned prompt/tool profile) when not forked, so the mode travels with it
      codingMode: header.codingMode,
      hidden: header.hidden,
      transferredSessionSummary: header.transferredSessionSummary,
      transferredSessionSummaryApplied: header.transferredSessionSummaryApplied,
      messages: bundle.session.messages,
      tokenUsage: header.tokenUsage ?? DEFAULT_TOKEN_USAGE,
    }

    // Fork-specific: set up SDK branching if branchInfo provided
    if (mode === 'fork' && bundle.branchInfo) {
      storedSession.branchFromSdkSessionId = bundle.branchInfo.sdkSessionId
      storedSession.branchFromSdkTurnId = bundle.branchInfo.sdkTurnId
      storedSession.branchFromSdkCwd = bundle.branchInfo.sdkCwd
    }

    // Fork-specific: clear sharing state and attempt resume-first strategy
    if (mode === 'fork') {
      storedSession.sharedUrl = undefined
      storedSession.sharedId = undefined

      // Resume-first: try to find a compatible LLM connection on the target workspace.
      // If found and the session has an sdkSessionId, preserve it for API-level resume.
      // If not, clear SDK state and fall back to transferred session summary.
      const sourceProviderType = header.llmConnection
        ? getLlmConnection(header.llmConnection)?.providerType
        : undefined
      const compatibleConnection = sourceProviderType
        ? this.findCompatibleLlmConnection(workspaceRootPath, sourceProviderType)
        : null

      if (compatibleConnection && storedSession.sdkSessionId) {
        // Resume path: compatible credentials exist — preserve SDK session ID
        sessionLog.info(`[import] Fork: compatible ${sourceProviderType} connection "${compatibleConnection}" found — preserving sdkSessionId for resume`)
        storedSession.llmConnection = compatibleConnection
        storedSession.connectionLocked = false
      } else {
        // Summary path: no compatible connection or no SDK session — clear for fresh start
        if (storedSession.llmConnection) {
          sessionLog.info(`[import] Fork: no compatible ${sourceProviderType ?? 'unknown'} connection — clearing, will use summary context`)
        }
        storedSession.sdkSessionId = undefined
        storedSession.llmConnection = undefined
        storedSession.connectionLocked = false
      }
      // Clear thinking level so the session inherits the workspace default
      storedSession.thinkingLevel = undefined
      // Clear working directory — the source path won't exist on a different server.
      // The user can set a new cwd after the session is transferred.
      storedSession.workingDirectory = undefined
    }

    // Check source compatibility (before writing JSONL so fixes are persisted)
    if (storedSession.enabledSourceSlugs?.length) {
      const availableSources = loadWorkspaceSources(workspaceRootPath)
      const availableSlugs = new Set(availableSources.map(s => s.config.slug))
      const missingSources = storedSession.enabledSourceSlugs.filter(s => !availableSlugs.has(s))
      if (missingSources.length > 0) {
        sessionLog.warn(`[import] Sources not available: ${missingSources.join(', ')}`)
        warnings.push(`Sources not available in target workspace: ${missingSources.join(', ')}`)
      }
    }

    // Check LLM connection compatibility for move mode (fork already cleared above)
    if (mode === 'move' && storedSession.llmConnection) {
      sessionLog.info(`[import] Checking LLM connection: "${storedSession.llmConnection}"`)
      const conn = resolveSessionConnection(storedSession.llmConnection, undefined)
      if (!conn) {
        sessionLog.warn(`[import] LLM connection "${storedSession.llmConnection}" not found — clearing to use default`)
        warnings.push(`LLM connection "${storedSession.llmConnection}" not found in target — session will use default`)
        storedSession.llmConnection = undefined
        storedSession.connectionLocked = false
      } else {
        sessionLog.info(`[import] LLM connection "${storedSession.llmConnection}" resolved OK`)
      }
    } else if (mode === 'move' && !storedSession.llmConnection) {
      sessionLog.info('[import] No LLM connection in bundle — will use default')
    }

    // Write JSONL file (after compatibility checks so remapped values are persisted)
    const sessionFile = getSessionFilePath(workspaceRootPath, sessionId)
    sessionLog.info(`[import] Writing JSONL: ${sessionFile} (llmConnection=${storedSession.llmConnection ?? 'default'}, messages=${storedSession.messages.length})`)
    writeSessionJsonl(sessionFile, storedSession)

    // Write all bundle files (attachments, plans, data, downloads, etc.)
    // Uses restoreFiles() for path traversal, size, and base64 validation.
    restoreFiles(sessionDir, bundle.files)

    // Register in-memory — pass session metadata without messages to avoid
    // StoredMessage[] vs Message[] type mismatch, then convert messages separately
    const { messages: bundleMessages, ...sessionMeta } = storedSession
    const managed = createManagedSession(sessionMeta, workspace, {
      messagesLoaded: true,
      workingDirectory: storedSession.workingDirectory,
    })
    managed.messages = bundleMessages.map(storedToMessage)

    setPermissionMode(sessionId, managed.permissionMode ?? 'ask', { changedBy: 'restore' })
    if (managed.previousPermissionMode) {
      hydratePreviousPermissionMode(sessionId, managed.previousPermissionMode)
    }

    this.sessions.set(sessionId, managed)

    // Initialize automation metadata
    const automationSystem = this.automationSystems.get(workspaceRootPath)
    if (automationSystem) {
      automationSystem.setInitialSessionMetadata(sessionId, {
        permissionMode: storedSession.permissionMode,
        labels: storedSession.labels,
        isFlagged: storedSession.isFlagged,
        sessionStatus: storedSession.sessionStatus,
        sessionName: managed.name,
      })
    }

    // Built by hand (not via createSession), so announce it explicitly.
    this.notifySessionCreated(workspaceId, sessionId, storedSession.projectId)

    sessionLog.info(`[import] Complete: sessionId=${sessionId}, transferredSummary=${managed.transferredSessionSummary ? `${managed.transferredSessionSummary.length} chars` : 'none'}, applied=${managed.transferredSessionSummaryApplied}, warnings=${warnings.length > 0 ? warnings.join('; ') : 'none'}`)
    return { sessionId, warnings: warnings.length > 0 ? warnings : undefined }
  }

  /**
   * Find an LLM connection on this server that matches the given provider type.
   * Checks workspace default first, then falls back to any matching connection.
   */
  private findCompatibleLlmConnection(workspaceRootPath: string, providerType: string): string | null {
    const wsConfig = loadWorkspaceConfig(workspaceRootPath)
    const defaultSlug = wsConfig?.defaults?.defaultLlmConnection
    if (defaultSlug) {
      const conn = getLlmConnection(defaultSlug)
      if (conn?.providerType === providerType) return defaultSlug
    }
    // Fall back: any connection with matching provider type
    const connections = getLlmConnections()
    const match = connections.find(c => c.providerType === providerType)
    return match?.slug ?? null
  }

  /**
   * Clean up all resources held by the SessionManager.
   * Should be called on app shutdown to prevent resource leaks.
   */
  cleanup(): void {
    sessionLog.info('Cleaning up resources...')

    // Stop all ConfigWatchers (file system watchers)
    for (const [path, watcher] of this.configWatchers) {
      watcher.stop()
      sessionLog.info(`Stopped config watcher for ${path}`)
    }
    this.configWatchers.clear()

    // Dispose all AutomationSystems (includes scheduler, handlers, and event loggers)
    for (const [workspacePath, automationSystem] of this.automationSystems) {
      try {
        automationSystem.dispose()
        sessionLog.info(`Disposed AutomationSystem for ${workspacePath}`)
      } catch (error) {
        sessionLog.error(`Failed to dispose AutomationSystem for ${workspacePath}:`, error)
      }
    }
    this.automationSystems.clear()

    // Clear all pending delta flush timers
    for (const [sessionId, timer] of this.deltaFlushTimers) {
      clearTimeout(timer)
    }
    this.deltaFlushTimers.clear()
    this.pendingDeltas.clear()

    // Clear pending credential resolvers (they won't be resolved, but prevents memory leak)
    this.pendingCredentialResolvers.clear()
    this.pendingPermissionRequests.clear()
    this.adminRememberApprovals.clear()

    // Clean up session-scoped tool callbacks for all sessions
    for (const sessionId of this.sessions.keys()) {
      unregisterSessionScopedToolCallbacks(sessionId)
    }

    sessionLog.info('Cleanup complete')
  }
}
