import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { mount, buttonNamed, textbox, type, click } from '../../test/mount';
import { GroupDocumentsDialog } from './GroupDocumentsDialog';
import type { DocumentRecord } from '../../types';

function doc(id: string, name: string): DocumentRecord {
  return {
    id,
    matterId: 'm1',
    name,
    kind: 'pdf',
    text: '',
    byteSize: 1,
    addedAt: 1,
    addedByUserId: 'u1',
    role: 'standalone',
  };
}

const twoDocuments = [doc('a', 'Lease.pdf'), doc('b', 'Deed of Variation.pdf')];
const threeDocuments = [doc('a', 'Lease.pdf'), doc('b', 'Deed of Variation.pdf'), doc('c', 'Side Letter.pdf')];

function confirmButton(container: HTMLElement) {
  return buttonNamed(container, /create collection/i) as HTMLButtonElement;
}

/** A local rerender helper for the one test below that needs to re-render
 *  the SAME root (close, then reopen with a different selection) — the
 *  shared harness's `mount`/`mountOnce` hand back only a container, with
 *  no way to render a second element into the same root. Unmounted
 *  explicitly at the end of that test rather than via the shared
 *  `afterEach`, since this root was never registered with it. */
function mountWithRerender(node: React.ReactElement): {
  container: HTMLDivElement;
  rerender: (n: React.ReactElement) => void;
  unmount: () => void;
} {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  act(() => { root.render(node); });
  return {
    container,
    rerender: (n) => act(() => { root.render(n); }),
    unmount: () => { act(() => { root.unmount(); }); container.remove(); },
  };
}

describe('GroupDocumentsDialog', () => {
  it('requires at least two documents before Confirm can enable — refuses to render a picker for fewer', () => {
    const container = mount(
      <GroupDocumentsDialog isOpen documents={[doc('a', 'Lease.pdf')]} onClose={() => {}} onConfirm={async () => {}} />,
    );
    // With a name already present, the ONLY thing that can still be
    // gating Confirm is the document count — isolates that check from the
    // name-required one below.
    expect(container.textContent).toMatch(/at least two/i);
    expect(confirmButton(container).disabled).toBe(true);
  });

  it('the base defaults to the first document selected', () => {
    const container = mount(
      <GroupDocumentsDialog isOpen documents={threeDocuments} onClose={() => {}} onConfirm={async () => {}} />,
    );
    const firstRadio = container.querySelector('#base-a') as HTMLInputElement;
    expect(firstRadio.checked).toBe(true);
    const otherRadios = ['#base-b', '#base-c'].map(sel => container.querySelector(sel) as HTMLInputElement);
    expect(otherRadios.every(r => !r.checked)).toBe(true);
  });

  it('exactly one base is chosen at a time — picking another clears the first', () => {
    const container = mount(
      <GroupDocumentsDialog isOpen documents={threeDocuments} onClose={() => {}} onConfirm={async () => {}} />,
    );
    click(container.querySelector('#base-c'));
    expect((container.querySelector('#base-a') as HTMLInputElement).checked).toBe(false);
    expect((container.querySelector('#base-b') as HTMLInputElement).checked).toBe(false);
    expect((container.querySelector('#base-c') as HTMLInputElement).checked).toBe(true);
  });

  it('a name is required — Confirm stays disabled on whitespace', () => {
    const container = mount(
      <GroupDocumentsDialog isOpen documents={twoDocuments} onClose={() => {}} onConfirm={async () => {}} />,
    );
    expect(confirmButton(container).disabled).toBe(true);
    type(textbox(container) as HTMLInputElement, '   ');
    expect(confirmButton(container).disabled).toBe(true);
    type(textbox(container) as HTMLInputElement, 'Lease as varied');
    expect(confirmButton(container).disabled).toBe(false);
  });

  it('amendments keep the order the user put them in, excluding whichever is chosen base', async () => {
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    const container = mount(
      <GroupDocumentsDialog isOpen documents={threeDocuments} onClose={() => {}} onConfirm={onConfirm} />,
    );
    type(textbox(container) as HTMLInputElement, 'Lease as varied');
    // Base defaults to the first ('a'/Lease.pdf) — the remaining two, 'b'
    // then 'c', must reach onConfirm in that same relative order.
    await act(async () => { confirmButton(container).click(); await Promise.resolve(); });
    expect(onConfirm).toHaveBeenCalledWith({
      name: 'Lease as varied',
      baseDocumentId: 'a',
      variesDocumentIds: ['b', 'c'],
    });
  });

  it('choosing a different base still preserves the relative order of the rest', async () => {
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    const container = mount(
      <GroupDocumentsDialog isOpen documents={threeDocuments} onClose={() => {}} onConfirm={onConfirm} />,
    );
    type(textbox(container) as HTMLInputElement, 'Lease as varied');
    click(container.querySelector('#base-b'));
    await act(async () => { confirmButton(container).click(); await Promise.resolve(); });
    expect(onConfirm).toHaveBeenCalledWith({
      name: 'Lease as varied',
      baseDocumentId: 'b',
      variesDocumentIds: ['a', 'c'],
    });
  });

  it('cancelling changes nothing — onConfirm is never called', () => {
    const onConfirm = vi.fn();
    const onClose = vi.fn();
    const container = mount(
      <GroupDocumentsDialog isOpen documents={twoDocuments} onClose={onClose} onConfirm={onConfirm} />,
    );
    type(textbox(container) as HTMLInputElement, 'Lease as varied');
    click(buttonNamed(container, /^cancel$/i));
    expect(onClose).toHaveBeenCalled();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('reopening for a different selection does not inherit the previous name or base choice', () => {
    const { container, rerender, unmount } = mountWithRerender(
      <GroupDocumentsDialog isOpen documents={threeDocuments} onClose={() => {}} onConfirm={async () => {}} />,
    );
    try {
      type(textbox(container) as HTMLInputElement, 'Stale name');
      click(container.querySelector('#base-c'));

      rerender(<GroupDocumentsDialog isOpen={false} documents={[]} onClose={() => {}} onConfirm={async () => {}} />);
      rerender(<GroupDocumentsDialog isOpen documents={twoDocuments} onClose={() => {}} onConfirm={async () => {}} />);

      expect((textbox(container) as HTMLInputElement).value).toBe('');
      expect((container.querySelector('#base-a') as HTMLInputElement).checked).toBe(true);
    } finally {
      unmount();
    }
  });
});
