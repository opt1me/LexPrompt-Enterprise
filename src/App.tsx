import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Settings as SettingsIcon, ClipboardList, Briefcase } from 'lucide-react';
import type { Playbook, PlaybookDraft, PlaybookVersion, DocumentFile, DocumentRecord, Review, ReviewRun, ReviewTarget, Settings, Matter, Collection, Finding, UserProfile, Verification, NetPosition } from './types';
import { loadSettings, saveSettings } from './lib/storage';
import { applyVerification, findingKey, makeNote, resetVerification, unchecked } from './lib/verification';
import type { VerificationChange } from './lib/verification';
import { confirmPosition, amendPosition, resetPosition, NetPositionError } from './lib/netPosition';
import { carryHumanState } from './lib/findingMerge';
import { uid } from './lib/uid';
import {
  listPlaybooks as listTemplates, getPlaybook as getTemplate, deletePlaybook as deleteTemplate,
  newPlaybook as newTemplate, exportPlaybook as exportTemplate, importPlaybook as importTemplate,
  getPlaybookContent, newPlaybookDraft, publishAndPoint, saveDraft, discardDraft,
} from './lib/db/playbooks';
import {
  listMatters, getMatter, saveMatter, newMatter, deleteMatter,
} from './lib/db/matters';
import { listDocuments, getDocument, addDocument, deleteDocument, setDocumentRole } from './lib/db/documents';
import { getDocumentBlob } from './lib/db/blobs';
import {
  listReviews, getReview, saveReview, createDebouncedReviewSaver, type DebouncedReviewSaver,
} from './lib/db/reviews';
import { getProfile } from './lib/db/profile';
import { migrateIfNeeded, type MigrationPhase } from './lib/db/migrate';
import { describeLoadError } from './lib/loadError';
import { getVersion, listVersions } from './lib/db/playbookVersions';
import { scanPlaybookAcrossMatters } from './lib/playbookScan';
import { buildPositionHealthMap } from './lib/positionHealthMap';
import { buildPositionRows, type PositionRow } from './lib/standardPositions';
import {
  listCollections, getCollection, saveCollection, deleteCollection, newCollection,
} from './lib/db/collections';
import { orderedMembers } from './lib/collectionOrder';
import { findingsKeyFor, isCollectionTarget } from './lib/reviewTarget';
import { useRoute, type Route } from './lib/router';
import { listModels, isAuthError } from './lib/openrouter';
import { useToast, Toast } from './components/Toast';
import { LoadErrorPanel } from './components/LoadErrorPanel';
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
import { emptyRun, runReview, retryCell, type CollectionRunInput } from './features/review/runReview';
import { TabularReview } from './features/tabular/TabularReview';
import { parseFiles, parseFile, toDocumentRecord, documentFileForViewing, documentFileForReview, evictPageImages } from './lib/documents';
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
import { TheWorkings } from './features/redlines/TheWorkings';
import { positionsToDraft, includedPositions } from './features/redlines/positionsToDraft';
import { Button } from './components/Button';
import { StandardPositionsView } from './features/positions/StandardPositionsView';
import { useAuth } from './lib/auth/useAuth';
import { SignInScreen } from './features/auth/SignInScreen';

/** `authoring-form` and `authoring-review` are sub-project E's two
 *  session-only screens. They deliberately have **no `Route`**: a draft
 *  must not survive a reload, and a URL that reopened one would be a URL
 *  that promised a draft it cannot produce — see `AUTHORING_VIEWS` below
 *  and R-E1. */
type View =
  | 'matters' | 'library' | 'editor' | 'run' | 'results' | 'tabular' | 'settings' | 'matter' | 'not-found'
  | 'authoring-form' | 'authoring-review'
  | 'redlines-intake' | 'redlines-learned' | 'redlines-workings'
  | 'positions';

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
const REDLINES_DIRTY_MESSAGE =
  'This learning session has not been turned into a playbook. It exists only in this tab, ' +
  'so leaving loses the documents you brought in and the positions found in them. Leave anyway?';

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
 * Rebuilds one persisted document as a `DocumentFile` FIT FOR EXTRACTION:
 * its stored bytes fetched, then run back through `documentFileForReview`
 * so a scan gets its page images regenerated (they are derived data and are
 * never persisted — `documentFileForReview` skips the work entirely for a
 * document with a healthy text layer, and caches the result per session for
 * one that needs it).
 *
 * The ONLY place App.tsx turns a persisted document into something the review
 * engine may be handed. `handleRunReviewForMatter`'s two branches and
 * `handleRetryCell` all go through it, so none of them can quietly drift
 * into hydrating "for viewing" instead — a `documentFileForViewing` result
 * carries no page images, and a scan hydrated that way reviews as though it
 * said nothing.
 */
async function hydrateRecordForReview(record: DocumentRecord): Promise<DocumentFile> {
  const blob = await getDocumentBlob(record.id);
  return documentFileForReview(record, blob);
}

/**
 * The same, starting from a document *id* — which is all a retry on a
 * REOPENED review has. `openReview` hydrates for VIEWING
 * (`documentFileForViewing`: right for the viewer pane, which renders the
 * PDF itself through `PdfCanvas` and needs no base64 page images, and wrong
 * for extraction, which does), and keeps no records behind those files.
 *
 * `fallback` is returned when the record is gone from storage entirely —
 * the document was deleted from its matter since this review was opened.
 * `openReview` already built a placeholder for exactly that case whose
 * `parseError` says so; handing it back means the caller reports that real
 * reason rather than inventing a second wording for it.
 */
async function hydrateIdForReview(documentId: string, fallback: DocumentFile): Promise<DocumentFile> {
  const record = await getDocument(documentId);
  if (!record) return fallback;
  return hydrateRecordForReview(record);
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

const AUTH_ERROR_MESSAGE = 'Your OpenRouter API key was rejected. Update it in Settings and try again.';

/** Where the user's playbooks still are, per failed step.
 *
 *  The reassurance was always true; before this it named the wrong place.
 *  Step 1 moves v1's localStorage templates into IndexedDB and is safe
 *  because that localStorage source is never deleted on any path. Step 2
 *  converts records that are ALREADY in IndexedDB and is safe for a
 *  different reason — each playbook's conversion is one all-or-nothing
 *  transaction — so telling that user to look in "the browser's older
 *  storage" points them at a place their playbooks may not be. With no
 *  phase (the defensive catch around a rejecting `migrateIfNeeded`) neither
 *  claim can be made, so the wording names no store at all. */
function reassuranceFor(phase: MigrationPhase | undefined): string {
  if (phase === 'v1') {
    return "Nothing has been lost. Your existing playbooks are still safely stored in the browser's " +
      'older storage and were not deleted — moving them to the new storage just didn’t succeed ' +
      'this time.';
  }
  if (phase === 'versions') {
    return 'Nothing has been lost. Your playbooks are still in the browser’s storage exactly as ' +
      'they were — each one is upgraded in a single all-or-nothing step, so a failure part-way ' +
      'through changes none of them.';
  }
  return 'Nothing has been lost. Your playbooks are still stored exactly as they were, and nothing ' +
    'was deleted — the upgrade simply did not finish.';
}

/** Rendered INSTEAD OF the entire app when the one-time playbook migration
 *  fails (see `App`'s gate below) — never alongside a library that would
 *  otherwise render empty and be mistaken for a fresh install with nothing
 *  in it. The reassurance is a fact about the implementation, not a guess:
 *  see `reassuranceFor` for why it depends on which step failed. */
function MigrationBlockedScreen(
  { error, phase, onRetry }: { error: string; phase?: MigrationPhase; onRetry: () => void },
) {
  return (
    <div className="min-h-screen flex items-center justify-center bg-paper p-8">
      <div className="max-w-md text-center space-y-4">
        <h1 className="font-prose text-screen-title text-ink-1">Your playbook library couldn't be set up</h1>
        <p className="font-ui text-ui text-ink-2">{reassuranceFor(phase)}</p>
        <p className="text-risk-high text-sm break-words">{error}</p>
        <button
          onClick={onRetry}
          className="px-4 py-2 rounded-control bg-accent text-page hover:bg-accent-strong"
        >
          Retry
        </button>
      </div>
    </div>
  );
}

type MigrationState =
  | { kind: 'pending' }
  | { kind: 'ok'; migratedCount: number | null }
  | { kind: 'failed'; error: string; phase?: MigrationPhase };

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
};

/**
 * The real app. Split out from the default-exported `App` below so that
 * none of its mount effects — `loadLibrary` foremost among them, since it's
 * the one reading the very store the migration writes into — can run until
 * the one-time v1→IndexedDB playbook migration has resolved. `App` doesn't
 * mount this component at all while migration is pending or failed, so
 * there is no ordering race to get right here; it's structural.
 */
function AppShell({ migratedCount }: { migratedCount: number | null }) {
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
  const abortControllerRef = useRef<AbortController | null>(null);
  // Tracks the latest `run` state during an in-flight run, for the one path
  // that can't just read the `run` state variable: `runReview`'s rejection
  // on cancellation carries no run, only the abort — see the `.catch` in
  // `handleStartRun`, which needs the run as it stood at the moment of
  // cancellation to persist it.
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
  // The debounced saver (if any) backing the CURRENTLY in-flight run, and
  // which matter it's scoped to — tracked separately from `activeMatterId`
  // state for the same reason as `deletedMatterIdsRef` above: this needs to
  // survive the user navigating away from the run while it keeps going in
  // the background. `handleDeleteMatter` disposes it outright (killing an
  // already-armed debounce timer, which `deletedMatterIdsRef` alone cannot
  // do — a fired timer would still send the write it captured before being
  // cancelled) when its matter is the one just deleted.
  const activeRunSaverRef = useRef<{ matterId: string; saver: DebouncedReviewSaver } | null>(null);
  // RunPanel seeds its own upload-list state from `initialDocuments` only
  // on mount (a plain useState initializer, not synced on prop changes) —
  // bumping this key on every entry into the run flow forces a fresh mount,
  // so a second "Run a review" (a different matter, or the same one after
  // adding more documents) doesn't show a stale panel left over from the
  // previous run.
  const [runPanelKey, setRunPanelKey] = useState(0);
  const [settings, setSettings] = useState<Settings>(() => loadSettings());
  const { notify, toast } = useToast();

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

  // Fires exactly once, on the render where the migration gate first hands
  // control to this component — `migratedCount` is a mount-time prop, not a
  // value that changes again for the lifetime of this component instance
  // (`App` unmounts and remounts a fresh `AppShell` on retry instead of
  // reusing this one). `null` means `not-needed`: proceed silently, per
  // spec — the whole point of the flag `migrateIfNeeded` writes is that a
  // returning user hits this path on every load after their first.
  useEffect(() => {
    if (migratedCount !== null) {
      notify(`Migrated ${migratedCount} playbook${migratedCount === 1 ? '' : 's'}.`);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
  // Everything here is session-only, full stop, per R-F6 (mirrors E's
  // `AuthoringDraft`, which this session hands off to): a precedent document's
  // `File` and its parsed edits live only in `redlinesFilesRef` below and
  // die with the tab, never reaching `addDocument`/blob storage — spec §4 /
  // §11's "read once, never stored" promise. `redlinesDocs` is the thin,
  // serialisable-looking half of that state (`PrecedentDocument[]` — no
  // `File`, no edit text) that actually drives `PrecedentIntake`'s render;
  // `redlinesFilesRef` is the other half, keyed by the same `id`.
  const [redlinesDocs, setRedlinesDocs] = useState<PrecedentDocument[]>([]);
  const [redlinesUnreadable, setRedlinesUnreadable] = useState<UnreadableDocument[]>([]);
  /** One entry per document brought in: its live `File` (read, never
   *  persisted), the text `pdfRedlineDiff` needs for the diff fallback, the
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

  const isConfigured = Boolean(settings.apiKey && settings.modelId);

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
      setRun(reviewRun);
      setIsRunning(false);
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
  // OpenRouter model list for whichever model is currently selected, even
  // when the user never opens Settings this session (e.g. a model chosen
  // in an earlier session, then jumping straight to Run). This is what lets
  // extractClause's image/structured-output/context-budget gating (Critical
  // 1, Important 9) work from live data rather than whatever was persisted
  // — possibly nothing — the last time Settings happened to be open. A
  // failed fetch leaves the existing (possibly unknown/conservative)
  // capability fields alone rather than erroring.
  useEffect(() => {
    if (!settings.modelId) return;
    let cancelled = false;
    listModels()
      .then(models => {
        if (cancelled) return;
        const match = models.find(m => m.id === settings.modelId);
        if (!match) return;
        setSettings(prev => {
          if (prev.modelId !== match.id) return prev;
          if (
            prev.modelSupportsImages === match.supportsImages &&
            prev.modelSupportsStructuredOutput === match.supportsStructuredOutput &&
            prev.modelContextLength === match.contextLength
          ) return prev;
          const next: Settings = {
            ...prev,
            modelSupportsImages: match.supportsImages,
            modelSupportsStructuredOutput: match.supportsStructuredOutput,
            modelContextLength: match.contextLength,
          };
          saveSettings(next);
          return next;
        });
      })
      .catch(() => { /* best-effort; keep whatever capabilities we already have */ });
    return () => { cancelled = true; };
  }, [settings.modelId]);

  // Important 4: a rejected API key must route to Settings with an
  // explanation, not sit as a wall of identical red error cards. Per-clause
  // failures are isolated by design (extractClause never rejects), so the
  // only reliable place to notice "the key itself is bad" is by watching
  // the findings as they land.
  useEffect(() => {
    if (!run || authErrorHandledRef.current) return;
    const hasAuthError = Object.values(run.findings).some(byClause =>
      Object.values(byClause).some(f => f.authError));
    if (!hasAuthError) return;
    authErrorHandledRef.current = true;
    abortControllerRef.current?.abort();
    notify(AUTH_ERROR_MESSAGE, 'error');
    setView('settings');
  }, [run]);

  const handleAuthError = () => {
    notify(AUTH_ERROR_MESSAGE, 'error');
    setView('settings');
  };

  /**
   * Anything that calls the API — running a review, generating a template —
   * routes to Settings with an explanatory toast instead of opening (or
   * proceeding into) a flow that can only fail with an obscure error.
   */
  const ensureConfigured = (message = 'Add your OpenRouter key to get started.') => {
    if (isConfigured) return true;
    notify(message, 'error');
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
    const created = await createMatter(params);
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

    let userId = '';
    if (matterId) {
      // Important 2: the matter could already be gone by the time this run
      // was queued up (e.g. a stale run panel) — never write a document
      // into a matter that no longer exists.
      if (deletedMatterIdsRef.current.has(matterId)) {
        notify('This matter has been deleted, so this review cannot be started.', 'error');
        return;
      }
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
    }

    const newRun = emptyRun(template, docs, collectionInput?.target);
    authErrorHandledRef.current = false;
    latestRunRef.current = newRun;
    // Task 8A: so a retry later in THIS run (`handleRetryCell`) can re-run a
    // collection clause through the collection extractor rather than
    // `extractClause` — `null` for the standalone path, exactly as before
    // this ref existed.
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

    const controller = new AbortController();
    abortControllerRef.current = controller;

    // Minor: `onError` used to go unused, so a failed debounced mid-run save
    // was reported through `debug()` only — invisible to the user, exactly
    // the "quietly wrong" failure mode this app exists to avoid. Now it
    // surfaces the same way any other save failure in this function does.
    const reviewSaver = matterId
      ? createDebouncedReviewSaver(undefined, (error) => {
          notify(error instanceof Error ? error.message : 'This review is not saving. Check your connection or storage.', 'error');
        })
      : null;
    if (matterId && reviewSaver) {
      activeRunSaverRef.current = { matterId, saver: reviewSaver };
    }

    const handleUpdate = (updated: ReviewRun) => {
      // Important 2: `matterId` is this closure's own local copy, captured
      // at the top of this function — it does NOT track `activeMatterId`
      // state, precisely because this run must keep going (and keep being
      // reachable via "Current run") even after the user navigates
      // elsewhere and that state changes. So the one thing that CAN stop
      // this write, or this UI update, once the matter is gone is checking
      // the deleted-ids set directly, every time, here.
      //
      // The `setRun` gate matters just as much as the write one below: a
      // cancellation triggered BY this same delete (`handleDeleteMatter`
      // aborts this run) runs `cancelPendingCells` and calls straight back
      // into this function before its own promise chain's `.catch` ever
      // runs — and that call would otherwise resurrect the "Current run"
      // button and the results view for a matter `handleDeleteMatter` had
      // just cleared `run` for, moments before.
      if (matterId && deletedMatterIdsRef.current.has(matterId)) return;
      // `runReview` owns its own copy of the run and knows nothing about a
      // verification or note written mid-run by `handleVerify`/`handleAddNote`
      // — every snapshot it emits carries `unchecked()` for every finding.
      // Without re-applying human state onto each snapshot here, the very
      // next cell finishing would silently overwrite a verification the user
      // just watched succeed (see `carryHumanState`'s own doc comment).
      const merged = carryHumanState(latestRunRef.current, updated);
      latestRunRef.current = merged;
      setRun(merged);
      if (matterId && reviewSaver) {
        reviewSaver.scheduleSave(reviewFromRun(merged, matterId, settings.modelId, userId));
      }
    };

    // Critical 1 fix: `persistFinal` used to take the run to persist as a
    // parameter, and had two callers — the success path passed `runReview`'s
    // own return value (which never sees a human write; `runReview` builds
    // every `Finding` with `unchecked()`/`notes: []`), while the abort path
    // four lines below correctly passed `latestRunRef.current`. A parameter
    // that only one of two callers gets right is a trap, so `persistFinal`
    // now reads `latestRunRef.current` itself — the single place `handleUpdate`
    // keeps the human-merged run — with `newRun` as a defensive fallback for
    // the case (which should not occur; `latestRunRef.current` is set to
    // `newRun` above before either code path can run) where no update ever
    // landed.
    const persistFinal = async () => {
      if (!matterId || !reviewSaver) return;
      if (activeRunSaverRef.current?.saver === reviewSaver) {
        activeRunSaverRef.current = null;
      }
      if (deletedMatterIdsRef.current.has(matterId)) {
        // The matter was deleted — most likely `handleDeleteMatter` already
        // disposed this exact saver and aborted this run, which is how
        // execution even got here (the abort's rejection lands in the
        // `.catch` below). Disposing again is a harmless no-op; the point
        // is that no write happens past this line.
        reviewSaver.dispose();
        return;
      }
      const finalRun = latestRunRef.current ?? newRun;
      try {
        await reviewSaver.saveNow(reviewFromRun(finalRun, matterId, settings.modelId, userId));
      } catch (e) {
        notify(e instanceof Error ? e.message : 'Could not save this review.', 'error');
      }
      reviewSaver.dispose();
      loadMatterReviews(matterId);
    };

    runReview(newRun, docs, settings, handleUpdate, controller.signal, collectionInput)
      .then(async () => {
        setIsRunning(false);
        await persistFinal();
      })
      .catch(async (error) => {
        setIsRunning(false);
        // runReview rejects on abort — that's a deliberate stop, not a
        // failure, and must never surface as an error toast. Everything
        // already completed stays exactly as it was set by the last
        // onUpdate call. A cancelled run is still real, partial work, so
        // it's persisted the same as a completed one (unless the matter
        // itself is what triggered the abort — see `persistFinal`'s own
        // deleted-matter check above).
        if (error instanceof DOMException && error.name === 'AbortError') {
          await persistFinal();
          return;
        }
        notify(error instanceof Error ? error.message : 'Review failed.', 'error');
      });
  };

  const handleCancelRun = () => {
    abortControllerRef.current?.abort();
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
   * Await the write, then apply (ruling R-B2, spec section 9). The UI must
   * never show a verification the store did not take: a reviewer who marks
   * twenty findings verified, whose writes all fail, and whose export then
   * claims verification no store holds, is the worst outcome this feature
   * has. A single IndexedDB record write is milliseconds; correctness is
   * worth them.
   *
   * `latestRunRef` is updated alongside `run` state because a live run's
   * debounced saver reads from it — without this, the next mid-run
   * auto-save would write a snapshot taken before this verification and
   * silently undo it.
   *
   * Important 1 fix: this function reads `latestRunRef.current` once, then
   * crosses two `await`s (`getProfile()`, `saveReview()`) before ever
   * writing it back. A live run's `onUpdate` can land in that window — it
   * writes `latestRunRef.current` unconditionally (see `handleUpdate`
   * above) — and the old code then overwrote the ref with a run built from
   * the PRE-await snapshot, discarding whatever the run completed while this
   * write was in flight, on screen and in the next persisted save. The fix
   * re-reads `latestRunRef.current` after both awaits and re-applies just
   * this finding's verification onto it, rather than replacing the whole
   * ref with the stale `updated`. The merge direction is asymmetric on
   * purpose: this call's own write must win for `docId`/`clauseId` — it is
   * the reason this function is running — while every other finding must
   * come from whichever run snapshot is freshest, since that's the one a
   * live run (or another concurrent human write) has had the last say over.
   */
  const handleVerify = async (docId: string, clauseId: string, change: VerificationChange) => {
    const current = latestRunRef.current ?? run;
    const matterId = activeMatterId;
    if (!current || !matterId) return;

    const existing = current.findings[findingsKeyFor(current.target, docId)]?.[clauseId];
    if (!existing) return;

    const profile = await getProfile();

    let verification: Verification;
    try {
      verification = applyVerification(existing.verification, change, profile.id, Date.now());
    } catch (e) {
      notify(e instanceof Error ? e.message : 'That verification is not valid.', 'error');
      return;
    }

    const updated = withUpdatedFinding(current, docId, clauseId, { ...existing, verification });

    setVerifyBusyKey(findingKey(docId, clauseId));
    try {
      // Minor 2: `createdByUserId` records who created the REVIEW, not who
      // most recently verified something in it — pass the tracked original
      // through rather than `profile.id` (the current actor, who is instead
      // recorded on the `Verification`/`Note` itself, correctly, above).
      // `|| profile.id` only covers the defensive case where the ref was
      // never set (should not happen: reaching here requires either
      // `openReview` or `handleStartRun` to have run first).
      const userId = createdByUserIdRef.current || profile.id;
      await saveReview(reviewFromRun(updated, matterId, settings.modelId, userId));
      // Important 1 fix (see doc comment above): re-read the ref rather than
      // trusting `current`/`updated`, which were captured before the two
      // awaits above and may already be stale.
      const latest = latestRunRef.current ?? updated;
      const latestExisting = latest.findings[findingsKeyFor(latest.target, docId)]?.[clauseId] ?? existing;
      const merged = withUpdatedFinding(latest, docId, clauseId, { ...latestExisting, verification });
      latestRunRef.current = merged;
      setRun(merged);
      // Item 2 fix: a live run's own debounced saver (`activeRunSaverRef`)
      // may have a stale, pre-verification payload already armed —
      // `scheduleSave` was called by the run's last `onUpdate`, before this
      // write landed. Left alone, that stale timer fires after this direct
      // write and reasserts the older state, silently undoing it in
      // storage even though the screen still shows it verified. Rescheduling
      // with the freshly merged run here closes that: `scheduleSave` is
      // latest-payload-wins and does not push its timer back (see
      // `createDebouncedReviewSaver`'s doc comment), so this cannot extend
      // the debounce, and it is a no-op once no run is active — `persistFinal`
      // and `handleDeleteMatter` both clear `activeRunSaverRef` before that
      // can happen, so there is nothing here for a lingering timer to attach
      // to.
      activeRunSaverRef.current?.saver.scheduleSave(reviewFromRun(merged, matterId, settings.modelId, userId));
    } catch (e) {
      notify(
        e instanceof Error
          ? `This verification was not saved: ${e.message}`
          : 'This verification was not saved.',
        'error',
      );
    } finally {
      setVerifyBusyKey(null);
    }
  };

  // Important 1 / Item 2 fix: same shape and same reasoning as `handleVerify`
  // above — re-read `latestRunRef.current` after the awaits and merge this
  // note onto whichever run snapshot is freshest, then reassert that merged
  // run through the live run's debounced saver, rather than overwriting
  // `latestRunRef` with the pre-await snapshot and leaving a stale
  // `scheduleSave` free to reassert it in storage afterward.
  const handleAddNote = async (docId: string, clauseId: string, text: string) => {
    const current = latestRunRef.current ?? run;
    const matterId = activeMatterId;
    if (!current || !matterId) return;

    const existing = current.findings[findingsKeyFor(current.target, docId)]?.[clauseId];
    if (!existing) return;

    const profile = await getProfile();
    const note = makeNote(docId, clauseId, text, profile.id, Date.now(), uid());
    const updated = withUpdatedFinding(current, docId, clauseId, {
      ...existing,
      notes: [...existing.notes, note],
    });

    setVerifyBusyKey(findingKey(docId, clauseId));
    try {
      // Minor 2: same reasoning as `handleVerify` above — preserve the
      // review's original creator rather than reattributing to whoever
      // just added a note.
      const userId = createdByUserIdRef.current || profile.id;
      await saveReview(reviewFromRun(updated, matterId, settings.modelId, userId));
      const latest = latestRunRef.current ?? updated;
      const latestExisting = latest.findings[findingsKeyFor(latest.target, docId)]?.[clauseId] ?? existing;
      const merged = withUpdatedFinding(latest, docId, clauseId, {
        ...latestExisting,
        notes: [...latestExisting.notes, note],
      });
      latestRunRef.current = merged;
      setRun(merged);
      activeRunSaverRef.current?.saver.scheduleSave(reviewFromRun(merged, matterId, settings.modelId, userId));
    } catch (e) {
      notify(e instanceof Error ? `This note was not saved: ${e.message}` : 'This note was not saved.', 'error');
    } finally {
      setVerifyBusyKey(null);
    }
  };

  /**
   * Accepts a collection clause's synthesised net position as written.
   * Follows `handleVerify`'s path exactly — build the updated run with
   * `withUpdatedFinding`, `await saveReview(...)`, and only then `setRun`
   * and update `latestRunRef`, re-reading `latestRunRef.current` after the
   * awaits so a live run's own `onUpdate` landing during them is not
   * discarded (Important 1, same reasoning as `handleVerify`). This call's
   * own write is the only thing forced to win for `docId`/`clauseId`;
   * everything else comes from whichever run snapshot is freshest.
   *
   * There is nothing here that separately calls `carryHumanState` — a
   * confirmation is protected from the LIVE run's next `onUpdate` by
   * `handleUpdate` (in `handleStartRun`), which already routes every
   * engine snapshot through `carryHumanState`, now that it (and
   * `findingMerge.ts`) know how to carry a net position the same way they
   * carry a verification. Reuse those helpers; this is not a third copy of
   * that pattern.
   */
  const handleConfirmNetPosition = async (docId: string, clauseId: string) => {
    const current = latestRunRef.current ?? run;
    const matterId = activeMatterId;
    if (!current || !matterId) return;

    const existing = current.findings[findingsKeyFor(current.target, docId)]?.[clauseId];
    if (!existing?.netPosition) return;

    const profile = await getProfile();
    const netPosition = confirmPosition(existing.netPosition, profile.id, Date.now());
    const updated = withUpdatedFinding(current, docId, clauseId, { ...existing, netPosition });

    setVerifyBusyKey(findingKey(docId, clauseId));
    try {
      const userId = createdByUserIdRef.current || profile.id;
      await saveReview(reviewFromRun(updated, matterId, settings.modelId, userId));
      // Re-read the ref rather than trusting `current`/`updated`, which were
      // captured before the two awaits above and may already be stale.
      const latest = latestRunRef.current ?? updated;
      const latestExisting = latest.findings[findingsKeyFor(latest.target, docId)]?.[clauseId] ?? existing;
      const merged = withUpdatedFinding(latest, docId, clauseId, { ...latestExisting, netPosition });
      latestRunRef.current = merged;
      setRun(merged);
      activeRunSaverRef.current?.saver.scheduleSave(reviewFromRun(merged, matterId, settings.modelId, userId));
    } catch (e) {
      notify(
        e instanceof Error ? `This confirmation was not saved: ${e.message}` : 'This confirmation was not saved.',
        'error',
      );
    } finally {
      setVerifyBusyKey(null);
    }
  };

  /** Records the human's rewritten net position. Same shape as
   *  `handleConfirmNetPosition` above; the only difference is building the
   *  new `NetPosition` through `amendPosition`, which throws on empty text
   *  the same way `applyVerification` throws on a reasonless rejection —
   *  the amend dialog already disables its own confirm button on
   *  whitespace, so this catch is a backstop, not the user's experience of
   *  the rule. */
  const handleAmendNetPosition = async (docId: string, clauseId: string, text: string) => {
    const current = latestRunRef.current ?? run;
    const matterId = activeMatterId;
    if (!current || !matterId) return;

    const existing = current.findings[findingsKeyFor(current.target, docId)]?.[clauseId];
    if (!existing?.netPosition) return;

    const profile = await getProfile();

    let netPosition: NetPosition;
    try {
      netPosition = amendPosition(existing.netPosition, text, profile.id, Date.now());
    } catch (e) {
      notify(e instanceof NetPositionError ? e.message : 'That amendment is not valid.', 'error');
      return;
    }

    const updated = withUpdatedFinding(current, docId, clauseId, { ...existing, netPosition });

    setVerifyBusyKey(findingKey(docId, clauseId));
    try {
      const userId = createdByUserIdRef.current || profile.id;
      await saveReview(reviewFromRun(updated, matterId, settings.modelId, userId));
      const latest = latestRunRef.current ?? updated;
      const latestExisting = latest.findings[findingsKeyFor(latest.target, docId)]?.[clauseId] ?? existing;
      const merged = withUpdatedFinding(latest, docId, clauseId, { ...latestExisting, netPosition });
      latestRunRef.current = merged;
      setRun(merged);
      activeRunSaverRef.current?.saver.scheduleSave(reviewFromRun(merged, matterId, settings.modelId, userId));
    } catch (e) {
      notify(
        e instanceof Error ? `This amendment was not saved: ${e.message}` : 'This amendment was not saved.',
        'error',
      );
    } finally {
      setVerifyBusyKey(null);
    }
  };

  /**
   * Writes a retry's outcome back to storage. Shared by the two ways a retry
   * can end — `retryCell` resolving with a result, and `failRetryCell`
   * recording that the retry could never start — so the screen and the
   * stored review cannot disagree about which of those happened. Before
   * this, only the success path persisted; a retry that fell over left an
   * error on screen and the old, possibly VERIFIED answer in storage,
   * indistinguishable on reload from an answer a human had actually checked.
   */
  const persistRetryResult = async (toPersist: ReviewRun, matterId: string | null) => {
    // Important 2: guards this write the same way handleStartRun's
    // handleUpdate/persistFinal do — `matterId` is a local snapshot of
    // `activeMatterId`, and the matter it names may have been deleted while
    // the retry was in flight.
    if (!matterId || deletedMatterIdsRef.current.has(matterId)) return;
    try {
      // Minor 2: same reasoning as `handleVerify`/`handleAddNote` — a
      // retry's save must not reattribute the review to whoever triggered
      // the retry either. The fallback for the case `createdByUserIdRef` was
      // never set — which the other two writers guard with `|| profile.id`
      // from their own fresh `getProfile()` call — uses the component's
      // render-time `profile` state instead of awaiting a new one purely for
      // this: this call has no other need of a fresh profile, and the three
      // sites are meant to agree on having SOME fallback, not on how each
      // happens to obtain it.
      await saveReview(reviewFromRun(toPersist, matterId, settings.modelId, createdByUserIdRef.current || profile?.id || ''));
      loadMatterReviews(matterId);
    } catch (e) {
      notify(e instanceof Error ? e.message : 'Could not save this retry.', 'error');
    }
  };

  /**
   * Ends a retry that could not even reach the extractor — the document's
   * stored bytes could not be re-read, so there is nothing to send.
   *
   * The cell is already `running` by the time this can be called (the busy
   * state is set before hydration deliberately, so the button never looks
   * dead), and leaving it there would give the reviewer a spinner that never
   * finishes — this project has shipped exactly that once already. It lands
   * as an `error` finding naming the real cause instead, and is persisted,
   * so a reload shows the same thing the screen does.
   */
  const failRetryCell = (busy: ReviewRun, docId: string, clauseId: string, reason: string) => {
    const message = `This clause was not re-run: ${reason}`;
    const existing = busy.findings[findingsKeyFor(busy.target, docId)]?.[clauseId];
    const failed = withUpdatedFinding(busy, docId, clauseId, {
      clauseId,
      status: 'error',
      citations: [],
      error: message,
      verification: existing?.verification ?? unchecked(),
      notes: existing?.notes ?? [],
      // Carried forward so nothing is destroyed by a retry that never even
      // reached the extractor. It reaches no reader: `FindingCard`'s error
      // branch renders the message alone, and `findingOutcome`'s
      // `hasStandingPosition` now keeps the label and the derivation out of
      // both exports too — they used to print a Derivation table under a
      // "could not be reviewed" heading, which the screen refused to show.
      ...(existing?.netPosition ? { netPosition: existing.netPosition } : {}),
    });
    // Same merge `onRetryUpdate` does, for the same reason: a verification
    // or note a human wrote to a DIFFERENT finding while the hydration was
    // in flight is invisible to `busy`, and must not be dropped by this.
    const merged = carryHumanState(latestRunRef.current, failed);
    latestRunRef.current = merged;
    setRun(merged);
    notify(message, 'error');
    void persistRetryResult(merged, activeMatterId);
  };

  const handleRetryCell = async (docId: string, clauseId: string) => {
    const current = latestRunRef.current ?? run;
    if (!current) return;
    // The VIEW-hydrated document: right for the viewer pane beside the
    // findings, and never handed to the extractor — see the re-hydration
    // below. Used here only to identify the document and to carry
    // `openReview`'s "this document was deleted" placeholder message
    // through, if that is what it is.
    const viewDoc = documents.find(d => d.id === docId);
    if (!viewDoc) return;
    const matterId = activeMatterId;

    // Task 8A: a collection clause's answer is a synthesis across every
    // member document — re-running it must go through the SAME collection
    // extractor that originally produced it, never `extractClause` (which
    // would silently replace that synthesis with a one-document answer, on
    // screen indistinguishable from a correct re-run). `activeCollectionRef`
    // is only ever populated for a collection target (`handleStartRun`,
    // `openReview`); if it's missing here for a collection run, the
    // collection info genuinely could not be prepared (e.g. its `Collection`
    // record failed to reload) — refusing the retry is the honest answer,
    // not a silent fallback to the wrong extractor.
    const isCollection = isCollectionTarget(current.target);
    if (isCollection && !activeCollectionRef.current) {
      notify(
        collectionUnavailableRef.current === 'missing'
          ? 'These documents are no longer grouped as a collection, so this clause cannot be re-run. ' +
            'The findings already here are unchanged.'
          : 'This collection could not be prepared for retry. Reload the review and try again.',
        'error',
      );
      return;
    }

    // Mirrors handleStartRun: a retry is a fresh, live API call, so a stale
    // `authErrorHandledRef` from an earlier run (or from opening a review
    // that already had one) must not suppress the redirect if THIS call is
    // the one that gets rejected.
    authErrorHandledRef.current = false;

    const existing = current.findings[findingsKeyFor(current.target, docId)]?.[clauseId];

    // The single most important rule in this sub-project: a verification
    // describes a judgement about specific content, and re-running the
    // clause replaces that content. Keeping the verification would let an
    // export claim a human checked text they never saw.
    //
    // `cleared` is what gets handed to `retryCell` — not just pushed into
    // state alongside it. `retryCell` derives every snapshot it emits from
    // the run it was given, so passing the un-cleared `run`/`current` here
    // would let its first update restore the verification we just removed.
    // `existing.verification` is guarded, not just `existing`: a finding
    // read from storage that predates sub-project B's schema (or a stale
    // fixture) may carry no `verification` at all. Treating that the same
    // as `unchecked` — nothing to reset — is the honest reading and keeps
    // this from crashing on data the type declares can't happen but that
    // can still show up at runtime.
    // Same rule, same reason, for a net position: `confirmPosition`/
    // `amendPosition` are a human's judgement about a specific synthesis,
    // and re-running the clause replaces that synthesis. `existing.netPosition`
    // is guarded the same way `existing.verification` is above — a
    // standalone-document finding never has one at all.
    const needsVerificationReset = Boolean(existing?.verification && existing.verification.state !== 'unchecked');
    const needsPositionReset = Boolean(existing?.netPosition && existing.netPosition.state !== 'unconfirmed');

    let cleared = current;
    if (needsVerificationReset || needsPositionReset) {
      cleared = withUpdatedFinding(current, docId, clauseId, {
        ...existing!,
        ...(needsVerificationReset ? { verification: resetVerification(existing!.verification) } : {}),
        ...(needsPositionReset ? { netPosition: resetPosition(existing!.netPosition!) } : {}),
      });
      const clauseTitle = current.templateSnapshot.clauses.find(c => c.id === clauseId)?.title ?? 'This clause';
      const clearedDescription = needsVerificationReset && needsPositionReset
        ? 'verification and net position were'
        : needsPositionReset
        ? 'net position was'
        : 'verification was';
      notify(`${clauseTitle} is being re-run, so its ${clearedDescription} cleared.`);
    }

    // The cell must read as busy NOW — before the re-hydration below, which
    // re-renders a multi-page scan through pdfjs and can take seconds. Until
    // this existed, `retryCell`'s own first `onUpdate` was what put the cell
    // into `running`, and that call now sits behind an await: the button
    // would look dead for the whole render, with the old (already cleared)
    // answer still on screen. Built as a fresh finding — the same shape
    // `retryCell` writes — so a previous attempt's error text or summary
    // does not sit under a spinner, but carrying `cleared`'s verification,
    // notes and net position forward: those are the human-authored state the
    // reset above deliberately just rewrote, not output to discard.
    const clearedFinding = cleared.findings[findingsKeyFor(cleared.target, docId)]?.[clauseId];
    const busy = withUpdatedFinding(cleared, docId, clauseId, {
      clauseId,
      status: 'running',
      citations: [],
      verification: clearedFinding?.verification ?? unchecked(),
      notes: clearedFinding?.notes ?? [],
      ...(clearedFinding?.netPosition ? { netPosition: clearedFinding.netPosition } : {}),
    });
    latestRunRef.current = busy;
    setRun(busy);

    // Re-hydrate FOR REVIEW, lazily, here — not when the review was opened.
    //
    // `openReview` hydrates with `documentFileForViewing`, which carries no
    // page images, and most reviews are opened to read rather than to retry;
    // regenerating every scan's images on every open would be exactly the
    // cost that function exists to avoid. But a view-hydrated `DocumentFile`
    // is as unfit for extraction as a raw `DocumentRecord` — a scan arrives
    // with empty text and no images, `assessDocument` calls it `unreadable`,
    // and the reviewer is told the document "has no readable text or images
    // to review" about a file they can see rendered in the pane beside it.
    // So the images get regenerated at the one moment they are actually
    // needed. `documentFileForReview` caches them per session, so only the
    // first retry in a session pays the render.
    let doc: DocumentFile;
    let collectionInput: CollectionRunInput | undefined;
    try {
      if (isCollection) {
        const active = activeCollectionRef.current!;
        // Rebuilt member by member rather than by re-deriving the order:
        // `orderedMembers` already decided this collection's reading order
        // when the run was started (or the review reopened), and re-running
        // it here would silently re-read a `Collection` record that may have
        // been edited since — quietly reviewing a different set of documents
        // than the one the user asked to retry. Only each member's
        // `document` is replaced; `documentId`, `kind` and `position` are
        // carried through untouched. A member that was already absent stays
        // absent (`document: null`), which is what the collection extractor
        // is written to report on.
        const members = await Promise.all(active.members.map(async (member) => (
          member.document
            ? { ...member, document: await hydrateIdForReview(member.documentId, member.document) }
            : member
        )));
        collectionInput = { target: active.target, members };
        // `retryCell` reads `doc` only for the standalone key; kept honest
        // anyway so nothing downstream is handed a view-hydrated file.
        doc = members.find(m => m.documentId === docId)?.document ?? await hydrateIdForReview(docId, viewDoc);
      } else {
        doc = await hydrateIdForReview(docId, viewDoc);
      }
    } catch (e) {
      failRetryCell(busy, docId, clauseId, e instanceof Error ? e.message : 'The stored file could not be read.');
      return;
    }

    // Hydration reports a failure by setting `parseError`, never by
    // throwing: a missing blob, a re-parse that errored, or a record that is
    // gone from storage altogether. Extraction must not be reached with one
    // of those — `extractCollectionClause` would call the document
    // unreadable and blame it for having "no extractable content", which is
    // the misleading message this whole path exists to remove. Report the
    // real cause instead.
    const unreadable = collectionInput
      ? collectionInput.members.map(m => m.document).find(d => d?.parseError)
      : (doc.parseError ? doc : undefined);
    if (unreadable?.parseError) {
      failRetryCell(busy, docId, clauseId, `${unreadable.name} could not be re-read: ${unreadable.parseError}`);
      return;
    }

    // `retryCell` is handed `busy`, a snapshot frozen at the moment the
    // retry started, and derives every onUpdate snapshot from it. Nothing
    // about `retryCell`'s own bookkeeping knows about a verification or note
    // a human writes to a DIFFERENT finding while this retry is still in
    // flight (`handleVerify`/`handleAddNote` write straight to
    // `latestRunRef.current`, entirely outside `retryCell`'s view) — so the
    // next `onRetryUpdate` would otherwise replace the whole run with a
    // stale, `cleared`-derived snapshot and silently discard that write, on
    // screen and in the next persisted save. `carryHumanState` (already used
    // by the live-run path for the same reason) fixes this by re-applying
    // whatever `latestRunRef.current` most recently held onto each snapshot.
    //
    // This does not resurrect the verification the reset above just
    // cleared: `latestRunRef.current` was set to `busy` (which carries
    // `cleared`'s reset verification) immediately before this retry started,
    // so the retried clause's own verification is already `unchecked` by the
    // time any snapshot arrives — `carryHumanState` only ever carries a
    // verification when it is NOT `unchecked`. There is nothing left for it
    // to fight.
    //
    // This also subsumes the retried clause's own notes, which used to need
    // a separate, narrower patch: `before` (`busy`) still holds this
    // clause's original notes, and every snapshot `retryCell` emits for it
    // arrives with `notes: []`, so the standard notes rule (kept below)
    // already reapplies them without a second, parallel mechanism that has
    // to agree with the first.
    const onRetryUpdate = (updated: ReviewRun) => {
      const merged = carryHumanState(latestRunRef.current, updated);
      latestRunRef.current = merged;
      setRun(merged);
    };

    retryCell(busy, doc, clauseId, settings, onRetryUpdate, collectionInput)
      .then(async (updated) => {
        // `latestRunRef.current`, not the raw `updated` retryCell resolved
        // with: `onRetryUpdate` (above) merges in whatever human writes
        // landed on OTHER findings while this retry was in flight, and
        // `updated` is retryCell's un-patched return value, which knows
        // nothing about them. Persisting `updated` directly would save a
        // review with those writes gone while the screen still shows them —
        // a verification or note that displays but was never (re-)written,
        // the exact failure this task exists to remove.
        await persistRetryResult(latestRunRef.current ?? updated, matterId);
      })
      .catch((error) => {
        notify(error instanceof Error ? error.message : 'Retry failed.', 'error');
      });
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
      const unreadable = parsed.filter(d => d.parseError).length;
      if (unreadable > 0) {
        notify(
          unreadable === parsed.length
            ? 'Added, but could not be read — see the error next to each file.'
            : `Added. ${unreadable} of ${parsed.length} could not be read — see the error next to each file.`,
          'error',
        );
      } else {
        notify(parsed.length === 1 ? 'Document added.' : `${parsed.length} documents added.`);
      }
    } catch (e) {
      notify(e instanceof Error ? e.message : 'Could not add the document(s).', 'error');
    }
  };

  const handleRemoveMatterDocument = async (matterId: string, documentId: string) => {
    try {
      await deleteDocument(documentId);
      evictPageImages(documentId);
      await loadMatterDocuments(matterId);
      notify('Document removed.');
    } catch (e) {
      notify(e instanceof Error ? e.message : 'Could not remove the document.', 'error');
    }
  };

  /**
   * Groups the chosen standalone documents into a new collection (Task 7).
   * Two separate writes, not one transaction — `saveCollection`'s `_seq`
   * allocation is scoped to a single-store transaction on `collections`
   * (`nextSeq`'s own type pins it there, see `seq.ts`), so it cannot share
   * a transaction with the `documents` store's role updates. The order
   * matters for the failure case: the collection is saved FIRST, so if a
   * member's role update then fails partway, retrying this action (or
   * ungrouping) still has a real collection record to work from rather
   * than orphaned document roles pointing at nothing.
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
   * bytes through `documentFileForReview` (spec §5.2 — page images are
   * never persisted, only regenerated on demand from the source bytes).
   * That function does the gating itself: a document with a healthy text
   * layer is returned untouched (no re-parse at all), only a document with
   * at least one below-threshold page gets pdfjs re-run over it to rebuild
   * `pageImages` — and even then only once per session, since it caches the
   * result by document id. So a scanned PDF's images are only ever
   * regenerated the first time this session it's actually reviewed.
   *
   * Task 7 widens this with an optional `target`. Omitted, this is
   * UNCHANGED — every line below runs exactly as it always did, over
   * every one of the matter's documents, into the RunPanel preview screen.
   * A collection target instead hydrates only that collection's present
   * members (through the SAME `documentFileForReview` the standalone path
   * uses, so a scanned amendment keeps its page images) and calls
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
        const hydrated = await Promise.all(presentRecords.map(hydrateRecordForReview));
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
      const docs = await Promise.all(matterDocuments.map(hydrateRecordForReview));
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
    if (!ensureConfigured('Add your OpenRouter key to draft a playbook.')) return;
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
      if (isAuthError(e)) {
        setAuthoringAuthFailed(true);
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
      if (isAuthError(e)) handleAuthError();
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
    if (!ensureConfigured('Add your OpenRouter key to learn from redlines.')) return;
    setRedlinesError(undefined);
    setView('redlines-intake');
  };

  /**
   * Reads a freshly-picked batch of files into memory ONLY — no
   * `addDocument`, no blob write, nothing that reaches IndexedDB or
   * `localStorage` (spec §4/§11's storage promise; mutation-tested in
   * `App.redlines.test.tsx`). `parseFile` (`lib/documents.ts`) already never
   * persists anything on its own, which is what makes it safe to reuse here
   * for the pdf-diff fallback's text — it is called for every file, not
   * only PDFs, so a `.docx` whose OOXML tracked changes cannot be read still
   * has SOME text available if the user offers the diff fallback for it.
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

      const readable = parsed.filter(p => !p.markupError);
      const unreadable = parsed.filter(p => p.markupError);

      const proposed = proposeChains(readable.map((p) => {
        const { role, inferred } = proposeRole(p.name, p.hasMarkup);
        return { id: p.id, name: p.name, role, roleInferred: inferred } satisfies PrecedentDocument;
      }));

      for (const p of parsed) {
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

  const handleRemoveRedlinesDocument = (document: PrecedentDocument) => {
    redlinesFilesRef.current.delete(document.id);
    setRedlinesDocs(prev => prev.filter(d => d.id !== document.id));
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
      if (isAuthError(e)) handleAuthError();
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
    updateAuthoringDraft(positionsToDraft(included, redlinesDocumentNames, settings.modelId, contractType));
    setView('authoring-review');
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
    await saveMatter(matter);
    await refreshMatters();
    return matter;
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
   *  Minor: also evicts the deleted matter's documents from the in-memory
   *  page-image cache (`evictPageImages`) — memory-only, so not covered by
   *  `deleteMatter`'s own IndexedDB cascade, but free to clean up here since
   *  this is the one place that already knows which documents just went
   *  away. The snapshot is taken before the delete and is best-effort: a
   *  failure to read it must never block the actual delete. */
  const handleDeleteMatter = async (id: string): Promise<boolean> => {
    try {
      const docsToEvict = await listDocuments(id).catch(() => []);

      await deleteMatter(id);

      deletedMatterIdsRef.current.add(id);
      if (activeRunSaverRef.current?.matterId === id) {
        activeRunSaverRef.current.saver.dispose();
        activeRunSaverRef.current = null;
      }
      if (activeMatterId === id) {
        abortControllerRef.current?.abort();
        setRun(null);
        setDocuments([]);
        setActiveMatterId(null);
      }
      if (matter?.id === id) {
        setMatter(null);
      }

      docsToEvict.forEach(d => evictPageImages(d.id));

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
              onAuthError={handleAuthError}
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
              modelId={settings.modelId}
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
              settings={settings}
              onAuthError={handleAuthError}
            />
          ) : (
            <div className="p-8 font-ui text-ui text-ink-3">No template selected.</div>
          )
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
                    onRetryCell={handleRetryCell}
                    onOpenTabular={() => { setOpenReviewAt(undefined); setView('tabular'); }}
                    openAt={openReviewAt}
                    onError={(message) => notify(message, 'error')}
                    onAuthError={handleAuthError}
                    interrupted={isInterrupted}
                    onVerify={handleVerify}
                    onAddNote={handleAddNote}
                    verifyBusyKey={verifyBusyKey}
                    authorInitials={profile?.initials ?? 'ME'}
                    localUserId={profile?.id ?? ''}
                    onConfirmNetPosition={handleConfirmNetPosition}
                    onAmendNetPosition={handleAmendNetPosition}
                    documentDates={documentDates}
                    playbookVersion={runPlaybookVersion}
                    onShowVersionHistory={handleShowVersionHistoryForRun}
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
                    authorInitials={profile?.initials ?? 'ME'}
                    localUserId={profile?.id ?? ''}
                  />
                )}
              </div>
            </div>
          ) : (
            <div className="p-8 font-ui text-ui text-ink-3">No run yet. Start one from a template.</div>
          )
        )}
        {view === 'settings' && (
          <SettingsPanel settings={settings} onChange={setSettings} />
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
 * Startup gate for the one-time v1→IndexedDB playbook migration (Task 14).
 * Runs `migrateIfNeeded()` once, before `AppShell` — and with it, every
 * effect that could read the `playbooks` store, `loadLibrary` foremost —
 * is even mounted. That ordering is structural, not timing-dependent:
 * `AppShell` only appears in the tree once `migration.kind === 'ok'`.
 *
 * - `not-needed` (`migratedCount: null`) → `AppShell` mounts silently.
 * - `migrated` → `AppShell` mounts and toasts the count once, from the
 *   `migratedCount` prop (see the effect near the top of `AppShell`).
 * - `failed` → `AppShell` never mounts. `MigrationBlockedScreen` renders
 *   instead, for as long as the failure persists — the exact "empty
 *   library" failure this project exists to design out, at its last and
 *   most visible possible occurrence: an app that has never rendered
 *   anything yet.
 *
 * `migrateIfNeeded()` is contractually documented to never reject — every
 * failure path resolves to `{ status: 'failed' }` — but the `.catch` below
 * is kept anyway: it is the one moment a user's existing playbooks are
 * being moved, and an unhandled rejection there must never be able to
 * regress into a white screen, whatever a future change to `migrate.ts`
 * does.
 */
export default function App() {
  // Task 19: the sign-in gate. `useAuth`'s own effect and the migration
  // effect just below both fire from this same first render, so the two
  // async checks run CONCURRENTLY rather than one blocking the other —
  // deliberately, so adding sign-in here does not double the wait a cold
  // load already had for the migration check alone.
  const { state: authState, signIn, retry: retryAuth } = useAuth();
  const [migration, setMigration] = useState<MigrationState>({ kind: 'pending' });

  const runMigration = () => {
    setMigration({ kind: 'pending' });
    migrateIfNeeded()
      .then((result) => {
        if (result.status === 'failed') {
          setMigration({
            kind: 'failed',
            error: result.error || 'The playbook migration failed for an unknown reason.',
            phase: result.phase,
          });
        } else {
          setMigration({
            kind: 'ok',
            migratedCount: result.status === 'migrated' ? result.count : null,
          });
        }
      })
      .catch((e) => {
        setMigration({ kind: 'failed', error: e instanceof Error ? e.message : String(e) });
      });
  };

  useEffect(() => {
    runMigration();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Rendered INSTEAD OF the app for every status but `signed-in` — never
  // behind a modal, and checked BEFORE the migration gate below, so a
  // failed or absent sign-in never lets a screen hint at whether this
  // browser has any existing playbooks. R-G1 still binds: this authenticates
  // a caller, it introduces no colleagues, and no other screen changes.
  if (authState.status !== 'signed-in') {
    return <SignInScreen state={authState} onSignIn={signIn} onRetry={retryAuth} />;
  }

  if (migration.kind === 'pending') {
    // Deliberately blank rather than a spinner: this resolves in a single
    // IndexedDB round trip (typically sub-frame), and the fast, common
    // `not-needed` case shouldn't flash a loading screen ahead of it.
    return <div className="min-h-screen bg-paper" />;
  }

  if (migration.kind === 'failed') {
    return <MigrationBlockedScreen error={migration.error} phase={migration.phase} onRetry={runMigration} />;
  }

  return <AppShell migratedCount={migration.migratedCount} />;
}
