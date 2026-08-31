import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { mount, buttons } from '../../test/mount';
import { AdminScreen } from './AdminScreen';

const noop = (): void => { /* the section change is App's to make */ };

describe('AdminScreen', () => {
  it('renders nothing an admin could act on for a reviewer or a partner', () => {
    // The COURTESY half only; the API is the gate (§18 item 3). Asserted so
    // that a non-admin who reaches /admin by URL gets a refusal panel and
    // not a half-drawn screen that 403s on every fetch — which reads as a
    // broken application rather than as a boundary.
    for (const role of ['reviewer', 'partner'] as const) {
      const container = mount(
        <AdminScreen section="roles" role={{ status: 'known', role }} onSelect={noop} />);
      expect(container.textContent).toMatch(/for administrators/i);
      expect(container.textContent).toContain(role);
      // No tabs, no panel, no controls at all.
      expect(buttons(container)).toEqual([]);
      expect(container.textContent).not.toMatch(/who gets which role/i);
    }
  });

  it('renders the panel for an administrator, which makes the refusal above about the ROLE', () => {
    const container = mount(
      <AdminScreen section="roles" role={{ status: 'known', role: 'admin' }} onSelect={noop} />);
    expect(container.textContent).not.toMatch(/for administrators/i);
    expect(buttons(container).length).toBeGreaterThan(0);
  });

  it('treats an UNKNOWN role as neither a refusal nor an admission', () => {
    // A permission granted by a loading state is the worst of the three, and
    // a refusal produced by one sends a real administrator away.
    const container = mount(
      <AdminScreen section="roles" role={{ status: 'unknown' }} onSelect={noop} />);
    expect(container.textContent).toMatch(/checking what you can do/i);
    expect(container.textContent).not.toMatch(/for administrators/i);
    expect(container.querySelector('[data-busy="true"]')).not.toBeNull();
  });

  it('says a FAILED check is a check that did not complete, not a refusal', () => {
    const container = mount(
      <AdminScreen section="roles" role={{ status: 'failed', error: new Error('offline') }}
        onSelect={noop} />);
    expect(container.textContent).toMatch(/could not check/i);
    expect(container.textContent).toMatch(/not a refusal/i);
  });

  it('names the sections that are not built yet rather than showing them empty', () => {
    for (const section of ['providers', 'audit'] as const) {
      const container = mount(
        <AdminScreen section={section} role={{ status: 'known', role: 'admin' }} onSelect={noop} />);
      // A blank tab is indistinguishable from a firm with no providers and
      // no audit trail at all.
      expect(container.textContent).toMatch(/is not built yet/i);
      expect(container.textContent).toMatch(/this screen is/i);
    }
  });

  it('asks its caller to change section, and never navigates itself', () => {
    const onSelect = vi.fn();
    const container = mount(
      <AdminScreen section="roles" role={{ status: 'known', role: 'admin' }} onSelect={onSelect} />);
    const people = buttons(container).find(b => b.textContent === 'People')!;
    people.click();
    expect(onSelect).toHaveBeenCalledWith('people');
  });
});
