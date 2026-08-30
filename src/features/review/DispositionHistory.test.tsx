import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ModelError } from '@lexprompt/core';
import { makeFakeTransport, transportModule } from '../../test/fakeTransport';
import { mount, flushUntil, buttonNamed, click } from '../../test/mount';
import { HISTORY_EVENTS, RERUN_EVENT, TEST_AUDIENCE } from '../../test/dispositionShapes';

/**
 * THE RECORD BEHIND A DISPOSITION, REACHABLE IN ONE ACTION (§6.3).
 *
 * The card's line says what the disposition is now; this says how it got
 * there. What is worth testing is not "it lists things" — it is the three
 * ways this panel could tell a reader something untrue:
 *
 *  - a failed FETCH rendering as "no changes", which is a change that
 *    failed to record itself and a network blip, made indistinguishable;
 *  - a re-run reset rendering as a person un-verifying, which §6.3 names as
 *    two different acts;
 *  - an empty history rendering as a blank panel, which is the blank-CSV-
 *    cell defect in a modal.
 */

const transport = makeFakeTransport();
vi.mock('../../lib/api/client', () => transportModule(transport));

const { DispositionHistory } = await import('./DispositionHistory');

const PATH = '/v1/reviews/rev-1/findings/d1/c1/history';

const props = {
  reviewId: 'rev-1',
  findingsKey: 'd1',
  clauseId: 'c1',
  audience: TEST_AUDIENCE,
  onClose: () => {},
};

beforeEach(() => {
  transport.reset();
  transport.responses.set(PATH, { events: HISTORY_EVENTS });
});

const lines = (container: ParentNode): (string | null)[] =>
  [...container.querySelectorAll('[data-history-line]')].map(n => n.textContent);

describe('DispositionHistory', () => {
  it('lists every change, newest first, each with its actor, its time and its cause', async () => {
    const container = mount(<DispositionHistory {...props} />);
    await flushUntil(() => lines(container).length > 0, 'the history to arrive');
    expect(lines(container)).toEqual([
      'Rejected by R. Okafor, 16:04 - was Verified. "The cap is uncapped in clause 14.2."',
      'Verified by A. Trainee, 15:12',
    ]);
  });

  it('renders a re-run reset as a re-run, not as a person un-verifying', async () => {
    // The one line in this panel a reader could act on wrongly. §6.3: the
    // two are different acts and the history distinguishes them.
    transport.responses.set(PATH, { events: [RERUN_EVENT] });
    const container = mount(<DispositionHistory {...props} />);
    await flushUntil(() => lines(container).length > 0, 'the re-run event to arrive');
    expect(container.textContent).toContain('this clause was re-run by A. Trainee at 11:07');
    expect(container.textContent).not.toContain('un-verified');
    expect(container.textContent).not.toContain('cleared by');
  });

  it('shows a load failure as a failure, never as an empty history', async () => {
    /*
     * An empty history under a non-unchecked disposition is
     * indistinguishable from a change that failed to record itself — the
     * ambiguity §6.4's one-transaction rule exists to make impossible. A
     * failed FETCH must not manufacture it.
     *
     * The mutation this exists for: `.catch(() => setEvents([]))` in the
     * component. The panel then reads "This finding has not been changed
     * since the review ran" over a clause somebody rejected an hour ago,
     * and this is the only assertion that goes red.
     */
    transport.failures.set(PATH, new ModelError('The service could not be reached.', 'network', 0));
    const container = mount(<DispositionHistory {...props} />);
    await flushUntil(() => container.querySelector('[data-load-error]') !== null,
      'the load error panel');
    expect(container.textContent).not.toContain('has not been changed');
    expect(container.textContent).toContain('The service could not be reached.');
    expect(lines(container)).toEqual([]);
  });

  it('offers a retry that re-reads, rather than re-rendering what failed', async () => {
    transport.failures.set(PATH, new ModelError('down', 'network', 0));
    const container = mount(<DispositionHistory {...props} />);
    await flushUntil(() => container.querySelector('[data-load-error]') !== null,
      'the load error panel');
    transport.failures.clear();
    click(buttonNamed(container, /retry/i));
    await flushUntil(() => lines(container).length > 0, 'the history after a retry');
    expect(container.querySelector('[data-load-error]')).toBeNull();
    expect(lines(container)).toHaveLength(2);
  });

  it('says a never-touched finding has no history, and says it in those words', async () => {
    transport.responses.set(PATH, { events: [] });
    const container = mount(<DispositionHistory {...props} />);
    await flushUntil(() => container.textContent!.includes('has not been changed'),
      'the empty-history sentence');
    // A sentence rather than a blank panel: an empty list styled as a list
    // is the blank-CSV-cell defect in a modal.
    expect(container.textContent).toContain('This finding has not been changed since the review ran.');
    expect(lines(container)).toEqual([]);
  });

  it('says it is still reading before the answer arrives, rather than showing nothing', async () => {
    const container = mount(<DispositionHistory {...props} />);
    // Synchronously after mount, before any microtask has run.
    expect(container.textContent).toContain('Reading the history');
    await flushUntil(() => lines(container).length > 0, 'the history to arrive');
    expect(container.textContent).not.toContain('Reading the history');
  });

  it('reads the route Stage 3 shipped, at the key it was given', async () => {
    // Never a document id chosen from a collection's members: this panel is
    // handed the findings key the SERVER stated on the disposition.
    transport.responses.set('/v1/reviews/rev-1/findings/col-1/c9/history',
      { events: [HISTORY_EVENTS[1]] });
    const container = mount(
      <DispositionHistory {...props} findingsKey="col-1" clauseId="c9" />,
    );
    await flushUntil(() => lines(container).length > 0 || container.querySelector('[data-load-error]') !== null,
      'the collection-keyed history');
    expect(lines(container)).toEqual(['Verified by A. Trainee, 15:12']);
  });

  it('describes an event exactly as the card describes the disposition it produced', async () => {
    // One function, two surfaces. A panel composing its own sentence is
    // where the DOCX and the CSV drifted apart, one layer over.
    const { dispositionHistoryLine } = await import('../../lib/findingOutcome');
    const container = mount(<DispositionHistory {...props} />);
    await flushUntil(() => lines(container).length > 0, 'the history to arrive');
    expect(lines(container)).toEqual(
      HISTORY_EVENTS.map(e => dispositionHistoryLine(e, TEST_AUDIENCE)));
  });
});
