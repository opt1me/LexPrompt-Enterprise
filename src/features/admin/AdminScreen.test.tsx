import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { mount, buttons } from '../../test/mount';
import { AdminScreen } from './AdminScreen';
import { ADMIN_SECTIONS } from '../../lib/router';

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

  it('renders a real panel in EVERY section, and no placeholder anywhere', () => {
    /*
     * The prohibition this replaces (P46): while a section had no panel, the
     * screen said so IN WORDS rather than rendering an empty tab, because a
     * blank tab is indistinguishable from a workspace with no people, no
     * providers and no audit trail. All four sections are built now, so the
     * rule is asserted the other way round — every section renders something
     * of its own, and the placeholder wording is gone rather than left
     * standing where a fifth section could inherit it silently.
     */
    // Each panel's FIRST PAINT, which is the state a person actually sees on
    // arrival — three of the four load from the server and say so, and the
    // fourth waits to be asked for a range. Table-driven over
    // `ADMIN_SECTIONS` itself so a fifth section cannot be added without a
    // line here.
    const FIRST_PAINT: Record<(typeof ADMIN_SECTIONS)[number], RegExp> = {
      roles: /loading the role mapping/i,
      people: /loading the people in this workspace/i,
      providers: /reading this deployment/i,
      audit: /audit export/i,
    };
    for (const section of ADMIN_SECTIONS) {
      const container = mount(
        <AdminScreen section={section} role={{ status: 'known', role: 'admin' }} onSelect={noop} />);
      expect(container.textContent, section).not.toMatch(/is not built yet/i);
      expect(container.textContent, section).toMatch(FIRST_PAINT[section]);
    }
    // The sanity half: the four patterns are genuinely different from one
    // another, so a screen that rendered one panel in every tab would fail
    // rather than matching four times over.
    expect(new Set(Object.values(FIRST_PAINT).map(String)).size).toBe(ADMIN_SECTIONS.length);
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
