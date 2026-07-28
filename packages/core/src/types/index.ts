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
  EpubTocPathEntryV1,
  EpubTocNode,
  EpubHighlightV1,
  EpubProgressV1,
  EpubDocumentStateV1,
  EpubStateMutation,
  ProjectFileReferenceV1,
  MessageReference,
} from './project-file.ts';
export { projectFileReferenceKey } from './project-file.ts';
export {
  MAX_PROJECT_FILE_REFERENCES,
  MAX_PROJECT_FILE_REFERENCE_CHARS,
  MAX_PROJECT_FILE_REFERENCE_CFI_CHARS,
  MAX_PROJECT_FILE_REFERENCE_QUOTE_CHARS,
  MAX_PROJECT_FILE_REFERENCE_CONTEXT_CHARS,
  MAX_PROJECT_FILE_REFERENCE_TOC_DEPTH,
  isSourceFingerprint,
  isCanonicalProjectRelativePath,
  isProjectFileReferenceV1,
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
