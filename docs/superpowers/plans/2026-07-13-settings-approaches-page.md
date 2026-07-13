# Settings Approaches Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rework the Settings › Approaches tab: swap the orchestrator command to `/karst:<id>`, guard enabling of not-installed approaches, add a command-content drawer, and restyle the tab as a grouped roster.

**Architecture:** The command swap uses **Design 2 (two plugins)** — a `karst` plugin holds generated orchestrator commands (`commands/<id>.md` → `/karst:<id>`), the existing `<id>` plugin keeps native fetched commands (`/<id>:research`). All plugin-format logic stays confined to `ClaudeAdapter.materializeApproach`. Enable-guard, drawer, and roster are settings-webview + host-action changes.

**Tech Stack:** TypeScript ESM (`.js` import suffix, `moduleResolution:Bundler`), vitest, better-sqlite3, VS Code webview (vanilla JS + `--vscode-*` CSS tokens).

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-13-settings-approaches-page-design.md`. Every task's requirements implicitly include it.
- Strict TDD: RED → GREEN. Conventional commits. Files <400 lines typical.
- `noUncheckedIndexedAccess` on: array access needs `!` or a guard.
- ESM: every relative import ends in `.js`.
- Plugin format exists ONLY in `src/agent/claude.ts` `materializeApproach`. No plugin concept leaks into install/manifest.
- All state updates return NEW objects (immutability). Never mutate manifest.
- Webview is untrusted: validate every message envelope in `parseSettingsMessage`; host actions re-check invariants (never trust the webview alone).
- Run `npm test` (vitest) and `npm run typecheck` (tsc --noEmit) before each commit.
- VS Code webview: color/type via `--vscode-*` tokens only — no custom palette.

---

### Task 1: Verify multi-plugin `--plugin-dir` loading (spike — gates Design 2)

**Files:**
- Modify (record outcome): `docs/superpowers/specs/2026-07-13-settings-approaches-page-design.md` (Workstream 1 "Open risk" section)

**Interfaces:**
- Consumes: nothing.
- Produces: a recorded decision — `TWO_FLAGS` (pass `--plugin-dir` twice), `PARENT_DIR` (one flag at the parent discovers all children), or `FALLBACK_DESIGN_1`. Tasks 2–4 read this decision.

- [ ] **Step 1: Build a throwaway two-plugin layout**

```bash
D=$(mktemp -d)
mkdir -p "$D/karst/.claude-plugin" "$D/karst/commands" "$D/rpi/.claude-plugin" "$D/rpi/commands"
printf '{"name":"karst","version":"0.0.0"}' > "$D/karst/.claude-plugin/plugin.json"
printf '{"name":"rpi","version":"0.0.0"}'   > "$D/rpi/.claude-plugin/plugin.json"
printf '# /karst:rpi\nsay KARST_OK'         > "$D/karst/commands/rpi.md"
printf '# /rpi:research\nsay RPI_OK'         > "$D/rpi/commands/research.md"
echo "$D"
```

- [ ] **Step 2: Try TWO_FLAGS — pass `--plugin-dir` twice, list commands headless**

```bash
claude --plugin-dir "$D/karst" --plugin-dir "$D/rpi" -p "List every slash command available to you that contains a colon. Output only the command names." --output-format text 2>&1 | tee /tmp/karst-spike-two.txt
```
Expected (pass): output mentions both `/karst:rpi` and `/rpi:research`.

- [ ] **Step 3: If TWO_FLAGS failed, try PARENT_DIR — one flag at the parent**

```bash
claude --plugin-dir "$D" -p "List every slash command available to you that contains a colon. Output only the command names." --output-format text 2>&1 | tee /tmp/karst-spike-parent.txt
```
Expected (pass): both commands appear.

- [ ] **Step 4: Record the decision in the spec**

Edit the spec's Workstream 1 "Open risk" section. Replace the risk paragraph with the confirmed mechanism, e.g.:
> RESOLVED: `--plugin-dir` accepts repetition; pass it once per plugin dir (`TWO_FLAGS`). Verified 2026-07-13 via headless command listing.

If BOTH failed, record `FALLBACK_DESIGN_1` and STOP — Tasks 2–4 must be re-planned for nested single-plugin (`/karst:<id>:<name>`, rewriting authored phase strings at install). Flag this to the reviewer before proceeding.

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/specs/2026-07-13-settings-approaches-page-design.md
git commit -m "docs: record multi-plugin --plugin-dir verification result"
```

---

### Task 2: Rename orchestrator to the `karst` plugin namespace (workflowCommand.ts)

**Files:**
- Modify: `src/agent/workflowCommand.ts`
- Test: `src/agent/workflowCommand.test.ts`

**Interfaces:**
- Consumes: `WorkflowPhase` from `../manifest/types.js`.
- Produces:
  - `export const KARST_PLUGIN_NAME = 'karst'`
  - `buildWorkflowInvocation(approachId: string, ticketKey: string): string` → `/karst:<id> <key>` (trimmed)
  - `renderWorkflowCommand(input: { id: string; label: string; phases: WorkflowPhase[] }): string` — title `# /karst:<id> — <label>`
  - `orchestratorCommandBasename(approachId: string): string` → the `.md` basename the materializer writes (`<id>`)

- [ ] **Step 1: Rewrite the failing tests**

Replace the contents of `src/agent/workflowCommand.test.ts` assertions that reference the old naming. Key cases:

```typescript
import { describe, it, expect } from 'vitest';
import {
  renderWorkflowCommand,
  buildWorkflowInvocation,
  orchestratorCommandBasename,
  KARST_PLUGIN_NAME,
} from './workflowCommand.js';
import type { WorkflowPhase } from '../manifest/types.js';

const rpiPhases: WorkflowPhase[] = [
  { name: 'describe' },
  { name: 'research', command: '/rpi:research' },
  { name: 'plan', command: '/rpi:plan' },
  { name: 'implement', command: '/rpi:implement' },
];

describe('renderWorkflowCommand', () => {
  it('titles the command /karst:<id>', () => {
    const body = renderWorkflowCommand({ id: 'rpi', label: 'Research, Plan, Implement', phases: rpiPhases });
    expect(body).toContain('/karst:rpi');
    expect(body).not.toContain('/rpi:karst');
    expect(body).toContain('Research, Plan, Implement');
  });
  it('still lists each native phase command in backticks', () => {
    const body = renderWorkflowCommand({ id: 'rpi', label: 'RPI', phases: rpiPhases });
    expect(body).toContain('`/rpi:research`');
    expect(body).toContain('`/rpi:plan`');
    expect(body).toContain('`/rpi:implement`');
  });
  it('references $ARGUMENTS', () => {
    expect(renderWorkflowCommand({ id: 'rpi', label: 'RPI', phases: rpiPhases })).toContain('$ARGUMENTS');
  });
});

describe('buildWorkflowInvocation', () => {
  it('builds /karst:<id> <key>', () => {
    expect(buildWorkflowInvocation('rpi', 'PROJ-9')).toBe('/karst:rpi PROJ-9');
    expect(buildWorkflowInvocation('rpi', 'PROJ-9')).toContain(`/${KARST_PLUGIN_NAME}:rpi`);
  });
  it('trims to just the command when the ticket key is empty', () => {
    expect(buildWorkflowInvocation('rpi', '')).toBe('/karst:rpi');
  });
});

describe('orchestratorCommandBasename', () => {
  it('is the approach id (registers as /karst:<id> under the karst plugin)', () => {
    expect(orchestratorCommandBasename('rpi')).toBe('rpi');
  });
  it('no drift: invocation command equals /<KARST_PLUGIN_NAME>:<basename>', () => {
    const id = 'rpi';
    const inv = buildWorkflowInvocation(id, 'K').split(' ')[0];
    expect(inv).toBe(`/${KARST_PLUGIN_NAME}:${orchestratorCommandBasename(id)}`);
  });
});
```

- [ ] **Step 2: Run tests — verify they fail**

Run: `npx vitest run src/agent/workflowCommand.test.ts`
Expected: FAIL — `KARST_PLUGIN_NAME` / `orchestratorCommandBasename` are not exported; title assertions fail.

- [ ] **Step 3: Rewrite `src/agent/workflowCommand.ts`**

```typescript
import type { WorkflowPhase } from '../manifest/types.js';

/**
 * Name of the karst-authored plugin that hosts every generated orchestrator
 * command. A Claude plugin named `karst` exposes its command files as
 * `/karst:<basename>`; the orchestrator file for approach `<id>` is `<id>.md`,
 * so it registers as `/karst:<id>` (§ Design 2 — two plugins). This constant is
 * the SINGLE source of truth shared by the materializer (plugin dir name), the
 * seed invocation, the command title, and the Settings chips, so they can't drift.
 */
export const KARST_PLUGIN_NAME = 'karst';

/** Basename (no `.md`) of the generated orchestrator file for an approach. */
export function orchestratorCommandBasename(approachId: string): string {
  return approachId;
}

/**
 * The seed's first line for a workflow approach: the slash command that actually
 * gets registered (`/karst:<id>`) followed by the ticket key. Trimmed so a null
 * key yields just the command.
 */
export function buildWorkflowInvocation(approachId: string, ticketKey: string): string {
  return `/${KARST_PLUGIN_NAME}:${orchestratorCommandBasename(approachId)} ${ticketKey}`.trim();
}

/**
 * Render the markdown body for the generated `/karst:<id>` slash command. Pure:
 * no fs, no side effects. Written to `karst/commands/<id>.md` inside the
 * karst-authored plugin at materialize time.
 */
export function renderWorkflowCommand(input: {
  id: string;
  label: string;
  phases: WorkflowPhase[];
}): string {
  const { id, label, phases } = input;
  const lines: string[] = [
    `# /${KARST_PLUGIN_NAME}:${orchestratorCommandBasename(id)} — ${label}`,
    '',
    'This command receives a ticket key as its argument, available in `$ARGUMENTS`. ' +
      'First, read and describe the ticket identified by `$ARGUMENTS` so you understand ' +
      'what is being asked before proceeding.',
    '',
    'Then work through the following phases in order:',
    '',
  ];
  phases.forEach((phase, i) => {
    const step = i + 1;
    const parts: string[] = [`**${phase.name}**`];
    if (phase.description !== undefined) parts.push(phase.description);
    if (phase.command !== undefined) parts.push(`Run the \`${phase.command}\` slash command.`);
    else parts.push('Handle this step manually (no native slash command for this phase).');
    lines.push(`${step}. ${parts.join(' — ')}`);
  });
  return lines.join('\n');
}
```

- [ ] **Step 4: Run tests — verify they pass**

Run: `npx vitest run src/agent/workflowCommand.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/agent/workflowCommand.ts src/agent/workflowCommand.test.ts
git commit -m "refactor: register orchestrator as /karst:<id> (two-plugin design)"
```

---

### Task 3: Two-plugin materialization (claude.ts)

**Files:**
- Modify: `src/agent/claude.ts` (`materializeApproach`, ~lines 121-189)
- Test: `src/agent/claude.test.ts`

**Interfaces:**
- Consumes: `KARST_PLUGIN_NAME`, `orchestratorCommandBasename`, `renderWorkflowCommand` from `./workflowCommand.js`; the Task 1 decision (`TWO_FLAGS` assumed — one `--plugin-dir` per plugin dir).
- Produces: `materializeApproach` returns `extraArgs` that load the `<id>` plugin (native artifacts + solo agent) AND, when a workflow is present, a sibling `karst` plugin holding `commands/<id>.md`. Two `--plugin-dir` flags when both exist.

- [ ] **Step 1: Write the failing test**

Add to `src/agent/claude.test.ts` (mirror the existing materialize test setup for `sessionDir`, `baseDir`, and a `pkg` with a `workflow`):

```typescript
it('materializes the orchestrator into a sibling karst plugin as commands/<id>.md', () => {
  const adapter = new ClaudeAdapter();
  const { sessionDir, baseDir, pkg } = makeWorkflowFixture('rpi'); // existing helper pattern
  const { extraArgs } = adapter.materializeApproach!({ sessionDir, baseDir, pkg });

  const karstCmd = join(sessionDir, '.karst-plugin', 'karst', 'commands', 'rpi.md');
  const karstManifest = join(sessionDir, '.karst-plugin', 'karst', '.claude-plugin', 'plugin.json');
  expect(existsSync(karstCmd)).toBe(true);
  expect(JSON.parse(readFileSync(karstManifest, 'utf8')).name).toBe('karst');
  // the <id> plugin must NOT contain the orchestrator anymore
  expect(existsSync(join(sessionDir, '.karst-plugin', 'rpi', 'commands', 'karst.md'))).toBe(false);
  // both plugin dirs are passed
  const dirs = extraArgs.filter((_, i) => extraArgs[i - 1] === '--plugin-dir');
  expect(dirs).toContain(join(sessionDir, '.karst-plugin', 'karst'));
  expect(dirs).toContain(join(sessionDir, '.karst-plugin', 'rpi'));
});
```

If `makeWorkflowFixture` doesn't exist, inline the fixture the same way the current materialize tests build `opts` (create `sessionDir`/`baseDir` under `mkdtempSync`, write a package with `workflow: [{name:'research',command:'/rpi:research'}]` and one command artifact).

- [ ] **Step 2: Run test — verify it fails**

Run: `npx vitest run src/agent/claude.test.ts`
Expected: FAIL — orchestrator is still written to `<id>/commands/karst.md`; only one `--plugin-dir`.

- [ ] **Step 3: Rewrite the workflow branch of `materializeApproach`**

Replace the current `if (hasWorkflow) { … writeFileSync(join(commandsDir, \`${KARST_COMMAND_NAME}.md\`), body); }` block and the single-`extraArgs` return. New shape:

```typescript
    // The <id> plugin dir holds ONLY the approach's own artifacts + solo agent.
    const idPluginDir = join(opts.sessionDir, '.karst-plugin', opts.pkg.id);
    // ...existing meta + artifact + solo-agent writes stay, targeting idPluginDir...

    const pluginDirs: string[] = [idPluginDir];

    if (hasWorkflow) {
      // Design 2: the generated orchestrator lives in a SIBLING `karst` plugin so
      // it registers as `/karst:<id>` (not `/<id>:karst`). Native commands stay
      // in the <id> plugin as `/<id>:<name>`.
      const karstDir = join(opts.sessionDir, '.karst-plugin', KARST_PLUGIN_NAME);
      const karstMeta = join(karstDir, '.claude-plugin');
      const karstCommands = join(karstDir, 'commands');
      mkdirSync(karstMeta, { recursive: true });
      mkdirSync(karstCommands, { recursive: true });
      writeFileSync(
        join(karstMeta, 'plugin.json'),
        JSON.stringify({ name: KARST_PLUGIN_NAME, version: '0.0.0' }, null, 2),
      );
      const body = renderWorkflowCommand({
        id: opts.pkg.id,
        label: opts.pkg.label,
        phases: opts.pkg.workflow!,
      });
      writeFileSync(join(karstCommands, `${orchestratorCommandBasename(opts.pkg.id)}.md`), body);
      pluginDirs.push(karstDir);
    }

    return { extraArgs: pluginDirs.flatMap((d) => ['--plugin-dir', d]) };
```

Rename the current `pluginDir` local to `idPluginDir` throughout the method (the meta/artifact/solo-agent writes). Update the import: replace `KARST_COMMAND_NAME` with `KARST_PLUGIN_NAME, orchestratorCommandBasename`. Update the doc-comment to describe the two-plugin split. Guard note: the `artifacts.length === 0 && !hasWorkflow && !solo` early-return stays.

- [ ] **Step 4: Run tests — verify they pass**

Run: `npx vitest run src/agent/claude.test.ts`
Expected: PASS. Then `npx vitest run` (full) to catch any fixture that asserted the old single-dir shape; fix those assertions to the two-plugin shape.

- [ ] **Step 5: Commit**

```bash
git add src/agent/claude.ts src/agent/claude.test.ts
git commit -m "feat: materialize orchestrator into sibling karst plugin (/karst:<id>)"
```

---

### Task 4: Update command listing + generated-chip detection

**Files:**
- Modify: `src/extension.ts` (`listApproachCommands`, ~lines 314-334)
- Modify: `src/ui/settings/webview.html` (`renderApproachCommands`, ~line 789)

**Interfaces:**
- Consumes: `KARST_PLUGIN_NAME`, `orchestratorCommandBasename` from `./agent/workflowCommand.js`.
- Produces: `listApproachCommands()` emits `/karst:<id>` for the generated orchestrator and `/<id>:<name>` for natives. The webview marks a chip "generated" when it starts with `/karst:`.

- [ ] **Step 1: Update `listApproachCommands` in `src/extension.ts`**

Change the generated-command line (currently `\`/${id}:${KARST_COMMAND_NAME}\``) and its import:

```typescript
        const commandNames = listArtifacts(pkg, 'command').map((a) => `/${id}:${basename(a.relPath, '.md')}`);
        result[id] = [
          ...(pkg.workflow?.length ? [`/${KARST_PLUGIN_NAME}:${orchestratorCommandBasename(id)}`] : []),
          ...commandNames,
        ];
```

Update the import at the top of `extension.ts` from `KARST_COMMAND_NAME` (and `buildWorkflowInvocation`, keep it) to also include `KARST_PLUGIN_NAME, orchestratorCommandBasename`. Update the comment above the loop to read `/karst:<id>` for the orchestrator.

- [ ] **Step 2: Update generated-chip detection in `webview.html`**

In `renderApproachCommands`, replace:

```javascript
      const isGenerated = c.endsWith(':karst');
```
with:
```javascript
      const isGenerated = c.startsWith('/karst:');
```

- [ ] **Step 3: Typecheck + full test run**

Run: `npm run typecheck && npx vitest run`
Expected: PASS. (No `vscode`-importing module loads under vitest; `extension.ts` logic exercised indirectly. If an extension-level test asserts the old `/rpi:karst` chip, update it to `/karst:rpi`.)

- [ ] **Step 4: Commit**

```bash
git add src/extension.ts src/ui/settings/webview.html
git commit -m "feat: list orchestrator as /karst:<id> and mark it generated in settings"
```

---

### Task 5: Enable-guard — reject enabling a not-installed approach

**Files:**
- Modify: `src/ui/settings/actions.ts` (`setApproachEnabled`, lines 156-177)
- Test: `src/ui/settings/actions.test.ts`

**Interfaces:**
- Consumes: `deps.listInstalledIds(): string[]` (already on `SettingsActionsDeps`).
- Produces: `setApproachEnabled(id, true)` posts an `error` and does NOT write the manifest when `id` is not in `listInstalledIds()`. Disabling (`enabled: false`) is always allowed.

- [ ] **Step 1: Write the failing test**

Add to `src/ui/settings/actions.test.ts` (follow the existing harness that builds `deps` with fakes + a `post` spy; `APPROACH_A` fixture already exists):

```typescript
it('rejects enabling an approach that is not installed', async () => {
  const posts: SettingsHostMessage[] = [];
  const writeManifest = vi.fn();
  const deps = makeDeps({
    writeManifest,
    listInstalledIds: () => [],                 // nothing installed
    loadState: () => ({ manifest: { approaches: [APPROACH_A] } as Manifest, error: null }),
  });
  const actions = buildSettingsActions(deps)({ post: (m) => posts.push(m), manifestPath: '/x' });

  await actions.setApproachEnabled(APPROACH_A.id, true);

  expect(writeManifest).not.toHaveBeenCalled();
  expect(posts.some((m) => m.type === 'error')).toBe(true);
});

it('still allows disabling a not-installed approach (cleanup path)', async () => {
  const writeManifest = vi.fn();
  const deps = makeDeps({
    writeManifest,
    listInstalledIds: () => [],
    loadState: () => ({ manifest: { approaches: [{ ...APPROACH_A, enabled: true }] } as Manifest, error: null }),
  });
  const actions = buildSettingsActions(deps)({ post: () => {}, manifestPath: '/x' });
  await actions.setApproachEnabled(APPROACH_A.id, false);
  expect(writeManifest).toHaveBeenCalled();
});
```

Match `makeDeps`/fixture names to whatever the existing `actions.test.ts` uses; if there's no `makeDeps` helper, construct the `deps` object inline exactly as the neighbouring tests do.

- [ ] **Step 2: Run test — verify it fails**

Run: `npx vitest run src/ui/settings/actions.test.ts`
Expected: FAIL — `writeManifest` is called and no error posts, because `setApproachEnabled` doesn't check install state.

- [ ] **Step 3: Add the guard**

In `setApproachEnabled`, after the `exists` check, before building `next`:

```typescript
      async setApproachEnabled(id: string, enabled: boolean): Promise<void> {
        const loaded = deps.loadState();
        const exists = (loaded.manifest.approaches ?? []).some((a) => a.id === id);
        if (!exists) {
          ctx.post({ type: 'error', message: `Unknown approach "${id}".` });
          return;
        }
        // Guard: an approach can only be ENABLED once installed. Disabling is
        // always allowed (lets a user turn off an approach that was uninstalled
        // out from under an `enabled: true` flag). Never trust the webview alone.
        if (enabled && !deps.listInstalledIds().includes(id)) {
          ctx.post({ type: 'error', message: `Install "${id}" before enabling it.` });
          return;
        }
        try {
          const next: Manifest = {
            ...loaded.manifest,
            approaches: (loaded.manifest.approaches ?? []).map((a) =>
              a.id === id ? { ...a, enabled } : a,
            ),
          };
          deps.writeManifest(ctx.manifestPath, next);
          deps.reloadManifest();
          deps.onChange();
          await pushStateWithInstalled();
        } catch (e) {
          ctx.post({ type: 'error', message: errorMessage(e) });
        }
      },
```

- [ ] **Step 4: Run tests — verify they pass**

Run: `npx vitest run src/ui/settings/actions.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ui/settings/actions.ts src/ui/settings/actions.test.ts
git commit -m "feat: block enabling a not-installed approach"
```

---

### Task 6: Command-body resolver (host action + message plumbing)

**Files:**
- Modify: `src/ui/settings/messages.ts` (message unions, `SettingsActions`, parse, route)
- Modify: `src/ui/settings/actions.ts` (`SettingsActionsDeps`, new action)
- Modify: `src/extension.ts` (wire the new dep)
- Test: `src/ui/settings/messages.test.ts`, `src/ui/settings/actions.test.ts`

**Interfaces:**
- Consumes: a new dep `readApproachCommandBody(approachId: string, command: string): string` (bound in `extension.ts` from `approachesDirOrThrow` + `readApproachPackage` + `renderWorkflowCommand`).
- Produces:
  - webview→host message `{ type: 'get-approach-command-body'; approachId: string; command: string }`
  - host→webview message `{ type: 'approach-command-body'; approachId: string; command: string; body: string }`
  - `SettingsActions.getApproachCommandBody(approachId: string, command: string): void`

- [ ] **Step 1: Write the failing message-parse test**

Add to `src/ui/settings/messages.test.ts`:

```typescript
it('parses get-approach-command-body', () => {
  expect(parseSettingsMessage({ type: 'get-approach-command-body', approachId: 'rpi', command: '/karst:rpi' }))
    .toEqual({ type: 'get-approach-command-body', approachId: 'rpi', command: '/karst:rpi' });
});
it('drops get-approach-command-body with a missing field', () => {
  expect(parseSettingsMessage({ type: 'get-approach-command-body', approachId: 'rpi' })).toBeNull();
});
it('routes get-approach-command-body to the action', () => {
  const calls: string[] = [];
  const actions = { ...noopActions(), getApproachCommandBody: (a: string, c: string) => calls.push(`${a}|${c}`) };
  routeSettingsAction({ type: 'get-approach-command-body', approachId: 'rpi', command: '/rpi:research' }, actions);
  expect(calls).toEqual(['rpi|/rpi:research']);
});
```

Use the existing `noopActions()` helper if present; otherwise build a full `SettingsActions` stub with no-op methods including the new `getApproachCommandBody`.

- [ ] **Step 2: Run test — verify it fails**

Run: `npx vitest run src/ui/settings/messages.test.ts`
Expected: FAIL — the new message type isn't parsed/routed and `getApproachCommandBody` isn't on `SettingsActions`.

- [ ] **Step 3: Extend `messages.ts`**

Add to `SettingsWebviewMessage`:
```typescript
  | { type: 'get-approach-command-body'; approachId: string; command: string }
```
Add to `SettingsHostMessage`:
```typescript
  | { type: 'approach-command-body'; approachId: string; command: string; body: string }
```
Add to `SettingsActions`:
```typescript
  /** Read a command's markdown body (native command file or generated orchestrator). */
  getApproachCommandBody(approachId: string, command: string): void;
```
Add a `parseSettingsMessage` case:
```typescript
    case 'get-approach-command-body':
      return str('approachId') && str('command')
        ? { type: 'get-approach-command-body', approachId: raw.approachId as string, command: raw.command as string }
        : null;
```
Add a `routeSettingsAction` case:
```typescript
    case 'get-approach-command-body':
      actions.getApproachCommandBody(msg.approachId, msg.command);
      return;
```

- [ ] **Step 4: Run message tests — verify they pass**

Run: `npx vitest run src/ui/settings/messages.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing action test**

Add to `src/ui/settings/actions.test.ts`:

```typescript
it('posts a command body for a native command', async () => {
  const posts: SettingsHostMessage[] = [];
  const deps = makeDeps({
    readApproachCommandBody: (id, cmd) => `# ${cmd}\nbody-of-${id}`,
  });
  const actions = buildSettingsActions(deps)({ post: (m) => posts.push(m), manifestPath: '/x' });
  await actions.getApproachCommandBody('rpi', '/rpi:research');
  expect(posts).toContainEqual({
    type: 'approach-command-body', approachId: 'rpi', command: '/rpi:research', body: '# /rpi:research\nbody-of-rpi',
  });
});
it('posts an error (never throws) when a command body cannot be read', async () => {
  const posts: SettingsHostMessage[] = [];
  const deps = makeDeps({
    readApproachCommandBody: () => { throw new Error('no such command'); },
  });
  const actions = buildSettingsActions(deps)({ post: (m) => posts.push(m), manifestPath: '/x' });
  await actions.getApproachCommandBody('rpi', '/rpi:nope');
  expect(posts.some((m) => m.type === 'error')).toBe(true);
});
```

- [ ] **Step 6: Run — verify it fails**

Run: `npx vitest run src/ui/settings/actions.test.ts`
Expected: FAIL — `readApproachCommandBody` isn't a dep and the action doesn't exist.

- [ ] **Step 7: Implement the action + dep**

In `actions.ts`, add to `SettingsActionsDeps`:
```typescript
  /** Read a command's markdown body: a native `commands/<name>.md` file, or the
   *  generated `/karst:<id>` orchestrator rendered from the package's workflow. */
  readApproachCommandBody(approachId: string, command: string): string;
```
Add the action inside the returned object:
```typescript
      async getApproachCommandBody(approachId: string, command: string): Promise<void> {
        try {
          const body = deps.readApproachCommandBody(approachId, command);
          ctx.post({ type: 'approach-command-body', approachId, command, body });
        } catch (e) {
          ctx.post({ type: 'error', message: errorMessage(e) });
        }
      },
```

- [ ] **Step 8: Wire the dep in `extension.ts`**

Add to the `buildSettingsActions({ … })` deps object a `readApproachCommandBody`:
```typescript
      readApproachCommandBody: (approachId, command) => {
        const dir = approachesDirOrThrow();
        const pkg = readApproachPackage(dir, approachId);
        if (!pkg) throw new Error(`Approach "${approachId}" is not installed.`);
        // Generated orchestrator: /karst:<id> — render from the stored workflow.
        if (command === `/${KARST_PLUGIN_NAME}:${orchestratorCommandBasename(approachId)}`) {
          if (!pkg.workflow?.length) throw new Error(`Approach "${approachId}" has no workflow.`);
          return renderWorkflowCommand({ id: pkg.id, label: pkg.label, phases: pkg.workflow });
        }
        // Native command: /<id>:<name> — read commands/<name>.md from disk.
        const name = command.replace(new RegExp(`^/${approachId}:`), '');
        const art = listArtifacts(pkg, 'command').find((a) => basename(a.relPath, '.md') === name);
        if (!art) throw new Error(`No command "${command}" in approach "${approachId}".`);
        return readFileSync(join(dir, approachId, art.relPath), 'utf8');
      },
```
Ensure `readFileSync`, `join`, `basename`, `renderWorkflowCommand`, `KARST_PLUGIN_NAME`, `orchestratorCommandBasename`, `listArtifacts`, `readApproachPackage` are imported in `extension.ts` (most already are).

- [ ] **Step 9: Run full tests + typecheck**

Run: `npm run typecheck && npx vitest run`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add src/ui/settings/messages.ts src/ui/settings/messages.test.ts src/ui/settings/actions.ts src/ui/settings/actions.test.ts src/extension.ts
git commit -m "feat: resolve approach command bodies for the settings drawer"
```

---

### Task 7: Roster UI + command drawer + enable-guard styling (webview.html)

**Files:**
- Modify: `src/ui/settings/webview.html` (approaches section markup, CSS, drawer, message handler)

**Interfaces:**
- Consumes: state fields already pushed — `draft.approaches`, `installedIds`, `approachCommands`, each approach's `enabled`; the `approach-command-body` host message; posts `get-approach-command-body` and `set-approach-enabled`.
- Produces: no new exported interface — this is the view layer. Not unit-tested (no vscode-free seam); verified by build + manual smoke.

> This task is UI integration and has no unit test; its correctness rests on Tasks 2–6 (all covered) plus a manual smoke check. Keep the deliverable self-contained.

- [ ] **Step 1: Restyle the approaches list as a grouped roster**

Rework the approaches render (currently `renderApproaches` building `.approach-card` rows) to:
- Group approaches into `Installed` / `Available` / `Built-in` sections (installed = `installedIds.includes(id)`; built-in = no `source`; available = the rest), each with an uppercase `--vscode-descriptionForeground` section header.
- Render each as a card with a 4px left status rail (`--vscode-charts-green` installed, `--vscode-panel-border` otherwise), the `id` in `var(--mono)`, the label, and a right action cluster (enable toggle + install/uninstall affordance from the existing `approachInstallAffordance`).
- For installed approaches, render the existing `renderApproachCommands(id)` output as an `entry` line (chip starting `/karst:`) + a `runs` line (native chips), reusing the current `.chip` / `.chip.generated` classes.

Derive every color from `--vscode-*` tokens — no literal hex. Match the class/structure conventions already in the file (see the mockup `approaches-mockup.html` Option A for the target visual).

- [ ] **Step 2: Enforce the enable-guard in the view**

Render the enable toggle for a not-installed approach as disabled + muted, with `title="Install to enable"`, and do NOT post `set-approach-enabled` on click when not installed. (The host already rejects it — this keeps the UI honest.)

- [ ] **Step 3: Make command chips open a drawer**

- Give each command chip a `data-cmd` and `data-approach` attribute and a click handler that posts `{ type:'get-approach-command-body', approachId, command }`.
- Add a right-side drawer element (hidden by default) with a header (the command name in a `.chip.generated`-style token) and a `<pre>`-style body.
- Handle the `approach-command-body` host message: set the drawer header to `command`, the body to `body` (as text, not HTML — use `textContent`), and open the drawer. Add a close button and `Esc`-to-close.
- Respect `prefers-reduced-motion` for the drawer transition.

- [ ] **Step 4: Build + smoke test**

Run: `npm run build`
Expected: build succeeds; `scripts/copy-assets.mjs` copies the edited `webview.html` into `dist/`. (Edit the SOURCE `src/ui/settings/webview.html`, never the `dist/` copy.)

Manual smoke (F5 Extension Dev Host → Settings › Approaches):
- Installed approach shows `entry /karst:<id>` + native `runs` chips, grouped under "Installed".
- A not-installed approach's enable toggle is disabled.
- Clicking `/karst:rpi` opens the drawer with the orchestrator body; clicking `/rpi:research` shows that file's body.

- [ ] **Step 5: Commit**

```bash
git add src/ui/settings/webview.html
git commit -m "feat: grouped roster approaches tab with command drawer and enable guard"
```

---

## Self-Review Notes

- **Spec coverage:** WS1 → Tasks 1–4; WS2 → Task 5 (logic) + Task 7 Step 2 (view); WS3 → Task 6 (host) + Task 7 Step 3 (view); WS4 → Task 7 Steps 1–2. All spec sections mapped.
- **Type consistency:** `KARST_PLUGIN_NAME` + `orchestratorCommandBasename` introduced in Task 2, consumed identically in Tasks 3, 4, 6. Message/action names (`get-approach-command-body`, `approach-command-body`, `getApproachCommandBody`, `readApproachCommandBody`) are consistent across Tasks 6–7.
- **Fallback:** if Task 1 records `FALLBACK_DESIGN_1`, Tasks 2–4 re-plan for nested single-plugin (`/karst:<id>:<name>`) — flagged in Task 1 Step 4.
