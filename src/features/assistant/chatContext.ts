import type { DocumentFile, Settings } from '../../types';
import { gatewayModelClient } from '../../lib/model/gatewayModelClient';
import { extractableText, usableText, contextBudgetChars } from '../../lib/modelContext';

export { extractableText, contextBudgetChars };

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

// contextBudgetChars, extractableText and usableText now live in
// lib/modelContext.ts, shared with the review engine's per-document
// readability guard (extractClause.ts) so both apply the identical rule
// rather than two separately-tuned checks.

export type ChatContext =
  | { kind: 'ok'; text: string; images: ChatImage[] }
  /** No document contributed text or images — there is nothing to send. */
  | { kind: 'unreadable' }
  /** At least one document had nothing but page images to offer, and the
   *  selected model can't read images — sending them would waste a
   *  request on content the model is guaranteed not to use. */
  | { kind: 'needs-image-model' };

/**
 * Decides what the chat can actually work with, mirroring the fallback
 * `extractClause` already uses: text when a page has it, page images when
 * it doesn't (and the model can read them), and — this is the part the
 * original chat code skipped — an honest decline when a document has
 * neither. Sending an empty "CONTEXT:" and letting the model answer anyway
 * is exactly the confident-wrong-answer failure this app's error handling
 * elsewhere (parseJsonLoose, the DOCX "could not be reviewed" rows) exists
 * to avoid; a scanned document deserves the same honesty.
 *
 * Text and images are not mutually exclusive per document: `parsePdf`
 * captures an image for every page that was too sparse to be text,
 * independent of whether other pages in the same document had real text,
 * so a mixed document can and should contribute both.
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
    const text = usableText(doc);
    if (text) textParts.push(`--- ${doc.name} ---\n${text}`);

    if (doc.pageImages?.length) {
      if (modelSupportsImages) {
        images.push(...doc.pageImages);
      } else if (!text) {
        // Only worth flagging "needs an image-capable model" when this
        // document had nothing else to offer — one with usable text from
        // another page isn't a lost cause just because its scanned pages
        // can't also be read.
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
 * WITHOUT calling the model at all — no request is spent on a document the
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

  // `.content` is the same joined text `openrouter.ts`'s chatStream
  // returned; the response around it now also says which backend answered
  // and where, which the panel does not yet render.
  const answer = await gatewayModelClient.chatStream(
    {
      modelChoiceId: params.settings.modelId,
      purpose: 'assistant.chat',
      system: SYSTEM_PROMPT,
      user,
      images: context.images.length ? context.images : undefined,
    },
    params.onDelta,
  );
  return answer.content;
}
