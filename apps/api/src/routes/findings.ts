import type { FastifyInstance } from 'fastify';
import type { Db } from '../db/pool.ts';
import { readFindings, type FindingsRead } from '../findings/read.ts';

/**
 * The findings routes — Task 14's read, and the human writes Task 15 adds
 * beside it.
 *
 * `GET /v1/reviews/:id/findings` is the flip: from here on, a finding's
 * answer, a person's judgement about it and their notes on it are READ FROM
 * ROWS, not from `review.findings`. The blob is still written for the rest
 * of Part 3B and is frozen in Task 22 — never dropped ("never delete what
 * you cannot read") — but nothing reads it for a finding after this route
 * exists.
 *
 * A review this workspace cannot see answers 404 rather than an empty
 * findings map. That distinction is the whole reason this is a route rather
 * than a field: "this review has no findings yet" and "this review is not
 * yours / is gone" render identically once one of them has been flattened
 * into `{}`, and a findings pane that says nothing was found about a
 * contract is the founding defect of this project.
 */
export function registerFindings(app: FastifyInstance, db: Db): void {
  app.get('/v1/reviews/:id/findings', async (req): Promise<FindingsRead> => {
    const { id } = req.params as { id: string };
    return readFindings(db, id, req.actor!.workspaceId);
  });
}
