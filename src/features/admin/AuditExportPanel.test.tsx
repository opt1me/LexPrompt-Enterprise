import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import type { AuditExport } from '@lexprompt/core';
import { mount, click, flushUntil, buttonNamed, buttons } from '../../test/mount';
import {
  AuditExportPanel, AUDIT_EXPORT_DEFAULT_DAYS, manifestLines, toCsv,
} from './AuditExportPanel';

const TAKEN_AT = Date.UTC(2026, 7, 31, 12, 0);
const FROM = Date.UTC(2026, 7, 1);
const TO = Date.UTC(2026, 7, 31);

const result = (over: Partial<AuditExport> = {}): AuditExport => ({
  manifest: {
    workspaceId: 'ws-1',
    from: FROM,
    to: TO,
    takenAt: TAKEN_AT,
    takenByUserId: 'u-admin',
    timeZone: 'Europe/London',
    sources: [
      { source: 'audit_event', rows: 2 },
      { source: 'finding_disposition_event', rows: 1 },
      { source: 'run', rows: 0 },
    ],
    complete: true,
  },
  rows: [
    {
      at: FROM + 1000, source: 'audit_event', kind: 'matter.created', byUserId: 'u-admin',
      matterId: 'm1', matterName: 'Ashcroft', subjectType: 'matter', subjectId: 'm1',
    },
    {
      at: FROM + 2000, source: 'audit_event', kind: 'review.created', byUserId: 'u-admin',
      matterId: 'm1', matterName: 'Ashcroft',
    },
    {
      at: FROM + 3000, source: 'finding_disposition_event', kind: 'verified',
      byUserId: 'u-trainee', reviewId: 'r1', reviewName: 'Lease review', clauseId: 'c1',
      cause: 'human',
    },
  ],
  ...over,
});

const textOf = (el: HTMLElement): string => el.textContent ?? '';

describe('AuditExportPanel', () => {
  it('opens on a bounded range and never on everything', () => {
    // "Everything this workspace has ever done" is a decision somebody
    // makes, not a default a screen makes for them — and the route refuses an
    // unbounded range for the same reason.
    expect(AUDIT_EXPORT_DEFAULT_DAYS).toBe(30);
    const take = vi.fn(async () => result());
    const container = mount(<AuditExportPanel take={take} />);
    expect(take).not.toHaveBeenCalled();
    // Every offered range is bounded; none of them is "all of it".
    expect(textOf(container).toLowerCase()).not.toContain('everything');
    expect(textOf(container).toLowerCase()).not.toContain('all time');
  });

  it('asks the server for the range it names, from and to', async () => {
    const take = vi.fn(async () => result());
    const container = mount(<AuditExportPanel take={take} />);
    click(buttonNamed(container, /Last 30 days/));
    await flushUntil(() => take.mock.calls.length > 0, 'the extract to be requested');
    const [from, to] = take.mock.calls[0] as unknown as [number, number];
    expect(to - from).toBe(30 * 24 * 60 * 60 * 1000);
    expect(to).toBeLessThanOrEqual(Date.now());
  });

  it('states the manifest above the download, not only inside the file', async () => {
    const take = vi.fn(async () => result());
    const container = mount(<AuditExportPanel take={take} />);
    click(buttonNamed(container, /Last 30 days/));
    await flushUntil(() => !!container.querySelector('[data-testid="manifest"]'), 'the manifest');
    const block = textOf(container.querySelector<HTMLElement>('[data-testid="manifest"]')!);
    expect(block).toContain('ws-1');
    expect(block).toContain('Europe/London');
    // EVERY source, including the one with no rows: an omitted source reads
    // as a source that was not covered.
    expect(block).toContain('Source audit_event: 2 row(s)');
    expect(block).toContain('Source finding_disposition_event: 1 row(s)');
    expect(block).toContain('Source run: 0 row(s)');
    expect(block).toMatch(/complete/i);
    // …and the download is only offered after it.
    expect(buttonNamed(container, /Download the extract/)).toBeDefined();
  });

  it('puts the SAME manifest at the top of the file, before any row', async () => {
    const take = vi.fn(async () => result());
    const onDownload = vi.fn();
    const container = mount(<AuditExportPanel take={take} onDownload={onDownload} />);
    click(buttonNamed(container, /Last 30 days/));
    await flushUntil(() => !!buttonNamed(container, /Download the extract/), 'the download');
    click(buttonNamed(container, /Download the extract/));
    const [filename, csv] = onDownload.mock.calls[0] as [string, string];
    expect(filename).toMatch(/^lexprompt-audit-\d{4}-\d{2}-\d{2}\.csv$/);
    // One producer for both, so the block a person reads before downloading
    // and the block inside the download cannot drift.
    for (const line of manifestLines(result().manifest)) {
      expect(csv).toContain(line);
    }
    // The manifest comes FIRST, exactly as the DOCX puts its "as at" line
    // first — a reader must meet the scope before the rows.
    expect(csv.indexOf('LexPrompt audit extract')).toBeLessThan(csv.indexOf('matter.created'));
    expect(csv.indexOf('LexPrompt audit extract')).toBeLessThan(csv.indexOf('"When"'));
  });

  it('carries every row it was given, and names what each one was about', () => {
    const csv = toCsv(result());
    expect(csv).toContain('matter.created');
    expect(csv).toContain('review.created');
    expect(csv).toContain('verified');
    expect(csv).toContain('Ashcroft');
    expect(csv).toContain('Lease review');
    // A re-run reset is NOT a person un-verifying something (§6.3), so the
    // cause travels rather than being flattened away.
    expect(csv).toContain('human');
    // One header row and three data rows after the manifest block.
    const dataLines = csv.split('\n').filter(l => l.startsWith('"20'));
    expect(dataLines).toHaveLength(3);
  });

  it('escapes a quote in a name rather than breaking the row', () => {
    const csv = toCsv(result({
      rows: [{
        at: FROM, source: 'audit_event', kind: 'matter.created', byUserId: 'u',
        matterName: 'The "Ashcroft" matter',
      }],
    }));
    expect(csv).toContain('"The ""Ashcroft"" matter"');
  });

  it('renders the refusal as a refusal, naming the source and offering a narrower range', async () => {
    const take = vi.fn(async () => {
      throw new Error(
        'This range holds more than 50000 rows in audit_event alone… Narrow the range and take '
        + 'it in pieces.');
    });
    const container = mount(<AuditExportPanel take={take} />);
    click(buttonNamed(container, /Last 90 days/));
    await flushUntil(() => textOf(container).includes('Narrow the range'), 'the refusal');
    expect(textOf(container)).toContain('audit_event');
    // A narrower range is a CONTROL, not an instruction to go and edit a URL.
    expect(buttons(container).map(b => b.textContent)).toContain('Last 30 days');
    expect(buttons(container).map(b => b.textContent)).toContain('Last 7 days');
    // NOT an empty extract, which would be a file saying nothing happened.
    expect(container.querySelector('[data-testid="manifest"]')).toBeNull();
    expect(buttonNamed(container, /Download the extract/)).toBeUndefined();
  });

  it('says nothing about a download until one has been taken', () => {
    const container = mount(<AuditExportPanel take={vi.fn(async () => result())} />);
    expect(container.querySelector('[data-testid="manifest"]')).toBeNull();
    expect(buttonNamed(container, /Download the extract/)).toBeUndefined();
  });
});
