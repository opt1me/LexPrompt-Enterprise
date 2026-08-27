import React, { useMemo, useState } from 'react';
import { Copy, MessageSquare, Code, ToggleLeft, ToggleRight } from 'lucide-react';
import type { PlaybookDraft } from '../../types';
import { Modal } from '../../components/Modal';
import { Button } from '../../components/Button';
import { buildMegaPrompt, type MegaPromptFormat } from './buildMegaPrompt';

export interface MegaPromptModalProps {
  isOpen: boolean;
  onClose: () => void;
  template: PlaybookDraft | null;
}

/** The "DIY mode" viewer: a self-contained prompt the user can copy and paste elsewhere. */
export function MegaPromptModal({ isOpen, onClose, template }: MegaPromptModalProps) {
  const [format, setFormat] = useState<MegaPromptFormat>('copilot');
  const [includeRisk, setIncludeRisk] = useState(true);

  const promptText = useMemo(
    () => (template ? buildMegaPrompt(template, format, includeRisk) : ''),
    [template, format, includeRisk],
  );

  return (
    <Modal
      isOpen={isOpen}
      title="DIY Prompt Builder"
      onClose={onClose}
      size="lg"
      footer={
        <Button onClick={() => navigator.clipboard.writeText(promptText)}>
          <Copy className="h-4 w-4" /> Copy Prompt
        </Button>
      }
    >
      <div className="flex items-center gap-3 -mt-2 mb-3">
        <div className="flex rounded-md overflow-hidden border border-white/10">
          <button
            onClick={() => setFormat('copilot')}
            className={`px-3 py-1.5 text-xs font-medium flex items-center gap-1 ${format === 'copilot' ? 'bg-violet-600 text-white' : 'text-gray-400 bg-black/30'}`}
          >
            <MessageSquare className="h-3 w-3" /> CoPilot
          </button>
          <button
            onClick={() => setFormat('json')}
            className={`px-3 py-1.5 text-xs font-medium flex items-center gap-1 ${format === 'json' ? 'bg-blue-600 text-white' : 'text-gray-400 bg-black/30'}`}
          >
            <Code className="h-3 w-3" /> JSON API
          </button>
        </div>
        <button
          onClick={() => setIncludeRisk(!includeRisk)}
          className={`px-3 py-1.5 text-xs font-medium rounded-md flex items-center gap-1 border border-white/10 ${includeRisk ? 'bg-red-500/20 text-red-300' : 'text-gray-400 bg-black/30'}`}
        >
          {includeRisk ? <ToggleRight className="h-3 w-3" /> : <ToggleLeft className="h-3 w-3" />} Risk
        </button>
      </div>
      <textarea
        value={promptText}
        readOnly
        className="w-full h-[50vh] bg-black/50 border border-white/10 rounded-lg p-4 text-xs text-gray-300 font-mono resize-none focus:outline-none"
      />
    </Modal>
  );
}
