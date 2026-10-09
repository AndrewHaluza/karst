<!-- AGENT INSTRUCTIONS:
This file uses an agent-optimized block format. DO NOT read this file entirely.
1. TABLE OF CONTENTS: Run this to list all available keys:
  grep -F "## [@" docs/agent-cores/HOOK-CONTRACT.md

2. EXTRACT A RULE: Run this to read a specific block (Example for ID 'core:HOOK-01'):
  awk "/^## \[@core:HOOK-01\]/,/END_DOC_BLOCK: \[@core:HOOK-01\]/" docs/agent-cores/HOOK-CONTRACT.md
-->

# The minimum hook contract every agent core must satisfy

Karst's needs-you glyph, Now line, launch-intent confirmation and resume-by-id are all
driven by lifecycle signals. Each core delivers them differently — an executable bridge,
a settings file, or a watch over the CLI's own state — and each mapping was written
against whatever the core in hand emitted, with no statement of what the dependent
features actually require. This file is that statement (869ej1zpv R5).

## [@core:HOOK-01] What the features need

| karst behavior | required signal | consequence if absent |
|---|---|---|
| session-id capture / resume-by-id | `SessionStart` carrying the core's session id | a relaunch cold-starts instead of continuing |
| launch-intent confirmation (`dispatch.ts`) | `SessionStart` carrying the launch generation | a prepared fix round stays pending forever, then parks "no fix execution in flight" |
| needs-you (amber) | a **permission asked** signal | a blocked agent reads as still working; the user never learns it wants them |
| needs-you clearing | the **resolution** of that ask | the ticket stays amber after the user answered (FIX-WRONG-STATUS) |
| in-progress (blue) | any running signal, or the absence of a wait | the ticket reads idle while the agent works |
| session end → idle | terminal close is an acceptable substitute | a finished session reads as running |
| interactive token usage | measured counts, per session | usage is unmeasured — which is NOT the same as zero (`PROVIDER_INTERACTIVE_USAGE`) |
| mail delivery (unread pointer) | a **turn-end reply** channel that can carry a host-written pointer (`Stop` / `session.idle`) | mail waits in the inbox until the agent next runs `inbox` by hand |

Everything above is normalized into karst's own **closed** vocabulary before it reaches
`dispatchHook`. A core's native event names never travel further than its adapter or its
watch: `hookChannel.ts`'s `normalizeHookEventName` is the boundary, because a hook event
name is agent-authored input.
END_DOC_BLOCK: [@core:HOOK-01]

## [@core:HOOK-02] How each core satisfies it

| | claude | codex | opencode | antigravity (agy) |
|---|---|---|---|---|
| channel | `--settings` file with shared bridge (`settings.ts`) | generated `bridge.cjs` | generated `.opencode/plugins/karst-bridge.js` | **none** — conversation-DB watch |
| SessionStart | bridge (replaces old `type:command` curl) | native | `session.created`, or plugin init on a `--session` resume (which emits none) | synthesized per conversation |
| permission asked | `Notification` | `Notification: permission_prompt` | `permission.asked` / `question.asked` (+ v2) | `steps.status = 9` |
| ask resolved | `UserPromptSubmit` | `UserPromptSubmit` | `permission.replied` / `question.replied` | status 9 clearing |
| running | `PostToolUse` (type:http) | `PostToolUse` | `session.status: busy\|retry` | — |
| end | `Stop` / `SessionEnd` | `Stop` / `SessionEnd` | `session.idle` + terminal close | `Stop` (turn end, from the summary DB run status) + terminal close |
| usage | session transcript (`claudeTranscriptWatch.ts`) | bridge `UsageUpdate` | bridge `UsageUpdate` | conversation DB (`agyUsageWatch.ts`) |
| mail delivery | `Stop` block → stdout JSON | `Stop` block → stdout JSON | plugin `session.idle` → SDK `promptAsync` | **none** — typed nudge |
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
the bootstrap. Because the plugin IS the channel, the adapter also overrides an
ambient `OPENCODE_PURE` to `0` on every hook-channel launch: opencode reads that
env var like `--pure` (any value but `0`/`false`, including empty, disables every
external plugin) and would otherwise silently kill the whole hook channel, not
just the resume. The adapter-agnostic safety net for a delivery that still fails
is the stranded-fix sweep, not a silent park.

**Historical backlog, not a live defect.** The registry's 142 pending opencode
`implementation/initial` launch intents are almost entirely pre-`SessionStart`:
141 predate 2026-08-14, when the opencode bridge did not post SessionStart at
all (the `session.created` capture landed in #218 that day). Confirmed intents
begin exactly 2026-08-14 and run at ~99% after (September 106 confirmed vs 1
pending, October 17/17). The lone September pending captured no session id — a
one-off missed hook, a different family from the resumed-launch bug fixed here.

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
END_DOC_BLOCK: [@core:HOOK-02]

## [@core:HOOK-03] Mail delivery reply channel (MAILBOX-DELIVERY-PER-CORE-PUSH)

A mailbox pointer is no longer only a typed nudge. The delivery seam
(`workflow/messageDelivery.ts`) resolves the RECIPIENT's current live core at
delivery time and picks a route:

| route | cores | how the pointer arrives |
|---|---|---|
| `hook-block` | claude, codex | the endpoint answers the core's `Stop` hook with `{decision:"block",reason:"<pointer>"}`; the shared `HOOK_BRIDGE` prints it to stdout, so the agent continues with the pointer as its next instruction |
| `plugin-idle` | opencode v1 | the endpoint answers the plugin's `session.idle` POST with the same body; the plugin reads `.reason` and pushes it through `client.session.promptAsync` |
| `typed` | opencode2, antigravity, unknown/retired | the #56 typed nudge into the live terminal |

The endpoint returns a body **only** for a hook it ADMITTED (known worktree +
current launch generation), so a stale bridge from a retired core gets no reply
and cannot claim delivery. The unread count comes from an in-memory cache; the
reply builder itself performs no DB query. The cache has two writers: the
delivery sweep rebuilds it from the store every tick, and the endpoint tops up
ONE ticket from the store when that ticket's turn ends. `message send` is a
separate CLI process, so that per-turn top-up is what makes a send visible on
the very next `Stop`/`session.idle` instead of waiting for the next sweep. The
bridge bounds the WHOLE invocation at 1.5 s (below codex's 3 s and claude's 5 s
Stop hook timeouts) — a Stop hook can carry a sibling `UsageUpdate` post, and
per-request timeouts alone would let the total stack past the agent's ceiling;
every failure, timeout or dead endpoint is fail-open (exit 0, no stdout). A
non-2xx on a sibling non-reply post is logged but does NOT turn a captured
block into an exit-1 (an agent that ignores stdout on a non-zero exit would
lose it).

A push route is only usable while the recipient is **mid-turn** (`agent_state`
`running`): the reply fires at the END of a turn, so an idle recipient has
already passed its `Stop`/`session.idle` and would never receive one. The sweep
therefore types the pointer into an idle recipient instead. A **graph-owned**
session is deferred by both halves — the sweep does not nudge it, and the
endpoint does not answer its hook (the sweep computes route + graph-owned +
busy in memory each tick and the endpoint reads that set, so the reply path
stays DB-free).

A reply IS that batch's delivery **once it is CONFIRMED received**. Building the
block is not enough, and neither is a flushed response: the endpoint answers 200
but a hung host can write the body into a socket the bridge already abandoned.
So the bridge POSTs a positive `MailReplyAck` (URL carries the launch generation;
the endpoint maps it back to the ticket) ONLY after it has written the block to
stdout, and the endpoint confirms delivery only on that ACK. The sweep skips a
batch only when a confirmation arrived AND the batch's watermark matches, so the
recipient now idle (a block continuation fires no `UserPromptSubmit`) is not
typed a SECOND copy — but a batch whose reply never reached the agent keeps the
typed fallback instead of being stranded. The record is keyed by the batch
watermark, so a genuinely NEW batch that arrives right after the reply is still
delivered promptly. The `session.idle` (plugin) route is never confirmed this
way: the plugin re-pushes through the SDK and does not ACK, and a rejected
`promptAsync` is invisible to the endpoint, so that route relies on the sweep's
idle fallback. The sweep's arm deliberately records nothing: a hook that never
arrives must still fall back to typing (see "A push route is only usable while
the recipient is mid-turn").

Guards (host + bridge): never block when `stop_hook_active` is true — the bridge
forwards the flag so the HOST declines a continuation `Stop` without spending
the batch's one-block budget on a reply the bridge discards; never block a
question turn (`Stop` remapped to `Notification idle_prompt`); and block at most
once per BATCH, keyed by the unread watermark (highest message id), not the
count — reading a batch and receiving a same-sized new one must block again, and
the count alone cannot tell those apart (so a core that does not send
`stop_hook_active` cannot loop either). opencode2 has no SDK client on its plugin
`ctx`, so it is declared on the typed route until one turns up; the reply body
is ignored by its plugin.

**SPIKE-CODEX-STOP-BLOCK (codex-cli 0.153.0, bundled binary): PASS.**
`StopCommandOutputWire` accepts `decision: "block"` + `reason` (the binary
carries `BlockDecisionWire`, `HookEventNameWire`, and the error "Stop hook
requested continuation without a prompt; ignoring the block"), and `reason` is
the continuation prompt. codex therefore takes the `hook-block` route
(`CODEX_STOP_BLOCK_SUPPORTED = true` in `extension.ts`). The route flag only
selects the channel — the shared bridge implements the protocol for both cores.
END_DOC_BLOCK: [@core:HOOK-03]

## [@core:HOOK-04] Rules for a new core

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
END_DOC_BLOCK: [@core:HOOK-04]
