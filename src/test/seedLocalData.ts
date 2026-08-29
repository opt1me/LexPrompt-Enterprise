import { Blob as NodeBlob } from 'node:buffer';
import { openDB, type IDBPDatabase } from 'idb';
import { DB_NAME, DB_VERSION, PROFILE_KEY, STORES, type LexPromptDB } from '../lib/db/schema';
import { upgradeSchema } from '../lib/db/open';
import type {
  Changeset, Collection, DocumentRecord, Matter, Playbook, PlaybookVersion, Review, UserProfile,
} from '../types';

/**
 * Seeds a browser-local database for the uploader's tests, WITHOUT going
 * through `getDb()`.
 *
 * From Task 23 `getDb()` returns a read-only handle that throws on any
 * `'readwrite'` transaction — deliberately, and enforced rather than agreed.
 * A test that has to put a firm's data into the browser before the uploader
 * reads it out therefore cannot use it, and this helper opens the same
 * database directly instead. It shares `upgradeSchema` with `open.ts` rather
 * than restating the store list, so a store added to the app cannot go
 * missing from the fixture and let the uploader's tests pass against a
 * database shaped unlike a user's.
 *
 * ## Which `Blob`
 *
 * `node:buffer`'s, and only here. Blobs do not round-trip through
 * `fake-indexeddb` with jsdom's `Blob` — Node's `structuredClone` silently
 * mangles it to `{}` — so anything STORED has to be Node's. (A Blob that
 * gets PARSED, by `jszip` or anything else reading bytes, needs jsdom's; the
 * two cases genuinely conflict and CLAUDE.md documents both.) The uploader
 * only ever reads these back and hands them to `FormData`, so Node's is the
 * right one throughout this file.
 */

export async function openSeedDb(): Promise<IDBPDatabase<LexPromptDB>> {
  return openDB<LexPromptDB>(DB_NAME, DB_VERSION, { upgrade: upgradeSchema });
}

export interface SeedShape {
  matters?: Partial<Matter>[];
  documents?: Partial<DocumentRecord>[];
  /** Document ids to store bytes for. A document NOT named here is a record
   *  that outlived its file — the state `getDocumentBlob` answers `null` for
   *  and the scan has to warn about. */
  blobsFor?: string[];
  collections?: Partial<Collection>[];
  playbooks?: Partial<Playbook>[];
  playbookVersions?: Partial<PlaybookVersion>[];
  reviews?: Partial<Review>[];
  changesets?: Partial<Changeset>[];
  profile?: UserProfile;
}

export async function seedLocal(shape: SeedShape): Promise<void> {
  const db = await openSeedDb();
  try {
    for (const m of shape.matters ?? []) await db.put(STORES.matters, m as Matter);
    for (const d of shape.documents ?? []) await db.put(STORES.documents, d as DocumentRecord);
    for (const id of shape.blobsFor ?? []) {
      await db.put(STORES.blobs, {
        documentId: id,
        bytes: new NodeBlob([`bytes for ${id}`]) as unknown as Blob,
        mime: 'application/pdf',
      });
    }
    for (const c of shape.collections ?? []) await db.put(STORES.collections, c as Collection);
    for (const p of shape.playbooks ?? []) await db.put(STORES.playbooks, p as Playbook);
    for (const v of shape.playbookVersions ?? []) {
      await db.put(STORES.playbookVersions, v as PlaybookVersion);
    }
    for (const r of shape.reviews ?? []) await db.put(STORES.reviews, r as Review);
    for (const c of shape.changesets ?? []) await db.put(STORES.changesets, c as Changeset);
    if (shape.profile) await db.put(STORES.profile, shape.profile, PROFILE_KEY);
  } finally {
    db.close();
  }
}

/** Everything in the local database, for the "DELETES NOTHING" assertion.
 *  Blobs are reduced to their ids and sizes — two Blob instances are never
 *  `toEqual` one another, and what that test is actually about is whether
 *  the bytes are still there. */
export async function dumpLocal(): Promise<Record<string, unknown>> {
  const db = await openSeedDb();
  try {
    const blobs = await db.getAll(STORES.blobs);
    return {
      matters: await db.getAll(STORES.matters),
      documents: await db.getAll(STORES.documents),
      blobs: blobs.map(b => ({ documentId: b.documentId, size: b.bytes.size, mime: b.mime })),
      collections: await db.getAll(STORES.collections),
      playbooks: await db.getAll(STORES.playbooks),
      playbookVersions: await db.getAll(STORES.playbookVersions),
      reviews: await db.getAll(STORES.reviews),
      changesets: await db.getAll(STORES.changesets),
    };
  } finally {
    db.close();
  }
}
