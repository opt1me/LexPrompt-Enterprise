import React from 'react';
import { Loader } from 'lucide-react';

export type ButtonVariant = 'primary' | 'ghost' | 'danger';

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  loading?: boolean;
}

const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  primary: 'bg-violet-600 text-white hover:bg-violet-500 shadow-lg shadow-violet-900/20',
  ghost: 'bg-white/5 border border-white/10 text-white hover:bg-white/10',
  danger: 'bg-red-600 text-white hover:bg-red-500',
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
      className={`px-4 py-2 rounded-lg flex items-center justify-center gap-2 text-sm font-medium transition-all active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed disabled:active:scale-100 ${VARIANT_CLASSES[variant]} ${className}`}
      {...props}
    >
      {loading && <Loader className="w-4 h-4 animate-spin" />}
      {children}
    </button>
  );
}
