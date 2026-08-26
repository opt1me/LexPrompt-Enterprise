# LexPrompt

LexPrompt is a browser-based tool for reviewing contracts against a checklist of clauses you define, using a language model you choose via [OpenRouter](https://openrouter.ai/). There is no backend, no database, and no user accounts — it is a static site that runs entirely in your browser and talks directly to OpenRouter.

## What it does

The core loop has four steps:

1. **Pick or generate a review template.** A template is a named set of clauses to check for in a given contract type (e.g. "Assured Shorthold Tenancy Agreement", "SaaS Master Services Agreement"). You can describe a contract type and have a model draft a starting template, or build one by hand, clause by clause.
2. **Edit and save it.** Every clause has an extraction instruction (what to find) and a risk scorer (how to judge it). Templates are fully editable in the browser and saved to your template library for reuse.
3. **Run it over one document or a batch.** Upload a PDF, DOCX, or TXT contract (or several at once) and the template runs against each one, extracting every clause in parallel.
4. **Read the findings.** Results appear as cards — one per clause — with a risk badge (Info / Low / Medium / High) and a plain-language explanation. Each finding carries one or more citations; clicking a citation scrolls the document viewer (shown alongside the findings) to the right page and highlights the exact quoted passage, so you can check the model's claim against the source text yourself.

Beyond the core loop:

- **Tabular view** shows the same results as a grid — one row per document, one column per clause — for scanning a whole batch at a glance, with CSV export.
- **DOCX export** produces a formatted Word report of a run, with risk-shaded rows and numbered citations.
- **Assistant tab** lets you ask free-form questions about a document, grounded in its actual text (or page images, for scanned documents — see Known limitations).
- **Draft Email** and **Suggest Fix** turn a run's findings into a client-ready summary email or a proposed replacement clause for a flagged risk.

## No backend, no accounts

LexPrompt is a static bundle of HTML, CSS, and JavaScript. There is no server component, no database, and nothing to sign up for. Everything the app knows about — your templates, your settings, the documents you've uploaded — lives only in the browser you're using, for as long as that browser's storage isn't cleared.

## You need an OpenRouter API key

LexPrompt doesn't call any model provider directly. Instead, every request goes through [OpenRouter](https://openrouter.ai/), which gives you a single API key and a choice of models from many providers (Anthropic, OpenAI, Google, and others) at their published per-token prices.

1. Create an account at [openrouter.ai](https://openrouter.ai/) and generate an API key.
2. Add credit to your OpenRouter account (LexPrompt does not mark up or intermediate billing in any way — you pay OpenRouter directly for what you use).
3. Paste the key into LexPrompt's Settings panel and pick a model.

**Where the key lives:** your API key is stored only in your browser's local storage, on the device and browser you entered it in. It is sent to exactly one place — `openrouter.ai` — as an `Authorization` header on each request you make. It is never sent anywhere else, and there is no server for LexPrompt to leak it to, because LexPrompt has no server.

## Privacy

This matters if you're evaluating LexPrompt for real contract work, so it's stated plainly:

- **Templates and settings are per-browser.** They're written to `localStorage` in the browser you're using. There is no sync, no account, and no cloud copy. Clearing site data, switching browsers, or switching devices means starting over — export a template first (the Library's Export button) if you want to move it or keep an external backup.
- **Documents are never persisted anywhere.** An uploaded contract is parsed and held in memory for the current session only. It is not written to disk, not saved to local storage, and not uploaded to any LexPrompt-operated service, because none exists.
- **The only place document content goes is the model you chose, via OpenRouter**, exactly as OpenRouter's own privacy and data-retention policies describe. Read your chosen model provider's policy on OpenRouter if that matters for your use case — LexPrompt does not add any retention of its own on top of it.
- Closing the tab or reloading the page discards the current run. Only templates you explicitly save persist.

## Local development

Requires **Node.js >= 22.13** (Node 20 will fail to install dependencies — see [Node version requirement](#node-version-requirement) below for why).

```bash
npm install
npm run dev
```

This starts a Vite dev server (default `http://127.0.0.1:3005`). Open Settings in the running app and enter your own OpenRouter key to use it — nothing works without one, since every review, template generation, chat message, and suggestion goes through OpenRouter.

## Testing

```bash
npm test          # runs the full suite once
npm run test:watch  # watch mode
```

The suite is unit and integration tests (Vitest) covering the storage layer, the OpenRouter client, PDF/DOCX parsing, citation matching, the review engine, and CSV/DOCX export. It does not include end-to-end browser tests or make real network calls — everything that talks to OpenRouter is mocked.

## Building and deploying

```bash
npm run build
```

This runs `tsc` for a type check and then produces a static `dist/` folder with Vite. The result is a set of plain HTML/CSS/JS files — deploy it to any static host: Netlify, Vercel, GitHub Pages, S3 + CloudFront, nginx, or similar. There is nothing to configure server-side; the only runtime configuration is the OpenRouter key each user enters themselves.

To preview the production build locally before deploying:

```bash
npm run preview
```

**Worked example — Firebase Hosting.** This repository is already wired up for it (`firebase.json`, `.firebaserc`):

```bash
npm run hosting:on   # builds, then deploys to Firebase Hosting
npm run hosting:off  # disables hosting
```

Using a different host just means pointing it at the contents of `dist/` and configuring it to rewrite all paths to `index.html` (this is a single-page app with client-side routing).

## Requirements, explained

### Node version requirement

Building and testing this project requires **Node.js >= 22.13**. This is a *tooling* requirement, not something that limits the app itself: one dependency, `pdfjs-dist` (the PDF rendering library, pinned at v6.2.108), declares that Node version as a minimum in its own `engines` field. On Node 20, a plain `npm install` or `npm ci` still succeeds, but prints an `EBADENGINE` warning; a CI pipeline that runs with `--engine-strict` (or has `engine-strict=true` set some other way — several CI templates do this deliberately) will hard-fail the install instead of just warning. Separately, and regardless of that flag, if anything tried to `import()` the library directly under Node 20 it would fail outright with `Iterator is not defined` (Node doesn't get the `Iterator` helpers pdfjs-dist's internals use until v22). Vite's production build is unaffected by this, because bundling only *parses* the package's source rather than executing it — but any CI pipeline pinned to Node 20 should be bumped to 22.13+ to be safe.

### Browser requirement

The app targets browsers from roughly **2024 onward**: Chrome 122+, Firefox 131+, Safari 18.4+. This isn't a stylistic choice — it's the same `Iterator` global that `pdfjs-dist` v6 needs at runtime, this time in the browser rather than in Node. Viewing or reviewing a PDF in an older browser will fail; a current browser is required, not just recommended.

## Known limitations

- **Scanned documents have no reliable citations.** A PDF with no text layer (a scan, a photographed page) is still readable — LexPrompt falls back to sending page images to the model, and extraction and chat both work from those images. But citations rely on matching a quoted string against the document's text layer, and a scanned page has none, so citation highlighting simply doesn't have anything to point at on those pages.
- **The Assistant declines rather than guessing on unreadable documents.** If a document has no usable text and the selected model can't read images either, the chat panel tells you it can't answer rather than fabricating a plausible-sounding response. This is deliberate: a confident wrong answer about a contract is worse than an honest "I can't read this."
- **Unsaved template edits are discarded without warning.** The template editor doesn't autosave and doesn't prompt before you navigate away. Click Save before leaving, or your changes are gone.
