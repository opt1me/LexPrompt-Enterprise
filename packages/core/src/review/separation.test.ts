import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { CLAUSE_SCHEMA, buildClausePrompt, extractClause } from './extractClause.ts';
import { COLLECTION_CLAUSE_SCHEMA, extractCollectionClause } from './extractCollectionClause.ts';
import { buildCollectionPrompt } from '../domain/collectionPrompt.ts';
import type { CollectionMember } from '../domain/collectionOrder.ts';
import type { DocumentFile, PlaybookClause, PlaybookVersion } from '../domain/types.ts';
import type { ModelClient } from '../model/client.ts';
import type { WorkspaceSettings } from '../api/records.ts';

/**
 * "extractCollectionClause is a SEPARATE function with its own prompt and its
 * own schema, deliberately, so the single-document path cannot drift by
 * sharing code that later has to special-case a collection" (CLAUDE.md).
 *
 * That is a design rule with no mechanical enforcement, which in this
 * codebase is the shape a rule takes right before it stops being true. The
 * pressure to merge them is real and reasonable-sounding — the two files
 * genuinely do look similar — so the argument against merging is written
 * down here, beside a test that fails if someone tries.
 *
 * The two answer different questions. A standalone review asks what ONE
 * document says about a clause. A collection review asks what several
 * documents, read in the order a person recorded, say NOW — a synthesis no
 * document contains, which is why it comes back with a per-document
 * derivation trail and starts `unconfirmed`. A shared prompt would have to
 * grow a branch for that, and the branch is exactly where the standalone
 * path acquires a collection's assumptions.
 */

const clause: PlaybookClause = {
  id: 'c1', title: 'Rent Review', extractPrompt: 'Describe how rent is reviewed.',
};

const template: PlaybookVersion = {
  id: 't1', name: 'Lease', contractType: 'Lease',
  systemPrompt: 'You are a reviewer.', formatPrompt: 'Quote verbatim.',
  clauses: [clause], playbookId: 'pb', version: 1, changeSummary: '',
  publishedAt: 0, publishedByUserId: '', schemaVersion: 7,
};

const doc = {
  id: 'd1', name: 'lease.pdf', kind: 'pdf' as const,
  text: 'Rent is reviewed every five years.',
} as unknown as DocumentFile;

const members: CollectionMember<DocumentFile>[] = [
  { documentId: 'd1', document: doc, kind: 'original', position: 1 },
  {
    documentId: 'd2', kind: 'varies', position: 2,
    document: { ...doc, id: 'd2', name: 'variation.pdf', text: 'Rent is now reviewed annually.' },
  },
];

const SRC = (file: string): string => readFileSync(path.resolve(__dirname, file), 'utf8');

/** Import STATEMENTS only, at the start of a line. Both modules mention the
 *  other at length in their docstrings, on purpose; a docstring line begins
 *  with whitespace and an asterisk and is not an import. */
const importsFrom = (code: string, spec: string): boolean =>
  new RegExp(`^import[^\\n]*from '${spec.replace(/\./g, '\\.')}'`, 'm').test(code);

describe('the two extractors stay separate (CLAUDE.md)', () => {
  it('neither imports the other', () => {
    const single = SRC('extractClause.ts');
    const collection = SRC('extractCollectionClause.ts');
    // Sanity: the scanner is reading real files with real imports in them,
    // so its silence on the two below means something.
    expect(importsFrom(single, '../domain/verification.ts')).toBe(true);
    expect(importsFrom(collection, '../domain/verification.ts')).toBe(true);

    expect(importsFrom(collection, './extractClause.ts')).toBe(false);
    expect(importsFrom(single, './extractCollectionClause.ts')).toBe(false);
  });

  it('asks for different things back — the schemas are not the same object or shape', () => {
    expect(COLLECTION_CLAUSE_SCHEMA).not.toBe(CLAUSE_SCHEMA);
    // The standalone answer is one document's summary with a risk level.
    expect(CLAUSE_SCHEMA.required).toContain('summary');
    expect(CLAUSE_SCHEMA.required).toContain('risk_level');
    expect(Object.keys(CLAUSE_SCHEMA.properties)).not.toContain('trail');
    // The collection answer is a derivation plus the position it derives —
    // never a bare conclusion, which would be an assertion with no argument.
    expect(COLLECTION_CLAUSE_SCHEMA.required).toContain('trail');
    expect(COLLECTION_CLAUSE_SCHEMA.required).toContain('net_position');
    expect(Object.keys(COLLECTION_CLAUSE_SCHEMA.properties)).not.toContain('summary');
  });

  it('the two prompt BUILDERS produce different prompts for the same clause', () => {
    const single = buildClausePrompt(doc, clause, template);
    const { prompt: collection } = buildCollectionPrompt(members, clause, template, 100_000);

    expect(single).not.toBe(collection);
    // The standalone prompt names ONE document and never numbers it — a
    // `DOCUMENT N` label is the collection prompt's whole addressing scheme,
    // and every citation and trail step resolves against it.
    expect(single).toContain('DOCUMENT: lease.pdf');
    expect(single).not.toContain('DOCUMENT 1');
    // The collection prompt numbers every member.
    expect(collection).toContain('DOCUMENT 1');
    expect(collection).toContain('DOCUMENT 2');
    expect(collection).not.toContain('DOCUMENT: lease.pdf');
  });

  it('and each extractor SENDS its own prompt — checked on the request that leaves', async () => {
    /*
     * The test above compares the two prompt BUILDERS. This one compares
     * what each extractor actually put on the wire, because those are
     * different claims: a collection path that still imported
     * `buildCollectionPrompt` and then handed `buildClausePrompt`'s output
     * to the model would satisfy every check above it while reviewing a
     * two-document collection as though it were one document — producing a
     * `net_position` synthesised from a prompt that never showed the model
     * the amendment.
     */
    const settings: WorkspaceSettings = {
      modelChoiceId: 'm', concurrency: 1,
      modelSupportsImages: true, modelSupportsStructuredOutput: true, modelContextLength: 1_000_000,
    };
    const sent: Record<string, unknown>[] = [];
    const client = {
      chatJson: async (req: Record<string, unknown>) => {
        sent.push(req);
        return {
          summary: 's', citations: [], risk_level: 'Low', risk_analysis: 'r',
          trail: [
            { document: 1, effect: 'e', citations: [] },
            { document: 2, effect: 'e', citations: [] },
          ],
          net_position: 'n',
        };
      },
    } as unknown as ModelClient;

    await extractClause(client, doc, clause, template, settings);
    await extractCollectionClause(client, members, clause, template, settings);

    // Found BY PURPOSE, never by call order: each request has to be right on
    // its own terms, and an assertion keyed to which call happened first
    // would pass for the wrong reason the day someone reorders the awaits.
    expect(sent.map(r => r.purpose).sort())
      .toEqual(['review.clause', 'review.collection_clause']);
    const userFor = (purpose: string): string =>
      String(sent.find(r => r.purpose === purpose)!.user);
    const single = userFor('review.clause');
    const collection = userFor('review.collection_clause');

    expect(single).not.toBe(collection);
    expect(collection).toContain('DOCUMENT 2');
    expect(collection).toContain('variation.pdf');
    expect(single).not.toContain('DOCUMENT 2');
    expect(single).toContain('DOCUMENT: lease.pdf');
  });
});
