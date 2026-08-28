import React from 'react';
import type { Matter, Playbook } from '../../types';
import { STORAGE_PRIVACY } from '../../lib/privacyCopy';
import { LoadErrorPanel } from '../../components/LoadErrorPanel';
import { Button } from '../../components/Button';

const STEPS = ['Matter', 'Documents', 'Playbook'] as const;

/**
 * `MatterHome` renders this ONLY when the matter has no documents at all
 * (spec §10.2: an empty matter shows the first-run wizard, not an empty
 * table), and the instant a file is added the list takes over and this
 * unmounts. Its props say so: it takes no `documents`, so it cannot grow a
 * document list, a per-document disclosure, or a collection suggestion that
 * nothing could ever render.
 *
 * It used to take them. All of that markup existed, was tested, and was
 * unreachable — including the scan disclosure, which existed nowhere else
 * in the app. Everything a listed document has to say about itself now
 * lives in `DocumentNotices`, rendered by the lists that can actually
 * contain one.
 */
export interface IntakeWizardProps {
  matter: Matter;
  onAddDocuments: (files: File[]) => Promise<void>;
  playbooks: Playbook[];
  playbooksError: string | null;
  onRetryPlaybooks: () => void;
  onCreatePlaybook: () => void;
  modelId: string;
  onOpenSettings: () => void;
}

/** Constant, because this screen only exists at step 2. The matter is made
 *  (step 1, done) and nothing has been added yet, so documents is where the
 *  reader is and the playbook step is ahead of them. */
const STEP = 2;

export function IntakeWizard({
  matter, onAddDocuments, playbooks, playbooksError, onRetryPlaybooks, onCreatePlaybook,
  modelId, onOpenSettings,
}: IntakeWizardProps) {
  return (
    <div className="max-w-3xl mx-auto p-8 space-y-6">
      <ol className="flex items-center gap-6">
        {STEPS.map((label, i) => (
          <li key={label} className="flex items-center gap-2">
            <span className={`w-5 h-5 rounded-meter flex items-center justify-center font-mono text-chip ${i + 1 <= STEP ? 'bg-accent text-page' : 'bg-chip-fill text-ink-4'}`}>
              {i + 1}
            </span>
            <span className={`font-mono text-label uppercase ${i + 1 <= STEP ? 'text-ink-1' : 'text-ink-4'}`}>{label}</span>
          </li>
        ))}
      </ol>

      <section className="bg-card border border-rule rounded-card p-5">
        <h2 className="font-prose text-matter-title text-ink-1">{matter.name}</h2>
        {matter.client && <p className="font-ui text-ui text-ink-2 mt-1">{matter.client}</p>}
      </section>

      <section className="bg-card border border-rule rounded-card p-5 space-y-4">
        <h3 className="font-prose text-section text-ink-1">Documents</h3>
        {/* `relative`: containing block for the input's `sr-only` styling —
           see the note on `ResultsView`'s finding scroller for why an
           absolutely-positioned sr-only element needs a positioned
           ancestor of its own rather than relying on whatever wraps it. */}
        <label className="relative block border border-dashed border-rule-strong rounded-panel p-8 text-center cursor-pointer hover:border-accent-edge">
          <input
            type="file"
            multiple
            className="sr-only"
            onChange={(e) => { const files = Array.from(e.target.files ?? []); if (files.length) void onAddDocuments(files); }}
          />
          <span className="font-ui text-ui text-ink-2">Drop contracts here, or choose files</span>
        </label>
      </section>

      <section className="bg-card border border-rule rounded-card p-5 space-y-3">
        <h3 className="font-prose text-section text-ink-1">Playbook</h3>
        {playbooksError ? (
          <LoadErrorPanel compact message={playbooksError} onRetry={onRetryPlaybooks} />
        ) : playbooks.length === 0 ? (
          <div className="space-y-3">
            <p className="font-ui text-ui text-ink-2">
              You have no playbooks yet. A playbook is the list of clauses a review looks for.
            </p>
            <Button onClick={onCreatePlaybook}>Create a playbook</Button>
          </div>
        ) : (
          <>
            {/* No `Run this playbook` here. This screen only renders when the
                matter has nothing in it, so a run button would promise a
                review of documents that do not exist — it would land the
                reader on the run screen with an empty file list. The
                playbooks are shown because step 3 is a real step and it is
                worth knowing it is ready; running one is offered by the
                matter's own `Run a review`, once there is something to run
                it over. */}
            <p className="font-ui text-ui-sm text-ink-2">
              Add a document above first — a review runs over this matter’s documents.
            </p>
            <ul className="space-y-2">
              {[...playbooks].sort((a, b) => b.updatedAt - a.updatedAt).map(p => (
                <li key={p.id} className="flex items-center gap-3 border border-rule rounded-control p-3">
                  <span data-playbook-name className="font-ui text-ui text-ink-1 truncate">{p.name}</span>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      <footer className="space-y-2">
        <p className="font-ui text-ui-sm text-ink-2">{STORAGE_PRIVACY[0]}</p>
        <p className="font-ui text-meta text-ink-3">
          Reviews will run on <span className="font-mono text-pin text-ink-2">{modelId}</span>.{' '}
          <button type="button" onClick={onOpenSettings} className="text-accent hover:underline">
            Settings
          </button>
        </p>
      </footer>
    </div>
  );
}
