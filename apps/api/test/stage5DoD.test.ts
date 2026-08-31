import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT, walk, rel, codeOf } from './sourceScan.ts';
import { ROUTE_POLICY } from '../src/auth/routeTable.ts';

/**
 * STAGE 5'S DEFINITION OF DONE — the half a source scan can honestly make.
 *
 * ## The division of labour, and why it matters more here than anywhere
 *
 * Every behavioural claim in this stage is proved by a suite that runs the
 * thing: the `.pg` suites against a real Postgres, the `.compose` suites
 * against the running stack with three real accounts, and `mount.tsx`
 * component tests in jsdom for every rendered string. Restating any of them
 * here would be two suites making one claim, and the weaker copy is always
 * the one that stays green when the property breaks.
 *
 * So this file asserts only what reading the source can settle:
 *
 * 1. that every affordance R-G1 dropped is back **only** where its mechanism
 *    is real, and that the ones with no mechanism are still absent;
 * 2. that the header avatar is still nobody but you;
 * 3. that nothing in this system can notify a person outside it;
 * 4. that every verb `audit_event` can carry has a writer — the check that
 *    would have caught `user.role_changed`, which was declared, rendered and
 *    written by nothing for three stages;
 * 5. that every APPLIED migration is byte-for-byte what it was when it was
 *    applied, which nothing else in this repository checks;
 * 6. that no admin route reached a screen without an entry in `ROUTE_POLICY`,
 *    and that the providers surface still has no write route;
 * 7. and the two things this stage deliberately did NOT do, pinned so they
 *    read as decisions rather than as omissions.
 *
 * ## Every scan has a sanity half
 *
 * Seventeen guards in this project have been found not guarding, and the
 * shape is always the same: a pattern that matches nothing passes every
 * absence assertion written with it. Every `toEqual([])` below is paired
 * with a positive case proving the pattern can see the thing it forbids.
 */

const at = (p: string): string => path.join(ROOT, p);
const WEB_SOURCES = walk(path.join(ROOT, 'src'));
const API_SOURCES = walk(path.join(ROOT, 'apps/api/src'));
const GATEWAY_SOURCES = walk(path.join(ROOT, 'apps/gateway/src'));
const CORE_SOURCES = walk(path.join(ROOT, 'packages/core/src'));
const COMPONENTS = WEB_SOURCES.filter(f => f.endsWith('.tsx'));

function grepRepo(needle: RegExp, sources: string[]): string[] {
  return sources.filter(f => needle.test(codeOf(f))).map(rel).sort();
}

describe('the scanners find something before anything is checked with them', () => {
  it('walks a realistic number of files in every workspace', () => {
    expect(WEB_SOURCES.length).toBeGreaterThan(130);
    expect(API_SOURCES.length).toBeGreaterThan(35);
    expect(GATEWAY_SOURCES.length).toBeGreaterThan(15);
    expect(CORE_SOURCES.length).toBeGreaterThan(15);
    expect(COMPONENTS.length).toBeGreaterThan(45);
    // …and it is reading CODE with its comments removed, which is what makes
    // an absence assertion mean anything in a repository whose comments
    // discuss the things they forbid at length.
    expect(codeOf(at('apps/api/src/audit/actions.ts'))).not.toContain('DELIBERATELY');
    expect(codeOf(at('apps/api/src/audit/actions.ts'))).toContain("'matter.created'");
  });
});

describe('§18 item 6: every R-G1 affordance is back ONLY where its mechanism is real', () => {
  it('ships the four whose mechanism arrived, each at the path it is named by', () => {
    // Each of these was forbidden by a shipped guard until the stage that
    // built the thing underneath it. The mechanism is named beside it.
    for (const [file, mechanism] of [
      ['src/features/assignments/AssigneeChip.tsx', 'the assignment table (Stage 4)'],
      ['src/lib/assignedToMe.ts', 'GET /v1/assignments, the cross-matter inbox'],
      ['src/features/search/SearchPalette.tsx', 'GET /v1/search'],
      ['src/features/review/ReportView.tsx', 'the findings map it already had'],
      ['src/features/admin/RoleMappingPanel.tsx', 'migration 015 and five routes'],
      ['src/features/admin/PeoplePanel.tsx', 'three admin user routes'],
      ['src/features/admin/ProvidersPanel.tsx', 'GET /v1/admin/providers'],
      ['src/features/admin/AuditExportPanel.tsx', 'GET /v1/admin/audit-export'],
    ] as const) {
      expect(existsSync(at(file)), `${file} — ${mechanism}`).toBe(true);
    }
  });

  it('keeps absent every affordance no mechanism ever arrived for', () => {
    /*
     * R-G1 dropped these and nothing in five stages gave any of them a
     * mechanism. They are absent because there is no honest answer to the
     * question each asks in a single-workspace, single-profile app.
     */
    expect(grepRepo(/\bfirmTag\b|\bfirmName\b|firm-tag/i, WEB_SOURCES)).toEqual([]);
    expect(grepRepo(/mobileAssignedTab|AssignedTab/i, WEB_SOURCES)).toEqual([]);
    // S17: `Verification.assigneeId` is retired for good. The chip renders
    // `assigneeUserId` off an `AssignmentView` — a different field on a
    // different record — and the retired one must not come back through a
    // component.
    expect(grepRepo(/\bassigneeId\b/, COMPONENTS)).toEqual([]);
    // The sanity half, on all three patterns.
    expect(/\bfirmTag\b/i.test('const firmTag = 1')).toBe(true);
    expect(/AssignedTab/i.test('<MobileAssignedTab />')).toBe(true);
    expect(/\bassigneeId\b/.test('v.assigneeId')).toBe(true);
    // …and the scan is looking at a populated set: a pattern that DOES occur
    // is found where it occurs.
    expect(grepRepo(/LoadErrorPanel/, COMPONENTS).length).toBeGreaterThan(3);
  });

  it('has one workspace and no per-matter access control, and says so where it matters', () => {
    // S9 and S10, pinned rather than assumed. `GET /v1/search` is the widest
    // read in the system — every matter in the firm, at the `reviewer` bar —
    // and it is correct only for as long as this is true.
    expect(readFileSync(at('apps/api/src/auth/routeTable.ts'), 'utf8'))
      .toMatch(/no per-matter[\s\n/-]+ACLs/i);
    expect(grepRepo(/matter_access/, [...API_SOURCES, ...WEB_SOURCES])).toEqual([]);
    expect(/matter_access/.test('from matter_access a')).toBe(true);
  });
});

describe('the header avatar is still the local profile s own initials', () => {
  it('renders your own initials beside your own label, and resolves nobody else s', () => {
    /*
     * R-G1's one surviving single-user affordance, and the one most likely
     * to be quietly widened: Stage 4 made presence real and this stage made
     * assignment visible, so the app now knows other people's names in
     * several places. None of that is a reason for the avatar in the header
     * to become somebody else's.
     */
    const app = codeOf(at('src/App.tsx'));
    const anchor = app.indexOf('aria-label="Your profile"');
    expect(anchor, 'the header avatar is not where this test thought').toBeGreaterThan(0);
    const button = app.slice(anchor, anchor + 400);
    expect(button).toMatch(/profile\?\.initials \?\? 'ME'/);
    // The id→name resolver is what renders OTHER people (the roster, the
    // feed, the chip). It must not be what renders this.
    expect(button).not.toMatch(/initialsOf|userInitials|userName/);
    // The sanity half: the window would show the resolver if it were there.
    expect(/initialsOf/.test('{initialsOf(m.userId)}')).toBe(true);
  });
});

describe('nothing notifies anybody outside this app (P59)', () => {
  it('holds no mail transport, webhook or outbound notification host, anywhere', () => {
    const everywhere = [...API_SOURCES, ...GATEWAY_SOURCES, ...WEB_SOURCES, ...CORE_SOURCES];
    expect(grepRepo(
      /nodemailer|sendgrid|mailgun|postmark|\bsmtp\b|webhookUrl|teams\.microsoft|hooks\.slack/i,
      everywhere)).toEqual([]);
    // The sanity half, on the pattern that would matter most.
    expect(/nodemailer/i.test("import nodemailer from 'nodemailer'")).toBe(true);
    expect(/webhookUrl/i.test('const webhookUrl = cfg.webhookUrl')).toBe(true);
    // …and no dependency that could do it either, in any workspace.
    for (const pkg of ['package.json', 'apps/api/package.json', 'apps/gateway/package.json']) {
      const deps = Object.keys((JSON.parse(readFileSync(at(pkg), 'utf8')) as {
        dependencies?: Record<string, string>;
      }).dependencies ?? {});
      for (const name of deps) {
        expect(name, `${pkg} depends on ${name}`).not.toMatch(/mail|smtp|twilio|slack/i);
      }
    }
  });

  it('says so on the screen where a request is made, rather than leaving it to be inferred', () => {
    // §17 Q2 is the owner's and is deliberately unanswered. Saying nothing
    // would leave an assigner believing an email went out — which means they
    // have asked nobody and do not know it.
    expect(codeOf(at('src/features/assignments/AssignPanel.tsx')))
      .toContain('Nothing is sent by email or chat.');
  });
});

describe('audit_event: a closed set of verbs, each with a writer (S22)', () => {
  /** The verbs `AUDIT_ACTIONS` declares, read out of its own source. */
  const declared = (): string[] => {
    const code = codeOf(at('apps/api/src/audit/actions.ts'));
    const list = /export const AUDIT_ACTIONS = \[([\s\S]*?)\] as const;/.exec(code);
    expect(list, 'AUDIT_ACTIONS is no longer a literal array this test can read').toBeTruthy();
    return [...list![1]!.matchAll(/'([a-z_]+\.[a-z_]+)'/g)].map(m => m[1]!);
  };

  it('reads the closed set, and it is exactly the nineteen verbs this system can write', () => {
    // A LITERAL LIST rather than one derived from the module, for the reason
    // `caps.test.ts` gives about its own: a set derived from the thing under
    // test agrees with whatever that thing happens to say, and a removal
    // would vanish from both.
    expect(declared()).toEqual([
      'matter.created', 'matter.deleted',
      'document.added', 'document.deleted',
      'playbook.published', 'playbook.imported',
      'review.created', 'review.deleted',
      'run.started', 'run.cancelled',
      'assignment.created', 'assignment.resolved',
      'workspace.settings_changed',
      'role_mapping.created', 'role_mapping.changed', 'role_mapping.removed',
      'user.disabled', 'user.enabled', 'user.pseudonymised',
    ]);
  });

  it('gives every declared verb a WRITER — the check user.role_changed survived for three stages', () => {
    /*
     * `user.role_changed` was in this set from Stage 2, rendered by
     * `MatterActivity.tsx`, and written by nothing at all. Part 5C is where
     * it would have found a writer and it did not, because the fact it names
     * does not exist: nothing in LexPrompt changes a PERSON'S role. It was
     * removed (Task 10) rather than given one.
     *
     * This is the guard that would have noticed. Without it the next dead
     * verb is invisible in exactly the same way — an audit log offering a
     * query that can only ever return nothing.
     */
    const writers = API_SOURCES.filter(f => rel(f) !== 'apps/api/src/audit/actions.ts')
      .map(f => codeOf(f));
    expect(writers.length).toBeGreaterThan(35);
    for (const verb of declared()) {
      expect(
        writers.some(code => code.includes(`'${verb}'`)),
        `${verb} is declared in AUDIT_ACTIONS and written by nothing`,
      ).toBe(true);
    }
    // The retired verb, pinned in both directions: not declared, not
    // written, and its reason recorded where the next reader will look.
    expect(declared()).not.toContain('user.role_changed');
    expect(grepRepo(/user\.role_changed/, [...API_SOURCES, ...WEB_SOURCES, ...CORE_SOURCES]))
      .toEqual([]);
    expect(readFileSync(at('apps/api/src/audit/actions.ts'), 'utf8'))
      .toMatch(/user\.role_changed` IS DELIBERATELY ABSENT/);
  });

  it('holds NO disposition verb, so one fact is recorded in one table', () => {
    for (const verb of declared()) {
      expect(verb, 'a disposition change belongs in finding_disposition_event and nowhere else')
        .not.toMatch(/^finding\.|disposition/);
    }
    expect(/^finding\./.test('finding.verified')).toBe(true);
  });
});

describe('every applied migration is immutable, and nothing else in this repository checks it', () => {
  /*
   * `schema_migration` records a VERSION and an APPLIED-AT and no checksum.
   * So an edit to an already-applied file is silently ignored on every
   * database that has run it and silently applied on every fresh one — two
   * schemas from one repository, with nothing anywhere saying they differ.
   *
   * The hashes below are over the file with CRLF normalised to LF, because
   * `002_records.sql` is checked out with CRLF on this machine and a raw
   * hash would make this guard fail for a reason that has nothing to do with
   * what it is guarding.
   */
  const APPLIED: Record<string, string> = {
    '000_preconditions.sql': '516dc1286fdf4623375e990bbe4310b9f3ea5d83e9ee5d79d3e85cfc45f574da',
    '001_identity.sql': 'e439569b20849e42d496eae9e02fd506a66028e0d0307dd734c8a268b4198eca',
    '002_records.sql': '3a39a62441a8c22861be9a18fd879159032c8d87e06a297616c3af230d62e35f',
    '003_precedent.sql': '663217621b0e027e52bc696543fc9f968aaee12e627af3b6eb6bdc06e345451e',
    '004_position_basis.sql': '1d31d6fcd8fc67ed75a214201300a8965bae346d19b4d47fa74cf45cdb8ecc74',
    '005_findings.sql': '02cbff11a4269766f635e774f2f222b31a850dd03da956cd3ae18b91d9ca2438',
    '006_dispositions.sql': 'a3586721db09806f10c347078acab6a01278ac5fc642e547d1db844563dde8c5',
    '007_findings_backfill.sql': '9dc2eb0f34e66545254c6f17614f1d7fc92a29cbf68f57176409ceaa856ecdfb',
    '008_runs.sql': '07ee45ee7c1eb56c96137b3c5e33b6d87c90a2e84106739accc203a54e548434',
    '009_evidence_and_indexes.sql':
      '3d11f637b6aa530679123d315ffe37ff875dbc0907ff1b522a826fc978a5c4b6',
    '010_freeze_findings.sql': 'b4e27a3232db6a9e9c83a0b9af5394a3946f3a043331153a5e58bb3313effbbe',
    '011_close_unused_finding_grants.sql':
      '7d4acf34efa8776926a7ac443bea770959ec1765b4131c10e8d3c40c49e05eb1',
    '012_audit_event.sql': '9a22709a9534c3ef95e662257f32d2d24bc33c7f8ac35e34815a039826fb9bce',
    '013_assignment.sql': 'e14c5d91e53ac2ddf8887729562bf551b15377169d1b4369695e69c8ac183049',
    '014_audit_partitions.sql': '34ac96dbfd2650f52a6db08c84808ab47c9a8014626641796d3ffadfc5e02a31',
    '015_role_mapping_source.sql':
      'ea0f6cc5995ffab09cb692bc90e6ff34f0a67b4826a4efb9583edd4ff94d5b6f',
  };

  const files = (): string[] =>
    readdirSync(at('apps/api/migrations')).filter(f => f.endsWith('.sql')).sort();

  it('has no gap, no duplicate and no file this pin does not name', () => {
    const found = files();
    expect(found).toEqual(Object.keys(APPLIED).sort());
    const numbers = found.map(f => Number(f.slice(0, 3)));
    expect(numbers).toEqual(numbers.map((_, i) => i));
    expect(Math.max(...numbers)).toBe(15);
    // Stage 5 took 015 because 014 was already applied. The plan said 014.
    expect(found).toContain('014_audit_partitions.sql');
    expect(existsSync(at('apps/api/migrations/014_role_mapping_source.sql'))).toBe(false);
  });

  it('is byte-for-byte what it was when it was applied', () => {
    for (const [file, sha] of Object.entries(APPLIED)) {
      const text = readFileSync(at(`apps/api/migrations/${file}`), 'utf8').replace(/\r\n/g, '\n');
      expect(createHash('sha256').update(text).digest('hex'), file).toBe(sha);
    }
    // The sanity half: the hash of a DIFFERENT text is a different hash, so
    // a comparison that always passed would be visible here.
    expect(createHash('sha256').update('x').digest('hex'))
      .not.toBe(APPLIED['001_identity.sql']);
  });
});

describe('no route reached a screen without a policy, and the read-only surfaces stayed read-only', () => {
  const admin = Object.entries(ROUTE_POLICY)
    .filter(([, p]) => p === 'admin').map(([k]) => k).sort();

  it('puts every §7 administrative act at the admin bar and nothing lower', () => {
    // Read out of the table rather than retyped. `authz.route.test.ts`
    // already asserts the table covers the registered routes in both
    // directions; what this adds is the STAGE's own claim about which acts
    // are administrative.
    expect(admin).toEqual([
      'DELETE /v1/admin/role-mappings/:id',
      'GET /v1/admin/audit-export',
      'GET /v1/admin/blob-orphans',
      'GET /v1/admin/providers',
      'GET /v1/admin/role-mappings',
      'POST /v1/admin/blob-orphans/delete',
      'POST /v1/admin/role-mappings',
      'POST /v1/admin/role-mappings/preview',
      'POST /v1/admin/users/:id/disable',
      'POST /v1/admin/users/:id/enable',
      'POST /v1/admin/users/:id/pseudonymise',
      'PUT /v1/admin/role-mappings/:id',
      'PUT /v1/workspace/settings',
    ]);
    // §7: an admin is not a super-reviewer, and there is no `public` admin
    // route. `/healthz` is the one public entry and it is asserted as the
    // complete list in `authz.route.test.ts`.
    expect(Object.values(ROUTE_POLICY).filter(p => p === 'public')).toHaveLength(1);
  });

  it('gives the providers surface NO write route, which is the design (P55, S15)', () => {
    // The allowlist has one home — the gateway's `models.json` — so a
    // provider is added by editing an operator's file and redeploying. A
    // write route here would move "where privileged text is processed" from
    // a deploy-time act with a Risk sign-off to a click.
    expect(admin.filter(k => k.includes('/providers'))).toEqual(['GET /v1/admin/providers']);
    expect(grepRepo(/app\.(post|put|patch|delete)\(/, [at('apps/api/src/routes/admin/providers.ts')]))
      .toEqual([]);
    // The sanity half.
    expect(/app\.(post|put|patch|delete)\(/.test("app.post('/x', h)")).toBe(true);
    // …and the screen says why, rather than leaving the absence to be read
    // as an unfinished feature.
    expect(codeOf(at('src/features/admin/ProvidersPanel.tsx')))
      .toContain('This is read-only: providers and models are changed in this deployment');
  });

  it('leaves the blob-orphan routes operator-only, deliberately and in writing', () => {
    // Reached with `curl` and an admin's bearer token. The new admin screen
    // does NOT adopt them, and the route table says so rather than leaving
    // them looking like routes some screen forgot to call.
    expect(grepRepo(/blob-orphans/, WEB_SOURCES)).toEqual([]);
    expect(/blob-orphans/.test("apiGet('/v1/admin/blob-orphans')")).toBe(true);
    expect(readFileSync(at('apps/api/src/auth/routeTable.ts'), 'utf8'))
      .toMatch(/OPERATOR-ONLY/);
  });

  it('reads no environment variable in any of the four new admin modules', () => {
    // `configSurface.test.ts` holds this repo-wide with its exemption list.
    // Named here for the modules this stage added, because a new module is
    // exactly where the exemption list gets quietly extended.
    for (const file of ['auditExport.ts', 'people.ts', 'providers.ts', 'roleMappings.ts']) {
      expect(codeOf(at(`apps/api/src/routes/admin/${file}`)), file).not.toContain('process.env');
    }
    expect('const x = process.env.API_ISSUER').toContain('process.env');
  });
});

describe('the caps this stage added are declared in all three places', () => {
  it('names each in config.ts, in caps.test.ts s literal list, and in divergence.json', () => {
    // Three files have to agree or an operator turns a knob that is not
    // there. `caps.test.ts` and `configSurface.test.ts` each hold one edge
    // of that triangle over the whole key set; this holds the stage's own
    // three across all of it, so a key that reached only two files fails
    // with a message naming the stage that added it.
    const config = codeOf(at('apps/api/src/config.ts'));
    const caps = codeOf(at('apps/api/test/caps.test.ts'));
    const divergence = readFileSync(at('apps/api/test/divergence.json'), 'utf8');
    for (const key of ['API_ASSIGNMENT_INBOX_LIMIT', 'API_SEARCH_LIMIT_PER_SOURCE',
      'API_AUDIT_EXPORT_MAX_ROWS']) {
      expect(config, `${key} is not read`).toContain(key);
      expect(caps, `${key} is not declared`).toContain(key);
      expect(divergence, `${key} has no divergence row`).toContain(key);
    }
  });
});

describe('one home for every piece of wording, with four renderers now', () => {
  it('keeps the export and disposition wording in findingOutcome.ts alone', () => {
    for (const fn of ['exportSummaryLine', 'dispositionsAsAtLine', 'dispositionsMayChangeLine',
      'dispositionLabel', 'verificationLabel']) {
      expect(grepRepo(new RegExp(`export function ${fn}\\b`), WEB_SOURCES), fn)
        .toEqual(['src/lib/findingOutcome.ts']);
    }
    // The sanity half: the pattern finds a declaration that IS there.
    expect(grepRepo(/export function describeLoadError/, WEB_SOURCES))
      .toEqual(['src/lib/loadError.ts']);
  });

  it('declares none of it in the four admin panels, which render a different subject', () => {
    // The admin screens are about policy, people, providers and evidence.
    // None of them is a fourth place a finding's outcome is worded, and the
    // audit export panel is the one where the pull to restate it is real.
    for (const panel of ['AdminScreen', 'AuditExportPanel', 'PeoplePanel', 'ProvidersPanel',
      'RoleMappingPanel']) {
      const code = codeOf(at(`src/features/admin/${panel}.tsx`));
      for (const fn of ['verificationLabel', 'dispositionLabel', 'exportSummaryLine']) {
        expect(code, `${panel} restates ${fn}`).not.toContain(`function ${fn}`);
      }
    }
  });
});

describe('what this stage deliberately did NOT do, pinned so it reads as a decision', () => {
  it('leaves findingOutcome.ts in src/, not packages/core (P33)', () => {
    /*
     * §6.3 says the module moves to `packages/core` when a SERVER-SIDE
     * export needs it. Task 15's export is server-side and carries AUDIT
     * ROWS, not findings, so the pressure has not arrived. Pinned rather
     * than left implicit: the next person to build a server-side findings
     * export should find this assertion and move the module, and the
     * assertion is what makes that a deliberate act.
     */
    expect(existsSync(at('src/lib/findingOutcome.ts'))).toBe(true);
    expect(existsSync(at('packages/core/src/findingOutcome.ts'))).toBe(false);
    expect(grepRepo(/findingOutcome/, [...API_SOURCES, ...CORE_SOURCES])).toEqual([]);
    expect(/findingOutcome/.test("from '../lib/findingOutcome.ts'")).toBe(true);
  });

  it('searches no document body text, and says so on the screen rather than in a comment', () => {
    // P48. Names, clients, references, review and collection and playbook
    // names, and clause titles inside the published version — and nothing
    // inside a document. A lawyer searching for a phrase they remember from
    // a lease gets nothing, which is survivable ONLY because the screen says
    // the phrase was never being searched for.
    expect(codeOf(at('src/features/search/SearchPalette.tsx')))
      .toMatch(/does not search the text inside documents/);
    const route = codeOf(at('apps/api/src/routes/search.ts'));
    expect(route).not.toMatch(/to_tsvector|websearch_to_tsquery|plainto_tsquery/);
    expect(/to_tsvector/.test('where to_tsvector(text) @@ q')).toBe(true);
  });

  it('has no retention job and no retention screen, and the partition is the whole mechanism', () => {
    // §7 lists retention configuration among an administrator's powers and
    // §17 Q3 is unanswered. A screen for a policy nobody has chosen would
    // choose one. What exists is monthly partitioning and a `DETACH`
    // somebody has to schedule.
    expect(grepRepo(/retention/i, COMPONENTS)).toEqual([]);
    expect(/retention/i.test('<RetentionPanel />')).toBe(true);
    expect(readFileSync(at('apps/api/migrations/012_audit_event.sql'), 'utf8'))
      .toMatch(/Retention becomes a DETACH rather than a DELETE/);
  });

  it('attributes no finding to a run, because finding carries no run_id (P60, §17 Q12)', () => {
    // The `run` row carries provider, model and jurisdiction; a clause
    // cannot honestly be attributed to a run, because a retry re-runs one
    // clause under whatever the workspace's model choice is NOW. So no
    // export says where a review was processed, and the gateway's call log
    // remains the evidence.
    const findings = readFileSync(at('apps/api/migrations/005_findings.sql'), 'utf8');
    expect(findings).not.toMatch(/run_id/);
    expect(/run_id/.test('run_id uuid references run(id)')).toBe(true);
    for (const file of ['src/lib/export/exportDocx.ts', 'src/lib/export/csv.ts']) {
      if (!existsSync(at(file))) continue;
      expect(codeOf(at(file)), file).not.toMatch(/jurisdiction/i);
    }
  });
});
