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

/** Shared overlay chrome: fixed inset, blurred backdrop, centred panel with a titled header and close X. */
export function Modal({ isOpen, title, onClose, children, footer, size = 'md' }: ModalProps) {
  if (!isOpen) return null;
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
      <div role="dialog" aria-modal="true" className={`bg-[#1a1a1a] border border-white/10 rounded-2xl w-full ${SIZE_CLASSES[size]} shadow-2xl flex flex-col overflow-hidden`}>

        <div className="p-4 border-b border-white/10 flex justify-between items-center bg-[#222]">
          <h3 className="text-lg font-bold text-white">{title}</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-white" aria-label="Close">
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="p-6 space-y-5 bg-[#1a1a1a] overflow-y-auto max-h-[60vh]">
          {children}
        </div>
        {footer && (
          <div className="p-4 border-t border-white/10 flex justify-end gap-3 bg-[#222]">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}
