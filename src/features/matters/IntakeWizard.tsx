import React from 'react';
import { FileWarning, ScanSearch, Layers, Trash2 } from 'lucide-react';
import type { DocumentRecord, Matter, Playbook } from '../../types';
import { suggestCollections } from '../../lib/collectionSuggest';
import { assessDocument } from '../../lib/modelContext';
import { STORAGE_PRIVACY } from '../../lib/privacyCopy';
import { LoadErrorPanel } from '../../components/LoadErrorPanel';
import { Button } from '../../components/Button';

const STEPS = ['Matter', 'Documents', 'Playbook'] as const;

export interface IntakeWizardProps {
  matter: Matter;
  documents: DocumentRecord[];
  documentsError: string | null;
  onRetryDocuments: () => void;
  onAddDocuments: (files: File[]) => Promise<void>;
  onRemoveDocument: (documentId: string) => Promise<void>;
  onCreateCollection: (params: { name: string; baseDocumentId: string; variesDocumentIds: string[] }) => Promise<void>;
  /** Task 19 fills these in — step 3, the playbook picker. Declared here so
   *  this commit's props already match what Task 19 consumes, and Task 19
   *  changes no signature. */
  playbooks: Playbook[];
  playbooksError: string | null;
  onRetryPlaybooks: () => void;
  onRunReview: (playbook: Playbook) => Promise<void>;
  onCreatePlaybook: () => void;
  modelId: string;
  onOpenSettings: () => void;
}

/**
 * A document record carries no page images by design (they are derived data,
 * regenerated on demand and never stored), so this asks the narrower
 * question the record can answer: did any usable text come out of it?
 * `assessDocument` with `modelSupportsImages: false` returns `unreadable`
 * exactly when it did not — which is the fact worth stating here, once,
 * before the run, rather than once per clause afterwards.
 */
function noUsableText(doc: DocumentRecord): boolean {
  return assessDocument({ text: doc.text }, false).kind === 'unreadable';
}

export function IntakeWizard({
  matter, documents, documentsError, onRetryDocuments, onAddDocuments, onRemoveDocument,
  onCreateCollection, playbooks, playbooksError, onRetryPlaybooks, onRunReview, onCreatePlaybook,
  modelId, onOpenSettings,
}: IntakeWizardProps) {
  const suggestions = documents.length > 1 ? suggestCollections(documents) : [];
  const step = documents.length === 0 ? 2 : 3;

  return (
    <div className="max-w-3xl mx-auto p-8 space-y-6">
      <ol className="flex items-center gap-6">
        {STEPS.map((label, i) => (
          <li key={label} className="flex items-center gap-2">
            <span className={`w-5 h-5 rounded-meter flex items-center justify-center font-mono text-chip ${i + 1 <= step ? 'bg-accent text-page' : 'bg-chip-fill text-ink-4'}`}>
              {i + 1}
            </span>
            <span className={`font-mono text-label uppercase ${i + 1 <= step ? 'text-ink-1' : 'text-ink-4'}`}>{label}</span>
          </li>
        ))}
      </ol>

      <section className="bg-card border border-rule rounded-card p-5">
        <h2 className="font-prose text-matter-title text-ink-1">{matter.name}</h2>
        {matter.client && <p className="font-ui text-ui text-ink-2 mt-1">{matter.client}</p>}
      </section>

      <section className="bg-card border border-rule rounded-card p-5 space-y-4">
        <h3 className="font-prose text-section text-ink-1">Documents</h3>

        {documentsError ? (
          <LoadErrorPanel compact message={documentsError} onRetry={onRetryDocuments} />
        ) : (
          <>
            <label className="block border border-dashed border-rule-strong rounded-panel p-8 text-center cursor-pointer hover:border-accent-edge">
              <input
                type="file"
                multiple
                className="sr-only"
                onChange={(e) => { const files = Array.from(e.target.files ?? []); if (files.length) void onAddDocuments(files); }}
              />
              <span className="font-ui text-ui text-ink-2">Drop contracts here, or choose files</span>
            </label>

            <ul className="space-y-3">
              {documents.map(doc => (
                <li key={doc.id} className="border border-rule rounded-control p-3 space-y-2">
                  <div className="flex items-center gap-2">
                    <span className="font-ui text-ui text-ink-1 truncate">{doc.name}</span>
                    <span className="font-mono text-pin text-ink-4 uppercase">{doc.kind}</span>
                    <button
                      onClick={() => void onRemoveDocument(doc.id)}
                      aria-label={`Remove ${doc.name}`}
                      title="Remove"
                      className="ml-auto p-1 rounded-inset text-ink-4 hover:text-risk-high"
                    >
                      <Trash2 className="w-4 h-4" aria-hidden="true" />
                      <span className="sr-only">Remove</span>
                    </button>
                  </div>

                  {doc.parseError && (
                    <p className="flex items-start gap-2 font-ui text-ui-sm text-risk-high bg-risk-high-tint border border-risk-high-edge rounded-inset p-2">
                      <FileWarning className="w-4 h-4 shrink-0 mt-0.5" aria-hidden="true" />
                      <span>{doc.parseError}</span>
                    </p>
                  )}

                  {!doc.parseError && noUsableText(doc) && (
                    <p className="flex items-start gap-2 font-ui text-ui-sm text-risk-med bg-risk-med-tint border border-risk-med-edge rounded-inset p-2">
                      <ScanSearch className="w-4 h-4 shrink-0 mt-0.5" aria-hidden="true" />
                      <span>
                        No text could be extracted from this document — it looks like a scan.
                        Reviewing it needs a vision-capable model.
                      </span>
                    </p>
                  )}

                  {doc.markupNotice && (
                    <p className="font-ui text-ui-sm text-risk-med bg-risk-med-tint border border-risk-med-edge rounded-inset p-2">
                      {doc.markupNotice}
                    </p>
                  )}
                </li>
              ))}
            </ul>

            {suggestions.map(s => (
              <div key={s.baseDocumentId} className="border border-accent-edge bg-accent-tint rounded-control p-3 flex items-start gap-2">
                <Layers className="w-4 h-4 shrink-0 mt-0.5 text-accent" aria-hidden="true" />
                <div className="min-w-0">
                  <p className="font-ui text-ui text-ink-1">{s.name} — read together</p>
                  <p className="font-ui text-ui-sm text-ink-2 mt-0.5">{s.reason}</p>
                </div>
                <Button
                  variant="ghost"
                  className="ml-auto shrink-0"
                  onClick={() => void onCreateCollection({ name: s.name, baseDocumentId: s.baseDocumentId, variesDocumentIds: s.variesDocumentIds })}
                >
                  Group these
                </Button>
              </div>
            ))}
          </>
        )}
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
          <ul className="space-y-2">
            {[...playbooks].sort((a, b) => b.updatedAt - a.updatedAt).map(p => (
              <li key={p.id} className="flex items-center gap-3 border border-rule rounded-control p-3">
                <span data-playbook-name className="font-ui text-ui text-ink-1 truncate">{p.name}</span>
                <Button className="ml-auto shrink-0" onClick={() => void onRunReview(p)}>
                  Run this playbook
                </Button>
              </li>
            ))}
          </ul>
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
