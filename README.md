# LexPrompt

LexPrompt is a tool for reviewing contracts against a checklist of clauses you define. It is a static web app, an HTTP API, an inference gateway, a Postgres database and a blob store, deployed into your firm's own cloud. Your matters, documents, reviews and playbooks are stored there; model calls go through the gateway. You sign in with an identity provider your firm already runs, and there is no way to run it without doing so.

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
- **Selecting a matter as style material sends its verified findings to the configured model.** Only `verified` findings — never anything still unverified, flagged, or rejected, since those are the model's own unconfirmed output — and only for a matter you've explicitly ticked in the picker. This is the one place in the app where a matter *other than the one under review* is sent to a model at all, and the picker says so plainly next to the checkboxes, not in a Settings note.
- **Per-field AI suggestions in the by-hand editor are never adopted just by saving the form.** "Draft this for me" on an extraction instruction, risk criteria, or standard position shows the suggestion dashed, badged, and clearly unaccepted, with Use this / Try again / I'll write it myself. Saving the clause while a suggestion sits on screen unaccepted leaves the field exactly as it was before you asked.
- **"Suggest what I'm missing" proposes clause titles only**, checked against what the playbook already covers, added or dismissed one at a time — there's no "add all," because every clause entering a playbook is meant to be a decision, not a bulk import.

## Learning from redlines

A firm's house rules usually aren't written down anywhere — they're in the redlines: the fact that on four leases out of four, someone struck the landlord's right to withhold consent unreasonably. "Learn from redlines" reads a set of your own negotiated documents and proposes standard positions from what they actually show, with the evidence attached.

- **Bring in the documents that taught you something, not the document under review.** These are precedent — a "their draft → our markup → executed" chain, or standalone files — brought in to learn from, not to review. They're **stored in your firm's own LexPrompt**, like any other document, and **kept apart from matter documents**: a precedent is never offered as something to review, never added to a collection, and never cited in a report — refused by the service itself, not merely left out of a picker. Your firm's retention schedule decides how long a precedent set is kept, and deleting one makes the evidence behind any position learned from it unresolvable, which the app then says on screen rather than showing an empty panel. **Only the standard positions you go on to adopt reach a playbook** — storing a precedent does not put it in one.
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
- **Fonts are vendored, not fetched.** `public/fonts/` holds six latin-subset `.woff2` files (a serif for document prose, a sans for interface chrome, a mono for labels and chips) under a combined budget of 350 KiB, checked by a test that also confirms nothing in the app links to a third-party font host. This is a privacy decision as much as a performance one: the app's own disclosure says nothing leaves the browser except calls to your firm's own API, and a Google Fonts `<link>` would make that false on every page view — before a user has done anything at all. Updating a font version is consequently a manual step — there is no font package as a dependency.
- **The chrome is honest about what the app can actually do.** The header avatar shows your own initials, taken from the account you signed in with; there is no assignee chip, no "assigned to me" counter, and no firm-wide search box. Accounts are real now, so the reason those are absent has changed and is worth stating exactly: it is no longer that there is nobody to assign to — it is that **assignment, presence and notification are not built**, and an affordance that implies otherwise would be a promise the app cannot keep. The matter activity feed is derived from your own verifications, notes, and confirmations at the moment you view it — it is not a stored event log, so it can never show an entry claiming a second person did something. Each of those comes back when its mechanism is real, and not before.
- **A matter's status board and its `Standard positions` tab both refuse to overstate.** The status board shows an empty form — not a row of zeroes — for a matter with no completed review yet, because "0 of 0 verified" reads as a fact about safety it hasn't earned. `Standard positions` lists every clause carrying a house position across your playbooks and marks each `HELD`, `CONCEDED`, or `UNTESTED` from verified findings only, built entirely from data the app already derives elsewhere — no new model calls, no new stored state.
- **The app is usable from 768px upward.** Phone-width layouts are a separate, later piece of work — this pass covers tablet and desktop widths of the existing screens, not a phone-specific redesign.

## The services, and the two stores

There are three services and two stores, all inside your firm's own cloud tenant.

- **`web`** — the static bundle of HTML, CSS and JavaScript this repository builds, served by nginx, which also proxies `/api` to the API on the same origin.
- **`api`** — validates the signed-in user's token on every request, reads and writes the two stores below, and forwards model calls onward. It holds no provider credential, and it is deliberately unable to reach the internet.
- **`gateway`** — the only process permitted to call a model provider. It holds the provider credentials, enforces an allowlist of provider+model pairs, and writes one call record per request. It holds **no database credential and no blob credential**, and has no client for either, so compromising it yields the calls in flight and never the archive.
- **Postgres** — every record: matters, documents' metadata and extracted text, collections, reviews and their findings, playbooks and their published versions, changesets, precedent sets, standard-position evidence, and the user rows sign-in creates. Locally a container on a network with no route out; in a firm a Flexible Server with public network access disabled and a private endpoint.
- **A blob store** — original file bytes, and nothing else. Locally Azurite (Microsoft's own emulator, not anything "S3-compatible"); in a firm an Azure Storage account with public network access disabled, a private endpoint, and shared-key authentication switched off entirely, so the API reaches it with a managed identity and there is no key to hold.

**Your matters, documents, reviews and playbooks are stored by your firm's own service, not by your browser.** Anything you created before this release is still in this browser's IndexedDB and is *not* deleted by moving it — see [Moving your existing data](#moving-your-existing-data) and [Privacy](#privacy).

There **are** user accounts now, and they are not LexPrompt's: you sign in against an identity provider your firm already runs, and LexPrompt records the account the issuer names plus the role your firm's own group membership maps to. It has no password of yours, no way to create an account, and no way to run without signing in. What it does not yet have is anything two people can do to each other's work — see [Known limitations](#known-limitations).

### What is stored, and where

Matter documents and precedent documents are both stored, and they are deliberately kept apart. This is the whole table:

| | Matter document | Precedent document |
|---|---|---|
| What it is | A contract under review, in a matter | One of your own past negotiated documents, brought in to learn house positions from |
| Original file bytes | Blob store | Blob store |
| Record and extracted text | Postgres, `kind = 'matter'` | Postgres, `kind = 'precedent'`, in a precedent set |
| Belongs to | A matter | A precedent set — never a matter |
| Can be reviewed | Yes | **No.** The API refuses it as a review target, not merely hides it in a picker |
| Can join a collection | Yes | **No.** Refused the same way |
| Can be cited in a report | Yes | No |
| What a delete removes | The document's row and its bytes. Deleting the matter deletes every document in it, and their bytes | The precedent set, its documents' rows and their bytes. Any standard position learned from it keeps its wording and loses its evidence, and the evidence panel says so rather than showing an empty panel |
| Page images for a scan | Never stored anywhere — regenerated on demand from the bytes | Never stored anywhere |

**How long precedent documents are kept is your firm's decision and LexPrompt does not decide it.** There is no retention schedule in this software, no default expiry, and nothing that deletes a precedent set on its own; a precedent set stays until somebody removes it. That is a deliberate refusal rather than an omission — the alternative is a tool quietly deciding how long another client's papers sit in your database.

## Choosing a model provider

You do not need an API key, and there is nowhere to type one. Which model answers a review is your administrator's decision, recorded in one file: the gateway's **allowlist** of provider+model pairs. A user picks from that list and cannot name a model that is not on it.

Six providers have adapters:

| Provider | What it is |
|---|---|
| `azure-foundry` | Azure AI Foundry, in a region you choose |
| `azure-openai` | Azure OpenAI Service, in a region you choose |
| `openai` | OpenAI's own API |
| `anthropic` | Anthropic's own API |
| `openrouter` | OpenRouter, as a front end to many providers |
| `recorded` | Replays fixtures from disk. Makes no network call at all, and every allowlist entry using it must declare its jurisdiction as `other`, because a recorded response comes from the machine it is running on |

A credential reaches the gateway from one of four sources, named per entry: an Azure **managed identity**, an Azure **Key Vault** secret, an **environment variable**, or a **file** on disk.

> **No credential ever leaves the gateway, and every call is logged with its provider and jurisdiction, whichever backend you configure.**
>
> **If you deploy against Azure with managed identity, the stronger property holds: no provider keys exist at all — not in a browser, not in an environment variable, not in Key Vault, not in a git history. That is the recommended posture for a firm with Azure.**

Both of those are true and they are two sentences on purpose. The second is a claim about one deployment shape; stated as though it covered all of them, it would tell a firm running against OpenAI something that is not true of their deployment.

**`GATEWAY_ALLOWED_JURISDICTIONS` has no default, and the gateway refuses to start without it.** It lists the processing blocs this deployment permits — `UK`, `EU`, `US`, `other`, comma-separated. A model whose declared jurisdiction is outside the set stops the process at startup, and a call that would reach one is refused before any request leaves.

Which jurisdictions you permit follows from the contracts and data provisions you hold with your provider. LexPrompt enforces the policy you declare; it has no view of its own, and a default would be exactly such a view applied silently on your behalf.

**The per-provider retention note is your record of terms you agreed.** Each allowlist entry can carry a `dataHandling` note — what the provider's terms say about retention, training and sub-processing — with the date you last checked them. The date is a staleness marker: it prompts you to re-read your own contract when it ages. It passes no judgement on the provider, and nothing in the code grades or scores it. Check each configured provider's current retention terms before you go live; they have a shelf life, and this file cannot know when they changed.

## Matters

Work in LexPrompt is organised around **matters** — a matter is the top-level object, and it holds the documents you've added to it and every review you've run over them. This replaced an earlier, session-only version of the app where a review's results vanished on reload; a matter that forgot its documents wasn't really a matter, so this was changed deliberately (see [Privacy](#privacy) below for exactly what that means for your data).

Matters, reviews, and templates are addressable by URL: `/matters/:id` opens a matter, `/matters/:id/reviews/:id` opens one of its reviews, and `/playbooks/:id` opens a template (called a "playbook" internally and in the URL, and in the storage layer) for editing. These are real deep links — reloading the page on one, or sharing the URL with yourself, returns to the same place.

**This means any static host you deploy to must rewrite all paths to `index.html` (SPA fallback).** Without it, refreshing the page on a deep link like `/matters/abc123` returns a 404 from the host, not from the app — which looks like LexPrompt is broken rather than like a hosting configuration gap. `firebase.json` in this repository already configures this rewrite for Firebase Hosting; if you deploy elsewhere (Netlify, Vercel, GitHub Pages, S3 + CloudFront, nginx, etc.), you must configure the equivalent yourself. See [Building and deploying](#building-and-deploying) below.

## Privacy

This matters if you're evaluating LexPrompt for real contract work, so it's stated plainly:

- **Matters, documents, and reviews are stored by your firm's own LexPrompt service** — the records and their text in its database, the original file bytes in its object storage, both inside your firm's own cloud tenant. Colleagues with access to a matter can see it.
- **Documents are uploaded to your firm's own LexPrompt API, and to nothing else.** They are stored by it and read back from it. When you run a review, that API sends the text (or, for a scan, page images) through your firm's own gateway to the model provider your administrator configured — the gateway is the only process that talks to a provider, and it is the only place your text goes outside your firm's tenant. Which provider that is, and where it processes your text, is shown on every model in Settings. LexPrompt adds no retention of its own on top of whatever terms your firm holds with that provider; see [Choosing a model provider](#choosing-a-model-provider) for where those terms are recorded.
- **Deleting a matter deletes its documents and their stored bytes**, not just the matter's entry in a list. This cascade is real and covered by tests, not just a UI-level hide.
- **Retention and backups are your firm's**, not this app's. LexPrompt adds no retention of its own and takes no backups of its own; your administrator decides how long everything is kept.
- **Page images generated for scanned PDFs are never stored.** When a scanned page needs an image (because it has no usable text layer), it's rendered on demand from the document's stored original bytes and kept only in memory for that session.
- **The copy already in this browser is left exactly where it is.** Everything an earlier version of LexPrompt wrote to this browser's IndexedDB — matters, documents and their bytes, collections, reviews with your verifications in them, playbooks, versions, changesets — is still there. The app no longer reads it, no longer writes to it (the database is opened read-only, and a write throws rather than being quietly lost), and does not delete it. A later release removes it, once the server copy has been confirmed good. (An OpenRouter key stored by an earlier version is deleted from this browser the first time you open this one, and the app says so once — deleting a key is not revoking it, so revoke it at the provider too if you no longer need it.)

## Moving your existing data

Everything an earlier version of LexPrompt kept in this browser is still in this browser. It is not on the server until you move it, and the app will not move it behind your back.

A banner sits above every screen while there is anything here to move, and **Move it to the server** opens one screen (`/upload-local-data`) that:

- reads the local database and lists, **by name**, every matter, document, collection, review, playbook, version and changeset in it, plus roughly how many bytes of original files that is;
- says so when it could not read part of it — an unreadable store is reported as *unknown*, never as zero, because "there is nothing here" and "I could not tell" are different facts and only one of them means your data is gone;
- warns you before you start about any document whose original file is no longer in this browser (a record can outlive its bytes), so nobody reads "3 documents moved" and assumes three files came with them;
- uploads everything through the same write paths the app itself uses — no bulk-import endpoint, so nothing arrives that the app would have refused;
- **reports by name what did not move, and why.** The heading only reads "Everything moved" when everything did; a single failure and it reads "Some of your data did not move", with the failures listed above the successes.

Two things are true of it whatever happens:

- **Nothing is deleted from this browser.** Not on success, not on failure. The local copy is your only copy until you have confirmed the server one, and this app does not delete what it cannot read.
- **Running it twice is safe.** Every record already on the server is confirmed rather than duplicated, so an interrupted or partly-failed run is finished by pressing Upload again.

After a complete run the banner changes rather than disappearing — *"Your data is on the server. A copy is still in this browser and will be removed in a later release."* — because a banner that vanishes is a person who never learns the copy is still there.

Templates written by the very first version of LexPrompt, which lived in `localStorage` rather than IndexedDB, are read by this screen too. The startup migration that used to copy them into IndexedDB has been removed (from the release where every repository became an HTTP client, it was writing into a store the app no longer read), and its `localStorage` source was never deleted — so those templates are picked up here instead, and nothing is orphaned.

## How it's built

A TypeScript monorepo: a React 19 single-page app built with Vite and styled with Tailwind 4, a Fastify API, an inference gateway, and a `packages/core` both sides import so one idea never gets two implementations.

```
packages/core/    the vocabulary the browser and the API both speak —
                  wire types, roles, and the shared logic neither side
                  may re-derive
apps/api/         Fastify. Validates a token on every request, owns the
                  Postgres schema and its migrations, and is the only
                  process holding a database or blob credential
apps/gateway/     the only process permitted to call a model provider
src/              the web app
  lib/            pure logic and persistence — no React
    db/           one repository per record type, each an HTTP client
                  against apps/api (matters, documents, blobs, reviews,
                  playbooks, collections, playbookVersions, changesets,
                  profile). `blobs` is a route over the blob store rather
                  than a table; the other eight are tables
    model/        the ONLY route to a model: the gateway client, and the
                  closed set of purposes every call must name
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
- **One route to a model.** Every request from the browser goes through `src/lib/model/gatewayModelClient.ts`, to your firm's own `api`, and onward to the gateway. The retry policy now lives in the gateway, where the provider's status code actually arrives: it retries only on 429 and 5xx and fails fast on 4xx. A failure a Retry button cannot fix is classified as one (`authFailure.ts`) so the screen offers the right thing rather than a button that will fail again.
- **The card view, the comparison grid and the clause index are three renderers over one findings map.** None of them derives its own counts. The moment two of them compute "how many are verified" separately, they can disagree, and a reader has no way to know which to believe.
- **Derived state is derived, not stored.** Position health, matter statistics and the activity feed are computed at read time from what already exists. A stored summary is a second source of truth that can drift from the thing it summarises.
- **A route with no authorisation policy fails the build.** Every API route is a key in one table that says which roles may call it; there is no default and no fallback, so adding a route without deciding who may call it does not compile. What the UI hides is a convenience — what the API refuses is the rule, and the two are tested as a pair so a screen cannot quietly become the only thing standing between a trainee and a publish.
- **Every query is scoped to the workspace, and every matter-context query is scoped to `kind = 'matter'`.** Both are enforced by a scanner over the SQL rather than by review, because a query that forgets either fails by showing **too much** — a precedent from another client's file appearing where a lawyer expects the deal in hand — and nothing on screen would look wrong.

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

This starts a Vite dev server (default `http://127.0.0.1:3005`) for the web app alone. It needs an `api` to call and an identity provider to sign in against, so on its own it renders the sign-in gate and goes no further. To run the whole thing, use the compose stack below.

## Running the server stack locally

`docker compose up` brings up the whole system: a `gateway` that is the only process allowed to call a model provider, an `api` that authenticates every request against a real identity provider and owns both stores, a `web` static build in front of both, a `postgres` and an `azurite` neither of which has a route out or a published port, and a Keycloak realm to sign in against. **There is no way to run LexPrompt without signing in.** No `SKIP_AUTH`, no anonymous mode, no trusted header, no development issuer that skips validation — a bypass would test a different code path from the one that ships, which would make a green local run evidence about something nobody deploys. A local Keycloak realm ships alongside the services instead, so the whole sign-in path runs on a laptop exactly as it runs in a tenant. The cost of that decision is one more container and about twenty seconds of cold start; the cost of the alternative is a flag that reaches production enabled.

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

**Those roles are now enforced, by the API and not by the UI.** A `trainee` reviews and verifies but cannot publish a playbook version or change the workspace's model; a `partner` can publish; an `admin` can also change workspace settings and sweep orphaned document files. `nogroups` is in no mapped group and is **refused** — told plainly which account it signed in as and that its administrator maps groups to roles, with no user record created for it. Every one of those refusals is the API's; the screens hide what a role cannot do as a convenience, and the two are tested as a pair, because a gate whose only enforcement is a greyed-out button is a suggestion rather than a gate. Open `http://localhost:3005` and sign in as `trainee` / `trainee` to run a review end to end.

```bash
npm run test:compose   # proves the network claim below against the running stack
npm run compose:down   # stop and remove the stack (including the Keycloak volume)
```

**The one architectural claim this whole arrangement exists to make checkable:** `api` sits on the `internal` network **only**, with no published port of its own — a browser reaches it through `web`'s nginx proxy. `gateway` sits on `internal` and `egress`. Being off `egress` was never sufficient on its own: a container's outbound access in Docker comes from being attached to **any** non-internal network, so an `api` also attached to a routable network had a default route and full internet access while the file still read as "api is not on egress". `internal` is marked `internal: true`, so Docker adds no default route to anywhere outside the stack. "The API cannot reach a model provider directly" is therefore a fact about the network, checkable by anyone with `docker network inspect`, not only a property of `apps/api/src/gatewayClient.ts` being the only file in that service that ever calls `fetch`. `npm run test:compose` (`apps/api/test/egress.compose.test.ts`) asserts it against the live stack: `api` cannot reach a model provider, `api` cannot reach the internet at all, `api` *can* reach the gateway, and the gateway *can* reach the internet — the last two rule out a false pass from a stack that is simply unplugged.

### Reclaiming orphaned document files (operator only)

A document's bytes are written to blob storage *before* its database row is inserted, deliberately: a row pointing at bytes that do not exist is a document that opens empty, and a few bytes nobody claims is a leak. So a failure between those two steps — or a `delete` that storage refuses during a matter cascade — leaves **orphaned blobs**: a client's contract sitting in the firm's storage with no record claiming it. The README's promise that deleting a matter deletes its documents' bytes is only true if somebody sweeps them.

Two admin-only routes do the sweep. **There is no screen for them, and there is no scheduler** — a scheduled job needs a worker, which is Stage 3. That is deferred, not silently missing: today the path is `curl`, and this section is it.

Both need an **admin's** bearer token (`GET`/`POST` are `admin` in `ROUTE_POLICY`; a reviewer or partner gets a 403). Keycloak's `lexprompt-web` client has direct access grants disabled on purpose, so there is no password grant to script — take the token from a signed-in admin's own browser session instead: sign in at `http://localhost:3005` as `admin` / `admin`, then DevTools → Application → Session Storage → the `oidc.user:…` entry → `access_token`.

```bash
TOKEN=...   # the access_token from the signed-in admin's session

# What is orphaned. Read-only: nothing is deleted, and the keys are scoped
# to this workspace's prefix at both ends, so another workspace's bytes can
# never appear here.
curl -s -H "Authorization: Bearer $TOKEN" \
  http://localhost:3005/api/v1/admin/blob-orphans

# Delete them. The list is RECOMPUTED server-side rather than taken from the
# request body — a key list in a body is a caller naming bytes to destroy,
# and the only list this route acts on is the one it derived itself. Run the
# GET first and read it.
curl -s -X POST -H "Authorization: Bearer $TOKEN" \
  http://localhost:3005/api/v1/admin/blob-orphans/delete
```

This is also the remedy behind the error a user sees when a delete half-succeeds — *"The records were deleted, but N document files could not be deleted from storage… An administrator can list and remove them"*. That sentence used to point at an administrator who had nothing to act with.

In Azure the host differs and the token comes from Entra rather than Keycloak; the two routes and their behaviour do not.

### What has actually been run, and what has not

Stated plainly, because a reader of this file has no other way to tell.

**Driven in a real browser against a running compose stack:** the sign-in gate renders; **Sign in** redirects to Keycloak with `response_type=code` and `code_challenge_method=S256` (PKCE, no MSAL); Keycloak serves its login page; an error-shaped redirect back renders "LexPrompt couldn't sign you in" with the reason and a Retry; `npm run test:compose` passes all four of its network assertions.

**Verified against the running stack without a browser:** the whole of `npm run test:pg` — 220 tests over a real Postgres, including every table's whole-record round trip, the grants, and the matter cascade deleting real blobs out of Azurite; real Keycloak tokens accepted and a user in no mapped group refused with no account row created; and `GET /api/v1/matters` with no token answering `401 sign_in_required` rather than an empty list, which is the founding rule holding at the HTTP boundary.

**Not done, and this is the largest gap in this file. No credentials were entered.** **Nothing in the server rebuild past the sign-in redirect has ever been watched in a browser**, so the token exchange, an end-to-end review, the four seeded accounts seeing different things, the screen that moves this browser's data to the server, the sentence a lawyer reads when bringing in a precedent document, and the standard-position evidence panel are **all covered by unit, integration, real-Postgres and real-token HTTP tests, and by nothing that has looked at a screen.** Browser automation was unavailable throughout: the Chrome extension disconnected mid-way and Playwright's driver times out. That is stated rather than worked around, because two of this project's worst defects — a review screen showing zero documents, and a failed review becoming permanently unopenable — were invisible to thousands of passing tests and appeared only when somebody drove the real app. **These need a person.**

The stream fixtures are synthetic, hand-authored from published wire formats rather than captured; `apps/gateway/src/smoke.ts` **has never been run against a live provider**; and nothing has been deployed to Azure.

## What running locally does not prove

§5.1 of the design puts this list in the README as well as in the spec, on the grounds that the reader who needs it is a developer who has just had a green local run — and they are not reading a design document at that moment.

**Keycloak is not an Entra emulator. Azurite *emulates* Blob Storage; Keycloak *implements the same protocol* Entra implements.** That is a weaker claim, and the gap is exactly where the list below says it is.

A green local run says nothing about:

- **Managed-identity acquisition.** Whether a workload identity actually gets a token for the audience it asks for, in a real tenant.
- **Entra's group-claim shape, consent, and group overage.** Overage — the claim being replaced by a Graph pointer once a user is in enough groups — is the case most likely to be met in a real tenant and impossible to meet locally.
- **Admin consent, conditional access, MFA and tenant token lifetimes.** None of these has a local analogue.
- **Azure networking, and the real egress denial.** The compose stack proves it with Docker networks; Azure would prove it with a VNet-integrated environment and a route table, which this template does not yet create. That is Spike 2.
- **Postgres Flexible Server's behaviour**, and **Azurite's gaps** as a stand-in for Blob Storage. Both are provisioned now (`infra/modules/postgres.bicep`, `infra/modules/storage.bicep`) and neither template has been deployed, so what a green local run proves about them is what a container proves: the SQL is right and the SDK calls are right. It says nothing about a private endpoint resolving, about `max_connections` under real concurrency, about a managed identity actually being granted a token for the storage account, or about Azurite's own divergences from the real service under load.
- **Real provider latency, rate limits and stream behaviour.** Every fixture in this repository is hand-authored.
- **Container Apps scale-to-zero, and multi-replica WebSockets.** A second replica changes the rate limiter's assumptions now, and the realtime channel's later.

A green run here is evidence about the authentication *path* and about the *shape* of the system. It is not evidence about a tenant.

## Deploying to Azure (`azd`)

`azure.yaml` and `infra/` provision the **same system** described above — three services, one gateway holding every provider credential, one auth path with two issuers — in Azure Container Apps. §5.1's argument is that local and Azure differ in *deployment*, not in code: `docker-compose.yml`'s `mtls` caller-auth mode becomes `entra`, Keycloak becomes Entra, and the compose network isolation (`api` not on `egress`) becomes an internal-only Container App for the gateway. Nothing in `apps/api` or `apps/gateway` branches on being in Azure; only the environment variables in `infra/modules/containerApps.bicep` differ from `docker-compose.yml`'s.

**This has not been deployed.** There is no Azure subscription and no `az`/`azd`/`bicep` CLI available in the environment this template was written in. What was checked instead: every file parses (`azure.yaml` as YAML, `infra/main.parameters.json` as JSON), and every environment variable the template sets was cross-referenced by name against `apps/api/src/config.ts` and `apps/gateway/src/config.ts` — the two files that actually read them. See `.superpowers/sdd/2026-08-28-lexprompt-server-stage-1-gateway/task-25-report.md` for the exact diff. **Do not treat this template as proven until someone runs it against a real subscription and works through the verification steps below.**

**Prerequisites `azd up` does not create for you:**
1. Two Entra **App Registrations**: one for the API (its `oidcAudience`; the browser signs in against `oidcClientId`, a public client on the same or a paired registration) and one for the **gateway itself** (`gatewayEntraAudience`) — a service-to-service audience with exactly one caller, `api`'s managed identity. Creating an App Registration is not expressed in this Bicep: it needs either the Microsoft Graph Bicep extension (still preview) or `az ad app create`/the portal, and adding an experimental Graph dependency for this alone was judged out of scope for a Stage 1 template that provisions no database either. Create both by hand first (the same category of manual step as `az keyvault secret set` below), and record their ids for the parameters below.
2. If any configured model uses `credential.source: "managed-identity"` against Azure OpenAI / Foundry, that resource must already exist; pass its resource id as `openAiResourceId` so `identity.bicep` can grant the gateway's identity `Cognitive Services OpenAI User` on it. Leave it empty for a deployment using only `key-vault`/third-party providers.
3. After the first `azd provision`, add every provider key `models.json` needs via `az keyvault secret set --vault-name <name> --name <secretName> --value <key>` — never as a parameter, an azd env value, or a committed file. `keyVault.bicep` deliberately defines no secrets.
4. Author `models.json` yourself (same file shape as the compose stack's, `models.example.json` for the Azure-native shape) and pass its content as the `MODELS_JSON_CONTENT` azd environment value — it is mounted as a Container Apps secret volume (`GATEWAY_MODELS_FILE=/config/models.json`), never an environment variable, so it is absent from the portal's app-settings blade and from `azd env get-values`.

**Two steps Bicep cannot do, and one ordering consequence of holding every credential in Key Vault.** These are not omissions to be tidied up later — each one is a thing a template is not allowed to do on a firm's behalf, and each fails loudly rather than quietly if it is skipped.

**(a) The first `azd provision` will fail, and that is the design.** The template reads three passwords out of the Key Vault it creates, with `getSecret()` — never a parameter with a default, never an azd environment value, never an output. On a fresh subscription the vault is created empty, so the run stops when it reaches Postgres and names the vault and the missing secret. Create the three, then run it again:

```bash
azd provision                                   # creates the RG, identities, VNet and the vault; FAILS on Postgres
VAULT=$(azd env get-value KEY_VAULT_URI | sed -E 's#https://([^.]+)\..*#\1#')

az keyvault secret set --vault-name "$VAULT" --name postgres-admin-password     --value "$(openssl rand -base64 24 | tr -d '/+=')"
az keyvault secret set --vault-name "$VAULT" --name database-app-password       --value "$(openssl rand -base64 24 | tr -d '/+=')"
az keyvault secret set --vault-name "$VAULT" --name database-migrator-password  --value "$(openssl rand -base64 24 | tr -d '/+=')"

azd provision                                   # now provisions Postgres, Storage and the three Container Apps
```

The alternative — a `@secure()` parameter fed from the azd environment — would put three live database credentials in `.azure/<env>/.env` on somebody's laptop, which is the thing this whole arrangement exists not to do. (The DSNs the API reads are composed *inside* the Bicep from those passwords and the server's FQDN, so no connection string is ever a parameter, an output, or an app setting either.)

**(b) Creating `lexprompt_migrator`, `lexprompt_app` and `lexprompt_worker`.** `infra/postgres/init.sql` is the local form of this. In Azure it is one `psql` run by the Flexible Server admin, after provisioning and **before the first `azd deploy`** — the server has public network access disabled, so run it from inside the VNet (a jump box, Cloud Shell with VNet integration, or `az containerapp exec` into the `api` app once it exists). Use the same passwords you put in the vault:

```sql
-- as the admin, connected to the `lexprompt` database
create role lexprompt_migrator login password '<database-migrator-password>';
create role lexprompt_app      login password '<database-app-password>';
-- The run worker (Stage 3, §9). Store its password in the vault beside the
-- other two as `database-worker-password`; the Container App that reads it
-- arrives with the worker itself, later in Stage 3.
create role lexprompt_worker   login password '<database-worker-password>';
grant connect on database lexprompt to lexprompt_migrator, lexprompt_app, lexprompt_worker;
-- The worker's declared statement_timeout has to be set here too: ALTER ROLE
-- needs CREATEROLE, which lexprompt_migrator deliberately does not have, so
-- migration 005 asserts this line was run rather than running it.
alter role lexprompt_worker set statement_timeout = '60s';
-- the rest of the grants are what infra/postgres/init.sql does locally; read
-- it and mirror it, because the two must not drift.
```

Skipping this is not silent: `000_preconditions.sql` refuses the migration with a message naming this step for the first two roles, and `005_findings.sql` does the same for `lexprompt_worker` and for its missing `statement_timeout`. That is why those blocks exist rather than letting a `GRANT` fail with "role does not exist".

**(c) Confirming the private endpoints resolve.** §5.1's own list says Azure networking is not exercised locally, so this is the one check that has no local equivalent. From inside the Container Apps environment:

```bash
az containerapp exec --name <namePrefix>-api --command sh
# then, inside the container:
getent hosts <namePrefix>-pg.postgres.database.azure.com
getent hosts <namePrefix>st.blob.core.windows.net
```

**A correct answer is a private address** — something in the VNet's `10.20.2.0/24` private-endpoint subnet. A public address (or a CNAME resolving to one) means the private DNS zone is not linked to the VNet: the endpoints will look green in the portal and every connection will time out, which reads as a firewall problem and is not one.

```bash
azd auth login
azd up      # prompts for GATEWAY_ALLOWED_JURISDICTIONS — there is no default in the template;
            # answer only from your own provider contracts and data provisions, exactly as
            # .env.example requires locally. It also prompts for OIDC_ISSUER, OIDC_AUDIENCE,
            # OIDC_REQUIRED_CLAIMS, OIDC_CLIENT_ID, OIDC_SCOPE, GATEWAY_ENTRA_TENANT_ID,
            # GATEWAY_ENTRA_AUDIENCE and MODELS_JSON_CONTENT — none of these have defaults either.
azd env get-values | grep -i -E 'key|secret|password' ; echo "exit=$?  <-- expect no matches"
azd env get-values | grep -i 'allowedJurisdictions'   # <-- expect the value YOU supplied
```

Then, against the deployed environment (**not verified here — this is what Step 3 of the task brief asks for, and it cannot be simulated**):
1. Open the web app, sign in with a firm account, and confirm the model picker lists the configured models with their jurisdictions.
2. Run a one-clause review and confirm a finding comes back.
3. `az containerapp logs show --name <namePrefix>-gateway --tail 20` and confirm one `call.started` and one `call.finished` per call, carrying no prompt text.
4. Confirm the gateway's FQDN is `*.internal.*` and that `curl` from outside the environment cannot reach it.

**`api` cannot yet authenticate to the gateway with a managed identity, and it now refuses to start rather than pretending otherwise.** `makeGatewayClient` accepts an optional `getGatewayToken()` callback and attaches it as a Bearer token, but nothing supplies one: acquiring a managed-identity token for the gateway's audience needs `@azure/identity` in `apps/api`, an audience value this service is not yet given, and a real tenant to test against. Rather than deploy an `api` that starts cleanly, reports itself healthy and has every single request refused by `GATEWAY_CALLER_AUTH=entra`, `apps/api` **refuses to start** when it has neither a client certificate nor a token source — naming both modes and the missing wiring in the message. So this template will provision successfully and the `api` container will fail its startup, loudly, until that wiring lands. That is deliberate: a crash-looping container with an explanatory log line is a far cheaper failure than a healthy-looking service whose model calls silently never succeed. Verification step 2 above cannot pass until then.

**What this template does NOT enforce, and says so rather than implying otherwise:** the Container Apps environment is now VNet-integrated — Stage 2 needed that so the two private endpoints resolve — but **VNet integration is an inbound fact, not an outbound one**. There is no route table, no NAT gateway and no firewall in this Bicep, so `api`'s Container App still has ordinary outbound internet access. The Azure counterpart of compose's network isolation (`api` not on the `egress` network) is therefore **not yet a fact about this deployment**, only a fact about the local stack — unchanged by the VNet, and it would be an easy sentence to delete by accident on reading that a VNet arrived. Enforcing it needs an egress lockdown forcing all outbound traffic through a firewall or a route table, and that is Spike 2's work. `npm run test:compose`'s assertion is what actually holds today; nothing equivalent runs against Azure yet.

**The deployer's checklist.** Nobody can automate these, so they are a list to tick. Four of them, and the last one is a command rather than a judgement:

- [ ] **Public network access is disabled on both stores.** `infra/modules/postgres.bicep` sets `network.publicNetworkAccess: 'Disabled'`; `infra/modules/storage.bicep` sets `publicNetworkAccess: 'Disabled'` and `networkAcls.defaultAction: 'Deny'` with **no** `AzureServices` bypass. Confirm both in the portal after provisioning — a policy in the tenant can override a template.
- [ ] **The private endpoints resolve from inside the Container Apps environment**, by the two `getent hosts` commands in step (c) above, and the answers are private addresses.
- [ ] **The Postgres admin password exists only in Key Vault.** It is not a parameter with a default, not an output, not an app setting, and not in `.azure/<env>/.env`. `azd env get-values | grep -i -E 'key|secret|password'` returns nothing.
- [ ] **No storage connection string exists anywhere in the template, the parameters file, or the azd environment** — searched, not assumed:

```bash
grep -rniE 'AccountKey=|DefaultEndpointsProtocol=|API_BLOB_CONNECTION_STRING' infra azure.yaml
# expect: no output
```

That absence is the Azure half of the stronger security property, expressed the same way Stage 1 expressed it for provider keys. It is also more than a convention here: the storage account is created with **shared-key authentication switched off**, so an account key authenticates nothing even if one were to leak. The API reaches the container with its own managed identity, granted `Storage Blob Data Contributor` **on the container** — not on the account, not on the subscription, and not Owner.

**Postgres and Blob Storage are provisioned, and neither has been deployed.** `infra/modules/postgres.bicep` and `infra/modules/storage.bicep` are new in Stage 2, along with `infra/modules/network.bicep` for the VNet they sit behind. **No `az`, `azd` or `bicep` CLI was available in the environment they were written in, and there is no Azure subscription** — so nothing here has been compiled, validated, or deployed, and no resource has ever been created from it. What was checked instead is what could be checked: every environment variable the template sets was cross-referenced **by name** against `apps/api/src/config.ts`'s reads, and `sslmode=verify-full` in the composed DSN was checked against the pinned `pg-connection-string` (2.14.0) that actually parses it — `require` and `prefer` reach the same code path but print a deprecation warning, and `no-verify` silently turns certificate verification off. The one defect that cross-reference found is recorded in `.superpowers/sdd/2026-08-29-lexprompt-server-stage-2-storage-and-auth/task-24-27-report.md`: `apps/api/src/blob/store.ts` constructs `new DefaultAzureCredential()` with no options, whose managed-identity leg resolves a **user-assigned** identity's client id from `AZURE_CLIENT_ID` and from nowhere else, so the Bicep sets it — without it every document byte read and write would have failed in Azure with every unit test green.

## Testing

```bash
npm test          # runs the full suite once
npm run test:watch  # watch mode
```

The suite is unit and integration tests (Vitest) covering the repositories and the API routes behind them (matters, documents, blobs, reviews, playbooks, and the cascade-delete path, the route suites run against a real Postgres), the local-data uploader (still run against `fake-indexeddb`, which stays for exactly as long as that screen does), the gateway client and the gateway's own provider adapters, PDF/DOCX parsing, citation matching, the review engine, and CSV/DOCX export. It does not include end-to-end browser tests or make real network calls: every provider is faked at the transport, and the stream fixtures the adapter conformance suite runs against are hand-authored from each provider's published wire format rather than captured from a live response. Each fixture says so in its own header, and nothing here has been run against a live provider.

There are three more suites beyond `npm test`, and they are separate because each needs something running:

```bash
npm test              # 2,693 tests across 198 files — no network, no containers
npm run test:pg       # 220 tests across 16 files, against a REAL Postgres
npm run test:compose  # 14 tests across 4 files, against the running compose stack
```

`test:pg` is where every grant, every cascade and every whole-record round trip is proved against the real database rather than against a fake — a permission is a property of a `GRANT`, not of a code path, and a fake client cannot refuse anything. It needs the stack up and a bridge to the container's Postgres (`bash scripts/pg-forward.sh` prints the two variables to export); the database is deliberately not published on a host port, because a database reachable from the host is a database reachable from anything else on it.

Several of these are guards rather than tests of behaviour, and they are the ones most likely to look deletable: a palette scanner that fails the build on a raw colour anywhere instead of a semantic design token; a contrast test that checks every colour pair against its legibility floor, so a warning or a disclosure cannot quietly become too faint to read; a configuration-surface test that fails if the local and deployed environments differ by any key the divergence table does not name **and equally if the table names a key nothing sets**; a scanner that fails if any SQL touching a matter forgets its workspace or its `kind`; and a search over `src/`, the README and the test suite for any sentence that denies a precedent document is kept.

One convention worth adopting if you contribute: **anything load-bearing gets mutation-tested.** Break the implementation deliberately, confirm the test fails, then restore it. A green suite is not evidence on its own — a test that fails when you break the thing is. This project has shipped tests that passed against unfixed code and proved nothing, which is why the rule is written down.

## Building and deploying

For the whole stack, rather than the web bundle alone:

```bash
docker compose up      # locally — see Running the server stack locally, above
azd up                 # into your own Azure subscription — see Deploying to Azure
```

For the web app on its own:

```bash
npm run build
```

This runs `tsc` for a type check and then produces a static `dist/` folder with Vite. The result is a set of plain HTML/CSS/JS files — deploy it to any static host: Netlify, Vercel, GitHub Pages, S3 + CloudFront, nginx, or similar. This builds the `web` service only; `api` and `gateway` are separate images (see [Running the server stack locally](#running-the-server-stack-locally) and [Deploying to Azure](#deploying-to-azure-azd)). The web bundle's own configuration — the API base URL and the three OIDC values — is inlined at **build** time by Vite, so a bundle built with the wrong ones cannot be corrected with an environment variable afterwards; it has to be rebuilt.

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
- **Verification is attributed to a real account, and is still single-reviewer in behaviour.** A verification or note now carries the account you signed in with rather than a profile invented in this browser, so an export names a person your firm can identify. What has *not* arrived is anything collaborative: two people editing one review do not see each other, a stale change is not yet refused with what replaced it, a verification cannot yet be overridden with a history of who changed it from what, assignment reaches nobody, and nothing notifies anybody of anything. Those are the next stages' work, and every affordance that would imply them is deliberately absent rather than stubbed.
- **Role changes and workspace-setting changes are attributed on the row, not logged as events.** Who last changed a user's role, and when, is recorded on the record itself; there is no append-only audit log yet, so a change that was made and then reversed leaves no trace of having happened. The activity feed a reader sees is derived from their own work at the moment they look, which is why it can never claim somebody else did something.
- **A user's role comes from their group membership at the identity provider, and there is no screen to change the mapping.** The group-to-role table is seeded from deployment configuration and the API's database role has read access to it and nothing else, so changing which of your groups may publish a playbook is a deployment change today. That is a deliberate absence: the missing grant is what keeps adding the screen a decision rather than an oversight.
- **The one-time uploader ships for one release.** The screen that moves this browser's data to the server, and the read-only local database behind it, exist so nothing is stranded. The release that removes them is the release that deletes the local copy, and it happens after the server copy has been confirmed good — not before.
- **A collection review isn't shown in the comparison grid.** The grid is built for comparing genuinely separate documents row by row; a collection produces one net position per clause, however many documents fed it, so there is nothing to compare — the grid refuses to open for a collection's review and points you back to the card view instead.
- **A document's effective date can't be entered yet.** A document record carries an optional effective date, and everything that would use one is built: the collection prompt labels each document with its date, and each step of a variation trail shows one. Nothing in the app can set it, though, so no date is ever known — a trail step shows its document by name alone, and the model is told the reading order of a collection but not when each amendment took effect. Nothing displays a blank or an empty "dated" where a date would go; the date is simply omitted. Reading order is unaffected either way: it is the order you set when you built the collection, and is deliberately never derived from a date. Entering a date is later work.
- **A collection whose base document is missing can't be run.** Every amendment acts on the base, so without it there's no starting position for any of them to vary; the collection's card says so and offers to choose a new base or ungroup, and starting a review is blocked until you do one or the other.
- **`api`'s inability to reach the internet is enforced and tested under `docker compose`; in Azure it is expressed in the Bicep but is not yet asserted by an automated test — that is Spike 2.** They are not the same claim, and only the local one has a test behind it today.
- **Phone-width layouts aren't built.** Every screen is responsive from 768px upward, but a dedicated phone layout is separate, later work rather than something this pass silently attempted and got wrong.
