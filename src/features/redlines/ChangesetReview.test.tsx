import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { mount, click, buttonNamed, textbox, type } from '../../test/mount';
import { ChangesetReview, decisionCounts } from './ChangesetReview';
import type { Changeset, ChangesetItem, PlaybookVersion } from '../../types';

function item(overrides: Partial<ChangesetItem> = {}): ChangesetItem {
  return {
    id: 'i1',
    kind: 'drift',
    clauseId: 'c1',
    currentText: 'Tenant may not assign without landlord consent.',
    proposedText: 'Tenant may assign to an affiliate without consent.',
    rationale: 'The tenant struck the consent requirement for affiliate transfers.',
    basis: [{
      documentId: 'd1',
      kind: 'deletion',
      text: 'without landlord consent',
      context: '... without landlord consent.',
      clauseRef: 'Assignment',
      source: 'tracked',
    }],
    decision: 'open',
    ...overrides,
  };
}

function newClauseItem(overrides: Partial<ChangesetItem> = {}): ChangesetItem {
  const base = item({
    id: 'i2',
    kind: 'new_clause',
    currentText: undefined,
    rationale: 'Raised in this deal though the playbook has no clause for it.',
    basis: [{
      documentId: 'd1',
      kind: 'insertion',
      text: 'pandemic carve-out',
      context: 'Includes a pandemic carve-out.',
      clauseRef: 'Force Majeure',
      source: 'tracked',
    }],
  });
  delete base.clauseId;
  return { ...base, ...overrides };
}

function confirmItem(overrides: Partial<ChangesetItem> = {}): ChangesetItem {
  return item({
    id: 'i3',
    kind: 'confirm',
    proposedText: 'Tenant may not assign without landlord consent.',
    rationale: 'This deal kept our standard assignment wording untouched.',
    ...overrides,
  });
}

const version: PlaybookVersion = {
  id: 'v1',
  playbookId: 'pb1',
  version: 4,
  name: 'Commercial Lease',
  contractType: 'Lease',
  systemPrompt: 'sys',
  formatPrompt: 'fmt',
  clauses: [],
  changeSummary: '',
  publishedAt: 1,
  publishedByUserId: 'u1',
  schemaVersion: 7,
};

function baseChangeset(overrides: Partial<Changeset> = {}): Changeset {
  return {
    id: 'cs1',
    playbookId: 'pb1',
    fromVersionId: 'v1',
    sourceSummary: 'Brookvale Retail Park — our markup + executed, Jul 2026',
    items: [item()],
    createdAt: Date.now(),
    createdByUserId: 'u1',
    ...overrides,
  };
}

function baseProps(overrides: Partial<React.ComponentProps<typeof ChangesetReview>> = {}) {
  return {
    changeset: baseChangeset(),
    fromVersion: version,
    onDecide: vi.fn(),
    onPublish: vi.fn(),
    ...overrides,
  };
}

describe('ChangesetReview', () => {
  it('says plainly that nothing changes in the live version until publish', () => {
    const el = mount(<ChangesetReview {...baseProps()} />);
    expect(el.textContent).toMatch(/nothing changes .* until you publish/i);
  });

  it('keeps saying so even once every item has been decided', () => {
    const el = mount(<ChangesetReview {...baseProps({ changeset: baseChangeset({ items: [item({ decision: 'accepted' })] }) })} />);
    expect(el.textContent).toMatch(/nothing changes .* until you publish/i);
  });

  it('shows the version transition and the source line', () => {
    const el = mount(<ChangesetReview {...baseProps()} />);
    expect(el.textContent).toContain('v4');
    expect(el.textContent).toContain('v5');
    expect(el.textContent).toContain('Brookvale Retail Park');
  });

  it('shows category counts across confirm, drift and new clauses', () => {
    const cs = baseChangeset({ items: [item(), newClauseItem(), confirmItem()] });
    const el = mount(<ChangesetReview {...baseProps({ changeset: cs })} />);
    expect(el.textContent).toMatch(/1 confirm/);
    expect(el.textContent).toMatch(/1 drift/);
    expect(el.textContent).toMatch(/1 new/);
  });

  it('shows a drift item\'s current and proposed text side by side', () => {
    const el = mount(<ChangesetReview {...baseProps()} />);
    expect(el.textContent).toContain('Tenant may not assign without landlord consent.');
    expect(el.textContent).toContain('Tenant may assign to an affiliate without consent.');
  });

  it('shows a new_clause item\'s rationale for why it was never covered', () => {
    const cs = baseChangeset({ items: [newClauseItem()] });
    const el = mount(<ChangesetReview {...baseProps({ changeset: cs })} />);
    expect(el.textContent).toContain('Raised in this deal though the playbook has no clause for it.');
  });

  it('shows a confirm item as a compact "held again" row', () => {
    const cs = baseChangeset({ items: [confirmItem()] });
    const el = mount(<ChangesetReview {...baseProps({ changeset: cs })} />);
    expect(el.textContent).toMatch(/held again/i);
  });

  it('reads an item\'s clause title from its basis, since ChangesetItem carries no title field', () => {
    const el = mount(<ChangesetReview {...baseProps()} />);
    expect(el.textContent).toContain('Assignment');
  });

  it('clicking Accept decides the item accepted', () => {
    const onDecide = vi.fn();
    const el = mount(<ChangesetReview {...baseProps({ onDecide })} />);
    click(buttonNamed(el, /^accept$/i));
    expect(onDecide).toHaveBeenCalledWith(expect.objectContaining({ id: 'i1' }), 'accepted');
  });

  it('clicking Decline decides the item declined', () => {
    const onDecide = vi.fn();
    const el = mount(<ChangesetReview {...baseProps({ onDecide })} />);
    click(buttonNamed(el, /^decline$/i));
    expect(onDecide).toHaveBeenCalledWith(expect.objectContaining({ id: 'i1' }), 'declined');
  });

  it('rewording opens a text box seeded with the proposal, and saves the human\'s own text', () => {
    const onDecide = vi.fn();
    const el = mount(<ChangesetReview {...baseProps({ onDecide })} />);
    click(buttonNamed(el, /^reword$/i));
    const box = textbox(el);
    expect(box!.value).toBe('Tenant may assign to an affiliate without consent.');
    type(box, 'The words a person wrote.');
    click(buttonNamed(el, /save reword/i));
    expect(onDecide).toHaveBeenCalledWith(expect.objectContaining({ id: 'i1' }), 'reworded', 'The words a person wrote.');
  });

  it('shows a decided item\'s decision', () => {
    const cs = baseChangeset({ items: [item({ decision: 'declined' })] });
    const el = mount(<ChangesetReview {...baseProps({ changeset: cs })} />);
    expect(el.textContent).toMatch(/decision:\s*declined/i);
  });

  it('disables Publish while any item is still open, and says how many remain', () => {
    const onPublish = vi.fn();
    const cs = baseChangeset({ items: [item({ decision: 'open' }), item({ id: 'i2', decision: 'accepted' })] });
    const el = mount(<ChangesetReview {...baseProps({ changeset: cs, onPublish })} />);
    const publishBtn = buttonNamed(el, /publish/i)!;
    expect(publishBtn.disabled).toBe(true);
    expect(el.textContent).toMatch(/1 more item/i);
    click(publishBtn);
    expect(onPublish).not.toHaveBeenCalled();
  });

  it('enables Publish once every item is decided, and clicking it calls onPublish', () => {
    const onPublish = vi.fn();
    const cs = baseChangeset({ items: [item({ decision: 'accepted' }), item({ id: 'i2', decision: 'declined' })] });
    const el = mount(<ChangesetReview {...baseProps({ changeset: cs, onPublish })} />);
    const publishBtn = buttonNamed(el, /^publish v5$/i)!;
    expect(publishBtn.disabled).toBe(false);
    click(publishBtn);
    expect(onPublish).toHaveBeenCalledTimes(1);
  });

  it('shows a publish error without losing the item list', () => {
    const cs = baseChangeset({ items: [item({ decision: 'accepted' })] });
    const el = mount(<ChangesetReview {...baseProps({ changeset: cs, publishError: 'Could not save — storage is full.' })} />);
    expect(el.textContent).toContain('Could not save — storage is full.');
  });

  it('once published, hides the decision controls and shows a published confirmation, never claiming nothing changed', () => {
    const cs = baseChangeset({ items: [item({ decision: 'accepted' })], publishedVersionId: 'v2' });
    const el = mount(<ChangesetReview {...baseProps({ changeset: cs })} />);
    expect(el.textContent).toMatch(/published/i);
    expect(buttonNamed(el, /^accept$/i)).toBeUndefined();
    expect(buttonNamed(el, /publish/i)).toBeUndefined();
  });

  it('names the version actually published, when known', () => {
    const cs = baseChangeset({ items: [item({ decision: 'accepted' })], publishedVersionId: 'v2' });
    const published: PlaybookVersion = { ...version, id: 'v2', version: 5 };
    const el = mount(<ChangesetReview {...baseProps({ changeset: cs, publishedVersion: published })} />);
    expect(el.textContent).toMatch(/published as v5/i);
  });

  it('says plainly when a deal raised nothing to review', () => {
    const cs = baseChangeset({ items: [] });
    const el = mount(<ChangesetReview {...baseProps({ changeset: cs })} />);
    expect(el.textContent).toMatch(/raised nothing to review/i);
  });
});

describe('decisionCounts', () => {
  it('counts each decision independently', () => {
    const items = [
      item({ id: 'a', decision: 'open' }),
      item({ id: 'b', decision: 'accepted' }),
      item({ id: 'c', decision: 'reworded' }),
      item({ id: 'd', decision: 'declined' }),
      item({ id: 'e', decision: 'declined' }),
    ];
    expect(decisionCounts(items)).toEqual({ open: 1, accepted: 1, reworded: 1, declined: 2 });
  });
});
