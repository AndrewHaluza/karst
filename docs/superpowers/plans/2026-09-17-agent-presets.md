# Agent Presets Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Named bundles of agent core + model (+ optional effort) defined once in `karst.yml`, a global default preset for every ticket, a per-ticket override, and a per-process reference — so every AI process resolves its core and model from the effective preset.

**Architecture:** A new pure `agentPresets.ts` resolver turns `(manifest, ticketPreset, rolePreset)` into the manifest-level defaults `{ provider, model, effort }`. The preset layers *under* the existing ticket and per-process explicit overrides and *over* the legacy `agentProvider`/`defaultModel`/`defaultEffort` fields, so with no presets configured the behavior is byte-identical to today. Every existing resolution call site (`resolveProcessAssignment`, the interactive launch, the dashboard/sidebar display, diagnostics, switch/recovery) is switched from passing `manifest.agentProvider`/`manifest.defaultModel`/`manifest.defaultEffort` to passing the resolved defaults.

**Tech Stack:** TypeScript (ESM, `type:module`, `moduleResolution:Bundler`, `.js` import suffixes), vitest, better-sqlite3 (SQLite), js-yaml, host-agnostic injected seams (no `vscode` in logic modules).

**Spec:** Ticket `UNTITLED-TICKET` — "Add agent presets". Done-when: presets definable in the manifest; a default preset applies to all tickets; a ticket can specify which preset to use; each AI process resolves its agent core and model from the effective preset.

---

## Global Constraints

Binding invariants from `AGENTS.md` / `CLAUDE.md` and `docs/arch/*`; every task implicitly includes them.

- **Host-agnostic:** `src/agent/**`, `src/manifest/**`, `src/store/**`, `src/ui/**` logic must not import `vscode`. `vscode` is only `@types/vscode`. Debug hooks are **injected callbacks**, never global logger imports.
- **ESM:** every relative import needs the `.js` suffix. `noUncheckedIndexedAccess` is on — array/map access needs a guard or `!`.
- **Precedence is most-specific-wins** and must stay centralized in one resolver. Blank/whitespace normalizes to "unset" at every layer.
- **Unknown references at manifest load are REFUSED, never guessed.** Dangling store-level references degrade to "unset".
- **No comments** in new code unless a module/test already carries explanatory comments in that style (the codebase does carry rationale comments; match local style).
- **Tests:** `npx vitest run src/path/to.test.ts` for one file; `npm run test:unit` for the suite; `npm run typecheck` before every commit.
- **UI changes** are judged against `docs/ui/UI-RULES.md` (v3.0). Cite a rule id when a change exists to satisfy one (UI-R35). Webview TS→HTML mirrors are **behavior** — pinned by `webview.test.ts`; both sides must change together.
- **New manifest field checklist** (`docs/arch/manifest-and-settings.md`): `types.ts` + `validateManifest` (validator, defaulted) + `writeManifest` overlay (`write.ts`) or Save silently drops it.
- **New schema column checklist** (`docs/arch/store-and-schema.md`): `schema.sql` + guarded `ALTER` in `migrations.ts` + bump `SCHEMA_VERSION` + update `db.test.ts`.
- **Debug logging:** any catch/major decision point in a workflow path should carry a debug line behind an injected `debug` callback. Do not log prompts, secrets, or repository contents.

---

## File Structure

**Create**
- `src/manifest/validate/agentPresets.ts` — pure validators for the `agentPresets` map, `defaultAgentPreset`, and cross-reference integrity. Mirrors `validate/processAssignments.ts`.
- `src/manifest/validate/agentPresets.test.ts` — unit tests for the above.
- `src/agent/agentPresets.ts` — pure resolver: effective preset name, preset lookup, and the manifest-level defaults.
- `src/agent/agentPresets.test.ts` — unit tests for the resolver.

**Modify (core)**
- `src/manifest/types.ts` — `AgentPreset` interface, `Manifest.agentPresets`, `Manifest.defaultAgentPreset`, `ProcessAssignmentConfig.preset`.
- `src/manifest/schema.ts` — wire the two new validators + the reference assertion into `validateManifest`.
- `src/manifest/validate/processAssignments.ts` — parse `preset`.
- `src/manifest/write.ts` — overlay `agentPresets` and `defaultAgentPreset`.
- `src/manifest/fixtures.ts` — `agentPresets()` builder so suites share one shape.
- `src/agent/processAssignment.ts` — `ProcessTicketOverride.preset`; resolve through `resolveAgentDefaults`.
- `src/store/schema.sql` + `src/store/migrations.ts` — `tickets.agent_preset` (v61).
- `src/store/tickets.ts` — `Ticket.agentPreset`, row mapping, patch, update.

**Modify (wiring)**
- `src/extension.ts` — interactive launch, launch intent, `currentAgentAdapter`, `processFor`, `switchAgentSession`, `sessionProviderFor`, `toRecoveryCandidate`.
- `src/ui/dashboard/state.ts`, `src/ui/dashboard/panel.ts` — display resolution.
- `src/ui/sidebar/state.ts`, `src/ui/sidebar/items.ts` — display resolution.
- `src/diagnostics/collectMetadata.ts` — read-only resolution.
- `src/agent/sessionSwitch.ts` — only if its callers do not already pass resolved defaults (they do; verify).

**Modify (UI)**
- `src/ui/ticketForm/state.ts`, `messages.ts`, `actions.ts`, `webview.html`, `webview.test.ts`.
- `src/ui/settings/sections.ts`, `processAssignmentViews.ts`, `webview.html`, `webview.test.ts`.

**Modify (docs/assets)**
- `docs/arch/agent-cores.md`, `docs/arch/manifest-and-settings.md`, `karst.example.yml`.

---

## Task 1: Manifest `agentPresets` + `defaultAgentPreset` (types, validation, fixture, example)

**Files:**
- Create: `src/manifest/validate/agentPresets.ts`
- Test: `src/manifest/validate/agentPresets.test.ts`
- Modify: `src/manifest/types.ts`
- Modify: `src/manifest/schema.ts`
- Modify: `src/manifest/fixtures.ts`
- Modify: `karst.example.yml`

**Interfaces:**
- Consumes: `AgentProvider`, `ManifestError`, `isObject`-style helpers already used by sibling validators.
- Produces:
  - `types.ts`: `interface AgentPreset { provider: AgentProvider; model: string; effort?: string }`
  - `types.ts`: `Manifest.agentPresets?: Record<string, AgentPreset>`; `Manifest.defaultAgentPreset?: string`
  - `validate/agentPresets.ts`: `validateAgentPresets(raw: unknown): Record<string, AgentPreset> | undefined`
  - `validate/agentPresets.ts`: `validateDefaultAgentPreset(raw: unknown): string | undefined`
  - `validate/agentPresets.ts`: `assertAgentPresetReferences(presets: Record<string, AgentPreset> | undefined, defaultAgentPreset: string | undefined, processes: ProcessAssignmentsConfig | undefined): void`
  - `fixtures.ts`: `agentPresets(over?: Record<string, AgentPreset>): Record<string, AgentPreset>`

- [ ] **Step 1: Write the failing validator test**

Create `src/manifest/validate/agentPresets.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  validateAgentPresets,
  validateDefaultAgentPreset,
  assertAgentPresetReferences,
} from './agentPresets.js';
import { ManifestError } from '../error.js';

describe('validateAgentPresets', () => {
  it('returns undefined when absent', () => {
    expect(validateAgentPresets(undefined)).toBeUndefined();
  });

  it('parses a valid map', () => {
    expect(
      validateAgentPresets({
        fast: { provider: 'opencode', model: 'opencode-go/deepseek-v4-flash' },
        deep: { provider: 'claude', model: 'claude-opus-5', effort: 'high' },
      }),
    ).toEqual({
      fast: { provider: 'opencode', model: 'opencode-go/deepseek-v4-flash' },
      deep: { provider: 'claude', model: 'claude-opus-5', effort: 'high' },
    });
  });

  it('refuses a non-mapping', () => {
    expect(() => validateAgentPresets([])).toThrow(ManifestError);
  });

  it('refuses an unknown provider', () => {
    expect(() => validateAgentPresets({ fast: { provider: 'gpt', model: 'x' } })).toThrow(
      /agentPresets\.fast\.provider must be one of/,
    );
  });

  it('refuses a missing model', () => {
    expect(() => validateAgentPresets({ fast: { provider: 'claude' } })).toThrow(
      /agentPresets\.fast\.model must be a non-empty string/,
    );
  });

  it('refuses a malformed model id', () => {
    expect(() => validateAgentPresets({ fast: { provider: 'claude', model: 'has space' } })).toThrow(
      /agentPresets\.fast\.model is not a valid model id/,
    );
  });

  it('refuses an unknown key', () => {
    expect(() =>
      validateAgentPresets({ fast: { provider: 'claude', model: 'm', role: 'research' } }),
    ).toThrow(/agentPresets\.fast has unknown key "role"/);
  });

  it('caps the number of presets', () => {
    const many: Record<string, unknown> = {};
    for (let i = 0; i < 51; i++) many[`p${i}`] = { provider: 'claude', model: 'm' };
    expect(() => validateAgentPresets(many)).toThrow(/at most 50/);
  });
});

describe('validateDefaultAgentPreset', () => {
  it('blank normalizes to undefined', () => {
    expect(validateDefaultAgentPreset('  ')).toBeUndefined();
  });
  it('refuses a non-string', () => {
    expect(() => validateDefaultAgentPreset(1)).toThrow(/defaultAgentPreset must be a string/);
  });
  it('keeps a name verbatim', () => {
    expect(validateDefaultAgentPreset('fast')).toBe('fast');
  });
});

describe('assertAgentPresetReferences', () => {
  const presets = { fast: { provider: 'opencode' as const, model: 'm' } };

  it('accepts an unset default and no process preset', () => {
    expect(() => assertAgentPresetReferences(presets, undefined, undefined)).not.toThrow();
  });

  it('accepts a default that names a preset', () => {
    expect(() => assertAgentPresetReferences(presets, 'fast', undefined)).not.toThrow();
  });

  it('refuses a default that names nothing', () => {
    expect(() => assertAgentPresetReferences(presets, 'nope', undefined)).toThrow(
      /defaultAgentPreset "nope" names no agent preset/,
    );
  });

  it('accepts a process preset that names a preset', () => {
    expect(() =>
      assertAgentPresetReferences(presets, undefined, { review: { preset: 'fast' } }),
    ).not.toThrow();
  });

  it('refuses a process preset that names nothing', () => {
    expect(() =>
      assertAgentPresetReferences(presets, undefined, { review: { preset: 'nope' } }),
    ).toThrow(/processes\.review\.preset "nope" names no agent preset/);
  });

  it('refuses any reference when no presets are defined', () => {
    expect(() => assertAgentPresetReferences(undefined, 'fast', undefined)).toThrow(
      /defaultAgentPreset "fast" names no agent preset/,
    );
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/manifest/validate/agentPresets.test.ts`
Expected: FAIL — `Failed to resolve import "./agentPresets.js"`.

- [ ] **Step 3: Add the `AgentPreset` type and the two Manifest fields**

In `src/manifest/types.ts`, add near `GraphProfileConfig` (line ~196):

```ts
/**
 * A named bundle of agent core + model (+ optional effort) that a ticket, a
 * process role, or the manifest default may reference. Deliberately the same
 * {provider, model, effort?} shape as `GraphProfileConfig`, but global: the
 * graph profiles stay nested per-approach and are out of scope.
 */
export interface AgentPreset {
  provider: AgentProvider;
  model: string;
  effort?: string;
}
```

In the `Manifest` interface, after `defaultEffort` (line ~655):

```ts
  /**
   * Named agent core + model bundles (§ agent presets). A ticket's
   * `agentPreset`, a process role's `preset`, or `defaultAgentPreset` may
   * reference one by name. A preset supplies the manifest-level defaults; the
   * existing per-ticket and per-process explicit fields still win over it.
   * Absent → no presets, and resolution is byte-identical to the legacy
   * agentProvider/defaultModel/defaultEffort behavior.
   */
  agentPresets?: Record<string, AgentPreset>;
  /**
   * Preset applied to every ticket that names none of its own. Must reference
   * a key of `agentPresets` — an unknown name is refused at load, never
   * silently ignored. Blank normalizes to undefined (no default preset).
   */
  defaultAgentPreset?: string;
```

- [ ] **Step 4: Write the validators**

Create `src/manifest/validate/agentPresets.ts`:

```ts
/**
 * Validate the top-level `agentPresets:` map and `defaultAgentPreset:` name,
 * and assert that every manifest-level reference names a defined preset.
 *
 * Mirrors `validate/processAssignments.ts`: every absent field is defaulted,
 * every unknown key is refused with the field named, and reference integrity is
 * checked for values this pure loader can see. The ticket-level preset is store
 * data and is NOT checked here — a dangling ticket reference degrades to "no
 * preset" at resolution, and the ticket form surfaces it.
 */

import { ManifestError } from '../error.js';
import type {
  AgentPreset,
  AgentProvider,
  ProcessAssignmentsConfig,
} from '../types.js';

const AGENT_PROVIDERS: readonly AgentProvider[] = ['claude', 'codex', 'antigravity', 'opencode'];

/** Model id bound — mirrors the graph profile model grammar. */
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/~-]{0,127}$/;

/** A typo must not turn one method into an unbounded config block. */
const MAX_AGENT_PRESETS = 50;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function requireString(v: unknown, where: string): string {
  if (typeof v !== 'string' || v.trim() === '' || v.length > 512) {
    throw new ManifestError(`${where} must be a non-empty string of at most 512 characters`);
  }
  return v;
}

function assertKnownKeys(raw: Record<string, unknown>, known: readonly string[], where: string): void {
  for (const key of Object.keys(raw)) {
    if (!(known as readonly string[]).includes(key)) {
      throw new ManifestError(`${where} has unknown key "${key}"`);
    }
  }
}

function validatePreset(raw: unknown, where: string): AgentPreset {
  if (!isObject(raw)) throw new ManifestError(`${where} must be a mapping`);
  assertKnownKeys(raw, ['provider', 'model', 'effort'], where);

  const provider = requireString(raw.provider, `${where}.provider`);
  if (!(AGENT_PROVIDERS as readonly string[]).includes(provider)) {
    throw new ManifestError(`${where}.provider must be one of: ${AGENT_PROVIDERS.join(', ')}`);
  }
  const model = requireString(raw.model, `${where}.model`);
  if (!MODEL_ID.test(model)) {
    throw new ManifestError(`${where}.model is not a valid model id`);
  }
  const preset: AgentPreset = { provider: provider as AgentProvider, model };
  if (raw.effort !== undefined) preset.effort = requireString(raw.effort, `${where}.effort`);
  return preset;
}

export function validateAgentPresets(raw: unknown): Record<string, AgentPreset> | undefined {
  if (raw === undefined) return undefined;
  if (!isObject(raw)) throw new ManifestError('agentPresets must be a mapping');
  const keys = Object.keys(raw);
  if (keys.length > MAX_AGENT_PRESETS) {
    throw new ManifestError(`agentPresets accepts at most ${MAX_AGENT_PRESETS} presets`);
  }
  const presets: Record<string, AgentPreset> = {};
  for (const [name, value] of Object.entries(raw)) {
    if (name.trim() === '') throw new ManifestError('agentPresets has an empty preset name');
    presets[name] = validatePreset(value, `agentPresets.${name}`);
  }
  return presets;
}

export function validateDefaultAgentPreset(raw: unknown): string | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string') throw new ManifestError('defaultAgentPreset must be a string');
  return raw.trim() === '' ? undefined : raw;
}

/**
 * Every manifest-level preset reference must resolve. A dangling
 * `defaultAgentPreset` or `processes.<key>.preset` would otherwise silently do
 * nothing, which reads as "the preset was ignored".
 */
export function assertAgentPresetReferences(
  presets: Record<string, AgentPreset> | undefined,
  defaultAgentPreset: string | undefined,
  processes: ProcessAssignmentsConfig | undefined,
): void {
  const defined = presets ?? {};
  if (defaultAgentPreset !== undefined && !(defaultAgentPreset in defined)) {
    throw new ManifestError(
      `defaultAgentPreset "${defaultAgentPreset}" names no agent preset — ` +
        'define it under agentPresets or remove the field',
    );
  }
  for (const [key, cfg] of Object.entries(processes ?? {})) {
    const name = cfg.preset;
    if (name !== undefined && !(name in defined)) {
      throw new ManifestError(
        `processes.${key}.preset "${name}" names no agent preset — ` +
          'define it under agentPresets or remove the field',
      );
    }
  }
}
```

- [ ] **Step 5: Wire the validators into `validateManifest`**

In `src/manifest/schema.ts`, add to the imports:

```ts
import {
  validateAgentPresets,
  validateDefaultAgentPreset,
  assertAgentPresetReferences,
} from './validate/agentPresets.js';
```

In `validateManifest`, after `const processes = validateProcessAssignments(raw.processes);` (line 583):

```ts
  const agentPresets = validateAgentPresets(raw.agentPresets);
  const defaultAgentPreset = validateDefaultAgentPreset(raw.defaultAgentPreset);
  assertAgentPresetReferences(agentPresets, defaultAgentPreset, processes);
```

Add to the returned object literal (near `defaultEffort`):

```ts
    agentPresets,
    defaultAgentPreset,
```

- [ ] **Step 6: Add the shared fixture**

In `src/manifest/fixtures.ts`, add `AgentPreset` to the type import and add:

```ts
/** An agentPresets block; one entry so a reference test has something to name. */
export function agentPresets(
  over: Record<string, AgentPreset> = {},
): Record<string, AgentPreset> {
  return {
    fast: { provider: 'opencode', model: 'opencode-go/deepseek-v4-flash' },
    ...over,
  };
}
```

- [ ] **Step 7: Document the block in `karst.example.yml`**

After the `defaultModel:` line (line ~44), add:

```yaml
# Named agent core + model bundles. A ticket, a process role, or
# `defaultAgentPreset` can reference one by name. Reference a preset in
# `defaultAgentPreset` below, per process under `processes:`, or per ticket.
# agentPresets:
#   fast:
#     provider: opencode
#     model: opencode-go/deepseek-v4-flash
#   deep:
#     provider: claude
#     model: claude-opus-5
#     effort: high
# defaultAgentPreset: fast
```

- [ ] **Step 8: Run the tests and typecheck**

Run: `npx vitest run src/manifest/validate/agentPresets.test.ts src/manifest/example.test.ts src/manifest/types.test.ts`
Expected: PASS.
Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 9: Commit**

```bash
git add src/manifest/types.ts src/manifest/schema.ts src/manifest/validate/agentPresets.ts src/manifest/validate/agentPresets.test.ts src/manifest/fixtures.ts karst.example.yml
git commit -m "feat(manifest): add agentPresets and defaultAgentPreset"
```

---

## Task 2: `processes.<key>.preset` + write overlay + round-trip

**Files:**
- Modify: `src/manifest/validate/processAssignments.ts`
- Modify: `src/manifest/validate/processAssignments.test.ts`
- Modify: `src/manifest/write.ts`
- Modify: `src/manifest/writeManifest.test.ts`
- Modify: `src/manifest/load.test.ts`

**Interfaces:**
- Consumes: `validateAgentPresets`, `validateDefaultAgentPreset`, `assertAgentPresetReferences` (Task 1).
- Produces: `ProcessAssignmentConfig.preset?: string`; `writeManifest` round-trips `agentPresets` and `defaultAgentPreset`.

- [ ] **Step 1: Write the failing validation test**

Append to `src/manifest/validate/processAssignments.test.ts`:

```ts
it('parses a preset reference and blank-normalizes it away', () => {
  expect(validateProcessAssignments({ review: { preset: 'fast' } })).toEqual({
    review: { enabled: true, preset: 'fast' },
  });
  expect(validateProcessAssignments({ review: { preset: '  ' } })).toEqual({
    review: { enabled: true },
  });
});

it('refuses a non-string preset', () => {
  expect(() => validateProcessAssignments({ review: { preset: 1 } })).toThrow(
    /processes\.review\.preset must be a string/,
  );
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/manifest/validate/processAssignments.test.ts`
Expected: FAIL — `preset` is not parsed (`toEqual` mismatch).

- [ ] **Step 3: Parse `preset`**

In `src/manifest/validate/processAssignments.ts`, inside `validateProcessAssignment`, after the `effort` block (line ~130):

```ts
  // The per-process preset reference. Reference integrity is checked once the
  // whole manifest (presets + processes) is known — see
  // `assertAgentPresetReferences` in validate/agentPresets.ts.
  const preset = optionalString(raw.preset, `${where}.preset`);
  if (preset !== undefined) config.preset = preset;
```

- [ ] **Step 4: Add the write overlay**

In `src/manifest/write.ts`, in the `next` object after `agentProvider:` (line 189):

```ts
    // Agent presets: written when set, dropped (undefined → omitted by the
    // dumper) when cleared. Without this line Save silently drops the whole
    // block — the failure mode the round-trip test exists to catch.
    agentPresets: manifest.agentPresets,
    defaultAgentPreset: manifest.defaultAgentPreset,
```

- [ ] **Step 5: Pin the round-trip**

In `src/manifest/writeManifest.test.ts`, add `agentPresets`/`defaultAgentPreset` to the full fixture object used by "round-trips every modeled section without dropping fields" (the `full` manifest literal, ~line 158–323):

```ts
    agentPresets: { fast: { provider: 'opencode', model: 'opencode-go/deepseek-v4-flash' } },
    defaultAgentPreset: 'fast',
```

Add a dedicated case next to the processes case (~line 649):

```ts
it('round-trips agentPresets and defaultAgentPreset', () => {
  const path = join(dir, 'karst.yml');
  writeFileSync(path, 'host: localhost\nportRange: [4000, 4999]\nbaselineBranch: develop\nrepositories:\n  extention:\n    repoPath: /repo\n    hasMigrations: false\n');
  writeManifest(path, validateManifest({
    host: 'localhost',
    portRange: [4000, 4999],
    baselineBranch: 'develop',
    repositories: { extention: { repoPath: '/repo', hasMigrations: false } },
    agentPresets: { fast: { provider: 'opencode', model: 'opencode-go/deepseek-v4-flash' } },
    defaultAgentPreset: 'fast',
    processes: { review: { preset: 'fast' } },
  }));
  const reloaded = loadManifest(path);
  expect(reloaded.agentPresets).toEqual({
    fast: { provider: 'opencode', model: 'opencode-go/deepseek-v4-flash' },
  });
  expect(reloaded.defaultAgentPreset).toBe('fast');
  expect(reloaded.processes?.review?.preset).toBe('fast');
});

it('drops a cleared defaultAgentPreset on save', () => {
  const path = join(dir, 'karst.yml');
  writeFileSync(path, 'host: localhost\nportRange: [4000, 4999]\nbaselineBranch: develop\nagentPresets:\n  fast:\n    provider: opencode\n    model: m\ndefaultAgentPreset: fast\nrepositories:\n  extention:\n    repoPath: /repo\n    hasMigrations: false\n');
  const current = loadManifest(path);
  writeManifest(path, validateManifest({ ...current, defaultAgentPreset: undefined }));
  expect(loadManifest(path).defaultAgentPreset).toBeUndefined();
});
```

- [ ] **Step 6: Add the load-level integrity test**

Append to `src/manifest/load.test.ts`:

```ts
it('refuses a defaultAgentPreset that names nothing', () => {
  const path = writeTemp(`
host: localhost
portRange: [4000, 4999]
baselineBranch: develop
defaultAgentPreset: nope
repositories:
  extention:
    repoPath: /repo
    hasMigrations: false
`);
  expect(() => loadManifest(path)).toThrow(/defaultAgentPreset "nope" names no agent preset/);
});

it('accepts a defaultAgentPreset that names a defined preset', () => {
  const path = writeTemp(`
host: localhost
portRange: [4000, 4999]
baselineBranch: develop
agentPresets:
  fast:
    provider: opencode
    model: opencode-go/deepseek-v4-flash
defaultAgentPreset: fast
repositories:
  extention:
    repoPath: /repo
    hasMigrations: false
`);
  expect(loadManifest(path).defaultAgentPreset).toBe('fast');
});
```

Use the existing temp-writer helper already in `load.test.ts` (search for the file's current helper name; if it writes via `writeFileSync`, mirror it). If no helper exists, inline `writeFileSync(path, ...)` with `mkdtempSync`.

- [ ] **Step 7: Run tests**

Run: `npx vitest run src/manifest/validate/processAssignments.test.ts src/manifest/writeManifest.test.ts src/manifest/load.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/manifest/validate/processAssignments.ts src/manifest/validate/processAssignments.test.ts src/manifest/write.ts src/manifest/writeManifest.test.ts src/manifest/load.test.ts
git commit -m "feat(manifest): support processes.<key>.preset and persist agentPresets"
```

---

## Task 3: Store `tickets.agent_preset` (schema v61)

**Files:**
- Modify: `src/store/schema.sql`
- Modify: `src/store/migrations.ts`
- Modify: `src/store/tickets.ts`
- Test: `src/store/db.test.ts`, `src/store/tickets.test.ts`

**Interfaces:**
- Consumes: the new-column checklist (`docs/arch/store-and-schema.md`).
- Produces: `Ticket.agentPreset: string | null`; `TicketFieldsPatch.agentPreset?: string`; `updateTicketFields` maps `''` → `NULL`.

- [ ] **Step 1: Write the failing store test**

Append to `src/store/tickets.test.ts`:

```ts
it('persists and clears a per-ticket agent preset', () => {
  const store = openStore(':memory:');
  const t = createTicket(store, { key: 'A-1', title: 'T' });
  updateTicketFields(store, t.id, { agentPreset: 'fast' });
  expect(getTicket(store, t.id)?.agentPreset).toBe('fast');
  updateTicketFields(store, t.id, { agentPreset: '' });
  expect(getTicket(store, t.id)?.agentPreset).toBeNull();
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/store/tickets.test.ts`
Expected: FAIL — `agentPreset` is `undefined` (property does not exist on `Ticket`).

- [ ] **Step 3: Add the column to `schema.sql`**

In `src/store/schema.sql`, after the `agent_provider` comment/line (lines 41–42):

```sql
  -- v61 agent preset column (kept in sync with migrations.ts v61 ALTER):
  agent_preset      TEXT,                 -- per-ticket agent preset name; NULL = inherit defaultAgentPreset
```

- [ ] **Step 4: Add the guarded migration and bump the version**

In `src/store/migrations.ts`, change `export const SCHEMA_VERSION = 60;` to `61`, and add before the final `db.pragma(...)`:

```ts
  if (current < 61) {
    // v61: `tickets.agent_preset` — the per-ticket agent-preset override. NULL
    // is the honest "inherit manifest.defaultAgentPreset" for every pre-v61
    // row: there was no preset concept to backfill. The guard reads the CURRENT
    // columns, so a fresh DB (schema.sql already carries it) is a no-op and a
    // re-open is idempotent.
    const cols61 = ticketColumns(db);
    if (cols61.has('model') && !cols61.has('agent_preset')) {
      db.exec('ALTER TABLE tickets ADD COLUMN agent_preset TEXT');
    }
  }
```

- [ ] **Step 5: Add the Ticket type + row mapping + patch**

In `src/store/tickets.ts`, after `agentProvider` in `Ticket` (line ~52):

```ts
  /** Per-ticket agent-preset override; `null` = inherit `manifest.defaultAgentPreset`. */
  agentPreset: string | null;
```

Add `agent_preset: string | null;` to `TicketRow` (after `agent_provider`), and in `rowToTicket` after `agentProvider`:

```ts
    agentPreset: r.agent_preset,
```

Add to `TicketFieldsPatch` (after `agentProvider`):

```ts
  /** Per-ticket agent-preset name; empty string clears it back to inherit. */
  agentPreset?: string;
```

In `updateTicketFields`, after the `agentProvider` block (line ~478):

```ts
  if (patch.agentPreset !== undefined) {
    columns.agent_preset = patch.agentPreset === '' ? null : patch.agentPreset;
  }
```

- [ ] **Step 6: Update `db.test.ts`**

Change every `expect(... user_version ...).toBe(60)` to `.toBe(61)` (lines 181, 206, 212, 248, 283, 312, 351, 363, 364). If `db.test.ts` also asserts a `tickets` column set, add `agent_preset` there.

- [ ] **Step 7: Run tests**

Run: `npx vitest run src/store/tickets.test.ts src/store/db.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/store/schema.sql src/store/migrations.ts src/store/tickets.ts src/store/tickets.test.ts src/store/db.test.ts
git commit -m "feat(store): add tickets.agent_preset (schema v61)"
```

---

## Task 4: Pure resolver `src/agent/agentPresets.ts`

**Files:**
- Create: `src/agent/agentPresets.ts`
- Test: `src/agent/agentPresets.test.ts`

**Interfaces:**
- Consumes: `Manifest`, `AgentPreset`, `AgentProvider`; `manifest()` fixture (Task 1).
- Produces:
  - `effectiveAgentPresetName(manifest, ticketPreset?, rolePreset?): string | undefined`
  - `resolveAgentPreset(manifest, name?): AgentPreset | undefined`
  - `resolveAgentDefaults(manifest, ticketPreset?, rolePreset?): AgentDefaults`
  - `interface AgentDefaults { provider: AgentProvider; model?: string; effort?: string }`

- [ ] **Step 1: Write the failing test**

Create `src/agent/agentPresets.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  effectiveAgentPresetName,
  resolveAgentPreset,
  resolveAgentDefaults,
} from './agentPresets.js';
import { manifest, repo } from '../manifest/fixtures.js';
import type { Manifest } from '../manifest/types.js';

function m(over: Partial<Manifest> = {}): Manifest {
  return manifest({ extention: repo() }, {
    agentPresets: {
      fast: { provider: 'opencode', model: 'opencode-go/deepseek-v4-flash' },
      deep: { provider: 'claude', model: 'claude-opus-5', effort: 'high' },
    },
    defaultAgentPreset: 'fast',
    agentProvider: 'codex',
    defaultModel: 'gpt-5.6-sol',
    defaultEffort: 'low',
    ...over,
  });
}

describe('effectiveAgentPresetName', () => {
  it('prefers the role preset, then the ticket preset, then the default', () => {
    expect(effectiveAgentPresetName(m(), 'deep', 'fast')).toBe('fast');
    expect(effectiveAgentPresetName(m(), 'deep', undefined)).toBe('deep');
    expect(effectiveAgentPresetName(m(), null, null)).toBe('fast');
  });
  it('blank values are unset', () => {
    expect(effectiveAgentPresetName(m({ defaultAgentPreset: undefined }), '  ', '')).toBeUndefined();
  });
});

describe('resolveAgentPreset', () => {
  it('returns the named preset', () => {
    expect(resolveAgentPreset(m(), 'deep')).toEqual({
      provider: 'claude',
      model: 'claude-opus-5',
      effort: 'high',
    });
  });
  it('degrades a dangling name to undefined', () => {
    expect(resolveAgentPreset(m(), 'nope')).toBeUndefined();
  });
});

describe('resolveAgentDefaults', () => {
  it('a preset overrides the legacy manifest defaults', () => {
    expect(resolveAgentDefaults(m(), null)).toEqual({
      provider: 'opencode',
      model: 'opencode-go/deepseek-v4-flash',
      effort: 'low',
    });
  });
  it('no presets defined falls back to the legacy fields', () => {
    expect(
      resolveAgentDefaults(m({ agentPresets: undefined, defaultAgentPreset: undefined }), null),
    ).toEqual({ provider: 'codex', model: 'gpt-5.6-sol', effort: 'low' });
  });
  it('a dangling ticket preset falls back to the legacy fields', () => {
    expect(resolveAgentDefaults(m(), 'nope')).toEqual({
      provider: 'codex',
      model: 'gpt-5.6-sol',
      effort: 'low',
    });
  });
  it('provider always resolves', () => {
    expect(
      resolveAgentDefaults(m({ agentPresets: undefined, defaultAgentPreset: undefined, agentProvider: undefined }), null)
        .provider,
    ).toBe('claude');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/agent/agentPresets.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the resolver**

Create `src/agent/agentPresets.ts`:

```ts
/**
 * Agent presets: named {provider, model, effort?} bundles (§ agent presets).
 *
 * These functions are the ONE precedence rule for the preset LAYER. They return
 * the manifest-level defaults a caller feeds into the existing
 * `resolveProvider`/`resolveModelForProvider`/`resolveEffortForProvider` calls,
 * so the per-process and per-ticket explicit fields keep winning exactly as
 * they do today. With no presets configured and no `defaultAgentPreset`, the
 * returned defaults are byte-identical to `manifest.agentProvider` /
 * `manifest.defaultModel` / `manifest.defaultEffort`.
 *
 * vscode-free and catalog-free: compatibility (a preset model that the resolved
 * provider cannot run) is judged by the existing provider-compatibility check
 * at the call site, not here.
 */

import type { AgentPreset, AgentProvider, Manifest } from '../manifest/types.js';

export type { AgentPreset } from '../manifest/types.js';

export interface AgentDefaults {
  provider: AgentProvider;
  model?: string;
  effort?: string;
}

function firstNonBlank(...vals: (string | null | undefined)[]): string | undefined {
  for (const v of vals) {
    if (typeof v === 'string' && v.trim() !== '') return v;
  }
  return undefined;
}

/**
 * The preset name that applies, most specific first: a process role's own
 * `processes.<key>.preset`, then the ticket's `agentPreset`, then the manifest
 * `defaultAgentPreset`. Blank values are "unset" at every layer.
 */
export function effectiveAgentPresetName(
  manifest: Manifest,
  ticketPreset?: string | null,
  rolePreset?: string | null,
): string | undefined {
  return firstNonBlank(rolePreset, ticketPreset, manifest.defaultAgentPreset);
}

/** The named preset, or undefined for an unset/dangling name. Never throws. */
export function resolveAgentPreset(
  manifest: Manifest,
  name?: string | null,
): AgentPreset | undefined {
  const key = firstNonBlank(name);
  if (key === undefined) return undefined;
  return manifest.agentPresets?.[key];
}

/** The manifest-level defaults, with the effective preset overlaid on the legacy fields. */
export function resolveAgentDefaults(
  manifest: Manifest,
  ticketPreset?: string | null,
  rolePreset?: string | null,
): AgentDefaults {
  const preset = resolveAgentPreset(
    manifest,
    effectiveAgentPresetName(manifest, ticketPreset, rolePreset),
  );
  return {
    provider: preset?.provider ?? manifest.agentProvider ?? 'claude',
    model: preset?.model ?? manifest.defaultModel,
    effort: preset?.effort ?? manifest.defaultEffort,
  };
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/agent/agentPresets.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/agent/agentPresets.ts src/agent/agentPresets.test.ts
git commit -m "feat(agent): add the agent-preset resolver"
```

---

## Task 5: Resolve presets in `resolveProcessAssignment`

**Files:**
- Modify: `src/agent/processAssignment.ts`
- Modify: `src/agent/processAssignment.test.ts`

**Interfaces:**
- Consumes: `resolveAgentDefaults` (Task 4).
- Produces: `ProcessTicketOverride.preset?: string | null`; every process role's provider/model/effort resolved with the effective preset layered in.

- [ ] **Step 1: Write the failing test**

Append to `src/agent/processAssignment.test.ts`:

```ts
it('a process preset supplies the defaults and explicit fields still win', () => {
  const manifest = m({
    agentPresets: {
      fast: { provider: 'opencode', model: 'opencode-go/deepseek-v4-flash' },
    },
    processes: { review: { preset: 'fast', model: 'opencode-go/mimo-v2.5' } },
  });
  const snap = resolveProcessAssignment(manifest, 'review', {});
  expect(snap?.provider).toBe('opencode');
  expect(snap?.model).toBe('opencode-go/mimo-v2.5');
});

it('a ticket preset applies to every process role when the role names none', () => {
  const manifest = m({
    agentPresets: { deep: { provider: 'claude', model: 'claude-opus-5' } },
    processes: { review: {} },
  });
  const snap = resolveProcessAssignment(manifest, 'review', { preset: 'deep' });
  expect(snap?.provider).toBe('claude');
  expect(snap?.model).toBe('claude-opus-5');
});

it('the process preset beats the ticket preset', () => {
  const manifest = m({
    agentPresets: {
      fast: { provider: 'opencode', model: 'opencode-go/deepseek-v4-flash' },
      deep: { provider: 'claude', model: 'claude-opus-5' },
    },
    processes: { review: { preset: 'fast' } },
  });
  const snap = resolveProcessAssignment(manifest, 'review', { preset: 'deep' });
  expect(snap?.provider).toBe('opencode');
});

it('a ticket preset does not override an explicit ticket provider/model', () => {
  const manifest = m({
    agentPresets: { deep: { provider: 'claude', model: 'claude-opus-5' } },
  });
  const snap = resolveProcessAssignment(manifest, 'review', {
    preset: 'deep',
    provider: 'codex',
    model: 'gpt-5.6-sol',
  });
  expect(snap?.provider).toBe('codex');
  expect(snap?.model).toBe('gpt-5.6-sol');
});
```

Use the file's existing `m(...)` manifest helper; if it is named differently, rename consistently in the snippets. If the file has no helper, build from `manifest()`/`repo()`/`processes()` in `src/manifest/fixtures.ts`.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/agent/processAssignment.test.ts`
Expected: FAIL — the preset has no effect (provider/model come from the manifest legacy fields).

- [ ] **Step 3: Layer the preset in**

In `src/agent/processAssignment.ts`, add the import:

```ts
import { resolveAgentDefaults } from './agentPresets.js';
```

Add to `ProcessTicketOverride` (line ~86):

```ts
  /** Per-ticket agent-preset name; the process's own `preset` wins over it. */
  preset?: string | null;
```

Update the module docstring's precedence block to list the preset layer between the ticket override and the manifest defaults.

Replace the provider/model/effort computation (lines 128–148) with:

```ts
  // The preset LAYER: `processes.<key>.preset` beats the ticket preset beats
  // `manifest.defaultAgentPreset`. It supplies the manifest-level defaults;
  // every explicit field above still wins, so a preset never silently replaces
  // an operator's pick.
  const defaults = resolveAgentDefaults(manifest, ticketOverride.preset, config?.preset);

  const provider =
    config?.provider ?? resolveProvider(ticketOverride.provider ?? null, defaults.provider);

  const model =
    config?.model ??
    resolveModelForProvider(provider, ticketOverride.model ?? null, defaults.model, catalog);

  const effort = resolveEffortForProvider(
    provider,
    config?.effort ?? ticketOverride.effort ?? null,
    defaults.effort,
    model,
    catalog,
  );
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/agent/processAssignment.test.ts src/agent/models.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/agent/processAssignment.ts src/agent/processAssignment.test.ts
git commit -m "feat(agent): resolve process assignments through the effective preset"
```

---

## Task 6: Interactive launch + launch intent + `currentAgentAdapter`

**Files:**
- Modify: `src/extension.ts`
- Test: `src/extensionActivation.test.ts` or the nearest existing launch-mode test that constructs the resolution helpers (search for `resolveModelForProvider` call assertions first; if the launch block is only covered e2e, add the assertion to the unit test that already pins `openSession`'s resolved identity).

**Interfaces:**
- Consumes: `resolveAgentDefaults` (Task 4), `Ticket.agentPreset` (Task 3).
- Produces: the interactive session launch resolves provider/model/effort with the ticket's preset layered in; the launch intent and adapter selection agree with it.

- [ ] **Step 1: Write the failing test**

Find the existing unit test that pins `karst.openSession`'s resolved identity (grep `src/extension*.test.ts` for `resolveModelForProvider` or the launch-intent `recordSessionLaunchIntent`). Add a case that builds a ticket whose `agentPreset` names a manifest preset and asserts the recorded launch identity uses the preset's provider/model. If no such unit seam exists, this task is covered by Task 7's `dashboard/state.ts` unit test and the change is verified by `npm run typecheck` + `npm run test:e2e`; state that explicitly in the commit and skip this step.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run <the test file from Step 1>`
Expected: FAIL — the launch uses the manifest legacy defaults, not the preset.

- [ ] **Step 3: Add the import**

In `src/extension.ts`, add beside the other `agent/*` imports:

```ts
import { resolveAgentDefaults } from './agent/agentPresets.js';
```

- [ ] **Step 4: Resolve the launch identity through the preset**

In `karst.openSession` (the block at lines ~6057–6211), read the ticket's preset once and use it for provider/model/effort. Replace:

```ts
  const launchProvider = options.assignment?.provider
    ?? resolveProvider(t.agentProvider, currentManifest()?.agentProvider);
```

with:

```ts
  const launchManifest = currentManifest();
  const launchDefaults = resolveAgentDefaults(launchManifest, t.agentPreset);
  const launchProvider = options.assignment?.provider
    ?? resolveProvider(t.agentProvider, launchDefaults.provider);
```

Replace the model expression (line ~6190) so its manifest-level argument is `launchDefaults.model`:

```ts
  const model = options.assignment?.model
    ?? resolveModelForProvider(launchProvider, t.model, launchDefaults.model, modelCatalog);
```

Replace the effort expression (line ~6203) so its manifest-level argument is `launchDefaults.effort`:

```ts
  const effort = options.assignment?.effort
    ?? resolveEffortForProvider(launchProvider, t.effort, launchDefaults.effort, model, modelCatalog);
```

(Keep the surrounding variable names and call shapes exactly as they are; only the manifest-level argument changes.)

- [ ] **Step 5: Resolve the launch-intent callback through the preset**

In the launch-intent block (lines ~980–1047), after `const ticket = getTicket(...)`, compute:

```ts
    const intentDefaults = resolveAgentDefaults(currentManifest(), ticket.agentPreset);
```

Replace `resolveProvider(ticket.agentProvider, manifest.agentProvider)` with `resolveProvider(ticket.agentProvider, intentDefaults.provider)` and replace the `resolveModelForProvider(provider, ticket.model, manifest.defaultModel, modelCatalog)` manifest-level argument with `intentDefaults.model`.

- [ ] **Step 6: Resolve `currentAgentAdapter` through the preset**

Replace `currentAgentAdapter` (lines ~1162–1167):

```ts
  const currentAgentAdapter = (ticketId: number): AgentAdapter => {
    const ticket = getTicket(localStore, ticketId);
    const defaults = resolveAgentDefaults(currentManifest(), ticket.agentPreset);
    const provider = resolveProvider(ticket.agentProvider, defaults.provider);
    return instrument(resolveAdapter(provider), provider);
  };
```

- [ ] **Step 7: Pass the ticket preset into `processFor`**

In `processFor` (lines ~1190–1204), add `preset` to the override passed to `resolveProcessAssignment`:

```ts
    { provider: t.agentProvider ?? undefined,
      model: t.model || undefined,
      effort: t.effort || undefined,
      preset: t.agentPreset ?? undefined },
```

- [ ] **Step 8: Run typecheck and the launch tests**

Run: `npm run typecheck`
Expected: no errors.
Run: `npx vitest run <the test file from Step 1>`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/extension.ts
git commit -m "feat(agent): launch sessions and processes from the effective preset"
```

---

## Task 7: Display resolution (dashboard, sidebar, diagnostics, settings views)

**Files:**
- Modify: `src/ui/dashboard/state.ts`
- Modify: `src/ui/dashboard/panel.ts`
- Modify: `src/ui/sidebar/state.ts`
- Modify: `src/ui/sidebar/items.ts`
- Modify: `src/diagnostics/collectMetadata.ts`
- Modify: `src/ui/settings/processAssignmentViews.ts`
- Tests: `src/ui/dashboard/state.test.ts` (or `renderFixtures.test.ts`), `src/ui/settings/processAssignmentViews.test.ts`, `src/diagnostics/*.test.ts`

**Interfaces:**
- Consumes: `resolveAgentDefaults` (Task 4), `Ticket.agentPreset` (Task 3).
- Produces: every displayed/derived `resolvedProvider`/`resolvedModel` matches what a launch would use; `SettingsProcessAssignmentView` gains `presetOptions: readonly string[]` and `presetHint: string`.

- [ ] **Step 1: Write the failing settings-view test**

Append to `src/ui/settings/processAssignmentViews.test.ts`:

```ts
it('reports the preset the row would inherit and honors a row preset', () => {
  const manifest = m({
    agentPresets: {
      fast: { provider: 'opencode', model: 'opencode-go/deepseek-v4-flash' },
      deep: { provider: 'claude', model: 'claude-opus-5' },
    },
    defaultAgentPreset: 'fast',
    processes: { review: { preset: 'deep' } },
  });
  const view = buildProcessAssignmentView('review', { preset: 'deep' }, manifest, []);
  expect(view.presetOptions).toEqual(['fast', 'deep']);
  expect(view.effectiveProvider).toBe('claude');
  expect(view.effectiveModel).toBe('claude-opus-5');
});

it('an omitted row inherits the default preset', () => {
  const manifest = m({
    agentPresets: { fast: { provider: 'opencode', model: 'opencode-go/deepseek-v4-flash' } },
    defaultAgentPreset: 'fast',
    processes: { review: {} },
  });
  const view = buildProcessAssignmentView('review', {}, manifest, []);
  expect(view.presetHint).toBe('Default: fast');
  expect(view.effectiveProvider).toBe('opencode');
  expect(view.effectiveModel).toBe('opencode-go/deepseek-v4-flash');
});
```

Use the file's existing `m(...)`/manifest helper.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/ui/settings/processAssignmentViews.test.ts`
Expected: FAIL — `presetOptions` is undefined and the effective core is the legacy manifest core.

- [ ] **Step 3: Make the settings view preset-aware**

In `src/ui/settings/processAssignmentViews.ts`:

Add to `SettingsProcessAssignmentView`:

```ts
  /** Agent preset names offered by the row's preset select, sorted. */
  presetOptions: readonly string[];
  /** 'Default: fast' when the row names no preset and one is defaulted; '' otherwise. */
  presetHint: string;
```

Add `preset` to `invalidField`'s union: `'agent' | 'provider' | 'model' | 'effort' | 'preset' | null`.

Import `resolveAgentDefaults` from `../../agent/agentPresets.js`. At the top of `buildProcessAssignmentView`:

```ts
  const defaults = resolveAgentDefaults(manifest, undefined, cfg.preset);
  const presetOptions = Object.keys(manifest.agentPresets ?? {}).sort();
  const presetHint =
    cfg.preset === undefined && manifest.defaultAgentPreset
      ? `Default: ${displayName(manifest.defaultAgentPreset)}`
      : '';
```

Replace `const manifestCore = resolveProvider(undefined, manifest.agentProvider);` with:

```ts
  const manifestCore = defaults.provider;
```

Replace the `resolveModelForProvider(effectiveProvider, cfg.model ?? null, manifest.defaultModel, catalog)` argument with `defaults.model`, and the `resolveEffortForProvider(effectiveProvider, null, manifest.defaultEffort, effectiveModel, catalog)` argument with `defaults.effort`.

Add an `unknown-preset` state as the first error branch after `disabled`:

```ts
  } else if (cfg.preset !== undefined && !presetOptions.includes(cfg.preset)) {
    state = 'unknown-preset';
    stateTone = 'error';
    stateMessage =
      `Agent preset "${displayName(cfg.preset)}" does not exist. ` +
      'Pick a preset or leave the role default.';
    invalidField = 'preset';
```

Add `'unknown-preset'` to the `ProcessAssignmentState` union and to the doc comment's precedence list. Return `presetOptions` and `presetHint` from the view object.

- [ ] **Step 4: Make the dashboard/sidebar/diagnostics resolution preset-aware**

In `src/ui/dashboard/state.ts` (line ~450): replace

```ts
  const resolvedProvider = resolveProvider(ticket.agentProvider, defaultProvider);
```

with a `resolveAgentDefaults(ticket.agentPreset, ...)`-derived default, then pass `defaultModel: defaults.model` and `defaultEffort: defaults.effort` into `buildAgentSessionView` and use `defaults.effort` for the `resolveEffortForProvider` call (line ~478). Import `resolveAgentDefaults`.

In `src/ui/dashboard/panel.ts` (`assignmentFor`, lines ~935–956): for the session, resolve `defaults = resolveAgentDefaults(manifest, ticket.agentPreset)` and use `resolveProvider(ticket.agentProvider, defaults.provider)` + `resolveModelForProvider(provider, ticket.model, defaults.model)`; for tester/review, pass `preset: ticket.agentPreset ?? undefined` in the `resolveProcessAssignment` override so the per-ticket preset applies there too.

In `src/ui/sidebar/state.ts` (lines ~231–232) and `src/ui/sidebar/items.ts` (line ~109): use `resolveAgentDefaults(ticket.agentPreset).provider` in place of `opts.defaultProvider` for the provider, and carry the preset-aware default model where the sidebar shows one.

In `src/diagnostics/collectMetadata.ts` (lines ~181–182): compute `defaults = resolveAgentDefaults(input.manifest, ticket.agent_preset)` and pass `defaults.provider`/`defaults.model`. Add `ticket.agent_preset` to the diagnostics ticket read if it reads named columns; a `SELECT *`-style read needs no change.

- [ ] **Step 5: Run tests and typecheck**

Run: `npx vitest run src/ui/settings/processAssignmentViews.test.ts src/ui/dashboard/state.test.ts src/ui/sidebar/state.test.ts src/diagnostics`
Expected: PASS.
Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/ui/dashboard/state.ts src/ui/dashboard/panel.ts src/ui/sidebar/state.ts src/ui/sidebar/items.ts src/diagnostics/collectMetadata.ts src/ui/settings/processAssignmentViews.ts src/ui/settings/processAssignmentViews.test.ts
git commit -m "feat(ui): resolve displayed agent identity through the effective preset"
```

---

## Task 8: Switch and recovery resolution

**Files:**
- Modify: `src/extension.ts`
- Modify: `src/agent/sessionSwitch.ts` (only if a caller passes raw manifest fields rather than resolved defaults)
- Tests: the existing switch/recovery suites

**Interfaces:**
- Consumes: Task 4 resolver, Task 3 column.
- Produces: an agent switch and a recovery/resume decision agree with the preset-aware launch identity.

- [ ] **Step 1: Write the failing test**

Find and extend the existing switch/resume test (grep for `switchAgentSession`, `applyAgentSwitchSelection`, or `sessionProviderFor`). Add a case where the ticket carries a preset and the current/default identity comes from that preset. If the seam is only exercised e2e, note it in the commit and rely on typecheck + e2e.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run <the switch/resume test file>`
Expected: FAIL.

- [ ] **Step 3: Make the switch/recovery paths preset-aware**

In `src/extension.ts`:
- `switchAgentSession` (lines ~1477–1543): resolve `defaults = resolveAgentDefaults(currentManifest(), ticket.agentPreset)` and pass `defaultModel: defaults.model`, `defaultEffort: defaults.effort`, and `defaultProvider: defaults.provider` into the agent-switch snapshot instead of the raw manifest fields.
- `sessionProviderFor` (line ~3369) and `toRecoveryCandidate` (lines ~6615–6627): resolve through `resolveAgentDefaults(ticket.agentPreset)` before `resolveProvider`, so a resume decision compares against the same core a launch would mint.

In `src/agent/sessionSwitch.ts` (`applyAgentSwitchSelection`, lines ~175–247): it already receives resolved `defaultModel`/`defaultEffort`/`defaultProvider` as arguments (lines ~196, ~202). No change unless Step 1's test shows a raw-manifest caller; if so, change that caller to pass the resolved defaults.

- [ ] **Step 4: Run tests and typecheck**

Run: `npx vitest run src/agent/sessionSwitch.test.ts`
Expected: PASS.
Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/extension.ts src/agent/sessionSwitch.ts
git commit -m "feat(agent): resolve switch and recovery identity through the effective preset"
```

---

## Task 9: Ticket-form state — preset names, selected preset, preset-aware defaults

**Files:**
- Modify: `src/ui/ticketForm/state.ts`
- Test: `src/ui/ticketForm/state.test.ts`

**Interfaces:**
- Consumes: `resolveAgentDefaults` (Task 4), `Ticket.agentPreset` (Task 3).
- Produces: `TicketFormState` gains `agentPresetNames: string[]`, `defaultAgentPreset: string | null`, `selectedAgentPreset: string | null`; `defaultAgentProvider`/`defaultModel`/`defaultEffort` and the seeded `models` list all resolve through the effective preset.

- [ ] **Step 1: Write the failing test**

Append to `src/ui/ticketForm/state.test.ts`:

```ts
it('create mode seeds the default preset and its core/model', () => {
  const store = openStore(':memory:');
  const manifest = m({
    agentPresets: { fast: { provider: 'opencode', model: 'opencode-go/deepseek-v4-flash' } },
    defaultAgentPreset: 'fast',
  });
  const state = buildTicketFormState(store, manifest, () => [], () => []);
  expect(state.agentPresetNames).toEqual(['fast']);
  expect(state.defaultAgentPreset).toBe('fast');
  expect(state.selectedAgentPreset).toBeNull();
  expect(state.defaultAgentProvider).toBe('opencode');
  expect(state.defaultModel).toBe('opencode-go/deepseek-v4-flash');
  expect(state.models.map((x) => x.id)).toContain('opencode-go/deepseek-v4-flash');
});

it('edit mode surfaces the ticket preset and resolves its core/model', () => {
  const store = openStore(':memory:');
  const manifest = m({
    agentPresets: {
      fast: { provider: 'opencode', model: 'opencode-go/deepseek-v4-flash' },
      deep: { provider: 'claude', model: 'claude-opus-5' },
    },
    defaultAgentPreset: 'fast',
  });
  const t = createTicket(store, { key: 'A-1', title: 'T' });
  updateTicketFields(store, t.id, { agentPreset: 'deep' });
  const state = buildTicketFormState(store, manifest, () => [], () => [], t.id);
  expect(state.selectedAgentPreset).toBe('deep');
  expect(state.defaultAgentProvider).toBe('claude');
  expect(state.defaultModel).toBe('claude-opus-5');
});
```

Use the file's existing `m(...)` helper; otherwise import `manifest`/`repo` from `src/manifest/fixtures.ts`.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/ui/ticketForm/state.test.ts`
Expected: FAIL — the new fields are undefined.

- [ ] **Step 3: Add the state fields and wire the resolver**

In `src/ui/ticketForm/state.ts`, add to `TicketFormState` (near `defaultAgentProvider`):

```ts
  /** Agent preset names defined in the manifest, sorted; offered by the preset select. */
  agentPresetNames: string[];
  /** Manifest default preset name, for the "Inherit (settings: …)" label; null = none. */
  defaultAgentPreset: string | null;
  /** Per-ticket preset override; null = inherit `manifest.defaultAgentPreset`. */
  selectedAgentPreset: string | null;
```

Import `resolveAgentDefaults` from `../../agent/agentPresets.js`.

In create mode, replace the hardcoded `defaultAgentProvider = manifest.agentProvider ?? 'claude'` (line 291) and the model/effort seeding (lines 355–364) with:

```ts
  const createDefaults = resolveAgentDefaults(manifest, null);
  const agentPresetNames = Object.keys(manifest.agentPresets ?? {}).sort();
```

and use `createDefaults.provider` / `createDefaults.model` / `createDefaults.effort` for `models`, `defaultAgentProvider`, `defaultModel`, `defaultEffort`. Add:

```ts
      agentPresetNames,
      defaultAgentPreset: manifest.defaultAgentPreset ?? null,
      selectedAgentPreset: null,
```

In edit mode, compute:

```ts
  const editDefaults = resolveAgentDefaults(manifest, ticket.agentPreset);
```

and use `editDefaults.provider` for `modelsForProvider(...)` (line ~406), `editDefaults.model` for `defaultModel`, `editDefaults.effort` for `defaultEffort`, plus:

```ts
    agentPresetNames,
    defaultAgentPreset: manifest.defaultAgentPreset ?? null,
    selectedAgentPreset: ticket.agentPreset ?? null,
```

Keep `defaultAgentProvider` = `editDefaults.provider`.

- [ ] **Step 4: Run tests and typecheck**

Run: `npx vitest run src/ui/ticketForm/state.test.ts`
Expected: PASS.
Run: `npm run typecheck`
Expected: no errors (the panel's state consumer may need the new fields; if `TicketFormState` is constructed literally elsewhere, add the fields there too).

- [ ] **Step 5: Commit**

```bash
git add src/ui/ticketForm/state.ts src/ui/ticketForm/state.test.ts
git commit -m "feat(ticket-form): seed the preset picker and preset-aware defaults"
```

---

## Task 10: Ticket-form messages + actions (`set-preset`, mutual exclusivity, persist)

**Files:**
- Modify: `src/ui/ticketForm/messages.ts`
- Modify: `src/ui/ticketForm/actions.ts`
- Tests: `src/ui/ticketForm/messages.test.ts`, `src/ui/ticketForm/actions.test.ts`

**Interfaces:**
- Consumes: `TicketFieldsPatch.agentPreset` (Task 3), state fields (Task 9).
- Produces: `TicketDraftFields.agentPreset?: string | null`; message `{ type: 'set-preset'; id: string }`; action `setPreset(id)`; touching the agent-core/model/effort picker clears the ticket preset.

- [ ] **Step 1: Write the failing tests**

Append to `src/ui/ticketForm/messages.test.ts`:

```ts
it('parses set-preset with a blank id (Inherit)', () => {
  expect(parseTicketFormMessage({ type: 'set-preset', id: '' })).toEqual({
    type: 'set-preset',
    id: '',
  });
});

it('refuses set-preset with a non-string id', () => {
  expect(parseTicketFormMessage({ type: 'set-preset', id: 1 })).toBeNull();
});

it('parses agentPreset on submit and save', () => {
  const draft = { key: 'A-1', title: 'T', description: '', repos: [], approach: null, agent: null, model: null, ticketType: null, createInProvider: false, agentPreset: 'fast' };
  expect(parseTicketFormMessage({ type: 'submit', ...draft, pullBase: true })).toMatchObject({ agentPreset: 'fast' });
  expect(parseTicketFormMessage({ type: 'save', ...draft })).toMatchObject({ agentPreset: 'fast' });
});
```

Append to `src/ui/ticketForm/actions.test.ts`:

```ts
it('setPreset persists the preset and clears explicit core/model/effort', () => {
  const { actions, store, ticketId } = harness();
  actions.setProvider('claude');
  actions.setModel('claude-opus-5');
  actions.setPreset('fast');
  const t = getTicket(store, ticketId);
  expect(t?.agentPreset).toBe('fast');
  expect(t?.agentProvider).toBeNull();
  expect(t?.model).toBeNull();
  expect(t?.effort).toBeNull();
});

it('picking an explicit core clears the ticket preset', () => {
  const { actions, store, ticketId } = harness();
  actions.setPreset('fast');
  actions.setProvider('claude');
  expect(getTicket(store, ticketId)?.agentPreset).toBeNull();
});
```

Use the file's existing harness/helpers (`harness()`, `openStore`, `getTicket`, `updateTicketFields`). If the harness has a different shape, adapt while keeping the assertions.

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/ui/ticketForm/messages.test.ts src/ui/ticketForm/actions.test.ts`
Expected: FAIL — `set-preset` is unknown / `setPreset` does not exist.

- [ ] **Step 3: Add the message, the draft field, and the parser**

In `src/ui/ticketForm/messages.ts`:

Add to `TicketDraftFields`:

```ts
  /** Per-ticket agent-preset name; null = inherit the manifest default preset. */
  agentPreset?: string | null;
```

Add to `TicketFormMessage` beside `set-provider`:

```ts
  // id may be '' — the "Inherit (settings)" choice, which clears the preset.
  | { type: 'set-preset'; id: string }
```

Add `setPreset: (id: string) => void | Promise<void>;` to `TicketFormActions`. In `parseDraftFields`, read the optional preset:

```ts
  const agentPreset = typeof m['agentPreset'] === 'string' ? m['agentPreset'] : undefined;
  // ... include in the returned object:
  //   agentPreset,
```

Add the parse case and route case for `set-preset` exactly as `set-provider` is handled (require `typeof id === 'string'`; a non-string returns `null`).

- [ ] **Step 4: Add the action**

In `src/ui/ticketForm/actions.ts`:

In `persistDraft`'s `updateTicketFields` call (lines 288–298) add:

```ts
    agentPreset: input.agentPreset ?? '',
```

Add the action after `setProvider` (line ~781):

```ts
    setPreset(id: string): void {
      // An empty id is "Inherit (settings)" — persisted as '' which the store
      // maps to NULL. A real preset GOVERN'S, so explicit core/model/effort are
      // cleared; otherwise they would win by precedence and the pick would look
      // ignored. The next state push re-renders the picker onto the preset.
      if (ctx.ticketId === undefined) return;
      updateTicketFields(
        deps.store,
        ctx.ticketId,
        id === ''
          ? { agentPreset: '' }
          : { agentPreset: id, agentProvider: '', model: '', effort: '' },
      );
      ctx.pushState();
    },
```

In `setProvider` (line ~778) and `setModel` (line ~759) and `setEffort` (line ~767), add `agentPreset: ''` to the patch so an explicit pick clears the preset:

```ts
        updateTicketFields(deps.store, ctx.ticketId, { agentProvider: id, agentPreset: '' });
```

```ts
        updateTicketFields(deps.store, ctx.ticketId, { model: id, agentPreset: '' });
```

```ts
        updateTicketFields(deps.store, ctx.ticketId, { effort: id, agentPreset: '' });
```

- [ ] **Step 5: Run tests and typecheck**

Run: `npx vitest run src/ui/ticketForm/messages.test.ts src/ui/ticketForm/actions.test.ts`
Expected: PASS.
Run: `npm run typecheck`
Expected: no errors (the `TicketFormActions` interface is implemented by the panel; adding `setPreset` means the panel/deps factory and any test fake must supply it — fix each).

- [ ] **Step 6: Commit**

```bash
git add src/ui/ticketForm/messages.ts src/ui/ticketForm/actions.ts src/ui/ticketForm/messages.test.ts src/ui/ticketForm/actions.test.ts
git commit -m "feat(ticket-form): persist the per-ticket agent preset"
```

---

## Task 11: Ticket-form webview preset select

**Files:**
- Modify: `src/ui/ticketForm/webview.html`
- Test: `src/ui/ticketForm/webview.test.ts`

**Interfaces:**
- Consumes: `TicketFormState.agentPresetNames`/`defaultAgentPreset`/`selectedAgentPreset` (Task 9), `set-preset` (Task 10).
- Produces: a rendered preset `<select>` that posts `set-preset`, and `agentPreset` on submit/save.

- [ ] **Step 1: Write the failing webview test**

Append to `src/ui/ticketForm/webview.test.ts` following the file's existing HTML-sandbox pattern (it extracts functions by name with `functionSource`):

```ts
it('renders the agent preset select from pushed state', () => {
  const sandbox = runInSandbox(`
    ${functionSource('renderAgentPresetSelect')}
    const el = (id) => (document.getElementById(id).innerHTML = '');
    draft = { agentPreset: null };
    renderAgentPresetSelect(['fast', 'deep'], null, 'fast');
    return document.getElementById('agentPresetSelect').innerHTML;
  `, '<select id="agentPresetSelect"></select>');
  expect(sandbox).toContain('value="fast"');
  expect(sandbox).toContain('value="deep"');
  expect(sandbox).toContain('Inherit (settings: fast)');
});

it('keeps a saved preset that is no longer defined', () => {
  const sandbox = runInSandbox(`
    ${functionSource('renderAgentPresetSelect')}
    const el = (id) => (document.getElementById(id).innerHTML = '');
    draft = { agentPreset: 'gone' };
    renderAgentPresetSelect(['fast'], 'gone', null);
    return document.getElementById('agentPresetSelect').innerHTML;
  `, '<select id="agentPresetSelect"></select>');
  expect(sandbox).toContain('value="gone"');
  expect(sandbox).toContain('(unknown)');
});
```

Adapt the sandbox helper name to the file's actual helper.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/ui/ticketForm/webview.test.ts`
Expected: FAIL — `renderAgentPresetSelect` is not defined.

- [ ] **Step 3: Add the HTML field**

In `src/ui/ticketForm/webview.html`, after the Type field (lines 564–567):

```html
      <div class="field">
        <label for="agentPresetSelect">Agent preset</label>
        <select class="k-input" id="agentPresetSelect"></select>
        <div class="field-help">A named core + model defined in karst.yml. Picking one clears the explicit core, model and effort below.</div>
      </div>
```

- [ ] **Step 4: Add the renderer and wire it**

In `src/ui/ticketForm/webview.html`, add next to `renderTypePicker` (line ~1210):

```js
  // Agent preset picker: "Inherit (settings: <default preset>)" plus every
  // preset the manifest defines. A saved preset the manifest no longer defines
  // stays visible, marked "(unknown)" — never silently dropped (UI-R34 mirror
  // discipline: the host supplies the list, the page renders it).
  function renderAgentPresetSelect(names, selected, defaultName) {
    const list = names || [];
    const sel = draft.agentPreset ?? selected ?? '';
    const inheritLabel = defaultName
      ? 'Inherit (settings: ' + esc(defaultName) + ')'
      : 'Inherit (settings: none)';
    const opts = [`<option value=""${sel ? '' : ' selected'}>${inheritLabel}</option>`];
    for (const n of list) {
      opts.push(`<option value="${esc(n)}"${n === sel ? ' selected' : ''}>${esc(n)}</option>`);
    }
    if (sel && list.indexOf(sel) === -1) {
      opts.push(`<option value="${esc(sel)}" selected>${esc(sel)} (unknown)</option>`);
    }
    el('agentPresetSelect').innerHTML = opts.join('');
  }
```

In `render(state)` (after the type picker call at line 794), add:

```js
    renderAgentPresetSelect(state.agentPresetNames, state.selectedAgentPreset, state.defaultAgentPreset);
```

Add the change listener beside the type listener (line ~1974):

```js
  el('agentPresetSelect').addEventListener('change', (e) => {
    const select = e.target;
    const id = select.value;
    draft.agentPreset = id || null;
    // A real preset governs: drop any explicit core/model/effort so the preset
    // takes effect (explicit values win by precedence).
    if (id) {
      draft.selectedAgentProvider = null;
      draft.selectedModel = null;
      draft.selectedEffort = null;
    }
    const requestId = karstRequestId();
    karstBeginPending(select, requestId);
    post({ type: 'set-preset', id, requestId });
  });
```

- [ ] **Step 5: Carry the preset on submit and save**

In both the submit handler (line ~1478) and the save handler (line ~1505), add `agentPreset` to the posted payload:
`agentPreset: (draft.agentPreset ?? lastSelectedAgentPreset) || null,`

Declare `lastSelectedAgentPreset` next to the other `lastSelected*` caches (line ~1163) and set it in `render(state)`:

```js
    lastSelectedAgentPreset = state.selectedAgentPreset ?? null;
```

- [ ] **Step 6: Run tests**

Run: `npx vitest run src/ui/ticketForm/webview.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/ui/ticketForm/webview.html src/ui/ticketForm/webview.test.ts
git commit -m "feat(ticket-form): add the agent preset picker (UI-R34)"
```

---

## Task 12: Settings — default preset select + per-process preset select

**Files:**
- Modify: `src/ui/settings/sections.ts`
- Modify: `src/ui/settings/webview.html`
- Modify: `src/ui/settings/webview.test.ts`
- Tests: `src/ui/settings/sections.test.ts`

**Interfaces:**
- Consumes: `SettingsProcessAssignmentView.presetOptions`/`presetHint` (Task 7); manifest `agentPresets`/`defaultAgentPreset`.
- Produces: `general` section claims `defaultAgentPreset`; a General-tab select writes it; each process row has a preset select writing `draft.processes[key].preset`.

- [ ] **Step 1: Write the failing mirror test**

In `src/ui/settings/sections.test.ts`, add `defaultAgentPreset` to the expected `SECTION_FIELDS.general` assertion (line ~45). In `src/ui/settings/webview.test.ts`, the existing "mirrors the host section vocabulary exactly" test (line ~758) will fail until the webview mirror is updated — run it to confirm.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/ui/settings/sections.test.ts src/ui/settings/webview.test.ts`
Expected: FAIL — the host `SECTION_FIELDS.general` gains the field but the mirror does not.

- [ ] **Step 3: Claim `defaultAgentPreset` in the general section**

In `src/ui/settings/sections.ts`, add `'defaultAgentPreset'` to `SECTION_FIELDS.general` after `'defaultEffort'`.

`agentPresets` is deliberately NOT in any section: preset definitions are authored in `karst.yml`, and a field no section claims always survives from the base (`mergeSection`), so a General-tab Save can never drop the presets (the `id`/`uat` rule).

- [ ] **Step 4: Mirror the section in the webview**

In `src/ui/settings/webview.html`, add `'defaultAgentPreset'` to `SECTION_FIELDS.general` (line ~2238).

- [ ] **Step 5: Add the General-tab select**

In the General-tab HTML, immediately after the `defaultAgentPicker` `.form-grid` (line ~1149):

```html
        <div class="form-grid">
          <div class="field-label" id="defaultAgentPresetLabel">Default agent preset</div>
          <div class="field-control">
            <select id="f-defaultAgentPreset" aria-labelledby="defaultAgentPresetLabel"></select>
            <div class="field-help">Applies to every ticket that picks no preset of its own. A preset overrides the core + model above; a ticket or process can still override it.</div>
          </div>
        </div>
```

Add the renderer and call it in the General render, next to `renderPresetOptions()` (line ~2662):

```js
  // Agent preset names for the default-preset select. Named distinctly from
  // renderPresetOptions (the Git tab's conventional-commit presets).
  function renderAgentPresetOptions() {
    const names = Object.keys(draft.agentPresets || {}).sort();
    const sel = draft.defaultAgentPreset || '';
    el('f-defaultAgentPreset').innerHTML =
      `<option value="">None (use the core + model above)</option>`
      + names.map((n) => `<option value="${esc(n)}"${n === sel ? ' selected' : ''}>${esc(n)}</option>`).join('');
  }
```

Add the change listener with the other General inputs:

```js
  el('f-defaultAgentPreset').addEventListener('change', (e) => {
    draft.defaultAgentPreset = e.target.value || undefined;
    markDirty();
  });
```

- [ ] **Step 6: Add the per-process preset select to the row**

In `renderProcessAssignmentRow` (line ~4592), build the preset options from the host-supplied `v.presetOptions` and keep an unknown saved value visible, then insert a select into the `proc-agent-cell` before the picker mount point:

```js
    let presetOpts = '<option value="">Role default</option>'
      + (v.presetOptions || []).map((name) =>
        `<option value="${esc(name)}"${name === cfg.preset ? ' selected' : ''}>${esc(name)}</option>`,
      ).join('');
    if (cfg.preset && !(v.presetOptions || []).includes(cfg.preset)) {
      presetOpts += `<option value="${esc(cfg.preset)}" selected>${esc(cfg.preset)}</option>`;
    }
```

```js
      + `<div class="proc-cell proc-agent-cell">`
      + `<label for="proc-${key}-preset">Agent preset</label>`
      + `<select id="proc-${key}-preset" class="proc-select" data-proc-field="preset" data-proc-key="${key}"${invalid('preset')}>${presetOpts}</select>`
      + `<div class="ap" data-proc-picker="${key}" data-proc-key="${key}"${describedBy}${invalid('provider')}${invalid('model')}${invalid('effort')}></div>`
```

Wire the field in the same delegated change handler that already writes `data-proc-field` values (the handler around `updateProcessAssignment`). A real preset clears explicit fields:

```js
    if (field === 'preset') {
      updateProcessAssignment(key, value
        ? { preset: value, provider: '', model: '', effort: '' }
        : { preset: '' });
      return;
    }
```

(`updateProcessAssignment` already deletes keys whose value is `''`, so the clears write the manifest's absent-field removal.)

- [ ] **Step 7: Run tests and typecheck**

Run: `npx vitest run src/ui/settings/sections.test.ts src/ui/settings/webview.test.ts`
Expected: PASS.
Run: `npm run typecheck`
Expected: no errors.
Run: `npx vitest run src/ui/runtimeConformance.render.test.ts`
Expected: PASS (UI-R09/R10/R25/R36 across views; the new controls need labels and described-by wiring).

- [ ] **Step 8: Commit**

```bash
git add src/ui/settings/sections.ts src/ui/settings/webview.html src/ui/settings/webview.test.ts
git commit -m "feat(settings): default agent preset and per-process preset (UI-R25, UI-R34)"
```

---

## Task 13: Docs

**Files:**
- Modify: `docs/arch/agent-cores.md`
- Modify: `docs/arch/manifest-and-settings.md`

**Interfaces:**
- Consumes: the whole feature.
- Produces: the binding reference docs describe the preset precedence and the new fields.

- [ ] **Step 1: Add the preset resolution rule to `docs/arch/agent-cores.md`**

Add a section after "Per-ticket launch model":

```markdown
## Agent presets layer the manifest defaults; explicit fields still win

`agentPresets:` maps a name to `{provider, model, effort?}` and
`defaultAgentPreset:` names the global default; `processes.<key>.preset` and
`tickets.agent_preset` reference a preset by name. `resolveAgentDefaults`
(`agent/agentPresets.ts`) is the ONE precedence rule for the preset LAYER:
`processes.<key>.preset` → `tickets.agent_preset` → `manifest.defaultAgentPreset`,
then the preset's fields, else the legacy `agentProvider`/`defaultModel`/
`defaultEffort`. It returns the manifest-level defaults every existing call site
already consumes, so per-process and per-ticket explicit values keep winning and
a manifest with no presets resolves byte-identically to before. Manifest-level
dangling references (`defaultAgentPreset`, `processes.<key>.preset`) are refused
at load; a dangling `tickets.agent_preset` degrades to "no preset" and is shown
as unknown in the ticket form. Graph `approaches[].graph.profiles` stay a
separate, per-approach mechanism and are deliberately NOT unified with presets.
```

- [ ] **Step 2: Record the new-field checklist outcome**

In `docs/arch/manifest-and-settings.md`'s "New `Manifest` field checklist" section, add one sentence:

```markdown
`agentPresets`/`defaultAgentPreset` follow the checklist: typed in `types.ts`,
validated in `validate/agentPresets.ts` (plus reference integrity against
`processes.<key>.preset`), and overlaid in `write.ts`. `agentPresets` is claimed
by no Settings section, so it always survives from the base on a tab-scoped
Save; `defaultAgentPreset` is a General-tab field and the process rows carry the
per-role `preset`.
```

- [ ] **Step 3: Verify docs and the example still load**

Run: `npx vitest run src/manifest/example.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add docs/arch/agent-cores.md docs/arch/manifest-and-settings.md
git commit -m "docs: document agent presets and their precedence"
```

---

## Self-Review

**1. Spec coverage**

| Done-when requirement | Task |
|---|---|
| Presets can be defined in the manifest | Task 1 (`agentPresets`, validation, write overlay), Task 2 (write round-trip, example yml) |
| A default preset applies to all tickets | Task 1 (`defaultAgentPreset` + integrity), Task 4 (`resolveAgentDefaults` default layer), Tasks 5–8 (every resolution path) |
| A ticket can specify which preset to use | Task 3 (`tickets.agent_preset`), Task 9 (state), Task 10 (actions/messages), Task 11 (picker) |
| Each AI process resolves core and model from the effective preset | Task 5 (`resolveProcessAssignment`), Task 6 (session launch, launch intent, `currentAgentAdapter`, `processFor`), Task 7 (display/diagnostics), Task 8 (switch/recovery) |
| Per-process override (from the ticket's "Why") | Task 2 (`processes.<key>.preset`), Task 5 (precedence), Task 12 (Settings row select) |

No gaps.

**2. Placeholder scan**

No "TBD"/"implement later"/"add appropriate error handling" steps. Every code step carries literal code. Two steps are conditional on locating an existing test seam (Task 6 Step 1, Task 8 Step 1); each names the exact fallback (typecheck + e2e) so the executor is never blocked. Tasks 6–8 reference existing expressions by their verified line numbers and quoted shapes rather than reprinting 6000-line-file context.

**3. Type consistency**

- `AgentPreset` is defined once in `types.ts` and re-exported by `agentPresets.ts`; both the manifest map and `processes.<key>.preset` reference it.
- `resolveAgentDefaults(manifest, ticketPreset?, rolePreset?)` has the same 3-arg shape at every call site (`processAssignment.ts`, `extension.ts`, dashboard, sidebar, diagnostics, ticket-form state).
- Store names are consistent: column `agent_preset`, `Ticket.agentPreset`, `TicketFieldsPatch.agentPreset`.
- UI names are consistent: `agentPresetNames`/`defaultAgentPreset`/`selectedAgentPreset` (state), `agentPreset` (draft/message/patch), `presetOptions`/`presetHint` (settings view), `f-defaultAgentPreset` (settings DOM), `agentPresetSelect` (ticket-form DOM), `renderAgentPresetOptions` (settings — deliberately distinct from the existing `renderPresetOptions` for convention presets).
- `ProcessAssignmentState` gains `'unknown-preset'` once, in Task 7, and is only consumed by Task 12's row.

**Known non-goals (stated so an executor does not silently expand scope):**
- No in-app authoring UI for presets — they are defined in `karst.yml` (same posture as agent-pool profiles today). The Settings select lists them.
- Graph `approaches[].graph.profiles` are not unified with presets.
- The `karst` CLI `context` output is not extended; the new column is additive and no CLI query selects it.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-09-17-agent-presets.md`. Two execution options:

1. **Subagent-Driven (recommended)** — a fresh subagent per task with review between tasks.
2. **Inline Execution** — execute tasks in this session with checkpoints.
