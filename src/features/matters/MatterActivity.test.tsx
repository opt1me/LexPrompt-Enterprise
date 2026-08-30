import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ActivityRow } from '@lexprompt/core';
import { ModelError } from '@lexprompt/core';
import { mount, flushUntil } from '../../test/mount';
import { MatterActivity } from './MatterActivity';
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
    expect(c.textContent).toContain('R. Okafor added a document to');
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
