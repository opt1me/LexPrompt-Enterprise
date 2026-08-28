import { describe, it, expect } from 'vitest';
import { parseDocxRedlines } from './docxRedlines';
import {
  buildDocx, buildDocxWithComments, CLEAN_BODY, TABLE_BODY,
} from '../test/docxFixture';

// The global (jsdom) `Blob`, not `node:buffer`'s. `parseDocxRedlines` reads
// the file with `.arrayBuffer()` and hands the bytes to `jszip`, which
// type-checks with `instanceof ArrayBuffer` against the realm it loaded in
// (jsdom's, here). `node:buffer`'s `Blob.arrayBuffer()` produces an
// ArrayBuffer from Node's own realm, which fails that check under jsdom even
// though the bytes are correct — see the polyfill note in
// `vitest.setup.ts`. CLAUDE.md's "use node:buffer's Blob" warning is about a
// different failure (structuredClone mangling a jsdom Blob on its way
// through fake-indexeddb); nothing here touches IndexedDB, so it does not
// apply, and following it anyway reintroduces the realm mismatch.
function toBlob(bytes: ArrayBuffer): Blob {
  return new Blob([bytes]);
}

/**
 * Spike 1's worked example (`spike1-mammoth-tracked-changes.mjs`): a
 * landlord's-consent clause with the "absolute discretion" wording struck
 * and "not unreasonably withheld" wording inserted, both attributed to
 * the same author and date, plus a margin comment on a second paragraph.
 * mammoth returns only the accepted-changes text and drops the comment
 * with no message — this is exactly what this module exists to recover.
 */
const REDLINE_BODY = `<w:p>
  <w:r><w:t xml:space="preserve">Consent may be </w:t></w:r>
  <w:del w:id="1" w:author="A Lawyer" w:date="2026-01-05T10:00:00Z">
    <w:r><w:delText xml:space="preserve">withheld at the Landlord's absolute discretion</w:delText></w:r>
  </w:del>
  <w:ins w:id="2" w:author="A Lawyer" w:date="2026-01-05T10:00:00Z">
    <w:r><w:t xml:space="preserve">withheld only where it is reasonable to do so</w:t></w:r>
  </w:ins>
  <w:r><w:t>.</w:t></w:r>
</w:p>
<w:p>
  <w:commentRangeStart w:id="99"/>
  <w:r><w:t>The Tenant shall pay all costs.</w:t></w:r>
  <w:commentRangeEnd w:id="99"/>
  <w:r><w:commentReference w:id="99"/></w:r>
</w:p>`;

const REDLINE_COMMENTS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:comment w:id="99" w:author="A Lawyer" w:date="2026-01-05T10:05:00Z" w:initials="AL">
<w:p><w:r><w:t>We never accept an uncapped costs indemnity.</w:t></w:r></w:p>
</w:comment>
</w:comments>`;

/** A clause moved from one place in the document to another: recorded by
 *  Word as `w:moveFrom`/`w:moveTo`, never as `w:del`/`w:ins`. R-F3 exists so
 *  this is not reported as an unrelated deletion and an unrelated
 *  insertion. */
const MOVE_BODY = `<w:p>
  <w:moveFrom w:id="1" w:author="Counterparty" w:date="2026-08-01T10:00:00Z">
    <w:r><w:delText>The Tenant shall insure the Premises.</w:delText></w:r>
  </w:moveFrom>
</w:p>
<w:p>
  <w:moveTo w:id="2" w:author="Counterparty" w:date="2026-08-01T10:00:00Z">
    <w:r><w:t>The Tenant shall insure the Premises.</w:t></w:r>
  </w:moveTo>
</w:p>`;

async function trackedChangesDocx(): Promise<Blob> {
  return toBlob(await buildDocxWithComments(REDLINE_BODY, REDLINE_COMMENTS));
}

async function cleanDocx(): Promise<Blob> {
  return toBlob(await buildDocx(CLEAN_BODY));
}

async function docxWithTableBorders(): Promise<Blob> {
  return toBlob(await buildDocx(TABLE_BODY));
}

async function docxWithMove(): Promise<Blob> {
  return toBlob(await buildDocx(MOVE_BODY));
}

describe('parseDocxRedlines', () => {
  it('reads an insertion with its author and date', async () => {
    const out = await parseDocxRedlines(await trackedChangesDocx());
    const ins = out.edits.find(e => e.kind === 'insertion')!;
    expect(ins.text).toBe('withheld only where it is reasonable to do so');
    expect(ins.author).toBe('A Lawyer');
    expect(new Date(ins.at!).getUTCFullYear()).toBe(2026);
  });

  it('reads a deletion from w:delText, which mammoth discards entirely', async () => {
    const out = await parseDocxRedlines(await trackedChangesDocx());
    expect(out.edits.find(e => e.kind === 'deletion')!.text)
      .toBe("withheld at the Landlord's absolute discretion");
  });

  it('gives every edit the surrounding paragraph as context', async () => {
    const out = await parseDocxRedlines(await trackedChangesDocx());
    // Context must contain BOTH sides — the original wording and the new one —
    // or a reader cannot see what the change actually did.
    const ins = out.edits.find(e => e.kind === 'insertion')!;
    expect(ins.context).toContain('Consent may be');
    expect(ins.context).toContain("withheld at the Landlord's absolute discretion");
    expect(ins.context).toContain('withheld only where it is reasonable to do so');
  });

  it('reads a margin comment with its author', async () => {
    const out = await parseDocxRedlines(await trackedChangesDocx());
    const c = out.edits.find(e => e.kind === 'comment')!;
    expect(c.text).toBe('We never accept an uncapped costs indemnity.');
    expect(c.context).toContain('The Tenant shall pay all costs.');
  });

  it('reports a clean document as having no markup, without throwing', async () => {
    const out = await parseDocxRedlines(await cleanDocx());
    expect(out.hasMarkup).toBe(false);
    expect(out.edits).toEqual([]);
  });

  it('THROWS on a file it cannot read, rather than reporting no markup', async () => {
    // "No tracked changes" and "could not look" must never collapse. A
    // detector that reports clean when it could not look is the founding
    // defect one level up.
    await expect(parseDocxRedlines(new Blob(['not a zip']))).rejects.toThrow();
  });

  it('does not mistake w:insideH for an insertion', async () => {
    // A real OOXML table-border element. Matching the letters rather than the
    // element name is the false positive waiting to happen here.
    const out = await parseDocxRedlines(await docxWithTableBorders());
    expect(out.hasMarkup).toBe(false);
  });

  it('labels a move rather than reporting an unrelated deletion and insertion (R-F3)', async () => {
    const out = await parseDocxRedlines(await docxWithMove());
    expect(out.edits.filter(e => e.kind === 'moved')).toHaveLength(2);
    expect(out.edits.some(e => e.kind === 'deletion')).toBe(false);
  });
});
