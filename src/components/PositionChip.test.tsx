import React from 'react';
import { describe, it, expect } from 'vitest';
import { mount } from '../test/mount';
import { PositionChip } from './PositionChip';

// No text()/html() helper exists anywhere in this project; these are local
// wrappers around the shared `mount`, same pattern other test files use for
// their own small helpers (e.g. StateChip.test.tsx's `status()`).
function text(node: React.ReactElement): string {
  return mount(node).textContent || '';
}

function html(node: React.ReactElement): string {
  return mount(node).innerHTML;
}

describe('PositionChip', () => {
  it('renders one label per outcome and never conflates two', () => {
    expect(text(<PositionChip outcome="meets" />)).toMatch(/meets/i);
    expect(text(<PositionChip outcome="deviates" />)).toMatch(/deviates/i);
    expect(text(<PositionChip outcome="unclear" />)).toMatch(/unclear/i);
  });

  it('renders nothing when there is no outcome', () => {
    // Absent means "no position to compare against". A chip here would put a
    // question on the card that was never asked.
    expect(html(<PositionChip outcome={undefined} />)).toBe('');
  });
});
