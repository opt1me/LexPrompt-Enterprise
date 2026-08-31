import { describe, it, expect, vi } from 'vitest';
import type { AssignmentInboxPage, AssignmentView } from '@lexprompt/core';
import { ModelError } from '@lexprompt/core';
import {
  assignmentChanged, watchAssignedToMe, type AssignedToMe, type AssignmentSubscribe,
} from './assignedToMe';

/**
 * A COUNTER THAT NEVER SAYS ZERO WHEN IT DOES NOT KNOW.
 *
 * The mutation every test here exists for: initialise the state to
 * `{ status: 'ready', count: 0 }`, or flatten the rejection into an empty
 * page. Either one renders "nothing is waiting for you" over a failed read,
 * which is a lawyer not doing something a colleague is waiting on and looks
 * exactly like a quiet week.
 */

const ME = 'u-me';

const page = (n: number, capped = false): AssignmentInboxPage => ({
  items: Array.from({ length: n }, (_, i) => ({
    assignment: {
      id: `a${i}`, reviewId: 'r1', findingsKey: 'd1', clauseId: `c${i}`,
      assigneeUserId: ME, assignedByUserId: 'u-them', createdAt: 1,
    },
    matterId: 'm1', matterName: 'Matter A',
  })),
  capped,
});

const frame = (assigneeUserId: string): AssignmentView => ({
  id: 'a-new', reviewId: 'r1', findingsKey: 'd1', clauseId: 'c9',
  assigneeUserId, assignedByUserId: 'u-them', createdAt: 2,
});

/** A `subscribe` a test can fire by hand. */
function fakeSubscribe(): {
  subscribe: AssignmentSubscribe; fire: (a: AssignmentView) => void; listeners: () => number;
} {
  const set = new Set<(a: AssignmentView) => void>();
  return {
    subscribe: (on) => { set.add(on); return () => { set.delete(on); }; },
    fire: (a) => { for (const on of [...set]) on(a); },
    listeners: () => set.size,
  };
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};

describe('the three states, and the third is the point', () => {
  it('starts in loading and never in ready-zero', async () => {
    const seen: AssignedToMe[] = [];
    const stop = watchAssignedToMe(s => seen.push(s), {
      load: () => new Promise<AssignmentInboxPage>(() => {}),
      subscribe: fakeSubscribe().subscribe,
      meId: ME,
    });
    await settle();
    expect(seen[0]).toEqual({ status: 'loading' });
    // THE MUTATION THIS KILLS: `let state = { status: 'ready', count: 0 }`.
    expect(seen.some(s => s.status === 'ready')).toBe(false);
    stop();
  });

  it('reports a failed read as an error carrying describeLoadError s sentence', async () => {
    const seen: AssignedToMe[] = [];
    const stop = watchAssignedToMe(s => seen.push(s), {
      // A `ModelError` is what the transport actually rejects with, and
      // `describeLoadError` passes its message through rather than replacing
      // it with a generic one.
      load: () => Promise.reject(new ModelError(
        "LexPrompt could not reach your firm's service (offline).", 'network', 0)),
      subscribe: fakeSubscribe().subscribe,
      meId: ME,
    });
    await settle();
    expect(seen.at(-1)?.status).toBe('error');
    expect((seen.at(-1) as { message: string }).message).toContain('offline');
    stop();
  });

  it('falls back to a subject-specific sentence for an opaque failure', async () => {
    const seen: AssignedToMe[] = [];
    const stop = watchAssignedToMe(s => seen.push(s), {
      load: () => Promise.reject(new Error('TypeError: undefined is not a function')),
      subscribe: fakeSubscribe().subscribe,
      meId: ME,
    });
    await settle();
    // Never the raw exception text, which says nothing a reader can act on.
    expect((seen.at(-1) as { message: string }).message)
      .toBe('LexPrompt could not read what has been asked of you.');
    stop();
  });

  it('carries capped through, so a screen can say 200+ rather than a wrong number', async () => {
    const seen: AssignedToMe[] = [];
    const stop = watchAssignedToMe(s => seen.push(s), {
      load: () => Promise.resolve(page(200, true)),
      subscribe: fakeSubscribe().subscribe,
      meId: ME,
    });
    await settle();
    expect(seen.at(-1)).toEqual({
      status: 'ready', count: 200, capped: true, matters: ['Matter A'],
    });
    stop();
  });
});

describe('a frame is a doorbell, and only for requests addressed to me', () => {
  it('re-reads when the socket says a request addressed to me changed', async () => {
    const load = vi.fn().mockResolvedValue(page(1));
    const bus = fakeSubscribe();
    const seen: AssignedToMe[] = [];
    const stop = watchAssignedToMe(s => seen.push(s), {
      load, subscribe: bus.subscribe, meId: ME,
    });
    await settle();
    expect(load).toHaveBeenCalledTimes(1);

    load.mockResolvedValue(page(2));
    bus.fire(frame(ME));
    await settle();
    expect(load).toHaveBeenCalledTimes(2);
    // The COUNT came from the read, not from the frame. A count incremented
    // on a push diverges the first time a frame is missed.
    expect(seen.at(-1)).toEqual({
      status: 'ready', count: 2, capped: false, matters: ['Matter A'],
    });
    stop();
  });

  it('does not re-read for somebody else s assignment', async () => {
    const load = vi.fn().mockResolvedValue(page(1));
    const bus = fakeSubscribe();
    const stop = watchAssignedToMe(() => {}, { load, subscribe: bus.subscribe, meId: ME });
    await settle();
    expect(load).toHaveBeenCalledTimes(1);
    // The frame carries the whole row and the socket has no per-recipient
    // filter, so without the guard every assignment in the workspace costs
    // every open tab a read.
    bus.fire(frame('u-someone-else'));
    await settle();
    expect(load).toHaveBeenCalledTimes(1);
    stop();
  });

  it('re-reads for nobody at all while this tab does not know who it belongs to', async () => {
    const load = vi.fn().mockResolvedValue(page(1));
    const bus = fakeSubscribe();
    // `assignmentParty`'s rule, one layer along: an unknown reader is a
    // bystander, never a party.
    const stop = watchAssignedToMe(() => {}, { load, subscribe: bus.subscribe });
    await settle();
    bus.fire(frame(ME));
    await settle();
    expect(load).toHaveBeenCalledTimes(1);
    stop();
  });

  it('coalesces a burst into one re-read, and does not lose the last one', async () => {
    let resolve: (p: AssignmentInboxPage) => void = () => {};
    const load = vi.fn()
      .mockImplementationOnce(() => new Promise<AssignmentInboxPage>(r => { resolve = r; }))
      .mockResolvedValue(page(3));
    const bus = fakeSubscribe();
    const seen: AssignedToMe[] = [];
    const stop = watchAssignedToMe(s => seen.push(s), {
      load, subscribe: bus.subscribe, meId: ME,
    });
    // Three frames while the first read is still in flight.
    bus.fire(frame(ME));
    bus.fire(frame(ME));
    bus.fire(frame(ME));
    expect(load).toHaveBeenCalledTimes(1);
    resolve(page(1));
    await settle();
    // ONE trailing re-read, not three — and not zero, which would leave the
    // counter a request behind whenever a push landed mid-read.
    expect(load).toHaveBeenCalledTimes(2);
    expect(seen.at(-1)).toEqual({
      status: 'ready', count: 3, capped: false, matters: ['Matter A'],
    });
    stop();
  });

  it('stops calling back after the unsubscribe, and drops its listener', async () => {
    const load = vi.fn().mockResolvedValue(page(1));
    const bus = fakeSubscribe();
    const seen: AssignedToMe[] = [];
    const stop = watchAssignedToMe(s => seen.push(s), {
      load, subscribe: bus.subscribe, meId: ME,
    });
    await settle();
    stop();
    expect(bus.listeners()).toBe(0);
    const after = seen.length;
    bus.fire(frame(ME));
    await settle();
    expect(load).toHaveBeenCalledTimes(1);
    expect(seen).toHaveLength(after);
  });
});

describe('the default fan-out is the one App feeds', () => {
  it('delivers a frame announced through assignmentChanged', async () => {
    const load = vi.fn().mockResolvedValue(page(1));
    const stop = watchAssignedToMe(() => {}, { load, meId: ME });
    await settle();
    assignmentChanged(frame(ME));
    await settle();
    expect(load).toHaveBeenCalledTimes(2);
    stop();
    // …and stops afterwards, so a remounted header does not leave a listener
    // behind reading the inbox forever.
    assignmentChanged(frame(ME));
    await settle();
    expect(load).toHaveBeenCalledTimes(2);
  });
});
