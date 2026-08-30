import { findingsKeyFor, isCollectionTarget, type ReviewTarget } from '@lexprompt/core';
import type { Tx } from '../db/pool.ts';

/**
 * `review.findings` becomes rows — the largest data migration in the plan,
 * and the most dangerous change in this stage, because what is inside that
 * blob is a lawyer's recorded judgement.
 *
 * Four things this must never do, stated before the how, because every choice
 * below serves one of them:
 *
 *  1. **Never report success over a gap.** "A failed storage migration
 *     rendering an empty library, indistinguishable from a fresh install" is
 *     on CLAUDE.md's list; this is the same migration one level up with a
 *     verification inside it.
 *  2. **Never invent a human judgement, and never destroy one.** It carries
 *     across exactly what the blob literally held. It does not upgrade,
 *     downgrade, guess an actor, or default a reason.
 *  3. **Never leave a non-`unchecked` disposition with an empty history.** An
 *     empty history under a non-`unchecked` current state is
 *     indistinguishable from a change that failed to record itself (§6.4).
 *  4. **Never delete its source.** `review.findings` is untouched here and
 *     frozen — not dropped — in Task 22.
 *
 * ## The order, and why it is the order
 *
 * Census, refusals, shred, reconciliation, report. The census is written
 * before anything MOVES so the comparison at the end is against a record made
 * independently of the movement it checks; the refusals run before the shred
 * so an operator gets a list rather than one Postgres error naming the first
 * row it happened to reach; the reconciliation is BY KEY, never by count,
 * because a count check passes when two verifications swap places, which is
 * the one arithmetic that lands a rejection on the wrong clause.
 *
 * Everything happens inside the caller's transaction — `runMigrations` opens
 * exactly one — so every `throw` below rolls the whole thing back, and the
 * sentence "Nothing has been changed" in the refusal message is true.
 */

/**
 * Every (review, findings key, clause) cell in the database, flattened.
 *
 * `jsonb_each` raises "cannot deconstruct a scalar" on anything that is not
 * an object, which would abort the migration with a message naming no row at
 * all — so a malformed key is replaced with an empty object HERE and named by
 * `shapeRefusals` instead. The guard and the refusal are a pair: without the
 * refusal this CTE would silently drop a whole document's findings.
 */
const CELLS = `
  select r.id as review_id, r.workspace_id, k.key as findings_key, c.key as clause_id,
         c.value as finding
  from review r
  cross join lateral jsonb_each(r.findings) as k(key, value)
  cross join lateral jsonb_each(
    case when jsonb_typeof(k.value) = 'object' then k.value else '{}'::jsonb end
  ) as c(key, value)
`;

/** The instant a blob field holds, as a `timestamptz`. Epoch MILLISECONDS on
 *  the wire; a bare number handed to Postgres for a `timestamptz` is read as
 *  SECONDS, which is a fifty-year error nothing would flag. */
const AT = (expr: string) => `to_timestamp((${expr})::double precision / 1000)`;

/**
 * True only for a JSON `true`.
 *
 * Never a cast: `(finding->>'edited')::boolean` aborts the whole migration on
 * a string where a boolean was expected, with a message naming no row. A
 * non-boolean is named by `shapeRefusals` instead.
 *
 * `coalesce`, and it is load-bearing rather than defensive: comparing SQL NULL
 * (an ABSENT key) to anything yields NULL, not false, and the four columns
 * this feeds are NOT NULL. Without it every finding with no `authError` key —
 * which is almost all of them — fails the insert.
 */
const FLAG = (expr: string) => `coalesce((${expr}) = 'true'::jsonb, false)`;

interface ReviewShape {
  id: string;
  target: unknown;
  document_ids: unknown;
}

function parsed(value: unknown): unknown {
  return typeof value === 'string' ? JSON.parse(value) : value;
}

/**
 * Whether `key` is a findings key this review's target explains.
 *
 * Routed through `findingsKeyFor` rather than re-deciding the collection
 * branch here: it is the only place a findings key is derived, and a second
 * copy of that decision — in SQL, in a migration, where nobody would look for
 * it — is exactly the shape of the six defects sub-project C produced.
 */
function explainsKey(target: ReviewTarget, documentIds: string[], key: string): boolean {
  if (isCollectionTarget(target)) return findingsKeyFor(target) === key;
  const known = new Set([...(target.documentIds ?? []), ...documentIds]);
  return known.has(key) && findingsKeyFor(target, key) === key;
}

async function namedRows<R extends Record<string, unknown>>(
  t: Tx, sql: string, describe: (row: R) => string,
): Promise<string[]> {
  return (await t.query<R>(sql)).map(describe);
}

// ---------------------------------------------------------------------------
// 1. The census
// ---------------------------------------------------------------------------

/**
 * Every non-`unchecked` verification, every confirmed net position, every
 * note and every `assigneeId`, recorded by key BEFORE anything moves (P19).
 *
 * All four, written here rather than one written and three described: the
 * reconciliation at the end can only check what the census recorded.
 */
export async function censusFindings(t: Tx): Promise<number> {
  await t.query(`
    with cells as (${CELLS})
    insert into finding_migration_census (review_id, findings_key, clause_id, workspace_id, kind, detail)
    select review_id, findings_key, clause_id, workspace_id, 'verification',
           jsonb_build_object(
             'state',    finding->'verification'->>'state',
             'byUserId', finding->'verification'->>'byUserId',
             'at',       finding->'verification'->>'at',
             'reason',   finding->'verification'->>'reason')
    from cells
    where coalesce(finding->'verification'->>'state', 'unchecked') <> 'unchecked'
  `);
  await t.query(`
    with cells as (${CELLS})
    insert into finding_migration_census (review_id, findings_key, clause_id, workspace_id, kind, detail)
    select review_id, findings_key, clause_id, workspace_id, 'net_position',
           jsonb_build_object(
             'state',    finding->'netPosition'->>'state',
             'byUserId', finding->'netPosition'->>'byUserId',
             'at',       finding->'netPosition'->>'at',
             'amended',  finding->'netPosition'->>'amended')
    from cells
    where jsonb_typeof(finding->'netPosition') = 'object'
      and coalesce(finding->'netPosition'->>'state', 'unconfirmed') <> 'unconfirmed'
  `);
  await t.query(`
    with cells as (${CELLS})
    insert into finding_migration_census (review_id, findings_key, clause_id, workspace_id, kind, detail)
    select review_id, findings_key, clause_id, workspace_id, 'note',
           jsonb_build_object('notes', finding->'notes')
    from cells
    where jsonb_typeof(finding->'notes') = 'array'
      and jsonb_array_length(finding->'notes') > 0
  `);
  await t.query(`
    with cells as (${CELLS})
    insert into finding_migration_census (review_id, findings_key, clause_id, workspace_id, kind, detail)
    select review_id, findings_key, clause_id, workspace_id, 'assignee',
           jsonb_build_object('assigneeId', finding->'verification'->>'assigneeId')
    from cells
    where finding->'verification'->>'assigneeId' is not null
  `);
  const rows = await t.query<{ n: string }>('select count(*)::text n from finding_migration_census');
  return Number(rows[0].n);
}

// ---------------------------------------------------------------------------
// 2. The refusals
// ---------------------------------------------------------------------------

/** A blob that is not the shape the wire type promises. Named, never
 *  coerced: a `status` this migration "tidied" is a run state nobody chose. */
async function shapeRefusals(t: Tx): Promise<string[]> {
  const out: string[] = [];
  out.push(...await namedRows<{ review_id: string; findings_key: string; kind: string }>(t, `
    select r.id as review_id, k.key as findings_key, jsonb_typeof(k.value) as kind
    from review r cross join lateral jsonb_each(r.findings) as k(key, value)
    where jsonb_typeof(k.value) <> 'object'
  `, r => `${r.review_id}/${r.findings_key}: the findings under this key are a ${r.kind}, `
    + 'not an object of clause id to finding, so every finding under it would be lost'));

  out.push(...await namedRows<{ review_id: string; findings_key: string; clause_id: string; kind: string }>(t, `
    with cells as (${CELLS})
    select review_id, findings_key, clause_id, jsonb_typeof(finding) as kind
    from cells where jsonb_typeof(finding) <> 'object'
  `, r => `${r.review_id}/${r.findings_key}/${r.clause_id}: the finding is a ${r.kind}, not an object`));

  out.push(...await namedRows<{ review_id: string; findings_key: string; clause_id: string; status: string | null }>(t, `
    with cells as (${CELLS})
    select review_id, findings_key, clause_id, finding->>'status' as status
    from cells
    where jsonb_typeof(finding) = 'object'
      and coalesce(finding->>'status', '') not in ('pending','running','done','error','cancelled')
  `, r => `${r.review_id}/${r.findings_key}/${r.clause_id}: status ${JSON.stringify(r.status)} `
    + 'is not one of pending, running, done, error, cancelled'));

  out.push(...await namedRows<{ review_id: string; findings_key: string; clause_id: string; kind: string }>(t, `
    with cells as (${CELLS})
    select review_id, findings_key, clause_id, jsonb_typeof(finding->'citations') as kind
    from cells
    where finding ? 'citations' and jsonb_typeof(finding->'citations') <> 'array'
  `, r => `${r.review_id}/${r.findings_key}/${r.clause_id}: citations are a ${r.kind}, not an array`));

  out.push(...await namedRows<{ review_id: string; findings_key: string; clause_id: string; field: string; kind: string }>(t, `
    with cells as (${CELLS}),
    flags as (
      select review_id, findings_key, clause_id, f.field,
             jsonb_typeof(finding->f.field) as kind
      from cells,
           unnest(array['edited','authError','truncated','noContent']) as f(field)
      where finding ? f.field
    )
    select * from flags where kind <> 'boolean'
  `, r => `${r.review_id}/${r.findings_key}/${r.clause_id}: ${r.field} is a ${r.kind}, not a boolean`));

  out.push(...await namedRows<{ review_id: string; findings_key: string; clause_id: string; outcome: string }>(t, `
    with cells as (${CELLS})
    select review_id, findings_key, clause_id, finding->>'positionOutcome' as outcome
    from cells
    where finding ? 'positionOutcome'
      and coalesce(finding->>'positionOutcome', '') not in ('meets','deviates','unclear')
  `, r => `${r.review_id}/${r.findings_key}/${r.clause_id}: positionOutcome `
    + `${JSON.stringify(r.outcome)} is not meets, deviates or unclear`));

  out.push(...await namedRows<{ review_id: string; findings_key: string; clause_id: string; level: string }>(t, `
    with cells as (${CELLS})
    select review_id, findings_key, clause_id, finding->>'riskLevel' as level
    from cells
    where finding ? 'riskLevel'
      and coalesce(finding->>'riskLevel', '') not in ('High','Medium','Low','Info')
  `, r => `${r.review_id}/${r.findings_key}/${r.clause_id}: riskLevel `
    + `${JSON.stringify(r.level)} is not High, Medium, Low or Info`));

  return out;
}

/**
 * A human judgement whose author cannot be resolved.
 *
 * NOT attributed to the operator, NOT downgraded to unchecked, NOT skipped.
 * §6.4 seeds the first history event from the verification's own
 * `byUserId`/`at`, and an event needs a real `app_user` — so the alternative
 * to refusing is the deploy operator's name on a lawyer's judgement, which is
 * the single worst outcome available anywhere in this stage.
 *
 * The same rule covers `at`: a verified finding with no instant cannot get
 * one from `now()`, because `now()` is when the migration ran.
 */
async function authorRefusals(t: Tx): Promise<string[]> {
  const out: string[] = [];
  out.push(...await namedRows<{ review_id: string; findings_key: string; clause_id: string; kind: string; by_user_id: string | null }>(t, `
    select c.review_id, c.findings_key, c.clause_id, c.kind, c.detail->>'byUserId' as by_user_id
    from finding_migration_census c
    left join app_user u on u.id::text = c.detail->>'byUserId'
    where c.kind in ('verification','net_position')
      and (c.detail->>'byUserId' is null or btrim(c.detail->>'byUserId') = '' or u.id is null)
  `, r => `${r.review_id}/${r.findings_key}/${r.clause_id}: the ${r.kind}'s byUserId `
    + `${JSON.stringify(r.by_user_id)} resolves to no app_user`));

  out.push(...await namedRows<{ review_id: string; findings_key: string; clause_id: string; note_id: string; by_user_id: string | null }>(t, `
    select c.review_id, c.findings_key, c.clause_id,
           n.value->>'id' as note_id, n.value->>'byUserId' as by_user_id
    from finding_migration_census c
    cross join lateral jsonb_array_elements(c.detail->'notes') as n(value)
    left join app_user u on u.id::text = n.value->>'byUserId'
    where c.kind = 'note'
      and (n.value->>'byUserId' is null or btrim(n.value->>'byUserId') = '' or u.id is null)
  `, r => `${r.review_id}/${r.findings_key}/${r.clause_id}: note ${JSON.stringify(r.note_id)} `
    + `has byUserId ${JSON.stringify(r.by_user_id)}, which resolves to no app_user`));

  out.push(...await namedRows<{ review_id: string; findings_key: string; clause_id: string; kind: string; at: string | null }>(t, `
    select review_id, findings_key, clause_id, kind, detail->>'at' as at
    from finding_migration_census
    where kind in ('verification','net_position')
      and (detail->>'at' is null or detail->>'at' !~ '^[0-9]+$')
  `, r => `${r.review_id}/${r.findings_key}/${r.clause_id}: the ${r.kind} has at `
    + `${JSON.stringify(r.at)}, which is not an epoch-millisecond timestamp — this migration `
    + 'does not stamp a human judgement with the moment it ran'));

  out.push(...await namedRows<{ review_id: string; findings_key: string; clause_id: string; note_id: string; at: string | null }>(t, `
    select c.review_id, c.findings_key, c.clause_id,
           n.value->>'id' as note_id, n.value->>'at' as at
    from finding_migration_census c
    cross join lateral jsonb_array_elements(c.detail->'notes') as n(value)
    where c.kind = 'note' and (n.value->>'at' is null or n.value->>'at' !~ '^[0-9]+$')
  `, r => `${r.review_id}/${r.findings_key}/${r.clause_id}: note ${JSON.stringify(r.note_id)} `
    + `has at ${JSON.stringify(r.at)}, which is not an epoch-millisecond timestamp`));

  return out;
}

/** A rejection with no reason. The check constraint would refuse it anyway;
 *  refusing here means the operator gets a list rather than one Postgres
 *  error naming the first row it happened to reach. */
async function reasonRefusals(t: Tx): Promise<string[]> {
  return namedRows<{ review_id: string; findings_key: string; clause_id: string }>(t, `
    select review_id, findings_key, clause_id
    from finding_migration_census
    where kind = 'verification' and detail->>'state' = 'rejected'
      and btrim(coalesce(detail->>'reason', '')) = ''
  `, r => `${r.review_id}/${r.findings_key}/${r.clause_id}: this finding is REJECTED with no `
    + 'reason. A rejection with no reason is a silent disagreement, useless to whoever reads '
    + 'the export, and this migration will not invent one');
}

/** A note whose id is empty, duplicated, or whose text is blank — each of
 *  which the `note` table refuses, and each of which is better named here. */
async function noteShapeRefusals(t: Tx): Promise<string[]> {
  const out: string[] = [];
  out.push(...await namedRows<{ review_id: string; findings_key: string; clause_id: string; note_id: string | null }>(t, `
    select c.review_id, c.findings_key, c.clause_id, n.value->>'id' as note_id
    from finding_migration_census c
    cross join lateral jsonb_array_elements(c.detail->'notes') as n(value)
    where c.kind = 'note'
      and (btrim(coalesce(n.value->>'id', '')) = '' or btrim(coalesce(n.value->>'text', '')) = '')
  `, r => `${r.review_id}/${r.findings_key}/${r.clause_id}: note ${JSON.stringify(r.note_id)} `
    + 'has no id or no text'));

  out.push(...await namedRows<{ note_id: string; n: string }>(t, `
    select n.value->>'id' as note_id, count(*)::text as n
    from finding_migration_census c
    cross join lateral jsonb_array_elements(c.detail->'notes') as n(value)
    where c.kind = 'note'
    group by 1 having count(*) > 1
  `, r => `note id ${JSON.stringify(r.note_id)} appears ${r.n} times across the database, and a `
    + 'note id is a primary key'));

  return out;
}

/**
 * A note whose `findingId` disagrees with the position it occupies.
 *
 * `Note.findingId` is `${documentId}::${clauseId}` (`findingKey`, in core). It
 * does NOT match the new `(review_id, findings_key, clause_id)` key — on a
 * collection review the note carries a DOCUMENT id where the finding is keyed
 * by the collection — so the migration re-keys each note from where it sits
 * in the blob rather than by parsing that string. It parses it anyway, as a
 * CHECK: a note whose own record of which clause it is about disagrees with
 * the clause it is filed under is a note that would be shown against the
 * wrong clause, and there is no way to tell from here which half is right.
 */
async function noteKeyRefusals(t: Tx): Promise<string[]> {
  const out: string[] = [];
  out.push(...await namedRows<{ review_id: string; findings_key: string; clause_id: string; note_id: string; finding_id: string | null }>(t, `
    select c.review_id, c.findings_key, c.clause_id,
           n.value->>'id' as note_id, n.value->>'findingId' as finding_id
    from finding_migration_census c
    cross join lateral jsonb_array_elements(c.detail->'notes') as n(value)
    where c.kind = 'note'
      and (n.value->>'findingId' is null or position('::' in n.value->>'findingId') = 0)
  `, r => `${r.review_id}/${r.findings_key}/${r.clause_id}: note ${JSON.stringify(r.note_id)} has `
    + `findingId ${JSON.stringify(r.finding_id)}, which is not a "documentId::clauseId" key`));

  out.push(...await namedRows<{ review_id: string; findings_key: string; clause_id: string; note_id: string; parsed_clause: string }>(t, `
    select c.review_id, c.findings_key, c.clause_id, n.value->>'id' as note_id,
           substring(n.value->>'findingId' from position('::' in n.value->>'findingId') + 2)
             as parsed_clause
    from finding_migration_census c
    cross join lateral jsonb_array_elements(c.detail->'notes') as n(value)
    where c.kind = 'note'
      and position('::' in coalesce(n.value->>'findingId', '')) > 0
      and substring(n.value->>'findingId' from position('::' in n.value->>'findingId') + 2)
          <> c.clause_id
  `, r => `${r.review_id}/${r.findings_key}/${r.clause_id}: note ${JSON.stringify(r.note_id)} says `
    + `it is about clause ${JSON.stringify(r.parsed_clause)} but is stored under `
    + `${JSON.stringify(r.clause_id)} — one of the two is wrong and this migration cannot tell which`));

  // The document half. On a document review the parsed id must BE the
  // findings key; on a collection review it must be one of the collection's
  // documents, because that is what the browser passed to `makeNote`.
  out.push(...await namedRows<{ review_id: string; findings_key: string; clause_id: string; note_id: string; parsed_document: string }>(t, `
    select c.review_id, c.findings_key, c.clause_id, n.value->>'id' as note_id,
           split_part(n.value->>'findingId', '::', 1) as parsed_document
    from finding_migration_census c
    join review r on r.id = c.review_id
    cross join lateral jsonb_array_elements(c.detail->'notes') as n(value)
    where c.kind = 'note'
      and position('::' in coalesce(n.value->>'findingId', '')) > 0
      and split_part(n.value->>'findingId', '::', 1) <> c.findings_key
      and not exists (
        select 1 from jsonb_array_elements_text(coalesce(r.target->'documentIds', '[]'::jsonb)) d
        where d = split_part(n.value->>'findingId', '::', 1))
  `, r => `${r.review_id}/${r.findings_key}/${r.clause_id}: note ${JSON.stringify(r.note_id)} names `
    + `document ${JSON.stringify(r.parsed_document)}, which is neither the key it is stored under `
    + 'nor a document this review covers'));

  return out;
}

/**
 * A findings key no target explains.
 *
 * The stored key is used EXACTLY as stored — never re-derived, never
 * "corrected". If it disagrees with what `findingsKeyFor` would produce, that
 * is a fact about the data, and a migration that rewrote it would move a
 * finding to a key its own review does not name.
 */
async function keyRefusals(t: Tx): Promise<string[]> {
  const reviews = await t.query<ReviewShape>('select id, target, document_ids from review');
  const byId = new Map(reviews.map(r => [r.id, r]));
  const keys = await t.query<{ review_id: string; findings_key: string }>(
    `select distinct r.id as review_id, k.key as findings_key
     from review r cross join lateral jsonb_each(r.findings) as k(key, value)`);
  const out: string[] = [];
  for (const { review_id, findings_key } of keys) {
    const review = byId.get(review_id);
    if (!review) continue;
    const target = parsed(review.target) as ReviewTarget | null;
    const documentIds = (parsed(review.document_ids) ?? []) as string[];
    if (!target || (target.kind !== 'documents' && target.kind !== 'collection')) {
      out.push(`${review_id}: the review's target is not a documents or collection target, so `
        + `nothing explains its findings key ${JSON.stringify(findings_key)}`);
      continue;
    }
    if (!explainsKey(target, documentIds, findings_key)) {
      out.push(`${review_id}/${findings_key}: no document or collection this review covers `
        + 'explains this findings key. A collection review keys by the COLLECTION id and a '
        + 'document review by the document id; this migration will not guess which was meant');
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 3. The shred
// ---------------------------------------------------------------------------

/**
 * One `insert ... select` per table, from the blob to the rows.
 *
 * The outer key is the `findings_key` EXACTLY as stored. `status` maps 1:1 —
 * a `pending` or `running` finding in a stored review is a run that was
 * abandoned mid-flight, it migrates as `pending`/`running`, and Task 11's
 * reaper is what resolves it. Tidying it to `error` here would be this
 * migration deciding what happened to somebody's run.
 */
export async function shredFindings(t: Tx): Promise<number> {
  await t.query(`
    with cells as (${CELLS})
    insert into finding (review_id, findings_key, clause_id, workspace_id, status, summary,
                         risk_level, risk_analysis, error, auth_error, truncated,
                         truncated_documents, no_content, edited, position_outcome,
                         position_rationale, citations, net_position)
    select review_id, findings_key, clause_id, workspace_id,
           finding->>'status',
           finding->>'summary',
           finding->>'riskLevel',
           finding->>'riskAnalysis',
           finding->>'error',
           ${FLAG("finding->'authError'")},
           ${FLAG("finding->'truncated'")},
           -- NULL, never '{}', on a single-document finding. A PRESENT but
           -- empty array also lands as NULL (array_agg over no rows is NULL),
           -- and that normalisation is named in the report rather than
           -- performed silently.
           case when jsonb_typeof(finding->'truncatedDocuments') = 'array'
                then (select array_agg(x)
                      from jsonb_array_elements_text(finding->'truncatedDocuments') x)
                else null end,
           ${FLAG("finding->'noContent'")},
           ${FLAG("finding->'edited'")},
           finding->>'positionOutcome',
           finding->>'positionRationale',
           case when jsonb_typeof(finding->'citations') = 'array'
                then finding->'citations' else '[]'::jsonb end,
           -- Both spellings of "there is none": an absent key and a JSON
           -- null. Both exist in real data, and a JSON null is an object to
           -- nobody but jsonb_typeof.
           case when jsonb_typeof(finding->'netPosition') = 'object'
                then finding->'netPosition' else null end
    from cells
  `);

  // Every finding gets a disposition row. An `unchecked` one gets
  // `changed_count = 0`, no actor, no instant and NO event: nobody has
  // touched it, there is nothing to attribute, and §6.3 says such a finding
  // renders as "Not checked" and names nobody.
  await t.query(`
    with cells as (${CELLS})
    insert into finding_disposition (review_id, findings_key, clause_id, workspace_id, state,
                                     reason, by_user_id, at, changed_count)
    select review_id, findings_key, clause_id, workspace_id,
           coalesce(finding->'verification'->>'state', 'unchecked'),
           case when finding->'verification'->>'state' = 'rejected'
                then finding->'verification'->>'reason' else null end,
           case when coalesce(finding->'verification'->>'state', 'unchecked') <> 'unchecked'
                then (finding->'verification'->>'byUserId')::uuid else null end,
           case when coalesce(finding->'verification'->>'state', 'unchecked') <> 'unchecked'
                then ${AT("finding->'verification'->>'at'")} else null end,
           case when coalesce(finding->'verification'->>'state', 'unchecked') <> 'unchecked'
                then 1 else 0 end
    from cells
  `);

  // §6.4: exactly one seed event per migrated non-`unchecked` disposition,
  // carrying the verification's OWN author and instant — never the operator's
  // and never `now()`.
  await t.query(`
    with cells as (${CELLS})
    insert into finding_disposition_event (review_id, findings_key, clause_id, workspace_id,
                                           from_state, to_state, reason, cause, by_user_id, at)
    select review_id, findings_key, clause_id, workspace_id,
           'unchecked',
           finding->'verification'->>'state',
           case when finding->'verification'->>'state' = 'rejected'
                then finding->'verification'->>'reason' else null end,
           'human',
           (finding->'verification'->>'byUserId')::uuid,
           ${AT("finding->'verification'->>'at'")}
    from cells
    where coalesce(finding->'verification'->>'state', 'unchecked') <> 'unchecked'
  `);

  await t.query(`
    with cells as (${CELLS})
    insert into note (id, review_id, findings_key, clause_id, workspace_id, text, by_user_id, at)
    select n.value->>'id', review_id, findings_key, clause_id, workspace_id,
           n.value->>'text', (n.value->>'byUserId')::uuid, ${AT("n.value->>'at'")}
    from cells
    cross join lateral jsonb_array_elements(
      case when jsonb_typeof(finding->'notes') = 'array' then finding->'notes' else '[]'::jsonb end
    ) as n(value)
  `);

  const rows = await t.query<{ n: string }>('select count(*)::text n from finding');
  return Number(rows[0].n);
}

// ---------------------------------------------------------------------------
// 4. The reconciliation, BY KEY
// ---------------------------------------------------------------------------

/**
 * Every censused judgement, checked against the rows AT THE SAME KEY, with
 * the same state, the same actor and the same instant.
 *
 * A count-only check passes when two verifications SWAP PLACES, which is
 * precisely the arithmetic that would land a rejection on the wrong clause —
 * so this is a full outer join on the three key columns, and every row where
 * either side is missing or any compared field differs is a discrepancy.
 *
 * Exported so a test can prove it FINDS something. A reconciliation that has
 * only ever been observed returning `[]` is a reconciliation that returns
 * `[]`; this project has shipped a scanner that matched nothing.
 */
export async function reconcileCensus(t: Tx): Promise<string[]> {
  const out: string[] = [];

  out.push(...await namedRows<{
    review_id: string | null; findings_key: string | null; clause_id: string | null;
    detail: string; actual: string;
  }>(t, `
    with expected as (
      select review_id, findings_key, clause_id,
             detail->>'state' as state,
             detail->>'byUserId' as by_user_id,
             detail->>'at' as at_ms
      from finding_migration_census where kind = 'verification'),
    actual as (
      select review_id, findings_key, clause_id, state,
             by_user_id::text as by_user_id,
             (extract(epoch from at) * 1000)::bigint::text as at_ms
      from finding_disposition where state <> 'unchecked')
    select coalesce(e.review_id, a.review_id) as review_id,
           coalesce(e.findings_key, a.findings_key) as findings_key,
           coalesce(e.clause_id, a.clause_id) as clause_id,
           coalesce(concat_ws(' ', e.state, e.by_user_id, e.at_ms), '(nothing)') as detail,
           coalesce(concat_ws(' ', a.state, a.by_user_id, a.at_ms), '(nothing)') as actual
    from expected e
    full outer join actual a
      on a.review_id = e.review_id and a.findings_key = e.findings_key
     and a.clause_id = e.clause_id
    where e.review_id is null or a.review_id is null
       or e.state is distinct from a.state
       or e.by_user_id is distinct from a.by_user_id
       or e.at_ms is distinct from a.at_ms
  `, r => `${r.review_id}/${r.findings_key}/${r.clause_id}: the census recorded a verification of `
    + `"${r.detail}" and the rows hold "${r.actual}"`));

  out.push(...await namedRows<{
    review_id: string | null; findings_key: string | null; clause_id: string | null;
    detail: string; actual: string;
  }>(t, `
    with expected as (
      select review_id, findings_key, clause_id,
             detail->>'state' as state, detail->>'byUserId' as by_user_id,
             detail->>'at' as at_ms
      from finding_migration_census where kind = 'net_position'),
    actual as (
      select review_id, findings_key, clause_id,
             net_position->>'state' as state, net_position->>'byUserId' as by_user_id,
             net_position->>'at' as at_ms
      from finding
      where jsonb_typeof(net_position) = 'object'
        and coalesce(net_position->>'state', 'unconfirmed') <> 'unconfirmed')
    select coalesce(e.review_id, a.review_id) as review_id,
           coalesce(e.findings_key, a.findings_key) as findings_key,
           coalesce(e.clause_id, a.clause_id) as clause_id,
           coalesce(concat_ws(' ', e.state, e.by_user_id, e.at_ms), '(nothing)') as detail,
           coalesce(concat_ws(' ', a.state, a.by_user_id, a.at_ms), '(nothing)') as actual
    from expected e
    full outer join actual a
      on a.review_id = e.review_id and a.findings_key = e.findings_key
     and a.clause_id = e.clause_id
    where e.review_id is null or a.review_id is null
       or e.state is distinct from a.state
       or e.by_user_id is distinct from a.by_user_id
       or e.at_ms is distinct from a.at_ms
  `, r => `${r.review_id}/${r.findings_key}/${r.clause_id}: the census recorded a confirmed net `
    + `position of "${r.detail}" and the rows hold "${r.actual}"`));

  out.push(...await namedRows<{
    review_id: string | null; findings_key: string | null; clause_id: string | null;
    note_id: string | null; side: string;
  }>(t, `
    with expected as (
      select c.review_id, c.findings_key, c.clause_id, n.value->>'id' as note_id
      from finding_migration_census c
      cross join lateral jsonb_array_elements(c.detail->'notes') as n(value)
      where c.kind = 'note'),
    actual as (select review_id, findings_key, clause_id, id as note_id from note)
    select coalesce(e.review_id, a.review_id) as review_id,
           coalesce(e.findings_key, a.findings_key) as findings_key,
           coalesce(e.clause_id, a.clause_id) as clause_id,
           coalesce(e.note_id, a.note_id) as note_id,
           case when e.note_id is null then 'is in the rows but was never censused'
                else 'was censused but is not in the rows' end as side
    from expected e
    full outer join actual a
      on a.review_id = e.review_id and a.findings_key = e.findings_key
     and a.clause_id = e.clause_id and a.note_id = e.note_id
    where e.note_id is null or a.note_id is null
  `, r => `${r.review_id}/${r.findings_key}/${r.clause_id}: note `
    + `${JSON.stringify(r.note_id)} ${r.side}`));

  // The findings themselves. Not a judgement, but a finding that did not
  // land is a clause a reader would see as never reviewed.
  out.push(...await namedRows<{ review_id: string; findings_key: string; clause_id: string }>(t, `
    with cells as (${CELLS})
    select c.review_id, c.findings_key, c.clause_id
    from cells c
    left join finding f
      on f.review_id = c.review_id and f.findings_key = c.findings_key
     and f.clause_id = c.clause_id
    where f.review_id is null
  `, r => `${r.review_id}/${r.findings_key}/${r.clause_id}: this finding is in the blob and did `
    + 'not land as a row'));

  return out;
}

// ---------------------------------------------------------------------------
// 5. What could not be stored, named
// ---------------------------------------------------------------------------

async function discarded(t: Tx): Promise<{ what: string; where: string; value: string }[]> {
  const assignees = await t.query<{ review_id: string; findings_key: string; clause_id: string; assignee: string }>(`
    select review_id, findings_key, clause_id, detail->>'assigneeId' as assignee
    from finding_migration_census where kind = 'assignee'`);
  const emptyTruncated = await t.query<{ review_id: string; findings_key: string; clause_id: string }>(`
    with cells as (${CELLS})
    select review_id, findings_key, clause_id from cells
    where jsonb_typeof(finding->'truncatedDocuments') = 'array'
      and jsonb_array_length(finding->'truncatedDocuments') = 0`);
  return [
    ...assignees.map(r => ({
      what: 'assigneeId',
      where: `${r.review_id}/${r.findings_key}/${r.clause_id}`,
      value: r.assignee,
    })),
    ...emptyTruncated.map(r => ({
      what: 'an empty truncatedDocuments array',
      where: `${r.review_id}/${r.findings_key}/${r.clause_id}`,
      value: '[]',
    })),
  ];
}

// ---------------------------------------------------------------------------
// The migration step itself
// ---------------------------------------------------------------------------

function refuse(refusals: string[]): never {
  throw new Error(
    `The findings migration has NOT been applied. ${refusals.length} human-authored records `
    + 'could not be moved without guessing who made them, and this migration does not guess.\n\n'
    + refusals.join('\n')
    + '\n\nNothing has been changed. review.findings is untouched. Fix the rows above '
    + '(or map the missing users) and run the migration again.');
}

/** Throws with the whole list when the rows and the census disagree. Split
 *  from `reconcileCensus` so a test can read the list without the throw, and
 *  so the throw is one line somebody can find. */
export async function assertReconciled(t: Tx): Promise<string[]> {
  const discrepancies = await reconcileCensus(t);
  if (discrepancies.length > 0) {
    throw new Error(
      `The findings migration has NOT been applied. It found ${discrepancies.length} `
      + 'discrepancies between what it recorded before moving anything and what actually '
      + 'landed in the rows. Every one of these is a human judgement that is not where the '
      + 'census says it should be.\n\n'
      + discrepancies.join('\n')
      + '\n\nNothing has been changed. review.findings is untouched.');
  }
  return discrepancies;
}

/**
 * The whole migration step, in the caller's transaction.
 *
 * Registered for `007_findings_backfill` in `db/migrationSteps.ts` and run by
 * `runMigrations` after that file's SQL and before its ledger row — so a
 * throw here rolls back the tables the SQL created as well as everything
 * below, and the sentence "Nothing has been changed" is true.
 */
export async function backfillFindings(t: Tx): Promise<void> {
  const censused = await censusFindings(t);

  const refusals = [
    ...await shapeRefusals(t),
    ...await keyRefusals(t),
    ...await authorRefusals(t),
    ...await reasonRefusals(t),
    ...await noteShapeRefusals(t),
    ...await noteKeyRefusals(t),
  ];
  if (refusals.length > 0) refuse(refusals);

  const landed = await shredFindings(t);
  const discrepancies = await assertReconciled(t);
  const lost = await discarded(t);

  const summary = [
    `Migrated ${landed} findings; ${censused} human-authored records censused; `
    + `${discrepancies.length} discrepancies.`,
    ...(lost.length === 0 ? [] : [
      `${lost.length} value(s) could not be stored and are named rather than dropped:`,
      ...lost.map(l => `  ${l.where}: ${l.what} ${JSON.stringify(l.value)}`),
    ]),
  ].join('\n');

  await t.query(
    `insert into finding_migration_report (censused, landed, discrepancies, discarded, summary)
     values ($1, $2, $3::jsonb, $4::jsonb, $5)`,
    [censused, landed, JSON.stringify(discrepancies), JSON.stringify(lost), summary]);
}
