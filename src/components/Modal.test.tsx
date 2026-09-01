import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { mount, mountOnce, click, keyDown } from '../test/mount';
import { Modal } from './Modal';

/**
 * WHAT `aria-modal="true"` PROMISES, AND WHETHER THIS COMPONENT KEEPS IT.
 *
 * The panel has carried `role="dialog" aria-modal="true"` since it was
 * written and implemented none of it: no Escape, no focus moved in, no focus
 * trapped, no focus restored. That attribute tells a screen reader that
 * everything outside the element is inert, so a screen-reader user tabbed
 * straight out of the dialog into content their software had just been told
 * to ignore. An attribute claiming a behaviour the implementation does not
 * have is this codebase's most-repeated defect; this is its accessibility
 * instance.
 *
 * Found by driving the app: Escape on the disposition-history dialog did
 * nothing. Every dialog in the app is this component, so the gap was uniform.
 */

function Dialog({ onClose = () => {} }: { onClose?: () => void }) {
  return (
    <Modal isOpen title="Reject this finding" onClose={onClose}
      footer={<button type="button">Confirm rejection</button>}>
      <input aria-label="reason" />
    </Modal>
  );
}

describe('Modal keeps the contract aria-modal asserts', () => {
  it('closes on Escape', () => {
    const onClose = vi.fn();
    mount(<Dialog onClose={onClose} />);
    keyDown({ key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does not close on any other key', () => {
    // The sanity half. A handler that called `onClose` on every keydown
    // would pass the test above and make every dialog unusable.
    const onClose = vi.fn();
    mount(<Dialog onClose={onClose} />);
    keyDown({ key: 'a' });
    keyDown({ key: 'Enter' });
    keyDown({ key: 'Tab' });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('moves focus into the dialog when it opens', () => {
    const container = mount(<Dialog />);
    const inside = container.querySelector('[role="dialog"]')!;
    expect(inside.contains(document.activeElement)).toBe(true);
  });

  it('cycles focus at the ends rather than letting Tab leave the dialog', () => {
    const container = mount(<Dialog />);
    const stops = Array.from(
      container.querySelectorAll<HTMLElement>('button, input, a[href]'));
    const first = stops[0];
    const last = stops[stops.length - 1];
    expect(stops.length).toBeGreaterThan(1);

    last.focus();
    keyDown({ key: 'Tab' });
    expect(document.activeElement).toBe(first);

    first.focus();
    keyDown({ key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(last);
  });

  it('gives focus back to whatever opened it', () => {
    // Without this a keyboard user who closes a dialog is returned to the top
    // of the document, having lost their place — which is why restoring
    // matters as much as trapping.
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();
    expect(document.activeElement).toBe(opener);

    const { unmount } = mountOnce(<Dialog />);
    expect(document.activeElement).not.toBe(opener);
    unmount();
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  it('binds nothing while it is closed', () => {
    // A listener that outlived the dialog would swallow Escape for the screen
    // underneath it.
    const onClose = vi.fn();
    mount(
      <Modal isOpen={false} title="Closed" onClose={onClose}>
        <input aria-label="reason" />
      </Modal>,
    );
    keyDown({ key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('unbinds when it unmounts', () => {
    const onClose = vi.fn();
    const { unmount } = mountOnce(<Dialog onClose={onClose} />);
    unmount();
    keyDown({ key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('still closes on the X, unchanged', () => {
    const onClose = vi.fn();
    const container = mount(<Dialog onClose={onClose} />);
    click(container.querySelector('[aria-label="Close"]'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
