import React from 'react';
import { ShieldAlert } from 'lucide-react';
import { LoadErrorPanel } from '../../components/LoadErrorPanel';
import { SOURCE_PRIVACY } from '../../lib/privacyCopy';
import type { FewShotSource } from './fewShot';

export interface SourcePickerProps {
  playbooks: { id: string; name: string }[];
  matters: { id: string; name: string }[];
  selected: FewShotSource[];
  onChange: (selected: FewShotSource[]) => void;
  /** Set when the matters list this picker draws from failed to load.
   *  Rendered INSTEAD OF the checkboxes, never alongside an empty `matters`
   *  array — without this, a failed read and a firm with genuinely no
   *  matters yet are the same picture: the section simply is not there. The
   *  matters exist; the app could not see them (CLAUDE.md: distinguish
   *  "empty" from "broken"). Mirrors `TemplateEditor`'s `healthError`. */
  mattersError?: string;
  onRetryMatters?: () => void;
}

function isSelected(selected: FewShotSource[], kind: FewShotSource['kind'], id: string): boolean {
  return selected.some((s) => s.kind === kind && s.id === id);
}

/**
 * "Learn from" style-source picker for the AI-draft form (spec §3.2, §5).
 *
 * R-E2 / spec §10: selecting a MATTER sends that matter's verified findings
 * to the chosen model as prompt material — the only place in this app
 * another matter's content leaves the browser (everything else sends only
 * the document under review). That has to be disclosed plainly, next to the
 * checkboxes, at the point of selection — not in a Settings note, and not
 * behind a dismiss button. Selecting a PLAYBOOK carries no client text (only
 * clause titles and standard positions), so it carries no such disclosure.
 */
export function SourcePicker({
  playbooks, matters, selected, onChange, mattersError, onRetryMatters,
}: SourcePickerProps) {
  const toggle = (source: FewShotSource) => {
    if (isSelected(selected, source.kind, source.id)) {
      onChange(selected.filter((s) => !(s.kind === source.kind && s.id === source.id)));
    } else {
      onChange([...selected, source]);
    }
  };

  return (
    <div className="space-y-5">
      <div>
        <label className="block font-mono text-label text-ink-4 uppercase mb-2">
          Learn from existing playbooks
        </label>
        {playbooks.length === 0 ? (
          <p className="text-sm text-ink-4 italic">No playbooks yet.</p>
        ) : (
          <div className="space-y-1.5">
            {playbooks.map((p) => (
              <label key={p.id} className="flex items-center gap-2 text-sm text-ink-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={isSelected(selected, 'playbook', p.id)}
                  onChange={() => toggle({ kind: 'playbook', id: p.id, name: p.name })}
                  className="shrink-0"
                />
                {p.name}
              </label>
            ))}
          </div>
        )}
      </div>

      {(matters.length > 0 || mattersError) && (
        <div>
          {/* m6: the heading no longer claims "completed" — App.tsx hands
             this component every matter regardless of state, and a heading
             promising a filter that is not applied is its own small
             confident-wrong-answer. Reworded rather than filtered: which
             matters are close enough to "done" to be worth learning from is
             a judgement call this picker has no way to make, so the
             decision is left to the person selecting, same as it always
             was — the heading just stops pretending the app already made
             it for them. */}
          <label className="block font-mono text-label text-ink-4 uppercase mb-2">
            Learn from a matter
          </label>
          {mattersError ? (
            <LoadErrorPanel message={mattersError} onRetry={onRetryMatters} compact />
          ) : (
            <>
              <p className="flex items-start gap-2 text-xs text-risk-med bg-risk-med-tint border border-risk-med-edge rounded-inset p-3 mb-2">
                <ShieldAlert className="h-4 w-4 shrink-0 mt-0.5" aria-hidden="true" />
                <span>{SOURCE_PRIVACY}</span>
              </p>
              <div className="space-y-1.5">
                {matters.map((m) => (
                  <label key={m.id} className="flex items-center gap-2 text-sm text-ink-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={isSelected(selected, 'matter', m.id)}
                      onChange={() => toggle({ kind: 'matter', id: m.id, name: m.name })}
                      className="shrink-0"
                    />
                    {m.name}
                  </label>
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
