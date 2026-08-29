import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { mount, click, buttonNamed } from '../../test/mount';
import { TheWorkings } from './TheWorkings';
import type { InferredPosition } from '../../lib/inferPositions';
import type { ParsedEdit } from '../../lib/docxRedlines';

function basePosition(overrides: Partial<InferredPosition> = {}): InferredPosition {
  return {
    id: 'p1',
    clauseTitle: 'Consent to assign',
    statement: "We strike the landlord's absolute discretion over consent.",
    strength: 'consistent',
    supporting: 1,
    total: 1,
    basis: [],
    contradicted: false,
    disposition: 'undecided',
    diffDerivedOnly: false,
    ...overrides,
  };
}

function baseProps(overrides: Partial<React.ComponentProps<typeof TheWorkings>> = {}) {
  return {
    position: basePosition(),
    onAdopt: vi.fn(),
    onReword: vi.fn(),
    onReject: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  };
}

describe('TheWorkings', () => {
  it('renders deletions struck and insertions underlined in the same sentence', () => {
    const context =
      "Consent may not be unreasonably withheld at the Landlord's absolute discretion, and consent may be " +
      'withheld only where it is reasonable to do so.';
    const deletion: ParsedEdit = {
      kind: 'deletion',
      text: "withheld at the Landlord's absolute discretion",
      context,
    };
    const insertion: ParsedEdit = {
      kind: 'insertion',
      text: 'withheld only where it is reasonable to do so',
      context,
    };
    const position = basePosition({ basis: [{ documentId: 'd1', supports: true, edits: [deletion, insertion] }] });

    const el = mount(<TheWorkings {...baseProps({ position })} />);

    const delEl = el.querySelector('del');
    const insEl = el.querySelector('ins');
    expect(delEl?.textContent).toContain("withheld at the Landlord's absolute discretion");
    expect(insEl?.textContent).toContain('withheld only where it is reasonable to do so');
    // "In the same sentence" — both fragments live inside the same <p>, not
    // two disconnected blocks.
    expect(delEl?.closest('p')).toBe(insEl?.closest('p'));
  });

  it('shows a margin comment with its author and date', () => {
    const comment: ParsedEdit = {
      kind: 'comment',
      text: 'We never accept an uncapped costs indemnity.',
      context: 'The Tenant shall indemnify the Landlord against all costs and expenses whatsoever.',
      author: 'A Lawyer',
      at: Date.parse('2026-01-15'),
    };
    const position = basePosition({ basis: [{ documentId: 'd1', supports: true, edits: [comment] }] });

    const el = mount(<TheWorkings {...baseProps({ position })} />);

    expect(el.textContent).toContain('We never accept an uncapped costs indemnity.');
    expect(el.textContent).toContain('A Lawyer');
  });

  it('names each document the workings came from', () => {
    const edit: ParsedEdit = {
      kind: 'deletion',
      text: 'absolute discretion',
      context: "Consent may be withheld at the Landlord's absolute discretion.",
    };
    const position = basePosition({ basis: [{ documentId: 'd1', supports: true, edits: [edit] }] });

    const el = mount(
      <TheWorkings {...baseProps({ position, documentNames: { d1: 'Brookvale markup.docx' } })} />,
    );

    expect(el.textContent).toContain('Brookvale markup.docx');
  });

  it('falls back to the raw document id when no display name was supplied', () => {
    const edit: ParsedEdit = { kind: 'deletion', text: 'absolute discretion', context: 'x absolute discretion y' };
    const position = basePosition({ basis: [{ documentId: 'doc-raw-id', supports: true, edits: [edit] }] });

    const el = mount(<TheWorkings {...baseProps({ position })} />);

    expect(el.textContent).toContain('doc-raw-id');
  });

  it('labels diff-derived workings as weaker evidence', () => {
    const edit: ParsedEdit = { kind: 'deletion', text: 'absolute discretion', context: 'x absolute discretion y' };
    const diffOnlyPos = basePosition({
      diffDerivedOnly: true,
      basis: [{ documentId: 'd1', supports: true, edits: [edit] }],
    });

    const el = mount(<TheWorkings {...baseProps({ position: diffOnlyPos })} />);

    expect(el.textContent).toMatch(/compared|inferred from|not from tracked changes/i);
  });

  it('does not label tracked-change-only workings as weaker evidence', () => {
    const edit: ParsedEdit = { kind: 'deletion', text: 'absolute discretion', context: 'x absolute discretion y' };
    const trackedPos = basePosition({
      diffDerivedOnly: false,
      basis: [{ documentId: 'd1', supports: true, edits: [edit] }],
    });

    const el = mount(<TheWorkings {...baseProps({ position: trackedPos })} />);

    expect(el.textContent).not.toMatch(/not from tracked changes/i);
  });

  it('does not silently drop an edit whose text cannot be located verbatim in its context', () => {
    const edit: ParsedEdit = {
      kind: 'deletion',
      text: 'zzz this exact text is not in the context',
      context: 'Completely unrelated paragraph text that does not contain the edit.',
    };
    const position = basePosition({ basis: [{ documentId: 'd1', supports: true, edits: [edit] }] });

    const el = mount(<TheWorkings {...baseProps({ position })} />);

    expect(el.textContent).toContain('zzz this exact text is not in the context');
  });

  it('renders a moved edit as neither a deletion nor an insertion', () => {
    const edit: ParsedEdit = { kind: 'moved', text: 'the indemnity clause', context: 'x the indemnity clause y' };
    const position = basePosition({ basis: [{ documentId: 'd1', supports: true, edits: [edit] }] });

    const el = mount(<TheWorkings {...baseProps({ position })} />);

    expect(el.querySelector('del')).toBeNull();
    expect(el.querySelector('ins')).toBeNull();
    expect(el.textContent).toContain('the indemnity clause');
    expect(el.textContent).toMatch(/moved/i);
  });

  it('says plainly when no redline text is attached, rather than rendering blank', () => {
    const position = basePosition({ basis: [] });

    const el = mount(<TheWorkings {...baseProps({ position })} />);

    expect(el.textContent).toMatch(/no redline text/i);
  });

  it('shows a contradiction callout without resolving it', () => {
    const edit: ParsedEdit = { kind: 'deletion', text: 'absolute discretion', context: 'x absolute discretion y' };
    const position = basePosition({
      contradicted: true,
      basis: [
        { documentId: 'd1', supports: true, edits: [edit] },
        { documentId: 'd2', supports: false, edits: [edit] },
      ],
    });

    const el = mount(<TheWorkings {...baseProps({ position })} />);

    expect(el.textContent).toMatch(/redlines disagree/i);
    expect(buttonNamed(el, /^adopt$/i)).toBeTruthy();
    expect(buttonNamed(el, /not a house rule/i)).toBeTruthy();
  });

  it('adopts and rejects exactly the position it was given', () => {
    const onAdopt = vi.fn();
    const onReject = vi.fn();
    const position = basePosition();

    const el = mount(<TheWorkings {...baseProps({ position, onAdopt, onReject })} />);
    click(buttonNamed(el, /^adopt$/i));
    click(buttonNamed(el, /not a house rule/i));

    expect(onAdopt).toHaveBeenCalledWith(position);
    expect(onReject).toHaveBeenCalledWith(position);
  });

  it('closes back to what we learned', () => {
    const onClose = vi.fn();
    const el = mount(<TheWorkings {...baseProps({ onClose })} />);

    click(buttonNamed(el, /back to what we learned/i));

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('keeps the handoff rationale sentence in the rendered UI', () => {
    const el = mount(<TheWorkings {...baseProps()} />);
    expect(el.textContent).toMatch(/will not adopt a position they cannot see the workings for/i);
  });
});

/**
 * The STORED basis (server spec §6.5) — the same panel, opened months after
 * the session that produced it.
 *
 * Four states, and the two that make this different from a list are the ones
 * a naive implementation renders identically: a basis whose precedent set has
 * been DISPOSED OF, and one whose position has been REWORDED since the
 * evidence was gathered. Both look like "here are some documents" unless the
 * panel says which it is.
 */
describe('TheWorkings — the stored basis', () => {
  const entry = (documentId: string, documentName: string) => ({
    precedentSetId: 's1',
    documentId,
    documentName,
    edits: [{
      documentId, kind: 'deletion' as const, source: 'tracked' as const,
      text: 'in its absolute discretion',
      context: 'The landlord may withhold consent in its absolute discretion.',
    }],
    diffDerivedOnly: false,
  });

  const loaded = (over: Partial<import('../../lib/db/positionBasis').PositionBasis> = {}) => ({
    state: 'loaded' as const,
    basis: {
      playbookId: 'pb', clauseId: 'c1', recorded: true, resolvable: true,
      adoptedText: 'No unreasonable withholding.',
      currentText: 'No unreasonable withholding.',
      adoptedTextMatchesCurrent: true,
      diffDerivedOnly: false,
      entries: [entry('p1', 'Brookvale.docx'), entry('p2', 'Ashfield.docx')],
      ...over,
    },
  });

  it('renders the stored documents and their edits when it resolves', () => {
    const c = mount(<TheWorkings {...baseProps({ stored: loaded() })} />);
    expect(c.textContent).toContain('Brookvale.docx');
    expect(c.textContent).toContain('Ashfield.docx');
    expect(c.querySelector('del')?.textContent).toBe('in its absolute discretion');
  });

  it('says the WORDING HAS MOVED, naming both, rather than showing the evidence silently', () => {
    // Four leases support the sentence that was ADOPTED. Rendering them
    // beside a sentence they never supported is the confidently-wrong claim
    // `positionHealth`'s wording scope exists to prevent, one layer down.
    const c = mount(<TheWorkings {...baseProps({
      stored: loaded({
        adoptedTextMatchesCurrent: false,
        adoptedText: 'No unreasonable withholding.',
        currentText: 'Consent not to be unreasonably withheld or delayed.',
      }),
    })} />);
    expect(c.textContent).toMatch(/wording has moved/i);
    expect(c.textContent).toContain('No unreasonable withholding.');
    expect(c.textContent).toContain('Consent not to be unreasonably withheld or delayed.');
    // The evidence is still SHOWN — it is still the honest answer to where
    // the rule came from, now labelled rather than withheld.
    expect(c.textContent).toContain('Brookvale.docx');
  });

  it('says nothing about the wording when it has not moved', () => {
    const c = mount(<TheWorkings {...baseProps({ stored: loaded() })} />);
    expect(c.textContent).not.toMatch(/wording has moved/i);
  });

  it('says nothing about the wording when the current text could not be read', () => {
    // ABSENT, not `false`: "the wording has moved" and "I could not tell" are
    // different facts, and only the first is a claim worth making.
    const c = mount(<TheWorkings {...baseProps({
      stored: { state: 'loaded', basis: {
        playbookId: 'pb', clauseId: 'c1', recorded: true, resolvable: true,
        adoptedText: 'No unreasonable withholding.', diffDerivedOnly: false,
        entries: [entry('p1', 'Brookvale.docx')],
      } },
    })} />);
    expect(c.textContent).not.toMatch(/wording has moved/i);
    expect(c.textContent).toContain('Brookvale.docx');
  });

  it('says the documents are no longer held, rather than rendering an empty panel', () => {
    // §11.1: "delete the set and a position's basis becomes unresolvable (and
    // must then say so on screen rather than showing an empty evidence panel
    // — 'empty is not broken', again)."
    const c = mount(<TheWorkings {...baseProps({
      stored: loaded({ resolvable: false, entries: [] }),
    })} />);
    expect(c.textContent).toMatch(/no longer held/i);
    expect(c.textContent).toMatch(/precedent set .* has been deleted/i);
    // And NOT the sentence for a position that never had evidence, which
    // would answer a partner's question with the wrong fact.
    expect(c.textContent).not.toMatch(/No redline text is attached/i);
    expect(c.textContent).not.toMatch(/written by hand/i);
  });

  it('distinguishes a position that never had a basis from one whose set is gone', () => {
    const c = mount(<TheWorkings {...baseProps({
      stored: { state: 'loaded', basis: {
        playbookId: 'pb', clauseId: 'c1', recorded: false, resolvable: true, entries: [],
      } },
    })} />);
    expect(c.textContent).toMatch(/written by hand/i);
    expect(c.textContent).not.toMatch(/no longer held/i);
  });

  it('shows the third load state while it is reading, not an empty panel', () => {
    const c = mount(<TheWorkings {...baseProps({ stored: { state: 'loading' } })} />);
    expect(c.textContent).toMatch(/looking up the redlines/i);
    expect(c.textContent).not.toMatch(/No redline text is attached/i);
  });

  it('renders a failed read as a failure, with a retry, never as no evidence', () => {
    const onRetry = vi.fn();
    const c = mount(<TheWorkings {...baseProps({
      stored: { state: 'error', message: 'The server is unreachable.', onRetry },
    })} />);
    expect(c.textContent).toMatch(/could not be read/i);
    expect(c.textContent).toContain('The server is unreachable.');
    expect(c.textContent).not.toMatch(/written by hand/i);
    click(buttonNamed(c, /try again/i));
    expect(onRetry).toHaveBeenCalled();
  });

  it('keeps diff-derived evidence weaker in a panel opened six months later', () => {
    // `source: 'diff'` never wears `source: 'tracked'`'s confidence, and
    // "everywhere it appears" now includes here. The LIVE position says
    // false; the stored basis says true, and the stored one wins because it
    // is what this panel is showing.
    const c = mount(<TheWorkings {...baseProps({
      position: basePosition({ diffDerivedOnly: false }),
      stored: loaded({ diffDerivedOnly: true }),
    })} />);
    expect(c.textContent).toMatch(/Not from tracked changes/i);
  });
});
