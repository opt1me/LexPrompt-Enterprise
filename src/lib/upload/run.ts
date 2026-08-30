import { ModelError } from '@lexprompt/core';
import { getDb } from '../db/open';
import { STORES } from '../db/schema';
import { getProfile } from '../db/profile';
import { getMatter, saveMatter } from '../db/matters';
import { addDocument, getDocument, migrateDocumentRecord } from '../db/documents';
import { getCollection, saveCollection } from '../db/collections';
import { getPlaybook, publishAndPoint, savePlaybook } from '../db/playbooks';
import { listVersions } from '../db/playbookVersions';
import { migratePlaybookRecord } from '../db/playbookMigration';
import { getReview, importReview } from '../db/reviews';
import { getChangeset, saveChangeset } from '../db/changesets';
import { migrateReviewRecord } from '../db/reviewMigration';
import { rewriteAttributionCounted } from './attribution';
import { seal, type RecordOutcome, type StoreName, type UploadReport } from './report';
import type { LocalDataScan, OpenDb, ScannedRecord } from './scan';
import type {
  Changeset, Collection, DocumentRecord, Matter, Playbook, PlaybookDraft, PlaybookVersion, Review,
} from '../../types';

/**
 * Moving this browser's data to the server, and reporting BY NAME what did
 * not move (§13.1).
 *
 * ## Two rules shape every line here
 *
 * **It uses the ordinary write paths.** `saveMatter`, `addDocument`,
 * `saveCollection`, `savePlaybook`, `publishAndPoint`, `saveReview`,
 * `saveChangeset` — the same functions the app itself calls, not a bulk
 * import endpoint. A second write path would be a second set of validations
 * and a second set of constraints, and the uploaded data would be exactly
 * the data that never went through the checks. It is also the only way this
 * function can honestly claim to have moved something: it moved it by the
 * path the app reads back.
 *
 * **It never deletes the local copy.** §13.1, S13, and `CLAUDE.md`'s "never
 * delete what you cannot read". Nothing in this module opens a writable
 * IndexedDB transaction — `getDb()` would refuse one — so the local database
 * is left byte-for-byte as it was, and `run.test.ts` proves it by dumping the
 * database before and after.
 *
 * ## The order, and where the brief was wrong
 *
 * Task 22's brief specifies `matters -> collections -> documents -> …`. The
 * shipped API refuses that: `PUT /v1/collections/:id` checks that every
 * document a collection names is already a `kind = 'matter'` document in the
 * same matter, and answers 404 naming the missing member when it is not.
 * Uploading collections first would refuse every collection a firm has,
 * blaming data that is fine. Documents therefore come second and collections
 * third — see `UPLOAD_STORES` for the full note.
 *
 * ## Version ids are MINTED BY THE SERVER, so ids have to be remapped
 *
 * `publishAndPoint` allocates a fresh `uid()` for every version and a version
 * number from `max(version_number) + 1` — immutability is a property of how
 * ids are allocated, not a check that could be forgotten. So a local
 * version's id does not survive the move, and two foreign keys point at one:
 * `review.playbook_version_id` and `changeset.from_version_id`. Both are
 * rewritten through `versionIds` below. Getting this wrong produces a wall of
 * refusals on reviews and changesets that are perfectly good, which is why
 * versions are uploaded before either.
 *
 * ## A second run confirms rather than duplicates
 *
 * Every write is the PUT-as-upsert the app uses, and a row that already
 * exists answers `conflict` (a local record carries no `version`, so the
 * route reads the write as a create and refuses to overwrite). This module
 * then RE-READS the record: present in this workspace means it is already
 * there (`skipped-already-there`, which counts as accounted for); absent
 * means the id belongs to somewhere this workspace cannot see, which is a
 * real failure and is reported as one.
 *
 * Versions cannot use that trick, because their ids change. They are matched
 * on `(playbookId, version number)` instead — a pair that is unique by
 * construction, and both copies of which came from this same browser.
 */

/** A local version id -> the id the server minted for it. */
type VersionIds = Map<string, string>;

export interface RunUploadOptions {
  /** How to read the local database. `getDb` in the app; a wrapper in the
   *  tests. READ-ONLY, always. */
  openDb?: OpenDb;
  /** Called after every record, so the screen can show progress on a library
   *  that takes minutes. Handed a SEALED report, so a caller that renders it
   *  mid-run renders an honest partial one — `complete` is false while
   *  outcomes are still missing. */
  onProgress?: (report: UploadReport) => void;
}

/** The message a failure carries onto the report. The API's own where there
 *  is one: it knows things the browser does not, and "there is no matter m3
 *  to add this document to" is actionable in a way that "upload failed" is
 *  not. */
function reasonOf(e: unknown): string {
  if (e instanceof ModelError) return e.message;
  return e instanceof Error ? e.message : String(e);
}

/** A conflict is the ONE refusal that might mean "this is already here".
 *  Everything else is a failure. */
function isConflict(e: unknown): boolean {
  return e instanceof ModelError && (e.code === 'conflict' || e.status === 409);
}

/**
 * The version re-published as itself.
 *
 * NOT `draftFromVersion`, deliberately. That function drops `changeSummary`
 * because its job is "start the NEXT version from this one", where carrying
 * the summary over would label a new version with the previous one's reason.
 * Here the version being published IS the one whose summary this is, so
 * dropping it would erase what a firm's version history says about itself —
 * and would then be refused outright by the route, which requires a summary
 * on every version after the first.
 */
function draftOf(version: PlaybookVersion): PlaybookDraft {
  const draft: PlaybookDraft = {
    name: version.name,
    contractType: version.contractType,
    systemPrompt: version.systemPrompt,
    formatPrompt: version.formatPrompt,
    clauses: structuredClone(version.clauses),
    changeSummary: version.changeSummary ?? '',
  };
  if (version.riskTolerance !== undefined) draft.riskTolerance = version.riskTolerance;
  return draft;
}

/** `_seq` is IndexedDB's write-sequence tiebreak and `version` is the
 *  server's optimistic-concurrency token. Neither belongs on a record being
 *  created: `_seq` means nothing to a route, and a `version` claims "I read
 *  this row at revision N", which a record that has never been on the server
 *  cannot truthfully say. */
function forCreate<T extends object>(record: T): T {
  const { _seq, version, ...rest } = record as T & { _seq?: unknown; version?: unknown };
  void _seq; void version;
  return rest as T;
}

export async function runUpload(
  scan: LocalDataScan,
  options: RunUploadOptions = {},
): Promise<UploadReport> {
  const openDb = options.openDb ?? getDb;
  const startedAt = Date.now();
  const outcomes: RecordOutcome[] = [];
  let unmapped = 0;

  // Who is doing the uploading. This REJECTS rather than falling back: every
  // record about to move carries an attribution, and a migration that cannot
  // say who ran it must not run. `getProfile()` no longer mints a person for
  // exactly this reason.
  const uploader = await getProfile();
  const local = scan.localProfileId;

  const expected: Partial<Record<StoreName, number>> = { ...scan.totals };

  const report = (): UploadReport =>
    seal({ startedAt, expected, outcomes, unreadable: scan.unreadable, unmapped });

  function record(outcome: RecordOutcome): void {
    outcomes.push(outcome);
    options.onProgress?.(report());
  }

  /** Rewrites attribution and counts what it could not map. */
  function prepared<T>(value: T): T {
    const out = rewriteAttributionCounted(value, local, uploader.id);
    unmapped += out.unmapped;
    return out.record;
  }

  /**
   * One record, sent by the ordinary write path, with the three answers this
   * module has to keep apart: it moved, it was already there, or it failed
   * and the report says which one it was and why.
   */
  async function send(
    scanned: ScannedRecord,
    write: () => Promise<void>,
    alreadyThere: () => Promise<boolean>,
  ): Promise<boolean> {
    if (scanned.unreadable) {
      // Found, but not readable. Sending whatever could be parsed out of it
      // would put half a record on the server wearing the name of a whole
      // one; the honest answer is a named failure that keeps the report
      // incomplete, with the scan's own explanation as the reason.
      record({
        store: scanned.store, id: scanned.id, label: scanned.label,
        status: 'failed',
        reason: scanned.warning ?? 'This record could not be read, so there was nothing to send.',
      });
      return false;
    }
    try {
      await write();
      record({ store: scanned.store, id: scanned.id, label: scanned.label, status: 'moved' });
      return true;
    } catch (e) {
      if (isConflict(e)) {
        // A conflict on a record with no version is "that id is taken". By
        // whom decides everything: by this workspace's own copy from an
        // earlier run (accounted for), or by something this workspace may
        // not see (a real failure, and the report must not read it as a
        // successful skip).
        let there = false;
        try {
          there = await alreadyThere();
        } catch {
          there = false;
        }
        if (there) {
          record({
            store: scanned.store, id: scanned.id, label: scanned.label,
            status: 'skipped-already-there',
          });
          return true;
        }
      }
      record({
        store: scanned.store, id: scanned.id, label: scanned.label,
        status: 'failed', reason: reasonOf(e),
      });
      return false;
    }
  }

  // ---- 1. Matters ---------------------------------------------------------
  for (const scanned of scan.records.matters) {
    const matter = prepared(forCreate(scanned.record as Matter));
    // eslint-disable-next-line no-await-in-loop
    await send(scanned, () => saveMatter(matter).then(() => undefined),
      async () => (await getMatter(matter.id)) !== null);
  }

  // ---- 2. Documents (before collections — see the note above) -------------
  const db = await openDb();
  for (const scanned of scan.records.documents) {
    const doc = prepared(forCreate(migrateDocumentRecord(scanned.record)));
    let bytes: Blob | null = null;
    try {
      // eslint-disable-next-line no-await-in-loop
      const stored = await db.get(STORES.blobs, doc.id);
      bytes = stored?.bytes ?? null;
    } catch {
      bytes = null;
    }
    if (bytes === null) {
      // The record moves and its extracted text with it — a review's
      // findings and citations are read against that text, and refusing to
      // move the record would take the reviews with it. What does NOT move
      // is a file that is not here to move, and the status says so in its
      // own word rather than in the word "moved". `isComplete` reads
      // `moved-without-bytes` as a gap, so no report carrying one can call
      // itself finished: "3 documents moved" over a document with no file is
      // the blank-CSV-cell defect.
      const empty = { ...doc, byteSize: 0 };
      // eslint-disable-next-line no-await-in-loop
      const ok = await send(scanned, () => addDocument(empty, new Blob([])),
        async () => (await getDocument(doc.id)) !== null);
      if (ok) {
        // Overwrite the optimistic outcome `send` recorded with the honest
        // one. Written this way round so there is exactly one place that
        // decides what a successful write is called.
        const last = outcomes[outcomes.length - 1];
        last.status = 'moved-without-bytes';
        last.reason = 'Its original file was not in this browser, so only the text already '
          + 'extracted from it moved. Add the file to the matter again to restore it.';
        options.onProgress?.(report());
      }
      continue;
    }
    // eslint-disable-next-line no-await-in-loop
    await send(scanned, () => addDocument(doc, bytes),
      async () => (await getDocument(doc.id)) !== null);
  }

  // ---- 3. Collections -----------------------------------------------------
  for (const scanned of scan.records.collections) {
    const collection = prepared(forCreate(scanned.record as Collection));
    // eslint-disable-next-line no-await-in-loop
    await send(scanned, () => saveCollection(collection).then(() => undefined),
      async () => (await getCollection(collection.id)) !== null);
  }

  // ---- 4 & 5. Playbooks and their versions --------------------------------
  //
  // Handled together rather than as two passes, because on the server they
  // ARE one thing: `publishAndPoint` writes the identity and the version in
  // one transaction, precisely so a version can never be orphaned from the
  // playbook that owns it. Two passes here would have to write the identity
  // twice and would publish into a `current_version_id` the first pass had
  // just set, which is the orphan `publishAndPoint` exists to prevent
  // rebuilt across a network. The outcomes still land in their own stores,
  // so the report reads exactly as if there had been two passes.
  const versionIds: VersionIds = new Map();
  const versionsByPlaybook = new Map<string, ScannedRecord[]>();
  for (const scanned of scan.records.playbookVersions) {
    const v = scanned.record as PlaybookVersion;
    const list = versionsByPlaybook.get(v.playbookId) ?? [];
    list.push(scanned);
    versionsByPlaybook.set(v.playbookId, list);
  }

  for (const scanned of scan.records.playbooks) {
    // eslint-disable-next-line no-await-in-loop
    await uploadPlaybook(scanned, versionsByPlaybook.get(scanned.id) ?? []);
  }

  // A version whose playbook is not in the playbooks store at all. It cannot
  // be published (there is no identity to publish it against and inventing
  // one would put a playbook in a firm's library that nobody created), so it
  // is reported as a failure BY NAME rather than quietly dropped — which is
  // the only way anyone would ever find out.
  for (const [playbookId, list] of versionsByPlaybook) {
    if (scan.records.playbooks.some(p => p.id === playbookId)) continue;
    for (const scanned of list) {
      record({
        store: 'playbookVersions', id: scanned.id, label: scanned.label, status: 'failed',
        reason: `Its playbook (${playbookId}) is not in this browser, so there is nothing for `
          + 'this version to belong to.',
      });
    }
  }

  async function uploadPlaybook(scanned: ScannedRecord, versions: ScannedRecord[]): Promise<void> {
    if (scanned.unreadable) {
      // `send` refuses it and records the failure; nothing below may run,
      // because `migratePlaybookRecord` would happily turn an unreadable
      // record into an "Untitled playbook" with no clauses and upload that.
      await send(scanned, () => Promise.resolve(), () => Promise.resolve(false));
      return;
    }
    const { playbook: identity, version: preD } =
      migratePlaybookRecord(prepared(forCreate(scanned.record as Playbook)));

    if (versions.length === 0) {
      // Either a playbook with no content at all, or a PRE-D one whose
      // clauses are still on the identity record. The second is why
      // `migratePlaybookRecord` is called here rather than the raw record
      // being sent: `playbooks.ts`'s repair-on-read is the only thing that
      // knows how to turn a v1 template into a publishable draft, and Task 23
      // takes the startup conversion away, so this is the last reader of it.
      await send(
        scanned,
        preD
          ? () => publishAndPoint(identity, preD, uploader.id).then(() => undefined)
          : () => savePlaybook(identity).then(() => undefined),
        async () => (await getPlaybook(identity.id)) !== null,
      );
      return;
    }

    // Ascending, because the server allocates `max(version_number) + 1` and
    // a firm's version numbering is part of what a review's history says.
    const ordered = [...versions].sort(
      (a, b) => (a.record as PlaybookVersion).version - (b.record as PlaybookVersion).version);

    // What is already there from an earlier run, matched on version NUMBER
    // because the id changed when the server minted it.
    let already = new Map<number, string>();
    try {
      already = new Map((await listVersions(identity.id)).map(v => [v.version, v.id]));
    } catch {
      // A playbook that is not on the server yet answers "no such playbook".
      // Nothing is already there, which is the right assumption and the one
      // the publishes below will confirm or refuse for themselves.
    }

    let stopped: string | null = null;
    let saved: Playbook | null = null;
    for (const scannedVersion of ordered) {
      const version = scannedVersion.record as PlaybookVersion;
      if (stopped) {
        // A version that could not be published leaves every LATER version
        // of that playbook unpublishable at its own number — the server
        // allocates the next one in sequence, so publishing v3 after v2
        // failed would file it as v2 and rewrite a firm's version history
        // silently. Refusing loudly, by name, is the only honest answer.
        record({
          store: 'playbookVersions', id: scannedVersion.id, label: scannedVersion.label,
          status: 'failed',
          reason: `Not attempted: ${stopped} could not be published, and publishing this one `
            + 'afterwards would file it under that version\'s number.',
        });
        continue;
      }
      const there = already.get(version.version);
      if (there !== undefined) {
        versionIds.set(version.id, there);
        record({
          store: 'playbookVersions', id: scannedVersion.id, label: scannedVersion.label,
          status: 'skipped-already-there',
        });
        continue;
      }
      try {
        // eslint-disable-next-line no-await-in-loop
        const published = await publishAndPoint(identity, draftOf(version), uploader.id);
        versionIds.set(version.id, published.version.id);
        saved = published.playbook;
        record({
          store: 'playbookVersions', id: scannedVersion.id, label: scannedVersion.label,
          status: 'moved',
        });
      } catch (e) {
        stopped = scannedVersion.label;
        record({
          store: 'playbookVersions', id: scannedVersion.id, label: scannedVersion.label,
          status: 'failed', reason: reasonOf(e),
        });
      }
    }

    if (saved === null) {
      if (stopped) {
        // Nothing published at all, so the identity may not exist either.
        // Written on its own so a playbook whose versions all failed is
        // still reachable rather than lost with them.
        await send(scanned, () => savePlaybook(identity).then(() => undefined),
          async () => (await getPlaybook(identity.id)) !== null);
        return;
      }
      // Every version was already there, which is the SECOND RUN of a
      // partial first one — the identity went up with the first version and
      // its draft (if any) was restored then. Confirmed rather than assumed:
      // reporting "already there" without looking would be the report
      // claiming something it did not check.
      let there = false;
      try {
        there = (await getPlaybook(identity.id)) !== null;
      } catch {
        there = false;
      }
      record({
        store: 'playbooks', id: scanned.id, label: scanned.label,
        ...(there
          ? { status: 'skipped-already-there' as const }
          : { status: 'failed' as const,
            reason: 'Its versions are on the server but the playbook itself is not, so nothing '
              + 'points at them.' }),
      });
      return;
    }

    // PUBLISHING CONSUMES THE DRAFT — the route sets `draft` to NULL — so an
    // unpublished working copy has to be written back AFTERWARDS, carrying
    // the version token the last publish returned. Doing it before would
    // write a draft the next publish immediately erased.
    if (identity.draft && saved) {
      const restore = { ...saved, draft: identity.draft };
      // eslint-disable-next-line no-await-in-loop
      await send(scanned, () => savePlaybook(restore).then(() => undefined),
        async () => (await getPlaybook(identity.id)) !== null);
      return;
    }
    record({ store: 'playbooks', id: scanned.id, label: scanned.label, status: saved ? 'moved' : 'failed',
      ...(saved ? {} : { reason: 'Its versions could not be published.' }) });
  }

  // ---- 6. Reviews ---------------------------------------------------------
  for (const scanned of scan.records.reviews) {
    const review = prepared(forCreate(migrateReviewRecord(scanned.record))) as Review;
    const localVersionId = review.playbookVersionId;
    const mapped = localVersionId === undefined ? undefined : versionIds.get(localVersionId);
    let note: string | undefined;
    const body: Review = { ...review };
    if (localVersionId !== undefined) {
      if (mapped !== undefined) {
        body.playbookVersionId = mapped;
      } else {
        // The pointer named a version this browser no longer holds — R-D15's
        // "recorded, then deleted", kept on read by `reviewMigration.ts`.
        // Sending it would be refused by the route's own foreign-key check
        // and would cost the whole review, verifications included, to save a
        // pointer that was already dangling before the move. The review moves
        // WHOLE and the report says what changed about it.
        delete body.playbookVersionId;
        note = 'It pointed at a playbook version that is not in this browser either, so it '
          + 'moved without that pointer. Its playbook snapshot — what the review actually ran '
          + 'against — moved intact.';
      }
    }
    // eslint-disable-next-line no-await-in-loop
    // `importReview`, NOT `saveReview`. A whole-review save carries no
    // findings any more (the column is frozen and each finding is its own
    // row), and an import is the one write that must carry them: an exported
    // review's findings hold the verifications, rejection reasons and notes
    // this uploader exists to move. The server writes them as rows, and
    // accepts them only for a review this workspace does not already have.
    const ok = await send(scanned, () => importReview(body).then(() => undefined),
      async () => (await getReview(body.id)) !== null);
    if (ok && note) {
      outcomes[outcomes.length - 1].reason = note;
      options.onProgress?.(report());
    }
  }

  // ---- 7. Changesets ------------------------------------------------------
  for (const scanned of scan.records.changesets) {
    const changeset = prepared(forCreate(scanned.record as Changeset));
    const body: Changeset = {
      ...changeset,
      // Left AS IS when it cannot be remapped, rather than dropped:
      // `from_version_id` is `not null references playbook_version(id)`, so
      // an id naming nothing is refused by Postgres and the refusal — turned
      // into a sentence a person can read by the API's error envelope —
      // becomes this changeset's reason on the report. Dropping it would
      // fail a NOT NULL with a message about a column instead.
      fromVersionId: versionIds.get(changeset.fromVersionId) ?? changeset.fromVersionId,
    };
    if (changeset.publishedVersionId !== undefined) {
      body.publishedVersionId =
        versionIds.get(changeset.publishedVersionId) ?? changeset.publishedVersionId;
    }
    // eslint-disable-next-line no-await-in-loop
    await send(scanned, () => saveChangeset(body).then(() => undefined),
      async () => (await getChangeset(body.id)) !== null);
  }

  return report();
}
