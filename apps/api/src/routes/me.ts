import type { FastifyInstance } from 'fastify';
import { ModelError, type MeResponse } from '@lexprompt/core';
import type { Db } from '../db/pool.ts';
import { initialsFrom } from '../auth/actor.ts';

export function registerMe(app: FastifyInstance, db: Db): void {
  app.get('/v1/me', async (req): Promise<MeResponse> => {
    const a = req.actor!;
    return {
      id: a.id, issuer: a.issuer, subject: a.subject, email: a.email,
      displayName: a.displayName, initials: a.initials, role: a.role,
      workspaceId: a.workspaceId,
    };
  });

  // The one thing a person may change about themselves. Role, status, issuer
  // and subject are NOT here: a role a user can set is not a role.
  //
  // NOT `app.put<{ Body: ... }>(...)`: the inline generic sits between the
  // method name and its opening paren, which is exactly the shape the
  // route-discovery scanner in `oidc.test.ts`'s "no authentication bypass"
  // suite does not match — a route registered that way is silently absent
  // from the list the 401 sweep checks. Casting the body instead, as
  // `registerInfer` already does, keeps every route in this file visible to
  // that scanner.
  app.put('/v1/me', async (req): Promise<MeResponse> => {
    const a = req.actor!;
    const body = (req.body ?? {}) as { displayName?: unknown };
    const name = typeof body.displayName === 'string' ? body.displayName.trim() : '';
    if (!name) throw new ModelError('A display name cannot be empty.', 'conflict', 400);
    const initials = initialsFrom(name);
    await db.query('update app_user set display_name = $2, initials = $3 where id = $1',
      [a.id, name, initials]);
    return {
      id: a.id, issuer: a.issuer, subject: a.subject, email: a.email,
      displayName: name, initials, role: a.role, workspaceId: a.workspaceId,
    };
  });
}
