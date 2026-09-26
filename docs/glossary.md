# Karst Glossary

A living, alphabetical-per-section glossary of the terms Karst uses for its
functionalities and the elements it manages. Read it like a map: every entry is
one concept, defined in one breath, with cross-references to its neighbors.

**Source of truth.** This document describes behavior, it does not set it. When
a definition here disagrees with the code, the code wins and this file is a
bug — report it. The closed vocabularies (stage keys, verdicts, blocker kinds,
agent states, hook events) are defined once in `src/model/types.ts` and
`src/hooks/dispatch.ts`; anything not in those lists does not exist.

---

## Core entities

- **Ticket** — the unit of work. A title (identity), a key, an optional type,
  an optional prompt, a resolved approach, an optional model override, and a
  project-scoped set of stage rows. Lives in the SQLite store; the board is
  re-derived from it on reopen. See *Project*, *Stage*, *Key*.
- **Project** — the scope boundary between IDE windows. Identity is
  `projects.slug`, from the manifest `id:` or a path-derived fallback. Every
  ticket query is scoped by `project_id`, because the database lives in global
  storage shared by every window. A ticket key is unique *per project*, not
  globally. See *Global storage*.
- **Manifest (`karst.yml`)** — the stack description: repositories, optional
  services, approaches, agents, gates, conventions, ticketing. Resolved by the
  `karst.manifestPath` setting (default `.karst/karst.yml`). Validated when it
  loads; loading never writes. See the *Manifest reference* section.
- **Repository** — a git repo Karst can worktree, scope to a ticket, classify
  and ship. The primary entity of the manifest; two entries may share a
  `repoPath` (a monorepo with several runnable processes — they resolve to one
  worktree). See *Service*, *Worktree*.
- **Service** — an *optional* relation on a repository describing how to *run*
  it (`start`, `health`, `ports`, `dependsOn`). A repo with no `service:` is
  fully first-class: it gets a worktree, is never started, and owns no port.
- **Worktree** — a git worktree per hot repo under `.karst/worktrees/<slug>`,
  cut at Spin from the base ref. The slug is per-ticket (key-or-id + title), so
  entries sharing a `repoPath` intentionally share one worktree. Its branch is
  rendered once at creation; the `worktrees` row is authoritative forever after.
  See *Branch*, *Spin*.
- **Base ref / `baselineBranch`** — the branch every worktree is created off,
  baseline services run from, and pull requests target. The base is pulled
  before a worktree is cut (`git fetch origin <base>:<base>`), a switch that is
  on by default and never blocks creation on failure. `base_ref` records the
  plain branch name; consumers re-derive `origin/<base>` themselves.
- **Port** — a slot on a repository's service, allocated from the manifest's
  inclusive `portRange` (default `[4000, 4100]`) for ticket-hot services.
  Baseline services use each port slot's `default` value. Port allocation and
  the `servers` table are keyed by repository *name*, not `repoPath`.

---

## Ticket lifecycle — the stage machine

- **Stage** — a node of the stage graph and a row in `stages`, keyed
  `(ticket_id, stage_key)` with a status, an attempt counter, a verdict, block
  columns and timing. A retry overwrites the row; prior evidence survives in
  `gate_runs` (see *Evidence*). Stage + `stage_current` move in one transaction.
- **Stage key** — the closed set `scope · impl · uat · review · fix · ship ·
  done` (`STAGE_KEYS`, `src/model/types.ts`). There is no `merge` stage and no
  `fetch` stage. See *Stage graph*.
- **Stage graph** — the verdict-keyed transition table (`STAGE_GRAPH`,
  `src/workflow/graph.ts`), a graph not a line:
  `scope ─pass→ impl ─pass→ uat ─pass→ review ─pass→ ship ─pass→ done`, with
  `uat/review ─fail→ fix ─pass→ uat`. `fix` is a *return channel* (reached only
  by a failed verdict), never a step on the forward path. A missing edge
  throws — an unknown verdict is never silently ignored.
- **Verdict** — the transition currency:
  `{kind:'passed'} | {kind:'failed'; reason?} | null`. `null` (no verdict yet)
  never transitions — the no-inference guarantee. `failed` means the code is
  wrong and an agent can act; a *block* is the other kind of non-passing
  outcome. Verdicts are deterministic (exit codes, merge state), never agent
  self-reports — except the explicit done markers, see *Marker*.
- **Transition** — moving a ticket from one stage to the next, fired by a
  definite verdict. Gate verdicts commit inside `commitGateOutcome`'s single
  transaction; a throw leaves the ticket exactly where it was.
- **Marker** — the one thing an agent may self-report: `stage impl pass` /
  `stage fix pass` through the CLI. `MARKER_STAGES` is `['impl', 'fix']` — a
  gate stage's verdict must come from an exit code, never from the agent. The
  seed carries a marker instruction only when the current stage has one
  (`markerStageFor`); at any other stage no marker is seeded at all.
- **Confirm stage** — a stage that does not start itself: reaching it parks the
  ticket until a human acts (`CONFIRM_STAGES = ['ship']`). Ship waits for the
  dashboard's "Confirm ship" click. See *Needs you*.
- **Gate stage** — a stage whose `failed` verdict routes into the fix loop:
  `uat` and `review` (`GATE_STAGES`).
- **Fix loop** — a UAT or review failure parks the ticket at `fix`; a fix pass
  re-enters `uat` (every fix is unvalidated code, whichever gate failed).
  Budgeted by `uat.maxFixAttempts` / `review.maxFixAttempts`; exhausting the
  budget parks the ticket at `fix` with nothing to resume.
- **Stage status** — `pending · running · passed · failed · skipped` on the
  stage row. A passed row with a null `ended_at` reads as still running. A
  parked stage is stamped `ended_at` like any other passed stage.
- **Stage run** — one invocation of a stage's work. `StageRunResult` is
  `advanced | blocked | stopped`; `blocked` and `stopped` are *not* verdicts and
  never transition. See *Stage driver*, *Block*.
- **Stage driver** — `workflow/driveTicket.ts`, the host seam that owns the
  `StageRunResult` branching, the fix-resume decision, and one `AbortController`
  per run. A runner's `blocked` is passed to the driver verbatim, never
  re-wrapped as `advanced` at the ticket's unchanged stage.
- **Attempt** — the retry counter on a stage row. Bumped only on the failed
  branch (`review-fail → fix → review-pass` files two invocations under one
  attempt). `gate_runs.run_at` groups one invocation's rows.

---

## Blocks & holds

- **Block** — karst saying it could *not ask* the stage's question: an
  environmental stop, distinct from a `failed` verdict. Stored as
  `blocked_kind` / `blocked_reason` / `blocked_at` on the stage row
  (`store/stageBlocks.ts`). NULL kind = not blocked. See *BlockerKind*,
  *Resume*.
- **BlockerKind** — the closed union (`src/model/types.ts`):
  `nothing-to-run · capability-missing · no-independent-signal · boot-failed ·
  lease-lost · awaiting-merge · unmapped-repository`. Members other than
  `awaiting-merge`/`unmapped-repository` mean "karst could not ask, retry it".
- **Nothing-to-run** — every gate returned no question (and none was disabled):
  karst could not ask. Parks, never passes — "asked nothing" is never green.
- **Bypassed** — every gate on a stage (uat/review) was disabled for this one
  ticket. The stage does not gate and the pipeline continues, but the outcome is
  `bypassed` (`model/types.ts`), never `passed`: nothing was proven. Rendered
  with its own `⊘` marker, distinct from a green pass; not a park, and not a
  gate pass.
- **Capability-missing** — a gate could not run: missing binary, permission/IO
  error, missing Playwright/auth digest.
- **No-independent-signal** — review's R7: a review whose gates ask nothing UAT
  didn't already ask added no signal and *fails* to `fix` when
  `review.requireIndependentSignal` is on (default). UAT's own overlap check is
  a warning, not a failure.
- **Boot-failed / lease-lost** — service boot or process-lease failures during
  gate execution.
- **Awaiting-merge** — the one blocker that does *not* mean "karst could not
  ask": ship opened its PRs and the answer was "not yet". The ticket parks at
  `ship` until every PR it opened reads merged upstream (or it had nothing to
  merge). The one block *Resume* may not clear — clearing it strands the
  ticket, because the merge gate needs exactly that block to tell "waiting to
  land" from "parked pending the first confirm click".
- **Unmapped-repository** — a worktree whose `repo` matched no
  `repositories:` entry. Not a retry failure: only editing `karst.yml` or
  re-scoping helps, so the block stays resumable.
- **Resume** — the dashboard/CLI action that retries a blocked stage by
  clearing its block and re-running. It clears every blocker kind except
  `awaiting-merge` (see above).
- **Needs you** — the amber signal: a ticket waiting on a human. Read from
  `agent_state = 'waiting'` (a pending permission ask) *or* from a
  pending-confirm stage *or* from the `awaiting-merge` block — `needsUser`
  (`model/ticketGlyph.ts`) folds all three, so the glyph, badge, sidebar facet,
  status bar and rail turn amber at once. A conflict is a wording difference,
  never a state one.

---

## Gates & evidence

- **Gate** — one deterministic question asked of the worktree: a *script* gate
  (`kind: script`, a package.json script name) or a *command* gate
  (`kind: command`, argv-based, spawned without a shell — what keeps UAT usable
  from Go/Rust/Java/Python repos). Gates are declared per stage under `uat.gates`
  / `review.gates`; per-repository gate lists *replace* the global list for that
  repo, never add to it.
- **Gate run** — one execution of a gate: an append-only `gate_runs` row written
  the moment the gate finishes, with the gate's timing and index. Never batched
  to the end of a target — a host that dies mid-run keeps every gate that
  finished. `run_at` groups one invocation.
- **Evidence** — the append-only records (`gate_runs`, `phase_marks`,
  `review_findings`, `uat_findings`) that survive a stage-row overwrite. Written
  *when it happens*, inside the transaction that commits with the stage outcome.
  See *Stage run*.
- **Stage run record** — `stage_runs` (v25): one row opened before a run's first
  gate, marked `stale` when superseded or when the activation sweep finds a dead
  pid. Exists to resolve the never-started / in-flight / destroyed ambiguity a
  host death would otherwise leave.
- **Disabled gate** — a gate switched off *for one ticket* (`tickets.disabled_gates`,
  `{uat:[...], review:[...]}`). Applied to resolution's *output* only; resolution
  itself never sees it. A disabled gate is still recorded: one `gate_runs` row
  with `skipped = 1` and no exit code — a different fact from `exit_code IS
  NULL` ("the repo defines no such script"), and never folded into it. When
  *every* gate of a stage is disabled the stage is **Bypassed** (see above):
  the pipeline continues, but the stage records `bypassed`, not `passed`.
- **Probe pipeline** — the default gate discovery: karst looks for known
  package.json scripts (`test` for UAT; `lint`/`typecheck`/`build`/`format` for
  review) and runs whichever exist. A repo that defines no such script is "no
  question asked", not a pass.
- **Independent signal** — see *No-independent-signal*.
- **Tester & testerVerifier** — UAT's optional deterministic verification
  command run after the required gates pass. Its exit code is the sole
  Tester-specific verdict: 0 completes the Tester; a completed nonzero exit
  fails UAT (one Fix round); a command that cannot run parks without spending a
  round. Absent → the Tester's observations are advisory and the gates decide
  alone.
- **Findings lane** — review's Phase-2 agent lane: an agent reviews the diff and
  files findings, persisted per target as each lane call returns
  (`review_findings`). Critical/high findings fail review to `fix` per
  `review.findings.blockingSeverity`; `enabled: false` turns the lane off.
- **maxFixAttempts** — the per-stage fix budget (`uat.maxFixAttempts` narrows
  UAT only; review has its own). See *Fix loop*.

---

## Agents & sessions

- **Agent provider** — the agent core: `claude · codex · antigravity ·
  opencode` (`IMPLEMENTED_PROVIDERS`). Resolved per ticket: `tickets.model`
  overrides the manifest `defaultModel`; `resolveModel` is the precedence rule;
  the resolved value goes to the adapter as `--model`.
- **Adapter (`AgentAdapter`)** — the seam every agent call goes through:
  interactive session, headless stage run, PR description. Only the adapter
  knows how to translate a launch into a concrete agent's format; a second
  agent core is a config swap, not a rewrite. Every AI invocation is wrapped by
  the instrumented adapter (see *Token usage*).
- **Headless run** — a non-interactive agent invocation (gate lanes, PR
  description, suggestions), spawned by ONE spawner (`agent/headlessSpawn.ts`):
  detached group, 15-minute backstop timeout, kill via `killTree` on abort or
  timeout, stdout/stderr drained into a bounded buffer (8 MB) instead of
  unbounded concat. A killed run's late `close` never reads as a clean exit.
- **Session** — an interactive agent terminal bound to a ticket and a worktree,
  tagged with `KARST_TICKET_ID` / `KARST_LAUNCH_ID`. Its seed carries the
  ticket context and, when the current stage has one, the done-marker
  instruction (see *Marker*).
- **Launch / resume** — opening a new session vs. re-attaching a running one
  (`--resume`). A VS Code reload does not kill the agent; the adoption scan and
  *nudge* re-identify the still-running session by its terminal's pid.
- **Terminal identity** — how a reattached terminal is recognized after a
  reload, when VS Code gives back no env: the pid captured at creation,
  persisted per window in workspaceState. Env always wins over a record; a
  record dies with its terminal. Terminal *names* are unusable — an agent CLI
  rewrites them with OSC sequences.
- **Nudge** — the "is the agent still there?" probe. It adopts a revived
  session rather than reporting "no session" — never launching a second agent
  beside a live one — and, on the nudge path, never reveals the terminal.
- **Fix session / conflict session** — purpose-built sessions: the fix session
  carries the failed gate's evidence and seeds `stage fix pass`; the conflict
  session opens at the conflicting worktree with the conflict brief.
- **Agent state** — the liveness signal on a ticket: `running · waiting ·
  idle · none`, driven ONLY by hooks, orthogonal to stage status. `waiting` is
  the needs-you amber signal and never comes from stage state. See *Hook
  event*, *Needs you*.
- **Interactive usage** — token usage measured while a live provider session
  runs. Codex and opencode post `UsageUpdate` events from their bridges;
  claude's interactive usage is read from Claude Code's session transcript
  (claudeTranscriptWatch.ts); antigravity's is read from its conversation DB
  (agyUsageWatch.ts). Every implemented provider is now measured; a missing
  fact is never rendered as a zero.

---

## Hooks

- **Hook endpoint** — the local HTTP endpoint (one per window, ephemeral port)
  that agent hooks post JSON to. A bridge script or generated plugin per
  provider translates agent lifecycle into the shared vocabulary. All gate
  commands go through async spawn so the extension host's event loop never
  blocks on a running hook.
- **Hook event** — a normalized lifecycle event: `SessionStart`, `SessionEnd`,
  `Stop`, `Notification`, `UserPromptSubmit`, `PostToolUse` (plus the
  normalized `permission.asked`/`permission.replied`, `session.idle` and
  `session.status` from the opencode plugin). Mapped to `agent_state` by
  `nextAgentState` in `src/hooks/dispatch.ts`; a stage transition is NEVER
  inferred from a hook. The opencode plugin normalizes `session.created` to
  `SessionStart` too — that is what confirms a closed-session fix launch's
  pending intent (`confirmFixLaunch`); without it the recovery round stays
  `pending`, never `fixing`, and the stranded-fix sweep parks the fix stage.
  opencode posts no `PostToolUse`/`UserPromptSubmit`, so
  its resolution and status events are the only signals that flip a
  `permission.asked` amber back to `running` — without them one answered
  prompt left the ticket reading "Needs you" for the whole remaining turn.
- **Notification** — the agent's "blocked on the user" envelope. The kind lives
  in `notification_type` (`permission_prompt`, `idle_prompt`,
  `agent_needs_input`, `elicitation_dialog` — the `WAITING_NOTIFICATION_TYPES`
  set); the `message` field is human-readable prose and is NOT a stable
  identifier. Keying the amber signal off `message` was the "Needs you" bug.
- **Generation barrier / launchId** — the endpoint only admits hooks from the
  generation (launch) it knows; a revived session's hooks rebind to the live
  endpoint through the `current-endpoint` file when its launch-time URL is gone.
- **UsageUpdate** — the provider-supplied usage event of a closed session,
  narrowed by `normalizeInteractiveUsage` before it touches the store. Not a
  liveness signal; it never re-kicks the stage driver.

---

## Approaches & materialization

- **Approach** — a development methodology the ticket form offers (rpi, GSD,
  superpowers TDD, direct, …). Each has a label, description, an entrypoint and
  an optional install source. `enabled` is slaved to what is on disk.
- **Approach package** — the neutral, structure-preserving result of an
  install: classified `agents/`, `commands/`, `skills/<name>/` artifacts plus a
  flat `prompts/` fallback, recorded in `approach.yml` as
  `ApproachArtifact {kind, relPath}`. Agent-agnostic; only the adapter
  translates it to a concrete agent's format at launch.
- **Entrypoint** — a bare name (no `.md`) that must resolve against what was
  collected — a skill folder name, an agent/command basename, or a flat prompt
  basename — or install fails loudly (never a silent bare launch).
- **Source** — where an approach is fetched from: `git` (fetches files
  structure-preserving) or `npm` (runs the bin in a temp cwd). A package that
  collects no prompts AND no artifacts AND declares no workflow is rejected at
  install (`assertPackageContributes`) — a misconfigured approach must not
  install "clean" and fail only at launch.
- **Install / uninstall** — install fetches, validates, then REPLACES the
  package dir (never overlays — a reinstall lands the source's current contents
  and nothing else). Uninstall removes the package dir, every ticket reference
  to it (`clearApproachFromTickets`) and the flag; deleting the manifest entry
  is a separate act.
- **Materialization** — the adapter's job at launch: turn the neutral package
  into agent-specific `extraArgs` (Claude builds a plugin dir + `--plugin-dir`
  — the only place the plugin format exists). Written at stable, predictable
  paths returned as `ownedPaths`, which session close cleans up. An adapter may
  only own a path it CREATED: a pre-existing directory belongs to the
  repository and is never written into or claimed.
- **Sanitization** — `sanitizeFrontmatter` strips dangerous permission
  frontmatter (`permissionMode: bypassPermissions`, `allowed-tools`,
  `dangerously-*`) from every fetched body at install; karst's `--settings`
  stays the sole permission authority.

---

## Shipping, PRs & merge

- **Ship** — the stage that opens one PR per hot repo via `gh` and ends where
  the PRs exist — NOT where the work landed. A confirm stage: it never opens a
  PR on its own. A ticket whose work produced no diff opens no PR and passes
  straight through (`nothing-to-merge` is a genuine pass).
- **Fallback commit** — the commit ship creates when a worktree is dirty
  (`commitAllIfDirty`, a plain `git add -A` — which is why karst's own
  generated paths are excluded from git by construction). Commits made by an
  agent or user are never rewritten.
- **PR (pull request)** — karst opens one per hot repo via `gh` with the
  rendered conventions; an already-open PR adopted during ship is never
  retitled or rewritten. `prs` rows are current state, re-probed by
  `gh pr view --json` — `status` is `open`/`closed`/`merged` plus the dropped
  `unknown`, and `merged_at` can never be un-set.
- **Current PR** — the live answer per repo (`CURRENT_PR_ORDER`): a repo
  re-shipped after a merge holds both rows, and the stale merged one must never
  answer for a branch still open.
- **Merge check** — the mergeability verdict for one repo's current PR:
  `clean · conflicted · unknown` (`merge_checks`), computed by probing
  `git merge-tree --write-tree --name-only` (whose output is a parsed format,
  not what it looks like). Read-filtered on `PR_NOT_MERGED` — a merged PR ends
  its repo's merge check, enforced on read, never deleted on transition.
- **Merge gate** — the whole landing decision (`workflow/mergeGate.ts`): a READ
  over state karst already keeps current, plus at most one transition. Ship's
  tail uses `resolveShipLanding` (entitled to trust `nothing-to-merge`); the
  background sweep uses `settleShipGate`, which requires the `awaiting-merge`
  block to already be present so a freshly parked ticket is never walked
  straight to `done`.
- **PR sweep** — the background pass that notices a merge a teammate did on
  GitHub — the only path that can see that one — and settles the ship gate.
  Rides the PR sync sweep in `extension.ts`.
- **Merge action** — the per-repo Merge click: `gh pr merge` with an explicit
  method (never bare, never `--delete-branch`/`--auto`), then re-reads the PR.
  The re-probe is trusted, not the exit code; the webview can neither pick a
  strategy nor skip the confirmation of an irreversible action.
- **Conflict brief** — the report a conflict generates for the agent
  (conflicting paths from the merge probe, rendered for the fix session); a
  conflict is never a `failed` verdict — only a human rebase can resolve it.
- **`done` means merged** — done is reached only when every PR the ticket
  opened reads merged upstream (or nothing was opened). A ticket whose PRs are
  open parks at ship with an `awaiting-merge` block, reading *Needs you*.
- **Dismissed PR** — a pull request a human declared will never land
  (`prs.dismissed_at`, v56; `workflow/dismissPr.ts`). The escape hatch for a
  PR CLOSED without merging, which can never satisfy "done means merged" and
  would otherwise park the ticket at ship forever. Dropped from the merge
  gate's read — never counted as merged — and reversible from the same PR row.

---

## Worktrees, servers & runtime

- **Spin** — creating a ticket's live environment: cut worktrees per hot repo,
  allocate ports, overlay env + secrets, spawn hot services and health-gate
  them. Baseline services are pooled and shared (see *Baseline pool*).
- **Hot repo / baseline repo** — a repository the ticket touches (worktree +
  own servers) vs. one it does not (shared, run once, pooled). The partition is
  made at spin and re-derived on boot.
- **Baseline pool** — baseline services shared across tickets, each keyed to
  its repository checkout. A server serving a deleted tree is wrong in every
  window — the reap is global, and baseline servers (`ticket_id IS NULL`) are
  exempt from it.
- **Server** — a spawned `start` process with a health URL that must become
  reachable. Spawned `detached` (own process group, no controlling tty) so a
  kill reaches the whole tree; recorded with the pid AND `servers.cwd` (v21) —
  NULL means unknown and is never reaped on a guess.
- **Health check** — the gate between "spawned" and "up": the `health` URL must
  answer before spin proceeds. `started_at` is captured the moment the pid is
  obtained, not at the INSERT — recording the later moment would skew every
  server-identity comparison by the health-check duration.
- **Reap** — the activation sweep that kills servers serving removed worktrees
  (`reapStaleServers`), the net for removals karst did not perform. Every kill
  is attributed first (see *Server identity*); `outcome` states what actually
  happened — `killed`, `row-cleared`, `kill-failed` — never the intent.
- **Server identity** — proving a recorded pid is the process it claims to be
  before `killTree` signals the process GROUP: the live process's own cwd
  (Linux `/proc/<pid>/cwd`, canonicalized on both sides), else its own start
  time via `ps -o lstart=` within a tolerance. `dead`/`foreign`/`unknown` all
  clear the row without killing; only `attributable` kills. A denied kill
  leaves the row truthfully `running`.
- **removeWorktree** — the single choke point for worktree removal (archive,
  bulk archive, spin teardown). `stopServersUnder` runs there FIRST — a
  worktree is never removed out from under the servers running inside it.
- **Archive** — soft-deleting a ticket and removing its worktrees (with server
  reaping). Done tickets are auto-archived after `archiveDoneAfterDays`
  (default 3, sweep-driven, never immediate). Archive slugs derive from the
  worktree path basename; restore lands back on `row.branch`.
- **Port allocation** — ticket-hot ports come from the manifest `portRange`;
  allocations are recorded (`port_allocations`) and re-derived on boot.

---

## Store & persistence

- **SQLite store** — the source of truth: one database in VS Code *global*
  storage (shared by every window — see *Project*). The extension uses
  `better-sqlite3`; the `karst` CLI uses Node's built-in `node:sqlite` (read-only
  where it can be). Registry reads from the CLI assert `user_version >=
  SCHEMA_VERSION` up front and fail naming the file.
- **Global storage** — where the DB lives; anything written there needs a
  per-window key (the hook endpoint port, terminal pids, hook settings file
  names). The remembered hook port lives in *workspaceState* — a global key
  would let a second window's fallback overwrite the first's.
- **Migration** — schema evolution (`migrations.ts`): a guarded ALTER per
  version plus `schema.sql` for fresh DBs, with `SCHEMA_VERSION` bumped and
  pinned by `db.test.ts`. Guards read the CURRENT columns so a fresh DB skips
  the step and a re-open is a no-op. Migrations never backfill data they cannot
  derive. The CLI cannot migrate and refuses to run on a stale registry.
- **Append-only evidence** — see *Evidence*. The retry-overwritten stage row
  and the append-only `gate_runs`/`phase_marks`/`stage_runs`/findings are the
  reason a prior attempt survives.
- **Single-writer discipline** — every stage mutation goes through `setStage`;
  `agent_state` through `setAgentState`. Two writers, one each, never racing.
- **ABI (native addon)** — `better-sqlite3` must match the ABI of whatever runs
  it: VS Code's Electron (39 → ABI 140) for F5, plain Node for `npm run test:unit`.
  `npm run dev:extension` / `npm run test:unit` restore the right binary automatically.
  A `NODE_MODULE_VERSION` mismatch is fixed with `rebuild:electron` /
  `rebuild:node`.

---

## CLI

- **`karst` CLI** — the agent-facing command line (`dist/cli/main.js`),
  invoked by agents via plain `node`, so it uses `node:sqlite`, never the
  Electron-ABI addon. Four verbs: `context` (read), `stage` and `phase`
  (write), and `guide` (the agent manual — static content, no DB).
- **`guide`** — prints the agent manual: how Karst works, the stage flow, the
  verbs, and the marker rules. It is the ONE agent-facing document, and
  `cli/guide.test.ts` pins it to the real CLI — a new verb, marker stage, or
  flow change fails `npm run test:unit` until the guide mentions it (869edmcme). The
  launch seed carries a one-line pointer to it, never the full text.
- **`context`** — renders the ticket context brief (header, stage, evidence,
  worktrees) for the invoking session. Both `context` and `stage` fall back to
  an unscoped ticket lookup when no project bound the key.
- **`stage`** — the done-marker verb: `stage <key> pass`, narrowed by
  `parseStageArgs` to `MARKER_STAGES × {pass}`. The narrowing IS the security
  property: the invoking agent reads ticket content it did not author, so
  prompt injection reaches argv — widening it would put other handling inside
  the one function whose job is refusing a forged `stage ship pass`.
- **`phase`** — records an approach phase marker (`phase_marks`, append-only
  evidence). Parses elsewhere, produces no `Verdict`, never imports the machine
  — the worst a fully-injected call does is append a row. Phase names are a
  shell token interpolated into the command, so one charset
  (`approaches/phaseName.ts`) is enforced at install, at compose, and again on
  receipt; trailing argv is rejected, not ignored.

---

## Models & token usage

- **Model** — a provider/model pair resolved per ticket: `tickets.model`
  (nullable) overrides the manifest `defaultModel`; the precedence rule lives
  in `src/agent/models.ts`; the resolved model is passed to the adapter as
  `--model`.
- **Model catalog** — the known-models list. Exactly two copies must stay
  identical: `BUNDLED_CATALOG` (offline fallback, re-exported flat as
  `KNOWN_MODELS`) and the published feed `model-catalog.json` at the repo root.
  Resolution per provider: CLI → feed (opt-in, NO default URL) → cache →
  bundled; every declining tier files a `CatalogDiagnostic` whose category —
  never the human-readable reason — decides the log level.
- **Token usage** — measured ONCE at the agent seam: `instrumentedAdapter`
  decorates every `AgentAdapter` call, and each call declares its `callSite`
  from the closed `AI_CALL_SITES` set (unknown calls are filed under `unknown`,
  visible, never dropped). A FAILED call is still recorded; an estimate is
  marked `estimated` and used only when the core reported nothing. No prompt or
  completion text is ever stored.
- **Interactive usage sample** — measured cumulative usage from a bridge's
  `UsageUpdate`, appended per provider session and attributed to the ticket's
  currently bound process.

---

## Manifest reference

Top-level keys of `karst.yml` (each validated at load; unknown or malformed
values are rejected naming the field):

- `id` — the project slug source; changing it starts a fresh, empty board.
- `host` / `portRange` — health-check host and the inclusive hot-port window.
- `baselineBranch` — default base branch (repositories may override).
- `worktreePathDisplay` — `relative` (default) or `absolute` path rendering.
- `agentProvider` — the default agent core (`claude` default).
- `archiveDoneAfterDays` — done-ticket auto-archive delay (default 3 days).
- `repositories` — map of name → `{repoPath, baselineBranch?, hasMigrations?,
  signals?, scope?, service?}`. `signals` route tickets to repos at classify;
  `hasMigrations: true` flags "not first-class under shared-DB"; `service` is
  `{start, health, ports, dependsOn}`.
- `approaches` — the development approaches offered on the ticket form (see
  *Approach*).
- `agents` — configured agents per workflow role; `role` is required by
  validation but read by nothing yet (a declared-but-not-active fact karst
  reports at load).
- `processes` — inside AI process assignments (uatTester, uatFix, review,
  reviewFix, prDescription), each opening its run record with a SNAPSHOT of the
  agent name/provider/model resolved ONCE at launch and immutable afterwards.
- `uat` — `maxFixAttempts`, `gates`, `testerVerifier`, per-repository gates.
  Everything else under `uat` is validated but not yet active.
- `review` — `maxFixAttempts`, `requireIndependentSignal`, `openChanges`, `gates`,
  `findings`.
- `conventions` — branch/commit/PR templates, `defaultType` (see *Conventions*).
- `ticketing` — provider (`manual` default, `clickup`), `teamId`, `listId`,
  `searchEnabled`. The API token is never stored in the manifest — it lives in
  the OS keychain (Settings → Ticketing).

---

## Conventions & templates

- **Conventions** — project-wide templates for the git artifacts KARST ITSELF
  creates: the worktree branch (`branchName`), the fallback commit
  (`commitMessage`), and new PRs (`pullRequestTitle`,
  `pullRequestDescription`). Validated at load, applied at render.
- **Placeholder** — `{variable}` in a template. Three renderers, ONE grammar:
  the cut (`{variable|t1|t2}`) is owned by `src/template/token.ts` and never
  re-implemented. Commit/PR vocabulary: `{title} {key} {id} {repo} {type}
  {scope}` (+ `{description}` in the PR body). Branch vocabulary: `{type}
  {slug} {key} {id} {title}` — `{repo}`/`{scope}` are rejected there (a shared
  `repoPath` has no single answer) and one of `{slug}`/`{key}`/`{id}` is
  required so two tickets can never share a branch.
- **Transform** — a pipe stage on a placeholder value (`slice`, `truncate`,
  `upper`, `lower`, `kebab`, `snake`, `trim`, `default`), chained left to
  right. Validation is configuration-time; application is render-time and never
  throws — an unknown transform is skipped because the load-time check already
  reported it. In `branchName`, transforms run on the RAW value and git-ref
  sanitization runs after.
- **Uniqueness rule** — branchName must include `{slug}`/`{key}`/`{id}`; the
  check reads WHICH variable, not how much of it survives a slice.
- **ticketLabelTemplate / terminalNameTemplate** — sidebar row and terminal tab
  labels, rendered from the same placeholder grammar.

---

## UI surfaces

- **Dashboard** — the ticket's main webview: stage rail, inside block, PR
  panel, servers, usage, Now line. Posts typed messages; the single
  `routeAction`-shaped dispatch seam emits one `{type:'action-result',
  requestId, ok, message?}` per action.
- **Sidebar** — the Tickets tree view (Ticket tree + status bar contributions).
- **Ticket form** — the create/edit ticket page (`src/ui/ticketForm/`).
  Gates Phase 2 on the title ALONE; the key is derived once at persist (see
  *Key*). "Getting Started" names a different surface.
- **Settings** — the manifest settings page. Save is TAB-SCOPED: each section's
  fields are the whole write, merged onto the manifest as it is on disk right
  now, validated as a MERGED result. Mirrored TS→HTML constants are behavior,
  pinned by tests.
- **Getting Started** — the fresh-install panel: setup checklist, tour, and the
  Report-an-issue entry. Once called "onboarding" — the word is retired; a
  `grep -i onboarding` over `src/` must return only the deprecated
  `karst.openOnboarding` alias.
- **Webview** — a self-contained HTML surface. CSP forbids a shared stylesheet
  or script, so the design system ships by MARKER INJECTION: `/*KARST_DS_CSS*/`
  and `/*KARST_DS_JS*/` text swapped in host-side, then nonced.
- **Design system** — the tokens, primitives and eight-state matrix
  (`docs/ui/DESIGN-SYSTEM.md`). Tokens are the only legal style values — no
  hex, `rgba()`, raw px/rem, radius, shadow or duration in a component.
- **Glyph / badge / facet** — the ticket's stage/liveness renderings: the
  glyph color folds needs-you and stage state; the badge shows stage; the
  sidebar facet shows status. Consumed from `model/palette.ts` and
  `model/stagePalette.ts`, never redefined.
- **Now line** — the dashboard headline describing what the ticket is doing
  right now; for a conflicted ship cell it says "resolve this" instead of
  "click Merge", keyed off the ship cell's `blocked.kind`.
- **Rail** — the dashboard's stage strip; draws `fix` as a return channel, not
  a step between review and ship (the `isBranch` derivation).
- **Inside block** — the per-stage detail panel: gates with their evidence,
  attempts, findings; renders a disabled gate as `skip` and a repo with no
  script as `note` — never folded together.
- **Status bar** — the window-level status contribution; reads the same needs-
  you and stage derivations as everything else.
- **Busy/result rules** — every control that posts to the host shows a pending
  state (`aria-busy`), cannot be re-triggered, and reports a terminal outcome
  with a watchdog ("unknown" is not "failure"). `disabled` and `aria-busy` are
  different states; a label never changes while pending.

---

## Ticketing

- **Ticketing provider** — where tickets come from: `manual` (local-only,
  default) or `clickup`. The provider integration seam lives under
  `src/integrations/`.
- **Key** — the ticket's stable identifier. If the form is given none, it is
  derived ONCE at persist from the title (`slugifyTitleKey`), suffixed `-2`,
  `-3`… in scope, falling back to `MANUAL-XXXXXXXX` only when the title has
  nothing key-able. The form previews the derivation live.
- **Ticket type** — a conventional-commit type (`feat`, `fix`, …) stored on the
  ticket and consumed by `{type}`. The form's analyzer suggests one, but the
  host persists it ONLY while the ticket has none — an explicit pick is never
  overwritten.

---

## Diagnostics & reporting

- **Report an issue** — the user-facing diagnostics flow: collect → redact →
  review → finalize → GitHub prefill. Owns its whole pipeline; any local
  shortcut that skips the review is refused.
- **Issue prefill** — the GitHub handoff form, prefilled from the FINALIZED
  snapshot (never the draft): editor fork/version, platform/arch,
  Node/Electron/ABI, registry `user_version` beside `SCHEMA_VERSION`, resolved
  provider/model, and the hook counters. Every cell is pipe-stripped,
  whitespace-collapsed and length-capped.
- **Hook counters** — the closed-vocabulary tallies of what the hook endpoint
  saw and what the dispatcher did, maintained by `diagnostics/hookChannel.ts`
  and read by nothing else. A counter defect never stalls the agent — recording
  is wrapped in try/catch at every call site.
- **Non-interference** — the dependency-direction invariant: reporting
  OBSERVES, it never reaches back into the system it describes
  (`diagnostics/nonInterference.test.ts` walks the import graph and fails on
  process spawns, workflow modules and write SQL inside `src/diagnostics/`).

---

## Security & trust boundaries

- **Prompt injection** — the threat that the invoking agent reads ticket
  content it did not author. Defense: the CLI verbs narrow argv
  (`parseStageArgs`), phase names enforce one charset, trailing argv is
  rejected, and hook payloads are narrowed field-by-field before a SQL bind.
- **Untrusted prose** — anything a CLI or model prints is untrusted; failures
  are collapsed to one line and capped before reaching a verdict, a log or a
  toast, and match on bounded codes, never on substring guesses.
- **Secret store** — the OS keychain wrapper (`secretStore.ts`, logic testable
  outside vscode; `secrets.ts` is the thin binding). Tokens live here, never in
  the manifest.
- **CSP** — the webview Content-Security-Policy: no external stylesheet,
  script, `url()` or `fetch()`. Marker injection + nonces are how shared
  CSS/JS reach the webviews at all.

---

## Quick index

Ticket flow: Ticket · Stage · Stage graph · Verdict · Marker · Confirm stage ·
Gate stage · Fix loop · Block · BlockerKind · Resume · Needs you · Ship · Merge
gate · `done` means merged.

Runtime: Project · Manifest · Repository · Service · Worktree · Branch · Spin ·
Hot repo · Baseline pool · Server · Health check · Reap · Server identity ·
Port · Archive.

Agent machinery: Agent provider · Adapter · Headless run · Session · Terminal
identity · Nudge · Agent state · Hook endpoint · Hook event · Notification ·
UsageUpdate.

Automation: Approach · Approach package · Entrypoint · Materialization ·
Owned paths · Gate · Gate run · Evidence · Probe pipeline · Disabled gate ·
Findings lane · TesterVerifier.

Persistence: SQLite store · Global storage · Migration · Append-only evidence ·
ABI.

Interfaces: Dashboard · Sidebar · Ticket form · Settings · Getting Started ·
Webview · Design system · Now line · Rail · Inside block · `karst` CLI ·
`context` · `stage` · `phase`.
