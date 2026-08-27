# LexPrompt

LexPrompt is a browser-based tool for reviewing contracts against a checklist of clauses you define, using a language model you choose via [OpenRouter](https://openrouter.ai/). There is no backend, no database, and no user accounts — it is a static site that runs entirely in your browser and talks directly to OpenRouter.

## What it does

The core loop has four steps:

1. **Pick or generate a review template.** A template is a named set of clauses to check for in a given contract type (e.g. "Assured Shorthold Tenancy Agreement", "SaaS Master Services Agreement"). You can describe a contract type and have a model draft a starting template, or build one by hand, clause by clause.
2. **Edit and save it.** Every clause has an extraction instruction (what to find) and a risk scorer (how to judge it). Templates are fully editable in the browser and saved to your template library for reuse.
3. **Run it over one document, a batch, or a collection of documents read together.** Upload a PDF, DOCX, or TXT contract (or several at once) and the template runs against each one, extracting every clause in parallel. Documents that amend each other — a lease and its deed of variation — can instead be grouped into a collection first and reviewed as a single source; see [Collections and net positions](#collections-and-net-positions) below.
4. **Read the findings.** Results appear as cards — one per clause — with a risk badge (Info / Low / Medium / High) and a plain-language explanation. Each finding also carries a verification state that only you can set (see [Verifying findings](#verifying-findings) below) — nothing the model does marks a finding as checked. Each finding's supporting quotes are shown inline on the card, labelled with the document and — for a PDF where the quote could be pinned to a page — the page number, so you can read the evidence without hovering over anything; the whole quote is still a click that scrolls the document viewer (shown alongside the findings) to that passage and highlights it.

Beyond the core loop:

- **Tabular view** shows the same results as a grid — one row per document, one column per clause — for scanning a whole batch at a glance, with CSV export.
- **DOCX export** produces a formatted Word report of a run, with risk-shaded rows and numbered citations.
- **Assistant tab** lets you ask free-form questions about a document, grounded in its actual text (or page images, for scanned documents — see Known limitations).
- **Draft Email** and **Suggest Fix** turn a run's findings into a client-ready summary email or a proposed replacement clause for a flagged risk.

## Verifying findings

A finding is what a model said. It isn't checked until a person says so, and LexPrompt is deliberate about keeping those two things visibly separate:

- **Every finding starts Unverified.** That's not a placeholder state you're meant to clear on your way past — it's the honest default, and it's shown on the card and on every export until you change it. (The tabular grid's cells don't yet show verification state — see Known limitations — but its cell detail panel does.)
- **You can Verify, Flag, or Reject a finding.** Verify means you checked it against the source and it's right. Flag means it needs a second look. Reject means it's wrong — and a rejection always asks for a reason, because a silent disagreement is no use to whoever reads the report later. That reason travels with the finding into every export.
- **Re-running a clause clears its verification.** A verification is a judgement about a specific answer; once you retry a clause, that answer no longer exists, so the checkmark would be describing something that isn't there anymore. It resets to Unverified rather than carrying over. Any notes you've written on the finding are not affected — they're about the clause, not about one run's output, and survive the re-run.
- **Evidence is shown inline, not on hover.** Each citation appears as a readable quote on the finding card itself, labelled with the document it came from and, for a PDF where the quote could be located, its page number — no pointer required. Clicking it still scrolls the document viewer to that passage and highlights it.
- **Exporting is never blocked by verification status.** A run with every finding still Unverified exports exactly as readily as a fully-reviewed one. Both the DOCX report and the CSV open with a one-line summary of how many findings were verified, flagged, rejected, or left unverified, and every finding that isn't verified is labelled as such in the export itself — an unverified row never reads as a checked one.
- **A keyboard loop for working through a batch:** `j`/`k` (or the arrow keys) move between findings, `v` verifies, `f` flags, and `r` opens the rejection reason prompt. Typing in a note or a reason box is never intercepted as a shortcut.

## Collections and net positions

A lease and the deed of variation that amends it answer a clause together. Ask them separately and you get two confident answers, and neither one is the answer — you have to read them in order to know what currently applies. A **collection** is how LexPrompt lets you do that.

- **Grouping is always proposed, never automatic.** From a matter's document list, select a base document and one or more amendments (a licence to alter, a side letter, a supplemental agreement) and give the group a name; LexPrompt will suggest groupings when filenames look like an amendment of another document already in the matter, but a suggestion is dismissible and nothing is grouped until you click to accept it. The base and its amendments keep the reading order you set — amendments are **not** re-sorted by any date on the document, because the order in which they take effect is a legal judgement, not something the app can infer.
- **A collection review makes one model call per clause across every document in the group**, and returns two things: a **trail** — what each document does to that clause, in reading order, each step with its own quotes — and a proposed **net position**: what the documents, read together, say now about that clause.
- **A net position starts unconfirmed, and says so wherever it appears.** It is synthesised text that no single document contains, describing a legal position someone will act on, so it is never shown as settled until a person has read it. You can **Confirm** it (you read the model's synthesis and accept it as written) or **Amend** it (you rewrite it yourself) — an amendment is a stronger claim than a confirmation, because a person wrote every word the reader sees, and it's labelled that way.
- **Re-running a clause clears its confirmation**, for the same reason re-running clears a finding's verification: the synthesis it described no longer exists once the clause is re-derived, so keeping the old confirmation would let an export claim someone accepted text they never saw.
- **The trail travels with the net position everywhere it's shown or exported**, including in the DOCX and CSV reports — a conclusion synthesised across documents is exported with its derivation, not as a bare assertion.
- **Ungrouping never deletes anything.** It dissolves the collection and returns its documents to standing on their own; nothing about the documents themselves — their text, their findings from other reviews, their file — is touched.

## No backend, no accounts

LexPrompt is a static bundle of HTML, CSS, and JavaScript. There is no server component, no database, and nothing to sign up for. Everything the app knows about — your matters, your documents, your templates, your settings — lives only in the browser you're using, for as long as that browser's storage isn't cleared. See [Privacy](#privacy) for exactly what's stored and where.

## You need an OpenRouter API key

LexPrompt doesn't call any model provider directly. Instead, every request goes through [OpenRouter](https://openrouter.ai/), which gives you a single API key and a choice of models from many providers (Anthropic, OpenAI, Google, and others) at their published per-token prices.

1. Create an account at [openrouter.ai](https://openrouter.ai/) and generate an API key.
2. Add credit to your OpenRouter account (LexPrompt does not mark up or intermediate billing in any way — you pay OpenRouter directly for what you use).
3. Paste the key into LexPrompt's Settings panel and pick a model.

**Where the key lives:** your API key is stored only in your browser's local storage, on the device and browser you entered it in. It is sent to exactly one place — `openrouter.ai` — as an `Authorization` header on each request you make. It is never sent anywhere else, and there is no server for LexPrompt to leak it to, because LexPrompt has no server.

## Matters

Work in LexPrompt is organised around **matters** — a matter is the top-level object, and it holds the documents you've added to it and every review you've run over them. This replaced an earlier, session-only version of the app where a review's results vanished on reload; a matter that forgot its documents wasn't really a matter, so this was changed deliberately (see [Privacy](#privacy) below for exactly what that means for your data).

Matters, reviews, and templates are addressable by URL: `/matters/:id` opens a matter, `/matters/:id/reviews/:id` opens one of its reviews, and `/playbooks/:id` opens a template (called a "playbook" internally and in the URL, and in the storage layer) for editing. These are real deep links — reloading the page on one, or sharing the URL with yourself, returns to the same place.

**This means any static host you deploy to must rewrite all paths to `index.html` (SPA fallback).** Without it, refreshing the page on a deep link like `/matters/abc123` returns a 404 from the host, not from the app — which looks like LexPrompt is broken rather than like a hosting configuration gap. `firebase.json` in this repository already configures this rewrite for Firebase Hosting; if you deploy elsewhere (Netlify, Vercel, GitHub Pages, S3 + CloudFront, nginx, etc.), you must configure the equivalent yourself. See [Building and deploying](#building-and-deploying) below.

## Privacy

This matters if you're evaluating LexPrompt for real contract work, so it's stated plainly:

- **Matters, documents, and reviews are stored in this browser's IndexedDB** — on the device and in the browser you're using, and nowhere else. This includes the original file bytes of every document you add to a matter, not just its extracted text, so a document can still be viewed and re-reviewed after a reload.
- **Nothing is uploaded anywhere except to the model you chose, via OpenRouter**, at the moment you run a review, exactly as OpenRouter's own privacy and data-retention policies describe. Read your chosen model provider's policy on OpenRouter if that matters for your use case — LexPrompt does not add any retention of its own on top of it.
- **Deleting a matter deletes its documents and their stored bytes**, not just the matter's entry in a list. This cascade is real and covered by tests, not just a UI-level hide.
- **Data is per-browser**, with no sync and no backup. Clearing this browser's site data (or switching browsers or devices) removes your matters, documents, reviews, and templates permanently. Export a template first (the Library's Export button) if you want to move it or keep an external copy — there is no equivalent export for matters or documents yet.
- **Page images generated for scanned PDFs are never stored.** When a scanned page needs an image (because it has no usable text layer), it's rendered on demand from the document's stored original bytes and kept only in memory for that session — never written to IndexedDB.
- Templates now live in IndexedDB alongside everything else above (an existing browser's `localStorage` templates are migrated in automatically, once, the first time you open this version). Migration deliberately never deletes that original `localStorage` copy — it's kept in place, indefinitely, as a safety net in case the new storage ever turns out not to be readable. So if you're upgrading from an earlier version, your original templates remain in `localStorage` in addition to their new copy in IndexedDB, alongside your OpenRouter key and a couple of small settings. All of it is still per-browser, and clearing this browser's site data removes every copy — the `localStorage` one included — along with everything else.

This is a deliberate reversal of an earlier, stricter position (contract text was never persisted at all). It was made because a matter that can't be returned to isn't a matter — but the reversal is bounded to your own browser, and it's stated here because you shouldn't have to find out otherwise.

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

The suite is unit and integration tests (Vitest) covering the IndexedDB storage layer (matters, documents, blobs, reviews, playbooks, and the cascade-delete and localStorage-to-IndexedDB migration paths, run against `fake-indexeddb`), the OpenRouter client, PDF/DOCX parsing, citation matching, the review engine, and CSV/DOCX export. It does not include end-to-end browser tests or make real network calls — everything that talks to OpenRouter is mocked.

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
- **Verification is single-reviewer.** A verification or note is attributed to the local profile on this browser. There is no second reviewer, no sharing a matter, and nothing here notifies anybody of anything — verifying, flagging, or rejecting a finding is a record for yourself and later readers of the export, not a handoff to a colleague.
- **The tabular grid's cells don't show verification state.** A rejected finding and a verified one look identical in the grid itself — the state only becomes visible once you open a cell's detail panel, which renders the same finding card (and verification controls) as the main review screen. Rebuilding the grid to surface this directly is a later sub-project's work, not this one's.
- **A collection review isn't shown in the comparison grid.** The grid is built for comparing genuinely separate documents row by row; a collection produces one net position per clause, however many documents fed it, so there is nothing to compare — the grid refuses to open for a collection's review and points you back to the card view instead.
- **A collection whose base document is missing can't be run.** Every amendment acts on the base, so without it there's no starting position for any of them to vary; the collection's card says so and offers to choose a new base or ungroup, and starting a review is blocked until you do one or the other.
