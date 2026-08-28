import React from 'react';
import { Scale, Check } from 'lucide-react';
import type { PositionOrigin, StandardPosition } from '../../types';
import { AutoResizeTextarea } from '../../components/AutoResizeTextarea';

export interface StandardPositionFieldProps {
  /** Absent means the clause has no house rule — the field renders empty with
   *  its "optional — enables deviation flagging" note. */
  position?: StandardPosition;
  /** Clearing the text removes the position entirely rather than storing an
   *  empty one — `migratePosition` drops those on read anyway, and a position
   *  reading "we ask for: (nothing)" is worse than none. */
  onChange: (position: StandardPosition | undefined) => void;
  disabled?: boolean;
}

/**
 * The provenance line, per spec §8. `origin` says where the WORDS came from
 * and `reviewedByHuman` says whether a person has read them: two different
 * facts, and collapsing them is how an AI suggestion nobody read comes to be
 * presented as the firm's position.
 */
export function provenanceLine(position: StandardPosition): string {
  switch (position.origin) {
    case 'authored':
      return 'Written by you';
    case 'ai-drafted':
      return position.reviewedByHuman
        ? 'Drafted by AI, reviewed by you'
        : 'Drafted by AI — not yet reviewed';
    case 'learned':
      return 'Learned from redlines';
  }
}

/** A brand-new position is the author's own words, and typing them is the
 *  human reading they describe. */
const NEW_POSITION_ORIGIN: PositionOrigin = 'authored';

/**
 * The firm's own answer to a clause, edited on the playbook clause beside the
 * prompt that extracts it. Its PRESENCE is what turns a finding from a
 * summary into a comparison (R-D1), which is why the empty state says so in
 * words rather than leaving a blank box to be read as a broken field.
 */
export function StandardPositionField({ position, onChange, disabled }: StandardPositionFieldProps) {
  const handleText = (text: string) => {
    if (text.trim() === '') {
      // Removed, not emptied: `migratePosition` drops an empty position on
      // read anyway, so storing one would only produce a record that reads
      // as a house rule until something happens to look at its text.
      onChange(undefined);
      return;
    }
    if (!position) {
      onChange({ text, origin: NEW_POSITION_ORIGIN, reviewedByHuman: true });
      return;
    }
    // `origin` and `provenance` survive an edit — they say where the words
    // came from, which editing them does not change. `reviewedByHuman` does
    // not survive as `false`: a person typing in this box has read it.
    onChange({ ...position, text, reviewedByHuman: true });
  };

  const needsReview = position !== undefined && !position.reviewedByHuman;

  return (
    <div>
      <label className="text-[10px] text-violet-300 uppercase tracking-wider flex items-center gap-1 font-bold mb-1">
        <Scale className="h-3 w-3" aria-hidden="true" /> Standard position
      </label>
      <AutoResizeTextarea
        value={position?.text ?? ''}
        onChange={(e) => handleText(e.target.value)}
        disabled={disabled}
        aria-label="Standard position"
        className="w-full bg-violet-500/5 border border-violet-500/20 rounded-md p-2 text-xs text-gray-300 outline-none min-h-[50px] focus:border-violet-500/60 disabled:opacity-50"
        // A noun phrase, not a full sentence — `PositionComparison` (the
        // card) prepends its own "We ask for " label to whatever is typed
        // here. An earlier placeholder modelled a complete sentence
        // ("We ask for a 6-month break notice…"), which taught an author to
        // type the label's own words into the field: the card then read
        // "We ask for We ask for a 6-month break notice…" — the label and
        // the placeholder must describe the SAME shape of text, not two
        // different ones that happen to look fine in isolation.
        placeholder="e.g. A 6-month break notice, no conditions."
      />
      {position === undefined ? (
        <p className="mt-1 text-[11px] text-gray-500">
          Optional — a position here enables deviation flagging: the review compares what the
          document says against it and reports meets, deviates or unclear. Leave it empty and the
          clause is extracted only.
        </p>
      ) : (
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <span className={`text-[11px] ${needsReview ? 'text-amber-300 font-medium' : 'text-gray-500'}`}>
            {provenanceLine(position)}
          </span>
          {position.provenance && (
            <span className="text-[11px] text-gray-600">— {position.provenance}</span>
          )}
          {/* Without this, the only way to accept a suggestion would be to
             edit it — which would make "reviewed" unreachable for a
             suggestion the reader agrees with word for word. */}
          {needsReview && (
            <button
              type="button"
              onClick={() => onChange({ ...position, reviewedByHuman: true })}
              disabled={disabled}
              className="text-[11px] flex items-center gap-1 px-2 py-0.5 rounded border border-violet-500/30 bg-violet-500/10 text-violet-200 hover:bg-violet-500/20 disabled:opacity-50"
            >
              <Check className="h-3 w-3" aria-hidden="true" /> Accept as our position
            </button>
          )}
        </div>
      )}
    </div>
  );
}
