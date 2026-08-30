import { useEffect } from 'react';
import type { VerificationChange } from '@lexprompt/core';

export interface UseVerifyKeysOptions {
  enabled: boolean;
  count: number;
  index: number;
  onIndexChange: (index: number) => void;
  /** `{ state: 'rejected' }` carries no reason on purpose — the caller opens
   *  the reason dialog. A keyboard shortcut must not be able to reject
   *  something silently. */
  onVerify: (index: number, change: VerificationChange) => void;
}

/** True when focus is somewhere the user is composing text. Without this, a
 *  reviewer typing "flag the cap" into a note would verify, flag and reject
 *  four findings on the way. */
function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.tagName !== 'string') return false;
  const tag = el.tagName.toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable === true;
}

/**
 * The verify loop's keyboard bindings: j/ArrowDown and k/ArrowUp to move,
 * v to verify, f to flag, r to open the rejection dialog.
 *
 * Deliberately six bindings and no more. Verification is a repetitive pass
 * — thirty findings, one decision each — and a loop that requires aiming a
 * mouse at a small button thirty times is a loop nobody completes. That is
 * the entire justification; it is not the beginning of a command palette,
 * and anything beyond next/previous plus the three state actions belongs in
 * a later sub-project with its own argument for existing.
 *
 * Movement stops at the ends rather than wrapping: a reviewer working down a
 * list needs to know when they have reached the bottom, and silently jumping
 * back to the top hides that.
 */
export function useVerifyKeys({ enabled, count, index, onIndexChange, onVerify }: UseVerifyKeysOptions): void {
  useEffect(() => {
    if (!enabled) return;

    function handle(event: KeyboardEvent): void {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (isTyping(event.target)) return;

      switch (event.key) {
        case 'j':
        case 'ArrowDown':
          if (index + 1 < count) { event.preventDefault(); onIndexChange(index + 1); }
          return;
        case 'k':
        case 'ArrowUp':
          if (index > 0) { event.preventDefault(); onIndexChange(index - 1); }
          return;
        case 'v':
          event.preventDefault();
          onVerify(index, { state: 'verified' });
          return;
        case 'f':
          event.preventDefault();
          onVerify(index, { state: 'flagged' });
          return;
        case 'r':
          event.preventDefault();
          onVerify(index, { state: 'rejected' });
          return;
        default:
      }
    }

    window.addEventListener('keydown', handle);
    return () => window.removeEventListener('keydown', handle);
  }, [enabled, count, index, onIndexChange, onVerify]);
}
