# What nobody has seen

Five stages of LexPrompt Server were built without a working browser. Everything in
them is proved against a real Postgres, a real gateway, real OIDC tokens and a live
compose stack — but a set of clauses are **"met by rendered string"**: a test asserts
the text, and no human has looked at it. This file is that set, as a checklist.

It exists because the honest answer to "is it done?" is different for a mechanism and
for a screen, and the difference should be written down rather than remembered.

**Why it was not closed automatically.** Two reasons, and the second is the real one:
the Chrome extension disconnected mid-session and Playwright's MCP would not connect —
but even with both working, signing in means typing a password, which Claude will not
do. Every screen worth checking is behind the sign-in gate. So this needs a person.

## Setup (about two minutes)

```bash
docker compose --env-file <your env file> up -d     # six services
bash scripts/pg-forward.sh                          # if you want to poke the database
```

Then `http://localhost:3005`. Accounts (`scripts/print-local-accounts.sh`):

| account    | password   | group      | expect |
|------------|------------|------------|--------|
| `trainee`  | `trainee`  | reviewers  | full review access |
| `partner`  | `partner`  | partners   | can publish, can override |
| `admin`    | `admin`    | admins     | can change the model choice |
| `nogroups` | `nogroups` | none       | **refused, on purpose** |

> The repo's `.env` is NOT a compose env file — it holds a single bare line. Use
> `--env-file` with a real one, or `docker compose up` will bake empty OIDC args into
> the web image and break sign-in.

## One person, one browser

- [ ] `nogroups` signs in and is **refused**, and the refusal reads as "you are not set
      up yet", not as an error or a broken app.
- [ ] A document uploads and shows **"Reading…"** while the parse worker runs, then
      settles. It must never look like a document with no text.
- [ ] A run fills in **progressively** rather than appearing all at once at the end.
- [ ] Reload mid-run: the run picks up where it was.
- [ ] Verify a finding. The card names **who** and **when**.
- [ ] "See what changed" opens the history, oldest first, with names.
- [ ] Kill the API (`docker compose … stop api`) with a review open: the **stale banner**
      appears and the controls that depend on freshness go dead. This is the one that
      matters most — a live view that stopped being live must not look like a quiet one.
- [ ] Export a review. The DOCX and CSV say **when it was true** and that it can change.

## Two people, two browsers

Use two profiles, or one normal and one private window.

- [ ] `trainee` and `partner` both open the same review. Each sees the other in
      **presence**, ideally down to the clause.
- [ ] A presence face reads as **"looking at this"** and never as "checked this".
      (`FindingCard` says VIEWING in words for this reason — does it land?)
- [ ] `trainee` verifies a clause. It appears on `partner`'s screen **without a reload**.
- [ ] `partner` overrides it. `trainee`'s card updates and names the partner.
- [ ] Both edit the same finding from a stale load: the loser gets a notice **naming who
      won and when**, and an offer to apply theirs again. It should read as a decision to
      make, not an error.
- [ ] `trainee` opens the reject-reason dialog; `partner` changes the same finding while
      it is open. The change is **held and announced**, not applied under the open control.
- [ ] `trainee` assigns a clause to `partner`. It reaches `partner` live **and** is in
      their list after a reload.
- [ ] A **third** account with the review open sees neither "you asked" nor "asked you"
      on that assignment, and no Withdraw button. **Changed in Stage 5:** they now see an
      assignee **chip** instead of nothing — check it reads as *"R. Okafor was asked to
      look"* and never as a verification, that it carries **no message** (the assigner's
      brief is between the two of them), and that it still offers **no control at all**.

## Stage 5's four new surfaces — nobody has seen any of them

Every claim about these is a rendered string asserted in jsdom. That is a weaker claim
than the mechanisms above, and it is weaker in exactly the place it matters: whether a
person reading quickly takes the right meaning from it.

- [ ] **The "assigned to me" counter** (header, beside your avatar). With something
      assigned to you it shows a number; with nothing assigned it shows **nothing at
      all** — check the empty case really is invisible and not a "0".
- [ ] **The counter's "not known" marker**, which is the one that matters. Stop the API
      (`docker compose … stop api`) and reload: the counter must read **"not known"**
      with the reason on hover and in its accessible name, and must never show a digit.
      A badge showing `0` because a fetch failed looks exactly like a quiet week.
- [ ] The counter **names the matters** in its tooltip and its accessible name, since
      there is no cross-matter inbox screen to click through to. Does that read as
      useful, or as a dead end?
- [ ] **The assignee chip** on a card, on a clause row in the rail, and in a grid cell.
      Three sizes of the same mark: does any of them read as a state? Does the grid cell
      look crowded beside the state chip and the risk chip?
- [ ] **The search palette** (`⌘K` / `Ctrl-K`, or the magnifier in the header). Opens on
      the shortcut, closes on Escape, and focus returns to whatever opened it.
- [ ] The palette's **corpus sentence** — *"It does not search the text inside
      documents"* — is on screen in every state. Is it read, or is it wallpaper?
- [ ] **An empty result and a failed search do not read the same.** Type something that
      matches nothing (*"nothing matched …"*, no button), then stop the API and search
      again (*"That search could not be run …"*, with **Try again**). This is the pair
      the whole feature exists to keep apart.
- [ ] A **partial** failure: one source missing with the rest answering. Hard to produce
      by hand — the assertion is `search.pg.test.ts`'s injected broken arm — but if you
      can, check the named line reads as *"some results are missing"* rather than as an
      error covering the whole list.
- [ ] A **precedent** hit is labelled as a precedent and never as a document in a
      matter, and it is **not clickable**, because there is no screen to open one on.
- [ ] **The Report tab** (third tab in the review header). Check it says the same things
      the DOCX says — export the same review and read them side by side. Check the
      Compare tab is absent for a single-document review while Report is still there.
- [ ] Print the Report tab (`Ctrl-P`). It is print-friendly by CSS only; nobody has seen
      a page break.


## Stage 5 Part 5C — the administration screens

**Nobody has looked at any of these.** Every mechanism below is proved headlessly — over
real HTTP with three real accounts, against the real Postgres, or in jsdom — and every
rendered string is asserted in jsdom and by nothing that has seen a screen. Sign in as
`admin` / `admin` at `http://localhost:3005` and open **Administration** in the header
(the link appears only for an administrator).

### `/admin/roles` — the screen that writes policy

- [ ] **The nav link is absent** for `trainee` and for `partner`, and typing
      `/admin/roles` as either of them shows the refusal panel — *"These screens are for
      administrators"* naming their own role — rather than a half-drawn screen whose
      every fetch 403s.
- [ ] **The "read at" line.** It must be on screen, in local time, and it must move when
      you reload. A policy screen with no instant cannot be told apart from a stale one,
      and this is the whole of P54.
- [ ] **A configuration row's controls are disabled AND say why**, naming
      `API_ROLE_MAPPINGS`. Does the reason read as a reason, or does the row just look
      broken? All three seeded mappings (`reviewers`, `partners`, `admins`) are
      configuration rows, so this is the default view.
- [ ] **Add a mapping**, then read the dialog before confirming. The sentence is the
      SERVER's, rendered verbatim: does it read as English on screen, at that width, or
      does it wrap into something nobody finishes?
- [ ] The **typed confirmation** for a widening. The word asked for is the role's own
      name (`admin`). Is it obvious what to type? Does the disabled button explain
      itself?
- [ ] **A narrowing asks for no typing at all.** Change an admin-authored mapping down a
      level and check the dialog still shows a sentence and the button is live
      immediately.
- [ ] **A superseded row.** Hard to produce by hand: set a mapping from the screen, then
      add the same `issuer|group` to `OIDC_ROLE_MAPPINGS` in `/tmp/compose.env` and
      `docker compose --env-file /tmp/compose.env up -d --build api`. The row must then
      read *"replaced by deployment configuration"* with a date, permanently, and the
      api log must carry the supersession line. Both are asserted headlessly; neither
      has been read on a screen.
- [ ] **The empty state.** Delete every mapping (migrator connection — no route can
      empty it) and reload: it must say **nobody can sign in**, loudly, and never render
      an empty table. Put them back afterwards, or the stack is locked out.

### `/admin/people`

- [ ] The role line reads **"the role at their last request"** and claims no instant.
      Does that read as pedantry or as the distinction it is?
- [ ] **Your own row offers nothing**, and says why. Check the sentence is where a
      person looks for the missing buttons rather than at the bottom of the card.
- [ ] **Turn an account off**, then use that person's other browser: they must be
      refused on their next click, with the account-disabled wording. Turn it back on.
- [ ] **The retire-a-name dialog.** It must say **permanent**, must say it is NOT
      deletion, and must say what survives. Do not confirm it against a seeded account —
      it cannot be undone from the application.

### `/admin/providers`

- [ ] **Nothing on this screen is editable** — no input, no select, no button at all.
      Does it read as a report, or as a form somebody forgot to enable?
- [ ] The per-provider guarantee sentence. The compose stack uses the `recorded`
      provider with an env credential, so it should read **"the key is held only by the
      gateway"** and must NOT read "no provider key exists". Nobody has seen the
      managed-identity wording on a screen at all, because no local deployment can
      produce it.
- [ ] The **dated `dataHandling` note**, and the over-a-year marker. `models.json` in
      this stack may carry no note — if so, the *"No note of this provider's terms has
      been recorded"* line is what to read instead.

### `/admin/audit` — the artefact that leaves the building

- [ ] **The manifest is on screen before the download**, and it lists all three sources
      including the ones with zero rows. Is the zero readable as "covered, nothing
      happened", or does it read as an error?
- [ ] **Download it and open it in a spreadsheet.** The manifest must be the first block
      of the file, before the header row. Does Excel mangle it? Nobody has opened this
      file in any spreadsheet.
- [ ] **The refusal.** Not reproducible by hand without 50 000 rows; the assertion is
      `auditExport.pg.test.ts` with a lowered ceiling. If you can produce it, check the
      narrower-range buttons are where a person would reach for them.

## The cross-stage seam fixes — six surfaces changed wording, and nobody has seen any of them

These came out of the cross-stage seam review. Every one is a sentence a reader acts
on, changed because the old sentence made a **false first-person claim** — and a
first-person claim is exactly the kind of thing a unit test can assert the letters of
while the screen still reads wrongly. Two profiles are needed for four of the six: the
whole point is what the OTHER person's screen says.

1. **A net position confirmed by a colleague** (`NetPositionPanel`, inside a collection
   review's finding card, and again inside the variation trail modal). Partner confirms
   or amends; trainee opens the same review. The line must read *"Confirmed by
   \<partner's name\> on …"*, never *"Confirmed by you"*. Check **both** places it is
   rendered — the card and the trail — because they are two renders of one panel and an
   attribution that differed between them would be invisible to a reader in either.
2. **A version published by a partner** (`Version history`, from the playbook editor and
   from a review header). A reviewer cannot publish and a partner can, so this is the
   one screen whose author is *guaranteed* to sometimes be somebody else. Every row must
   name a person. Check a row whose author has been pseudonymised too — it should read
   *"Published by Former user 1a2b3c4d"*, not a uuid and not a blank.
3. **Two colleagues' notes in one export.** Reviewer A notes one thing, reviewer B the
   opposite, on the same clause. Take the DOCX and both CSVs. Each line must read
   *"Note by \<name\>: …"*. This is the case with no card beside it to click, so if the
   names are wrong here nothing else recovers them.
4. **The audit extract, opened in a real spreadsheet** (already on the twenty-minute
   list, and now with a specific thing to try). Rename a matter to
   `=HYPERLINK("https://example.com","click")` as a reviewer, then take the extract as an
   administrator and open it in Excel **and** in Google Sheets. The cell must show the
   text, not a link. Nobody has opened one of these files at all.
5. **A standard position's provenance** (`StandardPositionField`, playbook editor). It
   now reads *"Written by a person"* / *"Drafted by AI, reviewed by a person"* rather
   than "by you". Read it as the second person to open the clause and check it does not
   look like a bug — the wording is deliberately weaker than the other two because
   `StandardPosition` records no author to name.
6. **An unresolvable actor, anywhere.** Sign in, open a review with a colleague's
   disposition on it, then stop the API before the directory loads. Every attribution
   surface should say *"someone this workspace does not name"* — the roster, the
   assignee chip, the asked-of-you list, the activity feed, the card's actor line, the
   net position and the version history. They now share one constant, so they should be
   identical; if two of them differ, the constant is not reaching one of them.

Also unseen, and not a browser task: **the API's new refusal to start** when the
migration ledger names a version the build does not carry. Verify by hand against a
disposable database — insert a row into `schema_migration` with a made-up version and
confirm the container refuses with the sentence naming it, rather than booting.

## If you only have twenty minutes

The six above, in the order of what being wrong costs. Each is a case where a passing
test and a misread screen are the same green.

1. **The counter's "not known" marker** (stop the API, reload). A badge that reads as a
   quiet week when it means "I could not ask" leaves a colleague waiting on something
   you were never told about.
2. **The empty search versus the failed search.** Two different sentences and two
   different controls; if they read the same, the search is answering "nothing in this
   firm matches" to a question it never asked.
3. **The widening sentence at `/admin/roles`**, read at real width before confirming.
   It is produced by the server and rendered verbatim precisely so the screen cannot
   describe a policy change in milder words than the server would.
4. **The assignee chip**, at all three sizes. If it reads as *checked* rather than as
   *asked to look*, it is a judgement the app invented.
5. **The audit extract opened in a real spreadsheet.** Nobody has opened one. It is the
   artefact that leaves the building and has no refresh button.
6. **Two profiles in one review** — presence, a live override, and the refusal notice.
   Five stages have closed without this and it is the app's central promise.

Write what you find straight into this file — a checked box, or a line saying what it
actually looked like. A checklist whose results live in somebody's memory is a
checklist nobody can act on.

## Known unverified beyond this list

- **No browser has been driven in any of the five stages.** `list_connected_browsers`
  answers with an empty list and the Playwright MCP times out on connect. That is a
  connection failure rather than a missing capability, and it has been recorded as such
  at the close of every stage.
- Nothing has been deployed to Azure. Spike 2's Azure half and Spike 3's Container Apps
  ingress half are both unanswered — cross-replica fan-out is proved locally at two
  replicas, never through Container Apps.
- **§18 item 9's deployed two-account pass** has never been run, and **§18 item 10(c)**
  — the integration and end-to-end suites against an ephemeral *deployed* environment —
  has never been run either. Everything green here is green in one environment.
- Entra itself has never been touched; both claim shapes are tested offline through one
  lookup, so overage, consent and conditional access are unproven.
- The findings migration has never run against real user data (its report says so).
- No `infra/` template has been compiled or validated.
- **This list is the project's closing state, not a snapshot mid-way.** Stage 5 was the
  last planned stage; nothing later is scheduled to close any of it.
- **The six wording changes above have been verified only in jsdom.** Every one of them
  is a sentence about WHO did something, and the tests that pin them supply a fake
  directory. What no test can answer is whether the sentence reads correctly to the
  second person on a real screen at real width, which is the failure the old wording
  had for two whole stages while its tests were green.
