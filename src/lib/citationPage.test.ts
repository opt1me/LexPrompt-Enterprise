import { describe, it, expect } from 'vitest';
import { derivePage } from './citationPage';
import { pageSegments, pageSegmentsWithNumbers } from './pageSegments';

const THREE_PAGES =
  '[Page 1]\nThe Supplier shall deliver the Goods.\n\n' +
  '[Page 2]\nLiability is capped at the Charges paid.\n\n' +
  '[Page 3]\nGoverning law is England and Wales.\n\n';

describe('pageSegmentsWithNumbers', () => {
  it('returns one entry per page, carrying the page number', () => {
    const segments = pageSegmentsWithNumbers(THREE_PAGES);
    expect(segments.map(s => s.page)).toEqual([1, 2, 3]);
    expect(segments[1].text).toContain('Liability is capped');
  });

  it('returns an empty array when there are no page markers', () => {
    expect(pageSegmentsWithNumbers('just some docx text')).toEqual([]);
  });

  it('honours the page numbers written in the markers, not the ordinal', () => {
    const segments = pageSegmentsWithNumbers('[Page 7]\nseven\n\n[Page 8]\neight\n\n');
    expect(segments.map(s => s.page)).toEqual([7, 8]);
  });

  it('leaves the existing pageSegments contract intact', () => {
    expect(pageSegments(THREE_PAGES)).toEqual(pageSegmentsWithNumbers(THREE_PAGES).map(s => s.text));
    expect(pageSegments('no markers here')).toEqual(['no markers here']);
  });

  it('is repeatable — the shared regex does not carry lastIndex between calls', () => {
    expect(pageSegmentsWithNumbers(THREE_PAGES)).toEqual(pageSegmentsWithNumbers(THREE_PAGES));
  });
});

describe('derivePage', () => {
  it('finds the page a quote sits on', () => {
    expect(derivePage(THREE_PAGES, 'Liability is capped at the Charges paid.')).toBe(2);
  });

  it('matches through punctuation and whitespace differences', () => {
    expect(derivePage(THREE_PAGES, 'liability  is capped, at the charges paid')).toBe(2);
  });

  it('returns undefined when the quote is not in the document', () => {
    expect(derivePage(THREE_PAGES, 'Force majeure suspends performance.')).toBeUndefined();
  });

  it('returns undefined for a document with no page markers rather than guessing page 1', () => {
    expect(derivePage('Liability is capped at the Charges paid.', 'Liability is capped')).toBeUndefined();
  });

  it('returns undefined for a quote too short to be located reliably', () => {
    expect(derivePage(THREE_PAGES, 'the')).toBeUndefined();
  });

  it('returns the first page a repeated quote appears on', () => {
    const repeated = '[Page 1]\nNotices in writing.\n\n[Page 2]\nNotices in writing.\n\n';
    expect(derivePage(repeated, 'Notices in writing.')).toBe(1);
  });

  it('returns undefined for empty input', () => {
    expect(derivePage('', 'anything')).toBeUndefined();
    expect(derivePage(THREE_PAGES, '')).toBeUndefined();
  });
});
