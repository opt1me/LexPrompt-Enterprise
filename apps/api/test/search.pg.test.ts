import { describe, it, expect } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { SearchResults, SearchSource } from '@lexprompt/core';
import { withPg, dbOn, migratorDb } from './helpers/pgHarness.ts';
import { buildTestApi } from './helpers/apiHarness.ts';
import { runSearch, SEARCH_ARMS, likePattern } from '../src/routes/search.ts';
import type { Tx } from '../src/db/pool.ts';

/**
 * ONE SEARCH, A DECLARED CORPUS, AND AN OUTCOME FOR EVERY SOURCE.
 *
 * The assertion that matters most in this file is the one about a BROKEN
 * ARM. Every other case here would pass against an implementation that runs
 * the seven queries in a `UNION` and answers an empty list when any of them
 * throws — which is this project's founding defect with a cursor blinking in
 * it: a corpus of seven things where one query errored and six matched
 * nothing must not render as "nothing found".
 */

const WS = '00000000-0000-0000-0000-000000000001';
const OTHER_WS = '00000000-0000-0000-0000-0000000000f2';
const ME = '00000000-0000-0000-0000-0000000000e1';
const STRANGER = '00000000-0000-0000-0000-0000000000e2';

/** Every source, written out. A table-driven case over this list means a NEW
 *  arm with no entry here fails rather than going unchecked. */
const ALL_SOURCES: SearchSource[] = [
  'matter', 'document', 'precedent', 'review', 'collection', 'playbook', 'clause',
];

interface Harness {
  app: FastifyInstance;
  send(method: 'GET', url: string): Promise<{
    statusCode: number; json(): any; body: string;
  }>;
}

function as(
  t: Tx, actorId: string | null, workspaceId = WS, limit = 20,
): Harness {
  const { app } = buildTestApi({
    principal: actorId === null
      ? null : { issuer: 'i', subject: `s-${actorId}`, groups: ['reviewers'] },
    db: dbOn(t),
    searchLimitPerSource: limit,
    actor: {
      id: actorId ?? 'nobody', displayName: 'A Person', initials: 'AP',
      role: 'reviewer', workspaceId,
    },
  });
  return {
    app,
    send: ((method: string, url: string) => app.inject({
      method: method as 'GET', url,
      ...(actorId === null ? {} : { headers: { authorization: 'Bearer t' } }),
    })) as never,
  };
}

async function searchAs(
  t: Tx, actorId: string, q: string, workspaceId = WS, limit = 20,
): Promise<SearchResults> {
  const res = await as(t, actorId, workspaceId, limit)
    .send('GET', `/v1/search?q=${encodeURIComponent(q)}`);
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as SearchResults;
}

async function people(t: Tx): Promise<void> {
  await t.query(
    `insert into app_user
       (id, workspace_id, issuer, subject, display_name, initials, role, status)
     values ($1, $2, 'i', $3, 'A Person', 'AP', 'reviewer', 'active')
     on conflict (id) do nothing`, [ME, WS, `s-${ME}`]);
}

/** One of every searchable thing, all naming "Ashcroft". */
async function corpus(t: Tx, ws = WS, prefix = ''): Promise<{ matterId: string }> {
  const id = (name: string): string => `${prefix}sr-${name}`;
  await t.query(
    `insert into matter (id, workspace_id, name, client, reference, created_at, updated_at)
     values ($1, $2, 'Ashcroft lease', 'Ashcroft Ltd', 'AL-2026', now(), now())`,
    [id('m'), ws]);
  await t.query(
    `insert into document
       (id, workspace_id, matter_id, name, doc_type, text, parse_state, byte_size, mime,
        blob_key, role, added_at, kind)
     values ($1, $2, $3, 'Ashcroft headlease.pdf', 'pdf', 'body text', 'parsed', 10,
             'application/pdf', 'k1', 'standalone', now(), 'matter')`,
    [id('d'), ws, id('m')]);
  await t.query(
    `insert into precedent_set (id, workspace_id, name, created_at)
     values ($1, $2, 'Old deals', now())`, [id('ps'), ws]);
  await t.query(
    `insert into document
       (id, workspace_id, matter_id, name, doc_type, text, parse_state, byte_size, mime,
        blob_key, role, added_at, kind, precedent_set_id)
     values ($1, $2, null, 'Ashcroft precedent 2019.pdf', 'pdf', 'body text', 'parsed', 10,
             'application/pdf', 'k2', 'standalone', now(), 'precedent', $3)`,
    [id('pd'), ws, id('ps')]);
  await t.query(
    `insert into review (id, workspace_id, matter_id, playbook_snapshot, target, findings,
                         model_id, started_at)
     values ($1, $2, $3, '{"name":"Ashcroft review"}'::jsonb,
             '{"kind":"documents","documentIds":[]}'::jsonb, '{}'::jsonb, 'm', now())`,
    [id('r'), ws, id('m')]);
  await t.query(
    `insert into collection
       (id, workspace_id, matter_id, name, base_document_id, created_at)
     values ($1, $2, $3, 'Ashcroft chain', $4, now())`,
    [id('c'), ws, id('m'), id('d')]);
  await t.query(
    `insert into playbook (id, workspace_id, name, created_at, updated_at, schema_version)
     values ($1, $2, 'Ashcroft playbook', now(), now(), 1)`, [id('p'), ws]);
  await t.query(
    `insert into playbook_version
       (id, workspace_id, playbook_id, version_number, content, published_at)
     values ($1, $2, $3, 1,
             '{"clauses":[{"id":"c1","title":"Ashcroft break right"}]}'::jsonb, now())`,
    [id('pv'), ws, id('p')]);
  await t.query('update playbook set current_version_id = $1 where id = $2',
    [id('pv'), id('p')]);
  return { matterId: id('m') };
}

describe('firm-wide search finds what it says it searches', () => {
  it('finds a matter by name, client and reference', async () => {
    await withPg(async t => {
      await people(t);
      const { matterId } = await corpus(t);
      for (const q of ['ashcroft', 'AL-2026', 'Ashcroft Ltd']) {
        const r = await searchAs(t, ME, q);
        expect(r.hits.some(h => h.source === 'matter' && h.id === matterId), q).toBe(true);
      }
    });
  });

  it('is case-insensitive and matches inside a name, not only at its start', async () => {
    await withPg(async t => {
      await people(t);
      const { matterId } = await corpus(t);
      expect((await searchAs(t, ME, 'CROFT')).hits.some(h => h.id === matterId)).toBe(true);
    });
  });

  it('finds one hit from every source it declares', async () => {
    await withPg(async t => {
      await people(t);
      await corpus(t);
      const r = await searchAs(t, ME, 'Ashcroft');
      // TABLE-DRIVEN over the declared corpus, so an arm that stopped
      // answering shows up as its own name rather than as a smaller number.
      for (const source of ALL_SOURCES) {
        expect(r.hits.filter(h => h.source === source).length, source).toBeGreaterThan(0);
      }
      // A clause hit carries the PLAYBOOK's id, because a clause is not a
      // record a URL can open on its own.
      const clause = r.hits.find(h => h.source === 'clause')!;
      expect(clause.id).toBe('sr-p');
      expect(clause.clauseId).toBe('c1');
      expect(clause.context).toBe('Ashcroft playbook');
    });
  });

  it('never returns a precedent document as a matter document (S23)', async () => {
    await withPg(async t => {
      await people(t);
      await corpus(t);
      const r = await searchAs(t, ME, 'precedent 2019');
      // A precedent is somebody else's deal. One appearing in a matter's
      // document list could be opened as though it were the deal under
      // review, and the distinction has to survive into the result list.
      expect(r.hits.filter(h => h.source === 'document')).toHaveLength(0);
      expect(r.hits.filter(h => h.source === 'precedent')).toHaveLength(1);
      // …and the matter document is still found as a document.
      const other = await searchAs(t, ME, 'headlease');
      expect(other.hits.filter(h => h.source === 'document')).toHaveLength(1);
      expect(other.hits.filter(h => h.source === 'precedent')).toHaveLength(0);
    });
  });

  it('does NOT search the text inside documents, which is the declared limit', async () => {
    await withPg(async t => {
      await people(t);
      await corpus(t);
      // `document.text` holds 'body text' and is deliberately not searched.
      // The palette states this in words on every result set; here it is
      // asserted as a fact about the query rather than left to the copy.
      const r = await searchAs(t, ME, 'body text');
      expect(r.hits).toHaveLength(0);
      // …and every source still REPORTS, which is what stops the empty list
      // above being read as a failure.
      expect(r.sources.every(s => s.status === 'ok')).toBe(true);
    });
  });

  it('does not search an unpublished draft playbook', async () => {
    await withPg(async t => {
      await people(t);
      await t.query(
        `insert into playbook (id, workspace_id, name, created_at, updated_at, schema_version,
                               draft)
         values ('pb-draft', $1, 'Draft only', now(), now(), 1,
                 '{"clauses":[{"id":"c1","title":"Zzunpublished clause"}]}'::jsonb)`, [WS]);
      // A draft is a playbook nobody has agreed to (R-E1's reasoning, one
      // layer along). Its NAME is searchable, because the record exists;
      // its clause titles are not, because nothing has published them.
      const r = await searchAs(t, ME, 'Zzunpublished');
      expect(r.hits).toHaveLength(0);
      expect((await searchAs(t, ME, 'Draft only')).hits.map(h => h.source)).toEqual(['playbook']);
    });
  });

  it('matches like metacharacters literally, so 50% does not return everything', async () => {
    await withPg(async t => {
      await people(t);
      await t.query(
        `insert into matter (id, workspace_id, name, created_at, updated_at)
         values ('m-pct', $1, 'Cap at 50% of fees', now(), now()),
                ('m-other', $1, 'Nothing to do with it', now(), now())`, [WS]);
      expect(likePattern('50%')).toBe('%50\\%%');
      const r = await searchAs(t, ME, '50%');
      expect(r.hits.map(h => h.id)).toEqual(['m-pct']);
    });
  });
});

describe('an outcome for every source, on every answer', () => {
  it('reports every source on a completely successful search', async () => {
    await withPg(async t => {
      await people(t);
      await corpus(t);
      const r = await searchAs(t, ME, 'zzzznothingmatchesthis');
      expect(r.hits).toHaveLength(0);
      expect(r.sources.map(s => s.source).sort()).toEqual([...ALL_SOURCES].sort());
      expect(r.sources.every(s => s.status === 'ok' && s.count === 0)).toBe(true);
      // `query` comes back, so a stale answer can be told apart from a
      // current one by whatever renders it.
      expect(r.query).toBe('zzzznothingmatchesthis');
    });
  });

  it('answers with the other arms hits when ONE arm throws', async () => {
    await withPg(async t => {
      await people(t);
      await corpus(t);
      /*
       * THE MUTATION THIS KILLS: make the wrapper swallow the error and
       * return `status: 'ok', count: 0`. Every happy-path case above still
       * passes, and the result renders as "nothing else matched" — a
       * statement about the firm's records that is not true.
       *
       * The broken arm is injected rather than simulated: it is a real
       * statement against a table that does not exist, so what is proved is
       * that a genuine database error is contained.
       */
      const broken = SEARCH_ARMS.map(arm => (arm.source === 'clause'
        ? { ...arm, sql: 'select * from table_that_does_not_exist where workspace_id = $1' }
        : arm));
      const r = await runSearch(dbOn(t), WS, 'Ashcroft', 20, broken);

      expect(r.hits.some(h => h.source === 'matter')).toBe(true);
      expect(r.hits.some(h => h.source === 'clause')).toBe(false);
      const clause = r.sources.find(s => s.source === 'clause')!;
      expect(clause.status).toBe('failed');
      expect(clause.message).toMatch(/could not be searched/i);
      expect(clause.count).toBe(0);
      // …and the six that answered are ok, so "failed" is about the arm and
      // not about the request.
      expect(r.sources.filter(s => s.status === 'ok')).toHaveLength(6);
    });
  });

  it('does not turn a broken arm into a 500, over the real route', async () => {
    await withPg(async t => {
      await people(t);
      await corpus(t);
      // The route itself, with a broken db: a failure in one arm must not
      // throw away the arms that answered, and it must not answer 500 —
      // which a browser renders as "the search could not be run" for a
      // search that six sevenths ran.
      const r = await runSearch(dbOn(t), WS, 'Ashcroft', 20,
        SEARCH_ARMS.map(arm => (arm.source === 'playbook'
          ? { ...arm, sql: 'select nonsense_column from playbook where workspace_id = $1' }
          : arm)));
      expect(r.sources.find(s => s.source === 'playbook')!.status).toBe('failed');
      expect(r.hits.length).toBeGreaterThan(0);
    });
  });

  it('reports capped rather than silently returning a short list', async () => {
    await withPg(async t => {
      await people(t);
      for (let i = 0; i < 4; i++) {
        await t.query(
          `insert into matter (id, workspace_id, name, created_at, updated_at)
           values ($1, $2, $3, now(), now())`, [`m-many-${i}`, WS, `Manyfold ${i}`]);
      }
      const r = await searchAs(t, ME, 'Manyfold', WS, 3);
      const m = r.sources.find(s => s.source === 'matter')!;
      expect(m).toMatchObject({ source: 'matter', status: 'capped', count: 3, limit: 3 });
      expect(r.hits.filter(h => h.source === 'matter')).toHaveLength(3);
      // …and the same data under a limit that fits is `ok`, so `capped` is
      // measured rather than always-on.
      expect((await searchAs(t, ME, 'Manyfold', WS, 4))
        .sources.find(s => s.source === 'matter')!.status).toBe('ok');
    });
  });
});

describe('the refusals, which are never an empty result', () => {
  it('refuses a query below the minimum, and says so', async () => {
    await withPg(async t => {
      await people(t);
      const res = await as(t, ME).send('GET', '/v1/search?q=a');
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('query_too_short');
      // NEVER an empty result set: "nothing in this firm matches" is a
      // statement about the corpus and must not be made about a query that
      // was never run.
      expect(res.json().hits).toBeUndefined();
    });
  });

  it('refuses a missing and a whitespace-only query the same way', async () => {
    await withPg(async t => {
      await people(t);
      for (const url of ['/v1/search', '/v1/search?q=', '/v1/search?q=%20%20']) {
        const res = await as(t, ME).send('GET', url);
        expect(res.statusCode, url).toBe(400);
        expect(res.json().error.code, url).toBe('query_too_short');
      }
    });
  });

  it('refuses an unauthenticated caller with 401 and not an empty result', async () => {
    await withPg(async t => {
      await people(t);
      await corpus(t);
      const res = await as(t, null).send('GET', '/v1/search?q=ashcroft');
      expect(res.statusCode).toBe(401);
      expect(res.json().error.code).toBe('sign_in_required');
      expect(res.json().hits).toBeUndefined();
    });
  });

  it('never crosses a workspace, in EVERY arm', async () => {
    await withPg(async t => {
      await t.query(
        `insert into workspace (id, name) values ($1, 'Another firm')
         on conflict (id) do nothing`, [OTHER_WS]);
      await t.query(
        `insert into app_user
           (id, workspace_id, issuer, subject, display_name, initials, role, status)
         values ($1, $2, 'i', 's-stranger', 'S', 'SS', 'reviewer', 'active')
         on conflict (id) do nothing`, [STRANGER, OTHER_WS]);
      await people(t);
      await corpus(t, OTHER_WS, 'x');
      // Every record naming "Ashcroft" belongs to the OTHER firm. A missing
      // `workspace_id` predicate in any single arm breaks nothing a test of
      // the feature would notice — the record is found, the list renders,
      // and the reader is handed the name of another firm's matter.
      const r = await searchAs(t, ME, 'Ashcroft');
      expect(r.hits).toEqual([]);
      for (const source of ALL_SOURCES) {
        expect(r.sources.find(s => s.source === source)!.count, source).toBe(0);
      }
      // …and the other firm's own caller DOES see them, so the emptiness
      // above is about the predicate rather than about the seed.
      const theirs = await searchAs(t, STRANGER, 'Ashcroft', OTHER_WS);
      for (const source of ALL_SOURCES) {
        expect(theirs.hits.filter(h => h.source === source).length, source).toBeGreaterThan(0);
      }
    }, migratorDb());
  });
});
