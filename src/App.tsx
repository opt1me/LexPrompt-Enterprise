import React, { useEffect, useRef, useState } from 'react';
import { FileText, Settings as SettingsIcon, ClipboardList, Briefcase } from 'lucide-react';
import type { Template, DocumentFile, DocumentRecord, Review, ReviewRun, Settings, Matter } from './types';
import { loadSettings, saveSettings } from './lib/storage';
import {
  listPlaybooks as listTemplates, savePlaybook as saveTemplate, deletePlaybook as deleteTemplate,
  newPlaybook as newTemplate, exportPlaybook as exportTemplate, importPlaybook as importTemplate,
} from './lib/db/playbooks';
import {
  listMatters, getMatter, saveMatter, newMatter, deleteMatter,
} from './lib/db/matters';
import { listDocuments, getDocument, addDocument, deleteDocument } from './lib/db/documents';
import { getDocumentBlob } from './lib/db/blobs';
import {
  listReviews, getReview, saveReview, createDebouncedReviewSaver,
} from './lib/db/reviews';
import { getProfile } from './lib/db/profile';
import { DbBlockedError } from './lib/db/open';
import { useRoute, type Route } from './lib/router';
import { generateTemplate } from './features/templates/generateTemplate';
import { listModels, isAuthError } from './lib/openrouter';
import { useToast, Toast } from './components/Toast';
import { SettingsPanel } from './features/settings/SettingsPanel';
import { MattersList, type MattersListItem, type CreateMatterParams } from './features/matters/MattersList';
import { MatterHome } from './features/matters/MatterHome';
import { TemplateLibrary } from './features/templates/TemplateLibrary';
import { TemplateEditor } from './features/templates/TemplateEditor';
import { CreateTemplateDialog, type CreateTemplateParams } from './features/templates/CreateTemplateDialog';
import { MegaPromptModal } from './features/templates/MegaPromptModal';
import { RunPanel, RunProgressBar, RunCancelledBanner } from './features/review/RunPanel';
import { ResultsView } from './features/review/ResultsView';
import { emptyRun, runReview, retryCell } from './features/review/runReview';
import { TabularReview } from './features/tabular/TabularReview';
import { parseFiles, toDocumentRecord, documentFileForViewing, documentFileForReview } from './lib/documents';

type View = 'matters' | 'library' | 'editor' | 'run' | 'results' | 'tabular' | 'settings' | 'matter';

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

/** A dedicated load-error panel, rendered INSTEAD OF the content it
 *  replaces — never alongside it, never falling back to an empty list. One
 *  shared component for the matters list, the playbook library, a single
 *  matter, and its documents/reviews, so the pattern can't drift between
 *  those five call sites (Critical fix in Task 4; the pattern is repeated
 *  and folded here rather than copied a fifth time). */
function LoadErrorPanel({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="p-8 max-w-md mx-auto text-center space-y-4">
      <p className="text-red-400">{message}</p>
      <button
        onClick={onRetry}
        className="px-4 py-2 rounded-md bg-violet-600 text-white hover:bg-violet-500"
      >
        Retry
      </button>
    </div>
  );
}

const AUTH_ERROR_MESSAGE = 'Your OpenRouter API key was rejected. Update it in Settings and try again.';

/** Maps a URL route to the `view` it corresponds to today. `matter` now has
 * its own screen (Task 11): `MatterHome`. `review` also renders — reusing
 * the existing results/tabular views scoped to a matter (see
 * `openReview`) — since a persisted review's cards and viewer are the same
 * v1 components a live run uses, just fed hydrated-from-IndexedDB data
 * instead of an in-session run. `playbook` (a single-playbook deep link)
 * has no screen yet and falls through to the matters list, the app's entry
 * point, rather than rendering nothing. */
function viewForRoute(route: Route): View {
  switch (route.name) {
    case 'matters': return 'matters';
    case 'matter': return 'matter';
    case 'review': return 'results';
    case 'playbooks': return 'library';
    case 'settings': return 'settings';
    default: return 'matters';
  }
}

/** The inverse mapping, for the views that own a canonical URL. Views with
 * no route of their own (editor/run/tabular — all still session-scoped) are
 * intentionally absent: switching to one of them must not push a history
 * entry it can't be deep-linked back into yet. `matter` and `results` are
 * NOT listed here either, even though both now have routes — both carry an
 * id (`matterId`, or `matterId`+`reviewId`) that this static per-`View`
 * table cannot express, so their navigation goes through `navigate(...)`
 * directly at the call site instead of through `requestView`. */
const ROUTE_FOR_VIEW: Partial<Record<View, Route>> = {
  matters: { name: 'matters' },
  library: { name: 'playbooks' },
  settings: { name: 'settings' },
};

export default function App() {
  const [route, navigate] = useRoute();
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
  // Non-null when a run was started from, or a review opened from,
  // MatterHome — set back to `null` for the Library's own standalone run
  // flow (`handleRunTemplate`), which stays session-only exactly as in v1.
  // Drives whether completing/cancelling/retrying a run persists a Review.
  const [activeMatterId, setActiveMatterId] = useState<string | null>(null);
  // RunPanel seeds its own upload-list state from `initialDocuments` only
  // on mount (a plain useState initializer, not synced on prop changes) —
  // bumping this key on every entry into the run flow forces a fresh mount,
  // so a second "Run a review" (a different matter, or the same one after
  // adding more documents) doesn't show a stale panel left over from the
  // previous run.
  const [runPanelKey, setRunPanelKey] = useState(0);
  const [settings, setSettings] = useState<Settings>(() => loadSettings());
  const { notify, toast } = useToast();

  const [createOpen, setCreateOpen] = useState(false);
  const [createLoading, setCreateLoading] = useState(false);
  const [generationStatus, setGenerationStatus] = useState('');
  const [megaPromptOpen, setMegaPromptOpen] = useState(false);
  const [importing, setImporting] = useState(false);

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
      // gets a generic message plus a Retry action instead.
      setLibraryLoadError(
        e instanceof DbBlockedError
          ? e.message
          : 'The playbook library could not be loaded. Try again.',
      );
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
      setMattersLoadError(
        e instanceof DbBlockedError
          ? e.message
          : 'The matters list could not be loaded. Try again.',
      );
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
      setMatterDocumentsError(
        e instanceof DbBlockedError
          ? e.message
          : 'The documents in this matter could not be loaded. Try again.',
      );
    });
  };

  const loadMatterReviews = (matterId: string) => {
    setMatterReviewsError(null);
    return listReviews(matterId).then(setMatterReviews).catch((e) => {
      setMatterReviewsError(
        e instanceof DbBlockedError
          ? e.message
          : 'The reviews in this matter could not be loaded. Try again.',
      );
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
      setMatterError(
        e instanceof DbBlockedError
          ? e.message
          : 'This matter could not be loaded. Try again.',
      );
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
      setReviewLoadError(
        e instanceof DbBlockedError
          ? e.message
          : 'This review could not be loaded. Try again.',
      );
    } finally {
      setReviewLoading(false);
    }
  };

  const reviewRouteKey = route.name === 'review' ? `${route.matterId}/${route.reviewId}` : null;
  useEffect(() => {
    if (route.name === 'review') openReview(route.matterId, route.reviewId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reviewRouteKey]);

  // Keeps `view` in step with the URL for the routes an existing screen
  // understands (see `viewForRoute`) — fires on browser back/forward
  // (`useRoute`'s popstate listener updates `route`) and on our own
  // `navigate` calls below. Views with no route of their own are untouched
  // by this: `route` only changes via `navigate`, and nothing here calls it
  // for editor/run/results/tabular, so this effect never fires while one of
  // those is showing.
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
    setView('editor');
  };

  const handleRunTemplate = (t: Template) => {
    setActiveTemplate(t);
    setActiveMatterId(null); // Library's standalone run flow is never matter-scoped.
    setRun(null);
    setDocuments([]);
    setRunPanelKey(k => k + 1);
    requestView('run');
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

    const reviewSaver = matterId ? createDebouncedReviewSaver() : null;

    const handleUpdate = (updated: ReviewRun) => {
      latestRunRef.current = updated;
      setRun(updated);
      if (matterId && reviewSaver) {
        reviewSaver.scheduleSave(reviewFromRun(updated, matterId, settings.modelId, userId));
      }
    };

    const persistFinal = async (finalRun: ReviewRun) => {
      if (!matterId || !reviewSaver) return;
      try {
        await reviewSaver.saveNow(reviewFromRun(finalRun, matterId, settings.modelId, userId));
      } catch (e) {
        notify(e instanceof Error ? e.message : 'Could not save this review.', 'error');
      }
      reviewSaver.dispose();
      loadMatterReviews(matterId);
    };

    runReview(newRun, docs, settings, handleUpdate, controller.signal)
      .then(async (finalRun) => {
        setIsRunning(false);
        await persistFinal(finalRun);
      })
      .catch(async (error) => {
        setIsRunning(false);
        // runReview rejects on abort — that's a deliberate stop, not a
        // failure, and must never surface as an error toast. Everything
        // already completed stays exactly as it was set by the last
        // onUpdate call. A cancelled run is still real, partial work, so
        // it's persisted the same as a completed one.
        if (error instanceof DOMException && error.name === 'AbortError') {
          await persistFinal(latestRunRef.current ?? newRun);
          return;
        }
        notify(error instanceof Error ? error.message : 'Review failed.', 'error');
      });
  };

  const handleCancelRun = () => {
    abortControllerRef.current?.abort();
  };

  const handleRetryCell = (docId: string, clauseId: string) => {
    if (!run) return;
    const doc = documents.find(d => d.id === docId);
    if (!doc) return;
    const matterId = activeMatterId;
    // Mirrors handleStartRun: a retry is a fresh, live API call, so a stale
    // `authErrorHandledRef` from an earlier run (or from opening a review
    // that already had one) must not suppress the redirect if THIS call is
    // the one that gets rejected.
    authErrorHandledRef.current = false;
    retryCell(run, doc, clauseId, settings, setRun)
      .then(async (updated) => {
        if (!matterId) return;
        try {
          const profile = await getProfile();
          await saveReview(reviewFromRun(updated, matterId, settings.modelId, profile.id));
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
      await loadMatterDocuments(matterId);
      notify('Document removed.');
    } catch (e) {
      notify(e instanceof Error ? e.message : 'Could not remove the document.', 'error');
    }
  };

  /**
   * "Run a review" from Matter Home: the existing run flow (RunPanel →
   * handleStartRun), pre-seeded with this matter's own documents rather
   * than requiring them to be re-uploaded. Each is re-parsed from its
   * stored bytes (`documentFileForReview`) rather than trusting the
   * extracted text alone, so a scanned PDF gets its page images
   * regenerated for this run (spec §5.2 — never persisted, always
   * regenerable from the source bytes).
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
      setView('editor');
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

  const handleCreateMatter = async ({ name, client }: CreateMatterParams) => {
    try {
      const profile = await getProfile();
      const matter: Matter = { ...newMatter(name, profile.id), client };
      await saveMatter(matter);
      await refreshMatters();
      notify('Matter created.');
    } catch (e) {
      notify(e instanceof Error ? e.message : 'Could not create the matter.', 'error');
    }
  };

  /** Returns whether the delete succeeded, so `handleDeleteMatterFromHome`
   *  (Task 11) knows it's safe to navigate away — never stranding the user
   *  on a dead matter screen, but also never leaving one on a delete that
   *  actually failed. */
  const handleDeleteMatter = async (id: string): Promise<boolean> => {
    try {
      await deleteMatter(id);
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
              onRunReview={(playbook) => handleRunReviewForMatter(matter.id, playbook)}
              onDeleteMatter={handleDeleteMatterFromHome}
            />
          ) : null
        )}
        {view === 'editor' && (
          activeTemplate ? (
            <TemplateEditor
              template={activeTemplate}
              onChange={setActiveTemplate}
              onSave={handleSaveTemplate}
              onExport={() => handleExportTemplate(activeTemplate)}
              onShowMegaPrompt={() => setMegaPromptOpen(true)}
              onClose={() => { if (confirmDiscardIfDirty()) setView('library'); }}
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
                  />
                ) : (
                  <TabularReview
                    run={run}
                    documents={documents}
                    onRetryCell={handleRetryCell}
                    onOpenCards={() => setView('results')}
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
    </div>
  );
}
