import { describe, it, expect, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { appDb, migratorDb } from './helpers/pgHarness.ts';
import { buildTestApi } from './helpers/apiHarness.ts';

/**
 * TWO PEOPLE CHANGING ONE JUDGEMENT AT THE SAME INSTANT, OVER A REAL
 * DATABASE.
 *
 * The owner's requirement is *"first person to verify wins"*, with *"a
 * partner may override a verification, and something can change from
 * Verified back to another state, at any time"*. Those two sentences are
 * only compatible because of the four mechanisms §6.3 names, and the first
 * of them is what this file proves: the version guard decides, in Postgres,
 * and the loser is REFUSED rather than merged.
 *
 * ## Why this suite does not use `withPg`
 *
 * `withPg` pins everything to one client inside one transaction that is
 * always rolled back — which is exactly what makes the other route suites
 * leave nothing behind, and exactly what makes a race impossible to
 * reproduce. Two writes serialised onto one connection cannot contend for a
 * row lock. So this suite COMMITS, over two real connections out of the app
 * pool, and deletes what it made.
 *
 * ## Which one wins is NOT asserted
 *
 * A test that expects the trainee to lose is a test that flakes on a faster
 * machine. What is asserted is the invariant: exactly one 200, exactly one
 * 409, exactly ONE history row for the contested instant, and a stored state
 * matching whichever answer was 200.
 */

const WS = '00000000-0000-0000-0000-000000000001';
const TRAINEE = '00000000-0000-0000-0000-0000000000b1';
const PARTNER = '00000000-0000-0000-0000-0000000000b2';
const REVIEW = 'race-r1';
const MATTER = 'race-m1';
const URL = `/v1/reviews/${REVIEW}/findings/d1/c1/disposition`;

const seed = migratorDb();

const principalFor = (subject: string) => ({
  issuer: 'https://issuer.example/realms/lexprompt', subject, groups: ['reviewers'],
});

function apiFor(id: string, name: string): FastifyInstance {
  const { app } = buildTestApi({
    principal: principalFor(`s-${id}`),
    db: appDb(),
    actor: { id, displayName: name, initials: 'XX', role: 'reviewer', workspaceId: WS },
  });
  return app;
}

const put = (app: FastifyInstance, body: unknown) => app.inject({
  method: 'PUT', url: URL, headers: { authorization: 'Bearer t' }, payload: body as never,
});

async function plant(): Promise<void> {
  for (const [id, name] of [[TRAINEE, 'A Trainee'], [PARTNER, 'R Okafor']] as const) {
    await seed.query(
      `insert into app_user (id, workspace_id, issuer, subject, display_name, initials, role,
                             status)
       values ($1, $2, 'i', $3, $4, 'XX', 'reviewer', 'active') on conflict (id) do nothing`,
      [id, WS, `s-${id}`, name]);
  }
  await seed.query(
    `insert into matter (id, workspace_id, name, created_at, updated_at)
     values ($1, $2, 'Race', now(), now()) on conflict (id) do nothing`, [MATTER, WS]);
  await seed.query(
    `insert into review (id, workspace_id, matter_id, playbook_snapshot, target, findings,
                         model_id, started_at)
     values ($1, $2, $3, '{}'::jsonb, '{"kind":"documents","documentIds":["d1"]}'::jsonb,
             '{}'::jsonb, 'test/model', now())
     on conflict (id) do nothing`, [REVIEW, WS, MATTER]);
  await seed.query(
    `insert into finding (review_id, findings_key, clause_id, workspace_id, status)
     values ($1, 'd1', 'c1', $2, 'done') on conflict do nothing`, [REVIEW, WS]);
  await seed.query(
    `insert into finding_disposition
       (review_id, findings_key, clause_id, workspace_id, state, changed_count)
     values ($1, 'd1', 'c1', $2, 'unchecked', 0) on conflict do nothing`, [REVIEW, WS]);
}

async function uproot(): Promise<void> {
  // `review` cascades to `finding`, and `finding` to its disposition and its
  // history — which is why 011 took `delete on finding` away from the app
  // role, and why this runs as the migrator rather than as the app.
  await seed.query('delete from review where id = $1', [REVIEW]);
  await seed.query('delete from matter where id = $1', [MATTER]);
  await seed.query('delete from app_user where id = any($1::uuid[])', [[TRAINEE, PARTNER]]);
}

interface HistoryRow { from_state: string; to_state: string; by_user_id: string }

const history = (): Promise<HistoryRow[]> => seed.query<HistoryRow>(
  `select from_state, to_state, by_user_id::text as by_user_id
     from finding_disposition_event where review_id = $1 order by id asc`, [REVIEW]);

const stored = (): Promise<{ state: string; changed_count: number }[]> =>
  seed.query('select state, changed_count from finding_disposition where review_id = $1',
    [REVIEW]);

describe('two people changing one judgement at the same instant', () => {
  afterAll(uproot);

  it('applies exactly one of two changes made against the same version, and refuses the other',
    async () => {
      await uproot();
      await plant();
      const trainee = apiFor(TRAINEE, 'A Trainee');
      const partner = apiFor(PARTNER, 'R Okafor');
      try {
        const results = await Promise.all([
          put(trainee, { state: 'verified', version: 1 }),
          put(partner, { state: 'rejected', reason: 'Cap is uncapped', version: 1 }),
        ]);
        const codes = results.map(r => r.statusCode).sort();
        expect(codes, results.map(r => r.body).join(' | ')).toEqual([200, 409]);

        const refused = results.find(r => r.statusCode === 409)!;
        const won = results.find(r => r.statusCode === 200)!;
        // The refusal carries the row that WON, so §6.3's sentence needs no
        // second round trip — Stage 3's interface note 2.
        const body = refused.json() as {
          current?: { version?: number; byUserId?: string; state?: string };
        };
        expect(body.current, 'a refusal arrived with no row to name').toBeDefined();
        expect(body.current!.version).toBe(2);
        expect(body.current!.byUserId).toBeTruthy();
        expect(body.current!.state).toBe(
          (won.json() as { disposition: { state: string } }).disposition.state);

        // EXACTLY ONE history row, not two. This is what fails if the stale
        // write is applied and then reported as a conflict — §14's named
        // mutation, "a UI that looks correct and a database where the later
        // click silently won".
        expect(await history()).toHaveLength(1);
        expect((await stored())[0]).toMatchObject({
          state: body.current!.state, changed_count: 1,
        });
      } finally {
        await trainee.close();
        await partner.close();
      }
    });

  it('records BOTH intentions when the refused person applies again, against the new version',
    async () => {
      await uproot();
      await plant();
      const trainee = apiFor(TRAINEE, 'A Trainee');
      const partner = apiFor(PARTNER, 'R Okafor');
      try {
        // Sequential here, so the loser is known: the point of this case is
        // the RESOLUTION, and a case that could not say who lost could not
        // assert the order of the two rows it produces.
        expect((await put(trainee, { state: 'verified', version: 1 })).statusCode).toBe(200);
        const refused = await put(partner, {
          state: 'rejected', reason: 'Cap is uncapped', version: 1,
        });
        expect(refused.statusCode).toBe(409);

        // §6.3: "a person who then repeats the change produces a second
        // history row, so both intentions are on the record". This is what
        // makes the refusal a resolution rather than a loss — and it is a
        // PERSON'S SECOND REQUEST, never a retry the server or the browser
        // performed on their behalf (P25).
        const again = await put(partner, {
          state: 'rejected', reason: 'Cap is uncapped', version: 2,
        });
        expect(again.statusCode, again.body).toBe(200);

        expect((await history()).map(e => [e.from_state, e.to_state, e.by_user_id])).toEqual([
          ['unchecked', 'verified', TRAINEE],
          ['verified', 'rejected', PARTNER],
        ]);
        expect((await stored())[0]).toMatchObject({ state: 'rejected', changed_count: 2 });
      } finally {
        await trainee.close();
        await partner.close();
      }
    });

  it('does NOT apply the refused write, and this is the mutation to try', async () => {
    await uproot();
    await plant();
    const trainee = apiFor(TRAINEE, 'A Trainee');
    const partner = apiFor(PARTNER, 'R Okafor');
    try {
      await put(trainee, { state: 'verified', version: 1 });
      await put(partner, { state: 'rejected', reason: 'Cap is uncapped', version: 1 });
      // Drop `and version = $8` from `setDisposition`'s UPDATE and THIS goes
      // red. Nothing else will: the route still answers 409 either way,
      // because the read-then-compare above it still refuses.
      expect((await stored())[0]).toMatchObject({ state: 'verified', changed_count: 1 });
      const rows = await history();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ to_state: 'verified', by_user_id: TRAINEE });
    } finally {
      await trainee.close();
      await partner.close();
    }
  });
});
