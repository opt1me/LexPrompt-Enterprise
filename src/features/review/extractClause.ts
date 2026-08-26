import { chatJson, isAuthError } from '../../lib/openrouter';
import { assessDocument, contextBudgetChars } from '../../lib/modelContext';
import type { Clause, DocumentFile, Finding, RiskLevel, Settings, Template } from '../../types';

const RISK_LEVELS: RiskLevel[] = ['High', 'Medium', 'Low', 'Info'];

export const CLAUSE_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    citations: {
      type: 'array',
      items: { type: 'string' },
      description:
        'EXACT VERBATIM SUBSTRINGS copied from the document text. Never clause numbers such as "Clause 14.2" — the literal text, so it can be located and highlighted.',
    },
    risk_level: { type: 'string', enum: RISK_LEVELS },
    risk_analysis: { type: 'string' },
  },
  required: ['summary', 'citations', 'risk_level', 'risk_analysis'],
  additionalProperties: false,
} as const;

interface RawFinding {
  summary?: string;
  citations?: unknown;
  risk_level?: string;
  risk_analysis?: string;
}

export interface BuildClausePromptOptions {
  /** Overrides `doc.text` — used by `extractClause` to pass the
   *  readability-filtered, budget-truncated text rather than the document's
   *  raw text (which may still carry `[Page N]` markers or sparse-OCR
   *  noise from pages that have a page-image fallback instead). Defaults to
   *  `doc.text` so existing callers/tests that pass a plain document are
   *  unaffected. */
  text?: string;
  /** True when `text` was cut short to fit the model's context budget
   *  (`contextBudgetChars`). Tells the model plainly rather than letting it
   *  answer "silent on this point" about a clause that was simply never
   *  sent. */
  truncated?: boolean;
}

export function buildClausePrompt(
  doc: DocumentFile,
  clause: Clause,
  template: Template,
  options: BuildClausePromptOptions = {},
): string {
  const riskBlock =
    template.mode === 'risk'
      ? `\nRISK CRITERIA: ${clause.riskCriteria || template.riskTolerance || 'General commercial reasonableness.'}`
      : '';
  const text = options.text ?? doc.text;
  const truncationNote = options.truncated
    ? '\n\nNOTE: The document text above was TRUNCATED to fit the context budget of the selected ' +
      'model and may not include the entire agreement. Do not conclude the agreement is silent on ' +
      'a point solely because it does not appear in the text shown.'
    : '';

  return `DOCUMENT: ${doc.name}

DOCUMENT TEXT:
${text}${truncationNote}

CLAUSE TO REVIEW: ${clause.title}
INSTRUCTION: ${clause.prompt}${riskBlock}

Return:
- summary: what the document says on this point, or that it is silent.
- citations: exact verbatim substrings from the document text supporting the summary.
- risk_level: one of High, Medium, Low, Info.
- risk_analysis: why that level.

If the document text above is empty and images are attached, read the images instead.`;
}

/**
 * Never rejects (except when the caller's own AbortSignal fires — see
 * below): a failed clause resolves to an error Finding so a run completes
 * with partial results and the cell can be retried on its own.
 *
 * Before ever calling the model, this mirrors the honest decline
 * `chatContext.ts` already makes for the chat panel (via the shared
 * `assessDocument`/`contextBudgetChars` helpers in `lib/modelContext.ts`):
 * a document with no usable text and no attached images, or with page
 * images the selected model can't read, is reported as an error Finding
 * instead of being sent to the model. Without this, a scanned PDF on a
 * text-only model — or any document mammoth/parseFile resolved to empty
 * text — got reviewed anyway and produced a confident, entirely fictional
 * "the agreement is silent on this point."
 */
export async function extractClause(
  doc: DocumentFile,
  clause: Clause,
  template: Template,
  settings: Settings,
  signal?: AbortSignal,
): Promise<Finding> {
  const base: Finding = { clauseId: clause.id, status: 'error', citations: [] };

  if (doc.parseError) {
    return { ...base, error: `Could not read ${doc.name}: ${doc.parseError}` };
  }

  // Unknown capability (list not loaded, fetch failed, or a manually
  // entered model id with no matching list entry) is treated as "cannot" —
  // the same conservative default `chatContext.ts` uses (ChatPanel starts
  // `modelSupportsImages` at `false` until the list resolves).
  const modelSupportsImages = settings.modelSupportsImages ?? false;
  const modelSupportsStructuredOutput = settings.modelSupportsStructuredOutput ?? false;

  const readability = assessDocument(doc, modelSupportsImages);
  if (readability.kind === 'unreadable') {
    return {
      ...base,
      error: `${doc.name} has no readable text or images to review. It may have failed to ` +
        'parse, or be a scan with no extractable content.',
    };
  }
  if (readability.kind === 'needs-image-model') {
    return {
      ...base,
      error: `${doc.name} appears to be a scan with no extractable text, and the model selected ` +
        "in Settings doesn't support image input, so it can't read the scanned pages. Choose an " +
        'image-capable model in Settings to review this document.',
    };
  }

  const budget = contextBudgetChars(settings.modelContextLength);
  const truncated = readability.text.length > budget;
  const textForPrompt = readability.text.slice(0, budget);

  try {
    const raw = await chatJson<RawFinding>(
      {
        apiKey: settings.apiKey,
        modelId: settings.modelId,
        system: `${template.systemPrompt}\n\nOUTPUT RULES: ${template.formatPrompt}`,
        user: buildClausePrompt(doc, clause, template, { text: textForPrompt, truncated }),
        images: readability.useImages ? doc.pageImages : undefined,
        jsonSchema: modelSupportsStructuredOutput ? CLAUSE_SCHEMA : undefined,
        temperature: 0.1,
      },
      signal,
    );

    // Case-insensitive on purpose: a mismatched case can only reach here via
    // parseJsonLoose's fallback for models that don't honour the strict
    // schema — exactly the models most likely to emit 'high' instead of
    // 'High'. Still strict about everything else: an unrecognised string,
    // null, or a non-string value all fall through to undefined.
    const level = typeof raw.risk_level === 'string'
      ? RISK_LEVELS.find(l => l.toLowerCase() === raw.risk_level!.toLowerCase())
      : undefined;

    return {
      clauseId: clause.id,
      status: 'done',
      summary: typeof raw.summary === 'string' ? raw.summary : '',
      citations: Array.isArray(raw.citations) ? raw.citations.filter(c => typeof c === 'string') : [],
      riskLevel: level,
      riskAnalysis: typeof raw.risk_analysis === 'string' ? raw.risk_analysis : undefined,
      truncated: truncated || undefined,
    };
  } catch (error) {
    // A cancelled run is not a failure (see App.tsx's own AbortError
    // handling) — an in-flight cell whose request was aborted must show a
    // calm "cancelled" state, not a red error card with a raw DOMException
    // message and a Retry button that will only abort again.
    if ((error instanceof DOMException && error.name === 'AbortError') ||
        (error as { name?: string } | null)?.name === 'AbortError') {
      return { clauseId: clause.id, status: 'cancelled', citations: [] };
    }
    return {
      ...base,
      error: error instanceof Error ? error.message : String(error),
      authError: isAuthError(error) || undefined,
    };
  }
}
