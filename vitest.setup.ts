import { vi } from 'vitest';
// `fake-indexeddb` is SCOPED, not deleted — and this comment records when it
// goes.
//
// Stage 2 §14 says it is "deleted along with the last IndexedDB test", and so
// is the `node:buffer` Blob workaround that exists only because Blobs do not
// round-trip through it. That moment is NOT this release. The browser-local
// database is read-only from Task 23 but it is still READ, by exactly one
// screen — the uploader (§13.1), which is available for one release and
// which a later release removes "once the owner confirms the server copy is
// good."
//
// So the last files that need this are `src/lib/upload/scan.test.ts`,
// `src/lib/upload/run.test.ts`, `src/lib/db/open.test.ts` and the fixture
// helper they share, `src/test/seedLocalData.ts`. The release that deletes
// `src/features/upload` and `src/lib/upload` is the release that deletes
// this import, the `fake-indexeddb` dependency in `package.json`, and the
// `node:buffer` Blob note in CLAUDE.md's environment quirks.
//
// It is a global rather than a per-file import because `getDb()` is imported
// transitively by a great deal of `src/` (through `loadError.ts`), and a
// missing `indexedDB` global turns that into an import-time crash in files
// that have nothing to do with storage.
import 'fake-indexeddb/auto';

// Task 19's sign-in gate wraps every screen App.tsx renders. Without this,
// each of the ~14 existing `App.tsx`-mounting test files would need its own
// `vi.mock('../lib/auth/oidc', ...)` — a real "wave of test edits" purely to
// keep an unrelated flow signed in, not because any of those tests care
// about authentication. This default double is exactly the seam the task
// asked for instead: every test in this project mounts `<App/>` as an
// already-signed-in user unless it says otherwise.
//
// `useAuth.test.tsx` — the one file that actually tests sign-in — overrides
// this with its own `vi.mock('oidc-client-ts', ...)` per case; a `vi.mock`
// declared in a test file always wins over one declared here for that file,
// so this default never leaks into the tests that are supposed to control
// it directly.
//
// Only `UserManager` is replaced — `ErrorResponse`, `WebStorageStateStore`
// and everything else come from the real package via `importOriginal`, so
// `oidc.ts`'s own `instanceof ErrorResponse` check keeps working against
// real error instances a test constructs.
vi.mock('oidc-client-ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('oidc-client-ts')>();
  const FAKE_USER = {
    profile: { sub: 'test-user-oid', name: 'Test User', email: 'test.user@example.com' },
    expired: false,
    access_token: 'test-access-token',
  };
  class DefaultSignedInUserManager {
    constructor(_settings: unknown) { /* the real settings shape is irrelevant to this double */ }
    getUser() { return Promise.resolve(FAKE_USER); }
    signinSilent() { return Promise.resolve(FAKE_USER); }
    signinRedirect() { return Promise.resolve(); }
    signinRedirectCallback() { return Promise.resolve(FAKE_USER); }
    signoutRedirect() { return Promise.resolve(); }
  }
  return { ...actual, UserManager: DefaultSignedInUserManager };
});

// `src/lib/api/client.ts` and `src/lib/model/gatewayModelClient.ts` each
// build a module-level singleton bound to the REAL `globalThis.fetch` at
// import time (Task 7). Without a default double, any test that merely
// imports something on either path — without mocking `fetch` itself —
// would make a genuine network call in Node's own `fetch`: in CI that
// either hangs on a DNS lookup or silently succeeds against nothing this
// suite controls, exactly the "looks like it passed, proves nothing" shape
// CLAUDE.md warns about for tests. Stubbed here, exactly as `oidc-client-ts`
// is above: a default every test gets for free, loudly refusing rather than
// reaching the network, and overridden by any test that mocks `fetch`
// itself (a per-file `vi.stubGlobal`/`vi.fn` always wins for that file).
vi.stubGlobal('fetch', vi.fn(async () => {
  throw new Error(
    'fetch was called with no mock in place for this test — see vitest.setup.ts',
  );
}));

// jsdom implements no layout engine, so `Element.prototype.scrollIntoView`
// simply does not exist — calling it throws "is not a function" rather than
// being a harmless no-op. Three components legitimately scroll: the chat
// panel scrolls to its newest message, `PdfCanvas` scrolls a citation
// highlight into view, and `ResultsView` follows the keyboard verify loop's
// focused card.
//
// Stubbed here rather than guarded at each call site with `?.scrollIntoView?.()`.
// A defensive optional call in production code to accommodate a test
// environment reads as though the API might genuinely be missing in a
// browser, which it never is — and it would silently stop scrolling if the
// call were ever renamed. The gap is jsdom's, so the fix belongs in jsdom's
// setup, alongside the `Blob.prototype.text` polyfill below.
if (typeof Element !== 'undefined' && !Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = function scrollIntoView(): void {
    /* no layout in jsdom; nothing to scroll */
  };
}

// Polyfill Blob.text() for jsdom if not available
if (typeof Blob !== 'undefined' && !Blob.prototype.text) {
  Blob.prototype.text = async function() {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () => reject(reader.error);
      reader.readAsText(this);
    });
  };
}

// Polyfill Blob.arrayBuffer() for jsdom if not available. Routed through
// FileReader (jsdom's own object) rather than `node:buffer`'s Blob, so the
// ArrayBuffer this produces lives in the same realm as jsdom's global
// `ArrayBuffer` — code such as `docxRedlines.ts` hands the result straight
// to `jszip`, which type-checks with `instanceof ArrayBuffer` against
// whatever realm it was loaded into. An ArrayBuffer built by Node's native
// `Blob.arrayBuffer()` fails that check under jsdom even though it is a
// perfectly real ArrayBuffer — a cross-realm identity mismatch, not a data
// problem — which is why fixtures in this project build with the global
// `Blob`, not `node:buffer`'s.
if (typeof Blob !== 'undefined' && !Blob.prototype.arrayBuffer) {
  Blob.prototype.arrayBuffer = async function() {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as ArrayBuffer);
      reader.onerror = () => reject(reader.error);
      reader.readAsArrayBuffer(this);
    });
  };
}
