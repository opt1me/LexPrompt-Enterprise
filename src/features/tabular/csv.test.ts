import { describe, it, expect } from 'vitest';
import { escapeCsvField, buildTabularCsv } from './csv';
import type { DocumentFile, ReviewRun, Template } from '../../types';

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
      findings,
      startedAt: 0,
    };
  }

  it('writes a header row of clause titles prefixed by "Document"', () => {
    const csv = buildTabularCsv(run(['d1', 'd2'], { d1: {}, d2: {} }), docs);
    const [header] = csv.split('\r\n');
    expect(header).toBe('"Document","Termination","Liability, Cap"');
  });

  it('writes one row per document with the finding summaries', () => {
    const csv = buildTabularCsv(
      run(['d1', 'd2'], {
        d1: {
          c1: { clauseId: 'c1', status: 'done', summary: 'Auto-renews annually.', citations: [] },
          c2: { clauseId: 'c2', status: 'done', summary: 'Capped at fees paid.', citations: [] },
        },
        d2: {
          c1: { clauseId: 'c1', status: 'pending', citations: [] },
          c2: { clauseId: 'c2', status: 'error', error: 'boom', citations: [] },
        },
      }),
      docs,
    );
    const lines = csv.split('\r\n');
    expect(lines[1]).toBe('"Agreement One.pdf","Auto-renews annually.","Capped at fees paid."');
    // Critical 3: pending/error findings must NEVER become an empty field —
    // in a spreadsheet an empty cell reads as "checked, nothing found."
    expect(lines[2]).not.toBe('"Agreement, Two.pdf","",""');
    expect(lines[2]).toContain('This clause could not be reviewed: not yet reviewed');
    expect(lines[2]).toContain('This clause could not be reviewed: boom');
  });

  it('never exports a pending, cancelled or errored cell as a blank field (Critical 3)', () => {
    const csv = buildTabularCsv(
      run(['d1'], {
        d1: {
          c1: { clauseId: 'c1', status: 'pending', citations: [] },
          c2: { clauseId: 'c2', status: 'cancelled', citations: [] },
        },
      }),
      docs,
    );
    const dataLine = csv.split('\r\n')[1];
    expect(dataLine).not.toContain('""');
    expect(dataLine).toContain('This clause could not be reviewed: not yet reviewed');
    expect(dataLine).toContain('This clause could not be reviewed: the run was cancelled before this clause was reviewed');
  });

  it('reports an error with no message as "unknown error" rather than a blank field', () => {
    const csv = buildTabularCsv(
      run(['d1'], { d1: { c1: { clauseId: 'c1', status: 'error', citations: [] }, c2: { clauseId: 'c2', status: 'done', summary: 'ok', citations: [] } } }),
      docs,
    );
    const dataLine = csv.split('\r\n')[1];
    expect(dataLine).toContain('This clause could not be reviewed: unknown error');
  });

  it('exports a missing finding (no entry at all for that clause) as "not yet reviewed", not blank', () => {
    const csv = buildTabularCsv(run(['d1'], { d1: {} }), docs);
    const dataLine = csv.split('\r\n')[1];
    expect(dataLine).not.toContain('""');
    expect(dataLine).toContain('This clause could not be reviewed: not yet reviewed');
  });

  it('does not let a comma in a summary split into extra columns', () => {
    const csv = buildTabularCsv(
      run(['d1'], {
        d1: {
          c1: { clauseId: 'c1', status: 'done', summary: 'Terminates on notice, 30 days.', citations: [] },
          c2: { clauseId: 'c2', status: 'done', summary: 'None.', citations: [] },
        },
      }),
      docs,
    );
    const dataLine = csv.split('\r\n')[1];
    // Splitting naively on comma would yield more than 3 fields; the quoted
    // field must keep the comma inside a single field.
    expect(dataLine).toBe('"Agreement One.pdf","Terminates on notice, 30 days.","None."');
  });

  it('escapes a summary containing double quotes', () => {
    const csv = buildTabularCsv(
      run(['d1'], {
        d1: {
          c1: { clauseId: 'c1', status: 'done', summary: 'The "Term" is 5 years.', citations: [] },
          c2: { clauseId: 'c2', status: 'done', summary: '', citations: [] },
        },
      }),
      docs,
    );
    const dataLine = csv.split('\r\n')[1];
    expect(dataLine).toBe('"Agreement One.pdf","The ""Term"" is 5 years.",""');
  });

  it('falls back to the document id when the document is not found in the documents array', () => {
    const csv = buildTabularCsv(run(['missing'], { missing: {} }), []);
    const lines = csv.split('\r\n');
    expect(lines[1]).toContain('"missing"');
    expect(lines[1]).toContain('This clause could not be reviewed: not yet reviewed');
  });

  it('joins rows with CRLF', () => {
    const csv = buildTabularCsv(run(['d1'], { d1: {} }), docs);
    expect(csv).toContain('\r\n');
  });
});
