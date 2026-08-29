/**
 * Rewriting who did what, on the way out of this browser (P16).
 *
 * Every record in the local database attributes itself to the ONE local
 * profile — a `uid()` this browser minted, which is not an `app_user` id and
 * never was. On the server, attribution columns are `uuid references
 * app_user(id)`, and the routes take the actor from the token rather than
 * from the body, so a top-level `ownerId` or `addedByUserId` is discarded
 * before it reaches a column at all.
 *
 * That is NOT the whole problem, and the half it does not cover is the half
 * that matters:
 *
 * **`review.findings` is jsonb.** `Verification.byUserId`, `Note.byUserId`
 * and `NetPosition.byUserId` all live inside it. A local id left in there
 * breaks no constraint — which is exactly why it would survive — and renders
 * as a verification by nobody. A human's verification is the most valuable
 * thing in this payload; an anonymous one is a judgement whose author has
 * been erased in transit.
 *
 * Three rules, and the second and third are the ones a careless
 * implementation gets wrong:
 *
 *  1. The LOCAL PROFILE's id becomes the uploading user's id.
 *  2. An EMPTY attribution becomes `null`, NOT the uploading user.
 *     `importPlaybook(json, byUserId = '')` produces one: a playbook
 *     imported from a file was written by whoever wrote the file, and
 *     claiming the person doing the upload wrote it would be a fabricated
 *     provenance in the one place provenance is the product.
 *  3. Any OTHER id is LEFT ALONE and counted. There has only ever been one
 *     local profile, so this should not happen; if it does, the honest thing
 *     is to leave it and say so on the report, not to sweep somebody else's
 *     work into the uploader's identity.
 */

/** The keys this treats as naming a person.
 *
 *  `assigneeId` is here alongside the `*UserId` family even though nothing
 *  in the app reads it (R1: assignment reaches nobody). It holds a person's
 *  id and nothing else ever will, so leaving it out would be leaving exactly
 *  one dangling local id behind on the argument that nobody is looking —
 *  which is the argument that stops being true the moment somebody does. */
function namesAPerson(key: string): boolean {
  return key === 'ownerId' || key === 'assigneeId' || /UserId$/.test(key);
}

/** Deep-rewrites in place on a structural clone, and counts what it could
 *  not map. `record` is returned with the same shape it came in with —
 *  arrays stay arrays, absent keys stay absent. */
export function rewriteAttributionCounted<T>(
  record: T,
  localProfileId: string | undefined,
  uploaderId: string,
): { record: T; unmapped: number } {
  let unmapped = 0;

  const walk = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(walk);
    if (!value || typeof value !== 'object') return value;
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      if (namesAPerson(key)) {
        if (typeof v !== 'string') {
          // `null`, `undefined`, or something that was never an id. Left
          // exactly as it is and NOT counted: an absent attribution is not
          // an unmappable one, and counting it would put a number on the
          // report that means nothing.
          out[key] = v;
        } else if (v === '') {
          // Rule 2. `null`, never the uploading user.
          out[key] = null;
        } else if (localProfileId !== undefined && v === localProfileId) {
          out[key] = uploaderId;
        } else {
          // Rule 3. Includes every id in a browser whose profile store could
          // not be read (`localProfileId` absent), which is why that case
          // leaves everything alone rather than guessing — and why the count
          // reaches the report.
          out[key] = v;
          unmapped++;
        }
        continue;
      }
      out[key] = walk(v);
    }
    return out;
  };

  return { record: walk(record) as T, unmapped };
}

/** The same, for callers that only want the record. */
export function rewriteAttribution<T>(
  record: T,
  localProfileId: string | undefined,
  uploaderId: string,
): T {
  return rewriteAttributionCounted(record, localProfileId, uploaderId).record;
}
