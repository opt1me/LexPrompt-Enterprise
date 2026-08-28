import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AlertCircle, Check } from 'lucide-react';

export type ToastVariant = 'success' | 'error';

export interface ToastState {
  message: string;
  variant: ToastVariant;
}

/**
 * A single toast that auto-dismisses after 3 seconds. `notify` replaces
 * whatever toast is currently showing (matching the old app's single-slot
 * behaviour) and resets the dismiss timer.
 *
 * The dismiss timer is tracked in a ref so a second `notify` call within the
 * 3-second window cancels the first toast's pending timeout before starting
 * its own — otherwise the earlier timer fires on schedule and clears
 * whatever toast is showing *then*, not the one it was set for.
 */
export function useToast() {
  const [toast, setToast] = useState<ToastState | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const notify = useCallback((message: string, variant: ToastVariant = 'success') => {
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    setToast({ message, variant });
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      setToast(null);
    }, 3000);
  }, []);

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    };
  }, []);

  return { notify, toast };
}

export function Toast({ toast }: { toast: ToastState | null }) {
  if (!toast) return null;
  const isError = toast.variant === 'error';
  return (
    <div
      data-toast
      // `aria-live`, never role="status": that selector is how ~21 positional
      // assertions find a StateChip, and this element renders FIRST in the app
      // frame (R-GP2/F1). `assertive` for an error the user must not miss,
      // `polite` for a success they can read when they get to it.
      aria-live={isError ? 'assertive' : 'polite'}
      className={`fixed bottom-8 right-8 px-6 py-3 rounded-card z-[100] flex items-center gap-3 border-l-2 border border-rule bg-card font-ui text-ui transition-colors duration-150 ${
        isError ? 'border-l-risk-high text-risk-high' : 'border-l-accent text-ink-1'
      }`}
    >
      {isError ? <AlertCircle className="h-5 w-5" aria-hidden="true" /> : <Check className="h-5 w-5" aria-hidden="true" />}
      <span>{toast.message}</span>
    </div>
  );
}
