import { useCallback, useEffect, useRef, useState } from 'react';
import { SEARCH_MIN_CHARS, type SearchResults } from '@lexprompt/core';
import { search as runSearch } from '../../lib/api/search';
import { describeLoadError } from '../../lib/loadError';

export { SEARCH_MIN_CHARS };

/**
 * How long after the last keystroke a search is actually run.
 *
 * Declared rather than picked: it is the number that decides how many
 * requests a nine-letter matter name costs, and an undeclared one is a knob
 * nobody can find. Short enough that a reader who has stopped typing does
 * not notice it.
 */
export const SEARCH_DEBOUNCE_MS = 200;

/**
 * FOUR STATES, AND THE FOURTH IS WHY THIS HOOK EXISTS.
 *
 * - `idle` — nothing typed, or below `SEARCH_MIN_CHARS`.
 * - `searching` — a request is in flight.
 * - `results` — an answer came back. It may hold zero hits AND a failed
 *   source; those are two different facts and both are in the value.
 * - `failed` — the REQUEST itself failed. Distinct from `results` with zero
 *   hits, distinct from `results` with a failed source, and rendered
 *   differently from both.
 *
 * Collapsing any two of them produces the same defect in a different place:
 * an empty list that really means something broke. "Nothing in this firm
 * matches" is a statement about the corpus, and it must only ever be made
 * about a search that ran.
 */
export type SearchState =
  | { status: 'idle' }
  | { status: 'searching'; query: string }
  | { status: 'results'; results: SearchResults }
  | { status: 'failed'; query: string; message: string };

export interface UseSearchDeps {
  run?: typeof runSearch;
  /** Overridden to `0` by tests, so a hook test measures the hook rather
   *  than a timer. */
  debounceMs?: number;
}

export interface UseSearch {
  state: SearchState;
  query: string;
  setQuery: (q: string) => void;
  /** Re-runs the SAME query. A retry that cleared the box would make the
   *  reader retype what they already typed to find out whether the failure
   *  was theirs. */
  retry: () => void;
}

export function useSearch(deps: UseSearchDeps = {}): UseSearch {
  const run = deps.run ?? runSearch;
  const debounceMs = deps.debounceMs ?? SEARCH_DEBOUNCE_MS;
  const [query, setQuery] = useState('');
  const [state, setState] = useState<SearchState>({ status: 'idle' });

  /**
   * A MONOTONIC SEQUENCE NUMBER, and a response whose sequence is not the
   * latest is DISCARDED — never merged, never rendered.
   *
   * Without it a slow answer for "a" overwrites a fast answer for
   * "ashcroft", and the screen shows results for something nobody asked.
   * That is not a cosmetic race: the reader is looking at a list under a
   * query box that says something else, which is a wrong answer wearing a
   * correct one's clothes.
   */
  const seq = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const runFor = useCallback((q: string) => {
    const mine = ++seq.current;
    // The superseded request is aborted rather than left to land and be
    // thrown away. `apiGet` propagates an abort as an abort, so nothing here
    // turns a user's next keystroke into a reported failure.
    controller.current?.abort();
    const own = new AbortController();
    controller.current = own;
    setState({ status: 'searching', query: q });
    run(q, own.signal).then(
      (results) => { if (seq.current === mine) setState({ status: 'results', results }); },
      (e: unknown) => {
        if (seq.current !== mine) return;
        if ((e as { name?: string } | null)?.name === 'AbortError') return;
        setState({
          status: 'failed',
          query: q,
          message: describeLoadError(e, 'LexPrompt could not run that search.'),
        });
      },
    );
  }, [run]);

  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length < SEARCH_MIN_CHARS) {
      // IDLE, not an empty result. Typing one letter must never render
      // "nothing matched", which is a false statement about the corpus —
      // and the sequence still advances, so an answer for a longer query
      // already in flight cannot land after the box was cleared.
      seq.current += 1;
      controller.current?.abort();
      controller.current = null;
      setState({ status: 'idle' });
      return undefined;
    }
    if (debounceMs === 0) { runFor(trimmed); return undefined; }
    const timer = setTimeout(() => runFor(trimmed), debounceMs);
    return () => { clearTimeout(timer); };
  }, [query, debounceMs, runFor]);

  const retry = useCallback(() => {
    const trimmed = query.trim();
    if (trimmed.length >= SEARCH_MIN_CHARS) runFor(trimmed);
  }, [query, runFor]);

  return { state, query, setQuery, retry };
}
