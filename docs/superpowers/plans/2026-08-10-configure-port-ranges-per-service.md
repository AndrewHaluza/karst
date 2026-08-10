# Configure Per-Service Port Ranges Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an operator declare an optional `[min, max]` port window per runnable service in `karst.yml`, so ticket-hot port allocation honors that service's boundaries instead of always using the manifest-global `portRange`.

**Architecture:** The range is manifest configuration (`ServiceDef.portRange?: [number, number]`), never persisted state — `port_allocations` already stores allocation *results*. The allocator (`src/resolver/allocator.ts`) already hands out one contiguous block per service from a parameterized window (`findContiguous`), so the change is: (1) parse+validate the new field, (2) let `allocate` take an optional per-call range (falling back to the allocator's construction range), (3) have `resolve.ts` pass `service.portRange ?? manifest.portRange`, (4) overlay the field in `writeManifest`, (5) edit it in the Settings Repositories tab.

**Tech Stack:** TypeScript (ESM, `.js` import suffixes), vitest, better-sqlite3 in-memory stores for tests, js-yaml.

## Global Constraints

- No schema change, no migration: ranges are manifest config; `port_allocations`/`servers` tables are untouched. `SCHEMA_VERSION` stays 33.
- **The only production call site of `PortAllocator.allocate` is `src/resolver/resolve.ts:101`** — every other `makePortAllocator` construction (archive paths in `extension.ts`) only ever calls `release`. Do not add allocate call sites.
- A per-service range is an OVERRIDE of the global range, never a containment check: the global `portRange` becomes the default, and a service range may deliberately sit outside it (e.g. a service needing the 3000s while the global window is 4000–4100). Collisions between overlapping windows are already impossible: the allocator's shared `used` set reads every row of `port_allocations` and `UNIQUE(port)` is the DB-level guard. Do NOT add a containment validation.
- `PortRangeExhaustedError` must name the service when the range came from a per-call override — with per-service windows, "which service ran out" is no longer obvious.
- New-field checklist applies to `ServiceDef.portRange`: `src/manifest/types.ts` + `src/manifest/validate/repository.ts` (validated via `validateService` — NOT `schema.ts`, which never sees nested service fields; `health`/`ports` are the precedent) + `writeManifest` overlay (`src/manifest/write.ts`) or Save silently drops it. Guard test: `writeManifest.test.ts` "round-trips every modeled section".
- A `portRange:` at repository level (outside `service:`) is a stray runtime field → add `'portRange'` to `RUNTIME_FIELDS` so it fails loudly like `start`/`ports` already do.
- Draft repositories (`enabled: false`) may save an incomplete range: validate shape only (`[0, 0]` is legal in draft), same relaxation `strictPort` gives `default: 0`.
- Do NOT touch `docs/plans/001-architecture.md` or `docs/superpowers/specs/…` — dated design records, never rewritten. Docs changes are `karst.example.yml` + `docs/config-ui-coverage.md` only.
- ESM: imports carry `.js`; `noUncheckedIndexedAccess` is on (array access needs `!` or a guard); keep files < 400 lines.
- All tests: `npx vitest run <file>` for a single file, `npm test` for the full suite. Typecheck: `npm run typecheck`.

---

### Task 1: `ServiceDef.portRange` — manifest type + validation

**Files:**
- Modify: `src/manifest/types.ts:37-42` (ServiceDef)
- Modify: `src/manifest/validate/repository.ts:29` (RUNTIME_FIELDS), `:57-64` (add `validatePortRange`), `:108-145` (validateService)
- Test: `src/manifest/load.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `ServiceDef.portRange?: [number, number]` — present = allocation window for this service; absent = inherit the manifest-global `portRange`. Validation error `where` strings start with `repository "<name>" service.portRange …` (the settings webview's error anchor depends on this exact prefix).

- [ ] **Step 1: Write the failing validation tests**

Add to `src/manifest/load.test.ts`, after the existing `portRange` describe block (~line 193). All YAML edits target the `VALID` fixture whose `backend` service ends with `      dependsOn: []` (6-space indent, unique in the file):

```ts
describe('per-service portRange', () => {
  it('reads an optional per-service portRange from the manifest', () => {
    const yaml = VALID.replace(
      '      dependsOn: []\n',
      '      portRange: [5000, 5100]\n      dependsOn: []\n',
    );
    const { path, cleanup } = fixture(yaml);
    try {
      expect(loadManifest(path).repositories.backend!.service!.portRange).toEqual([5000, 5100]);
    } finally {
      cleanup();
    }
  });

  it('defaults service.portRange to undefined when absent', () => {
    const { path, cleanup } = fixture(VALID);
    try {
      expect(loadManifest(path).repositories.backend!.service!.portRange).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  it('throws when service.portRange is not a [min, max] number pair', () => {
    const yaml = VALID.replace(
      '      dependsOn: []\n',
      '      portRange: 5000\n      dependsOn: []\n',
    );
    const { path, cleanup } = fixture(yaml);
    try {
      expect(() => loadManifest(path)).toThrow(/service\.portRange must be a \[min, max\] number pair/);
    } finally {
      cleanup();
    }
  });

  it('throws when service.portRange min exceeds max', () => {
    const yaml = VALID.replace(
      '      dependsOn: []\n',
      '      portRange: [5100, 5000]\n      dependsOn: []\n',
    );
    const { path, cleanup } = fixture(yaml);
    try {
      expect(() => loadManifest(path)).toThrow(/exceeds max/);
    } finally {
      cleanup();
    }
  });

  it('throws when a service.portRange endpoint is not a valid port', () => {
    const yaml = VALID.replace(
      '      dependsOn: []\n',
      '      portRange: [0, 5000]\n      dependsOn: []\n',
    );
    const { path, cleanup } = fixture(yaml);
    try {
      expect(() => loadManifest(path)).toThrow(/1 and 65535/);
    } finally {
      cleanup();
    }
  });

  it('accepts an incomplete portRange on a disabled draft repository', () => {
    const yaml = VALID
      .replace(
        '    repoPath: ../backend\n    service:',
        '    repoPath: ../backend\n    enabled: false\n    service:',
      )
      .replace(
        '      dependsOn: []\n',
        '      portRange: [0, 0]\n      dependsOn: []\n',
      );
    const { path, cleanup } = fixture(yaml);
    try {
      expect(loadManifest(path).repositories.backend!.service!.portRange).toEqual([0, 0]);
    } finally {
      cleanup();
    }
  });

  it('rejects a portRange at repository level as a stray runtime field', () => {
    const yaml = VALID.replace(
      '    repoPath: ../backend\n    service:',
      '    repoPath: ../backend\n    portRange: [5000, 5100]\n    service:',
    );
    const { path, cleanup } = fixture(yaml);
    try {
      expect(() => loadManifest(path)).toThrow(/at repository level/);
      expect(() => loadManifest(path)).toThrow(/move it under/);
    } finally {
      cleanup();
    }
  });
});
```

Also extend the existing stray-runtime-field `it.each` at `src/manifest/load.test.ts:325`:

```ts
  it.each(['start: npm run dev', 'ports: []', 'dependsOn: []', 'health: "http://x"', 'portRange: [5000, 5100]'])(
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/manifest/load.test.ts`

Expected: FAIL — `service!.portRange` is `undefined` (`TypeError`/assertion failures) for the reads; the shape/min-max/port/endpoint errors never throw; the draft `[0, 0]` case throws instead of loading. The stray-field `it.each` extension fails too. (`npm run typecheck` also errors: `portRange` does not exist on `ServiceDef` — expected.)

- [ ] **Step 3: Add the type field**

In `src/manifest/types.ts`, extend `ServiceDef` (lines 37-42):

```ts
export interface ServiceDef {
  start: string;
  health?: string;
  ports: PortSlot[]; // validated non-empty — a service without a port cannot be addressed
  /**
   * Optional per-service allocation window. When present, ticket-hot ports for
   * this service are allocated ONLY from this inclusive [min, max] window,
   * overriding the manifest-level `portRange`. Absent → the global range.
   */
  portRange?: [number, number];
  dependsOn: DependsOn[];
}
```

- [ ] **Step 4: Implement `validatePortRange` and wire it in**

In `src/manifest/validate/repository.ts`:

1. Add `'portRange'` to `RUNTIME_FIELDS` (line 29):

```ts
const RUNTIME_FIELDS = ['start', 'health', 'ports', 'dependsOn', 'portRange'] as const;
```

2. Add `validatePortRange` right after `validatePortSlot` (after line 64):

```ts
/**
 * An optional [min, max] port window narrowing the manifest-global portRange
 * for ONE service. Absent → allocation uses the global range. In DRAFT mode
 * (strict=false) only the two-number shape is checked, so a half-filled range
 * can be saved on a disabled repo — the same relaxation `strictPort` gives
 * `default: 0`.
 */
function validatePortRange(
  raw: unknown,
  where: string,
  strict: boolean,
): [number, number] | undefined {
  if (raw === undefined) return undefined;
  if (
    !Array.isArray(raw) ||
    raw.length !== 2 ||
    typeof raw[0] !== 'number' ||
    typeof raw[1] !== 'number' ||
    Number.isNaN(raw[0]) ||
    Number.isNaN(raw[1])
  ) {
    throw new ManifestError(`${where} must be a [min, max] number pair`);
  }
  if (!strict) return [raw[0], raw[1]];
  const min = requirePort(raw[0], `${where} min`);
  const max = requirePort(raw[1], `${where} max`);
  if (min > max) {
    throw new ManifestError(`${where} min (${min}) exceeds max (${max})`);
  }
  return [min, max];
}
```

3. In `validateService` (lines 108-145), parse the field and return it:

```ts
  const ports = portsRaw.map((p, i) => validatePortSlot(p, `${where}.ports[${i}]`, strict));
  const portRange = validatePortRange(raw.portRange, `${where}.portRange`, strict);
```

and in the return object (lines 139-144):

```ts
  return {
    start,
    health,
    ports,
    portRange,
    dependsOn: dependsOnRaw.map((d, i) => validateDependsOn(d, repo, i, strict)),
  };
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/manifest/load.test.ts`

Expected: PASS (all 7 new tests + the extended `it.each`).

- [ ] **Step 6: Typecheck + full suite**

Run: `npm run typecheck && npx vitest run src/manifest/load.test.ts`

Expected: no typecheck errors; load suite green.

- [ ] **Step 7: Commit**

```bash
git add src/manifest/types.ts src/manifest/validate/repository.ts src/manifest/load.test.ts
git commit -m "feat(manifest): add optional per-service portRange to the service model"
```

---

### Task 2: Allocator honors a per-call range

**Files:**
- Modify: `src/resolver/allocator.ts` (interface `:8-13`, `PortRangeExhaustedError` `:15-22`, `makeDryRunAllocator` `:50-69`, `makePortAllocator` `:71-105`)
- Test: `src/resolver/allocator.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1 (the allocator stays manifest-agnostic — it receives the range per call, never the manifest).
- Produces: `PortAllocator.allocate(ticketId: number, repo: string, slots: string[], range?: [number, number]): Record<string, number>` — the 4th parameter, when present, REPLACES the allocator's construction range for that call; when absent, the construction range is used (existing behavior, all existing call sites and tests keep working). `PortRangeExhaustedError` message gains ` for service "<repo>"` when a repo is passed. Task 3 consumes this signature.

- [ ] **Step 1: Write the failing tests**

Add to `src/resolver/allocator.test.ts` (the existing `beforeEach` builds `alloc = makePortAllocator(store, [4000, 4010])`):

```ts
  it('allocates within a per-call range override', () => {
    const ports = alloc.allocate(1, 'a', ['http', 'debug'], [5000, 5010]);
    for (const p of Object.values(ports)) {
      expect(p).toBeGreaterThanOrEqual(5000);
      expect(p).toBeLessThanOrEqual(5010);
    }
    expect(ports.http).toBe(5000); // lowest free wins, inside the override
  });

  it('never reuses a port allocated in another service range', () => {
    alloc.allocate(1, 'a', ['http'], [5000, 5010]); // takes 5000
    const b = alloc.allocate(2, 'b', ['http'], [5000, 5010]);
    expect(b.http).toBe(5001); // shared used-set: the override window is still unique
    const c = alloc.allocate(3, 'c', ['http']); // no override → construction range
    expect(c.http).toBe(4000); // independent of the 5000s
  });

  it('throws naming the service when a per-call range is exhausted', () => {
    const tight = makePortAllocator(store, [4000, 4010]);
    tight.allocate(1, 'a', ['http', 'debug'], [5000, 5001]); // fills the window
    expect(() => tight.allocate(2, 'b', ['http'], [5000, 5001])).toThrow(
      /no free contiguous block of 1 port\(s\) in range \[5000, 5001\] for service "b"/,
    );
  });

  it('dry-run honors a per-call range too', () => {
    const dry = makeDryRunAllocator([4000, 4999]);
    const ports = dry.allocate(1, 'backend', ['http', 'debug'], [5000, 5001]);
    expect(ports.http).toBe(5000);
    expect(ports.debug).toBe(5001);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/resolver/allocator.test.ts`

Expected: FAIL — `Expected 3 arguments, but got 4` (TypeError at runtime) for each per-call-range call; the exhausted-error message does not contain `for service "b"`. (`npm run typecheck` also errors — expected.)

- [ ] **Step 3: Implement the per-call range**

In `src/resolver/allocator.ts`:

1. Widen the interface (lines 8-13):

```ts
export interface PortAllocator {
  /** Allocate one contiguous port per slot for a ticket's service. */
  allocate(
    ticketId: number,
    repo: string,
    slots: string[],
    range?: [number, number],
  ): Record<string, number>;
  /** Free every port held by a ticket (teardown). */
  release(ticketId: number): void;
}
```

2. Name the service in the exhaustion error (lines 15-22):

```ts
export class PortRangeExhaustedError extends Error {
  constructor(range: [number, number], need: number, repo?: string) {
    const who = repo === undefined ? '' : ` for service "${repo}"`;
    super(
      `no free contiguous block of ${need} port(s) in range [${range[0]}, ${range[1]}]${who}`,
    );
    this.name = 'PortRangeExhaustedError';
  }
}
```

3. `makeDryRunAllocator` — use the per-call range when given (lines 50-69):

```ts
export function makeDryRunAllocator(range: [number, number]): PortAllocator {
  const used = new Set<number>();
  return {
    allocate(_ticketId, repo, slots, override) {
      if (slots.length === 0) return {};
      const window = override ?? range;
      const start = findContiguous(used, window, slots.length);
      if (start === null) throw new PortRangeExhaustedError(window, slots.length, repo);
      const out: Record<string, number> = {};
      slots.forEach((slot, i) => {
        const port = start + i;
        used.add(port);
        out[slot] = port;
      });
      return out;
    },
    release() {
      /* no-op: dry run holds no persistent allocations */
    },
  };
}
```

4. `makePortAllocator` — same override inside the transaction (lines 71-105):

```ts
  const allocate = store.db.transaction(
    (
      ticketId: number,
      repo: string,
      slots: string[],
      override?: [number, number],
    ): Record<string, number> => {
      if (slots.length === 0) return {};
      const window = override ?? range;
      const used = currentUsed();
      const start = findContiguous(used, window, slots.length);
      if (start === null) throw new PortRangeExhaustedError(window, slots.length, repo);

      const out: Record<string, number> = {};
      slots.forEach((slot, i) => {
        const port = start + i;
        insert.run(ticketId, repo, slot, port); // UNIQUE(port) enforces correctness
        out[slot] = port;
      });
      return out;
    },
  );

  return {
    allocate: (ticketId, service, slots, override) => allocate(ticketId, service, slots, override),
    release: (ticketId) => {
      deleteByTicket.run(ticketId);
    },
  };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/resolver/allocator.test.ts`

Expected: PASS — all existing tests (no-override calls still use the construction range) plus the 4 new ones.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`

Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/resolver/allocator.ts src/resolver/allocator.test.ts
git commit -m "feat(resolver): honor a per-call port range in the allocator"
```

---

### Task 3: `resolve` passes each service its effective range

**Files:**
- Modify: `src/resolver/resolve.ts:95-102` (Step 1 allocation loop)
- Test: `src/resolver/resolve.test.ts`

**Interfaces:**
- Consumes: `allocate(ticketId, repo, slots, range?)` from Task 2; `ServiceDef.portRange?: [number, number]` from Task 1.
- Produces: the allocation policy — a hot service allocates from `service.portRange ?? manifest.portRange`. The dry-run allocator (`previewEnv`) gets the same behavior for free: it flows through `resolve` unchanged.

- [ ] **Step 1: Write the failing tests**

Add to `src/resolver/resolve.test.ts` (the suite's `manifest()` fixture has `backend` with `http`+`debug` slots, `frontend` with an http slot depending on `backend.http`, `contracts` standalone; `alloc()` = `makePortAllocator(store, [4000, 4999])`; `TID = 1`):

```ts
  it('allocates a service with a custom portRange inside that range', () => {
    const m = manifest();
    m.repositories.backend!.service!.portRange = [5000, 5100];
    const r = resolve(m, ['backend'], alloc(), TID);
    expect(r.services.backend!.ports.http).toBe(5000); // lowest free wins
    expect(r.services.backend!.ports.debug).toBe(5001);
  });

  it('keeps the global range for services without a portRange', () => {
    const m = manifest();
    m.repositories.backend!.service!.portRange = [5000, 5100];
    const r = resolve(m, ['backend', 'contracts'], alloc(), TID);
    expect(r.services.backend!.ports.http).toBe(5000);
    expect(r.services.contracts!.ports.http).toBe(4000); // global floor
  });

  it('two services with distinct ranges allocate from their own windows', () => {
    const m = manifest();
    m.repositories.backend!.service!.portRange = [5000, 5100];
    m.repositories.frontend!.service!.portRange = [6000, 6100];
    const r = resolve(m, ['backend', 'frontend'], alloc(), TID);
    expect(r.services.backend!.ports.http).toBe(5000);
    expect(r.services.frontend!.ports.http).toBe(6000);
    // effectivePort is untouched: the dependent still repoints at the hot
    // target's ALLOCATED port, which now lives in the target's own window.
    expect(r.services.frontend!.env.VITE_API_URL).toBe('http://localhost:5000');
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/resolver/resolve.test.ts`

Expected: FAIL — backend's ports are 4000/4001 (the global range), not 5000/5001; contracts gets 4001 instead of the global floor 4000 once backend took 4000/4001.

- [ ] **Step 3: Implement the effective-range policy**

In `src/resolver/resolve.ts`, Step 1 (lines 95-102):

```ts
  // Step 1: allocate alt ports for each hot service's owned slots. A service
  // with its own portRange allocates ONLY from that window; the rest use the
  // manifest-global range. The allocator's shared used-set keeps every window
  // unique against every other, so overlapping ranges cannot double-book.
  const hotPorts: Record<string, Record<string, number>> = {};
  for (const name of hotRunnable) {
    const repo = manifest.repositories[name]!;
    if (!isRunnable(repo)) continue; // unreachable: runnableSubset already filtered
    const slots = repo.service.ports.map((p) => p.name);
    hotPorts[name] = allocator.allocate(
      ticketId,
      name,
      slots,
      repo.service.portRange ?? manifest.portRange,
    );
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/resolver/resolve.test.ts src/resolver/allocator.test.ts`

Expected: PASS — all resolve tests (existing ones unchanged: their fixtures declare no per-service range) + the 3 new ones.

- [ ] **Step 5: Full suite + typecheck**

Run: `npm run typecheck && npm test`

Expected: clean; the whole suite green (includes `previewEnv.test.ts`, which still starts from the global range floor because its fixtures declare no per-service range).

- [ ] **Step 6: Commit**

```bash
git add src/resolver/resolve.ts src/resolver/resolve.test.ts
git commit -m "feat(resolver): allocate each service from its own portRange"
```

---

### Task 4: `writeManifest` persists `service.portRange`

**Files:**
- Modify: `src/manifest/write.ts:113-121` (the `service:` overlay)
- Test: `src/manifest/writeManifest.test.ts`

**Interfaces:**
- Consumes: `ServiceDef.portRange?: [number, number]` from Task 1.
- Produces: nothing consumed by later tasks — this is the persistence seam that keeps Settings Save from silently dropping the field (the new-field checklist).

- [ ] **Step 1: Write the failing tests**

1. In `src/manifest/writeManifest.test.ts`, the "round-trips every modeled section" test (`full` manifest, lines 153-258) — add the range to its `backend.service`:

```ts
            service: {
              start: 'npm run dev',
              health: 'http://{host}:{port}/health',
              ports: [{ name: 'http', env: 'PORT', default: 3000 }],
              portRange: [5000, 5100],
              dependsOn: [],
            },
```

2. Add a dedicated persist-and-clear test after "drops the `service:` block when a repository becomes non-runnable" (~line 409):

```ts
  it('persists a service.portRange and drops it once cleared', () => {
    const { path, cleanup } = fixture();
    try {
      const m = loadManifest(path);
      const backend = m.repositories.backend!;
      const withRange: Manifest = {
        ...m,
        repositories: {
          backend: {
            ...backend,
            service: { ...backend.service!, portRange: [5000, 5100] },
          },
        },
      };
      writeManifest(path, withRange);
      let raw = yamlLoad(readFileSync(path, 'utf8')) as Record<string, any>;
      expect(raw.repositories.backend.service.portRange).toEqual([5000, 5100]);
      expect(loadManifest(path).repositories.backend!.service!.portRange).toEqual([5000, 5100]);

      writeManifest(path, {
        ...m,
        repositories: {
          backend: { ...backend, service: { ...backend.service!, portRange: undefined } },
        },
      });
      raw = yamlLoad(readFileSync(path, 'utf8')) as Record<string, any>;
      expect(raw.repositories.backend.service.portRange).toBeUndefined();
      expect(loadManifest(path).repositories.backend!.service!.portRange).toBeUndefined();
    } finally {
      cleanup();
    }
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/manifest/writeManifest.test.ts`

Expected: FAIL — the round-trip test: `reloaded.service.portRange` is `undefined` (the overlay omits the key, so the dumper drops it); the persist test: the raw file lacks `portRange` after the first write.

- [ ] **Step 3: Implement the overlay field**

In `src/manifest/write.ts`, the `service:` overlay (lines 113-121):

```ts
      service: repo.service
        ? {
            ...rawService,
            start: repo.service.start,
            health: repo.service.health,
            ports: repo.service.ports,
            // Written when set, dropped (undefined → omitted by the dumper)
            // when cleared, so the service falls back to the global range.
            portRange: repo.service.portRange,
            dependsOn: repo.service.dependsOn,
          }
        : undefined,
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/manifest/writeManifest.test.ts`

Expected: PASS — both new tests, plus every existing round-trip test (the `...rawService` spread still preserves unknown sub-keys; the explicit `portRange` assignment overrides the raw value, including clearing it).

- [ ] **Step 5: Commit**

```bash
git add src/manifest/write.ts src/manifest/writeManifest.test.ts
git commit -m "feat(manifest): persist service.portRange through writeManifest"
```

---

### Task 5: Settings Repositories tab — edit a service's port range

**Files:**
- Modify: `src/ui/settings/webview.html` (renderServiceCard ~line 1952-2011 for the ids + the row after `<h2>Ports</h2>` at `:2010`; the delegated `input` listener after the `portField` branch at `:2386-2393`; `parseRepoFieldError` at `:1460-1470`)
- Test: `src/ui/settings/webview.test.ts`

**Interfaces:**
- Consumes: `ServiceDef.portRange?: [number, number]` from Task 1 (the webview draft carries it — the draft is a deep copy of the manifest and the Repositories tab already owns `repositories` in `SECTION_FIELDS`, so NO change to `sections.ts`/`state.ts`/`actions.ts`: Save merges `repositories` and the host's `validateManifest` judges the field).
- Produces: two per-service number inputs (`data-port-range-field="min"|"max"` + `data-svc`), a touch-keyed inline error line, and a `parseRepoFieldError` anchor so a validation fault for this field renders inline instead of as a global banner. The webview mirrors the host's error-anchor regex by hand, so the mirror and its pinning test must move together.

- [ ] **Step 1: Write the failing tests**

1. Extend the parse test in `src/ui/settings/webview.test.ts` (the "parses a repoPath error to a repo/field key" test, lines 351-364):

```ts
    expect(parse('repository "api" service.portRange must be a [min, max] number pair'))
      .toEqual({ key: 'api.portRange' });
    expect(parse('repository "api" service.portRange min must be an integer between 1 and 65535 (got 0)'))
      .toEqual({ key: 'api.portRange' });
```

2. Extend the placeholder/coverage test in the "repository field placeholders" describe (lines 434-442):

```ts
    expect(HTML).toContain('data-port-range-field="min"'); // port range min input
    expect(HTML).toContain('data-port-range-field="max"'); // port range max input
    expect(HTML).toContain('data-touch-key="${esc(name)}.portRange"');
```

3. Add a new describe for the editing behavior:

```ts
describe('per-service port range editing', () => {
  it('writes draft.repositories[name].service.portRange from the range inputs', () => {
    expect(HTML).toContain('t.dataset.portRangeField');
    expect(HTML).toMatch(/svcDef\.portRange = \[Number\(minVal\) \|\| 0, Number\(maxVal\) \|\| 0\];/);
  });

  it('clears service.portRange when both inputs are blank', () => {
    expect(HTML).toContain("if (minVal === '' && maxVal === '') delete svcDef.portRange;");
  });

  it('renders an existing portRange into the min/max inputs', () => {
    expect(HTML).toContain('value="${svc.portRange ? svc.portRange[0] : \'\'}"');
    expect(HTML).toContain('value="${svc.portRange ? svc.portRange[1] : \'\'}"');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/ui/settings/webview.test.ts`

Expected: FAIL — the parse-anchor returns `null` for the `service.portRange` faults; `data-port-range-field` and the handler patterns are absent from `HTML`.

- [ ] **Step 3: Implement the webview**

In `src/ui/settings/webview.html`:

1. In `renderServiceCard`, add the three ids next to the other `safeId` calls (after line 1956):

```js
    const portMinId = safeId('f-svc-port-min', name);
    const portMaxId = safeId('f-svc-port-max', name);
    const portRangeErrId = safeId('err', name + '.portRange');
```

2. Between `<h2 style="margin-top:16px">Ports</h2>` and `renderPortsTable(...)` (lines 2010-2011), insert the range row:

```js
          + `<h2 style="margin-top:16px">Ports</h2>`
          + `<label id="${portMinId}">Port range <span class="field-hint">(blank inherits global)</span></label>`
          + `<div class="row" role="group" aria-labelledby="${portMinId}">`
          + `<input type="number" id="${portMinId}" placeholder="min" aria-label="Port range minimum" data-port-range-field="min" data-svc="${esc(name)}" data-touch-key="${esc(name)}.portRange" aria-describedby="${portRangeErrId}" value="${svc.portRange ? svc.portRange[0] : ''}"/>`
          + `<input type="number" id="${portMaxId}" placeholder="max" aria-label="Port range maximum" data-port-range-field="max" data-svc="${esc(name)}" data-touch-key="${esc(name)}.portRange" aria-describedby="${portRangeErrId}" value="${svc.portRange ? svc.portRange[1] : ''}"/>`
          + `</div>`
          + `<div class="field-error hidden" id="${portRangeErrId}" role="alert" data-field-error="${esc(name)}.portRange"></div>`
          + renderPortsTable(name, svc.ports || [])
```

3. In `parseRepoFieldError`, add the anchor before the `service.ports[…]` match (after line 1466):

```js
    m = msg.match(/^repository "([^"]+)" service\.portRange\b/);
    if (m) return { key: m[1] + '.portRange' };
```

4. In the delegated `input` listener, after the `t.dataset.portField` branch (after line 2393):

```js
    if (t.dataset.portRangeField) {
      const svc = t.dataset.svc;
      const svcDef = draft.repositories[svc].service;
      if (!svcDef) return;
      const minEl = document.querySelector('[data-port-range-field="min"][data-svc="' + CSS.escape(svc) + '"]');
      const maxEl = document.querySelector('[data-port-range-field="max"][data-svc="' + CSS.escape(svc) + '"]');
      const minVal = minEl ? minEl.value : '';
      const maxVal = maxEl ? maxEl.value : '';
      if (minVal === '' && maxVal === '') delete svcDef.portRange;
      else svcDef.portRange = [Number(minVal) || 0, Number(maxVal) || 0];
      markDirty();
      return;
    }
```

Note: a disabled (draft) repository may carry `[0, 0]` — Task 1's non-strict validation accepts it; an enabled one with a blank endpoint fails the host's `requirePort` check at Save with the anchored inline message.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/ui/settings/webview.test.ts`

Expected: PASS — the two extended tests + the three new ones, plus every existing pin (UI-R10b danger-button inventory, placeholder inventory, error-anchor tests, tab-scoped save tests — `repositories` is still the only field the tab owns).

- [ ] **Step 5: Full suite + typecheck**

Run: `npm run typecheck && npm test`

Expected: clean and green.

- [ ] **Step 6: Commit**

```bash
git add src/ui/settings/webview.html src/ui/settings/webview.test.ts
git commit -m "feat(settings): edit a service's port range in the repositories tab"
```

---

### Task 6: Documentation — example manifest + UI coverage inventory

**Files:**
- Modify: `karst.example.yml:31-32` and `:60-68` (backend service block)
- Modify: `docs/config-ui-coverage.md:21`

**Interfaces:**
- Consumes: the final field name `service.portRange` (Task 1).
- Produces: nothing — the operator-facing contract: "absent → inherit global `portRange`; present → allocate only within this window".

- [ ] **Step 1: Update `karst.example.yml`**

At lines 31-32, extend the global-range comment:

```yaml
# Inclusive [min, max] port window Karst allocates ticket-hot ports from.
# A service may override this with its own `portRange:` (see backend below).
portRange: [4000, 4100]
```

Inside the `backend` service block, after the `ports:` list and before `dependsOn: []` (lines 64-68):

```yaml
      # Optional per-service port window. When set, karst allocates THIS
      # service's ticket-hot ports only from this inclusive [min, max] window,
      # instead of the global `portRange` above. Absent = inherit the global.
      # Overlapping windows across services are fine — no port is ever handed
      # to two services at once.
      portRange: [5000, 5100]
```

- [ ] **Step 2: Update `docs/config-ui-coverage.md`**

On the Repositories coverage row (line 21), add `.portRange` after `.health`:

```md
| `repositories.<n>.service.start` / `.health` / `.portRange` / `.ports[].{name,env,default}` / `.dependsOn[].{target,port}` / `.dependsOn[].bind[].{env,template}` | Repositories |
```

- [ ] **Step 3: Verify the example file still loads**

Run: `npx vitest run src/manifest/load.test.ts`

Expected: PASS (the example file is not itself a fixture, but the suite's VALID shape now matches the documented shape; no test change here).

- [ ] **Step 4: Commit**

```bash
git add karst.example.yml docs/config-ui-coverage.md
git commit -m "docs: document per-service portRange"
```

---

## Self-Review

**1. Spec coverage:** The acceptance criterion — "an operator can set a min and max port for a given service, and the system will only allocate ports within that range for that service" — maps to: manifest field + validation (Task 1), allocation honoring it (Tasks 2+3), persistence (Task 4), operator-facing editor (Task 5), documentation (Task 6). The ticket's three numbered concerns: (1) extend the service config model → Task 1; (2) persist this configuration → Task 4 (writeManifest overlay; no DB column because ranges are config, and `port_allocations` already stores results); (3) allocation checks/honors the range → Tasks 2+3. No gaps.

**2. Placeholder scan:** Every step carries concrete code or an exact test; no "TBD"/"similar to"/"handle edge cases" phrasing.

**3. Type consistency:** `ServiceDef.portRange?: [number, number]` is defined once (Task 1) and consumed identically in Tasks 3/4/5. `allocate`'s 4th parameter is named `range` in the interface, `override` inside both allocator implementations, and passed positionally at `resolve.ts` — one signature everywhere. The validation error prefix `repository "<name>" service.portRange` is produced by `validatePortRange` (Task 1) and anchored by the webview regex `service\.portRange\b` (Task 5) — the `\b` boundary intentionally matches both `service.portRange must be…` and `service.portRange min must be…`.
