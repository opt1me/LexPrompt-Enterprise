import type { Tx } from './pool.ts';
import { backfillFindings } from '../findings/backfill.ts';

/**
 * A migration's TypeScript half, run in the SAME transaction as its `.sql`
 * file, immediately after it and before its ledger row.
 *
 * Only one migration has one, and it is the one that moves a lawyer's
 * recorded judgement: `007_findings_backfill`. The reason it is not SQL is
 * written at length in `findings/backfill.ts` — a refusal has to name every
 * offending row and say what to do about it, and the key it checks is derived
 * by `findingsKeyFor`, which is TypeScript and is the only place that
 * decision is allowed to live.
 *
 * A registry rather than a parameter every caller passes: `runMigrations`
 * defaults to this map, so the step cannot be forgotten by a call site — and
 * a test that wants a bare migration runner (`migrate.pg.test.ts` writes its
 * own `.sql` files into a temp directory) gets one for free, because no
 * version in that directory has a step here.
 */
export type MigrationStep = (t: Tx) => Promise<void>;

export const MIGRATION_STEPS: Record<string, MigrationStep> = {
  '007_findings_backfill': backfillFindings,
};
