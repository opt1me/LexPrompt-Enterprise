import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { mount, buttonNamed, click } from '../../test/mount';
import { IntakeWizard } from './IntakeWizard';
import type { DocumentRecord, Matter } from '../../types';

const matter: Matter = { id: 'm1', name: 'Ackroyd v Bell', ownerId: 'me', createdAt: 1, updatedAt: 1 };

function doc(over: Partial<DocumentRecord> = {}): DocumentRecord {
  return {
    id: 'd1', matterId: 'm1', name: 'Lease.pdf', kind: 'pdf',
    text: '[Page 1]\nThis lease is made between the parties on the date written below, and continues.',
    byteSize: 100, addedAt: 1, addedByUserId: 'me', role: 'standalone', ...over,
  };
}

const wiring = {
  documentsError: null,
  onRetryDocuments: () => {},
  onAddDocuments: async () => {},
  onRemoveDocument: async () => {},
  onCreateCollection: async () => {},
  playbooks: [],
  playbooksError: null,
  onRetryPlaybooks: () => {},
  onRunReview: async () => {},
  onCreatePlaybook: () => {},
  modelId: 'anthropic/claude-3.5-sonnet',
  onOpenSettings: () => {},
};

describe('IntakeWizard — the tracker and step 1', () => {
  it('shows the three steps and names the matter', () => {
    const c = mount(<IntakeWizard matter={matter} documents={[]} {...wiring} />);
    expect(c.textContent).toContain('Matter');
    expect(c.textContent).toContain('Documents');
    expect(c.textContent).toContain('Playbook');
    expect(c.textContent).toContain('Ackroyd v Bell');
  });

  it('carries the storage disclosure in its footer, in the shipped words', () => {
    const c = mount(<IntakeWizard matter={matter} documents={[]} {...wiring} />);
    expect(c.textContent).toContain("this browser's IndexedDB — on this device, in this browser, and nowhere else");
  });

  it('names the model and offers a way to change it', () => {
    const c = mount(<IntakeWizard matter={matter} documents={[]} {...wiring} />);
    expect(c.textContent).toContain('anthropic/claude-3.5-sonnet');
    expect(buttonNamed(c, /Settings/)).toBeTruthy();
  });
});

describe('IntakeWizard — step 2 reports what ingestion actually produced', () => {
  it('shows a parse failure inline, with a way to remove the document', () => {
    const c = mount(<IntakeWizard matter={matter} documents={[doc({ parseError: 'This PDF is encrypted and could not be read.' })]} {...wiring} />);
    expect(c.textContent).toContain('This PDF is encrypted and could not be read.');
    expect(buttonNamed(c, /Remove/)).toBeTruthy();
  });

  it('does not draw a progress bar for OCR the app does not perform', () => {
    // R-G13. The app does not OCR; a progress bar for work it never does is
    // the exact failure the state-preservation rule forbids.
    const c = mount(<IntakeWizard matter={matter} documents={[doc({ text: '' })]} {...wiring} />);
    expect(c.textContent).not.toMatch(/OCR|Running OCR|\d+%/);
  });

  it('says plainly that a scanned document needs a vision-capable model', () => {
    const c = mount(<IntakeWizard matter={matter} documents={[doc({ text: '[Page 1]\n \n[Page 2]\n ' })]} {...wiring} />);
    expect(c.textContent).toContain('No text could be extracted');
    expect(c.textContent).toContain('vision-capable model');
  });

  it('carries a tracked-changes notice where one was recorded', () => {
    const c = mount(<IntakeWizard matter={matter} documents={[doc({ kind: 'docx', markupNotice: 'This document contains tracked changes; they were accepted before extraction.' })]} {...wiring} />);
    expect(c.textContent).toContain('This document contains tracked changes; they were accepted before extraction.');
  });

  it('proposes a collection without creating one', () => {
    const onCreateCollection = vi.fn(async () => {});
    const c = mount(<IntakeWizard
      matter={matter}
      documents={[doc({ id: 'd1', name: 'Ackroyd Lease.pdf' }), doc({ id: 'd2', name: 'Ackroyd Lease - Deed of Variation.pdf' })]}
      {...wiring}
      onCreateCollection={onCreateCollection}
    />);
    expect(c.textContent).toMatch(/read together|collection/i);
    // R-C4: proposed, never created. Nothing has been grouped until the
    // reader accepts it.
    expect(onCreateCollection).not.toHaveBeenCalled();
    click(buttonNamed(c, /Group these/));
    expect(onCreateCollection).toHaveBeenCalledTimes(1);
  });

  it('renders the load-error panel instead of the document list when documents cannot be read', () => {
    const c = mount(<IntakeWizard matter={matter} documents={[]} {...wiring} documentsError="This matter's documents could not be loaded." />);
    expect(c.textContent).toContain("This matter's documents could not be loaded.");
    expect(buttonNamed(c, /^Retry$/)).toBeTruthy();
  });
});
