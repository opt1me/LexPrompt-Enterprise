import { fileURLToPath } from 'node:url';
import type { JWTVerifyGetKey } from 'jose';
import { loadConfig, describeConfig, type ApiConfig } from './config.ts';
import { discoverJwks, makeTokenVerifier } from './oidc.ts';
import { buildServer } from './server.ts';
import { makeGatewayClient, type GatewayClient } from './gatewayClient.ts';
import { makeDb, makePool, type Db } from './db/pool.ts';
import { runMigrations } from './db/migrate.ts';

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
      await runMigrations(makeDb(migrationPool), fileURLToPath(new URL('../migrations/', import.meta.url)));
    } finally {
      await migrationPool.end();
    }
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

  const app = buildServer({
    verify, gateway,
    workspaceId: config.workspaceId,
    maxBodyBytes: config.maxBodyBytes,
  });
  await app.listen({ port: config.port, host: '0.0.0.0' });
}

void main();
