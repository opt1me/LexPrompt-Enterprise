import React, { useEffect, useRef, useState } from 'react';
import { FileText, Settings as SettingsIcon, ClipboardList, Briefcase } from 'lucide-react';
import type { Template, DocumentFile, DocumentRecord, Review, ReviewRun, Settings, Matter, Finding, UserProfile, Verification } from './types';
import { loadSettings, saveSettings } from './lib/storage';
import { applyVerification, findingKey, makeNote, resetVerification } from './lib/verification';
import type { VerificationChange } from './lib/verification';
import { carryHumanState } from './lib/findingMerge';
import { uid } from './lib/uid';
import {
  listPlaybooks as listTemplates, getPlaybook as getTemplate, savePlaybook as saveTemplate, deletePlaybook as deleteTemplate,
  newPlaybook as newTemplate, exportPlaybook as exportTemplate, importPlaybook as importTemplate,
} from './lib/db/playbooks';
import {
  listMatters, getMatter, saveMatter, newMatter, deleteMatter,
} from './lib/db/matters';
import { listDocuments, getDocument, addDocument, deleteDocument } from './lib/db/documents';
import { getDocumentBlob } from './lib/db/blobs';
import {
  listReviews, getReview, saveReview, createDebouncedReviewSaver, type DebouncedReviewSaver,
} from './lib/db/reviews';
import { getProfile } from './lib/db/profile';
import { migrateIfNeeded } from './lib/db/migrate';
import { describeLoadError } from './lib/loadError';
import { useRoute, type Route } from './lib/router';
import { generateTemplate } from './features/templates/generateTemplate';
import { listModels, isAuthError } from './lib/openrouter';
import { useToast, Toast } from './components/Toast';
import { LoadErrorPanel } from './components/LoadErrorPanel';
import { SettingsPanel } from './features/settings/SettingsPanel';
import { MattersList, type MattersListItem, type CreateMatterParams } from './features/matters/MattersList';
import { MatterHome } from './features/matters/MatterHome';
import { MatterPickerModal } from './features/matters/MatterPickerModal';
import { TemplateLibrary } from './features/templates/TemplateLibrary';
import { TemplateEditor } from './features/templates/TemplateEditor';
import { CreateTemplateDialog, type CreateTemplateParams } from './features/templates/CreateTemplateDialog';
import { MegaPromptModal } from './features/templates/MegaPromptModal';
import { RunPanel, RunProgressBar, RunCancelledBanner, RunEmptyFindingsBanner, RunInterruptedBanner } from './features/review/RunPanel';
import { ResultsView } from './features/review/ResultsView';
import { emptyRun, runReview, retryCell } from './features/review/runReview';
import { TabularReview } from './features/tabular/TabularReview';
import { parseFiles, toDocumentRecord, documentFileForViewing, documentFileForReview, evictPageImages } from './lib/documents';

type View = 'matters' | 'library' | 'editor' | 'run' | 'results' | 'tabular' | 'settings' | 'matter' | 'not-found';

/** Builds the persisted `Review` shape from an in-session `ReviewRun`, for
 *  a run scoped to a matter (`matterId` — see `activeMatterId`). Shared by
 *  every place a run's progress needs writing back to IndexedDB
 *  (`handleStartRun`'s debounced mid-run saves, its completion/cancellation
 *  save, and `handleRetryCell`'s post-retry save) so those three call sites
 *  cannot drift into building slightly different `Review` objects — the
 *  exact sibling-drift failure this project's own review history keeps
 *  flagging when the same shape gets rebuilt by hand more than once. */
function reviewFromRun(run: ReviewRun, matterId: string, modelId: string, userId: string): Review {
  return {
    id: run.id,
    matterId,
    playbookSnapshot: run.templateSnapshot,
    documentIds: run.documentIds,
    findings: run.findings,
    modelId,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    cancelledAt: run.cancelledAt,
    createdByUserId: userId,
  };
}

/** Replaces one finding in a run, copying only the two objects on the path
 *  to it. Extracted rather than inlined three times: this project has six
 *  sibling-drift findings on record, and three hand-rolled copies of a
 *  nested-map update is exactly how the seventh happens. */
function withUpdatedFinding(
  run: ReviewRun,
  docId: string,
  clauseId: string,
  finding: Finding,
): ReviewRun {
  return {
    ...run,
    findings: {
      ...run.findings,
      [docId]: { ...run.findings[docId], [clauseId]: finding },
    },
  };
}

const AUTH_ERROR_MESSAGE = 'Your OpenRouter API key was rejected. Update it in Settings and try again.';

/** Rendered INSTEAD OF the entire app when the one-time v1→IndexedDB
 *  playbook migration fails (see `App`'s gate below) — never alongside a
 *  library that would otherwise render empty and be mistaken for a fresh
 *  install with nothing in it. `migrateIfNeeded()` never deletes the v1
 *  localStorage source on any failure path, so the reassurance here is a
 *  fact about the implementation, not a guess. */
function MigrationBlockedScreen({ error, onRetry }: { error: string; onRetry: () => void }) {
  return (
    <div className="min-h-screen flex items-center justify-center bg-surface p-8">
      <div className="max-w-md text-center space-y-4">
        <h1 className="text-lg font-semibold text-white">Your playbook library couldn't be set up</h1>
        <p className="text-gray-300">
          Nothing has been lost. Your existing playbooks are still safely stored in the browser's
          older storage and were <strong>not</strong> deleted — moving them to the new storage just
          didn't succeed this time.
        </p>
        <p className="text-red-400 text-sm break-words">{error}</p>
        <button
          onClick={onRetry}
          className="px-4 py-2 rounded-md bg-violet-600 text-white hover:bg-violet-500"
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
  | { kind: 'failed'; error: string };

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
  const [templates, setTemplates] = useState<Template[]>([]);
  const [matters, setMatters] = useState<MattersListItem[]>([]);
  const [activeTemplate, setActiveTemplate] = useState<Template | null>(null);
  const [documents, setDocuments] = useState<DocumentFile[]>([]);
  const [run, setRun] = useState<ReviewRun | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const abortControllerRef = useRef<AbortController | null>(null);
  // Tracks the latest `run` state during an in-flight run, for the one path
  // that can't just read the `run` state variable: `runReview`'s rejection
  // on cancellation carries no run, only the abort — see the `.catch` in
  // `handleStartRun`, which needs the run as it stood at the moment of
  // cancellation to persist it.
  const latestRunRef = useRef<ReviewRun | null>(null);
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

  const [createOpen, setCreateOpen] = useState(false);
  const [createLoading, setCreateLoading] = useState(false);
  const [generationStatus, setGenerationStatus] = useState('');
  const [megaPromptOpen, setMegaPromptOpen] = useState(false);
  const [importing, setImporting] = useState(false);

  // Important 3: running a playbook from the Library now goes through this
  // picker instead of straight into the run panel, since every review is
  // matter-scoped — `matterPickerTemplate` is the playbook awaiting a
  // matter choice, `null` whenever the picker is closed.
  const [matterPickerOpen, setMatterPickerOpen] = useState(false);
  const [matterPickerTemplate, setMatterPickerTemplate] = useState<Template | null>(null);

  // Tracks the template as last saved (or as last opened/generated) so the
  // editor can tell whether there are unsaved changes worth warning about
  // before they're discarded (Important 7). `null` means "nothing to
  // compare against" — an editor with no template open, or a freshly
  // generated/created one that has never been saved and so is unsaved by
  // definition, even before the user touches anything: closing it right
  // after a ~30s paid AI generation is exactly the loss this guards.
  const [savedTemplateSnapshot, setSavedTemplateSnapshot] = useState<string | null>(null);
  const isTemplateDirty =
    view === 'editor' && activeTemplate !== null &&
    (savedTemplateSnapshot === null || JSON.stringify(activeTemplate) !== savedTemplateSnapshot);

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
  // action's own toast instead (see handleSaveTemplate etc.), not routed
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

  // --- Matter home (Task 11) ---------------------------------------------

  const [matter, setMatter] = useState<Matter | null>(null);
  // Distinguishes "the matter genuinely doesn't exist" (deleted, bad link)
  // from "the load itself failed" — the two need different UI: a not-found
  // message with a way back, versus an error with a retry.
  const [matterNotFound, setMatterNotFound] = useState(false);
  const [matterError, setMatterError] = useState<string | null>(null);

  const [matterDocuments, setMatterDocuments] = useState<DocumentRecord[]>([]);
  const [matterDocumentsError, setMatterDocumentsError] = useState<string | null>(null);

  const [matterReviews, setMatterReviews] = useState<Review[]>([]);
  const [matterReviewsError, setMatterReviewsError] = useState<string | null>(null);

  const loadMatterDocuments = (matterId: string) => {
    setMatterDocumentsError(null);
    return listDocuments(matterId).then(setMatterDocuments).catch((e) => {
      setMatterDocumentsError(describeLoadError(e, 'The documents in this matter could not be loaded. Try again.'));
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
      const reviewRun: ReviewRun = {
        id: review.id,
        templateSnapshot: review.playbookSnapshot,
        documentIds: review.documentIds,
        findings: review.findings,
        startedAt: review.startedAt,
        completedAt: review.completedAt,
        cancelledAt: review.cancelledAt,
      };
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

  const loadPlaybookForEdit = (id: string) => {
    setPlaybookLoadError(null);
    setPlaybookNotFound(false);
    setPlaybookLoading(true);
    return getTemplate(id)
      .then((t) => {
        if (!t) {
          setPlaybookNotFound(true);
          return;
        }
        setActiveTemplate(t);
        setSavedTemplateSnapshot(JSON.stringify(t));
      })
      .catch((e) => {
        setPlaybookLoadError(describeLoadError(e, 'This playbook could not be loaded. Try again.'));
      })
      .finally(() => setPlaybookLoading(false));
  };

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
    if (activeTemplate && activeTemplate.id === playbookRouteId) return;
    loadPlaybookForEdit(playbookRouteId);
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

  /** Important 7: leaving the editor with unsaved changes needs a chance to
   *  back out, rather than silently discarding a paid AI generation or a
   *  half-finished edit. */
  const confirmDiscardIfDirty = () => {
    if (!isTemplateDirty) return true;
    return window.confirm('This template has unsaved changes. Discard them?');
  };

  const requestView = (next: View) => {
    if (view === 'editor' && next !== 'editor' && !confirmDiscardIfDirty()) return;
    if (next === 'run' && !ensureConfigured()) return;
    setView(next);
    // Keeps the URL in sync for the views that own a route, so a refresh or
    // a shared link lands back where the user was. Views with no route yet
    // (editor/run/results/tabular) deliberately push nothing.
    const routeForNext = ROUTE_FOR_VIEW[next];
    if (routeForNext) navigate(routeForNext);
  };

  const handleOpenTemplate = (t: Template) => {
    setActiveTemplate(t);
    setSavedTemplateSnapshot(JSON.stringify(t));
    navigate({ name: 'playbook', playbookId: t.id });
  };

  /** Important 3: a Library run used to skip persistence entirely — this
   *  now opens `MatterPickerModal` first, so every run (Library or Matter
   *  Home) ends up scoped to a matter. See `handlePickMatterForRun` /
   *  `handleCreateMatterForRun` for what happens once one is chosen. */
  const handleRunTemplate = (t: Template) => {
    setMatterPickerTemplate(t);
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
   */
  const handleStartRun = async (docs: DocumentFile[]) => {
    if (!activeTemplate || docs.length === 0) return;
    const matterId = activeMatterId;

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

    const newRun = emptyRun(activeTemplate, docs);
    authErrorHandledRef.current = false;
    latestRunRef.current = newRun;
    setDocuments(docs);
    setRun(newRun);
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

    runReview(newRun, docs, settings, handleUpdate, controller.signal)
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
   */
  const handleVerify = async (docId: string, clauseId: string, change: VerificationChange) => {
    const current = latestRunRef.current ?? run;
    const matterId = activeMatterId;
    if (!current || !matterId) return;

    const existing = current.findings[docId]?.[clauseId];
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
      await saveReview(reviewFromRun(updated, matterId, settings.modelId, profile.id));
      latestRunRef.current = updated;
      setRun(updated);
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

  const handleAddNote = async (docId: string, clauseId: string, text: string) => {
    const current = latestRunRef.current ?? run;
    const matterId = activeMatterId;
    if (!current || !matterId) return;

    const existing = current.findings[docId]?.[clauseId];
    if (!existing) return;

    const profile = await getProfile();
    const note = makeNote(docId, clauseId, text, profile.id, Date.now(), uid());
    const updated = withUpdatedFinding(current, docId, clauseId, {
      ...existing,
      notes: [...existing.notes, note],
    });

    setVerifyBusyKey(findingKey(docId, clauseId));
    try {
      await saveReview(reviewFromRun(updated, matterId, settings.modelId, profile.id));
      latestRunRef.current = updated;
      setRun(updated);
    } catch (e) {
      notify(e instanceof Error ? `This note was not saved: ${e.message}` : 'This note was not saved.', 'error');
    } finally {
      setVerifyBusyKey(null);
    }
  };

  const handleRetryCell = (docId: string, clauseId: string) => {
    const current = latestRunRef.current ?? run;
    if (!current) return;
    const doc = documents.find(d => d.id === docId);
    if (!doc) return;
    const matterId = activeMatterId;
    // Mirrors handleStartRun: a retry is a fresh, live API call, so a stale
    // `authErrorHandledRef` from an earlier run (or from opening a review
    // that already had one) must not suppress the redirect if THIS call is
    // the one that gets rejected.
    authErrorHandledRef.current = false;

    const existing = current.findings[docId]?.[clauseId];

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
    let cleared = current;
    if (existing?.verification && existing.verification.state !== 'unchecked') {
      cleared = withUpdatedFinding(current, docId, clauseId, {
        ...existing,
        verification: resetVerification(existing.verification),
      });
      const clauseTitle = current.templateSnapshot.clauses.find(c => c.id === clauseId)?.title ?? 'This clause';
      notify(`${clauseTitle} is being re-run, so its verification was cleared.`);
    }

    latestRunRef.current = cleared;
    setRun(cleared);

    // `retryCell` is handed `cleared`, a snapshot frozen at the moment the
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
    // cleared: `latestRunRef.current` was set to `cleared` immediately
    // before this retry started, so the retried clause's own verification
    // is already `unchecked` by the time any snapshot arrives —
    // `carryHumanState` only ever carries a verification when it is NOT
    // `unchecked`. There is nothing left for it to fight.
    //
    // This also subsumes the retried clause's own notes, which used to need
    // a separate, narrower patch: `before` (`cleared`) still holds this
    // clause's original notes, and every snapshot `retryCell` emits for it
    // arrives with `notes: []`, so the standard notes rule (kept below)
    // already reapplies them without a second, parallel mechanism that has
    // to agree with the first.
    const onRetryUpdate = (updated: ReviewRun) => {
      const merged = carryHumanState(latestRunRef.current, updated);
      latestRunRef.current = merged;
      setRun(merged);
    };

    retryCell(cleared, doc, clauseId, settings, onRetryUpdate)
      .then(async (updated) => {
        // Important 2: guards this write the same way handleStartRun's
        // handleUpdate/persistFinal do — `matterId` is a local snapshot of
        // `activeMatterId`, and the matter it names may have been deleted
        // while `retryCell`'s API call was in flight.
        if (!matterId || deletedMatterIdsRef.current.has(matterId)) return;
        // `latestRunRef.current`, not the raw `updated` retryCell resolved
        // with: `onRetryUpdate` (above) merges in whatever human writes
        // landed on OTHER findings while this retry was in flight, and
        // `updated` is retryCell's un-patched return value, which knows
        // nothing about them. Persisting `updated` directly would save a
        // review with those writes gone while the screen still shows them —
        // a verification or note that displays but was never (re-)written,
        // the exact failure this task exists to remove.
        const toPersist = latestRunRef.current ?? updated;
        try {
          const profile = await getProfile();
          await saveReview(reviewFromRun(toPersist, matterId, settings.modelId, profile.id));
          loadMatterReviews(matterId);
        } catch (e) {
          notify(e instanceof Error ? e.message : 'Could not save this retry.', 'error');
        }
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
   */
  const handleRunReviewForMatter = async (matterId: string, template: Template) => {
    try {
      const docs = await Promise.all(matterDocuments.map(async (record) => {
        const blob = await getDocumentBlob(record.id);
        return documentFileForReview(record, blob);
      }));
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

  const handleCreateTemplate = async (params: CreateTemplateParams) => {
    if (params.type === 'ai' && !ensureConfigured('Add your OpenRouter key to generate a template.')) {
      setCreateOpen(false);
      return;
    }

    setCreateLoading(true);
    setGenerationStatus('');
    try {
      const t = params.type === 'manual'
        ? newTemplate(params.name)
        : await generateTemplate({
            contractType: params.contractType,
            depth: params.depth,
            verbosity: params.verbosity,
            context: params.context,
            settings,
            onStatus: setGenerationStatus,
          });
      setActiveTemplate(t);
      // Never-saved: any further edit (or none at all) counts as unsaved —
      // this is what makes closing right after a paid AI generation trigger
      // the discard warning (Important 7).
      setSavedTemplateSnapshot(null);
      setCreateOpen(false);
      navigate({ name: 'playbook', playbookId: t.id });
    } catch (e) {
      if (isAuthError(e)) {
        setCreateOpen(false);
        handleAuthError();
      } else {
        notify(e instanceof Error ? e.message : 'Template creation failed.', 'error');
      }
    } finally {
      setCreateLoading(false);
      setGenerationStatus('');
    }
  };

  const handleSaveTemplate = async () => {
    if (!activeTemplate) return;
    try {
      const saved = await saveTemplate(activeTemplate);
      setActiveTemplate(saved);
      setSavedTemplateSnapshot(JSON.stringify(saved));
      await refreshTemplates();
      notify('Template saved.');
    } catch (e) {
      notify(e instanceof Error ? e.message : 'Could not save the template.', 'error');
    }
  };

  const handleExportTemplate = (t: Template) => {
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
      await importTemplate(text);
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

  return (
    <div className="min-h-screen flex flex-col bg-surface">
      <Toast toast={toast} />

      <header className="h-16 border-b border-white/10 bg-[#111] flex items-center justify-between px-6 shrink-0">
        <button
          className="flex items-center gap-2"
          onClick={() => requestView('matters')}
        >
          <div className="w-8 h-8 bg-gradient-to-br from-violet-600 to-indigo-600 rounded-lg flex items-center justify-center text-white">
            <FileText className="w-5 h-5" />
          </div>
          <span className="font-bold text-lg text-white">LexPrompt</span>
        </button>

        <div className="flex items-center gap-6">
          <button
            onClick={() => requestView('matters')}
            className={`text-sm flex items-center gap-1.5 ${view === 'matters' ? 'text-white' : 'text-gray-400 hover:text-white'}`}
          >
            <Briefcase className="w-4 h-4" /> Matters
          </button>
          <button
            onClick={() => requestView('library')}
            className={`text-sm ${view === 'library' || view === 'editor' ? 'text-white' : 'text-gray-400 hover:text-white'}`}
          >
            Library
          </button>
          {run && (
            // Important 6: nothing else sets `view` back to 'results' once
            // the user navigates elsewhere (e.g. to Library), so a run was
            // otherwise stranded for the rest of the session with no way
            // back except starting a brand new one.
            <button
              onClick={() => requestView('results')}
              className={`text-sm flex items-center gap-1.5 ${view === 'results' || view === 'tabular' ? 'text-white' : 'text-gray-400 hover:text-white'}`}
              title="Back to the current run's results"
            >
              <ClipboardList className="w-4 h-4" /> Current run
            </button>
          )}
          <div className="h-4 w-px bg-white/10" />
          <button
            onClick={() => requestView('settings')}
            className={`text-gray-400 hover:text-white ${view === 'settings' ? 'text-white' : ''}`}
            title="Settings"
          >
            <SettingsIcon className="w-4 h-4" />
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
              onCreate={() => setCreateOpen(true)}
              onImport={handleImportTemplate}
              importing={importing}
            />
          )
        )}
        {view === 'matter' && (
          matterError ? (
            <LoadErrorPanel message={matterError} onRetry={() => matterRouteId && loadMatterHome(matterRouteId)} />
          ) : matterNotFound ? (
            <div className="p-8 max-w-md mx-auto text-center space-y-4">
              <p className="text-gray-400">This matter could not be found. It may have been deleted.</p>
              <button
                onClick={() => requestView('matters')}
                className="px-4 py-2 rounded-md bg-violet-600 text-white hover:bg-violet-500"
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
              reviews={matterReviews}
              reviewsError={matterReviewsError}
              onRetryReviews={() => loadMatterReviews(matter.id)}
              onOpenReview={(review) => handleOpenReview(matter.id, review)}
              playbooks={templates}
              playbooksError={libraryLoadError}
              onRetryPlaybooks={() => loadLibrary()}
              onRunReview={(playbook) => handleRunReviewForMatter(matter.id, playbook)}
              onDeleteMatter={handleDeleteMatterFromHome}
            />
          ) : null
        )}
        {view === 'not-found' && (
          <div className="p-8 max-w-md mx-auto text-center space-y-4">
            <p className="text-gray-400">This page could not be found.</p>
            <button
              onClick={() => requestView('matters')}
              className="px-4 py-2 rounded-md bg-violet-600 text-white hover:bg-violet-500"
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
              <p className="text-gray-400">This playbook could not be found. It may have been deleted.</p>
              <button
                onClick={() => navigate({ name: 'playbooks' })}
                className="px-4 py-2 rounded-md bg-violet-600 text-white hover:bg-violet-500"
              >
                Back to Library
              </button>
            </div>
          ) : route.name === 'playbook' && playbookLoading && !activeTemplate ? (
            <div className="p-8 text-gray-500">Loading playbook…</div>
          ) : activeTemplate ? (
            <TemplateEditor
              template={activeTemplate}
              onChange={setActiveTemplate}
              onSave={handleSaveTemplate}
              onExport={() => handleExportTemplate(activeTemplate)}
              onShowMegaPrompt={() => setMegaPromptOpen(true)}
              onClose={() => { if (confirmDiscardIfDirty()) navigate({ name: 'playbooks' }); }}
            />
          ) : (
            <div className="p-8 text-gray-500">No template selected.</div>
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
            <div className="p-8 text-gray-500">No template selected.</div>
          )
        )}
        {(view === 'results' || view === 'tabular') && (
          route.name === 'review' && reviewLoadError ? (
            <LoadErrorPanel
              message={reviewLoadError}
              onRetry={() => openReview(route.matterId, route.reviewId)}
            />
          ) : route.name === 'review' && reviewLoading ? (
            <div className="p-8 text-gray-500">Loading review…</div>
          ) : run ? (
            <div className="h-[calc(100vh-64px)] flex flex-col">
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
              <div className="flex-1 min-h-0">
                {view === 'results' ? (
                  <ResultsView
                    run={run}
                    documents={documents}
                    settings={settings}
                    onRetryCell={handleRetryCell}
                    onOpenTabular={() => setView('tabular')}
                    onError={(message) => notify(message, 'error')}
                    onAuthError={handleAuthError}
                    interrupted={isInterrupted}
                    onVerify={handleVerify}
                    onAddNote={handleAddNote}
                    verifyBusyKey={verifyBusyKey}
                    authorInitials={profile?.initials ?? 'ME'}
                  />
                ) : (
                  <TabularReview
                    run={run}
                    documents={documents}
                    onRetryCell={handleRetryCell}
                    onOpenCards={() => setView('results')}
                    interrupted={isInterrupted}
                    onVerify={handleVerify}
                    onAddNote={handleAddNote}
                    verifyBusyKey={verifyBusyKey}
                    authorInitials={profile?.initials ?? 'ME'}
                  />
                )}
              </div>
            </div>
          ) : (
            <div className="p-8 text-gray-500">No run yet. Start one from a template.</div>
          )
        )}
        {view === 'settings' && (
          <SettingsPanel settings={settings} onChange={setSettings} />
        )}
      </main>

      <CreateTemplateDialog
        isOpen={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreate={handleCreateTemplate}
        loading={createLoading}
        status={generationStatus}
        canGenerate={isConfigured}
      />
      <MegaPromptModal
        isOpen={megaPromptOpen}
        onClose={() => setMegaPromptOpen(false)}
        template={activeTemplate}
      />
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
  const [migration, setMigration] = useState<MigrationState>({ kind: 'pending' });

  const runMigration = () => {
    setMigration({ kind: 'pending' });
    migrateIfNeeded()
      .then((result) => {
        if (result.status === 'failed') {
          setMigration({
            kind: 'failed',
            error: result.error || 'The playbook migration failed for an unknown reason.',
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

  if (migration.kind === 'pending') {
    // Deliberately blank rather than a spinner: this resolves in a single
    // IndexedDB round trip (typically sub-frame), and the fast, common
    // `not-needed` case shouldn't flash a loading screen ahead of it.
    return <div className="min-h-screen bg-surface" />;
  }

  if (migration.kind === 'failed') {
    return <MigrationBlockedScreen error={migration.error} onRetry={runMigration} />;
  }

  return <AppShell migratedCount={migration.migratedCount} />;
}
