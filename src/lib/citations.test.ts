// src/lib/citations.test.ts
import { describe, it, expect } from 'vitest';
import { normalizeForMatch, findQuoteRects, type PdfPageText } from './citations';

// Builds a page where each word is its own text item on one line,
// mirroring how pdf.js splits a text layer.
function page(pageNum: number, words: string[]): PdfPageText {
  return {
    pageNum,
    items: words.map((str, i) => ({
      str: str + ' ',
      transform: [1, 0, 0, 1, 10 + i * 40, 700],
      width: 38,
      height: 12,
    })),
  };
}

describe('normalizeForMatch', () => {
  it('strips punctuation and casing so quotes survive re-typesetting', () => {
    expect(normalizeForMatch('The "Term" is 5 years.')).toBe('thetermis5years');
  });

  it('collapses whitespace differences', () => {
    expect(normalizeForMatch('a  b\nc')).toBe(normalizeForMatch('a b c'));
  });
});

describe('findQuoteRects', () => {
  const pages = [
    page(1, ['The', 'landlord', 'shall', 'maintain', 'the', 'roof']),
    page(2, ['The', 'tenant', 'shall', 'pay', 'the', 'rent']),
  ];

  it('finds an exact quote and returns one rect per covered item', () => {
    const rects = findQuoteRects(pages, ['landlord shall maintain']);
    expect(rects.length).toBe(3);
    expect(rects.every(r => r.pageNum === 1)).toBe(true);
  });

  it('matches across punctuation and casing differences', () => {
    const rects = findQuoteRects(pages, ['"Landlord shall, maintain"']);
    expect(rects.length).toBeGreaterThan(0);
    expect(rects[0].pageNum).toBe(1);
  });

  it('finds a quote on a later page', () => {
    const rects = findQuoteRects(pages, ['tenant shall pay']);
    expect(rects.every(r => r.pageNum === 2)).toBe(true);
  });

  it('ignores quotes shorter than 5 normalized characters', () => {
    expect(findQuoteRects(pages, ['the'])).toEqual([]);
  });

  it('returns nothing for a quote that is not present', () => {
    expect(findQuoteRects(pages, ['force majeure provisions apply'])).toEqual([]);
  });

  it('returns rects for every occurrence, not just the first', () => {
    const repeated = [page(1, ['alpha', 'bravo', 'charlie', 'alpha', 'bravo', 'delta'])];
    const rects = findQuoteRects(repeated, ['alpha bravo']);
    const xs = new Set(rects.map(r => r.x));
    expect(xs.size).toBeGreaterThan(2);
  });

  it('falls back to prefix/suffix matching when the middle differs', () => {
    // Long quote whose interior was mis-transcribed by the model.
    const long = [page(1, [
      'Notwithstanding', 'any', 'provision', 'to', 'the', 'contrary',
      'the', 'liability', 'cap', 'shall', 'not', 'exceed', 'the', 'fees', 'paid',
    ])];
    const quote = 'Notwithstanding any XXXXX to the contrary the liability cap shall not exceed the fees paid';
    const rects = findQuoteRects(long, [quote]);
    expect(rects.length).toBeGreaterThan(0);
  });

  it('handles multiple quotes in one call', () => {
    const rects = findQuoteRects(pages, ['landlord shall maintain', 'tenant shall pay']);
    expect(new Set(rects.map(r => r.pageNum))).toEqual(new Set([1, 2]));
  });

  it('skips empty and whitespace-only quotes without throwing', () => {
    expect(() => findQuoteRects(pages, ['', '   '])).not.toThrow();
    expect(findQuoteRects(pages, ['', '   '])).toEqual([]);
  });
});
