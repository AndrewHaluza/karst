# The minimum hook contract every agent core must satisfy

Karst's needs-you glyph, Now line, launch-intent confirmation and resume-by-id are all
driven by lifecycle signals. Each core delivers them differently — an executable bridge,
a settings file, or a watch over the CLI's own state — and each mapping was written
against whatever the core in hand emitted, with no statement of what the dependent
features actually require. This file is that statement (869ej1zpv R5).

## What the features need

| karst behavior | required signal | consequence if absent |
|---|---|---|
| session-id capture / resume-by-id | `SessionStart` carrying the core's session id | a relaunch cold-starts instead of continuing |
| launch-intent confirmation (`dispatch.ts`) | `SessionStart` carrying the launch generation | a prepared fix round stays pending forever, then parks "no fix execution in flight" |
| needs-you (amber) | a **permission asked** signal | a blocked agent reads as still working; the user never learns it wants them |
| needs-you clearing | the **resolution** of that ask | the ticket stays amber after the user answered (FIX-WRONG-STATUS) |
| in-progress (blue) | any running signal, or the absence of a wait | the ticket reads idle while the agent works |
| session end → idle | terminal close is an acceptable substitute | a finished session reads as running |
| interactive token usage | measured counts, per session | usage is unmeasured — which is NOT the same as zero (`PROVIDER_INTERACTIVE_USAGE`) |

Everything above is normalized into karst's own **closed** vocabulary before it reaches
`dispatchHook`. A core's native event names never travel further than its adapter or its
watch: `hookChannel.ts`'s `normalizeHookEventName` is the boundary, because a hook event
name is agent-authored input.

## How each core satisfies it

| | claude | codex | opencode | antigravity (agy) |
|---|---|---|---|---|
| channel | `--settings` file with shared bridge (`settings.ts`) | generated `bridge.cjs` | generated `.opencode/plugins/karst-bridge.js` | **none** — conversation-DB watch |
| SessionStart | bridge (replaces old `type:command` curl) | native | `session.created`, or plugin init on a `--session` resume (which emits none) | synthesized per conversation |
| permission asked | `Notification` | `Notification: permission_prompt` | `permission.asked` / `question.asked` (+ v2) | `steps.status = 9` |
| ask resolved | `UserPromptSubmit` | `UserPromptSubmit` | `permission.replied` / `question.replied` | status 9 clearing |
| running | `PostToolUse` (type:http) | `PostToolUse` | `session.status: busy\|retry` | — |
| end | `Stop` / `SessionEnd` | `Stop` / `SessionEnd` | `session.idle` + terminal close | terminal close |
| usage | session transcript (`claudeTranscriptWatch.ts`) | bridge `UsageUpdate` | bridge `UsageUpdate` | conversation DB (`agyUsageWatch.ts`) |
| endpoint rebind after reload | ✓ (bridge re-reads `current-endpoint`) | ✓ | ✓ | n/a (no channel) |
| hook failure logging | ✓ (`claude/hook-failures.jsonl`) | ✓ (`codex/hook-failures.jsonl`) | ✓ (`opencode/hook-failures.jsonl`) | n/a |

**opencode resume is special-cased.** opencode 1.18.35 DROPS `--prompt` when
`--session` is present and never emits `session.created` for the resumed session
(verified on a real TUI, pty via `script`, with a probe plugin logging every
event: only `plugin.added`/`catalog.updated` fired; the control run without
`--session` submitted the prompt and emitted `session.created`). So a resumed
launch cannot hang SessionStart off `session.created` and cannot receive its
kickoff on argv. The adapter instead writes the kickoff to a file named by
`KARST_KICKOFF_FILE` (with `KARST_RESUME_SESSION_ID` in the terminal env) and
the generated plugin, at init, posts `SessionStart` for the resumed id and
pushes the kickoff through the opencode SDK (`client.session.promptAsync`). The
SDK call is deliberately NOT awaited in plugin init — opencode awaits plugin
construction before it serves the session API, so a synchronous call deadlocks
the bootstrap. The adapter-agnostic safety net for a delivery that still fails
is the stranded-fix sweep, not a silent park.

### The SPLIT decision (PROMPT-16 measured)

Not every claude event is bridged. The node bridge costs ~21 ms per invocation
(~16 ms Node startup + ~4 ms logic); bridging a high-frequency event would add
significant blocking time for a low-value signal. The split:

| event | per session (typ.) | bridged cost | delivery |
|---|---|---|---|
| `Stop` | 1 per turn | ~21 ms/turn | **bridge** |
| `UserPromptSubmit` | 1 per turn | ~21 ms/turn | **bridge** |
| `SessionEnd` | 1 | ~21 ms | **bridge** |
| `Notification` | occasional | ~21 ms | **bridge** |
| `SessionStart` | 1 | ~21 ms | **bridge** (replaces 5 ms curl) |
| `PostToolUse` | 1 per tool call | ~21 ms × every call | **type:http** (non-blocking) |

Bridging `PostToolUse` would cost ~6 seconds per session (300 tool calls × 21 ms)
for the least valuable signal — a liveness ping. A dropped `PostToolUse` costs
nothing; the next event re-establishes state. Lifecycle events are where a
stranded session actually costs something, and they are the low-frequency ones.

**Consequence**: `PostToolUse` still cannot rebind and its failures still cannot
be logged on claude. Coverage is partial **by decision, with the number
attached** — not an oversight. This table IS the contract doc for which events
rebind and which do not.

A core that cannot deliver a signal **natively** may satisfy the contract by WATCHING its
own state — agy proves this is a first-class option, not a degraded one. What is never
acceptable is a fake: agy loads `hooks.json` but never runs the hook commands in the CLI
conversation path, so installing a bridge script there would post nothing while looking
installed.

## Rules for a new core

1. Answer every row of the first table — natively, by synthesis, or by a watch. State the
   answer on the adapter's `surfaces` (`agent/surfaces.ts`); `adapterConformance.test.ts`
   requires a reason for every gap.
2. Normalize into karst's closed vocabulary at the adapter/watch boundary. Never widen
   `dispatchHook`'s event set to accommodate a core's own naming.
3. If the channel is a script karst generates, it MUST re-read
   `currentEndpointPath(configDir, provider)` when its launch-time URL stops answering,
   and re-apply the launch query string so the generation barrier still admits the
   session. Add the provider to `BRIDGE_PROVIDERS` so the extension writes its file.
4. Fail open. A dead endpoint, a malformed payload or a bridge defect must never throw
   into the agent's event loop or block a tool call. An oversized body is DECLINED
   (2xx + `input-too-large`), never rendered to the user as a hook failure.
5. Interactive usage is measured or it is absent — never invented. Record the answer in
   `PROVIDER_INTERACTIVE_USAGE`, since a zero from an unmeasured core would read as a
   measured free call.
