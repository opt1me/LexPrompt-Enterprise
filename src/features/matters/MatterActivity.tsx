import React from 'react';
import { CheckCheck, Flag, XCircle, MessageSquare, GitBranch, Play, Check } from 'lucide-react';
import type { Review } from '../../types';
import { matterActivity, type ActivityEntry, type ActivityKind } from '../../lib/matterActivity';

export interface MatterActivityProps {
  reviews: Review[];
  /** The local profile's id. An entry authored by it reads "You …"; one
   *  authored by anything else reads with no actor at all (R-GP5). */
  localUserId: string;
}

// Complete literal class names per kind, never built by string
// interpolation — a template like `text-${kind}` produces no styling at
// all, since Tailwind can only see whole class names as they appear in
// source (the trap this sub-project has already hit once).
const ICON: Record<ActivityKind, { Icon: typeof Check; ink: string }> = {
  verified: { Icon: CheckCheck, ink: 'text-state-verified' },
  flagged: { Icon: Flag, ink: 'text-state-flagged' },
  rejected: { Icon: XCircle, ink: 'text-state-rejected' },
  note: { Icon: MessageSquare, ink: 'text-ink-3' },
  'net-confirmed': { Icon: GitBranch, ink: 'text-net-confirmed' },
  'net-amended': { Icon: GitBranch, ink: 'text-net-amended' },
  'review-started': { Icon: Play, ink: 'text-ink-3' },
  'review-completed': { Icon: Check, ink: 'text-ink-3' },
};

const VERB: Record<ActivityKind, { you: string; passive: string }> = {
  verified: { you: 'You verified', passive: 'Verified' },
  flagged: { you: 'You flagged', passive: 'Flagged' },
  rejected: { you: 'You rejected', passive: 'Rejected' },
  note: { you: 'You noted on', passive: 'Note added on' },
  'net-confirmed': { you: 'You confirmed the net position on', passive: 'Net position confirmed on' },
  'net-amended': { you: 'You amended the net position on', passive: 'Net position amended on' },
  'review-started': { you: 'You started', passive: 'Started' },
  'review-completed': { you: 'Completed', passive: 'Completed' },
};

function line(entry: ActivityEntry): string {
  const verb = entry.byYou ? VERB[entry.kind].you : VERB[entry.kind].passive;
  return entry.clauseTitle ? `${verb} ${entry.clauseTitle}` : `${verb} ${entry.reviewName}`;
}

/**
 * The matter home's activity list (Task 16, spec §10.1 / §7): what
 * happened in this matter, attributed to you where a person did it.
 *
 * Derived at read time by `matterActivity` and never stored (R-G9) — an
 * event log would be a second account of what happened, free to drift
 * from the findings it describes.
 *
 * Single-actor by construction (R-G1). There is no second actor anywhere
 * in this component: an entry authored by someone other than the local
 * profile renders with a passive verb and NO name, never an invented one
 * and never "someone else". A flag is never described as raised FOR
 * anybody, because flagging reaches no one.
 */
export function MatterActivity({ reviews, localUserId }: MatterActivityProps) {
  const entries = matterActivity(reviews, localUserId);

  return (
    <section className="bg-card border border-rule rounded-card p-5">
      <h3 className="font-prose text-section text-ink-1">Activity</h3>
      {entries.length === 0 ? (
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
