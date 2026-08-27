import { describe, it, expect } from 'vitest';
import { escapeCsvField, buildTabularCsv } from './csv';
import { buildReportRows } from '../review/exportDocx';
import type { DocumentFile, Finding, ReviewRun, Template } from '../../types';

function template(clauses: Template['clauses']): Template {
  return {
    id: 't1',
    name: 'Test template',
    contractType: 'NDA',
    mode: 'extraction',
    systemPrompt: '',
    formatPrompt: '',
    clauses,
    createdAt: 0,
    updatedAt: 0,
    schemaVersion: 2,
  };
}

function doc(id: string, name: string): DocumentFile {
  return { id, name, text: '', file: new File([], name), kind: 'txt' };
}

describe('escapeCsvField', () => {
  it('wraps a plain field in double quotes', () => {
    expect(escapeCsvField('hello')).toBe('"hello"');
  });

  it('doubles internal double quotes', () => {
    expect(escapeCsvField('she said "hi"')).toBe('"she said ""hi"""');
  });

  it('leaves a comma untouched inside the quotes (the quoting is what protects it)', () => {
    expect(escapeCsvField('rent, due monthly')).toBe('"rent, due monthly"');
  });

  it('leaves embedded newlines untouched inside the quotes', () => {
    expect(escapeCsvField('line one\nline two')).toBe('"line one\nline two"');
  });

  it('handles an empty string', () => {
    expect(escapeCsvField('')).toBe('""');
  });

  describe('formula injection guard', () => {
    it('prefixes a field starting with "=" with an apostrophe', () => {
      expect(escapeCsvField('=SUM(A1:A9)')).toBe('"\'=SUM(A1:A9)"');
    });

    it('prefixes a field starting with "+" with an apostrophe', () => {
      expect(escapeCsvField('+1 555 0100')).toBe('"\'+1 555 0100"');
    });

    it('prefixes a field starting with "-" with an apostrophe (the rent-summary case)', () => {
      expect(escapeCsvField('-1,000 per annum')).toBe('"\'-1,000 per annum"');
    });

    it('prefixes a field starting with "@" with an apostrophe', () => {
      expect(escapeCsvField('@landlord terms')).toBe('"\'@landlord terms"');
    });

    it('does not touch a field where the lead character appears mid-string, not at the start', () => {
      expect(escapeCsvField('rent is -1,000 per annum')).toBe('"rent is -1,000 per annum"');
    });

    it('leaves a normal field with no leading formula character untouched', () => {
      expect(escapeCsvField('Auto-renews annually.')).toBe('"Auto-renews annually."');
    });

    it('still doubles internal quotes on a field that also needs the formula prefix', () => {
      expect(escapeCsvField('=A1 says "hi"')).toBe('"\'=A1 says ""hi"""');
    });
  });
});

describe('buildTabularCsv', () => {
  const clauses = [
    { id: 'c1', title: 'Termination', prompt: 'p1' },
    { id: 'c2', title: 'Liability, Cap', prompt: 'p2' },
  ];
  const tmpl = template(clauses);
  const docs = [doc('d1', 'Agreement One.pdf'), doc('d2', 'Agreement, Two.pdf')];

  function run(documentIds: string[], findings: ReviewRun['findings']): ReviewRun {
    return {
      id: 'r1',
      templateSnapshot: tmpl,
      documentIds,
      target: { kind: 'documents', documentIds },
      findings,
      startedAt: 0,
    };
  }

  it('writes a header row of clause titles prefixed by "Document"', () => {
    const csv = buildTabularCsv(run(['d1', 'd2'], { d1: {}, d2: {} }), docs);
    // Row 0 is the verification summary line (Ruling R-B4); the header
    // follows at row 1.
    const [, header] = csv.split('\r\n');
    expect(header).toBe('"Document","Termination","Liability, Cap"');
  });

  it('writes one row per document with the finding summaries', () => {
    const csv = buildTabularCsv(
      run(['d1', 'd2'], {
        d1: {
          c1: { clauseId: 'c1', status: 'done', summary: 'Auto-renews annually.', citations: [], verification: { state: 'unchecked' }, notes: [] },
          c2: { clauseId: 'c2', status: 'done', summary: 'Capped at fees paid.', citations: [], verification: { state: 'unchecked' }, notes: [] },
        },
        d2: {
          c1: { clauseId: 'c1', status: 'pending', citations: [], verification: { state: 'unchecked' }, notes: [] },
          c2: { clauseId: 'c2', status: 'error', error: 'boom', citations: [], verification: { state: 'unchecked' }, notes: [] },
        },
      }),
      docs,
    );
    const lines = csv.split('\r\n');
    expect(lines[2]).toBe('"Agreement One.pdf","[UNVERIFIED AI OUTPUT] Auto-renews annually.","[UNVERIFIED AI OUTPUT] Capped at fees paid."');
    // Critical 3: pending/error findings must NEVER become an empty field —
    // in a spreadsheet an empty cell reads as "checked, nothing found."
    expect(lines[3]).not.toBe('"Agreement, Two.pdf","",""');
    expect(lines[3]).toContain('This clause could not be reviewed: not yet reviewed');
    expect(lines[3]).toContain('This clause could not be reviewed: boom');
  });

  it('never exports a pending, cancelled or errored cell as a blank field (Critical 3)', () => {
    const csv = buildTabularCsv(
      run(['d1'], {
        d1: {
          c1: { clauseId: 'c1', status: 'pending', citations: [], verification: { state: 'unchecked' }, notes: [] },
          c2: { clauseId: 'c2', status: 'cancelled', citations: [], verification: { state: 'unchecked' }, notes: [] },
        },
      }),
      docs,
    );
    const dataLine = csv.split('\r\n')[2];
    expect(dataLine).not.toContain('""');
    expect(dataLine).toContain('This clause could not be reviewed: not yet reviewed');
    expect(dataLine).toContain('This clause could not be reviewed: the run was cancelled before this clause was reviewed');
  });

  it('reports an error with no message as "unknown error" rather than a blank field', () => {
    const csv = buildTabularCsv(
      run(['d1'], {
        d1: {
          c1: { clauseId: 'c1', status: 'error', citations: [], verification: { state: 'unchecked' }, notes: [] },
          c2: { clauseId: 'c2', status: 'done', summary: 'ok', citations: [], verification: { state: 'unchecked' }, notes: [] },
        },
      }),
      docs,
    );
    const dataLine = csv.split('\r\n')[2];
    expect(dataLine).toContain('This clause could not be reviewed: unknown error');
  });

  it('exports a missing finding (no entry at all for that clause) as "not yet reviewed", not blank', () => {
    const csv = buildTabularCsv(run(['d1'], { d1: {} }), docs);
    const dataLine = csv.split('\r\n')[2];
    expect(dataLine).not.toContain('""');
    expect(dataLine).toContain('This clause could not be reviewed: not yet reviewed');
  });

  it('does not let a comma in a summary split into extra columns', () => {
    const csv = buildTabularCsv(
      run(['d1'], {
        d1: {
          c1: { clauseId: 'c1', status: 'done', summary: 'Terminates on notice, 30 days.', citations: [], verification: { state: 'unchecked' }, notes: [] },
          c2: { clauseId: 'c2', status: 'done', summary: 'None.', citations: [], verification: { state: 'unchecked' }, notes: [] },
        },
      }),
      docs,
    );
    const dataLine = csv.split('\r\n')[2];
    // Splitting naively on comma would yield more than 3 fields; the quoted
    // field must keep the comma inside a single field.
    expect(dataLine).toBe('"Agreement One.pdf","[UNVERIFIED AI OUTPUT] Terminates on notice, 30 days.","[UNVERIFIED AI OUTPUT] None."');
  });

  it('escapes a summary containing double quotes', () => {
    const csv = buildTabularCsv(
      run(['d1'], {
        d1: {
          c1: { clauseId: 'c1', status: 'done', summary: 'The "Term" is 5 years.', citations: [], verification: { state: 'unchecked' }, notes: [] },
          c2: { clauseId: 'c2', status: 'done', summary: '', citations: [], verification: { state: 'unchecked' }, notes: [] },
        },
      }),
      docs,
    );
    const dataLine = csv.split('\r\n')[2];
    expect(dataLine).toBe('"Agreement One.pdf","[UNVERIFIED AI OUTPUT] The ""Term"" is 5 years.","[UNVERIFIED AI OUTPUT] "');
  });

  it('falls back to the document id when the document is not found in the documents array', () => {
    const csv = buildTabularCsv(run(['missing'], { missing: {} }), []);
    const lines = csv.split('\r\n');
    expect(lines[2]).toContain('"missing"');
    expect(lines[2]).toContain('This clause could not be reviewed: not yet reviewed');
  });

  it('joins rows with CRLF', () => {
    const csv = buildTabularCsv(run(['d1'], { d1: {} }), docs);
    expect(csv).toContain('\r\n');
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
      templateSnapshot: template([{ id: 'clause-1', title: 'Clause', prompt: 'p' }]),
      documentIds: ['doc-1'],
      target: { kind: 'documents', documentIds: ['doc-1'] },
      findings: { 'doc-1': findings },
      startedAt: 1,
    };
  }

  it('opens with a one-field summary row naming how many findings were verified', () => {
    const csv = buildTabularCsv(runWith({ 'clause-1': doneFinding({ verification: { state: 'verified' } }) }), docs);
    const [first] = csv.split('\r\n');
    expect(first).toBe('"1 findings: 1 verified, 0 unverified, 0 flagged, 0 rejected."');
  });

  it('prefixes an unverified cell so a spreadsheet cannot read it as checked', () => {
    const csv = buildTabularCsv(runWith({ 'clause-1': doneFinding({ verification: { state: 'unchecked' } }) }), docs);
    expect(csv).toContain('[UNVERIFIED AI OUTPUT]');
  });

  it('carries a rejection reason into the cell', () => {
    const csv = buildTabularCsv(
      runWith({ 'clause-1': doneFinding({ verification: { state: 'rejected', reason: 'Wrong clause' } }) }),
      docs,
    );
    expect(csv).toContain('[REJECTED: Wrong clause]');
  });

  it('leaves a verified cell unprefixed', () => {
    const csv = buildTabularCsv(runWith({ 'clause-1': doneFinding({ verification: { state: 'verified' } }) }), docs);
    expect(csv).not.toContain('[UNVERIFIED');
    expect(csv).not.toContain('[FLAGGED]');
  });

  it('still escapes a prefixed cell that would otherwise start a formula', () => {
    const csv = buildTabularCsv(
      runWith({ 'clause-1': doneFinding({ summary: '=1+1', verification: { state: 'verified' } }) }),
      docs,
    );
    expect(csv).toContain('"\'=1+1"');
  });

  it('agrees with the DOCX exporter on every label', () => {
    for (const state of ['unchecked', 'flagged', 'rejected', 'verified'] as const) {
      const verification = state === 'rejected' ? { state, reason: 'r' } : { state };
      const run = runWith({ 'clause-1': doneFinding({ verification }) });
      const label = buildReportRows(run, 'doc-1')[0].verificationLabel;
      const csv = buildTabularCsv(run, docs);
      if (label === null) continue;
      expect(csv).toContain(`[${label}]`);
    }
  });

  // Important 3 (spec §6: "a flagged finding carries its flag and any
  // note"). A note went missing from both exporters before this fix.
  it('carries a note into the cell', () => {
    const csv = buildTabularCsv(
      runWith({
        'clause-1': doneFinding({
          verification: { state: 'flagged' },
          notes: [{ id: 'n1', findingId: 'x', text: 'Confirm against the side letter.', byUserId: 'u1', at: 1 }],
        }),
      }),
      docs,
    );
    expect(csv).toContain('Confirm against the side letter.');
  });

  // The two exporters share `noteLines` via `findingOutcome.ts` for exactly
  // this reason: they must not be able to disagree about a note's text.
  it('agrees with the DOCX exporter on a note\'s text', () => {
    const run = runWith({
      'clause-1': doneFinding({
        verification: { state: 'flagged' },
        notes: [{ id: 'n1', findingId: 'x', text: 'Cross-check clause 14.2.', byUserId: 'u1', at: 1 }],
      }),
    });
    const docxNotes = buildReportRows(run, 'doc-1')[0].notes;
    const csv = buildTabularCsv(run, docs);
    expect(docxNotes).toEqual(['Note: Cross-check clause 14.2.']);
    for (const noteLine of docxNotes) {
      expect(csv).toContain(noteLine);
    }
  });
});
