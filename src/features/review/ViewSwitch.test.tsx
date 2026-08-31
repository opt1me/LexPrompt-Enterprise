import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { mount, buttonNamed, click } from '../../test/mount';
import { ViewSwitch } from './ViewSwitch';
import type { ReviewTarget } from '../../types';

const docs: ReviewTarget = { kind: 'documents', documentIds: ['d1', 'd2'] };
const one: ReviewTarget = { kind: 'documents', documentIds: ['d1'] };
const collection: ReviewTarget = {
  kind: 'collection', collectionId: 'k1', documentIds: ['d1', 'd2'],
};

describe('ViewSwitch', () => {
  it('offers Review, Compare and Report for a multi-document review', () => {
    const c = mount(<ViewSwitch value="review" onChange={() => {}} target={docs} documentCount={2} />);
    expect(buttonNamed(c, /^Review$/)).toBeTruthy();
    expect(buttonNamed(c, /^Compare$/)).toBeTruthy();
    expect(buttonNamed(c, /^Report$/)).toBeTruthy();
  });

  it('switches', () => {
    const onChange = vi.fn();
    const c = mount(<ViewSwitch value="review" onChange={onChange} target={docs} documentCount={2} />);
    click(buttonNamed(c, /^Compare$/));
    expect(onChange).toHaveBeenCalledWith('compare');
    click(buttonNamed(c, /^Report$/));
    expect(onChange).toHaveBeenCalledWith('report');
  });

  it('drops COMPARE for a single-document review, and keeps the rest', () => {
    // Absent, not disabled: a disabled tab advertises a view that will never
    // exist for this review (§10.5, R-GP6).
    //
    // What CHANGED in Stage 5: this used to render nothing at all, which
    // would have hidden the Report tab from most reviews in the app. Hiding
    // a view that DOES exist is the same defect in the opposite direction.
    const c = mount(<ViewSwitch value="review" onChange={() => {}} target={one} documentCount={1} />);
    expect(buttonNamed(c, /^Compare$/)).toBeUndefined();
    expect(buttonNamed(c, /^Review$/)).toBeTruthy();
    expect(buttonNamed(c, /^Report$/)).toBeTruthy();
  });

  it('drops COMPARE for a collection review, and keeps the rest', () => {
    // A collection produces ONE position per clause however many documents
    // fed it (findingsKeyFor). There is nothing to compare across — but
    // there is still a report to read.
    const c = mount(
      <ViewSwitch value="review" onChange={() => {}} target={collection} documentCount={2} />);
    expect(buttonNamed(c, /^Compare$/)).toBeUndefined();
    expect(c.querySelectorAll('button')).toHaveLength(2);
  });

  it('offers no FOURTH tab', () => {
    // Three renderers over one findings map, and that is the whole of it.
    // Export is still a button that produces a file; the Report tab is a
    // view of what that file will say, not a second way to make one.
    const c = mount(<ViewSwitch value="review" onChange={() => {}} target={docs} documentCount={2} />);
    expect(c.querySelectorAll('button')).toHaveLength(3);
    expect(c.textContent).not.toMatch(/export|download/i);
  });
});
