import { blobKeyFor, type BlobStore, type StoredBlob } from '../../src/blob/store.ts';

/**
 * An in-memory `BlobStore` that records what it was asked to do.
 *
 * `blobStore.compose.test.ts` proves the REAL store against real Azurite,
 * and `cascade.compose.test.ts` proves the cascade reaches real bytes. This
 * one exists for the questions neither can answer cheaply: what ORDER the
 * route wrote in, and what it did when a delete failed. A test that needs a
 * put to have already happened at the moment an insert throws cannot ask
 * Azurite that without a fault injector Azurite does not have.
 *
 * Deliberately NOT a second implementation of `AzureBlobStore`'s semantics:
 * the two properties it copies are the two the routes depend on — `get`
 * answers `null` for a missing key rather than throwing, and `delete`
 * resolves whether or not the key was there — and both are asserted against
 * the real store next door, so a drift between them fails there.
 */
export interface MemoryBlobStore extends BlobStore {
  /** Every key currently held, sorted. */
  keys(): string[];
  /** Makes `delete` throw for these keys, as an unreachable or refusing
   *  store does. The cascade must still attempt every other key. */
  failDeletesFor(...keys: string[]): void;
  /** The keys `delete` was CALLED with, in order — including the ones that
   *  threw, which is how "it did not stop at the first failure" is asserted
   *  rather than inferred from what survived. */
  deleteCalls: string[];
  raw: Map<string, StoredBlob>;
}

export function memoryBlobStore(seed: Iterable<[string, StoredBlob]> = []): MemoryBlobStore {
  const raw = new Map<string, StoredBlob>(seed);
  const failing = new Set<string>();
  const deleteCalls: string[] = [];
  return {
    raw,
    deleteCalls,
    keys: () => [...raw.keys()].sort(),
    failDeletesFor: (...keys: string[]) => keys.forEach(k => failing.add(k)),
    async put(key, bytes, mime) {
      // A COPY, so a caller reusing its buffer cannot rewrite what this
      // store claims to hold — the same reason `saveReview` deep-clones.
      raw.set(key, { bytes: Buffer.from(bytes), mime });
    },
    async get(key) {
      const found = raw.get(key);
      return found ? { bytes: Buffer.from(found.bytes), mime: found.mime } : null;
    },
    async delete(key) {
      deleteCalls.push(key);
      if (failing.has(key)) throw new Error(`storage refused to delete ${key}`);
      raw.delete(key);
    },
    async list(prefix) {
      return [...raw.keys()].filter(k => k.startsWith(prefix)).sort();
    },
    async ensureContainer() { /* nothing to create */ },
  };
}

export { blobKeyFor };
