import React from 'react';
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { DocumentFile, Finding, ReviewRun } from '../../types';
import { unchecked } from '@lexprompt/core';
import { mount } from '../../test/mount';
import { ReportView, REPORT_HEADINGS } from './ReportView';
import {
  exportSummaryLine, dispositionsAsAtLine, dispositionsMayChangeLine,
  exportDispositionLine, verificationLabel, truncationLabel,
  NO_EXPORT_CONTEXT, type ExportContext,
} from '../../lib/findingOutcome';
import { DISPOSITION_SHAPES, TEST_AUDIENCE } from '../../test/dispositionShapes';

/**
 * A THIRD RENDERER, SHOWING WHAT THE EXPORT WILL SAY (R-G11 discharged).
 *
 * Every assertion here compares the RENDER against the very function the
 * DOCX and the CSV call. That is the whole deliverable: not a new sentence
 * anywhere, so a reader can see on screen exactly what a DOCX read six weeks
 * later on a train will say.
 *
 * The one to break first is *"declares no display string of its own"*: the
 * DOCX and the CSV drifted apart once over a string of exactly this kind,
 * and a third surface writing its own wording would be the next instance.
 */

const AT = Date.UTC(2026, 7, 30, 16, 4);

const finding = (over: Partial<Finding> = {}): Finding => ({
  clauseId: 'c1',
  status: 'done',
  summary: 'Liability is capped at the fees paid in the preceding 12 months.',
  riskLevel: 'High',
  riskAnalysis: 'The cap is uncapped for indirect loss.',
  citations: [{ quote: 'the Supplier shall not be liable', documentId: 'd1' }],
  notes: [],
  verification: unchecked(),
  ...over,
});

const RUN: ReviewRun = {
  id: 'r1',
  matterId: 'm1',
  templateSnapshot: {
    id: 'p1',
    name: 'Ashcroft lease review',
    contractType: 'Lease',
    systemPrompt: 's',
    formatPrompt: 'f',
    clauses: [
      { id: 'c1', title: 'Liability cap', extractPrompt: 'x' },
      { id: 'c2', title: 'Governing law', extractPrompt: 'x' },
    ],
  },
  documentIds: ['d1'],
  target: { kind: 'documents', documentIds: ['d1'] },
  findings: { d1: { c1: finding(), c2: finding({ clauseId: 'c2', status: 'error', error: 'nope' }) } },
  modelId: 'm',
  startedAt: AT,
} as unknown as ReviewRun;

const DOCUMENTS: DocumentFile[] = [
  { id: 'd1', name: 'Ashcroft headlease.pdf' } as unknown as DocumentFile,
];

const CONTEXT: ExportContext = {
  readAt: AT,
  timeZone: 'Europe/London',
  dispositionOf: (_key, clauseId) =>
    (clauseId === 'c1' ? DISPOSITION_SHAPES['verified once'] : undefined),
  audience: TEST_AUDIENCE,
};

const view = (over: Partial<React.ComponentProps<typeof ReportView>> = {}) => (
  <ReportView run={RUN} documents={DOCUMENTS} exportContext={CONTEXT} {...over} />
);

describe('it renders the export s own words, and never its own', () => {
  it('renders the same summary line the export writes', () => {
    const c = mount(view());
    expect(c.textContent).toContain(exportSummaryLine(RUN.findings));
  });

  it('renders the as-at instant and the can-change sentence, verbatim', () => {
    const c = mount(view());
    expect(c.textContent).toContain(dispositionsAsAtLine(CONTEXT.readAt, CONTEXT.timeZone));
    expect(c.textContent).toContain(dispositionsMayChangeLine());
  });

  it('says "not recorded" loudly when nothing was read, exactly as the export does', () => {
    // `NO_EXPORT_CONTEXT` is the deliberate LOUD fallback. A report built
    // without a real context must say so on its first line rather than
    // looking finished, which is §19's worst-consequence failure and is
    // completely silent.
    const c = mount(view({ exportContext: NO_EXPORT_CONTEXT }));
    expect(c.textContent).toContain(dispositionsAsAtLine(undefined, 'UTC'));
    expect(c.textContent).toMatch(/not recorded/);
  });

  it('renders each clause s disposition line through exportDispositionLine', () => {
    const c = mount(view());
    const line = exportDispositionLine(CONTEXT, 'd1', 'c1')!;
    expect(line).toBeDefined();
    expect(c.querySelector('[data-report-disposition]')?.textContent).toBe(line);
  });

  it('never shows a disposition without its actor and its time', () => {
    const c = mount(view());
    const text = c.textContent ?? '';
    // The chip on a card says the state; a document read on a train has to
    // say who put it there. `Verified` with nothing after it is the
    // network-era form of the CSV that wrote unreviewed clauses as blanks.
    expect(text).not.toMatch(/Verified(?!\s+by)/);
    expect(text).toContain('A. Trainee');
    // …and the instant, which is the other half of "who and when".
    expect(text).toMatch(/\d\d:\d\d/);
  });

  it('carries the caveat for a clause that could not be reviewed', () => {
    const c = mount(view());
    const label = verificationLabel(RUN.findings.d1.c2)!;
    expect(label).toBeTruthy();
    expect(c.textContent).toContain(label);
    // …and the failed clause is RENDERED rather than dropped. A report that
    // omits a failed clause reads as "checked, nothing found".
    expect(c.textContent).toContain('Governing law');
  });

  it('renders the truncation caveat when the source was cut short', () => {
    const truncated = {
      ...RUN,
      findings: {
        d1: {
          c1: finding({ truncatedDocumentIds: ['d1'] } as Partial<Finding>),
          c2: finding({ clauseId: 'c2' }),
        },
      },
    } as unknown as ReviewRun;
    const label = truncationLabel(truncated.findings.d1.c1);
    const c = mount(view({ run: truncated }));
    if (label) expect(c.textContent).toContain(label);
    // Whatever `truncationLabel` decides, the view shows THAT and nothing of
    // its own — asserted here rather than asserting a string this test made
    // up, which would be a fourth wording site with a test agreeing with it.
    expect(c.querySelector('[data-report-truncation]')?.textContent ?? null)
      .toBe(label ?? null);
  });

  it('renders the citations, quoted, so the evidence travels with the finding', () => {
    const c = mount(view());
    expect(c.querySelector('[data-report-citation]')?.textContent)
      .toBe('the Supplier shall not be liable');
  });
});

describe('it declares no display string of its own', () => {
  const source = (): string => readFileSync(
    path.join(process.cwd(), 'src/features/review/ReportView.tsx'), 'utf8');

  /**
   * Every JSX text node with a letter in it — i.e. prose that arrived as
   * markup rather than through a function.
   *
   * Comments are stripped first, or the docstring above the component is
   * reported as rendered text. Attribute values are invisible to this by
   * construction: they sit inside a tag, and this only reads what is
   * BETWEEN tags.
   */
  const jsxTextIn = (code: string): string[] => {
    const stripped = code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/[^\n]*$/gm, '');
    return [...stripped.matchAll(/>\s*([^<>{}]*[A-Za-z]{2,}[^<>{}]*?)\s*</g)]
      .map(m => m[1].trim())
      .filter(t => t.length > 0);
  };

  it('has no bare text anywhere in its JSX', () => {
    // A sentence cannot arrive as markup: every rendered string comes
    // through an expression, and every expression comes from
    // `findingOutcome.ts` or from `HEADINGS`.
    expect(jsxTextIn(source())).toEqual([]);
    // THE SANITY HALF: the extractor finds bare text in a file that HAS
    // some. A scanner that matched nothing would satisfy the line above
    // while checking nothing. `AssignPanel` renders "Send the request" as
    // markup, which is fine there — it is a control's label, not a claim
    // about a contract.
    const panel = readFileSync(
      path.join(process.cwd(), 'src/features/assignments/AssignPanel.tsx'), 'utf8');
    expect(jsxTextIn(panel)).toContain('Send the request');
  });

  it('declares only short HEADINGS, which name a field rather than state a fact', () => {
    // A heading is a column label. The moment one grows a full stop or a
    // clause, it has become a sentence, and a sentence belongs in
    // `findingOutcome.ts` where the DOCX and the CSV can read it too.
    for (const label of Object.values(REPORT_HEADINGS)) {
      expect(label, label).not.toMatch(/[.;]/);
      expect(label.split(' ').length, label).toBeLessThanOrEqual(4);
    }
  });

  it('holds none of the export wording that lives in findingOutcome.ts', () => {
    // COMMENTS STRIPPED. This file's own docstrings QUOTE the export's
    // wording, deliberately — that is how a reader learns which sentence is
    // borrowed from where — and a raw text scan would report the
    // explanation as a violation of the rule it explains, which is the
    // failure `configSurface.test.ts`'s `codeOf` exists to avoid.
    const src = source()
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/[^\n]*$/gm, '');
    const home = readFileSync(
      path.join(process.cwd(), 'src/lib/findingOutcome.ts'), 'utf8');
    for (const fragment of [
      'Dispositions as at', 'can be changed by any reviewer', 'could not be reviewed',
      'Checked state not read', 'findings:', ' verified, ',
    ]) {
      // Present in exactly one home…
      expect(home, fragment).toContain(fragment);
      // …and not a second time here.
      expect(src, fragment).not.toContain(fragment);
    }
  });

  it('borrows the three opening lines by NAME, so a rewrite reaches this view too', () => {
    const src = source();
    for (const fn of ['exportSummaryLine', 'dispositionsAsAtLine', 'dispositionsMayChangeLine']) {
      expect(src, fn).toContain(fn);
    }
  });
});

describe('it is the third renderer and not a third pipeline', () => {
  const source = (): string => readFileSync(
    path.join(process.cwd(), 'src/features/review/ReportView.tsx'), 'utf8');

  it('imports nothing from lib/api and fetches nothing', () => {
    // A report that fetched its own data would be the second pipeline
    // `CLAUDE.md`'s rule exists to forbid, and it would be the one place on
    // the screen showing something the cards beside it do not.
    expect(source()).not.toMatch(/from '.*lib\/api/);
    expect(source()).not.toMatch(/\bfetch\(/);
  });

  it('builds its rows with the SAME function the DOCX builds its tables from', () => {
    // Not a second derivation of the same rows. `buildReportRows` is where
    // the row-level decisions live — most importantly that a clause whose
    // extraction failed still gets a row that says so.
    expect(source()).toContain('buildReportRows');
  });

  it('keys a section through findingsKeyFor, never by a document id directly', () => {
    // A collection review produces ONE position per clause however many
    // documents fed it. Keying by a document would render an empty report.
    expect(source()).toContain('findingsKeyFor');
    expect(source()).not.toMatch(/run\.findings\[docId\]/);
  });
});
