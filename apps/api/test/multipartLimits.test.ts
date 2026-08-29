import { describe, it, expect } from 'vitest';
import { buildTestApi } from './helpers/apiHarness.ts';

/**
 * Part 2A M2 — the multipart `record` field is governed by
 * `API_MAX_BODY_BYTES`, not by busboy's undeclared 1 MiB default.
 *
 * THE THIRD UNDECLARED CAP on the scanned-document ingest path (after
 * Fastify's own `bodyLimit` and nginx's `client_max_body_size`), and the
 * worst-behaved of the three: busboy TRUNCATES an oversized field rather
 * than erroring, and @fastify/multipart only notices a truncated field when
 * the part is labelled `application/json` — which `FormData.append` of a
 * string is not. So a `DocumentRecord` over 1,048,576 bytes (which is
 * `record.text`: the whole extracted text of a long lease bundle or an OCR'd
 * scan) reached `JSON.parse` cut mid-string and came back as *"the record
 * field is not JSON"*, blaming the browser's serialisation, naming no size,
 * and pointing at no key anyone could raise.
 *
 * No database needed: the fake `Db` answers every statement with no rows, so
 * a record that arrives INTACT is refused by the matter lookup ("there is no
 * matter …") while a TRUNCATED one is refused by `JSON.parse` first. Those
 * two refusals are the whole discriminator, and they are on opposite sides
 * of the parse.
 */

const PRINCIPAL = { issuer: 'https://issuer.example/realms/lexprompt', subject: 'sub-m2', groups: ['reviewers'] };
const BOUNDARY = '----lexpromptfieldsize';

function multipart(record: unknown, bytes: Buffer): {
  payload: Buffer; headers: Record<string, string>;
} {
  const head = Buffer.from(
    `--${BOUNDARY}\r\nContent-Disposition: form-data; name="record"\r\n\r\n`
    + `${JSON.stringify(record)}\r\n`
    + `--${BOUNDARY}\r\nContent-Disposition: form-data; name="bytes"; filename="lease.pdf"\r\n`
    + 'Content-Type: application/pdf\r\n\r\n', 'utf8');
  return {
    payload: Buffer.concat([head, bytes, Buffer.from(`\r\n--${BOUNDARY}--\r\n`, 'utf8')]),
    headers: { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` },
  };
}

/** A record whose serialised JSON is comfortably over busboy's 1 MiB
 *  default — `text` is the field that gets there in practice, and it is the
 *  one an OCR'd scan fills. */
function bigRecord(textBytes: number): Record<string, unknown> {
  return {
    id: 'doc-big', matterId: 'no-such-matter', name: 'lease.pdf', kind: 'pdf',
    text: 'x'.repeat(textBytes), byteSize: 4, addedAt: 1_700_000_000_000,
    addedByUserId: '', role: 'standalone',
  };
}

describe('the multipart record field is capped by API_MAX_BODY_BYTES, not by busboy', () => {
  it('reads a 1.2 MB record whole, rather than truncating it into invalid JSON', async () => {
    const { app } = buildTestApi({ principal: PRINCIPAL, maxBodyBytes: 16_777_216 });
    const form = multipart(bigRecord(1_200_000), Buffer.from([0x25, 0x50, 0x44, 0x46]));
    const res = await app.inject({
      method: 'POST', url: '/v1/documents',
      headers: { authorization: 'Bearer t', ...form.headers },
      payload: form.payload,
    });

    // THE DISCRIMINATOR. The truncated body died at `JSON.parse` with
    // "Unterminated string in JSON at position 1048576"; an intact one gets
    // as far as the matter lookup, which the fake `Db` answers with no rows.
    expect(res.json().error.message).not.toMatch(/is not JSON/);
    expect(res.statusCode).toBe(404);
    expect(res.json().error.message).toMatch(/There is no matter no-such-matter/);
    await app.close();
  });

  it('still reads a small record, so the cap did not simply disable the field', async () => {
    const { app } = buildTestApi({ principal: PRINCIPAL, maxBodyBytes: 16_777_216 });
    const form = multipart(bigRecord(100), Buffer.from([0x25, 0x50, 0x44, 0x46]));
    const res = await app.inject({
      method: 'POST', url: '/v1/documents',
      headers: { authorization: 'Bearer t', ...form.headers },
      payload: form.payload,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.message).toMatch(/There is no matter no-such-matter/);
    await app.close();
  });
});
