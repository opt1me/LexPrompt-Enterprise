import { importFindings } from '../../src/findings/import.ts';
import { readFindingsBlob } from '../../src/findings/reconcile.ts';
import type { Tx } from '../../src/db/pool.ts';

/**
 * Plants a whole findings map as rows, IMPORTING EACH CELL AS ITS OWN AUTHOR.
 *
 * ## Why this exists at all
 *
 * `importFindings` may record the SIGNED-IN PERSON's judgements and nobody
 * else's (see its attribution section: a `byUserId` in a request body is not
 * evidence of anything, and taking one let any signed-in user put a
 * colleague's name on a verification). Several suites used it as a fixture
 * writer for a review carrying two people's judgements, which the product
 * can now only produce as TWO imports — one per person, each signed in.
 *
 * So the partition lives here rather than in four files. A fixture that
 * hand-rolled it would drift; a fixture that passed one actor for a
 * two-author blob would be asking the import to do the thing it refuses.
 *
 * ## The author of a cell
 *
 * Its verification's `byUserId`, or — for an `unchecked` verification — its
 * first note's. A cell that names TWO people THROWS rather than picking one:
 * a fixture that quietly imported a trainee's note under a partner's name
 * would be a lie in exactly the place these suites make claims about. Such a
 * review cannot be imported at all today, and a fixture must not pretend
 * otherwise.
 *
 * A cell that attributes nothing (an `unchecked` finding with no notes)
 * writes no attribution anywhere, so it goes in with `fallbackAuthor` — who
 * must be a real `app_user` only if some other cell in that slice needs one.
 */
export async function seedFindingRows(
  t: Tx,
  reviewId: string,
  workspaceId: string,
  target: unknown,
  blob: unknown,
  fallbackAuthor: string,
): Promise<void> {
  // Read through the same reader the import uses, so a blob this cannot
  // partition is refused by `readFindingsBlob`'s own sentence rather than by
  // a `TypeError` in a helper.
  const cells = readFindingsBlob(blob, target as never);
  const byAuthor = new Map<string, Record<string, Record<string, unknown>>>();
  const map = blob as Record<string, Record<string, unknown>>;

  for (const cell of cells) {
    const named = new Set<string>();
    if (cell.verification.state !== 'unchecked' && cell.verification.byUserId) {
      named.add(cell.verification.byUserId);
    }
    for (const note of cell.notes) named.add(note.byUserId);
    if (named.size > 1) {
      throw new Error(
        `The fixture cell ${cell.findingsKey}/${cell.clauseId} names ${named.size} different `
        + `people (${[...named].join(', ')}). An import records ONE signed-in person's own `
        + 'judgements, so no request can produce this cell, and a helper that picked one of the '
        + 'names would be planting a row the product cannot make.');
    }
    const author = [...named][0] ?? fallbackAuthor;
    const slice = byAuthor.get(author) ?? {};
    slice[cell.findingsKey] = { ...(slice[cell.findingsKey] ?? {}),
      [cell.clauseId]: map[cell.findingsKey][cell.clauseId] };
    byAuthor.set(author, slice);
  }

  for (const [author, slice] of byAuthor) {
    await importFindings(t, reviewId, workspaceId, target as never, slice, { id: author });
  }
}
