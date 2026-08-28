import React, { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Copy, Check } from 'lucide-react';
import { Modal } from '../../components/Modal';
import { Button } from '../../components/Button';

export interface EmailModalProps {
  isOpen: boolean;
  onClose: () => void;
  content: string | null;
}

/**
 * Renders a drafted client email as markdown with a Copy button. Lives in
 * its own module (rather than inline in ResultsView) so `react-markdown` +
 * `remark-gfm` — only ever needed once a user actually drafts an email —
 * can be pulled in via a lazy `import()` from ResultsView instead of
 * sitting in the entry chunk permanently. This is the direct replacement
 * for the original's `alert(emailBody)`.
 */
export function EmailModal({ isOpen, onClose, content }: EmailModalProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    if (!content) return;
    navigator.clipboard.writeText(content);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Draft Email"
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Close</Button>
          <Button variant="primary" onClick={handleCopy}>
            {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
            {copied ? 'Copied' : 'Copy'}
          </Button>
        </>
      }
    >
      <div className="font-prose text-field text-ink-prose max-w-none">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{content ?? ''}</ReactMarkdown>
      </div>
    </Modal>
  );
}
