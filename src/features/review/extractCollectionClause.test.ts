import { describe, it, expect, vi, beforeEach } from 'vitest';
import { extractCollectionClause, COLLECTION_CLAUSE_SCHEMA } from './extractCollectionClause';
import type { Clause, Template, DocumentFile, Settings } from '../../types';
import type { CollectionMember } from '../../lib/collectionOrder';

vi.mock('../../lib/openrouter', async () => {
  const actual = await vi.importActual<typeof import('../../lib/openrouter')>('../../lib/openrouter');
  return { ...actual, chatJson: vi.fn() };
});
const { chatJson, OpenRouterError } = await import('../../lib/openrouter');

// A fully capable model, matching extractClause.test.ts's fixture posture, so
// the happy-path tests below are unaffected by capability gating.
const settings: Settings = {
  apiKey: 'k', modelId: 'm', concurrency: 5,
  modelSupportsImages: true, modelSupportsStructuredOutput: true, modelContextLength: 1_000_000,
};

const clause: Clause = {
  id: 'c1',
  title: 'Rent Review',
  prompt: 'Describe how rent is reviewed and by whom.',
  riskCriteria: 'Should not exceed RPI.',
};

const template: Template = {
  id: 't1', name: 'Lease', contractType: 'Lease', mode: 'risk',
  systemPrompt: 'You are a reviewer.', formatPrompt: 'Quote verbatim.',
  riskTolerance: 'Conservative.', clauses: [clause],
  createdAt: 0, updatedAt: 0, schemaVersion: 2,
};

function docFile(id: string, name: string, text: string, overrides: Partial<DocumentFile> = {}): DocumentFile {
  return { id, name, kind: 'pdf', text, file: new File([''], name), ...overrides };
}

const leaseDoc = docFile('lease', 'Lease.pdf', '[Page 1]\nThe rent is reviewed every five years to open market value.\n\n');
const dovDoc = docFile('dov', 'DoV.pdf', '[Page 1]\nRent review is now annual, capped at RPI.\n\n');

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

beforeEach(() => vi.clearAllMocks());

describe('extractCollectionClause', () => {
  it('returns a trail step per contributing document, in reading order, each with its effect', async () => {
    vi.mocked(chatJson).mockResolvedValue({
      trail: [
        { effect: 'The lease sets a 5-year rent review.', citations: [] },
        { effect: 'The deed makes rent review annual, capped at RPI.', citations: [] },
      ],
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
      trail: [{ effect: 'a', citations: [] }, { effect: 'b', citations: [] }],
      net_position: 'ok',
    });
    await extractCollectionClause(members(), clause, template, settings);
    expect(vi.mocked(chatJson).mock.calls[0][0].jsonSchema).toBe(COLLECTION_CLAUSE_SCHEMA);
  });

  it("attributes a citation naming document 2 to document 2's real id", async () => {
    vi.mocked(chatJson).mockResolvedValue({
      trail: [
        { effect: 'Base sets a 5-year review.', citations: [] },
        {
          effect: 'Amendment makes it annual.',
          citations: [{ quote: 'Rent review is now annual, capped at RPI.', document: 2 }],
        },
      ],
      net_position: 'Now annual, capped at RPI.',
    });

    const finding = await extractCollectionClause(members(), clause, template, settings);

    expect(finding.netPosition!.trail[1].citations).toEqual([
      { quote: 'Rent review is now annual, capped at RPI.', documentId: 'dov', page: 1 },
    ]);
  });

  it('drops a citation naming a document that was not in the call, and returns the finding with the rest', async () => {
    vi.mocked(chatJson).mockResolvedValue({
      trail: [
        {
          effect: 'Base effect.',
          citations: [{ quote: 'The rent is reviewed every five years to open market value.', document: 1 }],
        },
        {
          effect: 'Amendment effect.',
          citations: [{ quote: 'Fabricated quote from nowhere.', document: 7 }],
        },
      ],
      net_position: 'Now annual.',
    });

    const finding = await extractCollectionClause(members(), clause, template, settings);

    expect(finding.status).toBe('done');
    expect(finding.netPosition!.trail[0].citations).toHaveLength(1);
    expect(finding.netPosition!.trail[1].citations).toHaveLength(0);
  });

  it('recovers a citation whose document number is unreadable by matching its quote against each document\'s text', async () => {
    vi.mocked(chatJson).mockResolvedValue({
      trail: [
        { effect: 'Base effect.', citations: [] },
        // A bare string citation carries no document number at all.
        { effect: 'Amendment effect.', citations: ['Rent review is now annual, capped at RPI.'] },
      ],
      net_position: 'Now annual.',
    });

    const finding = await extractCollectionClause(members(), clause, template, settings);

    expect(finding.netPosition!.trail[1].citations).toEqual([
      { quote: 'Rent review is now annual, capped at RPI.', documentId: 'dov', page: 1 },
    ]);
  });

  it('drops an unreadable-number citation when quote-match recovery also fails', async () => {
    vi.mocked(chatJson).mockResolvedValue({
      trail: [
        { effect: 'Base effect.', citations: [] },
        { effect: 'Amendment effect.', citations: ['Nothing like this appears anywhere in either document.'] },
      ],
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
      trail: [
        {
          effect: 'Base effect.',
          citations: [{ quote: 'The rent is reviewed every five years to open market value.', document: 1 }],
        },
        { effect: 'Amendment effect.', citations: [] },
      ],
      net_position: 'Still on 5-year review.',
    });

    const finding = await extractCollectionClause(paged, clause, template, settings);

    expect(finding.netPosition!.trail[0].citations).toEqual([
      { quote: 'The rent is reviewed every five years to open market value.', documentId: 'lease', page: 2 },
    ]);
  });

  it('starts the net position unconfirmed and the finding unchecked, with no notes', async () => {
    vi.mocked(chatJson).mockResolvedValue({
      trail: [{ effect: 'a', citations: [] }, { effect: 'b', citations: [] }],
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
      trail: [{ effect: 'a', citations: [] }, { effect: 'b', citations: [] }],
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
      trail: [
        { effect: 'Base effect only.', citations: [] },
        { effect: 'This document is unavailable.', citations: [] },
      ],
      net_position: 'Based on the base document alone.',
    });

    const finding = await extractCollectionClause(members({ varies: null }), clause, template, settings);

    expect(finding.status).toBe('done');
    expect(finding.netPosition!.proposed).toMatch(/incomplete/i);
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
    vi.mocked(chatJson).mockRejectedValue(new OpenRouterError('Your OpenRouter API key was rejected: bad key', 401));

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
      trail: [{ effect: 'Base effect.', citations: [] }, { effect: 'Scan effect.', citations: [] }],
      net_position: 'ok',
    });
    const scan = docFile('dov', 'DoV.pdf', '', { pageImages: [{ mime: 'image/jpeg', data: 'AAA' }] });

    const finding = await extractCollectionClause(members({ varies: scan }), clause, template, settings);

    expect(finding.status).toBe('done');
    expect(vi.mocked(chatJson).mock.calls[0][0].images).toHaveLength(1);
  });

  it('sends no images when every member has a text layer', async () => {
    vi.mocked(chatJson).mockResolvedValue({
      trail: [{ effect: 'a', citations: [] }, { effect: 'b', citations: [] }],
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
