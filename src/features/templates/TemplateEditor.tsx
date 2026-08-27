import React, { useState } from 'react';
import {
  Cpu, FileOutput, ShieldAlert, Plus, ChevronUp, ChevronDown, X, UploadCloud, Download, Copy,
  Settings, GripVertical,
} from 'lucide-react';
import type { PlaybookClause, PlaybookDraft, PlaybookVersion, StandardPosition } from '../../types';
import { AutoResizeTextarea } from '../../components/AutoResizeTextarea';
import { draftFromVersion, newPlaybookDraft } from '../../lib/db/playbooks';
import { positionHealthLabel, type PositionHealth } from '../../lib/positionHealth';
import { StandardPositionField } from './StandardPositionField';

export interface TemplateEditorProps {
  /** The current published version, or `undefined` for a playbook that has
   *  never been published. Read-only here — editing produces a draft. */
  version?: PlaybookVersion;
  /** The working copy. Absent means there are no unpublished edits yet; the
   *  first edit creates one from `version`. */
  draft?: PlaybookDraft;
  onSaveDraft: (draft: PlaybookDraft) => void;
  onPublish: () => void;
  onExport: () => void;
  onShowMegaPrompt: () => void;
  onClose: () => void;
  /** Per-clause health, keyed by clause id — computed by the caller via
   *  `positionHealth` (R-D2 keeps that function pure and store-free).
   *  Absent means "the caller did not work it out", which renders as
   *  nothing at all rather than as `UNTESTED`: an unasked question and a
   *  question answered "no evidence" are different facts. */
  health?: Record<string, PositionHealth>;
}

/**
 * What the editor is actually showing: the draft when there are unpublished
 * edits, otherwise a fresh editable COPY of the published version.
 *
 * Exported because `App` needs the same answer for Export and DIY mode, and
 * a second copy of this coalesce is exactly the sibling drift that has
 * produced six separate defects in this project. The copy matters: a
 * published version is immutable, and handing its own `clauses` array to an
 * editor is all it takes for a reorder to rewrite history in place.
 */
export function workingContent(version?: PlaybookVersion, draft?: PlaybookDraft): PlaybookDraft {
  if (draft) return draft;
  if (version) return draftFromVersion(version);
  return newPlaybookDraft('');
}

export function TemplateEditor({
  version, draft, onSaveDraft, onPublish, onExport, onShowMegaPrompt, onClose, health,
}: TemplateEditorProps) {
  const working = workingContent(version, draft);
  const hasUnpublishedChanges = draft !== undefined;
  const [dragIndex, setDragIndex] = useState<number | null>(null);

  /**
   * THE single funnel for every edit in this editor.
   *
   * `version` is never touched: it is spread into a new object, never
   * assigned into. That is the whole immutability rule, and keeping it in
   * one place is what makes it checkable — see the mutation test in
   * `TemplateEditor.test.tsx`.
   */
  const updateDraft = (patch: Partial<PlaybookDraft>) => {
    onSaveDraft({ ...working, ...patch });
  };

  /** The ONE reordering path. Both affordances go through it — the chevrons
   *  (keyboard-reachable, which a drag handle is not) and the drag handle —
   *  so there is no second implementation to drift. */
  const reorderClause = (from: number, to: number) => {
    const count = working.clauses.length;
    if (from === to || from < 0 || to < 0 || from >= count || to >= count) return;
    const next = [...working.clauses];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved!);
    updateDraft({ clauses: next });
  };

  const moveClause = (index: number, direction: 'up' | 'down') =>
    reorderClause(index, direction === 'up' ? index - 1 : index + 1);

  const addClause = () => {
    updateDraft({
      clauses: [
        ...working.clauses,
        { id: Date.now().toString(), title: 'New Clause', extractPrompt: 'Instruction...', riskCriteria: '' },
      ],
    });
  };

  const deleteClause = (index: number) => {
    updateDraft({ clauses: working.clauses.filter((_, i) => i !== index) });
  };

  const updateClause = (index: number, patch: Partial<PlaybookClause>) => {
    updateDraft({
      clauses: working.clauses.map((c, i) => (i === index ? { ...c, ...patch } : c)),
    });
  };

  /** Separate from `updateClause` because clearing a position must DELETE
   *  the key, not set it to `undefined`: `structuredClone` — how IndexedDB
   *  writes every record — preserves an `undefined`-valued key, and
   *  `'standardPosition' in clause` is how "does this clause have a house
   *  rule" gets asked. */
  const setPosition = (index: number, position: StandardPosition | undefined) => {
    updateDraft({
      clauses: working.clauses.map((c, i) => {
        if (i !== index) return c;
        const next: PlaybookClause = { ...c };
        if (position) next.standardPosition = position;
        else delete next.standardPosition;
        return next;
      }),
    });
  };

  return (
    <div className="p-6 max-w-7xl mx-auto h-[calc(100vh-64px)] flex flex-col bg-[#09090b]">
      {/* Header */}
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center mb-6 gap-4">
        <div className="flex flex-wrap items-center gap-3 w-full md:w-auto">
          <input
            value={working.name}
            onChange={(e) => updateDraft({ name: e.target.value })}
            aria-label="Playbook name"
            className="text-2xl font-bold bg-transparent text-white border-b border-transparent hover:border-white/20 focus:border-violet-500 outline-none px-1 w-full md:w-auto"
          />
          {version && (
            <span className="text-xs font-mono text-gray-500 border border-white/10 rounded px-2 py-1">
              v{version.version}
            </span>
          )}
          {/* A version is immutable, so what is on screen is either exactly
             the published version or a draft that has not reached any
             review yet. Saying which is the difference between a reviewer
             running the clauses they just wrote and running the previous
             ones without being told. */}
          {!version ? (
            <span className="text-xs text-amber-300 bg-amber-500/10 border border-amber-500/30 rounded px-2 py-1">
              Not published yet — publish before running a review
            </span>
          ) : hasUnpublishedChanges ? (
            <span className="text-xs text-amber-300 bg-amber-500/10 border border-amber-500/30 rounded px-2 py-1">
              Unpublished changes — reviews still run v{version.version}
            </span>
          ) : null}
        </div>

        <div className="flex flex-wrap gap-2 md:gap-3 w-full md:w-auto justify-end items-center">
          <button onClick={onShowMegaPrompt} className="flex items-center gap-2 px-3 py-2 rounded-lg bg-blue-500/20 text-blue-300 hover:bg-blue-500/30 transition-colors border border-blue-500/30 text-xs md:text-sm"><Copy className="h-4 w-4" /> DIY Mode</button>
          <button onClick={onExport} className="flex items-center gap-2 px-3 py-2 rounded-lg bg-white/5 text-gray-300 hover:bg-white/10 transition-colors border border-white/10 text-xs md:text-sm"><Download className="h-4 w-4" /> Export</button>
          {/* Disabled with nothing unpublished: republishing an unchanged
             draft produces two byte-identical versions minutes apart, which
             a version history cannot explain — a real library already
             carries one such pair. */}
          <button
            onClick={onPublish}
            disabled={!hasUnpublishedChanges}
            title={hasUnpublishedChanges ? undefined : 'Nothing to publish — this is the published version.'}
            className="flex items-center gap-2 px-5 py-2 rounded-lg bg-green-500/20 text-green-400 hover:bg-green-500/30 transition-colors border border-green-500/30 text-xs md:text-sm font-bold disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <UploadCloud className="h-4 w-4" /> Publish
          </button>
          <button onClick={onClose} className="text-gray-500 hover:text-white px-2">Close</button>
        </div>
      </div>

      {/* Grid Layout */}
      <div className="flex-1 overflow-hidden grid grid-cols-1 lg:grid-cols-3 gap-6 pb-2">
        {/* Left Column: Global Settings */}
        <div className="space-y-6 overflow-y-auto pr-2 custom-scrollbar">
          <div className="bg-[#111] border border-white/10 rounded-xl p-5 shadow-lg">
            <label className="block text-sm font-medium text-gray-400 mb-2 flex items-center gap-2"><Cpu className="h-4 w-4" /> System Persona</label>
            <AutoResizeTextarea
              value={working.systemPrompt}
              onChange={(e) => updateDraft({ systemPrompt: e.target.value })}
              className="w-full bg-black/50 border border-white/10 rounded-lg p-3 text-sm text-gray-300 focus:border-violet-500 outline-none min-h-[120px]"
            />
          </div>
          <div className="bg-[#111] border border-white/10 rounded-xl p-5 shadow-lg">
            <label className="block text-sm font-medium text-gray-400 mb-2 flex items-center gap-2"><FileOutput className="h-4 w-4" /> Format & Rules</label>
            <AutoResizeTextarea
              value={working.formatPrompt}
              onChange={(e) => updateDraft({ formatPrompt: e.target.value })}
              className="w-full bg-black/50 border border-white/10 rounded-lg p-3 text-sm text-gray-300 focus:border-violet-500 outline-none min-h-[120px]"
            />
          </div>
          {/* R-D1: always visible. The Standard/Risk toggle that used to hide
              this is gone, and what decides whether a review assesses risk is
              now whether this field (or a clause's own criteria) has anything
              in it — so a hidden field would be a hidden decision. */}
          <div className="bg-red-900/10 border border-red-500/30 rounded-xl p-5">
            <label className="block text-sm font-medium text-red-300 mb-2 flex items-center gap-2"><ShieldAlert className="h-4 w-4" /> Global Risk Tolerance</label>
            <AutoResizeTextarea
              value={working.riskTolerance || ''}
              onChange={(e) => updateDraft({ riskTolerance: e.target.value })}
              placeholder="e.g. We are risk-averse regarding uncapped liability..."
              className="w-full bg-black/50 border border-red-500/20 rounded-lg p-3 text-sm text-gray-300 focus:border-red-500 outline-none min-h-[100px]"
            />
            <p className="mt-2 text-[11px] text-gray-500">
              Applies to every clause that has no criteria of its own. There is no risk mode any
              more: what is written here and in each clause's Risk Scorer is what decides. Leave
              them all empty and no risk criteria are sent at all.
            </p>
          </div>
        </div>

        {/* Right Column: Clauses (Spans 2 cols on large screens) */}
        <div className="lg:col-span-2 flex flex-col h-full bg-[#111] border border-white/10 rounded-xl overflow-hidden shadow-lg">
          <div className="p-4 border-b border-white/10 bg-[#161616] flex justify-between items-center shrink-0">
            <h3 className="text-lg font-semibold text-white flex items-center gap-2"><Settings className="h-4 w-4 text-violet-500" /> Extraction Clauses ({working.clauses.length})</h3>
            <button onClick={addClause} className="text-xs flex items-center gap-1 bg-violet-600 px-3 py-1.5 rounded hover:bg-violet-500 text-white transition-colors font-medium"><Plus className="h-3 w-3" /> Add Clause</button>
          </div>

          <div className="flex-1 overflow-y-auto p-4 space-y-4 custom-scrollbar">
            {working.clauses.map((clause, idx) => {
              const clauseHealth = health?.[clause.id];
              return (
                <div
                  key={clause.id}
                  onDragOver={(e) => { if (dragIndex !== null) e.preventDefault(); }}
                  onDrop={(e) => {
                    if (dragIndex === null) return;
                    e.preventDefault();
                    reorderClause(dragIndex, idx);
                    setDragIndex(null);
                  }}
                  className={`group relative p-0.5 rounded-xl bg-gradient-to-r transition-all duration-300 ${dragIndex === idx ? 'from-violet-500/40 to-violet-500/20' : 'from-white/5 to-white/10'}`}
                >
                  <div className="bg-[#0a0a0a] p-4 rounded-[10px] flex flex-col md:flex-row gap-4 items-start relative border border-white/5">
                    {/* Reordering Controls. The chevrons are the accessible
                       path and stay: a drag handle cannot be reached from a
                       keyboard. The handle below is a second affordance over
                       the same `reorderClause`, hidden from assistive tech
                       because it would announce a duplicate of what the
                       chevrons already offer. */}
                    <div className="flex flex-col items-center gap-1 pt-1 md:border-r md:border-white/10 md:pr-4">
                      <button
                        onClick={() => moveClause(idx, 'up')}
                        disabled={idx === 0}
                        aria-label={`Move ${clause.title} up`}
                        className="p-1 rounded hover:bg-white/10 text-gray-500 hover:text-white transition-colors disabled:opacity-30"
                      ><ChevronUp className="h-4 w-4" /></button>
                      <span className="text-[10px] text-gray-600 font-mono font-bold">{idx + 1}</span>
                      <button
                        onClick={() => moveClause(idx, 'down')}
                        disabled={idx === working.clauses.length - 1}
                        aria-label={`Move ${clause.title} down`}
                        className="p-1 rounded hover:bg-white/10 text-gray-500 hover:text-white transition-colors disabled:opacity-30"
                      ><ChevronDown className="h-4 w-4" /></button>
                      <span
                        draggable
                        aria-hidden="true"
                        title="Drag to reorder"
                        onDragStart={(e) => {
                          setDragIndex(idx);
                          // Firefox refuses to start a drag without payload.
                          // Optional-chained because jsdom's synthetic drag
                          // events carry no dataTransfer at all.
                          (e.dataTransfer as DataTransfer | undefined)?.setData('text/plain', String(idx));
                        }}
                        onDragEnd={() => setDragIndex(null)}
                        className="mt-1 cursor-grab active:cursor-grabbing text-gray-700 hover:text-gray-400"
                      ><GripVertical className="h-4 w-4" /></span>
                    </div>

                    {/* Content */}
                    <div className="flex-1 w-full space-y-3">
                      <div className="flex justify-between items-start">
                        <input
                          value={clause.title}
                          onChange={(e) => updateClause(idx, { title: e.target.value })}
                          className="bg-transparent font-bold text-white outline-none w-[90%] focus:text-violet-400 transition-colors text-sm md:text-base border-b border-transparent focus:border-violet-500/50"
                          placeholder="Clause Title"
                          aria-label="Clause title"
                        />
                        <button onClick={() => deleteClause(idx)} aria-label={`Delete ${clause.title}`} className="text-gray-600 hover:text-red-400 transition-colors p-1 opacity-0 group-hover:opacity-100"><X className="h-4 w-4" /></button>
                      </div>
                      <div>
                        <label className="text-[10px] text-gray-500 uppercase tracking-wider font-bold mb-1 block">Extraction Instruction</label>
                        <AutoResizeTextarea
                          value={clause.extractPrompt}
                          onChange={(e) => updateClause(idx, { extractPrompt: e.target.value })}
                          className="w-full bg-white/5 rounded-md p-2 text-xs text-gray-300 outline-none min-h-[50px] focus:ring-1 focus:ring-violet-500/50 border border-transparent focus:border-violet-500/30"
                          placeholder="What to extract..."
                        />
                      </div>
                      <StandardPositionField
                        position={clause.standardPosition}
                        onChange={(position) => setPosition(idx, position)}
                      />
                      {clauseHealth && (
                        <p className="text-[10px] uppercase tracking-wider font-bold text-gray-500">
                          {positionHealthLabel(clauseHealth)}
                        </p>
                      )}
                      <div>
                        <label className="text-[10px] text-red-400 uppercase tracking-wider flex items-center gap-1 font-bold mb-1"><ShieldAlert className="h-3 w-3" /> Risk Scorer</label>
                        <AutoResizeTextarea
                          value={clause.riskCriteria || ''}
                          onChange={(e) => updateClause(idx, { riskCriteria: e.target.value })}
                          className="w-full bg-red-900/10 border border-red-500/10 rounded-md p-2 text-xs text-gray-300 outline-none min-h-[50px] focus:border-red-500/50"
                          placeholder="Specific criteria (e.g., 'Must be mutual'). Leave blank to use Global Risk."
                        />
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
            {working.clauses.length === 0 && <div className="text-center text-gray-500 py-10 border border-dashed border-white/10 rounded-xl">No clauses defined. Add one to get started.</div>}
          </div>
        </div>
      </div>
    </div>
  );
}
