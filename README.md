# LexPrompt

LexPrompt is a browser-based tool for reviewing contracts against a checklist of clauses you define, using a language model you choose via [OpenRouter](https://openrouter.ai/). There is no backend, no database, and no user accounts — it is a static site that runs entirely in your browser and talks directly to OpenRouter.

## What it does

The core loop has four steps:

1. **Pick or draft a review template.** A template is a named set of clauses to check for in a given contract type (e.g. "Assured Shorthold Tenancy Agreement", "SaaS Master Services Agreement"). You can describe a contract type and have a model propose a starting draft, or build one by hand, clause by clause, with AI help on individual fields — see [Creating a playbook](#creating-a-playbook) below for how each route works, and why nothing is saved until you've read every clause.
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

- **Every finding starts Unverified.** That's not a placeholder state you're meant to clear on your way past — it's the honest default, and it's shown on the card and on every export until you change it. The grid shows it too: a cell carries its verification state and its risk level as separate chips, because they answer different questions.
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

## Standard positions

A playbook clause can carry a **standard position** — the firm's own answer to the question the clause asks, not just an instruction for extracting one. Its presence, not a mode toggle, is what turns a finding from a one-sided summary into a comparison.

- **A position is optional, per clause.** Leave it empty and the clause is extracted only, exactly as before. Fill it in and every future finding for that clause reports how the document measures up: **Meets**, **Deviates**, or **Unclear** — a third chip on the finding card and in the grid, alongside the verification state and risk chips, never merged into either, because the three answer three different questions.
- **Unclear is a real answer, not a failure to get one.** A missing or unrecognised outcome from the model is always recorded as Unclear, never as Meets — the safe default is the one that sends a person to look, not the one that reads as settled. A Deviates with no stated reason is downgraded to Unclear too, with a note that the model gave no reason; an unexplained Meets is not downgraded the same way, because an unexplained agreement doesn't assert anything a reader would act on. A clause with no standard position gets no outcome at all, on the card or in the grid — there was nothing to compare against, and nothing here invents a verdict to fill that gap.
- **A position records where its words came from, and whether a person has actually read them.** Written by you, drafted by AI and not yet reviewed, drafted by AI and reviewed, or learned from a set of redlines — an AI-drafted suggestion nobody has accepted is shown as exactly that, next to any comparison built from it, until someone reads it and accepts it as the firm's own.
- **A deviation is an observation, not a verdict.** Like every other finding, it sits Unverified until a person checks it against the source; a house position getting flagged as breached is not itself proof that it was.
- **A position's health is derived, never stored, and counts only verified findings.** The playbook editor shows each position as Held, Conceded, or Untested, built only from findings a human has actually verified — an unchecked Meets is the model agreeing with itself, and counting it would close the loop the rest of this app exists to keep open. It's also scoped to the position's *current* wording: a review that ran against a since-edited sentence doesn't count as evidence for the sentence that replaced it, in either direction.
- **Re-running a clause re-derives its outcome**, exactly as it resets the finding's verification and any net position — the comparison described one specific answer, and once that answer is replaced the old outcome no longer describes anything real.
- **A collection review compares too, against the net position it synthesises** rather than against any single document in the collection — the same "we ask for" vs. "the documents, read together, now say" comparison, one level up.

## Creating a playbook

A playbook doesn't come into existence pre-approved. It starts as a **draft** — proposed by a model, or built by hand — and nothing is written to your library until a person has been through every clause it contains.

- **Three routes, offered side by side.** "Create Template" in the library opens a chooser rather than going straight to a form: **Draft with AI** (describe the contract type, optionally point it at an existing playbook or a completed matter as style material, and a model proposes a first pass); **Build by hand** (add clauses one at a time, with a "Draft this for me" button on each field); and **Learn from redlines** (read a set of your own negotiated documents and propose standard positions from what you actually did to them — see [Learning from redlines](#learning-from-redlines) below).
- **Nothing is saved until every clause has been decided.** An AI-drafted playbook opens on a review screen headed "Unsaved draft" that stays true for as long as you're on it: reload the page, or navigate away without answering the warning, and the draft is gone — that's the intended behaviour, not data loss. Every clause has to be **kept**, **edited then kept**, or **cut** before `Save as v1` does anything; the button is disabled and names how many clauses are still waiting, rather than sitting greyed out with no explanation. A cut clause is left out of the saved playbook entirely, not merely hidden.
- **Every saved standard position says where it came from.** A clause the model proposed a position for reads as drafted by AI and not yet reviewed until you keep it; keep it unchanged and it reads as reviewed; rewrite it before keeping it and it still says the AI drafted it, because a person changing the wording doesn't erase where the idea came from — it only adds that someone changed it.
- **Selecting a matter as style material sends its verified findings to the model you've chosen.** Only `verified` findings — never anything still unverified, flagged, or rejected, since those are the model's own unconfirmed output — and only for a matter you've explicitly ticked in the picker. This is the one place in the app where another matter's content leaves your browser rather than just the document currently under review, and the picker says so plainly next to the checkboxes, not in a Settings note.
- **Per-field AI suggestions in the by-hand editor are never adopted just by saving the form.** "Draft this for me" on an extraction instruction, risk criteria, or standard position shows the suggestion dashed, badged, and clearly unaccepted, with Use this / Try again / I'll write it myself. Saving the clause while a suggestion sits on screen unaccepted leaves the field exactly as it was before you asked.
- **"Suggest what I'm missing" proposes clause titles only**, checked against what the playbook already covers, added or dismissed one at a time — there's no "add all," because every clause entering a playbook is meant to be a decision, not a bulk import.

## Learning from redlines

A firm's house rules usually aren't written down anywhere — they're in the redlines: the fact that on four leases out of four, someone struck the landlord's right to withhold consent unreasonably. "Learn from redlines" reads a set of your own negotiated documents and proposes standard positions from what they actually show, with the evidence attached.

- **Bring in the documents that taught you something, not the document under review.** These are precedent — a "their draft → our markup → executed" chain, or standalone files — brought in to learn from, not to review. LexPrompt reads them for this one session and **stores none of them**: not in IndexedDB, not in `localStorage`, not in the URL. Close the tab and they're gone; only the standard positions you go on to adopt survive, inside the playbook you eventually save.
- **Chains and roles are proposed, never assumed.** Filenames, and whether a `.docx` carries tracked changes at all, are just evidence — every document is asked "what is this?" rather than told what it is, and a chain you reject stays ungrouped rather than being re-proposed. Getting this silently wrong would mean learning a firm's house style from the counterparty's own opening draft.
- **Tracked changes are read from the markup itself, not from `mammoth`'s cleaned-up view.** `mammoth` (used elsewhere in the app for plain text extraction) unwraps insertions to plain text and silently drops deletions and comments entirely — reviewing a `.docx`'s tracked changes through it would mean reading the counterparty's redline back as though every change had already been accepted. Learning from redlines instead reads the `.docx`'s underlying XML directly, so insertions, deletions, moved text, and margin comments (with their author) all come through distinctly.
- **A document with no tracked changes falls back to comparing two PDFs, and says so.** Where there's no markup to read — an earlier and a later PDF rather than one marked-up file — LexPrompt diffs their extracted text sentence by sentence to find what changed. This is weaker evidence than a tracked change (it knows two documents differ; a tracked change knows a specific person made a specific edit), and every position resting only on this kind of evidence is labelled as such, everywhere it's shown.
- **A position's strength is counted, never claimed.** Every inferred position is scored `Consistent`, `Mixed`, or `Weak` from a plain count of which documents support it and which don't — arithmetic, not something asked of the model. A position struck in every document you supplied reads `Consistent`; a single instance is always `Weak`, however strongly worded, because one strike may have been a trade on that particular deal rather than a policy; documents that disagree are `Mixed`, and the app says the redlines disagree rather than picking a side.
- **Silence never produces a position.** A clause every document left untouched isn't "the firm accepts the standard wording" — it's a question the redlines never settled, and it's listed as an open question rather than smuggled in as a house rule nobody actually holds.
- **You can see the actual redline text behind any proposed position** — deletions struck through, insertions underlined, in the same sentence, with any margin comment shown alongside its author — before deciding anything about it.
- **Every position is adopted, reworded, or rejected one at a time.** Nothing here is written into a playbook because a model inferred it. Adopting a position (or rewriting it first) carries it into a genuine draft on [E's draft-review screen](#creating-a-playbook), where — exactly as with an AI-drafted playbook — nothing is saved until every clause has been kept, edited then kept, or cut. A rejected position ("not a house rule") is left out entirely.
- **The changeset mechanism — reading a new deal against a playbook you already have — is built and tested, but not yet reachable from the app.** Everything above produces a brand-new playbook. There's a separate, complete mechanism for the other half of this idea (`buildChangeset`/`publishChangeset`): feeding a new deal's redlines against a *live, already-published* playbook version and classifying each clause as confirming, drifting from, or entirely outside the standing position — publishing a new version from only what a person accepted. It refuses outright, rather than silently reverting anyone's work, if the playbook has been published again since the changeset was built. No screen currently links to it; wiring up that second entry point is separate, later work.

## Playbook versions

Playbooks are versioned. Editing one produces a draft; nothing a review reads changes until you publish it.

- **Publishing freezes a version.** A playbook's clauses, prompts, and standard positions are frozen into a numbered, immutable version the moment you publish. There's no way to edit a published version afterwards — only to publish a new one on top of it.
- **A change summary is required from v2 onward.** v1 has nothing to have changed from, so its summary is optional; every version after that requires one, because a version history whose entries don't say what changed is just a list of dates.
- **A review records the version it ran against.** Reopen a review from months ago and its header still reads against the exact clauses and positions that produced it, however many versions the playbook has published since.
- **Version history lists every published version** — its number, date, change summary, and which matters' reviews have used it — with no way to edit any of them from there.
- **Unpublished edits can be saved as a draft without publishing.** Trying to leave the editor with a draft pending offers to keep it (saved, so you can pick it back up later) or discard it — discarding really discards, including after a reload, not just for the rest of this session.

## Visual system

LexPrompt's screens use a paper-and-ink palette meant to read like a document rather than a dashboard, built on a token system designed to be checked rather than trusted.

- **Colour lives in two layers, and only the top one is usable from a component.** Raw values are plain CSS custom properties outside Tailwind's theme layer, so they never become classes anyone can type; only a small vocabulary of semantic roles — `accent`, `risk-high`, `ink-4`, `state-verified`, and the like — is exposed as a Tailwind utility. A component asks for what a colour *means* ("this is a risk", "this is a human confirmation"), never for a raw value. Teal is reserved for something a person did; a separate green is used for the model's own low-risk rating, so the two are never visually confused for one another even though they sit close in hue.
- **Two automated guards make the system a rule, not a guideline.** A palette scanner runs over every source file and fails the build on a raw hex or `rgb()` literal, a Tailwind arbitrary colour value, a reference to the raw token layer, or a generic Tailwind palette class — with no exemption list, so no file is invisible to it. A contrast test checks every declared colour pairing (foreground role on background role) against the WCAG threshold its use case calls for — body text, chip text, or decorative metadata — so a future palette edit that quietly pushes a colour below legible contrast fails the suite instead of shipping.
- **Fonts are vendored, not fetched.** `public/fonts/` holds six latin-subset `.woff2` files (a serif for document prose, a sans for interface chrome, a mono for labels and chips) under a combined budget of 350 KiB, checked by a test that also confirms nothing in the app links to a third-party font host. This is a privacy decision as much as a performance one: the app's own disclosure says nothing leaves the browser except calls to OpenRouter, and a Google Fonts `<link>` would make that false on every page view. Updating a font version is consequently a manual step — there is no font package as a dependency.
- **The chrome is honest about being single-user.** The header avatar shows the initials from your own local profile, not an invented colleague's; there is no assignee chip, no "assigned to me" counter, and no firm-wide search box, because none of those can mean anything in an app with no accounts and no server. The matter activity feed is derived from your own verifications, notes, and confirmations at the moment you view it — it is not a stored event log, so it can never show an entry claiming a second person did something.
- **A matter's status board and its `Standard positions` tab both refuse to overstate.** The status board shows an empty form — not a row of zeroes — for a matter with no completed review yet, because "0 of 0 verified" reads as a fact about safety it hasn't earned. `Standard positions` lists every clause carrying a house position across your playbooks and marks each `HELD`, `CONCEDED`, or `UNTESTED` from verified findings only, built entirely from data the app already derives elsewhere — no new model calls, no new stored state.
- **The app is usable from 768px upward.** Phone-width layouts are a separate, later piece of work — this pass covers tablet and desktop widths of the existing screens, not a phone-specific redesign.

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

## How it's built

A React 19 + TypeScript single-page app, built with Vite, styled with Tailwind 4. No backend, no server-side anything — the whole app is `dist/` and a static host.

```
src/
  lib/            pure logic and persistence — no React
    db/           IndexedDB via `idb`; one repository per store
                  (matters, documents, blobs, reviews, playbooks,
                   collections, playbookVersions, changesets, profile)
    openrouter.ts the ONLY route to a model provider
    citations.ts  matches a verbatim quote to page coordinates
    strength.ts   how strongly a house position is supported — arithmetic,
                  never a model's opinion
    ...
  features/       one folder per screen area
    review/       the findings ledger, evidence, document viewer
    tabular/      the comparison grid
    templates/    the playbook editor, versions, publishing
    authoring/    the three routes to a new playbook
    redlines/     learning house positions from marked-up documents
    matters/      matter home, status board, intake
    positions/    the cross-playbook standard-positions view
  components/     the shared primitives every screen composes
  test/           the harness, plus the guards described below
```

Some deliberate shapes worth knowing before changing things:

- **`src/lib/` holds no React.** Persistence, parsing, citation matching and every derived summary are plain functions over data, so they can be tested without mounting anything and the IO stays in the container components.
- **One route to a model.** Every request goes through `openrouter.ts`. It retries only on 429 and 5xx and fails fast on 4xx, because retrying a rejected key just burns time before telling you the same thing.
- **The card view, the comparison grid and the clause index are three renderers over one findings map.** None of them derives its own counts. The moment two of them compute "how many are verified" separately, they can disagree, and a reader has no way to know which to believe.
- **Derived state is derived, not stored.** Position health, matter statistics and the activity feed are computed at read time from what already exists. A stored summary is a second source of truth that can drift from the thing it summarises.

### The rule the codebase is organised around

**Fail loudly rather than answer quietly wrong.**

This app tells lawyers what is in contracts. A visible error costs someone a retry; a confident wrong answer costs them a mistake in advice. Almost every serious defect found while building this was a variant of one thing — something incomplete or stale presented as if it were complete and correct. A scanned PDF reviewed by a text-only model answering "the agreement is silent on this point" for every clause. A CSV writing unreviewed clauses as blank cells, which reads in a spreadsheet as "checked, nothing found". A summary row showing three zeroes where nothing had been assessed.

So the codebase leans hard on a few habits: a load path must distinguish *empty* from *broken* from *not yet known*; a default must never assert something (a missing outcome becomes "unclear", never "meets"); an absent fact renders as nothing at all rather than a placeholder that looks like an answer; and anything a person judged is set only by that person, never inferred.

`CLAUDE.md` in this repository records these as working rules, each with the defect that motivated it. `docs/superpowers/` holds the designs and the decision log — every ruling made during the build, with what it would cost if it turned out wrong.

## Local development

Requires **Node.js >= 22.13** (Node 20 will fail to install dependencies — see [Node version requirement](#node-version-requirement) below for why).

```bash
npm install
npm run dev
```

This starts a Vite dev server (default `http://127.0.0.1:3005`). Open Settings in the running app and enter your own OpenRouter key to use it — nothing works without one, since every review, template generation, chat message, and suggestion goes through OpenRouter.

## Running the server stack locally (Stage 1)

The section above is the original browser-only app. LexPrompt is being rebuilt around a real server: a `gateway` that is the only process allowed to call a model provider, an `api` that authenticates every request against a real identity provider and proxies validated calls to the gateway, and a `web` static build in front of both. There is no local bypass for any of this — Stage 1 requires a signed-in user with no mode that skips it — so a local Keycloak realm ships alongside the services so the whole path can be exercised on a laptop.

**Run the certificate script first.** The gateway and `api` talk to each other over mTLS; `api` presents a client certificate the gateway's identity check requires. Nothing else in this section works until this has been run:

```bash
bash scripts/dev-certs.sh
```

This writes a development CA and two leaf certificates into `certs/` (gitignored — see `scripts/dev-certs.sh`'s own comment on why a committed private key here would be a mistake nobody could undo later).

Then:

```bash
cp .env.example .env
cp models.local-openai.example.json models.json   # or one of the alternatives below
npm run compose:up
```

**Expect the first run to refuse to start.** `GATEWAY_ALLOWED_JURISDICTIONS` ships in `.env.example` only as a commented-out example, on purpose — the gateway will not guess which jurisdictions your own provider contracts cover, so it fails at startup until you set it yourself. Read the gateway's log line, uncomment and set `GATEWAY_ALLOWED_JURISDICTIONS` in `.env` to match `models.json` (`UK`, `EU`, `US`, `other` — processing blocs, not country codes; there is no `DE`, and it is `UK`, never `GB`), set whichever provider API key `models.json` needs, and run `npm run compose:up` again.

Three example model files are provided, because more than one is a first-class way to run this stack, not a fallback:

| File | Provider(s) | Needs | `GATEWAY_ALLOWED_JURISDICTIONS` |
|---|---|---|---|
| `models.example.json` | Azure Foundry, UK South | `az login` (managed identity — no key in `.env`) | `UK` |
| `models.local-openai.example.json` | OpenAI + Anthropic | `OPENAI_API_KEY` and/or `ANTHROPIC_API_KEY` | `US` |
| `models.local-recorded.example.json` | `recorded` (offline fixtures, Task 13) | nothing — no network call is ever made | `other` |

Copy whichever fits onto `models.json` (also gitignored — it is the operator's own allowlist, not something to commit).

`npm run compose:up` prints four seeded Keycloak accounts once the stack is up:

```
trainee  / trainee    reviewers
partner  / partner    partners
admin    / admin      admins
nogroups / nogroups   (no group - expect to be refused, on purpose)
```

Stage 1 enforces no roles, so all four sign in and see the same app — `partner`, `admin` and `nogroups` exist for Stage 2 onward, not because anything in this stage treats them differently yet. Open `http://localhost:3005` and sign in as `trainee` / `trainee` to run a review end to end.

```bash
npm run test:compose   # proves the network claim below against the running stack
npm run compose:down   # stop and remove the stack (including the Keycloak volume)
```

**The one architectural claim this whole arrangement exists to make checkable:** `api` sits on the `frontend` and `internal` Docker networks; `gateway` sits on `internal` and `egress`. `api` is deliberately **not** on `egress`, and `internal` is marked `internal: true`, so Docker adds no default route to anywhere outside the stack. "The API cannot reach a model provider directly" is therefore a fact about the network, checkable by anyone with `docker network inspect`, not only a property of `apps/api/src/gatewayClient.ts` being the only file in that service that ever calls `fetch`. `npm run test:compose` (`apps/api/test/egress.compose.test.ts`) asserts it against the live stack: `api` cannot reach a model provider, `api` cannot reach the internet at all, `api` *can* reach the gateway, and the gateway *can* reach the internet — the last two rule out a false pass from a stack that is simply unplugged.

**What running this locally does not prove.** Keycloak implements the same OIDC protocol Entra implements — it is not an Entra emulator, in the way Azurite genuinely emulates Blob Storage. Untested by this stack: Entra's group-claim shape and its overage behaviour, consent, conditional access, MFA, and tenant token lifetimes. A green run here is evidence about the authentication *path*, not about Entra specifically.

## Testing

```bash
npm test          # runs the full suite once
npm run test:watch  # watch mode
```

The suite is unit and integration tests (Vitest) covering the IndexedDB storage layer (matters, documents, blobs, reviews, playbooks, and the cascade-delete and localStorage-to-IndexedDB migration paths, run against `fake-indexeddb`), the OpenRouter client, PDF/DOCX parsing, citation matching, the review engine, and CSV/DOCX export. It does not include end-to-end browser tests or make real network calls — everything that talks to OpenRouter is mocked.

At the time of writing that is **1,742 tests across 130 files**, and two of them are guards rather than tests of behaviour: a palette scanner that fails the build if a raw colour is used anywhere instead of a semantic design token, and a contrast test that checks every colour pair in the design system against its assigned legibility floor — so a warning or a disclosure cannot quietly become too faint to read.

One convention worth adopting if you contribute: **anything load-bearing gets mutation-tested.** Break the implementation deliberately, confirm the test fails, then restore it. A green suite is not evidence on its own — a test that fails when you break the thing is. This project has shipped tests that passed against unfixed code and proved nothing, which is why the rule is written down.

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
- **A DOCX with tracked changes is read with every change accepted, and says so.** The library LexPrompt uses to extract text from a `.docx` returns the *accepted-changes* view of the document: deletions are removed and insertions are treated as final, with margin comments dropped entirely. LexPrompt cannot yet read the markup itself, so instead it checks every `.docx` for tracked changes and comments at upload, and says what it did — on the document in its matter, and again beside the findings in the review, where whoever is acting on them will see it. If the file's package can't be opened to check, it says *that* rather than nothing. One gap to know about: **documents added before this check existed were never checked** — their records carry no notice because nothing was ever looked at, not because they are clean. Re-adding such a document checks it.
- **The Assistant declines rather than guessing on unreadable documents.** If a document has no usable text and the selected model can't read images either, the chat panel tells you it can't answer rather than fabricating a plausible-sounding response. This is deliberate: a confident wrong answer about a contract is worse than an honest "I can't read this."
- **The template editor doesn't autosave, but it does ask before discarding.** Trying to leave with unpublished changes pending offers to save them as a draft or discard them; there's no third way to lose them silently. Nothing is written to your library until you either save a draft or publish, though — closing the browser tab without answering that prompt still loses whatever you typed.
- **Verification is single-reviewer.** A verification or note is attributed to the local profile on this browser. There is no second reviewer, no sharing a matter, and nothing here notifies anybody of anything — verifying, flagging, or rejecting a finding is a record for yourself and later readers of the export, not a handoff to a colleague.
- **A collection review isn't shown in the comparison grid.** The grid is built for comparing genuinely separate documents row by row; a collection produces one net position per clause, however many documents fed it, so there is nothing to compare — the grid refuses to open for a collection's review and points you back to the card view instead.
- **A document's effective date can't be entered yet.** A document record carries an optional effective date, and everything that would use one is built: the collection prompt labels each document with its date, and each step of a variation trail shows one. Nothing in the app can set it, though, so no date is ever known — a trail step shows its document by name alone, and the model is told the reading order of a collection but not when each amendment took effect. Nothing displays a blank or an empty "dated" where a date would go; the date is simply omitted. Reading order is unaffected either way: it is the order you set when you built the collection, and is deliberately never derived from a date. Entering a date is later work.
- **A collection whose base document is missing can't be run.** Every amendment acts on the base, so without it there's no starting position for any of them to vary; the collection's card says so and offers to choose a new base or ungroup, and starting a review is blocked until you do one or the other.
- **Phone-width layouts aren't built.** Every screen is responsive from 768px upward, but a dedicated phone layout is separate, later work rather than something this pass silently attempted and got wrong.
