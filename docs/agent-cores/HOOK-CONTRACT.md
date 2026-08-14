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
| channel | `--settings` file (`settings.ts`) | generated `bridge.cjs` | generated `.opencode/plugins/karst-bridge.js` | **none** — conversation-DB watch |
| SessionStart | `type:command` curl bridge | native | `session.created` | synthesized per conversation |
| permission asked | `Notification` | `Notification: permission_prompt` | `permission.asked` / `question.asked` (+ v2) | `steps.status = 9` |
| ask resolved | `UserPromptSubmit` | `UserPromptSubmit` | `permission.replied` / `question.replied` | status 9 clearing |
| running | `PostToolUse` | `PostToolUse` | `session.status: busy\|retry` | — |
| end | `Stop` / `SessionEnd` | `Stop` / `SessionEnd` | `session.idle` + terminal close | terminal close |
| usage | session transcript (`claudeTranscriptWatch.ts`) | bridge `UsageUpdate` | bridge `UsageUpdate` | conversation DB (`agyUsageWatch.ts`) |
| endpoint rebind after reload | ✗ (declared) | ✓ | ✓ | n/a (no channel) |

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
