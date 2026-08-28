import React from 'react';
import { describe, it, expect } from 'vitest';
import { mount } from '../../test/mount';
import { TemplateLibrary } from './TemplateLibrary';
import { SCHEMA_VERSION, type Playbook, type PlaybookDraft } from '../../types';

const noop = () => {};
const wiring = {
  onOpen: noop,
  onRun: noop,
  onDelete: noop,
  onCreate: noop,
  onImport: noop,
};

function draft(overrides: Partial<PlaybookDraft> = {}): PlaybookDraft {
  return {
    name: 'Lease Review',
    contractType: 'Lease',
    systemPrompt: 'You are a reviewer.',
    formatPrompt: 'Quote verbatim.',
    clauses: [],
    changeSummary: '',
    ...overrides,
  };
}

function playbook(overrides: Partial<Playbook> = {}): Playbook {
  return {
    id: 'pb1',
    name: 'Lease Review',
    createdAt: 1,
    updatedAt: 2,
    currentVersionId: 'v1',
    schemaVersion: SCHEMA_VERSION,
    ...overrides,
  };
}

// Task 9A / M2. The badge itself has always been written correctly; what it
// depended on was unreachable. Nothing in the app ever wrote a
// `Playbook.draft`, so before Task 9A wired `saveDraft` this row could not
// render for any playbook the user actually owned — a UI element promising
// a state the app could not reach. These tests pin the three rows apart so
// they cannot converge again.
describe('TemplateLibrary — the screen names itself the way the nav does', () => {
  it('is headed "Playbooks", not "Library"', () => {
    // The nav tab was renamed Library -> Playbooks, but this heading was
    // missed: clicking "Playbooks" landed on a page titled "Library". It
    // survived the rename's own verification sweep because that grep
    // filtered out the string "TemplateLibrary" to drop component-name
    // noise, and `grep -n` prefixes every line with the filename — so the
    // filter also hid every genuine match inside this very file.
    const c = mount(<TemplateLibrary templates={[]} {...wiring} />);
    expect(c.querySelector('h2')?.textContent).toBe('Playbooks');
    expect(c.querySelector('h2')?.textContent).not.toMatch(/library/i);
  });
});

describe('TemplateLibrary — a row says which of three states the playbook is in', () => {
  it('says "Unpublished changes" when a draft is stored against the playbook', () => {
    const c = mount(<TemplateLibrary templates={[playbook({ draft: draft() })]} {...wiring} />);
    expect(c.textContent).toMatch(/unpublished changes/i);
  });

  it('says when it was updated for a published playbook with no stored draft', () => {
    const c = mount(<TemplateLibrary templates={[playbook()]} {...wiring} />);
    expect(c.textContent).not.toMatch(/unpublished changes/i);
    expect(c.textContent).toMatch(/updated/i);
  });

  // "Never published" and "published, with edits on top" are different
  // facts, and only one of them means a review would run nothing.
  it('says a playbook with no published version has not been published', () => {
    const notPublished = playbook();
    delete notPublished.currentVersionId;
    const c = mount(<TemplateLibrary templates={[notPublished]} {...wiring} />);
    expect(c.textContent).toMatch(/not published yet/i);
    expect(c.textContent).not.toMatch(/unpublished changes/i);
  });
});
