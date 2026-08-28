import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { act } from 'react';
import { mount, buttons, buttonNamed, click } from '../../test/mount';
import { CollectionCard } from './CollectionCard';
import { SCAN_DISCLOSURE } from './DocumentNotices';
import type { Collection, DocumentRecord } from '../../types';

/** Clicks and flushes the microtask the click's async handler schedules
 *  (`await onUngroup(...)` / `await onRepair(...)` before `setBusy(false)`)
 *  — plain `click()` only wraps the synchronous dispatch, so the state
 *  update after that `await` lands outside `act` and React warns. */
async function clickAndFlush(element: HTMLElement | null | undefined): Promise<void> {
  if (!element) throw new Error('clickAndFlush() was given nothing to click.');
  await act(async () => {
    element.click();
    await Promise.resolve();
  });
}

function doc(id: string, name: string, over: Partial<DocumentRecord> = {}): DocumentRecord {
  return {
    id,
    matterId: 'm1',
    name,
    kind: 'pdf',
    // Real extracted text by default: with `text: ''` every fixture
    // document is a scan as far as `noUsableText` is concerned, and a
    // notice that shows on every row proves nothing about the row it is
    // meant to be about.
    text: '[Page 1] The tenant shall keep the premises in repair.',
    byteSize: 1,
    addedAt: 1,
    addedByUserId: 'u1',
    role: id === 'lease' ? 'base' : 'varies',
    collectionId: 'c1',
    ...over,
  };
}

const collection: Collection = {
  id: 'c1',
  matterId: 'm1',
  name: 'Lease as varied',
  baseDocumentId: 'lease',
  variesDocumentIds: ['dov', 'licence'],
  createdAt: 1,
  createdByUserId: 'u1',
};

const fullDocuments = [doc('lease', 'Lease.pdf'), doc('dov', 'DoV.pdf'), doc('licence', 'Licence.pdf')];

describe('CollectionCard', () => {
  it('names the collection', () => {
    const container = mount(
      <CollectionCard collection={collection} documents={fullDocuments} onUngroup={async () => {}} onRepair={async () => {}} onRunReview={() => {}} />,
    );
    expect(container.textContent).toContain('Lease as varied');
  });

  it('shows the base row labelled BASE and each amendment labelled VARIES, in reading order', () => {
    const container = mount(
      <CollectionCard collection={collection} documents={fullDocuments} onUngroup={async () => {}} onRepair={async () => {}} onRunReview={() => {}} />,
    );
    const rows = Array.from(container.querySelectorAll('li'));
    expect(rows).toHaveLength(3);
    expect(rows[0].textContent).toContain('Base');
    expect(rows[0].textContent).toContain('Lease.pdf');
    expect(rows[1].textContent).toContain('Varies');
    expect(rows[1].textContent).toContain('DoV.pdf');
    expect(rows[2].textContent).toContain('Varies');
    expect(rows[2].textContent).toContain('Licence.pdf');
  });

  it('offers Ungroup, which calls onUngroup with this collection\'s id', async () => {
    const onUngroup = vi.fn().mockResolvedValue(undefined);
    const container = mount(
      <CollectionCard collection={collection} documents={fullDocuments} onUngroup={onUngroup} onRepair={async () => {}} onRunReview={() => {}} />,
    );
    await clickAndFlush(buttonNamed(container, /ungroup/i));
    expect(onUngroup).toHaveBeenCalledWith('c1');
  });

  it('renders a member whose document is missing as unavailable rather than omitting it', () => {
    // The deed of variation ('dov') was removed from the matter, but the
    // collection still names it — the row must say so, not vanish.
    const partial = [doc('lease', 'Lease.pdf'), doc('licence', 'Licence.pdf')];
    const container = mount(
      <CollectionCard collection={collection} documents={partial} onUngroup={async () => {}} onRepair={async () => {}} onRunReview={() => {}} />,
    );
    const rows = Array.from(container.querySelectorAll('li'));
    expect(rows).toHaveLength(3);
    expect(rows[1].textContent).toMatch(/unavailable/i);
  });

  it('marks the collection broken and offers a repair action when the BASE is missing', () => {
    const missingBase = [doc('dov', 'DoV.pdf'), doc('licence', 'Licence.pdf')];
    const container = mount(
      <CollectionCard collection={collection} documents={missingBase} onUngroup={async () => {}} onRepair={async () => {}} onRunReview={() => {}} />,
    );
    expect(container.textContent).toMatch(/broken/i);
    // A named, explicit choice per surviving document — never a single
    // unlabelled "repair" button that would pick one silently.
    expect(buttonNamed(container, /make.*dov\.pdf.*base/i)).toBeTruthy();
    expect(buttonNamed(container, /make.*licence\.pdf.*base/i)).toBeTruthy();
  });

  it('choosing a repair candidate calls onRepair with the collection id and the chosen document id', async () => {
    const onRepair = vi.fn().mockResolvedValue(undefined);
    const missingBase = [doc('dov', 'DoV.pdf'), doc('licence', 'Licence.pdf')];
    const container = mount(
      <CollectionCard collection={collection} documents={missingBase} onUngroup={async () => {}} onRepair={onRepair} onRunReview={() => {}} />,
    );
    await clickAndFlush(buttonNamed(container, /make.*dov\.pdf.*base/i));
    expect(onRepair).toHaveBeenCalledWith('c1', 'dov');
  });

  it('a broken collection offers no runnable "Run a review" action', () => {
    const missingBase = [doc('dov', 'DoV.pdf'), doc('licence', 'Licence.pdf')];
    const container = mount(
      <CollectionCard collection={collection} documents={missingBase} onUngroup={async () => {}} onRepair={async () => {}} onRunReview={() => {}} />,
    );
    const runButton = buttonNamed(container, /run a review/i);
    expect(runButton).toBeTruthy();
    expect(runButton!.disabled).toBe(true);
  });

  it('a healthy collection offers a working "Run a review" that hands up a collection target built from orderedMembers', () => {
    const onRunReview = vi.fn();
    const container = mount(
      <CollectionCard collection={collection} documents={fullDocuments} onUngroup={async () => {}} onRepair={async () => {}} onRunReview={onRunReview} />,
    );
    const runButton = buttonNamed(container, /run a review/i);
    expect(runButton!.disabled).toBe(false);
    click(runButton);
    expect(onRunReview).toHaveBeenCalledWith({
      kind: 'collection',
      collectionId: 'c1',
      documentIds: ['lease', 'dov', 'licence'],
    });
  });

  it('sanity: exactly the expected number of buttons render for a healthy collection (Run a review + Ungroup)', () => {
    const container = mount(
      <CollectionCard collection={collection} documents={fullDocuments} onUngroup={async () => {}} onRepair={async () => {}} onRunReview={() => {}} />,
    );
    expect(buttons(container)).toHaveLength(2);
  });

  it("carries a member document's ingestion notices, so grouping never hides a scan", () => {
    // The scan disclosure lives in `DocumentNotices` precisely because a
    // matter lists its documents in more than one place. Before this, a
    // scanned PDF dropped into a collection lost the sentence entirely:
    // `extractCollectionClause` would still decline it at run time, but
    // only after the run had been started and paid for.
    const documents = [
      doc('lease', 'Lease.pdf'),
      doc('dov', 'Scanned DoV.pdf', { text: '' }),
      doc('licence', 'Licence.pdf', { markupNotice: 'Tracked changes were accepted to read this file.' }),
    ];
    const c = mount(
      <CollectionCard
        collection={collection}
        documents={documents}
        onUngroup={vi.fn()}
        onRepair={vi.fn()}
        onRunReview={vi.fn()}
      />,
    );
    const rows = Array.from(c.querySelectorAll('li'));
    const rowFor = (name: string) => rows.find(li => li.textContent?.includes(name))!;
    expect(rowFor('Scanned DoV.pdf').textContent).toContain(SCAN_DISCLOSURE);
    expect(rowFor('Licence.pdf').textContent).toContain('Tracked changes were accepted');
    // …and a document that read fine says nothing, or the notice stops
    // meaning anything.
    expect(rowFor('Lease.pdf').textContent).not.toContain(SCAN_DISCLOSURE);
  });
});
