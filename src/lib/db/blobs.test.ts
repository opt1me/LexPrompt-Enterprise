import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ModelError } from '@lexprompt/core';

/**
 * `getDocumentBlob`, now a TRANSPORT.
 *
 * The byte-fidelity assertion this file used to carry — that a `.pdf` comes
 * back with the same size, type and content it went in with — moved to
 * `apps/api/test/blobStore.compose.test.ts`, which puts a 0x00 and a 0xFF
 * through real Azurite from inside the real container. A jsdom `Blob` round
 * trip through a mocked `fetch` could not have caught the UTF-8 conversion
 * that test exists to catch.
 *
 * What stays here is the distinction the whole function is FOR: `null` means
 * "no bytes on record", and it means nothing else. A `getDocumentBlob` that
 * answered `null` for a 500 or an expired session would tell a reader their
 * document's file cannot be opened, over a server that is merely refusing
 * us — and the record would look like the partial-write case the `null` was
 * written for.
 */

const apiGetBlob = vi.fn();

vi.mock('../api/client', () => ({
  apiGetBlob: (...args: unknown[]) => apiGetBlob(...args),
}));

const { getDocumentBlob } = await import('./blobs');

beforeEach(() => {
  apiGetBlob.mockReset().mockResolvedValue(null);
});

describe('getDocumentBlob', () => {
  it('reads from /v1/documents/:id/bytes', async () => {
    await getDocumentBlob('d1');
    expect(apiGetBlob).toHaveBeenCalledWith('/v1/documents/d1/bytes');
  });

  it('escapes the id rather than losing it', async () => {
    await getDocumentBlob('a/b c?d');
    expect(apiGetBlob).toHaveBeenCalledWith('/v1/documents/a%2Fb%20c%3Fd/bytes');
  });

  it('returns the blob the server sent, untouched', async () => {
    const bytes = new Blob(['hello world'], { type: 'application/pdf' });
    apiGetBlob.mockResolvedValue(bytes);
    const back = await getDocumentBlob('d1');
    expect(back).toBe(bytes);
  });

  it('returns null, not a throw, when no bytes are on record', async () => {
    // KEPT from the IndexedDB version, and still the reason this function
    // exists: a `DocumentRecord` can outlive its bytes, and the UI must
    // still show that document's metadata with an "unavailable" state
    // rather than the whole view blowing up.
    await expect(getDocumentBlob('nope')).resolves.toBeNull();
  });

  it('propagates a genuine failure rather than returning null for it', async () => {
    // KEPT, and now load-bearing against a NETWORK rather than a disk: over
    // HTTP this fires routinely. A 500 answered as `null` would render
    // "this document's file cannot be opened" over a store that is up.
    const boom = new ModelError('Storage is unreachable.', 'unknown', 500);
    apiGetBlob.mockRejectedValue(boom);
    await expect(getDocumentBlob('d1')).rejects.toBe(boom);
  });

  it('propagates an expired session rather than reporting the file as missing', async () => {
    const expired = new ModelError('Sign in to use LexPrompt.', 'sign_in_required', 401);
    apiGetBlob.mockRejectedValue(expired);
    await expect(getDocumentBlob('d1')).rejects.toBe(expired);
  });
});
