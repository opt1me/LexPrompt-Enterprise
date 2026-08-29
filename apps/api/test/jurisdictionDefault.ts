import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

/**
 * Every home `GATEWAY_ALLOWED_JURISDICTIONS` could acquire a default in.
 *
 * P4 asks for redundancy on this absence — it is invisible to every
 * happy-path test, so with a default restored the gateway still starts, the
 * gate still refuses an undeclared model, the boot banner still prints its
 * table, and NOTHING LOOKS WRONG. Two suites therefore assert it. ONE
 * shared predicate is what makes that redundancy rather than duplication:
 * two copies of these regexes would drift, and the copy that drifted would
 * be the one still reporting success.
 *
 * Returns a list of offending homes; an empty list is the property holding.
 */
export function jurisdictionDefaultOffenders(root: string): string[] {
  const offenders: string[] = [];

  const gw = readFileSync(path.join(root, 'apps/gateway/src/config.ts'), 'utf8');
  if (/GATEWAY_ALLOWED_JURISDICTIONS\s*(?:\?\?|\|\|)\s*['"`][^'"`]/.test(gw)) {
    offenders.push('apps/gateway/src/config.ts defaults it');
  }
  // The refusal itself, not merely the absence of a `??`: a loader that
  // defaults it to the empty string and carries on has no default and no
  // refusal, which is the worst of both.
  if (!/GATEWAY_ALLOWED_JURISDICTIONS is not set/.test(gw)) {
    offenders.push('apps/gateway/src/config.ts no longer refuses it when unset');
  }
  if (!/no default/i.test(gw)) {
    offenders.push('apps/gateway/src/config.ts no longer says the absence is deliberate');
  }

  const compose = readFileSync(path.join(root, 'docker-compose.yml'), 'utf8');
  if (/GATEWAY_ALLOWED_JURISDICTIONS[^\n]*:-/.test(compose)) {
    offenders.push('docker-compose.yml defaults it');
  }

  for (const line of readFileSync(path.join(root, '.env.example'), 'utf8').split('\n')) {
    if (line.includes('GATEWAY_ALLOWED_JURISDICTIONS') && !line.trimStart().startsWith('#')) {
      offenders.push('.env.example sets it uncommented');
    }
  }

  // Both Bicep files, not only `main.bicep`: `containerApps.bicep` declares
  // the same parameter and could default it on its own, and a check that
  // reads one file while the mutation is available in two is the shape of
  // guard this project keeps finding after the fact.
  const infra = path.join(root, 'infra');
  for (const file of bicepFiles(infra)) {
    const text = readFileSync(file, 'utf8');
    if (/param\s+allowedJurisdictions[^\n]*=/.test(text)) {
      offenders.push(`${path.relative(root, file).replace(/\\/g, '/')} defaults it`);
    }
  }

  // azd's parameter file uses `${VAR=fallback}` for a default (it does so
  // for oidcSubjectClaim and oidcGroupsClaim), so a default could arrive
  // here without touching a line of Bicep.
  const params = readFileSync(path.join(root, 'infra/main.parameters.json'), 'utf8');
  if (/GATEWAY_ALLOWED_JURISDICTIONS\s*=/.test(params)) {
    offenders.push('infra/main.parameters.json defaults it');
  }

  return offenders;
}

function bicepFiles(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) bicepFiles(full, out);
    else if (entry.name.endsWith('.bicep')) out.push(full);
  }
  return out;
}

/** The homes the predicate above reads, so a test can assert it reads them all. */
export const JURISDICTION_HOMES = [
  'apps/gateway/src/config.ts',
  'docker-compose.yml',
  '.env.example',
  'infra/main.bicep',
  'infra/modules/containerApps.bicep',
  'infra/main.parameters.json',
];
