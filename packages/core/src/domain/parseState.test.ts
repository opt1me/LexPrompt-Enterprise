import { describe, it, expect } from 'vitest';
import {
  isNotYetRead, notYetReadMessage, notYetReadMessageFor, STILL_READING_NOTICE,
} from './parseState.ts';

/**
 * The predicate and the sentence that close C1, tested where they live.
 *
 * The failure they replace is `parseState` on the wire with ZERO readers:
 * the upload blanks `text` and returns `pending`, and every layer that could
 * have said so instead showed a document that appears to say nothing —
 * "It may have failed to parse, or be a scan with no extractable content",
 * false in both branches.
 */

describe('isNotYetRead', () => {
  it('is true only for pending', () => {
    expect(isNotYetRead({ name: 'a.pdf', parseState: 'pending' })).toBe(true);
    expect(isNotYetRead({ name: 'a.pdf', parseState: 'parsed' })).toBe(false);
    expect(isNotYetRead({ name: 'a.pdf', parseState: 'failed' })).toBe(false);
  });

  it('is FALSE for an absent parseState — "we do not know" is not "still reading"', () => {
    // A `DocumentFile` the browser built from a file it just parsed has never
    // been anywhere that could answer the question. Reading absence as
    // pending would refuse a review of a document sitting parsed in memory.
    expect(isNotYetRead({ name: 'a.pdf' })).toBe(false);
  });
});

describe('the wording', () => {
  it('names the document and says what to do, and never says "failed" or "scan"', () => {
    const message = notYetReadMessage('lease.pdf');
    expect(message).toContain('lease.pdf');
    expect(message).toMatch(/has not finished being read/);
    expect(message).toMatch(/try again in a moment/i);
    // The two words the old sentence used, which were the false ones.
    expect(message).not.toMatch(/failed to parse/i);
    expect(message).not.toMatch(/\bscan\b/i);
  });

  it('names every document when there are several, and says nothing was started', () => {
    const one = notYetReadMessageFor(['lease.pdf']);
    expect(one).toContain('lease.pdf');
    expect(one).toMatch(/Nothing was started/);

    const many = notYetReadMessageFor(['lease.pdf', 'deed.pdf']);
    expect(many).toContain('lease.pdf');
    expect(many).toContain('deed.pdf');
    expect(many).toMatch(/Nothing was started/);
    expect(many).toMatch(/try again in a moment/i);
  });

  it('has a short form for a list row that still says reading, never unreadable', () => {
    expect(STILL_READING_NOTICE).toMatch(/still being read/i);
    expect(STILL_READING_NOTICE).not.toMatch(/unreadable|scan/i);
  });
});
