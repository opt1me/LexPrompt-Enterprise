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
  VerificationError, unchecked, requiresReason, applyVerification,
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
