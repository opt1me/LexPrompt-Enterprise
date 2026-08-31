import React from 'react';
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { AssignmentView } from '@lexprompt/core';
import { mount, mountOnce } from '../../test/mount';
import { AssigneeChip, ClauseAssignees } from './AssigneeChip';
import type { DispositionAudience } from '../../lib/findingOutcome';

/**
 * A CHIP IS NOT A DISPOSITION (S18, Stage 5 Task 3).
 *
 * The same two tests that matter about `PresenceRoster`, one step along:
 *
 *  1. **It must not read as a judgement.** A chip on a clause says somebody
 *     was ASKED to look at it. If any part of it — a colour borrowed from a
 *     state, a tick, a word — could be read as "somebody has verified this",
 *     the chip has made the one claim it cannot support.
 *  2. **It must not offer an action on somebody else's act.** Stage 4's
 *     final review found a bystander shown "You asked B. Trainee to look at
 *     this" with a live Withdraw button. This component renders no control.
 */

const DIRECTORY = [
  { id: 'u1', displayName: 'A Trainee', initials: 'AT' },
  { id: 'u2', displayName: 'R Okafor', initials: 'RO' },
];

const nameOf = (id: string): string | undefined =>
  DIRECTORY.find(u => u.id === id)?.displayName;

const audience: DispositionAudience = {
  nameOf,
  initialsOf: (id: string) => DIRECTORY.find(u => u.id === id)?.initials,
  timeOf: () => 'now',
};

const ASKED_OF_PARTNER: AssignmentView = {
  id: 'a1', reviewId: 'r1', findingsKey: 'd1', clauseId: 'c1',
  assigneeUserId: 'u2', assignedByUserId: 'u1', createdAt: 1,
};

const WITH_MESSAGE: AssignmentView = {
  ...ASKED_OF_PARTNER, id: 'a2', message: 'Not sure the cap survives 14.2.',
};

describe('the chip says who was asked, in words', () => {
  it('names the person asked, and says what the chip means in words', () => {
    const { container } = mountOnce(
      <AssigneeChip assignment={ASKED_OF_PARTNER} audience={audience} />);
    expect(container.textContent).toContain('R Okafor');
    expect(container.textContent).toMatch(/asked to look/i);
  });

  it('names the assigner too, so the chip is not an anonymous mark', () => {
    const c = mount(<AssigneeChip assignment={ASKED_OF_PARTNER} audience={audience} />);
    expect(c.textContent).toContain('A Trainee');
    expect(c.querySelector('[data-assignee-chip="a1"]')?.getAttribute('title'))
      .toBe('R Okafor was asked to look at this, by A Trainee');
  });

  it('does NOT carry the message, which is between the two people', () => {
    /*
     * The message is on the CARD, for the assignee (who has to act on it)
     * and for the assigner (who wrote it). This chip is what everybody else
     * gets, and Stage 4's final review is why: a bystander was reading the
     * assigner's brief under a first-person line, beside a live Withdraw
     * button. The line and the button are gone from this surface and so is
     * the brief — what a third reviewer needs is "somebody is on this", not
     * a colleague's private note about a clause.
     */
    const c = mount(<AssigneeChip assignment={WITH_MESSAGE} audience={audience} />);
    const titles = [...c.querySelectorAll('[title]')]
      .map(el => el.getAttribute('title') ?? '').join(' ');
    expect(`${c.textContent ?? ''} ${titles}`).not.toContain('Not sure the cap survives');
    // …and the chip still says what it is for, so this is not silence.
    expect(c.textContent).toMatch(/asked to look/i);
  });

  it('renders "someone this workspace does not name" for an id the directory lacks', () => {
    const stranger: AssignmentView = {
      ...ASKED_OF_PARTNER, assigneeUserId: '9f1c0e2a-0000-0000-0000-000000000999',
    };
    const c = mount(<AssigneeChip assignment={stranger} audience={audience} />);
    // NOT a raw id, which says nothing to a reader while looking like it
    // should, and NOT "Unknown", which is a claim about a person made on the
    // strength of a failed fetch. The wording the activity feed already uses.
    expect(c.textContent).not.toContain('9f1c0e2a');
    expect(c.textContent).toContain('Someone this workspace does not name');
  });
});

describe('a chip is not a disposition', () => {
  it('never uses a disposition word', () => {
    const c = mount(<AssigneeChip assignment={WITH_MESSAGE} audience={audience} />);
    const titles = [...c.querySelectorAll('[title]')]
      .map(el => el.getAttribute('title') ?? '').join(' ');
    const all = `${c.textContent ?? ''} ${titles}`;
    for (const word of ['Verified', 'Flagged', 'Rejected', 'Checked', 'Unchecked',
      'Approved', 'Assigned']) {
      expect(all, word).not.toContain(word);
    }
    // The sanity half: the scan can see the words it is looking for.
    expect('Verified by R. Okafor').toContain('Verified');
  });

  it('never draws itself in a state or outcome ink', () => {
    // Mirrors `PresenceRoster.test.tsx`'s own assertion, over the same class
    // list, because this is the same rule about a different marker.
    const classes = [
      ...mount(<AssigneeChip assignment={ASKED_OF_PARTNER} audience={audience} />)
        .querySelectorAll('*'),
      ...mount(<ClauseAssignees assignments={[ASKED_OF_PARTNER]} audience={audience} />)
        .querySelectorAll('*'),
    ].map(el => el.getAttribute('class') ?? '').join(' ');
    expect(classes).not.toMatch(/state-verified|state-flagged|state-rejected|risk-|outcome-/);
    // The sanity check for that `not.toMatch`: the scan really is reading
    // class attributes, so the absence is about the component.
    expect(classes).toMatch(/bg-draft-tint/);
  });

  it('offers no control at all', () => {
    // Stage 4's defect, closed: a bystander was offered an action on
    // somebody else's act. What a third party gains here is information.
    const c = mount(<AssigneeChip assignment={WITH_MESSAGE} audience={audience} />);
    expect(c.querySelector('button')).toBeNull();
    expect(c.querySelector('a')).toBeNull();
    expect(c.querySelector('input')).toBeNull();
  });

  it('builds no class name out of a variable', () => {
    const code = readFileSync(
      path.join(process.cwd(), 'src/features/assignments/AssigneeChip.tsx'), 'utf8');
    expect(code).not.toMatch(/className=\{`[^`]*\$\{[^}]*\}(-|\s|`)/);
    expect(code).toContain('bg-draft-tint');
  });

  it('names no retired assigneeId anywhere in its source (S17, P24)', () => {
    // The chip reads `AssignmentView.assigneeUserId`, which is a different
    // field on a different record. `Verification.assigneeId` stays retired.
    const code = readFileSync(
      path.join(process.cwd(), 'src/features/assignments/AssigneeChip.tsx'), 'utf8');
    expect(code).not.toMatch(/\bassigneeId\b/);
    expect(code).toContain('assigneeUserId');
  });
});

describe('the clause marker', () => {
  it('marks a clause somebody has been asked to look at, and says which person', () => {
    const c = mount(<ClauseAssignees assignments={[ASKED_OF_PARTNER]} audience={audience} />);
    expect(c.querySelector('[data-assignees]')).not.toBeNull();
    expect(c.textContent).toContain('R Okafor');
    expect(c.textContent).toMatch(/was asked to look at this clause/i);
  });

  it('renders nothing for a clause nobody has been asked about', () => {
    const c = mount(<ClauseAssignees assignments={[]} audience={audience} />);
    expect(c.querySelector('[data-assignees]')).toBeNull();
    expect(c.textContent).toBe('');
  });

  it('reads as a sentence for two people, not a badge', () => {
    const second: AssignmentView = { ...ASKED_OF_PARTNER, id: 'a3', assigneeUserId: 'u1' };
    const c = mount(
      <ClauseAssignees assignments={[ASKED_OF_PARTNER, second]} audience={audience} />);
    expect(c.textContent).toContain('R Okafor, A Trainee were asked to look at this clause');
  });
});
