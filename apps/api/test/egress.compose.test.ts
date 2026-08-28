import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';

/**
 * Exercises §5's central claim — `api` has no route to the public internet —
 * as a NETWORK FACT against the real compose stack, not as a code review of
 * `gatewayClient.ts`. Excluded from the default `api` vitest project (Task 1)
 * and run only by `npm run test:compose`, because it shells out to
 * `docker compose exec` and must never make `npx vitest run` depend on a
 * Docker daemon being present. See `vitest.compose.config.ts`.
 *
 * Requires `npm run compose:up` to already be running the stack.
 */
const inApi = (script: string): { code: number; out: string } => {
  try {
    const out = execFileSync('docker', [
      'compose', 'exec', '-T', 'api', 'node', '-e', script,
    ], { encoding: 'utf8', timeout: 30_000 });
    return { code: 0, out };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
};

describe('apps/api cannot egress (S1, §18.7)', () => {
  it('CANNOT reach a model provider directly', () => {
    const r = inApi(
      "fetch('https://api.openai.com/v1/models',{signal:AbortSignal.timeout(8000)})"
      + ".then(res=>{console.log('REACHED '+res.status);process.exit(9)})"
      + ".catch(e=>{console.log('BLOCKED '+e.message);process.exit(0)})",
    );
    expect(r.out).toContain('BLOCKED');
    expect(r.out).not.toContain('REACHED');
  });

  it('CANNOT reach the public internet at all', () => {
    const r = inApi(
      "fetch('https://example.com',{signal:AbortSignal.timeout(8000)})"
      + ".then(()=>{console.log('REACHED');process.exit(9)})"
      + ".catch(e=>{console.log('BLOCKED '+e.message);process.exit(0)})",
    );
    expect(r.out).toContain('BLOCKED');
  });

  // The other half: a test that only proves api is offline would pass with
  // the whole stack unplugged and prove nothing.
  it('CAN reach the gateway', () => {
    const r = inApi(
      "const t=require('node:tls');const s=t.connect({host:'gateway',port:8081,"
      + "rejectUnauthorized:false},()=>{console.log('REACHED');s.end();process.exit(0)});"
      + "s.on('error',e=>{console.log('BLOCKED '+e.message);process.exit(9)});",
    );
    expect(r.out).toContain('REACHED');
  });

  it('and the gateway CAN reach the internet, so the block is api-specific', () => {
    let out = '';
    try {
      out = execFileSync('docker', ['compose', 'exec', '-T', 'gateway', 'node', '-e',
        "fetch('https://example.com',{signal:AbortSignal.timeout(8000)})"
        + ".then(()=>{console.log('REACHED')}).catch(e=>{console.log('BLOCKED '+e.message)})",
      ], { encoding: 'utf8', timeout: 30_000 });
    } catch (err) { out = String((err as { stdout?: string }).stdout ?? ''); }
    expect(out).toContain('REACHED');
  });
});
