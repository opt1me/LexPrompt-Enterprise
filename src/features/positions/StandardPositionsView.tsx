import React, { useState } from 'react';
import type { PositionHealth } from '../../lib/positionHealth';
import { positionHealthLabel } from '../../lib/positionHealth';
import type { PositionRow } from '../../lib/standardPositions';
import { LoadErrorPanel } from '../../components/LoadErrorPanel';

export interface StandardPositionsViewProps {
  rows: PositionRow[];
  /** Non-null replaces the index. A failed read is not an empty firm. */
  error: string | null;
  onRetry: () => void;
  onOpenPlaybook: (playbookId: string, clauseId: string) => void;
}

/**
 * A literal record, not a template-built class name: Tailwind's compiler
 * only picks up class names it can find as complete strings in source, and
 * `text-health-${kind}` would both silently fail to compile for
 * `no-position` (whose token is `--color-health-none`, a different spelling)
 * AND produce no styling at all for the rest — the exact trap
 * `TemplateEditor.tsx`'s own `HEALTH_INK` comment documents. Border and text
 * share the same four tokens, so both utilities are safe to derive from the
 * same `--color-health-*` custom properties.
 */
const HEALTH_INK: Record<PositionHealth['kind'], string> = {
  held: 'text-health-held border-health-held',
  conceded: 'text-health-conceded border-health-conceded',
  untested: 'text-health-untested border-health-untested',
  'no-position': 'text-health-none border-health-none',
};

const FILTERS: { label: string; kind: PositionHealth['kind'] | 'all' }[] = [
  { label: 'All', kind: 'all' },
  { label: 'Conceded', kind: 'conceded' },
  { label: 'Untested', kind: 'untested' },
  { label: 'Held', kind: 'held' },
];

/**
 * "Which of our house rules are drifting?" — a question no per-playbook
 * screen answers, because drift is only visible across playbooks and across
 * matters (§10.4).
 *
 * Read-only, by construction: it derives everything from D's
 * `positionHealth`, writes nothing, and calls no model. If the owner would
 * rather not have this tab, deleting it costs nothing — nothing else links
 * to it (R-G18).
 */
export function StandardPositionsView({ rows, error, onRetry, onOpenPlaybook }: StandardPositionsViewProps) {
  const [filter, setFilter] = useState<PositionHealth['kind'] | 'all'>('all');

  if (error) {
    return <LoadErrorPanel message={error} onRetry={onRetry} />;
  }

  if (rows.length === 0) {
    return (
      <div className="max-w-2xl mx-auto p-8 text-center space-y-2">
        <h1 className="font-prose text-screen-title text-ink-1">No standard positions yet</h1>
        <p className="font-ui text-ui text-ink-2">
          A standard position is your firm’s own answer to a clause. Add one to a clause in a
          playbook and it will appear here with how well it is holding up.
        </p>
      </div>
    );
  }

  const shown = filter === 'all' ? rows : rows.filter(r => r.health.kind === filter);

  return (
    <div className="max-w-4xl mx-auto p-8 space-y-5">
      <h1 className="font-prose text-screen-title text-ink-1">Standard positions</h1>
      <div className="flex gap-1 bg-chip-fill rounded-control p-0.5 w-fit">
        {FILTERS.map(f => (
          <button
            key={f.label}
            type="button"
            onClick={() => setFilter(f.kind)}
            className={`px-3 py-1.5 rounded-inset font-ui text-button ${filter === f.kind ? 'bg-card shadow-tab text-ink-1' : 'text-ink-3 hover:text-ink-1'}`}
          >
            {f.label}
          </button>
        ))}
      </div>

      <ul className="space-y-3">
        {shown.map(r => (
          <li key={`${r.playbookId}:${r.clauseId}`} className="bg-card border border-rule rounded-card p-4 space-y-2">
            <div className="flex items-start gap-3">
              <p className="font-prose text-field text-ink-prose min-w-0">{r.positionText}</p>
              <span
                role="status"
                className={`shrink-0 font-mono text-chip uppercase px-1.5 py-0.5 rounded-chip border bg-transparent ${HEALTH_INK[r.health.kind]}`}
              >
                {positionHealthLabel(r.health)}
              </span>
            </div>
            <p className="flex items-center gap-2">
              <span className="font-mono text-pin text-ink-4 uppercase">{r.playbookName} · {r.clauseTitle}</span>
              <button
                type="button"
                onClick={() => onOpenPlaybook(r.playbookId, r.clauseId)}
                className="ml-auto font-ui text-meta text-accent hover:underline"
              >
                Open in playbook →
              </button>
            </p>
          </li>
        ))}
      </ul>
    </div>
  );
}
