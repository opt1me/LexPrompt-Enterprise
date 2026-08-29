import type { IDBPDatabase, IDBPObjectStore, StoreNames } from 'idb';
import { getDb } from './open';
import { STORES, type LexPromptDB } from './schema';
import { seqOf } from './seq';
import { migratePlaybookRecord } from './playbookMigration';
import {
  SCHEMA_VERSION,
  type Playbook, type PlaybookDraft, type PlaybookVersion, type UserProfile,
} from '../../types';
import { uid } from '../uid';

/** The exact key v1 wrote its templates under (`src/lib/storage.ts`,
 *  pre-redesign — see `git show 457b6fc:src/lib/storage.ts`). Read directly;
 *  v1's module is gone. */
const V1_TEMPLATES_KEY = 'lexprompt.templates.v2';

/** A dedicated key inside the existing `profile` object store (an
 *  out-of-line-keyed store — any string key is valid, see `schema.ts`).
 *  Deliberately distinct from `PROFILE_KEY` ('local'), which holds the
 *  user's actual profile record, so the two can never collide. */
const MIGRATION_FLAG_KEY = 'migration:v1-templates';

/** Sub-project D's own flag, deliberately SEPARATE from the one above.
 *  Reusing `MIGRATION_FLAG_KEY` would silently skip D's conversion for
 *  every user sub-project A already migrated — the flag says "A's import
 *  ran", not "this record is current" (R-D7). The `migration:<name>`
 *  convention already anticipated more than one. */
const PLAYBOOK_VERSIONS_FLAG_KEY = 'migration:d-playbook-versions';

/** Which of `migrateIfNeeded`'s two steps a failure came from. Present on
 *  a `failed` result only, and absent when the failure happened before
 *  either step could be identified.
 *
 *  It exists because the blocking screen has to tell the user where their
 *  data still is, and the two steps have DIFFERENT answers: step 1 reads
 *  v1's localStorage and is safe because that source is never deleted;
 *  step 2 reads and writes IndexedDB and is safe because each playbook's
 *  conversion is one all-or-nothing transaction. Naming the wrong one is
 *  reassurance that happens to be true pointing at the wrong place, which
 *  misdirects anyone who acts on it. */
export type MigrationPhase = 'v1' | 'versions';

export interface MigrationResult {
  status: 'not-needed' | 'migrated' | 'failed';
  count: number;
  error?: string;
  phase?: MigrationPhase;
}

/** The value stored at `MIGRATION_FLAG_KEY`. Its presence is what makes
 *  `not-needed` determinable on every later load without re-reading
 *  localStorage at all — see the rule this exists to satisfy in
 *  `migrateIfNeeded`'s first check. */
interface MigrationFlag {
  done: true;
  count: number;
  migratedAt: number;
}

function isMigrationFlag(v: unknown): v is MigrationFlag {
  return !!v && typeof v === 'object' && (v as { done?: unknown }).done === true;
}

// The `profile` store's schema type is `UserProfile` — correctly, since
// that's the only shape every other caller ever puts there. Storing this
// module's own flag record in the same store means going through that
// type at the two points that touch it; the casts are contained to these
// two tiny helpers rather than sprinkled through the migration logic.
async function readFlag(db: Awaited<ReturnType<typeof getDb>>, key: string): Promise<MigrationFlag | undefined> {
  const v = (await db.get(STORES.profile, key)) as unknown;
  return isMigrationFlag(v) ? v : undefined;
}

async function writeFlag(db: Awaited<ReturnType<typeof getDb>>, key: string, count: number): Promise<void> {
  const flag: MigrationFlag = { done: true, count, migratedAt: Date.now() };
  await db.put(STORES.profile, flag as unknown as UserProfile, key);
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** The app's one-time, startup-ordered migrations, in order:
 *
 *  1. sub-project A — v1's localStorage templates into the `playbooks`
 *     IndexedDB store.
 *  2. sub-project D — every pre-D playbook into an identity record plus one
 *     published `PlaybookVersion` (R-D7).
 *
 *  Each carries its own durable flag, so a user already migrated by A still
 *  runs D's, and D's runs after A's within a single call — a v1 template
 *  imported by step 1 is converted by step 2 before anything can read it.
 *
 *  Three rules govern every line below:
 *
 *  1. The localStorage source is NEVER deleted here, on any path —
 *     success, partial success, or failure. A later, separate cleanup may
 *     remove it only after a subsequent successful load proves the new
 *     store readable.
 *  2. Idempotent and re-entrant: a tab closed mid-migration must resolve
 *     correctly on the next call, never double-importing. The durable flag
 *     (written only after every record has been accounted for) handles the
 *     common case fast; the per-record existence check below handles a run
 *     that was interrupted before that flag was ever written, AND protects
 *     a playbook the user has since edited in the app from being clobbered
 *     back to its original v1 content by a later, redundant migration
 *     attempt.
 *  3. Failure is loud: an unreadable or partially-written source is
 *     reported as `failed` with a real error message, never silently
 *     folded into `not-needed`.
 */
export async function migrateIfNeeded(): Promise<MigrationResult> {
  // Contract: this function reports failure by RETURNING
  // `{ status: 'failed', ... }`, never by rejecting. Everything below —
  // including `getDb()` itself and the final flag write — runs inside this
  // one try/catch so that a `DbBlockedError`, a quota failure while writing
  // the completion flag, or anything else unanticipated cannot surface as
  // an unhandled rejection. A caller written against `Promise<MigrationResult>`
  // has no reason to `.catch()`; letting this reject at startup — the exact
  // moment a user's v1 playbooks are being moved — would be the worst
  // possible time for that gap to show up. The counters live outside the try
  // so the catch can still report an accurate partial count from a mid-loop
  // failure, per Rule 3; `phase` says which step's count that is, so a
  // failure in one step never reports the other step's progress.
  let importedCount = 0;
  const converted = { count: 0 };
  let phase: MigrationPhase = 'v1';
  try {
    const db = await getDb();

    // --- Step 1 (sub-project A): v1 localStorage -> the playbooks store ---
    //
    // Its own durable flag still short-circuits it entirely for a returning
    // user. What changed in sub-project D is that this no longer RETURNS
    // early on its "nothing to do" paths — Step 2 below has to run whether
    // or not this one did, which is the whole point of giving it a separate
    // flag.
    let v1Status: 'not-needed' | 'migrated' = 'not-needed';
    if (!(await readFlag(db, MIGRATION_FLAG_KEY))) {
      const raw = localStorage.getItem(V1_TEMPLATES_KEY);
      if (raw === null) {
        await writeFlag(db, MIGRATION_FLAG_KEY, 0);
      } else {
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch (e) {
          // Rule 3. An unparseable source is not "nothing to migrate" — it is
          // a migration that cannot proceed. No flag is written, so a fixed or
          // recovered source gets another chance on the next call. Step 2 is
          // deliberately NOT reached: the app renders its migration-blocked
          // screen on this result and nothing reads a playbook until the user
          // retries, so there is nothing to be gained by converting first and
          // everything to be gained by leaving the store exactly as found.
          return { status: 'failed', count: 0, phase, error: `v1 template storage could not be parsed: ${errorMessage(e)}` };
        }

        if (!Array.isArray(parsed)) {
          return { status: 'failed', count: 0, phase, error: 'v1 template storage was not an array.' };
        }

        if (parsed.length === 0) {
          await writeFlag(db, MIGRATION_FLAG_KEY, 0);
        } else {
          for (const entry of parsed) {
            const src = (entry ?? {}) as Partial<Playbook> & Record<string, unknown>;
            const id = typeof src.id === 'string' && src.id ? src.id : uid();
            // Rule 2 (the check that matters). A record already present — from
            // a prior, possibly-interrupted run, or because the user has since
            // edited it in the app — is left exactly as it is. Never
            // unconditionally overwritten with what v1 originally had.
            const existing = await db.get(STORES.playbooks, id);
            if (existing) {
              importedCount++;
              continue;
            }
            // Written in its ORIGINAL pre-D shape, on purpose: Step 2 below
            // is what converts it, and it runs in this same call, so a v1
            // import never lands in the store un-versioned for longer than
            // one migration pass.
            const record = { ...src, id } as unknown as Playbook;
            await db.put(STORES.playbooks, record);
            importedCount++;
          }

          await writeFlag(db, MIGRATION_FLAG_KEY, importedCount);
          v1Status = 'migrated';
        }
      }
    }

    // --- Step 2 (sub-project D, R-D7): playbooks -> identity + v1 --------
    phase = 'versions';
    if (!(await readFlag(db, PLAYBOOK_VERSIONS_FLAG_KEY))) {
      await migratePlaybooksToVersions(db, converted);
      await writeFlag(db, PLAYBOOK_VERSIONS_FLAG_KEY, converted.count);
    }

    // `count` stays the number of playbooks IMPORTED from v1 — it is what
    // `App`'s "Migrated N playbooks." toast reports, and D's conversion
    // touches those same playbooks, so adding the two would double-count
    // them for the one user who hits both in a single load.
    return { status: v1Status, count: importedCount };
  } catch (e) {
    // Rule 3, for every failure either step can hit — a bad `getDb()` open, a
    // per-record write failure, a failed publish, or a failure writing a
    // completion flag after every record succeeded. No flag is written on any
    // of these paths, so a retry resumes: Step 1 recognises its
    // already-written records as present, and Step 2 adopts an already-
    // published version instead of publishing a second one.
    return { status: 'failed', count: phase === 'v1' ? importedCount : converted.count, phase, error: errorMessage(e) };
  }
}

/**
 * Sub-project D: converts every pre-D playbook into an identity record plus
 * one published v1.
 *
 * Runs ONCE, here, at startup — never lazily from `listPlaybooks` or
 * `getPlaybook` (R-D7). A read path that publishes races itself: two
 * components reading on the same tick both see no `currentVersionId`, both
 * publish, and the playbook ends up holding v1 and v2 with identical
 * content, in the sub-project whose entire purpose is making "which version
 * did this review run against" answerable.
 *
 * The durable flag is NOT what makes that safe, and assuming it was is a
 * mistake this function has already made once. Two calls to
 * `migrateIfNeeded()` on the same tick — which React StrictMode's
 * double-invoked mount effect produces on every dev load, and a second tab
 * produces in production — both read no flag and both start converting.
 * A browser run caught exactly that: one playbook came out holding v1 AND
 * v2 with byte-identical content.
 *
 * What makes it safe is that each playbook's conversion is ONE readwrite
 * transaction spanning both stores, and the record it decides from is read
 * fresh INSIDE that transaction. IndexedDB serialises readwrite
 * transactions with overlapping scopes, so a second pass cannot begin until
 * the first has committed, and it then reads the `currentVersionId` the
 * first one wrote and skips. Nothing non-IDB is awaited inside the
 * transaction, which is what keeps IndexedDB from auto-committing it early.
 *
 * `progress` is an out-parameter rather than the return value alone because
 * a mid-loop throw carries no return value, and `migrateIfNeeded`'s contract
 * is to report a partial count from exactly that. It is incremented only
 * after a transaction has committed, so it never counts a rolled-back one.
 */
async function migratePlaybooksToVersions(
  db: IDBPDatabase<LexPromptDB>,
  progress: { count: number },
): Promise<number> {
  // Ids only. Every decision below is made from a record re-read inside the
  // conversion's own transaction — a record captured out here would be stale
  // the moment a concurrent pass converted it, which is the whole defect.
  const ids = (await db.getAll(STORES.playbooks)).map(p => p.id);

  for (const id of ids) {
    const tx = db.transaction([STORES.playbooks, STORES.playbookVersions], 'readwrite');
    const playbooks = tx.objectStore(STORES.playbooks);
    const versions = tx.objectStore(STORES.playbookVersions);

    const record = await playbooks.get(id);
    if (!record) {
      // Deleted between the id sweep and now. Nothing to convert.
      await tx.done;
      continue;
    }

    const { playbook, version } = migratePlaybookRecord(record);
    // Already migrated — it has a version pointer, and its content lives in
    // the versions store. This is also the branch a concurrent pass lands in.
    if (!version) {
      await tx.done;
      continue;
    }

    // Rule 2, one level up. An older build could have left a version behind
    // with nothing pointing at it; adopting it is right where publishing a
    // second copy of the same content would not be.
    const existing = await versions.index('byPlaybook').getAll(playbook.id);
    const current = existing.length > 0
      ? existing.reduce((latest, v) => (v.version > latest.version ? v : latest))
      : await publishVersionIn(versions, playbook.id, version, '');

    // `_seq` is preserved rather than reallocated, and `createdAt` /
    // `updatedAt` come straight from the source: converting a playbook is
    // not the user editing it, and must not reorder their library.
    await playbooks.put({
      ...playbook,
      currentVersionId: current.id,
      _seq: seqOf(record as { _seq?: unknown }),
    } as unknown as Playbook);
    await tx.done;
    progress.count++;
  }
  return progress.count;
}


/**
 * The version-number allocation, against an object-store handle from an
 * ALREADY-OPEN readwrite transaction — the same shape (and the same reason)
 * as `seq.ts`'s `nextSeq`.
 *
 * MOVED HERE from `playbookVersions.ts` by Stage 2 Task 13, which made that
 * module an HTTP client. Its type takes an `IDBPObjectStore`, so there was
 * no HTTP shape for it; and this — the one-time pre-D conversion, which is
 * IndexedDB to IndexedDB — is its only remaining caller. Moved rather than
 * copied: two copies of a version-number allocation is precisely the sibling
 * drift `matters.ts` reproducing `playbooks.ts`'s allocation *without* its
 * transaction scoping produced, and this project's canonical example of it.
 *
 * File-local on purpose. Nothing outside this conversion should be minting
 * a version in the browser at all any more: publishing is one route running
 * one Postgres transaction over both tables, and a second path to it would
 * be the orphan `publishAndPoint` exists to prevent.
 *
 * The caller owns the transaction and must not await anything non-IDB
 * between calling this and its own put, or IndexedDB auto-commits early and
 * reopens the race the shared transaction exists to close.
 */
async function publishVersionIn<TxStores extends ArrayLike<StoreNames<LexPromptDB>>>(
  store: IDBPObjectStore<LexPromptDB, TxStores, 'playbookVersions', 'readwrite'>,
  playbookId: string,
  draft: PlaybookDraft,
  byUserId: string,
): Promise<PlaybookVersion> {
  const existing = await store.index('byPlaybook').getAll(playbookId);
  const nextVersion = existing.reduce((max, v) => Math.max(max, v.version), 0) + 1;

  // A version history whose entries do not say what changed is a list of
  // dates (spec §4). v1 is exempt: there is no previous version for it to
  // have changed from.
  const summary = draft.changeSummary?.trim() ?? '';
  if (nextVersion > 1 && summary === '') {
    throw new Error('A change summary is required when publishing a new version.');
  }

  const record: PlaybookVersion = {
    ...draft,
    changeSummary: summary,
    id: uid(),
    playbookId,
    version: nextVersion,
    publishedAt: Date.now(),
    publishedByUserId: byUserId,
    schemaVersion: SCHEMA_VERSION,
  };
  await store.put(record);
  return record;
}
