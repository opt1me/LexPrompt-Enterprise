import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { mount, buttonNamed, click } from '../../test/mount';
import { IntakeWizard } from './IntakeWizard';
import type { Matter, Playbook } from '../../types';
import { STORAGE_PRIVACY } from '../../lib/privacyCopy';

const matter: Matter = { id: 'm1', name: 'Ackroyd v Bell', ownerId: 'me', createdAt: 1, updatedAt: 1 };

const wiring = {
  onAddDocuments: async () => {},
  playbooks: [],
  playbooksError: null,
  onRetryPlaybooks: () => {},
  onCreatePlaybook: () => {},
  modelChoiceId: 'anthropic/claude-3.5-sonnet',
  onOpenSettings: () => {},
};

describe('IntakeWizard — the tracker and step 1', () => {
  it('shows the three steps and names the matter', () => {
    const c = mount(<IntakeWizard matter={matter} {...wiring} />);
    expect(c.textContent).toContain('Matter');
    expect(c.textContent).toContain('Documents');
    expect(c.textContent).toContain('Playbook');
    expect(c.textContent).toContain('Ackroyd v Bell');
  });

  it('carries the storage disclosure in its footer, in the shipped words', () => {
    // The SHIPPED words, read from the one module they live in rather than
    // transcribed here: this assertion used to quote "this browser's
    // IndexedDB — on this device, in this browser, and nowhere else", which
    // Stage 2 made false (the records are in the firm's own service now).
    // Quoting `privacyCopy.ts` means the next rewrite of the disclosure
    // cannot leave a test asserting a sentence the app no longer says.
    const c = mount(<IntakeWizard matter={matter} {...wiring} />);
    expect(c.textContent).toContain(STORAGE_PRIVACY[0]);
    expect(STORAGE_PRIVACY[0]).toContain("your firm's own LexPrompt service");
    expect(c.textContent).not.toContain('IndexedDB');
  });

  it('names the model and offers a way to change it', () => {
    const c = mount(<IntakeWizard matter={matter} {...wiring} />);
    expect(c.textContent).toContain('anthropic/claude-3.5-sonnet');
    expect(buttonNamed(c, /Settings/)).toBeTruthy();
  });
});

describe('IntakeWizard — step 2 offers the only thing it can', () => {
  it('offers a file picker and nothing that presumes a document already exists', () => {
    // This screen renders only while the matter is empty (`MatterHome`'s
    // `documents.length === 0` branch), so a document list, a per-document
    // disclosure or a collection suggestion here could never reach a user.
    // Those all used to live in this file and were tested by mounting a
    // `documents` array the call site cannot produce — a suite that proved
    // the branches existed and nothing about their reachability. The scan
    // disclosure was among them, and it existed nowhere else in the app.
    // It now lives in `DocumentNotices`, rendered by the lists that can
    // actually hold a document; the assertions below pin that this screen
    // does not grow a second, unreachable copy of it.
    const c = mount(<IntakeWizard matter={matter} {...wiring} />);
    expect(c.querySelectorAll('input[type="file"]')).toHaveLength(1);
    expect(c.textContent).not.toContain('No text could be extracted');
    expect(c.textContent).not.toMatch(/read together/i);
    expect(buttonNamed(c, /^Remove/)).toBeUndefined();
  });

  // sr-only sweep (final behaviour review's leftover): this file input is
  // `sr-only` (Tailwind: `position: absolute`) so the dashed drop-zone
  // `<label>` around it stays the clickable/visible surface. Without a
  // positioned ancestor its containing block is the document root rather
  // than the label — the same pattern that, on the review screen's finding
  // scroller, extended the document to 14,570px and produced a whole-window
  // scrollbar over blank space.
  it('the drop-zone label is a positioned ancestor for its sr-only file input', () => {
    const c = mount(<IntakeWizard matter={matter} {...wiring} />);
    const input = c.querySelector('input[type="file"]') as HTMLInputElement;
    expect(input.className).toMatch(/(?:^|\s)sr-only(?:\s|$)/);
    expect(input.parentElement!.tagName).toBe('LABEL');
    expect(input.parentElement!.className).toMatch(/(?:^|\s)relative(?:\s|$)/);
  });

  it('does not draw a progress bar for OCR the app does not perform', () => {
    // R-G13. The app does not OCR; a progress bar for work it never does is
    // the exact failure the state-preservation rule forbids. Its honest
    // replacement is the scan sentence, and that is asserted at the call
    // site that can actually show it (`MatterHome.test.tsx`).
    const c = mount(<IntakeWizard matter={matter} {...wiring} />);
    expect(c.textContent).not.toMatch(/OCR|Running OCR|\d+%/);
  });
});

describe('IntakeWizard — step 3 shows the playbooks without promising a run', () => {
  const playbook = (id: string, name: string, updatedAt: number): Playbook =>
    ({ id, name, createdAt: 1, updatedAt, currentVersionId: `v-${id}`, schemaVersion: 6 });

  it('lists the user’s playbooks, most recently used first', () => {
    const c = mount(<IntakeWizard
      matter={matter}
      {...wiring}
      playbooks={[playbook('p1', 'Old lease', 100), playbook('p2', 'Recent lease', 900)]}
    />);
    const names = Array.from(c.querySelectorAll('[data-playbook-name]')).map(el => el.textContent);
    expect(names).toEqual(['Recent lease', 'Old lease']);
  });

  it('offers no "Run this playbook" while the matter has nothing to run it over', () => {
    // This screen exists only for an empty matter, so a live run button
    // promised a review of documents that do not exist — it landed the
    // reader on the run screen with an empty file list. The step is still
    // shown, and it says what is missing instead.
    const c = mount(<IntakeWizard matter={matter} {...wiring} playbooks={[playbook('p1', 'Lease', 1)]} />);
    expect(buttonNamed(c, /Run this playbook/)).toBeUndefined();
    expect(c.textContent).toContain('Add a document above first');
  });

  it('offers a route to create one when there are none, rather than an empty list', () => {
    const onCreatePlaybook = vi.fn();
    const c = mount(<IntakeWizard matter={matter} {...wiring} onCreatePlaybook={onCreatePlaybook} />);
    expect(c.textContent).toContain('You have no playbooks yet');
    click(buttonNamed(c, /Create a playbook/));
    expect(onCreatePlaybook).toHaveBeenCalled();
  });

  it('renders the load-error panel instead of the playbook list when the library cannot be read', () => {
    const c = mount(<IntakeWizard matter={matter} {...wiring} playbooksError="The playbook library could not be loaded." />);
    expect(c.textContent).toContain('The playbook library could not be loaded.');
    expect(c.textContent).not.toContain('You have no playbooks yet');
  });

  it('never suggests which playbook to use', () => {
    // R-G12: "These look like a commercial lease…" is a model call with a
    // prompt contract, a cost, and a confidently-wrong-at-the-worst-moment
    // failure mode. None of that is a styling decision.
    const c = mount(<IntakeWizard matter={matter} {...wiring} playbooks={[playbook('p1', 'Lease', 1)]} />);
    expect(c.textContent).not.toMatch(/these look like|we suggest|recommended for these/i);
  });
});
