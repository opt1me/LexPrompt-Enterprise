import { hostname } from 'node:os';
import { fileURLToPath } from 'node:url';
import type { JWTVerifyGetKey } from 'jose';
import { loadConfig, describeConfig, type ApiConfig } from './config.ts';
import { discoverJwks, makeTokenVerifier, type Principal } from './oidc.ts';
import { buildServer } from './server.ts';
import { makeGatewayClient, type GatewayClient } from './gatewayClient.ts';
import { makeDb, makePool, type Db } from './db/pool.ts';
import { ledgerVersionsWithNoFile, runMigrations } from './db/migrate.ts';
import { ensureAuditPartitionsOrWarn } from './audit/partitions.ts';
import { resolveActor, type Actor } from './auth/actor.ts';
import { roleFor, seedRoleMappings } from './auth/roles.ts';
import { AzureBlobStore, type BlobStore } from './blob/store.ts';
import { makePageImageCache } from './parse/hydrate.ts';
import { startParseWorkers } from './parse/parseWorker.ts';
import { startWorkerPool } from './run/worker.ts';
import { startReaper } from './run/reaper.ts';
import { startEventFeed } from './realtime/feed.ts';

/** Every startup failure reaches the operator as the same banner, whatever
 *  threw it. `ConfigError` was the only thing caught before, so a missing
 *  certificate file (`readFileSync` -> ENOENT, inside `makeGatewayClient`)
 *  and an issuer that is not up yet (`discoverJwks`) both exited with a Node
 *  stack trace — the shape S29's banner exists to replace. */
function refuseToStart(err: unknown): never {
  process.stderr.write(`LexPrompt api will not start.\n${(err as Error).message}\n`);
  process.exit(1);
}

async function main(): Promise<void> {
  // ANNOTATED, not inferred. `let config;` is an implicit `any` that never
  // stops being one across a try/catch, so `config.auth` was `any` and every
  // call taking it typechecked — including `discoverJwks(config.auth.issuer)`,
  // the one mistake `discoverJwks`'s signature exists to make impossible.
  // A composition root has no test standing under it, so the types are the
  // only thing that does.
  let config: ApiConfig;
  let gateway: GatewayClient;
  let db: Db;
  /**
   * The ENGINE's connection, on the third role.
   *
   * A separate pool because it is a separate ROLE — `lexprompt_worker` holds
   * no grant on `finding_disposition` or `finding_disposition_event`, and
   * that separation is the whole of "nothing derives a human judgement" as a
   * fact about the database rather than about the code. Sharing `db` here
   * would hand every worker slot the app role and silently undo it, with
   * every test still green.
   */
  let workerDb: Db;
  let blobs: BlobStore;
  try {
    config = loadConfig(process.env);
    // Inside the same guard as `loadConfig`, deliberately. `makeGatewayClient`
    // refuses to build a client that could not authenticate to the gateway in
    // EITHER of its caller-auth modes, and that refusal is the same kind of
    // fact as a missing issuer: something about how this process is configured
    // that makes serving impossible. It belongs in the same loud startup exit,
    // not in an unhandled rejection.
    gateway = makeGatewayClient(config);
    db = makeDb(makePool(config.databaseUrl, config.databasePoolMax));
    workerDb = makeDb(makePool(config.databaseWorkerUrl, config.workerPoolMax));
    // Inside the SAME guard, for the same reason `makeGatewayClient` is:
    // `AzureBlobStore`'s constructor resolves the credential, and
    // `resolveBlobCredential` refuses a configured source with no material
    // rather than reaching for the other one. That refusal is a fact about
    // how this process is configured, so it belongs in the startup banner —
    // not in an unhandled rejection the first time somebody opens a
    // document.
    blobs = new AzureBlobStore(config.blob, config.blob.container);
  } catch (err) {
    // Fail loudly, at startup, before a single call can be served — the
    // same discipline as the gateway's config, and for the same reason:
    // S29 exists precisely so a bad issuer is a startup failure, not a
    // system that runs and mostly works.
    //
    // Every error, not only `ConfigError`. A `ConfigError` filter meant the
    // ENOENT from a missing `API_MTLS_CERT_FILE` — a configuration fault by
    // every property that matters — reached the operator as a stack trace.
    refuseToStart(err);
  }
  process.stdout.write(`${describeConfig(config)}\n`);

  // Migrations run on the MIGRATOR connection, and that pool is closed
  // immediately: the schema owner's credential must not sit in a live pool
  // for the process's lifetime, where any later code could reach it.
  try {
    const migrationPool = makePool(config.databaseMigrationUrl, 2);
    try {
      const migrator = makeDb(migrationPool);
      const migrationDir = fileURLToPath(new URL('../migrations/', import.meta.url));
      await runMigrations(migrator, migrationDir);
      /*
       * THE LEDGER READ IN THE OTHER DIRECTION, and a refusal to start.
       *
       * `runMigrations` asks which files this database has not seen. This
       * asks which versions this database HAS seen that this image does not
       * carry, which is the question nothing asked — a renamed or deleted
       * migration was invisible in both directions.
       *
       * A refusal rather than a warning, unlike the audit-partition line
       * below, and the difference is which way the disagreement points. A
       * missing partition is a calendar that has moved on and the fix is
       * idempotent; a ledger row with no file means this database has been
       * migrated by an image NEWER than this one. Every query this process
       * issues would still parse and still return rows, against columns whose
       * meaning changed under it — the stale-presented-as-correct failure
       * this codebase's whole posture is against, at the one layer where
       * nothing above it can notice.
       */
      const unknown = await ledgerVersionsWithNoFile(migrator, migrationDir);
      if (unknown.length > 0) {
        throw new Error(
          `This database has applied ${unknown.length} migration(s) this build does not carry: `
          + `${unknown.join(', ')}. That means it was migrated by a NEWER build than this one, `
          + 'and running against it would issue this build\'s queries against a schema it does '
          + 'not know. Deploy the build that owns those migrations, or restore the database to '
          + 'a point this build can read. Nothing has been changed.');
      }
      // On the MIGRATOR connection, because the app role holds no write grant
      // on `role_mapping` (001_identity.sql) — which is what makes "no request
      // can change a role mapping" a fact about the database rather than a
      // fact about the code that happens not to write.
      //
      // In ONE transaction, because this seeding both grants and REVOKES: a
      // mapping the configuration no longer names is deleted. Split across
      // statements, a failure between them could leave the deletion applied
      // and the replacement not, which is an outage; or the grant applied and
      // the revocation not, which is worse and silent.
      const superseded = await migrator.tx(
        t => seedRoleMappings(t, config.workspaceId, config.roleMappings));
      /*
       * A SUPERSESSION IS SAID OUT LOUD, HERE, ONCE PER PAIR.
       *
       * `API_ROLE_MAPPINGS` naming a group an administrator had already
       * mapped from `/admin/roles` takes the row back: configuration wins,
       * and the row becomes deployment configuration. That is recorded
       * permanently on the row (`converted_from_admin_at`, rendered by the
       * admin screen), and it is written here as well because the two
       * readers are different people — the administrator sees the row, the
       * operator who redeployed sees this line, and the operator is the one
       * who can decide whether the collision was intended.
       *
       * There is no `audit_event` row for it. `appendAudit` requires an
       * actor and a startup has no person to name; see `seedRoleMappings`'s
       * own docstring for why every available candidate would be a false
       * attribution.
       */
      for (const s of superseded) {
        process.stdout.write(
          `api: role mapping ${s.groupValue} (issuer ${s.issuer}) was authored by an `
          + `administrator granting ${s.previousRole}; API_ROLE_MAPPINGS now claims it and `
          + `grants ${s.role}. Configuration wins: the row is deployment configuration from `
          + 'now on and can no longer be changed from /admin/roles.\n');
      }
      // THE AUDIT HORIZON, rolled forward on the one connection that owns
      // the schema. A migration runs once; the calendar does not. See
      // `audit/partitions.ts` — a failure here is a sentence and not a
      // refusal to start, because the partitions covering today already
      // exist on any deployment that has ever run.
      await ensureAuditPartitionsOrWarn(migrator, s => process.stdout.write(s));
    } finally {
      await migrationPool.end();
    }
  } catch (err) {
    refuseToStart(err);
  }

  // The container, created if it is not there — private, no public access
  // (`ensureContainer`'s own note on `access: undefined`). At startup rather
  // than lazily on first upload, so an unreachable or misconfigured store is
  // a loud startup failure instead of a document that will not save at the
  // moment somebody needed it to.
  try {
    await blobs.ensureContainer();
  } catch (err) {
    refuseToStart(err);
  }

  // `discoverJwks` reads `discoveryUrl` off the config itself — see its own
  // comment for why it does not take a string. Inside the same banner as
  // the rest of startup, because an issuer that is not answering yet is a
  // reason this process cannot serve, and it used to be an unhandled
  // rejection instead — which reads, in a container log, as a crash with no
  // stated cause.
  let jwks: JWTVerifyGetKey;
  try {
    jwks = await discoverJwks(config.auth);
  } catch (err) {
    refuseToStart(err);
  }
  const verify = makeTokenVerifier(config.auth, jwks);

  // The token's group claim becomes a role, and a principal in no mapped
  // group is refused (`no_role`, 403) rather than provisioned as anything.
  //
  // ONE transaction around both reads, so a person cannot be provisioned
  // with a role that was removed between the lookup and the write.
  //
  // `roleFor` runs FIRST, and its failure means no `app_user` row is created
  // at all: a person the firm has not given a role to is not yet a user of
  // this system, and a row saying otherwise would show up in an
  // administrator's list as somebody with access.
  const resolveActorForRequest = async (principal: Principal): Promise<Actor> =>
    db.tx(async t => resolveActor(
      t, principal, await roleFor(t, principal.issuer, principal.groups), config.workspaceId,
    ));

  // THE HOSTNAME, not the pid — see the worker id below, which is now this
  // same string rather than a second copy of the same expression. On a
  // socket it is what makes "which replica am I connected to" answerable
  // from the `hello` frame, which is what
  // `replicaFanout.compose.test.ts` rests on: two connections that report
  // the same instance id are not the cross-replica condition that test needs
  // and it fails saying so, rather than passing vacuously.
  const instanceId = `api-${hostname()}`;
  const app = buildServer({
    verify, gateway, db,
    workspaceId: config.workspaceId,
    maxBodyBytes: config.maxBodyBytes,
    resolveActor: resolveActorForRequest,
    eventPageMax: config.eventPageMax,
    assignmentInboxLimit: config.assignmentInboxLimit,
    searchLimitPerSource: config.searchLimitPerSource,
    auditExportMaxRows: config.auditExportMaxRows,
    instanceId,
    socket: {
      pingMs: config.wsPingMs,
      maxConnections: config.wsMaxConnections,
      maxSubscriptions: config.wsMaxSubscriptions,
      maxFrameBytes: config.wsMaxFrameBytes,
      eventPageMax: config.eventPageMax,
      presenceHeartbeatMs: config.presenceHeartbeatMs,
      presenceTtlMs: config.presenceTtlMs,
    },
    // The SAME store `ensureContainer` ran against above. One instance for
    // the upload path and the delete cascade both: two stores built from
    // one credential would still be two, and a cascade that reached the
    // wrong one would leave every byte behind and report success.
    blobs,
  });
  // ---- The engine, started AFTER the migrations and BEFORE listen ----
  //
  // After the migrations because a worker polling `run_cell` before 008 has
  // run would fail on every tick with "relation does not exist" — loud, but
  // loud in a way that says nothing about the real cause. Before `listen`
  // because a run created by the first request must find a pool already
  // polling: a queue whose workers start later would leave that run `queued`
  // for however long the gap is, with nothing on screen to explain it.
  //
  // ONE PROCESS, three loops. §9 does not call for a separate worker
  // deployment and this does not build one: the API is what holds the
  // gateway's client certificate and the blob credential, and a second
  // container would need both. What it does need is the pool arithmetic
  // `assertWorkerPoolFits` already refused a bad value for at load.
  const cache = makePageImageCache(config.pageImageLruBytes);
  // THE HOSTNAME, not the pid. `releaseOwnOrphanedLeases` reclaims the
  // leases this process left behind the last time it died, and it can only
  // recognise them if the identity survives a restart — a pid does not. A
  // container's hostname is stable across `docker compose restart` and
  // unique between replicas, which is exactly the two properties needed:
  // a process may expire its OWN orphaned lease (whatever held it is gone),
  // and must never expire another host's (that worker may still be running,
  // and stealing its cell would put two writers on one finding).
  const workerId = instanceId;
  const parseWorkers = startParseWorkers(
    {
      db: workerDb,
      blobs,
      pollMs: config.runPollMs,
      parseTimeoutMs: config.parseTimeoutMs,
      parseStuckReportMs: config.parseStuckReportMs,
    },
    config.parseWorkers);
  const runWorkers = startWorkerPool({
    db: workerDb, blobs, gateway, cache, workerId,
    caps: {
      runWorkers: config.runWorkers,
      runLeaseMs: config.runLeaseMs,
      runCellTimeoutMs: config.runCellTimeoutMs,
      runHeartbeatMs: config.runHeartbeatMs,
      runAttemptsMax: config.runAttemptsMax,
      runPollMs: config.runPollMs,
      runRetryBackoffMs: config.runRetryBackoffMs,
      workspaceRunConcurrency: config.workspaceRunConcurrency,
      pageRenderTimeoutMs: config.pageRenderTimeoutMs,
      pageImageMaxPages: config.pageImageMaxPages,
      runImageBytesMax: config.runImageBytesMax,
    },
  });
  // On the APP connection: it deletes from `event`, which the worker role
  // deliberately cannot do.
  // §8 FAN-OUT (Task 18, P39). One per replica, on its OWN connection: a
  // `LISTEN` issued on a pooled client is lost when that client is returned
  // to the pool, which is a fact about `pg` rather than a preference.
  //
  // On the APP connection string rather than the worker one: it reads
  // `event`, which both roles can, but it also has to be a connection this
  // process may keep open indefinitely, and the worker pool is sized for
  // the run slots.
  //
  // NOTHING ELSE PUBLISHES TO THE HUB. The disposition route writes the
  // outbox and stops there; this is what turns that row into a frame, on
  // every replica including the one that served the write. One path,
  // exercised constantly, rather than a local shortcut that behaves
  // differently on the busiest hop.
  const feed = startEventFeed({
    db,
    hub: app.lexpromptHub,
    // The SAME registry the socket beats into (Task 22). It listens on
    // `PRESENCE_CHANNEL` beside the outbox's doorbell, on the connection it
    // already holds, so a colleague connected to another replica appears on
    // this one's roster.
    presence: app.lexpromptPresence,
    listenerUrl: config.databaseUrl,
    tickMs: config.hubTickMs,
    pageMax: config.eventPageMax,
  });
  await feed.start();
  const reaper = startReaper({
    db,
    heartbeatMs: config.runHeartbeatMs,
    eventRetentionDays: config.eventRetentionDays,
    attemptsMax: config.runAttemptsMax,
  });

  // A container stop must let the cell in flight finish its WRITE. Without
  // this the process dies holding a lease, and the run is only recovered by
  // the reaper three heartbeats later — correct, but three intervals of a
  // review that looks stuck for no reason anybody could act on.
  const shutdown = (signal: string) => {
    process.stderr.write(`api: ${signal} received; stopping the engine.
`);
    void Promise.allSettled(
      [parseWorkers.stop(), runWorkers.stop(), reaper.stop(), feed.stop()])
      .then(() => app.close())
      .then(() => process.exit(0));
  };
  process.once('SIGTERM', () => { shutdown('SIGTERM'); });
  process.once('SIGINT', () => { shutdown('SIGINT'); });

  await app.listen({ port: config.port, host: '0.0.0.0' });
}

void main();
