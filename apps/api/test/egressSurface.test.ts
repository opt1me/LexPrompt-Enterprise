import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { ROOT, walk, codeOf, rel } from './sourceScan.ts';

/**
 * M3: `gatewayClient.ts` used to open with "The ONLY outbound client in this
 * service", and add that "a second `fetch` anywhere in `apps/api` is a
 * defect, and Task 24's egress test is what catches it if review does not".
 *
 * All three halves of that were false in the same commit range. `oidc.ts`
 * calls a plain global `fetch`; `createRemoteJWKSet` installs a third client
 * that keeps fetching for the life of the process; and
 * `egress.compose.test.ts` measures whether the CONTAINER can reach the
 * internet, which the `internal` network enforces for every client equally —
 * it cannot tell one outbound client from four and would pass unchanged if
 * someone added a fifth.
 *
 * This is the scan that was claimed and did not exist. It does not forbid
 * egress — `apps/api` must reach an identity provider, and in Azure that is
 * `login.microsoftonline.com` on the public internet. It forbids an
 * UNDECLARED one: every outbound call in this service is named here, so
 * adding a fourth is a decision someone has to write down rather than
 * something a reviewer has to notice.
 */

const SRC = path.resolve(__dirname, '../src');

/** Where each outbound client is allowed to live, and what it is for. */
const DECLARED_EGRESS: { file: string; why: string }[] = [
  {
    file: 'apps/api/src/gatewayClient.ts',
    why: 'every call to the gateway — undici `request`, over the internal network',
  },
  {
    file: 'apps/api/src/oidc.ts',
    why: 'the issuer discovery document at startup (`fetch`), and jose\'s '
      + '`createRemoteJWKSet`, which refetches the JWKS on its own schedule',
  },
];

describe('every outbound client in apps/api is declared (M3)', () => {
  const files = walk(SRC);

  it('scans the real source, so it cannot pass vacuously', () => {
    expect(files.length).toBeGreaterThan(4);
    for (const { file } of DECLARED_EGRESS) {
      expect(files.map(rel), file).toContain(file);
    }
  });

  it('no file outside the declared two makes an outbound call', () => {
    const allowed = new Set(DECLARED_EGRESS.map(e => e.file));
    const offenders: string[] = [];
    for (const file of files) {
      if (allowed.has(rel(file))) continue;
      const code = codeOf(file);
      // Comment-stripped (`codeOf`), so the paragraph in `gatewayClient.ts`
      // explaining what the three clients ARE is not itself a violation —
      // the failure mode `sourceScan.ts`'s docstring describes, and the one
      // that would otherwise push the next person to exempt a file.
      if (/\bfetch\s*\(/.test(code)) offenders.push(`${rel(file)} calls fetch()`);
      if (/\bcreateRemoteJWKSet\b/.test(code)) {
        offenders.push(`${rel(file)} installs a remote JWKS client`);
      }
      if (/from 'undici'/.test(code)) offenders.push(`${rel(file)} imports undici`);
      if (/from 'node:https?'/.test(code)) offenders.push(`${rel(file)} imports node http`);
    }
    expect(offenders.sort()).toEqual([]);
  });

  it('each declared file still holds the client it is declared for', () => {
    // The other half of the same rule: a declaration nothing backs is a list
    // of good intentions, and this file's whole point is that the previous
    // claim was one.
    const gateway = codeOf(path.join(SRC, 'gatewayClient.ts'));
    expect(gateway).toMatch(/from 'undici'/);
    const oidc = codeOf(path.join(SRC, 'oidc.ts'));
    expect(oidc).toMatch(/\bfetch\s*\(/);
    expect(oidc).toMatch(/\bcreateRemoteJWKSet\b/);
  });

  it('the docstring no longer claims apps/api has exactly one outbound client', () => {
    // The specific false sentence, named so it cannot come back by a
    // copy-paste from an older revision.
    const raw = codeOf(path.join(SRC, 'gatewayClient.ts'));
    expect(raw).not.toContain('The ONLY outbound client');
  });
});

/**
 * m13: `withActor` is correct and both routes call it — but "both routes
 * that exist happen to call it" is not a rule, and the actor overwrite is
 * the single thing standing between a client and a colleague's name on every
 * entry in the firm's audit log.
 */
describe('every route that forwards a body applies the actor overwrite (m13)', () => {
  /**
   * A route module that FORWARDS to the gateway, identified by the client it
   * has to hold to do so.
   *
   * This was `posts.length > 0` until Task 11, when the first `app.post`
   * that forwards nothing arrived (`POST /v1/documents` stores bytes and
   * writes a row; it reaches no gateway, so there is no outbound body for
   * `withActor` to correct). Widening the rule to every POST would have
   * meant either an exemption list or a `withActor` call on a route with
   * nothing to overwrite — both of which weaken a guard whose subject is
   * narrow and real: the actor on a body this API sends ONWARD.
   *
   * The rule for the other POSTs is not dropped; it is a different rule and
   * it is asserted below. Attribution comes from `req.actor`, never from the
   * body — property 3 of `matters.ts`'s pattern. The two together cover
   * every route, and neither covers the other's case.
   */
  const forwardsToGateway = (code: string): boolean => /\bGatewayClient\b/.test(code);

  it('every gateway-forwarding app.post under src/routes references withActor', () => {
    const offenders: string[] = [];
    for (const file of walk(path.join(SRC, 'routes'))) {
      const code = codeOf(file);
      const posts = [...code.matchAll(/app\.post\(\s*'([^']+)'/g)].map(m => m[1]);
      if (posts.length === 0 || !forwardsToGateway(code)) continue;
      if (!/\bwithActor\s*\(/.test(code)) {
        offenders.push(`${rel(file)} registers ${posts.join(', ')} without withActor`);
      }
    }
    expect(offenders).toEqual([]);
  });

  /**
   * A module that actually REGISTERS routes.
   *
   * Narrowed in Task 19, when `routes/` gained its first two modules that
   * register nothing: `ingest.ts` (the multipart read and the blob-first
   * write order, shared by the matter and precedent uploads) and
   * `matterMembership.ts` (the refusal a review target and a collection
   * member share). Both take `ws: string` as a PARAMETER from a caller that
   * did read `req.actor` — there is no `req` in either to read one from —
   * so requiring them to name it would mean either an exemption list or a
   * meaningless reference, both of which weaken a guard whose subject is
   * narrow and real.
   *
   * Nothing is lost by the narrowing, and the reason is worth writing down:
   * a helper that scoped nothing would still be caught by
   * `workspaceScope.test.ts`, which scans EVERY file under `routes/` and
   * requires a `workspace_id` predicate on every statement — including these
   * two. This guard is about where the value comes from; that one is about
   * whether it is used.
   */
  const registersRoutes = (code: string): boolean =>
    /\bapp\.(?:get|post|put|patch|delete)\s*\(/.test(code);

  it('every route module reads its workspace and its attribution from req.actor', () => {
    // The companion rule, covering the POSTs the check above deliberately
    // does not: a route module that never reads `req.actor` scopes nothing
    // and attributes nothing, and it fails by showing another firm's records
    // rather than by throwing.
    const offenders: string[] = [];
    for (const file of walk(path.join(SRC, 'routes'))) {
      const code = codeOf(file);
      if (!registersRoutes(code)) continue;
      // Both spellings the codebase actually uses: `req.actor!` in the
      // repository routes, `request.actor as Actor` in the two forwarding
      // ones. Matching the property rather than one call site's variable
      // name, so a rename cannot silently empty this check.
      if (!/\b(?:req|request)\.actor\b/.test(code)) {
        offenders.push(`${rel(file)} never reads req.actor`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the narrowing skips only modules that register nothing, and it skips some', () => {
    // A guard that quietly started skipping every file would pass the check
    // above vacuously. So both sides are named: which modules are checked,
    // and which are not and why.
    const checked: string[] = [];
    const skipped: string[] = [];
    for (const file of walk(path.join(SRC, 'routes'))) {
      (registersRoutes(codeOf(file)) ? checked : skipped).push(rel(file));
    }
    expect(checked.length).toBeGreaterThan(5);
    expect(skipped).toEqual([
      'apps/api/src/routes/ingest.ts',
      'apps/api/src/routes/matterMembership.ts',
    ]);
    // …and each skipped module takes the workspace it scopes by as an
    // argument, which is the only reason it has no `req.actor` to read.
    for (const file of skipped) {
      expect(codeOf(path.join(ROOT, file))).toMatch(/\bws\s*:\s*string\b/);
    }
  });

  it('finds the routes it is checking', () => {
    const posts: string[] = [];
    for (const file of walk(path.join(SRC, 'routes'))) {
      const code = codeOf(file);
      if (!forwardsToGateway(code)) continue;
      for (const m of code.matchAll(/app\.post\(\s*'([^']+)'/g)) posts.push(m[1]);
    }
    expect(posts.sort()).toEqual(['/v1/infer', '/v1/infer/stream']);
  });
});
