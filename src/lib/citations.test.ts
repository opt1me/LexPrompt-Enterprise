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

  it('defaults height to 12 when item.height is 0, matching the ported original (h || 12, not h ?? 12)', () => {
    const zeroHeightPage: PdfPageText[] = [{
      pageNum: 1,
      items: [
        { str: 'landlord ', transform: [1, 0, 0, 1, 10, 700], width: 38, height: 0 },
        { str: 'shall ', transform: [1, 0, 0, 1, 50, 700], width: 30, height: 0 },
        { str: 'maintain ', transform: [1, 0, 0, 1, 90, 700], width: 40, height: 0 },
      ],
    }];
    const rects = findQuoteRects(zeroHeightPage, ['landlord shall maintain']);
    expect(rects.length).toBeGreaterThan(0);
    expect(rects.every(r => r.h === 12)).toBe(true);
  });

  it('counts overlapping occurrences, not just non-overlapping ones (cursor must advance by 1, not by match length)', () => {
    // Item text concatenates (no separators) to the 9-char normalized
    // string "ababababa". Searching it for "ababab" (6 chars) yields two
    // *overlapping* matches: at index 0 (chars 0-5) and index 2 (chars 2-7)
    // — they share chars 2-5. Advancing the cursor by the full match length
    // (6) instead of by 1 after the first match would jump straight past
    // the second match, since the string has only 9 characters.
    const overlapPage: PdfPageText[] = [{
      pageNum: 1,
      items: [
        { str: 'aba', transform: [1, 0, 0, 1, 10, 700], width: 30, height: 12 },
        { str: 'bab', transform: [1, 0, 0, 1, 40, 700], width: 30, height: 12 },
        { str: 'aba', transform: [1, 0, 0, 1, 70, 700], width: 30, height: 12 },
      ],
    }];
    const rects = findQuoteRects(overlapPage, ['ababab']);
    // Match 1 (index 0-5) covers items [0,1] -> 2 rects.
    // Match 2 (index 2-7) covers items [0,1,2] -> 3 rects.
    // Advance-by-length would only find match 1, producing 2 rects instead of 5.
    expect(rects.length).toBe(5);
  });

  describe('MIN_QUOTE_LENGTH boundary (5 normalized characters)', () => {
    const boundaryPage: PdfPageText[] = [{
      pageNum: 1,
      items: [{ str: 'abcde', transform: [1, 0, 0, 1, 10, 700], width: 50, height: 12 }],
    }];

    it('matches a quote at exactly the 5-character minimum', () => {
      const rects = findQuoteRects(boundaryPage, ['abcde']);
      expect(rects.length).toBeGreaterThan(0);
    });

    it('rejects a quote at 4 characters, one below the minimum', () => {
      // 'abcd' is a substring of the page's own 'abcde' item, so this only
      // returns [] if the length check itself excludes it, not because the
      // text is absent.
      expect(findQuoteRects(boundaryPage, ['abcd'])).toEqual([]);
    });
  });

  describe('FUZZY_MIN_LENGTH boundary (30 normalized characters)', () => {
    // Page text: 15 x's, then 3 filler z's (so the exact needle is never
    // present verbatim), then 15 y's. A fuzzy match is only reachable if
    // the affix-length guard lets a needle longer than 30 chars through.
    const fuzzyBoundaryPage: PdfPageText[] = [{
      pageNum: 1,
      items: [{
        str: 'x'.repeat(15) + 'z'.repeat(3) + 'y'.repeat(15),
        transform: [1, 0, 0, 1, 10, 700],
        width: 200,
        height: 12,
      }],
    }];

    it('does not engage the fuzzy fallback at exactly 30 characters', () => {
      const quote30 = 'x'.repeat(15) + 'y'.repeat(15); // length 30, no exact match in page text
      expect(findQuoteRects(fuzzyBoundaryPage, [quote30])).toEqual([]);
    });

    it('engages the fuzzy fallback at 31 characters', () => {
      const quote31 = 'x'.repeat(15) + 'm' + 'y'.repeat(15); // length 31, same prefix/suffix as above
      const rects = findQuoteRects(fuzzyBoundaryPage, [quote31]);
      expect(rects.length).toBeGreaterThan(0);
    });
  });
});
