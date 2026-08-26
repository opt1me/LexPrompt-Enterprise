import React, { useState } from 'react';
import { FileText, Settings as SettingsIcon } from 'lucide-react';
import type { Template, DocumentFile, ReviewRun, Settings } from './types';
import { loadSettings } from './lib/storage';
import { useToast, Toast } from './components/Toast';
import { SettingsPanel } from './features/settings/SettingsPanel';

type View = 'library' | 'editor' | 'run' | 'results' | 'tabular' | 'settings';

export default function App() {
  const [view, setView] = useState<View>('library');
  const [templates, setTemplates] = useState<Template[]>([]);
  const [activeTemplate, setActiveTemplate] = useState<Template | null>(null);
  const [documents, setDocuments] = useState<DocumentFile[]>([]);
  const [run, setRun] = useState<ReviewRun | null>(null);
  const [settings, setSettings] = useState<Settings>(() => loadSettings());
  const { notify, toast } = useToast();

  const isConfigured = Boolean(settings.apiKey && settings.modelId);

  /**
   * Views that need an OpenRouter key/model (running a review, generating a
   * template) route to Settings instead, with an explanatory toast, rather
   * than opening a view that can only fail.
   */
  const requestView = (next: View) => {
    if (next === 'run' && !isConfigured) {
      notify('Add your OpenRouter key to get started.', 'error');
      setView('settings');
      return;
    }
    setView(next);
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
          <div className="p-8 text-gray-500">Template library — Task 14.</div>
        )}
        {view === 'editor' && <div className="p-8 text-gray-500">Template editor — Task 14.</div>}
        {view === 'run' && <div className="p-8 text-gray-500">Run panel — Task 16.</div>}
        {view === 'results' && <div className="p-8 text-gray-500">Results view — Task 16.</div>}
        {view === 'tabular' && <div className="p-8 text-gray-500">Tabular review — Task 17.</div>}
        {view === 'settings' && (
          <SettingsPanel settings={settings} onChange={setSettings} />
        )}
      </main>
    </div>
  );
}
