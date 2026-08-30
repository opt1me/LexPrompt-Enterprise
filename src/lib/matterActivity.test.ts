import { describe, it, expect } from 'vitest';
import type { ActivityRow } from '@lexprompt/core';
import { activityEntries, matterActivity } from './matterActivity';
import type { Finding, Review } from '../types';

/**
 * STAGE 4: THE FEED READS THE RECORDS, AND NAMES PEOPLE.
 *
 * The verifications, runs and audited acts that used to be derived from the
 * reviews in hand now come from `GET /v1/matters/:id/activity`, which reads
 * `finding_disposition_event`, `audit_event` and `run` where they live
 * (S22). What is still derived here is what the server's three sources do
 * not carry: a note, and a net position somebody confirmed or amended.
 *
 * The change is deliberate and it is why every "derives a verification"
 * case below now passes `rows`. Deriving verifications from
 * `finding.verification` AS WELL would put the same act in the feed twice —
 * once with the current state, once per change — and an auditor reconciling
 * a feed against a history would find a discrepancy that is really a
 * duplicate.
 */

function finding(over: Partial<Finding> = {}): Finding {
  return { clauseId: 'c1', status: 'done', citations: [], verification: { state: 'unchecked' }, notes: [], ...over };
}
function review(over: Partial<Review> = {}): Review {
  return {
    id: 'r1', matterId: 'm1',
    playbookSnapshot: { id: 'v1', playbookId: 'p1', version: 1, name: 'Lease review', contractType: 'lease', systemPrompt: '', formatPrompt: '', clauses: [{ id: 'c1', title: 'Break right', extractPrompt: '' }], changeSummary: '', publishedAt: 1, publishedByUserId: 'u1', schemaVersion: 6 },
    documentIds: ['d1'], target: { kind: 'documents', documentIds: ['d1'] },
    findings: {}, modelId: 'm', startedAt: 100, createdByUserId: 'u1',
    ...over,
  };
}

const row = (over: Partial<ActivityRow> = {}): ActivityRow => ({
  at: 300, source: 'disposition', kind: 'verified', byUserId: 'me',
  reviewId: 'r1', reviewName: 'Lease review', clauseId: 'c1', clauseTitle: 'Break right',
  cause: 'human',
  ...over,
});

describe('the rows the server read, as feed entries', () => {
  it('reads a disposition change as its own kind, newest first', () => {
    const entries = activityEntries([
      row({ at: 100 }),
      row({ at: 300, kind: 'rejected' }),
    ], 'me');
    expect(entries.map(e => e.kind)).toEqual(['rejected', 'verified']);
    expect(entries[0].at).toBe(300);
    expect(entries[0].clauseTitle).toBe('Break right');
    expect(entries[0].reviewName).toBe('Lease review');
  });

  it('names both people in a contested finding, not just the local one', () => {
    const entries = activityEntries([
      row({ at: 100, byUserId: 'trainee' }),
      row({ at: 200, kind: 'rejected', byUserId: 'partner' }),
    ], 'trainee');
    expect(new Set(entries.map(e => e.byUserId))).toEqual(new Set(['trainee', 'partner']));
    expect(entries.find(e => e.byUserId === 'trainee')!.byYou).toBe(true);
    expect(entries.find(e => e.byUserId === 'partner')!.byYou).toBe(false);
  });

  it('derives byYou from byUserId, so the two cannot disagree', () => {
    // `byYou` was the only fact available before Stage 4 and is now derived.
    // The mutation: set it from anything else and this goes red.
    expect(activityEntries([row({ byUserId: 'someone-else' })], 'me')[0].byYou).toBe(false);
    expect(activityEntries([row({ byUserId: 'me' })], 'me')[0].byYou).toBe(true);
  });

  it('does not flatten a re-run reset into a person un-verifying something', () => {
    // §6.3: the two must never read the same. One is a person withdrawing a
    // judgement; the other is the system removing one that described an
    // answer which no longer exists.
    expect(activityEntries([
      row({ kind: 'unchecked', cause: 'rerun_reset' }),
    ], 'me')[0].kind).toBe('rerun');
    expect(activityEntries([
      row({ kind: 'unchecked', cause: 'human' }),
    ], 'me')[0].kind).toBe('cleared');
  });

  it('carries an audited act with the action that names it', () => {
    const [entry] = activityEntries([
      row({ source: 'audit', kind: 'document.added', clauseTitle: undefined, cause: undefined }),
    ], 'me');
    expect(entry.kind).toBe('audited');
    expect(entry.action).toBe('document.added');
  });

  it('keeps a run, and tells a cancelled one apart from a finished one', () => {
    const kinds = (state: string) =>
      activityEntries([row({ source: 'run', kind: state })], 'me')[0].kind;
    expect(kinds('running')).toBe('review-started');
    expect(kinds('succeeded')).toBe('review-completed');
    expect(kinds('cancelled')).toBe('run-cancelled');
  });

  it('drops an entry with no timestamp rather than dating it now', () => {
    // R-G9's rule, carried over verbatim: a feed whose ordering is invented
    // is worse than a feed with a gap.
    const entries = activityEntries([
      row(), { ...row(), at: Number.NaN }, { ...row(), at: undefined as unknown as number },
    ], 'me');
    expect(entries).toHaveLength(1);
    expect(entries.every(e => Number.isFinite(e.at))).toBe(true);
  });

  it('never puts a raw id where a name goes — it carries the id and nothing else', () => {
    // The renderer resolves it through the directory; this shape must not
    // pre-empt that with a fallback string, because a fallback here would be
    // a second place a person is named.
    const [entry] = activityEntries([row({ byUserId: 'ghost' })], 'me');
    expect(entry.byUserId).toBe('ghost');
    expect(entry.reviewName).toBe('Lease review');
  });
});

describe('matterActivity merges what the browser holds with what the server read', () => {
  it('derives notes and net-position confirmations, which no server source carries', () => {
    const entries = matterActivity([review({
      findings: { d1: { c1: finding({
        notes: [{ id: 'n1', findingId: 'd1::c1', text: 'Ask the client.', byUserId: 'me', at: 500 }],
        netPosition: { proposed: 'Six months.', state: 'confirmed', byUserId: 'me', at: 600, trail: [] },
      }) } },
    })], 'me');
    expect(entries.map(e => e.kind)).toEqual(['net-confirmed', 'note']);
  });

  it('reports an amended net position as amended, not merely confirmed', () => {
    const [entry] = matterActivity([review({
      findings: { d1: { c1: finding({
        netPosition: { proposed: 'Six months.', amended: 'Nine months.', state: 'confirmed', byUserId: 'me', at: 700, trail: [] },
      }) } },
    })], 'me');
    // Amending is a STRONGER claim than confirming — a person wrote every
    // word — so the feed must not flatten it into "confirmed".
    expect(entry.kind).toBe('net-amended');
  });

  it('does NOT re-derive a verification from the finding, which would double-count it', () => {
    // The disposition is read from `finding_disposition_event` through the
    // route. Deriving it here as well would show one act twice — once as its
    // current state and once per change — which is exactly the discrepancy
    // S22 exists to prevent, arriving from the other direction.
    const entries = matterActivity([review({
      findings: { d1: { c1: finding({ verification: { state: 'verified', byUserId: 'me', at: 300 } }) } },
    })], 'me', 20, [row({ at: 300 })]);
    expect(entries.map(e => e.kind)).toEqual(['verified']);
  });

  it('sorts both sources into one order and caps the whole list', () => {
    const rows = Array.from({ length: 30 }, (_, i) => row({ at: 1000 + i, clauseId: `c${i}` }));
    const notes = Array.from({ length: 30 }, (_, i) => ({
      id: `n${i}`, findingId: 'd1::c1', text: 'x', byUserId: 'me', at: 2000 + i,
    }));
    const entries = matterActivity(
      [review({ findings: { d1: { c1: finding({ notes }) } } })], 'me', 20, rows);
    expect(entries).toHaveLength(20);
    // The limit is applied to the MERGED list, so the newest twenty things
    // that happened win — not the newest twenty of one source.
    expect(entries.every(e => e.kind === 'note')).toBe(true);
    for (let i = 1; i < entries.length; i++) {
      expect(entries[i - 1].at).toBeGreaterThanOrEqual(entries[i].at);
    }
  });
});
