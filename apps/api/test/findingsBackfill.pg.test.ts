import { describe, it, expect } from 'vitest';
import { migratorDb, withPg } from './helpers/pgHarness.ts';
import type { Tx } from '../src/db/pool.ts';
import {
  assertReconciled, backfillFindings, censusFindings, reconcileCensus, shredFindings,
} from '../src/findings/backfill.ts';

/**
 * The findings backfill, against real Postgres, over data shaped like real
 * data.
 *
 * Every test here asks one of two questions. Did a specific human judgement
 * land on the specific key it was recorded under? And does the migration
 * REFUSE, loudly and completely, rather than guess — leaving the blob
 * untouched when it does?
 *
 * The tests call `backfillFindings` directly rather than `runMigrations`,
 * because the harness database has already had 007 applied and the ledger
 * makes a second run a no-op. It is the same function `runMigrations` calls,
 * reached through the one line in `migrationSteps.ts`; the whole path,
 * including the rollback of the migration's own tables, is exercised against
 * a scratch database in the task report.
 */

const WS = '00000000-0000-0000-0000-000000000001';

async function aUser(t: Tx, name: string): Promise<string> {
  const rows = await t.query<{ id: string }>(
    `insert into app_user (id, workspace_id, issuer, subject, display_name, initials, role, status)
     values (gen_random_uuid(), $1, 'i', 's-' || gen_random_uuid()::text, $2, 'AB', 'reviewer', 'active')
     returning id`, [WS, name]);
  return rows[0].id;
}

async function aReview(
  t: Tx,
  id: string,
  target: unknown,
  documentIds: string[],
  findings: unknown,
): Promise<void> {
  await t.query(
    `insert into matter (id, workspace_id, name, created_at, updated_at)
     values ('bm1', $1, 'Brookvale', now(), now()) on conflict (id) do nothing`, [WS]);
  await t.query(
    `insert into review (id, workspace_id, matter_id, playbook_snapshot, document_ids, target,
                         findings, model_id, started_at)
     values ($1, $2, 'bm1', '{}'::jsonb, $3::jsonb, $4::jsonb, $5::jsonb, 'test/model', now())`,
    [id, WS, JSON.stringify(documentIds), JSON.stringify(target), JSON.stringify(findings)]);
}

const documents = (ids: string[]) => ({ kind: 'documents', documentIds: ids });
const collection = (id: string, ids: string[]) =>
  ({ kind: 'collection', collectionId: id, documentIds: ids });

const finding = (over: Record<string, unknown> = {}) => ({
  clauseId: 'c1',
  status: 'done',
  summary: 'The break notice period is six months.',
  citations: [{ quote: 'six months', documentId: 'd1', page: 4 }],
  verification: { state: 'unchecked' },
  notes: [],
  ...over,
});

interface Disposition {
  state: string; reason: string | null; by_user_id: string | null; at: Date | null;
  changed_count: number;
}

const dispositionAt = (t: Tx, review: string, key: string, clause: string) =>
  t.query<Disposition>(
    `select state, reason, by_user_id::text as by_user_id, at, changed_count
     from finding_disposition where review_id = $1 and findings_key = $2 and clause_id = $3`,
    [review, key, clause]);

describe('every human judgement lands on the key it was recorded under', () => {
  it('lands a verification with the same actor and the same instant, on the right clause', async () => {
    await withPg(async t => {
      const partner = await aUser(t, 'Partner');
      const trainee = await aUser(t, 'Trainee');
      await aReview(t, 'br1', documents(['d1', 'd2']), ['d1', 'd2'], {
        d1: {
          c1: finding({ verification: { state: 'verified', byUserId: partner, at: 1_700_000_001_000 } }),
          c2: finding({ clauseId: 'c2', verification: { state: 'flagged', byUserId: trainee, at: 1_700_000_002_000 } }),
        },
        d2: {
          c1: finding(),
          c2: finding({ clauseId: 'c2', verification: { state: 'verified', byUserId: trainee, at: 1_700_000_003_000 } }),
        },
      });
      await backfillFindings(t);

      const d1c1 = (await dispositionAt(t, 'br1', 'd1', 'c1'))[0];
      expect(d1c1.state).toBe('verified');
      expect(d1c1.by_user_id).toBe(partner);
      expect(d1c1.at?.getTime()).toBe(1_700_000_001_000);
      expect(d1c1.changed_count).toBe(1);

      // The one that a count check cannot see: the OTHER clause, and the
      // other document, hold their own judgements and not this one.
      expect((await dispositionAt(t, 'br1', 'd1', 'c2'))[0])
        .toMatchObject({ state: 'flagged', by_user_id: trainee });
      expect((await dispositionAt(t, 'br1', 'd2', 'c1'))[0])
        .toMatchObject({ state: 'unchecked', by_user_id: null, at: null, changed_count: 0 });
      expect((await dispositionAt(t, 'br1', 'd2', 'c2'))[0])
        .toMatchObject({ state: 'verified', by_user_id: trainee });
      expect((await dispositionAt(t, 'br1', 'd2', 'c2'))[0].at?.getTime())
        .toBe(1_700_000_003_000);
    }, migratorDb());
  });

  it('carries a rejection s reason onto the clause it was written about', async () => {
    await withPg(async t => {
      const partner = await aUser(t, 'Partner');
      await aReview(t, 'br1', documents(['d1']), ['d1'], {
        d1: {
          c1: finding({ verification: {
            state: 'rejected', byUserId: partner, at: 1_700_000_004_000,
            reason: 'The cap is in the sixth schedule, not clause 14.',
          } }),
          c2: finding({ clauseId: 'c2' }),
        },
      });
      await backfillFindings(t);
      const rejected = (await dispositionAt(t, 'br1', 'd1', 'c1'))[0];
      expect(rejected.state).toBe('rejected');
      expect(rejected.reason).toBe('The cap is in the sixth schedule, not clause 14.');
      // …and it is not smeared onto the clause beside it.
      expect((await dispositionAt(t, 'br1', 'd1', 'c2'))[0].reason).toBeNull();
      const events = await t.query<{ reason: string | null; to_state: string; cause: string }>(
        "select reason, to_state, cause from finding_disposition_event where clause_id = 'c1'");
      expect(events).toEqual([{
        reason: 'The cap is in the sixth schedule, not clause 14.',
        to_state: 'rejected', cause: 'human',
      }]);
    }, migratorDb());
  });

  it('seeds exactly one history event per migrated verification, and none for an unchecked one', async () => {
    // §6.4: an empty history under a non-`unchecked` current state would be
    // indistinguishable from a change that failed to record itself.
    await withPg(async t => {
      const partner = await aUser(t, 'Partner');
      await aReview(t, 'br1', documents(['d1']), ['d1'], {
        d1: {
          c1: finding({ verification: { state: 'verified', byUserId: partner, at: 1_700_000_005_000 } }),
          c2: finding({ clauseId: 'c2' }),
        },
      });
      await backfillFindings(t);
      const count = async (clause: string) => Number((await t.query<{ n: string }>(
        'select count(*)::text n from finding_disposition_event where clause_id = $1',
        [clause]))[0].n);
      expect(await count('c1')).toBe(1);
      expect(await count('c2')).toBe(0);
      expect((await dispositionAt(t, 'br1', 'd1', 'c2'))[0])
        .toMatchObject({ changed_count: 0, by_user_id: null, at: null });
      const seed = await t.query<{ from_state: string; to_state: string; by_user_id: string; at: Date }>(
        `select from_state, to_state, by_user_id::text as by_user_id, at
         from finding_disposition_event where clause_id = 'c1'`);
      expect(seed[0].from_state).toBe('unchecked');
      expect(seed[0].to_state).toBe('verified');
      // The verification's OWN author and instant, not the operator's and
      // not now().
      expect(seed[0].by_user_id).toBe(partner);
      expect(seed[0].at.getTime()).toBe(1_700_000_005_000);
    }, migratorDb());
  });

  it('carries a note onto the finding it is filed under, re-keyed from its position', async () => {
    // `Note.findingId` is `documentId::clauseId`, which on a COLLECTION
    // review names a document while the finding is keyed by the collection.
    // The migration re-keys from where the note sits, and checks the string.
    await withPg(async t => {
      const partner = await aUser(t, 'Partner');
      await aReview(t, 'br1', collection('coll-1', ['d1', 'd2']), ['d1', 'd2'], {
        'coll-1': {
          c1: finding({ notes: [
            { id: 'n1', findingId: 'd1::c1', text: 'Checked against the deed.',
              byUserId: partner, at: 1_700_000_006_000 },
            { id: 'n2', findingId: 'd2::c1', text: 'And the variation.',
              byUserId: partner, at: 1_700_000_007_000 },
          ] }),
          c2: finding({ clauseId: 'c2' }),
        },
      });
      await backfillFindings(t);
      const notes = await t.query<{ id: string; findings_key: string; clause_id: string; text: string; at: Date }>(
        `select id, findings_key, clause_id, text, at from note where review_id = 'br1'
         order by id`);
      expect(notes.map(n => [n.id, n.findings_key, n.clause_id])).toEqual([
        ['n1', 'coll-1', 'c1'],
        ['n2', 'coll-1', 'c1'],
      ]);
      expect(notes[0].text).toBe('Checked against the deed.');
      expect(notes[0].at.getTime()).toBe(1_700_000_006_000);
      expect(await t.query("select 1 from note where clause_id = 'c2'")).toEqual([]);
    }, migratorDb());
  });

  it('carries a CONFIRMED net position, with the person who confirmed it', async () => {
    await withPg(async t => {
      const partner = await aUser(t, 'Partner');
      const netPosition = {
        proposed: 'The tenant has a rolling break on six months notice.',
        amended: 'The tenant has a rolling break on six months written notice.',
        state: 'confirmed',
        byUserId: partner,
        at: 1_700_000_008_000,
        trail: [{ documentId: 'd1', kind: 'original', effect: 'Grants the break.', citations: [] }],
      };
      await aReview(t, 'br1', collection('coll-1', ['d1']), ['d1'], {
        'coll-1': {
          c1: finding({ netPosition }),
          // Both spellings of "there is none": an absent key, and a JSON
          // null. Both exist in real data.
          c2: finding({ clauseId: 'c2' }),
          c3: finding({ clauseId: 'c3', netPosition: null }),
        },
      });
      await backfillFindings(t);
      const rows = await t.query<{ clause_id: string; net_position: unknown }>(
        `select clause_id, net_position from finding where review_id = 'br1'
         order by clause_id`);
      expect(rows[0].net_position).toEqual(netPosition);
      expect(rows[1].net_position).toBeNull();
      expect(rows[2].net_position).toBeNull();
      // …and the census recorded it, so the reconciliation had something to
      // check it against.
      const censused = await t.query<{ clause_id: string }>(
        "select clause_id from finding_migration_census where kind = 'net_position'");
      expect(censused.map(c => c.clause_id)).toEqual(['c1']);
    }, migratorDb());
  });

  it('keys a collection review by the COLLECTION, exactly as it was stored', async () => {
    await withPg(async t => {
      await aReview(t, 'br1', collection('coll-1', ['d1', 'd2']), ['d1', 'd2'], {
        'coll-1': { c1: finding() },
      });
      await backfillFindings(t);
      const rows = await t.query<{ findings_key: string }>(
        "select findings_key from finding where review_id = 'br1'");
      expect(rows.map(r => r.findings_key)).toEqual(['coll-1']);
    }, migratorDb());
  });

  it('migrates an abandoned run s pending and running cells as themselves', async () => {
    await withPg(async t => {
      await aReview(t, 'br1', documents(['d1']), ['d1'], {
        d1: {
          c1: finding({ status: 'pending' }),
          c2: finding({ clauseId: 'c2', status: 'running' }),
          c3: finding({ clauseId: 'c3', status: 'cancelled' }),
        },
      });
      await backfillFindings(t);
      const rows = await t.query<{ clause_id: string; status: string }>(
        "select clause_id, status from finding where review_id = 'br1' order by clause_id");
      expect(rows.map(r => r.status)).toEqual(['pending', 'running', 'cancelled']);
    }, migratorDb());
  });

  it('leaves review.findings exactly as it found it', async () => {
    await withPg(async t => {
      const partner = await aUser(t, 'Partner');
      const findings = {
        d1: { c1: finding({ verification: { state: 'verified', byUserId: partner, at: 1_700_000_009_000 } }) },
      };
      await aReview(t, 'br1', documents(['d1']), ['d1'], findings);
      const before = await t.query<{ findings: unknown }>("select findings from review where id = 'br1'");
      await backfillFindings(t);
      const after = await t.query<{ findings: unknown }>("select findings from review where id = 'br1'");
      expect(after[0].findings).toEqual(before[0].findings);
      expect(after[0].findings).toEqual(findings);
    }, migratorDb());
  });
});

describe('it refuses rather than guesses, and changes nothing when it does', () => {
  const failsWith = async (t: Tx, pattern: RegExp): Promise<void> => {
    // Inside a savepoint, so the rollback the real migration gets from its
    // own transaction is the rollback this assertion observes.
    await expect(t.tx(tt => backfillFindings(tt))).rejects.toThrow(pattern);
    expect(await t.query("select 1 from finding where review_id = 'br1'")).toEqual([]);
    expect(await t.query(
      "select 1 from finding_disposition where review_id = 'br1'")).toEqual([]);
    expect(await t.query("select 1 from note where review_id = 'br1'")).toEqual([]);
    expect(await t.query('select 1 from finding_migration_census')).toEqual([]);
  };

  it('REFUSES the whole migration when a verification names an unknown user, and changes nothing', async () => {
    // The single most important refusal in the stage: the alternative is the
    // deploy operator's name on a lawyer's judgement.
    await withPg(async t => {
      await aReview(t, 'br1', documents(['d1']), ['d1'], {
        d1: { c1: finding({ verification: {
          state: 'verified', byUserId: '00000000-0000-0000-0000-0000000000aa', at: 1_700_000_010_000,
        } }) },
      });
      await failsWith(t, /resolves to no app_user/);
      const blob = await t.query<{ findings: Record<string, Record<string, { verification: unknown }>> }>(
        "select findings from review where id = 'br1'");
      expect(blob[0].findings.d1.c1.verification).toEqual({
        state: 'verified', byUserId: '00000000-0000-0000-0000-0000000000aa', at: 1_700_000_010_000,
      });
    }, migratorDb());
  });

  it('REFUSES a verification with no byUserId at all, rather than attributing it to nobody', async () => {
    await withPg(async t => {
      await aReview(t, 'br1', documents(['d1']), ['d1'], {
        d1: { c1: finding({ verification: { state: 'verified', at: 1_700_000_010_000 } }) },
      });
      await failsWith(t, /resolves to no app_user/);
    }, migratorDb());
  });

  it('REFUSES a verification with no instant, rather than stamping it with now()', async () => {
    await withPg(async t => {
      const partner = await aUser(t, 'Partner');
      await aReview(t, 'br1', documents(['d1']), ['d1'], {
        d1: { c1: finding({ verification: { state: 'verified', byUserId: partner } }) },
      });
      await failsWith(t, /does not stamp a human judgement with the moment it ran/);
    }, migratorDb());
  });

  it('REFUSES a rejection with no reason', async () => {
    await withPg(async t => {
      const partner = await aUser(t, 'Partner');
      await aReview(t, 'br1', documents(['d1']), ['d1'], {
        d1: { c1: finding({ verification: {
          state: 'rejected', byUserId: partner, at: 1_700_000_011_000, reason: '   ',
        } }) },
      });
      await failsWith(t, /REJECTED with no reason/);
    }, migratorDb());
  });

  it('REFUSES a note whose author is not an app_user', async () => {
    await withPg(async t => {
      await aReview(t, 'br1', documents(['d1']), ['d1'], {
        d1: { c1: finding({ notes: [{ id: 'n1', findingId: 'd1::c1', text: 'x',
          byUserId: 'u-human', at: 1_700_000_012_000 }] }) },
      });
      await failsWith(t, /resolves to no app_user/);
    }, migratorDb());
  });

  it('REFUSES a note whose findingId names a different clause from the one it is stored under', async () => {
    // One of the two is wrong and nothing here can tell which. Showing a
    // remark against the wrong clause is the failure this prevents.
    await withPg(async t => {
      const partner = await aUser(t, 'Partner');
      await aReview(t, 'br1', documents(['d1']), ['d1'], {
        d1: { c1: finding({ notes: [{ id: 'n1', findingId: 'd1::c9', text: 'x',
          byUserId: partner, at: 1_700_000_013_000 }] }) },
      });
      await failsWith(t, /says it is about clause "c9" but is stored under "c1"/);
    }, migratorDb());
  });

  it('REFUSES a note whose findingId names a document the review does not cover', async () => {
    await withPg(async t => {
      const partner = await aUser(t, 'Partner');
      await aReview(t, 'br1', collection('coll-1', ['d1']), ['d1'], {
        'coll-1': { c1: finding({ notes: [{ id: 'n1', findingId: 'd-elsewhere::c1', text: 'x',
          byUserId: partner, at: 1_700_000_014_000 }] }) },
      });
      await failsWith(t, /neither the key it is stored under nor a document this review covers/);
    }, migratorDb());
  });

  it('REFUSES a findings key that no target explains', async () => {
    await withPg(async t => {
      await aReview(t, 'br1', documents(['d1']), ['d1'], {
        'a-key-from-nowhere': { c1: finding() },
      });
      await failsWith(t, /no document or collection this review covers explains this findings key/);
    }, migratorDb());
  });

  it('REFUSES a collection review keyed by one of its DOCUMENTS rather than the collection', async () => {
    // The exact shape of the six defects in sub-project C, arriving as
    // stored data rather than as code.
    await withPg(async t => {
      await aReview(t, 'br1', collection('coll-1', ['d1', 'd2']), ['d1', 'd2'], {
        d1: { c1: finding() },
      });
      await failsWith(t, /explains this findings key/);
    }, migratorDb());
  });

  it('REFUSES a status it does not recognise, rather than tidying it to error', async () => {
    await withPg(async t => {
      await aReview(t, 'br1', documents(['d1']), ['d1'], {
        d1: { c1: finding({ status: 'finished' }) },
      });
      await failsWith(t, /is not one of pending, running, done, error, cancelled/);
    }, migratorDb());
  });

  it('REFUSES a findings key whose value is not an object, rather than dropping every finding under it', async () => {
    // The guard and the refusal are a pair: the CTE replaces a scalar with an
    // empty object so `jsonb_each` does not abort with a message naming no
    // row, and without this refusal that would silently lose a document's
    // whole column of findings.
    await withPg(async t => {
      await aReview(t, 'br1', documents(['d1']), ['d1'], { d1: 'not an object' });
      await failsWith(t, /are a string, not an object of clause id to finding/);
    }, migratorDb());
  });

  it('lists EVERY offending row, not just the first one Postgres reached', async () => {
    await withPg(async t => {
      await aReview(t, 'br1', documents(['d1']), ['d1'], {
        d1: {
          c1: finding({ verification: { state: 'verified', byUserId: 'ghost-1', at: 1 } }),
          c2: finding({ clauseId: 'c2', verification: { state: 'verified', byUserId: 'ghost-2', at: 2 } }),
        },
      });
      const err = await t.tx(tt => backfillFindings(tt)).catch((e: Error) => e);
      expect((err as Error).message).toMatch(/ghost-1/);
      expect((err as Error).message).toMatch(/ghost-2/);
      expect((err as Error).message).toMatch(/Nothing has been changed/);
      expect((err as Error).message).toMatch(/review\.findings is untouched/);
    }, migratorDb());
  });
});

describe('the reconciliation is by key, and it can find something', () => {
  it('finds a verification that landed on the WRONG KEY, which a count check cannot see', async () => {
    // The mutation this test exists for: make the reconciliation compare
    // COUNTS instead of keys and it goes green over two verifications that
    // swapped places — which is precisely the arithmetic that lands a
    // rejection on the wrong clause.
    await withPg(async t => {
      const partner = await aUser(t, 'Partner');
      const trainee = await aUser(t, 'Trainee');
      await aReview(t, 'br1', documents(['d1']), ['d1'], {
        d1: {
          c1: finding({ verification: { state: 'verified', byUserId: partner, at: 1_700_000_020_000 } }),
          c2: finding({ clauseId: 'c2', verification: {
            state: 'rejected', byUserId: trainee, at: 1_700_000_021_000, reason: 'Wrong schedule.' } }),
        },
      });
      await censusFindings(t);
      await shredFindings(t);
      expect(await reconcileCensus(t)).toEqual([]);

      // Now swap the two dispositions, exactly as a shred that keyed by the
      // wrong column would have written them. The COUNT of non-unchecked
      // dispositions is unchanged: two before, two after.
      await t.query(`
        update finding_disposition d
           set state = s.state, reason = s.reason, by_user_id = s.by_user_id, at = s.at
          from (select clause_id, state, reason, by_user_id, at from finding_disposition
                where review_id = 'br1') s
         where d.review_id = 'br1'
           and d.clause_id = case s.clause_id when 'c1' then 'c2' else 'c1' end`);
      const counts = await t.query<{ n: string }>(
        "select count(*)::text n from finding_disposition where state <> 'unchecked'");
      expect(counts[0].n).toBe('2');

      const found = await reconcileCensus(t);
      expect(found).toHaveLength(2);
      expect(found.join('\n')).toMatch(/br1\/d1\/c1/);
      expect(found.join('\n')).toMatch(/br1\/d1\/c2/);
      await expect(assertReconciled(t)).rejects.toThrow(/discrepanc/i);
      await expect(assertReconciled(t)).rejects.toThrow(/Nothing has been changed/);
    }, migratorDb());
  });

  it('finds a note that did not land', async () => {
    await withPg(async t => {
      const partner = await aUser(t, 'Partner');
      await aReview(t, 'br1', documents(['d1']), ['d1'], {
        d1: { c1: finding({ notes: [{ id: 'n1', findingId: 'd1::c1', text: 'x',
          byUserId: partner, at: 1_700_000_022_000 }] }) },
      });
      await censusFindings(t);
      await shredFindings(t);
      expect(await reconcileCensus(t)).toEqual([]);
      await t.query("delete from note where id = 'n1'");
      expect((await reconcileCensus(t)).join('\n'))
        .toMatch(/note "n1" was censused but is not in the rows/);
    }, migratorDb());
  });

  it('finds a confirmed net position that did not land', async () => {
    await withPg(async t => {
      const partner = await aUser(t, 'Partner');
      await aReview(t, 'br1', collection('coll-1', ['d1']), ['d1'], {
        'coll-1': { c1: finding({ netPosition: {
          proposed: 'p', state: 'confirmed', byUserId: partner, at: 1_700_000_023_000, trail: [],
        } }) },
      });
      await censusFindings(t);
      await shredFindings(t);
      expect(await reconcileCensus(t)).toEqual([]);
      await t.query('update finding set net_position = null');
      expect((await reconcileCensus(t)).join('\n')).toMatch(/confirmed net position/);
    }, migratorDb());
  });

  it('finds a finding that did not land at all', async () => {
    await withPg(async t => {
      await aReview(t, 'br1', documents(['d1']), ['d1'], { d1: { c1: finding() } });
      await censusFindings(t);
      await shredFindings(t);
      expect(await reconcileCensus(t)).toEqual([]);
      await t.query('delete from finding');
      expect((await reconcileCensus(t)).join('\n'))
        .toMatch(/is in the blob and did not land as a row/);
    }, migratorDb());
  });
});

describe('the report says what was found and what could not be kept', () => {
  it('names a discarded assigneeId rather than dropping it silently (P24, S17)', async () => {
    // `Verification.assigneeId` reaches nobody (ruling R1) and has no home in
    // the new schema. A migration that dropped it would leave no trace that a
    // clause had ever been assigned to anybody.
    await withPg(async t => {
      const partner = await aUser(t, 'Partner');
      const trainee = await aUser(t, 'Trainee');
      await aReview(t, 'br1', documents(['d1']), ['d1'], {
        d1: { c1: finding({ verification: {
          state: 'verified', byUserId: partner, at: 1_700_000_024_000, assigneeId: trainee,
        } }) },
      });
      await backfillFindings(t);
      const report = await t.query<{ censused: number; landed: number; discrepancies: unknown[]; summary: string }>(
        'select censused, landed, discrepancies, summary from finding_migration_report order by at desc limit 1');
      expect(report[0].summary).toMatch(/assigneeId/);
      expect(report[0].summary).toMatch(new RegExp(trainee));
      expect(report[0].discrepancies).toEqual([]);
      expect(report[0].landed).toBe(1);
      // A verification and an assignee — two censused records for one cell.
      expect(report[0].censused).toBe(2);
      const census = await t.query<{ kind: string }>(
        'select kind from finding_migration_census order by kind');
      expect(census.map(c => c.kind)).toEqual(['assignee', 'verification']);
    }, migratorDb());
  });

  it('writes a report row only when the movement it describes is real', async () => {
    await withPg(async t => {
      await aReview(t, 'br1', documents(['d1']), ['d1'], {
        d1: { c1: finding({ verification: { state: 'verified', byUserId: 'ghost', at: 1 } }) },
      });
      // Counted rather than asserted empty: migration 007 itself wrote one
      // report row over the reviews that existed when it ran, and that row is
      // committed. What must not change is the COUNT.
      const rows = async () => (await t.query<{ n: string }>(
        'select count(*)::text n from finding_migration_report'))[0].n;
      const before = await rows();
      await t.tx(tt => backfillFindings(tt)).catch(() => undefined);
      expect(await rows()).toBe(before);
    }, migratorDb());
  });

  it('counts every kind of censused record', async () => {
    await withPg(async t => {
      const partner = await aUser(t, 'Partner');
      await aReview(t, 'br1', collection('coll-1', ['d1']), ['d1'], {
        'coll-1': {
          c1: finding({
            verification: { state: 'verified', byUserId: partner, at: 1_700_000_030_000 },
            notes: [{ id: 'n1', findingId: 'd1::c1', text: 'x', byUserId: partner, at: 1_700_000_031_000 }],
            netPosition: { proposed: 'p', state: 'confirmed', byUserId: partner,
              at: 1_700_000_032_000, trail: [] },
          }),
          c2: finding({ clauseId: 'c2' }),
        },
      });
      await backfillFindings(t);
      const census = await t.query<{ kind: string; n: string }>(
        'select kind, count(*)::text n from finding_migration_census group by kind order by kind');
      expect(census).toEqual([
        { kind: 'net_position', n: '1' },
        { kind: 'note', n: '1' },
        { kind: 'verification', n: '1' },
      ]);
      const report = await t.query<{ censused: number; landed: number }>(
        'select censused, landed from finding_migration_report order by at desc limit 1');
      expect(report[0]).toEqual({ censused: 3, landed: 2 });
    }, migratorDb());
  });
});
