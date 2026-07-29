# UAT stage — design

**Ticket:** 869ea5xpu — [FEAT] Implement UAT stage to run actual testing
**Date:** 2026-07-29 (rev 2, post-review)
**Status:** structural design settled; security + correctness items tracked in
`2026-07-29-uat-review-triage.md`

> **Rev 2** rewrites rev 1 after three reviews (architecture, security, skeptical feasibility).
> Rev 1's four structural claims were wrong; they are resolved here. Items still open carry an
> `OPEN (id)` marker pointing at the triage.

---

## Problem

`src/workflow/stages/uat.ts` runs `npm test` in the ticket's worktree. `gates/scripts.ts`:

```ts
export const UAT_GATE: GateSpec = { name: 'test', script: 'test', args: ['test'] };
export const REVIEW_GATES = [lint, typecheck, { name: 'test', script: 'test', args: ['test'] }];
```

Same script, same worktree, minutes apart. A ticket passing UAT passes review's `test` gate for
identical reasons. **The stage carries no independent signal.**

And there is a second, worse bug underneath it. `graph.ts:33`:

```ts
uat: { passed: 'review', failed: 'fix' },
fix: { passed: 'review' },   // ← re-enters review, never uat
```

**A ticket that fails UAT ships without ever passing UAT.** Today the duplicate `test` gate masks
this — review re-runs the same suite. Make UAT ask a different question and the hole opens: boot,
e2e, and coverage results would be discarded and never re-checked.

Meanwhile karst owns machinery nothing uses at gate time: `runtime/spin.ts` (multi-repo stack,
allocated ports, `dependsOn` binding), `runtime/health.ts`, every runnable repo's declared
`service.health`, and the ticket's acceptance criteria in `context/ticketContext.ts`.

The stage that should exercise the running system is the only one that never starts it.

## Research

- [Computer-Use Agents for UI Verification](https://vadim.blog/computer-use-agents-ui-verification/) —
  "the agent explores, a deterministic verifier judges", with browser deps lazy-imported so the
  verdict function provably cannot touch browser state. Rev 1 cited this and then inverted it; rev 2
  applies it properly (see Lane 2).
- [AAID acceptance testing workflow](https://github.com/dawid-dahl-umain/augmented-ai-development/blob/main/appendices/appendix-a/docs/aaid-acceptance-testing-workflow.md) —
  acceptance tests are "an automated, objective Definition of Done" against a production-like running
  system. Unit tests catch regressions; acceptance tests prevent building the wrong thing.
- [Codacy — independent quality gates](https://blog.codacy.com/why-coding-agents-need-independent-quality-gates) —
  verification must be independent of the generator.

Consensus: binary verdicts, outcome verification against real end state, **the generator never grades
itself**.

---

## The stage graph

`fix` must return to the stage that failed. A single `fix` with a remembered origin would make the
return edge dynamic — and `STAGE_GRAPH` being a static verdict-keyed table where a missing edge
**throws** is the property `graph.ts` exists to have. So the stage splits:

```ts
uat:       { passed: 'review', failed: 'fixUat' },
review:    { passed: 'ship',   failed: 'fixReview' },
fixUat:    { passed: 'uat' },
fixReview: { passed: 'review' },
```

```
scope → impl → uat → review → ship → done
                ↑ ↓fail        ↑ ↓fail
            fixUat ┘       fixReview ┘
```

`isBranch()` derives both automatically — no list to maintain.

**Cost:** one new stage key, a migration mapping existing `fix` rows, `MARKER_STAGES` gains an entry,
sidebar/dashboard stage classes, and CLI marker vocabulary. Nothing else in this document gates
anything until this lands.

### The attempt cap

`fixUat → uat` means every fix re-boots the stack and re-runs the gates. That is the real cost driver,
and the cap is what bounds it. It is **driver policy, not a graph edge** — `Verdict` is only
`passed｜failed｜null`, and "attempts exhausted" is not a verdict.

| | |
|---|---|
| Counted | Per gate stage, independent. Needs no new state — `stages` is keyed `(ticket_id, stage_key)` and already carries `attempt`. |
| Exhausted | Park at `fixUat`, needs-you, **no auto-resume**. Driver halts with reason `attempts-exhausted`; `autoResumeFix` does not fire. |
| Explorer | Same cap. An authored-step failure consumes an attempt like any other. |
| Configured | `uat.maxFixAttempts`, default 3. |

This is the answer to every "parks the ticket at fix forever" objection: nothing loops indefinitely,
and exhaustion lands somewhere a human can act.

---

## The UAT pipeline

Order matters, and the ordering is a correctness argument, not just a cost one.

```
1. static gates      unit → integration → e2e          NO karst stack
     ↓ any FAILED → fixUat  (a spin was never paid for)
2. boot              spin + health
3. author            agent writes e2e steps against the LIVE app
4. run steps         karst executes them under karst's Playwright config
     ↓ any FAILED → fixUat
     ↓ passed → review

   coverage          advisory only — recorded, surfaced in the review diff,
                     never a verdict (B3)
```

**Why static first.** Red unit/integration/e2e is an obvious push back to fix; spending an agent to
confirm what a failing suite already reported is waste. A red unit test never pays for booting a
multi-repo stack.

**Why boot after the repo's own suites.** A standard Playwright suite starts its own server via
`webServer`. If karst's boot already holds those ports, the repo's e2e fails to start for a reason
unrelated to the ticket. Running repo suites first lets each manage its own lifecycle.

**Verdict:** passed iff every gate that RAN exits 0. A gate whose script the repo does not define
records `null` and says nothing — `npm run e2e` in a repo with no e2e script exits 1 with "Missing
script", a fact about configuration, not about the ticket's code.

`test` is **removed** from UAT; `scripts.test.ts` gets a guard asserting UAT never names it.

### boot

Not a `GateSpec` — it runs no script.

| Situation | `boot` | Downstream |
|---|---|---|
| No runnable repository in scope | `null` | steps record `null` (nothing to drive) |
| All services healthy | `0` | proceed |
| A service failed to come up | `null` + surfaced warning · **OPEN (C15)** | — |

**OPEN (C15):** rev 1 routed a failed boot to `fix`, contradicting the null rule three paragraphs
above it. Real boot failures are "another process owns that port", a 30 s health timeout on a 45 s
boot, `ENOENT` on the start command — **none agent-fixable**, all would park the ticket forever.
Current position: record `null` and surface a warning. Alternative under consideration: fail only
when the service booted successfully at baseline (comparative).

**OPEN (C3, C4, C5, C20):** adopt-or-spin is not extractable from `spin.ts` as rev 1 assumed.
`allocator.allocate` unconditionally INSERTs, so a second resolve returns *different* ports while
running servers keep the old set; `startHot` **throws by design** when the health URL already answers;
there is no `adopted` concept for servers; and a stack spun at scope serves **pre-implementation
code** for any compiled service, so adoption needs a freshness predicate.

### Types

**OPEN (C1):** `CommandResult.exitCode` is `number` and cannot express `null`, which `boot`, the step
runner, and `coverage` all need. Use `GateResult` (`review.ts:24-40`), moved to a shared module.

---

## Lane 1 — programmatic gates

No agent on this path, so §5.4 holds trivially. Gates go through `runCommand` (async spawn, so the
extension host keeps serving hooks and webviews) and record one `gate_runs` batch per invocation
inside `transition`'s `premutate`, with `attempt` read *before* the machine bumps it.

`gate_name` is free text in `schema.sql`, so new gate names need no migration of their own.

**OPEN (C8):** `shouldContinue` is polled only *between* stages. One UAT stage is now boot + N gates
at 15 min each + an agent session — **Stop is inert for up to an hour.** Needs an `AbortSignal`
through `RunCommandOptions` and into the driver.

**OPEN (C9):** `model/inside/gates.ts:1,113` imports and renders `UAT_GATE`; removing it breaks the
build. The new gate list is dynamic and includes gates with no script, so `GateSpec` no longer models
it.

**OPEN (C14):** a zero-config repo yields all nulls → **always green**, and `test` has been removed —
*more* vacuous than today. For karst's own repo UAT would go from "runs the suite" to "runs nothing
and passes". Either keep `test` until a non-null UAT gate exists, or make all-null a distinct
non-pass.

---

## Lane 2 — the agent authors steps; Playwright is the harness

One agent, one artifact. "Author e2e steps" and "explore" are the same act.

### The trust model

The agent **never authors evidence**. It drives a Playwright session **karst configures**, and karst
reads Playwright's own artifacts:

| Machine fact | Source |
|---|---|
| Console errors | `page.on('console')` / trace |
| Unhandled rejections | `page.on('pageerror')` |
| Failed network requests | `page.on('requestfailed')` |
| HTTP statuses | `page.on('response')` / trace |

This is the vadim.blog split — harness drives, agent chooses actions — without building a CDP layer,
because Playwright already is one.

**Trust property: under-exploration remains possible; fabrication does not.** An agent can visit fewer
pages than it should, but it cannot make a 500 it *did* hit disappear from a trace it is not writing.

**Under-exploration is not mechanically bounded.** Rev 2 claimed the coverage gate bounded it; B3 made
coverage advisory, so that claim is withdrawn rather than quietly retained. An agent that authors two
shallow steps for a five-criterion ticket gets a green UAT. What catches it is the same thing that
catches a vacuous test: the authored steps are committed to the branch and read as code in the review
diff, with coverage shown alongside as advisory evidence. This is a known limit, accepted
deliberately — see "No mechanical vacuous-green guard".

Rev 1 had the agent emit an `ExplorationRecord` that a "pure" `reduceExploration` consumed — which
faithfully reduced whatever the agent claimed. That was agent self-report with a JSON hop, and it is
deleted.

### What the agent is shown back (B4, resolved)

The agent does not browse — it writes a script, karst runs it. So its only new exposure is the
**failure feedback** karst hands back for selector repair, and karst owns that because karst owns the
reporter.

| shown | withheld |
| --- | --- |
| failing step index, error class | response bodies |
| the selector text | screenshots |
| HTTP status codes | full traces |
| console error *messages* | text content |
| DOM around the failure, **text nodes stripped** — tags, `data-testid`, `aria-*`, roles, classes | |

**A selector is structural**, so what repair needs is precisely the part carrying no user data. PII
lives in text nodes. Fallback if stripping proves fiddly: the structured summary alone — a wrong
selector costs one attempt against the cap, it corrupts nothing.

**Playwright's `outputDir` points into `globalStorage/artifacts/<ticketId>/`, never the repo.** By
default `test-results/` and `playwright-report/` land beside `uat.testDir` inside the worktree —
screenshots and network bodies full of live dev-DB content, one `git add -A` from a PR. Same class as
the service-log finding in B6, same fix, and karst owning the config is what makes it available.

### Mechanics

| | |
|---|---|
| Playwright source | The repo under test (`npx playwright` in the worktree, repo's own install and browsers). Karst ships nothing. Absent → the step gate records `null`. |
| Action channel | The agent writes a Playwright script; **karst runs it with karst's config** (reporter, trace, console/network capture, base URL). The script cannot disable capture because it does not own the config. |
| API side | Playwright's `APIRequestContext` — same trace, one evidence stream, UI and API findings correlate in one artifact. |
| Reuse | Authored once on first UAT arrival, **replayed** on re-entry. Attempts 2–3 are free and deterministic; a fix is judged against the same bar that failed it. |
| Persistence | **Written into the repo from the start**, on the ticket's branch, into `uat.testDir`. They ride into the PR and are reviewed as code. |
| Stale steps | The fix agent **may modify** them; every modification is flagged prominently in the review diff. |

### Authored steps must be repo-runnable

They become part of the repo's suite, so on the *next* ticket they run in **step 1, the static
phase**, before karst boots anything. They must therefore target the repo's normal e2e entry point and
`webServer` config — **never karst's injected per-ticket ports**. A step depending on a karst-spun
stack would fail for every later ticket.

This is a hard requirement on the authoring brief, and the kind of thing that breaks silently six
months later if it is not stated now.

### No mechanical vacuous-green guard

Stated plainly rather than implied to be covered. Rev 1 claimed an add-only rule on `uat.testDir` was
"the guard that actually stops it". Two things killed it:

1. Add-only never stopped **adding** a vacuous test — `test('[AC-3] …', () => expect(true).toBe(true))`
   satisfies coverage. The gate checks *existence*; "is this test meaningful" is undecidable.
2. Steps now live in the repo as maintained code, so a legitimate UI change **must** be repairable by
   the fix agent — which removes add-only entirely.

**The human review diff is the sole control**, with karst flagging agent modifications to draw the
eye. `runReview` already opens the diff regardless of verdict. This is a deliberate trade.

**OPEN (B5):** the diff base for flagging. Capture HEAD when `autoResumeFix` fires and compare the
**working tree** (staged + unstaged + untracked) — gates read files off disk, so a committed-history
check is trivially dodged. Config-level edits (`playwright.config.ts` `testPathIgnorePatterns`,
global fixtures) sit outside `testDir` and are a documented limit.

**OPEN (C11, C12, C13):** how the agent actually ships. `soloAgent` is for `single-subagent`-approach
tickets and cannot double as this. Approach artifacts are *fetched from a declared external source* —
karst authors no packages, so rev 1's "the existing vocabulary" was wrong. And rev 1 gave the agent
three competing homes (approach artifact, `agents:` block, `uat.author.agent`); pick `agents:`.

---

## Acceptance criteria — advisory, never a gate (B3, resolved)

**Criteria coverage produces no verdict.** The agent extracts criteria, karst records them, and the
coverage result lands in the review diff as evidence a human reads. Nothing in the machine depends on
it.

**Why, in one line: an LLM reading prose is not a deterministic signal, and §5.4 says verdicts come
only from deterministic signals.** Letting extracted criteria gate would break the invariant the whole
machine rests on. Rev 1 refused agent-reported pass/fail and then accepted an agent-extracted *bar*
from the same untrusted text — the contradiction was in the design, not in the threat.

The threat framing also mattered less than it looked. Injection via `ticketContext.ts:154` (ticket
descriptions render verbatim, and anyone with tracker access writes them) is the dramatic case but the
rare one. The common case needs no attacker: extraction reads a five-requirement ticket as one vague
criterion, coverage passes, the ticket ships under-tested. Same effect, weekly rather than never — and
a fix aimed only at malice misses it entirely.

**UAT still gates, on what is actually deterministic:** static gates, then authored steps passing
under karst's Playwright config. The authored steps *are* the criteria made executable; nothing is
lost by declining to also derive the bar from prose.

**This is the same call already taken in A3/A4** — the human review diff is the sole control against
vacuous tests. Advisory coverage applies that decision to the same problem instead of contradicting it.

### What this deletes

| was | now |
| --- | --- |
| `ticket_criteria` table + migration, `SCHEMA_VERSION` 15 → 16, **29** `user_version` literals in `db.test.ts` | not needed |
| `frozen_at`, the freeze UI, "what freezes it / who reviews it" | not needed |
| **C18** whole-set freeze (a later extraction INSERTing beside frozen rows) | dissolved — nothing to freeze |
| **C19** zero rows → coverage passes **vacuously** | dissolved — no pass to be vacuous |
| **C17** `[AC-n]` parsing across five report formats with no XML parser in the tree | advisory display only; a wrong parse misleads a reader, it does not green a ticket |

Phase 3 shrinks to advisory display.

**Rejected — a second agent reviewing the first agent's extraction** (the original instinct). Two
passes over the same adversarial text share the same misreading, so it addresses neither injection nor
extraction quality. It reads as a control without being one.

**Later rung, not now:** a user who wants the bar enforced freezes the set and coverage becomes a gate
for that ticket. Deliberately deferred — two code paths for one property, and the advisory rung has to
prove it is insufficient first.

### B3b — the write path (resolved, still required)

Untrusted ticket text still reaches argv, so the criteria write verb still gets **its own parse path**
(charset, length, count limits, no delete), separate from `parseStageArgs`, per the argv threat model
in `CLAUDE.md`. Rev 1's "no CLI changes" was wrong.

What changes is the blast radius, not the requirement: the worst outcome of a fully-injected call drops
from *"moved the acceptance bar"* to *"appended a row to an advisory list"* — exactly the `stage`
versus `phase` split that already exists.

---

## Credentials

`spin.ts:204` builds a service's env with `buildSpawnEnv(join(repo.repoPath, '.env'), …)`, commented
*"main `.env` keys first (secrets)"*. That function (`runtime/env.ts:38`, 12 lines) is the single
place `.env` enters a service, so it is the only seam this section touches.

A service's environment has **three** layers, and the two findings below are different layers:

| layer | source | governed by |
| --- | --- | --- |
| inherited | extension host `process.env` | **B8** — allowlist replacement |
| file | the repository's `.env` | **B1** — explicit overlay |
| resolved | karst's port/peer vars | unchanged, and must stay last |

Rev 1 claimed *"UAT-owned processes never read `.env`"*. That was never true of the services under
test, and it is not the property being built — see B1.

### Service credentials (B1, resolved)

`boot` spins the stack, so without this the **services under test boot with real secrets**. The harm
is not exposure — UAT drives the app for real, so *"user receives a confirmation email"* sends mail
and *"checkout completes"* charges a card, up to `maxFixAttempts` times per ticket. The low-privilege
UAT account governs who is signed in, not which Stripe account the backend talks to; redaction runs
after the charge.

**Explicit overlay. karst never guesses; the user names the keys.** Pattern-matching key names to
decide what is dangerous in someone else's stack is not karst's call to make.

```yaml
uat:
  env:                       # literals — committed, must be non-secret
    SMTP_HOST: "127.0.0.1"
    PAYMENTS_MODE: "test"
  secrets:                   # names only; values live in karst's secret store
    - STRIPE_SECRET_KEY
    - SENDGRID_API_KEY
```

Values never appear in `karst.yml` — it is committed. `secrets:` lists key *names*; values come from
the store (UI now, Infisical later). Project-level with a per-repository override block, mirroring
`tickets.model` → `defaultModel`.

**Applied at both seams — gates and boot.** `runCommand` passes no env, so gates never receive `.env`
*from karst*, but a repo's `test:integration` usually calls `dotenv.config()` and reads the file
itself. dotenv does not overwrite a variable already set in the environment, so putting the override
in the gate child's env is what stops the self-loaded file from winning. Overlay at boot alone and
integration gates keep hitting real Stripe. `dotenv.config({override: true})` defeats this — a
documented limit.

**Precedence:** `.env` → UAT overlay → resolved vars **last**, or resolved ports lose and the alt-port
worktree scheme breaks. A `uat.env` key colliding with a resolved var name is refused at validation.

**A listed secret with no stored value refuses to boot**, naming the key. Falling back to the real
`.env` value would silently defeat the feature. Not agent-fixable → needs-you (C15).

**Fail-open, accepted and made legible.** An unlisted key passes through real, and a key added to
`.env` later stays uncovered until someone lists it. So each run records which keys were overridden
and which passed through, and **warns** on an unoverridden key whose name matches a known
side-effect pattern (`STRIPE_*`, `SENDGRID_*`, `SMTP_*`, `TWILIO_*`, `*_WEBHOOK_URL`). Warning, never
a block: the list informs the decision, it does not make it.

### Process environment (B8, resolved)

`runCommand` spawns with no `env`, so gate children inherit the extension host's — `AWS_*`,
`GITHUB_TOKEN`, direnv exports. `startHot` merges `{...process.env}` at `supervisor.ts:94`. Both
become an **allowlist replacement**:

```
PATH HOME SHELL LANG LC_* TZ TMPDIR USER LOGNAME
NODE_ENV CI
HTTP_PROXY HTTPS_PROXY NO_PROXY http_proxy https_proxy no_proxy
```

plus a manifest `env.passthrough: [...]` escape hatch, plus the UAT overlay. Proxy vars are
load-bearing: without them `npm test` behind a corporate proxy cannot reach the registry, and the
failure looks like a broken repo.

**This applies to review gates too, not only UAT.** The leak is on `main` today; fixing it on one
stage and not its neighbour is harder to justify than the one-time behaviour change. The risk is a
repo whose test script needs an inherited variable — that is what `env.passthrough` is for.

**Allowlist, not denylist, because karst is multi-provider.** A denylist needs a new entry per
provider (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, …) and fails silently on the one
nobody added. An allowlist covers providers that do not exist yet.

**The gate artifact records that filtering occurred and which keys survived.** Otherwise "green in my
shell, red in karst" is unbrowsable and nobody discovers `env.passthrough`.

**Scope boundary:** this covers children that run *repository* code. The **agent terminal is
excluded** — the agent is an authenticated actor and holding credentials is its job. All three
adapters return `env: {}` and rely on the inherited environment plus a credentials file under `HOME`;
nulling that would break subscription auth per-adapter. See B9 for the one real issue at that seam
(an exported provider API key possibly switching the agent to metered billing), which is a standing
karst issue, not a UAT one.

### Logs and redaction (B6, resolved)

**Service logs move out of the worktree.** `spin.ts:224` writes `join(cwd, '<name>.log')` where `cwd`
is the git worktree, so a file holding everything a server booted with the real `.env` printed sits in
the repo working tree — and `git check-ignore api.log` says it is **not ignored**, in karst's own repo.
One `git add -A` puts real secrets in a commit and then a PR. Live on `main`; UAT makes it likely,
because UAT boots the stack and hands it hot to review and ship, where commits happen.

New home: `globalStorage/artifacts/<ticketId>/<service>.log`, beside gate artifacts, outside every
repo. `spinTicket` takes the directory as a **required** parameter, so a missed call site is a compile
error rather than a silent fallback to `cwd`. Pre-upgrade leftovers are not deleted — karst does not
remove files from a user's worktree — but the service log names are added to the service repo's
`.git/info/exclude`, the mechanism `worktree.ts` already uses for `.karst/`. Exact names, not `*.log`,
which could mask a log the repo legitimately tracks.

**Redaction covers what karst writes, and nothing more.** A pure `redact(text, secrets)` applied at
`writeFileSync` in the stage and at panel render — not inside `BoundedOutput`, which only accumulates
and renders. Service logs stay unredacted: `stdio: ['ignore', logFd, logFd]` hands the fd straight to
the child, so karst never sees those bytes, and piping through the host would relay every byte of
every dev server for hours *and* EPIPE the detached server when the host exits, destroying the
survives-VS-Code-exit property (cf. C7). Once the file is outside the repo, that is an acceptable gap.

**A length floor is mandatory.** Scrubbing every known value destroys the artifact —
`PAYMENTS_MODE=test` would turn every "test" in the output into `[redacted]`. Only values at or above
a threshold are scrubbed, common tokens skipped. Undiagnosable failures cost more than this saves.

**It is a convenience, not a boundary.** Catches a secret printed verbatim — a boot-time config dump,
a stack trace carrying a connection string — which is how secrets reach logs in practice. Does not
survive base64 Basic Auth, percent-encoding, JSON-escaping, a value straddling the 1 MiB truncation
boundary, or a derived token (a JWT signed *with* a secret contains none of its bytes).

**OPEN (B7):** manifest validators hand-pick known fields and never reject unknown keys, so "a secret
value in the block is rejected" needs a deliberate strict check departing from house style.

---

## Data safety

Ports are isolated per ticket; the datastore is not (`scope.ts:35` already warns). Requiring a
disposable test DB is not viable — on real projects no test DB exists and all development goes
through dev.

**Determinism is largely handled by the fail set being small.** Console errors, unhandled rejections,
failed requests and 5xx are state-independent: a 500 is a 500 regardless of what another ticket did.
The state-sensitive question lives in `coverage` and the repo's own suites, whose state management is
the repo's problem in CI today.

**Destruction: the UAT account's privileges are the primary control.** The agent authenticates with
the test account and the app's own authorization decides what it can reach. Fully agnostic — karst
learns nothing about ArangoDB, Postgres, or anything else.

**The standalone guard proxy is deleted.** Karst is already in-path through Playwright's network
interception, so denies and mutation budgets are enforced on traffic karst genuinely sees —
*including SPA XHR*, which a separate proxy was structurally blind to because the API base URL is
baked into the bundle at build time.

`uat.isolation` (`none｜reset｜ephemeral`) stays as a declared, agnostic ladder with **`none` the
default and the only rung wired**. **Cut candidate** — see Deferred.

**OPEN (B4):** the agent's session transcript carries typed credentials, shared-dev-DB PII, and
debug-page contents into an agent context, possibly cloud. Stated in rev 1, unsolved. Playwright as
harness reduces but does not remove it.

---

## Stack lifecycle

**UAT adopts-or-spins and leaves the stack up.** Review inherits a hot stack, so manual acceptance
testing needs no respin and the stack a human pokes is the one UAT judged.

**OPEN (C6) — rev 1 claimed teardown "moves to boundaries that already exist". Four of five do not.**
Verified: `stopTicketServers`/`stopServer` are called only from `spin.ts:75,133` (cancel/respin) and
`extension.ts:2176,2180,2216` (dashboard buttons). `ship.ts`, `done.ts`, `archive.ts` contain **zero**
server code. Archive also has an ordering bug **today**: the worktree is removed and ports released
under a live pid — the exact hazard `spin.ts:128-133` documents elsewhere.

**OPEN (C7):** children spawn `detached: true` and **survive VS Code exit**; `reconcileOnStart` only
marks *dead* rows, so a survivor stays `running` forever.

**OPEN (C2) — rev 1 stated a safety property backwards.** `startHot` awaits health at ~153 and INSERTs
the `servers` row at ~176. A crash mid-boot leaves an **untracked pid**, not a reapable row. Fix:
insert with the pid before the wait, update status after. This is a latent bug today; UAT makes it
matter more.

**OPEN (C22):** review inheriting a hot stack breaks any suite that starts its own server — the same
port conflict the pipeline ordering avoids inside UAT.

---

## Manifest surface

```yaml
uat:
  testDir: e2e/karst          # authored steps; fix modifications flagged in review
  maxFixAttempts: 3
  isolation: none             # cut candidate
  gates:
    - { name: integration, kind: script, script: "test:integration" }
    - { name: e2e,         kind: script, script: e2e, repo: web,
        report: "reports/junit.xml" }
  author:
    agent: uat-author         # → the `agents:` block (C13)
    enabled: true
```

An absent `uat:` block yields the default pipeline. Per the new-`Manifest`-field checklist:
`types.ts`, `validateManifest`, the `writeManifest` overlay, and `manifest/fixtures.ts`.

**OPEN (C21):** `testDir` is project-level but repos are many; it must resolve per-repo or relative to
each gate's `repo:`.

---

## Phasing

**Phase 0 — one commit, ships immediately.** Delete `UAT_GATE`, update its `inside/gates.ts` consumer,
add the anti-duplication guard test. This is the literal stated bug.

**Phase 1 — make UAT gate.** The `fixUat`/`fixReview` split + migration, the attempt cap, static gates,
`boot` with adopt-or-spin, `env` threading with the allowlist, the `AbortSignal` cancel path, and the
four missing teardown call sites. Resolves A1 and the C-series lifecycle items. **No AI.**

**Phase 2 — authored steps.** The `uat-author` agent and its distribution path, Playwright-as-harness
config and trace reading, steps into `testDir`, replay-on-re-entry, modification flagging.

**Phase 3 — advisory coverage.** `[AC-n]` parsing for one chosen format, surfaced in the review diff,
plus the CLI write verb with its own parse path (B3b). No migration, no freeze, no verdict — B3 made
coverage advisory, so this phase is display and evidence only. Purely additive: without it the review
diff simply carries no coverage line.

## Deferred / cut

Speculative surface with no user waiting on it, each carrying real validation and test cost:

`UatSecretSource` union + `infisical` arm + settings UI · the standalone guard proxy (deleted by
Playwright interception) · the isolation ladder's `reset`/`ephemeral` rungs · `scaffold: author` ·
the AI-review second pass on criteria (replaced by a human freeze) · `kind: command`

## Cost

Rev 1 claimed the AI parts were token-cheap because sub-agent context is separate. That is a category
error: separate context means the **parent** does not pay — total tokens go *up*, since the agent
re-reads routing, selectors and contracts. Authoring plus a browsing session with DOM snapshots is
the most expensive token class in the pipeline.

The bound is the ordering (static gates fail before any agent runs) plus `maxFixAttempts`.

**OPEN:** `"failed network request (non-optional)"` — **"non-optional" is nowhere defined**, and that
one adjective carries the determinism claim for the most expensive gate. Real dev stacks fire it
constantly: source-map 404s, HMR reconnects, blocked analytics, `AbortError` on navigation.
