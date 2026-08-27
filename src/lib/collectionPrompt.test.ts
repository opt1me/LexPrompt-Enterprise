import { describe, it, expect } from 'vitest';
import { buildCollectionPrompt } from './collectionPrompt';
import type { CollectionMember } from './collectionOrder';
import type { Clause, DocumentRecord, Template } from '../types';

function doc(id: string, name: string, text: string, overrides: Partial<DocumentRecord> = {}): DocumentRecord {
  return {
    id, matterId: 'm1', name, kind: 'pdf', text, byteSize: text.length,
    addedAt: 1, addedByUserId: 'u1', role: 'standalone', ...overrides,
  };
}

function member(overrides: Partial<CollectionMember> & Pick<CollectionMember, 'documentId' | 'kind' | 'position'>): CollectionMember {
  return { document: null, ...overrides };
}

const clause: Clause = {
  id: 'cl1',
  title: 'Rent Review',
  prompt: 'Describe how rent is reviewed and by whom.',
};

const template: Template = {
  id: 't1', name: 'Lease Playbook', contractType: 'lease', mode: 'extraction',
  systemPrompt: 'You are a careful reviewer.', formatPrompt: 'Return JSON.',
  clauses: [clause], createdAt: 1, updatedAt: 1, schemaVersion: 2,
};

const riskTemplate: Template = {
  ...template, mode: 'risk', riskTolerance: 'Standard commercial risk.',
};

const BASE_TEXT = 'The rent is reviewed every five years to open market value.';
const AMENDMENT_TEXT = 'Clause 3 is deleted and replaced: rent review is now annual, capped at RPI.';

function twoMemberCollection(): CollectionMember[] {
  return [
    member({
      documentId: 'lease', kind: 'original', position: 1,
      document: doc('lease', 'Lease.pdf', BASE_TEXT, { documentDate: Date.UTC(2019, 2, 12) }),
    }),
    member({
      documentId: 'dov', kind: 'varies', position: 2,
      document: doc('dov', 'Deed of Variation.pdf', AMENDMENT_TEXT, { documentDate: Date.UTC(2024, 5, 4) }),
    }),
  ];
}

describe('buildCollectionPrompt', () => {
  it('introduces each document by number, role and name, and its date when present', () => {
    const { prompt } = buildCollectionPrompt(twoMemberCollection(), clause, template, 100_000);
    expect(prompt).toContain('DOCUMENT 1 (BASE)');
    expect(prompt).toContain('"Lease.pdf"');
    expect(prompt).toContain('12 March 2019');
    expect(prompt).toContain('DOCUMENT 2 (VARIES)');
    expect(prompt).toContain('"Deed of Variation.pdf"');
    expect(prompt).toContain('4 June 2024');
  });

  it('omits a date clause for a document with no documentDate', () => {
    const members: CollectionMember[] = [
      member({ documentId: 'lease', kind: 'original', position: 1, document: doc('lease', 'Lease.pdf', BASE_TEXT) }),
    ];
    const { prompt } = buildCollectionPrompt(members, clause, template, 100_000);
    expect(prompt).toContain('DOCUMENT 1 (BASE) — "Lease.pdf"');
    expect(prompt).not.toContain('dated');
  });

  it('places documents in reading order, base first, and each document once', () => {
    const { prompt } = buildCollectionPrompt(twoMemberCollection(), clause, template, 100_000);
    const baseIndex = prompt.indexOf('DOCUMENT 1 (BASE)');
    const variesIndex = prompt.indexOf('DOCUMENT 2 (VARIES)');
    expect(baseIndex).toBeGreaterThanOrEqual(0);
    expect(variesIndex).toBeGreaterThan(baseIndex);
    expect(prompt.indexOf('DOCUMENT 1')).toBe(prompt.lastIndexOf('DOCUMENT 1'));
  });

  it('states the clause instruction and risk criteria once, after the documents, not per document', () => {
    const { prompt } = buildCollectionPrompt(twoMemberCollection(), clause, riskTemplate, 100_000);
    const clauseIndex = prompt.indexOf('CLAUSE TO REVIEW: Rent Review');
    const instructionIndex = prompt.indexOf(clause.prompt);
    const riskIndex = prompt.indexOf('RISK CRITERIA');
    const lastDocumentIndex = prompt.lastIndexOf('DOCUMENT 2 (VARIES)');

    expect(clauseIndex).toBeGreaterThan(lastDocumentIndex);
    expect(instructionIndex).toBeGreaterThan(clauseIndex);
    expect(riskIndex).toBeGreaterThan(clauseIndex);

    // Each appears exactly once.
    expect(prompt.split('CLAUSE TO REVIEW:')).toHaveLength(2);
    expect(prompt.split('RISK CRITERIA')).toHaveLength(2);
  });

  it('asks for a per-document effect AND a proposed net position, not a bare conclusion', () => {
    const { prompt } = buildCollectionPrompt(twoMemberCollection(), clause, template, 100_000);
    expect(prompt).toMatch(/effect/i);
    expect(prompt).toMatch(/net.position/i);
    // The prompt must not simply ask for the conclusion in isolation — it
    // must tie the net position back to the per-document effects.
    const effectIndex = prompt.search(/effect/i);
    const netPositionIndex = prompt.search(/net.position/i);
    expect(effectIndex).toBeGreaterThanOrEqual(0);
    expect(netPositionIndex).toBeGreaterThan(effectIndex);
  });

  // C1: the extractor now refuses a trail whose entries do not each name the
  // document they describe, so the prompt has to ask for that number — a
  // requirement enforced on the response but never stated in the request
  // would just fail every clause.
  it('requires one entry per document, each naming its own DOCUMENT number', () => {
    const { prompt } = buildCollectionPrompt(twoMemberCollection(), clause, template, 100_000);
    expect(prompt).toContain('EXACTLY 2 trail entries');
    expect(prompt).toMatch(/- document: the DOCUMENT NUMBER/);
    // And it must say not to skip a document it judged silent — the exact
    // model behaviour that used to shift every later effect up one document.
    expect(prompt).toMatch(/never skip a document/i);
  });

  it('describes a member with document: null as unavailable, not silently omitted', () => {
    const members: CollectionMember[] = [
      member({ documentId: 'lease', kind: 'original', position: 1, document: doc('lease', 'Lease.pdf', BASE_TEXT) }),
      member({ documentId: 'dov', kind: 'varies', position: 2, document: null }),
    ];
    const { prompt } = buildCollectionPrompt(members, clause, template, 100_000);
    expect(prompt).toContain('DOCUMENT 2 (VARIES)');
    expect(prompt).toMatch(/missing|unavailable/i);
    // A missing document contributes no truncation — it's absent, not cut short.
    expect(buildCollectionPrompt(members, clause, template, 100_000).truncated).toEqual([]);
  });

  /**
   * MJ1. The request has to ask for what the response contract actually
   * checks, or a compliant model fails every clause. `alignTrail` matches
   * one step per document whose TEXT WAS SENT; an UNAVAILABLE member's text
   * never was, so asking for an entry about it invites the model to write a
   * sentence about a document it has not read — the one thing this app must
   * never present as a document's own legal effect.
   */
  it('asks for one entry per available document only, and says not to write one for an unavailable member', () => {
    const members: CollectionMember[] = [
      member({ documentId: 'lease', kind: 'original', position: 1, document: doc('lease', 'Lease.pdf', BASE_TEXT) }),
      member({ documentId: 'dov', kind: 'varies', position: 2, document: null }),
    ];
    const { prompt } = buildCollectionPrompt(members, clause, template, 100_000);

    expect(prompt).toContain('EXACTLY 1 trail entry');
    expect(prompt).not.toContain('EXACTLY 2 trail entries');
    // Line-wrapped in the prompt text, so whitespace between the words is
    // whatever the wrapping made it.
    expect(prompt).toMatch(/do not\s+(return|write)\s+an entry for a document marked UNAVAILABLE/i);
  });

  it('names truncated documents in the returned array and in the prompt text, when the budget forces truncation', () => {
    const longBase = 'B'.repeat(500);
    const longAmendment = 'A'.repeat(500);
    const members: CollectionMember[] = [
      member({ documentId: 'lease', kind: 'original', position: 1, document: doc('lease', 'Lease.pdf', longBase) }),
      member({ documentId: 'dov', kind: 'varies', position: 2, document: doc('dov', 'Deed of Variation.pdf', longAmendment) }),
    ];
    const { prompt, truncated } = buildCollectionPrompt(members, clause, template, 400);

    expect(truncated.length).toBeGreaterThan(0);
    expect(truncated).toContain('Lease.pdf');

    // Named BY NAME in the prompt text itself — not a generic "truncated"
    // note. Asserted by pulling out only the lines that actually carry a
    // "cut short" notice, rather than searching the whole prompt: a
    // document's own header always names it, so a whole-prompt search
    // passes even when the notice has been genericised to "the text was
    // cut short". A review caught exactly that hole in this test.
    const noticeText = prompt.split('\n').filter(line => /cut short/.test(line)).join('\n');
    expect(noticeText).toContain('Lease.pdf');
  });

  it('names only the document it actually cut short, not every member', () => {
    // The discriminating half of the rule. With a budget that forces the
    // large base to be cut but leaves the small amendment whole, a generic
    // notice — or one that names every member — is a notice a reviewer
    // cannot act on. "The deed of variation was cut short" has to mean that
    // document and no other.
    const members: CollectionMember[] = [
      member({ documentId: 'lease', kind: 'original', position: 1, document: doc('lease', 'Lease.pdf', 'B'.repeat(4000)) }),
      member({ documentId: 'dov', kind: 'varies', position: 2, document: doc('dov', 'Deed of Variation.pdf', 'A'.repeat(40)) }),
    ];
    const { prompt, truncated } = buildCollectionPrompt(members, clause, template, 1000);

    expect(truncated).toContain('Lease.pdf');
    expect(truncated).not.toContain('Deed of Variation.pdf');

    const noticeText = prompt.split('\n').filter(line => /cut short/.test(line)).join('\n');
    expect(noticeText).toContain('Lease.pdf');
    expect(noticeText).not.toContain('Deed of Variation.pdf');
  });

  it('does not report a document as truncated when the full budget covers it', () => {
    const { truncated } = buildCollectionPrompt(twoMemberCollection(), clause, template, 100_000);
    expect(truncated).toEqual([]);
  });

  it('divides the budget so no single long document starves the others', () => {
    const longBase = 'B'.repeat(10_000);
    const shortAmendment = 'A'.repeat(50);
    const members: CollectionMember[] = [
      member({ documentId: 'lease', kind: 'original', position: 1, document: doc('lease', 'Lease.pdf', longBase) }),
      member({ documentId: 'dov', kind: 'varies', position: 2, document: doc('dov', 'Deed of Variation.pdf', shortAmendment) }),
    ];
    const { prompt, truncated } = buildCollectionPrompt(members, clause, template, 1000);

    // The short amendment must be sent whole even though the base is huge.
    expect(prompt).toContain(shortAmendment);
    expect(truncated).not.toContain('Deed of Variation.pdf');
    // The base, being far larger than the budget, must still be truncated.
    expect(truncated).toContain('Lease.pdf');

    // The amendment only needed 50 of its 500-char fair share, so the base
    // must be given the leftover rather than being capped at an even split
    // (1000 / 2 = 500): a naive equal split — or processing documents in
    // reading order instead of shortest-need-first — would stop the base
    // at 500 and waste the other 450 chars the amendment never used.
    const baseBlockStart = prompt.indexOf('DOCUMENT 1 (BASE)');
    const amendmentBlockStart = prompt.indexOf('DOCUMENT 2 (VARIES)');
    const baseBlock = prompt.slice(baseBlockStart, amendmentBlockStart);
    const baseCharsIncluded = (baseBlock.match(/B/g) || []).length;
    expect(baseCharsIncluded).toBeGreaterThan(900);
  });

  it('never truncates the base to nothing while sending an amendment whole', () => {
    const longBase = 'B'.repeat(10_000);
    const shortAmendment = 'A'.repeat(50);
    const members: CollectionMember[] = [
      member({ documentId: 'lease', kind: 'original', position: 1, document: doc('lease', 'Lease.pdf', longBase) }),
      member({ documentId: 'dov', kind: 'varies', position: 2, document: doc('dov', 'Deed of Variation.pdf', shortAmendment) }),
    ];
    const { prompt } = buildCollectionPrompt(members, clause, template, 1000);

    const baseBlockStart = prompt.indexOf('DOCUMENT 1 (BASE)');
    const amendmentBlockStart = prompt.indexOf('DOCUMENT 2 (VARIES)');
    const baseBlock = prompt.slice(baseBlockStart, amendmentBlockStart);
    // The base contributed some non-trivial amount of its own text, not zero.
    expect(baseBlock).toContain('B'.repeat(50));
  });
});
