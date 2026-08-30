import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import type { AssignmentView } from '@lexprompt/core';
import { mount, click, buttons } from '../../test/mount';
import type { DispositionAudience } from '../../lib/findingOutcome';
import { AskedOfYou } from './AskedOfYou';

/**
 * §18 ITEM 5: *"AN ASSIGNMENT REACHES THE ASSIGNEE."*
 *
 * A mechanism nobody can see reaches nobody, and this project has nineteen
 * recorded instances of a correct mechanism with no path to it. What this
 * file holds is the path: the assignee is told WHO asked, WHAT they wanted,
 * and can get to the clause from where they were told.
 */

const audience: DispositionAudience = {
  nameOf: (id: string) => (id === 'u1' ? 'A Trainee' : undefined),
  initialsOf: (id: string) => (id === 'u1' ? 'AT' : undefined),
  timeOf: () => 'now',
};

const request = (over: Partial<AssignmentView> = {}): AssignmentView => ({
  id: 'as1',
  reviewId: 'r1',
  findingsKey: 'd1',
  clauseId: 'c14',
  assigneeUserId: 'u2',
  assignedByUserId: 'u1',
  message: 'Not sure the cap survives 14.2.',
  createdAt: 1_700_000_000_000,
  ...over,
});

describe('what has been asked of you', () => {
  it('shows the assigner and the message, not just a badge', () => {
    const container = mount(<AskedOfYou assignments={[request()]} audience={audience} />);
    // A bare marker makes the assignee open every clause to find out what
    // was wanted — the blank-CSV-cell failure at a new surface.
    expect(container.textContent).toContain('A Trainee asked you to look at this');
    expect(container.textContent).toContain('Not sure the cap survives 14.2.');
  });

  it('names an unresolvable assigner as unnamed, never as a raw id', () => {
    const container = mount(
      <AskedOfYou assignments={[request({ assignedByUserId: 'u9' })]} audience={audience} />);
    expect(container.textContent).not.toContain('u9');
    expect(container.textContent).toContain('does not name');
  });

  it('takes the reader to the clause it is about', () => {
    const onOpenClause = vi.fn();
    const container = mount(
      <AskedOfYou
        assignments={[request()]}
        audience={audience}
        clauseTitles={{ c14: 'Limitation of liability' }}
        onOpenClause={onOpenClause}
      />);
    click(buttons(container)[0]);
    // A request nobody can act on from where it is shown is a badge.
    expect(onOpenClause).toHaveBeenCalledWith('d1', 'c14');
    expect(container.textContent).toContain('Limitation of liability');
  });

  it('renders nothing at all when nothing has been asked', () => {
    const container = mount(<AskedOfYou assignments={[]} audience={audience} />);
    // No "0 requests" placeholder: a permanent empty panel is one readers
    // stop seeing, and it would take the non-empty case with it.
    expect(container.querySelector('[data-asked-of-you]')).toBeNull();
    expect(container.textContent).toBe('');
  });

  it('offers no way to dispose of the clause from here', () => {
    const container = mount(
      <AskedOfYou assignments={[request()]} audience={audience}
        onOpenClause={() => { /* … */ }} />);
    const text = container.textContent ?? '';
    /*
     * Deciding a clause happens on the card, where the answer and the
     * evidence are. A verify control in a list of requests would be a
     * judgement made without reading the thing being judged — which is the
     * one act this whole application exists to keep honest.
     */
    expect(text).not.toMatch(/verify|reject|flag/i);
    expect(buttons(container)).toHaveLength(1);
  });

  it('says how many when there is more than one, and not when there is one', () => {
    const one = mount(<AskedOfYou assignments={[request()]} audience={audience} />);
    expect(one.textContent).toContain('Asked of you');
    expect(one.textContent).not.toContain('(1)');
    const two = mount(
      <AskedOfYou
        assignments={[request(), request({ id: 'as2', clauseId: 'c15' })]}
        audience={audience}
      />);
    expect(two.textContent).toContain('(2)');
  });
});

describe('a read that failed is not an empty list', () => {
  it('says the read failed, instead of rendering nothing', () => {
    const container = mount(
      <AskedOfYou
        assignments={[]}
        audience={audience}
        error="LexPrompt could not read what has been asked of you on this review."
      />);
    // "Nobody has asked you anything" and "the read failed" are the same
    // pixels once one has been flattened into the other, and the cost here
    // is a colleague waiting on an answer nobody knows was requested.
    expect(container.querySelector('[data-asked-of-you-error]')).not.toBeNull();
    expect(container.textContent).toContain('could not read');
    // …and NOT the list, which would be a partial answer presented as a
    // whole one.
    expect(container.querySelector('[data-asked-of-you]')).toBeNull();
  });

  it('offers a way out of the failure', () => {
    const onRetry = vi.fn();
    const container = mount(
      <AskedOfYou assignments={[]} audience={audience} error="it failed" onRetry={onRetry} />);
    click(buttons(container)[0]);
    expect(onRetry).toHaveBeenCalled();
  });
});
