export { parseJsonLoose } from './json/parseJsonLoose.ts';
export {
  PURPOSES, isPurpose, PROVIDER_IDS, isProviderId, jurisdictionLabel,
  ModelError, isSignInError, isServiceConfigError, isRetryableStatus,
  SERVICE_CONFIG_HINT, MODEL_ERROR_CODES, isModelErrorCode, truncationRefusal,
} from './model/protocol.ts';
export type {
  Purpose, ProviderId, Bloc, Jurisdiction, DataHandling, AllowedModel,
  InferContext, InferRequest, InferUsage, InferResponse, ModelErrorCode,
  StopReason,
} from './model/protocol.ts';
export type { ModelClient } from './model/client.ts';
// The two "a retry cannot fix this" predicates. They lived in
// `src/lib/model/authFailure.ts` and moved here for one reason: the
// extractors read `isAuthFailure` to set `Finding.authError`, and the
// extractors now run in the browser AND in the worker. Both are pure tests
// over a `ModelError` code, so they belong beside `protocol.ts`, which is
// where the codes themselves are declared.
export { isAuthFailure, isAccessRefusedError } from './model/authFailure.ts';
// Reading the gateway's two envelopes. Shared because BOTH the browser and
// `apps/api` now call /v1/infer, and what must not diverge is the judgement
// — which bodies count as an answer, and what a refusal means — not the
// transport each one holds it in.
export { codeFromStatus, modelErrorFrom, inferResponseFrom } from './model/inferEnvelope.ts';
export {
  createSseEventReader, sseFields, encodeFrame, decodeFrame, readFrames,
} from './model/sse.ts';
export type { Frame, StreamEnd } from './model/sse.ts';
export { ROLES, isRole } from './api/records.ts';
export type { Role, MeResponse, WorkspaceSettings } from './api/records.ts';
// §6.3/P32: the workspace's people. The ONE place a user id becomes a name,
// declared here because the browser resolves through it and `apps/api`
// answers it — a name carried on every disposition payload instead would be
// a second copy of a mutable field, refreshed at different times in
// different places.
export type { WorkspaceUser, WorkspaceUsers } from './api/records.ts';
// §8/§9's run outbox, P22: one payload vocabulary, two transports. Declared
// here because the browser reads these and `apps/api` writes them, and
// Stage 4's socket sends the same vocabulary, four types wider (EVENT_TYPES).
export {
  RUN_EVENT_TYPES, isRunEventType, EVENT_TYPES, isEventType, subscriptionKey,
  RUN_STATES, RUN_CELL_STATES,
} from './api/records.ts';
export type {
  RunEventType, RunStartedPayload, FindingEventPayload, RunFinishedPayload,
  RunEventPayload, EventType, EventPayload, AppEvent, EventPage, SubscriptionRef,
  DispositionChangedPayload, NoteAddedPayload, AssignmentEventPayload,
  RunState, RunCellState, RunCellCounts, RunView,
} from './api/records.ts';
// §6.3/S17's assignment (Stage 4 Task 24): a request a person made of
// another, never a disposition. Declared here because `apps/api` writes it
// and the browser renders it, like every other wire shape in this file.
export type {
  AssignmentView, AssignmentsPage, AssignmentInboxItem, AssignmentInboxPage,
} from './api/records.ts';
// Part 3B's wire shapes: a review's findings assembled from rows, a
// disposition and its event, and what a per-clause retry cleared. One
// declaration, two programs — the browser reads them and `apps/api` writes
// them.
// §8's live transport (Stage 4 Task 16). ONE frame union, both directions,
// both sides -- the same argument RUN_EVENT_TYPES is here for, one layer
// out: a second copy in src/lib/ is a client that silently drops whichever
// frame the two disagree about, and the likeliest casualty is
// resync_required, the one frame that says a hole exists.
export {
  WS_SUBPROTOCOL, WS_BEARER_PREFIX, WS_PATH,
  WS_CLOSE_UNAUTHENTICATED, WS_CLOSE_UNRESPONSIVE,
  isClientFrame, isSubscriptionRef,
  // §8's heartbeat (Stage 4 Task 22). `PresenceMember` is declared beside
  // `ServerFrame` rather than in `apps/api/src/realtime/presence.ts`, where
  // the plan put it, for the mechanical reason that the frame union carries
  // it and the browser reads that union: a type the wire references cannot
  // live in a workspace the browser does not import.
  PRESENCE_SCREENS, isPresenceScreen,
} from './api/socket.ts';
export type { ClientFrame, ServerFrame, PresenceMember, PresenceScreen } from './api/socket.ts';
export type {
  FindingsPage, DispositionView, DispositionCause, DispositionEventView,
  DispositionWithHistory,
  DispositionWriteResult, DispositionHistory, ReviewHistory, ReviewHistoryEvent,
  ActivitySource, ActivityRow, MatterActivityPage,
  RetryCleared, RetryResult,
  NetPositionAction, NetPositionWriteResult,
} from './api/records.ts';
// The domain logic that decides what a published playbook version SAYS,
// needed by the browser that reviews a changeset and by the API that
// publishes it. Moved out of `src/lib/db/changesets.ts` rather than copied:
// two implementations of this, reachable only from two different processes,
// is this project's most repeated defect in its worst available form.
export {
  isDecided, isPublishable, publishedTextFor, provenanceFor, newClauseTitle,
  defaultExtractPrompt, applyItem, changeSummaryFor, nextVersionContent,
} from './playbook/applyChangeset.ts';
export type {
  RedlineEditKind, RedlineEdit, ChangeKind, ChangesetItem, ChangesetLike,
} from './playbook/applyChangeset.ts';

// ---------------------------------------------------------------------------
// The review closure (§13 Stage 0, P20). Every module below was MOVED from
// `src/lib/`, not copied: the browser runs a review today and the worker will
// run one in §9, and two implementations of "which page did this quote come
// from" or "what does a re-run do to a verification" — reachable only from two
// different processes — is this project's most repeated defect in the form
// where nobody can read the two copies side by side.
//
// EXTEND `packages/core/test/importBoundary.test.ts`'s `exported` array in the
// same commit that adds a name here, or the S14 guard cannot see it.
// ---------------------------------------------------------------------------

// The shapes. One declaration, three programs — see domain/types.ts.
export type {
  RiskLevel, PositionOrigin, PositionOutcome, StandardPosition, PlaybookClause,
  PlaybookVersion, DocumentFile, Citation, VerificationState, Verification, Note,
  Finding, ReviewRun, DocumentRecord, Collection, NetPositionState, TrailStep,
  NetPosition, ReviewTarget,
} from './domain/types.ts';

export { uid } from './domain/uid.ts';
export { mapWithConcurrency } from './domain/concurrency.ts';
export { SCAN_TEXT_THRESHOLD, pageSegments, pageSegmentsWithNumbers } from './domain/pageSegments.ts';
export { hasNoTextLayer, normalizeForMatch, findQuoteRects } from './domain/citations.ts';
export type { PdfTextItem, PdfPageText, QuoteRect } from './domain/citations.ts';
// `derivePage` is the ONLY place a citation page number is produced, and
// `repairCitations` is the only caller that should need it — both are
// exported because the browser's read-time review migration calls the second
// directly.
export { derivePage } from './domain/citationPage.ts';
export { repairCitations } from './domain/citationRepair.ts';
export {
  VerificationError, unchecked, requiresReason, effectiveReason, applyVerification,
  resetVerification, findingKey, makeNote,
} from './domain/verification.ts';
export type { VerificationChange } from './domain/verification.ts';
export {
  NetPositionError, unconfirmedPosition, confirmPosition, amendPosition,
  resetPosition, positionText, stepEffectText,
} from './domain/netPosition.ts';
export { NO_RATIONALE_NOTE, OUTCOMES, normalisePositionOutcome } from './domain/positionOutcome.ts';
export type { PositionOutcomeFields } from './domain/positionOutcome.ts';
export { DEFAULT_RISK_TOLERANCE, resolveRiskCriteria, riskCriteriaBlock } from './domain/riskBlock.ts';
export { isCollectionTarget, targetDocumentIds, findingsKeyFor } from './domain/reviewTarget.ts';
export { extractableText, usableText, assessDocument, contextBudgetChars } from './domain/modelContext.ts';
export type { ReadableSource, DocumentReadability } from './domain/modelContext.ts';
export {
  isNotYetRead, notYetReadMessage, notYetReadMessageFor, STILL_READING_NOTICE,
  couldNotBeReadMessageFor, failedToRead,
} from './domain/parseState.ts';
export type { ParseStateSource } from './domain/parseState.ts';
export { orderedMembers } from './domain/collectionOrder.ts';
export type { CollectionMember } from './domain/collectionOrder.ts';
export { buildCollectionPrompt } from './domain/collectionPrompt.ts';

// The two extractors. They are SEPARATE functions with their own prompts and
// their own schemas, deliberately (CLAUDE.md): a collection produces one
// synthesised position per clause across many documents, a standalone review
// produces one answer per document, and sharing code between them is how the
// single-document path acquires a special case for collections later. Do not
// merge them.
//
// Both take a `ModelClient` as their FIRST argument rather than importing
// one. That is the whole of §9's "the worker runs the extractors from core":
// the same function, over the same shapes, reached through the gateway from a
// browser or from a worker.
export {
  extractClause, buildClausePrompt, clauseSchema, CLAUSE_SCHEMA,
} from './review/extractClause.ts';
export type { BuildClausePromptOptions, ExtractClauseContext } from './review/extractClause.ts';
export {
  extractCollectionClause, collectionClauseSchema, COLLECTION_CLAUSE_SCHEMA,
} from './review/extractCollectionClause.ts';
export type { ExtractCollectionClauseContext } from './review/extractCollectionClause.ts';
