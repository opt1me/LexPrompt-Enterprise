#!/usr/bin/env bash
# Run after `docker compose up`, from the `compose:up` npm script — so the
# four seeded Keycloak accounts (infra/keycloak/lexprompt-realm.json) are
# printed where anyone bringing up the stack will actually see them, rather
# than expecting them to go open the realm file.
set -euo pipefail
cat <<'EOF'

LexPrompt local accounts (Keycloak realm 'lexprompt'):
  trainee / trainee    reviewers
  partner / partner    partners
  admin   / admin      admins
  nogroups / nogroups  (no group - expect to be refused, on purpose)

Postgres (infra/postgres/init.sql, dev-only passwords):
  lexprompt_app      / lexprompt_app_dev        (the app role api runs every request as)
  lexprompt_migrator / lexprompt_migrator_dev   (schema owner, used only by the migration runner)
  It publishes NO host port by design (Task 1: no route out of `internal`).
  Run `scripts/pg-forward.sh` in its own terminal to reach it from the host.
EOF
