import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Collection, DocumentRecord, Finding, Matter, Review, ReviewTarget } from '../../types';
import { MatterHome } from './MatterHome';
import { TRACKED_CHANGES_NOTICE } from '../../lib/docxMarkup';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function makeMatter(): Matter {
  return { id: 'm1', name: 'Acme v Bolt', ownerId: 'u1', createdAt: 1, updatedAt: 1 };
}

function f(status: Finding['status'], state: Finding['verification']['state']): Finding {
  return { clauseId: 'c', status, citations: [], notes: [], verification: { state } };
}

/** A completed review with 4 findings, 2 of them verified — the mix each
 *  progress test below needs. */
function makeReview(overrides: Partial<Review> = {}): Review {
  return {
    id: 'r1',
    matterId: 'm1',
    playbookSnapshot: {
      id: 't1',
      name: 'Basic Contract Review',
      contractType: 'NDA',
      systemPrompt: '',
      formatPrompt: '',
      clauses: [],
      playbookId: 'pb',
      version: 1,
      changeSummary: '',
      publishedAt: 1,
      publishedByUserId: '',
      schemaVersion: 6,
    },
    documentIds: ['d1'],
    target: { kind: 'documents', documentIds: ['d1'] },
    findings: {
      d1: {
        c1: f('done', 'verified'),
        c2: f('done', 'verified'),
        c3: f('done', 'unchecked'),
        c4: f('done', 'unchecked'),
      },
    },
    modelId: 'm',
    startedAt: 1,
    createdByUserId: 'u1',
    ...overrides,
  };
}

function makeDoc(overrides: Partial<DocumentRecord> = {}): DocumentRecord {
  return {
    id: 'd1',
    matterId: 'm1',
    name: 'Lease.pdf',
    kind: 'pdf',
    text: '',
    byteSize: 1,
    addedAt: 1,
    addedByUserId: 'u1',
    role: 'standalone',
    ...overrides,
  };
}

function makeCollection(overrides: Partial<Collection> = {}): Collection {
  return {
    id: 'c1',
    matterId: 'm1',
    name: 'Lease as varied',
    baseDocumentId: 'base',
    variesDocumentIds: ['dov'],
    createdAt: 1,
    createdByUserId: 'u1',
    ...overrides,
  };
}

let cleanup: (() => void) | null = null;
afterEach(() => { cleanup?.(); cleanup = null; });

function mount(node: React.ReactElement): HTMLDivElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  act(() => { root.render(node); });
  cleanup = () => { act(() => { root.unmount(); }); container.remove(); };
  return container;
}

const baseProps = {
  matter: makeMatter(),
  documents: [],
  documentsError: null,
  onRetryDocuments: () => {},
  onAddDocuments: async () => {},
  onRemoveDocument: async () => {},
  collections: [],
  collectionsError: null,
  onRetryCollections: () => {},
  onCreateCollection: async () => {},
  onUngroupCollection: async () => {},
  onRepairCollection: async () => {},
  reviews: [],
  reviewsError: null,
  onRetryReviews: () => {},
  onOpenReview: () => {},
  playbooks: [],
  playbooksError: null,
  onRetryPlaybooks: () => {},
  onRunReview: async () => {},
  onDeleteMatter: async () => {},
  localUserId: 'u1',
  modelId: 'anthropic/claude-3.5-sonnet',
  onOpenSettings: () => {},
  onCreatePlaybook: () => {},
};

describe('MatterHome — converged load-error panels (Important 4)', () => {
  it('a documents load failure renders the shared panel with a working retry', () => {
    const onRetryDocuments = vi.fn();
    const container = mount(
      <MatterHome {...baseProps} documentsError="The documents in this matter could not be loaded. Try again." onRetryDocuments={onRetryDocuments} />,
    );
    expect(container.textContent).toContain('could not be loaded');
    const button = Array.from(container.querySelectorAll('button')).find(b => /retry/i.test(b.textContent || ''));
    expect(button).toBeTruthy();
    act(() => { (button as HTMLButtonElement).click(); });
    expect(onRetryDocuments).toHaveBeenCalled();
  });

  it('a reviews load failure renders the shared panel with a working retry', () => {
    const onRetryReviews = vi.fn();
    const container = mount(
      <MatterHome {...baseProps} reviewsError="The reviews in this matter could not be loaded. Try again." onRetryReviews={onRetryReviews} />,
    );
    const button = Array.from(container.querySelectorAll('button')).find(b => /retry/i.test(b.textContent || ''));
    expect(button).toBeTruthy();
    act(() => { (button as HTMLButtonElement).click(); });
    expect(onRetryReviews).toHaveBeenCalled();
  });

  it('the "run a review" playbook picker now offers a working Retry on a load failure, not just a redirect message', () => {
    const onRetryPlaybooks = vi.fn();
    const container = mount(
      <MatterHome {...baseProps} playbooksError="The playbook library could not be loaded. Try again." onRetryPlaybooks={onRetryPlaybooks} />,
    );
    const runButton = Array.from(container.querySelectorAll('button')).find(b => /run a review/i.test(b.textContent || '')) as HTMLButtonElement;
    act(() => { runButton.click(); });

    expect(container.textContent).toContain('could not be loaded');
    const retryButton = Array.from(container.querySelectorAll('button')).find(b => /^retry$/i.test(b.textContent || ''));
    expect(retryButton).toBeTruthy();
    act(() => { (retryButton as HTMLButtonElement).click(); });
    expect(onRetryPlaybooks).toHaveBeenCalled();
  });
});

describe('MatterHome — verification progress (Task 12)', () => {
  it('shows how many findings in a review a human has verified', () => {
    const container = mount(
      <MatterHome {...baseProps} reviews={[makeReview()]} />,
    );
    expect(container.textContent).toContain('2 of 4 verified');
  });

  it('shows verification progress separately from run progress', () => {
    const container = mount(
      <MatterHome {...baseProps} reviews={[makeReview()]} />,
    );
    // All 4 findings are `status: 'done'`, so reviewStatusLabel (untouched
    // by this task) reports 4/4 clauses reviewed — a different question
    // from how many a human has verified, and a reader needs both.
    expect(container.textContent).toContain('4/4 clauses reviewed');
    expect(container.textContent).toContain('2 of 4 verified');
  });
});

describe('MatterHome — collections (Task 7)', () => {
  it('renders a collection card above the standalone documents, and only lists non-member documents as standalone rows', () => {
    const base = makeDoc({ id: 'base', name: 'Lease.pdf', role: 'base', collectionId: 'c1' });
    const dov = makeDoc({ id: 'dov', name: 'DoV.pdf', role: 'varies', collectionId: 'c1' });
    const loose = makeDoc({ id: 'loose', name: 'NDA.pdf', role: 'standalone' });
    const container = mount(
      <MatterHome {...baseProps} documents={[base, dov, loose]} collections={[makeCollection()]} />,
    );
    // The collection's own name appears (from CollectionCard), and the
    // grouped documents' names appear only inside it, not as loose rows.
    expect(container.textContent).toContain('Lease as varied');
    expect(container.textContent).toContain('NDA.pdf');
  });

  it('a collections load failure renders its own compact panel with a working retry, independent of documents', () => {
    const onRetryCollections = vi.fn();
    const container = mount(
      <MatterHome
        {...baseProps}
        documents={[makeDoc({ id: 'loose', name: 'NDA.pdf' })]}
        collectionsError="The collections in this matter could not be loaded. Try again."
        onRetryCollections={onRetryCollections}
      />,
    );
    expect(container.textContent).toContain('could not be loaded');
    // The standalone list still rendered — a collections failure must not
    // hide documents that loaded fine.
    expect(container.textContent).toContain('NDA.pdf');
    const button = Array.from(container.querySelectorAll('button')).find(b => /retry/i.test(b.textContent || ''));
    act(() => { (button as HTMLButtonElement).click(); });
    expect(onRetryCollections).toHaveBeenCalled();
  });

  it('"Group as a collection" is disabled until two standalone documents are selected, then calls onCreateCollection', async () => {
    const onCreateCollection = vi.fn().mockResolvedValue(undefined);
    const docs = [makeDoc({ id: 'a', name: 'A.pdf' }), makeDoc({ id: 'b', name: 'B.pdf' })];
    const container = mount(
      <MatterHome {...baseProps} documents={docs} onCreateCollection={onCreateCollection} />,
    );
    const groupButton = () => Array.from(container.querySelectorAll('button')).find(b => /group as a collection/i.test(b.textContent || '')) as HTMLButtonElement;
    expect(groupButton().disabled).toBe(true);

    const checkboxes = Array.from(container.querySelectorAll('input[type="checkbox"]')) as HTMLInputElement[];
    expect(checkboxes).toHaveLength(2);
    act(() => { checkboxes[0].click(); });
    expect(groupButton().disabled).toBe(true); // only one selected so far
    act(() => { checkboxes[1].click(); });
    expect(groupButton().disabled).toBe(false);

    act(() => { groupButton().click(); });
    // The GroupDocumentsDialog is now open — fill its name and confirm.
    const nameInput = container.querySelector('#collection-name') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    act(() => {
      setter.call(nameInput, 'A as varied');
      nameInput.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const confirmButton = Array.from(container.querySelectorAll('button')).find(b => /create collection/i.test(b.textContent || '')) as HTMLButtonElement;
    await act(async () => {
      confirmButton.click();
      await Promise.resolve();
    });
    expect(onCreateCollection).toHaveBeenCalledWith({ name: 'A as varied', baseDocumentId: 'a', variesDocumentIds: ['b'] });
  });

  it('shows a dismissible suggestion when suggestCollections proposes one, and dismissing removes it without grouping anything', () => {
    const base = makeDoc({ id: 'lease', name: 'Lease.pdf' });
    const amendment = makeDoc({ id: 'dov', name: 'Lease Deed of Variation.pdf' });
    const onCreateCollection = vi.fn();
    const container = mount(
      <MatterHome {...baseProps} documents={[base, amendment]} onCreateCollection={onCreateCollection} />,
    );
    expect(container.textContent).toMatch(/deed of variation/i);
    const dismiss = container.querySelector('button[aria-label="Dismiss suggestion"]') as HTMLButtonElement;
    expect(dismiss).toBeTruthy();
    act(() => { dismiss.click(); });
    expect(container.textContent).not.toMatch(/shares.*name and is named as a/i);
    expect(onCreateCollection).not.toHaveBeenCalled();
  });

  it('the matter-wide "Run a review" still passes no target — the standalone path is unchanged', async () => {
    const onRunReview = vi.fn().mockResolvedValue(undefined);
    const playbook = { id: 'p1', name: 'NDA Review' } as unknown as Parameters<typeof onRunReview>[0];
    const container = mount(
      <MatterHome {...baseProps} playbooks={[playbook]} onRunReview={onRunReview} />,
    );
    const runButton = Array.from(container.querySelectorAll('button')).find(b => /^run a review$/i.test((b.textContent || '').trim())) as HTMLButtonElement;
    act(() => { runButton.click(); });
    const playbookButton = Array.from(container.querySelectorAll('button')).find(b => /nda review/i.test(b.textContent || '')) as HTMLButtonElement;
    await act(async () => {
      playbookButton.click();
      await Promise.resolve();
    });
    expect(onRunReview).toHaveBeenCalledWith(playbook, undefined);
  });

  it('a collection card\'s own "Run a review" opens the same picker scoped to that collection\'s target', async () => {
    const onRunReview = vi.fn().mockResolvedValue(undefined);
    const playbook = { id: 'p1', name: 'NDA Review' } as unknown as Parameters<typeof onRunReview>[0];
    const base = makeDoc({ id: 'base', name: 'Lease.pdf', role: 'base', collectionId: 'c1' });
    const dov = makeDoc({ id: 'dov', name: 'DoV.pdf', role: 'varies', collectionId: 'c1' });
    const container = mount(
      <MatterHome
        {...baseProps}
        documents={[base, dov]}
        collections={[makeCollection()]}
        playbooks={[playbook]}
        onRunReview={onRunReview}
      />,
    );
    const collectionRunButton = Array.from(container.querySelectorAll('button')).find(b => /run a review/i.test(b.textContent || '')) as HTMLButtonElement;
    act(() => { collectionRunButton.click(); });
    const playbookButton = Array.from(container.querySelectorAll('button')).find(b => /nda review/i.test(b.textContent || '')) as HTMLButtonElement;
    await act(async () => {
      playbookButton.click();
      await Promise.resolve();
    });
    const expectedTarget: ReviewTarget = { kind: 'collection', collectionId: 'c1', documentIds: ['base', 'dov'] };
    expect(onRunReview).toHaveBeenCalledWith(playbook, expectedTarget);
  });

  it('a broken collection (missing base) offers no runnable "Run a review" of its own', () => {
    const dov = makeDoc({ id: 'dov', name: 'DoV.pdf', role: 'varies', collectionId: 'c1' });
    const container = mount(
      <MatterHome {...baseProps} documents={[dov]} collections={[makeCollection()]} />,
    );
    const runButtons = Array.from(container.querySelectorAll('button')).filter(b => /run a review/i.test(b.textContent || ''));
    // One is the matter-wide button (always runnable); the collection's own
    // must be present and disabled, never simply omitted.
    const collectionRunButton = runButtons.find(b => b.disabled);
    expect(collectionRunButton).toBeTruthy();
  });
});

describe('MatterHome — collection membership is authoritative over document role', () => {
  it('renders a claimed document once even when its role still says standalone', () => {
    // Creating a collection writes the collection record and the member
    // roles as two sequential writes (the sequence allocator is typed to a
    // single-store transaction, and relaxing that would weaken a guard
    // against a subtler bug). Both orders are chosen so a partial failure
    // can never make a document invisible — but it can leave `role` saying
    // 'standalone' while a collection already lists the document.
    //
    // Reading membership from the collection record makes that
    // disagreement invisible: the document renders once, inside its
    // collection. Filtering by `role` instead would render it twice, in
    // the collection card AND in the loose-documents list.
    const documents = [
      makeDoc({ id: 'lease', name: 'Lease.pdf', role: 'standalone' }),
      makeDoc({ id: 'dov', name: 'DoV.pdf', role: 'standalone' }),
      makeDoc({ id: 'loose', name: 'Loose.pdf', role: 'standalone' }),
    ];
    const collections = [
      makeCollection({ id: 'c1', name: 'Lease as varied', baseDocumentId: 'lease', variesDocumentIds: ['dov'] }),
    ];

    const container = mount(
      <MatterHome {...baseProps} documents={documents} collections={collections} />,
    );
    const text = container.textContent ?? '';
    const occurrences = (name: string) => text.split(name).length - 1;

    // Each claimed document appears exactly once — in its collection.
    expect(occurrences('Lease.pdf')).toBe(1);
    expect(occurrences('DoV.pdf')).toBe(1);
    // The genuinely loose document is still shown.
    expect(occurrences('Loose.pdf')).toBe(1);
  });
});

describe('MatterHome — a collections load failure does not mis-describe documents', () => {
  it('does not present grouped documents as loose when collections failed to load', () => {
    // The loose list is derived from the collection records. Without them,
    // membership is UNKNOWN — not empty. Listing every document as loose
    // would show a grouped document as ungrouped, and a reader would
    // believe it and might regroup something already in a collection.
    // That is worse than saying nothing, so the grouping affordance goes
    // away and the error explains why.
    const documents = [
      makeDoc({ id: 'lease', name: 'Lease.pdf', role: 'base', collectionId: 'c1' }),
      makeDoc({ id: 'dov', name: 'DoV.pdf', role: 'varies', collectionId: 'c1' }),
    ];
    const container = mount(
      <MatterHome
        {...baseProps}
        documents={documents}
        collections={[]}
        collectionsError="The collections in this matter could not be loaded. Try again."
      />,
    );
    const text = container.textContent ?? '';

    // The failure is stated, and the documents are still visible.
    expect(text).toContain('could not be loaded');
    expect(text).toContain('Lease.pdf');
    expect(text).toContain('DoV.pdf');
    // But nothing offers to group them, because we cannot know what is loose.
    expect(container.querySelectorAll('input[type="checkbox"]').length).toBe(0);
    expect(text).toContain('grouping unavailable');
  });

  it('still shows collection cards when the DOCUMENTS load failed', () => {
    // The two loads are independent. A documents failure used to hide
    // collection cards that had loaded perfectly well.
    const collections = [
      makeCollection({ id: 'c1', name: 'Lease as varied', baseDocumentId: 'lease', variesDocumentIds: ['dov'] }),
    ];
    const container = mount(
      <MatterHome
        {...baseProps}
        documents={[]}
        collections={collections}
        documentsError="The documents in this matter could not be loaded. Try again."
      />,
    );
    const text = container.textContent ?? '';
    expect(text).toContain('Lease as varied');
    expect(text).toContain('could not be loaded');
  });
});

describe('MatterHome — activity list (Task 16)', () => {
  it('attributes an action by the local profile as yours, wiring localUserId through', () => {
    const review = makeReview({
      findings: {
        d1: {
          c1: { clauseId: 'c1', status: 'done', citations: [], notes: [], verification: { state: 'verified', byUserId: 'u1', at: 500 } },
        },
      },
    });
    const container = mount(<MatterHome {...baseProps} reviews={[review]} />);
    expect(container.textContent).toContain('You verified');
  });

  it('a reviews load failure replaces the activity column with the error panel, never an empty feed', () => {
    // R-G9's honest consequence: statistics and history derived from
    // reviews that could not be read are not statistics or history. The
    // empty-feed idiom ("Nothing recorded…") must not appear here — that
    // is a different fact from "we could not read what happened".
    const container = mount(
      <MatterHome {...baseProps} reviewsError="The reviews in this matter could not be loaded. Try again." />,
    );
    expect(container.textContent).not.toContain('Nothing recorded in this matter yet.');
    expect(container.textContent).toContain('could not be loaded');
  });
});

describe('MatterHome — a marked-up document is marked as such in the list', () => {
  it('shows the markup notice on the document row', () => {
    const container = mount(
      <MatterHome
        {...baseProps}
        documents={[makeDoc({ id: 'd1', name: 'Lease.docx', kind: 'docx', markupNotice: TRACKED_CHANGES_NOTICE })]}
      />,
    );
    expect(container.textContent).toContain(TRACKED_CHANGES_NOTICE);
  });

  it('does not call a document with a caveat unreadable', () => {
    // The row's existing red "Unreadable:" treatment is for `parseError`. A
    // marked-up document is perfectly readable and perfectly reviewable —
    // labelling it unreadable would be a different lie in the other
    // direction, and would train the reader to ignore both labels.
    const container = mount(
      <MatterHome
        {...baseProps}
        documents={[makeDoc({ id: 'd1', name: 'Lease.docx', kind: 'docx', markupNotice: TRACKED_CHANGES_NOTICE })]}
      />,
    );
    expect(container.textContent).not.toContain('Unreadable');
  });

  it('says nothing about markup for a document with no notice', () => {
    const container = mount(<MatterHome {...baseProps} documents={[makeDoc({ id: 'd1' })]} />);
    expect(container.textContent).not.toContain('tracked changes');
  });
});
