# UAT design — external review (codex)

> **HISTORICAL — external input, not normative.** `2026-07-29-uat-stage-design.md` (rev 5) is the design
> of record. This file is the fourth review of the UAT design, produced in the
> `codex-review-uat-design` worktree against feature commit `1e1b95a`, and is kept verbatim so the
> reasoning trail is auditable. **Do not implement from it.**

**How it was handled.** Every finding was verified against source before being folded. Of the 18 triaged
items: **16 confirmed**, 1 overstated (the claimed contradiction in B7's "secrets reach no artifact"
sentence — that clause is about artifacts, not process environment, though the underlying hazard was
real), and 1 right in substance but wrong in its reasoning (the "awaited request" network rule — the
reviewer's justification and the rule it replaced were both unimplementable, because Playwright exposes
no notion of awaitedness). Verification also surfaced a finding this review missed: `openDiff` has no
production implementation, which made four of the design's mitigations vacuous (P5).

Rev 4 of the spec folded these. Rev 5 then reversed several of them after four parallel reviews of rev 4.

**Where rev 5 diverges from this report, and why:**

| this report | rev 5 |
|---|---|
| §3 origin-aware migration for the `fixUat`/`fixReview` split | **moot.** Rev 5 withdraws the split: with both branches returning to `uat` it encoded nothing `gate_runs` did not already hold. `fix: { passed: 'uat' }`, no migration, no legacy-marker policy. |
| §2 route `fixReview → uat` **or** bind a source-tree digest | the first branch of that "or". The digest is deferred to Phase 2 with its preimage and key specified — as written it was unspecified, and its worked example was inverted. |
| §5 declarative action/assertion format, never JavaScript | **declined.** A format expressive enough for real e2e converges on Playwright's API with a worse debugger, and makes authored steps unrunnable by the repo's own suite. Rev 4 paired this rejection with a containment claim about route interception; **rev 5 withdraws that claim** — interception does not constrain a Node process — so the rejection now stands only on expressiveness and repo-runnability. |
| "Sandbox dependency": fail closed, no host fallback, until PR #25 proves isolation | **declined.** PR #25 is documentation-only, so this makes the feature unshippable for an unbounded period. Rev 5 ships on process/env containment and names the residual gap explicitly, including unrestricted process egress. |
| §7 effective-signal check parks `no-independent-signal` | correct, but **blocking only from Phase 2**. Its escape hatch is a dynamic target, and authored steps are Phase 2 — blocking in Phase 1 parks every zero-config repository, karst's own included, permanently. Phase 1 records a warning. |
| §17 exhaustion parks the fix branch in a persisted needs-user state | exhaustion needs no new state: the ticket rests at `fix`, which `ticketsToSweep` does not select. `attempts-exhausted` also fails three of the five properties that define `blocked`. |
| §4 CAS on project, stage, status, attempt, lease | correct and necessary, and **not sufficient**. The CAS constrains which *stage* a marker may name; nothing binds the invocation to the ticket it was launched for. `parseGlobalFlags` is last-wins and `resolveTicketByKey` falls back cross-project, so an injected agent fires a marker for another project's ticket in another window. Rev 5 adds a per-launch capability token as **P7**. |

**Where rev 5 follows it closely:** durable `blocked` + `StageRunResult` (§1), the `starting` servers row
(§6), multi-repository targets (§8), author lease with scratch-and-promote (§9), the cross-window lease
(§10), stage-wide `AbortSignal` with discriminated outcomes (§11), no hot-stack handoff (§12),
lifecycle-owned cleanup (§13), assertions-as-verdicts (§14), host-written `uat_briefs`/`uat_brief_reviews`
with the criteria CLI verb deleted (§15), one normative document plus a behaviour matrix (§18), the
untrusted-ticket extractor→verifier boundary, discriminated availability semantics, workspace-local
Playwright resolution, and `kind: command` un-cut. The "Artifact isolation" note anticipated rev 5's
three-directory split, which goes further: raw service logs and Playwright traces move out of the
directory a fix brief points an agent at, not merely into subdirectories of it.

---

# CODE REVIEW REPORT

- Verdict: **NEEDS REVISION**
- Blockers: 6 | High: 10 | Medium: 2
- Reviewed feature commit: `1e1b95a`
- Scope: `2026-07-29-uat-stage-design.md`, `2026-07-29-uat-review-triage.md`, and the current workflow/runtime seams they rely on

The review was read-only against the feature worktree. No tests were run because the proposed change is
still documentation-only and `npm test` performs a native-addon rebuild.

## Resolution addendum — 2026-07-30

The review findings were triaged with the project owner. The recommendations below are selected and
normative for the next design revision. They do not make feature commit `1e1b95a` implementation-ready:
the feature design must incorporate them first. No review-stage redesign is authorized by this ticket;
where the current design depended on changing review, the resolution stays inside UAT.

### Resulting pipeline

```text
impl marker
  -> acquire persisted ticket+stage run lease
  -> run repository-qualified static gates in a fresh UAT sandbox
  -> no-tools extractor creates a structured brief from raw ticket text
  -> independent no-tools verifier approves/rejects that exact brief hash
  -> boot the scoped UAT stack inside the sandbox
  -> for each declared target:
       isolated author writes declarative actions/assertions into scratch space
       Karst validates and atomically promotes the declarative specifications
       Karst-owned browser harness executes them and owns repo-qualified evidence
  -> tear down the UAT stack/sandbox
  -> transition to the existing review stage
```

`rejected`, `uncertain`, unavailable required capabilities, and operational failures park UAT in a
persisted blocked state. They do not create a verdict or consume a fix attempt. A code/assertion failure
transitions to `fixUat`; a successful `fixUat` re-enters UAT. A successful `fixReview` also re-enters UAT
because review fixes can change runtime behavior and invalidate earlier UAT evidence.

### Selected resolutions for this report

1. **Durable non-verdict parking.** Add a first-class persisted blocked gate state and a
   `StageRunResult = advanced | blocked | stopped` contract. A dedicated transaction records the run,
   evidence, blocker kind/reason, and run ID without calling `transition`, incrementing an attempt, or
   leaving the stage eligible for an automatic sweep. Resume is explicit.

2. **Review fixes invalidate UAT.** Change `fixReview.passed` to `uat`. Bind successful UAT evidence to a
   final source-tree digest as a concurrency/staleness guard; refuse the pass if the tree changes before
   commit. This changes the workflow graph, not the current review runner.

3. **Origin-aware versioned migration.** Use the next schema migration for the stage split. Seed
   `fixUat` and `fixReview`, classify active legacy `fix` tickets from deterministic failed-stage/gate
   evidence, update `stages` and `tickets.stage_current` atomically, and park ambiguous cases. Support a
   parser-only legacy marker only when the current persisted branch resolves it unambiguously.

4. **Marker and run authority.** Inside the transition transaction, compare-and-swap the ticket's
   project, current stage, stage status, attempt, and active run lease/generation before `premutate`.
   The narrowed CLI vocabulary remains, but argv cannot select a non-current stage.

5. **Declarative, independently executed acceptance tests.** The author emits a constrained data format,
   never JavaScript. A Karst-owned harness launches and owns the browser/context, allowed origins,
   assertions, telemetry, and artifact paths. Arbitrary repository Playwright remains ordinary repository
   code and cannot supply independent UAT evidence.

6. **Server recovery is a Phase 1 prerequisite.** Insert a `starting` server record with owner/generation
   immediately after spawn, change it to `running` only after health, clean handled failures, and reconcile
   stale owners. C2 is not deferred past runtime UAT.

7. **Effective independent signal.** Compare non-null `(repository, command, args)` identities that
   actually ran. If no UAT-specific signal ran and no dynamic target applies, park with
   `no-independent-signal`; declared but unavailable probes do not satisfy the invariant.

8. **Explicit multi-repository targets.** Add repository-named UAT targets with test/spec directory and
   base service. Reuse dependency-aware affected-target selection, deduplicate execution by `repoPath`,
   preserve repository-name service identities, and attach repository identity to every gate/artifact.
   Run one isolated author and Karst-owned harness invocation per declared target; aggregate their required
   results only after every target completes.

9. **Exclusive author ownership.** Acquire the durable UAT lease before authoring. Give the author
   read-only repository inputs and private scratch output; allow only declared specification paths,
   validate the result, then atomically promote it. No application/config write is accepted from the
   author.

10. **Cross-window lease.** Persist ticket+stage owner, generation, heartbeat, and expiry in SQLite.
    Evidence writes, parking, promotion, cleanup, and transitions require the same live lease. Recovery
    may expire only demonstrably stale owners.

11. **Stage-wide cancellation.** Use discriminated process outcomes (`completed`, `spawnFailed`,
    `timedOut`, `aborted`) and one `AbortSignal` through gates, spin/health, extractor, verifier, author,
    and browser harness. Abort records partial evidence if available, cleans resources owned by the run,
    and produces no verdict or attempt.

12. **No hot-stack handoff to review.** UAT tears down its stack and saves evidence before entering the
    unchanged review stage. A future review task may add an explicit respin/manual-acceptance workflow.

13. **Lifecycle-owned cleanup.** Remove ordinary session close as a teardown boundary. Clean up on UAT
    completion/failure/abort, explicit Stop, successful ship completion, archive-before-worktree-removal,
    and stale-owner recovery. Deactivation may eagerly clean only resources leased to that exact window.

14. **Explicit assertions are verdicts; telemetry is evidence.** The declarative format can name an
    expected response/status. Only declared assertions and harness execution status reduce to a verdict.
    Ambient HTTP, console, and network telemetry is advisory; no trace inference attempts to guess what a
    test "awaited."

15. **Host-owned brief/review persistence.** Add bounded append-only `uat_briefs` and
    `uat_brief_reviews` evidence with source hash, canonical brief hash, revision, model identity,
    structured findings, decision, and server timestamp. The host writes agent results; remove the
    free-form criteria CLI write verb. Any source/brief change requires a new verifier decision.

16. **One containment contract.** Validate every configured relative path with the existing
    safe-relative-path approach: reject absolute paths, empty/`.`/`..` segments, control characters, and
    separators where a filename is expected; resolve/realpath beneath the intended root and defend
    against symlink escape. Generate service-log filenames instead of using raw repository names.

17. **Independent attempt budgets.** `uat.maxFixAttempts` counts UAT failures only. Review retains its
    existing default budget until its separate redesign, but UAT and review counters cannot consume one
    another. Exhaustion parks the corresponding fix branch in the persisted needs-user state.

18. **One normative document.** The next design revision is normative. The triage is historical and must
    label superseded prescriptions. Add a behavior matrix covering unavailable/failed/aborted phases,
    crash/restart, non-runnable scope, shared `repoPath`, migration origins, pre-bump evidence, and lease
    loss.

### Additional decisions discovered during triage

These were not named findings in the original report. They are recorded separately so later work does
not mistake them for findings already present in `2026-07-29-uat-review-triage.md`.

- **Required dynamic lane.** When a runnable authoring target exists, the brief, verifier, author, browser
  capability, and executed declarative steps are required. Any unavailable component blocks UAT even if a
  static sibling gate passed.

- **Untrusted-ticket boundary.** Raw tracker text reaches only an isolated no-tools extractor. A separate
  fresh-context, no-tools verifier checks requirement coverage, scope, injected/meta instructions,
  destructive actions, allowed origins, and the exact brief hash. `rejected` or `uncertain` blocks for
  human review. The author receives only the verified canonical brief.

- **Sandbox dependency.** PR #25 supplies the intended sandbox substrate but is currently documentation
  only. Automated UAT must fail closed unless headless sandbox execution proves host/global-storage,
  credential, sibling-worktree, Docker-socket, symlink, and egress isolation. No host fallback is allowed.

- **Fresh UAT namespace.** Static gates and the later UAT stack run sequentially in a fresh ticket-specific
  sandbox/network namespace, isolated from scope-time, baseline, and other-ticket ports. Destroying the
  namespace is the ownership-safe fallback for daemonized services.

- **Consumer-scoped secrets.** Each secret names permitted service/gate consumers. Static gates receive
  none by default; extractor, verifier, author, and browser harness never receive backend secrets. A
  repository-declared, trusted authentication bootstrap may receive only auth-scoped secrets and returns
  a browser session capability/storage state.

- **Artifact isolation.** Use category and invocation directories:

  ```text
  artifacts/<ticket>/
    briefs/
    baselines/
    services/
    gates/<runId>/
    playwright/<runId>/test-results/
  ```

  A third-party runner may clean only its invocation directory. Retention is explicit and prior evidence
  is never overwritten by a fixed filename.

- **Availability semantics.** Discovered missing scripts are optional nulls. Explicitly configured gates
  are required. Malformed repository configuration is an agent-fixable failure; permission/runtime
  unavailability is blocked. Probe APIs return a discriminated result rather than collapsing every error
  to `{}`.

- **Graph-derived dispatch.** The driver uses `isBranch` and `isGate`, dispatches gate runners
  exhaustively, and has no catch-all "otherwise review" path. Host auto-resume accepts the derived branch
  identity and issues its exact marker.

- **Local harness resolution.** Do not invoke bare `npx playwright`, which may download an unpinned
  package. Resolve an installed, workspace-local supported Playwright runtime and preflight browser
  availability. Absence blocks a required dynamic lane. The Karst live-run config never inherits the
  repository's `webServer`; the repository's own config remains untouched for its ordinary suite.

- **Safe environment baselines.** Process-environment filtering uses tested platform-specific bootstrap
  allowlists, including Windows runtime variables required by `cmd.exe` and npm. Extra passthrough remains
  explicit and consumer-scoped.

- **Agent reference semantics.** A configured author references the unique `agents` map key; validation
  requires that entry to be enabled with role `uat-author`. Extractor and verifier use equally explicit
  keys or shipped isolated defaults.

- **Repository-agnostic commands.** Preserve Karst's non-Node scope by supporting explicit argv-based
  command gates without a shell, or typed package-manager runners. Cutting `kind: command` without an
  alternative would permanently block Go, Rust, Java, and other valid repositories.

- **Review evidence is deferred.** Remove the false claim that the production `runReview` path already
  opens and acknowledges the diff. This ticket does not change review. Briefs, verifier findings, DSL,
  hashes, and telemetry remain available evidence for its future redesign.

## Blockers

- `docs/superpowers/specs/2026-07-29-uat-stage-design.md:162` — **A null UAT result
  has no durable parking path.** The design says all-null gates and failed boot persist evidence, consume
  no attempt, and park needs-you. `transition(null)` throws before `premutate`
  (`src/workflow/machine.ts:55`); without a transition the driver rereads `stage_current='uat'` and
  immediately runs it again (`src/workflow/driver.ts:61`), including after the activation sweep
  (`src/extension.ts:1173`). The UI also has no persisted blocked-UAT state. Add a discriminated runner
  outcome and a separate transactional `parkGateStage` operation that appends pre-bump evidence, stores
  blocker kind/reason/run ID without transitioning or incrementing attempts, stops the driver, survives
  restart, and requires an explicit Resume to clear.

- `docs/superpowers/specs/2026-07-29-uat-stage-design.md:83` — **A review fix can still
  ship code that never passed UAT.** `fixReview: { passed: 'review' }` sends edited code directly back to
  review. Any lint/test repair can change runtime behavior, invalidating the earlier UAT evidence; review
  can then pass and ship that untested revision. This is the same stale-evidence class described at lines
  49–51. Route `fixReview` through `uat`, or bind every successful UAT invocation to a source-tree/HEAD
  digest and force UAT whenever that digest changed.

- `docs/superpowers/specs/2026-07-29-uat-stage-design.md:97` — **The fix-stage split
  has no safe migration or legacy-marker policy.** Every existing ticket already has a seeded `fix` row,
  active `fix` tickets may have come from UAT or review, stale timestamps affect startup derivation, and
  live pre-upgrade sessions contain `stage fix pass`. Seed both new rows for every ticket; classify active
  legacy fixes from the latest deterministic failed evidence, parking ambiguous cases for human choice;
  migrate `stage_current` atomically; and retain a parser-only legacy `fix` alias that resolves solely
  from the ticket's current branch. Add migration tests for every current stage, both fix origins,
  historical fixes, startup reconciliation, and an old marker command.

- `docs/superpowers/specs/2026-07-29-uat-stage-design.md:82` — **Marker vocabulary is
  narrowed, but marker authority is not bound to current state.** `runStageCommand` passes the
  agent-selected `from` stage to `transition` (`src/cli/stage.ts:96`), while `transition` never verifies
  that it equals the ticket's current running stage. With both `fixUat` and `fixReview` accepted, injected
  content can issue the other valid marker and bypass the required return path. In the same transaction,
  compare-and-swap on project, ticket, current stage, status, attempt, and a one-use run token. Prefer a
  capability bound to those values so argv does not select the ticket or stage.

- `docs/superpowers/specs/2026-07-29-uat-stage-design.md:251` — **Agent-authored
  JavaScript is not independent evidence, and the proposed process can reach secrets.** A Karst-owned
  Playwright config is not a sandbox: test code can create its own browser/context, disable or bypass
  capture, read files and environment variables, make arbitrary network calls, and alter artifacts. The
  same design applies UAT secret overlays at gate seams (line 506) and leaves unlisted real `.env` values
  available by default, contradicting the claim at lines 618–620 that secrets do not reach this path.
  Have Karst execute a constrained declarative action/assertion format in a restricted runner; keep
  service secrets and `HOME` credentials out of that runner; and treat arbitrary repo-authored
  Playwright code as advisory unless a human explicitly approves it as the gate.

- `docs/superpowers/specs/2026-07-29-uat-stage-design.md:681` — **Phase 1 depends on a
  server-recovery defect it explicitly defers.** `startHot` detaches the child before health, but inserts
  the `servers` row only after health passes (`src/runtime/supervisor.ts:98,153,176`). A host crash during
  the wait leaves a live process outside SQLite, which reconciliation cannot discover. Repeated UAT boot
  makes this a prerequisite, not a side issue. Insert a `starting` row with run owner and process identity
  immediately after spawn, update it to `running` after health, clean it on handled failure, and reconcile
  stale `starting` owners. Cover a simulated crash during health.

## High Priority

- `docs/superpowers/specs/2026-07-29-uat-stage-design.md:171` — **The independent-signal
  invariant is checked against declared names, not executed gates.** A repo defining only `test`
  (including Karst itself) records the proposed unique probes as null, so its actual UAT signal remains
  review's `test`. Explicit `uat.gates: [test]` also recreates the original defect. Compare effective,
  non-null gate identities `(repo, command, args)` at runtime and park with a configuration message when
  no UAT-specific question ran. Add a zero-config test-only repository case.

- `docs/superpowers/specs/2026-07-29-uat-stage-design.md:712` — **Multi-repository gate
  targeting is undefined.** The current UAT seam chooses `listWorktreesByTicket(...)[0]`
  (`src/extension.ts:1015`); the design adds an optional gate `repo` and per-repo `testDir` without saying
  which scoped worktrees receive default probing. Define a project-scoped `UatTargetPlan`, reuse/extract
  review's affected-target selection, deduplicate static execution by `repoPath`, preserve separate
  service entries for boot/ports, require `repo` when authored-step targeting is ambiguous, and include
  repository identity in gate evidence.

- `docs/superpowers/specs/2026-07-29-uat-stage-design.md:303` — **Authorship has no
  exclusive worktree/run ownership.** Gates currently may run while the implementation terminal remains
  open; Phase 2 adds a second writer to the same worktree after static gates have judged it. A partial or
  concurrent authoring run can change application code or leave files whose completion is known only
  from sidecar artifacts. Introduce an injected `UatAuthorRunner` with a durable ticket/run lease; author
  into scratch space; reject changes outside approved test/config paths; atomically promote validated
  files; and persist invocation, completion, and baseline hashes in SQLite.

- `src/workflow/driverController.ts:36` — **Single-flight is in-memory although the DB
  is shared across windows.** Two windows can activation-sweep the same project/ticket, run side effects
  concurrently, and both transition because no durable lease or current-stage CAS exists. Claim each
  stage invocation with an owner/run token and expiry/heartbeat in SQLite; require that token on evidence
  writes and transition/parking; expire only abandoned leases during recovery.

- `docs/superpowers/specs/2026-07-29-uat-stage-design.md:236` — **Stop cancellation is
  specified only for `runCommand`.** UAT also performs spin/health, Playwright, and an agent run;
  `RunHeadlessOpts` has no signal and `DriverController` stores only a Boolean. Give each driver run one
  `AbortController` and thread it through every phase. Cancellation must terminate owned process groups,
  clean only resources created by that run, record no verdict, and return a durable stopped/interrupted
  outcome.

- `docs/superpowers/specs/2026-07-29-uat-stage-design.md:691` — **The accepted hot-stack
  handoff conflicts with today's review gate.** The driver immediately chains UAT into review, review
  still runs `test`, and the design acknowledges that suites starting their own server will fail because
  UAT holds the ports. A known lifecycle-induced failure is not a valid deterministic verdict. Make the
  review rework a prerequisite, or suspend UAT-owned servers around self-hosting review suites and
  restore them for manual acceptance.

- `docs/superpowers/specs/2026-07-29-uat-stage-design.md:654` — **Teardown triggers
  race workflow ownership and lack window ownership.** Generic session close can occur while its callback
  starts UAT, and deactivation cannot safely reap from a global DB whose server rows do not identify the
  owning extension instance. Remove session close as a generic teardown trigger. Tie cleanup to explicit
  workflow/run events (Stop, completed ship, archive-before-worktree-removal), and use owner leases if
  deactivation reaps processes.

- `docs/superpowers/specs/2026-07-29-uat-stage-design.md:815` — **“The authored step
  awaited this failed request” is not derivable from normal Playwright traces.** `goto` and
  `waitForResponse` can resolve on HTTP 500 unless the test asserts status, while `requestfailed` means a
  transport failure. Make Playwright exit/assertion status the only step verdict and keep network/console
  telemetry advisory, or provide a Karst-owned fixture API that explicitly records required request IDs
  and expected outcomes. Test awaited/unawaited 500s, transport failures, navigation aborts, and console
  errors.

- `docs/superpowers/specs/2026-07-29-uat-stage-design.md:410` — **Advisory criteria
  have a write verb but no source of truth.** The design deletes `ticket_criteria` and its migration, then
  says the CLI appends rows and Karst records them. Choose a bounded append-only evidence table with
  server-side attempt/run attribution, or remove the CLI verb and write a versioned atomic per-run
  artifact through the extension host. Define idempotency, limits, restart behavior, and how review picks
  the latest complete extraction. Do not put free-form criteria in a generated shell command: receiver-side
  argv validation happens after shell expansion and cannot stop command injection.

- `docs/superpowers/specs/2026-07-29-uat-stage-design.md:298` — **New file paths lack a
  containment contract.** `testDir`, report paths, config hashes, service-log names, and
  `.git/info/exclude` entries can be influenced by manifest/repository values, but the design specifies no
  rejection of absolute paths, `..`, control characters, separators, or symlink escapes. Add one shared
  safe-relative-path validator and realpath containment resolver; use generated log filenames instead of
  raw repository names.

## Medium Priority

- `docs/superpowers/specs/2026-07-29-uat-stage-design.md:109` — **Retry semantics are
  contradictory and underspecified.** The text says budgets are independent, but only
  `uat.maxFixAttempts` is configured and exhaustion is described only at `fixUat`; current policy sums
  UAT and review failures. Define separate UAT/review budgets, the exact off-by-one meaning of `3`, and
  which branch parks. Test interleaved failures so one stage cannot consume the other's budget.

- `docs/superpowers/specs/2026-07-29-uat-review-triage.md:46` — **The triage remains
  implementation-ambiguous.** Historical “resolved” passages still conflict with rev 3 on
  short-circuiting, throwaway versus persisted authored steps, deleting versus retaining `test`, and
  frozen criteria. Mark the final design as normative and the triage as historical, or annotate every
  superseded prescription. Add an acceptance matrix for all-null, boot unavailable/failure, cancellation
  at each phase, crash/restart, non-runnable scope, shared `repoPath`, and pre-bump evidence.

## Good Practices

- The `fixUat`/`fixReview` split preserves a static verdict-keyed graph instead of introducing a dynamic
  remembered-origin edge.
- Aggregate all-null becoming null rather than pass is the correct no-inference interpretation.
- Append-only gate evidence and pre-bump attempt attribution remain explicit.
- Static gates run asynchronously before boot, preserving extension-host responsiveness and avoiding
  needless stack startup.
- Non-runnable repositories and shared monorepo paths are recognized as valid scope shapes.
- Acceptance-criteria extraction is advisory rather than an LLM-derived verdict.
- The proposed criteria command stays separate from the tightly narrowed stage-marker parser.
- The documents candidly name under-exploration, vacuous tests, fail-open environment coverage, and
  correlated human-review controls.
