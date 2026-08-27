import JSZip from 'jszip';

/**
 * Builds real `.docx` packages for tests, in memory.
 *
 * Not a checked-in binary: a committed `.docx` cannot be read in a diff, so
 * nobody reviewing a change to the tracked-changes detector could see what
 * it is being asked to detect, and nobody could tell a fixture with an
 * insertion in it from one without. Assembling the zip here keeps the
 * markup under review as source.
 *
 * Shared by `src/lib/docxMarkup.test.ts` (the detector) and
 * `src/lib/documents.test.ts` (the ingest path that calls it) rather than
 * copied into each — two fixtures that are meant to be the same document
 * and quietly stop being it is the drift this project keeps paying for.
 */

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`;

const RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

function documentXml(body: string): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>${body}</w:body>
</w:document>`;
}

/** A `.docx` wrapping the given `<w:body>` contents — the three parts Word
 *  and mammoth both need, and nothing else. */
export function buildDocx(body: string): Promise<ArrayBuffer> {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', CONTENT_TYPES);
  zip.file('_rels/.rels', RELS);
  zip.file('word/document.xml', documentXml(body));
  return zip.generateAsync({ type: 'arraybuffer' });
}

/** A `.docx` package missing its body part — a file that opens as a zip but
 *  cannot be checked. */
export function buildDocxWithoutBody(): Promise<ArrayBuffer> {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', CONTENT_TYPES);
  zip.file('_rels/.rels', RELS);
  return zip.generateAsync({ type: 'arraybuffer' });
}

export const CLEAN_BODY = '<w:p><w:r><w:t>The Tenant shall pay all costs.</w:t></w:r></w:p>';

/**
 * Spike 1's worked example as OOXML: one sentence half deleted and half
 * inserted. mammoth returns only "Consent may be withheld only where it is
 * reasonable to do so." from this — the counterparty's position, presented
 * as the contract — with `messages: []`.
 */
export const TRACKED_BODY = `<w:p>
  <w:r><w:t xml:space="preserve">Consent may be </w:t></w:r>
  <w:del w:id="1" w:author="Counterparty" w:date="2026-08-01T10:00:00Z">
    <w:r><w:delText>withheld at the Landlord's absolute discretion</w:delText></w:r>
  </w:del>
  <w:ins w:id="2" w:author="Counterparty" w:date="2026-08-01T10:00:00Z">
    <w:r><w:t>withheld only where it is reasonable to do so</w:t></w:r>
  </w:ins>
  <w:r><w:t>.</w:t></w:r>
</w:p>`;

export const COMMENTED_BODY = `<w:p>
  <w:commentRangeStart w:id="0"/>
  <w:r><w:t>The Tenant shall pay all costs.</w:t></w:r>
  <w:commentRangeEnd w:id="0"/>
  <w:r><w:commentReference w:id="0"/></w:r>
</w:p>`;

/** A clean document that happens to contain a table — i.e. one carrying
 *  `<w:insideH>`/`<w:insideV>` border elements, the false positive the
 *  detector's element-name matching exists to avoid. */
export const TABLE_BODY = `<w:tbl>
  <w:tblPr>
    <w:tblBorders>
      <w:insideH w:val="single" w:sz="4" w:color="auto"/>
      <w:insideV w:val="single" w:sz="4" w:color="auto"/>
    </w:tblBorders>
  </w:tblPr>
  <w:tr><w:tc><w:p><w:r><w:t>Rent</w:t></w:r></w:p></w:tc></w:tr>
</w:tbl>`;
