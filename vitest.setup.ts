import 'fake-indexeddb/auto';

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
