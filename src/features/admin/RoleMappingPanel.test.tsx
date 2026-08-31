import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RoleMappingEffect, RoleMappingView, RoleMappingsPage } from '@lexprompt/core';
import { mount, click, type as typeInto, flushUntil, buttonNamed } from '../../test/mount';
import { RoleMappingPanel } from './RoleMappingPanel';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const ISSUER = 'https://issuer.example/realms/lexprompt';

const idOf = (group: string): string =>
  Buffer.from(`${ISSUER}\n${group}`, 'utf8').toString('base64url');

const mapping = (over: Partial<RoleMappingView> & { groupValue: string }): RoleMappingView => ({
  id: idOf(over.groupValue),
  issuer: ISSUER,
  role: 'reviewer',
  source: 'admin',
  createdAt: Date.UTC(2026, 1, 3),
  ...over,
});

const READ_AT = Date.UTC(2026, 7, 30, 9, 15);

const page = (mappings: RoleMappingView[]): RoleMappingsPage => ({
  mappings, readAt: READ_AT, configurationSource: 'API_ROLE_MAPPINGS',
});

/**
 * THE SERVER'S SENTENCE, as a fixture.
 *
 * Deliberately NOT a sentence this file could also compose: it names a role
 * in wording the component has no template for, so an assertion that the
 * rendered text contains it can only pass if the component printed what the
 * server sent.
 */
const WIDENING: RoleMappingEffect = {
  action: 'create',
  widens: true,
  grantsRole: 'admin',
  sentence: 'Anyone whose sign-in carries the group "house-counsel" from '
    + `${ISSUER} will be an administrator. There is no mapping for that group today. `
    + 'This takes effect on their next request, including for anyone already signed in.',
};

const NARROWING: RoleMappingEffect = {
  action: 'change',
  widens: false,
  grantsRole: 'reviewer',
  currentRole: 'partner',
  sentence: 'Anyone whose sign-in carries the group "house-counsel" from '
    + `${ISSUER} will be a reviewer. It grants a partner today. `
    + 'This takes effect on their next request, including for anyone already signed in.',
};

type Api = NonNullable<Parameters<typeof RoleMappingPanel>[0]['api']>;

function api(over: Partial<Api> = {}, p: RoleMappingsPage = page([])): Api {
  return {
    list: vi.fn(async () => p),
    preview: vi.fn(async () => WIDENING),
    create: vi.fn(async () => mapping({ groupValue: 'x' })),
    change: vi.fn(async () => mapping({ groupValue: 'x' })),
    remove: vi.fn(async () => { /* 204 */ }),
    ...over,
  };
}

async function render(p: RoleMappingsPage, over = {}): Promise<HTMLElement> {
  const deps = api(over, p);
  const container = mount(<RoleMappingPanel api={deps} />);
  await flushUntil(() => !container.textContent?.includes('Loading the role mapping'),
    'the role mapping to load');
  return container;
}

const rowFor = (container: HTMLElement, group: string): HTMLElement => {
  const el = container.querySelector<HTMLElement>(`[data-group="${group}"]`);
  if (!el) throw new Error(`no row for ${group}`);
  return el;
};

const controlsIn = (el: ParentNode): (HTMLButtonElement | HTMLInputElement | HTMLSelectElement)[] =>
  Array.from(el.querySelectorAll('button, input, select'));

/** Block and line comments removed, so a structural scan reads CODE.
 *  The component's own docstring EXPLAINS why it never renders
 *  `app_user.role`; a scan over raw text would read that explanation as the
 *  offence, which is the shape that makes a guard unwritable and then
 *  absent. */
const stripComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

describe('RoleMappingPanel', () => {
  it('shows the instant the policy was read', async () => {
    const container = await render(page([mapping({ groupValue: 'partners', role: 'partner' })]));
    // P54's whole content in one assertion: a policy screen with no instant
    // cannot be told apart from a stale one.
    expect(container.textContent).toMatch(/read at /i);
    expect(container.querySelector('[data-testid="read-at"]')!.textContent)
      .toContain(new Date(READ_AT).toLocaleString());
  });

  it('marks a configuration row as not editable, and names the variable', async () => {
    const container = await render(page([
      mapping({ groupValue: 'cfg', source: 'configuration' }),
    ]));
    const row = rowFor(container, 'cfg');
    expect(row.textContent).toContain('API_ROLE_MAPPINGS');
    expect(controlsIn(row).every(c => (c as HTMLButtonElement).disabled)).toBe(true);
    // …and says WHY it is disabled, rather than being a dead control.
    expect(row.textContent).toMatch(/deployment configuration/i);
  });

  it('leaves an ADMIN row s controls live, which is what makes the disabling above about the SOURCE',
    async () => {
      // Without this, a component that disabled every control everywhere
      // would pass the case above.
      const container = await render(page([mapping({ groupValue: 'ours' })]));
      const row = rowFor(container, 'ours');
      expect(controlsIn(row).length).toBeGreaterThan(0);
      expect(controlsIn(row).some(c => (c as HTMLButtonElement).disabled)).toBe(false);
    });

  it('shows a superseded row as superseded, permanently', async () => {
    const container = await render(page([
      mapping({
        groupValue: 'house-counsel',
        source: 'configuration',
        convertedFromAdminAt: Date.UTC(2026, 6, 1),
      }),
    ]));
    expect(rowFor(container, 'house-counsel').textContent)
      .toMatch(/replaced by deployment configuration/i);
  });

  it('renders the server s effect sentence verbatim before a widening', async () => {
    const container = await render(page([mapping({ groupValue: 'ours' })]));
    typeInto(container.querySelectorAll('input[type="text"]')[0] as HTMLInputElement, ISSUER);
    typeInto(container.querySelectorAll('input[type="text"]')[1] as HTMLInputElement, 'house-counsel');
    click(buttonNamed(container, /Add mapping/));
    await flushUntil(() => !!container.querySelector('[data-testid="effect-sentence"]'),
      'the effect sentence');
    // NOT a sentence the component composed: compared against the fixture
    // the fake server returned, character for character.
    expect(container.querySelector('[data-testid="effect-sentence"]')!.textContent)
      .toBe(WIDENING.sentence);
  });

  it('keeps the confirm control disabled until the role name is typed', async () => {
    const container = await render(page([mapping({ groupValue: 'ours' })]));
    typeInto(container.querySelectorAll('input[type="text"]')[0] as HTMLInputElement, ISSUER);
    typeInto(container.querySelectorAll('input[type="text"]')[1] as HTMLInputElement, 'house-counsel');
    click(buttonNamed(container, /Add mapping/));
    await flushUntil(() => !!container.querySelector('[data-testid="effect-sentence"]'),
      'the effect sentence');
    const confirm = (): HTMLButtonElement => buttonNamed(container, /Apply the change/)!;
    expect(confirm().disabled).toBe(true);
    typeInto(container.querySelector<HTMLInputElement>('[aria-label="Type the role name to confirm"]'), 'admin');
    expect(confirm().disabled).toBe(false);
  });

  it('does not require typing for a change that does not widen', async () => {
    const container = await render(
      page([mapping({ groupValue: 'house-counsel', role: 'partner' })]),
      { preview: vi.fn(async () => NARROWING) });
    click(buttonNamed(rowFor(container, 'house-counsel'), /Make Reviewer/));
    await flushUntil(() => !!container.querySelector('[data-testid="effect-sentence"]'),
      'the effect sentence');
    expect(container.querySelector('[aria-label="Type the role name to confirm"]')).toBeNull();
    expect(buttonNamed(container, /Apply the change/)!.disabled).toBe(false);
  });

  it('never renders app_user.role as the effective policy (P54)', () => {
    // The panel takes NO directory prop at all. Asserted STRUCTURALLY as well
    // as by render, because "we just won't pass it" is a habit rather than a
    // guarantee — and the sanity half below proves the scan can see a name
    // that IS in the file.
    // COMMENTS STRIPPED FIRST. The component's own docstring EXPLAINS why
    // it never renders `app_user.role`, and a scan over raw text would read
    // that explanation as the offence — the shape that makes a guard
    // unwritable and then absent. What is scanned is code.
    const code = stripComments(
      readFileSync(path.join(HERE, 'RoleMappingPanel.tsx'), 'utf8'));
    expect(code).not.toMatch(/WorkspaceUser/);
    expect(code).not.toMatch(/app_user/);
    expect(code).toMatch(/RoleMappingsPage/);
    // The sanity half: the stripper did not eat the file, and the scan can
    // see a name that IS in the code.
    expect(code.length).toBeGreaterThan(2000);
    expect(/app_user/.test('const x = app_user.role;')).toBe(true);
  });

  it('renders loading, error and empty distinctly, and empty is not a blank panel', async () => {
    const loading = mount(<RoleMappingPanel api={api({ list: vi.fn((): Promise<RoleMappingsPage> => new Promise(() => { /* never settles */ })) })} />);
    expect(loading.textContent).toMatch(/loading the role mapping/i);

    const container = mount(
      <RoleMappingPanel api={api({ list: vi.fn(async () => { throw new Error('offline'); }) })} />);
    await flushUntil(() => !!container.textContent?.includes('could not be loaded'),
      'the error panel');
    expect(container.textContent).toContain('offline');
    expect(buttonNamed(container, /Retry/)).toBeDefined();

    const empty = await render(page([]));
    // An empty `role_mapping` means NOBODY can sign in. It says that in
    // words rather than showing an empty table.
    expect(empty.textContent).toMatch(/nobody can sign in/i);
    expect(empty.textContent).toContain('API_ROLE_MAPPINGS');
  });
});
