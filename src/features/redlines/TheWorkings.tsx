import React, { useState } from 'react';
import { Button } from '../../components/Button';
import type { InferredPosition } from '../../lib/inferPositions';
import type { ParsedEdit } from '../../lib/docxRedlines';

/**
 * "The workings" — spec §7. Opened from `WhatWeLearned`'s `onSeeWorkings`.
 *
 * The handoff's own reasoning, kept close to verbatim because it is the
 * whole rationale for this screen existing at all: *a lawyer will not adopt
 * a position they cannot see the workings for.* `WhatWeLearned` states a
 * claim ("your firm strikes absolute discretion, 4 of 4"); this screen is
 * the evidence behind it — the actual redline text, not a paraphrase of it.
 *
 * Two things this file refuses to do:
 *
 * - Show a deletion and an insertion as two disconnected fragments. A
 *   `ParsedEdit.context` is the whole paragraph as Word stored it — original
 *   wording and revised wording both present, in document order — so
 *   `Sentence` below locates each edit's own text inside that one string and
 *   marks it in place, rather than listing "before" and "after" in separate
 *   boxes. `<del>`/`<ins>` are used rather than presentational classes alone:
 *   they carry the meaning to assistive technology, and a strikethrough that
 *   is only a CSS class disappears the moment someone reads with a screen
 *   reader or copies the text. `redline-del`/`redline-ins` are the two
 *   tokens sub-project G's system reserves for exactly this pairing.
 * - Let a diff-derived position read as though it were a tracked change. A
 *   tracked change is a record of what someone actually did; a diff between
 *   two PDFs is an inference about what probably changed (spec §3a, Spike
 *   2). `position.diffDerivedOnly` gets its own, unmissable banner here for
 *   exactly that reason — this is the screen a lawyer is meant to trust the
 *   most, so it is the one place this distinction can least afford to blur.
 *
 * An edit whose text cannot be located verbatim inside its own `context`
 * (a truncated snippet, an XML oddity) is never dropped silently — it is
 * still rendered, appended after the sentence it belongs to. Losing an edit
 * quietly here would understate the evidence behind a claim this feature's
 * whole credibility rests on.
 *
 * A `moved` edit (neither insertion nor deletion) is rendered in `draft`
 * blue rather than `risk-med` amber: it is a structural fact about where
 * text sits, not a negotiation and not a warning (spec §3a's "a flagged
 * unit with no counterpart is a structural difference, not an amendment").
 */

export interface TheWorkingsProps {
  position: InferredPosition;
  /** documentId -> display name. Falls back to the raw id when a name was
   *  not supplied — better an id than a blank, matching `WhatWeLearned`. */
  documentNames?: Record<string, string>;
  onAdopt: (position: InferredPosition) => void;
  onReword: (position: InferredPosition, text: string) => void;
  onReject: (position: InferredPosition) => void;
  onClose: () => void;
}

type BasisEntry = InferredPosition['basis'][number];

interface ParagraphGroup {
  context: string;
  edits: ParsedEdit[];
  comments: ParsedEdit[];
}

/**
 * Groups a document's edits by the paragraph they came from, so a deletion
 * and its matching insertion (same `context`) render as one sentence rather
 * than two. An edit with no context (or a context no other edit shares) gets
 * its own group rather than being merged into an unrelated paragraph.
 */
function groupByContext(edits: ParsedEdit[]): ParagraphGroup[] {
  const groups = new Map<string, ParagraphGroup>();
  const order: string[] = [];
  edits.forEach((edit, i) => {
    const key = edit.context ? edit.context : `__no-context-${i}__`;
    let group = groups.get(key);
    if (!group) {
      group = { context: edit.context, edits: [], comments: [] };
      groups.set(key, group);
      order.push(key);
    }
    if (edit.kind === 'comment') group.comments.push(edit);
    else group.edits.push(edit);
  });
  return order.map((key) => groups.get(key)!);
}

interface Match {
  start: number;
  end: number;
  edit: ParsedEdit;
}

/** Locates each edit's own text inside the shared paragraph string. Edits
 *  that cannot be found (or that overlap an already-placed match) go to
 *  `unmatched` rather than being dropped — see the module comment. */
function findMatches(context: string, edits: ParsedEdit[]): { matches: Match[]; unmatched: ParsedEdit[] } {
  const candidates: Match[] = [];
  const unmatched: ParsedEdit[] = [];
  for (const edit of edits) {
    const start = edit.text ? context.indexOf(edit.text) : -1;
    if (start === -1) {
      unmatched.push(edit);
      continue;
    }
    candidates.push({ start, end: start + edit.text.length, edit });
  }
  candidates.sort((a, b) => a.start - b.start);

  const matches: Match[] = [];
  let lastEnd = -1;
  for (const m of candidates) {
    if (m.start >= lastEnd) {
      matches.push(m);
      lastEnd = m.end;
    } else {
      unmatched.push(m.edit);
    }
  }
  return { matches, unmatched };
}

function EditSpan({ edit }: { edit: ParsedEdit }) {
  if (edit.kind === 'deletion') {
    return <del className="line-through text-redline-del decoration-redline-del">{edit.text}</del>;
  }
  if (edit.kind === 'insertion') {
    return <ins className="underline decoration-redline-ins text-redline-ins">{edit.text}</ins>;
  }
  // A move is neither a deletion nor an insertion — Word's own distinction
  // (docxRedlines.ts) — so it is never struck or underlined as if it were
  // one; that would misreport a relocation as a cut-and-paste negotiation.
  return (
    <span className="italic text-draft">
      {edit.text} <span className="font-mono text-chip uppercase align-middle text-draft">(moved)</span>
    </span>
  );
}

function Sentence({ context, edits }: { context: string; edits: ParsedEdit[] }) {
  if (edits.length === 0) return null;

  if (!context) {
    return (
      <p className="font-prose italic text-quote text-ink-quote leading-relaxed">
        {edits.map((edit, i) => (
          <EditSpan key={i} edit={edit} />
        ))}
      </p>
    );
  }

  const { matches, unmatched } = findMatches(context, edits);
  const nodes: React.ReactNode[] = [];
  let cursor = 0;
  matches.forEach((m, i) => {
    if (m.start > cursor) nodes.push(context.slice(cursor, m.start));
    nodes.push(<EditSpan key={`m-${i}`} edit={m.edit} />);
    cursor = m.end;
  });
  if (cursor < context.length) nodes.push(context.slice(cursor));

  return (
    <p className="font-prose italic text-quote text-ink-quote leading-relaxed">
      {nodes}
      {unmatched.map((edit, i) => (
        // Could not be located verbatim inside its own context — shown
        // anyway, appended, rather than silently missing from the evidence.
        <React.Fragment key={`u-${i}`}>
          {' '}
          <EditSpan edit={edit} />
        </React.Fragment>
      ))}
    </p>
  );
}

function CommentNote({ comment }: { comment: ParsedEdit }) {
  const dateLabel = comment.at ? new Date(comment.at).toLocaleDateString() : undefined;
  return (
    <div className="mt-2 ml-3 border-l-2 border-l-rule-strong pl-3 py-1.5 bg-chip-fill rounded-r">
      <p className="font-ui text-ui-sm text-ink-2">{comment.text}</p>
      <p className="font-mono text-pin text-ink-4 mt-1">
        {comment.author ?? 'Unknown author'}
        {dateLabel ? ` · ${dateLabel}` : ''}
      </p>
    </div>
  );
}

function DocumentWorkings({
  basisEntry,
  documentLabel,
}: {
  basisEntry: BasisEntry;
  documentLabel: (id: string) => string;
}) {
  const groups = groupByContext(basisEntry.edits);
  return (
    <div className="border border-rule rounded-card p-4 bg-card space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="font-ui text-ui font-semibold text-ink-1">{documentLabel(basisEntry.documentId)}</h3>
        <span
          className={`font-mono text-chip uppercase px-1.5 py-0.5 rounded-chip border whitespace-nowrap ${
            basisEntry.supports
              ? 'border-outcome-meets text-outcome-meets'
              : 'border-outcome-deviates text-outcome-deviates'
          }`}
        >
          {basisEntry.supports ? 'Supports' : 'Opposes'}
        </span>
      </div>
      <div className="space-y-3">
        {groups.length === 0 ? (
          <p className="font-ui text-meta text-ink-3 italic">No edits recorded for this document.</p>
        ) : (
          groups.map((group, i) => (
            <div key={i}>
              <Sentence context={group.context} edits={group.edits} />
              {group.comments.map((comment, j) => (
                <CommentNote key={j} comment={comment} />
              ))}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

export function TheWorkings({ position, documentNames = {}, onAdopt, onReword, onReject, onClose }: TheWorkingsProps) {
  const [rewording, setRewording] = useState(false);
  const [rewordText, setRewordText] = useState(position.rewordedText ?? position.statement);
  const documentLabel = (id: string) => documentNames[id] ?? id;

  const handleSaveReword = () => {
    onReword(position, rewordText);
    setRewording(false);
  };

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-6 bg-paper">
      <button onClick={onClose} className="font-ui text-meta text-ink-3 hover:text-ink-1">
        &larr; Back to what we learned
      </button>

      <header className="space-y-2">
        <p className="font-mono text-label uppercase text-ink-4">{position.clauseTitle}</p>
        <h2 className="font-prose text-section text-ink-1">{position.statement}</h2>
        <p className="font-ui text-meta text-ink-3 italic">
          A lawyer will not adopt a position they cannot see the workings for &mdash; this is that evidence.
        </p>
      </header>

      {position.diffDerivedOnly && (
        <p className="font-ui text-ui text-risk-med bg-risk-med-tint border border-risk-med-edge rounded-card p-3">
          Not from tracked changes &mdash; inferred by comparing two document versions automatically, rather than
          read from a change someone actually recorded. Weaker evidence.
        </p>
      )}

      {position.contradicted && (
        <p className="font-ui text-ui text-risk-med bg-risk-med-tint border border-risk-med-edge rounded-card p-3">
          The redlines disagree on this one &mdash; shown below, unresolved. The app does not pick a side.
        </p>
      )}

      {position.basis.length === 0 ? (
        <p className="font-ui text-ui text-ink-3 italic">No redline text is attached to this position.</p>
      ) : (
        <div className="space-y-4">
          {position.basis.map((basisEntry) => (
            <DocumentWorkings key={basisEntry.documentId} basisEntry={basisEntry} documentLabel={documentLabel} />
          ))}
        </div>
      )}

      {rewording ? (
        <div className="space-y-2">
          <textarea
            aria-label="Reworded position"
            value={rewordText}
            onChange={(e) => setRewordText(e.target.value)}
            className="w-full bg-paper border border-rule rounded-control p-2 text-xs text-ink-1 outline-none focus:border-accent min-h-[60px]"
          />
          <div className="flex gap-2">
            <Button onClick={handleSaveReword}>Save reword</Button>
            <Button variant="ghost" onClick={() => setRewording(false)}>Cancel</Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2 pt-2 border-t border-rule">
          <Button onClick={() => onAdopt(position)}>Adopt</Button>
          <Button variant="ghost" onClick={() => setRewording(true)}>Reword</Button>
          <Button variant="danger" onClick={() => onReject(position)}>Not a house rule</Button>
        </div>
      )}
    </div>
  );
}
