import { describe, it, expect } from 'vitest';
import {
  detectDocxMarkup, markupNoticeFor,
  TRACKED_CHANGES_NOTICE, COMMENTS_NOTICE, MARKUP_UNCHECKED_NOTICE,
} from './docxMarkup';
import {
  buildDocx, buildDocxWithoutBody, CLEAN_BODY, TRACKED_BODY, COMMENTED_BODY, TABLE_BODY,
} from '../test/docxFixture';

describe('detectDocxMarkup', () => {
  it('detects an insertion', async () => {
    const markup = await detectDocxMarkup(await buildDocx(
      '<w:p><w:ins w:id="1"><w:r><w:t>added</w:t></w:r></w:ins></w:p>',
    ));
    expect(markup.hasTrackedChanges).toBe(true);
    expect(markup.hasComments).toBe(false);
  });

  it('detects a deletion', async () => {
    const markup = await detectDocxMarkup(await buildDocx(
      '<w:p><w:del w:id="1"><w:r><w:delText>gone</w:delText></w:r></w:del></w:p>',
    ));
    expect(markup.hasTrackedChanges).toBe(true);
  });

  it('detects both halves of a redlined sentence', async () => {
    const markup = await detectDocxMarkup(await buildDocx(TRACKED_BODY));
    expect(markup).toEqual({ hasTrackedChanges: true, hasComments: false });
  });

  it('detects margin comments', async () => {
    const markup = await detectDocxMarkup(await buildDocx(COMMENTED_BODY));
    expect(markup).toEqual({ hasTrackedChanges: false, hasComments: true });
  });

  it('reports a clean document as clean', async () => {
    const markup = await detectDocxMarkup(await buildDocx(CLEAN_BODY));
    expect(markup).toEqual({ hasTrackedChanges: false, hasComments: false });
  });

  // The false positive this detector was always going to have: `w:insideH`
  // and `w:insideV` are ordinary table-border elements present in a great
  // many perfectly clean documents, and both begin with the letters of
  // `w:ins`. A substring test for `<w:ins` alone would tell a lawyer their
  // clean document was redlined every time they uploaded one with a table
  // in it — which teaches them to ignore the warning.
  it('does not mistake table borders for tracked changes', async () => {
    const markup = await detectDocxMarkup(await buildDocx(TABLE_BODY));
    expect(markup).toEqual({ hasTrackedChanges: false, hasComments: false });
  });

  it('does not mistake a deleted field instruction for a tracked change on its own', async () => {
    // `w:delInstrText` is a field instruction inside a deletion; matching it
    // directly would be matching the letters, not the element name.
    const markup = await detectDocxMarkup(await buildDocx(
      '<w:p><w:r><w:delInstrText>PAGE</w:delInstrText></w:r></w:p>',
    ));
    expect(markup.hasTrackedChanges).toBe(false);
  });

  // A move is recorded as `w:moveFrom`/`w:moveTo`, not as a delete/insert
  // pair, so nothing above catches it and mammoth has no handler for it
  // either — a clause moved out of one section and into another would come
  // back rearranged with nothing said.
  it('detects a moved passage', async () => {
    const moved = await detectDocxMarkup(await buildDocx(`<w:p>
      <w:moveFrom w:id="1" w:author="Counterparty" w:date="2026-08-01T10:00:00Z">
        <w:r><w:delText>The Tenant shall insure.</w:delText></w:r>
      </w:moveFrom>
    </w:p>`));
    expect(moved.hasTrackedChanges).toBe(true);

    const landed = await detectDocxMarkup(await buildDocx(`<w:p>
      <w:moveTo w:id="2"><w:r><w:t>The Tenant shall insure.</w:t></w:r></w:moveTo>
    </w:p>`));
    expect(landed.hasTrackedChanges).toBe(true);
  });

  it('detects a self-closing insertion element', async () => {
    const markup = await detectDocxMarkup(await buildDocx('<w:p><w:ins/></w:p>'));
    expect(markup.hasTrackedChanges).toBe(true);
  });

  // The founding failure, one level up: a detector that answers "no tracked
  // changes" when what it means is "I could not look" is worse than no
  // detector, because the caller has no way to tell the two apart.
  it('rejects rather than reporting clean when the file cannot be unzipped', async () => {
    const notAZip = new TextEncoder().encode('this is not a zip file at all').buffer;
    await expect(detectDocxMarkup(notAZip)).rejects.toThrow();
  });

  it('rejects rather than reporting clean when the zip has no word/document.xml', async () => {
    await expect(detectDocxMarkup(await buildDocxWithoutBody())).rejects.toThrow(/document\.xml/);
  });
});

describe('markupNoticeFor', () => {
  it('says nothing about a clean document', () => {
    expect(markupNoticeFor({ hasTrackedChanges: false, hasComments: false })).toBeUndefined();
  });

  it('says what was done to the tracked changes, not merely that they exist', () => {
    const notice = markupNoticeFor({ hasTrackedChanges: true, hasComments: false });
    expect(notice).toBe(TRACKED_CHANGES_NOTICE);
    expect(notice).toContain('with all changes accepted');
  });

  it('names comments as excluded from the reviewed text', () => {
    expect(markupNoticeFor({ hasTrackedChanges: false, hasComments: true })).toBe(COMMENTS_NOTICE);
  });

  it('says both when both are present', () => {
    const notice = markupNoticeFor({ hasTrackedChanges: true, hasComments: true });
    expect(notice).toContain(TRACKED_CHANGES_NOTICE);
    expect(notice).toContain(COMMENTS_NOTICE);
  });

  it('the could-not-check notice does not claim the document is clean', () => {
    expect(MARKUP_UNCHECKED_NOTICE).toContain('could not be checked');
    expect(MARKUP_UNCHECKED_NOTICE).not.toContain('no tracked changes');
  });
});
