import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ModelError, type SearchResults } from '@lexprompt/core';
import { makeFakeTransport, transportModule } from '../../test/fakeTransport';

/**
 * THE BROWSER'S ONE CALL TO THE SEARCH ROUTE.
 *
 * Two things it must do, and they are the two tests here: reject a transport
 * failure rather than flattening it into an empty result set, and hand a
 * PER-SOURCE failure back inside the answer, where the other sources' hits
 * survive it.
 */

const transport = makeFakeTransport();
vi.mock('./client', () => transportModule(transport));

const { search } = await import('./search');

const PARTIAL: SearchResults = {
  query: 'ashcroft',
  hits: [{ source: 'matter', id: 'm1', title: 'Ashcroft lease', context: 'Ashcroft Ltd' }],
  sources: [
    { source: 'matter', status: 'ok', count: 1 },
    { source: 'document', status: 'ok', count: 0 },
    { source: 'precedent', status: 'ok', count: 0 },
    { source: 'review', status: 'ok', count: 0 },
    { source: 'collection', status: 'ok', count: 0 },
    { source: 'playbook', status: 'ok', count: 0 },
    { source: 'clause', status: 'failed', count: 0,
      message: 'Clause titles could not be searched. Some results are missing from this list.' },
  ],
};

beforeEach(() => { transport.reset(); });

describe('search rejects a transport failure and never answers empty for one', () => {
  it('rejects when the request itself fails', async () => {
    transport.failures.set('/v1/search?q=ashcroft', new ModelError(
      "LexPrompt could not reach your firm's service.", 'network', 0));
    // NEVER `{ hits: [], sources: [] }`. "Nothing in this firm matches" is a
    // statement about the corpus, and making it about a request that never
    // arrived is the founding defect at a search box.
    await expect(search('ashcroft')).rejects.toThrow(/could not reach/);
  });

  it('rejects a refused query rather than answering an empty result', async () => {
    transport.failures.set('/v1/search?q=a', new ModelError(
      'A search needs at least 2 characters.', 'query_too_short', 400));
    await expect(search('a')).rejects.toMatchObject({ code: 'query_too_short' });
  });

  it('encodes the query, so a search for an ampersand is not two parameters', async () => {
    transport.responses.set('/v1/search?q=cap%20%26%20collar', { ...PARTIAL, query: 'cap & collar' });
    expect((await search('cap & collar')).query).toBe('cap & collar');
  });
});

describe('a per-source failure is inside the answer, not an exception', () => {
  it('resolves, keeps the other sources hits, and carries the failed one', async () => {
    transport.responses.set('/v1/search?q=ashcroft', PARTIAL);
    const r = await search('ashcroft');
    // The difference between this and a rejection is that the hits survive.
    expect(r.hits).toHaveLength(1);
    expect(r.sources.find(s => s.source === 'clause')).toMatchObject({
      status: 'failed', count: 0,
    });
    expect(r.sources.find(s => s.source === 'clause')!.message)
      .toMatch(/could not be searched/i);
  });

  it('carries an outcome for every source, including on a fully successful answer', async () => {
    const all: SearchResults = {
      query: 'zzz',
      hits: [],
      sources: PARTIAL.sources.map(s => ({ source: s.source, status: 'ok' as const, count: 0 })),
    };
    transport.responses.set('/v1/search?q=zzz', all);
    const r = await search('zzz');
    expect(r.hits).toHaveLength(0);
    // An empty list with seven `ok` outcomes is a real answer. An empty list
    // with no outcomes at all would be indistinguishable from a broken one.
    expect(r.sources).toHaveLength(7);
    expect(r.sources.every(s => s.status === 'ok')).toBe(true);
  });
});
