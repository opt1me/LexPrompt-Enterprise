import React, { useState } from 'react';
import { ChevronDown, ChevronRight, Cpu, FileOutput, Settings as SettingsIcon, ShieldAlert } from 'lucide-react';
import { AutoResizeTextarea } from '../../components/AutoResizeTextarea';

export interface PromptConfigPanelProps {
  systemPrompt: string;
  formatPrompt: string;
  /** Absent and `''` are the same fact to every reader — see
   *  `TemplateEditor`'s `setRiskTolerance`, which is why the change handler
   *  below hands back a plain string and the caller decides whether that
   *  means "delete the key". */
  riskTolerance?: string;
  onSystemPromptChange: (value: string) => void;
  onFormatPromptChange: (value: string) => void;
  onRiskToleranceChange: (value: string) => void;
}

/**
 * System Persona, Format & Rules and Global Risk Tolerance, collapsed.
 *
 * These are set once for a playbook and then rarely revisited, and in the
 * previous layout they occupied a third of the editor permanently — the
 * busiest thing on a screen whose job is reading one clause at a time.
 *
 * R-D1 said the Global Risk Tolerance field must be VISIBLE, because the
 * Standard/Risk toggle that used to hide it made "does this review assess
 * risk at all" a hidden decision. Collapsing the editing surface does not
 * reinstate that: the summary line below states, on the collapsed header,
 * whether a global tolerance is set — so the decision is legible without
 * opening anything, and the box that changes it is one click away. What
 * R-D1 forbids is a hidden ANSWER, not a folded-away textarea.
 */
export function PromptConfigPanel({
  systemPrompt, formatPrompt, riskTolerance,
  onSystemPromptChange, onFormatPromptChange, onRiskToleranceChange,
}: PromptConfigPanelProps) {
  const [open, setOpen] = useState(false);
  const hasRiskTolerance = (riskTolerance ?? '').trim() !== '';
  const Chevron = open ? ChevronDown : ChevronRight;

  return (
    <div className="mb-6 bg-card border border-rule rounded-panel">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="w-full flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 text-left hover:bg-chip-fill rounded-panel transition-colors"
      >
        <Chevron className="h-4 w-4 text-ink-4 shrink-0" aria-hidden="true" />
        <SettingsIcon className="h-4 w-4 text-ink-4 shrink-0" aria-hidden="true" />
        <span className="font-ui text-ui text-ink-1">Prompt configuration</span>
        {/* Not a chip, and deliberately not `role="status"`: this is static
            prose describing the playbook, not something announcing a change. */}
        <span className="font-ui text-meta text-ink-3">
          Persona, output rules, and{' '}
          {hasRiskTolerance
            ? 'a global risk tolerance that applies to every clause with no criteria of its own'
            : 'no global risk tolerance — each clause uses only its own criteria'}
        </span>
      </button>

      {open && (
        <div className="px-4 pb-4 pt-1 space-y-5 border-t border-rule">
          <div>
            <label
              htmlFor="prompt-config-persona"
              className="font-ui text-ui text-ink-3 mb-2 flex items-center gap-2"
            ><Cpu className="h-4 w-4" aria-hidden="true" /> System persona</label>
            <AutoResizeTextarea
              id="prompt-config-persona"
              aria-label="System persona"
              value={systemPrompt}
              onChange={(e) => onSystemPromptChange(e.target.value)}
              className="w-full p-3 min-h-[100px]"
            />
          </div>
          <div>
            <label
              htmlFor="prompt-config-format"
              className="font-ui text-ui text-ink-3 mb-2 flex items-center gap-2"
            ><FileOutput className="h-4 w-4" aria-hidden="true" /> Format &amp; rules</label>
            <AutoResizeTextarea
              id="prompt-config-format"
              aria-label="Format and rules"
              value={formatPrompt}
              onChange={(e) => onFormatPromptChange(e.target.value)}
              className="w-full p-3 min-h-[100px]"
            />
          </div>
          <div className="bg-risk-high-tint border border-risk-high-edge rounded-card p-4">
            <label
              htmlFor="prompt-config-risk"
              className="font-ui text-ui text-risk-high mb-2 flex items-center gap-2"
            ><ShieldAlert className="h-4 w-4" aria-hidden="true" /> Global risk tolerance</label>
            <AutoResizeTextarea
              id="prompt-config-risk"
              aria-label="Global risk tolerance"
              value={riskTolerance || ''}
              onChange={(e) => onRiskToleranceChange(e.target.value)}
              placeholder="e.g. We are risk-averse regarding uncapped liability..."
              className="w-full p-3 min-h-[80px]"
            />
            <p className="mt-2 font-ui text-meta text-ink-4">
              Applies to every clause that has no criteria of its own. There is no risk mode any
              more: what is written here and in each clause&rsquo;s Risky when is what decides.
              Leave them all empty and no risk criteria are sent at all.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
