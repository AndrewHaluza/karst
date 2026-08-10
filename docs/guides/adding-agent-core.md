# Adding an Agent Core to Karst

This guide is the implementation contract for adding a coding-agent CLI such as
Codex, Gemini CLI, or another interactive/headless agent to Karst.

The central rule is simple:

> Provider-specific behavior belongs behind `AgentAdapter`. The manifest,
> workflow engine, session manager, approach installer, and UI must not learn a
> provider's flags, output format, plugin layout, or permission vocabulary.

Use the existing Claude and Antigravity adapters as examples, but verify the new
CLI directly. Do not infer one provider's behavior from another provider or from
an old plan.

## 1. Start with CLI research

Before editing production code, inspect the exact CLI version that Karst will
launch. Prefer the installed binary and official documentation.

Record the following in the implementation plan:

- executable name and installation instructions;
- interactive prompt syntax and option ordering;
- non-interactive/headless syntax;
- model-list command and exact model identifiers;
- resume syntax and how Karst can obtain a resumable session identifier;
- permission and sandbox flags;
- working-directory and additional-workspace flags;
- exit-code behavior, stdout/stderr format, and structured-output modes;
- hook/event support and payload format;
- customization discovery roots and supported artifact kinds;
- plugin, skill, command, agent, rule, and MCP layouts;
- whether customizations are discovered from the session working directory or
  require an explicit CLI argument.

Run representative commands such as:

```sh
<cli> --help
<cli> models
<cli> plugin --help
```

Do not add model IDs merely because they look plausible. Model catalogs change
and provider CLIs often use effort-qualified IDs.

## 2. Preserve the architecture boundary

The load-bearing contract is `src/agent/adapter.ts`.

An adapter must provide:

- `requiredBinary`: the exact executable Karst launches;
- `capabilities`: only capabilities that work end-to-end in Karst;
- `buildInteractiveCommand`: terminal command, arguments, and environment;
- `runHeadless`: deterministic non-interactive execution;
- optionally, `materializeApproach`: translation from Karst's neutral approach
  package into the provider's native customization format.

Provider-specific imports and concepts must remain inside `src/agent/<provider>.ts`.
For example, Claude plugin manifests belong in `claude.ts`; Antigravity
`.agents/plugins` paths belong in `antigravity.ts`.

Do not:

- branch on the provider in `SessionManager`, workflow stages, or approach
  installation;
- add provider plugin concepts to `src/approaches/`;
- parse agent prose as a workflow verdict;
- make `vscode` a runtime dependency of adapter logic;
- use synchronous child processes in extension-host execution paths.

## 3. Implement with RED → GREEN tests

Create `src/agent/<provider>.test.ts` before the adapter implementation. Use an
injected spawn seam; tests must never require authentication or invoke the real
agent.

Minimum adapter coverage:

1. executable and truthful capabilities;
2. empty/basic interactive launch;
3. initial prompt, model, resume, settings, and extra-argument ordering;
4. prompts beginning with dashes or containing whitespace/newlines;
5. headless command construction;
6. stdout parsing and session-ID extraction, when available;
7. non-zero exit and spawn-error behavior;
8. approach materialization for every neutral artifact kind;
9. workflow-only and solo-agent materialization;
10. path traversal and reserved-name rejection.

Watch each new test fail for the intended reason before implementing it.

## 4. Build the adapter

Create `src/agent/<provider>.ts` implementing `AgentAdapter`.

### Interactive execution

`buildInteractiveCommand` returns data; it does not launch the process:

```ts
return {
  command: '<binary>',
  args,
  env: {},
};
```

Keep option ordering valid for the provider. Place opaque `extraArgs` where the
CLI accepts options, before a positional prompt or option terminator.

The session manager already scopes the terminal to the ticket worktree. Do not
duplicate terminal or VS Code logic in the adapter.

### Headless execution

Use asynchronous `spawn` with injected execution for tests. Explicitly close or
ignore stdin if the CLI otherwise waits for input.

On a non-zero exit, throw an error that includes the exit code and useful
stderr/stdout. On success, return:

```ts
{
  sessionId: '<parsed id or empty string>',
  verdict: null,
  raw: '<response body>',
}
```

`verdict` remains `null`. Karst transitions stages from deterministic gate
results, never from an agent's self-report.

### Capabilities must describe Karst, not just the CLI

A CLI supporting a resume flag is insufficient to set `resume: true`. Karst
must also capture and persist the interactive session ID.

Likewise, set `httpHooks: true` only when Karst can register hooks, receive the
events it needs, and associate them with the correct ticket/window.

Until the full channel exists, advertise the capability as `false`.

## 5. Translate neutral approaches

Installed approach packages are agent-agnostic:

```text
agents/<name>.md
skills/<name>/SKILL.md
commands/<name>.md
workflow: [...]
```

`materializeApproach` translates these artifacts at launch time. It must not
assume the provider supports all three artifact kinds.

For each kind:

1. confirm the provider's actual discovery location;
2. preserve the entire skill directory, not only `SKILL.md`;
3. translate unsupported concepts to a supported equivalent when semantics are
   clear;
4. otherwise reject the package loudly rather than copying files into an
   undiscoverable directory.

Example: Antigravity has no workspace `commands/` customization surface, so its
adapter wraps neutral commands as skills. Claude preserves commands inside its
plugin.

Generated Karst workflows must still expose:

- fresh ticket context;
- per-phase reporting through the `phase` CLI path;
- the explicit implementation/fix done marker through the restricted `stage`
  CLI path.

Never widen the `stage` parser to accommodate a provider. The separation between
`context`, restricted `stage`, and append-only `phase` is a security boundary.

Treat all names and relative paths as untrusted at the materialization boundary.
Reject absolute paths, separators in agent names, `..` segments, and provider
namespace collisions.

## 6. Register the provider

Update `src/manifest/types.ts`:

```ts
export type AgentProvider = 'claude' | 'codex' | '<provider>';
```

Update and test:

- `src/manifest/schema.ts`: accept the provider and improve the validation
  message;
- `src/manifest/load.test.ts`: load a manifest containing it;
- `karst.example.yml`: document the value;
- `src/agent/registry.ts`: add the factory and list it in
  `IMPLEMENTED_PROVIDERS`;
- `src/agent/registry.test.ts`: verify resolution and implemented-provider
  ordering.

Do not add a provider to `IMPLEMENTED_PROVIDERS` until its adapter is usable.
Unimplemented manifest values remain disabled in settings.

## 7. Add dependency detection

Add a confirmed entry to `AGENT_CLI_DEPENDENCIES` in `src/runtime/deps.ts`:

```ts
<provider>: {
  binary: '<binary>',
  label: 'the <Provider> CLI',
  install: 'Actionable official installation guidance.',
  enables: 'sessions',
},
```

Test that:

- the dependency resolves for the provider;
- its binary equals `resolveAdapter(provider).requiredBinary`;
- missing/not-ready states flow through the existing dependency registry.

Do not guess an installation URL. Use the generic fallback until official
guidance is confirmed.

## 8. Scope models by provider

Add exact IDs to `KNOWN_MODELS` in `src/agent/models.ts`, with the provider that
accepts each ID. Update the mirrored list in
`src/ui/settings/webview.html`; webviews cannot import TypeScript.

Provider changes create two compatibility problems:

- the manifest default may belong to the old provider;
- existing tickets may retain provider-specific model overrides.

The UI must show only compatible curated models and clear an incompatible
default when the provider changes. The launch boundary must use
`resolveModelForProvider`, which skips known incompatible IDs while preserving
unknown IDs for deliberate preview/custom models.

Update ticket-form state tests and model tests. Verify both directions of a
provider switch.

## 9. Wire settings and the ticket form

The settings webview mirrors all legal provider values and receives
`implementedProviders` to decide which are enabled.

Verify:

- the new provider renders enabled;
- unimplemented providers remain disabled;
- selecting and saving the provider round-trips through `writeManifest`;
- dependency checks use the selected provider's binary;
- model options update when the provider changes;
- an incompatible default is not silently retained;
- ticket-form models are filtered to the active provider.

Remember that source webview assets are copied into `dist/` by the build. Edit
the source HTML, never the generated copy.

## 10. Provider integration checklist

### Research

- [ ] Exact installed CLI behavior verified.
- [ ] Official installation guidance confirmed.
- [ ] Model IDs obtained from the CLI or official source.
- [ ] Customization/plugin discovery tested.
- [ ] Resume and hook data paths understood end-to-end.

### Adapter

- [ ] Interactive command implemented and tested.
- [ ] Headless command implemented and tested.
- [ ] Non-zero exits and spawn errors handled.
- [ ] Capabilities are truthful at the Karst level.
- [ ] No provider logic leaked outside the agent boundary.

### Approaches

- [ ] Agent artifacts discoverable.
- [ ] Whole skill folders preserved.
- [ ] Command artifacts supported, translated, or rejected.
- [ ] Workflow-only packages discoverable.
- [ ] Solo agents discoverable.
- [ ] Traversal and namespace collisions rejected.

### Wiring

- [ ] Manifest type/schema/example updated.
- [ ] Registry and implemented-provider list updated.
- [ ] Dependency registry updated.
- [ ] Provider-scoped models updated in TypeScript and settings HTML.
- [ ] Settings and ticket-form flows tested.

### Verification

- [ ] Focused adapter/registry/dependency/model tests pass.
- [ ] `npm run typecheck` passes.
- [ ] `npm test` passes.
- [ ] `npm run build` passes.
- [ ] F5 Extension Host launches the provider in a real ticket worktree.
- [ ] Initial ticket context reaches the agent.
- [ ] Installed approaches are visible to the agent.
- [ ] Done/phase markers update Karst state.
- [ ] Missing CLI produces actionable setup guidance.

## 11. Codex implementation notes

Codex is implemented as the reference for extending Karst beyond Claude and
Antigravity. Its integration verified the installed CLI rather than copying
another provider's flags.

In particular, determine:

- the correct interactive seed-prompt form;
- the supported non-interactive command and output schema;
- whether thread/session IDs are emitted and resumable;
- approval and sandbox flags and how they relate to Karst's permission policy;
- native discovery locations for `AGENTS.md`, skills, agents, and commands;
- whether an additional directory or configuration argument is required;
- the live model list and whether models are account-dependent.

Four integration rules proved especially important:

- Resolve the adapter when an operation starts, not once at extension
  activation, so a saved provider change applies to interactive and headless
  work.
- Keep the lifecycle endpoint provider-neutral. Each adapter owns the concrete
  hook configuration and normalization for its CLI.
- Write generated hook bridges and settings into `HookChannel.configDir`, not
  the repository or worktree. Runtime hook plumbing must never appear in a
  ticket diff even when a session exits abnormally.
- Return the provider-native workflow invocation from approach
  materialization; the extension must not guess slash-command or skill syntax.
- Return exact adapter-owned runtime paths and clean only those paths under
  reserved Karst roots. Never remove repository-owned `.agents` or `.codex`
  content.
- Treat Karst-created worktrees and Karst-generated hooks as trusted at the
  adapter boundary using the provider's narrow, purpose-built flags. Clear
  inherited hooks before bypassing hook trust so only the complete,
  Karst-authored event set can execute. A
  headless launch must not stop before consuming its prompt merely because the
  provider has not persisted trust for the new worktree, and generated
  lifecycle hooks must not require a separate manual trust ceremony.
- Karst's agent-facing CLI records stage and phase evidence in a shared
  global-storage registry outside the worktree. Do not grant the agent sandbox
  write access to that directory: it would let injected commands bypass the
  CLI's narrow parser and alter other projects. Tell the agent to request
  approval for the exact marker command outside the workspace sandbox instead.

## 12. Common failure modes

- **Plausible but invalid models:** UI looks correct; launch fails immediately.
- **Capability inflation:** CLI has a flag, but Karst cannot supply the required
  ID or receive the required event.
- **Undiscoverable customization files:** tests assert that files exist without
  proving their paths match the provider contract.
- **Cross-provider ticket models:** changing providers leaves old ticket
  overrides that are passed to the new CLI.
- **Silent artifact loss:** neutral commands or agents are copied into a layout
  the provider ignores.
- **Provider leakage:** session/UI/workflow code starts branching on provider
  names, weakening the adapter seam.
- **Blocking extension host:** synchronous process execution freezes hooks,
  webviews, and all sessions.
- **Unsafe materialization:** a name or relative path escapes the session
  customization directory.
- **Trust gate before prompt consumption:** a newly-created worktree causes a
  headless launch to exit before the supplied prompt runs.
- **Read-only control plane:** the agent can edit its worktree but cannot write
  Karst's registry, so explicit stage and phase markers fail.

When one of these appears, fix the abstraction or boundary test. Do not patch a
provider special case into the extension host.

## 13. OpenCode implementation notes

OpenCode is the second reference integration and differs sharply from Claude,
Antigravity, and Codex.

- OpenCode is server-first; the TUI is the interactive surface, `opencode run --format json` is headless (NDJSON).
- There is no CLI hook flag; lifecycle bridging is a generated plugin (Task 7): the adapter writes `.opencode/plugins/karst-bridge.js` beneath the worktree and launches WITHOUT `--pure` — opencode's `--pure` disables ALL external plugin loading, including the auto-discovered karst-bridge, so an interactive session launched with it can never deliver a hook event (869eg458d). The plugin POSTs `session.idle`/`session.error`/`permission.asked` (and question asks, normalized to `permission.asked`) to the loopback endpoint; the adapter advertises `lifecycleEvents: true` only because the channel ships with it. Headless `opencode run` still passes `--pure` for gate isolation.
- The TUI's `--prompt` prefills but does not auto-submit (interactive gap vs Claude/Codex).
- Materialization uses `.opencode/` (opencode's primary discovery root); opencode ALSO reads `.agents/skills/` and `.claude/skills/`, so codex/claude materialization is incidentally discoverable, but opencode keeps its own tree clean.
- Models are discovered live via `opencode models` (plain format, one `provider/model` ID per line). The bundled catalog is intentionally empty — CLI discovery is the primary source. Custom model IDs are always accepted by the resolution layer.
- Token usage is adapter-parsed from `step_finish.part.tokens` (keys `input`/`output`/`total` don't match the shared extractor); the adapter owns `parseOpencodeJsonl` like Codex owns `parseCodexJsonl`.

## 14. Antigravity implementation notes

Antigravity (agy 1.1.11, Go binary) was verified against the installed CLI
rather than its docs.

- **Hooks do not execute in the CLI.** agy ships a full hooks system
  (`hooks.json` at `<appdata>/hooks.json` AND `<workspace>/.agents/hooks.json`,
  merged; events PreToolUse/PostToolUse/PreInvocation/PostInvocation/Stop;
  stdin JSON payloads with `conversationId`/`workspacePaths`; `ask`/`allow`/
  `deny`/`force_ask` decisions). The CLI LOADS the files ("loaded 4 named hooks
  from 2 hooks.json file(s)") but NEVER RUNS the commands — verified across
  print and interactive sessions, allowed and permission-requiring tools. The
  hook machinery is wired for the IDE/Antigravity-2.0 surface (the
  model-mediated "call the 'finish' tool to submit your hook decision" path and
  `policyguardian: NewHooks called with nil modelAPI` in the binary). Do NOT
  build a bridge on it — a silent no-op is a fake signal.
- **The lifecycle channel is the conversation DB.** The CLI writes
  `<appdata>/conversations/<conv-id>.db` (SQLite). While a permission dialog
  ("Allow creation of this file?") is on screen, the conversation has a
  `steps` row with `status = 9` (pending user decision); answering resolves it
  to `status = 3`. The `trajectory_metadata_blob` row (`id='main'`) carries the
  workspace path as `file://<path>` bytes, which locates the conversation for a
  ticket's worktree. Karst's `agyConversationWatch` sweep reads this state
  read-only and normalizes it into the closed hook vocabulary
  (`SessionStart` / `permission.asked` / `UserPromptSubmit`) through the same
  `dispatchHook` seam as the HTTP endpoint. `--conversation <id>` resumes a
  session (verified: the CLI prints `agy --conversation=<id>` on exit).
- `ANTIGRAVITY_CONVERSATION_ID` exists in the binary but is NOT set on the CLI
  process environment — do not rely on it for discovery.
- The `-p` (print/headless) mode runs no hooks and writes no conversation DB;
  headless `sessionId` stays `''`.
- Capabilities: `lifecycleEvents: true` and `resume: true` (the watch delivers
  both), `interactiveUsage: false` (no usage channel exists — never a measured
  zero).
