import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach } from 'vitest';

// The precedent this follows is Toast.test.tsx: there is no
// @testing-library/react in this project, so component tests drive a real
// react-dom root directly. This module is that pattern extracted, after
// five separate test files had each written their own copy of it.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: { container: HTMLDivElement; root: Root }[] = [];

/** Mounts a tree and returns its container. Unmounted automatically after
 *  the test — a leaked root keeps rendering into a detached DOM and turns
 *  a later test's failure into a mystery. */
export function mount(node: React.ReactElement): HTMLDivElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => { root.render(node); });
  mounted.push({ container, root });
  return container;
}

/** Same, but hands back an explicit unmount for a test that needs to prove
 *  something about teardown (e.g. that a global listener was removed). */
export function mountOnce(node: React.ReactElement): { container: HTMLDivElement; unmount: () => void } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => { root.render(node); });
  return {
    container,
    unmount: () => { act(() => { root.unmount(); }); container.remove(); },
  };
}

afterEach(() => {
  while (mounted.length > 0) {
    const { container, root } = mounted.pop()!;
    act(() => { root.unmount(); });
    container.remove();
  }
});

/**
 * Flushes microtasks until `settled()` holds, then returns — and throws a
 * named failure if it never does.
 *
 * The alternative, a fixed `await flush(8)`, counts async ticks, and that
 * count is a property of the code under test rather than of the test. Sub-
 * project F's `DB_VERSION` 3 -> 4 bump added exactly one tick to App's
 * review-open path (the first `getDb()` in a suite now runs an upgrade
 * transaction before any read completes) and pushed two collection tests one
 * tick past their budget. They failed as "no Retry button" and as an empty
 * findings pane: symptoms that read as defects in the feature, when the
 * screen was in fact still showing "Loading review...". Waiting on the
 * condition keeps that failure honest — a load that genuinely never settles
 * fails here, saying which condition it was waiting for, instead of
 * downstream on an assertion about content that was never going to arrive.
 *
 * `min` flushes always run first, so this is a strict superset of the fixed
 * flush it replaces; `max` bounds the wait so a hung load fails loudly
 * rather than spinning the suite.
 */
export async function flushUntil(
  settled: () => boolean,
  what: string,
  { min = 8, max = 200 }: { min?: number; max?: number } = {},
): Promise<void> {
  for (let i = 1; i <= max; i++) {
    // eslint-disable-next-line no-await-in-loop
    await act(async () => { await Promise.resolve(); });
    if (i >= min && settled()) return;
  }
  throw new Error(`flushUntil gave up after ${max} flushes waiting for ${what}.`);
}

export function buttons(container: ParentNode): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll('button'));
}

/** The button whose visible text matches. Also checks `aria-label`, so an
 *  icon-only button is findable by the name a screen reader would announce
 *  — which is the name it should be findable by. */
export function buttonNamed(container: ParentNode, name: RegExp): HTMLButtonElement | undefined {
  return buttons(container).find(b =>
    name.test(b.textContent || '') || name.test(b.getAttribute('aria-label') || ''));
}

export function textbox(container: ParentNode): HTMLTextAreaElement | HTMLInputElement | null {
  return container.querySelector('textarea, input[type="text"]');
}

export function click(element: Element | null | undefined): void {
  if (!element) throw new Error('click() was given nothing to click — the query above it found no element.');
  act(() => { (element as HTMLElement).click(); });
}

/**
 * Types into a controlled React input.
 *
 * Setting `.value` directly does not work: React installs its own value
 * setter on the element instance and reads from its internal tracker, so a
 * plain assignment updates the DOM but leaves React believing nothing
 * changed, and the `input` event is then treated as a no-op. Going through
 * the prototype's setter is what makes React see the change — this is the
 * standard workaround and the reason this helper exists rather than each
 * test doing it by hand.
 */
export function type(element: HTMLTextAreaElement | HTMLInputElement | null, value: string): void {
  if (!element) throw new Error('type() was given nothing to type into.');
  const proto = element instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype
    : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (!setter) throw new Error('No value setter on the element prototype.');
  act(() => {
    setter.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

/** A keydown on `window`, for hooks that bind global shortcuts. */
export function keyDown(init: KeyboardEventInit): void {
  act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, ...init })); });
}

/** A keydown on a specific element, for proving a shortcut is ignored while
 *  the user is typing. */
export function keyDownOn(element: Element, init: KeyboardEventInit): void {
  act(() => { element.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, ...init })); });
}
