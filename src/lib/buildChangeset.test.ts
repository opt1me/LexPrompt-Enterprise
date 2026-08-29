import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { PlaybookVersion } from '../types';
import type { WorkspaceSettings } from '@lexprompt/core';
import type { ParsedEdit } from './docxRedlines';

// Same module-mock idiom as `inferPositions.test.ts`.
vi.mock('./model/gatewayModelClient', () => ({
  gatewayModelClient: {
    chat: vi.fn(), chatJson: vi.fn(), chatStream: vi.fn(), listModels: vi.fn(),
  },
}));
const { gatewayModelClient } = await import('./model/gatewayModelClient');
const chatJson = gatewayModelClient.chatJson;
const { buildChangeset } = await import('./buildChangeset');

beforeEach(() => vi.clearAllMocks());

const settings: WorkspaceSettings = { modelChoiceId: 'test/model', concurrency: 5 };

type EditEntry = { documentId: string; edit: ParsedEdit; source: 'tracked' | 'diff' };

function edit(documentId: string, text = 'edit text', source: 'tracked' | 'diff' = 'tracked'): EditEntry {
  return { documentId, edit: { kind: 'deletion', text, context: `... ${text} ...` }, source };
}

function mockItems(items: unknown[]): void {
  vi.mocked(chatJson).mockResolvedValue({ items });
}

function version(overrides: Partial<PlaybookVersion> = {}): PlaybookVersion {
  return {
    id: 'v1',
    playbookId: 'pb1',
    version: 1,
    name: 'Commercial Lease',
    contractType: 'Lease',
    systemPrompt: 'sys',
    formatPrompt: 'fmt',
    clauses: [],
    changeSummary: '',
    publishedAt: 1,
    publishedByUserId: 'u1',
    schemaVersion: 7,
    ...overrides,
  };
}

describe('buildChangeset', () => {
  it('classifies an unchanged clause as confirm', async () => {
    const v = version({
      clauses: [{
        id: 'c1',
        title: 'Assignment',
        extractPrompt: 'x',
        standardPosition: { text: 'Tenant may not assign without landlord consent.', origin: 'authored', reviewedByHuman: true },
      }],
    });
    mockItems([{
      clause_title: 'Assignment',
      proposed_text: 'Tenant may not assign without landlord consent.',
      rationale: 'This deal kept our standard assignment wording untouched.',
      edit_ids: ['e1'],
    }]);
    const changeset = await buildChangeset(v, [edit('doc-a')], 'Brookvale — executed', settings);
    expect(changeset.items).toHaveLength(1);
    const item = changeset.items[0];
    expect(item.kind).toBe('confirm');
    expect(item.clauseId).toBe('c1');
  });

  it('classifies a changed clause as drift, with the current text alongside', async () => {
    const v = version({
      clauses: [{
        id: 'c1',
        title: 'Assignment',
        extractPrompt: 'x',
        standardPosition: { text: 'Tenant may not assign without landlord consent.', origin: 'authored', reviewedByHuman: true },
      }],
    });
    mockItems([{
      clause_title: 'Assignment',
      proposed_text: 'Tenant may assign to an affiliate without consent.',
      rationale: 'The tenant struck the consent requirement for affiliate transfers.',
      edit_ids: ['e1'],
    }]);
    const changeset = await buildChangeset(v, [edit('doc-a')], 'Brookvale — our markup', settings);
    const item = changeset.items[0];
    expect(item.kind).toBe('drift');
    expect(item.currentText).toBe(v.clauses[0].standardPosition!.text);
    expect(item.proposedText).not.toBe(item.currentText);
  });

  it('classifies something the version never covered as new_clause, with no clauseId', async () => {
    const v = version({ clauses: [] });
    mockItems([{
      clause_title: 'Force Majeure — Pandemic Carve-out',
      proposed_text: 'Includes a specific pandemic carve-out.',
      rationale: 'Raised in this deal though the playbook has no clause for it.',
      edit_ids: ['e1'],
    }]);
    const changeset = await buildChangeset(v, [edit('doc-a')], 'Brookvale — their draft', settings);
    const item = changeset.items[0];
    expect(item.kind).toBe('new_clause');
    expect('clauseId' in item).toBe(false);
  });

  it('every item carries a rationale — a proposal without a reason is not reviewable', async () => {
    const v = version({
      clauses: [{ id: 'c1', title: 'Assignment', extractPrompt: 'x' }],
    });
    mockItems([
      { clause_title: 'Assignment', proposed_text: 'x', rationale: 'Because the deal said so.', edit_ids: ['e1'] },
      { clause_title: 'New Topic', proposed_text: 'y', rationale: 'Raised twice.', edit_ids: ['e2'] },
    ]);
    const changeset = await buildChangeset(
      v, [edit('doc-a'), edit('doc-b')], 'Brookvale', settings,
    );
    expect(changeset.items.length).toBeGreaterThan(0);
    for (const item of changeset.items) expect(item.rationale.trim()).not.toBe('');
  });

  it('every item starts open', async () => {
    const v = version({ clauses: [{ id: 'c1', title: 'Assignment', extractPrompt: 'x' }] });
    mockItems([
      { clause_title: 'Assignment', proposed_text: 'x', rationale: 'Because the deal said so.', edit_ids: ['e1'] },
    ]);
    const changeset = await buildChangeset(v, [edit('doc-a')], 'Brookvale', settings);
    for (const item of changeset.items) expect(item.decision).toBe('open');
  });

  it('never calls the model when there are no edits', async () => {
    const changeset = await buildChangeset(version(), [], 'Brookvale', settings);
    expect(changeset.items).toEqual([]);
    expect(chatJson).not.toHaveBeenCalled();
  });

  it('drops an item with no rationale rather than defaulting one', async () => {
    const v = version({ clauses: [{ id: 'c1', title: 'Assignment', extractPrompt: 'x' }] });
    mockItems([{ clause_title: 'Assignment', proposed_text: 'x', rationale: '   ', edit_ids: ['e1'] }]);
    const changeset = await buildChangeset(v, [edit('doc-a')], 'Brookvale', settings);
    expect(changeset.items).toEqual([]);
  });

  it('drops an item resting on no real edit at all (an invented edit id)', async () => {
    const v = version({ clauses: [{ id: 'c1', title: 'Assignment', extractPrompt: 'x' }] });
    mockItems([{ clause_title: 'Assignment', proposed_text: 'x', rationale: 'x', edit_ids: ['does-not-exist'] }]);
    const changeset = await buildChangeset(v, [edit('doc-a')], 'Brookvale', settings);
    expect(changeset.items).toEqual([]);
  });

  it('never proposes an item for a clause the deal did not address', async () => {
    // The model is the one asked not to do this (prompt-level), but nothing
    // here manufactures a `confirm` for a clause with zero items returned —
    // an empty model response is a legitimate, honest "the deal said
    // nothing about the rest of the playbook".
    const v = version({ clauses: [{ id: 'c1', title: 'Assignment', extractPrompt: 'x' }] });
    mockItems([]);
    const changeset = await buildChangeset(v, [edit('doc-a')], 'Brookvale', settings);
    expect(changeset.items).toEqual([]);
  });

  it('matches an existing clause title case- and whitespace-insensitively', async () => {
    const v = version({
      clauses: [{
        id: 'c1', title: 'Governing   Law', extractPrompt: 'x',
        standardPosition: { text: 'English law.', origin: 'authored', reviewedByHuman: true },
      }],
    });
    mockItems([{ clause_title: 'governing law', proposed_text: 'New York law.', rationale: 'x', edit_ids: ['e1'] }]);
    const changeset = await buildChangeset(v, [edit('doc-a')], 'Brookvale', settings);
    expect(changeset.items[0].clauseId).toBe('c1');
    expect(changeset.items[0].kind).toBe('drift');
  });

  it('carries the basis as RedlineEdit objects tagged with the matched clause', async () => {
    const v = version({ clauses: [{ id: 'c1', title: 'Assignment', extractPrompt: 'x' }] });
    mockItems([{ clause_title: 'Assignment', proposed_text: 'x', rationale: 'x', edit_ids: ['e1'] }]);
    const changeset = await buildChangeset(v, [edit('doc-a', 'struck the consent requirement')], 'Brookvale', settings);
    const basis = changeset.items[0].basis;
    expect(basis).toHaveLength(1);
    expect(basis[0].documentId).toBe('doc-a');
    expect(basis[0].text).toBe('struck the consent requirement');
    expect(basis[0].clauseRef).toBe('Assignment');
    expect(basis[0].source).toBe('tracked');
  });

  it('stamps the changeset\'s own identity fields', async () => {
    mockItems([]);
    const v = version({ playbookId: 'pb-x', id: 'v-x' });
    const changeset = await buildChangeset(v, [edit('doc-a')], 'a source summary', settings);
    expect(changeset.playbookId).toBe('pb-x');
    expect(changeset.fromVersionId).toBe('v-x');
    expect(changeset.sourceSummary).toBe('a source summary');
    expect(changeset.id).toBeTruthy();
    expect(typeof changeset.createdAt).toBe('number');
    expect('publishedVersionId' in changeset).toBe(false);
  });
});
