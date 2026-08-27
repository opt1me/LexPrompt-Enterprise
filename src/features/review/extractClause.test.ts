import { describe, it, expect, vi, beforeEach } from 'vitest';
import { extractClause, buildClausePrompt, CLAUSE_SCHEMA } from './extractClause';
import type { PlaybookClause, Template, DocumentFile, Settings } from '../../types';

vi.mock('../../lib/openrouter', async () => {
  const actual = await vi.importActual<typeof import('../../lib/openrouter')>('../../lib/openrouter');
  return { ...actual, chatJson: vi.fn() };
});
const { chatJson, OpenRouterError } = await import('../../lib/openrouter');

// A fully capable model (reads images, honours a strict schema, generous
// context window) is the default fixture so the existing happy-path tests
// below are unaffected by the capability gating added for Critical 1/9 —
// tests that specifically exercise the gating override these fields.
const settings: Settings = {
  apiKey: 'k', modelId: 'm', concurrency: 5,
  modelSupportsImages: true, modelSupportsStructuredOutput: true, modelContextLength: 1_000_000,
};

const clause: PlaybookClause = {
  id: 'c1',
  title: 'Governing Law',
  extractPrompt: 'Identify the governing law.',
  riskCriteria: 'Must be England and Wales.',
};

const template: Template = {
  id: 't1', name: 'Lease', contractType: 'Lease', mode: 'risk',
  systemPrompt: 'You are a reviewer.', formatPrompt: 'Quote verbatim.',
  riskTolerance: 'Conservative.', clauses: [clause],
  createdAt: 0, updatedAt: 0, schemaVersion: 2,
};

const doc: DocumentFile = {
  id: 'd1', name: 'lease.pdf', kind: 'pdf',
  text: 'This deed is governed by the laws of England and Wales.',
  file: new File([''], 'lease.pdf'),
};

beforeEach(() => vi.clearAllMocks());

describe('buildClausePrompt', () => {
  it('includes the clause instruction and the document text', () => {
    const prompt = buildClausePrompt(doc, clause, template);
    expect(prompt).toContain('Identify the governing law.');
    expect(prompt).toContain('England and Wales');
  });

  it('includes risk criteria in risk mode', () => {
    expect(buildClausePrompt(doc, clause, template)).toContain('Must be England and Wales.');
  });

  it('omits risk criteria in extraction mode', () => {
    const prompt = buildClausePrompt(doc, clause, { ...template, mode: 'extraction' });
    expect(prompt).not.toContain('Must be England and Wales.');
  });
});

describe('extractClause', () => {
  it('returns a done finding on success', async () => {
    vi.mocked(chatJson).mockResolvedValue({
      summary: 'England and Wales.',
      citations: ['governed by the laws of England and Wales'],
      risk_level: 'Low',
      risk_analysis: 'Matches the preferred jurisdiction.',
    });

    const finding = await extractClause(doc, clause, template, settings);

    expect(finding.status).toBe('done');
    expect(finding.clauseId).toBe('c1');
    expect(finding.summary).toBe('England and Wales.');
    expect(finding.citations).toEqual([
      { quote: 'governed by the laws of England and Wales', documentId: 'd1' },
    ]);
    expect(finding.riskLevel).toBe('Low');
  });

  it('resolves to an error finding rather than rejecting', async () => {
    vi.mocked(chatJson).mockRejectedValue(new Error('rate limited'));

    const finding = await extractClause(doc, clause, template, settings);

    expect(finding.status).toBe('error');
    expect(finding.error).toMatch(/rate limited/);
    expect(finding.citations).toEqual([]);
  });

  it('passes the JSON schema through to the model', async () => {
    vi.mocked(chatJson).mockResolvedValue({ summary: 's', citations: [] });
    await extractClause(doc, clause, template, settings);
    expect(vi.mocked(chatJson).mock.calls[0][0].jsonSchema).toBe(CLAUSE_SCHEMA);
  });

  it('coerces a missing citations array to empty', async () => {
    vi.mocked(chatJson).mockResolvedValue({ summary: 'no citations given' });
    const finding = await extractClause(doc, clause, template, settings);
    expect(finding.citations).toEqual([]);
    expect(finding.status).toBe('done');
  });

  it('coerces citations to empty when the model sends a bare string instead of an array', async () => {
    vi.mocked(chatJson).mockResolvedValue({ summary: 's', citations: 'not an array' });
    const finding = await extractClause(doc, clause, template, settings);
    expect(finding.citations).toEqual([]);
  });

  it('coerces citations to empty when the model sends null', async () => {
    vi.mocked(chatJson).mockResolvedValue({ summary: 's', citations: null });
    const finding = await extractClause(doc, clause, template, settings);
    expect(finding.citations).toEqual([]);
  });

  it('drops non-string entries from a mixed-type citations array, keeping only the strings', async () => {
    vi.mocked(chatJson).mockResolvedValue({ summary: 's', citations: ['ok', 42, null, 'fine'] });
    const finding = await extractClause(doc, clause, template, settings);
    expect(finding.citations).toEqual([
      { quote: 'ok', documentId: 'd1' },
      { quote: 'fine', documentId: 'd1' },
    ]);
  });

  it('drops a risk level the model invented outside the allowed set', async () => {
    vi.mocked(chatJson).mockResolvedValue({ summary: 's', citations: [], risk_level: 'Catastrophic' });
    expect((await extractClause(doc, clause, template, settings)).riskLevel).toBeUndefined();
  });

  it('drops a null risk level', async () => {
    vi.mocked(chatJson).mockResolvedValue({ summary: 's', citations: [], risk_level: null });
    expect((await extractClause(doc, clause, template, settings)).riskLevel).toBeUndefined();
  });

  it('drops a numeric risk level', async () => {
    vi.mocked(chatJson).mockResolvedValue({ summary: 's', citations: [], risk_level: 7 });
    expect((await extractClause(doc, clause, template, settings)).riskLevel).toBeUndefined();
  });

  it('normalises a lowercase risk level to the canonical casing', async () => {
    vi.mocked(chatJson).mockResolvedValue({ summary: 's', citations: [], risk_level: 'high' });
    expect((await extractClause(doc, clause, template, settings)).riskLevel).toBe('High');
  });

  it('attaches page images for a scanned document', async () => {
    vi.mocked(chatJson).mockResolvedValue({ summary: 's', citations: [] });
    const scan: DocumentFile = { ...doc, text: '', pageImages: [{ mime: 'image/jpeg', data: 'AAA' }] };

    await extractClause(scan, clause, template, settings);

    expect(vi.mocked(chatJson).mock.calls[0][0].images).toHaveLength(1);
  });

  it('sends no images for a document that has a text layer', async () => {
    vi.mocked(chatJson).mockResolvedValue({ summary: 's', citations: [] });
    await extractClause(doc, clause, template, settings);
    expect(vi.mocked(chatJson).mock.calls[0][0].images).toBeUndefined();
  });

  // Task 16: a schema-valid but empty summary is a non-answer, not a
  // finding — see empty-review-investigation.md. A model with a genuine
  // answer, including "the document is silent on this point," always
  // writes something; an empty string must not be indistinguishable from
  // a real 'done' finding.
  it('reports an empty summary as an error finding, not done', async () => {
    vi.mocked(chatJson).mockResolvedValue({ summary: '', citations: [], risk_level: 'Low' });
    const finding = await extractClause(doc, clause, template, settings);
    expect(finding.status).toBe('error');
    expect(finding.noContent).toBe(true);
    expect(finding.error).toMatch(/no content/i);
  });

  it('reports a whitespace-only summary as an error finding, not done', async () => {
    vi.mocked(chatJson).mockResolvedValue({ summary: '   \n\t  ', citations: [] });
    const finding = await extractClause(doc, clause, template, settings);
    expect(finding.status).toBe('error');
    expect(finding.noContent).toBe(true);
  });

  it('keeps citations and risk level on a no-content finding, for whatever use the UI has for them', async () => {
    vi.mocked(chatJson).mockResolvedValue({
      summary: '',
      citations: ['stray quote'],
      risk_level: 'High',
      risk_analysis: 'stray analysis',
    });
    const finding = await extractClause(doc, clause, template, settings);
    expect(finding.citations).toEqual([{ quote: 'stray quote', documentId: 'd1' }]);
    expect(finding.riskLevel).toBe('High');
    expect(finding.riskAnalysis).toBe('stray analysis');
  });

  // The boundary this guard must not cross: a real summary describing a
  // clause that is genuinely absent from the document is a legitimate
  // finding, whether or not it has citations to back it up.
  it('treats a real summary with no citations as done (boundary: clause genuinely absent)', async () => {
    vi.mocked(chatJson).mockResolvedValue({ summary: 'The agreement is silent on this point.', citations: [] });
    const finding = await extractClause(doc, clause, template, settings);
    expect(finding.status).toBe('done');
    expect(finding.summary).toBe('The agreement is silent on this point.');
  });

  it('treats a real summary with citations as done', async () => {
    vi.mocked(chatJson).mockResolvedValue({ summary: 'Governed by English law.', citations: ['English law'] });
    const finding = await extractClause(doc, clause, template, settings);
    expect(finding.status).toBe('done');
  });

  it('reports a parse failure without calling the model', async () => {
    const broken: DocumentFile = { ...doc, text: '', parseError: 'corrupt file' };
    const finding = await extractClause(broken, clause, template, settings);
    expect(finding.status).toBe('error');
    expect(finding.error).toMatch(/corrupt file/);
    expect(chatJson).not.toHaveBeenCalled();
  });
});

// Critical 1 + 2: the review engine must decline — without calling the
// model — exactly when chatContext.ts's buildChatContext would, instead of
// sending an empty or near-empty prompt and getting back a confident,
// entirely fictional finding.
describe('extractClause: readability guard (Critical 1 & 2)', () => {
  it('reports an error finding, without calling the model, for a scanned PDF on a text-only model', async () => {
    const scan: DocumentFile = {
      ...doc,
      text: '[Page 1]\n\n',
      pageImages: [{ mime: 'image/jpeg', data: 'AAA' }],
    };
    const textOnly: Settings = { ...settings, modelSupportsImages: false };

    const finding = await extractClause(scan, clause, template, textOnly);

    expect(finding.status).toBe('error');
    expect(finding.error).toMatch(/scan/i);
    expect(finding.error).toMatch(/image/i);
    expect(chatJson).not.toHaveBeenCalled();
  });

  it('reports an error finding, without calling the model, for a scan with no page images at all', async () => {
    const blank: DocumentFile = { ...doc, text: '[Page 1]\n\n' };
    const finding = await extractClause(blank, clause, template, settings);
    expect(finding.status).toBe('error');
    expect(finding.error).toMatch(/no readable text or images/i);
    expect(chatJson).not.toHaveBeenCalled();
  });

  it('treats unknown image support as "cannot" (conservative default), matching ChatPanel\'s initial state', async () => {
    const scan: DocumentFile = {
      ...doc,
      text: '',
      pageImages: [{ mime: 'image/jpeg', data: 'AAA' }],
    };
    const unknownCapabilities: Settings = { apiKey: 'k', modelId: 'm', concurrency: 5 };

    const finding = await extractClause(scan, clause, template, unknownCapabilities);

    expect(finding.status).toBe('error');
    expect(chatJson).not.toHaveBeenCalled();
  });

  it('still reviews a mixed document, keeping the readable page and declining only what is unreadable', async () => {
    vi.mocked(chatJson).mockResolvedValue({ summary: 's', citations: [] });
    const mixed: DocumentFile = {
      ...doc,
      text: '[Page 1]\nThis is a perfectly readable cover page with real content.\n\n[Page 2]\nAB\n\n',
    };

    const finding = await extractClause(mixed, clause, template, settings);

    expect(finding.status).toBe('done');
    const prompt = vi.mocked(chatJson).mock.calls[0][0].user as string;
    expect(prompt).toContain('readable cover page');
    expect(prompt).not.toContain('AB');
  });

  it('reports an empty-document error finding for a DOCX mammoth resolved to no text (Critical 2)', async () => {
    const empty: DocumentFile = { id: 'd2', name: 'blank.docx', kind: 'docx', text: '', file: new File([''], 'blank.docx') };
    const finding = await extractClause(empty, clause, template, settings);
    expect(finding.status).toBe('error');
    expect(finding.error).toMatch(/no readable text or images/i);
    expect(chatJson).not.toHaveBeenCalled();
  });

  it('reports an empty-document error finding for any text-free document, not only a parse failure', async () => {
    const empty: DocumentFile = { ...doc, text: '   ' };
    const finding = await extractClause(empty, clause, template, settings);
    expect(finding.status).toBe('error');
    expect(chatJson).not.toHaveBeenCalled();
  });
});

describe('extractClause: structured output capability', () => {
  it('sends the JSON schema when the model advertises structured output support', async () => {
    vi.mocked(chatJson).mockResolvedValue({ summary: 's', citations: [] });
    await extractClause(doc, clause, template, { ...settings, modelSupportsStructuredOutput: true });
    expect(vi.mocked(chatJson).mock.calls[0][0].jsonSchema).toBe(CLAUSE_SCHEMA);
  });

  it('omits the JSON schema when the model does not advertise structured output support', async () => {
    vi.mocked(chatJson).mockResolvedValue({ summary: 's', citations: [] });
    await extractClause(doc, clause, template, { ...settings, modelSupportsStructuredOutput: false });
    expect(vi.mocked(chatJson).mock.calls[0][0].jsonSchema).toBeUndefined();
  });

  it('omits the JSON schema when structured-output support is unknown', async () => {
    vi.mocked(chatJson).mockResolvedValue({ summary: 's', citations: [] });
    const unknown: Settings = { apiKey: 'k', modelId: 'm', concurrency: 5 };
    await extractClause(doc, clause, template, unknown);
    expect(vi.mocked(chatJson).mock.calls[0][0].jsonSchema).toBeUndefined();
  });
});

describe('extractClause: context budget (Important 9)', () => {
  it('truncates document text to the model\'s context budget and flags the finding as truncated', async () => {
    vi.mocked(chatJson).mockResolvedValue({ summary: 's', citations: [] });
    const long: DocumentFile = { ...doc, text: 'x'.repeat(1000) };
    // contextLength 100 -> budget = floor(100 * 4 * 0.5) = 200 characters.
    const tightBudget: Settings = { ...settings, modelContextLength: 100 };

    const finding = await extractClause(long, clause, template, tightBudget);

    const prompt = vi.mocked(chatJson).mock.calls[0][0].user as string;
    expect(prompt).toContain('TRUNCATED');
    expect(finding.truncated).toBe(true);
  });

  it('does not flag a finding as truncated when the document fits the budget', async () => {
    vi.mocked(chatJson).mockResolvedValue({ summary: 's', citations: [] });
    const finding = await extractClause(doc, clause, template, settings);
    // Absence, not an undefined-valued key. `toBeUndefined` passes either
    // way, and `structuredClone` — how IndexedDB writes every record —
    // PRESERVES an undefined-valued key, so the persisted finding would read
    // to any `in` check as "truncation was recorded here" (CLAUDE.md).
    expect('truncated' in finding).toBe(false);
  });
});

describe('extractClause: auth errors and cancellation (Important 4 & 5)', () => {
  it('tags the finding as an auth error on a 401 from OpenRouter', async () => {
    vi.mocked(chatJson).mockRejectedValue(new OpenRouterError('Your OpenRouter API key was rejected: bad key', 401));
    const finding = await extractClause(doc, clause, template, settings);
    expect(finding.status).toBe('error');
    expect(finding.authError).toBe(true);
  });

  it('does not tag an ordinary failure as an auth error', async () => {
    vi.mocked(chatJson).mockRejectedValue(new Error('rate limited'));
    const finding = await extractClause(doc, clause, template, settings);
    expect(finding.authError).toBeUndefined();
  });

  it('resolves an aborted request to a calm "cancelled" finding, not an error with a raw DOMException message', async () => {
    vi.mocked(chatJson).mockRejectedValue(new DOMException('The operation was aborted.', 'AbortError'));
    const finding = await extractClause(doc, clause, template, settings);
    expect(finding.status).toBe('cancelled');
    expect(finding.error).toBeUndefined();
  });
});

describe('extractClause citations and verification', () => {
  it('attributes each citation to the document and pins a page where derivable', async () => {
    const pagedDoc: DocumentFile = {
      id: 'doc-42', name: 'doc42.pdf', kind: 'pdf',
      text: '[Page 1]\nThe Supplier shall deliver.\n\n[Page 2]\nLiability is capped at the Charges.\n\n',
      file: new File([''], 'doc42.pdf'),
    };
    vi.mocked(chatJson).mockResolvedValue({
      summary: 'Liability is capped.',
      citations: ['Liability is capped at the Charges.'],
      risk_level: 'Medium',
      risk_analysis: 'Standard cap.',
    });

    const finding = await extractClause(pagedDoc, clause, template, settings);

    expect(finding.citations).toEqual([
      { quote: 'Liability is capped at the Charges.', documentId: 'doc-42', page: 2 },
    ]);
  });

  it('starts every finding unchecked with no notes', async () => {
    vi.mocked(chatJson).mockResolvedValue({ summary: 'Found it.', citations: [], risk_level: 'Low', risk_analysis: 'Fine.' });
    const finding = await extractClause(doc, clause, template, settings);
    expect(finding.verification).toEqual({ state: 'unchecked' });
    expect(finding.notes).toEqual([]);
  });

  it('starts an error finding unchecked too — a failure is not a judgement', async () => {
    const broken: DocumentFile = { ...doc, parseError: 'corrupt' };
    const finding = await extractClause(broken, clause, template, settings);
    expect(finding.status).toBe('error');
    expect(finding.verification).toEqual({ state: 'unchecked' });
    expect(finding.notes).toEqual([]);
  });

  it('drops junk citation entries without dropping the good ones', async () => {
    vi.mocked(chatJson).mockResolvedValue({
      summary: 'Found it.',
      citations: ['', 'The Supplier shall deliver.', null],
      risk_level: 'Low',
      risk_analysis: 'Fine.',
    });
    const doc7: DocumentFile = {
      id: 'doc-7', name: 'doc7.pdf', kind: 'pdf',
      text: '[Page 1]\nThe Supplier shall deliver.\n\n',
      file: new File([''], 'doc7.pdf'),
    };
    const finding = await extractClause(doc7, clause, template, settings);
    expect(finding.citations).toEqual([
      { quote: 'The Supplier shall deliver.', documentId: 'doc-7', page: 1 },
    ]);
  });
});
