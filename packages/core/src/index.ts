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
  RedlineEditKind, RedlineEdit, ChangeKind, StandardPosition, PlaybookClause,
  ChangesetItem, ChangesetLike,
} from './playbook/applyChangeset.ts';
