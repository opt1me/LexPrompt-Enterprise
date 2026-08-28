# Sub-project G — the visual reskin

Status: design spec, written 2026-08-28. Binding authority for sub-project G.
Branch: `lexprompt-redesign`. Prior specs: A, B, C, D, E, F in this directory.
Rulings appendix: §18 here, mirrored into `docs/superpowers/redesign/rulings.md`.

---

## 1. What this sub-project is for, and why it is its own

Sub-projects A–F built the redesign's *substance*: matters that persist, findings a
human signs off, collections that resolve to a net position, standard positions with
health, playbook authoring, and learning from redlines. Every one of those specs
deferred the same two things — "mobile layouts" and "the visual reskin" — and several
deferred named screens on top. The app today therefore does the redesign's work while
wearing v1's clothes: a dark violet-on-near-black Tailwind default, dark cards, and a
palette assembled ad hoc across 45 component files.

The owner has ruled that the reskin is its own sub-project rather than folded
screen-by-screen into the others. That is the right call for one reason above all:
**a reskin folded into a feature sub-project is a reskin nobody can review.** A diff
that changes both what a screen does and what it looks like offers no way to tell
which change deleted an error state. Keeping G separate makes every one of its diffs
answerable by a single question — *did behaviour change?* — and the answer should
always be no.

G therefore has two halves, and they must not be confused:

- **G-1, the restyle.** A design system extracted from the owner's prototypes, applied
  to every screen that exists. Zero behaviour change. Zero copy change except where
  §8.4 lists it and justifies it.
- **G-2, the inherited screens.** The screens the other six specs pushed away and that
  landed nowhere: the matter status board's missing half, the first-run intake, the
  export-gate banner, the `Standard positions` nav tab, and the resolution of the
  `Compare`/`Report` segmented control. These *are* behaviour changes. They are in G
  because G is where they landed, not because they are styling, and each is labelled
  structural in §10.

A deferred item that lands in no sub-project is this project's single most repeated
defect — eleven instances so far. §5 is the ledger that closes it.

---

## 2. The rule that outranks the others here

CLAUDE.md: **fail loudly rather than answer quietly wrong.** The reskin-specific form
of that rule is:

> **Restyling a component preserves its states — every one of them, including the
> error, empty, partial, loading, interrupted and refused states. A mockup shows a
> screen in its happy state. The spec is where the other states survive.**

The failure mode is precise and it is not hypothetical. A visually-driven rewrite
starts from a picture. Pictures contain populated lists, resolved findings, and
confident chips. They do not contain `LoadErrorPanel`, the four branches of
`ReviewVersionLine`, `RunInterruptedBanner`, the absence of a `PositionChip`, or the
sentence explaining that a document exceeded the model's context budget. A developer
restyling `MatterHome.tsx` against mock `1a` will render the mock's three stat cards
beautifully and delete the `LoadErrorPanel compact` branch underneath them, because
the mock has no idea it exists. Every screen in this app has more states than the
mockup of it.

Two consequences bind the whole sub-project:

1. **§8 is a checklist, and it is executable.** Every item on it names a component,
   the state it carries, and how a test proves the state survived.
2. **Copy that carries a disclosure or a failure is not free to reword for visual
   reasons.** The prototypes use different words for several things the app already
   says. Where they differ, the shipped copy wins (R-G5). Casing is a CSS decision;
   the string is not.

---

## 3. Scope

**In:**

1. A design system — colour, type, spacing, radii, borders, elevation, motion — as a
   two-layer token set in Tailwind 4, extracted from the prototypes, with **semantic
   roles** that components consume instead of raw colours.
2. Self-hosted fonts (Newsreader, Instrument Sans, IBM Plex Mono) with real fallback
   stacks, served from the app's own origin.
3. The restyle of every screen, panel, modal and shared primitive listed in §9.
4. Responsive behaviour down to a 768px viewport: no horizontal page scroll, panes
   collapse in a defined order, dense tables scroll inside their own container.
5. The screens G inherits, per §10: the matter status board's stat row and single-actor
   activity list (1a), the first-run intake (1f), the export-gate banner, the
   `Standard positions` nav tab, and the `Compare` segmented control resolved onto the
   existing findings/grid toggle.
6. The multi-user affordance ruling of §7, applied everywhere the prototypes show one.
7. A palette guard test that fails on a raw colour literal in application source.

**Out of G — each with a ruling, and each marked *deferred* (it has a home) or
*dropped* (it does not come back unless the owner asks):**

- **Full phone parity (`1h`) — deferred**, to a sub-project H. §11 argues this and puts
  it to the owner as a decision point with a recommendation.
- **Global `⌘K` search** over matters, clauses and findings — **deferred**, unassigned
  but named. It is a cross-entity index, not a style (R-G14).
- **The AI playbook suggestion in the intake wizard — deferred**, and it belongs with
  E's generation code. It is a model call and a prompt contract (R-G12).
- **A dark theme, or any theme toggle — dropped.** One palette (R-G7).
- **`Report` as a third segmented tab, and any live report *view* — dropped.** Export
  stays a button producing a file (R-G11).
- **A playbook version diff ("Compare to v3") — dropped** (R-G15). **OCR progress
  UI — dropped** (R-G13).

**Out and staying out:**

- Genuine multi-user: assignment that reaches a person, an activity feed with other
  actors, a firm identity, an "assigned to me" queue. Ruling R1 and §7.

**Unchanged and not to be touched:** `src/lib/citations.ts`, `src/lib/openrouter.ts`,
`src/lib/concurrency.ts`, `src/lib/citationPage.ts`, `src/lib/verification.ts`,
`src/lib/findingOutcome.ts`'s **strings**, `src/lib/positionHealth.ts`'s **strings**,
`extractClause.ts`, `extractCollectionClause.ts`, `runReview.ts`, `collectionPrompt.ts`,
every `src/lib/db/*` repository, and every exporter's output. G changes what the app
looks like. It does not change what the app says, sends, stores or produces.

`PdfCanvas.tsx` is a partial exception: it renders into a canvas and takes no
restyling, but the gutter and page-chrome *around* it are G's (§9).

---

## 4. Constraints inherited, which still bind

- **Browser-only, static-hostable, no backend.** Nothing G adds may require a server,
  a build-time secret, or a runtime third-party request. This is why fonts are
  self-hosted rather than hotlinked (§6.5, R-G3): the app's own disclosure says data
  goes nowhere but OpenRouter, and a Google Fonts `<link>` would make that sentence
  false for every page view.
- **Adding a dependency needs justification.** G adds none. See §6.7.
- **`src/lib/storage.ts` keeps settings only, synchronously.** G does not touch it.
- **Three chips, three questions.** `StateChip` (has a human checked this?),
  `RiskChip` (how risky is what it found?), `PositionChip` (does it match our house
  rule?) stay three components and must never be merged into one badge. G makes this
  harder to break, not easier (§6.4).
- **Verification state is set only by a human action; nothing derives it.** G renders
  it. G never writes it.
- **A clause with no standard position gets no chip.** `PositionChip` returns `null`
  on an absent outcome, and the absence is the message. G may not give it a default,
  a placeholder, or a grey "n/a" pill.

---

## 5. The deferral ledger — everything G inherits

Every "out of scope" line in specs A–F, resolved. This table exists so that no item
ends the redesign owned by nobody. **Resolution** is one of: *G-1* (restyle only),
*G-2* (G builds it), *Deferred* (named, with a home), or *Dropped* (with a ruling).

| Deferred item | Deferred by | Resolution |
| --- | --- | --- |
| "The visual reskin" | A, B, C, D, E, F | **G-1**, §9 |
| "Mobile layouts" | A, B, C, D, E, F | **Split.** ≥768px in G-1 (§3.4); phone parity is a decision point, §11 |
| The comparison grid rebuilt as a triage surface | A, B → C | **Already built in C.** The brief that commissioned this spec lists it as deferred; it is not. `TabularReview.tsx` has the per-column risk mini-bar, the un-truncated sentence per cell, split risk/verification, and "Open in review". G-1 restyles it and must not rebuild it (R-G8) |
| The first-run intake wizard (`1f`) | A, B, C | **G-2**, §10.2 |
| The matter home status board (`1a`) beyond documents/collections/reviews | A (partially delivered) | **G-2**, §10.1 — the stat row and the activity list are not built |
| The export-gate banner ("N findings are unchecked…") | not explicitly deferred by anyone; drawn in `1b`, never specified | **G-2**, §10.3 |
| The `Standard positions` global nav tab | D §11 ("named with no screen drawn") | **G-2**, §10.4 |
| The `Compare` segmented-control tab | C §12 ("cannot be specified from a name") | **G-2**, §10.5 — resolved onto the existing toggle, not invented |
| The `Report` segmented-control tab | C §12, implicitly | **Dropped**, R-G11 |
| Global `⌘K` search | never scoped | **Deferred** to a sub-project of its own; G renders no search box, not a dead one (R-G14) |
| Assignment as workflow, activity feed as cross-user record | A, B (ruling R1) | **Out and staying out**; §7 rules each affordance |
| Playbook version diff ("Compare to v3") | never scoped; drawn nowhere | **Dropped** from G. `VersionHistory` already lists every version with its change summary; a structured clause-level diff is a feature, not a style (R-G15) |
| OCR-at-ingest and its progress UI (`1f`'s "running OCR, 40%") | never scoped | **Dropped** from G. The app does not OCR; drawing a progress bar for work it does not do is the exact failure §2 forbids (R-G13) |
| Storing precedent documents | F | Out and staying out; unaffected by G |

---

## 6. The design system

Extracted from the owner's prototypes, not invented. `design_handoff_lexprompt_redesign/README.md`
carries a complete token table under "Design tokens" and it is the source for every
value below; where this spec differs from it, the difference is a ruling and says so.

The aesthetic in one line, from the prototype's own note: **paper, not panels.**
Newsreader for legal prose, Instrument Sans for chrome, IBM Plex Mono for pins and
references. Risk is printed ink, not neon. Cards are separated by hairline rules and a
value difference, never by a shadow.

### 6.1 Where the tokens live, and why in two layers

Tailwind 4 is already this project's setup (`@tailwindcss/vite`, `@import "tailwindcss"`,
a three-value `@theme` block in `src/index.css`). Everything G needs is native to it,
so the whole system is CSS custom properties in that one file. No config file, no
plugin, no dependency.

The tokens sit in **two layers**, and the split is the enforcement mechanism (R-G2):

```css
@import "tailwindcss";

/* ── Layer 1 · palette ────────────────────────────────────────────────
   Plain custom properties, deliberately NOT inside @theme, so Tailwind
   generates no utilities for them. `bg-oxblood` is not a class anyone can
   type, because the raw colour never enters the --color-* namespace. */
:root {
  --lex-canvas:  #e5e2db;  --lex-paper: #f6f3ed;  --lex-card:  #fffefb;
  --lex-gutter:  #e8e4dc;  --lex-page:  #ffffff;

  --lex-ink-1: #1a1815;  --lex-ink-prose: #26231e;  --lex-ink-quote: #3a352e;
  --lex-ink-2: #57524a;  --lex-ink-3: #6b665c;      --lex-ink-4: #8a847a;
  --lex-ink-5: #a8a29a;  --lex-ink-6: #c9c3b8;

  --lex-teal: #14574f;  --lex-oxblood: #8c2f24;  --lex-amber: #8a6414;
  --lex-green: #2c6448; --lex-blue: #3d5a80;
}

/* ── Layer 2 · roles ──────────────────────────────────────────────────
   The only names application code may use. Each answers a question about
   meaning, never about appearance. */
@theme {
  --color-canvas: var(--lex-canvas);
  --color-paper:  var(--lex-paper);
  --color-card:   var(--lex-card);
  /* … see 6.2 and 6.3 for the full set … */

  --color-risk-high:      var(--lex-oxblood);
  --color-risk-high-tint: rgb(140 47 36 / 0.06);
  --color-risk-high-edge: rgb(140 47 36 / 0.22);
}
```

Layer 2 gives `bg-paper`, `text-ink-1`, `text-risk-high`, `border-risk-high-edge` and so
on, generated by Tailwind from the `--color-*` namespace. Layer 1 gives nothing. A
component that wants oxblood must first decide what oxblood *means* here, and name it.

The remaining escape hatch is Tailwind's arbitrary-value syntax (`text-[#8c2f24]`), and
that is closed by the palette guard test (§13.4), which also fails on a `--lex-*`
reference outside `src/index.css`.

The dark `@theme` block currently in `src/index.css` (`--color-surface`, `--color-panel`,
`--color-card`) is **deleted**, along with the `body` rule beneath it. The
`.custom-scrollbar` rules survive, retinted to `rgb(26 24 21 / …)`.

### 6.2 Surfaces, ink, and rules

| Role token | Value | Use |
| --- | --- | --- |
| `canvas` | `#e5e2db` | outside the app frame only; the app itself rarely shows it |
| `paper` | `#f6f3ed` | app background, secondary button fill, segmented-control track |
| `card` | `#fffefb` | cards, rails, bars, panels, inputs |
| `doc-gutter` | `#e8e4dc` | the area around a rendered document page |
| `page` | `#ffffff` | the document page itself |
| `ink-1` | `#1a1815` | primary text and headings |
| `ink-prose` | `#26231e` | Newsreader body prose |
| `ink-quote` | `#3a352e` | quoted evidence |
| `ink-2` | `#57524a` | secondary text, superseded prose |
| `ink-3` | `#6b665c` | tertiary text, inactive nav |
| `ink-4` | `#8a847a` | field labels, metadata |
| `ink-5` | `#a8a29a` | timestamps, placeholders |
| `ink-6` | `#c9c3b8` | disabled icons, page numbers |
| `rule-soft` | `rgb(26 24 21 / .09)` | hairline between list rows |
| `rule` | `rgb(26 24 21 / .12)` | card and panel borders |
| `rule-strong` | `rgb(26 24 21 / .18)` | input borders |
| `chip-fill` | `rgb(26 24 21 / .06)` | neutral chips, segmented track |

**`ink-4` and below are decorative-grade contrast** on `paper` (`ink-5` on `paper` is
roughly 2.3:1). No failure state, disclosure, warning, or anything a reader must not
miss may use them (R-G19). The contrast test in §13.4 enforces the ratios; that
sentence enforces the role assignment, which arithmetic cannot.

### 6.3 Semantic colour roles

The governing invariant, and the one thing to get right:

> **Teal (`#14574f`) means a person did something.** Every other role colour is a model
> judgement or a system state. Low risk is green (`#2c6448`) and *is not* teal; a
> confirmed net position is teal and *is not* green. (R-G4; the handoff says this
> explicitly and it is the distinction the whole redesign turns on.)

Each role below exists in three flavours where it needs them — `-…` for ink,
`-…-tint` for a wash, `-…-edge` for a border.

| Group | Roles | Colour | Consumed by |
| --- | --- | --- | --- |
| **Action / human confirmation** | `accent`, `accent-tint`, `accent-edge`, `accent-strong` | teal | primary buttons, focus rings, confirmed net positions, links |
| **Risk** (model judgement) | `risk-high`, `risk-med`, `risk-low` | oxblood / amber / green | `RiskChip`, the grid's per-cell 5% wash, the column mini-bar, the matter risk profile |
| **Verification** (human) | `state-verified` (teal), `state-flagged` (amber), `state-rejected` (oxblood), `state-unchecked` (`ink-4`) | — | `StateChip`, the clause index icons, the verification meter |
| **Standard-position outcome** (model) | `outcome-meets` (green), `outcome-deviates` (oxblood), `outcome-unclear` (amber) | — | `PositionChip`, `PositionComparison` |
| **Position health** (derived from *verified* findings only) | `health-held` (teal), `health-conceded` (amber), `health-untested` (`ink-4`), `health-none` (`ink-5`) | — | the playbook editor, the `Standard positions` tab |
| **Net position** | `net-unconfirmed` (amber, dashed border), `net-confirmed` (teal), `net-amended` (teal) | — | `NetPositionPanel`, `VariationTrailModal` |
| **Draft / suggested / informational** | `draft`, `draft-tint` | blue `#3d5a80` | `UNSAVED DRAFT`, `SUGGESTED`, `AI DRAFTED — NOT YET REVIEWED`, "new clause" |
| **Document** | `highlight-fill` `rgb(255 222 89 / .34)`, `highlight-edge` `rgb(198 150 20 / .75)`, `redline-ins` (teal), `redline-del` (oxblood) | — | `DocumentViewer`, the redline renderer |

`health-held` is teal rather than green deliberately: D's `positionHealth` counts only
findings a human verified, so "held 5 of 5" is a claim about human-checked evidence,
which is what teal means.

Note the two deliberate collisions: `risk-high` and `state-rejected` share oxblood;
`risk-med` and `state-flagged` share amber. That is the handoff's palette and it is
correct — but it means **colour alone cannot distinguish the three chips**, which §6.4
resolves.

### 6.4 How a component consumes a role

**A component names a meaning and lets the token supply the colour.** The existing
components already have the right shape; only the right-hand side changes:

```tsx
// StateChip.tsx — before/after of the map, not of the component
const CHIP: Record<VerificationState, {...}> = {
  unchecked: { label: 'Unverified', classes: 'bg-chip-fill text-state-unchecked border-rule', … },
  verified:  { label: 'Verified',   classes: 'bg-accent-tint text-state-verified border-accent-edge', … },
  …
};
```

Forbidden anywhere under `src/` except `index.css`, and enforced by §13.4:

- a hex literal, or an `rgb()`/`rgba()` literal, inside a `className`;
- a Tailwind arbitrary colour (`text-[#…]`, `bg-[rgba(…)]`);
- a `--lex-*` palette variable;
- a generic Tailwind palette class (`text-emerald-400`, `bg-violet-600`, `border-white/10`)
  — roughly 100 distinct ones exist today and all of them go.

A role that does not exist yet is added to `index.css` in the **same commit** that first
uses it, never afterwards.

**The three-shapes rule (R-G16).** Because two pairs of roles share a hue, the three
chips are distinguished by form as well as colour, and no restyle may converge them:

| Chip | Question it answers | Form |
| --- | --- | --- |
| `RiskChip` | how risky is what the model found? | filled dot + uppercase mono label, **no border** |
| `StateChip` | has a human checked this? | lucide icon + uppercase mono label, hairline border, chip fill |
| `PositionChip` | does it match our house rule? | uppercase mono label inside a 1px role-coloured border, transparent fill |

A finding can be `verified`, `Medium` risk and `deviates` simultaneously. The three
chips sit side by side on that finding's header and a reader must be able to tell at a
glance which is which. §13.5 item 4 is the browser check for exactly this case.

### 6.5 Typography and font delivery

Three families, each with a role and a real fallback stack:

```css
@theme {
  --font-prose: "Newsreader", ui-serif, Georgia, "Times New Roman", serif;
  --font-ui:    "Instrument Sans", ui-sans-serif, system-ui, sans-serif;
  --font-mono:  "IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
}
```

- **`font-prose` (Newsreader)** — all legal prose: findings, quoted evidence, clause
  titles, headings, playbook instruction text, the wordmark, big numbers. This is the
  voice of the product and it is what makes the app read like a document.
- **`font-ui` (Instrument Sans)** — chrome: buttons, nav, form labels, metadata
  sentences. Set as the `body` default.
- **`font-mono` (IBM Plex Mono)** — references and pins: `LEASE · p.14 · cl.5.2`, clause
  numbers, chips, counts, timestamps, keyboard hints.

The type scale is declared as **named roles**, not raw sizes, using Tailwind 4's
`--text-*` namespace with its line-height companion:

```css
@theme {
  --text-matter-title: 30px;   --text-matter-title--line-height: 1.1;
  --text-finding: 15.5px;      --text-finding--line-height: 1.62;
  --text-quote: 13.5px;        --text-quote--line-height: 1.6;
  --text-chip: 9.5px;          --text-chip--letter-spacing: 0.07em;
  /* … */
}
```

| Role | Family / spec |
| --- | --- |
| `matter-title` | prose 500 30px/1.1, `-0.015em` |
| `screen-title` | prose 500 26px/1.15 |
| `section` | prose 500 17px |
| `clause` | prose 500 16–20px/1.2 |
| `finding` | prose 400 15.5px/1.62, `text-wrap: pretty` |
| `quote` | prose italic 400 13.5px/1.6 |
| `field` | prose 400 13.5px/1.6 |
| `ui` / `ui-sm` | ui 400–500 13.5px / 12px |
| `button` | ui 600 12px |
| `meta` | ui 400 11.5px |
| `label` | mono 600 9.5px, `0.13em`, uppercase |
| `chip` | mono 500 9.5px, `0.07em`, uppercase |
| `pin` | mono 400–500 10.5px |
| `figure` | prose 500 30px/1 (the big numbers on the status board) |

**Delivery (R-G3): self-hosted, never hotlinked.** Latin-subset `woff2` files vendored
under `public/fonts/`, declared with `@font-face` and `font-display: swap`. Newsreader
and Instrument Sans are variable (one upright file each, plus Newsreader italic); IBM
Plex Mono is static and needs 400/500/600. Total budget **≤350 KB**.

Two reasons, and the second is the binding one: the app is static-hostable with no
backend, and — decisively — `SettingsPanel` tells the user that nothing leaves this
browser except calls to OpenRouter. A `<link>` to `fonts.googleapis.com` would make
that sentence false on every page view, in an app whose founding rule is not being
quietly wrong. No screen may depend on a font metric: no icon fonts, no
character-width layout, and every screen must remain readable and un-reflowed with the
font files blocked (§13.5 item 1).

### 6.6 Geometry, elevation, motion, icons

**Radii**, named by what they wrap rather than by size:

```css
--radius-chip: 3px;  --radius-control: 6px;  --radius-card: 7px;
--radius-panel: 8px; --radius-inset: 5px;    --radius-meter: 9999px;
```

**Spacing** stays on Tailwind's default 4px grid (`--spacing` unchanged). The
prototype's ladder (5/6/7/9/11/14/18/22/26/34px) is an artefact of hand-authored inline
HTML, not a designed scale; re-basing the unit would silently change the meaning of
every spacing utility already in the codebase across ~788 `className` sites. Values snap
to the nearest 4px step (R-G21).

**Borders and elevation.** Hairline `1px solid --color-rule` on cards and panels;
`rule-strong` on inputs; left-accent borders `2px` on list rows and quotes, `3px` on
cards. **No shadow on a card, ever** — cards are separated by the hairline and the
`paper`/`card` value difference. Exactly two shadows exist in the whole system:

```css
--shadow-tab:  0 1px 2px rgb(0 0 0 / 0.07);   /* active segmented-control tab */
--shadow-page: 0 4px 18px rgb(0 0 0 / 0.14);  /* a rendered document page */
```

`Button`'s current `shadow-lg shadow-violet-900/20` goes.

**Motion**, restrained: 120–160 ms for chips, hovers and state changes; 200 ms for pane
and drawer transitions; **no entrance animation on content**. One looping animation
exists — the extracting pulse (`2s cubic-bezier(.4,0,.6,1)` on a 7px bar at
`rgb(26 24 21 / .09)`). Under `prefers-reduced-motion: reduce` every transition
collapses to 0 and the pulse becomes a static tinted bar **with its label intact**
(§8.6, R-G20).

**Icons:** `lucide-react`, already a dependency; every icon in the prototypes is a
lucide name. 1.5px stroke, sized 12 / 14 / 16 / 20px, coloured by a role token. Every
icon-only control keeps an `aria-label` — `mount.tsx`'s `buttonNamed` reads it, and a
control with no accessible name is a regression whether or not a test catches it.

**Graphics are CSS.** The meters, stacked bars, risk mini-bars, progress rings and
timeline nodes are all CSS, exactly as in the prototypes. No chart library, no SVG
assets, no logo file — the wordmark is live text in Newsreader.

### 6.7 Dependencies

**G adds none.** Everything above is CSS custom properties, Tailwind 4's native
`@theme`, `lucide-react` (already present), and three vendored font families.

Rejected, with reasons, so the question is not reopened:

- **`@fontsource/*`** — three npm packages, a build-time copy step, and a supply-chain
  surface, to deliver files that a `public/fonts/` directory delivers with none of it.
- **A headless UI kit** (Radix, Headless UI) — `Modal` already exists, already carries
  the `role="dialog"` that eleven tests select on, and already handles this app's focus
  needs. Replacing it would be a behaviour change wearing a styling change's clothes.
- **Any CSS-in-JS runtime** — the app is browser-only and static; a runtime style engine
  is bundle weight and a hydration hazard in exchange for nothing Tailwind 4's token
  layer does not already do.
- **A charting library** — every graphic here is a div with a width.

---

## 7. The multi-user trap, ruled affordance by affordance

The prototypes are a collaborative product's mockups. LexPrompt is single-user, by
deliberate decision: CLAUDE.md's "Deliberate non-features" and ruling R1 say
multi-user is *schema-ready but not built* — `ownerId`, `assigneeId` and `byUserId`
exist and populate from `src/lib/db/profile.ts` (default `{ name: 'Me', initials:
'ME' }`), but assignment reaches nobody.

A faithful reskin of these mockups would ship a lie: it would show a lawyer a queue of
work assigned to them by colleagues who do not exist, in an app with no colleagues.
That is worse than cosmetic dishonesty in this particular product, because the whole
premise of the redesign is that the app tells the truth about what has been checked
and by whom.

**Ruling R-G1 governs the whole table.** Each row states what ships.

| Prototype affordance | Ships as | Why |
| --- | --- | --- |
| "Assigned to me" counter with badge "6" in the matters rail | **Dropped entirely.** No counter, no badge, no rail slot | Nothing assigns to anyone. A zero-count badge is as dishonest as a six — it implies a queue that could fill |
| Assignee chip on a finding's disposition bar | **Dropped.** `Finding.verification.assigneeId` stays in the schema, unrendered | Ruling R1: the field may exist; nothing may imply it notifies anyone |
| `user-plus` "assign" action | **Dropped** | Same |
| Status subtext "rejected by M. Okafor" | **Kept, resolved through the local profile.** Renders "Rejected by you" when `byUserId` is the local profile, and the stored display name otherwise | The attribution is real data. It resolves to one person because there is one person. Never invent a second name |
| User avatar with initials, top right | **Kept**, showing the local profile's own initials, linking to Settings where the name is editable | An avatar of *yourself* is honest. It is also the only place the identity substrate becomes visible, which is worth having |
| Firm tag "CH&P LLP" beside the wordmark | **Dropped.** The wordmark stands alone | There is no firm record, and adding a decorative profile field to print a name the app knows nothing about is inventing an institution. If the owner wants it, it is a one-field profile addition and a later change |
| Activity feed with actors and timestamps | **Kept, as a single-actor matter history** (§10.1). Derived at read time from data that already carries an author and a timestamp: `verification.at`/`byUserId`, `Note.at`/`byUserId`, a net position's `confirmedAt`/`confirmedBy`, and a review's `startedAt`/`completedAt`. Every line reads "You …". Nothing is stored | The feed's value survives without collaborators: it answers "what did I last do here, and when". What it must not do is imply someone else did something. If the derived list is empty it says so, in the empty-state idiom — it never renders a placeholder row |
| "…flagged *for M. Okafor*" phrasing in the feed | **Dropped.** A flag is flagged, full stop | Flagging reaches no one |
| Mobile bottom tab bar's `Assigned` tab | **Dropped** (and moot if §11's recommendation stands) | Same as the counter |

**Cost if wrong (R-G1):** a single-user app looks slightly less like a firm-wide
product in a screenshot. The cost of the opposite error is a lawyer waiting on a
colleague's review that was never requested and will never arrive — a silence the app
manufactured. That asymmetry is the whole argument.

---

## 8. State preservation — the checklist a restyle must not delete

This section is normative. Each item names the component, the state, and the proof.

### 8.1 Load paths must keep distinguishing "empty" from "broken"

- `LoadErrorPanel` (both `compact` and full variants) is restyled, not replaced, and
  **not merged with an empty state**. Its two variants stay two variants: the full
  block replaces a screen; the compact block replaces a section.
- Every call site that renders `error ? <LoadErrorPanel/> : empty ? … : content`
  keeps that exact three-way branch. There are nine such sites today (matters list,
  playbook library, matter, matter's documents, matter's collections, matter's
  reviews, review, playbook, run-panel playbook picker).
- `describeLoadError` continues to produce the message; `DbBlockedError` continues to
  be distinguished by type.
- The Retry control keeps `title="Retry"` — three tests select on it.
- **Proof:** the existing load-error tests pass unedited.

### 8.2 The review header's three-state (in fact four-state) version line

`ReviewVersionLine` has four visually distinct outcomes and they must stay four:

1. `versionId` absent → "Ran against a playbook version that is no longer recorded."
2. `lookupFailed` → "Could not check which playbook version this review ran against.
   Try reloading."
3. resolved → "Ran against v*N*", a link when history is reachable.
4. resolved-to-nothing → "The version this review ran against has been deleted."

Branches 2 and 4 are amber today and stay in the `risk-med` role; branches 1 and 3 are
tertiary ink. **The restyle may not collapse 2 and 4 into one colour, one wording, or
one branch** — they are different facts, and R-D15 exists because collapsing them once
produced a confident false claim.

### 8.3 Position health, and the chips whose absence is meaningful

- `PositionChip` with no `outcome` renders **nothing**. Not a grey pill, not an
  "n/a", not a dashed placeholder. A clause with no house rule is not a question with
  a blank answer.
- `positionHealthLabel`'s four kinds stay four and stay visually distinct:
  `HELD n of n` (accent), `CONCEDED n times` (risk-med), `UNTESTED` (ink-4),
  `NO POSITION` (ink-5, and deliberately not styled like `UNTESTED` — "we have no
  rule" and "we have a rule nothing has tested" are different facts).
- `StateChip` always renders, including `unchecked`. There is no "no chip" state for
  verification, because an absent chip reads as "fine".

### 8.4 Copy frozen by this spec

The following strings are load-bearing and are **not** reworded in G. Where a
prototype shows different words, the shipped words win.

- Everything `src/lib/findingOutcome.ts` exports: `verificationLabel`
  ("UNVERIFIED AI OUTPUT", "FLAGGED", …), `netPositionLabel`
  ("UNCONFIRMED NET POSITION"), `netPositionAmendmentLabel`,
  `positionOutcomeLabel` ("DEVIATES FROM OUR STANDARD POSITION", …),
  `truncationLabel` ("INCOMPLETE SOURCE TEXT: …"), `exportSummaryLine`,
  `collectionExportLabel`, `describeFindingOutcome`. This module is the only place
  export wording lives and it is shared with the screen.
- `positionHealthLabel`'s four strings.
- `ReviewVersionLine`'s four sentences.
- `SettingsPanel`'s two disclosure blocks: the API-key sentence ("Your key is stored
  only in this browser's local storage…") and the storage/privacy block ("Matters,
  documents (including the original file bytes), and reviews are stored in this
  browser's IndexedDB — on this device, in this browser, and nowhere else…"), including
  the deletion sentence and the page-images sentence.
- `TemplateEditor`'s "Unpublished changes — reviews still run v*N*" badge and
  `TemplateLibrary`'s "Unpublished changes" badge, plus the disabled-publish tooltip
  "Nothing to publish — this is the published version."
- `RunPanel`'s banner copy: "Reviewing… *n* of *m* clauses", "Run cancelled — *n* of
  *m* clauses were reviewed before it stopped.", "This review was interrupted before
  it finished — … It will not resume on its own; use Retry on any stalled clause below
  to continue.", and the empty-findings banner.
- The model-capability refusal in `extractClause.ts`/`chatContext.ts` ("…doesn't
  support image input, so it can't read the scanned pages. Choose an …").
- `SourcePicker`'s "…another matter's content leaves your browser."
- The two unsaved-work guards in `App.tsx` (`TEMPLATE_DIRTY_MESSAGE`,
  `AUTHORING_DRAFT_DIRTY_MESSAGE`).
- `MatterHome`'s "Preparing documents for review — scanned pages can take a moment to
  render…".

**Uppercase is a CSS decision, not a string decision.** The prototypes render chips in
uppercase mono. Achieve that with `text-transform: uppercase`; do not uppercase the
string, because several of these strings are also printed into a DOCX or a CSV cell
where the chip's styling does not exist.

**The one permitted copy change in G-1** is `SourcePicker`'s and `SettingsPanel`'s
privacy sentences being *moved into a shared module* so the intake wizard (§10.2) can
render the same words at the point of upload rather than a second paraphrase. This is
the project's "extract it on the second copy" rule applied before the third copy
exists. The strings themselves do not change (R-G5).

### 8.5 Run and document states

- The four run banners (`RunProgressBar`, `RunCancelledBanner`,
  `RunInterruptedBanner`, `RunEmptyFindingsBanner`) all survive, all stay distinct,
  and all stay above the content rather than inside it.
- Per-cell states in the grid and the card list — queued, extracting, error-with-retry,
  done — stay four states. **A rejected-by-human finding and an errored-by-model
  finding must not look the same** (the handoff says so; it is also the difference
  between "a person read this and disagreed" and "the model never answered").
- Scan and truncation notices survive on the finding, on the card, and in the export.
- `markupNotice` (tracked-changes disclosure) survives wherever it renders today.
- Parse errors on a document row survive with their `file-warning` treatment.

### 8.6 Busy states must be legible without motion

The prototypes' "extracting…" state is a pulsing bar. Under `prefers-reduced-motion:
reduce` the pulse becomes a static tinted bar and **the word stays**. A busy state
whose only signal is an animation is invisible to a reader who turned animation off —
and a stalled cell that looks blank rather than busy is the "abandoned run reopening
with every cell spinning forever" defect wearing a different hat.

Corollary: `.animate-spin` is currently asserted by a test (§13.2). Busy elements gain
`role="status"` and `data-busy="true"`; the class becomes a styling detail, not a
contract.

---

## 9. Screen-by-screen migration inventory

45 non-test `.tsx` files, ~788 `className` sites, ~100 distinct raw palette utilities.
**Cosmetic** means tokens and layout polish only, no DOM restructuring beyond what
§13.3's structural contracts allow. **Structural** means the DOM or the information
architecture changes, and the change is called out here rather than smuggled in.

### 9.1 Shared primitives — restyled first, because everything depends on them

| Component | Becomes | Kind | Notes / behavioural flags |
| --- | --- | --- | --- |
| `Button` | Paper/accent buttons: primary = accent fill; ghost = paper fill + hairline; danger = risk-high | Cosmetic | Loses `shadow-lg` and `active:scale-95` — no elevation, restrained motion. Keeps `loading` and `disabled` semantics exactly |
| `Modal` | Card on a dimmed paper scrim, 6px radius, hairline border, no shadow | Cosmetic | Keeps `role="dialog"` — eleven tests select on it |
| `Toast` | Card + role-coloured left border | Cosmetic | Keeps `role="status"` |
| `LoadErrorPanel` | Risk-high ink on a risk-high tint, hairline dashed for `compact` | Cosmetic | §8.1. Keeps `title="Retry"` |
| `StateChip` | Icon + uppercase mono label, hairline border, chip fill | Cosmetic | Keeps `role="status"`, keeps all four states, keeps the rejected-reason `title` |
| `RiskChip` | Filled dot + uppercase mono label, **no border** | Cosmetic | Distinct *shape* from `StateChip`, §6.4 |
| `PositionChip` | Uppercase mono label inside a 1px role-coloured border, transparent fill | Cosmetic | Third shape. Still renders nothing when `outcome` is absent |
| `AutoResizeTextarea` | Card fill, hairline border, accent focus ring | Cosmetic | — |

### 9.2 Chrome

| Screen | Becomes | Kind | Notes |
| --- | --- | --- | --- |
| App top bar (`App.tsx`) | Paper bar, hairline underline, Newsreader wordmark as live text, nav in Instrument Sans, settings gear and profile-initials avatar right | **Structural (small)** | Adds the avatar (§7); adds the `Standard positions` tab (§10.4); renames `Library` → `Playbooks` — **a copy change, and therefore a test change** (R-G6). Renders **no** search box (R-G14). The gradient logo tile is dropped for a text wordmark, per the handoff's "no logo file" |
| `not-found` view | Paper, centred, Newsreader | Cosmetic | — |

### 9.3 Matters

| Screen | Becomes | Kind | Notes |
| --- | --- | --- | --- |
| `MattersList` | Card rows on paper, one-line status subtext per matter | Cosmetic | Status subtext is already derived; only its type/colour change |
| `MatterHome` | `1a` status board | **Structural** | Gains the three stat cards and the activity list (§10.1). Everything already present — documents, collections, reviews, suggestions, three `LoadErrorPanel compact` branches, the delete-matter modal — is preserved unchanged in behaviour. Keeps `[title="Delete Matter"]` |
| `CollectionCard` | Card with BASE/VARIES rows, mono role chips | Cosmetic | — |
| `GroupDocumentsDialog` | Restyled modal | Cosmetic | Keeps `#base-*` input ids — three tests select on them |
| `MatterPickerModal` | Restyled modal | Cosmetic | — |

### 9.4 Review

| Screen | Becomes | Kind | Notes |
| --- | --- | --- | --- |
| `ResultsView` | The `1b` ledger *approached, not completed* | **Structural — flagged** | Today: two panes (a 1/3 rail carrying a Findings/Chat tab pair and the finding cards, plus a 2/3 document pane). `1b` is three panes: a 258px clause index, a 470px finding detail, a document pane. **Moving to three panes is a scope decision, not styling** — it relocates the finding body out of a narrow rail, changes where the chat panel lives, and changes what is on screen at 1280px. §12 sequences it as its own step, reviewable on its own, and §17 offers the owner the option of declining it. If declined, G-1 restyles the two-pane layout and nothing else changes |
| `FindingCard` | Newsreader prose, inline evidence, role-shaped chips, disposition row | Cosmetic | All error/queued/extracting/truncated/markup branches preserved. **No assignee chip** (§7) |
| `EvidenceList` | Italic Newsreader quote + mono pin (`LEASE · p.14 · cl.5.2`) | Cosmetic | The pin's content is unchanged; `derivePage` still decides the page and still omits it rather than guessing |
| `VerificationControls` | Sticky disposition bar, three role-shaped buttons | Cosmetic | Await-then-apply is untouched. The `J` hint is kept; no new shortcuts are added in G |
| `NotesPanel` | Card, avatar = local profile initials | Cosmetic | Keeps `[data-testid="note-text"]` |
| `PositionComparison` | "We ask for" / "This lease says" two-column box | Cosmetic | Renders only when there is an outcome |
| `NetPositionPanel` | Unconfirmed = amber dashed; confirmed = accent with attribution | Cosmetic | The confirm/amend semantics are C's and are untouched |
| `VariationTrailModal` | `1d` timeline: original → varied by → net | Cosmetic | Unavailable-member wording (R-C2R1) preserved verbatim |
| `RejectReasonModal` | Restyled modal | Cosmetic | — |
| `DocumentViewer` | `doc-gutter` background, `page` white, the one permitted page shadow | Cosmetic | Highlight fill `rgba(255,222,89,.34)` + 2px underline |
| `PdfCanvas` | Untouched | — | Canvas rendering; only the surrounding gutter is G's |
| `RunPanel` | Restyled drop zone and file list | Cosmetic | Superseded as the *entry* flow by §10.2's wizard, but retained as the "run another review on this matter" path |
| `ReviewVersionLine` | Restyled, four branches intact | Cosmetic | §8.2 |
| Run banners ×4 | Role-coloured banners | Cosmetic | §8.5 |

### 9.5 Comparison grid

| Screen | Becomes | Kind | Notes |
| --- | --- | --- | --- |
| `TabularReview` | `1e` comparison grid | Cosmetic | **Already rebuilt in C** (R-G8). G supplies 5% risk washes per cell, the mono column headers, the mini-bar's colours, and sticky headers. Keeps `table`/`td`/`td:nth-child(2)`. The `.truncate` selector in its test must become a `data-*` hook (§13.2) |
| `CellDetail` | Restyled side panel | Cosmetic | — |

### 9.6 Playbooks

| Screen | Becomes | Kind | Notes |
| --- | --- | --- | --- |
| `TemplateLibrary` | Playbooks list, "used in N matters" line, unpublished badge | Cosmetic | Badge copy frozen |
| `TemplateEditor` | `1g` playbook editor: left rail (acting-for, house style, risk appetite, position coverage), clause cards with `HAS/NO STANDARD POSITION` mono chips | Cosmetic | Keeps `[draggable="true"]`; the `.group` selector in its test must become a `data-*` hook (§13.2). The footer coverage stat ("*n* of *m* clauses have a standard position") is derivable today and is **new copy** — R-G6 flags it as such |
| `StandardPositionField` | Card field with provenance line | Cosmetic | — |
| `FieldSuggestion` | Dashed border + `SUGGESTED` mono chip + use/retry/dismiss | Cosmetic | The unaccepted-suggestion semantics are E's |
| `PublishDialog` | Restyled modal | Cosmetic | Keeps `[aria-label="Change summary"]` |
| `MegaPromptModal` | Mono, `page` background | Cosmetic | — |
| `VersionHistory` | `4c` timeline: filled dot for current, outline for prior | Cosmetic | No "Compare to v*N*" action (R-G15) |

### 9.7 Authoring

| Screen | Becomes | Kind | Notes |
| --- | --- | --- | --- |
| `RouteChooser` | `2a` three route cards | Cosmetic | — |
| `DraftForm` | `2a` form with segmented controls | Cosmetic | — |
| `DraftReview` | `2b` draft review | Cosmetic | The `UNSAVED DRAFT` badge and the discouraged-not-blocked save survive exactly |
| `ClauseRail` | Kept/cut/unreviewed chips + progress | Cosmetic | — |
| `SourcePicker` | Checklist with the privacy line | Cosmetic | Privacy line moves to the shared module (§8.4) |

### 9.8 Settings and assistant

| Screen | Becomes | Kind | Notes |
| --- | --- | --- | --- |
| `SettingsPanel` | Paper form; disclosure blocks in a bordered card, **not** collapsed behind a disclosure triangle | Cosmetic | Copy frozen (§8.4). The prototypes have no settings screen at all; this one is designed in the language rather than inherited |
| `ChatPanel` | Restyled | Cosmetic | Ruling R4 keeps the assistant module otherwise untouched |
| `EmailModal`, `RevisionModal` | Restyled modals | Cosmetic | — |

---

## 10. The screens G inherits and must design

The owner has authorised designing screens the handoff names but never draws. That
permission comes with an obligation, stated here as a rule G applies to itself:

> **If you cannot say what a screen is FOR from the rest of the app, do not draw it.
> Recommend dropping it instead.** A plausible-looking shell is how a redesign
> acquires a feature nobody asked for, and this app already carries the cost of one
> named-but-undrawn screen per sub-project.

§10.4 passes that test. §10.5 and the `Report` tab do not, and are resolved by mapping
onto what exists or by being dropped.

### 10.1 Matter home / status board (`1a`) — **structural**

**What it is for:** answering "how much of this matter is actually checked by a human"
before anything else on the screen. That is the redesign's thesis, and the matter home
is currently the one screen that does not state it.

**What is already there:** matter header, Documents, Collections (with suggestions),
Reviews (each with a `progressLabel` line), three compact load-error branches, delete.

**What G adds — three stat cards above the existing two-column body:**

1. **Verification progress.** A big Newsreader number (verified count) over a stacked
   meter, legend `verified / flagged / rejected / unchecked`, computed with
   `verificationCounts` from `findingOutcome.ts` over the matter's reviews' findings —
   the same function the exports use, so the number on screen and the number in the
   report cannot drift. `MatterHome` already loads reviews with their findings, so
   this costs no new read.
2. **Needs attention.** Two counts: flagged for follow-up, and deviating from a
   standard position. The mockup's third count — "unassigned / no owner" — is
   **dropped** (§7).
3. **Risk profile.** High/med/low bars with counts, from findings' risk levels.

**Empty and partial behaviour, which the mockup does not show and which is
load-bearing:**

- A matter with no completed review renders the cards' **empty** form — "No review has
  run yet" — never three zeroes. Zero verified out of zero is not a fact about this
  matter's safety.
- A matter whose reviews failed to load renders the existing `LoadErrorPanel compact`
  **in place of the stat row**, not zeroes beneath it. The stat row is derived from the
  reviews; if the reviews are unknown the statistics are unknown.
- A matter mid-run shows the counts it has and says the run is in progress.

**Activity list:** the right-hand column, derived at read time, single-actor, per §7.
Empty renders "Nothing recorded in this matter yet." Never a placeholder row.

### 10.2 First-run intake (`1f`) — **structural**

**What it is for:** replacing "build a template before anything happens" with "name a
matter, drop documents, see what the app made of them". Its real value in *this* app —
as opposed to the mockup's — is that it puts three things the user currently has to go
hunting for at the moment they matter: the suggested collection grouping, the parse and
scan results per document, and the privacy disclosure.

**Shape:** a three-step tracker (`1 MATTER / 2 DOCUMENTS / 3 PLAYBOOK`) rendered as the
**empty state of a matter**, not as a new route. A matter with no documents shows the
wizard; a matter with documents shows the status board. This is the handoff's own
instruction ("Empty matter: the `1f` first-run flow, not an empty table") and it costs
no routing change.

**Step 2 renders, honestly, what ingestion actually produced:**

- A document that failed to parse shows its `parseError` inline, with a remove action.
  It does **not** show a progress bar for OCR the app does not perform (R-G13).
- A document detected as a scan says so, and says plainly that reviewing it needs a
  vision-capable model — the same fact `modelContext.ts` already enforces, said once
  before the run rather than once per clause afterwards.
- A `.docx` with tracked changes carries its `markupNotice` here too.
- Suggested collections use the existing `collectionSuggest` heuristic, which proposes
  and never creates (R-C4).

**Step 3** lists the user's playbooks, most-recently-used first, plus "create a new
one" routing into E's flow. **There is no AI suggestion banner** (R-G12): the mockup's
"These look like a commercial lease…" is a model call with a prompt contract, a failure
mode, and a cost, and none of those is a styling decision.

**Footer:** the shared privacy line (§8.4) and the model name with a link to Settings.

### 10.3 The export-gate banner — **structural**

Drawn in `1b`, specified by nobody. It says: "*N* findings are unchecked. Export is
available, but the report will mark them as unverified AI output."

G builds it, because every clause of that sentence is already true and already
enforced: export is never blocked (B §7), and `verificationLabel` already writes
`UNVERIFIED AI OUTPUT` into both exporters. The banner states the export's behaviour at
the moment the user is deciding whether to export — which is the honest place for it.

It renders only when `unchecked > 0`, derives from `verificationCounts`, and links to
the first unchecked finding. It must not block, disable, or gate the export button.

### 10.4 The `Standard positions` nav tab — **structural, and it passes the test**

D §11 declined to invent it. It can now be answered from the app rather than invented,
because D built `positionHealth` and `positionHealthMap`.

**What it is for:** *"which of our house rules are drifting?"* — a question no
per-playbook screen answers, because drift is only visible across playbooks and across
matters.

**Shape:** a read-only index over every published `PlaybookVersion`'s clauses that
carry a `standardPosition`. One row per position: the position text in Newsreader, its
playbook and clause in mono, and its `PositionHealth` chip. Filter by health. Sort:
`conceded` first, then `untested`, then `held` — the ordering answers the question the
screen exists to ask. Each row links to that clause in the playbook editor.

**No new data, no new writes, no new model call.** Health is derived at read time by
D's pure function, exactly as it is on the editor, so the two cannot disagree.

**States:** a firm with no standard positions anywhere gets an empty state that says
so and links to the playbook editor — not an empty table. A failure to read the
playbook store gets `LoadErrorPanel`.

**If the owner would rather not have this tab, dropping it costs nothing else** — no
other screen links to it. §17 offers that.

### 10.5 The `Compare` segmented control — resolved, not invented

C §12 refused to specify `Compare` from a name, and was right to. It is resolvable now
without inventing anything, because the app already has the thing the control is
switching between:

`ResultsView` (cards) and `TabularReview` (grid) are already two renderers over one
findings map, already toggled from the review header. **The `Review / Compare`
segmented control is that existing toggle, restyled.** `Review` is the card/ledger
view; `Compare` is the grid.

Two rules make it honest:

- The control is **absent**, not disabled, when there is nothing to compare across —
  a single-document review, or a collection review, which produces one position per
  clause however many documents fed it (`findingsKeyFor`). A disabled tab advertises a
  view that will never exist for this review.
- It does not mean "compare two runs" or "compare to another matter". Neither exists.

`Report` is **dropped** (R-G11): export is a button that produces a file, and a third
tab would advertise a live report view the app does not have.

### 10.6 Screens G recommends not building

- **`Compare to v3`** (playbook version diff, `4c`). Named as an action, drawn nowhere.
  `VersionHistory` already carries each version's change summary, which is the
  human-authored account of what changed; a structured clause-level diff is a genuine
  feature with its own failure modes (what does a diff of two prompts even assert?).
  Dropped, R-G15.
- **`⌘K` global search.** A cross-entity index over matters, clauses and findings. Not
  a style. Deferred with a name so it is not lost, R-G14.
- **OCR progress.** The app does not OCR. R-G13.

---

## 11. Mobile and responsive — sized honestly, and put to the owner

The handoff says `1h` is "full parity, not a cut-down". Taken literally, that means
every screen in §9 works on a 390px viewport.

**What G-1 includes regardless (and it is not negotiable, because a broken narrow
layout is a defect):** every screen is usable and free of horizontal page scroll at
≥768px. Panes collapse in a defined order — the document pane first, then the clause
index into a dropdown; dense tables scroll inside their own `overflow-x` container
rather than pushing the page; modals become full-height sheets below 640px. This is
ordinary responsive discipline and it rides along with the restyle at low marginal
cost, because the layout of every screen is being touched anyway.

**What full phone parity additionally requires, and why it is not a restyle:**

1. A **bottom tab bar** replacing the top nav — new navigation chrome with its own
   active-state logic and safe-area handling.
2. A **phone review flow**. The ledger's three panes cannot collapse into a phone; the
   handoff itself says so, and proposes `1c` (a single-column brief with the document
   as an on-demand overlay) as *the same layout mobile gets*. That is a second
   renderer over the findings map, plus an overlay document viewer, plus prev/next
   clause navigation, plus a pinned disposition bar.
3. A **phone grid**. `1e` at 390px is not a table. It needs a genuinely different
   presentation (per-document cards, or a clause-at-a-time column), which is a design
   problem, not a media query.
4. A **phone variation trail** and phone treatments of the intake wizard, the playbook
   editor's drag-reorder (touch drag is its own problem), and the draft review.
5. **Touch verification**: the keyboard verify loop (`J`/`V`/`F`/`R`) has no phone
   equivalent, so the phone needs its own way to move through unchecked findings.
6. **Test coverage for all of it** in a suite that currently has no viewport dimension
   at all.

That is a second body of work of roughly the same size as G-1's restyle — items 2 and
3 alone are new renderers, and item 5 is a new interaction model. **Full phone parity
roughly doubles this sub-project**, and it doubles it with work that is structural
rather than cosmetic, which means it cannot ride the "no behaviour change" review
discipline that makes G-1 safe to land.

**Recommendation:** G ships ≥768px responsive parity. Phone parity (`1h`) becomes
**sub-project H**, sequenced after G, specified separately, and free to make the
layout decisions (single-column brief vs. ledger) that a phone forces and a desktop
does not. §17 puts this to the owner as a decision point, with the alternative stated:
if the owner wants phone parity inside G, G's plan should be written as two phases with
separate definitions of done, and the estimate should double rather than the scope
being quietly compressed.

---

## 12. Sequencing, seams, and what may not be split

### 12.1 The honest position on incremental release

There is no way to *deploy* a half-migrated reskin without users seeing a half-migrated
app. Shared primitives (`Button`, `Modal`, `Toast`, chips, `LoadErrorPanel`) appear on
every screen, so the moment they turn light, every unmigrated screen shows light chips
on dark cards. Any claim that this can ship route-by-route requires a transitional dual
palette — two full sets of tokens and a per-route switch — which is more work than the
reskin, and which would itself have to be removed.

So: **G lands on its own branch and merges once complete.** The seams below exist to
make review, bisection and rollback tractable, not to ship intermediate states. Each
step is its own commit, each passes `tsc --noEmit`, the full suite, and `npm run build`
clean.

### 12.2 The order

1. **Token layer, additively.** `src/index.css` gains the palette layer (plain `:root`
   custom properties) and the semantic layer (`@theme`). The old dark `@theme` values
   stay for now. Nothing changes visually. Fonts land here: vendored woff2 under
   `public/fonts/`, `@font-face`, fallback stacks. **Reviewable in isolation, and the
   riskiest thing in it is a font file path.**
2. **The palette guard test** (§13.4). Written now, currently failing, skipped with an
   explicit reason, un-skipped at step 8. Writing it first means the target is defined
   before the work rather than asserted after it.
3. **Shared primitives** (§9.1). Eight components, all with existing tests, all
   selected by role and text. If a primitive's test needs editing, something behavioural
   changed and the commit is wrong.
4. **Chrome** — top bar, `not-found`, the app frame, `body`. The dark `@theme` block is
   deleted here; from this commit the branch is visibly light and visibly inconsistent,
   which is expected and is why it is a branch.
5. **Matters route group** — `MattersList`, `MatterHome` (restyle only), `CollectionCard`,
   the two matter dialogs.
6. **Review route group** — `ResultsView` (restyle of today's two panes), `FindingCard`,
   `EvidenceList`, `VerificationControls`, `NotesPanel`, `PositionComparison`,
   `NetPositionPanel`, `VariationTrailModal`, `DocumentViewer`, run banners, `RunPanel`.
7. **Grid, playbooks, authoring, settings, assistant** — the remaining route groups, in
   any order; they do not depend on each other.
8. **Un-skip the palette guard.** Any remaining raw colour is now a test failure.

Then G-2, each item independently revertible:

9. Matter status board's stat row and activity list (§10.1).
10. Export-gate banner (§10.3).
11. First-run intake (§10.2).
12. `Standard positions` tab (§10.4).
13. `Review / Compare` segmented control (§10.5).
14. Responsive pass to 768px across every screen (§11). Deliberately after every screen
    has reached its final shape — a responsive pass over a layout still due to change is
    a pass that has to be repeated.

Finally, and only if the owner approves decision D2 (§17):

15. The three-pane ledger (§9.4). Sequenced after everything above and written so that
    declining it costs nothing already landed.

### 12.3 What may not be split

- The token layer and the palette guard: a token set with no guard drifts within a week.
- A component's restyle and its state branches: never restyle the happy path in one
  commit and "restore the error state" in a follow-up. The follow-up is the commit that
  gets dropped.
- `verificationLabel`'s consumers: the screen and both exporters read one module; a
  commit that touches one of them touches all or none.

---

## 13. Testing

### 13.1 What the suite constrains, and how favourably

The suite is 1,297 tests across 99 files (Vitest + jsdom; component tests through
`src/test/mount.tsx`, no `@testing-library/react`). Measured against this sub-project:

- **461** assertions select by `textContent`.
- **Zero** assertions on a CSS class as a *style* claim.
- DOM selectors are structural and semantic: `button`, `input`, `textarea`, `table`,
  `td`, `h3`, `li`, `[role="status"]`, `[role="dialog"]`, `[aria-label=…]`,
  `[title=…]`, `[draggable="true"]`, `[data-testid=…]`, and three element ids.

This is close to the best possible starting position for a reskin, and it produces the
sub-project's governing test rule:

> **A pure restyle turns the suite green with no test edited.** A test edit inside a
> restyle commit is the signal that behaviour or copy changed — it is not a chore to be
> absorbed, it is the finding. Either revert the change, or move it to a commit that
> declares itself structural and explains why the copy moved.

### 13.2 The three tests that *will* break, and what to do about them

Three assertions couple to a presentational class and must be converted **before** the
components they cover are restyled, as their own commit:

| Test | Selector | Replacement |
| --- | --- | --- |
| `App.rerunResets.test.tsx:998` | `.animate-spin` | Busy elements carry `role="status"` + `data-busy="true"`; assert on those. Also §8.6's reduced-motion requirement |
| `TabularReview.test.tsx:97` | `.truncate` | The cell's summary carries `data-testid="cell-summary"` |
| `TemplateEditor.test.tsx:124` | `.closest('.group')` | The clause row carries `data-clause-row` |

Each conversion is mutation-tested: break the component, confirm the converted test
fails, restore.

### 13.3 Structural contracts a restyle may not break

Because 461 assertions read text and the rest read structure, the restyle must preserve:

- Heading levels where a test reads them (`h3` in three files).
- `role="dialog"` on every modal, `role="status"` on every chip and toast.
- `aria-label` and `title` attributes currently used as selectors, verbatim:
  `"Change summary"`, `"Retry"`, `"Delete Matter"`.
- The grid's real `<table>`/`<td>` structure — `td:nth-child(2)` is asserted. A CSS-grid
  rewrite of the table would break both the tests and the screen-reader semantics.
- Input ids `#base-a` / `#base-b` / `#base-c` in `GroupDocumentsDialog`.
- `data-testid="note-text"`.
- `[draggable="true"]` on clause rows.
- Every icon-only button keeps an `aria-label` — `buttonNamed` checks it, and an
  icon-only control with no accessible name is a regression whether or not a test
  catches it.

### 13.4 New tests G adds

1. **Palette guard** (`src/test/palette.test.ts`): scans non-test `.tsx`/`.ts` under
   `src/` for hex colour literals, `rgb(`/`rgba(` literals, and Tailwind arbitrary
   colour values (`text-[#…]`, `bg-[rgba…]`) inside `className` strings, and fails with
   the file and line. Exempt: `src/index.css` (the token definitions), `PdfCanvas.tsx`
   (canvas draw calls are not styling). Mutation-tested by adding a hex to a component
   and confirming the failure.
2. **Semantic-role guard**: the same scan fails on a palette-layer variable name
   (`--lex-*`) appearing outside `src/index.css`.
3. **State-preservation tests** for anything §8 names that is not already covered —
   in particular the stat row's empty and error branches (§10.1), and the export-gate
   banner's absence when `unchecked === 0`.
4. **Reduced-motion**: a busy element still exposes `role="status"` and its text under
   `prefers-reduced-motion` (asserted structurally, since jsdom does not evaluate media
   queries — the requirement is that the text is not conditional on motion, and the test
   asserts the text is always present).
5. **Contrast**: a unit test over the token table asserting a minimum contrast ratio
   (4.5:1 for body text, 3:1 for chips and large text) for every ink-on-surface and
   role-on-tint pair the design system defines. This is pure arithmetic over the token
   values, needs no browser, and catches the single most likely regression in a
   palette this low-contrast — `ink-5` on `paper` is close to the line by design.

### 13.5 What the suite genuinely cannot catch, and must be verified in a browser

jsdom does not lay out, does not paint, does not load fonts, and does not evaluate
media queries. It cannot see any of the following, and CLAUDE.md's standing rule
applies: **if you cannot drive the real app, say so plainly rather than implying you
did.**

Verify in a browser, with a real key and real documents:

1. **Fonts actually load and fall back gracefully.** Block the font files and confirm
   the fallback stack keeps every screen readable and un-reflowed.
2. **Contrast in situ**, especially `ink-4`/`ink-5` metadata on `paper`, and the mono
   chips at 9–10px.
3. **The document pane**: highlight fill and underline land on the cited passage,
   `page` white against `doc-gutter`, and the one permitted page shadow.
4. **The three chips are distinguishable at a glance** on one finding that is
   simultaneously `verified`, `Medium` risk, and `deviates`. This is the conflation
   this project keeps re-introducing and it is a purely visual judgement.
5. **Every load-error branch renders**, forced by throwing from the repository: matters,
   library, matter, its three sections, review, playbook, run panel's picker.
6. **A run mid-flight**: progress bar, per-cell extracting, a cell erroring with Retry,
   cancellation, and a reopened interrupted review — all four banners.
7. **A scanned PDF and a marked-up DOCX** through the intake wizard, confirming the
   scan warning and the markup notice appear before the run.
8. **Reduced-motion on**, confirming busy states are still legible.
9. **768px and 1024px** across every screen: no horizontal page scroll, the grid
   scrolling inside its own container, modals as sheets below 640px.
10. **The two flows unit tests have historically missed**: "Run a review" showing the
    right documents, and a review that failed once still being openable.

---

## 14. Error handling

G introduces no new failure modes of its own except two, both in the token/font layer:

- **A font file fails to load.** `font-display: swap` plus a real fallback stack means
  the app renders in the fallback and stays usable. No screen may depend on a font
  metric (no icon fonts, no character-width layout).
- **A token is referenced that does not exist.** A missing custom property resolves to
  nothing and can produce invisible text. The palette guard (§13.4) plus the contrast
  test catch the classes of this that matter; the review discipline is that a new role
  is added to `index.css` in the same commit that first uses it.

Every other error path in the app is pre-existing and is preserved verbatim per §8.

---

## 15. Definition of done

1. `npx tsc --noEmit` clean; `npm test` passes; `npm run build` clean with no
   externalization warning.
2. `src/index.css` carries the two-layer token set. The dark `@theme` block is gone.
3. The palette guard and semantic-role guard pass, un-skipped, and each has been
   mutation-tested.
4. The contrast test passes for every token pair the system defines.
5. No application component references a raw colour, a raw hex, or a palette-layer
   variable.
6. Fonts are served from the app's origin. No request leaves the page except to
   OpenRouter — verified in the browser's network panel on a cold load.
7. Every component in §9 is restyled and its existing tests pass **unedited**, except
   the three conversions in §13.2 and the copy changes R-G6 lists.
8. Every item in §8 is demonstrably present: nine load-error branches, four
   `ReviewVersionLine` outcomes, four position-health kinds, the absent `PositionChip`,
   four run banners, the frozen copy, and the reduced-motion busy state.
9. No multi-user affordance ships: no assignee chip, no "assigned to me", no second
   actor's name anywhere, no firm tag. The profile avatar shows the local profile's
   initials.
10. The G-2 screens ship per §10, each with its empty and error branches.
11. Every screen is usable at 768px with no horizontal page scroll.
12. Browser-verified per §13.5, all ten items, and the verification is written down.

---

## 16. Risks

**The reskin deletes an error state.** The central risk, and the reason §8 exists as a
checklist rather than a principle. Mitigation is structural: the test suite is
copy-coupled, so most deletions fail a test; §8's items that no test covers get one in
§13.4.

**Copy drifts for visual reasons.** A designer's instinct is to shorten
"UNVERIFIED AI OUTPUT" to "UNVERIFIED". That string is printed into a DOCX a client may
read. R-G5 freezes it; §13's rule surfaces any attempt as a test edit.

**The three chips converge.** Risk-high and rejected share a hue; risk-med and flagged
share a hue. That is the handoff's palette and it is right — but colour alone must
never carry the distinction. §6.4's three-shapes rule is the mitigation, and §13.5's
item 4 is the check.

**Low contrast.** The paper palette is deliberately soft: `ink-5` (`#a8a29a`) on
`paper` (`#f6f3ed`) is around 2.3:1 and is fine for a decorative timestamp and wrong
for anything a reader must not miss. **No failure state, disclosure, or warning may use
`ink-4` or below.** The contrast test enforces the ratio; this sentence enforces the
role assignment.

**Scope creep through undrawn screens.** The owner's permission to design undrawn
screens is the most dangerous line in this brief. §10's self-imposed rule — say what it
is for or drop it — is the control, and §10.6 is the evidence it was applied.

**Mobile absorbed silently.** §11 sizes it and §17 asks. The failure would be a plan
that says "responsive" and quietly means "phone", then runs out of time and ships
neither well.

**The ledger relayout smuggled in as styling.** §9.4 flags it, §12.2 sequences it last
and separately, §17 offers declining it. A two-to-three-pane change is a scope decision
and must be approved as one.

---

## 17. Decision points for the owner

Three genuine forks. Each has a recommendation; none blocks the rest of G.

**D1 — Phone parity: in G, or sub-project H?**
*Recommendation: sub-project H.* G ships ≥768px. Full phone parity needs a second
review renderer, a phone treatment of the grid, a bottom tab bar, and a touch
replacement for the keyboard verify loop — structural work of roughly G-1's size, and
work that cannot ride G's "no behaviour change" review discipline. Deferring it lets
`1c`-vs-`1b` be decided on its merits for a phone rather than inherited from the
desktop choice. *If you want it in G:* the plan must be written as two phases with
separate definitions of done and the estimate doubled — not the scope compressed.

**D2 — The three-pane ledger: now, or not in G?**
*Recommendation: include it, sequenced last and separately revertible (§12.2 step 15).*
Today's review screen is two panes with the findings in a 1/3 rail; `1b` is three, with
the finding given a 470px column of its own. The three-pane layout is materially better
for the app's central task, but it is a layout change, not a restyle, and it is the one
place in G where "cosmetic" would be a lie. Declining it costs nothing else in G.

**D3 — The `Standard positions` nav tab: build it, or drop the tab?**
*Recommendation: build it (§10.4).* It answers a question no other screen answers —
which house rules are drifting — entirely from data D already derives, with no new
writes and no new model call. It is the one undrawn screen that passed §10's "say what
it is for" test. *If you would rather not:* dropping it costs nothing; nothing else
links to it, and the nav simply carries two tabs.

---

## 18. Appendix — rulings made without owner review

Recorded in `docs/superpowers/redesign/rulings.md`'s format. Each carries its
cost-if-wrong.

- **R-G1. Every multi-user affordance in the prototypes is dropped or resolved to the
  local profile, per §7's table.** Dropped: the "assigned to me" counter and badge, the
  assignee chip and assign action, the firm tag, the mobile `Assigned` tab, and
  "flagged *for* X" phrasing. Kept and resolved single-user: attribution ("Rejected by
  you"), the avatar (local initials), and the activity feed as a derived, single-actor,
  never-stored matter history that renders an explicit empty state rather than a
  placeholder row. *Cost if wrong: the app photographs less like a firm-wide product.
  The opposite error has a lawyer waiting on a review nobody was asked for — a silence
  the app manufactured — which is why the asymmetry decides it.*
- **R-G2. Colour tokens live in two layers, and the palette layer is deliberately
  unreachable from components.** Raw values are plain `:root` custom properties
  (`--lex-*`) that generate no Tailwind utilities; only the semantic layer sits in
  `@theme` (`--color-risk-high`, `--color-accent`, `--color-ink-4`, …) and therefore
  only semantic names exist as utilities. `bg-oxblood` is not a class anyone can type.
  This mirrors `seq.ts`'s type-enforcement idiom: make the wrong thing fail rather than
  documenting that it is wrong. Arbitrary-value escapes are closed by the palette guard
  test. *Cost if wrong: one extra indirection in `index.css`, and a role must be named
  before it can be used — which is the point.*
- **R-G3. Fonts are self-hosted from `public/fonts/`, never hotlinked from Google.**
  The app's own disclosure states that nothing leaves the browser except calls to
  OpenRouter; a font `<link>` to a third-party CDN would make that sentence false for
  every page view, in an app whose founding rule is not being quietly wrong. Latin
  subset, woff2, `font-display: swap`, real fallback stacks, total budget ≤350 KB. No
  npm dependency: the files are vendored. *Cost if wrong: ~350 KB of static assets in
  the deploy and a manual step to update a font version.*
- **R-G4. Semantic roles are named by meaning, not appearance, and `verified` uses the
  accent teal (`#14574f`) while `low risk` uses the green (`#2c6448`).** The handoff is
  explicit and the distinction is load-bearing: teal means a human confirmed something;
  green means the model rated something low. *Cost if wrong: two nearby colours a user
  may read as one — which is exactly why they also differ in chip shape (R-G16).*
- **R-G5. Copy carrying a disclosure or a failure state is frozen (§8.4), and where a
  prototype's wording differs, the shipped wording wins.** Uppercase presentation is a
  CSS decision; the string is not, because several frozen strings are printed into a
  DOCX or a CSV cell where the chip's styling does not exist. *Cost if wrong: some
  screens read slightly less like the mockups.*
- **R-G6. The permitted copy changes in G are enumerated, and each is a declared test
  change.** They are: the nav's `Library` → `Playbooks`; the playbook editor's derived
  coverage line ("*n* of *m* clauses have a standard position"); the export-gate
  banner (§10.3); the intake wizard's step labels; and the `Standard positions` tab's own
  strings. Everything else in §8.4 is frozen. *Cost if wrong: a handful of test
  assertions updated in commits that declare themselves as copy changes rather than
  restyles.*
- **R-G7. One palette. No dark theme, no theme toggle.** The redesign is a paper
  aesthetic and the whole point is legal prose that reads like a document. A toggle
  would double every contrast check and every browser verification. *Cost if wrong:
  users who preferred the dark app lose it; adding a theme later is a second set of
  values under a `[data-theme]` selector, which the two-layer token structure makes
  cheap — that is much of why the structure is worth having.*
- **R-G8. The comparison grid (`1e`) was already rebuilt in sub-project C; G restyles
  it and must not rebuild it.** The brief that commissioned this spec lists `1e` as a
  deferred screen. It is not: `TabularReview.tsx` already has the per-column risk
  mini-bar, the un-truncated sentence per cell, separated risk and verification, and
  "Open in review". Recorded loudly because rebuilding it would silently discard C's
  `findingsKeyFor` collection handling — the source of six defects in C. *Cost if wrong:
  none; verified by reading the component.*
- **R-G9. The activity feed is derived at read time and never stored.** Its inputs
  (`verification.at`, `Note.at`, `netPosition.confirmedAt`, `Review.startedAt`) already
  exist and already carry an author. Storing an event log would create a second account
  of what happened that can drift from the findings themselves. *Cost if wrong: the
  feed shows only what the current data model timestamps — no "you opened this" events —
  which is the honest subset anyway.*
- **R-G10. The matter stat row renders an empty form when no review has completed, and
  is replaced by the load-error panel when reviews fail to load — never three zeroes.**
  Zero verified of zero is not a fact about a matter's safety; it is the "empty
  indistinguishable from broken" shape CLAUDE.md's load rule exists to prevent, at the
  top of the screen that exists to say how checked the matter is. *Cost if wrong: one
  extra branch per stat card.*
- **R-G11. The `Report` segmented tab is dropped; export stays a button producing a
  file.** A `Report` tab advertises a live report view the app does not have, and the
  handoff never draws one. *Cost if wrong: a segmented control with two options rather
  than three.*
- **R-G12. The intake wizard ships without the AI playbook suggestion.** The mockup's
  "These look like a commercial lease…" banner is a model call with a prompt contract,
  a cost, and a failure mode (a confidently wrong playbook choice at the moment the
  user is least able to judge it). None of that is a styling decision. Step 3 lists the
  user's playbooks, most-recently-used first. *Cost if wrong: one fewer convenience on
  the first-run path; adding it later is additive and belongs with E's generation code.*
- **R-G13. No OCR progress UI.** The app does not OCR. Drawing a progress bar for work
  it does not perform is precisely the failure §2 forbids. A scanned document says it is
  scanned and says a vision-capable model is needed — the fact `modelContext.ts` already
  enforces, stated once before the run rather than once per clause after it. *Cost if
  wrong: the intake screen looks less capable than the mockup, and is more honest.*
- **R-G14. `⌘K` global search is deferred, and G renders no search box.** It is a
  cross-entity index over matters, clauses and findings — a subsystem, not a style. A
  visible-but-dead search box is worse than none. *Cost if wrong: the top bar has a gap
  where the mockup has a control.*
- **R-G15. `Compare to v3` (playbook version diff) is dropped.** Named as an action in
  `4c`, drawn nowhere. `VersionHistory` already carries each version's human-authored
  change summary, which is the account that means something; a structured diff of two
  prompt strings asserts less than it appears to. *Cost if wrong: a version history
  without a diff view, which is what ships today.*
- **R-G16. The three chips differ in shape, not only in hue.** `RiskChip` is a filled
  dot plus a label with no border; `StateChip` is a lucide icon plus a label in a
  hairline-bordered chip fill; `PositionChip` is a label inside a 1px coloured border on
  a transparent fill. The handoff's palette gives rejected and high-risk the same
  oxblood, and flagged and medium-risk the same amber, so colour alone cannot carry the
  distinction between "a person disagreed", "the model rated it risky", and "it departs
  from our house rule". *Cost if wrong: three chips that look slightly less uniform than
  a single badge family would — which is the intent.*
- **R-G17. G lands on one branch and merges whole; the seams in §12.2 are for review
  and bisection, not for shipping intermediate states.** Route-by-route release would
  require a transitional dual palette costing more than the reskin. Said plainly rather
  than promising incrementality the shared primitives make impossible. *Cost if wrong: a
  longer-lived branch, mitigated by every step passing tsc, tests and build on its own.*
- **R-G18. The `Standard positions` tab is built, and it is the only undrawn screen
  that G invents.** It passes §10's test — it answers "which of our house rules are
  drifting", a question no per-playbook screen answers — and it needs no new data,
  writes, or model calls, because D's `positionHealth` already derives everything it
  shows. *Cost if wrong: a read-only index nobody opens; deleting it costs nothing
  because nothing else links to it.*
- **R-G19. Failure, disclosure and warning text may never use `ink-4` or below.** The
  paper palette is deliberately soft and its lower ink steps are decorative-grade
  contrast. A warning rendered in `ink-5` is a warning the reader's eye skips. *Cost if
  wrong: some metadata rows are slightly darker than the mockup.*
- **R-G20. Busy states must be legible without motion.** Under `prefers-reduced-motion`
  the pulse becomes a static tinted bar and the word "extracting" remains. A busy state
  whose only signal is an animation is invisible to a reader who turned animation off,
  which is the "cell spinning forever, unfinishable" defect in a different disguise.
  *Cost if wrong: a slightly less elegant reduced-motion rendering.*
- **R-G21. Spacing stays on Tailwind's default 4px grid; the prototype's ladder is
  snapped to it.** The handoff lists 5 / 6 / 7 / 9 / 11 / 14 / 18 / 22 / 26 / 34px, which
  is an artefact of hand-authored inline HTML rather than a designed scale. Re-basing
  `--spacing` to 2px to reproduce it exactly would silently change the meaning of every
  spacing utility already written across ~788 `className` sites — a change with no
  visual review surface and enormous blast radius. Radii and type sizes are *not*
  snapped: those are named roles with explicit values, so they reproduce the prototype
  exactly. *Cost if wrong: padding differs from the mock by up to 2px in places.*
