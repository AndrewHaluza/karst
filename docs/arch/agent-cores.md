# Agent cores: the adapter seam

Everything that is true of every agent core, and the places a core-specific fix must land in all four adapters. Related: `docs/agent-cores/HOOK-CONTRACT.md`, `docs/guides/adding-agent-core.md`, `docs/arch/approaches.md` (the package an adapter materializes).

## Contents

- Ticket-context shaping lives ONCE
- Per-ticket launch model
- A missing optional provider CLI is a normal state
- A failed headless CLI run is described in ONE place
- A SILENT run is an empty answer, never a failure
- A FIX TO ONE AGENT CORE IS A FIX TO THE SEAM
- A headless agent run is BOUNDED
- Token spend is measured ONCE, at the agent seam
- A terminal's ticket is carried by its ENV and its PID
- nudge adopts a revived session
- An adapter may only own a path it CREATED
- agy has no executable hook channel

## Ticket-context shaping lives ONCE in `src/context/ticketContext.ts`

Ticket-context shaping lives ONCE in `src/context/ticketContext.ts` (`buildTicketContext`/`renderTicketContext`): the launch seed (extension, in-process) AND the `karst context` CLI both render from it. `buildSessionSeed` only composes invocation + context + approach. The generated `/karst:<id>` command embeds a `node <ext>/dist/cli/main.js context --db … --manifest …` prefix so a running (or foreign) session can re-pull fresh state on demand. The stage section shows the ticket's CURRENT stage row except at `fix`, where it shows the failed gate stage's evidence instead — and the "not an agent-advanced stage" advisory is driven by the ticket's actual current stage (`ctx.stageCurrent`), never that evidence row. The done-marker instruction itself is seeded ONLY when the marker exists: `markerStageFor` (`agent/markerStage.ts`) returns `MarkerStage | null`, and at `uat`/`review`/`ship`/`scope`/`done` the seed carries no marker at all — seeding `stage impl pass` there was a command the CLI refuses.

## Per-ticket launch model

Per-ticket launch model: `tickets.model` (nullable) overrides manifest `defaultModel`; `resolveModel` (`src/agent/models.ts`) is the precedence rule → adapter `--model`. The model list has exactly TWO copies and they must stay identical: `BUNDLED_CATALOG` (`agent/modelCatalog.ts`, the offline fallback, re-exported flat as `KNOWN_MODELS`) and the published feed `model-catalog.json` at the repo root (read by `modelCatalogLoader.ts` ONLY when a `feedUrl` is configured — precedence CLI → feed → cache → bundled). Adding a model means editing BOTH — `modelCatalog.test.ts` "matches the published model feed exactly" fails otherwise. The webviews render the host-supplied catalog (`state.models` / `refreshModelCatalog`), so there is NO model literal in any HTML. `discoverClaudeModels` is a deliberate stub: the Claude CLI exposes no model-list command. Same shape for `tickets.type` (`store/ticketTypes.ts` → `{type}`): the ticket-form analyzer suggests one, but the host persists it ONLY while the ticket has none — an explicit pick is never overwritten. `TICKET_TYPES` and `CONVENTION_PRESETS` are mirrored into `settings/webview.html`; `webview.test.ts` pins both mirrors against the TS modules.

## A missing optional provider CLI is a normal state, not a fault

The model catalog resolves per provider through cli→feed→cache→bundled, and every tier that declines files a `CatalogDiagnostic`. `catalogDiagnosticSeverity` (`agent/modelCatalogLoader.ts`) is the ONLY thing that decides a log level: `command-unavailable`/`unsupported`/`empty` are INFO (the next tier covers them), everything else is WARN. The category is carried, never re-derived — `DiscoveryResult` now returns a `code` because `classifyCliFailure` used to substring-match the human-readable `reason`. `reason` is unbounded CLI prose and must never reach a log line; `target`/`cause` are the bounded exception and are re-validated inside `formatCatalogDiagnostic`. **The feed tier is opt-in with NO default URL.** `model-catalog.json` at the repo root is the publishable artifact (pinned by `modelCatalog.test.ts`), not something anything fetches by default.

## A failed headless CLI run is described in ONE place for every agent core

`agent/cliFailure.ts` (`describeHeadlessFailure`/`isUsageLimitFailure`) is what each adapter's `runHeadless` throws. It unwraps whole-document JSON AND JSONL (the interesting codex event is never line 1), names a usage limit from a 429 status / limit phrasing, and keeps raw text ONLY when nothing structured parsed — an unrecognized failure must stay debuggable. Every diagnostic is untrusted CLI prose (it can be model output), so it is collapsed to one line and capped before reaching a verdict, a log, or a toast. The bare-429 match uses lookarounds on purpose: `src/foo.ts:429:12` must not send the user to a billing page.

## A SILENT run is an empty answer, never a failure

A core that exits 0 having emitted no assistant text answered EMPTY — `runHeadless` returns `raw: ''` and every adapter agrees on that. opencode and codex used to THROW here (`did not contain agent text` / `did not contain a completed agent message`) while claude and agy already returned `''`, so the same silence was a crash on two cores and an empty answer on the other two. It is a real shape, not a broken stream: opencode routinely ends a turn on a tool call, and a three-minute UAT run that did the whole job and never wrote the answer down reached `uat/tester.ts` as `execution-failed` — which abandoned every remaining target, recorded ZERO observations, and left UAT to pass on its gates with nothing but a debug line to say the Tester never ran. A stream missing its SESSION ID (`thread.started`, opencode's `sessionID`) stays a hard failure — that is a broken stream, not a quiet model. **The caller decides what silence means**: the UAT Tester re-asks the target ONCE with `TESTER_SILENCE_NUDGE` appended to the same prompt (context and output rules intact) and then records `unreadable-output`; unreadable PROSE is never re-asked, because the core did answer and a second ask buys a second helping of prose. Every other headless call site already tolerates an empty answer through its own parse fallback.

## A FIX TO ONE AGENT CORE IS A FIX TO THE SEAM — all four adapters in the same commit, or a declared reason

A change that is NOT a translation of one CLI's own flag vocabulary lands on every adapter at once. Where a core genuinely cannot do it, that is DECLARED, never silently dropped — `agent/surfaces.ts` gives every adapter an `AdapterSurfaces` with a position on each optional field of the seam (`model`, `effortHeadless`/`effortInteractive`, `allowedTools`, `permissionMode`, `resume`, `sessionName`, `consoleStream`, `hookChannel`, `endpointRebind`, `mcpIsolationHeadless`), and `unsupported(reason)` REQUIRES the reason. `agent/adapterConformance.test.ts` is the enforcement: it loops `IMPLEMENTED_PROVIDERS` through `resolveAdapter` and checks each declaration against REAL argv (a claim is never taken on trust), plus the universal rules — bounded single-line failure text, `AbortError` from the shared spawner, `materializeApproach` never claiming a pre-existing repository dir, and every `ownedPaths` entry covered by a `KARST_EXCLUDE_RULES` pattern. So a fifth core is under test the moment it joins `FACTORIES`, and adding a field to `AdapterSurfaces` is deliberately a compile error in all four adapters. Rationale for shared behavior belongs at the SEAM (`adapter.ts`, the shared helper). Lifecycle signals have their own baseline: `docs/agent-cores/HOOK-CONTRACT.md` states what karst's needs-you / launch-intent / resume features require, and a core may satisfy it natively, by synthesis, or by WATCHING its own state (agy's conversation DB) — but never by a channel that looks installed and delivers nothing. `writeCurrentEndpoint` writes the endpoint file for every member of `BRIDGE_PROVIDERS`.

`mcpIsolationHeadless` has one verified argument per core, and the arguments are not interchangeable: claude passes `--strict-mcp-config` **alone** — pairing it with `--mcp-config '{}'` makes the CLI exit with `Invalid MCP configuration: mcpServers: Invalid input` before it does any work, because that value is schema-validated and requires an `mcpServers` key (this shipped once and turned every headless claude run into `execution-failed`); codex passes `--config mcp_servers={}`; opencode passes `--pure`; antigravity has no per-invocation flag at all and declares `unsupported(...)`. Presence of the right flag is not sufficient — `adapterConformance.test.ts` also holds `FORBIDDEN_HEADLESS_ARGS`, the arguments each core's CLI rejects, because a presence-only assertion cannot catch an extra argument.

## A headless agent run is BOUNDED, and the bounds live in ONE spawner

`agent/headlessSpawn.ts` (`spawnHeadlessCli`) is now THE spawner every adapter's `defaultSpawn`/`makeDefaultSpawn` delegates to: the child is spawned `detached` (its own group), an abort or the 15-minute `timeoutMs` backstop kills the WHOLE group via `killTree` (a killed run's `close` arrives a moment later and must never read as a clean exit — the `killReason` flag makes abort/timeout rejections win over it), and stdout/stderr drain into `BoundedOutput` (8 MB default) instead of unbounded string concat. An abort rejects with `name === 'AbortError'`; a timeout rejects naming the deadline. Adding a fifth core means routing its spawn through `spawnHeadlessCli`, never a third copy of the loop.

## Token spend is measured ONCE, at the agent seam — never at a call site

`agent/instrumentedAdapter.ts` decorates `AgentAdapter`, so every AI invocation is counted by construction: `tracking: { callSite }` on its `runHeadless` opts, where `callSite` comes from the closed `AI_CALL_SITES` set (`agent/aiCallSites.ts`). A call that declares none is filed under `unknown` — visible, never dropped. `extension.ts` wraps at BOTH `resolveAdapter` sites; an un-instrumented one compiles and silently records nothing, so `ui/usage/wiring.test.ts` pins it. Three rules keep it safe to leave on: the store write is wrapped and swallowed (a locked DB must never fail a PR description), a FAILED call is still recorded (a 429 arrives after the input was billed), and an estimate is MARKED (`estimated`) and used only when the core reported nothing. Counts are parsed by one provider-agnostic reader (`agent/tokenUsage.ts`, whole-doc JSON + JSONL) which prefers a provider total, takes a CUMULATIVE tally as-is rather than summing it, and drops non-numeric/negative values. **No prompt or completion text is stored** — `token_usage` has no column that could hold it. Aggregation is five SQL GROUP BYs (`store/tokenUsage.ts`), never an in-memory rollup; `sort` is the one query field that cannot be bound, so `parseUsageQuery` (`store/tokenUsageQuery.ts`) narrows it to a key of a closed ORDER BY map and an invalid query returns a NAMED error rather than an empty table that would read as "you spent nothing". **Reasoning tokens are their own counter (v45), and CACHE READS ARE NOT THE HEADLINE.** opencode reports thinking tokens in a cumulative `tokens.reasoning` beside `output`; it is now `reasoning_tokens` on both usage tables, never folded INTO `output` for the same reason cache reads and writes stay disjoint. The reverse defect is `cache_read_tokens`, which was folded INTO the displayed total: a long opencode session re-reads its whole context every request, so 3.7M of a 3.9M tally was cache — the Σ pill and the usage panel reported 3.9M for a conversation whose own terminal showed 154.5K of context, which reads as a runaway agent rather than as ordinary prompt caching. **The stored `total_tokens` stays the provider-faithful full tally; the DISPLAY subtracts cache reads and shows them beside the headline** (`tokenView` in `model/inside/agent.ts`, `totalsView` in `ui/usage/state.ts`), clamped at zero because the two sums are independent and a legacy row can carry reads its total never counted. A terminal's own token figure is usually CONTEXT SIZE, not cumulative spend — the two are different quantities and are never reconciled.

## A terminal's ticket is carried by its ENV while it lives and by its PID across a reload

`KARST_TICKET_ID`/`KARST_LAUNCH_ID` are the launch's own statement, but VS Code does not give them back: a reattached terminal is rebuilt from the pty host's process details (`title`/`cwd`/`icon`/pid — never `env`, never the executable), so `creationOptions.env` is `undefined` for the very terminal still running the agent. `ui/terminalIdentity.ts` closes it: the pid captured at `createTerminal` is persisted per window (`karst.sessionTerminals`, `workspaceState` — pids name processes THIS window started) and re-identifies the terminal when its env is gone, carrying the original `launchId` so the running agent's hooks stay current. Terminal NAMES are unusable for this — an agent CLI rewrites the title with an OSC sequence. Env always wins over a record (a record is a recollection of a pid the OS may have reissued), a record dies with its terminal (`onDidCloseTerminal` → `forget`), and the pid probe is BOUNDED (`PID_PROBE_TIMEOUT_MS`) because activation awaits every revived terminal's pid before the adoption scan and `Terminal.processId` never settles for a process that failed to start.

## `nudge` adopts a revived session; it never reports "no session" for an agent that is still running

`SessionManager.terminals` is this host's bookkeeping and is empty after a reload, while the agent it forgot sits at its prompt — so `nudge` falls back to `adoptRevivedSession` exactly as the open path does, rather than returning false and letting a failed gate launch a SECOND `--resume` agent beside the live one. Adoption on this path never REVEALS the terminal: an automated continuation must not yank the user out of what they are doing, which is the one thing that separates it from `openSession`.

## An adapter may only own a path it CREATED

`materializeApproach` writes into the worktree at stable, predictable paths (`.agents/skills/karst-<id>-<name>/`, `.karst-plugin/<id>/`, `.agents/plugins/<id>/`) and returns them as `ownedPaths`, which `cleanupOwnedPaths` (`agent/materializedCleanup.ts`) `rmSync(recursive)`s on session close. A repository may legitimately check in its own tree at those exact paths — karst's own repo tracks `.karst-plugin/rpi/`, `.karst-plugin/karst/`, and `.agents/skills/karst-rpi*/`. So EVERY adapter guards each target with `existsSync` BEFORE writing: a pre-existing directory belongs to the repository, is neither written into nor added to `ownedPaths`. Without this guard, materialization silently corrupts tracked files and session close deletes them. Guards: the `never claims or overwrites pre-existing repository …` test in `codex.test.ts`, `claude.test.ts`, and `antigravity.test.ts` — a new adapter needs the same one.

## The artifact karst GENERATES is rewritten every launch; only COPIED artifacts are existence-guarded

Ownership (above) is a path rule; it was wrongly applied to CONTENT. The generated orchestrator (`/karst:<id>`, the workflow skill) lives at a destination karst shares across launches — the `karst` plugin dir is named for the plugin, not the approach, and a worktree outlives both the approach and the stage it was first launched under. A dir-level `existsSync` skip therefore wrote NOTHING on a re-launch: a ticket moved from one approach to another kept the first approach's command and the seed invoked a command that was never generated ("Unknown command: /karst:<id>", then the ticket key reported as stray args) — the same user-visible failure as the un-slugged name, surviving that fix. The stale body was also wrong on its own terms: its closing marker step names the stage of the FIRST launch, which the CLI refuses later.

`agent/generatedArtifact.ts` splits the two cases by stamping what karst writes (`GENERATED_STAMP`, a markdown comment): `writeGeneratedArtifact` replaces a stamped file, refuses an unstamped one (the repository's), and reports the refusal. All four adapters use it for the generated workflow artifact and keep the plain `existsSync` guard for artifacts they COPY from the package. Ownership is unchanged — still only a path this call created — so a re-render never makes cleanup delete a dir karst did not create.

## The seed-shape rule

A seed is the prompt text karst composes for a headless agent session. Whether a block of content goes inline in that seed or behind a CLI indirection is decided once, by audience:

- **A seed a HUMAN reads** (the interactive launch, its resume, its fix resume, the merge-conflict handoff) carries only narrative content inline and pulls operational facts through `/karst:start-task` → `karst context <key> --md`. The human must not be asked to scroll through worktree paths, branch names, service ports, or PR URLs to reach the sentence that tells them what to do next.
- **A seed only a MACHINE consumes** (the three graph-planner prompts) keeps everything inline, because indirection there buys no readability and adds a failure mode — the machine does not scroll, and a missing `karst context` call is a silent data loss.

The three standing counterexamples where inline is correct by this rule:
1. `launchPlannerRepairHost` — the G2 compile-repair re-prompt (`extension.ts`'s planner-repair host binding).
2. `launchReplanPlannerHost` — the replan planner launch (Slice-4 T5).
3. `launchBootstrapRelaunchHost` — the bootstrap planner relaunch after `planner-relaunch` recovery.

All three compose the prompt from `promptBytesOf('karst-graph-planner')` plus `renderTicketContext` directly, with `bounded: false` — the graph-planner prompt is a different surface from the interactive seed and never shares its bounds.

## Entry-point commands

| command | args | entry point it serves |
|---|---|---|
| `/karst:start-task` | `<key> <brief>` | fresh launch |
| `/karst:resume` | `<key>` | session resume |
| `/karst:fix` | `<key>` | resume at the `fix` stage |
| `/karst:resolve-conflict` | `<key> <repo>` | the "Resolve conflicts" click |

**Key Decision 8:** separate commands per entry point rather than one unified verb, chosen so each is manually runnable from the CLI or a terminal without hidden state.

**Key Decision 9:** aliases only for the three cold-typed commands (resume, fix, resolve-conflict) — not for start-task, which takes a brief and is always composed by karst.

## Per-core start-task surface

| core | command file | command name |
|---|---|---|
| claude | `.karst-plugin/karst/commands/start-task.md` | `/karst:start-task` |
| antigravity | `.agents/plugins/karst/commands/start-task.md` | `/karst:start-task` |
| opencode | `.opencode/commands/karst-start-task.md` | `/karst-start-task` |
| codex | `.agents/skills/karst-start-task/SKILL.md` | `/karst-start-task` |

## Fallback invariant: the seed is self-contained when no adapter reports startTaskInvocation

The seed drops the inline marker (the `karst context` indirection) ONLY when the adapter reported `startTaskInvocation` — i.e. the adapter guarantees it will render a `/karst:start-task` command the human can click. Absent that report, the seed is self-contained exactly as before: every fact the agent needs is inline. A session must never have neither the inline content nor the adapter's command guarantee — that would be a silent data loss. The fallback check lives in the seed composer; the adapter's `startTaskInvocation` field (`agent/adapter.ts`) is the single source of truth for whether the guarantee exists.

## The guide pointer deliberately stays in the seed

The guide-pointer sentence (`GUIDE_POINTER_MARKER` from `agent/promptTelemetry.ts`) remains in every human-facing seed — including the new `/karst:start-task` command's output — to preserve the `seedHasGuide` telemetry denominator and the committed baseline in `docs/arch/prompt-metrics.md`. Removing it would zero the guide-pull rate and invalidate the metric without a replacement.

## agy has no executable hook channel; its lifecycle signals are READ from the CLI's own conversation DB

agy 1.1.11 loads `hooks.json` but never RUNS the hook commands in the CLI conversation path (verified empirically; the machinery targets the IDE surface), so a bridge script would be a silent fake signal. `agent/agyConversationWatch.ts` is the channel: a sweep in `extension.ts` finds the conversation DB by the worktree path stored in its `trajectory_metadata_blob`, and a `steps` row with `status = 9` is a pending permission ask (observed live: dialog open → 9, answered → 3). Events are normalized into the CLOSED hook vocabulary (`SessionStart` once per conversation, `permission.asked` on 9 appearing, `UserPromptSubmit` on it resolving) and posted through the SAME `dispatchHook` seam and closures as the HTTP endpoint, so session-id capture (`--conversation` resume), launch-intent confirmation, the generation barrier, the amber glyph and the Now line are shared. Session end → idle stays the terminal-close sweep's job. `interactiveUsage` stays false — no usage channel exists.