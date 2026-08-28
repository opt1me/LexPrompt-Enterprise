import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const ADAPTERS = path.resolve(__dirname, '../src/adapters');

const files = (): string[] => readdirSync(ADAPTERS)
  .map(e => path.join(ADAPTERS, e))
  .filter(f => statSync(f).isFile() && f.endsWith('.ts'));

/**
 * Strips `//` and `/* *\/` comments (string- and template-literal aware) so
 * the boundary checks below scan CODE, not prose. Without this, `types.ts`'s
 * own doc comment explaining *why* `isRetryableStatus` and `callModel.ts`
 * belong elsewhere trips the very regexes meant to forbid them in code — a
 * real bug caught running the brief's reference `adapterBoundary.test.ts`
 * verbatim: it failed 3 of 4 cases against the Step 3/4/6 code the same
 * brief specifies, on `types.ts`'s and `openrouter.ts`'s own commentary.
 */
function stripComments(text: string): string {
  let out = '';
  let i = 0;
  let inLine = false, inBlock = false, quote: '"' | "'" | '`' | null = null;
  while (i < text.length) {
    const c = text[i];
    const next = text[i + 1];
    if (inLine) {
      if (c === '\n') { inLine = false; out += c; }
      i++;
      continue;
    }
    if (inBlock) {
      if (c === '*' && next === '/') { inBlock = false; i += 2; continue; }
      i++;
      continue;
    }
    if (quote) {
      out += c;
      if (c === '\\') { out += next ?? ''; i += 2; continue; }
      if (c === quote) quote = null;
      i++;
      continue;
    }
    if (c === '/' && next === '/') { inLine = true; i += 2; continue; }
    if (c === '/' && next === '*') { inBlock = true; i += 2; continue; }
    if (c === '"' || c === "'" || c === '`') { quote = c; out += c; i++; continue; }
    out += c;
    i++;
  }
  return out;
}

/**
 * S25: an adapter owns credential shaping, request shaping, response
 * parsing, stream-frame decoding and error classification — and NOTHING
 * else. The allowlist check, the jurisdiction check, the purpose check,
 * budgets, the prompt cap, the timeout, the retry policy and the call log
 * live in the gateway core and run once, around every adapter.
 *
 * An adapter that logs, or checks an allowlist, is not a working adapter
 * with an extra feature; it is the defect.
 */
const FORBIDDEN = [
  'audit', 'allowlist', 'rateLimit', 'callModel', 'config', 'callerAuth',
];

/**
 * Whether `code` (already comment-stripped) contains a VALUE import from
 * `../mod` — as opposed to a type-only one.
 *
 * `config` is a deliberate, permitted exception in ONE direction only:
 * `adapters/types.ts` imports `ModelEntry` — a type, part of `AdapterRequest`
 * itself — from `../config.ts`, and that is not the "adapter reaches into
 * gateway-core configuration" defect this test exists to catch. What IS
 * still forbidden is an adapter importing `loadConfig`, `ConfigError`, or
 * any other VALUE from `config.ts` — reading configuration itself rather
 * than being handed the one type it is shaped by.
 */
function importsValueFrom(code: string, mod: string): boolean {
  const re = new RegExp(
    `import\\s+(type\\s+)?\\{([^}]*)\\}\\s+from\\s+['"]\\.\\./${mod}(?:\\.ts)?['"]`
    + `|import\\s+(type\\s+)?(\\*\\s+as\\s+\\w+|\\w+)\\s+from\\s+['"]\\.\\./${mod}(?:\\.ts)?['"]`,
    'g',
  );
  let m: RegExpExecArray | null;
  while ((m = re.exec(code))) {
    if (m[1] || m[3]) continue; // `import type ...` — permitted
    if (m[2] !== undefined) {
      const specifiers = m[2].split(',').map(s => s.trim()).filter(Boolean);
      if (specifiers.length > 0 && specifiers.every(s => /^type\s+/.test(s))) continue;
    }
    return true;
  }
  return false;
}

describe('adapterBoundary (S25)', () => {
  it('no adapter imports a gateway-core concern', () => {
    const offenders: string[] = [];
    for (const file of files()) {
      const code = stripComments(readFileSync(file, 'utf8'));
      for (const mod of FORBIDDEN) {
        if (mod === 'config') {
          if (importsValueFrom(code, mod)) {
            offenders.push(path.basename(file) + ' imports a VALUE from ../config');
          }
          continue;
        }
        if (code.includes("from '../" + mod)) {
          offenders.push(path.basename(file) + ' imports ../' + mod);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('no adapter reads the environment — configuration arrives as an argument', () => {
    const offenders: string[] = [];
    for (const file of files()) {
      if (/process\.env/.test(stripComments(readFileSync(file, 'utf8')))) {
        offenders.push(path.basename(file) + ' reads process.env');
      }
    }
    expect(offenders).toEqual([]);
  });

  it('no adapter implements a retry, a budget, a jurisdiction check or a log write', () => {
    const checks: [RegExp, string][] = [
      [/\bMAX_ATTEMPTS\b|for\s*\(\s*let attempt/, 'a retry loop'],
      [/isRetryableStatus/, 'the retry policy'],
      [/AuditLogger|kind: 'call\./, 'a log write'],
      [/allowedJurisdictions/, 'a jurisdiction check'],
      [/RateLimiter|budget_exhausted/, 'a budget check'],
    ];
    const offenders: string[] = [];
    for (const file of files()) {
      const code = stripComments(readFileSync(file, 'utf8'));
      for (const [pattern, what] of checks) {
        if (pattern.test(code)) offenders.push(path.basename(file) + ' contains ' + what);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the interface still records exactly what an adapter owns', () => {
    const types = readFileSync(path.join(ADAPTERS, 'types.ts'), 'utf8');
    for (const member of ['buildCall', 'readResponse', 'decodeEvent', 'credential: ResolvedCredential']) {
      expect(types).toContain(member);
    }
  });
});
