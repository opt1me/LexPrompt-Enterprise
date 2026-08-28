import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { mount, click, buttonNamed, type } from '../../test/mount';
import { PrecedentIntake } from './PrecedentIntake';
import type { PrecedentDocument } from '../../lib/chains';

const unknownRoleDoc: PrecedentDocument = {
  id: 'doc-1',
  name: 'document1.docx',
  role: 'unknown',
  roleInferred: true,
};

const proposedExecutedDoc: PrecedentDocument = {
  id: 'doc-2',
  name: 'Lease - executed.docx',
  role: 'executed',
  roleInferred: true,
};

const confirmedDoc: PrecedentDocument = {
  id: 'doc-3',
  name: 'Lease - our markup.docx',
  role: 'our-markup',
  roleInferred: false,
};

function baseProps(overrides: Partial<React.ComponentProps<typeof PrecedentIntake>> = {}) {
  return {
    documents: [],
    onSetRole: vi.fn(),
    onOfferDiff: vi.fn(),
    ...overrides,
  };
}

describe('PrecedentIntake', () => {
  it('asks about an ambiguous document instead of asserting a role (R-F4)', () => {
    const el = mount(<PrecedentIntake {...baseProps({ documents: [unknownRoleDoc] })} />);
    expect(el.textContent).toMatch(/what is this/i);
  });

  it('reports a document whose tracked changes could not be read, by name', () => {
    const el = mount(
      <PrecedentIntake
        {...baseProps({ documents: [confirmedDoc], unreadable: [{ name: 'Deed.docx' }] })}
      />,
    );
    expect(el.textContent).toContain('Deed.docx');
    // Spec §8: the diff fallback is OFFERED explicitly, never substituted
    // silently.
    expect(buttonNamed(el, /compare|diff/i)).toBeTruthy();
  });

  it('offers the diff fallback via a callback rather than substituting it automatically', () => {
    const onOfferDiff = vi.fn();
    const el = mount(
      <PrecedentIntake {...baseProps({ unreadable: [{ name: 'Deed.docx' }], onOfferDiff })} />,
    );
    click(buttonNamed(el, /compare|diff/i));
    expect(onOfferDiff).toHaveBeenCalledWith({ name: 'Deed.docx' });
  });

  it('never returns a role that was not clicked — a proposed role is not asserted', () => {
    const onSetRole = vi.fn();
    const el = mount(<PrecedentIntake {...baseProps({ documents: [proposedExecutedDoc], onSetRole })} />);
    // A confident proposal still shows as unconfirmed, not as a stated fact.
    expect(el.textContent).toMatch(/proposed|not yet confirmed/i);
    expect(onSetRole).not.toHaveBeenCalled();
    click(buttonNamed(el, /confirm/i));
    expect(onSetRole).toHaveBeenCalledWith(proposedExecutedDoc, 'executed');
  });

  it('does not gate Continue on a document whose role is already confirmed', () => {
    const onContinue = vi.fn();
    const el = mount(<PrecedentIntake {...baseProps({ documents: [confirmedDoc], onContinue })} />);
    const continueButton = buttonNamed(el, /continue/i)!;
    expect(continueButton.disabled).toBe(false);
  });

  it('blocks Continue while any document has an unresolved, ambiguous role', () => {
    const onContinue = vi.fn();
    const el = mount(
      <PrecedentIntake {...baseProps({ documents: [unknownRoleDoc, confirmedDoc], onContinue })} />,
    );
    const continueButton = buttonNamed(el, /continue/i)!;
    expect(continueButton.disabled).toBe(true);
  });

  it('groups documents sharing a chain id under one chain card', () => {
    const a = { ...proposedExecutedDoc, id: 'a', chainId: 'chain-1' };
    const b = { ...confirmedDoc, id: 'b', chainId: 'chain-1' };
    const el = mount(<PrecedentIntake {...baseProps({ documents: [a, b] })} />);
    expect(el.textContent).toMatch(/2 turns/i);
  });

  // R-F-fix-1's gap: a ruling on Task 10 puts the playbook's name on THIS
  // screen, beside the documents — the person is already telling the app
  // what these are. Lives here rather than being defaulted to a constant
  // (`App.tsx`'s `handleRedlinesToDraftReview` is where it is required).
  describe('the playbook name field (a Task 10 ruling)', () => {
    it('reports what was typed via onContractTypeChange', () => {
      const onContractTypeChange = vi.fn();
      const el = mount(<PrecedentIntake {...baseProps({ onContractTypeChange })} />);
      const nameInput = el.querySelector('[aria-label="Playbook name"]') as HTMLInputElement;
      expect(nameInput).toBeTruthy();
      type(nameInput, 'Brookvale Lease (Landlord)');
      expect(onContractTypeChange).toHaveBeenCalledWith('Brookvale Lease (Landlord)');
    });

    it('never blocks Continue, even while the name is blank', () => {
      const onContinue = vi.fn();
      const el = mount(
        <PrecedentIntake
          {...baseProps({ documents: [confirmedDoc], onContinue, onContractTypeChange: vi.fn(), contractType: '' })}
        />,
      );
      expect(buttonNamed(el, /continue/i)!.disabled).toBe(false);
    });
  });
});
