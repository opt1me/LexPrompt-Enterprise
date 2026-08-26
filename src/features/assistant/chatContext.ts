import type { DocumentFile, Settings } from '../../types';
import { chatStream } from '../../lib/openrouter';

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface ChatImage {
  mime: string;
  data: string;
}

export const SYSTEM_PROMPT =
  'You are a helpful legal assistant. OUTPUT FORMATTING RULES: 1) Use ## for main sections. ' +
  '2) Use ### for subsections. 3) Use - for all lists (no numbered lists unless sequential). ' +
  '4) Bold **key terms**. 5) Keep paragraphs short. ALWAYS provide detailed reasoning based on CONTEXT.';

export const UNREADABLE_MESSAGE =
  "This document has no readable text or images, so there's nothing for me to analyze. " +
  'It may have failed to parse — check the document list for a parse error.';

export const NEEDS_IMAGE_MODEL_MESSAGE =
  'This document appears to be a scan with no extractable text. The model selected in ' +
  "Settings doesn't support image input, so it can't read the scanned pages. Choose an " +
  'image-capable model to analyze this document.';

// A rough, explicit heuristic rather than an unexplained number: English
// legal prose runs close to 4 characters per token for OpenRouter's
// tokenizers, so `contextLength * 4` approximates the model's character
// budget. Half of that is reserved for the system prompt, prior turns and
// the model's own reply, leaving the other half for document context. This
// replaces the original's hardcoded 50,000-character cutoff, which was the
// same regardless of whether the selected model had an 8K or a 1M window.
const CHARS_PER_TOKEN = 4;
const CONTEXT_RESERVE_FRACTION = 0.5;
// Used only when the model's context length couldn't be looked up (list
// fetch failed, or the selected id isn't in the list) — a mid-sized window
// chosen so a lookup failure degrades to "conservative" rather than either
// "unusably tiny" or "silently unbounded".
const FALLBACK_CONTEXT_LENGTH = 32_000;

export function contextBudgetChars(contextLength: number | undefined): number {
  const length = contextLength && contextLength > 0 ? contextLength : FALLBACK_CONTEXT_LENGTH;
  return Math.floor(length * CHARS_PER_TOKEN * CONTEXT_RESERVE_FRACTION);
}

const PAGE_MARKER = /\[Page \d+\]/g;

/**
 * Strips the `[Page N]` markers `lib/documents.ts` inserts unconditionally
 * around every page's extracted text (`parsePdf`), so a fully scanned PDF —
 * whose pages contribute only those markers, no real content — is correctly
 * recognised as having no extractable text. Without stripping them, a
 * multi-page scan's `doc.text` reads as non-empty ("[Page 1]\n\n[Page 2]\n...")
 * even though there is nothing in it a model could actually read.
 */
export function extractableText(doc: DocumentFile): string {
  return doc.text.replace(PAGE_MARKER, '').trim();
}

export type ChatContext =
  | { kind: 'ok'; text: string; images: ChatImage[] }
  /** No document contributed text or images — there is nothing to send. */
  | { kind: 'unreadable' }
  /** Every document that lacked text had page images, but the selected
   *  model can't read images — sending them would waste a request on
   *  content the model is guaranteed not to use. */
  | { kind: 'needs-image-model' };

/**
 * Decides what the chat can actually work with, mirroring the fallback
 * `extractClause` already uses: text when a document has it, page images
 * when it doesn't (and the model can read them), and — this is the part
 * the original chat code skipped — an honest decline when a document has
 * neither. Sending an empty "CONTEXT:" and letting the model answer anyway
 * is exactly the confident-wrong-answer failure this app's error handling
 * elsewhere (parseJsonLoose, the DOCX "could not be reviewed" rows) exists
 * to avoid; a scanned document deserves the same honesty.
 */
export function buildChatContext(
  documents: DocumentFile[],
  modelSupportsImages: boolean,
  budgetChars: number,
): ChatContext {
  const textParts: string[] = [];
  const images: ChatImage[] = [];
  let sawUnusableImages = false;

  for (const doc of documents) {
    const text = extractableText(doc);
    if (text) {
      textParts.push(`--- ${doc.name} ---\n${text}`);
      continue;
    }
    if (doc.pageImages?.length) {
      if (modelSupportsImages) {
        images.push(...doc.pageImages);
      } else {
        sawUnusableImages = true;
      }
    }
  }

  const text = textParts.join('\n\n');
  if (!text && images.length === 0) {
    return sawUnusableImages ? { kind: 'needs-image-model' } : { kind: 'unreadable' };
  }
  return { kind: 'ok', text: text.slice(0, budgetChars), images };
}

/**
 * Caps serialized chat history to `budgetChars`, dropping the oldest turns
 * first. The most recent exchange (last two messages: the last user
 * question and its answer) is always kept intact even if it alone exceeds
 * the budget — trimming the turn the user just asked about would be worse
 * than a single oversized request.
 */
export function capHistory(history: ChatMessage[], budgetChars: number): ChatMessage[] {
  const kept: ChatMessage[] = [];
  let total = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const len = history[i].content.length;
    if (kept.length >= 2 && total + len > budgetChars) break;
    kept.unshift(history[i]);
    total += len;
  }
  return kept;
}

export interface SendChatMessageParams {
  documents: DocumentFile[];
  query: string;
  history: ChatMessage[];
  contextLength: number | undefined;
  modelSupportsImages: boolean;
  settings: Settings;
  onDelta: (chunk: string) => void;
}

/**
 * The whole "what do we send, and do we send anything at all" decision,
 * pulled out of the component so it's testable without rendering React.
 * When nothing usable was found, this resolves to an explanatory message
 * WITHOUT calling `chatStream` — no request is spent on a document the
 * model can't actually read.
 */
export async function sendChatMessage(params: SendChatMessageParams): Promise<string> {
  const budget = contextBudgetChars(params.contextLength);
  const context = buildChatContext(params.documents, params.modelSupportsImages, budget);

  if (context.kind === 'unreadable') return UNREADABLE_MESSAGE;
  if (context.kind === 'needs-image-model') return NEEDS_IMAGE_MODEL_MESSAGE;

  const historyText = capHistory(params.history, budget)
    .map(m => `${m.role.toUpperCase()}: ${m.content}`)
    .join('\n');
  const user = `CONTEXT: ${context.text}\nHISTORY: ${historyText}\nQUERY: ${params.query}`;

  return chatStream(
    {
      apiKey: params.settings.apiKey,
      modelId: params.settings.modelId,
      system: SYSTEM_PROMPT,
      user,
      images: context.images.length ? context.images : undefined,
    },
    params.onDelta,
  );
}
