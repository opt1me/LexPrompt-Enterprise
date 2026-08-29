import { describe, it, expect } from 'vitest';
import {
  absentUnless,
  toMatterRow, fromMatterRow,
  toDocumentRow, fromDocumentRow,
  toCollectionRow, fromCollectionRow,
  toPlaybookRow, fromPlaybookRow,
  toPlaybookVersionRow, fromPlaybookVersionRow,
  toReviewRow, fromReviewRow,
  toChangesetRow, fromChangesetRow,
  type Matter, type DocumentRecord, type Collection, type Playbook, type PlaybookVersion,
  type Review, type Changeset,
} from '../src/db/rows.ts';

const WS = 'ws-1';

describe('absentUnless', () => {
  it('produces an object with the key when the value is present', () => {
    expect(absentUnless('client', 'Acme')).toEqual({ client: 'Acme' });
  });

  it('produces an object with NO key at all for null — never { key: undefined }', () => {
    const result = absentUnless('client', null);
    expect('client' in result).toBe(false);
    // toEqual would treat {} and { client: undefined } as equal — the exact
    // trap CLAUDE.md names. The 'in' check above is the one that matters.
    expect(result).toEqual({});
  });

  it('produces an object with NO key at all for undefined', () => {
    const result = absentUnless('reference', undefined);
    expect('reference' in result).toBe(false);
  });
});

describe('matter row mapping', () => {
  const matter: Matter = {
    id: 'm1', name: 'Brookvale', ownerId: 'u1',
    createdAt: 1_700_000_000_000, updatedAt: 1_700_000_100_000,
  };

  it('round-trips an epoch through a real Date', () => {
    const row = toMatterRow(matter, WS);
    expect(row.created_at).toBeInstanceOf(Date);
    expect(row.created_at.getTime()).toBe(1_700_000_000_000);
    const back = fromMatterRow(row);
    expect(back.createdAt).toBe(1_700_000_000_000);
    expect(back.updatedAt).toBe(1_700_000_100_000);
  });

  it('turns a NULL client/reference column into an ABSENT key, not client: undefined', () => {
    const row = toMatterRow(matter, WS);
    expect(row.client).toBeNull();
    expect(row.reference).toBeNull();
    const back = fromMatterRow(row);
    expect('client' in back).toBe(false);
    expect('reference' in back).toBe(false);
  });

  it('keeps a present client/reference', () => {
    const row = toMatterRow({ ...matter, client: 'Acme', reference: 'REF-1' }, WS);
    expect(row.client).toBe('Acme');
    expect(row.reference).toBe('REF-1');
    const back = fromMatterRow(row);
    expect(back.client).toBe('Acme');
    expect(back.reference).toBe('REF-1');
  });

  it('maps an empty-string ownerId to NULL in the column, and NULL back to \'\'', () => {
    const row = toMatterRow({ ...matter, ownerId: '' }, WS);
    expect(row.owner_id).toBeNull();
    const back = fromMatterRow(row);
    expect(back.ownerId).toBe('');
    expect(typeof back.ownerId).toBe('string');
  });

  it('keeps a real ownerId as-is, both ways', () => {
    const row = toMatterRow(matter, WS);
    expect(row.owner_id).toBe('u1');
    expect(fromMatterRow(row).ownerId).toBe('u1');
  });
});

describe('document row mapping', () => {
  const doc: DocumentRecord = {
    id: 'd1', matterId: 'm1', name: 'Lease.pdf', kind: 'pdf', text: 'Body text',
    byteSize: 1024, addedAt: 1_700_000_000_000, addedByUserId: '', role: 'standalone',
  };

  it('derives parse_state from parseError, and never reads it back onto the wire type', () => {
    const parsed = toDocumentRow(doc, WS, { mime: 'application/pdf', blobKey: 'k1' });
    expect(parsed.parse_state).toBe('parsed');
    const failed = toDocumentRow({ ...doc, parseError: 'could not read' }, WS,
      { mime: 'application/pdf', blobKey: 'k1' });
    expect(failed.parse_state).toBe('failed');
    const back = fromDocumentRow(failed);
    expect('parseState' in back).toBe(false);
    expect(back.parseError).toBe('could not read');
  });

  it('turns an absent collectionId/documentDate into NULL, and NULL back into absent', () => {
    const row = toDocumentRow(doc, WS, { mime: 'application/pdf', blobKey: 'k1' });
    expect(row.collection_id).toBeNull();
    expect(row.document_date).toBeNull();
    const back = fromDocumentRow(row);
    expect('collectionId' in back).toBe(false);
    expect('documentDate' in back).toBe(false);
  });

  it('round-trips a present documentDate through a real Date', () => {
    const row = toDocumentRow({ ...doc, documentDate: 1_650_000_000_000 }, WS,
      { mime: 'application/pdf', blobKey: 'k1' });
    expect(row.document_date).toBeInstanceOf(Date);
    const back = fromDocumentRow(row);
    expect(back.documentDate).toBe(1_650_000_000_000);
  });

  it('maps an empty-string addedByUserId to NULL and back', () => {
    const row = toDocumentRow(doc, WS, { mime: 'application/pdf', blobKey: 'k1' });
    expect(row.added_by_user_id).toBeNull();
    expect(fromDocumentRow(row).addedByUserId).toBe('');
  });
});

describe('collection row mapping', () => {
  const collection: Collection = {
    id: 'c1', matterId: 'm1', name: 'Lease + variations', baseDocumentId: 'd1',
    variesDocumentIds: ['d2', 'd3'], createdAt: 1_700_000_000_000, createdByUserId: '',
  };

  it('round-trips variesDocumentIds as a JSON array, not a Postgres array literal', () => {
    const row = toCollectionRow(collection, WS);
    expect(typeof row.varies_document_ids).toBe('string');
    expect(JSON.parse(row.varies_document_ids as string)).toEqual(['d2', 'd3']);
    // Simulates what `pg` hands back for a jsonb column: already parsed.
    const parsedRow = { ...row, varies_document_ids: ['d2', 'd3'] };
    expect(fromCollectionRow(parsedRow).variesDocumentIds).toEqual(['d2', 'd3']);
    // And the string form (a row built by hand, or read via a client that
    // does not auto-parse jsonb) round-trips identically.
    expect(fromCollectionRow(row).variesDocumentIds).toEqual(['d2', 'd3']);
  });

  it('maps an empty-string createdByUserId to NULL and back', () => {
    const row = toCollectionRow(collection, WS);
    expect(row.created_by_user_id).toBeNull();
    expect(fromCollectionRow(row).createdByUserId).toBe('');
  });
});

describe('playbook row mapping', () => {
  const playbook: Playbook = {
    id: 'p1', name: 'NDA playbook', createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_100_000, schemaVersion: 3,
  };

  it('turns an absent currentVersionId/draft into NULL, and NULL back into absent', () => {
    const row = toPlaybookRow(playbook, WS);
    expect(row.current_version_id).toBeNull();
    expect(row.draft).toBeNull();
    const back = fromPlaybookRow(row);
    expect('currentVersionId' in back).toBe(false);
    expect('draft' in back).toBe(false);
  });

  it('round-trips a present draft through JSON', () => {
    const draft = { name: 'x', contractType: 'NDA', systemPrompt: 's', formatPrompt: 'f', clauses: [], changeSummary: '' };
    const row = toPlaybookRow({ ...playbook, draft }, WS);
    expect(typeof row.draft).toBe('string');
    expect(fromPlaybookRow(row).draft).toEqual(draft);
  });
});

describe('playbook_version row mapping (immutable — no update path)', () => {
  const version: PlaybookVersion = {
    id: 'pv1', playbookId: 'p1', version: 1, name: 'NDA playbook',
    contractType: 'NDA', systemPrompt: 'sys', formatPrompt: 'fmt',
    clauses: [{ id: 'cl1' }], changeSummary: 'Initial publish.',
    publishedAt: 1_700_000_000_000, publishedByUserId: 'u1', schemaVersion: 3,
  };

  it('bundles everything not its own column into content, and mirrors changeSummary as summary', () => {
    const row = toPlaybookVersionRow(version, WS);
    expect(row.summary).toBe('Initial publish.');
    const content = JSON.parse(row.content as string) as Record<string, unknown>;
    expect(content).not.toHaveProperty('id');
    expect(content).not.toHaveProperty('playbookId');
    expect(content).not.toHaveProperty('version');
    expect(content).not.toHaveProperty('publishedAt');
    expect(content).not.toHaveProperty('publishedByUserId');
    expect(content.clauses).toEqual([{ id: 'cl1' }]);
  });

  it('round-trips to an object structurally equal to the original', () => {
    const row = toPlaybookVersionRow(version, WS);
    expect(fromPlaybookVersionRow(row)).toEqual(version);
  });

  it('maps an empty-string publishedByUserId to NULL and back', () => {
    const row = toPlaybookVersionRow({ ...version, publishedByUserId: '' }, WS);
    expect(row.published_by_user_id).toBeNull();
    expect(fromPlaybookVersionRow(row).publishedByUserId).toBe('');
  });
});

describe('review row mapping', () => {
  const review: Review = {
    id: 'r1', matterId: 'm1', playbookSnapshot: { id: 'pv1' }, documentIds: ['d1'],
    target: { kind: 'documents', documentIds: ['d1'] }, findings: { d1: { c1: { clauseId: 'c1' } } },
    modelId: 'gpt-4o', startedAt: 1_700_000_000_000, createdByUserId: '',
  };

  it('turns absent optional fields into NULL columns, and NULL back into absent', () => {
    const row = toReviewRow(review, WS);
    expect(row.playbook_version_id).toBeNull();
    expect(row.completed_at).toBeNull();
    expect(row.cancelled_at).toBeNull();
    const back = fromReviewRow(row);
    expect('playbookVersionId' in back).toBe(false);
    expect('completedAt' in back).toBe(false);
    expect('cancelledAt' in back).toBe(false);
  });

  it('round-trips the jsonb map exactly, findings key survives whole', () => {
    const row = toReviewRow(review, WS);
    expect(fromReviewRow(row).findings).toEqual(review.findings);
    expect(fromReviewRow(row).documentIds).toEqual(['d1']);
  });

  it('maps an empty-string createdByUserId to NULL and back', () => {
    const row = toReviewRow(review, WS);
    expect(row.created_by_user_id).toBeNull();
    expect(fromReviewRow(row).createdByUserId).toBe('');
  });
});

describe('changeset row mapping', () => {
  const changeset: Changeset = {
    id: 'cs1', playbookId: 'p1', fromVersionId: 'pv1', sourceSummary: 'Redlined lease',
    items: [{ clauseId: 'c1' }], createdAt: 1_700_000_000_000, createdByUserId: '',
  };

  it('round-trips items as a JSON array', () => {
    const row = toChangesetRow(changeset, WS);
    expect(typeof row.items).toBe('string');
    expect(fromChangesetRow(row).items).toEqual([{ clauseId: 'c1' }]);
  });

  it('turns an absent publishedVersionId into NULL, and NULL back into absent', () => {
    const row = toChangesetRow(changeset, WS);
    expect(row.published_version_id).toBeNull();
    expect('publishedVersionId' in fromChangesetRow(row)).toBe(false);
  });

  it('maps an empty-string createdByUserId to NULL and back', () => {
    const row = toChangesetRow(changeset, WS);
    expect(row.created_by_user_id).toBeNull();
    expect(fromChangesetRow(row).createdByUserId).toBe('');
  });
});
