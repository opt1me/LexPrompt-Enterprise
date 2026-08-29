/**
 * Whether this browser's data has already been moved to the server.
 *
 * ## Why this is remembered at all
 *
 * §13.1, and Task 23: *"after a complete upload, the banner CHANGES rather
 * than disappearing — 'Your data is on the server. A copy is still in this
 * browser and will be removed in a later release' — because a banner that
 * vanishes is a person who never learns the copy is still there."*
 *
 * The copy is still in IndexedDB, so nothing about the database itself can
 * tell the two states apart: a browser that has uploaded and a browser that
 * has not look identical from the inside. That is deliberate — this uploader
 * deletes nothing — and it is exactly why the fact has to be recorded
 * somewhere else.
 *
 * ## Why `localStorage`
 *
 * The one place this app already keeps a few hundred synchronously-read
 * bytes (`src/lib/storage.ts`'s settings, ruling R6), and the one place that
 * is still writable: the IndexedDB database is read-only from this stage, so
 * the flag could not live beside the data it describes even if that were
 * otherwise the right home.
 *
 * ## What it is NOT
 *
 * It is not evidence that the data is on the server, and nothing reads it as
 * such. Only the report the run produced says what moved, and only a person
 * looking at the server can confirm it. This records one thing: that a
 * COMPLETE run happened in this browser, so the banner can stop saying "not
 * moved yet" and start saying "still here as well". A partial run does not
 * set it — a browser with records that did not move must go on saying so.
 */

const KEY = 'lexprompt.upload.complete.v1';

export function markUploadComplete(at = Date.now()): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ at }));
  } catch {
    // A browser refusing localStorage (private mode, a policy). The banner
    // then keeps offering the upload, which is wrong but SAFE: it offers to
    // move data that has already moved, and a second run confirms every
    // record rather than duplicating it. The opposite default — assuming a
    // failed write meant the upload happened — would hide the banner from
    // somebody whose data never left.
  }
}

export function wasUploadComplete(): boolean {
  try {
    return localStorage.getItem(KEY) !== null;
  } catch {
    return false;
  }
}

/** For tests, and for a person who wants the banner back. */
export function forgetUploadComplete(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* nothing to forget */
  }
}
