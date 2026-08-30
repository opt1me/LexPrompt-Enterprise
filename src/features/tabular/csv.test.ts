import { describe, it, expect } from 'vitest';
import { escapeCsvField, buildTabularCsv } from './csv';
import { buildReportRows } from '../review/exportDocx';
import { positionOutcomeLabel } from '../../lib/findingOutcome';
import { unconfirmedPosition, confirmPosition, amendPosition } from '@lexprompt/core';
import type { DocumentFile, Finding, ReviewRun, PlaybookVersion, TrailStep } from '../../types';

function template(clauses: PlaybookVersion['clauses']): PlaybookVersion {
  return {
    id: 't1',
    name: 'Test template',
    contractType: 'NDA',
    systemPrompt: '',
    formatPrompt: '',
    clauses,
    playbookId: 'pb',
    version: 1,
    changeSummary: '',
    publishedAt: 0,
    publishedByUserId: '',
    schemaVersion: 6,
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
    { id: 'c1', title: 'Termination', extractPrompt: 'p1' },
    { id: 'c2', title: 'Liability, Cap', extractPrompt: 'p2' },
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
      templateSnapshot: template([{ id: 'clause-1', title: 'Clause', extractPrompt: 'p' }]),
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

  // Task 9: the net position labels must not drift between exporters any
  // more than the verification labels above may.
  const npTrail: TrailStep[] = [
    { documentId: 'd1', kind: 'original', effect: 'Break on 12 months notice.', citations: [] },
    { documentId: 'd2', kind: 'varies', effect: 'Notice cut to 6 months.', citations: [] },
  ];

  it('agrees with the DOCX exporter on the net position label', () => {
    const run = runWith({ 'clause-1': doneFinding({ summary: undefined, netPosition: unconfirmedPosition('Break on 6 months notice.', npTrail) }) });
    const label = buildReportRows(run, 'doc-1')[0].netPositionLabel;
    expect(label).toBe('UNCONFIRMED NET POSITION');
    const csv = buildTabularCsv(run, docs);
    expect(csv).toContain(`[${label}]`);
  });

  it('does not label a confirmed net position in either exporter', () => {
    const pos = confirmPosition(unconfirmedPosition('Break on 6 months notice.', npTrail), 'u1', 1);
    const run = runWith({ 'clause-1': doneFinding({ summary: undefined, netPosition: pos }) });
    expect(buildReportRows(run, 'doc-1')[0].netPositionLabel).toBeNull();
    expect(buildTabularCsv(run, docs)).not.toContain('UNCONFIRMED NET POSITION');
  });

  it('carries the derivation trail into the CSV text', () => {
    const run = runWith({ 'clause-1': doneFinding({ summary: undefined, netPosition: unconfirmedPosition('Break on 6 months notice.', npTrail) }) });
    const csv = buildTabularCsv(run, docs);
    // Each step names its DOCUMENT, not its id. Which document varied a
    // clause is the information a derivation carries — "varied by the deed
    // of variation" is the point, and a raw id says nothing to a reader
    // while looking like it should. Sub-project B shipped this exact defect
    // in note attribution and a browser check, not a test, caught it.
    expect(csv).toContain('Agreement One.pdf');
    expect(csv).toContain('Break on 12 months notice.');
    expect(csv).toContain('Agreement, Two.pdf');
    expect(csv).toContain('Notice cut to 6 months.');
    // And the internal ids do not leak into a client-facing export.
    expect(csv).not.toMatch(/\(d1\)/);
    expect(csv).not.toMatch(/\(d2\)/);
  });

  it('exports the human\'s amended text in the CSV, and says a person amended it', () => {
    const pos = amendPosition(unconfirmedPosition('Model draft position.', npTrail), 'Break on 3 months notice.', 'u1', 1);
    const run = runWith({ 'clause-1': doneFinding({ summary: undefined, netPosition: pos }) });
    const csv = buildTabularCsv(run, docs);
    expect(csv).toContain('Break on 3 months notice.');
    expect(csv).not.toContain('Model draft position.');
    expect(csv).toMatch(/amend.*person|person.*amend/i);
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

  // Task 11: exports carry the standard-position outcome and its rationale.
  // Absent is not zero — a clause that never carried a standard position
  // gets no caveat at all, not a "meets" or "0 deviations" reading.
  it('carries the deviation label and its rationale into the cell', () => {
    const csv = buildTabularCsv(
      runWith({ 'clause-1': doneFinding({
        summary: 'The lease gives 9 months.',
        positionOutcome: 'deviates', positionRationale: 'Nine months, not six.',
      }) }),
      [doc('doc-1', 'Lease.pdf')],
    );
    expect(csv).toContain('DEVIATES FROM OUR STANDARD POSITION');
    expect(csv).toContain('Nine months, not six.');
  });

  it('adds no position caveat to a clause that never had a position', () => {
    const csv = buildTabularCsv(runWith({ 'clause-1': doneFinding({ summary: 'x' }) }), [doc('doc-1', 'Lease.pdf')]);
    expect(csv).not.toMatch(/STANDARD POSITION/);
  });

  // The drift guard: the DOCX and the CSV have silently disagreed on export
  // wording before, which is why `positionOutcomeLabel` lives in
  // `findingOutcome.ts` rather than being composed separately in each.
  it('the DOCX and the CSV use the same wording for the same finding', () => {
    const finding = doneFinding({
      summary: 'The lease gives 9 months.',
      positionOutcome: 'deviates', positionRationale: 'Nine months, not six.',
    });
    const label = positionOutcomeLabel(finding)!;
    const r = runWith({ 'clause-1': finding });
    expect(buildTabularCsv(r, [doc('doc-1', 'Lease.pdf')])).toContain(label);
    expect(buildReportRows(r, 'doc-1', { 'doc-1': 'Lease.pdf' }).flatMap(row => Object.values(row)).join(' '))
      .toContain(label);
  });

  // M1 (final review). Two defects, one test each way round:
  //
  //  - Step 0's: the CSV keyed `run.findings` by the raw document id, so a
  //    collection review's cells all read "not yet reviewed" even though the
  //    collection genuinely produced an answer. Findings live under the
  //    COLLECTION key (`findingsKeyFor`).
  //  - M1's: the fix above was applied per document row, so the same single
  //    synthesised position was emitted once per member document, under that
  //    member's own name in the Document column. `TabularReview` refuses to
  //    render exactly that and says why in its own doc comment — "repeat the
  //    same synthesised answer under every member document's name
  //    (misleading ... implying a per-document disagreement that was never
  //    assessed)" — and the CSV must not do what its sibling declares
  //    unacceptable. THE DUPLICATION WAS THE DEFECT: a reader filtering this
  //    sheet by document read a synthesis as a per-document finding, saying
  //    of the deed of variation something only the lease and the deed
  //    together say. Do not "restore" the per-document rows.
  describe('a collection review', () => {
    const collectionRun: ReviewRun = {
      id: 'run-coll',
      templateSnapshot: tmpl,
      documentIds: ['lease', 'deed'],
      target: { kind: 'collection', collectionId: 'coll-1', documentIds: ['lease', 'deed'] },
      findings: {
        'coll-1': {
          c1: { clauseId: 'c1', status: 'done', summary: 'Break on 6 months notice, as amended.', citations: [], verification: { state: 'unchecked' }, notes: [] },
          c2: { clauseId: 'c2', status: 'done', summary: 'Uncapped.', citations: [], verification: { state: 'unchecked' }, notes: [] },
        },
      },
      startedAt: 0,
    };
    const collectionDocs: DocumentFile[] = [doc('lease', 'Lease.pdf'), doc('deed', 'Deed of Variation.pdf')];

    it('reads its findings from the COLLECTION key rather than each document id', () => {
      const csv = buildTabularCsv(collectionRun, collectionDocs);
      expect(csv).toContain('Break on 6 months notice, as amended.');
      expect(csv).not.toContain('not yet reviewed');
    });

    it('emits ONE row, not one per member document', () => {
      const csv = buildTabularCsv(collectionRun, collectionDocs);
      const [, , ...body] = csv.split('\r\n');
      expect(body).toHaveLength(1);
    });

    it("labels that row with the collection, never with a member document's name", () => {
      const csv = buildTabularCsv(collectionRun, collectionDocs);
      const [, , row] = csv.split('\r\n');
      // The identity of what was reviewed — both members named, as a
      // collection, so the row cannot be read as one document's answer.
      expect(row.startsWith('"Collection: Lease.pdf + Deed of Variation.pdf"')).toBe(true);
    });

    it('names an unresolvable member in words rather than printing its raw id', () => {
      const csv = buildTabularCsv(collectionRun, [doc('lease', 'Lease.pdf')]);
      const [, , row] = csv.split('\r\n');
      expect(row).toContain('Lease.pdf');
      expect(row).not.toContain('deed"');
      expect(row).toMatch(/unavailable/i);
    });

    // mn6. Truncation reached the card and neither export, so the DOCX a
    // client receives — and the CSV a reviewer sorts — said nothing about a
    // deed of variation the model only read half of. Spec §11 names exactly
    // that as the way a collection produces a confidently wrong answer.
    it('carries a truncation caveat, naming the documents that were cut short', () => {
      const truncatedRun: ReviewRun = {
        ...collectionRun,
        findings: {
          'coll-1': {
            ...collectionRun.findings['coll-1'],
            c1: {
              ...collectionRun.findings['coll-1'].c1,
              truncated: true,
              truncatedDocuments: ['Deed of Variation.pdf'],
            },
          },
        },
      };
      const csv = buildTabularCsv(truncatedRun, collectionDocs);
      const [, , row] = csv.split('\r\n');
      expect(row).toMatch(/incomplete/i);
      expect(row).toContain('Deed of Variation.pdf');
    });

    it('agrees with its own summary line about how many findings there are', () => {
      const csv = buildTabularCsv(collectionRun, collectionDocs);
      const [summary, , ...body] = csv.split('\r\n');
      // The summary counts the collection key once per clause (2). The body
      // must contain that many clause cells — one row of 2, not two rows of
      // 2. This is the tell that caught M1: "5 findings" over a 10-cell
      // table.
      expect(summary).toContain('2 findings');
      const cells = body.length * tmpl.clauses.length;
      expect(cells).toBe(2);
    });
  });
});
