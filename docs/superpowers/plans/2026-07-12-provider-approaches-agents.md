# Provider Select, Approach Orchestration, File-Backed Agents — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. One fresh subagent per Phase; code-review between phases.

**Goal:** Make karst provider-agnostic (selectable agent provider), turn approaches into orchestrated `/karst:<id>` workflows, and give agents editable file-backed definitions with enable/disable.

**Architecture:** Manifest stays source of truth; all new fields flow `types.ts → schema.ts (validate+default) → write.ts overlay` guarded by the round-trip test. Agent-specifics stay behind `AgentAdapter`; a provider registry replaces the hardcoded adapter. Approach orchestration is a generated command file inside the existing Claude `--plugin-dir` materialization — no new hook engine.

**Tech Stack:** TypeScript ESM (`.js` import suffixes, `moduleResolution:Bundler`, `noUncheckedIndexedAccess`), vitest with injected fakes (no `vscode` at runtime), better-sqlite3, self-contained webview HTML.

## Global Constraints

- ESM: every relative import needs a `.js` suffix.
- `noUncheckedIndexedAccess` is on: array/index access needs `!` or a guard.
- Immutability: never mutate inputs; return new objects (spread).
- New `Manifest` field checklist (or Save silently drops it): add to `types.ts` + `validateManifest` in `schema.ts` (default it) + `writeManifest` overlay in `write.ts`. Guard: `writeManifest.test.ts` "round-trips every modeled section".
- Approaches are agent-agnostic; the plugin format exists ONLY in `ClaudeAdapter`.
- `sanitizeFrontmatter` must run on every fetched/materialized untrusted body before it lands on disk.
- Two tsconfigs: `tsconfig.json` (typecheck/vitest), `tsconfig.build.json` (emit, excludes tests).
- Webview asset edits go in the SOURCE `src/ui/**/webview.html`, never `dist/`.
- Conventional commits. Files <400 lines typical. Verify each phase: `npm test` + `npm run typecheck` green before its code-review.

---

## Phase 1 — Seed + headless stdin fix

**Deps:** none. **Deliverable:** `suggestApproach`/headless runs no longer hang on stdin; full ticket prompt is verifiably seeded.

### Task 1.1: Fix `defaultSpawn` stdin

**Files:**
- Modify: `src/agent/claude.ts:36-46` (`defaultSpawn`)
- Test: `src/agent/claude.test.ts`

**Interfaces:**
- Consumes: `SpawnHeadless = (command, args, cwd) => Promise<HeadlessSpawnResult>` (unchanged signature).
- Produces: no API change; behavioral fix only.

- [ ] **Step 1: Write the failing test.** In `claude.test.ts`, add a test that spawns a fake command capturing whether stdin was closed. Since `defaultSpawn` uses the real `spawn`, test at the observable level: run `runHeadless` against a tiny node script that echoes JSON only if its stdin is at EOF, OR (simpler, preferred) refactor `defaultSpawn` to accept an injected child factory. Recommended concrete approach — assert the spawn options:

```ts
import { describe, it, expect, vi } from 'vitest';
// Spy on child_process.spawn to assert stdio ignores stdin.
vi.mock('node:child_process', async (orig) => {
  const actual = await orig<typeof import('node:child_process')>();
  return { ...actual };
});
```

Prefer the clean seam: export `defaultSpawn` (or a `makeDefaultSpawn(spawnImpl)`) and pass a fake `spawnImpl` that returns a fake child with `stdin: { end: vi.fn() }`, `stdout`/`stderr` as `EventEmitter`s, and `on('close')`. Assert either `spawnImpl` was called with `stdio: ['ignore','pipe','pipe']`, or `child.stdin.end()` was called.

- [ ] **Step 2: Run test, verify it fails.** `npx vitest run src/agent/claude.test.ts` → FAIL (stdin not closed / option absent).

- [ ] **Step 3: Implement.** Close stdin so `claude -p` never waits on a non-TTY pipe:

```ts
const defaultSpawn: SpawnHeadless = (command, args, cwd) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', reject);
    child.on('close', (code) => resolve({ stdout, stderr, exitCode: code ?? 1 }));
  });
```

(If a factory seam was introduced for testability, keep `defaultSpawn` as the default arg to `makeDefaultSpawn(spawn)`.)

- [ ] **Step 4: Run tests, verify pass.** `npx vitest run src/agent/claude.test.ts` → PASS.

- [ ] **Step 5: Commit.** `git commit -m "fix: close headless stdin so claude -p never waits on empty pipe"`

### Task 1.2: Assert full prompt seeded (regression lock)

**Files:**
- Modify: `src/agent/seed.test.ts`
- Verify (no change expected): `src/agent/seed.ts:61-83`

**Interfaces:**
- Consumes: `buildSessionSeed(ticket, approachPrompt?: string | null): string | undefined`.

- [ ] **Step 1: Write test** asserting the seed contains the ticket `description` (Prompt) verbatim AND the brief, in that order, so a future refactor can't silently drop the full prompt in favor of brief-only. Use an existing fixture ticket with distinct `description` and `brief` strings; assert `seed.indexOf(description) < seed.indexOf(brief)` and both `> -1`.
- [ ] **Step 2: Run, expect PASS** (current code already seeds both — this locks it). `npx vitest run src/agent/seed.test.ts`.
- [ ] **Step 3: Commit.** `git commit -m "test: lock full-prompt-before-brief seeding invariant"`

### Task 1.3: Phase gate

- [ ] `npm test && npm run typecheck` → all green. Hand to code-review.

---

## Phase 2 — Manifest foundations

**Deps:** none. **Deliverable:** all new manifest fields parse, default, and round-trip. No behavior wired yet.

### Task 2.1: `agentProvider` field

**Files:**
- Modify: `src/manifest/types.ts` (add type + `Manifest.agentProvider`)
- Modify: `src/manifest/schema.ts` (`validateManifest` — parse + default)
- Modify: `src/manifest/write.ts:97-107` (overlay)
- Test: `src/manifest/load.test.ts`, `src/manifest/writeManifest.test.ts`

**Interfaces:**
- Produces:
```ts
export type AgentProvider = 'claude' | 'codex';
// Manifest gains: agentProvider?: AgentProvider  // always set by validate, default 'claude'
```

- [ ] **Step 1: Failing test** in `load.test.ts`: a manifest omitting `agentProvider` loads with `agentProvider === 'claude'`; one with `agentProvider: 'codex'` preserves it; an invalid value throws `ManifestError`.
- [ ] **Step 2: Run, verify fail.** `npx vitest run src/manifest/load.test.ts`.
- [ ] **Step 3: Implement.** Add `AgentProvider` + `Manifest.agentProvider?` to `types.ts`. In `schema.ts` add `validateAgentProvider(raw): AgentProvider` (default `'claude'`; accept only `'claude'|'codex'`, else throw) and set it in `validateManifest`. In `write.ts` overlay add `agentProvider: manifest.agentProvider ?? 'claude'`.
- [ ] **Step 4: Run, verify pass.**
- [ ] **Step 5: writeManifest round-trip test** — add `agentProvider` to the "round-trips every modeled section" fixture; run `npx vitest run src/manifest/writeManifest.test.ts` → PASS.
- [ ] **Step 6: Commit.** `git commit -m "feat: add agentProvider manifest field (default claude)"`

### Task 2.2: `ApproachDef.workflow` + `enabled`

**Files:** same manifest trio + tests.

**Interfaces:**
- Produces:
```ts
export interface WorkflowPhase {
  name: string;          // e.g. "research"
  command?: string;      // native slash command to invoke, e.g. "/rpi:research"
  description?: string;  // human guidance for the phase
}
export interface ApproachDef {
  // ...existing...
  workflow?: WorkflowPhase[];
  enabled?: boolean;     // default true; when false, hidden from create/edit flow
}
```

- [ ] **Step 1: Failing test** in `load.test.ts`: an approach with `workflow: [{name:'research',command:'/rpi:research'}]` round-parses; a phase missing `name` throws; `enabled` absent defaults to `true`; `enabled:false` preserved.
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement.** In `types.ts` add `WorkflowPhase` + fields. In `schema.ts` `validateApproaches` (after the `source` block, before `recommended`): parse `a.workflow` via a new `validateWorkflow(raw, where): WorkflowPhase[]` (each item object, `name` required string, `command`/`description` optional strings); set `approach.enabled = a.enabled === false ? false : true`.
- [ ] **Step 4: Run, verify pass.**
- [ ] **Step 5: Round-trip** — extend the writeManifest fixture approach with `workflow` + `enabled:false`; run `writeManifest.test.ts` → PASS.
- [ ] **Step 6: Commit.** `git commit -m "feat: add approach workflow + enabled manifest fields"`

### Task 2.3: File-backed agents model (`agentsDir` + `AgentDef.enabled`)

**Files:**
- Modify: `src/manifest/types.ts` (extend `AgentDef`)
- Modify: `src/manifest/schema.ts` (`validateAgents`)
- Modify: `src/manifest/write.ts` overlay
- Modify: `package.json` (add `karst.agentsDir` VS Code setting, default `./.karst/agents`, mirroring `karst.approachesDir` at `package.json:121-123`)
- Modify: `src/extension/manifestResolve.ts` (resolve `agentsDir` like `approachesDir`)
- Test: `src/manifest/load.test.ts`

**Interfaces:**
- Produces:
```ts
export interface AgentDef {
  role: string;
  command?: string;
  promptPath?: string;   // relative path to the agent's markdown file under agentsDir
  enabled?: boolean;     // default true
}
```
Note: `promptPath` bridges legacy yaml agents to files; the primary agent authoring is the `.karst/agents/*.md` files handled in Phase 5. Here we only extend the type + validation + settings key.

- [ ] **Step 1: Failing test:** legacy `agents: { r: { role:'research' } }` still loads with `enabled` defaulting true; `enabled:false` + `promptPath` preserved.
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement.** Extend `AgentDef`; in `validateAgents` parse optional `promptPath` (string) and default `enabled` (`a.enabled === false ? false : true`). Add `karst.agentsDir` to `package.json` config + resolve in `manifestResolve.ts` (function `agentsDirOrThrow()` mirroring `approachesDirOrThrow()`).
- [ ] **Step 4: Run, verify pass.**
- [ ] **Step 5: Round-trip** — add `promptPath`+`enabled` to writeManifest agents fixture; PASS.
- [ ] **Step 6: Commit.** `git commit -m "feat: agent enabled/promptPath fields + karst.agentsDir setting"`

### Task 2.4: Phase gate

- [ ] `npm test && npm run typecheck` green. Update `karst.example.yml`: add `agentProvider: claude`, add `workflow:` to the `rpi` approach (phases: describe / research `/rpi:research` / plan `/rpi:plan` / implement `/rpi:implement`), keep others unchanged. Run tests. Commit `docs: seed rpi workflow + agentProvider in example manifest`. Hand to code-review.

---

## Phase 3 — Provider selection

**Deps:** P2 (`agentProvider`). **Deliverable:** adapter chosen from manifest; Settings shows provider select with Codex disabled.

### Task 3.1: Adapter registry

**Files:**
- Create: `src/agent/registry.ts`
- Test: `src/agent/registry.test.ts`
- Modify: `src/extension.ts:120`, `:208` (use registry)

**Interfaces:**
- Consumes: `AgentProvider` (P2), `AgentAdapter` (`src/agent/adapter.ts:78`), `ClaudeAdapter`.
- Produces:
```ts
export function resolveAdapter(provider: AgentProvider): AgentAdapter;
// 'claude' -> new ClaudeAdapter(); unknown/unimplemented -> ClaudeAdapter + console.warn-free
//   surfaced fallback (return claude; caller may warn). Keep pure/testable.
export const IMPLEMENTED_PROVIDERS: readonly AgentProvider[] = ['claude'];
```

- [ ] **Step 1: Failing test:** `resolveAdapter('claude') instanceof ClaudeAdapter`; `resolveAdapter('codex')` falls back to a `ClaudeAdapter` (documented MVP behavior) — assert instance; `IMPLEMENTED_PROVIDERS` equals `['claude']`.
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement** `registry.ts` with a `Record<AgentProvider, () => AgentAdapter>` where only `claude` is registered; `resolveAdapter` looks up, else falls back to claude.
- [ ] **Step 4: Run, verify pass.**
- [ ] **Step 5: Wire `extension.ts`** — replace both `new ClaudeAdapter()` with `resolveAdapter(manifest.agentProvider ?? 'claude')`. Typecheck.
- [ ] **Step 6: Commit.** `git commit -m "feat: provider-keyed agent adapter registry"`

### Task 3.2: Settings provider select

**Files:**
- Modify: `src/ui/settings/state.ts` (expose `agentProvider` + `implementedProviders`)
- Modify: `src/ui/settings/messages.ts` (new `set-provider` action) + `actions.ts` (persist via manifest write) + `webview.html` (select in General or a new Provider row, non-claude `disabled`)
- Test: `src/ui/settings/actions.test.ts`, `state.test.ts`

**Interfaces:**
- Consumes: `resolveAdapter`, `IMPLEMENTED_PROVIDERS`, manifest write path used by existing `save`.
- Produces: `SettingsActions.setProvider(provider: AgentProvider): Promise<void>` (writes manifest.agentProvider via reload+write, then `onChange`).

- [ ] **Step 1: Failing test** in `actions.test.ts`: `setProvider('claude')` writes manifest with `agentProvider:'claude'`; provider not in `IMPLEMENTED_PROVIDERS` is rejected (throws) so a disabled option can't be forced through the message boundary.
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement** state field, message parse/route (validate discriminant + provider value), action persisting to manifest. In `webview.html` render `<select>` with options from `implementedProviders` enabled and known-but-unimplemented (`codex`) rendered `disabled` with "(coming soon)".
- [ ] **Step 4: Run, verify pass.**
- [ ] **Step 5: Commit.** `git commit -m "feat: agent provider select in settings (claude only functional)"`

### Task 3.3: Phase gate

- [ ] `npm test && npm run typecheck` green. Code-review.

---

## Phase 4 — Approach orchestration engine

**Deps:** P1, P2. **Deliverable:** an approach with a `workflow` materializes a `/karst:<id>` command and launches with `/karst:<id> <ticket-key>` seeded.

### Task 4.1: Generate the `karst-<id>` command markdown

**Files:**
- Create: `src/agent/workflowCommand.ts` (pure generator — no fs, agent-agnostic content)
- Test: `src/agent/workflowCommand.test.ts`

**Interfaces:**
- Consumes: `WorkflowPhase` (P2).
- Produces:
```ts
export function renderWorkflowCommand(input: {
  id: string;
  label: string;
  phases: WorkflowPhase[];
}): string; // returns the markdown body for commands/karst-<id>.md
```
Body shape (deterministic, assert substrings, not whole-string): a title `# /karst:<id> — <label>`, a line instructing to read the ticket named by the `$ARGUMENTS`/`<ticket-key>` passed to the command, then a numbered list — one entry per phase: `N. <name>` + its `description` +, when `command` present, "run `<command>`". A phase without `command` is a manual step (e.g. describe).

- [ ] **Step 1: Failing test:** given rpi phases, output contains `/karst:rpi`, an ordered `1.`…`4.`, `` `/rpi:research` ``, `` `/rpi:plan` ``, `` `/rpi:implement` ``, and references the ticket key placeholder.
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement** the pure renderer (string building, no fs).
- [ ] **Step 4: Run, verify pass.**
- [ ] **Step 5: Commit.** `git commit -m "feat: render karst:<id> workflow command markdown"`

### Task 4.2: Materialize the generated command into the plugin

**Files:**
- Modify: `src/agent/claude.ts:90-121` (`materializeApproach`)
- Modify: `src/agent/adapter.ts` (`MaterializablePackage` — add optional `workflow`, `label`)
- Test: `src/agent/claude.test.ts`

**Interfaces:**
- Consumes: `renderWorkflowCommand`, `sanitizeFrontmatter` (`src/approaches/sanitize.ts`).
- Produces: `materializeApproach` now, when `pkg.workflow?.length`, ALSO writes `pluginDir/commands/karst-<id>.md` (sanitized) even if `artifacts` is empty — so a workflow-only approach still materializes a plugin. Update the early `artifacts.length === 0` guard to `artifacts.length === 0 && !pkg.workflow?.length`.

- [ ] **Step 1: Failing test:** a `pkg` with `workflow` (and possibly zero artifacts) materializes `commands/karst-<id>.md` containing the rendered body, and `extraArgs` includes `--plugin-dir`. A `pkg` with neither artifacts nor workflow → `extraArgs: []` (unchanged).
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement.** Extend `MaterializablePackage` (adapter.ts) with `workflow?: WorkflowPhase[]` and `label?: string` (keep the agent boundary free of the approaches module — mirror the existing minimal-shape pattern). In `materializeApproach`, after writing artifacts, if `pkg.workflow?.length` write the sanitized generated command to `commands/karst-<id>.md` (mkdir `commands/` first). Loosen the empty guard.
- [ ] **Step 4: Run, verify pass.**
- [ ] **Step 5: Commit.** `git commit -m "feat: materialize generated karst:<id> command into plugin"`

### Task 4.3: Pass workflow through readApproachPackage → launch

**Files:**
- Modify: `src/approaches/pkg.ts` (`ApproachPackage` type + `writeApproachArtifacts` + `readApproachPackage` to persist/read `workflow`)
- Modify: `src/approaches/fetch.ts` (`assembleAndWrite` carries `def.workflow` into the written package)
- Test: `src/approaches/pkg.test.ts`, `src/approaches/fetch.test.ts`

**Interfaces:**
- Produces: `ApproachPackage` gains `workflow?: WorkflowPhase[]`; persisted in `approach.yml`; read back by `readApproachPackage`.

- [ ] **Step 1: Failing test:** write a package with `workflow`, read it back, assert equality; a package without workflow reads `undefined`.
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement** the field in the type, writer, reader, and thread `def.workflow` through `assembleAndWrite` in fetch.ts.
- [ ] **Step 4: Run, verify pass.**
- [ ] **Step 5: Commit.** `git commit -m "feat: persist approach workflow in neutral package"`

### Task 4.4: Seed the `/karst:<id> <ticket-key>` invocation

**Files:**
- Modify: `src/agent/seed.ts` (new optional leading invocation)
- Modify: `src/extension.ts:323-390` (openSession: when the approach has a workflow, compute the invocation and pass it)
- Test: `src/agent/seed.test.ts`, `src/agent/direct-launch.test.ts`

**Interfaces:**
- Produces:
```ts
// seed.ts
export function buildSessionSeed(
  ticket: SeedTicket,
  approachPrompt?: string | null,
  invocation?: string | null, // e.g. "/karst:rpi 869e3j557"; prepended as the FIRST line when present
): string | undefined;
```
When `invocation` is present, the seed starts with the invocation line, a blank line, then the existing ticket-context + approach block. When absent, output is byte-for-byte the current behavior (guard with a dedicated test).

- [ ] **Step 1: Failing test:** with `invocation='/karst:rpi KEY'`, seed's first line is exactly that; ticket context still follows. Without invocation, output unchanged (compare to a snapshot of current output).
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement** the optional prepend in `seed.ts`; in `extension.ts` build `invocation = pkg.workflow?.length ? \`/karst:${t.approach} ${t.key ?? t.id}\` : null` and pass it to `buildSessionSeed`.
- [ ] **Step 4: Run, verify pass** (`seed.test.ts` + `direct-launch.test.ts` still green — direct has no workflow → no invocation).
- [ ] **Step 5: Commit.** `git commit -m "feat: seed /karst:<id> <ticket-key> invocation for workflow approaches"`

### Task 4.5: Operational hooks verification + phase gate

- [ ] **Step 1:** Add/confirm a test in `src/agent/settings.test.ts` that `buildHookSettings` still registers the stage/WT/PR HTTP bridge (SessionStart command + Stop/Notification/etc. http) — the operational layer the generated command runs on top of. No new engine; this only guards the existing channel isn't broken by the launch changes.
- [ ] **Step 2:** `npm test && npm run typecheck` green. Manually note in the PR that end-to-end `/karst:rpi` requires the Claude plugin loader to pick up `commands/karst-<id>.md` under the plugin name (verify in Extension Dev Host with F5). Code-review.

---

## Phase 5 — File-backed agents + single-subagent

**Deps:** P2, P3. **Deliverable:** editable `.karst/agents/*.md`; single-subagent picks an enabled agent that gets materialized at launch.

### Task 5.1: Agent file I/O module

**Files:**
- Create: `src/agents/pkg.ts` (mirrors `src/approaches/pkg.ts` style: path-traversal guards, list/read/write/remove)
- Test: `src/agents/pkg.test.ts`

**Interfaces:**
- Produces:
```ts
export interface AgentFile {
  name: string;          // filename stem, unique id
  description?: string;  // from frontmatter
  body: string;          // full markdown incl. frontmatter (system prompt)
}
export function listAgentFiles(agentsDir: string): AgentFile[];      // *.md, skip malformed
export function readAgentFile(agentsDir: string, name: string): AgentFile | null;
export function writeAgentFile(agentsDir: string, name: string, body: string): void; // sanitizeFrontmatter first
export function removeAgentFile(agentsDir: string, name: string): void; // idempotent
```
Reuse `assertSafeId`/traversal-guard patterns from `approaches/pkg.ts:43-77`. `writeAgentFile` MUST run `sanitizeFrontmatter` (approaches/sanitize.ts) on the body before write.

- [ ] **Step 1: Failing test:** write→list→read round-trip; malformed/`..` name rejected; dangerous frontmatter (`permissionMode: bypassPermissions`) stripped on write; remove is idempotent.
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement** the module.
- [ ] **Step 4: Run, verify pass.**
- [ ] **Step 5: Commit.** `git commit -m "feat: file-backed agent I/O module"`

### Task 5.2: Selectable agent pool (files ∪ approach artifacts, enable-filtered, deduped)

**Files:**
- Create: `src/agents/pool.ts`
- Test: `src/agents/pool.test.ts`

**Interfaces:**
- Consumes: `listAgentFiles`, `listInstalled` (`approaches/pkg.ts:266`) + `listArtifacts`, manifest `approaches` (for `enabled`).
- Produces:
```ts
export interface PoolAgent {
  name: string;
  source: 'file' | 'approach';
  approachId?: string;   // set when source==='approach'
}
export function buildAgentPool(input: {
  agentsDir: string;
  approachesDir: string;
  approaches: ApproachDef[]; // to honor approach.enabled
}): PoolAgent[]; // enabled only; local files win on name collision (dedup)
```
Rules: include every `.karst/agents/*.md`; include `agent`-kind artifacts of installed approaches whose `enabled !== false`; dedup by `name` with `source:'file'` winning; stable sort by name.

- [ ] **Step 1: Failing test:** file + approach-artifact same name → single entry `source:'file'`; disabled approach's agents excluded; ordering stable.
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run, verify pass.**
- [ ] **Step 5: Commit.** `git commit -m "feat: build enabled deduped agent pool"`

### Task 5.3: Ticket `agent` column

**Files:**
- Modify: `src/store/schema.sql`, `src/store/migrations.ts` (add `agent TEXT` nullable), `src/store/tickets.ts` (read/write + `updateTicketOnboarding`)
- Test: `src/store/tickets.test.ts`

**Interfaces:**
- Produces: ticket row gains `agent: string | null`; `updateTicketOnboarding` accepts optional `agent`.

- [ ] **Step 1: Failing test:** persist a ticket with `agent:'reviewer'`, read it back; default null.
- [ ] **Step 2: Run, verify fail** (migration/column absent).
- [ ] **Step 3: Implement** migration (new numbered migration mirroring the `approach` column addition), schema.sql column, tickets read/write mapping.
- [ ] **Step 4: Run, verify pass.**
- [ ] **Step 5: Commit.** `git commit -m "feat: persist per-ticket single-subagent selection"`

### Task 5.4: Onboarding agent dropdown (single-subagent only)

**Files:**
- Modify: `src/ui/onboarding/state.ts` (expose `agents: PoolAgent[]` + `selectedAgent`), `messages.ts` (`set-agent`), `actions.ts` (persist in edit mode / hold in create), `webview.html` (render a `<select>` only when `selectedApproach==='single-subagent'`)
- Test: `src/ui/onboarding/state.test.ts`, `actions.test.ts`

**Interfaces:**
- Consumes: `buildAgentPool`.
- Produces: `OnboardingActions.setAgent(name: string): Promise<void>`; state `agents`, `selectedAgent`.

- [ ] **Step 1: Failing test:** state for a single-subagent ticket includes the enabled pool; `setAgent` persists to the ticket (edit mode); non-single-subagent approaches carry no agent requirement.
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement** state/messages/actions + webview `<select>` gated on the approach, mirroring the approach radio wiring at `webview.html:417-441`.
- [ ] **Step 4: Run, verify pass.**
- [ ] **Step 5: Commit.** `git commit -m "feat: single-subagent agent picker in onboarding"`

### Task 5.5: Materialize chosen agent at launch

**Files:**
- Modify: `src/extension.ts:323-390` (when `t.approach==='single-subagent'` and `t.agent`, resolve the agent body and pass to adapter), `src/agent/claude.ts` (`materializeApproach` or a sibling to inject a single agent file), `src/agent/adapter.ts` (`MaterializeOpts` gains optional `soloAgent?: { name; body }`)
- Test: `src/agent/claude.test.ts`, integration in `src/agent/direct-launch.test.ts` sibling

**Interfaces:**
- Produces: when `soloAgent` is provided, materialize writes `pluginDir/agents/<name>.md` (sanitized) and returns `--plugin-dir`; seed instructs delegation ("Delegate this ticket to the `<name>` subagent.").

- [ ] **Step 1: Failing test:** solo-agent launch writes `agents/<name>.md` and includes `--plugin-dir`; seed contains the delegation instruction.
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement.** Resolve the chosen `PoolAgent` body (file via `readAgentFile`, or approach artifact via `readArtifactBody`) in `extension.ts`; pass `soloAgent` through `MaterializeOpts`; write it in the adapter; add the delegation line to the seed (extend `buildSessionSeed` or compose in extension.ts as an approach-prompt-style block).
- [ ] **Step 4: Run, verify pass.**
- [ ] **Step 5: Commit.** `git commit -m "feat: materialize chosen agent for single-subagent launch"`

### Task 5.6: Phase gate

- [ ] `npm test && npm run typecheck` green. Code-review.

---

## Phase 6 — Settings redesign + enable/disable wiring

**Deps:** P2–P5. **Deliverable:** redesigned Approaches + Agents tabs surfacing commands/enable/edit; onboarding honors `enabled`.

### Task 6.1: Onboarding enable filters

**Files:**
- Modify: `src/ui/onboarding/state.ts:72-77` (`toApproachRows` — also drop `enabled===false`)
- Test: `src/ui/onboarding/state.test.ts`

- [ ] **Step 1: Failing test:** a disabled sourced approach (installed) is NOT offered; a disabled built-in is NOT offered; enabled ones remain.
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement** the `enabled !== false` filter alongside the install filter.
- [ ] **Step 4: Run, verify pass.**
- [ ] **Step 5: Commit.** `git commit -m "feat: hide disabled approaches from create/edit flow"`

### Task 6.2: Settings enable/disable + edit actions

**Files:**
- Modify: `src/ui/settings/messages.ts` (`set-approach-enabled`, `set-agent-enabled`, `save-agent-file`, `create-agent`, `delete-agent`), `actions.ts` (implement via manifest write + `writeAgentFile`/`removeAgentFile`), `state.ts` (expose per-approach `enabled` + installed command names + agent pool + file bodies)
- Test: `src/ui/settings/actions.test.ts`, `state.test.ts`

**Interfaces:**
- Consumes: `buildAgentPool`, `readAgentFile`/`writeAgentFile`/`removeAgentFile`, `listArtifacts` (to list an installed approach's command names incl. the generated `karst-<id>`).
- Produces: `SettingsActions` gains `setApproachEnabled(id, enabled)`, `setAgentEnabled(name, enabled)`, `saveAgentFile(name, body)`, `createAgent(name)`, `deleteAgent(name)`.

- [ ] **Step 1: Failing tests** (one per action): toggling approach `enabled` writes manifest; `saveAgentFile` sanitizes + writes; `deleteAgent` removes; state exposes each installed approach's command list including `karst-<id>` when a workflow exists.
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement** actions + message parse/route (validate every discriminant at the boundary) + state fields.
- [ ] **Step 4: Run, verify pass.**
- [ ] **Step 5: Commit.** `git commit -m "feat: settings actions for enable/disable + agent file editing"`

### Task 6.3: Redesign Approaches + Agents tabs (frontend-design)

**Files:**
- Modify: `src/ui/settings/webview.html` (Approaches + Agents sections)

**Interfaces:** consumes the state fields from 6.2.

- [ ] **Step 1:** Invoke the `frontend-design` skill for aesthetic direction before writing markup.
- [ ] **Step 2:** Approaches tab per row: label, install state, enable toggle, and (when installed) the command list — `/karst:<id>` plus native commands — and Uninstall. Agents tab: list pool agents (file vs approach badge), enable toggle, an editable `<textarea>` for file bodies (file source only) with Save, Add agent, Delete.
- [ ] **Step 3:** Wire the new controls to the 6.2 messages; keep the webview self-contained (inline CSS/JS, `postMessage`).
- [ ] **Step 4:** Manual verify via F5 Extension Dev Host; run `npm test` (webview logic covered by state/actions tests) + `npm run typecheck`.
- [ ] **Step 5: Commit.** `git commit -m "feat: redesign settings approaches + agents tabs"`

### Task 6.4: Final gate

- [ ] `npm test && npm run typecheck` green. Full code-review of the branch. Update `docs/todo-3.md` (or delete) to reflect shipped scope.

---

## Self-Review

- **Spec coverage:** provider select → P2.1/P3; workflow orchestration + generated command → P2.2/P4; enable/disable approaches → P2.2/P6.1/P6.2; file-backed agents + edit → P2.3/P5.1/P6.2/P6.3; single-subagent dropdown → P5; direct approach → unchanged (verified via `direct-launch.test.ts` staying green in P4.4); stdin/prompt bug → P1; settings redesign → P6.3. All covered.
- **Type consistency:** `AgentProvider`, `WorkflowPhase`, `ApproachDef.workflow/enabled`, `AgentDef.enabled/promptPath`, `PoolAgent`, `AgentFile`, `resolveAdapter`, `renderWorkflowCommand`, `buildAgentPool`, `buildSessionSeed(ticket, approachPrompt?, invocation?)` used consistently across tasks.
- **Placeholders:** none — each task names exact files, signatures, test intent, and commits.
