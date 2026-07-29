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
writing. ~~Under-exploration is bounded by the coverage gate.~~ **Superseded by B3** — coverage is
advisory and gates nothing, so under-exploration is bounded only by the review diff. See B5b.

**Consequence — B2 is deleted.** The standalone guard proxy is unnecessary: karst is already in-path
through Playwright's network interception, so denies and mutation budgets are enforced on traffic
karst genuinely sees — *including SPA XHR*, which the proxy was structurally blind to because the API
base URL is baked into the bundle at build time.

The throwaway exploration script lives outside `uat.testDir`, so it never collides with the fix guard
(A3).

### A3 `RESOLVED` (later superseded) — the coverage gate deadlocks

> **Superseded twice, kept as the reasoning trail.** A4 removed the add-only rule (steps live in the
> repo and must be repairable). B3 then made coverage advisory, so the deadlock this item describes
> cannot occur at all — there is no coverage gate to fail. Current behaviour: B5's modification
> flagging.

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

> **SUPERSEDED BY A4.** A4 decided the fix agent **may modify** authored steps, with every
> modification flagged in the review diff — because steps now live in the repo and a legitimate UI
> change must be repairable. That removes the add-only rule.
>
> What survives: the deadlock is still solved (a fix can write the missing test, more freely than
> add-only allowed), and the **diff base** decision stands — capture HEAD at `autoResumeFix`, compare
> the working tree, since gates read files off disk.
>
> What is lost: **there is no longer any mechanical vacuous-green guard.** The human review diff is
> the sole control, with karst flagging agent modifications to draw the eye. This is a deliberate
> trade — steps as maintained repo code must be repairable — but it should be stated plainly rather
> than implied to be covered.

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

### A4 `RESOLVED` — Lane 3 is gated off precisely when it is needed

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

#### Resolution (decided) — reorder, and merge Lanes 2 and 3

```
uat:
  1. static gates    unit → integration → e2e        NO karst stack
       ↓ any failed → fixUat (a spin was never paid for)
  2. boot            spin + health
  3. agent authors e2e steps against the LIVE app
  4. karst runs them under karst's Playwright config
  5. coverage
       ↓ any failed → fixUat
       ↓ passed → review
```

Three properties this ordering buys:

- **No spin cost on the common failure.** A red unit test never pays for booting a multi-repo stack.
- **Blind authoring disappears.** Steps are written against a running app with real selectors,
  redirects and error states. There is nothing left for a "mitigation" to cover.
- **It avoids a port conflict.** A standard Playwright suite starts its own server via `webServer`.
  If karst's boot already holds those ports, the repo's own e2e fails to start for a reason unrelated
  to the ticket. Running repo suites *before* boot lets each manage its own lifecycle. (Same latent
  problem as C22.)

**Lanes 2 and 3 collapse into one agent.** "Author e2e steps" and "explore" are the same act: the
agent produces steps, karst runs them under its own Playwright config and reads the trace. A2's trust
property is unchanged — agent supplies steps, Playwright supplies evidence.

| Decision | Value |
|---|---|
| Reuse | Authored once on first UAT arrival, **replayed** on re-entry. Attempts 2–3 are free and deterministic, and a fix is judged against the same bar that failed it. |
| Persistence | **Written into the repo from the start**, on the ticket's branch, into `uat.testDir`. They ride into the PR and are reviewed as code. |
| Stale steps | The fix agent **may modify** them; every modification is flagged prominently in the review diff. |

**Consequence — the authored steps must be runnable by the repo's own e2e runner.** They become part
of the repo's suite, so on the *next* ticket they run in step 1, the static phase, before karst boots
anything. They must therefore target the repo's normal e2e entry point and `webServer` config —
**never karst's injected per-ticket ports**. A step depending on a karst-spun stack would fail for
every later ticket. This is a hard requirement on the authoring brief and the kind of thing that
breaks silently six months later if it is not stated now.

**Consequence — A3's add-only rule is superseded.** See below.

---

## B. Security

### B1 `RESOLVED` — the `.env` boundary is scoped to the wrong thing

`boot` reuses `spinTicket` → `spin.ts:204` `buildSpawnEnv(join(repo.repoPath, '.env'), …)`. The
guarantee covers gates and agents; **the service under test still boots with real secrets**.

**The harm is not exposure — it is a real-world side effect.** UAT drives the app for real, so a
criterion like *"user receives a confirmation email"* sends mail and *"checkout completes"* charges a
card, up to `maxFixAttempts` times per ticket. Neither the low-privilege UAT account (which governs
who is signed in, not which Stripe account the backend talks to) nor redaction (the charge already
happened) touches this.

**Decision — explicit overlay. karst never guesses; the user names the keys.**

Rationale, user's: *"user responsible to override if he want to make automated testing from another
env."* karst substituting values by pattern-matching key names would be karst deciding what is
dangerous in someone else's stack.

```yaml
uat:
  env:                       # literals — committed, must be non-secret
    SMTP_HOST: "127.0.0.1"
    PAYMENTS_MODE: "test"
  secrets:                   # names only; values live in karst's secret store
    - STRIPE_SECRET_KEY
    - SENDGRID_API_KEY
```

Values never appear in `karst.yml` — it is committed. The `secrets:` block lists key *names*; values
come from the store (UI-entered now, Infisical later). Per-project, with a per-repository override
block, mirroring the `tickets.model` → `defaultModel` precedence already in the codebase.

**Applies at BOTH seams, and this is not optional.** `runCommand` passes no env, so gates never
receive `.env` from karst — but a repo's `test:integration` typically calls `dotenv.config()` and
reads the file off disk itself, which karst cannot prevent. dotenv does **not** overwrite a variable
already present in the environment, so placing the override in the gate child's env is what stops the
self-loaded `.env` from winning. Overlay at `boot` only and integration gates keep hitting real
Stripe. (A repo using `dotenv.config({override: true})` defeats this — documented limit.)

**Precedence:** `.env` → UAT overlay → resolved vars **last**. Resolved ports and peer URLs must win
or the alt-port worktree scheme breaks. A `uat.env` key colliding with a resolved var name is
**refused at validation**, never silently dropped — same rule as the both-keys manifest refusal.

**A listed secret with no stored value refuses to boot**, naming the key and pointing at settings.
Passing the real `.env` value through instead would silently defeat the entire feature. Not
agent-fixable → parks at needs-you (C15 path).

**Fail-open is accepted, and made legible.** A key nobody listed passes through real, and a key added
to `.env` later is not covered until someone lists it. To keep responsibility informed rather than
blind, each run records in the artifact which keys were overridden and which passed through, and
**warns** on any unoverridden key whose name matches a known side-effect provider pattern
(`STRIPE_*`, `SENDGRID_*`, `SMTP_*`, `TWILIO_*`, `*_WEBHOOK_URL`). A warning, never a block — the
pattern list informs the user's decision, it does not make it.

### B2 `RESOLVED` (cut) — the guard proxy does not work for the archetypal stack

Four independent problems: an SPA's XHR goes to the API URL **baked into the bundle at build time**,
so the proxy sees navigation only; enforcement is a base URL string an agent may ignore; a karst 403
produces a console error and failed request that the fail set cannot distinguish from a real one
(no provenance field); and `onDenied: abort` → `explore` = null lets one denied action silently
neutralize the lane forever. Also denylist-by-default, and `POST /graphql` funnels every mutation
through one path so `DELETE /api/**` never fires.

**Fix: cut it.** The low-privilege UAT account remains the primary control, and the gap gets
documented. Keeping it would require allowlist-default, path normalization, a provenance field, and
`onDenied: record` — a lot of machinery for something blind to SPA traffic.

### B3 `RESOLVED` — criteria poisoning

Ticket descriptions are attacker-controllable in a shared tracker and render verbatim
(`ticketContext.ts:154`). They feed criteria extraction, whose output becomes the frozen acceptance
bar, and the explorer's instructions. The spec refuses agent-reported pass/fail but accepts
**agent-extracted criteria from adversarial text** as ground truth.

**Decision — coverage is advisory. Criteria never gate.**

**The framing in this finding was too narrow.** Injection is the dramatic case and the rare one. The
common case needs no attacker: extraction reads a five-requirement ticket as one vague criterion,
coverage passes, the ticket ships under-tested. Same effect, weekly rather than never. Both reduce to
one fact — **an LLM reading prose is not a deterministic signal** — and §5.4 admits only deterministic
signals as verdicts. A fix aimed only at malice would have left the frequent failure untouched.

So the agent still extracts, karst still records, and coverage lands in the review diff as evidence a
human reads. No verdict depends on it. The injection surface stops mattering — not because it is
defended, but because nothing mechanical hangs off the extracted text.

UAT still gates on what *is* deterministic: static gates, then authored steps passing under karst's
config. The authored steps are the criteria made executable.

**Consistent with a decision already taken:** A3/A4 accepted the human review diff as the sole control
against vacuous tests. This applies the same call to the same problem.

**Deletes:** the `ticket_criteria` migration (`SCHEMA_VERSION` 15 → 16, 29 `user_version` literals),
`frozen_at`, the freeze UI, and the "what freezes it / who reviews it" questions. **Dissolves C18**
(whole-set freeze — nothing to freeze) and **C19** (empty set passing vacuously — no pass to be
vacuous). **Defuses C17**: `[AC-n]` parsing across five formats with no XML parser in the tree becomes
advisory display, where a wrong parse misleads a reader instead of greening a ticket.

**Costs, stated rather than buried:** under-exploration is no longer mechanically bounded. Rev 2
claimed the coverage gate bounded it; that claim is withdrawn. An agent authoring two shallow steps for
a five-criterion ticket gets a green UAT, caught only by the review diff.

**Rejected — a second agent reviewing the extraction.** Two passes over the same adversarial text share
the same misreading. Neither injection nor extraction quality improves; it reads as a control without
being one.

**Later rung:** freeze-to-gate, per ticket, opt-in. Deferred — two code paths for one property, and the
advisory rung should prove insufficient first.

### B3b `RESOLVED` — the criteria write path

Still required, smaller blast radius. Untrusted ticket text still reaches argv, so the write verb gets
**its own parse path** (charset, length, count limits, no delete), separate from `parseStageArgs`, per
the argv threat model in `CLAUDE.md` — the spec's "no CLI changes" was wrong. But the worst outcome of
a fully-injected call drops from *"moved the acceptance bar"* to *"appended a row to an advisory
list"*, which is the existing `stage`-versus-`phase` split exactly.

### B4 `RESOLVED` — live app content reaching a cloud agent

Filed against Lane 3's browsing explorer. A2 deleted that; the finding survives in a narrower and
more tractable form.

**Verified: the agent does not browse.** It writes a Playwright script and *karst* runs it. Three
channels into agent context, one of them new:

| channel | new? | content |
| --- | --- | --- |
| worktree source | no — the impl agent already has it | code |
| **failure feedback** for selector repair | **yes** | whatever karst chooses to hand back |
| anything else | no | karst would have to put it there |

karst owns the reporter config, so it owns channel 2 outright. B4 is therefore a design decision, not
an inherent leak.

**Decision — structured summary plus structure-only DOM.**

The agent receives: failing step index, error class, the selector text, HTTP status codes, console
error *messages*, and the DOM around the failure **with text nodes stripped** — tags, `data-testid`,
`aria-*`, roles and classes kept, content dropped.

Rationale: **a selector is structural.** What the agent needs to repair one is exactly the part that
carries no user data; PII lives in text nodes, and selectors do not. Constraint and requirement point
the same way rather than trading off.

Explicitly **not** handed to the agent: response bodies, screenshots, full traces, text content.

**Fallback if text-stripping proves fiddly:** drop to the structured summary alone. It degrades
gracefully — a wrong selector costs one attempt against the cap of 3, it corrupts nothing.

**Second finding, same class as B6 — Playwright's own output directory.** `test-results/` and
`playwright-report/` (screenshots, network bodies, traces, all live dev-DB content) are written
relative to the config, i.e. **inside the repo**, beside `uat.testDir`. One `git add -A` from a PR.
karst owns the config, so `outputDir` points into `globalStorage/artifacts/<ticketId>/`. Cheap, but it
does not happen by itself.

**Not recommended:** a local-only model for the author agent — cuts against the subscription premise
(Claude/Codex/Antigravity) and adds a config surface for less than the DOM-stripping gets.

### B5 `RESOLVED` — authored-step modification detection

The original framing died with A3's add-only rule: A4 lets the fix agent **modify** authored steps,
flagging every modification. So `testDir` being populated during impl no longer "rejects every fix
cycle" — nothing rejects. What remains is the mechanics of *flagged*.

**Decision — content hashes in a sidecar artifact.**

karst hashes each step file as it writes it, storing path+hash in
`globalStorage/artifacts/<ticketId>/authored-steps.json`. At review, re-hash and compare. Survives
`--amend`, rebase and squash because it never touches git history, and needs **no migration** —
artifacts already live per-ticket in `globalStorage`.

Rejected: a **karst-authored baseline commit** (agents amend, rebase and squash routinely; the baseline
vanishes and the flag silently stops working — the worst property available), and a **provenance
marker** alone (cannot distinguish "the fix agent edited the failing test" from "an agent wrote these",
and the first is the entire signal).

**Required properties, because the naive version fails open:**

| case | behaviour |
| --- | --- |
| baseline missing (globalStorage wiped, DB reset, archive→restore) | **flag every authored file as unverifiable** — never flag none |
| path absent at review | flag as deleted |
| unknown file under `testDir` | flag as new |
| identical content after delete+recreate | no flag (content is identical) |

**Known weakness, not solvable inside B5:** a hash cannot distinguish a comment change from a gutted
assertion — both flag identically. Flag everything and the flags get skimmed within a week, which is
worse than no flags because it manufactures a feeling of coverage. Mitigation is to attach the diff to
the flag so severity is visible at a glance.

**Config bypass — narrowed by A2, not closed.** karst owns the Playwright config for the run karst
judges, so `testPathIgnorePatterns` bypasses nothing on this ticket. But karst's config must spread the
repo's to inherit fixtures (authored steps typically need the repo's auth setup), so an agent editing
`playwright.config.ts` could influence capture. Therefore: karst's overrides (reporter, trace,
`outputDir`, console/network capture) are applied **after** the spread, and `playwright.config.ts` is
hashed alongside the authored steps so edits to it are flagged identically.

### B5b `RISK` — four controls, one human, one moment

Not a finding in any review; an emergent property of the resolutions above, recorded because it was
never chosen by anyone.

| control | resolves to |
| --- | --- |
| A3/A4 vacuous tests | human reads the diff |
| B3 coverage | human reads the diff |
| B5 step modification | human reads the diff |
| B1 unlisted `.env` key | human reads a warning |

**These are not four independent controls — they are one control with four labels.** An inattentive
review fails all four simultaneously rather than independently, which is the opposite of what defence
in depth buys.

**Accepted as a named risk.** The available lever is making exactly one of the four blocking to break
the correlation; B5 is the best candidate (narrowest, most mechanical signal, and a false positive
costs a reviewer thirty seconds rather than parking a ticket). Deferred — consistent with the advisory
call in B3 — but it should be revisited if review quality proves to be the weak link in practice.

### B6 `RESOLVED` — redaction gaps, and a worse finding underneath

Filed as "redaction is at the wrong seam." True, and secondary. Verification found the real issue.

**`spin.ts:224` writes each service log to `join(cwd, '<name>.log')`, and `cwd` is the git worktree.**
A file containing everything a server booted with the real `.env` printed sits in the repo working
tree. `git check-ignore api.log` in karst's own repo: **not ignored**; an arbitrary user's repo is
less likely to ignore it. One `git add -A` puts real secrets in a commit, then a PR. Live on `main`
today, and UAT is what makes it likely — UAT boots the stack and hands it hot to review and ship,
where commits happen.

**Redacting those logs is structurally impossible as plumbed.** `stdio: ['ignore', logFd, logFd]`
(`supervisor.ts:92`) hands the fd to the child; karst never sees the bytes. Piping through the host
would relay every byte of every dev server for hours *and* close the pipe on host exit, giving the
detached server an EPIPE — destroying the "server survives VS Code exit" property (cf. C7).

**Decision — relocate, then redact what karst actually writes.**

1. **Relocate service logs** to `globalStorage/artifacts/<ticketId>/<service>.log`, beside gate
   artifacts, outside every repo. `spinTicket` takes the directory as a **required** parameter — no
   default, so a missed call site is a compile error rather than a silent regression to `cwd`.
   Fixes every stage, not just UAT.
2. **Leftovers from before the upgrade** are not deleted (karst does not remove files from a user's
   worktree). Instead the service log names go into the service repo's `.git/info/exclude` — the
   mechanism `worktree.ts` already uses for `.karst/`. Local-only, never touches the user's committed
   `.gitignore`. Exact names, **not** `*.log`, which could mask a log the repo legitimately tracks.
3. **Redact gate artifacts** at the true egress: a pure `redact(text, secrets)` applied at
   `writeFileSync` in the stage **and** at panel render. Not inside `BoundedOutput`, which only
   accumulates and renders.
4. **Server logs stay unredacted**, which is acceptable once they are outside the repo.

**Practical constraint on value-scrubbing: a length floor is mandatory.** Naive substitution of every
known value destroys the artifact — `PAYMENTS_MODE=test` would replace every occurrence of "test" in
the output with `[redacted]`. Scrub only values at or above a length threshold, skipping common
tokens. Without this, redaction makes failures undiagnosable, which costs more than it saves.

**Documented as a convenience, not a boundary.** It catches a secret printed verbatim — a boot-time
config dump, a stack trace carrying a connection string — which is how secrets actually reach logs in
practice. It does **not** survive base64 Basic Auth, percent-encoding, JSON-escaping, a value
straddling the 1 MiB truncation boundary, or a derived token (a JWT signed *with* a secret contains
none of its bytes).

**Not on the commit path either way:** gate artifacts already live in `globalStorage`. The relocation
concerns service logs only.

### B7 `RESOLVED` — secret storage, and rejecting a value in the `secrets` block

Verified: `schema.ts` hand-picks known fields and silently ignores the rest, by house style. Everywhere
else an ignored unknown key is inert. In `uat.secrets` it means **a live credential committed to git**
via `karst.yml`, because the block exists precisely to hold names and never values.

**Storage — reuse the seam that already exists.** `src/extension/secretStore.ts` is the
CLAUDE.md-sanctioned split: a `SecretStore` interface (`get`/`store`/`delete` over `PromiseLike`) with
no `vscode` import, bound to the real `context.secrets` in `secrets.ts`. OS-keychain backed. No new
infrastructure; UAT secrets are additional keys through the same door.

**Project-scoped keys — `karst.uat.<projectSlug>.<KEY>`.** `CLICKUP_TOKEN_KEY` is a flat global key,
correct for one tracker token and wrong here: two projects have different sandbox credentials, and
global storage is shared by every window — the trap `CLAUDE.md` documents for hook ports.

**`karst.yml` holds names only.** A key *name* is not a secret, and the declarative list is what makes
B1's fail-open reviewable: an added override shows in the PR diff, and a fresh clone shows which keys
need values. Keeping the name list in the store instead would make the override set invisible to
review, non-portable, and unvalidatable at load — a net loss.

**The strict check:**

| block | shape | on violation |
| --- | --- | --- |
| `uat.secrets` | list of strings (names) | **reject at load**, naming the field |
| `uat.env` | mapping name→value (non-secret literals) | accepted |

A mapping under `secrets:`, or any entry carrying a value, is refused. This deliberately departs from
house style for one block, justified by it being the only block where the failure mode is a committed
credential.

**Plus a heuristic warning on `uat.env` values** matching known credential shapes (`sk_live_`,
`sk_test_`, `ghp_`, `AKIA`, `SG.`) or high entropy. A warning, never a block — it cannot be reliable,
and the mistake it catches (pasting a value into the wrong block) is the likely one.

**Missing values surface at load and in settings**, not only as a boot failure — "3 declared, 1
missing" is actionable where a failed spin three stages later is not.

**Boundary: secrets are extension-host-only.** The `karst` CLI runs under plain `node` with
`node:sqlite` and cannot read SecretStorage — and never needs to, since no CLI verb spawns a service.
Secrets reach neither `karst.yml`, the DB, gate artifacts (B6's redaction seam), nor the agent's context
(B4).

### B8 `RESOLVED` — `runCommand` inherits the developer's shell

`gates/run.ts` spawns with no `env`, so children get the extension host's environment — `AWS_*`,
`GITHUB_TOKEN`, direnv exports. True today, unchanged by the spec. A bare replacement drops `PATH`
and `npm` stops resolving. `startHot` merges `{...process.env}` at `supervisor.ts:94`.

**Decision — allowlist, applied at every seam that runs repository code.**

**Scope is the point.** B8 governs children karst spawns *to run code from the repository*: gates
(`runCommand`) and services (`startHot`). It does **not** govern the agent terminal — see B9, which
is a different seam with an inverted threat model. Conflating them was an error in the first pass at
this item.

| seam | today | after |
| --- | --- | --- |
| `runCommand` — gates (uat **and** review) | no `env` → full inherit | allowlist, replacement |
| `startHot` — services under test | `{...process.env, ...opts.env}` | allowlist + explicit overlay |
| agent terminal | full inherit (`env: {}` from every adapter) | unchanged — B9 |

Review gates are included deliberately. The leak is not caused by this feature — it is on `main`
today — and a UAT-only fix would leave the identical hole one stage later, which is harder to
explain than a one-time behaviour change.

**Allowlist:**

```
PATH HOME SHELL LANG LC_* TZ TMPDIR USER LOGNAME
NODE_ENV CI
HTTP_PROXY HTTPS_PROXY NO_PROXY http_proxy https_proxy no_proxy
```

Proxy vars are not optional. Drop them and `npm test` behind a corporate proxy cannot reach the
registry — a failure that looks like a broken repo and is nearly unbrowsable.

Plus a manifest escape hatch, `env.passthrough: [...]`, for what karst cannot predict (`ASDF_DIR`,
`DOCKER_HOST`, `AWS_PROFILE`, a private-registry `npm_config_*`).

**Allowlist, not denylist — and the multi-adapter reality is the argument.** karst drives Claude,
Codex, and Antigravity today and will add more. A denylist would need a new entry per provider
(`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, …) and would fail *silently* on the one
nobody remembered. An allowlist covers every provider that does not exist yet, at no cost.

**Legibility requirement.** A filtered environment turns "green in my shell, red in karst" into a
mystery. The gate artifact records which keys were passed and notes that filtering occurred, so the
diagnosis is one look rather than an afternoon. Without this the escape hatch is undiscoverable —
nobody reaches for `env.passthrough` when the symptom is a test failure.

### B9 `NEW` `MED` — an exported provider API key may silently switch the agent off subscription

Not a UAT finding — a standing one, surfaced while scoping B8, and orthogonal to this feature.

karst is built around **subscription** auth (Claude, Codex, Antigravity), where credentials live in a
file under `HOME` and no environment variable is involved. All three adapters return `env: {}`
(`claude.ts:135`, `codex.ts:440`, `antigravity.ts:142`), so the agent inherits the extension host's
environment whole.

If a provider's API-key variable happens to be exported there — for an unrelated project, by direnv,
by a shell profile — the provider CLI may prefer **metered API billing** over the subscription. The
user is charged per token for work they believe their subscription covers, and nothing in karst says
so. The same environment also reaches every karst-launched agent, so the effect is not one session.

**Unverified.** Each CLI's precedence rule needs checking per adapter before acting; I have not
confirmed any of them. Cheap to test: export a dummy key, launch, observe.

**If confirmed:** karst detects the variable at launch and warns, naming the provider and the
variable, rather than stripping it. Stripping would break a user who *is* deliberately on API
billing, and would break them invisibly — the failure mode this finding is about.

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
| C9 `RESOLVED` | "no other files change" | `model/inside/gates.ts:1,113` imports and renders `UAT_GATE`; removing it breaks the build. The new gate list is dynamic and includes gates with no script, so `GateSpec` no longer models it | Model a dynamic gate list; update the dashboard stepper |
| C10 `LOW` | "nine hardcoded `user_version` literals" | **29** in `db.test.ts` (from a stale `CLAUDE.md` line) | Correct the estimate — 3× |
| C11 `RESOLVED` | `soloAgent` ships `uat-author` | It is the agent for a **`single-subagent`-approach ticket**, mutually exclusive with a real approach package | New distribution path needed |
| C12 `RESOLVED` | "an approach artifact — the existing vocabulary" | Approach artifacts are *fetched from a declared external source*; karst authors no packages. Lane 2 would only work if the chosen approach happens to ship `uat-author` | Karst synthesizes/merges a package (new code in `assembleAndWrite`, which also runs `assertPackageContributes` + `sanitizeFrontmatter`) |
| C13 `RESOLVED` | — | Three competing homes for one agent identity: approach artifact, `agents:` block, `uat.author.agent` | Pick `agents:` |
| C14 `RESOLVED` | "Phase 1 fixes the duplication bug" | A zero-config repo yields **all nulls → always green**, and `test` has been removed. For karst's own repo UAT goes from "runs the suite" to "runs nothing and passes" — *more* vacuous than today | Keep `test` in UAT until a non-null UAT gate exists, **or** make all-null a distinct non-pass |
| C15 `RESOLVED` | `boot` failure → `fix` | Contradicts the null rule three paragraphs above. Real boot failures are "another process owns that port", 30 s health timeout on a 45 s boot, `ENOENT` on the start command — **none fixable by the agent**, all park the ticket at `fix` forever | Boot failure = `null` + a surfaced warning, never routes to `fix`. Or fail only when the service booted at baseline (comparative) |
| C16 `MED` | "explore skipped whenever gates 1–6 are non-green" | Ambiguous: is `null` non-green? If yes, explore never runs anywhere. If no, it runs with no server | Define: explore runs iff every gate is `0` or `null` **and** `boot` is `0` |
| C17 `MED` | "parses the runner's report" | Five incompatible formats (JUnit/vitest/jest/playwright/mocha); N gates each with a `report:` but one `coverage` exit code; "passing" undefined per format (`test.skip` would parse as present); `report:` path base unspecified; `[AC-3]` free-match collides with any test *mentioning* it | Pick JUnit XML first; one report per project initially; define pass explicitly; resolve relative to the gate's repo; exact tag-prefix match. **No XML parser in the tree** — new dep or hand-rolled |
| C18 `MED` | `frozen_at` prevents drift | No FK, no `UNIQUE(ticket_id, ordinal)`, and freezing is **per row** — a later extraction can INSERT a new unfrozen row beside frozen ones and move the goalposts | FK + unique constraint + freeze the whole set, not rows |
| C19 `MED` | — | Zero criteria rows (sub-agent never dispatched) → coverage over an empty set **passes vacuously** | Empty set = `null`, not pass; surface "no criteria" in the UI |
| C20 `HIGH` | "adopt a hot stack" | `spinTicket` normally runs at *scope*, before implementation. A compiled service (Go, Java, built Next.js) adopted at UAT serves **pre-implementation code** — UAT declares criteria met by a binary predating the ticket | Freshness predicate: restart if HEAD moved since the server started. Needs `head_sha`/`started_at` on `servers` |
| C21 `MED` | — | `testDir` is project-level but repos are many; `e2e/karst/` resolves against nothing in a multi-repo ticket | Per-repo, or relative to each gate's `repo:` |
| C22 `LOW` | "review inherits a hot stack" | Review's `npm test` then runs against **bound ports**, breaking any suite that starts its own server | Decide explicitly; document |

### C9, C11–C15 — resolutions

**C14 + C15 are one bug.** Rev 2 wrote the per-gate null rule correctly, then let the *aggregate*
convert "nothing ran" into `passed`. One rule closes both: **`null` is not a pass at the aggregate
level either.** Every gate `null` → stage verdict `null` → `machine.ts` does not transition → the
driver parks needs-you. No new concept; that is what `Verdict = null` already means.

**C14 — and the premise was wrong.** The fix is not to remove `test` from UAT. The bug is that `test`
was UAT's **only** gate: `UAT_GATE` is singular, so UAT asked one question and another stage asked it
too. `npm test` is the conventional entry point and usually the cheapest suite, so it **stays in UAT,
first** — cheap-fails-fast is the entire argument for static-before-boot. Whether *review* keeps its
`test` gate is out of scope; the review stage is being rethought separately and `test` may leave from
that end.

Also: probe `package.json` when `uat.gates` is absent (`test`, `test:integration`, `e2e`, `test:e2e`,
`cypress`, `playwright`), so most repos need no config; an explicit list always wins. Genuinely nothing
to run → `null` → park, with a message naming the scripts karst looked for.

**C9 — the guard test's invariant changes.** "UAT never names `test`" was wrong, since `test` belongs in
UAT. The checkable property is **UAT's gate set is not a subset of review's** — UAT must ask at least one
question review does not. That survives review being rethought; a name ban would not. `UAT_GATE` becomes
a gate *list*, and `model/inside/gates.ts:1,113` is updated rather than left to break the build.

**C15 — a failed boot does not transition.** Port owned by another process (`startHot` throws by design),
30 s health timeout on a 45 s boot, `ENOENT` on the start command, a crash on a missing UAT secret (B1):
**none agent-fixable.** Rev 1 routed to `fix` (three wasted attempts, then a park); rev 2's `null` +
warning was worse, since nothing blocked and UAT reported **green on a stack that never came up**. Stage
verdict is `null`, no transition, no attempt consumed. Rejected: a comparative baseline predicate — needs
baseline state, does not help the common case.

**C11, C12, C13 — the `agents:` block, with a built-in default.** `manifest.agents?:
Record<string, AgentDef>` already exists (role-keyed), bodies are markdown under `agentsDir` (VS Code
setting `karst.agentsDir`, default `./.karst/agents`), and `readAgentFile`/`writeAgentFile`/
`agentStarterTemplate` plus the settings UI are already built. `uat-author` is one more role. No
configured agent → a shipped default prompt, so zero-config works and the role stays swappable.

Rejected: **approach artifact** (packages are *fetched from a declared external source*; karst authors
none, and synthesizing one means new code inside `assembleAndWrite` beside `assertPackageContributes`
and `sanitizeFrontmatter`); **`soloAgent`** (it is the agent for a `single-subagent`-approach ticket,
mutually exclusive with a real approach package); **a third `uat.author.agent` identity** (rev 1 cited
all three at once). C11 concerns *identity* only — the launch mechanism may share code with `soloAgent`.


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
