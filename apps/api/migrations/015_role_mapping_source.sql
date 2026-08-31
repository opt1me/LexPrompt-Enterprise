-- 015: role_mapping becomes BOTH deployment configuration and an admin
-- surface -- which section 7 has always said it is, and which the shipped
-- table could not be.
--
-- NUMBERED 015, NOT 014. The plan's brief names
-- `014_role_mapping_source.sql`; `014_audit_partitions.sql` already exists
-- and an applied migration is immutable, so that number is taken.
-- `stage5abDoD.test.ts` asserted the next free number was 015 before this
-- file was written, because the alternative is discovering it when two
-- files claim one number.
--
-- ## The problem this closes
--
-- `seedRoleMappings` (auth/roles.ts) runs on the MIGRATOR connection at
-- every startup and DELETES every row `API_ROLE_MAPPINGS` does not name.
-- Its docstring is right about why: "an upsert-only seed would leave the
-- removed row in place and keep granting the role forever, with the
-- configuration file saying otherwise -- a revocation that silently did not
-- happen". That reasoning is unchanged and survives here in full.
--
-- What it cannot survive is a SECOND writer. An admin screen writing this
-- table as it stands would take the write, show it applied, and have it
-- deleted at the next container restart -- silently, with nothing on screen
-- and nothing in a log. So the two writers get one half of the table each,
-- and the boundary is enforced by the DATABASE rather than by whichever
-- `where` clause a handler happens to carry.
--
-- ## Why row-level security, and why WITHOUT `force`
--
-- `infra/postgres/init.sql` makes `lexprompt_migrator` the owner of schema
-- public, and `role_mapping` is owned by it (checked against the running
-- database, not assumed: `pg_tables.tableowner` reads `lexprompt_migrator`).
-- A table's owner BYPASSES row-level security unless the table is `force`d
-- -- so `enable` alone gives exactly the split wanted: the seed keeps full
-- reach, and every request is bounded to `source = 'admin'`. Adding `force
-- row level security` here would break the seed, and the symptom would be
-- that configuration silently stops revoking. Do not add it.
alter table role_mapping
  add column source text not null default 'configuration'
    check (source in ('configuration', 'admin')),
  -- WHO and WHEN, for an admin row. Null on a configuration row: nobody
  -- typed it into a screen, and naming the deployment as an author would be
  -- an attribution nobody made.
  add column created_at timestamptz not null default now(),
  add column created_by_user_id uuid references app_user(id),
  add column updated_at timestamptz,
  add column updated_by_user_id uuid references app_user(id),
  -- P52: an admin row that deployment configuration later claimed. The row
  -- becomes `source = 'configuration'`, and this column keeps the fact
  -- visible on the row FOREVER rather than only in the audit log -- an
  -- administrator looking at the screen must be able to see that their
  -- change was superseded without going and reading a log for it.
  add column converted_from_admin_at timestamptz;

-- Existing rows are deployment configuration, which is what they are: the
-- column's DEFAULT back-fills them, and it stays as the default afterwards
-- so that an INSERT which omits `source` is REFUSED by the policy below
-- rather than quietly becoming deployment configuration. That is the
-- direction that fails loudly.

alter table role_mapping enable row level security;

-- READ EVERYTHING. `roleFor` must see configuration rows or every sign-in
-- fails; there is no privacy boundary inside this table.
create policy role_mapping_read on role_mapping
  for select to lexprompt_app using (true);

-- WRITE ONLY ADMIN ROWS. Three policies rather than one `for all`, because
-- `for all` would also govern SELECT and would silently narrow the read
-- above to `source = 'admin'` -- which would make every sign-in through a
-- configuration mapping fail, at startup, in production, for everyone. That
-- is the tidier-looking implementation, it passes every write test, and it
-- is the mutation `roleMappingGrants.pg.test.ts`'s first case exists to
-- kill.
create policy role_mapping_insert_admin on role_mapping
  for insert to lexprompt_app with check (source = 'admin');
create policy role_mapping_update_admin on role_mapping
  for update to lexprompt_app using (source = 'admin') with check (source = 'admin');
create policy role_mapping_delete_admin on role_mapping
  for delete to lexprompt_app using (source = 'admin');

-- A CONSEQUENCE OF THE UPDATE POLICY WORTH WRITING DOWN, because a handler
-- that does not know it is a handler that undercounts:
--
--   `select ... for update` returns ONLY the rows that also pass the UPDATE
--   policy's USING clause. A configuration row is visible to a plain SELECT
--   (the read policy above says `using (true)`) and INVISIBLE to the same
--   SELECT with `for update` appended. Confirmed by probing this database
--   directly rather than read off the manual.
--
-- So the last-admin-mapping guard in `routes/admin/roleMappings.ts` LOCKS
-- the rows it may write (`source = 'admin'`) and COUNTS over all of them
-- (no `for update`) in that order. Counting with `for update` would miss an
-- admin mapping that came from `API_ROLE_MAPPINGS` and refuse a delete that
-- was perfectly safe.

grant insert, update, delete on role_mapping to lexprompt_app;

-- THE WORKER GETS NOTHING, not even select, and the revoke stands in the
-- record beside the absent grant -- the same reasoning 006, 012 and 013
-- each give: an absent grant is undone by one careless `grant all`, and a
-- revoke is not.
revoke all on role_mapping from lexprompt_worker;
