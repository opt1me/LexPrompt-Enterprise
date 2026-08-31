import type { FastifyInstance } from 'fastify';
import {
  ModelError, SEARCH_MIN_CHARS,
  type SearchHit, type SearchResults, type SearchSource, type SearchSourceOutcome,
} from '@lexprompt/core';
import type { Db } from '../db/pool.ts';

/**
 * FIRM-WIDE SEARCH (§6.3, R-G14 discharged).
 *
 * ## What is searched
 *
 * Matter name, client and reference; matter-document name; precedent-document
 * name (returned as its own source, **never** as a matter document — S23);
 * review name; collection name; playbook name; and clause titles inside each
 * playbook's **current published version**.
 *
 * An unpublished DRAFT is not searched, and that is deliberate rather than an
 * oversight: a draft is a playbook nobody has agreed to (R-E1's reasoning,
 * one layer along), and a firm-wide search that surfaced one would put text
 * in front of a reader as though the firm stood behind it.
 *
 * ## What is NOT searched: the text inside documents
 *
 * Not an oversight and not a limitation of the data — `document.text` is
 * right there. Two reasons.
 *
 * **First**, there is no index for it and there cannot be a cheap one:
 * `lexprompt_migrator` is not a superuser and `pg_trgm` is not a trusted
 * extension, so a substring index over document bodies is unavailable.
 * Postgres's built-in `tsvector` needs no extension and **would** work, but
 * it matches by stemmed word — so a lawyer searching for a phrase they
 * remember verbatim would sometimes get nothing back from a document that
 * contains it.
 *
 * **Second, and decisive**: mixing two match semantics in one result list
 * makes an empty result mean two different things, which is exactly what
 * this feature exists not to do. The screen therefore **states the corpus in
 * words, on every result set including an empty one.**
 *
 * Closing this needs a `tsvector` column, a GIN index, and a second labelled
 * section on the palette that explains its own matching — a real feature,
 * named as the next one rather than folded in here.
 *
 * ## One statement per arm, and the departure from `activity.ts` is the point
 *
 * The activity feed's arms must be ordered and limited TOGETHER, which forces
 * one `UNION`. Search's arms are reported SEPARATELY, which forces the
 * opposite: a `UNION` that throws loses every arm, and the whole content of
 * this route is that it must not. So one parameterised query per source, run
 * concurrently, each wrapped so a rejection becomes a
 * `SearchSourceOutcome` with `status: 'failed'` rather than a rejected
 * request — the other six arms' hits survive, the reader is told which one
 * did not answer, and the response is a 200 rather than a 500.
 */
export interface SearchRouteOptions {
  /** `API_SEARCH_LIMIT_PER_SOURCE`. Read with a `limit + 1` so `capped` is
   *  measured rather than guessed. */
  limitPerSource: number;
}

export function registerSearch(
  app: FastifyInstance, db: Db, opts: SearchRouteOptions,
): void {
  app.get('/v1/search', async (req): Promise<SearchResults> => {
    const ws = req.actor!.workspaceId;
    const raw = (req.query as { q?: unknown } | null)?.q;
    const query = typeof raw === 'string' ? raw.trim() : '';
    if (query.length < SEARCH_MIN_CHARS) {
      // REFUSED, and said. Answering an empty result set for one letter
      // would be a false statement about the corpus: "nothing in this firm
      // matches" when nothing was looked for.
      throw new ModelError(
        `A search needs at least ${SEARCH_MIN_CHARS} characters. LexPrompt will not answer `
        + 'an empty result for a query it did not run.',
        'query_too_short', 400);
    }
    return runSearch(db, ws, query, opts.limitPerSource);
  });
}

/** One source's query and how its rows become hits. */
export interface SearchArm {
  source: SearchSource;
  /** `$1` workspace, `$2` the escaped `like` pattern, `$3` limit + 1. */
  sql: string;
  toHit(row: Record<string, unknown>): SearchHit;
}

/**
 * The `like` metacharacters, escaped so a user's query matches itself.
 *
 * A search for `50%` must find "50% of the fees" and not every record in the
 * firm; a search for `a_b` must not match `axb`. The backslash is escaped
 * FIRST, or escaping the others would double-escape it, and `\` is declared
 * as the escape character in every arm's `like` rather than relying on the
 * default (`standard_conforming_strings` makes the default `\`, but a value
 * that depends on a server setting is a value nobody can reason about).
 */
export function likePattern(query: string): string {
  return `%${query.replace(/\\/g, '\\\\').replace(/[%_]/g, c => `\\${c}`)}%`;
}

const text = (row: Record<string, unknown>, key: string): string => String(row[key] ?? '');
const maybe = (row: Record<string, unknown>, key: string): { context?: string } => {
  const value = row[key];
  // ABSENT rather than empty. `structuredClone` preserves an
  // undefined-valued key, so `context: undefined` would read to an `in`
  // check as a hit that has context and simply is not showing it.
  return value === null || value === undefined || value === ''
    ? {} : { context: String(value) };
};

/**
 * EVERY ARM CARRIES ITS OWN `workspace_id = $1` PREDICATE.
 *
 * `workspaceScope.test.ts` walks all of `apps/api/src` and reads these as
 * whole literals. A missing predicate here breaks nothing a test of the
 * feature would notice: the record is found, the list renders, and the
 * reader is handed the name of another firm's matter.
 *
 * The two document arms carry `kind = 'matter'` or `kind = 'precedent'`,
 * never neither: a query with no `kind` predicate fails by showing too much,
 * which is §19's own warning and which is why 003 dropped the column's
 * default.
 */
export const SEARCH_ARMS: SearchArm[] = [
  {
    source: 'matter',
    sql: `select id, name, client from matter
           where workspace_id = $1
             and (name ilike $2 escape '\\' or client ilike $2 escape '\\'
                  or reference ilike $2 escape '\\')
           order by name limit $3`,
    toHit: row => ({
      source: 'matter', id: text(row, 'id'), title: text(row, 'name'),
      ...maybe(row, 'client'), matterId: text(row, 'id'),
    }),
  },
  {
    source: 'document',
    sql: `select d.id as id, d.name as name, d.matter_id as matter_id, m.name as matter_name
            from document d
            join matter m on m.id = d.matter_id and m.workspace_id = d.workspace_id
           where d.workspace_id = $1 and d.kind = 'matter' and d.name ilike $2 escape '\\'
           order by d.name limit $3`,
    toHit: row => ({
      source: 'document', id: text(row, 'id'), title: text(row, 'name'),
      ...maybe(row, 'matter_name'), matterId: text(row, 'matter_id'),
    }),
  },
  {
    source: 'precedent',
    sql: `select d.id as id, d.name as name, p.name as set_name
            from document d
            join precedent_set p
              on p.id = d.precedent_set_id and p.workspace_id = d.workspace_id
           where d.workspace_id = $1 and d.kind = 'precedent' and d.name ilike $2 escape '\\'
           order by d.name limit $3`,
    toHit: row => ({
      source: 'precedent', id: text(row, 'id'), title: text(row, 'name'),
      ...maybe(row, 'set_name'),
    }),
  },
  {
    source: 'review',
    sql: `select r.id as id, r.playbook_snapshot ->> 'name' as name,
                 r.matter_id as matter_id, m.name as matter_name
            from review r
            join matter m on m.id = r.matter_id and m.workspace_id = r.workspace_id
           where r.workspace_id = $1
             and r.playbook_snapshot ->> 'name' ilike $2 escape '\\'
           order by r.started_at desc limit $3`,
    toHit: row => ({
      source: 'review', id: text(row, 'id'), title: text(row, 'name'),
      ...maybe(row, 'matter_name'), matterId: text(row, 'matter_id'),
    }),
  },
  {
    source: 'collection',
    sql: `select c.id as id, c.name as name, c.matter_id as matter_id, m.name as matter_name
            from collection c
            join matter m on m.id = c.matter_id and m.workspace_id = c.workspace_id
           where c.workspace_id = $1 and c.name ilike $2 escape '\\'
           order by c.name limit $3`,
    toHit: row => ({
      source: 'collection', id: text(row, 'id'), title: text(row, 'name'),
      ...maybe(row, 'matter_name'), matterId: text(row, 'matter_id'),
    }),
  },
  {
    source: 'playbook',
    sql: `select id, name from playbook
           where workspace_id = $1 and name ilike $2 escape '\\'
           order by name limit $3`,
    toHit: row => ({
      source: 'playbook', id: text(row, 'id'), title: text(row, 'name'),
    }),
  },
  {
    // THE CURRENT PUBLISHED VERSION, joined through `current_version_id`. A
    // draft is a playbook nobody has agreed to and is not searched.
    source: 'clause',
    sql: `select p.id as id, p.name as playbook_name,
                 c ->> 'id' as clause_id, c ->> 'title' as title
            from playbook p
            join playbook_version v
              on v.id = p.current_version_id and v.workspace_id = p.workspace_id
      cross join lateral jsonb_array_elements(coalesce(v.content -> 'clauses', '[]'::jsonb)) c
           where p.workspace_id = $1 and c ->> 'title' ilike $2 escape '\\'
           order by p.name limit $3`,
    toHit: row => ({
      source: 'clause', id: text(row, 'id'), title: text(row, 'title'),
      clauseId: text(row, 'clause_id'), ...maybe(row, 'playbook_name'),
    }),
  },
];

/**
 * Runs every arm concurrently and reports what happened to each.
 *
 * `arms` is a parameter so a test can inject one that throws. That is not a
 * convenience: P49's whole content is that a broken arm must not take the
 * other six with it, and the only honest way to prove it is to break one.
 *
 * Hits are ordered by SOURCE, in `SEARCH_ARMS` order, and never merged by
 * relevance. There is no relevance score here and inventing one would be a
 * ranking the reader cannot see the reasoning of; the palette groups by
 * source and labels each group, which is a shape a person can read.
 */
export async function runSearch(
  db: Db, workspaceId: string, query: string, limitPerSource: number,
  arms: SearchArm[] = SEARCH_ARMS,
): Promise<SearchResults> {
  const pattern = likePattern(query);
  const answers = await Promise.all(arms.map(async (arm): Promise<{
    hits: SearchHit[]; outcome: SearchSourceOutcome;
  }> => {
    try {
      const rows = await db.query<Record<string, unknown>>(
        arm.sql, [workspaceId, pattern, limitPerSource + 1]);
      const capped = rows.length > limitPerSource;
      const hits = rows.slice(0, limitPerSource).map(arm.toHit);
      return {
        hits,
        outcome: capped
          ? { source: arm.source, status: 'capped', count: hits.length, limit: limitPerSource }
          : { source: arm.source, status: 'ok', count: hits.length },
      };
    } catch {
      // A SENTENCE, NEVER A STACK, and never a rethrow. The six arms that
      // answered are not thrown away because one did not, and the reader is
      // told which one is missing rather than being handed a shorter list
      // that looks complete.
      return {
        hits: [],
        outcome: {
          source: arm.source,
          status: 'failed',
          count: 0,
          message: `${LABEL[arm.source]} could not be searched. `
            + 'Some results are missing from this list.',
        },
      };
    }
  }));

  return {
    query,
    hits: answers.flatMap(a => a.hits),
    // EVERY source, on EVERY answer, including a completely successful one.
    sources: answers.map(a => a.outcome),
  };
}

/** How each source is named in the sentence a failed arm carries. One home,
 *  so the server's message and the palette's heading cannot disagree about
 *  what was not searched. */
const LABEL: Record<SearchSource, string> = {
  matter: 'Matters',
  document: 'Documents',
  precedent: 'Precedents',
  review: 'Reviews',
  collection: 'Collections',
  playbook: 'Playbooks',
  clause: 'Clause titles',
};

export { LABEL as SEARCH_SOURCE_LABEL };
