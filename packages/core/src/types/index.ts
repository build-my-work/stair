/**
 * Re-export all types from @craft-agent/core
 */

// Workspace and config types
export type {
  WorkspaceInfo,
  Workspace,
  RemoteServerConfig,
  McpAuthType,
  AuthType,
  OAuthCredentials,
  StoredConfig,
} from './workspace.ts';

export type { ContextUsageSnapshot } from './context-usage.ts';

// Session types
export type {
  Session,
  StoredSession,
  SessionMetadata,
  SessionStatus,
} from './session.ts';

// Message types
export type {
  MessageRole,
  ToolStatus,
  ToolDisplayMeta,
  AttachmentType,
  MessageAttachment,
  StoredAttachment,
  ContentBadge,
  AnnotationAuthor,
  AnnotationBody,
  AnnotationIntent,
  AnnotationStatus,
  AnnotationBlockType,
  AnnotationSelector,
  AnnotationTarget,
  AnnotationV1,
  Message,
  StoredMessage,
  TokenUsage,
  AgentEventUsage,
  RecoveryAction,
  ErrorCode,
  TypedError,
  PermissionRequest,
  PermissionRisk,
  AgentEvent,
  // Auth-related types
  CredentialInputMode,
  AuthRequestType,
  AuthStatus,
} from './message.ts';
export { generateMessageId } from './message.ts';

export type {
  SourceFingerprint,
  ProjectFileIdentity,
  EpubTocPathEntryV1,
  EpubCfiLocatorV1,
  TextQuoteLocatorV1,
  PdfPageRectV1,
  PdfTextQuoteLocatorV1,
  ProjectFileSelectionLocatorV1,
  ProjectFileReferenceV1,
  ChatMessageReferenceV1,
  Reference,
} from './reference.ts';
export {
  MAX_REFERENCES_PER_MESSAGE,
  MAX_REFERENCE_QUOTE_CHARS,
  MAX_REFERENCE_CONTEXT_CHARS,
  MAX_REFERENCE_CFI_CHARS,
  MAX_REFERENCE_TOC_DEPTH,
  MAX_REFERENCE_TOC_ORDER_DEPTH,
  MAX_REFERENCE_PATH_BYTES,
  MAX_REFERENCE_SERIALIZED_BYTES,
  MAX_REFERENCES_SERIALIZED_BYTES,
  isProjectFileReference,
  isChatMessageReference,
  isReference,
  referenceSerializedByteLength,
  referencesFitSerializedLimits,
  referenceKey,
} from './reference.ts';

// Message persistence mappers
export { messageToStored, storedToMessage } from './message-mapper.ts';

// Server types (headless operations)
export type {
  ServerStatus,
  ServerHealth,
  SessionProcessingStatus,
  ActiveSessionInfo,
} from './server.ts';

// Page types (workspace-scoped mini dashboards)
export type {
  PageKind,
  PageScriptRuntime,
  PageRefreshSpec,
  PageRefreshStatus,
  PageSeriesPoint,
  PageDataSnapshot,
  PageActionHttpMethod,
  PageActionDescriptor,
  PageActionGrant,
  PageRenderLease,
  PageActionInvocation,
  PageActionRequest,
  PageActionResult,
  PageShareInfo,
  PageClaudeArtifactInfo,
  PageThumbnailInfo,
  PageConfig,
} from './page.ts';

