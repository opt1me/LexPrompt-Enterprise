import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT, walk, rel, codeOf, ENV_NAME } from './sourceScan.ts';
import { jurisdictionDefaultOffenders, JURISDICTION_HOMES } from './jurisdictionDefault.ts';

/**
 * §18 item 10(a) and 10(b): the same code path runs in both environments,
 * and the divergences are exactly §5.1's enumerated list — CHECKED, not
 * asserted.
 *
 * This is the one guarantee in the server design that nothing else enforces
 * at rest. Its symptom when it stops being true is a green `docker compose
 * up` that says nothing about a tenant.
 */

const DIVERGENCE = JSON.parse(
  readFileSync(path.join(__dirname, 'divergence.json'), 'utf8'),
) as {
  rows: { n: number; what: string; keys: string[] }[];
  rowsWithNoKeys: Record<string, string>;
  sameEverywhere: string[];
  defaultedInBothEnvironments: string[];
  awaitingAzureTemplate: string[];
  localOnlyServices: string[];
};

/**
 * The three typed configuration modules. Everything else is forbidden from
 * reading the environment (S30, §18 item 10(a)).
 */
const CONFIG_MODULES = [
  'src/lib/config.ts',
  'apps/api/src/config.ts',
  'apps/gateway/src/config.ts',
].map(f => path.join(ROOT, f));

/**
 * The composition roots, and the ONLY other files permitted to touch
 * `process.env`.
 *
 * Each does exactly one thing with it: hands the whole object to
 * `loadConfig` and reads nothing itself. They cannot be config modules —
 * `loadConfig` is pure over its inputs precisely so it is testable without
 * an environment — and they cannot be forbidden either, because something
 * has to read the environment once.
 *
 * THREE, not two. The task brief named the two `main.ts` files; the shipped
 * gateway also has `smoke.ts`, a second entry point with its own `main()`,
 * its own `loadConfig` call and its own npm script. It is a composition
 * root by every property that makes the other two ones, and the honest
 * options were to name it here or to exempt its whole file from the scan —
 * and a file-level exemption hides everything in that file, not just the
 * part you meant to protect (CLAUDE.md, `PdfCanvas`). Naming it also holds
 * it to the pass-through rule below, which is what caught it reading
 * `process.env.USER` directly.
 *
 * The list is asserted to be EXACTLY these three, so it cannot grow
 * quietly. A fourth composition root is a design change, not a convenience.
 */
const COMPOSITION_ROOTS = [
  'apps/api/src/main.ts',
  'apps/gateway/src/main.ts',
  'apps/gateway/src/smoke.ts',
].map(f => path.join(ROOT, f));

const APP_SOURCES = [
  ...walk(path.join(ROOT, 'src')),
  ...walk(path.join(ROOT, 'apps/api/src')),
  ...walk(path.join(ROOT, 'apps/gateway/src')),
  ...walk(path.join(ROOT, 'packages/core/src')),
];

// ---- the scanners themselves are checked before anything is checked WITH them ----
describe('the scanners find something (a guard that matches nothing passes vacuously)', () => {
  it('walks a realistic number of source files in every workspace', () => {
    expect(walk(path.join(ROOT, 'src')).length).toBeGreaterThan(100);
    expect(walk(path.join(ROOT, 'apps/api/src')).length).toBeGreaterThan(3);
    expect(walk(path.join(ROOT, 'apps/gateway/src')).length).toBeGreaterThan(10);
    expect(walk(path.join(ROOT, 'packages/core/src')).length).toBeGreaterThan(3);
    expect(APP_SOURCES.length).toBeGreaterThan(150);
  });

  it('strips comments and keeps code, on a file that contains both', () => {
    // `apps/gateway/src/config.ts` says at length why nothing in it reads
    // NODE_ENV — in a comment. A raw text scan reports that sentence as a
    // violation of the rule it exists to explain.
    const file = path.join(ROOT, 'apps/gateway/src/config.ts');
    const raw = readFileSync(file, 'utf8');
    const code = codeOf(file);
    expect(raw).toContain('NOTHING in this file reads NODE_ENV');
    expect(code).not.toContain('NOTHING in this file reads NODE_ENV');
    expect(code).toContain('GATEWAY_ALLOWED_JURISDICTIONS');
    expect(code).toContain('export function loadConfig');
    // Offsets are preserved, so a line number from a match still points at
    // the right line of the file on disk.
    expect(code.length).toBe(raw.length);
  });

  it('strips comments in a .tsx file without eating its markup', () => {
    const file = path.join(ROOT, 'src/lib/config.ts');
    expect(codeOf(file)).toContain("import.meta.env.VITE_API_BASE_URL");
    const tsx = walk(path.join(ROOT, 'src')).find(f => f.endsWith('App.tsx'))!;
    const code = codeOf(tsx);
    expect(code).toContain('export');
    expect(code).not.toContain("`openrouter.ts`'s old contract");
  });

  it('the environment-name pattern matches the names the apps actually use', () => {
    const sample = 'API_ISSUER GATEWAY_PORT VITE_OIDC_SCOPE KC_HEALTH_ENABLED OPENAI_API_KEY';
    expect(sample.match(ENV_NAME)).toHaveLength(5);
  });
});

// ---- §18 item 10(a): no module branches on the environment ----
describe('no module branches on the environment (S30)', () => {
  it('nothing reads NODE_ENV, isLocal, or a build-mode flag', () => {
    const offenders: string[] = [];
    for (const file of APP_SOURCES) {
      const code = codeOf(file);
      if (/\bNODE_ENV\b/.test(code)) offenders.push(`${rel(file)} reads NODE_ENV`);
      if (/\bisLocal\b|\bisDev\b|\bisProduction\b/.test(code)) {
        offenders.push(`${rel(file)} branches on the environment`);
      }
      // `src/lib/config.ts` reads `import.meta.env.DEV` for `DEBUG`, and says
      // in its own comment why that is not an exception being taken quietly.
      // It is the one config module for the web app, so it is allowed here
      // for the same reason it is allowed to read `import.meta.env` at all.
      if (CONFIG_MODULES.includes(file)) continue;
      if (/import\.meta\.env\.(DEV|PROD|MODE)\b/.test(code)) {
        offenders.push(`${rel(file)} reads a build-mode flag`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('nothing outside the config modules and the composition roots reads the environment', () => {
    const allowed = new Set([...CONFIG_MODULES, ...COMPOSITION_ROOTS]);
    const offenders: string[] = [];
    for (const file of APP_SOURCES) {
      if (allowed.has(file)) continue;
      const code = codeOf(file);
      if (/process\.env/.test(code)) offenders.push(`${rel(file)} reads process.env`);
      if (/import\.meta\.env/.test(code)) offenders.push(`${rel(file)} reads import.meta.env`);
    }
    expect(offenders).toEqual([]);
  });

  // The exemption cannot grow silently. It is the one part of this guard
  // that can be widened to make a failure go away, so it is the part that
  // most needs a test of its own.
  it('the composition-root exemption is exactly the three entry points', () => {
    expect(COMPOSITION_ROOTS.map(rel).sort()).toEqual([
      'apps/api/src/main.ts',
      'apps/gateway/src/main.ts',
      'apps/gateway/src/smoke.ts',
    ]);
    for (const file of COMPOSITION_ROOTS) expect(existsSync(file), rel(file)).toBe(true);
  });

  // …and each root must genuinely be a pass-through, not a reader. An
  // exemption for "hands the environment to `loadConfig`" must not quietly
  // become an exemption for "reads the environment".
  it('each composition root passes process.env to loadConfig and reads no key itself', () => {
    const offenders: string[] = [];
    for (const file of COMPOSITION_ROOTS) {
      const code = codeOf(file);
      if (!/loadConfig\(\s*process\.env/.test(code)) {
        offenders.push(`${rel(file)} does not hand process.env to loadConfig`);
      }
      if (/process\.env\s*[.[]/.test(code)) {
        offenders.push(`${rel(file)} reads a key off process.env itself`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

// ---- §18 item 10(b): the configuration diff IS the divergence list ----
describe('the configuration diff is exactly §5.1s divergence list (S30)', () => {
  /**
   * Container environment variable names, read from both sides.
   *
   * Both sides are read from the CONTAINER DEFINITIONS — the compose file's
   * `environment:` blocks and the Bicep's container `env:` arrays — because
   * those are the names the applications actually read, which is what §5.1
   * is about. Reading `.env.example` instead would compare host-side
   * interpolation inputs against Azure parameter names, which are two
   * different vocabularies for one value.
   *
   * BUILD ARGUMENTS COUNT TOO, and leaving them out is how the brief's
   * draft of this file ended up listing four VITE_* keys that appeared on
   * neither side. The web app is a Vite SPA: `src/lib/config.ts`'s four
   * values are inlined into the bundle at BUILD time and cannot be set at
   * runtime at all, so `docker-compose.yml`'s `web.build.args` and
   * `azure.yaml`'s `docker.buildArgs` are where the web app's configuration
   * lives in each environment. They are configuration by every property
   * that matters here.
   */
  const composeKeys = (): Map<string, Set<string>> => {
    const text = readFileSync(path.join(ROOT, 'docker-compose.yml'), 'utf8');
    const byService = new Map<string, Set<string>>();
    let service = '';
    let inEnv = false;
    let inArgs = false;
    // Only inside the top-level `services:` block: `networks:` uses the same
    // two-space key shape, and counting `frontend`/`internal`/`egress` as
    // services would make the "every service is named" check below assert a
    // list nobody could read as one.
    let inServices = false;
    for (const line of text.split('\n')) {
      if (/^[a-z][\w-]*:/.test(line)) { inServices = /^services:/.test(line); continue; }
      if (!inServices) continue;
      const svc = /^ {2}([a-z][\w-]*):\s*$/.exec(line);
      if (svc) {
        service = svc[1];
        inEnv = false;
        inArgs = false;
        byService.set(service, byService.get(service) ?? new Set());
        continue;
      }
      if (/^ {4}environment:\s*$/.test(line)) { inEnv = true; inArgs = false; continue; }
      if (/^ {6}args:\s*$/.test(line)) { inArgs = true; inEnv = false; continue; }
      if (inEnv && /^ {0,4}\S/.test(line)) inEnv = false;
      if (inArgs && /^ {0,6}\S/.test(line)) inArgs = false;
      const env = /^ {6}([A-Z][A-Z0-9_]*):/.exec(line);
      if (inEnv && env) byService.get(service)?.add(env[1]);
      const arg = /^ {8}([A-Z][A-Z0-9_]*):/.exec(line);
      if (inArgs && arg) byService.get(service)?.add(arg[1]);
    }
    return byService;
  };

  const deployedKeys = (): Set<string> => {
    // Container Apps env entries are `{ name: 'API_ISSUER', value: … }` or
    // `{ name: 'X', secretRef: … }`. The uppercase-initial pattern is what
    // keeps container names, volume names and secret names ('models-json')
    // out of the set.
    const bicep = readFileSync(path.join(ROOT, 'infra/modules/containerApps.bicep'), 'utf8');
    const keys = new Set(
      [...bicep.matchAll(/name:\s*'([A-Z][A-Z0-9_]*)'/g)].map(m => m[1]),
    );
    const azureYaml = readFileSync(path.join(ROOT, 'azure.yaml'), 'utf8');
    for (const m of azureYaml.matchAll(/^ {8}([A-Z][A-Z0-9_]*):/gm)) keys.add(m[1]);
    return keys;
  };

  const local = composeKeys();
  const localAll = new Set<string>();
  for (const keys of local.values()) for (const k of keys) localAll.add(k);
  const deployed = deployedKeys();
  const tabled = new Set(DIVERGENCE.rows.flatMap(r => r.keys));
  const same = new Set(DIVERGENCE.sameEverywhere);
  const defaulted = new Set(DIVERGENCE.defaultedInBothEnvironments);
  const awaiting = new Set(DIVERGENCE.awaitingAzureTemplate);

  it('reads a non-empty key set from BOTH sides', () => {
    // The check that would have caught the previous version of this file,
    // whose deployed set was always empty and which therefore reported
    // success while asserting half of what it claimed.
    expect(localAll.size).toBeGreaterThan(10);
    expect(deployed.size).toBeGreaterThan(10);
    // And from each side's own halves, so a parser that silently stopped
    // matching one block cannot be mistaken for an environment that stopped
    // setting one.
    expect([...localAll].filter(k => k.startsWith('VITE_'))).toHaveLength(4);
    expect([...deployed].filter(k => k.startsWith('VITE_'))).toHaveLength(4);
    expect([...localAll].filter(k => k.startsWith('KC_')).length).toBeGreaterThan(0);
    expect([...deployed].filter(k => k.startsWith('GATEWAY_ENTRA_')).length).toBeGreaterThan(0);
  });

  it('names every compose service, so a new one cannot arrive unscanned', () => {
    expect([...local.keys()].sort())
      .toEqual(['api', 'azurite', 'gateway', 'keycloak', 'postgres', 'web']);
    for (const service of DIVERGENCE.localOnlyServices) {
      expect(local.has(service), `${service} is named local-only but is not a service`).toBe(true);
    }
  });

  it('every key that differs between the environments is named by a table row', () => {
    const differing = [
      ...[...localAll].filter(k => !deployed.has(k)),
      ...[...deployed].filter(k => !localAll.has(k)),
    ].filter(k => !same.has(k));
    expect(differing.filter(k => !tabled.has(k)).sort()).toEqual([]);
  });

  it('every key present in BOTH environments is a sameEverywhere key, not a tabled one', () => {
    const inBoth = [...localAll].filter(k => deployed.has(k));
    expect(inBoth.filter(k => tabled.has(k)).sort()).toEqual([]);
    expect(inBoth.filter(k => !same.has(k)).sort()).toEqual([]);
  });

  // The half that stops the table rotting into optimism.
  it('every table row has a key behind it, or an explicit reason why not', () => {
    const orphans = DIVERGENCE.rows
      .filter(r => r.keys.length === 0 && !(String(r.n) in DIVERGENCE.rowsWithNoKeys))
      .map(r => `row ${r.n} (${r.what}) names no key and gives no reason`);
    expect(orphans).toEqual([]);
  });

  it('a reason is only given for a row that actually has no key', () => {
    const spurious = Object.keys(DIVERGENCE.rowsWithNoKeys)
      .filter(n => (DIVERGENCE.rows.find(r => String(r.n) === n)?.keys.length ?? 0) > 0);
    expect(spurious).toEqual([]);
  });

  it('every tabled key actually appears in at least one environment', () => {
    const ghosts = [...tabled].filter(k => !localAll.has(k) && !deployed.has(k));
    expect(ghosts.sort()).toEqual([]);
  });

  it('every sameEverywhere key appears in BOTH environments', () => {
    const missing = [...same].filter(k => !localAll.has(k) || !deployed.has(k));
    expect(missing.sort()).toEqual([]);
  });

  /**
   * The names the three configuration modules actually read, over the
   * comment-stripped source — so a name that appears only in prose
   * explaining why it is not read (apps/api/src/config.ts mentions
   * GATEWAY_CALLER_AUTH in exactly that way) does not become a phantom key.
   */
  const declared = new Set<string>();
  for (const file of CONFIG_MODULES) {
    for (const m of codeOf(file).matchAll(ENV_NAME)) declared.add(m[0]);
  }

  it('reads a plausible number of keys out of the configuration modules', () => {
    expect(declared.size).toBeGreaterThan(25);
    expect(declared.has('API_ISSUER')).toBe(true);
    expect(declared.has('VITE_OIDC_SCOPE')).toBe(true);
    expect(declared.has('GATEWAY_ALLOWED_JURISDICTIONS')).toBe(true);
    // Named in a comment in apps/api/src/config.ts and read by nothing there.
    expect(codeOf(path.join(ROOT, 'apps/api/src/config.ts'))).not.toContain('GATEWAY_CALLER_AUTH');
  });

  it('every key a config module reads is classified: tabled, same, defaulted, or awaiting Azure', () => {
    const unclassified = [...declared]
      .filter(k => !tabled.has(k) && !same.has(k) && !defaulted.has(k) && !awaiting.has(k))
      .sort();
    expect(unclassified).toEqual([]);
  });

  /**
   * The fourth classification, added by Task 10 and meant to empty.
   *
   * A key with NO default that is required by one environment's posture and
   * set by neither environment yet — API_BLOB_ACCOUNT_URL, which the Azure
   * deployment needs and which Task 25's Bicep will set. It is not
   * `defaultedInBothEnvironments`: those keys fall back to a value in a
   * config module and are SUPPOSED to be unset, and filing this one there
   * would say the software has an opinion about which storage account holds
   * a firm's documents.
   *
   * The check is the same shape as the defaulted one and for the same
   * reason: an entry that is quietly set by an environment has stopped being
   * this kind of key, and an entry no module reads is a key nobody is going
   * to configure.
   */
  it('every "awaiting the Azure template" key is set by NEITHER environment and read by a module', () => {
    const offenders: string[] = [];
    for (const key of awaiting) {
      if (localAll.has(key)) offenders.push(`${key} is set by docker-compose.yml`);
      if (deployed.has(key)) {
        offenders.push(`${key} is now set by the Azure template — move it into a table row`);
      }
      if (!declared.has(key)) offenders.push(`${key} is read by no configuration module`);
    }
    expect(offenders.sort()).toEqual([]);
  });

  it('every "defaulted in both" key is set by NEITHER environment and read by a module', () => {
    const offenders: string[] = [];
    for (const key of defaulted) {
      if (localAll.has(key)) offenders.push(`${key} is set by docker-compose.yml`);
      if (deployed.has(key)) offenders.push(`${key} is set by the Azure template`);
      if (!declared.has(key)) offenders.push(`${key} is read by no configuration module`);
    }
    expect(offenders.sort()).toEqual([]);
  });

  it('no key is classified twice', () => {
    const dupes: string[] = [];
    for (const key of [...tabled]) {
      if (same.has(key)) dupes.push(`${key} is both tabled and sameEverywhere`);
      if (defaulted.has(key)) dupes.push(`${key} is both tabled and defaulted`);
    }
    for (const key of [...same]) {
      if (defaulted.has(key)) dupes.push(`${key} is both sameEverywhere and defaulted`);
    }
    for (const key of [...awaiting]) {
      if (tabled.has(key)) dupes.push(`${key} is both awaiting the Azure template and tabled`);
      if (same.has(key)) dupes.push(`${key} is both awaiting the Azure template and sameEverywhere`);
      if (defaulted.has(key)) dupes.push(`${key} is both awaiting the Azure template and defaulted`);
    }
    expect(dupes.sort()).toEqual([]);
  });

  /**
   * The one key in this table that NO configuration module reads, and the
   * blind spot it sits in.
   *
   * Every other check in this file works because a configuration module is
   * the only thing that reads the environment (§18 item 10(a)), so the set
   * of keys that matter is knowable by scanning three files.
   * `AZURE_CLIENT_ID` breaks that assumption, and it is the only key that
   * does: `apps/api/src/blob/store.ts` constructs
   * `new DefaultAzureCredential()` with no options, and the managed-identity
   * leg of that chain resolves a USER-ASSIGNED identity's client id from
   * `process.env.AZURE_CLIENT_ID` and from nowhere else (@azure/identity
   * 4.13.1, `createDefaultManagedIdentityCredential`). The api Container App
   * has a user-assigned identity and no system-assigned one, so without that
   * variable set, every document byte read and write fails in Azure — with
   * every unit test in this repository green, because nothing in this
   * repository reads the key.
   *
   * That is the deployment-only failure this suite exists to catch a class
   * of, and the classification checks above cannot see it: the key is not
   * `declared` by any config module, so "every key a config module reads is
   * classified" passes whether it is set or not. Two assertions instead,
   * pinned to the two facts that make it necessary:
   *
   *  1. The Azure template sets it. Deleting the line fails here.
   *  2. `store.ts` still takes the no-options constructor. If someone later
   *     passes an explicit `managedIdentityClientId`, the ENVIRONMENT
   *     VARIABLE stops being the mechanism, and this test should be the
   *     thing that says so rather than a key quietly outliving its reason.
   */
  it('AZURE_CLIENT_ID is set by the Azure template, because the credential chain reads it and no config module does', () => {
    expect(deployed.has('AZURE_CLIENT_ID')).toBe(true);
    expect(tabled.has('AZURE_CLIENT_ID')).toBe(true);
    // Not local: Azurite authenticates by connection string, and there is no
    // managed identity on a laptop to name.
    expect(localAll.has('AZURE_CLIENT_ID')).toBe(false);
    // …and it is genuinely invisible to the config-module scan, which is the
    // reason this test exists rather than being covered by the ones above.
    expect(declared.has('AZURE_CLIENT_ID')).toBe(false);

    const store = codeOf(path.join(ROOT, 'apps/api/src/blob/store.ts'));
    expect(store).toContain('new DefaultAzureCredential()');
    expect(store).not.toContain('managedIdentityClientId');
  });

  // P4 / owner decision 5, asserted here as well as in `stage1DoD`, both
  // through ONE shared predicate.
  it('GATEWAY_ALLOWED_JURISDICTIONS is the same-everywhere kind, and is defaulted nowhere', () => {
    expect(same.has('GATEWAY_ALLOWED_JURISDICTIONS')).toBe(true);
    expect(tabled.has('GATEWAY_ALLOWED_JURISDICTIONS')).toBe(false);
    expect(defaulted.has('GATEWAY_ALLOWED_JURISDICTIONS')).toBe(false);
    expect(jurisdictionDefaultOffenders(ROOT)).toEqual([]);
  });

  it('the jurisdiction predicate reads every home the value could live in', () => {
    for (const home of JURISDICTION_HOMES) {
      expect(existsSync(path.join(ROOT, home)), home).toBe(true);
    }
  });
});

export { CONFIG_MODULES, COMPOSITION_ROOTS };
