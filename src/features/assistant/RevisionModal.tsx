import React, { useState } from 'react';
import { Copy, Check } from 'lucide-react';
import { Modal } from '../../components/Modal';
import { Button } from '../../components/Button';

export interface RevisionData {
  title: string;
  original: string;
  revised: string;
}

export interface RevisionModalProps {
  isOpen: boolean;
  onClose: () => void;
  data: RevisionData | null;
}

/** Side-by-side original/revised comparison for a suggested clause rewrite.
 *  Ported from the deleted `components/Modals.tsx` RevisionModal, rebuilt on
 *  the shared `<Modal>` shell instead of its own bespoke overlay. */
export function RevisionModal({ isOpen, onClose, data }: RevisionModalProps) {
  const [copied, setCopied] = useState(false);

  if (!data) return null;

  const handleCopy = () => {
    navigator.clipboard.writeText(data.revised);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={`Revision Comparison: ${data.title}`}
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Close</Button>
          <Button variant="primary" onClick={handleCopy}>
            {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
            {copied ? 'Copied' : 'Copy New Clause'}
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="p-4 rounded-card bg-paper border border-rule">
          <span className="font-mono text-label uppercase text-ink-4 mb-4 block">Original Text</span>
          <p className="font-prose text-field text-ink-prose whitespace-pre-wrap leading-relaxed">{data.original}</p>
        </div>
        <div className="p-4 rounded-card bg-draft-tint border border-dashed border-draft">
          <span className="font-mono text-label uppercase text-draft mb-4 block">AI Suggestion</span>
          <p className="font-prose text-field text-ink-prose whitespace-pre-wrap leading-relaxed">{data.revised}</p>
        </div>
      </div>
    </Modal>
  );
}
