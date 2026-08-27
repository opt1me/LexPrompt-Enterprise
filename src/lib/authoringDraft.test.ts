import { describe, expect, it } from 'vitest';
import {
  keepClause, cutClause, unreviewedCount, canSaveDraft, saveGateLabel, toPlaybookDraft,
  type AuthoringDraft, type DraftClause,
} from './authoringDraft';

const clause = (id: string, over: Partial<DraftClause> = {}): DraftClause => ({
  id, title: `Clause ${id}`, extractPrompt: `Extract ${id}.`,
  disposition: 'unreviewed', edited: false, suggestions: [], ...over,
});

const draft = (clauses: DraftClause[]): AuthoringDraft => ({
  contractType: 'Lease', learnedFrom: [], modelId: 'test/model', clauses,
});

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
    expect('suggestions' in out.clauses[0]).toBe(false);
  });

  it('marks an AI position a human kept as reviewed', () => {
    const withPos = clause('a', {
      disposition: 'kept',
      standardPosition: { text: 'We ask for six months.', origin: 'ai-drafted', reviewedByHuman: false },
    });
    const out = toPlaybookDraft(draft([withPos]), 'p');
    expect(out.clauses[0].standardPosition).toEqual({
      text: 'We ask for six months.', origin: 'ai-drafted', reviewedByHuman: true,
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
