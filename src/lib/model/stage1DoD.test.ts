import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import * as ts from 'typescript';
// Both extracted rather than written a second time — this project's own rule
// is "when you find yourself writing a second copy, extract it then", and
// `configSurface` (apps/api) needs the same scanners.
import { ROOT, walk, rel, codeOf } from '../../../apps/api/test/sourceScan.ts';
import { jurisdictionDefaultOffenders } from '../../../apps/api/test/jurisdictionDefault.ts';

/**
 * Stage 1's definition of done (§18.2), as a suite that fails when any of it
 * stops being true.
 *
 * §18 says "searched for, not assumed" four times, so every assertion below
 * is a search over the shipped source rather than a restatement of an
 * intention. Two consequences follow, and both are deliberate:
 *
 *  - The searches run over COMMENT-STRIPPED source (`codeOf`). This codebase
 *    explains its own rules at length in prose — why nothing reads
 *    `process.env`, why the app does not use MSAL, why `storage.ts` deletes
 *    an `apiKey` — and a raw text scan reports every one of those notes as a
 *    violation of the rule it exists to explain. Faced with that, an
 *    executor either relaxes the pattern until it stops biting or exempts
 *    the file, and both end with a guard that no longer searches for the
 *    thing it names.
 *  - Where an exemption is genuinely needed, it is ONE NAMED FILE and the
 *    list is asserted to be exactly that file. A guard whose exemption list
 *    can grow silently is a guard that reports whatever is convenient.
 */

const CLIENT_FILES = walk(path.join(ROOT, 'src')).filter(f => !f.endsWith('stage1DoD.test.ts'));
const API_FILES = walk(path.join(ROOT, 'apps/api/src'));
const GATEWAY_FILES = walk(path.join(ROOT, 'apps/gateway/src'));
const ADAPTERS = `${path.sep}adapters${path.sep}`;

describe('the sweep scans something (a guard that matches nothing passes vacuously)', () => {
  it('finds the browser, api and gateway source trees', () => {
    expect(CLIENT_FILES.length).toBeGreaterThan(100);
    expect(API_FILES.length).toBeGreaterThan(3);
    expect(GATEWAY_FILES.length).toBeGreaterThan(10);
    expect(GATEWAY_FILES.filter(f => f.includes(ADAPTERS)).length).toBeGreaterThan(4);
  });

  it('finds the files this suite makes claims about', () => {
    for (const file of [
      'src/lib/storage.ts', 'src/lib/privacyCopy.ts', 'src/types.ts',
      'src/lib/model/gatewayModelClient.ts', 'src/lib/auth/oidc.ts',
      'apps/gateway/src/audit.ts', 'apps/gateway/src/callModel.ts',
      'apps/gateway/src/config.ts', 'README.md',
    ]) {
      expect(existsSync(path.join(ROOT, file)), file).toBe(true);
    }
  });
});

describe('Stage 1 definition of done (§18.2)', () => {
  // ---- no user-supplied key exists anywhere in the browser ----

  it('src/lib/openrouter.ts is gone, and nothing in the browser imports it', () => {
    expect(existsSync(path.join(ROOT, 'src/lib/openrouter.ts'))).toBe(false);
    const offenders: string[] = [];
    for (const file of CLIENT_FILES) {
      for (const m of codeOf(file).matchAll(/from\s+['"]([^'"]+)['"]/g)) {
        if (/(^|\/)openrouter(\.ts)?$/.test(m[1])) offenders.push(`${rel(file)} imports ${m[1]}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  /**
   * `storage.ts` is the ONE file allowed to name `apiKey` in code, because
   * its job is to delete one: a key typed last week does not vanish when the
   * field does, and "never delete what you cannot read" is about the user's
   * work, not about a credential no code path can use any more.
   */
  const API_KEY_PURGE = 'src/lib/storage.ts';

  it('no browser file holds or sends an apiKey — only the one that deletes it', () => {
    const offenders: string[] = [];
    for (const file of CLIENT_FILES) {
      const code = codeOf(file);
      if (/\bapiKey\b/.test(code) && rel(file) !== API_KEY_PURGE) {
        offenders.push(`${rel(file)} names apiKey in code`);
      }
      // A key-shaped literal, in code OR in a comment: a real credential
      // pasted into either is a credential in the repository.
      if (/\bsk-[a-zA-Z0-9]{4}/.test(readFileSync(file, 'utf8'))) {
        offenders.push(`${rel(file)} contains a key-shaped literal`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the apiKey exemption is exactly the purge path, and it purges', () => {
    const code = codeOf(path.join(ROOT, API_KEY_PURGE));
    expect(code).toMatch(/delete\s+stored\.apiKey/);
    expect(code).not.toMatch(/return[^\n]*\bapiKey\b/);
  });

  it('Settings carries no apiKey field, and (Stage 2 Task 18) no longer carries modelChoiceId either', () => {
    // Non-greedy up to the FIRST `}` rather than a `\n}` on its own line:
    // Task 18 emptied `Settings` down to `export interface Settings {}`,
    // written on one line, which the old two-line-only pattern would not
    // match at all — a `block` of `null` reads as "the interface was not
    // found", which is the loud failure this scan wants on a rewrite that
    // moves it, not a silent false negative.
    const types = readFileSync(path.join(ROOT, 'src/types.ts'), 'utf8');
    const block = /export interface Settings \{([\s\S]*?)\}/.exec(types);
    expect(block, 'the Settings interface was not found — this scan proves nothing').toBeTruthy();
    expect(block![1]).not.toMatch(/\bapiKey\b/);
    // Task 18 moved every field `Settings` had — `modelChoiceId` chief among
    // them — to `WorkspaceSettings` (`packages/core/src/api/records.ts`),
    // server-side configuration an admin sets, not a per-browser preference.
    // The interface stays (rather than being deleted) for the one purge job
    // `storage.ts` still has, but it is EMPTY now — this is the sanity check
    // that it stayed that way rather than silently reacquiring the fields
    // that moved, replacing the old "scan really looked at the interface"
    // check now that there is nothing left inside it to look for.
    expect(block![1].trim()).toBe('');
    const core = readFileSync(path.join(ROOT, 'packages/core/src/api/records.ts'), 'utf8');
    expect(core).toContain('modelChoiceId');
  });

  /**
   * `privacyCopy.ts` is the ONE file allowed to name openrouter.ai, and only
   * as the revocation notice: deleting a key from a browser is not revoking
   * it, so the copy has to leave a reader in no doubt that the credential
   * still exists at OpenRouter until they go and kill it themselves.
   */
  const REVOCATION_NOTICE = 'src/lib/privacyCopy.ts';

  it('openrouter.ai survives in the browser only as the revoke-your-key notice', () => {
    const offenders = CLIENT_FILES
      .filter(f => rel(f) !== REVOCATION_NOTICE)
      .filter(f => /openrouter\.ai/.test(codeOf(f)))
      .map(rel);
    expect(offenders).toEqual([]);
    const notice = codeOf(path.join(ROOT, REVOCATION_NOTICE));
    expect(notice).toContain('API_KEY_PURGED_NOTICE');
    expect(notice).toMatch(/href:\s*'https:\/\/openrouter\.ai\/keys'/);
  });

  /**
   * A request to any host outside the app's own API is an egress path the
   * gateway does not see — and `fetch` is not the only way to make one.
   *
   * This scanner used to be a single `fetch(` pattern under a sentence that
   * claimed to cover every direct call to an external host. It did not:
   * `new EventSource(...)`, `new WebSocket(...)`,
   * `navigator.sendBeacon(...)`, `new Image().src = ...`, a bare
   * `XMLHttpRequest` and an `<img src="https://...">` all reach a third
   * party and none of them matched. That gap is the "correct mechanism with
   * no path to it" defect: a guard reporting green over a sentence wider
   * than the check underneath it.
   *
   * Each pattern is self-tested below against a string it MUST bite, so a
   * regex edited into uselessness fails here rather than passing silently.
   */
  const EGRESS_PATTERNS: { name: string; re: RegExp; bitesOn: string }[] = [
    {
      name: 'fetch to a literal external URL',
      re: /fetch\(\s*(?:new URL\(\s*)?['"`]https?:\/\/[^'"`]+/g,
      bitesOn: 'await fetch("https://api.openai.com/v1")',
    },
    {
      name: 'EventSource / WebSocket',
      re: /new\s+(?:EventSource|WebSocket)\s*\(/g,
      bitesOn: 'const es = new EventSource("https://example.com/stream")',
    },
    {
      name: 'navigator.sendBeacon',
      re: /sendBeacon\s*\(/g,
      bitesOn: 'navigator.sendBeacon(url, blob)',
    },
    {
      name: 'XMLHttpRequest',
      re: /XMLHttpRequest/g,
      bitesOn: 'const xhr = new XMLHttpRequest()',
    },
    {
      name: 'an element pointed at an external URL (src/href/action)',
      re: /(?:src|action)\s*[=:]\s*\{?\s*['"`]https?:\/\/[^'"`]+/g,
      bitesOn: '<img src="https://tracker.example.com/pixel.gif" />',
    },
  ];

  it('every egress pattern this suite scans for actually bites', () => {
    for (const { name, re, bitesOn } of EGRESS_PATTERNS) {
      re.lastIndex = 0;
      expect(bitesOn.match(re), name).toHaveLength(1);
    }
  });

  it('every model call in the browser goes through the gateway client', () => {
    const offenders: string[] = [];
    for (const file of CLIENT_FILES) {
      const code = codeOf(file);
      for (const { name, re } of EGRESS_PATTERNS) {
        re.lastIndex = 0;
        const m = code.match(re);
        if (m) offenders.push(`${rel(file)}: ${name} — ${m.join(', ')}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('no MODEL-PROVIDER credential of any kind exists in apps/api', () => {
    const patterns = [
      /\bapiKey\b/, /\bAPI_KEY\b/, /\bsk-[a-zA-Z0-9]{4}/, /\bx-api-key\b/,
      /OPENAI_API_KEY|ANTHROPIC_API_KEY|OPENROUTER_API_KEY/,
      /KeyVault|SecretClient/,
    ];
    // The scan bites on something.
    expect(patterns.some(p => p.test('const apiKey = 1'))).toBe(true);
    const offenders: string[] = [];
    for (const file of API_FILES) {
      const code = codeOf(file);
      for (const pattern of patterns) {
        if (pattern.test(code)) offenders.push(`${rel(file)} matches ${pattern}`);
      }
    }
    expect(offenders).toEqual([]);
    // …and no provider key reaches apps/api's own package manifest either.
    const pkg = readFileSync(path.join(ROOT, 'apps/api/package.json'), 'utf8');
    expect(pkg).not.toContain('@azure/keyvault-secrets');
  });

  /**
   * `DefaultAzureCredential` used to be on the list above, and Stage 2 Task
   * 10 took it off - deliberately, and narrowly.
   *
   * S1/S2 is about MODEL PROVIDER credentials: the gateway is the only
   * service that holds one, and `apps/api` reaching a provider directly is
   * what that pattern list exists to catch. A managed identity for the
   * firm's OWN document store is a different fact - the store is
   * `apps/api`'s to read and write, the credential authenticates nothing
   * outside the firm's own tenant, and 6.5 says in as many words that the
   * bytes are "reachable only through the API's managed identity". Keeping
   * the pattern as written would have made 6.5 unimplementable, and the only
   * ways out would have been to delete the check or to exempt a file.
   *
   * So it is SCOPED rather than removed, and the exemption is asserted to be
   * exactly one file - because a file-level exemption hides everything in
   * that file, not just the part you meant to protect (CLAUDE.md,
   * `PdfCanvas`). The second half below is what keeps that from being a
   * hole: the one permitted file is held to the full provider-credential
   * pattern list, and to holding no other credential machinery.
   */
  it('DefaultAzureCredential appears in exactly one apps/api file, and it is the blob store', () => {
    const holders = API_FILES.filter(f => /DefaultAzureCredential/.test(codeOf(f))).map(rel);
    expect(holders).toEqual(['apps/api/src/blob/store.ts']);
    const code = codeOf(path.join(ROOT, 'apps/api/src/blob/store.ts'));
    // It is a STORAGE credential and nothing else: no Key Vault, no secret
    // client, no api key, no provider key.
    for (const pattern of [/KeyVault/, /SecretClient/, /apiKey/, /x-api-key/,
      /OPENAI_API_KEY|ANTHROPIC_API_KEY|OPENROUTER_API_KEY/]) {
      expect(pattern.test(code), String(pattern)).toBe(false);
    }
    // ...and it reaches a BLOB endpoint, not a model provider.
    expect(code).toContain('BlobServiceClient');
  });

  // ---- one OIDC path, no vendor library, no bypass ----

  it('MSAL is nowhere in the repository (S28)', () => {
    for (const manifest of [
      'package.json', 'apps/api/package.json',
      'apps/gateway/package.json', 'packages/core/package.json',
    ]) {
      expect(readFileSync(path.join(ROOT, manifest), 'utf8'), manifest).not.toContain('msal');
    }
    const offenders = [...CLIENT_FILES, ...API_FILES, ...GATEWAY_FILES]
      .filter(f => /msal/i.test(codeOf(f)))
      .map(rel);
    expect(offenders).toEqual([]);
    // The standards-only client is what is actually used, so this is an
    // absence next to a presence rather than an absence on its own.
    expect(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).toContain('oidc-client-ts');
  });

  it('there is no authentication bypass anywhere (S29)', () => {
    const bypasses = ['SKIP_AUTH', 'DISABLE_AUTH', 'ALLOW_ANONYMOUS', 'AUTH_BYPASS', 'x-trusted-user'];
    const offenders: string[] = [];
    for (const file of [...CLIENT_FILES, ...API_FILES, ...GATEWAY_FILES]) {
      const code = codeOf(file);
      for (const bad of bypasses) {
        if (code.includes(bad)) offenders.push(`${rel(file)} mentions ${bad}`);
      }
    }
    expect(offenders).toEqual([]);
    // Nor in the files that configure those processes.
    for (const config of ['docker-compose.yml', '.env.example', 'infra/modules/containerApps.bicep']) {
      const text = readFileSync(path.join(ROOT, config), 'utf8');
      for (const bad of bypasses) {
        // `.env.example` and the compose file SAY there is no bypass, in
        // prose; what must not appear is one being set.
        expect(text, `${config} sets ${bad}`).not.toMatch(new RegExp(`^\\s*${bad}\\s*[:=]`, 'm'));
      }
    }
  });

  // ---- the jurisdiction gate has no default, in any of its homes ----

  // Owner decision 5 / P4, checked at rest in six places at once. The absence
  // of a default is invisible to every happy-path test — with one restored
  // the gateway still starts, the gate still refuses an undeclared model, the
  // boot banner still prints its table, and nothing looks wrong — which is
  // exactly why it needs a test of its own, and why P4 asks for it twice.
  //
  // The PREDICATE is shared with `configSurface` rather than restated here:
  // two copies of six regexes drifting apart is the failure mode that
  // redundancy would otherwise create, and one function removes it while
  // keeping both call sites.
  it('GATEWAY_ALLOWED_JURISDICTIONS has no default value ANYWHERE', () => {
    expect(jurisdictionDefaultOffenders(ROOT)).toEqual([]);
  });

  // ---- the audit record: unconditional, and content-free ----

  // S26's log-sink clause, held as a ruling (L1) rather than a startup check.
  // The sink is unconditional stdout; the moment a configuration key selects
  // or disables it, this test fails and §10.5's startup refusal has to be
  // written for real.
  it('the audit sink has no configuration surface', () => {
    const gw = codeOf(path.join(ROOT, 'apps/gateway/src/config.ts'));
    const pattern = /\bGATEWAY_[A-Z0-9_]*(?:LOG|SINK)[A-Z0-9_]*\b/g;
    expect('GATEWAY_LOG_SINK'.match(pattern)).toHaveLength(1);
    expect(gw.match(pattern) ?? []).toEqual([]);
    expect(codeOf(path.join(ROOT, 'apps/gateway/src/audit.ts'))).not.toMatch(/process\.env/);
  });

  it('the gateway never logs prompt or completion content', () => {
    const file = path.join(ROOT, 'apps/gateway/src/audit.ts');
    const source = ts.createSourceFile(
      file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

    /** Every property name, and every whole-object spread, in the two audit
     *  record literals — the only two objects that reach the sink. */
    const records = new Map<string, { keys: string[]; spreads: string[] }>();
    const visit = (node: ts.Node): void => {
      if (
        ts.isVariableDeclaration(node) && node.name.getText(source) === 'record'
        && node.type && node.initializer && ts.isObjectLiteralExpression(node.initializer)
      ) {
        const keys: string[] = [];
        const spreads: string[] = [];
        const scan = (obj: ts.ObjectLiteralExpression): void => {
          for (const prop of obj.properties) {
            if (ts.isPropertyAssignment(prop) || ts.isShorthandPropertyAssignment(prop)) {
              keys.push(prop.name.getText(source));
              if (ts.isPropertyAssignment(prop) && ts.isObjectLiteralExpression(prop.initializer)) {
                scan(prop.initializer);
              }
            } else if (ts.isSpreadAssignment(prop)) {
              // `...(x ? { k: v } : {})` contributes its own keys; a spread
              // of anything else copies a caller's object wholesale, which
              // is how content would get in.
              const spread = prop.expression;
              const inner = ts.isParenthesizedExpression(spread) ? spread.expression : spread;
              if (ts.isConditionalExpression(inner)) {
                for (const branch of [inner.whenTrue, inner.whenFalse]) {
                  if (ts.isObjectLiteralExpression(branch)) scan(branch);
                }
              } else {
                spreads.push(spread.getText(source));
              }
            }
          }
        };
        scan(node.initializer);
        records.set(node.type.getText(source), { keys: keys.sort(), spreads });
      }
      node.forEachChild(visit);
    };
    visit(source);

    // The AST walk found both literals — without this the assertions below
    // would pass over an empty map.
    expect([...records.keys()].sort()).toEqual(['AuditFinish', 'AuditStart']);

    // Stage 2, Task 6: `actorUserId` joins the record ALONGSIDE
    // `actorIssuer`/`actorSubject` — an id, never content, and the AST walk
    // above already resolves it through the `...(x ? {k:v} : {})` shape.
    expect(records.get('AuditStart')!.keys).toEqual([
      'actorIssuer', 'actorSubject', 'actorUserId', 'at', 'callId', 'clauseId',
      'credentialSource', 'documentIds', 'imageCount', 'jurisdiction', 'kind',
      'matterId', 'model', 'modelChoiceId', 'promptChars', 'promptSha256',
      'provider', 'purpose', 'reviewId', 'streaming', 'workspaceId',
    ]);
    expect(records.get('AuditFinish')!.keys).toEqual([
      'at', 'callId', 'completionTokens', 'errorCode', 'kind', 'latencyMs', 'ok',
      'promptTokens', 'retries', 'status',
    ]);
    expect(records.get('AuditStart')!.spreads).toEqual([]);
    expect(records.get('AuditFinish')!.spreads).toEqual([]);
    // §10's required fields, named rather than merely "not content".
    for (const required of ['purpose', 'provider', 'model', 'jurisdiction', 'promptSha256']) {
      expect(records.get('AuditStart')!.keys).toContain(required);
    }
  });

  // ---- one adapter interface; no provider knowledge outside it ----

  it('no provider-specific branch exists outside apps/gateway/src/adapters', () => {
    // `recorded` is deliberately branched on outside the adapters — the
    // gateway's config refuses a recorded entry claiming a real jurisdiction,
    // and the picker marks one on screen — because being a fixture replay is
    // a fact about the software rather than a wire protocol. The four below
    // are wire protocols, and knowing one outside an adapter is the
    // duplication the adapter interface exists to prevent.
    const providers = ['anthropic', 'azure-openai', 'azure-foundry', 'openrouter'];
    expect(new RegExp(`===\\s*['"]anthropic['"]`).test("p === 'anthropic'")).toBe(true);
    const scan = [
      ...CLIENT_FILES, ...API_FILES,
      ...GATEWAY_FILES.filter(f => !f.includes(ADAPTERS)),
    ];
    const offenders: string[] = [];
    for (const file of scan) {
      const code = codeOf(file);
      for (const id of providers) {
        if (new RegExp(`===\\s*['"]${id}['"]`).test(code)) {
          offenders.push(`${rel(file)} branches on provider ${id}`);
        }
      }
    }
    expect(offenders).toEqual([]);
    // The registry really does hold more than one adapter, so the absence
    // above is a property of the boundary rather than of an empty tree.
    expect(readdirSync(path.join(ROOT, 'apps/gateway/src/adapters')).length).toBeGreaterThan(4);
  });

  // ---- the README, which is the document a Risk reviewer reads first ----

  const readme = (): string => readFileSync(path.join(ROOT, 'README.md'), 'utf8');

  it('README carries both credential sentences, separately', () => {
    const text = readme();
    expect(text).toContain('No credential ever leaves the gateway');
    expect(text).toContain('no provider keys exist at all');
    // Adjacent and distinct: two paragraphs, not one sentence. Conflating
    // them is how a security claim quietly becomes false for half its
    // deployments, and one sentence is shorter and sounds better, so the
    // pressure to re-merge them is permanent.
    const weak = text.indexOf('No credential ever leaves the gateway');
    const strong = text.indexOf('no provider keys exist at all');
    expect(strong).toBeGreaterThan(weak);
    // Separated by a paragraph break (a blank line, blockquote markers
    // allowed) — not welded into one sentence…
    expect(text.slice(weak, strong)).toMatch(/\r?\n[>\s]*\r?\n/);
    // …and adjacent, not one of them exiled to a footnote elsewhere.
    expect(strong - weak).toBeLessThan(500);
    expect(text).not.toContain('your API key is stored only in your browser');
    expect(text).not.toContain('there is no server for LexPrompt to leak it to');
  });

  it('README no longer tells the reader to get an OpenRouter key', () => {
    const text = readme();
    expect(text).not.toContain('openrouter.ai/keys');
    expect(text).not.toContain('You need an OpenRouter API key');
    expect(text).not.toContain('talks directly to OpenRouter');
    expect(text).not.toContain('every request goes through [OpenRouter]');
  });

  it('README carries §5.1s "what running locally does not prove" list', () => {
    const text = readme();
    for (const phrase of [
      'does not prove',
      'Managed-identity acquisition',
      'group overage',
      'conditional access',
      'Keycloak is not an Entra emulator',
      'Azurite',
    ]) {
      expect(text, phrase).toContain(phrase);
    }
  });

  it('README states the egress claim is proven locally and only expressed in Azure', () => {
    const text = readme();
    // Both halves, each required on its own. An OR would let either half be
    // deleted while the other kept the test green — and the half that would
    // go first is the one saying Azure is unproven, because it is the
    // uncomfortable one.
    expect(text).toContain('enforced and tested under `docker compose`');
    expect(text).toContain('not yet asserted by an automated test');
    expect(text).toContain('not yet a fact about this deployment');
    expect(text).toContain('that is Spike 2');
  });

  it('README does not claim what was never verified', () => {
    const text = readme();
    // The boundary of what was actually driven in a browser, stated rather
    // than implied. An honest "not verified" beats an implied claim.
    for (const phrase of [
      'No credentials were entered',
      'has never been run against a live provider',
      'This has not been deployed',
    ]) {
      expect(text, phrase).toContain(phrase);
    }
    // And no sentence claiming the opposite.
    expect(text).not.toMatch(/verified end to end against (a|the) deployed/i);
    expect(text).not.toContain('recorded from live provider responses');
  });
});
