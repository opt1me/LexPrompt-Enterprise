import { describe, it, expect, beforeEach, vi } from 'vitest';
import React from 'react';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { PresenceMember } from '@lexprompt/core';
import type { WorkspaceUsers } from '@lexprompt/core';
import { mount } from '../test/mount';
import { makeFakeTransport, transportModule } from '../test/fakeTransport';
import type { DispositionAudience } from '../lib/findingOutcome';

/**
 * A FACE IS NOT A DISPOSITION (§8, S6, Task 23).
 *
 * Two things this component must never do, and they are the two tests that
 * matter here:
 *
 *  1. **Read as a judgement.** A dot on a clause says somebody is looking at
 *     it. If any part of it — a colour borrowed from a state, a tick, a word
 *     — could be read as "somebody has verified this", the roster has made
 *     the one claim it cannot support, in the app whose whole purpose is
 *     keeping "a person decided this" apart from everything else.
 *  2. **Outlive the server's own roster.** The client renders what the
 *     server last said and never its own accumulated view; the stale-roster
 *     half of that is `socket.test.ts`'s, and what is here is that an empty
 *     roster renders NOTHING rather than a leftover.
 */

const transport = makeFakeTransport();
vi.mock('../lib/api/client', () => transportModule(transport));

const { loadDirectory, forgetDirectory } = await import('../lib/api/users');
const { PresenceRoster, ClausePresence } = await import('./PresenceRoster');

const DIRECTORY: WorkspaceUsers = {
  users: [
    { id: 'u1', displayName: 'A Trainee', initials: 'AT', role: 'reviewer', status: 'active' },
    { id: 'u2', displayName: 'R Okafor', initials: 'RO', role: 'partner', status: 'active' },
  ],
};

const ME = 'u1';
const audience: DispositionAudience = {
  nameOf: (id: string) => DIRECTORY.users.find(u => u.id === id)?.displayName,
  initialsOf: (id: string) => DIRECTORY.users.find(u => u.id === id)?.initials,
  timeOf: () => 'now',
};

const member = (userId: string, clauseId?: string): PresenceMember => ({
  userId, screen: 'review', ...(clauseId === undefined ? {} : { clauseId }),
});

beforeEach(async () => {
  transport.reset();
  forgetDirectory();
  transport.responses.set('/v1/workspace/users', DIRECTORY);
  await loadDirectory();
});

describe('the roster answers "is anyone else here?"', () => {
  it('shows a colleague s initials, and never your own', () => {
    const container = mount(
      <PresenceRoster members={[member(ME), member('u2')]} meId={ME} audience={audience} />);
    expect(container.textContent).toContain('RO');
    // You already know you are here. A roster including you is never empty,
    // which makes the one question it exists to answer unanswerable at a
    // glance.
    expect(container.querySelector('[data-presence-member="u1"]')).toBeNull();
    expect(container.querySelector('[data-presence-member="u2"]')).not.toBeNull();
  });

  it('shows nobody when the roster is empty, rather than a placeholder', () => {
    const container = mount(<PresenceRoster members={[]} meId={ME} audience={audience} />);
    expect(container.querySelector('[data-presence-roster]')).toBeNull();
    expect(container.textContent).toBe('');
  });

  it('shows nobody when the only person here is you', () => {
    const container = mount(<PresenceRoster members={[member(ME)]} meId={ME} audience={audience} />);
    expect(container.querySelector('[data-presence-roster]')).toBeNull();
  });

  it('names an unknown user id as unnamed, never as a raw id', () => {
    const stranger = '9f1c0e2a-0000-0000-0000-000000000999';
    const container = mount(
      <PresenceRoster members={[member(stranger)]} meId={ME} audience={audience} />);
    // NEVER the id. A uuid on screen says nothing to a reader while looking
    // like it should — the rule `dispositionLabel` follows for an actor.
    expect(container.textContent).not.toContain(stranger);
    expect(container.textContent).toContain('does not name');
  });

  it('says presence is approximate, on the surface itself', () => {
    const container = mount(
      <PresenceRoster members={[member('u2')]} meId={ME} audience={audience} />);
    const title = container.querySelector('[data-presence-roster]')?.getAttribute('title') ?? '';
    // An absent name does not mean nobody is there and a present one is a
    // claim about a few seconds ago. A roster that looks authoritative is one
    // somebody defers to.
    expect(title.toLowerCase()).toContain('approximate');
  });
});

describe('a face is not a disposition', () => {
  it('says VIEWING in words, and never a disposition word', () => {
    const container = mount(
      <PresenceRoster members={[member('u2')]} meId={ME} audience={audience} />);
    const text = container.textContent ?? '';
    const titles = [...container.querySelectorAll('[title]')]
      .map(el => el.getAttribute('title') ?? '').join(' ');
    expect(`${text} ${titles}`).toMatch(/viewing/i);
    /*
     * THE MUTATION THIS TEST EXISTS FOR: change the sentence to
     * "R Okafor checked this" (or give the dot a tick, or the
     * `text-state-verified` ink) and this goes red.
     *
     * A presence marker that could be read as a verification is the worst
     * available failure of this feature: it is a human judgement claimed by
     * nobody, on a surface a reviewer trusts, and every screen would render
     * perfectly while it happened.
     */
    expect(`${text} ${titles}`).not.toMatch(/verif|checked|approved|rejected|flagged|signed/i);
  });

  it('draws itself in the presence ink and never a state or outcome ink', () => {
    const container = mount(
      <PresenceRoster members={[member('u2')]} meId={ME} audience={audience} />);
    const classes = [...container.querySelectorAll('*')]
      .map(el => el.getAttribute('class') ?? '').join(' ');
    expect(classes).toContain('text-presence');
    // The fastest way to make a face read as a judgement is to draw it in
    // the ink a verification is drawn in.
    expect(classes).not.toMatch(/state-verified|state-flagged|state-rejected|risk-|outcome-/);
    // The sanity check for that `not.toMatch`: the scan really is reading
    // class attributes, so the absence is about the component.
    expect(classes).toMatch(/rounded-full/);
  });

  it('builds no class name out of a variable', () => {
    // Tailwind finds classes by scanning source text for complete literal
    // strings, so a template-built name renders as no colour at all with no
    // error and no failing test. This is the mechanical half of that rule.
    const code = readFileSync(
      path.join(process.cwd(), 'src/components/PresenceRoster.tsx'), 'utf8');
    expect(code).not.toMatch(/className=\{`[^`]*\$\{[^}]*\}(-|\s|`)/);
    expect(code).toContain('bg-presence-tint');
  });
});

describe('the clause marker', () => {
  it('marks the clause a colleague has selected, and says which person', () => {
    const container = mount(
      <ClausePresence members={[member('u2', 'c14')]} audience={audience} />);
    expect(container.querySelector('[data-presence]')).not.toBeNull();
    expect(container.textContent).toContain('R Okafor');
    expect(container.textContent).toMatch(/viewing this clause/i);
  });

  it('renders nothing for a clause nobody has selected', () => {
    const container = mount(<ClausePresence members={[]} audience={audience} />);
    expect(container.querySelector('[data-presence]')).toBeNull();
  });

  it('reads as a sentence for two people, not a badge', () => {
    const container = mount(
      <ClausePresence members={[member('u1', 'c1'), member('u2', 'c1')]} audience={audience} />);
    expect(container.textContent).toContain('A Trainee, R Okafor are viewing this clause');
  });
});
