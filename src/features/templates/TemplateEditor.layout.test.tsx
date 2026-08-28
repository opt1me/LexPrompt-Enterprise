import React from 'react';
import { describe, it, expect } from 'vitest';
import { mount, buttonNamed, click } from '../../test/mount';
import { TemplateEditor } from './TemplateEditor';
import type { PlaybookClause, PlaybookVersion, Settings } from '../../types';

/**
 * The relayout (handoff 1g/2b): a clause LIST in the left rail, ONE clause
 * in the main pane, `EXTRACT` full width above a two-column
 * `RISKY WHEN` / `OUR STANDARD POSITION` pairing, and the playbook-wide
 * prompt configuration folded away.
 *
 * The behaviour this replaced — every clause expanded at once, three walls
 * of text each — is deliberately gone, so the tests that asserted it were
 * changed rather than kept; each change is noted where it was made.
 */

const labelled = (c: HTMLElement, name: string) =>
  c.querySelector(`[aria-label="${name}"]`) as HTMLTextAreaElement | null;
const allLabelled = (c: HTMLElement, name: string) =>
  [...c.querySelectorAll(`[aria-label="${name}"]`)];
const rail = (c: HTMLElement) => c.querySelector('nav[aria-label="Clauses"]') as HTMLElement;
const railRows = (c: HTMLElement) => [...rail(c).querySelectorAll('li[data-clause-row]')];
const railSelect = (c: HTMLElement, title: RegExp) =>
  [...rail(c).querySelectorAll('button')]
    .find(b => b.hasAttribute('aria-current') && title.test(b.textContent || '')) as HTMLButtonElement | undefined;

function version(overrides: Partial<PlaybookVersion> = {}): PlaybookVersion {
  return {
    id: 'v1',
    playbookId: 'pb1',
    version: 1,
    name: 'Lease Review',
    contractType: 'Lease',
    systemPrompt: 'You are a reviewer.',
    formatPrompt: 'Quote verbatim.',
    clauses: [],
    changeSummary: '',
    publishedAt: 1000,
    publishedByUserId: 'u1',
    schemaVersion: 6,
    ...overrides,
  };
}

const threeClauses: PlaybookClause[] = [
  { id: 'c1', title: 'Term', extractPrompt: 'What is the term?' },
  {
    id: 'c2',
    title: 'Rent',
    extractPrompt: 'What is the rent?',
    standardPosition: { text: 'Reviewed annually, upward only excluded.', origin: 'authored', reviewedByHuman: true },
  },
  { id: 'c3', title: 'Break', extractPrompt: 'Any break right?' },
];

const noop = () => {};
const testSettings: Settings = { modelChoiceId: 'test/model', concurrency: 5 };
const wiring = {
  onPersistDraft: noop,
  onShowVersionHistory: noop,
  onPublish: noop,
  onExport: noop,
  onShowMegaPrompt: noop,
  onClose: noop,
  settings: testSettings,
};

const editor = (overrides: Partial<React.ComponentProps<typeof TemplateEditor>> = {}) => mount(
  <TemplateEditor
    version={version({ clauses: structuredClone(threeClauses) })}
    draft={undefined}
    onDraftChange={noop}
    {...wiring}
    {...overrides}
  />,
);

describe('TemplateEditor — one clause at a time', () => {
  it('renders the fields of exactly one clause, however many the playbook has', () => {
    const c = editor();
    expect(railRows(c)).toHaveLength(3);
    // One of each field, not three. This is the assertion the whole
    // relayout exists for: the previous editor rendered all three clauses
    // expanded, nine fields deep.
    expect(allLabelled(c, 'Extract')).toHaveLength(1);
    expect(allLabelled(c, 'Risky when')).toHaveLength(1);
    expect(allLabelled(c, 'Our standard position')).toHaveLength(1);
    // And it is the FIRST clause that is shown, not an arbitrary one.
    expect(labelled(c, 'Extract')!.value).toBe('What is the term?');
    expect(c.textContent).toMatch(/clause 1 of 3/i);
  });

  it('shows only the active clause\'s text — a clause off screen is not rendered', () => {
    const c = editor();
    expect(c.textContent).not.toMatch(/Any break right\?/);
    expect(c.textContent).not.toMatch(/upward only excluded/);
  });

  it('switches the clause on screen when the rail row is clicked', () => {
    const c = editor();
    click(railSelect(c, /Break/));
    expect(labelled(c, 'Extract')!.value).toBe('Any break right?');
    expect(c.textContent).toMatch(/clause 3 of 3/i);
    // Still exactly one clause's worth of fields.
    expect(allLabelled(c, 'Extract')).toHaveLength(1);
  });

  it('marks the active row in the rail so a reader can see where they are', () => {
    const c = editor();
    const current = () => [...rail(c).querySelectorAll('[aria-current="true"]')]
      .map(b => b.textContent);
    expect(current()).toHaveLength(1);
    expect(current()[0]).toMatch(/Term/);
    click(railSelect(c, /Rent/));
    expect(current()).toHaveLength(1);
    expect(current()[0]).toMatch(/Rent/);
  });

  it('numbers the rail so the list reads in playbook order', () => {
    const c = editor();
    expect(railRows(c).map(r => r.textContent)).toEqual([
      expect.stringMatching(/^1Term/),
      expect.stringMatching(/^2Rent/),
      expect.stringMatching(/^3Break/),
    ]);
  });

  // The rail says which clauses carry a house rule. It says nothing about
  // whether that rule has HELD — that is a different fact, it belongs beside
  // the position it describes, and a clause with no position gets no verdict
  // at all rather than an invented `UNTESTED`.
  it('marks in the rail which clauses have a standard position, and claims nothing about health', () => {
    const c = editor({ health: { c1: { kind: 'held', supporting: 3, total: 4 } } });
    const rows = railRows(c);
    expect(rows[0]!.textContent).not.toMatch(/has a standard position/i);
    expect(rows[1]!.textContent).toMatch(/has a standard position/i);
    expect(rows[2]!.textContent).not.toMatch(/has a standard position/i);
    expect(rail(c).textContent).not.toMatch(/held|untested|conceded/i);
  });

  it('says so rather than showing an empty pane when the playbook has no clauses', () => {
    const c = editor({ version: version({ clauses: [] }) });
    expect(c.textContent).toMatch(/no clauses/i);
    expect(allLabelled(c, 'Extract')).toHaveLength(0);
  });
});

describe('TemplateEditor — the two-column field pairing', () => {
  it('pairs RISKY WHEN with OUR STANDARD POSITION, and leaves EXTRACT above them', () => {
    const c = editor();
    const pair = c.querySelector('[data-field-pair]') as HTMLElement;
    expect(pair, 'the two paired fields must share one container').toBeTruthy();
    expect(pair.contains(labelled(c, 'Risky when')!)).toBe(true);
    expect(pair.contains(labelled(c, 'Our standard position')!)).toBe(true);
    // EXTRACT is full width above the pair, not a third column in it.
    expect(pair.contains(labelled(c, 'Extract')!)).toBe(false);
  });

  it('declares one column by default and two only at lg', () => {
    // Reading the class list as DATA, the way `responsive.test.tsx` reads
    // the document pane's declared geometry: jsdom has no layout engine, so
    // the declaration is the only thing there is to read. Below `lg` the
    // pane is too narrow for two columns and must stack.
    //
    // What this does NOT catch, checked by mutation and worth writing down:
    // a class assembled by string INTERPOLATION produces the identical
    // runtime className and passes here — it fails only in Tailwind's
    // compile-time scan, so nothing in jsdom can see it. That trap is
    // caught by the build and by looking at the page, not by this test.
    const c = editor();
    const pair = c.querySelector('[data-field-pair]') as HTMLElement;
    expect(pair.className).toMatch(/(?:^|\s)grid(?:\s|$)/);
    expect(pair.className).toMatch(/(?:^|\s)grid-cols-1(?:\s|$)/);
    expect(pair.className).toMatch(/(?:^|\s)lg:grid-cols-2(?:\s|$)/);
  });
});

describe('TemplateEditor — the prompt configuration is folded away', () => {
  it('does not render the playbook-wide fields until the panel is opened', () => {
    const c = editor();
    expect(labelled(c, 'System persona')).toBeNull();
    expect(labelled(c, 'Format and rules')).toBeNull();
    expect(labelled(c, 'Global risk tolerance')).toBeNull();

    click(buttonNamed(c, /prompt configuration/i));

    expect(labelled(c, 'System persona')!.value).toBe('You are a reviewer.');
    expect(labelled(c, 'Format and rules')!.value).toBe('Quote verbatim.');
    expect(labelled(c, 'Global risk tolerance')).toBeTruthy();
  });

  it('reports whether it is open, so the control is not a mystery toggle', () => {
    const c = editor();
    const toggle = () => buttonNamed(c, /prompt configuration/i)!;
    expect(toggle().getAttribute('aria-expanded')).toBe('false');
    click(toggle());
    expect(toggle().getAttribute('aria-expanded')).toBe('true');
  });
});
