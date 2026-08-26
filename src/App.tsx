import React, { useEffect, useRef, useState } from 'react';
import { FileText, Settings as SettingsIcon } from 'lucide-react';
import type { Template, DocumentFile, ReviewRun, Settings } from './types';
import { loadSettings, listTemplates, saveTemplate, deleteTemplate, newTemplate, exportTemplate, importTemplate } from './lib/storage';
import { generateTemplate } from './features/templates/generateTemplate';
import { useToast, Toast } from './components/Toast';
import { SettingsPanel } from './features/settings/SettingsPanel';
import { TemplateLibrary } from './features/templates/TemplateLibrary';
import { TemplateEditor } from './features/templates/TemplateEditor';
import { CreateTemplateDialog, type CreateTemplateParams } from './features/templates/CreateTemplateDialog';
import { MegaPromptModal } from './features/templates/MegaPromptModal';
import { RunPanel, RunProgressBar } from './features/review/RunPanel';
import { ResultsView } from './features/review/ResultsView';
import { emptyRun, runReview, retryCell } from './features/review/runReview';

type View = 'library' | 'editor' | 'run' | 'results' | 'tabular' | 'settings';

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

  const isConfigured = Boolean(settings.apiKey && settings.modelId);

  const refreshTemplates = () => listTemplates().then(setTemplates);

  useEffect(() => {
    refreshTemplates();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  const requestView = (next: View) => {
    if (next === 'run' && !ensureConfigured()) return;
    setView(next);
  };

  const handleOpenTemplate = (t: Template) => {
    setActiveTemplate(t);
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
      setCreateOpen(false);
      setView('editor');
    } catch (e) {
      notify(e instanceof Error ? e.message : 'Template creation failed.', 'error');
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
              onClose={() => setView('library')}
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
        {view === 'results' && (
          run ? (
            <div className="h-[calc(100vh-64px)] flex flex-col">
              {isRunning && <RunProgressBar run={run} onCancel={handleCancelRun} />}
              <div className="flex-1 min-h-0">
                <ResultsView
                  run={run}
                  documents={documents}
                  onRetryCell={handleRetryCell}
                  onOpenTabular={() => setView('tabular')}
                />
              </div>
            </div>
          ) : (
            <div className="p-8 text-gray-500">No run yet. Start one from a template.</div>
          )
        )}
        {view === 'tabular' && <div className="p-8 text-gray-500">Tabular review — Task 17.</div>}
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
