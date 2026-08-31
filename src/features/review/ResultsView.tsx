import React, { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react';
import { Table, Mail, FileDown, History, Loader, FileText, X } from 'lucide-react';
import type { PlaybookClause, DocumentFile, Finding, PlaybookVersion, ReviewRun } from '../../types';
import { isAuthFailure } from '@lexprompt/core';
import {
  ModelError,
  SERVICE_CONFIG_HINT,
  type WorkspaceSettings,
  findingKey,
  findingsKeyFor,
  isCollectionTarget,
} from '@lexprompt/core';
import type {
  AssignmentView, DispositionWithHistory, PresenceMember, VerificationChange,
} from '@lexprompt/core';
import { reportPresence } from '../../lib/api/socket';
import { PresenceRoster } from '../../components/PresenceRoster';
import { AskedOfYou } from '../assignments/AskedOfYou';
import { progressLabel, progressPercent } from '../../lib/reviewProgress';
import { assignmentParty } from '../../lib/assignmentParty';
import {
  isVerifiable, NO_EXPORT_CONTEXT, type DispositionAudience, type ExportContext,
} from '../../lib/findingOutcome';
import { FindingCard } from './FindingCard';
import type { VerificationConflict } from './ConflictNotice';
import { ServiceConfigError } from '../../components/ServiceConfigError';
import { ClauseIndex } from './ClauseIndex';
import { ViewSwitch } from './ViewSwitch';
import { ReviewVersionLine } from './ReviewVersionLine';
import type { TrailDocumentInfo } from './VariationTrailModal';
import { DocumentViewer } from './DocumentViewer';
import { RejectReasonModal } from './RejectReasonModal';
import { useVerifyKeys } from './useVerifyKeys';
import { exportDocx } from './exportDocx';
import { downloadTabularCsv } from '../tabular/csv';
import { downloadHistoryCsv } from './exportHistoryCsv';
import { getAllReviewHistory } from '../../lib/api/history';
import { draftEmail } from '../assistant/draftEmail';
import { suggestRevision } from '../assistant/suggestRevision';
import { RevisionModal, type RevisionData } from '../assistant/RevisionModal';

// Both of these pull in `react-markdown` + `remark-gfm`, which are only ever
// needed once a user opens the Assistant tab or drafts an email — not on
// first paint. Lazy-loading them (the same pattern `documents.ts` uses for
// pdfjs and mammoth, and `exportDocx.ts` uses for `docx`) keeps that weight
// out of the entry chunk for the common case where neither is touched.
const ChatPanel = lazy(() => import('../assistant/ChatPanel').then(m => ({ default: m.ChatPanel })));
const EmailModal = lazy(() => import('../assistant/EmailModal').then(m => ({ default: m.EmailModal })));

/**
 * Task 23: `Finding.authError` keeps its name and its persisted meaning (a
 * failure Retry cannot fix) — what changes is which sentence a reader sees
 * when it is set. `extractClause.ts` is unchanged by this task and stores
 * only `error.message` on the finding, never a `ModelError.code`, so this
 * is the one signal available: the real gateway text for a
 * `service_misconfigured` failure (`callModel.ts`, `credentials/resolve.ts`)
 * names itself this way on purpose, precisely so a reader — human or code —
 * can tell "the firm's configuration is broken" apart from any other
 * failure without guessing. A finding carrying older wording (a stale
 * OpenRouter-era rejection, say) simply doesn't match, and renders as an
 * ordinary error card exactly as it always has.
 */
function namesConfigurationFault(errorText: string | undefined): boolean {
  return !!errorText && errorText.toLowerCase().includes(SERVICE_CONFIG_HINT);
}

export interface ResultsViewProps {
  run: ReviewRun;
  documents: DocumentFile[];
  settings: WorkspaceSettings;
  onRetryCell: (docId: string, clauseId: string) => void;
  /** Optional: wired in Task 17. Renders the "Tabular view" toggle only when supplied. */
  onOpenTabular?: () => void;
  /** Opens the Report view -- the third renderer over this same findings
   *  map (R-G11). Optional, like the toggle above: omitted, the tab is not
   *  offered rather than offered dead. */
  onOpenReport?: () => void;
  /** Where to land when this view is opened from the comparison grid's
   *  "Open in review" handoff: the document to show and the clause to put
   *  the keyboard cursor on. Without this the grid's handoff would drop the
   *  reader on clause 1 of whichever document happened to be first, which
   *  is not the cell they clicked — and a triage surface whose handoff
   *  loses your place is one nobody uses twice.
   *
   *  Applied on mount and whenever it changes, not merged into the
   *  document-switch effect: switching documents by hand must still reset
   *  the cursor to the top, which is a different intent from being sent
   *  somewhere specific. */
  openAt?: { docId: string; clauseId: string };
  /** Reports a failure from an assistant action (email, revision, export) so
   *  the caller can surface it however it surfaces other errors (a toast in
   *  App.tsx). Failures here are non-fatal to the run itself. */
  onError?: (message: string) => void;
  /** An auth-class failure from anywhere in this view (draft email, export,
   *  suggest fix, or the chat panel) — routed here, with the real error,
   *  instead of through `onError`, so the caller can split it into the
   *  right sentence for the right audience (`handleModelError`, Task 23)
   *  rather than showing it as if it were a normal failure (Important 4).
   *  Settings no longer holds anything that could fix either half of this
   *  split, so this never implies "go there". */
  onAuthError?: (error: unknown) => void;
  /** Mirrors `FindingCard`'s `interrupted` prop (Important 1): true when this
   *  run is not currently live (reopened after an abandoned run), so
   *  pending/running cards get a Retry action instead of looking like work
   *  still in flight. */
  interrupted?: boolean;
  /** Persists the human's verification intent for one finding (Task 10).
   *  Optional: omitted entirely, a card renders its state chip with no
   *  controls rather than an action that goes nowhere. */
  onVerify?: (
    docId: string, clauseId: string, change: VerificationChange, atVersion?: number,
  ) => Promise<void>;
  /** Persists a new note against one finding (Task 10). Same optionality
   *  reasoning as `onVerify`. */
  onAddNote?: (docId: string, clauseId: string, text: string) => Promise<void>;
  /** Key (`findingKey(docId, clauseId)`) of the one finding whose
   *  verification, note, or net position write is currently in flight — see
   *  `App.tsx`'s `verifyBusyKey`. `null`/omitted means nothing is in flight.
   *  Net position writes share this key with verification/notes: they all
   *  mutate the same `Finding` record, and a second concurrent write to it
   *  is exactly what this key exists to prevent. */
  verifyBusyKey?: string | null;
  /**
   * The client cannot vouch for what is on screen (section 3's fourth load
   * state, Task 20). Passed to every card so the controls that compose a
   * human-authored write go dead, with a sentence saying why — the
   * findings themselves stay exactly where they are.
   */
  stale?: boolean;
  /** The local profile's initials, for a note's author placeholder. */
  authorInitials?: string;
  /** The local profile's id, for deciding which notes read as "yours". */
  localUserId?: string;
  /**
   * Resolves the disposition a card should name (§6.3, Stage 4) —
   * `src/lib/api/findings.ts`'s `dispositionFor`, with the review closed
   * over.
   *
   * A LOOKUP rather than a map, because the map lives in one module cache
   * keyed by review and copying it into a prop would be a second copy of the
   * one fact a card's attribution line rests on. Optional: omitted, a card
   * says it has not read the disposition rather than claiming nobody checked
   * the clause.
   */
  dispositionOf?: (findingsKey: string, clauseId: string) => DispositionWithHistory | undefined;
  /** How a card turns a user id into a name and an instant into a time.
   *  Optional, and a card given none names nobody. */
  audience?: DispositionAudience;
  /** A refused change and the row that refused it, for the ONE cell it is
   *  about (§6.3). Passed to that card and to no other. */
  /**
   * WHEN THIS REVIEW'S DISPOSITIONS WERE READ, AND HOW TO NAME WHO SET THEM
   * (section 6.3.1).
   *
   * Built by `App.tsx`, which is the only place that holds all three facts
   * at once. Optional so a preview can render; absent, the exports fall back
   * to `NO_EXPORT_CONTEXT`, which dates nothing and names nobody rather than
   * inventing either.
   */
  exportContext?: ExportContext;
  verifyConflict?: VerificationConflict | null;
  onReapplyConflict?: () => void;
  onDismissConflict?: () => void;
  /** Persists the human's acceptance of a collection clause's synthesised
   *  net position (Task 8). Same optionality reasoning as `onVerify`. */
  onConfirmNetPosition?: (docId: string, clauseId: string) => Promise<void>;
  /** Persists the human's rewritten net position text. */
  onAmendNetPosition?: (docId: string, clauseId: string, text: string) => Promise<void>;
  /** documentId to documentDate, for the variation trail's "date where
   *  known" (`DocumentFile`, unlike `DocumentRecord`, carries no date at
   *  all). Optional: omitted, a trail step simply shows no date rather than
   *  guessing one. */
  documentDates?: Record<string, number>;
  /** The result of the caller resolving `run.playbookVersionId` against the
   *  LIVE playbookVersions store (R-D15) — `null` once that lookup has run,
   *  succeeded, and found nothing (the version was deleted), a
   *  `PlaybookVersion` once it succeeds and finds one, or the literal
   *  string `'error'` when the lookup attempt itself threw. `undefined`
   *  means "not resolved yet" and is NOT the same as either `null` or
   *  `'error'`: while `run.playbookVersionId` is present but this is still
   *  `undefined`, the header renders nothing rather than guessing "deleted"
   *  (or claiming a failure that hasn't happened) before the lookup has
   *  actually run. A failed lookup, once it has actually happened, is
   *  reported loudly (`ReviewVersionLine`'s `lookupFailed`) rather than
   *  left indistinguishable from "still loading" — collapsing the two let a
   *  `getVersion` throw hide the whole line with no error at all. Irrelevant
   *  (and ignored) when `run.playbookVersionId` itself is absent. */
  playbookVersion?: PlaybookVersion | null | 'error';
  /** Opens Version History for the playbook this run ran against. Optional:
   *  omitted, a resolved "Ran against vN" line renders as plain text with
   *  nothing to click. */
  onShowVersionHistory?: () => void;
  /** The matter this run belongs to, if any — carried into every model call
   *  made from this screen (draft email, suggest a fix, the assistant chat)
   *  as `InferContext.matterId` so the gateway's audit record can answer
   *  "which matter did this call serve". Absent for a run started outside a
   *  matter, which is a genuine fact (Task 21) — never invented. */
  matterId?: string;
  /**
   * WHO ELSE IS ON THIS REVIEW, as the server last stated it (§8, Task 23).
   *
   * Passed down rather than subscribed to here, because `App` already holds
   * the review's subscription and a second one would be a second answer to
   * "who is here" on one screen. Optional: absent, nothing is drawn, which
   * is what a review nobody else is in looks like.
   *
   * ADVISORY. It gates nothing on this screen: every control a stale client
   * must not offer is governed by `stale`, and no control anywhere reads
   * this list. The day a "somebody else is on this clause" warning becomes a
   * refusal is the day presence stops being advisory (S6).
   */
  presence?: PresenceMember[];
  /**
   * EVERY OPEN REQUEST ON THIS REVIEW (§6.3, S17, Task 25) — in both
   * directions: what has been asked of you, and what you have asked of
   * others.
   *
   * One list, filtered per card by the cell it names, for the reason the
   * findings map is one map read by two renderers: a second list per card
   * would be a second answer to "what has been asked here".
   *
   * Optional: absent, the assign action does not render — the same rule
   * `onVerify` follows, since a control that goes nowhere is worse than no
   * control.
   */
  assignments?: AssignmentView[];
  /** The request the store actually took, after an assign. */
  onAssigned?: (assignment: AssignmentView) => void;
  /** Closes one, by the assignee or the assigner. */
  onResolveAssignment?: (id: string) => void;
  /** The open-requests read failed. Said on the panel, never swallowed into
   *  an empty list — "nobody asked you anything" and "the read failed" are
   *  the same pixels once one is flattened into the other. */
  assignmentsError?: string;
  onRetryAssignments?: () => void;
}

type Tab = 'findings' | 'chat';

/**
 * Three panes (Task 23, `1b`'s ledger): a clause index rail, a finding
 * column (the cards, in template order, plus the Findings/Assistant tab
 * pair moved into its header per R-GP7), and DocumentViewer. A document
 * switcher in the finding column's header swaps the findings and the
 * viewer together when the run covers more than one document. `highlights`
 * is local state set by a citation click and handed straight to the
 * viewer — that's the whole feature this screen exists for.
 *
 * `ClauseIndex` is purely a second way to MOVE the same keyboard cursor
 * (`focusIndex`) that `useVerifyKeys` already drives — it reads the same
 * `findings` map the cards read and computes no count or status of its own
 * (CLAUDE.md's sibling-drift rule). Every clause's card still renders in
 * the finding column exactly as it did in the two-pane layout; the index
 * does not hide any of them. Collapsing the finding column down to a
 * single active card was considered and rejected: two existing regression
 * tests (`App.rerunResets.test.tsx`'s "leaves the verification of other
 * findings alone", and this file's own "renders exactly as before") prove,
 * with no keyboard movement at all, that a second clause's chip/summary is
 * on screen alongside the first — a single-card column would make both
 * false. See this task's report for the full account.
 *
 * Responsive collapse (also this task, F17b — Task 22 deliberately skipped
 * this screen so the pass is written once against the layout that ships):
 * below `lg` the document pane is reachable through an "Open in document"
 * toggle instead of sitting in its own column; below `md` the clause index
 * becomes a `<select>`, the same control shape already used for switching
 * documents above.
 */
export function ResultsView({
  run, documents, settings, onRetryCell, onOpenTabular, onOpenReport, onError, onAuthError,
  interrupted = false,
  onVerify, onAddNote, verifyBusyKey, stale = false, authorInitials, localUserId,
  dispositionOf, audience, exportContext, verifyConflict, onReapplyConflict, onDismissConflict,
  onConfirmNetPosition, onAmendNetPosition, documentDates, openAt,
  playbookVersion, onShowVersionHistory, matterId, presence,
  assignments, onAssigned, onResolveAssignment, assignmentsError, onRetryAssignments,
}: ResultsViewProps) {
  const [activeDocId, setActiveDocId] = useState(run.documentIds[0] ?? '');
  const [highlights, setHighlights] = useState<string[]>([]);
  const [tab, setTab] = useState<Tab>('findings');
  const [focusIndex, setFocusIndex] = useState(0);
  const [rejectClauseId, setRejectClauseId] = useState<string | null>(null);
  /**
   * The disposition version the KEYBOARD path's reject dialog was opened
   * against (P36).
   *
   * Captured when the dialog opens, not read when it is submitted: a change
   * from somebody else landing while the reason is being typed moves the
   * module cache, and a submission taking the cache would land a rejection
   * on a state its author never read. What is stated is what was on screen.
   */
  const [rejectAtVersion, setRejectAtVersion] = useState<number | undefined>(undefined);

  const [emailLoading, setEmailLoading] = useState(false);
  const [emailContent, setEmailContent] = useState<string | null>(null);

  const [exportLoading, setExportLoading] = useState(false);
  const [historyExportLoading, setHistoryExportLoading] = useState(false);

  const [revisionLoadingClauseId, setRevisionLoadingClauseId] = useState<string | null>(null);
  const [revisionData, setRevisionData] = useState<RevisionData | null>(null);
  const [revisionOpen, setRevisionOpen] = useState(false);

  // Below `lg` the document pane lives behind an "Open in document" toggle
  // rather than its own column (§11's collapse order, applied here for the
  // first time — Task 22 skipped this screen deliberately).
  const [mobileDocOpen, setMobileDocOpen] = useState(false);

  // The comparison grid's "Open in review" handoff: land on the document
  // and clause the reader actually clicked. Keyed on the value itself so
  // opening the same cell twice re-focuses it, and separate from the
  // document-switch reset below because being *sent* somewhere and
  // *choosing* to switch documents are different intents.
  useEffect(() => {
    if (!openAt) return;
    const clauseIndex = run.templateSnapshot.clauses.findIndex(c => c.id === openAt.clauseId);
    if (run.documentIds.includes(openAt.docId)) setActiveDocId(openAt.docId);
    // A clause that is not in this run's playbook leaves the cursor alone
    // rather than sending it to index 0 — being dropped at the top of a
    // list is a worse answer than staying put, because it looks deliberate.
    if (clauseIndex >= 0) setFocusIndex(clauseIndex);
    setHighlights([]);
  }, [openAt, run.documentIds, run.templateSnapshot.clauses]);

  // If a fresh run REPLACES this one with a different document set, don't
  // keep pointing at a stale id.
  //
  // Guarded on the run actually changing rather than firing on mount too.
  // It used to reset the cursor on every mount, which silently undid the
  // `openAt` effect above: React runs effects in declaration order, so the
  // grid's handoff would set the cursor and this would immediately move it
  // back to clause 1. Relying on declaration order to fix that would have
  // worked and been quietly fragile — the next person to reorder two
  // effects would break a handoff with no test failing near their change.
  // A run that has not changed has nothing to reset.
  const lastRunIdRef = useRef(run.id);
  useEffect(() => {
    if (lastRunIdRef.current === run.id) return;
    lastRunIdRef.current = run.id;
    if (!run.documentIds.includes(activeDocId)) {
      setActiveDocId(run.documentIds[0] ?? '');
      setHighlights([]);
    }
    setFocusIndex(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run.id]);

  const activeDoc = useMemo(
    () => documents.find(d => d.id === activeDocId) ?? null,
    [documents, activeDocId],
  );

  const handleSwitchDoc = (id: string) => {
    setActiveDocId(id);
    setHighlights([]);
    setFocusIndex(0);
  };

  /**
   * A citation click opens the citation's OWN document, then highlights.
   *
   * Found by driving the real app in sub-project C's browser verification,
   * and the seventh instance of this sub-project's recurring shape: a
   * `documentId` sits on the record and the consumer ignores it. A
   * collection review keys one finding per clause, and that finding's
   * citations can belong to any document in the collection — so clicking a
   * quote from the base while the amendment was on screen used to leave
   * `activeDocId` alone and search the AMENDMENT for it, producing
   * "Couldn't locate this quote in the document ... the wording may not
   * match exactly" about a quote that is verbatim present one tab away.
   * Telling a reader their evidence cannot be found, when it can, is the
   * confident-wrong-answer failure this app exists to remove.
   *
   * Deliberately NOT `handleSwitchDoc`: that one is the "I chose to change
   * documents" intent and resets the keyboard cursor to the top of the
   * list. Following a citation must keep the cursor on the finding the
   * reader is reading — the same distinction `openAt` draws.
   *
   * The `run.documentIds` check keeps this correct on its own terms rather
   * than relying on the `activeDocId` effect to clean up after it. It is
   * unreachable from live data — `repairCitations` stamps the reviewed
   * document's own id, and `resolveStepCitations` resolves only against the
   * collection's members — and deliberately has no test, because that
   * effect masks any observable difference and a test here would pass
   * against the unguarded version too.
   */
  const handleCiteClick = (quotes: string[], documentId?: string) => {
    if (documentId && documentId !== activeDocId && run.documentIds.includes(documentId)) {
      setActiveDocId(documentId);
    }
    setHighlights(quotes);
    // Below `lg` the document pane is behind the "Open in document" toggle
    // (see `mobileDocOpen`) — a citation click is exactly the moment a
    // reader wants to see the highlight land, so it opens the overlay
    // rather than leaving them to notice the toggle themselves.
    setMobileDocOpen(true);
  };

  // Task 8A: a collection review's findings are keyed by the COLLECTION id
  // (`findingsKeyFor`, Task 6A), never by whichever document happens to be
  // active in the viewer pane — `activeDocId` only picks which document
  // the viewer/tab-strip show, and is not itself a valid lookup key for a
  // collection run. Guarded rather than always calling `findingsKeyFor`
  // with `activeDocId`: a `documents` target with no active id yet (e.g. an
  // empty `run.documentIds` on first render) must still degrade to an empty
  // pane instead of throwing (`findingsKeyFor` throws for that combination
  // on purpose — see its own doc comment).
  const findingsKey = isCollectionTarget(run.target)
    ? findingsKeyFor(run.target)
    : (activeDocId ? findingsKeyFor(run.target, activeDocId) : undefined);
  const findings = (findingsKey ? run.findings[findingsKey] : undefined) ?? {};

  // So `EvidenceList` can name a citation's document — a review can cover
  // several. `findingKey` (imported above) is the one place the
  // `docId::clauseId` shape is written; this must not re-template it inline
  // (a second copy of the shape is exactly how six of this project's
  // findings started).
  const documentNames = useMemo(
    () => Object.fromEntries(documents.map(d => [d.id, d.name])),
    [documents],
  );

  // What the variation trail needs about each document — same document set
  // as `documentNames` above, with whatever date `documentDates` knows for
  // it. Built here, once, rather than in `FindingCard` per clause: every
  // card on this screen shares the same document set.
  const documentInfo = useMemo(
    () => Object.fromEntries(documents.map(d => [d.id, {
      name: d.name,
      documentDate: documentDates?.[d.id],
    } satisfies TrailDocumentInfo])),
    [documents, documentDates],
  );

  const reportError = (fallback: string, error: unknown) => {
    // An auth-class failure is never just "this one action failed" — it
    // means every subsequent call will fail the same way, so it's handed to
    // the caller's split (`handleModelError`) instead of surfacing as an
    // ordinary toast (Important 4).
    if (isAuthFailure(error)) {
      onAuthError?.(error);
      return;
    }
    onError?.(error instanceof Error ? error.message : fallback);
  };

  const handleDraftEmail = async () => {
    if (!activeDocId) return;
    setEmailLoading(true);
    try {
      const body = await draftEmail(run, activeDocId, settings, matterId);
      setEmailContent(body);
    } catch (error) {
      reportError('Could not draft the email.', error);
    } finally {
      setEmailLoading(false);
    }
  };

  /**
   * THE REVIEW'S WHOLE DISPOSITION HISTORY, AS A FILE (section 6.3.1's
   * fourth requirement).
   *
   * Beside the other two exports, because it answers the question they
   * cannot: they say what the dispositions ARE as at an instant, and this
   * says how they got there. A firm reconstructing what a report would have
   * said on the day it was signed needs the second.
   *
   * `getAllReviewHistory` follows the cursor to the end and THROWS rather
   * than returning a partial history — a document titled "full history" that
   * silently stops at page one is the failure this whole project is about,
   * on the surface least likely to be checked by hand. The throw surfaces
   * here as a notice rather than as a file.
   */
  const handleExportHistory = async () => {
    setHistoryExportLoading(true);
    try {
      const events = await getAllReviewHistory(run.id);
      downloadHistoryCsv(events, {
        readAt: exportContext?.readAt,
        timeZone: exportContext?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
        audience: exportContext?.audience ?? NO_EXPORT_CONTEXT.audience,
        reviewName: run.templateSnapshot.name,
      });
    } catch (error) {
      reportError('Could not export this review s history.', error);
    } finally {
      setHistoryExportLoading(false);
    }
  };

  const handleExport = async () => {
    if (!activeDocId || !activeDoc) return;
    setExportLoading(true);
    try {
      await exportDocx(run, activeDocId, activeDoc.name, documentNames,
        exportContext ?? NO_EXPORT_CONTEXT);
    } catch (error) {
      reportError('Could not export the report.', error);
    } finally {
      setExportLoading(false);
    }
  };

  const handleSuggestFix = async (clause: PlaybookClause, finding: Finding) => {
    setRevisionLoadingClauseId(clause.id);
    try {
      const original = finding.citations[0]?.quote ?? finding.summary ?? '';
      const revised = await suggestRevision(clause.title, original, finding.riskAnalysis ?? '', settings, {
        matterId, reviewId: run.id, clauseId: clause.id,
      });
      setRevisionData({ title: clause.title, original, revised });
      setRevisionOpen(true);
    } catch (error) {
      reportError('Could not generate a revision.', error);
    } finally {
      setRevisionLoadingClauseId(null);
    }
  };

  const clauses = run.templateSnapshot.clauses;
  const cardRefs = useRef<(HTMLDivElement | null)[]>([]);

  // `ClauseIndex`'s notion of "the active clause" is the SAME cursor
  // `focusIndex` already is — not a second piece of state to keep in sync.
  // Selecting a row just moves `focusIndex` to match, exactly as `j`/`k`
  // do, so the index's highlight, the keyboard cursor and the scrolled-to
  // card can never disagree with one another.
  const activeClauseId = clauses[focusIndex]?.id ?? null;
  const handleSelectClause = (clauseId: string) => {
    const i = clauses.findIndex(c => c.id === clauseId);
    if (i < 0) return;
    setFocusIndex(i);
    // Selecting a clause is a request to read it, which only ever makes
    // sense on the Findings tab — switching there mirrors what the
    // Assistant tab already is not: a place `focusIndex` has any meaning.
    setTab('findings');
  };

  // Keyboard nav for the verify loop (Task 13): j/k move, v/f act immediately,
  // r opens the reason dialog rather than rejecting directly — a keyboard
  // shortcut must never be able to reject something silently.
  useVerifyKeys({
    enabled: tab === 'findings' && Boolean(onVerify),
    count: clauses.length,
    index: focusIndex,
    onIndexChange: setFocusIndex,
    onVerify: (i, change) => {
      const clause = clauses[i];
      if (!clause || !onVerify) return;
      // Critical 2 fix: the mouse path only ever offers verification controls
      // on a `done` finding (`FindingCard` renders `VerificationControls` —
      // and the `StateChip` that would show the result — only in its `done`
      // branch). The keyboard hook is index-based and knows nothing about a
      // finding's status, so without this gate `v`/`f`/`r` could write
      // `verified`/`flagged`/`rejected` onto a pending, running, error or
      // cancelled card — with no chip to show it happened, yet it would
      // still count in the progress indicators and in the export summary.
      // That is precisely "a finding nobody could have read, exported as
      // verified" — the thing this sub-project exists to prevent. Silently
      // ignoring the keypress here (rather than surfacing a notice) matches
      // how the mouse path behaves: there is simply no control to press.
      // `isVerifiable` (shared with `FindingCard`'s own gate on the same
      // rule — see its doc comment) replaces what used to be this file's own
      // inline `status !== 'done'` copy of the check.
      if (!isVerifiable(findings[clause.id])) return;
      // Minor 5: the mouse path (`VerificationControls`) disables itself
      // while `verifyBusyKey` names the finding currently being written —
      // the keyboard path had no equivalent, so a fast repeat keypress
      // (`v` then `v`, or `v` then `f`) could start a second write before
      // the first was known to have persisted, with the second racing the
      // first's read-modify-write on `latestRunRef`. Gate it the same way.
      if (verifyBusyKey === findingKey(activeDocId, clause.id)) return;
      const at = findingsKey ? dispositionOf?.(findingsKey, clause.id)?.disposition.version
        : undefined;
      if (change.state === 'rejected') {
        setRejectClauseId(clause.id);
        setRejectAtVersion(at);
        return;
      }
      void onVerify(activeDocId, clause.id, change, at);
    },
  });

  // A keyboard cursor that never scrolls into view is unusable once the list
  // outgrows the visible pane.
  useEffect(() => {
    cardRefs.current[focusIndex]?.scrollIntoView({ block: 'nearest' });
  }, [focusIndex]);

  /*
   * *"I AM HERE, ON THIS REVIEW, LOOKING AT THIS CLAUSE"* (§8, Task 23).
   *
   * The SELECTED clause — `activeClauseId` is the same cursor `j`/`k` and
   * the rail both move — and never the clause nearest the top of the
   * viewport. A scroll-derived presence would broadcast a stream of clause
   * changes and would tell a colleague something the reader never chose to
   * say.
   *
   * Reported here rather than in `App` because this is where the selection
   * lives; the report is a fire-and-forget frame on the socket the tab
   * already holds, and `reportPresence(null)` on unmount is what stops this
   * screen claiming a reader who has navigated away.
   */
  useEffect(() => {
    reportPresence({
      sub: { review: run.id },
      screen: 'review',
      ...(activeClauseId ? { clauseId: activeClauseId } : {}),
    });
    return () => { reportPresence(null); };
  }, [run.id, activeClauseId]);

  /** Clause id -> the colleagues who have selected it. Derived from the one
   *  roster this screen was handed, never accumulated across frames. */
  const presenceByClause = useMemo(() => {
    const out: Record<string, PresenceMember[]> = {};
    for (const member of presence ?? []) {
      if (!member.clauseId || member.userId === localUserId) continue;
      (out[member.clauseId] ??= []).push(member);
    }
    return out;
  }, [presence, localUserId]);

  /**
   * Clause id -> every open request about it, WHOEVER was asked.
   *
   * ## The party filter moved INTO the card, and did not go away
   *
   * It used to be here, because `assignment.created` is a review-scoped
   * event and the card's line is first person: a third reviewer was
   * otherwise told "You asked B. Trainee to look at this", under a message
   * B's assigner wrote, beside a live "Withdraw the request" button — an
   * action offered on somebody else's act.
   *
   * Dropping the row entirely was the right fix while a bystander had
   * nothing honest to be shown. Stage 5 Task 3 gives them something: a chip
   * saying somebody was **asked to look**, with no first-person claim and no
   * control. So the filter is now `FindingCard`'s — through the same
   * `assignmentParty`, which is still the one place that comparison is made
   * — and it decides which of two renders a row gets rather than whether the
   * row survives at all.
   *
   * The same set `GET /v1/reviews/:id/assignments` answers with, so what a
   * card shows live is what it shows after a reload.
   */
  const assignmentsByClause = useMemo(() => {
    const out: Record<string, AssignmentView[]> = {};
    for (const a of assignments ?? []) {
      if (findingsKey && a.findingsKey !== findingsKey) continue;
      (out[a.clauseId] ??= []).push(a);
    }
    return out;
  }, [assignments, findingsKey]);

  /** Only the ones addressed to YOU, for the panel that says so. Through
   *  the same comparison the cards use, rather than a second copy of it. */
  const askedOfMe = useMemo(
    () => (assignments ?? []).filter(a => assignmentParty(a, localUserId) === 'assignee'),
    [assignments, localUserId]);

  const clauseTitles = useMemo(
    () => Object.fromEntries(clauses.map(c => [c.id, c.title])),
    [clauses]);

  return (
    <div className="h-full flex flex-col md:flex-row bg-paper min-h-0">
      {/* The clause index rail, `md` and up. */}
      <div className="hidden md:flex md:shrink-0">
        <ClauseIndex
          clauses={clauses}
          findings={findings}
          activeClauseId={activeClauseId}
          onSelect={handleSelectClause}
          presenceByClause={presenceByClause}
          assignmentsByClause={assignmentsByClause}
          audience={audience}
        />
      </div>
      {/* Flexible, not `shrink-0`. Fixing 258px of rail + 470px of finding
         column at every width above `md` left the document pane ~279px at
         1024px and ~533px at 1278px — narrower than a page at any zoom the
         control offers, which is how the clipped-left-margin defect above
         went unnoticed. The column now takes what is left below `lg` (where
         the document pane is a toggled overlay, so fixing 470px merely left
         dead space beside it), a smaller fixed width once the document pane
         claims a column of its own, and its full design width at `xl`. */}
      <div
        data-pane="findings"
        className="w-full md:flex-1 md:min-w-0 lg:flex-none lg:w-[380px] xl:w-[470px] border-r border-rule flex flex-col bg-card min-h-0"
      >
        {/* WHAT HAS BEEN ASKED OF YOU, at the top of the column the cards
           are in — §18 item 5's "an assignment reaches the assignee". A
           mechanism nobody can see reaches nobody. */}
        <AskedOfYou
          assignments={askedOfMe}
          audience={audience}
          clauseTitles={clauseTitles}
          onOpenClause={(_key, clauseId) => handleSelectClause(clauseId)}
          error={assignmentsError}
          onRetry={onRetryAssignments}
        />
        <div className="p-4 border-b border-rule flex items-center justify-between gap-3">
          {run.documentIds.length > 1 ? (
            <select
              value={activeDocId}
              onChange={(e) => handleSwitchDoc(e.target.value)}
              className="flex-1 min-w-0 bg-card border border-rule-strong rounded-control px-2 py-1.5 font-ui text-ui text-ink-1 outline-none focus:ring-1 focus:ring-accent"
            >
              {run.documentIds.map(id => {
                const doc = documents.find(d => d.id === id);
                return (
                  <option key={id} value={id}>{doc?.name ?? id}</option>
                );
              })}
            </select>
          ) : (
            <span className="font-ui text-ui font-medium text-ink-1 truncate">{activeDoc?.name ?? 'Document'}</span>
          )}

          {/* WHO ELSE IS HERE, beside how much of the review is done — two
             facts about the same screen, and deliberately not merged: one
             is what has been decided and the other is who is reading. */}
          <PresenceRoster members={presence ?? []} meId={localUserId} audience={audience} />

          <span
            className="shrink-0 font-mono text-pin text-ink-4"
            title={run.documentIds.length > 1 ? 'Findings a human has verified, across every document in this run' : 'Findings a human has verified'}
          >
            {progressLabel(run.findings)}{run.documentIds.length > 1 ? ' · whole run' : ''}
          </span>

          {/* Below `lg` the document pane lives behind this toggle instead
             of its own column (§11's collapse order — the document pane
             collapses first). */}
          {/* `relative`: containing block for the sr-only label (see the
             note on the finding scroller below — same pattern, swept here
             too). */}
          <button
            type="button"
            onClick={() => setMobileDocOpen(true)}
            title="Open in document"
            className="relative lg:hidden shrink-0 p-2 bg-chip-fill rounded-control hover:bg-paper transition-colors text-ink-2"
          >
            <FileText className="w-4 h-4" aria-hidden="true" />
            <span className="sr-only">Open in document</span>
          </button>

          {(onOpenTabular || onOpenReport) && (
            <ViewSwitch
              value="review"
              onChange={(next) => {
                if (next === 'compare' && onOpenTabular) onOpenTabular();
                if (next === 'report' && onOpenReport) onOpenReport();
              }}
              target={run.target}
              documentCount={run.documentIds.length}
            />
          )}
        </div>

        {/* R-D15: only render once the caller has actually tried to resolve
           `run.playbookVersionId` — while it is present but `playbookVersion`
           is still `undefined` (the lookup hasn't settled yet), this stays
           silent rather than guessing "deleted" ahead of the real answer.
           `'error'` is a SETTLED outcome (the lookup ran and threw), not the
           "still loading" `undefined` case, so it renders too — as a loud
           failure via `lookupFailed`, never as silence or a false "deleted". */}
        {(run.playbookVersionId === undefined || playbookVersion !== undefined) && (
          <div className="px-4 py-1.5 border-b border-rule shrink-0">
            <ReviewVersionLine
              versionId={run.playbookVersionId}
              version={
                run.playbookVersionId === undefined || playbookVersion === 'error'
                  ? null
                  : (playbookVersion ?? null)
              }
              lookupFailed={playbookVersion === 'error'}
              onOpenHistory={onShowVersionHistory}
            />
          </div>
        )}

        <div className="flex border-b border-rule shrink-0">
          <button
            onClick={() => setTab('findings')}
            className={`flex-1 py-3 font-ui text-ui font-medium transition-colors ${tab === 'findings' ? 'text-accent border-b-2 border-accent' : 'text-ink-3 hover:text-ink-1'}`}
          >
            Findings
          </button>
          <button
            onClick={() => setTab('chat')}
            className={`flex-1 py-3 font-ui text-ui font-medium transition-colors ${tab === 'chat' ? 'text-accent border-b-2 border-accent' : 'text-ink-3 hover:text-ink-1'}`}
          >
            Assistant
          </button>
        </div>

        {tab === 'findings' && onVerify && (
          <div className="px-4 py-1.5 flex flex-wrap items-center gap-1 font-mono text-pin text-ink-4 border-b border-rule shrink-0">
            <span className="bg-chip-fill rounded-chip px-1">j/k</span>
            <span>move</span>
            <span className="mx-0.5" aria-hidden="true">·</span>
            <span className="bg-chip-fill rounded-chip px-1">v</span>
            <span>verify</span>
            <span className="mx-0.5" aria-hidden="true">·</span>
            <span className="bg-chip-fill rounded-chip px-1">f</span>
            <span>flag</span>
            <span className="mx-0.5" aria-hidden="true">·</span>
            <span className="bg-chip-fill rounded-chip px-1">r</span>
            <span>reject</span>
          </div>
        )}

        <div className="h-1 bg-rule shrink-0" role="progressbar" aria-valuenow={progressPercent(run.findings)} aria-valuemin={0} aria-valuemax={100}>
          <div className="h-full bg-accent transition-all" style={{ width: `${progressPercent(run.findings)}%` }} />
        </div>

        {tab === 'findings' ? (
          <div
            // `relative` is load-bearing, not decoration. Every card's
            // icon-only Retry button carries an `sr-only` label, and
            // Tailwind's `sr-only` is `position: absolute` — with no
            // positioned ancestor its containing block is the page itself,
            // so a label sitting 14,000px down this scrolled list extended
            // the DOCUMENT to 14,000px and gave the review screen a second,
            // whole-window scrollbar over blank space. Positioning this
            // scroller puts those labels inside the box that clips them.
            // Verified in the browser: `document.scrollingElement.
            // scrollHeight` drops from 14,570 to the viewport's own 1,352
            // and the window scrollbar disappears.
            className="relative flex-1 overflow-y-auto p-4 space-y-4 min-h-0"
          >
            <div className="flex justify-between items-center">
              <h3 className="font-prose text-section text-ink-1">Analysis</h3>
              <div className="flex gap-2">
                <button
                  onClick={handleDraftEmail}
                  disabled={emailLoading || !activeDocId}
                  title="Draft Email"
                  className="p-2 bg-chip-fill rounded-control hover:bg-paper transition-colors text-ink-2 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {emailLoading ? (
                    <span data-busy="true" aria-live="polite" className="flex items-center">
                      <Loader className="w-4 h-4 animate-spin" aria-hidden="true" />
                    </span>
                  ) : <Mail className="w-4 h-4" aria-hidden="true" />}
                </button>
                <button
                  onClick={handleExport}
                  disabled={exportLoading || !activeDocId}
                  title="Export DOCX"
                  className="p-2 bg-accent rounded-control hover:bg-accent-strong transition-colors text-page disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {exportLoading ? (
                    <span data-busy="true" aria-live="polite" className="flex items-center">
                      <Loader className="w-4 h-4 animate-spin" aria-hidden="true" />
                    </span>
                  ) : <FileDown className="w-4 h-4" aria-hidden="true" />}
                </button>
                {/* Beside the DOCX export, deliberately. The tabular grid was
                    the only place that offered a CSV, and it refuses to render
                    for a collection review — so a collection could not be
                    exported to CSV at all, though C's spec requires it (§3.8,
                    DoD §10.7). Keeping both exporters in one place is also the
                    reachability half of the rule that stops them drifting. */}
                <button
                  onClick={() => downloadTabularCsv(run, documents,
                    exportContext ?? NO_EXPORT_CONTEXT)}
                  title="Export CSV"
                  className="p-2 bg-chip-fill rounded-control hover:bg-paper transition-colors text-ink-2"
                >
                  <Table className="w-4 h-4" aria-hidden="true" />
                </button>
                {/* Section 6.3.1's fourth requirement, reachable. A route
                    with no caller is what Stage 3 shipped and P28 warns
                    about; a history nobody can take out of the app answers
                    "what did this say when it was signed" only for as long
                    as somebody has the app open. */}
                <button
                  onClick={() => { void handleExportHistory(); }}
                  disabled={historyExportLoading}
                  title="Export history"
                  className="p-2 bg-chip-fill rounded-control hover:bg-paper transition-colors text-ink-2 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {historyExportLoading ? (
                    <span data-busy="true" aria-live="polite" className="flex items-center">
                      <Loader className="w-4 h-4 animate-spin" aria-hidden="true" />
                    </span>
                  ) : <History className="w-4 h-4" aria-hidden="true" />}
                </button>
              </div>
            </div>

            {clauses.map((clause, i) => {
              const finding = findings[clause.id];
              // Task 23: a finding whose OWN error text names a
              // configuration fault renders the same panel a live one
              // would, in place of the ordinary card — never both at once,
              // and never a Settings affordance either way.
              const showServiceConfigError =
                !!finding?.authError && namesConfigurationFault(finding.error);
              return (
                <div
                  key={clause.id}
                  ref={(el) => { cardRefs.current[i] = el; }}
                  className={`rounded-card transition-shadow ${focusIndex === i ? 'ring-1 ring-accent-edge' : ''}`}
                >
                  {showServiceConfigError ? (
                    <>
                      {/* The panel stands in for a whole `FindingCard`, and
                         a card is the only thing on this screen that says
                         WHICH clause it is about. In a twenty-clause list
                         the reader could not tell which one failed — a
                         wall of identical panels naming nothing. The title
                         is rendered here rather than inside
                         `ServiceConfigError`, which is also mounted at the
                         shell level where there is no clause. */}
                      <h4 className="font-prose text-section text-ink-1 mb-2">{clause.title}</h4>
                      <ServiceConfigError
                        error={new ModelError(
                          finding!.error ?? 'LexPrompt could not reach the model service.',
                          'service_misconfigured',
                          503,
                        )}
                        onRetry={() => onRetryCell(activeDocId, clause.id)}
                      />
                    </>
                  ) : (
                    <FindingCard
                      clause={clause}
                      finding={finding}
                      onCiteClick={handleCiteClick}
                      onRetry={(clauseId) => onRetryCell(activeDocId, clauseId)}
                      onSuggestFix={handleSuggestFix}
                      suggestFixLoading={revisionLoadingClauseId === clause.id}
                      interrupted={interrupted}
                      onVerify={onVerify
                        ? (change, atVersion) => onVerify(activeDocId, clause.id, change, atVersion)
                        : undefined}
                      onAddNote={onAddNote ? (text) => onAddNote(activeDocId, clause.id, text) : undefined}
                      verifyBusy={verifyBusyKey === findingKey(activeDocId, clause.id)}
                      stale={stale}
                      noteBusy={verifyBusyKey === findingKey(activeDocId, clause.id)}
                      documentNames={documentNames}
                      authorInitials={authorInitials}
                      localUserId={localUserId}
                      // Keyed by `findingsKey`, never by `activeDocId` —
                      // a collection review produces one disposition per
                      // clause however many documents fed it, and the
                      // active document only decides which one the viewer
                      // pane shows.
                      disposition={findingsKey ? dispositionOf?.(findingsKey, clause.id) : undefined}
                      audience={audience}
                      conflict={
                        verifyConflict && findingsKey === verifyConflict.findingsKey
                          && clause.id === verifyConflict.clauseId
                          ? verifyConflict : undefined
                      }
                      onReapplyConflict={onReapplyConflict}
                      onDismissConflict={onDismissConflict}
                      // Keyed by `findingsKey` for the reason the
                      // disposition above is: a collection review produces
                      // one set of requests per clause however many
                      // documents fed it.
                      assignments={assignmentsByClause[clause.id]}
                      assignTarget={findingsKey && onAssigned
                        ? { reviewId: run.id, findingsKey } : undefined}
                      onAssigned={onAssigned}
                      onResolveAssignment={onResolveAssignment}
                      // The KEYBOARD path's reject dialog (`r`), which this
                      // view owns and the card cannot see. The card's own
                      // dialog reports itself; both feed one gate, so an
                      // incoming change is held under either (P36).
                      rejectModalOpen={rejectClauseId === clause.id}
                      onConfirmNetPosition={onConfirmNetPosition ? () => onConfirmNetPosition(activeDocId, clause.id) : undefined}
                      onAmendNetPosition={onAmendNetPosition ? (text) => onAmendNetPosition(activeDocId, clause.id, text) : undefined}
                      netPositionBusy={verifyBusyKey === findingKey(activeDocId, clause.id)}
                      documentInfo={documentInfo}
                    />
                  )}
                </div>
              );
            })}
          </div>
        ) : (
          <Suspense fallback={<div className="p-4 font-ui text-ui-sm text-ink-4">Loading assistant…</div>}>
            <ChatPanel documents={activeDoc ? [activeDoc] : []} settings={settings} onAuthError={onAuthError} matterId={matterId} />
          </Suspense>
        )}
      </div>

      {/* Below `md` the clause index collapses into a `<select>` — the
         same control shape the document switcher above already uses.
         `order-first` puts it visually above the finding column on a
         stacked mobile layout despite sitting after it in the DOM; DOM
         order itself is deliberate — `ResultsView — a citation opens its
         own document`'s `activeDoc` helper reads `container.querySelector
         ('select')` expecting the DOCUMENT switcher, and jsdom applies no
         media query, so both selects exist in the tree regardless of
         viewport and whichever comes first in the DOM wins that query. */}
      <div className="order-first md:hidden shrink-0 border-b border-rule bg-card p-3">
        <select
          value={activeClauseId ?? ''}
          onChange={(e) => handleSelectClause(e.target.value)}
          className="w-full bg-card border border-rule-strong rounded-control px-2 py-1.5 font-ui text-ui text-ink-1 outline-none focus:ring-1 focus:ring-accent"
        >
          {clauses.map(clause => (
            <option key={clause.id} value={clause.id}>{clause.title}</option>
          ))}
        </select>
      </div>

      {/* The document pane: its own column from `lg` up; below that, a
         toggled full-screen overlay. Never conditionally unmounted by the
         toggle — a scan's page images are regenerated per session and
         cached (`documentFileForReview`), and closing/reopening this pane
         must not pay that cost again. */}
      <div
        data-pane="document"
        className={`${mobileDocOpen ? 'fixed inset-0 z-50 flex' : 'hidden'} lg:static lg:z-auto lg:flex lg:flex-1 lg:min-w-0 flex-col bg-paper`}
      >
        <button
          type="button"
          onClick={() => setMobileDocOpen(false)}
          className="lg:hidden shrink-0 flex items-center gap-1.5 px-4 py-2 border-b border-rule bg-card font-ui text-ui text-ink-2"
        >
          <X className="w-4 h-4" aria-hidden="true" /> Close
        </button>
        <div className="flex-1 min-h-0">
          <DocumentViewer doc={activeDoc} highlights={highlights} />
        </div>
      </div>

      {emailContent !== null && (
        <Suspense fallback={null}>
          <EmailModal isOpen onClose={() => setEmailContent(null)} content={emailContent} />
        </Suspense>
      )}

      <RevisionModal isOpen={revisionOpen} onClose={() => setRevisionOpen(false)} data={revisionData} />

      <RejectReasonModal
        open={rejectClauseId !== null}
        // Minor 3: mirrors `VerificationControls`'s own mount — re-rejecting
        // an already-rejected finding (via `r`) must prefill its existing
        // reason exactly as the mouse path does, or the same action behaves
        // differently depending on which entry point triggered it.
        initialReason={
          rejectClauseId && findings[rejectClauseId]?.verification.state === 'rejected'
            ? findings[rejectClauseId]?.verification.reason ?? ''
            : ''
        }
        onCancel={() => { setRejectClauseId(null); setRejectAtVersion(undefined); }}
        onConfirm={(reason) => {
          const clauseId = rejectClauseId;
          const atVersion = rejectAtVersion;
          setRejectClauseId(null);
          setRejectAtVersion(undefined);
          if (clauseId && onVerify) {
            void onVerify(activeDocId, clauseId, { state: 'rejected', reason }, atVersion);
          }
        }}
      />
    </div>
  );
}
