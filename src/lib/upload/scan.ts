import type { IDBPDatabase } from 'idb';
import { getDb } from '../db/open';
import { PROFILE_KEY, STORES, type LexPromptDB } from '../db/schema';
import type { StoreName } from './report';
import { UPLOAD_STORES } from './report';
import type {
  Changeset, Collection, DocumentRecord, Matter, Playbook, PlaybookVersion, Review, UserProfile,
} from '../../types';

/**
 * Reading the browser, and saying exactly what is in it — BEFORE anything
 * moves.
 *
 * ## Why this is its own module, and its own step
 *
 * A report can only say *"3 of 4 matters moved"* if something counted the
 * four before the upload started. A count accumulated as the upload goes can
 * only ever report what it managed to reach, which is the failure mode
 * wearing a summary's clothes — and this app's founding defect, *"a failed
 * storage migration rendering an empty library, indistinguishable from a
 * fresh install"*, is exactly that shape one layer down.
 *
 * So the scan runs first, produces the record list the report's `expected`
 * counts come from, and is allowed to answer three different things about a
 * store:
 *
 *  - a COUNT, when it read the store;
 *  - NOTHING AT ALL — the key absent from `totals`, the store named in
 *    `unreadable` — when it could not. Never `0`. Zero and unreadable are
 *    different facts and this is the exact place where confusing them
 *    produces the defect above;
 *  - and, per record, a WARNING: a `DocumentRecord` can outlive its bytes
 *    (`getDocumentBlob` returns `null` for precisely this), and a person
 *    reading "3 documents moved" must not be left to assume three files came
 *    with them.
 *
 * ## Failures are not flattened
 *
 * `getDb()` can reject with `DbBlockedError` (another tab holds an upgrade),
 * `DbOpenTimeoutError` (nothing answered) or, through the repair-on-read
 * path, `UnconvertedPlaybookError`. Each names something a person can act
 * on and `describeLoadError` already passes all three through verbatim. This
 * module therefore does NOT catch them: "your local data could not be read"
 * would replace three useful sentences with a shrug. It rejects, and the
 * screen renders `describeLoadError`'s message.
 *
 * A single STORE failing is different — the other six are still readable and
 * still worth moving — so that is caught, named in `unreadable`, and the
 * scan continues.
 *
 * ## Nothing here writes
 *
 * Every transaction this module opens is `'readonly'`, which Task 23 makes
 * an enforced property of `getDb()` itself rather than a convention this
 * file keeps.
 */

export type OpenDb = () => Promise<IDBPDatabase<LexPromptDB>>;

/** One record the uploader will try to move, with the name a person would
 *  call it by. `record` is the RAW stored value — repair-on-read
 *  (`migrateDocumentRecord`, `migrateReviewRecord`, `migratePlaybookRecord`)
 *  is applied by the uploader at the moment of sending, so the scan stays a
 *  read and the migration stays in one place. */
export interface ScannedRecord {
  store: StoreName;
  id: string;
  label: string;
  /** Something a person should know BEFORE pressing Upload — that a
   *  document's original file is not in this browser, or that a record was
   *  found but could not be read. */
  warning?: string;
  /** Set when the record was FOUND but could not be read, so there is
   *  nothing to send. The uploader reports it as a named failure rather than
   *  sending whatever it managed to parse — half a playbook uploaded as a
   *  whole one is the confidently-wrong shape this app exists not to
   *  produce. */
  unreadable?: true;
  record: unknown;
}

export interface LocalDataScan {
  /** Per store, how many records are there. A store in `unreadable` has NO
   *  KEY here — never `0`. */
  totals: Partial<Record<StoreName, number>>;
  records: Record<StoreName, ScannedRecord[]>;
  /** Stores that could not be read at all. */
  unreadable: StoreName[];
  /** True only when every store was READ and every one of them was empty.
   *  A browser with an unreadable store is not empty — it is a browser
   *  nobody knows the contents of. */
  isEmpty: boolean;
  /** An ESTIMATE of the bytes an upload would send, from each document
   *  record's own `byteSize`, so a person is not surprised by a 400 MB
   *  upload. Taken from the record rather than by reading every Blob: the
   *  reading is the upload, and doing it twice would double the cost of
   *  finding out. */
  totalBytes: number;
  /** The id the local profile carried, for `rewriteAttribution` (P16).
   *  Absent when this browser never had one, or when the profile store
   *  could not be read — in which case every attribution is left alone and
   *  counted as unmapped on the report, which is loud and true. */
  localProfileId?: string;
  /** Document ids with no bytes in this browser. Held here so the uploader
   *  does not have to re-derive the same fact from the same store. */
  documentsWithoutBytes: string[];
}

export const NO_BYTES_WARNING =
  'The original file is not in this browser — only the text already extracted from it can move.';

const emptyRecords = (): Record<StoreName, ScannedRecord[]> => ({
  matters: [], documents: [], collections: [], playbooks: [],
  playbookVersions: [], reviews: [], changesets: [],
});

/** `12 August 2026`. A review's own name is its playbook and its date; an id
 *  is not a name. */
function dateLabel(at: unknown): string {
  if (typeof at !== 'number' || !Number.isFinite(at)) return 'undated';
  return new Date(at).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });
}

function text(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

/** The exact key v1 wrote its templates under (`src/lib/storage.ts`,
 *  pre-redesign — see `git show 457b6fc:src/lib/storage.ts`). Read directly;
 *  v1's module is gone, and from Task 23 so is the migration that used to
 *  copy these into IndexedDB. */
const V1_TEMPLATES_KEY = 'lexprompt.templates.v2';

/**
 * v1's `localStorage` templates, as scanned playbook records.
 *
 * A value that is present but unparseable, or that is not an array, does NOT
 * silently read as "there are none": it becomes ONE record marked
 * `unreadable`, so it appears on this screen by name, fails by name on the
 * report, and makes the run incomplete. The old migration's answer to the
 * same situation was to block the entire app, which was right when this was
 * the only path to a playbook and is too much now that it is a backup of
 * records almost certainly already in the object store.
 */
function readV1Templates(): ScannedRecord[] {
  let raw: string | null;
  try {
    raw = localStorage.getItem(V1_TEMPLATES_KEY);
  } catch {
    // A browser refusing localStorage entirely (private mode, a policy).
    // Nothing to report: we cannot even tell whether there was a key.
    return [];
  }
  if (raw === null) return [];

  const broken = (why: string): ScannedRecord[] => ([{
    store: 'playbooks',
    id: V1_TEMPLATES_KEY,
    label: 'Playbooks saved by an older version of LexPrompt',
    warning: `These could not be read (${why}), so they cannot be moved. `
      + 'They are still in this browser exactly as they were.',
    unreadable: true,
    record: null,
  }]);

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return broken(e instanceof Error ? e.message : String(e));
  }
  if (!Array.isArray(parsed)) return broken('what is stored there is not a list');

  return parsed.map((entry, index) => {
    const src = (entry ?? {}) as Record<string, unknown>;
    const id = typeof src.id === 'string' && src.id ? src.id : `${V1_TEMPLATES_KEY}:${index}`;
    return {
      store: 'playbooks' as const,
      id,
      label: text(src.name, 'Untitled playbook'),
      record: { ...src, id },
    };
  });
}

export async function scanLocalData(openDb: OpenDb = getDb): Promise<LocalDataScan> {
  // NOT caught. `DbBlockedError`, `DbOpenTimeoutError` and
  // `UnconvertedPlaybookError` each say something a person can act on, and
  // `describeLoadError` passes each through; folding them into one sentence
  // here would replace three useful ones with a shrug.
  const db = await openDb();

  const records = emptyRecords();
  const totals: Partial<Record<StoreName, number>> = {};
  const unreadable: StoreName[] = [];

  /** One store, read on its own so a failure names ITSELF rather than
   *  taking the other six down with it. */
  async function read<T>(store: StoreName, from: () => Promise<T[]>): Promise<T[] | null> {
    try {
      return await from();
    } catch {
      // The message is deliberately not kept: an IndexedDB read failure
      // carries a browser-level string no lawyer can act on, and the fact
      // that matters — this store's contents are UNKNOWN — is the store's
      // presence in `unreadable`, which the screen and the report both read.
      unreadable.push(store);
      return null;
    }
  }

  // Blob PRESENCE, not blob bytes. `getAllKeys` reads the key path only, so
  // a 400 MB library is not pulled into memory to find out which documents
  // have a file — and the answer is the one thing the scan needs.
  const blobKeys = await read('documents', () => db.getAllKeys(STORES.blobs) as Promise<string[]>);
  const haveBytes = new Set(blobKeys ?? []);
  // `read` above pushed 'documents' onto `unreadable` if the BLOB keys could
  // not be read, which is the right store to name (a document whose bytes
  // cannot even be enumerated cannot be moved honestly) — but the documents
  // store itself may still read fine, so the flag is remembered and the
  // store is not read twice.
  const blobsUnreadable = blobKeys === null;

  const matters = await read('matters', () => db.getAll(STORES.matters) as Promise<Matter[]>);
  if (matters) {
    totals.matters = matters.length;
    records.matters = matters.map(m => ({
      store: 'matters' as const, id: m.id, label: text(m.name, 'Untitled matter'), record: m,
    }));
  }

  let totalBytes = 0;
  const documentsWithoutBytes: string[] = [];
  const documents = blobsUnreadable
    ? null
    : await read('documents', () => db.getAll(STORES.documents) as Promise<DocumentRecord[]>);
  if (documents) {
    totals.documents = documents.length;
    records.documents = documents.map(d => {
      const size = typeof d.byteSize === 'number' && Number.isFinite(d.byteSize) ? d.byteSize : 0;
      const missing = !haveBytes.has(d.id);
      if (missing) documentsWithoutBytes.push(d.id);
      else totalBytes += size;
      return {
        store: 'documents' as const,
        id: d.id,
        label: text(d.name, 'Untitled document'),
        ...(missing ? { warning: NO_BYTES_WARNING } : {}),
        record: d,
      };
    });
  }

  const collections = await read('collections', () => db.getAll(STORES.collections) as Promise<Collection[]>);
  if (collections) {
    totals.collections = collections.length;
    records.collections = collections.map(c => ({
      store: 'collections' as const, id: c.id, label: text(c.name, 'Untitled collection'), record: c,
    }));
  }

  const playbooks = await read('playbooks', () => db.getAll(STORES.playbooks) as Promise<Playbook[]>);
  const playbookName = new Map<string, string>();
  if (playbooks) {
    totals.playbooks = playbooks.length;
    records.playbooks = playbooks.map(p => {
      const label = text(p.name, 'Untitled playbook');
      playbookName.set(p.id, label);
      return { store: 'playbooks' as const, id: p.id, label, record: p };
    });
    // …and the templates v1 left in `localStorage`, which are not in any
    // object store at all.
    //
    // Sub-project A's startup migration used to copy these into the
    // `playbooks` store, and deliberately never deleted the source — that
    // backup is disclosed in the README. Task 23 deletes that migration,
    // because from Part 2A it was writing into a store the app no longer
    // read. So this is now the ONLY thing that will ever look at v1's key
    // again, and skipping it would silently orphan the playbooks of anyone
    // whose browser never ran a post-A build: they would open a signed-in
    // app with an empty library and be told there was nothing here to move.
    // That is the founding defect, reached by omission rather than by
    // failure.
    //
    // An id already in the object store is SKIPPED, never uploaded twice —
    // for almost everybody these are the same playbooks, copied by A's
    // migration years ago and left behind here as the backup it promised.
    for (const template of readV1Templates()) {
      if (playbookName.has(template.id)) continue;
      records.playbooks.push(template);
      totals.playbooks = (totals.playbooks ?? 0) + 1;
      playbookName.set(template.id, template.label);
    }
  }

  const versions = await read(
    'playbookVersions', () => db.getAll(STORES.playbookVersions) as Promise<PlaybookVersion[]>);
  if (versions) {
    totals.playbookVersions = versions.length;
    records.playbookVersions = versions.map(v => ({
      store: 'playbookVersions' as const,
      id: v.id,
      label: `${playbookName.get(v.playbookId) ?? text(v.name, 'Untitled playbook')} v${v.version}`,
      record: v,
    }));
  }

  const reviews = await read('reviews', () => db.getAll(STORES.reviews) as Promise<Review[]>);
  if (reviews) {
    totals.reviews = reviews.length;
    records.reviews = reviews.map(r => ({
      store: 'reviews' as const,
      id: r.id,
      label: `${text(r.playbookSnapshot?.name, 'Untitled playbook')} — ${dateLabel(r.startedAt)}`,
      record: r,
    }));
  }

  const changesets = await read('changesets', () => db.getAll(STORES.changesets) as Promise<Changeset[]>);
  if (changesets) {
    totals.changesets = changesets.length;
    records.changesets = changesets.map(c => ({
      store: 'changesets' as const,
      id: c.id,
      label: text(c.sourceSummary, 'Untitled changeset'),
      record: c,
    }));
  }

  let localProfileId: string | undefined;
  try {
    const profile = (await db.get(STORES.profile, PROFILE_KEY)) as UserProfile | undefined;
    if (profile && typeof profile.id === 'string' && profile.id) localProfileId = profile.id;
  } catch {
    // Left absent rather than reported as a broken store: the profile is not
    // a record this uploader moves (the signed-in `app_user` is who the
    // server says it is), and its absence has a defined, loud consequence —
    // every attribution is left exactly as it was and counted as unmapped on
    // the report.
  }

  // A store nobody could read leaves an UNKNOWN number of records behind, so
  // this browser is not empty; it is a browser nobody knows the contents of.
  // Reporting it as empty is the founding defect, restated at the one screen
  // whose whole job is telling a person what is here.
  const isEmpty = unreadable.length === 0
    && UPLOAD_STORES.every(store => (totals[store] ?? 0) === 0);

  return {
    totals,
    records,
    unreadable,
    isEmpty,
    totalBytes,
    ...(localProfileId === undefined ? {} : { localProfileId }),
    documentsWithoutBytes,
  };
}

/** `1.2 MB`. Rendered on the screen so the size estimate is a sentence
 *  rather than a number of bytes. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/**
 * Is there anything in this browser at all, and could we tell?
 *
 * The banner needs an answer on every app start, and a full `scanLocalData`
 * is the wrong price for it: `getAll` on the documents store pulls every
 * document's extracted text into memory to answer a question `count` answers
 * from the index. So this is the cheap read, and `scanLocalData` is the one
 * the screen does when a person actually asks to see what is here.
 *
 * It REJECTS rather than answering `0` when the database cannot be opened.
 * That is the whole reason it is a separate function rather than a boolean
 * folded into a component: a browser holding a firm's un-uploaded matters
 * whose database refuses to open must not render as "nothing here" and
 * silently drop the banner. The caller shows the failure, with
 * `describeLoadError`'s wording, instead of hiding.
 *
 * A single store failing is caught, named, and still reported — the same
 * three-way distinction `scanLocalData` keeps, at a cheaper price.
 */
export async function countLocalData(openDb: OpenDb = getDb): Promise<{
  total: number;
  unreadable: StoreName[];
}> {
  const db = await openDb();
  let total = 0;
  const unreadable: StoreName[] = [];
  for (const store of UPLOAD_STORES) {
    try {
      // eslint-disable-next-line no-await-in-loop
      total += await db.count(store);
    } catch {
      unreadable.push(store);
    }
  }
  // v1's localStorage templates count too. A browser holding ONLY those —
  // one that never ran a post-sub-project-A build — has an empty IndexedDB
  // and a library that has never been moved anywhere, and leaving them out
  // here would drop the banner and orphan them in silence.
  if (!unreadable.includes('playbooks')) total += readV1Templates().length;
  return { total, unreadable };
}
