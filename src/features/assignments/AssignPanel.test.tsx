import { describe, it, expect, beforeEach, vi } from 'vitest';
import React from 'react';
import { ModelError, type WorkspaceUsers } from '@lexprompt/core';
import { mount, buttonNamed, click, type as typeInto, flushUntil } from '../../test/mount';
import { makeFakeTransport, transportModule } from '../../test/fakeTransport';

/**
 * ASKING SOMEBODY, AND THE TWO THINGS THAT MUST NOT HAPPEN (Task 25).
 *
 *  1. **An assignment with no assignee.** Refused, with the missing field
 *     named — a disabled button and no sentence is a dead end a person has
 *     to guess their way out of.
 *  2. **A request that quietly did not send.** Reported on the panel, and
 *     the panel stays open, because a colleague who is never asked and an
 *     assigner who believes they asked is the whole failure §18 item 5 is
 *     about.
 */

const transport = makeFakeTransport();
vi.mock('../../lib/api/client', () => transportModule(transport));

const { loadDirectory, forgetDirectory } = await import('../../lib/api/users');
const { AssignPanel } = await import('./AssignPanel');

const DIRECTORY: WorkspaceUsers = {
  users: [
    { id: 'u1', displayName: 'A Trainee', initials: 'AT', role: 'reviewer', status: 'active' },
    { id: 'u2', displayName: 'R Okafor', initials: 'RO', role: 'partner', status: 'active' },
    { id: 'u3', displayName: 'P Departed', initials: 'PD', role: 'reviewer', status: 'disabled' },
  ],
};

const ASSIGN_PATH = '/v1/reviews/r1/findings/d1/c1/assignments';

const panel = (over: Partial<React.ComponentProps<typeof AssignPanel>> = {}) => (
  <AssignPanel
    open
    reviewId="r1"
    findingsKey="d1"
    clauseId="c1"
    clauseTitle="Limitation of liability"
    meId="u1"
    onClose={over.onClose ?? (() => { /* … */ })}
    onAssigned={over.onAssigned ?? (() => { /* … */ })}
    {...over}
  />
);

beforeEach(async () => {
  transport.reset();
  forgetDirectory();
  transport.responses.set('/v1/workspace/users', DIRECTORY);
  await loadDirectory();
});

const picker = (c: ParentNode): HTMLSelectElement =>
  c.querySelector('select') as HTMLSelectElement;

function choose(select: HTMLSelectElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
  setter?.call(select, value);
  select.dispatchEvent(new Event('change', { bubbles: true }));
}

describe('asking a colleague to look at a clause', () => {
  it('offers the workspace s people, never you and never a disabled account', () => {
    const container = mount(panel());
    const options = [...picker(container).options].map(o => o.textContent);
    expect(options).toContain('R Okafor');
    // Asking yourself to look at something is a note, and the app has notes.
    expect(options).not.toContain('A Trainee');
    // A disabled account cannot sign in, so a request addressed to it would
    // sit in a queue nobody ever opens.
    expect(options).not.toContain('P Departed');
  });

  it('says which clause is being handed over', () => {
    const container = mount(panel());
    expect(container.textContent).toContain('Limitation of liability');
  });

  it('sends the request with the message, and hands back the row the store took', async () => {
    const written = {
      id: 'as1', reviewId: 'r1', findingsKey: 'd1', clauseId: 'c1',
      assigneeUserId: 'u2', assignedByUserId: 'u1',
      message: 'Not sure the cap survives 14.2.', createdAt: 1,
    };
    transport.responses.set(ASSIGN_PATH, written);
    const onAssigned = vi.fn();
    const onClose = vi.fn();
    const container = mount(panel({ onAssigned, onClose }));

    choose(picker(container), 'u2');
    typeInto(container.querySelector('textarea'), 'Not sure the cap survives 14.2.');
    click(buttonNamed(container, /Send the request/));
    await flushUntil(() => onAssigned.mock.calls.length > 0, 'the request to be sent');

    const { method, path, body } = transport.sent.at(-1)!;
    expect(method).toBe('POST');
    expect(path).toBe(ASSIGN_PATH);
    expect(body).toEqual({ assigneeUserId: 'u2', message: 'Not sure the cap survives 14.2.' });
    // NO assigner in the body. The server takes it from the token, and a
    // panel that could name one is a panel that could name anybody.
    expect(Object.keys(body as object)).not.toContain('assignedByUserId');
    // AWAIT-THEN-APPLY: the caller gets the row the STORE returned.
    expect(onAssigned).toHaveBeenCalledWith(written);
    expect(onClose).toHaveBeenCalled();
  });

  it('never assigns without an assignee, and says which field is missing', () => {
    const container = mount(panel());
    const send = buttonNamed(container, /Send the request/)!;
    // Disabled AND explained. A greyed-out control with no sentence is a
    // dead end; the server refuses the same thing by the same field name,
    // because a gate whose only enforcement is a disabled attribute is a
    // suggestion (`authoringDraft.ts`'s rule, one surface over).
    expect(send.disabled).toBe(true);
    expect(transport.sent).toHaveLength(0);
  });

  it('says a failed request was not sent, and stays open', async () => {
    transport.failures.set(
      ASSIGN_PATH, new ModelError('the network went away', 'unknown', 500));
    const onAssigned = vi.fn();
    const onClose = vi.fn();
    const container = mount(panel({ onAssigned, onClose }));
    choose(picker(container), 'u2');
    click(buttonNamed(container, /Send the request/));
    await flushUntil(
      () => (container.textContent ?? '').includes('was not sent'), 'the failure to be said');
    // A colleague who is never asked and an assigner who believes they asked
    // is the failure this whole feature exists against.
    expect(container.textContent).toContain('the network went away');
    expect(onAssigned).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('is disabled while the client is stale, like every other human-authored write', () => {
    // §3's list names an assignment explicitly. The findings stay on screen;
    // what goes dead is every control that composes a write.
    const container = mount(panel({ stale: true }));
    expect(buttonNamed(container, /Send the request/)!.disabled).toBe(true);
    expect(picker(container).disabled).toBe(true);
    expect(container.textContent).toMatch(/cannot reach the server/i);
  });

  it('says the directory failed to load rather than offering an empty menu', async () => {
    forgetDirectory();
    const container = mount(panel());
    // "The directory did not load" and "this firm has one person" are
    // different facts and only the first is a failure; a picker with an
    // empty menu says neither.
    expect(container.querySelector('select')).toBeNull();
    expect(container.textContent).toMatch(/could not read the list of people/i);
  });
});
