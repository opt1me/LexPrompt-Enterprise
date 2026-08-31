import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { SearchResults } from '@lexprompt/core';
import { mount, buttonNamed, click } from '../../test/mount';
import { SearchPalette } from './SearchPalette';
import type { SearchState } from './useSearch';

/**
 * THE DIFFERENCE BETWEEN NOTHING AND BROKEN, ON SCREEN.
 *
 * Two states that must never render as the same pixel, and one sentence that
 * must appear on all four. A search that silently misses documents is worse
 * than no search: it turns "I looked and it is not there" into a claim the
 * software invited and cannot support.
 */

const OK = (hits: SearchResults['hits'], sources?: SearchResults['sources']): SearchResults => ({
  query: 'ashcroft',
  hits,
  sources: sources ?? [{ source: 'matter', status: 'ok', count: hits.length }],
});

const IDLE: SearchState = { status: 'idle' };
const SEARCHING: SearchState = { status: 'searching', query: 'ashcroft' };
const EMPTY_RESULTS: SearchState = { status: 'results', results: OK([]) };
const FAILED: SearchState = {
  status: 'failed', query: 'ashcroft',
  message: "LexPrompt could not reach your firm's service.",
};
const PARTIAL: SearchState = {
  status: 'results',
  results: {
    query: 'ashcroft',
    hits: [{ source: 'matter', id: 'm1', title: 'Ashcroft lease', context: 'Ashcroft Ltd' }],
    sources: [
      { source: 'matter', status: 'ok', count: 1 },
      { source: 'clause', status: 'failed', count: 0,
        message: 'Clause titles could not be searched. Some results are missing from this list.' },
    ],
  },
};
const CAPPED: SearchState = {
  status: 'results',
  results: {
    query: 'lease',
    hits: [{ source: 'matter', id: 'm1', title: 'Lease one' }],
    sources: [{ source: 'matter', status: 'capped', count: 1, limit: 20 }],
  },
};
const PRECEDENT: SearchState = {
  status: 'results',
  results: {
    query: 'ashcroft',
    hits: [{ source: 'precedent', id: 'p1', title: 'Ashcroft precedent 2019.pdf',
      context: 'Old deals' }],
    sources: [{ source: 'precedent', status: 'ok', count: 1 }],
  },
};

const palette = (state: SearchState, over: Partial<React.ComponentProps<typeof SearchPalette>> = {}) => (
  <SearchPalette
    open
    state={state}
    query="ashcroft"
    onQuery={() => { /* … */ }}
    onClose={() => { /* … */ }}
    onRetry={() => { /* … */ }}
    {...over}
  />
);

const textOf = (state: SearchState): string => mount(palette(state)).textContent ?? '';

describe('it says what it searches, on every state', () => {
  it.each([
    ['idle', IDLE], ['searching', SEARCHING], ['empty', EMPTY_RESULTS],
    ['failed', FAILED], ['partial', PARTIAL],
  ] as [string, SearchState][])('states the corpus in the %s state', (_name, state) => {
    const c = mount(palette(state));
    expect(c.textContent).toMatch(/does not search the text inside documents/i);
    // …and it names what it DOES search, so the sentence is a corpus rather
    // than a disclaimer.
    expect(c.querySelector('[data-search-corpus]')?.textContent)
      .toMatch(/matters, documents, precedents, reviews, collections, playbooks/i);
  });

  it('declares the sentence in ONE place', () => {
    // The route's docstring gives the reasoning; this is the half a reader
    // sees, and two copies would drift the day one of them is reworded.
    const code = readFileSync(
      path.join(process.cwd(), 'src/features/search/SearchPalette.tsx'), 'utf8');
    const occurrences = code.match(/does not search the text inside documents/g) ?? [];
    expect(occurrences).toHaveLength(1);
  });
});

describe('an empty result and a failure do not read the same', () => {
  it('renders different sentences and different controls', () => {
    const empty = textOf(EMPTY_RESULTS);
    const failed = textOf(FAILED);
    expect(empty).toMatch(/nothing matched/i);
    expect(failed).toMatch(/search could not be run/i);
    expect(empty).not.toEqual(failed);
    // The failure offers a retry the empty state does not. An empty result
    // is an ANSWER; a failure is not, and a reader must be able to tell.
    expect(buttonNamed(mount(palette(FAILED)), /^Try again$/)).toBeTruthy();
    expect(buttonNamed(mount(palette(EMPTY_RESULTS)), /^Try again$/)).toBeUndefined();
  });

  it('retries the same query rather than clearing it', () => {
    const onRetry = vi.fn();
    const c = mount(palette(FAILED, { onRetry }));
    click(buttonNamed(c, /^Try again$/));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('quotes the query in the empty sentence, so it is about what was asked', () => {
    expect(textOf(EMPTY_RESULTS)).toContain('ashcroft');
  });
});

describe('a source that failed is named, even when others answered', () => {
  it('names it AND shows the hits that did arrive', () => {
    const c = mount(palette(PARTIAL));
    expect(c.textContent).toMatch(/clause titles could not be searched/i);
    // Throwing six sevenths of an answer away helps nobody.
    expect(c.textContent).toContain('Ashcroft lease');
    expect(c.querySelector('[data-search-source-failed="clause"]')).not.toBeNull();
    // …and it is NOT the empty sentence, which would say something untrue
    // about the corpus.
    expect(c.textContent).not.toMatch(/nothing matched/i);
  });

  it('says when a source was capped, with the limit', () => {
    const c = mount(palette(CAPPED));
    expect(c.querySelector('[data-search-source-capped="matter"]')?.textContent)
      .toMatch(/only the first 20 are shown/i);
  });

  it('says nothing about a source that answered normally', () => {
    const c = mount(palette(EMPTY_RESULTS));
    expect(c.querySelector('[data-search-source-failed]')).toBeNull();
    expect(c.querySelector('[data-search-source-capped]')).toBeNull();
  });
});

describe('a precedent is labelled a precedent and never a matter document (S23)', () => {
  it('groups it under its own heading and says what it is', () => {
    const c = mount(palette(PRECEDENT));
    expect(c.querySelector('[data-search-group="precedent"]')).not.toBeNull();
    expect(c.querySelector('[data-search-group="document"]')).toBeNull();
    // A precedent is somebody else's deal. One that read as a document in
    // this matter could be opened as though it were the deal under review.
    expect(c.textContent).toMatch(/precedents/i);
    expect(c.textContent).toMatch(/other firms/i);
  });
});

describe('the palette itself', () => {
  it('renders nothing at all when closed', () => {
    const c = mount(palette(PARTIAL, { open: false }));
    expect(c.textContent).toBe('');
  });

  it('takes the reader to a hit when there is somewhere to go', () => {
    const onOpen = vi.fn();
    const c = mount(palette(PARTIAL, { onOpen }));
    click(c.querySelector('[data-search-hit="matter"]'));
    expect(onOpen).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'matter', id: 'm1' }));
    // …and offers no dead control when there is not.
    expect(mount(palette(PARTIAL)).querySelector('button[data-search-hit]')).toBeNull();
  });

  it('closes on the Modal s own control, rather than a second overlay', () => {
    const onClose = vi.fn();
    const c = mount(palette(PARTIAL, { onClose }));
    click(buttonNamed(c, /^Close$/));
    expect(onClose).toHaveBeenCalledTimes(1);
    // ONE overlay: focus, the scrim and the responsive sheet are solved
    // once, in `Modal`, and a second would be a second set of those
    // decisions drifting.
    const code = readFileSync(
      path.join(process.cwd(), 'src/features/search/SearchPalette.tsx'), 'utf8');
    expect(code).toContain("from '../../components/Modal'");
    expect(code).not.toMatch(/fixed inset-0/);
  });

  it('builds no class name out of a variable', () => {
    const code = readFileSync(
      path.join(process.cwd(), 'src/features/search/SearchPalette.tsx'), 'utf8');
    expect(code).not.toMatch(/className=\{`[^`]*\$\{[^}]*\}(-|\s|`)/);
    expect(code).toContain('text-risk-med');
  });
});
