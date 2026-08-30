-- The three roles P10 and §9 require. Created by the DEPLOYMENT, not by a
-- migration. In Azure the equivalent is run once by the Flexible Server
-- admin; infra/modules/postgres.bicep (Task 24) names it and the README
-- carries it as a deployment step rather than leaving it to be discovered.
create role lexprompt_migrator login password 'lexprompt_migrator_dev';
create role lexprompt_app      login password 'lexprompt_app_dev';
-- The run worker (§9, §14). It writes model output and CANNOT touch a
-- disposition, an event or a note: 006_dispositions.sql revokes all three
-- explicitly, which is what makes "nothing derives a human judgement" a fact
-- about the database rather than a fact about the code that happens not to
-- write one.
create role lexprompt_worker   login password 'lexprompt_worker_dev';
alter schema public owner to lexprompt_migrator;
grant usage on schema public to lexprompt_app, lexprompt_worker;
-- The worker's declared cap, set HERE rather than in 005_findings.sql because
-- ALTER ROLE needs CREATEROLE and the ADMIN option on the role, and
-- lexprompt_migrator deliberately has neither — a migrator that could alter
-- roles could grant itself anything. 005 asserts that this line was run and
-- refuses the migration when it was not, so skipping it is loud rather than a
-- worker that holds a lease on a cell through a runaway query.
alter role lexprompt_worker set statement_timeout = '60s';
-- The app and worker roles get NOTHING else here. Every grant they hold is
-- granted by the migration that creates the table it applies to, so a table
-- added without a grant is a table they cannot read — which fails loudly on
-- the first request rather than quietly widening.
