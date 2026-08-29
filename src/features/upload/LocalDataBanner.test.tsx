import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { mount, buttons, click } from '../../test/mount';
import { LocalDataBanner } from './LocalDataBanner';

describe('LocalDataBanner', () => {
  it('says how much is still in this browser, and offers the way to move it', () => {
    const onOpen = vi.fn();
    const el = mount(<LocalDataBanner state={{ kind: 'present', total: 12 }} onOpen={onOpen} />);
    expect(el.textContent).toContain('12 items are still stored in this browser');
    click(buttons(el).find(b => /move it to the server/i.test(b.textContent ?? ''))!);
    expect(onOpen).toHaveBeenCalled();
  });

  it('NEVER renders as silence when the local database could not be read', () => {
    // The founding defect at its most dangerous moment: a browser holding a
    // firm's un-uploaded matters whose database will not open. Rendering
    // nothing would be the app deciding, on no evidence, that there is
    // nothing to move — which is indistinguishable from a fresh install and
    // is exactly how someone's history gets left behind.
    const el = mount(<LocalDataBanner
      state={{ kind: 'unknown', message: 'Close other LexPrompt tabs and reload.' }}
      onRetry={() => {}}
    />);
    expect(el.textContent).toContain('could not read the data stored in this browser');
    // The specific, actionable sentence survives rather than being replaced
    // by a generic apology.
    expect(el.textContent).toContain('Close other LexPrompt tabs and reload.');
    expect(buttons(el).some(b => /try again/i.test(b.textContent ?? ''))).toBe(true);
  });

  it('says what it COULD read and what it could not, when only part failed', () => {
    const el = mount(<LocalDataBanner
      state={{ kind: 'partial', total: 3, message: 'reviews' }}
      onOpen={() => {}}
      onRetry={() => {}}
    />);
    expect(el.textContent).toContain('3 items are still stored in this browser');
    expect(el.textContent).toContain('could not be read at all');
  });

  it('keeps saying the copy is here after everything moved', () => {
    // A banner that vanishes is a person who never learns the copy is still
    // in their browser.
    const el = mount(<LocalDataBanner state={{ kind: 'moved' }} />);
    expect(el.textContent).toContain('A copy is still in this browser');
    expect(buttons(el)).toHaveLength(0);
  });
});
