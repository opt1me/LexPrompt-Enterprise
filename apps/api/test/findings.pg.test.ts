import { describe, it, expect } from 'vitest';
import { migratorDb, withPg } from './helpers/pgHarness.ts';
import type { Tx } from '../src/db/pool.ts';
import {
  FINDING_COLUMNS, findingValues, fromFindingRow, toFindingRow,
  type FindingContent, type FindingRow,
} from '../src/findings/rows.ts';

/**
 * `finding` and `note` as real rows, against a real Postgres.
 *
 * What has to be proved here is not "it stores things". It is that the three
 * ABSENCES survive — `truncatedDocuments`, `positionOutcome` and
 * `netPosition` each mean something different absent from what they mean
 * present-and-empty — and that a `finding` row can never grow a verification
 * or a note by accident, because both live in tables of their own.
 */

const WS = '00000000-0000-0000-0000-000000000001';

async function aUser(t: Tx): Promise<string> {
  const rows = await t.query<{ id: string }>(
    `insert into app_user (id, workspace_id, issuer, subject, display_name, initials, role, status)
     values (gen_random_uuid(), $1, 'i', 's-' || gen_random_uuid()::text, 'A B', 'AB', 'reviewer', 'active')
     returning id`, [WS]);
  return rows[0].id;
}

async function aReview(t: Tx, id = 'fr1'): Promise<void> {
  await t.query(
    `insert into matter (id, workspace_id, name, created_at, updated_at)
     values ('fm1', $1, 'Brookvale', now(), now()) on conflict (id) do nothing`, [WS]);
  await t.query(
    `insert into review (id, workspace_id, matter_id, playbook_snapshot, target, model_id, started_at)
     values ($1, $2, 'fm1', '{}'::jsonb, '{"kind":"documents","documentIds":[]}'::jsonb,
             'test/model', now())`, [id, WS]);
}

const placeholders = FINDING_COLUMNS.map((_, i) => {
  const n = `$${i + 1}`;
  return FINDING_COLUMNS[i] === 'citations' || FINDING_COLUMNS[i] === 'net_position'
    ? `${n}::jsonb` : n;
}).join(', ');

async function insertFinding(t: Tx, row: FindingRow): Promise<FindingRow> {
  const rows = await t.query<FindingRow>(
    `insert into finding (${FINDING_COLUMNS.join(', ')}) values (${placeholders}) returning *`,
    findingValues(row));
  return rows[0];
}

/** A finding through the row mapping, into the real table, and back. */
async function roundTrip(t: Tx, f: FindingContent, key = 'd1'): Promise<FindingContent> {
  return fromFindingRow(await insertFinding(t, toFindingRow(f, 'fr1', key, WS)));
}

const base: FindingContent = {
  clauseId: 'c1',
  status: 'done',
  summary: 'The break notice period is six months.',
  citations: [{ quote: 'six months', documentId: 'd1', page: 4, clauseRef: '14.2' }],
};

describe('a finding round-trips through its own table', () => {
  it('carries every field it was given', async () => {
    await withPg(async t => {
      await aReview(t);
      const back = await roundTrip(t, {
        ...base,
        riskLevel: 'High',
        riskAnalysis: 'The cap is uncapped.',
        edited: true,
        positionOutcome: 'deviates',
        positionRationale: 'The firm requires a cap.',
      });
      expect(back).toEqual({
        clauseId: 'c1',
        status: 'done',
        summary: 'The break notice period is six months.',
        citations: [{ quote: 'six months', documentId: 'd1', page: 4, clauseRef: '14.2' }],
        riskLevel: 'High',
        riskAnalysis: 'The cap is uncapped.',
        edited: true,
        positionOutcome: 'deviates',
        positionRationale: 'The firm requires a cap.',
      });
    });
  });

  it('keeps an absent truncatedDocuments absent, and never returns []', async () => {
    // `truncated` alone already names the only document there is on a
    // single-document finding; an empty array here reads as "several
    // documents, none cut short", which is a different fact.
    await withPg(async t => {
      await aReview(t);
      const back = await roundTrip(t, { ...base, truncated: true });
      // NOT toEqual — Vitest cannot tell an absent key from an undefined one,
      // and absence is the assertion (CLAUDE.md).
      expect('truncatedDocuments' in back).toBe(false);
      expect(back.truncated).toBe(true);
      const stored = await t.query<{ truncated_documents: string[] | null }>(
        "select truncated_documents from finding where clause_id = 'c1'");
      expect(stored[0].truncated_documents).toBeNull();
    });
  });

  it('carries truncatedDocuments when a collection finding has them', async () => {
    await withPg(async t => {
      await aReview(t);
      const back = await roundTrip(t, {
        ...base, truncated: true, truncatedDocuments: ['The deed of variation'],
      });
      expect(back.truncatedDocuments).toEqual(['The deed of variation']);
    });
  });

  it('keeps an absent positionOutcome absent, and distinguishes it from unclear', async () => {
    // "We have no house rule here" and "we have one and could not tell" are
    // different facts, and only the first should produce no comparison.
    await withPg(async t => {
      await aReview(t);
      const none = await roundTrip(t, base);
      expect('positionOutcome' in none).toBe(false);
      expect('positionRationale' in none).toBe(false);
      const unclear = await roundTrip(t, {
        ...base, clauseId: 'c2', positionOutcome: 'unclear',
        positionRationale: 'The model gave no reason.',
      });
      expect(unclear.positionOutcome).toBe('unclear');
    });
  });

  it('keeps an absent netPosition absent on a standalone finding', async () => {
    await withPg(async t => {
      await aReview(t);
      expect('netPosition' in await roundTrip(t, base)).toBe(false);
    });
  });

  it('carries a net position, its state and its trail, on a collection finding', async () => {
    await withPg(async t => {
      await aReview(t);
      const netPosition = {
        proposed: 'The tenant has a rolling break on six months notice.',
        state: 'confirmed' as const,
        byUserId: 'u1',
        at: 1_700_000_000_000,
        trail: [{ documentId: 'd1', kind: 'original' as const, effect: 'Grants it.', citations: [] }],
      };
      // Keyed by the COLLECTION id, which is what `findingsKeyFor` returns
      // for a collection target — never by one of its documents.
      const back = await roundTrip(t, { ...base, netPosition }, 'coll-1');
      expect(back.netPosition).toEqual(netPosition);
    });
  });

  it('NEVER produces a verification or notes from a finding row', async () => {
    // A `fromFindingRow` that invented `verification: unchecked()` would be
    // the engine deriving a human judgement one layer below where anybody
    // looks for it. The type forbids it; this checks the value too.
    await withPg(async t => {
      await aReview(t);
      const back = await roundTrip(t, base);
      expect('verification' in back).toBe(false);
      expect('notes' in back).toBe(false);
      const columns = await t.query<{ column_name: string }>(
        "select column_name from information_schema.columns where table_name = 'finding'");
      const names = columns.map(c => c.column_name);
      expect(names.length).toBeGreaterThan(10);
      expect(names).not.toContain('verification');
      expect(names).not.toContain('notes');
    });
  });
});

describe('the table refuses what the shapes forbid', () => {
  it('refuses a status outside the five the engine produces', async () => {
    await withPg(async t => {
      await aReview(t);
      await expect(insertFinding(t, {
        ...toFindingRow(base, 'fr1', 'd1', WS),
        status: 'tidied' as FindingRow['status'],
      })).rejects.toThrow(/finding_status_check/);
    });
  });

  it('refuses citations that are not an array', async () => {
    await withPg(async t => {
      await aReview(t);
      await expect(insertFinding(t, {
        ...toFindingRow(base, 'fr1', 'd1', WS), citations: '{"quote":"x"}',
      })).rejects.toThrow(/citations_check/);
    });
  });

  it('refuses a second finding on the same review, key and clause', async () => {
    await withPg(async t => {
      await aReview(t);
      await roundTrip(t, base);
      await expect(insertFinding(t, toFindingRow(base, 'fr1', 'd1', WS)))
        .rejects.toThrow(/finding_pkey/);
    });
  });

  it('keeps the same clause under two different keys, which is what a document review needs', async () => {
    await withPg(async t => {
      await aReview(t);
      await roundTrip(t, base, 'd1');
      await roundTrip(t, base, 'd2');
      const rows = await t.query<{ n: string }>(
        "select count(*)::text n from finding where review_id = 'fr1' and clause_id = 'c1'");
      expect(rows[0].n).toBe('2');
    });
  });

  it('deletes a review s findings with the review, rather than orphaning them', async () => {
    await withPg(async t => {
      await aReview(t);
      await roundTrip(t, base);
      await t.query("delete from review where id = 'fr1'");
      expect(await t.query("select 1 from finding where review_id = 'fr1'")).toEqual([]);
    }, migratorDb());
  });
});

describe('a note belongs to a finding and names a real person', () => {
  async function aFinding(t: Tx): Promise<void> {
    await aReview(t);
    await insertFinding(t, toFindingRow(base, 'fr1', 'd1', WS));
  }

  const insertNote = (t: Tx, over: Partial<{
    id: string; key: string; clause: string; text: string; by: string;
  }> = {}) => t.query(
    `insert into note (id, review_id, findings_key, clause_id, workspace_id, text, by_user_id, at)
     values ($1, 'fr1', $2, $3, $4, $5, $6, now())`,
    [over.id ?? 'n1', over.key ?? 'd1', over.clause ?? 'c1', WS,
      over.text ?? 'Checked against the deed.', over.by]);

  it('stores a note against the finding it is about', async () => {
    await withPg(async t => {
      await aFinding(t);
      await insertNote(t, { by: await aUser(t) });
      const rows = await t.query<{ text: string }>("select text from note where id = 'n1'");
      expect(rows[0].text).toBe('Checked against the deed.');
    });
  });

  it('refuses a note whose author is not an app_user', async () => {
    // A note is a person's remark. "Somebody wrote this about your clause"
    // with no somebody is not a remark anyone can weigh.
    await withPg(async t => {
      await aFinding(t);
      await expect(insertNote(t, { by: '00000000-0000-0000-0000-0000000000aa' }))
        .rejects.toThrow(/note_by_user_id_fkey/);
    });
  });

  it('refuses an empty or whitespace-only note', async () => {
    await withPg(async t => {
      await aFinding(t);
      const by = await aUser(t);
      await expect(insertNote(t, { by, text: '   ' })).rejects.toThrow(/note_text_check/);
    });
  });

  it('refuses a note on a finding that does not exist', async () => {
    await withPg(async t => {
      await aFinding(t);
      const by = await aUser(t);
      await expect(insertNote(t, { by, clause: 'c-nonexistent' }))
        .rejects.toThrow(/note_review_id_findings_key_clause_id_fkey/);
    });
  });

  it('deletes a note with the finding it is about', async () => {
    await withPg(async t => {
      await aFinding(t);
      await insertNote(t, { by: await aUser(t) });
      await t.query("delete from finding where review_id = 'fr1'");
      expect(await t.query("select 1 from note where id = 'n1'")).toEqual([]);
    });
  });
});
