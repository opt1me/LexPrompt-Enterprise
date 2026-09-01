import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ActivityRow } from '@lexprompt/core';
import { ModelError } from '@lexprompt/core';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { mount, flushUntil } from '../../test/mount';
import { MatterActivity, AUDIT_VERB } from './MatterActivity';
import type { Finding, Review } from '../../types';

const activityFetch = vi.hoisted(() => vi.fn());
vi.mock('../../lib/api/activity', () => ({ getMatterActivity: activityFetch }));
vi.mock('../../lib/api/users', () => ({
  userName: (id?: string) => ({ me: 'A. Trainee', partner: 'R. Okafor' } as Record<string, string>)[id ?? ''],
  userInitials: (id?: string) => ({ me: 'AT', partner: 'RO' } as Record<string, string>)[id ?? ''],
  directoryLoaded: () => true,
  workspaceUsers: () => [],
}));

function finding(over: Partial<Finding> = {}): Finding {
  return { clauseId: 'c1', status: 'done', citations: [], verification: { state: 'unchecked' }, notes: [], ...over };
}
function review(over: Partial<Review> = {}): Review {
  return {
    id: 'r1', matterId: 'm1',
    playbookSnapshot: { id: 'v1', playbookId: 'p1', version: 1, name: 'Lease review', contractType: 'lease', systemPrompt: '', formatPrompt: '', clauses: [{ id: 'c1', title: 'Break right', extractPrompt: '' }], changeSummary: '', publishedAt: 1, publishedByUserId: 'u1', schemaVersion: 6 },
    documentIds: ['d1'], target: { kind: 'documents', documentIds: ['d1'] },
    findings: {}, modelId: 'm', startedAt: 100, createdByUserId: 'me',
    ...over,
  };
}

const row = (over: Partial<ActivityRow> = {}): ActivityRow => ({
  at: 300, source: 'disposition', kind: 'verified', byUserId: 'me',
  reviewId: 'r1', reviewName: 'Lease review', clauseId: 'c1', clauseTitle: 'Break right',
  cause: 'human',
  ...over,
});

beforeEach(() => { activityFetch.mockReset(); });

describe('MatterActivity', () => {
  it('says nothing is recorded rather than rendering a placeholder row', () => {
    const c = mount(<MatterActivity reviews={[]} localUserId="me" rows={[]} />);
    expect(c.textContent).toContain('Nothing recorded in this matter yet.');
    expect(c.querySelectorAll('li')).toHaveLength(0);
  });

  it('writes your own actions in the first person', () => {
    const c = mount(<MatterActivity reviews={[]} localUserId="me" rows={[row()]} />);
    expect(c.textContent).toContain('You verified');
    expect(c.textContent).toContain('Break right');
  });

  it('NAMES a colleague, because as of Stage 4 there are people to name', () => {
    /*
     * The clause of `CLAUDE.md` this task makes false, asserted in its new
     * form. Before Stage 4 this line read a passive "Rejected" and named
     * nobody, because there was nobody to name; a matter is now worked on by
     * a workspace, and a feed that hid whose rejection it was would hide the
     * one fact a reader needs.
     */
    const c = mount(
      <MatterActivity reviews={[]} localUserId="me"
        rows={[row({ kind: 'rejected', byUserId: 'partner' })]} />);
    expect(c.textContent).toContain('R. Okafor rejected');
    expect(c.textContent).not.toContain('You rejected');
  });

  it('never prints an id for an author the directory cannot name', () => {
    // A raw uuid says nothing to a reader while looking like it should, and
    // "no longer in this workspace" would be a claim about a person made on
    // the strength of a failed fetch.
    const c = mount(
      <MatterActivity reviews={[]} localUserId="me" rows={[row({ byUserId: 'ghost' })]} />);
    expect(c.textContent).not.toContain('ghost');
    expect(c.textContent).toContain('Someone this workspace does not name');
    expect(c.textContent).not.toMatch(/no longer|left the firm|former/i);
  });

  it('never says a flag was raised FOR anybody', () => {
    // "…flagged for M. Okafor" is dropped: a flag is flagged, full stop.
    // Flagging still reaches no one — the assignment surface is Stage 5.
    const c = mount(
      <MatterActivity reviews={[]} localUserId="me" rows={[row({ kind: 'flagged' })]} />);
    expect(c.textContent).not.toMatch(/flagged for/i);
  });

  it('renders a re-run as a re-run, never as somebody un-verifying something', () => {
    const c = mount(
      <MatterActivity reviews={[]} localUserId="me"
        rows={[row({ kind: 'unchecked', cause: 'rerun_reset', byUserId: 'partner' })]} />);
    expect(c.textContent).toContain('R. Okafor re-ran');
    expect(c.textContent).not.toMatch(/cleared the check/);
  });

  it('names an audited act with its own verb', () => {
    const c = mount(
      <MatterActivity reviews={[]} localUserId="me"
        rows={[row({ source: 'audit', kind: 'document.added', byUserId: 'partner',
          clauseTitle: undefined, cause: undefined })]} />);
    // The verb is a COMPLETE SENTENCE and takes no subject: an audited act
    // is recorded against the matter, and the feed is that matter's own
    // page. This used to read "…added a document to This matter".
    expect(c.textContent).toContain('R. Okafor added a document');
    expect(c.textContent).not.toMatch(/This matter/);
  });

  it('still renders a note from the reviews it holds', () => {
    const c = mount(<MatterActivity localUserId="me" rows={[]} reviews={[review({
      findings: { d1: { c1: finding({
        notes: [{ id: 'n1', findingId: 'd1::c1', text: 'Ask the client.', byUserId: 'partner', at: 500 }],
      }) } },
    })]} />);
    expect(c.textContent).toContain('R. Okafor noted on');
  });

  it('SAYS a failed read rather than showing a shorter feed', async () => {
    /*
     * The disposition changes, the runs and the audited acts all live
     * server-side now, so a failed read removes most of this list — and a
     * shorter list is indistinguishable from a quieter matter. That is the
     * founding defect at a new surface, and the mutation is to swallow the
     * rejection and render an empty feed.
     */
    activityFetch.mockRejectedValue(
      new ModelError('LexPrompt could not reach your firm s service.', 'network', 0));
    const c = mount(<MatterActivity reviews={[]} localUserId="me" matterId="m1" />);
    await flushUntil(() => c.querySelector('[data-activity-error]') !== null,
      'the failed activity read to be said');
    expect(c.textContent).toContain('could not reach');
    expect(c.textContent).toContain('are not shown below');
    // …and it must NOT read as an empty matter.
    expect(c.textContent).not.toContain('Nothing recorded in this matter yet.');
  });

  it('reads the matter s activity from the server when given a matter id', async () => {
    activityFetch.mockResolvedValue([row({ byUserId: 'partner', kind: 'rejected' })]);
    const c = mount(<MatterActivity reviews={[]} localUserId="me" matterId="m1" />);
    await flushUntil(() => /R\. Okafor rejected/.test(c.textContent ?? ''),
      'the server s rows to arrive');
    expect(activityFetch).toHaveBeenCalledWith('m1');
  });
});

/*
 * THE WORDING OF AN AUDITED ACT.
 *
 * Found in a browser: the feed read *"You added a document to This matter"*
 * — a capital "This" mid-sentence, naming the page the reader was already
 * looking at. Two faults in one line. The audit arm of
 * `GET /v1/matters/:id/activity` selects `null` for `review_name`, so the
 * subject appended was `activityEntries`' placeholder; and an audited act
 * has no review to be about in the first place, so it should never have
 * been given a subject.
 *
 * The guard below is over the WHOLE map rather than over the two lines that
 * happen to exist today, because the property is a property of the map: a
 * verb added later ending in "to" or "on" would render as a fragment, and
 * nothing else would notice.
 */
describe('MatterActivity — an audited act reads as a whole sentence', () => {
  const auditRow = (action: string) => row({
    source: 'audit', kind: action, byUserId: 'me',
    reviewName: undefined, clauseTitle: undefined, cause: undefined,
  });

  it('has a verb map that is not empty, and no entry is a fragment', () => {
    // The sanity half FIRST: a scan over an empty map passes vacuously, and
    // this project has shipped eighteen guards that were not guarding.
    const actions = Object.keys(AUDIT_VERB);
    expect(actions.length).toBeGreaterThan(10);
    expect(actions).toContain('document.added');

    for (const [action, verbs] of Object.entries(AUDIT_VERB)) {
      for (const phrasing of [verbs.you, verbs.passive]) {
        expect(
          /\b(to|on|from|for|of|with|into)$/i.test(phrasing),
          `${action} reads "${phrasing}", a fragment waiting for a subject the `
          + 'audit feed never supplies',
        ).toBe(false);
      }
    }
  });

  it('renders every audited act with no subject appended, and never the words "This matter"', () => {
    for (const action of Object.keys(AUDIT_VERB)) {
      const c = mount(<MatterActivity reviews={[]} localUserId="me" rows={[auditRow(action)]} />);
      const li = c.querySelector('li');
      expect(li, `${action} rendered no feed line at all`).toBeTruthy();
      // The line is exactly the verb plus the timestamp — nothing else.
      expect(li!.textContent).toContain(AUDIT_VERB[action].you);
      expect(li!.textContent).not.toMatch(/this matter\b/i);
      expect(li!.textContent).not.toMatch(/this review\b/i);
    }
  });

  it('names an action it does not recognise rather than dropping the line', () => {
    const c = mount(<MatterActivity reviews={[]} localUserId="me" rows={[auditRow('matter.teleported')]} />);
    expect(c.textContent).toContain('matter.teleported');
    expect(c.querySelectorAll('li')).toHaveLength(1);
  });
});

/*
 * Found in a browser: two documents were added to a matter, both
 * `audit_event` rows were written and correctly scoped, and this panel went
 * on showing only "You opened this matter" until the page was reloaded by
 * hand. It reads once on mount, and adding a document does not remount it —
 * a snapshot presented as a current account of the matter.
 *
 * `refreshKey` is what closes it. It is NOT a live subscription and these
 * tests do not claim one: audited acts are not in §8's outbox, so nothing
 * pushes a `document.added` to any client.
 */
describe('MatterActivity — the feed is re-read when this tab changes the matter', () => {
  function render(refreshKey: string) {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => { root.render(<MatterActivity reviews={[]} localUserId="me" matterId="m1" refreshKey={refreshKey} />); });
    return {
      container,
      update: (next: string) => {
        act(() => { root.render(<MatterActivity reviews={[]} localUserId="me" matterId="m1" refreshKey={next} />); });
      },
      unmount: () => { act(() => { root.unmount(); }); container.remove(); },
    };
  }

  it('re-reads when the caller s signature of this tab s content changes', async () => {
    activityFetch.mockResolvedValue([]);
    const el = render('d1');
    await flushUntil(() => activityFetch.mock.calls.length === 1, 'the first read');

    activityFetch.mockResolvedValue([row({
      source: 'audit', kind: 'document.added', byUserId: 'me',
      reviewName: undefined, clauseTitle: undefined, cause: undefined,
    })]);
    el.update('d1 d2');
    await flushUntil(() => /You added a document/.test(el.container.textContent ?? ''),
      'the newly-added document to appear in the feed');
    expect(activityFetch).toHaveBeenCalledTimes(2);
    el.unmount();
  });

  it('does NOT re-read when the signature is unchanged', async () => {
    // The sanity half: the parse poll re-reads the document list every few
    // seconds while a document is still being read, and a feed that
    // re-fetched on every one of those would be a request loop, not a fix.
    activityFetch.mockResolvedValue([]);
    const el = render('d1');
    await flushUntil(() => activityFetch.mock.calls.length === 1, 'the first read');

    el.update('d1');
    await flushUntil(() => true, 'a render to settle');
    expect(activityFetch).toHaveBeenCalledTimes(1);
    el.unmount();
  });
});
