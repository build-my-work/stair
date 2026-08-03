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
  AgentEvent,
  // Auth-related types
  CredentialInputMode,
  AuthRequestType,
  AuthStatus,
} from './message.ts';
export { generateMessageId } from './message.ts';

// Project File and EPUB types
export type {
  SourceFingerprint,
  ProjectFileIdentity,
  ProjectFileOpenIntent,
  EpubCfiLocatorV1,
  PdfPageRectV1,
  PdfTextQuoteLocatorV1,
  EpubTocPathEntryV1,
  EpubTocNode,
  EpubHighlightV1,
  EpubProgressV1,
  EpubDocumentStateV1,
  EpubStateMutation,
  PdfHighlightV1,
  PdfProgressV1,
  PdfDocumentStateV1,
  PdfStateMutation,
  ProjectFileSelectionLocatorV1,
  ProjectFileSelectionReferenceV1,
  EpubProjectFileReferenceV1,
  PdfProjectFileReferenceV1,
  ProjectFileReferenceV1,
  WebSelectionReferenceV1,
  ChatMessageSelectionReferenceV1,
  SelectionReference,
  MessageReference,
} from './project-file.ts';
export {
  messageReferenceKey,
  projectFileReferenceKey,
  MAX_MESSAGE_REFERENCES,
  MAX_PROJECT_FILE_REFERENCES,
  MAX_PROJECT_FILE_REFERENCE_CHARS,
  MAX_PROJECT_FILE_REFERENCE_CFI_CHARS,
  MAX_PROJECT_FILE_REFERENCE_QUOTE_CHARS,
  MAX_PROJECT_FILE_REFERENCE_CONTEXT_CHARS,
  MAX_PROJECT_FILE_REFERENCE_TOC_DEPTH,
  MAX_PDF_RECTS_PER_HIGHLIGHT,
  MAX_WEB_SELECTION_REFERENCE_CHARS,
  MAX_WEB_SELECTION_URL_CHARS,
  MAX_WEB_SELECTION_TITLE_CHARS,
  MAX_WEB_SELECTION_QUOTE_CHARS,
  MAX_WEB_SELECTION_CONTEXT_CHARS,
  MAX_CHAT_SELECTION_REFERENCE_CHARS,
  MAX_CHAT_SELECTION_ID_CHARS,
  MAX_CHAT_SELECTION_QUOTE_CHARS,
  MAX_CHAT_SELECTION_CONTEXT_CHARS,
  isSourceFingerprint,
  isCanonicalProjectRelativePath,
  isSelectionReference,
  isProjectFileSelectionReferenceV1,
  isChatMessageSelectionReferenceV1,
  isMessageReference,
  isEpubProjectFileReferenceV1,
  isPdfProjectFileReferenceV1,
  isProjectFileReferenceV1,
  isWebSelectionReferenceV1,
} from './project-file.ts';

// Message persistence mappers
export { messageToStored, storedToMessage } from './message-mapper.ts';

// Server types (headless operations)
export type {
  ServerStatus,
  ServerHealth,
  SessionProcessingStatus,
  ActiveSessionInfo,
} from './server.ts';
