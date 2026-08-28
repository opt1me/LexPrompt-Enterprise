import type { Playbook, PlaybookVersion, Review } from '../types';
import { buildPositionHealthMap } from './positionHealthMap';
import type { PositionHealth } from './positionHealth';

export interface PositionRow {
  playbookId: string;
  playbookName: string;
  clauseId: string;
  clauseTitle: string;
  positionText: string;
  health: PositionHealth;
}

export interface PositionRowsInput {
  /** Every playbook the caller could read, each with its own published
   *  versions (`listVersions`). */
  playbooks: { playbook: Playbook; versions: PlaybookVersion[] }[];
  /** Every review the caller could read, from every matter — drift is only
   *  visible across matters, which is the whole reason this screen exists. */
  reviews: Review[];
}

/** conceded first, then untested, then held, then no-position. The ordering
 *  IS the answer to "which of our house rules are drifting": a position
 *  someone has given up on outranks one nothing has tested, which outranks
 *  one that is holding. */
const HEALTH_RANK: Record<PositionHealth['kind'], number> = {
  conceded: 0, untested: 1, held: 2, 'no-position': 3,
};

/**
 * The `Standard positions` index. Pure, and it introduces no derivation of
 * its own: health comes from `buildPositionHealthMap`, exactly as the
 * playbook editor's chips do, so the tab and the editor cannot disagree
 * about the same position (R-G18).
 *
 * Reads each playbook's CURRENT PUBLISHED VERSION, never its draft. A draft
 * has never been published, so no review has run against its wording, and
 * reporting health against it would attribute evidence to words nothing was
 * ever measured against — the exact failure R-D17's fix closed one level
 * down.
 */
export function buildPositionRows({ playbooks, reviews }: PositionRowsInput): PositionRow[] {
  const rows: PositionRow[] = [];

  for (const { playbook, versions } of playbooks) {
    const current = versions.find(v => v.id === playbook.currentVersionId);
    if (!current) continue;

    const health = buildPositionHealthMap({ clauses: current.clauses, versions, reviews });

    for (const clause of current.clauses) {
      const position = clause.standardPosition;
      if (!position) continue;
      rows.push({
        playbookId: playbook.id,
        playbookName: playbook.name,
        clauseId: clause.id,
        clauseTitle: clause.title,
        positionText: position.text,
        health: health[clause.id] ?? { kind: 'untested' },
      });
    }
  }

  return rows.sort((a, b) =>
    HEALTH_RANK[a.health.kind] - HEALTH_RANK[b.health.kind]
    || a.playbookName.localeCompare(b.playbookName)
    || a.clauseTitle.localeCompare(b.clauseTitle));
}
