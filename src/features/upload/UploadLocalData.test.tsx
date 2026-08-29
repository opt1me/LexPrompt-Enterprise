import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mount, buttonNamed, click, flushUntil } from '../../test/mount';
import { closeDb } from '../../lib/db/open';
import { seedLocal } from '../../test/seedLocalData';
import { UploadLocalData } from './UploadLocalData';
import { seal, type UploadReport } from '../../lib/upload/report';

/**
 * The screen's whole job in Task 21 is telling a person exactly what is in
 * their browser. So what is asserted is names — not counts alone — and the
 * three different empties: still loading, genuinely nothing here, and
 * could not be read.
 */

beforeEach(() => {
  closeDb();
  indexedDB.deleteDatabase('lexprompt');
});

const DOC = {
  id: 'd1', matterId: 'm1', name: 'Brookvale - executed.pdf', kind: 'pdf' as const,
  text: 'x', byteSize: 4096, addedAt: 1, addedByUserId: 'local-abc', role: 'standalone' as const,
};

describe('UploadLocalData', () => {
  it('names every record it found, rather than only counting them', async () => {
    await seedLocal({
      matters: [
        { id: 'm1', name: 'Brookvale Retail Park', ownerId: 'local-abc', createdAt: 1, updatedAt: 1 },
        { id: 'm2', name: 'Ashfield Mill', ownerId: 'local-abc', createdAt: 2, updatedAt: 2 },
      ],
      documents: [DOC],
      blobsFor: ['d1'],
    });
    const el = mount(<UploadLocalData onClose={() => {}} />);
    await flushUntil(() => /Brookvale Retail Park/.test(el.textContent ?? ''), 'the scan to render');
    expect(el.textContent).toContain('Brookvale Retail Park');
    expect(el.textContent).toContain('Ashfield Mill');
    expect(el.textContent).toContain('Brookvale - executed.pdf');
    expect(el.textContent).toContain('2 matters');
  });

  it('warns, by name, about a document whose original file is not here', async () => {
    await seedLocal({ documents: [DOC], blobsFor: [] });
    const el = mount(<UploadLocalData onClose={() => {}} />);
    await flushUntil(() => /Brookvale - executed\.pdf/.test(el.textContent ?? ''), 'the scan');
    expect(el.textContent).toMatch(/original file is not in this browser/i);
  });

  it('says an empty browser is empty', async () => {
    const el = mount(<UploadLocalData onClose={() => {}} />);
    await flushUntil(() => /nothing stored in this browser/.test(el.textContent ?? ''), 'the empty state');
    expect(el.textContent).toContain('There is nothing stored in this browser');
    // …and does NOT offer to upload nothing.
    expect(buttonNamed(el, /upload everything/i)).toBeUndefined();
  });

  it('states that nothing is deleted from this browser', async () => {
    const el = mount(<UploadLocalData onClose={() => {}} />);
    await flushUntil(() => /Reading this browser/.test(el.textContent ?? '')
      || /nothing stored/.test(el.textContent ?? ''), 'the screen');
    expect(el.textContent).toContain('Nothing here has been deleted');
  });

  it('hands the scan to the uploader when Upload everything is pressed', async () => {
    await seedLocal({
      matters: [{ id: 'm1', name: 'Brookvale Retail Park', ownerId: 'local-abc', createdAt: 1, updatedAt: 1 }],
    });
    const upload = vi.fn(async (_scan: unknown) => complete);
    const el = mount(<UploadLocalData onClose={() => {}} upload={upload} />);
    await flushUntil(() => !!buttonNamed(el, /upload everything/i), 'the upload button');
    click(buttonNamed(el, /upload everything/i));
    expect(upload).toHaveBeenCalledTimes(1);
    expect((upload.mock.calls[0][0] as { totals: Record<string, number> }).totals.matters).toBe(1);
  });
});

/**
 * The one sentence this screen must never say: "Everything moved", over
 * anything less than everything.
 *
 * The negative assertion is PAIRED with a positive one on purpose. A
 * `not.toContain` with no companion passes against a component that renders
 * nothing at all, which is how Stage 1 shipped two vacuous assertions.
 */
const complete: UploadReport = seal({
  startedAt: 1, expected: { matters: 1 }, unmapped: 0, unreadable: [],
  outcomes: [{ store: 'matters', id: 'm1', label: 'Brookvale Retail Park', status: 'moved' }],
});

const incomplete: UploadReport = seal({
  startedAt: 1, expected: { matters: 2 }, unmapped: 0, unreadable: [],
  outcomes: [
    { store: 'matters', id: 'm1', label: 'Brookvale Retail Park', status: 'moved' },
    { store: 'matters', id: 'm2', label: 'Ashfield Mill', status: 'failed',
      reason: 'There is no matter m2 to add this to.' },
  ],
});

async function reportFor(report: UploadReport): Promise<HTMLDivElement> {
  await seedLocal({
    matters: [{ id: 'm1', name: 'Brookvale Retail Park', ownerId: 'local-abc', createdAt: 1, updatedAt: 1 }],
  });
  const el = mount(<UploadLocalData onClose={() => {}} upload={async () => report} />);
  await flushUntil(() => !!buttonNamed(el, /upload everything/i), 'the upload button');
  click(buttonNamed(el, /upload everything/i));
  await flushUntil(() => /moved/i.test(el.textContent ?? ''), 'the report');
  return el;
}

describe('the finished report', () => {
  it('says everything moved, and says the word complete, ONLY when it did', async () => {
    const el = await reportFor(complete);
    expect(el.textContent).toContain('Everything moved');
    expect(el.textContent).toMatch(/complete/i);
    expect(el.textContent).toContain('✓');
  });

  it('says NEITHER "complete" NOR a tick when one record failed', async () => {
    const el = await reportFor(incomplete);
    expect(el.textContent).toContain('Some of your data did not move');
    expect(el.textContent).not.toMatch(/complete/i);
    expect(el.textContent).not.toContain('✓');
  });

  it('names what did not move, with the reason, above the successes', async () => {
    const el = await reportFor(incomplete);
    const text = el.textContent ?? '';
    expect(text).toContain('Ashfield Mill');
    expect(text).toContain('There is no matter m2 to add this to.');
    // A person who has to scroll past nine good records to find the one that
    // did not move will not scroll.
    expect(text.indexOf('Did not move')).toBeLessThan(text.indexOf('1 of 2 matters'));
  });

  it('states that the browser copy is still here, on the report itself', async () => {
    const el = await reportFor(complete);
    expect(el.textContent).toContain('Your data is still in this browser as well');
    expect(el.textContent).toContain('Nothing here has been deleted');
  });
});
