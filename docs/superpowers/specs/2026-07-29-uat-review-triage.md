# UAT design — review triage

Three reviews (architecture, security, skeptical feasibility) against
`2026-07-29-uat-stage-design.md`. Every finding, its fix, and what the fix costs.

**Severity:** `BLOCK` = design does not work until fixed · `HIGH` = ships a false guarantee ·
`MED` = real but bounded · `LOW` = correction.

---

## A. Structural — these break the design outright

### A1 `RESOLVED` — UAT never re-runs after a failure

`graph.ts:33`: `uat: { failed: 'fix' }` but `fix: { passed: 'review' }`. A ticket that fails UAT
**ships without ever passing UAT**. Every cadence and cost argument in the spec describes a loop that
does not exist.

**Fix — split the fix stage.** Keep `STAGE_GRAPH` a static verdict-keyed table (its whole design):

```ts
uat:       { passed: 'review', failed: 'fixUat' },
review:    { passed: 'ship',   failed: 'fixReview' },
fixUat:    { passed: 'uat' },      // revalidate the gate that failed
fixReview: { passed: 'review' },
```

`isBranch()` derives both automatically. Rejected alternative: a dynamic return edge — it makes the
graph non-static, which is the property `graph.ts` exists to have.

**Cost:** one new stage key, `MARKER_STAGES` gains one, a migration for existing `stage_key` rows,
sidebar/dashboard stage classes, CLI marker vocabulary. Not small, and **nothing else in the spec
gates anything until this lands**.

**Second-order:** `fixUat → uat` means every fix re-boots the stack and re-runs e2e. That is the real
cost driver, and the spec never priced it. The attempt cap below is what bounds it.

#### Resolution (decided)

```
scope → impl → uat → review → ship → done
                ↑ ↓fail        ↑ ↓fail
            fixUat ┘       fixReview ┘
```

Inside `uat`, static gates run first — `boot → smoke → integration → e2e → custom → coverage`, no AI.
Any FAILED verdict short-circuits to `fixUat` without paying for the explorer. Only when no static
gate failed does `explore` run. This is an ordering rule about *correctness*, not cost: red
unit/integration/e2e is an obvious push back to fix, and spending an agent to confirm what a failing
suite already reported is waste.

It also settles C16: **the explorer runs iff no static gate FAILED.** Null gates do not block it —
nothing was asked. (`boot` null still means no server, so `explore` records null too.)

**Attempt cap** — the piece the original spec lacked entirely, and the answer to every
"parks the ticket at fix forever" objection in this triage:

| Decision | Value |
|---|---|
| Counted | Per gate stage, independent. `uat` and `review` each get their own budget. Needs no new state — `stages` is already keyed `(ticket_id, stage_key)` and carries `attempt`. |
| Exhausted | Park at `fixUat`, needs-you, **no auto-resume**. Driver halts with reason `attempts-exhausted`; `autoResumeFix` does not fire. No new stage, no new edge. |
| Explorer | Same cap; an explorer failure consumes an attempt like any other. A full re-entry re-boots and re-runs every static gate, so the cap is what bounds the expensive path. |
| Configured | `uat.maxFixAttempts` in the manifest, default 3. |

The cap is **driver policy, not a graph edge** — `Verdict` is only `passed｜failed｜null`, and
"attempts exhausted" is not a verdict.

### A2 `RESOLVED` — Lane 3's evidence is written by the agent it is meant to check

`reduceExploration` is pure, but its input is a document the explorer authors. An explorer that emits
`consoleErrors: []` is indistinguishable from one that saw a clean run. **This is agent self-report
with a JSON hop** — the thing the spec's own "explicitly not built" section rejects.

The cited vadim.blog model works the other way: the *harness* drives the browser, the agent only
chooses actions. The spec inverted it.

**Fixes, in descending honesty:**

| Option | Effect | Cost |
|---|---|---|
| Karst drives via CDP; agent picks actions only | Evidence becomes trustworthy; guard proxy unnecessary | A browser dependency + a real runtime component, in a codebase whose runtime deps are `better-sqlite3` and `js-yaml` |
| Proxy-as-observer | Karst produces `httpStatuses`/`networkFailures` itself | Undermined by C-Sec2 (SPA XHR never reaches it); cannot see console errors at all |
| Demote to non-gating artifact evidence | Honest about trust level; cheap | A 500 the explorer walked into does not stop the ticket |
| Defer Lane 3 | — | Loses the lane |

#### Resolution (decided) — Playwright *is* the harness

No `ExplorationRecord`. The agent never authors evidence. It drives a Playwright session **karst
configures**, and karst reads Playwright's own artifacts:

| Machine fact | Source |
|---|---|
| Console errors | `page.on('console')` / trace |
| Unhandled rejections | `page.on('pageerror')` |
| Failed network requests | `page.on('requestfailed')` |
| HTTP statuses | `page.on('response')` / trace |

This is the vadim.blog split — harness drives, agent chooses actions — without building a CDP layer,
because Playwright already is one.

| Decision | Value |
|---|---|
| Playwright source | The repo under test (`npx playwright` in the worktree, repo's own install and browsers). Karst ships nothing. Absent → `explore` records `null`, like any unavailable gate. |
| Action channel | The agent writes a **throwaway** Playwright script; karst runs it **with karst's config** (reporter, trace, console/network capture, base URL). The script cannot disable capture because it does not own the config. The script is itself a readable artifact. |
| API side | Playwright's `APIRequestContext` — same trace, same evidence stream, one dependency, and UI/API findings correlate in one artifact. |

**Trust property:** under-exploration remains possible; **fabrication does not**. An agent can visit
fewer pages than it should, but it cannot make a 500 it *did* hit disappear from a trace it is not
writing. Under-exploration is bounded by the coverage gate.

**Consequence — B2 is deleted.** The standalone guard proxy is unnecessary: karst is already in-path
through Playwright's network interception, so denies and mutation budgets are enforced on traffic
karst genuinely sees — *including SPA XHR*, which the proxy was structurally blind to because the API
base URL is baked into the bundle at build time.

The throwaway exploration script lives outside `uat.testDir`, so it never collides with the fix guard
(A3).

### A3 `RESOLVED` — the coverage gate deadlocks

`coverage` fails when a criterion has no passing test → the remedy is to write a test → tests live in
`uat.testDir` → `fix` may not touch `testDir`. Unwinnable, which is exactly what the null rule exists
to prevent. `fix` also has no `failed` edge, so the rejection cannot even be expressed.

**Fix — make the guard add-only.** The guard's real purpose is "an agent may not make a *red* gate
green by editing the test that is red". So:

```
git diff --diff-filter=M,D  ∩  testDir   → reject   (modified or deleted)
git diff --diff-filter=A    ∩  testDir   → allow    (new test)
```

Deterministic, and it matches the intent exactly. **Cost:** near zero.

#### Resolution (decided)

| Decision | Value |
|---|---|
| Rule | Add-only, as above. Modified or deleted files under `testDir` reject; added files pass. |
| Diff base | Capture HEAD when `autoResumeFix` fires; compare the **working tree** (staged + unstaged + untracked) against it. Sees exactly what this fix attempt did and cannot be dodged by leaving edits uncommitted — gates read files off disk, not history. Needs a ref stored per fix attempt. |
| Vacuous new tests | **Accepted, not solved.** The human diff at review is the control. |
| Config bypass | **Documented limit.** |

**Two honest limits, recorded rather than papered over.** The original spec called this "the guard that
actually stops it", which overclaimed:

1. Add-only stops *rewriting the red test*. It does not stop **adding a vacuous one** —
   `test('[AC-3] …', () => expect(true).toBe(true))` satisfies coverage. The gate checks *existence*,
   so it is gameable by construction; "is this test meaningful" is undecidable. `runReview` already
   opens the diff for the human regardless of verdict, and that is the real control.
2. Editing `playwright.config.ts` (`testPathIgnorePatterns`), a global fixture, or the reporter
   mapping neuters a failing test **without touching `testDir`**. A path-prefix guard cannot see it.
   Rejected alternative: a `uat.protectedPaths` denylist — it would be perpetually incomplete and
   would block legitimate config changes during a fix.

### A4 `BLOCK` — Lane 3 is gated off precisely when it is needed

The spec accepts that Lane 2 authors specs blind at impl, and names Lane 3 the mitigation. But Lane 3
runs *only when gates 1–6 are green* — i.e. only when the blind specs already pass. When they
false-fail, `e2e` is red and the explorer never runs. Lane 3 also produces no test fixes and its
findings are explicitly routed nowhere.

**Fix — move Lane 2 authoring to after `boot`.** Tests get authored against a live app with real
selectors, real redirects, real error states. Blind authoring disappears, and with it the
contradiction.

This requires reframing the lane rule from "no AI runs during the stage" to **"no AI judges"** —
which is the property that actually matters and which Lane 1 still holds. **Cost:** an AI step inside
the stage; the separation argument gets one sentence harder to explain.

---

## B. Security

### B1 `HIGH` — the `.env` boundary is scoped to the wrong thing

`boot` reuses `spinTicket` → `spin.ts:204` `buildSpawnEnv(join(repo.repoPath, '.env'), …)`. The
guarantee covers gates and agents; **the service under test still boots with real secrets**. A
ticket exercising "send email" or "charge card" uses real SMTP and real payment keys regardless of
which low-privilege account is logged in. Redaction is structurally blind to it.

**Fixes:** (a) `uat.serviceEnv` — a second credential set `boot` uses instead of the repo `.env`;
real, and costs the user a full service env to author. (b) Restate the claim as *"UAT-owned processes
never read `.env`"* and add the risk row. **Minimum: (b). (a) as an opt-in.**

### B2 `HIGH` — the guard proxy does not work for the archetypal stack

Four independent problems: an SPA's XHR goes to the API URL **baked into the bundle at build time**,
so the proxy sees navigation only; enforcement is a base URL string an agent may ignore; a karst 403
produces a console error and failed request that the fail set cannot distinguish from a real one
(no provenance field); and `onDenied: abort` → `explore` = null lets one denied action silently
neutralize the lane forever. Also denylist-by-default, and `POST /graphql` funnels every mutation
through one path so `DELETE /api/**` never fires.

**Fix: cut it.** The low-privilege UAT account remains the primary control, and the gap gets
documented. Keeping it would require allowlist-default, path normalization, a provenance field, and
`onDenied: record` — a lot of machinery for something blind to SPA traffic.

### B3 `HIGH` — criteria poisoning

Ticket descriptions are attacker-controllable in a shared tracker and render verbatim
(`ticketContext.ts:154`). They feed criteria extraction, whose output becomes the frozen acceptance
bar, and the explorer's instructions. The spec refuses agent-reported pass/fail but accepts
**agent-extracted criteria from adversarial text** as ground truth.

**Fix — a human freezes the criteria.** Replace the AI-review second pass with a dashboard list and
one click. This answers three open questions at once: *what freezes it*, *who reviews it*, and *how
injection is stopped* — a human reads the list before it gates anything.

**Also:** the criteria write path needs a CLI verb with its own parse path (charset, length, count
limits, no delete), per the argv threat model in `CLAUDE.md`. The spec claimed "no CLI changes".

### B4 `MED` — explorer transcript reaches a cloud agent

Credentials typed into a browser, shared-dev-DB PII, and debug-page contents all enter agent context
each run. Explorer *commentary* also lands in the ticket artifact on a path that never touches
redaction. **Fix:** falls away if Lane 3 defers. Otherwise: local-only model, or app-side auth
injection instead of the agent typing credentials.

### B5 `MED` — `testDir` guard diff semantics

`testDir` is populated during impl, so diffing against baseline rejects **every** fix cycle. And a
committed-diff check misses uncommitted edits, which gates read off disk anyway. Config-level bypass
(`playwright.config.ts` `testPathIgnorePatterns`, global fixtures) sits entirely outside `testDir`.

**Fix:** capture HEAD before the fix resume and diff the incremental delta; include the working tree
(`git status --porcelain`), not just history; document the config bypass as a known limit. Combined
with A3's add-only rule.

### B6 `MED` — redaction gaps and the wrong seam

`BoundedOutput` writes nothing — the seam is `writeFileSync` in the stage. Server logs
(`startHot` → `<name>.log` in the worktree, surfaced by `tailLog`) are never redacted at all. Misses
base64 Basic Auth, percent-encoding, JSON-escaping, secrets straddling the 1 MiB truncation, and
derived tokens (a JWT signed *with* a secret contains none of its bytes).

**Fix:** apply at the real write seam; cover server logs; document the encoded/derived limits.

### B7 `LOW` — manifest validators never reject unknown keys

Verified: `schema.ts` hand-picks known fields. The spec's test "a value in the block is rejected"
needs a deliberate strict check departing from house style. **Fix:** strict check on the `secrets`
block only.

### B8 `MED` — `runCommand` inherits the developer's shell

`gates/run.ts` spawns with no `env`, so children get the extension host's environment — `AWS_*`,
`GITHUB_TOKEN`, `ANTHROPIC_API_KEY`, direnv exports. True today, unchanged by the spec. A bare
replacement drops `PATH` and `npm` stops resolving. **Fix:** explicit allowlist (`PATH`, `HOME`,
`SHELL`, `LANG`) + UAT vars. `startHot` merges `{...process.env}` at `supervisor.ts:94` and needs the
same treatment.

---

## C. Claims in the spec that are factually wrong

| # | Claim | Reality | Fix |
|---|---|---|---|
| C1 `BLOCK` | "`boot` returns `CommandResult`" | `CommandResult.exitCode` is `number` — cannot express `null`, which `boot`/`coverage`/`explore` all need | Use `GateResult` (`review.ts:24-40`); move it to a shared module |
| C2 `HIGH` | "the `servers` row is inserted **before** the health wait, so a crash leaves a reapable row" | **Backwards.** `supervisor.ts` awaits health ~153, inserts ~176. A crash mid-boot leaves an **untracked pid** | Insert with pid before the wait, update status after. Fixes an existing latent bug |
| C3 `BLOCK` | "adopt-or-spin, extracted from `spin.ts`" | `allocator.allocate` unconditionally INSERTs — a second resolve returns **different ports** while servers keep the old set, so every injected base URL points at nothing | Read-existing-allocations path |
| C4 `BLOCK` | "UAT must not bypass `startHot`" | `startHot` **throws by design** when the health URL already answers (`supervisor.ts:80-86`) | Adopt reads the `servers` table, verifies pid alive + health, bypasses `startHot` |
| C5 `MED` | "copy `spin.ts`'s created-vs-adopted discipline verbatim" | `adopted` exists only on `WorktreeRecord`. `ServerRecord` and the `servers` table have no such concept | Add it, or derive from "row predates this run" |
| C6 `HIGH` | "teardown moves to boundaries that already exist: ship, done, archive, session close, dashboard Stop" | Only the dashboard Stop exists. `ship.ts`, `done.ts`, `archive.ts` contain zero server code. Archive also has an ordering bug **today**: worktree removed and ports released under a live pid | Four new call sites; fix the archive ordering |
| C7 `HIGH` | implied: stacks die with the window | Children are `detached: true` and survive VS Code exit; `reconcileOnStart` only marks *dead* rows, so a survivor stays `running` forever | Reap on `deactivate`, or reconcile kills live orphans |
| C8 `HIGH` | Stop works | `shouldContinue` is polled only *between* stages. One UAT stage is now boot (N × 30 s) + 5 gates × 15 min + a browser session — **Stop is inert for up to an hour** | `AbortSignal` through `RunCommandOptions` into the driver |
| C9 `MED` | "no other files change" | `model/inside/gates.ts:1,113` imports and renders `UAT_GATE`; removing it breaks the build. The new gate list is dynamic and includes gates with no script, so `GateSpec` no longer models it | Model a dynamic gate list; update the dashboard stepper |
| C10 `LOW` | "nine hardcoded `user_version` literals" | **29** in `db.test.ts` (from a stale `CLAUDE.md` line) | Correct the estimate — 3× |
| C11 `MED` | `soloAgent` ships `uat-author` | It is the agent for a **`single-subagent`-approach ticket**, mutually exclusive with a real approach package | New distribution path needed |
| C12 `MED` | "an approach artifact — the existing vocabulary" | Approach artifacts are *fetched from a declared external source*; karst authors no packages. Lane 2 would only work if the chosen approach happens to ship `uat-author` | Karst synthesizes/merges a package (new code in `assembleAndWrite`, which also runs `assertPackageContributes` + `sanitizeFrontmatter`) |
| C13 `LOW` | — | Three competing homes for one agent identity: approach artifact, `agents:` block, `uat.author.agent` | Pick `agents:` |
| C14 `HIGH` | "Phase 1 fixes the duplication bug" | A zero-config repo yields **all nulls → always green**, and `test` has been removed. For karst's own repo UAT goes from "runs the suite" to "runs nothing and passes" — *more* vacuous than today | Keep `test` in UAT until a non-null UAT gate exists, **or** make all-null a distinct non-pass |
| C15 `HIGH` | `boot` failure → `fix` | Contradicts the null rule three paragraphs above. Real boot failures are "another process owns that port", 30 s health timeout on a 45 s boot, `ENOENT` on the start command — **none fixable by the agent**, all park the ticket at `fix` forever | Boot failure = `null` + a surfaced warning, never routes to `fix`. Or fail only when the service booted at baseline (comparative) |
| C16 `MED` | "explore skipped whenever gates 1–6 are non-green" | Ambiguous: is `null` non-green? If yes, explore never runs anywhere. If no, it runs with no server | Define: explore runs iff every gate is `0` or `null` **and** `boot` is `0` |
| C17 `MED` | "parses the runner's report" | Five incompatible formats (JUnit/vitest/jest/playwright/mocha); N gates each with a `report:` but one `coverage` exit code; "passing" undefined per format (`test.skip` would parse as present); `report:` path base unspecified; `[AC-3]` free-match collides with any test *mentioning* it | Pick JUnit XML first; one report per project initially; define pass explicitly; resolve relative to the gate's repo; exact tag-prefix match. **No XML parser in the tree** — new dep or hand-rolled |
| C18 `MED` | `frozen_at` prevents drift | No FK, no `UNIQUE(ticket_id, ordinal)`, and freezing is **per row** — a later extraction can INSERT a new unfrozen row beside frozen ones and move the goalposts | FK + unique constraint + freeze the whole set, not rows |
| C19 `MED` | — | Zero criteria rows (sub-agent never dispatched) → coverage over an empty set **passes vacuously** | Empty set = `null`, not pass; surface "no criteria" in the UI |
| C20 `HIGH` | "adopt a hot stack" | `spinTicket` normally runs at *scope*, before implementation. A compiled service (Go, Java, built Next.js) adopted at UAT serves **pre-implementation code** — UAT declares criteria met by a binary predating the ticket | Freshness predicate: restart if HEAD moved since the server started. Needs `head_sha`/`started_at` on `servers` |
| C21 `MED` | — | `testDir` is project-level but repos are many; `e2e/karst/` resolves against nothing in a multi-repo ticket | Per-repo, or relative to each gate's `repo:` |
| C22 `LOW` | "review inherits a hot stack" | Review's `npm test` then runs against **bound ports**, breaking any suite that starts its own server | Decide explicitly; document |

---

## D. Cost realism

"Sub-agent context is separate, which makes it token-cheap" is a category error. Separate context
means the **parent does not pay** — total tokens go *up*, because a fresh sub-agent re-reads routing,
components, selectors, and API contracts the impl agent already read.

Per ticket, Lane 2 alone: read ticket → extract criteria → a full second AI pass → author N specs
across possibly several repos. Plausibly the same order as the implementation.

Lane 3 is worse — screenshots and DOM snapshots per step, the most expensive token class. And the
"only when green" rule bounds it to once per ticket **only because the loop is broken**. Fix A1 and
every fix iteration reaching green pays a full re-boot, full e2e, and full exploration.

The fail set also fires constantly on real dev stacks: React dev-mode warnings, favicon and
source-map 404s, HMR websocket reconnects, blocked analytics, `AbortError` from a cancelled fetch.
`"failed network request (non-optional)"` — **"non-optional" is nowhere defined**, and that one
undefined adjective carries the entire determinism claim for the most expensive lane.

---

## E. What survives untouched

- Delete `UAT_GATE` + the anti-duplication guard test *(the actual stated bug; one commit)*
- `boot` as a health-probe gate
- Manifest-declared UAT gates with `env` threading
- Null-is-not-a-verdict extended to every new gate
- Evidence written inside `transition`'s `premutate`
- Frozen criteria as a concept (with B3's human freeze and C18's constraints)
- Value-based redaction as defense-in-depth (at the correct seam, per B6)
- The three-lane *framing* — provided Lane 3 is redesigned so karst owns collection

## F. Recommended cuts

Speculative surface, no user waiting on it, each carrying real validation and test cost:

`UatSecretSource` union + `infisical` arm + settings UI · the guard proxy (B2) · the isolation ladder
(three rungs, one wired, two for a stack nobody has) · `scaffold: author` · the AI-review second pass
on criteria (B3 replaces it with a human click) · `kind: command`
