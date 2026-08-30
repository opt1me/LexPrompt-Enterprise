import { describe, it, expect } from 'vitest';
import { repairCitations } from './citationRepair.ts';

const PAGED = '[Page 1]\nThe Supplier shall deliver.\n\n[Page 2]\nLiability is capped at the Charges.\n\n';

describe('repairCitations', () => {
  it('turns v1 quote strings into attributed citations', () => {
    const out = repairCitations(['Liability is capped at the Charges.'], 'doc-1', PAGED);
    expect(out).toEqual([
      { quote: 'Liability is capped at the Charges.', documentId: 'doc-1', page: 2 },
    ]);
  });

  it('omits page when the quote cannot be located, rather than guessing', () => {
    const out = repairCitations(['Force majeure suspends performance.'], 'doc-1', PAGED);
    expect(out).toEqual([{ quote: 'Force majeure suspends performance.', documentId: 'doc-1' }]);
  });

  it('omits page when no document text is available at all', () => {
    const out = repairCitations(['Liability is capped at the Charges.'], 'doc-1');
    expect(out).toEqual([{ quote: 'Liability is capped at the Charges.', documentId: 'doc-1' }]);
  });

  it('passes through citations that are already the new shape', () => {
    const existing = [{ quote: 'q', documentId: 'doc-9', page: 4, clauseRef: '14.2' }];
    expect(repairCitations(existing, 'doc-1', PAGED)).toEqual(existing);
  });

  it('repairs a citation object missing its documentId rather than dropping it', () => {
    const out = repairCitations([{ quote: 'Liability is capped at the Charges.' }], 'doc-1', PAGED);
    expect(out).toEqual([
      { quote: 'Liability is capped at the Charges.', documentId: 'doc-1', page: 2 },
    ]);
  });

  it('keeps a clauseRef the model supplied', () => {
    const out = repairCitations([{ quote: 'The Supplier shall deliver.', clauseRef: '3.1' }], 'doc-1', PAGED);
    expect(out[0].clauseRef).toBe('3.1');
  });

  it('discards a non-numeric or non-finite stored page rather than carrying it forward', () => {
    const out = repairCitations(
      [{ quote: 'The Supplier shall deliver.', documentId: 'doc-1', page: 'two' }],
      'doc-1',
      PAGED,
    );
    expect(out[0].page).toBe(1); // re-derived, not the junk value
    const noText = repairCitations(
      [{ quote: 'somewhere else entirely', documentId: 'doc-1', page: Number.NaN }],
      'doc-1',
    );
    expect(noText[0].page).toBeUndefined();
  });

  it('drops entries with no usable quote, and only those', () => {
    const out = repairCitations(
      ['', '   ', null, 42, { documentId: 'doc-1' }, 'The Supplier shall deliver.'],
      'doc-1',
      PAGED,
    );
    expect(out).toEqual([{ quote: 'The Supplier shall deliver.', documentId: 'doc-1', page: 1 }]);
  });

  it('returns an empty array for anything that is not an array', () => {
    expect(repairCitations(undefined, 'doc-1')).toEqual([]);
    expect(repairCitations(null, 'doc-1')).toEqual([]);
    expect(repairCitations('a quote', 'doc-1')).toEqual([]);
    expect(repairCitations({ 0: 'a quote' }, 'doc-1')).toEqual([]);
  });

  it('leaves page genuinely absent, not set to undefined, when it cannot be derived', () => {
    // toEqual ignores undefined-valued properties, so it cannot tell
    // `{ page: undefined }` apart from no `page` key at all. Check the key
    // directly so a regression that assigns `page: undefined` is caught.
    const out = repairCitations(['Force majeure suspends performance.'], 'doc-1', PAGED);
    expect('page' in out[0]).toBe(false);
  });

  it('does not mutate the input', () => {
    const input = [{ quote: 'The Supplier shall deliver.' }];
    repairCitations(input, 'doc-1', PAGED);
    expect(input).toEqual([{ quote: 'The Supplier shall deliver.' }]);
  });
});
