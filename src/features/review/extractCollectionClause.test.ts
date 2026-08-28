import { describe, it, expect, vi, beforeEach } from 'vitest';
import { extractCollectionClause, collectionClauseSchema, COLLECTION_CLAUSE_SCHEMA } from './extractCollectionClause';
import type { PlaybookClause, PlaybookVersion, DocumentFile, Settings, StandardPosition } from '../../types';
import type { CollectionMember } from '../../lib/collectionOrder';

import { ModelError } from '@lexprompt/core';

vi.mock('../../lib/model/gatewayModelClient', () => ({
  gatewayModelClient: {
    chat: vi.fn(), chatJson: vi.fn(), chatStream: vi.fn(), listModels: vi.fn(),
  },
}));
const { gatewayModelClient } = await import('../../lib/model/gatewayModelClient');
const chatJson = gatewayModelClient.chatJson;

// A fully capable model, matching extractClause.test.ts's fixture posture, so
// the happy-path tests below are unaffected by capability gating.
const settings: Settings = {
  modelChoiceId: 'm', concurrency: 5,
  modelSupportsImages: true, modelSupportsStructuredOutput: true, modelContextLength: 1_000_000,
};

const clause: PlaybookClause = {
  id: 'c1',
  title: 'Rent Review',
  extractPrompt: 'Describe how rent is reviewed and by whom.',
  riskCriteria: 'Should not exceed RPI.',
};

const template: PlaybookVersion = {
  id: 't1', name: 'Lease', contractType: 'Lease',
  systemPrompt: 'You are a reviewer.', formatPrompt: 'Quote verbatim.',
  riskTolerance: 'Conservative.', clauses: [clause],
  playbookId: 'pb', version: 1, changeSummary: '', publishedAt: 0, publishedByUserId: '', schemaVersion: 6,
};

function docFile(id: string, name: string, text: string, overrides: Partial<DocumentFile> = {}): DocumentFile {
  return { id, name, kind: 'pdf', text, file: new File([''], name), ...overrides };
}

const leaseDoc = docFile('lease', 'Lease.pdf', '[Page 1]\nThe rent is reviewed every five years to open market value.\n\n');
const dovDoc = docFile('dov', 'DoV.pdf', '[Page 1]\nRent review is now annual, capped at RPI.\n\n');

const pos: StandardPosition = {
  text: 'Rent review should not exceed RPI.',
  origin: 'authored',
  reviewedByHuman: true,
};

// `base`/`varies` default to the fixtures above; pass `null` explicitly to
// simulate a missing member (the document was deleted from the matter).
function members(overrides: { base?: DocumentFile | null; varies?: DocumentFile | null } = {}): CollectionMember<DocumentFile>[] {
  const base = 'base' in overrides ? overrides.base! : leaseDoc;
  const varies = 'varies' in overrides ? overrides.varies! : dovDoc;
  return [
    { document: base, documentId: 'lease', kind: 'original', position: 1 },
    { document: varies, documentId: 'dov', kind: 'varies', position: 2 },
  ];
}

/**
 * Numbers a mocked trail's entries 1..N, which is what the schema and the
 * prompt now REQUIRE of a model: every entry says which DOCUMENT it
 * describes, and the extractor refuses a trail whose entries do not, rather
 * than zipping them onto the members by array position and hoping.
 *
 * Tests that exercise a badly numbered trail build their entries by hand
 * instead — that is the whole point of those tests.
 */
function numbered<T extends object>(...steps: T[]): (T & { document: number })[] {
  return steps.map((step, i) => ({ ...step, document: i + 1 }));
}

beforeEach(() => vi.clearAllMocks());

describe('extractCollectionClause', () => {
  it('returns a trail step per contributing document, in reading order, each with its effect', async () => {
    vi.mocked(chatJson).mockResolvedValue({
      trail: numbered(
        { effect: 'The lease sets a 5-year rent review.', citations: [] },
        { effect: 'The deed makes rent review annual, capped at RPI.', citations: [] },
      ),
      net_position: 'Rent is now reviewed annually, capped at RPI.',
    });

    const finding = await extractCollectionClause(members(), clause, template, settings);

    expect(finding.status).toBe('done');
    expect(finding.netPosition!.trail).toHaveLength(2);
    expect(finding.netPosition!.trail[0]).toMatchObject({
      documentId: 'lease', kind: 'original', effect: 'The lease sets a 5-year rent review.',
    });
    expect(finding.netPosition!.trail[1]).toMatchObject({
      documentId: 'dov', kind: 'varies', effect: 'The deed makes rent review annual, capped at RPI.',
    });
  });

  it('passes the JSON schema through to the model when the model supports structured output', async () => {
    vi.mocked(chatJson).mockResolvedValue({
      trail: numbered({ effect: 'a', citations: [] }, { effect: 'b', citations: [] }),
      net_position: 'ok',
    });
    await extractCollectionClause(members(), clause, template, settings);
    expect(vi.mocked(chatJson).mock.calls[0][0].jsonSchema).toBe(COLLECTION_CLAUSE_SCHEMA);
  });

  it("attributes a citation naming document 2 to document 2's real id", async () => {
    vi.mocked(chatJson).mockResolvedValue({
      trail: numbered(
        { effect: 'Base sets a 5-year review.', citations: [] },
        {
          effect: 'Amendment makes it annual.',
          citations: [{ quote: 'Rent review is now annual, capped at RPI.', document: 2 }],
        },
      ),
      net_position: 'Now annual, capped at RPI.',
    });

    const finding = await extractCollectionClause(members(), clause, template, settings);

    expect(finding.netPosition!.trail[1].citations).toEqual([
      { quote: 'Rent review is now annual, capped at RPI.', documentId: 'dov', page: 1 },
    ]);
  });

  it('drops a citation naming a document that was not in the call, and returns the finding with the rest', async () => {
    vi.mocked(chatJson).mockResolvedValue({
      trail: numbered(
        {
          effect: 'Base effect.',
          citations: [{ quote: 'The rent is reviewed every five years to open market value.', document: 1 }],
        },
        {
          effect: 'Amendment effect.',
          citations: [{ quote: 'Fabricated quote from nowhere.', document: 7 }],
        },
      ),
      net_position: 'Now annual.',
    });

    const finding = await extractCollectionClause(members(), clause, template, settings);

    expect(finding.status).toBe('done');
    expect(finding.netPosition!.trail[0].citations).toHaveLength(1);
    expect(finding.netPosition!.trail[1].citations).toHaveLength(0);
  });

  it('recovers a citation whose document number is unreadable by matching its quote against each document\'s text', async () => {
    vi.mocked(chatJson).mockResolvedValue({
      trail: numbered(
        { effect: 'Base effect.', citations: [] },
        // A bare string citation carries no document number at all.
        { effect: 'Amendment effect.', citations: ['Rent review is now annual, capped at RPI.'] },
      ),
      net_position: 'Now annual.',
    });

    const finding = await extractCollectionClause(members(), clause, template, settings);

    expect(finding.netPosition!.trail[1].citations).toEqual([
      { quote: 'Rent review is now annual, capped at RPI.', documentId: 'dov', page: 1 },
    ]);
  });

  it('drops an unreadable-number citation when quote-match recovery also fails', async () => {
    vi.mocked(chatJson).mockResolvedValue({
      trail: numbered(
        { effect: 'Base effect.', citations: [] },
        { effect: 'Amendment effect.', citations: ['Nothing like this appears anywhere in either document.'] },
      ),
      net_position: 'Now annual.',
    });

    const finding = await extractCollectionClause(members(), clause, template, settings);

    expect(finding.netPosition!.trail[1].citations).toEqual([]);
  });

  it("derives pages from each document's own doc.text via repairCitations, not the readability-filtered text", async () => {
    const paged = members({
      base: docFile(
        'lease', 'Lease.pdf',
        '[Page 1]\nIntro.\n\n[Page 2]\nThe rent is reviewed every five years to open market value.\n\n',
      ),
    });
    vi.mocked(chatJson).mockResolvedValue({
      trail: numbered(
        {
          effect: 'Base effect.',
          citations: [{ quote: 'The rent is reviewed every five years to open market value.', document: 1 }],
        },
        { effect: 'Amendment effect.', citations: [] },
      ),
      net_position: 'Still on 5-year review.',
    });

    const finding = await extractCollectionClause(paged, clause, template, settings);

    expect(finding.netPosition!.trail[0].citations).toEqual([
      { quote: 'The rent is reviewed every five years to open market value.', documentId: 'lease', page: 2 },
    ]);
  });

  it('starts the net position unconfirmed and the finding unchecked, with no notes', async () => {
    vi.mocked(chatJson).mockResolvedValue({
      trail: numbered({ effect: 'a', citations: [] }, { effect: 'b', citations: [] }),
      net_position: 'Now annual.',
    });

    const finding = await extractCollectionClause(members(), clause, template, settings);

    expect(finding.netPosition!.state).toBe('unconfirmed');
    expect(finding.verification).toEqual({ state: 'unchecked' });
    expect(finding.notes).toEqual([]);
  });

  it('treats a conclusion with no trail as an error, not a derivation', async () => {
    vi.mocked(chatJson).mockResolvedValue({ net_position: 'Now annual.' });

    const finding = await extractCollectionClause(members(), clause, template, settings);

    expect(finding.status).toBe('error');
    expect(finding.error).toMatch(/trail|derivation/i);
    expect(finding.netPosition).toBeUndefined();
  });

  it('treats an empty trail array the same as a missing one', async () => {
    vi.mocked(chatJson).mockResolvedValue({ trail: [], net_position: 'Now annual.' });

    const finding = await extractCollectionClause(members(), clause, template, settings);

    expect(finding.status).toBe('error');
    expect(finding.netPosition).toBeUndefined();
  });

  it('reports an empty net position as an error finding, not done', async () => {
    vi.mocked(chatJson).mockResolvedValue({
      trail: numbered({ effect: 'a', citations: [] }, { effect: 'b', citations: [] }),
      net_position: '',
    });

    const finding = await extractCollectionClause(members(), clause, template, settings);

    expect(finding.status).toBe('error');
    expect(finding.noContent).toBe(true);
    expect(finding.netPosition).toBeUndefined();
  });

  it('fails the clause loudly when the base document is missing, without calling the model', async () => {
    const finding = await extractCollectionClause(members({ base: null }), clause, template, settings);

    expect(finding.status).toBe('error');
    expect(finding.error).toMatch(/base document/i);
    expect(finding.error).toMatch(/nothing to vary/i);
    expect(chatJson).not.toHaveBeenCalled();
  });

  it('produces a net position explicitly marked as derived from an incomplete set when an amendment is missing', async () => {
    vi.mocked(chatJson).mockResolvedValue({
      trail: numbered(
        { effect: 'Base effect only.', citations: [] },
        { effect: 'This document is unavailable.', citations: [] },
      ),
      net_position: 'Based on the base document alone.',
    });

    const finding = await extractCollectionClause(members({ varies: null }), clause, template, settings);

    expect(finding.status).toBe('done');
    expect(finding.netPosition!.proposed).toMatch(/incomplete/i);
    // m1 (final review): the note printed the member's raw internal id —
    // "[Incomplete set: k3jd8fa0x91mq could not be found ...]" — into text
    // shown in the panel, in the trail modal, in both exports and in the
    // drafted email. A missing member has no name anywhere by definition, so
    // the wording says what is missing in words instead of presenting an
    // opaque token as though it identified something to the reader.
    // `cd89c27` fixed exactly this shape (a raw user id) one commit earlier.
    expect(finding.netPosition!.proposed).not.toContain('dov');
    expect(finding.netPosition!.proposed).toMatch(/one amending document/i);
  });

  it('counts the missing amendments rather than listing their ids', async () => {
    vi.mocked(chatJson).mockResolvedValue({
      trail: [
        { document: 1, effect: 'Base effect only.', citations: [] },
        { document: 2, effect: 'Unavailable.', citations: [] },
        { document: 3, effect: 'Unavailable.', citations: [] },
      ],
      net_position: 'Based on the base document alone.',
    });

    const three: CollectionMember<DocumentFile>[] = [
      { document: leaseDoc, documentId: 'lease', kind: 'original', position: 1 },
      { document: null, documentId: 'dov', kind: 'varies', position: 2 },
      { document: null, documentId: 'lic', kind: 'varies', position: 3 },
    ];

    const finding = await extractCollectionClause(three, clause, template, settings);

    expect(finding.netPosition!.proposed).toMatch(/2 amending documents/i);
    expect(finding.netPosition!.proposed).not.toContain('lic');
  });

  it('resolves an aborted request to a calm cancelled finding, not an error', async () => {
    vi.mocked(chatJson).mockRejectedValue(new DOMException('The operation was aborted.', 'AbortError'));

    const finding = await extractCollectionClause(members(), clause, template, settings);

    expect(finding.status).toBe('cancelled');
    expect(finding.error).toBeUndefined();
  });

  it('resolves an API failure to an error finding rather than rejecting', async () => {
    vi.mocked(chatJson).mockRejectedValue(new Error('rate limited'));

    const finding = await extractCollectionClause(members(), clause, template, settings);

    expect(finding.status).toBe('error');
    expect(finding.error).toMatch(/rate limited/);
  });

  it('tags an auth error from OpenRouter', async () => {
    vi.mocked(chatJson).mockRejectedValue(new ModelError('Your session has expired. Sign in again.', 'sign_in_required', 401));

    const finding = await extractCollectionClause(members(), clause, template, settings);

    expect(finding.status).toBe('error');
    expect(finding.authError).toBe(true);
  });
});

// The founding defect, reopened one level up: a scanned member must still
// reach the model as images when the model supports them, and the clause
// must fail loudly — not silently review the member as though it said
// nothing — when it does not.
describe('extractCollectionClause: scan/image fallback', () => {
  it('sends page images for a scanned member when the model supports images', async () => {
    vi.mocked(chatJson).mockResolvedValue({
      trail: numbered({ effect: 'Base effect.', citations: [] }, { effect: 'Scan effect.', citations: [] }),
      net_position: 'ok',
    });
    const scan = docFile('dov', 'DoV.pdf', '', { pageImages: [{ mime: 'image/jpeg', data: 'AAA' }] });

    const finding = await extractCollectionClause(members({ varies: scan }), clause, template, settings);

    expect(finding.status).toBe('done');
    expect(vi.mocked(chatJson).mock.calls[0][0].images).toHaveLength(1);
  });

  it('sends no images when every member has a text layer', async () => {
    vi.mocked(chatJson).mockResolvedValue({
      trail: numbered({ effect: 'a', citations: [] }, { effect: 'b', citations: [] }),
      net_position: 'ok',
    });
    await extractCollectionClause(members(), clause, template, settings);
    expect(vi.mocked(chatJson).mock.calls[0][0].images).toBeUndefined();
  });

  it('fails loudly, without calling the model, when a scanned member cannot be read by a text-only model', async () => {
    const scan = docFile('dov', 'DoV.pdf', '', { pageImages: [{ mime: 'image/jpeg', data: 'AAA' }] });
    const textOnly: Settings = { ...settings, modelSupportsImages: false };

    const finding = await extractCollectionClause(members({ varies: scan }), clause, template, textOnly);

    expect(finding.status).toBe('error');
    expect(finding.error).toMatch(/scan/i);
    expect(finding.error).toMatch(/image/i);
    expect(chatJson).not.toHaveBeenCalled();
  });

  it('fails loudly, without calling the model, for a present member with no readable text or images at all', async () => {
    const blank = docFile('dov', 'DoV.pdf', '[Page 1]\n\n');

    const finding = await extractCollectionClause(members({ varies: blank }), clause, template, settings);

    expect(finding.status).toBe('error');
    expect(finding.error).toMatch(/no readable text or images/i);
    expect(chatJson).not.toHaveBeenCalled();
  });

  // Sibling parity with `extractClause`, which has always guarded this and
  // which this function had drifted away from. A member whose stored bytes
  // could not be found or re-parsed arrives carrying `parseError` — and, if
  // it is a scan, no text either. Without the guard, `assessDocument` reads
  // that as `unreadable` and the reviewer is told the document has "no
  // extractable content": the file is blamed for a failure to READ it.
  it('names the read failure, not the document, when a member carries a parseError', async () => {
    const unreadable = docFile('dov', 'DoV.pdf', '', {
      parseError: 'The original file for this document is no longer available.',
    });

    const finding = await extractCollectionClause(members({ varies: unreadable }), clause, template, settings);

    expect(finding.status).toBe('error');
    expect(finding.error).toContain('Could not read DoV.pdf');
    expect(finding.error).toContain('The original file for this document is no longer available.');
    expect(finding.error).not.toMatch(/no readable text or images/i);
    expect(chatJson).not.toHaveBeenCalled();
  });

  // The same for a member that DOES still have text: a document whose bytes
  // could not be re-read is not half-reviewable — `extractClause` refuses it
  // outright and so must this, or the two disagree about what a `parseError`
  // means depending on which extractor happens to see it.
  it('refuses a member with a parseError even when its extracted text survives', async () => {
    const unreadable = docFile('dov', 'DoV.pdf', dovDoc.text, {
      parseError: 'The original file for this document is no longer available.',
    });

    const finding = await extractCollectionClause(members({ varies: unreadable }), clause, template, settings);

    expect(finding.status).toBe('error');
    expect(finding.error).toContain('Could not read DoV.pdf');
    expect(chatJson).not.toHaveBeenCalled();
  });
});

/**
 * C1. The trail used to be zipped onto the collection's ordered members by
 * ARRAY POSITION, guarded only against a completely empty array. A model
 * that judged one document silent and skipped it therefore shifted every
 * later document's effect onto the document above it — while the card kept
 * showing the right name and date, which is the most convincing possible
 * presentation of a false attribution — and left the last document rendering
 * as "considered, does nothing".
 *
 * The fix is the treatment `RawCitation` already had one type above: each
 * step names the DOCUMENT it describes, that claim is resolved, and anything
 * that cannot be aligned fails the clause loudly rather than reaching `done`.
 * An effect attributed to the wrong document is worse than no derivation.
 */
describe('extractCollectionClause: the trail is aligned by each step\'s own document, never by array position', () => {
  it('fails the clause when the model returns fewer steps than the collection has documents', async () => {
    vi.mocked(chatJson).mockResolvedValue({
      // The lease's effect, then the LICENCE's effect — the deed was judged
      // silent and skipped. Zipped by index, the licence's effect lands on
      // the deed's card.
      trail: [
        { document: 1, effect: 'Break on 12 months notice, 24 June 2027.', citations: [] },
        { document: 3, effect: 'Moves the break date to 24 June 2030.', citations: [] },
      ],
      net_position: 'The break date is 24 June 2030.',
    });

    const three: CollectionMember<DocumentFile>[] = [
      ...members(),
      {
        document: docFile('lic', 'Licence.pdf', '[Page 1]\nThe break date is moved to 24 June 2030 by this licence to alter.\n\n'),
        documentId: 'lic',
        kind: 'varies',
        position: 3,
      },
    ];

    const finding = await extractCollectionClause(three, clause, template, settings);

    expect(finding.status).toBe('error');
    expect(finding.error).toMatch(/2 derivation step/i);
    expect(finding.error).toMatch(/3 document/i);
    expect(finding.netPosition).toBeUndefined();
  });

  it('fails the clause when the model returns more steps than the collection has documents', async () => {
    vi.mocked(chatJson).mockResolvedValue({
      trail: [
        { document: 1, effect: 'a', citations: [] },
        { document: 2, effect: 'b', citations: [] },
        { document: 3, effect: 'c', citations: [] },
      ],
      net_position: 'Now annual.',
    });

    const finding = await extractCollectionClause(members(), clause, template, settings);

    expect(finding.status).toBe('error');
    expect(finding.error).toMatch(/derivation/i);
    expect(finding.netPosition).toBeUndefined();
  });

  it('fails the clause when a step does not say which document it describes', async () => {
    vi.mocked(chatJson).mockResolvedValue({
      trail: [
        { document: 1, effect: 'Base effect.', citations: [] },
        { effect: 'Amendment effect.', citations: [] },
      ],
      net_position: 'Now annual.',
    });

    const finding = await extractCollectionClause(members(), clause, template, settings);

    expect(finding.status).toBe('error');
    expect(finding.error).toMatch(/step 2/i);
    expect(finding.error).toMatch(/which document/i);
    expect(finding.netPosition).toBeUndefined();
  });

  it('fails the clause when a step names a document that is not in the collection', async () => {
    vi.mocked(chatJson).mockResolvedValue({
      trail: [
        { document: 1, effect: 'Base effect.', citations: [] },
        { document: 7, effect: 'Amendment effect.', citations: [] },
      ],
      net_position: 'Now annual.',
    });

    const finding = await extractCollectionClause(members(), clause, template, settings);

    expect(finding.status).toBe('error');
    expect(finding.error).toMatch(/DOCUMENT 7/);
    expect(finding.netPosition).toBeUndefined();
  });

  it('fails the clause when two steps describe the same document', async () => {
    vi.mocked(chatJson).mockResolvedValue({
      trail: [
        { document: 1, effect: 'Base effect.', citations: [] },
        { document: 1, effect: 'Base effect again.', citations: [] },
      ],
      net_position: 'Now annual.',
    });

    const finding = await extractCollectionClause(members(), clause, template, settings);

    expect(finding.status).toBe('error');
    expect(finding.error).toMatch(/DOCUMENT 1/);
    expect(finding.netPosition).toBeUndefined();
  });

  it("orders the trail by the collection's reading order using each step's own document number", async () => {
    // Correctly attributed, returned out of order. The claim is explicit, so
    // this is resolved rather than refused — but it is resolved by the
    // CLAIM, which is what stops an effect landing on the wrong document.
    vi.mocked(chatJson).mockResolvedValue({
      trail: [
        { document: 2, effect: 'The deed makes rent review annual.', citations: [] },
        { document: 1, effect: 'The lease sets a 5-year review.', citations: [] },
      ],
      net_position: 'Now annual.',
    });

    const finding = await extractCollectionClause(members(), clause, template, settings);

    expect(finding.status).toBe('done');
    expect(finding.netPosition!.trail[0]).toMatchObject({
      documentId: 'lease', effect: 'The lease sets a 5-year review.',
    });
    expect(finding.netPosition!.trail[1]).toMatchObject({
      documentId: 'dov', effect: 'The deed makes rent review annual.',
    });
  });

  /**
   * MJ1 (re-review of C1's fix). The alignment above is a contract about the
   * documents the model was actually SENT, and an unavailable member is not
   * one of them: `buildCollectionPrompt` writes an UNAVAILABLE block for it
   * and no text, so a step describing it could only be invented.
   *
   * C1's first fix demanded one step per member of the collection's reading
   * order, unavailable members included, which made the deterministic
   * "this document is unavailable" effect and the "[Incomplete set: ...]"
   * note — two pieces of machinery that exist for exactly this case —
   * conditional on the model volunteering a step for a document it had
   * never read. The likeliest model behaviour (not inventing one) then
   * failed EVERY clause of a base-plus-missing-amendment collection, a flow
   * the app supports on purpose: only a missing BASE blocks the run.
   */
  it('completes the clause when the model returns one step per PRESENT document and an amendment is missing', async () => {
    vi.mocked(chatJson).mockResolvedValue({
      // One entry, for the one document whose text was actually sent.
      trail: [{ document: 1, effect: 'The lease sets a 5-year review.', citations: [] }],
      net_position: 'Still a 5-year review.',
    });

    const finding = await extractCollectionClause(members({ varies: null }), clause, template, settings);

    expect(finding.status).toBe('done');
    expect(finding.error).toBeUndefined();
    // The trail still covers the whole collection: the app fills the absent
    // member's step in itself rather than asking the model for it.
    expect(finding.netPosition!.trail).toHaveLength(2);
    expect(finding.netPosition!.trail[0]).toMatchObject({
      documentId: 'lease', kind: 'original', effect: 'The lease sets a 5-year review.',
    });
    expect(finding.netPosition!.trail[1].documentId).toBe('dov');
    expect(finding.netPosition!.trail[1].effect).toMatch(/unavailable/i);
    expect(finding.netPosition!.trail[1].citations).toEqual([]);
    expect(finding.netPosition!.proposed).toMatch(/incomplete set/i);
  });

  it('discards a step describing an unavailable member rather than presenting invented text as its effect', async () => {
    vi.mocked(chatJson).mockResolvedValue({
      trail: [
        { document: 1, effect: 'Base effect only.', citations: [] },
        // The model was told this document is UNAVAILABLE and wrote an
        // effect for it anyway. It has never seen the document, so this
        // sentence cannot be evidence of anything — it is dropped and the
        // deterministic wording used instead.
        { document: 2, effect: 'The deed extends the term by ten years.', citations: [] },
      ],
      net_position: 'Based on the base document alone.',
    });

    const finding = await extractCollectionClause(members({ varies: null }), clause, template, settings);

    expect(finding.status).toBe('done');
    expect(finding.netPosition!.trail[1].documentId).toBe('dov');
    expect(finding.netPosition!.trail[1].effect).toMatch(/unavailable/i);
    expect(finding.netPosition!.trail[1].effect).not.toContain('ten years');
  });

  /**
   * mn2. `claimedDocumentNumber` is shared by the trail path and the
   * citation path precisely so the two cannot disagree about what counts as
   * a claim — and it required `typeof field === 'number'`, which a model
   * without structured output (whose JSON comes back through
   * `parseJsonLoose`) routinely fails by stringifying its integers. The
   * asymmetry was the sharp end: an unreadable number costs a CITATION one
   * quote, and cost a STEP the entire clause, with a message saying the
   * model named no document when it plainly had.
   */
  it('reads a stringified document number on a step, exactly as it reads one on a citation', async () => {
    vi.mocked(chatJson).mockResolvedValue({
      trail: [
        { document: '1', effect: 'The lease sets a 5-year review.', citations: [] },
        { document: '2', effect: 'The deed makes rent review annual.', citations: [] },
      ],
      net_position: 'Now annual.',
    });

    const finding = await extractCollectionClause(members(), clause, template, settings);

    expect(finding.status).toBe('done');
    expect(finding.netPosition!.trail[0]).toMatchObject({
      documentId: 'lease', effect: 'The lease sets a 5-year review.',
    });
    expect(finding.netPosition!.trail[1]).toMatchObject({
      documentId: 'dov', effect: 'The deed makes rent review annual.',
    });
  });

  it('still fails the clause loudly when a step names something that is not a number at all', async () => {
    vi.mocked(chatJson).mockResolvedValue({
      trail: [
        { document: 1, effect: 'Base effect.', citations: [] },
        { document: 'the deed of variation', effect: 'Amendment effect.', citations: [] },
      ],
      net_position: 'Now annual.',
    });

    const finding = await extractCollectionClause(members(), clause, template, settings);

    expect(finding.status).toBe('error');
    expect(finding.error).toMatch(/step 2/i);
    expect(finding.error).toMatch(/which document/i);
    expect(finding.netPosition).toBeUndefined();
  });

  it('treats a stringified out-of-range citation number as the explicit wrong claim it is, not as an unreadable one', async () => {
    vi.mocked(chatJson).mockResolvedValue({
      trail: numbered(
        { effect: 'Base effect.', citations: [] },
        {
          effect: 'Amendment effect.',
          // A real quote from DOCUMENT 2, attributed to a document that does
          // not exist. Read as a number this is an explicit, specific claim
          // that is wrong, so it is dropped rather than quote-matched back
          // to a document the model did not name — the same rule the
          // numeric form has always followed.
          citations: [{ quote: 'Rent review is now annual, capped at RPI.', document: '9' }],
        },
      ),
      net_position: 'Now annual.',
    });

    const finding = await extractCollectionClause(members(), clause, template, settings);

    expect(finding.status).toBe('done');
    expect(finding.netPosition!.trail[1].citations).toEqual([]);
  });

  /**
   * mn1. One appended sentence was emitted for all four refusals, and it was
   * untrue for two of them. "An effect attributed to the wrong document
   * reads as that document's own legal position" describes the duplicate and
   * out-of-range cases; on a count mismatch nothing was attributed to
   * anything. "Choose a model that supports structured output" was offered
   * even when structured output was already on, and could not help in any
   * case for a count: `COLLECTION_CLAUSE_SCHEMA.trail` has no `minItems`, so
   * a schema cannot express "exactly N entries" — C1's own argument. And
   * "re-run it" is not a remedy for a model that will deviate the same way
   * every time.
   *
   * The rule this is held to is CLAUDE.md's: loud, SPECIFIC and RECOVERABLE.
   * Where nothing would recover it, the message says so rather than
   * inventing advice.
   */
  it('does not blame misattribution, or offer structured output, for a count mismatch', async () => {
    vi.mocked(chatJson).mockResolvedValue({
      trail: [{ document: 1, effect: 'Base effect.', citations: [] }],
      net_position: 'Now annual.',
    });

    const finding = await extractCollectionClause(members(), clause, template, settings);

    expect(finding.status).toBe('error');
    expect(finding.error).toMatch(/1 derivation step/i);
    expect(finding.error).toMatch(/2 document/i);
    // Nothing was attributed to anything here.
    expect(finding.error).not.toMatch(/attributed to the wrong document/i);
    // The schema has no minItems; structured output cannot enforce a count.
    expect(finding.error).not.toMatch(/structured output would|choose a model that supports structured output/i);
    expect(finding.error).toMatch(/cannot require a particular number of steps/i);
  });

  it('offers structured output for an unnumbered step only when it is not already on', async () => {
    const unnumbered = {
      trail: [
        { document: 1, effect: 'Base effect.', citations: [] },
        { effect: 'Amendment effect.', citations: [] },
      ],
      net_position: 'Now annual.',
    };

    vi.mocked(chatJson).mockResolvedValue(unnumbered);
    const without = await extractCollectionClause(
      members(), clause, template, { ...settings, modelSupportsStructuredOutput: false },
    );
    expect(without.error).toMatch(/structured output/i);
    expect(without.error).toMatch(/mandatory|required/i);

    vi.mocked(chatJson).mockResolvedValue(unnumbered);
    const with_ = await extractCollectionClause(
      members(), clause, template, { ...settings, modelSupportsStructuredOutput: true },
    );
    // Already on and the model omitted the field anyway — telling the
    // reviewer to turn it on is advice they have already taken.
    expect(with_.error).not.toMatch(/choose a model that supports structured output/i);
    expect(with_.error).toMatch(/left it out anyway|omitted it anyway/i);
  });

  it('does say an effect landed on the wrong document when a step names one that was not sent', async () => {
    vi.mocked(chatJson).mockResolvedValue({
      trail: [
        { document: 1, effect: 'Base effect.', citations: [] },
        { document: 7, effect: 'Amendment effect.', citations: [] },
      ],
      net_position: 'Now annual.',
    });

    const finding = await extractCollectionClause(members(), clause, template, settings);

    expect(finding.error).toMatch(/DOCUMENT 7/);
    expect(finding.error).toMatch(/attributed to the wrong document/i);
    // A wrong number is a per-response mistake, so re-running genuinely can
    // fix it — unlike a count, where the same deviation recurs.
    expect(finding.error).toMatch(/re-run/i);
  });

  it('names the schema field the model must number its steps with', () => {
    const step = COLLECTION_CLAUSE_SCHEMA.properties.trail.items;
    expect(step.properties.document).toBeDefined();
    expect(step.required).toContain('document');
  });
});

/**
 * M3 (final review). `buildCollectionPrompt` does the work of collecting the
 * FILENAMES it had to cut short, and `extractCollectionClause` collapsed
 * them to a bare boolean — so the card told a reviewer "this document
 * exceeds the model's context budget" about a finding derived from four, and
 * they could not tell whether the deed of variation, the document they
 * grouped the collection to ask about, was the one cut.
 *
 * Spec section 6, verbatim: "The deed of variation was cut short" is
 * actionable; "the text was truncated" is not.
 */
describe('extractCollectionClause: truncation names the documents it cut', () => {
  // contextLength 100 -> budget = floor(100 * 4 * 0.5) = 200 characters,
  // split across two documents, so both long members are cut short.
  const tight: Settings = { ...settings, modelContextLength: 100 };

  function longMembers(): CollectionMember<DocumentFile>[] {
    return [
      { document: docFile('lease', 'Lease.pdf', '[Page 1] ' + 'x'.repeat(1000)), documentId: 'lease', kind: 'original', position: 1 },
      { document: docFile('dov', 'DoV.pdf', '[Page 1] ' + 'y'.repeat(1000)), documentId: 'dov', kind: 'varies', position: 2 },
    ];
  }

  it('records WHICH documents were cut short, by name', async () => {
    vi.mocked(chatJson).mockResolvedValue({
      trail: numbered({ effect: 'a', citations: [] }, { effect: 'b', citations: [] }),
      net_position: 'Now annual.',
    });

    const finding = await extractCollectionClause(longMembers(), clause, template, tight);

    expect(finding.status).toBe('done');
    expect(finding.truncated).toBe(true);
    expect(finding.truncatedDocuments).toEqual(['Lease.pdf', 'DoV.pdf']);
  });

  /**
   * The two extractors disagreed about this: `extractClause`'s empty-summary
   * branch keeps `truncated`, and this one dropped it — so a collection
   * whose model returned nothing lost the one fact that best explains why.
   * Invisible in today's exports (a caveat qualifies an answer, and this
   * finding has none), but sibling drift between two copies of one rule is
   * this project's most repeated defect, and it is the finding record that
   * is wrong, not just the render.
   */
  it('keeps the truncation names on an empty-net-position error, exactly as extractClause does', async () => {
    vi.mocked(chatJson).mockResolvedValue({
      trail: numbered({ effect: 'a', citations: [] }, { effect: 'b', citations: [] }),
      net_position: '   ',
    });

    const finding = await extractCollectionClause(longMembers(), clause, template, tight);

    expect(finding.status).toBe('error');
    expect(finding.noContent).toBe(true);
    expect(finding.truncated).toBe(true);
    expect(finding.truncatedDocuments).toEqual(['Lease.pdf', 'DoV.pdf']);
  });

  it('records no names, and no key at all, when everything fit', async () => {
    vi.mocked(chatJson).mockResolvedValue({
      trail: numbered({ effect: 'a', citations: [] }, { effect: 'b', citations: [] }),
      net_position: 'Now annual.',
    });

    const finding = await extractCollectionClause(members(), clause, template, settings);

    // Absence, not an undefined-valued key: `structuredClone` (how
    // IndexedDB writes every record) preserves one, and it would read to
    // any `in` check as "truncation was recorded here".
    expect('truncatedDocuments' in finding).toBe(false);
    expect('truncated' in finding).toBe(false);
  });
});

// Task 6 / R-D3: evaluation happens in this same call, against the NET
// POSITION the model has just derived across the whole collection —
// `normalisePositionOutcome` (Task 5) owns the actual rules, so these tests
// only check that the collection extractor calls it with the right raw
// values and spreads its result onto the right findings.
describe('extractCollectionClause: standard position evaluation (Task 6 / R-D3)', () => {
  const clauseWithPos: PlaybookClause = { ...clause, standardPosition: pos };

  it('records a deviation with its rationale', async () => {
    vi.mocked(chatJson).mockResolvedValue({
      trail: numbered(
        { effect: 'The lease sets a 5-year rent review.', citations: [] },
        { effect: 'The deed makes rent review annual, capped at RPI.', citations: [] },
      ),
      net_position: 'Rent is now reviewed annually, at CPI, not RPI.',
      position_outcome: 'deviates',
      position_rationale: 'CPI, not RPI as our position requires.',
    });

    const finding = await extractCollectionClause(members(), clauseWithPos, template, settings);

    expect(finding.status).toBe('done');
    expect(finding.positionOutcome).toBe('deviates');
    expect(finding.positionRationale).toBe('CPI, not RPI as our position requires.');
  });

  it('leaves the outcome absent for a clause with no position', async () => {
    vi.mocked(chatJson).mockResolvedValue({
      trail: numbered({ effect: 'a', citations: [] }, { effect: 'b', citations: [] }),
      net_position: 'Now annual, capped at RPI.',
      position_outcome: 'meets',
      position_rationale: 'z',
    });

    const finding = await extractCollectionClause(members(), clause, template, settings);

    // The model volunteered an outcome for a clause with no house rule. It
    // is dropped, not recorded: there was nothing to compare against.
    expect('positionOutcome' in finding).toBe(false);
    expect('positionRationale' in finding).toBe(false);
  });

  it('records unclear when the model omits the outcome', async () => {
    vi.mocked(chatJson).mockResolvedValue({
      trail: numbered({ effect: 'a', citations: [] }, { effect: 'b', citations: [] }),
      net_position: 'Now annual, capped at RPI.',
    });

    const finding = await extractCollectionClause(members(), clauseWithPos, template, settings);

    expect(finding.positionOutcome).toBe('unclear');
  });

  it('keeps the outcome on a no-content finding', async () => {
    // A model that gave an outcome and an empty synthesis still gave an
    // outcome; dropping it would lose the one thing it did say.
    vi.mocked(chatJson).mockResolvedValue({
      trail: numbered({ effect: 'a', citations: [] }, { effect: 'b', citations: [] }),
      net_position: '   ',
      position_outcome: 'deviates',
      position_rationale: 'CPI, not RPI.',
    });

    const finding = await extractCollectionClause(members(), clauseWithPos, template, settings);

    expect(finding.status).toBe('error');
    expect(finding.noContent).toBe(true);
    expect(finding.positionOutcome).toBe('deviates');
    expect(finding.positionRationale).toBe('CPI, not RPI.');
  });

  it('requires position_outcome/position_rationale in the schema only when the clause has a position', () => {
    expect(collectionClauseSchema(clause)).toBe(COLLECTION_CLAUSE_SCHEMA);
    const withPos = collectionClauseSchema(clauseWithPos);
    expect(withPos).not.toBe(COLLECTION_CLAUSE_SCHEMA);
    expect(withPos.required).toContain('position_outcome');
    expect(withPos.required).toContain('position_rationale');
  });

  it('sends the position-aware schema to the model when the clause has a standard position', async () => {
    vi.mocked(chatJson).mockResolvedValue({
      trail: numbered({ effect: 'a', citations: [] }, { effect: 'b', citations: [] }),
      net_position: 'ok', position_outcome: 'meets', position_rationale: 'y',
    });

    await extractCollectionClause(members(), clauseWithPos, template, settings);

    const sent = vi.mocked(chatJson).mock.calls[0][0].jsonSchema as { required: string[] };
    expect(sent).not.toBe(COLLECTION_CLAUSE_SCHEMA);
    expect(sent.required).toContain('position_outcome');
  });
});
