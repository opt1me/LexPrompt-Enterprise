import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Settings as SettingsIcon, ClipboardList, Briefcase, ShieldCheck } from 'lucide-react';
import type { Playbook, PlaybookClause, PlaybookDraft, PlaybookVersion, DocumentFile, DocumentRecord, Review, ReviewRun, ReviewTarget, Matter, Collection, Finding, UserProfile, Verification, NetPosition } from './types';
import {
  applyVerification,
  findingKey,
  makeNote,
  resetVerification,
  unchecked,
  confirmPosition,
  amendPosition,
  resetPosition,
  NetPositionError,
  uid,
  orderedMembers,
  findingsKeyFor,
  isCollectionTarget,
  ModelError,
  isSignInError,
  isServiceConfigError,
  isNotYetRead,
  failedToRead,
  couldNotBeReadMessageFor,
  notYetReadMessageFor,
} from '@lexprompt/core';
import type {
  AppEvent, AssignmentEventPayload, AssignmentView,
  DispositionChangedPayload, DispositionWithHistory, NoteAddedPayload,
  PresenceMember, RetryResult, RunView, VerificationChange, WorkspaceSettings,
} from '@lexprompt/core';
import { getWorkspaceSettings } from './lib/db/workspaceSettings';
import { apiKeyWasPurgedThisSession, loadSettings } from './lib/storage';
import { API_KEY_PURGED_NOTICE } from './lib/privacyCopy';
import {
  listPlaybooks as listTemplates, getPlaybook as getTemplate, deletePlaybook as deleteTemplate,
  newPlaybook as newTemplate, exportPlaybook as exportTemplate, importPlaybook as importTemplate,
  getPlaybookContent, newPlaybookDraft, publishAndPoint, saveDraft, discardDraft,
} from './lib/db/playbooks';
import {
  listMatters, getMatter, saveMatter, newMatter, deleteMatter,
} from './lib/db/matters';
import {
  listDocuments, getDocument, addDocument, deleteDocument, setDocumentRole, reparseDocument,
} from './lib/db/documents';
// The precedent path (§11.1) — deliberately NOT `addDocument`, which is the
// matter ingest path: a precedent going through it would be another client's
// deal in a matter's document list (S23).
import {
  createPrecedentSet, deletePrecedentDocument, newPrecedentSet, uploadPrecedent,
} from './lib/db/precedents';
import { getDocumentBlob } from './lib/db/blobs';
import {
  listReviews, getReview, saveReview,
} from './lib/db/reviews';
import { getProfile } from './lib/db/profile';
import { describeLoadError, describeRunEnding } from './lib/loadError';
import { StalePanel } from './components/StalePanel';
import { subscribe } from './lib/api/socket';
import { onConnectionState, onPresence, type ConnectionState } from './lib/api/socket';
import {
  getOpenAssignments, resolveAssignment as resolveAssignmentRequest,
} from './lib/api/assignments';
// Task 17/18: the browser asks about a run instead of performing one.
import {
  cancelRun, getRun, isRunOver, liveRunFor, retryCell, startRun, watchRun,
} from './lib/api/runs';
import {
  addNote, conflictingDisposition, dispositionFor, dispositionVersionFor, dispositionsReadAt,
  getFindings, rememberConflict, rememberPushedDisposition, setDisposition, setNetPosition,
  verificationFromDisposition,
} from './lib/api/findings';
import { loadDirectory, userInitials, userName } from './lib/api/users';
import { formatInstant } from './lib/instant';
import { debug } from './lib/debug';
import { getVersion, listVersions } from './lib/db/playbookVersions';
import { scanPlaybookAcrossMatters } from './lib/playbookScan';
import { buildPositionHealthMap } from './lib/positionHealthMap';
import { buildPositionRows, type PositionRow } from './lib/standardPositions';
import {
  listCollections, getCollection, saveCollection, deleteCollection, newCollection,
} from './lib/db/collections';
import { useRoute, type Route } from './lib/router';
import { gatewayModelClient } from './lib/model/gatewayModelClient';
import { isAuthFailure } from '@lexprompt/core';
import { MODEL_CHOICE_STALE_MESSAGE, modelProvenanceName } from './lib/model/modelChoice';
import { useToast, Toast } from './components/Toast';
import { LoadErrorPanel } from './components/LoadErrorPanel';
import { ServiceConfigError } from './components/ServiceConfigError';
import { SettingsPanel } from './features/settings/SettingsPanel';
import { MattersList, type MattersListItem, type CreateMatterParams } from './features/matters/MattersList';
import { MatterHome } from './features/matters/MatterHome';
import { MatterPickerModal } from './features/matters/MatterPickerModal';
import { TemplateLibrary } from './features/templates/TemplateLibrary';
import { TemplateEditor, workingContent, hasUnpublishedContent } from './features/templates/TemplateEditor';
import { MegaPromptModal } from './features/templates/MegaPromptModal';
import { PublishDialog } from './features/templates/PublishDialog';
import { VersionHistory } from './features/templates/VersionHistory';
import { RouteChooser } from './features/authoring/RouteChooser';
import { DraftForm } from './features/authoring/DraftForm';
import { DraftReview } from './features/authoring/DraftReview';
import { generateDraft, type DraftFormValues } from './features/authoring/generateDraft';
import { buildFewShot, usedFewShotSources, type FewShotSource } from './features/authoring/fewShot';
import { saveDraftAsV1 } from './features/authoring/saveDraftAsV1';
import { useUnsavedDraftGuard } from './features/authoring/useUnsavedDraftGuard';
import type { AuthoringDraft } from './lib/authoringDraft';
import { RunPanel, RunProgressBar, RunCancelledBanner, RunEmptyFindingsBanner, RunInterruptedBanner } from './features/review/RunPanel';
import { ResultsView } from './features/review/ResultsView';
import { ExportGateBanner } from './features/review/ExportGateBanner';
import { firstUncheckedClauseId } from './features/review/ClauseIndex';
// `runReview` and `retryCell` are GONE (Tasks 18 and 20): the browser no
// longer performs a run, and a retry is one POST. `emptyRun` stays for the
// optimistic shape a just-clicked run renders between the click and the
// server's first answer.
import { emptyRun, type CollectionRunInput } from './features/review/runReview';
import { TabularReview } from './features/tabular/TabularReview';
import { parseFiles, parseFile, toDocumentRecord, documentFileForViewing } from './lib/documents';
// --- Sub-project F: learning from redlines ---------------------------------
//
// Task 10A wires the whole path — the chooser's redlines card was the
// mechanism with no path to it (CLAUDE.md's "sibling drift"/"correct
// mechanism, no path" pattern, its fifteenth instance in this project). None
// of these library functions are modified here; App.tsx only calls them in
// sequence, exactly as it already does for D's publish path and E's
// authoring flow.
//
// Task 10A-fix: `buildChangeset`/`publishChangeset` and `ChangesetReview`
// are deliberately NOT imported here. Spec §4.8 routes adopted positions
// into E's draft review and D's publish path; the changeset mechanism is
// for the OTHER entry point — a new deal read against a playbook version
// that really exists — and this app has no screen for that yet. Those three
// stay built, tested and unreached rather than being reached through a
// fabricated empty v1. See `features/redlines/positionsToDraft.ts`.
import { proposeRole, proposeChains, type PrecedentDocument, type PrecedentRole } from './lib/chains';
import { parseDocxRedlines, type ParsedEdit } from './lib/docxRedlines';
import { diffExtractedText } from './lib/pdfRedlineDiff';
import { inferPositions, type InferredPosition, type OpenQuestion } from './lib/inferPositions';
import { PrecedentUploadPanel } from './features/redlines/PrecedentUploadPanel';
import { PrecedentIntake, type UnreadableDocument } from './features/redlines/PrecedentIntake';
import { WhatWeLearned } from './features/redlines/WhatWeLearned';
import { TheWorkings, type StoredBasis } from './features/redlines/TheWorkings';
import { getPositionBasis } from './lib/db/positionBasis';
import { positionsToDraft, includedPositions } from './features/redlines/positionsToDraft';
import { Button } from './components/Button';
import { StandardPositionsView } from './features/positions/StandardPositionsView';
import { useAuth } from './lib/auth/useAuth';
import { SignInScreen } from './features/auth/SignInScreen';
import { AccessRefusedPanel } from './features/auth/AccessRefusedPanel';
import { useRole } from './lib/role';
import { isAccessRefusedError } from '@lexprompt/core';
import { UploadLocalData } from './features/upload/UploadLocalData';
import { LocalDataBanner, type LocalDataBannerState } from './features/upload/LocalDataBanner';
import { countLocalData } from './lib/upload/scan';
import { STORE_LABELS } from './lib/upload/report';
import { markUploadComplete, wasUploadComplete } from './lib/upload/uploaded';

/** `authoring-form` and `authoring-review` are sub-project E's two
 *  session-only screens. They deliberately have **no `Route`**: a draft
 *  must not survive a reload, and a URL that reopened one would be a URL
 *  that promised a draft it cannot produce — see `AUTHORING_VIEWS` below
 *  and R-E1. */
type View =
  | 'matters' | 'library' | 'editor' | 'run' | 'results' | 'tabular' | 'settings' | 'matter' | 'not-found'
  | 'authoring-form' | 'authoring-review'
  | 'redlines-intake' | 'redlines-learned' | 'redlines-workings'
  | 'positions'
  /** Stage 2 §13.1's uploader, available for one release. */
  | 'upload-local-data';

/** The two views that hold a session-only `AuthoringDraft`. Leaving either
 *  of them, by any path, destroys it (see the effect that clears the
 *  authoring state). */
const AUTHORING_VIEWS: readonly View[] = ['authoring-form', 'authoring-review'];

function isAuthoringView(view: View): boolean {
  return AUTHORING_VIEWS.includes(view);
}

/** Sub-project F's three session-only screens, mirroring `AUTHORING_VIEWS`
 *  above — same reasoning (R-F6: "a learning session is session-only,
 *  exactly as E's `AuthoringDraft` is"), same absence of a `Route`: a deep
 *  link cannot restore a set of in-memory `File`s, so none of the three
 *  gets one.
 *
 *  The session hands off to `authoring-review` — E's screen, holding E's
 *  `AuthoringDraft` — rather than ending here, so nothing durable is
 *  written on this side of the handoff at all. */
const REDLINES_VIEWS: readonly View[] = [
  'redlines-intake', 'redlines-learned', 'redlines-workings',
];

function isRedlinesView(view: View): boolean {
  return REDLINES_VIEWS.includes(view);
}

/** Wording for the two unsaved-work guards. Both are consulted by
 *  `confirmDiscardIfDirty`, which every exit from a screen goes through. */
const TEMPLATE_DIRTY_MESSAGE = 'This template has unsaved changes. Discard them?';
const AUTHORING_DRAFT_DIRTY_MESSAGE =
  'This drafted playbook has not been saved. It exists only in this tab, ' +
  'so leaving loses every clause you have reviewed. Leave anyway?';
// REWRITTEN IN THE SAME COMMIT AS THE STORAGE (spec §11.1). This used to say
// leaving "loses the documents you brought in and the positions found in
// them" — which asserted, in a modal a person reads at the moment of
// deciding, that the documents were not stored. §18 item 3 says no screen
// may say that, and the search for such a screen is what found this one: the
// task brief's own grep (for "never stored" / "read once") would have missed
// it entirely, because the false claim is made in different words.
//
// What is still true and still worth a confirm: the SESSION is session-only
// (R-E1/R-F6) — the roles confirmed, the positions found, the adopt/reject
// decisions, and the draft they lead to all die with the tab.
const REDLINES_DIRTY_MESSAGE =
  'This learning session has not been turned into a playbook. It exists only in this tab, ' +
  'so leaving loses the positions found in these documents and the decisions you have made ' +
  "about them. The documents themselves stay in your firm's LexPrompt. Leave anyway?";

/** Why "What we learned" shows no open questions on THIS entry point, and
 *  why that is not the same as having found none.
 *
 *  An `OpenQuestion` is derived (in `inferPositions`) from a clause a
 *  playbook already has that none of these documents amended — spec §2's
 *  "never guess a position from silence", turned into a question. A session
 *  building a brand-new playbook out of these documents has no such clause
 *  list, so `unamendedClauses` is genuinely `[]` and no search happens.
 *  Saying so is the point: without it, the screen's empty state reads
 *  "nothing the redlines raised without also settling it", which asserts a
 *  search that never ran. Read against an existing playbook — F's other
 *  entry point, not yet built — this block would fill in. */
const REDLINES_NO_QUESTIONS_REASON =
  'No open questions were looked for here. An open question comes from a clause your playbook already ' +
  'has that none of these documents amended — and this session is building the playbook out of these ' +
  'documents, so there is no clause list yet to check them against.';

/** Builds the persisted `Review` shape from an in-session `ReviewRun`, for
 *  a run scoped to a matter (`matterId` — see `activeMatterId`). Shared by
 *  every place a run's progress needs writing back to IndexedDB
 *  (`handleStartRun`'s debounced mid-run saves, its completion/cancellation
 *  save, and `handleRetryCell`'s post-retry save) so those three call sites
 *  cannot drift into building slightly different `Review` objects — the
 *  exact sibling-drift failure this project's own review history keeps
 *  flagging when the same shape gets rebuilt by hand more than once.
 *
 *  Task 4: `playbookVersionId` is read straight off `run.playbookVersionId`
 *  (Task 10 added the field to `ReviewRun` itself — `emptyRun` sets it from
 *  the live `PlaybookVersion` a fresh run reads, and `openReview` carries a
 *  reopened review's own stored id through unchanged). Reading it from
 *  `run.templateSnapshot.id` instead, as this used to, would silently
 *  overwrite a reopened LEGACY review's back-filled (or dangling, R-D15)
 *  `playbookVersionId` with whatever id its migrated snapshot happens to
 *  carry on every re-save (e.g. a retried cell) — two derivations of one
 *  fact, exactly the sibling drift this project keeps paying for. Omitted
 *  rather than set to an empty string on the defensive path where it
 *  somehow is not (never set to `undefined` — `structuredClone` preserves
 *  that key, per R-D4/R-D15). */
function reviewFromRun(run: ReviewRun, matterId: string, modelId: string, userId: string): Review {
  return {
    id: run.id,
    matterId,
    playbookSnapshot: run.templateSnapshot,
    ...(run.playbookVersionId ? { playbookVersionId: run.playbookVersionId } : {}),
    documentIds: run.documentIds,
    target: run.target,
    findings: run.findings,
    modelId,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    cancelledAt: run.cancelledAt,
    createdByUserId: userId,
  };
}

/**
 * TASK 20: `hydrateRecordForReview` AND `hydrateIdForReview` ARE GONE.
 *
 * They turned a persisted document into something FIT FOR EXTRACTION —
 * bytes fetched and, for a scan, page images regenerated — because the
 * browser handed documents to the extractor. It does not any more: a run is
 * a POST and a retry is a POST, and the server hydrates for review itself
 * (Task 9), which is where the extraction happens and therefore where this
 * project's founding defect has to be guarded.
 *
 * The guard did not go with them: `parse_state` is checked before a run
 * starts and before a clause is retried, and hydration failure is reported
 * as `parseError` rather than left for the extractor to mistake for an
 * empty document. The deletion and that guard are one change, not two.
 *
 * What the browser still hydrates is documents FOR VIEWING —
 * `documentFileForViewing`, which carries no page images because
 * `PdfCanvas` renders the PDF itself.
 */

/**
 * One persisted document as a `DocumentFile` FOR THE VIEWER — its stored
 * bytes fetched and wrapped, with no page images.
 *
 * `documentFileForViewing`, not `documentFileForReview`: nothing this
 * builds is handed to an extractor any more (Task 20), and regenerating a
 * scan's page images through pdfjs to populate a field nobody reads is
 * seconds of work per document for nothing. `PdfCanvas` renders the PDF
 * itself.
 */
async function hydrateRecordForViewing(record: DocumentRecord): Promise<DocumentFile> {
  const blob = await getDocumentBlob(record.id);
  return documentFileForViewing(record, blob);
}

/**
 * The browser's half of `refuseUnparsedDocuments` (`routes/runs.ts`).
 *
 * Since Stage 3 an upload stores the bytes and returns; a parse worker reads
 * them a moment later. A review started in that window is a review of `text:
 * ''`, which reports every clause absent — this project's founding defect,
 * caused by our own write path rather than by a scan. The API refuses such a
 * run by name; the browser still ORCHESTRATES runs for the whole of Part 3A,
 * so that refusal is never consulted, and this is it on the side that starts
 * the work.
 *
 * The sentence comes from `@lexprompt/core` and is not written here: two
 * copies of one refusal is how one of them stops being true.
 */
/**
 * How long to wait before asking again whether a document has been read.
 *
 * A second, matching `watchRun`'s poll: a parse of an ordinary contract
 * finishes in well under that, and the interval is what a person waiting for
 * a document they just added would call "immediately". It is a CONSTANT
 * rather than a config key on purpose — nothing about it varies by
 * deployment, and the declared caps table is for values an operator sets.
 */
const PARSE_POLL_MS = 1_000;

function notYetReadNames(records: DocumentRecord[]): string[] {
  return records.filter(isNotYetRead).map(r => r.name);
}

/**
 * The OTHER state a review may not run over: read, and the read failed.
 *
 * `routes/runs.ts` has refused both since Task 9; this side refused only
 * `pending`, so a matter holding one unreadable document met the failure as
 * a 409 after the POST rather than as a sentence before it. The server's
 * refusal is the one that cannot be got wrong quietly, and this is the UI
 * telling the truth rather than being the enforcement (§11).
 *
 * The sentence is `@lexprompt/core`'s, and it is the SAME one the route
 * throws — extracted there at its second copy rather than written out
 * again here.
 */
function couldNotBeReadNames(records: DocumentRecord[]): string[] {
  return records.filter(failedToRead).map(r => r.name);
}


/** Replaces one finding in a run, copying only the two objects on the path
 *  to it. Extracted rather than inlined three times: this project has six
 *  sibling-drift findings on record, and three hand-rolled copies of a
 *  nested-map update is exactly how the seventh happens.
 *
 *  Task 8A: `docId` is always the ACTIVE document (which viewer pane/tab a
 *  human was looking at when they wrote this), never assumed to be the key
 *  a finding is stored under — those are the same thing for a standalone
 *  review and different things for a collection one, where every clause's
 *  finding lives under the collection id (`findingsKeyFor`, Task 6A)
 *  regardless of which member document happens to be on screen. Resolving
 *  the key here, once, means every caller (`handleVerify`, `handleAddNote`,
 *  `handleConfirmNetPosition`, `handleAmendNetPosition`, `handleRetryCell`)
 *  writes under the same key `ResultsView`/`TabularReview` read from. */
function withUpdatedFinding(
  run: ReviewRun,
  docId: string,
  clauseId: string,
  finding: Finding,
): ReviewRun {
  const key = findingsKeyFor(run.target, docId);
  return {
    ...run,
    findings: {
      ...run.findings,
      [key]: { ...run.findings[key], [clauseId]: finding },
    },
  };
}

/**
 * Task 23's copy split. `openrouter.ts`'s old contract — a 401/403 means
 * the user's key was rejected, route to Settings — retires along with
 * `AUTH_ERROR_MESSAGE`, the string that named it: there is no OpenRouter
 * key in the browser any more, so that sentence is simply false now. It has
 * split into two facts for two audiences (`isSignInError`/
 * `isServiceConfigError`, `packages/core/src/model/protocol.ts`): the
 * user's own session, which they fix by signing in again, and the firm's
 * deployment, which only an administrator can fix and which must never be
 * sent to Settings — Settings holds no credential to change any more.
 */
const SIGN_IN_ERROR_MESSAGE = 'Your sign-in has expired. Sign in again to continue.';
const NOT_PERMITTED_MESSAGE =
  'Your account does not have access to LexPrompt. Ask your IT team to add you.';
/**
 * §7's group overage. Kept as a separate string from `NOT_PERMITTED_MESSAGE`
 * on purpose: they are two different facts about two different people, and
 * the whole reason the gateway detects overage separately is that showing
 * the message above to a partner in forty groups would be a wrong answer
 * told with complete confidence.
 */
const GROUP_OVERAGE_MESSAGE =
  'Your account is in too many groups for LexPrompt to read them from your sign-in. '
  + 'This is not something signing in again will fix — ask your IT team to grant LexPrompt '
  + 'directory read access, or to reduce your group memberships.';
const MODEL_UNAVAILABLE_MESSAGE =
  'The model this review was set up with is no longer available. Choose another in Settings.';

/** A live per-clause failure this app cannot classify further than "auth
 *  class" (see `handleModelError`'s doc comment on why this stays generic).
 *  Never claims Settings will help — the affected finding, rendered below,
 *  is where the specific detail (and, when it names a configuration fault,
 *  `<ServiceConfigError>`) actually lives. */
const PER_CLAUSE_MODEL_FAILURE_MESSAGE =
  'This review stopped: a clause failed for a reason a retry will not fix. '
  + 'See the affected finding below for what the model reported.';

/** Maps a URL route to the `view` it corresponds to today. `matter` now has
 * its own screen (Task 11): `MatterHome`. `review` also renders — reusing
 * the existing results/tabular views scoped to a matter (see
 * `openReview`) — since a persisted review's cards and viewer are the same
 * v1 components a live run uses, just fed hydrated-from-IndexedDB data
 * instead of an in-session run. `playbook` (a single-playbook deep link,
 * Task 12) maps to `editor` — see `playbookRouteId`'s effect below for how
 * a cold load of that URL hydrates `activeTemplate` from storage.
 * `not-found` maps to its own `not-found` view (Minor fix): this used to
 * fall into the `default` case below and silently render the Matters list
 * for any unrecognised path, contradicting `router.ts`'s own doc comment
 * that an unparseable/unknown path yields `not-found` "rather than a silent
 * fallback to the home route." `default` stays only as a defensive
 * fallback — `Route`'s union already covers every case explicitly above
 * it. */
function viewForRoute(route: Route): View {
  switch (route.name) {
    case 'matters': return 'matters';
    case 'matter': return 'matter';
    case 'review': return 'results';
    case 'playbooks': return 'library';
    case 'playbook': return 'editor';
    case 'settings': return 'settings';
    case 'positions': return 'positions';
    case 'upload-local-data': return 'upload-local-data';
    case 'not-found': return 'not-found';
    default: return 'matters';
  }
}

/** The inverse mapping, for the views that own a canonical URL. Views with
 * no route of their own (run/tabular — still session-scoped) are
 * intentionally absent: switching to one of them must not push a history
 * entry it can't be deep-linked back into yet. `matter`, `results` and
 * `editor` are NOT listed here either, even though all three now have
 * routes — each carries an id (`matterId`, `matterId`+`reviewId`, or
 * `playbookId`) that this static per-`View` table cannot express, so their
 * navigation goes through `navigate(...)` directly at the call site instead
 * of through `requestView`. */
const ROUTE_FOR_VIEW: Partial<Record<View, Route>> = {
  matters: { name: 'matters' },
  library: { name: 'playbooks' },
  settings: { name: 'settings' },
  positions: { name: 'positions' },
  'upload-local-data': { name: 'upload-local-data' },
};

/**
 * The real app. Still split out from the default-exported `App` below, which
 * is now purely the sign-in and role gate: `AppShell` does not mount at all
 * until a caller has been authenticated and found to have access, so no
 * screen it renders can hint at a working app behind a refusal.
 *
 * It used to be split out for a second reason as well — the one-time
 * v1→IndexedDB playbook migration had to resolve before `loadLibrary` could
 * read the store it wrote into. That migration is gone (Task 23): the store
 * it wrote is one the app stopped reading in Part 2A, and what it converted
 * is now converted by the UPLOADER, on the way out of this browser.
 */
function AppShell({ signIn }: { signIn: () => void }) {
  // Task 17: the role gate for the two partner-only actions. A second
  // `useRole()` instance, not a prop threaded down from `App()` — it shares
  // `getProfile()`'s cache (so this costs no second request once the boot
  // gate above has already resolved one) without widening `AppShell`'s own
  // prop surface, which nothing outside this file constructs directly.
  const roleState = useRole();
  // The inline closure defers the actual `confirmDiscardIfDirty` reference
  // (declared further down, once `view`/`activeTemplate` exist) until the
  // guard is actually invoked — never before this render has finished, so
  // the forward reference is safe. See useRoute's doc comment for why this
  // is how Back/Forward gets the same unsaved-changes guard as a nav-link
  // click (`requestView`, below).
  const [route, navigate] = useRoute(() => confirmDiscardIfDirty());
  const [view, setView] = useState<View>(() => viewForRoute(route));
  const [templates, setTemplates] = useState<Playbook[]>([]);
  const [matters, setMatters] = useState<MattersListItem[]>([]);
  // The CONTENT a run or a reopened review is working against — a published
  // version, or a review's frozen snapshot. Never the thing the editor
  // edits: a published version is immutable.
  const [activeTemplate, setActiveTemplate] = useState<PlaybookVersion | null>(null);
  // The editor's trio: the playbook's identity, its CURRENT PUBLISHED
  // content, and the unpublished working copy if there is one. Split because
  // `Playbook` no longer carries clauses or prompts, and because a published
  // version is immutable — the editor is handed it for reference and edits
  // only the draft (Task 9).
  //
  // `activeDraft === null` is a real state, not a missing one: it means
  // there are no unpublished edits, so what is on screen IS the published
  // version and there is nothing to publish.
  const [activePlaybook, setActivePlaybook] = useState<Playbook | null>(null);
  const [activeVersion, setActiveVersion] = useState<PlaybookVersion | null>(null);
  const [activeDraft, setActiveDraft] = useState<PlaybookDraft | null>(null);
  const [documents, setDocuments] = useState<DocumentFile[]>([]);
  const [run, setRun] = useState<ReviewRun | null>(null);
  // Task 10 / R-D15: `run.playbookVersionId` resolved against the LIVE
  // playbookVersions store, for the results header's "ran against vN" line.
  // FOUR states, not three (a browser check found the third collapsed into
  // the first, hiding a real failure as if nothing had gone wrong):
  // `undefined` means "no lookup has settled for the CURRENT run yet"
  // (rendered as nothing by `ResultsView` — never guessed at, and this is a
  // genuinely quiet case: there is nothing wrong to report yet), `null`
  // means the lookup ran, succeeded, and found nothing (the version was
  // deleted), `'error'` means the lookup itself threw (a DB read failure —
  // proves nothing about whether the version exists, and must not be
  // presented as "deleted" or as silence), and a `PlaybookVersion` is the
  // ordinary resolved case. Kept out of `run` itself — this is a read of a
  // DIFFERENT store than anything else `run` carries, and re-deriving it
  // from `run.templateSnapshot` would silently mask a live deletion the
  // snapshot has no way to know about (the snapshot's own `id` doesn't stop
  // existing just because the live version record does).
  const [runPlaybookVersion, setRunPlaybookVersion] =
    useState<PlaybookVersion | null | undefined | 'error'>(undefined);
  const [isRunning, setIsRunning] = useState(false);
  /**
   * THE RUN, AS THE SERVER HAS IT (Task 18).
   *
   * A run used to be an `AbortController` and some React state, and it died
   * with the tab. It is a row now: this is the browser's copy of what
   * `GET /v1/runs/:id` last said, kept in a ref as well as in state because
   * `handleCancelRun` and the watch callbacks read it from closures that
   * outlive the render they were created in.
   *
   * `null` means no run is being watched — which is not the same as no run
   * existing, and is why `openReview` ASKS (`liveRunFor`) rather than
   * assuming.
   *
   * A REF AND NOT STATE, deliberately: nothing renders a `RunView`. The
   * screen renders the `ReviewRun` (the findings) and `isRunning`, and the
   * only readers of this are `handleCancelRun` and the watch's callbacks,
   * every one of which runs from a closure created on an earlier render.
   * Holding it in state as well would be a second copy of one fact, kept in
   * step by hand.
   */
  const runViewRef = useRef<RunView | null>(null);
  /** Unsubscribes the current `watchRun`. One at a time; `attachRun` stops
   *  the previous before starting another, so two watches cannot both be
   *  applying events to one screen. */
  const watchStopRef = useRef<(() => void) | null>(null);
  /** `refreshFindings`'s coalescing state: whether a read is in flight,
   *  whether another was asked for while it was, and how many have failed in
   *  a row. See `refreshFindings`. */
  const findingsRefreshRef = useRef<{ inFlight: boolean; again: boolean; failures: number }>(
    { inFlight: false, again: false, failures: 0 });
  /**
   * How many human writes this browser has had CONFIRMED by the store.
   *
   * `carryHumanState` is gone (Task 21) and nothing merges a snapshot any
   * more: the findings a read returns already carry the disposition, the
   * notes and the net position, because each is its own row written by its
   * own route. What a read cannot carry is a write that COMMITTED WHILE THE
   * READ WAS IN FLIGHT — the response was assembled before it. Applying such
   * a response puts a verification a lawyer has just made back to
   * "Not checked" for one poll interval.
   *
   * So a read that spans a confirmed human write is DISCARDED AND REISSUED
   * rather than merged. That is deliberately not the old merge: nothing from
   * the browser's copy is carried onto the server's answer, and the second
   * read is issued after the write, so it carries the judgement itself.
   *
   * Incremented in `applyToFinding`, which every human-write handler already
   * funnels through.
   */
  /**
   * SECTION 3'S FOURTH LOAD STATE (Task 20, P42).
   *
   * `loading`, `error` and `empty` are all about a READ that has already
   * happened. This is about whether what is already on screen is still
   * being kept current, which is a different question and the one section 19
   * calls "the defect this design is most likely to ship in the app": a live
   * view that has quietly stopped being live looks exactly like a quiet
   * review.
   *
   * Held here rather than read per component so there is ONE answer to "am
   * I connected?" on the screen. The socket reports it (`onConnectionState`
   * fires immediately with the current value, so a mount during a stale
   * period renders stale rather than waiting for a change that has already
   * happened).
   */
  const [liveState, setLiveState] = useState<ConnectionState>('connecting');
  useEffect(() => onConnectionState(setLiveState), []);
  /**
   * WHO ELSE IS ON THE OPEN REVIEW (§8, S6, Task 23).
   *
   * The SERVER'S roster, replaced whole on every frame and never merged
   * with what was held before. A client that accumulated its own view would
   * keep a colleague's face on a clause after the frame that removed them,
   * and *"a stale presence indicator that claims someone is there is worse
   * than no indicator"*: a reviewer might defer to somebody who left ten
   * minutes ago. `onPresence` also clears this to empty when the socket
   * goes, for the same reason.
   *
   * It gates nothing. Presence locks nothing, blocks nothing and gates no
   * write (S6) — `stale` is what disables a control, and no control reads
   * this list.
   */
  const [presence, setPresence] = useState<PresenceMember[]>([]);
  /**
   * EVERY OPEN REQUEST ON THE REVIEW THAT IS OPEN (§6.3, S17, Task 25).
   *
   * Both directions — what has been asked of you, and what you have asked of
   * others — in one list, filtered per card by the cell it names. Read once
   * when the review opens and kept current by `assignment.created` /
   * `assignment.resolved` over the socket, which is what makes §18 item 5's
   * *"an assignment reaches the assignee"* true without a reload.
   *
   * The read carries what the SERVER holds, and it is deliberately not
   * merged with a local guess: a request this browser composed but the store
   * refused must not sit on a card looking like one somebody made.
   */
  const [assignments, setAssignments] = useState<AssignmentView[]>([]);
  /** The read failed. A dedicated error state rather than an empty list, and
   *  rendered on the panel it is about rather than as a toast — the rule
   *  every other load path in this codebase follows. */
  const [assignmentsError, setAssignmentsError] = useState<string | null>(null);
  /**
   * WHAT IS ALREADY OPEN on a review, read once when it opens.
   *
   * The socket carries what happens NEXT; a request made while this browser
   * was closed has no event it will ever receive, and a person signing in to
   * find nothing waiting is exactly the "a mechanism that reaches nobody"
   * failure §18 item 5 is about.
   *
   * A FAILURE IS SAID AND THE LIST IS EMPTIED. `getOpenAssignments` rejects
   * rather than resolving to an empty list, and this keeps the two apart:
   * the panel renders the error branch INSTEAD of a list, which is the load
   * rule this codebase applies everywhere else.
   */
  const readAssignments = useCallback(async (reviewId: string) => {
    try {
      const open = await getOpenAssignments(reviewId);
      setAssignments(open);
      setAssignmentsError(null);
    } catch (e) {
      setAssignments([]);
      setAssignmentsError(e instanceof Error
        ? `LexPrompt could not read what has been asked of you on this review: ${e.message}`
        : 'LexPrompt could not read what has been asked of you on this review.');
    }
  }, []);
  /**
   * A resync is in progress: the events between this client's cursor and
   * now are gone, so the screen is being RE-READ rather than merely waited
   * on. A different fact from `stale` and the banner says so.
   *
   * Cleared by the refresh that answers it, in `attachRun`'s `onResync`.
   */
  const [resyncing, setResyncing] = useState(false);
  const humanWritesRef = useRef(0);
  // Tracks the latest `run` state, for every path that cannot just read the
  // `run` state variable: the watch's callbacks, and the human-write
  // handlers, all of which run from closures created on an earlier render.
  const latestRunRef = useRef<ReviewRun | null>(null);
  // Task 8A: the collection info (`target` + ordered, hydrated `members`) a
  // LIVE run over a collection was started with (`handleStartRun`), or that
  // a REOPENED collection review was reconstructed with (`openReview`) — the
  // one thing `handleRetryCell` needs beyond `run` itself to re-run a
  // collection clause through the collection extractor rather than
  // `extractClause`. `null` for a standalone (document-target) run/review,
  // or when a collection review's own collection record could not be
  // reloaded — `handleRetryCell` refuses to retry a collection clause
  // rather than silently falling back to a single-document answer, which is
  // exactly the confidently-wrong result this sub-project exists to avoid.
  const activeCollectionRef = useRef<CollectionRunInput | null>(null);
  /** WHY `activeCollectionRef` is empty, when it is. A collection that was
   *  ungrouped is gone for good, and telling someone to reload and try again
   *  sends them round a loop that cannot succeed; a transient read failure is
   *  worth retrying. Both used to collapse to one message. */
  const collectionUnavailableRef = useRef<'missing' | 'error' | null>(null);
  // Minor 2: the id of whoever CREATED the in-session review — set once,
  // either from a freshly-started run's own creator (`handleStartRun`) or
  // from a reopened review's stored `createdByUserId` (`openReview`), and
  // read (never rewritten) by every later save. Before this existed,
  // `handleVerify`/`handleAddNote`/`handleRetryCell`'s persist all passed
  // the CURRENT actor's profile id into `reviewFromRun`'s `userId` param,
  // which becomes `createdByUserId` — so verifying a finding silently
  // reattributed authorship of the whole review to whoever last touched it.
  // With one local profile (ruling R1) this was invisible; it would not be
  // once a second reviewer exists.
  const createdByUserIdRef = useRef<string>('');
  // Which matter (if any) the in-session `run`/`documents` above belong to.
  // Set whenever a run is started or a review opened — from MatterHome
  // directly, or from the Library via `MatterPickerModal` (Important 3: a
  // Library run used to stay session-only with this left `null`; every run
  // is matter-scoped now, so in practice this is non-null whenever `run`
  // is). Drives whether completing/cancelling/retrying a run persists a
  // Review, and — together with `deletedMatterIdsRef` below — whether a
  // pending write is still allowed to land.
  const [activeMatterId, setActiveMatterId] = useState<string | null>(null);
  // Important 2: a matter delete must not be silently undone by a write
  // still in flight for it. `handleStartRun` captures its own `matterId`
  // in a local closure that outlives any later change to `activeMatterId`
  // state (the run keeps going, and stays reachable via "Current run", even
  // after the user navigates elsewhere) — so clearing `activeMatterId`
  // alone cannot stop it. Every write site that persists a Review or adds a
  // Document (`handleStartRun`'s `handleUpdate`/`persistFinal`, and
  // `handleRetryCell`) checks this set before writing; `handleDeleteMatter`
  // adds to it the moment `deleteMatter` resolves, before anything else.
  const deletedMatterIdsRef = useRef<Set<string>>(new Set());
  // `activeRunSaverRef` — the debounced whole-review saver backing an
  // in-flight run — is GONE with Task 18. The server writes every finding
  // now, so there is nothing for a mid-run whole-review save to carry, and
  // with it goes the armed-timer problem this ref existed to solve: a fired
  // timer sending a write it captured before its matter was deleted.
  // RunPanel seeds its own upload-list state from `initialDocuments` only
  // on mount (a plain useState initializer, not synced on prop changes) —
  // bumping this key on every entry into the run flow forces a fresh mount,
  // so a second "Run a review" (a different matter, or the same one after
  // adding more documents) doesn't show a stale panel left over from the
  // previous run.
  const [runPanelKey, setRunPanelKey] = useState(0);
  // This first read PURGES any OpenRouter key an earlier version of the app
  // stored, and `storage.ts` explains why that is the one deliberate
  // deletion in this project. The notice is raised from
  // `apiKeyWasPurgedThisSession()` rather than from this initializer's own
  // `purgedApiKey`, because React StrictMode invokes a `useState`
  // initializer twice and the second call — by then reading a blob with no
  // key in it — correctly reports `false`. Losing the one notice about a
  // live credential to a dev-mode double-invoke is not a trade worth making.
  // The initializer's RETURN VALUE is no longer read into `settings` below —
  // Task 18 moved every field `Settings` had to `WorkspaceSettings`, fetched
  // from the server — but the CALL still has to happen, because purging a
  // leftover `apiKey` (Stage 1's DoD) is this call's side effect, not its
  // result.
  useState(() => loadSettings());
  const [keyPurgeNoticeDismissed, setKeyPurgeNoticeDismissed] = useState(false);
  /**
   * §6.6 (Task 18): the model choice and its concurrency limit are workspace
   * configuration now, fetched from `GET /v1/workspace/settings` rather
   * than read out of `localStorage` on the very first render. The zeroed
   * default below is deliberately NOT "configured" — `isConfigured` reads
   * `modelChoiceId`, and an empty string there is the same "nothing chosen
   * yet" state a fresh `Settings` blob used to start in.
   *
   * It is NOT what a FAILED fetch leaves behind, though; `settingsLoadError`
   * below is. An empty `modelChoiceId` reached by a 503 is a load failure
   * wearing a legitimate empty state — this project's founding defect, one
   * transport out — and it is worse than the usual shape of that, because
   * the sentence it produces ("Choose a model in Settings") sends a
   * reviewer to a screen that fetches independently, usually succeeds, and
   * tells them a model IS configured and is an administrator's to change.
   */
  const [settings, setSettings] = useState<WorkspaceSettings>({
    modelChoiceId: '', concurrency: 5, version: 0, updatedAt: 0,
  });
  /**
   * The third state, beside "configured" and "not configured": the workspace
   * settings could not be READ, so nothing is known about what is chosen.
   *
   * The same argument `RoleState` makes about a permission ("a default role
   * would be a permission GRANTED by a loading state"), applied to a model
   * choice. Classified through `describeLoadError` like every other load
   * path in this file, and rendered through `LoadErrorPanel` with a working
   * Retry — the one route this codebase permits for "empty versus broken".
   */
  const [settingsLoadError, setSettingsLoadError] = useState<string | null>(null);
  const { notify, toast } = useToast();

  /**
   * Task 18: the one fetch that replaces `loadSettings().settings` for
   * everything that moved to `WorkspaceSettings`.
   *
   * A failure here is a LOAD FAILURE with its own state and its own Retry,
   * never a quiet fall-through to `modelChoiceId: ''`. It was the latter,
   * and one 503 / 502 / network blip / expired-token race on this single
   * boot-time request then refused every run, every drafted playbook and
   * every redline session for the rest of the tab's life with "Choose a
   * model in Settings to get started." — a specific, wrong reason, pointing
   * at a screen that contradicts it and that a reviewer has no permission to
   * change anyway. Nothing retried it: this effect runs once, and the
   * capability cross-reference effect returns immediately while
   * `modelChoiceId` is `''`.
   */
  const loadWorkspaceSettings = useCallback(() => {
    setSettingsLoadError(null);
    return getWorkspaceSettings()
      .then(ws => { setSettings(prev => ({ ...prev, ...ws })); })
      .catch((e: unknown) => {
        setSettingsLoadError(describeLoadError(
          e,
          "This workspace's model settings could not be read, so LexPrompt cannot tell which "
          + 'model reviews run on. Nothing has been changed. Try again.',
        ));
      });
  }, []);

  useEffect(() => {
    void loadWorkspaceSettings();
  }, [loadWorkspaceSettings]);

  /** A `service_misconfigured`-class failure (Task 23): shown "in place",
   *  wherever the user already is, and never routed to Settings — there is
   *  nothing there to fix it. Set by `handleModelError`'s default branch;
   *  cleared by the panel's own Retry. */
  const [serviceConfigError, setServiceConfigError] = useState<ModelError | null>(null);

  /**
   * Whether this browser is still holding data that has not been moved to
   * the server (Stage 2 §13.1), and what the banner should therefore say.
   *
   * `null` means "not asked yet" and renders nothing. Every other value —
   * INCLUDING the failure — renders. That asymmetry is the point: a local
   * database that will not open is precisely the situation `CLAUDE.md`'s
   * opening list names ("a failed storage migration rendering an empty
   * library, indistinguishable from a fresh install"), and hiding the banner
   * would be the app deciding on no evidence that there is nothing to move.
   *
   * `countLocalData` is the cheap read (`count` per store, not `getAll`), so
   * this costs one indexed count per store on a cold load rather than
   * pulling every document's extracted text into memory to answer a
   * yes/no question.
   */
  const [localData, setLocalData] = useState<LocalDataBannerState | null>(null);
  // `countLocalData()` is async and nothing cancels it, so its result can
  // arrive after this component is gone — a test file finishing, a sign-out.
  // Applying state then is a write to a component that no longer exists;
  // under jsdom it surfaces as `ReferenceError: window is not defined` from
  // React's own `dispatchSetState`, AFTER the environment has been torn
  // down, which makes the suite exit 1 with every test reporting PASSED.
  // The migration gate below carries the same guard for the same reason —
  // and this is the second time this project has paid for its absence.
  const localDataLive = useRef(true);
  useEffect(() => () => { localDataLive.current = false; }, []);
  const loadLocalDataPresence = useCallback(() => {
    countLocalData().then(
      ({ total, unreadable }) => {
        if (!localDataLive.current) return;
        // A COMPLETE upload changes what the banner says; it does not remove
        // it (§13.1, Task 23). The copy is still in this browser — nothing
        // was deleted — and a banner that vanished would be a person who
        // never learns that. Checked before the counts, because after a
        // complete run those counts describe a copy, not a backlog.
        if (total > 0 && wasUploadComplete()) {
          setLocalData({ kind: 'moved' });
        } else if (unreadable.length > 0) {
          setLocalData({
            kind: 'partial',
            total,
            message: unreadable.map(store => STORE_LABELS[store].many).join(', '),
          });
        } else if (total > 0) {
          setLocalData({ kind: 'present', total });
        } else {
          setLocalData(null);
        }
      },
      (e: unknown) => {
        if (!localDataLive.current) return;
        setLocalData({
          kind: 'unknown',
          message: describeLoadError(e, 'Reload the page to try again.'),
        });
      },
    );
  }, []);
  useEffect(() => { loadLocalDataPresence(); }, [loadLocalDataPresence]);

  /**
   * The `modelChoiceId` the last successful allowlist read could not find,
   * or `null`.
   *
   * Stored as the ID rather than as a boolean so that choosing a new model
   * cannot leave a stale `true` behind: `isConfigured` compares the current
   * choice against this one, so a fresh pick is not stale by construction
   * and needs no reset. A FAILED read never writes here — a network blip is
   * not evidence that a model was retired, and treating it as such would
   * lock a working user out of their own review.
   */
  const [staleModelChoiceId, setStaleModelChoiceId] = useState<string | null>(null);

  // Render-time profile, for `authorInitials` (a note's placeholder needs a
  // value to render with, and an `await` can't supply one). Write handlers
  // (`handleVerify`, `handleAddNote`, etc.) keep using their own
  // `await getProfile()` — a write must never trust a value that could be
  // null for one frame, but display can tolerate exactly that.
  const [profile, setProfile] = useState<UserProfile | null>(null);
  useEffect(() => {
    getProfile().then(setProfile).catch(() => { /* display-only; initials falls back to 'ME' */ });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * THE WORKSPACE'S PEOPLE, for every attribution line on screen (§6.3).
   *
   * Loaded once, beside the profile above, and for the same reason: a card
   * has to say WHO set the state it is showing, and the `byUserId` on a
   * disposition is a foreign key rather than a name. `userName` reads a
   * module cache, so the load needs a state change to bring the names onto
   * a screen already rendered — see `moduleCacheEpoch` below.
   *
   * A FAILURE IS SWALLOWED HERE ON PURPOSE, and it is not the "empty is not
   * broken" rule being broken. `loadDirectory` rejects and stays unloaded
   * rather than caching an empty directory, so `userName` goes on answering
   * `undefined` and every actor renders as *"someone this workspace does not
   * name"* — a true sentence, not an invented name and not a blank. The
   * alternative, blocking the review screen on a directory fetch, would make
   * a name the precondition for reading a contract.
   */
  /**
   * A COUNTER THAT EXISTS ONLY TO RE-RENDER WHEN A MODULE CACHE MOVES.
   *
   * Two of them move outside React: the workspace directory above
   * (`users.ts`), and the last-seen disposition (`findings.ts`, written by
   * `rememberConflict` when a 409 tells this browser what actually won).
   * Neither is React state, so a screen already rendered would go on showing
   * what it read before.
   *
   * It was called `directoryLoads`, documented as *"how many times the
   * directory loaded — that is all `directoryLoads` is"*, and then bumped by
   * a disposition conflict as well. Harmless behaviourally and a name that
   * had stopped being true: the next reader would have taken a count of
   * conflicts for a count of directory loads. Renamed rather than given a
   * second counter, because there is one thing being expressed — *"something
   * a render reads has changed underneath it"*.
   */
  const [moduleCacheEpoch, bumpModuleCache] = useState(0);
  useEffect(() => {
    loadDirectory()
      .then(() => bumpModuleCache(n => n + 1))
      .catch(() => { /* names stay unresolved, and the label says so */ });
  }, []);

  /**
   * How a card turns a user id into a name and an instant into a time.
   *
   * Rebuilt when the directory arrives so a card rendered before it lands
   * re-renders with the names in it. It can only RESOLVE an id — it cannot
   * supply one, which is what keeps "the card names an actor because a
   * disposition says so" true no matter what this object holds.
   */
  const audience = useMemo(
    () => ({ nameOf: userName, initialsOf: userInitials, timeOf: formatInstant }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [moduleCacheEpoch]);

  /** The disposition the server last reported for one cell of the open
   *  review — `undefined` until this browser has read it, which the card
   *  renders as "not read" rather than as "not checked". */
  const dispositionOf = (findingsKey: string, clauseId: string) =>
    (run ? dispositionFor(run.id, findingsKey, clauseId) : undefined);

  /**
   * WHAT AN EXPORT NEEDS IN ORDER TO SAY WHEN IT WAS TRUE (section 6.3.1).
   *
   * Assembled here because this is the only place all three facts are in
   * hand at once, and assembled as ONE object because they are one fact:
   * what the server said about this review's judgements, and when. A caller
   * able to supply two of the three would be a caller able to stamp an
   * instant onto dispositions it did not read.
   *
   * `readAt` comes from the module that performed the read, never from
   * `Date.now()` here: those differ, and the second is a claim the document
   * cannot support — it would date the moment the file was written rather
   * than the moment the dispositions were true.
   *
   * The time zone is the browser's own, resolved rather than assumed, and
   * NAMED in the stamp so a report read in another office knows which clock
   * the instant is on.
   */
  const exportContext = useMemo(() => ({
    readAt: run ? dispositionsReadAt(run.id) : undefined,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    dispositionOf,
    audience,
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [run, audience]);

  // --- Sub-project E: authoring a new playbook ---------------------------
  //
  // `Create Template` opens the ROUTE CHOOSER (spec §6), which is the only
  // way into any of these screens. Everything below is session state and
  // nothing here is ever written to IndexedDB or localStorage: the draft
  // becomes durable at exactly one moment, when `saveDraftAsV1` publishes
  // it as v1 through D's atomic path. R-E1 is the reason — a half-reviewed
  // model draft that survived a reload would be a playbook nobody agreed
  // to, presented as one they did.
  const [chooserOpen, setChooserOpen] = useState(false);
  const [authoringDraft, setAuthoringDraft] = useState<AuthoringDraft | null>(null);
  /**
   * The authoring draft as it stands RIGHT NOW, updated synchronously by
   * `updateAuthoringDraft` below.
   *
   * Integrity review (D/E), Major 4. `handleSaveDraftAsV1` read
   * `authoringDraft` from its own render closure, awaited `getProfile()`,
   * and published that captured value. Anything the reviewer decided in the
   * meantime — and, once `DraftReview` began committing typed edits on its
   * way into the save, the edit that triggered the save itself — updated
   * React state and never reached the version; `setAuthoringDraft(null)` on
   * success then destroyed it, and the draft exists only in memory (R-E1),
   * so it was unrecoverable. This is the same shape as `latestRunRef`, and
   * it is here for the same reason: a value read across an await has to come
   * from somewhere that a render has not frozen.
   */
  const authoringDraftRef = useRef<AuthoringDraft | null>(null);
  /**
   * The in-flight draft generation, so it can be abandoned when its screen
   * is.
   *
   * Integrity review (D/E), Major 5. A generation belongs to the authoring
   * flow and to nothing else; before this it outlived it. Leaving the
   * authoring views now aborts the request — the user is not billed for a
   * draft nobody will see — and the resolve path checks the same signal, so
   * a provider that ignores an abort still cannot deliver a draft onto a
   * screen the user has left.
   */
  const authoringGenerationRef = useRef<AbortController | null>(null);
  /** The ONLY writer of the authoring draft. Ref first, so a handler
   *  already mid-await sees the change on its next read rather than on the
   *  next render. */
  const updateAuthoringDraft = (next: AuthoringDraft | null) => {
    authoringDraftRef.current = next;
    setAuthoringDraft(next);
  };
  const [authoringBusy, setAuthoringBusy] = useState(false);
  const [authoringError, setAuthoringError] = useState<string | undefined>(undefined);
  const [authoringAuthFailed, setAuthoringAuthFailed] = useState(false);
  const [savingAuthoringDraft, setSavingAuthoringDraft] = useState(false);
  const [megaPromptOpen, setMegaPromptOpen] = useState(false);
  const [publishOpen, setPublishOpen] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [importing, setImporting] = useState(false);

  // --- Sub-project F: learning from redlines (Task 10A wiring) -----------
  //
  // The SESSION here is session-only, per R-F6 (mirrors E's
  // `AuthoringDraft`, which this session hands off to). **The DOCUMENTS are
  // not, and that changed in Stage 2** — this comment used to say a
  // precedent document's `File` and edits "die with the tab, never reaching
  // blob storage — spec §4/§11's 'read once, never stored' promise", and
  // the server design's §11.1 supersedes that: `handleAddRedlinesFiles`
  // uploads every file to a precedent set on the firm's own service, and
  // the intake screen says so. A stale comment is how a true statement gets
  // restored by a well-meaning refactor, which is why this paragraph is here
  // rather than deleted.
  //
  // What is still session-only: the parsed edits, the live `File`, the roles
  // and chains a person confirms, the positions inferred from them, and the
  // `AuthoringDraft` they become. `redlinesDocs` is the thin,
  // serialisable-looking half of that state (`PrecedentDocument[]` — no
  // `File`, no edit text) that actually drives `PrecedentIntake`'s render;
  // `redlinesFilesRef` is the other half, keyed by the same `id` — which is
  // ALSO the stored precedent document's id, so a position's basis still
  // resolves to a real document a year later (§11.1, `position_basis`).
  const [redlinesDocs, setRedlinesDocs] = useState<PrecedentDocument[]>([]);
  const [redlinesUnreadable, setRedlinesUnreadable] = useState<UnreadableDocument[]>([]);
  /** One entry per document brought in: its live `File` (held for the
   *  session; its BYTES are also uploaded, see above), the text
   *  `pdfRedlineDiff` needs for the diff fallback, the
   *  edits actually read from it (tracked-change or diff-derived), and which
   *  of the two `source` they are. A `useRef`, not `useState`: a `File` is
   *  exactly the kind of per-session-only value `AuthoringDraft`'s own
   *  ref/ref-writer pattern exists for (see `authoringDraftRef`) — nothing
   *  here needs to trigger a re-render on its own, `redlinesDocs`/
   *  `redlinesPositions` already do that whenever the derived, renderable
   *  state actually changes. */
  const redlinesFilesRef = useRef<Map<string, {
    file: File; text: string; edits: ParsedEdit[]; source: 'tracked' | 'diff';
  }>>(new Map());
  const [redlinesBusy, setRedlinesBusy] = useState(false);
  const [redlinesError, setRedlinesError] = useState<string | undefined>(undefined);
  const [redlinesPositions, setRedlinesPositions] = useState<InferredPosition[]>([]);
  const [redlinesQuestions, setRedlinesQuestions] = useState<OpenQuestion[]>([]);
  const [redlinesWorkingsPosition, setRedlinesWorkingsPosition] = useState<InferredPosition | null>(null);
  /** The stored-basis panel opened from the PLAYBOOK EDITOR (§6.5), which is
   *  a different screen from the redlines session's own workings and holds
   *  no session state at all. */
  const [storedWorkings, setStoredWorkings] = useState<
    { position: InferredPosition; stored: StoredBasis } | null>(null);
  /** Ruling on a gap Task 10A-fix left open (R-F-fix-1): every redlines
   *  playbook was named with the constant `REDLINES_DRAFT_NAME`, which is
   *  unusable the second the flow runs twice — two identically-named
   *  playbooks, neither saying what contract they are for. Collected on
   *  `PrecedentIntake` (beside the documents, mirroring E's `DraftForm`,
   *  which asks the same question before it drafts anything) and carried
   *  through the session; `handleRedlinesToDraftReview` is where it is
   *  actually required, not here — intake itself must not trap someone who
   *  has not decided on a name yet. */
  const [redlinesContractType, setRedlinesContractType] = useState('');
  /** The `PrecedentSet` this session's documents are stored in (§11.1),
   *  created lazily on the first batch of files and NOT cleared when the
   *  session ends: the set outlives the tab, exactly as its documents do,
   *  and deleting it is a retention decision rather than a side effect of
   *  navigating away. A `useRef` because `handleAddRedlinesFiles` reads it
   *  synchronously within one call and nothing renders it. */
  const redlinesSetIdRef = useRef<string | undefined>(undefined);
  // No playbook, no version and no changeset state here on purpose. This
  // session mints NOTHING: `handleRedlinesToDraftReview` converts the
  // adopted positions into E's `AuthoringDraft` and hands over, and the
  // first and only durable write in the whole flow is `saveDraftAsV1`'s
  // single `publishAndPoint` transaction after a person has cleared E's
  // save gate. (Task 10A minted a playbook and published an empty v1 here
  // so there was a live version for `buildChangeset` to read — a version
  // recording a state the playbook was never in, and an orphaned playbook
  // whenever the flow was abandoned. See `positionsToDraft.ts`.)

  // Important 3: running a playbook from the Library now goes through this
  // picker instead of straight into the run panel, since every review is
  // matter-scoped — `matterPickerTemplate` is the playbook awaiting a
  // matter choice, `null` whenever the picker is closed.
  const [matterPickerOpen, setMatterPickerOpen] = useState(false);
  const [matterPickerTemplate, setMatterPickerTemplate] = useState<PlaybookVersion | null>(null);

  // Tracks the template as last saved (or as last opened/generated) so the
  // editor can tell whether there are unsaved changes worth warning about
  // before they're discarded (Important 7). `null` means "nothing to
  // compare against" — an editor with no template open, or a freshly
  // generated/created one that has never been saved and so is unsaved by
  // definition, even before the user touches anything: closing it right
  // after a ~30s paid AI generation is exactly the loss this guards.
  const [savedTemplateSnapshot, setSavedTemplateSnapshot] = useState<string | null>(null);
  const [savingDraft, setSavingDraft] = useState(false);
  const isTemplateDirty =
    view === 'editor' && activeDraft !== null &&
    (savedTemplateSnapshot === null || JSON.stringify(activeDraft) !== savedTemplateSnapshot);

  /** What the editor is showing — the draft when there are unpublished
   *  edits, otherwise an editable copy of the published version. Goes
   *  through `workingContent`, the editor's own function, rather than
   *  repeating the coalesce here: two copies of it is the sibling drift
   *  CLAUDE.md names, and this one would be the copy that silently handed
   *  Export a different thing from what is on screen. `null` — neither a
   *  version nor a draft — is the "no playbook open" state. */
  const editorContent = useMemo<PlaybookDraft | null>(
    () => (activeDraft || activeVersion
      ? workingContent(activeVersion ?? undefined, activeDraft ?? undefined)
      : null),
    [activeDraft, activeVersion],
  );

  /** Important 1: derived at render, not marked on load — see the doc
   *  comment where this is consumed, next to `RunInterruptedBanner`, for
   *  why deriving from `isRunning` (already unambiguous) is enough and
   *  needs no separate stored flag. */
  const isInterrupted = !isRunning && !!run && !run.completedAt && !run.cancelledAt;

  // Guards against re-showing the "your key was rejected" prompt for every
  // remaining clause in a run once the first one hits a 401/403 — reset
  // whenever a new run starts.
  const authErrorHandledRef = useRef(false);

  // No key half any more: the browser holds no provider credential. The
  // signed-in half of "configured" is not checked here because it cannot be
  // false — `App` renders `SignInScreen` INSTEAD OF this whole shell for
  // every auth status but `signed-in`, so re-deriving it here would add a
  // second source of truth for a question already settled one component up.
  const isConfigured = Boolean(settings.modelChoiceId)
    && settings.modelChoiceId !== staleModelChoiceId;

  // Set only by the initial load below — a failure here must never resolve
  // to an empty library (indistinguishable from "you have no playbooks");
  // it has to be its own visible state with a way back in. The post-action
  // refreshes after save/delete/import intentionally do NOT touch this: a
  // refresh failing right after a successful save is reported through that
  // action's own toast instead (see handlePublishTemplate etc.), not routed
  // through this banner.
  const [libraryLoadError, setLibraryLoadError] = useState<string | null>(null);

  const refreshTemplates = () => listTemplates().then(setTemplates);

  const loadLibrary = () => {
    setLibraryLoadError(null);
    return refreshTemplates().catch((e) => {
      // DbBlockedError's own message already tells the user exactly what's
      // wrong (another tab has the DB open) and how to fix it; anything
      // else is an opaque IndexedDB failure the user can't diagnose, so it
      // gets a generic message plus a Retry action instead — see
      // `describeLoadError` (Important 4).
      setLibraryLoadError(describeLoadError(e, 'The playbook library could not be loaded. Try again.'));
    });
  };

  useEffect(() => {
    loadLibrary();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Mirrors `libraryLoadError` above (same Critical fix, applied to the new
  // entry point): a failure loading matters must render its own visible
  // error branch instead of the list, never fall back to an empty "no
  // matters" state, which would be indistinguishable from a user who
  // genuinely has none yet.
  const [mattersLoadError, setMattersLoadError] = useState<string | null>(null);

  const refreshMatters = async () => {
    const list = await listMatters();
    // Review counts are a nice-to-have, not load-bearing: if they fail to
    // fetch (e.g. the reviews store errors independently of the matters
    // store), the matters list itself must still render — so failures here
    // are swallowed and just leave every count omitted, rather than routing
    // through mattersLoadError and hiding matters that loaded just fine.
    let counts: Record<string, number> = {};
    try {
      const perMatter = await Promise.all(list.map(m => listReviews(m.id)));
      counts = Object.fromEntries(list.map((m, i) => [m.id, perMatter[i].length]));
    } catch {
      counts = {};
    }
    setMatters(list.map(matter => ({ matter, reviewCount: counts[matter.id] })));
  };

  const loadMatters = () => {
    setMattersLoadError(null);
    return refreshMatters().catch((e) => {
      setMattersLoadError(describeLoadError(e, 'The matters list could not be loaded. Try again.'));
    });
  };

  useEffect(() => {
    loadMatters();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- Standard positions (sub-project G, Task 20) ------------------------
  //
  // "Which of our house rules are drifting?" — no new data, no new writes,
  // no model call (R-G18). `buildPositionRows` is pure; everything here is
  // just gathering what it needs to read: every playbook's identity plus
  // its published versions, and every review from every matter (health is
  // only visible across matters, per `buildPositionHealthMap`'s own doc
  // comment).
  // `undefined`, not `[]`: before the first read there is no answer to give,
  // and `[]` is an answer — "this firm has no standard positions". The view
  // renders a loading branch for `undefined` and the empty state only for a
  // read that finished and found nothing.
  const [positionRows, setPositionRows] = useState<PositionRow[] | undefined>(undefined);
  const [positionsError, setPositionsError] = useState<string | null>(null);

  const loadPositions = () => {
    setPositionsError(null);
    return (async () => {
      const playbooks = await listTemplates();
      const withVersions = await Promise.all(
        playbooks.map(async (playbook) => ({ playbook, versions: await listVersions(playbook.id) })),
      );
      const matterList = await listMatters();
      const perMatterReviews = await Promise.all(matterList.map(m => listReviews(m.id)));
      const reviews = perMatterReviews.flat();
      setPositionRows(buildPositionRows({ playbooks: withVersions, reviews }));
    })().catch((e) => {
      // Leaves `positionRows` untouched on failure — never resets it to
      // `[]`, which would render the "no standard positions yet" empty
      // state over what is actually a failed read (CLAUDE.md's founding
      // defect, one level up).
      setPositionsError(describeLoadError(e, 'Your standard positions could not be loaded. Try again.'));
    });
  };

  useEffect(() => {
    if (view === 'positions') loadPositions();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view]);

  // --- Matter home (Task 11) ---------------------------------------------

  const [matter, setMatter] = useState<Matter | null>(null);
  // Distinguishes "the matter genuinely doesn't exist" (deleted, bad link)
  // from "the load itself failed" — the two need different UI: a not-found
  // message with a way back, versus an error with a retry.
  const [matterNotFound, setMatterNotFound] = useState(false);
  const [matterError, setMatterError] = useState<string | null>(null);

  const [matterDocuments, setMatterDocuments] = useState<DocumentRecord[]>([]);
  const [matterDocumentsError, setMatterDocumentsError] = useState<string | null>(null);

  // Task 7: this matter's collections, loaded and errored independently of
  // documents/reviews — the same reasoning `loadMatterHome`'s own comment
  // gives for those two: one failing must never hide either of the others
  // having loaded fine.
  const [matterCollections, setMatterCollections] = useState<Collection[]>([]);
  const [matterCollectionsError, setMatterCollectionsError] = useState<string | null>(null);

  const [matterReviews, setMatterReviews] = useState<Review[]>([]);
  const [matterReviewsError, setMatterReviewsError] = useState<string | null>(null);

  const loadMatterDocuments = (matterId: string) => {
    setMatterDocumentsError(null);
    return listDocuments(matterId).then(setMatterDocuments).catch((e) => {
      setMatterDocumentsError(describeLoadError(e, 'The documents in this matter could not be loaded. Try again.'));
    });
  };

  /**
   * WHILE ANYTHING IS STILL BEING READ, KEEP ASKING — AND STOP WHEN NOTHING
   * IS.
   *
   * An upload returns before the text exists (Task 9): the bytes are stored,
   * the row is `pending`, and a parse worker reads them a moment later.
   * Without this the matter screen keeps saying "Still being read" until
   * somebody reloads the page, and the document stays un-reviewable on
   * screen long after it is ready — a screen that has quietly stopped
   * updating, which is the same failure as a run that stops reporting.
   *
   * NOT A PERMANENT POLL. It is armed only by a `pending` document being on
   * screen and it disarms the moment none is, so a tab left open on a matter
   * does not talk to the server forever. `matterDocuments` is the dependency,
   * so each answer re-evaluates the condition — one more read after the last
   * document lands, and then silence.
   *
   * A failed read is NOT retried here. `listDocuments` failing sets
   * `matterDocumentsError`, which the screen already renders instead of the
   * list; polling through an error would replace a load error a person can
   * act on with a spinner that never resolves.
   */
  useEffect(() => {
    if (view !== 'matter' || !matter) return undefined;
    if (!matterDocuments.some(isNotYetRead)) return undefined;
    const matterId = matter.id;
    const timer = setTimeout(() => { void loadMatterDocuments(matterId); }, PARSE_POLL_MS);
    return () => { clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, matter, matterDocuments]);

  /**
   * "Read it again" on a document whose parse FAILED.
   *
   * The bytes are still stored, so a parse that failed for a reason that is
   * not a property of the file is recoverable without deleting the document
   * and adding the same file again — which loses its id, and with it its
   * collection membership and its place in every review that names it.
   *
   * `await-then-apply`: the list is re-read only after the store confirms
   * the write, never optimistically. The poll above then takes over,
   * because the row it comes back with is `pending`.
   */
  const handleReparseDocument = async (matterId: string, documentId: string) => {
    try {
      await reparseDocument(documentId);
      await loadMatterDocuments(matterId);
    } catch (e) {
      notify(
        e instanceof Error ? `That document could not be read again: ${e.message}`
          : 'That document could not be read again.',
        'error',
      );
    }
  };

  const loadMatterCollections = (matterId: string) => {
    setMatterCollectionsError(null);
    return listCollections(matterId).then(setMatterCollections).catch((e) => {
      setMatterCollectionsError(describeLoadError(e, 'The collections in this matter could not be loaded. Try again.'));
    });
  };

  const loadMatterReviews = (matterId: string) => {
    setMatterReviewsError(null);
    return listReviews(matterId).then(setMatterReviews).catch((e) => {
      setMatterReviewsError(describeLoadError(e, 'The reviews in this matter could not be loaded. Try again.'));
    });
  };

  // Loads the matter itself, then its documents and reviews independently
  // (mirrors `refreshMatters`'s per-matter review-count fetch): a documents
  // failure must not hide a reviews list that loaded fine, and vice versa.
  const loadMatterHome = (matterId: string) => {
    setMatterError(null);
    setMatterNotFound(false);
    return getMatter(matterId).then((m) => {
      if (!m) {
        setMatterNotFound(true);
        return;
      }
      setMatter(m);
      loadMatterDocuments(matterId);
      loadMatterCollections(matterId);
      loadMatterReviews(matterId);
    }).catch((e) => {
      setMatterError(describeLoadError(e, 'This matter could not be loaded. Try again.'));
    });
  };

  const matterRouteId = route.name === 'matter' ? route.matterId : null;
  useEffect(() => {
    if (matterRouteId) loadMatterHome(matterRouteId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matterRouteId]);

  // --- Opening a persisted review (Task 11) -------------------------------
  //
  // Reopens a completed (or in-progress, or cancelled) review from
  // IndexedDB into the same `run`/`documents` state a live run uses, so it
  // renders through the existing ResultsView/TabularReview screens rather
  // than a second, parallel implementation. Fires both from clicking a
  // review row in MatterHome and from a cold load of
  // `/matters/:matterId/reviews/:reviewId` (spec definition-of-done #6).
  const [reviewLoading, setReviewLoading] = useState(false);
  // A review whose documents were since deleted must still open (spec §9)
  // — this error state is for the review itself failing to load (not
  // found, or a genuine DB failure), which is a different, screen-blocking
  // condition from a per-document viewer being unavailable.
  const [reviewLoadError, setReviewLoadError] = useState<string | null>(null);

  const openReview = async (matterId: string, reviewId: string) => {
    setReviewLoadError(null);
    setReviewLoading(true);
    // Task 10 / R-D15: reset to "not resolved yet" for the run about to load
    // — carrying the PREVIOUS review's resolved version across would let a
    // stale "Ran against v2" (or "deleted") flash for this one before its
    // own lookup below settles.
    setRunPlaybookVersion(undefined);
    try {
      const review = await getReview(reviewId);
      if (!review) {
        setReviewLoadError('This review could not be found. It may have been deleted.');
        return;
      }
      const hydratedDocs = await Promise.all(review.documentIds.map(async (id) => {
        const record = await getDocument(id);
        if (!record) {
          // The document itself was deleted from the matter — the review's
          // findings are still real work and must still open (spec §9);
          // only the viewer for this one document is unavailable.
          return {
            id,
            name: 'Deleted document',
            text: '',
            file: new File([], 'deleted'),
            kind: 'txt' as const,
            parseError: 'This document was removed from the matter, so it can no longer be viewed. Its findings are shown below.',
          } satisfies DocumentFile;
        }
        const blob = await getDocumentBlob(id);
        return documentFileForViewing(record, blob);
      }));
      // Task 8A: reconstruct what a retry needs to re-run a collection
      // clause through the collection extractor — the `Collection` record
      // itself is not part of a `Review`, so it has to be fetched
      // separately. Failing to load it (deleted collection, a DB error)
      // must not block the review from opening at all — its findings are
      // still real work (spec §9's reasoning, applied one level up) — it
      // only means `handleRetryCell` will refuse a retry on this review
      // rather than silently re-running a collection clause as a
      // single-document one.
      if (isCollectionTarget(review.target)) {
        try {
          const collectionRecord = await getCollection(review.target.collectionId);
          activeCollectionRef.current = collectionRecord
            ? { target: review.target, members: orderedMembers(collectionRecord, hydratedDocs) }
            : null;
          // `null` here is not a failure to read — the read succeeded and the
          // collection is not there, i.e. it was ungrouped or deleted.
          collectionUnavailableRef.current = collectionRecord ? null : 'missing';
        } catch {
          activeCollectionRef.current = null;
          collectionUnavailableRef.current = 'error';
        }
      } else {
        activeCollectionRef.current = null;
        collectionUnavailableRef.current = null;
      }
      const reviewRun: ReviewRun = {
        id: review.id,
        templateSnapshot: review.playbookSnapshot,
        documentIds: review.documentIds,
        // `getReview` funnels every read through `migrateReviewRecord`, so
        // `review.target` is always present and its `documentIds` always
        // agree with `review.documentIds` (ruling F-C1) — carried through
        // unchanged so a reopened collection review still keys its cells,
        // and any future retry, by the collection rather than by document.
        target: review.target,
        findings: review.findings,
        startedAt: review.startedAt,
        completedAt: review.completedAt,
        cancelledAt: review.cancelledAt,
        // Task 10: carried through UNCHANGED from the stored review — dangle
        // and all (R-D15). Never derived from `review.playbookSnapshot.id`:
        // that would restate the migration's own back-fill by a different,
        // untested route the moment this run gets re-saved.
        ...(review.playbookVersionId ? { playbookVersionId: review.playbookVersionId } : {}),
      };
      // Task 10 / R-D15: resolve against the LIVE playbookVersions store, not
      // the review's own frozen `playbookSnapshot` — a snapshot's content
      // survives its playbook being deleted, but the live version record
      // does not (Task 3's cascade), and this is what tells the header
      // whether Version History still has anywhere to send the reader. No
      // id at all resolves to `null` without a lookup (there is nothing to
      // look up); a lookup that itself throws resolves to `'error'`, NOT
      // `undefined` — `undefined` is the "not resolved yet" state
      // `ResultsView` renders as silence, and a caught `getVersion` failure
      // is a SETTLED outcome, not an in-flight one. Collapsing the two used
      // to hide a real read failure as if the header simply had nothing to
      // say; `'error'` renders its own loud line instead
      // (`ReviewVersionLine`'s `lookupFailed`) rather than reusing "deleted",
      // a specific claim this catch has no evidence for.
      let resolvedVersion: PlaybookVersion | null | undefined | 'error' = review.playbookVersionId
        ? undefined
        : null;
      if (review.playbookVersionId) {
        try {
          resolvedVersion = await getVersion(review.playbookVersionId);
        } catch {
          resolvedVersion = 'error';
        }
      }
      setRunPlaybookVersion(resolvedVersion);
      setActiveTemplate(review.playbookSnapshot);
      setActiveMatterId(matterId);
      setDocuments(hydratedDocs);
      // A reopened review can already contain an `authError` finding from
      // whatever run originally produced it — that's history, not a fresh
      // rejection happening right now, so it must not trip the "your key
      // was rejected" redirect below (which exists to react to a NEW auth
      // error while a run is actually in flight). Marking it as already
      // "handled" suppresses that for this stale data; `handleRetryCell`
      // resets it back to `false` before any retry, so a genuinely new
      // auth error from retrying a cell in this same review still redirects.
      authErrorHandledRef.current = true;
      createdByUserIdRef.current = review.createdByUserId;
      latestRunRef.current = reviewRun;
      setRun(reviewRun);
      setIsRunning(false);

      // A RUN STARTED IN ANOTHER TAB, OR BEFORE A RELOAD, IS FINDABLE (Task
      // 18). A run used to live in React state and die with the tab; it is a
      // row now, so opening a review ASKS whether one is live and resumes
      // watching it. This is new behaviour and it is the point of the stage.
      //
      // A failure to ask does NOT fail the open: the findings are real work
      // and the review must still be readable. It is reported, because a
      // review that is quietly running while the screen says it is idle is
      // the "a job that died looking like a job still working" failure
      // inverted — the reader would think nothing more is coming.
      stopWatching();
      runViewRef.current = null;
      try {
        const live = await liveRunFor(review.id);
        if (live) attachRun(live, matterId);
      } catch (e) {
        debug('could not ask whether this review has a live run', review.id, e);
        notify(
          'LexPrompt could not tell whether this review is still running. The findings below are '
          + 'what it has recorded so far; reload to check again.',
          'error',
        );
      }
    } catch (e) {
      setReviewLoadError(describeLoadError(e, 'This review could not be loaded. Try again.'));
    } finally {
      setReviewLoading(false);
    }
  };

  const reviewRouteKey = route.name === 'review' ? `${route.matterId}/${route.reviewId}` : null;
  useEffect(() => {
    if (route.name === 'review') openReview(route.matterId, route.reviewId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reviewRouteKey]);

  // The watch is a timer and an in-flight request; it has to stop when this
  // component goes away, or it keeps polling a run nobody is looking at and
  // keeps calling `setRun` on an unmounted tree. Deliberately a mount-only
  // effect with an empty dependency list: `attachRun` stops the previous
  // watch itself, so this is the LAST stop rather than one per render.
  useEffect(() => () => stopWatching(), []);

  // --- Opening the playbook editor by URL (Task 12) -----------------------
  //
  // Mirrors loadMatterHome/openReview above: a cold load (or a
  // browser-back/forward landing on) `/playbooks/:playbookId` must open
  // that exact playbook from IndexedDB rather than rendering a blank editor
  // or crashing, and a genuinely missing id gets its own honest not-found
  // state distinct from a load failure.
  const [playbookLoadError, setPlaybookLoadError] = useState<string | null>(null);
  const [playbookNotFound, setPlaybookNotFound] = useState(false);
  const [playbookLoading, setPlaybookLoading] = useState(false);

  // DoD #7. What a standard position has actually been tested against, read
  // from VERIFIED findings only. The raw inputs are held here and the map is
  // derived at render (`positionHealthMap`, below) so that editing a
  // position re-answers the question without another store read.
  //
  // The scan is CROSS-MATTER: `listReviews` is matter-scoped and a
  // playbook's positions are tested wherever it has been run. It therefore
  // gets its own error state — a failure must never resolve to an empty
  // list of reviews, which renders as `UNTESTED` and is a claim about the
  // firm's positions rather than about the app.
  const [healthVersions, setHealthVersions] = useState<PlaybookVersion[]>([]);
  const [healthReviews, setHealthReviews] = useState<Review[]>([]);
  const [healthLoaded, setHealthLoaded] = useState(false);
  const [healthError, setHealthError] = useState<string | null>(null);

  // Spec 8's "link to version history", opened from the editor. Its own
  // read and its own error state rather than reusing the health scan's
  // versions: that scan reports one error for versions AND reviews
  // together, so a reviews failure would leave this showing "nothing
  // published yet" over a playbook with four versions — the empty-versus-
  // broken confusion CLAUDE.md exists to stop.
  const [versionHistoryOpen, setVersionHistoryOpen] = useState(false);
  const [historyVersions, setHistoryVersions] = useState<PlaybookVersion[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  // Spec §8 / DoD #6: "the matters that used each" version. Cross-matter,
  // exactly like `loadPositionHealth` below (`listReviews` is matter-scoped)
  // — gathered here rather than shared with that scan's state so a reviews
  // failure here still reports through THIS screen's own error branch
  // rather than borrowing one that renders a different message.
  const [historyMatterNames, setHistoryMatterNames] = useState<Record<string, string[]>>({});

  // Minor 4: a fire-and-forget request-id guard, "latest request wins".
  // `playbookRouteId` can change again before this scan resolves (a fast
  // Back-then-click-another-card, or a re-import that lands on a fresh route
  // before the old one's IndexedDB awaits settle) — without this, whichever
  // of the two resolves LAST wins, even if it was requested first, and the
  // screen ends up showing one playbook's version history stitched onto
  // another's clauses. Each loader below owns its own counter so a stale
  // history scan can never be judged against a position-health request or
  // vice versa.
  const versionHistoryRequestRef = useRef(0);
  const loadVersionHistory = (playbookId: string) => {
    const requestId = ++versionHistoryRequestRef.current;
    setHistoryError(null);
    setHistoryLoading(true);
    // D3 (drift review): the cross-matter `listVersions`/`listMatters`/
    // `listReviews` sweep is shared with `loadPositionHealth` via
    // `scanPlaybookAcrossMatters` — see its docstring for why the two loaders
    // still keep their own error handling rather than sharing that too.
    return scanPlaybookAcrossMatters(playbookId)
      .then(({ versions, matters, reviewsByMatter }) => {
        if (versionHistoryRequestRef.current !== requestId) return; // superseded — discard
        const versionIds = new Set(versions.map(v => v.id));
        const names: Record<string, string[]> = {};
        for (const review of reviewsByMatter.flat()) {
          const versionId = review.playbookVersionId;
          if (versionId === undefined || !versionIds.has(versionId)) continue;
          const matterName = matters.find(m => m.id === review.matterId)?.name;
          if (!matterName) continue;
          const forVersion = (names[versionId] ??= []);
          if (!forVersion.includes(matterName)) forVersion.push(matterName);
        }
        setHistoryVersions(versions);
        setHistoryMatterNames(names);
      })
      .catch((e) => {
        if (versionHistoryRequestRef.current !== requestId) return; // superseded — discard
        setHistoryError(describeLoadError(e, "This playbook's versions could not be read. Try again."));
      })
      .finally(() => {
        if (versionHistoryRequestRef.current !== requestId) return; // superseded — its own request owns the spinner now
        setHistoryLoading(false);
      });
  };

  // Task 10: the review header's "ran against vN" link into this same
  // screen. Reuses the editor's `versionHistoryOpen` modal and
  // `loadVersionHistory` rather than a second implementation — navigating to
  // the playbook's own route first so `playbookRouteId` (which `onRetry`
  // above reads) is correct for this playbook, exactly as if the reader had
  // opened the editor and clicked "Version history" themselves.
  const handleShowVersionHistoryForRun = () => {
    const playbookId = run?.templateSnapshot.playbookId;
    if (!playbookId) return;
    navigate({ name: 'playbook', playbookId });
    setVersionHistoryOpen(true);
    loadVersionHistory(playbookId);
  };

  // Minor 4 — see `versionHistoryRequestRef` above for why each loader needs
  // its own "latest request wins" counter.
  const positionHealthRequestRef = useRef(0);
  const loadPositionHealth = (playbookId: string) => {
    const requestId = ++positionHealthRequestRef.current;
    setHealthError(null);
    setHealthLoaded(false);
    return scanPlaybookAcrossMatters(playbookId)
      .then(({ versions, reviewsByMatter }) => {
        if (positionHealthRequestRef.current !== requestId) return; // superseded — discard
        setHealthVersions(versions);
        setHealthReviews(reviewsByMatter.flat());
        setHealthLoaded(true);
      })
      .catch((e) => {
        if (positionHealthRequestRef.current !== requestId) return; // superseded — discard
        setHealthError(describeLoadError(
          e,
          'Your reviews could not be read, so position health is unknown. Try again.',
        ));
      });
  };

  // Minor 4 — see `versionHistoryRequestRef` above. This is the loader whose
  // staleness the review named worst: an unguarded resolve here does not
  // just show the wrong text, it can make `positionHealthMap` (built from
  // THIS playbook's clauses against the PREVIOUS playbook's versions and
  // reviews) report a false "HELD n of n" on a position that was never run.
  const playbookForEditRequestRef = useRef(0);
  const loadPlaybookForEdit = (id: string) => {
    const requestId = ++playbookForEditRequestRef.current;
    setPlaybookLoadError(null);
    setPlaybookNotFound(false);
    setPlaybookLoading(true);
    return getTemplate(id)
      .then(async (t) => {
        if (playbookForEditRequestRef.current !== requestId) return; // superseded — discard
        if (!t) {
          setPlaybookNotFound(true);
          return;
        }
        // The editor is handed the published version for reference and a
        // DRAFT only if there is one. A playbook that has never been
        // published gets a blank draft seeded from its identity's name —
        // there is nothing published for it to show, and everything in it
        // is by definition unpublished.
        const version = await getPlaybookContent(id);
        if (playbookForEditRequestRef.current !== requestId) return; // superseded — discard
        const draft = t.draft ?? (version ? null : newPlaybookDraft(t.name));
        setActivePlaybook(t);
        setActiveVersion(version);
        setActiveDraft(draft);
        // Clean on open either way: a stored draft has already been saved,
        // and a blank draft over a never-published playbook holds nothing
        // that closing would lose. Any edit from here replaces
        // `activeDraft` and makes this comparison fail, which is what marks
        // the editor dirty.
        //
        // Minor 6 (integrity review): snapshotting `draft` itself, rather
        // than what the editor actually DISPLAYS, broke this for a published
        // playbook with no stored draft — `draft` is `null` there, so this
        // used to record `JSON.stringify(null)`, the literal string "null",
        // as the baseline. The first keystroke replaces `activeDraft` with a
        // REAL draft object (`TemplateEditor`'s `updateDraft` always
        // produces one, never `null`), and `JSON.stringify` of a real object
        // can never again equal the string "null" — not even after the edit
        // is typed and undone back to the exact published content.
        // `isTemplateDirty` then latches true for the rest of the session,
        // "Save draft" stays enabled, and clicking it persists a
        // `Playbook.draft` that is content-identical to the published
        // version. The library's badge (`t.draft ? 'Unpublished changes' :
        // ...`) is keyed on the draft's mere PRESENCE, not its content, so it
        // shows from then on with no control left to clear it: the Discard
        // path is reachable only while `isTemplateDirty`, which THIS save
        // just made false. Snapshotting the same WORKING CONTENT the editor
        // renders (`workingContent` — the one function that coalesces
        // draft/version, shared with `TemplateEditor` and `editorContent`)
        // gives a baseline a genuine edit-and-undo can actually match again.
        setSavedTemplateSnapshot(JSON.stringify(workingContent(version ?? undefined, draft ?? undefined)));
      })
      .catch((e) => {
        if (playbookForEditRequestRef.current !== requestId) return; // superseded — discard
        setPlaybookLoadError(describeLoadError(e, 'This playbook could not be loaded. Try again.'));
      })
      .finally(() => {
        if (playbookForEditRequestRef.current !== requestId) return; // superseded — its own request owns the spinner now
        setPlaybookLoading(false);
      });
  };

  /** Per-clause position health for the editor, or `undefined` when the
   *  scan has not answered yet. `undefined` renders as NOTHING — an unasked
   *  question and a question answered "no evidence" are different facts, and
   *  a defaulted `UNTESTED` would state the second having only established
   *  the first. A FAILED scan is `healthError`, which the editor renders
   *  instead of the chips. Derived from the working copy's clauses, so a
   *  position edited on screen is judged on the words the author can see. */
  const positionHealthMap = useMemo(
    () => (healthLoaded && editorContent
      ? buildPositionHealthMap({
          clauses: editorContent.clauses, versions: healthVersions, reviews: healthReviews,
        })
      : undefined),
    [healthLoaded, editorContent, healthVersions, healthReviews],
  );

  const playbookRouteId = route.name === 'playbook' ? route.playbookId : null;
  useEffect(() => {
    if (!playbookRouteId) return;
    // Skip the fetch when `activeTemplate` already IS this exact playbook —
    // true right after `handleOpenTemplate` or `handleCreateTemplate`
    // navigate here in the same render, both of which already hold the
    // full Template in memory (the latter often not saved to IndexedDB
    // yet, which a fetch would wrongly report as not-found). A cold load,
    // refresh, or browser back/forward into this URL always starts with no
    // matching `activeTemplate`, so it still fetches from storage then.
    if (activePlaybook && activePlaybook.id === playbookRouteId) return;
    loadPlaybookForEdit(playbookRouteId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playbookRouteId]);

  // Leaving the editor DISCARDS its working copy (M2, fix round 1).
  //
  // Before Task 3, `handleOpenTemplate` re-seeded `activeTemplate` and
  // `savedTemplateSnapshot` from the library's own record on every open, so
  // reopening always reset. The library now holds identity records only and
  // opening is a bare `navigate`, and the effect above short-circuits when
  // `activePlaybook.id` already matches — so without this, a confirmed
  // "This template has unsaved changes. Discard them?" discarded nothing:
  // reopening the same card showed the rejected edits, still marked dirty,
  // and the next Save PUBLISHED them. A version that records a change the
  // user explicitly rejected is precisely what this sub-project exists to
  // make impossible.
  //
  // Guarded on the route rather than placed relative to the effect above:
  // the two are mutually exclusive on `playbookRouteId` being null, so
  // neither can clobber the other whichever order they end up declared in
  // (the reordering hazard CLAUDE.md names). `handleCreateTemplate` seeds
  // the editor and navigates in the same batch, so `playbookRouteId` is
  // already set by the time this runs and its unsaved draft survives.
  useEffect(() => {
    if (playbookRouteId) return;
    setActivePlaybook(null);
    setActiveVersion(null);
    setActiveDraft(null);
    setSavedTemplateSnapshot(null);
  }, [playbookRouteId]);

  // One effect with both branches, keyed on the same value as the two above
  // — the editor is the only screen that asks this question, so entering
  // the route asks it and leaving forgets the answer. Splitting it in two
  // would reopen the effect-ordering hazard CLAUDE.md names.
  useEffect(() => {
    if (!playbookRouteId) {
      setHealthLoaded(false);
      setHealthError(null);
      setHealthVersions([]);
      setHealthReviews([]);
      return;
    }
    loadPositionHealth(playbookRouteId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playbookRouteId]);

  // Keeps `view` in step with the URL for the routes an existing screen
  // understands (see `viewForRoute`) — fires on browser back/forward
  // (`useRoute`'s popstate listener updates `route`) and on our own
  // `navigate` calls below. Views with no route of their own are untouched
  // by this: `route` only changes via `navigate`, and nothing here calls it
  // for run/tabular, so this effect never fires while one of those is
  // showing.
  useEffect(() => {
    setView(viewForRoute(route));
  }, [route]);

  // Sub-project E: the authoring draft dies with its screen.
  //
  // Keyed on the view rather than repeated at each exit because there are
  // four of them — a nav click, Back/Forward, `Discard`, and a successful
  // save — and a fifth added later would otherwise leave a stale draft
  // behind, which the guard above would then insist on warning about from
  // a screen that no longer shows it. Guarded on the view, not on where
  // this sits in the file: no other effect writes authoring state, and the
  // handlers that enter these screens set the draft and the view in one
  // batch, so this sees `authoring-*` and returns (CLAUDE.md's
  // effect-ordering hazard).
  useEffect(() => {
    if (isAuthoringView(view)) return;
    // The generation dies with its screen too (Major 5). Aborting here
    // rather than only guarding the resolve is what stops a 30-second call
    // running on after the user has walked away from it.
    authoringGenerationRef.current?.abort();
    authoringGenerationRef.current = null;
    updateAuthoringDraft(null);
    setAuthoringError(undefined);
    setAuthoringAuthFailed(false);
    setAuthoringBusy(false);
    setSavingAuthoringDraft(false);
  }, [view]);

  // Sub-project F: the learning session dies with its screen, exactly like
  // the authoring draft above and for the same reason (R-F6). This is the
  // ONLY place `redlinesFilesRef` is cleared, and it is what actually keeps
  // spec §4/§11's promise: once the last of the three `REDLINES_VIEWS` is
  // left, every `File` this session ever read is dropped from memory, never
  // having reached `addDocument`/blob storage on any path.
  useEffect(() => {
    if (isRedlinesView(view)) return;
    redlinesFilesRef.current = new Map();
    // The SET id is cleared too, so a second session starts a second set —
    // but the set itself is NOT deleted. §11.1 stores these documents on
    // purpose; disposing of them is the firm's retention decision (§17 Q3),
    // not something a nav click does silently.
    redlinesSetIdRef.current = undefined;
    setRedlinesDocs([]);
    setRedlinesUnreadable([]);
    setRedlinesBusy(false);
    setRedlinesError(undefined);
    setRedlinesPositions([]);
    setRedlinesQuestions([]);
    setRedlinesWorkingsPosition(null);
    setRedlinesContractType('');
  }, [view]);

  // Best-effort: keeps `settings.model*` capability fields in step with the
  // allowlist the gateway serves, for whichever model is currently selected, even
  // when the user never opens Settings this session (e.g. a model chosen
  // in an earlier session, then jumping straight to Run). This is what lets
  // extractClause's image/structured-output/context-budget gating (Critical
  // 1, Important 9) work from live data rather than whatever was persisted
  // — possibly nothing — the last time Settings happened to be open. A
  // failed fetch leaves the existing (possibly unknown/conservative)
  // capability fields alone rather than erroring.
  useEffect(() => {
    if (!settings.modelChoiceId) return;
    let cancelled = false;
    gatewayModelClient.listModels()
      .then(models => {
        if (cancelled) return;
        const match = models.find(m => m.id === settings.modelChoiceId);
        if (!match) {
          // `ModelPicker` already refused to resolve a retired choice and
          // told the user "nothing is selected". This shell went on
          // reporting `isConfigured` from the stored id alone, so
          // `ensureConfigured` waved the same user into a 40-clause run
          // that failed on every clause with `model_not_allowed` — the
          // guard that exists to stop a flow that can only fail with an
          // obscure error not firing at the one moment it was for. The
          // capability flags left behind were the previous model's, so a
          // scanned PDF could still be sent as images to a choice that no
          // longer exists.
          //
          // The id itself is deliberately NOT cleared: an empty
          // `modelChoiceId` makes `ModelPicker` preselect and auto-commit
          // the workspace default, which would tell a reviewer a model they
          // never picked ran their review. The choice stays, visibly
          // unresolvable, and only the derived facts go.
          setStaleModelChoiceId(settings.modelChoiceId);
          setSettings(prev => {
            if (prev.modelChoiceId !== settings.modelChoiceId) return prev;
            const {
              modelChoiceLabel: _label, modelChoiceModel: _model,
              modelSupportsImages: _images, modelSupportsStructuredOutput: _structured,
              modelContextLength: _context, ...kept
            } = prev;
            // Nothing to strip — no re-render needed.
            if (Object.keys(kept).length === Object.keys(prev).length) return prev;
            // Task 18: these capability fields are never PERSISTED — they
            // are resolved fresh, client-side, from the allowlist every
            // session (`WorkspaceSettings`'s own docstring). There is
            // nothing to write back here any more; the old `saveSettings`
            // call wrote them to `localStorage`, which no longer holds any
            // part of this record at all.
            return kept as WorkspaceSettings;
          });
          return;
        }
        setStaleModelChoiceId(prev => (prev === match.id ? null : prev));
        setSettings(prev => {
          if (prev.modelChoiceId !== match.id) return prev;
          if (
            prev.modelChoiceLabel === match.label &&
            prev.modelChoiceModel === match.model &&
            prev.modelSupportsImages === match.supportsImages &&
            prev.modelSupportsStructuredOutput === match.supportsStructuredOutput &&
            prev.modelContextLength === match.contextLength
          ) return prev;
          return {
            ...prev,
            // Refreshed alongside the capabilities so that anything built
            // from this state names what the allowlist entry IS now, not
            // what it was called when it was first chosen. In-memory only —
            // see the comment above.
            modelChoiceLabel: match.label,
            modelChoiceModel: match.model,
            modelSupportsImages: match.supportsImages,
            modelSupportsStructuredOutput: match.supportsStructuredOutput,
            modelContextLength: match.contextLength,
          };
        });
      })
      .catch(() => { /* best-effort; keep whatever capabilities we already have */ });
    return () => { cancelled = true; };
  }, [settings.modelChoiceId]);

  // Important 4: a wall of identical red error cards must not sit there with
  // no explanation. Per-clause failures are isolated by design (extractClause
  // never rejects — it always resolves to an error `Finding`), so the only
  // reliable place to notice "something unrecoverable happened" is by
  // watching the findings as they land.
  //
  // Task 23: this used to notify with a fixed "your key was rejected" string
  // and always route to Settings. It no longer can — a `Finding` carries only
  // `authError: boolean` and the model's own message text, never the
  // `ModelError.code` that would say WHICH of the new split's audiences this
  // is for, and `extractClause.ts` is unchanged by this task (it stays
  // outside this task's file list; teaching it to carry a code is a
  // different, larger change). Guessing "Settings" here, when the true cause
  // might be the firm's configuration, is exactly the confidently-wrong
  // instruction this app exists not to give — so this stays generic and
  // never navigates, and the affected finding (rendered below, either as a
  // plain error card or, when its text names a configuration fault, as
  // `<ServiceConfigError>` — see `ResultsView`) is where the real detail and
  // the real repair (Retry) live.
  useEffect(() => {
    if (!run || authErrorHandledRef.current) return;
    const hasAuthError = Object.values(run.findings).some(byClause =>
      Object.values(byClause).some(f => f.authError));
    if (!hasAuthError) return;
    authErrorHandledRef.current = true;
    // The run is the server's, so stopping it is a request rather than an
    // abort. Fire-and-forget: the notice below is what the reader acts on,
    // and a second toast saying the stop request itself failed would bury
    // it.
    const live = runViewRef.current;
    if (live && !isRunOver(live.state)) {
      void cancelRun(live.id).catch(e => debug('cancelling a run after an auth failure', e));
    }
    notify(PER_CLAUSE_MODEL_FAILURE_MESSAGE, 'error');
  }, [run]);

  /**
   * Replaces `handleAuthError`, which sent every 401/403 to Settings.
   *
   * With the credentials held server-side, "your key was rejected" has split
   * into two facts with two audiences: the user's session expired, which
   * they fix by signing in; and the firm's deployment cannot reach a
   * provider (or has refused this model/purpose/jurisdiction), which they
   * cannot fix themselves. Sending a lawyer to a screen with nothing on it
   * that could help is a wrong instruction delivered with authority.
   */
  const handleModelError = (error: unknown): void => {
    if (isSignInError(error)) {
      const e = error as ModelError;
      notify(e.code === 'not_permitted' ? NOT_PERMITTED_MESSAGE : SIGN_IN_ERROR_MESSAGE, 'error');
      if (e.code === 'sign_in_required') signIn();
      return;
    }
    if (isServiceConfigError(error)) {
      const e = error as ModelError;
      if (e.code === 'group_overage') {
        notify(GROUP_OVERAGE_MESSAGE, 'error');
        return; // not Settings, not sign-in: neither can fix it
      }
      if (e.code === 'jurisdiction_not_allowed') {
        // The message carries the jurisdiction and the reassurance that
        // nothing was sent, and both come from the gateway rather than being
        // reassembled here — a second wording of "nothing was sent" is the
        // drift this app's copy exists to prevent, and it's the sentence a
        // lawyer reads first.
        notify(e.message, 'error');
        setView('settings');
        return;
      }
      if (e.code === 'model_not_allowed' || e.code === 'purpose_not_allowed') {
        notify(MODEL_UNAVAILABLE_MESSAGE, 'error');
        setView('settings');
        return;
      }
      // `service_misconfigured` and anything else in this class: stays where
      // the user is, with a Retry and a reference id. There is nothing in
      // Settings for them to change.
      setServiceConfigError(e);
      return;
    }
    notify(error instanceof Error ? error.message : 'Something went wrong.', 'error');
  };

  /**
   * Anything that calls the API — running a review, generating a template —
   * routes to Settings with an explanatory toast instead of opening (or
   * proceeding into) a flow that can only fail with an obscure error.
   */
  const ensureConfigured = (message = 'Choose a model in Settings to get started.') => {
    if (isConfigured) return true;
    // THREE reasons, not one. A workspace whose settings could not be READ
    // is not a workspace with nothing chosen — saying so would be a load
    // failure reported as a legitimate empty state, and the instruction it
    // carries ("choose a model in Settings") is one no reviewer can act on
    // and one an administrator's own Settings screen will contradict as
    // soon as its independent fetch succeeds. Deliberately does NOT route
    // to Settings for the same reason `serviceConfigError` does not: there
    // is nothing there that fixes this. The banner rendered in the shell
    // carries the Retry that does.
    if (settingsLoadError) {
      notify(settingsLoadError, 'error');
      return false;
    }
    // A user who never chose a model and a user whose choice was withdrawn
    // by an administrator are being told two different things, and only one
    // of them is answered by "choose a model".
    notify(staleModelChoiceId ? MODEL_CHOICE_STALE_MESSAGE : message, 'error');
    setView('settings');
    return false;
  };

  /**
   * Writes the working copy to `Playbook.draft`, or says why it could not.
   *
   * The ONE place `saveDraft` is called from, so the in-editor Save and the
   * Keep branch of the leave prompt cannot drift on what a save means. It
   * deliberately touches no editor state: the leave path calls it after the
   * route effect has already torn the editor down, and re-seeding
   * `activePlaybook` from under that would leave a stale playbook in state
   * off-route — which then makes reopening the same card skip its own
   * fetch and render "No template selected". `handlePersistDraft` applies
   * the state on top, where there is still an editor to apply it to.
   *
   * Integrity re-review, Minor 6 (second route): a draft whose content
   * equals the published version is not an unpublished change, wherever
   * that question is asked — including here. `isTemplateDirty` answers a
   * DELIBERATELY different question ("is there something new since the
   * last save this session", per `TemplateEditor`'s own docstring on
   * `unsavedChanges`), so an edit-then-revert can leave it true even though
   * `hasUnpublishedContent` is false. Persisting anyway in that state wrote
   * a `Playbook.draft` content-identical to the version — `t.draft`
   * presence stayed true forever after, with `discardDraft` unreachable
   * because THIS save had just made `isTemplateDirty` false again — so the
   * library card (keyed on that presence, `TemplateLibrary.tsx:62`)
   * disagreed with the editor's own `hasUnpublishedContent`-gated banner
   * and Publish button, permanently. Checking `hasUnpublishedContent` here,
   * the same function the editor's banner and Publish button already use,
   * and discarding instead of saving when it says false, keeps draft
   * PRESENCE a reliable proxy for draft CONTENT differing from the
   * version — the one thing every reader of that presence, the library
   * card included, actually means to ask. No second special case needed at
   * the read site.
   */
  const saveDraftOrReport = async (
    playbook: Playbook, draft: PlaybookDraft, version?: PlaybookVersion,
  ): Promise<Playbook | null> => {
    try {
      if (!hasUnpublishedContent(version, draft)) {
        await discardDraft(playbook.id);
        await refreshTemplates().catch(() => {});
        const cleared: Playbook = { ...playbook };
        delete cleared.draft;
        return cleared;
      }
      const saved = await saveDraft(playbook, draft);
      // The save succeeded; a library row that is briefly stale is not that
      // failure and must not be reported as it.
      await refreshTemplates().catch(() => {});
      return saved;
    } catch (e) {
      notify(
        e instanceof Error ? e.message : 'Your unpublished changes could not be saved.',
        'error',
      );
      return null;
    }
  };

  /** The editor's explicit `Save draft` (R-D16: on intent, never per
   *  keystroke). await-then-apply, like every other human-authored write in
   *  this app — the editor is marked saved only once the store has taken
   *  the write, never optimistically. */
  const handlePersistDraft = async () => {
    if (!activePlaybook || !activeDraft) return;
    setSavingDraft(true);
    const saved = await saveDraftOrReport(activePlaybook, activeDraft, activeVersion ?? undefined);
    setSavingDraft(false);
    if (!saved) return;
    setActivePlaybook(saved);
    setSavedTemplateSnapshot(JSON.stringify(activeDraft));
    notify('Draft saved.');
  };

  /**
   * Important 7 / R-D16: leaving the editor with unsaved changes is a
   * THREE-way choice — Keep them, Discard them, or stay. This is the
   * TEMPLATE half of `confirmDiscardIfDirty` below; the authoring half
   * is E’s session-only draft, guarded by `useUnsavedDraftGuard`.
   *
   * Two native confirms rather than a modal, because this is also
   * `useRoute`'s popstate guard: a Back press has already moved the address
   * bar by the time it runs, so the answer has to be synchronous and there
   * is no await to be had. One implementation serves the Close control, a
   * nav click and Back alike; splitting it so the two async-capable paths
   * could use a modal would be two guards to keep honest.
   *
   * DISCARD CLEARS THE STORED DRAFT, not just the in-memory one. Without
   * that, "discard" would leave the rejected edits durable and
   * `loadPlaybookForEdit` prefers a stored draft over the published
   * version, so the next open would show exactly the edits the user had
   * just rejected — the defect Task 3's M2 fixed in memory, one layer down.
   *
   * Both writes are fired without being awaited, because the guard cannot
   * await: a failure is reported by its own toast rather than silently.
   */
  const confirmLeaveTemplate = () => {
    if (!isTemplateDirty) return true;
    const playbook = activePlaybook;
    const draft = activeDraft;
    if (window.confirm(
      'Keep your unpublished changes?\n\n'
      + 'OK saves them as a draft you can come back to. Cancel offers to discard them.',
    )) {
      if (playbook && draft) void saveDraftOrReport(playbook, draft, activeVersion ?? undefined);
      return true;
    }
    if (window.confirm(
      'Discard your unpublished changes? They cannot be recovered.\n\n'
      + 'Cancel to stay in the editor.',
    )) {
      if (playbook) {
        void discardDraft(playbook.id)
          .then(() => refreshTemplates().catch(() => {}))
          .catch(() => notify('Your unpublished changes could not be discarded.', 'error'));
      }
      return true;
    }
    return false;
  };

  // R-E4 — two pieces of unsaved work, and both routes out of each of them.
  //
  // `useUnsavedDraftGuard` registers a `beforeunload` handler (a reload, a
  // tab close) for as long as its flag holds, and returns the IN-APP half,
  // which `beforeunload` cannot cover because it does not fire on a route
  // change. Wiring only the first looks like a working guard right up
  // until someone clicks a nav link.
  //
  // The TEMPLATE half takes only the `beforeunload` registration: its
  // in-app question is the THREE-way prompt above (Keep / Discard / stay),
  // which a single `window.confirm` cannot express, so the guard this call
  // returns is deliberately unused. The AUTHORING half is a plain
  // two-way question — there is nowhere to keep a draft that must never be
  // persisted — so it uses both halves.
  useUnsavedDraftGuard(isTemplateDirty, TEMPLATE_DIRTY_MESSAGE);
  const confirmLeaveAuthoringDraft = useUnsavedDraftGuard(
    authoringDraft !== null,
    AUTHORING_DRAFT_DIRTY_MESSAGE,
  );

  /** Sub-project F's own unsaved-work flag, reusing E's guard rather than
   *  writing a second one (spec §11's rule, restated for F in the task
   *  brief). Real work exists in this session once at least one precedent
   *  document has been brought in, and NOTHING in this session is ever
   *  durable — the handoff to `authoring-review` passes the warning to E's
   *  own guard (`confirmLeaveAuthoringDraft`), and the first durable write
   *  in the whole flow is the publish at the end of E's draft review. */
  const redlinesSessionDirty = isRedlinesView(view) && redlinesDocs.length > 0;
  const confirmLeaveRedlinesSession = useUnsavedDraftGuard(redlinesSessionDirty, REDLINES_DIRTY_MESSAGE);

  /** The single question every exit from the current screen asks — a nav
   *  click (`requestView`), a Back/Forward press (`useRoute`'s
   *  `canLeaveCurrentView`), and the editor's own close button. Each flag
   *  is already false outside its own screen (`isTemplateDirty` requires
   *  `view === 'editor'`; `authoringDraft` is cleared the moment an
   *  authoring view is left; `redlinesSessionDirty` requires a
   *  `REDLINES_VIEWS` view), so calling all three from anywhere is safe.
   *  `&&` short-circuits, so more than one being dirty at once still asks
   *  only one question at a time and still refuses on the first "cancel". */
  const confirmDiscardIfDirty = () =>
    confirmLeaveTemplate() && confirmLeaveAuthoringDraft() && confirmLeaveRedlinesSession();

  const requestView = (next: View) => {
    if (next !== view && !confirmDiscardIfDirty()) return;
    if (next === 'run' && !ensureConfigured()) return;
    setView(next);
    // Keeps the URL in sync for the views that own a route, so a refresh or
    // a shared link lands back where the user was. Views with no route yet
    // (editor/run/results/tabular) deliberately push nothing.
    const routeForNext = ROUTE_FOR_VIEW[next];
    if (routeForNext) navigate(routeForNext);
  };

  const handleOpenTemplate = (t: Playbook) => {
    // The library holds identity records only, so the content has to be
    // fetched — which `loadPlaybookForEdit` does, driven by the route. The
    // reset that this function used to do lives in the route effect above
    // (see "Leaving the editor DISCARDS its working copy"), where every way
    // out of the editor reaches it, not just this one.
    navigate({ name: 'playbook', playbookId: t.id });
  };

  /** Loads a playbook's published content, or reports why it cannot. `null`
   *  content is a real state (a playbook created but never saved), and
   *  running it would produce a review of no clauses that looked like a
   *  review that found nothing. */
  const contentForRun = async (t: Playbook): Promise<PlaybookVersion | null> => {
    try {
      const content = await getPlaybookContent(t.id);
      if (!content) {
        notify('This playbook has no published version yet. Open it and save it first.', 'error');
        return null;
      }
      return content;
    } catch (e) {
      notify(describeLoadError(e, 'This playbook could not be loaded. Try again.'), 'error');
      return null;
    }
  };

  /** Important 3: a Library run used to skip persistence entirely — this
   *  now opens `MatterPickerModal` first, so every run (Library or Matter
   *  Home) ends up scoped to a matter. See `handlePickMatterForRun` /
   *  `handleCreateMatterForRun` for what happens once one is chosen. */
  const handleRunTemplate = async (t: Playbook) => {
    const content = await contentForRun(t);
    if (!content) return;
    setMatterPickerTemplate(content);
    setMatterPickerOpen(true);
  };

  const closeMatterPicker = () => {
    setMatterPickerOpen(false);
    setMatterPickerTemplate(null);
  };

  /** Enters the run flow scoped to `matterId`, exactly like
   *  `handleRunReviewForMatter` (Matter Home's own "Run a review") except
   *  starting from an empty upload rather than the matter's existing
   *  documents — this is reached from the Library, which has no documents
   *  of its own to pre-seed with. Refreshes `matterDocuments` first so
   *  `handleStartRun`'s new-vs-existing-document check (further down) is
   *  comparing against the CHOSEN matter's real documents, not whatever
   *  matter's documents happened to be in state beforehand. */
  const handlePickMatterForRun = async (matterId: string) => {
    const template = matterPickerTemplate;
    if (!template) return;
    await loadMatterDocuments(matterId);
    setActiveTemplate(template);
    setActiveMatterId(matterId);
    setRun(null);
    setDocuments([]);
    setRunPanelKey(k => k + 1);
    closeMatterPicker();
    requestView('run');
  };

  const handleCreateMatterForRun = async (params: CreateMatterParams) => {
    // Task 16: `createMatter` "does not notify or swallow errors itself —
    // both callers have their own thing to do with a failure" (see its own
    // docstring), but this caller had nothing: `MatterPickerModal.handleCreate`
    // only wraps the call in `try { … } finally`, with no `catch` — so a
    // `createMatter` rejection (now routine on a `getProfile()` failure,
    // where it used to require a `saveMatter` failure) was an unhandled
    // rejection with no message shown anywhere.
    let created: Matter;
    try {
      created = await createMatter(params);
    } catch (e) {
      notify(e instanceof Error ? e.message : 'Could not create the matter.', 'error');
      return;
    }
    notify('Matter created.');
    await handlePickMatterForRun(created.id);
  };

  /**
   * Switches to the results view immediately — before `runReview` settles,
   * not after — so the cards mount while the run is still in flight and
   * fill in one clause at a time as `onUpdate` (here, `setRun` itself)
   * fires. That progressive fill is the entire feel of the app; showing
   * results only once everything is done would defeat the point.
   *
   * When this run is matter-scoped (`activeMatterId` set — via
   * `handleRunReviewForMatter`), it additionally:
   *  - persists any document uploaded straight into the run panel that
   *    isn't already one of the matter's documents, so the review this
   *    produces refers only to real, matter-owned documents (never one
   *    that exists nowhere else the app can find it);
   *  - persists a `Review` record as findings land (debounced) and again
   *    on completion or cancellation, so the run survives a reload (spec
   *    definition-of-done #3) instead of vanishing the moment the tab
   *    closes, exactly like every completed v1 run used to.
   *
   * `options` (Task 7) is how a collection review reaches this same,
   * single run-starting function rather than a second copy of it:
   *  - `template`/`matterId` default to `activeTemplate`/`activeMatterId`
   *    state, exactly what this function always read before — needed as
   *    explicit overrides ONLY because a collection's own "Run a review"
   *    calls this in the same tick as `setActiveTemplate`/
   *    `setActiveMatterId`, before either state update has taken effect on
   *    this render's closures (the standard React stale-closure gap;
   *    `RunPanel`'s call always lands on a LATER render, so it never
   *    needed this).
   *  - `collection`, when present, is threaded straight into `emptyRun`
   *    (as its `target`) and `runReview` (as its sixth argument) — every
   *    other line in this function is unchanged and still runs, since a
   *    collection's documents are already-persisted matter documents
   *    (`existingIds` below always contains them, so the "persist a
   *    newly-uploaded document" branch is naturally a no-op for them).
   *
   * When `options` is omitted entirely (`RunPanel`'s
   * `onRun={handleStartRun}`), every one of these resolves to exactly what
   * it always did — the standalone path this function implements is
   * unchanged, byte for byte.
   */
  const handleStartRun = async (
    docs: DocumentFile[],
    options: { template?: PlaybookVersion; matterId?: string | null; collection?: CollectionRunInput } = {},
  ) => {
    const template = options.template ?? activeTemplate;
    if (!template || docs.length === 0) return;
    const matterId = options.matterId !== undefined ? options.matterId : activeMatterId;
    const collectionInput = options.collection;

    // A REVIEW IS A ROW NOW, AND A ROW BELONGS TO A MATTER.
    //
    // The browser used to be able to run a review that belonged to nothing
    // — `matterId` null meant "no saver, no persistence, gone when the tab
    // closes". The server has nowhere to put such a run: `POST
    // /v1/reviews/:id/runs` reads the review's own target and playbook
    // snapshot out of the `review` row. Every path into this function today
    // goes through the matter picker or Matter Home, so this is refused
    // rather than silently downgraded to a run nobody could find again.
    if (!matterId) {
      notify('A review has to belong to a matter. Choose one and start the review again.', 'error');
      return;
    }

    // Important 2: the matter could already be gone by the time this run
    // was queued up (e.g. a stale run panel) — never write a document
    // into a matter that no longer exists.
    if (deletedMatterIdsRef.current.has(matterId)) {
      notify('This matter has been deleted, so this review cannot be started.', 'error');
      return;
    }

    let userId = '';
    try {
      const profile = await getProfile();
      userId = profile.id;
      createdByUserIdRef.current = userId;
      const existingIds = new Set(matterDocuments.map(d => d.id));
      const newDocs = docs.filter(d => !existingIds.has(d.id));
      if (newDocs.length > 0) {
        await Promise.all(newDocs.map(doc => {
          const { record, bytes } = toDocumentRecord(doc, matterId, userId);
          return addDocument(record, bytes);
        }));
        await loadMatterDocuments(matterId);
      }
    } catch (e) {
      notify(e instanceof Error ? e.message : 'Could not save the new documents to this matter.', 'error');
      return;
    }
    // Re-check: the matter may have been deleted WHILE the documents above
    // were being written. Those writes can't be undone from here, but the
    // review itself — the bigger, ongoing write this guards — must not
    // start against a matter that's already gone.
    if (deletedMatterIdsRef.current.has(matterId)) {
      notify('This matter has been deleted, so this review cannot be started.', 'error');
      return;
    }

    // `emptyRun` SURVIVES, and only for its shape. It mints the review's
    // id, freezes the playbook snapshot, records the target and seeds one
    // `pending` finding per cell — which is what the results view renders
    // between the click and the server's first answer. The server seeds its
    // OWN `pending` findings inside `createRun`, and those are the ones
    // that outlive this tab; these are the optimistic view of the same
    // shape, replaced by the first refresh.
    const newRun = emptyRun(template, docs, collectionInput?.target);
    authErrorHandledRef.current = false;
    latestRunRef.current = newRun;
    // Task 8A: kept for the collection VIEWER, not for a retry — a retry is
    // one POST now (Task 20) and the server reads the collection record
    // itself.
    activeCollectionRef.current = collectionInput ?? null;
    setDocuments(docs);
    setRun(newRun);
    // Task 10 / R-D15: `template` IS the live `PlaybookVersion` this run
    // just read (`emptyRun` mints `newRun.playbookVersionId` from its own
    // `id`), so the resolved version is already in hand — no store round
    // trip needed for a run that only just started.
    setRunPlaybookVersion(template);
    setIsRunning(true);
    setView('results');

    try {
      // THE REVIEW ROW FIRST, ONCE — not a debounced stream of them.
      //
      // `createDebouncedReviewSaver` and `persistFinal` are gone with the
      // orchestration they kept up with. The server writes every finding
      // now, so there is nothing for a mid-run whole-review save to carry —
      // and the 409 that save kept colliding with (a run's saver holding its
      // own copy of a review somebody else has since written to) has no way
      // to arise any more. That is P25's remedy, and it is a deletion rather
      // than a fix.
      //
      // The findings this write carries are `emptyRun`'s `pending` ones,
      // which is what the review genuinely holds at this instant. The run
      // then replaces them with its own.
      await saveReview(reviewFromRun(newRun, matterId, settings.modelChoiceId, userId));
      const started = await startRun(newRun.id);
      attachRun(started, matterId);
    } catch (e) {
      setIsRunning(false);
      // THROUGH `handleModelError`, and not through a second policy of its
      // own. This was first written as "a 4xx is a refusal, show its own
      // message; anything else goes to `handleModelError`" — and that
      // routed a 403 `model_not_allowed` to a plain toast, losing the
      // navigation to Settings that the whole of Task 23's copy split
      // exists to get right.
      //
      // `handleModelError`'s own fallback already ends in
      // `notify(error.message)`, so the refusals this path really carries —
      // a document still being read (§11's third load state), a document the
      // server no longer has, a review already running — reach the reader as
      // themselves. One classification, in one place.
      handleModelError(e);
      return;
    }
    loadMatterReviews(matterId);
  };

  const stopWatching = (): void => {
    watchStopRef.current?.();
    watchStopRef.current = null;
  };

  /**
   * Watches a run to its end, and keeps the findings on screen in step with
   * the rows.
   *
   * THE ONE BEHAVIOURAL CHANGE A USER CAN SEE. The results view used to fill
   * in as `onUpdate` fired, cell by cell — "that progressive fill is the
   * entire feel of the app". It still fills in progressively; it is now one
   * second coarser, because that is the poll interval. If it reads as
   * sluggish the interval is the knob (`watchRun`'s `intervalMs`), not the
   * architecture, and Stage 4's socket removes the question entirely.
   *
   * Used by BOTH ways a run reaches this screen: one just started, and one
   * found already live when a review was opened — in another tab, or before
   * a reload. That second case is new, and it is the point of the stage.
   */
  /**
   * Nothing holds these promises, so an error inside one has nowhere to go
   * but an unhandled rejection — which crashes nothing and says nothing,
   * the worst of both. Caught and logged at the one place they are started.
   * Every failure they can carry has already been reported by the function
   * itself; what this catches is the unexpected.
   */
  const detach = (work: Promise<void>, what: string): void => {
    void work.catch(e => debug(what, e));
  };

  const attachRun = (view: RunView, matterId: string) => {
    stopWatching();
    runViewRef.current = view;
    setIsRunning(!isRunOver(view.state));
    if (isRunOver(view.state)) {
      detach(refreshFindings(view.reviewId), 'reading a finished run s findings');
      return;
    }
    watchStopRef.current = watchRun(
      view.id,
      event => {
        if (event.type === 'run.finished') {
          detach(finishRun(view.id, view.reviewId, matterId), 'finishing the run');
          return;
        }
        // One refresh per batch of events rather than one per event: a
        // forty-cell run emits eighty of them and the findings map is one
        // read whatever it is answering. `refreshFindings` coalesces.
        detach(refreshFindings(view.reviewId), 'refreshing the findings');
      },
      error => {
        // Three consecutive failed polls. A poll loop that dies quietly
        // leaves a run apparently frozen at whatever it last saw.
        notify(
          error instanceof Error
            ? `LexPrompt has lost touch with this review while it runs: ${error.message}. `
              + 'The work is still on the server. Reload to pick it up again.'
            : 'LexPrompt has lost touch with this review while it runs. The work is still on '
              + 'the server. Reload to pick it up again.',
          'error',
        );
      },
      // The cursor fell outside the retention window, so the events between
      // it and now are gone. The findings map is most of the state those
      // events described — but not all of it: a `run.finished` among the
      // pruned ones is an ENDING nothing else on this screen would ever
      // learn about, and the banner would say the review is still running
      // for the life of the page. So the run's own state is re-read too,
      // and a run that has ended since is finished here exactly as the
      // event would have finished it.
      {
        onResync: () => {
          // SAID OUT LOUD. A silent re-read is indistinguishable from a
          // screen that has stopped updating, which is the state this
          // whole task exists to make visible.
          setResyncing(true);
          detach(
            refreshFindings(view.reviewId).finally(() => setResyncing(false)),
            'resyncing the findings');
          detach(
            getRun(view.id).then(fresh => (isRunOver(fresh.state)
              ? finishRun(view.id, view.reviewId, matterId)
              : undefined)),
            'resyncing the run',
          );
        },
      },
    );
  };

  /**
   * Re-reads the findings map and puts it on screen, at most one read at a
   * time.
   *
   * COALESCED rather than queued: events arrive in batches and every one of
   * them describes the same map, so a second read asked for while the first
   * is in flight is marked and performed once, not stacked. Without this a
   * forty-cell run would issue eighty reads of the same sixty findings.
   *
   * A read that keeps failing is REPORTED, on the same three-strikes rule
   * `watchRun` uses and for the same reason: a screen that has quietly
   * stopped updating mid-run is a job that died looking like a job still
   * working.
   */
  const refreshFindings = async (reviewId: string): Promise<void> => {
    const state = findingsRefreshRef.current;
    if (state.inFlight) {
      state.again = true;
      return;
    }
    state.inFlight = true;
    try {
      do {
        state.again = false;
        const writes = humanWritesRef.current;
        let findings: Review['findings'];
        try {
          ({ findings } = await getFindings(reviewId));
          state.failures = 0;
        } catch (e) {
          state.failures += 1;
          debug('findings refresh failed', reviewId, state.failures, e);
          if (state.failures >= 3) {
            state.failures = 0;
            notify(
              'The findings on this screen have stopped updating. They are safe on the server; '
              + 'reload the review to see where it has got to.',
              'error',
            );
          }
          return;
        }
        const base = latestRunRef.current;
        // The screen moved on — another review was opened while this read
        // was in flight. Applying it would put one review's findings under
        // another's clauses.
        if (!base || base.id !== reviewId) return;
        // A human write was confirmed while this read was in flight, so the
        // response predates it. Read again rather than apply — see
        // `humanWritesRef`. NOT a merge: `carryHumanState` is deleted and
        // nothing puts this browser's copy of a judgement back on top of the
        // store's answer.
        if (humanWritesRef.current !== writes) {
          state.again = true;
          continue;
        }
        // The findings a read returns ARE the human state: the disposition,
        // the notes and the net position are rows of their own, assembled by
        // `findings/read.ts`. There is no snapshot to merge and nothing the
        // engine could have clobbered — it holds no grant on any of them.
        const merged = { ...base, findings };
        latestRunRef.current = merged;
        setRun(merged);
      } while (state.again);
    } finally {
      state.inFlight = false;
    }
  };

  /**
   * The run ended. Read the findings one last time, say HOW it ended, and
   * stop watching.
   *
   * The last read is not optional: `run.finished` says the run is over, and
   * the findings it produced are only on screen once they have been read.
   * Skipping it would leave the final cell spinning on a run the banner
   * calls finished.
   */
  const finishRun = async (runId: string, reviewId: string, matterId: string): Promise<void> => {
    stopWatching();
    setIsRunning(false);
    // Important 2, in its new home. `matterId` is this closure's own copy,
    // captured when the run was attached, and the matter it names may have
    // been deleted while the run was still going — `handleDeleteMatter`
    // stops the watch, but an event already delivered can land after it.
    // Past this line lies a `saveReview`, which is exactly the write that
    // must never resurrect a purged matter.
    //
    // Found by a test rather than by care: the guard `persistFinal` used to
    // carry did not come across with the rewrite, and `App.matterDelete`'s
    // "never lets a late run event write to the purged matter" turned red.
    if (deletedMatterIdsRef.current.has(matterId)) return;
    await refreshFindings(reviewId);
    let final: RunView;
    try {
      final = await getRun(runId);
    } catch (e) {
      // The run ended and this read of its ending failed. The findings are
      // already on screen from the refresh above; what is lost is the
      // sentence saying HOW it ended, and inventing one would be worse than
      // saying nothing.
      debug('could not read the finished run', runId, e);
      loadMatterReviews(matterId);
      return;
    }
    runViewRef.current = final;
    // `cancelled` is calm and `failed` is not — the same distinction
    // `Finding.status` already keeps one level down. A `succeeded` run says
    // nothing about its ending: the findings are the answer.
    const ending = describeRunEnding(final);
    if (ending) notify(ending.message, ending.tone === 'error' ? 'error' : 'success');

    // ONE WHOLE-REVIEW SAVE, AT A SETTLED MOMENT, and it writes exactly one
    // new fact: WHEN THIS REVIEW ENDED.
    //
    // `Review.completedAt`/`cancelledAt` are what `RunCancelledBanner`,
    // `RunInterruptedBanner` and `RunEmptyFindingsBanner` read when the
    // review is reopened, and nothing else can write them: `settleRunIfFinished`
    // runs in the WORKER, whose role holds only `select` on `review`. Making
    // the server stamp them would need a new grant on that table, which is
    // not a change to make in passing — so the browser records it, once, at
    // the moment it learns the run is over.
    //
    // This is not the debounced saver returning. That wrote the whole record
    // every two seconds from a copy nobody else could see, which is the
    // sticky-409 P25 names; this is a single write of a settled fact.
    //
    // A `failed` run gets NEITHER timestamp, deliberately: it stopped
    // without being asked, which is what "interrupted" means, and
    // `RunInterruptedBanner` is the honest reading.
    const at = final.finishedAt ?? Date.now();
    const base = latestRunRef.current;
    if (base && base.id === reviewId && (final.state === 'succeeded' || final.state === 'cancelled')) {
      const stamped: ReviewRun = final.state === 'cancelled'
        ? { ...base, cancelledAt: at }
        : { ...base, completedAt: at };
      latestRunRef.current = stamped;
      setRun(stamped);
      try {
        await saveReview(reviewFromRun(
          stamped, matterId, settings.modelChoiceId, createdByUserIdRef.current));
      } catch (e) {
        notify(
          e instanceof Error
            ? `This review finished, but recording that it finished failed: ${e.message}`
            : 'This review finished, but recording that it finished failed.',
          'error',
        );
      }
    }
    loadMatterReviews(matterId);
  };

  const handleCancelRun = () => {
    const current = runViewRef.current;
    if (!current) return;
    // A person asked it to stop. What has to be surfaced here is a FAILURE
    // TO ASK: if the request never landed the run is still going, and a
    // screen that said otherwise would be the quiet wrong answer.
    void cancelRun(current.id)
      .then(cancelled => {
        runViewRef.current = cancelled;
      })
      .catch(e => notify(
        e instanceof Error
          ? `This review was not stopped: ${e.message}`
          : 'This review was not stopped.',
        'error',
      ));
  };

  /** Key of the finding whose verification or note write is in flight, as
   *  `findingKey(docId, clauseId)`. One at a time is enough: these are
   *  single-record writes and a user verifies one finding at a time. */
  const [verifyBusyKey, setVerifyBusyKey] = useState<string | null>(null);
  // Where the comparison grid last handed off to, so ResultsView can land
  // on the cell the reader actually clicked rather than clause 1 of
  // whichever document happened to be first.
  const [openReviewAt, setOpenReviewAt] = useState<{ docId: string; clauseId: string } | undefined>(undefined);

  /**
   * `ExportGateBanner`'s "Review unchecked →": the first finding nobody has
   * disposed of, wherever it is in this run. Task 17 deliberately left the
   * banner's `onReviewUnchecked` unwired because there was nowhere to send
   * the reader — `ResultsView`'s clause index (Task 23) is that somewhere.
   *
   * A collection review keys every clause's finding by the collection id
   * (one position per clause, however many documents fed it), so there is
   * exactly one findings map to scan and `docId` is only along for the ride
   * (it just picks which document the viewer shows). A standalone review
   * keys by document, so this walks `run.documentIds` in order and returns
   * the first document whose OWN findings have an unchecked clause — the
   * same "read top to bottom" order a reviewer would use by hand.
   */
  const firstUncheckedTarget = (r: ReviewRun): { docId: string; clauseId: string } | null => {
    const clauses = r.templateSnapshot.clauses;
    if (isCollectionTarget(r.target)) {
      const clauseId = firstUncheckedClauseId(clauses, r.findings[findingsKeyFor(r.target)] ?? {});
      return clauseId ? { docId: r.documentIds[0] ?? '', clauseId } : null;
    }
    for (const docId of r.documentIds) {
      const clauseId = firstUncheckedClauseId(clauses, r.findings[findingsKeyFor(r.target, docId)] ?? {});
      if (clauseId) return { docId, clauseId };
    }
    return null;
  };

  /**
   * A PERSON'S JUDGEMENT ABOUT ONE ANSWER, written to its own row (Task 19).
   *
   * Await the write, then apply (ruling R-B2, spec §9). The UI must never
   * show a verification the store did not take: a reviewer who marks twenty
   * findings verified, whose writes all fail, and whose export then claims
   * verification no store holds, is the worst outcome this feature has.
   *
   * ## What went, and why the long comment that used to be here went with it
   *
   * This function used to read `latestRunRef.current`, cross two awaits
   * (`getProfile()`, then a whole-review `saveReview`), and write the ref
   * back — so a live run's `onUpdate` landing in that window was discarded
   * unless the ref was re-read and this one finding re-applied onto it. All
   * of that was a consequence of the write being a READ-MODIFY-WRITE OVER A
   * WHOLE REVIEW. It is now one PUT against one row:
   *
   *  - `getProfile()` is gone. The server knows who is asking, and refuses a
   *    body that says otherwise. That retires one of the two awaits those
   *    comments were about — and one of the five unhandled-rejection sites
   *    Stage 2's Task 16 found among exactly these call sites.
   *  - The merge is gone. There is nothing to merge: this write touches one
   *    row, and the engine holds no grant on it.
   *
   * What is NOT gone is `latestRunRef`. It is still the freshest run this
   * browser holds and still what the next findings refresh merges onto, so
   * the applied result goes there as well as into `run`.
   *
   * A 409 is a REFUSAL and must not be softened into a retry (P25): the row
   * moved on — another tab, another person — so applying this write would
   * overwrite a judgement nobody has seen. Stage 4 puts *"Priya changed this
   * to Rejected at 14:22, after you loaded it"* on that sentence; Stage 3
   * says the plain thing, because half an attribution surface is worse than
   * none (P28).
   */
  const handleVerify = async (
    docId: string, clauseId: string, change: VerificationChange, atVersion?: number,
  ) => {
    const current = latestRunRef.current ?? run;
    if (!current) return;
    const key = findingsKeyFor(current.target, docId);
    const existing = current.findings[key]?.[clauseId];
    if (!existing) return;

    setVerifyBusyKey(findingKey(docId, clauseId));
    try {
      const { disposition } = await setDisposition(
        current.id, key, clauseId, change, atVersion);
      // The write landed, so whatever refusal was on screen is about a state
      // that no longer stands. Cleared here rather than left for the next
      // render, because a notice saying "your change was not applied" beside
      // a card showing that it was is a second lie of exactly the kind the
      // notice exists to end.
      setVerifyConflict(null);
      applyToFinding(docId, clauseId, finding => ({
        ...finding,
        // The row the store CONFIRMED, through the ONE mapping
        // (`verificationFromDisposition`) — the same function the card
        // reads while it holds an update and the same one Stage 4's push
        // handler reads. It was written out inline here, and a second
        // copy was about to be written twice more.
        verification: verificationFromDisposition(disposition),
      }));
    } catch (e) {
      // A REFUSAL THAT NAMES WHOSE WON (§6.3, Stage 4).
      //
      // The 409 carries the row as it stands now, so this needs no second
      // round trip: `conflictingDisposition` narrows it, `rememberConflict`
      // records it — which is what lets the change be offered again against
      // the version that won — and `ConflictNotice` renders §6.3's own
      // sentence beside the card.
      //
      // NOTHING RE-SUBMITS HERE. The re-apply is `handleReapplyConflict`,
      // reachable only from a person's click (P25). An automatic one would
      // be last-write-wins with a history row claiming a person decided it.
      //
      // Await-then-apply holds on this path too: the card's own state is not
      // moved. What is updated is the browser's record of what the SERVER
      // says is there, because continuing to show the stale disposition
      // beside a notice about the new one would be a second lie beside the
      // first.
      const won = conflictingDisposition(e);
      if (won) {
        rememberConflict(won);
        setVerifyConflict({
          findingsKey: won.findingsKey, clauseId: won.clauseId, docId,
          current: { disposition: won }, attempted: change,
        });
        // The module cache `dispositionOf` reads has just moved
        // (`rememberConflict`), and it is not React state. Without this the
        // card would go on rendering the row that lost.
        bumpModuleCache(n => n + 1);
      } else {
        notify(verificationRefusal(e), 'error');
      }
    } finally {
      setVerifyBusyKey(null);
    }
  };

  /**
   * A refused change, and the row that refused it.
   *
   * ONE at a time, like `verifyBusyKey` and for the same reason: a person
   * makes one judgement at a time, and a queue of unresolved refusals is a
   * screen nobody can act on.
   */
  const [verifyConflict, setVerifyConflict] = useState<{
    findingsKey: string; clauseId: string; docId: string;
    current: DispositionWithHistory; attempted: VerificationChange;
  } | null>(null);

  /**
   * THE CHANGE, OFFERED AGAIN, AGAINST THE VERSION THAT WON — by a click.
   *
   * This writes a SECOND HISTORY ROW, which is the point: §6.3's resolution
   * is that both intentions end up on the record, not that one of them is
   * merged into the other. There is nothing to merge — a disposition is one
   * of four words — and "keep mine" is exactly this.
   *
   * It is `handleVerify` again, unchanged, because the re-apply must be
   * indistinguishable from the original judgement in every way except that
   * the person making it has now been shown whose judgement they are
   * replacing. A separate write path here would be a second way to move a
   * disposition, and this codebase has six findings about what that costs.
   */
  const handleReapplyConflict = () => {
    const conflict = verifyConflict;
    if (!conflict) return;
    // Against the version that WON, which the refusal stated and
    // `rememberConflict` recorded — never against whatever the card was
    // showing when the refused click was made, which is the version that has
    // just been refused.
    void handleVerify(conflict.docId, conflict.clauseId, conflict.attempted,
      conflict.current.disposition.version);
  };

  /** The sentence a refused verification shows when the refusal named no
   *  row this browser can speak about — a foreign-key conflict, or a
   *  conflict over an id this workspace may not see. A conflict WITH a row
   *  goes to `ConflictNotice` instead, which names the person. */
  const verificationRefusal = (e: unknown): string => {
    if (e instanceof ModelError && e.code === 'conflict') {
      return 'This finding changed while you were looking at it. Reload the review and try again.';
    }
    return e instanceof Error
      ? `This verification was not saved: ${e.message}`
      : 'This verification was not saved.';
  };

  /**
   * Replaces ONE finding in the freshest run this browser holds, and puts it
   * on screen.
   *
   * The four human-write handlers all did this by hand, each with its own
   * re-read of `latestRunRef` and its own `withUpdatedFinding` call — which
   * is the third copy of a pattern this project has six sibling-drift
   * findings about. `update` is given the CURRENT finding under that key, so
   * a caller cannot accidentally apply its change to the pre-await snapshot
   * it was holding.
   */
  const applyToFinding = (
    docId: string, clauseId: string, update: (finding: Finding) => Finding,
  ): void => {
    const latest = latestRunRef.current ?? run;
    if (!latest) return;
    const key = findingsKeyFor(latest.target, docId);
    const existing = latest.findings[key]?.[clauseId];
    if (!existing) return;
    const merged = withUpdatedFinding(latest, docId, clauseId, update(existing));
    latestRunRef.current = merged;
    setRun(merged);
    // A findings read that was already in flight was assembled before this
    // write and must not be applied over it. See `humanWritesRef`.
    humanWritesRef.current += 1;
  };

  /** A note: a person's remark about the clause, and its own row. The actor
   *  and the instant are the server's — the note that comes back is what was
   *  stored, and it is what goes on screen. */

  /**
   * SOMEBODY ELSE'S CHANGE, ARRIVING (section 18 item 5, Task 21).
   *
   * Five rules, each of which is a defect if dropped:
   *
   * 1. **The version guard first.** An event whose version is not newer
   *    than what this browser holds is DROPPED. It is what makes replay
   *    safe, makes the echo of your own write a no-op, and makes
   *    out-of-order delivery survivable. `src/lib/api/socket.ts` applies
   *    the same comparison one layer down; two independent guards,
   *    because this is the one place a dropped event leaves a human
   *    judgement on screen that the database does not hold.
   * 2. **Apply from the PAYLOAD, never by re-fetching.** Section 8 puts the
   *    whole new row and the event that produced it on one frame precisely
   *    so "was Rejected" is on hand without a second query. A handler that
   *    re-fetched would turn a forty-cell run into forty reads and would
   *    be optimised away later, taking the sentence with it.
   * 3. **Never over a decision in progress.** `mayApplyNow` decides that,
   *    inside `FindingCard`, which is where the open control and the
   *    in-flight write actually are — the SAME function the poll path
   *    uses, not a second copy. What this handler does is move the two
   *    caches a read moves, exactly as a read would; the card then holds
   *    the DISPLAY back, and a judgement submitted from a held dialog
   *    states the version it was showing and is REFUSED, which is the
   *    correct outcome.
   * 4. **A note arrives as a note.** It APPENDS; it never replaces the
   *    notes array from a stale local copy.
   * 5. **A `run.*` event still routes to `refreshFindings`** — through
   *    `watchRun`, exactly as it does today. The engine's events describe
   *    the model's output; the disposition events describe a person's
   *    judgement. They arrive on one socket and are applied by two paths,
   *    because they are two kinds of fact.
   */
  const applyPush = (event: AppEvent): void => {
    const current = latestRunRef.current ?? run;
    if (!current) return;

    if (event.type === 'finding.disposition_changed') {
      const payload = event.payload as DispositionChangedPayload;
      if (payload.reviewId !== current.id) return;
      // RULE 1. One comparison, and the load-bearing line in this file.
      const held = dispositionVersionFor(
        payload.reviewId, payload.findingsKey, payload.clauseId);
      if (payload.version <= held) return;
      // RULE 2. From the payload. No fetch.
      rememberPushedDisposition(payload.disposition, payload.event);
      // `findingsKey` IS the key `findingsKeyFor` produces — the document
      // id for a document review, the COLLECTION id for a collection one —
      // so handing it back through `findingsKeyFor` returns itself in both
      // cases. Never a member document chosen from a collection.
      applyToFinding(payload.findingsKey, payload.clauseId, finding => ({
        ...finding,
        verification: verificationFromDisposition(payload.disposition),
      }));
      return;
    }

    if (event.type === 'note.added') {
      const payload = event.payload as NoteAddedPayload;
      if (payload.reviewId !== current.id) return;
      // RULE 4. APPENDED, and by id: the same note arriving twice (a
      // replay, or a review AND a matter subscription both carrying it)
      // must not become two remarks on the record.
      applyToFinding(payload.findingsKey, payload.clauseId, finding => (
        finding.notes.some(n => n.id === payload.note.id)
          ? finding
          : { ...finding, notes: [...finding.notes, payload.note] }
      ));
    }
    if (event.type === 'assignment.created' || event.type === 'assignment.resolved') {
      const payload = event.payload as AssignmentEventPayload;
      if (payload.reviewId !== current.id) return;
      /*
       * A REQUEST ARRIVES, OR CLOSES, WITHOUT A RELOAD (§18 item 5).
       *
       * BY ID, and replacing rather than appending: the same event arriving
       * twice — a replay, or a review and a matter subscription both
       * carrying it — must not put one request on a card twice, and a
       * `resolved` must remove the row it names rather than sit beside it.
       * The socket's own guards drop a duplicate before this runs; this is
       * the second one, for the reason the note handler has a second one.
       *
       * NOT FILTERED BY ACTOR HERE, deliberately, and the filter is not
       * missing — it is applied where the local id is a LIVE value
       * (`ResultsView.assignmentsByClause`, `FindingCard`, both through
       * `assignmentParty`). This closure is captured by the subscription
       * effect at the moment the review opens, which is routinely before
       * `GET /v1/me` has answered; filtering on the id it could read there
       * would silently DROP a request addressed to the reader, and a
       * request that never arrives is the failure §18 item 5 is about.
       * Held here, filtered at render: the request appears the moment the
       * profile lands, and a bystander is told nothing either way.
       */
      setAssignments(held => {
        const without = held.filter(a => a.id !== payload.assignment.id);
        return payload.assignment.resolvedAt === undefined
          ? [...without, payload.assignment]
          : without;
      });
      return;
    }
    // RULE 5: a `run.*` event is not handled here at all. `watchRun` has
    // it, and routes it to `refreshFindings` exactly as it did over the
    // poll. Handling it in both places would refresh the findings twice
    // per cell.
  };

  /**
   * ONE SUBSCRIPTION PER OPEN REVIEW, and it is not the run's.
   *
   * `watchRun` subscribes to `{ run }` and only while a run is live. A
   * disposition change belongs to no run — a colleague can reject a finding
   * on a review that finished last week — so the card needs `{ review }`,
   * held for as long as the review is open.
   *
   * Guarded on the review ID CHANGING rather than on where this effect sits
   * in the file: React runs effects in declaration order, and the next
   * person to reorder two of them would otherwise break this with no test
   * failing near their change.
   */
  const reviewId = run?.id;
  useEffect(() => {
    if (!reviewId) return undefined;
    // The ROSTER for the same subscription, alongside the events. One
    // subscription, two things it carries; a second `subscribe` for presence
    // would be a second cursor over the same review.
    const offPresence = onPresence({ review: reviewId }, setPresence);
    /*
     * WHAT IS ALREADY OPEN, once, when the review opens.
     *
     * The socket carries what happens NEXT; a request made while this
     * browser was closed has no event it will ever receive, and a person
     * signing in to find nothing waiting is exactly the "a mechanism that
     * reaches nobody" failure §18 item 5 is about.
     *
     * A FAILURE IS SAID. `getOpenAssignments` rejects rather than resolving
     * to an empty list, and a silent empty list here would read as "nobody
     * has asked you anything" — which is the load-path rule this codebase
     * has under `describeLoadError`, at a surface where the cost is a
     * colleague waiting on an answer nobody knows was requested.
     */
    detach(readAssignments(reviewId), 'reading this review s open assignments');
    const subscription = subscribe({ review: reviewId }, {
      onEvent: applyPush,
      onResync: () => {
        // The events between this client's cursor and now are gone. The
        // findings map is the state they described, so it is re-read —
        // and SAID OUT LOUD, because a silent re-read is indistinguishable
        // from a screen that has stopped updating.
        setResyncing(true);
        detach(
          refreshFindings(reviewId).finally(() => setResyncing(false)),
          'resyncing the findings after a push gap');
      },
    });
    return () => {
      offPresence();
      // A closed review claims nobody. The roster it held was about a screen
      // this tab is no longer on, and so was every request on it.
      setPresence([]);
      setAssignments([]);
      setAssignmentsError(null);
      subscription.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reviewId]);

  const handleAddNote = async (docId: string, clauseId: string, text: string) => {
    const current = latestRunRef.current ?? run;
    if (!current) return;
    const key = findingsKeyFor(current.target, docId);
    if (!current.findings[key]?.[clauseId]) return;

    setVerifyBusyKey(findingKey(docId, clauseId));
    try {
      const note = await addNote(current.id, key, clauseId, text);
      applyToFinding(docId, clauseId, finding => ({
        ...finding, notes: [...finding.notes, note],
      }));
    } catch (e) {
      notify(e instanceof Error ? `This note was not saved: ${e.message}` : 'This note was not saved.', 'error');
    } finally {
      setVerifyBusyKey(null);
    }
  };

  /**
   * Accepts a collection clause's synthesised net position as written.
   *
   * `confirmPosition`/`amendPosition` (`@lexprompt/core`) are still the only
   * producers of a `NetPosition` — they now run on the SERVER, over the
   * stored position, with the authenticated actor and the server's clock.
   * The browser sends the ACTION. A body carrying the object itself could
   * state a confirmation with anybody's name on it, and *"a net position is
   * synthesised text no document contains"* is the one output where that
   * matters most.
   */
  /**
   * A REQUEST THE STORE ACTUALLY TOOK.
   *
   * Await-then-apply: `AssignPanel` hands this the row the server returned,
   * never the one it composed. The push will carry the same row to every
   * other reader; applying it here by id means this browser does not wait
   * for its own echo.
   */
  const handleAssigned = (assignment: AssignmentView) => {
    setAssignments(held => [...held.filter(a => a.id !== assignment.id), assignment]);
  };

  /** Closes one. The server refuses anybody but the assignee and the
   *  assigner, and the row is removed only after it confirms. */
  const handleResolveAssignment = async (id: string) => {
    try {
      await resolveAssignmentRequest(id);
      setAssignments(held => held.filter(a => a.id !== id));
    } catch (e) {
      notify(e instanceof Error
        ? `That request was not closed: ${e.message}`
        : 'That request was not closed.', 'error');
    }
  };

  const handleConfirmNetPosition = async (docId: string, clauseId: string) => {
    await writeNetPosition(docId, clauseId, { action: 'confirm' }, 'This confirmation');
  };

  /** Records the human's rewritten net position — a STRONGER claim than
   *  confirming, because a person wrote every word. An empty amendment is
   *  refused by `amendPosition` on the server, exactly as it was refused in
   *  the browser; the amend dialog already disables its own confirm button
   *  on whitespace, so that refusal is a backstop rather than the user's
   *  experience of the rule. */
  const handleAmendNetPosition = async (docId: string, clauseId: string, text: string) => {
    await writeNetPosition(docId, clauseId, { action: 'amend', text }, 'This amendment');
  };

  const writeNetPosition = async (
    docId: string,
    clauseId: string,
    action: { action: 'confirm' } | { action: 'amend'; text: string },
    subject: string,
  ): Promise<void> => {
    const current = latestRunRef.current ?? run;
    if (!current) return;
    const key = findingsKeyFor(current.target, docId);
    // Guarded on the POSITION and not just the finding: a standalone
    // document's finding has none at all, and absence is not "unconfirmed".
    if (!current.findings[key]?.[clauseId]?.netPosition) return;

    setVerifyBusyKey(findingKey(docId, clauseId));
    try {
      const { netPosition } = await setNetPosition(current.id, key, clauseId, action);
      applyToFinding(docId, clauseId, finding => ({ ...finding, netPosition }));
    } catch (e) {
      notify(
        e instanceof Error ? `${subject} was not saved: ${e.message}` : `${subject} was not saved.`,
        'error',
      );
    } finally {
      setVerifyBusyKey(null);
    }
  };

  /**
   * A RETRY IS ONE POST (Task 20).
   *
   * What the server owns now, and why each piece went:
   *
   *  - **The reset.** `resetVerification`/`resetPosition` ran in the browser
   *    as three writes it could not make atomic. Task 16 does it in ONE
   *    transaction, with a `finding_disposition_event` recording that it
   *    cleared — a history the browser never had.
   *  - **Re-hydrating the document for review.** `hydrateIdForReview` and
   *    `hydrateRecordForReview` are DELETED. This project's founding defect
   *    — reviewing a scan as though it said nothing — is guarded on the
   *    server now (Task 9), where the extraction happens. It must not end up
   *    living nowhere, which is why the deletion and the guard are the same
   *    change rather than two.
   *  - **The collection-retry refusal.** The server reads the collection
   *    record itself, and checks the key through `cellsFor` → `findingsKeyFor`:
   *    a collection target produces only the collection's own key, so a
   *    document id under one answers 404. There is no path by which a
   *    collection clause is retried through the single-document extractor.
   *  - **"The stored file could not be read."** Hydration reports failure as
   *    `parseError` server-side and the cell becomes an `error` finding
   *    naming the real cause, rather than the extractor blaming the document
   *    for having no content.
   *
   * What the BROWSER keeps is the notice — it is a message to the person who
   * clicked. It is composed from what the transaction says it CLEARED rather
   * than from this browser's own copy of the finding, so the sentence and
   * the write cannot disagree. Same three wordings, same rule.
   */
  const handleRetryCell = async (docId: string, clauseId: string) => {
    const current = latestRunRef.current ?? run;
    if (!current) return;
    const key = findingsKeyFor(current.target, docId);
    const existing = current.findings[key]?.[clauseId];
    if (!existing) return;
    const matterId = activeMatterId;

    // Mirrors `handleStartRun`: a retry is a fresh, live call, so a stale
    // `authErrorHandledRef` from an earlier run (or from opening a review
    // that already had one) must not suppress the notice if THIS run is the
    // one that gets rejected.
    authErrorHandledRef.current = false;

    // The cell reads as busy NOW, before the request. Built as a fresh
    // finding — the same shape the server will write — so a previous
    // attempt's error text or summary does not sit under a spinner. The
    // human-authored state is carried forward: the server's transaction is
    // what clears it, and until this request answers, nothing has.
    const busy = withUpdatedFinding(current, docId, clauseId, {
      clauseId,
      status: 'running',
      citations: [],
      verification: existing.verification ?? unchecked(),
      notes: existing.notes ?? [],
      ...(existing.netPosition ? { netPosition: existing.netPosition } : {}),
    });
    latestRunRef.current = busy;
    setRun(busy);

    let result: RetryResult;
    try {
      result = await retryCell(current.id, key, clauseId);
    } catch (e) {
      // NOTHING HAPPENED SERVER-SIDE, so nothing on screen may say it did.
      // The old `failRetryCell` wrote an `error` finding here because the
      // browser had already cleared the verification by then and the cell
      // was its own to close; a refused POST has changed no row, so putting
      // the finding back exactly as it was is the honest answer. What must
      // NOT happen is leaving the spinner up — this project has shipped a
      // cell that spins forever once already.
      latestRunRef.current = current;
      setRun(current);
      handleModelError(e);
      return;
    }

    // THE THREE WORDINGS, unchanged, composed from what the transaction
    // actually cleared.
    if (result.cleared.verification || result.cleared.netPosition) {
      const clauseTitle = current.templateSnapshot.clauses.find(c => c.id === clauseId)?.title
        ?? 'This clause';
      const clearedDescription = result.cleared.verification && result.cleared.netPosition
        ? 'verification and net position were'
        : result.cleared.netPosition
        ? 'net position was'
        : 'verification was';
      notify(`${clauseTitle} is being re-run, so its ${clearedDescription} cleared.`);
    }

    // The row is `pending` again and its judgement is cleared — read it back
    // rather than guessing at it, then watch the one-cell run to its end.
    await refreshFindings(current.id);
    if (matterId) attachRun(result.run, matterId);
  };

  const handleOpenMatter = (id: string) => {
    navigate({ name: 'matter', matterId: id });
  };

  const handleAddMatterDocuments = async (matterId: string, files: File[]) => {
    try {
      const profile = await getProfile();
      const parsed = await parseFiles(files);
      await Promise.all(parsed.map(doc => {
        const { record, bytes } = toDocumentRecord(doc, matterId, profile.id);
        return addDocument(record, bytes);
      }));
      await loadMatterDocuments(matterId);
      /*
       * THE TOAST REPORTS WHAT WAS STORED, NOT WHAT THIS BROWSER PARSED.
       *
       * It used to count `parsed.filter(d => d.parseError)` and say *"Added,
       * but could not be read — see the error next to each file."* Since
       * Task 9 the upload route DISCARDS the body's `text`, `parse_state`
       * and `parse_error` outright and writes the row `pending`
       * (`routes/documents.ts`); a parse worker reads the bytes and is the
       * only writer of that state. So the toast could call a document
       * unreadable while the list beside it correctly said *"Still being
       * read"* — and while the server then read it perfectly well. Task 24
       * reconciled `DocumentNotices` and the row icon with "still being read
       * is not unreadable"; this was the one place in the add path left
       * saying the opposite.
       *
       * A browser-side parse failure is not thrown away, it is just not this
       * sentence's to report: the server reaches its own verdict on the same
       * bytes, and `DocumentNotices` says so per document, by name, once it
       * has. What the toast can honestly say is that the files are stored
       * and are being read.
       */
      notify(parsed.length === 1
        ? 'Document added. Its text is being read — the list says when it is ready.'
        : `${parsed.length} documents added. Their text is being read — the list says when they `
          + 'are ready.');
    } catch (e) {
      notify(e instanceof Error ? e.message : 'Could not add the document(s).', 'error');
    }
  };

  const handleRemoveMatterDocument = async (matterId: string, documentId: string) => {
    try {
      await deleteDocument(documentId);
      await loadMatterDocuments(matterId);
      notify('Document removed.');
    } catch (e) {
      notify(e instanceof Error ? e.message : 'Could not remove the document.', 'error');
    }
  };

  /**
   * Groups the chosen standalone documents into a new collection (Task 7).
   * Two separate writes, not one transaction — a collection and its members'
   * roles are written by two different routes, so nothing here can make them
   * atomic. The order matters for the failure case: the collection is saved
   * FIRST, so if a member's role update then fails partway, retrying this
   * action (or ungrouping) still has a real collection record to work from
   * rather than orphaned document roles pointing at nothing.
   *
   * Document role updates run in parallel via `setDocumentRole` — never a
   * hand-rolled write here, so grouping and ungrouping can't drift on how
   * a document's collection membership is actually persisted.
   */
  const handleCreateCollection = async (
    matterId: string,
    params: { name: string; baseDocumentId: string; variesDocumentIds: string[] },
  ) => {
    try {
      const profile = await getProfile();
      const collection = newCollection(matterId, params.name, params.baseDocumentId, profile.id);
      collection.variesDocumentIds = params.variesDocumentIds;
      await saveCollection(collection);
      await Promise.all([
        setDocumentRole(params.baseDocumentId, 'base', collection.id),
        ...params.variesDocumentIds.map(id => setDocumentRole(id, 'varies', collection.id)),
      ]);
      await Promise.all([loadMatterDocuments(matterId), loadMatterCollections(matterId)]);
      notify('Collection created.');
    } catch (e) {
      notify(e instanceof Error ? e.message : 'Could not create this collection.', 'error');
    }
  };

  /**
   * Ungroups a collection: every member document reverts to `standalone`
   * FIRST, and only once that has actually succeeded is the collection
   * record itself deleted. That order means a failure partway through
   * still leaves every already-reverted document visible in the
   * standalone list (never omitted — it just isn't lost track of even on
   * a partial failure), rather than deleting the collection first and
   * risking documents stuck claiming a `collectionId` that resolves to
   * nothing. Documents are never deleted, in either order (spec §8).
   */
  const handleUngroupCollection = async (matterId: string, collectionId: string) => {
    try {
      const collection = matterCollections.find(c => c.id === collectionId) ?? await getCollection(collectionId);
      if (!collection) {
        notify('This collection could not be found.', 'error');
        return;
      }
      const memberIds = [collection.baseDocumentId, ...collection.variesDocumentIds];
      const presentIds = new Set(matterDocuments.map(d => d.id));
      await Promise.all(
        memberIds.filter(id => presentIds.has(id)).map(id => setDocumentRole(id, 'standalone')),
      );
      await deleteCollection(collectionId);
      await Promise.all([loadMatterDocuments(matterId), loadMatterCollections(matterId)]);
      notify('Collection ungrouped. Its documents are unaffected.');
    } catch (e) {
      notify(e instanceof Error ? e.message : 'Could not ungroup this collection.', 'error');
    }
  };

  /**
   * Repairs a collection whose base document was deleted, by promoting one
   * of its surviving members to base (spec §8's "choose a new base"; the
   * card's own "or ungroup" is just `handleUngroupCollection` above). Never
   * inferred — `newBaseDocumentId` is always a document the user clicked by
   * name on `CollectionCard`, never the "first surviving member" chosen
   * for them.
   */
  const handleRepairCollection = async (matterId: string, collectionId: string, newBaseDocumentId: string) => {
    try {
      const collection = matterCollections.find(c => c.id === collectionId) ?? await getCollection(collectionId);
      if (!collection) {
        notify('This collection could not be found.', 'error');
        return;
      }
      const updated: Collection = {
        ...collection,
        baseDocumentId: newBaseDocumentId,
        variesDocumentIds: collection.variesDocumentIds.filter(id => id !== newBaseDocumentId),
      };
      await saveCollection(updated);
      await setDocumentRole(newBaseDocumentId, 'base', collectionId);
      await Promise.all([loadMatterDocuments(matterId), loadMatterCollections(matterId)]);
      notify('Collection repaired.');
    } catch (e) {
      notify(e instanceof Error ? e.message : 'Could not repair this collection.', 'error');
    }
  };

  /**
   * "Run a review" from Matter Home: the existing run flow (RunPanel →
   * handleStartRun), pre-seeded with this matter's own documents rather
   * than requiring them to be re-uploaded. Each is rebuilt from its stored
   * bytes through `documentFileForViewing` — page images are never
   * persisted, and since Task 20 nothing the browser builds is handed to an
   * extractor, so there is nothing here for them to be regenerated FOR. The
   * server hydrates for review itself, where the extraction happens.
   *
   * Task 7 widens this with an optional `target`. Omitted, this is
   * UNCHANGED — every line below runs exactly as it always did, over
   * every one of the matter's documents, into the RunPanel preview screen.
   * A collection target instead hydrates only that collection's present
   * members (through the SAME hydration the standalone path uses) and
   * calls
   * `handleStartRun` directly with the built `CollectionRunInput` — there
   * is no RunPanel step for a collection: its document set is the
   * collection's own ordered members, not something to preview or add
   * loose uploads to.
   */
  const handleRunReviewForMatter = async (matterId: string, playbook: Playbook, target?: ReviewTarget) => {
    const template = await contentForRun(playbook);
    if (!template) return;
    if (target && isCollectionTarget(target)) {
      try {
        const collection = matterCollections.find(c => c.id === target.collectionId) ?? await getCollection(target.collectionId);
        if (!collection) {
          notify('This collection could not be found.', 'error');
          return;
        }
        const recordById = new Map(matterDocuments.map(d => [d.id, d]));
        const presentRecords = [collection.baseDocumentId, ...collection.variesDocumentIds]
          .map(id => recordById.get(id))
          .filter((r): r is DocumentRecord => !!r);
        const reading = notYetReadNames(presentRecords);
        if (reading.length > 0) {
          notify(notYetReadMessageFor(reading), 'error');
          return;
        }
        const unreadable = couldNotBeReadNames(presentRecords);
        if (unreadable.length > 0) {
          notify(couldNotBeReadMessageFor(unreadable), 'error');
          return;
        }
        const hydrated = await Promise.all(presentRecords.map(hydrateRecordForViewing));
        const members = orderedMembers(collection, hydrated);
        if (!members[0]?.document) {
          // The base is missing — `CollectionCard` already offers this
          // action disabled for exactly this reason, but `matterDocuments`
          // could have gone stale (another tab, another tick) between that
          // render and this click, and starting a review that will fail
          // every clause is worse than refusing it here too.
          notify('This collection is missing its base document, so it cannot be reviewed. Repair it first.', 'error');
          return;
        }
        setActiveTemplate(template);
        setActiveMatterId(matterId);
        setRun(null);
        await handleStartRun(hydrated, { template, matterId, collection: { target, members } });
      } catch (e) {
        notify(e instanceof Error ? e.message : 'Could not prepare this collection for review.', 'error');
      }
      return;
    }

    try {
      const reading = notYetReadNames(matterDocuments);
      if (reading.length > 0) {
        notify(notYetReadMessageFor(reading), 'error');
        return;
      }
      const unreadable = couldNotBeReadNames(matterDocuments);
      if (unreadable.length > 0) {
        notify(couldNotBeReadMessageFor(unreadable), 'error');
        return;
      }
      const docs = await Promise.all(matterDocuments.map(hydrateRecordForViewing));
      setActiveTemplate(template);
      setActiveMatterId(matterId);
      setRun(null);
      setDocuments(docs);
      setRunPanelKey(k => k + 1);
      requestView('run');
    } catch (e) {
      notify(e instanceof Error ? e.message : 'Could not prepare this matter’s documents for review.', 'error');
    }
  };

  const handleOpenReview = (matterId: string, review: Review) => {
    navigate({ name: 'review', matterId, reviewId: review.id });
  };

  const handleDeleteMatterFromHome = async (id: string) => {
    const ok = await handleDeleteMatter(id);
    // Never strand the user on a dead screen: only leave `matter` if the
    // delete actually succeeded (handleDeleteMatter already reported a
    // failure via toast; the modal in MatterHome stays open to retry).
    if (ok) requestView('matters');
  };

  // --- Sub-project E: the three authoring routes -------------------------
  //
  // `Create Template` opens the chooser; the chooser is the only entrance
  // to any of them. Every one of these screens existed and was unit-tested
  // before this wiring, and none of them was reachable from the running
  // app — the "correct mechanism with no path to it" shape, which is why
  // `App.authoring.test.tsx` drives the whole route from the library card
  // to the published playbook rather than testing the pieces again.

  /** Build by hand: D's editor on a brand-new, empty, unsaved playbook.
   *  The identity is minted here and written only by the editor's Save,
   *  exactly as it was before — nothing is persisted by opening. */
  const handleBuildByHand = () => {
    const draft = newPlaybookDraft('Untitled playbook');
    const identity = newTemplate(draft.name);
    setActivePlaybook(identity);
    // Nothing published yet, so the editor has no version to show for
    // reference and everything it holds is an unpublished draft.
    setActiveVersion(null);
    setActiveDraft(draft);
    // Never-saved: any further edit (or none at all) counts as unsaved, so
    // closing the editor immediately still asks before discarding
    // (Important 7).
    setSavedTemplateSnapshot(null);
    setChooserOpen(false);
    navigate({ name: 'playbook', playbookId: identity.id });
  };

  const handleDraftWithAI = () => {
    setChooserOpen(false);
    if (!ensureConfigured('Choose a model in Settings to draft a playbook.')) return;
    setAuthoringError(undefined);
    setAuthoringAuthFailed(false);
    setView('authoring-form');
  };

  /**
   * Generation. On failure the form STAYS MOUNTED with everything the user
   * typed (spec §7) — this sets an error and nothing else, and never
   * unmounts `DraftForm`, which is what keeps its `useState`-seeded fields
   * intact. A 401/403 is handed to the form as `authFailed` so it can route
   * to Settings; an ordinary failure is not, or every 502 would send
   * someone off to fix a key that was never the problem.
   *
   * The few-shot material is assembled here rather than inside
   * `generateDraft` because it is the only part that reads the stores: the
   * selected playbooks' current versions, and the selected matters'
   * reviews. `buildFewShot` then applies the rule that matters — a matter
   * contributes its VERIFIED findings only.
   */
  const handleGenerateDraft = async (form: DraftFormValues, sources: FewShotSource[]) => {
    const generation = new AbortController();
    authoringGenerationRef.current?.abort();
    authoringGenerationRef.current = generation;
    setAuthoringBusy(true);
    setAuthoringError(undefined);
    setAuthoringAuthFailed(false);
    try {
      const versions = (await Promise.all(
        sources.filter(s => s.kind === 'playbook').map(s => getPlaybookContent(s.id)),
      )).filter((v): v is PlaybookVersion => v !== null && v !== undefined);
      const reviews = (await Promise.all(
        sources.filter(s => s.kind === 'matter').map(s => listReviews(s.id)),
      )).flat();
      const fewShot = buildFewShot(templates, versions, reviews, sources);
      // m2 (final honesty review): `learnedFrom` must name only sources
      // that actually contributed material, not every source the user
      // ticked — a matter with zero verified findings is the common case,
      // and crediting it as having "taught" the draft overstates what
      // happened.
      const usedSources = usedFewShotSources(templates, versions, reviews, sources);

      const draft = await generateDraft(form, fewShot, usedSources, settings, generation.signal);
      // Abandoned: the user left the authoring flow while this was in the
      // air. Setting the draft and the view here would MOVE THEM — out of
      // whatever screen they navigated to, past `requestView`'s
      // `confirmDiscardIfDirty` and past `confirmLeaveTemplate`'s three-way
      // prompt, taking a playbook editor's unpublished edits with it (Major
      // 5). A result nobody is waiting for is dropped, not delivered.
      if (generation.signal.aborted) return;
      updateAuthoringDraft(draft);
      setView('authoring-review');
    } catch (e) {
      // Same rule for the failure path: an error banner belongs to the form,
      // and the form is gone. (`App`'s own AbortError handling elsewhere
      // reads the same way — a cancelled request is not a failure.)
      if (generation.signal.aborted) return;
      if (isAuthFailure(e)) {
        // `DraftForm` (unmodified by this task) only needs to know THAT
        // this was an auth-class failure, to hide its own inline error box
        // (its "authFailed" contract predates the split and only supports
        // an on/off signal) — the actual sentence and any routing decision
        // happens here, where the real `ModelError` is still in scope.
        setAuthoringAuthFailed(true);
        handleModelError(e);
      } else {
        setAuthoringError(
          e instanceof Error ? e.message : 'The playbook could not be drafted. Try again.',
        );
      }
    } finally {
      if (authoringGenerationRef.current === generation) authoringGenerationRef.current = null;
      if (!generation.signal.aborted) setAuthoringBusy(false);
    }
  };

  /** `DraftReview` has already confirmed (spec §7). This leaves by
   *  `navigate` rather than `requestView` deliberately: `setAuthoringDraft`
   *  does not update the value `confirmDiscardIfDirty` closes over until
   *  the next render, so routing the discard through the guard would ask a
   *  second time about a draft the user has just agreed to throw away. */
  const handleDiscardDraft = () => {
    updateAuthoringDraft(null);
    navigate({ name: 'playbooks' });
  };

  /**
   * The one moment an authoring draft becomes durable. `saveDraftAsV1`
   * re-checks the save gate itself and publishes through D's atomic
   * `publishAndPoint`; on success we open the published playbook in D's
   * editor, which is the whole point of the route — a playbook you can
   * immediately edit and run, not a dead end.
   *
   * A failure leaves the draft exactly as it was, on this screen, so the
   * reviewer can retry without losing the reviewing they have done.
   */
  const handleSaveDraftAsV1 = async () => {
    if (!authoringDraftRef.current) return;
    setSavingAuthoringDraft(true);
    try {
      const profile = await getProfile();
      // Read AFTER the await, not before: `DraftReview` commits whatever is
      // typed into the clause editor on its way into this call, and that
      // commit lands in the ref one tick before this function's own render
      // closure would ever see it (Major 4). Everything that could change it
      // from here on is disabled for the duration of the publish.
      const draft = authoringDraftRef.current;
      if (!draft) return;
      const { playbook, version } = await saveDraftAsV1(
        draft,
        draft.contractType,
        profile.id,
      );
      updateAuthoringDraft(null);
      await refreshTemplates();
      navigate({ name: 'playbook', playbookId: playbook.id });
      // The number comes from what was actually published, not from the
      // "v1" in this function's name — R-D15's rule that a version claim is
      // read from the record rather than asserted by the code that hoped
      // to write it.
      notify(`Published v${version.version}.`);
    } catch (e) {
      if (isAuthFailure(e)) handleModelError(e);
      else notify(e instanceof Error ? e.message : 'The playbook could not be saved.', 'error');
    } finally {
      setSavingAuthoringDraft(false);
    }
  };

  /**
   * Publishing freezes the draft into an immutable version.
   *
   * The change summary comes from `PublishDialog`, which asks for it and
   * refuses without one from v2 onwards — the same rule `publishVersionIn`
   * enforces in the store, asked BEFORE the write rather than surfaced as a
   * toast afterwards. Task 3's stopgap header field is gone with it; two
   * homes for one field is how they drift apart.
   *
   * `publishAndPoint` rather than `publishVersion` + `savePlaybook`: those
   * were two transactions, and a failure in the window between them left an
   * orphaned version and a gap in the version numbering (Minor 1). It also
   * clears any stored draft, which the two-call form did not.
   *
   * On success `activeDraft` becomes null: the edits are IN the version
   * now, so anything still calling itself a draft would keep the editor
   * reading "unpublished changes" over content that is published.
   */
  const handlePublishTemplate = async (changeSummary: string) => {
    if (!activePlaybook || !activeDraft) return;
    setPublishing(true);
    try {
      const profile = await getProfile();
      const { playbook: saved, version } = await publishAndPoint(
        activePlaybook, { ...activeDraft, changeSummary }, profile.id,
      );
      setActivePlaybook(saved);
      setActiveVersion(version);
      setActiveDraft(null);
      // Minor 6: the same fix as `loadPlaybookForEdit`'s, for the same
      // reason. The baseline has to be the WORKING CONTENT a next edit will
      // be compared against (a fresh copy of the version just published),
      // not the literal string "null" — which a real draft object's
      // `JSON.stringify` can never equal again, latching `isTemplateDirty`
      // true for the rest of the session on the very next keystroke.
      setSavedTemplateSnapshot(JSON.stringify(workingContent(version)));
      setPublishOpen(false);
      await refreshTemplates();
      notify(`Published v${version.version}.`);
    } catch (e) {
      // The dialog stays open: the change summary the user just typed is in
      // it, and closing it would make them type it again.
      notify(e instanceof Error ? e.message : 'Could not publish the playbook.', 'error');
    } finally {
      setPublishing(false);
    }
  };

  // --- Sub-project F: learning from redlines (Task 10A wiring) -----------
  //
  // `RouteChooser`'s "Learn from redlines" card is the ONLY entrance to any
  // of the four screens below, exactly as it is the only entrance to E's
  // two authoring screens — see `handleDraftWithAI`/`handleBuildByHand`
  // above for the model this follows.
  //
  // Where this MEETS E, rather than differing from it (Task 10A-fix, spec
  // §4.8: adopt/reword/not-a-house-rule "feeding into E's draft-review
  // surface and D's publish path"). The adopted and reworded positions
  // become an ordinary `AuthoringDraft` — `positionsToDraft` is the whole
  // conversion — and from `authoring-review` onwards this flow IS E's:
  // the same `DraftReview`, the same `canSaveDraft` gate, the same
  // `saveDraftAsV1` publishing a genuine v1 through one atomic
  // `publishAndPoint`. There is no second "positions become a playbook"
  // pipeline, and no version is written before a person has been through
  // that review.
  //
  // Spec §9's changeset mechanism (`buildChangeset` → `ChangesetReview` →
  // `publishChangeset`) is F's OTHER entry point: a new deal read against a
  // playbook version that already exists, where `confirm`/`drift`/
  // `new_clause` are meaningful because there is a real prior version to be
  // meaningful against. It is built, tested and currently unreached — this
  // app has no "test a deal against a playbook" screen yet — and it stays
  // that way rather than being reached from here through a fabricated empty
  // v1, which is what Task 10A did.

  const handleLearnFromRedlines = () => {
    setChooserOpen(false);
    if (!ensureConfigured('Choose a model in Settings to learn from redlines.')) return;
    setRedlinesError(undefined);
    setView('redlines-intake');
  };

  /**
   * Reads a freshly-picked batch of files AND stores them in this session's
   * precedent set (spec §11.1).
   *
   * **Never through `addDocument`.** That is the MATTER ingest path, and a
   * precedent going through it would be another client's marked-up lease
   * sitting in a matter's document list — the failure S23 exists to prevent.
   * `uploadPrecedent` is the other path: same multipart shape, same
   * server-side ingest, a `kind = 'precedent'` row with no matter and a
   * check constraint that makes the other shape unwritable.
   *
   * The parse stays HERE. `docxRedlines.ts` reads the `.docx`'s OOXML
   * directly (never through `mammoth`, which silently discards `<w:ins>` and
   * `<w:del>`), it needs the raw bytes, and they are already in hand.
   * `parseFile` (`lib/documents.ts`) is called for every file, not only
   * PDFs, so a `.docx` whose tracked changes cannot be read still has SOME
   * text available if the user offers the diff fallback for it.
   *
   * **A file whose upload fails does not join the session.** The screen says
   * these documents are stored; a document sitting in the list that is not
   * stored would make that sentence false for it, quietly, with the person
   * who chose it none the wiser. So the failures are named and the files are
   * refused — loud and recoverable rather than quietly wrong.
   *
   * A `.docx` is additionally read for tracked changes via
   * `parseDocxRedlines`. That function distinguishes "no markup" from
   * "could not read" by throwing on the latter (see its own doc comment) —
   * exactly the distinction spec §8 requires: a throw here routes the
   * document to `redlinesUnreadable`, offering the diff fallback explicitly
   * (`onOfferDiff`) rather than silently reporting it as clean. A non-`.docx`
   * file (a PDF chief among them) has no OOXML to read at all, so it goes
   * straight to that same bucket — never silently treated as "no tracked
   * changes found", which would be indistinguishable from a real, clean
   * `.docx`.
   *
   * `proposeChains`/`proposeRole` run once per BATCH, over only the
   * newly-added files — never re-run over documents already in
   * `redlinesDocs`. Re-running over the whole list on every add would
   * re-mint every document's `chainId` from scratch each time, silently
   * undoing an earlier `onRejectChain` (spec §8: "a chain the user rejects
   * is ungrouped, not re-proposed").
   */
  const handleAddRedlinesFiles = async (files: File[]) => {
    if (files.length === 0) return;
    setRedlinesBusy(true);
    setRedlinesError(undefined);
    try {
      const parsed = await Promise.all(files.map(async (file) => {
        const id = uid();
        const parsedFile = await parseFile(file);
        const text = parsedFile.text;
        const isDocx = /\.docx$/i.test(file.name);
        let edits: ParsedEdit[] = [];
        let hasMarkup = false;
        let markupError: string | undefined;
        if (!isDocx) {
          markupError = 'This file has no tracked changes to read — compare it against another version instead.';
        } else {
          try {
            const result = await parseDocxRedlines(file);
            edits = result.edits;
            hasMarkup = result.hasMarkup;
          } catch (e) {
            markupError = e instanceof Error ? e.message : 'Its tracked changes could not be read.';
          }
        }
        return { id, file, name: file.name, text, edits, hasMarkup, markupError };
      }));

      // ---- Stored, before anything reaches the screen. ----
      //
      // The set is created lazily, on the first batch, so opening the screen
      // and leaving mints nothing. Its id is the SESSION's id for each
      // document (`p.id`), because `InferredPosition.basis` is keyed by that
      // id and `position_basis` has to resolve it a year later.
      const setId = redlinesSetIdRef.current ?? await (async () => {
        const created = await createPrecedentSet(newPrecedentSet(
          redlinesContractType.trim() || `Precedents brought in with ${files[0].name}`));
        redlinesSetIdRef.current = created.id;
        return created.id;
      })();
      const stored = await Promise.all(parsed.map(async (p) => {
        try {
          await uploadPrecedent(setId, {
            id: p.id,
            precedentSetId: setId,
            name: p.name,
            kind: /\.pdf$/i.test(p.name) ? 'pdf' : /\.docx$/i.test(p.name) ? 'docx' : 'txt',
            text: p.text,
            byteSize: p.file.size,
            addedAt: Date.now(),
            // Read and DISCARDED by the route, which attributes the upload to
            // the authenticated actor.
            addedByUserId: '',
            storedAs: 'precedent',
          }, p.file);
          return { p, error: undefined as string | undefined };
        } catch (e) {
          return { p, error: e instanceof Error ? e.message : 'it could not be stored.' };
        }
      }));
      const rejected = stored.filter(s => s.error);
      if (rejected.length > 0) {
        setRedlinesError(
          `${rejected.map(s => s.p.name).join(', ')} could not be stored, so ${
            rejected.length === 1 ? 'it has' : 'they have'} not been brought in: ${
            rejected[0].error}`);
      }
      const kept = new Set(stored.filter(s => !s.error).map(s => s.p.id));
      const parsedAndStored = parsed.filter(p => kept.has(p.id));

      const readable = parsedAndStored.filter(p => !p.markupError);
      const unreadable = parsedAndStored.filter(p => p.markupError);

      const proposed = proposeChains(readable.map((p) => {
        const { role, inferred } = proposeRole(p.name, p.hasMarkup);
        return { id: p.id, name: p.name, role, roleInferred: inferred } satisfies PrecedentDocument;
      }));

      // Only the files that actually stored. A session entry for a document
      // the server never took would let the diff fallback and the inference
      // run over evidence nothing can resolve afterwards.
      for (const p of parsedAndStored) {
        redlinesFilesRef.current.set(p.id, { file: p.file, text: p.text, edits: p.edits, source: 'tracked' });
      }

      setRedlinesDocs(prev => [...prev, ...proposed]);
      if (unreadable.length > 0) {
        setRedlinesUnreadable(prev => [
          ...prev,
          ...unreadable.map(p => ({ id: p.id, name: p.name })),
        ]);
      }
    } catch (e) {
      setRedlinesError(e instanceof Error ? e.message : 'These documents could not be read.');
    } finally {
      setRedlinesBusy(false);
    }
  };

  const handleSetRedlinesRole = (document: PrecedentDocument, role: PrecedentRole) => {
    // The ONLY place `roleInferred` becomes `false` (R-F4) — every proposal
    // from `proposeRole` arrives `inferred: true`, and only a human clicking
    // Confirm or picking a role here turns that into a stated fact.
    setRedlinesDocs(prev => prev.map(d => (d.id === document.id ? { ...d, role, roleInferred: false } : d)));
  };

  /**
   * Takes a document back out of the session — and out of storage.
   *
   * The stored delete is not optional tidying. The intake screen says these
   * documents are kept "with the playbook you build from them"; a document
   * the person explicitly removed belongs to no playbook, and leaving it
   * stored would make that sentence false in the quiet direction for the one
   * document they went out of their way to reject.
   *
   * The screen state is cleared FIRST and unconditionally: the person asked
   * for it gone, and a storage failure must not leave it sitting in the list
   * looking like the click did nothing. A failure is reported instead, so an
   * administrator can be told rather than the bytes silently surviving.
   */
  const handleRemoveRedlinesDocument = (document: PrecedentDocument) => {
    redlinesFilesRef.current.delete(document.id);
    setRedlinesDocs(prev => prev.filter(d => d.id !== document.id));
    setRedlinesUnreadable(prev => prev.filter(d => d.id !== document.id));
    void deletePrecedentDocument(document.id).catch((e: unknown) => {
      setRedlinesError(
        `${document.name} was removed from this session, but its stored copy could not be `
        + `deleted: ${e instanceof Error ? e.message : String(e)}`);
    });
  };

  /** Spec §8: "a chain the user rejects is ungrouped, not re-proposed."
   *  Giving every member of the chain its own fresh, unique `chainId` is
   *  what makes it render as standalone cards from here on — and since
   *  `handleAddRedlinesFiles` never re-chains documents already in
   *  `redlinesDocs`, nothing later re-groups them. */
  const handleRejectRedlinesChain = (chainId: string) => {
    setRedlinesDocs(prev => prev.map(d => (d.chainId === chainId ? { ...d, chainId: uid() } : d)));
  };

  /**
   * Spec §8: the diff fallback is OFFERED, never substituted silently — this
   * only ever runs from `PrecedentIntake`'s explicit "Compare versions
   * instead" click. Pairs the unreadable document against another document
   * already brought into this session as the "earlier" side; when nothing
   * else has been added yet, it says so rather than guessing a pairing.
   */
  const handleOfferRedlinesDiff = (document: UnreadableDocument) => {
    if (!document.id) return;
    const laterEntry = redlinesFilesRef.current.get(document.id);
    if (!laterEntry) return;
    const earlierDoc = redlinesDocs.find(d => d.id !== document.id);
    if (!earlierDoc) {
      notify('Add another document first — there is nothing yet to compare this one against.', 'error');
      return;
    }
    const earlierEntry = redlinesFilesRef.current.get(earlierDoc.id);
    if (!earlierEntry) return;
    try {
      const units = diffExtractedText(earlierEntry.text, laterEntry.text);
      const edits: ParsedEdit[] = units.map(u => ({ kind: 'insertion', text: u.text, context: u.text }));
      redlinesFilesRef.current.set(document.id, { ...laterEntry, edits, source: 'diff' });
      const { role, inferred } = proposeRole(document.name, false);
      setRedlinesDocs(prev => [...prev, { id: document.id!, name: document.name, role, roleInferred: inferred, chainId: uid() }]);
      setRedlinesUnreadable(prev => prev.filter(u => u.id !== document.id));
      notify(`Compared against ${earlierDoc.name} — ${edits.length} difference${edits.length === 1 ? '' : 's'} found.`);
    } catch (e) {
      notify(e instanceof Error ? e.message : 'These documents could not be compared.', 'error');
    }
  };

  /** All edits read so far, across every document currently in
   *  `redlinesDocs`, tagged with the `documentId`/`source` `inferPositions`
   *  and `buildChangeset` both need. Shared by the intake summary line and
   *  `handleRedlinesContinueToLearning` below, so the count shown on screen
   *  and the count actually sent to the model can never drift apart. */
  const redlinesEditEntries = redlinesDocs.flatMap((doc) => {
    const entry = redlinesFilesRef.current.get(doc.id);
    if (!entry) return [];
    return entry.edits.map(edit => ({ documentId: doc.id, edit, source: entry.source }));
  });
  const redlinesDocumentNames: Record<string, string> = Object.fromEntries(
    redlinesDocs.map(d => [d.id, d.name]),
  );

  /**
   * Precedent intake → "What we learned" (spec §6, §7). `unamendedClauses`
   * is passed empty: this session has no pre-existing clause list to check a
   * document against (it is building a playbook FROM these redlines, not
   * reading them against one that already exists) — `inferPositions` reads
   * that as "nothing to ask an open question about" and returns
   * `questions: []`, which is the honest answer given there is no clause
   * list this wiring can derive one from, not a guessed one.
   *
   * The screen is told WHY (`REDLINES_NO_QUESTIONS_REASON`) rather than
   * left to render its "nothing the redlines raised without also settling
   * it" empty state, which would claim a search that never ran. The fix for
   * an empty open-questions block is never to invent questions to fill it.
   */
  const handleRedlinesContinueToLearning = async () => {
    setRedlinesBusy(true);
    setRedlinesError(undefined);
    try {
      const { positions, questions } = await inferPositions(redlinesEditEntries, [], settings);
      setRedlinesPositions(positions);
      setRedlinesQuestions(questions);
      setView('redlines-learned');
    } catch (e) {
      if (isAuthFailure(e)) handleModelError(e);
      else setRedlinesError(e instanceof Error ? e.message : 'Positions could not be inferred from these documents.');
    } finally {
      setRedlinesBusy(false);
    }
  };

  /** The one writer of a position's disposition — shared by `WhatWeLearned`
   *  and `TheWorkings`, which both offer the same three actions over the
   *  same position, so the two screens cannot drift on what "adopt" means.
   *  Updates `redlinesWorkingsPosition` too, when it is the position being
   *  acted on, so the workings screen reflects a reword made from itself
   *  without requiring a round-trip back to "what we learned". */
  const handleRedlinesDisposition = (
    position: InferredPosition,
    disposition: InferredPosition['disposition'],
    rewordedText?: string,
  ) => {
    const apply = (p: InferredPosition): InferredPosition =>
      (p.id === position.id ? { ...p, disposition, ...(rewordedText !== undefined ? { rewordedText } : {}) } : p);
    setRedlinesPositions(prev => prev.map(apply));
    setRedlinesWorkingsPosition(prev => (prev ? apply(prev) : prev));
  };

  /**
   * "What we learned" → E's draft review (spec §4.8, §7). The hand-off, and
   * the only thing standing between an adopted position and a playbook.
   *
   * Synchronous, and it writes NOTHING: no playbook, no version, no
   * changeset, no model call. It converts the adopted and reworded
   * positions into an `AuthoringDraft` (`positionsToDraft`) and moves to
   * `authoring-review`, from which point this is E's flow unchanged —
   * `DraftReview`, `canSaveDraft`'s gate, and `saveDraftAsV1` publishing a
   * genuine v1 in one atomic `publishAndPoint`. Abandon the flow here and
   * nothing has been created, which is the property Task 10A's mint-an-
   * empty-v1-first ordering could not have.
   *
   * Only ADOPTED and REWORDED positions travel (`includedPositions`) — a
   * rejected position ("not a house rule") and an undecided one contribute
   * no clause at all, so the control actually keeps them out of the
   * playbook rather than merely hiding a button.
   *
   * Refuses rather than proceeding when nothing was adopted: E's save gate
   * (`canSaveDraft`) requires at least one KEPT clause, so a zero-clause
   * draft is one that could never be saved — sending someone to a review
   * screen they cannot leave by the front door is the "unfinishable state"
   * shape CLAUDE.md lists among this project's own defects.
   *
   * Also refuses without a playbook name (a ruling on a gap Task 10A-fix
   * left open, R-F-fix-1): `redlinesContractType` is collected on
   * `PrecedentIntake`, beside the documents, but intake itself does not
   * require it — someone should be able to bring documents in and explore
   * what the redlines say before committing to a name. This is the point
   * mirroring `DraftForm`'s own `canSubmit` gate (`contractType.trim() !==
   * ''`) that actually creates the `AuthoringDraft`: exactly where E blocks
   * on the same field for the same reason, not a second, differently-shaped
   * gate. Checked AFTER "nothing adopted" so a session with neither problem
   * yet sees the more fundamental one first.
   */
  const handleRedlinesToDraftReview = () => {
    const included = includedPositions(redlinesPositions);
    if (included.length === 0) {
      setRedlinesError(
        'Nothing has been adopted yet. Adopt or reword at least one position — a playbook needs at ' +
        'least one clause a person stood behind.',
      );
      return;
    }
    const contractType = redlinesContractType.trim();
    if (contractType === '') {
      setRedlinesError(
        'This playbook needs a name before it can be saved. Go back to the documents screen and name it — ' +
        'that names the playbook you are about to create, not the documents themselves.',
      );
      return;
    }
    setRedlinesError(undefined);
    // Set the draft and the view in one batch, exactly as
    // `handleGenerateDraft` does: the authoring reset effect is keyed on
    // the view and sees `authoring-review` here, so it returns rather than
    // clearing the draft that was just set (CLAUDE.md's effect-ordering
    // hazard). Leaving the redlines views does clear this session's
    // documents and positions, which is correct — they have been read into
    // the draft, and the `File`s were never to be kept.
    // `modelProvenanceName`, never `modelChoiceId`: the id is an
    // operator-defined alias an administrator can repoint, and this value is
    // printed by `positionProvenance` into every export of the playbook.
    // The evidence carried forward with the draft (§6.5). Present only when
    // this session actually stored a precedent set — which it always has by
    // this point, since a document cannot reach the session without being
    // stored, but `positionsToDraft` takes it as optional so a caller with no
    // set records no basis rather than an empty one claiming evidence was
    // looked for.
    const setId = redlinesSetIdRef.current;
    const evidence = setId === undefined ? undefined : {
      precedentSetId: setId,
      // Per DOCUMENT, from the session's own record of how each one's edits
      // were read — `docxRedlines` tracked changes, or `pdfRedlineDiff`'s
      // fallback. A diff never wears a tracked change's confidence, and this
      // is the last point at which that distinction is still in hand.
      documentSource: Object.fromEntries(
        [...redlinesFilesRef.current].map(([id, entry]) => [id, entry.source])),
    };
    updateAuthoringDraft(
      positionsToDraft(
        included, redlinesDocumentNames, modelProvenanceName(settings), contractType, evidence),
    );
    setView('authoring-review');
  };

  /**
   * "Where did this house rule come from?" — the stored `position_basis`
   * (server §6.5), read months after the session that produced it.
   *
   * This is the ENTRY POINT that mechanism exists for. Without it the whole
   * of `position_basis` would be a correct implementation with no path to
   * it, which is this project's most-recorded defect: §11.1's argument is
   * that a partner asking the question gets the four leases and the four
   * strikes, and an answer nobody can reach is a shrug with extra tables.
   *
   * The `InferredPosition` handed to `TheWorkings` is SYNTHESISED from the
   * clause, and carries an empty `basis` deliberately: the panel is
   * rendering `stored`, and a fabricated live basis would put edits on
   * screen that no document was read for. `strength`/`supporting`/`total`
   * are the harmless zero values the type requires and nothing in the
   * read-only view reads them — `strength.ts` is still the only place a
   * strength is computed, and this screen computes none.
   */
  const openStoredWorkings = (clause: PlaybookClause) => {
    const playbookId = playbookRouteId;
    if (!playbookId) return;
    const position: InferredPosition = {
      id: clause.id,
      clauseTitle: clause.title,
      statement: clause.standardPosition?.text ?? '',
      strength: 'weak',
      supporting: 0,
      total: 0,
      basis: [],
      contradicted: false,
      disposition: 'adopted',
      diffDerivedOnly: false,
    };
    const load = () => {
      setStoredWorkings({ position, stored: { state: 'loading' } });
      void getPositionBasis(playbookId, clause.id)
        .then(basis => setStoredWorkings({ position, stored: { state: 'loaded', basis } }))
        .catch((e: unknown) => setStoredWorkings({
          position,
          stored: {
            state: 'error',
            message: e instanceof Error ? e.message : String(e),
            onRetry: load,
          },
        }));
    };
    load();
  };

  const handleExportTemplate = (t: PlaybookDraft) => {
    const blob = exportTemplate(t);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${t.name}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleDeleteTemplate = async (id: string) => {
    try {
      await deleteTemplate(id);
      await refreshTemplates();
      notify('Template deleted.');
    } catch (e) {
      notify(e instanceof Error ? e.message : 'Could not delete the template.', 'error');
    }
  };

  const handleImportTemplate = async (file: File) => {
    setImporting(true);
    try {
      const text = await file.text();
      const profile = await getProfile();
      await importTemplate(text, profile.id);
      await refreshTemplates();
      notify('Template imported.');
    } catch (e) {
      // importTemplate throws two distinct, user-actionable messages
      // ("not valid JSON" vs "not a template") — surface them verbatim
      // rather than a generic failure.
      notify(e instanceof Error ? e.message : 'Import failed.', 'error');
    } finally {
      setImporting(false);
    }
  };

  /** The actual create — factored out of `handleCreateMatter` so
   *  `handleCreateMatterForRun` (Important 3: creating a matter from the
   *  Library's matter picker) can reuse it and get the created `Matter`
   *  (specifically its `id`) back, rather than the void the toast-wrapped
   *  `handleCreateMatter` below returns. Does not notify or swallow errors
   *  itself — both callers have their own thing to do with a failure. */
  const createMatter = async ({ name, client }: CreateMatterParams): Promise<Matter> => {
    const profile = await getProfile();
    const matter: Matter = { ...newMatter(name, profile.id), client };
    // Returns what the STORE confirmed, not what was sent to it
    // (await-then-apply). Passing the local object back was harmless while
    // the store was IndexedDB and the two were byte-identical; since Stage 2
    // the server sets `updatedAt`, mints a `version`, and records the
    // AUTHENTICATED actor as `ownerId` rather than the local profile id the
    // browser guessed at — so the local object is now a record that never
    // existed anywhere.
    const saved = await saveMatter(matter);
    await refreshMatters();
    return saved;
  };

  const handleCreateMatter = async (params: CreateMatterParams) => {
    try {
      await createMatter(params);
      notify('Matter created.');
    } catch (e) {
      notify(e instanceof Error ? e.message : 'Could not create the matter.', 'error');
    }
  };

  /** Returns whether the delete succeeded, so `handleDeleteMatterFromHome`
   *  (Task 11) knows it's safe to navigate away — never stranding the user
   *  on a dead matter screen, but also never leaving one on a delete that
   *  actually failed.
   *
   *  Important 2: nothing that started before this call resolves may still
   *  write to `id` after it. The moment `deleteMatter` itself resolves,
   *  this adds `id` to `deletedMatterIdsRef` (checked by every write site in
   *  `handleStartRun`/`handleRetryCell`) and, if `id` is the matter the
   *  CURRENTLY in-flight run belongs to, aborts it and disposes its
   *  debounced saver outright — a debounce timer already armed would
   *  otherwise still fire the write it captured before being told about
   *  any of this. All of `run`/`documents`/`activeMatterId` are cleared
   *  together so the header's "Current run" button (which renders purely
   *  off `run`) can't keep offering a way back into a run for a matter that
   *  no longer exists.
   *
   *  The in-memory page-image cache this used to evict from is gone with
   *  `documentFileForReview` (Task 20): the browser regenerates no page
   *  images any more, so there is nothing left here to clean up. The
   *  server's cache is bounded by bytes and is its own concern. */
  const handleDeleteMatter = async (id: string): Promise<boolean> => {
    try {
      await deleteMatter(id);

      deletedMatterIdsRef.current.add(id);
      if (activeMatterId === id) {
        // STOP WATCHING, then ask the server to stop the run. The order
        // matters: the watch is what would otherwise keep re-reading the
        // findings of a review that has just been deleted, and answer 404
        // three times in a row into a toast about a matter the person has
        // already been told is gone.
        //
        // The cancel is fire-and-forget and its failure is deliberately not
        // reported: the matter delete cascades to the review, the run and
        // its cells, so a run this could not reach has nothing left to write
        // to. Telling somebody their deleted matter's review "was not
        // stopped" would be an instruction with nothing behind it.
        stopWatching();
        const live = runViewRef.current;
        runViewRef.current = null;
        if (live && !isRunOver(live.state)) {
          void cancelRun(live.id).catch(e => debug('cancelling a deleted matter s run', e));
        }
        setRun(null);
        setDocuments([]);
        setActiveMatterId(null);
      }
      if (matter?.id === id) {
        setMatter(null);
      }

      await refreshMatters();
      notify('Matter deleted.');
      return true;
    } catch (e) {
      notify(e instanceof Error ? e.message : 'Could not delete the matter.', 'error');
      return false;
    }
  };

  // documentId -> documentDate, for the variation trail's "date where known"
  // (Task 8). `documents` (the in-session `DocumentFile`s a run reviews)
  // carries no date at all — only `DocumentRecord` does — so this is built
  // from `matterDocuments`, which is already loaded for the current matter.
  const documentDates: Record<string, number> = {};
  for (const doc of matterDocuments) {
    if (doc.documentDate !== undefined) documentDates[doc.id] = doc.documentDate;
  }

  return (
    // `h-screen`, not `min-h-screen`. `main` below is `flex-1`, and a flex
    // item's height is only definite enough for a percentage child (`h-full`)
    // to resolve against when the container's own height is definite. Under
    // `min-h-screen` the height is auto-with-a-floor, so every screen that
    // fills its pane with `h-full` silently fell back to content height: the
    // review screen grew to 19,473px, the window took over the scrolling, and
    // the document pane's own scroller stopped containing anything. Measured
    // in the browser before and after; `TemplateEditor`/`PlaybookLibrary` were
    // already written against `h-full` and were already degrading this way.
    <div className="h-screen flex flex-col bg-paper">
      <Toast toast={toast} />

      {/* Stage 2 §13.1. A BANNER, never a modal (P15): a modal that can be
          dismissed once is a migration a person can lose, and one that
          cannot be dismissed is an app they cannot use while a library of
          any size is moving. It stays up until there is nothing left in this
          browser to say anything about — and it is shown for a database that
          could not be READ as loudly as for one holding records, because
          those two must never look alike. */}
      {localData && (
        <LocalDataBanner
          state={localData}
          onOpen={() => requestView('upload-local-data')}
          onRetry={loadLocalDataPresence}
        />
      )}

      {/* Task 23: a `service_misconfigured`-class failure, wherever it came
          from (a run, the chat panel, a suggested field, drafting or
          publishing a playbook, redlines) — rendered here, once, so it
          shows up "in place" no matter which screen triggered it, and is
          never confused with a navigation. Never routes to Settings: there
          is nothing there that could fix it. */}
      {serviceConfigError && (
        <div className="shrink-0 border-b border-rule bg-card px-6 py-3">
          {/* `onDismiss`, never `onRetry`: by the time this renders, the
              run that failed is over, the chat message is gone and the
              field suggestion was dropped, so there is nothing here to
              re-attempt. The per-finding instance in `ResultsView` DOES
              have something (`onRetryCell`), and passes `onRetry` — one
              component, two call sites, and now two different buttons
              because they can genuinely do two different things. */}
          <ServiceConfigError
            error={serviceConfigError}
            onDismiss={() => setServiceConfigError(null)}
          />
        </div>
      )}

      {/* Part 2A M1: the workspace's model settings could not be READ. Shown
          in place, wherever the reader already is, and never as a routed
          "choose a model" — the difference between "nothing is configured"
          and "we could not find out" is the empty-versus-broken rule, and
          this is the one load path in the HTTP move that had missed it.
          `LoadErrorPanel`, not a hand-rolled banner: it is the only route
          this codebase permits, and it is what carries the Retry. */}
      {settingsLoadError && (
        <div className="shrink-0 border-b border-rule bg-card px-6 py-3">
          <LoadErrorPanel
            compact
            message={settingsLoadError}
            onRetry={() => { void loadWorkspaceSettings(); }}
          />
        </div>
      )}

      {/* Said ONCE, and only when a key was actually there to remove. The
          only actionable half is the revocation: a key deleted from this
          browser is still a live credential at OpenRouter until the user
          kills it, and the copy must not let anyone read "removed" as
          "revoked". Dismissing hides it for this session; it does not come
          back on the next load because there is no longer a key to purge. */}
      {!keyPurgeNoticeDismissed && apiKeyWasPurgedThisSession() && (
        <div
          data-key-purged-notice
          // `aria-live`, never role="status": that selector is how ~21
          // positional assertions in this suite find a StateChip.
          aria-live="polite"
          className="shrink-0 flex items-start gap-3 px-6 py-3 border-b border-accent-edge bg-accent-tint"
        >
          <ShieldCheck className="w-4 h-4 text-accent shrink-0 mt-0.5" aria-hidden="true" />
          <p className="font-ui text-ui-sm text-ink-2 leading-relaxed flex-1">
            {API_KEY_PURGED_NOTICE.before}
            <a
              href={API_KEY_PURGED_NOTICE.href}
              target="_blank"
              rel="noreferrer"
              className="text-accent hover:text-accent-strong underline"
            >
              {API_KEY_PURGED_NOTICE.linkText}
            </a>
            {API_KEY_PURGED_NOTICE.after}
          </p>
          <button
            onClick={() => setKeyPurgeNoticeDismissed(true)}
            className="font-ui text-ui-sm text-ink-3 hover:text-ink-1 shrink-0"
          >
            Dismiss
          </button>
        </div>
      )}

      <header className="min-h-14 h-auto border-b border-rule bg-card flex flex-wrap items-center justify-between gap-y-2 px-6 py-2 shrink-0">
        <button
          className="flex items-center"
          onClick={() => requestView('matters')}
        >
          <span className="font-prose text-section font-medium text-ink-1 tracking-[-0.01em]">LexPrompt</span>
        </button>

        <div className="flex items-center gap-2">
          <button
            onClick={() => requestView('matters')}
            className={`font-ui text-ui-sm px-2.5 py-1.5 rounded-inset flex items-center gap-1.5 ${view === 'matters' || view === 'matter' ? 'font-semibold text-ink-1 bg-accent-tint' : 'font-medium text-ink-3 hover:text-ink-1'}`}
          >
            <Briefcase className="w-4 h-4" /> Matters
          </button>
          <button
            onClick={() => requestView('library')}
            className={`font-ui text-ui-sm px-2.5 py-1.5 rounded-inset ${view === 'library' || view === 'editor' ? 'font-semibold text-ink-1 bg-accent-tint' : 'font-medium text-ink-3 hover:text-ink-1'}`}
          >
            Playbooks
          </button>
          <button
            onClick={() => requestView('positions')}
            className={`font-ui text-ui-sm px-2.5 py-1.5 rounded-inset ${view === 'positions' ? 'font-semibold text-ink-1 bg-accent-tint' : 'font-medium text-ink-3 hover:text-ink-1'}`}
          >
            Standard positions
          </button>
          {run && (
            // Important 6: nothing else sets `view` back to 'results' once
            // the user navigates elsewhere (e.g. to Playbooks), so a run was
            // otherwise stranded for the rest of the session with no way
            // back except starting a brand new one.
            <button
              onClick={() => requestView('results')}
              className={`font-ui text-ui-sm px-2.5 py-1.5 rounded-inset flex items-center gap-1.5 ${view === 'results' || view === 'tabular' ? 'font-semibold text-ink-1 bg-accent-tint' : 'font-medium text-ink-3 hover:text-ink-1'}`}
              title="Back to the current run's results"
            >
              <ClipboardList className="w-4 h-4" /> Current run
            </button>
          )}
          <div className="h-4 w-px bg-rule mx-2" />
          <button
            onClick={() => requestView('settings')}
            className={`p-1.5 rounded-inset ${view === 'settings' ? 'text-ink-1' : 'text-ink-3 hover:text-ink-1'}`}
            title="Settings"
            /* An icon-only control needs an accessible NAME, and `title` is
               not one: `buttonNamed` (src/test/mount.tsx:54-57) matches
               textContent or aria-label and never title, so without this the
               gear is unreachable to assistive tech and to the test harness
               alike. The gap is pre-existing; this task rewrites the element,
               so it is this task's to close (F15). */
            aria-label="Settings"
          >
            <SettingsIcon className="w-4 h-4" aria-hidden="true" />
          </button>
          {/* §7: the avatar shows the LOCAL profile's own initials and goes
              to Settings, where the name is editable. An avatar of yourself
              is honest — and it is the only place the identity substrate
              becomes visible. There is no counter, no badge, and no second
              actor anywhere in this app (R-G1). */}
          <button
            onClick={() => requestView('settings')}
            aria-label="Your profile"
            title="Your profile"
            className="w-7 h-7 rounded-meter bg-accent text-page font-ui text-meta font-semibold flex items-center justify-center"
          >
            {profile?.initials ?? 'ME'}
          </button>
        </div>
      </header>

      <main className="flex-1 overflow-hidden overflow-y-auto">
        {view === 'matters' && (
          mattersLoadError ? (
            <LoadErrorPanel message={mattersLoadError} onRetry={() => loadMatters()} />
          ) : (
            <MattersList
              matters={matters}
              onCreate={handleCreateMatter}
              onDelete={handleDeleteMatter}
              onOpen={handleOpenMatter}
            />
          )
        )}
        {view === 'library' && (
          libraryLoadError ? (
            <LoadErrorPanel message={libraryLoadError} onRetry={() => loadLibrary()} />
          ) : (
            <TemplateLibrary
              templates={templates}
              onOpen={handleOpenTemplate}
              onRun={handleRunTemplate}
              onDelete={handleDeleteTemplate}
              onCreate={() => setChooserOpen(true)}
              onImport={handleImportTemplate}
              importing={importing}
            />
          )
        )}
        {view === 'positions' && (
          <StandardPositionsView
            rows={positionRows}
            error={positionsError}
            onRetry={loadPositions}
            onOpenPlaybook={(playbookId) => navigate({ name: 'playbook', playbookId })}
            // `clauseId` is accepted by the prop and deliberately unused
            // here: the editor has no clause deep-link today, and adding
            // one is not something this task invents — it only reads what
            // D's derivation already produces.
          />
        )}
        {view === 'upload-local-data' && (
          <UploadLocalData
            onClose={() => requestView('matters')}
            onUploaded={(report) => {
              // Only a COMPLETE run. A browser with records that did not move
              // must go on saying so — switching the banner to "your data is
              // on the server" over a partial upload is the sentence §13.1
              // exists to forbid, one screen removed from the report that
              // refuses to say it.
              if (report.complete) markUploadComplete();
              loadLocalDataPresence();
            }}
          />
        )}
        {/* Sub-project E's two session-only screens. Neither has a URL: a
            deep link would promise a draft that cannot be restored. */}
        {view === 'authoring-form' && (
          <div className="p-6 max-w-3xl mx-auto">
            <h2 className="font-prose text-screen-title text-ink-1 mb-1">Draft a playbook with AI</h2>
            <p className="font-ui text-meta text-ink-4 mb-6">
              Describe the contract and the model proposes a clause list. You review every clause
              before any of it becomes a playbook.
            </p>
            <DraftForm
              playbooks={templates.map(t => ({ id: t.id, name: t.name }))}
              matters={matters.map(m => ({ id: m.matter.id, name: m.matter.name }))}
              mattersError={mattersLoadError ?? undefined}
              onRetryMatters={() => loadMatters()}
              busy={authoringBusy}
              error={authoringError}
              authFailed={authoringAuthFailed}
              // No `onAuthError`: the generation catch above already calls
              // `handleModelError(e)` directly, with the real `ModelError`
              // still in scope. `DraftForm`'s own callback is a no-arg
              // signal this task does not touch — routing through it here
              // too would risk a second, duplicate notification.
              onSubmit={handleGenerateDraft}
              onCancel={() => navigate({ name: 'playbooks' })}
            />
          </div>
        )}
        {view === 'authoring-review' && (
          authoringDraft ? (
            <DraftReview
              draft={authoringDraft}
              onChange={updateAuthoringDraft}
              onSave={handleSaveDraftAsV1}
              onDiscard={handleDiscardDraft}
              saving={savingAuthoringDraft}
            />
          ) : (
            <div className="p-8 font-ui text-ui text-ink-3">No draft in progress.</div>
          )
        )}
        {/* Sub-project F's three session-only screens (Task 10A). None has a
            URL, for the same reason the two authoring screens above do
            not — see `REDLINES_VIEWS`. The flow ends by handing an
            `AuthoringDraft` to `authoring-review` above. */}
        {view === 'redlines-intake' && (
          <div className="pb-6">
            <PrecedentUploadPanel onFilesSelected={handleAddRedlinesFiles} busy={redlinesBusy} />
            {redlinesError && (
              <p className="max-w-5xl mx-auto px-6 pt-3 font-ui text-ui text-risk-high">{redlinesError}</p>
            )}
            <PrecedentIntake
              documents={redlinesDocs}
              unreadable={redlinesUnreadable}
              totalEditsToRead={redlinesEditEntries.length}
              contractType={redlinesContractType}
              onContractTypeChange={setRedlinesContractType}
              onSetRole={handleSetRedlinesRole}
              onRemoveDocument={handleRemoveRedlinesDocument}
              onRejectChain={handleRejectRedlinesChain}
              onOfferDiff={handleOfferRedlinesDiff}
              onContinue={handleRedlinesContinueToLearning}
            />
          </div>
        )}
        {view === 'redlines-learned' && (
          <div className="pb-6">
            <WhatWeLearned
              positions={redlinesPositions}
              questions={redlinesQuestions}
              documentNames={redlinesDocumentNames}
              onAdopt={(p) => handleRedlinesDisposition(p, 'adopted')}
              onReword={(p, text) => handleRedlinesDisposition(p, 'reworded', text)}
              onReject={(p) => handleRedlinesDisposition(p, 'rejected')}
              onSeeWorkings={(p) => { setRedlinesWorkingsPosition(p); setView('redlines-workings'); }}
              onBulkAccept={(ps) => setRedlinesPositions(prev => prev.map(
                p => (ps.some(x => x.id === p.id) ? { ...p, disposition: 'adopted' } : p),
              ))}
              onAnswerQuestion={(q, answer) => setRedlinesQuestions(prev => prev.map(
                x => (x.id === q.id ? { ...x, answer } : x),
              ))}
              onSkipQuestion={(q) => setRedlinesQuestions(prev => prev.map(
                x => (x.id === q.id ? { ...x, answer: 'Left open.' } : x),
              ))}
              questionsUnavailableReason={REDLINES_NO_QUESTIONS_REASON}
            />
            {redlinesError && (
              <p className="max-w-4xl mx-auto px-6 font-ui text-ui text-risk-high">{redlinesError}</p>
            )}
            <div className="max-w-4xl mx-auto px-6 pt-2 flex items-center justify-between">
              <button
                onClick={() => setView('redlines-intake')}
                className="font-ui text-meta text-ink-3 hover:text-ink-1"
              >
                &larr; Back to documents
              </button>
              <Button onClick={handleRedlinesToDraftReview}>
                Review and save as a playbook
              </Button>
            </div>
          </div>
        )}
        {view === 'redlines-workings' && (
          redlinesWorkingsPosition ? (
            <TheWorkings
              position={redlinesWorkingsPosition}
              documentNames={redlinesDocumentNames}
              onAdopt={(p) => handleRedlinesDisposition(p, 'adopted')}
              onReword={(p, text) => handleRedlinesDisposition(p, 'reworded', text)}
              onReject={(p) => handleRedlinesDisposition(p, 'rejected')}
              onClose={() => setView('redlines-learned')}
            />
          ) : (
            <div className="p-8 font-ui text-ui text-ink-3">No position selected.</div>
          )
        )}
        {view === 'matter' && (
          matterError ? (
            <LoadErrorPanel message={matterError} onRetry={() => matterRouteId && loadMatterHome(matterRouteId)} />
          ) : matterNotFound ? (
            <div className="p-8 max-w-md mx-auto text-center space-y-4">
              <p className="font-prose text-screen-title text-ink-1">This matter could not be found. It may have been deleted.</p>
              <button
                onClick={() => requestView('matters')}
                className="px-4 py-2 rounded-control bg-accent text-page hover:bg-accent-strong"
              >
                Back to Matters
              </button>
            </div>
          ) : matter ? (
            <MatterHome
              matter={matter}
              documents={matterDocuments}
              documentsError={matterDocumentsError}
              onRetryDocuments={() => loadMatterDocuments(matter.id)}
              onAddDocuments={(files) => handleAddMatterDocuments(matter.id, files)}
              onRemoveDocument={(documentId) => handleRemoveMatterDocument(matter.id, documentId)}
              onReparseDocument={(documentId) => handleReparseDocument(matter.id, documentId)}
              collections={matterCollections}
              collectionsError={matterCollectionsError}
              onRetryCollections={() => loadMatterCollections(matter.id)}
              onCreateCollection={(params) => handleCreateCollection(matter.id, params)}
              onUngroupCollection={(collectionId) => handleUngroupCollection(matter.id, collectionId)}
              onRepairCollection={(collectionId, newBaseDocumentId) => handleRepairCollection(matter.id, collectionId, newBaseDocumentId)}
              reviews={matterReviews}
              reviewsError={matterReviewsError}
              onRetryReviews={() => loadMatterReviews(matter.id)}
              onOpenReview={(review) => handleOpenReview(matter.id, review)}
              playbooks={templates}
              playbooksError={libraryLoadError}
              onRetryPlaybooks={() => loadLibrary()}
              onRunReview={(playbook, target) => handleRunReviewForMatter(matter.id, playbook, target)}
              onDeleteMatter={handleDeleteMatterFromHome}
              localUserId={profile?.id ?? ''}
              modelChoiceId={settings.modelChoiceId}
              onOpenSettings={() => requestView('settings')}
              onCreatePlaybook={() => setChooserOpen(true)}
            />
          ) : null
        )}
        {view === 'not-found' && (
          <div className="p-8 max-w-md mx-auto text-center space-y-4 bg-paper">
            <p className="font-prose text-screen-title text-ink-1">This page could not be found.</p>
            <button
              onClick={() => requestView('matters')}
              className="px-4 py-2 rounded-control bg-accent text-page hover:bg-accent-strong"
            >
              Back to Matters
            </button>
          </div>
        )}
        {view === 'editor' && (
          route.name === 'playbook' && playbookLoadError ? (
            <LoadErrorPanel
              message={playbookLoadError}
              onRetry={() => loadPlaybookForEdit(route.playbookId)}
            />
          ) : route.name === 'playbook' && playbookNotFound ? (
            <div className="p-8 max-w-md mx-auto text-center space-y-4">
              <p className="font-prose text-screen-title text-ink-1">This playbook could not be found. It may have been deleted.</p>
              <button
                onClick={() => navigate({ name: 'playbooks' })}
                className="px-4 py-2 rounded-control bg-accent text-page hover:bg-accent-strong"
              >
                Back to Playbooks
              </button>
            </div>
          ) : route.name === 'playbook' && playbookLoading && !editorContent ? (
            <div className="p-8 font-ui text-ui text-ink-3">Loading playbook…</div>
          ) : editorContent ? (
            <TemplateEditor
              version={activeVersion ?? undefined}
              draft={activeDraft ?? undefined}
              onDraftChange={setActiveDraft}
              onPersistDraft={handlePersistDraft}
              unsavedChanges={isTemplateDirty}
              savingDraft={savingDraft}
              onPublish={() => setPublishOpen(true)}
              onExport={() => handleExportTemplate(editorContent)}
              onShowVersionHistory={() => {
                setVersionHistoryOpen(true);
                if (playbookRouteId) loadVersionHistory(playbookRouteId);
              }}
              onShowMegaPrompt={() => setMegaPromptOpen(true)}
              onClose={() => { if (confirmDiscardIfDirty()) navigate({ name: 'playbooks' }); }}
              health={positionHealthMap}
              healthError={healthError ?? undefined}
              onRetryHealth={() => { if (playbookRouteId) loadPositionHealth(playbookRouteId); }}
              onSeeWorkings={openStoredWorkings}
              settings={settings}
              onAuthError={handleModelError}
              role={roleState}
            />
          ) : (
            <div className="p-8 font-ui text-ui text-ink-3">No template selected.</div>
          )
        )}
        {/* "Where did this house rule come from?" — over the editor rather
            than as a view of its own, so it needs no `Route` (there is
            nothing to deep-link to that the editor's own URL does not
            already name) and cannot interact with the unsaved-draft guards.
            Closing returns to exactly the clause the reader left. */}
        {storedWorkings && (
          <div className="fixed inset-0 z-50 overflow-y-auto bg-paper">
            <TheWorkings
              position={storedWorkings.position}
              stored={storedWorkings.stored}
              readOnly
              backLabel="Back to the clause"
              onAdopt={() => {}}
              onReword={() => {}}
              onReject={() => {}}
              onClose={() => setStoredWorkings(null)}
            />
          </div>
        )}
        {view === 'run' && (
          activeTemplate ? (
            <RunPanel
              key={runPanelKey}
              template={activeTemplate}
              onBack={() => (activeMatterId ? navigate({ name: 'matter', matterId: activeMatterId }) : setView('library'))}
              onRun={handleStartRun}
              initialDocuments={activeMatterId ? documents : []}
            />
          ) : (
            <div className="p-8 font-ui text-ui text-ink-3">No template selected.</div>
          )
        )}
        {(view === 'results' || view === 'tabular') && (
          route.name === 'review' && reviewLoadError ? (
            <LoadErrorPanel
              message={reviewLoadError}
              onRetry={() => openReview(route.matterId, route.reviewId)}
            />
          ) : route.name === 'review' && reviewLoading ? (
            <div className="p-8 font-ui text-ui text-ink-3">Loading review…</div>
          ) : run ? (
            <div
              // `h-full`, never `calc(100vh - <the header's height>)`. The
              // header is `min-h-14 h-auto flex-wrap`, so its height is
              // content-dependent: anything that pushes the nav onto a
              // second row (browser zoom, a longer label, one more item)
              // makes it ~103px, and a screen that had subtracted a
              // hardcoded 64 would then reserve more than the space left,
              // growing the page past the viewport and adding a second
              // scrollbar outside this screen's own scroll panes. `main` is
              // `flex-1` in the `h-screen` column, so its height is
              // already exactly what the header left over: filling it needs
              // no arithmetic, and no copy of a number that by now names
              // nothing.
              className="h-full flex flex-col"
            >
              {/* SECTION 3'S FOURTH LOAD STATE, and it sits ABOVE the run
                 banners because it is about the whole screen rather than
                 about this run: a review nobody is running can go stale
                 too, and the push it stops receiving is somebody else
                 changing a judgement on it.

                 Rendered BESIDE the findings, never instead of them.
                 Blanking them is the other failure — a reviewer who loses
                 their place because the wifi blinked — and the rule is
                 "never show disconnected data AS THOUGH IT WERE CURRENT",
                 not "show nothing".

                 A resync takes precedence over stale: both mean "not
                 current", and only one of them is being fixed right now.
                 Telling a reader which is the whole of the difference. */}
              {resyncing && <StalePanel kind="resyncing" />}
              {!resyncing && liveState === 'stale' && <StalePanel kind="stale" />}
              {isRunning && <RunProgressBar run={run} onCancel={handleCancelRun} />}
              {!isRunning && run.cancelledAt && !run.completedAt && <RunCancelledBanner run={run} />}
              {/* Important 1: `isInterrupted` (derived above, at render, not
                 marked when the review is loaded) is true for a review that
                 is neither completed nor cancelled and isn't the live
                 in-flight run — exactly a review reopened after an
                 abandoned run (tab closed, reload, crash). `isRunning`
                 already unambiguously tells that apart from a genuinely
                 live run (`openReview` always sets it false — see its own
                 comment), so no extra stored flag is needed, and this stays
                 correct automatically as `run` changes shape: retrying a
                 stalled cell from this same banner's Retry buttons flips
                 that one cell out of pending/running immediately, with
                 nothing here needing to be told about it. */}
              {isInterrupted && <RunInterruptedBanner run={run} />}
              {!isRunning && run.completedAt && <RunEmptyFindingsBanner run={run} />}
              {/* Stated where the export decision is made. Renders nothing
                  when everything has been checked, and gates nothing ever:
                  export is never blocked (B §7, §10.3). */}
              <ExportGateBanner
                findings={run.findings}
                onReviewUnchecked={() => {
                  const target = firstUncheckedTarget(run);
                  if (!target) return;
                  setOpenReviewAt(target);
                  setView('results');
                }}
              />
              <div className="flex-1 min-h-0">
                {view === 'results' ? (
                  <ResultsView
                    run={run}
                    documents={documents}
                    settings={settings}
                    matterId={activeMatterId ?? undefined}
                    onRetryCell={handleRetryCell}
                    onOpenTabular={() => { setOpenReviewAt(undefined); setView('tabular'); }}
                    openAt={openReviewAt}
                    onError={(message) => notify(message, 'error')}
                    onAuthError={handleModelError}
                    interrupted={isInterrupted}
                    onVerify={handleVerify}
                    onAddNote={handleAddNote}
                    verifyBusyKey={verifyBusyKey}
                    stale={liveState === 'stale'}
                    authorInitials={profile?.initials ?? 'ME'}
                    localUserId={profile?.id ?? ''}
                    dispositionOf={dispositionOf}
                    audience={audience}
                    exportContext={exportContext}
                    verifyConflict={verifyConflict}
                    onReapplyConflict={handleReapplyConflict}
                    onDismissConflict={() => setVerifyConflict(null)}
                    onConfirmNetPosition={handleConfirmNetPosition}
                    onAmendNetPosition={handleAmendNetPosition}
                    documentDates={documentDates}
                    playbookVersion={runPlaybookVersion}
                    onShowVersionHistory={handleShowVersionHistoryForRun}
                    presence={presence}
                    assignments={assignments}
                    assignmentsError={assignmentsError ?? undefined}
                    onRetryAssignments={() => {
                      if (run?.id) detach(readAssignments(run.id), 're-reading open assignments');
                    }}
                    onAssigned={handleAssigned}
                    onResolveAssignment={(id) => { void handleResolveAssignment(id); }}
                  />
                ) : (
                  <TabularReview
                    run={run}
                    documents={documents}
                    onRetryCell={handleRetryCell}
                    onOpenCards={() => setView('results')}
                    onOpenInReview={(docId, clauseId) => { setOpenReviewAt({ docId, clauseId }); setView('results'); }}
                    interrupted={isInterrupted}
                    onVerify={handleVerify}
                    onAddNote={handleAddNote}
                    verifyBusyKey={verifyBusyKey}
                    stale={liveState === 'stale'}
                    authorInitials={profile?.initials ?? 'ME'}
                    localUserId={profile?.id ?? ''}
                    dispositionOf={dispositionOf}
                    audience={audience}
                    exportContext={exportContext}
                    verifyConflict={verifyConflict}
                    onReapplyConflict={handleReapplyConflict}
                    onDismissConflict={() => setVerifyConflict(null)}
                    assignments={assignments}
                    onAssigned={handleAssigned}
                    onResolveAssignment={(id) => { void handleResolveAssignment(id); }}
                  />
                )}
              </div>
            </div>
          ) : (
            <div className="p-8 font-ui text-ui text-ink-3">No run yet. Start one from a template.</div>
          )
        )}
        {view === 'settings' && (
          <SettingsPanel
            role={roleState}
            onWorkspaceSettingsSaved={(saved) => setSettings(prev => ({ ...prev, ...saved }))}
          />
        )}
      </main>

      {/* The route chooser, and the only way into any authoring route
          (spec §6), including F's. Task 10A: `learnFromRedlinesAvailable`
          is now true — the card was built enabled from the start (R-E6)
          specifically so switching it on was this one line plus a real
          handler, never a re-design of the chooser itself. */}
      {chooserOpen && (
        <RouteChooser
          onDraftWithAI={handleDraftWithAI}
          onBuildByHand={handleBuildByHand}
          learnFromRedlinesAvailable
          onLearnFromRedlines={handleLearnFromRedlines}
          onClose={() => setChooserOpen(false)}
        />
      )}
      {/* Mounted only while open, so its risk toggle re-derives its default
          from THIS playbook every time it is opened (R-D1) — a `useState`
          initialiser on a component that stays mounted would keep the first
          playbook's answer for the rest of the session. */}
      {megaPromptOpen && (
        <MegaPromptModal
          isOpen
          onClose={() => setMegaPromptOpen(false)}
          template={editorContent}
        />
      )}
      {versionHistoryOpen && (
        <VersionHistory
          versions={historyVersions}
          loading={historyLoading}
          error={historyError ?? undefined}
          matterNamesByVersion={historyMatterNames}
          onRetry={() => { if (playbookRouteId) loadVersionHistory(playbookRouteId); }}
          onClose={() => setVersionHistoryOpen(false)}
        />
      )}
      {/* Only reachable with unpublished edits: the editor's Publish button
          is disabled without them, and publishing an unchanged draft would
          mint a second byte-identical version the history cannot explain. */}
      {publishOpen && activeDraft && (
        <PublishDialog
          nextVersion={(activeVersion?.version ?? 0) + 1}
          onPublish={handlePublishTemplate}
          onCancel={() => setPublishOpen(false)}
          busy={publishing}
        />
      )}
      <MatterPickerModal
        isOpen={matterPickerOpen}
        templateName={matterPickerTemplate?.name ?? ''}
        matters={matters.map(m => m.matter)}
        mattersError={mattersLoadError}
        onRetryMatters={() => loadMatters()}
        onClose={closeMatterPicker}
        onPick={handlePickMatterForRun}
        onCreateAndPick={handleCreateMatterForRun}
      />
    </div>
  );
}

/**
 * The sign-in and role gate, and nothing else.
 *
 * This function used to also run the one-time v1→IndexedDB playbook
 * migration before `AppShell` was allowed to mount. Task 23 removed it: the
 * migration wrote into the `playbooks` object store, which the app stopped
 * reading in Part 2A when every repository became an HTTP client, so from
 * that point it was converting records nothing would ever look at — work
 * silently lost, which is the shape `open.ts`'s read-only guard now makes
 * impossible rather than merely unlikely.
 *
 * Nothing it protected is orphaned. A pre-D playbook, and a v1 template that
 * is still only in `localStorage`, are BOTH read by the uploader
 * (`scanLocalData`) and converted on their way to the server by the same
 * `migratePlaybookRecord` this gate used to call — so the conversion happens
 * once, at the moment the record moves somewhere that will actually be read.
 * `LocalDataBanner` says there is data here until it has moved, and says the
 * copy is still here afterwards.
 */
export default function App() {
  // Task 19: the sign-in gate.
  const { state: authState, signIn, signOut, retry: retryAuth } = useAuth();
  // Task 17 (§7): a signed-in caller can still be told "no access" by
  // `GET /v1/me` — a role gate one layer beyond the sign-in gate below,
  // which only knows the token was accepted, not what it is allowed to do.
  const roleState = useRole();

  // Rendered INSTEAD OF the app for every status but `signed-in` — never
  // behind a modal, so a failed or absent sign-in never lets a screen hint
  // at whether this browser has any existing playbooks. R-G1 still binds: this authenticates
  // a caller, it introduces no colleagues, and no other screen changes.
  if (authState.status !== 'signed-in') {
    return <SignInScreen state={authState} onSignIn={signIn} onRetry={retryAuth} />;
  }

  // Task 17 (§7): "a user in no mapped group has no access at all and is
  // told so plainly — not shown an empty app, which would be the 'empty is
  // not broken' rule failing at the front door." Checked here, beside the
  // sign-in gate above, so nothing
  // AppShell mounts (matters list, playbook library, the header itself) can
  // hint at a working app behind this refusal.
  //
  // Scoped to exactly the failures with a definite answer here:
  //  - `no_role` / `account_disabled` / `group_overage` → told plainly,
  //    with the API's own message (`isAccessRefusedError`).
  //  - `service_misconfigured` → the FIRM's problem, not this account's;
  //    Stage 1's Task 23 split these deliberately, so this must not be
  //    folded into the panel above.
  // Anything else — a boot-time network blip, an unrecognised code — falls
  // through and lets `AppShell` mount. `roleState` reaching `failed` for a
  // reason nothing here recognises is not evidence the account has no
  // access; blocking the whole app on it would be exactly the
  // confidently-wrong failure this file exists not to produce.
  if (roleState.status === 'failed') {
    if (isAccessRefusedError(roleState.error)) {
      return <AccessRefusedPanel error={roleState.error} onSignOut={signOut} />;
    }
    if (roleState.error instanceof ModelError && roleState.error.code === 'service_misconfigured') {
      return (
        <div className="min-h-screen bg-paper flex items-center justify-center p-6">
          <ServiceConfigError error={roleState.error} />
        </div>
      );
    }
  }

  return <AppShell signIn={signIn} />;
}
