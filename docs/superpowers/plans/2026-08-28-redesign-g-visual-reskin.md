# Redesign sub-project G — The visual reskin — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace v1's dark violet-on-near-black Tailwind defaults with the owner's paper design system — two-layer tokens, three self-hosted families, semantic role colours — across all 45 components, build the five screens the other sub-projects left homeless, and do it without deleting a single error, empty, partial or interrupted state.

**Architecture:** All colour lives as CSS custom properties in `src/index.css` in two layers: a palette layer of plain `:root` variables that Tailwind generates no utilities for, and a semantic layer inside `@theme` that generates every class application code is allowed to type. Components name meanings (`bg-risk-high-tint`), never colours. Two test guards make the wrong thing fail rather than documenting that it is wrong: a palette scanner that rejects a raw colour anywhere under `src/`, and a contrast test that is pure arithmetic over the token table. The restyle carries no behaviour change, which is what makes each of its commits reviewable by one question; the five inherited screens are labelled structural and sequenced after it.

**Tech Stack:** React 19, TypeScript 5.8 (strict), Vite 6, Tailwind 4 (`@tailwindcss/vite`, `@theme`), `lucide-react`, Vitest 3 + jsdom, `src/test/mount.tsx`. **No dependency is added by this sub-project.**

**Spec:** `docs/superpowers/specs/2026-08-28-redesign-g-visual-reskin.md` (binding authority). Rulings R-G1–R-G21 are in its §18 and mirrored in `docs/superpowers/redesign/rulings.md`.

---

## The owner's three decisions, now ruled

The spec's §17 put three forks to the owner. All three are answered, and the answers are binding on this plan.

**D1 — Phone parity is NOT in G. It becomes sub-project H, to be specced separately.**
G ships **responsive behaviour of the screens that exist**, down to a 768px viewport: no horizontal page scroll anywhere, panes collapsing in a defined order, dense tables scrolling inside their own container, modals as full-height sheets below 640px (Task 22). G ships **no phone-specific screen**. Full `1h` parity needs a second review renderer (`1c` as a single-column brief), a phone treatment of the comparison grid, a bottom tab bar with its own active-state and safe-area logic, and a touch replacement for the `J`/`V`/`F`/`R` keyboard verify loop. That is structural work of roughly G-1's size, it cannot ride G's no-behaviour-change review discipline, and folding it in would roughly double this sub-project while destroying the property that makes it reviewable.
**Mobile is not forgotten. It is sub-project H, and Task 24 records that in `rulings.md` so a later reader does not have to infer it.**

**D2 — The three-pane ledger (`1b`) IS in G, sequenced last and separately revertible.**
It is Task 23, the final implementation task, with its own definition of done and its own commit boundary. It is a **layout change, not a restyle** — the one place in G where calling the work cosmetic would be a lie — so it is isolated such that `git revert` of that single commit leaves every other task intact.

**D3 — The `Standard positions` nav tab IS built** (R-G18). Task 20. It reads entirely from D's existing derived `positionHealth`/`buildPositionHealthMap`: **no new stored data, no new writes, no model call.**

---

## Global Constraints

Copied verbatim from the spec and CLAUDE.md. Every task's requirements implicitly include this section.

- **Fail loudly rather than answer quietly wrong.** Prefer a loud, specific, recoverable failure over anything that could be mistaken for a successful empty result.
- **Restyling a component preserves its states — every one of them, including the error, empty, partial, loading, interrupted and refused states.** A mockup shows a screen in its happy state. The spec is where the other states survive.
- **A pure restyle turns the suite green with no test edited.** A test edit inside a restyle commit is the signal that behaviour or copy changed — **it is not a chore to be absorbed, it is the finding.** Either revert the change, or move it to a commit that declares itself structural and explains why the copy moved.
- **Colour tokens live in two layers, and the palette layer is deliberately unreachable from components** (R-G2). Raw values are plain `:root` custom properties (`--lex-*`) that generate no Tailwind utilities; only the semantic layer sits in `@theme`.
- **Forbidden anywhere under `src/` except `src/index.css`:** a hex literal or `rgb()`/`rgba()` literal inside a `className`; a Tailwind arbitrary colour (`text-[#…]`, `bg-[rgba(…)]`); a `--lex-*` palette variable; a generic Tailwind palette class (`text-emerald-400`, `bg-violet-600`, `border-white/10`).
- **A role that does not exist yet is added to `index.css` in the same commit that first uses it**, never afterwards.
- **Teal (`#14574f`) means a person did something.** Low risk is green (`#2c6448`) and *is not* teal; a confirmed net position is teal and *is not* green (R-G4).
- **The three chips differ in shape, not only in hue** (R-G16). `RiskChip` = filled dot + uppercase mono label, **no border**. `StateChip` = lucide icon + uppercase mono label, hairline border, chip fill. `PositionChip` = uppercase mono label inside a 1px role-coloured border, transparent fill. Never merged into one badge.
- **A clause with no standard position gets no chip.** `PositionChip` returns `null` on an absent outcome and the absence is the message — no default, no placeholder, no grey "n/a" pill.
- **Verification state is set only by a human action; nothing derives it.** G renders it. G never writes it.
- **Copy frozen by spec §8.4 is not reworded.** Everything `src/lib/findingOutcome.ts` exports; `positionHealthLabel`'s four strings; `ReviewVersionLine`'s four sentences; `SettingsPanel`'s two disclosure blocks; `TemplateEditor`/`TemplateLibrary`'s unpublished-changes badges and the disabled-publish tooltip; `RunPanel`'s four banner sentences; the model-capability refusal; `SourcePicker`'s privacy sentence; `TEMPLATE_DIRTY_MESSAGE` and `AUTHORING_DRAFT_DIRTY_MESSAGE`; `MatterHome`'s "Preparing documents for review…". Where a prototype's wording differs, **the shipped wording wins** (R-G5).
- **Uppercase is a CSS decision, not a string decision.** Use `text-transform: uppercase`; never uppercase the string — several frozen strings are printed into a DOCX or a CSV cell where the chip's styling does not exist.
- **The permitted copy changes are enumerated** (R-G6, extended once by R-GP3 below), and **each is a declared test change**: the nav's `Library` → `Playbooks`; the playbook editor's derived coverage line; the export-gate banner; the intake wizard's step labels; the `Standard positions` tab's own strings.
- **Failure, disclosure and warning text may never use `ink-4` or below** (R-G19).
- **Busy states must be legible without motion** (R-G20). Under `prefers-reduced-motion: reduce` every transition collapses to 0, the extracting pulse becomes a static tinted bar, and the word stays.
- **Fonts are self-hosted from `public/fonts/`, never hotlinked** (R-G3). Latin subset, `woff2`, `font-display: swap`, real fallback stacks, total budget **≤350 KB**. No screen may depend on a font metric: no icon fonts, no character-width layout.
- **One palette. No dark theme, no theme toggle** (R-G7).
- **G adds no dependency.** No `@fontsource/*`, no headless UI kit, no CSS-in-JS runtime, no charting library. Every graphic is a div with a width.
- **Spacing stays on Tailwind's default 4px grid** (R-G21); the prototype's 5/6/7/9/11/14/18/22/26/34px ladder snaps to the nearest 4px step. Radii and type sizes are **not** snapped — they are named roles with explicit values.
- **No shadow on a card, ever.** Exactly two shadows exist: `--shadow-tab` on an active segmented-control tab and `--shadow-page` on a rendered document page.
- **No multi-user affordance ships** (R-G1): no "assigned to me" counter or badge, no assignee chip, no assign action, no firm tag, no second actor's name anywhere. Kept and resolved single-user: attribution ("Rejected by you"), the avatar showing the local profile's own initials, and the activity list as a derived, never-stored, single-actor matter history.
- **G renders no search box** (R-G14), **no `Report` tab** (R-G11), **no playbook version diff** (R-G15), **no OCR progress UI** (R-G13), **no AI playbook suggestion in the intake wizard** (R-G12).
- **Do not touch:** `src/lib/citations.ts`, `src/lib/openrouter.ts`, `src/lib/concurrency.ts`, `src/lib/citationPage.ts`, `src/lib/verification.ts`, `findingOutcome.ts`'s and `positionHealth.ts`'s **strings**, `extractClause.ts`, `extractCollectionClause.ts`, `runReview.ts`, `collectionPrompt.ts`, every `src/lib/db/*` repository, every exporter's output, and `PdfCanvas.tsx`'s canvas rendering (its highlight **overlay divs** are in scope — see R-GP1).
- **Structural contracts a restyle may not break:** `role="dialog"` on every modal; `role="status"` on every chip and toast; the `aria-label`/`title` selectors `"Change summary"`, `"Retry"`, `"Delete Matter"`, `"Close"`; the grid's real `<table>`/`<td>` structure (`td:nth-child(2)` is asserted — a CSS-grid rewrite breaks both the tests and the screen-reader semantics); input ids `#base-a`/`#base-b`/`#base-c`; `data-testid="note-text"`; `[draggable="true"]` on clause rows; `h3` where a test reads it; an `aria-label` on **every** icon-only button (`buttonNamed` checks it).
- **Gates for every task:** `npx tsc --noEmit` clean, `npm test` green, `npm run build` clean with no externalization warning.
- **Mutation-test anything load-bearing.** Break the implementation, confirm the test fails, restore. A green suite is not evidence.
- **No `@testing-library/react`.** New component tests use `src/test/mount.tsx` (`mount`, `mountOnce`, `click`, `type`, `keyDown`, `buttonNamed`).
- **`toEqual` does not distinguish an absent key from an `undefined` one.** When absence is the assertion, write `expect('x' in obj).toBe(false)`.
- **Two live `mount()`s in one test leave two competing global listeners.** Use `mountOnce` and unmount explicitly when a test needs a second tree.
- **Stage commits by name.** Never `git add -A` / `.` / `src` / `-u`.
- **G lands on one branch and merges whole** (R-G17). The task boundaries below exist for review, bisection and rollback — **not** for shipping intermediate states. The branch is visibly half-light between Tasks 6 and 14 and that is expected.

---

## Rulings made while writing this plan

Recorded here and copied into `docs/superpowers/redesign/rulings.md` by Task 24. Each departs from, or extends, something the spec left open, and each carries its cost if wrong.

**R-GP1 — `PdfCanvas.tsx`'s highlight overlay divs are restyled; its canvas draw calls are not touched.**
Spec §3 calls `PdfCanvas` a partial exception ("it renders into a canvas and takes no restyling") and §13.4 exempts the whole file from the palette guard. But the citation highlight is **not** a canvas draw call: `PdfCanvas.tsx:100-101` renders absolutely-positioned `<div>`s with `backgroundColor: 'rgba(255, 235, 59, 0.35)'` and `borderBottom: '2px solid rgba(255, 193, 7, 0.8)'` — DOM, in the old yellow, not the design's `rgba(255,222,89,.34)` / `rgba(198,150,20,.75)`. Leaving them would ship the one graphic §13.5 item 3 exists to verify in the wrong colour, hidden behind a guard exemption. So: those two inline style values become `var(--color-highlight-fill)` / `var(--color-highlight-edge)`, the file-level guard exemption stays exactly as the spec wrote it, and nothing else in the file changes. *Cost if wrong: two lines of a file the spec called untouched are touched, in the direction the spec's own token table asks for.*

**R-GP2 — Busy elements carry `data-busy="true"` and `aria-live="polite"`, NOT `role="status"`.**
Spec §8.6 and §13.2 say busy elements should gain `role="status"` + `data-busy="true"`. That is unsafe here and the spec could not have known why: `[role="status"]` is already this suite's selector for `StateChip`, and **thirteen assertions read it positionally** — `chips()[0].textContent` in `App.verification.test.tsx` (8 sites) and `App.rerunResets.test.tsx` (5 sites), including `App.rerunResets.test.tsx:459`, which reads `chipsDuring()[0]` **while a card is busy**. Adding `role="status"` to a busy card inserts a new element into that index-ordered list and changes what every one of those assertions selects. `role="status"` is defined as exactly `aria-live="polite"` plus `aria-atomic="true"` on a status region, so `aria-live="polite"` delivers the identical announcement behaviour without colliding with the selector. The machine-checkable contract the spec actually wanted is `data-busy="true"`, and that is what the converted test asserts on. *Cost if wrong: a busy region is announced by `aria-live` rather than by an implicit role — the same announcement — and `[role="status"]` keeps meaning "a chip".*

**R-GP3 — R-G6's enumerated copy changes gain exactly one string: the busy card's visible `Extracting…` label.**
R-G20 requires a busy state to stay legible with motion off. `FindingCard`'s `running` branch today shows a clause title, a spinning `Loader`, and three pulsing skeleton bars — **no word at all**. With `prefers-reduced-motion` on, that is a dimmed card with grey bars, which is indistinguishable from an empty one. So the running branch gains a visible `Extracting…` label. It is new copy, it is declared, and it lands in Task 3 — the one task before the restyle sequence that is allowed to change tests — so that no restyle commit carries a string change. *Cost if wrong: one more string than R-G6 enumerated, in the service of the ruling R-G20 that R-G6 does not override.*

**R-GP4 — The contrast test asserts three tiers, and `ink-5`/`ink-6` pairs are asserted against a decorative floor rather than exempted.**
Spec §13.4 item 5 asks for 4.5:1 body / 3:1 chips and large text. `ink-5` on `paper` is ~2.3:1 **by design** and would fail either threshold, and an exemption list is how a palette silently drifts to invisible. So every pair is asserted, at the tier its role assigns: `body` ≥ 4.5, `chip`/`large` ≥ 3.0, `decorative` ≥ 2.2. A future palette edit that pushes a timestamp below legibility fails the suite. R-G19 — no failure, disclosure or warning text at `ink-4` or below — is the rule arithmetic cannot check, and it is enforced by review, restated in every restyle task's checklist. *Cost if wrong: the decorative tier is a documented floor rather than a WCAG threshold, which is what "decorative" means.*

**R-GP5 — An activity entry whose `byUserId` does not match the local profile renders with no actor, never an invented one.**
§7 says attribution resolves to "you" for the local profile "and the stored display name otherwise". There is no store of other display names — `profile.ts` holds exactly one record — so "otherwise" can only arise when the profile record was re-created (cleared site data, a new browser profile) and old findings point at a dead id. The honest rendering is the event without an actor ("Rejected · 21 Aug 11:02"), never "by someone else", never a placeholder initial. *Cost if wrong: a handful of pre-existing entries lose the word "you"; the alternative is the app naming a colleague who does not exist, which is the exact failure §7 is about.*

**R-GP6 — The `Review / Compare` control is absent when `run.documentIds.length < 2`, as well as for a collection review.**
§10.5 requires absence "when there is nothing to compare across — a single-document review, or a collection review". `TabularReview` already refuses a collection target outright (`isCollectionTarget` → `CollectionNotComparable`). The single-document half has no such guard today: the grid renders a one-column table. The control is therefore gated on **both** conditions, and `ResultsView`'s existing `onOpenTabular` prop stays the mechanism — it is already optional and already renders nothing when omitted. *Cost if wrong: a one-document review loses a grid view that showed one column.*

**R-GP7 — the chat panel moves into the finding column's header, not out of the app.**
The three-pane ledger (Task 23) leaves no room for a rail-level Findings/Chat tab pair, and dropping the chat panel would be a behaviour change smuggled into a layout change — the exact thing §9.4 flags the relayout for. It becomes a two-way segmented control at the top of the 470px finding column: `Finding` / `Assistant`. Every prop `ChatPanel` receives today is unchanged, and ruling R4's "the assistant module is otherwise untouched" still holds. *Cost if wrong: the assistant is one click further from the document pane than it was.*

---

## The restyle task template

Tasks 5–13 are restyles. Each one repeats this shape, and **each names its own components' non-happy states explicitly** — the checklist is in the task, not left to memory. Every restyle task's steps are:

1. **Record the baseline.** Run `npm test` and note the passing count. A restyle that changes it has changed behaviour.
2. **Apply the token mapping**, component by component, using the exact class strings the task gives.
3. **Walk the state checklist** in the task: for every component, confirm its error, empty, partial, loading, interrupted and refused branches are still rendered, still distinct from each other, and still carry their frozen copy. Confirm no warning, disclosure or failure text sits at `ink-4` or below (R-G19).
4. **Run `npm test`.** It must pass **with no test file edited.** `git status --porcelain` must show no `*.test.ts`/`*.test.tsx` file modified. If a test needs editing, **stop**: something behavioural or textual changed. Revert that part and report it.
5. **Run `npx tsc --noEmit` and `npm run build`.** Both clean, no externalization warning.
6. **Run the palette scanner over the files this task touched** (Task 2's `scanSource`), via the one-off command each task gives. Zero violations in those files.
7. **Commit**, staging by name.

---

## File Structure

**Create:**

| File | Responsibility |
| --- | --- |
| `public/fonts/newsreader-latin-var.woff2` | Newsreader variable upright, latin subset |
| `public/fonts/newsreader-latin-var-italic.woff2` | Newsreader variable italic, latin subset |
| `public/fonts/instrument-sans-latin-var.woff2` | Instrument Sans variable upright, latin subset |
| `public/fonts/ibm-plex-mono-latin-400.woff2` | IBM Plex Mono regular |
| `public/fonts/ibm-plex-mono-latin-500.woff2` | IBM Plex Mono medium |
| `public/fonts/ibm-plex-mono-latin-600.woff2` | IBM Plex Mono semibold |
| `src/test/paletteScan.ts` | Pure scanner: source text → colour-literal violations. Not a test file; exempt from its own scan |
| `src/test/palette.test.ts` | The repo-wide palette and semantic-role guards |
| `src/test/tokens.ts` | Pure token-table reader and WCAG contrast arithmetic over `src/index.css` |
| `src/test/contrast.test.ts` | The contrast assertions over every declared token pair |
| `src/test/fonts.test.ts` | Every `@font-face` `src` resolves to a real file; total ≤350 KB; no third-party font host referenced anywhere |
| `src/lib/privacyCopy.ts` | The one place the storage/privacy sentences live, shared by Settings, SourcePicker and the intake wizard |
| `src/lib/matterStats.ts` | Pure: reviews → the status board's three stat summaries |
| `src/lib/matterStats.test.ts` | Its tests |
| `src/lib/matterActivity.ts` | Pure: reviews + local profile id → a single-actor, read-time activity list |
| `src/lib/matterActivity.test.ts` | Its tests |
| `src/lib/standardPositions.ts` | Pure: playbooks + versions + reviews → sorted `PositionRow[]` for the new tab |
| `src/lib/standardPositions.test.ts` | Its tests |
| `src/features/matters/MatterStats.tsx` | The three stat cards, with their empty and load-error branches |
| `src/features/matters/MatterStats.test.tsx` | Its tests |
| `src/features/matters/MatterActivity.tsx` | The activity list, with its empty branch |
| `src/features/matters/MatterActivity.test.tsx` | Its tests |
| `src/features/matters/IntakeWizard.tsx` | The first-run intake, rendered as a matter's empty state |
| `src/features/matters/IntakeWizard.test.tsx` | Its tests |
| `src/features/review/ExportGateBanner.tsx` | "N findings are unchecked…" — renders nothing at zero |
| `src/features/review/ExportGateBanner.test.tsx` | Its tests |
| `src/features/review/ViewSwitch.tsx` | The `Review / Compare` segmented control |
| `src/features/review/ViewSwitch.test.tsx` | Its tests |
| `src/features/positions/StandardPositionsView.tsx` | The `Standard positions` tab: read-only index, filter, empty and error branches |
| `src/features/positions/StandardPositionsView.test.tsx` | Its tests |

**Modify:**

- `src/index.css` — the whole token system; the dark `@theme` block and `body` rule are deleted in Task 6.
- `index.html` — nothing added (no font `<link>`; R-G3). Asserted by Task 1's test.
- All eight shared primitives in `src/components/` (Task 5).
- `src/App.tsx` — chrome (Task 6), banners' host (Task 9), stat row/activity/wizard wiring (Tasks 15/16/18/19), export-gate banner (Task 17), the `positions` route and view (Task 20), the view switch (Task 21).
- `src/lib/router.ts` — one new route, `{ name: 'positions' }` (Task 20).
- Every `.tsx` under `src/features/` (Tasks 7–13, 22, 23).
- `src/features/review/PdfCanvas.tsx` — two overlay style values only (R-GP1, Task 9).
- `src/App.rerunResets.test.tsx`, `src/features/tabular/TabularReview.test.tsx`, `src/features/templates/TemplateEditor.test.tsx` — the three declared conversions (Task 3).
- `src/App.test.tsx`, `src/App.authRedirect.test.tsx`, `src/App.matterDelete.test.tsx`, `src/App.matterPicker.test.tsx`, `src/App.reviewSaveError.test.tsx` — the declared `Library` → `Playbooks` rename, 13 occurrences (Task 6).
- `docs/superpowers/redesign/rulings.md`, `README.md` (Task 24).

**Do not create:** any theme-toggle module, any search component, any `Report` view, any version-diff component, any OCR progress component, any assignee or "assigned to me" component.

---

## Task 1: The token layer and self-hosted fonts

**Kind:** cosmetic (purely additive — nothing changes visually in this commit).

**Files:**
- Modify: `src/index.css` (adds two layers above the existing dark `@theme`, which stays until Task 6)
- Create: `public/fonts/newsreader-latin-var.woff2`, `public/fonts/newsreader-latin-var-italic.woff2`, `public/fonts/instrument-sans-latin-var.woff2`, `public/fonts/ibm-plex-mono-latin-400.woff2`, `public/fonts/ibm-plex-mono-latin-500.woff2`, `public/fonts/ibm-plex-mono-latin-600.woff2`
- Create: `src/test/fonts.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: the complete semantic token vocabulary every later task consumes as Tailwind utilities —
  - surfaces: `canvas`, `paper`, `card`, `doc-gutter`, `page`
  - ink: `ink-1`, `ink-prose`, `ink-quote`, `ink-2`, `ink-3`, `ink-4`, `ink-5`, `ink-6`
  - rules and fills: `rule-soft`, `rule`, `rule-strong`, `chip-fill`
  - accent: `accent`, `accent-tint`, `accent-edge`, `accent-strong`
  - risk: `risk-high`, `risk-high-tint`, `risk-high-edge`, `risk-med`, `risk-med-tint`, `risk-med-edge`, `risk-low`, `risk-low-tint`
  - verification: `state-verified`, `state-flagged`, `state-rejected`, `state-unchecked`
  - position outcome: `outcome-meets`, `outcome-deviates`, `outcome-unclear`
  - position health: `health-held`, `health-conceded`, `health-untested`, `health-none`
  - net position: `net-unconfirmed`, `net-confirmed`, `net-amended`
  - draft/informational: `draft`, `draft-tint`
  - document: `highlight-fill`, `highlight-edge`, `redline-ins`, `redline-del`
  - families: `font-prose`, `font-ui`, `font-mono`
  - type roles: `text-matter-title`, `text-screen-title`, `text-section`, `text-clause`, `text-finding`, `text-quote`, `text-field`, `text-ui`, `text-ui-sm`, `text-button`, `text-meta`, `text-label`, `text-chip`, `text-pin`, `text-figure`
  - radii: `rounded-chip`, `rounded-control`, `rounded-card`, `rounded-panel`, `rounded-inset`, `rounded-meter`
  - shadows: `shadow-tab`, `shadow-page`
  - the `.lex-pulse` utility class for the extracting bar, and its `prefers-reduced-motion` collapse.

- [ ] **Step 1: Vendor the six font files**

Latin-subset `woff2` only. Run from the repo root:

```bash
mkdir -p public/fonts
UA='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36'
# Print the woff2 URLs Google serves for a modern browser, then fetch the latin ones.
curl -s -A "$UA" 'https://fonts.googleapis.com/css2?family=Newsreader:ital,opsz,wght@0,6..72,300..600;1,6..72,300..600&display=swap'
curl -s -A "$UA" 'https://fonts.googleapis.com/css2?family=Instrument+Sans:wght@400..700&display=swap'
curl -s -A "$UA" 'https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&display=swap'
```

Each response block ends with `unicode-range: U+0000-00FF, …` for the `latin` subset — take the `src: url(https://fonts.gstatic.com/…woff2)` immediately above **that** block (the last block in each family's response is `latin`), and save it under the exact names below:

```bash
curl -s -o public/fonts/newsreader-latin-var.woff2        '<Newsreader normal latin woff2 URL>'
curl -s -o public/fonts/newsreader-latin-var-italic.woff2 '<Newsreader italic latin woff2 URL>'
curl -s -o public/fonts/instrument-sans-latin-var.woff2   '<Instrument Sans normal latin woff2 URL>'
curl -s -o public/fonts/ibm-plex-mono-latin-400.woff2     '<IBM Plex Mono 400 latin woff2 URL>'
curl -s -o public/fonts/ibm-plex-mono-latin-500.woff2     '<IBM Plex Mono 500 latin woff2 URL>'
curl -s -o public/fonts/ibm-plex-mono-latin-600.woff2     '<IBM Plex Mono 600 latin woff2 URL>'
du -cb public/fonts/*.woff2 | tail -1
```

The total must be **≤ 358400 bytes** (350 KB). All three families are open-licensed (OFL); no attribution file is required in the bundle.

**If this machine has no network access, stop and say so plainly** rather than committing zero-byte files or quietly skipping the step. Step 4's test exists so that a missing or truncated file fails loudly instead of the app silently rendering in Georgia forever.

- [ ] **Step 2: Add the two token layers to `src/index.css`**

Insert **above** the existing dark `@theme` block. That block and the `body` rule below it stay for now and are deleted in Task 6 — this commit changes nothing visually.

```css
@import "tailwindcss";

/* ── Layer 1 · palette ────────────────────────────────────────────────────
   Plain custom properties, deliberately NOT inside @theme, so Tailwind
   generates no utilities for them. `bg-oxblood` is not a class anyone can
   type, because the raw colour never enters the --color-* namespace
   (R-G2). Application code may not reference a --lex-* name; the semantic
   -role guard in src/test/palette.test.ts fails on one outside this file. */
:root {
  --lex-canvas: #e5e2db;  --lex-paper: #f6f3ed;  --lex-card: #fffefb;
  --lex-gutter: #e8e4dc;  --lex-page: #ffffff;

  --lex-ink-1: #1a1815;  --lex-ink-prose: #26231e;  --lex-ink-quote: #3a352e;
  --lex-ink-2: #57524a;  --lex-ink-3: #6b665c;      --lex-ink-4: #8a847a;
  --lex-ink-5: #a8a29a;  --lex-ink-6: #c9c3b8;

  --lex-teal: #14574f;   --lex-oxblood: #8c2f24;  --lex-amber: #8a6414;
  --lex-green: #2c6448;  --lex-blue: #3d5a80;

  /* Channel triplets, so a tint or an edge is one rgb(… / a) away from the
     hue it belongs to and cannot drift from it by hand-mixing. */
  --lex-ink-rgb: 26 24 21;
  --lex-teal-rgb: 20 87 79;
  --lex-oxblood-rgb: 140 47 36;
  --lex-amber-rgb: 138 100 20;
  --lex-green-rgb: 44 100 72;
  --lex-blue-rgb: 61 90 128;
  --lex-highlight-rgb: 255 222 89;
  --lex-highlight-edge-rgb: 198 150 20;
}

/* ── Layer 2 · roles ──────────────────────────────────────────────────────
   The only names application code may use. Each answers a question about
   meaning, never about appearance. */
@theme {
  /* Surfaces */
  --color-canvas:     var(--lex-canvas);
  --color-paper:      var(--lex-paper);
  --color-card:       var(--lex-card);
  --color-doc-gutter: var(--lex-gutter);
  --color-page:       var(--lex-page);

  /* Ink. ink-4 and below are decorative-grade contrast on paper: no failure
     state, disclosure or warning may use them (R-G19). */
  --color-ink-1:     var(--lex-ink-1);
  --color-ink-prose: var(--lex-ink-prose);
  --color-ink-quote: var(--lex-ink-quote);
  --color-ink-2:     var(--lex-ink-2);
  --color-ink-3:     var(--lex-ink-3);
  --color-ink-4:     var(--lex-ink-4);
  --color-ink-5:     var(--lex-ink-5);
  --color-ink-6:     var(--lex-ink-6);

  /* Rules and neutral fills */
  --color-rule-soft:   rgb(var(--lex-ink-rgb) / 0.09);
  --color-rule:        rgb(var(--lex-ink-rgb) / 0.12);
  --color-rule-strong: rgb(var(--lex-ink-rgb) / 0.18);
  --color-chip-fill:   rgb(var(--lex-ink-rgb) / 0.06);

  /* Action and human confirmation. Teal means a person did something. */
  --color-accent:        var(--lex-teal);
  --color-accent-tint:   rgb(var(--lex-teal-rgb) / 0.09);
  --color-accent-edge:   rgb(var(--lex-teal-rgb) / 0.24);
  --color-accent-strong: var(--lex-teal);

  /* Risk — a model judgement */
  --color-risk-high:      var(--lex-oxblood);
  --color-risk-high-tint: rgb(var(--lex-oxblood-rgb) / 0.06);
  --color-risk-high-edge: rgb(var(--lex-oxblood-rgb) / 0.22);
  --color-risk-med:       var(--lex-amber);
  --color-risk-med-tint:  rgb(var(--lex-amber-rgb) / 0.09);
  --color-risk-med-edge:  rgb(var(--lex-amber-rgb) / 0.22);
  --color-risk-low:       var(--lex-green);
  --color-risk-low-tint:  rgb(var(--lex-green-rgb) / 0.10);

  /* Verification — a human judgement. verified is TEAL, not the green of
     low risk (R-G4). */
  --color-state-verified:  var(--lex-teal);
  --color-state-flagged:   var(--lex-amber);
  --color-state-rejected:  var(--lex-oxblood);
  --color-state-unchecked: var(--lex-ink-4);

  /* Standard-position outcome — a model judgement */
  --color-outcome-meets:    var(--lex-green);
  --color-outcome-deviates: var(--lex-oxblood);
  --color-outcome-unclear:  var(--lex-amber);

  /* Position health — derived from VERIFIED findings only, which is why
     held is teal rather than green. */
  --color-health-held:      var(--lex-teal);
  --color-health-conceded:  var(--lex-amber);
  --color-health-untested:  var(--lex-ink-4);
  --color-health-none:      var(--lex-ink-5);

  /* Net position */
  --color-net-unconfirmed: var(--lex-amber);
  --color-net-confirmed:   var(--lex-teal);
  --color-net-amended:     var(--lex-teal);

  /* Draft / suggested / informational */
  --color-draft:      var(--lex-blue);
  --color-draft-tint: rgb(var(--lex-blue-rgb) / 0.11);

  /* Document */
  --color-highlight-fill: rgb(var(--lex-highlight-rgb) / 0.34);
  --color-highlight-edge: rgb(var(--lex-highlight-edge-rgb) / 0.75);
  --color-redline-ins:    var(--lex-teal);
  --color-redline-del:    var(--lex-oxblood);

  /* Families. Real fallback stacks: with the woff2 files blocked every
     screen must stay readable and un-reflowed (R-G3, §13.5 item 1). */
  --font-prose: "Newsreader", ui-serif, Georgia, "Times New Roman", serif;
  --font-ui:    "Instrument Sans", ui-sans-serif, system-ui, sans-serif;
  --font-mono:  "IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, monospace;

  /* Type scale as named roles, not raw sizes */
  --text-matter-title: 30px;   --text-matter-title--line-height: 1.1;
  --text-matter-title--letter-spacing: -0.015em;
  --text-screen-title: 26px;   --text-screen-title--line-height: 1.15;
  --text-section:      17px;   --text-section--line-height: 1.3;
  --text-clause:       18px;   --text-clause--line-height: 1.2;
  --text-finding:      15.5px; --text-finding--line-height: 1.62;
  --text-quote:        13.5px; --text-quote--line-height: 1.6;
  --text-field:        13.5px; --text-field--line-height: 1.6;
  --text-ui:           13.5px; --text-ui--line-height: 1.5;
  --text-ui-sm:        12px;   --text-ui-sm--line-height: 1.5;
  --text-button:       12px;   --text-button--line-height: 1;
  --text-meta:         11.5px; --text-meta--line-height: 1.45;
  --text-label:        9.5px;  --text-label--line-height: 1.2;
  --text-label--letter-spacing: 0.13em;
  --text-chip:         9.5px;  --text-chip--line-height: 1.2;
  --text-chip--letter-spacing: 0.07em;
  --text-pin:          10.5px; --text-pin--line-height: 1.3;
  --text-figure:       30px;   --text-figure--line-height: 1;

  /* Radii, named by what they wrap */
  --radius-chip:    3px;
  --radius-inset:   5px;
  --radius-control: 6px;
  --radius-card:    7px;
  --radius-panel:   8px;
  --radius-meter:   9999px;

  /* The only two shadows in the system. No shadow on a card, ever. */
  --shadow-tab:  0 1px 2px rgb(0 0 0 / 0.07);
  --shadow-page: 0 4px 18px rgb(0 0 0 / 0.14);
}

@font-face {
  font-family: "Newsreader";
  src: url("/fonts/newsreader-latin-var.woff2") format("woff2");
  font-weight: 300 600;
  font-style: normal;
  font-display: swap;
}
@font-face {
  font-family: "Newsreader";
  src: url("/fonts/newsreader-latin-var-italic.woff2") format("woff2");
  font-weight: 300 600;
  font-style: italic;
  font-display: swap;
}
@font-face {
  font-family: "Instrument Sans";
  src: url("/fonts/instrument-sans-latin-var.woff2") format("woff2");
  font-weight: 400 700;
  font-style: normal;
  font-display: swap;
}
@font-face {
  font-family: "IBM Plex Mono";
  src: url("/fonts/ibm-plex-mono-latin-400.woff2") format("woff2");
  font-weight: 400; font-style: normal; font-display: swap;
}
@font-face {
  font-family: "IBM Plex Mono";
  src: url("/fonts/ibm-plex-mono-latin-500.woff2") format("woff2");
  font-weight: 500; font-style: normal; font-display: swap;
}
@font-face {
  font-family: "IBM Plex Mono";
  src: url("/fonts/ibm-plex-mono-latin-600.woff2") format("woff2");
  font-weight: 600; font-style: normal; font-display: swap;
}

/* The one looping animation in the system: the extracting pulse. Under
   reduced motion it becomes a static tinted bar — and the WORD next to it
   stays, which is the half that matters (R-G20, §8.6). */
@keyframes lex-pulse {
  0%, 100% { opacity: 1; }
  50%      { opacity: 0.45; }
}
.lex-pulse {
  animation: lex-pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite;
}
@media (prefers-reduced-motion: reduce) {
  .lex-pulse { animation: none; }
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
}
```

- [ ] **Step 3: Write the failing font test**

Create `src/test/fonts.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync, statSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '../..');
const CSS = readFileSync(resolve(ROOT, 'src/index.css'), 'utf8');

/** Every `src: url("/fonts/…")` declared in index.css. */
function declaredFontUrls(): string[] {
  return [...CSS.matchAll(/url\("(\/fonts\/[^"]+)"\)/g)].map(m => m[1]);
}

describe('self-hosted fonts (R-G3)', () => {
  it('declares six font files', () => {
    expect(declaredFontUrls()).toHaveLength(6);
  });

  it('every declared font file exists and is not empty', () => {
    for (const url of declaredFontUrls()) {
      const path = resolve(ROOT, 'public', url.replace(/^\//, ''));
      // A missing or truncated font is why this test exists: font-display
      // swap means the app would silently render in Georgia forever with
      // nothing on screen to say the design never loaded.
      expect(() => statSync(path), `${url} is declared in index.css but not present`).not.toThrow();
      expect(statSync(path).size, `${url} is empty`).toBeGreaterThan(1000);
    }
  });

  it('the whole font payload stays inside the 350 KB budget', () => {
    const dir = resolve(ROOT, 'public/fonts');
    const total = readdirSync(dir)
      .filter(f => f.endsWith('.woff2'))
      .reduce((sum, f) => sum + statSync(resolve(dir, f)).size, 0);
    expect(total).toBeLessThanOrEqual(350 * 1024);
  });

  it('no font is hotlinked from a third-party host, anywhere', () => {
    // The app's own disclosure says nothing leaves this browser except
    // calls to OpenRouter. A <link> to fonts.googleapis.com would make that
    // sentence false on every page view.
    const suspects = [
      readFileSync(resolve(ROOT, 'index.html'), 'utf8'),
      CSS,
    ];
    for (const source of suspects) {
      expect(source).not.toMatch(/fonts\.googleapis\.com|fonts\.gstatic\.com/);
    }
  });

  it('every family declares a real fallback stack', () => {
    expect(CSS).toMatch(/--font-prose:\s*"Newsreader",\s*ui-serif,\s*Georgia/);
    expect(CSS).toMatch(/--font-ui:\s*"Instrument Sans",\s*ui-sans-serif,\s*system-ui/);
    expect(CSS).toMatch(/--font-mono:\s*"IBM Plex Mono",\s*ui-monospace/);
  });
});
```

- [ ] **Step 4: Run the font test**

Run: `npx vitest run src/test/fonts.test.ts`
Expected: PASS, all five. If "declared in index.css but not present" fails, Step 1 did not complete — fix it rather than relaxing the test.

- [ ] **Step 5: Mutation-test the font guard**

Rename one file (`mv public/fonts/ibm-plex-mono-latin-600.woff2 /tmp/x.woff2`), re-run the test, confirm the "exists and is not empty" case fails naming that exact file, then restore it. Then temporarily add `<link href="https://fonts.googleapis.com/css2?family=Newsreader" rel="stylesheet">` to `index.html`, confirm the hotlink test fails, and remove it.

- [ ] **Step 6: Confirm nothing changed visually**

Run: `npm test && npx tsc --noEmit && npm run build`
Expected: the full suite passes with no test edited (the old dark `@theme` is still in place and still wins for `--color-card`, which is redeclared in the new block — Tailwind takes the last declaration, so `card` is now `#fffefb`; nothing in the app consumes `bg-card` yet, so no screen changes). Build clean, no externalization warning.

- [ ] **Step 7: Commit**

```bash
git add src/index.css src/test/fonts.test.ts public/fonts
git commit -F .git/COMMIT_G1
```

Write the message to `.git/COMMIT_G1` first, with the Write tool:

```
feat(g): add the two-layer token set and self-hosted fonts

Layer 1 is plain :root custom properties that Tailwind generates no
utilities for; layer 2 is the semantic @theme block that generates every
class application code may type. A component that wants oxblood has to
decide what oxblood means here first (R-G2).

Six latin-subset woff2 files vendored under public/fonts, declared with
font-display: swap and real fallback stacks. Never hotlinked: the app's own
disclosure says nothing leaves this browser except calls to OpenRouter, and
a Google Fonts link would make that sentence false on every page view
(R-G3).

Additive. The old dark @theme block is still in place, so nothing changes
visually in this commit.
```

---

## Task 2: The palette guard and the semantic-role guard

**Kind:** test infrastructure. No application file changes.

Written now, failing against today's ~100 raw palette utilities, so the target is defined before the work rather than asserted after it. The repo-wide assertions are `it.skip`ped **with an explicit reason naming Task 14**, which un-skips them. The scanner itself is pure and is fully tested and green in this commit — a skipped test that guards nothing until Task 14 would leave this task with no deliverable.

**Files:**
- Create: `src/test/paletteScan.ts`
- Create: `src/test/palette.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `export interface ColourViolation { file: string; line: number; rule: string; text: string }`
  - `export function scanSource(file: string, source: string): ColourViolation[]`
  - `export function collectScannableFiles(root: string): string[]`
  - `export const SCAN_EXEMPT: readonly string[]` — the exemption list, so a later reader can see it is three entries and why.

- [ ] **Step 1: Write the scanner's failing tests**

Create `src/test/palette.test.ts`. This first half runs green as soon as Step 2 exists:

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { scanSource, collectScannableFiles } from './paletteScan';

const SRC = resolve(__dirname, '..');

describe('paletteScan — what counts as a raw colour', () => {
  it('flags a hex literal in a className', () => {
    const v = scanSource('x.tsx', `<div className="bg-[#1a1a1a] p-4" />`);
    expect(v).toHaveLength(1);
    expect(v[0].rule).toBe('arbitrary-colour');
    expect(v[0].line).toBe(1);
  });

  it('flags a bare hex literal in a style object', () => {
    const v = scanSource('x.tsx', `style={{ backgroundColor: '#8c2f24' }}`);
    expect(v.map(r => r.rule)).toContain('hex-literal');
  });

  it('flags an rgb()/rgba() literal', () => {
    const v = scanSource('x.tsx', `const ring = 'shadow-[inset_0_0_0_2px_rgba(139,92,246,0.6)]';`);
    expect(v.map(r => r.rule)).toContain('arbitrary-colour');
  });

  it('flags a generic Tailwind palette class', () => {
    const v = scanSource('x.tsx', `className="text-emerald-300 border-violet-500/20"`);
    expect(v.map(r => r.rule)).toEqual(['tailwind-palette', 'tailwind-palette']);
  });

  it('flags bg-white/5, text-white and border-white/10', () => {
    const v = scanSource('x.tsx', `className="bg-white/5 text-white border-white/10 text-black"`);
    expect(v).toHaveLength(4);
    expect(new Set(v.map(r => r.rule))).toEqual(new Set(['tailwind-palette']));
  });

  it('flags a palette-layer variable used outside index.css', () => {
    const v = scanSource('x.tsx', `style={{ color: 'var(--lex-teal)' }}`);
    expect(v.map(r => r.rule)).toContain('palette-layer-leak');
  });

  it('does NOT flag a semantic role class', () => {
    expect(scanSource('x.tsx', `className="bg-risk-high-tint text-risk-high border-risk-high-edge"`)).toEqual([]);
  });

  it('does NOT flag a semantic role variable', () => {
    expect(scanSource('x.tsx', `style={{ color: 'var(--color-accent)' }}`)).toEqual([]);
  });

  it('does NOT flag a non-colour arbitrary value or a non-colour utility', () => {
    expect(scanSource('x.tsx', `className="w-[258px] max-w-[70ch] grid-cols-[1.35fr_1fr_1fr] p-3 gap-1.5"`)).toEqual([]);
  });

  it('does NOT flag a hex-looking string that is not a colour', () => {
    // Six hex digits behind a `#` in prose or an id are not styling. The
    // rule is anchored to a colour position: a quoted value, a style
    // property, or a Tailwind arbitrary value.
    expect(scanSource('x.tsx', `// see commit #abc123 for why`)).toEqual([]);
  });

  it('reports the file and the 1-based line of each violation', () => {
    const v = scanSource('src/features/x.tsx', `line one\nclassName="text-violet-400"\nline three`);
    expect(v[0]).toMatchObject({ file: 'src/features/x.tsx', line: 2 });
  });
});

describe('collectScannableFiles', () => {
  it('includes application source and excludes tests, the harness and the exemptions', () => {
    const files = collectScannableFiles(SRC);
    expect(files).toContain('features/review/FindingCard.tsx');
    expect(files.some(f => f.endsWith('.test.tsx'))).toBe(false);
    expect(files.some(f => f.endsWith('.test.ts'))).toBe(false);
    expect(files.some(f => f.startsWith('test/'))).toBe(false);
    expect(files).not.toContain('features/review/PdfCanvas.tsx');
    expect(files.some(f => f.endsWith('.css'))).toBe(false);
  });
});

// ── The repo-wide guards. Un-skipped by Task 14, once every screen has
// been restyled. Skipped (not deleted, not weakened) until then because
// today's ~100 raw palette utilities are the work this sub-project exists
// to remove: a guard that passes today would be a guard that asserts
// nothing.
describe.skip('palette guard — SKIPPED UNTIL TASK 14 un-skips it', () => {
  it('no application source references a raw colour', () => {
    const violations = collectScannableFiles(SRC)
      .flatMap(rel => scanSource(rel, readFileSync(resolve(SRC, rel), 'utf8')));
    expect(
      violations.map(v => `${v.file}:${v.line} [${v.rule}] ${v.text}`).join('\n'),
    ).toBe('');
  });
});
```

- [ ] **Step 2: Run the tests to watch them fail**

Run: `npx vitest run src/test/palette.test.ts`
Expected: FAIL — `Failed to resolve import "./paletteScan"`.

- [ ] **Step 3: Write the scanner**

Create `src/test/paletteScan.ts`:

```ts
import { readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

export interface ColourViolation {
  /** Path as handed to `scanSource`. */
  file: string;
  /** 1-based. */
  line: number;
  /** `hex-literal` | `arbitrary-colour` | `tailwind-palette` | `palette-layer-leak` */
  rule: string;
  /** The offending text, for a message that points at something. */
  text: string;
}

/**
 * Files the scan does not read, and why each one is exempt.
 *
 * `index.css` is where the tokens are DEFINED — the palette layer lives
 * there by design. `PdfCanvas.tsx` is exempt by spec §13.4 because canvas
 * draw calls are not styling; its highlight overlay divs are nevertheless
 * moved onto the highlight tokens by Task 9 (R-GP1), so the exemption
 * covers only what it is meant to. `test/` holds this scanner and the token
 * reader, both of which contain colour patterns as DATA.
 */
export const SCAN_EXEMPT: readonly string[] = [
  'index.css',
  'features/review/PdfCanvas.tsx',
];

const TAILWIND_HUES =
  'slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose';
const COLOUR_PROPS =
  'bg|text|border|from|to|via|ring|divide|outline|decoration|shadow|fill|stroke|accent|caret|placeholder';

const RULES: { rule: string; re: RegExp }[] = [
  // A Tailwind arbitrary value whose contents are a colour: bg-[#fff],
  // text-[rgb(…)], shadow-[inset_0_0_0_2px_rgba(…)].
  { rule: 'arbitrary-colour', re: new RegExp(`\\b(?:${COLOUR_PROPS})-\\[[^\\]]*(?:#[0-9a-fA-F]{3,8}|rgba?\\()[^\\]]*\\]`, 'g') },
  // A hex literal in a quoted string or a style property value.
  { rule: 'hex-literal', re: /(?:['"`]|:\s*)#[0-9a-fA-F]{3,8}\b/g },
  // A bare rgb()/rgba() outside an arbitrary value (an inline style).
  { rule: 'hex-literal', re: /(?:['"`]|:\s*)rgba?\([^)]*\)/g },
  // A generic Tailwind palette class, with or without an opacity suffix.
  { rule: 'tailwind-palette', re: new RegExp(`\\b(?:${COLOUR_PROPS})-(?:(?:${TAILWIND_HUES})-\\d{2,3}|white|black)(?:/\\d{1,3})?\\b`, 'g') },
  // The palette layer, reached from outside index.css.
  { rule: 'palette-layer-leak', re: /--lex-[a-z0-9-]+/g },
];

/** Pure: one file's text in, its violations out. No IO, so it is trivially
 *  unit-testable and the repo-wide guard is just a loop over it. */
export function scanSource(file: string, source: string): ColourViolation[] {
  const out: ColourViolation[] = [];
  const lines = source.split('\n');
  lines.forEach((text, i) => {
    for (const { rule, re } of RULES) {
      re.lastIndex = 0;
      for (const match of text.matchAll(re)) {
        out.push({ file, line: i + 1, rule, text: match[0].trim() });
      }
    }
  });
  // Stable order: by line, then by the order RULES declares.
  return out.sort((a, b) => a.line - b.line);
}

/** Every application `.ts`/`.tsx` under `root`, as paths relative to it
 *  with forward slashes. Tests, the test harness and `SCAN_EXEMPT` are
 *  excluded. */
export function collectScannableFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) { walk(full); continue; }
      const rel = relative(root, full).split(sep).join('/');
      if (!/\.tsx?$/.test(rel)) continue;
      if (/\.test\.tsx?$/.test(rel)) continue;
      if (rel.startsWith('test/')) continue;
      if (SCAN_EXEMPT.includes(rel)) continue;
      out.push(rel);
    }
  };
  walk(root);
  return out.sort();
}
```

- [ ] **Step 4: Run the tests to watch them pass**

Run: `npx vitest run src/test/palette.test.ts`
Expected: PASS for every unskipped case; the repo-wide guard reported as skipped.

- [ ] **Step 5: Prove the skipped guard would actually fire**

Temporarily change `describe.skip` to `describe` and run again. Expected: FAIL, with a multi-line list naming real files (`features/review/FindingCard.tsx:128 [tailwind-palette] text-violet-400`, and so on) — this is the work Tasks 5–13 remove. Restore the `.skip`. **Record the violation count in the commit message**; Task 14 checks it has reached zero.

- [ ] **Step 6: Mutation-test the scanner**

Change `TAILWIND_HUES` to drop `violet`, re-run `npx vitest run src/test/palette.test.ts`, and confirm the "flags a generic Tailwind palette class" case fails. Restore. Then delete `'features/review/PdfCanvas.tsx'` from `SCAN_EXEMPT`, confirm the `collectScannableFiles` exemption case fails, and restore.

- [ ] **Step 7: Full gates and commit**

Run: `npm test && npx tsc --noEmit && npm run build`

```bash
git add src/test/paletteScan.ts src/test/palette.test.ts
git commit -F .git/COMMIT_G2
```

Message (write with the Write tool first):

```
test(g): add the palette and semantic-role guards, skipped until task 14

scanSource is pure and fully covered now: hex literals, Tailwind arbitrary
colours, generic palette classes, and any --lex-* palette variable reached
from outside index.css. The repo-wide sweep that uses it is skipped with an
explicit reason, because today it reports N violations across M files — the
work tasks 5 to 13 exist to remove. Writing the target before the work,
rather than asserting it afterwards.
```

(Replace `N` and `M` with the counts Step 5 printed.)

---

## Task 3: The three presentational-class test conversions, and the busy-state contract

**Kind:** declared test change. This is the **only** task before Task 14 permitted to modify a test file, and it exists so that "a test edit inside a restyle commit is the finding" holds cleanly for every task after it.

Three assertions couple to a presentational class. Each is converted to a semantic hook **before** the component it covers is restyled.

| Test | Today's selector | Replacement |
| --- | --- | --- |
| `src/App.rerunResets.test.tsx:998` | `.animate-spin` | `[data-busy="true"]` on the busy card (R-GP2), plus the visible word |
| `src/features/tabular/TabularReview.test.tsx:97` | `.truncate` | `[data-testid="cell-summary"]` holding the whole summary |
| `src/features/templates/TemplateEditor.test.tsx:124` | `.closest('.group')` | `.closest('[data-clause-row]')` |

**Files:**
- Modify: `src/features/review/FindingCard.tsx:105-147` (the `pending` and `running` branches)
- Modify: `src/features/tabular/TabularReview.tsx:379-381` (the cell summary div)
- Modify: `src/features/templates/TemplateEditor.tsx:312-322` (the clause row wrapper)
- Modify: `src/App.rerunResets.test.tsx` (the assertion at line 998)
- Modify: `src/features/tabular/TabularReview.test.tsx` (the assertion at line 97)
- Modify: `src/features/templates/TemplateEditor.test.tsx` (the row lookup at line 124)

**Interfaces:**
- Consumes: nothing from Tasks 1–2.
- Produces, and every later task depends on these exact names:
  - Any element representing work in flight carries `data-busy="true"` and `aria-live="polite"`, and carries a **visible word** describing the work (`Extracting…`). It does **not** carry `role="status"` (R-GP2).
  - `TabularReview`'s cell summary element carries `data-testid="cell-summary"`.
  - `TemplateEditor`'s clause row wrapper carries the boolean attribute `data-clause-row`.

- [ ] **Step 1: Add the busy contract to `FindingCard`'s running branch**

`src/features/review/FindingCard.tsx:123-134` becomes (the `interrupted` block below it at 135-144 is unchanged):

```tsx
  if (status === 'running') {
    return (
      <div className={`${CARD_SHELL} border-white/5`}>
        <div
          className="p-3 border-b border-white/5 flex justify-between items-center bg-white/5 rounded-t-xl"
          data-busy="true"
          aria-live="polite"
        >
          <span className="font-semibold text-sm text-white">{clause.title}</span>
          {/* R-G20: a busy state whose only signal is an animation is
              invisible to a reader who turned animation off, and a stalled
              cell that looks blank rather than busy is the "cell spinning
              forever, unfinishable" defect in a different disguise. The word
              is the part that survives `prefers-reduced-motion`. */}
          <span className="text-[11px] text-gray-400 flex items-center gap-1.5">
            <Loader className="w-3.5 h-3.5 text-violet-400 animate-spin" aria-hidden="true" />
            Extracting…
          </span>
        </div>
        <div className="p-4 space-y-2">
          <div className="h-2.5 bg-white/10 rounded w-full animate-pulse" />
          <div className="h-2.5 bg-white/10 rounded w-5/6 animate-pulse" />
          <div className="h-2.5 bg-white/10 rounded w-2/3 animate-pulse" />
        </div>
```

The old palette classes stay for now — Task 8 restyles this component; this commit changes only the contract.

- [ ] **Step 2: Convert the `.animate-spin` assertion**

In `src/App.rerunResets.test.tsx`, replace line 998:

```ts
    expect(container.querySelectorAll('.animate-spin').length).toBeGreaterThan(0);
```

with:

```ts
    // The busy contract, not a styling class: `data-busy` survives the
    // reskin, and the word survives `prefers-reduced-motion` (R-G20/R-GP2).
    expect(container.querySelectorAll('[data-busy="true"]').length).toBeGreaterThan(0);
    expect(container.textContent).toContain('Extracting…');
```

- [ ] **Step 3: Run the converted test and mutation-test it**

Run: `npx vitest run src/App.rerunResets.test.tsx`
Expected: PASS.
Now delete `data-busy="true"` from `FindingCard.tsx` and re-run: expected FAIL on the `[data-busy="true"]` assertion. Restore it. Then delete the `Extracting…` text node and re-run: expected FAIL on the `toContain`. Restore.

- [ ] **Step 4: Add `data-testid="cell-summary"` to the grid cell**

`src/features/tabular/TabularReview.tsx:379-381` becomes:

```tsx
            <div
              data-testid="cell-summary"
              className={`${wrapText ? 'whitespace-normal' : 'line-clamp-3'} text-gray-300 min-w-0`}
            >
              {finding?.summary || <span className="text-gray-600 italic">Empty</span>}
            </div>
```

- [ ] **Step 5: Convert the `.truncate` assertion**

In `src/features/tabular/TabularReview.test.tsx`, the body of "the full summary text is present, and the cell does not use single-line truncation" becomes:

```ts
    const summary = 'The notice period is six months from the date of service, running from delivery.';
    const run = makeRun({ d1: { c1: doneFinding({ summary }) } });
    const container = mount(<TabularReview run={run} documents={[makeDoc('d1')]} onRetryCell={() => {}} />);
    expect(container.textContent).toContain(summary);
    const cell = Array.from(container.querySelectorAll('td')).find(td => td.textContent?.includes(summary));
    // The claim is about the cell's CONTENT, not its class: the whole
    // sentence is in the DOM, in the cell, in one element — a grid that
    // cuts a finding off mid-word is a grid that hides the finding.
    const summaryEl = cell?.querySelector('[data-testid="cell-summary"]');
    expect(summaryEl).toBeTruthy();
    expect(summaryEl?.textContent).toBe(summary);
```

- [ ] **Step 6: Run it and mutation-test it**

Run: `npx vitest run src/features/tabular/TabularReview.test.tsx`
Expected: PASS.
Now change the component to render `{finding?.summary?.slice(0, 20) || …}` and re-run: expected FAIL on `toBe(summary)`. Restore.

- [ ] **Step 7: Add `data-clause-row` to the editor's clause row**

`src/features/templates/TemplateEditor.tsx:312-322` gains one attribute:

```tsx
                <div
                  key={clause.id}
                  data-clause-row
                  onDragOver={(e) => { if (dragIndex !== null) e.preventDefault(); }}
                  onDrop={(e) => {
                    if (dragIndex === null) return;
                    e.preventDefault();
                    reorderClause(dragIndex, idx);
                    setDragIndex(null);
                  }}
                  className={`group relative p-0.5 rounded-xl bg-gradient-to-r transition-all duration-300 ${dragIndex === idx ? 'from-violet-500/40 to-violet-500/20' : 'from-white/5 to-white/10'}`}
                >
```

- [ ] **Step 8: Convert the `.closest('.group')` lookup**

In `src/features/templates/TemplateEditor.test.tsx`, line 124 becomes:

```ts
    const rows = [...c.querySelectorAll('[draggable="true"]')].map(h => h.closest('[data-clause-row]')!);
```

- [ ] **Step 9: Run it and mutation-test it**

Run: `npx vitest run src/features/templates/TemplateEditor.test.tsx`
Expected: PASS (the drag test still reorders `['c2','c3','c1']`).
Now remove `data-clause-row` from the component and re-run: expected FAIL — `h.closest(...)` returns `null` and the `drop` dispatch throws. Restore.

- [ ] **Step 10: Confirm no other test was disturbed**

Run: `npm test && npx tsc --noEmit && npm run build`
Expected: full suite green. In particular confirm the eight positional `chips()[0]` assertions in `src/App.verification.test.tsx` and the five in `src/App.rerunResets.test.tsx` still pass — they would not have, had the busy element been given `role="status"`, which is precisely why R-GP2 rules it out.

- [ ] **Step 11: Commit**

```bash
git add src/features/review/FindingCard.tsx src/features/tabular/TabularReview.tsx src/features/templates/TemplateEditor.tsx src/App.rerunResets.test.tsx src/features/tabular/TabularReview.test.tsx src/features/templates/TemplateEditor.test.tsx
git commit -F .git/COMMIT_G3
```

Message:

```
test(g): convert the three presentational-class couplings to semantic hooks

The suite has 461 textContent selectors and zero class-as-style assertions;
exactly three tests read a presentational class, and they are converted here
so that from the next commit onward, a test edit inside a restyle IS the
finding rather than a chore.

- animate-spin becomes [data-busy="true"] plus the visible word. Busy
  elements take aria-live="polite", NOT role="status": that selector is
  already how thirteen assertions find a StateChip positionally, and one of
  them reads chips()[0] while a card is busy (R-GP2).
- .truncate becomes [data-testid="cell-summary"], asserting the whole
  sentence is in one element rather than asserting a class is absent.
- .closest('.group') becomes .closest('[data-clause-row]').

FindingCard's running branch gains a visible "Extracting…" label: with
prefers-reduced-motion on it was a dimmed card with grey bars and no word
at all (R-G20, declared under R-GP3).
```

---

## Task 4: The contrast test over the token table

**Kind:** test infrastructure. No application file changes.

The single most likely regression in a palette this deliberately soft is a role slipping below legibility. This is pure arithmetic over `src/index.css`, needs no browser, and asserts **every** pair the design system defines — at the tier that pair's role assigns (R-GP4).

**Files:**
- Create: `src/test/tokens.ts`
- Create: `src/test/contrast.test.ts`

**Interfaces:**
- Consumes: Task 1's `src/index.css` token layers.
- Produces:
  - `export interface TokenTable { palette: Record<string, string>; roles: Record<string, string> }`
  - `export function readTokens(cssPath: string): TokenTable`
  - `export function resolveColour(name: string, tokens: TokenTable): { r: number; g: number; b: number; a: number }`
  - `export function composite(fg: {r,g,b,a}, bg: {r,g,b,a}): {r,g,b,a}`
  - `export function contrastRatio(fg: string, bg: string, tokens: TokenTable): number`

- [ ] **Step 1: Write the failing contrast tests**

Create `src/test/contrast.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { readTokens, contrastRatio } from './tokens';

const tokens = readTokens(resolve(__dirname, '../index.css'));

/** Tier thresholds. `body` is WCAG AA for normal text; `chip` is AA for
 *  large/bold text and is what the 9.5px uppercase mono chips are held to
 *  because they are bold, letter-spaced and short. `decorative` is a
 *  documented FLOOR, not a WCAG grade: ink-5 on paper is ~2.3:1 by design
 *  and is right for a timestamp and wrong for anything a reader must not
 *  miss (R-G19, R-GP4). Asserting it rather than exempting it is what stops
 *  a future palette edit pushing a timestamp to invisible. */
const MIN = { body: 4.5, chip: 3.0, decorative: 2.2 } as const;

type Pair = [fg: string, bg: string, tier: keyof typeof MIN];

const PAIRS: Pair[] = [
  // Primary and prose ink on every surface it is used on.
  ['ink-1', 'paper', 'body'], ['ink-1', 'card', 'body'], ['ink-1', 'page', 'body'],
  ['ink-prose', 'paper', 'body'], ['ink-prose', 'card', 'body'], ['ink-prose', 'page', 'body'],
  ['ink-quote', 'card', 'body'], ['ink-quote', 'paper', 'body'],
  ['ink-2', 'paper', 'body'], ['ink-2', 'card', 'body'],
  ['ink-3', 'paper', 'body'], ['ink-3', 'card', 'body'],
  // Decorative-grade ink. Never used for a warning, a disclosure or a
  // failure — that rule is R-G19 and lives in review, not in arithmetic.
  ['ink-4', 'paper', 'chip'], ['ink-4', 'card', 'chip'],
  ['ink-5', 'paper', 'decorative'], ['ink-5', 'card', 'decorative'],
  ['ink-6', 'card', 'decorative'],
  // Action and human confirmation.
  ['accent', 'paper', 'body'], ['accent', 'card', 'body'], ['accent', 'accent-tint', 'chip'],
  // Risk, on the surfaces and washes each is used on.
  ['risk-high', 'paper', 'body'], ['risk-high', 'card', 'body'], ['risk-high', 'risk-high-tint', 'chip'],
  ['risk-med', 'paper', 'body'], ['risk-med', 'card', 'body'], ['risk-med', 'risk-med-tint', 'chip'],
  ['risk-low', 'paper', 'body'], ['risk-low', 'card', 'body'], ['risk-low', 'risk-low-tint', 'chip'],
  // Verification chips, each on the fill it sits in.
  ['state-verified', 'accent-tint', 'chip'],
  ['state-flagged', 'risk-med-tint', 'chip'],
  ['state-rejected', 'risk-high-tint', 'chip'],
  ['state-unchecked', 'chip-fill', 'chip'],
  // Position outcome chips sit on a transparent fill over card.
  ['outcome-meets', 'card', 'chip'],
  ['outcome-deviates', 'card', 'chip'],
  ['outcome-unclear', 'card', 'chip'],
  // Position health.
  ['health-held', 'card', 'chip'], ['health-conceded', 'card', 'chip'],
  ['health-untested', 'card', 'chip'], ['health-none', 'card', 'decorative'],
  // Net position.
  ['net-unconfirmed', 'card', 'body'], ['net-confirmed', 'card', 'body'],
  // Draft / suggested.
  ['draft', 'card', 'body'], ['draft', 'draft-tint', 'chip'],
  // Primary button: white text on the accent fill.
  ['page', 'accent', 'body'],
];

describe('token contrast', () => {
  for (const [fg, bg, tier] of PAIRS) {
    it(`${fg} on ${bg} clears the ${tier} floor (${MIN[tier]}:1)`, () => {
      const ratio = contrastRatio(fg, bg, tokens);
      expect(
        Number(ratio.toFixed(2)),
        `${fg} on ${bg} is ${ratio.toFixed(2)}:1`,
      ).toBeGreaterThanOrEqual(MIN[tier]);
    });
  }

  it('every semantic role in index.css is either exercised above or explicitly surface-only', () => {
    // A role nobody checks is a role that can drift. Surfaces, rules,
    // edges and the two highlight colours are not text pairs; everything
    // else must appear as a foreground somewhere in PAIRS.
    const SURFACE_ONLY = new Set([
      'canvas', 'paper', 'card', 'doc-gutter',
      'rule-soft', 'rule', 'rule-strong', 'chip-fill',
      'accent-tint', 'accent-edge', 'accent-strong',
      'risk-high-tint', 'risk-high-edge', 'risk-med-tint', 'risk-med-edge', 'risk-low-tint',
      'draft-tint', 'highlight-fill', 'highlight-edge',
      'redline-ins', 'redline-del', 'net-amended',
    ]);
    const exercised = new Set(PAIRS.map(([fg]) => fg));
    const missing = Object.keys(tokens.roles)
      .filter(name => !SURFACE_ONLY.has(name) && !exercised.has(name));
    expect(missing).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it to watch it fail**

Run: `npx vitest run src/test/contrast.test.ts`
Expected: FAIL — `Failed to resolve import "./tokens"`.

- [ ] **Step 3: Write the token reader and the contrast arithmetic**

Create `src/test/tokens.ts`:

```ts
import { readFileSync } from 'node:fs';

export interface TokenTable {
  /** `--lex-*` names, without the prefix: `teal`, `ink-1`, `teal-rgb`. */
  palette: Record<string, string>;
  /** `--color-*` names, without the prefix: `accent`, `risk-high-tint`. */
  roles: Record<string, string>;
}

export interface Rgba { r: number; g: number; b: number; a: number }

/** Reads both layers out of index.css. Deliberately a parse of the real
 *  file rather than a duplicated table: a second copy of the palette is
 *  exactly the sibling drift this project keeps paying for. */
export function readTokens(cssPath: string): TokenTable {
  const css = readFileSync(cssPath, 'utf8');
  const palette: Record<string, string> = {};
  const roles: Record<string, string> = {};
  for (const [, name, value] of css.matchAll(/--lex-([a-z0-9-]+)\s*:\s*([^;]+);/g)) {
    palette[name] = value.trim();
  }
  for (const [, name, value] of css.matchAll(/--color-([a-z0-9-]+)\s*:\s*([^;]+);/g)) {
    roles[name] = value.trim();
  }
  return { palette, roles };
}

function parseHex(hex: string): Rgba {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map(c => c + c).join('') : h;
  return {
    r: parseInt(full.slice(0, 2), 16),
    g: parseInt(full.slice(2, 4), 16),
    b: parseInt(full.slice(4, 6), 16),
    a: 1,
  };
}

/** Resolves a role name to concrete channels, following `var()` through the
 *  palette layer and expanding `rgb(<triplet> / <alpha>)`. */
export function resolveColour(name: string, tokens: TokenTable): Rgba {
  let value = tokens.roles[name];
  if (value === undefined) throw new Error(`No --color-${name} in index.css`);

  const rgbFn = value.match(/^rgb\(\s*var\(--lex-([a-z0-9-]+)\)\s*\/\s*([0-9.]+)\s*\)$/);
  if (rgbFn) {
    const triplet = tokens.palette[rgbFn[1]];
    if (triplet === undefined) throw new Error(`No --lex-${rgbFn[1]} in index.css`);
    const [r, g, b] = triplet.split(/\s+/).map(Number);
    return { r, g, b, a: Number(rgbFn[2]) };
  }

  const varRef = value.match(/^var\(--lex-([a-z0-9-]+)\)$/);
  if (varRef) {
    const resolved = tokens.palette[varRef[1]];
    if (resolved === undefined) throw new Error(`No --lex-${varRef[1]} in index.css`);
    value = resolved;
  }
  if (!value.startsWith('#')) throw new Error(`--color-${name} is not a resolvable colour: ${value}`);
  return parseHex(value);
}

/** Source-over compositing, so a tint's real appearance is measured rather
 *  than its nominal channels — a 9% teal wash IS what the eye sees, and
 *  measuring the unblended colour would report a contrast nobody has. */
export function composite(fg: Rgba, bg: Rgba): Rgba {
  return {
    r: Math.round(fg.r * fg.a + bg.r * (1 - fg.a)),
    g: Math.round(fg.g * fg.a + bg.g * (1 - fg.a)),
    b: Math.round(fg.b * fg.a + bg.b * (1 - fg.a)),
    a: 1,
  };
}

function channelLuminance(v: number): number {
  const s = v / 255;
  return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

function relativeLuminance({ r, g, b }: Rgba): number {
  return 0.2126 * channelLuminance(r) + 0.7152 * channelLuminance(g) + 0.0722 * channelLuminance(b);
}

/**
 * WCAG 2.1 contrast ratio between two role tokens.
 *
 * A translucent background is composited over `card` first, because every
 * tint in this system is painted on a card or on paper and `card` is the
 * lighter of the two (so this reports the WORSE of the two ratios for dark
 * ink, which is the honest direction to round in).
 */
export function contrastRatio(fgName: string, bgName: string, tokens: TokenTable): number {
  const card = resolveColour('card', tokens);
  let bg = resolveColour(bgName, tokens);
  if (bg.a < 1) bg = composite(bg, card);
  let fg = resolveColour(fgName, tokens);
  if (fg.a < 1) fg = composite(fg, bg);

  const l1 = relativeLuminance(fg);
  const l2 = relativeLuminance(bg);
  const [light, dark] = l1 > l2 ? [l1, l2] : [l2, l1];
  return (light + 0.05) / (dark + 0.05);
}
```

- [ ] **Step 4: Run it to watch it pass**

Run: `npx vitest run src/test/contrast.test.ts`
Expected: PASS for every pair. If a pair fails, **do not lower the threshold** — either the role assignment in Task 1 is wrong (a body-tier role pointing at a decorative ink), or the pair belongs at a different tier and the reason must be written into the test as a comment. `state-unchecked` on `chip-fill` is the tightest pair in the table at roughly 3.1:1; that is intentional and is why the chip tier exists.

- [ ] **Step 5: Mutation-test the contrast guard**

In `src/index.css`, temporarily change `--color-ink-2` to `var(--lex-ink-5)`. Re-run: expected FAIL on `ink-2 on paper clears the body floor`, with the measured ratio in the message. Restore. Then add a new `--color-experimental: var(--lex-blue);` to the `@theme` block and re-run: expected FAIL on "every semantic role … is either exercised above or explicitly surface-only", naming `experimental`. Remove it.

- [ ] **Step 6: Full gates and commit**

Run: `npm test && npx tsc --noEmit && npm run build`

```bash
git add src/test/tokens.ts src/test/contrast.test.ts
git commit -F .git/COMMIT_G4
```

Message:

```
test(g): assert contrast for every token pair the design system defines

Pure arithmetic over index.css, parsed rather than copied so a second table
cannot drift from the first. Tints are composited over card before the
ratio is taken, because a 9% wash is what the eye actually sees.

Three tiers rather than an exemption list: body 4.5:1, chip and large text
3:1, and a documented decorative floor of 2.2:1 for the timestamp inks that
are ~2.3:1 by design. Exempting them is how a palette drifts to invisible;
asserting the floor means a future edit that crosses it fails here (R-GP4).

A last case fails if index.css grows a role no pair exercises.
```

---

## Task 5: Shared primitives

**Kind:** cosmetic. Restyled first, because every screen depends on them.

Follow the **restyle task template** above. Eight components, all with existing tests, all selected by role and text.

**Files:**
- Modify: `src/components/Button.tsx`, `Modal.tsx`, `Toast.tsx`, `LoadErrorPanel.tsx`, `StateChip.tsx`, `RiskChip.tsx`, `PositionChip.tsx`, `AutoResizeTextarea.tsx`

**Interfaces:**
- Consumes: every role token from Task 1.
- Produces: the restyled primitives every later restyle task composes. **No prop, no export and no DOM role changes.**

**State checklist for this task (§8, and it is not optional):**

- `LoadErrorPanel` keeps **both** variants — `compact` (a section) and full (a screen) — as two visually distinct blocks, and is **not** merged with any empty state. Its retry keeps the visible word `Retry` (every caller's test finds it by text) and it keeps rendering the message when `onRetry` is absent.
- `LoadErrorPanel`'s text is a failure: `risk-high` ink, never `ink-4` or below (R-G19).
- `StateChip` renders in **all four** states including `unchecked` — there is no "no chip" state — keeps `role="status"`, and keeps the rejected-reason `title` (`Rejected: {reason}`).
- `RiskChip` returns `null` for an absent level and keeps all four levels including `Info`.
- `PositionChip` returns `null` for an absent outcome. **No grey pill, no "n/a", no dashed placeholder.**
- The three chips are three shapes (R-G16) — verify by rendering all three side by side, not by reading the classes.
- `Button` keeps `loading` and `disabled` semantics exactly, keeps the disabled cursor and opacity, and keeps rendering its spinner while loading — but that spinner now sits inside a `data-busy="true"` `aria-live="polite"` wrapper, per Task 3's contract.
- `Modal` keeps `role="dialog"`, `aria-modal="true"`, and the `aria-label="Close"` on its X.
- `Toast` keeps `role="status"` and keeps its two variants distinct.

- [ ] **Step 1: Record the baseline**

Run: `npm test`
Note the passing count and file count. Any change to either later in this task is a behaviour change.

- [ ] **Step 2: Restyle `Button`**

`VARIANT_CLASSES` and the base string become:

```tsx
const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-page hover:bg-accent-strong',
  ghost: 'bg-paper border border-rule text-ink-1 hover:bg-chip-fill',
  danger: 'bg-risk-high text-page hover:opacity-90',
};
```

```tsx
    <button
      disabled={isDisabled}
      className={`px-4 py-2 rounded-control flex items-center justify-center gap-2 font-ui text-button font-semibold transition-colors duration-150 disabled:opacity-50 disabled:cursor-not-allowed ${VARIANT_CLASSES[variant]} ${className}`}
      {...props}
    >
      {loading && (
        <span data-busy="true" aria-live="polite" className="flex items-center">
          <Loader className="w-4 h-4 animate-spin" aria-hidden="true" />
        </span>
      )}
      {children}
    </button>
```

`shadow-lg shadow-violet-900/20` and `active:scale-95` are gone: no elevation, restrained motion.

- [ ] **Step 3: Restyle `Modal`**

```tsx
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-canvas/70 p-4">
      <div role="dialog" aria-modal="true" className={`bg-card border border-rule rounded-control w-full ${SIZE_CLASSES[size]} flex flex-col overflow-hidden`}>
        <div className="p-4 border-b border-rule flex justify-between items-center bg-paper">
          <h3 className="font-prose text-section text-ink-1">{title}</h3>
          <button onClick={onClose} className="text-ink-4 hover:text-ink-1" aria-label="Close">
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="p-6 space-y-5 bg-card overflow-y-auto max-h-[60vh]">
          {children}
        </div>
        {footer && (
          <div className="p-4 border-t border-rule flex justify-end gap-3 bg-paper">
            {footer}
          </div>
        )}
      </div>
    </div>
```

`backdrop-blur-sm` and `shadow-2xl` go (no card shadow; the scrim is a dim, not a blur). `h3` stays an `h3`.

- [ ] **Step 4: Restyle `Toast`**

```tsx
    <div
      role="status"
      className={`fixed bottom-8 right-8 px-6 py-3 rounded-card z-[100] flex items-center gap-3 border-l-2 border border-rule bg-card font-ui text-ui transition-colors duration-150 ${
        isError ? 'border-l-risk-high text-risk-high' : 'border-l-accent text-ink-1'
      }`}
    >
```

- [ ] **Step 5: Restyle `LoadErrorPanel`**

```tsx
  if (compact) {
    return (
      <div className="p-6 text-center space-y-3 border border-dashed border-risk-high-edge rounded-card bg-risk-high-tint">
        <p className="text-risk-high font-ui text-ui">{message}</p>
        {onRetry && (
          <button
            onClick={onRetry}
            title="Retry"
            className="px-3 py-1.5 rounded-control bg-accent text-page font-ui text-button font-semibold hover:bg-accent-strong"
          >
            Retry
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="p-8 max-w-md mx-auto text-center space-y-4">
      <p className="text-risk-high font-ui text-ui">{message}</p>
      {onRetry && (
        <button
          onClick={onRetry}
          title="Retry"
          className="px-4 py-2 rounded-control bg-accent text-page font-ui text-button font-semibold hover:bg-accent-strong"
        >
          Retry
        </button>
      )}
    </div>
  );
```

Note the `title="Retry"` added to **both** variants. It is absent from the current code, and it is **not** the `title="Retry"` §13.3 names: that selector lives on `TabularReview`'s per-cell retry buttons (`TabularReview.tsx:285`, `:307`, `:328`, `:352`), where three assertions in `TabularReview.test.tsx:239` and `TabularReview.interrupted.test.tsx:55, :71` read `button[title="Retry"]` — Task 10 preserves those. Here it is a hardening: `LoadErrorPanel`'s retry is found by its visible word, and the word does not change either way.

- [ ] **Step 6: Restyle the three chips — three shapes, not three colours**

`StateChip`'s map and element:

```tsx
const CHIP: Record<VerificationState, { label: string; classes: string; Icon: typeof CircleDashed }> = {
  unchecked: { label: 'Unverified', classes: 'bg-chip-fill text-state-unchecked border-rule', Icon: CircleDashed },
  verified: { label: 'Verified', classes: 'bg-accent-tint text-state-verified border-accent-edge', Icon: CheckCircle2 },
  flagged: { label: 'Flagged', classes: 'bg-risk-med-tint text-state-flagged border-risk-med-edge', Icon: Flag },
  rejected: { label: 'Rejected', classes: 'bg-risk-high-tint text-state-rejected border-risk-high-edge', Icon: XCircle },
};
```

```tsx
    <span
      role="status"
      title={title}
      className={`font-mono text-chip uppercase px-1.5 py-0.5 rounded-chip border inline-flex items-center gap-1 ${classes}`}
    >
      <Icon className="w-3 h-3" aria-hidden="true" />
      {label}
    </span>
```

`RiskChip` — filled dot, **no border**:

```tsx
const RISK_CLASSES: Record<RiskLevel, string> = {
  High: 'text-risk-high',
  Medium: 'text-risk-med',
  Low: 'text-risk-low',
  Info: 'text-draft',
};

const RISK_DOT: Record<RiskLevel, string> = {
  High: 'bg-risk-high',
  Medium: 'bg-risk-med',
  Low: 'bg-risk-low',
  Info: 'bg-draft',
};
```

```tsx
    <span className={`font-mono text-chip uppercase inline-flex items-center gap-1.5 ${RISK_CLASSES[level]}`}>
      <span className={`w-1.5 h-1.5 rounded-meter ${RISK_DOT[level]}`} aria-hidden="true" />
      {level}
    </span>
```

`PositionChip` — label inside a 1px role-coloured border, transparent fill:

```tsx
const POSITION_CLASSES: Record<PositionOutcome, string> = {
  meets: 'text-outcome-meets border-outcome-meets',
  deviates: 'text-outcome-deviates border-outcome-deviates',
  unclear: 'text-outcome-unclear border-outcome-unclear',
};
```

```tsx
    <span className={`font-mono text-chip uppercase px-1.5 py-0.5 rounded-chip border bg-transparent ${POSITION_CLASSES[outcome]}`}>
      {POSITION_LABEL[outcome]}
    </span>
```

Update `PositionChip`'s doc comment: it no longer "matches `RiskChip` exactly" — R-G16 makes that the wrong goal, because two pairs of roles share a hue and colour alone cannot carry the distinction. Say so in the comment.

- [ ] **Step 7: Restyle `AutoResizeTextarea`**

The component composes `className` from its caller, so it gains only the shared field styling in its own string:

```tsx
        <textarea
            ref={textareaRef}
            value={value}
            onChange={handleChange}
            className={`${className} overflow-hidden resize-none bg-card border border-rule-strong rounded-control text-ink-prose font-prose text-field placeholder:text-ink-5 focus:outline-none focus:ring-1 focus:ring-accent focus:border-accent`}
            {...props}
        />
```

- [ ] **Step 8: Walk the state checklist**

Go through every bullet in this task's state checklist above and confirm each in the code. In particular render all three chips on one element mentally against R-G16: icon+border+fill / dot+no border / border+transparent.

- [ ] **Step 9: Run the suite with no test edited**

Run: `npm test`
Expected: the same passing count as Step 1.
Run: `git status --porcelain -- '*.test.ts' '*.test.tsx'`
Expected: **empty output.** If it is not, stop: something behavioural or textual changed. Report it rather than editing the test.

- [ ] **Step 10: Scan the touched files**

```bash
npx tsx -e "import {scanSource} from './src/test/paletteScan.ts'; import {readFileSync} from 'node:fs'; for (const f of ['src/components/Button.tsx','src/components/Modal.tsx','src/components/Toast.tsx','src/components/LoadErrorPanel.tsx','src/components/StateChip.tsx','src/components/RiskChip.tsx','src/components/PositionChip.tsx','src/components/AutoResizeTextarea.tsx']) { const v = scanSource(f, readFileSync(f,'utf8')); if (v.length) console.log(v); }"
```

Expected: no output.

- [ ] **Step 11: Gates and commit**

Run: `npx tsc --noEmit && npm run build`

```bash
git add src/components/Button.tsx src/components/Modal.tsx src/components/Toast.tsx src/components/LoadErrorPanel.tsx src/components/StateChip.tsx src/components/RiskChip.tsx src/components/PositionChip.tsx src/components/AutoResizeTextarea.tsx
git commit -F .git/COMMIT_G5
```

Message:

```
style(g): restyle the eight shared primitives onto the role tokens

Buttons lose their elevation and their active:scale; the modal loses its
blur and its shadow; cards are separated by a hairline and a value
difference, never by a shadow.

The three chips become three SHAPES, not three colours (R-G16): risk is a
filled dot with no border, verification is a lucide icon in a bordered chip
fill, and a standard-position outcome is a label inside a coloured border on
a transparent fill. Two pairs of roles share a hue — rejected with high
risk, flagged with medium — so colour alone cannot say which question a
chip is answering.

PositionChip still renders nothing when there is no outcome. LoadErrorPanel
keeps both variants, keeps its retry, and its message stays risk-high ink:
no failure text at ink-4 or below (R-G19).

No test edited.
```
---

## Task 6: App chrome, the dark-theme deletion, and the declared nav rename

**Kind:** **structural (small)** — the top bar gains an avatar and the nav's `Library` is renamed to `Playbooks`. Everything else is cosmetic. **This is the commit after which the branch is visibly light and visibly inconsistent**, which is expected and is why G is a branch (R-G17).

**Files:**
- Modify: `src/index.css` (delete the dark `@theme` block and the `body` rule; retint `.custom-scrollbar`; add the new `body` rule)
- Modify: `src/App.tsx:2554-2604` (the app frame and header), `src/App.tsx:225-243` (`MigrationBlockedScreen`), `src/App.tsx:2946` (the pending `bg-surface` div), and the `not-found` branch
- Modify: `src/App.test.tsx`, `src/App.authRedirect.test.tsx`, `src/App.matterDelete.test.tsx`, `src/App.matterPicker.test.tsx`, `src/App.reviewSaveError.test.tsx` — **13 occurrences** of the string `'Library'` passed to each file's local `clickNav` helper

**Interfaces:**
- Consumes: Task 1's tokens; Task 5's primitives.
- Produces: the light app frame every other screen sits inside, and the nav row Tasks 20 and 21 extend.

**Declared changes, and nothing else may be declared later:**

1. **`Library` → `Playbooks`** (R-G6). The route is already `/playbooks` and the `Route` is already `{ name: 'playbooks' }`; only the visible label was out of step. Thirteen assertions call `clickNav(container, 'Library')` and each becomes `clickNav(container, 'Playbooks')`. This is the one copy change in this task and it is why the commit is labelled structural.
2. **The profile-initials avatar** (§7). It shows the **local** profile's own initials and links to Settings. An avatar of yourself is honest and it is the only place the identity substrate becomes visible. **No** "assigned to me" counter, **no** badge, **no** firm tag beside the wordmark, **no** search box (R-G14).
3. **The gradient logo tile is dropped** for a live-text wordmark in Newsreader — the handoff's "no logo file".

- [ ] **Step 1: Record the baseline**

Run: `npm test`. Note the passing count.

- [ ] **Step 2: Delete the dark theme from `src/index.css`**

Remove the old `@theme` block (`--color-surface`, `--color-panel`, `--color-card`) and the `body` rule beneath it, and replace with:

```css
body {
  background-color: var(--color-paper);
  color: var(--color-ink-1);
  font-family: var(--font-ui);
  -webkit-font-smoothing: antialiased;
}

.custom-scrollbar::-webkit-scrollbar { width: 6px; height: 6px; }
.custom-scrollbar::-webkit-scrollbar-track { background: transparent; }
.custom-scrollbar::-webkit-scrollbar-thumb { background: rgb(26 24 21 / 0.14); border-radius: 10px; }
.custom-scrollbar::-webkit-scrollbar-thumb:hover { background: rgb(26 24 21 / 0.24); }
```

`bg-surface` and `bg-panel` no longer exist as utilities; `tsc` will not catch that (they are strings), so Step 6's grep does.

- [ ] **Step 3: Restyle the app frame and header**

`src/App.tsx:2554-2604` becomes:

```tsx
    <div className="min-h-screen flex flex-col bg-paper">
      <Toast toast={toast} />

      <header className="h-14 border-b border-rule bg-card flex items-center justify-between px-6 shrink-0">
        <button
          className="flex items-center"
          onClick={() => requestView('matters')}
        >
          <span className="font-prose text-section font-medium text-ink-1 tracking-[-0.01em]">LexPrompt</span>
        </button>

        <div className="flex items-center gap-2">
          <button
            onClick={() => requestView('matters')}
            className={`font-ui text-ui-sm px-2.5 py-1.5 rounded-inset flex items-center gap-1.5 ${view === 'matters' || view === 'matter' ? 'font-semibold text-ink-1 bg-accent-tint' : 'font-medium text-ink-3 hover:text-ink-1'}`}
          >
            <Briefcase className="w-4 h-4" /> Matters
          </button>
          <button
            onClick={() => requestView('library')}
            className={`font-ui text-ui-sm px-2.5 py-1.5 rounded-inset ${view === 'library' || view === 'editor' ? 'font-semibold text-ink-1 bg-accent-tint' : 'font-medium text-ink-3 hover:text-ink-1'}`}
          >
            Playbooks
          </button>
          {run && (
            <button
              onClick={() => requestView('results')}
              className={`font-ui text-ui-sm px-2.5 py-1.5 rounded-inset flex items-center gap-1.5 ${view === 'results' || view === 'tabular' ? 'font-semibold text-ink-1 bg-accent-tint' : 'font-medium text-ink-3 hover:text-ink-1'}`}
              title="Back to the current run's results"
            >
              <ClipboardList className="w-4 h-4" /> Current run
            </button>
          )}
          <div className="h-4 w-px bg-rule mx-2" />
          <button
            onClick={() => requestView('settings')}
            className={`p-1.5 rounded-inset ${view === 'settings' ? 'text-ink-1' : 'text-ink-3 hover:text-ink-1'}`}
            title="Settings"
          >
            <SettingsIcon className="w-4 h-4" />
          </button>
          {/* §7: the avatar shows the LOCAL profile's own initials and goes
              to Settings, where the name is editable. An avatar of yourself
              is honest — and it is the only place the identity substrate
              becomes visible. There is no counter, no badge, and no second
              actor anywhere in this app (R-G1). */}
          <button
            onClick={() => requestView('settings')}
            aria-label="Your profile"
            title="Your profile"
            className="w-7 h-7 rounded-meter bg-accent text-page font-ui text-meta font-semibold flex items-center justify-center"
          >
            {profile?.initials ?? 'ME'}
          </button>
        </div>
      </header>
```

`FileText` is no longer imported by the header; leave the import only if another call site in `App.tsx` still uses it (`grep -n 'FileText' src/App.tsx` before removing it from line 2).

- [ ] **Step 4: Restyle the remaining app-level surfaces**

- `src/App.tsx:2946`: `<div className="min-h-screen bg-surface" />` → `<div className="min-h-screen bg-paper" />`.
- `MigrationBlockedScreen` (`src/App.tsx` around 225-243): its heading becomes `font-prose text-screen-title text-ink-1`, its body `font-ui text-ui text-ink-2`, its container `bg-paper`, and its error detail `text-risk-high` — this screen is the app's most visible failure and must not sit at `ink-4` or below (R-G19).
- The `not-found` view: `bg-paper`, centred, heading in `font-prose text-screen-title text-ink-1`, body in `text-ink-2`.
- `src/App.tsx:2838`: `<div className="p-8 text-gray-500">No run yet. Start one from a template.</div>` → `<div className="p-8 font-ui text-ui text-ink-3">No run yet. Start one from a template.</div>`.

- [ ] **Step 5: Update the 13 declared test occurrences**

In each of `src/App.test.tsx` (5), `src/App.matterPicker.test.tsx` (4), `src/App.authRedirect.test.tsx` (2), `src/App.matterDelete.test.tsx` (1) and `src/App.reviewSaveError.test.tsx` (1), replace `clickNav(container, 'Library')` with `clickNav(container, 'Playbooks')`. Each file's `clickNav` matches on the button's exact trimmed text, so nothing else needs touching. Leave every comment mentioning "the Library flow" alone: they describe a flow, not a label.

- [ ] **Step 6: Prove no dead utility survived**

```bash
grep -rn "bg-surface\|bg-panel" src --include=*.tsx --include=*.ts
```

Expected: no output. Both were generated only by the deleted `@theme` block; a leftover would render transparent — invisible text on an invisible background, exactly the §14 failure mode.

- [ ] **Step 7: Run the suite**

Run: `npm test`
Expected: the Step 1 count, with **only** the five declared test files modified. Confirm with:

```bash
git status --porcelain -- '*.test.ts' '*.test.tsx'
```

Expected: exactly those five files, no others.

- [ ] **Step 8: Gates and commit**

Run: `npx tsc --noEmit && npm run build`

```bash
git add src/index.css src/App.tsx src/App.test.tsx src/App.authRedirect.test.tsx src/App.matterDelete.test.tsx src/App.matterPicker.test.tsx src/App.reviewSaveError.test.tsx
git commit -F .git/COMMIT_G6
```

Message:

```
feat(g)!: light the app frame, drop the dark theme, rename Library to Playbooks

The dark @theme block and its body rule are gone; the scrollbar is
retinted. From this commit the branch is visibly light and visibly
inconsistent until task 14 — expected, and the reason G is a branch that
merges whole rather than a series of releases (R-G17).

Three declared changes, none of them styling:
- Library -> Playbooks in the nav (R-G6). The route was already
  /playbooks; only the label was out of step. 13 assertions across 5 test
  files updated, named in this commit rather than absorbed into a restyle.
- A profile avatar showing the LOCAL profile's initials, linking to
  Settings. No counter, no badge, no firm tag, no search box: nothing that
  implies a colleague this app does not have (R-G1, R-G14).
- The gradient logo tile becomes a live-text Newsreader wordmark.
```

---

## Task 7: Matters route group

**Kind:** cosmetic. Follow the restyle task template.

**Files:**
- Modify: `src/features/matters/MattersList.tsx`, `MatterHome.tsx`, `CollectionCard.tsx`, `GroupDocumentsDialog.tsx`, `MatterPickerModal.tsx`

**Interfaces:**
- Consumes: Task 1's tokens, Task 5's primitives.
- Produces: the restyled matters screens that Tasks 15, 16, 18 and 19 add sections to. **No prop changes.**

**State checklist for this task:**

- `MatterHome`'s **three** `LoadErrorPanel compact` branches all survive, at `MatterHome.tsx:357-365` (collections), `:378-386` (documents), `:531-536` (the run picker's playbooks). Each still renders **instead of** the content it replaces.
- The collections-error branch that refuses to list loose documents (`MatterHome.tsx:378-392`) keeps refusing: membership unknown is not membership empty.
- `documents.length === 0` still renders "No documents yet. Add one to get started." — Task 18 replaces this branch with the wizard; **it is not touched here**.
- The document row's `parseError` keeps its `file-warning` treatment, in `risk-high` on `risk-high-tint`, never at `ink-4` or below.
- `markupNotice` (the tracked-changes disclosure) survives on the document row it renders on today.
- `MatterHome`'s "Preparing documents for review — scanned pages can take a moment to render…" is frozen copy: it renders identically, in `ink-2`, wrapped in `data-busy="true"` `aria-live="polite"` per Task 3's contract.
- `[title="Delete Matter"]` survives on the delete control.
- `GroupDocumentsDialog` keeps input ids `#base-a` / `#base-b` / `#base-c` — three tests select on them.
- `CollectionCard`'s BASE/VARIES role chips stay two distinguishable chips; a collection whose base is missing keeps its repair affordance and its explanatory line.
- `MatterPickerModal` keeps its `mattersError` branch with `onRetryMatters`.

- [ ] **Step 1: Record the baseline** — run `npm test`, note the count.

- [ ] **Step 2: Apply the surface mapping across all five files**

Mechanical substitutions, in this order (do them per-file, reading each line, not with `sed` — several strings are conditional expressions where only one arm is a colour):

| Old | New |
| --- | --- |
| `bg-[#09090b]` / `bg-surface` | `bg-paper` |
| `bg-[#111]` / `bg-panel` | `bg-card` |
| `bg-[#1a1a1a]` / `bg-[#1a1a1d]` | `bg-card` |
| `bg-white/5` (a fill) | `bg-chip-fill` |
| `border-white/10`, `border-white/5` | `border-rule` |
| `text-white` | `text-ink-1` |
| `text-gray-300` | `text-ink-2` |
| `text-gray-400` | `text-ink-3` |
| `text-gray-500` | `text-ink-4` (metadata only — never a warning) |
| `text-gray-600` | `text-ink-5` |
| `text-violet-*` (an action) | `text-accent` |
| `bg-violet-600` (a primary action) | `bg-accent text-page` |
| `text-red-*` / `border-red-*` (a failure) | `text-risk-high` / `border-risk-high-edge` |
| `text-yellow-*` / `text-amber-*` (a caution) | `text-risk-med` |
| `text-emerald-*` (a human confirmation) | `text-accent` |
| `text-emerald-*` (a low-risk rating) | `text-risk-low` |
| `rounded-lg` / `rounded-xl` on a card | `rounded-card` |
| `rounded-lg` on a control | `rounded-control` |
| `rounded-full` on a meter | `rounded-meter` |
| `shadow-*` on a card | **deleted** |

The emerald row is the one that needs thought every time: **teal for a human, green for a low risk** (R-G4). On these five screens every emerald is a completion or a confirmation, so every one becomes `accent`.

- [ ] **Step 3: Apply the type mapping**

- Matter name on `MattersList` rows and `MatterHome`'s title: `font-prose text-matter-title text-ink-1`.
- Section headings ("Documents & collections", "Reviews"): `font-prose text-section text-ink-1`.
- Metadata sentences (client · reference · counts): `font-ui text-meta text-ink-4`.
- Counts, dates, page counts, byte sizes: `font-mono text-pin text-ink-4`.
- Role chips (`BASE`, `VARIES`, `COLLECTION · READ TOGETHER`): `font-mono text-chip uppercase`.
- Buttons: through `Button`, which Task 5 already handles.

- [ ] **Step 4: Walk the state checklist** above, item by item, in the code.

- [ ] **Step 5: Run the suite with no test edited**

Run: `npm test`, then `git status --porcelain -- '*.test.ts' '*.test.tsx'` (expected: empty).

- [ ] **Step 6: Scan and gate**

Run the Task 5 Step 10 scan command with this task's five paths substituted. Then `npx tsc --noEmit && npm run build`.

- [ ] **Step 7: Commit**

```bash
git add src/features/matters/MattersList.tsx src/features/matters/MatterHome.tsx src/features/matters/CollectionCard.tsx src/features/matters/GroupDocumentsDialog.tsx src/features/matters/MatterPickerModal.tsx
git commit -F .git/COMMIT_G7
```

Message:

```
style(g): restyle the matters screens onto the role tokens

Cards on paper, hairline rules, Newsreader for matter names and section
headings, mono for counts and dates.

All three of MatterHome's compact load-error branches survive, including
the one that refuses to list loose documents when collection membership is
unknown — unknown is not empty. Parse errors keep risk-high ink rather than
dropping to a metadata grey (R-G19), and the delete control keeps its
title="Delete Matter".

No test edited.
```

---

## Task 8: Review route group, part 1 — the finding and its disposition

**Kind:** cosmetic. Follow the restyle task template.

**Files:**
- Modify: `src/features/review/ResultsView.tsx` (the existing **two-pane** layout only — the three-pane relayout is Task 23), `FindingCard.tsx`, `EvidenceList.tsx`, `VerificationControls.tsx`, `NotesPanel.tsx`

**Interfaces:**
- Consumes: Task 1's tokens, Task 3's busy contract, Task 5's primitives.
- Produces: the restyled review rail. **No prop changes**; `ResultsViewProps` is untouched.

**State checklist for this task:**

- `FindingCard` keeps **all five** statuses distinct: `pending` (queued, dashed, dimmed), `running` (busy, with Task 3's `data-busy` and the `Extracting…` word), `error` (with Retry), `cancelled` (calm, not an error), `done`.
- **A rejected-by-human finding and an errored-by-model finding must not look the same.** Rejected is a `StateChip` on a done card carrying the model's answer; errored is an error branch with no answer and a Retry. Check them side by side.
- The `interrupted` variants of `pending` and `running` keep their explanatory sentences and their Retry buttons verbatim.
- Truncation (`truncated`, `truncatedDocuments`) and scan notices survive on the card.
- `markupNotice` survives wherever it renders today.
- `authError`, `noContent` and `edited` branches survive.
- `EvidenceList` renders the pin exactly as `derivePage` produced it and **still omits the page when `derivePage` returned `undefined`** — no guessed page, ever.
- `VerificationControls`: await-then-apply untouched; the `J` hint kept; **no new shortcut added**; the busy state uses Task 3's contract; **no assignee chip and no assign action** (R-G1).
- `NotesPanel` keeps `data-testid="note-text"`; its avatar is the **local** profile's initials; attribution reads "you" for the local profile and carries no invented name otherwise (R-GP5).
- The rail's Findings/Assistant tab pair keeps both tabs and the chat panel's `Suspense` fallback text.

- [ ] **Step 1: Record the baseline** — `npm test`, note the count.

- [ ] **Step 2: Restyle the rail shell in `ResultsView`**

`ResultsView.tsx:364-366`:

```tsx
    <div className="h-full flex flex-col lg:flex-row bg-paper">
      <div className="w-full lg:w-1/3 border-r border-rule flex flex-col bg-card min-h-0">
        <div className="p-4 border-b border-rule flex items-center justify-between gap-3">
```

The document `<select>` becomes `bg-card border border-rule-strong rounded-control px-2 py-1.5 font-ui text-ui text-ink-1 outline-none focus:ring-1 focus:ring-accent`. The `progressLabel` span becomes `font-mono text-pin text-ink-4` and keeps its `title="Findings a human has verified"`. The tab pair's active arm becomes `text-accent border-b-2 border-accent`, inactive `text-ink-3 hover:text-ink-1`.

The three action buttons (Draft Email / Export DOCX / Export CSV) keep their `title` attributes verbatim — `"Draft Email"`, `"Export DOCX"`, `"Export CSV"` — and become `bg-chip-fill rounded-control text-ink-2 hover:bg-paper`, except Export DOCX which is the primary: `bg-accent text-page rounded-control`. Their in-flight `Loader` icons move inside a `data-busy="true" aria-live="polite"` wrapper.

- [ ] **Step 3: Restyle `FindingCard`**

- `CARD_SHELL`: `bg-card border border-rule rounded-card` (no shadow).
- Clause title: `font-prose text-clause font-medium text-ink-1`.
- The finding summary: `font-prose text-finding text-ink-prose [text-wrap:pretty]`.
- The card's left accent, by risk: `border-l-2 border-l-risk-high` / `-risk-med` / `-risk-low`, and no left accent at all for `Info`.
- `pending`: `border-dashed border-rule` + `opacity-60` when not interrupted (raised from `opacity-40`: a queued clause must still be readable).
- `running`: the header row from Task 3, with the skeleton bars becoming `h-2.5 bg-chip-fill rounded-inset lex-pulse` — one class, so `prefers-reduced-motion` collapses them to static tinted bars while `Extracting…` stays (R-G20).
- `error`: `bg-risk-high-tint border-risk-high-edge`, message in `text-risk-high`, Retry as a ghost `Button`.
- `cancelled`: `bg-chip-fill border-rule`, text in `ink-2` — calm, visibly **not** an error.
- Truncation and scan notices: `text-risk-med` on `bg-risk-med-tint`, never `ink-4`.

- [ ] **Step 4: Restyle `EvidenceList`**

Each citation block: `border-l-2 border-l-rule pl-3.5 bg-chip-fill/40`. The quote: `font-prose italic text-quote text-ink-quote`. The pin: `font-mono text-pin text-ink-4 uppercase`. "Show in document": `font-ui text-meta text-accent`.

- [ ] **Step 5: Restyle `VerificationControls` and `NotesPanel`**

- The disposition row: `bg-card border-t border-rule`, label `font-mono text-label uppercase text-ink-4`.
- Verify: `border border-accent-edge text-accent` when inactive, `bg-accent text-page` when it is the current state.
- Flag: `border border-risk-med-edge text-risk-med` inactive, `bg-risk-med text-page` active.
- Reject: `border border-risk-high-edge text-risk-high` inactive, `bg-risk-high text-page` active.
- The `J` hint: `font-mono text-pin text-ink-4` in a `bg-chip-fill rounded-chip px-1` key cap.
- `NotesPanel`: `bg-card border border-rule rounded-card`; note text in `font-ui text-ui text-ink-2` and **keeps `data-testid="note-text"`**; the avatar a 22px `rounded-meter bg-accent text-page font-ui text-meta`.

- [ ] **Step 6: Walk the state checklist** above.

- [ ] **Step 7: Run the suite with no test edited** — `npm test`, then `git status --porcelain -- '*.test.ts' '*.test.tsx'` (expected: empty).

- [ ] **Step 8: Scan and gate** — the Task 5 Step 10 command with this task's five paths; then `npx tsc --noEmit && npm run build`.

- [ ] **Step 9: Commit**

```bash
git add src/features/review/ResultsView.tsx src/features/review/FindingCard.tsx src/features/review/EvidenceList.tsx src/features/review/VerificationControls.tsx src/features/review/NotesPanel.tsx
git commit -F .git/COMMIT_G8
```

Message:

```
style(g): restyle the finding, its evidence and its disposition bar

Findings read as prose now — Newsreader 15.5/1.62 with text-wrap: pretty —
and quoted evidence is italic Newsreader behind a hairline left border with
a mono source pin.

All five card statuses stay distinct, and a rejected finding still cannot
be mistaken for an errored one: rejected is a chip on a card that carries
an answer, errored is a branch with no answer and a Retry. The extracting
state's skeleton bars use the one looping animation in the system, and its
word survives prefers-reduced-motion.

No assignee chip, no assign action: flagging reaches no one and the UI does
not pretend otherwise (R-G1). Layout is untouched — the two-to-three-pane
relayout is its own commit.

No test edited.
```

---

## Task 9: Review route group, part 2 — positions, trail, document and run banners

**Kind:** cosmetic. Follow the restyle task template.

**Files:**
- Modify: `src/features/review/PositionComparison.tsx`, `NetPositionPanel.tsx`, `VariationTrailModal.tsx`, `RejectReasonModal.tsx`, `DocumentViewer.tsx`, `RunPanel.tsx`, `ReviewVersionLine.tsx`
- Modify: `src/features/review/PdfCanvas.tsx:100-101` — **the two overlay style values only** (R-GP1)

**Interfaces:**
- Consumes: Task 1's tokens (`highlight-fill`, `highlight-edge`, `net-*`, `outcome-*`), Task 5's primitives.
- Produces: the restyled document pane and run banners. **No prop changes.**

**State checklist for this task:**

- **`ReviewVersionLine` keeps all four outcomes, in four distinguishable renderings**, with the four sentences verbatim:
  1. `versionId` absent → "Ran against a playbook version that is no longer recorded." — `text-ink-3`.
  2. `lookupFailed` → "Could not check which playbook version this review ran against. Try reloading." — `text-risk-med`.
  3. resolved → "Ran against v*N*", a link (`text-accent underline underline-offset-2`) when `onOpenHistory` is supplied, plain `text-ink-3` when not.
  4. `version === null` → "The version this review ran against has been deleted." — `text-risk-med`.
  **Branches 2 and 4 may not be collapsed into one colour, one wording or one branch** — they are different facts, and R-D15 exists because collapsing them once produced a confident false claim. Both are amber; both keep their own sentence.
- **All four run banners survive, stay distinct, and stay above the content**: `RunProgressBar` (accent bar + Cancel), `RunCancelledBanner` (neutral, calm), `RunInterruptedBanner` (`risk-med` on `risk-med-tint`), `RunEmptyFindingsBanner` (`risk-med`, and still returns `null` at `noContent === 0`). Their four sentences are frozen copy.
- `PositionComparison` renders **only** when there is an outcome, and keeps its two-column "We ask for" / "This lease says" shape.
- `NetPositionPanel`: unconfirmed is `border-dashed border-net-unconfirmed` on `risk-med-tint` with the confirm action visible; confirmed is `border-net-confirmed` with attribution. **A net position must not read as settled until a human confirms it.** The confirm/amend semantics are C's and are untouched.
- `VariationTrailModal` keeps the unavailable-member wording verbatim (R-C2R1) and keeps its three node forms distinct: original (outline ring), varied-by (solid amber dot), net (teal dot with a check).
- `DocumentViewer`: `bg-doc-gutter` around a `bg-page` sheet carrying `shadow-page` — **the only card-like shadow in the app** — and keeps its own "no document" and parse-error branches.
- `RunPanel` keeps its drop zone, its per-file list, its parse-error rows and its scan notices.

- [ ] **Step 1: Record the baseline** — `npm test`, note the count.

- [ ] **Step 2: Restyle `ReviewVersionLine`**

Only the four class strings change; the four sentences, the prop contract and the branch order do not:

```tsx
  if (versionId === undefined) {
    return (
      <span className="font-ui text-meta text-ink-3">
        Ran against a playbook version that is no longer recorded.
      </span>
    );
  }

  if (lookupFailed) {
    return (
      <span className="font-ui text-meta text-risk-med">
        Could not check which playbook version this review ran against. Try reloading.
      </span>
    );
  }

  if (version === null) {
    return (
      <span className="font-ui text-meta text-risk-med">
        The version this review ran against has been deleted.
      </span>
    );
  }

  const label = `Ran against v${version.version}`;
  if (!onOpenHistory) {
    return <span className="font-ui text-meta text-ink-3">{label}</span>;
  }

  return (
    <button
      type="button"
      onClick={onOpenHistory}
      className="font-ui text-meta text-accent hover:text-accent-strong underline underline-offset-2"
    >
      {label}
    </button>
  );
```

- [ ] **Step 3: Restyle the four run banners in `RunPanel.tsx`**

```tsx
// RunProgressBar's shell and bar
    <div className="shrink-0 border-b border-rule bg-card px-6 py-3 flex items-center gap-4" data-busy="true" aria-live="polite">
      <div className="flex-1 min-w-0">
        <div className="flex justify-between font-ui text-meta text-ink-3 mb-1.5">
          <span>Reviewing… {done} of {total} clauses</span>
          <span>{pct}%</span>
        </div>
        <div className="h-1.5 bg-chip-fill rounded-meter overflow-hidden">
          <div className="h-full bg-accent transition-all duration-150" style={{ width: `${pct}%` }} />
        </div>
      </div>
      <Button variant="ghost" onClick={onCancel} className="shrink-0">Cancel</Button>
    </div>
```

```tsx
// RunCancelledBanner — calm and neutral, visibly not a failure
    <div className="shrink-0 border-b border-rule bg-card px-6 py-3 flex items-center gap-3 font-ui text-ui text-ink-2">
```

```tsx
// RunInterruptedBanner and RunEmptyFindingsBanner — both caution
    <div className="shrink-0 border-b border-risk-med-edge bg-risk-med-tint px-6 py-3 flex items-center gap-3 font-ui text-ui text-risk-med">
```

Every sentence inside them is unchanged, character for character.

- [ ] **Step 4: Restyle the document pane and the highlight (R-GP1)**

`DocumentViewer.tsx`: the gutter becomes `bg-doc-gutter`, the text-document sheet becomes `bg-page shadow-page rounded-inset font-prose text-finding text-ink-prose max-w-3xl mx-auto` (replacing `bg-[#1a1a1a] shadow-2xl text-gray-300 font-serif`).

`PdfCanvas.tsx:100-101` — and nothing else in that file:

```tsx
              backgroundColor: 'var(--color-highlight-fill)',
              borderBottom: '2px solid var(--color-highlight-edge)',
```

- [ ] **Step 5: Restyle the position, net-position, trail and reject modals**

- `PositionComparison`: card `bg-risk-high-tint border border-risk-high-edge rounded-control` for `deviates`, `bg-accent-tint border-accent-edge` for `meets`, `bg-risk-med-tint border-risk-med-edge` for `unclear`; the two column labels `font-mono text-label uppercase text-ink-4`; both bodies `font-prose text-field text-ink-prose`.
- `NetPositionPanel`: unconfirmed `bg-card border border-dashed border-net-unconfirmed`, confirmed `bg-card border border-accent-edge`; the position text `font-prose text-finding text-ink-prose`; attribution `font-mono text-pin text-ink-4`.
- `VariationTrailModal`: the connector `bg-rule`; original node `border-2 border-ink-4 bg-paper rounded-meter`; varied-by node `bg-risk-med rounded-meter`; net node `bg-accent text-page rounded-meter`; superseded prose `text-ink-2`, current prose `text-ink-prose`.
- `RejectReasonModal`: through the restyled `Modal`; its textarea through `AutoResizeTextarea`.

- [ ] **Step 6: Walk the state checklist** above — in particular render `ReviewVersionLine` in all four branches and confirm 2 and 4 still say different things.

- [ ] **Step 7: Run the suite with no test edited** — `npm test`, then `git status --porcelain -- '*.test.ts' '*.test.tsx'` (expected: empty). `ReviewVersionLine.test.tsx` and `ReviewVersionLine.e2e.test.tsx` are text-selecting and must both pass untouched.

- [ ] **Step 8: Scan and gate** — the scan command with this task's seven paths (`PdfCanvas.tsx` is exempt by `SCAN_EXEMPT` and is not in the list); then `npx tsc --noEmit && npm run build`.

- [ ] **Step 9: Commit**

```bash
git add src/features/review/PositionComparison.tsx src/features/review/NetPositionPanel.tsx src/features/review/VariationTrailModal.tsx src/features/review/RejectReasonModal.tsx src/features/review/DocumentViewer.tsx src/features/review/RunPanel.tsx src/features/review/ReviewVersionLine.tsx src/features/review/PdfCanvas.tsx
git commit -F .git/COMMIT_G9
```

Message:

```
style(g): restyle the document pane, the run banners and the version line

The document sits on doc-gutter as a white page carrying the one page
shadow the system allows. The citation highlight moves to its tokens: it
lives in PdfCanvas's overlay DIVS, not in a canvas draw call, so leaving it
would have shipped the one graphic the browser checklist exists to verify
in the wrong yellow (R-GP1). Nothing else in that file is touched.

ReviewVersionLine keeps four branches with four sentences. "Could not check
which version this ran against" and "the version has been deleted" are
different facts and stay two branches: R-D15 exists because collapsing them
once produced a confident false claim.

All four run banners survive, distinct, above the content, with their copy
frozen.

No test edited.
```

---

## Task 10: The comparison grid

**Kind:** cosmetic. **`1e` was already rebuilt in sub-project C — G restyles it and must not rebuild it** (R-G8). `TabularReview.tsx` already has the per-column risk mini-bar, the un-truncated sentence per cell, split risk/verification, and "Open in review". Rebuilding it would silently discard C's `findingsKeyFor` collection handling, the source of six defects.

**Files:**
- Modify: `src/features/tabular/TabularReview.tsx`, `src/features/tabular/CellDetail.tsx`

**Interfaces:**
- Consumes: Task 1's tokens, Task 3's `data-testid="cell-summary"`, Task 5's chips.
- Produces: the restyled grid Task 21's `Review / Compare` control switches to.

**State checklist for this task:**

- The real `<table>` / `<th>` / `<td>` structure survives. **`td:nth-child(2)` is asserted; a CSS-grid rewrite breaks both the tests and the screen-reader semantics.**
- `CollectionNotComparable` still refuses a collection target outright, with its explanation intact.
- The four per-cell states stay four: queued, extracting (Task 3's contract), error-with-retry, done.
- `StateChip` and `RiskChip` stay two separate chips in a cell.
- The truncation warning icon keeps its `aria-label="Document truncated to fit context budget"`.
- The column mini-bar keeps `role="img"` and its `aria-label` naming the counts.
- `data-testid="cell-summary"` holds the whole sentence; the wrap toggle still switches between `whitespace-normal` and `line-clamp-3`.
- The done cell's retry control keeps its `title="Re-run this clause"` and its `sr-only` "Retry".
- **The per-cell retry buttons at `TabularReview.tsx:285`, `:307`, `:328` and `:352` keep `title="Retry"` verbatim.** Three assertions read `button[title="Retry"]` — `TabularReview.test.tsx:239` and `TabularReview.interrupted.test.tsx:55` and `:71` — and this is the `title="Retry"` §13.3 names.
- The CSV export button keeps its label (and this task fixes the literal typo `bg-white\5` at `TabularReview.tsx:157` by replacing the whole class string).

- [ ] **Step 1: Record the baseline** — `npm test`, note the count.

- [ ] **Step 2: Restyle the grid chrome and the sticky columns**

Header bar: `h-14 border-b border-rule bg-card`. Title: `font-prose text-section text-ink-1`. The doc/clause count chip: `font-mono text-chip uppercase bg-chip-fill text-ink-4 rounded-chip px-2 py-1`. The deviating chip: `font-mono text-chip uppercase text-outcome-deviates border border-outcome-deviates rounded-chip px-2 py-1` (the third chip shape, R-G16). The Wrap toggle: `bg-accent-tint text-accent border-accent-edge` when on, `bg-chip-fill text-ink-2 border-rule` when off.

Sticky clause header (`TabularReview.tsx:177`) and sticky row header (`:197`):

```tsx
className="text-left p-4 border-b border-r border-rule font-mono text-label uppercase text-ink-4 w-64 sticky left-0 bg-card z-20"
```

```tsx
className="p-3 border-b border-r border-rule font-ui text-ui-sm text-ink-1 sticky left-0 bg-paper truncate max-w-[250px]"
```

The `shadow-[1px_0_0_0_rgba(255,255,255,0.1)]` seam becomes `border-r border-rule` (already present) — an arbitrary-value colour the palette guard rejects, and a hairline says the same thing.

- [ ] **Step 3: Apply the 5% per-cell risk washes**

The per-cell `riskClass` map becomes exactly the design's 5% washes, expressed as roles:

```tsx
const RISK_CELL: Record<RiskLevel, string> = {
  High: 'bg-risk-high-tint',
  Medium: 'bg-risk-med-tint',
  Low: 'bg-risk-low-tint',
  Info: 'bg-draft-tint',
};
```

and the selection ring (`TabularReview.tsx:262`) becomes `ring-1 ring-inset ring-accent` rather than an arbitrary `shadow-[inset…rgba…]`.

The mini-bar's segment classes (`RISK_BAR_CLASSES`) become `bg-risk-high` / `bg-risk-med` / `bg-risk-low` / `bg-draft`, and its track `bg-chip-fill`.

- [ ] **Step 4: Restyle `CellDetail`** — `bg-card border-l border-rule`, the summary in `font-prose text-finding text-ink-prose`, evidence as in Task 8, chips through the shared components.

- [ ] **Step 5: Walk the state checklist** above.

- [ ] **Step 6: Run the suite with no test edited**

Run: `npm test`, then `git status --porcelain -- '*.test.ts' '*.test.tsx'` (expected: empty). All three grid test files — `TabularReview.test.tsx`, `TabularReview.collectionKey.test.tsx`, `TabularReview.interrupted.test.tsx` — must pass untouched.

- [ ] **Step 7: Scan, gate and commit**

```bash
git add src/features/tabular/TabularReview.tsx src/features/tabular/CellDetail.tsx
git commit -F .git/COMMIT_G10
```

Message:

```
style(g): restyle the comparison grid, per-cell risk washes and all

C already built this screen — the mini-bar, the un-truncated sentence, the
split risk and verification chips, "Open in review". G supplies the 5% risk
washes, the mono column headers and the sticky hairlines, and rebuilds
nothing: a rewrite would have discarded C's findingsKeyFor handling, which
cost six defects to get right (R-G8).

The real table/td structure stays. td:nth-child(2) is asserted and a CSS
grid would break the screen-reader semantics as well as the test.

No test edited.
```

---

## Task 11: Playbooks route group

**Kind:** cosmetic, **plus one declared copy addition** — the playbook editor's derived coverage line (R-G6).

**Files:**
- Modify: `src/features/templates/TemplateLibrary.tsx`, `TemplateEditor.tsx`, `StandardPositionField.tsx`, `FieldSuggestion.tsx`, `PublishDialog.tsx`, `MegaPromptModal.tsx`, `VersionHistory.tsx`
- Modify: `src/features/templates/TemplateEditor.test.tsx` — **one new test** for the coverage line (declared)

**Interfaces:**
- Consumes: Task 1's tokens, Task 3's `data-clause-row`, Task 5's primitives, D's `positionHealthLabel`.
- Produces: the restyled playbook editor Task 20's rows link into.

**State checklist for this task:**

- `positionHealthLabel`'s **four** kinds stay four and stay visually distinct: `HELD n of n` → `text-health-held`; `CONCEDED n times` → `text-health-conceded`; `UNTESTED` → `text-health-untested`; `NO POSITION` → `text-health-none`. **`UNTESTED` and `NO POSITION` are deliberately not styled alike** — "we have no rule" and "we have a rule nothing has tested" are different facts (§8.3). The four strings are frozen.
- `TemplateEditor`'s "Unpublished changes — reviews still run v*N*" badge and `TemplateLibrary`'s "Unpublished changes" badge keep their exact wording, in `draft` on `draft-tint`.
- The disabled-publish tooltip "Nothing to publish — this is the published version." is frozen.
- `[draggable="true"]` stays on the drag handle; the chevrons stay as the keyboard path; `data-clause-row` from Task 3 stays.
- `PublishDialog` keeps `[aria-label="Change summary"]`.
- `FieldSuggestion` keeps its dashed border, its `SUGGESTED` chip, and its use/retry/dismiss actions; **an unaccepted suggestion is still not saved** — E's semantics are untouched.
- `VersionHistory` keeps its loading, error-with-retry and empty branches, and **carries no "Compare to v*N*" action** (R-G15).
- `TemplateLibrary` keeps its `LoadErrorPanel` branch distinct from its empty state.

- [ ] **Step 1: Record the baseline** — `npm test`, note the count.

- [ ] **Step 2: Restyle the seven components**

Apply Task 7 Step 2's surface mapping and Step 3's type mapping. Specific to this group:

- Clause row wrapper: `data-clause-row` (already there) + `bg-card border border-rule rounded-card`, replacing the `p-0.5 bg-gradient-to-r` faux-border trick entirely. While dragging: `border-accent-edge bg-accent-tint`.
- Clause title: `font-prose text-clause font-medium text-ink-1`.
- Prompt text and standard-position text: `font-prose text-field text-ink-prose`.
- The `HAS STANDARD POSITION` / `NO STANDARD POSITION` markers: `font-mono text-chip uppercase`, the first `text-accent border border-accent-edge`, the second `text-ink-4 border border-rule` — both the `PositionChip` shape, so the editor and the finding card agree on what that shape means.
- `MegaPromptModal`: `bg-page font-mono text-ui-sm text-ink-prose`.
- `VersionHistory`: current version a filled `bg-accent rounded-meter` node, prior versions an outline `border border-ink-4 rounded-meter` node, connector `bg-rule`.

- [ ] **Step 3: Add the declared coverage line**

In `TemplateEditor.tsx`, above the clause list's footer, derived from what is already on screen — no new read, no new state:

```tsx
{/* Declared new copy (R-G6). Derivable from `working.clauses` alone, and it
    answers the question the left rail's position coverage is for: how much
    of this playbook actually carries a house rule. */}
<p className="font-ui text-meta text-ink-3">
  {working.clauses.filter(c => c.standardPosition).length} of {working.clauses.length} clauses have a standard position
</p>
```

- [ ] **Step 4: Write the test for the declared copy**

Append to `src/features/templates/TemplateEditor.test.tsx`:

```ts
describe('TemplateEditor — position coverage line (sub-project G, R-G6)', () => {
  it('counts the clauses that carry a standard position', () => {
    const v = version({
      clauses: [
        { id: 'c1', title: 'Break', extractPrompt: 'Any break right?', standardPosition: { text: 'Six months.', origin: 'authored', reviewedByHuman: true } },
        { id: 'c2', title: 'Rent', extractPrompt: 'What rent?' },
      ],
    });
    const c = mount(<TemplateEditor version={v} draft={undefined} onDraftChange={() => {}} {...wiring} />);
    expect(c.textContent).toContain('1 of 2 clauses have a standard position');
  });

  it('says none rather than hiding the line when no clause carries one', () => {
    const v = version({ clauses: structuredClone(twoClauses) });
    const c = mount(<TemplateEditor version={v} draft={undefined} onDraftChange={() => {}} {...wiring} />);
    expect(c.textContent).toContain('0 of 2 clauses have a standard position');
  });
});
```

Check `StandardPosition`'s required fields in `src/types.ts:13` before writing the fixture and match them exactly; `version(...)`, `twoClauses` and `wiring` are the helpers this file already defines at its top.

- [ ] **Step 5: Run the new test, then mutation-test it**

Run: `npx vitest run src/features/templates/TemplateEditor.test.tsx`
Expected: PASS. Now change the filter to `c => c.standardPosition !== undefined ? false : true` and re-run: expected FAIL on the "1 of 2" case. Restore.

- [ ] **Step 6: Walk the state checklist** above — in particular render all four `positionHealthLabel` kinds and confirm `UNTESTED` and `NO POSITION` do not look alike.

- [ ] **Step 7: Run the suite**

Run: `npm test`, then `git status --porcelain -- '*.test.ts' '*.test.tsx'`
Expected: **exactly one** file — `src/features/templates/TemplateEditor.test.tsx` — and that edit is the declared coverage-line test, nothing else.

- [ ] **Step 8: Scan, gate and commit**

```bash
git add src/features/templates/TemplateLibrary.tsx src/features/templates/TemplateEditor.tsx src/features/templates/StandardPositionField.tsx src/features/templates/FieldSuggestion.tsx src/features/templates/PublishDialog.tsx src/features/templates/MegaPromptModal.tsx src/features/templates/VersionHistory.tsx src/features/templates/TemplateEditor.test.tsx
git commit -F .git/COMMIT_G11
```

Message:

```
style(g): restyle the playbook editor, library and version history

Clause cards become real cards on a hairline rather than a gradient
faux-border. Position health keeps four visually distinct kinds: UNTESTED
and NO POSITION are deliberately styled apart, because "we have no rule"
and "we have a rule nothing has tested" are different facts.

One declared copy addition (R-G6): the editor's derived coverage line, "n
of m clauses have a standard position", with its own test. Derived from the
clauses already on screen — no new read, no new state.

No version diff action: VersionHistory already carries each version's
human-authored change summary, and a structured diff of two prompt strings
asserts less than it appears to (R-G15).
```

---

## Task 12: Authoring route group and the shared privacy copy

**Kind:** cosmetic, **plus the one permitted copy MOVE in G-1** — the privacy sentences relocate into a shared module so the intake wizard (Task 19) renders the same words rather than a second paraphrase. **The strings themselves do not change** (R-G5, §8.4).

This is the project's "extract it on the second copy" rule applied before the third copy exists.

**Files:**
- Create: `src/lib/privacyCopy.ts`
- Modify: `src/features/authoring/RouteChooser.tsx`, `DraftForm.tsx`, `DraftReview.tsx`, `ClauseRail.tsx`, `SourcePicker.tsx`
- Modify: `src/features/settings/SettingsPanel.tsx` (to consume the module; its restyle is Task 13)

**Interfaces:**
- Consumes: Task 1's tokens, Task 5's primitives.
- Produces:
  - `export const API_KEY_PRIVACY: string`
  - `export const STORAGE_PRIVACY: readonly [string, string, string]` — the three paragraphs of the "Where your documents go" block, in order
  - `export const SOURCE_PRIVACY: string`
  Task 19's intake wizard footer consumes `STORAGE_PRIVACY[0]`.

**State checklist for this task:**

- `SourcePicker`'s privacy line still renders **only** when a source is selected — `SourcePicker.test.tsx:27` asserts its absence otherwise, and that absence is the point.
- `DraftReview`'s `UNSAVED DRAFT` badge and its discouraged-but-not-blocked save survive exactly.
- `ClauseRail`'s kept/cut/unreviewed chips stay three states.
- `RouteChooser`'s "learn from redlines" card stays rendered and honestly inert (R-E6) — **it is not hidden**.
- `DraftForm`'s validation and its generation error branch survive.

- [ ] **Step 1: Record the baseline** — `npm test`, note the count.

- [ ] **Step 2: Create the shared module**

Create `src/lib/privacyCopy.ts`, copying the strings **character for character** from `SettingsPanel.tsx:90-121` and `SourcePicker.tsx:66-72`:

```ts
/**
 * The privacy and storage disclosures, in one place.
 *
 * Extracted at the SECOND copy rather than the third: sub-project G's
 * intake wizard needs to say the storage sentence at the point of upload,
 * and the alternative was a paraphrase of a disclosure — the one kind of
 * string this app must never have two versions of. These are the SHIPPED
 * words; where a prototype says something different, these win (R-G5).
 *
 * Not exported through findingOutcome.ts: that module is export wording,
 * printed into a DOCX and a CSV. This is screen wording. Two different
 * jobs, deliberately two modules.
 */
export const API_KEY_PRIVACY =
  "Your key is stored only in this browser's local storage and is sent only to OpenRouter "
  + 'when making a request. It is never sent anywhere else.';

export const STORAGE_PRIVACY = [
  'Matters, documents (including the original file bytes), and reviews are stored in '
  + "this browser's IndexedDB — on this device, in this browser, and nowhere else. "
  + 'Nothing is uploaded anywhere except to the model you chose, via OpenRouter, at the '
  + 'moment you run a review.',
  'Deleting a matter deletes its documents and their stored bytes, not just its entry '
  + "in a list. Data is per-browser: clearing this browser's site data removes your "
  + 'matters permanently, and there is no sync or backup.',
  'Page images generated for scanned PDFs are never stored — they’re regenerated from '
  + 'the original file bytes whenever they’re needed again.',
] as const;

export const SOURCE_PRIVACY =
  'Selecting a matter sends its verified findings to the model you have chosen — the only '
  + "place in this app another matter’s content leaves your browser.";
```

Reproduce the whitespace exactly as the JSX renders it: JSX collapses the newlines and indentation in the original blocks to single spaces, so the assembled strings above must match what `textContent` produces today. Verify with the existing tests in Step 5 rather than by eye.

- [ ] **Step 3: Consume it from both existing call sites**

`SettingsPanel.tsx` renders `{API_KEY_PRIVACY}` and `{STORAGE_PRIVACY.map(p => <p key={p}>{p}</p>)}`. `SourcePicker.tsx` renders `{SOURCE_PRIVACY}`. Neither file gains or loses a sentence.

- [ ] **Step 4: Restyle the five authoring components**

Apply Task 7 Step 2's surface mapping and Step 3's type mapping. Specific to this group:

- `RouteChooser`'s three route cards: `bg-card border border-rule rounded-panel hover:border-accent-edge`; the inert redlines card at `opacity-60` with its explanation in `text-ink-2` (**not** `ink-4` — it is a disclosure).
- `DraftForm`'s segmented controls: track `bg-chip-fill rounded-control p-0.5`, active tab `bg-card rounded-inset shadow-tab` — one of the system's two shadows.
- `DraftReview`'s `UNSAVED DRAFT` badge: `font-mono text-chip uppercase text-draft border border-draft rounded-chip px-1.5 py-0.5`.
- `ClauseRail`'s three chips: kept `text-accent`, cut `text-risk-high`, unreviewed `text-ink-4`, all in the `font-mono text-chip uppercase` idiom.
- `SourcePicker`'s privacy line: `bg-risk-med-tint border border-risk-med-edge text-risk-med` — a disclosure, so **never** `ink-4` or below (R-G19).

- [ ] **Step 5: Run the suite with no test edited**

Run: `npm test`
`SourcePicker.test.tsx`'s two assertions (`/sent to the model|leaves your browser|other matters/i` present, and absent when nothing is selected) are exactly the check that the extraction preserved the string. If either fails, the module's whitespace does not match the JSX's — fix the module, not the test.
Run: `git status --porcelain -- '*.test.ts' '*.test.tsx'` (expected: empty).

- [ ] **Step 6: Scan, gate and commit**

```bash
git add src/lib/privacyCopy.ts src/features/authoring/RouteChooser.tsx src/features/authoring/DraftForm.tsx src/features/authoring/DraftReview.tsx src/features/authoring/ClauseRail.tsx src/features/authoring/SourcePicker.tsx src/features/settings/SettingsPanel.tsx
git commit -F .git/COMMIT_G12
```

Message:

```
style(g): restyle authoring, and extract the privacy copy into one module

The disclosure sentences move to src/lib/privacyCopy.ts unchanged, so the
intake wizard can say the same words at the point of upload instead of a
second paraphrase. Extracted on the second copy rather than the third,
because a paraphrase of a disclosure is the one kind of duplication this
app cannot carry (R-G5, §8.4). The strings are byte-identical; SourcePicker's
own tests are what prove it.

The learn-from-redlines card stays rendered and honestly inert (R-E6):
hiding it would misrepresent what the product is.

No test edited.
```

---

## Task 13: Settings and the assistant

**Kind:** cosmetic. Follow the restyle task template.

**Files:**
- Modify: `src/features/settings/SettingsPanel.tsx`, `src/features/assistant/ChatPanel.tsx`, `EmailModal.tsx`, `RevisionModal.tsx`

**Interfaces:**
- Consumes: Task 1's tokens, Task 5's primitives, Task 12's `privacyCopy` module.
- Produces: nothing new.

**State checklist for this task:**

- **Both `SettingsPanel` disclosure blocks render in full, in a bordered card, and are NOT collapsed behind a disclosure triangle** (§9.8). The prototypes have no settings screen at all; this one is designed in the language rather than inherited.
- The disclosure text sits at `ink-2` on `chip-fill` inside an `accent-edge` card — **never `ink-4` or below** (R-G19). This is the app's central privacy claim.
- The model picker keeps its loading, error and empty branches; a failure to list models still says so rather than showing an empty list.
- The API-key field keeps its "not configured" state distinct from "configured".
- `ChatPanel` keeps its "no document text" refusal, its streaming state (Task 3's busy contract), and its error branch. **Ruling R4 keeps the assistant module otherwise untouched** — restyle only.
- `EmailModal` and `RevisionModal` keep `role="dialog"` through the shared `Modal`.

- [ ] **Step 1: Record the baseline** — `npm test`, note the count.

- [ ] **Step 2: Restyle `SettingsPanel`**

Page `bg-paper`; each section `bg-card border border-rule rounded-panel p-6`; section headings `font-prose text-section text-ink-1` (keeping `h3` where the markup uses it); field labels `font-mono text-label uppercase text-ink-4`; inputs `bg-card border border-rule-strong rounded-control font-ui text-ui text-ink-1 focus:ring-1 focus:ring-accent`.

Both disclosure blocks:

```tsx
<div className="flex items-start gap-2 p-3 bg-accent-tint border border-accent-edge rounded-control">
  <ShieldCheck className="w-4 h-4 text-accent shrink-0 mt-0.5" aria-hidden="true" />
  <div className="font-ui text-ui-sm text-ink-2 leading-relaxed space-y-2">
    …
  </div>
</div>
```

- [ ] **Step 3: Restyle the assistant**

`ChatPanel`: `bg-card`; user turns `bg-accent-tint border border-accent-edge rounded-card`; assistant turns `bg-paper border border-rule rounded-card`, prose in `font-prose text-finding text-ink-prose`; the composer `bg-card border-t border-rule`; the streaming indicator through Task 3's `data-busy` contract. `EmailModal` and `RevisionModal`: body `font-prose text-field text-ink-prose`, through the restyled `Modal`.

- [ ] **Step 4: Walk the state checklist** above.

- [ ] **Step 5: Run the suite with no test edited** — `npm test`, then `git status --porcelain -- '*.test.ts' '*.test.tsx'` (expected: empty).

- [ ] **Step 6: Scan, gate and commit**

```bash
git add src/features/settings/SettingsPanel.tsx src/features/assistant/ChatPanel.tsx src/features/assistant/EmailModal.tsx src/features/assistant/RevisionModal.tsx
git commit -F .git/COMMIT_G13
```

Message:

```
style(g): restyle settings and the assistant

Both disclosure blocks stay open in a bordered card rather than collapsing
behind a triangle, and their text stays at ink-2: the app's central privacy
claim is not decorative-grade contrast (R-G19). Their words are unchanged —
they come from the shared module now.

The assistant is restyle only; ruling R4 leaves that module otherwise
alone.

No test edited.
```

---

## Task 14: Un-skip the guards and sweep the last raw colours

**Kind:** enforcement. From this commit, a raw colour anywhere under `src/` is a test failure.

**Files:**
- Modify: `src/test/palette.test.ts` (remove the `.skip`)
- Modify: whatever files the guard still names — expected to be a short tail (`MigrationBlockedScreen`'s inline styles, any remaining `App.tsx` string, the `not-found` view)

**Interfaces:**
- Consumes: Task 2's scanner, Tasks 5–13's restyles.
- Produces: the standing guarantee that every later task (15–23) inherits: no new raw colour can land.

- [ ] **Step 1: See what is left**

```bash
npx vitest run src/test/palette.test.ts
```

with `describe.skip` temporarily changed to `describe`. Read the full violation list. Expected: a short tail in `src/App.tsx` and one or two feature files that no restyle task owned.

- [ ] **Step 2: Fix every remaining violation**

Each one maps onto a role from Task 1. If a violation genuinely has no role — a colour the design system never named — **add the role to `src/index.css` in this commit** (never afterwards) and add its contrast pair to `src/test/contrast.test.ts`'s `PAIRS`, or the "every semantic role is exercised" case fails and tells you so.

- [ ] **Step 3: Remove the `.skip` for good**

```ts
describe('palette guard', () => {
```

and update the block comment above it to say the guard is live, rather than describing a state that no longer exists.

- [ ] **Step 4: Run the guard**

Run: `npx vitest run src/test/palette.test.ts`
Expected: PASS, zero violations.

- [ ] **Step 5: Mutation-test the live guard**

Add `className="text-violet-500"` to any element in `src/components/Button.tsx`, run the guard, confirm it fails naming `components/Button.tsx` and the line. Remove it. Then add `style={{ color: 'var(--lex-teal)' }}` to the same element, confirm the `palette-layer-leak` rule fires, and remove it. **This is the mutation test the definition of done requires; record its output in the commit message.**

- [ ] **Step 6: Full gates and commit**

Run: `npm test && npx tsc --noEmit && npm run build`

```bash
git add src/test/palette.test.ts src/App.tsx <any other file step 2 touched>
git commit -F .git/COMMIT_G14
```

Message:

```
test(g): un-skip the palette guard — a raw colour is now a test failure

The guard has been failing on purpose since task 2, which is how the target
got defined before the work instead of asserted after it. Zero violations
now, across every non-test file under src/ except index.css (where the
tokens live) and PdfCanvas.tsx (canvas draw calls; its overlay divs moved
to the highlight tokens in task 9).

Mutation-tested both rules: a text-violet-500 in Button.tsx fails with the
file and line, and a var(--lex-teal) reached from a component fails as a
palette-layer leak.
```
---

## Task 15: The matter status board's stat row

**Kind:** **structural.** The first of the five screens G inherits (§10.1).

**What it is for:** answering "how much of this matter is actually checked by a human" before anything else on the screen. That is the redesign's thesis, and the matter home is the one screen that does not currently state it.

**Files:**
- Create: `src/lib/matterStats.ts`, `src/lib/matterStats.test.ts`
- Create: `src/features/matters/MatterStats.tsx`, `src/features/matters/MatterStats.test.tsx`
- Modify: `src/features/matters/MatterHome.tsx` (render the row above the existing two-column body)

**Interfaces:**
- Consumes: `verificationCounts` and `VerificationCounts` from `src/lib/findingOutcome.ts` — **the same function both exporters use, so the number on screen and the number in the report cannot drift.** `MatterHome` already receives `reviews: Review[]` with their findings, so this costs no new read.
- Produces:
  - `export interface MatterStatSummary { counts: VerificationCounts; needsAttention: { flagged: number; deviating: number }; risk: Record<RiskLevel, number>; completedReviews: number; running: boolean }`
  - `export function summariseMatter(reviews: Review[]): MatterStatSummary`
  - `export interface MatterStatsProps { reviews: Review[]; reviewsError: string | null; onRetryReviews: () => void }`
  - `export function MatterStats(props: MatterStatsProps): JSX.Element`

- [ ] **Step 1: Write the failing summary tests**

Create `src/lib/matterStats.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { summariseMatter } from './matterStats';
import type { Finding, Review } from '../types';

function finding(over: Partial<Finding> = {}): Finding {
  return { clauseId: 'c1', status: 'done', citations: [], verification: { state: 'unchecked' }, notes: [], ...over };
}

function review(over: Partial<Review> = {}): Review {
  return {
    id: 'r1', matterId: 'm1',
    playbookSnapshot: { id: 'v1', playbookId: 'p1', version: 1, name: 'Lease', contractType: 'lease', systemPrompt: '', formatPrompt: '', clauses: [], changeSummary: '', publishedAt: 1, publishedByUserId: 'u1', schemaVersion: 6 },
    documentIds: ['d1'], target: { kind: 'documents', documentIds: ['d1'] },
    findings: {}, modelId: 'm', startedAt: 1, completedAt: 2, createdByUserId: 'u1',
    ...over,
  };
}

describe('summariseMatter', () => {
  it('sums verification counts across every review in the matter', () => {
    const s = summariseMatter([
      review({ id: 'r1', findings: { d1: { c1: finding({ verification: { state: 'verified' } }), c2: finding() } } }),
      review({ id: 'r2', findings: { d2: { c1: finding({ verification: { state: 'flagged' } }) } } }),
    ]);
    expect(s.counts).toEqual({ total: 3, verified: 1, unchecked: 1, flagged: 1, rejected: 0 });
  });

  it('counts what needs attention: flagged findings and deviations', () => {
    const s = summariseMatter([review({
      findings: { d1: {
        c1: finding({ verification: { state: 'flagged' } }),
        c2: finding({ positionOutcome: 'deviates' }),
        c3: finding({ positionOutcome: 'meets' }),
      } },
    })]);
    expect(s.needsAttention).toEqual({ flagged: 1, deviating: 1 });
  });

  it('counts risk levels, ignoring findings the model never rated', () => {
    const s = summariseMatter([review({
      findings: { d1: {
        c1: finding({ riskLevel: 'High' }), c2: finding({ riskLevel: 'High' }),
        c3: finding({ riskLevel: 'Low' }), c4: finding({ status: 'error' }),
      } },
    })]);
    expect(s.risk).toEqual({ High: 2, Medium: 0, Low: 1, Info: 0 });
  });

  it('reports zero completed reviews for a matter whose only review is still running', () => {
    // R-G10: this is what stops the cards rendering three zeroes. Zero
    // verified out of zero is not a fact about this matter's safety.
    const s = summariseMatter([review({ completedAt: undefined })]);
    expect(s.completedReviews).toBe(0);
    expect(s.running).toBe(true);
  });

  it('does not count a cancelled review as running', () => {
    const s = summariseMatter([review({ completedAt: undefined, cancelledAt: 5 })]);
    expect(s.running).toBe(false);
    expect(s.completedReviews).toBe(0);
  });

  it('returns an all-zero summary with no completed reviews for an empty matter', () => {
    const s = summariseMatter([]);
    expect(s.completedReviews).toBe(0);
    expect(s.counts.total).toBe(0);
  });
});
```

- [ ] **Step 2: Run to watch it fail**

Run: `npx vitest run src/lib/matterStats.test.ts`
Expected: FAIL — cannot resolve `./matterStats`.

- [ ] **Step 3: Write `src/lib/matterStats.ts`**

```ts
import type { Review, RiskLevel } from '../types';
import { verificationCounts, type VerificationCounts } from './findingOutcome';

export interface MatterStatSummary {
  counts: VerificationCounts;
  needsAttention: { flagged: number; deviating: number };
  risk: Record<RiskLevel, number>;
  /** Reviews that actually finished. The stat cards render their EMPTY form
   *  while this is 0 (R-G10) — three zeroes would read as "nothing wrong
   *  here", which is a claim about the matter's safety that nobody made. */
  completedReviews: number;
  /** At least one review started, not completed, not cancelled. */
  running: boolean;
}

/** Pure: whatever reviews the caller already loaded, summarised. Reads no
 *  store, exactly as `positionHealth` does not (R-D2), so the IO stays in
 *  the container and this stays testable.
 *
 *  Verification counting goes through `verificationCounts` rather than a
 *  second loop, because the DOCX report and the CSV quote that same
 *  function: a status board that disagreed with the export about how much
 *  had been checked would be the exact drift `findingOutcome.ts` exists to
 *  prevent. */
export function summariseMatter(reviews: Review[]): MatterStatSummary {
  const counts: VerificationCounts = { total: 0, verified: 0, unchecked: 0, flagged: 0, rejected: 0 };
  const risk: Record<RiskLevel, number> = { High: 0, Medium: 0, Low: 0, Info: 0 };
  let deviating = 0;
  let completedReviews = 0;
  let running = false;

  for (const review of reviews) {
    if (review.completedAt !== undefined) completedReviews++;
    else if (review.cancelledAt === undefined) running = true;

    const c = verificationCounts(review.findings);
    counts.total += c.total;
    counts.verified += c.verified;
    counts.unchecked += c.unchecked;
    counts.flagged += c.flagged;
    counts.rejected += c.rejected;

    for (const byClause of Object.values(review.findings ?? {})) {
      for (const finding of Object.values(byClause ?? {})) {
        if (finding?.riskLevel) risk[finding.riskLevel]++;
        if (finding?.positionOutcome === 'deviates') deviating++;
      }
    }
  }

  return {
    counts,
    needsAttention: { flagged: counts.flagged, deviating },
    risk,
    completedReviews,
    running,
  };
}
```

- [ ] **Step 4: Run to watch it pass, then mutation-test**

Run: `npx vitest run src/lib/matterStats.test.ts` — expected PASS.
Now change `if (review.completedAt !== undefined) completedReviews++;` to `completedReviews++` unconditionally and re-run: expected FAIL on "reports zero completed reviews…". Restore. This is the branch R-G10 rests on.

- [ ] **Step 5: Write the component's failing tests**

Create `src/features/matters/MatterStats.test.tsx`:

```tsx
import React from 'react';
import { describe, it, expect } from 'vitest';
import { mount, buttonNamed } from '../../test/mount';
import { MatterStats } from './MatterStats';
import type { Finding, Review } from '../../types';

function finding(over: Partial<Finding> = {}): Finding {
  return { clauseId: 'c1', status: 'done', citations: [], verification: { state: 'unchecked' }, notes: [], ...over };
}
function review(over: Partial<Review> = {}): Review {
  return {
    id: 'r1', matterId: 'm1',
    playbookSnapshot: { id: 'v1', playbookId: 'p1', version: 1, name: 'Lease', contractType: 'lease', systemPrompt: '', formatPrompt: '', clauses: [], changeSummary: '', publishedAt: 1, publishedByUserId: 'u1', schemaVersion: 6 },
    documentIds: ['d1'], target: { kind: 'documents', documentIds: ['d1'] },
    findings: { d1: { c1: finding({ verification: { state: 'verified' } }), c2: finding() } },
    modelId: 'm', startedAt: 1, completedAt: 2, createdByUserId: 'u1',
    ...over,
  };
}

describe('MatterStats', () => {
  it('shows the verified count over the total once a review has completed', () => {
    const c = mount(<MatterStats reviews={[review()]} reviewsError={null} onRetryReviews={() => {}} />);
    expect(c.textContent).toContain('1');
    expect(c.textContent).toContain('of 2 findings verified');
  });

  it('renders the empty form, not three zeroes, when no review has completed', () => {
    // R-G10. "0 of 0 findings verified" reads as "nothing outstanding".
    const c = mount(<MatterStats reviews={[]} reviewsError={null} onRetryReviews={() => {}} />);
    expect(c.textContent).toContain('No review has run yet');
    expect(c.textContent).not.toContain('of 0 findings verified');
  });

  it('says a run is in progress rather than presenting partial counts as final', () => {
    const c = mount(<MatterStats reviews={[review({ completedAt: undefined })]} reviewsError={null} onRetryReviews={() => {}} />);
    expect(c.textContent).toContain('A review is still running');
  });

  it('renders the load-error panel IN PLACE OF the stat row, with a retry', () => {
    // The stats are derived from the reviews. If the reviews are unknown
    // the statistics are unknown — never zeroes beneath an error.
    const c = mount(
      <MatterStats reviews={[]} reviewsError="This matter's reviews could not be loaded." onRetryReviews={() => {}} />,
    );
    expect(c.textContent).toContain("This matter's reviews could not be loaded.");
    expect(c.textContent).not.toContain('findings verified');
    expect(c.textContent).not.toContain('No review has run yet');
    expect(buttonNamed(c, /^Retry$/)).toBeTruthy();
  });

  it('counts what needs attention without inventing an owner', () => {
    const c = mount(<MatterStats
      reviews={[review({ findings: { d1: { c1: finding({ verification: { state: 'flagged' } }), c2: finding({ positionOutcome: 'deviates' }) } } })]}
      reviewsError={null}
      onRetryReviews={() => {}}
    />);
    expect(c.textContent).toContain('Flagged for follow-up');
    expect(c.textContent).toContain('Deviating from a standard position');
    // The mockup's third count — "unassigned / no owner" — is dropped:
    // nothing assigns to anyone (R-G1).
    expect(c.textContent).not.toMatch(/unassigned|no owner|assigned to/i);
  });
});
```

- [ ] **Step 6: Run to watch it fail** — `npx vitest run src/features/matters/MatterStats.test.tsx`, expected FAIL on the missing module.

- [ ] **Step 7: Write `src/features/matters/MatterStats.tsx`**

```tsx
import React from 'react';
import type { Review, RiskLevel } from '../../types';
import { summariseMatter } from '../../lib/matterStats';
import { LoadErrorPanel } from '../../components/LoadErrorPanel';

export interface MatterStatsProps {
  reviews: Review[];
  /** Non-null replaces the whole row: statistics derived from reviews
   *  nobody could read are not statistics (R-G10). */
  reviewsError: string | null;
  onRetryReviews: () => void;
}

const RISK_ORDER: RiskLevel[] = ['High', 'Medium', 'Low'];
const RISK_INK: Record<RiskLevel, string> = {
  High: 'text-risk-high', Medium: 'text-risk-med', Low: 'text-risk-low', Info: 'text-draft',
};
const RISK_FILL: Record<RiskLevel, string> = {
  High: 'bg-risk-high', Medium: 'bg-risk-med', Low: 'bg-risk-low', Info: 'bg-draft',
};

const CARD = 'bg-card border border-rule rounded-card p-5';

export function MatterStats({ reviews, reviewsError, onRetryReviews }: MatterStatsProps) {
  if (reviewsError) {
    return <LoadErrorPanel compact message={reviewsError} onRetry={onRetryReviews} />;
  }

  const s = summariseMatter(reviews);

  if (s.completedReviews === 0) {
    return (
      <div className={CARD}>
        <p className="font-prose text-section text-ink-1">No review has run yet</p>
        <p className="font-ui text-ui text-ink-2 mt-1">
          {s.running
            ? 'A review is still running. Its findings will appear here as it goes.'
            : 'Run a playbook over this matter’s documents to see how much of it has been checked.'}
        </p>
      </div>
    );
  }

  const pct = (n: number) => (s.counts.total > 0 ? (n / s.counts.total) * 100 : 0);
  const riskTotal = RISK_ORDER.reduce((sum, l) => sum + s.risk[l], 0);

  return (
    <div className="grid gap-4 md:grid-cols-[1.35fr_1fr_1fr]">
      <section className={CARD}>
        <h3 className="font-mono text-label uppercase text-ink-4">Verification progress</h3>
        <p className="mt-2 flex items-baseline gap-2">
          <span className="font-prose text-figure text-ink-1">{s.counts.verified}</span>
          <span className="font-ui text-ui text-ink-2">of {s.counts.total} findings verified</span>
        </p>
        <div className="mt-3 h-2 rounded-inset bg-chip-fill overflow-hidden flex">
          <span className="bg-state-verified" style={{ width: `${pct(s.counts.verified)}%` }} />
          <span className="bg-state-flagged" style={{ width: `${pct(s.counts.flagged)}%` }} />
          <span className="bg-state-rejected" style={{ width: `${pct(s.counts.rejected)}%` }} />
        </div>
        <p className="mt-2 font-ui text-meta text-ink-3">
          {s.counts.verified} verified · {s.counts.flagged} flagged · {s.counts.rejected} rejected · {s.counts.unchecked} unchecked
        </p>
        {s.running && (
          <p className="mt-2 font-ui text-meta text-risk-med">A review is still running, so these counts are not final.</p>
        )}
      </section>

      <section className={CARD}>
        <h3 className="font-mono text-label uppercase text-ink-4">Needs attention</h3>
        <p className="mt-3 flex items-baseline gap-2">
          <span className={`font-mono text-clause ${RISK_INK.Medium}`}>{s.needsAttention.flagged}</span>
          <span className="font-ui text-ui-sm text-ink-2">Flagged for follow-up</span>
        </p>
        <p className="mt-2 flex items-baseline gap-2">
          <span className={`font-mono text-clause ${RISK_INK.High}`}>{s.needsAttention.deviating}</span>
          <span className="font-ui text-ui-sm text-ink-2">Deviating from a standard position</span>
        </p>
      </section>

      <section className={CARD}>
        <h3 className="font-mono text-label uppercase text-ink-4">Risk profile</h3>
        {RISK_ORDER.map(level => (
          <p key={level} className="mt-2 flex items-center gap-2">
            <span className={`w-14 font-mono text-chip uppercase ${RISK_INK[level]}`}>{level}</span>
            <span className="flex-1 h-1.5 rounded-meter bg-chip-fill overflow-hidden">
              <span
                className={`block h-full ${RISK_FILL[level]}`}
                style={{ width: `${riskTotal > 0 ? (s.risk[level] / riskTotal) * 100 : 0}%` }}
              />
            </span>
            <span className="font-mono text-pin text-ink-4">{s.risk[level]}</span>
          </p>
        ))}
      </section>
    </div>
  );
}
```

- [ ] **Step 8: Run to watch it pass, then mutation-test the error branch**

Run: `npx vitest run src/features/matters/MatterStats.test.tsx` — expected PASS.
Now move the `reviewsError` check **below** the summary and render the panel alongside the cards. Re-run: expected FAIL on `not.toContain('findings verified')`. Restore. That branch is R-G10 and it is the whole reason this component takes the error as a prop.

- [ ] **Step 9: Wire it into `MatterHome`**

Render `<MatterStats reviews={reviews} reviewsError={reviewsError} onRetryReviews={onRetryReviews} />` immediately below the matter header and above the existing lower grid. The reviews **section**'s own error branch stays where it is: two panels for one failure is correct here, because one says "the statistics are unknown" and the other says "the review list is unknown", and suppressing either would leave a screen that looks partly fine.

- [ ] **Step 10: Full gates and commit**

Run: `npm test && npx tsc --noEmit && npm run build`

```bash
git add src/lib/matterStats.ts src/lib/matterStats.test.ts src/features/matters/MatterStats.tsx src/features/matters/MatterStats.test.tsx src/features/matters/MatterHome.tsx
git commit -F .git/COMMIT_G15
```

Message:

```
feat(g): add the matter status board's three stat cards

The matter home now leads with how much of the matter a human has actually
checked, which is the redesign's thesis and the one thing this screen did
not say.

Counted with verificationCounts — the same function both exporters use — so
the number on the board and the number in the report cannot drift.

Two branches the mockup does not have and that carry the weight: a matter
with no completed review gets the empty form, never three zeroes, because
zero verified of zero is not a fact about a matter's safety; and a matter
whose reviews failed to load gets the load-error panel IN PLACE OF the row,
because statistics derived from reviews nobody could read are not
statistics (R-G10).

No "unassigned" count: nothing assigns to anyone (R-G1).
```

---

## Task 16: The matter activity list

**Kind:** **structural.** §10.1's right-hand column. **Derived at read time, single-actor, never stored** (R-G9).

Its value survives without collaborators: it answers "what did I last do here, and when". What it must not do is imply someone else did something.

**Files:**
- Create: `src/lib/matterActivity.ts`, `src/lib/matterActivity.test.ts`
- Create: `src/features/matters/MatterActivity.tsx`, `src/features/matters/MatterActivity.test.tsx`
- Modify: `src/features/matters/MatterHome.tsx` (render it in the right column; it needs the local profile id, so `MatterHomeProps` gains `localUserId: string`), `src/App.tsx` (pass `profile?.id ?? ''`)

**Interfaces:**
- Consumes: `Review`, `Finding`, `Note`, `NetPosition` from `src/types.ts` — every input already carries an author and a timestamp: `verification.at`/`byUserId`, `Note.at`/`byUserId`, `netPosition.at`/`byUserId`, `Review.startedAt`/`completedAt`.
- Produces:
  - `export type ActivityKind = 'verified' | 'flagged' | 'rejected' | 'note' | 'net-confirmed' | 'net-amended' | 'review-started' | 'review-completed'`
  - `export interface ActivityEntry { at: number; kind: ActivityKind; clauseTitle?: string; reviewName: string; byYou: boolean }`
  - `export function matterActivity(reviews: Review[], localUserId: string, limit?: number): ActivityEntry[]`
  - `export interface MatterActivityProps { reviews: Review[]; localUserId: string }`

- [ ] **Step 1: Write the failing derivation tests**

Create `src/lib/matterActivity.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { matterActivity } from './matterActivity';
import type { Finding, Review } from '../types';

function finding(over: Partial<Finding> = {}): Finding {
  return { clauseId: 'c1', status: 'done', citations: [], verification: { state: 'unchecked' }, notes: [], ...over };
}
function review(over: Partial<Review> = {}): Review {
  return {
    id: 'r1', matterId: 'm1',
    playbookSnapshot: { id: 'v1', playbookId: 'p1', version: 1, name: 'Lease review', contractType: 'lease', systemPrompt: '', formatPrompt: '', clauses: [{ id: 'c1', title: 'Break right', extractPrompt: '' }], changeSummary: '', publishedAt: 1, publishedByUserId: 'u1', schemaVersion: 6 },
    documentIds: ['d1'], target: { kind: 'documents', documentIds: ['d1'] },
    findings: {}, modelId: 'm', startedAt: 100, createdByUserId: 'u1',
    ...over,
  };
}

describe('matterActivity', () => {
  it('derives an entry per human action, newest first', () => {
    const entries = matterActivity([review({
      startedAt: 100, completedAt: 200,
      findings: { d1: { c1: finding({ verification: { state: 'verified', byUserId: 'me', at: 300 } }) } },
    })], 'me');
    expect(entries.map(e => e.kind)).toEqual(['verified', 'review-completed', 'review-started']);
    expect(entries[0].at).toBe(300);
    expect(entries[0].clauseTitle).toBe('Break right');
    expect(entries[0].reviewName).toBe('Lease review');
  });

  it('marks an action by the local profile as yours', () => {
    const [entry] = matterActivity([review({
      findings: { d1: { c1: finding({ verification: { state: 'flagged', byUserId: 'me', at: 400 } }) } },
    })], 'me');
    expect(entry).toMatchObject({ kind: 'flagged', byYou: true });
  });

  it('does not claim an unrecognised author is you, and invents no other name', () => {
    // R-GP5: there is no store of other display names. The honest render is
    // the event with no actor, never "someone else".
    const [entry] = matterActivity([review({
      findings: { d1: { c1: finding({ verification: { state: 'rejected', byUserId: 'ghost', reason: 'x', at: 400 } }) } },
    })], 'me');
    expect(entry.byYou).toBe(false);
    expect(Object.values(entry)).not.toContain('ghost');
  });

  it('derives notes and net-position confirmations', () => {
    const entries = matterActivity([review({
      findings: { d1: { c1: finding({
        notes: [{ id: 'n1', findingId: 'd1::c1', text: 'Ask the client.', byUserId: 'me', at: 500 }],
        netPosition: { proposed: 'Six months.', state: 'confirmed', byUserId: 'me', at: 600, trail: [] },
      }) } },
    })], 'me');
    expect(entries.map(e => e.kind)).toEqual(['net-confirmed', 'note', 'review-started']);
  });

  it('reports an amended net position as amended, not merely confirmed', () => {
    const [entry] = matterActivity([review({
      findings: { d1: { c1: finding({
        netPosition: { proposed: 'Six months.', amended: 'Nine months.', state: 'confirmed', byUserId: 'me', at: 700, trail: [] },
      }) } },
    })], 'me');
    // Amending is a STRONGER claim than confirming — a person wrote every
    // word — so the feed must not flatten it into "confirmed".
    expect(entry.kind).toBe('net-amended');
  });

  it('skips an unchecked verification, which is not an action anyone took', () => {
    const entries = matterActivity([review({ findings: { d1: { c1: finding() } } })], 'me');
    expect(entries.map(e => e.kind)).toEqual(['review-started']);
  });

  it('skips a verification with no timestamp rather than dating it now', () => {
    const entries = matterActivity([review({
      findings: { d1: { c1: finding({ verification: { state: 'verified', byUserId: 'me' } }) } },
    })], 'me');
    expect(entries.map(e => e.kind)).toEqual(['review-started']);
  });

  it('caps the list', () => {
    const findings: Record<string, Record<string, Finding>> = { d1: {} };
    for (let i = 0; i < 40; i++) {
      findings.d1[`c${i}`] = finding({ clauseId: `c${i}`, verification: { state: 'verified', byUserId: 'me', at: 1000 + i } });
    }
    expect(matterActivity([review({ findings })], 'me', 20)).toHaveLength(20);
  });
});
```

- [ ] **Step 2: Run to watch it fail** — `npx vitest run src/lib/matterActivity.test.ts`, expected FAIL on the missing module.

- [ ] **Step 3: Write `src/lib/matterActivity.ts`**

```ts
import type { Review } from '../types';

export type ActivityKind =
  | 'verified' | 'flagged' | 'rejected' | 'note'
  | 'net-confirmed' | 'net-amended'
  | 'review-started' | 'review-completed';

export interface ActivityEntry {
  at: number;
  kind: ActivityKind;
  /** Absent on a review-level event, which belongs to no clause. */
  clauseTitle?: string;
  reviewName: string;
  /** True when the recorded author is the local profile. An unrecognised
   *  author renders with NO actor rather than an invented one (R-GP5). */
  byYou: boolean;
}

/**
 * A matter's history, derived at read time from data that already carries
 * an author and a timestamp. Nothing is stored (R-G9): an event log would
 * be a second account of what happened, free to drift from the findings it
 * claims to describe.
 *
 * Single-actor by construction. Every line the UI renders reads "You …",
 * and an entry whose `byUserId` matches nothing known is rendered without
 * an actor — never as a colleague, because there are none.
 *
 * An event with no timestamp is DROPPED, not dated `Date.now()`: a feed
 * whose ordering is invented is worse than a feed with a gap.
 */
export function matterActivity(reviews: Review[], localUserId: string, limit = 20): ActivityEntry[] {
  const entries: ActivityEntry[] = [];

  for (const review of reviews) {
    const reviewName = review.playbookSnapshot?.name ?? 'Review';
    const titleOf = (clauseId: string) =>
      review.playbookSnapshot?.clauses?.find(c => c.id === clauseId)?.title;

    entries.push({ at: review.startedAt, kind: 'review-started', reviewName, byYou: review.createdByUserId === localUserId });
    if (review.completedAt !== undefined) {
      entries.push({ at: review.completedAt, kind: 'review-completed', reviewName, byYou: review.createdByUserId === localUserId });
    }

    for (const byClause of Object.values(review.findings ?? {})) {
      for (const finding of Object.values(byClause ?? {})) {
        if (!finding) continue;

        const v = finding.verification;
        if (v && v.state !== 'unchecked' && v.at !== undefined) {
          entries.push({
            at: v.at, kind: v.state, reviewName,
            clauseTitle: titleOf(finding.clauseId),
            byYou: v.byUserId === localUserId,
          });
        }

        for (const note of finding.notes ?? []) {
          entries.push({
            at: note.at, kind: 'note', reviewName,
            clauseTitle: titleOf(finding.clauseId),
            byYou: note.byUserId === localUserId,
          });
        }

        const net = finding.netPosition;
        if (net && net.state === 'confirmed' && net.at !== undefined) {
          entries.push({
            at: net.at,
            // Amending is a stronger claim than confirming — a person wrote
            // every word of it — so the two are different events.
            kind: net.amended !== undefined ? 'net-amended' : 'net-confirmed',
            reviewName,
            clauseTitle: titleOf(finding.clauseId),
            byYou: net.byUserId === localUserId,
          });
        }
      }
    }
  }

  return entries.sort((a, b) => b.at - a.at).slice(0, limit);
}
```

- [ ] **Step 4: Run to watch it pass, then mutation-test**

Run: `npx vitest run src/lib/matterActivity.test.ts` — expected PASS.
Now change the net-position kind to always `'net-confirmed'` and re-run: expected FAIL on "reports an amended net position as amended". Restore. Then drop the `v.at !== undefined` guard and re-run: expected FAIL on "skips a verification with no timestamp". Restore.

- [ ] **Step 5: Write the component's failing tests**

Create `src/features/matters/MatterActivity.test.tsx`:

```tsx
import React from 'react';
import { describe, it, expect } from 'vitest';
import { mount } from '../../test/mount';
import { MatterActivity } from './MatterActivity';
import type { Finding, Review } from '../../types';

function finding(over: Partial<Finding> = {}): Finding {
  return { clauseId: 'c1', status: 'done', citations: [], verification: { state: 'unchecked' }, notes: [], ...over };
}
function review(over: Partial<Review> = {}): Review {
  return {
    id: 'r1', matterId: 'm1',
    playbookSnapshot: { id: 'v1', playbookId: 'p1', version: 1, name: 'Lease review', contractType: 'lease', systemPrompt: '', formatPrompt: '', clauses: [{ id: 'c1', title: 'Break right', extractPrompt: '' }], changeSummary: '', publishedAt: 1, publishedByUserId: 'u1', schemaVersion: 6 },
    documentIds: ['d1'], target: { kind: 'documents', documentIds: ['d1'] },
    findings: {}, modelId: 'm', startedAt: 100, createdByUserId: 'me',
    ...over,
  };
}

describe('MatterActivity', () => {
  it('says nothing is recorded rather than rendering a placeholder row', () => {
    const c = mount(<MatterActivity reviews={[]} localUserId="me" />);
    expect(c.textContent).toContain('Nothing recorded in this matter yet.');
    expect(c.querySelectorAll('li')).toHaveLength(0);
  });

  it('writes your own actions in the first person', () => {
    const c = mount(<MatterActivity reviews={[review({
      findings: { d1: { c1: finding({ verification: { state: 'verified', byUserId: 'me', at: 300 } }) } },
    })]} localUserId="me" />);
    expect(c.textContent).toContain('You verified');
    expect(c.textContent).toContain('Break right');
  });

  it('names no second actor for an unrecognised author', () => {
    const c = mount(<MatterActivity reviews={[review({
      findings: { d1: { c1: finding({ verification: { state: 'flagged', byUserId: 'ghost', at: 300 } }) } },
    })]} localUserId="me" />);
    expect(c.textContent).toContain('Flagged');
    expect(c.textContent).not.toMatch(/You flagged|by ghost|someone/i);
  });

  it('never says a flag was raised FOR anybody', () => {
    // "…flagged for M. Okafor" is dropped: a flag is flagged, full stop.
    // Flagging reaches no one (R-G1).
    const c = mount(<MatterActivity reviews={[review({
      findings: { d1: { c1: finding({ verification: { state: 'flagged', byUserId: 'me', at: 300 } }) } },
    })]} localUserId="me" />);
    expect(c.textContent).not.toMatch(/flagged for/i);
  });
});
```

- [ ] **Step 6: Run to watch it fail** — expected FAIL on the missing module.

- [ ] **Step 7: Write `src/features/matters/MatterActivity.tsx`**

```tsx
import React from 'react';
import { CheckCheck, Flag, XCircle, MessageSquare, GitBranch, Play, Check } from 'lucide-react';
import type { Review } from '../../types';
import { matterActivity, type ActivityEntry, type ActivityKind } from '../../lib/matterActivity';

export interface MatterActivityProps {
  reviews: Review[];
  /** The local profile's id. An entry authored by it reads "You …"; one
   *  authored by anything else reads with no actor at all (R-GP5). */
  localUserId: string;
}

const ICON: Record<ActivityKind, { Icon: typeof Check; ink: string }> = {
  verified: { Icon: CheckCheck, ink: 'text-state-verified' },
  flagged: { Icon: Flag, ink: 'text-state-flagged' },
  rejected: { Icon: XCircle, ink: 'text-state-rejected' },
  note: { Icon: MessageSquare, ink: 'text-ink-3' },
  'net-confirmed': { Icon: GitBranch, ink: 'text-net-confirmed' },
  'net-amended': { Icon: GitBranch, ink: 'text-net-amended' },
  'review-started': { Icon: Play, ink: 'text-ink-3' },
  'review-completed': { Icon: Check, ink: 'text-ink-3' },
};

const VERB: Record<ActivityKind, { you: string; passive: string }> = {
  verified: { you: 'You verified', passive: 'Verified' },
  flagged: { you: 'You flagged', passive: 'Flagged' },
  rejected: { you: 'You rejected', passive: 'Rejected' },
  note: { you: 'You noted on', passive: 'Note added on' },
  'net-confirmed': { you: 'You confirmed the net position on', passive: 'Net position confirmed on' },
  'net-amended': { you: 'You amended the net position on', passive: 'Net position amended on' },
  'review-started': { you: 'You started', passive: 'Started' },
  'review-completed': { you: 'Completed', passive: 'Completed' },
};

function line(entry: ActivityEntry): string {
  const verb = entry.byYou ? VERB[entry.kind].you : VERB[entry.kind].passive;
  return entry.clauseTitle ? `${verb} ${entry.clauseTitle}` : `${verb} ${entry.reviewName}`;
}

export function MatterActivity({ reviews, localUserId }: MatterActivityProps) {
  const entries = matterActivity(reviews, localUserId);

  return (
    <section className="bg-card border border-rule rounded-card p-5">
      <h3 className="font-prose text-section text-ink-1">Activity</h3>
      {entries.length === 0 ? (
        <p className="mt-2 font-ui text-ui text-ink-2">Nothing recorded in this matter yet.</p>
      ) : (
        <ul className="mt-3 space-y-3">
          {entries.map((entry, i) => {
            const { Icon, ink } = ICON[entry.kind];
            return (
              <li key={`${entry.at}-${entry.kind}-${i}`} className="flex items-start gap-2.5">
                <Icon className={`w-3.5 h-3.5 mt-0.5 shrink-0 ${ink}`} aria-hidden="true" />
                <span className="font-ui text-ui-sm text-ink-2 leading-relaxed">
                  {line(entry)}
                  {entry.clauseTitle && (
                    <span className="text-ink-4"> · {entry.reviewName}</span>
                  )}
                </span>
                <time className="ml-auto shrink-0 font-mono text-pin text-ink-5">
                  {new Date(entry.at).toLocaleString()}
                </time>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
```

- [ ] **Step 8: Run to watch it pass, then mutation-test**

Run: `npx vitest run src/features/matters/MatterActivity.test.tsx` — expected PASS.
Now change `line` to always use `VERB[entry.kind].you` and re-run: expected FAIL on "names no second actor for an unrecognised author". Restore.

- [ ] **Step 9: Wire it into `MatterHome`**

Add `localUserId: string` to `MatterHomeProps` with a doc comment saying it is the local profile's id and that the activity list is the only consumer. Render `<MatterActivity reviews={reviews} localUserId={localUserId} />` as the right column of the lower grid. In `App.tsx`, pass `localUserId={profile?.id ?? ''}` — an empty id simply means nothing reads as yours, which is the honest degradation.

- [ ] **Step 10: Full gates and commit**

Run: `npm test && npx tsc --noEmit && npm run build`

```bash
git add src/lib/matterActivity.ts src/lib/matterActivity.test.ts src/features/matters/MatterActivity.tsx src/features/matters/MatterActivity.test.tsx src/features/matters/MatterHome.tsx src/App.tsx
git commit -F .git/COMMIT_G16
```

Message:

```
feat(g): add the matter activity list, derived and single-actor

Every line comes from data that already carries an author and a timestamp —
verification.at, Note.at, netPosition.at, Review.startedAt. Nothing is
stored (R-G9): an event log would be a second account of what happened,
free to drift from the findings it describes.

It reads "You verified…" for the local profile and renders no actor at all
for an author it does not recognise. It never says a flag was raised FOR
anyone, because flagging reaches no one (R-G1, R-GP5). Empty renders
"Nothing recorded in this matter yet." — never a placeholder row.

An event with no timestamp is dropped rather than dated now: a feed whose
ordering is invented is worse than a feed with a gap.
```

---

## Task 17: The export-gate banner

**Kind:** **structural.** Drawn in `1b`, specified by nobody (§10.3).

G builds it because every clause of its sentence is already true and already enforced: export is never blocked (B §7), and `verificationLabel` already writes `UNVERIFIED AI OUTPUT` into both exporters. The banner states the export's behaviour at the moment the user is deciding whether to export — the honest place for it.

**Files:**
- Create: `src/features/review/ExportGateBanner.tsx`, `src/features/review/ExportGateBanner.test.tsx`
- Modify: `src/App.tsx:2782-2797` (render it with the four run banners, above the results pane)

**Interfaces:**
- Consumes: `verificationCounts` / `VerificationCounts` from `src/lib/findingOutcome.ts`.
- Produces:
  - `export interface ExportGateBannerProps { findings: Review['findings']; onReviewUnchecked?: () => void }`
  - `export function ExportGateBanner(props: ExportGateBannerProps): JSX.Element | null`

- [ ] **Step 1: Write the failing tests**

Create `src/features/review/ExportGateBanner.test.tsx`:

```tsx
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { mount, buttonNamed, click } from '../../test/mount';
import { ExportGateBanner } from './ExportGateBanner';
import type { Finding } from '../../types';

function finding(state: Finding['verification']['state']): Finding {
  return { clauseId: 'c1', status: 'done', citations: [], verification: { state }, notes: [] };
}

describe('ExportGateBanner', () => {
  it('states the count and what the export will say about them', () => {
    const c = mount(<ExportGateBanner findings={{ d1: { c1: finding('unchecked'), c2: finding('unchecked'), c3: finding('verified') } }} />);
    expect(c.textContent).toContain('2 findings are unchecked.');
    expect(c.textContent).toContain('Export is available, but the report will mark them as unverified AI output.');
  });

  it('renders nothing at all when everything has been checked', () => {
    const c = mount(<ExportGateBanner findings={{ d1: { c1: finding('verified'), c2: finding('rejected') } }} />);
    expect(c.textContent).toBe('');
  });

  it('renders nothing for a review with no findings', () => {
    const c = mount(<ExportGateBanner findings={{}} />);
    expect(c.textContent).toBe('');
  });

  it('offers a way to the unchecked findings when the caller supplies one', () => {
    const onReviewUnchecked = vi.fn();
    const c = mount(<ExportGateBanner findings={{ d1: { c1: finding('unchecked') } }} onReviewUnchecked={onReviewUnchecked} />);
    click(buttonNamed(c, /Review unchecked/));
    expect(onReviewUnchecked).toHaveBeenCalled();
  });

  it('renders as a banner with no control that could block an export', () => {
    // It must not block, disable, or gate the export button (§10.3).
    const c = mount(<ExportGateBanner findings={{ d1: { c1: finding('unchecked') } }} />);
    expect(c.querySelectorAll('button')).toHaveLength(0);
    expect(c.querySelectorAll('[disabled]')).toHaveLength(0);
  });

  it('uses the singular for one unchecked finding', () => {
    const c = mount(<ExportGateBanner findings={{ d1: { c1: finding('unchecked') } }} />);
    expect(c.textContent).toContain('1 finding is unchecked.');
  });
});
```

- [ ] **Step 2: Run to watch it fail** — expected FAIL on the missing module.

- [ ] **Step 3: Write `src/features/review/ExportGateBanner.tsx`**

```tsx
import React from 'react';
import { TriangleAlert } from 'lucide-react';
import type { Review } from '../../types';
import { verificationCounts } from '../../lib/findingOutcome';

export interface ExportGateBannerProps {
  findings: Review['findings'];
  /** Sends the reader to the first unchecked finding. Omitted, the banner
   *  states the fact and offers nothing to click — which is still the
   *  honest thing to say at the moment someone is deciding to export. */
  onReviewUnchecked?: () => void;
}

/**
 * "N findings are unchecked. Export is available, but the report will mark
 * them as unverified AI output."
 *
 * Every clause of that sentence is already true and already enforced:
 * export is never blocked (B §7), and `verificationLabel` already writes
 * UNVERIFIED AI OUTPUT into both exporters. This says so where the decision
 * is made rather than leaving the reader to discover it in the file.
 *
 * It must never block, disable or gate the export button. It is a
 * statement, not a gate — the name is the mockup's, not a description of
 * what it does.
 */
export function ExportGateBanner({ findings, onReviewUnchecked }: ExportGateBannerProps) {
  const { unchecked } = verificationCounts(findings);
  if (unchecked === 0) return null;

  return (
    <div className="shrink-0 border-b border-risk-med-edge bg-risk-med-tint px-6 py-2.5 flex items-center gap-3">
      <TriangleAlert className="w-4 h-4 shrink-0 text-risk-med" aria-hidden="true" />
      <span className="font-ui text-ui-sm text-risk-med">
        <span className="font-semibold">
          {unchecked === 1 ? '1 finding is unchecked.' : `${unchecked} findings are unchecked.`}
        </span>{' '}
        Export is available, but the report will mark them as unverified AI output.
      </span>
      {onReviewUnchecked && (
        <button
          type="button"
          onClick={onReviewUnchecked}
          className="ml-auto shrink-0 font-ui text-meta font-semibold text-risk-med hover:underline"
        >
          Review unchecked →
        </button>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run to watch it pass, then mutation-test**

Run: `npx vitest run src/features/review/ExportGateBanner.test.tsx` — expected PASS.
Now change `if (unchecked === 0) return null;` to `if (false) return null;` and re-run: expected FAIL on both "renders nothing" cases. Restore. That early return is the whole component: a banner that renders "0 findings are unchecked" at the top of a fully-checked review is noise that teaches the reader to ignore the banner.

- [ ] **Step 5: Wire it into `App.tsx`**

Immediately below the four run banners at `src/App.tsx:2782-2797`:

```tsx
              {/* Stated where the export decision is made. Renders nothing
                  when everything has been checked, and gates nothing ever:
                  export is never blocked (B §7, §10.3). */}
              <ExportGateBanner findings={run.findings} />
```

`onReviewUnchecked` is left unwired for now — `ResultsView`'s `openAt` prop is scoped to a document+clause pair and Task 23 is where the clause index makes "the first unchecked finding" a place the reader can be sent. Passing a handler that scrolls nowhere would be worse than a plain statement.

- [ ] **Step 6: Full gates and commit**

Run: `npm test && npx tsc --noEmit && npm run build`

```bash
git add src/features/review/ExportGateBanner.tsx src/features/review/ExportGateBanner.test.tsx src/App.tsx
git commit -F .git/COMMIT_G17
```

Message:

```
feat(g): add the export-gate banner

"N findings are unchecked. Export is available, but the report will mark
them as unverified AI output." Every clause of that is already true and
already enforced — verificationLabel writes UNVERIFIED AI OUTPUT into both
exporters, and export is never blocked. The banner says it where the
decision is being made instead of leaving the reader to find it in the
file.

It renders nothing at zero unchecked, and it gates nothing: no disabled
button, no blocked export. The name is the mockup's, not a description of
what it does.
```
---

## Task 18: The first-run intake wizard — steps 1 and 2

**Kind:** **structural.** §10.2.

**What it is for:** replacing "build a template before anything happens" with "name a matter, drop documents, see what the app made of them". Its real value in *this* app is that it puts three things the user currently has to hunt for at the moment they matter: the suggested collection grouping, the parse and scan results per document, and the privacy disclosure.

**Shape:** a three-step tracker rendered as **the empty state of a matter**, not a new route. A matter with no documents shows the wizard; a matter with documents shows the status board. This is the handoff's own instruction and it costs no routing change.

This task builds the tracker and steps 1–2. Task 19 builds step 3 and replaces `MatterHome`'s empty branch with it.

**Files:**
- Create: `src/features/matters/IntakeWizard.tsx`, `src/features/matters/IntakeWizard.test.tsx`

**Interfaces:**
- Consumes: `suggestCollections` / `CollectionSuggestion` from `src/lib/collectionSuggest.ts`; `assessDocument` from `src/lib/modelContext.ts`; `STORAGE_PRIVACY` from Task 12's `src/lib/privacyCopy.ts`; `Button`, `LoadErrorPanel`.
- Produces (Task 19 fills in the playbook half):
  ```ts
  export interface IntakeWizardProps {
    matter: Matter;
    documents: DocumentRecord[];
    documentsError: string | null;
    onRetryDocuments: () => void;
    onAddDocuments: (files: File[]) => Promise<void>;
    onRemoveDocument: (documentId: string) => Promise<void>;
    onCreateCollection: (params: { name: string; baseDocumentId: string; variesDocumentIds: string[] }) => Promise<void>;
    /** Task 19. */
    playbooks: Playbook[];
    playbooksError: string | null;
    onRetryPlaybooks: () => void;
    onRunReview: (playbook: Playbook) => Promise<void>;
    onCreatePlaybook: () => void;
    modelId: string;
    onOpenSettings: () => void;
  }
  export function IntakeWizard(props: IntakeWizardProps): JSX.Element
  ```

**What this screen must NOT do (§10.2, and each has a ruling):**

- **No OCR progress bar.** The app does not OCR. Drawing a progress bar for work it does not perform is precisely the failure §2 forbids (R-G13).
- **No AI playbook suggestion banner.** "These look like a commercial lease…" is a model call with a prompt contract, a cost, and a failure mode — a confidently wrong playbook choice at the moment the user is least able to judge it (R-G12).
- **Suggested collections propose and never create** (R-C4). The user accepts one; nothing is grouped on their behalf.

- [ ] **Step 1: Write the failing tests for steps 1–2**

Create `src/features/matters/IntakeWizard.test.tsx`:

```tsx
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { mount, buttonNamed, click } from '../../test/mount';
import { IntakeWizard } from './IntakeWizard';
import type { DocumentRecord, Matter } from '../../types';

const matter: Matter = { id: 'm1', name: 'Ackroyd v Bell', ownerId: 'me', createdAt: 1, updatedAt: 1 };

function doc(over: Partial<DocumentRecord> = {}): DocumentRecord {
  return {
    id: 'd1', matterId: 'm1', name: 'Lease.pdf', kind: 'pdf',
    text: '[Page 1]\nThis lease is made between the parties on the date written below, and continues.',
    byteSize: 100, addedAt: 1, addedByUserId: 'me', role: 'standalone', ...over,
  };
}

const wiring = {
  documentsError: null,
  onRetryDocuments: () => {},
  onAddDocuments: async () => {},
  onRemoveDocument: async () => {},
  onCreateCollection: async () => {},
  playbooks: [],
  playbooksError: null,
  onRetryPlaybooks: () => {},
  onRunReview: async () => {},
  onCreatePlaybook: () => {},
  modelId: 'anthropic/claude-3.5-sonnet',
  onOpenSettings: () => {},
};

describe('IntakeWizard — the tracker and step 1', () => {
  it('shows the three steps and names the matter', () => {
    const c = mount(<IntakeWizard matter={matter} documents={[]} {...wiring} />);
    expect(c.textContent).toContain('Matter');
    expect(c.textContent).toContain('Documents');
    expect(c.textContent).toContain('Playbook');
    expect(c.textContent).toContain('Ackroyd v Bell');
  });

  it('carries the storage disclosure in its footer, in the shipped words', () => {
    const c = mount(<IntakeWizard matter={matter} documents={[]} {...wiring} />);
    expect(c.textContent).toContain("this browser's IndexedDB — on this device, in this browser, and nowhere else");
  });

  it('names the model and offers a way to change it', () => {
    const c = mount(<IntakeWizard matter={matter} documents={[]} {...wiring} />);
    expect(c.textContent).toContain('anthropic/claude-3.5-sonnet');
    expect(buttonNamed(c, /Settings/)).toBeTruthy();
  });
});

describe('IntakeWizard — step 2 reports what ingestion actually produced', () => {
  it('shows a parse failure inline, with a way to remove the document', () => {
    const c = mount(<IntakeWizard matter={matter} documents={[doc({ parseError: 'This PDF is encrypted and could not be read.' })]} {...wiring} />);
    expect(c.textContent).toContain('This PDF is encrypted and could not be read.');
    expect(buttonNamed(c, /Remove/)).toBeTruthy();
  });

  it('does not draw a progress bar for OCR the app does not perform', () => {
    // R-G13. The app does not OCR; a progress bar for work it never does is
    // the exact failure the state-preservation rule forbids.
    const c = mount(<IntakeWizard matter={matter} documents={[doc({ text: '' })]} {...wiring} />);
    expect(c.textContent).not.toMatch(/OCR|Running OCR|\d+%/);
  });

  it('says plainly that a scanned document needs a vision-capable model', () => {
    const c = mount(<IntakeWizard matter={matter} documents={[doc({ text: '[Page 1]\n \n[Page 2]\n ' })]} {...wiring} />);
    expect(c.textContent).toContain('No text could be extracted');
    expect(c.textContent).toContain('vision-capable model');
  });

  it('carries a tracked-changes notice where one was recorded', () => {
    const c = mount(<IntakeWizard matter={matter} documents={[doc({ kind: 'docx', markupNotice: 'This document contains tracked changes; they were accepted before extraction.' })]} {...wiring} />);
    expect(c.textContent).toContain('This document contains tracked changes; they were accepted before extraction.');
  });

  it('proposes a collection without creating one', () => {
    const onCreateCollection = vi.fn(async () => {});
    const c = mount(<IntakeWizard
      matter={matter}
      documents={[doc({ id: 'd1', name: 'Ackroyd Lease.pdf' }), doc({ id: 'd2', name: 'Ackroyd Lease - Deed of Variation.pdf' })]}
      {...wiring}
      onCreateCollection={onCreateCollection}
    />);
    expect(c.textContent).toMatch(/read together|collection/i);
    // R-C4: proposed, never created. Nothing has been grouped until the
    // reader accepts it.
    expect(onCreateCollection).not.toHaveBeenCalled();
    click(buttonNamed(c, /Group these/));
    expect(onCreateCollection).toHaveBeenCalledTimes(1);
  });

  it('renders the load-error panel instead of the document list when documents cannot be read', () => {
    const c = mount(<IntakeWizard matter={matter} documents={[]} {...wiring} documentsError="This matter's documents could not be loaded." />);
    expect(c.textContent).toContain("This matter's documents could not be loaded.");
    expect(buttonNamed(c, /^Retry$/)).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run to watch it fail** — `npx vitest run src/features/matters/IntakeWizard.test.tsx`, expected FAIL on the missing module.

- [ ] **Step 3: Write the wizard's shell, tracker, step 1 and step 2**

Create `src/features/matters/IntakeWizard.tsx`. Step 3's body is a placeholder element in this commit and Task 19 replaces it — but **the file's props already declare the step-3 wiring** (above), so Task 19 changes no signature.

```tsx
import React from 'react';
import { FileWarning, ScanSearch, Layers, Trash2 } from 'lucide-react';
import type { DocumentRecord, Matter, Playbook } from '../../types';
import { suggestCollections } from '../../lib/collectionSuggest';
import { assessDocument } from '../../lib/modelContext';
import { STORAGE_PRIVACY } from '../../lib/privacyCopy';
import { LoadErrorPanel } from '../../components/LoadErrorPanel';
import { Button } from '../../components/Button';

const STEPS = ['Matter', 'Documents', 'Playbook'] as const;

/**
 * A document record carries no page images by design (they are derived data,
 * regenerated on demand and never stored), so this asks the narrower
 * question the record can answer: did any usable text come out of it?
 * `assessDocument` with `modelSupportsImages: false` returns `unreadable`
 * exactly when it did not — which is the fact worth stating here, once,
 * before the run, rather than once per clause afterwards.
 */
function noUsableText(doc: DocumentRecord): boolean {
  return assessDocument({ text: doc.text }, false).kind === 'unreadable';
}

export function IntakeWizard({
  matter, documents, documentsError, onRetryDocuments, onAddDocuments, onRemoveDocument,
  onCreateCollection, playbooks, playbooksError, onRetryPlaybooks, onRunReview, onCreatePlaybook,
  modelId, onOpenSettings,
}: IntakeWizardProps) {
  const suggestions = documents.length > 1 ? suggestCollections(documents) : [];
  const step = documents.length === 0 ? 2 : 3;

  return (
    <div className="max-w-3xl mx-auto p-8 space-y-6">
      <ol className="flex items-center gap-6">
        {STEPS.map((label, i) => (
          <li key={label} className="flex items-center gap-2">
            <span className={`w-5 h-5 rounded-meter flex items-center justify-center font-mono text-chip ${i + 1 <= step ? 'bg-accent text-page' : 'bg-chip-fill text-ink-4'}`}>
              {i + 1}
            </span>
            <span className={`font-mono text-label uppercase ${i + 1 <= step ? 'text-ink-1' : 'text-ink-4'}`}>{label}</span>
          </li>
        ))}
      </ol>

      <section className="bg-card border border-rule rounded-card p-5">
        <h2 className="font-prose text-matter-title text-ink-1">{matter.name}</h2>
        {matter.client && <p className="font-ui text-ui text-ink-2 mt-1">{matter.client}</p>}
      </section>

      <section className="bg-card border border-rule rounded-card p-5 space-y-4">
        <h3 className="font-prose text-section text-ink-1">Documents</h3>

        {documentsError ? (
          <LoadErrorPanel compact message={documentsError} onRetry={onRetryDocuments} />
        ) : (
          <>
            <label className="block border border-dashed border-rule-strong rounded-panel p-8 text-center cursor-pointer hover:border-accent-edge">
              <input
                type="file"
                multiple
                className="sr-only"
                onChange={(e) => { const files = Array.from(e.target.files ?? []); if (files.length) void onAddDocuments(files); }}
              />
              <span className="font-ui text-ui text-ink-2">Drop contracts here, or choose files</span>
            </label>

            <ul className="space-y-3">
              {documents.map(doc => (
                <li key={doc.id} className="border border-rule rounded-control p-3 space-y-2">
                  <div className="flex items-center gap-2">
                    <span className="font-ui text-ui text-ink-1 truncate">{doc.name}</span>
                    <span className="font-mono text-pin text-ink-4 uppercase">{doc.kind}</span>
                    <button
                      onClick={() => void onRemoveDocument(doc.id)}
                      aria-label={`Remove ${doc.name}`}
                      title="Remove"
                      className="ml-auto p-1 rounded-inset text-ink-4 hover:text-risk-high"
                    >
                      <Trash2 className="w-4 h-4" aria-hidden="true" />
                      <span className="sr-only">Remove</span>
                    </button>
                  </div>

                  {doc.parseError && (
                    <p className="flex items-start gap-2 font-ui text-ui-sm text-risk-high bg-risk-high-tint border border-risk-high-edge rounded-inset p-2">
                      <FileWarning className="w-4 h-4 shrink-0 mt-0.5" aria-hidden="true" />
                      <span>{doc.parseError}</span>
                    </p>
                  )}

                  {!doc.parseError && noUsableText(doc) && (
                    <p className="flex items-start gap-2 font-ui text-ui-sm text-risk-med bg-risk-med-tint border border-risk-med-edge rounded-inset p-2">
                      <ScanSearch className="w-4 h-4 shrink-0 mt-0.5" aria-hidden="true" />
                      <span>
                        No text could be extracted from this document — it looks like a scan.
                        Reviewing it needs a vision-capable model.
                      </span>
                    </p>
                  )}

                  {doc.markupNotice && (
                    <p className="font-ui text-ui-sm text-risk-med bg-risk-med-tint border border-risk-med-edge rounded-inset p-2">
                      {doc.markupNotice}
                    </p>
                  )}
                </li>
              ))}
            </ul>

            {suggestions.map(s => (
              <div key={s.baseDocumentId} className="border border-accent-edge bg-accent-tint rounded-control p-3 flex items-start gap-2">
                <Layers className="w-4 h-4 shrink-0 mt-0.5 text-accent" aria-hidden="true" />
                <div className="min-w-0">
                  <p className="font-ui text-ui text-ink-1">{s.name} — read together</p>
                  <p className="font-ui text-ui-sm text-ink-2 mt-0.5">{s.reason}</p>
                </div>
                <Button
                  variant="ghost"
                  className="ml-auto shrink-0"
                  onClick={() => void onCreateCollection({ name: s.name, baseDocumentId: s.baseDocumentId, variesDocumentIds: s.variesDocumentIds })}
                >
                  Group these
                </Button>
              </div>
            ))}
          </>
        )}
      </section>

      {/* Task 19 replaces this section with the playbook step. */}
      <section className="bg-card border border-rule rounded-card p-5" data-step="playbook" />

      <footer className="space-y-2">
        <p className="font-ui text-ui-sm text-ink-2">{STORAGE_PRIVACY[0]}</p>
        <p className="font-ui text-meta text-ink-3">
          Reviews will run on <span className="font-mono text-pin text-ink-2">{modelId}</span>.{' '}
          <button type="button" onClick={onOpenSettings} className="text-accent hover:underline">
            Settings
          </button>
        </p>
      </footer>
    </div>
  );
}
```

Declare `IntakeWizardProps` above the component exactly as the **Interfaces** block gives it, with `playbooks`, `playbooksError`, `onRetryPlaybooks`, `onRunReview` and `onCreatePlaybook` marked in a comment as Task 19's, so `tsc` accepts the unused destructured names only because they are consumed in the next task — if `noUnusedLocals` complains, prefix them in this commit by rendering the placeholder section as `data-step="playbook"` and reading `playbooks.length` into an `aria-hidden` count, then delete that in Task 19.

- [ ] **Step 4: Run to watch it pass** — expected PASS on all nine cases.

- [ ] **Step 5: Mutation-test the two branches that carry the honesty**

Change `noUsableText` to `return false` and re-run: expected FAIL on "says plainly that a scanned document needs a vision-capable model". Restore.
Change the `Group these` button to call `onCreateCollection` on mount (in an effect) and re-run: expected FAIL on "proposes a collection without creating one" at the `not.toHaveBeenCalled()` assertion. Restore. R-C4 is the rule that suggestion proposes and never creates.

- [ ] **Step 6: Full gates and commit**

Run: `npm test && npx tsc --noEmit && npm run build`

```bash
git add src/features/matters/IntakeWizard.tsx src/features/matters/IntakeWizard.test.tsx
git commit -F .git/COMMIT_G18
```

Message:

```
feat(g): add the first-run intake wizard's tracker, matter step and documents step

Step 2 reports what ingestion actually produced: a parse failure inline
with a remove action, a scan saying plainly that reviewing it needs a
vision-capable model — the fact modelContext already enforces, stated once
before the run rather than once per clause after it — and a docx's tracked-
changes notice carried through.

No OCR progress bar: the app does not OCR, and drawing a progress bar for
work it never performs is the exact failure this project's founding rule
forbids (R-G13). Suggested collections propose and never create (R-C4).

The footer carries the storage disclosure from the shared module, in the
shipped words.
```

---

## Task 19: The intake wizard's playbook step, and the matter empty state

**Kind:** **structural.** Completes §10.2 and swaps it in for `MatterHome`'s current "No documents yet" branch.

**Files:**
- Modify: `src/features/matters/IntakeWizard.tsx`, `src/features/matters/IntakeWizard.test.tsx`
- Modify: `src/features/matters/MatterHome.tsx` (the `documents.length === 0` branch at `MatterHome.tsx:412-414`)
- Modify: `src/App.tsx` (pass `modelId` and `onOpenSettings` through to `MatterHome`)

**Interfaces:**
- Consumes: `IntakeWizardProps` as Task 18 declared it — **no signature change**.
- Produces: `MatterHomeProps` gains `modelId: string` and `onOpenSettings: () => void`.

- [ ] **Step 1: Write the failing tests for step 3 and the empty-state swap**

Append to `src/features/matters/IntakeWizard.test.tsx`:

```tsx
describe('IntakeWizard — step 3 chooses a playbook', () => {
  const playbook = (id: string, name: string, updatedAt: number): Playbook =>
    ({ id, name, createdAt: 1, updatedAt, currentVersionId: `v-${id}`, schemaVersion: 6 });

  it('lists the user’s playbooks, most recently used first', () => {
    const c = mount(<IntakeWizard
      matter={matter}
      documents={[doc()]}
      {...wiring}
      playbooks={[playbook('p1', 'Old lease', 100), playbook('p2', 'Recent lease', 900)]}
    />);
    const names = Array.from(c.querySelectorAll('[data-playbook-name]')).map(el => el.textContent);
    expect(names).toEqual(['Recent lease', 'Old lease']);
  });

  it('offers a route to create one when there are none, rather than an empty list', () => {
    const onCreatePlaybook = vi.fn();
    const c = mount(<IntakeWizard matter={matter} documents={[doc()]} {...wiring} onCreatePlaybook={onCreatePlaybook} />);
    expect(c.textContent).toContain('You have no playbooks yet');
    click(buttonNamed(c, /Create a playbook/));
    expect(onCreatePlaybook).toHaveBeenCalled();
  });

  it('renders the load-error panel instead of the playbook list when the library cannot be read', () => {
    const c = mount(<IntakeWizard matter={matter} documents={[doc()]} {...wiring} playbooksError="The playbook library could not be loaded." />);
    expect(c.textContent).toContain('The playbook library could not be loaded.');
    expect(c.textContent).not.toContain('You have no playbooks yet');
  });

  it('never suggests which playbook to use', () => {
    // R-G12: "These look like a commercial lease…" is a model call with a
    // prompt contract, a cost, and a confidently-wrong-at-the-worst-moment
    // failure mode. None of that is a styling decision.
    const c = mount(<IntakeWizard matter={matter} documents={[doc()]} {...wiring} playbooks={[playbook('p1', 'Lease', 1)]} />);
    expect(c.textContent).not.toMatch(/these look like|we suggest|recommended for these/i);
  });

  it('runs the chosen playbook', async () => {
    const onRunReview = vi.fn(async () => {});
    const c = mount(<IntakeWizard matter={matter} documents={[doc()]} {...wiring} playbooks={[playbook('p1', 'Lease', 1)]} onRunReview={onRunReview} />);
    click(buttonNamed(c, /Run this playbook/));
    expect(onRunReview).toHaveBeenCalledWith(expect.objectContaining({ id: 'p1' }));
  });
});
```

Import `Playbook` at the top of the test file.

- [ ] **Step 2: Run to watch it fail** — expected FAIL: the placeholder section renders none of this.

- [ ] **Step 3: Replace the placeholder section**

```tsx
      <section className="bg-card border border-rule rounded-card p-5 space-y-3">
        <h3 className="font-prose text-section text-ink-1">Playbook</h3>
        {playbooksError ? (
          <LoadErrorPanel compact message={playbooksError} onRetry={onRetryPlaybooks} />
        ) : playbooks.length === 0 ? (
          <div className="space-y-3">
            <p className="font-ui text-ui text-ink-2">
              You have no playbooks yet. A playbook is the list of clauses a review looks for.
            </p>
            <Button onClick={onCreatePlaybook}>Create a playbook</Button>
          </div>
        ) : (
          <ul className="space-y-2">
            {[...playbooks].sort((a, b) => b.updatedAt - a.updatedAt).map(p => (
              <li key={p.id} className="flex items-center gap-3 border border-rule rounded-control p-3">
                <span data-playbook-name className="font-ui text-ui text-ink-1 truncate">{p.name}</span>
                <Button className="ml-auto shrink-0" onClick={() => void onRunReview(p)}>
                  Run this playbook
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>
```

- [ ] **Step 4: Run to watch it pass, then mutation-test**

Run: `npx vitest run src/features/matters/IntakeWizard.test.tsx` — expected PASS.
Now change the sort to `a.updatedAt - b.updatedAt` and re-run: expected FAIL on "most recently used first". Restore. Then swap the `playbooksError` and `playbooks.length === 0` branches so the empty state wins, and re-run: expected FAIL on "renders the load-error panel instead of the playbook list" — a failed read must never present as an empty library. Restore.

- [ ] **Step 5: Swap the wizard in as the matter's empty state**

`MatterHome.tsx`'s `documents.length === 0 ? (<p>No documents yet. Add one to get started.</p>) : …` branch becomes a render of `<IntakeWizard … />` with every prop `MatterHome` already holds, plus the two new ones. Add `modelId: string` and `onOpenSettings: () => void` to `MatterHomeProps` with doc comments naming the wizard as their only consumer, and pass them from `App.tsx` as `settings.model` (read the exact field name from `Settings` in `src/types.ts:257`) and `() => requestView('settings')`.

**The matter with documents is unchanged**: it still renders the status board. The wizard replaces one branch, not the screen.

- [ ] **Step 6: Confirm no matter-home test broke**

Run: `npm test`
`src/features/matters/MatterHome.test.tsx` may reference "No documents yet." If it does, that assertion is a **declared** change belonging to this task: replace it with an assertion that the wizard's own step tracker renders. Any *other* test change is a finding — stop and report it.

- [ ] **Step 7: Full gates and commit**

Run: `npx tsc --noEmit && npm run build`

```bash
git add src/features/matters/IntakeWizard.tsx src/features/matters/IntakeWizard.test.tsx src/features/matters/MatterHome.tsx src/App.tsx
git commit -F .git/COMMIT_G19
```

Message:

```
feat(g): finish the intake wizard and make it a matter's empty state

Step 3 lists the user's playbooks, most recently used first, with a route
to create one when there are none — and a failed library read renders the
error panel rather than the empty list, because "no playbooks" and "we
could not read your playbooks" are different facts.

It never suggests which playbook to use (R-G12).

A matter with no documents shows the wizard; a matter with documents shows
the status board. No new route, no routing change: it is one branch of a
screen that already existed.
```

---

## Task 20: The `Standard positions` nav tab

**Kind:** **structural.** §10.4 / R-G18 — **the only undrawn screen G invents**, and the one that passed §10's "say what it is for" test.

**What it is for:** *"which of our house rules are drifting?"* — a question no per-playbook screen answers, because drift is only visible across playbooks and across matters.

**No new data, no new writes, no new model call.** Health is derived at read time by D's pure functions, exactly as it is on the editor, so the two cannot disagree.

**Files:**
- Create: `src/lib/standardPositions.ts`, `src/lib/standardPositions.test.ts`
- Create: `src/features/positions/StandardPositionsView.tsx`, `src/features/positions/StandardPositionsView.test.tsx`
- Modify: `src/lib/router.ts` (one new route)
- Modify: `src/App.tsx` (the `positions` view, its loader, and the third nav tab)

**Interfaces:**
- Consumes: `buildPositionHealthMap` from `src/lib/positionHealthMap.ts`; `positionHealthLabel` and `PositionHealth` from `src/lib/positionHealth.ts`; `listPlaybooks`, `listVersions`, `listMatters`, `listReviews`.
- Produces:
  - `export interface PositionRow { playbookId: string; playbookName: string; clauseId: string; clauseTitle: string; positionText: string; health: PositionHealth }`
  - `export interface PositionRowsInput { playbooks: { playbook: Playbook; versions: PlaybookVersion[] }[]; reviews: Review[] }`
  - `export function buildPositionRows(input: PositionRowsInput): PositionRow[]`
  - `Route` gains `| { name: 'positions' }`, path `/positions`
  - `View` gains `'positions'`; `ROUTE_FOR_VIEW.positions = { name: 'positions' }`; `viewForRoute` maps `positions → 'positions'`

- [ ] **Step 1: Write the failing router tests**

Append to `src/lib/router.test.ts`:

```ts
describe('the standard positions route', () => {
  it('parses /positions', () => {
    expect(parseRoute('/positions')).toEqual({ name: 'positions' });
  });

  it('round-trips', () => {
    expect(buildPath(parseRoute('/positions'))).toBe('/positions');
  });

  it('does not swallow a deeper path', () => {
    expect(parseRoute('/positions/anything')).toEqual({ name: 'not-found', path: '/positions/anything' });
  });
});
```

- [ ] **Step 2: Add the route**

In `src/lib/router.ts`: add `| { name: 'positions' }` to `Route`; in `parsePath`, `else if (segments[0] === 'positions' && segments.length === 1) return { name: 'positions' };`; in `buildPath`, `case 'positions': return '/positions';`.

Run: `npx vitest run src/lib/router.test.ts` — expected PASS. Then delete the `segments.length === 1` guard and re-run: expected FAIL on "does not swallow a deeper path". Restore.

- [ ] **Step 3: Write the failing row-derivation tests**

Create `src/lib/standardPositions.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { buildPositionRows } from './standardPositions';
import type { Playbook, PlaybookVersion, Review, Finding } from '../types';

function version(over: Partial<PlaybookVersion> = {}): PlaybookVersion {
  return {
    id: 'v1', playbookId: 'p1', version: 1, name: 'Lease', contractType: 'lease',
    systemPrompt: '', formatPrompt: '', clauses: [], changeSummary: '',
    publishedAt: 100, publishedByUserId: 'me', schemaVersion: 6, ...over,
  };
}
const playbook: Playbook = { id: 'p1', name: 'Lease', createdAt: 1, updatedAt: 1, currentVersionId: 'v1', schemaVersion: 6 };

function finding(over: Partial<Finding> = {}): Finding {
  return { clauseId: 'c1', status: 'done', citations: [], verification: { state: 'unchecked' }, notes: [], ...over };
}
function review(over: Partial<Review> = {}): Review {
  return {
    id: 'r1', matterId: 'm1', playbookSnapshot: version(), playbookVersionId: 'v1',
    documentIds: ['d1'], target: { kind: 'documents', documentIds: ['d1'] },
    findings: {}, modelId: 'm', startedAt: 1, completedAt: 2, createdByUserId: 'me', ...over,
  };
}

describe('buildPositionRows', () => {
  it('returns one row per clause that carries a standard position', () => {
    const v = version({ clauses: [
      { id: 'c1', title: 'Break right', extractPrompt: '', standardPosition: { text: 'Six months.', origin: 'authored', reviewedByHuman: true } },
      { id: 'c2', title: 'Rent', extractPrompt: '' },
    ] });
    const rows = buildPositionRows({ playbooks: [{ playbook, versions: [v] }], reviews: [] });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ playbookName: 'Lease', clauseTitle: 'Break right', positionText: 'Six months.' });
  });

  it('reports health from verified findings, through D’s own derivation', () => {
    const v = version({ clauses: [
      { id: 'c1', title: 'Break right', extractPrompt: '', standardPosition: { text: 'Six months.', origin: 'authored', reviewedByHuman: true } },
    ] });
    const rows = buildPositionRows({
      playbooks: [{ playbook, versions: [v] }],
      reviews: [review({ findings: { d1: { c1: finding({ positionOutcome: 'deviates', verification: { state: 'verified', byUserId: 'me', at: 200 } }) } } })],
    });
    expect(rows[0].health).toEqual({ kind: 'conceded', count: 1 });
  });

  it('sorts conceded first, then untested, then held', () => {
    const clause = (id: string, text: string) =>
      ({ id, title: id, extractPrompt: '', standardPosition: { text, origin: 'authored' as const, reviewedByHuman: true } });
    const v = version({ clauses: [clause('c1', 'Held.'), clause('c2', 'Untested.'), clause('c3', 'Conceded.')] });
    const rows = buildPositionRows({
      playbooks: [{ playbook, versions: [v] }],
      reviews: [review({ findings: { d1: {
        c1: finding({ clauseId: 'c1', positionOutcome: 'meets', verification: { state: 'verified', byUserId: 'me', at: 200 } }),
        c3: finding({ clauseId: 'c3', positionOutcome: 'deviates', verification: { state: 'verified', byUserId: 'me', at: 200 } }),
      } } })],
    });
    // The ordering IS the answer to the question the screen exists to ask.
    expect(rows.map(r => r.health.kind)).toEqual(['conceded', 'untested', 'held']);
  });

  it('reads the current published version only, never a draft', () => {
    const v1 = version({ id: 'v1', version: 1, clauses: [
      { id: 'c1', title: 'Break right', extractPrompt: '', standardPosition: { text: 'Six months.', origin: 'authored', reviewedByHuman: true } },
    ] });
    const withDraft: Playbook = { ...playbook, draft: { name: 'Lease', contractType: 'lease', systemPrompt: '', formatPrompt: '', changeSummary: '', clauses: [
      { id: 'c1', title: 'Break right', extractPrompt: '', standardPosition: { text: 'NINE months.', origin: 'authored', reviewedByHuman: true } },
    ] } };
    const rows = buildPositionRows({ playbooks: [{ playbook: withDraft, versions: [v1] }], reviews: [] });
    // A draft is unpublished: no review has ever run against it, so
    // reporting its wording here would attribute evidence to words nothing
    // was measured against.
    expect(rows[0].positionText).toBe('Six months.');
  });

  it('skips a playbook that has never been published', () => {
    const unpublished: Playbook = { id: 'p2', name: 'New', createdAt: 1, updatedAt: 1, schemaVersion: 6 };
    expect(buildPositionRows({ playbooks: [{ playbook: unpublished, versions: [] }], reviews: [] })).toEqual([]);
  });
});
```

- [ ] **Step 4: Run to watch it fail** — expected FAIL on the missing module.

- [ ] **Step 5: Write `src/lib/standardPositions.ts`**

```ts
import type { Playbook, PlaybookVersion, Review } from '../types';
import { buildPositionHealthMap } from './positionHealthMap';
import type { PositionHealth } from './positionHealth';

export interface PositionRow {
  playbookId: string;
  playbookName: string;
  clauseId: string;
  clauseTitle: string;
  positionText: string;
  health: PositionHealth;
}

export interface PositionRowsInput {
  /** Every playbook the caller could read, each with its own published
   *  versions (`listVersions`). */
  playbooks: { playbook: Playbook; versions: PlaybookVersion[] }[];
  /** Every review the caller could read, from every matter — drift is only
   *  visible across matters, which is the whole reason this screen exists. */
  reviews: Review[];
}

/** conceded first, then untested, then held, then no-position. The ordering
 *  IS the answer to "which of our house rules are drifting": a position
 *  someone has given up on outranks one nothing has tested, which outranks
 *  one that is holding. */
const HEALTH_RANK: Record<PositionHealth['kind'], number> = {
  conceded: 0, untested: 1, held: 2, 'no-position': 3,
};

/**
 * The `Standard positions` index. Pure, and it introduces no derivation of
 * its own: health comes from `buildPositionHealthMap`, exactly as the
 * playbook editor's chips do, so the tab and the editor cannot disagree
 * about the same position (R-G18).
 *
 * Reads each playbook's CURRENT PUBLISHED VERSION, never its draft. A draft
 * has never been published, so no review has run against its wording, and
 * reporting health against it would attribute evidence to words nothing was
 * ever measured against — the exact failure R-D17's fix closed one level
 * down.
 */
export function buildPositionRows({ playbooks, reviews }: PositionRowsInput): PositionRow[] {
  const rows: PositionRow[] = [];

  for (const { playbook, versions } of playbooks) {
    const current = versions.find(v => v.id === playbook.currentVersionId);
    if (!current) continue;

    const health = buildPositionHealthMap({ clauses: current.clauses, versions, reviews });

    for (const clause of current.clauses) {
      const position = clause.standardPosition;
      if (!position) continue;
      rows.push({
        playbookId: playbook.id,
        playbookName: playbook.name,
        clauseId: clause.id,
        clauseTitle: clause.title,
        positionText: position.text,
        health: health[clause.id] ?? { kind: 'untested' },
      });
    }
  }

  return rows.sort((a, b) =>
    HEALTH_RANK[a.health.kind] - HEALTH_RANK[b.health.kind]
    || a.playbookName.localeCompare(b.playbookName)
    || a.clauseTitle.localeCompare(b.clauseTitle));
}
```

- [ ] **Step 6: Run to watch it pass, then mutation-test**

Run: `npx vitest run src/lib/standardPositions.test.ts` — expected PASS.
Now change `const current = versions.find(...)` to read `playbook.draft` when present, and re-run: expected FAIL on "reads the current published version only". Restore. Then reverse `HEALTH_RANK`'s conceded and held and re-run: expected FAIL on the sort case. Restore.

- [ ] **Step 7: Write the view's failing tests**

Create `src/features/positions/StandardPositionsView.test.tsx`:

```tsx
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { mount, buttonNamed, click } from '../../test/mount';
import { StandardPositionsView } from './StandardPositionsView';
import type { PositionRow } from '../../lib/standardPositions';

const row = (over: Partial<PositionRow> = {}): PositionRow => ({
  playbookId: 'p1', playbookName: 'Lease', clauseId: 'c1', clauseTitle: 'Break right',
  positionText: 'Six months.', health: { kind: 'untested' }, ...over,
});

describe('StandardPositionsView', () => {
  it('lists a row per position with its playbook, clause and health', () => {
    const c = mount(<StandardPositionsView rows={[row({ health: { kind: 'conceded', count: 2 } })]} error={null} onRetry={() => {}} onOpenPlaybook={() => {}} />);
    expect(c.textContent).toContain('Six months.');
    expect(c.textContent).toContain('Lease');
    expect(c.textContent).toContain('Break right');
    // The four health strings are frozen copy — positionHealthLabel is the
    // only place they live.
    expect(c.textContent).toContain('CONCEDED 2 times');
  });

  it('says a firm has no standard positions rather than showing an empty table', () => {
    const c = mount(<StandardPositionsView rows={[]} error={null} onRetry={() => {}} onOpenPlaybook={() => {}} />);
    expect(c.textContent).toContain('No standard positions yet');
    expect(c.querySelectorAll('li')).toHaveLength(0);
  });

  it('renders the load-error panel instead of the index when the read failed', () => {
    const c = mount(<StandardPositionsView rows={[]} error="Your playbooks could not be loaded." onRetry={() => {}} onOpenPlaybook={() => {}} />);
    expect(c.textContent).toContain('Your playbooks could not be loaded.');
    expect(c.textContent).not.toContain('No standard positions yet');
    expect(buttonNamed(c, /^Retry$/)).toBeTruthy();
  });

  it('filters by health', () => {
    const c = mount(<StandardPositionsView
      rows={[row({ clauseId: 'c1', clauseTitle: 'Break', health: { kind: 'conceded', count: 1 } }), row({ clauseId: 'c2', clauseTitle: 'Rent', health: { kind: 'held', supporting: 2, total: 2 } })]}
      error={null} onRetry={() => {}} onOpenPlaybook={() => {}}
    />);
    click(buttonNamed(c, /^Conceded$/));
    expect(c.textContent).toContain('Break');
    expect(c.textContent).not.toContain('Rent');
  });

  it('links each row to its clause in the playbook editor', () => {
    const onOpenPlaybook = vi.fn();
    const c = mount(<StandardPositionsView rows={[row()]} error={null} onRetry={() => {}} onOpenPlaybook={onOpenPlaybook} />);
    click(buttonNamed(c, /Open in playbook/));
    expect(onOpenPlaybook).toHaveBeenCalledWith('p1', 'c1');
  });

  it('offers no way to change anything from here', () => {
    // Read-only by design: no new writes and no model call (R-G18).
    const c = mount(<StandardPositionsView rows={[row()]} error={null} onRetry={() => {}} onOpenPlaybook={() => {}} />);
    expect(c.querySelectorAll('input, textarea, select')).toHaveLength(0);
  });
});
```

- [ ] **Step 8: Write `src/features/positions/StandardPositionsView.tsx`**

```tsx
import React, { useState } from 'react';
import type { PositionHealth } from '../../lib/positionHealth';
import { positionHealthLabel } from '../../lib/positionHealth';
import type { PositionRow } from '../../lib/standardPositions';
import { LoadErrorPanel } from '../../components/LoadErrorPanel';

export interface StandardPositionsViewProps {
  rows: PositionRow[];
  /** Non-null replaces the index. A failed read is not an empty firm. */
  error: string | null;
  onRetry: () => void;
  onOpenPlaybook: (playbookId: string, clauseId: string) => void;
}

const HEALTH_INK: Record<PositionHealth['kind'], string> = {
  held: 'text-health-held border-health-held',
  conceded: 'text-health-conceded border-health-conceded',
  untested: 'text-health-untested border-health-untested',
  'no-position': 'text-health-none border-health-none',
};

const FILTERS: { label: string; kind: PositionHealth['kind'] | 'all' }[] = [
  { label: 'All', kind: 'all' },
  { label: 'Conceded', kind: 'conceded' },
  { label: 'Untested', kind: 'untested' },
  { label: 'Held', kind: 'held' },
];

/**
 * "Which of our house rules are drifting?" — a question no per-playbook
 * screen answers, because drift is only visible across playbooks and across
 * matters (§10.4).
 *
 * Read-only, by construction: it derives everything from D's
 * `positionHealth`, writes nothing, and calls no model. If the owner would
 * rather not have this tab, deleting it costs nothing — nothing else links
 * to it (R-G18).
 */
export function StandardPositionsView({ rows, error, onRetry, onOpenPlaybook }: StandardPositionsViewProps) {
  const [filter, setFilter] = useState<PositionHealth['kind'] | 'all'>('all');

  if (error) {
    return <LoadErrorPanel message={error} onRetry={onRetry} />;
  }

  if (rows.length === 0) {
    return (
      <div className="max-w-2xl mx-auto p-8 text-center space-y-2">
        <h1 className="font-prose text-screen-title text-ink-1">No standard positions yet</h1>
        <p className="font-ui text-ui text-ink-2">
          A standard position is your firm’s own answer to a clause. Add one to a clause in a
          playbook and it will appear here with how well it is holding up.
        </p>
      </div>
    );
  }

  const shown = filter === 'all' ? rows : rows.filter(r => r.health.kind === filter);

  return (
    <div className="max-w-4xl mx-auto p-8 space-y-5">
      <h1 className="font-prose text-screen-title text-ink-1">Standard positions</h1>
      <div className="flex gap-1 bg-chip-fill rounded-control p-0.5 w-fit">
        {FILTERS.map(f => (
          <button
            key={f.label}
            type="button"
            onClick={() => setFilter(f.kind)}
            className={`px-3 py-1.5 rounded-inset font-ui text-button ${filter === f.kind ? 'bg-card shadow-tab text-ink-1' : 'text-ink-3 hover:text-ink-1'}`}
          >
            {f.label}
          </button>
        ))}
      </div>

      <ul className="space-y-3">
        {shown.map(r => (
          <li key={`${r.playbookId}:${r.clauseId}`} className="bg-card border border-rule rounded-card p-4 space-y-2">
            <div className="flex items-start gap-3">
              <p className="font-prose text-field text-ink-prose min-w-0">{r.positionText}</p>
              <span className={`shrink-0 font-mono text-chip uppercase px-1.5 py-0.5 rounded-chip border bg-transparent ${HEALTH_INK[r.health.kind]}`}>
                {positionHealthLabel(r.health)}
              </span>
            </div>
            <p className="flex items-center gap-2">
              <span className="font-mono text-pin text-ink-4 uppercase">{r.playbookName} · {r.clauseTitle}</span>
              <button
                type="button"
                onClick={() => onOpenPlaybook(r.playbookId, r.clauseId)}
                className="ml-auto font-ui text-meta text-accent hover:underline"
              >
                Open in playbook →
              </button>
            </p>
          </li>
        ))}
      </ul>
    </div>
  );
}
```

- [ ] **Step 9: Run the view tests and mutation-test the error branch**

Run: `npx vitest run src/features/positions/StandardPositionsView.test.tsx` — expected PASS.
Now move the `error` check below the `rows.length === 0` check and re-run: expected FAIL on "renders the load-error panel instead of the index" — a failed read presented as an empty firm is CLAUDE.md's founding defect. Restore.

- [ ] **Step 10: Wire the view and the nav tab into `App.tsx`**

- Add `'positions'` to the `View` union, `case 'positions': return 'positions';` to `viewForRoute`, and `positions: { name: 'positions' }` to `ROUTE_FOR_VIEW`.
- Add state `positionRows: PositionRow[]`, `positionsError: string | null`, and a `loadPositions()` that runs `listPlaybooks()`, then `listVersions(id)` per playbook, then `listMatters()` → `listReviews(matterId)` per matter, and calls `buildPositionRows`. On any rejection it sets `positionsError` via `describeLoadError(e, 'Your standard positions could not be loaded. Try again.')` and **leaves `positionRows` untouched** — never `[]`, which would render the empty state over a failure.
- Fire `loadPositions()` from the same effect that reacts to `view === 'positions'`, so opening the tab reads current data rather than a stale snapshot.
- Render the third nav button between `Playbooks` and `Current run`, with the same class idiom Task 6 established:

```tsx
          <button
            onClick={() => requestView('positions')}
            className={`font-ui text-ui-sm px-2.5 py-1.5 rounded-inset ${view === 'positions' ? 'font-semibold text-ink-1 bg-accent-tint' : 'font-medium text-ink-3 hover:text-ink-1'}`}
          >
            Standard positions
          </button>
```

- Render the view in `<main>`: `{view === 'positions' && <StandardPositionsView rows={positionRows} error={positionsError} onRetry={loadPositions} onOpenPlaybook={(playbookId) => navigate({ name: 'playbook', playbookId })} />}`. The `clauseId` argument is accepted by the prop and deliberately unused by this call site: the editor has no clause deep-link, and scrolling to a clause is not something this task invents. Say so in a comment rather than silently dropping the parameter.

- [ ] **Step 11: Full gates and commit**

Run: `npm test && npx tsc --noEmit && npm run build`

```bash
git add src/lib/standardPositions.ts src/lib/standardPositions.test.ts src/features/positions/StandardPositionsView.tsx src/features/positions/StandardPositionsView.test.tsx src/lib/router.ts src/lib/router.test.ts src/App.tsx
git commit -F .git/COMMIT_G20
```

Message:

```
feat(g): add the Standard positions tab

"Which of our house rules are drifting?" — a question no per-playbook
screen answers, because drift is only visible across playbooks and across
matters. It is the one undrawn screen that passed the "say what it is for
or drop it" test (R-G18).

No new data, no new writes, no model call: health comes from D's
buildPositionHealthMap, the same derivation the editor's chips use, so the
two cannot disagree about the same position. It reads each playbook's
current published version, never its draft — a draft has never been
published, so no review has run against its wording.

Conceded first, then untested, then held: the ordering is the answer to the
question the screen exists to ask.

A firm with no positions gets an explanation, not an empty table; a failed
read gets the error panel, not an empty firm.
```

---

## Task 21: The `Review / Compare` segmented control

**Kind:** **structural.** §10.5 — **resolved onto what exists, not invented.**

`ResultsView` (cards) and `TabularReview` (grid) are already two renderers over one findings map, already toggled from the review header. The `Review / Compare` control **is** that existing toggle, restyled and made honest.

**Files:**
- Create: `src/features/review/ViewSwitch.tsx`, `src/features/review/ViewSwitch.test.tsx`
- Modify: `src/features/review/ResultsView.tsx` (replace the "Tabular view" button with the switch), `src/features/tabular/TabularReview.tsx` (replace its "Cards" affordance with the same switch)

**Interfaces:**
- Consumes: `isCollectionTarget` from `src/lib/reviewTarget.ts`.
- Produces:
  - `export interface ViewSwitchProps { value: 'review' | 'compare'; onChange: (next: 'review' | 'compare') => void; target: ReviewTarget; documentCount: number }`
  - `export function ViewSwitch(props: ViewSwitchProps): JSX.Element | null`

**Two rules make it honest (§10.5, R-GP6):**

- The control is **absent, not disabled**, when there is nothing to compare across — a single-document review, or a collection review, which produces one position per clause however many documents fed it (`findingsKeyFor`). **A disabled tab advertises a view that will never exist for this review.**
- It does not mean "compare two runs" or "compare to another matter". Neither exists. **`Report` is not a third tab** (R-G11): export is a button that produces a file.

- [ ] **Step 1: Write the failing tests**

Create `src/features/review/ViewSwitch.test.tsx`:

```tsx
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { mount, buttonNamed, click } from '../../test/mount';
import { ViewSwitch } from './ViewSwitch';

const docs = { kind: 'documents', documentIds: ['d1', 'd2'] } as const;

describe('ViewSwitch', () => {
  it('offers Review and Compare for a multi-document review', () => {
    const c = mount(<ViewSwitch value="review" onChange={() => {}} target={docs} documentCount={2} />);
    expect(buttonNamed(c, /^Review$/)).toBeTruthy();
    expect(buttonNamed(c, /^Compare$/)).toBeTruthy();
  });

  it('switches', () => {
    const onChange = vi.fn();
    const c = mount(<ViewSwitch value="review" onChange={onChange} target={docs} documentCount={2} />);
    click(buttonNamed(c, /^Compare$/));
    expect(onChange).toHaveBeenCalledWith('compare');
  });

  it('renders nothing for a single-document review', () => {
    // Absent, not disabled: a disabled tab advertises a view that will
    // never exist for this review (§10.5, R-GP6).
    const c = mount(<ViewSwitch value="review" onChange={() => {}} target={{ kind: 'documents', documentIds: ['d1'] }} documentCount={1} />);
    expect(c.textContent).toBe('');
  });

  it('renders nothing for a collection review', () => {
    // A collection produces ONE position per clause however many documents
    // fed it (findingsKeyFor). There is nothing to compare across.
    const c = mount(<ViewSwitch value="review" onChange={() => {}} target={{ kind: 'collection', collectionId: 'k1', documentIds: ['d1', 'd2'] }} documentCount={2} />);
    expect(c.textContent).toBe('');
  });

  it('offers no third tab', () => {
    // Report is dropped: export is a button producing a file, and a Report
    // tab would advertise a live report view the app does not have (R-G11).
    const c = mount(<ViewSwitch value="review" onChange={() => {}} target={docs} documentCount={2} />);
    expect(c.querySelectorAll('button')).toHaveLength(2);
    expect(c.textContent).not.toMatch(/report/i);
  });
});
```

- [ ] **Step 2: Run to watch it fail** — expected FAIL on the missing module.

- [ ] **Step 3: Write `src/features/review/ViewSwitch.tsx`**

```tsx
import React from 'react';
import type { ReviewTarget } from '../../types';
import { isCollectionTarget } from '../../lib/reviewTarget';

export type ReviewViewKind = 'review' | 'compare';

export interface ViewSwitchProps {
  value: ReviewViewKind;
  onChange: (next: ReviewViewKind) => void;
  target: ReviewTarget;
  documentCount: number;
}

const TABS: { kind: ReviewViewKind; label: string }[] = [
  { kind: 'review', label: 'Review' },
  { kind: 'compare', label: 'Compare' },
];

/**
 * The review header's `Review / Compare` control. `Review` is the card
 * ledger; `Compare` is the grid. They are already two renderers over one
 * findings map — this control is that existing toggle, not a new view
 * (§10.5).
 *
 * It renders NOTHING when there is nothing to compare across, rather than
 * rendering a disabled tab: a single-document review has one column, and a
 * collection review produces one position per clause however many documents
 * fed it, so `TabularReview` refuses it outright. A disabled tab would
 * advertise a view that will never exist for this review.
 *
 * There is no third tab. Export is a button that produces a file (R-G11).
 */
export function ViewSwitch({ value, onChange, target, documentCount }: ViewSwitchProps) {
  if (isCollectionTarget(target) || documentCount < 2) return null;

  return (
    <div className="flex gap-0.5 bg-chip-fill rounded-control p-0.5">
      {TABS.map(tab => (
        <button
          key={tab.kind}
          type="button"
          onClick={() => onChange(tab.kind)}
          className={`px-3 py-1.5 rounded-inset font-ui text-button ${value === tab.kind ? 'bg-card shadow-tab text-ink-1' : 'text-ink-3 hover:text-ink-1'}`}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}
```

- [ ] **Step 4: Run to watch it pass, then mutation-test**

Run: `npx vitest run src/features/review/ViewSwitch.test.tsx` — expected PASS.
Now change the guard to render a `disabled` tab instead of returning `null`, and re-run: expected FAIL on both "renders nothing" cases. Restore.

- [ ] **Step 5: Use it in both renderers**

In `ResultsView`, replace the "Tabular view" button with:

```tsx
          {onOpenTabular && (
            <ViewSwitch
              value="review"
              onChange={(next) => { if (next === 'compare') onOpenTabular(); }}
              target={run.target}
              documentCount={run.documentIds.length}
            />
          )}
```

In `TabularReview`, replace its return-to-cards affordance with the same control at `value="compare"`, calling `onOpenCards()` when `next === 'review'`. `onOpenTabular` and `onOpenCards` stay optional; when either is omitted the control simply is not rendered, which is the existing contract.

- [ ] **Step 6: Confirm the existing review tests still pass unedited**

Run: `npm test`, then `git status --porcelain -- '*.test.ts' '*.test.tsx'`
Expected: only `src/features/review/ViewSwitch.test.tsx` (new). If `ResultsView.test.tsx` or a `TabularReview` test asserted on the string "Tabular view" or "Cards", **that is a declared copy change belonging to this task** — update it and say so in the commit message, naming the test.

- [ ] **Step 7: Full gates and commit**

Run: `npx tsc --noEmit && npm run build`

```bash
git add src/features/review/ViewSwitch.tsx src/features/review/ViewSwitch.test.tsx src/features/review/ResultsView.tsx src/features/tabular/TabularReview.tsx
git commit -F .git/COMMIT_G21
```

Message:

```
feat(g): resolve the Review / Compare control onto the toggle that exists

C refused to specify Compare from a name and was right to. It is resolvable
without inventing anything: the card ledger and the grid are already two
renderers over one findings map, already toggled from the header. This is
that toggle, as a segmented control.

Absent, not disabled, when there is nothing to compare across — a
single-document review, or a collection review, which produces one position
per clause however many documents fed it. A disabled tab advertises a view
that will never exist for this review.

No Report tab: export is a button that produces a file (R-G11).
```
---

## Task 22: The responsive pass to 768px

**Kind:** **structural (layout).** §3.4 and §11. Deliberately **after** every screen has reached its final shape — a responsive pass over a layout still due to change is a pass that has to be repeated.

**Scope, stated so a later reader does not assume mobile was forgotten:** this task makes **the screens that exist** usable at 768px and 1024px. It builds **no phone-specific screen**. Full `1h` phone parity — a bottom tab bar, a single-column phone review flow, a phone treatment of the grid, a touch replacement for the `J`/`V`/`F`/`R` verify loop — is **sub-project H**, per decision D1. Nothing in this task pretends otherwise.

**Files:**
- Modify: `src/App.tsx` (the header wraps rather than overflowing), `src/features/review/ResultsView.tsx`, `src/features/tabular/TabularReview.tsx`, `src/features/matters/MatterHome.tsx`, `src/features/matters/MatterStats.tsx`, `src/features/templates/TemplateEditor.tsx`, `src/components/Modal.tsx`
- Create: `src/test/responsive.test.tsx`

**Interfaces:**
- Consumes: every restyled screen.
- Produces: `data-scroll-x` on the one element that owns each dense table's horizontal scroll — the semantic hook the structural test asserts on, because jsdom evaluates no media query and lays nothing out.

**The collapse order, applied consistently (§11):**

1. **The document pane collapses first**, below `lg`. Its content moves behind an "Open in document" affordance rather than being stacked beneath the finding, so the finding column keeps a usable width.
2. **The clause index collapses second**, below `md`, into a `<select>` that changes the active clause — the same control shape `ResultsView` already uses for switching documents.
3. **Dense tables scroll inside their own container**, never by pushing the page. The container carries `data-scroll-x` and `overflow-x-auto`; the page body never scrolls horizontally.
4. **Modals become full-height sheets below 640px**: `max-h-full h-full rounded-none` at the base, `sm:h-auto sm:max-h-[85vh] sm:rounded-control` above it.
5. **The stat row and the matter's lower grid stack** below `md` (`grid-cols-1 md:grid-cols-[…]`) — Task 15 already wrote them that way; confirm rather than re-do.

- [ ] **Step 1: Write the structural responsive test**

jsdom cannot lay out, so this asserts the **structure** responsive behaviour depends on, and Step 6 does the rest in a browser. Create `src/test/responsive.test.tsx`:

```tsx
import React from 'react';
import { describe, it, expect } from 'vitest';
import { mount } from './mount';
import { TabularReview } from '../features/tabular/TabularReview';
import { Modal } from '../components/Modal';
import type { Finding, ReviewRun, DocumentFile } from '../types';

function finding(over: Partial<Finding> = {}): Finding {
  return { clauseId: 'c1', status: 'done', summary: 'A sentence.', citations: [], verification: { state: 'unchecked' }, notes: [], ...over };
}
function run(): ReviewRun {
  return {
    id: 'r1',
    templateSnapshot: { id: 'v1', playbookId: 'p1', version: 1, name: 'Lease', contractType: 'lease', systemPrompt: '', formatPrompt: '', clauses: [{ id: 'c1', title: 'Break', extractPrompt: '' }], changeSummary: '', publishedAt: 1, publishedByUserId: 'me', schemaVersion: 6 },
    documentIds: ['d1'],
    target: { kind: 'documents', documentIds: ['d1'] },
    findings: { d1: { c1: finding() } },
  } as ReviewRun;
}
const doc = { id: 'd1', name: 'Lease.pdf', kind: 'pdf', text: '[Page 1]\nx' } as DocumentFile;

describe('responsive structure (≥768px pass)', () => {
  it('the grid owns its horizontal scroll in a dedicated container', () => {
    // A dense table that pushes the PAGE horizontally is the defect this
    // asserts against: every other screen then scrolls sideways too.
    const c = mount(<TabularReview run={run()} documents={[doc]} onRetryCell={() => {}} />);
    const table = c.querySelector('table');
    expect(table).toBeTruthy();
    const scroller = table!.closest('[data-scroll-x]');
    expect(scroller, 'the grid table must sit inside a data-scroll-x container').toBeTruthy();
    // …and that container must not be the page body itself.
    expect(scroller!.contains(table!)).toBe(true);
    expect(scroller!.tagName).not.toBe('BODY');
  });

  it('a modal panel declares a sheet form at the smallest width and a panel form above it', () => {
    const c = mount(<Modal isOpen title="T" onClose={() => {}}><p>x</p></Modal>);
    const dialog = c.querySelector('[role="dialog"]');
    const cls = dialog!.getAttribute('class') ?? '';
    // The class strings are the responsive contract here — asserted as
    // BEHAVIOUR (a sheet below 640, a panel above) rather than as
    // appearance, because jsdom evaluates no media query and there is no
    // other way to state it in this environment.
    expect(cls).toContain('sm:rounded-control');
    expect(cls).toContain('sm:h-auto');
  });
});
```

- [ ] **Step 2: Run to watch it fail** — expected FAIL: no `data-scroll-x`, no `sm:` classes on the dialog.

- [ ] **Step 3: Apply the collapse rules**

- `TabularReview`: wrap the `<table>` in `<div data-scroll-x className="overflow-x-auto min-w-0">`. The sticky first column keeps `sticky left-0`, which works inside the scroller.
- `Modal`: the panel becomes `w-full h-full max-h-full rounded-none sm:h-auto sm:max-h-[85vh] sm:rounded-control ${SIZE_CLASSES[size]}`, and the body's `max-h-[60vh]` becomes `flex-1 sm:max-h-[60vh]`.
- `ResultsView`: `flex-col lg:flex-row` already; the document pane becomes `hidden lg:block`, with an "Open in document" button in the finding column below `lg` that toggles it to a full-width overlay (`fixed inset-0 z-50 lg:static lg:z-auto`).
- `App.tsx`'s header: `flex-wrap gap-y-2 h-auto min-h-14 py-2` so the nav wraps instead of overflowing at 768px.
- `TemplateEditor`'s clause rows: already `flex-col md:flex-row`; confirm the left rail becomes `hidden md:block` with its content reachable above the list below `md`.
- `MatterHome`'s lower grid and `MatterStats`: `grid-cols-1 md:grid-cols-[…]`.

- [ ] **Step 4: Run to watch it pass** — `npx vitest run src/test/responsive.test.tsx`, expected PASS.

- [ ] **Step 5: Mutation-test the scroll container**

Remove `data-scroll-x` from the grid wrapper and re-run: expected FAIL with "the grid table must sit inside a data-scroll-x container". Restore.

- [ ] **Step 6: Verify in a browser at 768px and 1024px — and write down what you saw**

jsdom evaluates no media query and lays nothing out, so this is the only real check. At **768px** and **1024px**, on every screen (matters list, matter home with and without documents, review, grid, playbook editor, version history, authoring, settings, standard positions):

1. No horizontal page scroll — check `document.documentElement.scrollWidth === document.documentElement.clientWidth` in the console on each screen.
2. The grid scrolls inside its own container, and the sticky clause column stays put while it does.
3. Modals are full-height sheets below 640px and panels above it.
4. The document pane's collapse leaves the finding readable, not squeezed.

**If you cannot drive a real browser, say so plainly** rather than implying you did. This is CLAUDE.md's standing rule and §13.5's opening sentence.

- [ ] **Step 7: Full gates and commit**

Run: `npm test && npx tsc --noEmit && npm run build`

```bash
git add src/test/responsive.test.tsx src/App.tsx src/components/Modal.tsx src/features/review/ResultsView.tsx src/features/tabular/TabularReview.tsx src/features/matters/MatterHome.tsx src/features/matters/MatterStats.tsx src/features/templates/TemplateEditor.tsx
git commit -F .git/COMMIT_G22
```

Message:

```
feat(g): make every existing screen usable at 768px

One collapse order everywhere: the document pane goes first, the clause
index second, dense tables scroll inside their own container rather than
pushing the page, and modals become full-height sheets below 640px.

This is responsive behaviour for the screens that exist. It builds no
phone-specific screen: full 1h parity needs a second review renderer, a
phone grid, a bottom tab bar and a touch replacement for the keyboard
verify loop, which is sub-project H (decision D1). Mobile is not forgotten,
it is scheduled.

jsdom evaluates no media query, so the test asserts the structure the
behaviour depends on — the grid's own scroll container, the modal's sheet
form — and the rest is browser-verified and written down.
```

---

## Task 23: The three-pane ledger

**Kind:** **structural, and separately revertible.** Decision D2. §9.4 and §12.2 step 15.

This is the one place in G where calling the work cosmetic would be a lie. It is sequenced last and written so that **`git revert` of this single commit leaves every other task intact** — nothing landed before it depends on anything it introduces.

**Today:** two panes — a 1/3 rail carrying a Findings/Chat tab pair and the finding cards, plus a 2/3 document pane.
**`1b`:** three panes — a 258px clause index, a 470px finding column, a fluid document pane.

**Files:**
- Create: `src/features/review/ClauseIndex.tsx`, `src/features/review/ClauseIndex.test.tsx`
- Modify: `src/features/review/ResultsView.tsx` (layout only)
- Modify: `src/App.tsx` (wire `ExportGateBanner`'s `onReviewUnchecked`, which Task 17 deliberately left unwired until there was somewhere to send the reader)

**Interfaces:**
- Consumes: `verificationCounts`, `StateChip`'s state vocabulary, `ViewSwitch` from Task 21, `useVerifyKeys` unchanged.
- Produces:
  - `export interface ClauseIndexProps { clauses: PlaybookClause[]; findings: Record<string, Finding>; activeClauseId: string | null; onSelect: (clauseId: string) => void }`
  - `export function ClauseIndex(props: ClauseIndexProps): JSX.Element`
  - `export function firstUncheckedClauseId(clauses: PlaybookClause[], findings: Record<string, Finding>): string | null`

**R-GP7 applies here** (stated in full in "Rulings made while writing this plan"): the Findings/Chat tab pair moves into the 470px finding column's header as a `Finding` / `Assistant` segmented control. `ChatPanel`'s props are unchanged. Dropping the chat panel instead would be a behaviour change smuggled into a layout change.

**State checklist for this task — the layout may not delete any of these:**

- The keyboard verify loop (`useVerifyKeys`: `J`, `V`, `F`, `R`) works exactly as before, moving through the **same** clause order, and still stops at the list's ends. **Remember `mount()` accumulates trees**: a test comparing before/after must use `mountOnce` and unmount explicitly, or the first tree's `window` listener answers for the second.
- `openAt` still lands the reader on the document **and** the clause the grid handed off, and a manual document switch still resets the cursor to the top.
- The card's scroll-into-view still fires (`vitest.setup.ts` stubs `scrollIntoView`; do not add a guard at the call site).
- Every `FindingCard` branch from Task 8 renders in the new column: pending, running, error, cancelled, done.
- The four run banners and the export-gate banner stay **above** the three panes, spanning them.
- `ChatPanel` keeps every prop and every branch.
- `DocumentViewer` keeps its own empty and error branches.

- [ ] **Step 1: Write the failing clause-index tests**

Create `src/features/review/ClauseIndex.test.tsx`:

```tsx
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { mount, click } from '../../test/mount';
import { ClauseIndex, firstUncheckedClauseId } from './ClauseIndex';
import type { Finding, PlaybookClause } from '../../types';

const clauses: PlaybookClause[] = [
  { id: 'c1', title: 'Break right', extractPrompt: '' },
  { id: 'c2', title: 'Rent review', extractPrompt: '' },
  { id: 'c3', title: 'Assignment', extractPrompt: '' },
];
function finding(over: Partial<Finding> = {}): Finding {
  return { clauseId: 'c1', status: 'done', citations: [], verification: { state: 'unchecked' }, notes: [], ...over };
}

describe('ClauseIndex', () => {
  it('lists every clause in the playbook order', () => {
    const c = mount(<ClauseIndex clauses={clauses} findings={{}} activeClauseId={null} onSelect={() => {}} />);
    expect(Array.from(c.querySelectorAll('li')).map(li => li.textContent)).toHaveLength(3);
    expect(c.textContent?.indexOf('Break right')).toBeLessThan(c.textContent!.indexOf('Rent review'));
  });

  it('selects a clause', () => {
    const onSelect = vi.fn();
    const c = mount(<ClauseIndex clauses={clauses} findings={{}} activeClauseId="c1" onSelect={onSelect} />);
    click(Array.from(c.querySelectorAll('button')).find(b => /Rent review/.test(b.textContent || '')));
    expect(onSelect).toHaveBeenCalledWith('c2');
  });

  it('shows the count chips that make triage possible', () => {
    const c = mount(<ClauseIndex
      clauses={clauses}
      findings={{ c1: finding({ riskLevel: 'High' }), c2: finding({ verification: { state: 'flagged' } }), c3: finding() }}
      activeClauseId={null}
      onSelect={() => {}}
    />);
    expect(c.textContent).toContain('1 high');
    expect(c.textContent).toContain('1 flagged');
    expect(c.textContent).toContain('2 unchecked');
  });

  it('distinguishes a queued clause from a busy one', () => {
    const c = mount(<ClauseIndex
      clauses={clauses}
      findings={{ c1: finding({ status: 'pending' }), c2: finding({ status: 'running' }) }}
      activeClauseId={null}
      onSelect={() => {}}
    />);
    expect(c.querySelectorAll('[data-busy="true"]')).toHaveLength(1);
  });
});

describe('firstUncheckedClauseId', () => {
  it('returns the first clause whose finding nobody has checked', () => {
    expect(firstUncheckedClauseId(clauses, {
      c1: finding({ verification: { state: 'verified' } }),
      c2: finding(),
    })).toBe('c2');
  });

  it('returns null when everything has been checked', () => {
    expect(firstUncheckedClauseId(clauses.slice(0, 1), { c1: finding({ verification: { state: 'rejected' } }) })).toBe(null);
  });

  it('treats a clause with no finding at all as unchecked', () => {
    // A clause the run never reached is not a clause a human signed off.
    expect(firstUncheckedClauseId(clauses, {})).toBe('c1');
  });
});
```

- [ ] **Step 2: Run to watch it fail** — expected FAIL on the missing module.

- [ ] **Step 3: Write `src/features/review/ClauseIndex.tsx`**

```tsx
import React from 'react';
import { CheckCircle2, Flag, XCircle, Circle, CircleDashed, Loader } from 'lucide-react';
import type { Finding, PlaybookClause } from '../../types';

export interface ClauseIndexProps {
  clauses: PlaybookClause[];
  /** This document's findings, keyed by clause id — the caller resolves the
   *  key through `findingsKeyFor`, exactly as every other consumer does. */
  findings: Record<string, Finding>;
  activeClauseId: string | null;
  onSelect: (clauseId: string) => void;
}

/** The first clause a human has not disposed of. A clause with NO finding
 *  counts as unchecked: a clause the run never reached is not a clause
 *  anybody signed off. */
export function firstUncheckedClauseId(
  clauses: PlaybookClause[],
  findings: Record<string, Finding>,
): string | null {
  const next = clauses.find(c => (findings[c.id]?.verification.state ?? 'unchecked') === 'unchecked');
  return next ? next.id : null;
}

export function ClauseIndex({ clauses, findings, activeClauseId, onSelect }: ClauseIndexProps) {
  let high = 0, flagged = 0, unchecked = 0;
  for (const clause of clauses) {
    const f = findings[clause.id];
    if (f?.riskLevel === 'High') high++;
    if (f?.verification.state === 'flagged') flagged++;
    if ((f?.verification.state ?? 'unchecked') === 'unchecked') unchecked++;
  }

  return (
    <nav className="w-full md:w-[258px] shrink-0 border-r border-rule bg-card flex flex-col min-h-0">
      <div className="p-3 border-b border-rule flex flex-wrap gap-2">
        <span className="font-mono text-chip uppercase text-risk-high">{high} high</span>
        <span className="font-mono text-chip uppercase text-risk-med">{flagged} flagged</span>
        <span className="font-mono text-chip uppercase text-ink-4">{unchecked} unchecked</span>
      </div>
      <ul className="flex-1 overflow-y-auto min-h-0">
        {clauses.map((clause, i) => {
          const f = findings[clause.id];
          const active = clause.id === activeClauseId;
          const busy = f?.status === 'running';
          return (
            <li key={clause.id}>
              <button
                type="button"
                onClick={() => onSelect(clause.id)}
                {...(busy ? { 'data-busy': 'true', 'aria-live': 'polite' as const } : {})}
                className={`w-full text-left px-3.5 py-2 border-l-2 flex items-start gap-2 ${active ? 'border-l-ink-1 bg-chip-fill' : 'border-l-transparent hover:bg-chip-fill'}`}
              >
                <StatusIcon finding={f} />
                <span className="min-w-0">
                  <span className={`block font-ui text-ui-sm truncate ${active ? 'font-semibold text-ink-1' : 'text-ink-2'}`}>
                    {clause.title}
                  </span>
                  <span className="block font-mono text-pin text-ink-4">
                    {busy ? 'Extracting…' : `Clause ${i + 1} of ${clauses.length}`}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/** The handoff's status-icon vocabulary, used consistently everywhere. */
function StatusIcon({ finding }: { finding: Finding | undefined }) {
  const size = 'w-3.5 h-3.5 mt-0.5 shrink-0';
  if (!finding || finding.status === 'pending') return <CircleDashed className={`${size} text-ink-6 opacity-50`} aria-hidden="true" />;
  if (finding.status === 'running') return <Loader className={`${size} text-ink-6 animate-spin`} aria-hidden="true" />;
  switch (finding.verification.state) {
    case 'verified': return <CheckCircle2 className={`${size} text-state-verified`} aria-hidden="true" />;
    case 'flagged': return <Flag className={`${size} text-state-flagged`} aria-hidden="true" />;
    case 'rejected': return <XCircle className={`${size} text-state-rejected`} aria-hidden="true" />;
    default: return <Circle className={`${size} text-ink-6`} aria-hidden="true" />;
  }
}
```

- [ ] **Step 4: Run to watch it pass, then mutation-test**

Run: `npx vitest run src/features/review/ClauseIndex.test.tsx` — expected PASS.
Now change `firstUncheckedClauseId`'s default to `'verified'` and re-run: expected FAIL on "treats a clause with no finding at all as unchecked". Restore.

- [ ] **Step 5: Relayout `ResultsView` to three panes**

The outer container becomes:

```tsx
    <div className="h-full flex flex-col md:flex-row bg-paper min-h-0">
      <ClauseIndex
        clauses={clauses}
        findings={findings}
        activeClauseId={activeClauseId}
        onSelect={setActiveClauseId}
      />
      <div className="w-full lg:w-[470px] shrink-0 border-r border-rule bg-card flex flex-col min-h-0">
        {/* R-GP7: the Findings/Assistant pair moves here from the rail. */}
        …tab pair, then either the active clause's FindingCard or ChatPanel…
      </div>
      <div className="flex-1 min-w-0 hidden lg:block">
        <DocumentViewer doc={activeDoc} highlights={highlights} />
      </div>
      …the three modals, unchanged…
    </div>
```

`activeClauseId` is new local state, seeded from `openAt?.clauseId` and otherwise from the first clause. **Guard the "the run changed" effect on the run id actually changing** rather than relying on effect order — React runs effects in declaration order, and a reset-on-mount effect will silently undo an earlier one that set the cursor.

The finding column renders **only the active clause's card**. Keep the existing `clauses.map` list behind nothing: delete it, because the clause index replaces it. `useVerifyKeys` keeps operating over the same `clauses` array and now drives `activeClauseId` as well as the verification, so `J` moves the selection.

- [ ] **Step 6: Wire the export-gate banner's destination**

In `App.tsx`, pass `onReviewUnchecked` to `ExportGateBanner`: it sets `openReviewAt` to `{ docId: activeDocId, clauseId: firstUncheckedClauseId(...) }` when there is one, and does nothing when there is not. This is the loop Task 17 deliberately left open until a clause index existed to receive it.

- [ ] **Step 7: Prove the verify loop survived**

Run: `npx vitest run src/features/review/useVerifyKeys.test.tsx src/features/review/ResultsView.test.tsx src/App.verification.test.tsx src/App.rerunResets.test.tsx`
Expected: PASS, unedited. If `ResultsView.test.tsx` asserted on the presence of every clause's card at once, that assertion is now false by design — it becomes an assertion that every clause is listed in the index and the active one's card is rendered. **That is a declared change and this task's commit message names it.**

- [ ] **Step 8: Verify in a browser at 1280px**

Three panes; `J` walks the index and the finding column follows; a citation still highlights in the document pane; the run banners and the gate banner span all three. Write down what you saw.

- [ ] **Step 9: Full gates and commit — on its own, and revertible**

Run: `npm test && npx tsc --noEmit && npm run build`

```bash
git add src/features/review/ClauseIndex.tsx src/features/review/ClauseIndex.test.tsx src/features/review/ResultsView.tsx src/App.tsx
git commit -F .git/COMMIT_G23
```

Message:

```
feat(g): move the review screen to the three-pane ledger

258px clause index, 470px finding column, fluid document pane. This is a
LAYOUT change, not a restyle, which is why it is its own commit at the end
of the sub-project: reverting this one commit leaves every other task in G
intact, and nothing landed before it depends on anything it introduces
(decision D2).

The finding gets a column of its own instead of a third of the screen. The
clause index carries the triage counts and the handoff's status-icon
vocabulary. The Findings/Assistant pair moves into the finding column's
header rather than out of the app (R-GP7).

The keyboard verify loop drives the selection now as well as the
verification, over the same clause order, stopping at the same ends.

The export-gate banner's "Review unchecked" now has somewhere to send the
reader, which is why task 17 left it unwired.
```

---

## Task 24: Rulings, README, and the browser-verification record

**Kind:** documentation. The sub-project's definition of done requires the browser verification to be **written down** (§15 item 12), and this project's most repeated defect is a decision made and then lost.

**Files:**
- Modify: `docs/superpowers/redesign/rulings.md`
- Modify: `README.md`
- Create: `docs/superpowers/redesign/g-browser-verification.md`

- [ ] **Step 1: Record the three owner decisions and the seven plan rulings**

Append to `docs/superpowers/redesign/rulings.md`, in its existing format:

- **The three decisions of §17, as ruled:** D1 — phone parity is **not** in G; it is **sub-project H**, to be specced separately; G ships ≥768px responsive behaviour of existing screens and no phone-specific screen. D2 — the three-pane ledger **is** in G, sequenced last, in one revertible commit. D3 — the `Standard positions` tab **is** built.
- **R-GP1** through **R-GP7** exactly as this plan's "Rulings made while writing this plan" section states them, each with its cost if wrong.

- [ ] **Step 2: Update the README**

Add, in the README's own voice:

- **Fonts are vendored, not fetched.** `public/fonts/` holds six latin-subset woff2 files. Updating a font version is a manual step — deliberately, because the app's privacy disclosure says nothing leaves the browser except calls to OpenRouter, and a font CDN would make that false on every page view.
- **One palette, no theme toggle.** Colour lives in `src/index.css` in two layers; components consume semantic role names and a raw colour anywhere under `src/` fails `src/test/palette.test.ts`.
- **Mobile:** the app is usable at 768px and above. Phone layouts are sub-project H and are not built.

- [ ] **Step 3: Write the browser-verification record**

Create `docs/superpowers/redesign/g-browser-verification.md` with §13.5's ten items as a checklist, each with what was observed, the date, and the browser. Items that could **not** be verified are recorded as **not verified**, with the reason — never left blank and never implied.

The ten: (1) fonts load and fall back gracefully with the files blocked; (2) contrast in situ, especially `ink-4`/`ink-5` metadata on `paper` and the mono chips at 9–10px; (3) the document pane's highlight fill, underline, `page`-on-`doc-gutter` and the one page shadow; (4) the three chips distinguishable at a glance on one finding that is simultaneously `verified`, `Medium` risk and `deviates`; (5) every load-error branch, forced by throwing from the repository — matters, library, matter, its three sections, review, playbook, run panel's picker; (6) a run mid-flight — progress bar, per-cell extracting, a cell erroring with Retry, cancellation, and a reopened interrupted review, all four banners; (7) a scanned PDF and a marked-up DOCX through the intake wizard; (8) reduced motion on, busy states still legible; (9) 768px and 1024px across every screen; (10) the two flows unit tests have historically missed — "Run a review" showing the right documents, and a review that failed once still being openable.

**CLAUDE.md's standing rule applies to this file above all: if you could not drive the real app, say so plainly rather than implying you did.**

- [ ] **Step 4: Confirm the definition of done, item by item**

Walk §15's twelve items and confirm each against the repo:

1. `npx tsc --noEmit` clean; `npm test` passes; `npm run build` clean with no externalization warning.
2. `src/index.css` carries the two-layer token set; the dark `@theme` block is gone.
3. The palette guard and semantic-role guard pass, un-skipped, each mutation-tested (Tasks 2 and 14).
4. The contrast test passes for every token pair (Task 4).
5. No application component references a raw colour, a raw hex, or a palette-layer variable (Task 14's guard).
6. Fonts served from the app's origin; no request leaves the page except to OpenRouter — verified in the network panel on a cold load (record it in Step 3's file).
7. Every component in §9 restyled, existing tests passing **unedited** except the three conversions (Task 3) and the R-G6 copy changes (Tasks 6, 11, 19, 20, 21).
8. Every §8 item present: nine load-error branches, four `ReviewVersionLine` outcomes, four position-health kinds, the absent `PositionChip`, four run banners, the frozen copy, the reduced-motion busy state.
9. No multi-user affordance ships; the avatar shows the local profile's initials.
10. The G-2 screens ship with their empty **and** error branches (Tasks 15–21).
11. Every screen usable at 768px (Task 22).
12. Browser-verified per §13.5, all ten items, and **written down** (Step 3).

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/redesign/rulings.md docs/superpowers/redesign/g-browser-verification.md README.md
git commit -F .git/COMMIT_G24
```

Message:

```
docs(g): record G's rulings, the mobile decision, and the browser verification

The three owner decisions are written down where the next reader will look:
phone parity is sub-project H and is scheduled rather than forgotten; the
three-pane ledger shipped as one revertible commit; the Standard positions
tab was built.

R-GP1 to R-GP7 are the rulings this plan made on its own authority, each
with its cost if wrong — including the one that departs from the spec's
literal wording, because role="status" on a busy element collides with the
selector thirteen positional chip assertions already use.

The browser verification is a file, not a claim, and anything that could
not be verified says so.
```

---

## Self-review

Run against the spec with fresh eyes, per the skill.

### 1. Spec coverage

| Spec requirement | Task |
| --- | --- |
| §3.1 two-layer token set in Tailwind 4, semantic roles | 1 |
| §3.2 self-hosted fonts with fallback stacks | 1 |
| §3.3 restyle of every screen in §9 | 5–13 |
| §3.4 responsive to 768px | 22 |
| §3.5 the inherited screens | 15, 16, 17, 19, 20, 21 |
| §3.6 the multi-user ruling applied everywhere | 6 (avatar, no counter/firm tag/search), 8 (no assignee chip), 15 (no "unassigned" count), 16 (single-actor feed) |
| §3.7 palette guard test | 2, 14 |
| §6.1 two layers, `@theme` vs `:root`, dark block deleted, `.custom-scrollbar` retinted | 1, 6 |
| §6.2 surfaces, ink, rules table; ink-4-and-below rule | 1; R-G19 restated in every restyle task's checklist |
| §6.3 semantic colour roles, teal-vs-green | 1 |
| §6.4 how a component consumes a role; the three-shapes rule | 5 |
| §6.5 typography, type scale as named roles, font delivery | 1 |
| §6.6 radii, spacing on the 4px grid, borders, two shadows, motion, icons, CSS graphics | 1 (tokens, `.lex-pulse`, reduced-motion), 5–13 (application) |
| §6.7 no dependency added | Global Constraints; nothing in any task adds one |
| §7 multi-user affordance table, row by row | 6, 8, 15, 16 |
| §8.1 nine load-error sites, both `LoadErrorPanel` variants, the retry control | 5, 7, 11, 13, 15, 19, 20 (the `title="Retry"` selector §13.3 names is `TabularReview`'s per-cell retry, preserved by 10) |
| §8.2 `ReviewVersionLine`'s four outcomes | 9 |
| §8.3 absent `PositionChip`, four health kinds, `StateChip` always renders | 5, 11 |
| §8.4 frozen copy | Global Constraints + each restyle task's checklist; the one permitted move is Task 12 |
| §8.5 four run banners, four per-cell states, rejected≠errored, scan/truncation/markup notices, parse errors | 8, 9, 10, 7 |
| §8.6 busy legible without motion; `.animate-spin` no longer a contract | 1 (`.lex-pulse` + reduced motion), 3 (the contract), 8 |
| §9.1 eight shared primitives | 5 |
| §9.2 chrome, nav rename, avatar, no search, no logo tile | 6 |
| §9.3 matters screens | 7 |
| §9.4 review screens (restyle) | 8, 9 |
| §9.4 `ResultsView` three panes | 23 |
| §9.5 grid and `CellDetail`, not rebuilt | 10 |
| §9.6 playbooks, incl. coverage line and no version diff | 11 |
| §9.7 authoring, incl. the privacy-line move | 12 |
| §9.8 settings and assistant | 13 |
| §10.1 status board stat row + activity list, with empty/partial/error | 15, 16 |
| §10.2 first-run intake, all three steps, no OCR bar, no AI suggestion | 18, 19 |
| §10.3 export-gate banner | 17 |
| §10.4 `Standard positions` tab | 20 |
| §10.5 `Compare` resolved onto the existing toggle; absent not disabled | 21 |
| §10.6 screens recommended not built (`Compare to v3`, `⌘K`, OCR) | Global Constraints; asserted in Tasks 11, 18 |
| §11 responsive ≥768px; phone parity deferred | 22 (and D1, recorded by 24) |
| §12.2 the order, steps 1–15 | Tasks 1→23 follow it exactly; step 7's "any order" group is Tasks 10–13 |
| §12.3 what may not be split | Tasks 1+2 adjacent; every restyle task carries its component's state branches; `verificationLabel`'s consumers are untouched throughout |
| §13.2 the three conversions | 3 |
| §13.3 structural contracts | Global Constraints + every restyle task's checklist |
| §13.4 palette guard, semantic-role guard, state-preservation tests, reduced-motion, contrast | 2, 14, 4; state-preservation tests in 15, 16, 17, 19, 20, 21; reduced-motion in 3 |
| §13.5 the ten browser checks | 22 (item 9), 23 (item 4-adjacent), 24 (the record of all ten) |
| §14 error handling: font failure, missing token | 1 (fallback stacks + the font test), 14 ("a new role is added in the same commit") |
| §15 definition of done, twelve items | 24 Step 4 |
| §17 D1, D2, D3 | The decisions section; 22, 23, 20; recorded by 24 |
| §18 R-G1…R-G21 | R-G1 → 6/8/15/16; R-G2 → 1/2; R-G3 → 1; R-G4 → 1/5; R-G5 → Global Constraints/12; R-G6 → 6/11/17/19/20; R-G7 → 1; R-G8 → 10; R-G9 → 16; R-G10 → 15; R-G11 → 21; R-G12 → 19; R-G13 → 18; R-G14 → 6; R-G15 → 11; R-G16 → 5; R-G17 → Global Constraints; R-G18 → 20; R-G19 → every restyle checklist; R-G20 → 1/3/8; R-G21 → 1 |

**Requirements with no task: none.**

Two things are deliberately *not* built and are named rather than missed: the AI playbook suggestion (R-G12), and `⌘K` search (R-G14). Both are recorded as deferred in Task 24.

### 2. Placeholder scan

No "TBD", no "add appropriate error handling", no "similar to Task N", no "write tests for the above" without the test code. Three places name something a later task fills, and each says exactly what and where: Task 18's step-3 section is `data-step="playbook"` and Task 19 replaces it with the code given there; Task 17 leaves `onReviewUnchecked` unwired and Task 23 wires it with the code given there; Task 20's `onOpenPlaybook` takes a `clauseId` its only call site does not use, and says why in a comment. The restyle tasks (5–13) share a template stated once in full rather than repeated — the template is complete, and each task states its own components, class strings and state checklist rather than pointing at a neighbour.

### 3. Type and name consistency

- `scanSource(file, source)` / `collectScannableFiles(root)` / `SCAN_EXEMPT` — defined in Task 2, used in Tasks 5–13's scan step and Task 14.
- `readTokens` / `contrastRatio` / `resolveColour` / `composite` — Task 4 only.
- `data-busy="true"` + `aria-live="polite"` — defined in Task 3, used in Tasks 5, 7, 8, 9, 13, 23. **Never `role="status"` on a busy element** (R-GP2), which stays the chip/toast selector in Tasks 5 and 10.
- `data-testid="cell-summary"` (Task 3) — asserted in Task 3, preserved in Task 10.
- `data-clause-row` (Task 3) — preserved in Task 11.
- `data-scroll-x` — Task 22 only.
- `summariseMatter` → `MatterStatSummary` (Task 15) consumed only by `MatterStats`.
- `matterActivity` → `ActivityEntry` / `ActivityKind` (Task 16) consumed only by `MatterActivity`.
- `buildPositionRows` → `PositionRow` / `PositionRowsInput` (Task 20) consumed by `StandardPositionsView` and `App.tsx`.
- `ExportGateBannerProps.findings` is `Review['findings']`, matching `verificationCounts`'s parameter type exactly.
- `ViewSwitchProps` (Task 21) is consumed unchanged by Task 23's finding column.
- `IntakeWizardProps` is declared once in Task 18 and **not changed** by Task 19 — Task 19 only fills in the section that consumes the props already declared.
- `MatterHomeProps` gains `localUserId` (Task 16), then `modelId` and `onOpenSettings` (Task 19). No task renames an existing prop.
- Token names are used identically everywhere: `accent`, `accent-tint`, `accent-edge`, `risk-high`, `risk-high-tint`, `risk-high-edge`, `risk-med`, `risk-med-tint`, `risk-med-edge`, `risk-low`, `risk-low-tint`, `state-verified`, `state-flagged`, `state-rejected`, `state-unchecked`, `outcome-meets`, `outcome-deviates`, `outcome-unclear`, `health-held`, `health-conceded`, `health-untested`, `health-none`, `net-confirmed`, `net-amended`, `net-unconfirmed`, `draft`, `draft-tint`, `highlight-fill`, `highlight-edge`, `ink-1`…`ink-6`, `ink-prose`, `ink-quote`, `rule`, `rule-soft`, `rule-strong`, `chip-fill`, `paper`, `card`, `page`, `canvas`, `doc-gutter`. Every one of them is declared in Task 1 and exercised by Task 4's `PAIRS` or listed in its `SURFACE_ONLY` set.
