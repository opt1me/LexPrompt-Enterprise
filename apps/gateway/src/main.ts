import { readFileSync } from 'node:fs';
import { loadConfig, describeConfig, ConfigError } from './config.ts';
import { buildServer, type MtlsHttpsOptions } from './server.ts';
import { buildDeps } from './wiring.ts';

/**
 * `null` for `mode: 'entra'`/`'none'` (`'none'` is unreachable from
 * configuration, but the type is total): only mTLS changes how this
 * process listens. Reading the three files here, rather than inside
 * `buildServer`, keeps `server.ts` free of filesystem access — it is
 * exercised entirely through `app.inject` in tests, which never touch
 * disk.
 */
function mtlsHttpsOptions(
  config: ReturnType<typeof loadConfig>,
): MtlsHttpsOptions | undefined {
  if (config.caller.mode !== 'mtls') return undefined;
  const { caFile, certFile, keyFile } = config.caller;
  return {
    ca: readFileSync(caFile),
    cert: readFileSync(certFile),
    key: readFileSync(keyFile),
    requestCert: true,
    rejectUnauthorized: true,
  };
}

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig(process.env, p => readFileSync(p, 'utf8'));
  } catch (err) {
    if (err instanceof ConfigError) {
      // Fail loudly, at startup, before a single call can be served.
      process.stderr.write(`LexPrompt gateway will not start.\n${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }
  process.stdout.write(`${describeConfig(config)}\n`);
  const app = buildServer(buildDeps(config, process.stdout), mtlsHttpsOptions(config));
  await app.listen({ port: config.port, host: '0.0.0.0' });
}

void main();
