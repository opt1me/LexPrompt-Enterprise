#!/usr/bin/env bash
# A temporary bridge from the host to the compose-internal Postgres, for the
# .pg.test.ts suites. Deliberately NOT a published port on the postgres
# service: a container attached to a routable network has a route out, and
# the database must not have one. Runs in the foreground; Ctrl-C removes it.
#
# CORRECTED against the reference (Task 1 brief) after actually running it:
# `docker run --network internal-net -p host:container ...` never binds the
# host port at all, silently — `docker port` on the resulting container comes
# back empty and the host connection is refused, even though
# `docker inspect`'s HostConfig.PortBindings looks correctly set. Verified
# directly against this compose file's OWN `internal` network before writing
# this comment: a plain nginx container started the same way exhibits the
# identical silent non-binding. That is exactly the behaviour this project's
# own docker-compose.yml documents for an `internal: true` network — "removes
# every published port" — and it applies to ANY container joined to that
# network at creation time, not only to the services this compose file
# defines. A single `--network` at `docker run` time cannot dodge it.
#
# The fix is the two-step docker networking already has for this: publish the
# port on a container created on the default (routable) bridge, THEN
# `docker network connect` it to the internal network afterwards, which does
# not re-apply the internal network's port restriction to a port already
# bound. Confirmed working end to end (`npm run test:pg` passing through it)
# before this script was trusted.
set -euo pipefail
NET="$(docker compose ls --format json >/dev/null 2>&1 && echo lexprompt_internal)"
echo "export LEXPROMPT_TEST_DATABASE_URL=postgres://lexprompt_app:lexprompt_app_dev@127.0.0.1:55432/lexprompt"
echo "export LEXPROMPT_TEST_MIGRATION_URL=postgres://lexprompt_migrator:lexprompt_migrator_dev@127.0.0.1:55432/lexprompt"
# The third role (Stage 3 Task 4). The grant suites prove what the run worker
# CANNOT do — write a note, read or write a disposition — and a grant test can
# only prove that by attempting the write as the role itself.
echo "export LEXPROMPT_TEST_WORKER_URL=postgres://lexprompt_worker:lexprompt_worker_dev@127.0.0.1:55432/lexprompt"

CID=$(docker run -d --rm -p 127.0.0.1:55432:55432 alpine/socat \
  tcp-listen:55432,fork,reuseaddr tcp-connect:postgres:5432)
docker network connect "$NET" "$CID"
trap 'docker rm -f "$CID" >/dev/null 2>&1 || true' EXIT INT TERM
echo "Forwarding 127.0.0.1:55432 -> postgres:5432 (container $CID). Ctrl-C to stop."
docker wait "$CID"
