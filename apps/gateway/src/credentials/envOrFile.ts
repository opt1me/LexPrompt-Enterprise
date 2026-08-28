import { readFileSync } from 'node:fs';

/**
 * Deliberately NO `readEnv` here.
 *
 * The obvious version of this file is
 * `export const readEnv = (name) => process.env[name];` — and that would be
 * a second environment reader outside `config.ts`, which `configSurface`
 * (Task 26) fails the build on. `GatewayConfig.readEnv` carries the
 * accessor from the one place that legitimately holds `process.env`, and
 * `main.ts` passes it into `DefaultCredentialResolver`, which already takes
 * it as a dependency for exactly this reason.
 */
export const readSecretFile = (path: string): string => readFileSync(path, 'utf8');
