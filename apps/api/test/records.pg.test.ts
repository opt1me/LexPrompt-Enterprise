import { describe, it, expect } from 'vitest';
import { migratorDb, withPg } from './helpers/pgHarness.ts';
import type { Tx } from '../src/db/pool.ts';

const WS = '00000000-0000-0000-0000-000000000001';

async function aUser(t: Tx): Promise<string> {
  const rows = await t.query<{ id: string }>(
    `insert into app_user (id, workspace_id, issuer, subject, display_name, initials, role, status)
     values (gen_random_uuid(), $1, 'i', 's-' || gen_random_uuid()::text, 'A B', 'AB', 'reviewer', 'active')
     returning id`, [WS]);
  return rows[0].id;
}

describe('002_records', () => {
  it('every record table carries workspace_id NOT NULL', async () => {
    const rows = await migratorDb().query<{ table_name: string }>(`
      select c.relname as table_name
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind = 'r'
         and c.relname in ('matter','document','collection','playbook','playbook_version','review','changeset')
         and not exists (
           select 1 from information_schema.columns col
            where col.table_name = c.relname and col.column_name = 'workspace_id'
              and col.is_nullable = 'NO')
    `);
    // S9 is a property of every table or of none: one table without the
    // column is one query that cannot be scoped, and it would be the query
    // nobody thought about.
    expect(rows.map(r => r.table_name)).toEqual([]);
  });

  it('refuses an owner_id that is not a real user', async () => {
    await withPg(async t => {
      await expect(t.query(
        `insert into matter (id, workspace_id, name, owner_id, created_at, updated_at)
         values ('m1', $1, 'M', gen_random_uuid(), now(), now())`, [WS],
      )).rejects.toThrow(/foreign key/i);
    });
  });

  it('accepts a NULL owner_id — an unattributed import is not the uploader', async () => {
    // P16: `importPlaybook(json, byUserId = '')` produces an empty
    // attribution today, and the uploader maps it to NULL rather than
    // claiming the person doing the upload wrote it.
    await withPg(async t => {
      await t.query(
        `insert into playbook (id, workspace_id, name, created_at, updated_at, schema_version, created_by_user_id)
         values ('p1', $1, 'P', now(), now(), 1, null)`, [WS]);
      const rows = await t.query<{ n: string }>("select count(*)::text n from playbook where id = 'p1'");
      expect(rows[0].n).toBe('1');
    });
  });

  it('starts every mutable record at version 1', async () => {
    await withPg(async t => {
      const owner = await aUser(t);
      await t.query(
        `insert into matter (id, workspace_id, name, owner_id, created_at, updated_at)
         values ('m2', $1, 'M', $2, now(), now())`, [WS, owner]);
      const rows = await t.query<{ version: string }>("select version::text from matter where id = 'm2'");
      expect(rows[0].version).toBe('1');
    });
  });

  it('cascades a matter delete to its documents, collections and reviews', async () => {
    await withPg(async t => {
      const owner = await aUser(t);
      await t.query(`insert into matter (id, workspace_id, name, owner_id, created_at, updated_at)
                     values ('m3', $1, 'M', $2, now(), now())`, [WS, owner]);
      await t.query(`insert into document (id, workspace_id, matter_id, name, doc_type, text, parse_state,
                       byte_size, mime, blob_key, role, added_at, added_by_user_id)
                     values ('d3', $1, 'm3', 'D', 'pdf', 't', 'parsed', 1, 'application/pdf',
                       'workspace/x/document/d3', 'standalone', now(), $2)`, [WS, owner]);
      await t.query(`insert into collection (id, workspace_id, matter_id, name, base_document_id,
                       varies_document_ids, created_at, created_by_user_id)
                     values ('col3', $1, 'm3', 'C', 'd3', '[]'::jsonb, now(), $2)`, [WS, owner]);
      await t.query(`insert into review (id, workspace_id, matter_id, playbook_snapshot, target, findings,
                       model_id, started_at, created_by_user_id)
                     values ('rv3', $1, 'm3', '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 'x', now(), $2)`,
      [WS, owner]);
      await t.query("delete from matter where id = 'm3'");
      const docs = await t.query<{ n: string }>("select count(*)::text n from document where id = 'd3'");
      const cols = await t.query<{ n: string }>("select count(*)::text n from collection where id = 'col3'");
      const revs = await t.query<{ n: string }>("select count(*)::text n from review where id = 'rv3'");
      expect(docs[0].n).toBe('0');
      expect(cols[0].n).toBe('0');
      expect(revs[0].n).toBe('0');
    });
  });

  it('refuses a review whose playbook_snapshot is not an object', async () => {
    // `playbookSnapshot` is the record of what a review CLAIMS to have
    // checked. A review with a string or a null there is a review that
    // cannot say what it ran, which is worse than a review that failed.
    await withPg(async t => {
      const owner = await aUser(t);
      await t.query(`insert into matter (id, workspace_id, name, owner_id, created_at, updated_at)
                     values ('m4', $1, 'M', $2, now(), now())`, [WS, owner]);
      await expect(t.query(
        `insert into review (id, workspace_id, matter_id, playbook_snapshot, target, findings,
                             model_id, started_at, created_by_user_id)
         values ('r4', $1, 'm4', '"oops"'::jsonb, '{}'::jsonb, '{}'::jsonb, 'x', now(), $2)`,
        [WS, owner])).rejects.toThrow(/check constraint/i);
    });
  });

  // Not on the reference brief for this task, but src/types.ts's own
  // `DocumentRecord.matterId` is a required, non-optional `string` — a
  // persisted document always belongs to a matter — so the column must
  // refuse to be created without one, exactly as it would refuse a matter
  // that does not exist.
  it('refuses a document with no matter_id', async () => {
    await withPg(async t => {
      await expect(t.query(
        `insert into document (id, workspace_id, matter_id, name, doc_type, text, parse_state,
           byte_size, mime, blob_key, role, added_at)
         values ('d-no-matter', $1, null, 'D', 'pdf', 't', 'parsed', 1, 'application/pdf',
           'k', 'standalone', now())`, [WS],
      )).rejects.toThrow(/not-null constraint/i);
    });
  });

  it('refuses a collection whose varies_document_ids is not an array', async () => {
    await withPg(async t => {
      const owner = await aUser(t);
      await t.query(`insert into matter (id, workspace_id, name, owner_id, created_at, updated_at)
                     values ('m5', $1, 'M', $2, now(), now())`, [WS, owner]);
      await expect(t.query(
        `insert into collection (id, workspace_id, matter_id, name, base_document_id,
           varies_document_ids, created_at, created_by_user_id)
         values ('col5', $1, 'm5', 'C', 'd1', '{}'::jsonb, now(), $2)`, [WS, owner],
      )).rejects.toThrow(/check constraint/i);
    });
  });

  it('refuses a changeset whose items is not an array', async () => {
    await withPg(async t => {
      const owner = await aUser(t);
      await t.query(`insert into playbook (id, workspace_id, name, created_at, updated_at, schema_version)
                     values ('p6', $1, 'P', now(), now(), 1)`, [WS]);
      await t.query(`insert into playbook_version (id, workspace_id, playbook_id, version_number,
                       content, published_at, published_by_user_id)
                     values ('pv6', $1, 'p6', 1, '{}'::jsonb, now(), $2)`, [WS, owner]);
      await expect(t.query(
        `insert into changeset (id, workspace_id, playbook_id, from_version_id, source_summary,
           items, created_at, created_by_user_id)
         values ('cs6', $1, 'p6', 'pv6', 'S', '{}'::jsonb, now(), $2)`, [WS, owner],
      )).rejects.toThrow(/check constraint/i);
    });
  });

  it('links a playbook to its current published version and back', async () => {
    await withPg(async t => {
      const owner = await aUser(t);
      await t.query(`insert into playbook (id, workspace_id, name, created_at, updated_at, schema_version)
                     values ('p7', $1, 'P', now(), now(), 1)`, [WS]);
      await t.query(`insert into playbook_version (id, workspace_id, playbook_id, version_number,
                       content, published_at, published_by_user_id)
                     values ('pv7', $1, 'p7', 1, '{}'::jsonb, now(), $2)`, [WS, owner]);
      await t.query("update playbook set current_version_id = 'pv7' where id = 'p7'");
      const rows = await t.query<{ current_version_id: string }>(
        "select current_version_id from playbook where id = 'p7'");
      expect(rows[0].current_version_id).toBe('pv7');
    });
  });
});
