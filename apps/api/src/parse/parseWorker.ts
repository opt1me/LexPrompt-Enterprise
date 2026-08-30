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
  /** `API_PARSE_TIMEOUT_MS`. See `parseWithin` — the bound this queue
   *  shipped without. */
  parseTimeoutMs: number;
  /** `API_PARSE_STUCK_REPORT_MS`. How long a document may sit `pending`
   *  before this worker says so on stderr. */
  parseStuckReportMs: number;
  /**
   * The reader, injected — defaulting to `parseDocument`, which is what
   * production passes by omission.
   *
   * A seam, and a narrow one, for the same reason `db` and `blobs` are
   * injected: the behaviour this module's timeout exists for is a parse that
   * DOES NOT RETURN, and there is no fixture for that. A `Promise.race`
   * cannot preempt synchronous CPU work either — nothing in Node can — so a
   * test that leaned on a tiny `parseTimeoutMs` against a real PDF would
   * prove only that the fixture is fast, and would go on passing with the
   * bound deleted.
   */
  parse?: typeof parseDocument;
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

    let parsed;
    try {
      const read = deps.parse ?? parseDocument;
      parsed = await parseWithin(read(bytes, doc.mime, doc.name), deps.parseTimeoutMs);
    } catch (error) {
      if (!(error instanceof ParseTimeoutError)) throw error;
      // FAILED, not left `pending`. This is the whole point of the bound:
      // `parseWorkers` defaults to 1 and the claim is strict FIFO with no
      // skipping, so a document that never finishes blocks every other
      // document in the deployment — in every workspace — and the only
      // message anybody can reach is `routes/runs.ts`'s "try again in a
      // moment", which becomes a lie repeated forever. Taking it out of
      // `pending` with a message naming the key is the loud answer; leaving
      // it is the quiet one.
      await fail(t, doc, `${doc.name} took longer than ${deps.parseTimeoutMs}ms to read and was `
        + 'stopped (API_PARSE_TIMEOUT_MS). It has NOT been read, and a review of it would '
        + 'report every clause as absent. Add the file again, or ask an administrator to '
        + 'raise that limit for a document this large.');
      return true;
    }
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

/**
 * The parse did not finish inside its budget.
 *
 * Its own class rather than a bare `Error`, so `parseOneDocument` can tell a
 * timeout (which it records as a `failed` document with a message naming the
 * key) from a genuine crash (which it lets propagate, so the transaction
 * rolls back and the row stays `pending` for the next poll — the recovery
 * this module's "no lease column" design deliberately relies on).
 */
export class ParseTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`The parse did not finish inside ${timeoutMs}ms.`);
    this.name = 'ParseTimeoutError';
  }
}

/**
 * `work`, bounded.
 *
 * A race rather than a check afterwards, because the failure this exists for
 * is work that never settles: a check afterwards never runs. The parse keeps
 * burning CPU until it finishes or the process ends — nothing in Node can
 * stop a synchronous library mid-loop — but the CLAIM is released and the
 * document leaves `pending`, which is what unblocks every other document
 * behind it in a single-slot FIFO queue.
 */
async function parseWithin<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new ParseTimeoutError(timeoutMs)), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    // The losing promise must not become an unhandled rejection when the
    // parse eventually fails on its own, long after this returned.
    work.catch(() => { /* already answered, one way or the other */ });
  }
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
 * Documents that have been waiting to be read for longer than anybody would
 * call "a moment", reported on stderr.
 *
 * NOT a failure and NOT a bound: a busy queue is not a broken one, and a
 * document waiting behind nine others is normal — the same reasoning the
 * reaper gives for never reaping a `queued` run. It exists because the
 * alternative is a queue whose only symptom is a person being told to *"try
 * again in a moment"* forever, with nothing anywhere naming the document at
 * the head of it.
 *
 * Exported so a test can assert on the count rather than on a log line.
 */
export async function reportStuckDocuments(deps: ParseWorkerDeps): Promise<number> {
  const rows = await deps.db.query<{ id: string; name: string; waited: string | number }>(
    `select id, name, extract(epoch from (now() - added_at)) * 1000 as waited
       from document
      where parse_state = 'pending' and added_at < now() - ($1 || ' milliseconds')::interval
      order by added_at asc
      limit 20`,
    [String(deps.parseStuckReportMs)]);
  if (rows.length === 0) return 0;
  process.stderr.write(
    `api: ${rows.length} document(s) have been waiting to be read for longer than `
    + `${deps.parseStuckReportMs}ms (API_PARSE_STUCK_REPORT_MS). Nothing can review them, and every `
    + 'attempt is answered "try again in a moment". Oldest first: '
    + `${rows.map(r => `${r.name} (${Math.round(Number(r.waited))}ms)`).join(', ')}\n`);
  return rows.length;
}

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

  // The report ticks beside the loops rather than inside them: a loop that
  // is blocked on a slow parse is exactly when the report matters, and a
  // check inside the loop would be the thing not running.
  const report = setInterval(() => {
    if (!running) return;
    void reportStuckDocuments(deps).catch((error: Error) => {
      process.stderr.write(`api: could not check for stuck documents: ${error.message}\n`);
    });
  }, Math.max(deps.pollMs, Math.floor(deps.parseStuckReportMs / 2)));
  report.unref?.();

  const loops = Array.from({ length: count }, () => loop());
  return {
    async stop() {
      running = false;
      clearInterval(report);
      await Promise.allSettled(loops);
    },
  };
}
