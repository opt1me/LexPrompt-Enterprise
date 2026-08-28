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
