# LexPrompt Server — Stage 1: the inference gateway — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a firm-deployed inference gateway the single route from LexPrompt to a model — five pluggable provider backends behind one adapter interface, an operator-configured allowlist of provider+model pairs each declaring its processing jurisdiction, credentials that never leave the gateway, and an audit record per call — while the rest of the app stays browser-only.

**Architecture:** Three new npm workspaces (`packages/core`, `apps/gateway`, `apps/api`) beside the existing web app. `apps/gateway` is the only component that may egress: it holds the allowlist, resolves each provider's credential from the platform secret store (or from an Azure managed identity where the provider supports one), writes the call log, and speaks **one** canonical SSE frame format outwards regardless of which provider answered. Every provider difference — request shape, auth header, event framing, structured-output mechanism — lives inside that provider's adapter and nowhere else. `apps/api` validates the user's OIDC token against a **configured** issuer — Entra ID in a firm deployment, Keycloak in `docker compose` — injects the actor identity from that token and forwards to the gateway — and, for streams, is a byte-transparent pipe that parses nothing. The browser calls `apps/api` through a `ModelClient` whose shape is `openrouter.ts`'s shape minus the key. `src/lib/openrouter.ts` is deleted.

**Tech Stack:** TypeScript 5.8, Vitest 3.2 (`test.projects`: jsdom for `src/**`, node for `packages/**` and `apps/**`), Node 22 in containers (nothing newer than Node 20.19 APIs is used, because the development machine runs 20.20.1), Fastify 5, undici, `@azure/identity`, `@azure/keyvault-secrets`, `jose`, `oidc-client-ts`, Keycloak (local OIDC issuer), Docker Compose, `azd` + Bicep. **`@azure/msal-browser` is deliberately not used** — see Revision 2 below. React 19 / Vite 6 / Tailwind 4 unchanged. **No provider SDK is added** — every adapter speaks its provider's HTTP API through `undici`, because five SDKs would be five dependency trees, five auth abstractions and five retry policies to keep in agreement with §10's.

**Spec:** `docs/superpowers/specs/2026-08-28-lexprompt-server-design.md` (binding authority). Stage 1's boundary is §13; the gateway's specification is §10; the local/deployed equivalence it must preserve is §5.1; auth is §7; the Risk story it exists to make true is §12; rulings **S1**, **S2**, **S10 (amended)**, **S15**, **S25–S31** and the testing bar in §14.

---

## The owner's multi-provider decision, 2026-08-28

The owner has changed the gateway from Foundry-only to **multi-provider**, after this plan was begun. **A spec revision carrying the identical wording is being written in parallel; where the revised spec and this plan disagree, the spec wins.** The owner's reason, verbatim:

> *"I think we probably want different AI layers — Foundry, OpenRouter, Claude, OpenAI, Azure OpenAI etc. And they choose. That's particularly useful for any smaller firms or individuals running it locally who won't have Azure infrastructure."*

Five consequences, each binding on this plan:

1. **Providers are pluggable and operator-chosen.** At minimum: Azure AI Foundry, Azure OpenAI, OpenAI, Anthropic, OpenRouter. **Adding a sixth must not require touching a call site** — one adapter interface (`ProviderAdapter`, Task 8), one registration point (`adapters/registry.ts`, Task 8).

2. **The central claim is restated, and the restatement is not cosmetic.** §1's *"there are no provider API keys anywhere in the system"* was true of a Foundry-only, managed-identity deployment and is **not** true of a deployment configured against OpenAI or Anthropic. The claim this plan builds to, and the sentence the README and §12 Q5 must carry, is:

   > **No credential ever leaves the gateway, and every call is logged with its provider and jurisdiction, whichever backend is configured.**

   And, stated **separately** rather than folded into it:

   > **An Azure-only deployment using managed identity retains the stronger property — no provider keys exist at all, in a browser, an environment variable, Key Vault or a git history. That is the recommended posture for a firm with Azure.**

   Both are true. Conflating them is how a security claim quietly becomes false for half its deployments, which is this project's founding defect pointed at a Risk reviewer.

3. **Every configured provider declares its processing jurisdiction**, surfaced to the operator **where the choice is made** — at gateway startup, in `GET /v1/models`, and on every option in the model picker — and recorded per call in the audit record. A firm must not be able to believe it is processing in one place while routing privileged text to another. **Which jurisdictions are acceptable is the operator's judgement, not this design's** (owner decision 5, D4): a firm may hold entirely sound provisions with a US provider — SCCs, a DPA, negotiated retention and training terms — settled with legal input long before anyone edits a config file, and **the key is the interface to a service whose guarantees live in the contract behind it.** So `GATEWAY_ALLOWED_JURISDICTIONS` has **no default anywhere** and the gateway refuses to start unset; an entry outside the declared set **refuses to start the gateway**; and the whole table prints on boot. The mechanism is unchanged and strict — what it enforces is the operator's declared policy.

4. **S15's allowlist becomes provider+model pairs**, each carrying its declared region. **A user still cannot name an arbitrary model** — that property is unchanged and is what S15 is for.

5. **Local development with no Azure at all is a first-class path, not a degraded one.** Running against an OpenAI or OpenRouter key with `docker compose up` and nothing else uses the same allowlist check, the same jurisdiction gate, the same audit sink and the same failure behaviour. **It must not skip logging.** A local deployment that fails to log would teach people to expect a gateway that does not.

**And the constraint that binds all five: this must not become five parallel implementations.** One adapter interface, one audit path, one allowlist check, one streaming path. Where a provider genuinely differs — Anthropic's `system` is a top-level parameter rather than a message and its `max_tokens` is required; Anthropic's stream frames content as `content_block_delta` where OpenAI-compatible providers frame it as `choices[0].delta.content`; Anthropic's structured output is a forced tool call where the others use `response_format` — **that difference lives inside that provider's adapter and is visible nowhere else in the codebase**. Duplicated per-provider logic is this project's most expensive recurring defect and it would be worse here than anywhere, because the two copies would be reachable only by two different operators' configurations and neither would ever see the other's.

**What this changes in the spec as written.** §1's second claim, §10's "How it authenticates to Foundry", §10's deployment allowlist, §12 Q5's subprocessor answer, §18.2's Stage-1 definition of done and ruling **S2**. §2's *"OpenRouter is removed as a subprocessor"* becomes *"OpenRouter is no longer a mandatory subprocessor; it is one configurable backend among five, and whichever backends are configured are named, with their jurisdictions, in §12 Q5."* Everything else in the spec stands unamended.

---

## The owner's one-system-two-environments decision (spec Revision 2, §17 Q11)

The spec was revised again after this plan was first written. **Q11 is answered, and the answer is structural rather than a choice between deployment modes.** The owner:

> *"I want it to work cohesively when deployed within a firm, but also make it easy for someone to build and test on their own machine for testing. So ideally best of both."*

The local path is not a deployment mode; **it is a development environment for the one system the spec specifies.** The claim §5.1 exists to make true — *the code that runs on a developer's laptop is the code that runs in the firm's tenant* — is what this plan must not break. Six consequences, each binding here:

1. **One authentication path — OIDC — with two issuers.** Entra ID in a firm deployment, **Keycloak** in `docker compose`. The application reads a discovery document, validates against the JWKS it names, and reads group membership from a **configured** claim. **There is no Entra branch anywhere in the codebase** (S28). Entra's tenant check is a **configured required claim** — `{ tid: <tenant id> }` — never a code path, and that distinction is exactly what makes "never special-cases Entra" literally true rather than merely intended.

2. **MSAL is out.** It is Entra's own library. Keeping it would tie the sign-in path to one issuer, or produce a second sign-in path for the other — two implementations of one idea at the front door, which is this project's most repeated defect in the worst possible place. **The browser uses `oidc-client-ts` or an equivalent standards-only client.** Recorded emphatically because "use MSAL for Entra" is the obvious choice and it is the wrong one here, and because a removed dependency is the kind of thing a later reader reinstates by accident.

3. **There is no development bypass** (S29). No `SKIP_AUTH`, no anonymous local mode, no trusted header, no configuration that disables authentication. Two reasons and the second is decisive for this project: a bypass is the flag that reaches production enabled, and **a bypass tests a different code path from the one that ships** — the same class of error as a test that passes against unfixed code. A green local run under a bypass would prove nothing, which removes the only reason to have a faithful local stack at all. §14 requires the absence to be **mutation-tested**: add a `SKIP_AUTH` path and the `auth` suite must fail.

4. **Keycloak seeds four users, and the reason is not convenience** (S31). A reviewer (trainee), a partner, an admin, **and a user in no mapped group**. Every collaborative behaviour this design adds — first sight of a colleague, a Partner override, the stale-version refusal, assignment, presence — is *unobservable with one user*, so a single-user local stack would run green on exactly the half of the system that does not need testing. Stages 3–5 are unbuildable without it, and the fourth account tests a Stage 1 behaviour: being told plainly that you have no access. **They ship in Stage 1** because Stage 1 is the first stage requiring a signed-in user and there is no bypass to stand in for one.

5. **The recorded-response stub becomes a registered adapter, not a bypass.** It appears in the registry, passes `adapterConformance`, declares a jurisdiction, and is refused in a firm deployment by S27's *existing* mechanism rather than a new one. Every response it produces is marked — on the finding, on the `run` row (`provider = 'recorded'`), and behind a loud non-dismissible banner. It is the one component of the local stack capable of producing a **confident wrong answer**, so it is the one that must say loudest what it is.

6. **§5.1's divergence list is exhaustive, and §18 item 10 checks it mechanically.** Deployment-varying values are read in exactly one typed configuration module per app; no module branches on the environment (no `isLocal`, no `if (dev)`, no `NODE_ENV` outside build tooling, no `process.env` outside that module); and the set of configuration keys differing between the two environments is *exactly* §5.1's table — **a differing key with no row fails, and a row with no key behind it fails too**, so the table cannot rot into optimism. §5.1 is the one guarantee in this design not otherwise enforced by a test at rest.

**Which of §5.1's nine rows Stage 1 touches:** row 1 (issuer — Tasks 16, 19, 24), row 2 (provider adapter and credential — Tasks 7, 8, 13, the one deliberate different code path, already ruled by D3/S2), row 3 (secret source — Task 7), row 7 (`api` egress denial — Tasks 24, 25), row 8 (gateway log sink — Tasks 6, 24), row 9 (ingress — Tasks 24, 25). Rows 4, 5 and 6 — Postgres, Azurite, Redis — are Stage 2 and later and **must not appear in this stage's compose file**, since a row with no key behind it fails §18 item 10(b).

**What running locally does not prove**, carried into Task 26's README so a developer meets it where they need it: managed-identity acquisition; Entra's group-claim shape, consent and **overage**; admin consent, conditional access, MFA and tenant token lifetimes; Azure networking and the real egress denial; Postgres Flexible Server's own behaviour; Azurite's gaps; real provider latency, rate limits and stream behaviour; Container Apps scale-to-zero and multi-replica WebSockets. **Keycloak is not an Entra emulator** — Azurite *emulates* Blob Storage, Keycloak *implements the same protocol* Entra implements, and that distinction is precisely where this list bites.

**Nothing in this revision changes the gateway, the adapters, streaming, the allowlist, jurisdiction enforcement or the audit record** — with the two exceptions the revision itself forces: `recorded` joins `PROVIDER_IDS` as a real adapter (Tasks 2, 10, 13), and the audit record's actor becomes `(actorIssuer, actorSubject)` rather than an Entra-shaped id (Tasks 6, 17).

---

## Relationship to Stage 0, stated once

§13 lists **Stage 0** (`packages/core` extraction, monorepo conversion) before Stage 1. **Stage 0 has no plan and does not exist in code at the time of writing.** This plan therefore does not depend on it, and does not pre-empt it either:

- Task 1 turns the repository into an npm workspace root **without moving `src/`**. The web app stays where it is (root `package.json`, `src/`, `vite.config.ts`). Stage 0 later moves it to `apps/web/` and moves the other ~40 `src/lib` modules into `packages/core`.
- Task 1 creates `packages/core` containing **only** what Stage 1 genuinely shares between the browser and the server: `parseJsonLoose` (§10 says it moves there), the model protocol types, and the one SSE parser. Stage 0 adds to that package rather than creating a sibling. **Do not create a second shared package** — S14 exists to prevent exactly that.
- If Stage 0 has already landed when you execute this plan, every path in this document written as `src/…` reads as `apps/web/src/…`, and Task 1's workspace scaffolding is already done — verify it matches, then skip to Task 1 Step 6.

---

## Global Constraints

Copied verbatim from the spec and from `CLAUDE.md`. Every task's requirements implicitly include this section.

- **Fail loudly rather than answer quietly wrong.** Prefer a loud, specific, recoverable failure over anything that could be mistaken for a successful empty result.
- **The inference gateway is the only component in the system permitted to egress. Nothing else can call a model — not as a convention, as a network fact.** (§1, S1)
- **No credential ever leaves the gateway, and every call is logged with its provider and jurisdiction, whichever backend is configured.** (S2, as revised) A credential is never sent to `apps/api`, never sent to a browser, never written to a log line, never included in an error message and never echoed in a response body.
- **An Azure-only deployment using managed identity retains the stronger property — no provider keys exist at all: not in a browser, not in an environment variable, not in Key Vault, not in a git history. That is the recommended posture for a firm with Azure.** Stated separately from the sentence above, never folded into it.
- **A credential-resolution failure is a loud `503` naming the failure — never a fallback to an unauthenticated call, to a different credential, or to a different provider**, which are the three shapes of "answer quietly wrong" available to this service. (§10)
- **An allowlist of provider+model pairs, each declaring its processing jurisdiction. A request naming an entry not on the list is rejected. A user cannot name a model.** (§10, S15)
- **Every allowlist entry's jurisdiction is visible where the choice is made** — printed at gateway startup, returned by `GET /v1/models`, shown on every option in the model picker, and recorded on every audit record. The operator's permitted jurisdictions are explicit configuration; an entry outside them refuses to start the gateway, naming the entry. (Owner decision 3)
- **A purpose allowlist** — `review.clause`, `review.collection_clause`, `assistant.chat`, `playbook.draft`, `playbook.suggest`, `redlines.infer`, `changeset.build`, `export.email`, `export.suggest_fix`. **An unknown purpose is rejected.** (§10)
- **Budgets and rate limits**, per workspace and per actor, in tokens and in requests. **A maximum prompt size** and a request timeout. (§10)
- **Retry on 429 and 5xx only; fail fast on 400/401/402/403.** This is `openrouter.ts`'s rule, carried over verbatim because it was right, and it is enforced **once**, in the shared call path — never re-implemented per adapter. `parseJsonLoose` moves to `packages/core` and stays the fallback for models that wrap JSON in prose. (§10)
- **What it logs, per call:** timestamp, purpose, **provider**, **model**, **jurisdiction**, allowlist entry id, workspace id, actor user id, matter/review/clause/document ids, prompt token count, completion token count, latency, HTTP status, retry count, whether images were attached and how many, and `sha256` of the prompt. Retained 90 days. (§10, extended by owner decision 3)
- **One adapter interface, one audit path, one allowlist check, one streaming path.** Provider differences are confined behind the adapter. Adding a sixth provider touches `adapters/` and the conformance fixture table, and nothing else. A provider-specific `if` anywhere outside `apps/gateway/src/adapters/` is a defect.
- **Running with an OpenAI or OpenRouter key and no Azure at all is a first-class path**, with the same allowlist check, the same jurisdiction gate, the same audit sink and the same failure behaviour as a deployed one. It is never a mode that skips a check.
- **One authentication path — OIDC authorization code with PKCE against a *configured* issuer.** Entra ID in a firm deployment, Keycloak in `docker compose`, and the application does not know which. **There is no Entra branch anywhere in the codebase**, and the `auth` suite asserts it rather than trusting it. (§7, S28)
- **Entra's tenant check is a configured required claim, never a code path.** The auth configuration is exactly `issuer`, `audience`, `subjectClaim`, `groupsClaim`, `requiredClaims` — and `{ tid: <tenant id> }` is a value in the last of those. (§7)
- **The browser uses a standards-only OIDC client, never MSAL.** (§7, S28)
- **Identity is `(issuer, subject)`, never the email**, with the subject claim named in configuration — `oid` for Entra, `sub` elsewhere. A Keycloak subject and an Entra `oid` are both opaque stable strings and neither is ever compared with the other. (§7)
- **A missing group claim is not an empty one.** Entra omits `groups` entirely on overage and emits `_claim_names`. Read naively that is "in no mapped group", so a partner in forty groups would be told they have no access — a wrong answer delivered confidently. **The absent-claim case is detected and reported as its own error.** It cannot be reproduced locally. (§7, §5.1)
- **There is no development bypass and no configuration that disables authentication** — no `SKIP_AUTH`, no anonymous local mode, no trusted header. The API refuses to start with no issuer configured, and refuses a non-HTTPS issuer that does not resolve to loopback. **The absence is mutation-tested.** (§7, S29)
- **Local dependencies are faithful emulators, not near-equivalents**, and **no module branches on the environment**: no `isLocal`, no `if (dev)`, no `NODE_ENV` read outside build tooling, and no `process.env` read outside each app's single typed configuration module. (§5.1, S30)
- **The configuration diff *is* §5.1's divergence list.** A key that differs between the local and deployed configurations and is not in §5.1's table fails the build — **and so does a table row with no key behind it.** (§18 item 10, S30)
- **The recorded-response stub is a registered adapter, not a bypass.** It passes `adapterConformance`, declares a jurisdiction, is refused in a firm deployment by S27's existing mechanism, and every response it produces is marked on the finding, on the run and behind a non-dismissible banner. (§5.1, §10.2)
- **What it does not log: prompt content and completion content, ever.** A content-logging debug mode is not built. A redaction test asserts no log line can carry document text. (§10, §14)
- **Who may call it: only `apps/api`, authenticated by its Azure managed identity (or mTLS in local compose). The gateway has no public ingress and no route from the internet.** (§10)
- **`api` may not egress.** Its only outbound routes are to the gateway (Stage 1) and, from Stage 2, Postgres and Blob Storage over private endpoints; the public internet is denied by network policy, not by code review. (§5)
- **The gateway never calls back to `api`, and holds no database or Blob credential.** (§5)
- **A load path must distinguish `not yet known` (in flight), `broken` (failed) and `empty` (succeeded and returned nothing).** Every one renders differently and none may render as any of the others. `describeLoadError` / `LoadErrorPanel` carry forward; do not hand-roll a new one. (§3; the fourth state, `stale`, arrives with realtime in Stage 4 and is **not** built here.)
- **`await-then-apply` survives verbatim.** No optimistic update for any human-authored state.
- **Verification state is set only by a human action; nothing derives it.** Stage 1 adds no writer of verification state and must not add one.
- **Local development is the same shape.** `docker compose up` brings up web, api, gateway (and, from Stage 2, Postgres and Azurite). The compose network denies `api` egress the same way the Container Apps environment does, so the central claim is exercised in development rather than only asserted in production. (§5)
- **`azd up` provisions the same shape in Azure.** (§4.10)
- **R-G1 continues to bind until Stage 4.** Stage 1 must not add a collaborative affordance — no assignee chip, no assign action, no "assigned to me" counter, no second actor's name anywhere. Entra sign-in in this stage exists to authenticate a caller, not to introduce colleagues. (§3.1)
- **Nothing in Stage 1 touches persistence.** Matters, documents, reviews, playbooks and changesets stay in IndexedDB. Do not add a table, a repository or an HTTP route for any of them.
- **When you find yourself writing a second copy of something, extract it then.** Not after the third. A client/server split doubles the surface for sibling drift, which is this project's most repeated defect. (§19, S14)
- **Mutation-test anything load-bearing.** Break the implementation, confirm the named test fails, restore. A green suite is not evidence.
- **Gates for every task:** `npx tsc --noEmit` clean at the repository root **and** in each workspace that has its own `tsconfig.json`; `npm test` green; `npm run build` clean with no externalization warning.
- **Commit at the end of every task**, by pathspec — never `git add -A`.

---

## Five decisions this plan makes, and why

The spec settles the shape of the gateway but leaves these implementation choices open. They are recorded here because they are load-bearing across many tasks and a reader should not have to reconstruct them from the task list.

**D1 — There is exactly one SSE event splitter in the system. Each provider contributes only a pure event decoder.**
`chatStream` exists because the assistant streams tokens, and this project has already shipped an SSE parser that dropped the last token of every answer and returned nothing on CRLF servers (`openrouter.ts`'s comments record both fixes). Five providers means five event framings, and the naive reading of that is five parsers — five surfaces for a bug this project has already paid for twice.

The decomposition that avoids it: **the transport-level hazard and the provider-level difference are different problems and are separated.** `createSseEventReader` in `packages/core` owns everything transport (CRLF normalisation on the buffer, partial-event buffering across chunk boundaries, the final flush) and is written once and tested once. Each adapter contributes `decodeEvent(rawEvent: string): AdapterEvent | null` — a **pure string-to-value function** with no IO, no buffering and no knowledge of chunking, tested offline against recorded fixtures. The gateway then re-emits the canonical LexPrompt frame format; the **browser** reads that format with the *same* reader function from `packages/core`; and **`api` pipes bytes**, unexamined, from one socket to the other.

So the count is: one splitter, five ~15-line decoders, one outward format, zero parsing in the middle. Task 18 asserts the bytes out of `api` equal the bytes in.

**D2 — A stream that ends without a terminator frame is an error, not a short answer.**
Today, a connection dropped mid-stream resolves `chatStream` with whatever arrived, and the caller cannot tell a complete answer from a truncated one. Over three hops that becomes likely rather than theoretical. Every gateway stream ends with exactly one `done` frame (carrying usage and the call id) or one `error` frame. A stream that ends with neither raises `ModelError('stream_truncated')`. This is the founding rule applied to a new boundary and it is mutation-tested in Task 3 and Task 12.

**D3 — The audit record is written *before* the upstream call, and a sink failure refuses the call.**
"It writes an audit record per call" cannot be satisfied by logging afterwards: a process that dies mid-call would then have made an unlogged egress, which is the one thing this component exists to make impossible. So each call writes a `call.started` record (everything except the outcome, including provider and jurisdiction) which is **awaited before the upstream request is issued**, and a `call.finished` record (status, tokens, latency, retries) afterwards. If the started record cannot be written, the gateway answers `503 service_misconfigured` and **makes no upstream call at all**. This holds identically in local development — owner decision 5. Task 6 mutation-tests the ordering.

**D4 — The jurisdiction gate is startup configuration with NO default, and it enforces the operator's declared policy rather than a view of our own.**

The owner's fifth decision settles whose judgement this is:

> *"It's basically for the person running the solution to be happy with the provider they're using, and the associated contracts and data provisions that those providers will give them (the API key is just the interface into the service, backed by those guarantees)."*

A firm may hold entirely sound provisions with a US provider — SCCs, a DPA, negotiated retention and training terms — settled with legal input long before anyone edits a config file. **The key is the interface to a service whose guarantees live in the contract behind it.** This design has no standing to decide which jurisdictions are acceptable to a particular firm, and **a default value would be exactly that decision, made silently, on their behalf.**

So: `GATEWAY_ALLOWED_JURISDICTIONS` **ships unset and has no default anywhere** — not in the config loader, not in the compose file, not in `.env.example`, not in Bicep. The gateway **refuses to start** when it is unset, naming the variable and what it is for. Unconfigured is a startup failure, not a silent guess, which is strictly more fail-closed than a default would have been: a default is a value nobody chose that the system then enforces as though somebody had.

The mechanism is unchanged and stays strict. Every allowlist entry's declared jurisdiction is compared against the operator's set **at startup**; an entry outside it **stops the process**, naming the entry, its provider and its jurisdiction; the boot log prints the resulting table every time, so the answer to "where does our text go" is in the first screen of the gateway's logs. Tasks 4 and 5 mutation-test both halves — the refusal, and **the absence of the default**, which no happy-path test can see.

**D5 — Every provider's stream decoding is proved by one table-driven conformance suite over recorded fixtures, and a provider with no fixture fails the build.**
Task 10's `adapterConformance.test.ts` runs the same battery over every registered adapter: the recorded fixture as-is; the same fixture with every `\n\n` replaced by `\r\n\r\n`; the same fixture delivered one byte at a time; the same fixture with the final blank line removed. All four must yield identical text. A separate test asserts every id in `PROVIDER_IDS` has a conformance entry, so a sixth provider added without a fixture turns the suite red rather than shipping untested.

**What this can prove without network access, and what it cannot** — stated plainly because the honest version matters more than the reassuring one. Provable offline: event decoding (fixtures), request-body construction (recorded expectations per provider), auth header/token attachment (fake credential + fake transport), the retry policy (fake transport), the allowlist, the jurisdiction gate, the audit record, the whole route layer (injected fake adapter), and the end-to-end browser→api→gateway→adapter path against the stub. **Not provable offline: that a real provider accepts the body we build.** That is a manual smoke script (`npm run smoke -w apps/gateway`, Task 11 Step 8), it needs a real credential, and a fixture recorded from a live provider is the only thing that keeps the offline tests honest. Fixtures carry the date and provider version they were recorded against, in a header comment, so a stale one is visible.

---

## File Structure

```
package.json                       MODIFY  workspace root; "workspaces": ["packages/*","apps/*"]
tsconfig.json                      MODIFY  path alias for @lexprompt/core
vite.config.ts                     MODIFY  resolve alias for @lexprompt/core
vitest.config.ts                   MODIFY  test.projects: web(jsdom) / core / gateway / api(node)

packages/core/
  package.json                     name @lexprompt/core, type module, exports ./src/index.ts
  tsconfig.json
  src/index.ts                     the package's only public surface
  src/json/parseJsonLoose.ts       MOVED from src/lib/openrouter.ts, unchanged
  src/json/parseJsonLoose.test.ts  MOVED from src/lib/openrouter.test.ts
  src/model/protocol.ts            Purpose, ProviderId, Jurisdiction, AllowedModel,
                                   InferRequest/Response, ModelError
  src/model/protocol.test.ts
  src/model/client.ts              the ModelClient interface (no implementation)
  src/model/sse.ts                 THE one SSE event splitter + the canonical frame codec
  src/model/sse.test.ts

apps/gateway/
  package.json  tsconfig.json  Dockerfile  .dockerignore
  src/config.ts                    env → GatewayConfig; throws at startup on anything wrong
  src/allowlist.ts                 allowlist lookup + the jurisdiction gate (S15, D4)
  src/audit.ts                     AuditRecord, AuditSink, JsonlAuditSink, fail-closed write
  src/credentials/types.ts         CredentialResolver interface + ResolvedCredential
  src/credentials/managedIdentity.ts   DefaultAzureCredential → bearer token
  src/credentials/keyVault.ts      Key Vault secret → api key, cached with a TTL
  src/credentials/envOrFile.ts     env var or file (docker secret) → api key
  src/credentials/resolve.ts       source selection; never falls back between sources
  src/callerAuth.ts                who may call the gateway: mTLS | Entra audience
  src/rateLimit.ts                 per-workspace and per-actor request + token budgets
  src/adapters/types.ts            ProviderAdapter, AdapterRequest, AdapterEvent
  src/adapters/openaiCompatible.ts shared body/decoder for the four OpenAI-shaped providers
  src/adapters/azureFoundry.ts     Azure AI Foundry
  src/adapters/azureOpenai.ts      Azure OpenAI
  src/adapters/openai.ts           OpenAI direct
  src/adapters/anthropic.ts        Anthropic — the one genuinely different shape
  src/adapters/openrouter.ts       OpenRouter
  src/adapters/recorded.ts         the 'recorded' provider: a REGISTERED adapter that
                                   replays fixtures, declares a jurisdiction, passes
                                   conformance, and is refused by S27 in a firm deployment
  src/adapters/registry.ts         THE registration point; adding a sixth provider = one line
  src/callModel.ts                 the ONE call path: retry, timeout, abort, usage
  src/routes/infer.ts              POST /v1/infer
  src/routes/inferStream.ts        POST /v1/infer/stream
  src/routes/models.ts             GET  /v1/models  (the allowlist's single home)
  src/routes/health.ts             GET  /healthz
  src/server.ts                    Fastify wiring + listen
  src/main.ts                      entrypoint
  src/smoke.ts                     manual live-provider smoke script (needs a credential)
  test/*.test.ts
  test/fixtures/streams/*.txt      recorded raw SSE per provider (D5)
  test/fixtures/requests/*.json    recorded expected request bodies per provider
  fixtures/recorded/*.json         recorded responses for offline development

apps/api/
  package.json  tsconfig.json  Dockerfile  .dockerignore
  src/config.ts                    THE only process.env reader in this app (S30)
  src/oidc.ts                      OIDC token validation against a CONFIGURED issuer:
                                   discovery, JWKS, iss/aud/exp, requiredClaims,
                                   subjectClaim, groupsClaim, group-overage detection
  src/gatewayClient.ts             THE only outbound client in this service
  src/routes/infer.ts              POST /v1/infer, GET /v1/deployments
  src/routes/inferStream.ts        POST /v1/infer/stream — a byte pipe
  src/server.ts  src/main.ts
  test/*.test.ts

src/lib/model/gatewayModelClient.ts   NEW  browser ModelClient over apps/api
src/lib/model/gatewayModelClient.test.ts
src/lib/config.ts                     NEW  THE only import.meta.env reader in the web app
src/lib/auth/oidc.ts                  NEW  oidc-client-ts UserManager + token acquisition
                                           (NOT MSAL — S28)
src/lib/auth/useAuth.ts               NEW  sign-in state hook: signing-in / failed / signed-in
src/lib/auth/useAuth.test.tsx
src/features/settings/ModelPicker.tsx              NEW  three load states over GET /v1/models,
                                                       jurisdiction on every option
src/features/settings/ModelPicker.test.tsx
src/components/ServiceConfigError.tsx             NEW  "this is not something you can fix"

src/lib/openrouter.ts              DELETE (Task 18)
src/lib/openrouter.test.ts         DELETE / split (Tasks 1, 3, 8, 18)
src/lib/storage.ts                 MODIFY  purge a stored apiKey, once, loudly
src/lib/privacyCopy.ts             MODIFY  API_KEY_PRIVACY replaced
src/types.ts                       MODIFY  Settings loses apiKey; modelId becomes modelChoiceId
                                           (an allowlist entry id, never a provider model name)
src/App.tsx                        MODIFY  auth copy split, isConfigured, sign-in gate
src/features/settings/SettingsPanel.tsx           MODIFY  key section deleted
src/features/assistant/chatContext.ts             MODIFY  purpose assistant.chat
src/features/assistant/draftEmail.ts              MODIFY  purpose export.email
src/features/assistant/suggestRevision.ts         MODIFY  purpose export.suggest_fix
src/features/authoring/generateDraft.ts           MODIFY  purpose playbook.draft
src/features/review/extractClause.ts              MODIFY  purpose review.clause
src/features/review/extractCollectionClause.ts    MODIFY  purpose review.collection_clause
src/features/templates/suggestField.ts            MODIFY  purpose playbook.suggest
src/features/templates/suggestMissingClauses.ts   MODIFY  purpose playbook.suggest
src/lib/buildChangeset.ts                         MODIFY  purpose changeset.build
src/lib/inferPositions.ts                         MODIFY  purpose redlines.infer

docker-compose.yml                 NEW
docker-compose.egress.test.ts      NEW  (apps/api/test/egress.compose.test.ts)
infra/main.bicep  infra/*.bicep    NEW
infra/keycloak/lexprompt-realm.json NEW  version-controlled realm: 4 seeded users (S31)
azure.yaml                         NEW
apps/api/test/configSurface.test.ts NEW  §18 item 10(a) and 10(b)
README.md                          MODIFY  §2's Stage-1 rows
docs/superpowers/redesign/rulings.md  MODIFY  S1/S2/S15 as executed, plus D1–D3
```

---

## Task 1: Workspace root and `packages/core`, with `parseJsonLoose` moved

**Type:** infrastructure

**Files:**
- Modify: `package.json` (add `workspaces`, add `@lexprompt/core` dependency)
- Modify: `tsconfig.json` (add the `@lexprompt/core` path)
- Modify: `vite.config.ts` (add the resolve alias)
- Modify: `vitest.config.ts` (replace `test` with `test.projects`)
- Create: `packages/core/package.json`, `packages/core/tsconfig.json`, `packages/core/src/index.ts`
- Create: `packages/core/src/json/parseJsonLoose.ts` (moved from `src/lib/openrouter.ts`)
- Create: `packages/core/src/json/parseJsonLoose.test.ts` (moved from `src/lib/openrouter.test.ts`)
- Create: `packages/core/test/importBoundary.test.ts`
- Modify: `src/lib/openrouter.ts` (import and re-export `parseJsonLoose`; no other change)
- Modify: `src/lib/openrouter.test.ts` (delete the `parseJsonLoose` describe block)

**Interfaces:**
- Consumes: nothing.
- Produces: the package `@lexprompt/core`, importable from `src/**`, `apps/gateway/**` and `apps/api/**`. Exports `parseJsonLoose<T>(text: string): T`.

- [ ] **Step 1: Create the package**

`packages/core/package.json`:

```json
{
  "name": "@lexprompt/core",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "exports": { ".": "./src/index.ts" }
}
```

`packages/core/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "lib": ["ES2022"],
    "moduleResolution": "bundler",
    "isolatedModules": true,
    "moduleDetection": "force",
    "skipLibCheck": true,
    "allowImportingTsExtensions": true,
    "noEmit": true
  },
  "include": ["src", "test"]
}
```

Note the `lib` has no `DOM`: `packages/core` runs on both sides, so anything that needs `Response` or `ReadableStream` must take them as parameters typed structurally, never reach for a global. Task 3 relies on this.

`packages/core/src/index.ts`:

```ts
export { parseJsonLoose } from './json/parseJsonLoose.ts';
```

- [ ] **Step 2: Move `parseJsonLoose` out of `openrouter.ts`**

Cut the whole `parseJsonLoose` function **and its doc comment, unedited** from `src/lib/openrouter.ts` into `packages/core/src/json/parseJsonLoose.ts`, prefixed with `export`. The comment explains why the scan returns the *last* valid object; it is the reason the function is correct and it moves with it.

In `src/lib/openrouter.ts`, replace it with:

```ts
import { parseJsonLoose } from '@lexprompt/core';
export { parseJsonLoose };
```

(`openrouter.ts` is deleted in Task 18. Until then it re-exports so no call site changes twice.)

- [ ] **Step 3: Move its tests**

Cut the whole `describe('parseJsonLoose', …)` block from `src/lib/openrouter.test.ts` into `packages/core/src/json/parseJsonLoose.test.ts`, changing only the import:

```ts
import { describe, it, expect } from 'vitest';
import { parseJsonLoose } from './parseJsonLoose.ts';
```

All seven cases move verbatim: clean JSON, prose preamble, fenced code block, nested braces and braces inside strings, no JSON at all, a non-JSON first brace, the last of several valid objects, a truncated unclosed brace.

- [ ] **Step 4: Wire the root**

`package.json` — add at the top level:

```json
  "workspaces": ["packages/*", "apps/*"],
```

and in `dependencies`:

```json
    "@lexprompt/core": "*",
```

`tsconfig.json` — extend `paths`:

```json
    "paths": {
      "@/*": ["./src/*"],
      "@lexprompt/core": ["./packages/core/src/index.ts"],
      "@lexprompt/core/*": ["./packages/core/src/*"]
    },
```

and extend `include` to `["src", "packages/core/src", "packages/core/test"]`.

`vite.config.ts` — extend the alias:

```ts
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
      '@lexprompt/core': path.resolve(__dirname, 'packages/core/src/index.ts'),
    },
  },
```

- [ ] **Step 5: Split the test runner into projects**

Replace `vitest.config.ts` entirely:

```ts
import path from 'node:path';
import { defineConfig } from 'vitest/config';

const coreAlias = {
  '@lexprompt/core': path.resolve(__dirname, 'packages/core/src/index.ts'),
};

export default defineConfig({
  test: {
    projects: [
      {
        resolve: { alias: { '@': path.resolve(__dirname, 'src'), ...coreAlias } },
        test: {
          name: 'web',
          environment: 'jsdom',
          globals: false,
          include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
          setupFiles: ['./vitest.setup.ts'],
        },
      },
      {
        resolve: { alias: coreAlias },
        test: {
          name: 'core',
          environment: 'node',
          globals: false,
          include: ['packages/core/**/*.test.ts'],
        },
      },
      {
        resolve: { alias: coreAlias },
        test: {
          name: 'gateway',
          environment: 'node',
          globals: false,
          include: ['apps/gateway/test/**/*.test.ts'],
        },
      },
      {
        resolve: { alias: coreAlias },
        test: {
          name: 'api',
          environment: 'node',
          globals: false,
          include: ['apps/api/test/**/*.test.ts'],
          exclude: ['apps/api/test/**/*.compose.test.ts'],
        },
      },
    ],
  },
});
```

`fake-indexeddb/auto` and the jsdom polyfills stay in `vitest.setup.ts` and now load **only** for the `web` project — which is correct: no server test should have an IndexedDB global.

The `api` project excludes `*.compose.test.ts`; those need a running compose stack and are run by their own script in Task 22.

- [ ] **Step 6: Write the import-boundary guard**

`packages/core/test/importBoundary.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '../../..');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry === '.git') continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(full)) out.push(full);
  }
  return out;
}

/**
 * S14: `packages/core` is the single home for anything both sides need.
 * A second copy of one of its exports is this project's most repeated
 * defect at client/server scale, where the two copies cannot even be read
 * side by side. This test names each export and forbids a second
 * definition of it outside the package.
 */
describe('import boundary (S14)', () => {
  // EXTEND THIS ARRAY in every task that adds a core export. By the end of
  // Stage 1 it reads:
  //   ['parseJsonLoose', 'createSseEventReader', 'sseFields', 'encodeFrame',
  //    'decodeFrame', 'readFrames', 'isPurpose', 'isProviderId',
  //    'jurisdictionLabel', 'isRetryableStatus', 'isSignInError',
  //    'isServiceConfigError']
  const exported = ['parseJsonLoose'];

  it('nothing outside packages/core defines an export of packages/core', () => {
    const files = [
      ...walk(path.join(ROOT, 'src')),
      ...walk(path.join(ROOT, 'apps')).filter(f => !f.includes(`${path.sep}test${path.sep}`)),
    ];
    const offenders: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      for (const name of exported) {
        if (new RegExp(`(function|const|class)\\s+${name}\\b`).test(text)) {
          offenders.push(`${path.relative(ROOT, file)} redefines ${name}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
```

`walk` on `apps/` must tolerate the directory not existing yet — guard it:

```ts
function walkIfPresent(dir: string): string[] {
  try { return walk(dir); } catch { return []; }
}
```

and use `walkIfPresent` for both roots.

- [ ] **Step 7: Run everything**

```bash
npm install
npx tsc --noEmit
npm test
npm run build
```

Expected: `tsc` clean; four vitest projects reported (`web`, `core`, `gateway`, `api`) with `gateway`/`api` reporting no test files (that is fine — they gain files in Task 4 and Task 14); all previously-passing tests still pass; build clean with no externalization warning.

- [ ] **Step 8: Mutation test the boundary guard**

Add `export function parseJsonLoose() { return null; }` to the bottom of `src/lib/storage.ts`. Run `npx vitest run --project core`. Expected: `importBoundary` FAILS naming `src/lib/storage.ts`. Remove the line and re-run: PASS.

- [ ] **Step 9: Commit**

```bash
git add package.json package-lock.json tsconfig.json vite.config.ts vitest.config.ts packages/core src/lib/openrouter.ts src/lib/openrouter.test.ts
git commit -F .git/COMMIT_MSG_TASK1
```

with `.git/COMMIT_MSG_TASK1` written as:

```
build: make the repo an npm workspace root and create @lexprompt/core

parseJsonLoose moves first, unedited, because §10 names it as the one
piece of openrouter.ts that belongs on both sides of the wire. An
import-boundary test (S14) forbids a second definition of any core
export outside the package.
```

---

## Task 2: The model protocol — purposes, providers, jurisdictions, allowlist entries, errors

**Type:** application code

**Files:**
- Create: `packages/core/src/model/protocol.ts`
- Create: `packages/core/src/model/protocol.test.ts`
- Create: `packages/core/src/model/client.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `PURPOSES: readonly Purpose[]`, `type Purpose`, `isPurpose(v: unknown): v is Purpose`
  - `PROVIDER_IDS: readonly ProviderId[]`, `type ProviderId = 'azure-foundry' | 'azure-openai' | 'openai' | 'anthropic' | 'openrouter' | 'recorded'`, `isProviderId(v: unknown): v is ProviderId`
  - `type Bloc = 'UK' | 'EU' | 'US' | 'other'`, `interface Jurisdiction { bloc: Bloc; region: string; label: string }`, `jurisdictionLabel(j: Jurisdiction): string`
  - `interface AllowedModel { id: string; provider: ProviderId; model: string; label: string; jurisdiction: Jurisdiction; contextLength: number; supportsImages: boolean; supportsStructuredOutput: boolean; isDefault: boolean }`
  - `interface InferContext { matterId?: string; reviewId?: string; clauseId?: string; documentIds?: string[] }`
  - `interface InferRequest { modelChoiceId: string; purpose: Purpose; system?: string; user: string; images?: { mime: string; data: string }[]; jsonSchema?: object; temperature?: number; maxTokens?: number; context?: InferContext }`
  - `interface InferUsage { promptTokens: number; completionTokens: number }`
  - `interface InferResponse { content: string; usage: InferUsage; callId: string; provider: ProviderId; jurisdiction: Jurisdiction }` — no `stubbed` flag: `provider === 'recorded'` is that fact and carrying it twice is drift
  - `type ModelErrorCode`, `class ModelError`, `isSignInError`, `isServiceConfigError`, `isRetryableStatus`
  - `interface ModelClient` with `chat`, `chatJson`, `chatStream`, `listModels`

**Naming note, binding on every later task:** the browser and the wire say **`modelChoiceId`** — an id of an entry on the operator's allowlist. They never say `model`, `modelId` or `deployment`, because those are provider-side names and letting one reach the wire is how a user ends up able to name one (S15). Inside an adapter, `AllowedModel.model` is the provider-side name and is the only place it appears.

- [ ] **Step 1: Write the failing test**

`packages/core/src/model/protocol.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  PURPOSES, isPurpose, PROVIDER_IDS, isProviderId, jurisdictionLabel,
  ModelError, isSignInError, isServiceConfigError, isRetryableStatus,
} from './protocol.ts';

describe('providers (owner decision 1)', () => {
  it('is the five the owner named, plus the recorded adapter', () => {
    expect([...PROVIDER_IDS]).toEqual([
      'azure-foundry', 'azure-openai', 'openai', 'anthropic', 'openrouter', 'recorded',
    ]);
  });

  // Spec Revision 2 / §5.1: the offline stub is an ADAPTER, not a bypass.
  // Being on this list is what forces it through the registry completeness
  // test, the conformance suite and the jurisdiction gate like any other.
  it('includes recorded, so the offline stub cannot escape the adapter machinery', () => {
    expect(isProviderId('recorded')).toBe(true);
  });

  it('accepts a known provider and refuses anything else', () => {
    expect(isProviderId('anthropic')).toBe(true);
    expect(isProviderId('bedrock')).toBe(false);
    expect(isProviderId(undefined)).toBe(false);
  });
});

describe('jurisdiction (owner decision 3)', () => {
  it('reads as something an operator can act on, not a region code', () => {
    expect(jurisdictionLabel({ bloc: 'UK', region: 'uksouth', label: 'UK South' }))
      .toBe('UK · UK South');
    expect(jurisdictionLabel({ bloc: 'US', region: 'us', label: 'United States' }))
      .toBe('US · United States');
  });
});

describe('purposes (§10)', () => {
  it('is exactly the nine the spec names, in the spec order', () => {
    expect([...PURPOSES]).toEqual([
      'review.clause', 'review.collection_clause', 'assistant.chat',
      'playbook.draft', 'playbook.suggest', 'redlines.infer',
      'changeset.build', 'export.email', 'export.suggest_fix',
    ]);
  });

  it('accepts a known purpose and refuses anything else', () => {
    expect(isPurpose('review.clause')).toBe(true);
    expect(isPurpose('review.everything')).toBe(false);
    expect(isPurpose('')).toBe(false);
    expect(isPurpose(undefined)).toBe(false);
    expect(isPurpose(null)).toBe(false);
    expect(isPurpose(42)).toBe(false);
  });
});

describe('retry policy (§10, carried from openrouter.ts verbatim)', () => {
  it('retries 429 and 5xx only', () => {
    expect(isRetryableStatus(429)).toBe(true);
    expect(isRetryableStatus(500)).toBe(true);
    expect(isRetryableStatus(503)).toBe(true);
    expect(isRetryableStatus(400)).toBe(false);
    expect(isRetryableStatus(401)).toBe(false);
    expect(isRetryableStatus(402)).toBe(false);
    expect(isRetryableStatus(403)).toBe(false);
    expect(isRetryableStatus(413)).toBe(false);
  });
});

describe('error classification — who is being told, and what they can do', () => {
  it('a rejected or expired user token is a sign-in problem the USER can fix', () => {
    expect(isSignInError(new ModelError('expired', 'sign_in_required', 401))).toBe(true);
    expect(isSignInError(new ModelError('no role', 'not_permitted', 403))).toBe(true);
  });

  it('a firm-configuration failure is NOT a sign-in problem', () => {
    const e = new ModelError('no managed identity token', 'service_misconfigured', 503);
    expect(isSignInError(e)).toBe(false);
    expect(isServiceConfigError(e)).toBe(true);
  });

  it('a refused model or purpose is a firm-configuration problem, not the user\'s', () => {
    expect(isServiceConfigError(new ModelError('x', 'model_not_allowed', 400))).toBe(true);
    expect(isServiceConfigError(new ModelError('x', 'purpose_not_allowed', 400))).toBe(true);
  });

  // §7: a partner in forty groups must never be told they have no access.
  it('group overage is an admin problem, and is NOT a sign-in problem', () => {
    const e = new ModelError('overage', 'group_overage', 403);
    expect(isSignInError(e)).toBe(false);
    expect(isServiceConfigError(e)).toBe(true);
  });

  it('a transient upstream failure is neither', () => {
    const e = new ModelError('foundry 500', 'upstream_failed', 502);
    expect(isSignInError(e)).toBe(false);
    expect(isServiceConfigError(e)).toBe(false);
    expect(e.retryable).toBe(true);
  });

  it('is false for a plain Error and for a non-error value', () => {
    expect(isSignInError(new Error('boom'))).toBe(false);
    expect(isServiceConfigError('boom')).toBe(false);
    expect(isSignInError(null)).toBe(false);
  });

  it('carries the call id so a user can quote it to IT', () => {
    const e = new ModelError('nope', 'service_misconfigured', 503, 'c-7f3a');
    expect(e.callId).toBe('c-7f3a');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run --project core packages/core/src/model/protocol.test.ts`
Expected: FAIL — `Failed to resolve import "./protocol.ts"`.

- [ ] **Step 3: Implement `protocol.ts`**

```ts
/**
 * The wire contract between the browser, `apps/api` and `apps/gateway`.
 *
 * Lives in `packages/core` because all three speak it, and because a
 * second copy of a purpose list or an error code is exactly the drift
 * S14 exists to prevent — here it would mean a call the gateway refuses
 * for a reason the browser has no wording for.
 */

/** §10's purpose allowlist. Closed set: the gateway refuses anything else,
 *  and "what does this system send to a model, and why" is answerable from
 *  this array rather than by reading the application. */
export const PURPOSES = [
  'review.clause',
  'review.collection_clause',
  'assistant.chat',
  'playbook.draft',
  'playbook.suggest',
  'redlines.infer',
  'changeset.build',
  'export.email',
  'export.suggest_fix',
] as const;

export type Purpose = (typeof PURPOSES)[number];

export function isPurpose(value: unknown): value is Purpose {
  return typeof value === 'string' && (PURPOSES as readonly string[]).includes(value);
}

/** The provider backends an operator may configure (owner decision 1).
 *  Adding a sixth means adding it here, adding an adapter, and adding a
 *  conformance fixture — and nothing else. */
export const PROVIDER_IDS = [
  'azure-foundry',
  'azure-openai',
  'openai',
  'anthropic',
  'openrouter',
  // The offline recorded-response provider (§5.1). It is an ADAPTER, not a
  // bypass: being on this list is what puts it through the registry
  // completeness test, the stream conformance suite and the jurisdiction
  // gate exactly like the other five, and what lets a firm deployment refuse
  // it through S27's existing mechanism rather than through a new one.
  'recorded',
] as const;

export type ProviderId = (typeof PROVIDER_IDS)[number];

export function isProviderId(value: unknown): value is ProviderId {
  return typeof value === 'string' && (PROVIDER_IDS as readonly string[]).includes(value);
}

export type Bloc = 'UK' | 'EU' | 'US' | 'other';

/**
 * Where a call is processed (owner decision 3).
 *
 * Declared per allowlist entry by the operator, checked against the
 * gateway's permitted blocs at startup, returned to the browser so it can
 * be shown on the option itself, and written to every audit record. A firm
 * must not be able to believe it is UK-only while routing privileged text
 * to a US region, and the defence against that is this value being
 * unavoidable rather than documented.
 */
export interface Jurisdiction {
  bloc: Bloc;
  /** The provider's own region identifier, e.g. 'uksouth', 'swedencentral', 'us'. */
  region: string;
  /** Human wording for the region, e.g. 'UK South'. */
  label: string;
}

export function jurisdictionLabel(j: Jurisdiction): string {
  return `${j.bloc} · ${j.label}`;
}

/**
 * One entry on the operator's allowlist: a provider and a model on it
 * (S15, as revised to provider+model pairs).
 *
 * `id` is what the browser names. `model` is the provider-side name and
 * never crosses the wire outwards — a user who could name one could name
 * an unreviewed egress destination, which is the whole of what S15 forbids.
 */
export interface AllowedModel {
  id: string;
  provider: ProviderId;
  model: string;
  label: string;
  jurisdiction: Jurisdiction;
  contextLength: number;
  supportsImages: boolean;
  supportsStructuredOutput: boolean;
  isDefault: boolean;
}

/**
 * What the call was for, in the app's own terms — logged so a client's
 * "what of ours went where, and when" is answerable.
 *
 * `documentIds` is a deliberate addition to §10's listed body fields. §10
 * requires matter/review/clause ids; Stage 1's own goal is that the record
 * says "which document or review the call served", and a clause extraction
 * over three documents cannot say that from a review id alone.
 */
export interface InferContext {
  matterId?: string;
  reviewId?: string;
  clauseId?: string;
  documentIds?: string[];
}

export interface InferRequest {
  /** An `AllowedModel.id` — never a provider-side model name (S15). */
  modelChoiceId: string;
  purpose: Purpose;
  system?: string;
  user: string;
  images?: { mime: string; data: string }[];
  jsonSchema?: object;
  temperature?: number;
  /** Anthropic requires one; the OpenAI-shaped providers do not. The
   *  gateway supplies its configured default when a caller omits it, so no
   *  call site has to know which provider it happens to be talking to. */
  maxTokens?: number;
  context?: InferContext;
}

export interface InferUsage {
  promptTokens: number;
  completionTokens: number;
}

export interface InferResponse {
  content: string;
  usage: InferUsage;
  /** Quotable to IT when something is wrong. Present on success and on error. */
  callId: string;
  /** Which backend actually answered, and from where. Returned, not just
   *  logged, so the browser can show it rather than assert it. */
  provider: ProviderId;
  jurisdiction: Jurisdiction;
}

// There is deliberately NO `stubbed` flag. `provider === 'recorded'` is the
// fact, and a second field carrying the same fact is the sibling drift S14
// exists to prevent — in the one place where the two copies disagreeing
// would mean the app telling a lawyer an answer came from a model when it
// came from a file (§5.1).

export type ModelErrorCode =
  | 'sign_in_required'
  | 'not_permitted'
  | 'group_overage'
  | 'model_not_allowed'
  | 'purpose_not_allowed'
  | 'prompt_too_large'
  | 'budget_exhausted'
  | 'rate_limited'
  | 'service_misconfigured'
  | 'upstream_failed'
  | 'stream_truncated'
  | 'network'
  | 'unknown';

/** Retries only 429 and 5xx, exactly as `openrouter.ts` did. Retrying a
 *  rejected credential or a refused deployment wastes the user's time
 *  before telling them the same thing. */
export function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

export class ModelError extends Error {
  code: ModelErrorCode;
  status: number;
  retryable: boolean;
  callId?: string;

  constructor(message: string, code: ModelErrorCode, status: number, callId?: string) {
    super(message);
    this.name = 'ModelError';
    this.code = code;
    this.status = status;
    this.callId = callId;
    // 'network' has no HTTP response at all (status 0) and is always
    // transient; everything else follows the status.
    this.retryable = code === 'network' ? true : isRetryableStatus(status);
  }
}

const SIGN_IN_CODES: ReadonlySet<ModelErrorCode> = new Set(['sign_in_required', 'not_permitted']);
const SERVICE_CONFIG_CODES: ReadonlySet<ModelErrorCode> = new Set([
  'service_misconfigured', 'model_not_allowed', 'purpose_not_allowed',
  // Group overage (§7): the token carried no `groups` claim because the user
  // is in too many groups for one to fit. An admin fixes it; signing in again
  // cannot, and nothing in Settings can. So it classifies here and NOT as a
  // sign-in error — the whole point of detecting it separately is that
  // "you have no access" would be a wrong answer told confidently.
  'group_overage',
]);

/**
 * True when the person at the keyboard can fix it by signing in again.
 * The successor to `openrouter.ts`'s `isAuthError` for the half of its
 * meaning that still belongs to the user. Routes to the sign-in action.
 */
export function isSignInError(error: unknown): boolean {
  return error instanceof ModelError && SIGN_IN_CODES.has(error.code);
}

/**
 * True when the FIRM's configuration is wrong: a credential that could not
 * be resolved, a model that is not allowlisted, a purpose the gateway does
 * not know. A different message to a different person — there is nothing
 * in Settings for the user to change, so this must never route there.
 */
export function isServiceConfigError(error: unknown): boolean {
  return error instanceof ModelError && SERVICE_CONFIG_CODES.has(error.code);
}
```

- [ ] **Step 4: Implement `client.ts`**

```ts
import type { AllowedModel, InferRequest, InferResponse } from './protocol.ts';

/**
 * The seam §13 names for Stage 1: "openrouter.ts becomes a ModelClient
 * interface with one implementation pointing at the gateway". The shape is
 * `openrouter.ts`'s shape minus `apiKey` and minus `modelId` — a caller
 * names a purpose and an allowlist entry, never a provider model name
 * (S15), and never a provider: which backend answers is the operator's
 * configuration, not the call site's business.
 */
export interface ModelClient {
  chat(req: InferRequest, signal?: AbortSignal): Promise<InferResponse>;
  chatJson<T>(req: InferRequest, signal?: AbortSignal): Promise<T>;
  chatStream(
    req: InferRequest,
    onDelta: (chunk: string) => void,
    signal?: AbortSignal,
  ): Promise<InferResponse>;
  listModels(): Promise<AllowedModel[]>;
}
```

`AbortSignal` is a global in both Node 18+ and every browser, so `packages/core`'s DOM-free `lib` still types it via `ES2022` + Node types at the consuming end. If `tsc` complains in the core project, add `"lib": ["ES2022", "DOM"]`— but **only** `DOM` for types, never a DOM runtime call.

- [ ] **Step 5: Export from the index**

```ts
export { parseJsonLoose } from './json/parseJsonLoose.ts';
export {
  PURPOSES, isPurpose, PROVIDER_IDS, isProviderId, jurisdictionLabel,
  ModelError, isSignInError, isServiceConfigError, isRetryableStatus,
} from './model/protocol.ts';
export type {
  Purpose, ProviderId, Bloc, Jurisdiction, AllowedModel,
  InferContext, InferRequest, InferUsage, InferResponse, ModelErrorCode,
} from './model/protocol.ts';
export type { ModelClient } from './model/client.ts';
```

- [ ] **Step 6: Run the test**

Run: `npx vitest run --project core packages/core/src/model/protocol.test.ts`
Expected: PASS, 14 tests.

- [ ] **Step 7: Mutation test the classifier split**

Add `'service_misconfigured'` to `SIGN_IN_CODES`. Run the test. Expected: FAIL on *"a firm-configuration failure is NOT a sign-in problem"*. Remove it and re-run: PASS.

This is the mutation that matters: it is exactly the mistake of telling a lawyer to fix their sign-in when the firm's Foundry role assignment is missing.

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/model packages/core/src/index.ts
git commit -F .git/COMMIT_MSG_TASK2
```

```
feat(core): the model protocol — purposes, providers, jurisdictions, errors

The nine purposes and the five providers are closed sets, so "what does
this system send to a model, why, and where is it processed" is answerable
from configuration rather than by reading the application.

Every allowlist entry carries a Jurisdiction, returned to the browser and
written to every audit record — a firm must not be able to believe it is
UK-only while routing privileged text to a US region.

openrouter.ts's isAuthError splits in two: isSignInError is the user's
problem and routes to sign-in; isServiceConfigError is the firm's and must
never route to Settings, because there is nothing there to change.
```

---

## Task 3: The one SSE reader and the canonical frame codec

**Type:** application code + test

**Files:**
- Create: `packages/core/src/model/sse.ts`
- Create: `packages/core/src/model/sse.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Consumes: `ModelError`, `ModelErrorCode`, `InferUsage` (Task 2).
- Produces:
  - `createSseEventReader(): { push(chunk: string): string[]; flush(): string[] }` — the CRLF-safe, final-flush event splitter. **The only SSE event splitter in the system**, used by the gateway over five providers' streams and by the browser over the gateway's.
  - `sseFields(rawEvent: string): { event: string | null; data: string | null }` — the `event:` and `data:` fields of one raw SSE event. Every adapter's `decodeEvent` starts here; none of them re-implements line scanning. (Anthropic puts the discriminator on the `event:` line, which is why `event` is returned rather than only `data`.)
  - `type Frame = { type: 'delta'; text: string } | { type: 'done'; usage: InferUsage; callId: string } | { type: 'error'; code: ModelErrorCode; status: number; message: string; callId: string }`
  - `encodeFrame(frame: Frame): string`
  - `decodeFrame(rawEvent: string): Frame | null`
  - `readFrames(stream: AsyncIterable<Uint8Array>, onDelta: (text: string) => void): Promise<{ usage: InferUsage; callId: string }>` — resolves only on a `done` frame; throws `ModelError` on an `error` frame or on a stream that ends with neither (D2).

**`Frame` is the gateway's outward format and is provider-independent by construction.** Nothing downstream of the gateway can tell which of the five answered except by reading `InferResponse.provider`, which is a field rather than a shape.

- [ ] **Step 1: Write the failing tests**

`packages/core/src/model/sse.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  createSseEventReader, sseFields, encodeFrame, decodeFrame, readFrames,
} from './sse.ts';
import { ModelError } from './protocol.ts';

const enc = new TextEncoder();

async function* streamOf(...chunks: string[]): AsyncIterable<Uint8Array> {
  for (const c of chunks) yield enc.encode(c);
}

describe('createSseEventReader — the one parser (D1)', () => {
  it('splits complete LF events and keeps a partial one buffered', () => {
    const r = createSseEventReader();
    expect(r.push('data: a\n\ndata: b\n\ndata: par')).toEqual(['data: a', 'data: b']);
    expect(r.push('tial\n\n')).toEqual(['data: partial']);
    expect(r.flush()).toEqual([]);
  });

  // The defect this project already shipped once: a CRLF server produced
  // NOTHING — no error, no deltas — because `\r\n\r\n` never matches `\n\n`.
  it('parses CRLF-terminated events instead of silently returning nothing', () => {
    const r = createSseEventReader();
    expect(r.push('data: a\r\n\r\ndata: b\r\n\r\n')).toEqual(['data: a', 'data: b']);
  });

  it('handles a stream mixing LF and CRLF separators', () => {
    const r = createSseEventReader();
    expect(r.push('data: a\n\ndata: b\r\n\r\ndata: c\n\n')).toEqual(['data: a', 'data: b', 'data: c']);
  });

  it('emits a CRLF event as soon as it arrives, not only at the end', () => {
    const r = createSseEventReader();
    expect(r.push('data: a\r\n\r\n')).toEqual(['data: a']);
  });

  // The other defect this project already shipped: the last event was
  // dropped when the connection closed without a trailing blank line.
  it('flush() yields a final event that arrived without a trailing blank line', () => {
    const r = createSseEventReader();
    expect(r.push('data: a\n\ndata: last')).toEqual(['data: a']);
    expect(r.flush()).toEqual(['data: last']);
  });

  it('flush() yields nothing when the buffer holds only whitespace', () => {
    const r = createSseEventReader();
    r.push('data: a\n\n\n');
    expect(r.flush()).toEqual([]);
  });

  it('survives a chunk boundary in the middle of the separator', () => {
    const r = createSseEventReader();
    expect(r.push('data: a\r')).toEqual([]);
    expect(r.push('\n\r\ndata: b\n\n')).toEqual(['data: a', 'data: b']);
  });
});

describe('sseFields — the one field scanner every adapter starts from', () => {
  it('reads a data line', () => {
    expect(sseFields('data: {"a":1}')).toEqual({ event: null, data: '{"a":1}' });
  });

  it('reads an event name and a data line together (Anthropic\'s shape)', () => {
    expect(sseFields('event: content_block_delta\ndata: {"a":1}'))
      .toEqual({ event: 'content_block_delta', data: '{"a":1}' });
  });

  it('returns nulls for a keepalive comment and for an empty data line', () => {
    expect(sseFields(': keepalive')).toEqual({ event: null, data: null });
    expect(sseFields('data:')).toEqual({ event: null, data: null });
  });

  it('tolerates a trailing \\r left on an individual line', () => {
    expect(sseFields('event: ping\r\ndata: {"a":1}\r')).toEqual({ event: 'ping', data: '{"a":1}' });
  });

  it('joins multiple data lines with a newline, per the SSE spec', () => {
    expect(sseFields('data: one\ndata: two').data).toBe('one\ntwo');
  });
});

describe('the canonical frame codec', () => {
  it('round-trips a delta', () => {
    const raw = encodeFrame({ type: 'delta', text: 'Hello' }).replace(/\n\n$/, '');
    expect(decodeFrame(raw)).toEqual({ type: 'delta', text: 'Hello' });
  });

  it('round-trips a delta containing a newline and a brace', () => {
    const text = 'line one\nline {two}';
    const raw = encodeFrame({ type: 'delta', text }).replace(/\n\n$/, '');
    expect(decodeFrame(raw)).toEqual({ type: 'delta', text });
  });

  it('encodes one event terminated by a blank line', () => {
    expect(encodeFrame({ type: 'delta', text: 'x' })).toBe('data: {"type":"delta","text":"x"}\n\n');
  });

  it('round-trips done and error', () => {
    const done = { type: 'done' as const, usage: { promptTokens: 11, completionTokens: 3 }, callId: 'c1' };
    expect(decodeFrame(encodeFrame(done).trim())).toEqual(done);
    const err = { type: 'error' as const, code: 'upstream_failed' as const, status: 502, message: 'boom', callId: 'c1' };
    expect(decodeFrame(encodeFrame(err).trim())).toEqual(err);
  });

  it('returns null for a non-frame event rather than throwing', () => {
    expect(decodeFrame(': keepalive')).toBe(null);
    expect(decodeFrame('data: {"type":"nonsense"}')).toBe(null);
  });
});

describe('readFrames — a stream is complete or it is an error (D2)', () => {
  it('emits deltas in order and resolves with usage and call id', async () => {
    const seen: string[] = [];
    const result = await readFrames(
      streamOf(
        encodeFrame({ type: 'delta', text: 'Hel' }),
        encodeFrame({ type: 'delta', text: 'lo' }),
        encodeFrame({ type: 'done', usage: { promptTokens: 5, completionTokens: 2 }, callId: 'c9' }),
      ),
      d => seen.push(d),
    );
    expect(seen).toEqual(['Hel', 'lo']);
    expect(result).toEqual({ usage: { promptTokens: 5, completionTokens: 2 }, callId: 'c9' });
  });

  it('does not drop a delta split across two network chunks', async () => {
    const whole = encodeFrame({ type: 'delta', text: 'Hello' })
      + encodeFrame({ type: 'done', usage: { promptTokens: 1, completionTokens: 1 }, callId: 'c1' });
    const seen: string[] = [];
    await readFrames(streamOf(whole.slice(0, 12), whole.slice(12)), d => seen.push(d));
    expect(seen).toEqual(['Hello']);
  });

  it('does not drop the final delta when the done frame arrives without a trailing blank line', async () => {
    const seen: string[] = [];
    const doneNoBlank = encodeFrame({
      type: 'done', usage: { promptTokens: 1, completionTokens: 1 }, callId: 'c1',
    }).replace(/\n\n$/, '');
    await readFrames(
      streamOf(encodeFrame({ type: 'delta', text: 'last' }), doneNoBlank),
      d => seen.push(d),
    );
    expect(seen).toEqual(['last']);
  });

  // THE rule. A truncated stream is not a short answer.
  it('throws stream_truncated when the stream ends with no done and no error frame', async () => {
    const seen: string[] = [];
    await expect(
      readFrames(streamOf(encodeFrame({ type: 'delta', text: 'half an ans' })), d => seen.push(d)),
    ).rejects.toMatchObject({ name: 'ModelError', code: 'stream_truncated' });
    expect(seen).toEqual(['half an ans']);
  });

  it('throws stream_truncated on a completely empty stream, never resolving empty', async () => {
    await expect(readFrames(streamOf(), () => {})).rejects.toMatchObject({ code: 'stream_truncated' });
  });

  it('throws the error frame\'s own code and message, carrying the call id', async () => {
    await expect(
      readFrames(
        streamOf(
          encodeFrame({ type: 'delta', text: 'partial' }),
          encodeFrame({ type: 'error', code: 'upstream_failed', status: 502, message: 'Foundry 500', callId: 'c4' }),
        ),
        () => {},
      ),
    ).rejects.toMatchObject({ name: 'ModelError', code: 'upstream_failed', message: 'Foundry 500', callId: 'c4' });
  });

  it('stops emitting deltas after an error frame', async () => {
    const seen: string[] = [];
    await expect(
      readFrames(
        streamOf(
          encodeFrame({ type: 'error', code: 'upstream_failed', status: 502, message: 'x', callId: 'c1' }),
          encodeFrame({ type: 'delta', text: 'should not be seen' }),
        ),
        d => seen.push(d),
      ),
    ).rejects.toBeInstanceOf(ModelError);
    expect(seen).toEqual([]);
  });

  it('propagates a stream-level rejection unwrapped, so an abort stays an abort', async () => {
    async function* boom(): AsyncIterable<Uint8Array> {
      yield enc.encode(encodeFrame({ type: 'delta', text: 'a' }));
      const e = new Error('The operation was aborted');
      e.name = 'AbortError';
      throw e;
    }
    await expect(readFrames(boom(), () => {})).rejects.toMatchObject({ name: 'AbortError' });
  });
});
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `npx vitest run --project core packages/core/src/model/sse.test.ts`
Expected: FAIL — `Failed to resolve import "./sse.ts"`.

- [ ] **Step 3: Implement `sse.ts`**

```ts
import { ModelError, type ModelErrorCode, type InferUsage } from './protocol.ts';

/**
 * The ONE SSE event splitter in this system (D1).
 *
 * Five providers means five event framings, and the naive reading of that
 * is five parsers — five surfaces for a bug this project has already paid
 * for twice. The decomposition that avoids it separates the two problems:
 * everything TRANSPORT (chunk boundaries, CRLF, the final flush) lives
 * here and is written once; everything PROVIDER-SPECIFIC is a pure
 * `decodeEvent(rawEvent) => AdapterEvent | null` inside that provider's
 * adapter, with no buffering and no knowledge of chunking, tested offline
 * against a recorded fixture (D5).
 *
 * It is `openrouter.ts`'s `chatStream` loop, lifted out and given a name,
 * because both of its hard-won behaviours were bugs this project shipped:
 *
 *  - CRLF normalisation on the BUFFER, not per line: a CRLF-terminated
 *    event never matches `\n\n` (there is a stray `\r` between the two
 *    `\n`s), so the whole stream parsed as empty — no error, no deltas,
 *    nothing. For a panel answering questions about a contract that is
 *    worse than a visible failure.
 *  - `flush()`: a stream can end without a trailing blank line after the
 *    final event, and that event may carry the last content delta. Dropping
 *    it gives the caller a truncated-but-apparently-successful response.
 *
 * The gateway runs it over whichever provider's stream it opened; the
 * browser runs it over the gateway's. `apps/api` runs it over nothing,
 * because `apps/api` pipes bytes and parses nothing at all.
 */
export function createSseEventReader(): { push(chunk: string): string[]; flush(): string[] } {
  let buffer = '';
  return {
    push(chunk: string): string[] {
      buffer += chunk.replace(/\r\n/g, '\n');
      const parts = buffer.split('\n\n');
      buffer = parts.pop() ?? '';
      return parts.filter(p => p.trim().length > 0);
    },
    flush(): string[] {
      // A lone trailing `\r` can survive normalisation when a chunk ended
      // mid-separator and nothing followed it.
      const rest = buffer.replace(/\r/g, '').trim();
      buffer = '';
      return rest ? [rest] : [];
    },
  };
}

/**
 * The `event:` and `data:` fields of one raw SSE event.
 *
 * Exported because every provider adapter needs exactly this and nothing
 * more before it starts reading its own JSON — and five hand-rolled line
 * scanners is precisely the drift S14 exists to prevent, in the one place
 * where a missing `\r` guard has already cost this project a silent
 * empty stream. Anthropic puts its discriminator on the `event:` line, so
 * both fields are returned rather than only `data`.
 */
export function sseFields(rawEvent: string): { event: string | null; data: string | null } {
  let event: string | null = null;
  const data: string[] = [];
  for (const rawLine of rawEvent.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (line.startsWith('event:')) {
      const name = line.slice(6).trim();
      if (name) event = name;
    } else if (line.startsWith('data:')) {
      data.push(line.slice(5).trim());
    }
  }
  const joined = data.join('\n').trim();
  return { event, data: joined ? joined : null };
}

function dataPayload(rawEvent: string): string | null {
  return sseFields(rawEvent).data;
}

export type Frame =
  | { type: 'delta'; text: string }
  | { type: 'done'; usage: InferUsage; callId: string }
  | { type: 'error'; code: ModelErrorCode; status: number; message: string; callId: string };

/** One SSE event, terminated by the blank line that ends it. */
export function encodeFrame(frame: Frame): string {
  return `data: ${JSON.stringify(frame)}\n\n`;
}

export function decodeFrame(rawEvent: string): Frame | null {
  const payload = dataPayload(rawEvent);
  if (!payload) return null;
  try {
    const parsed = JSON.parse(payload) as Frame;
    if (parsed?.type === 'delta' && typeof parsed.text === 'string') return parsed;
    if (parsed?.type === 'done' && parsed.usage && typeof parsed.callId === 'string') return parsed;
    if (parsed?.type === 'error' && typeof parsed.message === 'string') return parsed;
    return null;
  } catch {
    return null;
  }
}

/**
 * Reads a gateway stream to its end.
 *
 * D2: a stream is complete or it is an error. It resolves ONLY on a `done`
 * frame. A stream that stops — a dropped socket, a killed container, a
 * proxy timeout — throws `stream_truncated` rather than handing back the
 * fragment that did arrive, because a half-answer about a contract that
 * looks like a whole one is this project's founding defect wearing a
 * network cable.
 *
 * A stream-level rejection (an abort, a socket error) propagates unwrapped
 * and un-retried, exactly as `openrouter.ts`'s `chatStream` was careful to
 * do: a cancellation is a deliberate user decision.
 */
export async function readFrames(
  stream: AsyncIterable<Uint8Array>,
  onDelta: (text: string) => void,
): Promise<{ usage: InferUsage; callId: string }> {
  const reader = createSseEventReader();
  const decoder = new TextDecoder();
  let terminal: Frame | null = null;

  const handle = (raw: string): void => {
    if (terminal) return;
    const frame = decodeFrame(raw);
    if (!frame) return;
    if (frame.type === 'delta') onDelta(frame.text);
    else terminal = frame;
  };

  for await (const chunk of stream) {
    for (const raw of reader.push(decoder.decode(chunk, { stream: true }))) handle(raw);
    if (terminal && terminal.type === 'error') break;
  }
  const tail = decoder.decode();
  if (tail) for (const raw of reader.push(tail)) handle(raw);
  for (const raw of reader.flush()) handle(raw);

  const end = terminal as Frame | null;
  if (end && end.type === 'done') return { usage: end.usage, callId: end.callId };
  if (end && end.type === 'error') throw new ModelError(end.message, end.code, end.status, end.callId);
  throw new ModelError(
    'The answer stopped before it finished. Nothing was lost, but what arrived is incomplete — ask again.',
    'stream_truncated',
    0,
  );
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run --project core packages/core/src/model/sse.test.ts`
Expected: PASS, 23 tests.

- [ ] **Step 5: Export from the index**

Append to `packages/core/src/index.ts`:

```ts
export {
  createSseEventReader, sseFields, encodeFrame, decodeFrame, readFrames,
} from './model/sse.ts';
export type { Frame } from './model/sse.ts';
```

- [ ] **Step 6: Mutation test — three mutations, each on a bug this project has already shipped**

1. **CRLF.** Delete `.replace(/\r\n/g, '\n')` from `push`. Run the suite. Expected: FAIL on *"parses CRLF-terminated events instead of silently returning nothing"*, *"handles a stream mixing LF and CRLF"*, *"emits a CRLF event as soon as it arrives"*, *"survives a chunk boundary in the middle of the separator"*. Restore.
2. **Final flush.** Delete the `for (const raw of reader.flush()) handle(raw);` line from `readFrames`. Run. Expected: FAIL on *"does not drop the final delta when the done frame arrives without a trailing blank line"*. Restore.
3. **The terminator rule (D2).** Replace the final `throw new ModelError(… 'stream_truncated' …)` with `return { usage: { promptTokens: 0, completionTokens: 0 }, callId: '' };`. Run. Expected: FAIL on *"throws stream_truncated when the stream ends with no done and no error frame"* and *"throws stream_truncated on a completely empty stream"*. Restore.

Record all three in the commit message so the next reader knows they were run.

- [ ] **Step 7: Run the whole suite and the type check**

```bash
npx tsc --noEmit
npm test
```

Expected: clean, all green.

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/model/sse.ts packages/core/src/model/sse.test.ts packages/core/src/index.ts
git commit -F .git/COMMIT_MSG_TASK3
```

```
feat(core): one SSE splitter, one frame codec, and a truncated stream is an error

Proxying a stream through a gateway reintroduces the two SSE bugs this
project has already shipped — the dropped final token and the CRLF server
that returned nothing — at a new boundary, and five providers would give
that class of bug five surfaces. So the transport hazard and the provider
difference are separated: one splitter here, tested once; a pure
decodeEvent per adapter, tested offline against a recorded fixture.
apps/api parses nothing at all.

D2: readFrames resolves only on a done frame. A stream that stops throws
stream_truncated rather than handing back the fragment that arrived.

Mutation-tested three ways: CRLF normalisation removed (4 tests fail),
final flush removed (1 fails), the truncation throw replaced with an empty
success (2 fail). All restored.
```

---

## Task 4: The gateway workspace, its configuration, and refusing to start when it is wrong

**Type:** infrastructure

**Files:**
- Create: `apps/gateway/package.json`, `apps/gateway/tsconfig.json`, `apps/gateway/Dockerfile`, `apps/gateway/.dockerignore`
- Create: `apps/gateway/src/config.ts`, `apps/gateway/src/routes/health.ts`, `apps/gateway/src/server.ts`, `apps/gateway/src/main.ts`
- Create: `apps/gateway/test/config.test.ts`
- Modify: `package.json` (root scripts), `tsconfig.json` (include)

**Interfaces:**
- Consumes: `@lexprompt/core` (`ProviderId`, `Jurisdiction`, `AllowedModel`, `Bloc`, `isProviderId`).
- Produces:
  - `type CredentialConfig` — a discriminated union on `source`: `{ source: 'managed-identity'; scope: string }` | `{ source: 'key-vault'; vaultUrl: string; secretName: string }` | `{ source: 'env'; var: string }` | `{ source: 'file'; path: string }`
  - `interface ModelEntry extends AllowedModel { endpoint: string; apiVersion?: string; credential: CredentialConfig }` — the **gateway-internal** entry. `endpoint` and `credential` never leave the process.
  - `type CallerAuthConfig` — `{ mode: 'none' }` | `{ mode: 'mtls'; caFile; certFile; keyFile; allowedSubject }` | `{ mode: 'entra'; tenantId; audience; allowedObjectIds }`
  - `interface GatewayConfig { port: number; models: ModelEntry[]; allowedJurisdictions: Bloc[]; maxPromptChars: number; requestTimeoutMs: number; defaultMaxTokens: number; caller: CallerAuthConfig }` — **no `environment`, no `upstream`, no `stubDir`.** S30 forbids a module branching on the environment, and a config field named `environment` is how one starts. Offline working is a provider on the allowlist (Task 13), not a mode.
  - `loadConfig(env: NodeJS.ProcessEnv, readFile: (p: string) => string): GatewayConfig` — pure over its two inputs, so it is testable without a filesystem. Throws `ConfigError` naming the field.
  - `describeConfig(cfg: GatewayConfig): string` — the boot banner.
  - `class ConfigError extends Error`
  - `buildServer(deps: ServerDeps): FastifyInstance`

- [ ] **Step 1: Create the workspace**

`apps/gateway/package.json`:

```json
{
  "name": "@lexprompt/gateway",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/main.ts",
    "start": "node --experimental-strip-types src/main.ts",
    "smoke": "tsx src/smoke.ts"
  },
  "dependencies": {
    "@azure/identity": "^4.5.0",
    "@azure/keyvault-secrets": "^4.9.0",
    "@lexprompt/core": "*",
    "fastify": "^5.2.0",
    "undici": "^7.2.0"
  }
}
```

`apps/gateway/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "lib": ["ES2022"],
    "types": ["node"],
    "moduleResolution": "bundler",
    "isolatedModules": true,
    "moduleDetection": "force",
    "skipLibCheck": true,
    "allowImportingTsExtensions": true,
    "noEmit": true,
    "paths": { "@lexprompt/core": ["../../packages/core/src/index.ts"] }
  },
  "include": ["src", "test"]
}
```

Add `"apps/gateway/src"` and `"apps/gateway/test"` to the root `tsconfig.json`'s `include`, and these to the root `package.json` scripts:

```json
    "gateway:dev": "npm run dev -w @lexprompt/gateway",
    "api:dev": "npm run dev -w @lexprompt/api",
```

- [ ] **Step 2: Write the failing config tests**

`apps/gateway/test/config.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { loadConfig, ConfigError } from '../src/config.ts';

const UK_MODEL = {
  id: 'uks-gpt4o', provider: 'azure-foundry', model: 'gpt-4o',
  label: 'GPT-4o (Foundry, UK South)',
  jurisdiction: { bloc: 'UK', region: 'uksouth', label: 'UK South' },
  contextLength: 128000, supportsImages: true, supportsStructuredOutput: true,
  isDefault: true,
  endpoint: 'https://lexprompt-uks.services.ai.azure.com',
  credential: { source: 'managed-identity', scope: 'https://cognitiveservices.azure.com/.default' },
};

const US_MODEL = {
  id: 'oai-gpt4o', provider: 'openai', model: 'gpt-4o', label: 'GPT-4o (OpenAI)',
  jurisdiction: { bloc: 'US', region: 'us', label: 'United States' },
  contextLength: 128000, supportsImages: true, supportsStructuredOutput: true,
  isDefault: true,
  endpoint: 'https://api.openai.com',
  credential: { source: 'env', var: 'OPENAI_API_KEY' },
};

const BASE = {
  GATEWAY_PORT: '8081',
  GATEWAY_MODELS_FILE: '/etc/lexprompt/models.json',
  // No default exists, so every fixture states the operator's policy
  // explicitly — which is what a real deployment must also do.
  GATEWAY_ALLOWED_JURISDICTIONS: 'UK,EU',
  GATEWAY_CALLER_AUTH: 'mtls',
  GATEWAY_MTLS_CA_FILE: '/certs/ca.pem',
  GATEWAY_MTLS_CERT_FILE: '/certs/gateway.pem',
  GATEWAY_MTLS_KEY_FILE: '/certs/gateway.key',
  GATEWAY_MTLS_ALLOWED_SUBJECT: 'lexprompt-api',
};

const read = (body: string) => (p: string) => {
  if (p !== '/etc/lexprompt/models.json') throw new Error(`unexpected read of ${p}`);
  return body;
};

const file = (...models: unknown[]) => JSON.stringify({ models });

describe('loadConfig', () => {
  it('loads a model whose jurisdiction the operator has declared permitted', () => {
    const cfg = loadConfig({ ...BASE }, read(file(UK_MODEL)));
    expect(cfg.port).toBe(8081);
    expect(cfg.allowedJurisdictions).toEqual(['UK', 'EU']);
    expect(cfg.models).toHaveLength(1);
    expect(cfg.models[0].endpoint).toBe('https://lexprompt-uks.services.ai.azure.com');
  });

  // D4, and the owner's fifth decision. THERE IS NO DEFAULT: which
  // jurisdictions a firm accepts is a judgement about contracts and data
  // provisions that this design has no standing to make on their behalf, and
  // a default value would make it silently.
  it('REFUSES TO START when GATEWAY_ALLOWED_JURISDICTIONS is unset, rather than assuming one', () => {
    const { GATEWAY_ALLOWED_JURISDICTIONS, ...unset } = BASE;
    expect(() => loadConfig(unset, read(file(UK_MODEL))))
      .toThrow(/GATEWAY_ALLOWED_JURISDICTIONS[\s\S]*no default/i);
  });

  it('REFUSES TO START when it is set but empty, which is the same silence with a keystroke', () => {
    expect(() => loadConfig({ ...BASE, GATEWAY_ALLOWED_JURISDICTIONS: '   ' }, read(file(UK_MODEL))))
      .toThrow(/GATEWAY_ALLOWED_JURISDICTIONS/);
  });

  // D4 — the jurisdiction gate itself.
  it('REFUSES TO START when a model is outside the permitted jurisdictions, naming it', () => {
    expect(() => loadConfig({ ...BASE }, read(file(US_MODEL))))
      .toThrow(/oai-gpt4o[\s\S]*openai[\s\S]*US[\s\S]*United States[\s\S]*GATEWAY_ALLOWED_JURISDICTIONS/);
  });

  // Not because US is exceptional — because it is a jurisdiction this
  // operator had not declared. The same test would hold for EU under a
  // UK-only policy.
  it('starts with a US model when the operator has declared US permitted', () => {
    const cfg = loadConfig(
      { ...BASE, GATEWAY_ALLOWED_JURISDICTIONS: 'UK,EU,US' },
      read(file(US_MODEL)),
    );
    expect(cfg.models[0].jurisdiction.bloc).toBe('US');
    expect(cfg.allowedJurisdictions).toEqual(['UK', 'EU', 'US']);
  });

  it('refuses an unknown bloc in the permitted list rather than ignoring it', () => {
    expect(() => loadConfig({ ...BASE, GATEWAY_ALLOWED_JURISDICTIONS: 'UK,MARS' }, read(file(UK_MODEL))))
      .toThrow(/GATEWAY_ALLOWED_JURISDICTIONS[\s\S]*MARS/);
  });

  it('refuses an unknown provider id rather than dropping the entry', () => {
    expect(() => loadConfig({ ...BASE }, read(file({ ...UK_MODEL, provider: 'bedrock' }))))
      .toThrow(/bedrock/);
  });

  it('refuses an entry with no jurisdiction rather than assuming one', () => {
    const { jurisdiction, ...noJurisdiction } = UK_MODEL;
    expect(() => loadConfig({ ...BASE }, read(file(noJurisdiction))))
      .toThrow(/uks-gpt4o[\s\S]*jurisdiction/);
  });

  it('refuses an entry with no credential source rather than calling unauthenticated', () => {
    const { credential, ...noCredential } = UK_MODEL;
    expect(() => loadConfig({ ...BASE }, read(file(noCredential))))
      .toThrow(/uks-gpt4o[\s\S]*credential\.source/);
  });

  it('refuses an EMPTY allowlist rather than starting with nothing to offer', () => {
    expect(() => loadConfig({ ...BASE }, read(file())))
      .toThrow(/at least one model/i);
  });

  it('refuses two entries sharing an id', () => {
    expect(() => loadConfig({ ...BASE }, read(file(UK_MODEL, UK_MODEL))))
      .toThrow(/duplicate model id "uks-gpt4o"/i);
  });

  it('refuses more than one default, and refuses none', () => {
    const other = { ...UK_MODEL, id: 'other' };
    expect(() => loadConfig({ ...BASE }, read(file(UK_MODEL, other))))
      .toThrow(/exactly one model must be marked isDefault/i);
    expect(() => loadConfig({ ...BASE }, read(file({ ...UK_MODEL, isDefault: false }))))
      .toThrow(/exactly one model must be marked isDefault/i);
  });

  it('refuses a missing models file reference rather than serving nothing', () => {
    const { GATEWAY_MODELS_FILE, ...noFile } = BASE;
    expect(() => loadConfig(noFile, read(file(UK_MODEL)))).toThrow(/GATEWAY_MODELS_FILE/);
  });

  it('reports a malformed models file as a config error, not a JSON parse crash', () => {
    expect(() => loadConfig({ ...BASE }, read('{not json'))).toThrow(ConfigError);
  });

  it('defaults the operational limits and lets the operator raise them', () => {
    const d = loadConfig({ ...BASE }, read(file(UK_MODEL)));
    expect(d.maxPromptChars).toBe(400_000);
    expect(d.requestTimeoutMs).toBe(120_000);
    expect(d.defaultMaxTokens).toBe(4096);
    const raised = loadConfig(
      { ...BASE, GATEWAY_MAX_PROMPT_CHARS: '900000', GATEWAY_REQUEST_TIMEOUT_MS: '30000' },
      read(file(UK_MODEL)),
    );
    expect(raised.maxPromptChars).toBe(900_000);
    expect(raised.requestTimeoutMs).toBe(30_000);
  });

  it('refuses a non-numeric limit rather than silently using the default', () => {
    expect(() => loadConfig({ ...BASE, GATEWAY_MAX_PROMPT_CHARS: 'lots' }, read(file(UK_MODEL))))
      .toThrow(/GATEWAY_MAX_PROMPT_CHARS/);
  });

  it('refuses an unknown caller-auth mode rather than defaulting to none', () => {
    expect(() => loadConfig({ ...BASE, GATEWAY_CALLER_AUTH: 'trustme' }, read(file(UK_MODEL))))
      .toThrow(/GATEWAY_CALLER_AUTH/);
  });

  // S29's shape at the gateway's own front door, and S30's "no environment
  // branch": there is no configuration value that turns the caller check
  // off, so there is nothing to accidentally ship enabled and nothing that
  // behaves differently in one environment.
  it('has NO configuration value that disables the caller check, in any environment', () => {
    for (const nodeEnv of ['development', 'production', undefined]) {
      expect(() => loadConfig(
        { ...BASE, GATEWAY_CALLER_AUTH: 'none', NODE_ENV: nodeEnv }, read(file(UK_MODEL)),
      )).toThrow(/no value that disables the caller check/i);
    }
  });
});
```

- [ ] **Step 3: Run and watch it fail**

Run: `npx vitest run --project gateway`
Expected: FAIL — `Failed to resolve import "../src/config.ts"`.

- [ ] **Step 4: Implement `config.ts`**

```ts
import {
  isProviderId, type AllowedModel, type Bloc, type Jurisdiction, type ProviderId,
} from '@lexprompt/core';

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export type CredentialConfig =
  | { source: 'managed-identity'; scope: string }
  | { source: 'key-vault'; vaultUrl: string; secretName: string }
  | { source: 'env'; var: string }
  | { source: 'file'; path: string };

/**
 * An allowlist entry as the gateway holds it.
 *
 * `endpoint` and `credential` are the two fields that must NEVER leave this
 * process. `toAllowedModel` (Task 5) is the only route from one of these to
 * something a browser may see.
 */
export interface ModelEntry extends AllowedModel {
  endpoint: string;
  apiVersion?: string;
  credential: CredentialConfig;
}

export type CallerAuthConfig =
  | { mode: 'none' }
  | { mode: 'mtls'; caFile: string; certFile: string; keyFile: string; allowedSubject: string }
  | { mode: 'entra'; tenantId: string; audience: string; allowedObjectIds: string[] };

export interface GatewayConfig {
  port: number;
  models: ModelEntry[];
  allowedJurisdictions: Bloc[];
  maxPromptChars: number;
  requestTimeoutMs: number;
  defaultMaxTokens: number;
  caller: CallerAuthConfig;
}
// Deliberately absent: `environment`, `upstream`, `stubDir`. S30 forbids any
// module branching on the environment, and a config field called
// `environment` is where that starts. Offline working is a provider on the
// allowlist (Task 13), not a mode; the caller-auth check below is the one
// allowlist (Task 13), not a mode. NOTHING in this file reads NODE_ENV.

const BLOCS: readonly Bloc[] = ['UK', 'EU', 'US', 'other'];

function int(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new ConfigError(`${name} must be a positive number; got ${JSON.stringify(raw)}.`);
  }
  return n;
}

function str(value: unknown, entryId: string, field: string): string {
  if (typeof value !== 'string' || !value) {
    throw new ConfigError(`Model "${entryId}" is missing ${field}.`);
  }
  return value;
}

function parseJurisdiction(raw: unknown, entryId: string): Jurisdiction {
  const j = raw as Partial<Jurisdiction> | undefined;
  if (!j || typeof j !== 'object') {
    throw new ConfigError(
      `Model "${entryId}" has no jurisdiction. Every model must declare where it is `
      + 'processed — an unstated jurisdiction is how a firm ends up believing it is UK-only.',
    );
  }
  if (!BLOCS.includes(j.bloc as Bloc)) {
    throw new ConfigError(
      `Model "${entryId}" has jurisdiction.bloc ${JSON.stringify(j.bloc)}; `
      + `expected one of ${BLOCS.join(', ')}.`,
    );
  }
  return {
    bloc: j.bloc as Bloc,
    region: str(j.region, entryId, 'jurisdiction.region'),
    label: str(j.label, entryId, 'jurisdiction.label'),
  };
}

function parseCredential(raw: unknown, entryId: string): CredentialConfig {
  const c = (raw ?? {}) as Record<string, unknown>;
  switch (c.source) {
    case 'managed-identity':
      return { source: 'managed-identity', scope: str(c.scope, entryId, 'credential.scope') };
    case 'key-vault':
      return {
        source: 'key-vault',
        vaultUrl: str(c.vaultUrl, entryId, 'credential.vaultUrl'),
        secretName: str(c.secretName, entryId, 'credential.secretName'),
      };
    case 'env':
      return { source: 'env', var: str(c.var, entryId, 'credential.var') };
    case 'file':
      return { source: 'file', path: str(c.path, entryId, 'credential.path') };
    default:
      throw new ConfigError(
        `Model "${entryId}" has credential.source ${JSON.stringify(c.source)}; `
        + 'expected managed-identity, key-vault, env or file.',
      );
  }
}

function parseCaller(env: NodeJS.ProcessEnv): CallerAuthConfig {
  const mode = env.GATEWAY_CALLER_AUTH;
  // `mode: 'none'` is deliberately NOT reachable from configuration. It
  // exists as a type so unit tests can construct one directly, and there is
  // no environment variable that produces it — which is stronger than
  // refusing it under NODE_ENV=production, and is the only version
  // compatible with S30's "no module branches on the environment". Local
  // development uses mTLS like the compose stack does; there is no mode that
  // turns the caller check off (S29's shape, applied to the gateway's own
  // front door).
  if (mode === 'mtls') {
    return {
      mode: 'mtls',
      caFile: str(env.GATEWAY_MTLS_CA_FILE, 'gateway', 'GATEWAY_MTLS_CA_FILE'),
      certFile: str(env.GATEWAY_MTLS_CERT_FILE, 'gateway', 'GATEWAY_MTLS_CERT_FILE'),
      keyFile: str(env.GATEWAY_MTLS_KEY_FILE, 'gateway', 'GATEWAY_MTLS_KEY_FILE'),
      allowedSubject: str(env.GATEWAY_MTLS_ALLOWED_SUBJECT, 'gateway', 'GATEWAY_MTLS_ALLOWED_SUBJECT'),
    };
  }
  if (mode === 'entra') {
    return {
      mode: 'entra',
      tenantId: str(env.GATEWAY_ENTRA_TENANT_ID, 'gateway', 'GATEWAY_ENTRA_TENANT_ID'),
      audience: str(env.GATEWAY_ENTRA_AUDIENCE, 'gateway', 'GATEWAY_ENTRA_AUDIENCE'),
      allowedObjectIds: (env.GATEWAY_ENTRA_ALLOWED_OIDS ?? '')
        .split(',').map(s => s.trim()).filter(Boolean),
    };
  }
  throw new ConfigError(
    `GATEWAY_CALLER_AUTH must be mtls or entra; got ${JSON.stringify(mode)}. `
    + 'There is no value that disables the caller check.',
  );
}

export function loadConfig(
  env: NodeJS.ProcessEnv,
  readFile: (path: string) => string,
): GatewayConfig {
  const modelsFile = env.GATEWAY_MODELS_FILE;
  if (!modelsFile) {
    throw new ConfigError(
      'GATEWAY_MODELS_FILE is not set. The gateway will not start without an allowlist: '
      + 'starting with none would mean either refusing every call or, worse, somebody later '
      + 'making "no allowlist" mean "anything allowed".',
    );
  }

  let raw: { models?: unknown[] };
  try {
    raw = JSON.parse(readFile(modelsFile)) as { models?: unknown[] };
  } catch (err) {
    throw new ConfigError(
      `GATEWAY_MODELS_FILE (${modelsFile}) could not be read as JSON: ${(err as Error).message}`,
    );
  }

  const entries = Array.isArray(raw.models) ? raw.models : [];
  if (entries.length === 0) {
    throw new ConfigError(`${modelsFile} lists no models. Configure at least one model.`);
  }

  const models: ModelEntry[] = entries.map((item) => {
    const m = item as Record<string, unknown>;
    const id = str(m.id, String(m.id ?? '(unnamed)'), 'id');
    if (!isProviderId(m.provider)) {
      throw new ConfigError(
        `Model "${id}" names provider ${JSON.stringify(m.provider)}, `
        + 'which is not a provider this gateway has an adapter for.',
      );
    }
    return {
      id,
      provider: m.provider as ProviderId,
      model: str(m.model, id, 'model'),
      label: str(m.label, id, 'label'),
      jurisdiction: parseJurisdiction(m.jurisdiction, id),
      contextLength: Number(m.contextLength ?? 0),
      supportsImages: m.supportsImages === true,
      supportsStructuredOutput: m.supportsStructuredOutput === true,
      isDefault: m.isDefault === true,
      endpoint: str(m.endpoint, id, 'endpoint'),
      apiVersion: typeof m.apiVersion === 'string' ? m.apiVersion : undefined,
      credential: parseCredential(m.credential, id),
    };
  });

  const seen = new Set<string>();
  for (const m of models) {
    if (seen.has(m.id)) throw new ConfigError(`Duplicate model id "${m.id}".`);
    seen.add(m.id);
  }
  if (models.filter(m => m.isDefault).length !== 1) {
    throw new ConfigError('Exactly one model must be marked isDefault.');
  }

  // NO DEFAULT, deliberately (owner decision 5). Which jurisdictions a firm
  // accepts is a judgement about the contracts and data provisions it holds
  // with its providers — settled with legal input, long before anyone edits
  // this file. A default would make that judgement silently, on their
  // behalf, and the system would then enforce it as though somebody had
  // chosen it. Unset is a startup failure instead: strictly more fail-closed
  // than any default could be, because a refusal cannot be mistaken for a
  // decision.
  const declared = (env.GATEWAY_ALLOWED_JURISDICTIONS ?? '').trim();
  if (!declared) {
    throw new ConfigError(
      'GATEWAY_ALLOWED_JURISDICTIONS is not set, and it has no default. It lists the '
      + `processing jurisdictions this deployment permits (any of ${BLOCS.join(', ')}), `
      + 'and it must state the policy the operator has settled with their providers — '
      + 'LexPrompt will not guess it. Set it to the jurisdictions your contracts and data '
      + 'provisions cover.',
    );
  }
  const allowedJurisdictions = declared
    .split(',').map(s => s.trim()).filter(Boolean) as Bloc[];
  for (const bloc of allowedJurisdictions) {
    if (!BLOCS.includes(bloc)) {
      throw new ConfigError(
        `GATEWAY_ALLOWED_JURISDICTIONS contains ${JSON.stringify(bloc)}; `
        + `expected one of ${BLOCS.join(', ')}.`,
      );
    }
  }

  // D4. An operator routing privileged text outside the permitted blocs
  // must have written that bloc down. There is no runtime warning to scroll
  // past and no documentation note to not read.
  for (const m of models) {
    if (!allowedJurisdictions.includes(m.jurisdiction.bloc)) {
      throw new ConfigError(
        `Model "${m.id}" (provider ${m.provider}) is processed in `
        + `${m.jurisdiction.bloc} · ${m.jurisdiction.label}, which is not in `
        + `GATEWAY_ALLOWED_JURISDICTIONS (${allowedJurisdictions.join(', ')}). `
        + `Remove the model, or add ${m.jurisdiction.bloc} to `
        + 'GATEWAY_ALLOWED_JURISDICTIONS to record that your provisions with this '
        + 'provider cover processing there.',
      );
    }
  }

  return {
    port: int(env, 'GATEWAY_PORT', 8081),
    models,
    allowedJurisdictions,
    maxPromptChars: int(env, 'GATEWAY_MAX_PROMPT_CHARS', 400_000),
    requestTimeoutMs: int(env, 'GATEWAY_REQUEST_TIMEOUT_MS', 120_000),
    defaultMaxTokens: int(env, 'GATEWAY_DEFAULT_MAX_TOKENS', 4096),
    caller: parseCaller(env),
  };
}

/**
 * The boot banner. Printed every start, because the answer to "where does
 * our contract text go" belongs in the first screen of this service's logs
 * rather than in a document somebody has to find.
 */
export function describeConfig(cfg: GatewayConfig): string {
  const rows = cfg.models.map(m =>
    `  ${m.isDefault ? '*' : ' '} ${m.id.padEnd(24)} ${m.provider.padEnd(15)} `
    + `${m.jurisdiction.bloc} · ${m.jurisdiction.label} (auth: ${m.credential.source})`);
  return [
    `LexPrompt gateway — caller-auth=${cfg.caller.mode}`,
    `Permitted jurisdictions: ${cfg.allowedJurisdictions.join(', ')}`,
    'Allowlisted models:',
    ...rows,
  ].join('\n');
}
```

- [ ] **Step 5: Implement the server skeleton**

`apps/gateway/src/routes/health.ts`:

```ts
import type { FastifyInstance } from 'fastify';

/** Liveness only. It deliberately reports NOTHING about configuration — a
 *  health endpoint listing models or providers would be an unauthenticated
 *  read of the allowlist. */
export function registerHealth(app: FastifyInstance): void {
  app.get('/healthz', async () => ({ status: 'ok' }));
}
```

`apps/gateway/src/server.ts`:

```ts
import Fastify, { type FastifyInstance } from 'fastify';
import type { GatewayConfig } from './config.ts';
import { registerHealth } from './routes/health.ts';

export interface ServerDeps {
  config: GatewayConfig;
}

export function buildServer(deps: ServerDeps): FastifyInstance {
  const app = Fastify({
    // audit.ts owns every log line this service writes (§10). Fastify's own
    // request logger would write URLs and headers on a service whose whole
    // discipline is that it logs metadata and never content.
    logger: false,
    bodyLimit: deps.config.maxPromptChars * 4,
  });
  registerHealth(app);
  return app;
}
```

`apps/gateway/src/main.ts`:

```ts
import { readFileSync } from 'node:fs';
import { loadConfig, describeConfig, ConfigError } from './config.ts';
import { buildServer } from './server.ts';

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig(process.env, p => readFileSync(p, 'utf8'));
  } catch (err) {
    if (err instanceof ConfigError) {
      // Fail loudly, at startup, before a single call can be served.
      process.stderr.write(`LexPrompt gateway will not start.\n${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }
  process.stdout.write(`${describeConfig(config)}\n`);
  const app = buildServer({ config });
  await app.listen({ port: config.port, host: '0.0.0.0' });
}

void main();
```

- [ ] **Step 6: Write the Dockerfile**

`apps/gateway/Dockerfile`:

```dockerfile
FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY apps/gateway/package.json apps/gateway/
RUN npm ci --omit=dev --workspace @lexprompt/gateway --include-workspace-root
COPY packages/core packages/core
COPY apps/gateway apps/gateway
USER node
EXPOSE 8081
CMD ["node", "--experimental-strip-types", "apps/gateway/src/main.ts"]
```

`apps/gateway/.dockerignore`:

```
node_modules
test
```

**`fixtures/recorded` is deliberately NOT excluded.** The image is the same image in both environments (§5.1) — building a different one for production would be the environment branch S30 forbids, moved into the build. What keeps recorded responses out of a firm deployment is S27's jurisdiction refusal (Task 13), which is a check that already exists and that every provider passes through, rather than a second mechanism built for one of them.

- [ ] **Step 7: Run the tests**

Run: `npx vitest run --project gateway`
Expected: PASS, 18 tests.

- [ ] **Step 8: Mutation test the jurisdiction gate, and the absence of its default (D4)**

**Mutation 1 — the gate.** Comment out the whole `for (const m of models) { if (!allowedJurisdictions.includes(m.jurisdiction.bloc)) … }` block. Run `npx vitest run --project gateway`.
Expected: FAIL on *"REFUSES TO START when a model is outside the permitted jurisdictions, naming it"*. Restore and re-run: PASS.

**Mutation 2 — the absence of a default.** Restore the default: change the loader to

```ts
  const declared = (env.GATEWAY_ALLOWED_JURISDICTIONS ?? 'UK,EU').trim();
```

and delete the `if (!declared)` throw. Run. Expected: FAIL on *"REFUSES TO START when GATEWAY_ALLOWED_JURISDICTIONS is unset"* and *"REFUSES TO START when it is set but empty"*. Restore.

**This mutation matters more than it looks, and that is why it is named rather than left to judgement.** The absence of a default is invisible to every happy-path test: with `UK,EU` restored, every other test in this file still passes, the gateway still starts, the gate still refuses a US model, and the boot banner still prints a table. Nothing looks wrong. Without this specific mutation a later, entirely well-meant "sensible default" would slip in green — and it would encode an assumption about one firm's contracts as though it were a property of the software.

- [ ] **Step 9: Verify it actually starts and actually refuses**

```bash
mkdir -p /tmp/lexprompt && cat > /tmp/lexprompt/models.json <<'JSON'
{"models":[{"id":"oai-gpt4o","provider":"openai","model":"gpt-4o","label":"GPT-4o (OpenAI)",
"jurisdiction":{"bloc":"US","region":"us","label":"United States"},"contextLength":128000,
"supportsImages":true,"supportsStructuredOutput":true,"isDefault":true,
"endpoint":"https://api.openai.com","credential":{"source":"env","var":"OPENAI_API_KEY"}}]}
JSON
GATEWAY_MODELS_FILE=/tmp/lexprompt/models.json \
GATEWAY_CALLER_AUTH=mtls GATEWAY_MTLS_CA_FILE=certs/ca.pem \
GATEWAY_MTLS_CERT_FILE=certs/gateway.pem GATEWAY_MTLS_KEY_FILE=certs/gateway.key \
GATEWAY_MTLS_ALLOWED_SUBJECT=lexprompt-api \
  npx tsx apps/gateway/src/main.ts; echo "exit=$?"
```

Expected: `LexPrompt gateway will not start.` and a message saying `GATEWAY_ALLOWED_JURISDICTIONS` is not set and has no default; `exit=1`. Then set it to `UK,EU` and re-run: it now fails for the *second* reason, naming `oai-gpt4o`, `openai`, `US · United States`; `exit=1`.

Then:

```bash
GATEWAY_MODELS_FILE=/tmp/lexprompt/models.json \
GATEWAY_CALLER_AUTH=mtls GATEWAY_MTLS_CA_FILE=certs/ca.pem \
GATEWAY_MTLS_CERT_FILE=certs/gateway.pem GATEWAY_MTLS_KEY_FILE=certs/gateway.key \
GATEWAY_MTLS_ALLOWED_SUBJECT=lexprompt-api \
GATEWAY_ALLOWED_JURISDICTIONS=UK,EU,US npx tsx apps/gateway/src/main.ts &
sleep 1 && curl -s localhost:8081/healthz; kill %1
```

Expected: the boot banner reading `Permitted jurisdictions: UK, EU, US` and one model row, then `{"status":"ok"}`.

- [ ] **Step 10: Commit**

```bash
git add apps/gateway package.json package-lock.json tsconfig.json
git commit -F .git/COMMIT_MSG_TASK4
```

```
feat(gateway): the workspace, its configuration, and D4's jurisdiction gate

Configuration is validated at startup and the process refuses to start when
it is wrong: an unstated jurisdiction, an unknown provider, a missing
credential source, an empty allowlist, two defaults.

The jurisdiction gate enforces the OPERATOR's declared policy and has NO
default (owner decision 5): which jurisdictions a firm accepts is a judgement
about the contracts and data provisions it holds with its providers, and a
default would make that judgement silently on their behalf. Unset is a
startup failure, which is strictly more fail-closed than a default — a
refusal cannot be mistaken for a decision. A model processed outside the
declared set stops the gateway, naming the model, its provider and where it
processes. The boot banner prints the whole table on every start.

Mutation-tested twice: the gate removed (1 test fails); and the `?? 'UK,EU'`
default restored (2 fail). The second matters more than it looks — with a
default in place every other test still passes and nothing looks wrong, so
without that mutation a later well-meant "sensible default" would slip in
green.
```

---

## Task 5: The allowlist — lookup, and the strip that keeps endpoints and credentials inside

**Type:** application code

**Files:**
- Create: `apps/gateway/src/allowlist.ts`
- Create: `apps/gateway/test/allowlist.test.ts`

**Interfaces:**
- Consumes: `ModelEntry` (Task 4); `AllowedModel`, `ModelError` (Task 2).
- Produces:
  - `class Allowlist` with `resolve(modelChoiceId: string): ModelEntry` (throws `ModelError` code `model_not_allowed`, status 400), `list(): AllowedModel[]`, `default(): ModelEntry`
  - `toAllowedModel(entry: ModelEntry): AllowedModel`

- [ ] **Step 1: Write the failing test**

`apps/gateway/test/allowlist.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Allowlist, toAllowedModel } from '../src/allowlist.ts';
import type { ModelEntry } from '../src/config.ts';

const uk: ModelEntry = {
  id: 'uks-gpt4o', provider: 'azure-foundry', model: 'gpt-4o',
  label: 'GPT-4o (Foundry, UK South)',
  jurisdiction: { bloc: 'UK', region: 'uksouth', label: 'UK South' },
  contextLength: 128000, supportsImages: true, supportsStructuredOutput: true, isDefault: true,
  endpoint: 'https://lexprompt-uks.services.ai.azure.com',
  credential: { source: 'managed-identity', scope: 'https://cognitiveservices.azure.com/.default' },
};

const claude: ModelEntry = {
  id: 'claude-sonnet', provider: 'anthropic', model: 'claude-sonnet-4-5',
  label: 'Claude Sonnet 4.5 (Anthropic)',
  jurisdiction: { bloc: 'US', region: 'us', label: 'United States' },
  contextLength: 200000, supportsImages: true, supportsStructuredOutput: true, isDefault: false,
  endpoint: 'https://api.anthropic.com',
  // Deliberately NOT the string 'anthropic': a leak test that cannot tell
  // the secret name from the legitimate `provider` field proves nothing.
  credential: { source: 'key-vault', vaultUrl: 'https://kv.vault.azure.net', secretName: 'prod-model-key' },
};

describe('Allowlist (S15)', () => {
  const list = new Allowlist([uk, claude]);

  it('resolves an allowlisted id to its full internal entry', () => {
    expect(list.resolve('uks-gpt4o').endpoint).toBe('https://lexprompt-uks.services.ai.azure.com');
  });

  it('refuses an id that is not on the list, with model_not_allowed', () => {
    expect(() => list.resolve('gpt-5-turbo-ultra'))
      .toThrowError(expect.objectContaining({ code: 'model_not_allowed', status: 400 }));
  });

  // The failure S15 exists to prevent: a user naming a provider model and
  // reaching an egress destination nobody reviewed.
  it('refuses a PROVIDER-side model name even when an entry uses it', () => {
    expect(() => list.resolve('gpt-4o'))
      .toThrowError(expect.objectContaining({ code: 'model_not_allowed' }));
  });

  it('names the model the caller asked for, so the message is diagnosable', () => {
    expect(() => list.resolve('nope')).toThrow(/"nope"/);
  });

  it('returns the single default', () => {
    expect(list.default().id).toBe('uks-gpt4o');
  });
});

describe('toAllowedModel — nothing internal crosses the wire', () => {
  it('produces exactly the AllowedModel keys and no others', () => {
    expect(Object.keys(toAllowedModel(claude)).sort()).toEqual([
      'contextLength', 'id', 'isDefault', 'jurisdiction', 'label',
      'model', 'provider', 'supportsImages', 'supportsStructuredOutput',
    ]);
  });

  it('drops endpoint, apiVersion and credential', () => {
    const wire = toAllowedModel(claude) as Record<string, unknown>;
    expect('endpoint' in wire).toBe(false);
    expect('apiVersion' in wire).toBe(false);
    expect('credential' in wire).toBe(false);
  });

  it('no serialisation of the list mentions a vault, a secret name or an endpoint host', () => {
    const json = JSON.stringify(new Allowlist([uk, claude]).list());
    expect(json).not.toContain('vault.azure.net');
    expect(json).not.toContain('prod-model-key');
    expect(json).not.toContain('services.ai.azure.com');
    expect(json).not.toContain('api.anthropic.com');
    expect(json).toContain('claude-sonnet');   // the entry id is fine, and needed
  });

  it('keeps the jurisdiction, because the browser has to show it', () => {
    expect(toAllowedModel(claude).jurisdiction)
      .toEqual({ bloc: 'US', region: 'us', label: 'United States' });
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `npx vitest run --project gateway apps/gateway/test/allowlist.test.ts`
Expected: FAIL — `Failed to resolve import "../src/allowlist.ts"`.

- [ ] **Step 3: Implement `allowlist.ts`**

```ts
import { ModelError, type AllowedModel } from '@lexprompt/core';
import type { ModelEntry } from './config.ts';

/**
 * Strips a gateway-internal entry down to what a browser may see.
 *
 * Written as an explicit field list rather than a destructured rest, so a
 * field added to `ModelEntry` later is NOT carried outwards by default. The
 * right default for a new internal field is "stays inside";
 * `{ endpoint, credential, ...rest }` gives it the opposite default, and
 * the leak would be invisible in the diff that caused it.
 */
export function toAllowedModel(entry: ModelEntry): AllowedModel {
  return {
    id: entry.id,
    provider: entry.provider,
    model: entry.model,
    label: entry.label,
    jurisdiction: entry.jurisdiction,
    contextLength: entry.contextLength,
    supportsImages: entry.supportsImages,
    supportsStructuredOutput: entry.supportsStructuredOutput,
    isDefault: entry.isDefault,
  };
}

/**
 * The single home of the allowlist (S15).
 *
 * `apps/api` holds NO copy and validates no model choice — it forwards, and
 * the gateway refuses. Two copies of an allowlist is the sibling drift this
 * project has paid for six times, here in the one place where the two
 * copies would be reachable only by two different deployments'
 * configurations and neither would ever see the other's.
 */
export class Allowlist {
  #byId: Map<string, ModelEntry>;
  #entries: ModelEntry[];

  constructor(entries: ModelEntry[]) {
    this.#entries = entries;
    this.#byId = new Map(entries.map(e => [e.id, e]));
  }

  resolve(modelChoiceId: string): ModelEntry {
    const entry = this.#byId.get(modelChoiceId);
    if (!entry) {
      throw new ModelError(
        `The model ${JSON.stringify(modelChoiceId)} is not on this workspace's allowlist. `
        + 'LexPrompt can only use models an administrator has configured.',
        'model_not_allowed',
        400,
      );
    }
    return entry;
  }

  list(): AllowedModel[] {
    return this.#entries.map(toAllowedModel);
  }

  default(): ModelEntry {
    // config.ts has already proved exactly one entry is default.
    return this.#entries.find(e => e.isDefault) as ModelEntry;
  }
}
```

- [ ] **Step 4: Run the test**

Run: `npx vitest run --project gateway apps/gateway/test/allowlist.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Mutation test the strip**

Replace `toAllowedModel`'s body with:

```ts
  const { credential, ...rest } = entry;
  return rest as AllowedModel;
```

Run the test. Expected: FAIL on *"produces exactly the AllowedModel keys and no others"*, *"drops endpoint, apiVersion and credential"* and *"no serialisation … mentions a vault, a secret name or an endpoint host"*. Restore.

This is the mutation worth naming: the rest-spread version is what a reasonable engineer writes, it survives an eyeball, and it ships the endpoint host of every configured provider to every browser.

- [ ] **Step 6: Commit**

```bash
git add apps/gateway/src/allowlist.ts apps/gateway/test/allowlist.test.ts
git commit -F .git/COMMIT_MSG_TASK5
```

```
feat(gateway): the allowlist, and the strip that keeps endpoints inside

One home for the allowlist: apps/api holds no copy and validates nothing —
it forwards and the gateway refuses. toAllowedModel lists its output fields
explicitly rather than spreading a rest, so a field added to ModelEntry
later stays inside by default.

Mutation-tested: rewritten as a rest-spread, three tests fail; restored.
```

---

## Task 6: The audit record — written before the call, refusing the call when it cannot be written

**Type:** application code

**Files:**
- Create: `apps/gateway/src/audit.ts`
- Create: `apps/gateway/test/audit.test.ts`

**Interfaces:**
- Consumes: `ModelEntry` (Task 4); `Purpose`, `ProviderId`, `Jurisdiction`, `InferContext`, `InferUsage`, `ModelError` (Task 2).
- Produces:
  - `interface AuditStart { kind: 'call.started'; callId: string; at: string; purpose: Purpose; provider: ProviderId; model: string; modelChoiceId: string; jurisdiction: Jurisdiction; credentialSource: CredentialConfig['source']; workspaceId: string; actorIssuer: string; actorSubject: string; matterId?: string; reviewId?: string; clauseId?: string; documentIds?: string[]; promptSha256: string; promptChars: number; imageCount: number; streaming: boolean }` — no `stubbed`: `provider` already carries it
  - `interface AuditFinish { kind: 'call.finished'; callId: string; at: string; status: number; ok: boolean; errorCode?: ModelErrorCode; promptTokens: number; completionTokens: number; latencyMs: number; retries: number }`
  - `type AuditRecord = AuditStart | AuditFinish`
  - `interface AuditSink { write(record: AuditRecord): Promise<void> }`
  - `class JsonlAuditSink implements AuditSink` — one JSON object per line to a writable stream, awaiting the write callback so a broken pipe rejects
  - `class AuditLogger` with `start(input: AuditStartInput): Promise<string>` (returns the call id; **throws `ModelError('service_misconfigured', 503)` when the sink fails**) and `finish(callId, outcome): Promise<void>`
  - `sha256Hex(text: string): string`

- [ ] **Step 1: Write the failing test**

`apps/gateway/test/audit.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { AuditLogger, JsonlAuditSink, sha256Hex, type AuditRecord, type AuditSink } from '../src/audit.ts';
import { Writable } from 'node:stream';

const CANARY = 'The Tenant shall not assign the whole of this Lease without consent.';

class Collecting implements AuditSink {
  records: AuditRecord[] = [];
  async write(r: AuditRecord): Promise<void> { this.records.push(r); }
}

class Failing implements AuditSink {
  async write(): Promise<void> { throw new Error('log pipe closed'); }
}

const START = {
  purpose: 'review.clause' as const,
  entry: {
    id: 'uks-gpt4o', provider: 'azure-foundry' as const, model: 'gpt-4o',
    label: 'GPT-4o', jurisdiction: { bloc: 'UK' as const, region: 'uksouth', label: 'UK South' },
    contextLength: 128000, supportsImages: true, supportsStructuredOutput: true, isDefault: true,
    endpoint: 'https://x.services.ai.azure.com',
    credential: { source: 'managed-identity' as const, scope: 'https://cognitiveservices.azure.com/.default' },
  },
  workspaceId: 'ws-1',
  actorIssuer: 'https://login.microsoftonline.com/t/v2.0',
  actorSubject: 'oid-abc',
  context: { matterId: 'm-1', reviewId: 'r-1', clauseId: 'c-14', documentIds: ['d-1', 'd-2'] },
  system: 'You are a contract reviewer.',
  user: CANARY,
  imageCount: 2,
  streaming: false,
};

describe('the audit record (§10)', () => {
  it('records every field §10 names, plus provider, jurisdiction and (issuer, subject)', async () => {
    const sink = new Collecting();
    const log = new AuditLogger(sink, () => new Date('2026-08-28T16:41:00Z'), () => 'call-1');
    const callId = await log.start(START);
    await log.finish(callId, {
      status: 200, ok: true, promptTokens: 1200, completionTokens: 300, latencyMs: 2410, retries: 1,
    });

    expect(sink.records[0]).toEqual({
      kind: 'call.started',
      callId: 'call-1',
      at: '2026-08-28T16:41:00.000Z',
      purpose: 'review.clause',
      provider: 'azure-foundry',
      model: 'gpt-4o',
      modelChoiceId: 'uks-gpt4o',
      jurisdiction: { bloc: 'UK', region: 'uksouth', label: 'UK South' },
      credentialSource: 'managed-identity',
      workspaceId: 'ws-1',
      actorIssuer: 'https://login.microsoftonline.com/t/v2.0',
      actorSubject: 'oid-abc',
      matterId: 'm-1',
      reviewId: 'r-1',
      clauseId: 'c-14',
      documentIds: ['d-1', 'd-2'],
      promptSha256: sha256Hex('You are a contract reviewer.\n\n' + CANARY),
      promptChars: ('You are a contract reviewer.\n\n' + CANARY).length,
      imageCount: 2,
      streaming: false,
    });

    expect(sink.records[1]).toEqual({
      kind: 'call.finished',
      callId: 'call-1',
      at: '2026-08-28T16:41:00.000Z',
      status: 200,
      ok: true,
      promptTokens: 1200,
      completionTokens: 300,
      latencyMs: 2410,
      retries: 1,
    });
  });

  // §10: "What it does not log: prompt content and completion content, ever."
  it('NEVER contains prompt or completion content, in any field, in any record', async () => {
    const sink = new Collecting();
    const log = new AuditLogger(sink, () => new Date(), () => 'call-2');
    const callId = await log.start(START);
    await log.finish(callId, {
      status: 500, ok: false, errorCode: 'upstream_failed',
      promptTokens: 0, completionTokens: 0, latencyMs: 40, retries: 3,
      // A completion is deliberately offered to `finish` here to prove it is
      // not carried through even when a caller hands one over.
      completionForRedactionTestOnly: 'The agreement is silent on this point.',
    } as never);

    const serialised = JSON.stringify(sink.records);
    expect(serialised).not.toContain(CANARY);
    expect(serialised).not.toContain('Tenant');
    expect(serialised).not.toContain('You are a contract reviewer');
    expect(serialised).not.toContain('silent on this point');
  });

  it('hashes the prompt so "was this the same prompt?" is answerable without keeping it', async () => {
    const sink = new Collecting();
    const log = new AuditLogger(sink, () => new Date(), () => 'c');
    await log.start(START);
    await log.start({ ...START, user: CANARY });
    await log.start({ ...START, user: `${CANARY} And more.` });
    const [a, b, c] = sink.records.map(r => (r as { promptSha256: string }).promptSha256);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('omits an absent context id rather than writing it as null', async () => {
    const sink = new Collecting();
    const log = new AuditLogger(sink, () => new Date(), () => 'c');
    await log.start({ ...START, context: {} });
    const r = sink.records[0] as Record<string, unknown>;
    expect('matterId' in r).toBe(false);
    expect('documentIds' in r).toBe(false);
  });

  // D3 — the whole point of writing the record first.
  it('REFUSES THE CALL when the started record cannot be written', async () => {
    const log = new AuditLogger(new Failing(), () => new Date(), () => 'c');
    await expect(log.start(START)).rejects.toMatchObject({
      name: 'ModelError', code: 'service_misconfigured', status: 503,
    });
  });

  it('says what went wrong, in words an operator can act on', async () => {
    const log = new AuditLogger(new Failing(), () => new Date(), () => 'c');
    await expect(log.start(START)).rejects.toThrow(/could not be recorded[\s\S]*log pipe closed/);
  });
});

describe('JsonlAuditSink', () => {
  it('writes one JSON object per line', async () => {
    const chunks: string[] = [];
    const stream = new Writable({
      write(chunk, _enc, cb) { chunks.push(String(chunk)); cb(); },
    });
    const sink = new JsonlAuditSink(stream);
    await sink.write({ kind: 'call.finished', callId: 'c', at: 'now', status: 200, ok: true,
      promptTokens: 1, completionTokens: 1, latencyMs: 1, retries: 0 });
    expect(chunks.join('')).toBe(
      '{"kind":"call.finished","callId":"c","at":"now","status":200,"ok":true,'
      + '"promptTokens":1,"completionTokens":1,"latencyMs":1,"retries":0}\n',
    );
  });

  it('REJECTS when the stream errors, rather than resolving over a lost record', async () => {
    const stream = new Writable({
      write(_chunk, _enc, cb) { cb(new Error('EPIPE')); },
    });
    const sink = new JsonlAuditSink(stream);
    await expect(sink.write({ kind: 'call.finished', callId: 'c', at: 'now', status: 200,
      ok: true, promptTokens: 0, completionTokens: 0, latencyMs: 0, retries: 0 }))
      .rejects.toThrow(/EPIPE/);
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `npx vitest run --project gateway apps/gateway/test/audit.test.ts`
Expected: FAIL — `Failed to resolve import "../src/audit.ts"`.

- [ ] **Step 3: Implement `audit.ts`**

```ts
import { createHash, randomUUID } from 'node:crypto';
import type { Writable } from 'node:stream';
import {
  ModelError,
  type InferContext, type Jurisdiction, type ModelErrorCode, type ProviderId, type Purpose,
} from '@lexprompt/core';
import type { CredentialConfig, ModelEntry } from './config.ts';

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export interface AuditStart {
  kind: 'call.started';
  callId: string;
  at: string;
  purpose: Purpose;
  provider: ProviderId;
  model: string;
  modelChoiceId: string;
  jurisdiction: Jurisdiction;
  credentialSource: CredentialConfig['source'];
  workspaceId: string;
  /** Identity is (issuer, subject), never an email and never an
   *  Entra-shaped id (§7, S28). The subject is the value of the issuer's
   *  configured `subjectClaim` — `oid` for Entra, `sub` for Keycloak — and
   *  the two halves are stored separately so Stage 2 can key `app_user` on
   *  the pair without parsing a composite string back apart. */
  actorIssuer: string;
  actorSubject: string;
  matterId?: string;
  reviewId?: string;
  clauseId?: string;
  documentIds?: string[];
  promptSha256: string;
  promptChars: number;
  imageCount: number;
  streaming: boolean;
}

export interface AuditFinish {
  kind: 'call.finished';
  callId: string;
  at: string;
  status: number;
  ok: boolean;
  errorCode?: ModelErrorCode;
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
  retries: number;
}

export type AuditRecord = AuditStart | AuditFinish;

export interface AuditSink {
  write(record: AuditRecord): Promise<void>;
}

/**
 * One JSON object per line, to a stream — stdout in a container, collected
 * by Azure Monitor or by `docker logs` locally. The write is AWAITED and a
 * stream error REJECTS, which is what makes D3's fail-closed behaviour real
 * rather than aspirational: a fire-and-forget log write cannot fail closed.
 */
export class JsonlAuditSink implements AuditSink {
  #stream: Writable;
  constructor(stream: Writable) { this.#stream = stream; }

  write(record: AuditRecord): Promise<void> {
    return new Promise((resolve, reject) => {
      this.#stream.write(`${JSON.stringify(record)}\n`, err => (err ? reject(err) : resolve()));
    });
  }
}

export interface AuditStartInput {
  purpose: Purpose;
  entry: ModelEntry;
  workspaceId: string;
  actorIssuer: string;
  actorSubject: string;
  context: InferContext;
  system?: string;
  user: string;
  imageCount: number;
  streaming: boolean;
}

export interface AuditFinishInput {
  status: number;
  ok: boolean;
  errorCode?: ModelErrorCode;
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
  retries: number;
}

/**
 * D3: the started record is written BEFORE the upstream call and its
 * failure refuses the call.
 *
 * "It writes an audit record per call" cannot be satisfied by logging
 * afterwards — a process that died mid-call would then have made an
 * unlogged egress, which is the one thing this component exists to make
 * impossible. Two records also make an egress that started and never
 * finished visible, which answers "what of ours went where" better than a
 * post-hoc record could.
 *
 * `finish` deliberately does NOT throw: by the time it runs the call has
 * happened, and refusing to return an answer the model already produced
 * would lose work without preventing anything. It is logged to stderr and
 * the response carries `callId` so support can find the started record and
 * see the gap.
 */
export class AuditLogger {
  #sink: AuditSink;
  #now: () => Date;
  #newId: () => string;

  constructor(sink: AuditSink, now: () => Date = () => new Date(), newId: () => string = randomUUID) {
    this.#sink = sink;
    this.#now = now;
    this.#newId = newId;
  }

  async start(input: AuditStartInput): Promise<string> {
    const callId = this.#newId();
    // The hashed text is exactly what is sent, so "was this the same
    // prompt?" is answerable in support without keeping the prompt.
    const prompt = input.system ? `${input.system}\n\n${input.user}` : input.user;
    const record: AuditStart = {
      kind: 'call.started',
      callId,
      at: this.#now().toISOString(),
      purpose: input.purpose,
      provider: input.entry.provider,
      model: input.entry.model,
      modelChoiceId: input.entry.id,
      jurisdiction: input.entry.jurisdiction,
      credentialSource: input.entry.credential.source,
      workspaceId: input.workspaceId,
      actorIssuer: input.actorIssuer,
      actorSubject: input.actorSubject,
      ...(input.context.matterId ? { matterId: input.context.matterId } : {}),
      ...(input.context.reviewId ? { reviewId: input.context.reviewId } : {}),
      ...(input.context.clauseId ? { clauseId: input.context.clauseId } : {}),
      ...(input.context.documentIds?.length ? { documentIds: input.context.documentIds } : {}),
      promptSha256: sha256Hex(prompt),
      promptChars: prompt.length,
      imageCount: input.imageCount,
      streaming: input.streaming,
    };

    try {
      await this.#sink.write(record);
    } catch (err) {
      throw new ModelError(
        'This request could not be recorded in the call log, so it was not made. '
        + `LexPrompt does not send anything to a model it cannot log. (${(err as Error).message})`,
        'service_misconfigured',
        503,
        callId,
      );
    }
    return callId;
  }

  async finish(callId: string, outcome: AuditFinishInput): Promise<void> {
    const record: AuditFinish = {
      kind: 'call.finished',
      callId,
      at: this.#now().toISOString(),
      status: outcome.status,
      ok: outcome.ok,
      ...(outcome.errorCode ? { errorCode: outcome.errorCode } : {}),
      promptTokens: outcome.promptTokens,
      completionTokens: outcome.completionTokens,
      latencyMs: outcome.latencyMs,
      retries: outcome.retries,
    };
    try {
      await this.#sink.write(record);
    } catch (err) {
      process.stderr.write(
        `AUDIT WRITE FAILED for call ${callId}: ${(err as Error).message}\n`,
      );
    }
  }
}
```

**Note on the redaction test's `completionForRedactionTestOnly` field:** `finish` builds its record from named fields, so an extra property on the input object is dropped by construction. That is the property the test proves, and it is why the record is built field by field rather than spread. Never change `finish` to `{ ...outcome }`.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run --project gateway apps/gateway/test/audit.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Mutation test D3 — three mutations**

1. **Fail-open on a log failure.** Wrap `await this.#sink.write(record)` in `try { … } catch { /* ignore */ }` and return the call id. Run. Expected: FAIL on *"REFUSES THE CALL when the started record cannot be written"* and *"says what went wrong"*. Restore.
2. **Redaction.** Add `user: input.user` to the `AuditStart` record. Run. Expected: FAIL on *"NEVER contains prompt or completion content"*. Restore.
3. **Spread in `finish`.** Replace the named fields with `...outcome`. Run. Expected: FAIL on *"NEVER contains prompt or completion content"* (the `completionForRedactionTestOnly` value appears) and on *"records every field §10 names"* (the record gains keys). Restore.

- [ ] **Step 6: Commit**

```bash
git add apps/gateway/src/audit.ts apps/gateway/test/audit.test.ts
git commit -F .git/COMMIT_MSG_TASK6
```

```
feat(gateway): the call log — written before the call, refusing it on failure

D3: a started record is written and awaited before the upstream request is
issued, and a sink failure refuses the call with 503. "Writes a record per
call" cannot be satisfied by logging afterwards — a process that dies
mid-call would have made an unlogged egress, which is the one thing this
component exists to prevent. It holds identically in local development.

Records carry provider, jurisdiction and the actor as (issuer, subject) —
never an email and never an Entra-shaped id (§7) — as well as §10's fields,
and never carry prompt or completion content: both start and finish build their
records from named fields, so a caller handing over a completion cannot get
it into the log.

Mutation-tested three ways: fail-open on a log failure (2 tests fail), the
prompt added to the record (1), finish rewritten as a spread (2). Restored.
```

---

## Task 7: Credential resolution — four sources, no fallback between them

**Type:** application code

**Files:**
- Create: `apps/gateway/src/credentials/types.ts`, `managedIdentity.ts`, `keyVault.ts`, `envOrFile.ts`, `resolve.ts`
- Create: `apps/gateway/test/credentials.test.ts`

**Interfaces:**
- Consumes: `CredentialConfig` (Task 4); `ModelError` (Task 2).
- Produces:
  - `type ResolvedCredential = { kind: 'bearer'; token: string } | { kind: 'api-key'; key: string }`
  - `interface CredentialResolver { resolve(config: CredentialConfig): Promise<ResolvedCredential> }`
  - `class DefaultCredentialResolver implements CredentialResolver` — constructed with `{ getToken, getSecret, readEnv, readFile, now }`, all injectable so every path is testable with no Azure and no filesystem
  - `redactCredential(text: string, credential: ResolvedCredential): string`

- [ ] **Step 1: Write the failing test**

`apps/gateway/test/credentials.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { DefaultCredentialResolver, redactCredential } from '../src/credentials/resolve.ts';

const deps = (over: Partial<ConstructorParameters<typeof DefaultCredentialResolver>[0]> = {}) =>
  new DefaultCredentialResolver({
    getToken: async () => ({ token: 'mi-token', expiresOnTimestamp: Date.now() + 3_600_000 }),
    getSecret: async () => 'vault-key',
    readEnv: (name: string) => (name === 'OPENAI_API_KEY' ? 'env-key' : undefined),
    readFile: (p: string) => (p === '/run/secrets/k' ? 'file-key\n' : (() => { throw new Error('ENOENT'); })()),
    now: () => Date.now(),
    ...over,
  });

describe('credential resolution (S2, as revised)', () => {
  it('managed identity yields a bearer token', async () => {
    expect(await deps().resolve({ source: 'managed-identity', scope: 'https://cognitiveservices.azure.com/.default' }))
      .toEqual({ kind: 'bearer', token: 'mi-token' });
  });

  it('key vault yields an api key', async () => {
    expect(await deps().resolve({ source: 'key-vault', vaultUrl: 'https://kv.vault.azure.net', secretName: 's' }))
      .toEqual({ kind: 'api-key', key: 'vault-key' });
  });

  it('env yields an api key', async () => {
    expect(await deps().resolve({ source: 'env', var: 'OPENAI_API_KEY' }))
      .toEqual({ kind: 'api-key', key: 'env-key' });
  });

  it('file yields an api key with trailing whitespace trimmed', async () => {
    expect(await deps().resolve({ source: 'file', path: '/run/secrets/k' }))
      .toEqual({ kind: 'api-key', key: 'file-key' });
  });

  it('caches a managed-identity token and reuses it inside its lifetime', async () => {
    const getToken = vi.fn(async () => ({ token: 't', expiresOnTimestamp: Date.now() + 3_600_000 }));
    const r = deps({ getToken });
    const c = { source: 'managed-identity' as const, scope: 's' };
    await r.resolve(c); await r.resolve(c);
    expect(getToken).toHaveBeenCalledTimes(1);
  });

  it('re-acquires a managed-identity token inside the expiry margin', async () => {
    let clock = 1_000_000;
    const getToken = vi.fn(async () => ({ token: 't', expiresOnTimestamp: clock + 60_000 }));
    const r = deps({ getToken, now: () => clock });
    const c = { source: 'managed-identity' as const, scope: 's' };
    await r.resolve(c);
    clock += 30_000;                       // 30s left, inside the 120s margin
    await r.resolve(c);
    expect(getToken).toHaveBeenCalledTimes(2);
  });

  // THE rule. §10: "never a fallback to an unauthenticated or
  // differently-authenticated call".
  it('a managed-identity failure is a loud 503 and NEVER falls back to a key', async () => {
    const r = deps({
      getToken: async () => { throw new Error('ManagedIdentityCredential: no identity endpoint'); },
      readEnv: () => 'a-key-that-must-not-be-used',
    });
    await expect(r.resolve({ source: 'managed-identity', scope: 's' })).rejects.toMatchObject({
      name: 'ModelError', code: 'service_misconfigured', status: 503,
    });
  });

  it('a key-vault failure is a loud 503 and NEVER falls back to env', async () => {
    const r = deps({
      getSecret: async () => { throw new Error('Forbidden'); },
      readEnv: () => 'a-key-that-must-not-be-used',
    });
    await expect(r.resolve({ source: 'key-vault', vaultUrl: 'v', secretName: 's' }))
      .rejects.toMatchObject({ code: 'service_misconfigured', status: 503 });
  });

  it('a missing env var is a loud 503, not an empty key sent as a credential', async () => {
    await expect(deps().resolve({ source: 'env', var: 'NOT_SET' }))
      .rejects.toMatchObject({ code: 'service_misconfigured', status: 503 });
  });

  it('an empty env var is a loud 503, because an empty credential is not a credential', async () => {
    const r = deps({ readEnv: () => '   ' });
    await expect(r.resolve({ source: 'env', var: 'OPENAI_API_KEY' }))
      .rejects.toMatchObject({ code: 'service_misconfigured', status: 503 });
  });

  it('names WHICH source failed and WHAT to fix, without quoting any secret', async () => {
    const r = deps({ getSecret: async () => { throw new Error('Forbidden by RBAC'); } });
    await expect(r.resolve({ source: 'key-vault', vaultUrl: 'https://kv.vault.azure.net', secretName: 'prod-model-key' }))
      .rejects.toThrow(/key-vault[\s\S]*https:\/\/kv\.vault\.azure\.net[\s\S]*prod-model-key[\s\S]*Forbidden by RBAC/);
  });
});

describe('redactCredential', () => {
  it('replaces a key wherever it appears in text bound for a log or an error', () => {
    expect(redactCredential('Bearer sk-abc123 rejected', { kind: 'api-key', key: 'sk-abc123' }))
      .toBe('Bearer [redacted] rejected');
  });

  it('replaces a bearer token too', () => {
    expect(redactCredential('token eyJhbG bad', { kind: 'bearer', token: 'eyJhbG' }))
      .toBe('token [redacted] bad');
  });

  it('leaves text alone when the credential does not appear in it', () => {
    expect(redactCredential('rate limit exceeded', { kind: 'api-key', key: 'sk-abc' }))
      .toBe('rate limit exceeded');
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `npx vitest run --project gateway apps/gateway/test/credentials.test.ts`
Expected: FAIL — `Failed to resolve import "../src/credentials/resolve.ts"`.

- [ ] **Step 3: Implement `credentials/types.ts`**

```ts
import type { CredentialConfig } from '../config.ts';

export type ResolvedCredential =
  | { kind: 'bearer'; token: string }
  | { kind: 'api-key'; key: string };

export interface CredentialResolver {
  resolve(config: CredentialConfig): Promise<ResolvedCredential>;
}
```

- [ ] **Step 4: Implement `credentials/resolve.ts`**

```ts
import { ModelError } from '@lexprompt/core';
import type { CredentialConfig } from '../config.ts';
import type { CredentialResolver, ResolvedCredential } from './types.ts';

export interface CredentialDeps {
  /** `DefaultAzureCredential.getToken(scope)` in production; injected here
   *  so every branch below is testable with no Azure and no network. */
  getToken(scope: string): Promise<{ token: string; expiresOnTimestamp: number }>;
  getSecret(vaultUrl: string, secretName: string): Promise<string>;
  readEnv(name: string): string | undefined;
  readFile(path: string): string;
  now(): number;
}

/** Re-acquire a token this long before it expires, so a call never starts
 *  with a token that expires mid-flight. */
const EXPIRY_MARGIN_MS = 120_000;

function fail(source: string, detail: string, err: unknown): never {
  throw new ModelError(
    `LexPrompt could not obtain the credential for this model (${source}: ${detail}). `
    + 'This is a configuration problem in the firm\'s deployment, not something you can fix here. '
    + `(${err instanceof Error ? err.message : String(err)})`,
    'service_misconfigured',
    503,
  );
}

/**
 * Resolves the one credential a model entry declares — and ONLY that one.
 *
 * §10's rule, restated for five providers: a credential failure is a loud
 * 503 naming the failure, never a fallback to an unauthenticated call, to a
 * different credential source, or to a different provider. All three are
 * shapes of "answer quietly wrong", and the second is the one that would
 * actually get written by someone being helpful: "managed identity is
 * unavailable locally, so read the env var instead" is a two-line change
 * that turns a deployed gateway's Entra failure into a silent switch to
 * whatever key happens to be in its environment.
 *
 * So: one `switch`, no `catch` that reaches another branch, and a test for
 * each failure that supplies a working alternative and asserts it is NOT
 * used.
 */
export class DefaultCredentialResolver implements CredentialResolver {
  #deps: CredentialDeps;
  #tokens = new Map<string, { token: string; expiresOnTimestamp: number }>();
  #secrets = new Map<string, string>();

  constructor(deps: CredentialDeps) { this.#deps = deps; }

  async resolve(config: CredentialConfig): Promise<ResolvedCredential> {
    switch (config.source) {
      case 'managed-identity': {
        const cached = this.#tokens.get(config.scope);
        if (cached && cached.expiresOnTimestamp - this.#deps.now() > EXPIRY_MARGIN_MS) {
          return { kind: 'bearer', token: cached.token };
        }
        try {
          const fresh = await this.#deps.getToken(config.scope);
          this.#tokens.set(config.scope, fresh);
          return { kind: 'bearer', token: fresh.token };
        } catch (err) {
          fail('managed-identity', config.scope, err);
        }
      }
      case 'key-vault': {
        const key = `${config.vaultUrl}#${config.secretName}`;
        const cached = this.#secrets.get(key);
        if (cached) return { kind: 'api-key', key: cached };
        try {
          const secret = (await this.#deps.getSecret(config.vaultUrl, config.secretName)).trim();
          if (!secret) fail('key-vault', key, new Error('the secret is empty'));
          this.#secrets.set(key, secret);
          return { kind: 'api-key', key: secret };
        } catch (err) {
          if (err instanceof ModelError) throw err;
          fail('key-vault', key, err);
        }
      }
      case 'env': {
        const value = (this.#deps.readEnv(config.var) ?? '').trim();
        if (!value) fail('env', config.var, new Error('the variable is unset or empty'));
        return { kind: 'api-key', key: value };
      }
      case 'file': {
        try {
          const value = this.#deps.readFile(config.path).trim();
          if (!value) fail('file', config.path, new Error('the file is empty'));
          return { kind: 'api-key', key: value };
        } catch (err) {
          if (err instanceof ModelError) throw err;
          fail('file', config.path, err);
        }
      }
    }
  }
}

/**
 * Removes a credential from any text about to be logged or returned.
 *
 * Providers put the offending key into their own error bodies more often
 * than you would hope, and this gateway's whole discipline is that no
 * credential leaves it. Applied at the one place a provider's error body
 * becomes a message (Task 11's `callModel`).
 */
export function redactCredential(text: string, credential: ResolvedCredential): string {
  const secret = credential.kind === 'bearer' ? credential.token : credential.key;
  if (!secret) return text;
  return text.split(secret).join('[redacted]');
}
```

- [ ] **Step 5: Implement the three thin adapters onto Azure's SDKs**

`apps/gateway/src/credentials/managedIdentity.ts`:

```ts
import { DefaultAzureCredential } from '@azure/identity';

/**
 * `DefaultAzureCredential` covers both deployment postures with no code
 * difference: a managed identity in Container Apps, and a developer's own
 * `az login` locally. That is why local development against a real Azure
 * model needs no key either — S2's stronger property survives development,
 * not only deployment.
 */
export function makeGetToken(): (scope: string) => Promise<{ token: string; expiresOnTimestamp: number }> {
  const credential = new DefaultAzureCredential();
  return async (scope: string) => {
    const token = await credential.getToken(scope);
    if (!token) throw new Error(`No token was returned for scope ${scope}.`);
    return { token: token.token, expiresOnTimestamp: token.expiresOnTimestamp };
  };
}
```

`apps/gateway/src/credentials/keyVault.ts`:

```ts
import { DefaultAzureCredential } from '@azure/identity';
import { SecretClient } from '@azure/keyvault-secrets';

export function makeGetSecret(): (vaultUrl: string, name: string) => Promise<string> {
  const credential = new DefaultAzureCredential();
  const clients = new Map<string, SecretClient>();
  return async (vaultUrl: string, name: string) => {
    let client = clients.get(vaultUrl);
    if (!client) {
      client = new SecretClient(vaultUrl, credential);
      clients.set(vaultUrl, client);
    }
    const secret = await client.getSecret(name);
    if (!secret.value) throw new Error(`Secret ${name} has no value.`);
    return secret.value;
  };
}
```

`apps/gateway/src/credentials/envOrFile.ts`:

```ts
import { readFileSync } from 'node:fs';

export const readEnv = (name: string): string | undefined => process.env[name];
export const readSecretFile = (path: string): string => readFileSync(path, 'utf8');
```

- [ ] **Step 6: Run the tests**

Run: `npx vitest run --project gateway apps/gateway/test/credentials.test.ts`
Expected: PASS, 14 tests.

- [ ] **Step 7: Mutation test the no-fallback rule**

In `resolve`'s `managed-identity` branch, replace `fail('managed-identity', config.scope, err)` with:

```ts
          const fallback = (this.#deps.readEnv('OPENAI_API_KEY') ?? '').trim();
          if (fallback) return { kind: 'api-key', key: fallback };
          fail('managed-identity', config.scope, err);
```

Run the test. Expected: FAIL on *"a managed-identity failure is a loud 503 and NEVER falls back to a key"*. Restore.

This is the exact code a helpful engineer writes to "make local development easier", and it is why the test supplies a working fallback and asserts it is not taken.

- [ ] **Step 8: Commit**

```bash
git add apps/gateway/src/credentials apps/gateway/test/credentials.test.ts
git commit -F .git/COMMIT_MSG_TASK7
```

```
feat(gateway): four credential sources, and no fallback between them

Managed identity, Key Vault, env, file. Which one is per allowlist entry,
so a UK Foundry model authenticating by managed identity and a US model
authenticating by a vaulted key coexist without either weakening the other.

A credential failure is a loud 503 naming the source and what to fix, and
never a fallback to an unauthenticated call, a different source or a
different provider. The tests supply a WORKING alternative and assert it is
not taken, because "managed identity is unavailable locally, so read the
env var instead" is a two-line change that turns a deployed gateway's Entra
failure into a silent switch to whatever key is in its environment.

redactCredential exists because providers put keys in their own error
bodies. Mutation-tested: an env fallback added to the managed-identity
branch, one test fails; restored.
```

---

## Task 8: The adapter interface, the OpenAI-compatible base, and four of the five providers

**Type:** application code

**Files:**
- Create: `apps/gateway/src/adapters/types.ts`, `openaiCompatible.ts`, `azureFoundry.ts`, `azureOpenai.ts`, `openai.ts`, `openrouter.ts`, `registry.ts`
- Create: `apps/gateway/test/openaiCompatible.test.ts`

**Interfaces:**
- Consumes: `ModelEntry` (Task 4); `ResolvedCredential` (Task 7); `sseFields`, `InferUsage`, `ProviderId` (Tasks 2–3).
- Produces:
  - `interface AdapterRequest { entry: ModelEntry; system?: string; user: string; images?: { mime: string; data: string }[]; jsonSchema?: object; temperature?: number; maxTokens: number; stream: boolean }`
  - `type AdapterEvent = { kind: 'delta'; text: string } | { kind: 'usage'; usage: InferUsage } | { kind: 'end' } | { kind: 'error'; status: number; message: string }`
  - `interface AdapterCall { url: string; headers: Record<string, string>; body: unknown }`
  - `interface ProviderAdapter { readonly id: ProviderId; buildCall(req: AdapterRequest, credential: ResolvedCredential): AdapterCall; readResponse(body: unknown): { content: string; usage: InferUsage }; decodeEvent(rawEvent: string): AdapterEvent | null }`
  - `getAdapter(id: ProviderId): ProviderAdapter` and `ALL_ADAPTERS: readonly ProviderAdapter[]` from `registry.ts`

**Why the adapter is three pure functions and no IO.** `buildCall` returns a description of a request rather than making one; `readResponse` and `decodeEvent` are pure. The single place that opens a socket, retries, times out and aborts is `callModel.ts` (Task 11). That is what keeps §10's retry policy enforced once rather than five times, and it is what makes every adapter testable offline.

- [ ] **Step 1: Write the failing test**

`apps/gateway/test/openaiCompatible.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { getAdapter, ALL_ADAPTERS } from '../src/adapters/registry.ts';
import { PROVIDER_IDS } from '@lexprompt/core';
import type { ModelEntry } from '../src/config.ts';
import type { AdapterRequest } from '../src/adapters/types.ts';

const entry = (over: Partial<ModelEntry>): ModelEntry => ({
  id: 'e', provider: 'openai', model: 'gpt-4o', label: 'l',
  jurisdiction: { bloc: 'US', region: 'us', label: 'United States' },
  contextLength: 128000, supportsImages: true, supportsStructuredOutput: true, isDefault: true,
  endpoint: 'https://api.openai.com',
  credential: { source: 'env', var: 'K' },
  ...over,
});

const req = (over: Partial<AdapterRequest> = {}): AdapterRequest => ({
  entry: entry({}),
  system: 'You are a contract reviewer.',
  user: 'Summarise clause 14.',
  maxTokens: 4096,
  stream: false,
  ...over,
});

describe('the registry', () => {
  it('has an adapter for every provider id, so a new id cannot ship unimplemented', () => {
    expect(ALL_ADAPTERS.map(a => a.id).sort()).toEqual([...PROVIDER_IDS].sort());
  });

  it('throws for an id with no adapter rather than returning undefined', () => {
    expect(() => getAdapter('bedrock' as never)).toThrow(/bedrock/);
  });
});

describe('OpenAI-compatible adapters — one body builder, four endpoints', () => {
  it('OpenAI direct: /v1/chat/completions with a bearer key', () => {
    const call = getAdapter('openai').buildCall(req(), { kind: 'api-key', key: 'sk-1' });
    expect(call.url).toBe('https://api.openai.com/v1/chat/completions');
    expect(call.headers.Authorization).toBe('Bearer sk-1');
    expect(call.body).toMatchObject({
      model: 'gpt-4o',
      max_tokens: 4096,
      messages: [
        { role: 'system', content: 'You are a contract reviewer.' },
        { role: 'user', content: 'Summarise clause 14.' },
      ],
    });
  });

  it('OpenRouter: its own base, a bearer key, and the two identifying headers', () => {
    const e = entry({ provider: 'openrouter', endpoint: 'https://openrouter.ai/api', model: 'anthropic/claude-sonnet-4.5' });
    const call = getAdapter('openrouter').buildCall(req({ entry: e }), { kind: 'api-key', key: 'or-1' });
    expect(call.url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(call.headers.Authorization).toBe('Bearer or-1');
    expect(call.headers['X-Title']).toBe('LexPrompt');
    expect((call.body as { model: string }).model).toBe('anthropic/claude-sonnet-4.5');
  });

  it('Azure OpenAI: the deployment path, api-version, and an api-key HEADER not a bearer', () => {
    const e = entry({
      provider: 'azure-openai', endpoint: 'https://firm.openai.azure.com',
      model: 'gpt4o-uks', apiVersion: '2024-10-21',
      jurisdiction: { bloc: 'UK', region: 'uksouth', label: 'UK South' },
    });
    const call = getAdapter('azure-openai').buildCall(req({ entry: e }), { kind: 'api-key', key: 'az-1' });
    expect(call.url).toBe('https://firm.openai.azure.com/openai/deployments/gpt4o-uks/chat/completions?api-version=2024-10-21');
    expect(call.headers['api-key']).toBe('az-1');
    expect('Authorization' in call.headers).toBe(false);
  });

  it('Azure OpenAI with a managed identity uses a bearer token and NO api-key header', () => {
    const e = entry({ provider: 'azure-openai', endpoint: 'https://firm.openai.azure.com', model: 'd', apiVersion: '2024-10-21' });
    const call = getAdapter('azure-openai').buildCall(req({ entry: e }), { kind: 'bearer', token: 'mi' });
    expect(call.headers.Authorization).toBe('Bearer mi');
    expect('api-key' in call.headers).toBe(false);
  });

  it('Azure Foundry: /models/chat/completions with api-version', () => {
    const e = entry({
      provider: 'azure-foundry', endpoint: 'https://firm.services.ai.azure.com',
      model: 'gpt-4o', apiVersion: '2024-05-01-preview',
    });
    const call = getAdapter('azure-foundry').buildCall(req({ entry: e }), { kind: 'bearer', token: 'mi' });
    expect(call.url).toBe('https://firm.services.ai.azure.com/models/chat/completions?api-version=2024-05-01-preview');
    expect(call.headers.Authorization).toBe('Bearer mi');
  });

  it('trims a trailing slash off the configured endpoint rather than producing a double slash', () => {
    const call = getAdapter('openai').buildCall(
      req({ entry: entry({ endpoint: 'https://api.openai.com/' }) }), { kind: 'api-key', key: 'k' });
    expect(call.url).toBe('https://api.openai.com/v1/chat/completions');
  });

  it('omits the system message when there is none, rather than sending an empty one', () => {
    const call = getAdapter('openai').buildCall(req({ system: undefined }), { kind: 'api-key', key: 'k' });
    expect((call.body as { messages: unknown[] }).messages).toHaveLength(1);
  });

  it('attaches images as image_url content parts', () => {
    const call = getAdapter('openai').buildCall(
      req({ images: [{ mime: 'image/png', data: 'AAA' }] }), { kind: 'api-key', key: 'k' });
    const messages = (call.body as { messages: { role: string; content: unknown }[] }).messages;
    expect(messages[1].content).toEqual([
      { type: 'text', text: 'Summarise clause 14.' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } },
    ]);
  });

  it('sends a strict json_schema response format when a schema is supplied', () => {
    const call = getAdapter('openai').buildCall(
      req({ jsonSchema: { type: 'object', properties: {} } }), { kind: 'api-key', key: 'k' });
    expect((call.body as { response_format: unknown }).response_format).toEqual({
      type: 'json_schema',
      json_schema: { name: 'result', strict: true, schema: { type: 'object', properties: {} } },
    });
  });

  it('sets stream and stream_options so usage arrives on a streamed call', () => {
    const call = getAdapter('openai').buildCall(req({ stream: true }), { kind: 'api-key', key: 'k' });
    expect(call.body).toMatchObject({ stream: true, stream_options: { include_usage: true } });
  });

  it('omits temperature when the caller did not set one', () => {
    const body = getAdapter('openai').buildCall(req(), { kind: 'api-key', key: 'k' }).body as Record<string, unknown>;
    expect('temperature' in body).toBe(false);
  });
});

describe('OpenAI-compatible readResponse', () => {
  const a = getAdapter('openai');

  it('reads content and usage', () => {
    expect(a.readResponse({
      choices: [{ message: { content: 'Answer.' } }],
      usage: { prompt_tokens: 10, completion_tokens: 4 },
    })).toEqual({ content: 'Answer.', usage: { promptTokens: 10, completionTokens: 4 } });
  });

  it('reports zero usage rather than NaN when a provider omits it', () => {
    expect(a.readResponse({ choices: [{ message: { content: 'x' } }] }).usage)
      .toEqual({ promptTokens: 0, completionTokens: 0 });
  });

  it('THROWS when there is no message content, rather than returning an empty answer', () => {
    expect(() => a.readResponse({ choices: [] })).toThrow(/no message content/i);
    expect(() => a.readResponse({ choices: [{ message: {} }] })).toThrow(/no message content/i);
  });
});

describe('OpenAI-compatible decodeEvent (pure, no network)', () => {
  const a = getAdapter('openai');

  it('reads a content delta', () => {
    expect(a.decodeEvent('data: {"choices":[{"delta":{"content":"Hi"}}]}'))
      .toEqual({ kind: 'delta', text: 'Hi' });
  });

  it('reads a usage-only chunk', () => {
    expect(a.decodeEvent('data: {"choices":[],"usage":{"prompt_tokens":9,"completion_tokens":2}}'))
      .toEqual({ kind: 'usage', usage: { promptTokens: 9, completionTokens: 2 } });
  });

  it('reads the [DONE] sentinel as the end of the stream', () => {
    expect(a.decodeEvent('data: [DONE]')).toEqual({ kind: 'end' });
  });

  it('reads a mid-stream error object as an error, not as content', () => {
    expect(a.decodeEvent('data: {"error":{"message":"upstream exploded","code":500}}'))
      .toEqual({ kind: 'error', status: 500, message: 'upstream exploded' });
  });

  it('returns null for a keepalive, an empty delta and malformed JSON', () => {
    expect(a.decodeEvent(': ping')).toBe(null);
    expect(a.decodeEvent('data: {"choices":[{"delta":{}}]}')).toBe(null);
    expect(a.decodeEvent('data: {not json')).toBe(null);
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `npx vitest run --project gateway apps/gateway/test/openaiCompatible.test.ts`
Expected: FAIL — `Failed to resolve import "../src/adapters/registry.ts"`.

- [ ] **Step 3: Implement `adapters/types.ts`**

```ts
import type { InferUsage, ProviderId } from '@lexprompt/core';
import type { ModelEntry } from '../config.ts';
import type { ResolvedCredential } from '../credentials/types.ts';

export interface AdapterRequest {
  entry: ModelEntry;
  system?: string;
  user: string;
  images?: { mime: string; data: string }[];
  jsonSchema?: object;
  temperature?: number;
  maxTokens: number;
  stream: boolean;
}

/** One decoded provider stream event. `end` means the provider said the
 *  stream is complete — the gateway emits its `done` frame only after
 *  seeing one, which is D2's rule at the upstream edge. */
export type AdapterEvent =
  | { kind: 'delta'; text: string }
  | { kind: 'usage'; usage: InferUsage }
  | { kind: 'end' }
  | { kind: 'error'; status: number; message: string };

export interface AdapterCall {
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

/**
 * A provider backend, as three PURE functions and no IO.
 *
 * `buildCall` describes a request rather than making one; `readResponse`
 * and `decodeEvent` are pure. The one place that opens a socket, retries,
 * times out and aborts is `callModel.ts` — which is what keeps §10's retry
 * policy enforced once rather than five times, and what makes every
 * adapter testable with no network at all (D5).
 *
 * Adding a sixth provider: write one of these, add it to `registry.ts`, add
 * a stream fixture. Nothing else in the codebase changes.
 */
export interface ProviderAdapter {
  readonly id: ProviderId;
  buildCall(req: AdapterRequest, credential: ResolvedCredential): AdapterCall;
  readResponse(body: unknown): { content: string; usage: InferUsage };
  decodeEvent(rawEvent: string): AdapterEvent | null;
}
```

- [ ] **Step 4: Implement `adapters/openaiCompatible.ts`**

```ts
import { sseFields, type InferUsage, type ProviderId } from '@lexprompt/core';
import type { ResolvedCredential } from '../credentials/types.ts';
import type { AdapterCall, AdapterEvent, AdapterRequest, ProviderAdapter } from './types.ts';

const trimSlash = (s: string): string => s.replace(/\/+$/, '');

/**
 * Four of the five providers speak OpenAI's chat-completions shape. They
 * differ ONLY in the URL they are reached at and the header the credential
 * goes in, so those two are parameters and everything else is written once.
 *
 * This is the extraction S14 asks for, made at the first duplication rather
 * than the third: writing `azureOpenai.ts` by copying `openai.ts` and
 * editing the URL is how the image-attachment shape, the strict-schema
 * flag and the `[DONE]` handling end up subtly different in four files that
 * nobody reads side by side.
 */
export function openAiCompatible(options: {
  id: ProviderId;
  url(entry: AdapterRequest['entry']): string;
  headers(entry: AdapterRequest['entry'], credential: ResolvedCredential): Record<string, string>;
}): ProviderAdapter {
  return {
    id: options.id,

    buildCall(req: AdapterRequest, credential: ResolvedCredential): AdapterCall {
      const messages: unknown[] = [];
      if (req.system) messages.push({ role: 'system', content: req.system });

      const content = req.images?.length
        ? [
            { type: 'text', text: req.user },
            ...req.images.map(img => ({
              type: 'image_url',
              image_url: { url: `data:${img.mime};base64,${img.data}` },
            })),
          ]
        : req.user;
      messages.push({ role: 'user', content });

      return {
        url: options.url(req.entry),
        headers: { 'Content-Type': 'application/json', ...options.headers(req.entry, credential) },
        body: {
          model: req.entry.model,
          messages,
          max_tokens: req.maxTokens,
          ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
          ...(req.jsonSchema
            ? {
                response_format: {
                  type: 'json_schema',
                  json_schema: { name: 'result', strict: true, schema: req.jsonSchema },
                },
              }
            : {}),
          ...(req.stream ? { stream: true, stream_options: { include_usage: true } } : {}),
        },
      };
    },

    readResponse(body: unknown): { content: string; usage: InferUsage } {
      const b = body as {
        choices?: { message?: { content?: unknown } }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      const content = b?.choices?.[0]?.message?.content;
      if (typeof content !== 'string') {
        // Not an empty answer. A response with no message content is a
        // failed call wearing a 200, and returning '' from here would put
        // "the agreement is silent on this point" in a finding.
        throw new Error('The provider returned no message content.');
      }
      return {
        content,
        usage: {
          promptTokens: Number(b?.usage?.prompt_tokens ?? 0),
          completionTokens: Number(b?.usage?.completion_tokens ?? 0),
        },
      };
    },

    decodeEvent(rawEvent: string): AdapterEvent | null {
      const { data } = sseFields(rawEvent);
      if (!data) return null;
      if (data === '[DONE]') return { kind: 'end' };
      let parsed: {
        choices?: { delta?: { content?: unknown } }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number };
        error?: { message?: string; code?: unknown };
      };
      try {
        parsed = JSON.parse(data);
      } catch {
        return null;   // a malformed event is skipped, never fails the stream
      }
      if (parsed.error) {
        const status = Number(parsed.error.code);
        return {
          kind: 'error',
          status: Number.isFinite(status) && status >= 400 ? status : 502,
          message: parsed.error.message ?? 'The provider reported an error mid-stream.',
        };
      }
      const delta = parsed.choices?.[0]?.delta?.content;
      if (typeof delta === 'string' && delta) return { kind: 'delta', text: delta };
      if (parsed.usage) {
        return {
          kind: 'usage',
          usage: {
            promptTokens: Number(parsed.usage.prompt_tokens ?? 0),
            completionTokens: Number(parsed.usage.completion_tokens ?? 0),
          },
        };
      }
      return null;
    },
  };
}

export { trimSlash };
```

- [ ] **Step 5: Implement the four thin adapters**

`apps/gateway/src/adapters/openai.ts`:

```ts
import { openAiCompatible, trimSlash } from './openaiCompatible.ts';

export const openaiAdapter = openAiCompatible({
  id: 'openai',
  url: entry => `${trimSlash(entry.endpoint)}/v1/chat/completions`,
  headers: (_entry, credential) => ({
    Authorization: `Bearer ${credential.kind === 'bearer' ? credential.token : credential.key}`,
  }),
});
```

`apps/gateway/src/adapters/openrouter.ts`:

```ts
import { openAiCompatible, trimSlash } from './openaiCompatible.ts';

/**
 * OpenRouter returns as ONE configurable backend among five, rather than as
 * the app's only route to a model. Its two identifying headers are kept
 * from `openrouter.ts` because OpenRouter uses them for attribution; the
 * referer is the gateway's own configured origin, never a browser's, since
 * no browser is anywhere near this call.
 */
export const openrouterAdapter = openAiCompatible({
  id: 'openrouter',
  url: entry => `${trimSlash(entry.endpoint)}/v1/chat/completions`,
  headers: (_entry, credential) => ({
    Authorization: `Bearer ${credential.kind === 'bearer' ? credential.token : credential.key}`,
    'HTTP-Referer': process.env.GATEWAY_PUBLIC_ORIGIN ?? 'https://lexprompt.local',
    'X-Title': 'LexPrompt',
  }),
});
```

`apps/gateway/src/adapters/azureOpenai.ts`:

```ts
import { openAiCompatible, trimSlash } from './openaiCompatible.ts';

/**
 * Azure OpenAI takes the deployment name in the PATH and the model field is
 * ignored, and it accepts either an `api-key` header or an Entra bearer
 * token. Which one is decided by the resolved credential's kind — so an
 * operator moves from a vaulted key to a managed identity by editing
 * configuration, with no code change and no second adapter.
 */
export const azureOpenaiAdapter = openAiCompatible({
  id: 'azure-openai',
  url: entry =>
    `${trimSlash(entry.endpoint)}/openai/deployments/${entry.model}/chat/completions`
    + `?api-version=${entry.apiVersion ?? '2024-10-21'}`,
  headers: (_entry, credential) =>
    credential.kind === 'bearer'
      ? { Authorization: `Bearer ${credential.token}` }
      : { 'api-key': credential.key },
});
```

`apps/gateway/src/adapters/azureFoundry.ts`:

```ts
import { openAiCompatible, trimSlash } from './openaiCompatible.ts';

export const azureFoundryAdapter = openAiCompatible({
  id: 'azure-foundry',
  url: entry =>
    `${trimSlash(entry.endpoint)}/models/chat/completions`
    + `?api-version=${entry.apiVersion ?? '2024-05-01-preview'}`,
  headers: (_entry, credential) =>
    credential.kind === 'bearer'
      ? { Authorization: `Bearer ${credential.token}` }
      : { 'api-key': credential.key },
});
```

- [ ] **Step 6: Implement `adapters/registry.ts`**

```ts
import { PROVIDER_IDS, type ProviderId } from '@lexprompt/core';
import type { ProviderAdapter } from './types.ts';
import { azureFoundryAdapter } from './azureFoundry.ts';
import { azureOpenaiAdapter } from './azureOpenai.ts';
import { openaiAdapter } from './openai.ts';
import { anthropicAdapter } from './anthropic.ts';
import { openrouterAdapter } from './openrouter.ts';
import { recordedAdapter } from './recorded.ts';

/**
 * THE registration point. Adding a sixth provider is: add its id to
 * `PROVIDER_IDS` in packages/core, write its adapter, add one line here,
 * add a stream fixture. No call site changes, because no call site names a
 * provider — `callModel` looks one up from the allowlist entry.
 */
export const ALL_ADAPTERS: readonly ProviderAdapter[] = [
  azureFoundryAdapter,
  azureOpenaiAdapter,
  openaiAdapter,
  anthropicAdapter,
  openrouterAdapter,
  // Registered like any other, deliberately (§5.1). The offline stub being
  // an adapter rather than a bypass is what puts it through the conformance
  // suite, gives it a jurisdiction to declare, and lets a firm deployment
  // refuse it through S27's existing mechanism rather than a new one.
  recordedAdapter,
];

const BY_ID = new Map<ProviderId, ProviderAdapter>(ALL_ADAPTERS.map(a => [a.id, a]));

export function getAdapter(id: ProviderId): ProviderAdapter {
  const adapter = BY_ID.get(id);
  if (!adapter) {
    throw new Error(
      `No adapter is registered for provider ${JSON.stringify(id)}. `
      + `Registered: ${[...BY_ID.keys()].join(', ')}. Known ids: ${PROVIDER_IDS.join(', ')}.`,
    );
  }
  return adapter;
}
```

`registry.ts` imports `anthropicAdapter` (Task 9) and `recordedAdapter` (Task 13). **Write Task 9's file before running this task's tests** — or, if you are executing tasks strictly in order, create `apps/gateway/src/adapters/anthropic.ts` now with `export const anthropicAdapter = openAiCompatible({ id: 'anthropic', url: e => e.endpoint, headers: () => ({}) });` as a placeholder and replace it wholesale in Task 9. **Prefer the first**: a placeholder that happens to type-check is exactly the kind of thing that survives.

- [ ] **Step 7: Run the tests**

Run: `npx vitest run --project gateway apps/gateway/test/openaiCompatible.test.ts`
Expected: PASS, 20 tests.

- [ ] **Step 8: Mutation test the "no empty answer" rule**

In `readResponse`, replace the `throw` with `return { content: '', usage: { promptTokens: 0, completionTokens: 0 } };`. Run the test. Expected: FAIL on *"THROWS when there is no message content, rather than returning an empty answer"*. Restore.

This is `CLAUDE.md`'s founding case at a new boundary: an empty completion recorded as a finding reads as "the agreement is silent on this point".

- [ ] **Step 9: Mutation test the registry completeness guard**

Comment out `openrouterAdapter` in `ALL_ADAPTERS`. Run. Expected: FAIL on *"has an adapter for every provider id"*. Restore.

- [ ] **Step 10: Commit**

```bash
git add apps/gateway/src/adapters apps/gateway/test/openaiCompatible.test.ts
git commit -F .git/COMMIT_MSG_TASK8
```

```
feat(gateway): the adapter interface and four OpenAI-shaped providers

A ProviderAdapter is three PURE functions and no IO: buildCall describes a
request, readResponse and decodeEvent are pure. The one place that opens a
socket, retries, times out and aborts is callModel.ts — so §10's retry
policy is enforced once rather than five times, and every adapter is
testable with no network.

Four providers speak OpenAI's shape and differ only in URL and credential
header, so those two are parameters and the body builder, the image shape,
the strict-schema flag and the [DONE] handling are written once. Writing
azureOpenai.ts by copying openai.ts is how those four end up subtly
different in four files nobody reads side by side.

A registry test asserts every PROVIDER_ID has an adapter, so a new id
cannot ship unimplemented.

Mutation-tested: readResponse returning '' instead of throwing (1 test
fails); an adapter dropped from the registry (1). Restored.
```

---

## Task 9: The Anthropic adapter — the one genuinely different shape

**Type:** application code

**Files:**
- Create: `apps/gateway/src/adapters/anthropic.ts`
- Create: `apps/gateway/test/anthropic.test.ts`

**Interfaces:**
- Consumes: `ProviderAdapter`, `AdapterRequest`, `AdapterEvent` (Task 8); `sseFields` (Task 3).
- Produces: `anthropicAdapter: ProviderAdapter`.

**The four differences, and they are all confined here.** (1) `system` is a top-level parameter, not a message. (2) `max_tokens` is required, not optional. (3) Images are `{ type: 'image', source: { type: 'base64', media_type, data } }`. (4) Structured output is a forced tool call — `tools: [{ name: 'result', input_schema }]` with `tool_choice: { type: 'tool', name: 'result' }` — and the answer comes back as a tool-use block whose `input` is the object, which `readResponse` re-serialises to JSON so the gateway's contract ("content is a string") is unchanged. Its stream frames deltas as `event: content_block_delta` with `delta.text`, reports input tokens in `message_start` and output tokens in `message_delta`, and ends with `event: message_stop`.

- [ ] **Step 1: Write the failing test**

`apps/gateway/test/anthropic.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { anthropicAdapter as a } from '../src/adapters/anthropic.ts';
import type { ModelEntry } from '../src/config.ts';
import type { AdapterRequest } from '../src/adapters/types.ts';

const entry: ModelEntry = {
  id: 'claude', provider: 'anthropic', model: 'claude-sonnet-4-5', label: 'Claude',
  jurisdiction: { bloc: 'US', region: 'us', label: 'United States' },
  contextLength: 200000, supportsImages: true, supportsStructuredOutput: true, isDefault: false,
  endpoint: 'https://api.anthropic.com',
  credential: { source: 'env', var: 'K' },
};

const req = (over: Partial<AdapterRequest> = {}): AdapterRequest => ({
  entry, system: 'You are a contract reviewer.', user: 'Summarise clause 14.',
  maxTokens: 4096, stream: false, ...over,
});

describe('anthropic buildCall — the four differences, all here', () => {
  it('uses /v1/messages, the x-api-key header and a version header', () => {
    const call = a.buildCall(req(), { kind: 'api-key', key: 'sk-ant-1' });
    expect(call.url).toBe('https://api.anthropic.com/v1/messages');
    expect(call.headers['x-api-key']).toBe('sk-ant-1');
    expect(call.headers['anthropic-version']).toBe('2023-06-01');
    expect('Authorization' in call.headers).toBe(false);
  });

  it('DIFFERENCE 1: system is a top-level parameter, not a message', () => {
    const body = a.buildCall(req(), { kind: 'api-key', key: 'k' }).body as Record<string, unknown>;
    expect(body.system).toBe('You are a contract reviewer.');
    expect(body.messages).toEqual([{ role: 'user', content: 'Summarise clause 14.' }]);
  });

  it('omits system entirely when there is none', () => {
    const body = a.buildCall(req({ system: undefined }), { kind: 'api-key', key: 'k' }).body as Record<string, unknown>;
    expect('system' in body).toBe(false);
  });

  it('DIFFERENCE 2: max_tokens is always sent, because Anthropic requires it', () => {
    expect((a.buildCall(req(), { kind: 'api-key', key: 'k' }).body as { max_tokens: number }).max_tokens)
      .toBe(4096);
  });

  it('DIFFERENCE 3: images are base64 source blocks, not image_url parts', () => {
    const body = a.buildCall(
      req({ images: [{ mime: 'image/png', data: 'AAA' }] }), { kind: 'api-key', key: 'k' },
    ).body as { messages: { content: unknown }[] };
    expect(body.messages[0].content).toEqual([
      { type: 'text', text: 'Summarise clause 14.' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAA' } },
    ]);
  });

  it('DIFFERENCE 4: a JSON schema becomes a forced tool call', () => {
    const schema = { type: 'object', properties: { summary: { type: 'string' } } };
    const body = a.buildCall(req({ jsonSchema: schema }), { kind: 'api-key', key: 'k' }).body as Record<string, unknown>;
    expect(body.tools).toEqual([{ name: 'result', description: 'Return the result.', input_schema: schema }]);
    expect(body.tool_choice).toEqual({ type: 'tool', name: 'result' });
    expect('response_format' in body).toBe(false);
  });
});

describe('anthropic readResponse', () => {
  it('reads a text block and maps usage', () => {
    expect(a.readResponse({
      content: [{ type: 'text', text: 'Answer.' }],
      usage: { input_tokens: 10, output_tokens: 4 },
    })).toEqual({ content: 'Answer.', usage: { promptTokens: 10, completionTokens: 4 } });
  });

  it('joins several text blocks in order', () => {
    expect(a.readResponse({
      content: [{ type: 'text', text: 'One. ' }, { type: 'text', text: 'Two.' }],
    }).content).toBe('One. Two.');
  });

  // The whole point of the forced tool call: the gateway's contract is that
  // `content` is a string, and parseJsonLoose is the caller's fallback. A
  // tool-use answer is re-serialised so nothing downstream learns which
  // provider answered.
  it('re-serialises a tool-use answer to JSON, so the contract is unchanged', () => {
    expect(a.readResponse({
      content: [{ type: 'tool_use', name: 'result', input: { summary: 'Silent.', risk: 'low' } }],
      usage: { input_tokens: 1, output_tokens: 1 },
    }).content).toBe('{"summary":"Silent.","risk":"low"}');
  });

  it('THROWS when there is no text and no tool use, rather than returning an empty answer', () => {
    expect(() => a.readResponse({ content: [] })).toThrow(/no message content/i);
  });
});

describe('anthropic decodeEvent (pure, no network)', () => {
  it('reads a content_block_delta as a delta', () => {
    expect(a.decodeEvent('event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hi"}}'))
      .toEqual({ kind: 'delta', text: 'Hi' });
  });

  it('reads input_json_delta (a streamed tool call) as a delta too', () => {
    expect(a.decodeEvent('event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"input_json_delta","partial_json":"{\\"a\\":"}}'))
      .toEqual({ kind: 'delta', text: '{"a":' });
  });

  it('reads input tokens from message_start', () => {
    expect(a.decodeEvent('event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":91,"output_tokens":0}}}'))
      .toEqual({ kind: 'usage', usage: { promptTokens: 91, completionTokens: 0 } });
  });

  it('reads output tokens from message_delta', () => {
    expect(a.decodeEvent('event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":37}}'))
      .toEqual({ kind: 'usage', usage: { promptTokens: 0, completionTokens: 37 } });
  });

  it('reads message_stop as the end of the stream', () => {
    expect(a.decodeEvent('event: message_stop\ndata: {"type":"message_stop"}'))
      .toEqual({ kind: 'end' });
  });

  it('reads an error event as an error, not as content', () => {
    expect(a.decodeEvent('event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}'))
      .toEqual({ kind: 'error', status: 529, message: 'Overloaded' });
  });

  it('returns null for ping, for content_block_start and for malformed JSON', () => {
    expect(a.decodeEvent('event: ping\ndata: {"type":"ping"}')).toBe(null);
    expect(a.decodeEvent('event: content_block_start\ndata: {"type":"content_block_start"}')).toBe(null);
    expect(a.decodeEvent('event: content_block_delta\ndata: {not json')).toBe(null);
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `npx vitest run --project gateway apps/gateway/test/anthropic.test.ts`
Expected: FAIL — no `anthropicAdapter` export (or the Task 8 placeholder failing every assertion).

- [ ] **Step 3: Implement `adapters/anthropic.ts`**

```ts
import { sseFields, type InferUsage } from '@lexprompt/core';
import type { ResolvedCredential } from '../credentials/types.ts';
import { trimSlash } from './openaiCompatible.ts';
import type { AdapterCall, AdapterEvent, AdapterRequest, ProviderAdapter } from './types.ts';

const ANTHROPIC_VERSION = '2023-06-01';

/**
 * Anthropic's Messages API differs from the OpenAI shape in four ways, and
 * ALL FOUR are confined to this file. Nothing outside `adapters/` may
 * branch on a provider id — the moment `if (provider === 'anthropic')`
 * appears in a route, a call path or a client, this separation is gone and
 * the next difference gets handled in two places.
 *
 *  1. `system` is a top-level parameter, not a message.
 *  2. `max_tokens` is required.
 *  3. Images are base64 `source` blocks.
 *  4. Structured output is a forced tool call, and the answer arrives as a
 *     tool-use block whose `input` is the object. `readResponse`
 *     re-serialises it, so the gateway's contract — content is a string,
 *     and `parseJsonLoose` is the caller's fallback — is unchanged and
 *     nothing downstream can tell which provider answered.
 */
export const anthropicAdapter: ProviderAdapter = {
  id: 'anthropic',

  buildCall(req: AdapterRequest, credential: ResolvedCredential): AdapterCall {
    const content = req.images?.length
      ? [
          { type: 'text', text: req.user },
          ...req.images.map(img => ({
            type: 'image',
            source: { type: 'base64', media_type: img.mime, data: img.data },
          })),
        ]
      : req.user;

    return {
      url: `${trimSlash(req.entry.endpoint)}/v1/messages`,
      headers: {
        'Content-Type': 'application/json',
        'anthropic-version': ANTHROPIC_VERSION,
        'x-api-key': credential.kind === 'api-key' ? credential.key : credential.token,
      },
      body: {
        model: req.entry.model,
        max_tokens: req.maxTokens,
        ...(req.system ? { system: req.system } : {}),
        messages: [{ role: 'user', content }],
        ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
        ...(req.jsonSchema
          ? {
              tools: [{ name: 'result', description: 'Return the result.', input_schema: req.jsonSchema }],
              tool_choice: { type: 'tool', name: 'result' },
            }
          : {}),
        ...(req.stream ? { stream: true } : {}),
      },
    };
  },

  readResponse(body: unknown): { content: string; usage: InferUsage } {
    const b = body as {
      content?: { type?: string; text?: string; input?: unknown }[];
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    const blocks = b?.content ?? [];
    const text = blocks.filter(x => x.type === 'text').map(x => x.text ?? '').join('');
    const tool = blocks.find(x => x.type === 'tool_use');
    const content = text || (tool ? JSON.stringify(tool.input) : '');
    if (!content) {
      throw new Error('The provider returned no message content.');
    }
    return {
      content,
      usage: {
        promptTokens: Number(b?.usage?.input_tokens ?? 0),
        completionTokens: Number(b?.usage?.output_tokens ?? 0),
      },
    };
  },

  decodeEvent(rawEvent: string): AdapterEvent | null {
    const { data } = sseFields(rawEvent);
    if (!data) return null;
    let parsed: {
      type?: string;
      delta?: { type?: string; text?: string; partial_json?: string };
      message?: { usage?: { input_tokens?: number; output_tokens?: number } };
      usage?: { input_tokens?: number; output_tokens?: number };
      error?: { type?: string; message?: string };
    };
    try {
      parsed = JSON.parse(data);
    } catch {
      return null;
    }

    switch (parsed.type) {
      case 'content_block_delta': {
        const text = parsed.delta?.text ?? parsed.delta?.partial_json;
        return typeof text === 'string' && text ? { kind: 'delta', text } : null;
      }
      case 'message_start':
        return {
          kind: 'usage',
          usage: {
            promptTokens: Number(parsed.message?.usage?.input_tokens ?? 0),
            completionTokens: Number(parsed.message?.usage?.output_tokens ?? 0),
          },
        };
      case 'message_delta':
        return {
          kind: 'usage',
          usage: {
            promptTokens: Number(parsed.usage?.input_tokens ?? 0),
            completionTokens: Number(parsed.usage?.output_tokens ?? 0),
          },
        };
      case 'message_stop':
        return { kind: 'end' };
      case 'error':
        return {
          kind: 'error',
          // `overloaded_error` is Anthropic's 529; everything else that
          // arrives mid-stream is treated as a bad gateway, which is what
          // it is from the caller's point of view.
          status: parsed.error?.type === 'overloaded_error' ? 529 : 502,
          message: parsed.error?.message ?? 'The provider reported an error mid-stream.',
        };
      default:
        return null;
    }
  },
};
```

**A note on `usage` accumulation:** Anthropic reports input tokens in `message_start` and output tokens in `message_delta`, so a stream produces two `usage` events with the other field zero. Task 12's stream route therefore **accumulates by taking the maximum of each field across every `usage` event** rather than replacing — the OpenAI-shaped providers emit one complete usage chunk, and max-merging is correct for both without a provider branch outside the adapter.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run --project gateway apps/gateway/test/anthropic.test.ts`
Expected: PASS, 17 tests.

- [ ] **Step 5: Mutation test the tool-call re-serialisation**

In `readResponse`, change `const content = text || (tool ? JSON.stringify(tool.input) : '');` to `const content = text;`. Run. Expected: FAIL on *"re-serialises a tool-use answer to JSON"* and on *"THROWS when there is no text and no tool use"* is unaffected — but the schema path now returns nothing, which is precisely the failure this catches: every structured call to Anthropic (that is, every `chatJson` — nine call sites, including `extractClause`) would throw "no message content" and every clause would show as an error. Restore.

- [ ] **Step 6: Commit**

```bash
git add apps/gateway/src/adapters/anthropic.ts apps/gateway/test/anthropic.test.ts
git commit -F .git/COMMIT_MSG_TASK9
```

```
feat(gateway): the Anthropic adapter, with all four of its differences here

system as a top-level parameter; max_tokens required; base64 image source
blocks; structured output as a forced tool call, re-serialised so the
gateway's "content is a string" contract is unchanged and nothing
downstream can tell which provider answered.

All four are confined to this file. The moment `if (provider ===
'anthropic')` appears in a route, a call path or a client, the separation
is gone and the next difference gets handled twice.

Mutation-tested: tool-use re-serialisation removed — every structured call
(every chatJson, nine call sites) would throw "no message content".
Restored.
```

---

## Task 10: The adapter stream-conformance suite (D5)

**Type:** test

**Files:**
- Create: `apps/gateway/test/fixtures/streams/azure-foundry.txt`, `azure-openai.txt`, `openai.txt`, `anthropic.txt`, `openrouter.txt`, `recorded.txt`
- Create: `apps/gateway/test/fixtures/streams/expected.json`
- Create: `apps/gateway/test/adapterConformance.test.ts`

**Interfaces:**
- Consumes: `ALL_ADAPTERS` (Task 8); `createSseEventReader` (Task 3).
- Produces: nothing importable. It is the guard that makes "five providers, one class of streaming bug" survivable.

**Why this is a task of its own.** Streaming across five providers is the hardest part of Stage 1, and the honest reason is that the failure is silent: an adapter that drops the last event yields a short answer, not an error. One shared battery over recorded fixtures is what turns that into a red test. **Write this task before Task 12**, so the stream route is built against decoders already proved.

**Recording the fixtures.** Each `.txt` is the **raw bytes of a real streamed response**, captured once, with a header comment naming the provider, the model and the date. Capture them with the smoke script (Task 11 Step 8) using `--record`, or by hand:

```bash
curl -N https://api.openai.com/v1/chat/completions \
  -H "Authorization: Bearer $OPENAI_API_KEY" -H 'Content-Type: application/json' \
  -d '{"model":"gpt-4o","stream":true,"stream_options":{"include_usage":true},
       "max_tokens":64,"messages":[{"role":"user","content":"Say: one two three"}]}' \
  > apps/gateway/test/fixtures/streams/openai.txt
```

**If you cannot reach a provider, say so and hand-write the fixture from its published event format — then mark it `synthetic: true` in `expected.json`.** A synthetic fixture still catches every transport bug and every decoder regression; what it cannot catch is the provider having changed its shape. That distinction must be visible in the file rather than assumed, so a later reader knows which fixtures are evidence and which are a model's recollection of a format.

- [ ] **Step 1: Write `expected.json`**

```json
{
  "azure-foundry": { "text": "one two three", "promptTokens": 14, "completionTokens": 5, "synthetic": true },
  "azure-openai":  { "text": "one two three", "promptTokens": 14, "completionTokens": 5, "synthetic": true },
  "openai":        { "text": "one two three", "promptTokens": 14, "completionTokens": 5, "synthetic": true },
  "anthropic":     { "text": "one two three", "promptTokens": 16, "completionTokens": 5, "synthetic": true },
  "openrouter":    { "text": "one two three", "promptTokens": 14, "completionTokens": 5, "synthetic": true },
  "recorded":      { "text": "one two three", "promptTokens": 14, "completionTokens": 5, "synthetic": true }
}
```

Set `"synthetic": false` for each provider whose fixture you actually recorded, and add the recording date to the fixture's first line as an SSE comment (`: recorded 2026-08-28 against gpt-4o`) — an SSE comment line, so the fixture stays a valid stream.

- [ ] **Step 2: Write one fixture, in full, as the pattern for the rest**

`apps/gateway/test/fixtures/streams/openai.txt` (LF-terminated events; the suite generates the CRLF variant itself):

```
: recorded 2026-08-28 against gpt-4o (synthetic)

data: {"choices":[{"delta":{"role":"assistant","content":""}}]}

data: {"choices":[{"delta":{"content":"one"}}]}

data: {"choices":[{"delta":{"content":" two"}}]}

data: {"choices":[{"delta":{"content":" three"}}]}

data: {"choices":[{"delta":{},"finish_reason":"stop"}]}

data: {"choices":[],"usage":{"prompt_tokens":14,"completion_tokens":5}}

data: [DONE]

```

`anthropic.txt`:

```
: recorded 2026-08-28 against claude-sonnet-4-5 (synthetic)

event: message_start
data: {"type":"message_start","message":{"usage":{"input_tokens":16,"output_tokens":0}}}

event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}

event: ping
data: {"type":"ping"}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"one"}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" two"}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" three"}}

event: content_block_stop
data: {"type":"content_block_stop","index":0}

event: message_delta
data: {"type":"message_delta","usage":{"output_tokens":5}}

event: message_stop
data: {"type":"message_stop"}

```

`recorded.txt` is the stream one of Task 13's fixtures replays, and it is `synthetic: true` permanently and by definition — there is no live provider to record it from, and saying so in the file keeps the honest/recorded distinction meaningful for the five that do have one.

`azure-foundry.txt`, `azure-openai.txt` and `openrouter.txt` use the same OpenAI-shaped body as `openai.txt` — copy it, change only the header comment. (They genuinely are the same wire format; that is why one adapter base serves four providers, and a conformance fixture that pretends otherwise would be testing a fiction.)

- [ ] **Step 3: Write the conformance suite**

`apps/gateway/test/adapterConformance.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createSseEventReader } from '@lexprompt/core';
import { ALL_ADAPTERS } from '../src/adapters/registry.ts';
import type { ProviderAdapter } from '../src/adapters/types.ts';

const DIR = path.join(__dirname, 'fixtures/streams');
const EXPECTED = JSON.parse(readFileSync(path.join(DIR, 'expected.json'), 'utf8')) as Record<
  string, { text: string; promptTokens: number; completionTokens: number; synthetic: boolean }
>;

/** Drives one adapter over one delivery of one fixture, exactly as the
 *  stream route will (Task 12): the shared splitter, then the adapter's
 *  pure decoder, max-merging usage. */
function drive(adapter: ProviderAdapter, chunks: string[]) {
  const reader = createSseEventReader();
  let text = '';
  let promptTokens = 0;
  let completionTokens = 0;
  let ended = false;
  let error: { status: number; message: string } | null = null;

  const handle = (raw: string) => {
    const ev = adapter.decodeEvent(raw);
    if (!ev) return;
    if (ev.kind === 'delta') text += ev.text;
    else if (ev.kind === 'usage') {
      promptTokens = Math.max(promptTokens, ev.usage.promptTokens);
      completionTokens = Math.max(completionTokens, ev.usage.completionTokens);
    } else if (ev.kind === 'end') ended = true;
    else error = { status: ev.status, message: ev.message };
  };

  for (const chunk of chunks) for (const raw of reader.push(chunk)) handle(raw);
  for (const raw of reader.flush()) handle(raw);
  return { text, promptTokens, completionTokens, ended, error };
}

const byBytes = (s: string): string[] => [...s];

describe('every provider has a conformance fixture (D5)', () => {
  it('so a sixth provider cannot ship without one', () => {
    expect(ALL_ADAPTERS.map(a => a.id).sort()).toEqual(Object.keys(EXPECTED).sort());
  });
});

describe.each(ALL_ADAPTERS.map(a => [a.id, a] as const))('%s stream conformance', (id, adapter) => {
  const raw = readFileSync(path.join(DIR, `${id}.txt`), 'utf8');
  const want = EXPECTED[id];

  it('decodes the recorded stream to the expected text, usage and end', () => {
    const got = drive(adapter, [raw]);
    expect(got.text).toBe(want.text);
    expect(got.promptTokens).toBe(want.promptTokens);
    expect(got.completionTokens).toBe(want.completionTokens);
    expect(got.ended).toBe(true);
    expect(got.error).toBe(null);
  });

  // The CRLF bug, per provider. This project shipped it once and it
  // returned NOTHING — no error, no deltas.
  it('decodes the same stream identically when every separator is CRLF', () => {
    expect(drive(adapter, [raw.replace(/\n/g, '\r\n')]).text).toBe(want.text);
  });

  // The chunk-boundary bug, per provider. One byte at a time is the
  // harshest delivery a network can produce and the cheapest to simulate.
  it('decodes the same stream identically when delivered one byte at a time', () => {
    const got = drive(adapter, byBytes(raw));
    expect(got.text).toBe(want.text);
    expect(got.ended).toBe(true);
  });

  // The dropped-final-event bug, per provider.
  it('does not lose the last event when the stream ends without a trailing blank line', () => {
    const got = drive(adapter, [raw.replace(/\n+$/, '')]);
    expect(got.text).toBe(want.text);
    expect(got.ended).toBe(true);
  });

  it('reports that it ended, so the route never emits done on a truncated stream', () => {
    // Cut the fixture before its terminator: the decoder must NOT report an
    // end, which is what makes D2 reachable at the route layer.
    const truncated = raw.slice(0, Math.floor(raw.length * 0.6));
    expect(drive(adapter, [truncated]).ended).toBe(false);
  });

  it('is recorded against a live provider, or is marked synthetic', () => {
    expect(typeof want.synthetic).toBe('boolean');
    if (want.synthetic) {
      expect(raw).toContain('(synthetic)');
    }
  });
});
```

- [ ] **Step 4: Run it**

Run: `npx vitest run --project gateway apps/gateway/test/adapterConformance.test.ts`
Expected: PASS — 1 registry test plus 6 tests × 6 providers = 37 tests. The `recorded` rows are not ceremony: they are what proves the offline stub's stream behaves exactly like a provider's, which is the property that stops a fixture-backed local run from being a different code path.

- [ ] **Step 5: Mutation test — the two per-provider bugs, at the shared surface**

1. Delete `for (const raw of reader.flush()) handle(raw);` from `drive`. Expected: FAIL on *"does not lose the last event when the stream ends without a trailing blank line"* for **all five** providers — which is the point: one splitter means one fix, and this suite proves the fix reaches every adapter.
2. In `openaiCompatible.decodeEvent`, change `if (data === '[DONE]') return { kind: 'end' };` to `return null`. Expected: FAIL on *"decodes the recorded stream to the expected text, usage and end"* for the four OpenAI-shaped providers and for `recorded` (which reuses the same base), and **not** for Anthropic — which is also the point: a provider-specific regression is isolated to that provider's rows.

Restore both.

- [ ] **Step 6: Commit**

```bash
git add apps/gateway/test/adapterConformance.test.ts apps/gateway/test/fixtures/streams
git commit -F .git/COMMIT_MSG_TASK10
```

```
test(gateway): one stream-conformance battery over every provider (D5)

Four deliveries of each provider's recorded stream — as recorded, all-CRLF,
one byte at a time, and with the trailing blank line removed — must yield
identical text, usage and end. Plus: a truncated stream must NOT report an
end, which is what makes D2 reachable at the route layer.

A test asserts every registered adapter has a fixture, so a sixth provider
cannot ship untested. Fixtures marked synthetic say so in the file: a
synthetic fixture catches every transport and decoder bug but cannot catch
a provider changing its shape, and that distinction should be visible
rather than assumed.

Mutation-tested: the flush removed fails all five (one splitter, one fix,
proved to reach every adapter); [DONE] handling removed fails the four
OpenAI-shaped and not Anthropic (a provider regression stays isolated).
```

---

## Task 11: `callModel` — the one call path — and `POST /v1/infer`, `GET /v1/models`

**Type:** application code

**Files:**
- Create: `apps/gateway/src/callModel.ts`, `apps/gateway/src/routes/infer.ts`, `apps/gateway/src/routes/models.ts`, `apps/gateway/src/smoke.ts`
- Create: `apps/gateway/test/callModel.test.ts`, `apps/gateway/test/infer.route.test.ts`
- Modify: `apps/gateway/src/server.ts`, `apps/gateway/src/main.ts`

**Interfaces:**
- Consumes: `Allowlist` (5), `AuditLogger` (6), `CredentialResolver` (7), `getAdapter` (8), `GatewayConfig` (4).
- Produces:
  - `interface Transport { fetch(url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }): Promise<TransportResponse> }`
  - `interface TransportResponse { status: number; ok: boolean; json(): Promise<unknown>; text(): Promise<string>; body: AsyncIterable<Uint8Array> | null }`
  - `callModel(ctx: CallContext, req: InferRequest, signal?: AbortSignal): Promise<InferResponse>`
  - `interface CallContext { config: GatewayConfig; allowlist: Allowlist; audit: AuditLogger; credentials: CredentialResolver; transport: Transport; limiter: RateLimiter; workspaceId: string; actorIssuer: string; actorSubject: string }`
  - `registerInfer(app, makeContext)`, `registerModels(app, allowlist)`

- [ ] **Step 1: Write the failing tests**

`apps/gateway/test/callModel.test.ts` — the load-bearing cases (write all of them; the file is the retry-policy suite §14 says moves here from `openrouter.test.ts`):

```ts
import { describe, it, expect, vi } from 'vitest';
import { callModel } from '../src/callModel.ts';
import { Allowlist } from '../src/allowlist.ts';
import { AuditLogger, type AuditRecord, type AuditSink } from '../src/audit.ts';
import type { ModelEntry } from '../src/config.ts';
import type { Transport, TransportResponse } from '../src/callModel.ts';

const entry: ModelEntry = {
  id: 'uks-gpt4o', provider: 'azure-foundry', model: 'gpt-4o', label: 'GPT-4o',
  jurisdiction: { bloc: 'UK', region: 'uksouth', label: 'UK South' },
  contextLength: 128000, supportsImages: true, supportsStructuredOutput: true, isDefault: true,
  endpoint: 'https://firm.services.ai.azure.com',
  credential: { source: 'managed-identity', scope: 'https://cognitiveservices.azure.com/.default' },
};

const ok = (content: string): TransportResponse => ({
  status: 200, ok: true, body: null,
  json: async () => ({ choices: [{ message: { content } }], usage: { prompt_tokens: 7, completion_tokens: 2 } }),
  text: async () => '',
});

const err = (status: number, message = 'nope'): TransportResponse => ({
  status, ok: false, body: null,
  json: async () => ({ error: { message } }),
  text: async () => JSON.stringify({ error: { message } }),
});

class Sink implements AuditSink {
  records: AuditRecord[] = [];
  async write(r: AuditRecord) { this.records.push(r); }
}

function ctx(transport: Transport, sink = new Sink()) {
  return {
    config: {
      maxPromptChars: 100, requestTimeoutMs: 5000, defaultMaxTokens: 4096,
    } as never,
    allowlist: new Allowlist([entry]),
    audit: new AuditLogger(sink, () => new Date(), (() => { let n = 0; return () => `call-${++n}`; })()),
    credentials: { resolve: async () => ({ kind: 'bearer' as const, token: 'mi' }) },
    transport,
    limiter: { check: () => {}, record: () => {} } as never,
    workspaceId: 'ws-1',
    actorIssuer: 'https://keycloak.local/realms/lexprompt',
    actorSubject: 'oid-1',
    sink,
  };
}

const REQ = { modelChoiceId: 'uks-gpt4o', purpose: 'review.clause' as const, user: 'hi' };

describe('callModel — the one call path', () => {
  it('returns content, usage, provider, jurisdiction and the call id', async () => {
    const c = ctx({ fetch: async () => ok('Answer.') });
    expect(await callModel(c as never, REQ)).toEqual({
      content: 'Answer.',
      usage: { promptTokens: 7, completionTokens: 2 },
      callId: 'call-1',
      provider: 'azure-foundry',
      jurisdiction: { bloc: 'UK', region: 'uksouth', label: 'UK South' },
    });
  });

  it('refuses a purpose that is not on the allowlist, before any call', async () => {
    const fetchSpy = vi.fn(async () => ok('x'));
    const c = ctx({ fetch: fetchSpy });
    await expect(callModel(c as never, { ...REQ, purpose: 'review.everything' as never }))
      .rejects.toMatchObject({ code: 'purpose_not_allowed', status: 400 });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('refuses a model that is not on the allowlist, before any call', async () => {
    const fetchSpy = vi.fn(async () => ok('x'));
    const c = ctx({ fetch: fetchSpy });
    await expect(callModel(c as never, { ...REQ, modelChoiceId: 'gpt-5' }))
      .rejects.toMatchObject({ code: 'model_not_allowed', status: 400 });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('refuses a prompt over the configured maximum, with prompt_too_large', async () => {
    const c = ctx({ fetch: async () => ok('x') });
    await expect(callModel(c as never, { ...REQ, user: 'x'.repeat(200) }))
      .rejects.toMatchObject({ code: 'prompt_too_large', status: 413 });
  });

  // §10's rule, carried over verbatim.
  it('retries a 429 and succeeds', async () => {
    let n = 0;
    const c = ctx({ fetch: async () => (++n === 1 ? err(429) : ok('Answer.')) });
    expect((await callModel(c as never, REQ)).content).toBe('Answer.');
    expect(n).toBe(2);
  });

  it('retries a 500 and gives up after the retry budget', async () => {
    let n = 0;
    const c = ctx({ fetch: async () => { n++; return err(500); } });
    await expect(callModel(c as never, REQ)).rejects.toMatchObject({ code: 'upstream_failed' });
    expect(n).toBe(3);
  });

  it('fails immediately on 401, 402, 403 and 400 without retrying', async () => {
    for (const status of [400, 401, 402, 403]) {
      let n = 0;
      const c = ctx({ fetch: async () => { n++; return err(status); } });
      await expect(callModel(c as never, REQ)).rejects.toThrow();
      expect(n).toBe(1);
    }
  });

  it('surfaces a provider 401 as a FIRM configuration problem, not a user sign-in one', async () => {
    const c = ctx({ fetch: async () => err(401, 'Incorrect API key provided') });
    await expect(callModel(c as never, REQ))
      .rejects.toMatchObject({ code: 'service_misconfigured', status: 503 });
  });

  it('never lets a provider error body carry a credential outwards', async () => {
    const c = ctx({ fetch: async () => err(401, 'Incorrect API key provided: mi') });
    await expect(callModel(c as never, REQ)).rejects.toThrow(/\[redacted\]/);
    await expect(callModel(c as never, REQ)).rejects.not.toThrow(/provided: mi/);
  });

  it('propagates an abort immediately, unwrapped and unretried', async () => {
    let n = 0;
    const c = ctx({
      fetch: async () => {
        n++;
        const e = new Error('aborted'); e.name = 'AbortError'; throw e;
      },
    });
    await expect(callModel(c as never, REQ)).rejects.toMatchObject({ name: 'AbortError' });
    expect(n).toBe(1);
  });

  it('wraps a network-level rejection as retryable and retries the full budget', async () => {
    let n = 0;
    const c = ctx({ fetch: async () => { n++; throw new TypeError('fetch failed'); } });
    await expect(callModel(c as never, REQ)).rejects.toMatchObject({ code: 'network' });
    expect(n).toBe(3);
  });

  it('writes call.started before the call and call.finished after, with the retry count', async () => {
    const sink = new Sink();
    const order: string[] = [];
    let n = 0;
    const c = ctx({
      fetch: async () => { order.push('fetch'); return ++n === 1 ? err(500) : ok('A'); },
    }, sink);
    const originalWrite = sink.write.bind(sink);
    sink.write = async r => { order.push(r.kind); return originalWrite(r); };
    await callModel(c as never, REQ);
    expect(order).toEqual(['call.started', 'fetch', 'fetch', 'call.finished']);
    expect((sink.records[1] as { retries: number }).retries).toBe(1);
  });

  // D3, at the route level.
  it('makes NO upstream call when the audit sink fails', async () => {
    const fetchSpy = vi.fn(async () => ok('x'));
    const failing = { write: async () => { throw new Error('pipe'); } };
    const c = { ...ctx({ fetch: fetchSpy }), audit: new AuditLogger(failing, () => new Date(), () => 'c') };
    await expect(callModel(c as never, REQ))
      .rejects.toMatchObject({ code: 'service_misconfigured', status: 503 });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('makes NO upstream call when the credential cannot be resolved', async () => {
    const fetchSpy = vi.fn(async () => ok('x'));
    const c = {
      ...ctx({ fetch: fetchSpy }),
      credentials: { resolve: async () => { throw new Error('no identity endpoint'); } },
    };
    await expect(callModel(c as never, REQ)).rejects.toThrow();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `npx vitest run --project gateway apps/gateway/test/callModel.test.ts`
Expected: FAIL — `Failed to resolve import "../src/callModel.ts"`.

- [ ] **Step 3: Implement `callModel.ts`**

```ts
import {
  ModelError, isPurpose, isRetryableStatus,
  type InferRequest, type InferResponse,
} from '@lexprompt/core';
import type { GatewayConfig } from './config.ts';
import type { Allowlist } from './allowlist.ts';
import type { AuditLogger } from './audit.ts';
import type { CredentialResolver } from './credentials/types.ts';
import { redactCredential } from './credentials/resolve.ts';
import { getAdapter } from './adapters/registry.ts';
import type { RateLimiter } from './rateLimit.ts';

const MAX_ATTEMPTS = 3;
const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
const isAbort = (e: unknown): boolean =>
  (e as { name?: string } | null)?.name === 'AbortError';

export interface TransportResponse {
  status: number;
  ok: boolean;
  json(): Promise<unknown>;
  text(): Promise<string>;
  body: AsyncIterable<Uint8Array> | null;
}

export interface Transport {
  fetch(url: string, init: {
    method: string; headers: Record<string, string>; body: string; signal: AbortSignal;
  }): Promise<TransportResponse>;
}

export interface CallContext {
  config: GatewayConfig;
  allowlist: Allowlist;
  audit: AuditLogger;
  credentials: CredentialResolver;
  transport: Transport;
  limiter: RateLimiter;
  workspaceId: string;
  actorIssuer: string;
  actorSubject: string;
}

/** Everything a call needs, resolved and checked, before anything is sent.
 *  Shared by `callModel` and the stream route, so the checks cannot differ
 *  between a streamed and a non-streamed call. */
export async function prepare(ctx: CallContext, req: InferRequest, streaming: boolean) {
  if (!isPurpose(req.purpose)) {
    throw new ModelError(
      `The purpose ${JSON.stringify(req.purpose)} is not one this gateway serves.`,
      'purpose_not_allowed', 400,
    );
  }
  const entry = ctx.allowlist.resolve(req.modelChoiceId);

  const promptChars = (req.system ? req.system.length + 2 : 0) + req.user.length;
  if (promptChars > ctx.config.maxPromptChars) {
    throw new ModelError(
      `This request is ${promptChars} characters, over this gateway's limit of `
      + `${ctx.config.maxPromptChars}. Review fewer documents at once, or ask an `
      + 'administrator to raise the limit.',
      'prompt_too_large', 413,
    );
  }

  ctx.limiter.check(ctx.workspaceId, ctx.actorSubject);

  // Order matters and is load-bearing: the credential is resolved BEFORE
  // the audit record is written, so a credential failure never produces a
  // started record with no call; and the audit record is written before the
  // socket opens (D3), so a call never happens unlogged.
  const credential = await ctx.credentials.resolve(entry.credential);

  const callId = await ctx.audit.start({
    purpose: req.purpose,
    entry,
    workspaceId: ctx.workspaceId,
    actorIssuer: ctx.actorIssuer,
    actorSubject: ctx.actorSubject,
    context: req.context ?? {},
    system: req.system,
    user: req.user,
    imageCount: req.images?.length ?? 0,
    streaming,
  });

  const adapter = getAdapter(entry.provider);
  const call = adapter.buildCall({
    entry,
    system: req.system,
    user: req.user,
    images: req.images,
    jsonSchema: req.jsonSchema,
    temperature: req.temperature,
    maxTokens: req.maxTokens ?? ctx.config.defaultMaxTokens,
    stream: streaming,
  }, credential);

  return { entry, adapter, call, credential, callId };
}

/** Turns a provider's failure response into a ModelError, with the
 *  credential scrubbed out of whatever the provider chose to echo back. */
async function toModelError(
  response: TransportResponse,
  credential: { kind: 'bearer'; token: string } | { kind: 'api-key'; key: string },
  callId: string,
): Promise<ModelError> {
  let message = `HTTP ${response.status}`;
  try {
    const body = await response.json() as { error?: { message?: string } };
    if (body?.error?.message) message = body.error.message;
  } catch { /* keep the status */ }
  message = redactCredential(message, credential);

  // A provider rejecting OUR credential is the firm's configuration
  // problem, not the user's sign-in — the distinction openrouter.ts's
  // isAuthError could not make, because the key was the user's.
  if (response.status === 401 || response.status === 403 || response.status === 402) {
    return new ModelError(
      `The AI provider rejected LexPrompt's credentials (${message}). This is a `
      + 'configuration problem in the firm\'s deployment, not something you can fix here.',
      'service_misconfigured', 503, callId,
    );
  }
  if (response.status === 429) {
    return new ModelError(`The AI provider is rate-limiting this workspace (${message}).`,
      'rate_limited', 429, callId);
  }
  if (response.status >= 500) {
    return new ModelError(`The AI provider failed (${message}).`, 'upstream_failed', 502, callId);
  }
  return new ModelError(message, 'unknown', response.status, callId);
}

export async function callModel(
  ctx: CallContext,
  req: InferRequest,
  signal?: AbortSignal,
): Promise<InferResponse> {
  const { entry, adapter, call, credential, callId } = await prepare(ctx, req, false);
  const started = Date.now();
  let retries = 0;
  let lastError: unknown;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const timeout = AbortSignal.timeout(ctx.config.requestTimeoutMs);
    const composite = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let response: TransportResponse;
    try {
      response = await ctx.transport.fetch(call.url, {
        method: 'POST',
        headers: call.headers,
        body: JSON.stringify(call.body),
        signal: composite,
      });
    } catch (err) {
      // A cancellation is a deliberate decision and is never retried —
      // openrouter.ts learned this the expensive way, where an abort was
      // retried three times over ~3s while the UI looked busy.
      if (isAbort(err) && signal?.aborted) {
        await ctx.audit.finish(callId, {
          status: 0, ok: false, errorCode: 'unknown',
          promptTokens: 0, completionTokens: 0, latencyMs: Date.now() - started, retries,
        });
        throw err;
      }
      lastError = new ModelError(
        `Could not reach the AI provider: ${(err as Error).message}`, 'network', 0, callId,
      );
      if (attempt < MAX_ATTEMPTS - 1) { retries++; await wait(1000 * 2 ** attempt); }
      continue;
    }

    if (response.ok) {
      const body = await response.json();
      let read: { content: string; usage: { promptTokens: number; completionTokens: number } };
      try {
        read = adapter.readResponse(body);
      } catch (err) {
        await ctx.audit.finish(callId, {
          status: response.status, ok: false, errorCode: 'upstream_failed',
          promptTokens: 0, completionTokens: 0, latencyMs: Date.now() - started, retries,
        });
        throw new ModelError((err as Error).message, 'upstream_failed', 502, callId);
      }
      await ctx.audit.finish(callId, {
        status: response.status, ok: true,
        promptTokens: read.usage.promptTokens,
        completionTokens: read.usage.completionTokens,
        latencyMs: Date.now() - started, retries,
      });
      ctx.limiter.record(ctx.workspaceId, ctx.actorSubject, read.usage);
      return {
        content: read.content,
        usage: read.usage,
        callId,
        provider: entry.provider,
        jurisdiction: entry.jurisdiction,
      };
    }

    const modelError = await toModelError(response, credential, callId);
    // §10: retry 429 and 5xx only; fail fast on 400/401/402/403.
    if (!isRetryableStatus(response.status)) {
      await ctx.audit.finish(callId, {
        status: response.status, ok: false, errorCode: modelError.code,
        promptTokens: 0, completionTokens: 0, latencyMs: Date.now() - started, retries,
      });
      throw modelError;
    }
    lastError = modelError;
    if (attempt < MAX_ATTEMPTS - 1) { retries++; await wait(1000 * 2 ** attempt); }
  }

  const final = lastError as ModelError;
  await ctx.audit.finish(callId, {
    status: final.status, ok: false, errorCode: final.code,
    promptTokens: 0, completionTokens: 0, latencyMs: Date.now() - started, retries,
  });
  throw final;
}
```

- [ ] **Step 4: Implement the two routes**

`apps/gateway/src/routes/models.ts`:

```ts
import type { FastifyInstance } from 'fastify';
import type { Allowlist } from '../allowlist.ts';

/** The allowlist's single home on the wire. `apps/api` proxies this rather
 *  than holding a copy (S14). */
export function registerModels(app: FastifyInstance, allowlist: Allowlist): void {
  app.get('/v1/models', async () => ({ models: allowlist.list() }));
}
```

`apps/gateway/src/routes/infer.ts`:

```ts
import { ModelError } from '@lexprompt/core';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { callModel, type CallContext } from '../callModel.ts';

export interface InferBody {
  workspaceId?: string;
  actorIssuer?: string;
  actorSubject?: string;
  [key: string]: unknown;
}

export function sendModelError(reply: FastifyReply, err: unknown): void {
  const e = err instanceof ModelError
    ? err
    : new ModelError((err as Error).message ?? 'Unknown failure', 'unknown', 500);
  void reply.code(e.status === 0 ? 502 : e.status)
    .send({ error: { code: e.code, message: e.message, callId: e.callId } });
}

export function registerInfer(
  app: FastifyInstance,
  makeContext: (req: FastifyRequest) => CallContext,
): void {
  app.post('/v1/infer', async (request, reply) => {
    const body = request.body as InferBody;
    try {
      const result = await callModel(makeContext(request), body as never);
      return await reply.send(result);
    } catch (err) {
      return sendModelError(reply, err);
    }
  });
}
```

`makeContext` reads `workspaceId`, `actorIssuer` and `actorSubject` from the **request body**, which `apps/api` fills from the validated token (Task 17). The gateway does not validate a user token — it trusts its one caller, which is the whole point of the caller-auth boundary in Task 15.

- [ ] **Step 5: Wire the server**

In `server.ts`, extend `ServerDeps` with `allowlist`, `audit`, `credentials`, `transport`, `limiter`, and register `registerModels(app, deps.allowlist)` and `registerInfer(app, req => ({ ...deps, workspaceId: String((req.body as InferBody).workspaceId ?? ''), actorIssuer: String((req.body as InferBody).actorIssuer ?? ''), actorSubject: String((req.body as InferBody).actorSubject ?? '') }))`. In `main.ts`, construct `JsonlAuditSink(process.stdout)`, `DefaultCredentialResolver` from the three Azure helpers, and an `undici`-backed `Transport`:

```ts
import { request as undiciRequest } from 'undici';

const transport: Transport = {
  async fetch(url, init) {
    const res = await undiciRequest(url, {
      method: init.method as 'POST', headers: init.headers, body: init.body, signal: init.signal,
    });
    return {
      status: res.statusCode,
      ok: res.statusCode >= 200 && res.statusCode < 300,
      json: () => res.body.json(),
      text: () => res.body.text(),
      body: res.body,
    };
  },
};
```

- [ ] **Step 6: Write the route test**

`apps/gateway/test/infer.route.test.ts` — build a server with a fake transport and assert: a 200 returns the `InferResponse` shape; a `model_not_allowed` returns HTTP 400 with `{ error: { code: 'model_not_allowed' } }`; a `service_misconfigured` returns 503 with a `callId`; `GET /v1/models` returns the stripped list and **no endpoint or credential** (`expect(JSON.stringify(res.json())).not.toContain('services.ai.azure.com')`). Drive it with Fastify's `app.inject({ method: 'POST', url: '/v1/infer', payload: { … } })` — no socket needed.

- [ ] **Step 7: Run the tests**

Run: `npx vitest run --project gateway`
Expected: PASS across `config`, `allowlist`, `audit`, `credentials`, `openaiCompatible`, `anthropic`, `adapterConformance`, `callModel`, `infer.route`.

- [ ] **Step 8: Write the live smoke script**

`apps/gateway/src/smoke.ts`: loads the real config, calls every allowlisted model once with `purpose: 'assistant.chat'` and the prompt `Say: one two three`, prints per model `id, provider, jurisdiction, latency, promptTokens, completionTokens, content`, and with `--record <id>` writes the raw streamed bytes to `apps/gateway/test/fixtures/streams/<provider>.txt`.

Run it when you have a credential:

```bash
GATEWAY_MODELS_FILE=./models.json GATEWAY_CALLER_AUTH=mtls npm run smoke -w @lexprompt/gateway
```

**This is the only step in Stage 1 that cannot be proved offline** (D5). If you cannot run it, say so plainly in the task's completion note rather than implying you did — `CLAUDE.md`'s rule, and the fixtures stay marked `synthetic`.

- [ ] **Step 9: Mutation test the retry policy**

Change `if (!isRetryableStatus(response.status))` to `if (response.status < 400)`. Run `callModel.test.ts`. Expected: FAIL on *"fails immediately on 401, 402, 403 and 400 without retrying"* (three retries each). Restore.

Then delete the `redactCredential` call in `toModelError`. Expected: FAIL on *"never lets a provider error body carry a credential outwards"*. Restore.

- [ ] **Step 10: Commit**

```bash
git add apps/gateway/src/callModel.ts apps/gateway/src/routes apps/gateway/src/server.ts apps/gateway/src/main.ts apps/gateway/src/smoke.ts apps/gateway/test/callModel.test.ts apps/gateway/test/infer.route.test.ts
git commit -F .git/COMMIT_MSG_TASK11
```

```
feat(gateway): one call path — retry, timeout, abort, audit, redaction

§10's retry rule (429 and 5xx only, fail fast on 400/401/402/403) is
enforced here, once, for all five providers rather than five times. So are
the timeout, the abort passthrough, the prompt cap and D3's ordering:
credential, then audit record, then socket — so a credential failure never
leaves a started record with no call, and no call ever happens unlogged.

A provider rejecting OUR credential is service_misconfigured, not a user
sign-in problem: the distinction openrouter.ts could not make because the
key was the user's. Provider error bodies are scrubbed of the credential
before they become a message.

Mutation-tested: retry predicate widened to `status < 400` (1 test fails);
redaction removed (1). Restored.

The live smoke script is the one thing here that cannot be proved offline.
```

---

## Task 12: `POST /v1/infer/stream` — the gateway's outward stream

**Type:** application code

**Files:**
- Create: `apps/gateway/src/routes/inferStream.ts`
- Create: `apps/gateway/test/inferStream.route.test.ts`
- Modify: `apps/gateway/src/server.ts`

**Interfaces:**
- Consumes: `prepare` (Task 11), `createSseEventReader`, `encodeFrame` (Task 3), `getAdapter`/`decodeEvent` (Tasks 8–9).
- Produces: `registerInferStream(app, makeContext)` — responds `text/event-stream` carrying `Frame`s and nothing else.

**Four rules this route enforces, all of them D2 at the upstream edge:**
1. A `done` frame is emitted **only** after the adapter reported `end`. Never in a `finally`.
2. A stream that ends without `end` emits an **`error` frame** with `stream_truncated` — and the browser's `readFrames` then throws, so a half-answer never renders as a whole one.
3. An `error` event from the adapter, or a non-2xx before the stream opens, emits an `error` frame and stops.
4. Usage is **max-merged** across every `usage` event, because Anthropic reports input and output tokens in two separate events and the OpenAI-shaped providers report both in one. Max-merging is correct for both, so no provider branch appears outside `adapters/`.

- [ ] **Step 1: Write the failing tests**

`apps/gateway/test/inferStream.route.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { buildTestServer, fakeStream } from './helpers/streamHarness.ts';
import { createSseEventReader, decodeFrame, type Frame } from '@lexprompt/core';

function framesOf(body: string): Frame[] {
  const r = createSseEventReader();
  const out: Frame[] = [];
  for (const raw of [...r.push(body), ...r.flush()]) {
    const f = decodeFrame(raw);
    if (f) out.push(f);
  }
  return out;
}

const OPENAI_OK =
  'data: {"choices":[{"delta":{"content":"one"}}]}\n\n'
  + 'data: {"choices":[{"delta":{"content":" two"}}]}\n\n'
  + 'data: {"choices":[],"usage":{"prompt_tokens":9,"completion_tokens":2}}\n\n'
  + 'data: [DONE]\n\n';

describe('POST /v1/infer/stream', () => {
  it('emits one delta frame per delta and exactly one done frame, carrying usage', async () => {
    const app = buildTestServer({ stream: fakeStream(200, OPENAI_OK) });
    const res = await app.inject({ method: 'POST', url: '/v1/infer/stream',
      payload: { modelChoiceId: 'uks-gpt4o', purpose: 'assistant.chat', user: 'hi',
                 workspaceId: 'ws', actorIssuer: 'iss', actorSubject: 'sub' } });
    expect(res.headers['content-type']).toContain('text/event-stream');
    expect(framesOf(res.body)).toEqual([
      { type: 'delta', text: 'one' },
      { type: 'delta', text: ' two' },
      { type: 'done', usage: { promptTokens: 9, completionTokens: 2 }, callId: 'call-1' },
    ]);
  });

  // D2 at the upstream edge. THE rule of this task.
  it('emits an ERROR frame, not a done frame, when the provider stream stops early', async () => {
    const app = buildTestServer({
      stream: fakeStream(200, 'data: {"choices":[{"delta":{"content":"half an ans"}}]}\n\n'),
    });
    const res = await app.inject({ method: 'POST', url: '/v1/infer/stream',
      payload: { modelChoiceId: 'uks-gpt4o', purpose: 'assistant.chat', user: 'hi',
                 workspaceId: 'ws', actorIssuer: 'iss', actorSubject: 'sub' } });
    const frames = framesOf(res.body);
    expect(frames[0]).toEqual({ type: 'delta', text: 'half an ans' });
    expect(frames[1]).toMatchObject({ type: 'error', code: 'stream_truncated' });
    expect(frames.some(f => f.type === 'done')).toBe(false);
  });

  it('emits an error frame when the provider errors mid-stream', async () => {
    const app = buildTestServer({
      stream: fakeStream(200,
        'data: {"choices":[{"delta":{"content":"a"}}]}\n\n'
        + 'data: {"error":{"message":"upstream exploded","code":500}}\n\n'),
    });
    const res = await app.inject({ method: 'POST', url: '/v1/infer/stream',
      payload: { modelChoiceId: 'uks-gpt4o', purpose: 'assistant.chat', user: 'hi',
                 workspaceId: 'ws', actorIssuer: 'iss', actorSubject: 'sub' } });
    expect(framesOf(res.body)[1]).toMatchObject({
      type: 'error', code: 'upstream_failed', message: 'upstream exploded',
    });
  });

  it('answers a pre-stream failure with an HTTP status, not a 200 carrying an error frame', async () => {
    const app = buildTestServer({ stream: fakeStream(401, '{"error":{"message":"bad key"}}') });
    const res = await app.inject({ method: 'POST', url: '/v1/infer/stream',
      payload: { modelChoiceId: 'uks-gpt4o', purpose: 'assistant.chat', user: 'hi',
                 workspaceId: 'ws', actorIssuer: 'iss', actorSubject: 'sub' } });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ error: { code: 'service_misconfigured' } });
  });

  it('refuses an unallowlisted model with 400 and never opens a stream', async () => {
    const app = buildTestServer({ stream: fakeStream(200, OPENAI_OK) });
    const res = await app.inject({ method: 'POST', url: '/v1/infer/stream',
      payload: { modelChoiceId: 'gpt-5', purpose: 'assistant.chat', user: 'hi',
                 workspaceId: 'ws', actorIssuer: 'iss', actorSubject: 'sub' } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: 'model_not_allowed' } });
  });

  // Anthropic's two-event usage, through the same route with no branch.
  it('max-merges usage across events, so Anthropic\'s split usage arrives whole', async () => {
    const app = buildTestServer({
      provider: 'anthropic',
      stream: fakeStream(200,
        'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":16,"output_tokens":0}}}\n\n'
        + 'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}\n\n'
        + 'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":5}}\n\n'
        + 'event: message_stop\ndata: {"type":"message_stop"}\n\n'),
    });
    const res = await app.inject({ method: 'POST', url: '/v1/infer/stream',
      payload: { modelChoiceId: 'claude', purpose: 'assistant.chat', user: 'hi',
                 workspaceId: 'ws', actorIssuer: 'iss', actorSubject: 'sub' } });
    const done = framesOf(res.body).find(f => f.type === 'done');
    expect(done).toEqual({ type: 'done', usage: { promptTokens: 16, completionTokens: 5 }, callId: 'call-1' });
  });

  it('records call.finished with the streamed usage', async () => {
    const app = buildTestServer({ stream: fakeStream(200, OPENAI_OK) });
    await app.inject({ method: 'POST', url: '/v1/infer/stream',
      payload: { modelChoiceId: 'uks-gpt4o', purpose: 'assistant.chat', user: 'hi',
                 workspaceId: 'ws', actorIssuer: 'iss', actorSubject: 'sub' } });
    const finished = app.auditSink.records.find(r => r.kind === 'call.finished');
    expect(finished).toMatchObject({ ok: true, promptTokens: 9, completionTokens: 2 });
  });

  it('records call.finished with ok:false and stream_truncated on a cut stream', async () => {
    const app = buildTestServer({ stream: fakeStream(200, 'data: {"choices":[{"delta":{"content":"x"}}]}\n\n') });
    await app.inject({ method: 'POST', url: '/v1/infer/stream',
      payload: { modelChoiceId: 'uks-gpt4o', purpose: 'assistant.chat', user: 'hi',
                 workspaceId: 'ws', actorIssuer: 'iss', actorSubject: 'sub' } });
    expect(app.auditSink.records.find(r => r.kind === 'call.finished'))
      .toMatchObject({ ok: false, errorCode: 'stream_truncated' });
  });
});
```

`apps/gateway/test/helpers/streamHarness.ts` builds a Fastify instance with a stubbed `Transport` whose `fetch` returns `{ status, ok, body }` where `body` is an async generator yielding the given text in three uneven chunks (so a chunk boundary lands mid-event on every test, not only the one that names it), an `Allowlist` holding `uks-gpt4o` (azure-foundry) and `claude` (anthropic), a collecting `AuditSink` exposed as `app.auditSink`, and a credential resolver returning a fixed bearer token.

- [ ] **Step 2: Run and watch it fail**

Run: `npx vitest run --project gateway apps/gateway/test/inferStream.route.test.ts`
Expected: FAIL — `Failed to resolve import './helpers/streamHarness.ts'`.

- [ ] **Step 3: Implement `routes/inferStream.ts`**

```ts
import { ModelError, createSseEventReader, encodeFrame, type InferUsage } from '@lexprompt/core';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { prepare, type CallContext } from '../callModel.ts';
import { sendModelError, type InferBody } from './infer.ts';

export function registerInferStream(
  app: FastifyInstance,
  makeContext: (req: FastifyRequest) => CallContext,
): void {
  app.post('/v1/infer/stream', async (request, reply) => {
    const ctx = makeContext(request);
    const body = request.body as InferBody;
    const started = Date.now();

    let prepared: Awaited<ReturnType<typeof prepare>>;
    try {
      prepared = await prepare(ctx, body as never, true);
    } catch (err) {
      // Nothing has been sent yet, so a failure here is an HTTP status —
      // never a 200 carrying an error frame, which would make a refusal
      // indistinguishable from a mid-stream fault to any proxy in between.
      return sendModelError(reply, err);
    }
    const { entry, adapter, call, credential, callId } = prepared;

    const timeout = AbortSignal.timeout(ctx.config.requestTimeoutMs);
    let response;
    try {
      response = await ctx.transport.fetch(call.url, {
        method: 'POST', headers: call.headers,
        body: JSON.stringify(call.body), signal: timeout,
      });
    } catch (err) {
      await ctx.audit.finish(callId, {
        status: 0, ok: false, errorCode: 'network',
        promptTokens: 0, completionTokens: 0, latencyMs: Date.now() - started, retries: 0,
      });
      return sendModelError(reply, new ModelError(
        `Could not reach the AI provider: ${(err as Error).message}`, 'network', 0, callId));
    }

    // A stream is deliberately NOT retried: a half-delivered stream cannot
    // be resumed from the middle, and the caller can simply ask again.
    // `openrouter.ts` made the same choice for the same reason.
    if (!response.ok) {
      const { toModelError } = await import('../callModel.ts');
      const err = await toModelError(response, credential, callId);
      await ctx.audit.finish(callId, {
        status: response.status, ok: false, errorCode: err.code,
        promptTokens: 0, completionTokens: 0, latencyMs: Date.now() - started, retries: 0,
      });
      return sendModelError(reply, err);
    }

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // no-transform matters: a proxy that rebuffers or recompresses an SSE
      // body is how a stream stops arriving event by event.
    });

    const reader = createSseEventReader();
    const decoder = new TextDecoder();
    const usage: InferUsage = { promptTokens: 0, completionTokens: 0 };
    let ended = false;
    let failure: { status: number; message: string } | null = null;

    const handle = (raw: string): void => {
      if (ended || failure) return;
      const ev = adapter.decodeEvent(raw);
      if (!ev) return;
      if (ev.kind === 'delta') {
        reply.raw.write(encodeFrame({ type: 'delta', text: ev.text }));
      } else if (ev.kind === 'usage') {
        // Max-merge, not replace: Anthropic reports input tokens in
        // message_start and output tokens in message_delta, each leaving
        // the other at zero. The OpenAI-shaped providers send one complete
        // chunk. Max is right for both, which is why there is no provider
        // branch here.
        usage.promptTokens = Math.max(usage.promptTokens, ev.usage.promptTokens);
        usage.completionTokens = Math.max(usage.completionTokens, ev.usage.completionTokens);
      } else if (ev.kind === 'end') {
        ended = true;
      } else {
        failure = { status: ev.status, message: ev.message };
      }
    };

    try {
      for await (const chunk of response.body ?? []) {
        for (const raw of reader.push(decoder.decode(chunk, { stream: true }))) handle(raw);
        if (failure) break;
      }
      const tail = decoder.decode();
      if (tail) for (const raw of reader.push(tail)) handle(raw);
      for (const raw of reader.flush()) handle(raw);
    } catch (err) {
      failure = { status: 502, message: `The stream failed: ${(err as Error).message}` };
    }

    if (failure) {
      reply.raw.write(encodeFrame({
        type: 'error', code: 'upstream_failed',
        status: failure.status, message: failure.message, callId,
      }));
    } else if (ended) {
      // The ONLY place a done frame is written, and it is written only
      // because the provider said the stream was complete. Never in a
      // finally — a finally would emit done on a dropped socket, which is
      // exactly the truncated-but-apparently-successful answer this project
      // exists to prevent.
      reply.raw.write(encodeFrame({ type: 'done', usage, callId }));
    } else {
      reply.raw.write(encodeFrame({
        type: 'error', code: 'stream_truncated', status: 0, callId,
        message: 'The answer stopped before it finished. What arrived is incomplete — ask again.',
      }));
    }
    reply.raw.end();

    await ctx.audit.finish(callId, {
      status: 200,
      ok: !failure && ended,
      ...(failure ? { errorCode: 'upstream_failed' as const }
        : ended ? {} : { errorCode: 'stream_truncated' as const }),
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      latencyMs: Date.now() - started,
      retries: 0,
    });
    ctx.limiter.record(ctx.workspaceId, ctx.actorSubject, usage);
  });
}
```

Export `toModelError` from `callModel.ts` rather than dynamically importing it — the `await import` above is a placeholder that must not survive; change both files in this step.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run --project gateway apps/gateway/test/inferStream.route.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Mutation test D2 at this boundary — two mutations**

1. **`done` in a `finally`.** Replace the three-way `if (failure) … else if (ended) … else …` with an unconditional `reply.raw.write(encodeFrame({ type: 'done', usage, callId }));`. Run. Expected: FAIL on *"emits an ERROR frame, not a done frame, when the provider stream stops early"*, *"emits an error frame when the provider errors mid-stream"* and *"records call.finished with ok:false and stream_truncated"*. Restore.
2. **Usage replace instead of max-merge.** Change both `Math.max(...)` to plain assignment. Run. Expected: FAIL on *"max-merges usage across events"* — Anthropic's `message_delta` would zero the input tokens, and every Anthropic call would be logged as having sent nothing. Restore.

- [ ] **Step 6: Commit**

```bash
git add apps/gateway/src/routes/inferStream.ts apps/gateway/src/callModel.ts apps/gateway/test/inferStream.route.test.ts apps/gateway/test/helpers
git commit -F .git/COMMIT_MSG_TASK12
```

```
feat(gateway): the outward stream — one frame format, five providers

A done frame is written in exactly one place and only because the provider
said the stream was complete. A stream that ends without that emits an
error frame carrying stream_truncated, so a half-answer can never render as
a whole one. A pre-stream failure is an HTTP status, never a 200 carrying
an error frame.

Usage is max-merged across events, because Anthropic reports input and
output tokens in two separate events and the OpenAI-shaped providers report
both in one — max is right for both, so no provider branch appears outside
adapters/.

Mutation-tested: done written unconditionally (3 tests fail); usage
replaced rather than max-merged (1). Restored.
```

---

## Task 13: The `recorded` provider — an adapter, not a bypass, and marked everywhere

**Type:** application code

**Files:**
- Create: `apps/gateway/src/adapters/recorded.ts`, `apps/gateway/fixtures/recorded/*.json`, `apps/gateway/fixtures/recorded/streams/*.txt`
- Create: `apps/gateway/test/recorded.test.ts`
- Modify: `apps/gateway/src/adapters/registry.ts` (Task 8 already imports it), `apps/gateway/src/routes/infer.ts` and `inferStream.ts` (the `X-LexPrompt-Provider` header)
- Modify: `models.local-recorded.example.json` (Task 24 ships it)

**Interfaces:**
- Consumes: `ProviderAdapter`, `AdapterRequest`, `AdapterEvent` (Task 8); `sseFields` (Task 3).
- Produces: `recordedAdapter: ProviderAdapter` with `id: 'recorded'`; `makeRecordedAdapter(dir, readFile)` for tests.

**This task changed with spec Revision 2 (§5.1), and the change is the point of it.** The stub was a *transport* selected by an environment flag — which is a second code path, chosen by a branch on the environment, and §5.1 and S30 forbid exactly that. It is now a **registered provider adapter**: it appears in `ALL_ADAPTERS`, an operator selects it by putting it in `models.json` like any other, it passes `adapterConformance` like any other, and it declares a jurisdiction like any other — so a firm deployment refuses it through **S27's existing mechanism** rather than through a new guard.

That is strictly stronger than the flag-and-guard version this task previously described. The guard was a check somebody had to remember to write; the jurisdiction refusal is a check that already exists and that every provider passes through.

**Its declared jurisdiction is the honest one.** `{ bloc: 'other', region: 'local', label: 'this machine — recorded responses, not a model' }`. Any deployment whose declared set does not include `other` therefore refuses it at startup, naming it, with no new code — and since `GATEWAY_ALLOWED_JURISDICTIONS` has no default (D4), that is every deployment whose operator has not written `other` themselves. Which is a thing they cannot type by accident.

**And every response it produces is marked, in four places.** It is the one component of the local stack capable of producing a *confident wrong answer* — fluent, plausible, and about no document anybody uploaded — so it says loudest what it is:

1. `InferResponse.provider === 'recorded'`, returned, not merely logged.
2. The audit record's `provider` and `jurisdiction`, from the same allowlist entry as every other call.
3. `X-LexPrompt-Provider: recorded` on the HTTP response, so the marking survives a caller that ignores the body.
4. The browser renders a **loud, non-dismissible banner** while the selected model's provider is `recorded`, and Stage 3 additionally stores the flag on the finding and `run.provider` (§5.1) — noted here as the interface Stage 3 must honour, and not built now, because Stage 1 has no `run` row.

- [ ] **Step 1: Write the failing test**

`apps/gateway/test/recorded.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { makeRecordedAdapter } from '../src/adapters/recorded.ts';
import { loadConfig } from '../src/config.ts';
import type { ModelEntry } from '../src/config.ts';
import type { AdapterRequest } from '../src/adapters/types.ts';

const RECORDED_JURISDICTION = {
  bloc: 'other' as const, region: 'local',
  label: 'this machine — recorded responses, not a model',
};

const entry: ModelEntry = {
  id: 'offline', provider: 'recorded', model: 'recorded', label: 'Recorded responses (offline)',
  jurisdiction: RECORDED_JURISDICTION,
  contextLength: 128000, supportsImages: true, supportsStructuredOutput: true, isDefault: true,
  endpoint: 'file:///fixtures/recorded',
  credential: { source: 'env', var: 'UNUSED' },
};

const files: Record<string, string> = {
  'fixtures/recorded/review.clause.json': JSON.stringify({
    choices: [{ message: { content: '{"summary":"RECORDED - this is a stored development response, not a review.","riskLevel":"low"}' } }],
    usage: { prompt_tokens: 5, completion_tokens: 9 },
  }),
  'fixtures/recorded/default.json': JSON.stringify({
    choices: [{ message: { content: 'RECORDED - this is a stored development response, not a review.' } }],
    usage: { prompt_tokens: 1, completion_tokens: 1 },
  }),
};
const read = (path: string) => {
  const body = files[path.replace(/\\/g, '/')];
  if (!body) throw new Error(`ENOENT ${path}`);
  return body;
};

const req = (over: Partial<AdapterRequest> = {}): AdapterRequest => ({
  entry, user: 'hi', maxTokens: 4096, stream: false, ...over,
});

describe('the recorded adapter is an adapter (spec Revision 2, §5.1)', () => {
  const a = makeRecordedAdapter('fixtures/recorded', read);

  it('is registered under the provider id `recorded`', () => {
    expect(a.id).toBe('recorded');
  });

  it('implements the same three functions as every other adapter', () => {
    expect(typeof a.buildCall).toBe('function');
    expect(typeof a.readResponse).toBe('function');
    expect(typeof a.decodeEvent).toBe('function');
  });

  it('decodes an OpenAI-shaped event, so it passes adapterConformance unmodified', () => {
    expect(a.decodeEvent('data: {"choices":[{"delta":{"content":"Hi"}}]}'))
      .toEqual({ kind: 'delta', text: 'Hi' });
    expect(a.decodeEvent('data: [DONE]')).toEqual({ kind: 'end' });
  });

  it('routes buildCall to the fixture chosen by the purpose, and to default otherwise', () => {
    expect(a.buildCall(req({ purpose: 'review.clause' } as never), { kind: 'api-key', key: '' }).url)
      .toBe('fixtures/recorded/review.clause.json');
    expect(a.buildCall(req({ purpose: 'export.email' } as never), { kind: 'api-key', key: '' }).url)
      .toBe('fixtures/recorded/default.json');
  });

  it('carries no credential into its headers, because it needs none', () => {
    const call = a.buildCall(req(), { kind: 'api-key', key: 'sk-should-not-appear' });
    expect(JSON.stringify(call.headers)).not.toContain('sk-should-not-appear');
  });

  it('THROWS on a missing fixture rather than answering empty', () => {
    const bare = makeRecordedAdapter('fixtures/recorded', () => { throw new Error('ENOENT'); });
    expect(() => bare.readResponse(bare.buildCall(req(), { kind: 'api-key', key: '' })))
      .toThrow(/no recorded fixture/i);
  });

  it('THROWS when a fixture has no message content, like every other adapter', () => {
    const empty = makeRecordedAdapter('d', () => JSON.stringify({ choices: [] }));
    expect(() => empty.readResponse({ choices: [] })).toThrow(/no message content/i);
  });
});

describe('S27 refuses it in a firm deployment, through the mechanism that already exists', () => {
  const modelsFile = (jurisdiction: unknown) => JSON.stringify({
    models: [{ ...entry, jurisdiction }],
  });
  const BASE = {
    GATEWAY_PORT: '8081', GATEWAY_MODELS_FILE: '/m.json', GATEWAY_CALLER_AUTH: 'none',
  };
  const read1 = (body: string) => () => body;

  // No new guard. The jurisdiction gate D4 already built does the whole job.
  it('a deployment that has not declared `other` refuses to start with it, naming it', () => {
    expect(() => loadConfig({ ...BASE, GATEWAY_ALLOWED_JURISDICTIONS: 'UK,EU' },
      read1(modelsFile(RECORDED_JURISDICTION))))
      .toThrow(/offline[\s\S]*recorded[\s\S]*other[\s\S]*GATEWAY_ALLOWED_JURISDICTIONS/);
  });

  it('starts only when the operator wrote `other` into the allowed set themselves', () => {
    const cfg = loadConfig(
      { ...BASE, GATEWAY_ALLOWED_JURISDICTIONS: 'UK,EU,other' },
      read1(modelsFile(RECORDED_JURISDICTION)),
    );
    expect(cfg.models[0].provider).toBe('recorded');
  });

  // The one thing a recorded adapter must not be allowed to do: hide.
  it('refuses a recorded entry that declares a real-looking jurisdiction', () => {
    expect(() => loadConfig(
      { ...BASE, GATEWAY_ALLOWED_JURISDICTIONS: 'UK,EU' },
      read1(modelsFile({ bloc: 'UK', region: 'uksouth', label: 'UK South' })),
    )).toThrow(/recorded[\s\S]*must declare/i);
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `npx vitest run --project gateway apps/gateway/test/recorded.test.ts`
Expected: FAIL — `Failed to resolve import "../src/adapters/recorded.ts"`.

- [ ] **Step 3: Implement `adapters/recorded.ts`**

```ts
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { openAiCompatible } from './openaiCompatible.ts';
import type { AdapterCall, AdapterRequest, ProviderAdapter } from './types.ts';
import type { ResolvedCredential } from '../credentials/types.ts';

export const RECORDED_JURISDICTION = {
  bloc: 'other' as const,
  region: 'local',
  label: 'this machine — recorded responses, not a model',
};

/**
 * The offline provider (§5.1). An ADAPTER, not a bypass.
 *
 * It was a transport chosen by an environment flag, which is a second code
 * path selected by a branch on the environment — precisely what §5.1 and
 * S30 forbid, and what would make a green local run evidence about a system
 * nobody deploys. It is now registered, selected by an operator writing it
 * into `models.json` like any other provider, and refused in a firm
 * deployment by the jurisdiction gate that already exists (S27) rather than
 * by a guard somebody had to remember to write.
 *
 * It reuses `openAiCompatible`'s response and event decoders verbatim, which
 * is not laziness: it is what makes the fixture path decode through the same
 * code the four OpenAI-shaped providers decode through, so `adapterConformance`
 * is testing something rather than agreeing with itself.
 *
 * This is the one component of the local stack that can produce a confident
 * wrong answer — fluent, plausible, and about no document anybody uploaded —
 * so it is marked in four places: the returned `provider`, the audit record,
 * an `X-LexPrompt-Provider` response header, and a non-dismissible banner in
 * the app.
 */
export function makeRecordedAdapter(
  dir: string,
  readFile: (p: string) => string,
): ProviderAdapter {
  const base = openAiCompatible({
    id: 'recorded',
    url: () => dir,
    headers: () => ({}),
  });

  return {
    id: 'recorded',

    buildCall(req: AdapterRequest, _credential: ResolvedCredential): AdapterCall {
      // The credential is deliberately ignored and never enters the headers:
      // a recorded provider needs none, and a call that carried one would
      // put a real key on a path that never reaches a network.
      const purpose = (req as unknown as { purpose?: string }).purpose ?? 'default';
      const candidates = [`${purpose}.json`, 'default.json'];
      const found = candidates.find((name) => {
        try { readFile(path.join(dir, name)); return true; } catch { return false; }
      });
      if (!found) {
        throw new Error(
          `No recorded fixture for purpose ${purpose} in ${dir}. `
          + 'A missing fixture is a failure, never an empty answer.',
        );
      }
      return { url: path.join(dir, found).replace(/\\/g, '/'), headers: {}, body: {} };
    },

    // Both reused verbatim from the OpenAI-shaped base, including its refusal
    // to return an empty answer when a fixture has no message content.
    readResponse: base.readResponse,
    decodeEvent: base.decodeEvent,
  };
}

export const recordedAdapter = makeRecordedAdapter(
  process.env.GATEWAY_RECORDED_DIR ?? 'apps/gateway/fixtures/recorded',
  p => readFileSync(p, 'utf8'),
);
```

**`callModel`'s transport reads a `file:` URL for this adapter and nothing else changes.** Extend `main.ts`'s `undici` transport with one branch on the URL *scheme* — not on the provider id, which would be the provider branch outside `adapters/` that Task 26's sweep forbids:

```ts
    if (!/^https?:/.test(url)) {
      // A fixture path, produced only by the recorded adapter's buildCall.
      const body = JSON.parse(readFileSync(url, 'utf8')) as unknown;
      return { status: 200, ok: true, body: null,
        json: async () => body, text: async () => JSON.stringify(body) };
    }
```

For the streamed route, the same branch returns an async generator over `fixtures/recorded/streams/<purpose>.txt` in three uneven chunks, so a local stream exercises the chunk-boundary path rather than arriving whole.

- [ ] **Step 4: Add the jurisdiction honesty check to `config.ts`**

The third S27 test needs one new rule, and it is the only new code this task adds to the gateway core:

```ts
  // A recorded model must declare that it is recorded. Everything else in
  // this design lets an operator declare a jurisdiction and be trusted; here
  // the value is a fact about the software rather than about a deployment,
  // and an entry claiming `UK South` for stored fixtures would defeat every
  // one of the four markings at once.
  for (const m of models) {
    if (m.provider === 'recorded' && m.jurisdiction.bloc !== 'other') {
      throw new ConfigError(
        `Model "${m.id}" uses the recorded provider and must declare `
        + `jurisdiction.bloc "other" — recorded responses come from this machine, `
        + `not from ${m.jurisdiction.label}.`,
      );
    }
  }
```

This is a check on the `provider` field's *value*, in the configuration validator, not a provider-specific code path in the call path — `config.ts` already validates provider ids and is where per-entry rules belong.

- [ ] **Step 5: Write the fixtures**

`apps/gateway/fixtures/recorded/default.json`, plus one per purpose that needs a schema-shaped answer: `review.clause.json`, `review.collection_clause.json`, `playbook.draft.json`, `playbook.suggest.json`, `redlines.infer.json`, `changeset.build.json`. Each is a complete OpenAI-shaped envelope whose `content` is a JSON string matching that call site's schema — copy the schemas from `extractClause.ts`, `extractCollectionClause.ts`, `generateDraft.ts`, `suggestField.ts`, `inferPositions.ts` and `buildChangeset.ts`.

**Make every value obviously fake and say so in the value itself** — `"summary": "RECORDED — a stored development response, not a review of this document."` — so a screenshot taken against the recorded provider cannot be mistaken for a real one even with the banner cropped out.

`apps/gateway/fixtures/recorded/streams/assistant.chat.txt` is the SSE fixture, in the same OpenAI-shaped format as Task 10's `openai.txt`.

- [ ] **Step 6: Mark it on the wire and in the app**

In `routes/infer.ts` and `routes/inferStream.ts`, add `reply.header('X-LexPrompt-Provider', entry.provider)` — for every provider, not only this one. A header present only for `recorded` would make its *absence* carry meaning, which is the blank-CSV-cell defect S27's own reasoning names.

In `src/features/settings/ModelPicker.tsx` and the app shell (Task 22), render a **non-dismissible** banner whenever the selected model's `provider === 'recorded'`:

> **These answers are recorded fixtures, not a model.** LexPrompt is configured with the offline `recorded` provider. Nothing here has been read by an AI, and nothing here is about your documents.

- [ ] **Step 7: Run the tests**

Run: `npx vitest run --project gateway`
Expected: PASS — `recorded.test.ts` 10 tests, and `adapterConformance` now 37 (Task 10), including six rows for `recorded`.

- [ ] **Step 8: Verify by hand**

```bash
cat > /tmp/lexprompt/models.json <<'JSON'
{"models":[{"id":"offline","provider":"recorded","model":"recorded",
"label":"Recorded responses (offline)",
"jurisdiction":{"bloc":"other","region":"local","label":"this machine — recorded responses, not a model"},
"contextLength":128000,"supportsImages":true,"supportsStructuredOutput":true,"isDefault":true,
"endpoint":"file:///fixtures/recorded","credential":{"source":"env","var":"UNUSED"}}]}
JSON
GATEWAY_MODELS_FILE=/tmp/lexprompt/models.json \
GATEWAY_CALLER_AUTH=mtls GATEWAY_MTLS_CA_FILE=certs/ca.pem \
GATEWAY_MTLS_CERT_FILE=certs/gateway.pem GATEWAY_MTLS_KEY_FILE=certs/gateway.key \
GATEWAY_MTLS_ALLOWED_SUBJECT=lexprompt-api \
  npx tsx apps/gateway/src/main.ts; echo "exit=$?"
```

Expected: refusal naming `offline`, `recorded`, `other · this machine — recorded responses, not a model` and `GATEWAY_ALLOWED_JURISDICTIONS`; `exit=1`. Re-run with `GATEWAY_ALLOWED_JURISDICTIONS=other` and it starts, with the boot banner naming the recorded row.

- [ ] **Step 9: Mutation test — two mutations**

1. **The S27 refusal.** Add `'other'` to `allowedJurisdictions` inside `loadConfig` after parsing, rather than requiring the operator to write it. Run. Expected: FAIL on *"a deployment that has not declared `other` refuses to start with it, naming it"*. Restore.
2. **The honesty check.** Delete the `provider === 'recorded' && bloc !== 'other'` loop. Run. Expected: FAIL on *"refuses a recorded entry that declares a real-looking jurisdiction"*. Restore.

The second is the mutation that matters: without it, an operator can hide the recorded provider behind `UK South`, and all four markings then agree with each other about something false.

- [ ] **Step 10: Commit**

```bash
git add apps/gateway/src/adapters/recorded.ts apps/gateway/src/adapters/registry.ts apps/gateway/src/config.ts apps/gateway/src/routes apps/gateway/src/main.ts apps/gateway/fixtures apps/gateway/test/recorded.test.ts
git commit -F .git/COMMIT_MSG_TASK13
```

```
feat(gateway): the recorded provider is an adapter, not a bypass

Spec Revision 2 / §5.1 changed this and the change is the point. It was a
transport chosen by an environment flag — a second code path selected by a
branch on the environment, which is exactly what S30 forbids and what would
make a green local run evidence about a system nobody deploys.

It is now registered like any other provider: an operator selects it in
models.json, it passes adapterConformance through the same decoders the four
OpenAI-shaped providers use, and a firm deployment refuses it through S27's
jurisdiction gate rather than a guard somebody had to remember to write.

Its declared jurisdiction is 'other · this machine — recorded responses, not
a model', and config.ts refuses a recorded entry that claims anything else —
without that, an operator could hide it behind UK South and all four
markings would agree with each other about something false.

Marked in four places: the returned provider, the audit record, an
X-LexPrompt-Provider header sent for EVERY provider (present only for this
one would make its absence carry meaning), and a non-dismissible banner. It
is the one local component that can produce a confident wrong answer.

Mutation-tested: 'other' added to the default allowed set (1 test fails);
the jurisdiction honesty check removed (1). Restored.
```

---

## Task 14: Budgets and rate limits

**Type:** application code

**Files:**
- Create: `apps/gateway/src/rateLimit.ts`, `apps/gateway/test/rateLimit.test.ts`
- Modify: `apps/gateway/src/config.ts` (four more limits), `apps/gateway/src/main.ts`

**Interfaces:**
- Consumes: `InferUsage`, `ModelError` (Task 2).
- Produces:
  - `interface RateLimiter { check(workspaceId: string, actorSubject: string): void; record(workspaceId: string, actorSubject: string, usage: InferUsage): void }`
  - `class WindowRateLimiter implements RateLimiter` — constructed with `{ requestsPerMinutePerActor, requestsPerMinutePerWorkspace, tokensPerHourPerActor, tokensPerHourPerWorkspace, now }`
  - Config: `GATEWAY_RPM_PER_ACTOR` (default 60), `GATEWAY_RPM_PER_WORKSPACE` (600), `GATEWAY_TOKENS_PER_HOUR_PER_ACTOR` (2_000_000), `GATEWAY_TOKENS_PER_HOUR_PER_WORKSPACE` (20_000_000)

- [ ] **Step 1: Write the failing test**

`apps/gateway/test/rateLimit.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { WindowRateLimiter } from '../src/rateLimit.ts';

const make = (over = {}) => {
  let clock = 1_000_000;
  const limiter = new WindowRateLimiter({
    requestsPerMinutePerActor: 3,
    requestsPerMinutePerWorkspace: 5,
    tokensPerHourPerActor: 100,
    tokensPerHourPerWorkspace: 200,
    now: () => clock,
    ...over,
  });
  return { limiter, advance: (ms: number) => { clock += ms; } };
};

describe('WindowRateLimiter', () => {
  it('allows requests up to the per-actor limit', () => {
    const { limiter } = make();
    for (let i = 0; i < 3; i++) { limiter.check('ws', 'a'); limiter.record('ws', 'a', { promptTokens: 1, completionTokens: 0 }); }
    expect(() => limiter.check('ws', 'a')).toThrowError(
      expect.objectContaining({ code: 'budget_exhausted', status: 429 }));
  });

  it('does not let one actor exhaust another actor\'s allowance', () => {
    const { limiter } = make();
    for (let i = 0; i < 3; i++) { limiter.check('ws', 'a'); limiter.record('ws', 'a', { promptTokens: 1, completionTokens: 0 }); }
    expect(() => limiter.check('ws', 'b')).not.toThrow();
  });

  it('enforces the workspace request limit across actors', () => {
    const { limiter } = make();
    for (const actor of ['a', 'b']) {
      for (let i = 0; i < 2; i++) { limiter.check('ws', actor); limiter.record('ws', actor, { promptTokens: 1, completionTokens: 0 }); }
    }
    limiter.check('ws', 'c'); limiter.record('ws', 'c', { promptTokens: 1, completionTokens: 0 });
    expect(() => limiter.check('ws', 'd')).toThrow(/workspace/i);
  });

  it('forgets requests once the minute window has passed', () => {
    const { limiter, advance } = make();
    for (let i = 0; i < 3; i++) { limiter.check('ws', 'a'); limiter.record('ws', 'a', { promptTokens: 1, completionTokens: 0 }); }
    advance(61_000);
    expect(() => limiter.check('ws', 'a')).not.toThrow();
  });

  it('enforces the token budget over the hour window', () => {
    const { limiter } = make();
    limiter.check('ws', 'a');
    limiter.record('ws', 'a', { promptTokens: 90, completionTokens: 20 });
    expect(() => limiter.check('ws', 'a')).toThrow(/token/i);
  });

  it('forgets tokens once the hour window has passed', () => {
    const { limiter, advance } = make();
    limiter.check('ws', 'a');
    limiter.record('ws', 'a', { promptTokens: 90, completionTokens: 20 });
    advance(3_601_000);
    expect(() => limiter.check('ws', 'a')).not.toThrow();
  });

  it('says which limit was hit and when it clears, so the message is actionable', () => {
    const { limiter } = make();
    for (let i = 0; i < 3; i++) { limiter.check('ws', 'a'); limiter.record('ws', 'a', { promptTokens: 1, completionTokens: 0 }); }
    expect(() => limiter.check('ws', 'a')).toThrow(/3 requests a minute[\s\S]*try again/i);
  });

  it('scopes an unknown workspace separately rather than sharing a bucket', () => {
    const { limiter } = make();
    for (let i = 0; i < 3; i++) { limiter.check('ws1', 'a'); limiter.record('ws1', 'a', { promptTokens: 1, completionTokens: 0 }); }
    expect(() => limiter.check('ws2', 'a')).not.toThrow();
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `npx vitest run --project gateway apps/gateway/test/rateLimit.test.ts`
Expected: FAIL — `Failed to resolve import "../src/rateLimit.ts"`.

- [ ] **Step 3: Implement**

```ts
import { ModelError, type InferUsage } from '@lexprompt/core';

export interface RateLimiter {
  check(workspaceId: string, actorSubject: string): void;
  record(workspaceId: string, actorSubject: string, usage: InferUsage): void;
}

interface Window { at: number; tokens: number }

/**
 * §10's budgets, per workspace and per actor, in requests and in tokens.
 *
 * In-process, which is correct while the gateway runs as one replica and is
 * the honest limit of it: Stage 2 or a scale-out needs a shared store, and
 * the interface exists so that is one implementation and no call sites.
 * Recorded as a Stage 2 interface at the end of this plan rather than left
 * for someone to discover under load.
 */
export class WindowRateLimiter implements RateLimiter {
  #opts: {
    requestsPerMinutePerActor: number;
    requestsPerMinutePerWorkspace: number;
    tokensPerHourPerActor: number;
    tokensPerHourPerWorkspace: number;
    now(): number;
  };
  #events = new Map<string, Window[]>();

  constructor(opts: WindowRateLimiter['#opts']) { this.#opts = opts; }

  #recent(key: string, windowMs: number): Window[] {
    const cutoff = this.#opts.now() - windowMs;
    const kept = (this.#events.get(key) ?? []).filter(e => e.at > cutoff);
    this.#events.set(key, kept);
    return kept;
  }

  check(workspaceId: string, actorSubject: string): void {
    // Keyed on (workspace, subject). The subject is issuer-scoped, so two
    // issuers' subjects can never collide in one deployment — and a
    // deployment has one issuer anyway.
    const actor = `a:${workspaceId}:${actorSubject}`;
    const ws = `w:${workspaceId}`;
    const o = this.#opts;

    if (this.#recent(actor, 60_000).length >= o.requestsPerMinutePerActor) {
      throw new ModelError(
        `You have reached this workspace's limit of ${o.requestsPerMinutePerActor} requests a `
        + 'minute. Nothing is lost — try again shortly.',
        'budget_exhausted', 429);
    }
    if (this.#recent(ws, 60_000).length >= o.requestsPerMinutePerWorkspace) {
      throw new ModelError(
        `This workspace has reached its limit of ${o.requestsPerMinutePerWorkspace} requests a `
        + 'minute across everyone using it. Nothing is lost — try again shortly.',
        'budget_exhausted', 429);
    }
    const actorTokens = this.#recent(actor, 3_600_000).reduce((n, e) => n + e.tokens, 0);
    if (actorTokens >= o.tokensPerHourPerActor) {
      throw new ModelError(
        `You have reached this workspace's hourly token budget (${o.tokensPerHourPerActor}). `
        + 'Nothing is lost — try again later, or ask an administrator to raise it.',
        'budget_exhausted', 429);
    }
    const wsTokens = this.#recent(ws, 3_600_000).reduce((n, e) => n + e.tokens, 0);
    if (wsTokens >= o.tokensPerHourPerWorkspace) {
      throw new ModelError(
        `This workspace has reached its hourly token budget (${o.tokensPerHourPerWorkspace}) `
        + 'across everyone using it. Nothing is lost — try again later.',
        'budget_exhausted', 429);
    }
  }

  record(workspaceId: string, actorSubject: string, usage: InferUsage): void {
    const at = this.#opts.now();
    const tokens = usage.promptTokens + usage.completionTokens;
    for (const key of [`a:${workspaceId}:${actorSubject}`, `w:${workspaceId}`]) {
      this.#events.set(key, [...(this.#events.get(key) ?? []), { at, tokens }]);
    }
  }
}
```

**`check` runs before the audit record and before the credential**, in `prepare` — a refused request is not an egress and should not consume a credential or produce a started record with no call. Confirm the order in `callModel.ts` matches: purpose, model, prompt size, **limiter**, credential, audit, socket.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run --project gateway apps/gateway/test/rateLimit.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Mutation test the per-actor scoping**

Change `const actor = \`a:${workspaceId}:${actorSubject}\`` to `const actor = \`a:${workspaceId}\``. Run. Expected: FAIL on *"does not let one actor exhaust another actor's allowance"*. Restore.

- [ ] **Step 6: Commit**

```bash
git add apps/gateway/src/rateLimit.ts apps/gateway/test/rateLimit.test.ts apps/gateway/src/config.ts apps/gateway/src/callModel.ts apps/gateway/src/main.ts
git commit -F .git/COMMIT_MSG_TASK14
```

```
feat(gateway): request and token budgets, per workspace and per actor

Checked before the credential and before the audit record — a refused
request is not an egress and should not consume either. The messages name
the limit that was hit and say nothing is lost.

In-process, which is right for one replica and is the honest limit of it: a
scale-out needs a shared store, and the RateLimiter interface exists so
that is one implementation and no call sites. Recorded as a Stage 2
interface rather than left to be discovered under load.

Mutation-tested: per-actor key collapsed to per-workspace, one test fails.
```

---

## Task 15: Caller authentication — only `apps/api` may call the gateway

**Type:** infrastructure

**Files:**
- Create: `apps/gateway/src/callerAuth.ts`, `apps/gateway/test/callerAuth.test.ts`, `scripts/dev-certs.sh`
- Modify: `apps/gateway/src/server.ts`, `apps/gateway/src/main.ts`, `.gitignore`

**Interfaces:**
- Consumes: `CallerAuthConfig` (Task 4).
- Produces: `makeCallerAuthHook(config: CallerAuthConfig, verifyEntra): (req, reply) => Promise<void>` — a Fastify `preHandler` that rejects with 401 before any route body runs.

**Two modes, per §10.** In Azure the gateway has **internal-only ingress** and validates an OIDC token whose audience is the gateway's own app registration and whose subject is `apps/api`'s workload identity. In compose it uses **mTLS**: the gateway is an HTTPS server with `requestCert: true, rejectUnauthorized: true` against a locally generated CA, and additionally checks the client certificate's subject CN. **`mode: 'none'` is not reachable from configuration at all** (Task 4) — it exists as a type so a unit test can construct one, and no `GATEWAY_CALLER_AUTH` value produces it. That is stronger than refusing it under `NODE_ENV=production`, and it is the only version compatible with S30's "no module branches on the environment": a mode that behaves differently in one environment is the environment branch, wearing a security control's clothes.

- [ ] **Step 1: Write the failing test**

`apps/gateway/test/callerAuth.test.ts` — cases:
1. `mode: 'none'`, **constructed directly rather than through `loadConfig`**, allows any request — and a separate assertion that no `GATEWAY_CALLER_AUTH` value produces it (Task 4's test), so the permissive branch exists only where a unit test can reach it.
2. `mode: 'mtls'` rejects 401 when `req.socket.authorized` is false, naming that a client certificate is required.
3. `mode: 'mtls'` rejects 401 when the certificate's `subject.CN` is not `allowedSubject`, **naming the CN it saw**.
4. `mode: 'mtls'` allows when authorized and the CN matches.
5. `mode: 'entra'` rejects 401 with no `Authorization` header.
6. `mode: 'entra'` rejects when `verifyEntra` throws.
7. `mode: 'entra'` rejects when the token's `oid` is not in `allowedObjectIds`, naming neither the token nor the oid in the response body (only in the log) — a 401 body that echoes a token is a token in a proxy log.
8. `mode: 'entra'` allows when `verifyEntra` resolves with an allowed `oid`.
9. **The mutation-proof case:** with `mode: 'mtls'`, a request carrying a valid *Entra* token but no client certificate is still rejected — the two modes never fall back to each other.

Write each with `app.inject` against a Fastify instance whose only route is `POST /v1/infer` returning `{ ok: true }`, and a `req.socket` stubbed via `app.addHook('onRequest', …)` in the harness.

- [ ] **Step 2: Implement `callerAuth.ts`**

```ts
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { TLSSocket } from 'node:tls';
import type { CallerAuthConfig } from './config.ts';

export type VerifyEntra = (token: string, tenantId: string, audience: string)
  => Promise<{ oid: string }>;

/**
 * §10: "Only `apps/api`, authenticated by its Azure managed identity (or
 * mTLS in local compose)."
 *
 * The gateway does NOT validate a user's token — it has no user model and
 * no roles. It validates its one caller. That is what makes
 * `workspaceId` and the actor in the request body trustworthy: they were
 * put there by `apps/api` from a token `apps/api` validated, and nothing
 * else can reach this port.
 *
 * The two modes never fall back to each other. A gateway configured for
 * mTLS that accepted a bearer token instead would be a gateway with two
 * front doors, one of which nobody remembered to lock.
 */
export function makeCallerAuthHook(config: CallerAuthConfig, verifyEntra: VerifyEntra) {
  return async function callerAuth(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    if (config.mode === 'none') return;

    if (config.mode === 'mtls') {
      const socket = req.raw.socket as TLSSocket;
      if (!socket.authorized) {
        void reply.code(401).send({ error: { code: 'not_permitted',
          message: 'A client certificate is required to call this gateway.' } });
        return reply;
      }
      const cn = socket.getPeerCertificate()?.subject?.CN;
      if (cn !== config.allowedSubject) {
        void reply.code(401).send({ error: { code: 'not_permitted',
          message: `Client certificate CN ${JSON.stringify(cn)} is not permitted.` } });
        return reply;
      }
      return;
    }

    const header = req.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7) : '';
    if (!token) {
      void reply.code(401).send({ error: { code: 'not_permitted',
        message: 'This gateway is reachable only by the LexPrompt API.' } });
      return reply;
    }
    try {
      const { oid } = await verifyEntra(token, config.tenantId, config.audience);
      if (config.allowedObjectIds.length && !config.allowedObjectIds.includes(oid)) {
        // The oid goes to the log, not to the body: a 401 body that echoes
        // identity details is identity details in every proxy log between
        // here and the caller.
        process.stderr.write(`callerAuth: rejected oid ${oid}\n`);
        void reply.code(401).send({ error: { code: 'not_permitted',
          message: 'This identity is not permitted to call the gateway.' } });
        return reply;
      }
    } catch (err) {
      process.stderr.write(`callerAuth: token rejected: ${(err as Error).message}\n`);
      void reply.code(401).send({ error: { code: 'not_permitted',
        message: 'This gateway is reachable only by the LexPrompt API.' } });
      return reply;
    }
  };
}
```

Register it in `buildServer` with `app.addHook('preHandler', makeCallerAuthHook(deps.config.caller, deps.verifyEntra))`, and **exclude `/healthz`** by checking `req.url === '/healthz'` first — a liveness probe has no certificate and no token.

`parseCaller` in `config.ts` already refuses `none` **in every environment** (Task 4) — there is no configuration value that turns the caller check off, which is stronger than refusing it under `NODE_ENV=production` and is the only version compatible with S30's "no module branches on the environment". Confirm Task 4's test *"has NO configuration value that disables the caller check, in any environment"* is present and passing before continuing; do not add a second check here.

- [ ] **Step 3: Write the dev certificate script**

`scripts/dev-certs.sh` — generates `certs/ca.pem`, `certs/gateway.{pem,key}` (CN `gateway`, SAN `DNS:gateway,DNS:localhost`) and `certs/api.{pem,key}` (CN `lexprompt-api`) with `openssl req`/`openssl x509`, idempotently, into a `certs/` directory added to `.gitignore`. Print the four paths and the `GATEWAY_MTLS_*` / `API_MTLS_*` env lines to paste into `.env`.

In `main.ts`, when `config.caller.mode === 'mtls'`, construct Fastify with `https: { ca: readFileSync(caFile), cert: readFileSync(certFile), key: readFileSync(keyFile), requestCert: true, rejectUnauthorized: true }`.

- [ ] **Step 4: Run the tests, and verify by hand**

Run: `npx vitest run --project gateway apps/gateway/test/callerAuth.test.ts` — Expected: PASS, 10 tests.

```bash
bash scripts/dev-certs.sh
GATEWAY_CALLER_AUTH=mtls GATEWAY_MTLS_CA_FILE=certs/ca.pem \
GATEWAY_MTLS_CERT_FILE=certs/gateway.pem GATEWAY_MTLS_KEY_FILE=certs/gateway.key \
GATEWAY_MTLS_ALLOWED_SUBJECT=lexprompt-api \
GATEWAY_MODELS_FILE=/tmp/lexprompt/models.json \
GATEWAY_ALLOWED_JURISDICTIONS=UK,EU,US npx tsx apps/gateway/src/main.ts &
sleep 1
curl -sk https://localhost:8081/v1/models; echo "  <-- expect a TLS handshake failure"
curl -sk --cert certs/api.pem --key certs/api.key https://localhost:8081/v1/models
kill %1
```

Expected: the first `curl` fails the handshake (no client certificate); the second returns the model list.

- [ ] **Step 5: Mutation test the no-fallback rule**

In the `mtls` branch, after the `socket.authorized` check fails, add `if (req.headers.authorization) return;`. Run. Expected: FAIL on *"a request carrying a valid Entra token but no client certificate is still rejected"*. Restore.

- [ ] **Step 6: Commit**

```bash
git add apps/gateway/src/callerAuth.ts apps/gateway/test/callerAuth.test.ts apps/gateway/src/config.ts apps/gateway/src/server.ts apps/gateway/src/main.ts scripts/dev-certs.sh .gitignore
git commit -F .git/COMMIT_MSG_TASK15
```

```
feat(gateway): only apps/api may call it — mTLS locally, Entra in Azure

The gateway validates its one caller, not a user: it has no user model and
no roles. That is what makes workspaceId and the actor in the request body
trustworthy — apps/api put them there from a token it validated, and nothing
else can reach this port.

The two modes never fall back to each other, and no GATEWAY_CALLER_AUTH value
turns the check off — `none` exists as a type for unit tests and is
unreachable from configuration, which is stronger than refusing it under
NODE_ENV and is the only version compatible with S30. /healthz is excluded,
because a liveness probe has neither a certificate nor a token.

Mutation-tested: an Entra fallback added to the mTLS branch, one test fails.
```

---

## Task 16: The `apps/api` workspace and OIDC token validation against a configured issuer

**Type:** infrastructure

**Files:**
- Create: `apps/api/package.json`, `tsconfig.json`, `Dockerfile`, `.dockerignore`
- Create: `apps/api/src/config.ts`, `src/oidc.ts`, `src/server.ts`, `src/main.ts`
- Create: `apps/api/test/oidc.test.ts`
- Modify: root `tsconfig.json` (include), root `package.json` (script)

**Interfaces:**
- Consumes: `ModelError` (Task 2).
- Produces:
  - `interface AuthConfig { issuer: string; audience: string; subjectClaim: string; groupsClaim: string; requiredClaims: Record<string, string> }`
  - `interface Principal { issuer: string; subject: string; groups: string[]; name?: string; email?: string }`
  - `makeTokenVerifier(config: AuthConfig, jwks: JWTVerifyGetKey): (token: string) => Promise<Principal>` — throws `ModelError('sign_in_required', 401)`, or `ModelError('group_overage', 403)` on an overage token
  - `discoverJwks(issuer: string): Promise<JWTVerifyGetKey>` — reads `/.well-known/openid-configuration` and builds a remote key set from the `jwks_uri` it names
  - `assertIssuerUsable(issuer: string): void` — refuses an empty issuer and a non-HTTPS issuer that does not resolve to loopback
  - `requireUser(verify): FastifyPreHandler` — attaches `request.principal`
  - `interface ApiConfig { port: number; auth: AuthConfig; gatewayUrl: string; workspaceId: string; mtls?: { caFile: string; certFile: string; keyFile: string } }`

**This task changed with spec Revision 2 (§7, S28).** It was Entra-specific. It is now **standards OIDC against a configured issuer** — Entra ID in a firm deployment, Keycloak in `docker compose`, and **the application does not know which**. There is no Entra branch, and the three things that used to be one are now three configuration values:

| Was | Is |
|---|---|
| `issuer` built as `https://login.microsoftonline.com/${tenantId}/v2.0` | `issuer` is configuration, and the JWKS URI comes from **its own discovery document**, not from a URL template |
| `if (payload.tid !== config.tenantId) throw` | `requiredClaims: { tid: '<tenant id>' }`, compared in a loop over whatever the configuration names |
| `payload.oid` | `payload[config.subjectClaim]` — `oid` for Entra, `sub` for Keycloak |

**That last column is the whole of S28.** A tenant check written as a code branch is an Entra special case however carefully it is commented; a tenant check written as a configured required claim is a general mechanism that happens to be configured with a tenant id. The `auth` suite asserts the difference rather than trusting it.

**Stage boundary:** this derives a `Principal` and nothing else. No `app_user` row, no role mapping, no role gate — all Stage 2 (§13). `workspaceId` is a single configured value, the one workspace §6 seeds. That keeps Stage 1 honestly single-user while making the audit record's actor real and issuer-scoped.

- [ ] **Step 1: Create the workspace**

`apps/api/package.json` — same shape as the gateway's, with dependencies `@lexprompt/core`, `fastify`, `undici`, `jose`. **No `@azure/identity`** unless Task 25's gateway-bound workload-identity token needs it, and no MSAL anywhere.

`apps/api/tsconfig.json` — copy the gateway's, changing only the `include`. Add `"apps/api/src"`, `"apps/api/test"` to the root `tsconfig.json`. `apps/api/Dockerfile` — copy the gateway's, substituting `@lexprompt/api`, port 8080 and `apps/api/src/main.ts`.

- [ ] **Step 2: Write the failing tests**

`apps/api/test/oidc.test.ts`. Generate a key pair with `jose`'s `generateKeyPair('RS256')`, sign tokens with `SignJWT`, and pass a local key set, so no network and no tenant are needed:

```ts
import { describe, it, expect, beforeAll } from 'vitest';
import { SignJWT, exportJWK, generateKeyPair, createLocalJWKSet, type KeyLike } from 'jose';
import { makeTokenVerifier, assertIssuerUsable, type AuthConfig } from '../src/oidc.ts';

const ENTRA: AuthConfig = {
  issuer: 'https://login.microsoftonline.com/11111111-1111-1111-1111-111111111111/v2.0',
  audience: 'api://lexprompt',
  subjectClaim: 'oid',
  groupsClaim: 'groups',
  requiredClaims: { tid: '11111111-1111-1111-1111-111111111111' },
};

const KEYCLOAK: AuthConfig = {
  issuer: 'https://keycloak.local/realms/lexprompt',
  audience: 'lexprompt-api',
  subjectClaim: 'sub',
  groupsClaim: 'groups',
  requiredClaims: {},
};

let privateKey: KeyLike;
let otherKey: KeyLike;
let jwks: ReturnType<typeof createLocalJWKSet>;

beforeAll(async () => {
  const pair = await generateKeyPair('RS256');
  privateKey = pair.privateKey;
  const jwk = await exportJWK(pair.publicKey);
  jwk.kid = 'k1'; jwk.alg = 'RS256';
  jwks = createLocalJWKSet({ keys: [jwk] });
  otherKey = (await generateKeyPair('RS256')).privateKey;
});

const sign = (cfg: AuthConfig, claims: Record<string, unknown>, key?: KeyLike, expIn = '10m') =>
  new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
    .setIssuer(cfg.issuer).setAudience(cfg.audience)
    .setIssuedAt().setExpirationTime(expIn)
    .sign(key ?? privateKey);

const entraToken = (over: Record<string, unknown> = {}) => sign(ENTRA, {
  tid: '11111111-1111-1111-1111-111111111111',
  oid: 'oid-1', groups: ['group-a'], name: 'A. Gray', preferred_username: 'a@firm.com', ...over,
});

const keycloakToken = (over: Record<string, unknown> = {}) => sign(KEYCLOAK, {
  sub: 'kc-sub-1', groups: ['/reviewers'], name: 'A. Trainee', email: 't@firm.local', ...over,
});

describe('one code path, two issuers (§7, S28)', () => {
  it('validates an Entra token and reads oid as the subject', async () => {
    expect(await makeTokenVerifier(ENTRA, jwks)(await entraToken())).toEqual({
      issuer: ENTRA.issuer, subject: 'oid-1', groups: ['group-a'],
      name: 'A. Gray', email: 'a@firm.com',
    });
  });

  it('validates a Keycloak token and reads sub as the subject, with the SAME function', async () => {
    expect(await makeTokenVerifier(KEYCLOAK, jwks)(await keycloakToken())).toEqual({
      issuer: KEYCLOAK.issuer, subject: 'kc-sub-1', groups: ['/reviewers'],
      name: 'A. Trainee', email: 't@firm.local',
    });
  });

  // The point of S28: neither issuer's token is accepted by the other's
  // configuration, and it is the SAME code refusing both.
  it('rejects a Keycloak token under the Entra configuration, and the reverse', async () => {
    await expect(makeTokenVerifier(ENTRA, jwks)(await keycloakToken()))
      .rejects.toMatchObject({ code: 'sign_in_required' });
    await expect(makeTokenVerifier(KEYCLOAK, jwks)(await entraToken()))
      .rejects.toMatchObject({ code: 'sign_in_required' });
  });
});

describe('token validation', () => {
  const verify = () => makeTokenVerifier(ENTRA, jwks);

  it('rejects a token signed by another key', async () => {
    await expect(verify()(await entraToken() && await sign(ENTRA, { oid: 'o', tid: ENTRA.requiredClaims.tid }, otherKey)))
      .rejects.toMatchObject({ code: 'sign_in_required', status: 401 });
  });

  it('rejects a token for another audience', async () => {
    const t = await new SignJWT({ oid: 'o', tid: ENTRA.requiredClaims.tid })
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
      .setIssuer(ENTRA.issuer).setAudience('api://something-else')
      .setIssuedAt().setExpirationTime('10m').sign(privateKey);
    await expect(verify()(t)).rejects.toMatchObject({ code: 'sign_in_required' });
  });

  it('rejects an expired token', async () => {
    await expect(verify()(await entraToken({}, ) && await sign(ENTRA,
      { oid: 'o', tid: ENTRA.requiredClaims.tid }, privateKey, '-1m')))
      .rejects.toMatchObject({ code: 'sign_in_required' });
  });

  // The tenant check, as a CONFIGURED required claim rather than a code
  // branch. This test is the difference between "never special-cases Entra"
  // being true and being intended.
  it('rejects a token whose required claim does not match', async () => {
    await expect(verify()(await entraToken({ tid: '22222222-2222-2222-2222-222222222222' })))
      .rejects.toMatchObject({ code: 'sign_in_required' });
  });

  it('enforces required claims generically, not just tid', async () => {
    const cfg = { ...KEYCLOAK, requiredClaims: { realm: 'lexprompt' } };
    await expect(makeTokenVerifier(cfg, jwks)(await sign(cfg, { sub: 's', realm: 'other' })))
      .rejects.toMatchObject({ code: 'sign_in_required' });
    await expect(makeTokenVerifier(cfg, jwks)(await sign(cfg, { sub: 's', realm: 'lexprompt' })))
      .resolves.toMatchObject({ subject: 's' });
  });

  it('rejects a token missing the configured subject claim, rather than inventing an actor', async () => {
    await expect(verify()(await sign(ENTRA, { tid: ENTRA.requiredClaims.tid })))
      .rejects.toThrow(/oid/);
  });

  it('rejects an empty or malformed token without throwing something unhandled', async () => {
    await expect(verify()('')).rejects.toMatchObject({ code: 'sign_in_required' });
    await expect(verify()('not.a.token')).rejects.toMatchObject({ code: 'sign_in_required' });
  });

  it('never puts the token into the error message', async () => {
    const token = await sign(ENTRA, { oid: 'o' }, otherKey);
    await expect(verify()(token)).rejects.not.toThrow(new RegExp(token.slice(0, 24)));
  });
});

// ===================================================================
// Entra group overage (§7). Keycloak CANNOT reproduce this — no seeded
// user is in enough groups — so this is a unit test over a crafted token,
// and it is the clearest case in Stage 1 where a green local run proves
// nothing about the tenant.
// ===================================================================
describe('group overage is its own error, never "in no mapped group"', () => {
  const verify = () => makeTokenVerifier(ENTRA, jwks);

  it('reports overage when the groups claim is ABSENT and _claim_names points at it', async () => {
    const t = await entraToken({
      groups: undefined,
      _claim_names: { groups: 'src1' },
      _claim_sources: { src1: { endpoint: 'https://graph.microsoft.com/v1.0/users/oid-1/getMemberObjects' } },
    });
    await expect(verify()(t)).rejects.toMatchObject({ code: 'group_overage', status: 403 });
  });

  it('names overage and tells the user to contact an admin, not to sign in again', async () => {
    const t = await entraToken({ groups: undefined, _claim_names: { groups: 'src1' } });
    await expect(verify()(t)).rejects.toThrow(/too many groups[\s\S]*administrator/i);
  });

  // The distinction the whole case exists for. Three states, three outcomes.
  it('an EMPTY groups array is not overage — it is genuinely no groups', async () => {
    const p = await verify()(await entraToken({ groups: [] }));
    expect(p.groups).toEqual([]);
  });

  it('an ABSENT groups claim with no _claim_names is not overage either', async () => {
    const p = await verify()(await entraToken({ groups: undefined }));
    expect(p.groups).toEqual([]);
  });

  it('a populated groups claim is neither', async () => {
    const p = await verify()(await entraToken({ groups: ['a', 'b'] }));
    expect(p.groups).toEqual(['a', 'b']);
  });

  it('detects overage on any configured groups claim name, not just "groups"', async () => {
    const cfg = { ...ENTRA, groupsClaim: 'roles' };
    const t = await sign(cfg, {
      oid: 'o', tid: cfg.requiredClaims.tid, _claim_names: { roles: 'src1' },
    });
    await expect(makeTokenVerifier(cfg, jwks)(t))
      .rejects.toMatchObject({ code: 'group_overage' });
  });
});

describe('the API refuses to start on an unusable issuer (S29)', () => {
  it('refuses an empty issuer', () => {
    expect(() => assertIssuerUsable('')).toThrow(/no issuer/i);
  });

  it('refuses a non-HTTPS issuer that is not loopback', () => {
    expect(() => assertIssuerUsable('http://idp.example.com/realms/x'))
      .toThrow(/https[\s\S]*loopback/i);
  });

  it('allows http on loopback, which is what compose serves', () => {
    expect(() => assertIssuerUsable('http://localhost:8088/realms/lexprompt')).not.toThrow();
    expect(() => assertIssuerUsable('http://127.0.0.1:8088/realms/lexprompt')).not.toThrow();
    expect(() => assertIssuerUsable('http://keycloak:8080/realms/lexprompt')).not.toThrow();
  });

  it('allows any https issuer', () => {
    expect(() => assertIssuerUsable('https://login.microsoftonline.com/t/v2.0')).not.toThrow();
  });
});

// S29's absence, mutation-tested in Step 7 and asserted here at rest.
describe('there is no authentication bypass anywhere in apps/api', () => {
  it('no source file mentions a bypass flag, an anonymous mode or a trusted header', async () => {
    const { readFileSync, readdirSync, statSync } = await import('node:fs');
    const path = await import('node:path');
    const SRC = path.resolve(__dirname, '../src');
    const walk = (dir: string, out: string[] = []): string[] => {
      for (const e of readdirSync(dir)) {
        const full = path.join(dir, e);
        if (statSync(full).isDirectory()) walk(full, out);
        else if (full.endsWith('.ts')) out.push(full);
      }
      return out;
    };
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      const text = readFileSync(file, 'utf8');
      for (const bad of ['SKIP_AUTH', 'DISABLE_AUTH', 'ALLOW_ANONYMOUS', 'x-trusted-user', 'AUTH_BYPASS']) {
        if (text.includes(bad)) offenders.push(`${path.basename(file)} mentions ${bad}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
```

**Note on `assertIssuerUsable` and `keycloak:8080`:** a compose service name is not literally loopback, and treating it as such would widen the rule. Implement it as *loopback, or a hostname with no dots* — a bare service name cannot be a public host, and a public issuer always has a dotted domain. Say so in the code comment, because the rule looks arbitrary otherwise.

- [ ] **Step 3: Run and watch them fail**

Run: `npx vitest run --project api`
Expected: FAIL — `Failed to resolve import "../src/oidc.ts"`.

- [ ] **Step 4: Implement `oidc.ts`**

```ts
import { jwtVerify, createRemoteJWKSet, type JWTVerifyGetKey } from 'jose';
import { ModelError } from '@lexprompt/core';

/**
 * The whole of what varies between the two environments (§7, §5.1 row 1).
 * Entra ID and Keycloak differ in these five values and in nothing else —
 * no branch, no flag, no second module.
 */
export interface AuthConfig {
  issuer: string;
  audience: string;
  /** 'oid' for Entra (stable across the tenant); 'sub' elsewhere. */
  subjectClaim: string;
  /** Named, never assumed. */
  groupsClaim: string;
  /** { tid: <tenant id> } for Entra. Compared generically. */
  requiredClaims: Record<string, string>;
}

/**
 * Identity is (issuer, subject), never the email (§7).
 *
 * An email can be reassigned; an issuer-scoped subject cannot. The pair is
 * also what makes one implementation correct against both issuers: a
 * Keycloak `sub` and an Entra `oid` are both opaque stable strings, and
 * neither is ever compared with the other.
 */
export interface Principal {
  issuer: string;
  subject: string;
  groups: string[];
  name?: string;
  email?: string;
}

/**
 * Refuses an issuer the API must not start with (S29).
 *
 * "Loopback, or a hostname with no dots": a bare compose service name
 * (`keycloak`) cannot be a public host, and a public issuer always has a
 * dotted domain. The rule looks arbitrary without that sentence, which is
 * why the sentence is here.
 */
export function assertIssuerUsable(issuer: string): void {
  if (!issuer) {
    throw new Error(
      'No issuer is configured. The API will not start without one: a misconfiguration '
      + 'must not become a system that runs and mostly works.',
    );
  }
  let url: URL;
  try {
    url = new URL(issuer);
  } catch {
    throw new Error(`The configured issuer ${JSON.stringify(issuer)} is not a URL.`);
  }
  if (url.protocol === 'https:') return;
  const host = url.hostname;
  const loopback = host === 'localhost' || host === '127.0.0.1' || host === '::1'
    || !host.includes('.');
  if (!loopback) {
    throw new Error(
      `The configured issuer ${issuer} is not https and does not resolve to loopback. `
      + 'This is the check that makes a deployed environment pointed at a development '
      + 'issuer a startup failure rather than a silent one.',
    );
  }
}

/** Reads the issuer's own discovery document and builds a key set from the
 *  `jwks_uri` it names — never from a URL template, which would be an
 *  issuer-specific assumption wearing a helper's clothes. */
export async function discoverJwks(issuer: string): Promise<JWTVerifyGetKey> {
  const url = `${issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`OIDC discovery failed for ${issuer}: HTTP ${response.status}.`);
  }
  const doc = await response.json() as { jwks_uri?: string };
  if (!doc.jwks_uri) throw new Error(`OIDC discovery for ${issuer} names no jwks_uri.`);
  return createRemoteJWKSet(new URL(doc.jwks_uri));
}

/**
 * Validates a token against a CONFIGURED issuer. There is no Entra branch
 * here and there must never be one (S28): the tenant check is a required
 * claim, the subject is a named claim, and the group claim is a named claim.
 */
export function makeTokenVerifier(
  config: AuthConfig,
  jwks: JWTVerifyGetKey,
): (token: string) => Promise<Principal> {
  return async (token: string): Promise<Principal> => {
    let payload: Record<string, unknown>;
    try {
      ({ payload } = await jwtVerify(token, jwks, {
        issuer: config.issuer, audience: config.audience, algorithms: ['RS256'],
      }) as unknown as { payload: Record<string, unknown> });
    } catch (err) {
      // The token never reaches the message: an error string ends up in a
      // log, a browser console and a support ticket.
      throw new ModelError(
        `Your sign-in could not be verified (${(err as Error).message}). Sign in again.`,
        'sign_in_required', 401,
      );
    }

    for (const [claim, expected] of Object.entries(config.requiredClaims)) {
      if (payload[claim] !== expected) {
        throw new ModelError(
          `Your sign-in could not be verified (the ${claim} claim does not match this `
          + 'deployment). Sign in again.',
          'sign_in_required', 401,
        );
      }
    }

    const subject = payload[config.subjectClaim];
    if (typeof subject !== 'string' || !subject) {
      throw new ModelError(
        `Your sign-in could not be verified (the token carries no ${config.subjectClaim} `
        + 'claim). Sign in again.',
        'sign_in_required', 401,
      );
    }

    // §7: a missing group claim is not the same fact as an empty one.
    //
    // When a user belongs to more groups than a token can carry, Entra omits
    // `groups` entirely and emits `_claim_names` pointing at Microsoft Graph.
    // Read naively that is indistinguishable from "in no mapped group" — so a
    // partner in forty groups would be told they have no access, which is a
    // wrong answer delivered confidently. Three states, three outcomes:
    // populated, genuinely empty, and overage.
    //
    // Keycloak cannot reproduce this (§5.1): no seeded user is in enough
    // groups, so the local path is always the simple one and always works.
    // That is why this is specified and unit-tested rather than discovered.
    const raw = payload[config.groupsClaim];
    const claimNames = payload._claim_names as Record<string, unknown> | undefined;
    if (raw === undefined && claimNames && config.groupsClaim in claimNames) {
      throw new ModelError(
        'Your account is in too many groups for LexPrompt to read them from your sign-in '
        + '(group overage). This is not a problem you can fix by signing in again — ask '
        + 'your administrator to grant LexPrompt directory read access, or to reduce your '
        + 'group memberships.',
        'group_overage', 403,
      );
    }

    return {
      issuer: config.issuer,
      subject,
      groups: Array.isArray(raw) ? raw.filter((g): g is string => typeof g === 'string') : [],
      name: typeof payload.name === 'string' ? payload.name : undefined,
      email: typeof payload.email === 'string' ? payload.email
        : typeof payload.preferred_username === 'string' ? payload.preferred_username : undefined,
    };
  };
}
```

`config.ts` calls `assertIssuerUsable(auth.issuer)` at load, and `main.ts` exits non-zero with the message on failure, exactly as the gateway does for a jurisdiction. `server.ts` adds `requireUser`, a `preHandler` reading `Authorization: Bearer`, calling the verifier, setting `request.principal`, and answering with the `ModelError`'s own status and code — so a `group_overage` reaches the browser as 403 `group_overage` and not as 401 `sign_in_required`.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run --project api`
Expected: PASS, 23 tests.

- [ ] **Step 6: Mutation test the two things that would silently misclassify a person**

1. **Overage folded into "no groups".** Delete the `_claim_names` check, leaving `groups: []`. Run. Expected: FAIL on *"reports overage when the groups claim is ABSENT and _claim_names points at it"*, *"names overage and tells the user to contact an admin"* and *"detects overage on any configured groups claim name"*. Restore.
   This is the mutation worth naming twice: without it a partner in forty groups is told they have no access to the firm's own tool, and the message is wrong with complete confidence.
2. **The required-claim loop replaced by a tenant branch.** Replace the loop with `if (config.issuer.includes('microsoftonline') && payload.tid !== …)`. Run. Expected: FAIL on *"enforces required claims generically, not just tid"*. Restore.
   That branch is the Entra special case S28 forbids, and it type-checks perfectly.

- [ ] **Step 7: Mutation test the absence of a bypass (S29)**

Add to `server.ts`:

```ts
  if (process.env.SKIP_AUTH === '1') return;   // MUTATION — remove after the test fails
```

Run: `npx vitest run --project api`. Expected: FAIL on *"no source file mentions a bypass flag, an anonymous mode or a trusted header"*. Remove it.

**Mutation-testing an absence is unusual and it is deliberate** (§14, S29): it is the only way an absence stays true, because nothing else in a test suite fails when a bypass is *added*.

- [ ] **Step 8: Commit**

```bash
git add apps/api package.json package-lock.json tsconfig.json
git commit -F .git/COMMIT_MSG_TASK16
```

```
feat(api): OIDC token validation against a configured issuer

Standards OIDC, not Entra: discovery names the JWKS, the tenant check is a
CONFIGURED required claim rather than a code branch, and the subject is a
named claim — oid for Entra, sub for Keycloak. The same function validates
both issuers' tokens and refuses each under the other's configuration, which
is what makes "never special-cases Entra" true rather than intended (S28).

Identity is (issuer, subject), never the email. A Keycloak sub and an Entra
oid are both opaque stable strings and neither is ever compared with the
other.

Group overage is its own error. Entra omits `groups` entirely for a user in
too many groups and emits _claim_names instead; read naively that is "in no
mapped group", so a partner in forty groups would be told they have no
access — a wrong answer delivered confidently. Three states, three outcomes.
Keycloak cannot reproduce it, so it is a unit test over a crafted token, and
it is the clearest case in Stage 1 where a green local run proves nothing.

The API refuses to start with no issuer, and with a non-HTTPS issuer that is
not loopback — the check that makes a deployed environment pointed at a
development issuer a startup failure rather than a silent one.

Stage boundary: a Principal and nothing else. No app_user, no role mapping,
no role gate — all Stage 2.

Mutation-tested: overage folded into "no groups" (3 tests fail); the
required-claim loop replaced by a tid branch (1); and the absence of a
bypass, by adding SKIP_AUTH (1). All restored.
```

---

## Task 17: `apps/api` forwards `/v1/infer` and `/v1/models` — actor from the token, never the body

**Type:** application code

**Files:**
- Create: `apps/api/src/gatewayClient.ts`, `apps/api/src/routes/infer.ts`
- Create: `apps/api/test/infer.route.test.ts`
- Modify: `apps/api/src/server.ts`

**Interfaces:**
- Consumes: `Principal` — `{ issuer, subject, groups, name?, email? }` — and `requireUser` (Task 16); the gateway's `POST /v1/infer`, `GET /v1/models` (Task 11).
- Produces:
  - `interface GatewayClient { infer(body: unknown): Promise<{ status: number; json: unknown }>; models(): Promise<{ status: number; json: unknown }>; stream(body: unknown, signal: AbortSignal): Promise<{ status: number; headers: Record<string, string>; body: AsyncIterable<Uint8Array> | null; text(): Promise<string> }> }`
  - `registerInfer(app, gateway, workspaceId)`

**The one rule of this task.** The gateway trusts `workspaceId`, `actorIssuer` and `actorSubject` in the request body. `apps/api` therefore **overwrites** all three from the validated token — it does not merge, does not default, and does not accept a body-supplied value under any circumstance. A client that could set the actor could put a colleague's name on every call in the firm's audit log, which is a worse defect than any of the loud ones this stage is defending against, because it corrupts the record that answers §12's questions.

**And the actor is `(issuer, subject)`, never an Entra-shaped identifier** (§7, S28). `principal.subject` is whatever the issuer's configured `subjectClaim` named — `oid` under Entra, `sub` under Keycloak — and `principal.issuer` travels with it, unparsed and uncombined. Stage 2 keys `app_user` on the pair and `role_mapping` on `(issuer, group_value, role)`; **no schema in this system may carry an `entra_*` column.** Writing the two halves separately now is what lets Stage 2 join to records written before `app_user` existed, and it is why they are two fields rather than one composite string.

- [ ] **Step 1: Write the failing test**

`apps/api/test/infer.route.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { buildTestApi } from './helpers/apiHarness.ts';

const ISSUER = 'http://keycloak:8080/realms/lexprompt';
const PRINCIPAL = {
  issuer: ISSUER, subject: 'sub-real', groups: ['/reviewers'],
  name: 'A. Gray', email: 'a@firm.com',
};

describe('POST /v1/infer', () => {
  it('forwards the request and returns the gateway\'s response verbatim', async () => {
    const { app, calls } = buildTestApi({ principal: PRINCIPAL,
      inferResponse: { status: 200, json: { content: 'A.', usage: { promptTokens: 1, completionTokens: 1 },
        callId: 'c1', provider: 'openai',
        jurisdiction: { bloc: 'US', region: 'us', label: 'United States' } } } });
    const res = await app.inject({ method: 'POST', url: '/v1/infer',
      headers: { authorization: 'Bearer t' },
      payload: { modelChoiceId: 'm', purpose: 'review.clause', user: 'hi' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ content: 'A.', callId: 'c1' });
    expect(calls.infer[0]).toMatchObject({ modelChoiceId: 'm', purpose: 'review.clause', user: 'hi' });
  });

  it('sets the actor as (issuer, subject) from the token', async () => {
    const { app, calls } = buildTestApi({ principal: PRINCIPAL });
    await app.inject({ method: 'POST', url: '/v1/infer', headers: { authorization: 'Bearer t' },
      payload: { modelChoiceId: 'm', purpose: 'review.clause', user: 'hi' } });
    expect(calls.infer[0].actorIssuer).toBe(ISSUER);
    expect(calls.infer[0].actorSubject).toBe('sub-real');
  });

  // THE rule of this task.
  it('OVERWRITES a client-supplied actor rather than trusting it', async () => {
    const { app, calls } = buildTestApi({ principal: PRINCIPAL });
    await app.inject({ method: 'POST', url: '/v1/infer', headers: { authorization: 'Bearer t' },
      payload: { modelChoiceId: 'm', purpose: 'review.clause', user: 'hi',
                 actorSubject: 'sub-a-colleague', actorIssuer: 'https://evil.example',
                 workspaceId: 'another-firm' } });
    expect(calls.infer[0].actorSubject).toBe('sub-real');
    expect(calls.infer[0].actorIssuer).toBe(ISSUER);
    expect(calls.infer[0].workspaceId).toBe('ws-configured');
  });

  // The identity is issuer-scoped, and nothing anywhere assumes Entra's
  // shape. The same test with an Entra-shaped principal must pass unchanged.
  it('carries an Entra principal identically, with oid as the subject', async () => {
    const entra = { issuer: 'https://login.microsoftonline.com/t/v2.0', subject: 'oid-1', groups: [] };
    const { app, calls } = buildTestApi({ principal: entra });
    await app.inject({ method: 'POST', url: '/v1/infer', headers: { authorization: 'Bearer t' },
      payload: { modelChoiceId: 'm', purpose: 'review.clause', user: 'hi' } });
    expect(calls.infer[0].actorIssuer).toBe('https://login.microsoftonline.com/t/v2.0');
    expect(calls.infer[0].actorSubject).toBe('oid-1');
  });

  it('passes a group_overage refusal through as 403, not as 401', async () => {
    const { app, calls } = buildTestApi({ principal: null, principalError: {
      name: 'ModelError', code: 'group_overage', status: 403,
      message: 'Your account is in too many groups…',
    } });
    const res = await app.inject({ method: 'POST', url: '/v1/infer',
      headers: { authorization: 'Bearer t' },
      payload: { modelChoiceId: 'm', purpose: 'review.clause', user: 'hi' } });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: { code: 'group_overage' } });
    expect(calls.infer).toHaveLength(0);
  });

  it('refuses with 401 and never calls the gateway when there is no token', async () => {
    const { app, calls } = buildTestApi({ principal: null });
    const res = await app.inject({ method: 'POST', url: '/v1/infer',
      payload: { modelChoiceId: 'm', purpose: 'review.clause', user: 'hi' } });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: { code: 'sign_in_required' } });
    expect(calls.infer).toHaveLength(0);
  });

  it('passes the gateway\'s status and error code through unchanged', async () => {
    const { app } = buildTestApi({ principal: PRINCIPAL,
      inferResponse: { status: 400, json: { error: { code: 'model_not_allowed', message: 'no' } } } });
    const res = await app.inject({ method: 'POST', url: '/v1/infer',
      headers: { authorization: 'Bearer t' },
      payload: { modelChoiceId: 'nope', purpose: 'review.clause', user: 'hi' } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: 'model_not_allowed' } });
  });

  it('turns an unreachable gateway into a service_misconfigured 503, not a 500', async () => {
    const { app } = buildTestApi({ principal: PRINCIPAL, inferThrows: new Error('ECONNREFUSED') });
    const res = await app.inject({ method: 'POST', url: '/v1/infer',
      headers: { authorization: 'Bearer t' },
      payload: { modelChoiceId: 'm', purpose: 'review.clause', user: 'hi' } });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ error: { code: 'service_misconfigured' } });
  });
});

describe('GET /v1/models', () => {
  it('proxies the gateway\'s list rather than holding a copy (S14)', async () => {
    const models = [{ id: 'm', provider: 'openai', model: 'gpt-4o', label: 'GPT-4o',
      jurisdiction: { bloc: 'US', region: 'us', label: 'United States' }, contextLength: 1,
      supportsImages: false, supportsStructuredOutput: true, isDefault: true }];
    const { app } = buildTestApi({ principal: PRINCIPAL, modelsResponse: { status: 200, json: { models } } });
    const res = await app.inject({ method: 'GET', url: '/v1/models', headers: { authorization: 'Bearer t' } });
    expect(res.json()).toEqual({ models });
  });

  it('returns an EMPTY list as an empty list, not as an error', async () => {
    const { app } = buildTestApi({ principal: PRINCIPAL, modelsResponse: { status: 200, json: { models: [] } } });
    const res = await app.inject({ method: 'GET', url: '/v1/models', headers: { authorization: 'Bearer t' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ models: [] });
  });

  it('requires a token', async () => {
    const { app } = buildTestApi({ principal: null });
    expect((await app.inject({ method: 'GET', url: '/v1/models' })).statusCode).toBe(401);
  });
});
```

The last-but-one case is the network-era "empty is not broken" rule at its one Stage-1 site: an empty allowlist must arrive at the browser as a successful empty list so Task 22 can render *"no model has been configured yet"* rather than *"the model list could not be loaded"*.

- [ ] **Step 2: Run and watch it fail**

Run: `npx vitest run --project api apps/api/test/infer.route.test.ts`
Expected: FAIL — `Failed to resolve import './helpers/apiHarness.ts'`.

- [ ] **Step 3: Implement `gatewayClient.ts`**

```ts
import { readFileSync } from 'node:fs';
import { Agent, request } from 'undici';
import type { ApiConfig } from './config.ts';

/**
 * The ONLY outbound client in this service (S1: `api` may not egress).
 *
 * Everything that leaves `apps/api` goes through here, which is what makes
 * "the API cannot reach a model" checkable by reading one file as well as
 * by reading the network policy. A second `fetch` anywhere in `apps/api` is
 * a defect, and Task 24's egress test is what catches it if review does not.
 */
export function makeGatewayClient(config: ApiConfig, getGatewayToken?: () => Promise<string>) {
  const dispatcher = config.mtls
    ? new Agent({ connect: {
        ca: readFileSync(config.mtls.caFile),
        cert: readFileSync(config.mtls.certFile),
        key: readFileSync(config.mtls.keyFile),
      } })
    : undefined;

  const headers = async (): Promise<Record<string, string>> => ({
    'Content-Type': 'application/json',
    ...(getGatewayToken ? { Authorization: `Bearer ${await getGatewayToken()}` } : {}),
  });

  return {
    async infer(body: unknown) {
      const res = await request(`${config.gatewayUrl}/v1/infer`, {
        method: 'POST', dispatcher, headers: await headers(), body: JSON.stringify(body),
      });
      return { status: res.statusCode, json: await res.body.json() };
    },
    async models() {
      const res = await request(`${config.gatewayUrl}/v1/models`, {
        method: 'GET', dispatcher, headers: await headers(),
      });
      return { status: res.statusCode, json: await res.body.json() };
    },
    async stream(body: unknown, signal: AbortSignal) {
      const res = await request(`${config.gatewayUrl}/v1/infer/stream`, {
        method: 'POST', dispatcher, headers: await headers(),
        body: JSON.stringify(body), signal,
      });
      return {
        status: res.statusCode,
        headers: res.headers as Record<string, string>,
        body: res.body,
        text: () => res.body.text(),
      };
    },
  };
}
export type GatewayClient = ReturnType<typeof makeGatewayClient>;
```

- [ ] **Step 4: Implement `routes/infer.ts`**

```ts
import type { FastifyInstance } from 'fastify';
import type { GatewayClient } from '../gatewayClient.ts';
import type { Principal } from '../entra.ts';

export function registerInfer(
  app: FastifyInstance, gateway: GatewayClient, workspaceId: string,
): void {
  app.post('/v1/infer', async (request, reply) => {
    const principal = (request as { principal: Principal }).principal;
    const client = (request.body ?? {}) as Record<string, unknown>;

    // Spread FIRST, then overwrite. A client that could set the actor could
    // put a colleague's name on every call in the firm's audit log — which
    // corrupts the record that answers §12's questions, silently, and is
    // worse than any of the loud failures this stage defends against.
    // Never `{ workspaceId, actorIssuer, actorSubject, ...client }`.
    //
    // (issuer, subject), never an Entra-shaped id: `principal.subject` is
    // whatever the configured subjectClaim named, and the two halves stay
    // separate so Stage 2 can key app_user on the pair.
    const body = {
      ...client,
      workspaceId,
      actorIssuer: principal.issuer,
      actorSubject: principal.subject,
    };

    try {
      const { status, json } = await gateway.infer(body);
      return await reply.code(status).send(json);
    } catch (err) {
      return reply.code(503).send({ error: { code: 'service_misconfigured',
        message: 'LexPrompt could not reach the firm\'s AI service. This is a configuration '
          + 'problem in the deployment, not something you can fix here. '
          + `(${(err as Error).message})` } });
    }
  });

  app.get('/v1/models', async (_request, reply) => {
    try {
      const { status, json } = await gateway.models();
      return await reply.code(status).send(json);
    } catch (err) {
      return reply.code(503).send({ error: { code: 'service_misconfigured',
        message: 'The list of available models could not be loaded from the firm\'s AI service. '
          + `(${(err as Error).message})` } });
    }
  });
}
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run --project api`
Expected: PASS, 18 tests (9 from Task 16, 9 here).

- [ ] **Step 6: Mutation test the overwrite**

Move the spread after the overwrite: `const body = { workspaceId, actorIssuer: principal.issuer, actorSubject: principal.subject, ...client };`. Run. Expected: FAIL on *"OVERWRITES a client-supplied actor rather than trusting it"* and on the stream route's equivalent. Restore.

This is a one-character-class mutation — moving a spread — that a reviewer's eye slides over and that silently makes the audit log forgeable. It is the reason the test exists rather than a comment.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src apps/api/test package.json package-lock.json
git commit -F .git/COMMIT_MSG_TASK17
```

```
feat(api): forward /v1/infer and /v1/models, with the actor from the token

The gateway trusts workspaceId and the actor in the request body, so apps/api
overwrites them from the validated token — spread first, then overwrite,
never the other way round. A client that could set the actor could put a
colleague's name on every call in the firm's audit log, which corrupts the
record that answers §12's questions and does it silently.

The actor is (issuer, subject) and never an Entra-shaped id: the subject is
whatever the configured subjectClaim named — oid under Entra, sub under
Keycloak — and the two halves stay separate so Stage 2 can key app_user on
the pair. No schema in this system carries an entra_* column.

/v1/models proxies the gateway rather than holding a copy (S14), and an
empty allowlist comes back as an empty list with a 200, so the browser can
tell "none configured" from "could not load".

Mutation-tested: the spread moved after the overwrite, one test fails.
```

---

## Task 18: `apps/api`'s stream route is a byte-transparent pipe

**Type:** application code + test

**Files:**
- Create: `apps/api/src/routes/inferStream.ts`, `apps/api/test/inferStream.pipe.test.ts`
- Modify: `apps/api/src/server.ts`

**Interfaces:**
- Consumes: `GatewayClient.stream` (Task 17); `Principal` (Task 16).
- Produces: `registerInferStream(app, gateway, workspaceId)`.

**This is D1's middle hop, and its whole specification is: parse nothing.** `apps/api` must not import `createSseEventReader`, `decodeFrame`, `encodeFrame` or `sseFields`. It copies bytes. The test proves it by comparing the bytes out with the bytes in, over deliveries designed to break a re-framer.

- [ ] **Step 1: Write the failing test**

`apps/api/test/inferStream.pipe.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { buildTestApi } from './helpers/apiHarness.ts';

const BODY =
  'data: {"type":"delta","text":"one"}\n\n'
  + 'data: {"type":"delta","text":" two"}\n\n'
  + 'data: {"type":"done","usage":{"promptTokens":9,"completionTokens":2},"callId":"c1"}\n\n';

const post = (app: ReturnType<typeof buildTestApi>['app']) => app.inject({
  method: 'POST', url: '/v1/infer/stream', headers: { authorization: 'Bearer t' },
  payload: { modelChoiceId: 'm', purpose: 'assistant.chat', user: 'hi' },
});

describe('POST /v1/infer/stream — a byte pipe (D1)', () => {
  it('returns exactly the bytes the gateway sent', async () => {
    const { app } = buildTestApi({ principal: { issuer: 'iss', subject: 'o', groups: [] }, streamChunks: [BODY] });
    expect((await post(app)).body).toBe(BODY);
  });

  it('returns exactly the bytes when they arrive in three uneven chunks', async () => {
    const { app } = buildTestApi({ principal: { issuer: 'iss', subject: 'o', groups: [] },
      streamChunks: [BODY.slice(0, 17), BODY.slice(17, 61), BODY.slice(61)] });
    expect((await post(app)).body).toBe(BODY);
  });

  it('returns exactly the bytes when they arrive one byte at a time', async () => {
    const { app } = buildTestApi({ principal: { issuer: 'iss', subject: 'o', groups: [] }, streamChunks: [...BODY] });
    expect((await post(app)).body).toBe(BODY);
  });

  // A re-framer normalises CRLF. A pipe does not, and must not: the browser
  // parser handles CRLF, and something in the middle "helping" is how a
  // proxy becomes a participant in a bug nobody can locate.
  it('preserves CRLF separators byte for byte rather than normalising them', async () => {
    const crlf = BODY.replace(/\n/g, '\r\n');
    const { app } = buildTestApi({ principal: { issuer: 'iss', subject: 'o', groups: [] }, streamChunks: [crlf] });
    expect((await post(app)).body).toBe(crlf);
  });

  it('preserves a stream that ends with no trailing blank line', async () => {
    const cut = BODY.replace(/\n\n$/, '');
    const { app } = buildTestApi({ principal: { issuer: 'iss', subject: 'o', groups: [] }, streamChunks: [cut] });
    expect((await post(app)).body).toBe(cut);
  });

  it('preserves a truncated stream unchanged, so the browser sees the truncation', async () => {
    const truncated = 'data: {"type":"delta","text":"half"}\n\n';
    const { app } = buildTestApi({ principal: { issuer: 'iss', subject: 'o', groups: [] }, streamChunks: [truncated] });
    expect((await post(app)).body).toBe(truncated);
  });

  it('passes the gateway\'s content-type through', async () => {
    const { app } = buildTestApi({ principal: { issuer: 'iss', subject: 'o', groups: [] }, streamChunks: [BODY] });
    expect((await post(app)).headers['content-type']).toContain('text/event-stream');
  });

  it('answers a pre-stream failure with the gateway\'s status and body', async () => {
    const { app } = buildTestApi({ principal: { issuer: 'iss', subject: 'o', groups: [] },
      streamStatus: 400, streamChunks: ['{"error":{"code":"model_not_allowed","message":"no"}}'] });
    const res = await post(app);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: 'model_not_allowed' } });
  });

  it('sets the actor from the token here too, and overwrites a supplied one', async () => {
    const principal = { issuer: 'http://keycloak:8080/realms/lexprompt', subject: 'sub-real', groups: [] };
    const { app, calls } = buildTestApi({ principal, streamChunks: [BODY] });
    await app.inject({ method: 'POST', url: '/v1/infer/stream', headers: { authorization: 'Bearer t' },
      payload: { modelChoiceId: 'm', purpose: 'assistant.chat', user: 'hi',
                 actorSubject: 'sub-someone-else' } });
    expect(calls.stream[0].actorSubject).toBe('sub-real');
    expect(calls.stream[0].actorIssuer).toBe('http://keycloak:8080/realms/lexprompt');
  });
});

// The structural half of D1: no parser may exist in this service at all.
describe('apps/api parses nothing', () => {
  const SRC = path.resolve(__dirname, '../src');
  const walk = (dir: string, out: string[] = []): string[] => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full, out); else if (full.endsWith('.ts')) out.push(full);
    }
    return out;
  };

  it('imports no SSE parser or frame codec from @lexprompt/core', () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      const text = readFileSync(file, 'utf8');
      for (const name of ['createSseEventReader', 'decodeFrame', 'encodeFrame', 'sseFields', 'readFrames']) {
        if (text.includes(name)) offenders.push(`${path.basename(file)} references ${name}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `npx vitest run --project api apps/api/test/inferStream.pipe.test.ts`
Expected: FAIL — the route does not exist, so every inject returns 404.

- [ ] **Step 3: Implement `routes/inferStream.ts`**

```ts
import type { FastifyInstance } from 'fastify';
import type { GatewayClient } from '../gatewayClient.ts';
import type { Principal } from '../entra.ts';

/**
 * D1's middle hop, and its entire specification is: parse nothing.
 *
 * This project has already shipped an SSE parser that dropped the last
 * token of every answer and returned nothing on CRLF servers. Three hops
 * would be three chances to reproduce it. There are two parsers in this
 * system — the gateway's, over a provider's stream, and the browser's, over
 * the gateway's — and they are the same function from packages/core. This
 * service copies bytes, so it cannot be the one that is wrong.
 *
 * A structural test asserts this file's service imports no parser at all.
 */
export function registerInferStream(
  app: FastifyInstance, gateway: GatewayClient, workspaceId: string,
): void {
  app.post('/v1/infer/stream', async (request, reply) => {
    const principal = (request as { principal: Principal }).principal;
    const client = (request.body ?? {}) as Record<string, unknown>;
    const body = {
      ...client, workspaceId,
      actorIssuer: principal.issuer, actorSubject: principal.subject,
    };

    const controller = new AbortController();
    // A client that goes away must not leave a provider call running: the
    // abort propagates api → gateway → provider.
    request.raw.on('close', () => controller.abort());

    let upstream;
    try {
      upstream = await gateway.stream(body, controller.signal);
    } catch (err) {
      return reply.code(503).send({ error: { code: 'service_misconfigured',
        message: 'LexPrompt could not reach the firm\'s AI service. This is a configuration '
          + `problem in the deployment, not something you can fix here. (${(err as Error).message})` } });
    }

    if (upstream.status !== 200) {
      // Not a stream: pass the status and the body through as they are.
      const text = await upstream.text();
      reply.raw.writeHead(upstream.status, { 'Content-Type': 'application/json' });
      reply.raw.end(text);
      return reply;
    }

    reply.raw.writeHead(200, {
      'Content-Type': upstream.headers['content-type'] ?? 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    });
    for await (const chunk of upstream.body ?? []) {
      reply.raw.write(chunk);   // bytes in, bytes out. Nothing is decoded.
    }
    reply.raw.end();
    return reply;
  });
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run --project api`
Expected: PASS, 28 tests.

- [ ] **Step 5: Mutation test the pipe**

Replace the copy loop with a re-framer:

```ts
    const dec = new TextDecoder();
    for await (const chunk of upstream.body ?? []) {
      reply.raw.write(dec.decode(chunk, { stream: true }).replace(/\r\n/g, '\n'));
    }
```

Run. Expected: FAIL on *"preserves CRLF separators byte for byte rather than normalising them"*. Restore.

Then add `import { decodeFrame } from '@lexprompt/core';` to the file. Run. Expected: FAIL on *"imports no SSE parser or frame codec from @lexprompt/core"*. Restore.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/inferStream.ts apps/api/test/inferStream.pipe.test.ts apps/api/src/server.ts
git commit -F .git/COMMIT_MSG_TASK18
```

```
feat(api): the stream route is a byte pipe, and cannot be anything else

D1's middle hop parses nothing. Bytes in, bytes out — proved by comparing
the response body with the gateway's, delivered whole, in three uneven
chunks, one byte at a time, all-CRLF, with no trailing blank line, and
truncated. A structural test asserts this service imports no SSE parser or
frame codec at all, so the next person cannot helpfully add one.

A client going away aborts the provider call through both hops.

Mutation-tested: CRLF normalisation added to the copy loop (1 test fails);
a frame-codec import added (1). Restored.
```

---

## Task 19: OIDC sign-in in the browser — standards only, never MSAL

**Type:** application code

**Files:**
- Create: `src/lib/config.ts`, `src/lib/auth/oidc.ts`, `src/lib/auth/useAuth.ts`, `src/lib/auth/useAuth.test.tsx`, `src/features/auth/SignInScreen.tsx`
- Modify: `src/App.tsx` (the sign-in gate), `package.json` (`oidc-client-ts`)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `type AuthState = { status: 'signing-in' } | { status: 'signed-out' } | { status: 'failed'; message: string } | { status: 'signed-in'; account: { oid: string; name: string; initials: string; email: string } }`
  - `useAuth(): { state: AuthState; signIn(): void; signOut(): void; retry(): void }`
  - `getAccessToken(): Promise<string>` — the single token source for every request in Task 20; acquires silently and falls back to a redirect only on `InteractionRequiredAuthError`

**MSAL is deliberately not used, and this is the task where that decision lands** (§7, S28). MSAL is Entra's own library. Reaching for it would either tie the sign-in path to one issuer or produce a second sign-in path for Keycloak — two implementations of one idea, at the front door, which is this project's most repeated defect in the worst place to put it. `oidc-client-ts` speaks discovery, authorization code and PKCE to any conformant issuer, **Entra included**.

*This is a change from the pre-revision plan and is flagged as one, because "use MSAL for Entra" is the obvious choice and it is the wrong one here — and because a removed dependency is exactly the kind of thing a later reader reinstates by accident.* What is genuinely given up: MSAL's Entra-specific conveniences — broker accounts, tenant discovery, its own token cache. Note which way each choice fails. If the generalisation is wrong it fails **loudly, at sign-in, in the environment that is wrong**; if the app had special-cased Entra and a second issuer were ever needed, the cost would be a rewrite rather than an edit to a configuration file — and the second issuer was needed within a day.

**`src/lib/config.ts` is created here and is the web app's ONLY reader of `import.meta.env`** (S30, §18 item 10(a)). Task 26's `configSurface` test enforces it. Creating it in this task rather than later is deliberate: the first component to reach for an env var directly will be written the week the sign-in screen lands.

**Stage boundary and R-G1.** Sign-in here authenticates a caller. It does **not** introduce colleagues. The header avatar keeps showing *your own* initials — now from the token instead of the local profile — and no screen gains an assignee, a second actor or a "shared with" affordance. R-G1 binds until Stage 4. **Roles are not read and not enforced here**; the token's group claim is carried but unused until Stage 2.

**The three load states, at the front door.** `signing-in` renders a busy screen; `failed` renders an explicit failure with a Retry and the tenant it tried; `signed-out` renders the sign-in prompt. **None of them renders the app with no data**, which is the "empty is not broken" rule at the one place a user meets it first.

- [ ] **Step 1: Add the dependency**

```bash
npm install oidc-client-ts@^3.1.0
```

Then confirm the wrong one is absent, and stays absent:

```bash
grep -r "msal" package.json src/ ; echo "exit=$?   <-- expect no matches"
```

- [ ] **Step 2: Write the failing test**

`src/lib/auth/useAuth.test.tsx` — mock `../oidc` with `vi.mock` and drive `useAuth` through `mountOnce` from `src/test/mount.tsx` (R-B8: `createRoot`/`act`, no `@testing-library/react`). Cases:

1. It starts in `signing-in` while `handleRedirectPromise` is pending — asserted by rendering a probe component that writes `state.status` into the DOM and checking it before the promise resolves.
2. It reaches `signed-in` with `oid`, `name`, `email` and computed `initials` when an account is returned.
3. `initials` are the first letters of the first and last words of `name` (`'A. Gray'` → `'AG'`, `'Priya Okafor'` → `'PO'`, `'Cher'` → `'C'`).
4. It reaches `signed-out`, **not** `failed`, when no account is returned — being signed out is not an error.
5. It reaches `failed` with the message when `handleRedirectPromise` rejects, and **does not** fall through to `signed-out`, because "we could not tell whether you are signed in" is a different fact from "you are not".
6. `retry()` from `failed` returns to `signing-in`.
7. `getAccessToken` returns the silent token when `acquireTokenSilent` resolves.
8. `getAccessToken` triggers a redirect and rejects when `acquireTokenSilent` throws `InteractionRequiredAuthError`, rather than returning an empty string.
9. `getAccessToken` rejects with a `ModelError` of code `sign_in_required` on any other failure.
10. **The same hook and the same code reach both issuers.** Run cases 2, 3 and 7 twice — once with an Entra-shaped config (`issuer: 'https://login.microsoftonline.com/t/v2.0'`, profile carrying `oid`) and once with a Keycloak-shaped one (`issuer: 'http://localhost:8088/realms/lexprompt'`, profile carrying `sub`) — and assert identical behaviour. The browser reads the subject from `profile.sub` in **both** cases (OIDC's `sub` is always present, and for Entra it is the pairwise subject); the **`subjectClaim` configuration lives server-side only** (Task 16), because the browser never makes an authorisation decision and must not be given a second place to get identity from.

- [ ] **Step 3: Implement `src/lib/config.ts`**

```ts
/**
 * The web app's ONE reader of `import.meta.env` (S30, §18 item 10(a)).
 *
 * Every deployment-varying value the browser needs is read here and nowhere
 * else, and `configSurface` (Task 26) fails the build on a second reader.
 * There is no `isLocal`, no `if (dev)` and no environment branch: the four
 * values below are all that differ between a laptop and a firm's tenant.
 */
export interface WebConfig {
  apiBaseUrl: string;
  oidcIssuer: string;
  oidcClientId: string;
  oidcScope: string;
}

function required(name: string, value: unknown): string {
  if (typeof value !== 'string' || !value) {
    throw new Error(
      `${name} is not configured. LexPrompt will not start without it — a missing `
      + 'identity configuration must not become an app that runs and mostly works.',
    );
  }
  return value;
}

export const config: WebConfig = {
  apiBaseUrl: required('VITE_API_BASE_URL', import.meta.env.VITE_API_BASE_URL),
  oidcIssuer: required('VITE_OIDC_ISSUER', import.meta.env.VITE_OIDC_ISSUER),
  oidcClientId: required('VITE_OIDC_CLIENT_ID', import.meta.env.VITE_OIDC_CLIENT_ID),
  oidcScope: required('VITE_OIDC_SCOPE', import.meta.env.VITE_OIDC_SCOPE),
};
```

- [ ] **Step 4: Implement `auth/oidc.ts`**

```ts
import { UserManager, WebStorageStateStore, type User } from 'oidc-client-ts';
import { ModelError } from '@lexprompt/core';
import { config } from '../config.ts';

/**
 * Standards OIDC — authorization code with PKCE, against a CONFIGURED
 * issuer (§7, S28). Entra ID in a firm deployment, Keycloak in compose, and
 * this file does not know which: `authority` is a configured URL and
 * everything else comes from that issuer's discovery document.
 *
 * NOT MSAL, deliberately. MSAL is Entra's own library, and using it would
 * either tie this path to one issuer or produce a second path for the
 * other — two implementations of one idea, at the front door. If you are
 * reading this because you were about to add `@azure/msal-browser` back:
 * that is the change S28 exists to prevent.
 */
export const userManager = new UserManager({
  authority: config.oidcIssuer,
  client_id: config.oidcClientId,
  redirect_uri: window.location.origin,
  post_logout_redirect_uri: window.location.origin,
  response_type: 'code',              // authorization code…
  scope: config.oidcScope,            // …with PKCE, which oidc-client-ts does by default
  // sessionStorage, not localStorage: a token is the one thing in this app
  // that should NOT outlive the tab. Everything else the app stores is the
  // user's own work; this is a credential.
  userStore: new WebStorageStateStore({ store: window.sessionStorage }),
  stateStore: new WebStorageStateStore({ store: window.sessionStorage }),
  automaticSilentRenew: true,
  loadUserInfo: false,                // the access token carries what we need
});

/**
 * The single source of a bearer token for every request the browser makes.
 *
 * A silent renew is attempted by `UserManager` on a schedule; this reads the
 * stored user and refreshes on demand when it is expired. A failure is a
 * `sign_in_required` ModelError — never an empty string, which would produce
 * a 401 from `apps/api` and show the user a message about the firm's
 * configuration for what is actually an expired session.
 */
export async function getAccessToken(): Promise<string> {
  let user: User | null = await userManager.getUser();
  if (user?.expired) {
    try {
      user = await userManager.signinSilent();
    } catch (err) {
      throw new ModelError(
        `Your sign-in could not be renewed (${(err as Error).message}). Sign in again.`,
        'sign_in_required', 401,
      );
    }
  }
  if (!user?.access_token) {
    throw new ModelError('You are not signed in. Sign in to continue.', 'sign_in_required', 401);
  }
  return user.access_token;
}
```

- [ ] **Step 5: Implement `useAuth.ts` and `SignInScreen.tsx`**

`useAuth` calls `userManager.signinRedirectCallback()` when the URL carries a `code`, otherwise `userManager.getUser()`, and exposes the four-state `AuthState`. The account's `oid`/`sub` comes from `user.profile.sub` — the one claim OIDC guarantees, on every issuer. `SignInScreen` renders each non-signed-in state with the existing design vocabulary — reuse `LoadErrorPanel` for `failed` rather than writing a new panel (`CLAUDE.md`: *"do not hand-roll a new one"*), and give the `failed` copy the tenant name and a Retry.

In `App.tsx`, render `<SignInScreen …/>` instead of the app for every status but `signed-in`. **Do not render the app shell behind a modal** — a shell full of empty lists behind a sign-in dialog is the "empty is not broken" failure at the front door.

- [ ] **Step 6: Run the tests**

Run: `npx vitest run --project web src/lib/auth/useAuth.test.tsx`
Expected: PASS, 13 tests (9, plus case 10's three re-runs against the Keycloak-shaped config).

- [ ] **Step 7: Mutation test the failed-vs-signed-out distinction**

In `useAuth`, change the `catch` around `signinRedirectCallback` to `setState({ status: 'signed-out' })`. Run. Expected: FAIL on *"reaches failed with the message when the redirect callback rejects"*. Restore.

- [ ] **Step 8: Verify in a browser, against Keycloak**

`npm run compose:up` (Task 24) and open `http://localhost:3005`. Confirm: the sign-in screen appears; signing in as `trainee` / `trainee` returns to the app with your own initials in the header; signing out returns to the sign-in screen; reloading mid-session does not flash the app's empty state; and a second browser profile can sign in as `partner` at the same time.

**This needs no Entra tenant, which is the whole point of S31** — the deployed sign-in path runs on the laptop. What it does not prove is §5.1's list: Entra's group-claim shape, overage (unit-tested in Task 16 because Keycloak cannot reproduce it), consent, conditional access, MFA and tenant token lifetimes. Verify against a real tenant too if you have one, and **if you cannot, say so plainly rather than implying you did.**

- [ ] **Step 9: Commit**

```bash
git add src/lib/config.ts src/lib/auth src/features/auth src/App.tsx package.json package-lock.json
git commit -F .git/COMMIT_MSG_TASK19
```

```
feat(web): standards OIDC sign-in, with four honest states at the front door

oidc-client-ts, not MSAL (S28). MSAL is Entra's own library; using it would
tie this path to one issuer or produce a second path for Keycloak — two
implementations of one idea at the front door, which is this project's most
repeated defect in the worst place to put it. What is given up is MSAL's
Entra-specific conveniences; what is gained is that the sign-in a developer
tests is the sign-in a firm runs.

Four states — signing-in, signed-out, failed, signed-in — each render
differently, and none renders the app with no data: "empty is not broken" at
the place a user meets it first. Being signed out is not an error; failing to
determine whether you are signed in is, and says so with a Retry.

src/lib/config.ts is the web app's only reader of import.meta.env (S30). No
isLocal, no if(dev): four configured values are all that differ between a
laptop and a tenant.

Tokens live in sessionStorage: a token is the one thing in this app that
should not outlive the tab.

R-G1 still binds — this authenticates a caller, it does not introduce
colleagues. Roles are carried but not read until Stage 2.

Mutation-tested: the failure path collapsed into signed-out, one test fails.
```

---

## Task 20: `GatewayModelClient` — and `openrouter.ts` is deleted

**Type:** application code

**Files:**
- Create: `src/lib/model/gatewayModelClient.ts`, `src/lib/model/gatewayModelClient.test.ts`
- Delete: `src/lib/openrouter.ts`, `src/lib/openrouter.test.ts`
- Modify: every file importing `openrouter` (Task 21 completes the call sites; this task creates the client and re-points the imports)

**Interfaces:**
- Consumes: `ModelClient`, `InferRequest`, `InferResponse`, `AllowedModel`, `ModelError`, `readFrames`, `parseJsonLoose` (Tasks 2–3); `getAccessToken` (Task 19).
- Produces: `gatewayModelClient: ModelClient` and `makeGatewayModelClient(deps)` for tests.

**What survives from `openrouter.ts`, and where it went.** The retry policy → `callModel.ts` (Task 11). `parseJsonLoose` → `packages/core` (Task 1), still the fallback here. The SSE parser → `packages/core` (Task 3), used by `readFrames`. `isAuthError` → split into `isSignInError` / `isServiceConfigError` (Task 2). The abort discipline → preserved here and in `callModel`. `listModels` → `listModels()` over `GET /v1/models`. **Nothing is dropped; every piece is somewhere and this task's commit message says where** — a deleted module whose reasoning went with it is how a fixed bug comes back.

- [ ] **Step 1: Write the failing test**

`src/lib/model/gatewayModelClient.test.ts` — construct the client with an injected `fetch` and an injected `getToken`. Cases:

1. `chat` POSTs to `/v1/infer` with the bearer token and returns the parsed `InferResponse`.
2. `chat` sends `purpose`, `modelChoiceId` and `context` through unchanged, and **does not** send `apiKey` or `modelId` (`expect(JSON.stringify(sentBody)).not.toContain('apiKey')`).
3. `chatJson` runs the response content through `parseJsonLoose`, so a model that wraps JSON in prose still parses.
4. A 400 `{ error: { code: 'model_not_allowed' } }` becomes a `ModelError` whose `code` is `model_not_allowed` and for which `isServiceConfigError` is true and `isSignInError` is false.
5. A 401 becomes `sign_in_required`, for which `isSignInError` is true.
6. A 503 `service_misconfigured` carries the `callId` through, so the UI can quote it.
7. A network-level `fetch` rejection becomes `ModelError` code `network`, **not** an unhandled `TypeError` — the failure `openrouter.ts` fixed and that must not regress.
8. An abort propagates unwrapped: `expect(...).rejects.toMatchObject({ name: 'AbortError' })`, and the client does not retry (assert the injected fetch was called once).
9. `chatStream` invokes `onDelta` per delta, in order, and resolves with usage and `callId`.
10. `chatStream` **rejects** with `stream_truncated` when the body ends with no `done` frame, and the deltas seen before that are still reported — the caller can show what arrived *and* know it is incomplete.
11. `chatStream` rejects with the `error` frame's code and message.
12. `listModels` returns the array from `{ models: [...] }`.
13. `listModels` returns `[]` for an empty allowlist and **does not throw** — the empty/broken distinction, at the wire.
14. `listModels` throws `service_misconfigured` on a 503.

- [ ] **Step 2: Run and watch it fail**

Run: `npx vitest run --project web src/lib/model/gatewayModelClient.test.ts`
Expected: FAIL — `Failed to resolve import "./gatewayModelClient.ts"`.

- [ ] **Step 3: Implement**

```ts
import {
  ModelError, parseJsonLoose, readFrames,
  type AllowedModel, type InferRequest, type InferResponse, type ModelClient, type ModelErrorCode,
} from '@lexprompt/core';
import { getAccessToken } from '../auth/oidc.ts';
import { config } from '../config.ts';

export interface GatewayClientDeps {
  baseUrl: string;
  getToken(): Promise<string>;
  fetch: typeof globalThis.fetch;
}

const isAbort = (e: unknown): boolean => (e as { name?: string } | null)?.name === 'AbortError';

async function toModelError(response: Response): Promise<ModelError> {
  let code: ModelErrorCode = 'unknown';
  let message = `HTTP ${response.status}`;
  let callId: string | undefined;
  try {
    const body = await response.json() as { error?: { code?: ModelErrorCode; message?: string; callId?: string } };
    if (body?.error?.code) code = body.error.code;
    if (body?.error?.message) message = body.error.message;
    callId = body?.error?.callId;
  } catch { /* keep the status */ }
  return new ModelError(message, code, response.status, callId);
}

/**
 * The one route from this browser to a model (S1).
 *
 * `openrouter.ts`'s shape, minus the key and minus the model id. What it
 * carried has not been dropped — it has moved:
 *   retry policy      -> apps/gateway/src/callModel.ts
 *   parseJsonLoose    -> packages/core (still the fallback, below)
 *   the SSE parser    -> packages/core, reached through readFrames
 *   isAuthError       -> isSignInError / isServiceConfigError
 *   the abort rule    -> here, and in callModel
 * A deleted module whose reasoning went with it is how a fixed bug returns.
 */
export function makeGatewayModelClient(deps: GatewayClientDeps): ModelClient {
  const post = async (path: string, body: unknown, signal?: AbortSignal): Promise<Response> => {
    const token = await deps.getToken();
    try {
      return await deps.fetch(`${deps.baseUrl}${path}`, {
        method: 'POST',
        signal,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      });
    } catch (err) {
      // A cancellation is a deliberate decision and propagates as itself.
      if (isAbort(err)) throw err;
      // A network-level failure never reaches an HTTP response and throws a
      // raw TypeError out of fetch. Left unwrapped it crashes every caller
      // that reads `.code` — the exact defect openrouter.ts fixed.
      throw new ModelError(
        `LexPrompt could not reach its server (${(err as Error).message}). Check your connection and try again.`,
        'network', 0,
      );
    }
  };

  return {
    async chat(req: InferRequest, signal?: AbortSignal): Promise<InferResponse> {
      const response = await post('/v1/infer', req, signal);
      if (!response.ok) throw await toModelError(response);
      return await response.json() as InferResponse;
    },

    async chatJson<T>(req: InferRequest, signal?: AbortSignal): Promise<T> {
      // parseJsonLoose survives verbatim: models vary in schema adherence
      // and a run must not fail because one added "Sure! Here you go:".
      return parseJsonLoose<T>((await this.chat(req, signal)).content);
    },

    async chatStream(
      req: InferRequest, onDelta: (chunk: string) => void, signal?: AbortSignal,
    ): Promise<InferResponse> {
      const response = await post('/v1/infer/stream', req, signal);
      if (!response.ok) throw await toModelError(response);
      if (!response.body) {
        throw new ModelError('The server returned no response body to stream.', 'upstream_failed', 502);
      }
      // readFrames throws stream_truncated if the stream ends with no done
      // frame (D2), so a half-answer cannot be returned as a whole one.
      const { usage, callId } = await readFrames(
        response.body as unknown as AsyncIterable<Uint8Array>, onDelta,
      );
      return { content: '', usage, callId, provider: 'openai', jurisdiction: { bloc: 'other', region: '', label: '' } };
    },

    async listModels(): Promise<AllowedModel[]> {
      const token = await deps.getToken();
      let response: Response;
      try {
        response = await deps.fetch(`${deps.baseUrl}/v1/models`, {
          headers: { Authorization: `Bearer ${token}` },
        });
      } catch (err) {
        throw new ModelError(
          `LexPrompt could not reach its server (${(err as Error).message}).`, 'network', 0);
      }
      if (!response.ok) throw await toModelError(response);
      const body = await response.json() as { models?: AllowedModel[] };
      // An empty list is a successful empty list, not a failure. Task 22
      // renders it as "no model has been configured yet".
      return Array.isArray(body.models) ? body.models : [];
    },
  };
}

export const gatewayModelClient = makeGatewayModelClient({
  // Through src/lib/config.ts, never `import.meta.env` directly: that module
  // is the web app's only reader of it (S30), and `configSurface` (Task 26)
  // fails the build on a second one.
  baseUrl: config.apiBaseUrl,
  getToken: getAccessToken,
  fetch: globalThis.fetch.bind(globalThis),
});
```

**Fix the `chatStream` return before you finish this step.** The placeholder above returns invented `provider`/`jurisdiction` values, which is precisely the kind of plausible-looking wrong data this project exists to prevent. Change the `done` frame in Task 12 to carry `provider` and `jurisdiction` alongside `usage` and `callId`, extend `Frame`'s `done` variant in `packages/core`, extend Task 3's round-trip test, and return the real values here. The accumulated text is also returned as `content`, built by the `onDelta` accumulator.

- [ ] **Step 4: Delete `openrouter.ts` and re-point every import**

```bash
git rm src/lib/openrouter.ts src/lib/openrouter.test.ts
```

The 24 files that referenced it (`grep -rln openrouter src/`) are updated in this task for the *imports* and in Task 21 for the *purposes*. `isAuthError` call sites become `isSignInError`/`isServiceConfigError` per Task 23; until then, import both and route to the existing handler so the suite stays green between tasks.

Move the retry-policy and SSE tests that were in `openrouter.test.ts` — do **not** delete them: §14 says they move to the gateway's suite, and Tasks 3, 10, 11 and 12 are where they now live. Confirm each of the 52 cases in the deleted file has a successor, and list any that do not in the commit message.

- [ ] **Step 5: Run everything**

```bash
npx tsc --noEmit
npm test
npm run build
```

Expected: clean, green, no externalization warning.

- [ ] **Step 6: Mutation test the empty-vs-broken distinction**

In `listModels`, change the last line to `if (!body.models?.length) throw new ModelError('No models', 'unknown', 500); return body.models;`. Run. Expected: FAIL on *"listModels returns [] for an empty allowlist and does not throw"*. Restore.

Then, in `chatStream`, wrap `readFrames` in `try { … } catch { return { content: text, … } }`. Run. Expected: FAIL on *"chatStream rejects with stream_truncated when the body ends with no done frame"*. Restore.

- [ ] **Step 7: Commit**

```bash
git add src/lib/model package.json
git commit -F .git/COMMIT_MSG_TASK20
```

```
feat(web): GatewayModelClient replaces openrouter.ts, which is deleted

openrouter.ts's shape minus the key and minus the model id. Nothing it
carried is dropped; every piece has a new home, named here so a fixed bug
cannot come back with the module that fixed it:

  retry policy (429/5xx only)  -> apps/gateway/src/callModel.ts
  parseJsonLoose               -> packages/core, still the fallback
  the SSE parser               -> packages/core, reached through readFrames
  isAuthError                  -> isSignInError / isServiceConfigError
  the abort rule               -> preserved here and in callModel
  the network-error wrap       -> preserved here

An empty model list is a successful empty list. A stream with no done frame
rejects rather than returning what arrived.

Mutation-tested: an empty list turned into a throw (1 test fails); the
truncation rejection swallowed into a return (1). Restored.
```

---

## Task 21: The nine call sites carry a purpose and a context

**Type:** application code

**Files:**
- Modify: `src/features/review/extractClause.ts` (`review.clause`), `src/features/review/extractCollectionClause.ts` (`review.collection_clause`), `src/features/assistant/chatContext.ts` (`assistant.chat`), `src/features/authoring/generateDraft.ts` (`playbook.draft`), `src/features/templates/suggestField.ts` and `suggestMissingClauses.ts` (`playbook.suggest`), `src/lib/inferPositions.ts` (`redlines.infer`), `src/lib/buildChangeset.ts` (`changeset.build`), `src/features/assistant/draftEmail.ts` (`export.email`), `src/features/assistant/suggestRevision.ts` (`export.suggest_fix`)
- Create: `src/lib/model/purposes.test.ts`

**Interfaces:**
- Consumes: `gatewayModelClient`, `Purpose`, `PURPOSES` (Tasks 2, 20).
- Produces: no new exports. Every call site now passes `{ modelChoiceId, purpose, context }` in place of `{ apiKey, modelId }`.

**The mapping, in full** (this is the whole task; there is nothing to infer):

| File | Call | `purpose` | `context` |
|---|---|---|---|
| `extractClause.ts` | `chatJson` | `review.clause` | `{ matterId, reviewId, clauseId, documentIds: [doc.id] }` |
| `extractCollectionClause.ts` | `chatJson` | `review.collection_clause` | `{ matterId, reviewId, clauseId, documentIds: orderedMembers(...).map(d => d.id) }` |
| `chatContext.ts` | `chatStream` | `assistant.chat` | `{ matterId, documentIds: params.documents.map(d => d.id) }` |
| `generateDraft.ts` | `chatJson` | `playbook.draft` | `{}` |
| `suggestField.ts` | `chatJson` | `playbook.suggest` | `{}` |
| `suggestMissingClauses.ts` | `chatJson` | `playbook.suggest` | `{}` |
| `inferPositions.ts` | `chatJson` | `redlines.infer` | `{ documentIds: docs.map(d => d.id) }` |
| `buildChangeset.ts` | `chatJson` | `changeset.build` | `{ documentIds: docs.map(d => d.id) }` |
| `draftEmail.ts` | `chat` | `export.email` | `{ matterId, reviewId }` |
| `suggestRevision.ts` | `chat` | `export.suggest_fix` | `{ matterId, reviewId, clauseId }` |

`draftEmail.ts` and `suggestRevision.ts` use `chat`, which now returns `InferResponse` — read `.content`. That is a two-line change in each and is the only shape change at a call site.

Where a call site does not currently receive the ids its `context` needs, **thread the id through rather than inventing one or omitting the field silently.** `extractClause` already takes the review's target; `chatContext` takes `params.documents`. A `context` that is quietly `{}` produces an audit record that cannot answer "which document did this call serve", which is half of what Stage 1 is for.

- [ ] **Step 1: Write the failing test**

`src/lib/model/purposes.test.ts` — a coverage guard, in the shape §14 asks for:

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PURPOSES } from '@lexprompt/core';

const ROOT = path.resolve(__dirname, '../../..');

const SITES: Record<string, string> = {
  'review.clause': 'src/features/review/extractClause.ts',
  'review.collection_clause': 'src/features/review/extractCollectionClause.ts',
  'assistant.chat': 'src/features/assistant/chatContext.ts',
  'playbook.draft': 'src/features/authoring/generateDraft.ts',
  'playbook.suggest': 'src/features/templates/suggestField.ts',
  'redlines.infer': 'src/lib/inferPositions.ts',
  'changeset.build': 'src/lib/buildChangeset.ts',
  'export.email': 'src/features/assistant/draftEmail.ts',
  'export.suggest_fix': 'src/features/assistant/suggestRevision.ts',
};

describe('every purpose has a call site, and every call site names one', () => {
  it('covers all nine purposes', () => {
    expect(Object.keys(SITES).sort()).toEqual([...PURPOSES].sort());
  });

  it.each(Object.entries(SITES))('%s is named in %s', (purpose, file) => {
    expect(readFileSync(path.join(ROOT, file), 'utf8')).toContain(`'${purpose}'`);
  });

  it('no call site still passes an apiKey or a modelId', () => {
    const offenders: string[] = [];
    for (const file of Object.values(SITES)) {
      const text = readFileSync(path.join(ROOT, file), 'utf8');
      if (/\bapiKey\b/.test(text)) offenders.push(`${file} still passes apiKey`);
      if (/\bmodelId\b/.test(text)) offenders.push(`${file} still passes modelId`);
    }
    expect(offenders).toEqual([]);
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `npx vitest run --project web src/lib/model/purposes.test.ts`
Expected: FAIL on eight of the nine `is named in` cases and on *"no call site still passes an apiKey or a modelId"*.

- [ ] **Step 3: Edit the ten files**

The pattern, shown once on `extractClause.ts` and applied identically to the rest:

```diff
-import { chatJson, isAuthError } from '../../lib/openrouter';
+import { isServiceConfigError, isSignInError } from '@lexprompt/core';
+import { gatewayModelClient } from '../../lib/model/gatewayModelClient';
...
-      const result = await chatJson<ExtractResult>({
-        apiKey: settings.apiKey,
-        modelId: settings.modelId,
+      const result = await gatewayModelClient.chatJson<ExtractResult>({
+        modelChoiceId: settings.modelChoiceId,
+        purpose: 'review.clause',
+        context: { matterId, reviewId, clauseId: clause.id, documentIds: [doc.id] },
         system: SYSTEM_PROMPT,
         user,
         images,
         jsonSchema: EXTRACT_SCHEMA,
       }, signal);
...
-      ...(isAuthError(error) ? { authError: true } : {}),
+      // `authError` keeps its name and its persisted meaning — a failure
+      // Retry cannot fix — and now covers both halves of what openrouter's
+      // isAuthError meant: an expired sign-in and a firm-configuration
+      // fault. Renaming a persisted field would need a schema migration
+      // for no behavioural gain (reviewMigration.ts reads it).
+      ...(isSignInError(error) || isServiceConfigError(error) ? { authError: true } : {}),
```

- [ ] **Step 4: Run everything**

```bash
npx tsc --noEmit
npm test
```

Expected: `tsc` clean; `purposes.test.ts` PASS, 11 tests; every existing `extractClause`, `extractCollectionClause`, `chatContext`, `generateDraft`, `suggestField`, `suggestMissingClauses`, `inferPositions`, `buildChangeset` and `draftEmail` test passing with its mock re-pointed from `../../lib/openrouter` to `../../lib/model/gatewayModelClient`.

- [ ] **Step 5: Mutation test the coverage guard**

Delete `purpose: 'redlines.infer',` from `inferPositions.ts`. Run. Expected: FAIL on *"redlines.infer is named in src/lib/inferPositions.ts"* **and** on the `tsc` gate (`purpose` is required on `InferRequest`). Restore.

The type error is the real guard and the test is the backstop; both being present is deliberate, because `tsconfig.json` sets neither `strict` nor `noUnusedLocals` and this project has been surprised by how little `tsc` catches here before.

- [ ] **Step 6: Commit**

```bash
git add src/features src/lib
git commit -F .git/COMMIT_MSG_TASK21
```

```
feat(web): every call site names its purpose and what it served

Nine purposes, ten call sites, each carrying the matter, review, clause and
document ids the call is about — which is what makes the gateway's log able
to answer "which document or review did this call serve", half of what
Stage 1 is for. A context quietly left {} would look fine and answer
nothing.

Finding.authError keeps its name and persisted meaning — a failure Retry
cannot fix — and now covers both halves of openrouter's isAuthError.
Renaming a persisted field would need a schema migration for no gain.

A coverage test asserts all nine purposes appear at a call site and that no
call site still passes an apiKey or a modelId.
```

---

## Task 22: Settings — the key is gone, the model picker shows jurisdiction, three load states

**Type:** application code

**Files:**
- Create: `src/features/settings/ModelPicker.tsx`, `src/features/settings/ModelPicker.test.tsx`
- Modify: `src/types.ts` (`Settings`), `src/lib/storage.ts` (purge a stored key), `src/lib/privacyCopy.ts`, `src/features/settings/SettingsPanel.tsx`, `src/App.tsx` (`isConfigured`)
- Modify: `src/lib/storage.test.ts` (or create it)

**Interfaces:**
- Consumes: `gatewayModelClient.listModels`, `AllowedModel`, `jurisdictionLabel` (Tasks 2, 20).
- Produces:
  - `Settings` becomes `{ modelChoiceId: string; concurrency: number; modelSupportsImages?: boolean; modelSupportsStructuredOutput?: boolean; modelContextLength?: number }` — `apiKey` and `modelId` are **deleted**
  - `DEFAULT_SETTINGS = { modelChoiceId: '', concurrency: 5 }`
  - `loadSettings()` additionally **removes** any stored `apiKey` and returns `{ settings, purgedApiKey: boolean }`

**Three things this task must get right:**

1. **The key is purged from the browser, and the user is told once.** Stage 1's definition of done is *"no OpenRouter key exists anywhere in the codebase or in any browser"*. `loadSettings` strips `apiKey` and rewrites `localStorage`. This is the one place this project **does** delete stored data, and the reason is that it is a credential which is now useless and cannot be re-read for any purpose. The user is told, once, with the one thing they can act on: *"LexPrompt no longer uses an OpenRouter key, and the key stored in this browser has been removed. If you no longer need it, revoke it at openrouter.ai/keys."*
2. **The free-text model box is deleted** (S15). Its replacement is a select over `listModels()`. A user cannot type a model id, and the fallback that let them — `SettingsPanel`'s "Or enter a model id manually" — goes with it.
3. **Three load states, distinctly** — and the empty one is the new hazard. `loading` → a busy row. `error` → `LoadErrorPanel` with a Retry. `ready` with `models.length === 0` → *"No model has been configured for this workspace yet. An administrator sets these up; LexPrompt cannot run a review until one exists."* — which is **not** the error panel and **not** an empty select.

- [ ] **Step 1: Write the failing tests**

`src/features/settings/ModelPicker.test.tsx`, using `mountOnce`/`click` from `src/test/mount.tsx`:

1. While the promise is pending, it renders a busy element (`[data-busy="true"]`) and **no** select.
2. On rejection it renders the error copy and a Retry button, and clicking Retry calls `listModels` again.
3. On an **empty** list it renders the "no model has been configured" sentence, renders **no** select, and renders **no** error panel — asserted by `expect(container.querySelector('select')).toBe(null)` and `expect(container.textContent).not.toContain('could not be loaded')`.
4. On a populated list it renders one option per model.
5. **Every option names its jurisdiction** — `expect(option.textContent).toContain('UK · UK South')` for each. (Owner decision 3: visible where the choice is made.)
6. **Every** option states where processing occurs in words, not only the non-UK ones — `expect(ukOption.textContent).toContain('Processed in UK South')` and `expect(usOption.textContent).toContain('Processed in the United States')`. Labelling only some would make the **absence** of a label carry meaning, which is the blank-CSV-cell defect exactly (S27's own reasoning).
7. **The label is factual and never evaluative.** It says where processing occurs and nothing about whether that is good — no "warning", no colour that reads as risk, no "outside the UK/EU". Whether a jurisdiction is acceptable is settled by the operator's contracts and their `GATEWAY_ALLOWED_JURISDICTIONS`, and every option on this list has already passed that gate. Asserted: `expect(container.textContent).not.toMatch(/warning|caution|risk|unsafe|outside/i)`.
7. Selecting a model calls `onChange` with `modelChoiceId` and the three capability fields from that model.
8. It preselects the model marked `isDefault` when `settings.modelChoiceId` is empty.
9. It **does not** preselect, and shows the "choose a model" prompt, when a stored `modelChoiceId` is no longer on the list — a stale choice must not silently resolve to a different model.

`src/lib/storage.test.ts`:

10. `loadSettings` returns settings with no `apiKey` key at all when one was stored (`expect('apiKey' in result.settings).toBe(false)` — `toEqual` would not distinguish an absent key from an `undefined` one, and `structuredClone` preserves an `undefined`-valued key).
11. `loadSettings` rewrites `localStorage` so a second read finds no key: `expect(localStorage.getItem('lexprompt.settings')).not.toContain('apiKey')`.
12. `purgedApiKey` is `true` on the read that purged and `false` on the next.
13. `loadSettings` migrates a stored `modelId` to nothing — the value was an OpenRouter model id and is meaningless against an allowlist, so it is dropped and the user picks again, rather than being carried over as a `modelChoiceId` that will not resolve.

- [ ] **Step 2: Run and watch them fail**

Run: `npx vitest run --project web src/features/settings/ModelPicker.test.tsx src/lib/storage.test.ts`
Expected: FAIL — no `ModelPicker.tsx`, and `loadSettings` returns a bare `Settings`.

- [ ] **Step 3: Implement the type and storage changes**

```ts
// src/types.ts
export interface Settings {
  /** An allowlist entry id from GET /v1/models. Never a provider model
   *  name: a user cannot name a model (S15). */
  modelChoiceId: string;
  concurrency: number;
  modelSupportsImages?: boolean;
  modelSupportsStructuredOutput?: boolean;
  modelContextLength?: number;
}

export const DEFAULT_SETTINGS: Settings = { modelChoiceId: '', concurrency: 5 };
```

```ts
// src/lib/storage.ts
export function loadSettings(): { settings: Settings; purgedApiKey: boolean } {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { settings: { ...DEFAULT_SETTINGS }, purgedApiKey: false };
    const stored = JSON.parse(raw) as Record<string, unknown>;

    // The one place this project deliberately DELETES stored data.
    // "Never delete what you cannot read" is about the user's work; this is
    // a credential that no longer does anything and that we should not keep
    // sitting in a browser. Stage 1's definition of done says no OpenRouter
    // key exists in any browser, and this is where that becomes true.
    const purgedApiKey = typeof stored.apiKey === 'string' && stored.apiKey.length > 0;
    delete stored.apiKey;
    // `modelId` was an OpenRouter model id. It has no meaning against an
    // allowlist, so it is dropped rather than carried over as a
    // modelChoiceId that would never resolve.
    delete stored.modelId;

    const settings = { ...DEFAULT_SETTINGS, ...stored } as Settings;
    if (purgedApiKey || 'modelId' in JSON.parse(raw)) saveSettings(settings);
    return { settings, purgedApiKey };
  } catch {
    return { settings: { ...DEFAULT_SETTINGS }, purgedApiKey: false };
  }
}
```

Every caller of `loadSettings` changes shape. Update them in this task; `App.tsx` uses `purgedApiKey` to raise the one-time notice.

- [ ] **Step 4: Implement `ModelPicker.tsx` and rewrite `SettingsPanel.tsx`**

`ModelPicker` owns the three-state load over `listModels()` and renders **every** option as ``${m.label} — Processed in ${m.jurisdiction.label}`` — unconditionally, for every entry, in the same neutral style. The wording is **factual, never evaluative**: it states where processing occurs and passes no judgement, because every model on this list has already passed the operator's own jurisdiction gate and whether that jurisdiction is acceptable was settled by their contracts, not by this screen. No warning icon, no risk colour, no "outside the UK/EU".

In `SettingsPanel.tsx`: delete the whole "OpenRouter API key" section, the "Get an API key" link and the `API_KEY_PRIVACY` block; delete the manual model-id input and its warning; replace the model `<select>` with `<ModelPicker …/>`; change the screen's subtitle from *"Connect an OpenRouter account to run reviews."* to *"Choose the model your firm has configured for reviews."*; and add a section headed **Where your requests go** rendering the selected model's provider and jurisdiction as a sentence.

In `privacyCopy.ts` (R-G5 — this is the single home for disclosure wording; do not write one of these inline):

```ts
/** Replaces API_KEY_PRIVACY, which is void: there is no user key.
 *  Stage 1 makes the first sentence true; Stage 2 makes the second one
 *  true and rewrites STORAGE_PRIVACY with it. */
export const INFERENCE_PRIVACY =
  'You do not need an API key. Requests go to your firm\'s own LexPrompt service, which '
  + 'holds the credentials for the AI provider your administrator has configured and keeps '
  + 'a record of every request — who made it, when, which model, and which document or '
  + 'review it was for. The text of your documents and the model\'s answers are never '
  + 'written to that record.';
```

`STORAGE_PRIVACY` **stays as it is in this stage**: matters, documents and reviews genuinely are still in IndexedDB until Stage 2. Its second bullet's phrase *"except to the model you chose, via OpenRouter"* is now false, so change **that clause only**, to *"except to your firm's LexPrompt service, at the moment you run a review"*. Update `SettingsPanel`'s test assertions with it.

In `App.tsx`: `const isConfigured = Boolean(auth.state.status === 'signed-in' && settings.modelChoiceId);` and `ensureConfigured`'s default message becomes `'Choose a model in Settings to get started.'`.

- [ ] **Step 5: Run everything**

```bash
npx tsc --noEmit && npm test && npm run build
```

Expected: clean, green, no externalization warning. `SettingsPanel`'s existing tests need their assertions updated for the deleted sections — that is a **declared copy change**, so update them in this commit rather than absorbing it.

- [ ] **Step 6: Mutation test the empty-vs-broken distinction and the purge**

1. In `ModelPicker`, render the empty list through the error branch. Run. Expected: FAIL on *"on an empty list it renders the 'no model has been configured' sentence … and no error panel"*. Restore.
2. In `loadSettings`, remove `delete stored.apiKey`. Run. Expected: FAIL on *"returns settings with no apiKey key at all"* and *"rewrites localStorage so a second read finds no key"*. Restore.

- [ ] **Step 7: Verify in a browser**

Load the app with an old `lexprompt.settings` containing an `apiKey` in `localStorage`; confirm the notice appears once, the key is gone from DevTools → Application → Local Storage, and the model picker lists the configured models with their jurisdictions. Then stop the gateway and reload: the picker must say the list could not be loaded, with a Retry — **not** show an empty select.

- [ ] **Step 8: Commit**

```bash
git add src/types.ts src/lib/storage.ts src/lib/storage.test.ts src/lib/privacyCopy.ts src/features/settings src/App.tsx
git commit -F .git/COMMIT_MSG_TASK22
```

```
feat(web): Settings loses the key, gains a model picker that names jurisdictions

Settings.apiKey is deleted from the type and PURGED from localStorage on
first read, with a one-time notice telling the user to revoke it at
OpenRouter if they no longer need it. This is the one place this project
deliberately deletes stored data: "never delete what you cannot read" is
about the user's work, and this is a credential that no longer does
anything.

The free-text model box goes with it (S15). Its replacement is a select
over GET /v1/models where every option names where it is processed, and an
every option — not only some — says where it processes, in factual words
rather than a two-letter code, in the same neutral style —
owner decision 3: visible where the choice is made.

Three load states, and the empty one is new: an empty allowlist reads "no
model has been configured for this workspace yet", which is neither an
error panel nor an empty select.

privacyCopy.ts gains INFERENCE_PRIVACY and loses API_KEY_PRIVACY (R-G5 —
one home for disclosure wording). STORAGE_PRIVACY keeps its IndexedDB
sentences, which are still true until Stage 2, and loses only the
"via OpenRouter" clause, which is not.

Mutation-tested: an empty list routed through the error branch (1 test
fails); the apiKey purge removed (2). Restored.
```

---

## Task 23: The error copy split — the user's problem, the firm's problem

**Type:** application code

**Files:**
- Create: `src/components/ServiceConfigError.tsx`, `src/components/ServiceConfigError.test.tsx`
- Modify: `src/App.tsx`, `src/features/assistant/ChatPanel.tsx`, `src/features/review/ResultsView.tsx`, `src/features/templates/TemplateEditor.tsx`
- Modify: `src/App.authRedirect.test.tsx`

**Interfaces:**
- Consumes: `isSignInError`, `isServiceConfigError`, `ModelError` (Task 2).
- Produces: `<ServiceConfigError error={ModelError} onRetry={() => void} />`; and in `App.tsx`, `SIGN_IN_ERROR_MESSAGE` and `handleSignInError` / `handleServiceConfigError`.

**What changes, and why it is a different message to a different person.** `openrouter.ts`'s contract was: *a 401/403 means the user's key was rejected; route to Settings.* That is now two different facts with two different audiences:

| Old | New | Copy | Where it goes |
|---|---|---|---|
| 401 — the user's key was rejected | `sign_in_required` — the user's Entra session expired | *"Your sign-in has expired. Sign in again to continue."* | The **sign-in action** — not Settings, which no longer holds a credential |
| 403 — the key lacks access | `not_permitted` — the account is in no mapped group | *"Your account does not have access to LexPrompt. Ask your IT team to add you."* | In place, with no Retry |
| *(did not exist)* | `group_overage` — the token carried **no** `groups` claim because the account is in too many groups (§7) | *"Your account is in too many groups for LexPrompt to read them from your sign-in. This is not something signing in again will fix — ask your IT team to grant LexPrompt directory read access, or to reduce your group memberships."* | **In place**, with no Retry. **Never the `not_permitted` message**, which would tell a partner in forty groups they have no access to their own firm's tool |
| *(did not exist)* | `service_misconfigured` — the firm's gateway cannot reach a provider, or its credential was rejected | *"LexPrompt can't reach your firm's AI service. This is a configuration problem in the deployment, not something you can fix here. Tell your IT team, and quote reference `{callId}`."* | **In place**, with a Retry and the reference id. **Never Settings** |
| *(did not exist)* | `model_not_allowed` / `purpose_not_allowed` | *"The model this review was set up with is no longer available. Choose another in Settings."* | Settings — this one genuinely is |

**`AUTH_ERROR_MESSAGE` is retired.** Sending a lawyer to Settings to fix the firm's Foundry role assignment is a wrong instruction delivered with authority, which is the failure mode this project is organised against.

**`Finding.authError` keeps its name and its persisted meaning** (Task 21): a failure Retry cannot fix. `reviewMigration.ts` reads it and a rename would be a schema migration for no gain. What changes is which sentence a reader is shown when it is set — `ResultsView` reads the finding's `error` text and now renders `<ServiceConfigError>` when it names a configuration fault.

- [ ] **Step 1: Write the failing tests**

`src/components/ServiceConfigError.test.tsx`:
1. It renders the "not something you can fix here" sentence.
2. It renders the `callId` as a quotable reference when one is present.
3. It renders **no** reference line when `callId` is absent, rather than an empty label.
4. It renders a Retry that calls `onRetry`.
5. It contains **no** link or button to Settings — `expect(buttonNamed(container, /settings/i)).toBeUndefined()`.

In `src/App.authRedirect.test.tsx`, keep all three existing cases (they cover the reopened-review `authError` interaction, which is unchanged) and add:
6. A live `sign_in_required` during a run shows the sign-in message and does **not** navigate to Settings.
7. A live `service_misconfigured` during a run shows the configuration message **in place**, does **not** navigate to Settings, and shows the `callId`.
8. A live `model_not_allowed` **does** navigate to Settings.
8b. A live `group_overage` shows the overage message, does **not** navigate to Settings, does **not** offer sign-in, and does **not** show the `not_permitted` wording — `expect(container.textContent).not.toContain('does not have access')`.
9. Reopening a review whose only finding already has `authError` still does not redirect anywhere and still renders its findings — the existing behaviour, re-asserted against the new routing.

- [ ] **Step 2: Run and watch them fail**

Run: `npx vitest run --project web src/components/ServiceConfigError.test.tsx src/App.authRedirect.test.tsx`
Expected: FAIL — no component, and the four new App cases still route to Settings.

- [ ] **Step 3: Implement**

`ServiceConfigError.tsx` renders with the existing design vocabulary (`text-risk-high` for the failure line, per R-G19 failure text never uses `ink-4` or below), the reference id in `font-mono`, and a `Button variant="ghost"` Retry.

In `App.tsx`:

```tsx
const SIGN_IN_ERROR_MESSAGE = 'Your sign-in has expired. Sign in again to continue.';
const NOT_PERMITTED_MESSAGE =
  'Your account does not have access to LexPrompt. Ask your IT team to add you.';
/**
 * §7's group overage. Kept as a separate string from NOT_PERMITTED_MESSAGE
 * on purpose: they are two different facts about two different people, and
 * the whole reason `oidc.ts` detects overage separately is that showing the
 * one above to a partner in forty groups would be a wrong answer told with
 * complete confidence.
 */
const GROUP_OVERAGE_MESSAGE =
  'Your account is in too many groups for LexPrompt to read them from your sign-in. '
  + 'This is not something signing in again will fix — ask your IT team to grant LexPrompt '
  + 'directory read access, or to reduce your group memberships.';
const MODEL_UNAVAILABLE_MESSAGE =
  'The model this review was set up with is no longer available. Choose another in Settings.';

/**
 * Replaces `handleAuthError`, which sent every 401/403 to Settings.
 *
 * With the credentials held server-side, "your key was rejected" has split
 * into two facts with two audiences: the user's session expired, which they
 * fix by signing in; and the firm's deployment cannot reach a provider,
 * which they cannot fix at all and must not be sent to Settings to try.
 * Sending a lawyer to a screen with nothing on it that could help is a
 * wrong instruction delivered with authority.
 */
const handleModelError = (error: unknown): void => {
  if (isSignInError(error)) {
    const e = error as ModelError;
    notify(e.code === 'not_permitted' ? NOT_PERMITTED_MESSAGE : SIGN_IN_ERROR_MESSAGE, 'error');
    if (e.code === 'sign_in_required') auth.signIn();
    return;
  }
  if (isServiceConfigError(error)) {
    const e = error as ModelError;
    if (e.code === 'group_overage') {
      notify(GROUP_OVERAGE_MESSAGE, 'error');
      return;   // not Settings, not sign-in: neither can fix it
    }
    if (e.code === 'model_not_allowed' || e.code === 'purpose_not_allowed') {
      notify(MODEL_UNAVAILABLE_MESSAGE, 'error');
      setView('settings');
      return;
    }
    // Stays where the user is, with a reference id. There is nothing in
    // Settings for them to change.
    setServiceConfigError(e);
    return;
  }
  notify(error instanceof Error ? error.message : 'Something went wrong.', 'error');
};
```

Replace all three `isAuthError(e) ? handleAuthError()` sites in `App.tsx`, and the equivalents in `ChatPanel.tsx`, `ResultsView.tsx` and `TemplateEditor.tsx`, with `handleModelError` / `<ServiceConfigError>`.

- [ ] **Step 4: Run everything**

```bash
npx tsc --noEmit && npm test
```

Expected: clean; `ServiceConfigError` 5 tests PASS; `App.authRedirect` 7 tests PASS.

- [ ] **Step 5: Mutation test the routing split**

Change `if (isServiceConfigError(error)) { … setServiceConfigError(e); return; }` to `setView('settings')`. Run. Expected: FAIL on *"a live service_misconfigured shows the configuration message in place and does not navigate to Settings"*. Restore.

- [ ] **Step 6: Commit**

```bash
git add src/components/ServiceConfigError.tsx src/components/ServiceConfigError.test.tsx src/App.tsx src/App.authRedirect.test.tsx src/features/assistant/ChatPanel.tsx src/features/review/ResultsView.tsx src/features/templates/TemplateEditor.tsx
git commit -F .git/COMMIT_MSG_TASK23
```

```
feat(web): split the auth error — the user's problem and the firm's

openrouter.ts's contract was "a 401 means your key was rejected; go to
Settings". With credentials held server-side that is two facts with two
audiences: your session expired, which you fix by signing in; and the
firm's deployment cannot reach a provider, which you cannot fix at all.

A configuration failure now stays where the user is, with a Retry and a
reference id to quote to IT, and never routes to Settings — sending a
lawyer to a screen with nothing on it that could help is a wrong
instruction delivered with authority. A refused model DOES route to
Settings, because that one genuinely is fixable there.

Group overage gets its own message and its own destination — neither Settings
nor sign-in, because neither can fix it. Telling a partner in forty groups
that they have no access to their own firm's tool is a wrong answer told with
complete confidence, and it is the reason oidc.ts detects the case at all.

AUTH_ERROR_MESSAGE is retired. Finding.authError keeps its name and its
persisted meaning; only the sentence a reader sees changes.

Mutation-tested: the configuration branch routed to Settings, one test
fails.
```

---

## Task 24: `docker compose` — Keycloak, the same shape locally, and the egress test

**Type:** infrastructure

**Files:**
- Create: `docker-compose.yml`, `.env.example`, `models.example.json`, `models.local-openai.example.json`, `models.local-recorded.example.json`, `Dockerfile.web`
- Create: `infra/keycloak/lexprompt-realm.json`
- Create: `apps/api/test/egress.compose.test.ts`
- Modify: `package.json` (compose scripts), `README.md` (the running-it section)

**Interfaces:**
- Consumes: everything built so far.
- Produces: `npm run compose:up`, `npm run compose:down`, `npm run test:compose`; a Keycloak issuer at `http://keycloak:8080/realms/lexprompt` (and `http://localhost:8088/realms/lexprompt` from the host) with four seeded accounts.

**Three networks, and that is the whole point.** `api` sits on `frontend` (reachable from the host) and `internal` (reaching the gateway and Keycloak). `gateway` sits on `internal` and `egress`. `api` **is not on `egress`**, so it has no route to the public internet — §5's central claim, exercised in development rather than only asserted in production. `internal` is `internal: true`, so Docker adds no default route to it.

**Keycloak ships in this stage, and the sequencing is forced rather than chosen** (§13). Stage 1 is the first stage that requires a signed-in user, and there is no bypass to stand in for one (S29) — so without a local issuer, **Stage 1 is a stage nobody can run on a laptop.**

**It seeds four accounts, and the reason is not convenience** (S31). A reviewer (trainee), a partner, an admin, **and a user in no mapped group**. Stage 1 enforces no roles — that is Stage 2 — so it would be easy to seed one account now and three later. Do not: **every collaborative behaviour this design adds is unobservable with one user.** First sight of a colleague, a Partner overriding a trainee's verification, the stale-version refusal, assignment reaching a person, presence, a card changing attribution without a reload — each needs two browsers signed in as two different people. A single-user local stack would not be a cheaper version of this; it would be a stack that runs green on exactly the half of the system that needs testing most, and Stages 3 to 5 would be unbuildable on a laptop. Seeding four now is two extra blocks in one version-controlled file; seeding them in Stage 3 is the same two blocks plus a stage spent without them. The fourth account earns its place in **this** stage: being told plainly that you have no access is a Stage 1 behaviour (§7).

**Keycloak is not an Entra emulator, and the compose file must not be read as claiming it is.** Azurite *emulates* Blob Storage; Keycloak *implements the same protocol* Entra implements. Everything in §5.1's "what local does not prove" list stands — group-claim shape, overage (Task 16), consent, conditional access, MFA, tenant token lifetimes.

**Three example model configurations, because owner decision 5 makes the second and third first-class:**
- `models.example.json` — Azure Foundry, UK South, managed identity. Needs `az login`.
- `models.local-openai.example.json` — OpenAI direct, US, `credential.source: env`, plus an Anthropic entry so the picker has two options and the jurisdiction display has something to show.
- `models.local-recorded.example.json` — the `recorded` provider (Task 13), for work with no network and no credential of any kind.

**`GATEWAY_ALLOWED_JURISDICTIONS` has no default and appears in `.env.example` only as a commented example.** Whoever runs this — a firm or one person on a laptop — types their own value, for the same reason the gateway refuses to start without one (D4): which jurisdictions are acceptable follows from the contracts and data provisions they hold with their provider, and neither this compose file nor this plan is entitled to guess.

**§5.1 rows 4, 5 and 6 — Postgres, Azurite, Redis — must NOT appear in this compose file.** They are Stage 2 and later, and §18 item 10(b) fails a divergence row with no configuration key behind it just as it fails a key with no row.

- [ ] **Step 1: Write `docker-compose.yml`**

```yaml
name: lexprompt

networks:
  frontend:
  internal:
    internal: true    # no default route: this network cannot reach the internet
  egress:

services:
  # The local OIDC issuer (S31). NOT an Entra emulator — it implements the
  # same protocol Entra implements, which is a different and weaker claim,
  # and §5.1's "what local does not prove" list is where the difference bites.
  keycloak:
    image: quay.io/keycloak/keycloak:26.0
    command: ["start-dev", "--import-realm"]
    ports: ["8088:8080"]          # published so a BROWSER can redirect to it
    networks: [frontend, internal]
    environment:
      KC_BOOTSTRAP_ADMIN_USERNAME: admin
      KC_BOOTSTRAP_ADMIN_PASSWORD: admin
      KC_HEALTH_ENABLED: "true"
    volumes:
      - "./infra/keycloak:/opt/keycloak/data/import:ro"
    healthcheck:
      test: ["CMD-SHELL", "exec 3<>/dev/tcp/127.0.0.1/9000 && echo -e 'GET /health/ready HTTP/1.1\\r\\nHost: localhost\\r\\nConnection: close\\r\\n\\r\\n' >&3 && cat <&3 | grep -q '\"status\": \"UP\"'"]
      interval: 5s
      retries: 30

  web:
    build: { context: ., dockerfile: Dockerfile.web }
    ports: ["3005:80"]
    networks: [frontend]
    environment:
      VITE_API_BASE_URL: http://localhost:8080
      # The issuer the BROWSER redirects to, so it is the published host
      # address rather than the compose service name.
      VITE_OIDC_ISSUER: ${OIDC_ISSUER_BROWSER}
      VITE_OIDC_CLIENT_ID: ${OIDC_CLIENT_ID}
      VITE_OIDC_SCOPE: ${OIDC_SCOPE}

  api:
    build: { context: ., dockerfile: apps/api/Dockerfile }
    ports: ["8080:8080"]
    # frontend AND internal — deliberately NOT egress. This is the design's
    # central claim as a network fact rather than a code review.
    networks: [frontend, internal]
    environment:
      API_PORT: "8080"
      # §5.1 row 1: the ONLY thing that differs from a firm deployment is
      # these five values. There is no local auth mode and no bypass (S29).
      API_OIDC_ISSUER: ${OIDC_ISSUER_API}
      API_OIDC_AUDIENCE: ${OIDC_AUDIENCE}
      API_OIDC_SUBJECT_CLAIM: ${OIDC_SUBJECT_CLAIM}
      API_OIDC_GROUPS_CLAIM: ${OIDC_GROUPS_CLAIM}
      API_OIDC_REQUIRED_CLAIMS: ${OIDC_REQUIRED_CLAIMS}
      API_WORKSPACE_ID: 00000000-0000-0000-0000-000000000001
      API_GATEWAY_URL: https://gateway:8081
      API_MTLS_CA_FILE: /certs/ca.pem
      API_MTLS_CERT_FILE: /certs/api.pem
      API_MTLS_KEY_FILE: /certs/api.key
    volumes: ["./certs:/certs:ro"]
    depends_on:
      gateway: { condition: service_started }
      keycloak: { condition: service_healthy }

  gateway:
    build: { context: ., dockerfile: apps/gateway/Dockerfile }
    # NO ports: — unreachable from the host, by construction.
    networks: [internal, egress]
    environment:
      GATEWAY_PORT: "8081"
      GATEWAY_MODELS_FILE: /config/models.json
      # NO DEFAULT (D4, owner decision 5). Unset means the gateway refuses to
      # start, which is what we want: which jurisdictions are permitted
      # follows from the operator's own contracts with their provider, and a
      # compose file has no standing to guess. There is also no
      # GATEWAY_UPSTREAM — offline working is the `recorded` provider on the
      # allowlist (Task 13), not a mode, because a mode would be an
      # environment branch (S30).
      GATEWAY_ALLOWED_JURISDICTIONS: ${GATEWAY_ALLOWED_JURISDICTIONS}
      GATEWAY_CALLER_AUTH: mtls
      GATEWAY_MTLS_CA_FILE: /certs/ca.pem
      GATEWAY_MTLS_CERT_FILE: /certs/gateway.pem
      GATEWAY_MTLS_KEY_FILE: /certs/gateway.key
      GATEWAY_MTLS_ALLOWED_SUBJECT: lexprompt-api
      OPENAI_API_KEY: ${OPENAI_API_KEY:-}
      ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY:-}
      OPENROUTER_API_KEY: ${OPENROUTER_API_KEY:-}
    volumes:
      - "./certs:/certs:ro"
      - "./models.json:/config/models.json:ro"
```

- [ ] **Step 2: Write `.env.example`**

```sh
# ---------------------------------------------------------------------------
# Identity (§5.1 row 1). These five values are the WHOLE of what differs
# between this stack and a firm deployment. There is no local auth mode and
# no bypass: no SKIP_AUTH, no anonymous mode, no trusted header (S29).
#
# Locally: Keycloak, seeded from infra/keycloak/lexprompt-realm.json.
# In a firm: Entra, and the same five variables read
#   OIDC_ISSUER_API=https://login.microsoftonline.com/<tenant>/v2.0
#   OIDC_SUBJECT_CLAIM=oid
#   OIDC_REQUIRED_CLAIMS={"tid":"<tenant>"}
# ---------------------------------------------------------------------------
OIDC_ISSUER_API=http://keycloak:8080/realms/lexprompt
OIDC_ISSUER_BROWSER=http://localhost:8088/realms/lexprompt
OIDC_AUDIENCE=lexprompt-api
OIDC_CLIENT_ID=lexprompt-web
OIDC_SCOPE=openid profile email lexprompt-api
OIDC_SUBJECT_CLAIM=sub
OIDC_GROUPS_CLAIM=groups
OIDC_REQUIRED_CLAIMS={}

# ---------------------------------------------------------------------------
# Which processing jurisdictions this deployment permits.
#
# THERE IS NO DEFAULT, AND THIS LINE IS DELIBERATELY COMMENTED OUT. The
# gateway refuses to start until you set it. That is not an obstacle to work
# around; it is the one value nobody but you can supply.
#
# Which jurisdictions are acceptable follows from the contracts and data
# provisions YOU hold with YOUR provider — SCCs, a DPA, negotiated retention
# and training terms, settled with legal input long before anyone edited this
# file. The API key is just the interface to a service whose guarantees live
# in that contract. LexPrompt enforces the policy you declare here; it has no
# view of its own about which jurisdictions are acceptable, and a default
# value would be exactly such a view, applied silently on your behalf.
#
# Valid values: UK, EU, US, other (comma-separated).
#   OpenAI direct, Anthropic direct and OpenRouter process in the US.
#   The `recorded` provider (offline fixtures) declares `other`.
#
# Uncomment and set to match your own provisions, for example:
# GATEWAY_ALLOWED_JURISDICTIONS=UK,EU
# GATEWAY_ALLOWED_JURISDICTIONS=UK,EU,US
# ---------------------------------------------------------------------------

# One key per provider you have configured in models.json. Leave the rest
# empty. None of these ever leaves the gateway container.
OPENAI_API_KEY=
ANTHROPIC_API_KEY=
OPENROUTER_API_KEY=
```

**There is deliberately no `GATEWAY_UPSTREAM`.** Working offline is the `recorded` provider on the allowlist (Task 13), not a mode — a mode would be an environment branch, which S30 forbids and §18 item 10(a) fails.

- [ ] **Step 3: Write the seeded Keycloak realm**

`infra/keycloak/lexprompt-realm.json`, version-controlled, imported by `--import-realm`. It must define:

- **Realm** `lexprompt`, `enabled: true`, `sslRequired: "none"` (loopback only — the API's `assertIssuerUsable` allows `http` on loopback and a dotless compose host, and nothing else).
- **A `groups` client scope** with a **group-membership mapper** named `groups`, `full.path: false`, `add.to.access.token: true`. Without this Keycloak issues no group claim at all and every seeded account looks like the no-access one — the single most likely way to lose an afternoon on this task.
- **Two clients.** `lexprompt-web`: public, `standardFlowEnabled: true`, `publicClient: true`, PKCE required (`pkce.code.challenge.method: S256`), redirect URIs `http://localhost:3005/*`, web origins `http://localhost:3005`, and the `groups` scope as a default. `lexprompt-api`: bearer-only, and the **audience** `lexprompt-api` added to `lexprompt-web`'s tokens by an audience mapper — without it every token is rejected for the wrong audience and the failure reads like a code bug.
- **Three groups:** `reviewers`, `partners`, `admins`.
- **Four users**, each `enabled: true`, `emailVerified: true`, with a non-temporary password:

| Username | Password | Group | Exists to test |
|---|---|---|---|
| `trainee` | `trainee` | `reviewers` | the ordinary case |
| `partner` | `partner` | `partners` | Stage 2's role gate; Stage 4's override |
| `admin` | `admin` | `admins` | Stage 2's admin routes |
| `nogroups` | `nogroups` | *(none)* | **a Stage 1 behaviour**: being told plainly you have no access (§7) |

Print all four from `docker compose up` — add an `echo` step to `compose:up` in `package.json` rather than expecting anyone to open the realm file:

```
LexPrompt local accounts (Keycloak realm 'lexprompt'):
  trainee / trainee    reviewers
  partner / partner    partners
  admin   / admin      admins
  nogroups / nogroups  (no group — expect to be refused, on purpose)
```

**These are development credentials in version control, deliberately.** They reach a realm that only exists inside `docker compose`, on an issuer the API refuses unless it is loopback — and the alternative, generating them per developer, would mean the seeded set differs per machine, which is the local/deployed divergence problem one level down.

- [ ] **Step 4: Write the three example model files**

`models.example.json` — one `azure-foundry` entry, `uksouth`, `credential: { source: 'managed-identity', scope: 'https://cognitiveservices.azure.com/.default' }`, `isDefault: true`.

`models.local-openai.example.json` — one `openai` entry, jurisdiction `{ bloc: 'US', region: 'us', label: 'United States' }`, `credential: { source: 'env', var: 'OPENAI_API_KEY' }`, `isDefault: true`, with a sibling `anthropic` entry (`isDefault: false`, `credential.var: ANTHROPIC_API_KEY`) so the picker has two options and the jurisdiction display has something to show.

`models.local-recorded.example.json` — one `recorded` entry (Task 13), jurisdiction `{ bloc: 'other', region: 'local', label: 'this machine — recorded responses, not a model' }`, `credential: { source: 'env', var: 'UNUSED' }`, `isDefault: true`. Using it requires `GATEWAY_ALLOWED_JURISDICTIONS=other`, which the operator types, like every other value of that variable.

- [ ] **Step 5: Write the egress test**

`apps/api/test/egress.compose.test.ts` (excluded from the default `api` project by Task 1's `exclude`; run by `npm run test:compose`):

```ts
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';

const inApi = (script: string): { code: number; out: string } => {
  try {
    const out = execFileSync('docker', [
      'compose', 'exec', '-T', 'api', 'node', '-e', script,
    ], { encoding: 'utf8', timeout: 30_000 });
    return { code: 0, out };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
};

describe('apps/api cannot egress (S1, §18.7)', () => {
  it('CANNOT reach a model provider directly', () => {
    const r = inApi(
      "fetch('https://api.openai.com/v1/models',{signal:AbortSignal.timeout(8000)})"
      + ".then(res=>{console.log('REACHED '+res.status);process.exit(9)})"
      + ".catch(e=>{console.log('BLOCKED '+e.message);process.exit(0)})",
    );
    expect(r.out).toContain('BLOCKED');
    expect(r.out).not.toContain('REACHED');
  });

  it('CANNOT reach the public internet at all', () => {
    const r = inApi(
      "fetch('https://example.com',{signal:AbortSignal.timeout(8000)})"
      + ".then(()=>{console.log('REACHED');process.exit(9)})"
      + ".catch(e=>{console.log('BLOCKED '+e.message);process.exit(0)})",
    );
    expect(r.out).toContain('BLOCKED');
  });

  // The other half: a test that only proves api is offline would pass with
  // the whole stack unplugged and prove nothing.
  it('CAN reach the gateway', () => {
    const r = inApi(
      "const t=require('node:tls');const s=t.connect({host:'gateway',port:8081,"
      + "rejectUnauthorized:false},()=>{console.log('REACHED');s.end();process.exit(0)});"
      + "s.on('error',e=>{console.log('BLOCKED '+e.message);process.exit(9)});",
    );
    expect(r.out).toContain('REACHED');
  });

  it('and the gateway CAN reach the internet, so the block is api-specific', () => {
    let out = '';
    try {
      out = execFileSync('docker', ['compose', 'exec', '-T', 'gateway', 'node', '-e',
        "fetch('https://example.com',{signal:AbortSignal.timeout(8000)})"
        + ".then(()=>{console.log('REACHED')}).catch(e=>{console.log('BLOCKED '+e.message)})",
      ], { encoding: 'utf8', timeout: 30_000 });
    } catch (err) { out = String((err as { stdout?: string }).stdout ?? ''); }
    expect(out).toContain('REACHED');
  });
});
```

Add to the root `package.json`:

```json
    "compose:up": "docker compose up -d --build",
    "compose:down": "docker compose down -v",
    "test:compose": "vitest run --project api apps/api/test/egress.compose.test.ts --config vitest.compose.config.ts",
```

with `vitest.compose.config.ts` a two-line config including only `apps/api/test/**/*.compose.test.ts` under a node environment.

- [ ] **Step 6: Run the stack and the test**

```bash
bash scripts/dev-certs.sh
cp .env.example .env && cp models.local-openai.example.json models.json
npm run compose:up
```

Expected on the first run: **the gateway refuses to start**, because `GATEWAY_ALLOWED_JURISDICTIONS` is commented out in `.env.example` and has no default. That is the intended first experience, not a snag — read the message, decide which jurisdictions your provisions cover, and set it. Then:

```bash
# set OPENAI_API_KEY, and uncomment GATEWAY_ALLOWED_JURISDICTIONS with your own value
npm run compose:up
docker compose logs gateway | head -20
docker compose logs keycloak | grep -i "imported\|Running the server"
npm run test:compose
```

Expected: the gateway's boot banner listing the permitted jurisdictions and the model table; Keycloak reporting the realm imported; then 4 tests PASS.

Then open `http://localhost:3005`, sign in as `trainee` / `trainee`, and run a review end to end. **Sign in as `nogroups` too** and confirm you are told plainly that you have no access rather than shown an empty app (§7) — that is a Stage 1 behaviour and this is the account that tests it.

**No Entra tenant is needed for any of this**, which is the point of S31: the deployed authentication path runs on the laptop. What it does not prove is in §5.1's list and in Task 26's README — managed identity, Entra's group-claim shape and overage, consent, conditional access, Azure networking. **If you skip any step, say so plainly** rather than implying you ran it; `models.local-recorded.example.json` gets you everything but a real model answer.

- [ ] **Step 7: Mutation test the egress restriction**

Add `egress` to `api`'s `networks` in `docker-compose.yml`, `npm run compose:up`, `npm run test:compose`. Expected: FAIL on *"CANNOT reach a model provider directly"* and *"CANNOT reach the public internet at all"*. Remove it, bring the stack back up, re-run: PASS.

This is the mutation §14 names under `egress` and §19 calls the difference between the design's central claim being architecture and being a promise. Record that you ran it.

- [ ] **Step 8: Mutation test the seeded group claim**

Set `add.to.access.token: false` on the realm's `groups` mapper, `npm run compose:up`, and sign in as `trainee`. Expected: the API reports **no groups**, which in Stage 2 will be indistinguishable from `nogroups`. Restore.

Run this once, by hand, and record that you did: it is not a unit test, and it is the failure mode that will otherwise be discovered in Stage 2 by someone who assumes the realm file is right because it imported without error.

- [ ] **Step 9: Commit**

```bash
git add docker-compose.yml Dockerfile.web .env.example models.example.json models.local-openai.example.json models.local-recorded.example.json infra/keycloak apps/api/test/egress.compose.test.ts vitest.compose.config.ts package.json README.md
git commit -F .git/COMMIT_MSG_TASK24
```

```
feat: docker compose, with api's egress denied by the network

Three networks: api on frontend+internal, gateway on internal+egress. api is
not on egress and internal has no default route, so "the API cannot reach a
model" is a network fact in development, not only in production. Four tests
assert it — api cannot reach a provider, cannot reach the internet, CAN
reach the gateway, and the gateway CAN reach the internet, so a stack that
is simply unplugged does not pass.

Keycloak ships here and the sequencing is forced: Stage 1 is the first stage
needing a signed-in user and there is no bypass to stand in for one (S29), so
without it Stage 1 is a stage nobody can run on a laptop. Its realm seeds
four accounts — trainee, partner, admin, and one in no group — because every
collaborative behaviour this design adds is unobservable with one user, and
the fourth tests a Stage 1 behaviour: being told plainly you have no access.

Three example model configurations, because running with an OpenAI or
OpenRouter key and no Azure — or with recorded fixtures and no credential at
all — are first-class paths, not degraded ones.

GATEWAY_ALLOWED_JURISDICTIONS has no default and appears in .env.example only
as a commented example with the reasoning beside it, so the first
`compose up` fails and asks. That is the intended first experience: which
jurisdictions are acceptable follows from the operator's own contracts with
their provider, and neither this compose file nor this plan is entitled to
guess. There is no GATEWAY_UPSTREAM either — offline working is the
`recorded` provider on the allowlist, not a mode, because a mode would be
an environment branch (S30).

Rows 4, 5 and 6 of §5.1 — Postgres, Azurite, Redis — are deliberately absent:
they are Stage 2 and later, and §18 item 10(b) fails a divergence row with no
key behind it just as it fails a key with no row.

Mutation-tested: api attached to the egress network, two tests fail. Plus one
by hand: the realm's group mapper set to add.to.access.token=false, which
makes every seeded account look like the no-access one.
```

---

## Task 25: `azd` and Bicep — the same shape in Azure

**Type:** infrastructure

**Files:**
- Create: `azure.yaml`, `infra/main.bicep`, `infra/main.parameters.json`, `infra/modules/containerApps.bicep`, `infra/modules/identity.bicep`, `infra/modules/keyVault.bicep`, `infra/modules/monitoring.bicep`
- Modify: `README.md` (deployment)

**Interfaces:**
- Consumes: the two Dockerfiles and the environment variables named in Tasks 4, 15, 16, 24.
- Produces: `azd up` provisioning a Container Apps environment with `web`, `api` and `gateway`.

**What the Bicep must express, and each is a requirement rather than a preference:**

1. **The gateway has `ingress.external: false`** and is reachable only from inside the Container Apps environment. Its `GATEWAY_CALLER_AUTH` is `entra`, its audience is its own app registration, and its allowed subject is `api`'s user-assigned managed identity principal id.
1b. **`GATEWAY_ALLOWED_JURISDICTIONS` is a required parameter with NO default value in the Bicep** (D4, owner decision 5). `@description` states what it is for and that it must match the operator's own contracts and data provisions; there is no `= 'UK,EU'`. `azd up` therefore prompts for it, which is the right moment to be asked. A Bicep default would reintroduce, in infrastructure, exactly the assumption the config loader refuses to make in code.
1c. **The three OIDC values are parameters too** — `oidcIssuer`, `oidcAudience`, `oidcSubjectClaim` (`oid` for Entra), `oidcGroupsClaim`, `oidcRequiredClaims` (`{"tid":"<tenant>"}`). They are the same five keys the compose file sets to Keycloak's values (§5.1 row 1), passed to the same code. **Nothing in the Bicep is read by an Entra-specific code path**, because there is not one.
2. **`api` has no outbound access to the public internet.** Express it, and **record honestly in the file's own comment whether that is enforced at this layer or awaits Spike 2** (§15): Container Apps' egress controls depend on the environment's VNet integration and a route table or NAT configuration, and the plan does not pretend to have proved which. Task 24's compose test is what holds in the meantime, and §18.7's "asserted by a test" is not satisfied for Azure until Spike 2 lands. **Say so in the README rather than implying the deployment is proven.**
3. **The gateway has a user-assigned managed identity** with `Cognitive Services OpenAI User` on the Foundry/Azure OpenAI resource, and `Key Vault Secrets User` on the vault. **No key is a parameter, an output, or an app setting** — vaulted keys are referenced by `credential.source: 'key-vault'` in `models.json` and fetched at runtime.
4. **`models.json` is a Container Apps secret volume or a config-map-style mounted secret**, not an inline environment variable, so it is not visible in the portal's app-settings blade or in `azd env get-values`.
5. **Log Analytics retention is 90 days** for the gateway's call log (§10) and the workspace is created by `monitoring.bicep`.
6. **No Postgres, no Blob, no private endpoints for them.** Those are Stage 2. A `main.bicep` that provisions a database Stage 1 does not use would be infrastructure nobody has tested and a bill nobody expected.

- [ ] **Step 1: Write `azure.yaml`**

```yaml
name: lexprompt
metadata:
  template: lexprompt-stage1
services:
  web:
    project: .
    language: js
    host: containerapp
    docker: { path: ./Dockerfile.web, context: . }
  api:
    project: ./apps/api
    language: js
    host: containerapp
    docker: { path: ./Dockerfile, context: ../.. }
  gateway:
    project: ./apps/gateway
    language: js
    host: containerapp
    docker: { path: ./Dockerfile, context: ../.. }
```

- [ ] **Step 2: Write the Bicep modules**

`identity.bicep` — two user-assigned identities (`api`, `gateway`) and the two role assignments in point 3, with `principalId` outputs.

`keyVault.bicep` — a vault with RBAC authorisation, **no secrets defined in the template** (an operator adds provider keys with `az keyvault secret set`, which keeps them out of the repository, out of `azd env`, and out of any deployment log).

`monitoring.bicep` — a Log Analytics workspace with `retentionInDays: 90`.

`containerApps.bicep` — the environment and three apps. The gateway's:

```bicep
    ingress: {
      external: false          // internal only: no route from the internet
      targetPort: 8081
      transport: 'http'
    }
    // No provider key appears here. Credentials are resolved at runtime
    // from this container's managed identity (Azure) or from Key Vault by
    // that identity — never from an app setting, which is readable in the
    // portal and in `azd env get-values`.
```

- [ ] **Step 3: Deploy and verify**

```bash
azd auth login
azd up      # prompts for allowedJurisdictions — there is no default; answer from your own provisions
azd env get-values | grep -i -E 'key|secret|password' ; echo "exit=$?  <-- expect no matches"
azd env get-values | grep -i 'allowedJurisdictions'   # <-- expect the value YOU supplied
```

Then, against the deployed environment:
1. Open the web app, sign in with a firm account, and confirm the model picker lists the configured models with their jurisdictions.
2. Run a one-clause review and confirm a finding comes back.
3. `az containerapp logs show --name gateway --tail 20` and confirm one `call.started` and one `call.finished` per call, **carrying no prompt text**.
4. Confirm the gateway's FQDN is `*.internal.*` and that `curl` from outside the environment cannot reach it.

**If you cannot deploy, say so plainly.** This step cannot be simulated and the plan must not read as though it were.

- [ ] **Step 4: Commit**

```bash
git add azure.yaml infra README.md
git commit -F .git/COMMIT_MSG_TASK25
```

```
feat(infra): azd + Bicep for the Stage 1 shape

Three container apps; the gateway internal-only, authenticating its one
caller by Entra and its providers by managed identity or Key Vault. No key
is a parameter, an output or an app setting — an operator sets vaulted keys
with az keyvault secret set, so they are in neither the repository nor
`azd env get-values`.

models.json is a mounted secret rather than an env var, so the allowlist and
its endpoints are not in the portal's app-settings blade.

GATEWAY_ALLOWED_JURISDICTIONS is a required parameter with no default, so
azd up prompts for it. A Bicep default would reintroduce in infrastructure
exactly the assumption the config loader refuses to make in code: which
jurisdictions a firm accepts follows from its own contracts, and this
template has no standing to guess.

The five OIDC values are parameters, identical in shape to the ones compose
sets to Keycloak's — §5.1 row 1, one code path, two issuers.

No Postgres and no Blob: those are Stage 2, and provisioning them now would
be infrastructure nobody has tested and a bill nobody expected.

api's egress denial is expressed here but is NOT yet asserted by a test in
Azure — that is Spike 2. The comment in containerApps.bicep and the README
both say so rather than implying it is proven; Task 24's compose test is
what holds until then.
```

---

## Task 26: `configSurface`, the README, the rulings, and the Stage 1 definition-of-done sweep

**Type:** test + documentation

**Files:**
- Modify: `README.md`
- Modify: `docs/superpowers/redesign/rulings.md`
- Create: `src/lib/model/stage1DoD.test.ts`
- Create: `apps/api/test/configSurface.test.ts`, `apps/api/test/divergence.json`

**Interfaces:**
- Consumes: everything, and the three configuration modules — `src/lib/config.ts` (Task 19), `apps/api/src/config.ts` (Task 16), `apps/gateway/src/config.ts` (Task 4).
- Produces: a test that fails if any part of Stage 1's definition of done regresses, and the `configSurface` suite §18 item 10 requires.

**This task grew with spec Revision 2.** It gains §18 item 10 — the check that makes §5.1's divergence table verifiable rather than aspirational, and **the one guarantee in this design not otherwise enforced by a test at rest.** It is folded in here rather than given its own task because it is the same job as the rest of this task: a mechanical sweep that fails when a claim made elsewhere stops being true.

**The README rows §2 assigns to Stage 1** (the rest are Stage 2's and are not touched):

| Location | Replace with |
|---|---|
| Line 3, intro — "no backend … talks directly to OpenRouter" | *"a static web app, an HTTP API and an inference gateway you deploy into your own cloud. Your matters and documents still live in your browser (that changes in a later release); model calls go through the gateway."* |
| §"No backend, no accounts" | Rewritten, not deleted: matters and documents **are** still in the browser in Stage 1. It becomes "No database yet", explains what the three services do, and says the browser is still the store. |
| §"You need an OpenRouter API key" (105–113) | **Deleted.** Replaced by §"Choosing a model provider" — see the new sections below. |
| §Privacy bullet 2 — "except to the model you chose, via OpenRouter" | *"Nothing is uploaded anywhere except to your firm's own LexPrompt gateway, which forwards it to the model provider your administrator configured. Which provider that is, and where it processes your text, is shown on every model in Settings."* |
| §Visual system (96) — "nothing leaves the browser except calls to OpenRouter" | *"nothing leaves the browser except calls to your firm's own API"* |
| §"How it's built" — "No backend, no server-side anything" | The monorepo: `packages/core`, `apps/api`, `apps/gateway`, and the web app. |
| §"Building and deploying" | `docker compose up` and `azd up`, with the SPA-rewrite note kept for the web app's hosting. |
| §Known limitations | Add: *"`api`'s inability to reach the internet is enforced and tested under `docker compose`; in Azure it is expressed in the Bicep but is not yet asserted by an automated test — that is Spike 2."* |
| **New section: §"Running it locally"** | `docker compose up` brings up the whole stack including **Keycloak**, with four seeded accounts printed on start (`trainee`, `partner`, `admin`, `nogroups`). **There is no way to run LexPrompt without signing in** — no `SKIP_AUTH`, no anonymous mode — because a bypass would test a different code path from the one that ships (S29). The four accounts exist because every collaborative behaviour this design adds is unobservable with one user (S31). |
| **New section: §"Choosing a model provider"** | The allowlist, the six providers (five real plus `recorded`), the four credential sources, and `GATEWAY_ALLOWED_JURISDICTIONS` — **which has no default and which the gateway refuses to start without.** State why in the operator's own terms: *"Which jurisdictions you permit follows from the contracts and data provisions you hold with your provider. LexPrompt enforces the policy you declare; it has no view of its own, and a default would be exactly such a view applied silently on your behalf."* Also: **the per-provider retention note is your record of terms you agreed**, carrying the date you last checked them — the staleness marker prompts you to re-read your own contract and passes no judgement on the provider. |
| **New section: §"What running locally does not prove"** | §5.1's list, verbatim in substance: managed-identity acquisition; Entra's group-claim shape, consent and **overage**; admin consent, conditional access, MFA and tenant token lifetimes; Azure networking and the real egress denial; Postgres Flexible Server's behaviour; Azurite's gaps; real provider latency, rate limits and stream behaviour; Container Apps scale-to-zero and multi-replica WebSockets. And the sentence the whole section turns on: **"Keycloak is not an Entra emulator. Azurite *emulates* Blob Storage; Keycloak *implements the same protocol* Entra implements."** §5.1 says this list belongs in the README as well as the spec, because the reader who needs it is the developer who has just had a green local run, and they are not reading a design document at that moment. |

**The two sentences that must appear, adjacent and distinct** (owner decision 2):

> **No credential ever leaves the gateway, and every call is logged with its provider and jurisdiction, whichever backend you configure.**
>
> **If you deploy against Azure with managed identity, the stronger property holds: no provider keys exist at all — not in a browser, not in an environment variable, not in Key Vault, not in a git history. That is the recommended posture for a firm with Azure.**

Do not merge them into one sentence and do not put the second one in a footnote. Both are true; conflating them is how a security claim quietly becomes false for half its deployments.

- [ ] **Step 1: Write the `configSurface` suite (§18 item 10)**

`apps/api/test/divergence.json` — §5.1's table, as data, listing only the rows Stage 1 touches. **A row here with no configuration key behind it fails, exactly as a key with no row does**, which is what stops the table decaying into a list of good intentions:

```json
{
  "rows": [
    { "n": 1, "what": "Identity issuer", "keys": [
      "OIDC_ISSUER_API", "OIDC_ISSUER_BROWSER", "OIDC_AUDIENCE",
      "OIDC_CLIENT_ID", "OIDC_SCOPE", "OIDC_SUBJECT_CLAIM",
      "OIDC_GROUPS_CLAIM", "OIDC_REQUIRED_CLAIMS"
    ] },
    { "n": 2, "what": "Inference provider and credential", "keys": ["GATEWAY_MODELS_FILE"] },
    { "n": 3, "what": "Provider secret source", "keys": [
      "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "OPENROUTER_API_KEY"
    ] },
    { "n": 7, "what": "api egress denial", "keys": [] },
    { "n": 8, "what": "Gateway log sink", "keys": [] },
    { "n": 9, "what": "Ingress and TLS", "keys": [
      "API_MTLS_CA_FILE", "API_MTLS_CERT_FILE", "API_MTLS_KEY_FILE",
      "GATEWAY_MTLS_CA_FILE", "GATEWAY_MTLS_CERT_FILE",
      "GATEWAY_MTLS_KEY_FILE", "GATEWAY_MTLS_ALLOWED_SUBJECT",
      "GATEWAY_CALLER_AUTH", "API_GATEWAY_URL", "VITE_API_BASE_URL"
    ] }
  ],
  "rowsWithNoKeys": {
    "7": "Infrastructure, not application code: compose networks versus Container Apps egress rules. Asserted by apps/api/test/egress.compose.test.ts (Task 24) and by Spike 2 in Azure.",
    "8": "The gateway writes the same JSON lines to stdout in both environments (§10.5). What differs is the collector, which reads them; no application key varies."
  },
  "sameEverywhere": [
    "GATEWAY_ALLOWED_JURISDICTIONS",
    "GATEWAY_PORT", "API_PORT", "API_WORKSPACE_ID",
    "GATEWAY_MAX_PROMPT_CHARS", "GATEWAY_REQUEST_TIMEOUT_MS",
    "GATEWAY_DEFAULT_MAX_TOKENS", "GATEWAY_RPM_PER_ACTOR",
    "GATEWAY_RPM_PER_WORKSPACE", "GATEWAY_TOKENS_PER_HOUR_PER_ACTOR",
    "GATEWAY_TOKENS_PER_HOUR_PER_WORKSPACE"
  ]
}
```

**`GATEWAY_ALLOWED_JURISDICTIONS` is in `sameEverywhere`, not in a divergence row**, and that is a deliberate and load-bearing placement. It is not a value that differs *because* one environment is local; it is a value the operator supplies in **both**, from the same source — their own contracts and data provisions — and neither has a default (D4). Filing it as a divergence would say the two environments are entitled to different policies, which is the opposite of what the owner decided.

`apps/api/test/configSurface.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '../../..');
const DIVERGENCE = JSON.parse(readFileSync(path.join(__dirname, 'divergence.json'), 'utf8')) as {
  rows: { n: number; what: string; keys: string[] }[];
  rowsWithNoKeys: Record<string, string>;
  sameEverywhere: string[];
};

const walk = (dir: string, out: string[] = []): string[] => {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir)) {
    if (e === 'node_modules' || e === 'dist') continue;
    const full = path.join(dir, e);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(full) && !/\.test\.tsx?$/.test(full)) out.push(full);
  }
  return out;
};

const CONFIG_MODULES = [
  'src/lib/config.ts',
  'apps/api/src/config.ts',
  'apps/gateway/src/config.ts',
].map(f => path.join(ROOT, f));

const APP_SOURCES = [
  ...walk(path.join(ROOT, 'src')),
  ...walk(path.join(ROOT, 'apps/api/src')),
  ...walk(path.join(ROOT, 'apps/gateway/src')),
];

// ---- §18 item 10(a): no module branches on the environment ----
describe('no module branches on the environment (S30)', () => {
  it('nothing reads NODE_ENV, isLocal, or if (dev)', () => {
    const offenders: string[] = [];
    for (const file of APP_SOURCES) {
      const text = readFileSync(file, 'utf8');
      const rel = path.relative(ROOT, file);
      if (/\bNODE_ENV\b/.test(text)) offenders.push(`${rel} reads NODE_ENV`);
      if (/\bisLocal\b|\bisDev\b|\bisProduction\b/.test(text)) offenders.push(`${rel} branches on the environment`);
      if (/\bimport\.meta\.env\.DEV\b|\bimport\.meta\.env\.PROD\b/.test(text)) offenders.push(`${rel} reads a Vite mode flag`);
    }
    expect(offenders).toEqual([]);
  });

  it('nothing outside the three config modules reads process.env or import.meta.env', () => {
    const offenders: string[] = [];
    for (const file of APP_SOURCES) {
      if (CONFIG_MODULES.includes(file)) continue;
      const text = readFileSync(file, 'utf8');
      const rel = path.relative(ROOT, file);
      if (/process\.env/.test(text)) offenders.push(`${rel} reads process.env`);
      if (/import\.meta\.env/.test(text)) offenders.push(`${rel} reads import.meta.env`);
    }
    expect(offenders).toEqual([]);
  });
});

// ---- §18 item 10(b): the configuration diff IS the divergence list ----
describe('the configuration diff is exactly §5.1s divergence list (S30)', () => {
  const envKeys = (file: string): Set<string> => {
    const text = readFileSync(path.join(ROOT, file), 'utf8');
    return new Set([...text.matchAll(/^\s*([A-Z][A-Z0-9_]+)\s*[:=]/gm)].map(m => m[1]));
  };

  const local = new Set([...envKeys('.env.example'), ...envKeys('docker-compose.yml')]);
  const deployed = envKeys('infra/main.parameters.json');
  const tabled = new Set(DIVERGENCE.rows.flatMap(r => r.keys));
  const same = new Set(DIVERGENCE.sameEverywhere);

  it('every key that differs between the environments is named by a table row', () => {
    const differing = [...local].filter(k => !deployed.has(k) && !same.has(k))
      .concat([...deployed].filter(k => !local.has(k) && !same.has(k)));
    expect(differing.filter(k => !tabled.has(k))).toEqual([]);
  });

  // The half that stops the table rotting into optimism.
  it('every table row has a key behind it, or an explicit reason why not', () => {
    const orphans = DIVERGENCE.rows
      .filter(r => r.keys.length === 0 && !(String(r.n) in DIVERGENCE.rowsWithNoKeys))
      .map(r => `row ${r.n} (${r.what}) names no key and gives no reason`);
    expect(orphans).toEqual([]);
  });

  it('every tabled key actually appears in at least one environment', () => {
    const ghosts = [...tabled].filter(k => !local.has(k) && !deployed.has(k));
    expect(ghosts).toEqual([]);
  });

  // Owner decision 5: this is a value the operator supplies in BOTH
  // environments, from the same source, so it is not a divergence — and it
  // must have no default in either.
  it('GATEWAY_ALLOWED_JURISDICTIONS is the same-everywhere kind, and has no default', () => {
    expect(same.has('GATEWAY_ALLOWED_JURISDICTIONS')).toBe(true);
    expect(tabled.has('GATEWAY_ALLOWED_JURISDICTIONS')).toBe(false);

    const gatewayConfig = readFileSync(path.join(ROOT, 'apps/gateway/src/config.ts'), 'utf8');
    expect(gatewayConfig).not.toMatch(/GATEWAY_ALLOWED_JURISDICTIONS\s*\?\?/);

    const compose = readFileSync(path.join(ROOT, 'docker-compose.yml'), 'utf8');
    expect(compose).not.toMatch(/GATEWAY_ALLOWED_JURISDICTIONS[^\n]*:-/);

    // In .env.example it may appear ONLY as a comment.
    for (const line of readFileSync(path.join(ROOT, '.env.example'), 'utf8').split('\n')) {
      if (line.includes('GATEWAY_ALLOWED_JURISDICTIONS')) {
        expect(line.trimStart().startsWith('#')).toBe(true);
      }
    }

    const bicep = readFileSync(path.join(ROOT, 'infra/main.bicep'), 'utf8');
    expect(bicep).not.toMatch(/param allowedJurisdictions[^\n]*=/);
  });
});
```

- [ ] **Step 2: Write the sweep test**

`src/lib/model/stage1DoD.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '../../..');
const walk = (dir: string, out: string[] = []): string[] => {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir)) {
    if (['node_modules', 'dist', '.git', 'test_docs', 'fixtures'].includes(e)) continue;
    const full = path.join(dir, e);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(full)) out.push(full);
  }
  return out;
};

const CLIENT_FILES = walk(path.join(ROOT, 'src'));

describe('Stage 1 definition of done (§18.2)', () => {
  it('no OpenRouter API key exists anywhere in the browser codebase', () => {
    const offenders: string[] = [];
    for (const file of CLIENT_FILES) {
      if (file.endsWith('stage1DoD.test.ts')) continue;
      const text = readFileSync(file, 'utf8');
      if (/\bapiKey\b/.test(text) && !/purgedApiKey|delete stored\.apiKey|'apiKey'/.test(text)) {
        offenders.push(`${path.relative(ROOT, file)} still references apiKey`);
      }
      if (text.includes('openrouter.ai')) {
        offenders.push(`${path.relative(ROOT, file)} still names openrouter.ai`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('src/lib/openrouter.ts is gone', () => {
    expect(existsSync(path.join(ROOT, 'src/lib/openrouter.ts'))).toBe(false);
  });

  it('every model call in the browser goes through the gateway client', () => {
    const offenders: string[] = [];
    for (const file of CLIENT_FILES) {
      if (file.includes(path.join('lib', 'model')) || file.endsWith('.test.ts') || file.endsWith('.test.tsx')) continue;
      const text = readFileSync(file, 'utf8');
      // A direct fetch to any host outside the app's own API is an egress
      // path the gateway does not see.
      const m = text.match(/fetch\(\s*['"`]https?:\/\/[^'"`]+/g);
      if (m) offenders.push(`${path.relative(ROOT, file)}: ${m.join(', ')}`);
    }
    expect(offenders).toEqual([]);
  });

  it('MSAL is nowhere in the repository (S28)', () => {
    const pkg = readFileSync(path.join(ROOT, 'package.json'), 'utf8');
    expect(pkg).not.toContain('msal');
    const offenders = CLIENT_FILES
      .filter(f => !f.endsWith('stage1DoD.test.ts'))
      .filter(f => /msal/i.test(readFileSync(f, 'utf8')))
      .map(f => path.relative(ROOT, f));
    expect(offenders).toEqual([]);
  });

  it('there is no authentication bypass anywhere (S29)', () => {
    const scan = [...CLIENT_FILES, ...walk(path.join(ROOT, 'apps/api/src')),
      ...walk(path.join(ROOT, 'apps/gateway/src'))];
    const offenders: string[] = [];
    for (const file of scan) {
      if (file.endsWith('stage1DoD.test.ts')) continue;
      const text = readFileSync(file, 'utf8');
      for (const bad of ['SKIP_AUTH', 'DISABLE_AUTH', 'ALLOW_ANONYMOUS', 'AUTH_BYPASS', 'x-trusted-user']) {
        if (text.includes(bad)) offenders.push(`${path.relative(ROOT, file)} mentions ${bad}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  // Owner decision 5, checked at rest and in five places at once. The
  // absence of a default is invisible to every happy-path test, which is
  // exactly why it needs a test of its own.
  it('GATEWAY_ALLOWED_JURISDICTIONS has no default value ANYWHERE', () => {
    const offenders: string[] = [];
    const gw = readFileSync(path.join(ROOT, 'apps/gateway/src/config.ts'), 'utf8');
    if (/GATEWAY_ALLOWED_JURISDICTIONS\s*\?\?\s*['"`]/.test(gw)) offenders.push('config.ts defaults it');
    if (!/no default/i.test(gw)) offenders.push('config.ts does not refuse it when unset');

    const compose = readFileSync(path.join(ROOT, 'docker-compose.yml'), 'utf8');
    if (/GATEWAY_ALLOWED_JURISDICTIONS[^\n]*:-/.test(compose)) offenders.push('docker-compose.yml defaults it');

    for (const line of readFileSync(path.join(ROOT, '.env.example'), 'utf8').split('\n')) {
      if (line.includes('GATEWAY_ALLOWED_JURISDICTIONS') && !line.trimStart().startsWith('#')) {
        offenders.push('.env.example sets it uncommented');
      }
    }

    const bicep = readFileSync(path.join(ROOT, 'infra/main.bicep'), 'utf8');
    if (/param allowedJurisdictions[^\n]*=/.test(bicep)) offenders.push('main.bicep defaults it');

    expect(offenders).toEqual([]);
  });

  it('the gateway never logs prompt or completion content', () => {
    const audit = readFileSync(path.join(ROOT, 'apps/gateway/src/audit.ts'), 'utf8');
    // The record is built from named fields; a spread of the caller's input
    // is how content would get in.
    expect(audit).not.toMatch(/\.\.\.input\b/);
    expect(audit).not.toMatch(/\.\.\.outcome\b/);
    expect(audit).toContain('promptSha256');
  });

  it('README carries both credential sentences, separately', () => {
    const readme = readFileSync(path.join(ROOT, 'README.md'), 'utf8');
    expect(readme).toContain('No credential ever leaves the gateway');
    expect(readme).toContain('no provider keys exist at all');
    expect(readme).not.toContain('your API key is stored only in your browser');
    expect(readme).not.toContain('there is no server for LexPrompt to leak it to');
  });

  it('README no longer tells the reader to get an OpenRouter key', () => {
    const readme = readFileSync(path.join(ROOT, 'README.md'), 'utf8');
    expect(readme).not.toContain('openrouter.ai/keys');
    expect(readme).not.toContain('You need an OpenRouter API key');
  });

  it('README carries §5.1s "what running locally does not prove" list', () => {
    const readme = readFileSync(path.join(ROOT, 'README.md'), 'utf8');
    for (const phrase of [
      'does not prove', 'Managed-identity acquisition', 'group overage',
      'conditional access', 'Keycloak is not an Entra emulator',
    ]) {
      expect(readme).toContain(phrase);
    }
  });

  it('no provider-specific branch exists outside apps/gateway/src/adapters', () => {
    const offenders: string[] = [];
    const scan = [...CLIENT_FILES, ...walk(path.join(ROOT, 'apps/api/src')),
      ...walk(path.join(ROOT, 'apps/gateway/src')).filter(f => !f.includes(`${path.sep}adapters${path.sep}`))];
    for (const file of scan) {
      const text = readFileSync(file, 'utf8');
      for (const id of ['anthropic', 'azure-openai', 'azure-foundry', 'openrouter']) {
        if (new RegExp(`===\\s*['"]${id}['"]`).test(text)) {
          offenders.push(`${path.relative(ROOT, file)} branches on provider ${id}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
```

- [ ] **Step 3: Run them and watch them fail**

Run: `npx vitest run --project api apps/api/test/configSurface.test.ts` — Expected: FAIL until `.env.example`, `docker-compose.yml` and `infra/main.parameters.json` all exist (Tasks 24 and 25) and `src/lib/config.ts` is the web app's only env reader (Task 19).

Run: `npx vitest run --project web src/lib/model/stage1DoD.test.ts`
Expected: FAIL on the two README cases (the README is not yet rewritten). Every other case should already pass if Tasks 1–25 are done — **if any other case fails, that is a real regression, not a test to adjust.**

- [ ] **Step 4: Rewrite the README rows**

Apply the table above. Keep every sentence that is still true — the citation guarantees, the scan detection, the page-image rule, the palette guards, the fonts decision (its reasoning strengthens: the app should not contact a third-party host on a page view, and now the sentence is about the firm's own API).

- [ ] **Step 5: Record the rulings**

Append to `docs/superpowers/redesign/rulings.md`, in its established format, with a cost-if-wrong for each:

- **S2 (revised 2026-08-28, owner decision).** The gateway is multi-provider. No credential ever leaves the gateway, and every call is logged with its provider and jurisdiction, whichever backend is configured. An Azure-only deployment using managed identity retains the stronger property — no provider keys exist at all — and that is the recommended posture. *Cost if wrong: the two sentences get conflated in a README or a Risk answer, and a firm running against OpenAI believes a claim that is true only of the Azure posture.*
- **S15 (revised).** The allowlist is provider+model pairs, each declaring its processing jurisdiction. A user still cannot name a model. *Cost if wrong: one more field per entry and a startup check.*
- **D1.** One SSE event splitter in `packages/core`; each adapter contributes only a pure `decodeEvent`; `apps/api` parses nothing. *Cost if wrong: five copies of a parser this project has already fixed twice, at a boundary where the failure is a short answer rather than an error.*
- **D2.** A stream that ends without a terminator frame is an error, not a short answer. *Cost if wrong: a truncated answer about a contract, indistinguishable from a complete one.*
- **D3.** The audit record is written before the upstream call and a sink failure refuses the call. *Cost if wrong: an unlogged egress, which is the one thing the gateway exists to prevent — and "what of ours went where" stops being answerable.*
- **D4 (revised, owner decision 5).** The jurisdiction gate is startup configuration with **no default anywhere**; the gateway refuses to start with `GATEWAY_ALLOWED_JURISDICTIONS` unset, and a model outside the declared set stops the process. It enforces the **operator's** declared policy — which jurisdictions their contracts and data provisions cover — and passes no judgement of its own; the model picker's jurisdiction label is factual for the same reason. *Cost if wrong: an operator must type one variable before the gateway starts. Against that, two failures a default would cause. A default encodes an assumption about one firm's contracts as though it were a property of the software, and the system then enforces a policy nobody chose — while a firm whose provisions genuinely cover a US provider is told, wrongly, that their configuration is unacceptable. And the absence of a default is invisible to every happy-path test, which is why its removal is mutation-tested rather than trusted.*
- **D5.** Every provider's stream decoding is proved by one conformance battery over recorded fixtures; a provider with no fixture fails the build; a synthetic fixture says so in the file. *Cost if wrong: a provider changes its event shape and the suite stays green.*
- **S28 (as executed).** One OIDC path, two issuers, no Entra branch: the tenant check is a configured required claim, the identity is `(issuer, subject)` with the subject claim named in configuration, and the browser uses `oidc-client-ts` rather than MSAL. *Cost if wrong: an OIDC library instead of the vendor's, and MSAL's Entra-specific conveniences given up. Against that, two sign-in paths — this project's most repeated defect at the front door, where the divergence would be between the authentication a developer tests and the one a firm runs.*
- **S29 (as executed).** No development bypass and no configuration that disables authentication; the API refuses to start with no issuer, or a non-HTTPS issuer that is not loopback; the gateway has no caller-auth value that turns its check off. **The absence is mutation-tested** (Task 16 Step 7). *Cost if wrong: a developer runs one more container. Against it: a bypass reaches production enabled, and it tests a different code path from the one that ships — a green local run under one would prove nothing, which removes the only reason to have a faithful local stack.*
- **S31 (as executed).** Keycloak, from a version-controlled realm seeding four accounts across the three roles plus one in no group. *Cost if wrong: ~450 MB of image and ~20 seconds of cold start per boot. If it ever becomes the bottleneck the swap is one compose service and one realm file, because §7 is issuer-agnostic — which is the point.*
- **S30 (as executed).** One typed configuration module per app; no module branches on the environment; the configuration diff **is** §5.1's divergence list, checked in both directions by `configSurface` (Task 26). *Cost if wrong: one boundary test and one diff test to keep green. Without them §5.1 is the one guarantee in this design with nothing enforcing it at rest, and its symptom is a green `docker compose up` that says nothing about the tenant.*

- [ ] **Step 6: Run everything, in full**

```bash
npx tsc --noEmit
npm test
npm run build
npm run compose:up && npm run test:compose && npm run compose:down
```

Expected: `tsc` clean; all four vitest projects green; build clean with no externalization warning; 4 compose tests passing.

- [ ] **Step 7: Mutation test the sweep and the configuration surface**

Add `const apiKey = 'sk-or-v1-test';` to `src/features/settings/SettingsPanel.tsx`. Run the DoD test. Expected: FAIL on *"no OpenRouter API key exists anywhere in the browser codebase"*. Remove it.

Then add `if (provider === 'anthropic') { /* … */ }` to `apps/gateway/src/callModel.ts`. Expected: FAIL on *"no provider-specific branch exists outside apps/gateway/src/adapters"*. Remove it.

Then, **the four mutations this task exists for**:

3. **Reintroduce the jurisdiction default.** Change `apps/gateway/src/config.ts` to `(env.GATEWAY_ALLOWED_JURISDICTIONS ?? 'UK,EU')` and delete its unset check. Run `npx vitest run`. Expected: FAIL on *"GATEWAY_ALLOWED_JURISDICTIONS has no default value ANYWHERE"* (this task), on *"GATEWAY_ALLOWED_JURISDICTIONS is the same-everywhere kind, and has no default"* (`configSurface`) and on Task 4's two refusal tests. Restore.

   **Do the same for the other three homes, one at a time** — `${GATEWAY_ALLOWED_JURISDICTIONS:-UK,EU}` in `docker-compose.yml`, an uncommented line in `.env.example`, and `param allowedJurisdictions string = 'UK,EU'` in `main.bicep`. Each must fail on its own. **This is the mutation that matters most in the whole plan and it is the least obvious.** With a default in place, every happy-path test passes, the gateway starts, the gate still refuses an undeclared model, and the boot banner still prints a table — *nothing looks wrong*. Without these four checks a later, entirely well-meant "sensible default" slips in green and the system then enforces, as though it were a property of the software, an assumption about one particular firm's contracts.

4. **Read an env var outside a config module.** Add `const x = process.env.FOO;` to `apps/gateway/src/callModel.ts`. Expected: FAIL on *"nothing outside the three config modules reads process.env or import.meta.env"*. Remove it.

5. **Branch on the environment.** Add `const isLocal = true;` to `apps/api/src/routes/infer.ts`. Expected: FAIL on *"nothing reads NODE_ENV, isLocal, or if (dev)"*. Remove it.

6. **Orphan a divergence row.** Empty row 1's `keys` array in `divergence.json` without adding a `rowsWithNoKeys` entry. Expected: FAIL on *"every table row has a key behind it, or an explicit reason why not"*. Restore.
   That is the half of §18 item 10(b) that stops §5.1's table decaying into a list of good intentions, and it is why the check runs in both directions.

- [ ] **Step 8: Commit**

```bash
git add README.md docs/superpowers/redesign/rulings.md src/lib/model/stage1DoD.test.ts apps/api/test/configSurface.test.ts apps/api/test/divergence.json
git commit -F .git/COMMIT_MSG_TASK26
```

```
docs: rewrite the README's Stage 1 rows, record the rulings, guard the DoD

The two credential sentences appear adjacent and distinct, because both are
true and conflating them is how a security claim quietly becomes false for
half its deployments.

The README says plainly that api's egress denial is tested under compose and
only expressed, not proven, in Azure — that is Spike 2, and implying
otherwise would be the exact failure this project is organised against, in
the document a Risk reviewer reads first.

A sweep test fails if any of it regresses: no apiKey in the browser
codebase, openrouter.ts gone, no direct fetch to an external host from the
client, no spread in the audit record builder, both README sentences
present, no OpenRouter key instructions, and no provider-specific branch
outside apps/gateway/src/adapters.

Mutation-tested: an apiKey reintroduced (1 test fails); a provider branch
added to callModel.ts (1). Both removed.
```

---

## Interfaces Stage 2 and later must honour

Recorded here so a later stage extends rather than duplicates. Each is a thing this stage built that a later one will be tempted to build again.

1. **`packages/core` exists and is the single home for shared logic (S14).** Stage 0's remaining extraction and every later stage **add to it**. Do not create a second shared package. Extend `packages/core/test/importBoundary.test.ts`'s `exported` array with every new export.
2. **`GET /v1/models` is the allowlist's only wire surface, and the gateway is its only home.** Stage 2's admin workspace-configuration UI reads through this route. It must not hold a second list, and `apps/api` must not start validating a model choice.
3. **`workspaceId`, `actorIssuer` and `actorSubject` reach the gateway in the request body, put there by `apps/api` from a validated token — never from the client.** Stage 2 replaces the configured `workspaceId` with a real one and resolves `(issuer, subject)` to an `app_user.id`. The overwrite-after-spread in `apps/api/src/routes/infer.ts` must survive that change, and `AuditStart` should then gain `actorUserId` **alongside** `actorIssuer`/`actorSubject` rather than replacing them, so records written before and after Stage 2 remain joinable.
4. **`Purpose` is a closed set in `packages/core`.** A new call site in Stage 3 or 4 adds its purpose there and to no other list. The gateway refuses an unknown one.
5. **`Settings.modelChoiceId` and `Settings.concurrency` are per-user `localStorage` in Stage 1.** §6.6 makes both workspace configuration in Stage 2. When they move, re-validate a stored `modelChoiceId` against `GET /v1/models` on load — Task 22's ninth `ModelPicker` test is the behaviour to preserve.
6. **The gateway's call log (`AuditSink`, stdout JSONL) and Stage 2's `audit_event` are two different logs and must stay two.** §12 Q3 is explicit that they are deliberately separate, and S22's reasoning about two append-only records of one fact applies here too. The gateway must not gain a database credential to write `audit_event` — it has no database credential by design (§5).
7. **`RateLimiter` is an interface with an in-process implementation.** A second `api` or `gateway` replica needs a shared store; that is one new implementation and no call sites.
8. **`ModelError.callId` is the reference a user quotes to IT.** Every error surface Stage 2+ adds must keep it reachable, and `ServiceConfigError` is the component to reuse.
9. **Stage 3's run worker calls the gateway through `apps/api`'s `gatewayClient.ts`.** Not a second client, and not directly from the worker — `apps/api` is one service and its single outbound module is what makes S1 checkable by reading one file.
10. **`Frame` is the gateway's outward stream format and is provider-independent.** Stage 3's `run.started` / `finding.done` events are a *different* channel (§9) and must not be squeezed into this one; Stage 4's WebSocket is a third. Three transports, three formats, each with one job.
11. **`Finding.authError` keeps its persisted meaning: a failure Retry cannot fix.** Stage 3's `finding.auth_error` column carries it forward unchanged.
12. **`callerAuth.ts`'s two modes never fall back to each other**, and no configuration value turns the check off — `mode: 'none'` is unreachable from configuration and exists only as a type for unit tests. A Stage 2 deployment adding a second caller adds a subject to `GATEWAY_CALLER_ALLOWED_SUBJECTS`; it does not add a third mode and does not add an environment branch.
13. **Identity is `(issuer, subject)` everywhere, and no schema may carry an `entra_*` column.** Stage 2's `app_user` is keyed on the pair; `role_mapping` is `(issuer, group_value, role)`; the subject claim is named in configuration (`oid` for Entra, `sub` for Keycloak) and the two issuers' subjects are never compared with each other. Stage 1 creates none of those tables, but `AuditStart.actorIssuer` / `actorSubject` (Tasks 6, 17) are already the pair, so Stage 2's `app_user.id` can be joined to records written before it existed.
14. **The `auth` and `configSurface` suites are table-driven over the route list and the configuration key sets** (Task 16, Task 26). A Stage 2+ route with no `auth` entry fails the build; a configuration key that differs between environments and is not in §5.1's table fails the build, and so does a table row with no key behind it.
15. **The seeded Keycloak realm ships in Stage 1 with all four accounts** (Task 24). Stage 2 maps their groups to roles; Stages 3–5 use the same four. Do not add accounts per stage — the realm file is version-controlled and one edit now is cheaper than four later.

---

## Self-review

### 1. Spec coverage

Every Stage 1 requirement, with the task that implements it.

| Requirement | Source | Task |
|---|---|---|
| The gateway is the only component permitted to egress | §1, §5, S1 | 24 (network), 26 (sweep) |
| `api` may not egress; asserted by a test | §5, §18.7 | 24 |
| Nothing else holds a provider credential | §1, S2 rev. | 7, 25, 26 |
| No credential ever leaves the gateway | S2 rev. | 5 (strip), 7 (redact), 11 (error bodies), 26 |
| The Azure/managed-identity stronger property, stated separately | Owner decision 2 | 26 |
| Managed-identity auth where the provider supports it | §10, owner decision 2 | 7 |
| Keys from the platform secret store otherwise | Owner decision 2 | 7 (Key Vault, env, file), 25 (no key in a template) |
| Credential failure → loud 503, never a fallback | §10 | 7 |
| Five pluggable providers, one adapter interface | Owner decision 1 | 8, 9 |
| Adding a sixth touches no call site | Owner decision 1 | 8 (registry), 26 (no provider branch outside adapters) |
| Provider differences confined behind the adapter | Owner decision 5 | 8, 9, 26 |
| Allowlist of provider+model pairs, region-pinned | §10, S15 rev. | 4, 5 |
| A user cannot name a model | S15 | 5, 22 |
| Jurisdiction declared per entry | Owner decision 3 | 2, 4 |
| Jurisdiction visible where the choice is made | Owner decision 3 | 4 (boot banner), 17/20 (`GET /v1/models`), 22 (picker) |
| Jurisdiction recorded per call | Owner decision 3 | 6 |
| Purpose allowlist, nine purposes, unknown rejected | §10 | 2, 11, 21 |
| Budgets and rate limits, per workspace and per actor | §10 | 14 |
| Maximum prompt size and request timeout | §10 | 4, 11 |
| Retry 429/5xx only, fail fast on 4xx | §10 | 11 |
| `parseJsonLoose` survives as the fallback | §10 | 1, 20 |
| An audit record per call, with §10's fields | §10 | 6 |
| Enough to answer "what of ours went where, and when" | Stage 1 brief | 6 (context ids), 21 (call sites supply them) |
| Never logs prompt or completion content | §10, §14 | 6, 26 |
| Only `apps/api` may call the gateway | §10 | 15 |
| One OIDC path, two issuers, no Entra branch | §7, S28 | 16, 19 |
| The tenant check is a configured required claim, never a code path | §7, S28 | 16 |
| Identity is `(issuer, subject)`, never the email or an Entra-shaped id | §7, S28 | 16, 17, 6 |
| The browser uses a standards-only OIDC client, not MSAL | §7, S28 | 19, 26 (sweep) |
| The API validates signature, iss, aud, exp and the configured required claims | §7 | 16 |
| Group overage is detected and reported as its own error | §7 | 16, 23 |
| No development bypass; the absence is mutation-tested | §7, S29 | 16 (Step 7), 15, 4, 26 |
| The API refuses to start with no issuer, or a non-loopback non-HTTPS one | §7, S29 | 16 |
| Keycloak seeds four accounts across the three roles plus one with none | §5.1, S31 | 24 |
| The recorded stub is a registered adapter, refused by S27, marked everywhere | §5.1, §10.2 | 2, 8, 10, 13 |
| One typed config module per app; no module branches on the environment | §5.1, S30 | 4, 16, 19, 26 |
| The configuration diff **is** §5.1's divergence list, both directions | §18 item 10 | 26 |
| `GATEWAY_ALLOWED_JURISDICTIONS` has no default, in any of its five homes | D4, owner decision 5 | 4, 24, 25, 26 |
| The model picker's jurisdiction label is factual, never evaluative | S27, owner decision 5 | 22 |
| The README carries "what running locally does not prove" | §5.1 | 26 |
| `openrouter.ts` becomes a `ModelClient` | §13 | 2 (interface), 20 (implementation) |
| A minimal `api` whose only route is the inference proxy | §13 | 16, 17, 18 |
| Everything else stays in IndexedDB | §13 | Global constraint; no task touches persistence |
| Streaming survives the new boundary | §14, brief | 3, 10, 12, 18, 20 |
| `docker compose up` locally, same shape | §5, §4.10 | 24 |
| Local development without Azure | S2 | 7 (env/file), 13 (recorded), 24 (example configs) |
| Local development is not a degraded mode, and runs the same code path | S30, §5.1 | 13, 19, 24, 26 |
| `azd up` to Azure | §4.10 | 25 |
| No OpenRouter key in the codebase or any browser | §18.2 | 22 (purge), 26 (sweep) |
| Empty / broken / in-flight render distinctly | §3 | 19 (sign-in), 22 (model picker), 17/20 (empty list at the wire) |
| An auth failure routes correctly, per audience | §3, brief | 23 |
| Mutation tests on everything load-bearing | §14 | 1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,26 |
| Browser verification, said plainly if not done | `CLAUDE.md` | 19, 22, 24, 25 |
| `tsc` clean, tests pass, build clean | §18.1 | Global constraint; every task's gate |

**Requirements I could not assign to a task, and why:**

- **§10.1 / §17 Q4 — Foundry abuse-monitoring retention.** An owner decision, not an implementation step. It is now **wider** than the spec states: OpenAI, Anthropic and OpenRouter each have their own retention and training terms, and a firm choosing one is choosing those terms. **This needs a §12 Q4 answer per configured provider before go-live, and the spec's own warning applies — the terms have a shelf life and must be re-confirmed against each provider's current documentation at implementation time.** No task can settle it; Task 26's README should carry a "check your provider's retention terms" line, and the owner should be asked.
- **§15 Spike 2 — the Azure-side egress assertion.** Task 24 satisfies §18.7 under compose; the Azure half depends on the spike's outcome. Task 25 expresses it in Bicep and Task 26's README says plainly that it is not yet proven there.
- **§17 Q10 — whether the assistant is in scope.** This plan assumes **yes**, per the spec's own recommendation and because `chatStream` exists and dropping a working feature by omission is the wrong reading of silence. If the owner defers it, Tasks 3, 12, 18 and 20's streaming halves are still needed — every provider's streaming path is exercised by the conformance suite regardless — but `assistant.chat` leaves the purpose list.

### 2. Placeholder scan

Searched for `TBD`, `TODO`, `implement later`, `fill in`, `appropriate error handling`, `similar to Task`, `and so on`, `etc.` in step bodies, and for test steps with no test. Three things were found and fixed inline rather than left:

- Task 8 Step 6 originally left `anthropic.ts` dangling for Task 9; it now names the ordering explicitly and says why a type-checking placeholder is the worse of the two options.
- Task 12's `await import('../callModel.ts')` was a placeholder; the step now instructs a static export and says it must not survive.
- Task 20's `chatStream` return invented `provider`/`jurisdiction`; the step now requires the `done` frame to carry them and `packages/core`'s `Frame` and its round-trip test to be extended.

Three deliberate delegations remain and are marked as such rather than hidden: Task 15 Step 1 and Task 19 Step 2 describe their test cases as a numbered list rather than quoting every assertion; Task 24 Step 3 specifies the Keycloak realm as a table of required objects rather than 400 lines of realm JSON; and Task 25's Bicep names what each module must express rather than transcribing the ARM. Both are cases where the exact text depends on a local certificate path, a tenant id or a subscription's resource naming — writing invented values would be worse than naming the requirement precisely.

### 3. Type and name consistency

Checked across all 26 tasks:

- `modelChoiceId` — used consistently from Task 2 onwards on the wire and in `Settings`. `AllowedModel.model` is the only provider-side name and appears only inside `adapters/` and `ModelEntry`. **`deployment` appears nowhere**; the spec's word was replaced when the allowlist became provider+model pairs, and the naming note in Task 2 records that.
- `listModels` — the `ModelClient` method (Tasks 2, 20), the route `GET /v1/models` (Tasks 11, 17), the picker's data source (Task 22). It is **not** `listDeployments`, and the old `openrouter.ts` `listModels` returning `ModelInfo` is gone with the module (Task 20).
- `AllowedModel` vs `ModelEntry` — the wire type and the gateway-internal type. `toAllowedModel` is the only bridge (Task 5) and is tested to produce exactly the wire type's keys.
- `ModelError` codes — `sign_in_required`, `not_permitted`, `model_not_allowed`, `purpose_not_allowed`, `prompt_too_large`, `budget_exhausted`, `rate_limited`, `service_misconfigured`, `upstream_failed`, `stream_truncated`, `network`, `unknown`. Every code used in Tasks 5, 7, 11, 12, 13, 14, 15, 16, 17, 20, 23 is on this list. `deployment_not_allowed` from the first draft was renamed to `model_not_allowed` throughout.
- `AdapterEvent` kinds — `delta`, `usage`, `end`, `error` (Task 8), consumed identically in Tasks 9, 10, 12.
- `Frame` types — `delta`, `done`, `error` (Task 3), produced in Task 12, consumed in Task 20, passed through untouched in Task 18.
- `AuditStart` / `AuditFinish` / `AuditRecord` / `AuditSink` / `AuditLogger` (Task 6) — used with the same names in Tasks 11, 12.
- `CallContext` and `prepare` (Task 11) — reused unchanged in Task 12, which is what keeps a streamed call's checks identical to a non-streamed one.
- `Principal` (Task 16) — used in Tasks 17 and 18.
- `getAccessToken` (Task 19) — the one token source in Task 20.
- `isSignInError` / `isServiceConfigError` (Task 2) — used in Tasks 20, 21, 23. `isAuthError` survives nowhere.
- `GATEWAY_ALLOWED_JURISDICTIONS` — spelled identically in Tasks 4, 24, 25, 26, and **has no default in any of them**; Task 26's sweep and `configSurface` check all five homes (config loader, compose, `.env.example`, Bicep, and the `sameEverywhere` list).
- `AuthConfig` / `Principal` (Task 16) — `Principal` is `{ issuer, subject, groups, name?, email? }` and is used with those field names in Tasks 17 and 18. **`oid` and `tid` appear nowhere outside a test fixture and a configuration value**; the pre-revision `Principal { oid, tid }` is gone.
- `actorIssuer` / `actorSubject` — the pair, spelled identically in Tasks 6 (`AuditStart`, `AuditStartInput`), 11 (`CallContext`, `InferBody`), 12 and 17. **`actorUserId` survives nowhere in Stage 1** — it appears only in the Stage 2 interface note above, as the field Stage 2 adds *beside* the pair rather than in place of it.
- `getAccessToken` (Task 19) lives in `src/lib/auth/oidc.ts`, not `msal.ts`, and Task 20 imports it from there.
- `recorded` — the provider id in Task 2's `PROVIDER_IDS`, the adapter file `adapters/recorded.ts` and its export `recordedAdapter` (Tasks 8, 13), the conformance fixture `recorded.txt` (Task 10), and the fixture directory `fixtures/recorded/` (Tasks 4, 13). **`stub` survives only as an English word describing a test double, never as an identifier**; `selectTransport`, `GATEWAY_UPSTREAM`, `stubDir` and `InferResponse.stubbed` are all gone.
- `config` — `src/lib/config.ts` (Task 19), `apps/api/src/config.ts` (Task 16), `apps/gateway/src/config.ts` (Task 4). Exactly three, and `configSurface` (Task 26) names exactly those three.
