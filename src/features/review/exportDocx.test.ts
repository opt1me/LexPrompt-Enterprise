import { describe, it, expect, vi } from 'vitest';
// `jszip` is a transitive dependency (pulled in via `docx`, not declared in
// this project's own package.json) used only here, to unzip the generated
// .docx buffer so a test can read its raw XML. If a future `docx` version
// bump drops it, this import fails loudly at test collection time — not a
// silent wrong answer — and the fix is to add it to devDependencies then.
import JSZip from 'jszip';
import { buildReportRows, buildReportDocument, exportDocx } from './exportDocx';
// Imported across features on purpose: this file carries the one test whose
// whole point is that the DOCX and the CSV cannot name a collection two
// different ways, and it cannot prove that without both of them.
import { buildTabularCsv } from '../tabular/csv';
import { collectionExportLabel } from '../../lib/findingOutcome';
import { unconfirmedPosition, confirmPosition, amendPosition } from '../../lib/netPosition';
import type { Finding, ReviewRun, PlaybookVersion, TrailStep } from '../../types';

/** jsdom has no `Blob.prototype.arrayBuffer` — see vitest.setup.ts's
 *  `Blob.prototype.text` polyfill for the same gap on the text side. Needed
 *  only by the `exportDocx` (not `buildReportDocument`) tests below, which
 *  exercise the real browser-download path end to end. */
function blobToArrayBuffer(blob: Blob): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(blob);
  });
}

const template: PlaybookVersion = {
  id: 't', name: 'T', contractType: 'NDA',
  systemPrompt: '', formatPrompt: '',
  clauses: [
    { id: 'clause-1', title: 'Term', extractPrompt: '' },
    { id: 'c2', title: 'Law', extractPrompt: '' },
  ],
  playbookId: 'pb', version: 1, changeSummary: '', publishedAt: 0, publishedByUserId: '', schemaVersion: 6,
};

const run: ReviewRun = {
  id: 'r', templateSnapshot: template, documentIds: ['d1'],
  target: { kind: 'documents', documentIds: ['d1'] },
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
      target: { kind: 'documents', documentIds: ['doc-1'] },
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

  // Important 3 (spec §6: "a flagged finding carries its flag and any
  // note"). See findingOutcome.test.ts for `noteLines` itself; this proves
  // the note actually reaches the generated docx XML, not just the
  // intermediate `ReportRow[]`.
  it('carries a note from a row into the generated docx XML', async () => {
    const run = runWith({
      'clause-1': doneFinding({
        verification: { state: 'flagged' },
        notes: [{ id: 'n1', findingId: 'x', text: 'Confirm against the side letter.', byUserId: 'u1', at: 1 }],
      }),
    });
    const rows = buildReportRows(run, 'doc-1');
    expect(rows[0].notes).toEqual(['Note: Confirm against the side letter.']);

    const doc = await buildReportDocument(rows, 'doc-1', 'stub summary line');
    const { Packer } = await import('docx');
    const buffer = await Packer.toBuffer(doc);
    const zip = await JSZip.loadAsync(buffer);
    const xml = await zip.file('word/document.xml')?.async('string');

    expect(xml).toContain('Confirm against the side letter.');
  });
});

// Important 4: the DOCX report is per-document (`buildReportRows(run,
// docId)`), so its header summary must count only that document's findings
// — not the whole run. Exercises `exportDocx` itself (not just
// `buildReportDocument`), because the bug lived in the one line that decides
// which findings the summary counts, not in row-building or rendering.
describe('exportDocx — header summary is scoped to the exported document (Important 4)', () => {
  const twoDocTemplate: PlaybookVersion = {
    id: 't2', name: 'T2', contractType: 'NDA',
    systemPrompt: '', formatPrompt: '',
    clauses: [{ id: 'c1', title: 'Term', extractPrompt: '' }],
    playbookId: 'pb', version: 1, changeSummary: '', publishedAt: 0, publishedByUserId: '', schemaVersion: 6,
  };

  function twoDocRun(): ReviewRun {
    return {
      id: 'r2', templateSnapshot: twoDocTemplate, documentIds: ['doc-a', 'doc-b'],
      target: { kind: 'documents', documentIds: ['doc-a', 'doc-b'] },
      findings: {
        // doc-a: one finding, verified.
        'doc-a': { c1: { clauseId: 'c1', status: 'done', summary: 'a', citations: [], verification: { state: 'verified', byUserId: 'u', at: 1 }, notes: [] } },
        // doc-b: one finding, unchecked — if the summary were run-wide, this
        // would drag doc-a's "1 verified" report down to "1 of 2 verified".
        'doc-b': { c1: { clauseId: 'c1', status: 'done', summary: 'b', citations: [], verification: { state: 'unchecked' }, notes: [] } },
      },
      startedAt: 0,
    };
  }

  /** jsdom implements neither `URL.createObjectURL` nor anchor-driven
   *  navigation; `exportDocx`'s download side effects are stubbed so the
   *  function itself — the thing that was actually wrong — can run
   *  end-to-end rather than only its `buildReportRows`/`buildReportDocument`
   *  pieces in isolation. */
  async function runExportAndReadXml(run: ReviewRun, docId: string, docName: string): Promise<string | undefined> {
    let capturedBlob: Blob | undefined;
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: (b: Blob) => { capturedBlob = b; return 'blob:stub'; },
      revokeObjectURL: () => {},
    });
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    try {
      await exportDocx(run, docId, docName, { [docId]: docName });
      expect(capturedBlob).toBeDefined();
      const buf = await blobToArrayBuffer(capturedBlob!);
      const zip = await JSZip.loadAsync(buf);
      return await zip.file('word/document.xml')?.async('string');
    } finally {
      clickSpy.mockRestore();
      vi.unstubAllGlobals();
    }
  }

  it('counts only the exported document, not the whole two-document run', async () => {
    const xml = await runExportAndReadXml(twoDocRun(), 'doc-a', 'docA.pdf');
    expect(xml).toContain('1 findings: 1 verified, 0 unverified, 0 flagged, 0 rejected.');
    // The whole-run wording this bug produced must be absent.
    expect(xml).not.toContain('2 findings: 1 verified, 1 unverified, 0 flagged, 0 rejected.');
  });

  it('scopes to whichever document is exported, not always the first', async () => {
    const xml = await runExportAndReadXml(twoDocRun(), 'doc-b', 'docB.pdf');
    expect(xml).toContain('1 findings: 0 verified, 1 unverified, 0 flagged, 0 rejected.');
  });
});

// Step 0: `buildReportRows` and `exportDocx` used to key `run.findings`
// directly by the document id passed in. A collection review stores its
// findings under the COLLECTION id (`findingsKeyFor`, Task 6A/8A) — so
// "Export DOCX" on a collection review silently produced a report with zero
// clause tables, no error at all. This is the founding defect (CLAUDE.md:
// a confidently-empty export reads as "checked, nothing found") reopened one
// screen over from where sub-project C already fixed it once (Task 8A, for
// `ResultsView`/`TabularReview`).
describe('buildReportRows / exportDocx — a collection review (Step 0)', () => {
  const collectionTemplate: PlaybookVersion = {
    id: 'tc', name: 'TC', contractType: 'Lease',
    systemPrompt: '', formatPrompt: '',
    clauses: [{ id: 'break', title: 'Break clause', extractPrompt: '' }],
    playbookId: 'pb', version: 1, changeSummary: '', publishedAt: 0, publishedByUserId: '', schemaVersion: 6,
  };

  function collectionRun(findings: ReviewRun['findings']): ReviewRun {
    return {
      id: 'run-coll',
      templateSnapshot: collectionTemplate,
      documentIds: ['lease', 'deed'],
      target: { kind: 'collection', collectionId: 'coll-1', documentIds: ['lease', 'deed'] },
      findings,
      startedAt: 0,
    };
  }

  it('reads a collection review\'s findings from the COLLECTION key, not the document id', () => {
    const run = collectionRun({
      'coll-1': {
        break: {
          clauseId: 'break', status: 'done', summary: 'Break on 6 months notice, as amended.',
          citations: [], verification: { state: 'unchecked' }, notes: [],
        },
      },
    });

    // Before the fix: run.findings['lease'] is undefined, so this returned [].
    const rows = buildReportRows(run, 'lease');
    expect(rows).not.toEqual([]);
    expect(rows[0].summary).toContain('Break on 6 months notice, as amended.');
  });

  it('exports real content to the generated DOCX bytes for a collection review', async () => {
    const run = collectionRun({
      'coll-1': {
        break: {
          clauseId: 'break', status: 'done', summary: 'Break on 6 months notice, as amended.',
          citations: [], verification: { state: 'unchecked' }, notes: [],
        },
      },
    });

    let capturedBlob: Blob | undefined;
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: (b: Blob) => { capturedBlob = b; return 'blob:stub'; },
      revokeObjectURL: () => {},
    });
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    try {
      await exportDocx(run, 'lease', 'Lease.pdf', { lease: 'Lease.pdf', deed: 'Deed of Variation.pdf' });
      expect(capturedBlob).toBeDefined();
      const buf = await blobToArrayBuffer(capturedBlob!);
      const zip = await JSZip.loadAsync(buf);
      const xml = await zip.file('word/document.xml')?.async('string');
      expect(xml).toContain('Break on 6 months notice, as amended.');
    } finally {
      clickSpy.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  // The fail-loudly rule, applied to the surface where it was originally
  // learned: an export that finds nothing at all must say so, not silently
  // hand back a technically-valid .docx with zero clause tables in it — a
  // document a lawyer could send without ever noticing it says nothing.
  it('refuses to export a document with no findings at all, rather than producing an empty report', async () => {
    const run = collectionRun({}); // No key for 'coll-1' at all.
    await expect(exportDocx(run, 'lease', 'Lease.pdf', { lease: 'Lease.pdf' })).rejects.toThrow(/no findings/i);
  });
});

// Net positions (Task 9, Step 1 onwards): a net position is synthesised text
// no single document contains, and the most dangerous output this app
// produces — it must never leave the app looking as settled as a human-
// checked answer, and its derivation (the trail) must travel with it, not
// just its conclusion.
describe('buildReportRows / exportDocx / buildReportDocument — net positions', () => {
  const netPositionTemplate: PlaybookVersion = {
    id: 'tnp', name: 'TNP', contractType: 'Lease',
    systemPrompt: '', formatPrompt: '',
    clauses: [{ id: 'break', title: 'Break clause', extractPrompt: '' }],
    playbookId: 'pb', version: 1, changeSummary: '', publishedAt: 0, publishedByUserId: '', schemaVersion: 6,
  };

  const trail: TrailStep[] = [
    { documentId: 'lease', kind: 'original', effect: 'Break on 12 months notice.', citations: [] },
    { documentId: 'deed', kind: 'varies', effect: 'Notice cut to 6 months.', citations: [{ quote: 'reduced to six months', documentId: 'deed' }] },
  ];

  function runWithNetPosition(finding: Finding): ReviewRun {
    return {
      id: 'run-np',
      templateSnapshot: netPositionTemplate,
      documentIds: ['lease', 'deed'],
      target: { kind: 'collection', collectionId: 'coll-np', documentIds: ['lease', 'deed'] },
      findings: { 'coll-np': { break: finding } },
      startedAt: 0,
    };
  }

  function doneCollectionFinding(overrides: Partial<Finding> = {}): Finding {
    return {
      clauseId: 'break', status: 'done', citations: [],
      verification: { state: 'unchecked' }, notes: [],
      netPosition: unconfirmedPosition('Break on 6 months notice.', trail),
      ...overrides,
    };
  }

  async function docXml(run: ReviewRun, docId: string): Promise<string | undefined> {
    const rows = buildReportRows(run, docId);
    const doc = await buildReportDocument(rows, docId, 'stub summary line');
    const { Packer } = await import('docx');
    const buffer = await Packer.toBuffer(doc);
    const zip = await JSZip.loadAsync(buffer);
    return zip.file('word/document.xml')?.async('string');
  }

  it('carries an unconfirmed net position onto the row, distinctly from verification', () => {
    const run = runWithNetPosition(doneCollectionFinding());
    const [row] = buildReportRows(run, 'lease');
    expect(row.netPositionLabel).toBe('UNCONFIRMED NET POSITION');
    // Independent axis: this finding's AI output is also unverified.
    expect(row.verificationLabel).toBe('UNVERIFIED AI OUTPUT');
    expect(row.summary).toBe('Break on 6 months notice.');
  });

  it('drops the caveat once a human confirms the position, but not the verification label', () => {
    const pos = confirmPosition(unconfirmedPosition('Break on 6 months notice.', trail), 'u1', 1);
    const run = runWithNetPosition(doneCollectionFinding({ netPosition: pos }));
    const [row] = buildReportRows(run, 'lease');
    expect(row.netPositionLabel).toBeNull();
  });

  // The derivation is exported, not just the conclusion: each trail step's
  // document and effect must reach the actual DOCX bytes.
  it('carries every trail step\'s document and effect into the generated DOCX XML', async () => {
    const run = runWithNetPosition(doneCollectionFinding());
    const xml = await docXml(run, 'lease');
    expect(xml).toContain('lease');
    expect(xml).toContain('Break on 12 months notice.');
    expect(xml).toContain('deed');
    expect(xml).toContain('Notice cut to 6 months.');
  });

  // mn6. See the CSV's twin test: an export that omits truncation lets a
  // net position derived from half a deed of variation read as one derived
  // from all of it.
  it('carries a truncation caveat, naming the cut documents, onto the row and into the XML', async () => {
    const run = runWithNetPosition(doneCollectionFinding({
      truncated: true,
      truncatedDocuments: ['Deed of Variation.pdf'],
    }));
    const [row] = buildReportRows(run, 'lease');
    expect(row.truncationLabel).toMatch(/incomplete/i);
    expect(row.truncationLabel).toContain('Deed of Variation.pdf');

    const xml = await docXml(run, 'lease');
    expect(xml).toMatch(/INCOMPLETE/);
    expect(xml).toContain('Deed of Variation.pdf');
  });

  it('raises no truncation caveat when the whole text fit', () => {
    const [row] = buildReportRows(runWithNetPosition(doneCollectionFinding()), 'lease');
    expect(row.truncationLabel).toBeNull();
  });

  it('carries the UNCONFIRMED NET POSITION label into the generated DOCX XML', async () => {
    const run = runWithNetPosition(doneCollectionFinding());
    const xml = await docXml(run, 'lease');
    expect(xml).toContain('UNCONFIRMED NET POSITION');
  });

  // An amended position exports the HUMAN text, and says a person wrote it —
  // not the model's original proposal, and not silently as though the model
  // had written every word.
  it('exports the human\'s amended text, and says it was amended by a person', async () => {
    const pos = amendPosition(unconfirmedPosition('Break on 6 months notice (model draft).', trail), 'Break on 3 months notice.', 'u1', 1);
    const run = runWithNetPosition(doneCollectionFinding({ netPosition: pos }));
    const [row] = buildReportRows(run, 'lease');
    expect(row.summary).toBe('Break on 3 months notice.');
    expect(row.summary).not.toContain('model draft');

    const xml = await docXml(run, 'lease');
    expect(xml).toContain('Break on 3 months notice.');
    expect(xml).not.toContain('model draft');
    expect(xml).toMatch(/amend.*person|person.*amend/i);
  });

  // Task 11: the standard-position comparison, distinct from every caveat
  // above. Absent is not zero, and `unclear` is not a deviation.
  it('carries a deviation label and its rationale onto the row', () => {
    const run = runWithNetPosition(doneCollectionFinding({
      positionOutcome: 'deviates', positionRationale: 'Nine months, not six.',
    }));
    const [row] = buildReportRows(run, 'lease');
    expect(row.positionOutcomeLabel).toBe('DEVIATES FROM OUR STANDARD POSITION');
    expect(row.positionRationale).toEqual(['Standard position rationale: Nine months, not six.']);
  });

  it('labels an unclear outcome distinctly from a deviation', () => {
    const run = runWithNetPosition(doneCollectionFinding({ positionOutcome: 'unclear' }));
    const [row] = buildReportRows(run, 'lease');
    expect(row.positionOutcomeLabel).toBe('UNCLEAR AGAINST OUR STANDARD POSITION');
  });

  it('raises no position caveat for a met position — a label there would be a caveat where there is none', () => {
    const run = runWithNetPosition(doneCollectionFinding({ positionOutcome: 'meets' }));
    const [row] = buildReportRows(run, 'lease');
    expect(row.positionOutcomeLabel).toBeNull();
  });

  it('raises no position caveat for a clause that never carried a standard position', () => {
    const run = runWithNetPosition(doneCollectionFinding());
    const [row] = buildReportRows(run, 'lease');
    expect(row.positionOutcomeLabel).toBeNull();
    expect(row.positionRationale).toEqual([]);
  });

  it('carries the deviation label and rationale into the generated DOCX XML', async () => {
    const run = runWithNetPosition(doneCollectionFinding({
      positionOutcome: 'deviates', positionRationale: 'Nine months, not six.',
    }));
    const xml = await docXml(run, 'lease');
    expect(xml).toContain('DEVIATES FROM OUR STANDARD POSITION');
    expect(xml).toContain('Nine months, not six.');
  });
});

// Found by the fix agent for C's final review, outside its own round: a
// collection's DOCX report was titled, filenamed and error-messaged after
// whichever document the viewer happened to be showing. That asserts that a
// synthesis drawn across every member belongs to one member — the same "a
// collection is not one of its members" shape as the CSV defect (M1) that
// emitted one identical row per document.
describe('exportDocx — a collection report is named after the collection', () => {
  function collectionRun(): ReviewRun {
    return {
      id: 'r1',
      templateSnapshot: { ...run.templateSnapshot, name: 'Lease Review' },
      documentIds: ['lease', 'deed'],
      target: { kind: 'collection', collectionId: 'coll-1', documentIds: ['lease', 'deed'] },
      findings: {
        'coll-1': {
          [run.templateSnapshot.clauses[0].id]: {
            clauseId: run.templateSnapshot.clauses[0].id, status: 'done',
            summary: 'The notice period is six months.',
            citations: [], verification: { state: 'unchecked' }, notes: [],
          },
        },
      },
      startedAt: 1,
    };
  }

  /** Mirrors this file's existing download-capture idiom (see the
   *  `vi.stubGlobal('URL', …)` blocks above) rather than inventing a second
   *  one — jsdom has no `URL.createObjectURL`. */
  async function capturedDownloadName(r: ReviewRun, docId: string, docName: string): Promise<string> {
    let name = '';
    vi.stubGlobal('URL', { createObjectURL: () => 'blob:stub', revokeObjectURL: () => {} });
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(function (this: HTMLAnchorElement) { name = this.download; });
    try {
      await exportDocx(r, docId, docName, { lease: 'Lease.pdf', deed: 'Deed.pdf', d1: 'MSA.pdf' });
    } finally {
      clickSpy.mockRestore();
      vi.unstubAllGlobals();
    }
    return name;
  }

  it('does not name the report after a member document', async () => {
    const name = await capturedDownloadName(collectionRun(), 'lease', 'Lease.pdf');
    expect(name).not.toMatch(/^Lease_Report/);
    // It names the collection: what it is, and which documents it is —
    // with each member's extension stripped, as a single-document report's
    // filename has always had its own stripped.
    expect(name).toMatch(/collection/i);
    expect(name).toContain('Lease');
    expect(name).toContain('Deed');
    expect(name).not.toContain('.pdf');
  });

  /**
   * mn4. The DOCX named the collection "<template name> - collection of N
   * linked documents", which identifies the TEMPLATE: two collections in one
   * matter under one playbook produced the same report title and the same
   * filename. It also counted `run.documentIds` blind, announcing "3 linked
   * documents" when one of them was gone. Both exporters now go through
   * `collectionExportLabel`, because two implementations of "how an export
   * names a collection" is the exact drift that produced M1 between these
   * same two files.
   */
  it('names the collection with the same words the CSV uses', async () => {
    const r = collectionRun();
    const names = { lease: 'Lease.pdf', deed: 'Deed.pdf' };
    const label = collectionExportLabel(r.documentIds, names);

    let capturedBlob: Blob | undefined;
    vi.stubGlobal('URL', {
      createObjectURL: (b: Blob) => { capturedBlob = b; return 'blob:stub'; },
      revokeObjectURL: () => {},
    });
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    let xml: string | undefined;
    try {
      await exportDocx(r, 'lease', 'Lease.pdf', names);
      const zip = await JSZip.loadAsync(await blobToArrayBuffer(capturedBlob!));
      xml = await zip.file('word/document.xml')?.async('string');
    } finally {
      clickSpy.mockRestore();
      vi.unstubAllGlobals();
    }

    expect(xml).toContain(label);
    // The same run, through the other exporter, says the same thing.
    const csv = buildTabularCsv(r, [
      { id: 'lease', name: 'Lease.pdf', kind: 'pdf', text: '', file: new File([''], 'Lease.pdf') },
      { id: 'deed', name: 'Deed.pdf', kind: 'pdf', text: '', file: new File([''], 'Deed.pdf') },
    ]);
    expect(csv).toContain(label);
  });

  // mn5. `docName` was always a filename; a collection label is assembled
  // from user-authored text and can carry characters no filesystem accepts.
  it('produces a path-safe filename from a collection label', async () => {
    const r = collectionRun();
    const name = await capturedDownloadName(r, 'lease', 'Lease.pdf');
    expect(name).not.toMatch(/[\/:*?"<>|]/);
    expect(name.endsWith('_Report.docx')).toBe(true);
  });

  it('still names a single-document report after its document', async () => {
    // The regression pin: the collection rule must not leak into the ordinary
    // path, which has always been named after the document it reports on.
    expect(await capturedDownloadName(run, 'd1', 'MSA.pdf')).toBe('MSA_Report.docx');
  });
});
