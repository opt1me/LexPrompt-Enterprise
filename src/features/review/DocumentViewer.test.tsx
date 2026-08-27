import React from 'react';
import { describe, it, expect } from 'vitest';
import { mount } from '../../test/mount';
import { DocumentViewer } from './DocumentViewer';
import { TRACKED_CHANGES_NOTICE, MARKUP_UNCHECKED_NOTICE } from '../../lib/docxMarkup';
import type { DocumentFile } from '../../types';

function docxDoc(over: Partial<DocumentFile> = {}): DocumentFile {
  return {
    id: 'd1',
    name: 'lease.docx',
    text: 'Consent may be withheld only where it is reasonable to do so.',
    file: new File([], 'lease.docx'),
    kind: 'docx',
    ...over,
  };
}

describe('DocumentViewer: the markup notice', () => {
  // It has to be here, beside the text and beside the findings — not only in
  // a toast at upload. The person reading a review is often not the person
  // who uploaded the file, and is reading it after the toast is long gone.
  it('shows the notice above the document text', () => {
    const container = mount(<DocumentViewer doc={docxDoc({ markupNotice: TRACKED_CHANGES_NOTICE })} highlights={[]} />);
    expect(container.textContent).toContain(TRACKED_CHANGES_NOTICE);
  });

  it('still shows the document text — the notice is a caveat, not a refusal', () => {
    const doc = docxDoc({ markupNotice: TRACKED_CHANGES_NOTICE });
    const container = mount(<DocumentViewer doc={doc} highlights={[]} />);
    expect(container.textContent).toContain(doc.text);
    expect(container.textContent).not.toContain('Could not read this file');
  });

  it('shows the could-not-check notice with the same prominence', () => {
    const container = mount(<DocumentViewer doc={docxDoc({ markupNotice: MARKUP_UNCHECKED_NOTICE })} highlights={[]} />);
    expect(container.textContent).toContain(MARKUP_UNCHECKED_NOTICE);
  });

  it('says nothing at all about a document with no notice', () => {
    const container = mount(<DocumentViewer doc={docxDoc()} highlights={[]} />);
    expect(container.textContent).not.toContain('tracked changes');
    expect(container.textContent).toContain('Consent may be withheld');
  });

  it('an unreadable document still renders its parse error, not a markup notice', () => {
    const doc = docxDoc({ parseError: 'corrupt file', markupNotice: TRACKED_CHANGES_NOTICE });
    const container = mount(<DocumentViewer doc={doc} highlights={[]} />);
    expect(container.textContent).toContain('Could not read this file: corrupt file');
  });
});
