import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ModelError } from '@lexprompt/core';
import type { DocumentRecord } from '../../types';

/**
 * The documents repository, now a TRANSPORT.
 *
 * What this file used to assert about STORAGE — the two-store transaction,
 * the `byMatter` index, the blob round trip, the read-modify-write inside
 * `setDocumentRole` — moved to `apps/api/test/documents.pg.test.ts` and
 * `apps/api/test/cascade.compose.test.ts`, where a real Postgres and a real
 * Azurite can prove it rather than a fake IndexedDB. The
 * `migrateDocumentRecord` cases below are kept VERBATIM: it is a pure
 * function over a record's own shape and has no business changing when its
 * neighbours' storage does — its needing no edit is the evidence R3's seam
 * held for it.
 *
 * What stays here is what the browser still owns: which request each export
 * makes, that the upload is ONE multipart request carrying both halves, and
 * — the one that matters — that a failure stays a failure.
 */

const apiGet = vi.fn();
const apiGetOrNull = vi.fn();
const apiSend = vi.fn();
const apiSendBlob = vi.fn();
const apiDelete = vi.fn();

vi.mock('../api/client', () => ({
  apiGet: (...args: unknown[]) => apiGet(...args),
  apiGetOrNull: (...args: unknown[]) => apiGetOrNull(...args),
  apiSend: (...args: unknown[]) => apiSend(...args),
  apiSendBlob: (...args: unknown[]) => apiSendBlob(...args),
  apiDelete: (...args: unknown[]) => apiDelete(...args),
}));

const {
  migrateDocumentRecord, listDocuments, getDocument, addDocument, setDocumentRole, deleteDocument,
} = await import('./documents');

const DOC: DocumentRecord = {
  id: 'd1', matterId: 'm1', name: 'lease.pdf', kind: 'pdf', text: 'Some extracted text.',
  byteSize: 11, addedAt: 1_700_000_000_000, addedByUserId: 'u1', role: 'standalone',
};

beforeEach(() => {
  apiGet.mockReset().mockResolvedValue([]);
  apiGetOrNull.mockReset().mockResolvedValue(null);
  apiSend.mockReset().mockResolvedValue(DOC);
  apiSendBlob.mockReset().mockResolvedValue(undefined);
  apiDelete.mockReset().mockResolvedValue(undefined);
});

describe('migrateDocumentRecord', () => {
  // KEPT VERBATIM from the IndexedDB version of this file. Still pure, still
  // client-side, and still the only place a missing role is defaulted.
  it('defaults a record with no role to standalone, never to base', () => {
    const upgraded = migrateDocumentRecord({ id: 'd', matterId: 'm', name: 'n' });
    expect(upgraded.role).toBe('standalone');
  });

  it('leaves a recognised role untouched', () => {
    expect(migrateDocumentRecord({ ...DOC, role: 'base' }).role).toBe('base');
    expect(migrateDocumentRecord({ ...DOC, role: 'varies' }).role).toBe('varies');
  });

  it('replaces an unrecognised role rather than passing it through', () => {
    expect(migrateDocumentRecord({ ...DOC, role: 'primary' }).role).toBe('standalone');
  });

  it('keeps every other field', () => {
    expect(migrateDocumentRecord(DOC)).toEqual(DOC);
  });
});

describe('the requests each export makes', () => {
  it('lists a matter s documents from /v1/matters/:id/documents, in the server s order', async () => {
    const list = [{ ...DOC, id: 'a' }, { ...DOC, id: 'b' }];
    apiGet.mockResolvedValue(list);
    expect((await listDocuments('m1')).map(d => d.id)).toEqual(['a', 'b']);
    expect(apiGet).toHaveBeenCalledWith('/v1/matters/m1/documents');
  });

  it('reads one from /v1/documents/:id', async () => {
    apiGetOrNull.mockResolvedValue(DOC);
    expect(await getDocument('d1')).toEqual(DOC);
    expect(apiGetOrNull).toHaveBeenCalledWith('/v1/documents/d1');
  });

  it('uploads the record and the bytes as ONE multipart request', async () => {
    // One request is what is left of the two-store transaction: the browser
    // cannot observe a torn write because there is only one call to fail.
    const bytes = new Blob(['hello world'], { type: 'application/pdf' });
    await addDocument(DOC, bytes);
    expect(apiSendBlob).toHaveBeenCalledTimes(1);
    const [path, form] = apiSendBlob.mock.calls[0] as [string, FormData];
    expect(path).toBe('/v1/documents');
    expect(JSON.parse(form.get('record') as string)).toEqual(DOC);
    const file = form.get('bytes') as File;
    expect(file.type).toBe('application/pdf');
    expect(await file.text()).toBe('hello world');
  });

  it('names the file part, because a part with no filename is refused by some servers', async () => {
    await addDocument({ ...DOC, name: 'redline.docx' }, new Blob(['x']));
    const form = apiSendBlob.mock.calls[0][1] as FormData;
    expect((form.get('bytes') as File).name).toBe('redline.docx');
  });

  it('PATCHes only role and collectionId when grouping', async () => {
    await setDocumentRole('d1', 'varies', 'c1');
    expect(apiSend).toHaveBeenCalledWith(
      'PATCH', '/v1/documents/d1/role', { role: 'varies', collectionId: 'c1' });
  });

  it('OMITS collectionId entirely when ungrouping, never sending it as undefined', async () => {
    // `structuredClone` preserves a `key: undefined` and JSON drops one,
    // which is how two stores come to disagree about whether a document is
    // in a collection. The absence is the assertion, so `toEqual` — which
    // cannot tell an absent key from an undefined one — is not enough.
    await setDocumentRole('d1', 'standalone');
    const body = apiSend.mock.calls[0][2] as Record<string, unknown>;
    expect('collectionId' in body).toBe(false);
    expect(body).toEqual({ role: 'standalone' });
  });

  it('DELETEs /v1/documents/:id', async () => {
    await deleteDocument('d1');
    expect(apiDelete).toHaveBeenCalledWith('/v1/documents/d1');
  });

  it('escapes an id in every path segment it builds', async () => {
    const id = 'a/b c?d';
    await getDocument(id);
    await setDocumentRole(id, 'standalone');
    await deleteDocument(id);
    expect(apiGetOrNull.mock.calls[0][0]).toBe('/v1/documents/a%2Fb%20c%3Fd');
    expect(apiSend.mock.calls[0][1]).toBe('/v1/documents/a%2Fb%20c%3Fd/role');
    expect(apiDelete.mock.calls[0][0]).toBe('/v1/documents/a%2Fb%20c%3Fd');
    await listDocuments(id);
    expect(apiGet.mock.calls[0][0]).toBe('/v1/matters/a%2Fb%20c%3Fd/documents');
  });
});

describe('a failure is a failure, never an empty result', () => {
  it('returns null for a document the server does not have', async () => {
    expect(await getDocument('nope')).toBeNull();
  });

  it('propagates a 500 from a read rather than swallowing it into null', async () => {
    // THE ONE THAT MATTERS. `getDocument` answering `null` over a 500 would
    // render "no such document" for a server that is simply broken.
    const boom = new ModelError('Server fell over.', 'unknown', 500);
    apiGetOrNull.mockRejectedValue(boom);
    await expect(getDocument('d1')).rejects.toBe(boom);
  });

  it('propagates a 500 from the list rather than answering with no documents', async () => {
    // The founding defect at its new surface: an empty documents pane over a
    // broken server is indistinguishable from a matter nobody has uploaded
    // to, and "Run a review" would offer zero documents with no explanation.
    const boom = new ModelError('Server fell over.', 'unknown', 500);
    apiGet.mockRejectedValue(boom);
    await expect(listDocuments('m1')).rejects.toBe(boom);
  });

  it('propagates an upload failure rather than reporting the document as added', async () => {
    const boom = new ModelError('Storage refused the file.', 'unknown', 500);
    apiSendBlob.mockRejectedValue(boom);
    await expect(addDocument(DOC, new Blob(['x']))).rejects.toBe(boom);
  });

  it('propagates a 404 from setDocumentRole rather than resolving silently', async () => {
    // A caller moving a document into a collection has a stale id, and
    // swallowing that leaves the collection pointing at a member this write
    // never happened for.
    const gone = new ModelError('Document d1 could not be found.', 'not_found', 404);
    apiSend.mockRejectedValue(gone);
    await expect(setDocumentRole('d1', 'varies', 'c1')).rejects.toBe(gone);
  });

  it('resolves quietly when the document to delete does not exist', async () => {
    apiDelete.mockRejectedValue(new ModelError('There is no such document.', 'not_found', 404));
    await expect(deleteDocument('gone')).resolves.toBeUndefined();
  });

  it('propagates a delete that could not remove the bytes', async () => {
    // The route answers 500 naming the keys it could not delete. Swallowing
    // it would make "deleting a document deletes its file" quietly false.
    const kept = new ModelError(
      'The records were deleted, but 1 document file could not be deleted from storage.',
      'unknown', 500);
    apiDelete.mockRejectedValue(kept);
    await expect(deleteDocument('d1')).rejects.toBe(kept);
  });
});
