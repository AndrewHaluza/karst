# Codex Agent Core Design

**Status:** Approved design  
**Date:** 2026-07-24  
**Target:** Codex CLI 0.145.0 and Karst's `AgentAdapter` boundary

## Goal

Make Codex a first-class Karst agent core with the same usable lifecycle as
Claude: interactive ticket sessions, deterministic headless runs, approach
materialization, lifecycle state, session-ID capture, and resume.

The implementation must also repair the current provider-selection path. Karst
constructs a Claude adapter during activation, so registering another adapter
does not currently switch the session and workflow execution paths.

## Evidence

The design was checked against the locally installed `codex-cli 0.145.0` and
current OpenAI Codex documentation on 2026-07-24.

- `codex [OPTIONS] [PROMPT]` starts an interactive session.
- `codex resume [OPTIONS] [SESSION_ID] [PROMPT]` resumes an interactive session.
- `codex exec --json [PROMPT]` emits JSONL, including
  `thread.started.thread_id` and completed agent-message items.
- `codex exec resume [SESSION_ID] [PROMPT]` resumes a non-interactive session.
- Repository skills are discovered below `.agents/skills` from the current
  directory through the repository root.
- Codex command hooks receive JSON on stdin. Common fields include `session_id`,
  `cwd`, and `hook_event_name`.
- Project hooks can be loaded from `.codex/hooks.json` or `.codex/config.toml`
  after the project layer is trusted.
- Codex accepts `--model`, but this CLI version has no model-list command.

Official references:

- <https://developers.openai.com/codex/skills>
- <https://learn.chatgpt.com/docs/hooks>
- <https://learn.chatgpt.com/docs/non-interactive-mode>
- <https://developers.openai.com/codex/config-advanced>

## Chosen Approach

Use the native Codex CLI with repository-local skills and a Karst-owned command
hook bridge.

This preserves Karst's terminal workflow and keeps Codex behavior behind the
agent boundary. It avoids installing a user-global Codex plugin and avoids the
much larger app-server integration.

Two alternatives were rejected:

1. An ephemeral Codex plugin would require marketplace or installed-plugin
   state outside the ticket session.
2. App Server would replace the terminal execution architecture and require
   approval UI, protocol lifecycle, reconnection, and process ownership beyond
   the agent-core scope.

## Architecture

### 1. Resolve the provider at operation time

Karst must not retain one activation-time adapter.

The current manifest provider is resolved when Karst:

- opens an interactive ticket session;
- materializes an approach;
- runs a headless workflow stage;
- evaluates the selected CLI dependency.

`SessionManager` receives the chosen adapter for a new session instead of
capturing a single adapter in its constructor. An already-open terminal remains
bound to the adapter with which it was created.

Tests must prove that a Codex or Antigravity manifest never launches `claude`.

### 2. Make the session contract provider-neutral

The shared adapter input must expose the local hook endpoint, not a Claude
settings-file path:

```ts
export interface HookChannel {
  endpointUrl: string;
}

export interface InteractiveCommandOpts {
  cwd: string;
  hookChannel?: HookChannel;
  resume?: string;
  initialPrompt?: string;
  model?: string;
  extraArgs?: string[];
}
```

Each adapter owns its concrete hook registration:

- Claude creates and passes its `--settings` file.
- Codex creates its command-hook configuration.
- Antigravity ignores the channel while lifecycle integration is unavailable.

The existing `/hooks` endpoint remains provider-neutral. It accepts Karst's
small normalized payload rather than provider-specific wire formats.

### 3. Move workflow invocation behind materialization

The extension must not build `/karst:<id>` before it knows the provider.

`Materialized` becomes:

```ts
export interface Materialized {
  extraArgs: string[];
  invocation?: string;
  ownedPaths?: string[];
}
```

Materialization happens before seed composition. The extension supplies
`materialized.invocation` to `buildSessionSeed`.

Expected provider-native forms are:

- Claude: `/karst:<approach> <ticket-key>`
- Codex: `$karst-<approach> <ticket-key>`
- Antigravity: its discoverable skill invocation

The workflow body continues to use the existing restricted `context`, `stage`,
and `phase` CLI prefixes. Provider integration must never widen those parsers.

### 4. Add `CodexAdapter`

`src/agent/codex.ts` implements `AgentAdapter`.

#### Interactive launch

A fresh session uses:

```text
codex [provider options] <initial-prompt>
```

A resumed session uses:

```text
codex resume [provider options] <session-id> <resume-prompt>
```

The adapter:

- passes `--model <id>` only when a model is resolved;
- preserves prompts beginning with `-` as data rather than options;
- keeps opaque materialization arguments before positional arguments;
- maps Karst's permission policy only to documented Codex approval/sandbox
  options;
- never adds `--dangerously-bypass-approvals-and-sandbox`;
- never adds `--dangerously-bypass-hook-trust`.

Karst already sets the terminal working directory to the ticket worktree, so
`--cd` is unnecessary.

#### Headless launch

A new run uses:

```text
codex exec --json [options] <prompt>
```

A resumed run uses:

```text
codex exec resume --json [options] <session-id> <prompt>
```

The adapter uses asynchronous `spawn` with ignored stdin and captured
stdout/stderr. It parses stdout one JSONL record at a time.

Successful parsing requires:

- one usable `thread.started.thread_id`;
- a completed final `agent_message`;
- no `turn.failed` or top-level `error` event;
- process exit code zero.

The result is:

```ts
{
  sessionId: threadId,
  verdict: null,
  raw: finalAgentMessage,
}
```

Malformed JSONL, missing required events, a spawn error, or nonzero exit is a
loud error containing bounded diagnostic output. Agent prose never becomes a
workflow verdict.

### 5. Materialize Codex approaches as repository skills

Karst writes only beneath reserved names:

```text
.agents/skills/karst-<approach>/
.agents/skills/karst-agent-<agent-name>/
.codex/karst/
```

Artifact mapping:

| Neutral artifact | Codex representation |
| --- | --- |
| `skills/<name>/...` | A preserved Codex skill directory |
| `commands/<name>.md` | A generated Codex skill with the command body |
| `agents/<name>.md` | A generated delegation-oriented Codex skill |
| Solo agent | A generated delegation skill plus explicit seed invocation |
| Workflow | A generated `karst-<approach>` skill |

Karst does not modify `AGENTS.md`; it is durable repository policy owned by the
user.

Every generated skill has valid frontmatter with a safe, deterministic name.
Materialization rejects absolute paths, traversal, separators in logical names,
reserved-name collisions, and destinations outside Karst's owned roots.

The adapter returns the exact paths it created. Session cleanup may replace or
remove only those paths. It must never recursively delete `.agents`, `.codex`,
or repository-owned sibling content.

Cleanup occurs when the terminal closes and before a same-ticket
rematerialization. Failure to clean up is logged but must not block the
extension host.

### 6. Bridge Codex lifecycle events

Codex supports command hooks rather than Claude's native HTTP hook entries.
Karst generates a small provider-owned bridge that:

1. reads one JSON object from stdin;
2. validates the event fields it consumes;
3. maps the Codex event to Karst's normalized payload;
4. POSTs the normalized JSON to the per-window loopback endpoint;
5. exits quickly without returning model-visible content.

Event mapping:

| Codex event | Karst normalized event | State effect |
| --- | --- | --- |
| `SessionStart` | `SessionStart` | Persist `session_id`; running |
| `UserPromptSubmit` | `UserPromptSubmit` | Running |
| `PostToolUse` | `PostToolUse` | Running |
| `PermissionRequest` | `Notification` with `permission_prompt` | Waiting |
| `Stop` | `Stop` | Idle |
| `SessionEnd` | `SessionEnd` | Idle |

The bridge forwards only `session_id`, `cwd`, normalized `hook_event_name`, and
an optional normalized `message`. It does not forward prompts, tool input,
transcripts, assistant messages, or credentials.

Hook failures must not transition workflow stages. Terminal-close recovery and
activation sweeps remain the fallback when lifecycle delivery is unavailable.

### 7. Preserve Codex trust

Project-local Codex hooks require normal project trust. Karst does not bypass
that decision.

The UX must explain that Codex lifecycle tracking and resume become active
after the generated project hook is trusted. If a session starts without a
`SessionStart` delivery, the terminal remains usable but Karst must not claim a
captured resume ID.

`capabilities.resume` and lifecycle capability are true because the complete
supported path exists, while runtime state continues to depend on whether a
session ID was actually captured.

The misleading `httpHooks` capability should be renamed to
`lifecycleEvents`. It describes Karst-visible lifecycle delivery, not the
provider's transport.

### 8. Models and dependencies

Codex receives a confirmed dependency entry:

```ts
{
  binary: 'codex',
  label: 'the OpenAI Codex CLI',
  install: 'Install Codex from the official OpenAI Codex CLI instructions, then reload the window.',
  enables: 'sessions',
}
```

No speculative Codex model identifiers are added. The settings UI initially
offers “No default (agent picks)” for Codex. Explicit unknown/custom model IDs
remain valid through `resolveModelForProvider`.

Curated Codex models may be added separately when their exact CLI identifiers
and availability policy have an authoritative, maintainable source.

## Error Handling

- Missing `codex` is reported by the existing dependency registry before a
  session starts.
- Invalid CLI argument construction is covered by adapter unit tests.
- A headless failure throws and includes bounded stderr/stdout.
- A malformed hook payload is ignored by the endpoint.
- An unknown worktree never mutates a ticket.
- Missing hook trust degrades lifecycle tracking, not the terminal session.
- Materialization failure opens the session with ticket context only and emits
  the existing approach warning.
- Cleanup touches only returned `ownedPaths`.
- No provider operation uses synchronous child-process execution in the
  extension host.

## Testing Strategy

Implementation follows strict RED to GREEN.

### Provider-selection tests

- Manifest `agentProvider` selects the matching adapter for interactive launch.
- The same provider reaches headless stages.
- Changing the saved provider affects new sessions without extension restart.
- Existing open terminals are focused rather than relaunched with a new
  provider.

### Codex adapter tests

- Binary and truthful capabilities.
- Fresh and resumed interactive argument ordering.
- Model, permission, extra-argument, empty-prompt, dash-prefixed prompt, and
  multiline prompt cases.
- Fresh and resumed headless commands.
- JSONL thread ID and final-message extraction.
- Malformed JSONL, missing thread, missing message, error event, failed turn,
  nonzero exit, and spawn error.
- Output diagnostics are bounded.

### Materialization tests

- Preserve complete skill folders.
- Convert commands and agents to valid skills.
- Generate workflow and solo-agent skills.
- Produce the correct `$karst-<approach> <ticket>` invocation.
- Reject traversal and reserved collisions.
- Preserve repository-owned `.agents` and `.codex` content.
- Clean only paths owned by the materialization result.

### Hook tests

- Generate valid Codex hook configuration.
- Normalize each supported event.
- Persist Codex `session_id` from `SessionStart`.
- Map `PermissionRequest` to waiting.
- Never infer a stage transition from `Stop` or `SessionEnd`.
- Do not forward sensitive event fields.
- Failures do not block the event loop.

### Registration and UI tests

- Registry resolves `codex` to `CodexAdapter`.
- `IMPLEMENTED_PROVIDERS` includes Codex only after the adapter is usable.
- Dependency entry uses the same binary as the adapter.
- Settings enables Codex.
- Codex has no speculative curated model rows.

### Verification

Run:

```text
npx vitest run <focused test files>
npm run typecheck
npm test
npm run build
```

Manual F5 verification must prove:

1. selecting Codex launches `codex`, not `claude`;
2. the initial ticket context reaches Codex;
3. the generated workflow skill is discoverable and invokes the Karst CLI;
4. `SessionStart` captures the Codex session ID after normal trust;
5. closing and reopening an implementation or fix session resumes it;
6. permission requests produce the waiting state;
7. done and phase markers update Karst deterministically;
8. generated runtime artifacts are absent after terminal cleanup.

## Non-Goals

- Replacing terminal sessions with Codex App Server.
- Installing or managing user-global Codex plugins.
- Bypassing Codex approval, sandbox, or hook-trust policy.
- Dynamically discovering account-specific models.
- Modifying user-owned `AGENTS.md`.
- Parsing agent prose as a stage verdict.
- General refactoring unrelated to provider selection and session
  materialization.
