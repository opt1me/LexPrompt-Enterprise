-- The two roles P10 requires. Created by the DEPLOYMENT, not by a migration.
-- In Azure the equivalent is run once by the Flexible Server admin;
-- infra/modules/postgres.bicep (Task 24) names it and the README carries it
-- as a deployment step rather than leaving it to be discovered.
create role lexprompt_migrator login password 'lexprompt_migrator_dev';
create role lexprompt_app      login password 'lexprompt_app_dev';
alter schema public owner to lexprompt_migrator;
grant usage on schema public to lexprompt_app;
-- The app role gets NOTHING else here. Every grant it holds is granted by the
-- migration that creates the table it applies to, so a table added without a
-- grant is a table the app cannot read — which fails loudly on the first
-- request rather than quietly widening.
