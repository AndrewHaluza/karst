# OpenCode Agent Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the OpenCode CLI (`opencode`, v1.18.14) a first-class Karst agent core with provider-correct interactive (TUI) and headless (`opencode run --format json`) execution, repository-local approach materialization into `.opencode/` (skills/agents/commands), honest capabilities, and provider-scoped model routing — without leaking opencode concepts past the `AgentAdapter` seam.

**Architecture:** OpenCode is **server-first**: the TUI (`opencode`) is a client to an internal HTTP server, and headless runs (`opencode run --format json`) emit NDJSON events to stdout. Unlike Claude/Codex, OpenCode has **no CLI flag to register lifecycle hooks** — hooks are JS/TS plugin files discovered from `.opencode/plugins/`. The adapter therefore ships with truthful, conservative capabilities (`lifecycleEvents: false`, `resume: false` initially) and materializes approaches into opencode's native `.opencode/skills/`, `.opencode/agents/`, `.opencode/commands/` tree. A follow-up task adds a generated `.opencode/plugins/karst-bridge.js` plugin to bridge lifecycle events into Karst's existing loopback hook endpoint — the opencode-native equivalent of Codex's `bridge.cjs`.

**Switch-surface coverage (every place an agent core / model is chosen):** `AgentProvider` is consumed by exhaustive `Record<AgentProvider, …>` maps and hardcoded provider arrays across the codebase, so widening the type touches every one. The plan covers: (1) **Settings** manifest default provider + defaultModel; (2) **Ticket form** per-ticket provider + model dropdowns (host-driven via `IMPLEMENTED_PROVIDERS` — no HTML change, only catalog/state); (3) **Dashboard "Switch agent…"** host-owned QuickPick (`sessionSwitch.ts` `PROVIDER_LABELS` + `agentSwitchProviderChoices`); (4) **Diagnostics** row-type unions; (5) **Model catalog loader** per-provider discovery probes; (6) **Follow-up ticket** copy (`createFollowUpTicket` copies `parent.agentProvider`/`model` — already provider-neutral, just verify); (7) **Headless stages** (all take an injected `currentAgentAdapter(ticketId)` — already provider-neutral, just verify). The CLI verbs (`context`/`stage`/`phase`) and sidebar have no provider/model switch and need no change.

**Tech Stack:** TypeScript 5, Node.js `child_process.spawn` (async, never sync on the host path) and `fs`/`path` APIs, Vitest, VS Code terminal API, OpenCode CLI 1.18.14.

## Global Constraints

- Follow strict RED → GREEN TDD. Run each named test before and after its implementation.
- Do not add `opencode` to `IMPLEMENTED_PROVIDERS` until the adapter, materialization, and provider routing are all usable (Task 7).
- Do not parse agent prose as a workflow verdict; every OpenCode headless result returns `verdict: null`.
- Do not use synchronous child processes on any extension-host execution path (guard: `gates/run.test.ts` "leaves the event loop free while the child runs").
- Provider-specific behavior stays inside `src/agent/opencode.ts`. Do not branch on the provider in `SessionManager`, workflow stages, approach installation, or the UI.
- Do not add speculative opencode model IDs to the curated picker. OpenCode model IDs are `provider/model` and account/provider-dependent; preserve unknown/custom IDs only.
- Edit source webview assets only, never `dist/` copies.
- Keep `context`, restricted `stage`, and append-only `phase` CLI parsing unchanged.
- Keep ESM `.js` import suffixes and satisfy `noUncheckedIndexedAccess` (array access needs `!` or a guard).
- Generated paths must remain beneath reserved Karst roots; cleanup removes only paths returned as owned by materialization. Add `.opencode` to `OWNED_PREFIXES` so adapter-owned materialization is deletable.
- Do not modify repository-owned `AGENTS.md` (OpenCode reads it from cwd as rules — leave it to the repo).

## Researched OpenCode Contract

Verified locally with `opencode 1.18.14` on 2026-08-06. The CLI is server-first: `opencode` (no args) starts the TUI + an internal server; `opencode run` is the non-interactive path.

```text
opencode [project]                       # TUI (default); [project] is a PATH, NOT a prompt
opencode run [message..]                  # headless; message.. is the prompt
opencode run --format json [message..]    # headless, NDJSON events to stdout
opencode run --format json --session <id> [message..]   # resume headless
opencode run --format json --model <provider/model> [message..]
opencode run --format json --auto [message..]           # auto-approve (bypassPermissions equiv)
```

Interactive (TUI) flags relevant to Karst: `--model <provider/model>`, `--agent <name>`, `--prompt <text>` (**prefills** the TUI prompt; does NOT auto-submit — documented gap vs Claude/Codex), `-s`/`--session <id>`, `-c`/`--continue`, `--auto`, `--title <name>`. The TUI does NOT print its session id to stdout → interactive resume capture is not available → `resume: false`.

### Headless NDJSON event schema (`opencode run --format json`)

One JSON object per line on **stdout** (stderr carries logs only). Verified:

```json
{"type":"step_start","timestamp":1786011591431,"sessionID":"ses_02969edadffe7NKE9JdtJ5713e","part":{"id":"prt_...","messageID":"msg_...","sessionID":"ses_...","type":"step-start"}}
{"type":"text","timestamp":...,"sessionID":"ses_...","part":{"id":"prt_...","type":"text","text":"HELLO","time":{"start":...,"end":...}}}
{"type":"step_finish","timestamp":...,"sessionID":"ses_...","part":{"id":"prt_...","reason":"stop","type":"step-finish","tokens":{"total":16318,"input":16312,"output":6,"reasoning":0,"cache":{"write":0,"read":0}},"cost":0.012261}}
{"type":"error","timestamp":...,"sessionID":"ses_...","error":{"name":"UnknownError","data":{"message":"...","ref":"err_..."}}}
```

- `sessionID` (string) is on every event → headless resume ID is capturable.
- The agent's text answer is `part.text` on `type:"text"` events (last one wins; concatenate if multiple).
- Token usage is `part.tokens` on `step_finish`: `{total, input, output, reasoning, cache:{write, read}}`. **These keys (`input`/`output`/`total`) are NOT matched by the shared `extractTokenUsage`** (which looks for `input_tokens`/`prompt_tokens`/etc.). The adapter therefore parses its own NDJSON and maps tokens into the `TokenUsage` shape directly — the same ownership pattern as Codex's `parseCodexJsonl`, keeping the shared extractor generic (the `tokenUsage.ts` comment: "the module deliberately does NOT branch on the core").
- Exit code: `0` on success, non-zero (observed `1`) on error. The `type:"error"` event names the failure; the adapter surfaces it via `describeHeadlessFailure`.

### Customization discovery (walked cwd → git worktree; global too)

- **Skills**: `.opencode/skills/<name>/SKILL.md`, `.claude/skills/<name>/SKILL.md`, `.agents/skills/<name>/SKILL.md` (all three — note codex's `.agents/skills/` overlaps; opencode materialization uses `.opencode/` to stay clean).
  - SKILL.md frontmatter: `name` (required; regex `^[a-z0-9]+(-[a-z0-9]+)*$`, 1–64 chars, must match dir name), `description` (required, 1–1024 chars), optional `license`/`compatibility`/`metadata`.
- **Agents**: `.opencode/agents/<name>.md` with frontmatter `description` (required), `mode` (`primary`/`subagent`/`all`), `model`, `prompt`/body, `permission`.
- **Commands**: `.opencode/commands/<name>.md` with frontmatter `description`, `agent`, `model`, `subtask`; body is the template with `$ARGUMENTS`. Invoked as `/<name> $ARGUMENTS`. Built-ins like `/init`, `/share` exist; custom names override built-ins.
- **Rules**: `AGENTS.md` (and `CLAUDE.md` fallback) at cwd / global `~/.config/opencode/AGENTS.md`.
- **Plugins** (the ONLY hook surface): `.opencode/plugins/*.js` / `*.ts` (or `~/.config/opencode/plugins/`), or npm packages via config `plugin: []`. A plugin exports a function returning a hooks object keyed by event names: `session.idle`, `session.error`, `session.status`, `permission.asked`, `message.updated`, `tool.execute.before/after`, etc. Plugins run under **Bun** in the opencode server process and may use the `client` SDK + `$` shell.

### Permissions / sandbox

- `--auto` (global + `run` flag): auto-approve permissions not explicitly denied — the `bypassPermissions` equivalent. Headless `run` WITHOUT `--auto` still completes for simple prompts (verified), so gate `--auto` on `permissionMode === 'bypassPermissions'` (mirroring Codex's gated `--ask-for-approval never`).
- No `--skip-git-repo-check` / trust-ceremony gate: opencode operates on any cwd; a fresh worktree does NOT block prompt consumption.
- Config-level `permission` block is the authority; Karst must not author one (would override the user). Karst's generated plugin is the sole hook authority it introduces.

Official references:

- <https://opencode.ai/docs/cli/> (commands + flags)
- <https://opencode.ai/docs/config/> (config locations, schema, merge precedence)
- <https://opencode.ai/docs/agents/> / <https://opencode.ai/docs/commands/> / <https://opencode.ai/docs/skills/> (discovery)
- <https://opencode.ai/docs/plugins/> (plugin hook surface — events list)
- <https://opencode.ai/docs/server/> / <https://opencode.ai/docs/sdk/> (server-first architecture, SSE events)

## File Map

**Create**

- `src/agent/opencode.ts` — OpenCode commands, NDJSON parsing, token mapping, and approach materialization into `.opencode/`.
- `src/agent/opencode.test.ts` — OpenCode adapter unit tests (injected spawn seam; never invokes the real CLI or requires auth).

**Modify**

- `src/agent/registry.ts` and `src/agent/registry.test.ts` — register `opencode` after usable; add to `IMPLEMENTED_PROVIDERS` (Task 7).
- `src/agent/provider.ts` — `IMPLEMENTED_PROVIDERS` gains `'opencode'`; `resolveProvider` fallback chain unchanged (still `?? 'claude'`).
- `src/manifest/types.ts` — widen `AgentProvider` to include `'opencode'`.
- `src/manifest/schema.ts` — accept `'opencode'` in `validateAgentProvider` with an improved message.
- `src/manifest/load.test.ts` — load a manifest with `agentProvider: opencode`.
- `src/manifest/write.ts` — `agentProvider` overlay already defaults to `'claude'`; no change needed (verify round-trip).
- `src/runtime/deps.ts` and `src/runtime/deps.test.ts` — confirmed `opencode` dependency entry.
- `src/agent/models.ts`, `src/agent/models.test.ts` — verify no curated opencode rows; preserve custom `provider/model` IDs.
- `src/agent/modelCatalog.ts` and `model-catalog.json` — add an empty `opencode: []` section to the catalog shape (both copies must stay identical; guard: `modelCatalog.test.ts` "matches the published model feed exactly").
- `src/agent/materializedCleanup.ts` — add `${sep}.opencode${sep}` prefix variants to `OWNED_PREFIXES`.
- `src/ui/settings/webview.html` — add `'opencode'` to `KNOWN_AGENT_PROVIDERS` and the `modelCatalog`/`modelCompatibility` default objects (three places: init, state-merge, prev-merge).
- `src/extension.ts` — resolve adapter at operation time (already provider-neutral after the Codex refactor); verify no activation-time binding; pass `currentAgentAdapter()` to all headless paths.
- `karst.example.yml` — document `agentProvider: opencode` and mark opencode as implemented.
- `docs/guides/adding-agent-core.md` — record the server-first / plugin-hook / NDJSON lessons.

**Optional (lifecycle bridge — Task 8, gates `lifecycleEvents: true`)**

- Modify: `src/agent/opencode.ts` and `src/agent/opencode.test.ts` — generate `.opencode/plugins/karst-bridge.js` in `buildInteractiveCommand`, return it as `ownedPaths`.
- Modify: `src/hooks/dispatch.ts` and `src/hooks/dispatch.test.ts` — handle normalized opencode events (`session.idle` → Stop, `permission.asked` → Notification).

---

### Task 1: Widen the provider type and manifest validation

**Files:**

- Modify: `src/manifest/types.ts`
- Modify: `src/manifest/schema.ts`
- Modify: `src/manifest/load.test.ts`

**Interfaces:**

- Produces: `AgentProvider` includes `'opencode'`.
- Produces: `validateAgentProvider` accepts `'opencode'` with an actionable message.

- [ ] **Step 1: Write failing manifest test**

Add to `src/manifest/load.test.ts` in the `agentProvider` describe block:

```ts
it("preserves an explicit 'opencode' setting", () => {
  const { path, cleanup } = fixture(`${VALID}\nagentProvider: opencode\n`);
  try {
    expect(loadManifest(path).agentProvider).toBe('opencode');
  } finally {
    cleanup();
  }
});
```

- [ ] **Step 2: Run and verify RED**

```sh
npx vitest run src/manifest/load.test.ts
```

Expected: the opencode case fails (type/validator rejects it).

- [ ] **Step 3: Widen the type and validator**

In `src/manifest/types.ts`:

```ts
export type AgentProvider = 'claude' | 'codex' | 'antigravity' | 'opencode';
```

In `src/manifest/schema.ts` `validateAgentProvider`:

```ts
function validateAgentProvider(raw: unknown): AgentProvider {
  if (raw === undefined) return 'claude';
  if (raw !== 'claude' && raw !== 'codex' && raw !== 'antigravity' && raw !== 'opencode') {
    throw new ManifestError(
      'agentProvider must be "claude", "codex", "antigravity", or "opencode"',
    );
  }
  return raw as AgentProvider;
}
```

- [ ] **Step 4: Run and verify GREEN, then commit**

```sh
npx vitest run src/manifest/load.test.ts
npm run typecheck
git add src/manifest/types.ts src/manifest/schema.ts src/manifest/load.test.ts
git commit -m "feat: accept opencode as an agent provider"
```

---

### Task 2: Implement OpenCode interactive + headless execution

**Files:**

- Create: `src/agent/opencode.test.ts`
- Create: `src/agent/opencode.ts`

**Interfaces:**

- Consumes: `AgentAdapter`, `InteractiveCommandOpts`, `RunHeadlessOpts`.
- Produces: `OpencodeAdapter`.
- Produces: `SpawnHeadless` injected async seam (mirrors Claude/Codex).
- Produces: `parseOpencodeJsonl(stdout): { sessionId: string; raw: string; usage?: TokenUsage }`.

- [ ] **Step 1: Write failing command and parser tests**

Create `src/agent/opencode.test.ts`. The NDJSON fixtures mirror the verified 1.18.14 schema. Use `noUncheckedIndexedAccess`-safe access (`!` / guards).

```ts
import { describe, expect, it, vi } from 'vitest';
import { OpencodeAdapter, parseOpencodeJsonl, type SpawnHeadless } from './opencode.js';

const okNdjson = [
  JSON.stringify({ type: 'step_start', timestamp: 1, sessionID: 'ses_abc', part: { id: 'p1', messageID: 'm1', sessionID: 'ses_abc', type: 'step-start' } }),
  JSON.stringify({ type: 'text', timestamp: 2, sessionID: 'ses_abc', part: { id: 'p2', type: 'text', text: 'HELLO', time: { start: 1, end: 2 } } }),
  JSON.stringify({ type: 'step_finish', timestamp: 3, sessionID: 'ses_abc', part: { id: 'p3', reason: 'stop', type: 'step-finish', tokens: { total: 16318, input: 16312, output: 6, reasoning: 0, cache: { write: 0, read: 0 } }, cost: 0.012261 } }),
].join('\n');

function fakeSpawn(r: { stdout: string; stderr?: string; exitCode: number }): SpawnHeadless {
  return async () => ({ stdout: r.stdout, stderr: r.stderr ?? '', exitCode: r.exitCode });
}

describe('OpencodeAdapter capabilities', () => {
  it('declares truthful conservative capabilities and the opencode binary', () => {
    const a = new OpencodeAdapter();
    expect(a.requiredBinary).toBe('opencode');
    expect(a.capabilities).toEqual({ lifecycleEvents: false, resume: false });
  });
});

describe('OpencodeAdapter interactive commands', () => {
  it('builds a fresh interactive launch that prefills the prompt', () => {
    const cmd = new OpencodeAdapter().buildInteractiveCommand({
      cwd: '/wt',
      model: 'openrouter/~openai/gpt-mini-latest',
      initialPrompt: '/rpi KARST-1',
    });
    expect(cmd.command).toBe('opencode');
    expect(cmd.args).toEqual(['--model', 'openrouter/~openai/gpt-mini-latest', '--prompt', '/rpi KARST-1']);
    expect(cmd.env).toEqual({});
  });

  it('drops sessionName (opencode TUI has no launch-time session-name flag)', () => {
    const cmd = new OpencodeAdapter().buildInteractiveCommand({
      cwd: '/wt',
      sessionName: 'Karst: KARST-1 — title',
      initialPrompt: 'go',
    });
    expect(cmd.args).not.toContain('--name');
    expect(cmd.args).not.toContain('Karst: KARST-1 — title');
  });

  it('places extraArgs before the prompt', () => {
    const cmd = new CodexLikeExtraArgs();
    // ... assert extraArgs from materializeApproach land before --prompt
  });
});

describe('parseOpencodeJsonl', () => {
  it('returns the session id, last text, and mapped token usage', () => {
    const { sessionId, raw, usage } = parseOpencodeJsonl(okNdjson);
    expect(sessionId).toBe('ses_abc');
    expect(raw).toBe('HELLO');
    expect(usage).toEqual({
      inputTokens: 16312, outputTokens: 6, cacheReadTokens: 0, cacheWriteTokens: 0,
      totalTokens: 16318, model: null, estimated: false,
    });
  });

  it('concatenates multiple text parts in order', () => {
    const nd = [
      JSON.stringify({ type: 'step_start', timestamp: 1, sessionID: 'ses_x', part: { type: 'step-start' } }),
      JSON.stringify({ type: 'text', timestamp: 2, sessionID: 'ses_x', part: { type: 'text', text: 'a' } }),
      JSON.stringify({ type: 'text', timestamp: 3, sessionID: 'ses_x', part: { type: 'text', text: 'b' } }),
      JSON.stringify({ type: 'step_finish', timestamp: 4, sessionID: 'ses_x', part: { type: 'step-finish', tokens: { total: 0, input: 0, output: 0, reasoning: 0, cache: { write: 0, read: 0 } } } }),
    ].join('\n');
    expect(parseOpencodeJsonl(nd).raw).toBe('ab');
  });

  it.each([
    ['error event', JSON.stringify({ type: 'error', timestamp: 1, sessionID: 'ses_e', error: { name: 'UnknownError', data: { message: 'boom' } } })],
    ['missing session', JSON.stringify({ type: 'step_start', timestamp: 1, part: { type: 'step-start' } })],
    ['no text', [JSON.stringify({ type: 'step_start', timestamp: 1, sessionID: 's', part: { type: 'step-start' } }), JSON.stringify({ type: 'step_finish', timestamp: 2, sessionID: 's', part: { type: 'step-finish', tokens: { total: 0, input: 0, output: 0, reasoning: 0, cache: { write: 0, read: 0 } } } })].join('\n')],
  ])('rejects %s', (_label, stdout) => {
    expect(() => parseOpencodeJsonl(stdout)).toThrow();
  });

  it('skips unparseable trailing lines without failing', () => {
    const nd = okNdjson + '\n{truncated';
    expect(parseOpencodeJsonl(nd).sessionId).toBe('ses_abc');
  });
});

describe('OpencodeAdapter headless execution', () => {
  it('runs a fresh NDJSON run with --auto under bypassPermissions', async () => {
    const spawn = vi.fn(fakeSpawn({ stdout: okNdjson, exitCode: 0 }));
    const result = await new OpencodeAdapter(spawn).runHeadless({
      cwd: '/wt', prompt: '- inspect', permissionMode: 'bypassPermissions', model: 'openrouter/~openai/gpt-mini-latest',
    });
    expect(spawn).toHaveBeenCalledWith('opencode', ['run', '--format', 'json', '--auto', '--model', 'openrouter/~openai/gpt-mini-latest', '--', '- inspect'], '/wt');
    expect(result).toEqual({ sessionId: 'ses_abc', verdict: null, raw: 'HELLO', usage: expect.objectContaining({ inputTokens: 16312 }) });
  });

  it('runs without --auto when permissionMode is not bypass', async () => {
    const spawn = vi.fn(fakeSpawn({ stdout: okNdjson, exitCode: 0 }));
    await new OpencodeAdapter(spawn).runHeadless({ cwd: '/wt', prompt: 'go' });
    expect(spawn.mock.calls[0]![1]).not.toContain('--auto');
  });

  it('runs a resumed headless run via --session', async () => {
    const spawn = vi.fn(fakeSpawn({ stdout: okNdjson, exitCode: 0 }));
    await new OpencodeAdapter(spawn).runHeadless({ cwd: '/wt', prompt: 'continue', resume: 'ses_abc' });
    expect(spawn).toHaveBeenCalledWith('opencode', ['run', '--format', 'json', '--session', 'ses_abc', '--', 'continue'], '/wt');
  });

  it('reports bounded diagnostics + usage on a nonzero exit', async () => {
    const errNd = JSON.stringify({ type: 'error', timestamp: 1, sessionID: 'ses_e', error: { name: 'UnknownError', data: { message: 'x'.repeat(20_000) } } });
    const adapter = new OpencodeAdapter(fakeSpawn({ stdout: errNd, stderr: '', exitCode: 1 }));
    await expect(adapter.runHeadless({ cwd: '/wt', prompt: 'go' })).rejects.toThrow(/opencode/i);
  });
});
```

- [ ] **Step 2: Run and verify RED**

```sh
npx vitest run src/agent/opencode.test.ts
```

Expected: module-not-found.

- [ ] **Step 3: Implement the adapter**

Create `src/agent/opencode.ts`. Mirror Claude/Codex structure: injected `SpawnHeadless`, `describeHeadlessFailure`, `attachUsage`/`extractTokenUsage` for the rejection path (counts ride out on failure), `parseOpencodeJsonl` for success.

Key implementation points:

- `OPENCODE_BIN = 'opencode'`.
- `capabilities = { lifecycleEvents: false, resume: false }` (honest; Task 8 may flip lifecycle).
- `buildInteractiveCommand`: build `args = []`; if `opts.model` → `['--model', model]`; `extraArgs` (from materializeApproach) before the prompt; if `opts.initialPrompt` → `['--prompt', initialPrompt]`. **Drop `sessionName`** (no TUI naming flag). **Drop `resume`** from interactive (capability is false; if a resume id is passed despite the capability, ignore it rather than emitting an unsupported `-s` against a TUI that would hang on a nonexistent session). Do NOT add `[project]` positional (cwd is the project; the terminal host already sets cwd). `command: 'opencode'`, `env: {}`.
- `runHeadless`: `args = ['run', '--format', 'json']`; if `permissionMode === 'bypassPermissions'` → push `'--auto'`; if `opts.model` → `['--model', model]`; if `opts.resume` → `['--session', resume]`; then `['--', opts.prompt]`. Spawn with `stdio: ['ignore', 'pipe', 'pipe']` (stdin ignored so a non-TTY stdin never hangs — same fix as Claude). On non-zero exit: `throw attachUsage(new Error(describeHeadlessFailure({ tool: 'OpenCode', exitCode, stdout, stderr })), parseOpencodeJsonlUsage(stdout))`. On success: `parseOpencodeJsonl(stdout)` → `{ sessionId, raw, usage }`; return `{ sessionId, verdict: null, raw, ...(usage ? { usage } : {}) }`.
- `parseOpencodeJsonl(stdout)`: split on `\r?\n`, skip blank lines, `JSON.parse` each; on a parse failure **skip the line** (a truncated final line must not fail the whole read — mirrors `tokenUsage.events()` tolerance, NOT codex's strict throw — because opencode streams and a cut mid-write is expected). Track `sessionId` from `sessionID` (string) on any event; throw if no session id found. Accumulate `raw` from every `type === 'text'` event's `part.text` (string) in order. Throw on `type === 'error'` with a bounded diagnostic of `JSON.stringify(error)`. Extract `usage` from the last `type === 'step_finish'` event's `part.tokens`: map `input→inputTokens`, `output→outputTokens`, `cache.read→cacheReadTokens`, `cache.write→cacheWriteTokens`, `total→totalTokens`, `model: null`, `estimated: false`. Throw if no text was produced.

Confirm option ordering against the installed CLI:

```sh
opencode run --help
opencode --help
```

`--` is accepted by yargs as the option terminator; keep it before the prompt so a dash-prefixed prompt (e.g. a YAML frontmatter `---` in a seed) cannot be misread as an option.

- [ ] **Step 4: Run and verify GREEN**

```sh
npx vitest run src/agent/opencode.test.ts
```

- [ ] **Step 5: Commit**

```sh
git add src/agent/opencode.test.ts src/agent/opencode.ts
git commit -m "feat: add opencode interactive and headless adapter"
```

---

### Task 3: Materialize neutral approaches into `.opencode/`

**Files:**

- Modify: `src/agent/opencode.ts`
- Modify: `src/agent/opencode.test.ts`
- Modify: `src/agent/materializedCleanup.ts`
- Modify: `src/agent/materializedCleanup.test.ts`

**Interfaces:**

- Consumes: `MaterializeOpts` (neutral package).
- Produces: `OpencodeAdapter.materializeApproach`.
- Produces: `/<approach> <ticket-key>` invocation (opencode command).
- Produces: `ownedPaths` under `sessionDir/.opencode/` (deletable by cleanup).

**Mapping (neutral → opencode):**

| Neutral artifact | opencode target | Notes |
|---|---|---|
| `skills/<name>/` (skill) | `.opencode/skills/karst-<id>-<name>/SKILL.md` | Preserve whole folder; rewrite `name` frontmatter (must match dir; lowercase regex). |
| `agents/<name>.md` (agent) | `.opencode/agents/karst-<id>-<name>.md` | frontmatter `description`, `mode: subagent`, body = `Delegate the requested work…`. |
| `commands/<name>.md` (command) | `.opencode/skills/karst-<id>-<name>/SKILL.md` | opencode HAS commands, but a neutral command maps more safely to an on-demand skill (preserves semantics, avoids `/<name>` namespace collision). Mirror Antigravity's command→skill translation. |
| `workflow` | `.opencode/commands/<id>.md` | Generated orchestrator; frontmatter `description`, `agent: build`; body = `renderWorkflowCommand(...)`. Registers as `/<id>`. |
| `soloAgent` | `.opencode/agents/karst-agent-<name>.md` | `mode: subagent`. |

The generated `/<id>` command body uses `$ARGUMENTS` (opencode's command arg placeholder, identical to the workflow body's existing `$ARGUMENTS`) — so `renderWorkflowCommand` needs **no change**: its `contextCommand $ARGUMENTS` / `phaseCommand(name) $ARGUMENTS` / `stageCommand $ARGUMENTS` already render the opencode-correct syntax.

- [ ] **Step 1: Write failing materialization tests**

Add to `src/agent/opencode.test.ts` (reuse the `makeBasePackage`/`makeWorktree` helpers pattern from codex.test.ts):

```ts
it('preserves a skill folder and rewrites its name frontmatter', () => {
  const baseDir = makeBasePackage('rpi', [
    ['skills/planning/SKILL.md', '---\nname: planning\ndescription: Plan.\n---\nPlan.'],
    ['skills/planning/references/checks.md', '# checks'],
  ]);
  const worktree = makeWorktree();
  new OpencodeAdapter().materializeApproach!({ baseDir, sessionDir: worktree, pkg: { id: 'rpi', label: 'RPI', artifacts: [{ kind: 'skill', relPath: 'skills/planning/SKILL.md' }] } });
  expect(readFileSync(join(worktree, '.opencode/skills/karst-rpi-planning/references/checks.md'), 'utf8')).toBe('# checks');
  expect(readFileSync(join(worktree, '.opencode/skills/karst-rpi-planning/SKILL.md'), 'utf8')).toContain('name: karst-rpi-planning');
});

it('writes an agent artifact as a subagent markdown file', () => {
  const baseDir = makeBasePackage('rpi', [['agents/researcher.md', '# Researcher']]);
  const worktree = makeWorktree();
  new OpencodeAdapter().materializeApproach!({ baseDir, sessionDir: worktree, pkg: { id: 'rpi', label: 'RPI', artifacts: [{ kind: 'agent', relPath: 'agents/researcher.md' }] } });
  const body = readFileSync(join(worktree, '.opencode/agents/karst-rpi-researcher.md'), 'utf8');
  expect(body).toContain('mode: subagent');
  expect(body).toContain('Delegate');
});

it('translates a command artifact to an on-demand skill', () => {
  const baseDir = makeBasePackage('rpi', [['commands/review.md', '# Review']]);
  const worktree = makeWorktree();
  new OpencodeAdapter().materializeApproach!({ baseDir, sessionDir: worktree, pkg: { id: 'rpi', label: 'RPI', artifacts: [{ kind: 'command', relPath: 'commands/review.md' }] } });
  expect(existsSync(join(worktree, '.opencode/skills/karst-rpi-review/SKILL.md'))).toBe(true);
  expect(existsSync(join(worktree, '.opencode/commands/review.md'))).toBe(false);
});

it('generates a workflow command and native /<id> invocation', () => {
  const worktree = makeWorktree();
  const result = new OpencodeAdapter().materializeApproach!({
    baseDir: makeBasePackage('rpi', []), sessionDir: worktree,
    pkg: { id: 'rpi', label: 'Research, Plan, Implement', workflow: [{ name: 'research' }, { name: 'plan' }] },
    cliContextPrefix: 'node cli.js context --ticket', cliStagePrefix: 'node cli.js stage impl pass --ticket',
    cliPhasePrefix: (n) => `node cli.js phase ${n} --ticket`,
  });
  expect(result.invocation).toBe('/rpi');
  const body = readFileSync(join(worktree, '.opencode/commands/rpi.md'), 'utf8');
  expect(body).toContain('node cli.js context --ticket $ARGUMENTS');
  expect(body).toContain('node cli.js phase research --ticket $ARGUMENTS');
  expect(body).toContain('node cli.js stage impl pass --ticket $ARGUMENTS');
});

it('materializes a solo agent into .opencode/agents/', () => {
  const worktree = makeWorktree();
  new OpencodeAdapter().materializeApproach!({ baseDir: makeBasePackage('rpi', []), sessionDir: worktree, pkg: { id: 'rpi', label: 'RPI' }, soloAgent: { name: 'pm', body: 'do the work' } });
  expect(readFileSync(join(worktree, '.opencode/agents/karst-agent-pm.md'), 'utf8')).toContain('mode: subagent');
});

it.each(['../escape', '/absolute', 'karst', 'a/b', 'UPPER'])('rejects unsafe/reserved/uppercase id %s', (id) => {
  expect(() => new OpencodeAdapter().materializeApproach!({ baseDir: '/base', sessionDir: makeWorktree(), pkg: { id, label: id, workflow: [{ name: 'run' }] } })).toThrow(/unsafe|reserved|invalid|name/i);
});

it('does not own a pre-existing .opencode tree (repo-owned, left alone)', () => {
  const worktree = makeWorktree();
  mkdirSync(join(worktree, '.opencode', 'skills', 'karst-rpi-planning'), { recursive: true });
  writeFileSync(join(worktree, '.opencode', 'skills', 'karst-rpi-planning', 'SKILL.md'), 'repo');
  const result = new OpencodeAdapter().materializeApproach!({ baseDir: makeBasePackage('rpi', [['skills/planning/SKILL.md', '---\nname: planning\ndescription: p\n---\n']]), sessionDir: worktree, pkg: { id: 'rpi', label: 'RPI', artifacts: [{ kind: 'skill', relPath: 'skills/planning/SKILL.md' }] } });
  expect(readFileSync(join(worktree, '.opencode/skills/karst-rpi-planning/SKILL.md'), 'utf8')).toBe('repo');
  expect(result.ownedPaths).toEqual([]);
});
```

Add a cleanup test asserting `.opencode` paths are deletable:

```ts
it('removes adapter-owned .opencode paths beneath the worktree', () => {
  const root = mkdtempSync(join(tmpdir(), 'karst-oc-'));
  try {
    const owned = join(root, '.opencode', 'skills', 'karst-rpi');
    mkdirSync(owned, { recursive: true });
    writeFileSync(join(owned, 'SKILL.md'), 'gen');
    cleanupOwnedPaths(root, [owned]);
    expect(existsSync(owned)).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: Run and verify RED**

```sh
npx vitest run src/agent/opencode.test.ts src/agent/materializedCleanup.test.ts
```

- [ ] **Step 3: Implement materialization + cleanup prefix**

Add to `materializedCleanup.ts` `OWNED_PREFIXES`:

```ts
export const OWNED_PREFIXES = [
  `${sep}.agents${sep}skills${sep}karst-`,
  `${sep}.codex${sep}karst${sep}`,
  `${sep}.karst-plugin${sep}`,
  `${sep}.agents${sep}plugins${sep}`,
  `${sep}.opencode${sep}skills${sep}karst-`,
  `${sep}.opencode${sep}agents${sep}karst-`,
  `${sep}.opencode${sep}commands${sep}karst-`,
  `${sep}.opencode${sep}plugins${sep}karst-`,
] as const;
```

Implement `materializeApproach` in `opencode.ts`:

- `assertSafeName` enforcing opencode's skill-name rules (lowercase `^[a-z0-9]+(-[a-z0-9]+)*$`, 1–64, no `/`/`\`/`..`/absolute, not `karst`). Reject `opts.pkg.id === KARST_PLUGIN_NAME` (reserved).
- For each artifact: compute `base = basename(relPath)` (strip `.md` for agents/commands; for skills use `basename(dirname(relPath))`); `skillName = karst-${id}-${base}`; target under `sessionDir/.opencode/...`. **Skip if the target already exists** (repo-owned tree left alone — mirrors Claude/Codex's `existsSync` guard; record nothing as owned).
  - skill: `cpSync(dirname(src), dest, { recursive: true })`, then rewrite `SKILL.md` frontmatter `name: <skillName>`, `description: Use the <base> workflow from <label>.`, strip old frontmatter.
  - agent: write `.opencode/agents/karst-<id>-<base>.md` with frontmatter `description: Delegate work using the <base> role from <label>.`, `mode: subagent` and body `Delegate the requested work to a subagent following these instructions:\n\n<body>`.
  - command: write `.opencode/skills/karst-<id>-<base>/SKILL.md` (command→skill translation, like Antigravity) with `name: <skillName>`, `description: Run the <base> command from <label>.`, body = source body.
- `soloAgent`: write `.opencode/agents/karst-agent-<name>.md` (`mode: subagent`).
- `workflow`: write `.opencode/commands/<id>.md` (note: bare `<id>`, NOT `karst-<id>` — so it registers as `/<id>`; guard `id` against reserved/unsafe). Frontmatter `description: Run the <label> workflow for a Karst ticket.`, `agent: build`. Body = `renderWorkflowCommand({...})`.
- Return `{ extraArgs: [], ownedPaths: [...owned], ...(hasWorkflow ? { invocation: `/${id}` } : {}) }`.

`extraArgs` is empty: opencode discovers `.opencode/` from cwd (the worktree) automatically — no `--add-dir`/`--plugin-dir` flag needed (unlike Claude's `--plugin-dir`). The session launches with `cwd === sessionDir`, so the TUI/server finds the materialized tree.

- [ ] **Step 4: Run and verify GREEN**

```sh
npx vitest run src/agent/opencode.test.ts src/agent/materializedCleanup.test.ts src/agent/codex.test.ts src/agent/claude.test.ts src/agent/antigravity.test.ts
```

- [ ] **Step 5: Commit**

```sh
git add src/agent/opencode.ts src/agent/opencode.test.ts src/agent/materializedCleanup.ts src/agent/materializedCleanup.test.ts
git commit -m "feat: materialize karst approaches into .opencode"
```

---

### Task 4: Register opencode across EVERY provider-keyed surface

This task closes the typecheck-and-test gap left by widening `AgentProvider` in Task 1. `AgentProvider` is consumed by **exhaustive `Record<AgentProvider, …>` maps** and **hardcoded provider arrays** in several modules; adding `'opencode'` without updating every one either fails `tsc` (exhaustive Record) or silently drops opencode from a switch surface. The switch surfaces are:

- **Settings** (`src/ui/settings/`): manifest default provider + defaultModel dropdowns.
- **Ticket form** (`src/ui/ticketForm/`): per-ticket provider + model dropdowns (host-driven via `IMPLEMENTED_PROVIDERS` — no HTML change, but the catalog it reads must have `opencode`).
- **Dashboard "Switch agent…"** (`src/agent/sessionSwitch.ts`): host-owned QuickPick listing `IMPLEMENTED_PROVIDERS` minus current, labeled via `PROVIDER_LABELS`, model list via `modelsForProvider`.
- **Diagnostics** (`src/diagnostics/collectMetadata.ts`): typed row snapshot of `agent_provider`/`session_provider`.
- **Model catalog loader** (`src/agent/modelCatalogLoader.ts`): per-provider discovery probes.

**Files:**

- Modify: `src/agent/registry.ts`, `src/agent/registry.test.ts`
- Modify: `src/agent/provider.ts`
- Modify: `src/runtime/deps.ts`, `src/runtime/deps.test.ts`
- Modify: `src/agent/modelCatalog.ts`, `model-catalog.json`, `src/agent/modelCatalog.test.ts`
- Modify: `src/agent/modelCatalogLoader.ts`, `src/agent/modelCatalogLoader.test.ts`
- Modify: `src/agent/modelDiscovery.ts`, `src/agent/modelDiscovery.test.ts`
- Modify: `src/agent/models.test.ts`
- Modify: `src/agent/sessionSwitch.ts`, `src/agent/sessionSwitch.test.ts`
- Modify: `src/ui/settings/state.ts`, `src/ui/settings/state.test.ts`, `src/ui/settings/webview.html`
- Modify: `src/diagnostics/collectMetadata.ts` (and any test asserting the provider union)
- Modify: `karst.example.yml`

**Interfaces:**

- Produces: `resolveAdapter('opencode') -> OpencodeAdapter`.
- Produces: `opencode` in `IMPLEMENTED_PROVIDERS` (after Task 3 is GREEN).
- Produces: `PROVIDER_LABELS.opencode === 'OpenCode'` (dashboard switch QuickPick + label).
- Produces: confirmed `AGENT_CLI_DEPENDENCIES.opencode`.
- Produces: `discoverOpencodeModels` returning `{ status: 'unavailable', code: 'unsupported' }` (account-dependent models; curate zero rows).
- Preserves: no curated opencode model rows; custom `provider/model` IDs pass through.

- [ ] **Step 1: Write failing tests for every surface**

In `registry.test.ts`:

```ts
import { OpencodeAdapter } from './opencode.js';
it('resolves opencode to an OpencodeAdapter instance', () => {
  expect(resolveAdapter('opencode')).toBeInstanceOf(OpencodeAdapter);
});
it('lists every usable provider in stable UI order', () => {
  expect(IMPLEMENTED_PROVIDERS).toEqual(['claude', 'codex', 'antigravity', 'opencode']);
});
```

In `deps.test.ts`:

```ts
it('returns the confirmed opencode entry', () => {
  const dep = agentDependency('opencode');
  expect(dep.binary).toBe('opencode');
  expect(dep.label).toBe('the OpenCode CLI');
  expect(dep.install).toMatch(/opencode\.ai/);
  expect(AGENT_CLI_DEPENDENCIES.opencode).toEqual(dep);
  expect(dep.binary).toBe(resolveAdapter('opencode').requiredBinary);
});
it('probes the same binary the opencode adapter launches', () => {
  expect(agentDependency('opencode').binary).toBe(resolveAdapter('opencode').requiredBinary);
});
it('declares every binary karst itself spawns', () => {
  expect(dependencyRegistry('opencode').map((d) => d.binary)).toContain('opencode');
});
```

In `models.test.ts`:

```ts
it('offers no speculative curated opencode models', () => {
  expect(modelsForProvider('opencode')).toEqual([]);
});
it('preserves an explicit custom opencode model id (provider/model)', () => {
  expect(resolveModelForProvider('opencode', 'openrouter/~openai/gpt-mini-latest', undefined)).toBe('openrouter/~openai/gpt-mini-latest');
});
it('drops a known model from another provider when opencode is selected', () => {
  expect(resolveModelForProvider('opencode', 'claude-sonnet-5', undefined)).toBeUndefined();
});
```

In `sessionSwitch.test.ts` — the existing `agentSwitchProviderChoices('claude')` assertion (lines 28-31) hardcodes the expected list; update it and add opencode coverage:

```ts
it('omits the current provider and supplies human labels', () => {
  expect(agentSwitchProviderChoices('claude')).toEqual([
    { provider: 'codex', label: 'Codex' },
    { provider: 'antigravity', label: 'Antigravity' },
    { provider: 'opencode', label: 'OpenCode' },
  ]);
});

it('labels opencode in the agent session view', () => {
  expect(buildAgentSessionView({
    provider: 'opencode', ticketModel: null, defaultModel: null,
    catalog: CATALOG, stageCurrent: 'impl', sessionOpen: true,
  }).providerLabel).toBe('OpenCode');
});
```

In `modelCatalog.test.ts` — relax the "at least one fallback for every provider" guard to skip `opencode` (its curated list is intentionally empty — models are account-dependent; the guide: "Do not add model IDs merely because they look plausible"):

```ts
it('offers at least one fallback for every provider with a curated list', () => {
  const catalog = bundledModelCatalog();
  for (const provider of ['claude', 'codex', 'antigravity'] as const) {
    expect(catalog[provider].length).toBeGreaterThan(0);
  }
  expect(catalog.opencode).toEqual([]);
});
```

In `modelDiscovery.test.ts` — add:

```ts
it('reports opencode models as unsupported (account-dependent, not probed)', async () => {
  const result = await discoverOpencodeModels();
  expect(result).toEqual({ status: 'unavailable', code: 'unsupported', reason: expect.any(String) });
});
```

In `modelCatalogLoader.test.ts` — add a case asserting the opencode section is accepted from a feed and that the loader's `unsupported` result yields an empty `opencode` catalog entry (mirroring how Claude's `unsupported` probe is handled).

- [ ] **Step 2: Run and verify RED**

```sh
npx vitest run src/agent/registry.test.ts src/runtime/deps.test.ts src/agent/models.test.ts src/agent/modelCatalog.test.ts src/agent/sessionSwitch.test.ts src/agent/modelDiscovery.test.ts src/agent/modelCatalogLoader.test.ts src/ui/settings/state.test.ts
npm run typecheck
```

Expected: `tsc` fails on the exhaustive `Record<AgentProvider, …>` maps (`sessionSwitch.ts:10`, `modelCatalogLoader.ts:159`, `registry.ts:15`) and the hardcoded provider arrays; the targeted tests fail on the new assertions.

- [ ] **Step 3: Register + wire every surface**

`src/agent/provider.ts`:

```ts
export const IMPLEMENTED_PROVIDERS: readonly AgentProvider[] = ['claude', 'codex', 'antigravity', 'opencode'];
```

`src/agent/registry.ts`:

```ts
import { OpencodeAdapter } from './opencode.js';
const FACTORIES: Record<AgentProvider, () => AgentAdapter> = {
  claude: () => new ClaudeAdapter(), codex: () => new CodexAdapter(),
  antigravity: () => new AntigravityAdapter(), opencode: () => new OpencodeAdapter(),
};
```

`src/agent/sessionSwitch.ts` — exhaustive Record, must add the opencode label (drives the dashboard "Switch agent…" QuickPick + the `providerLabel` shown beside the button):

```ts
export const PROVIDER_LABELS: Readonly<Record<AgentProvider, string>> = {
  claude: 'Claude Code', codex: 'Codex', antigravity: 'Antigravity', opencode: 'OpenCode',
};
```

`src/runtime/deps.ts`:

```ts
opencode: {
  binary: 'opencode',
  label: 'the OpenCode CLI',
  install: "Install OpenCode from https://opencode.ai so the 'opencode' command is on your PATH, then reload the window.",
  enables: 'sessions',
},
```

`src/agent/modelCatalog.ts` — add `opencode` to BOTH the `PROVIDERS` array (used by `parseModelFeed` to iterate feed sections) AND the `BUNDLED_CATALOG`:

```ts
const PROVIDERS: readonly AgentProvider[] = ['claude', 'codex', 'antigravity', 'opencode'];
// ...
const BUNDLED_CATALOG: ModelCatalog = {
  claude: [...], codex: [...], antigravity: [...], opencode: [],
};
```

`model-catalog.json` (the published feed — must stay byte-identical to `BUNDLED_CATALOG` per the "matches the published model feed exactly" guard):

```json
"opencode": []
```

`src/agent/modelDiscovery.ts` — add a discovery probe that reports `unsupported` (opencode models are `provider/model` and account/provider-dependent; probing `opencode models` would return a huge account-specific list that must not be curated — same posture as Claude's probe):

```ts
export async function discoverOpencodeModels(): Promise<DiscoveryResult> {
  return { status: 'unavailable', code: 'unsupported', reason: 'opencode models are account- and provider-dependent; karst curates none' };
}
```

`src/agent/modelCatalogLoader.ts` — add `opencode` to BOTH the `PROVIDERS` array (line 18, used by `parseModelFeed`) AND the exhaustive `DEFAULT_CLI_LOADERS` Record (line 159):

```ts
const PROVIDERS: readonly AgentProvider[] = ['claude', 'codex', 'antigravity', 'opencode'];
// ...
const DEFAULT_CLI_LOADERS: Record<AgentProvider, ModelDiscoveryLoader> = {
  claude: discoverClaudeModels, codex: discoverCodexModels,
  antigravity: discoverAntigravityModels, opencode: discoverOpencodeModels,
};
```

`src/ui/settings/state.ts` — the default `implementedProviders` parameter (line 68) is the fallback before the host pushes the real list; keep it in sync:

```ts
implementedProviders: AgentProvider[] = ['claude', 'codex', 'antigravity', 'opencode'],
```

`src/ui/settings/webview.html` — add `'opencode'` to `KNOWN_AGENT_PROVIDERS` (line ~1096) and to the three `modelCatalog`/`modelCompatibility` default object literals (`{ claude: [], codex: [], antigravity: [], opencode: [] }`) at init (line ~1084), state-merge (line ~3569), and prev-merge (line ~3798). The provider `<select>` re-render (`KNOWN_AGENT_PROVIDERS.map`) picks it up automatically; `implementedProviders` gating enables it once the host sends it. The model picker's in-webview `renderModelOptions(provider, …)` filters by `draft.agentProvider`, so opencode renders zero curated rows and accepts a custom typed id (the "stale saved model" path keeps an unknown id selectable).

`src/diagnostics/collectMetadata.ts` — widen the row type unions (lines 74-75) so a ticket row carrying `opencode` type-checks:

```ts
agent_provider: 'claude' | 'codex' | 'antigravity' | 'opencode' | null
session_provider: 'claude' | 'codex' | 'antigravity' | 'opencode' | null
```

`karst.example.yml` — change the comment to `# Agent CLI used for sessions: claude, codex, antigravity, or opencode.`

**Note on the ticket form:** `src/ui/ticketForm/state.ts:235,279` builds `agentProviders: [...IMPLEMENTED_PROVIDERS]` from the host-side constant, so the form's provider dropdown auto-includes opencode once `provider.ts` is updated — **no ticket-form HTML change needed**. The form's model list is host-filtered via `modelsForProvider(resolveProvider(...))` in `buildTicketFormState`, so it auto-renders zero curated opencode rows. The `set-provider` action's `pushState` re-filters the model picker on a provider switch (the only `set*` that calls `pushState` — the model list depends on it). All of this is already provider-neutral; the only ticket-form touch is verifying via F5.

- [ ] **Step 4: Run and verify GREEN + typecheck + build**

```sh
npx vitest run src/agent/registry.test.ts src/runtime/deps.test.ts src/agent/models.test.ts src/agent/modelCatalog.test.ts src/agent/sessionSwitch.test.ts src/agent/modelDiscovery.test.ts src/agent/modelCatalogLoader.test.ts src/ui/settings/state.test.ts src/ui/ticketForm
npm run typecheck
npm run build
```

- [ ] **Step 5: Commit**

```sh
git add src/agent/registry.ts src/agent/registry.test.ts src/agent/provider.ts src/runtime/deps.ts src/runtime/deps.test.ts src/agent/modelCatalog.ts src/agent/modelCatalog.test.ts src/agent/modelCatalogLoader.ts src/agent/modelCatalogLoader.test.ts src/agent/modelDiscovery.ts src/agent/modelDiscovery.test.ts src/agent/models.test.ts src/agent/sessionSwitch.ts src/agent/sessionSwitch.test.ts src/ui/settings/state.ts src/ui/settings/state.test.ts src/ui/settings/webview.html src/diagnostics/collectMetadata.ts model-catalog.json karst.example.yml
git commit -m "feat: register opencode across every provider-keyed surface"
```

---

### Task 5: Route execution through the live provider (verify, no activation-time binding)

**Files:**

- Verify/modify: `src/extension.ts`
- Test: `src/ui/session.test.ts`, existing workflow/dashboard tests

**Note:** The Codex refactor (plan 006 Task 6) already made `SessionManager` per-launch and `extension.ts` resolve `currentAgentAdapter()` at operation time. This task VERIFIES that opencode requires no additional routing change and adds a regression test that opencode is reachable.

- [ ] **Step 1: Add a routing regression test**

In `src/ui/session.test.ts`:

```ts
it('launches the opencode binary when the opencode adapter is selected', () => {
  const { adapter } = fakeAdapter('opencode');
  const { host, terminals } = fakeHost();
  const mgr = new SessionManager(host, () => ({ endpointUrl: 'http://127.0.0.1:1/hooks', configDir: '/runtime' }));
  mgr.openSession(adapter, 1, '/wt/a');
  expect(terminals.map((t) => t.shellPath)).toEqual(['opencode']);
});
```

- [ ] **Step 2: Verify no activation-time binding remains**

```sh
rg -n "resolveAdapter\('claude'\)|const agentAdapter = resolveAdapter" src/extension.ts
```

Expected: no matches — every adapter use goes through `currentAgentAdapter()` / a passed adapter.

- [ ] **Step 3: Run routing + workflow tests**

```sh
npx vitest run src/ui/session.test.ts src/workflow src/ui/dashboard src/extensionActivation.test.ts
npm run typecheck
```

- [ ] **Step 4: Commit (if any test was added)**

```sh
git add src/ui/session.test.ts
git commit -m "test: opencode provider reaches the terminal launch path"
```

---

### Task 6: Verify full suite + F5 launch

**Files:** none (verification only)

- [ ] **Step 1: Full suite**

```sh
npm test
npm run typecheck
npm run build
```

- [ ] **Step 2: F5 Extension Host — opencode interactive (settings + ticket form + launch)**

1. **Settings**: set `agentProvider: opencode` in the test workspace's `karst.yml` (or use the Settings UI; opencode should render enabled in the dropdown, labeled "OpenCode"). Verify the Default model dropdown shows zero curated rows and accepts a custom `provider/model` id. Save → verify `writeManifest` round-trips it.
2. **Ticket form (create)**: open the form; verify the Agent core dropdown lists "Inherit (settings: OpenCode)" + all four providers; verify the Model dropdown is filtered to opencode's (empty) curated list when opencode is selected, and a custom `provider/model` typed id is preserved. Submit → a terminal opens running `opencode` in the worktree, the seed prompt is **prefilled** (user submits Enter — documented gap), and the `/<approach> <key>` invocation (when an approach with a workflow is selected) is prefilled.
3. **Ticket form (edit, session lock)**: with a session open, verify the Agent core dropdown is disabled with the "Locked while the session runs — close the terminal to change it." hint (the lock is stage/session-gated, not provider-specific).
4. **Materialization**: verify materialized `.opencode/skills/`, `.opencode/agents/`, `.opencode/commands/<id>.md` exist in the worktree and the command is invocable as `/<id>`.
5. **Cleanup**: on terminal close, the adapter-owned `.opencode/karst-*` paths are removed and repo-owned `.opencode/` content is untouched.

- [ ] **Step 3: F5 — dashboard "Switch agent…" (the per-ticket mid-flight switch)**

1. With a ticket at `impl` or `fix` and a live session open, verify the "Switch agent…" button appears beside the Now line (guarded by `canSwitchAgentSession = sessionOpen && stage∈{impl,fix}`).
2. Click it → verify the QuickPick lists "Codex / Antigravity / OpenCode" (all `IMPLEMENTED_PROVIDERS` except current), each with its `PROVIDER_LABELS` label ("OpenCode" for opencode).
3. Pick OpenCode → verify the model QuickPick shows "Inherit (settings: …)" + opencode's empty curated list (so just the inherit/default option); a previously-saved ticket model that's compatible with opencode stays pre-picked.
4. Confirm → verify: `updateTicketFields({agentProvider:'opencode', model})` writes both per-ticket columns; the live terminal is disposed; a fresh `opencode` session launches with `allowResume:false` (the old `session_provider` is foreign, so `shouldResumeSession` correctly refuses to `--resume` it).
5. Verify the dashboard's identity subtitle now reads "OpenCode · <model label>".

- [ ] **Step 4: F5 — opencode headless**

1. Trigger a headless stage (e.g. a gate/review/ship path that calls `runHeadless`).
2. Verify: `opencode run --format json ...` is spawned, NDJSON is parsed, `sessionId` captured, token usage recorded, `verdict: null` returned.
3. Verify: a missing `opencode` binary produces actionable setup guidance (dependency preflight).
4. Verify: a ticket switched from claude→opencode with a stale `claude-sonnet-5` model override drops it via `resolveModelForProvider` (the headless adapter gets no `--model`, opencode picks its own default).

- [ ] **Step 5: Update the agent-core guide**

In `docs/guides/adding-agent-core.md` add a "## 13. OpenCode implementation notes" section recording:

- OpenCode is server-first; the TUI is the interactive surface, `opencode run --format json` is headless (NDJSON).
- There is no CLI hook flag; lifecycle bridging requires a generated plugin (Task 8) — advertise `lifecycleEvents: false` until that channel exists.
- The TUI's `--prompt` prefills but does not auto-submit (interactive gap vs Claude/Codex).
- Materialization uses `.opencode/` (opencode's primary discovery root); opencode ALSO reads `.agents/skills/` and `.claude/skills/`, so codex/claude materialization is incidentally discoverable, but opencode keeps its own tree clean.
- Models are account-dependent `provider/model`; curate zero rows, preserve custom IDs.
- Token usage is adapter-parsed from `step_finish.part.tokens` (keys `input`/`output`/`total` don't match the shared extractor); the adapter owns `parseOpencodeJsonl` like Codex owns `parseCodexJsonl`.

---

### Task 7 (optional, gates `lifecycleEvents: true`): Bridge opencode lifecycle events via a generated plugin

**Files:**

- Modify: `src/agent/opencode.ts`, `src/agent/opencode.test.ts`
- Modify: `src/hooks/dispatch.ts`, `src/hooks/dispatch.test.ts`
- Modify: `src/agent/materializedCleanup.ts` (prefix already added in Task 3)

**Why optional / gated:** opencode's only hook surface is a JS/TS plugin running under Bun in the opencode server process. Karst generating a plugin is the opencode-native equivalent of Codex's `bridge.cjs`, but it is more invasive (full Bun execution context, not a stdin→HTTP shim) and depends on the opencode plugin event API staying stable. Ship the adapter with `lifecycleEvents: false` first; flip to `true` only after this task proves the channel end-to-end. **Do not add this to `IMPLEMENTED_PROVIDERS` gating** — the adapter is usable without it (Antigravity shipped the same way).

- [ ] **Step 1: Write failing hook tests**

```ts
it('materializes a karst-bridge plugin that POSTs session.idle/permission.asked to the hook endpoint', () => {
  const worktree = makeWorktree();
  const configDir = join(worktree, '.karst-runtime'); mkdirSync(configDir, { recursive: true });
  const cmd = new OpencodeAdapter().buildInteractiveCommand({
    cwd: worktree, hookChannel: { endpointUrl: 'http://127.0.0.1:4567/hooks', configDir }, initialPrompt: 'go',
  });
  const pluginPath = join(worktree, '.opencode', 'plugins', 'karst-bridge.js');
  expect(existsSync(pluginPath)).toBe(true);
  const body = readFileSync(pluginPath, 'utf8');
  expect(body).toContain('session.idle');
  expect(body).toContain('http://127.0.0.1:4567/hooks');
  expect(cmd.args).toContain('--pure'); // optional: suppress inherited plugins so only karst's events fire
});
```

Add to `src/hooks/dispatch.test.ts`:

```ts
it('treats opencode session.idle as Stop and permission.asked as waiting', () => {
  dispatchHook(store, { hook_event_name: 'session.idle', cwd: WT, session_id: 'ses_1' });
  // Stop semantics: the session finished a turn
  dispatchHook(store, { hook_event_name: 'Notification', message: 'permission_prompt', cwd: WT, session_id: 'ses_1' });
  expect(getTicket(store, id).agentState).toBe('waiting');
});
```

- [ ] **Step 2: Implement the generated plugin**

Write `.opencode/plugins/karst-bridge.js` (CommonJS-friendly under Bun) exporting a plugin that subscribes to `session.idle` (→ `Stop`), `session.error` (→ error), `permission.asked` (→ `Notification`/`permission_prompt`), and POSTs a normalized payload `{ hook_event_name, cwd, session_id, message? }` to the loopback endpoint. Mirror Codex's loopback-safety rules: refuse non-`http://127.0.0.1:<port>` endpoints; bound input size; fail open on errors (never block the agent). Return the plugin path as `ownedPaths` so cleanup removes it.

- [ ] **Step 3: Flip the capability**

```ts
readonly capabilities: AgentCapabilities = { lifecycleEvents: true, resume: false };
```

- [ ] **Step 4: Run + verify + commit**

```sh
npx vitest run src/agent/opencode.test.ts src/hooks/dispatch.test.ts src/hooks/endpoint.test.ts
git add src/agent/opencode.ts src/agent/opencode.test.ts src/hooks/dispatch.ts src/hooks/dispatch.test.ts
git commit -m "feat: bridge opencode lifecycle events via a generated plugin"
```

---

## Compatibility & migration notes

- **Existing tickets:** a ticket with `provider: opencode` and no `model` resolves to the CLI default (opencode reads `opencode.json`). A ticket carrying a `claude-*` model override that is incompatible with opencode is dropped by `resolveModelForProvider` (unknown IDs preserved; known-incompatible dropped) — exactly the Codex behavior.
- **Manifests:** `agentProvider: opencode` validates and round-trips through `writeManifest` (the overlay already defaults to `'claude'` and passes through any set value). Legacy manifests without the field are unaffected.
- **Shared storage / model catalog:** `model-catalog.json` gains `opencode: []`; the "matches the published feed exactly" guard keeps the two copies identical.
- **UI:** opencode renders enabled in the Settings provider dropdown and the ticket-form model picker shows zero curated opencode rows (custom `provider/model` IDs still accepted).

## Risks & open verification items

1. **`--prompt` prefill vs auto-submit:** verify in F5 whether the TUI auto-submits on a non-TTY or whether the user must press Enter. If it never auto-submits, document the gap in the agent-core guide (Task 6 Step 4) and consider the server/SDK path (`opencode serve` + `/tui/submit-prompt`) as a future enhancement — out of scope for this plan.
2. **`--auto` necessity for headless:** verified that a simple `opencode run` without `--auto` completes; confirm a tool-using headless run (edit/bash) does not block without `--auto`. If it blocks, always pass `--auto` for `run` (non-interactive) and document that headless always auto-approves.
3. **Plugin trust (Task 7):** opencode plugins run under Bun with full tool access. Karst generating a plugin is more invasive than Codex's stdin bridge; confirm the plugin API is stable before flipping `lifecycleEvents: true`.
4. **NDJSON truncation:** confirm a long headless run does not interleave non-JSON logs on stdout (stderr only). If a `--print-logs` user has pointed logs to stdout, the parser skips unparseable lines (Task 2 tolerance), but document that `--print-logs` must not be set for headless runs.
