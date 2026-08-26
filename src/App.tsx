import React, { useEffect, useRef, useState } from 'react';
import { FileText, Settings as SettingsIcon, ClipboardList } from 'lucide-react';
import type { Template, DocumentFile, ReviewRun, Settings } from './types';
import { loadSettings, saveSettings, listTemplates, saveTemplate, deleteTemplate, newTemplate, exportTemplate, importTemplate } from './lib/storage';
import { generateTemplate } from './features/templates/generateTemplate';
import { listModels, isAuthError } from './lib/openrouter';
import { useToast, Toast } from './components/Toast';
import { SettingsPanel } from './features/settings/SettingsPanel';
import { TemplateLibrary } from './features/templates/TemplateLibrary';
import { TemplateEditor } from './features/templates/TemplateEditor';
import { CreateTemplateDialog, type CreateTemplateParams } from './features/templates/CreateTemplateDialog';
import { MegaPromptModal } from './features/templates/MegaPromptModal';
import { RunPanel, RunProgressBar, RunCancelledBanner } from './features/review/RunPanel';
import { ResultsView } from './features/review/ResultsView';
import { emptyRun, runReview, retryCell } from './features/review/runReview';
import { TabularReview } from './features/tabular/TabularReview';

type View = 'library' | 'editor' | 'run' | 'results' | 'tabular' | 'settings';

const AUTH_ERROR_MESSAGE = 'Your OpenRouter API key was rejected. Update it in Settings and try again.';

export default function App() {
  const [view, setView] = useState<View>('library');
  const [templates, setTemplates] = useState<Template[]>([]);
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

  const refreshTemplates = () => listTemplates().then(setTemplates);

  useEffect(() => {
    refreshTemplates();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  return (
    <div className="min-h-screen flex flex-col bg-surface">
      <Toast toast={toast} />

      <header className="h-16 border-b border-white/10 bg-[#111] flex items-center justify-between px-6 shrink-0">
        <button
          className="flex items-center gap-2"
          onClick={() => requestView('library')}
        >
          <div className="w-8 h-8 bg-gradient-to-br from-violet-600 to-indigo-600 rounded-lg flex items-center justify-center text-white">
            <FileText className="w-5 h-5" />
          </div>
          <span className="font-bold text-lg text-white">LexPrompt</span>
        </button>

        <div className="flex items-center gap-6">
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
        {view === 'library' && (
          <TemplateLibrary
            templates={templates}
            onOpen={handleOpenTemplate}
            onRun={handleRunTemplate}
            onDelete={handleDeleteTemplate}
            onCreate={() => setCreateOpen(true)}
            onImport={handleImportTemplate}
            importing={importing}
          />
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
