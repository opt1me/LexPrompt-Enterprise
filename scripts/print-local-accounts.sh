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
EOF
