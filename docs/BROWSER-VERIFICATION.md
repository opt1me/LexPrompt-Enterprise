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

## Known unverified beyond this list

- Nothing has been deployed to Azure. Spike 2's Azure half and Spike 3's Container Apps
  ingress half are both unanswered — cross-replica fan-out is proved locally at two
  replicas, never through Container Apps.
- Entra itself has never been touched; both claim shapes are tested offline through one
  lookup, so overage, consent and conditional access are unproven.
- The findings migration has never run against real user data (its report says so).
- No `infra/` template has been compiled or validated.
