import React from 'react';
import { Loader } from 'lucide-react';

export type ButtonVariant = 'primary' | 'ghost' | 'danger';

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  loading?: boolean;
}

const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-page hover:bg-accent-strong',
  ghost: 'bg-paper border border-rule text-ink-1 hover:bg-chip-fill',
  danger: 'bg-risk-high text-page hover:opacity-90',
};

export function Button({
  variant = 'primary',
  loading = false,
  disabled,
  className = '',
  children,
  ...props
}: ButtonProps) {
  const isDisabled = disabled || loading;
  return (
    <button
      disabled={isDisabled}
      className={`px-4 py-2 rounded-control flex items-center justify-center gap-2 font-ui text-button font-semibold transition-colors duration-150 disabled:opacity-50 disabled:cursor-not-allowed ${VARIANT_CLASSES[variant]} ${className}`}
      {...props}
    >
      {loading && (
        <span data-busy="true" aria-live="polite" className="flex items-center">
          <Loader className="w-4 h-4 animate-spin" aria-hidden="true" />
        </span>
      )}
      {children}
    </button>
  );
}
