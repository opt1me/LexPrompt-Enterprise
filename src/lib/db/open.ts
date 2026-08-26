import { openDB, type IDBPDatabase } from 'idb';
import { DB_NAME, DB_VERSION, STORES, type LexPromptDB } from './schema';
import { debug } from '../debug';

const BLOCKED_TIMEOUT_MS = 3000;

export class DbBlockedError extends Error {
  constructor() {
    super(
      'LexPrompt could not upgrade its local database because another tab has it open. ' +
        'Close other LexPrompt tabs and reload.',
    );
    this.name = 'DbBlockedError';
  }
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
    // of hanging forever.
    const guarded: Promise<IDBPDatabase<LexPromptDB>> = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (blockedFlag) {
          reject(new DbBlockedError());
        }
      }, BLOCKED_TIMEOUT_MS);

      openPromise.then(
        db => {
          clearTimeout(timer);
          resolve(db);
        },
        err => {
          clearTimeout(timer);
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
