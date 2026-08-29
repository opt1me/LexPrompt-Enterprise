import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ModelError } from '@lexprompt/core';
import { closeDb } from '../db/open';
import { seedLocal, dumpLocal } from '../../test/seedLocalData';
import type { Finding, Review } from '../../types';

/**
 * The uploader, and the four things a report of a firm's working history has
 * to get right.
 *
 * 1. It says by NAME what did not move, and calls itself incomplete.
 * 2. It keeps going after a failure, so eleven good records are not reported
 *    as eleven unknowns.
 * 3. It DELETES NOTHING from the browser.
 * 4. A human's verification survives the round trip, including an ABSENT
 *    optional key staying absent.
 *
 * The repositories are doubled by `src/test/uploadServer.ts`, which behaves
 * the way the shipped routes behave in the respects the uploader depends on
 * — a create over an existing id is refused, a published version gets a
 * fresh id and a server-allocated number, publishing consumes the draft, and
 * top-level attribution comes from the actor while `findings` jsonb does
 * not.
 */

vi.mock('../db/matters', async () => (await import('../../test/uploadServer')).mattersModule());
vi.mock('../db/documents', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../db/documents');
  return (await import('../../test/uploadServer')).documentsModule(actual);
});
vi.mock('../db/collections',
  async () => (await import('../../test/uploadServer')).collectionsModule());
vi.mock('../db/playbooks', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../db/playbooks');
  return (await import('../../test/uploadServer')).playbooksModule(actual);
});
vi.mock('../db/playbookVersions',
  async () => (await import('../../test/uploadServer')).playbookVersionsModule());
vi.mock('../db/reviews', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../db/reviews');
  return (await import('../../test/uploadServer')).reviewsModule(actual);
});
vi.mock('../db/changesets', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../db/changesets');
  return (await import('../../test/uploadServer')).changesetsModule(actual);
});
vi.mock('../db/profile', async () => (await import('../../test/uploadServer')).profileModule());

const { runUpload } = await import('./run');
const { scanLocalData } = await import('./scan');
const {
  server, calls, failUploadOf, unfail, resetServer, ACTOR_ID,
} = await import('../../test/uploadServer');

const LOCAL = 'local-abc';

const VERSION_1 = {
  id: 'v1', playbookId: 'p1', version: 1, name: 'Retail lease', contractType: 'Lease',
  systemPrompt: 's', formatPrompt: 'f', clauses: [], publishedAt: 1,
  publishedByUserId: LOCAL, schemaVersion: 1, changeSummary: '',
};
const VERSION_2 = { ...VERSION_1, id: 'v2', version: 2, changeSummary: 'Added rent review' };

/** Twelve records, one of every kind, the way a small firm's browser looks. */
async function seedEverything(extra: Partial<Parameters<typeof seedLocal>[0]> = {}): Promise<void> {
  await seedLocal({
    matters: [
      { id: 'm1', name: 'Brookvale Retail Park', ownerId: LOCAL, createdAt: 1, updatedAt: 1 },
      { id: 'm2', name: 'Ashfield Mill', ownerId: LOCAL, createdAt: 2, updatedAt: 2 },
    ],
    documents: [
      { id: 'd1', matterId: 'm1', name: 'Brookvale - executed.pdf', kind: 'pdf', text: 'a',
        byteSize: 10, addedAt: 1, addedByUserId: LOCAL, role: 'base' },
      { id: 'd2', matterId: 'm1', name: 'Brookvale - deed.docx', kind: 'docx', text: 'b',
        byteSize: 20, addedAt: 2, addedByUserId: LOCAL, role: 'varies' },
      { id: 'd3', matterId: 'm2', name: 'Ashfield - lease.pdf', kind: 'pdf', text: 'c',
        byteSize: 30, addedAt: 3, addedByUserId: LOCAL, role: 'standalone' },
    ],
    blobsFor: ['d1', 'd2', 'd3'],
    collections: [{ id: 'k1', matterId: 'm1', name: 'Lease and variation', baseDocumentId: 'd1',
      variesDocumentIds: ['d2'], createdAt: 1, createdByUserId: LOCAL }],
    playbooks: [{ id: 'p1', name: 'Retail lease', createdAt: 1, updatedAt: 1,
      currentVersionId: 'v2', schemaVersion: 1 }],
    playbookVersions: [VERSION_1, VERSION_2],
    reviews: [
      { id: 'r1', matterId: 'm1', documentIds: ['d1'], target: { kind: 'documents', documentIds: ['d1'] },
        findings: {}, modelId: 'model', startedAt: 100, createdByUserId: LOCAL,
        playbookVersionId: 'v2', playbookSnapshot: VERSION_2 },
      { id: 'r2', matterId: 'm2', documentIds: ['d3'], target: { kind: 'documents', documentIds: ['d3'] },
        findings: {}, modelId: 'model', startedAt: 200, createdByUserId: LOCAL,
        playbookSnapshot: VERSION_2 },
    ],
    changesets: [{ id: 'g1', playbookId: 'p1', fromVersionId: 'v2',
      sourceSummary: 'Brookvale — our markup + executed', items: [], createdAt: 1,
      createdByUserId: LOCAL }],
    profile: { id: LOCAL, name: 'Me', initials: 'ME' },
    ...extra,
  });
}

beforeEach(() => {
  closeDb();
  indexedDB.deleteDatabase('lexprompt');
  resetServer();
});

const orderOf = (): string[] => [...new Set(calls.map(c => c.store))];

describe('runUpload', () => {
  it('moves every record type and reports each one moved, by name', async () => {
    await seedEverything();
    const report = await runUpload(await scanLocalData());
    expect(report.complete).toBe(true);
    // Two matters, three documents, one collection, one playbook, two
    // versions, two reviews, one changeset.
    expect(report.outcomes.filter(o => o.status === 'moved')).toHaveLength(12);
    expect(report.outcomes.map(o => o.label)).toContain('Brookvale Retail Park');
    expect(report.outcomes.map(o => o.label)).toContain('Brookvale - executed.pdf');
  });

  it('NAMES what it could not move, and reports the run as incomplete', async () => {
    await seedEverything();
    failUploadOf('documents', 'Brookvale - executed.pdf',
      new ModelError('This request is larger than LexPrompt accepts in one call', 'prompt_too_large', 413));
    const report = await runUpload(await scanLocalData());
    expect(report.complete).toBe(false);
    const failed = report.outcomes.find(o => o.status === 'failed')!;
    expect(failed.label).toBe('Brookvale - executed.pdf');
    expect(failed.reason).toMatch(/larger than LexPrompt accepts/);
  });

  it('KEEPS GOING after a failure rather than stopping at the first', async () => {
    // Stopping would report one failure and eleven unknowns, and the person
    // reading it could not tell which of the eleven were fine.
    await seedEverything();
    failUploadOf('documents', 'Ashfield - lease.pdf', new Error('boom'));
    const report = await runUpload(await scanLocalData());
    expect(report.outcomes.filter(o => o.status === 'moved').length).toBeGreaterThan(9);
    expect(report.complete).toBe(false);
  });

  it('records a document whose bytes are missing as moved-WITHOUT-BYTES, never as moved', async () => {
    // "3 documents moved" over a document with no file is the blank-CSV-cell
    // defect: technically true, read as complete.
    await seedLocal({
      matters: [{ id: 'm1', name: 'Brookvale Retail Park', ownerId: LOCAL, createdAt: 1, updatedAt: 1 }],
      documents: [{ id: 'd1', matterId: 'm1', name: 'Brookvale - executed.pdf', kind: 'pdf',
        text: 'a', byteSize: 10, addedAt: 1, addedByUserId: LOCAL, role: 'standalone' }],
      blobsFor: [],
      profile: { id: LOCAL, name: 'Me', initials: 'ME' },
    });
    const report = await runUpload(await scanLocalData());
    const document = report.outcomes.find(o => o.store === 'documents')!;
    expect(document.status).toBe('moved-without-bytes');
    expect(document.reason).toMatch(/original file was not in this browser/i);
    expect(report.complete).toBe(false);
    // …and the TEXT still moved, because a review's findings are read
    // against it and refusing the record would take the reviews too.
    expect(server.documents.get('d1')!.record.text).toBe('a');
  });

  it('is idempotent — a second run over a partial first one re-sends only what failed', async () => {
    // P15. Every write is the same PUT-as-upsert the app uses, so a record
    // that is already there is confirmed rather than duplicated.
    await seedEverything();
    failUploadOf('documents', 'Ashfield - lease.pdf', new Error('boom'));
    const first = await runUpload(await scanLocalData());
    expect(first.complete).toBe(false);
    unfail();
    const second = await runUpload(await scanLocalData());
    expect(second.complete).toBe(true);
    expect(server.documents.size).toBe(3);
    // Two versions, not four: a re-run must not republish a firm's history
    // as v3 and v4 of the same playbook.
    expect(server.versions.size).toBe(2);
    expect(second.outcomes.filter(o => o.status === 'skipped-already-there').length)
      .toBeGreaterThan(9);
  });

  it('DELETES NOTHING from the local database', async () => {
    await seedEverything();
    const before = await dumpLocal();
    await runUpload(await scanLocalData());
    expect(await dumpLocal()).toEqual(before);
  });

  it('uploads in dependency order, so a document never arrives before its matter', async () => {
    // matters -> documents -> collections -> playbooks/versions -> reviews
    // -> changesets. The foreign keys and the routes' own membership checks
    // enforce it; getting the order wrong produces a wall of "not in this
    // matter" for data that is fine. (Task 22's brief has collections BEFORE
    // documents, which the shipped collections route refuses.)
    await seedEverything();
    await runUpload(await scanLocalData());
    expect(orderOf()).toEqual(['matters', 'documents', 'collections', 'playbookVersions',
      'reviews', 'changesets']);
  });

  it('remaps a version id the server minted, so a review is not refused for naming the old one', async () => {
    // `publishAndPoint` allocates a fresh id every time. A review pointing at
    // the local id would be refused by the route's foreign-key check — a wall
    // of refusals over data that is perfectly good.
    await seedEverything();
    const report = await runUpload(await scanLocalData());
    expect(report.complete).toBe(true);
    const stored = server.reviews.get('r1')!;
    expect(stored.playbookVersionId).not.toBe('v2');
    expect(server.versions.get(stored.playbookVersionId!)!.version).toBe(2);
    // …and the changeset's `from_version_id`, which is `not null references
    // playbook_version(id)`.
    expect(server.changesets.get('g1')!.fromVersionId).toBe(stored.playbookVersionId);
  });

  it('moves a review WHOLE when its version pointer names a version this browser no longer has', async () => {
    // R-D15's "recorded, then deleted". Sending the dangling id would cost
    // the whole review — verifications included — to save a pointer that was
    // already dangling before the move.
    await seedEverything();
    const scan = await scanLocalData();
    const review = scan.records.reviews.find(r => r.id === 'r1')!;
    (review.record as Review).playbookVersionId = 'gone';
    const report = await runUpload(scan);
    const outcome = report.outcomes.find(o => o.id === 'r1')!;
    expect(outcome.status).toBe('moved');
    expect(outcome.reason).toMatch(/not in this browser either/);
    expect('playbookVersionId' in server.reviews.get('r1')!).toBe(false);
  });

  it('reports a version whose playbook is not here at all, rather than dropping it', async () => {
    await seedLocal({
      playbookVersions: [{ ...VERSION_1, playbookId: 'ghost' }],
      profile: { id: LOCAL, name: 'Me', initials: 'ME' },
    });
    const report = await runUpload(await scanLocalData());
    expect(report.complete).toBe(false);
    const outcome = report.outcomes.find(o => o.store === 'playbookVersions')!;
    expect(outcome.status).toBe('failed');
    expect(outcome.reason).toMatch(/not in this browser/);
  });
});

/**
 * The most valuable thing in the payload.
 *
 * Verification state is set only by a human action and nothing derives it. A
 * review that moves while its verifications do not is a silent loss of
 * exactly the judgement this app exists to record — and it would be silent,
 * because the review still opens, still reads, and still exports.
 */
describe("a human's verification survives the round trip", () => {
  const verified: Finding = {
    clauseId: 'c1', status: 'done', summary: 'Rent reviewed every five years.',
    citations: [{ documentId: 'd1', quote: 'reviewed every fifth year', page: 4 }],
    verification: { state: 'verified', byUserId: LOCAL, at: 1_700_000_000_000 },
    notes: [{ id: 'n1', findingId: 'd1::c1', text: 'Agreed with the partner.',
      byUserId: LOCAL, at: 1_700_000_100_000 }],
  };
  // A finding a person REJECTED, with the reason a rejection must carry, and
  // no `at`/`byUserId`-adjacent optional key it never had.
  const rejected: Finding = {
    clauseId: 'c2', status: 'done', summary: 'Silent on service charge caps.',
    citations: [],
    verification: { state: 'rejected', byUserId: LOCAL, at: 1_700_000_200_000,
      reason: 'The cap is in the sixth schedule.' },
    notes: [],
  };

  beforeEach(async () => {
    await seedLocal({
      matters: [{ id: 'm1', name: 'Brookvale Retail Park', ownerId: LOCAL, createdAt: 1, updatedAt: 1 }],
      reviews: [{ id: 'r1', matterId: 'm1', documentIds: ['d1'],
        target: { kind: 'documents', documentIds: ['d1'] },
        findings: { d1: { c1: verified, c2: rejected } },
        modelId: 'model', startedAt: 100, createdByUserId: LOCAL,
        playbookSnapshot: VERSION_2 }],
      profile: { id: LOCAL, name: 'Me', initials: 'ME' },
    });
  });

  it('arrives with the state, the reason and the note intact', async () => {
    await runUpload(await scanLocalData());
    const stored = server.reviews.get('r1')!;
    expect(stored.findings.d1.c1.verification.state).toBe('verified');
    expect(stored.findings.d1.c2.verification.state).toBe('rejected');
    expect(stored.findings.d1.c2.verification.reason).toBe('The cap is in the sixth schedule.');
    expect(stored.findings.d1.c1.notes[0].text).toBe('Agreed with the partner.');
    expect(stored.findings.d1.c1.verification.at).toBe(1_700_000_000_000);
  });

  it('re-attributes it to the signed-in user, so it is not verified by nobody', async () => {
    // `review.findings` is jsonb and nothing on the server looks inside it,
    // so a local profile id left in there breaks no constraint — which is
    // exactly why it would survive — and renders as a verification by
    // nobody.
    await runUpload(await scanLocalData());
    const stored = server.reviews.get('r1')!;
    expect(stored.findings.d1.c1.verification.byUserId).toBe(ACTOR_ID);
    expect(stored.findings.d1.c1.notes[0].byUserId).toBe(ACTOR_ID);
    expect(stored.findings.d1.c2.verification.byUserId).toBe(ACTOR_ID);
  });

  it('leaves an ABSENT optional key absent', async () => {
    // `toEqual` cannot tell an absent key from an `undefined` one, and
    // `structuredClone` — how IndexedDB writes every record — PRESERVES an
    // undefined-valued key. A `reason: undefined` on a verified finding
    // would persist a claim that a reason was recorded and was empty.
    await runUpload(await scanLocalData());
    const stored = server.reviews.get('r1')!;
    expect('reason' in stored.findings.d1.c1.verification).toBe(false);
    expect('assigneeId' in stored.findings.d1.c1.verification).toBe(false);
    expect('riskLevel' in stored.findings.d1.c1).toBe(false);
  });
});
