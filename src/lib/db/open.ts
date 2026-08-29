import { openDB, type IDBPDatabase } from 'idb';
import { DB_NAME, DB_VERSION, STORES, type LexPromptDB } from './schema';
import { debug } from '../debug';

const BLOCKED_TIMEOUT_MS = 3000;

// Generous on purpose. The blocked-guard above only fires when another tab
// is provably in the way — but an IndexedDB open can also simply never
// settle (no `blocked()`, no error, no success) with no browser-visible
// signal at all. Without a backstop that leaves every caller's `getDb()`
// pending forever, indistinguishable from a slow-but-working load. 30s is
// wide enough that a legitimately slow first open on a large database is
// not aborted for the users with the most data (see rulings.md) — this is
// a last resort, not a normal-path timeout.
const OPEN_TIMEOUT_MS = 30000;

export class DbBlockedError extends Error {
  constructor() {
    super(
      'LexPrompt could not upgrade its local database because another tab has it open. ' +
        'Close other LexPrompt tabs and reload.',
    );
    this.name = 'DbBlockedError';
  }
}

/** Raised when the underlying IndexedDB open neither succeeds, fails, nor
 *  fires `blocked()` within `OPEN_TIMEOUT_MS`. Distinct from `DbBlockedError`
 *  (which names a specific, diagnosable cause) because this covers whatever
 *  is left when none of the recognised signals ever arrived — a browser- or
 *  disk-level fault this app has no way to name more precisely. */
export class DbOpenTimeoutError extends Error {
  constructor() {
    super(
      "LexPrompt's local database did not respond. Your data has not been lost — " +
        'try again.',
    );
    this.name = 'DbOpenTimeoutError';
  }
}

/**
 * Creates every object store and index this app has ever added, additively.
 *
 * EXPORTED so a test can open the same database WITHOUT going through
 * `getDb()`. From Stage 2 Task 23 `getDb()` hands back a READ-ONLY handle,
 * and a test that needs to seed local data (the uploader's tests, and only
 * those) has to be able to write it. The alternative — a second copy of the
 * schema in a test helper — is this project's most repeated defect, and this
 * particular copy would drift silently: a store added here and missed there
 * would make the uploader's tests pass against a database shaped unlike the
 * one a user has.
 *
 * `src/test/seedLocalData.ts` is its only non-`getDb` caller.
 */
export function upgradeSchema(db: IDBPDatabase<LexPromptDB>): void {
  if (!db.objectStoreNames.contains(STORES.matters)) {
    db.createObjectStore(STORES.matters, { keyPath: 'id' });
  }
  if (!db.objectStoreNames.contains(STORES.documents)) {
    const s = db.createObjectStore(STORES.documents, { keyPath: 'id' });
    s.createIndex('byMatter', 'matterId');
  }
  if (!db.objectStoreNames.contains(STORES.blobs)) {
    db.createObjectStore(STORES.blobs, { keyPath: 'documentId' });
  }
  if (!db.objectStoreNames.contains(STORES.reviews)) {
    const s = db.createObjectStore(STORES.reviews, { keyPath: 'id' });
    s.createIndex('byMatter', 'matterId');
  }
  if (!db.objectStoreNames.contains(STORES.playbooks)) {
    db.createObjectStore(STORES.playbooks, { keyPath: 'id' });
  }
  if (!db.objectStoreNames.contains(STORES.profile)) {
    db.createObjectStore(STORES.profile);
  }
  if (!db.objectStoreNames.contains(STORES.collections)) {
    const s = db.createObjectStore(STORES.collections, { keyPath: 'id' });
    s.createIndex('byMatter', 'matterId');
  }
  if (!db.objectStoreNames.contains(STORES.playbookVersions)) {
    const s = db.createObjectStore(STORES.playbookVersions, { keyPath: 'id' });
    s.createIndex('byPlaybook', 'playbookId');
  }
  // DB_VERSION 3 -> 4 (sub-project F, Task 8): additive only. Every
  // branch above is untouched — no existing store is modified,
  // reindexed, or cleared, so a database already at version 3 keeps
  // every record it had.
  if (!db.objectStoreNames.contains(STORES.changesets)) {
    const s = db.createObjectStore(STORES.changesets, { keyPath: 'id' });
    s.createIndex('byPlaybook', 'playbookId');
  }
}

/**
 * Raised by the READ-ONLY handle `getDb()` hands out, when something tries to
 * write to the browser-local database.
 *
 * See `readOnly` below for why the local database is read-only from Stage 2,
 * and why that is enforced here rather than agreed in a comment.
 */
export class LocalDatabaseIsReadOnlyError extends Error {
  constructor(what: string) {
    super(
      `LexPrompt's local database is read-only (a "${what}" was attempted). Your firm's server `
      + 'is where everything is stored now; the copy in this browser is kept only so the '
      + '"Move this browser’s data to the server" screen can read it, and a later release '
      + 'removes it.',
    );
    this.name = 'LocalDatabaseIsReadOnlyError';
  }
}

/** `idb`'s convenience writes. Each opens its own `'readwrite'` transaction
 *  internally, on the WRAPPED database rather than through the `transaction`
 *  method this proxy intercepts, so guarding the transaction alone would
 *  leave every one of these live. */
const WRITE_METHODS = new Set(['put', 'add', 'delete', 'clear']);

/**
 * The local database is READ-ONLY from Stage 2.
 *
 * It is not deleted (S13, and "never delete what you cannot read"): it is the
 * owner's only copy until the uploader has run and they have confirmed the
 * server copy is good, and a later release removes it. Until then it is
 * readable by exactly one screen and writable by nothing.
 *
 * Enforced rather than agreed. A `'readwrite'` transaction throws here,
 * naming the rule, because a convention lasts until the first person who
 * needs a quick write — and a write to a store nothing reads is work
 * silently lost. That is not hypothetical: `migrateIfNeeded` spent the whole
 * of Part 2A writing converted playbooks into a store the app had already
 * stopped reading, and nothing anywhere said so.
 *
 * `src/test/seedLocalData.ts` opens the same database directly, through
 * `upgradeSchema` above, for the uploader's own fixtures — a test that has to
 * put a firm's data into the browser cannot go through a handle that refuses
 * to write. That is the ONE way past this guard and it is not reachable from
 * `src/lib` or `src/features`.
 */
function readOnly(db: IDBPDatabase<LexPromptDB>): IDBPDatabase<LexPromptDB> {
  return new Proxy(db, {
    get(target, prop) {
      if (prop === 'transaction') {
        return (stores: unknown, mode?: IDBTransactionMode, ...rest: unknown[]) => {
          // `undefined` means `'readonly'` in the IndexedDB API, so only an
          // explicit non-readonly mode is refused.
          if (mode !== undefined && mode !== 'readonly') {
            throw new LocalDatabaseIsReadOnlyError(`${mode} transaction`);
          }
          return (target.transaction as (...a: unknown[]) => unknown)(stores, mode, ...rest);
        };
      }
      if (typeof prop === 'string' && WRITE_METHODS.has(prop)) {
        return () => { throw new LocalDatabaseIsReadOnlyError(prop); };
      }
      const value = (target as unknown as Record<string | symbol, unknown>)[prop];
      // Bound to the REAL database, never to the proxy: `idb`'s own internals
      // read private state off the instance, and handing them the proxy sends
      // every internal access back through this trap.
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as IDBPDatabase<LexPromptDB>;
}

let dbPromise: Promise<IDBPDatabase<LexPromptDB>> | null = null;

export function getDb(): Promise<IDBPDatabase<LexPromptDB>> {
  if (!dbPromise) {
    let blockedFlag = false;
    // Declared up front so `terminated()` — which can only fire after this
    // synchronous block has finished and `opening` has been assigned below —
    // can compare against it by reference.
    let opening: Promise<IDBPDatabase<LexPromptDB>>;

    const openPromise = openDB<LexPromptDB>(DB_NAME, DB_VERSION, {
      upgrade(db) {
        upgradeSchema(db);
      },
      blocked() {
        // Another tab holds an older version open. Without this the open hangs
        // silently forever, which reads to a user as "the app is broken".
        blockedFlag = true;
        debug('IndexedDB upgrade blocked by another tab');
      },
      blocking() {
        // This tab is holding a version another tab wants to upgrade past.
        // Close so the other tab can proceed.
        closeDb();
      },
      terminated() {
        // Only clear the memo if it still points at *this* connection's
        // promise. If closeDb() (e.g. via blocking()) already replaced it
        // with a fresh, later open, that fresh open must survive this old
        // connection's termination notice.
        if (dbPromise === opening) dbPromise = null;
      },
    });

    // openDB still never settles once `blocked()` has fired — the callback alone
    // is not a fix. Race it against a timer so callers get a rejection instead
    // of hanging forever. A second, much longer timer backstops the case
    // `blocked()` never covers: an open that never settles AT ALL, with no
    // signal of any kind. Whichever of the four ways this can settle fires
    // first (success, failure, blocked-timeout, open-timeout) clears the
    // others, so nothing is left running once `guarded` has settled.
    const guarded: Promise<IDBPDatabase<LexPromptDB>> = new Promise((resolve, reject) => {
      const blockedTimer = setTimeout(() => {
        if (blockedFlag) {
          clearTimeout(openTimer);
          reject(new DbBlockedError());
        }
      }, BLOCKED_TIMEOUT_MS);

      const openTimer = setTimeout(() => {
        clearTimeout(blockedTimer);
        reject(new DbOpenTimeoutError());
      }, OPEN_TIMEOUT_MS);

      openPromise.then(
        db => {
          clearTimeout(blockedTimer);
          clearTimeout(openTimer);
          // READ-ONLY from here on. Wrapped at the one place every caller
          // comes through, so there is no handle in the app that is not.
          resolve(readOnly(db));
        },
        err => {
          clearTimeout(blockedTimer);
          clearTimeout(openTimer);
          reject(err);
        },
      );
    });

    opening = guarded.catch(err => {
      // Never memoise a rejection — one transient failure (or a blocked
      // upgrade) must not poison the database for the rest of the page's
      // lifetime. But only clear the memo if it still points at *this*
      // attempt: closeDb() may already have replaced it with a fresh,
      // successful open by the time this rejection settles — e.g. a
      // blocked open's 3s timeout firing after a newer getDb() call has
      // already resolved. Nulling unconditionally here would discard that
      // fresh connection with nothing left to close it, which is exactly
      // the leaked-connection failure this task exists to prevent.
      if (dbPromise === opening) dbPromise = null;
      throw err;
    });

    dbPromise = opening;
  }
  return dbPromise;
}

export function closeDb(): void {
  const pending = dbPromise;
  dbPromise = null;
  void pending?.then(db => db.close()).catch(() => {});
}
