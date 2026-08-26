import React, { useEffect, useRef, useState } from 'react';
import { FileText, Settings as SettingsIcon, ClipboardList, Briefcase } from 'lucide-react';
import type { Template, DocumentFile, ReviewRun, Settings, Matter } from './types';
import { loadSettings, saveSettings } from './lib/storage';
import {
  listPlaybooks as listTemplates, savePlaybook as saveTemplate, deletePlaybook as deleteTemplate,
  newPlaybook as newTemplate, exportPlaybook as exportTemplate, importPlaybook as importTemplate,
} from './lib/db/playbooks';
import {
  listMatters, saveMatter, newMatter, deleteMatter,
} from './lib/db/matters';
import { listReviews } from './lib/db/reviews';
import { getProfile } from './lib/db/profile';
import { DbBlockedError } from './lib/db/open';
import { useRoute, type Route } from './lib/router';
import { generateTemplate } from './features/templates/generateTemplate';
import { listModels, isAuthError } from './lib/openrouter';
import { useToast, Toast } from './components/Toast';
import { SettingsPanel } from './features/settings/SettingsPanel';
import { MattersList, type MattersListItem, type CreateMatterParams } from './features/matters/MattersList';
import { TemplateLibrary } from './features/templates/TemplateLibrary';
import { TemplateEditor } from './features/templates/TemplateEditor';
import { CreateTemplateDialog, type CreateTemplateParams } from './features/templates/CreateTemplateDialog';
import { MegaPromptModal } from './features/templates/MegaPromptModal';
import { RunPanel, RunProgressBar, RunCancelledBanner } from './features/review/RunPanel';
import { ResultsView } from './features/review/ResultsView';
import { emptyRun, runReview, retryCell } from './features/review/runReview';
import { TabularReview } from './features/tabular/TabularReview';

type View = 'matters' | 'library' | 'editor' | 'run' | 'results' | 'tabular' | 'settings';

const AUTH_ERROR_MESSAGE = 'Your OpenRouter API key was rejected. Update it in Settings and try again.';

/** Maps a URL route to the `view` it corresponds to today. Only the routes
 * an existing screen actually understands are listed here — `matter`,
 * `review` and `playbook` (single-item deep links) have no screen yet
 * (Tasks 11/12) and fall through to the matters list, the app's entry
 * point, rather than rendering nothing. */
function viewForRoute(route: Route): View {
  switch (route.name) {
    case 'matters': return 'matters';
    case 'playbooks': return 'library';
    case 'settings': return 'settings';
    default: return 'matters';
  }
}

/** The inverse mapping, for the views that own a canonical URL. Views with
 * no route of their own (editor/run/results/tabular — all still
 * session-scoped pending Task 12) are intentionally absent: switching to
 * one of them must not push a history entry it can't be deep-linked back
 * into yet. */
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
    setRun(null);
    setDocuments([]);
    requestView('run');
  };

  /**
   * Switches to the results view immediately — before `runReview` settles,
   * not after — so the cards mount while the run is still in flight and
   * fill in one clause at a time as `onUpdate` (here, `setRun` itself)
   * fires. That progressive fill is the entire feel of the app; showing
   * results only once everything is done would defeat the point.
   */
  const handleStartRun = (docs: DocumentFile[]) => {
    if (!activeTemplate || docs.length === 0) return;
    const newRun = emptyRun(activeTemplate, docs);
    authErrorHandledRef.current = false;
    setDocuments(docs);
    setRun(newRun);
    setIsRunning(true);
    setView('results');

    const controller = new AbortController();
    abortControllerRef.current = controller;

    runReview(newRun, docs, settings, setRun, controller.signal)
      .then(() => setIsRunning(false))
      .catch((error) => {
        setIsRunning(false);
        // runReview rejects on abort — that's a deliberate stop, not a
        // failure, and must never surface as an error toast. Everything
        // already completed stays exactly as it was set by the last
        // onUpdate call.
        if (error instanceof DOMException && error.name === 'AbortError') return;
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
    retryCell(run, doc, clauseId, settings, setRun).catch((error) => {
      notify(error instanceof Error ? error.message : 'Retry failed.', 'error');
    });
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

  const handleDeleteMatter = async (id: string) => {
    try {
      await deleteMatter(id);
      await refreshMatters();
      notify('Matter deleted.');
    } catch (e) {
      notify(e instanceof Error ? e.message : 'Could not delete the matter.', 'error');
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
            <div className="p-8 max-w-md mx-auto text-center space-y-4">
              <p className="text-red-400">{mattersLoadError}</p>
              <button
                onClick={() => loadMatters()}
                className="px-4 py-2 rounded-md bg-violet-600 text-white hover:bg-violet-500"
              >
                Retry
              </button>
            </div>
          ) : (
            <MattersList
              matters={matters}
              onCreate={handleCreateMatter}
              onDelete={handleDeleteMatter}
            />
          )
        )}
        {view === 'library' && (
          libraryLoadError ? (
            <div className="p-8 max-w-md mx-auto text-center space-y-4">
              <p className="text-red-400">{libraryLoadError}</p>
              <button
                onClick={() => loadLibrary()}
                className="px-4 py-2 rounded-md bg-violet-600 text-white hover:bg-violet-500"
              >
                Retry
              </button>
            </div>
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
              template={activeTemplate}
              onBack={() => setView('library')}
              onRun={handleStartRun}
            />
          ) : (
            <div className="p-8 text-gray-500">No template selected.</div>
          )
        )}
        {(view === 'results' || view === 'tabular') && (
          run ? (
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
