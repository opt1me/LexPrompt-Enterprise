import React from 'react';
import type { AssignedToMe as AssignedToMeState, AssignedToMeKind } from '../../lib/assignedToMe';

export interface AssignedToMeProps {
  state: AssignedToMeState;
}

/**
 * "ASSIGNED TO ME", IN THE APP HEADER (S18, Stage 5).
 *
 * ## Three states, three renders, and two of them must not look alike
 *
 * - `loading` renders **nothing**. A skeleton here would be a shape a reader
 *   learns to ignore, and it would occupy the same pixel as the empty case
 *   anyway.
 * - `ready` with a count of zero renders **nothing**. That is the ordinary
 *   week, and a permanent "0" is a mark people stop seeing — which takes the
 *   non-zero case with it.
 * - `error` renders a marker saying **"not known"**, with the reason, and
 *   **never a digit**. This is the whole reason the component exists: a
 *   badge showing `0` because a fetch failed is a lawyer not doing something
 *   a colleague is waiting on, and it looks exactly like a quiet week.
 *
 * `AssignedToMe.test.tsx` asserts the absence of any digit in the error
 * state, over the render, because the failure is silent by construction.
 *
 * ## It NAMES THE MATTERS rather than offering a control that goes nowhere
 *
 * A counter with no way to find what it counts is a badge. This stage ships
 * no cross-matter inbox SCREEN, so rather than wiring the marker to
 * something that is not where the requests are — an affordance implying a
 * destination the app does not have (R1) — it says which matters they are
 * in, in words, where a reader and a screen reader both get it. That is
 * exactly what Task 1's projection exists for: the assignment row alone
 * could not have said it.
 *
 * ## `200+` rather than a number that is wrong
 *
 * The inbox reads `API_ASSIGNMENT_INBOX_LIMIT + 1` rows and says whether it
 * hit the ceiling. A counter that printed the truncated count would state a
 * number the server never claimed.
 *
 * ## Amber, not oxblood, and never a state ink
 *
 * `--color-risk-med` already means *"attention, not failure"* — which is
 * exactly what "we could not read this" is — and `StalePanel` chose it for
 * the same reason. Minting a role for one marker would put another colour in
 * the palette for a meaning that already has one. Nothing here uses a
 * `state-` or `outcome-` ink: this is not a judgement about anything.
 *
 * ## Every class string is COMPLETE
 *
 * Tailwind finds classes by scanning source text for whole literals, so
 * `` `bg-${kind}-tint` `` generates no utility at all — no error, no failing
 * test, no colour. The map below is indexed into, never built.
 */
const SHELL: Record<AssignedToMeKind, string> = {
  loading: '',
  ready: 'inline-flex items-center gap-1 px-2 py-0.5 rounded-meter '
    + 'bg-accent-tint text-accent border border-accent-edge font-ui text-meta font-semibold',
  error: 'inline-flex items-center gap-1 px-2 py-0.5 rounded-meter '
    + 'bg-risk-med-tint text-risk-med border border-risk-med-edge font-ui text-meta font-semibold',
};

/** The one wording for "the read failed", so the marker and the tooltip
 *  cannot come to disagree. */
const NOT_KNOWN = 'Assigned to you: not known';

export function AssignedToMe({ state }: AssignedToMeProps) {
  if (state.status === 'loading') return null;
  if (state.status === 'ready' && state.count === 0) return null;

  if (state.status === 'error') {
    // THE REASON WHERE A PERSON CAN REACH IT: `title` for a pointer and
    // `aria-label` for everything else. A marker whose explanation lives
    // only in a hover is an explanation a keyboard user does not have.
    const explanation = `${NOT_KNOWN}. ${state.message}`;
    return (
      <span
        data-assigned-to-me="error"
        // NO `role="status"`, deliberately. This marker lives in the app
        // header, above every screen, and a positional `[role="status"]`
        // query has already broken once in this codebase on a second element
        // quietly claiming the same role (`AskedOfYou` says so at length,
        // and `ClauseIndex` before it). It is also not a live region: it is
        // a standing fact about this session, not an announcement, and it
        // must not interrupt a reviewer mid-sentence. The `aria-label` below
        // is what gives it a name.
        title={explanation}
        aria-label={explanation}
        className={SHELL.error}
      >
        <span aria-hidden="true">not known</span>
      </span>
    );
  }

  // `200+`, never a truncated number stated as if it were the total.
  const shown = state.capped ? `${state.count}+` : String(state.count);
  const how = state.capped
    ? `More than ${state.count} things have been asked of you`
    : state.count === 1
      ? '1 thing has been asked of you'
      : `${state.count} things have been asked of you`;
  const label = state.matters.length === 0 ? how : `${how}, in ${listOf(state.matters)}`;

  return (
    <span
      data-assigned-to-me="ready"
      title={label}
      aria-label={label}
      className={SHELL.ready}
    >
      <span aria-hidden="true">{shown}</span>
    </span>
  );
}

/** `a`, `a and b`, `a, b and c`. Plain ASCII and no Oxford comma, which is
 *  the house style everywhere else in this app's prose. */
function listOf(names: string[]): string {
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}
