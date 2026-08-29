import { describe, it, expect, beforeEach } from 'vitest';
import type { IDBPDatabase } from 'idb';
import { scanLocalData } from './scan';
import { DbBlockedError, closeDb, getDb } from '../db/open';
import { describeLoadError } from '../loadError';
import type { LexPromptDB } from '../db/schema';
import { seedLocal } from '../../test/seedLocalData';

/**
 * The scan is what makes the report honest, so what is asserted here is not
 * "it counted things" but the three-way distinction it exists to keep:
 * a store it READ and found empty, a store it READ and found records in, and
 * a store it COULD NOT READ. Collapsing the third into the first is
 * `CLAUDE.md`'s founding defect — *"a failed storage migration rendering an
 * empty library, indistinguishable from a fresh install"* — arriving at the
 * one screen whose entire job is telling a person what is in their browser.
 */

/** Wraps a real `getDb()` handle so a single store's `getAll` fails, leaving
 *  the rest readable. That is the real situation being modelled: IndexedDB
 *  can fail per-request, and the other six stores are still worth moving. */
function failingStore(store: string): () => Promise<IDBPDatabase<LexPromptDB>> {
  return async () => {
    const db = await getDb();
    return new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === 'getAll' || prop === 'getAllKeys') {
          return (name: string, ...rest: unknown[]) => (name === store
            ? Promise.reject(new Error('IndexedDB read failed'))
            : (Reflect.get(target, prop, receiver) as (...a: unknown[]) => unknown)
              .call(target, name, ...rest));
        }
        return Reflect.get(target, prop, receiver) as unknown;
      },
    }) as IDBPDatabase<LexPromptDB>;
  };
}

const MATTERS = [
  { id: 'm1', name: 'Brookvale Retail Park', ownerId: 'local-abc', createdAt: 1, updatedAt: 1 },
  { id: 'm2', name: 'Ashfield Mill', ownerId: 'local-abc', createdAt: 2, updatedAt: 2 },
];

const DOCS = [
  { id: 'd1', matterId: 'm1', name: 'Brookvale - executed.pdf', kind: 'pdf' as const, text: 'x',
    byteSize: 1000, addedAt: 1, addedByUserId: 'local-abc', role: 'standalone' as const },
  { id: 'd2', matterId: 'm1', name: 'Brookvale - deed.docx', kind: 'docx' as const, text: 'y',
    byteSize: 2000, addedAt: 2, addedByUserId: 'local-abc', role: 'standalone' as const },
  { id: 'd3', matterId: 'm2', name: 'Ashfield - lease.pdf', kind: 'pdf' as const, text: 'z',
    byteSize: 3000, addedAt: 3, addedByUserId: 'local-abc', role: 'standalone' as const },
];

async function seedEverything(): Promise<void> {
  await seedLocal({
    matters: MATTERS,
    documents: DOCS,
    blobsFor: ['d1', 'd2', 'd3'],
    collections: [{ id: 'k1', matterId: 'm1', name: 'Lease and variation',
      baseDocumentId: 'd1', variesDocumentIds: ['d2'], createdAt: 1, createdByUserId: 'local-abc' }],
    playbooks: [{ id: 'p1', name: 'Retail lease', createdAt: 1, updatedAt: 1,
      currentVersionId: 'v2', schemaVersion: 1 }],
    playbookVersions: [
      { id: 'v1', playbookId: 'p1', version: 1, name: 'Retail lease', contractType: 'Lease',
        systemPrompt: 's', formatPrompt: 'f', clauses: [], publishedAt: 1,
        publishedByUserId: 'local-abc', schemaVersion: 1, changeSummary: '' },
      { id: 'v2', playbookId: 'p1', version: 2, name: 'Retail lease', contractType: 'Lease',
        systemPrompt: 's', formatPrompt: 'f', clauses: [], publishedAt: 2,
        publishedByUserId: 'local-abc', schemaVersion: 1, changeSummary: 'Added rent review' },
    ],
    reviews: [
      { id: 'r1', matterId: 'm1', documentIds: ['d1'], target: { kind: 'documents', documentIds: ['d1'] },
        findings: {}, modelId: 'model', startedAt: 1_760_000_000_000, createdByUserId: 'local-abc',
        playbookSnapshot: { id: 'v2', playbookId: 'p1', version: 2, name: 'Retail lease',
          contractType: 'Lease', systemPrompt: 's', formatPrompt: 'f', clauses: [],
          publishedAt: 2, publishedByUserId: 'local-abc', schemaVersion: 1,
          changeSummary: 'Added rent review' } },
      { id: 'r2', matterId: 'm2', documentIds: ['d3'], target: { kind: 'documents', documentIds: ['d3'] },
        findings: {}, modelId: 'model', startedAt: 1_760_100_000_000, createdByUserId: 'local-abc',
        playbookSnapshot: { id: 'v2', playbookId: 'p1', version: 2, name: 'Retail lease',
          contractType: 'Lease', systemPrompt: 's', formatPrompt: 'f', clauses: [],
          publishedAt: 2, publishedByUserId: 'local-abc', schemaVersion: 1,
          changeSummary: 'Added rent review' } },
    ],
    changesets: [{ id: 'g1', playbookId: 'p1', fromVersionId: 'v2',
      sourceSummary: 'Brookvale — our markup + executed', items: [], createdAt: 1,
      createdByUserId: 'local-abc' }],
    profile: { id: 'local-abc', name: 'Me', initials: 'ME' },
  });
}

beforeEach(() => {
  closeDb();
  indexedDB.deleteDatabase('lexprompt');
});

describe('scanLocalData', () => {
  it('counts every store and names every record', async () => {
    await seedEverything();
    const scan = await scanLocalData();
    expect(scan.totals).toEqual({
      matters: 2, documents: 3, collections: 1, reviews: 2,
      playbooks: 1, playbookVersions: 2, changesets: 1,
    });
    // Named, not just counted: "3 of 4 moved" is useless without which one.
    expect(scan.records.matters.map(r => r.label)).toEqual(['Brookvale Retail Park', 'Ashfield Mill']);
    expect(scan.records.documents.map(r => r.label)).toContain('Brookvale - executed.pdf');
    expect(scan.records.playbookVersions.map(r => r.label)).toEqual(['Retail lease v1', 'Retail lease v2']);
    // A review's name is its playbook and its date, not its id.
    expect(scan.records.reviews[0].label).toMatch(/^Retail lease — /);
    expect(scan.records.changesets[0].label).toBe('Brookvale — our markup + executed');
  });

  it('carries the local profile id, so attributions can be rewritten', async () => {
    await seedEverything();
    expect((await scanLocalData()).localProfileId).toBe('local-abc');
  });

  it('reports a document whose BLOB is missing as a record that will move incompletely', async () => {
    // A DocumentRecord can outlive its bytes (`getDocumentBlob` returns null
    // for exactly this). The scan must say so BEFORE the upload, so nobody
    // reads "3 documents moved" and assumes three files came with them.
    await seedLocal({ documents: [DOCS[0]], blobsFor: [] });
    const scan = await scanLocalData();
    expect(scan.records.documents[0].warning).toMatch(/original file is not in this browser/i);
    expect(scan.documentsWithoutBytes).toEqual(['d1']);
  });

  it('leaves the warning key ABSENT on a document whose bytes are here', async () => {
    // Absent, not `undefined`: `structuredClone` preserves an
    // undefined-valued key and `toEqual` cannot tell the two apart, so the
    // assertion is written the one way that can.
    await seedLocal({ documents: [DOCS[0]], blobsFor: ['d1'] });
    const scan = await scanLocalData();
    expect('warning' in scan.records.documents[0]).toBe(false);
  });

  it('reports a store it could not read, and does NOT report zero for it', async () => {
    // Zero and unreadable are different facts, and this is the exact place
    // where confusing them produces the CLAUDE.md defect: an empty library
    // indistinguishable from a fresh install.
    await seedEverything();
    const scan = await scanLocalData(failingStore('reviews'));
    expect(scan.unreadable).toEqual(['reviews']);
    expect(scan.totals.reviews).toBeUndefined();
    expect('reviews' in scan.totals).toBe(false);
    // …and the other six were still read, so a single bad store does not
    // cost a firm the rest of its library.
    expect(scan.totals.matters).toBe(2);
  });

  it('surfaces DbBlockedError as itself, so the screen can say "close your other tabs"', async () => {
    const err = await scanLocalData(() => Promise.reject(new DbBlockedError()))
      .catch((e: unknown) => e);
    expect(describeLoadError(err, 'fallback')).toMatch(/another tab/i);
  });

  it('reports an EMPTY browser as empty, distinctly from a browser it could not read', async () => {
    const empty = await scanLocalData();
    expect(empty.isEmpty).toBe(true);
    expect(empty.unreadable).toEqual([]);

    // The other half, and the half that matters. This browser looks
    // identical to the one above on every count it managed to take — every
    // readable store is empty — and it is NOT empty: nobody knows how many
    // reviews are in it. Offering "there is nothing here to move" over that
    // is the founding defect arriving at the migration screen, so the case
    // is deliberately seeded with nothing, which is the only shape that can
    // tell the two apart.
    const broken = await scanLocalData(failingStore('reviews'));
    expect(broken.isEmpty).toBe(false);
    expect(broken.unreadable).toEqual(['reviews']);
  });

  it('estimates the total bytes, so a person is not surprised by a 400 MB upload', async () => {
    await seedEverything();
    expect((await scanLocalData()).totalBytes).toBe(6000);
  });

  it('does not count the bytes of a document whose file is not here', async () => {
    await seedLocal({ documents: DOCS, blobsFor: ['d1'] });
    expect((await scanLocalData()).totalBytes).toBe(1000);
  });
});
