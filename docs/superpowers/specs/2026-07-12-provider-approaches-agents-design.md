# Design: Agent provider, approach orchestration, file-backed agents

**Date:** 2026-07-12
**Source todo:** `docs/todo-3.md`
**Status:** approved for planning

## Goal

Make karst genuinely agent-provider-agnostic and turn approaches into first-class,
orchestrated workflows. Three intertwined capabilities:

1. **Agent provider selection** — user picks the agent provider (Claude Code by
   default; others visible but non-selectable until implemented). Provider
   governs how skills/hooks/commands/agents are materialized.
2. **Approach orchestration** — an installed approach exposes a generated
   `/karst:<id> <ticket-key>` slash command that drives the approach's phases
   (e.g. RPI: describe → research → plan → implement) by invoking the approach's
   native slash commands, on top of karst's operational hooks.
3. **File-backed agents + single-subagent delegation** — karst agents become
   editable markdown files; the `single-subagent` approach lets the user pick one
   installed+enabled agent to delegate a ticket to. Approaches and agents can be
   enabled/disabled without deletion.

## Non-goals (YAGNI)

- No working Codex/other adapter. Only the selection UI, persistence, and the
  registry seam. Codex is shown disabled.
- No new hook engine. Operational processing (stages/WT/PR) rides the existing
  `--settings` HTTP hook channel (`src/agent/settings.ts`).
- No stage-graph sub-phases for RPI. The generated `/karst:<id>` command guides
  phase order in-session; deterministic stage gating stays out of scope.
- No auto-derivation of workflows from README/npx. Workflows are authored in the
  manifest.

## Current state (grounded from research)

- **Approaches** (`src/approaches/`): neutral on-disk packages fetched from git/npm,
  materialized to a Claude `--plugin-dir` by `ClaudeAdapter.materializeApproach`
  (`src/agent/claude.ts:90`). 5 predefined in `karst.example.yml` (rpi,
  superpowers:writing-plans, superpowers:test-driven-development, single-subagent,
  direct). Install from Settings only. No `/karst:<approach>` concept — native
  `commands/*.md` only surface as plugin slash-commands.
- **Seed/launch** (`src/agent/seed.ts`): `buildSessionSeed` embeds ticket
  Prompt + Context brief + Repositories + `# Approach` method text as a positional
  arg (`-- <seed>`), NOT stdin. The `no stdin data received in 3s` error is in
  the HEADLESS path: `defaultSpawn` (`src/agent/claude.ts:38`) leaves `child.stdin`
  an open pipe, never `.end()`-ed; `claude -p` waits on it. Hit via `suggestApproach`.
- **Provider**: none. `ClaudeAdapter` hardcoded at `extension.ts:120` and `:208`.
  `AgentAdapter` seam (`src/agent/adapter.ts:78`) is the intended swap point.
- **Agents**: manifest `AgentDef {role, command?}` (`src/manifest/types.ts:83`) in
  `karst.yml`, Settings>Agents tab. No file, no enable/disable, no dropdown.
- **Enable/disable**: nonexistent. Only binary installed-on-disk for approaches.

## Locked decisions

| Area | Decision |
|---|---|
| `/karst:<approach>` | Generated command file in the materialized plugin; calls native commands |
| Workflow definition | New `workflow` field on `ApproachDef` in the manifest |
| Provider | Settings select + persisted in manifest; Claude-only functional; others disabled |
| Agents | File-backed `.karst/agents/*.md` pool ∪ `agent`-kind artifacts of installed+enabled approaches; replaces yaml `role+command` |
| single-subagent | Per-ticket agent selection → materialize the chosen agent |
| UI | Redesign Approaches + Agents settings tabs (frontend-design skill) |

## Architecture

All logic stays host-agnostic; agent-specifics stay behind `AgentAdapter`. Manifest
stays source of truth. Every new manifest field goes through the full
`types.ts → schema.ts (validate + default) → write.ts overlay` checklist, guarded by
`writeManifest.test.ts` "round-trips every modeled section".

### Provider registry
Replace the hardcoded `new ClaudeAdapter()` (`extension.ts:120`, `:208`) with a
registry keyed by provider id: `{ claude: () => new ClaudeAdapter() }`. Selection
reads `manifest.agentProvider` (default `'claude'`). Unknown/unimplemented provider
falls back to claude with a surfaced warning. Settings renders a select mirroring the
ticketing provider control, with non-`claude` options `disabled`.

### Approach orchestration
- `ApproachDef.workflow?: WorkflowPhase[]`, `WorkflowPhase = { name: string; command?: string; description?: string }`.
- At materialize, `ClaudeAdapter` generates `plugin/commands/karst-<id>.md` — a
  command whose body is the ordered phase guide (describe the ticket, then invoke
  each phase's native `command`). Native fetched `commands/*.md` are bundled into the
  same plugin (already happens). The `/karst:` namespace comes from the plugin name.
- At launch, when the ticket's approach has a workflow, the seed's leading
  instruction becomes `/karst:<id> <ticket-key>` followed by the existing ticket
  context block. Absent a workflow (built-ins, plain approaches) launch is unchanged.
- Operational hooks: verify the existing `--settings` channel (`src/agent/settings.ts`)
  already registers the stage/WT/PR bridge; no new engine.

### File-backed agents
- Agents become markdown files under a base dir (new `karst.agentsDir` setting,
  default `./.karst/agents`), each with frontmatter (name, description, optional
  model/allowedTools) + system-prompt body. New module `src/agents/` mirroring
  `src/approaches/pkg.ts` I/O style (list/read/write/remove, path-traversal guards).
- Selectable pool = `.karst/agents/*.md` ∪ `agent`-kind artifacts across installed +
  enabled approach packages. De-duplicated by name.
- `AgentDef` gains `enabled?: boolean` (default true). The legacy `{role, command}`
  is superseded; migration keeps reading old shape but new authoring is file-based.
- Settings>Agents lists the pool, lets the user open/edit a file body, toggle enable.

### single-subagent
- Ticket gains an `agent TEXT` column (nullable) alongside `approach`.
- When approach is `single-subagent`, onboarding shows a dropdown of enabled agents;
  selection persists to the ticket.
- At launch for `single-subagent`, `ClaudeAdapter` materializes the chosen agent file
  into the plugin's `agents/` and the seed instructs delegation to it.

### Enable/disable
- `enabled?: boolean` (default true) on `ApproachDef` and the agents model.
- `onboarding/state.ts:toApproachRows` and the new agent dropdown filter to enabled.
- Settings tabs expose the toggles.

## Data-flow (approach-driven launch)

```
ticket.approach = 'rpi'
  -> resolveApproachPrompt (method text, back-compat)
  -> readApproachPackage(rpi) incl. workflow
  -> ClaudeAdapter.materializeApproach:
       plugin/commands/karst-rpi.md   (generated from workflow)
       plugin/commands/rpi-*.md       (fetched native)
       plugin/agents|skills/*         (fetched)
     -> extraArgs = ['--plugin-dir', dir]
  -> buildSessionSeed: leading '/karst:rpi <key>' + ticket context
  -> claude --settings ... --plugin-dir ... -- '<seed>'
```

## Testing strategy

- Unit: every new manifest field validated + round-tripped; workflow → generated
  command markdown; provider registry resolution incl. fallback; agents pool
  union/dedup/enable-filter; seed leading-invocation composition; stdin fix asserted
  via a spawn fake that records `stdio`/`stdin.end`.
- Integration: approach-driven launch end-to-end (materialize + seed + args);
  single-subagent launch materializes the chosen agent.
- All under vitest with fakes (no `vscode` at runtime), per project invariants.

## Phase breakdown (each = one subagent, TDD, then code-review)

**P1 — Seed + headless stdin fix** *(deps: none)*
Fix `defaultSpawn` stdin pipe (close/ignore, `stdio: ['ignore','pipe','pipe']` or
`child.stdin.end()`). Confirm full prompt seeded. Regression tests via spawn fake.

**P2 — Manifest foundations** *(deps: none)*
Add `agentProvider`, `ApproachDef.workflow`, `ApproachDef.enabled`, file-backed
agents model + `enabled` to `types.ts` + `schema.ts` (validate + default) +
`write.ts` overlay + round-trip guard. Pure model; no behavior.

**P3 — Provider selection** *(deps: P2)*
Adapter registry; `extension.ts` resolves adapter from `manifest.agentProvider`;
Settings select with non-claude disabled.

**P4 — Approach orchestration engine** *(deps: P1, P2)*
`workflow` → generated `/karst:<id>` command at materialize; bundle native commands;
launch seeds `/karst:<id> <ticket-key>`; verify operational hooks via `--settings`.

**P5 — File-backed agents + single-subagent** *(deps: P2, P3)*
`src/agents/` file I/O; pool union+dedup+enable filter; ticket `agent` column;
onboarding dropdown; launch materializes chosen agent.

**P6 — Settings redesign + enable/disable wiring** *(deps: P2–P5)*
frontend-design Approaches + Agents tabs; per-approach show `/karst:<id>` + native
commands + install state + enable toggle; agents list/edit-file/enable; onboarding
filters wired to `enabled`.

## Risks

- **Manifest churn** (P2) is load-bearing for all downstream — get the round-trip
  guard green before building on it.
- **Generated command format** (P4) depends on Claude plugin command conventions;
  verify the plugin loader picks up `commands/karst-<id>.md` under the plugin name.
- **Agent-name collisions** (P5) between `.karst/agents` and approach artifacts —
  dedup rule must be explicit (local files win).
