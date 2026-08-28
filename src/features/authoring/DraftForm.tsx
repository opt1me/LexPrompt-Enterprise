import React, { useEffect, useState } from 'react';
import { Wand2, AlertTriangle } from 'lucide-react';
import { Button } from '../../components/Button';
import { SourcePicker } from './SourcePicker';
import type { DraftFormValues } from './generateDraft';
import type { FewShotSource } from './fewShot';

export interface DraftFormProps {
  playbooks: { id: string; name: string }[];
  matters: { id: string; name: string }[];
  /** Forwarded to `SourcePicker` — see its own doc comment. Set when the
   *  matters list failed to load; renders an error in place of the matter
   *  checkboxes rather than letting a load failure look like "no matters". */
  mattersError?: string;
  onRetryMatters?: () => void;
  busy?: boolean;
  error?: string;
  /** True when `error` is a 401/403 rather than an ordinary failure (spec
   *  §7). The form never shows that error itself — it routes it to Settings
   *  via `onAuthError` instead. An ordinary failure (a 502, a timeout, "no
   *  usable clauses") is neither: it stays right here, in the form, next to
   *  everything the user already typed. */
  authFailed?: boolean;
  onAuthError?: () => void;
  /** Retains everything typed when generation fails (spec S7). */
  initialValues?: DraftFormValues;
  onSubmit: (form: DraftFormValues, sources: FewShotSource[]) => void;
  onCancel: () => void;
}

type AnswerLength = NonNullable<DraftFormValues['answerLength']>;
const ANSWER_LENGTHS: AnswerLength[] = ['brief', 'standard', 'detailed'];
const ANSWER_LENGTH_LABEL: Record<AnswerLength, string> = {
  brief: 'Brief',
  standard: 'Standard',
  detailed: 'Detailed',
};

/**
 * The AI-draft form (spec §3.2, §6 "Draft form"). One rule carries more
 * weight than the fields: a generation failure must not eat the form.
 * Every field here is `useState`-seeded from `initialValues` exactly once,
 * on mount — never re-synced from the prop on every render — so a parent
 * that keeps this same component instance mounted across a failed submit
 * (passing back a new `error`/`busy`) leaves everything the user typed
 * untouched. Losing a filled-in form to a 500 is the small betrayal that
 * stops people using a feature (spec §7).
 *
 * The auth split (spec §7): a 401/403 must route to Settings via
 * `onAuthError`, not render inline — but an ordinary failure (a 502, a
 * timeout) must NOT, or every unrelated failure sends someone to fix an API
 * key that was never the problem. The caller decides which is which (via
 * `isAuthError`, `openrouter.ts`) and hands this component only the
 * resulting `authFailed` flag; this component's only job is to act on it.
 */
export function DraftForm({
  playbooks,
  matters,
  mattersError,
  onRetryMatters,
  busy = false,
  error,
  authFailed = false,
  onAuthError,
  initialValues,
  onSubmit,
  onCancel,
}: DraftFormProps) {
  const [contractType, setContractType] = useState(initialValues?.contractType ?? '');
  const [actingFor, setActingFor] = useState(initialValues?.actingFor ?? '');
  const [context, setContext] = useState(initialValues?.context ?? '');
  const [targetClauseCount, setTargetClauseCount] = useState(
    initialValues?.targetClauseCount != null ? String(initialValues.targetClauseCount) : '',
  );
  const [answerLength, setAnswerLength] = useState<AnswerLength>(initialValues?.answerLength ?? 'standard');
  const [sources, setSources] = useState<FewShotSource[]>([]);

  // Fires exactly when the caller says this specific error is an auth
  // failure — never derived here from the error text, which would risk the
  // same class of mistake the negative test guards against (an ordinary
  // 502 read as if it were a rejected key).
  useEffect(() => {
    if (authFailed) onAuthError?.();
  }, [authFailed, onAuthError]);

  const canSubmit = !busy && contractType.trim() !== '';

  const handleSubmit = () => {
    if (!canSubmit) return;
    const count = Number.parseInt(targetClauseCount, 10);
    onSubmit(
      {
        contractType: contractType.trim(),
        actingFor: actingFor.trim() || undefined,
        context: context.trim() || undefined,
        targetClauseCount: Number.isFinite(count) && count > 0 ? count : undefined,
        answerLength,
      },
      sources,
    );
  };

  // The auth-routed error is never shown here (spec §7) — it belongs in
  // Settings, and showing both would be two contradictory stories about the
  // same failure.
  const showInlineError = !!error && !authFailed;

  return (
    <div className="space-y-5">
      {showInlineError && (
        <p className="flex items-start gap-2 text-xs text-risk-high bg-risk-high-tint border border-risk-high-edge rounded-inset p-3">
          <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" aria-hidden="true" />
          <span>{error}</span>
        </p>
      )}

      <div>
        <label className="block font-mono text-label text-ink-4 uppercase mb-1">
          Contract Type
        </label>
        <input
          value={contractType}
          onChange={(e) => setContractType(e.target.value)}
          placeholder="e.g. SaaS Agreement, NDA, Employment Contract"
          className="w-full bg-paper border border-rule rounded-control p-3 text-ink-1 text-sm outline-none focus:border-accent transition-colors placeholder-ink-5"
          autoFocus
        />
      </div>

      <div>
        <label className="block font-mono text-label text-ink-4 uppercase mb-1">
          Acting For (Optional)
        </label>
        <input
          value={actingFor}
          onChange={(e) => setActingFor(e.target.value)}
          placeholder="e.g. the tenant, the buyer"
          className="w-full bg-paper border border-rule rounded-control p-3 text-ink-1 text-sm outline-none focus:border-accent transition-colors placeholder-ink-5"
        />
      </div>

      <div>
        <label className="block font-mono text-label text-ink-4 uppercase mb-1">
          Context (Optional)
        </label>
        <textarea
          value={context}
          onChange={(e) => setContext(e.target.value)}
          placeholder="e.g. Focus on strict liability caps..."
          className="w-full bg-paper border border-rule rounded-control p-3 text-ink-1 text-sm outline-none focus:border-accent transition-colors resize-none h-20 placeholder-ink-5"
        />
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block font-mono text-label text-ink-4 uppercase mb-1">
            Target Clause Count (Optional)
          </label>
          <input
            type="number"
            min={1}
            value={targetClauseCount}
            onChange={(e) => setTargetClauseCount(e.target.value)}
            placeholder="e.g. 15"
            className="w-full bg-paper border border-rule rounded-control p-3 text-ink-1 text-sm outline-none focus:border-accent transition-colors placeholder-ink-5"
          />
          <p className="font-ui text-meta text-ink-4 mt-1.5 px-1 italic">
            Guidance only — a shorter list of genuinely relevant clauses is not a failure.
          </p>
        </div>

        <div>
          <label className="block font-mono text-label text-ink-4 uppercase mb-2">
            Answer Length
          </label>
          <div className="flex bg-chip-fill rounded-control p-0.5">
            {ANSWER_LENGTHS.map((level) => (
              <button
                key={level}
                onClick={() => setAnswerLength(level)}
                className={`flex-1 py-1.5 text-[10px] sm:text-xs font-medium rounded-inset transition-all ${
                  answerLength === level
                    ? 'bg-card text-ink-1 shadow-tab'
                    : 'text-ink-4 hover:text-ink-1'
                }`}
              >
                {ANSWER_LENGTH_LABEL[level]}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div>
        <SourcePicker
          playbooks={playbooks}
          matters={matters}
          selected={sources}
          onChange={setSources}
          mattersError={mattersError}
          onRetryMatters={onRetryMatters}
        />
      </div>

      <p className="font-ui text-meta text-ink-4 italic border-t border-rule pt-4">
        Nothing is saved yet. You will review every proposed clause — keep, edit, or cut it — before
        anything becomes a playbook.
      </p>

      <div className="flex justify-end gap-3">
        <Button variant="ghost" onClick={onCancel} disabled={busy}>Cancel</Button>
        <Button onClick={handleSubmit} disabled={!canSubmit} loading={busy}>
          {!busy && <><Wand2 className="h-4 w-4" /> Draft the playbook</>}
          {busy && 'Drafting...'}
        </Button>
      </div>
    </div>
  );
}
