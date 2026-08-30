import type { FastifyInstance } from 'fastify';
import { appendAudit } from '../audit/write.ts';
import { ModelError, type AllowedModel, type WorkspaceSettings } from '@lexprompt/core';
import type { Db } from '../db/pool.ts';
import type { GatewayClient } from '../gatewayClient.ts';
import { ConflictError } from '../errors.ts';
import { callerAuthRefusal, unreachableGateway } from '../gatewayFailure.ts';

/**
 * §6.6: the workspace's model choice, server side.
 *
 * `GET /v1/workspace/settings` answers ANY signed-in role — a reviewer needs
 * to see what model runs their reviews, read-only (`ROUTE_POLICY`'s
 * `'reviewer'` entry for this route is deliberate, not an oversight). `PUT`
 * needs `'admin'`, the same bar §7 sets for changing role mapping.
 *
 * The allowlist itself has ONE home — the gateway (Stage 1's interface note
 * 2) — so a `PUT` asks it via `gateway.models()`, the same client `/v1/infer`
 * and `/v1/models` already use, rather than holding a second copy here that
 * could drift from it.
 */
export interface WorkspaceSettingRow {
  workspace_id: string;
  model_choice_id: string | null;
  model_choice_label: string | null;
  model_choice_model: string | null;
  concurrency: number;
  // `pg`'s default type parser hands a `bigint` column back as a STRING,
  // never a `number` — a value that large cannot round-trip through JS
  // `number` losslessly in general, so the driver refuses to guess. Every
  // other `version` column in this project (`db/rows.ts`'s `bigintOf`)
  // reads the exact same way; this repeats that conversion rather than
  // importing a private helper from a sibling module.
  version: string | number;
  updated_at: Date;
  updated_by_user_id: string | null;
}

/** `''` for "not chosen yet" — the SAME convention `Settings.modelChoiceId`
 *  used, kept on purpose (see `WorkspaceSettings`'s own docstring) so a
 *  caller's `isConfigured`-style check does not need a second shape for the
 *  same fact. `absentUnless`'s reasoning (`db/rows.ts`) for the two optional
 *  string fields: a key present with an `undefined` value round-trips
 *  differently through JSON than an absent key, and `structuredClone` (how
 *  the browser eventually persists anything derived from this) preserves
 *  the difference. */
export function fromWorkspaceSettingRow(row: WorkspaceSettingRow): WorkspaceSettings {
  return {
    modelChoiceId: row.model_choice_id ?? '',
    ...(row.model_choice_label ? { modelChoiceLabel: row.model_choice_label } : {}),
    ...(row.model_choice_model ? { modelChoiceModel: row.model_choice_model } : {}),
    concurrency: row.concurrency,
    version: typeof row.version === 'number' ? row.version : Number(row.version),
    updatedAt: row.updated_at.getTime(),
    ...(row.updated_by_user_id ? { updatedByUserId: row.updated_by_user_id } : {}),
  };
}

/**
 * Reads the workspace's row, creating it with the table's own defaults
 * (`concurrency default 5`, no model chosen) on first read — "one row per
 * workspace, created lazily by the route" is `001_identity.sql`'s own
 * comment on this table, honoured here rather than by a migration seed that
 * would have to know every workspace id in advance.
 *
 * `on conflict do nothing … returning *` racing empty is the same shape
 * `resolveActor` uses for the identical reason: two concurrent first reads
 * must not both try to insert and have the loser error out on the primary
 * key, so the loser re-reads instead.
 */
async function ensureRow(db: Db, workspaceId: string): Promise<WorkspaceSettingRow> {
  const existing = await db.query<WorkspaceSettingRow>(
    'select * from workspace_setting where workspace_id = $1', [workspaceId]);
  if (existing[0]) return existing[0];
  const created = await db.query<WorkspaceSettingRow>(
    `insert into workspace_setting (workspace_id) values ($1)
     on conflict (workspace_id) do nothing
     returning *`,
    [workspaceId],
  );
  if (created[0]) return created[0];
  const row = await db.query<WorkspaceSettingRow>(
    'select * from workspace_setting where workspace_id = $1', [workspaceId]);
  if (!row[0]) {
    throw new ModelError('LexPrompt could not read this workspace\'s settings.', 'unknown', 500);
  }
  return row[0];
}

export function registerWorkspaceSettings(app: FastifyInstance, db: Db, gateway: GatewayClient): void {
  app.get('/v1/workspace/settings', async (req): Promise<WorkspaceSettings> => {
    const row = await ensureRow(db, req.actor!.workspaceId);
    return fromWorkspaceSettingRow(row);
  });

  // NOT `app.put<{ Body: … }>(…)` — see `me.ts`'s note on the same shape:
  // the inline generic is what `oidc.test.ts`'s route-discovery scanner does
  // not match, and a route registered that way is silently absent from the
  // 401 sweep.
  app.put('/v1/workspace/settings', async (req): Promise<WorkspaceSettings> => {
    const ws = req.actor!.workspaceId;
    const body = (req.body ?? {}) as Record<string, unknown>;

    // OMITTING `modelChoiceId` means "unchanged", exactly as omitting
    // `concurrency` does (Part 2A m7). It used to be required on every PUT,
    // which made the concurrency slider's Save on a FRESH workspace answer
    // *"A model choice is required."* — a 400 naming a field the admin did
    // not touch, on the one workspace state where they cannot satisfy it
    // without abandoning what they were doing. Sending it EMPTY is still
    // refused: "I am not changing the model" and "I am setting the model to
    // nothing" are different requests, and only the first is one this route
    // should carry out.
    const hasModelChoice = body.modelChoiceId !== undefined;
    const modelChoiceId = typeof body.modelChoiceId === 'string' ? body.modelChoiceId.trim() : '';
    if (hasModelChoice && !modelChoiceId) {
      throw new ModelError('A model choice is required.', 'unknown', 400);
    }
    // A row always exists by the time a real caller reaches this route (a
    // settings screen always `GET`s before it can render a form to submit),
    // but `ensureRow` also covers a bare PUT with no prior GET. Read FIRST
    // so an admin changing only the model does not silently reset
    // `concurrency` to the table's default — omitting a field must mean
    // "unchanged", not "revert".
    const before = await ensureRow(db, ws);
    const concurrency = body.concurrency === undefined ? before.concurrency : body.concurrency;
    if (typeof concurrency !== 'number' || !Number.isInteger(concurrency)
      || concurrency < 1 || concurrency > 20) {
      throw new ModelError('concurrency must be a whole number between 1 and 20.', 'unknown', 400);
    }
    if (body.version !== undefined && !Number.isInteger(body.version)) {
      throw new ModelError('version is present but is not a whole number.', 'unknown', 400);
    }

    // The allowlist has ONE home. This asks the gateway rather than holding
    // a second list — a second list here would be the exact drift Stage 1's
    // interface note 2 exists to prevent.
    //
    // Asked ONLY when the model is actually being set. A write that does
    // not name a model asserts nothing about one, so checking the stored id
    // against the allowlist here would let a withdrawn model block a
    // concurrency change — and would make a save fail for a reason the
    // admin's own request had nothing to do with. Whether the STORED choice
    // is still allowed is `staleModelChoiceId`'s question, asked where a
    // reader can act on it.
    let chosen: { id: string; label?: string; model?: string };
    if (hasModelChoice) {
      let status: number;
      let json: unknown;
      try {
        ({ status, json } = await gateway.models());
      } catch (err) {
        throw unreachableGateway(err, 'model list');
      }
      const refusal = callerAuthRefusal(status);
      if (refusal) throw refusal;
      if (status !== 200) {
        throw new ModelError('LexPrompt could not read the model allowlist.', 'service_misconfigured', 503);
      }
      const models = (json as { models?: AllowedModel[] })?.models ?? [];
      const found = models.find(m => m.id === modelChoiceId);
      if (!found) {
        throw new ModelError(
          `"${modelChoiceId}" is not on your firm's model allowlist. Choose a model from the list.`,
          'model_not_allowed', 400,
        );
      }
      chosen = found;
    } else {
      chosen = {
        id: before.model_choice_id ?? '',
        ...(before.model_choice_label ? { label: before.model_choice_label } : {}),
        ...(before.model_choice_model ? { model: before.model_choice_model } : {}),
      };
    }

    // Same shape as `matters.ts`'s PUT: a record with NO version claims to
    // be a create, so `workspace_setting.version = NULL` is never true and
    // an existing row refuses rather than being silently overwritten by a
    // caller that never stated which version it read.
    // ONE TRANSACTION with its audit row (S11): a record of a settings
    // change that did not happen is worse than no record.
    const rows = await db.tx(async t => {
      const written = await t.query<WorkspaceSettingRow>(
      `insert into workspace_setting
         (workspace_id, model_choice_id, model_choice_label, model_choice_model,
          concurrency, updated_by_user_id)
       values ($1, $2, $3, $4, $5, $6)
       on conflict (workspace_id) do update set
         model_choice_id    = excluded.model_choice_id,
         model_choice_label = excluded.model_choice_label,
         model_choice_model = excluded.model_choice_model,
         concurrency        = excluded.concurrency,
         updated_at         = now(),
         updated_by_user_id = excluded.updated_by_user_id,
         version             = workspace_setting.version + 1
       where workspace_setting.version = $7
       returning *`,
      [ws, chosen.id, chosen.label ?? null, chosen.model ?? null, concurrency, req.actor!.id,
        typeof body.version === 'number' ? body.version : null],
      );
      // Which SETTING changed is in `detail` rather than in the action:
      // `workspace.settings_changed` is one act with a shape, and a verb per
      // column would be a log of function calls rather than a record of
      // decisions.
      if (written[0]) {
        await appendAudit(t, {
          workspaceId: ws, actorUserId: req.actor!.id, action: 'workspace.settings_changed',
          subjectType: 'workspace', subjectId: ws,
          detail: {
            modelChoiceId: chosen.id,
            concurrency,
            modelChanged: hasModelChoice && chosen.id !== before.model_choice_id,
            concurrencyChanged: concurrency !== before.concurrency,
          },
        });
      }
      return written;
    });
    if (!rows[0]) {
      const current = await db.query<WorkspaceSettingRow>(
        'select * from workspace_setting where workspace_id = $1', [ws]);
      throw new ConflictError(current[0] ? fromWorkspaceSettingRow(current[0]) : undefined);
    }
    return fromWorkspaceSettingRow(rows[0]);
  });
}
