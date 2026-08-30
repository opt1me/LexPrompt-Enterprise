import { describe, it, expect, vi, beforeEach } from 'vitest';
import { extractClause, buildClausePrompt, clauseSchema, CLAUSE_SCHEMA } from './extractClause.ts';
import type { PlaybookClause, PlaybookVersion, DocumentFile, StandardPosition } from '../domain/types.ts';
import type { WorkspaceSettings } from '../api/records.ts';
import type { ModelClient } from '../model/client.ts';

import { ModelError } from '../model/protocol.ts';

// The model client is a PARAMETER now, so there is nothing to mock at the
// module level: the tests build one and hand it in. `chatJson` is the only
// method either extractor calls; the other three throw rather than
// returning a plausible empty answer, so a test that starts calling one
// fails loudly instead of quietly passing on a stub.
const chatJson = vi.fn();
const client = {
  chatJson,
  chat: () => { throw new Error('the extractors do not call chat'); },
  chatStream: () => { throw new Error('the extractors do not call chatStream'); },
  listModels: () => { throw new Error('the extractors do not call listModels'); },
} as unknown as ModelClient;

// A fully capable model (reads images, honours a strict schema, generous
// context window) is the default fixture so the existing happy-path tests
// below are unaffected by the capability gating added for Critical 1/9 —
// tests that specifically exercise the gating override these fields.
const settings: WorkspaceSettings = {
  modelChoiceId: 'm', concurrency: 5,
  modelSupportsImages: true, modelSupportsStructuredOutput: true, modelContextLength: 1_000_000,
};

const clause: PlaybookClause = {
  id: 'c1',
  title: 'Governing Law',
  extractPrompt: 'Identify the governing law.',
  riskCriteria: 'Must be England and Wales.',
};

const template: PlaybookVersion = {
  id: 't1', name: 'Lease', contractType: 'Lease',
  systemPrompt: 'You are a reviewer.', formatPrompt: 'Quote verbatim.',
  riskTolerance: 'Conservative.', clauses: [clause],
  playbookId: 'pb', version: 1, changeSummary: '', publishedAt: 0, publishedByUserId: '', schemaVersion: 6,
};

const doc: DocumentFile = {
  id: 'd1', name: 'lease.pdf', kind: 'pdf',
  text: 'This deed is governed by the laws of England and Wales.',
  file: new File([''], 'lease.pdf'),
};

const pos: StandardPosition = {
  text: 'We ask for a 6-month break notice, no conditions.',
  origin: 'authored',
  reviewedByHuman: true,
};

beforeEach(() => vi.clearAllMocks());

/**
 * The argument order, pinned before anything else in this file runs.
 *
 * `client` is position 0 and `signal` is position 5. Both `signal` and
 * `context` are optional, and mocks in `src/App.*.test.tsx` and
 * `runReview.test.ts` read the arguments POSITIONALLY — a mock holding the
 * settings object where it expected an `AbortSignal` gets no type error, it
 * just never sees the abort, and the symptom is a run that cannot be
 * cancelled. Nothing but a test can catch that.
 */
describe('the extractor signature', () => {
  it('takes the client first and hands the signal through at position 5', async () => {
    chatJson.mockImplementation(async () => ({
      summary: 's', citations: [], risk_level: 'Low', risk_analysis: 'r',
    }));
    const controller = new AbortController();
    await extractClause(client, doc, clause, template, settings, controller.signal, { reviewId: 'r1' });

    // `chatJson`'s own SECOND argument is the signal it was handed — which is
    // only true if `signal` arrived where the implementation expects it.
    expect(chatJson.mock.calls[0][1]).toBe(controller.signal);
    // …and the request built from arguments 1-4 is the one for this clause,
    // so nothing shifted underneath it either.
    expect(chatJson.mock.calls[0][0].purpose).toBe('review.clause');
    expect(chatJson.mock.calls[0][0].context.clauseId).toBe('c1');
    expect(chatJson.mock.calls[0][0].context.reviewId).toBe('r1');
  });

  it('calls the client it was given, never one of its own', async () => {
    // The whole point of the injection: this function has no import that
    // could reach a model, so a worker gets the same extractor a browser
    // does. If it ever acquired one, the second client would answer and this
    // spy would see nothing.
    const other = vi.fn(async () => ({
      summary: 'from the injected client', citations: [], risk_level: 'Low', risk_analysis: 'r',
    }));
    const finding = await extractClause(
      { ...client, chatJson: other } as unknown as ModelClient,
      doc, clause, template, settings,
    );
    expect(other).toHaveBeenCalledTimes(1);
    expect(chatJson).not.toHaveBeenCalled();
    expect(finding.summary).toBe('from the injected client');
  });
});

describe('buildClausePrompt', () => {
  it('includes the clause instruction and the document text', () => {
    const prompt = buildClausePrompt(doc, clause, template);
    expect(prompt).toContain('Identify the governing law.');
    expect(prompt).toContain('England and Wales');
  });

  it('includes risk criteria in risk mode', () => {
    expect(buildClausePrompt(doc, clause, template)).toContain('Must be England and Wales.');
  });

  it('omits risk criteria when neither the clause nor the playbook has any (R-D1)', () => {
    // `mode` is gone: the PRESENCE of criteria decides, so a clause with no
    // riskCriteria under a playbook with no riskTolerance gets no block.
    const plain = { ...clause, riskCriteria: undefined };
    const prompt = buildClausePrompt(doc, plain, { ...template, riskTolerance: undefined, clauses: [plain] });
    expect(prompt).not.toContain('Must be England and Wales.');
    expect(prompt).not.toContain('RISK CRITERIA');
  });

  it('falls back to the playbook riskTolerance when the clause has no criteria', () => {
    const plain = { ...clause, riskCriteria: undefined };
    expect(buildClausePrompt(doc, plain, { ...template, clauses: [plain] }))
      .toContain('RISK CRITERIA: Conservative.');
  });

  // R-D1: `Template.mode` is gone. Presence of a criterion — the clause's
  // own, else the playbook's tolerance — decides whether the block is
  // emitted at all, so a migrated risk-mode playbook (which keeps its
  // `riskTolerance`) still emits exactly today's block, and a migrated
  // extraction-mode playbook (whose stale tolerance was cleared by the
  // migration) emits none.
  it('emits the risk block from riskCriteria or riskTolerance now that mode is gone (R-D1)', () => {
    const versionNoTolerance: PlaybookVersion = { ...template, riskTolerance: undefined };

    expect(buildClausePrompt(doc, { ...clause, riskCriteria: 'Must be unconditional' }, versionNoTolerance))
      .toContain('RISK CRITERIA: Must be unconditional');
    expect(buildClausePrompt(doc, { ...clause, riskCriteria: undefined }, { ...template, riskTolerance: 'Risk-averse' }))
      .toContain('RISK CRITERIA: Risk-averse');
    expect(buildClausePrompt(doc, { ...clause, riskCriteria: undefined }, versionNoTolerance))
      .not.toContain('RISK CRITERIA');
  });

  // The `||` in `riskCriteriaBlock` is easy to invert by accident (e.g.
  // `version.riskTolerance || clause.riskCriteria`), which would silently let
  // a playbook-wide tolerance override a clause's own, more specific
  // criterion. Both fixtures below have both set, so this only passes when
  // the clause's own criterion wins.
  it('prefers the clause\'s own risk criteria over the playbook tolerance when both are present (R-D1 precedence)', () => {
    const prompt = buildClausePrompt(doc, clause, template);
    expect(prompt).toContain('RISK CRITERIA: Must be England and Wales.');
    expect(prompt).not.toContain('RISK CRITERIA: Conservative.');
  });

  it('asks for a position outcome only when the clause has a standard position', () => {
    const withPos = buildClausePrompt(doc, { ...clause, standardPosition: pos }, template);
    const without = buildClausePrompt(doc, clause, template);
    expect(withPos).toContain('OUR STANDARD POSITION');
    expect(withPos).toContain('We ask for a 6-month break notice');
    expect(withPos).toContain('position_outcome');
    expect(without).not.toContain('OUR STANDARD POSITION');
    expect(without).not.toContain('position_outcome');
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

    const finding = await extractClause(client, doc, clause, template, settings);

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

    const finding = await extractClause(client, doc, clause, template, settings);

    expect(finding.status).toBe('error');
    expect(finding.error).toMatch(/rate limited/);
    expect(finding.citations).toEqual([]);
  });

  it('passes the JSON schema through to the model', async () => {
    vi.mocked(chatJson).mockResolvedValue({ summary: 's', citations: [] });
    await extractClause(client, doc, clause, template, settings);
    expect(vi.mocked(chatJson).mock.calls[0][0].jsonSchema).toBe(CLAUSE_SCHEMA);
  });

  it('coerces a missing citations array to empty', async () => {
    vi.mocked(chatJson).mockResolvedValue({ summary: 'no citations given' });
    const finding = await extractClause(client, doc, clause, template, settings);
    expect(finding.citations).toEqual([]);
    expect(finding.status).toBe('done');
  });

  it('coerces citations to empty when the model sends a bare string instead of an array', async () => {
    vi.mocked(chatJson).mockResolvedValue({ summary: 's', citations: 'not an array' });
    const finding = await extractClause(client, doc, clause, template, settings);
    expect(finding.citations).toEqual([]);
  });

  it('coerces citations to empty when the model sends null', async () => {
    vi.mocked(chatJson).mockResolvedValue({ summary: 's', citations: null });
    const finding = await extractClause(client, doc, clause, template, settings);
    expect(finding.citations).toEqual([]);
  });

  it('drops non-string entries from a mixed-type citations array, keeping only the strings', async () => {
    vi.mocked(chatJson).mockResolvedValue({ summary: 's', citations: ['ok', 42, null, 'fine'] });
    const finding = await extractClause(client, doc, clause, template, settings);
    expect(finding.citations).toEqual([
      { quote: 'ok', documentId: 'd1' },
      { quote: 'fine', documentId: 'd1' },
    ]);
  });

  it('drops a risk level the model invented outside the allowed set', async () => {
    vi.mocked(chatJson).mockResolvedValue({ summary: 's', citations: [], risk_level: 'Catastrophic' });
    expect((await extractClause(client, doc, clause, template, settings)).riskLevel).toBeUndefined();
  });

  it('drops a null risk level', async () => {
    vi.mocked(chatJson).mockResolvedValue({ summary: 's', citations: [], risk_level: null });
    expect((await extractClause(client, doc, clause, template, settings)).riskLevel).toBeUndefined();
  });

  it('drops a numeric risk level', async () => {
    vi.mocked(chatJson).mockResolvedValue({ summary: 's', citations: [], risk_level: 7 });
    expect((await extractClause(client, doc, clause, template, settings)).riskLevel).toBeUndefined();
  });

  it('normalises a lowercase risk level to the canonical casing', async () => {
    vi.mocked(chatJson).mockResolvedValue({ summary: 's', citations: [], risk_level: 'high' });
    expect((await extractClause(client, doc, clause, template, settings)).riskLevel).toBe('High');
  });

  it('attaches page images for a scanned document', async () => {
    vi.mocked(chatJson).mockResolvedValue({ summary: 's', citations: [] });
    const scan: DocumentFile = { ...doc, text: '', pageImages: [{ mime: 'image/jpeg', data: 'AAA' }] };

    await extractClause(client, scan, clause, template, settings);

    expect(vi.mocked(chatJson).mock.calls[0][0].images).toHaveLength(1);
  });

  it('sends no images for a document that has a text layer', async () => {
    vi.mocked(chatJson).mockResolvedValue({ summary: 's', citations: [] });
    await extractClause(client, doc, clause, template, settings);
    expect(vi.mocked(chatJson).mock.calls[0][0].images).toBeUndefined();
  });

  // Task 16: a schema-valid but empty summary is a non-answer, not a
  // finding — see empty-review-investigation.md. A model with a genuine
  // answer, including "the document is silent on this point," always
  // writes something; an empty string must not be indistinguishable from
  // a real 'done' finding.
  it('reports an empty summary as an error finding, not done', async () => {
    vi.mocked(chatJson).mockResolvedValue({ summary: '', citations: [], risk_level: 'Low' });
    const finding = await extractClause(client, doc, clause, template, settings);
    expect(finding.status).toBe('error');
    expect(finding.noContent).toBe(true);
    expect(finding.error).toMatch(/no content/i);
  });

  it('reports a whitespace-only summary as an error finding, not done', async () => {
    vi.mocked(chatJson).mockResolvedValue({ summary: '   \n\t  ', citations: [] });
    const finding = await extractClause(client, doc, clause, template, settings);
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
    const finding = await extractClause(client, doc, clause, template, settings);
    expect(finding.citations).toEqual([{ quote: 'stray quote', documentId: 'd1' }]);
    expect(finding.riskLevel).toBe('High');
    expect(finding.riskAnalysis).toBe('stray analysis');
  });

  // The boundary this guard must not cross: a real summary describing a
  // clause that is genuinely absent from the document is a legitimate
  // finding, whether or not it has citations to back it up.
  it('treats a real summary with no citations as done (boundary: clause genuinely absent)', async () => {
    vi.mocked(chatJson).mockResolvedValue({ summary: 'The agreement is silent on this point.', citations: [] });
    const finding = await extractClause(client, doc, clause, template, settings);
    expect(finding.status).toBe('done');
    expect(finding.summary).toBe('The agreement is silent on this point.');
  });

  it('treats a real summary with citations as done', async () => {
    vi.mocked(chatJson).mockResolvedValue({ summary: 'Governed by English law.', citations: ['English law'] });
    const finding = await extractClause(client, doc, clause, template, settings);
    expect(finding.status).toBe('done');
  });

  it('reports a parse failure without calling the model', async () => {
    const broken: DocumentFile = { ...doc, text: '', parseError: 'corrupt file' };
    const finding = await extractClause(client, broken, clause, template, settings);
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
    const textOnly: WorkspaceSettings = { ...settings, modelSupportsImages: false };

    const finding = await extractClause(client, scan, clause, template, textOnly);

    expect(finding.status).toBe('error');
    expect(finding.error).toMatch(/scan/i);
    expect(finding.error).toMatch(/image/i);
    expect(chatJson).not.toHaveBeenCalled();
  });

  it('reports an error finding, without calling the model, for a scan with no page images at all', async () => {
    const blank: DocumentFile = { ...doc, text: '[Page 1]\n\n' };
    const finding = await extractClause(client, blank, clause, template, settings);
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
    const unknownCapabilities: WorkspaceSettings = { modelChoiceId: 'm', concurrency: 5 };

    const finding = await extractClause(client, scan, clause, template, unknownCapabilities);

    expect(finding.status).toBe('error');
    expect(chatJson).not.toHaveBeenCalled();
  });

  it('still reviews a mixed document, keeping the readable page and declining only what is unreadable', async () => {
    vi.mocked(chatJson).mockResolvedValue({ summary: 's', citations: [] });
    const mixed: DocumentFile = {
      ...doc,
      text: '[Page 1]\nThis is a perfectly readable cover page with real content.\n\n[Page 2]\nAB\n\n',
    };

    const finding = await extractClause(client, mixed, clause, template, settings);

    expect(finding.status).toBe('done');
    const prompt = vi.mocked(chatJson).mock.calls[0][0].user as string;
    expect(prompt).toContain('readable cover page');
    expect(prompt).not.toContain('AB');
  });

  it('reports an empty-document error finding for a DOCX mammoth resolved to no text (Critical 2)', async () => {
    const empty: DocumentFile = { id: 'd2', name: 'blank.docx', kind: 'docx', text: '', file: new File([''], 'blank.docx') };
    const finding = await extractClause(client, empty, clause, template, settings);
    expect(finding.status).toBe('error');
    expect(finding.error).toMatch(/no readable text or images/i);
    expect(chatJson).not.toHaveBeenCalled();
  });

  it('reports an empty-document error finding for any text-free document, not only a parse failure', async () => {
    const empty: DocumentFile = { ...doc, text: '   ' };
    const finding = await extractClause(client, empty, clause, template, settings);
    expect(finding.status).toBe('error');
    expect(chatJson).not.toHaveBeenCalled();
  });
});

describe('extractClause: structured output capability', () => {
  it('sends the JSON schema when the model advertises structured output support', async () => {
    vi.mocked(chatJson).mockResolvedValue({ summary: 's', citations: [] });
    await extractClause(client, doc, clause, template, { ...settings, modelSupportsStructuredOutput: true });
    expect(vi.mocked(chatJson).mock.calls[0][0].jsonSchema).toBe(CLAUSE_SCHEMA);
  });

  it('omits the JSON schema when the model does not advertise structured output support', async () => {
    vi.mocked(chatJson).mockResolvedValue({ summary: 's', citations: [] });
    await extractClause(client, doc, clause, template, { ...settings, modelSupportsStructuredOutput: false });
    expect(vi.mocked(chatJson).mock.calls[0][0].jsonSchema).toBeUndefined();
  });

  it('omits the JSON schema when structured-output support is unknown', async () => {
    vi.mocked(chatJson).mockResolvedValue({ summary: 's', citations: [] });
    const unknown: WorkspaceSettings = { modelChoiceId: 'm', concurrency: 5 };
    await extractClause(client, doc, clause, template, unknown);
    expect(vi.mocked(chatJson).mock.calls[0][0].jsonSchema).toBeUndefined();
  });
});

describe('extractClause: context budget (Important 9)', () => {
  it('truncates document text to the model\'s context budget and flags the finding as truncated', async () => {
    vi.mocked(chatJson).mockResolvedValue({ summary: 's', citations: [] });
    const long: DocumentFile = { ...doc, text: 'x'.repeat(1000) };
    // contextLength 100 -> budget = floor(100 * 4 * 0.5) = 200 characters.
    const tightBudget: WorkspaceSettings = { ...settings, modelContextLength: 100 };

    const finding = await extractClause(client, long, clause, template, tightBudget);

    const prompt = vi.mocked(chatJson).mock.calls[0][0].user as string;
    expect(prompt).toContain('TRUNCATED');
    expect(finding.truncated).toBe(true);
  });

  it('does not flag a finding as truncated when the document fits the budget', async () => {
    vi.mocked(chatJson).mockResolvedValue({ summary: 's', citations: [] });
    const finding = await extractClause(client, doc, clause, template, settings);
    // Absence, not an undefined-valued key. `toBeUndefined` passes either
    // way, and `structuredClone` — how IndexedDB writes every record —
    // PRESERVES an undefined-valued key, so the persisted finding would read
    // to any `in` check as "truncation was recorded here" (CLAUDE.md).
    expect('truncated' in finding).toBe(false);
  });
});

describe('extractClause: auth errors and cancellation (Important 4 & 5)', () => {
  it('tags the finding as an auth error on a 401 from OpenRouter', async () => {
    vi.mocked(chatJson).mockRejectedValue(new ModelError('Your session has expired. Sign in again.', 'sign_in_required', 401));
    const finding = await extractClause(client, doc, clause, template, settings);
    expect(finding.status).toBe('error');
    expect(finding.authError).toBe(true);
  });

  it('does not tag an ordinary failure as an auth error', async () => {
    vi.mocked(chatJson).mockRejectedValue(new Error('rate limited'));
    const finding = await extractClause(client, doc, clause, template, settings);
    expect(finding.authError).toBeUndefined();
  });

  it('resolves an aborted request to a calm "cancelled" finding, not an error with a raw DOMException message', async () => {
    vi.mocked(chatJson).mockRejectedValue(new DOMException('The operation was aborted.', 'AbortError'));
    const finding = await extractClause(client, doc, clause, template, settings);
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

    const finding = await extractClause(client, pagedDoc, clause, template, settings);

    expect(finding.citations).toEqual([
      { quote: 'Liability is capped at the Charges.', documentId: 'doc-42', page: 2 },
    ]);
  });

  it('starts every finding unchecked with no notes', async () => {
    vi.mocked(chatJson).mockResolvedValue({ summary: 'Found it.', citations: [], risk_level: 'Low', risk_analysis: 'Fine.' });
    const finding = await extractClause(client, doc, clause, template, settings);
    expect(finding.verification).toEqual({ state: 'unchecked' });
    expect(finding.notes).toEqual([]);
  });

  it('starts an error finding unchecked too — a failure is not a judgement', async () => {
    const broken: DocumentFile = { ...doc, parseError: 'corrupt' };
    const finding = await extractClause(client, broken, clause, template, settings);
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
    const finding = await extractClause(client, doc7, clause, template, settings);
    expect(finding.citations).toEqual([
      { quote: 'The Supplier shall deliver.', documentId: 'doc-7', page: 1 },
    ]);
  });
});

// Task 6: evaluation against `clause.standardPosition` happens in this same
// extraction call. `normalisePositionOutcome` (Task 5) owns the actual rules
// for what counts as "unclear" or "no rationale" — these tests only check
// that `extractClause` calls it with the right raw values and spreads its
// result onto the right findings.
describe('extractClause: standard position evaluation (Task 6)', () => {
  it('records a deviation with its rationale', async () => {
    vi.mocked(chatJson).mockResolvedValue({
      summary: 'The lease gives 9 months.', citations: [], risk_level: 'Medium',
      risk_analysis: 'x', position_outcome: 'deviates', position_rationale: 'Nine months, not six.',
    });
    const f = await extractClause(client, doc, { ...clause, standardPosition: pos }, template, settings);
    expect(f.status).toBe('done');
    expect(f.positionOutcome).toBe('deviates');
    expect(f.positionRationale).toBe('Nine months, not six.');
  });

  it('leaves the outcome absent for a clause with no position', async () => {
    vi.mocked(chatJson).mockResolvedValue({
      summary: 'x', citations: [], risk_level: 'Low', risk_analysis: 'y',
      position_outcome: 'meets', position_rationale: 'z',
    });
    const f = await extractClause(client, doc, clause, template, settings);
    // The model volunteered an outcome for a clause with no house rule. It
    // is dropped, not recorded: there was nothing to compare against.
    expect('positionOutcome' in f).toBe(false);
    expect('positionRationale' in f).toBe(false);
  });

  it('records unclear when the model omits the outcome', async () => {
    vi.mocked(chatJson).mockResolvedValue({ summary: 'x', citations: [], risk_level: 'Low', risk_analysis: 'y' });
    const f = await extractClause(client, doc, { ...clause, standardPosition: pos }, template, settings);
    expect(f.positionOutcome).toBe('unclear');
  });

  it('keeps the outcome on a no-content finding', async () => {
    // A model that gave an outcome and an empty summary still gave an
    // outcome; dropping it would lose the one thing it did say.
    vi.mocked(chatJson).mockResolvedValue({
      summary: '  ', citations: [], risk_level: 'Low', risk_analysis: 'y',
      position_outcome: 'deviates', position_rationale: 'Nine months.',
    });
    const f = await extractClause(client, doc, { ...clause, standardPosition: pos }, template, settings);
    expect(f.status).toBe('error');
    expect(f.noContent).toBe(true);
    expect(f.positionOutcome).toBe('deviates');
    expect(f.positionRationale).toBe('Nine months.');
  });

  it('requires position_outcome/position_rationale in the schema only when the clause has a position', () => {
    expect(clauseSchema(clause)).toBe(CLAUSE_SCHEMA);
    const withPos = clauseSchema({ ...clause, standardPosition: pos });
    expect(withPos).not.toBe(CLAUSE_SCHEMA);
    expect(withPos.required).toContain('position_outcome');
    expect(withPos.required).toContain('position_rationale');
  });

  it('sends the position-aware schema to the model when the clause has a standard position', async () => {
    vi.mocked(chatJson).mockResolvedValue({
      summary: 'x', citations: [], position_outcome: 'meets', position_rationale: 'y',
    });
    await extractClause(client, doc, { ...clause, standardPosition: pos }, template, settings);
    const sent = vi.mocked(chatJson).mock.calls[0][0].jsonSchema as { required: string[] };
    expect(sent).not.toBe(CLAUSE_SCHEMA);
    expect(sent.required).toContain('position_outcome');
  });
});
