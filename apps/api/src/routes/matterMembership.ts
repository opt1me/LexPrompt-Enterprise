import { ModelError } from '@lexprompt/core';
import type { Tx } from '../db/pool.ts';

/**
 * The refusal a review target and a collection member share when a document
 * id names nothing this matter holds.
 *
 * ONE implementation, at the second copy rather than the third. The two
 * callers already answered in near-identical words and are about to gain the
 * same second branch (§11.1's precedent case); two copies of a message whose
 * whole job is to tell a reader WHICH failure they hit is precisely the
 * sibling drift this project has paid for six times.
 *
 * **Two different facts, and they must not arrive as one.** A generic "not
 * in this matter" over a precedent id would send someone hunting for a
 * document that is right there in front of them on the playbook side of the
 * app — the file they uploaded ten minutes ago, in a list they can see. So
 * the missing ids are re-read, and any that turn out to be PRECEDENT
 * documents are named as such, with the reason: a precedent is somebody
 * else's deal and can never be reviewed or grouped as though it were the
 * deal in hand (S23).
 *
 * The query is `kind = 'precedent'` and workspace-scoped, so it can only
 * ever say "this id is a precedent OF YOURS" — never confirm that an id
 * belongs to another firm.
 */
export async function refuseForeignDocuments(
  t: Pick<Tx, 'query'>,
  ws: string,
  missing: string[],
  subject: 'review' | 'collection',
): Promise<ModelError> {
  const precedents = await t.query<{ id: string }>(
    `select id from document
     where workspace_id = $1 and kind = 'precedent' and id = any($2::text[])`,
    [ws, missing]);
  if (precedents.length > 0) {
    const ids = precedents.map(r => r.id);
    const one = ids.length === 1;
    const verb = subject === 'review' ? 'reviewed' : 'grouped into a collection';
    return new ModelError(
      `${one ? 'This is a precedent document' : 'These are precedent documents'} and cannot be `
      + `${verb}: ${ids.join(', ')}. Precedent documents are stored with the playbook you `
      // "kept apart from a matter's documents", NOT "…from matter documents":
      // `workspaceScope.test.ts` reads every string literal in this
      // directory as SQL, and `from matter documents` parses as a statement
      // against the `matter` table with no workspace predicate. The guard is
      // right to be crude — relaxing it so prose can say anything is how it
      // stops biting — so the prose moves instead.
      + "learned them from, kept apart from a matter's own documents, and are never offered "
      + 'as something to review — a citation pointing into another client\'s document would '
      + 'carry this app\'s authority into the wrong deal.',
      'conflict', 400);
  }
  const one = missing.length === 1;
  const noun = subject === 'review' ? 'A review can only cover' : 'A collection can only group';
  return new ModelError(
    `This ${subject} names ${missing.length} document${one ? '' : 's'} that ${one ? 'is' : 'are'} `
    + `not in this matter: ${missing.join(', ')}. ${noun} documents in the matter it belongs to.`,
    'conflict', 400);
}
