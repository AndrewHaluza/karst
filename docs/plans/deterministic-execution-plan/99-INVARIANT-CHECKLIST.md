# Invariant Checklist — the High/Critical gate

This is the pass/fail gate. Before a slice is called done, every row whose "Gate" column names that slice must be **demonstrated by a named test**, not argued.

Each row names the defect class the three design reviews raised, the task that closes it, and the test that proves it. A row with no passing test is an open High finding regardless of how the code reads.

## A — Configuration integrity

| # | Invariant | Failure if absent | Task | Gate |
|---|---|---|---|---|
| A1 | A `graph:` block survives load → save → load byte-identically | `validateApproaches` drops unknown keys; the first Save destroys the user's whole configuration | S1/T2 | 1 |
| A2 | Every numeric limit is a finite safe integer in an explicit range; no coercion | `NaN`/fraction/overflow silently becomes a budget of 0 or ∞ | S1/T2 | 1 |
| A3 | Product hard ceilings cannot be raised by project config | a project grants itself unbounded spend | S1/T2 | 1 |
| A4 | `maxExpertRuns < maxReplans + 1` is a named load-time error | a graph that can never replan compiles and dies mid-run | S1/T2 | 1 |
| A5 | The built-in resolves through `withBuiltInApproaches` in exactly three consumers | enable/sync silently no-op with `Unknown approach` | S1/T3 | 1 |
| A6 | A disable tombstone carries the packaged `label` | a labelless entry **fails manifest load** for the whole project | S1/T3 | 1 |
| A7 | Settings Save writes a **delta**, never the merged effective object | Save resurrects the built-in into the manifest and reverts other tabs | S1/T3, S1/T6 | 1 |
| A8 | Analyzer may set the picker only when `!pickerTouched && approach === null`; `defaultApproach` rule unchanged | the built-in becomes a silent default or clobbers a user's pick | S1/T4 | 1 |
| A9 | The built-in ships `enabled: false` until Slice 3 | a ticket selects an approach whose runtime does not exist | S1/T1, S3/T12 | 1, 3 |
| A10 | A model without `efforts` accepts no effort; OpenCode `model`+`effort` refused at Save | an unsupported effort reaches the CLI or is silently discarded | S1/T5 | 1 |

## B — Durability and transactions

| # | Invariant | Failure if absent | Task | Gate |
|---|---|---|---|---|
| B1 | The graph migration is one `BEGIN IMMEDIATE` opened **before** reading `user_version` | an interrupted migration half-applies and the next open skips the rest | S2/T1 | 2 |
| B2 | `SCHEMA_VERSION` 34 → 35 and every hardcoded `user_version` assertion updated | tests pin a version the code no longer stamps | S2/T1 | 2 |
| B3 | Claim = one transaction with an **exact affected-row check** (1, or `\|waitFor\|`) | two windows launch the same node; double spend, double integration | S3/T1 | 3 |
| B4 | A join firing is all-or-nothing | a partially claimed join strands arrivals forever | S3/T4, S5/T4 | 3, 5 |
| B5 | END quiescence check + status flip are one transaction | a concurrent completion commits successors in between; the marker guard then refuses forever with no reopen path — the ticket is stuck | S3/T9 | 3 |
| B6 | Replan election is a conditional `active → draining`; only the winner counts | two planners run; two revision N+1s | S4/T5 | 4 |
| B7 | Exactly four token transitions; no `claimed → pending` | a retry creates a second logical visit and double-charges budget | S2/T2, S3/T1 | 2, 3 |
| B8 | Leases are durable DB rows with `UNIQUE(owner, domain)`, never an in-memory mutex | two windows integrate the same repository concurrently | S5/T2 | 5 |
| B9 | The active revision is derived, never stored | a stale pointer schedules a superseded revision | S2/T2 | 2 |
| B10 | Canonical bytes are authoritative on reload; fingerprint mismatch **blocks** | a silently recompiled graph executes topology nobody validated | S2/T4 | 2 |
| B11 | A committed completion is always eventually scheduled by the sweep | a lost wake-up strands the graph forever | S3/T2 | 3 |
| B12 | A contended `BEGIN IMMEDIATE` in the host aborts immediately | a synchronous wait blocks the shared extension-host event loop — every other session's hooks freeze | S3/T1 | 3 |

## C — Untrusted input

| # | Invariant | Failure if absent | Task | Gate |
|---|---|---|---|---|
| C1 | The graph parser rejects unknown fields, never ignores them | a future/forged field is silently accepted as policy | S2/T3 | 2 |
| C2 | Generated nodes cannot carry provider/model/effort | an LLM picks the model that spends the money | S2/T3, S2/T4 | 2 |
| C3 | `karst graph submit` and `karst node …` are parse paths separate from `stage` and from each other | a prompt-injected agent forges a stage marker or a node completion | S2/T6, S3/T5 | 2, 3 |
| C4 | No ticket/graph/node/destination/provider/capability/generation in argv; trailing argv rejected | argv becomes the injection channel | S2/T6, S3/T5 | 2, 3 |
| C5 | The capability hash is the sole authenticator; environment identity fields are untrusted claims | a forged environment authenticates itself | S2/T6 | 2 |
| C6 | Capability ≥256 bits, hash-only at rest, one-shot on the **first** mutating verb, rotated per launch attempt/generation | a leaked capability from a prior attempt stays live | S2/T6, S3/T5 | 2, 3 |
| C7 | No capability in argv, URLs, logs, diagnostics, artifacts, UI, or issue reports | the secret leaks through the report the user is encouraged to file | S2/T6, S6/T3 | 2, 6 |
| C8 | Loopback only, CSPRNG route token ≥128 bits, non-loopback origins rejected | any local page can drive the graph | S3/T2 | 3 |
| C9 | Wake-up rate limit covers **valid** requests too | the URL is inherited by every agent child; a valid flood is the realistic attack | S3/T2 | 3 |
| C10 | Agent prose reaches the next planner as a **file artifact**, never argv or a shell token | the repository's known shell-token interpolation failure class | S4/T5 | 4 |
| C11 | Agent reasons are capped, collapsed, prefixed `[agent-reported]`, never routing labels | self-report becomes routing | S3/T5 | 3 |
| C12 | `replan` requires observable lineage evidence, else it is `blocked` | an agent loops the planner at will on its own say-so | S3/T5 | 3 |
| C13 | Gate policies execute no JS/shell/SQL/regex/model-generated expression | arbitrary execution inside a "condition" | S3/T4 | 3 |
| C14 | Commands run without a shell, from a pinned absolute path and fixed argv, with a 4-name minimal env plus the project map | the planner injects shell operators or reads secrets from `process.env` | S3/T4 | 3 |

## D — Process and lifecycle

| # | Invariant | Failure if absent | Task | Gate |
|---|---|---|---|---|
| D1 | Owner nonce persists **before** spawn; identity immediately after | a crash between the two is indistinguishable from never-launched | S3/T3 | 3 |
| D2 | Termination requires positive evidence; terminal disposal is insufficient | a live agent is presumed dead and a second one launches beside it | S3/T3 | 3 |
| D3 | `killTree` return checked: `killed` / `denied` / `unknown` are three facts | a denied kill is recorded as stopped over a live process | S3/T3 | 3 |
| D4 | Attribution via `runtime/serverIdentity.ts` only; a pid is a recollection | a reissued pid gets an unrelated process tree killed | S3/T3 | 3 |
| D5 | `launch-unknown` / `termination-unknown` never auto-retry and never release leases | duplicate spend, or corruption from two writers | S3/T3 | 3 |
| D6 | "Discard unknown process" exists, is one transaction, releases budgets **and** lease, then re-evaluates | the permanent-stall class (REVIEW-1 C1/H4/H5) has no exit | S4/T4 | 4 |
| D7 | A `completing`/`integrating` node with a dead process **resumes**, never re-executes | duplicate spend and duplicate integration | S4/T3 | 4 |
| D8 | Graph sessions bypass `SessionManager`; it stays 1:1 and legacy-only | the 1:1 map silently drops a second node's session | S3/T3 | 3 |
| D9 | Every graph process registers in the `servers` registry | an archived ticket leaves detached processes holding a tree (869ed2n50) | S3/T3, S5/T1 | 3, 5 |
| D10 | All five entry-point matrix rows hold while a graph is active | Open or nudge launches a second agent beside the coordinator's | S3/T7 | 3 |
| D11 | Stop is coordinator-owned and moves the run to `draining`, never `blocked` | Stop reads as a fault, or reaches nothing at all | S3/T7 | 3 |
| D12 | Completion writes carry no window field | after a reload, the old window's agent — the legitimate owner — is locked out | S4/T3 | 4 |
| D13 | No `spawnSync` on any graph path | a repo script freezes the extension host | S3/T4 | 3 |

## E — Artifact and path safety

| # | Invariant | Failure if absent | Task | Gate |
|---|---|---|---|---|
| E1 | Validate-and-copy is one operation per file on **one descriptor**: `O_NOFOLLOW\|O_NONBLOCK`, `fstat` the fd, then read the fd; never re-resolve | classic TOCTOU: a symlink or FIFO swapped in after validation | S2/T7 | 2 |
| E2 | Reject non-regular files, link count > 1, oversize, media-type mismatch | a hardlinked or device file is snapshotted as evidence | S2/T7 | 2 |
| E3 | The planner process is terminated and proven dead **before** its submission snapshot | the planner rewrites its own submission after validation | S2/T7 | 2 |
| E4 | Artifact roots and workspaces live under global storage, outside every worktree | `ship`'s `git add -A` commits karst's scaffolding into a PR (869eck3gv) | S2/T7, S5/T1 | 2, 5 |
| E5 | Prompt bytes are snapshotted at run creation and hash-verified at launch | a repo-wide writer poisons the planner prompt before a replan | S2/T5 | 2 |
| E6 | Paths reject absolute, `..`, dot segments, and the Windows alias set (pure-string tests) | traversal out of the artifact root or repository root | S2/T3 | 2 |
| E7 | Required output staging destinations must be absent at launch | a stale file is accepted as this visit's output | S2/T7 | 2 |
| E8 | Consumers read only the recorded snapshot hash; the mutable path is never authoritative | evidence changes after it was judged | S2/T7 | 2 |
| E9 | `deleteTicket` removes graph rows **and** bytes; archive removes neither | either unbounded disk growth or evidence lost on a soft delete | S2/T8 | 2 |

## F — UI conformance

| # | Invariant | Task | Gate |
|---|---|---|---|
| F1 | Every host-posting control: local pending state, no re-trigger, terminal outcome, watchdog whose timeout reports **unknown** (UI-R11–R14) | S1/T6, S3/T11 | 1, 3 |
| F2 | `disabled` ≠ `aria-busy`; no `pointer-events:none` disabling; required explanation not `title`-only (UI-R17/R19) | S1/T6 | 1 |
| F3 | Actions are `<button>`, navigation is `<a href>`; icon-only controls have accessible names (UI-R09/R24) | S1/T6, S3/T11 | 1, 3 |
| F4 | Busy/result vocabularies are closed unions, never `string` (UI-R16) | S1/T6 | 1 |
| F5 | Agent core = canonical icon + canonical name, model/effort subordinate (UI-R10c) | S1/T6 | 1 |
| F6 | Destructive controls use the danger variant and name the risk — "Discard unknown process" (UI-R10b) | S4/T4 | 4 |
| F7 | Mirrored TS→HTML constants pinned; their tests pass untouched (UI-R34) | S1/T2, S1/T6 | 1 |
| F8 | Contrast verified in light, dark, high contrast (UI-R29) | S1/T6, S6/T4 | 1, 6 |
| F9 | Every graph-derived string escaped; ANSI and unsafe schemes stripped; CSP authoritative | S2/T10, S6/T4 | 2, 6 |

## G — Stage boundary

| # | Invariant | Failure if absent | Task | Gate |
|---|---|---|---|---|
| G1 | No graph module imports the stage machine; no graph event makes a `Verdict` | the graph starts advancing tickets | S3/T9 | 3 |
| G2 | Exactly three graph/stage surfaces, all in `workflow/graphMarkerGuard.ts` | the boundary erodes one call site at a time | S3/T9 | 3 |
| G3 | The IMPL marker is impossible before `completed-awaiting-impl-marker` and closes exactly once | a ticket reports implemented while nodes still run | S3/T9 | 3 |
| G4 | Graph seeds contain no marker instruction and no `cliStagePrefix` | an agent is told to run a command the CLI refuses (869edna84 class) | S3/T6 | 3 |
| G5 | `resumeBlockedStage` refuses to clear `approach-graph-failed` and returns the typed recovery action; every caller updated | the generic Resume clears a graph block and strands the run | S3/T9 | 3 |
| G6 | `approach-graph-failed` has an explicit case in every `BlockerKind` consumer | a blocked graph is invisible on the board | S3/T9 | 3 |
| G7 | Stage blocks are written through `store/stageBlocks.ts`, never a direct `UPDATE stages` | the stage-scoped refusal after leaving `impl` is bypassed | S3/T9 | 3 |
| G8 | Graph tickets write no `phase_marks` | evidence lands in a table that cannot express revisions or visits | S3/T6 | 3 |

## H — Accounting

| # | Invariant | Failure if absent | Task | Gate |
|---|---|---|---|---|
| H1 | Every graph launch opens a `process_runs` row | interactive usage is unrecordable (`process_run_id` is NOT NULL) | S3/T10 | 3 |
| H2 | Exactly two new call sites: `graph-planner`, `graph-node`; node identity in FK columns | the closed call-site set becomes unbounded | S3/T10 | 3 |
| H3 | Unreportable usage records `unknown`, never 0 | a fabricated zero reads as a free call | S3/T10, S6/T2 | 3, 6 |
| H4 | No prompt or completion text stored anywhere | the ledger becomes a transcript store | S3/T10 | 3 |
| H5 | The usage store write is wrapped and swallowed | a locked DB fails a launch | S3/T10 | 3 |
| H6 | `token_usage` graph FKs are `ON DELETE SET NULL` | deleting graph history deletes spend | S2/T1 | 2 |

## I — Recovery has an exit

| # | Invariant | Task | Gate |
|---|---|---|---|
| I1 | Every recoverable blocker kind maps to exactly one prescribed recovery action | S4/T6 | 4 |
| I2 | A retry does not re-snapshot the prompt; an explicit prompt Resume does | S4/T6 | 4 |
| I3 | Recovery claims atomically and clears the stage block only after durably entering a recoverable state | S3/T9 | 3 |
| I4 | Budget exhaustion blocks, never routes; an exhausted `maxReplans` refuses election and blocks the reporting node | S4/T1, S4/T5 | 4 |
| I5 | `graph-topology-deadlock` is reachable, named, and leads to replan — never silent quiescence | S2/T4, S4/T4 | 2, 4 |
| I6 | A node override write after claiming fails its CAS; overrides never cross a revision | S4/T6 | 4 |
| I7 | `failed-to-launch`, `blocked`, and `stale` are rest states with exactly two exits each (`→ launching` on recovery, `→ cancelled` on drain); only `completed`/`cancelled` are terminal. Without them "retry the same reserved visit" has no legal transition and the node is unrecoverable | S2/T2, S4/T6 | 2, 4 |
| I8 | `completed-awaiting-impl-marker → cancelled` exists for a ticket that leaves `impl` before the marker fires — a quiescent run must not stay marker-eligible | S2/T2, S3/T9 | 2, 3 |

## J — Parallel safety

| # | Invariant | Failure if absent | Task | Gate |
|---|---|---|---|---|
| J1 | Writers never share a mutable workspace or writable Git metadata | index/ref corruption between two concurrent agents | S5/T1 | 5 |
| J2 | Physical domains keyed by canonical realpath + Git common dir, never repository name | two entries sharing one `repoPath` are treated as independent | S5/T2, S5/T3 | 5 |
| J3 | Actual diffs are validated against declared writes before integration | a node silently widens its claim | S5/T5 | 5 |
| J4 | An integration conflict preserves both trees, blocks, and never routes `complete` | work lost, or a conflict reported as success | S5/T5 | 5 |
| J5 | Deferral reasons are persisted and shown | deliberate serialization reads as a scheduler defect | S5/T3 | 5 |
| J6 | Bounded aging prevents starvation of wide-claim nodes | a loop starves the node that needs the whole repository | S5/T3 | 5 |
| J7 | A dependency-waiting node is never reported as resource-blocked | a false diagnosis sends the user to fix the wrong thing | S5/T3 | 5 |
| J8 | `maxParallel > 1` only after workspaces, leases, and lineage exist | the corruption class this slice prevents | S5/T7 | 5 |
| J9 | Join correlation matches full lineage stack **and** fork visit number | two loop iterations cross-correlate | S5/T4 | 5 |

## K — Observability leaks nothing

| # | Invariant | Task | Gate |
|---|---|---|---|
| K1 | Diagnostics carry closed categories and bounded keys; agent prose is bounded before logging | S6/T3 | 6 |
| K2 | No capability, prompt body, secret, or unredacted command output in any log, diagnostic, or issue report | S6/T3 | 6 |
| K3 | Host-agnostic modules receive `debug` as an injected callback, never importing the logger | S6/T3 | 6 |
| K4 | Slice 6 changes no scheduler semantics (empty coordinator/marker diff) | S6 verification | 6 |
| K5 | Command logs are sensitive evidence, excluded from issue reports and unrelated node context | S3/T4 | 3 |

## Sign-off procedure per slice

1. Run `npm run typecheck && npm test && npm run build`.
2. For every checklist row gated on this slice, name the test file and test title that proves it. A row without one is an open High finding.
3. Confirm no pre-existing non-graph test was modified, except where a task explicitly extends one.
4. Confirm the cross-slice invariants in `00-ROADMAP.md` still hold — in particular that no later slice weakened an earlier slice's stage, project, capability, artifact, transaction, lease, workspace-location, or capability-rotation invariant.
5. Record the sign-off (slice, date, commit range, checklist rows with their proving tests) in `docs/plans/deterministic-execution-plan/sign-off/<slice>.md`.
