import React, { useState } from 'react';
import { Button } from '../../components/Button';
import { strengthLabel, type PositionStrength } from '../../lib/strength';
import type { InferredPosition, OpenQuestion } from '../../lib/inferPositions';

/**
 * "What we learned" — spec §7. The screen where sub-project F either tells
 * the truth about its own evidence or doesn't, so every branch below is a
 * refusal to overstate something:
 *
 * - The banner is the handoff's own framing, close to verbatim (spec §2):
 *   these are *observations*, not advice. Nothing here is a recommendation.
 * - `Accept all consistent` (`consistentPositions`, exported so the mutation
 *   test can call it directly) sweeps up ONLY `consistent` positions — a
 *   `mixed` or `weak` one is exactly the inference that most needs a human's
 *   individual look, so it is never eligible for the bulk control.
 * - Zero positions is a real, honest outcome (spec §8) and says so in words,
 *   not by rendering nothing.
 * - An `OpenQuestion` renders only as a question — `QuestionCard` has no
 *   "adopt" affordance anywhere in it, deliberately: these come from a
 *   clause nobody ever amended, and an adopt button would let a reader turn
 *   silence into a position with one click (spec §11).
 * - A contradiction is shown, never resolved — `PositionCard` states that the
 *   redlines disagree and still leaves Adopt/Reword/Reject to a person.
 * - `strengthLabel` (not a home-grown string here) is the only place a
 *   strength badge is worded, so a `weak` position can never accidentally
 *   borrow a `consistent` one's phrasing.
 */

export interface WhatWeLearnedProps {
  positions: InferredPosition[];
  questions: OpenQuestion[];
  /** documentId -> display name for the basis list. Falls back to the raw
   *  id when a name was not supplied — better an id than a blank. */
  documentNames?: Record<string, string>;
  onAdopt: (position: InferredPosition) => void;
  onReword: (position: InferredPosition, text: string) => void;
  onReject: (position: InferredPosition) => void;
  onSeeWorkings: (position: InferredPosition) => void;
  /** Called with exactly the `consistent` subset of what was passed in,
   *  never the full selection — see `consistentPositions`. */
  onBulkAccept: (positions: InferredPosition[]) => void;
  onAnswerQuestion: (question: OpenQuestion, answer: string) => void;
  onSkipQuestion: (question: OpenQuestion) => void;
}

const STRENGTH_ORDER: Record<PositionStrength, number> = {
  consistent: 0,
  mixed: 1,
  weak: 2,
};

const STRENGTH_BADGE_CLASS: Record<PositionStrength, string> = {
  consistent: 'bg-emerald-500/15 border-emerald-500/30 text-emerald-300',
  mixed: 'bg-amber-500/15 border-amber-500/30 text-amber-300',
  weak: 'bg-white/10 border-white/20 text-gray-300',
};

/**
 * The bulk-accept filter, and the single most load-bearing line in this
 * file (plan Task 6, step 5: mutation-tested). `Accept all consistent`
 * must never be satisfiable by anything that is not `strength === 'consistent'`
 * — a `mixed` or `weak` position swept up here would be adopted, in one
 * click, with exactly the amount of scrutiny it should NOT get.
 */
export function consistentPositions(positions: InferredPosition[]): InferredPosition[] {
  return positions.filter((p) => p.strength === 'consistent');
}

export function WhatWeLearned({
  positions,
  questions,
  documentNames = {},
  onAdopt,
  onReword,
  onReject,
  onSeeWorkings,
  onBulkAccept,
  onAnswerQuestion,
  onSkipQuestion,
}: WhatWeLearnedProps) {
  const sorted = [...positions].sort((a, b) => STRENGTH_ORDER[a.strength] - STRENGTH_ORDER[b.strength]);
  const bulkable = consistentPositions(positions);
  const documentLabel = (id: string) => documentNames[id] ?? id;

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-6 bg-[#09090b]">
      <div className="bg-violet-500/10 border border-violet-500/30 rounded-lg p-4">
        <p className="text-sm text-violet-200">
          These are observations about what you did, not advice. Nothing here becomes a house rule until you say so.
        </p>
      </div>

      <section className="space-y-4">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-lg font-bold text-white">Positions we found in your redlines</h2>
          {bulkable.length > 0 && (
            <Button variant="ghost" onClick={() => onBulkAccept(bulkable)}>
              Accept all consistent ({bulkable.length})
            </Button>
          )}
        </div>

        {positions.length === 0 ? (
          <p className="text-sm text-gray-400 italic">
            The redlines did not settle anything we could state as a position.
          </p>
        ) : (
          <div className="space-y-3">
            {sorted.map((position) => (
              <PositionCard
                key={position.id}
                position={position}
                documentLabel={documentLabel}
                onAdopt={onAdopt}
                onReword={onReword}
                onReject={onReject}
                onSeeWorkings={onSeeWorkings}
              />
            ))}
          </div>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-bold text-white">Open questions</h2>
        <p className="text-xs text-gray-500">
          Things your redlines raised but never settled — never shown as a position (spec §11).
        </p>
        {questions.length === 0 ? (
          <p className="text-sm text-gray-500 italic">Nothing the redlines raised without also settling it.</p>
        ) : (
          <div className="space-y-3">
            {questions.map((question) => (
              <QuestionCard
                key={question.id}
                question={question}
                onAnswer={onAnswerQuestion}
                onSkip={onSkipQuestion}
              />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

interface PositionCardProps {
  position: InferredPosition;
  documentLabel: (id: string) => string;
  onAdopt: (position: InferredPosition) => void;
  onReword: (position: InferredPosition, text: string) => void;
  onReject: (position: InferredPosition) => void;
  onSeeWorkings: (position: InferredPosition) => void;
}

function PositionCard({ position, documentLabel, onAdopt, onReword, onReject, onSeeWorkings }: PositionCardProps) {
  const [rewording, setRewording] = useState(false);
  const [rewordText, setRewordText] = useState(position.rewordedText ?? position.statement);

  const handleSaveReword = () => {
    onReword(position, rewordText);
    setRewording(false);
  };

  return (
    <div className="border border-white/10 rounded-xl p-4 bg-white/5 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-[10px] uppercase tracking-wider text-gray-500 font-bold">{position.clauseTitle}</p>
          <p className="text-sm text-gray-100 mt-1">{position.statement}</p>
        </div>
        <span
          className={`shrink-0 text-[10px] font-bold uppercase px-2 py-1 rounded border whitespace-nowrap ${STRENGTH_BADGE_CLASS[position.strength]}`}
        >
          {strengthLabel(position.strength, position.supporting, position.total)}
        </span>
      </div>

      {position.contradicted && (
        <p className="text-xs text-amber-300 bg-amber-500/10 border border-amber-500/20 rounded p-2">
          The redlines disagree on this one &mdash; some documents support it, others go the other way. This is left
          for you to decide; the app does not pick a side.
        </p>
      )}

      {position.diffDerivedOnly && (
        <p className="text-[10px] text-gray-500 italic">
          Based on comparing document text, not on tracked changes &mdash; weaker evidence.
        </p>
      )}

      {position.basis.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {position.basis.map((b) => (
            <span
              key={b.documentId}
              className={`text-[11px] px-2 py-1 rounded border ${
                b.supports ? 'border-emerald-500/30 text-emerald-300' : 'border-red-500/30 text-red-300'
              }`}
            >
              {documentLabel(b.documentId)} &middot; {b.supports ? 'supports' : 'opposes'}
            </span>
          ))}
        </div>
      )}

      {rewording ? (
        <div className="space-y-2">
          <textarea
            aria-label="Reworded position"
            value={rewordText}
            onChange={(e) => setRewordText(e.target.value)}
            className="w-full bg-black/50 border border-white/10 rounded-lg p-2 text-xs text-gray-200 outline-none focus:border-violet-500 min-h-[60px]"
          />
          <div className="flex gap-2">
            <Button onClick={handleSaveReword}>Save reword</Button>
            <Button variant="ghost" onClick={() => setRewording(false)}>Cancel</Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2 pt-1 border-t border-white/10">
          <Button onClick={() => onAdopt(position)}>Adopt</Button>
          <Button variant="ghost" onClick={() => setRewording(true)}>Reword</Button>
          <Button variant="ghost" onClick={() => onReject(position)}>Not a house rule</Button>
          <Button variant="ghost" onClick={() => onSeeWorkings(position)}>See the workings</Button>
        </div>
      )}
    </div>
  );
}

interface QuestionCardProps {
  question: OpenQuestion;
  onAnswer: (question: OpenQuestion, answer: string) => void;
  onSkip: (question: OpenQuestion) => void;
}

/**
 * Renders purely as a question. There is deliberately no path in this
 * component to an "adopt" action of any kind — recording an answer just
 * stores the text the person typed, it never becomes an `InferredPosition`.
 */
function QuestionCard({ question, onAnswer, onSkip }: QuestionCardProps) {
  const [answer, setAnswer] = useState(question.answer ?? '');

  return (
    <div className="border border-white/10 rounded-xl p-4 bg-white/5 space-y-2">
      <p className="text-[10px] uppercase tracking-wider text-gray-500 font-bold">{question.clauseTitle}</p>
      <p className="text-sm text-gray-100">{question.question}</p>
      {question.answer ? (
        <p className="text-xs text-emerald-300">Answered: {question.answer}</p>
      ) : (
        <div className="space-y-2">
          <textarea
            aria-label={`Answer for ${question.clauseTitle}`}
            value={answer}
            onChange={(e) => setAnswer(e.target.value)}
            placeholder="Do you have a position, or is this genuinely open?"
            className="w-full bg-black/50 border border-white/10 rounded-lg p-2 text-xs text-gray-200 outline-none focus:border-violet-500 min-h-[50px]"
          />
          <div className="flex gap-2">
            <Button onClick={() => onAnswer(question, answer)} disabled={answer.trim() === ''}>
              Record answer
            </Button>
            <Button variant="ghost" onClick={() => onSkip(question)}>Leave open</Button>
          </div>
        </div>
      )}
    </div>
  );
}
