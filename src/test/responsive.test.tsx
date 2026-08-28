import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { mount, mountOnce, flushUntil, buttonNamed, click } from './mount';
import { collectScannableFiles } from './paletteScan';
import { TabularReview } from '../features/tabular/TabularReview';
import { ResultsView } from '../features/review/ResultsView';
import { PdfCanvas } from '../features/review/PdfCanvas';
import { Modal } from '../components/Modal';
import type { Finding, ReviewRun, DocumentFile, Settings } from '../types';

// pdf.js, faked just enough to render one page. `getViewport` reports a
// US Letter page (612pt wide) at whatever scale the component asks for, so
// every page width measured below is the width `PdfCanvas` itself chose —
// not a number this file picked.
vi.mock('../lib/documents', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/documents')>();
  const page = {
    getViewport: ({ scale }: { scale: number }) => ({ width: 612 * scale, height: 792 * scale }),
    render: () => ({ promise: Promise.resolve(), cancel: () => {} }),
  };
  const pdfjs = { getDocument: () => ({ promise: Promise.resolve({ numPages: 1, getPage: async () => page }) }) };
  return {
    ...actual,
    loadPdfjs: (async () => pdfjs) as unknown as typeof actual.loadPdfjs,
    readArrayBuffer: (async () => new ArrayBuffer(0)) as unknown as typeof actual.readArrayBuffer,
    extractPageText: (async () => []) as unknown as typeof actual.extractPageText,
  };
});

function finding(over: Partial<Finding> = {}): Finding {
  return { clauseId: 'c1', status: 'done', summary: 'A sentence.', citations: [], verification: { state: 'unchecked' }, notes: [], ...over };
}
function run(): ReviewRun {
  return {
    id: 'r1',
    templateSnapshot: { id: 'v1', playbookId: 'p1', version: 1, name: 'Lease', contractType: 'lease', systemPrompt: '', formatPrompt: '', clauses: [{ id: 'c1', title: 'Break', extractPrompt: '' }], changeSummary: '', publishedAt: 1, publishedByUserId: 'me', schemaVersion: 6 },
    documentIds: ['d1'],
    target: { kind: 'documents', documentIds: ['d1'] },
    findings: { d1: { c1: finding() } },
    startedAt: 1,
  } as ReviewRun;
}
const doc = { id: 'd1', name: 'Lease.pdf', kind: 'pdf', text: '[Page 1]\nx' } as DocumentFile;

describe('responsive structure (≥768px pass)', () => {
  it('the grid owns its horizontal scroll in a dedicated container', () => {
    // A dense table that pushes the PAGE horizontally is the defect this
    // asserts against: every other screen then scrolls sideways too.
    const c = mount(<TabularReview run={run()} documents={[doc]} onRetryCell={() => {}} />);
    const table = c.querySelector('table');
    expect(table).toBeTruthy();
    const scroller = table!.closest('[data-scroll-x]');
    expect(scroller, 'the grid table must sit inside a data-scroll-x container').toBeTruthy();
    // …and that container must not be the page body itself.
    expect(scroller!.contains(table!)).toBe(true);
    expect(scroller!.tagName).not.toBe('BODY');
  });

  it('a modal panel declares itself a sheet below the sm breakpoint', () => {
    const c = mount(<Modal isOpen title="T" onClose={() => {}}><p>x</p></Modal>);
    const dialog = c.querySelector('[role="dialog"]');
    // A semantic hook, not a class-string assertion. §13.1 records that this
    // suite has ZERO class-as-style assertions and G is not the sub-project
    // that introduces the first one; the scroll container in the case above
    // already demonstrates the better idiom (F18).
    expect(dialog!.getAttribute('data-sheet-below')).toBe('sm');
    expect(dialog!.getAttribute('role')).toBe('dialog');
  });
});

// ── The document pane's geometry (H1).
//
// jsdom has no layout engine, so nothing here can measure a rendered box.
// What it CAN do is read the geometry the components declare — a width
// utility, the scroller's padding, whether the scroller centres its cross
// axis — and compute the distance that matters from those numbers. That is
// reading a class list as DATA, the way the palette guard reads a colour out
// of one; it is not the class-as-style assertion §13.1 rules out, which
// would be "this element has `lg:w-[380px]`, therefore it is styled right".
// The assertion below is a distance in pixels, and it is derived from the
// same numbers the browser would use.
//
// The rule the whole finding turns on, stated once: a scroll container
// extends its scrollable overflow region only in the inline-END direction.
// Anything a cross-axis CENTRING rule (`align-items: center`) pushes past
// the container's start edge is therefore unreachable — no `scrollLeft`
// value exposes it. Auto margins do not have this problem: they centre only
// while the free space is positive and collapse to zero the moment it is
// negative, leaving the page's left edge exactly at the content origin.

const BREAKPOINTS: Record<string, number> = { sm: 640, md: 768, lg: 1024, xl: 1280 };

/** The px width a pane's class list resolves to at `viewport`: the highest
 *  breakpoint-prefixed `w-[Npx]` that applies, exactly as the cascade would
 *  pick it. Throws rather than guessing if the pane declares none — a pane
 *  that stopped declaring a width would otherwise silently measure as 0 and
 *  make every assertion below pass for the wrong reason. */
function paneWidth(el: Element, viewport: number): number {
  const applicable = [...el.className.matchAll(/(?:(sm|md|lg|xl):)?w-\[(\d+)px\]/g)]
    .filter(m => !m[1] || viewport >= BREAKPOINTS[m[1]])
    .map(m => ({ at: m[1] ? BREAKPOINTS[m[1]] : 0, px: Number(m[2]) }))
    .sort((a, b) => a.at - b.at);
  if (applicable.length === 0) {
    throw new Error(`No w-[Npx] utility applies at ${viewport}px on: ${el.className}`);
  }
  return applicable[applicable.length - 1].px;
}

/** Horizontal padding declared by a `p-N` utility, both sides, in px
 *  (Tailwind's spacing unit is 4px). */
function paddingX(el: Element): number {
  const m = /(?:^|\s)p-(\d+)(?:\s|$)/.exec(el.className);
  return m ? Number(m[1]) * 4 * 2 : 0;
}

/** Whether an element centres its flex cross axis — the thing that makes an
 *  overflowing child's leading edge unreachable. */
function centresItsChildren(el: Element): boolean {
  return /(?:^|[\s:])(items-center|justify-center)(?:\s|$)/.test(el.className);
}

/** The document pane's width at `viewport`, from the two panes beside it as
 *  the review screen actually renders them. Above `lg` all three panes are
 *  in one flex row and the document pane takes what the other two leave. */
function documentPaneWidth(view: HTMLElement, viewport: number): number {
  const rail = paneWidth(view.querySelector('nav[aria-label="Clauses"]')!, viewport);
  const findings = paneWidth(view.querySelector('[data-pane="findings"]')!, viewport);
  const BORDERS = 2; // the 1px border-r on each of the two panes above
  return viewport - rail - findings - BORDERS;
}

const settings: Settings = { apiKey: '', modelId: 'test/model', concurrency: 2 };

/** Mounts the review screen only long enough to read the pane widths off it,
 *  then unmounts: `ResultsView` binds `useVerifyKeys` to `window`, and this
 *  file mounts `PdfCanvas` separately (CLAUDE.md: two live trees leave two
 *  competing global listeners). */
function paneWidthsAt(viewport: number): { pane: number } {
  const { container, unmount } = mountOnce(
    <ResultsView run={run()} documents={[]} settings={settings} onRetryCell={() => {}} />,
  );
  try {
    return { pane: documentPaneWidth(container, viewport) };
  } finally {
    unmount();
  }
}

async function mountPdf(): Promise<{ container: HTMLElement; unmount: () => void }> {
  const { container, unmount } = mountOnce(
    <PdfCanvas file={new File([], 'lease.pdf', { type: 'application/pdf' })} highlights={[]} />,
  );
  await flushUntil(
    () => container.querySelector<HTMLElement>('[data-overflow-origin] > div[style]') !== null,
    'the fake PDF to render its first page',
  );
  return { container, unmount };
}

function renderedPageWidth(container: HTMLElement): number {
  const page = container.querySelector<HTMLElement>('[data-overflow-origin] > div[style]')!;
  return parseFloat(page.style.width);
}

describe('the review screen keeps a document page reachable (H1)', () => {
  it('leaves nothing of a page off the left edge at any width the three-pane layout appears at', async () => {
    const { container, unmount } = await mountPdf();
    try {
      const scroller = container.querySelector('[data-overflow-origin="inline-start"]');
      expect(scroller, 'the PDF scroll container must declare where its overflow starts').toBeTruthy();
      const pageWidth = renderedPageWidth(container);

      // 1024 is where the three-pane layout first appears; 1064 is the
      // window the controller reproduced the clipping at; 1278 is the width
      // Task 23 was verified at and saw a ~100px strip cut off.
      for (const viewport of [1024, 1064, 1278]) {
        const contentBox = paneWidthsAt(viewport).pane - paddingX(scroller!);
        // The case only means anything while the page really does overflow.
        expect(pageWidth).toBeGreaterThan(contentBox);
        const unreachableLeft = centresItsChildren(scroller!)
          ? (pageWidth - contentBox) / 2
          : 0;
        expect(
          unreachableLeft,
          `at ${viewport}px the document pane's content box is ${Math.round(contentBox)}px and the page ` +
          `${Math.round(pageWidth)}px, leaving ${Math.round(unreachableLeft)}px of the page's left margin ` +
          'outside the scrollport with no scrollLeft that can reach it',
        ).toBe(0);
      }
    } finally {
      unmount();
    }
  });

  it('is wide enough at 1024px to show a whole page at the zoom control’s floor', async () => {
    // The other half of H1: reachable is not the same as readable. Zooming
    // out is the reader's answer to a narrow pane, so the pane has to be
    // wide enough for the smallest scale the control actually offers —
    // discovered here by pressing the button until it stops moving, not
    // by copying the constant.
    const { container, unmount } = await mountPdf();
    try {
      const zoomOut = buttonNamed(container, /zoom out/i)!;
      let floor = renderedPageWidth(container);
      for (let i = 0; i < 20; i++) {
        click(zoomOut);
        await flushUntil(() => true, 'the page to re-render at the smaller scale', { min: 1, max: 4 });
        const next = renderedPageWidth(container);
        if (next === floor) break;
        floor = next;
      }
      const scroller = container.querySelector('[data-overflow-origin="inline-start"]')!;
      const contentBox = paneWidthsAt(1024).pane - paddingX(scroller);
      expect(
        floor,
        `at 1024px the document pane's content box is ${Math.round(contentBox)}px, but the smallest page ` +
        `the zoom control can produce is ${Math.round(floor)}px — the reader has no way to see a whole page`,
      ).toBeLessThanOrEqual(contentBox);
    } finally {
      unmount();
    }
  });
});

// ── The same defect, guarded everywhere else.
//
// The two cases above prove it for the one pane it was found in. This is the
// generalisation: any container that declares horizontal scrolling and also
// centres its cross axis has the same unreachable leading edge, and the
// combination is never what was meant.

interface CentredScroller { file: string; line: number; text: string }

const SCROLLS_HORIZONTALLY = /(?:^|[\s:])overflow(?:-x)?-(?:auto|scroll)(?:\s|$)/;

/** Pure: one file's text in, its centred horizontal scrollers out. */
export function scanCentredScrollers(file: string, source: string): CentredScroller[] {
  const out: CentredScroller[] = [];
  // Every className value, quoted or a template literal, including the
  // multi-line ones — a class list split across lines is exactly where this
  // would hide.
  for (const m of source.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\})/g)) {
    const classes = (m[1] ?? m[2]).replace(/\s+/g, ' ');
    if (!SCROLLS_HORIZONTALLY.test(classes)) continue;
    if (!/(?:^|[\s:])(items-center|justify-center)(?:\s|$)/.test(classes)) continue;
    out.push({ file, line: source.slice(0, m.index).split('\n').length, text: classes.trim() });
  }
  return out;
}

describe('scanCentredScrollers — what counts as an unreachable overhang', () => {
  it('flags a horizontal scroll container that centres its children', () => {
    const v = scanCentredScrollers('x.tsx', '<div className="h-full overflow-auto flex flex-col items-center p-8" />');
    expect(v).toHaveLength(1);
    expect(v[0].line).toBe(1);
  });

  it('flags it inside a multi-line template literal too', () => {
    const v = scanCentredScrollers('x.tsx', '<div\n  className={`overflow-x-auto flex\n    justify-center`}\n/>');
    expect(v).toHaveLength(1);
  });

  it('does not flag centring on a container that does not scroll sideways', () => {
    expect(scanCentredScrollers('x.tsx', '<div className="h-full flex items-center justify-center" />')).toEqual([]);
    // `overflow-y-auto` alone is left to the caller: a vertical panel whose
    // children are width-constrained is the common, correct case, and this
    // guard is about containers that DECLARE they expect horizontal overflow.
    expect(scanCentredScrollers('x.tsx', '<div className="overflow-y-auto flex items-center" />')).toEqual([]);
  });

  it('does not flag a horizontal scroller that centres nothing', () => {
    expect(scanCentredScrollers('x.tsx', '<div className="overflow-auto flex flex-col p-8" />')).toEqual([]);
  });
});

describe('centred-scroller guard', () => {
  it('no container that scrolls sideways centres what overflows it', () => {
    const SRC = resolve(__dirname, '..');
    const hits = collectScannableFiles(SRC)
      .flatMap(rel => scanCentredScrollers(rel, readFileSync(resolve(SRC, rel), 'utf8')));
    expect(
      hits.map(h => `${h.file}:${h.line} ${h.text}`).join('\n'),
      'a centred flex child\'s leading overhang cannot be scrolled to — centre with auto margins instead',
    ).toBe('');
  });
});

// ── L4: no screen may size itself by subtracting the header's height.
describe('viewport-height guard', () => {
  it('no screen hardcodes the app header’s height', () => {
    // The header is `min-h-14 h-auto … flex-wrap`: its height is
    // content-dependent, so `calc(100vh - 64px)` names a number that is
    // already wrong by ~7px and becomes wrong by ~39px the moment the nav
    // wraps onto a second row — at which point the page grows past the
    // viewport and gains a second scrollbar outside each screen's own
    // scroll panes. Screens fill `main` (`flex-1` under the shell's
    // `h-screen`) with `h-full` instead, which needs no arithmetic at all —
    // and verified in a browser, because `h-full` resolves only while the
    // shell's own height is definite, which is why the shell is `h-screen`
    // and not `min-h-screen`.
    const SRC = resolve(__dirname, '..');
    const hits = collectScannableFiles(SRC)
      .flatMap(rel => {
        const source = readFileSync(resolve(SRC, rel), 'utf8');
        return [...source.matchAll(/(?:h|min-h|max-h)-\[calc\(100vh[^\]]*\)\]/g)]
          .map(m => `${rel}:${source.slice(0, m.index).split('\n').length} ${m[0]}`);
      });
    expect(hits.join('\n')).toBe('');
  });
});
