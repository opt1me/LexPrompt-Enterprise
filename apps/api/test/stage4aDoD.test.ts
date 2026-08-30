import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { ROOT, walk, rel, codeOf } from './sourceScan.ts';

/**
 * PART 4A'S DEFINITION OF DONE — searched rather than assumed.
 *
 * Part 4A closes ATTRIBUTION over Stage 3's existing poll, before Part 4B
 * replaces the transport. The finding that set the order was that
 * change-by-others is already live and already unattributed: one reviewer
 * could overwrite another's verification with nothing on screen saying who
 * did it, and `twoAccounts.compose.test.ts` demonstrated it with two real
 * tokens.
 *
 * ## What this file is, and what it deliberately is not
 *
 * The behavioural claims each have a suite: the race is
 * `dispositionRace.pg.test.ts`, the refusal's sentence is
 * `ConflictNotice.test.tsx`, the held update is `FindingCard.test.tsx`, the
 * export's stamp is `exportDocx.test.ts`, the grant is
 * `auditEvent.pg.test.ts`. Restating any of them here would be two suites
 * making one claim, and the weaker copy is always the one that stays green
 * when the property breaks.
 *
 * So what is here is the STRUCTURE those suites rest on and cannot check
 * about themselves — one home per piece of wording, one resolver, one gate —
 * and THE PART BOUNDARY, enforced rather than remembered. Tasks 16, 19, 22
 * and 24 each edit this file when they land, and that is the intent.
 *
 * Every scanner is paired with a check that it finds what it claims to.
 * Stage 3 found nine guards that were not guarding; this batch found two
 * more (a `clauseTitle` absence that `JSON.stringify` hid, and a
 * workspace-scope guard that read a `union` whole).
 */

const at = (p: string): string => path.join(ROOT, p);

const WEB_SOURCES = walk(path.join(ROOT, 'src'));
const API_SOURCES = walk(path.join(ROOT, 'apps/api/src'));
const CORE_SOURCES = walk(path.join(ROOT, 'packages/core/src'));
const ALL_SOURCES = [...WEB_SOURCES, ...API_SOURCES, ...CORE_SOURCES];

/** Source files, comments stripped, whose CODE names `needle`. */
function grepRepo(needle: string | RegExp, sources: string[] = ALL_SOURCES): string[] {
  const re = typeof needle === 'string'
    ? new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) : needle;
  return sources.filter(f => re.test(codeOf(f))).map(rel).sort();
}

const declares = (re: RegExp): string[] =>
  ALL_SOURCES.filter(f => re.test(codeOf(f))).map(rel).sort();

describe('the scanners find something', () => {
  it('walks every workspace, and enough of each to mean anything', () => {
    expect(WEB_SOURCES.length).toBeGreaterThan(120);
    expect(API_SOURCES.length).toBeGreaterThan(30);
    expect(CORE_SOURCES.length).toBeGreaterThan(15);
    expect(ALL_SOURCES.length).toBeGreaterThan(180);
  });

  it('grepRepo finds a name that IS there, and misses one that is not', () => {
    // Both directions. A `grepRepo` that always returned `[]` would satisfy
    // every `toEqual([])` below, which is the failure mode this project has
    // now caught eleven times.
    expect(grepRepo('dispositionLabel').length).toBeGreaterThan(1);
    expect(grepRepo('a-name-no-source-file-contains')).toEqual([]);
  });
});

describe('Part 4A: every piece of wording has exactly one home', () => {
  it('has exactly one home for every piece of disposition wording', () => {
    expect(declares(/export function dispositionLabel/)).toEqual(['src/lib/findingOutcome.ts']);
    expect(declares(/export function dispositionHistoryLine/))
      .toEqual(['src/lib/findingOutcome.ts']);
    // Stage 4's three new sentences live there too: the refusal that names
    // whose change won, the notice a held update shows, and the export's
    // point-in-time stamp. Five surfaces render a disposition — the card,
    // the history panel, the refusal notice, the DOCX and the CSV — and five
    // callers is four more than it takes for a second copy to appear.
    for (const fn of ['dispositionConflictLine', 'conflictReapplyLabel', 'heldUpdateLine',
      'dispositionsAsAtLine', 'dispositionsMayChangeLine', 'exportDispositionLine']) {
      expect(declares(new RegExp(`export function ${fn}`)), fn)
        .toEqual(['src/lib/findingOutcome.ts']);
    }
    expect(ALL_SOURCES.length).toBeGreaterThan(60);
  });

  it('states a previous state, and a state WORD, in ONE module', () => {
    // `STATE_WORD` is `StateChip`'s vocabulary, and a component building
    // "was Rejected" out of its own state name is the drift
    // `verificationLabel` was extracted to end.
    expect(grepRepo('STATE_WORD')).toEqual(['src/lib/findingOutcome.ts']);
    const HARD_CODED = /['"`]was (?:Rejected|Verified|Flagged|Unverified)/;
    expect(grepRepo(HARD_CODED)).toEqual([]);
    expect(HARD_CODED.test("const s = 'was Rejected';")).toBe(true);
    expect(HARD_CODED.test('const s = `, was ${STATE_WORD[previous]}`;')).toBe(false);
  });

  it('renders no disposition anywhere without going through that wording', () => {
    /*
     * THE SCANNER: any component that renders a `VerificationState` word
     * directly is a second place deciding what a disposition SAYS.
     *
     * `StateChip` is the one named exclusion, and it is named rather than
     * pattern-matched: it renders the WORD, deliberately, and is always
     * paired with the label line beside it. A relaxed pattern here would
     * quietly cover the next component that grew its own copy.
     */
    const RENDERS_A_STATE = /['"`](?:Verified|Rejected|Flagged|Unverified)['"`]/;
    const components = WEB_SOURCES.filter(f => f.endsWith('.tsx'));
    const offenders = components.filter(f => RENDERS_A_STATE.test(codeOf(f))).map(rel);
    expect(offenders.filter(f => f !== 'src/components/StateChip.tsx')).toEqual([]);
    expect(components.length, 'the component scan found nothing').toBeGreaterThan(20);
    // …and the pattern really does bite, so the empty list above is a fact
    // about the components rather than about the regex.
    expect(RENDERS_A_STATE.test("<span>{'Verified'}</span>")).toBe(true);
    expect(RENDERS_A_STATE.test('<span>{dispositionLabel(d, a)}</span>')).toBe(false);
  });

  it('has exactly one id-to-name resolver, and it cannot write', () => {
    expect(declares(/export function userName/)).toEqual(['src/lib/api/users.ts']);
    // P32's other half: it resolves ids FOR DISPLAY and must never grow a
    // way to ASSERT an attribution. Asserted over the module's own source,
    // because a behavioural check stays green until something CALLS the new
    // function.
    const users = codeOf(at('src/lib/api/users.ts'));
    for (const writer of ['apiSend', 'apiSendBlob', 'apiDelete']) {
      expect(users, `users.ts names ${writer}`).not.toContain(writer);
    }
    expect(users).toContain('apiGet');
  });

  it('decides "may this update be applied" in ONE place', () => {
    // Read by the poll path today and by the socket path in Task 21. Two
    // copies of this decision is sibling drift on the one question that
    // decides whether a lawyer sees a state change under their hand.
    expect(declares(/export function mayApplyNow/))
      .toEqual(['src/features/review/pendingUpdate.ts']);
    expect(grepRepo('mayApplyNow').length).toBeGreaterThan(1);
  });

  it('writes no disposition act into audit_event (S22)', () => {
    const src = codeOf(at('apps/api/src/audit/actions.ts'));
    expect(src).not.toMatch(/finding\.|disposition|verif|reject|flag/i);
    expect(src).toMatch(/playbook\.published/);      // the sanity check
    // …and `appendAudit` is the ONE writer of the table.
    expect(declares(/export async function appendAudit/))
      .toEqual(['apps/api/src/audit/write.ts']);
    expect(grepRepo(/insert into audit_event/, API_SOURCES))
      .toEqual(['apps/api/src/audit/write.ts']);
  });

  it('writes a disposition from ONE module, still', () => {
    // Stage 3's rule, re-checked because Stage 4 added a route group. A
    // third writer appearing is exactly what this exists to catch, whatever
    // its intentions.
    // `findings/backfill.ts` is the SECOND, and it is the one-time migration
    // Stage 3 named as such: it writes the history rows that explain the
    // dispositions it created from the frozen blob, once, as the migrator.
    // NAMED rather than pattern-excluded, so a third writer is still a
    // failure and this list has to be edited by whoever adds one.
    expect(grepRepo(/insert into finding_disposition_event|update finding_disposition\b/,
      API_SOURCES)).toEqual([
      'apps/api/src/dispositions/service.ts',
      'apps/api/src/findings/backfill.ts',
    ]);
  });
});

describe('Part 4A: the part boundary, enforced rather than remembered', () => {
  it('has the socket, registered like every other route — INVERTED by Task 16 (P30)', () => {
    /*
     * This read *"still polls — the socket is Task 16, not this part"*, and
     * it was the boundary Part 4A enforced rather than remembered. Task 16
     * landed the socket, so the assertion is INVERTED rather than deleted:
     * the record of what was missing survives beside the proof that it no
     * longer is.
     *
     * What is asserted now is the structure the socket's own suites cannot
     * check about themselves — that it exists, that it is a route the
     * authorisation table covers, and that it did NOT arrive as a plugin
     * whose upgrade ordering nobody here can read (S29).
     */
    expect(existsSync(at('apps/api/src/realtime/socket.ts'))).toBe(true);
    expect(existsSync(at('apps/api/src/realtime/hub.ts'))).toBe(true);
    expect(existsSync(at('packages/core/src/api/socket.ts'))).toBe(true);
    // The frame union has exactly one home. A second copy in `src/lib/` is a
    // client that silently drops whichever frame the two disagree about.
    expect(declares(/export type ServerFrame/)).toEqual(['packages/core/src/api/socket.ts']);
    expect(declares(/export type ClientFrame/)).toEqual(['packages/core/src/api/socket.ts']);
    // In the authorisation table, so the authz sweep and the 401 sweep both
    // see it. A socket registered outside the router would be silently
    // absent from both.
    expect(codeOf(at('apps/api/src/auth/routeTable.ts'))).toContain("'GET /v1/ws'");
    // NOT `@fastify/websocket`: it performs the upgrade inside Fastify's own
    // lifecycle, so whether the 101 is written before or after this
    // application's authentication is a property of that plugin rather than
    // of anything readable here. The ruling is in `realtime/socket.ts`.
    expect(grepRepo('@fastify/websocket')).toEqual([]);
    // The sanity check for that `toEqual([])`: the scanner CAN find a name
    // that is genuinely present in the same sources.
    expect(grepRepo('setTimeout').length).toBeGreaterThan(1);
  });

  it('authenticates the socket BEFORE the upgrade, and offers no way round it (S29)', () => {
    const socket = codeOf(at('apps/api/src/realtime/socket.ts'));
    // The mutation this exists for: add an `if (process.env.WS_ALLOW_ANON)`
    // branch to `realtime/socket.ts` and confirm THIS goes red.
    expect(socket).not.toMatch(/SKIP|ANON|allowAnonymous|process\.env/);
    // …and the sanity check, so the absence above is a fact about the file
    // rather than about a scan that read nothing.
    expect(socket).toMatch(/deps\.verify\(token\)/);
    expect(socket).toMatch(/resolveActor/);
    // The ORDER, over the source: `handleUpgrade` must not appear before the
    // verification does. A socket upgraded first and authenticated on its
    // first frame is an unauthenticated connection that exists.
    expect(socket.indexOf('deps.verify(token)')).toBeLessThan(socket.indexOf('handleUpgrade'));
    expect(socket.indexOf('handleUpgrade')).toBeGreaterThan(-1);
  });

  it('has no presence surface yet — Task 22, not before', () => {
    const PRESENCE = /\bpresence\b/i;
    expect(grepRepo(PRESENCE, [...WEB_SOURCES, ...API_SOURCES])).toEqual([]);
    expect(PRESENCE.test('const presence = usePresence();')).toBe(true);
  });

  it('has no assignment yet — Task 24, not before', () => {
    // BY PATTERN, not by the plan's fixed `012_assignment.sql`: 012 is
    // `audit_event`, because `011_close_unused_finding_grants.sql` landed in
    // Stage 3's fix round and an applied migration is immutable. A check
    // pinned to a number would pass for the wrong reason forever.
    const migrations = readdirSync(at('apps/api/migrations'));
    expect(migrations.filter(f => /assignment/i.test(f))).toEqual([]);
    expect(migrations.length, 'the migrations directory was not read')
      .toBeGreaterThan(10);
    expect(migrations).toContain('012_audit_event.sql');
    // The audit action list ANTICIPATES assignment (it is a closed set, and
    // Stage 5 adds the writer, not the verb) — but no route serves one.
    expect(grepRepo(/\/assignments?\b/, API_SOURCES)).toEqual([]);
  });

  it('ships no assignee field and no second person in the single-user substrate', () => {
    // R-G1's surviving half. The activity feed NAMES people as of Task 12
    // and `CLAUDE.md` says so; what is still absent is an assignee chip and
    // an "assigned to me" counter.
    expect(grepRepo(/assigneeId/, WEB_SOURCES.filter(f => f.endsWith('.tsx')))).toEqual([]);
    expect(grepRepo(/assigned to me/i)).toEqual([]);
  });
});

describe('Part 4A: what the record must say, structurally', () => {
  it('has a suite for each of the four mechanisms an override resolves by', () => {
    // The behavioural claims live in these files. Their EXISTENCE is the
    // thing this file can check and they cannot.
    for (const suite of [
      'apps/api/test/dispositionRace.pg.test.ts',       // 1: the version guard decides
      'src/features/review/ConflictNotice.test.tsx',    // 2: the refusal is named
      'src/features/review/pendingUpdate.test.ts',      // 4: a push held mid-decision
      'src/features/review/exportHistoryCsv.test.ts',   // the record, exportable
      'apps/api/test/reviewHistory.pg.test.ts',
      'apps/api/test/auditEvent.pg.test.ts',
      'apps/api/test/activity.pg.test.ts',
    ]) {
      expect(existsSync(at(suite)), suite).toBe(true);
    }
  });

  it('wires every real-database suite into a runner that actually runs them', () => {
    // A `.pg.test.ts` no config includes is a suite whose absence looks
    // exactly like a suite that passes.
    const config = codeOf(at('vitest.pg.config.ts'));
    expect(config).toMatch(/pg\.test\.ts/);
    const pgSuites = readdirSync(at('apps/api/test')).filter(f => f.endsWith('.pg.test.ts'));
    expect(pgSuites.length).toBeGreaterThan(20);
    expect(pgSuites).toContain('dispositionRace.pg.test.ts');
    expect(pgSuites).toContain('auditEvent.pg.test.ts');
  });

  it('offers the change again by a person s click, and never automatically', () => {
    /*
     * P25's absence, over the source. The behavioural case is in
     * `ConflictNotice.test.tsx`; what THIS adds is that the component has no
     * effect at all, which is the shape an automatic re-apply would take.
     * The pressure to add one is permanent: the click is annoying, the fix
     * is one line, and it re-creates last-write-wins with a history row
     * saying a person decided it.
     */
    const notice = codeOf(at('src/features/review/ConflictNotice.tsx'));
    expect(notice).not.toMatch(/useEffect|setTimeout|setInterval/);
    expect(notice).toContain('onReapply');
  });

  it('never asserts a verification eternally — every export carries the stamp', () => {
    for (const exporter of ['src/features/review/exportDocx.ts', 'src/features/tabular/csv.ts',
      'src/features/review/exportHistoryCsv.ts']) {
      const code = codeOf(at(exporter));
      expect(code, `${exporter} does not date its dispositions`)
        .toContain('dispositionsAsAtLine');
      expect(code, `${exporter} does not say a disposition can change`)
        .toContain('dispositionsMayChangeLine');
    }
    // …and the wording itself is in exactly one file, so the three cannot
    // drift. The DOCX and the CSV have drifted once before.
    expect(grepRepo(/Dispositions as at/)).toEqual(['src/lib/findingOutcome.ts']);
  });
});
