# Codex Agent Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Codex CLI a first-class Karst agent core with provider-correct interactive and headless execution, repository-local approach skills, lifecycle tracking, session capture, and resume.

**Architecture:** Repair the activation-time Claude binding before registering Codex. Pass a provider-neutral hook channel and a per-launch adapter through `SessionManager`; let each adapter own its command, lifecycle configuration, approach layout, and invocation syntax. Codex uses `codex exec --json` for headless work, `.agents/skills` for approaches, and command hooks that normalize lifecycle events into Karst's existing loopback endpoint.

**Tech Stack:** TypeScript 5, Node.js child processes and filesystem APIs, Vitest, VS Code terminal API, Codex CLI 0.145.0.

## Global Constraints

- Follow strict RED → GREEN TDD. Run each named test before and after its implementation.
- Do not add Codex to `IMPLEMENTED_PROVIDERS` until the adapter, lifecycle bridge, materialization, and provider routing are all usable.
- Do not parse agent prose as a workflow verdict; every Codex headless result returns `verdict: null`.
- Do not use synchronous child processes on any extension-host execution path.
- Do not pass `--dangerously-bypass-approvals-and-sandbox` or `--dangerously-bypass-hook-trust`.
- Do not modify repository-owned `AGENTS.md`.
- Generated paths must remain beneath reserved Karst roots and cleanup must remove only paths returned as owned by materialization.
- Keep `context`, restricted `stage`, and append-only `phase` CLI parsing unchanged.
- Preserve unknown/custom model IDs; do not add unverified Codex model IDs to the curated picker.
- Edit source webview assets only, never `dist`.
- Keep ESM `.js` import suffixes and satisfy `noUncheckedIndexedAccess`.

## Researched Codex Contract

Verified locally with `codex-cli 0.145.0` on 2026-07-24:

```text
codex [OPTIONS] [PROMPT]
codex resume [OPTIONS] [SESSION_ID] [PROMPT]
codex exec --json [OPTIONS] [PROMPT]
codex exec resume --json [OPTIONS] [SESSION_ID] [PROMPT]
```

`codex exec --json` emits JSONL. The required records are:

```json
{"type":"thread.started","thread_id":"0199a213-81c0-7800-8aa1-bbab2a035a53"}
{"type":"item.completed","item":{"id":"item_3","type":"agent_message","text":"Final response"}}
{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}
```

Codex command hooks receive JSON on stdin with `session_id`, `cwd`, and
`hook_event_name`. Repository skills are discovered beneath `.agents/skills`.

Official references:

- <https://developers.openai.com/codex/skills>
- <https://learn.chatgpt.com/docs/hooks>
- <https://learn.chatgpt.com/docs/non-interactive-mode>
- <https://developers.openai.com/codex/config-advanced>

## File Map

**Create**

- `src/agent/codex.ts` — Codex commands, JSONL parsing, hooks, and approach materialization.
- `src/agent/codex.test.ts` — Codex adapter unit tests.
- `src/agent/materializedCleanup.ts` — safe cleanup of adapter-owned runtime paths.
- `src/agent/materializedCleanup.test.ts` — cleanup boundary tests.

**Modify**

- `src/agent/adapter.ts` — provider-neutral hook channel and enriched materialization result.
- `src/agent/claude.ts` and `src/agent/claude.test.ts` — consume the neutral channel and return native invocation/owned paths.
- `src/agent/antigravity.ts` and `src/agent/antigravity.test.ts` — return native invocation/owned paths and renamed lifecycle capability.
- `src/agent/settings.ts` and `src/agent/settings.test.ts` — build Claude settings from an endpoint URL.
- `src/ui/session.ts` and `src/ui/session.test.ts` — select an adapter per new session and clean its owned paths.
- `src/hooks/dispatch.ts` and `src/hooks/dispatch.test.ts` — retain the normalized provider-neutral event contract.
- `src/agent/registry.ts` and `src/agent/registry.test.ts` — register Codex after it is usable.
- `src/runtime/deps.ts` and `src/runtime/deps.test.ts` — confirmed Codex dependency guidance.
- `src/agent/models.ts` and `src/agent/models.test.ts` — verify Codex default/custom model behavior without speculative rows.
- `src/ui/settings/state.ts`, `src/ui/settings/state.test.ts`, and `src/ui/settings/webview.html` — enable Codex with no curated model rows.
- `src/extension.ts` — resolve adapters at operation time, materialize before seed composition, and route headless calls dynamically.
- `karst.example.yml` — mark Codex as implemented.
- `docs/guides/adding-agent-core.md` — record the provider-routing and native-invocation lessons.

---

### Task 1: Make the adapter and session contracts provider-neutral

**Files:**

- Modify: `src/agent/adapter.ts`
- Modify: `src/ui/session.ts`
- Modify: `src/ui/session.test.ts`
- Modify: `src/agent/settings.ts`
- Modify: `src/agent/settings.test.ts`
- Modify: `src/agent/claude.ts`
- Modify: `src/agent/claude.test.ts`
- Modify: `src/agent/antigravity.ts`
- Modify: `src/agent/antigravity.test.ts`

**Interfaces:**

- Produces: `HookChannel = { endpointUrl: string; configDir: string }`.
- Produces: `Materialized = { extraArgs: string[]; invocation?: string; ownedPaths: string[] }`.
- Produces: `SessionManager.openSession(adapter, ticketId, worktreePath, ...)`.
- Produces: `AgentCapabilities.lifecycleEvents`.
- Consumes: the existing `AgentAdapter`, terminal host, and loopback hook endpoint.

- [ ] **Step 1: Write failing contract and session tests**

Update the fake adapter in `src/ui/session.test.ts` and add these cases:

```ts
function fakeAdapter(binary = 'fake-agent'): { adapter: AgentAdapter; calls: InteractiveCommandOpts[] } {
  const calls: InteractiveCommandOpts[] = [];
  return {
    calls,
    adapter: {
      requiredBinary: binary,
      capabilities: { lifecycleEvents: true, resume: true },
      buildInteractiveCommand: (opts) => {
        calls.push(opts);
        return { command: binary, args: [], env: {} };
      },
      runHeadless: () => Promise.reject(new Error('not used')),
    },
  };
}

it('uses the adapter supplied for each new session', () => {
  const a = fakeAdapter('claude');
  const b = fakeAdapter('codex');
  const { host, terminals } = fakeHost();
  const mgr = new SessionManager(host, () => ({
    endpointUrl: 'http://127.0.0.1:4567/hooks',
    configDir: '/runtime',
  }));

  mgr.openSession(a.adapter, 1, '/wt/a');
  mgr.openSession(b.adapter, 2, '/wt/b');

  expect(terminals.map((t) => t.shellPath)).toEqual(['claude', 'codex']);
});

it('passes a provider-neutral hook channel to the selected adapter', () => {
  const { adapter, calls } = fakeAdapter();
  const { host } = fakeHost();
  const channel = {
    endpointUrl: 'http://127.0.0.1:4567/hooks',
    configDir: '/runtime',
  };
  const mgr = new SessionManager(host, () => channel);

  mgr.openSession(adapter, 1, '/wt/a');

  expect(calls[0]!.hookChannel).toEqual(channel);
});
```

Update capability assertions in Claude and Antigravity tests:

```ts
expect(adapter.capabilities.lifecycleEvents).toBe(true); // Claude
expect(adapter.capabilities.lifecycleEvents).toBe(false); // Antigravity
```

Add to `src/agent/settings.test.ts`:

```ts
it('builds Claude hook settings from an explicit endpoint URL', () => {
  const settings = JSON.parse(
    buildHookSettings('http://127.0.0.1:4567/hooks'),
  ) as { hooks: Record<string, { hooks: { url?: string; command?: string }[] }[]> };

  expect(settings.hooks.Stop![0]!.hooks[0]!.url).toBe(
    'http://127.0.0.1:4567/hooks',
  );
  expect(settings.hooks.SessionStart![0]!.hooks[0]!.command).toContain(
    "'http://127.0.0.1:4567/hooks'",
  );
});
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```sh
npx vitest run src/ui/session.test.ts src/agent/settings.test.ts src/agent/claude.test.ts src/agent/antigravity.test.ts
```

Expected: TypeScript/test failures because `HookChannel`,
`lifecycleEvents`, and the per-launch adapter signature do not exist.

- [ ] **Step 3: Implement the neutral interfaces**

Change `src/agent/adapter.ts` to include:

```ts
export interface HookChannel {
  endpointUrl: string;
  configDir: string;
}

export interface InteractiveCommandOpts {
  cwd: string;
  hookChannel?: HookChannel;
  resume?: string;
  initialPrompt?: string;
  model?: string;
  extraArgs?: string[];
}

export interface Materialized {
  extraArgs: string[];
  invocation?: string;
  ownedPaths: string[];
}

export interface AgentCapabilities {
  lifecycleEvents: boolean;
  resume: boolean;
}
```

Remove `settingsPath` from both interactive and headless options. Headless runs
do not need Karst's interactive lifecycle channel.

Change `SessionManager` construction and launch:

```ts
export type HookChannelFor = () => HookChannel;

export class SessionManager {
  private readonly terminals = new Map<number, SessionTerminal>();

  constructor(
    private readonly host: TerminalHost,
    private readonly hookChannelFor: HookChannelFor,
    private readonly onDidCloseSession?: (ticketId: number) => void,
  ) {}

  openSession(
    adapter: AgentAdapter,
    ticketId: number,
    worktreePath: string,
    label?: { key?: string | null; title?: string | null },
    initialPrompt?: string,
    extraArgs?: string[],
    model?: string,
    resume?: string,
    naming?: { name: string; iconPath?: string; color?: string },
  ): void {
    const existing = this.terminals.get(ticketId);
    if (existing) {
      existing.show();
      return;
    }

    const cmd = adapter.buildInteractiveCommand({
      cwd: worktreePath,
      hookChannel: this.hookChannelFor(),
      ...(initialPrompt ? { initialPrompt } : {}),
      ...(extraArgs?.length ? { extraArgs } : {}),
      ...(model ? { model } : {}),
      ...(resume ? { resume } : {}),
    });

    const terminal = this.host.createTerminal({
      name: naming?.name ?? `Karst: ${label?.key ?? `#${ticketId}`}`,
      description: naming ? undefined : (label?.title ?? undefined),
      cwd: worktreePath,
      shellPath: cmd.command,
      shellArgs: cmd.args,
      ...(naming?.iconPath ? { iconPath: naming.iconPath } : {}),
      ...(naming?.color ? { color: naming.color } : {}),
    });
    terminal.onDidClose(() => {
      this.terminals.delete(ticketId);
      this.onDidCloseSession?.(ticketId);
    });
    this.terminals.set(ticketId, terminal);
    terminal.show();
  }
}
```

Change `buildHookSettings` to receive the already-bound URL:

```ts
export function buildHookSettings(endpointUrl: string): string {
  const parsed = new URL(endpointUrl);
  if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1') {
    throw new Error(`karst: refusing non-loopback hook endpoint ${endpointUrl}`);
  }
  const httpHook = { type: 'http', url: endpointUrl, timeout: 10 };
  const bridgeHook = {
    type: 'command',
    command:
      `curl -s -m 5 -X POST -H 'Content-Type: application/json' ` +
      `--data-binary @- '${endpointUrl}' >/dev/null 2>&1`,
  };
  const hooks: Record<string, unknown> = {
    SessionStart: [{ matcher: '', hooks: [bridgeHook] }],
  };
  for (const event of HTTP_EVENTS) {
    hooks[event] = [{ matcher: '', hooks: [httpHook] }];
  }
  return JSON.stringify({ hooks });
}

export function writeHookSettings(endpointUrl: string, dir: string): string {
  const port = new URL(endpointUrl).port;
  const path = join(dir, `karst-hooks.${port}.settings.json`);
  writeFileSync(path, buildHookSettings(endpointUrl));
  return path;
}
```

In `ClaudeAdapter.buildInteractiveCommand`, materialize its settings file:

```ts
if (opts.hookChannel) {
  args.push(
    '--settings',
    writeHookSettings(opts.hookChannel.endpointUrl, opts.hookChannel.configDir),
  );
}
```

Rename both existing adapters' capability field and make every current
materialization return `ownedPaths`, initially using the roots it creates:

```ts
return {
  extraArgs: pluginDirs.flatMap((dir) => ['--plugin-dir', dir]),
  ownedPaths: pluginDirs,
  ...(hasWorkflow
    ? { invocation: `/${KARST_PLUGIN_NAME}:${orchestratorCommandBasename(opts.pkg.id)}` }
    : {}),
};
```

For Antigravity, use its skill name:

```ts
return {
  extraArgs: [],
  ownedPaths: [pluginDir, ...(hasWorkflow ? [karstDir] : [])],
  ...(hasWorkflow ? { invocation: `$${opts.pkg.id}` } : {}),
};
```

Empty materialization returns `{ extraArgs: [], ownedPaths: [] }`.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run:

```sh
npx vitest run src/ui/session.test.ts src/agent/settings.test.ts src/agent/claude.test.ts src/agent/antigravity.test.ts
```

Expected: all selected tests pass.

- [ ] **Step 5: Commit**

```sh
git add src/agent/adapter.ts src/ui/session.ts src/ui/session.test.ts src/agent/settings.ts src/agent/settings.test.ts src/agent/claude.ts src/agent/claude.test.ts src/agent/antigravity.ts src/agent/antigravity.test.ts
git commit -m "refactor: make agent session contract provider neutral"
```

---

### Task 2: Add safe ownership and cleanup for materialized runtime files

**Files:**

- Create: `src/agent/materializedCleanup.ts`
- Create: `src/agent/materializedCleanup.test.ts`
- Modify: `src/ui/session.ts`
- Modify: `src/ui/session.test.ts`

**Interfaces:**

- Consumes: `Materialized.ownedPaths`.
- Produces: `cleanupOwnedPaths(worktreePath: string, ownedPaths: readonly string[]): void`.
- Produces: optional `ownedPaths` parameter on `SessionManager.openSession`.

- [ ] **Step 1: Write failing cleanup tests**

Create `src/agent/materializedCleanup.test.ts`:

```ts
import { afterEach, describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanupOwnedPaths } from './materializedCleanup.js';

describe('cleanupOwnedPaths', () => {
  let root = '';

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it('removes only explicit owned paths beneath the worktree', () => {
    root = mkdtempSync(join(tmpdir(), 'karst-cleanup-'));
    const owned = join(root, '.agents', 'skills', 'karst-rpi');
    const user = join(root, '.agents', 'skills', 'user-skill');
    mkdirSync(owned, { recursive: true });
    mkdirSync(user, { recursive: true });
    writeFileSync(join(owned, 'SKILL.md'), 'generated');
    writeFileSync(join(user, 'SKILL.md'), 'user');

    cleanupOwnedPaths(root, [owned]);

    expect(existsSync(owned)).toBe(false);
    expect(existsSync(user)).toBe(true);
  });

  it.each([
    '/tmp/outside',
    '../outside',
    '.agents/skills/user-skill',
    '.agents',
    '.codex',
  ])('rejects an unsafe cleanup target: %s', (target) => {
    root = mkdtempSync(join(tmpdir(), 'karst-cleanup-'));
    expect(() => cleanupOwnedPaths(root, [target])).toThrow(/owned path|unsafe/i);
  });
});
```

Add a session test:

```ts
it('cleans adapter-owned paths after the terminal closes', () => {
  const { adapter } = fakeAdapter();
  const { host, terminals } = fakeHost();
  const cleanup = vi.fn();
  const mgr = new SessionManager(
    host,
    () => ({ endpointUrl: 'http://127.0.0.1:1/hooks', configDir: '/runtime' }),
    undefined,
    cleanup,
  );

  mgr.openSession(adapter, 1, '/wt/a', undefined, undefined, undefined, undefined, undefined, undefined, [
    '/wt/a/.agents/skills/karst-rpi',
  ]);
  terminals[0]!.dispose();

  expect(cleanup).toHaveBeenCalledWith('/wt/a', ['/wt/a/.agents/skills/karst-rpi']);
});
```

- [ ] **Step 2: Run tests and verify RED**

Run:

```sh
npx vitest run src/agent/materializedCleanup.test.ts src/ui/session.test.ts
```

Expected: module/signature failures because cleanup does not exist.

- [ ] **Step 3: Implement guarded cleanup**

Create `src/agent/materializedCleanup.ts`:

```ts
import { rmSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

const OWNED_PREFIXES = [
  `${sep}.agents${sep}skills${sep}karst-`,
  `${sep}.codex${sep}karst${sep}`,
  `${sep}.karst-plugin${sep}`,
  `${sep}.agents${sep}plugins${sep}`,
] as const;

export function cleanupOwnedPaths(
  worktreePath: string,
  ownedPaths: readonly string[],
): void {
  const root = resolve(worktreePath);
  for (const candidate of ownedPaths) {
    const target = resolve(root, candidate);
    const rel = relative(root, target);
    const inside = rel !== '' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
    const normalized = `${sep}${rel.split(sep).join(sep)}`;
    const reserved = OWNED_PREFIXES.some((prefix) => normalized.startsWith(prefix));
    if (!inside || !reserved) {
      throw new Error(`karst: unsafe adapter-owned path "${candidate}"`);
    }
    rmSync(target, { recursive: true, force: true });
  }
}
```

Extend `SessionManager` with an injected cleanup function and store the paths in
the close closure:

```ts
export type CleanupOwnedPaths = (
  worktreePath: string,
  ownedPaths: readonly string[],
) => void;

constructor(
  private readonly host: TerminalHost,
  private readonly hookChannelFor: HookChannelFor,
  private readonly onDidCloseSession?: (ticketId: number) => void,
  private readonly cleanup: CleanupOwnedPaths = cleanupOwnedPaths,
) {}
```

Add `ownedPaths: string[] = []` as the final `openSession` argument and call:

```ts
terminal.onDidClose(() => {
  this.terminals.delete(ticketId);
  try {
    this.cleanup(worktreePath, ownedPaths);
  } finally {
    this.onDidCloseSession?.(ticketId);
  }
});
```

- [ ] **Step 4: Run tests and verify GREEN**

Run:

```sh
npx vitest run src/agent/materializedCleanup.test.ts src/ui/session.test.ts
```

Expected: all selected tests pass.

- [ ] **Step 5: Commit**

```sh
git add src/agent/materializedCleanup.ts src/agent/materializedCleanup.test.ts src/ui/session.ts src/ui/session.test.ts
git commit -m "feat: clean agent-owned session artifacts safely"
```

---

### Task 3: Implement Codex interactive and headless execution

**Files:**

- Create: `src/agent/codex.ts`
- Create: `src/agent/codex.test.ts`

**Interfaces:**

- Consumes: `AgentAdapter`, `InteractiveCommandOpts`, and `RunHeadlessOpts`.
- Produces: `CodexAdapter`.
- Produces: `SpawnHeadless` injected async seam.
- Produces: `parseCodexJsonl(stdout: string): { sessionId: string; raw: string }`.

- [ ] **Step 1: Write failing command and parser tests**

Create `src/agent/codex.test.ts` with:

```ts
import { describe, expect, it, vi } from 'vitest';
import {
  CodexAdapter,
  parseCodexJsonl,
  type SpawnHeadless,
} from './codex.js';

const okJsonl = [
  JSON.stringify({ type: 'thread.started', thread_id: 'thread-7' }),
  JSON.stringify({
    type: 'item.completed',
    item: { id: 'i1', type: 'agent_message', text: 'first' },
  }),
  JSON.stringify({
    type: 'item.completed',
    item: { id: 'i2', type: 'agent_message', text: 'final' },
  }),
  JSON.stringify({ type: 'turn.completed', usage: {} }),
].join('\n');

function fakeSpawn(
  result: { stdout: string; stderr?: string; exitCode: number },
): SpawnHeadless {
  return async () => ({
    stdout: result.stdout,
    stderr: result.stderr ?? '',
    exitCode: result.exitCode,
  });
}

describe('CodexAdapter interactive commands', () => {
  it('declares truthful capabilities and binary', () => {
    const adapter = new CodexAdapter();
    expect(adapter.requiredBinary).toBe('codex');
    expect(adapter.capabilities).toEqual({
      lifecycleEvents: true,
      resume: true,
    });
  });

  it('builds a fresh interactive launch', () => {
    const cmd = new CodexAdapter().buildInteractiveCommand({
      cwd: '/wt',
      model: 'custom-model',
      extraArgs: ['--no-alt-screen'],
      initialPrompt: '- inspect\ncarefully',
    });
    expect(cmd).toEqual({
      command: 'codex',
      args: ['--model', 'custom-model', '--no-alt-screen', '--', '- inspect\ncarefully'],
      env: {},
    });
  });

  it('builds a resumed interactive launch', () => {
    const cmd = new CodexAdapter().buildInteractiveCommand({
      cwd: '/wt',
      resume: '0199-thread',
      model: 'custom-model',
      initialPrompt: 'continue',
    });
    expect(cmd).toEqual({
      command: 'codex',
      args: ['resume', '--model', 'custom-model', '0199-thread', 'continue'],
      env: {},
    });
  });
});

describe('parseCodexJsonl', () => {
  it('returns the thread id and last completed agent message', () => {
    expect(parseCodexJsonl(okJsonl)).toEqual({
      sessionId: 'thread-7',
      raw: 'final',
    });
  });

  it.each([
    ['malformed JSON', '{"type":'],
    ['missing thread', JSON.stringify({ type: 'turn.completed' })],
    [
      'failed turn',
      [
        JSON.stringify({ type: 'thread.started', thread_id: 't' }),
        JSON.stringify({ type: 'turn.failed', error: { message: 'bad' } }),
      ].join('\n'),
    ],
    [
      'error event',
      [
        JSON.stringify({ type: 'thread.started', thread_id: 't' }),
        JSON.stringify({ type: 'error', message: 'bad' }),
      ].join('\n'),
    ],
  ])('rejects %s', (_label, stdout) => {
    expect(() => parseCodexJsonl(stdout)).toThrow();
  });
});

describe('CodexAdapter headless execution', () => {
  it('runs a fresh JSONL exec', async () => {
    const spawn = vi.fn(fakeSpawn({ stdout: okJsonl, exitCode: 0 }));
    const result = await new CodexAdapter(spawn).runHeadless({
      cwd: '/wt',
      prompt: '- inspect',
      permissionMode: 'bypassPermissions',
      model: 'custom-model',
    });

    expect(spawn).toHaveBeenCalledWith(
      'codex',
      [
        'exec',
        '--json',
        '--model',
        'custom-model',
        '--ask-for-approval',
        'never',
        '--sandbox',
        'workspace-write',
        '--',
        '- inspect',
      ],
      '/wt',
    );
    expect(result).toEqual({
      sessionId: 'thread-7',
      verdict: null,
      raw: 'final',
    });
  });

  it('runs a resumed JSONL exec', async () => {
    const spawn = vi.fn(fakeSpawn({ stdout: okJsonl, exitCode: 0 }));
    await new CodexAdapter(spawn).runHeadless({
      cwd: '/wt',
      prompt: 'continue',
      resume: 'thread-7',
    });
    expect(spawn).toHaveBeenCalledWith(
      'codex',
      ['exec', 'resume', '--json', 'thread-7', 'continue'],
      '/wt',
    );
  });

  it('reports bounded diagnostics for a nonzero exit', async () => {
    const stderr = 'x'.repeat(20_000);
    const adapter = new CodexAdapter(
      fakeSpawn({ stdout: '', stderr, exitCode: 2 }),
    );
    await expect(
      adapter.runHeadless({ cwd: '/wt', prompt: 'go' }),
    ).rejects.toThrow(/codex exited 2/);
    try {
      await adapter.runHeadless({ cwd: '/wt', prompt: 'go' });
    } catch (error) {
      expect((error as Error).message.length).toBeLessThan(9_000);
    }
  });
});
```

Add `model?: string` to `RunHeadlessOpts` because headless stages must honor the
same provider-scoped model selection.

- [ ] **Step 2: Run the test and verify RED**

Run:

```sh
npx vitest run src/agent/codex.test.ts
```

Expected: module-not-found and missing `RunHeadlessOpts.model` failures.

- [ ] **Step 3: Implement Codex execution and JSONL parsing**

Create `src/agent/codex.ts`:

```ts
import { spawn } from 'node:child_process';
import type {
  AgentAdapter,
  AgentCapabilities,
  HeadlessResult,
  InteractiveCommand,
  InteractiveCommandOpts,
  RunHeadlessOpts,
} from './adapter.js';

const CODEX_BIN = 'codex';
const MAX_DIAGNOSTIC_CHARS = 8_000;

export interface HeadlessSpawnResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type SpawnHeadless = (
  command: string,
  args: string[],
  cwd: string,
) => Promise<HeadlessSpawnResult>;

const defaultSpawn: SpawnHeadless = (command, args, cwd) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (data: unknown) => {
      stdout += String(data);
    });
    child.stderr?.on('data', (data: unknown) => {
      stderr += String(data);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ stdout, stderr, exitCode: code ?? 1 });
    });
  });

function diagnostic(text: string): string {
  return text.length <= MAX_DIAGNOSTIC_CHARS
    ? text
    : `${text.slice(0, MAX_DIAGNOSTIC_CHARS)}…`;
}

export function parseCodexJsonl(
  stdout: string,
): { sessionId: string; raw: string } {
  let sessionId = '';
  let raw = '';
  for (const [index, line] of stdout.split(/\r?\n/).entries()) {
    if (line.trim() === '') continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch (error) {
      throw new Error(
        `codex JSONL line ${index + 1} was invalid: ${(error as Error).message}`,
      );
    }
    if (event.type === 'thread.started' && typeof event.thread_id === 'string') {
      if (sessionId && sessionId !== event.thread_id) {
        throw new Error('codex JSONL contained multiple thread ids');
      }
      sessionId = event.thread_id;
    }
    if (event.type === 'turn.failed' || event.type === 'error') {
      throw new Error(`codex reported ${String(event.type)}: ${diagnostic(line)}`);
    }
    if (event.type === 'item.completed') {
      const item = event.item;
      if (
        typeof item === 'object' &&
        item !== null &&
        !Array.isArray(item) &&
        (item as Record<string, unknown>).type === 'agent_message' &&
        typeof (item as Record<string, unknown>).text === 'string'
      ) {
        raw = (item as Record<string, unknown>).text as string;
      }
    }
  }
  if (!sessionId) throw new Error('codex JSONL did not contain thread.started');
  if (!raw) throw new Error('codex JSONL did not contain a completed agent message');
  return { sessionId, raw };
}

function appendPolicyArgs(args: string[], permissionMode?: string): void {
  if (permissionMode === 'bypassPermissions') {
    args.push(
      '--ask-for-approval',
      'never',
      '--sandbox',
      'workspace-write',
    );
  }
}

export class CodexAdapter implements AgentAdapter {
  readonly requiredBinary = CODEX_BIN;
  readonly capabilities: AgentCapabilities = {
    lifecycleEvents: true,
    resume: true,
  };

  constructor(private readonly spawnHeadless: SpawnHeadless = defaultSpawn) {}

  buildInteractiveCommand(
    opts: InteractiveCommandOpts,
  ): InteractiveCommand {
    const args: string[] = [];
    if (opts.resume) args.push('resume');
    if (opts.model) args.push('--model', opts.model);
    if (opts.extraArgs?.length) args.push(...opts.extraArgs);
    if (opts.resume) {
      args.push(opts.resume);
      if (opts.initialPrompt) args.push(opts.initialPrompt);
    } else if (opts.initialPrompt) {
      args.push('--', opts.initialPrompt);
    }
    return { command: CODEX_BIN, args, env: {} };
  }

  async runHeadless(opts: RunHeadlessOpts): Promise<HeadlessResult> {
    const args = opts.resume
      ? ['exec', 'resume', '--json']
      : ['exec', '--json'];
    if (opts.model) args.push('--model', opts.model);
    appendPolicyArgs(args, opts.permissionMode);
    if (opts.resume) {
      args.push(opts.resume, opts.prompt);
    } else {
      args.push('--', opts.prompt);
    }
    const result = await this.spawnHeadless(CODEX_BIN, args, opts.cwd);
    if (result.exitCode !== 0) {
      throw new Error(
        `codex exited ${result.exitCode}: ${diagnostic(
          result.stderr || result.stdout,
        )}`,
      );
    }
    const parsed = parseCodexJsonl(result.stdout);
    return { ...parsed, verdict: null };
  }
}
```

Confirm the option ordering against the installed CLI help:

```sh
codex --help
codex resume --help
codex exec --help
codex exec resume --help
```

The verified 0.145.0 parser accepts `--` as the option terminator. Keep it in
fresh interactive and headless commands so a dash-prefixed prompt cannot become
an option.

- [ ] **Step 4: Run tests and verify GREEN**

Run:

```sh
npx vitest run src/agent/codex.test.ts
```

Expected: all Codex execution tests pass without invoking the real CLI.

- [ ] **Step 5: Commit**

```sh
git add src/agent/adapter.ts src/agent/codex.ts src/agent/codex.test.ts
git commit -m "feat: add codex interactive and headless adapter"
```

---

### Task 4: Materialize neutral approaches as Codex skills

**Files:**

- Modify: `src/agent/codex.ts`
- Modify: `src/agent/codex.test.ts`
- Modify: `src/agent/workflowCommand.ts`
- Modify: `src/agent/workflowCommand.test.ts`

**Interfaces:**

- Consumes: `MaterializeOpts`.
- Produces: `CodexAdapter.materializeApproach`.
- Produces: `$karst-<approach> <ticket-key>` invocation template.
- Produces: reserved `ownedPaths` suitable for `cleanupOwnedPaths`.

- [ ] **Step 1: Write failing materialization tests**

Add to `src/agent/codex.test.ts` using a temporary base/worktree:

```ts
it('preserves skills and converts commands and agents to Codex skills', () => {
  const baseDir = makeBasePackage('rpi', [
    ['skills/planning/SKILL.md', '---\nname: planning\ndescription: Plan.\n---\nPlan.'],
    ['skills/planning/references/checks.md', '# checks'],
    ['commands/review.md', '# Review command'],
    ['agents/researcher.md', '# Researcher'],
  ]);
  const worktree = makeWorktree();

  const result = new CodexAdapter().materializeApproach!({
    baseDir,
    sessionDir: worktree,
    pkg: {
      id: 'rpi',
      label: 'RPI',
      artifacts: [
        { kind: 'skill', relPath: 'skills/planning/SKILL.md' },
        { kind: 'command', relPath: 'commands/review.md' },
        { kind: 'agent', relPath: 'agents/researcher.md' },
      ],
    },
  });

  expect(
    readFileSync(
      join(worktree, '.agents/skills/karst-rpi-planning/references/checks.md'),
      'utf8',
    ),
  ).toBe('# checks');
  expect(
    readFileSync(
      join(worktree, '.agents/skills/karst-rpi-review/SKILL.md'),
      'utf8',
    ),
  ).toContain('# Review command');
  expect(
    readFileSync(
      join(worktree, '.agents/skills/karst-rpi-researcher/SKILL.md'),
      'utf8',
    ),
  ).toContain('Delegate');
  expect(result.ownedPaths.every((path) => path.startsWith(worktree))).toBe(true);
});

it('generates a workflow skill and native invocation', () => {
  const worktree = makeWorktree();
  const result = new CodexAdapter().materializeApproach!({
    baseDir: makeBasePackage('rpi', []),
    sessionDir: worktree,
    pkg: {
      id: 'rpi',
      label: 'Research, Plan, Implement',
      workflow: [{ name: 'research' }, { name: 'plan' }],
    },
    cliContextPrefix: 'node cli.js context --ticket',
    cliStagePrefix: 'node cli.js stage impl pass --ticket',
    cliPhasePrefix: (name) => `node cli.js phase ${name} --ticket`,
  });

  expect(result.invocation).toBe('$karst-rpi');
  const body = readFileSync(
    join(worktree, '.agents/skills/karst-rpi/SKILL.md'),
    'utf8',
  );
  expect(body).toContain('name: karst-rpi');
  expect(body).toContain('node cli.js context --ticket $ARGUMENTS');
  expect(body).toContain('node cli.js phase research --ticket $ARGUMENTS');
  expect(body).toContain('node cli.js stage impl pass --ticket $ARGUMENTS');
});

it.each(['../escape', '/absolute', 'karst', 'a/b'])(
  'rejects unsafe approach id %s',
  (id) => {
    expect(() =>
      new CodexAdapter().materializeApproach!({
        baseDir: '/base',
        sessionDir: makeWorktree(),
        pkg: { id, label: id, workflow: [{ name: 'run' }] },
      }),
    ).toThrow(/unsafe|reserved/i);
  },
);
```

The helper functions in the test must create files with `mkdirSync`,
`writeFileSync`, and clean their temporary roots in `afterEach`.

- [ ] **Step 2: Run the test and verify RED**

Run:

```sh
npx vitest run src/agent/codex.test.ts src/agent/workflowCommand.test.ts
```

Expected: materialization tests fail because `CodexAdapter` has no
`materializeApproach`.

- [ ] **Step 3: Implement Codex skill materialization**

Add focused helpers to `src/agent/codex.ts`:

```ts
function assertSafeName(kind: string, name: string): void {
  if (
    name.length === 0 ||
    name === 'karst' ||
    name.includes('/') ||
    name.includes('\\') ||
    name === '..' ||
    isAbsolute(name)
  ) {
    throw new Error(`materializeApproach: unsafe or reserved ${kind} "${name}"`);
  }
}

function skillDocument(name: string, description: string, body: string): string {
  return [
    '---',
    `name: ${name}`,
    `description: ${description}`,
    '---',
    '',
    body,
  ].join('\n');
}

function writeSkill(
  worktree: string,
  name: string,
  description: string,
  body: string,
): string {
  assertSafeName('skill name', name);
  const dir = join(worktree, '.agents', 'skills', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), skillDocument(name, description, body));
  return dir;
}
```

Implement `materializeApproach`:

```ts
materializeApproach(opts: MaterializeOpts): Materialized {
  assertSafeName('approach id', opts.pkg.id);
  const owned = new Set<string>();
  const prefix = `karst-${opts.pkg.id}`;

  for (const artifact of opts.pkg.artifacts ?? []) {
    const source = join(opts.baseDir, opts.pkg.id, artifact.relPath);
    const base = basename(artifact.relPath, extname(artifact.relPath));
    assertSafeName('artifact name', base);
    const skillName = `${prefix}-${base}`;
    const destination = join(opts.sessionDir, '.agents', 'skills', skillName);

    if (artifact.kind === 'skill') {
      cpSync(dirname(source), destination, { recursive: true });
      const skillPath = join(destination, 'SKILL.md');
      const original = readFileSync(skillPath, 'utf8');
      writeFileSync(
        skillPath,
        skillDocument(
          skillName,
          `Use the ${base} workflow from ${opts.pkg.label}.`,
          original.replace(/^---[\s\S]*?---\s*/u, ''),
        ),
      );
    } else {
      const body = readFileSync(source, 'utf8');
      writeSkill(
        opts.sessionDir,
        skillName,
        artifact.kind === 'agent'
          ? `Delegate work using the ${base} role from ${opts.pkg.label}.`
          : `Run the ${base} command from ${opts.pkg.label}.`,
        artifact.kind === 'agent'
          ? `Delegate the requested work to a subagent following these instructions:\n\n${body}`
          : body,
      );
    }
    owned.add(destination);
  }

  if (opts.soloAgent) {
    assertSafeName('solo agent name', opts.soloAgent.name);
    const name = `karst-agent-${opts.soloAgent.name}`;
    owned.add(
      writeSkill(
        opts.sessionDir,
        name,
        `Delegate the ticket to the ${opts.soloAgent.name} role.`,
        `Delegate this ticket to a subagent following these instructions:\n\n${opts.soloAgent.body}`,
      ),
    );
  }

  const hasWorkflow = (opts.pkg.workflow?.length ?? 0) > 0;
  if (hasWorkflow) {
    const body = renderWorkflowCommand({
      id: opts.pkg.id,
      label: opts.pkg.label,
      phases: opts.pkg.workflow!,
      ...(opts.cliContextPrefix ? { contextCommand: opts.cliContextPrefix } : {}),
      ...(opts.cliStagePrefix ? { stageCommand: opts.cliStagePrefix } : {}),
      ...(opts.cliPhasePrefix ? { phaseCommand: opts.cliPhasePrefix } : {}),
    });
    owned.add(
      writeSkill(
        opts.sessionDir,
        prefix,
        `Run the ${opts.pkg.label} workflow for a Karst ticket.`,
        body,
      ),
    );
  }

  return {
    extraArgs: [],
    ownedPaths: [...owned],
    ...(hasWorkflow ? { invocation: `$${prefix}` } : {}),
  };
}
```

Import the required `node:fs`, `node:path`, adapter types, and
`renderWorkflowCommand`.

Keep `renderWorkflowCommand` provider-neutral by changing its heading from a
literal Claude command to:

```ts
const lines: string[] = [
  `# ${label}`,
  '',
  loadInstruction,
  '',
  'Then work through the following phases in order:',
  '',
];
```

Update the existing Claude/Antigravity tests that asserted the old heading.
Invocation syntax is now asserted from `Materialized.invocation`, not from the
workflow body.

- [ ] **Step 4: Run tests and verify GREEN**

Run:

```sh
npx vitest run src/agent/codex.test.ts src/agent/workflowCommand.test.ts src/agent/claude.test.ts src/agent/antigravity.test.ts
```

Expected: all selected tests pass.

- [ ] **Step 5: Commit**

```sh
git add src/agent/codex.ts src/agent/codex.test.ts src/agent/workflowCommand.ts src/agent/workflowCommand.test.ts src/agent/claude.test.ts src/agent/antigravity.test.ts
git commit -m "feat: materialize karst approaches as codex skills"
```

---

### Task 5: Bridge Codex lifecycle hooks into Karst

**Files:**

- Modify: `src/agent/codex.ts`
- Modify: `src/agent/codex.test.ts`
- Modify: `src/hooks/dispatch.ts`
- Modify: `src/hooks/dispatch.test.ts`

**Interfaces:**

- Produces: `buildCodexHookConfig(endpointUrl, worktreePath)`.
- Produces: generated `.codex/karst/bridge.cjs` and CLI `-c` hook overrides.
- Consumes: the existing loopback `POST /hooks` normalized payload.

- [ ] **Step 1: Write failing hook tests**

Add to `src/agent/codex.test.ts`:

```ts
it('materializes Codex command hooks and passes the project config layer', () => {
  const worktree = makeWorktree();
  const configDir = join(worktree, '.karst-runtime');
  mkdirSync(configDir, { recursive: true });

  const cmd = new CodexAdapter().buildInteractiveCommand({
    cwd: worktree,
    hookChannel: {
      endpointUrl: 'http://127.0.0.1:4567/hooks',
      configDir,
    },
    initialPrompt: 'go',
  });

  const bridgePath = join(worktree, '.codex', 'karst', 'bridge.cjs');
  expect(existsSync(bridgePath)).toBe(true);
  expect(cmd.args).not.toContain('--dangerously-bypass-hook-trust');
  const overrides = cmd.args.filter((arg, index) => cmd.args[index - 1] === '-c');
  expect(overrides).toHaveLength(6);
  expect(overrides.some((value) => value.startsWith('hooks.SessionStart='))).toBe(true);
  expect(overrides.some((value) => value.startsWith('hooks.PermissionRequest='))).toBe(true);
});

it('normalizes PermissionRequest without forwarding sensitive fields', async () => {
  const posted: unknown[] = [];
  const normalize = codexHookNormalizer((payload) => {
    posted.push(payload);
    return Promise.resolve();
  });
  await normalize({
    hook_event_name: 'PermissionRequest',
    session_id: 'thread-1',
    cwd: '/wt',
    prompt: 'secret prompt',
    tool_input: { command: 'secret command' },
  });
  expect(posted).toEqual([
    {
      hook_event_name: 'Notification',
      session_id: 'thread-1',
      cwd: '/wt',
      message: 'permission_prompt',
    },
  ]);
});
```

Add to `src/hooks/dispatch.test.ts`:

```ts
it('treats normalized Codex PermissionRequest as waiting', () => {
  dispatchHook(store, {
    hook_event_name: 'SessionStart',
    cwd: WT,
    session_id: 'thread-1',
  });
  dispatchHook(store, {
    hook_event_name: 'Notification',
    cwd: WT,
    message: 'permission_prompt',
  });
  expect(getTicket(store, id).agentState).toBe('waiting');
});
```

- [ ] **Step 2: Run tests and verify RED**

Run:

```sh
npx vitest run src/agent/codex.test.ts src/hooks/dispatch.test.ts
```

Expected: missing hook materializer/normalizer failures.

- [ ] **Step 3: Implement the pure event normalizer**

Add provider-neutral exported types and functions to `src/agent/codex.ts`:

```ts
type CodexHookInput = Record<string, unknown>;
type NormalizedHook = {
  hook_event_name: string;
  cwd: string;
  session_id: string;
  message?: string;
};

type PostHook = (payload: NormalizedHook) => Promise<void>;

export function codexHookNormalizer(post: PostHook) {
  return async (input: CodexHookInput): Promise<void> => {
    const event = input.hook_event_name;
    const cwd = input.cwd;
    const sessionId = input.session_id;
    if (
      typeof event !== 'string' ||
      typeof cwd !== 'string' ||
      typeof sessionId !== 'string'
    ) {
      return;
    }
    const mapped =
      event === 'PermissionRequest'
        ? { hook_event_name: 'Notification', message: 'permission_prompt' }
        : [
              'SessionStart',
              'UserPromptSubmit',
              'PostToolUse',
              'Stop',
              'SessionEnd',
            ].includes(event)
          ? { hook_event_name: event }
          : null;
    if (!mapped) return;
    await post({
      ...mapped,
      cwd,
      session_id: sessionId,
    });
  };
}
```

The generated CommonJS bridge must use only Node built-ins, read at most 64 KiB,
and POST only normalized fields:

```js
const http = require('node:http');

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  input += chunk;
  if (input.length > 64 * 1024) process.exit(0);
});
process.stdin.on('end', () => {
  let raw;
  try {
    raw = JSON.parse(input);
  } catch {
    process.exit(0);
  }
  const event = raw.hook_event_name;
  if (
    typeof event !== 'string' ||
    typeof raw.cwd !== 'string' ||
    typeof raw.session_id !== 'string'
  ) {
    process.exit(0);
  }
  const mapped =
    event === 'PermissionRequest'
      ? { hook_event_name: 'Notification', message: 'permission_prompt' }
      : ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'Stop', 'SessionEnd'].includes(event)
        ? { hook_event_name: event }
        : null;
  if (!mapped) process.exit(0);
  const payload = JSON.stringify({
    ...mapped,
    cwd: raw.cwd,
    session_id: raw.session_id,
  });
  const target = new URL(process.argv[2]);
  const req = http.request({
    hostname: target.hostname,
    port: target.port,
    path: target.pathname,
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(payload),
    },
    timeout: 2000,
  });
  req.on('error', () => process.exit(0));
  req.on('timeout', () => req.destroy());
  req.end(payload);
});
```

Write only `.codex/karst/bridge.cjs`. Use `JSON.stringify(process.execPath)` and
`JSON.stringify(path)` when composing its command so spaces and quotes cannot
alter argv. Pass each hook as a command-line config override; this avoids
overwriting or merging a repository-owned `.codex/hooks.json`:

```ts
const command = [
  JSON.stringify(process.execPath),
  JSON.stringify(bridgePath),
  JSON.stringify(channel.endpointUrl),
].join(' ');

const events = [
  'SessionStart',
  'UserPromptSubmit',
  'PostToolUse',
  'PermissionRequest',
  'Stop',
  'SessionEnd',
] as const;
for (const event of events) {
  const value =
    `[{ hooks = [{ type = "command", command = ${JSON.stringify(command)}, ` +
    'timeout = 3 }] }]';
  args.push('-c', `hooks.${event}=${value}`);
}
```

Codex parses `-c` values as TOML. The value above is a TOML array containing
inline tables; `JSON.stringify(command)` supplies a valid escaped basic string.
Add the overrides before the prompt or resume positional arguments.
Record only `.codex/karst` as owned. Add a test that creates a pre-existing
`.codex/hooks.json`, launches Codex through the adapter, and asserts that its
bytes are unchanged.

The implementation must launch with normal project trust. It must not pass a
trust bypass flag.

- [ ] **Step 4: Run tests and verify GREEN**

Run:

```sh
npx vitest run src/agent/codex.test.ts src/hooks/dispatch.test.ts src/hooks/endpoint.test.ts
```

Expected: all selected tests pass and existing endpoint behavior is unchanged.

- [ ] **Step 5: Commit**

```sh
git add src/agent/codex.ts src/agent/codex.test.ts src/hooks/dispatch.ts src/hooks/dispatch.test.ts
git commit -m "feat: bridge codex lifecycle events into karst"
```

---

### Task 6: Route every execution path through the current provider

**Files:**

- Modify: `src/extension.ts`
- Modify: `src/ui/session.test.ts`
- Modify: `src/agent/registry.test.ts`
- Test: existing workflow stage and dashboard action tests

**Interfaces:**

- Consumes: `resolveAdapter(currentManifest().agentProvider)`.
- Produces: `currentAgentAdapter(): AgentAdapter`.
- Consumes: `Materialized.invocation`, `ownedPaths`, and `extraArgs`.

- [ ] **Step 1: Add provider-routing regression tests**

Extend `src/ui/session.test.ts` with:

```ts
it('does not resolve a new adapter when focusing an existing ticket', () => {
  const first = fakeAdapter('codex');
  const second = fakeAdapter('claude');
  const { host, terminals } = fakeHost();
  const mgr = new SessionManager(
    host,
    () => ({ endpointUrl: 'http://127.0.0.1:1/hooks', configDir: '/runtime' }),
  );

  mgr.openSession(first.adapter, 1, '/wt/a');
  mgr.openSession(second.adapter, 1, '/wt/a');

  expect(terminals).toHaveLength(1);
  expect(terminals[0]!.shellPath).toBe('codex');
});
```

Update `src/agent/registry.test.ts` temporarily to assert that Codex still falls
back until Task 7. The provider-routing proof in this task is the per-launch
adapter test plus direct inspection of every `agentAdapter` reference removed
from `src/extension.ts`.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```sh
npx vitest run src/ui/session.test.ts
```

Expected: failure until the new `SessionManager` signature and focus behavior
are complete.

- [ ] **Step 3: Replace the activation-time adapter**

In `src/extension.ts`, remove:

```ts
const agentAdapter = resolveAdapter('claude');
```

After `currentManifest` is defined, add:

```ts
const currentAgentAdapter = (): AgentAdapter =>
  resolveAdapter(currentManifest()?.agentProvider ?? 'claude');
```

Construct the session manager with the host and provider-neutral channel:

```ts
const sessions = new SessionManager(
  makeTerminalHost(),
  () => {
    if (!endpoint) {
      throw new Error('karst: hook endpoint is not bound');
    }
    return {
      endpointUrl: endpoint.url,
      configDir: settingsDir,
    };
  },
  (ticketId) => maybeDrive(ticketId, 'session-closed'),
);
```

Retain the existing refusal to launch before the endpoint is bound.

Inside `karst.openSession`, resolve once:

```ts
const adapter = currentAgentAdapter();
```

Materialize before composing the workflow invocation:

```ts
let materialized: Materialized = { extraArgs: [], ownedPaths: [] };
try {
  const matPkg = pkg ?? (soloAgent ? { id: t.approach!, label: t.approach! } : null);
  if (matPkg && adapter.materializeApproach) {
    materialized = adapter.materializeApproach({
      pkg: matPkg,
      baseDir: approachesDirOrThrow(),
      sessionDir: wt.path,
      soloAgent,
      cliContextPrefix: buildCliContextPrefix(context, dbPath),
      cliStagePrefix: buildCliStagePrefix(context, dbPath),
      cliPhasePrefix: buildCliPhasePrefix(context, dbPath),
    });
  }
} catch (error) {
  logError(`approach materialization failed for ticket ${ticketId}`, error);
}

const invocation =
  materialized.invocation && pkg?.workflow?.length
    ? `${materialized.invocation} ${t.key ?? ''}`.trim()
    : null;
```

Then compose `initialPrompt`, resolve the model, and open the terminal:

```ts
sessions.openSession(
  adapter,
  ticketId,
  wt.path,
  { key: t.key, title: t.title },
  seedPrompt,
  materialized.extraArgs.length ? materialized.extraArgs : undefined,
  model,
  resumeId,
  naming,
  materialized.ownedPaths,
);
```

Replace every extension-host use of the removed variable:

```ts
makeDashboardActions(
  localStore,
  ticketId,
  currentAgentAdapter,
  // remaining arguments unchanged
);
```

Change `makeDashboardActions` to accept `agentAdapter: () => AgentAdapter` and
call `agentAdapter()` immediately before `runShipTicket`.

Likewise, pass `currentAgentAdapter()` into UAT, review, fix, classification,
and any other headless operation at the moment the operation starts. Verify with:

```sh
rg -n "agentAdapter|resolveAdapter\\(" src/extension.ts
```

Expected: no activation-time adapter constant; every adapter is resolved from
the live manifest or passed as the adapter that created a live session.

- [ ] **Step 4: Run routing and workflow tests**

Run:

```sh
npx vitest run src/ui/session.test.ts src/workflow src/ui/dashboard
npm run typecheck
```

Expected: selected tests and typecheck pass.

- [ ] **Step 5: Commit**

```sh
git add src/extension.ts src/ui/session.ts src/ui/session.test.ts
git commit -m "fix: route agent execution through configured provider"
```

---

### Task 7: Register Codex, dependencies, settings, and model behavior

**Files:**

- Modify: `src/agent/registry.ts`
- Modify: `src/agent/registry.test.ts`
- Modify: `src/runtime/deps.ts`
- Modify: `src/runtime/deps.test.ts`
- Modify: `src/agent/models.test.ts`
- Modify: `src/ui/settings/state.test.ts`
- Modify: `src/ui/settings/webview.html`
- Modify: `karst.example.yml`
- Modify: `docs/guides/adding-agent-core.md`

**Interfaces:**

- Produces: `resolveAdapter('codex') -> CodexAdapter`.
- Produces: Codex in `IMPLEMENTED_PROVIDERS`.
- Produces: confirmed `AGENT_CLI_DEPENDENCIES.codex`.
- Preserves: no curated Codex model rows.

- [ ] **Step 1: Write failing registration and dependency tests**

Change `src/agent/registry.test.ts`:

```ts
import { CodexAdapter } from './codex.js';

it('resolves codex to a CodexAdapter instance', () => {
  expect(resolveAdapter('codex')).toBeInstanceOf(CodexAdapter);
});

it('lists every usable provider in stable UI order', () => {
  expect(IMPLEMENTED_PROVIDERS).toEqual([
    'claude',
    'codex',
    'antigravity',
  ]);
});
```

Change the Codex dependency test in `src/runtime/deps.test.ts`:

```ts
it('returns the confirmed Codex entry', () => {
  const dep = agentDependency('codex');
  expect(dep.binary).toBe('codex');
  expect(dep.label).toBe('the OpenAI Codex CLI');
  expect(dep.install).toMatch(/openai\.com|developers\.openai\.com/);
  expect(AGENT_CLI_DEPENDENCIES.codex).toEqual(dep);
  expect(dep.binary).toBe(resolveAdapter('codex').requiredBinary);
});
```

Add to `src/agent/models.test.ts`:

```ts
it('offers no speculative curated Codex models', () => {
  expect(modelsForProvider('codex')).toEqual([]);
});

it('preserves an explicit custom Codex model id', () => {
  expect(
    resolveModelForProvider('codex', 'team-codex-model', undefined),
  ).toBe('team-codex-model');
});

it('drops a known model from another provider when Codex is selected', () => {
  expect(
    resolveModelForProvider('codex', 'claude-sonnet-5', undefined),
  ).toBeUndefined();
});
```

- [ ] **Step 2: Run tests and verify RED**

Run:

```sh
npx vitest run src/agent/registry.test.ts src/runtime/deps.test.ts src/agent/models.test.ts src/ui/settings/state.test.ts
```

Expected: registry and dependency assertions fail because Codex remains
unimplemented/generic.

- [ ] **Step 3: Register Codex**

Change `src/agent/registry.ts`:

```ts
import { CodexAdapter } from './codex.js';

export const IMPLEMENTED_PROVIDERS: readonly AgentProvider[] = [
  'claude',
  'codex',
  'antigravity',
];

const FACTORIES: Record<AgentProvider, () => AgentAdapter> = {
  claude: () => new ClaudeAdapter(),
  codex: () => new CodexAdapter(),
  antigravity: () => new AntigravityAdapter(),
};

export function resolveAdapter(provider: AgentProvider): AgentAdapter {
  return FACTORIES[provider]();
}
```

Remove the fallback-to-Claude comment and behavior. `AgentProvider` is a closed
validated union; silently launching the wrong provider is more dangerous than a
loud missing factory.

Add to `AGENT_CLI_DEPENDENCIES`:

```ts
codex: {
  binary: 'codex',
  label: 'the OpenAI Codex CLI',
  install:
    "Install the Codex CLI from https://developers.openai.com/codex/cli so the 'codex' command is on your PATH, then reload the window.",
  enables: 'sessions',
},
```

Keep `KNOWN_MODELS` unchanged. Codex deliberately receives no curated rows.

The settings HTML already contains `codex` in `KNOWN_AGENT_PROVIDERS`; confirm
that it becomes enabled from the state-provided implemented list and that the
model selector shows only:

```html
<option value="">No default (agent picks)</option>
```

Add a DOM-independent state assertion if necessary rather than introducing a
new webview runtime dependency.

Update `karst.example.yml` to document:

```yaml
# Agent CLI used for sessions: claude, codex, or antigravity.
agentProvider: claude
```

Add these lessons to `docs/guides/adding-agent-core.md`:

- resolve the adapter at operation time rather than extension activation;
- keep hook endpoints provider-neutral and provider configuration inside the
  adapter;
- return the provider-native invocation from materialization;
- track and clean only adapter-owned runtime paths.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run:

```sh
npx vitest run src/agent/registry.test.ts src/runtime/deps.test.ts src/agent/models.test.ts src/ui/settings/state.test.ts
```

Expected: all selected tests pass.

- [ ] **Step 5: Commit**

```sh
git add src/agent/registry.ts src/agent/registry.test.ts src/runtime/deps.ts src/runtime/deps.test.ts src/agent/models.test.ts src/ui/settings/state.test.ts src/ui/settings/webview.html karst.example.yml docs/guides/adding-agent-core.md
git commit -m "feat: enable codex as an agent provider"
```

---

### Task 8: Complete regression and manual verification

**Files:**

- Modify only files required by concrete verification failures.
- Do not weaken assertions or skip tests to obtain a green run.

**Interfaces:**

- Consumes: all preceding tasks.
- Produces: verified Codex provider behavior and an evidence-backed handoff.

- [ ] **Step 1: Run focused Codex and provider tests**

Run:

```sh
npx vitest run src/agent/codex.test.ts src/agent/materializedCleanup.test.ts src/agent/registry.test.ts src/agent/models.test.ts src/agent/settings.test.ts src/hooks/dispatch.test.ts src/hooks/endpoint.test.ts src/runtime/deps.test.ts src/ui/session.test.ts src/ui/settings/state.test.ts
```

Expected: all selected test files pass.

- [ ] **Step 2: Run static verification**

Run:

```sh
npm run typecheck
npm run build
```

Expected: both commands exit zero. Confirm the built settings webview contains
Codex as an enabled provider only through `IMPLEMENTED_PROVIDERS` state.

- [ ] **Step 3: Run the complete suite**

Run:

```sh
npm test
```

Expected: the full Vitest suite passes with no unhandled rejection or native
ABI failure.

- [ ] **Step 4: Inspect the final diff**

Run:

```sh
git diff --check
git status --short
rg -n "resolveAdapter\\('claude'\\)|const agentAdapter = resolveAdapter" src
rg -n "dangerously-bypass-hook-trust|dangerously-bypass-approvals-and-sandbox" src/agent/codex.ts
```

Expected:

- `git diff --check` prints nothing.
- The status contains only intended implementation changes plus pre-existing
  user work.
- No activation-time hardcoded Claude adapter remains.
- Codex contains neither dangerous bypass flag.

- [ ] **Step 5: Run F5 Extension Host verification**

Use a disposable ticket/worktree and perform:

1. Select `codex` in Karst settings and save.
2. Confirm dependency health probes `codex`.
3. Open the ticket session and confirm the terminal executable is `codex`.
4. Confirm the initial prompt contains the ticket context.
5. With a workflow approach, run the generated `$karst-<approach>` skill and
   verify `context`, `phase`, and restricted `stage` commands update Karst.
6. Trust the generated project hook through Codex's normal trust flow.
7. Confirm `SessionStart` stores the Codex session ID.
8. Trigger a permission request and confirm the ticket becomes waiting.
9. Submit a prompt and confirm the ticket returns to running.
10. Close and reopen at `impl` or `fix`; confirm `codex resume <id>` is used.
11. Close the terminal and confirm only Karst-owned generated skill/hook paths
    are removed; repository-owned `.agents` and `.codex` files remain.

- [ ] **Step 6: Commit verification fixes, if any**

If verification required code changes, add only the affected files and use:

```sh
git commit -m "fix: complete codex provider verification"
```

If no fixes were required, do not create an empty commit.

## Completion Criteria

- Selecting Codex launches Codex for interactive and headless work.
- Selecting Antigravity still launches Antigravity; the activation-time Claude
  binding is gone.
- Codex approach artifacts are discoverable as repository skills.
- Codex lifecycle events drive only `agent_state` and session persistence.
- A captured Codex session resumes at `impl` and `fix`.
- No dangerous Codex bypass flag is emitted.
- Generated runtime content cannot escape its reserved roots and is cleaned
  without touching repository-owned content.
- Codex is enabled in settings with no speculative model catalog.
- Focused tests, typecheck, full tests, build, and manual F5 verification pass.
