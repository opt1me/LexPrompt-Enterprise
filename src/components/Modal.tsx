import React, { useEffect, useRef } from 'react';
import { X } from 'lucide-react';

export interface ModalProps {
  isOpen: boolean;
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
  /** Panel width. `md` (default) matches the original dialogs; `lg` is for wider content like the DIY prompt view. */
  size?: 'md' | 'lg';
}

const SIZE_CLASSES: Record<'md' | 'lg', string> = {
  md: 'max-w-md',
  lg: 'max-w-4xl',
};

/** Everything inside a dialog that a keyboard can land on. `:not([disabled])`
 *  because a disabled control is not a tab stop, and a trap that counted one
 *  would send focus to something that cannot take it. */
const FOCUSABLE = [
  'a[href]', 'button:not([disabled])', 'textarea:not([disabled])',
  'input:not([disabled])', 'select:not([disabled])', '[tabindex]:not([tabindex="-1"])',
].join(',');

/**
 * Shared overlay chrome: fixed inset, dimmed scrim, centred panel with a
 * titled header and close X.
 *
 * ## `aria-modal` is a promise, and this component has to keep it
 *
 * The markup below has said `role="dialog" aria-modal="true"` since it was
 * written, and implemented none of what that asserts: no Escape, no focus
 * moved in, no focus trapped, no focus restored. `aria-modal="true"` tells a
 * screen reader that everything outside this element is inert — so a
 * screen-reader user tabbed straight out of the dialog into content their
 * software had just been told to ignore, with no way back and nothing
 * announced. An attribute claiming a behaviour the implementation does not
 * have is this codebase's most-repeated defect, and this is the accessibility
 * instance of it.
 *
 * Found by driving the app: pressing Escape on the disposition-history dialog
 * did nothing. Every dialog in the app is this component — Run review, the
 * reject-reason modal, the matter picker, publish, delete confirmations — so
 * the gap was uniform and none of them had it.
 *
 * ## What Escape does, exactly
 *
 * `onClose`, and nothing else — the same call the X makes. It is deliberately
 * not smarter than that: a dialog that decided for itself when a dismissal
 * was safe would be a second policy beside each caller's own, and the
 * unsaved-work question this app does take seriously (`useUnsavedDraftGuard`)
 * is about NAVIGATION away from a draft, not about closing a dialog.
 *
 * ## Focus
 *
 * Moved to the first focusable control on open, restored to whatever had it
 * when the dialog closes, and cycled within the panel on Tab. Restoring
 * matters as much as trapping: without it a keyboard user who closes a
 * dialog is returned to the top of the document, having lost their place.
 */
export function Modal({ isOpen, title, onClose, children, footer, size = 'md' }: ModalProps) {
  const panel = useRef<HTMLDivElement>(null);
  // `onClose` in a ref so the effect below binds ONCE per open rather than on
  // every render: callers routinely pass an inline arrow, and re-binding a
  // keydown listener on each render would also re-run the focus move, pulling
  // focus back to the first control while somebody is typing in the third.
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    if (!isOpen) return undefined;
    // Captured BEFORE focus moves, so the restore below returns focus to
    // whatever opened the dialog rather than to something inside it.
    const opener = document.activeElement as HTMLElement | null;
    const focusable = (): HTMLElement[] =>
      Array.from(panel.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []);
    focusable()[0]?.focus();

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        close.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const stops = focusable();
      if (stops.length === 0) return;
      const first = stops[0];
      const last = stops[stops.length - 1];
      // Only the two ends are handled. Everything between them is the
      // browser's own tab order, which is the correct one.
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    // On `window`, matching `useVerifyKeys` and every other global key
    // handler in this app. A `document` listener misses an event dispatched
    // ON window, which is how the shared test harness raises one — and a
    // handler that only works when the event happens to originate below
    // `document` is a handler nobody can test.
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      // Guarded on the element still being in the document: a dialog opened
      // from a control that the close itself removes (a row's own button, on
      // a list that re-renders) would otherwise throw here.
      if (opener && document.contains(opener)) opener.focus();
    };
  }, [isOpen]);

  if (!isOpen) return null;
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-canvas/70 p-0 sm:p-4">
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        // Semantic hook for the responsive structural test (Task 22) — jsdom
        // evaluates no media query, so "this becomes a full-height sheet
        // below sm" is asserted via this attribute rather than the classes
        // below, which only a real browser lays out.
        data-sheet-below="sm"
        className={`bg-card border border-rule w-full h-full max-h-full rounded-none sm:h-auto sm:max-h-[85vh] sm:rounded-control ${SIZE_CLASSES[size]} flex flex-col overflow-hidden`}
      >
        <div className="p-4 border-b border-rule flex justify-between items-center bg-paper shrink-0">
          <h3 className="font-prose text-section text-ink-1">{title}</h3>
          <button onClick={onClose} className="text-ink-4 hover:text-ink-1" aria-label="Close">
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="p-6 space-y-5 bg-card overflow-y-auto flex-1 sm:max-h-[60vh]">
          {children}
        </div>
        {footer && (
          <div className="p-4 border-t border-rule flex justify-end gap-3 bg-paper shrink-0">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}
