import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { mount, buttonNamed, click } from '../../test/mount';
import { ViewSwitch } from './ViewSwitch';
import type { ReviewTarget } from '../../types';

const docs: ReviewTarget = { kind: 'documents', documentIds: ['d1', 'd2'] };

describe('ViewSwitch', () => {
  it('offers Review and Compare for a multi-document review', () => {
    const c = mount(<ViewSwitch value="review" onChange={() => {}} target={docs} documentCount={2} />);
    expect(buttonNamed(c, /^Review$/)).toBeTruthy();
    expect(buttonNamed(c, /^Compare$/)).toBeTruthy();
  });

  it('switches', () => {
    const onChange = vi.fn();
    const c = mount(<ViewSwitch value="review" onChange={onChange} target={docs} documentCount={2} />);
    click(buttonNamed(c, /^Compare$/));
    expect(onChange).toHaveBeenCalledWith('compare');
  });

  it('renders nothing for a single-document review', () => {
    // Absent, not disabled: a disabled tab advertises a view that will
    // never exist for this review (§10.5, R-GP6).
    const c = mount(<ViewSwitch value="review" onChange={() => {}} target={{ kind: 'documents', documentIds: ['d1'] }} documentCount={1} />);
    expect(c.textContent).toBe('');
  });

  it('renders nothing for a collection review', () => {
    // A collection produces ONE position per clause however many documents
    // fed it (findingsKeyFor). There is nothing to compare across.
    const c = mount(<ViewSwitch value="review" onChange={() => {}} target={{ kind: 'collection', collectionId: 'k1', documentIds: ['d1', 'd2'] }} documentCount={2} />);
    expect(c.textContent).toBe('');
  });

  it('offers no third tab', () => {
    // Report is dropped: export is a button producing a file, and a Report
    // tab would advertise a live report view the app does not have (R-G11).
    const c = mount(<ViewSwitch value="review" onChange={() => {}} target={docs} documentCount={2} />);
    expect(c.querySelectorAll('button')).toHaveLength(2);
    expect(c.textContent).not.toMatch(/report/i);
  });
});
