import { getDb } from './open';
import { STORES } from './schema';
import type { Playbook, UserProfile } from '../../types';
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

export interface MigrationResult {
  status: 'not-needed' | 'migrated' | 'failed';
  count: number;
  error?: string;
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
async function readFlag(db: Awaited<ReturnType<typeof getDb>>): Promise<MigrationFlag | undefined> {
  const v = (await db.get(STORES.profile, MIGRATION_FLAG_KEY)) as unknown;
  return isMigrationFlag(v) ? v : undefined;
}

async function writeFlag(db: Awaited<ReturnType<typeof getDb>>, count: number): Promise<void> {
  const flag: MigrationFlag = { done: true, count, migratedAt: Date.now() };
  await db.put(STORES.profile, flag as unknown as UserProfile, MIGRATION_FLAG_KEY);
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** One-time migration of v1's localStorage templates into the `playbooks`
 *  IndexedDB store. Three rules govern every line below:
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
  // possible time for that gap to show up. `count` lives outside the try so
  // the catch can still report an accurate partial count from a mid-loop
  // failure, per Rule 3.
  let count = 0;
  try {
    const db = await getDb();

    // Fast path — the whole point of the durable flag: a returning user who
    // has already been migrated (or who never had v1 data) never causes
    // localStorage to be touched again.
    if (await readFlag(db)) {
      return { status: 'not-needed', count: 0 };
    }

    const raw = localStorage.getItem(V1_TEMPLATES_KEY);
    if (raw === null) {
      await writeFlag(db, 0);
      return { status: 'not-needed', count: 0 };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      // Rule 3. An unparseable source is not "nothing to migrate" — it is a
      // migration that cannot proceed. No flag is written, so a fixed or
      // recovered source gets another chance on the next call.
      return { status: 'failed', count: 0, error: `v1 template storage could not be parsed: ${errorMessage(e)}` };
    }

    if (!Array.isArray(parsed)) {
      return { status: 'failed', count: 0, error: 'v1 template storage was not an array.' };
    }

    if (parsed.length === 0) {
      await writeFlag(db, 0);
      return { status: 'not-needed', count: 0 };
    }

    for (const entry of parsed) {
      const src = (entry ?? {}) as Partial<Playbook> & Record<string, unknown>;
      const id = typeof src.id === 'string' && src.id ? src.id : uid();
      // Rule 2 (the check that matters). A record already present — from a
      // prior, possibly-interrupted run, or because the user has since
      // edited it in the app — is left exactly as it is. Never
      // unconditionally overwritten with what v1 originally had.
      const existing = await db.get(STORES.playbooks, id);
      if (existing) {
        count++;
        continue;
      }
      const record = { ...src, id } as Playbook;
      await db.put(STORES.playbooks, record);
      count++;
    }

    await writeFlag(db, count);
    return { status: 'migrated', count };
  } catch (e) {
    // Rule 3, for every failure this function can hit — a bad `getDb()`
    // open, a per-record write failure (count reflects successes strictly
    // before the failing record, since `count++` only happens after a
    // successful get/skip or put), or a failure writing the completion
    // flag itself after every record succeeded. No flag is written on any
    // of these paths — the successfully-written records are recognized as
    // already-present on the next attempt, so a retry resumes rather than
    // reprocessing them.
    return { status: 'failed', count, error: errorMessage(e) };
  }
}
