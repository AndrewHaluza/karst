# Codex Hook Bridge Reliability Design

## Goal

Karst-enabled hooks in Codex ticket sessions must deliver lifecycle events
without producing false `SessionStart hook (failed)` or `PostToolUse hook
(failed)` messages. Successful events must retain their existing ticket-state
side effects. Expected local endpoint races must not disrupt Codex, while
malformed invocations and bridge defects must remain observable.

## Context

Karst installs session-scoped Codex command hooks through CLI configuration and
uses `--dangerously-bypass-hook-trust` because those definitions are generated
and vetted by Karst. Each hook starts a standalone Node process, reads Codex's
JSON object from stdin, normalizes the event, and posts a narrow payload to the
extension host's loopback endpoint.

Two earlier mitigations resolved specific failure modes:

- The bridge uses a standalone Node executable instead of the Electron-based
  extension host executable.
- Network and asynchronous bridge failures currently exit successfully to
  prevent stale endpoints from surfacing as hook failures.

The existing regression test covers only an unreachable endpoint. It does not
prove that a real `SessionStart` or `PostToolUse` invocation reaches Karst and
terminates successfully. The current blanket fail-open behavior also treats
malformed input and invalid configuration like an expected stale endpoint,
which hides genuine integration defects.

## Design

### Bridge lifecycle

The generated bridge remains a standalone CommonJS script under Karst's
per-window configuration directory. Codex continues to receive absolute,
shell-quoted paths to both the Node executable and bridge.

The bridge will:

1. Read at most 64 KiB of UTF-8 JSON from stdin.
2. Validate the common Codex fields `hook_event_name`, `cwd`, and `session_id`.
3. Map supported Codex events to the existing Karst hook payload.
4. POST the normalized payload to the configured loopback endpoint.
5. Consume the response and terminate with exit code 0 once it completes.

Explicit completion after the response prevents the hook process from remaining
alive until Codex's three-second command timeout.

### Failure classification

Failures are divided by whether they represent an expected lifecycle race:

- An endpoint that is unavailable, closes early, or times out is expected when
  an IDE window reloads or closes while a Codex session still exists. The bridge
  records a sanitized diagnostic and exits 0 so it does not disrupt the session.
- Oversized stdin, malformed JSON, missing or wrongly typed required fields,
  an invalid endpoint argument, and unexpected bridge exceptions are genuine
  invocation or implementation errors. The bridge records a sanitized
  diagnostic and exits nonzero so Codex reports the hook failure.
- Unsupported event names are ignored with exit 0. Karst installs only its
  supported set, and ignoring an unknown future event preserves forward
  compatibility without mutating ticket state.

Diagnostics remain append-only JSON lines capped at 64 KiB. They contain the
event name and a symbolic outcome, never the working directory, session id,
tool input, or response content.

### Hook trust and existing behavior

Karst will continue clearing inherited session-level hooks before installing
its complete generated hook set. `--dangerously-bypass-hook-trust` therefore
authorizes only Karst-authored command definitions for that launch.

Event normalization and side effects do not change:

- `SessionStart` posts the session id and moves the ticket agent state to
  running.
- `PostToolUse` moves a waiting ticket back to running.
- `PermissionRequest` maps to Karst's permission notification.
- The remaining supported lifecycle events keep their existing mappings.

## Regression coverage

Subprocess tests will execute the generated bridge with representative Codex
stdin payloads rather than testing only the TypeScript normalizer.

- A real loopback server receives `SessionStart`; the bridge exits 0 and the
  received JSON contains the normalized event, cwd, and session id.
- The same round trip is covered for `PostToolUse`, including realistic
  event-specific fields that the bridge intentionally discards.
- An unavailable loopback endpoint produces exit 0 and a sanitized diagnostic.
- Malformed JSON and missing required common fields produce a nonzero exit and
  a sanitized diagnostic.
- Generated launch arguments retain the hook-trust bypass, clear inherited
  hooks, point at standalone Node, and install all supported events.

Targeted Codex adapter tests run first during RED and GREEN. Completion requires
the full test suite, typecheck, and build.

## Non-goals

- Replacing Codex command hooks with `curl` or another platform-specific tool.
- Moving generated bridge files into ticket worktrees.
- Changing the hook endpoint protocol or ticket-state machine.
- Making hook delivery durable across a closed IDE window.
