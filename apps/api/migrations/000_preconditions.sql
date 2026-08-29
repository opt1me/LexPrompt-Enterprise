-- Refuses the migration when the deployment has not created the two roles P10
-- requires. Without this, the first GRANT in 001 fails with Postgres's own
-- "role does not exist", which is true and says nothing about what the
-- operator is supposed to do about it.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'lexprompt_app') then
    raise exception 'The role lexprompt_app does not exist. LexPrompt runs every request as an app role that cannot modify a published playbook version, and the schema owner is a different role. Create both roles as part of the deployment: infra/postgres/init.sql is the local form, and the README carries the Azure step. A migration deliberately does not create its own principal, because it would then have to carry that principal password in version control.';
  end if;
  if not exists (select 1 from pg_roles where rolname = 'lexprompt_migrator') then
    raise exception 'The role lexprompt_migrator does not exist. See infra/postgres/init.sql.';
  end if;
end $$;
