/**
 * Row <-> wire mapping, in one place.
 *
 * Three conversions that every table needs and that every table would
 * otherwise get slightly differently:
 *
 *  - `timestamptz` <-> the epoch milliseconds `types.ts` uses everywhere
 *    (`createdAt: number`). `pg` hands back a `Date`; sending one back needs
 *    `new Date(ms)`, not a bare number, or Postgres reads it as seconds.
 *  - NULL <-> ABSENT. `structuredClone` preserves an `undefined`-valued key
 *    (CLAUDE.md), and so does `JSON.stringify` — no, it drops it, which is
 *    the *other* half of the same trap: a wire record built by spreading
 *    `{ collectionId: undefined }` loses the key over JSON and keeps it in
 *    IndexedDB, so the two stores disagree about whether a document is
 *    ungrouped. `absentUnless` makes the intent explicit at every site.
 *  - The empty-string attribution. `''` in, NULL in the column, `''` out —
 *    so a caller reading `Matter.ownerId: string` still gets a string.
 *
 * ---
 *
 * ## Why the wire types below are declared here, not imported
 *
 * The Task 8 brief calls for importing `Matter`, `DocumentRecord`,
 * `Collection`, `Playbook`, `PlaybookVersion`, `Review`, `Changeset`,
 * `PlaybookDraft` and `Finding` from `src/types.ts` — the browser app's own
 * type module — directly. That does not typecheck.
 *
 * Verified directly, not assumed: `import type { Matter } from
 * '../../../../src/types.ts'` alone — nothing else, not even a `Changeset`
 * in sight — fails `apps/api`'s typecheck with 22 errors, every one of them
 * inside `src/lib/docxRedlines.ts` ("Cannot find name 'Document'",
 * `'DOMParser'`, `'Element'`). The cause is one line, `types.ts:325`:
 * `ChangesetItem.kind` is typed `import('./lib/docxRedlines').RedlineEditKind`
 * — an inline type import that pulls the WHOLE of `docxRedlines.ts` into
 * whatever program imports `types.ts`, for ANY export, because TypeScript
 * type-checks a source file in full once it enters the program, not just
 * the members another file happens to use. `docxRedlines.ts` is browser
 * code that reads a `.docx`'s XML via `DOMParser`/`Element`, and it
 * typechecks fine under the web app's own `lib: ["ES2022","DOM",…]`
 * tsconfig — but `apps/api` is a Node service with `lib: ["ES2022"]` and no
 * DOM, on purpose (S25/S28 and every other service-side type in this repo
 * assume there is no `window`), and adding DOM globals repo-wide to work
 * around one browser-only field would remove the one thing that catches a
 * server file reaching for a browser API by mistake.
 *
 * So the shapes below are declared locally, kept structurally IDENTICAL to
 * their same-named counterparts in `src/types.ts` (TypeScript's structural
 * typing then makes a value built here assignable to the real browser-side
 * type with no cast), and jsonb-blob fields that this layer never inspects
 * — `Playbook.draft`, `PlaybookVersion.clauses`, `Review.target`/
 * `findings`/`playbookSnapshot`, `Changeset.items` — are typed loosely
 * (`unknown` / `unknown[]`) rather than pulling in their own nested real
 * types, since `rows.ts`'s job is the OUTER scalar/timestamp/null mapping,
 * not deep validation of a blob it stores and returns unread. Keep these
 * side by side with `src/types.ts` when either changes — the sibling-drift
 * risk CLAUDE.md warns about, one layer down.
 */

// ---------------------------------------------------------------------------
// Locally declared wire shapes (see the module docstring for why).
// ---------------------------------------------------------------------------

export interface Matter {
  id: string;
  name: string;
  client?: string;
  reference?: string;
  ownerId: string;
  createdAt: number;
  updatedAt: number;
  /** The optimistic-concurrency token (§8), and the ONE field R3's seam
   *  could not absorb — see `src/types.ts`'s own note on it. Optional
   *  because a record that has never been read from the server (a freshly
   *  minted `newMatter`, an imported one) has no version to state, and that
   *  absence is a claim: "I believe this is a create." Never sent back as
   *  `version: undefined`; `absentUnless` keeps the key off the wire. */
  version?: number;
}

export interface DocumentRecord {
  id: string;
  matterId: string;
  name: string;
  kind: 'pdf' | 'docx' | 'txt';
  text: string;
  parseError?: string;
  markupNotice?: string;
  byteSize: number;
  addedAt: number;
  addedByUserId: string;
  role: 'base' | 'varies' | 'standalone';
  collectionId?: string;
  documentDate?: number;
}

export interface Collection {
  id: string;
  matterId: string;
  name: string;
  baseDocumentId: string;
  variesDocumentIds: string[];
  createdAt: number;
  createdByUserId: string;
}

export interface Playbook {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  currentVersionId?: string;
  /** `PlaybookDraft` on the wire — opaque jsonb at this layer. */
  draft?: unknown;
  schemaVersion: number;
}

export interface PlaybookVersion {
  id: string;
  playbookId: string;
  version: number;
  name: string;
  contractType: string;
  systemPrompt: string;
  formatPrompt: string;
  riskTolerance?: string;
  /** `PlaybookClause[]` on the wire — opaque jsonb at this layer. */
  clauses: unknown[];
  changeSummary: string;
  publishedAt: number;
  publishedByUserId: string;
  schemaVersion: number;
}

/** Mirrors `src/types.ts`'s own derivation: a version's content minus
 *  everything only a publish can assign. */
export type PlaybookDraft =
  Omit<PlaybookVersion, 'id' | 'playbookId' | 'version' | 'publishedAt' | 'publishedByUserId' | 'schemaVersion'>;

export interface Review {
  id: string;
  matterId: string;
  /** `PlaybookVersion` on the wire — opaque jsonb at this layer. */
  playbookSnapshot: unknown;
  playbookVersionId?: string;
  documentIds: string[];
  /** `ReviewTarget` on the wire — opaque jsonb at this layer. */
  target: unknown;
  /** `Record<string, Record<string, Finding>>` on the wire — opaque jsonb
   *  at this layer. */
  findings: unknown;
  modelId: string;
  startedAt: number;
  completedAt?: number;
  cancelledAt?: number;
  createdByUserId: string;
}

export interface Changeset {
  id: string;
  playbookId: string;
  fromVersionId: string;
  sourceSummary: string;
  /** `ChangesetItem[]` on the wire — opaque jsonb at this layer, and the
   *  field that would otherwise pull in `docxRedlines.ts` (see the module
   *  docstring). */
  items: unknown[];
  createdAt: number;
  createdByUserId: string;
  publishedVersionId?: string;
}

// ---------------------------------------------------------------------------
// Shared conversions.
// ---------------------------------------------------------------------------

/**
 * NULL <-> ABSENT, made explicit at every call site.
 *
 * `value === null` (a column with nothing in it) and `value === undefined`
 * (a field this layer chooses not to set) are treated identically: both
 * become an ABSENT key on the wire object, never a `key: undefined` one —
 * `structuredClone` (how IndexedDB writes every record) preserves an
 * `undefined`-valued key, so returning `{ collectionId: undefined }` would
 * persist a claim that a comparison or value was attempted when it was not.
 */
export function absentUnless<K extends string, V>(key: K, value: V | null | undefined):
  Record<K, V> | Record<string, never> {
  return value === null || value === undefined ? {} : ({ [key]: value } as Record<K, V>);
}

/** `timestamptz` -> epoch milliseconds. `pg`'s default type parser already
 *  hands back a `Date` for a `timestamptz` column. */
function epochOf(d: Date): number {
  return d.getTime();
}

/** Epoch milliseconds -> `timestamptz`. A bare number sent as a parameter
 *  for a `timestamptz` column is read by Postgres as a Unix epoch in
 *  SECONDS, not milliseconds — `new Date(ms)` is what makes this correct,
 *  not a nicety. */
function dateOf(ms: number): Date {
  return new Date(ms);
}

/**
 * A `bigint` column as a number.
 *
 * `pg` returns `bigint` as a STRING, deliberately — a 64-bit value does not
 * fit a JS number — and `version` is compared for equality on the way back
 * in, so `'3' !== 3` would make every optimistic-concurrency check fail
 * against a row it should have matched. A version counter reaches
 * `Number.MAX_SAFE_INTEGER` after nine quadrillion saves of one record, so
 * the narrowing is safe here in a way it would not be for an arbitrary
 * `bigint` column.
 */
function bigintOf(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  return typeof value === 'number' ? value : Number(value);
}

/** The empty-string attribution (P16): `''` on the wire means "nobody
 *  attributed this", which is a fact about the DATA, not a valid foreign
 *  key — so it goes into the column as NULL, never as a zero-length string
 *  that would fail the `references app_user(id)` check outright. */
function useridToColumn(id: string): string | null {
  return id === '' ? null : id;
}

/** NULL back to `''`, so a caller reading `Matter.ownerId: string` (never
 *  optional on the wire) still gets a string rather than `null`. */
function useridFromColumn(id: string | null): string {
  return id ?? '';
}

// ---------------------------------------------------------------------------
// matter
// ---------------------------------------------------------------------------

export interface MatterRow {
  id: string;
  workspace_id: string;
  name: string;
  client: string | null;
  reference: string | null;
  owner_id: string | null;
  created_at: Date;
  updated_at: Date;
  /** `bigint`, which `pg` hands back as a STRING — see `bigintOf`. Optional
   *  on this interface because `toMatterRow` never sets it: the database
   *  owns a row's version and a client that could set one could defeat the
   *  check the column exists for. */
  version?: string | number | null;
}

export function toMatterRow(x: Matter, workspaceId: string): MatterRow {
  return {
    id: x.id,
    workspace_id: workspaceId,
    name: x.name,
    client: x.client ?? null,
    reference: x.reference ?? null,
    owner_id: useridToColumn(x.ownerId),
    created_at: dateOf(x.createdAt),
    updated_at: dateOf(x.updatedAt),
  };
}

export function fromMatterRow(row: MatterRow): Matter {
  return {
    id: row.id,
    name: row.name,
    ...absentUnless('client', row.client),
    ...absentUnless('reference', row.reference),
    ownerId: useridFromColumn(row.owner_id),
    createdAt: epochOf(row.created_at),
    updatedAt: epochOf(row.updated_at),
    ...absentUnless('version', bigintOf(row.version)),
  };
}

// ---------------------------------------------------------------------------
// document
// ---------------------------------------------------------------------------

/** Fields a `DocumentRecord` does not carry (see the migration's own
 *  comments): the Blob this document's bytes live in is a separate
 *  repository concern, and `parseState` is derived here rather than stored
 *  on the wire type at all. */
export interface DocumentRowExtra {
  mime: string;
  blobKey: string;
  contentSha256?: string;
}

export interface DocumentRow {
  id: string;
  workspace_id: string;
  matter_id: string;
  name: string;
  doc_type: 'pdf' | 'docx' | 'txt';
  text: string;
  parse_state: 'pending' | 'parsed' | 'failed';
  parse_error: string | null;
  markup_notice: string | null;
  byte_size: number;
  mime: string;
  blob_key: string;
  content_sha256: string | null;
  role: 'base' | 'varies' | 'standalone';
  collection_id: string | null;
  document_date: Date | null;
  added_at: Date;
  added_by_user_id: string | null;
}

export function toDocumentRow(x: DocumentRecord, workspaceId: string, extra: DocumentRowExtra): DocumentRow {
  return {
    id: x.id,
    workspace_id: workspaceId,
    matter_id: x.matterId,
    name: x.name,
    doc_type: x.kind,
    text: x.text,
    // Not on the wire type: the browser extracts text synchronously before
    // a DocumentRecord ever exists, so by the time one is written parsing
    // has already either succeeded (with or without a caveat) or failed.
    parse_state: x.parseError ? 'failed' : 'parsed',
    parse_error: x.parseError ?? null,
    markup_notice: x.markupNotice ?? null,
    byte_size: x.byteSize,
    mime: extra.mime,
    blob_key: extra.blobKey,
    content_sha256: extra.contentSha256 ?? null,
    role: x.role,
    collection_id: x.collectionId ?? null,
    document_date: x.documentDate === undefined ? null : dateOf(x.documentDate),
    added_at: dateOf(x.addedAt),
    added_by_user_id: useridToColumn(x.addedByUserId),
  };
}

export function fromDocumentRow(row: DocumentRow): DocumentRecord {
  return {
    id: row.id,
    matterId: row.matter_id,
    name: row.name,
    kind: row.doc_type,
    text: row.text,
    ...absentUnless('parseError', row.parse_error),
    ...absentUnless('markupNotice', row.markup_notice),
    byteSize: row.byte_size,
    addedAt: epochOf(row.added_at),
    addedByUserId: useridFromColumn(row.added_by_user_id),
    role: row.role,
    ...absentUnless('collectionId', row.collection_id),
    ...absentUnless('documentDate', row.document_date === null ? null : epochOf(row.document_date)),
  };
}

// ---------------------------------------------------------------------------
// collection
// ---------------------------------------------------------------------------

export interface CollectionRow {
  id: string;
  workspace_id: string;
  matter_id: string;
  name: string;
  base_document_id: string;
  /** A jsonb ARRAY. `pg`'s default type parser hands this back already
   *  parsed into a JS array; sending one back is a JSON STRING (`pg` would
   *  otherwise encode a bare JS array as a Postgres native ARRAY literal,
   *  not as jsonb) — see the module docstring's note on the asymmetry. */
  varies_document_ids: unknown;
  created_at: Date;
  created_by_user_id: string | null;
}

export function toCollectionRow(x: Collection, workspaceId: string): CollectionRow {
  return {
    id: x.id,
    workspace_id: workspaceId,
    matter_id: x.matterId,
    name: x.name,
    base_document_id: x.baseDocumentId,
    varies_document_ids: JSON.stringify(x.variesDocumentIds),
    created_at: dateOf(x.createdAt),
    created_by_user_id: useridToColumn(x.createdByUserId),
  };
}

export function fromCollectionRow(row: CollectionRow): Collection {
  const varies = typeof row.varies_document_ids === 'string'
    ? JSON.parse(row.varies_document_ids) as string[]
    : row.varies_document_ids as string[];
  return {
    id: row.id,
    matterId: row.matter_id,
    name: row.name,
    baseDocumentId: row.base_document_id,
    variesDocumentIds: varies,
    createdAt: epochOf(row.created_at),
    createdByUserId: useridFromColumn(row.created_by_user_id),
  };
}

// ---------------------------------------------------------------------------
// playbook
// ---------------------------------------------------------------------------

export interface PlaybookRow {
  id: string;
  workspace_id: string;
  name: string;
  created_at: Date;
  updated_at: Date;
  current_version_id: string | null;
  draft: unknown;
  schema_version: number;
}

export function toPlaybookRow(x: Playbook, workspaceId: string): PlaybookRow {
  return {
    id: x.id,
    workspace_id: workspaceId,
    name: x.name,
    created_at: dateOf(x.createdAt),
    updated_at: dateOf(x.updatedAt),
    current_version_id: x.currentVersionId ?? null,
    draft: x.draft === undefined ? null : JSON.stringify(x.draft),
    schema_version: x.schemaVersion,
    // `created_by_user_id` is NOT set here: nothing on `Playbook` sources
    // it (see the migration's own comment on that column), so it is left
    // to the database's NULL default rather than guessed at.
  };
}

export function fromPlaybookRow(row: PlaybookRow): Playbook {
  const draft = typeof row.draft === 'string' ? JSON.parse(row.draft) as unknown : row.draft;
  return {
    id: row.id,
    name: row.name,
    createdAt: epochOf(row.created_at),
    updatedAt: epochOf(row.updated_at),
    ...absentUnless('currentVersionId', row.current_version_id),
    ...absentUnless('draft', draft),
    schemaVersion: row.schema_version,
  };
}

// ---------------------------------------------------------------------------
// playbook_version — immutable; there is deliberately no update path.
// ---------------------------------------------------------------------------

export interface PlaybookVersionRow {
  id: string;
  workspace_id: string;
  playbook_id: string;
  version_number: number;
  content: unknown;
  summary: string | null;
  published_at: Date;
  published_by_user_id: string | null;
}

export function toPlaybookVersionRow(x: PlaybookVersion, workspaceId: string): PlaybookVersionRow {
  const { id: _id, playbookId: _playbookId, version: _version, publishedAt: _publishedAt,
    publishedByUserId: _publishedByUserId, ...content } = x;
  return {
    id: x.id,
    workspace_id: workspaceId,
    playbook_id: x.playbookId,
    version_number: x.version,
    content: JSON.stringify(content),
    // Mirrors `content.changeSummary`, so a version-history list can read
    // it without parsing jsonb — the same reason `playbook.name` mirrors
    // its current version's.
    summary: x.changeSummary,
    published_at: dateOf(x.publishedAt),
    published_by_user_id: useridToColumn(x.publishedByUserId),
  };
}

export function fromPlaybookVersionRow(row: PlaybookVersionRow): PlaybookVersion {
  const content = (typeof row.content === 'string' ? JSON.parse(row.content) : row.content) as
    Omit<PlaybookVersion, 'id' | 'playbookId' | 'version' | 'publishedAt' | 'publishedByUserId'>;
  return {
    ...content,
    id: row.id,
    playbookId: row.playbook_id,
    version: row.version_number,
    publishedAt: epochOf(row.published_at),
    publishedByUserId: useridFromColumn(row.published_by_user_id),
  };
}

// ---------------------------------------------------------------------------
// review
// ---------------------------------------------------------------------------

export interface ReviewRow {
  id: string;
  workspace_id: string;
  matter_id: string;
  playbook_snapshot: unknown;
  playbook_version_id: string | null;
  document_ids: unknown;
  target: unknown;
  findings: unknown;
  model_id: string;
  started_at: Date;
  completed_at: Date | null;
  cancelled_at: Date | null;
  created_by_user_id: string | null;
}

export function toReviewRow(x: Review, workspaceId: string): ReviewRow {
  return {
    id: x.id,
    workspace_id: workspaceId,
    matter_id: x.matterId,
    playbook_snapshot: JSON.stringify(x.playbookSnapshot),
    playbook_version_id: x.playbookVersionId ?? null,
    document_ids: JSON.stringify(x.documentIds),
    target: JSON.stringify(x.target),
    findings: JSON.stringify(x.findings),
    model_id: x.modelId,
    started_at: dateOf(x.startedAt),
    completed_at: x.completedAt === undefined ? null : dateOf(x.completedAt),
    cancelled_at: x.cancelledAt === undefined ? null : dateOf(x.cancelledAt),
    created_by_user_id: useridToColumn(x.createdByUserId),
  };
}

function parsedJson(value: unknown): unknown {
  return typeof value === 'string' ? JSON.parse(value) : value;
}

export function fromReviewRow(row: ReviewRow): Review {
  return {
    id: row.id,
    matterId: row.matter_id,
    playbookSnapshot: parsedJson(row.playbook_snapshot),
    ...absentUnless('playbookVersionId', row.playbook_version_id),
    documentIds: parsedJson(row.document_ids) as string[],
    target: parsedJson(row.target),
    findings: parsedJson(row.findings),
    modelId: row.model_id,
    startedAt: epochOf(row.started_at),
    ...absentUnless('completedAt', row.completed_at === null ? null : epochOf(row.completed_at)),
    ...absentUnless('cancelledAt', row.cancelled_at === null ? null : epochOf(row.cancelled_at)),
    createdByUserId: useridFromColumn(row.created_by_user_id),
  };
}

// ---------------------------------------------------------------------------
// changeset
// ---------------------------------------------------------------------------

export interface ChangesetRow {
  id: string;
  workspace_id: string;
  playbook_id: string;
  from_version_id: string;
  source_summary: string;
  items: unknown;
  created_at: Date;
  created_by_user_id: string | null;
  published_version_id: string | null;
}

export function toChangesetRow(x: Changeset, workspaceId: string): ChangesetRow {
  return {
    id: x.id,
    workspace_id: workspaceId,
    playbook_id: x.playbookId,
    from_version_id: x.fromVersionId,
    source_summary: x.sourceSummary,
    items: JSON.stringify(x.items),
    created_at: dateOf(x.createdAt),
    created_by_user_id: useridToColumn(x.createdByUserId),
    published_version_id: x.publishedVersionId ?? null,
  };
}

export function fromChangesetRow(row: ChangesetRow): Changeset {
  return {
    id: row.id,
    playbookId: row.playbook_id,
    fromVersionId: row.from_version_id,
    sourceSummary: row.source_summary,
    items: parsedJson(row.items) as unknown[],
    createdAt: epochOf(row.created_at),
    createdByUserId: useridFromColumn(row.created_by_user_id),
    ...absentUnless('publishedVersionId', row.published_version_id),
  };
}
