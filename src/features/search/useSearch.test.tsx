import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { ModelError, type SearchResults } from '@lexprompt/core';
import { mount, flushUntil } from '../../test/mount';
import { useSearch, type SearchState } from './useSearch';

/**
 * FOUR STATES, AND THE FOURTH IS WHY THE HOOK EXISTS.
 *
 * The two cases that matter here are the two that produce a wrong answer
 * rather than an ugly one: a query below the minimum rendering "nothing
 * matched" (a false statement about the corpus), and a slow answer for an
 * abandoned query landing after a fast one and being shown under a query box
 * that says something else.
 */

const RESULTS = (query: string, hits: number): SearchResults => ({
  query,
  hits: Array.from({ length: hits }, (_, i) => ({
    source: 'matter' as const, id: `m${i}`, title: `${query} ${i}`,
  })),
  sources: [{ source: 'matter', status: 'ok', count: hits }],
});

/** Drives the hook and records every state it has been in. */
function Probe({ run, seen, api }: {
  run: (q: string, signal?: AbortSignal) => Promise<SearchResults>;
  seen: SearchState[];
  api: { setQuery?: (q: string) => void; retry?: () => void };
}) {
  const s = useSearch({ run, debounceMs: 0 });
  api.setQuery = s.setQuery;
  api.retry = s.retry;
  seen.push(s.state);
  return <span data-status={s.state.status}>{s.query}</span>;
}

function drive(run: (q: string, signal?: AbortSignal) => Promise<SearchResults>): {
  seen: SearchState[]; setQuery: (q: string) => void; retry: () => void;
} {
  const seen: SearchState[] = [];
  const api: { setQuery?: (q: string) => void; retry?: () => void } = {};
  mount(<Probe run={run} seen={seen} api={api} />);
  return {
    seen,
    setQuery: (q: string) => { api.setQuery!(q); },
    retry: () => { api.retry!(); },
  };
}

const act = async (fn: () => void): Promise<void> => {
  const { act: reactAct } = await import('react');
  await reactAct(async () => { fn(); await Promise.resolve(); });
};

describe('the hook stays idle below the minimum', () => {
  it('never runs a search for one letter, and never shows an empty result for it', async () => {
    const run = vi.fn(async (q: string) => RESULTS(q, 0));
    const { seen, setQuery } = drive(run);
    await act(() => setQuery('a'));
    // THE DEFECT THIS KILLS: typing "a" firing a search that returns nothing
    // and rendering "No results" — which is a false statement about what is
    // in the firm's records.
    expect(run).not.toHaveBeenCalled();
    expect(seen.at(-1)!.status).toBe('idle');
  });

  it('returns to idle when the box is cleared, rather than keeping the old list', async () => {
    const run = vi.fn(async (q: string) => RESULTS(q, 2));
    const { seen, setQuery } = drive(run);
    await act(() => setQuery('ashcroft'));
    await flushUntil(() => seen.at(-1)!.status === 'results', 'the first answer');
    await act(() => setQuery(''));
    expect(seen.at(-1)!.status).toBe('idle');
  });
});

describe('a stale answer is discarded, never rendered', () => {
  it('discards a response for a query the user has moved on from', async () => {
    // Two in flight, the FIRST resolving SECOND. The rendered state must be
    // the second query's, by sequence number and not by arrival — otherwise
    // a slow "as" answer overwrites a fast "ashcroft" answer and the screen
    // shows results for something nobody asked.
    let releaseSlow: (r: SearchResults) => void = () => {};
    const run = vi.fn((q: string) => (q === 'as'
      ? new Promise<SearchResults>(res => { releaseSlow = res; })
      : Promise.resolve(RESULTS(q, 3))));
    const { seen, setQuery } = drive(run);
    await act(() => setQuery('as'));
    await act(() => setQuery('ashcroft'));
    await flushUntil(() => seen.at(-1)!.status === 'results', 'the second answer');
    expect((seen.at(-1) as { results: SearchResults }).results.query).toBe('ashcroft');

    await act(() => releaseSlow(RESULTS('as', 99)));
    // Still the SECOND query's answer.
    const last = seen.at(-1) as { status: string; results?: SearchResults };
    expect(last.status).toBe('results');
    expect(last.results!.query).toBe('ashcroft');
  });

  it('does not report a superseded request s abort as a failure', async () => {
    // A user typing the next letter is not a failure of the firm's service.
    const run = vi.fn((q: string, signal?: AbortSignal) => (q === 'as'
      ? new Promise<SearchResults>((_res, rej) => {
        signal?.addEventListener('abort', () => {
          const e = new Error('aborted');
          e.name = 'AbortError';
          rej(e);
        });
      })
      : Promise.resolve(RESULTS(q, 1))));
    const { seen, setQuery } = drive(run);
    await act(() => setQuery('as'));
    await act(() => setQuery('ashcroft'));
    await flushUntil(() => seen.at(-1)!.status === 'results', 'the second answer');
    expect(seen.some(s => s.status === 'failed')).toBe(false);
  });
});

describe('failed and results-with-zero-hits are different states', () => {
  it('renders a rejection as failed and an empty answer as results', async () => {
    const failing = drive(() => Promise.reject(
      new ModelError("LexPrompt could not reach your firm's service.", 'network', 0)));
    await act(() => failing.setQuery('ashcroft'));
    await flushUntil(() => failing.seen.at(-1)!.status === 'failed', 'the failure');
    expect(failing.seen.at(-1)!.status).toBe('failed');
    expect((failing.seen.at(-1) as { message: string }).message).toMatch(/could not reach/);

    const empty = drive(async (q: string) => RESULTS(q, 0));
    await act(() => empty.setQuery('ashcroft'));
    await flushUntil(() => empty.seen.at(-1)!.status === 'results', 'the empty answer');
    expect(empty.seen.at(-1)!.status).toBe('results');
    // …and the empty answer still carries its per-source outcomes, which is
    // what makes it a real answer rather than a shrug.
    expect((empty.seen.at(-1) as { results: SearchResults }).results.sources).toHaveLength(1);
  });

  it('falls back to a subject-specific sentence for an opaque failure', async () => {
    const { seen, setQuery } = drive(() => Promise.reject(new Error('TypeError: nope')));
    await act(() => setQuery('ashcroft'));
    await flushUntil(() => seen.at(-1)!.status === 'failed', 'the failure');
    expect((seen.at(-1) as { message: string }).message)
      .toBe('LexPrompt could not run that search.');
  });
});

describe('retry re-runs the same query rather than clearing it', () => {
  it('runs the query again and keeps it in the box', async () => {
    let fail = true;
    const run = vi.fn((q: string) => (fail
      ? Promise.reject(new ModelError('nope', 'network', 0))
      : Promise.resolve(RESULTS(q, 1))));
    const { seen, setQuery, retry } = drive(run);
    await act(() => setQuery('ashcroft'));
    await flushUntil(() => seen.at(-1)!.status === 'failed', 'the failure');
    fail = false;
    await act(() => retry());
    await flushUntil(() => seen.at(-1)!.status === 'results', 'the retry s answer');
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[1][0]).toBe('ashcroft');
    // A retry that cleared the box would make the reader retype what they
    // already typed to find out whether the failure was theirs.
    expect((seen.at(-1) as { results: SearchResults }).results.query).toBe('ashcroft');
  });

  it('does nothing when there is nothing to retry', async () => {
    const run = vi.fn(async (q: string) => RESULTS(q, 0));
    const { retry } = drive(run);
    await act(() => retry());
    expect(run).not.toHaveBeenCalled();
  });
});
