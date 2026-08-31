import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { mount, buttonNamed, click, type } from '../../test/mount';
import { StandardPositionField } from './StandardPositionField';
import type { StandardPosition } from '../../types';

const area = (c: HTMLElement) => c.querySelector('textarea') as HTMLTextAreaElement;

describe('StandardPositionField — provenance (spec §8)', () => {
  it('says the field is optional and what it enables when empty', () => {
    const c = mount(<StandardPositionField position={undefined} onChange={() => {}} />);
    expect(c.textContent).toMatch(/optional/i);
    expect(c.textContent).toMatch(/deviation/i);
  });

  it('marks an AI-drafted position no human has read as a suggestion', () => {
    const c = mount(
      <StandardPositionField
        position={{ text: 'x', origin: 'ai-drafted', reviewedByHuman: false }}
        onChange={() => {}}
      />,
    );
    expect(c.textContent).toMatch(/drafted by AI/i);
    expect(c.textContent).not.toMatch(/reviewed by you/i);
  });

  /*
   * "a person", NOT "you" — cross-stage seam review, m6, and the two cases
   * below changed direction with it.
   *
   * They pinned "reviewed by you" / "written by you", which was true while a
   * playbook belonged to one browser. Under Stage 4 a playbook is shared, so
   * the second person to open a clause read "Written by you" over a
   * colleague's words. Unlike `NetPositionPanel` and `VersionHistory`, this
   * cannot be fixed by resolving an id: `StandardPosition` carries no author
   * at all, so the honest line says what the record knows and no more.
   */
  it('says an AI-drafted position a human accepted was reviewed by a person', () => {
    const c = mount(
      <StandardPositionField
        position={{ text: 'x', origin: 'ai-drafted', reviewedByHuman: true }}
        onChange={() => {}}
      />,
    );
    expect(c.textContent).toMatch(/drafted by AI, reviewed by a person/i);
    expect(c.textContent).not.toMatch(/by you/i);
  });

  it('says an authored position was written by a person, never by the reader', () => {
    const c = mount(
      <StandardPositionField
        position={{ text: 'x', origin: 'authored', reviewedByHuman: true }}
        onChange={() => {}}
      />,
    );
    expect(c.textContent).toMatch(/written by a person/i);
    expect(c.textContent).not.toMatch(/by you/i);
  });

  it('names where a learned position came from', () => {
    const c = mount(
      <StandardPositionField
        position={{
          text: 'x',
          origin: 'learned',
          reviewedByHuman: false,
          provenance: '6 redlines across 4 documents',
        }}
        onChange={() => {}}
      />,
    );
    expect(c.textContent).toMatch(/learned from redlines/i);
    expect(c.textContent).toContain('6 redlines across 4 documents');
  });
});

describe('StandardPositionField — placeholder shape agrees with the card\'s label', () => {
  // `PositionComparison` (the finding card) prepends its own "We ask for "
  // label to whatever text is typed here. A placeholder that itself started
  // with "We ask for" — modelling a complete sentence — taught an author to
  // type the label's own words into the field, and the card then stuttered:
  // "We ask for We ask for a 6-month break notice, no conditions." The
  // placeholder's example must be a noun phrase the label can be prepended
  // to, never a sentence that already carries the label.
  it('suggests a noun phrase, not a sentence starting with the card\'s own "We ask for" label', () => {
    const c = mount(<StandardPositionField position={undefined} onChange={() => {}} />);
    const placeholder = area(c).placeholder;
    expect(placeholder.toLowerCase()).not.toMatch(/we ask for/);
  });
});

describe('StandardPositionField — editing', () => {
  it('creates an authored position when text is typed into an empty field', () => {
    const onChange = vi.fn();
    const c = mount(<StandardPositionField position={undefined} onChange={onChange} />);
    type(area(c), 'We ask for a 6-month break notice.');
    expect(onChange).toHaveBeenCalledWith({
      text: 'We ask for a 6-month break notice.',
      origin: 'authored',
      reviewedByHuman: true,
    });
    // `toEqual` treats an absent key and an `undefined` one as equal, and
    // `structuredClone` — how IndexedDB writes every record — PRESERVES an
    // `undefined`-valued key. Absence is the thing being asserted.
    expect('provenance' in (onChange.mock.calls[0]![0] as object)).toBe(false);
  });

  // Clearing the text REMOVES the position: a stored position reading
  // "we ask for: (nothing)" is worse than none, and `migratePosition`
  // drops empty ones on read anyway.
  it('removes the position entirely when its text is cleared', () => {
    const onChange = vi.fn();
    const c = mount(
      <StandardPositionField
        position={{ text: 'something', origin: 'authored', reviewedByHuman: true }}
        onChange={onChange}
      />,
    );
    type(area(c), '   ');
    expect(onChange).toHaveBeenCalledWith(undefined);
  });

  // Origin says where the words CAME FROM and must survive an edit;
  // `reviewedByHuman` says a person has read them, which typing proves.
  it('keeps the origin but marks an AI-drafted position read once a person edits it', () => {
    const onChange = vi.fn();
    const position: StandardPosition = {
      text: 'AI words',
      origin: 'ai-drafted',
      reviewedByHuman: false,
      provenance: 'Commercial Lease — Tenant v4',
    };
    const c = mount(<StandardPositionField position={position} onChange={onChange} />);
    type(area(c), 'AI words, edited');
    expect(onChange).toHaveBeenCalledWith({
      text: 'AI words, edited',
      origin: 'ai-drafted',
      reviewedByHuman: true,
      provenance: 'Commercial Lease — Tenant v4',
    });
  });

  it('offers an explicit accept for an unreviewed suggestion, so accepting it needs no edit', () => {
    const onChange = vi.fn();
    const c = mount(
      <StandardPositionField
        position={{ text: 'AI words', origin: 'ai-drafted', reviewedByHuman: false }}
        onChange={onChange}
      />,
    );
    click(buttonNamed(c, /accept|mark as reviewed/i));
    expect(onChange).toHaveBeenCalledWith({
      text: 'AI words',
      origin: 'ai-drafted',
      reviewedByHuman: true,
    });
  });

  it('offers no accept control once the position has been reviewed', () => {
    const c = mount(
      <StandardPositionField
        position={{ text: 'AI words', origin: 'ai-drafted', reviewedByHuman: true }}
        onChange={() => {}}
      />,
    );
    expect(buttonNamed(c, /accept|mark as reviewed/i)).toBeUndefined();
  });

  it('disables the field when told to', () => {
    const c = mount(<StandardPositionField position={undefined} onChange={() => {}} disabled />);
    expect(area(c).disabled).toBe(true);
  });
});
