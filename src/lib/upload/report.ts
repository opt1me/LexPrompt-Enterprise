/**
 * What the uploader reports, and the one function that decides whether it
 * may call itself finished.
 *
 * §13.1: *"a single screen … that reads the local IndexedDB, uploads each
 * matter, document (bytes and text), collection, review, playbook, version
 * and changeset, and reports exactly what it moved and what it could not,
 * by name. A partial migration says so; it never reports success over a
 * gap."*
 *
 * `CLAUDE.md`'s opening list carries the shipped instance of the defect this
 * file exists against: *"a failed storage migration rendering an empty
 * library, indistinguishable from a fresh install."* Every type below is
 * shaped so that the failure has somewhere to be said out loud:
 *
 *  - the unit is ONE RECORD with a `label`, never a per-store counter,
 *    because "3 of 4 matters moved" is unusable without which one;
 *  - `expected` comes from the SCAN, taken before anything moved, because a
 *    count accumulated during the upload can only ever report what the
 *    upload managed to reach;
 *  - `unreadable` is a THIRD state beside moved and failed, because a store
 *    that could not be read holds an unknown number of records and reporting
 *    zero for it is precisely the empty-versus-broken confusion above;
 *  - `complete` is DERIVED by `isComplete` below and never assigned, because
 *    a flag somebody sets is a flag somebody sets wrongly.
 */

/**
 * The stores the uploader moves, in the order it moves them.
 *
 * ## The order is a foreign-key order, and the brief had it wrong
 *
 * Task 22's brief specifies `matters -> collections -> documents -> …`.
 * The shipped API refuses that: `PUT /v1/collections/:id` checks that every
 * document a collection NAMES (its `baseDocumentId` and every
 * `variesDocumentIds` entry) is already a `kind = 'matter'` document in the
 * same matter, and answers 404 naming the missing member when it is not
 * (`apps/api/src/routes/collections.ts`, "Every document this collection
 * NAMES must be in that same matter"). Uploading collections before their
 * members would refuse every collection in a firm's library, blaming data
 * that is fine. Documents therefore come SECOND and collections THIRD.
 *
 * The reverse dependency does not exist: `document.collection_id` carries no
 * foreign key (deliberately — grouping writes the collection record and each
 * member's `role` non-atomically), and `POST /v1/documents` does not check
 * it, so a document may arrive naming a collection that is still to come.
 *
 * `playbookVersions` before `reviews` and `changesets` for the same kind of
 * reason, one table over: `review.playbook_version_id` and
 * `changeset.from_version_id` are real foreign keys into `playbook_version`.
 *
 * `blobs` is not here. It is not a record type a person has a name for — it
 * is a document's bytes, moved in the same request as the document, and its
 * absence is reported on the DOCUMENT's outcome (`moved-without-bytes`)
 * rather than as a record of its own that failed.
 *
 * `profile` is not here either: the signed-in `app_user` is who the server
 * says it is, and a browser's local profile is not a record to move (see
 * `src/lib/db/profile.ts` — `getProfile()` no longer mints a person).
 */
export const UPLOAD_STORES = [
  'matters',
  'documents',
  'collections',
  'playbooks',
  'playbookVersions',
  'reviews',
  'changesets',
] as const;

export type StoreName = (typeof UPLOAD_STORES)[number];

/** What a person would call this kind of thing, for a heading on the report
 *  screen. Singular/plural pairs rather than a store name: "playbookVersions"
 *  is a table, not a word anyone would say. */
export const STORE_LABELS: Record<StoreName, { one: string; many: string }> = {
  matters: { one: 'matter', many: 'matters' },
  documents: { one: 'document', many: 'documents' },
  collections: { one: 'collection', many: 'collections' },
  playbooks: { one: 'playbook', many: 'playbooks' },
  playbookVersions: { one: 'playbook version', many: 'playbook versions' },
  reviews: { one: 'review', many: 'reviews' },
  changesets: { one: 'changeset', many: 'changesets' },
};

export type RecordStatus = 'moved' | 'moved-without-bytes' | 'failed' | 'skipped-already-there';

/**
 * What happened to ONE record.
 *
 * The unit the report is built from, because §13.1's requirement is "by
 * name" and a per-store counter cannot be.
 */
export interface RecordOutcome {
  store: StoreName;
  id: string;
  /** What a person would call it: a matter's name, a document's filename, a
   *  review's playbook and date. An id alone is not a name. */
  label: string;
  status: RecordStatus;
  /** Present on `'failed'` and on `'moved-without-bytes'`. The API's own
   *  message where there is one — it knows things the browser does not
   *  ("there is no matter m3 to add this document to" is actionable in a way
   *  that "upload failed" is not). */
  reason?: string;
}

export interface UploadReport {
  startedAt: number;
  finishedAt?: number;
  /**
   * From the SCAN, not from the upload. This is what makes "3 of 4" a
   * sentence the report is entitled to say.
   *
   * PARTIAL, not `Record<StoreName, number>` as Task 21's brief has it: a
   * store the scan could not read has no count, and giving it `0` here would
   * put the empty-versus-broken confusion into the one structure written to
   * prevent it. The key is ABSENT for such a store, and `unreadable` names
   * it instead.
   */
  expected: Partial<Record<StoreName, number>>;
  outcomes: RecordOutcome[];
  /** A store the scan could not read at all. Its records are neither moved
   *  nor failed — they are unknown, and that is a third thing. */
  unreadable: StoreName[];
  /**
   * An attribution this uploader could not map to the signed-in user: an id
   * that is neither the local profile's nor empty. There has only ever been
   * one local profile, so it should be zero; when it is not, the honest
   * thing is to leave the id alone and say so, not to sweep it into the
   * uploading user's identity (P16).
   *
   * Deliberately NOT part of `complete`: the record moved, and every field
   * of it arrived. What did not arrive is a name for whoever wrote part of
   * it, which the screen states separately rather than folding into "some of
   * your data did not move".
   */
  unmapped: number;
  /** True only when every expected record moved AND nothing was unreadable
   *  AND no document moved without its bytes. DERIVED by `isComplete`,
   *  never set. */
  complete: boolean;
}

/**
 * The whole of §13.1's *"never reports success over a gap"*, as one pure
 * function with nothing else in it.
 *
 * Three near-misses, each of which must answer `false`:
 *
 *  1. **A record failed.** Obvious, and the only one a naive implementation
 *     gets right.
 *  2. **A store was unreadable.** Nothing failed, because nothing was
 *     attempted — and that is worse, not better. An unknown number of
 *     matters is not zero matters.
 *  3. **A document moved without its bytes.** Its row is on the server and
 *     its text with it, so every count reconciles and every status begins
 *     with the word "moved". A report that called this complete would be the
 *     blank-CSV-cell defect exactly: technically true, read as finished.
 *
 * And the fourth, which is not a near-miss but an arithmetic one: fewer
 * outcomes than the scan expected. A record the run never reached at all
 * produces no outcome of any kind, so counting only failures would report a
 * run that crashed half way as complete.
 */
export function isComplete(
  expected: Partial<Record<StoreName, number>>,
  outcomes: readonly RecordOutcome[],
  unreadable: readonly StoreName[],
): boolean {
  if (unreadable.length > 0) return false;
  for (const outcome of outcomes) {
    if (outcome.status !== 'moved' && outcome.status !== 'skipped-already-there') return false;
  }
  for (const store of UPLOAD_STORES) {
    const want = expected[store];
    // A store with no expected count and no `unreadable` entry never
    // existed in this browser; nothing to reconcile.
    if (want === undefined) continue;
    const got = outcomes.filter(o => o.store === store).length;
    if (got !== want) return false;
  }
  return true;
}

/** Seals a report: stamps `finishedAt` and computes `complete` from what is
 *  actually in it. The ONLY place `complete` is produced — `runUpload` never
 *  assigns the field, which is what makes Task 22's first mutation
 *  (`complete` as a value the run sets) a change to this file rather than an
 *  invisible one inside a loop. */
export function seal(report: Omit<UploadReport, 'complete' | 'finishedAt'>, now = Date.now()): UploadReport {
  return {
    ...report,
    finishedAt: now,
    complete: isComplete(report.expected, report.outcomes, report.unreadable),
  };
}

/** `2 of 3 matters`, or `2 matters` when nothing was expected to be counted
 *  against. Used by the screen; here so the wording has one home rather than
 *  one per heading (the `verificationLabel` rule, applied before the second
 *  copy exists). */
export function movedLine(store: StoreName, report: UploadReport): string {
  const words = STORE_LABELS[store];
  const want = report.expected[store];
  const got = report.outcomes.filter(
    o => o.store === store && (o.status === 'moved' || o.status === 'skipped-already-there'),
  ).length;
  const noun = want === 1 ? words.one : words.many;
  if (want === undefined) return `${got} ${got === 1 ? words.one : words.many} (this store could not be read)`;
  return `${got} of ${want} ${noun}`;
}
