import { describe, it, expect, afterAll } from 'vitest';
import type { AssignmentInboxPage, SearchResults } from '@lexprompt/core';
import { API_BASE, asUser, type TestAccount } from './helpers/twoAccounts.ts';
import { threeAccounts } from './helpers/threeAccounts.ts';
import { removeSeeded, seedOneDoneFinding, type Seeded } from './helpers/seedReview.ts';

/**
 * PARTS 5A AND 5B'S GATE — THREE ACCOUNTS, ON A RUNNING STACK.
 *
 * ## Why THREE and not two
 *
 * Stage 4's final review found a bystander shown *"You asked B. Trainee to
 * look at this"* with a live **Withdraw** button, for a request they had
 * nothing to do with. `twoAccounts()` cannot express that failure at all:
 * with two people, everybody is a party. The third session is the whole
 * point of this file, and the assertions about it are executed as a real
 * refused request rather than reasoned about.
 *
 * ## What is proved here and nowhere else
 *
 * The unit and `.pg` suites prove the mechanisms. This proves they hold over
 * real HTTP, through nginx, with tokens minted by the seeded realm and an
 * actor resolved from each of them — which is the layer four stages of
 * defects have been found at.
 *
 * ## What NOBODY HAS SEEN
 *
 * Browser automation has been unavailable for four stages and remains so.
 * Nobody has looked at the counter's "not known" marker, the palette's
 * failed state, the chip on a card, or the Report tab.
 * `docs/BROWSER-VERIFICATION.md` names each of those; every rendered-string
 * claim in Parts 5A and 5B is asserted in jsdom and by nothing that has
 * looked at a screen.
 */

const litter: { who: TestAccount; seeded: Seeded }[] = [];

afterAll(async () => {
  // EVERY ROW THIS SUITE CREATED. `test:pg` and `test:compose` share one
  // database, and a suite that leaves state behind breaks a different file
  // with a message pointing at the wrong feature.
  for (const { who, seeded } of litter.splice(0)) await removeSeeded(who, seeded);
});

const assignPath = (s: Seeded): string =>
  `/v1/reviews/${s.reviewId}/findings/${s.findingsKey}/${s.clauseId}/assignments`;

const label = (n: string): string => `stage5ab ${n}`;

describe('the three accounts, and the premise every privilege claim rests on', () => {
  it('signs in as a trainee, a partner and an admin, with three distinct roles', async () => {
    const { trainee, partner, admin } = await threeAccounts();
    expect(trainee.role).toBe('reviewer');
    expect(partner.role).toBe('partner');
    // P61's premise, RE-CHECKED rather than inherited: if the realm's group
    // mapping stopped producing `admin`, every privilege assertion in Part
    // 5C would be planned around a fiction.
    expect(admin.role).toBe('admin');
    // Three PEOPLE, not one token read three times.
    expect(new Set([trainee.userId, partner.userId, admin.userId]).size).toBe(3);
  }, 60_000);
});

describe('an unauthenticated caller is refused, never answered empty', () => {
  it('answers 401 sign_in_required to a search with no token', async () => {
    const res = await fetch(`${API_BASE}/v1/search?q=ashcroft`);
    expect(res.status).toBe(401);
    const body = await res.json() as { error?: { code?: string }; hits?: unknown };
    expect(body.error?.code).toBe('sign_in_required');
    // NOT an empty result set. "Nothing in this firm matches" is a statement
    // about the corpus, and it must never be made about a request that was
    // refused.
    expect('hits' in body).toBe(false);
  }, 60_000);
});

describe('the cross-matter inbox, across two matters, with the context to act', () => {
  it('names both matters, both reviews and both clause titles, and moves on a close', async () => {
    const { trainee, partner } = await threeAccounts();
    const a = await seedOneDoneFinding(trainee, label('inbox A'));
    const b = await seedOneDoneFinding(trainee, label('inbox B'));
    litter.push({ who: trainee, seeded: a }, { who: trainee, seeded: b });

    const ids: string[] = [];
    for (const seeded of [a, b]) {
      const created = await asUser(trainee, 'POST', assignPath(seeded),
        { assigneeUserId: partner.userId, message: 'Not sure the cap survives 14.2.' });
      expect(created.status, await created.clone().text()).toBe(201);
      ids.push((await created.json() as { id: string }).id);
    }

    const inbox = async (who: TestAccount): Promise<AssignmentInboxPage> => {
      const res = await asUser(who, 'GET', '/v1/assignments?state=open');
      expect(res.status, await res.clone().text()).toBe(200);
      return await res.json() as AssignmentInboxPage;
    };
    const ours = (page: AssignmentInboxPage) =>
      page.items.filter(i => i.matterName.startsWith('stage5ab inbox '));

    const two = ours(await inbox(partner));
    expect(two.map(i => i.matterName).sort())
      .toEqual([label('inbox A'), label('inbox B')]);
    // THE CONTEXT AN ASSIGNEE NEEDS TO ACT, over real HTTP. Before Task 1
    // this call answered three opaque ids and two user ids.
    expect(two.every(i => i.reviewName === i.matterName)).toBe(true);
    expect(two.every(i => i.matterId.length > 0)).toBe(true);
    // The seed's snapshot carries no clause list, so the title is ABSENT
    // rather than invented — which is the honest half of the same rule.
    expect(two.every(i => !('clauseTitle' in i))).toBe(true);

    // …and the ASSIGNER's own inbox holds none of it. A counter that
    // included what you asked of others would tell a person they owe an
    // answer they do not owe.
    expect(ours(await inbox(trainee))).toEqual([]);

    // One closed by the assignee. The number moves because the SERVER says
    // so on a fresh read, not because anything decremented.
    const closed = await asUser(partner, 'POST', `/v1/assignments/${ids[0]}/resolve`);
    expect(closed.status, await closed.text()).toBe(200);
    expect(ours(await inbox(partner)).map(i => i.matterName)).toEqual([label('inbox B')]);
  }, 90_000);
});

describe('a THIRD person: told what is outstanding, offered nothing to do about it', () => {
  it('lists the request to a bystander and refuses their attempt to close it', async () => {
    const { trainee, partner, admin } = await threeAccounts();
    const seeded = await seedOneDoneFinding(trainee, label('bystander'));
    litter.push({ who: trainee, seeded });

    const created = await asUser(trainee, 'POST', assignPath(seeded),
      { assigneeUserId: partner.userId, message: 'Not sure the cap survives 14.2.' });
    expect(created.status, await created.clone().text()).toBe(201);
    const { id } = await created.json() as { id: string };

    // The ADMIN here is simply a third real session — neither the assignee
    // nor the assigner. Nothing about this is a privilege claim; it is the
    // one thing two accounts cannot express.
    const seen = await asUser(admin, 'GET', `/v1/reviews/${seeded.reviewId}/assignments`);
    expect(seen.status, await seen.clone().text()).toBe(200);
    const { assignments } = await seen.json() as {
      assignments: { id: string; assigneeUserId: string; assignedByUserId: string }[];
    };
    const row = assignments.find(x => x.id === id);
    expect(row, 'a bystander could not see that somebody was asked').toBeDefined();
    expect(row!.assigneeUserId).toBe(partner.userId);
    expect(row!.assignedByUserId).toBe(trainee.userId);

    // …AND THEY MAY NOT ACT ON IT. Executed as a real refused request rather
    // than reasoned about: this is Stage 4's defect, closed.
    const refused = await asUser(admin, 'POST', `/v1/assignments/${id}/resolve`);
    expect(refused.status).toBe(403);
    expect((await refused.json() as { error: { code: string } }).error.code)
      .toBe('not_permitted');

    // …and the request is still open, so the refusal is not a silent
    // success.
    const after = await asUser(partner, 'GET', `/v1/reviews/${seeded.reviewId}/assignments`);
    expect((await after.json() as { assignments: { id: string }[] })
      .assignments.filter(x => x.id === id)).toHaveLength(1);

    // The PARTNER, who was asked, still may close it — so the refusal above
    // is about who the admin is, not about the id.
    expect((await asUser(partner, 'POST', `/v1/assignments/${id}/resolve`)).status).toBe(200);
  }, 90_000);
});

describe('search, over real HTTP, with an outcome for every source', () => {
  it('finds a matter and its review, reports all seven sources, and refuses one letter', async () => {
    const { trainee } = await threeAccounts();
    const seeded = await seedOneDoneFinding(trainee, label('searchable'));
    litter.push({ who: trainee, seeded });

    const search = async (q: string): Promise<SearchResults> => {
      const res = await asUser(trainee, 'GET', `/v1/search?q=${encodeURIComponent(q)}`);
      expect(res.status, await res.clone().text()).toBe(200);
      return await res.json() as SearchResults;
    };

    const found = await search('stage5ab searchable');
    expect(found.hits.some(h => h.source === 'matter' && h.id === seeded.matterId)).toBe(true);
    expect(found.hits.some(h => h.source === 'review' && h.id === seeded.reviewId)).toBe(true);
    // EVERY SOURCE REPORTS, on a successful search.
    expect(found.sources.map(s => s.source).sort()).toEqual([
      'clause', 'collection', 'document', 'matter', 'playbook', 'precedent', 'review',
    ]);
    expect(found.sources.every(s => s.status === 'ok')).toBe(true);

    // …AND ON AN EMPTY ONE, which is the whole point: an empty list with
    // seven `ok` outcomes is an answer, and an empty list with no outcomes
    // is indistinguishable from a broken search.
    const nothing = await search('zzzznothingmatchesthisanywhere');
    expect(nothing.hits).toHaveLength(0);
    expect(nothing.sources.every(s => s.status === 'ok' && s.count === 0)).toBe(true);

    // THE TEXT INSIDE DOCUMENTS IS NOT SEARCHED, which the palette states on
    // every result set. Asserted as a fact about the query rather than left
    // to the copy: the seeded finding's summary contains this phrase.
    const body = await search('capped at the fees');
    expect(body.hits).toHaveLength(0);

    // A QUERY BELOW THE MINIMUM IS REFUSED, never answered empty.
    const short = await asUser(trainee, 'GET', '/v1/search?q=a');
    expect(short.status).toBe(400);
    expect((await short.json() as { error: { code: string } }).error.code)
      .toBe('query_too_short');
  }, 90_000);
});
