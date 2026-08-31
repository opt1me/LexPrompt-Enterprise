import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT, walk, rel, codeOf } from './sourceScan.ts';

/**
 * STAGE 4'S DEFINITION OF DONE — §18 ITEM 5, CLAUSE BY CLAUSE.
 *
 * ## The three categories, and why a green sweep would be the worst outcome
 *
 * The plan (P44) requires every clause of §18 item 5 to be categorised as
 * **met by mechanism**, **met by rendered string**, or **unmet**, with its
 * evidence and its limit. A file that simply went green over all of them
 * would be the exact failure this project is organised against: something
 * incomplete presented as complete.
 *
 * So this file asserts only what a SOURCE SCAN can honestly assert — the
 * structure the behavioural suites rest on and cannot check about
 * themselves. The behaviour is proved elsewhere and is NAMED here rather
 * than restated: restating it would be two suites making one claim, and the
 * weaker copy is always the one that stays green when the property breaks.
 *
 * `stage4DoD.compose.test.ts` holds the live half — two real tokens, two
 * replicas, the running stack.
 *
 * ## What NEITHER file can prove, and does not pretend to
 *
 * Browser automation has been unavailable for this whole project. Nobody has
 * SEEN the conflict notice read as an error rather than a decision, the
 * held-update line get noticed mid-sentence, a presence face, or two people
 * using the app at once. The API halves are proved live; the screen halves
 * are proved as rendered strings in jsdom, which is a weaker claim, and
 * `stage-4-report.md` says which is which.
 */

const at = (p: string): string => path.join(ROOT, p);
const WEB_SOURCES = walk(path.join(ROOT, 'src'));
const API_SOURCES = walk(path.join(ROOT, 'apps/api/src'));
const CORE_SOURCES = walk(path.join(ROOT, 'packages/core/src'));
const ALL_SOURCES = [...WEB_SOURCES, ...API_SOURCES, ...CORE_SOURCES];

function grepRepo(needle: RegExp, sources: string[] = ALL_SOURCES): string[] {
  return sources.filter(f => needle.test(codeOf(f))).map(rel).sort();
}

/** Every `.tsx` under `src/`, which is where an affordance can live. */
const COMPONENTS = WEB_SOURCES.filter(f => f.endsWith('.tsx') && !f.includes('.test.'));

describe('the scanners find something before anything is checked with them', () => {
  it('walks a realistic number of files in every workspace', () => {
    expect(WEB_SOURCES.length).toBeGreaterThan(120);
    expect(API_SOURCES.length).toBeGreaterThan(30);
    expect(CORE_SOURCES.length).toBeGreaterThan(15);
    expect(COMPONENTS.length).toBeGreaterThan(40);
  });
});

describe('§18 item 5, met by MECHANISM — the suites that prove it exist and run', () => {
  it('names a suite for each clause, and every one of them is on disk', () => {
    /*
     * The EXISTENCE of these files is what this suite can check and they
     * cannot check about themselves. Every one is behavioural and every one
     * runs in a configured runner (asserted below).
     */
    const CLAUSES: Record<string, string[]> = {
      'a change by one person reaches another, attributed': [
        'apps/api/test/livePush.compose.test.ts',        // two real tokens, one socket
        'apps/api/test/replicaFanout.compose.test.ts',   // …across replicas
        'src/App.livePush.test.tsx',                     // …and onto the card
      ],
      'a stale change is refused, named, and offered again': [
        'apps/api/test/dispositionRace.pg.test.ts',
        'src/features/review/ConflictNotice.test.tsx',
        'src/features/review/pendingUpdate.test.ts',
      ],
      'every disposition names its actor and its time': [
        'src/lib/findingOutcome.test.ts',
        'src/features/review/DispositionHistory.test.tsx',
      ],
      'an export states the instant it was true': [
        'src/features/review/exportDocx.test.ts',
        'src/features/tabular/csv.test.ts',
        'src/features/review/exportHistoryCsv.test.ts',
      ],
      'a stale client stops offering to change anything': [
        'src/components/StalePanel.test.tsx',
        'src/features/review/VerificationControls.test.tsx',
      ],
      'an assignment reaches its assignee': [
        'apps/api/test/assignments.pg.test.ts',
        'apps/api/test/assignmentReaches.compose.test.ts',
        'src/features/assignments/AskedOfYou.test.tsx',
      ],
      'presence is ephemeral, advisory and never persisted': [
        'apps/api/test/presence.pg.test.ts',
        'apps/api/test/presence.compose.test.ts',
        'src/components/PresenceRoster.test.tsx',
      ],
      'the audit log holds no disposition change (S22)': [
        'apps/api/test/auditEvent.pg.test.ts',
        'apps/api/test/activity.pg.test.ts',
      ],
    };
    for (const [clause, suites] of Object.entries(CLAUSES)) {
      for (const suite of suites) {
        expect(existsSync(at(suite)), `${clause}: ${suite}`).toBe(true);
      }
    }
  });

  it('wires every compose suite into a runner that actually runs it', () => {
    // A `.compose.test.ts` no config includes is a suite whose absence looks
    // exactly like a suite that passes.
    const config = codeOf(at('vitest.compose.config.ts'));
    expect(config).toMatch(/compose\.test\.ts/);
    const suites = readdirSync(at('apps/api/test')).filter(f => f.endsWith('.compose.test.ts'));
    expect(suites.length).toBeGreaterThan(8);
    for (const required of [
      'livePush.compose.test.ts', 'replicaFanout.compose.test.ts',
      'presence.compose.test.ts', 'assignmentReaches.compose.test.ts',
      'stage4DoD.compose.test.ts',
    ]) {
      expect(suites, required).toContain(required);
    }
  });
});

describe('§18 item 5, met by RENDERED STRING — one home per piece of wording', () => {
  it('shows no disposition state anywhere without its actor line beside it', () => {
    /*
     * `StateChip` is the ONE component that renders a bare state word, and
     * every surface that renders it must say who set it. The failure this
     * guards is a card that looks complete — the chip says "Verified" —
     * while saying nothing about who decided that.
     *
     * ONE SURFACE IS DIFFERENT AND IS NAMED HERE RATHER THAN EXEMPTED.
     * `TabularReview` is the comparison GRID: many documents × many clauses,
     * one small cell each, and an actor line per cell would be unreadable
     * and would also be the only place in the app where a name is rendered
     * at that density. Its chip is a triage signal; the attribution is one
     * click away in the cell detail panel, which mounts the ordinary
     * `FindingCard` with the ordinary `disposition` — asserted below rather
     * than assumed, because "the detail panel shows it" is exactly the kind
     * of claim that stops being true without anything going red.
     *
     * This is a REAL LIMIT of §18 item 5 on that surface and Stage 4's
     * report says so: on the grid, a disposition is shown without its actor
     * until a reader opens the cell.
     */
    const TRIAGE_GRID = 'src/features/tabular/TabularReview.tsx';
    const chipUsers = COMPONENTS.filter(f => /<StateChip/.test(codeOf(f))).map(rel);
    expect(chipUsers.length, 'nothing renders a StateChip').toBeGreaterThan(0);
    expect(chipUsers, 'the named triage surface no longer renders a chip')
      .toContain(TRIAGE_GRID);
    for (const file of chipUsers) {
      if (file === TRIAGE_GRID) continue;
      const code = codeOf(at(file));
      expect(code, `${file} renders a state chip and no actor line`)
        .toMatch(/dispositionLabel|DispositionHistory/);
    }
    // The grid's counterpart, so the exemption above is a boundary rather
    // than a hole: its detail panel really does carry the disposition into a
    // `FindingCard`, which is where `dispositionLabel` lives.
    const detail = codeOf(at('src/features/tabular/CellDetail.tsx'));
    expect(detail).toMatch(/disposition=\{disposition\}/);
    expect(detail).toMatch(/<FindingCard/);
  });

  it('keeps disposition wording in ONE module, beside the verification wording', () => {
    // The DOCX and the CSV drifted apart on this once before. Both call
    // these rather than composing their own strings.
    for (const fn of [
      /export function dispositionLabel/,
      /export function dispositionHistoryLine/,
      /export function dispositionsAsAtLine/,
      /export function dispositionsMayChangeLine/,
      /export function verificationLabel/,
      /export function exportSummaryLine/,
    ]) {
      expect(grepRepo(fn), String(fn)).toEqual(['src/lib/findingOutcome.ts']);
    }
  });

  it('stamps both exporters with the instant, and says a disposition can change', () => {
    for (const exporter of [
      'src/features/review/exportDocx.ts',
      'src/features/tabular/csv.ts',
      'src/features/review/exportHistoryCsv.ts',
    ]) {
      const code = codeOf(at(exporter));
      expect(code, `${exporter} does not stamp its instant`).toMatch(/dispositionsAsAtLine/);
      expect(code, `${exporter} does not say a disposition can change`)
        .toMatch(/dispositionsMayChangeLine/);
    }
  });

  it('resolves every id to a name through ONE module (P32)', () => {
    expect(grepRepo(/export function userName/)).toEqual(['src/lib/api/users.ts']);
    expect(grepRepo(/export function userInitials/)).toEqual(['src/lib/api/users.ts']);
    // …and no event payload carries a display name, which would be a second
    // copy of a mutable field refreshed at a different moment.
    const records = codeOf(at('packages/core/src/api/records.ts'));
    expect(records).not.toMatch(/displayName: string;\s*\n\s*\}\s*\n\s*\/\*\* .*payload/i);
  });

  it('disables every human-authored write when the client is stale', () => {
    // §3's fourth load state. The findings stay on screen — blanking them is
    // the OTHER failure — and every control that COMPOSES a write goes dead.
    for (const control of [
      'src/features/review/VerificationControls.tsx',
      'src/features/review/NotesPanel.tsx',
      'src/features/review/NetPositionPanel.tsx',
      'src/features/assignments/AssignPanel.tsx',
    ]) {
      const code = codeOf(at(control));
      expect(code, `${control} does not read stale`).toMatch(/stale/);
      expect(code, `${control} does not disable on stale`).toMatch(/disabled=\{[^}]*stale/);
    }
    // `VariationTrailModal` is the one that PASSES it rather than applying
    // it — the controls live in `NetPositionPanel`, which is checked above.
    // Named, because "it takes a `stale` prop" and "it does something with
    // it" are different facts and only the second is the guarantee.
    expect(codeOf(at('src/features/review/VariationTrailModal.tsx')))
      .toMatch(/stale=\{stale\}/);
  });
});

describe('the properties a later stage would break quietly', () => {
  it('has ONE version number doing both jobs, not two', () => {
    /*
     * §8: "the stale-change refusal and the realtime version guard are the
     * same number doing two jobs, and they must not be allowed to become two
     * numbers."
     */
    expect(grepRepo(/dispositionVersion2|pushVersion|liveVersion/)).toEqual([]);
    // The sanity check: the scanner CAN find the one number that is there.
    expect(grepRepo(/dispositionVersions/).length).toBeGreaterThan(3);
  });

  it('writes no disposition change into audit_event (S22)', () => {
    const actions = codeOf(at('apps/api/src/audit/actions.ts'));
    expect(actions).not.toMatch(/'finding\.[a-z_]+'/);
    // The sanity check: the file DOES name the actions it holds.
    expect(actions).toMatch(/'assignment\.created'/);
    expect(actions).toMatch(/'matter\.created'/);
    // …and only one module writes the table at all.
    expect(grepRepo(/insert into audit_event/, API_SOURCES))
      .toEqual(['apps/api/src/audit/write.ts']);
  });

  it('persists no presence anywhere (S6)', () => {
    const migrations = readdirSync(at('apps/api/migrations'));
    const sql = migrations
      .map(f => readFileSync(at(`apps/api/migrations/${f}`), 'utf8').replace(/--[^\n]*/g, ''))
      .join('\n');
    expect(/presence/i.test(sql), 'a migration names presence').toBe(false);
    expect(/finding_disposition/.test(sql), 'the migration scan read nothing').toBe(true);
    // …and the module itself reaches no store.
    const presence = codeOf(at('apps/api/src/realtime/presence.ts'));
    expect(presence).not.toMatch(/insert into|update |blobStore|db\/pool/i);
    expect(presence).toMatch(/roster/);
  });

  it('gates no write on presence (S6)', () => {
    // The day "Priya is on this clause — are you sure?" becomes a REFUSAL is
    // the day presence stops being advisory. No route reads a roster.
    const routes = walk(path.join(ROOT, 'apps/api/src/routes'));
    expect(routes.length).toBeGreaterThan(10);
    expect(routes.filter(f => /presence|roster/i.test(codeOf(f))).map(rel)).toEqual([]);
  });

  it('has no authentication bypass, on the socket either (S29)', () => {
    const socket = codeOf(at('apps/api/src/realtime/socket.ts'));
    expect(socket).not.toMatch(/SKIP|ANON|allowAnonymous|process\.env/);
    expect(socket).toMatch(/deps\.verify\(token\)/);
    // The ORDER, over the source: authenticated BEFORE the upgrade.
    expect(socket.indexOf('deps.verify(token)')).toBeLessThan(socket.indexOf('handleUpgrade'));
    expect(socket.indexOf('handleUpgrade')).toBeGreaterThan(-1);
  });

  it('keeps an assignment out of the disposition path (§6.3)', () => {
    const route = codeOf(at('apps/api/src/routes/assignments.ts'));
    expect(route).not.toMatch(/finding_disposition|setDisposition|resetVerification/);
    expect(route).toMatch(/insert into assignment/);   // the sanity check
  });

  it('lets the engine touch none of it — the grants, in the migrations', () => {
    const dir = at('apps/api/migrations');
    const sql = readdirSync(dir)
      .map(f => readFileSync(path.join(dir, f), 'utf8').replace(/--[^\n]*/g, ''))
      .join('\n');
    for (const table of ['finding_disposition', 'audit_event', 'assignment']) {
      const OFFENDING = new RegExp(`grant[^;]*\\bon\\b[^;]*${table}[^;]*lexprompt_worker`, 'i');
      expect(OFFENDING.test(sql), `a migration grants the worker ${table}`).toBe(false);
    }
    // The scan bites: the same shape over a line that DOES grant one.
    expect(/grant[^;]*\bon\b[^;]*assignment[^;]*lexprompt_worker/i
      .test('grant select on assignment to lexprompt_worker;')).toBe(true);
    expect(sql).toMatch(/revoke all on assignment from lexprompt_worker/);
  });

  it('keeps three files with three concerns behind §8 s interface', () => {
    // Redis, if it is ever needed, replaces `feed.ts` and touches neither of
    // the others. A hub that knew about frames, or a socket that read the
    // outbox, would make that untrue silently.
    expect(codeOf(at('apps/api/src/realtime/hub.ts'))).not.toMatch(/WebSocket|readEvents|pg_notify/);
    expect(codeOf(at('apps/api/src/realtime/feed.ts'))).not.toMatch(/WebSocketServer|handleUpgrade/);
  });

  it('has every route in ROUTE_POLICY, the socket included', () => {
    const policy = codeOf(at('apps/api/src/auth/routeTable.ts'));
    for (const route of [
      "'GET /v1/ws'",
      "'GET /v1/assignments'",
      "'POST /v1/assignments/:id/resolve'",
      "'POST /v1/reviews/:id/findings/:findingsKey/:clauseId/assignments'",
    ]) {
      expect(policy, `${route} is not in ROUTE_POLICY`).toContain(route);
    }
    // …and there is no default. A route with no entry fails at registration.
    expect(codeOf(at('apps/api/src/auth/requireRole.ts'))).toMatch(/onRoute/);
  });
});

describe('what Stage 5 inherits, asserted rather than described', () => {
  it('ships an assignee chip, and a chip is not a disposition (S18 released)', () => {
    /*
     * INVERTED, NOT DELETED (P46). This forbade the chip by absence; what
     * replaces the prohibition is the rule that OUTLIVES it — the chip may
     * not render a disposition word or a state ink.
     *
     * Asserted over the component's SOURCE as well as over its render
     * (`AssigneeChip.test.tsx`), because a class added in a hurry is not
     * something a render test with three fixtures would catch.
     */
    expect(grepRepo(/AssigneeChip/, COMPONENTS))
      .toContain('src/features/assignments/AssigneeChip.tsx');
    const chip = codeOf(at('src/features/assignments/AssigneeChip.tsx'));
    expect(chip).not.toMatch(/text-state-|bg-state-|text-outcome-|bg-outcome-/);
    expect('text-state-verified').toMatch(/text-state-/);   // the sanity half
    // …and no disposition word in the wording it declares.
    for (const word of ['Verified', 'Flagged', 'Rejected', 'Unchecked', 'Approved']) {
      expect(chip, word).not.toContain(word);
    }
    // …and `assigneeId` is still not a field any component names (P24). The
    // chip reads `AssignmentView.assigneeUserId`, which is a different field
    // on a different record; `Verification.assigneeId` (S17) stays retired.
    expect(grepRepo(/\bassigneeId\b/, COMPONENTS)).toEqual([]);
    expect(chip).toContain('assigneeUserId');
  });

  it('ships an assigned-to-me counter, and it has THREE states (S18 released)', () => {
    /*
     * INVERTED, NOT DELETED (P46). This `it` used to forbid the counter by
     * absence; a guard that simply lost its case would pass every other
     * test in the repository, which is why the prohibition is replaced by
     * the assertion that keeps the thing it released honest.
     *
     * The third state is the whole point: `ready` with a count of zero
     * renders nothing, a failed read renders "not known", and they must not
     * be the same pixel. A badge showing `0` because a fetch failed is a
     * lawyer not doing something a colleague is waiting on, and it looks
     * exactly like a quiet week.
     */
    expect(grepRepo(/assignedToMe/i, WEB_SOURCES)).toContain('src/lib/assignedToMe.ts');
    const counter = codeOf(at('src/lib/assignedToMe.ts'));
    expect(counter).toMatch(/status: 'error'/);
    expect(counter).toMatch(/status: 'loading'/);
    // …and the component renders the error state as words, never a digit.
    expect(codeOf(at('src/features/assignments/AssignedToMe.tsx'))).toMatch(/not known/);
  });

  it('ships firm-wide search, and it declares its own corpus (R-G14 discharged)', () => {
    /*
     * INVERTED (P46) — AND THE GUARD IT REPLACES WAS NOT GUARDING.
     *
     * The shipped assertion was `grepRepo(/cmdk|CommandPalette/i)` with no
     * sanity check, so it would have passed a palette named anything else —
     * which is exactly what shipped: `SearchPalette`. It reported a deferral
     * that a later commit could have discharged without a word. Fixed where
     * it was found rather than where it was convenient (the fifteenth guard
     * in this project found not guarding).
     */
    const palette = grepRepo(/SearchPalette/, COMPONENTS);
    expect(palette).toContain('src/features/search/SearchPalette.tsx');
    // The rule that outlives the deferral: the corpus sentence exists, in
    // ONE place, and the palette renders it. A search that silently misses
    // documents turns "I looked and it is not there" into a claim the
    // software invited and cannot support.
    expect(codeOf(at('src/features/search/SearchPalette.tsx')))
      .toMatch(/does not search the text inside documents/);
    // THE SANITY CHECK THE SHIPPED GUARD NEVER HAD: the scanner can find a
    // component that IS present. A `toEqual([])` over a scanner that matches
    // nothing passes vacuously, and that is how this one lasted.
    expect(grepRepo(/LoadErrorPanel/, COMPONENTS).length).toBeGreaterThan(3);
  });

  it('still defers the Report tab, by absence', () => {
    /*
     * The Report tab is Task 6. Until then it is absent, and the ABSENCE is
     * what is asserted — by PATH rather than by name, because the name is
     * already taken: `src/features/upload/UploadLocalData.tsx` exports a
     * `ReportView` of its own, for the uploader's report, and a name grep
     * would have reported the Report tab as already shipped. That is the
     * same failure as the ⌘K guard above, in the opposite direction: a
     * scanner that matches the wrong thing.
     *
     * With the sanity half this `it` never had either: the check has to be
     * able to see a component that IS there.
     */
    expect(existsSync(at('src/features/review/ReportView.tsx'))).toBe(false);
    expect(existsSync(at('src/features/tabular/TabularReview.tsx'))).toBe(true);
  });

  it('keeps every applied migration immutable — the next one is 014', () => {
    const migrations = readdirSync(at('apps/api/migrations')).filter(f => f.endsWith('.sql'));
    const numbers = migrations.map(f => Number(f.slice(0, 3))).sort((a, b) => a - b);
    // No gaps and no duplicates: a migration applied out of order is a
    // schema nobody can reproduce.
    expect(numbers).toEqual(numbers.map((_, i) => i));
    expect(migrations).toContain('013_assignment.sql');
  });
});
