import { readFileSync } from 'node:fs';
import { loadConfig, describeConfig, ConfigError } from './config.ts';
import { buildServer } from './server.ts';

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
  const app = buildServer({ config });
  await app.listen({ port: config.port, host: '0.0.0.0' });
}

void main();
