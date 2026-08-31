import React from 'react';
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { mount, mountOnce } from '../../test/mount';
import { AssignedToMe } from './AssignedToMe';
import type { AssignedToMe as AssignedToMeState } from '../../lib/assignedToMe';

/**
 * THE STATE THAT DOES NOT KNOW, RENDERED AS SUCH.
 *
 * Table-driven over every state, because the defect this component exists to
 * prevent is two states rendering as the same pixel — and a test that
 * checked them one at a time would prove each render individually while
 * saying nothing about whether two of them are identical.
 */

const CASES: [string, AssignedToMeState, { text: string; hasMarker: boolean }][] = [
  ['loading', { status: 'loading' }, { text: '', hasMarker: false }],
  ['empty', { status: 'ready', count: 0, capped: false, matters: [] },
    { text: '', hasMarker: false }],
  ['three', { status: 'ready', count: 3, capped: false, matters: ['Ashcroft lease'] },
    { text: '3', hasMarker: true }],
  ['capped', { status: 'ready', count: 200, capped: true, matters: ['Ashcroft lease'] },
    { text: '200+', hasMarker: true }],
  ['error', { status: 'error', message: 'The network is unavailable.' },
    { text: 'not known', hasMarker: true }],
];

describe('the counter renders each state distinctly', () => {
  it.each(CASES)('renders %s', (_name, state, expected) => {
    const c = mount(<AssignedToMe state={state} />);
    expect(c.textContent).toBe(expected.text);
    expect(c.querySelector('[data-assigned-to-me]') !== null).toBe(expected.hasMarker);
  });

  it('renders NOTHING for loading and for a genuine zero, and they are the same nothing', () => {
    // Deliberately the same: neither is a claim, and a "0" chip is a mark
    // readers stop seeing — which would take the non-zero case with it.
    const a = mount(<AssignedToMe state={{ status: 'loading' }} />);
    const b = mount(
      <AssignedToMe state={{ status: 'ready', count: 0, capped: false, matters: [] }} />);
    expect(a.innerHTML).toBe('');
    expect(b.innerHTML).toBe('');
  });

  it('never renders a digit in the error state', () => {
    /*
     * THE MUTATION THIS TEST EXISTS FOR: render the error branch with the
     * empty state's `return null`, or with `count: 0`'s chip. A badge
     * showing `0` because a fetch failed is a lawyer not doing something a
     * colleague is waiting on, and it looks exactly like a quiet week.
     */
    const { container } = mountOnce(
      <AssignedToMe state={{ status: 'error', message: 'Could not reach 3 services.' }} />);
    expect(container.textContent).not.toMatch(/\d/);
    expect(container.textContent).toMatch(/not known/i);
    // The sanity half: the scan can see a digit when there is one to see.
    expect('200+').toMatch(/\d/);
  });

  it('an error and a count of three do not render the same', () => {
    const err = mount(<AssignedToMe state={{ status: 'error', message: 'x' }} />).textContent;
    const three = mount(
      <AssignedToMe
        state={{ status: 'ready', count: 3, capped: false, matters: ['Ashcroft lease'] }}
      />).textContent;
    expect(err).not.toEqual(three);
  });

  it('says 200+ when the read was capped, never the truncated number alone', () => {
    const c = mount(<AssignedToMe
      state={{ status: 'ready', count: 200, capped: true, matters: ['Ashcroft lease'] }}
    />);
    expect(c.textContent).toBe('200+');
    // …and NOT `200`, which would state a total the server never claimed.
    expect(c.textContent).not.toBe('200');
  });
});

describe('the reason is somewhere a person can reach it', () => {
  it('carries the sentence in BOTH title and aria-label', () => {
    // A marker whose explanation is only in a hover is an explanation a
    // keyboard user does not have.
    const c = mount(
      <AssignedToMe state={{ status: 'error', message: 'The network is unavailable.' }} />);
    const marker = c.querySelector('[data-assigned-to-me="error"]')!;
    expect(marker.getAttribute('title')).toContain('The network is unavailable.');
    expect(marker.getAttribute('aria-label')).toContain('The network is unavailable.');
    expect(marker.getAttribute('aria-label')).toMatch(/not known/i);
  });

  it('says in words what the number means, rather than leaving a bare digit', () => {
    const c = mount(<AssignedToMe
      state={{ status: 'ready', count: 1, capped: false, matters: ['Ashcroft lease'] }}
    />);
    const marker = c.querySelector('[data-assigned-to-me="ready"]')!;
    expect(marker.getAttribute('aria-label'))
      .toBe('1 thing has been asked of you, in Ashcroft lease');
  });

  it('NAMES THE MATTERS, so a counter with nowhere to go is not a badge', () => {
    // This stage ships no cross-matter inbox SCREEN. Rather than a control
    // that goes somewhere the requests are not, the marker says where they
    // are — which is what Task 1's projection exists for.
    const c = mount(<AssignedToMe state={{
      status: 'ready',
      count: 3,
      capped: false,
      matters: ['Ashcroft lease', 'Brookvale lease', 'Cranmer supply'],
    }} />);
    const marker = c.querySelector('[data-assigned-to-me="ready"]')!;
    expect(marker.getAttribute('aria-label'))
      .toBe('3 things have been asked of you, in Ashcroft lease, Brookvale lease '
        + 'and Cranmer supply');
  });
});

describe('a counter is not a disposition, and not a badge', () => {
  it('draws itself in no state, outcome or risk-high ink', () => {
    const classes = [
      ...mount(<AssignedToMe
        state={{ status: 'ready', count: 3, capped: false, matters: ['Ashcroft lease'] }}
      />).querySelectorAll('*'),
      ...mount(<AssignedToMe state={{ status: 'error', message: 'x' }} />)
        .querySelectorAll('*'),
    ].map(el => el.getAttribute('class') ?? '').join(' ');
    expect(classes).not.toMatch(/state-verified|state-flagged|state-rejected|outcome-/);
    // The sanity check for that `not.toMatch`: the scan really is reading
    // class attributes.
    expect(classes).toMatch(/rounded-meter/);
  });

  it('offers no control at all, rather than a dead one', () => {
    // R1: no affordance implying something the app cannot deliver. There is
    // no cross-matter inbox screen in this stage, so there is no button —
    // not a disabled one, and not one that goes to the matters list and
    // leaves a reader to hunt.
    const states: AssignedToMeState[] = [
      { status: 'ready', count: 3, capped: false, matters: ['Ashcroft lease'] },
      { status: 'error', message: 'x' },
    ];
    for (const state of states) {
      const c = mount(<AssignedToMe state={state} />);
      expect(c.querySelector('button')).toBeNull();
      expect(c.querySelector('a')).toBeNull();
    }
  });

  it('builds no class name out of a variable', () => {
    // Tailwind finds classes by scanning source text for complete literal
    // strings, so a template-built name renders as no colour at all with no
    // error and no failing test.
    const code = readFileSync(
      path.join(process.cwd(), 'src/features/assignments/AssignedToMe.tsx'), 'utf8');
    expect(code).not.toMatch(/className=\{`[^`]*\$\{[^}]*\}(-|\s|`)/);
    expect(code).toContain('bg-risk-med-tint');
  });
});
