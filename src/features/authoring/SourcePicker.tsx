import React from 'react';
import { ShieldAlert } from 'lucide-react';
import type { FewShotSource } from './fewShot';

export interface SourcePickerProps {
  playbooks: { id: string; name: string }[];
  matters: { id: string; name: string }[];
  selected: FewShotSource[];
  onChange: (selected: FewShotSource[]) => void;
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
export function SourcePicker({ playbooks, matters, selected, onChange }: SourcePickerProps) {
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
        <label className="block text-xs text-gray-500 uppercase mb-2 font-semibold tracking-wider">
          Learn from existing playbooks
        </label>
        {playbooks.length === 0 ? (
          <p className="text-xs text-gray-500 italic">No playbooks yet.</p>
        ) : (
          <div className="space-y-1.5">
            {playbooks.map((p) => (
              <label key={p.id} className="flex items-center gap-2 text-sm text-gray-200 cursor-pointer">
                <input
                  type="checkbox"
                  checked={isSelected(selected, 'playbook', p.id)}
                  onChange={() => toggle({ kind: 'playbook', id: p.id, name: p.name })}
                  className="accent-violet-500"
                />
                {p.name}
              </label>
            ))}
          </div>
        )}
      </div>

      {matters.length > 0 && (
        <div>
          <label className="block text-xs text-gray-500 uppercase mb-2 font-semibold tracking-wider">
            Learn from a completed matter
          </label>
          <p className="flex items-start gap-2 text-xs text-yellow-300 bg-yellow-500/10 border border-yellow-500/20 rounded-lg p-3 mb-2">
            <ShieldAlert className="h-4 w-4 shrink-0 mt-0.5" />
            <span>
              Selecting a matter sends its verified findings to the model you have chosen — the only
              place in this app another matter&rsquo;s content leaves your browser.
            </span>
          </p>
          <div className="space-y-1.5">
            {matters.map((m) => (
              <label key={m.id} className="flex items-center gap-2 text-sm text-gray-200 cursor-pointer">
                <input
                  type="checkbox"
                  checked={isSelected(selected, 'matter', m.id)}
                  onChange={() => toggle({ kind: 'matter', id: m.id, name: m.name })}
                  className="accent-violet-500"
                />
                {m.name}
              </label>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
