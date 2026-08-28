import { loadConfig, describeConfig, ConfigError } from './config.ts';
import { discoverJwks, makeTokenVerifier } from './oidc.ts';
import { buildServer } from './server.ts';

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig(process.env);
  } catch (err) {
    if (err instanceof ConfigError) {
      // Fail loudly, at startup, before a single call can be served — the
      // same discipline as the gateway's config, and for the same reason:
      // S29 exists precisely so a bad issuer is a startup failure, not a
      // system that runs and mostly works.
      process.stderr.write(`LexPrompt api will not start.\n${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }
  process.stdout.write(`${describeConfig(config)}\n`);

  const jwks = await discoverJwks(config.auth.issuer);
  const verify = makeTokenVerifier(config.auth, jwks);

  const app = buildServer({ verify });
  await app.listen({ port: config.port, host: '0.0.0.0' });
}

void main();
