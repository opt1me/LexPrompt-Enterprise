import { describe, it, expect } from 'vitest';
import { proposeChains, proposeRole } from './chains';
import type { PrecedentDocument } from './chains';

// The brief's own snippets use a `doc(...)` helper without defining it: a
// small local factory returning a PrecedentDocument, id defaulted from name
// so callers only have to say what varies for the assertion at hand.
function doc(name: string, overrides: Partial<PrecedentDocument> = {}): PrecedentDocument {
  return { id: name, name, role: 'unknown', roleInferred: true, ...overrides };
}

describe('proposeRole', () => {
  it('proposes a role from a clear filename, and marks it inferred (R-F4)', () => {
    expect(proposeRole('Lease - executed.docx', false)).toEqual({ role: 'executed', inferred: true });
  });

  it('uses the presence of markup as evidence of our markup', () => {
    expect(proposeRole('Lease v3.docx', true)).toEqual({ role: 'our-markup', inferred: true });
  });

  it('leaves an ambiguous document unknown rather than guessing', () => {
    expect(proposeRole('document1.docx', false)).toEqual({ role: 'unknown', inferred: true });
  });

  it('NEVER returns inferred: false — nothing here is confirmed by the app', () => {
    for (const n of ['Lease - executed.docx', 'their draft.docx', 'x.docx']) {
      expect(proposeRole(n, false).inferred).toBe(true);
    }
  });

  it('an explicit "their draft" filename beats a generic markup mention', () => {
    // A firm might title a comparison file "their draft with our markup" —
    // it is still, first and foremost, their draft, and hasMarkup being true
    // must not override an explicit filename claim of a different role.
    expect(proposeRole('their draft.docx', true)).toEqual({ role: 'their-draft', inferred: true });
  });

  it('an explicit "executed" filename beats hasMarkup evidence', () => {
    expect(proposeRole('Lease - fully executed.docx', true)).toEqual({ role: 'executed', inferred: true });
  });

  it('recognises markup named directly in the filename without hasMarkup', () => {
    expect(proposeRole('Brookvale - our markup.docx', false)).toEqual({ role: 'our-markup', inferred: true });
  });
});

describe('proposeChains', () => {
  it('groups documents sharing a stem into one proposed chain', () => {
    const out = proposeChains([doc('Brookvale - their draft.docx'), doc('Brookvale - our markup.docx')]);
    expect(new Set(out.map(d => d.chainId)).size).toBe(1);
  });

  it('does not chain two unrelated documents', () => {
    const out = proposeChains([doc('Brookvale lease.docx'), doc('Camden licence.docx')]);
    expect(out[0].chainId).not.toBe(out[1].chainId);
  });

  it('gives every document a chainId, including an unmatched standalone one', () => {
    const out = proposeChains([doc('Brookvale lease.docx')]);
    expect(out[0].chainId).toBeDefined();
  });

  it('chains three turns of the same deal into a single chain', () => {
    const out = proposeChains([
      doc('Brookvale - their draft.docx'),
      doc('Brookvale - our markup.docx'),
      doc('Brookvale - executed.docx'),
    ]);
    expect(new Set(out.map(d => d.chainId)).size).toBe(1);
  });

  it('does not merge chains just because both contain a shared common word', () => {
    // "lease" appears in both names but is not a role/version word, so it is
    // never stripped — the stems stay "brookvale retail park lease" and
    // "camden lease", which do not match.
    const out = proposeChains([doc('Brookvale Retail Park lease.docx'), doc('Camden lease.docx')]);
    expect(out[0].chainId).not.toBe(out[1].chainId);
  });

  it('preserves every document, only adding chainId', () => {
    const input = [doc('Brookvale - their draft.docx'), doc('Brookvale - our markup.docx')];
    const out = proposeChains(input);
    expect(out.map(d => d.name)).toEqual(input.map(d => d.name));
    expect(out.map(d => d.id)).toEqual(input.map(d => d.id));
  });
});
