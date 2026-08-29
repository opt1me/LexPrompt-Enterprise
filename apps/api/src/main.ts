import { fileURLToPath } from 'node:url';
import type { JWTVerifyGetKey } from 'jose';
import { loadConfig, describeConfig, type ApiConfig } from './config.ts';
import { discoverJwks, makeTokenVerifier, type Principal } from './oidc.ts';
import { buildServer } from './server.ts';
import { makeGatewayClient, type GatewayClient } from './gatewayClient.ts';
import { makeDb, makePool, type Db } from './db/pool.ts';
import { runMigrations } from './db/migrate.ts';
import { resolveActor, type Actor } from './auth/actor.ts';
import { roleFor, seedRoleMappings } from './auth/roles.ts';
import { AzureBlobStore, type BlobStore } from './blob/store.ts';

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
      await runMigrations(migrator, fileURLToPath(new URL('../migrations/', import.meta.url)));
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
      await migrator.tx(t => seedRoleMappings(t, config.workspaceId, config.roleMappings));
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

  const app = buildServer({
    verify, gateway, db,
    workspaceId: config.workspaceId,
    maxBodyBytes: config.maxBodyBytes,
    resolveActor: resolveActorForRequest,
  });
  await app.listen({ port: config.port, host: '0.0.0.0' });
}

void main();
