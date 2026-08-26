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
      className={`fixed bottom-8 right-8 px-6 py-3 rounded-lg shadow-2xl z-[100] flex items-center gap-3 border backdrop-blur-md transition-all ${
        isError
          ? 'bg-red-900/90 border-red-500 text-red-100'
          : 'bg-violet-900/90 border-violet-500 text-violet-100'
      }`}
    >
      {isError ? <AlertCircle className="h-5 w-5" /> : <Check className="h-5 w-5" />}
      <span className="font-medium text-sm">{toast.message}</span>
    </div>
  );
}
