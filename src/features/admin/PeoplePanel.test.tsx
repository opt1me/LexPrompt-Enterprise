import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import type { WorkspaceUser } from '@lexprompt/core';
import { mount, click, type as typeInto, flushUntil, buttonNamed, buttons } from '../../test/mount';
import { PeoplePanel } from './PeoplePanel';

const person = (over: Partial<WorkspaceUser> & { id: string }): WorkspaceUser => ({
  displayName: 'P Leaver',
  initials: 'PL',
  role: 'reviewer',
  status: 'active',
  ...over,
});

type Api = NonNullable<Parameters<typeof PeoplePanel>[0]['api']>;

function api(people: WorkspaceUser[], over: Partial<Api> = {}): Api {
  return {
    list: vi.fn(async () => people),
    disable: vi.fn(async () => people[0]),
    enable: vi.fn(async () => people[0]),
    pseudonymise: vi.fn(async () => people[0]),
    ...over,
  };
}

async function render(people: WorkspaceUser[], props: { selfUserId?: string } = {},
  over: Partial<Api> = {}): Promise<{ container: HTMLElement; deps: Api }> {
  const deps = api(people, over);
  const container = mount(<PeoplePanel api={deps} {...props} />);
  await flushUntil(() => !container.textContent?.includes('Loading the people'),
    'the directory to load');
  return { container, deps };
}

describe('PeoplePanel', () => {
  it('labels the role as the role at their LAST REQUEST, and claims no instant', async () => {
    // P54, one layer out from the mapping screen: `app_user.role` is a cache
    // of what the last request derived, and a screen presenting it as "their
    // role" presents a stale mapping as current.
    const { container } = await render([person({ id: 'u1', role: 'partner' })]);
    expect(container.textContent).toMatch(/the role at their last request/i);
    expect(container.textContent).toMatch(/what decides it is the role mapping/i);
    // The wire carries no `lastSeenAt`, so no time is claimed. A screen that
    // invented one would be a second wrong answer on top of the first.
    expect(container.textContent).not.toMatch(/last seen|as at|\bago\b/i);
  });

  it('shows the status of every account, disabled ones included', async () => {
    const { container } = await render([
      person({ id: 'u1', displayName: 'A Active' }),
      person({ id: 'u2', displayName: 'D Disabled', status: 'disabled' }),
    ]);
    expect(container.querySelector('[data-user="u1"]')!.textContent).toMatch(/account active/i);
    expect(container.querySelector('[data-user="u2"]')!.textContent).toMatch(/turned off/i);
    // A disabled person is LISTED. Someone who has left the firm still
    // verified things last March, and hiding the row is how history loses a
    // name.
    expect(container.querySelector('[data-user="u2"]')).not.toBeNull();
  });

  it('offers the administrator no action on their OWN row, and says why', async () => {
    const { container } = await render(
      [person({ id: 'me', displayName: 'An Admin', role: 'admin' })], { selfUserId: 'me' });
    const row = container.querySelector('[data-user="me"]')!;
    expect(buttons(row)).toEqual([]);
    expect(row.textContent).toMatch(/nobody could undo it/i);
  });

  it('does require the person s name typed before it retires it, and says PERMANENT', async () => {
    const { container } = await render([person({ id: 'u1', displayName: 'P Leaver' })]);
    click(buttonNamed(container, /Retire this name/));
    await flushUntil(() => !!container.textContent?.includes('Type'), 'the confirmation');
    const confirm = (): HTMLButtonElement => buttons(container)
      .filter(b => /Retire this name/.test(b.textContent || '')).slice(-1)[0];
    expect(confirm().disabled).toBe(true);
    expect(container.textContent).toMatch(/permanent/i);
    typeInto(container.querySelector<HTMLInputElement>('[aria-label="Type the person\'s name to confirm"]'), 'P Leaver');
    expect(confirm().disabled).toBe(false);
  });

  it('never calls it deletion, and says what survives', async () => {
    // The whole point of the wording. A button labelled "delete this person"
    // over an implementation that cannot delete is a confident claim of
    // erasure that did not happen.
    const { container } = await render([person({ id: 'u1' })]);
    click(buttonNamed(container, /Retire this name/));
    await flushUntil(() => !!container.textContent?.includes('Type'), 'the confirmation');
    expect(container.textContent).toMatch(/it is not deletion/i);
    expect(container.textContent).toMatch(/stays attributed to them/i);
    expect(container.textContent).toMatch(/append-only/i);
    expect(container.textContent?.toLowerCase()).not.toContain('delete this person');
    expect(container.textContent?.toLowerCase()).not.toContain('erase this');
  });

  it('calls the route only after the name matches, and reloads afterwards', async () => {
    const { container, deps } = await render([person({ id: 'u1', displayName: 'P Leaver' })]);
    click(buttonNamed(container, /Retire this name/));
    await flushUntil(() => !!container.textContent?.includes('Type'), 'the confirmation');
    typeInto(container.querySelector<HTMLInputElement>('[aria-label="Type the person\'s name to confirm"]'), 'P Leaver');
    const confirm = buttons(container)
      .filter(b => /Retire this name/.test(b.textContent || '')).slice(-1)[0];
    click(confirm);
    await flushUntil(() => (deps.list as ReturnType<typeof vi.fn>).mock.calls.length > 1,
      'the directory to reload');
    expect(deps.pseudonymise).toHaveBeenCalledWith('u1');
  });

  it('renders loading and error distinctly, and an error is not an empty directory', async () => {
    const loading = mount(
      <PeoplePanel api={api([], { list: vi.fn((): Promise<WorkspaceUser[]> => new Promise(() => { /* never */ })) })} />);
    expect(loading.textContent).toMatch(/loading the people/i);

    const container = mount(
      <PeoplePanel api={api([], { list: vi.fn(async () => { throw new Error('offline'); }) })} />);
    await flushUntil(() => !!container.textContent?.includes('could not be loaded'),
      'the error panel');
    expect(container.textContent).toContain('offline');
    expect(buttonNamed(container, /Retry/)).toBeDefined();
  });
});
