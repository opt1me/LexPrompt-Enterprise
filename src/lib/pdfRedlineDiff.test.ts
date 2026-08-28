import { describe, it, expect } from 'vitest';
import { diffExtractedText } from './pdfRedlineDiff';

/**
 * A realistic (invented) slice of `parsePdf` output for a short tenancy
 * agreement: a few numbered clauses, long enough that sentence-splitting is
 * meaningful, with a couple of the double-space runs spike 2 found are
 * routine in pdfjs's output (it joins text items with variable spacing
 * rather than preserving layout). Deliberately contains "three months" and
 * "Landlord" exactly once each near the front, and "The Tenant" as an
 * exact, reusable substring — the test helpers below do plain
 * `String.prototype.replace`, which only touches the first match.
 */
const base =
  "Clause 1. Term. The tenancy shall commence on 1 January 2026 and continue for a fixed  term of twelve months, terminable by either party giving not less than three months written notice in advance of the expiry date. " +
  "Clause 2. Rent. The Tenant shall pay the Rent of £1,200 per calendar month in advance on the first day of each  month by standing order to the Landlord's nominated bank account. " +
  "Clause 3. Repairs. The Landlord shall keep the structure and exterior of the Property in good repair and the Tenant shall keep the interior in a clean and tenantable condition throughout the tenancy. " +
  "Clause 4. Alterations. The Tenant shall not make any alteration or addition to the Property without the prior written consent of the Landlord, such consent not to be unreasonably withheld or delayed. " +
  "Clause 5. Assignment. The Tenant shall not assign, sublet or part with possession of the Property or any part of it without the prior written consent of the Landlord.";

// Mirrors parsePdf's variable multi-space joins.
const REFLOWED = (s: string) => s.replace(/ {2,}/g, '   ');
// Mirrors a word broken across a line (or page) break by re-typesetting.
const HYPHENATED = (s: string) => s.replace(/(\w{3})(\w{3})/, '$1-\n$2');

describe('diffExtractedText', () => {
  it('finds a genuine amendment through whitespace reflow', () => {
    const out = diffExtractedText(base, REFLOWED(base).replace('three months', 'six months'));
    expect(out).toHaveLength(1);
    expect(out[0].text).toContain('six months');
    expect(out[0].kind).toBe('amended');
  });

  it('finds it through hyphenation across line breaks too', () => {
    // Spike 2's non-obvious result: hyphenation ALONE, with whitespace already
    // collapsed, drops precision from 1.00 to 0.038. De-hyphenation is not
    // optional polish — without it this function is useless.
    const later = HYPHENATED(REFLOWED(base)).replace('three months', 'six months');
    expect(diffExtractedText(base, later)).toHaveLength(1);
  });

  it('reports an inserted heading as structural, not as an amendment', () => {
    const out = diffExtractedText(base, base.replace('The Tenant', 'SCHEDULE 2 — CONTINUED. The Tenant'));
    expect(out.length).toBeGreaterThan(0);
    expect(out.every(u => u.kind === 'structural')).toBe(true);
  });

  it('never misses a changed clause — recall is the property that matters', () => {
    // Spike 2 measured recall 1.00 across every scenario. Over-flagging is
    // triaged; a missed amendment is silently omitted from the evidence.
    const later = REFLOWED(base).replace('three months', 'six months').replace('Landlord', 'Lessor');
    const flagged = diffExtractedText(base, later).map(u => u.text).join(' ');
    expect(flagged).toContain('six months');
    expect(flagged).toContain('Lessor');
  });

  it('returns nothing at all for two renderings of the same text', () => {
    expect(diffExtractedText(base, HYPHENATED(REFLOWED(base)))).toEqual([]);
  });

  it('refuses an empty later text rather than reporting every clause deleted', () => {
    // A scanned second version has no text layer. Diffing it against a real
    // one would flag the entire document as removed — the loudest possible
    // wrong answer. Spec §3a: a scan yields NO positions, not an empty set
    // of changes.
    expect(() => diffExtractedText(base, '')).toThrow(/no extractable text/i);
  });

  it('also refuses a later text that is nothing but page markers', () => {
    // A page that failed to extract any real content still gets its
    // `[Page N]` marker written (see pageSegments.ts) — this must not read
    // as "has content" just because the marker itself is non-empty text.
    expect(() => diffExtractedText(base, '[Page 1]\n[Page 2]\n')).toThrow(/no extractable text/i);
  });

  it('does not throw when earlier is empty — everything in later is reported, not treated as a scan', () => {
    const out = diffExtractedText('', 'A single new clause was added here.');
    expect(out.length).toBeGreaterThan(0);
    expect(out.every(u => u.kind === 'structural')).toBe(true);
  });

  it('strips [Page N] markers before comparing, rather than diffing across them', () => {
    const earlierPaged = `[Page 1]\n${base}\n\n`;
    const laterPaged = `[Page 1]\n${REFLOWED(base).replace('three months', 'six months')}\n\n`;
    const out = diffExtractedText(earlierPaged, laterPaged);
    expect(out).toHaveLength(1);
    expect(out[0].text).toContain('six months');
  });
});
