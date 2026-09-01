import React from 'react';
import { describe, it, expect } from 'vitest';
import { mount, click } from '../../test/mount';
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

/*
 * COPY DRIFT, THE SAME ONE AS THE HEADING ABOVE, ONE ROUND LATER.
 *
 * The redesign renamed Library → Playbooks. The `<h2>` was fixed when that
 * was caught; the button under it still said "Create Template", the empty
 * state still said "No templates yet", and the delete dialog still called a
 * playbook a template — a page headed Playbooks whose every control names
 * something else. Found in a browser, exactly as the heading was.
 *
 * This guards the screen as a whole rather than the four strings that were
 * wrong, because "the strings that were wrong" is the list that already
 * failed to stay complete once. It reads `innerHTML`, not `textContent`, so
 * a `title` attribute is covered too — that is where one of the four was
 * hiding.
 */
describe('TemplateLibrary — nothing visible on the Playbooks screen calls a playbook a template', () => {
  /** The delete dialog is rendered only while it is open, so the scan has to
   *  open it or it would be scanning a screen the copy is not on. */
  function openDeleteDialog(c: HTMLElement): void {
    const trash = Array.from(c.querySelectorAll('button'))
      .find(b => /delete/i.test(b.getAttribute('title') ?? ''));
    if (!trash) throw new Error('The delete control is not on this screen.');
    click(trash);
  }

  it('scans a screen that actually has content on it', () => {
    // The sanity half. A guard over an empty container passes vacuously,
    // and eighteen guards in this project were found not guarding.
    const c = mount(<TemplateLibrary templates={[playbook()]} {...wiring} />);
    openDeleteDialog(c);
    expect(c.innerHTML.length).toBeGreaterThan(500);
    expect(c.textContent).toContain('Playbooks');
    expect(c.textContent).toContain('permanently delete');
  });

  it('says "template" nowhere, in text or in a title attribute', () => {
    const c = mount(<TemplateLibrary templates={[playbook()]} {...wiring} />);
    openDeleteDialog(c);
    expect(c.innerHTML).not.toMatch(/template/i);
  });

  it('names the empty state after playbooks too', () => {
    const c = mount(<TemplateLibrary templates={[]} {...wiring} />);
    expect(c.textContent).toContain('No playbooks yet.');
    expect(c.innerHTML).not.toMatch(/template/i);
  });
});
