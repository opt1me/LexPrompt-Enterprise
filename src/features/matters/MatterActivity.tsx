import React, { useEffect, useState } from 'react';
import {
  CheckCheck, Flag, XCircle, MessageSquare, GitBranch, Play, Check, RotateCcw, CircleSlash,
  FileText,
} from 'lucide-react';
import type { ActivityRow } from '@lexprompt/core';
import type { Review } from '../../types';
import { matterActivity, type ActivityEntry, type ActivityKind } from '../../lib/matterActivity';
import { userName } from '../../lib/api/users';
import {
  UNNAMED_BY_RECORD_SENTENCE, UNRESOLVED_ACTOR_SENTENCE,
} from '../../lib/findingOutcome';
import { getMatterActivity } from '../../lib/api/activity';
import { describeLoadError } from '../../lib/loadError';

export interface MatterActivityProps {
  reviews: Review[];
  /** The local profile's id. An entry authored by it reads "You …"; one
   *  authored by a colleague reads with their NAME (Stage 4); one whose
   *  author the directory cannot resolve reads as "someone this workspace
   *  does not name" — never as an id, and never as you (R-GP5). */
  localUserId: string;
  /**
   * The matter whose server-side activity to read — disposition changes,
   * audited acts and runs (`GET /v1/matters/:id/activity`).
   *
   * Optional so a preview or a test can hand `rows` directly. When it is
   * given, a FAILED read is SAID rather than swallowed: a feed silently
   * missing every verification looks exactly like a matter nobody has
   * checked anything in, which is the founding defect at a new surface.
   */
  matterId?: string;
  /** The rows themselves, for a caller that has them already. */
  rows?: ActivityRow[];
  /**
   * A SIGNATURE OF WHAT THIS TAB HAS CHANGED. When it changes, the feed is
   * read again.
   *
   * Found in a browser: two documents were added to a matter, both audit
   * rows were written and correctly scoped, and this panel went on showing
   * only *"You opened this matter"* until the page was reloaded by hand. It
   * reads once on mount, and adding a document does not remount it — so the
   * feed was a snapshot presented as a current account of the matter, which
   * is this project's founding failure shape at a new surface.
   *
   * This is NOT a live subscription and must not be described as one. The
   * three sources this feed reads (audited acts, disposition events, runs)
   * are not in §8's outbox — `AppEvent` carries runs, dispositions, notes
   * and assignments, and no audited act at all — so nothing pushes a
   * `document.added` to any client. What this closes is the case the browser
   * session actually hit and the one this tab can know about without
   * inventing anything: work done HERE. A colleague's act still arrives on
   * the next read.
   *
   * A signature rather than a counter, because the parse poll re-reads the
   * document list every few seconds while a document is being read: an
   * array identity would re-fetch the feed on every poll, and a length
   * would miss an add-plus-delete.
   */
  refreshKey?: string;
}

// Complete literal class names per kind, never built by string
// interpolation — a template like `text-${kind}` produces no styling at
// all, since Tailwind can only see whole class names as they appear in
// source (the trap this sub-project has already hit once).
const ICON: Record<ActivityKind, { Icon: typeof Check; ink: string }> = {
  verified: { Icon: CheckCheck, ink: 'text-state-verified' },
  flagged: { Icon: Flag, ink: 'text-state-flagged' },
  rejected: { Icon: XCircle, ink: 'text-state-rejected' },
  cleared: { Icon: RotateCcw, ink: 'text-ink-3' },
  rerun: { Icon: RotateCcw, ink: 'text-ink-3' },
  note: { Icon: MessageSquare, ink: 'text-ink-3' },
  'net-confirmed': { Icon: GitBranch, ink: 'text-net-confirmed' },
  'net-amended': { Icon: GitBranch, ink: 'text-net-amended' },
  'review-started': { Icon: Play, ink: 'text-ink-3' },
  'review-completed': { Icon: Check, ink: 'text-ink-3' },
  'run-cancelled': { Icon: CircleSlash, ink: 'text-ink-4' },
  audited: { Icon: FileText, ink: 'text-ink-3' },
};

/**
 * The verb each kind reads as, in both voices.
 *
 * `you` is used when the local profile did it; `passive` is the tail of a
 * sentence a NAME goes in front of. A RE-RUN is its own verb rather than
 * "cleared", because §6.3 says the two must not be flattened: one is a
 * person withdrawing a judgement, the other is the system removing one that
 * described an answer which no longer exists.
 */
const VERB: Record<ActivityKind, { you: string; passive: string }> = {
  verified: { you: 'You verified', passive: 'verified' },
  flagged: { you: 'You flagged', passive: 'flagged' },
  rejected: { you: 'You rejected', passive: 'rejected' },
  cleared: { you: 'You cleared the check on', passive: 'cleared the check on' },
  rerun: { you: 'You re-ran', passive: 're-ran' },
  note: { you: 'You noted on', passive: 'noted on' },
  'net-confirmed': {
    you: 'You confirmed the net position on', passive: 'confirmed the net position on',
  },
  'net-amended': {
    you: 'You amended the net position on', passive: 'amended the net position on',
  },
  'review-started': { you: 'You started', passive: 'started' },
  'review-completed': { you: 'Completed', passive: 'completed' },
  'run-cancelled': { you: 'You cancelled', passive: 'cancelled' },
  audited: { you: 'You changed', passive: 'changed' },
};

/**
 * The verb an AUDITED act reads as — a complete literal map, indexed, never
 * interpolated.
 *
 * The set is closed on the server (`apps/api/src/audit/actions.ts`). An
 * action this browser does not recognise falls back to `VERB.audited` rather
 * than rendering nothing: a feed line that disappears reads as "nobody did
 * this", which is the blank-cell defect at a new surface.
 */
export const AUDIT_VERB: Record<string, { you: string; passive: string }> = {
  'matter.created': { you: 'You opened this matter', passive: 'opened this matter' },
  'matter.deleted': { you: 'You deleted this matter', passive: 'deleted this matter' },
  'document.added': { you: 'You added a document', passive: 'added a document' },
  'document.deleted': { you: 'You deleted a document', passive: 'deleted a document' },
  'playbook.published': { you: 'You published a playbook version', passive: 'published a playbook version' },
  'playbook.imported': { you: 'You imported a playbook', passive: 'imported a playbook' },
  'review.created': { you: 'You created a review', passive: 'created a review' },
  'review.deleted': { you: 'You deleted a review', passive: 'deleted a review' },
  'run.started': { you: 'You started a review run', passive: 'started a review run' },
  'run.cancelled': { you: 'You cancelled a review run', passive: 'cancelled a review run' },
  'assignment.created': { you: 'You asked a colleague to look at a clause', passive: 'asked a colleague to look at a clause' },
  'assignment.resolved': { you: 'You resolved an assignment', passive: 'resolved an assignment' },
  'workspace.settings_changed': {
    you: 'You changed the workspace settings', passive: 'changed the workspace settings',
  },
  /*
   * `user.role_changed` HAS BEEN REMOVED, and its absence is the point.
   *
   * It was rendered here from Stage 2 and written by nothing, anywhere.
   * Stage 5 Part 5C is where it would have found a writer and did not,
   * because the fact it names does not exist: nothing in LexPrompt changes a
   * PERSON'S role. `app_user.role` is a per-request cache of what `roleFor`
   * derived from the token's groups and the deployment's role mapping, and
   * what an administrator actually changes is the MAPPING.
   *
   * The three verbs that replaced it in `AUDIT_ACTIONS`
   * (`role_mapping.created`/`.changed`/`.removed`) are deliberately NOT
   * added here. They are WORKSPACE acts and carry no matter, and this feed
   * reads `where a.matter_id = $1` — so a rendering for them would be a
   * string this component can never be handed. They are read from
   * `audit_event` by the workspace audit export instead.
   */
};

/**
 * WHO DID IT, and it never prints an id.
 *
 * The same three cases `actorPhrase` (`findingOutcome.ts`) makes one layer
 * down, and the same wording for the unresolvable one: *"someone this
 * workspace does not name"* is true whether the person has left the firm or
 * the directory has not loaded, and only one of those would justify saying
 * "no longer in this workspace".
 */
function actor(entry: ActivityEntry): string {
  if (entry.byYou) return 'You';
  if (!entry.byUserId) return UNNAMED_BY_RECORD_SENTENCE;
  return userName(entry.byUserId) ?? UNRESOLVED_ACTOR_SENTENCE;
}

/**
 * An action this browser does not recognise. It NAMES THE RAW ACTION as its
 * subject rather than disappearing: a feed quietly shorter than what
 * happened is the failure R-G9 named, and a client reading a newer server
 * must not be the thing that shortens it.
 */
const UNKNOWN_AUDIT_VERB = { you: 'You made a change recorded as', passive: 'made a change recorded as' };

/**
 * ONE FEED LINE.
 *
 * ## An audited act takes no subject
 *
 * The audit arm of `GET /v1/matters/:id/activity` selects `null` for
 * `review_name` — an audited act is recorded against the MATTER, and this
 * feed is that matter's own page. Appending the subject anyway meant
 * appending `activityEntries`' placeholder, and the screen read
 * *"You added a document to This matter"*: a capital mid-sentence, naming
 * the page the reader is already looking at, in a shape that reads like a
 * cross-matter template nobody adjusted for the in-matter view.
 *
 * So every entry in `AUDIT_VERB` is a COMPLETE SENTENCE and nothing is
 * appended to it. That is a property of the map, not of this function: a
 * verb added there ending in "to" or "on" would render as a fragment, and
 * `MatterActivity.test.tsx` asserts the whole map reads as sentences rather
 * than pinning the two lines that happen to exist today.
 *
 * A disposition, a run or a note DOES belong to a review or a clause, and
 * those keep their subject.
 */
function line(entry: ActivityEntry): string {
  if (entry.kind === 'audited' && entry.action) {
    const verbs = AUDIT_VERB[entry.action];
    if (!verbs) {
      return entry.byYou
        ? `${UNKNOWN_AUDIT_VERB.you} ${entry.action}`
        : `${actor(entry)} ${UNKNOWN_AUDIT_VERB.passive} ${entry.action}`;
    }
    return entry.byYou ? verbs.you : `${actor(entry)} ${verbs.passive}`;
  }
  const verbs = VERB[entry.kind];
  const subject = entry.clauseTitle ?? entry.reviewName;
  return entry.byYou ? `${verbs.you} ${subject}` : `${actor(entry)} ${verbs.passive} ${subject}`;
}

/**
 * The matter home's activity list (Task 16, spec §10.1 / §7): what happened
 * in this matter, and who did it.
 *
 * ## It names people, because as of Stage 4 there are people to name
 *
 * The single-actor rule this component was built under (R-G1, R-GP5) is
 * over: a matter is worked on by a workspace, `finding_disposition_event`
 * and `audit_event` both carry an actor, and a feed that rendered a
 * colleague's rejection as a passive "Rejected" would be hiding the one
 * fact a reader needs. What has NOT changed is that an actor is only ever
 * rendered from a stored id — the directory can turn an id into a name and
 * cannot conjure one.
 *
 * The three server-side sources are read where they live (S22). Notes and
 * net positions come from the reviews this screen already holds; both go
 * through `matterActivity`, which is the one place a matter's feed is
 * assembled.
 */
export function MatterActivity({
  reviews, localUserId, matterId, rows, refreshKey,
}: MatterActivityProps) {
  const [fetched, setFetched] = useState<ActivityRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  /**
   * THE THIRD STATE. Loading, error, empty — and only two were rendered.
   *
   * While `getMatterActivity` was in flight, `fetched` was `null`, `entries`
   * was built from `[]` plus whatever notes the reviews carried, and a
   * matter with no notes rendered *"Nothing recorded in this matter yet"* —
   * the empty/loading conflation this codebase's own load rule exists to
   * prevent, on the matter home screen. Transient and self-correcting, and
   * still a sentence claiming a fact nothing had checked.
   */
  const [reading, setReading] = useState(matterId !== undefined && rows === undefined);

  useEffect(() => {
    if (matterId === undefined || rows !== undefined) {
      setReading(false);
      return;
    }
    let live = true;
    setError(null);
    setReading(true);
    getMatterActivity(matterId)
      .then(got => { if (live) { setFetched(got); setReading(false); } })
      // NOT swallowed into an empty feed. The disposition changes, the runs
      // and the audited acts all live server-side now, so a failed read
      // removes most of this list — and a shorter list is indistinguishable
      // from a quieter matter.
      .catch((e: unknown) => {
        if (live) {
          setReading(false);
          setError(describeLoadError(
            e, 'This matter s activity could not be read.'));
        }
      });
    return () => { live = false; };
    // `refreshKey` is in the dependency list, and that is the whole of the
    // staleness fix — see the prop's docstring.
  }, [matterId, rows, refreshKey]);

  const entries = matterActivity(reviews, localUserId, 20, rows ?? fetched ?? []);

  return (
    <section className="bg-card border border-rule rounded-card p-5">
      <h3 className="font-prose text-section text-ink-1">Activity</h3>
      {error && (
        <p data-activity-error className="mt-2 font-ui text-ui-sm text-risk-high leading-relaxed">
          {error} Checks, runs and changes to this matter are not shown below.
        </p>
      )}
      {entries.length === 0 && !error && reading ? (
        // NOT "nothing recorded yet" — nothing has been read yet, which is a
        // different fact and the only one this screen can honestly state.
        <p data-activity-loading className="mt-2 font-ui text-ui text-ink-3">
          Reading this matter s activity…
        </p>
      ) : entries.length === 0 && !error ? (
        <p className="mt-2 font-ui text-ui text-ink-2">Nothing recorded in this matter yet.</p>
      ) : (
        <ul className="mt-3 space-y-3">
          {entries.map((entry, i) => {
            const { Icon, ink } = ICON[entry.kind];
            return (
              <li key={`${entry.at}-${entry.kind}-${i}`} className="flex items-start gap-2.5">
                <Icon className={`w-3.5 h-3.5 mt-0.5 shrink-0 ${ink}`} aria-hidden="true" />
                <span className="font-ui text-ui-sm text-ink-2 leading-relaxed">
                  {line(entry)}
                  {entry.clauseTitle && (
                    <span className="text-ink-4"> · {entry.reviewName}</span>
                  )}
                </span>
                <time className="ml-auto shrink-0 font-mono text-pin text-ink-5">
                  {new Date(entry.at).toLocaleString()}
                </time>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
