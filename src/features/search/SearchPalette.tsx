import React, { useEffect, useRef } from 'react';
import type { SearchHit, SearchSource, SearchSourceOutcome } from '@lexprompt/core';
import { Modal } from '../../components/Modal';
import { SEARCH_MIN_CHARS, type SearchState } from './useSearch';

/**
 * WHAT THIS SEARCHES, IN WORDS, ON EVERY STATE.
 *
 * ONE constant, rendered in every state including an empty result and a
 * failure. The route's own docstring gives the reasoning at length; this is
 * the half a reader sees, and it is the reason the corpus decision is
 * defensible at all. A search that silently misses documents is worse than
 * no search: it turns "I looked and it is not there" into a claim the
 * software invited and cannot support.
 */
export const SEARCH_CORPUS_SENTENCE =
  'This searches names: matters, documents, precedents, reviews, collections, playbooks and '
  + 'clause titles. It does not search the text inside documents.';

/** The heading each group of hits carries. A precedent is labelled as a
 *  precedent here as well as in the query (S23): it is somebody else's deal
 *  and must never read as a document in this matter. */
const GROUP_LABEL: Record<SearchSource, string> = {
  matter: 'Matters',
  document: 'Documents',
  precedent: 'Precedents (other firms’ deals, kept to learn from)',
  review: 'Reviews',
  collection: 'Collections',
  playbook: 'Playbooks',
  clause: 'Clause titles',
};

/** The order groups appear in, which is the order the route runs its arms.
 *  There is no relevance score and inventing one would be a ranking the
 *  reader cannot see the reasoning of. */
const GROUP_ORDER: SearchSource[] = [
  'matter', 'document', 'precedent', 'review', 'collection', 'playbook', 'clause',
];

export interface SearchPaletteProps {
  open: boolean;
  state: SearchState;
  query: string;
  onQuery: (q: string) => void;
  onClose: () => void;
  onRetry: () => void;
  /** Opens a hit. Optional: a result list with nowhere to go is a list, and
   *  the palette says so by not offering a control rather than by offering a
   *  dead one. */
  onOpen?: (hit: SearchHit) => void;
  /**
   * Whether this particular hit has anywhere to go.
   *
   * PER HIT, not per palette, because the answer genuinely differs: a matter,
   * a review and a playbook each have a screen, and a precedent document does
   * not — precedents are read in a session and never stored (§11.1), so there
   * is no page to open one on. A control that navigated nowhere would be an
   * affordance implying a screen the app does not have; a hit rendered as
   * plain text says "this exists, and here is where it lives" without
   * promising more.
   */
  canOpen?: (hit: SearchHit) => boolean;
}

/**
 * FIRM-WIDE SEARCH (R-G14 discharged), and the difference between nothing
 * and broken.
 *
 * ## An empty result and a failure do not read the same
 *
 * *"Nothing matched"* is an answer. *"The search could not be run"* is not,
 * and it comes with **Try again**, which the empty state does not. An empty
 * list that really means a broken query is this project's founding defect
 * with a cursor blinking in it, and two states rendering as the same pixel is
 * exactly how it happens.
 *
 * ## A source that failed is NAMED, even when the others answered
 *
 * The route returns an outcome for every source on every answer. A source
 * whose arm threw is listed by name with the sentence the server produced —
 * the hits that DID arrive are still shown, because throwing six sevenths of
 * an answer away helps nobody, and a shorter list that says nothing about
 * why is the thing this whole feature exists not to render.
 *
 * ## `Modal`, not a second overlay
 *
 * Focus, the scrim, the escape hatch and the responsive sheet are already
 * solved once. A second overlay would be a second set of those decisions,
 * drifting.
 */
export function SearchPalette({
  open, state, query, onQuery, onClose, onRetry, onOpen, canOpen,
}: SearchPaletteProps) {
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (open) input.current?.focus();
  }, [open]);

  const failedSources = state.status === 'results'
    ? state.results.sources.filter(s => s.status === 'failed') : [];
  const cappedSources = state.status === 'results'
    ? state.results.sources.filter(s => s.status === 'capped') : [];
  const groups = state.status === 'results'
    ? GROUP_ORDER
      .map(source => ({
        source,
        hits: state.results.hits.filter(h => h.source === source),
      }))
      .filter(g => g.hits.length > 0)
    : [];

  return (
    <Modal isOpen={open} title="Search" onClose={onClose} size="lg">
      <label className="block">
        <span className="sr-only">Search this firm</span>
        <input
          ref={input}
          type="text"
          value={query}
          onChange={e => onQuery(e.target.value)}
          placeholder="Matter, document, review, playbook or clause title"
          aria-label="Search this firm"
          className="w-full bg-card border border-rule-strong rounded-control px-3 py-2 font-ui text-ui text-ink-1 outline-none focus:ring-1 focus:ring-accent"
        />
      </label>

      {/* THE CORPUS, ON EVERY STATE. Not only on the empty one: a reader who
          finds something still has to know what was not looked in. */}
      <p data-search-corpus className="font-ui text-ui-sm text-ink-3">
        {SEARCH_CORPUS_SENTENCE}
      </p>

      {state.status === 'idle' && (
        <p className="font-ui text-ui-sm text-ink-4">
          {`Type at least ${SEARCH_MIN_CHARS} characters.`}
        </p>
      )}

      {state.status === 'searching' && (
        <p className="font-ui text-ui-sm text-ink-4" aria-live="polite">Searching…</p>
      )}

      {state.status === 'failed' && (
        <div data-search-failed className="space-y-2">
          <p className="font-ui text-ui-sm text-risk-high">
            {`That search could not be run. ${state.message}`}
          </p>
          {/* THE CONTROL THE EMPTY STATE DOES NOT HAVE, which is half of how
              a reader tells the two apart. */}
          <button
            type="button"
            onClick={onRetry}
            className="font-ui text-ui-sm text-accent underline underline-offset-2 hover:text-accent-strong transition-colors"
          >
            Try again
          </button>
        </div>
      )}

      {state.status === 'results' && (
        <div className="space-y-4">
          {failedSources.map(s => (
            <p
              key={s.source}
              data-search-source-failed={s.source}
              className="font-ui text-ui-sm text-risk-med"
            >
              {s.message}
            </p>
          ))}
          {cappedSources.map(s => (
            <p
              key={s.source}
              data-search-source-capped={s.source}
              className="font-ui text-ui-sm text-risk-med"
            >
              {`${GROUP_LABEL[s.source]}: only the first ${s.limit} are shown. `
                + 'Narrow the search to see the rest.'}
            </p>
          ))}

          {state.results.hits.length === 0 ? (
            <p data-search-empty className="font-ui text-ui-sm text-ink-3">
              {`Nothing matched “${state.results.query}”.`}
            </p>
          ) : (
            groups.map(group => (
              <section key={group.source} data-search-group={group.source} className="space-y-1">
                <h4 className="font-mono text-chip uppercase text-ink-4">
                  {GROUP_LABEL[group.source]}
                </h4>
                <ul className="space-y-0.5">
                  {group.hits.map(hit => (
                    <li key={`${hit.source}:${hit.id}:${hit.clauseId ?? ''}`}>
                      <Hit
                        hit={hit}
                        onOpen={onOpen && (canOpen ? canOpen(hit) : true) ? onOpen : undefined}
                      />
                    </li>
                  ))}
                </ul>
              </section>
            ))
          )}
        </div>
      )}
    </Modal>
  );
}

function Hit({ hit, onOpen }: { hit: SearchHit; onOpen?: (hit: SearchHit) => void }) {
  const body = (
    <>
      <span className="font-ui text-ui text-ink-1">{hit.title}</span>
      {hit.context && (
        <span className="font-ui text-ui-sm text-ink-4">{` · ${hit.context}`}</span>
      )}
    </>
  );
  if (!onOpen) {
    return <span data-search-hit={hit.source} className="block px-2 py-1">{body}</span>;
  }
  return (
    <button
      type="button"
      data-search-hit={hit.source}
      onClick={() => onOpen(hit)}
      className="block w-full text-left px-2 py-1 rounded-inset hover:bg-chip-fill transition-colors"
    >
      {body}
    </button>
  );
}

export type { SearchSourceOutcome };
