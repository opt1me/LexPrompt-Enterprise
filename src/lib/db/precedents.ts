import { ModelError, uid } from '@lexprompt/core';
import { apiDelete, apiGet, apiSend, apiSendBlob } from '../api/client';
import type { PrecedentDocumentRecord, PrecedentSet } from '../../types';

/**
 * The precedents repository — precedent sets and the documents in them
 * (server spec §11.1).
 *
 * ## This module exists because a promise changed
 *
 * Sub-project F read a precedent document for one session and stored
 * nothing, and the intake screen said so in the strongest words it could:
 * *"Read once to learn from. Never stored."* That was true when it was
 * written. §11.1 rules the other way — a house position adopted from a
 * redline is only *evidenced* while the evidence exists, and a lawyer who
 * cannot re-open the four leases behind a house rule six months later has an
 * assertion rather than evidence — so precedent documents are stored, and
 * the sentence on that screen changed in the same commit that made them so
 * (`PRECEDENT_STORAGE_PRIVACY` in `src/lib/privacyCopy.ts`).
 *
 * ## What did NOT change
 *
 * - **The parse stays in the browser.** `docxRedlines.ts` reads a `.docx`'s
 *   OOXML directly, never through `mammoth` (which silently discards
 *   `<w:ins>` and `<w:del>`), and it needs the raw bytes, which the caller
 *   already holds. Uploading is IN ADDITION to that, not instead of it.
 * - **The SESSION is still session-only.** Storing the documents does not
 *   store the `AuthoringDraft` they lead to (R-E1): a half-reviewed playbook
 *   nobody agreed to must still die with the tab.
 * - **A playbook is house rules, not a document archive.** Only the standard
 *   positions a person goes on to adopt reach a playbook.
 *
 * ## The rule this file must not get wrong
 *
 * The same one `matters.ts` and `documents.ts` state: **a failure is a
 * failure, never an empty result.** Nothing here answers `[]` or `null` for
 * anything but a genuine "there is no such record", so a caller can always
 * tell "nothing brought in yet" from "the server failed" — and, on THIS
 * path, so a screen that promises a document is stored never shows a person
 * a document that silently is not.
 */

/**
 * Mints a set. `id` and `createdAt` are the browser's (P6: ids are
 * client-minted), the attribution is the server's — whatever this sends for
 * `createdByUserId` is read and discarded by the route, which uses the
 * authenticated actor.
 */
export function newPrecedentSet(name: string): PrecedentSet {
  return { id: uid(), name, createdAt: Date.now(), createdByUserId: '' };
}

/** Creates the set. Rejects on any failure — a set that was not created is
 *  a set no document can be stored in, and the caller must not proceed
 *  believing otherwise. */
export async function createPrecedentSet(set: PrecedentSet): Promise<PrecedentSet> {
  return apiSend<PrecedentSet>('POST', '/v1/precedent-sets', set);
}

export async function getPrecedentSet(id: string): Promise<PrecedentSet> {
  return apiGet<PrecedentSet>(`/v1/precedent-sets/${encodeURIComponent(id)}`);
}

/** The set's documents, oldest-added first. The order is the server's and is
 *  not re-derived here — two sorts that must agree is this project's most
 *  repeated defect. */
export async function listPrecedentDocuments(setId: string): Promise<PrecedentDocumentRecord[]> {
  return apiGet<PrecedentDocumentRecord[]>(
    `/v1/precedent-sets/${encodeURIComponent(setId)}/documents`);
}

/**
 * Uploads one precedent document's record and its original bytes as ONE
 * multipart request — the same shape, and the same server-side ingest, as
 * `addDocument` (`apps/api/src/routes/ingest.ts`). Read that route's note on
 * the blob-first write order before changing anything here; from this side
 * the difference is invisible.
 *
 * **`rec.id` is the SESSION's id for this document, deliberately.** The
 * `basis` of every position `inferPositions` derives is keyed by that id, so
 * making it the stored document's id is what lets a position adopted today
 * still resolve to the document it came from next year (§11.1,
 * `position_basis`). Minting a second id here would leave the durable basis
 * pointing at nothing.
 */
export async function uploadPrecedent(
  setId: string, rec: PrecedentDocumentRecord, bytes: Blob,
): Promise<PrecedentDocumentRecord> {
  const form = new FormData();
  form.append('record', JSON.stringify(rec));
  // The FILENAME matters: some servers refuse a file part without one, and
  // the Blob's own `type` is what the server stores as the document's mime.
  form.append('bytes', bytes, rec.name);
  return apiSendBlob<PrecedentDocumentRecord>(
    `/v1/precedent-sets/${encodeURIComponent(setId)}/documents`, form);
}

/**
 * Removes one precedent document and its bytes.
 *
 * Called when a person takes a document OUT of an intake session. Without
 * it, the screen's promise — "stored with the playbook you build from them"
 * — would be false in the quiet direction for a document they explicitly
 * removed: still held, belonging to a playbook it never taught.
 *
 * A 404 RESOLVES: the caller asked for it to be gone and it is gone.
 */
export async function deletePrecedentDocument(id: string): Promise<void> {
  await forgivingDelete(`/v1/precedent-documents/${encodeURIComponent(id)}`);
}

/** Removes the set, its documents and their bytes. */
export async function deletePrecedentSet(id: string): Promise<void> {
  await forgivingDelete(`/v1/precedent-sets/${encodeURIComponent(id)}`);
}

/** A 404 resolves; everything else rejects — in particular a 500 saying the
 *  bytes survived, which the reader needs to see. Matched on the class and
 *  the status, exactly as `deleteDocument` and `deleteMatter` match it, so
 *  the three cannot drift into three ideas of what "not found" looks like. */
async function forgivingDelete(path: string): Promise<void> {
  try {
    await apiDelete(path);
  } catch (err) {
    if (err instanceof ModelError && err.status === 404) return;
    throw err;
  }
}
