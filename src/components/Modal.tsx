import React from 'react';
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

/** Shared overlay chrome: fixed inset, dimmed scrim, centred panel with a titled header and close X. */
export function Modal({ isOpen, title, onClose, children, footer, size = 'md' }: ModalProps) {
  if (!isOpen) return null;
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-canvas/70 p-4">
      <div role="dialog" aria-modal="true" className={`bg-card border border-rule rounded-control w-full ${SIZE_CLASSES[size]} flex flex-col overflow-hidden`}>
        <div className="p-4 border-b border-rule flex justify-between items-center bg-paper">
          <h3 className="font-prose text-section text-ink-1">{title}</h3>
          <button onClick={onClose} className="text-ink-4 hover:text-ink-1" aria-label="Close">
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="p-6 space-y-5 bg-card overflow-y-auto max-h-[60vh]">
          {children}
        </div>
        {footer && (
          <div className="p-4 border-t border-rule flex justify-end gap-3 bg-paper">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}
