import type { Db } from '../db/pool.ts';
import type { BlobStore } from '../blob/store.ts';
import { parseDocument } from './parseDocument.ts';

/**
 * The parse worker (§9, P12): the ONE writer of a `parse_state` change.
 *
 * Stage 2 stored `parse_state` from the browser's own parse and said "Stage
 * 3 changes only who writes it". The upload now stores the bytes, writes the
 * row as `'pending'` and RETURNS; this reads the bytes back and writes what
 * it found. `'pending'` has been in the check constraint since Stage 2 and
 * unused; it starts being used here.
 *
 * ## `failed` is a real answer with a real message
 *
 * A parse that throws writes `parse_state = 'failed'` and a `parse_error`
 * naming the cause, and the document is then REFUSED as a review target
 * (`routes/runs.ts`). It is never `'parsed'` with empty text: *"a document
 * silently marked parsed with no text is the founding defect wearing a
 * database column"* — 005's own words, in the migration comment this worker
 * makes true.
 *
 * A document whose bytes are MISSING is `failed` too, with a different
 * sentence. "We could not find the file" and "the file is not readable" send
 * a person to two different places.
 *
 * ## Claiming, without a lease column
 *
 * `for update skip locked` inside the transaction that does the parse.
 * There is no `parse_lease_expires_at` because there does not need to be: a
 * worker that dies mid-parse loses its transaction, the row's `'pending'`
 * survives, and the next poll picks it up. A lease would add a column, a
 * clock and a reaper to reproduce what a rollback already does.
 *
 * That does mean a transaction stays open for the length of a parse. It is
 * bounded by the bytes the upload already accepted (`API_MAX_BODY_BYTES`),
 * it holds one row lock nothing else contends for, and `lexprompt_worker`'s
 * `statement_timeout` (60s, set where the role is created) bounds any single
 * statement inside it.
 */

export interface ParseWorkerDeps {
  /** The WORKER's connection — `lexprompt_worker`, which holds
   *  `update (text, parse_state, parse_error)` on `document` and nothing
   *  else on it. */
  db: Db;
  blobs: BlobStore;
  pollMs: number;
}

interface PendingRow {
  id: string;
  workspace_id: string;
  name: string;
  mime: string;
  blob_key: string;
}

/**
 * One pending document, or `false` when there was none.
 *
 * Exported so a test can drive exactly one step rather than racing a loop —
 * a suite that starts a polling worker and waits proves whatever the clock
 * happened to allow.
 */
export async function parseOneDocument(deps: ParseWorkerDeps): Promise<boolean> {
  return deps.db.tx(async t => {
    const rows = await t.query<PendingRow>(
      `select id, workspace_id, name, mime, blob_key from document
        where parse_state = 'pending'
        order by added_at asc, id asc
        for update skip locked
        limit 1`);
    const doc = rows[0];
    if (!doc) return false;

    let bytes: Buffer | null = null;
    let fetchError: string | null = null;
    try {
      bytes = (await deps.blobs.get(doc.blob_key))?.bytes ?? null;
    } catch (error) {
      // A store that REFUSED is not a store that had nothing. Reported as
      // its own sentence for the same reason `documents.ts` keeps its two
      // 404s apart: "your file is gone" and "we could not reach storage"
      // send a person to two different places, and the second is somebody
      // else's to fix.
      fetchError = error instanceof Error ? error.message : String(error);
    }

    if (fetchError !== null) {
      await fail(t, doc, `LexPrompt could not reach the file store to read ${doc.name} `
        + `(${fetchError}). The document's record is intact; try again once storage is `
        + 'reachable.');
      return true;
    }
    if (!bytes) {
      await fail(t, doc, `The original file for ${doc.name} is not in storage, so there is `
        + 'nothing to read. Its record is still here; add the file again.');
      return true;
    }

    const parsed = await parseDocument(bytes, doc.mime, doc.name);
    if (parsed.parseError) {
      await fail(t, doc, `${doc.name} could not be read (${parsed.parseError}).`);
      return true;
    }

    // A parse that SUCCEEDED and produced nothing at all is `failed`, not
    // `parsed`. This is the founding defect's exact shape: a document with no
    // text reviewed by a model answers "the agreement is silent on this
    // point" for every clause, fluently, with nothing on the card to say the
    // text never arrived. A scan is not this case — a scan has sparse pages
    // and gets IMAGES at review time — so the test is on the whole document
    // producing nothing, which no readable file does.
    if (parsed.text.trim() === '' && parsed.sparsePages.length === 0) {
      await fail(t, doc, `${doc.name} produced no text at all. It may be empty, or it may be a `
        + 'file this reader cannot open. A review of it would report every clause as absent, '
        + 'which is why it is refused instead.');
      return true;
    }

    await t.query(
      `update document set text = $3, parse_state = 'parsed', parse_error = null
        where id = $1 and workspace_id = $2`,
      [doc.id, doc.workspace_id, parsed.text]);
    return true;
  });
}

async function fail(
  t: { query: (text: string, values?: unknown[]) => Promise<unknown[]> },
  doc: PendingRow,
  message: string,
): Promise<void> {
  await t.query(
    `update document set parse_state = 'failed', parse_error = $3, text = ''
      where id = $1 and workspace_id = $2`,
    [doc.id, doc.workspace_id, message]);
}

export interface WorkerHandle { stop(): Promise<void> }

/**
 * The polling loop. `stop()` waits for the in-flight parse, so a shutdown
 * never leaves a transaction to be rolled back by a dying connection.
 */
export function startParseWorkers(deps: ParseWorkerDeps, count: number): WorkerHandle {
  let running = true;
  const sleep = (ms: number) => new Promise<void>(resolve => { setTimeout(resolve, ms); });

  const loop = async (): Promise<void> => {
    while (running) {
      let did = false;
      try {
        did = await parseOneDocument(deps);
      } catch (error) {
        // A failure to CLAIM (the database is down, a grant is missing) must
        // not kill the loop silently, and must not spin either.
        process.stderr.write(
          `api: parse worker could not claim a document: ${(error as Error).message}\n`);
      }
      // Straight on to the next document when there was one — a queue of
      // twenty uploads must not take twenty poll intervals.
      if (!did) await sleep(deps.pollMs);
    }
  };

  const loops = Array.from({ length: count }, () => loop());
  return {
    async stop() {
      running = false;
      await Promise.allSettled(loops);
    },
  };
}
