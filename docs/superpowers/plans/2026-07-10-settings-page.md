# Karst Settings Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A VS Code webview that edits every section of `.karst/karst.yml` (General, Services, Approaches, Agents) and writes changes back to disk safely, gated by the same validator the loader uses.

**Architecture:** Mirror the existing `src/ui/dashboard` / `src/ui/onboarding` webview pattern — host-agnostic modules (`panel`/`state`/`messages`/`actions`/`webview.html`), unit-tested with fakes, `vscode` bound only in `extension.ts`. A new `writeManifest` (merge-over-raw) generalizes the existing single-field `writeServiceSignals`. Live validation drives Save-enabled; nothing writes until an explicit Save.

**Tech Stack:** TypeScript (ESM, `.js` import suffix), vitest, js-yaml, better-sqlite3, `@types/vscode` (dev only).

## Global Constraints

- ESM (`type:module`): every relative import needs a `.js` suffix; `moduleResolution:Bundler`.
- `noUncheckedIndexedAccess` on: array/record access needs `!` or a guard.
- `vscode` is NOT a runtime dep — host-agnostic modules take injected interfaces; only `extension.ts` imports `vscode`.
- Immutability: never mutate inputs; return new objects (spread).
- Strict TDD: RED → GREEN → commit per step. Conventional commits (`feat:`/`test:`/`refactor:`).
- Files small (<400 lines typical).
- Reuse `validateManifest` for ALL validation — never a second validator (zero drift).
- Tests use in-memory store `openStore(':memory:')` where a store is needed; filesystem tests use `mkdtempSync`.
- Run a single test file: `npx vitest run src/path/to.test.ts`.

---

### Task 1: `writeManifest` — merge-over-raw manifest writer

**Files:**
- Modify: `src/manifest/write.ts` (add `writeManifest`; keep `writeServiceSignals`)
- Test: `src/manifest/writeManifest.test.ts`

**Interfaces:**
- Consumes: `validateManifest` (from `./schema.js`), `ManifestError` (from `./schema.js`), `Manifest` (from `./types.js`).
- Produces: `writeManifest(path: string, manifest: Manifest): void` — reads the raw YAML tree at `path`, overlays the four editable sections (`host`, `portRange`, `baselineBranch`, `worktreePathDisplay`, `services`, `approaches`, `agents`) from `manifest` onto the raw tree, **preserving any other top-level keys and any service sub-keys the type doesn't model**, re-validates the merged tree, then serializes and writes. Throws `ManifestError` on invalid; never writes on failure.

- [ ] **Step 1: Write the failing test**

Create `src/manifest/writeManifest.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { load as yamlLoad } from 'js-yaml';
import { writeManifest } from './write.js';
import { loadManifest } from './load.js';
import type { Manifest } from './types.js';

// Includes an unknown top-level key (`extraTopLevel`) and an unmodeled service
// sub-key (`services.backend.customField`) that must SURVIVE a write.
const RAW = `
extraTopLevel: keep-me
host: localhost
portRange: [4000, 4999]
baselineBranch: develop
services:
  backend:
    repoPath: ../backend
    start: npm run dev
    customField: also-keep
    ports:
      - { name: http, env: PORT, default: 3000 }
    dependsOn: []
`;

function fixture(body = RAW): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'karst-wm-'));
  const path = join(dir, 'karst.yml');
  writeFileSync(path, body);
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe('writeManifest', () => {
  it('round-trips an edited manifest through validation', () => {
    const { path, cleanup } = fixture();
    try {
      const m = loadManifest(path);
      const edited: Manifest = { ...m, baselineBranch: 'main' };
      writeManifest(path, edited);
      expect(loadManifest(path).baselineBranch).toBe('main');
    } finally {
      cleanup();
    }
  });

  it('preserves unknown top-level keys and unmodeled service fields', () => {
    const { path, cleanup } = fixture();
    try {
      const m = loadManifest(path);
      writeManifest(path, { ...m, host: '0.0.0.0' });
      const raw = yamlLoad(readFileSync(path, 'utf8')) as Record<string, any>;
      expect(raw.extraTopLevel).toBe('keep-me');
      expect(raw.services.backend.customField).toBe('also-keep');
      expect(raw.host).toBe('0.0.0.0'); // edit landed
    } finally {
      cleanup();
    }
  });

  it('never writes when the merged manifest fails validation', () => {
    const { path, cleanup } = fixture();
    try {
      const before = readFileSync(path, 'utf8');
      const m = loadManifest(path);
      // portRange min > max — validateManifest throws.
      const bad: Manifest = { ...m, portRange: [9000, 1000] };
      expect(() => writeManifest(path, bad)).toThrow(/portRange/);
      expect(readFileSync(path, 'utf8')).toBe(before); // untouched
    } finally {
      cleanup();
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/manifest/writeManifest.test.ts`
Expected: FAIL — `writeManifest` is not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `src/manifest/write.ts` (keep existing imports + `writeServiceSignals`):

```typescript
import type { Manifest } from './types.js';

/**
 * Persist an edited `Manifest` to `karst.yml` using MERGE-OVER-RAW: read the
 * raw YAML tree, overlay only the modeled sections, and keep every other
 * top-level key + unmodeled service sub-key intact. Re-validate the merged tree
 * before writing so we never persist a manifest the loader would reject.
 *
 * TRADEOFF: `js-yaml.dump` drops comments; the file may be reformatted on write.
 * This is gated behind an explicit "Save" in the settings UI.
 */
export function writeManifest(path: string, manifest: Manifest): void {
  const text = readFileSync(path, 'utf8');
  let parsed: unknown;
  try {
    parsed = yamlLoad(text);
  } catch (e) {
    throw new ManifestError(`YAML parse failed: ${(e as Error).message}`);
  }
  const root = isRecord(parsed) ? parsed : {};

  // Overlay each edited service onto its raw counterpart so unmodeled sub-keys
  // (e.g. author comments-as-values, future fields) survive.
  const rawServices = isRecord(root.services) ? root.services : {};
  const nextServices: Record<string, unknown> = {};
  for (const [name, svc] of Object.entries(manifest.services)) {
    const rawSvc = isRecord(rawServices[name]) ? rawServices[name] : {};
    nextServices[name] = {
      ...rawSvc,
      repoPath: svc.repoPath,
      start: svc.start,
      health: svc.health,
      ports: svc.ports,
      dependsOn: svc.dependsOn,
      hasMigrations: svc.hasMigrations,
      signals: svc.signals ?? [],
    };
  }

  const next = {
    ...root, // preserve unknown top-level keys
    host: manifest.host,
    portRange: manifest.portRange,
    baselineBranch: manifest.baselineBranch,
    worktreePathDisplay: manifest.worktreePathDisplay ?? 'relative',
    services: nextServices,
    approaches: manifest.approaches ?? [],
    agents: manifest.agents ?? {},
  };

  // Re-validate before persisting — never write a file the loader would reject.
  validateManifest(next);
  writeFileSync(path, yamlDump(next));
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
```

Ensure the top-of-file imports include `yamlDump` and `Manifest`. The file already
imports `{ load as yamlLoad, dump as yamlDump }` and `validateManifest, ManifestError`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/manifest/writeManifest.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/manifest/write.ts src/manifest/writeManifest.test.ts
git commit -m "feat(manifest): writeManifest — merge-over-raw writer preserving unknown keys"
```

---

### Task 2: Settings state builder

**Files:**
- Create: `src/ui/settings/state.ts`
- Test: `src/ui/settings/state.test.ts`

**Interfaces:**
- Consumes: `Manifest`, `ServiceDef`, `PortSlot`, `DependsOn`, `ApproachDef`, `AgentDef`, `WorktreePathDisplay` (from `../../manifest/types.js`).
- Produces:
  - `interface SettingsState { manifest: Manifest; error: string | null }` — the full editable manifest plus a validation error (null when valid). The webview holds the manifest as its editable draft.
  - `buildSettingsState(manifest: Manifest, error?: string | null): SettingsState`.

- [ ] **Step 1: Write the failing test**

Create `src/ui/settings/state.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { buildSettingsState } from './state.js';
import type { Manifest } from '../../manifest/types.js';

const M: Manifest = {
  host: 'localhost',
  portRange: [4000, 4999],
  baselineBranch: 'develop',
  services: {
    backend: {
      repoPath: '../backend',
      start: 'npm run dev',
      ports: [{ name: 'http', env: 'PORT', default: 3000 }],
      dependsOn: [],
      hasMigrations: false,
      signals: [],
    },
  },
  approaches: [{ id: 'tdd', label: 'TDD', recommended: true }],
  agents: { implement: { role: 'implement', command: 'claude' } },
  worktreePathDisplay: 'relative',
};

describe('buildSettingsState', () => {
  it('carries the whole manifest and a null error by default', () => {
    const s = buildSettingsState(M);
    expect(s.manifest).toEqual(M);
    expect(s.error).toBeNull();
  });

  it('carries a validation error when provided', () => {
    const s = buildSettingsState(M, 'portRange min exceeds max');
    expect(s.error).toBe('portRange min exceeds max');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/ui/settings/state.test.ts`
Expected: FAIL — cannot find `./state.js`.

- [ ] **Step 3: Write minimal implementation**

Create `src/ui/settings/state.ts`:

```typescript
import type { Manifest } from '../../manifest/types.js';

/**
 * Fully serializable settings state pushed to the webview. `manifest` is the
 * editable draft source; `error` is the current validation message (null when
 * the draft is valid) so the webview can disable Save + show the message.
 */
export interface SettingsState {
  manifest: Manifest;
  error: string | null;
}

/** Build the initial settings state from a manifest (valid or last-known). */
export function buildSettingsState(
  manifest: Manifest,
  error: string | null = null,
): SettingsState {
  return { manifest, error };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/ui/settings/state.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/ui/settings/state.ts src/ui/settings/state.test.ts
git commit -m "feat(settings): state shape + builder"
```

---

### Task 3: Settings messages — trust boundary + router

**Files:**
- Create: `src/ui/settings/messages.ts`
- Test: `src/ui/settings/messages.test.ts`

**Interfaces:**
- Consumes: `Manifest` (from `../../manifest/types.js`), `SettingsState` (from `./state.js`).
- Produces:
  - `type SettingsWebviewMessage = { type: 'save'; manifest: Manifest } | { type: 'validate'; manifest: Manifest } | { type: 'request-state' }`
  - `type SettingsHostMessage = { type: 'state'; state: SettingsState } | { type: 'validation'; ok: boolean; error: string | null } | { type: 'error'; message: string } | { type: 'saved' }`
  - `interface SettingsActions { save(manifest: Manifest): void; validate(manifest: Manifest): void; requestState(): void }`
  - `parseSettingsMessage(raw: unknown): SettingsWebviewMessage | null` — validates the discriminant AND that `manifest` is a non-null object for `save`/`validate`. (Full manifest validation happens later via `validateManifest`; this only guards the message envelope.)
  - `routeSettingsAction(raw: unknown, actions: SettingsActions): void`

- [ ] **Step 1: Write the failing test**

Create `src/ui/settings/messages.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { parseSettingsMessage, routeSettingsAction, type SettingsActions } from './messages.js';

const draft = { host: 'x', portRange: [1, 2], baselineBranch: 'b', services: {} };

describe('parseSettingsMessage', () => {
  it('accepts save/validate with an object manifest', () => {
    expect(parseSettingsMessage({ type: 'save', manifest: draft })).toEqual({
      type: 'save', manifest: draft,
    });
    expect(parseSettingsMessage({ type: 'validate', manifest: draft })).toEqual({
      type: 'validate', manifest: draft,
    });
  });

  it('accepts request-state', () => {
    expect(parseSettingsMessage({ type: 'request-state' })).toEqual({ type: 'request-state' });
  });

  it('rejects save/validate without an object manifest', () => {
    expect(parseSettingsMessage({ type: 'save' })).toBeNull();
    expect(parseSettingsMessage({ type: 'save', manifest: 'nope' })).toBeNull();
    expect(parseSettingsMessage({ type: 'validate', manifest: null })).toBeNull();
  });

  it('rejects unknown / malformed shapes', () => {
    expect(parseSettingsMessage(null)).toBeNull();
    expect(parseSettingsMessage({ type: 'bogus' })).toBeNull();
    expect(parseSettingsMessage(42)).toBeNull();
  });
});

describe('routeSettingsAction', () => {
  function spies(): SettingsActions & { calls: Record<string, unknown[]> } {
    const calls: Record<string, unknown[]> = { save: [], validate: [], requestState: [] };
    return {
      calls,
      save: (m) => calls.save.push(m),
      validate: (m) => calls.validate.push(m),
      requestState: () => calls.requestState.push(true),
    };
  }

  it('routes each valid message to its action', () => {
    const a = spies();
    routeSettingsAction({ type: 'save', manifest: draft }, a);
    routeSettingsAction({ type: 'validate', manifest: draft }, a);
    routeSettingsAction({ type: 'request-state' }, a);
    expect(a.calls.save).toEqual([draft]);
    expect(a.calls.validate).toEqual([draft]);
    expect(a.calls.requestState).toEqual([true]);
  });

  it('ignores malformed messages (no throw, no action)', () => {
    const a = spies();
    expect(() => routeSettingsAction({ type: 'bogus' }, a)).not.toThrow();
    expect(a.calls.save).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/ui/settings/messages.test.ts`
Expected: FAIL — cannot find `./messages.js`.

- [ ] **Step 3: Write minimal implementation**

Create `src/ui/settings/messages.ts`:

```typescript
import type { Manifest } from '../../manifest/types.js';
import type { SettingsState } from './state.js';

/** Webview → host messages. The webview is untrusted; parse before use. */
export type SettingsWebviewMessage =
  | { type: 'save'; manifest: Manifest }
  | { type: 'validate'; manifest: Manifest }
  | { type: 'request-state' };

/** Host → webview messages. */
export type SettingsHostMessage =
  | { type: 'state'; state: SettingsState }
  | { type: 'validation'; ok: boolean; error: string | null }
  | { type: 'error'; message: string }
  | { type: 'saved' };

/** The host-side effects a settings panel can trigger. */
export interface SettingsActions {
  save(manifest: Manifest): void;
  validate(manifest: Manifest): void;
  requestState(): void;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Narrow an untrusted webview message. Guards only the ENVELOPE — that `manifest`
 * is an object for save/validate. Full manifest validation is `validateManifest`
 * downstream, so a well-formed envelope with a bad manifest still reaches the
 * host (which reports the validation error), while junk shapes are dropped here.
 */
export function parseSettingsMessage(raw: unknown): SettingsWebviewMessage | null {
  if (!isRecord(raw)) return null;
  switch (raw.type) {
    case 'save':
      return isRecord(raw.manifest) ? { type: 'save', manifest: raw.manifest as unknown as Manifest } : null;
    case 'validate':
      return isRecord(raw.manifest) ? { type: 'validate', manifest: raw.manifest as unknown as Manifest } : null;
    case 'request-state':
      return { type: 'request-state' };
    default:
      return null;
  }
}

/** Route an untrusted webview message to the matching action; ignore junk. */
export function routeSettingsAction(raw: unknown, actions: SettingsActions): void {
  const msg = parseSettingsMessage(raw);
  if (!msg) return;
  switch (msg.type) {
    case 'save':
      actions.save(msg.manifest);
      return;
    case 'validate':
      actions.validate(msg.manifest);
      return;
    case 'request-state':
      actions.requestState();
      return;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/ui/settings/messages.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ui/settings/messages.ts src/ui/settings/messages.test.ts
git commit -m "feat(settings): webview message trust boundary + router"
```

---

### Task 4: Settings host actions — validate + save

**Files:**
- Create: `src/ui/settings/actions.ts`
- Test: `src/ui/settings/actions.test.ts`

**Interfaces:**
- Consumes: `Manifest` (`../../manifest/types.js`), `validateManifest` + `ManifestError` (`../../manifest/schema.js`), `SettingsActions` + `SettingsHostMessage` (`./messages.js`), `buildSettingsState` (`./state.js`).
- Produces:
  - `interface SettingsActionsCtx { post(m: SettingsHostMessage): void; manifestPath: string }`
  - `interface SettingsActionsDeps { writeManifest(path: string, m: Manifest): void; reloadManifest(): void; onChange(): void; getManifest(): Manifest }`
  - `type SettingsActionsFactory = (ctx: SettingsActionsCtx) => SettingsActions`
  - `buildSettingsActions(deps: SettingsActionsDeps): SettingsActionsFactory`

**Behavior:**
- `validate(m)`: run `validateManifest(m)`; post `{type:'validation', ok:true, error:null}` on success, `{ok:false, error:message}` on `ManifestError`.
- `save(m)`: run `validateManifest(m)`; on throw post `{type:'error', message}` and DO NOT write. On success: `writeManifest(path, m)` → `reloadManifest()` → `onChange()` → post `{type:'state', state: buildSettingsState(getManifest())}` → post `{type:'saved'}`. Order matters: reload before pushing state so the pushed state reflects disk.
- `requestState()`: post `{type:'state', state: buildSettingsState(getManifest())}`.

- [ ] **Step 1: Write the failing test**

Create `src/ui/settings/actions.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { buildSettingsActions, type SettingsActionsDeps } from './actions.js';
import type { SettingsHostMessage } from './messages.js';
import type { Manifest } from '../../manifest/types.js';

const VALID: Manifest = {
  host: 'localhost',
  portRange: [4000, 4999],
  baselineBranch: 'develop',
  services: {
    api: {
      repoPath: '../api', start: 'npm run dev',
      ports: [{ name: 'http', env: 'PORT', default: 3000 }],
      dependsOn: [], hasMigrations: false, signals: [],
    },
  },
  approaches: [], agents: {}, worktreePathDisplay: 'relative',
};

function harness(overrides: Partial<SettingsActionsDeps> = {}) {
  const posted: SettingsHostMessage[] = [];
  const order: string[] = [];
  let current = VALID;
  const deps: SettingsActionsDeps = {
    writeManifest: (_p, m) => { order.push('write'); current = m; },
    reloadManifest: () => order.push('reload'),
    onChange: () => order.push('change'),
    getManifest: () => current,
    ...overrides,
  };
  const factory = buildSettingsActions(deps);
  const actions = factory({ post: (m) => posted.push(m), manifestPath: '/tmp/karst.yml' });
  return { actions, posted, order };
}

describe('settings actions — validate', () => {
  it('posts ok:true for a valid draft', () => {
    const { actions, posted } = harness();
    actions.validate(VALID);
    expect(posted).toContainEqual({ type: 'validation', ok: true, error: null });
  });

  it('posts ok:false + message for an invalid draft', () => {
    const { actions, posted } = harness();
    actions.validate({ ...VALID, portRange: [9000, 1000] });
    const v = posted.find((m) => m.type === 'validation');
    expect(v).toMatchObject({ type: 'validation', ok: false });
    expect((v as any).error).toMatch(/portRange/);
  });
});

describe('settings actions — save', () => {
  it('writes, reloads, fans out, and re-pushes state + saved (in order)', () => {
    const { actions, posted, order } = harness();
    actions.save({ ...VALID, host: '0.0.0.0' });
    expect(order).toEqual(['write', 'reload', 'change']);
    expect(posted.some((m) => m.type === 'state')).toBe(true);
    expect(posted.some((m) => m.type === 'saved')).toBe(true);
  });

  it('does NOT write an invalid draft; posts an error', () => {
    const { actions, posted, order } = harness();
    actions.save({ ...VALID, portRange: [9000, 1000] });
    expect(order).toEqual([]); // never wrote
    const e = posted.find((m) => m.type === 'error');
    expect((e as any).message).toMatch(/portRange/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/ui/settings/actions.test.ts`
Expected: FAIL — cannot find `./actions.js`.

- [ ] **Step 3: Write minimal implementation**

Create `src/ui/settings/actions.ts`:

```typescript
import type { Manifest } from '../../manifest/types.js';
import { validateManifest, ManifestError } from '../../manifest/schema.js';
import type { SettingsActions, SettingsHostMessage } from './messages.js';
import { buildSettingsState } from './state.js';

/** Per-panel context: how to post to this webview + which file it edits. */
export interface SettingsActionsCtx {
  post(message: SettingsHostMessage): void;
  manifestPath: string;
}

/** Injected host dependencies (real ones bound in extension.ts). */
export interface SettingsActionsDeps {
  writeManifest(path: string, manifest: Manifest): void;
  /** Re-read the manifest from disk into the host's live copy. */
  reloadManifest(): void;
  /** Refresh sidebar + open dashboard/onboarding after a save. */
  onChange(): void;
  /** Read the host's current (post-reload) manifest for state pushes. */
  getManifest(): Manifest;
}

export type SettingsActionsFactory = (ctx: SettingsActionsCtx) => SettingsActions;

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function buildSettingsActions(deps: SettingsActionsDeps): SettingsActionsFactory {
  return (ctx: SettingsActionsCtx): SettingsActions => ({
    validate(manifest: Manifest): void {
      try {
        validateManifest(manifest);
        ctx.post({ type: 'validation', ok: true, error: null });
      } catch (e) {
        if (!(e instanceof ManifestError)) throw e;
        ctx.post({ type: 'validation', ok: false, error: errorMessage(e) });
      }
    },

    save(manifest: Manifest): void {
      try {
        validateManifest(manifest); // guard before touching disk
      } catch (e) {
        if (!(e instanceof ManifestError)) throw e;
        ctx.post({ type: 'error', message: errorMessage(e) });
        return;
      }
      try {
        deps.writeManifest(ctx.manifestPath, manifest);
        deps.reloadManifest(); // refresh host's live copy BEFORE state push
        deps.onChange();
        ctx.post({ type: 'state', state: buildSettingsState(deps.getManifest()) });
        ctx.post({ type: 'saved' });
      } catch (e) {
        ctx.post({ type: 'error', message: errorMessage(e) });
      }
    },

    requestState(): void {
      ctx.post({ type: 'state', state: buildSettingsState(deps.getManifest()) });
    },
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/ui/settings/actions.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ui/settings/actions.ts src/ui/settings/actions.test.ts
git commit -m "feat(settings): host actions — validate + guarded save"
```

---

### Task 5: Settings panel manager — open-on-invalid

**Files:**
- Create: `src/ui/settings/panel.ts`
- Test: `src/ui/settings/panel.test.ts`

**Interfaces:**
- Consumes: `Manifest` (`../../manifest/types.js`), `SettingsHostMessage` (`./messages.js`), `SettingsActions` (`./messages.js`), `routeSettingsAction` (`./messages.js`), `buildSettingsState` (`./state.js`), `SettingsActionsFactory` + `SettingsActionsCtx` (`./actions.js`).
- Produces:
  - `interface SettingsPanel { reveal(): void; postMessage(m: SettingsHostMessage): void; onDidReceiveMessage(h: (m: unknown) => void): void; onDidDispose(h: () => void): void }`
  - `interface SettingsPanelHost { createPanel(title: string): SettingsPanel }`
  - `interface LoadedManifest { manifest: Manifest; error: string | null }` — a valid load has `error:null`; a failed load supplies a best-effort raw manifest + the error string.
  - `class SettingsManager` with `constructor(loadState: () => LoadedManifest, manifestPath: () => string, host: SettingsPanelHost, actionsFactory: SettingsActionsFactory)` and `open(): void`, `isOpen(): boolean`.

**Behavior:** single panel (reveal if already open). On open, read `loadState()`; push `{type:'state', state: buildSettingsState(manifest, error)}` so an invalid manifest still opens with its error shown. Message pump wraps `routeSettingsAction` in try/catch (never die on one bad message). `onDidDispose` drops the panel.

- [ ] **Step 1: Write the failing test**

Create `src/ui/settings/panel.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { SettingsManager, type SettingsPanel, type LoadedManifest } from './panel.js';
import type { SettingsHostMessage } from './messages.js';
import type { Manifest } from '../../manifest/types.js';

const M: Manifest = {
  host: 'localhost', portRange: [4000, 4999], baselineBranch: 'develop',
  services: { api: { repoPath: '../api', start: 'x', ports: [{ name: 'http', env: 'PORT', default: 3000 }], dependsOn: [], hasMigrations: false, signals: [] } },
  approaches: [], agents: {}, worktreePathDisplay: 'relative',
};

class FakePanel implements SettingsPanel {
  posted: SettingsHostMessage[] = [];
  revealed = 0;
  handlers: Array<(m: unknown) => void> = [];
  disposeHandler?: () => void;
  reveal() { this.revealed++; }
  postMessage(m: SettingsHostMessage) { this.posted.push(m); }
  onDidReceiveMessage(h: (m: unknown) => void) { this.handlers.push(h); }
  onDidDispose(h: () => void) { this.disposeHandler = h; }
  emit(m: unknown) { this.handlers.forEach((h) => h(m)); }
}

function make(loaded: LoadedManifest) {
  let panel!: FakePanel;
  const host = { createPanel: () => (panel = new FakePanel()) };
  const mgr = new SettingsManager(
    () => loaded,
    () => '/tmp/karst.yml',
    host,
    (ctx) => ({ save: () => {}, validate: () => {}, requestState: () => ctx.post({ type: 'saved' }) }),
  );
  return { mgr, panel: () => panel };
}

describe('SettingsManager', () => {
  it('opens with a valid manifest and null error', () => {
    const { mgr, panel } = make({ manifest: M, error: null });
    mgr.open();
    const state = panel().posted.find((m) => m.type === 'state') as any;
    expect(state.state.manifest).toEqual(M);
    expect(state.state.error).toBeNull();
    expect(mgr.isOpen()).toBe(true);
  });

  it('opens on an INVALID manifest, surfacing the error', () => {
    const { mgr, panel } = make({ manifest: M, error: 'portRange min exceeds max' });
    mgr.open();
    const state = panel().posted.find((m) => m.type === 'state') as any;
    expect(state.state.error).toBe('portRange min exceeds max');
  });

  it('reveals instead of duplicating when already open', () => {
    const { mgr, panel } = make({ manifest: M, error: null });
    mgr.open();
    mgr.open();
    expect(panel().revealed).toBe(1); // second open revealed the existing panel
  });

  it('routes incoming messages through injected actions without throwing on junk', () => {
    const { mgr, panel } = make({ manifest: M, error: null });
    mgr.open();
    expect(() => panel().emit({ type: 'bogus' })).not.toThrow();
    panel().emit({ type: 'request-state' });
    expect(panel().posted.some((m) => m.type === 'saved')).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/ui/settings/panel.test.ts`
Expected: FAIL — cannot find `./panel.js`.

- [ ] **Step 3: Write minimal implementation**

Create `src/ui/settings/panel.ts`:

```typescript
import type { Manifest } from '../../manifest/types.js';
import {
  routeSettingsAction,
  type SettingsActions,
  type SettingsHostMessage,
} from './messages.js';
import { buildSettingsState } from './state.js';
import type { SettingsActionsFactory } from './actions.js';

/** The subset of a `vscode.WebviewPanel` the manager touches (host-agnostic). */
export interface SettingsPanel {
  reveal(): void;
  postMessage(message: SettingsHostMessage): void;
  onDidReceiveMessage(handler: (message: unknown) => void): void;
  onDidDispose(handler: () => void): void;
}

/** Factory the manager uses to mint a panel (real: `createWebviewPanel`). */
export interface SettingsPanelHost {
  createPanel(title: string): SettingsPanel;
}

/**
 * The manifest to edit + a validation error. A clean load has `error:null`; a
 * broken file supplies a best-effort raw manifest plus the error so the page
 * still opens (fixing a broken manifest is the point of the settings UI).
 */
export interface LoadedManifest {
  manifest: Manifest;
  error: string | null;
}

/**
 * Single settings panel. `open` reveals an existing panel rather than spawning a
 * duplicate; disposal drops it so a later open recreates it. State (manifest +
 * error) is pushed on open; incoming messages route to injected host actions.
 */
export class SettingsManager {
  private panel: SettingsPanel | undefined;

  constructor(
    private readonly loadState: () => LoadedManifest,
    private readonly manifestPath: () => string,
    private readonly host: SettingsPanelHost,
    private readonly actionsFactory: SettingsActionsFactory,
  ) {}

  open(): void {
    if (this.panel) {
      this.panel.reveal();
      return;
    }
    const panel = this.host.createPanel('Karst Settings');
    this.panel = panel;

    const actions: SettingsActions = this.actionsFactory({
      post: (message) => panel.postMessage(message),
      manifestPath: this.manifestPath(),
    });

    panel.onDidReceiveMessage((raw) => {
      try {
        routeSettingsAction(raw, actions);
      } catch (err) {
        // The message pump must never die on one bad message.
        console.error('karst: settings action failed', err);
      }
    });
    panel.onDidDispose(() => (this.panel = undefined));

    const { manifest, error } = this.loadState();
    panel.postMessage({ type: 'state', state: buildSettingsState(manifest, error) });
  }

  isOpen(): boolean {
    return this.panel !== undefined;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/ui/settings/panel.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/ui/settings/panel.ts src/ui/settings/panel.test.ts
git commit -m "feat(settings): panel manager — single panel, open-on-invalid"
```

---

### Task 6: Webview HTML (Option A — accordion cards)

**Files:**
- Create: `src/ui/settings/webview.html`
- Modify: `scripts/copy-assets.mjs` (mirror the new html into `dist/`)
- Test: manual (webview HTML is a runtime asset; logic is covered by Tasks 2–5).

**Interfaces:**
- Consumes host messages: `{type:'state', state}` (initial + post-save), `{type:'validation', ok, error}`, `{type:'error', message}`, `{type:'saved'}`.
- Posts webview messages: `{type:'request-state'}` on load, `{type:'validate', manifest}` on any edit (debounced), `{type:'save', manifest}` on Save click.

- [ ] **Step 1: Confirm the copy-assets pattern**

Read `scripts/copy-assets.mjs` and note how `dashboard/webview.html` and `onboarding/webview.html` are copied. Add `settings/webview.html` to the same list.

Run: `cat scripts/copy-assets.mjs`
Expected: an array/loop of html asset paths to mirror into `dist/`.

- [ ] **Step 2: Create the webview**

Create `src/ui/settings/webview.html` implementing Option A. Requirements:
- Left nav: General · Services · Approaches · Agents (section switch, no reload).
- Top bar: title, dirty dot (shown when the draft differs from the last saved state), **Discard** (reset draft to last state), **Save** (disabled while invalid).
- **General:** inputs for `host`, `portRange[0]`, `portRange[1]`, `baselineBranch`; select for `worktreePathDisplay` (`relative`/`absolute`).
- **Services:** accordion cards per service; each card edits `repoPath`, `start`, `health`, `hasMigrations` (toggle), a `ports[]` table (name/env/default, add/remove rows), a `dependsOn[]` table (target select, port, `bind[]` env+template rows, add/remove), and a `signals[]` chip list. "Add service" / "Remove service" controls.
- **Approaches:** list of `{id, label, recommended}`; add/remove; a single-select recommended.
- **Agents:** role → command rows; add/remove.
- Hold the manifest draft in JS state. On any edit: update the draft, mark dirty, and post `{type:'validate', manifest: draft}` (debounce ~150ms).
- On `{type:'validation', ok, error}`: enable/disable Save; show `error` in a banner when `!ok`.
- On `{type:'state', state}`: replace draft + last-saved baseline, clear dirty, render.
- On `{type:'saved'}`: clear dirty, brief "Saved" confirmation.
- Use the same `acquireVsCodeApi()` message pattern as `dashboard/webview.html`.
- Use VS Code theme CSS variables (`--vscode-*`) as the existing webviews do — do NOT hardcode the mockup palette; that palette was only for the design comparison.

- [ ] **Step 3: Add to copy-assets**

Modify `scripts/copy-assets.mjs` to include `src/ui/settings/webview.html` → `dist/ui/settings/webview.html` (match the existing entries' shape exactly).

- [ ] **Step 4: Verify build copies the asset**

Run: `npm run build`
Expected: build succeeds; `dist/ui/settings/webview.html` exists.

Run: `ls dist/ui/settings/webview.html`
Expected: the file path prints (no error).

- [ ] **Step 5: Commit**

```bash
git add src/ui/settings/webview.html scripts/copy-assets.mjs
git commit -m "feat(settings): accordion-card webview + copy-assets wiring"
```

---

### Task 7: Wire into the extension — command + gear icon

**Files:**
- Modify: `src/extension.ts` (construct `SettingsManager`, register `karst.openSettings`, refactor `reloadManifest` into a shared closure)
- Modify: `package.json` (`commands` + `menus > view/title` contribution for the gear)
- Modify: `src/ui/settings/host.ts` (create — real `SettingsPanelHost` via `createWebviewPanel`, mirroring `src/ui/onboarding/host.ts`)
- Test: manual (activation adapter is the untested host seam by design; logic is covered by Tasks 1–5). A build + typecheck gate stands in for a unit test here.

**Interfaces:**
- Consumes: `SettingsManager`, `SettingsPanelHost`, `LoadedManifest` (`./ui/settings/panel.js`), `buildSettingsActions` (`./ui/settings/actions.js`), `writeManifest` (`./manifest/write.js`), `loadManifest` + `ManifestError` (`./manifest/load.js`), existing `manifestPathOrThrow` / `emptyManifest`.
- Produces: `makeSettingsPanelHost(context): SettingsPanelHost` in `src/ui/settings/host.ts`.

- [ ] **Step 1: Create the real panel host**

Read `src/ui/onboarding/host.ts` first, then create `src/ui/settings/host.ts` following the same shape — a `createWebviewPanel` with `enableScripts:true`, load `webview.html` from the extension dir, return the `SettingsPanel` interface. Match the onboarding host's asset-path resolution exactly.

Run: `npx tsc --noEmit`
Expected: no errors in `host.ts`.

- [ ] **Step 2: Add a shared `loadSettingsState` + refactor `reloadManifest`**

In `src/extension.ts`, add a helper that reads the manifest file for the settings panel, tolerating invalid files:

```typescript
// Load the manifest for the settings page. Unlike resolveManifest (which gates
// on invalid), this ALWAYS returns something to edit: a valid parse, or a raw
// best-effort manifest plus the error so the page opens on a broken file.
const loadSettingsState = (): LoadedManifest => {
  const path = manifestPathOrThrow();
  try {
    return { manifest: loadManifest(path), error: null };
  } catch (e) {
    return {
      manifest: currentManifest ?? emptyManifest(),
      error: e instanceof Error ? e.message : String(e),
    };
  }
};
```

Extract the existing inline `reloadManifest` (currently in the onboarding deps, `extension.ts:99`) into a shared closure so both onboarding and settings use one implementation:

```typescript
const reloadManifest = (): void => {
  if (currentManifestPath) currentManifest = loadManifest(currentManifestPath);
};
```

Replace the onboarding deps' inline `reloadManifest: () => {...}` with `reloadManifest`.

- [ ] **Step 3: Construct SettingsManager + register the command**

In `src/extension.ts`, after the onboarding manager is built:

```typescript
const settings = new SettingsManager(
  loadSettingsState,
  () => manifestPathOrThrow(),
  makeSettingsPanelHost(context),
  buildSettingsActions({
    writeManifest,
    reloadManifest,
    onChange: () => {
      provider.refresh();
      // Re-push any open dashboards so worktree-path display etc. reflect edits.
    },
    getManifest: () => currentManifest ?? emptyManifest(),
  }),
);
```

Add to the `context.subscriptions.push(...)` command list:

```typescript
vscode.commands.registerCommand('karst.openSettings', async () => {
  const manifest = await resolveManifest();
  // resolveManifest returns undefined on no-folder/scaffolded/INVALID. For a
  // missing folder/scaffold we bail (message already shown). For invalid, we
  // still want to open — so only bail when there's no manifest path at all.
  if (manifest) {
    currentManifest = manifest;
    currentManifestPath = manifestPathOrThrow();
  } else {
    // No valid manifest: open on the raw file if a path exists, else bail.
    try {
      currentManifestPath = manifestPathOrThrow();
    } catch {
      return; // no workspace/manifest path — resolveManifest already messaged
    }
  }
  settings.open();
}),
```

Add the imports at the top of `src/extension.ts`:

```typescript
import { SettingsManager, type LoadedManifest } from './ui/settings/panel.js';
import { buildSettingsActions } from './ui/settings/actions.js';
import { makeSettingsPanelHost } from './ui/settings/host.js';
import { writeManifest } from './manifest/write.js';
```

- [ ] **Step 4: Contribute the command + gear icon in package.json**

Read the existing `contributes.commands` and `contributes.menus` in `package.json`. Add:

```jsonc
// contributes.commands += 
{ "command": "karst.openSettings", "title": "Karst: Settings", "icon": "$(gear)" }
```

```jsonc
// contributes.menus["view/title"] += (group navigation, on the karst.tickets view)
{ "command": "karst.openSettings", "when": "view == karst.tickets", "group": "navigation" }
```

Match the exact `when`/`group` conventions already used by `karst.refresh`/`karst.createTicket` if they appear in `view/title`.

- [ ] **Step 5: Typecheck, build, run full suite**

Run: `npm run typecheck`
Expected: no errors.

Run: `npm run build`
Expected: success; `dist/ui/settings/webview.html` present.

Run: `npm test`
Expected: all tests pass (existing + Tasks 1–5).

- [ ] **Step 6: Commit**

```bash
git add src/extension.ts src/ui/settings/host.ts package.json
git commit -m "feat(settings): wire openSettings command + sidebar gear + shared reloadManifest"
```

---

### Task 8: Manual verification in the Extension Dev Host

**Files:** none (verification only).

- [ ] **Step 1: Launch**

Press F5 in VS Code (runs `dev:extension` then launches the Extension Dev Host).

- [ ] **Step 2: Open settings**

Click the gear icon in the Karst sidebar title bar (or run `Karst: Settings` from the command palette). Expected: the settings panel opens showing the current `karst.yml` values across the four sections.

- [ ] **Step 3: Valid edit round-trip**

Change `baselineBranch`, click Save. Expected: "Saved" confirmation; `karst.yml` on disk shows the new value; unknown keys/comments-as-values preserved (comments dropped is expected).

- [ ] **Step 4: Live validation blocks Save**

Set `portRange` min > max. Expected: inline error appears; Save disabled; no write occurs.

- [ ] **Step 5: Open-on-invalid**

Hand-edit `karst.yml` to something invalid (e.g. delete `host`), then open settings. Expected: the panel still opens, shows the validation error, and lets you fix + Save.

- [ ] **Step 6: Record the result**

Note any defects. If all five behaviors pass, the feature is complete.

---

## Self-Review

**Spec coverage:**
- General/Services/Approaches/Agents editable → Task 6 (webview) + Task 2 (state carries full manifest). ✓
- Merge-over-raw writeback preserving unknown keys → Task 1. ✓
- Open-on-invalid → Task 5 (`LoadedManifest.error`) + Task 7 (`loadSettingsState`). ✓
- Live validation, Save disabled while invalid → Task 4 (`validate`) + Task 6 (webview). ✓
- Explicit Save, dirty/Discard → Task 6. ✓
- Command + gear entry → Task 7. ✓
- Shared-manifest refresh after Save → Task 4 (`reloadManifest`→`getManifest`) + Task 7 (shared `reloadManifest`, `onChange`). ✓
- Trust boundary → Task 3 (`parseSettingsMessage`). ✓
- Same validator (no drift) → Tasks 1 & 4 both use `validateManifest`. ✓
- `writeServiceSignals` retained → Task 1 keeps it. ✓

**Type consistency:** `SettingsState`, `SettingsWebviewMessage`, `SettingsHostMessage`, `SettingsActions`, `SettingsActionsDeps`, `SettingsActionsCtx`, `SettingsActionsFactory`, `LoadedManifest`, `SettingsPanel`, `SettingsPanelHost` — each defined once and consumed with matching names across tasks. `buildSettingsState(manifest, error?)` signature consistent in Tasks 2, 4, 5.

**Placeholder scan:** no TBD/TODO; every code step shows full code; the two host-seam tasks (6, 7) are gated by build/typecheck/`npm test` in lieu of unit tests, per the codebase's untested-adapter invariant.
