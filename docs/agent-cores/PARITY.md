# Agent core parity — research (869ej1zpv)

Every agent core (`claude`, `codex`, `opencode`, `antigravity`/agy) implements the same
`AgentAdapter` contract (`src/agent/adapter.ts`), but a fix is normally made inside the
adapter the reporter happened to be running. Nothing in the repo forces the other three to
gain it, so the four adapters have drifted. This document is the measured drift, the root
cause, and the rules proposed to stop it.

Source of truth read for this: `src/agent/{adapter,claude,codex,opencode,antigravity,
registry,provider,consoleFormat,hookFailureLog,settings,interactiveUsage}.ts`.

## 1. Two kinds of difference — only one is a gap

- **Justified divergence**: the core's CLI genuinely lacks the surface. Examples:
  `sessionName` is claude-only (`--name`); `effort` is dropped on the opencode TUI
  (passing it printed help and exited 1); agy has no executable hook channel, so its
  lifecycle is read from the conversation DB (`agyConversationWatch.ts`). These are
  documented at the drop site and are correct.
- **Unjustified divergence (the gap)**: karst-owned behavior that is provider-neutral,
  or a CLI flag the core *does* support, present in one adapter and absent in another.
  Every row in §2 is of this kind.

## 2. Measured gaps

### G1 — `--model` is not passed on agy headless runs (highest impact)

`AntigravityAdapter.runHeadless` (antigravity.ts:224) builds `['-p', prompt]` and never
appends `--model`, though its own `buildInteractiveCommand` does (antigravity.ts:137).
claude (claude.ts:289), codex (codex.ts:736) and opencode (opencode.ts:803) all pin it.

This is literally the bug 869ef1e6x fixed — an unpinned headless call falls back to the
CLI default and was measured billing at opus pricing on a PR-description call — fixed in
`claude.ts` only, with the reasoning written in a comment *in that file*. Every headless
call on an agy ticket (classify, PR description, UAT tester, review findings lane) ignores
the ticket's resolved model today.

### G2 — readable console stream is codex/opencode only

`renderConsoleStream` (`consoleFormat.ts`) translates a core's NDJSON event stream into
lines a person can read in the Tester/Review console tail. It is wired in `codex.ts:756`
and `opencode.ts:822`; claude and antigravity forward `opts.onOutput` raw. claude runs
`--output-format json` (a single end-of-run blob, not a stream) and agy runs plain `-p`,
so their console tails carry no live progress at all — a UX fix that stopped at two cores.
`renderConsoleStream`'s provider parameter is typed `'opencode' | 'codex'`, so the
omission is invisible at the type level.

### G3 — endpoint rebinding + hook failure log are codex-only

`hookFailureLog.ts` hardcodes `join(configDir, 'codex', …)` for both `hook-failures.jsonl`
and `current-endpoint`, and only `codex.ts` reads the endpoint file. The fix behind it —
a VS Code reload rebinds an ephemeral port, so a live session's hooks must fall back to
the extension's currently-written endpoint — applies identically to the opencode bridge
(`KarstBridge`, which bakes `endpointUrl` in at write time) and to claude (whose
`--settings` file names the launch-time port). After a reload, an opencode or claude
session posts to a dead port, silently, with no failure log to diagnose it from.

### G4 — hook event vocabulary differs per core, with no stated baseline

| event | claude | codex | opencode | agy |
|---|---|---|---|---|
| SessionStart | yes (command bridge) | yes | yes (`session.created`) | synthesized |
| UserPromptSubmit | yes | yes | — (`permission.replied` stands in) | synthesized |
| PostToolUse | yes | yes | — | — |
| Stop / SessionEnd | yes | yes | `session.idle` / terminal close | terminal close |
| permission asked | `Notification` | `Notification:permission_prompt` | `permission.asked` | status 9 |
| UsageUpdate | — (transcript read) | yes | yes | — (DB read) |

Each mapping is defensible on its own, but no module states which events a core MUST
produce for the dependent features (launch-intent confirm, needs-you glyph, Now line) to
work. A new core is written by copying whichever adapter the author opened.

### G5 — `allowedTools` is honored only by claude

`RunHeadlessOpts.allowedTools` reaches `--allowedTools` in `claude.ts:294`. codex and
opencode ignore it entirely; antigravity carries a bare comment (`// allowedTools mapped
or omitted if unsupported.`). A caller that narrows tools gets that narrowing on one core
and unrestricted execution on three — a security-relevant asymmetry, not a cosmetic one.

### G6 — `materializeApproach` artifact-kind coverage differs

- claude: copies every artifact structure-preserving into a plugin (`skill` = whole dir).
- codex / opencode: explicit `skill` / `agent` / `command` branches.
- antigravity: `command` → converted to an on-demand skill, `skill` → dir copy, and
  **`agent` falls into the else-branch** as a bare file copy into `pluginDir/agents/`
  with no discoverability guarantee stated anywhere.

An approach package that ships agents behaves differently per core with no test pinning
the intent.

### G7 — no cross-adapter conformance suite

`registry.test.ts` asserts only `instanceof` per provider. Every behavioral rule the four
share — "guards a pre-existing repository directory", "routes its spawn through
`spawnHeadlessCli`", "throws `describeHeadlessFailure`", "attaches usage on the failure
path", "pins the resolved model" — is pinned four times in four files, by convention.
CLAUDE.md already says this in prose ("a new adapter needs the same one"), which is the
weakest possible enforcement: a copied adapter that omits a test omits the requirement.

### G8 — `KARST_EXCLUDE_RULES` / `OWNED_PREFIXES` are hand-maintained per adapter

`runtime/karstExcludes.ts` lists each adapter's materialization paths as literals. An
adapter that adds a write path must remember to add a rule there, or ship's `git add -A`
commits karst's scaffolding (the 869eck3gv failure). Nothing ties a `Materialized.
ownedPaths` value to an exclude rule.

## 3. Root cause

Three structural facts, in order of leverage:

1. **The contract is optional-heavy.** `RunHeadlessOpts` carries eleven optional fields;
   ignoring one compiles clean. There is no compile-time or test-time record of "this
   adapter deliberately drops `effort`" vs "this adapter forgot `model`".
2. **Shared helpers are opt-in.** `renderConsoleStream`, `hookFailureLog`,
   `spawnHeadlessCli` are modules an adapter may import. Only `spawnHeadlessCli` is
   effectively mandatory, and only because CLAUDE.md says so.
3. **Fix reasoning lives in the adapter that was fixed.** The `--model` rationale is a
   comment in `claude.ts`. A future agent fixing agy never reads it.

## 4. Proposed rules

R1. **Per-core capability declaration, checked in one table.** Extend `AgentCapabilities`
(or add a sibling `AdapterSurfaces` record) with an explicit verdict per optional
`RunHeadlessOpts` / `InteractiveCommandOpts` field: `supported` | `unsupported:<reason>`.
Make it a required field, so a new adapter cannot compile without stating a position on
every surface. `unsupported` demands a one-line reason that becomes the drop-site comment.

R2. **A shared conformance suite, parameterized over `IMPLEMENTED_PROVIDERS`.** One new
file (`src/agent/adapterConformance.test.ts`) that loops every factory in `registry.ts`
and asserts the rules that are genuinely universal:
   - a headless run with `model` set puts the model on argv (unless declared unsupported);
   - `runHeadless` rejects with `describeHeadlessFailure`-shaped text on nonzero exit;
   - an aborted run rejects with `name === 'AbortError'` (i.e. it went through
     `spawnHeadlessCli`);
   - a failed run still carries usage via `attachUsage`;
   - `materializeApproach` never claims or overwrites a pre-existing directory;
   - every path in `ownedPaths` is matched by a `KARST_EXCLUDE_RULES` pattern (closes G8).
   A new core added to `FACTORIES` is then automatically under test.

R3. **Provider-neutral behavior lives outside the adapter.** `renderConsoleStream`'s
provider union becomes the full `AgentProvider`, with a pass-through renderer as the
default, and the wrapping moves to `instrumentedAdapter.ts` — the seam that already
injects `debug` into every core by construction. Same move for the hook failure log and
the `current-endpoint` fallback: neither is a codex fact, so `hookFailureLog.ts` takes the
provider as an argument instead of hardcoding `'codex'`.

R4. **A fix to one core is a fix to the contract.** Add to CLAUDE.md, as an invariant:
*any change to an adapter that is not a translation of a provider-specific flag must be
applied to all four adapters in the same commit, or its absence declared via R1 with a
reason.* The rationale comment belongs at the seam (adapter.ts / the shared helper), not
in the adapter that happened to be fixed.

R5. **State the minimum hook contract.** One module documents the events a core must
produce for launch-intent confirm, needs-you and Now line to work, and how each core
satisfies them (native, synthesized, or watched). §2 G4's table is the starting content.

## 5. What shipped

Every gap in §2 is closed. §1–§4 above are kept as the record of what was measured and
why; this section is the resolution.

| gap | resolution |
|---|---|
| G1 | `antigravity.ts` `runHeadless` now pins `--model`. The conformance suite asserts it for every core that declares model support, so it cannot regress on any of the four. |
| G2 | `renderConsoleStream` takes the full `AgentProvider` and `consoleLineRendererFor` answers per core, pass-through where there is no structured stream. claude (`--output-format json`, one end-of-run document) and agy (plain `-p`, prose) declare `consoleStream: unsupported(...)` with the reason, and the suite requires the declaration and the renderer to agree — the absence is now a stated fact instead of an invisible one. |
| G3 | `hookFailureLogPath` / `currentEndpointPath` / `readCurrentEndpoint` take a `BridgeProvider`; `writeCurrentEndpoint` writes the file for every member of `BRIDGE_PROVIDERS` (`codex`, `opencode`). The opencode plugin now walks endpoint candidates — its launch-time URL, then the extension's current one — re-applying the launch query string so the generation barrier still admits the rebound session, and treats a non-2xx answer as "did not deliver" (a foreign process on the stale port answers). claude and agy declare `endpointRebind: unsupported(...)` with the reason. |
| G4 | `docs/agent-cores/HOOK-CONTRACT.md`: what each karst behavior requires, how all four cores satisfy it, and the five rules a fifth core must follow. |
| G5 | Declared, not invented: codex, opencode and agy each state on `surfaces.allowedTools` why they have no per-run tool allowlist and what carries execution policy instead (`permissionMode`). No flag was guessed — a wrong flag kills a launch. |
| G6 | The antigravity `agent` branch is named and commented at its neutral `agents/<name>.md` path, beside the solo-agent write. |
| G7 | `src/agent/adapterConformance.test.ts`, parameterized over `IMPLEMENTED_PROVIDERS`. |
| G8 | Same suite: every `ownedPaths` entry must be covered by a `KARST_EXCLUDE_RULES` pattern. |
| R1 | `src/agent/surfaces.ts` — `AdapterSurfaces` on every adapter, forwarded by `instrumentedAdapter` so a wrapped runtime adapter still reads as declared. |
| R4 | The CLAUDE.md invariant: a non-flag-translation adapter change lands on all four in one commit, or is declared with a reason. |
| R5 | The hook contract document above. |

Deliberately NOT done, and why: claude's headless run was not switched to
`--output-format stream-json` to gain a live console tail. That changes the response
parsing every claude call depends on (verdict, session id, usage) and is a behavior
change to the default core, not a parity fix — it belongs in its own ticket with its own
verification. The gap is declared on `surfaces.consoleStream` in the meantime.

## 6. Typed-submit delay (MAILBOX-DELIVERY-RELIABLE-SUBMIT)

A nudge is no longer one `sendText(line)`. A core's TUI reads a burst of bytes as a
paste, so the newline VS Code appends does NOT submit — the pointer sits half typed
until a human presses Enter. `SessionManager.nudge` therefore types the text with
`addNewLine=false`, waits a per-core window, and sends a separate `\r`; a per-terminal
FIFO serializes nudges so two inside one window cannot merge into `AB`.

The window is a per-core MEASURED fact on `AgentCapabilities.submitDelayMs`, never one
shared constant (`src/ui/session.ts`'s `DEFAULT_SUBMIT_DELAY_MS` is only the last-resort
fallback for a handle whose provider cannot be resolved). `adapterConformance.test.ts`
requires every adapter `registry.ts` resolves to declare a positive delay.

| core | `submitDelayMs` | measurement |
|---|---|---|
| claude | 120 | local Claude TUI: its paste heuristic needs the widest gap before the `\r` registers as a keystroke |
| codex | 60 | local codex TUI: the typed line is consumed well inside 60 ms |
| opencode | 60 | local opencode TUI: same window as codex |
| opencode2 | 60 | local opencode2 TUI: same window as v1 |
| antigravity | 250 | local agy TUI: its input line buffers the burst for longer, so the submit waits well after the paste |

The agy route adds one more gate: agy swallows a line typed mid-turn, so the pointer is
`deferred` while the conversation watch reports the run status explicitly RUNNING, and the
delivery sweep retries once it turns idle. A conversation the watch has NOT observed yet
also defers — a fresh session, or a fresh activation map, has no state until the sweep's
first tick (up to `AGY_WATCH_INTERVAL_MS` away), and a pointer typed in that window could
land mid-turn. An UNKNOWN status (the summary DB or the conversation's row is missing, or
the read failed) does NOT gate — a summary the CLI has not written must never strand mail
forever, and the read is isolated so a summary failure cannot drop the lifecycle tick.
Every other core accepts a typed line at any time.

## 7. Mail delivery route + submit delay (MAILBOX-DELIVERY-PER-CORE-PUSH)

A mail pointer reaches the recipient through a per-core route, resolved from the
recipient's CURRENT live session core at delivery time (never stored per ticket — a core
can change between stages or resumes). Every core must state BOTH its route and its
`submitDelayMs`; a fifth core that omits either is incomplete.

| core | mail delivery route | submitDelayMs |
|---|---|---|
| claude | `hook-block` — `Stop` reply `{decision:"block",reason}` on stdout | 120 |
| codex | `hook-block` — same protocol (SPIKE-CODEX-STOP-BLOCK passed on 0.153.0) | 60 |
| opencode | `plugin-idle` — plugin reads the `session.idle` reply and `promptAsync`s it | 60 |
| opencode2 | `typed` — no SDK client on the plugin `ctx`; reply body ignored | 60 |
| antigravity | `typed` — no executable hook channel; agy idle gate applies | 250 |

`hook-block` and `plugin-idle` only ARM the push: the pointer is delivered when the
recipient's turn ends, so nothing is typed mid-turn. A turn-end reply counts as
that batch's delivery only once it is CONFIRMED — the bridge POSTs a positive
`MailReplyAck` after writing the block to stdout (a flushed response is not
enough: a hung host can write into a socket the bridge abandoned), and only then
does the sweep skip that batch's watermark. A reply built but not confirmed keeps
the sweep's typed fallback, so a lost reply never strands the mail. They are used
only while the recipient is MID-TURN; an idle recipient has already passed its
turn-end event, so it takes `typed` instead. A graph-owned session is deferred by
both the sweep and the endpoint.
`typed` is the #56 nudge and the fallback for every route that cannot push
(opencode2, agy, an idle recipient, an unknown/retired session, and any hook-route
failure). The endpoint's reply is bound to the recipient's current launch
generation and blocked at most once per BATCH (the unread watermark — highest
message id — not the count, so a same-sized new batch still blocks). The reply
reads the host's in-memory unread cache, which the sweep rebuilds every tick and
the endpoint tops up for one ticket at its turn end (so a `message send` in the
sweep window is not missed). See `docs/agent-cores/HOOK-CONTRACT.md` § "Mail
delivery reply channel".
