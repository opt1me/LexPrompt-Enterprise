import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { SERVICE_CONFIG_HINT } from '@lexprompt/core';

const SRC = path.resolve(__dirname, '../src');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith('.ts')) out.push(full);
  }
  return out;
}

/**
 * Returns every `new ModelError( ... )` expression in `code`, as source
 * text, by matching parentheses. A regex cannot do this: the messages
 * inside are multi-line template concatenations containing their own
 * brackets, and `[^)]*` stops at the first `)` in `(${err.message})`.
 */
function modelErrorCalls(code: string): string[] {
  const calls: string[] = [];
  const marker = 'new ModelError(';
  let from = 0;
  for (;;) {
    const start = code.indexOf(marker, from);
    if (start === -1) return calls;
    let depth = 0;
    let i = start + marker.length - 1;
    for (; i < code.length; i++) {
      if (code[i] === '(') depth++;
      else if (code[i] === ')') {
        depth--;
        if (depth === 0) break;
      }
    }
    calls.push(code.slice(start, i + 1));
    from = i + 1;
  }
}

/**
 * M3's absent guard, written so the next `service_misconfigured` cannot
 * arrive without it.
 *
 * `ModelError.code` does NOT survive the findings path — `extractClause`
 * stores only `error.message` — so the browser decides whether a failure is
 * the firm's configuration problem or the user's by matching
 * `SERVICE_CONFIG_HINT` in the sentence (`protocol.ts` explains why that is
 * the mechanism available, and `ResultsView.tsx` is what reads it).
 *
 * There were three producers in the gateway. Two embedded the hint. The
 * third — `audit.ts`'s P3 refusal, the single loudest failure this design
 * has — did not, so the one thing the gateway is proudest of refusing was
 * the thing it reported least clearly: an ordinary retryable error card
 * with a Retry button, refused identically on every retry, telling neither
 * the lawyer nor IT that the firm's log pipe is broken.
 *
 * This is a source scan rather than three behavioural tests on purpose: the
 * defect was a MISSING producer, and a per-producer test cannot fail for a
 * producer nobody wrote one for.
 */
describe('every gateway service_misconfigured names itself as a firm-configuration fault', () => {
  const files = walk(SRC);

  it('finds the gateway source tree, so the scan below is not vacuous', () => {
    expect(files.length).toBeGreaterThan(10);
    expect(files.some(f => f.endsWith('audit.ts'))).toBe(true);
    expect(files.some(f => f.endsWith('callModel.ts'))).toBe(true);
  });

  it('embeds SERVICE_CONFIG_HINT in every message that carries the code', () => {
    const offenders: string[] = [];
    let found = 0;
    for (const file of files) {
      const code = readFileSync(file, 'utf8');
      for (const call of modelErrorCalls(code)) {
        if (!call.includes("'service_misconfigured'")) continue;
        found++;
        if (!call.includes('SERVICE_CONFIG_HINT')) {
          offenders.push(path.relative(SRC, file));
        }
      }
    }
    // Anti-vacuity: the scan must actually be finding producers. Three
    // today — callModel.ts, credentials/resolve.ts, audit.ts.
    expect(found).toBeGreaterThanOrEqual(3);
    expect(offenders).toEqual([]);
  });
});
