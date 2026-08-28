import { describe, expect, it } from 'vitest';
import {
  keepClause, cutClause, unreviewedCount, canSaveDraft, saveGateLabel, toPlaybookDraft,
  positionProvenance,
  type AuthoringDraft, type DraftClause,
} from './authoringDraft';

const clause = (id: string, over: Partial<DraftClause> = {}): DraftClause => ({
  id, title: `Clause ${id}`, extractPrompt: `Extract ${id}.`,
  disposition: 'unreviewed', edited: false, positionEdited: false, suggestions: [], ...over,
});

const draft = (clauses: DraftClause[]): AuthoringDraft => ({
  contractType: 'Lease', learnedFrom: [], modelId: 'test/model', clauses,
});

const aiPosition = { text: 'We ask for six months.', origin: 'ai-drafted', reviewedByHuman: false } as const;

describe('the save gate', () => {
  it('refuses to save while any clause is unreviewed', () => {
    expect(canSaveDraft(draft([clause('a', { disposition: 'kept' }), clause('b')]))).toBe(false);
  });

  it('allows save once every clause is kept or cut', () => {
    expect(canSaveDraft(draft([
      clause('a', { disposition: 'kept' }), clause('b', { disposition: 'cut' }),
    ]))).toBe(true);
  });

  it('says how many remain, rather than being inertly grey', () => {
    expect(saveGateLabel(draft([clause('a'), clause('b'), clause('c', { disposition: 'kept' })])))
      .toBe('2 clauses left to review');
  });

  it('uses the singular for one remaining clause', () => {
    expect(saveGateLabel(draft([clause('a'), clause('b', { disposition: 'kept' })])))
      .toBe('1 clause left to review');
  });

  it('says Save as v1 when nothing remains', () => {
    expect(saveGateLabel(draft([clause('a', { disposition: 'cut' })]))).toBe('Save as v1');
  });

  it('refuses to save a draft with no clauses at all', () => {
    // Vacuously "all reviewed" is not the same as reviewed. An empty playbook
    // is not a thing anyone meant to create, and letting it through would
    // make the gate's own rule read as satisfied when nothing was read.
    expect(canSaveDraft(draft([]))).toBe(false);
  });

  it('refuses to save when every clause was cut', () => {
    // Same reasoning: a version with no clauses reviews nothing.
    expect(canSaveDraft(draft([clause('a', { disposition: 'cut' })]))).toBe(false);
  });
});

describe('dispositions and `edited`', () => {
  it('keeping without edits leaves edited false', () => {
    const out = keepClause(draft([clause('a')]), 'a');
    expect(out.clauses[0].disposition).toBe('kept');
    expect(out.clauses[0].edited).toBe(false);
  });

  it('keeping with a changed field sets edited', () => {
    const out = keepClause(draft([clause('a')]), 'a', { extractPrompt: 'Something else.' });
    expect(out.clauses[0].edited).toBe(true);
    expect(out.clauses[0].extractPrompt).toBe('Something else.');
  });

  it('keeping with an IDENTICAL value does not set edited (R-E5)', () => {
    // A focus-and-blur, or an edit typed and undone, is not engagement. This
    // is the assertion that stops `edited` becoming "was touched".
    const out = keepClause(draft([clause('a')]), 'a', { extractPrompt: 'Extract a.' });
    expect(out.clauses[0].edited).toBe(false);
  });

  it('cutting a clause marks it cut and does not mark it edited', () => {
    const out = cutClause(draft([clause('a')]), 'a');
    expect(out.clauses[0].disposition).toBe('cut');
    expect(out.clauses[0].edited).toBe(false);
  });

  it('leaves other clauses untouched', () => {
    const out = keepClause(draft([clause('a'), clause('b')]), 'a');
    expect(out.clauses[1].disposition).toBe('unreviewed');
  });

  // Minor 1 (final honesty review): an edit that explicitly clears a field
  // to `undefined` — `DraftReview` does this for a blanked standard
  // position — must DELETE the key, not leave it present with value
  // `undefined`. `structuredClone` (how IndexedDB writes every record, once
  // a draft is published) preserves an `undefined`-valued key, so leaving
  // one here would resurface on reload exactly as if it had never been
  // cleared.
  it('deletes a key an edit explicitly sets to undefined, rather than assigning undefined', () => {
    const withPosition = clause('a', {
      standardPosition: { text: 'We ask for six months.', origin: 'authored', reviewedByHuman: true },
    });
    const out = keepClause(draft([withPosition]), 'a', { standardPosition: undefined });
    expect('standardPosition' in out.clauses[0]).toBe(false);
    expect(out.clauses[0].edited).toBe(true);
  });

  it('never mutates the draft it was given', () => {
    const before = draft([clause('a')]);
    keepClause(before, 'a', { title: 'New' });
    expect(before.clauses[0].disposition).toBe('unreviewed');
    expect(before.clauses[0].title).toBe('Clause a');
  });
});

describe('toPlaybookDraft', () => {
  it('omits cut clauses entirely', () => {
    const out = toPlaybookDraft(draft([
      clause('a', { disposition: 'kept' }), clause('b', { disposition: 'cut' }),
    ]), 'My playbook');
    expect(out.clauses.map(c => c.id)).toEqual(['a']);
  });

  it('strips the authoring-only fields from every clause', () => {
    const out = toPlaybookDraft(draft([clause('a', { disposition: 'kept' })]), 'p');
    expect('disposition' in out.clauses[0]).toBe(false);
    expect('edited' in out.clauses[0]).toBe(false);
    expect('positionEdited' in out.clauses[0]).toBe(false);
    expect('suggestions' in out.clauses[0]).toBe(false);
  });

  it('marks an AI position a human kept as reviewed, and records how it got there', () => {
    const withPos = clause('a', { disposition: 'kept', standardPosition: { ...aiPosition } });
    const out = toPlaybookDraft(draft([withPos]), 'p');
    expect(out.clauses[0].standardPosition).toEqual({
      text: 'We ask for six months.',
      origin: 'ai-drafted',
      reviewedByHuman: true,
      provenance: 'Drafted by test/model; accepted unchanged by a person in the draft review.',
    });
  });

  it('keeps an edited AI position as ai-drafted, not authored', () => {
    // The model proposed it; a person changed it. Calling that `authored`
    // would erase where it came from, and the provenance line is the whole
    // reason `origin` exists.
    const withPos = clause('a', {
      disposition: 'kept', edited: true,
      standardPosition: { text: 'We ask for nine months.', origin: 'ai-drafted', reviewedByHuman: false },
    });
    expect(toPlaybookDraft(draft([withPos]), 'p').clauses[0].standardPosition!.origin).toBe('ai-drafted');
  });

  it('leaves a clause with no position without one', () => {
    const out = toPlaybookDraft(draft([clause('a', { disposition: 'kept' })]), 'p');
    expect('standardPosition' in out.clauses[0]).toBe(false);
  });

  it('carries the name and a first-version change summary', () => {
    const out = toPlaybookDraft(draft([clause('a', { disposition: 'kept' })]), 'Commercial Lease');
    expect(out.name).toBe('Commercial Lease');
    // v1 is exempt from D's required-change-summary rule, so an empty string
    // is correct here and `publishVersion` accepts it.
    expect(out.changeSummary).toBe('');
  });
});

// Integrity review (D/E), Major 3 — E spec §8's `provenance` row and DoD 5.
// `edited` was computed and then thrown away at this seam, and
// `StandardPosition.provenance` was written nowhere in the authoring path,
// so a position a person rewrote and one they clicked past were stored as
// byte-identical claims.
describe('provenance on a saved standard position (Major 3)', () => {
  const learned = (clauses: DraftClause[]): AuthoringDraft => ({
    contractType: 'Lease',
    learnedFrom: ['Commercial Lease — Tenant v4', 'Acme Lease'],
    modelId: 'anthropic/claude',
    clauses,
  });

  it('names the model and the sources the draft learned from', () => {
    const withPos = clause('a', { disposition: 'kept', standardPosition: { ...aiPosition } });
    const out = toPlaybookDraft(learned([withPos]), 'p');
    expect(out.clauses[0].standardPosition!.provenance)
      .toBe('Drafted by anthropic/claude, learning from Commercial Lease — Tenant v4, Acme Lease; '
        + 'accepted unchanged by a person in the draft review.');
  });

  it('distinguishes a position a person rewrote from one they clicked past', () => {
    const base = clause('a', { standardPosition: { ...aiPosition } });
    const clickedPast = keepClause(draft([base]), 'a', { standardPosition: { ...aiPosition } });
    const rewritten = keepClause(draft([base]), 'a', {
      standardPosition: { ...aiPosition, text: 'We ask for nine months, no conditions.' },
    });

    expect(toPlaybookDraft(clickedPast, 'p').clauses[0].standardPosition!.provenance)
      .toMatch(/accepted unchanged/);
    expect(toPlaybookDraft(rewritten, 'p').clauses[0].standardPosition!.provenance)
      .toMatch(/rewritten and accepted/);
  });

  // The narrow claim is the honest one: provenance is a claim about the
  // POSITION, and rewriting a risk criterion is not evidence that anyone
  // rewrote the house rule.
  it('does not claim the position was rewritten when a different field was', () => {
    const base = clause('a', { standardPosition: { ...aiPosition } });
    const out = keepClause(draft([base]), 'a', { extractPrompt: 'Something else entirely.' });
    expect(out.clauses[0].edited).toBe(true);
    expect(out.clauses[0].positionEdited).toBe(false);
    expect(toPlaybookDraft(out, 'p').clauses[0].standardPosition!.provenance)
      .toMatch(/accepted unchanged/);
  });

  // R-E5, applied to the narrow flag too: comparing values, never reacting
  // to an onChange. Re-submitting the same text is not engagement.
  it('does not mark the position rewritten when the same text is re-submitted', () => {
    const base = clause('a', { standardPosition: { ...aiPosition } });
    const out = keepClause(draft([base]), 'a', { standardPosition: { ...aiPosition } });
    expect(out.clauses[0].positionEdited).toBe(false);
  });

  it('keeps the stronger claim when a clause is edited, reopened and kept again', () => {
    const base = clause('a', { standardPosition: { ...aiPosition } });
    const once = keepClause(draft([base]), 'a', {
      standardPosition: { ...aiPosition, text: 'We ask for nine months.' },
    });
    const twice = keepClause(once, 'a', {
      standardPosition: { ...aiPosition, text: 'We ask for nine months.' },
    });
    expect(twice.clauses[0].positionEdited).toBe(true);
  });

  it('says a hand-written position was written by a person, claiming no model', () => {
    const withPos = clause('a', {
      disposition: 'kept',
      standardPosition: { text: 'We ask for six months.', origin: 'authored', reviewedByHuman: true },
    });
    const provenance = toPlaybookDraft(learned([withPos]), 'p').clauses[0].standardPosition!.provenance;
    expect(provenance).toBe('Written by a person.');
    expect(provenance).not.toMatch(/anthropic|Drafted/);
  });

  it('writes no provenance for a clause with no position', () => {
    expect(positionProvenance(draft([clause('a')]), clause('a'))).toBeUndefined();
  });
});
