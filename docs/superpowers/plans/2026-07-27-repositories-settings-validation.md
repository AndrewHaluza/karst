# Repositories Settings Page Validation Rework — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rework the Repositories tab of the settings webview so a fresh/incomplete repository never shows a validation error before the user touches it, required-field violations highlight inline once touched, a repository can be saved as a disabled draft regardless of completeness, any repository (draft or previously-valid) can be toggled disabled, fields carry example placeholders, repo path can be filled by typing or by a native folder picker, and the accordion chevron is a comfortably-sized click target.

**Architecture:** Add a persisted `enabled` boolean to `RepositoryDef` (mirrors the existing `ApproachDef.enabled` / `AgentDef.enabled` pattern). `validateRepository` relaxes "required non-empty" checks for a repository with `enabled === false` (a draft), while still type-checking whatever is present — so an incomplete draft is a *valid* manifest. The whole-graph check skips a disabled repository's own `dependsOn` edges, and rejects an *enabled* repository depending on a disabled one. The settings webview gains: (1) a `touchedFields` set populated on `blur`, used to gate whether a mapped field-level error renders as inline red text vs. staying silent, with the old whole-manifest banner surviving only as a fallback for errors that don't map to one field; (2) an `enabled` pill toggle per repository card, defaulting new repos to disabled; (3) placeholders on every free-text repo/service field; (4) a "Browse…" button beside the repo-path input that round-trips through a new `browse-repo-path` / `repo-path-picked` message pair to a host-side `vscode.window.showOpenDialog`; (5) a bigger chevron with a larger hit area.

**Tech Stack:** TypeScript (manifest layer, Node/vitest), vanilla JS inside `webview.html` (no framework — string-template rendering, tested via regex/string assertions against the raw HTML file per existing `webview.test.ts` convention), `js-yaml` for manifest persistence, VS Code `showOpenDialog` API for the folder picker.

## Global Constraints

- Existing manifests with no `enabled` key on a repository MUST continue to validate exactly as today (`enabled` defaults to `true` — same convention as `ApproachDef.enabled` / `AgentDef.enabled` in `src/manifest/schema.ts:110,138`).
- `writeManifest` MUST keep writing a manifest the loader accepts (re-validates before persisting) — see `CLAUDE.md` "New schema column checklist" / "writeManifest overlay" invariant.
- The webview MUST stay framework-free and self-contained (CSP forbids external assets); all new markup/JS lives in `src/ui/settings/webview.html`.
- Validation display changes MUST NOT weaken the actual gate: `Save` stays disabled whenever `validateManifest` fails, regardless of whether the banner or an inline message is showing.
- Only ONE `ManifestError` is ever active at a time (`validateManifest` throws on first fault) — inline field highlighting is therefore best-effort (highlights the one field the current error names, if any); this is a pre-existing constraint, not something this plan changes.
- Follow `CLAUDE.md`'s "New Manifest field checklist": `types.ts` + `validateManifest` (default it) + `writeManifest` overlay + `manifest/fixtures.ts`.
- Immutable updates: never mutate `draft`/`repo`/`service` objects in place where a spread is straightforward already-used pattern in `webview.html`; existing code already does some in-place mutation on nested arrays (`svcDef.ports = [...]`) — follow the surrounding file's existing style per task, don't unilaterally rewrite it.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/manifest/types.ts` | Add `RepositoryDef.enabled?: boolean`. |
| `src/manifest/validate/repository.ts` | Relax required-field checks when `enabled === false`. |
| `src/manifest/validate/graph.ts` | Skip a disabled repo's own `dependsOn` edges; reject an enabled repo depending on a disabled target. |
| `src/manifest/write.ts` | Persist `enabled` in the repositories overlay. |
| `src/manifest/fixtures.ts` | `repo()` builder gains `enabled` default (`true`, matching current behavior). |
| `src/manifest/load.test.ts` | New `describe('repository enabled / draft')` block. |
| `src/manifest/validate/graph.test.ts` | New cases for disabled-repo dependency skipping. |
| `src/manifest/write.test.ts` / `writeManifest.test.ts` | Round-trip `enabled`. |
| `src/ui/settings/messages.ts` | New `browse-repo-path` (webview→host) / `repo-path-picked` (host→webview) messages. |
| `src/ui/settings/messages.test.ts` | Parse/route tests for the new message pair. |
| `src/ui/settings/actions.ts` | `browseRepoPath` action + `browseForFolder` dep. |
| `src/ui/settings/actions.test.ts` | Test the new action. |
| `src/extension.ts` | Wire `browseForFolder` to `vscode.window.showOpenDialog`. |
| `src/ui/settings/webview.html` | All UX changes: touched-field tracking, inline field errors, enabled toggle, placeholders, browse button, chevron sizing. |
| `src/ui/settings/webview.test.ts` | New assertions for the above. |

---

### Task 1: `RepositoryDef.enabled` — manifest model + relaxed draft validation

**Files:**
- Modify: `src/manifest/types.ts`
- Modify: `src/manifest/validate/repository.ts`
- Modify: `src/manifest/validate/graph.ts`
- Test: `src/manifest/load.test.ts`
- Test: `src/manifest/validate/graph.test.ts`

**Interfaces:**
- Produces: `RepositoryDef.enabled?: boolean` (always concretely `true`/`false` after `validateManifest`, optional on the type only for hand-built fixtures — same convention as `ApproachDef.enabled`).
- Produces: `validateRepository(raw: unknown, name: string): RepositoryDef` — unchanged signature, new behavior.

- [ ] **Step 1: Write the failing tests**

Append to `src/manifest/load.test.ts` (near the `describe('repositories without a service', ...)` block):

```typescript
describe('repository enabled / draft', () => {
  const DRAFT = `
host: localhost
portRange: [4000, 4999]
baselineBranch: develop
repositories:
  scratch:
    repoPath: ""
    enabled: false
`;

  it('accepts a disabled repository with a blank repoPath (draft)', () => {
    const { path, cleanup } = fixture(DRAFT);
    try {
      const repo = loadManifest(path).repositories.scratch!;
      expect(repo.repoPath).toBe('');
      expect(repo.enabled).toBe(false);
    } finally {
      cleanup();
    }
  });

  it('defaults enabled to true when absent (back-compat)', () => {
    const { path, cleanup } = fixture(VALID);
    try {
      expect(loadManifest(path).repositories.backend!.enabled).toBe(true);
    } finally {
      cleanup();
    }
  });

  it('still requires repoPath when enabled is true (or absent)', () => {
    const yaml = DRAFT.replace('enabled: false', 'enabled: true');
    const { path, cleanup } = fixture(yaml);
    try {
      expect(() => loadManifest(path)).toThrow(/repoPath must be a non-empty string/);
    } finally {
      cleanup();
    }
  });

  it('accepts a disabled repository whose service is half-filled', () => {
    const yaml = `${DRAFT}    service:\n      start: ""\n      health: ""\n      ports: []\n      dependsOn: []\n`;
    const { path, cleanup } = fixture(yaml);
    try {
      const repo = loadManifest(path).repositories.scratch!;
      expect(repo.service!.start).toBe('');
      expect(repo.service!.ports).toEqual([]);
    } finally {
      cleanup();
    }
  });

  it('rejects a half-filled service once enabled is true', () => {
    const yaml = `${DRAFT.replace('enabled: false', 'enabled: true')}    service:\n      start: ""\n      ports: []\n      dependsOn: []\n`;
    const { path, cleanup } = fixture(yaml);
    try {
      expect(() => loadManifest(path)).toThrow(/service\.start must be a non-empty string/);
    } finally {
      cleanup();
    }
  });

  it('still rejects a non-string repoPath even when disabled', () => {
    const yaml = DRAFT.replace('repoPath: ""', 'repoPath: 42');
    const { path, cleanup } = fixture(yaml);
    try {
      expect(() => loadManifest(path)).toThrow(/repoPath must be a string/);
    } finally {
      cleanup();
    }
  });
});
```

Append to `src/manifest/validate/graph.test.ts` (read the file first to match its existing fixture-building style — it imports from `../fixtures.js`):

```typescript
describe('validateGraph — disabled repositories', () => {
  it('does not validate a disabled repository\'s own dependsOn edges', () => {
    const repos = {
      draft: repo({
        enabled: false,
        service: svc({ dependsOn: [dependsOn('missing-target', 'http', [])] }),
      }),
    };
    expect(() => validateGraph(repos)).not.toThrow();
  });

  it('rejects an enabled repository depending on a disabled target', () => {
    const repos = {
      api: runnableRepo({
        dependsOn: [dependsOn('worker', 'http', [])],
      }),
      worker: runnableRepo({}, { enabled: false }),
    };
    expect(() => validateGraph(repos)).toThrow(/"worker".*disabled/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/manifest/load.test.ts src/manifest/validate/graph.test.ts`
Expected: FAIL — `enabled` doesn't exist on `RepositoryDef`, draft repoPath/service still throw, disabled-dependency skip doesn't exist.

- [ ] **Step 3: Add `enabled` to the type**

In `src/manifest/types.ts`, inside `RepositoryDef` (after `service?: ServiceDef;`):

```typescript
  /**
   * Whether this repository is used by the system. `false` is the DRAFT state:
   * the settings UI lets an author save an incomplete repository as long as it
   * is disabled, and a saved-valid repository can be toggled off the same way.
   * `validateRepository` relaxes required-field checks when this is `false` —
   * an enabled repository still has to be complete. Always concretely set by
   * `validateRepository` (default `true`, matching `ApproachDef.enabled` /
   * `AgentDef.enabled`); optional on the type only so hand-built fixtures need
   * not supply it.
   */
  enabled?: boolean;
```

- [ ] **Step 4: Relax `validateRepository` / `validateService` for a disabled repo**

In `src/manifest/validate/repository.ts`, add two small strict-aware helpers near the top (after the imports, before `validatePortSlot`):

```typescript
/**
 * A string that is required when `strict` (the repository is enabled), and
 * merely type-checked otherwise — absent/blank normalizes to `''` so a DRAFT
 * repository can leave the field empty without failing validation.
 */
function strictString(v: unknown, where: string, strict: boolean): string {
  if (strict) return requireString(v, where);
  if (v === undefined) return '';
  if (typeof v !== 'string') throw new ManifestError(`${where} must be a string`);
  return v;
}

/** A TCP port when `strict`; merely a well-typed number otherwise (0 = unset). */
function strictPort(v: unknown, where: string, strict: boolean): number {
  if (strict) return requirePort(v, where);
  if (v === undefined) return 0;
  if (typeof v !== 'number' || Number.isNaN(v)) throw new ManifestError(`${where} must be a number`);
  return v;
}

/** An array, non-empty when `strict`; merely array-typed otherwise. */
function strictArray(raw: unknown, where: string, strict: boolean): unknown[] {
  if (!Array.isArray(raw)) throw new ManifestError(`${where} must be an array`);
  if (strict && raw.length === 0) throw new ManifestError(`${where} must be a non-empty array`);
  return raw;
}
```

Thread `strict` through the port/bind/dependsOn/service validators. Replace:

```typescript
function validatePortSlot(raw: unknown, where: string): PortSlot {
  if (!isObject(raw)) throw new ManifestError(`${where} must be an object`);
  return {
    name: requireString(raw.name, `${where}.name`),
    env: requireString(raw.env, `${where}.env`),
    default: requirePort(raw.default, `${where}.default`),
  };
}
```

with:

```typescript
function validatePortSlot(raw: unknown, where: string, strict: boolean): PortSlot {
  if (!isObject(raw)) throw new ManifestError(`${where} must be an object`);
  return {
    name: strictString(raw.name, `${where}.name`, strict),
    env: strictString(raw.env, `${where}.env`, strict),
    default: strictPort(raw.default, `${where}.default`, strict),
  };
}
```

Replace:

```typescript
function validateBind(raw: unknown, where: string): BindVar {
  if (!isObject(raw)) throw new ManifestError(`${where} must be an object`);
  return {
    env: requireString(raw.env, `${where}.env`),
    template: requireString(raw.template, `${where}.template`),
  };
}
```

with:

```typescript
function validateBind(raw: unknown, where: string, strict: boolean): BindVar {
  if (!isObject(raw)) throw new ManifestError(`${where} must be an object`);
  return {
    env: strictString(raw.env, `${where}.env`, strict),
    template: strictString(raw.template, `${where}.template`, strict),
  };
}
```

Replace the `validateDependsOn` body (keep the self-target check — it's a logic invariant, not a completeness requirement, and the UI never produces it):

```typescript
function validateDependsOn(raw: unknown, repo: string, i: number, strict: boolean): DependsOn {
  const where = `repository "${repo}" service.dependsOn[${i}]`;
  if (!isObject(raw)) throw new ManifestError(`${where} must be an object`);

  const bindRaw = strictArray(raw.bind, `${where}.bind`, strict);
  const bind = bindRaw.map((b, bi) => validateBind(b, `${where}.bind[${bi}]`, strict));

  if (strict) {
    assertUnique(
      bind.map((b) => b.env),
      (bi) => `${where}.bind[${bi}]`,
      'env',
    );
  }

  const target = strictString(raw.target, `${where}.target`, strict);
  if (target !== '' && target === repo) {
    throw new ManifestError(
      `${where} targets its own repository "${repo}" — a service cannot depend on itself`,
    );
  }

  return { target, port: strictString(raw.port, `${where}.port`, strict), bind };
}
```

Replace `validateService`:

```typescript
function validateService(raw: unknown, repo: string, strict: boolean): ServiceDef {
  const where = `repository "${repo}" service`;
  if (!isObject(raw)) throw new ManifestError(`${where} must be an object`);

  const portsRaw = strictArray(raw.ports, `${where}.ports`, strict);
  if (strict && portsRaw.length === 0) {
    throw new ManifestError(
      `${where}.ports must be a non-empty array — a declared service needs at least ` +
        `one port. If "${repo}" is not runnable, omit the whole \`service:\` block.`,
    );
  }
  const ports = portsRaw.map((p, i) => validatePortSlot(p, `${where}.ports[${i}]`, strict));

  if (strict) {
    assertUnique(ports.map((p) => p.name), (i) => `${where}.ports[${i}]`, 'name');
    assertUnique(ports.map((p) => p.env), (i) => `${where}.ports[${i}]`, 'env');
  }

  const dependsOnRaw = raw.dependsOn ?? [];
  if (!Array.isArray(dependsOnRaw)) {
    throw new ManifestError(`${where}.dependsOn must be an array`);
  }

  return {
    start: strictString(raw.start, `${where}.start`, strict),
    health: optionalString(raw.health, `${where}.health`),
    ports,
    dependsOn: dependsOnRaw.map((d, i) => validateDependsOn(d, repo, i, strict)),
  };
}
```

Note: the old unconditional `ports.length === 0` throw inside `validateService` doubled as both a strictness AND a shape check — the replacement keeps `strictArray` enforcing array-typing always, and the non-empty message only under `strict`.

Finally, replace `validateRepository`:

```typescript
export function validateRepository(raw: unknown, name: string): RepositoryDef {
  const where = `repository "${name}"`;
  if (!isObject(raw)) throw new ManifestError(`${where} must be an object`);

  assertNoStrayRuntimeFields(raw, name);

  // Draft state: `enabled: false` relaxes required-field checks below so an
  // incomplete repository can still be saved. Absent/anything-but-`false` is
  // enabled — same convention as ApproachDef.enabled / AgentDef.enabled.
  const enabled = raw.enabled !== false;

  const repo: RepositoryDef = {
    repoPath: strictString(raw.repoPath, `${where}.repoPath`, enabled),
    baselineBranch: optionalString(raw.baselineBranch, `${where}.baselineBranch`),
    hasMigrations: raw.hasMigrations === true, // default false
    signals: validateSignals(raw.signals, name),
    enabled,
  };

  return raw.service === undefined
    ? repo
    : { ...repo, service: validateService(raw.service, name, enabled) };
}
```

- [ ] **Step 5: Skip a disabled repo's own dependency edges; reject enabled→disabled edges**

In `src/manifest/validate/graph.ts`, replace `assertDependenciesResolve`:

```typescript
function assertDependenciesResolve(repositories: Record<string, RepositoryDef>): void {
  for (const [name, repo] of Object.entries(repositories)) {
    if (!isRunnable(repo)) continue; // no service, no edges
    if (repo.enabled === false) continue; // draft: not used by the system yet

    for (const [i, dep] of repo.service.dependsOn.entries()) {
      const where = `repository "${name}" service.dependsOn[${i}]`;
      const target = repositories[dep.target];

      if (!target) {
        throw new ManifestError(`${where} targets unknown repository "${dep.target}"`);
      }
      if (!isRunnable(target)) {
        throw new ManifestError(
          `${where} targets "${dep.target}", which declares no service — ` +
            `there is no port to bind to. Give "${dep.target}" a \`service:\` block ` +
            `or drop the dependency.`,
        );
      }
      if (target.enabled === false) {
        throw new ManifestError(
          `${where} targets "${dep.target}", which is disabled — enable it or drop the dependency.`,
        );
      }
      if (!target.service.ports.some((p) => p.name === dep.port)) {
        const slots = target.service.ports.map((p) => p.name).join(', ');
        throw new ManifestError(
          `${where} references port "${dep.port}" on "${dep.target}", ` +
            `which has no such port slot (has: ${slots})`,
        );
      }
    }
  }
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run src/manifest/load.test.ts src/manifest/validate/graph.test.ts`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/manifest/types.ts src/manifest/validate/repository.ts src/manifest/validate/graph.ts src/manifest/load.test.ts src/manifest/validate/graph.test.ts
git commit -m "feat: repositories can be saved disabled/draft with incomplete fields"
```

---

### Task 2: Persist `enabled` through `writeManifest` and test fixtures

**Files:**
- Modify: `src/manifest/write.ts`
- Modify: `src/manifest/fixtures.ts`
- Test: `src/manifest/write.test.ts`
- Test: `src/manifest/writeManifest.test.ts`

**Interfaces:**
- Consumes: `RepositoryDef.enabled` from Task 1.
- Produces: nothing new — `writeManifest` round-trips the field; `repo()` fixture gets an `enabled` override slot.

- [ ] **Step 1: Write the failing test**

`src/manifest/writeManifest.test.ts` has a `fixture(body = RAW)` helper that writes YAML to a temp file and returns `{ path, cleanup }`; every test loads via `loadManifest(path)`, edits the returned `Manifest`, and calls `writeManifest(path, edited)`. Add, inside the existing `describe('writeManifest', ...)` block:

```typescript
it('round-trips a disabled draft repository with a blank repoPath', () => {
  const { path, cleanup } = fixture();
  try {
    const m = loadManifest(path);
    const edited: Manifest = {
      ...m,
      repositories: {
        ...m.repositories,
        scratch: { repoPath: '', hasMigrations: false, signals: [], enabled: false },
      },
    };
    writeManifest(path, edited);
    const after = loadManifest(path);
    expect(after.repositories.scratch!.repoPath).toBe('');
    expect(after.repositories.scratch!.enabled).toBe(false);
  } finally {
    cleanup();
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/manifest/writeManifest.test.ts`
Expected: FAIL — `enabled` is silently dropped on write (repo defaults back to enabled/strict on reload, which throws on the blank `repoPath`).

- [ ] **Step 3: Overlay `enabled` in `writeManifest`**

In `src/manifest/write.ts`, inside the `nextRepos[name] = { ... }` object (the loop over `manifest.repositories`), add the field:

```typescript
    nextRepos[name] = {
      ...rawRepo,
      repoPath: repo.repoPath,
      baselineBranch: repo.baselineBranch,
      hasMigrations: repo.hasMigrations,
      signals: repo.signals ?? [],
      enabled: repo.enabled ?? true,
      service: repo.service
        ? {
            ...rawService,
            start: repo.service.start,
            health: repo.service.health,
            ports: repo.service.ports,
            dependsOn: repo.service.dependsOn,
          }
        : undefined,
    };
```

- [ ] **Step 4: Update the `repo()` fixture builder**

In `src/manifest/fixtures.ts`, `repo()` stays the same signature (callers already pass `{ enabled: false }` via `over`), but confirm the default matches back-compat by NOT setting `enabled` explicitly (undefined → validated as `true` downstream, and fixtures that build raw `RepositoryDef` objects directly — not through `validateRepository` — should also read as enabled by any code checking `repo.enabled !== false`). No code change needed here IF all runtime call sites added in Task 3 check `repo.enabled !== false` rather than `repo.enabled === true`. Add a one-line comment to the existing `repo()` doc-comment noting this:

```typescript
/**
 * A repository. Defaults to NON-RUNNABLE — pass `service: svc()` to make it
 * runnable. That default is deliberate: it makes the non-runnable case the easy
 * one to write, so tests reach for it rather than defaulting every fixture to a
 * process that has to exist. `enabled` defaults to unset (treated as enabled,
 * per `repo.enabled !== false` — the same convention `validateRepository` uses).
 */
export function repo(over: Partial<RepositoryDef> = {}): RepositoryDef {
  return {
    repoPath: '/repo',
    hasMigrations: false,
    ...over,
  };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/manifest/write.test.ts src/manifest/writeManifest.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/manifest/write.ts src/manifest/fixtures.ts src/manifest/writeManifest.test.ts src/manifest/write.test.ts
git commit -m "feat: persist repository enabled flag through writeManifest"
```

---

### Task 3: `browse-repo-path` message pair (webview ⇄ host)

**Files:**
- Modify: `src/ui/settings/messages.ts`
- Test: `src/ui/settings/messages.test.ts`
- Modify: `src/ui/settings/actions.ts`
- Test: `src/ui/settings/actions.test.ts`

**Interfaces:**
- Produces: `SettingsWebviewMessage` variant `{ type: 'browse-repo-path'; name: string }`.
- Produces: `SettingsHostMessage` variant `{ type: 'repo-path-picked'; name: string; path: string }`.
- Produces: `SettingsActions.browseRepoPath(name: string): void`.
- Consumes (new dep): `SettingsActionsDeps.browseForFolder(): Promise<string | undefined>`.

- [ ] **Step 1: Write the failing tests**

In `src/ui/settings/messages.test.ts`, add (matching the file's existing `describe` groupings):

```typescript
describe('browse-repo-path', () => {
  it('parses with a name', () => {
    expect(parseSettingsMessage({ type: 'browse-repo-path', name: 'backend' })).toEqual({
      type: 'browse-repo-path', name: 'backend',
    });
  });

  it('rejects a missing/blank name', () => {
    expect(parseSettingsMessage({ type: 'browse-repo-path' })).toBeNull();
    expect(parseSettingsMessage({ type: 'browse-repo-path', name: '' })).toBeNull();
  });

});
```

In the same file's `describe('routeSettingsAction', ...)` block, its `spies()` helper builds one `SettingsActions & { calls: Record<string, unknown[]> }` stub with a `calls` record pre-populated per action name. Add `browseRepoPath: []` to the `calls` record literal, add `browseRepoPath: (name) => calls['browseRepoPath']!.push(name),` to the returned object, and add a line to the existing `'routes each valid message to its action'` test:

```typescript
    routeSettingsAction({ type: 'browse-repo-path', name: 'backend' }, a);
```

alongside its neighboring `expect(a.calls['xxx']).toEqual([...])` assertions (that test asserts every route at the end — read it fully first and add `expect(a.calls['browseRepoPath']).toEqual(['backend']);` in the same block).

In `src/ui/settings/actions.test.ts`, `harness(overrides)` returns `{ actions, posted, order }` where `posted` collects every `SettingsHostMessage` the actions post via `ctx.post`. Add, near `describe('settings actions — setToken', ...)`:

```typescript
describe('settings actions — browseRepoPath', () => {
  it('posts repo-path-picked when a folder is chosen', async () => {
    const { actions, posted } = harness({
      browseForFolder: async () => '/Users/nd/code/backend',
    });
    await actions.browseRepoPath('backend');
    expect(posted).toContainEqual({
      type: 'repo-path-picked', name: 'backend', path: '/Users/nd/code/backend',
    });
  });

  it('posts nothing when the dialog is cancelled', async () => {
    const { actions, posted } = harness({
      browseForFolder: async () => undefined,
    });
    await actions.browseRepoPath('backend');
    expect(posted).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/ui/settings/messages.test.ts src/ui/settings/actions.test.ts`
Expected: FAIL — `browse-repo-path` unknown to `parseSettingsMessage`/`routeSettingsAction`; `browseRepoPath` doesn't exist on `SettingsActions`.

- [ ] **Step 3: Add the message types and parsing**

In `src/ui/settings/messages.ts`, add to `SettingsWebviewMessage`:

```typescript
  | { type: 'browse-repo-path'; name: string }
```

Add to `SettingsHostMessage`:

```typescript
  | { type: 'repo-path-picked'; name: string; path: string }
```

Add to `SettingsActions`:

```typescript
  /** Open a native folder picker for a repository's repoPath. */
  browseRepoPath(name: string): void;
```

In `parseSettingsMessage`'s switch, add:

```typescript
    case 'browse-repo-path':
      return str('name') ? { type: 'browse-repo-path', name: raw.name as string } : null;
```

In `routeSettingsAction`'s switch, add:

```typescript
    case 'browse-repo-path':
      actions.browseRepoPath(msg.name);
      return;
```

- [ ] **Step 4: Add the dep + action implementation**

In `src/ui/settings/actions.ts`, add to `SettingsActionsDeps` (near `setToken`):

```typescript
  /**
   * Open a native folder picker (host-side) for a repository's repoPath.
   * Resolves the chosen absolute path, or undefined if the user cancelled.
   */
  browseForFolder(): Promise<string | undefined>;
```

Add to the returned actions object (near `setToken`/`clearToken`):

```typescript
      async browseRepoPath(name: string): Promise<void> {
        const path = await deps.browseForFolder();
        if (path === undefined) return; // cancelled — leave the field as-is
        ctx.post({ type: 'repo-path-picked', name, path });
      },
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/ui/settings/messages.test.ts src/ui/settings/actions.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/ui/settings/messages.ts src/ui/settings/messages.test.ts src/ui/settings/actions.ts src/ui/settings/actions.test.ts
git commit -m "feat: wire browse-repo-path host action for the repo-path folder picker"
```

---

### Task 4: Wire the folder picker in `extension.ts`

**Files:**
- Modify: `src/extension.ts`

**Interfaces:**
- Consumes: `SettingsActionsDeps.browseForFolder` from Task 3.

- [ ] **Step 1: Add the dep to the `buildSettingsActions({...})` call**

In `src/extension.ts`, inside the `buildSettingsActions({ ... })` object literal (near `setToken`/`clearToken`, around line 775), add:

```typescript
      // Native folder picker for a repository's repoPath (§ settings). No
      // validation here — whatever the user picks is just text in the field,
      // same as typing it; validateManifest is still the authority.
      browseForFolder: async (): Promise<string | undefined> => {
        const uris = await vscode.window.showOpenDialog({
          canSelectFolders: true,
          canSelectFiles: false,
          canSelectMany: false,
          openLabel: 'Select repository folder',
        });
        return uris?.[0]?.fsPath;
      },
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: no new errors (this file isn't covered by vitest since it imports `vscode`, per `CLAUDE.md`'s "`vscode`-importing modules don't load under vitest" note — typecheck is the verification here).

- [ ] **Step 3: Commit**

```bash
git add src/extension.ts
git commit -m "feat: implement browseForFolder via vscode.window.showOpenDialog"
```

---

### Task 5: Webview — touched-field tracking + inline field errors (replaces premature banner)

**Files:**
- Modify: `src/ui/settings/webview.html`
- Test: `src/ui/settings/webview.test.ts`

This is the task that fixes the literal bug: "Fresh new repository shows an error." A brand-new draft repo's `repoPath` is required-but-blank; today that immediately renders the whole-page error banner. After this task, the banner is suppressed for any error that maps to one specific field UNTIL that field has been touched (focused then blurred) — and once touched, the error shows as a small inline message under that exact field instead of a page-wide banner. Errors that don't map to a known field (structural/graph errors) keep showing the banner unconditionally, since there's no better place to put them.

**Interfaces:**
- Consumes: nothing new from other tasks (pure webview JS/CSS/HTML).
- Produces: globals `touchedFields` (Set<string>), `lastValidationError` (string|null), functions `parseRepoFieldError(msg)`, `applyFieldValidationUI(msg)`, `shouldShowBanner(msg)` — used by later tasks (Task 6 sets `data-touch-key` on the enabled toggle's neighbors is NOT needed; Task 7 relies on `applyFieldValidationUI` being re-callable after `renderServices()`).

- [ ] **Step 1: Write the failing tests**

Add to `src/ui/settings/webview.test.ts`:

```typescript
describe('repository field validation UX', () => {
  it('tracks touched fields via a blur listener', () => {
    expect(HTML).toContain('touchedFields');
    expect(HTML).toMatch(/addEventListener\('blur',[\s\S]{0,200}true\)/); // capture phase
  });

  it('parses a repoPath error to a repo/field key', () => {
    const fn = HTML.match(/function parseRepoFieldError\(msg\)\s*{([\s\S]*?)\n {2}}/);
    expect(fn, 'parseRepoFieldError not found').toBeTruthy();
    expect(fn![1]).toContain('repoPath');
    expect(fn![1]).toContain('service\\.(start|health)');
  });

  it('suppresses the banner for an untouched mapped field error', () => {
    expect(HTML).toContain('function shouldShowBanner(');
    expect(HTML).toContain('touchedFields.has(parsed.key)');
  });

  it('renders an inline field-error line and a browse button next to repoPath', () => {
    expect(HTML).toContain('data-field-error="${esc(name)}.repoPath"');
    expect(HTML).toContain('data-browse-repo-path="${esc(name)}"');
    expect(HTML).toContain('data-touch-key="${esc(name)}.repoPath"');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/ui/settings/webview.test.ts`
Expected: FAIL — none of this markup/JS exists yet.

- [ ] **Step 3: Add state + helper functions**

In `webview.html`, find the top-of-script state declarations (near where `openCards`, `dirty`, `valid`, `validateTimer` are declared — search for `let dirty` / `const openCards`). Add alongside them:

```javascript
  const touchedFields = new Set(); // keys like "backend.repoPath", "backend.start"
  let lastValidationError = null;
```

Directly after the `updateSaveEnabled` function (or any other single-purpose helper near the top), add the parsing/gating helpers:

```javascript
  // Maps a single ManifestError string to the one repo field it names, if any.
  // validateManifest throws on the FIRST fault, so only one field is ever
  // mappable at a time — this is a display concern layered on top of that
  // existing single-error architecture, not a change to it.
  function parseRepoFieldError(msg) {
    if (!msg) return null;
    let m = msg.match(/^repository "([^"]+)"\.(repoPath|baselineBranch)\b/);
    if (m) return { key: m[1] + '.' + m[2] };
    m = msg.match(/^repository "([^"]+)" service\.(start|health)\b/);
    if (m) return { key: m[1] + '.' + m[2] };
    m = msg.match(/^repository "([^"]+)" service\.ports\[(\d+)\]\.(name|env|default)\b/);
    if (m) return { key: m[1] + '.ports.' + m[2] + '.' + m[3] };
    return null;
  }

  // A mapped error stays silent (no banner, no highlight) until the user has
  // touched that exact field — this is what stops a freshly-added repository
  // from showing an error before anyone has typed anything. An error that
  // doesn't map to one field always shows the banner (no better place for it).
  function shouldShowBanner(msg) {
    const parsed = parseRepoFieldError(msg);
    if (!parsed) return Boolean(msg);
    return touchedFields.has(parsed.key);
  }

  function clearFieldErrorUI() {
    document.querySelectorAll('[data-field-error]').forEach((el) => {
      el.textContent = '';
      el.classList.add('hidden');
    });
    document.querySelectorAll('[data-touch-key]').forEach((el) => el.removeAttribute('aria-invalid'));
  }

  // Re-applies the current single validation error as an inline field message,
  // if it maps to a field AND that field has been touched. Safe to call after
  // any renderServices() rebuild, since it re-queries the DOM by data attribute
  // rather than holding element references.
  function applyFieldValidationUI(msg) {
    clearFieldErrorUI();
    const parsed = parseRepoFieldError(msg);
    if (!parsed || !touchedFields.has(parsed.key)) return;
    const input = document.querySelector('[data-touch-key="' + CSS.escape(parsed.key) + '"]');
    if (input) input.setAttribute('aria-invalid', 'true');
    const line = document.querySelector('[data-field-error="' + CSS.escape(parsed.key) + '"]');
    if (line) { line.textContent = msg; line.classList.remove('hidden'); }
  }
```

- [ ] **Step 4: Wire the blur listener (touch tracking)**

Near the existing `document.addEventListener('input', (e) => { ... })` delegation, add a new delegated listener. Blur does not bubble, so this MUST use the capture-phase `true` third argument:

```javascript
  document.addEventListener('blur', (e) => {
    const t = e.target;
    if (!t || !t.dataset || !t.dataset.touchKey) return;
    touchedFields.add(t.dataset.touchKey);
    applyFieldValidationUI(lastValidationError);
    showError(shouldShowBanner(lastValidationError) ? lastValidationError : null);
  }, true);
```

- [ ] **Step 5: Add `data-touch-key` + inline error line to the repoPath and start fields**

In `renderServiceCard`, replace the repo-path line:

```javascript
      + `<label>Repo path</label>`
      + `<input type="text" data-svc-field="repoPath" data-svc="${esc(name)}" value="${esc(repo.repoPath)}"/>`
```

with (also adds the Task 3 browse button and Task 7 placeholder hook — placeholder text finalized in Task 7, stub it here so this task's tests can assert the button/error-line landed):

```javascript
      + `<label>Repo path</label>`
      + `<div class="row">`
      + `<input type="text" placeholder="/Users/you/code/${esc(name)}" data-svc-field="repoPath" data-svc="${esc(name)}" data-touch-key="${esc(name)}.repoPath" value="${esc(repo.repoPath)}"/>`
      + `<button type="button" class="secondary icon fixed" data-browse-repo-path="${esc(name)}" title="Browse for a folder">Browse&hellip;</button>`
      + `</div>`
      + `<div class="field-error hidden" data-field-error="${esc(name)}.repoPath"></div>`
```

And the start-command line:

```javascript
          + `<label>Start command</label>`
          + `<input type="text" data-svc-field="start" data-svc="${esc(name)}" value="${esc(svc.start || '')}"/>`
```

becomes:

```javascript
          + `<label>Start command</label>`
          + `<input type="text" placeholder="npm run dev" data-svc-field="start" data-svc="${esc(name)}" data-touch-key="${esc(name)}.start" value="${esc(svc.start || '')}"/>`
          + `<div class="field-error hidden" data-field-error="${esc(name)}.start"></div>`
```

- [ ] **Step 6: Call `applyFieldValidationUI` after every structural re-render**

At the end of `renderServices()` (after `el('serviceCards').innerHTML = ...`), add:

```javascript
    applyFieldValidationUI(lastValidationError);
```

Also add it right after the `if (!names.length) { ...; return; }` early-return branch's `return` — actually simplest: add one line right before the function's final closing brace so it runs on both paths. Read the current `renderServices()` body (shown earlier in this plan's research) and place the call as the last statement, after the `.map(...).join('')` assignment, NOT inside the early-return branch (an empty list has nothing to apply to, but calling it is harmless — `clearFieldErrorUI` is a no-op on an empty DOM query).

- [ ] **Step 7: Replace the two validation-message handlers to use `shouldShowBanner`/`applyFieldValidationUI`**

In the `case 'state':` handler, replace:

```javascript
        valid = !msg.state.error;
        updateSaveEnabled();
        showError(msg.state.error);
```

with:

```javascript
        valid = !msg.state.error;
        updateSaveEnabled();
        lastValidationError = msg.state.error;
        showError(shouldShowBanner(msg.state.error) ? msg.state.error : null);
```

(leave `applyFieldValidationUI`'s call to happen via `renderAll()` → `renderServices()` from Step 6, since `case 'state'` already calls `renderAll()` right after.)

In the `case 'validation':` handler, replace:

```javascript
      case 'validation': {
        valid = msg.ok;
        updateSaveEnabled();
        showError(msg.ok ? null : msg.error);
        showConventionValidation(msg.ok ? null : msg.error);
        break;
      }
```

with:

```javascript
      case 'validation': {
        valid = msg.ok;
        updateSaveEnabled();
        lastValidationError = msg.ok ? null : msg.error;
        showError(shouldShowBanner(lastValidationError) ? lastValidationError : null);
        showConventionValidation(msg.ok ? null : msg.error);
        applyFieldValidationUI(lastValidationError);
        break;
      }
```

- [ ] **Step 8: Handle `repo-path-picked` (Task 3's response) and the browse-button click**

In the same `switch (msg.type)` block, add a case:

```javascript
      case 'repo-path-picked': {
        if (draft.repositories[msg.name]) {
          draft.repositories[msg.name].repoPath = msg.path;
          const input = document.querySelector(
            'input[data-svc-field="repoPath"][data-svc="' + CSS.escape(msg.name) + '"]',
          );
          if (input) input.value = msg.path;
          touchedFields.add(msg.name + '.repoPath');
          markDirty();
        }
        break;
      }
```

In the existing `document.addEventListener('click', (e) => { ... })` delegation, near the other `t.dataset.xxx` branches, add:

```javascript
    if (t.dataset.browseRepoPath) {
      post({ type: 'browse-repo-path', name: t.dataset.browseRepoPath });
      return;
    }
```

- [ ] **Step 9: Run tests to verify they pass**

Run: `npx vitest run src/ui/settings/webview.test.ts`
Expected: PASS. Also run the full suite once to catch regressions in neighboring settings tests: `npx vitest run src/ui/settings/`

- [ ] **Step 10: Commit**

```bash
git add src/ui/settings/webview.html src/ui/settings/webview.test.ts
git commit -m "feat: gate repo validation errors on touched fields, add inline field errors"
```

---

### Task 6: Webview — repository `enabled` toggle, draft defaults, and CSS

**Files:**
- Modify: `src/ui/settings/webview.html`
- Test: `src/ui/settings/webview.test.ts`

**Interfaces:**
- Consumes: `RepositoryDef.enabled` (Task 1), `applyFieldValidationUI`/`touchedFields` (Task 5, for correctness only — no new coupling needed here beyond calling `markDirty()`).

- [ ] **Step 1: Write the failing tests**

```typescript
describe('repository enabled toggle', () => {
  it('new repositories default to disabled (draft)', () => {
    const fn = HTML.match(/el\('addServiceBtn'\)\.addEventListener\('click', \(\) => {([\s\S]*?)\n {2}}\);/);
    expect(fn, 'addServiceBtn handler not found').toBeTruthy();
    expect(fn![1]).toContain('enabled: false');
  });

  it('renders an enabled pill toggle per repository card', () => {
    expect(HTML).toContain('data-repo-enabled="${esc(name)}"');
    expect(HTML).toContain('approach-toggle'); // reuses the existing pill style
  });

  it('shows a Draft label when a repository is disabled', () => {
    expect(HTML).toContain("repo.enabled === false");
    expect(HTML).toContain('Draft');
  });

  it('flips draft.repositories[name].enabled on toggle click', () => {
    expect(HTML).toContain('t.dataset.repoEnabled');
    expect(HTML).toMatch(/draft\.repositories\[name\]\.enabled\s*=\s*t\.checked/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/ui/settings/webview.test.ts`
Expected: FAIL.

- [ ] **Step 3: Default new repositories to disabled**

In `el('addServiceBtn').addEventListener('click', ...)`, change:

```javascript
    draft.repositories = { ...draft.repositories, [name]: {
      repoPath: '', hasMigrations: false, signals: [],
    } };
```

to:

```javascript
    // Draft: disabled by default. The author fills in required fields at
    // their own pace and flips it on when ready — never used by the system
    // (ticket scoping, classification) while disabled.
    draft.repositories = { ...draft.repositories, [name]: {
      repoPath: '', hasMigrations: false, signals: [], enabled: false,
    } };
```

- [ ] **Step 4: Render the enabled toggle + Draft label in the card header**

In `renderServiceCard`, the card-head currently is:

```javascript
    return `<div class="card ${isOpen ? 'open' : ''}" data-card="${esc(name)}">`
      + `<div class="card-head" data-toggle="${esc(name)}">`
      + `<span class="chevron">&#9656;</span>`
      + `<span class="card-title">${esc(name)}</span>`
      + (svc ? '' : `<span class="field-hint" style="margin:0 0 0 8px">no service</span>`)
      + `<button class="secondary icon" data-remove-service="${esc(name)}">Remove</button>`
      + `</div>`
```

Replace with (the enabled toggle sits before Remove; clicking it must NOT trigger the accordion toggle, so it's excluded the same way `data-svc-name` already is — see Step 5):

```javascript
    const isEnabled = repo.enabled !== false;
    return `<div class="card ${isOpen ? 'open' : ''}" data-card="${esc(name)}">`
      + `<div class="card-head" data-toggle="${esc(name)}">`
      + `<span class="chevron">&#9656;</span>`
      + `<span class="card-title">${esc(name)}</span>`
      + (isEnabled ? '' : `<span class="chip">Draft</span>`)
      + (svc ? '' : `<span class="field-hint" style="margin:0 0 0 8px">no service</span>`)
      + `<label class="approach-toggle" title="${isEnabled ? 'Disable this repository' : 'Enable this repository'}">`
      + `<input type="checkbox" data-repo-enabled="${esc(name)}" ${isEnabled ? 'checked' : ''}/>`
      + `<span class="dot"></span>`
      + `</label>`
      + `<button class="secondary icon" data-remove-service="${esc(name)}">Remove</button>`
      + `</div>`
```

- [ ] **Step 5: Handle the toggle click (before the accordion-toggle fallback)**

In the `document.addEventListener('click', (e) => { ... })` delegation, add a branch BEFORE the final accordion-toggle block (which already special-cases `data-svc-name`; add this one the same way, alongside `t.dataset.runnable`):

```javascript
    if (t.dataset.repoEnabled) {
      const name = t.dataset.repoEnabled;
      draft.repositories[name] = { ...draft.repositories[name], enabled: t.checked };
      markDirty(); renderServices();
      return;
    }
```

And make sure the accordion-toggle fallback at the bottom of the handler doesn't also fire for this control — it currently only excludes `t.dataset.svcName === undefined` as its guard condition; since the checkbox has `data-repo-enabled` (not `data-svc-name`) it would otherwise fall through to `t.closest('[data-toggle]')` and ALSO toggle the accordion. The early `return` in the new branch above already prevents this (the branch runs first and returns), so no change to the fallback itself is needed — just confirm this new branch is placed ahead of it in source order, matching where `t.dataset.runnable` (a similar checkbox-inside-card-head case... actually `runnable` is in the card BODY, not the head — the repo-enabled toggle is the first checkbox-in-card-HEAD case). Double check by testing manually in Task 8.

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run src/ui/settings/webview.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/ui/settings/webview.html src/ui/settings/webview.test.ts
git commit -m "feat: add repository enabled/draft toggle to the settings accordion"
```

---

### Task 7: Webview — placeholders on remaining repo/service fields

**Files:**
- Modify: `src/ui/settings/webview.html`
- Test: `src/ui/settings/webview.test.ts`

**Interfaces:** none new — pure markup.

- [ ] **Step 1: Write the failing test**

```typescript
describe('repository field placeholders', () => {
  it('gives every free-text repo/service field an example placeholder', () => {
    expect(HTML).toContain('placeholder="/Users/you/code/${esc(name)}"'); // repoPath, from Task 5
    expect(HTML).toContain('placeholder="npm run dev"'); // start, from Task 5
    expect(HTML).toContain('placeholder="http://{host}:{port}/health"'); // health
    expect(HTML).toContain('placeholder="http"'); // port name
    expect(HTML).toContain('placeholder="PORT"'); // port env
    expect(HTML).toContain('placeholder="3000"'); // port default
    expect(HTML).toContain('placeholder="my-repo"'); // repo name field
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/ui/settings/webview.test.ts`
Expected: FAIL (health/ports/name placeholders don't exist yet).

- [ ] **Step 3: Add the remaining placeholders**

In `renderServiceCard`, the health input:

```javascript
          + `<label>Health check</label>`
          + `<input type="text" data-svc-field="health" data-svc="${esc(name)}" value="${esc(svc.health || '')}"/>`
```

becomes:

```javascript
          + `<label>Health check</label>`
          + `<input type="text" placeholder="http://{host}:{port}/health" data-svc-field="health" data-svc="${esc(name)}" value="${esc(svc.health || '')}"/>`
```

The repository name input:

```javascript
      + `<label>Name</label>`
      + `<input type="text" data-svc-name="${esc(name)}" value="${esc(name)}"/>`
```

becomes:

```javascript
      + `<label>Name</label>`
      + `<input type="text" placeholder="my-repo" data-svc-name="${esc(name)}" value="${esc(name)}"/>`
```

In `renderPortsTable`, the three `<td><input ...>` cells:

```javascript
      + `<td><input type="text" data-port-field="name" data-svc="${esc(svcName)}" data-idx="${i}" value="${esc(p.name)}"/></td>`
      + `<td><input type="text" data-port-field="env" data-svc="${esc(svcName)}" data-idx="${i}" value="${esc(p.env)}"/></td>`
      + `<td><input type="number" data-port-field="default" data-svc="${esc(svcName)}" data-idx="${i}" value="${esc(p.default)}"/></td>`
```

become:

```javascript
      + `<td><input type="text" placeholder="http" data-port-field="name" data-svc="${esc(svcName)}" data-idx="${i}" value="${esc(p.name)}"/></td>`
      + `<td><input type="text" placeholder="PORT" data-port-field="env" data-svc="${esc(svcName)}" data-idx="${i}" value="${esc(p.env)}"/></td>`
      + `<td><input type="number" placeholder="3000" data-port-field="default" data-svc="${esc(svcName)}" data-idx="${i}" value="${esc(p.default)}"/></td>`
```

The baseline-branch override input:

```javascript
      + `<input type="text" data-svc-field="baselineBranch" data-svc="${esc(name)}" value="${esc(repo.baselineBranch || '')}"/>`
```

becomes:

```javascript
      + `<input type="text" placeholder="main" data-svc-field="baselineBranch" data-svc="${esc(name)}" value="${esc(repo.baselineBranch || '')}"/>`
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/ui/settings/webview.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ui/settings/webview.html src/ui/settings/webview.test.ts
git commit -m "feat: add example placeholders to repository/service fields"
```

---

### Task 8: Webview — bigger chevron + a generic `aria-invalid` border rule

**Files:**
- Modify: `src/ui/settings/webview.html`
- Test: `src/ui/settings/webview.test.ts`

**Interfaces:** none new — pure CSS.

- [ ] **Step 1: Write the failing test**

```typescript
describe('chevron and invalid-field styling', () => {
  it('renders the chevron at a comfortably clickable size', () => {
    const m = HTML.match(/\.card \.card-head \.chevron\{([^}]*)\}/);
    expect(m, '.card .card-head .chevron rule not found').toBeTruthy();
    expect(m![1]).toMatch(/font-size:1[4-9]px/); // at least 14px, up from 10px
  });

  it('applies the error border to any invalid field, not just convention fields', () => {
    expect(HTML).toMatch(/input\[aria-invalid="true"\][^{]*\{[^}]*border-color/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/ui/settings/webview.test.ts`
Expected: FAIL.

- [ ] **Step 3: Bump the chevron size and hit area**

Replace:

```css
  .card .card-head{
    display:flex;align-items:center;gap:10px;padding:10px 14px;cursor:pointer;
    user-select:none;
  }
  .card .card-head:hover{background:var(--vscode-list-hoverBackground)}
  .card .card-head .chevron{font-size:10px;opacity:.6;transition:transform .1s}
  .card.open .card-head .chevron{transform:rotate(90deg)}
```

with:

```css
  .card .card-head{
    display:flex;align-items:center;gap:10px;padding:10px 14px;cursor:pointer;
    user-select:none;
  }
  .card .card-head:hover{background:var(--vscode-list-hoverBackground)}
  /* Bigger than the old 10px — a chevron this small was hard to see/hit as the
     open/close affordance for a whole card. */
  .card .card-head .chevron{
    font-size:16px;opacity:.7;transition:transform .1s;
    display:inline-flex;align-items:center;justify-content:center;
    width:20px;height:20px;flex:none;
  }
  .card.open .card-head .chevron{transform:rotate(90deg)}
```

- [ ] **Step 4: Generalize the invalid-field border**

Replace:

```css
  .convention-control[aria-invalid="true"]{
    border-color:var(--vscode-inputValidation-errorBorder,var(--vscode-errorForeground))}
```

with:

```css
  .convention-control[aria-invalid="true"],
  input[aria-invalid="true"],select[aria-invalid="true"]{
    border-color:var(--vscode-inputValidation-errorBorder,var(--vscode-errorForeground))}
  /* Inline per-field validation message (repo cards; see applyFieldValidationUI). */
  .field-error{color:var(--vscode-errorForeground);font-size:11px;margin-top:5px}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/ui/settings/webview.test.ts`
Expected: PASS. Then run the whole settings suite once more: `npx vitest run src/ui/settings/`

- [ ] **Step 6: Commit**

```bash
git add src/ui/settings/webview.html src/ui/settings/webview.test.ts
git commit -m "style: bigger chevron hit target, generic invalid-field border"
```

---

### Task 9: Full-suite verification + manual smoke test

**Files:** none (verification only).

- [ ] **Step 1: Run the full test suite**

Run: `npm test`
Expected: all tests pass, including everything touched above plus the pre-existing suite (resolver/scope/preflight/spin tests that build manifests via `fixtures.ts` must still pass since `enabled` defaults to the old behavior everywhere it isn't explicitly set).

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 3: Manual smoke test in the Extension Dev Host**

Per `CLAUDE.md`: F5 runs `dev:extension` (build + `rebuild:electron`) then launches the Extension Dev Host. In the launched window:
1. Open Settings → Repositories tab.
2. Click "+ Add repository" — confirm NO error banner appears, the card shows a "Draft" chip, and the enabled toggle is off.
3. Type a few characters into Repo path then delete them back to blank, then blur (click elsewhere) — confirm an inline red message now appears under Repo path (not a page banner), and Save stays disabled.
4. Click "Browse…" next to Repo path — confirm the native folder picker opens, and picking a folder fills the field.
5. Flip the repository's enabled toggle on with Repo path still blank — confirm Save is now blocked with a page banner (no field to map it to changes since repoPath IS the mapped field — confirm behavior matches: once enabled+touched, the inline message should already be visible from step 3; re-verify it stays consistent).
6. Fill in a valid repoPath, flip enabled on — confirm Save enables and the draft/inline errors clear.
7. Save, then click the enabled toggle off on the now-valid repository — confirm it saves successfully as disabled (no validation error) and shows the Draft chip again.
8. Confirm the accordion chevron is visibly bigger and easy to click.
9. Confirm placeholder text (e.g. `/Users/you/code/<name>`, `npm run dev`, `http`, `PORT`, `3000`, `main`) shows in empty fields.

- [ ] **Step 4: Report results**

No commit — this task is verification only. If step 3 surfaces a real bug, fix it as a follow-up commit against the relevant task above (don't silently patch without updating that task's tests).

---

## Self-Review Notes (for whoever executes this plan)

- **Spec coverage:** "fresh repo shows error" → Task 5/6 (draft defaults + touched-gating). "highlight once touched" → Task 5. "save draft, disabled until enabled" → Task 1 (validation relax) + Task 6 (toggle + default). "draft == always disabled" → Task 6 (no separate draft flag, `enabled` IS the state). "valid repo can also be disabled via toggler" → Task 6 (same toggle, no special-casing by validity). "placeholders" → Task 5 (repoPath/start) + Task 7 (the rest). "repo path 2nd variant via button + folder nav" → Task 3/4 (host wiring) + Task 5 (button + response handling). "chevron too small" → Task 8.
- **Not in scope (explicitly, per the "Global Constraints" single-error note and the plan's design discussion):** aggregating multiple simultaneous `ManifestError`s so more than one field can be highlighted at once; excluding disabled repositories from the onboarding repo-classifier/ticket-scoping candidate list (a real "not used by the system" gap beyond the settings page itself — flag this to the user as a likely fast-follow, since `src/ui/onboarding/state.ts:148`'s `repoEntries` currently lists every repository regardless of `enabled`).
