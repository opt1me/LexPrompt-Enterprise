import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Matter, Review, DocumentRecord, PlaybookVersion } from './types';
import type { AppEvent } from '@lexprompt/core';
import { flushUntil } from './test/mount';
import { TEST_ALLOWED_MODEL } from './test/allowedModel';

/**
 * §18 ITEM 5'S HEADLINE CLAUSE: somebody else's change reaches the card,
 * attributed, without a reload.
 *
 * This and Task 5's render test are, together, the whole of what can be
 * claimed for that clause without a browser.
 *
 * The five rules the handler obeys, each of which is a defect if dropped:
 * the version guard first; apply from the PAYLOAD rather than by
 * re-fetching; never over a decision in progress (`mayApplyNow` — the same
 * function, not a second copy); a note APPENDS; and a `run.*` event still
 * routes to `refreshFindings`, which is `watchRun`'s path and not this one.
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// --- Repository mocks, the same seams App.verification.test.tsx drives ---

const listPlaybooksMock = vi.fn();
const listMattersMock = vi.fn();
const listReviewsMock = vi.fn();
const getMatterMock = vi.fn();
const listDocumentsMock = vi.fn();
const getDocumentMock = vi.fn();
const getDocumentBlobMock = vi.fn();
const getReviewMock = vi.fn();
const saveReviewMock = vi.fn();
const getProfileMock = vi.fn();

vi.mock('./lib/db/playbooks', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./lib/db/playbooks')>()),
  listPlaybooks: (...args: unknown[]) => listPlaybooksMock(...args),
  getPlaybook: vi.fn(),
  getPlaybookContent: vi.fn().mockResolvedValue(null),
  savePlaybook: vi.fn(),
  deletePlaybook: vi.fn(),
  newPlaybook: vi.fn(),
  exportPlaybook: vi.fn(),
  importPlaybook: vi.fn(),
}));

vi.mock('./lib/db/matters', () => ({
  listMatters: (...args: unknown[]) => listMattersMock(...args),
  getMatter: (...args: unknown[]) => getMatterMock(...args),
  saveMatter: vi.fn(), newMatter: vi.fn(), deleteMatter: vi.fn(),
}));

vi.mock('./lib/db/documents', () => ({
  listDocuments: (...args: unknown[]) => listDocumentsMock(...args),
  getDocument: (...args: unknown[]) => getDocumentMock(...args),
  addDocument: vi.fn(), deleteDocument: vi.fn(),
}));

vi.mock('./lib/db/blobs', () => ({
  getDocumentBlob: (...args: unknown[]) => getDocumentBlobMock(...args),
}));

vi.mock('./lib/db/reviews', () => ({
  listReviews: (...args: unknown[]) => listReviewsMock(...args),
  getReview: (...args: unknown[]) => getReviewMock(...args),
  saveReview: (...args: unknown[]) => saveReviewMock(...args),
}));

vi.mock('./lib/db/profile', () => ({
  getProfile: (...args: unknown[]) => getProfileMock(...args),
  getCachedRole: () => undefined,
}));

vi.mock('./lib/db/workspaceSettings', () => ({
  getWorkspaceSettings: vi.fn().mockResolvedValue(
    { modelChoiceId: '', concurrency: 5, version: 1, updatedAt: 1 }),
  saveWorkspaceSettings: vi.fn(),
}));

vi.mock('./lib/model/gatewayModelClient', () => ({
  gatewayModelClient: {
    chat: vi.fn(), chatJson: vi.fn(), chatStream: vi.fn(),
    listModels: vi.fn().mockResolvedValue([TEST_ALLOWED_MODEL]),
  },
}));

/**
 * THE DIRECTORY, so an id can become a NAME. Without this the card renders
 * "someone" and the assertion below would be about a sentence nobody sees.
 */
vi.mock('./lib/api/users', () => ({
  loadDirectory: vi.fn().mockResolvedValue(undefined),
  userName: (id: string) => (id === 'u2' ? 'R. Okafor' : id === 'u1' ? 'A. Trainee' : undefined),
  // Task 25's assign panel resolves both of these through the one directory
  // module (P32). A factory mock replaces the WHOLE module, so an export it
  // omits is a hard failure inside a component the moment it renders --
  // which is what these two lines are, rather than test scaffolding.
  userInitials: (id: string) => (id === 'u2' ? 'RO' : id === 'u1' ? 'AT' : undefined),
  directoryLoaded: () => true,
  workspaceUsers: () => [
    { id: 'u1', displayName: 'A. Trainee', initials: 'AT', role: 'reviewer', status: 'active' },
    { id: 'u2', displayName: 'R. Okafor', initials: 'RO', role: 'partner', status: 'active' },
  ],
}));

/**
 * THE ASSIGNMENTS READ. Mocked so a review opens with a known list rather
 * than a rejected fetch — the push tests below are about what ARRIVES, and a
 * failed read would render the error panel instead.
 */
const getOpenAssignmentsMock = vi.fn().mockResolvedValue([]);
vi.mock('./lib/api/assignments', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./lib/api/assignments')>()),
  getOpenAssignments: (...args: unknown[]) => getOpenAssignmentsMock(...args),
  createAssignment: vi.fn(),
  resolveAssignment: vi.fn(),
}));

const getFindingsMock = vi.fn();
const setDispositionMock = vi.fn();
const addNoteMock = vi.fn();

vi.mock('./lib/api/findings', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./lib/api/findings')>()),
  getFindings: (...args: unknown[]) => getFindingsMock(...args),
  setDisposition: (...args: unknown[]) => setDispositionMock(...args),
  addNote: (...args: unknown[]) => addNoteMock(...args),
  setNetPosition: vi.fn(),
}));

vi.mock('./lib/api/runs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./lib/api/runs')>()),
  startRun: vi.fn(),
  getRun: vi.fn(),
  cancelRun: vi.fn(),
  liveRunFor: vi.fn().mockResolvedValue(null),
  watchRun: vi.fn(() => () => { /* no live run in this file */ }),
}));

/**
 * THE SOCKET SEAM. `subscribe` is mocked so a test can deliver a frame the
 * way the server does; `onConnectionState` is left inert because this file
 * is about what a push DOES, and Task 20's suites are about what a dropped
 * one looks like.
 */
let deliverPush: ((event: AppEvent) => void) | null = null;
let triggerResync: (() => void) | null = null;
const closeSubscriptionMock = vi.fn();
const subscribeMock = vi.fn((
  _sub: unknown, handlers: { onEvent(e: AppEvent): void; onResync(): void },
) => {
  deliverPush = handlers.onEvent;
  triggerResync = handlers.onResync;
  return { close: closeSubscriptionMock };
});

vi.mock('./lib/api/socket', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./lib/api/socket')>()),
  subscribe: (...args: unknown[]) =>
    (subscribeMock as unknown as (...a: unknown[]) => { close(): void })(...args),
  onConnectionState: () => () => { /* Task 20's business, not this file's */ },
}));

import App from './App';
import { forgetFindingVersions, rememberPushedDisposition } from './lib/api/findings';

const flush = async (times = 8): Promise<void> => {
  for (let i = 0; i < times; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await act(async () => { await Promise.resolve(); });
  }
};

const T_1512 = Date.UTC(2026, 0, 5, 15, 12);
const T_1604 = Date.UTC(2026, 0, 5, 16, 4);

/**
 * WHAT THE READ WOULD HAVE PUT IN THE MODULE CACHE.
 *
 * `getFindings` is mocked in this file, so the real one -- which is what
 * calls `rememberDispositions` -- never runs, and the browser would hold no
 * disposition for this cell at all. That is not the state a real reader is
 * in, and it matters: a card with NO remembered disposition has nothing to
 * hold BACK, so every P36 assertion below would pass vacuously.
 *
 * Seeded through the shipped recorder rather than by reaching into the
 * module, so what is planted is exactly the shape a read plants.
 */
function seedReadDisposition(): void {
  rememberPushedDisposition(
    {
      reviewId: 'r1', findingsKey: 'd1', clauseId: 'c1', state: 'verified',
      byUserId: 'u1', at: T_1512, changedCount: 1, version: 1,
    },
    {
      id: 1, fromState: 'unchecked', toState: 'verified', cause: 'human',
      byUserId: 'u1', at: T_1512,
    },
  );
}

function makeMatter(): Matter {
  return { id: 'm1', name: 'Acme v Bolt', ownerId: 'u1', createdAt: 1, updatedAt: 1 };
}

function makeTemplate(): PlaybookVersion {
  return {
    id: 't1', name: 'Basic Contract Review', contractType: 'NDA',
    systemPrompt: '', formatPrompt: '',
    clauses: [{ id: 'c1', title: 'Governing Law', extractPrompt: 'Extract it.' }],
    playbookId: 'pb', version: 1, changeSummary: '', publishedAt: 1,
    publishedByUserId: '', schemaVersion: 6,
  };
}

function makeDocumentRecord(): DocumentRecord {
  return {
    id: 'd1', matterId: 'm1', name: 'nda.txt', kind: 'txt',
    text: 'This is the contract text.', byteSize: 27, addedAt: 1,
    addedByUserId: 'u1', role: 'standalone',
  };
}

/** One review, one clause, VERIFIED by the trainee at 15:12. */
function makeReview(): Review {
  return {
    id: 'r1', matterId: 'm1', playbookSnapshot: makeTemplate(),
    documentIds: ['d1'], target: { kind: 'documents', documentIds: ['d1'] },
    findings: {
      d1: {
        c1: {
          clauseId: 'c1', status: 'done',
          citations: [{ quote: 'x', documentId: 'd1' }],
          summary: 'Governed by NY law.',
          verification: { state: 'verified', byUserId: 'u1', at: T_1512 },
          notes: [],
        },
      },
    },
    modelId: 'test/model', startedAt: 1, completedAt: 2, createdByUserId: 'u1',
  };
}

/** What the findings read answers, INCLUDING the disposition map — which is
 *  what puts version 1 into the browser's cache, so the guard below has a
 *  number to compare against. */
function serverFindings(): void {
  getFindingsMock.mockResolvedValue({
    findings: makeReview().findings,
    dispositionVersions: { d1: { c1: 1 } },
    dispositions: {
      d1: {
        c1: {
          disposition: {
            reviewId: 'r1', findingsKey: 'd1', clauseId: 'c1', state: 'verified',
            byUserId: 'u1', at: T_1512, changedCount: 1, version: 1,
          },
          last: {
            id: 1, fromState: 'unchecked', toState: 'verified', cause: 'human',
            byUserId: 'u1', at: T_1512,
          },
        },
      },
    },
    version: 1,
  });
}

/** The partner's rejection, as the server sends it: the whole new row AND
 *  the event that produced it, on ONE frame. */
function partnerRejection(version = 2): AppEvent {
  return {
    id: 100 + version, type: 'finding.disposition_changed',
    workspaceId: 'ws-1', matterId: 'm1', reviewId: 'r1', at: T_1604,
    payload: {
      reviewId: 'r1', findingsKey: 'd1', clauseId: 'c1', version,
      disposition: {
        reviewId: 'r1', findingsKey: 'd1', clauseId: 'c1', state: 'rejected',
        reason: 'The cap is uncapped in clause 14.2.',
        byUserId: 'u2', at: T_1604, changedCount: 2, version,
      },
      event: {
        id: 2, fromState: 'verified', toState: 'rejected', cause: 'human',
        byUserId: 'u2', at: T_1604,
      },
    },
  };
}

describe('someone else s write arrives, and the card changes without a reload', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    localStorage.clear();
    // The module cache is per TAB in the app and per FILE here; a review's
    // remembered versions surviving between tests would make the version
    // guard pass or fail for reasons no test states.
    forgetFindingVersions('r1');
    seedReadDisposition();
    deliverPush = null;
    triggerResync = null;
    subscribeMock.mockClear();
    closeSubscriptionMock.mockClear();
    listPlaybooksMock.mockReset().mockResolvedValue([]);
    listMattersMock.mockReset().mockResolvedValue([]);
    listReviewsMock.mockReset().mockResolvedValue([]);
    getMatterMock.mockReset().mockResolvedValue(makeMatter());
    listDocumentsMock.mockReset().mockResolvedValue([]);
    getDocumentMock.mockReset().mockResolvedValue(makeDocumentRecord());
    getDocumentBlobMock.mockReset().mockResolvedValue(null);
    getReviewMock.mockReset().mockResolvedValue(makeReview());
    saveReviewMock.mockReset().mockResolvedValue(undefined);
    getProfileMock.mockReset().mockResolvedValue({ id: 'u1', name: 'A. Trainee', initials: 'AT' });
    getFindingsMock.mockReset();
    serverFindings();
    setDispositionMock.mockReset();
    addNoteMock.mockReset();

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => { root.unmount(); });
    container.remove();
  });

  async function openReview(): Promise<void> {
    window.history.pushState(null, '', '/matters/m1/reviews/r1');
    act(() => { root.render(<App />); });
    await flushUntil(
      () => !(container.textContent ?? '').includes('Loading review'),
      'the review to finish loading',
    );
    await flush();
  }

  async function push(event: AppEvent): Promise<void> {
    const deliver = deliverPush;
    if (!deliver) throw new Error('nothing subscribed to this review');
    act(() => { deliver(event); });
    await flush();
  }

  it('subscribes to the REVIEW, not to a run, for as long as it is open', async () => {
    await openReview();
    // A disposition change belongs to no run: a colleague can reject a
    // finding on a review that finished last week.
    expect(subscribeMock).toHaveBeenCalled();
    expect(subscribeMock.mock.calls[0][0]).toEqual({ review: 'r1' });
  });

  it('shows the partner s name and what it was, with NO re-fetch', async () => {
    await openReview();
    expect(container.textContent).toContain('Verified');
    const readsBefore = getFindingsMock.mock.calls.length;

    await push(partnerRejection(2));

    // RULE 2: the payload carried the row and the event that produced it, so
    // "was Verified" needs no second query. A handler that re-fetched would
    // turn a forty-cell run into forty reads.
    expect(getFindingsMock.mock.calls.length).toBe(readsBefore);
    expect(container.textContent).toContain('Rejected');
    expect(container.textContent).toContain('R. Okafor');
    // The whole of §6.3's sentence: the new state, who, and what it was.
    expect(container.textContent).toContain('was Verified');
  });

  it('drops an event whose version is NOT NEWER, including the echo of your own write', async () => {
    /*
     * RULE 1, and the load-bearing line in the handler. THE MUTATION: remove
     * the `payload.version <= held` comparison in `applyPush` and confirm
     * this goes red. Without it a reader watches a finding go from done back
     * to running on every reconnect, and their own write's echo re-renders
     * the card underneath them.
     */
    await openReview();
    // The read put version 1 in the cache. A push AT version 1 is the echo
    // of what this browser already holds.
    await push({
      ...partnerRejection(1),
      id: 500,
    });
    expect(container.textContent).toContain('Verified');
    expect(container.textContent).not.toContain('R. Okafor');

    // …and the sanity check: a NEWER version does land, so the drop above is
    // about the number rather than about pushes never working.
    await push(partnerRejection(2));
    expect(container.textContent).toContain('R. Okafor');
  });

  it('appends an arriving note rather than replacing the list', async () => {
    await openReview();
    await push({
      id: 300, type: 'note.added', workspaceId: 'ws-1', matterId: 'm1', reviewId: 'r1',
      at: T_1604,
      payload: {
        reviewId: 'r1', findingsKey: 'd1', clauseId: 'c1',
        note: {
          id: 'n-1', findingId: 'd1::c1', text: 'Check 14.2 against the LOI.',
          byUserId: 'u2', at: T_1604,
        },
      },
    });
    expect(container.textContent).toContain('Check 14.2 against the LOI.');

    // The SAME note again — a replay, or a review and a matter subscription
    // both carrying it. One remark, not two.
    await push({
      id: 301, type: 'note.added', workspaceId: 'ws-1', matterId: 'm1', reviewId: 'r1',
      at: T_1604,
      payload: {
        reviewId: 'r1', findingsKey: 'd1', clauseId: 'c1',
        note: {
          id: 'n-1', findingId: 'd1::c1', text: 'Check 14.2 against the LOI.',
          byUserId: 'u2', at: T_1604,
        },
      },
    });
    const occurrences = (container.textContent ?? '')
      .split('Check 14.2 against the LOI.').length - 1;
    expect(occurrences).toBe(1);
  });

  it('re-reads the findings and SAYS SO when the cursor fell outside the window', async () => {
    await openReview();
    const readsBefore = getFindingsMock.mock.calls.length;
    const resync = triggerResync;
    expect(resync, 'nothing subscribed to this review').toBeTruthy();
    act(() => { resync!(); });
    await flush();
    // Nothing is fabricated to fill the gap: the findings map is the state
    // those events described, so it is re-read.
    expect(getFindingsMock.mock.calls.length).toBeGreaterThan(readsBefore);
  });

  it('closes its subscription when the review is left', async () => {
    await openReview();
    act(() => { root.unmount(); });
    expect(closeSubscriptionMock).toHaveBeenCalled();
    // The afterEach unmounts again; a second unmount of an unmounted root
    // throws, so re-create one for it to take down.
    root = createRoot(container);
  });
});

/**
 * P36, AND THE HALF THAT WAS ONLY HALF-IMPLEMENTED.
 *
 * Task 8 shipped "a push landing while a reject-reason modal is open is held
 * and announced, never applied under an open control", and held the
 * ATTRIBUTION LINE. The `StateChip` at the top of the card and the
 * highlighted button inside `VerificationControls` both kept rendering from
 * `finding.verification`, which every findings read replaces wholesale — so
 * the state a reviewer was looking at swapped under their hand on the two
 * elements they actually look at, while the line beneath it still said the
 * old thing.
 *
 * It was reachable before the socket (a poll landing mid-dialog did it too);
 * Stage 4 only makes it constant. The card now renders the state it is
 * SHOWING, and this is the case that says so.
 */
describe('a push held under an open control', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    localStorage.clear();
    forgetFindingVersions('r1');
    seedReadDisposition();
    deliverPush = null;
    subscribeMock.mockClear();
    listPlaybooksMock.mockReset().mockResolvedValue([]);
    listMattersMock.mockReset().mockResolvedValue([]);
    listReviewsMock.mockReset().mockResolvedValue([]);
    getMatterMock.mockReset().mockResolvedValue(makeMatter());
    listDocumentsMock.mockReset().mockResolvedValue([]);
    getDocumentMock.mockReset().mockResolvedValue(makeDocumentRecord());
    getDocumentBlobMock.mockReset().mockResolvedValue(null);
    getReviewMock.mockReset().mockResolvedValue(makeReview());
    saveReviewMock.mockReset().mockResolvedValue(undefined);
    getProfileMock.mockReset().mockResolvedValue({ id: 'u1', name: 'A. Trainee', initials: 'AT' });
    getFindingsMock.mockReset();
    serverFindings();
    setDispositionMock.mockReset();
    addNoteMock.mockReset();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => { root.unmount(); });
    container.remove();
  });

  /*
   * AN ASSIGNMENT ARRIVES ON A REVIEW-SCOPED PUSH (C1).
   *
   * This file contained the string "assignment" zero times: the push path
   * for `assignment.created` had no test at all, which is how a bystander
   * came to be told they had made a request. `applyPush` still appends every
   * pushed assignment — deliberately, because the local id may not have
   * resolved yet and a dropped request reaches nobody — so the actor filter
   * is at render, and that is what these assert.
   */
  const assignmentPush = (
    id: string, assigneeUserId: string, assignedByUserId: string, message: string,
  ): AppEvent => ({
    id: 900, type: 'assignment.created',
    workspaceId: 'ws-1', matterId: 'm1', reviewId: 'r1', at: T_1604,
    payload: {
      reviewId: 'r1', findingsKey: 'd1', clauseId: 'c1',
      assignment: {
        id, reviewId: 'r1', findingsKey: 'd1', clauseId: 'c1',
        assigneeUserId, assignedByUserId, message, createdAt: T_1604,
      },
    },
  } as unknown as AppEvent);

  async function openTheReview(): Promise<void> {
    window.history.pushState(null, '', '/matters/m1/reviews/r1');
    act(() => { root.render(<App />); });
    await flushUntil(
      () => !(container.textContent ?? '').includes('Loading review'),
      'the review to finish loading');
    await flush();
  }

  it('shows a request ADDRESSED TO YOU the moment it is pushed', async () => {
    // The local profile is `u1`.
    await openTheReview();
    act(() => { deliverPush!(assignmentPush('as1', 'u1', 'u2', 'Check the cap.')); });
    await flush();
    expect(container.textContent).toContain('asked you to look at this');
    expect(container.textContent).toContain('Check the cap.');
  });

  it('tells a BYSTANDER nothing about a request between two other people', async () => {
    // `u1` is neither the assignee nor the assigner. The event still reaches
    // this tab, because it is scoped to the REVIEW and the socket has no
    // per-recipient filter — and should not grow one.
    await openTheReview();
    act(() => { deliverPush!(assignmentPush('as2', 'u2', 'u3', 'Not sure about 14.2.')); });
    await flush();
    expect(container.textContent).not.toContain('You asked');
    expect(container.textContent).not.toContain('asked you to look at this');
    expect(container.textContent).not.toContain('Not sure about 14.2.');
    expect(container.textContent).not.toContain('Withdraw the request');
  });

  it('shows a request YOU MADE, with the control only you should have', async () => {
    await openTheReview();
    act(() => { deliverPush!(assignmentPush('as3', 'u2', 'u1', 'Please look at the cap.')); });
    await flush();
    expect(container.textContent).toContain('You asked');
    expect(container.textContent).toContain('R. Okafor');
    expect(container.textContent).toContain('Withdraw the request');
  });

  it('holds the state under an open reject dialog, and announces it instead', async () => {
    window.history.pushState(null, '', '/matters/m1/reviews/r1');
    act(() => { root.render(<App />); });
    await flushUntil(
      () => !(container.textContent ?? '').includes('Loading review'),
      'the review to finish loading');
    await flush();

    // The trainee opens the reject-reason dialog: a control that composes a
    // disposition for THIS finding is now open.
    const reject = Array.from(container.querySelectorAll('button'))
      .find(b => /reject/i.test(b.textContent ?? ''));
    expect(reject, 'the Reject control was not rendered').toBeTruthy();
    act(() => { reject!.click(); });
    await flush();
    expect(container.querySelector('[role="dialog"]'),
      'the reject-reason dialog did not open').toBeTruthy();

    const deliver = deliverPush!;
    act(() => { deliver(partnerRejection(2)); });
    await flush();

    // HELD, and asserted on the STATE CHIP rather than on the card's text.
    //
    // The attribution line for a rejection reads "… — was Verified", so a
    // `textContent` match on "Verified" passes with the hold removed. That
    // weaker assertion is exactly the shape that let this half of P36 ship
    // unimplemented, so the chip is read directly.
    const chip = container.querySelector('[role="status"]');
    expect(chip, 'the state chip was not rendered').toBeTruthy();
    expect(chip!.textContent).toMatch(/Verified/i);
    expect(chip!.textContent).not.toMatch(/Rejected/i);
    // ANNOUNCED, so the hold is not a silence: `heldUpdateLine` names who
    // changed it and says the view will catch up.
    expect(container.textContent).toContain('changed this while you were writing');
    expect(container.textContent).toContain('R. Okafor');
  });
});
