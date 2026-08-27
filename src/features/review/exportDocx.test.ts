import { describe, it, expect } from 'vitest';
// `jszip` is a transitive dependency (pulled in via `docx`, not declared in
// this project's own package.json) used only here, to unzip the generated
// .docx buffer so a test can read its raw XML. If a future `docx` version
// bump drops it, this import fails loudly at test collection time — not a
// silent wrong answer — and the fix is to add it to devDependencies then.
import JSZip from 'jszip';
import { buildReportRows, buildReportDocument } from './exportDocx';
import type { Finding, ReviewRun, Template } from '../../types';

const template: Template = {
  id: 't', name: 'T', contractType: 'NDA', mode: 'risk',
  systemPrompt: '', formatPrompt: '',
  clauses: [
    { id: 'clause-1', title: 'Term', prompt: '' },
    { id: 'c2', title: 'Law', prompt: '' },
  ],
  createdAt: 0, updatedAt: 0, schemaVersion: 2,
};

const run: ReviewRun = {
  id: 'r', templateSnapshot: template, documentIds: ['d1'],
  findings: {
    d1: {
      'clause-1': {
        clauseId: 'clause-1', status: 'done', summary: 'Three years.',
        citations: [{ quote: 'a term of three years', documentId: 'd1' }],
        riskLevel: 'Low', riskAnalysis: 'Standard.',
        verification: { state: 'unchecked' }, notes: [],
      },
      c2: { clauseId: 'c2', status: 'error', citations: [], error: 'timed out', verification: { state: 'unchecked' }, notes: [] },
    },
  },
  startedAt: 0,
};

describe('buildReportRows', () => {
  it('emits one row per clause in template order', () => {
    expect(buildReportRows(run, 'd1').map(r => r.title)).toEqual(['Term', 'Law']);
  });

  it('carries summary, risk and citations through', () => {
    const row = buildReportRows(run, 'd1')[0];
    expect(row.summary).toBe('Three years.');
    expect(row.riskLevel).toBe('Low');
    expect(row.citations).toEqual([{ quote: 'a term of three years', documentId: 'd1' }]);
  });

  it('renders a failed clause honestly rather than as an empty finding', () => {
    const row = buildReportRows(run, 'd1')[1];
    expect(row.summary).toMatch(/not (be )?review/i);
    expect(row.summary).toMatch(/timed out/);
  });

  it('marks a clause with no citations', () => {
    const noCite: ReviewRun = {
      ...run,
      findings: {
        d1: {
          'clause-1': { clauseId: 'clause-1', status: 'done', summary: 's', citations: [], verification: { state: 'unchecked' }, notes: [] },
          c2: run.findings.d1.c2,
        },
      },
    };
    expect(buildReportRows(noCite, 'd1')[0].citations).toEqual([]);
  });

  it('returns an empty list for an unknown document', () => {
    expect(buildReportRows(run, 'nope')).toEqual([]);
  });

  function doneFinding(overrides: Partial<Finding> = {}): Finding {
    return {
      clauseId: 'clause-1',
      status: 'done',
      summary: 'Capped at the Charges.',
      citations: [],
      verification: { state: 'unchecked' },
      notes: [],
      ...overrides,
    };
  }

  function runWith(findings: Record<string, Finding>): ReviewRun {
    return {
      id: 'run-1',
      templateSnapshot: template,
      documentIds: ['doc-1'],
      findings: { 'doc-1': findings },
      startedAt: 1,
    };
  }

  it('carries a verification label onto every row that needs one', () => {
    const run = runWith({ 'clause-1': doneFinding({ verification: { state: 'unchecked' } }) });
    const [row] = buildReportRows(run, 'doc-1');
    expect(row.verificationLabel).toBe('UNVERIFIED AI OUTPUT');
  });

  it('includes a rejected finding with its reason rather than dropping it', () => {
    const run = runWith({
      'clause-1': doneFinding({
        summary: 'Cap is 100% of Charges.',
        verification: { state: 'rejected', reason: 'Cites the indemnity' },
      }),
    });
    const [row] = buildReportRows(run, 'doc-1');
    expect(row.summary).toContain('Cap is 100% of Charges.');
    expect(row.verificationLabel).toBe('REJECTED: Cites the indemnity');
  });

  it('leaves a verified row unlabelled', () => {
    const run = runWith({ 'clause-1': doneFinding({ verification: { state: 'verified', byUserId: 'u', at: 1 } }) });
    expect(buildReportRows(run, 'doc-1')[0].verificationLabel).toBeNull();
  });

  it('labels an unreviewed clause as unverified too', () => {
    const run = runWith({});
    const [row] = buildReportRows(run, 'doc-1');
    expect(row.summary).toContain('could not be reviewed');
    expect(row.verificationLabel).toBe('UNVERIFIED AI OUTPUT');
  });

  it('renders each citation with its page pin', () => {
    const run = runWith({
      'clause-1': doneFinding({
        citations: [{ quote: 'Capped at the Charges.', documentId: 'doc-1', page: 4 }],
      }),
    });
    expect(buildReportRows(run, 'doc-1')[0].citations[0]).toEqual({
      quote: 'Capped at the Charges.', documentId: 'doc-1', page: 4,
    });
  });

  // `buildReportRows` only proves the label reaches the intermediate
  // `ReportRow[]`; it can't see whether the docx table-building loop
  // actually renders that label into the document. This packs the real
  // `docx` Document and reads the generated word/document.xml straight out
  // of the zip, so a row whose verification label never makes it into the
  // table (e.g. the row being dropped, or a wrong condition on it) is
  // caught here even though every `buildReportRows` assertion still passes.
  it('carries the verification label from a row into the generated docx XML', async () => {
    const run = runWith({ 'clause-1': doneFinding({ verification: { state: 'unchecked' } }) });
    const rows = buildReportRows(run, 'doc-1');

    const doc = await buildReportDocument(rows, 'doc-1', 'stub summary line');
    const { Packer } = await import('docx');
    const buffer = await Packer.toBuffer(doc);
    const zip = await JSZip.loadAsync(buffer);
    const xml = await zip.file('word/document.xml')?.async('string');

    expect(xml).toContain('UNVERIFIED AI OUTPUT');
  });

  // A rejection is the one label that carries human-authored text (the
  // reason) into a document that leaves the building — spec section 6: a
  // rejected finding is exported WITH its reason, never omitted. Asserting
  // on the reason string itself, not just the "REJECTED:" prefix, is the
  // point: a bug that renders the prefix but drops the reason would pass a
  // prefix-only check while still failing the actual requirement.
  it('carries a rejection reason from a row into the generated docx XML', async () => {
    const run = runWith({
      'clause-1': doneFinding({
        verification: { state: 'rejected', reason: 'Cites the indemnity, not the cap' },
      }),
    });
    const rows = buildReportRows(run, 'doc-1');

    const doc = await buildReportDocument(rows, 'doc-1', 'stub summary line');
    const { Packer } = await import('docx');
    const buffer = await Packer.toBuffer(doc);
    const zip = await JSZip.loadAsync(buffer);
    const xml = await zip.file('word/document.xml')?.async('string');

    expect(xml).toContain('REJECTED:');
    expect(xml).toContain('Cites the indemnity, not the cap');
  });
});
