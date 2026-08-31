# Parts 5A and 5B — the gate, with three accounts on a running stack

**Status: PASSED.** Part 5C may begin.

Six commits, `ab1c04a` … `209fe5c`, plus this gate. Every task's own report is its
commit message; this file is the gate's own record.

---

## Step 1 — the searched checks

`apps/api/test/stage5abDoD.test.ts`, 13 cases. Each carries its sanity half.

- **Four prohibitions became POSITIVE assertions, not deletions (P46).** The counter,
  the chip, the search palette and the Report view each assert presence where a
  prohibition stood, and each keeps the RULE the prohibition was protecting: three
  states on the counter, no state ink and no control on the chip, the corpus sentence
  on the palette, borrowed wording and no `lib/api` import on the report.
- **`assigneeId` stays forbidden** and `R-G1` is still named in `stage2DoD`.
- **The firm tag had NO guard at all.** The brief said to assert `stage4DoD` still
  forbids it; no shipped suite ever did — the absence lived in `CLAUDE.md` and in
  nothing executable. It is asserted here for the first time, over the components,
  with a sanity half.
- **One id-to-name resolver**, one home for every piece of export wording, and one
  wording for "someone this workspace does not name" across four surfaces.
- **Part 5C has not started**: no admin write route, no `RoleMappingPanel`, no
  `insert`/`update` grant on `role_mapping`, and no migration added by 5A or 5B.
- **No runtime dependency added** in any of the three workspaces.

### One finding this gate records for Part 5C

**The plan's `014_role_mapping_source.sql` is a number already taken.**
`014_audit_partitions.sql` exists and an applied migration is immutable, so 5C's
migration must be `015_`. Asserted in the gate rather than left to be discovered when
two files claim one number.

---

## Step 2 — the live checks, three accounts, in order

Run against the compose stack (`docker compose --env-file /tmp/compose.env up -d
--build`), all six services healthy. Encoded in
`apps/api/test/stage5abDoD.compose.test.ts` (5 cases, all passing) and reproduced by
hand first.

| # | Check | Result |
|---|-------|--------|
| 1 | `signIn('admin')` returns `role: 'admin'` (P61's premise, re-checked) | **`{ trainee: 'reviewer', partner: 'partner', admin: 'admin' }`**, three distinct `app_user` ids |
| 2 | Unauthenticated `GET /v1/search?q=ashcroft` | **401 `sign_in_required`**, and the body has **no `hits` key** — a refusal, never an empty result set |
| 3 | Two matters, two reviews, two assignments to the partner | Inbox named **both matters, both review names and both clause titles** (`Gate Ashcroft` / `Liability cap`, `Gate Brookvale` / `Indemnity`). The assigner's own inbox: **empty** |
| 4 | The trainee withdraws one | **200**; the partner's inbox drops to one. The assignee's socket receives `assignment.created`/`assignment.resolved` — proved in `assignedToMe.compose.test.ts`, **56 ms** to the assignee's socket |
| 5 | `GET /v1/reviews/:id/assignments` as a **third session** | **200, 1 open request visible.** The bystander's `POST …/resolve` → **403 `not_permitted`**, and the request is **still open** afterwards. The partner then closes it with 200, so the refusal is about who the caller is and not about the id |
| 6 | Search as the trainee | Matter, its **document**, its **review** and its **precedent** all found. `precedent 2019` → **1 `precedent` hit, 0 `document` hits** (S23). All seven sources report `ok` on a successful search AND on an empty one. Text inside a document (`body text`) → **0 hits with all seven `ok`**. One-letter query → **400 `query_too_short`** |
| 7 | A broken arm answers 200 with `status: 'failed'` on that source and hits from the others | Proved by **injection against the real database** in `search.pg.test.ts` (`answers with the other arms hits when ONE arm throws`, and `does not turn a broken arm into a 500`), using a statement against a table that does not exist. Not re-run against the container, which would have meant shipping a deliberately broken route into an image — the pg suite runs the same `runSearch` over the same Postgres |
| 8 | `docker compose exec api wget https://example.com` | **`wget: bad address 'example.com'`, exit 1.** Egress still denied; re-checked rather than inherited because a new route group landed |
| 9 | Everything this gate created is deleted | Yes. The hand-run script deleted 2 matters + 2 reviews (`Gate Ashcroft`, `Gate Brookvale`), a precedent set, a matter document and a precedent document; the compose suite's `afterAll` deletes its own four matters and reviews (`stage5ab inbox A/B`, `stage5ab bystander`, `stage5ab searchable`) |

---

## Step 3 — what could not be done, and what nobody has seen

**Browser automation is unavailable and remains so.** The Playwright MCP server timed
out on connect this session (`CONNECT_TIMEOUT`, 30 s), and the Chrome extension tools
were not reachable. `list_connected_browsers` was therefore not callable; the failure
is a connection failure rather than a missing capability, and it is recorded as such.

**Nobody has looked at any Stage 5 screen.** Specifically:

- the counter's **"not known"** marker, which is the whole point of Task 2;
- the counter's empty case actually rendering as nothing;
- the palette's **failed** state beside its **empty** state — the pair the feature
  exists to keep apart;
- the corpus sentence being read rather than being wallpaper;
- the **chip** on a card, on a clause row and in a grid cell;
- the **Report tab**, and whether it prints.

Every rendered-string claim in Parts 5A and 5B is asserted in jsdom and by nothing that
has looked at a screen. `docs/BROWSER-VERIFICATION.md` gained a Stage 5 section naming
each of the above as a checkbox for a person.

---

## Gates at the moment this was written

- `npm run typecheck` — **exit 0, 4 projects**
- `npx vitest run` — **exit 0, 232 files / 3185 tests**, no unhandled errors
- `npm run test:pg` — **exit 0, 44 files / 636 tests**
- `npm run test:compose` — **exit 0, 16 files / 62 tests**
- `npm run build` — clean, no externalization warning
