# karst.yml → UI Coverage — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use `superpowers:subagent-driven-development` (recommended) or
> `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.
>
> **Spec of record:** `docs/config-ui-coverage.md`. Every "why", every rejected alternative, and the decision
> record (S1–S7, D1–D3) lives there. This file is the "what, and in what order".

**Goal:** Close the gap between what `karst.yml` accepts and what the UI can reach — fix the one place the UI
silently destroys config, make config that does nothing say so, make the file itself findable, and give the
keys that DO work a settings tab.

**Architecture:** Four independent phases, smallest-risk first. Phase 1 is a one-line-class defect fix in the
approach drawer. Phase 2 adds a second, INFO-level diagnostic channel to the manifest loader (`notices`,
beside the existing `warnings`) fed by one pure detector over the raw parsed YAML — raw, not the validated
model, because the validator defaults `uat.env` to `{}` and "declared empty" must stay distinguishable from
"absent". Phase 3 adds a command and two read-only facts to Settings. Phase 4 adds one `Quality` settings tab
owning `uat` + `review`, rendering only keys with live consumers, with a single gate-editor component used by
both blocks.

**Tech Stack:** TypeScript (ESM, `moduleResolution: Bundler`), vitest, js-yaml, VS Code extension API
(`@types/vscode` only — never a runtime import outside `src/extension.ts` and its thin wrappers).

---

## Global Constraints

Copied from `CLAUDE.md` and `docs/ui/UI-RULES.md`. Every task's requirements implicitly include this section.

- **ESM:** every relative import needs a `.js` suffix, including from `.ts` files.
- **`noUncheckedIndexedAccess` is on:** array/index access needs `!` or a guard.
- **`vscode` is not a runtime dependency.** Nothing under `src/manifest/`, `src/workflow/`, `src/store/`,
  `src/model/`, `src/ui/settings/*.ts` (the non-panel modules) may import it.
- **New `Manifest` field checklist** (Phase 4 touches none, but the Quality tab makes `uat`/`review` editable):
  `types.ts` + `validateManifest` + **the `writeManifest` overlay** + `manifest/fixtures.ts`. `uat` and
  `review` are ALREADY in the overlay (`write.ts:164-165`) — do not re-add them.
- **Tokens are the only legal style values** (UI-R04/R05). No hex, `rgba()`, raw `px`/`rem`, radius, shadow or
  duration in a component — use `--k-*`.
- **Every control that posts to the host shows a pending state and reports a terminal outcome** (UI-R11–R14).
- **Semantics match the element** (UI-R09): an action is a `<button>`, navigation is an `<a href>`.
- **`disabled` ≠ `aria-busy`.** Never `pointer-events:none` to disable.
- **Mirrored TS→HTML constants are BEHAVIOR** (UI-R34). `SECTION_FIELDS` lives in `ui/settings/sections.ts`
  AND in `ui/settings/webview.html`; `webview.test.ts` pins them together.
- **Settings Save is TAB-SCOPED.** `mergeSection` overlays only that tab's fields, onto the manifest **as it is
  on disk right now**. A field absent from the posted draft is DELETED.
- **File size:** 200–400 lines typical, 800 max. `src/extension.ts` is ~3000 lines — move code out, never in.
- **TDD is mandatory:** write the failing test, run it, watch it fail, then implement.
- **Conventional commits:** `feat:`, `fix:`, `refactor:`, `test:`, `docs:`, `chore:`.
- **Commands:** `npm test`, `npx vitest run <path>`, `npm run typecheck`.

---

## Scope and phasing

| Phase | Ships | Independently valuable? |
|---|---|---|
| **1 — Stop destroying config** (Task 1) | Approach drawer preserves `workflow` on edit | Yes. Standalone `main` bug fix, revertable alone. |
| **2 — Inert config says so** (Tasks 2–5) | `notices` channel, inert-key detector, host + CLI surfacing, `uatEnvWarnings` finally wired, example.yml annotations | Yes. Implements decisions D1 + D2. No UI dependency. |
| **3 — The file is findable** (Tasks 6–7) | `karst.openManifest` command; manifest path + resolved project id shown in Settings | Yes. Implements S6. Makes yml-only a real path. |
| **4 — Quality tab** (Tasks 8–13) | One tab owning `uat` + `review`, wired keys only, one shared gate editor, per-repo overrides prefilled from global | Yes. Implements D3 + S2 + S3 + S4. |

Phases are ordered by risk, not dependency. **Only real dependency:** Task 13 (per-repo override editor)
consumes the gate editor from Task 11. Phases 1–3 can ship in any order.

---

## Task 1: Approach drawer stops dropping `workflow`

Implements **S1**. `saveApproachDrawer` rebuilds the approach object from drawer fields alone, carrying only
`enabled` from the existing entry. Any key the drawer does not render — today `workflow`, tomorrow anything
added to `ApproachDef` — is destroyed when a user edits that approach.

**Files:**
- Modify: `src/ui/settings/webview.html:2423-2436` (the `approach` object literal in the drawer save)
- Test: `src/ui/settings/webview.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: nothing. Behavioral fix only.

- [ ] **Step 1: Write the failing test**

Add to `src/ui/settings/webview.test.ts`. This suite already loads the HTML and evaluates its script in a
jsdom-ish harness — follow the file's existing pattern for reaching drawer functions; if the suite exercises
the drawer through DOM events elsewhere, mirror that rather than inventing a new entry point.

```ts
it('preserves approach keys the drawer does not render when editing', () => {
  // An approach carrying a workflow — exactly the shipped `rpi` shape.
  const before = {
    id: 'rpi',
    label: 'Research → Plan → Implement',
    entrypoint: 'research',
    enabled: true,
    workflow: [
      { name: 'describe' },
      { name: 'research', command: '/rpi:research' },
    ],
  };

  const after = rebuildApproachFromDrawer(before, {
    id: 'rpi',
    label: 'Research → Plan → Implement (edited)',
    description: '',
    entrypoint: 'research',
    sourceType: 'none',
    recommended: false,
  });

  expect(after.label).toBe('Research → Plan → Implement (edited)');
  expect(after.workflow).toEqual(before.workflow);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/ui/settings/webview.test.ts -t "preserves approach keys"`
Expected: FAIL — `after.workflow` is `undefined`.

- [ ] **Step 3: Implement**

The current code builds the object inline inside the drawer's save handler, which is why it cannot be tested.
Extract it first as a pure function (the test above calls exactly this), then have the handler call it.

Add near the other approach helpers in `src/ui/settings/webview.html`:

```js
  // Pure: existing entry + the drawer's fields → the entry to store. Extracted
  // from the save handler so it is testable — the clobber it fixes was
  // invisible precisely because this logic lived inside an event handler.
  // `fields` is what the drawer read: {id, label, description, entrypoint,
  // sourceType, recommended, source?}.
  function rebuildApproachFromDrawer(existing, fields) {
    const approach = {
      // Spread the existing entry first so keys this drawer does not render —
      // `workflow` today, anything added to ApproachDef later — survive an edit.
      // Every drawer-owned field below overwrites it, so this is not a merge of
      // stale values; it is only a floor for fields the form has no control for.
      ...(existing || {}),
      id: fields.id,
      label: fields.label,
      enabled: existing ? existing.enabled !== false : true,
    };
    // Optional fields are DELETED when cleared, not left at their old value —
    // the drawer owns them, and `...existing` would otherwise resurrect them.
    if (fields.description) approach.description = fields.description;
    else delete approach.description;
    if (fields.entrypoint) approach.entrypoint = fields.entrypoint;
    else delete approach.entrypoint;
    if (fields.source) approach.source = fields.source; else delete approach.source;
    if (fields.recommended) approach.recommended = true; else delete approach.recommended;
    return approach;
  }
```

Note the explicit deletes: `...existing` makes clearing a field a real case. Without them, blanking
`description` in the drawer would silently keep the old text.

Then replace the inline literal in the save handler (`webview.html:2423-2436`) with a call, keeping the
`finalId` and `source` resolution already above it:

```js
    const approach = rebuildApproachFromDrawer(existing, {
      id: finalId, label, description, entrypoint, source, recommended,
    });
```

The `clearOthers` / `nextApproaches` logic below it is unchanged.

- [ ] **Step 4: Add the clearing test, and run both**

```ts
it('clears a drawer-owned optional field that the user blanked', () => {
  const before = { id: 'x', label: 'X', description: 'old', entrypoint: 'e', enabled: true };
  const after = rebuildApproachFromDrawer(before, {
    id: 'x', label: 'X', description: '', entrypoint: 'e',
    sourceType: 'none', recommended: false,
  });
  expect(after.description).toBeUndefined();
  expect(after.entrypoint).toBe('e');
});
```

Run: `npx vitest run src/ui/settings/webview.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add src/ui/settings/webview.html src/ui/settings/webview.test.ts
git commit -m "fix: approach drawer no longer drops workflow on edit"
```

---

## Task 2: Detect declared-but-inert manifest keys

Implements **D1** + **D2** detection. Pure function, no I/O, no `vscode`.

Detection runs over the **raw parsed object** (post-`migrateLegacyManifest`, pre-`validateManifest`) because
the validator defaults `uat.env` to `{}` and `uat.secrets` to `[]` — after validation, "the author declared
it" and "the validator filled it in" are indistinguishable, and a notice must only fire for what the author
actually wrote.

**Files:**
- Create: `src/manifest/inertKeys.ts`
- Test: `src/manifest/inertKeys.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `detectInertKeys(raw: unknown): string[]` — human-readable notice lines, empty when the file
  declares no inert key. Consumed by Task 3.

- [ ] **Step 1: Write the failing test**

Create `src/manifest/inertKeys.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { detectInertKeys } from './inertKeys.js';

describe('detectInertKeys', () => {
  it('says nothing about a manifest that declares no inert key', () => {
    expect(detectInertKeys({ host: '127.0.0.1', uat: { maxFixAttempts: 5 } })).toEqual([]);
  });

  it('names inert uat keys the author actually declared', () => {
    const notices = detectInertKeys({
      uat: { maxFixAttempts: 3, secrets: ['STRIPE_KEY'], origins: ['https://a.test'] },
    });
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('uat.secrets');
    expect(notices[0]).toContain('uat.origins');
    expect(notices[0]).toContain('not yet active');
    // Wired keys are never named.
    expect(notices[0]).not.toContain('maxFixAttempts');
  });

  it('does not fire for an absent uat block', () => {
    expect(detectInertKeys({ host: 'x' })).toEqual([]);
  });

  it('reports per-repository uat overrides', () => {
    const notices = detectInertKeys({
      uat: { repositories: { api: { env: { A: 'b' }, gates: [] } } },
    });
    expect(notices[0]).toContain('uat.repositories.api.env');
    // `gates` IS wired per-repo — never named.
    expect(notices[0]).not.toContain('gates');
  });

  it('names the AgentDef fields as one aggregate line, not one per agent', () => {
    const notices = detectInertKeys({
      agents: { research: { role: 'research' }, plan: { role: 'plan', command: 'x' } },
    });
    const agentLine = notices.find((n) => n.startsWith('agents.'));
    expect(agentLine).toBeDefined();
    expect(agentLine).toContain('role');
    expect(agentLine).toContain('command');
    // Required-but-unread is the confusing part; say so explicitly.
    expect(agentLine).toContain('required');
  });

  it('does not name promptPath when no agent declares one', () => {
    const notices = detectInertKeys({ agents: { research: { role: 'research' } } });
    const agentLine = notices.find((n) => n.startsWith('agents.'));
    expect(agentLine).not.toContain('promptPath');
  });

  it('tolerates a malformed manifest without throwing', () => {
    expect(() => detectInertKeys(null)).not.toThrow();
    expect(() => detectInertKeys('nonsense')).not.toThrow();
    expect(() => detectInertKeys({ uat: 'not-a-mapping' })).not.toThrow();
    expect(detectInertKeys({ uat: 'not-a-mapping' })).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/manifest/inertKeys.test.ts`
Expected: FAIL — `Cannot find module './inertKeys.js'`.

- [ ] **Step 3: Implement**

Create `src/manifest/inertKeys.ts`:

```ts
/**
 * Manifest keys the validator ACCEPTS but no code reads (decision D1,
 * `docs/config-ui-coverage.md`). karst keeps parsing and round-tripping them so
 * no existing file breaks and nothing is erased on Save — but it says so at
 * load, because a key that silently does nothing is indistinguishable from a
 * key that is broken.
 *
 * Runs over the RAW parsed object, after `migrateLegacyManifest` and before
 * `validateManifest`: the validator defaults `uat.env` to `{}` and
 * `uat.secrets` to `[]`, so after it runs, "the author wrote this" and "the
 * validator filled it in" cannot be told apart — and only the first deserves a
 * notice. Never throws: a malformed file is the validator's error to report,
 * with its own precise message, and a diagnostic helper must not pre-empt it.
 *
 * When a key gains a consumer, delete it from the list below and delete its
 * annotation in `karst.example.yml`.
 */

/** `uat.*` keys with no consumer. `maxFixAttempts` and `gates` are wired — never list them. */
const INERT_UAT_KEYS = [
  'testDir',
  'env',
  'secrets',
  'passthrough',
  'origins',
  'authBootstrap',
  'author',
] as const;

/** `uat.repositories.<name>.*` keys with no consumer. `gates` is wired per-repo. */
const INERT_UAT_REPO_KEYS = ['env', 'secrets', 'testDir'] as const;

/** `agents.<name>.*` keys with no consumer. Only `enabled` is read. */
const INERT_AGENT_KEYS = ['role', 'command', 'promptPath'] as const;

const INACTIVE = 'declared but not yet active — karst parses these and does not read them yet';

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function uatNotice(raw: Record<string, unknown>): string | undefined {
  const uat = raw.uat;
  if (!isObject(uat)) return undefined;

  const found: string[] = INERT_UAT_KEYS.filter((k) => uat[k] !== undefined).map((k) => `uat.${k}`);

  const repositories = uat.repositories;
  if (isObject(repositories)) {
    for (const [name, override] of Object.entries(repositories)) {
      if (!isObject(override)) continue;
      for (const key of INERT_UAT_REPO_KEYS) {
        if (override[key] !== undefined) found.push(`uat.repositories.${name}.${key}`);
      }
    }
  }

  return found.length ? `${found.join(', ')} — ${INACTIVE}` : undefined;
}

function agentsNotice(raw: Record<string, unknown>): string | undefined {
  const agents = raw.agents;
  if (!isObject(agents)) return undefined;

  // Aggregated across every agent, never one line per agent: a manifest with
  // eight declared agents would otherwise emit eight identical notices.
  const found = new Set<string>();
  for (const def of Object.values(agents)) {
    if (!isObject(def)) continue;
    for (const key of INERT_AGENT_KEYS) {
      if (def[key] !== undefined) found.add(key);
    }
  }
  if (found.size === 0) return undefined;

  const keys = INERT_AGENT_KEYS.filter((k) => found.has(k)).join(', ');
  const required = found.has('role')
    // `role` is required by validateManifest while being read by nothing, so an
    // author is compelled to supply a value that misleads them. Say it outright.
    ? ' (`role` is required by validation despite being unread)'
    : '';
  return `agents.*.${keys} — ${INACTIVE}${required}`;
}

/** Notice lines for every inert key this manifest actually declares. */
export function detectInertKeys(raw: unknown): string[] {
  if (!isObject(raw)) return [];
  const notices: string[] = [];
  const uat = uatNotice(raw);
  if (uat) notices.push(uat);
  const agents = agentsNotice(raw);
  if (agents) notices.push(agents);
  return notices;
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/manifest/inertKeys.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add src/manifest/inertKeys.ts src/manifest/inertKeys.test.ts
git commit -m "feat: detect declared-but-inert manifest keys"
```

---

## Task 3: A `notices` channel on the manifest loader

`warnings` means "something is wrong and you should change it" (a legacy `services:` key, a credential-shaped
`uat.env` value). An inert key is not wrong — it is inactive. Mixing them would make every UAT-configuring
project look like it has a problem, so this is a separate, INFO-level channel, mirroring the
`catalogDiagnosticSeverity` INFO/WARN split (`agent/modelCatalogLoader.ts`) rather than inventing a second
severity vocabulary.

This task also finally wires `uatEnvWarnings` (`manifest/validate/uat.ts:230`) — it has existed since UAT
landed and is called by nothing, so the credential-in-`uat.env` check has never once run.

**Files:**
- Modify: `src/manifest/load.ts:11-19` (the `LoadedManifestResult` interface) and `:47-52` (the return)
- Test: `src/manifest/load.test.ts`

**Interfaces:**
- Consumes: `detectInertKeys(raw: unknown): string[]` from Task 2; `uatEnvWarnings(config: UatConfig): string[]`
  (already exported, `manifest/validate/uat.ts:230`).
- Produces: `LoadedManifestResult.notices: string[]` — consumed by Task 4.

- [ ] **Step 1: Write the failing test**

Add to `src/manifest/load.test.ts`, following that file's existing tmp-file pattern:

```ts
it('reports inert keys as notices, not warnings', () => {
  const path = writeTmpManifest(`
host: 127.0.0.1
portRange: [4000, 4100]
baselineBranch: main
repositories:
  api:
    repoPath: ${repoDir}
    hasMigrations: false
uat:
  maxFixAttempts: 2
  secrets: [STRIPE_KEY]
`);
  const { notices, warnings } = loadManifestWithDiagnostics(path);
  expect(notices.some((n) => n.includes('uat.secrets'))).toBe(true);
  // Inactive is not the same claim as wrong.
  expect(warnings).toEqual([]);
});

it('warns when a uat.env value looks like a credential', () => {
  const path = writeTmpManifest(`
host: 127.0.0.1
portRange: [4000, 4100]
baselineBranch: main
repositories:
  api:
    repoPath: ${repoDir}
    hasMigrations: false
uat:
  env:
    STRIPE_KEY: sk_live_abcdefghijklmnopqrstuvwx
`);
  const { warnings } = loadManifestWithDiagnostics(path);
  expect(warnings.some((w) => w.includes('uat.env') && w.includes('uat.secrets'))).toBe(true);
});

it('has no notices for a manifest declaring only wired keys', () => {
  const path = writeTmpManifest(`
host: 127.0.0.1
portRange: [4000, 4100]
baselineBranch: main
repositories:
  api:
    repoPath: ${repoDir}
    hasMigrations: false
review:
  maxFixAttempts: 2
`);
  expect(loadManifestWithDiagnostics(path).notices).toEqual([]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/manifest/load.test.ts -t "notices"`
Expected: FAIL — `notices` is `undefined`.

- [ ] **Step 3: Implement**

In `src/manifest/load.ts`, add the imports:

```ts
import { detectInertKeys } from './inertKeys.js';
import { uatEnvWarnings } from './validate/uat.js';
```

Extend the result interface:

```ts
export interface LoadedManifestResult {
  manifest: Manifest;
  /**
   * Non-fatal problems: the file uses the legacy `services:` key, or a
   * `uat.env` value looks like a pasted credential. Something the author
   * should change.
   */
  warnings: string[];
  /**
   * Non-fatal FACTS: keys the file declares that no code reads yet (D1). Not a
   * problem and not the author's mistake, so kept out of `warnings` — a project
   * configuring UAT ahead of Phase 2 must not read as broken. INFO, mirroring
   * `catalogDiagnosticSeverity`'s split.
   */
  notices: string[];
}
```

And the return, inside the existing `try`:

```ts
  try {
    const { raw, warnings } = migrateLegacyManifest(parsed);
    const manifest = validateManifest(raw);
    return {
      manifest,
      // uatEnvWarnings has existed since UAT landed and was called by nothing,
      // so this check has never run. It is a warning, never a block: it cannot
      // be reliable, and the mistake it catches is the likely one.
      warnings: [...warnings, ...(manifest.uat ? uatEnvWarnings(manifest.uat) : [])],
      notices: detectInertKeys(raw),
    };
  } catch (e) {
    throw e instanceof ManifestError ? e.withPath(path) : e;
  }
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/manifest/load.test.ts`
Expected: PASS. Existing tests that destructure `{ manifest, warnings }` keep compiling — the field is
additive.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add src/manifest/load.ts src/manifest/load.test.ts
git commit -m "feat: manifest loader reports inert-key notices and wires uatEnvWarnings"
```

---

## Task 4: Surface notices in the host and the CLI

Three call sites read `loadManifestWithDiagnostics` today and each logs `warnings`. Notices go beside them at
INFO.

**Files:**
- Modify: `src/extension.ts:815` and `src/extension.ts:2778`
- Modify: `src/extension/manifestResolve.ts:108`
- Modify: `src/cli/main.ts:17-19` (`writeManifestWarnings`) and its two call sites (`:31`, `:106`)
- Test: `src/extension/manifestResolve.test.ts` (if it exists — otherwise assert via the CLI test)

**Interfaces:**
- Consumes: `LoadedManifestResult.notices` from Task 3.
- Produces: nothing.

- [ ] **Step 1: Write the failing test**

In `src/cli/main.test.ts` (follow its existing stderr-capture pattern):

```ts
it('writes inert-key notices to stderr, keeping stdout clean JSON', async () => {
  const { stdout, stderr } = await runCli(['context', '--db', dbPath, '--manifest', manifestWithInertKeys]);
  expect(stderr).toContain('uat.secrets');
  expect(stderr).toContain('not yet active');
  // stdout is consumed by an agent — it must stay parseable.
  expect(() => JSON.parse(stdout)).not.toThrow();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/cli/main.test.ts -t "inert-key notices"`
Expected: FAIL — stderr carries no notice.

- [ ] **Step 3: Implement**

`src/cli/main.ts` — generalize the writer and call it for both channels:

```ts
function writeManifestDiagnostics(diagnostics: readonly string[]): void {
  for (const d of diagnostics) process.stderr.write(`karst: ${d}\n`);
}
```

Replace both `writeManifestWarnings(loaded.warnings)` call sites with:

```ts
        writeManifestDiagnostics(loaded.warnings);
        writeManifestDiagnostics(loaded.notices);
```

and at `:30-31`, inside `projectSlugFromManifest`:

```ts
    const { manifest, warnings, notices } = loadManifestWithDiagnostics(manifestPath);
    writeManifestDiagnostics(warnings);
    writeManifestDiagnostics(notices);
```

`src/extension.ts:815` — beside the existing warn loop:

```ts
      for (const w of warnings) logger.warn(`karst.yml: ${w}`);
      for (const n of notices) logger.info(`karst.yml: ${n}`);
```

(destructure `notices` from the same `loadManifestWithDiagnostics` call).

`src/extension.ts:2778` — same shape, using the local `warn` helper's info sibling. If no `info` helper is in
scope at that site, use `logger.info` directly; do not add a new helper.

`src/extension/manifestResolve.ts:108` — destructure and forward `notices` wherever that function already
forwards `warnings`.

- [ ] **Step 4: Run tests**

Run: `npm test`
Expected: PASS. Watch for CLI tests asserting exact stderr — a manifest fixture declaring inert keys will now
emit an extra line.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add src/cli/main.ts src/extension.ts src/extension/manifestResolve.ts src/cli/main.test.ts
git commit -m "feat: surface inert-key notices in host log and CLI stderr"
```

---

## Task 5: Annotate the inert blocks in `karst.example.yml`

The example file is the de-facto documentation for hand-editing (Task 6 makes it reachable). It currently
presents `uat:` keys with no hint that most do nothing.

**Files:**
- Modify: `karst.example.yml`
- Modify: `scripts/copy-assets.mjs` — **verify only**; `karst.example.yml` is already a mirrored root asset, no
  change expected.
- Test: `src/manifest/example.test.ts`

**Interfaces:**
- Consumes: the inert-key list from Task 2 (`INERT_UAT_KEYS`, `INERT_UAT_REPO_KEYS`, `INERT_AGENT_KEYS`).
- Produces: nothing.

- [ ] **Step 1: Write the failing test**

`src/manifest/example.test.ts` already loads and validates the example manifest. Add:

```ts
it('annotates every inert key it demonstrates', () => {
  const text = readFileSync(examplePath, 'utf8');
  // Whatever the example chooses to show, an inert key must carry the marker on
  // or above its line — otherwise the file teaches config that does nothing.
  const parsed = load(text) as unknown;
  for (const notice of detectInertKeys(parsed)) {
    expect(text, `example demonstrates ${notice} without marking it inactive`)
      .toContain('NOT YET ACTIVE');
  }
});
```

- [ ] **Step 2: Run test to verify it fails or passes trivially**

Run: `npx vitest run src/manifest/example.test.ts -t "annotates every inert key"`
Expected: PASS trivially if the example declares no `uat:` block; FAIL once Step 3 adds one. Either way, Step 3
is what makes the test meaningful — write the annotated block, then re-run.

- [ ] **Step 3: Implement**

Append to `karst.example.yml`, after the `agents:` block:

```yaml
# UAT gates. ABSENT (the default) yields the probe pipeline: karst looks for
# known package.json scripts. Only two keys under `uat:` are read today —
# `maxFixAttempts` and `gates` (plus per-repository `gates`).
uat:
  # WIRED. Fix→UAT→fix retries before the ticket parks. Narrows UAT only; review
  # has its own `review.maxFixAttempts`.
  maxFixAttempts: 3
  # WIRED. Replaces the probe. `kind: command` is argv-based and spawned without
  # a shell — it is what keeps UAT usable from Go, Rust, Java and Python repos.
  gates:
    - { name: test, kind: script, script: test }
    - { name: e2e, kind: command, command: npx, args: [playwright, test], repo: frontend }
  repositories:
    frontend:
      # WIRED, and it REPLACES the global list for this repository — it is not
      # additive. A repo listed here runs exactly these gates.
      gates:
        - { name: test, kind: script, script: test:unit }

  # ---- NOT YET ACTIVE -------------------------------------------------------
  # Everything below is validated at load and read by nothing. karst preserves
  # it across a Settings Save and reports it at load as "declared but not yet
  # active" (see docs/config-ui-coverage.md, decision D1). Declaring it early is
  # harmless; expecting it to DO anything is not.
  #
  # testDir: e2e
  # env:
  #   BASE_URL: http://localhost:3000
  # secrets: [STRIPE_KEY]        # KEY NAMES ONLY — never values. karst.yml is
  #                              # committed; a value here is a leaked credential.
  # passthrough: [HOME, PATH]
  # origins: [https://api.stripe.com]
  # authBootstrap: { path: .auth/state.json, secrets: [SESSION_TOKEN] }
  # author: { agent: uat-author, enabled: true }

# Review gates. ABSENT yields the probe pipeline (REVIEW_PROBE_SCRIPTS).
# Every key here IS wired.
review:
  maxFixAttempts: 3
  # Whether a passing review needs a signal independent of the agent's own claim.
  requireIndependentSignal: true
  findings:
    # ON and blocking at `high` by DESIGN — a deliberate deviation from the
    # design spec's advisory-only recommendation. critical/high findings fail
    # review to `fix` rather than sitting as unread evidence.
    enabled: true
    blockingSeverity: high
    maxFindings: 50
  gates:
    - { name: build, kind: script, script: build }
```

Also fix the stale path in the file's header comment: the `karst.manifestPath` default is
`./.karst/karst.yml` (`extension/manifestResolve.ts:25`), not `./karst.yml` as the current comment claims.

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/manifest/example.test.ts`
Expected: PASS — the example still validates, and every inert key it shows sits under the `NOT YET ACTIVE`
marker (commented out, so `detectInertKeys` sees none of them and the test's loop is empty — which is the
point: the example demonstrates the shape without declaring dead config).

- [ ] **Step 5: Commit**

```bash
git add karst.example.yml src/manifest/example.test.ts
git commit -m "docs: mark inert uat keys in the example manifest"
```

---

## Task 6: `karst.openManifest` command

Makes hand-editing a real path. The Quality tab (Phase 4) deliberately does not cover the inert keys, so this
is not optional polish — it is the only route to them.

**Files:**
- Modify: `package.json` (the `contributes.commands` array, after `karst.openSettings` at `:140-145`)
- Modify: `src/extension.ts` (register beside `karst.openSettings` at `:2502`)
- Test: manual (a `vscode`-importing command registration is not unit-testable — see CLAUDE.md).

**Interfaces:**
- Consumes: `manifestPathOrThrow(): string` (`src/extension/manifestResolve.ts:20`).
- Produces: the command id `karst.openManifest`, referenced by Task 7's Settings link.

- [ ] **Step 1: Add the contribution**

In `package.json`, inside `contributes.commands`:

```json
      {
        "command": "karst.openManifest",
        "title": "Karst: Open karst.yml",
        "icon": "$(file-code)"
      },
```

- [ ] **Step 2: Register the command**

In `src/extension.ts`, beside the `karst.openSettings` registration:

```ts
    vscode.commands.registerCommand('karst.openManifest', async () => {
      // Opens the FILE, deliberately — not the settings panel. Config karst
      // parses but does not render (docs/config-ui-coverage.md, D1) is only
      // reachable here, so this must work even when the manifest is invalid.
      let path: string;
      try {
        path = manifestPathOrThrow();
      } catch {
        void vscode.window.showWarningMessage('Karst: no workspace folder is open.');
        return;
      }
      if (!existsSync(path)) {
        void vscode.window.showWarningMessage(
          `Karst: no manifest at ${path}. Run onboarding to scaffold one.`,
        );
        return;
      }
      const doc = await vscode.workspace.openTextDocument(path);
      await vscode.window.showTextDocument(doc);
    }),
```

- [ ] **Step 3: Verify manually**

Press F5, open the Extension Development Host, run **Karst: Open karst.yml** from the command palette.
Expected: the manifest opens in an editor tab. Rename the file and re-run: expected a warning naming the
missing path, no exception in the log.

- [ ] **Step 4: Typecheck and commit**

```bash
npm run typecheck
git add package.json src/extension.ts
git commit -m "feat: add Karst: Open karst.yml command"
```

---

## Task 7: Show the manifest path and resolved project id in Settings

Implements **S6**. Two read-only facts on the General tab, answering "is this window bound to the project I
think it is, using the file I think it is?".

`id` is displayed with its PROVENANCE, because the interesting case is the one that is not in the file at all:
when `id:` is absent the host falls back to a path-derived slug that changes if the repo moves.

**Files:**
- Modify: `src/ui/settings/state.ts` (add two fields to `SettingsState` + `buildSettingsState`)
- Modify: `src/ui/settings/panel.ts:74` (supply them)
- Modify: `src/extension.ts` (pass the resolved slug when constructing the panel)
- Modify: `src/ui/settings/webview.html` (render, General tab)
- Test: `src/ui/settings/state.test.ts`, `src/ui/settings/webview.test.ts`

**Interfaces:**
- Consumes: `resolveProjectSlug(id: string | undefined, rootPath: string): string` (`src/project/slug.ts:64`);
  the `karst.openManifest` command id from Task 6.
- Produces: `SettingsState.manifestPath: string` and `SettingsState.projectSlug: { value: string; derived: boolean }`.

- [ ] **Step 1: Write the failing test**

Add to `src/ui/settings/state.test.ts`:

```ts
it('carries the manifest path and the resolved project slug', () => {
  const state = buildSettingsState(
    manifestFixture,
    null,
    [],
    false,
    ['claude'],
    [],
    {},
    bundledModelCatalog(),
    '/work/proj/.karst/karst.yml',
    { value: 'my-proj', derived: false },
  );
  expect(state.manifestPath).toBe('/work/proj/.karst/karst.yml');
  expect(state.projectSlug).toEqual({ value: 'my-proj', derived: false });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/ui/settings/state.test.ts -t "manifest path"`
Expected: FAIL — properties do not exist.

- [ ] **Step 3: Implement the state fields**

In `src/ui/settings/state.ts`, extend the interface:

```ts
export interface SettingsState {
  // … existing fields unchanged …
  /** Absolute path of the manifest this window reads. Displayed, never edited. */
  manifestPath: string;
  /**
   * The project identity tickets are scoped by. `derived: true` means the
   * manifest declares no `id:` and the host fell back to a path-derived slug —
   * which changes if the repo moves, so it is the case worth showing.
   */
  projectSlug: { value: string; derived: boolean };
}
```

Add the two parameters to `buildSettingsState` (last, both defaulted, so existing callers keep compiling):

```ts
  manifestPath = '',
  projectSlug: { value: string; derived: boolean } = { value: '', derived: true },
```

and return them.

- [ ] **Step 4: Supply them from the host**

In `src/ui/settings/panel.ts`, at the `buildSettingsState` call (`:74`), pass `this.manifestPath()` and a
`projectSlug` computed by the host. In `src/extension.ts`, where the panel is constructed, compute:

```ts
      const slugValue = resolveProjectSlug(manifest.id, folder.uri.fsPath);
      const projectSlug = { value: slugValue, derived: manifest.id === undefined };
```

- [ ] **Step 5: Render (General tab)**

In `src/ui/settings/webview.html`, at the end of `#section-general`'s field list. Read-only: a `<dl>`, not
inputs — nothing here is part of the draft, and adding it to `SECTION_FIELDS` would make Save write it.

```html
        <div class="field-group" id="projectFacts">
          <label>This project</label>
          <dl class="facts">
            <dt>Manifest</dt>
            <dd><code id="factManifestPath"></code>
              <button type="button" class="k-btn k-btn--secondary k-btn--sm fixed"
                      id="openManifestBtn"
                      title="Open karst.yml in an editor">Open karst.yml</button></dd>
            <dt>Project id</dt>
            <dd><code id="factProjectSlug"></code>
              <span class="chip" id="factSlugDerived" hidden
                    title="No id: in karst.yml — derived from the workspace path, so it changes if the repo moves">derived</span></dd>
          </dl>
        </div>
```

and in the render path:

```js
    el('factManifestPath').textContent = state.manifestPath || '(unresolved)';
    el('factProjectSlug').textContent = state.projectSlug?.value || '(unresolved)';
    el('factSlugDerived').hidden = !state.projectSlug?.derived;
```

Wire the button through the existing action dispatch (UI-R11: pending state, terminal outcome) posting
`{ type: 'open-manifest' }`; the host handler runs
`vscode.commands.executeCommand('karst.openManifest')`. Add `'open-manifest'` to the message union in
`src/ui/settings/messages.ts` and the corresponding `actions.ts` method — both are closed unions (UI-R16), so
an unhandled value must not be possible.

- [ ] **Step 6: Run tests**

Run: `npx vitest run src/ui/settings/`
Expected: PASS. `webview.test.ts` may assert on General's field count — update it if so.

- [ ] **Step 7: Typecheck and commit**

```bash
npm run typecheck
git add src/ui/settings/ src/extension.ts
git commit -m "feat: show manifest path and resolved project id in Settings"
```

---

## Task 8: A `quality` settings section

Implements **D3**'s plumbing. `uat` and `review` become editable fields, each owned by exactly one section.

**⚠ The trap this task must not spring:** `mergeSection` DELETES a field absent from the posted draft. The
Quality tab renders only wired keys, so if its editors ever REBUILD `draft.uat` from the rendered controls,
every inert key (`uat.secrets`, `uat.env`, …) is destroyed on Save — the exact defect Task 1 fixes for
approaches. Every Quality editor must spread the existing block. Task 12 pins this with a guard test.

**Files:**
- Modify: `src/ui/settings/sections.ts` (`SETTINGS_SECTIONS`, `SECTION_LABELS`, `SECTION_FIELDS`, and the
  doc comment at `:18-19` which currently says `uat`/`review` are never editable)
- Modify: `src/ui/settings/webview.html:1058-1077` (the mirrors)
- Test: `src/ui/settings/sections.test.ts`, `src/ui/settings/webview.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: the section key `'quality'`, owning manifest fields `uat` and `review`.

- [ ] **Step 1: Update the failing assertions**

`src/ui/settings/sections.test.ts:44-56` hardcodes the owned-field list. Add both fields:

```ts
    expect([...seen].sort()).toEqual(
      [
        'agentProvider', 'agents', 'approaches', 'baselineBranch', 'conventions',
        'defaultModel', 'host', 'portRange', 'repositories', 'review',
        'terminalNameTemplate', 'ticketLabelTemplate', 'ticketing', 'uat',
        'worktreePathDisplay',
      ].sort(),
    );
```

Add a section-scoping test:

```ts
it('a quality save leaves every other section untouched', () => {
  const incoming: Manifest = { ...BASE, uat: { ...BASE.uat, maxFixAttempts: 9 } as never, host: 'evil' };
  const merged = mergeSection(BASE, incoming, 'quality');
  expect(merged.uat?.maxFixAttempts).toBe(9);
  expect(merged.host).toBe(BASE.host);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/ui/settings/sections.test.ts`
Expected: FAIL — `'quality'` is not a section; `uat`/`review` unclaimed.

- [ ] **Step 3: Implement**

In `src/ui/settings/sections.ts`:

```ts
export const SETTINGS_SECTIONS = [
  'general', 'git', 'services', 'approaches', 'agents', 'ticketing', 'quality',
] as const;

export const SECTION_LABELS: Record<SettingsSection, string> = {
  // … existing …
  quality: 'Quality',
};

export const SECTION_FIELDS: Record<SettingsSection, readonly (keyof Manifest)[]> = {
  // … existing …
  quality: ['uat', 'review'],
};
```

Update the doc comment at `:18-19` — only `id` is now unclaimed:

```ts
 * Fields no section claims (`id`) are never editable here and always survive
 * from the base. The Quality tab claims `uat`/`review` but renders only the
 * keys with live consumers, so its editors MUST spread the existing block
 * rather than rebuild it — see docs/config-ui-coverage.md, D1/D3.
```

Mirror all three constants into `src/ui/settings/webview.html:1058-1077`.

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/ui/settings/sections.test.ts src/ui/settings/webview.test.ts`
Expected: PASS — including `webview.test.ts`'s existing mirror-drift test.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add src/ui/settings/sections.ts src/ui/settings/sections.test.ts src/ui/settings/webview.html
git commit -m "feat: add quality settings section owning uat and review"
```

---

## Task 9: Quality tab shell — the wired scalar controls

**Files:**
- Modify: `src/ui/settings/webview.html` (nav entry + `#section-quality`)
- Test: `src/ui/settings/webview.test.ts`

**Interfaces:**
- Consumes: the `'quality'` section from Task 8.
- Produces: the DOM ids `f-uatMaxFix`, `f-reviewMaxFix`, `f-reviewIndependent`, `f-findingsEnabled`,
  `f-findingsSeverity`, `f-findingsMax` — read by Task 12's draft-sync.

- [ ] **Step 1: Write the failing test**

```ts
it('renders review findings defaults as blocking when the block is absent', () => {
  const dom = renderSettings({ manifest: { ...baseManifest, review: undefined } });
  // The manifest default is enabled/high by design — a control that renders
  // "off" would imply review is advisory when it blocks (decision S4).
  expect(dom.querySelector('#f-findingsEnabled').checked).toBe(true);
  expect(dom.querySelector('#f-findingsSeverity').value).toBe('high');
  expect(dom.querySelector('#f-findingsMax').value).toBe('50');
  expect(dom.querySelector('#f-reviewIndependent').checked).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/ui/settings/webview.test.ts -t "findings defaults"`
Expected: FAIL — no such elements.

- [ ] **Step 3: Implement**

Add the nav entry beside the others, then the section. Defaults are declared once at the top of the script and
must match `manifest/validate/review.ts:10-12` and `:96,108` exactly:

```js
  // Mirrors validate/review.ts defaultFindings() and validateReview()'s
  // fallbacks. An absent block renders as what it DOES, not as empty (S4).
  const REVIEW_DEFAULTS = {
    maxFixAttempts: 3,
    requireIndependentSignal: true,
    findings: { enabled: true, blockingSeverity: 'high', maxFindings: 50 },
  };
  const UAT_DEFAULTS = { maxFixAttempts: 3 };
  const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info', 'none'];
```

```html
    <div class="section hidden" id="section-quality">
      <div class="card open">
        <div class="card-head"><span class="card-title">UAT</span></div>
        <div class="card-body form">
          <label for="f-uatMaxFix">Max fix attempts</label>
          <input type="number" min="1" id="f-uatMaxFix" />
          <div class="field-hint">Fix→UAT→fix retries before the ticket parks. UAT only.</div>
        </div>
      </div>
      <div class="card open">
        <div class="card-head"><span class="card-title">Review</span></div>
        <div class="card-body form">
          <label for="f-reviewMaxFix">Max fix attempts</label>
          <input type="number" min="1" id="f-reviewMaxFix" />
          <label for="f-reviewIndependent">Require independent signal</label>
          <input type="checkbox" id="f-reviewIndependent" />
          <div class="field-hint">A pass needs evidence beyond the agent's own claim.</div>
          <label for="f-findingsEnabled">Agent findings</label>
          <input type="checkbox" id="f-findingsEnabled" />
          <label for="f-findingsSeverity">Blocking severity</label>
          <select id="f-findingsSeverity"></select>
          <div class="field-hint">Findings at or above this severity fail review to <code>fix</code>.
            <code>none</code> makes them advisory.</div>
          <label for="f-findingsMax">Max findings</label>
          <input type="number" min="1" id="f-findingsMax" />
        </div>
      </div>
      <div class="card open">
        <div class="card-head"><span class="card-title">Gates</span></div>
        <div class="card-body" id="qualityGates"></div>
      </div>
    </div>
```

Populate `#f-findingsSeverity` from `SEVERITIES` and hydrate every control from
`draft.review ?? REVIEW_DEFAULTS` (deep-defaulting `findings`), `draft.uat ?? UAT_DEFAULTS`.

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/ui/settings/webview.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ui/settings/webview.html src/ui/settings/webview.test.ts
git commit -m "feat: quality tab renders wired uat and review scalars"
```

---

## Task 10: `GateDef` draft helpers, shared by both blocks

Implements **S2**'s host half: one set of pure functions over a gate list, so the UAT and review editors cannot
diverge on validation.

**Files:**
- Create: `src/ui/settings/gateDraft.ts`
- Test: `src/ui/settings/gateDraft.test.ts`

**Interfaces:**
- Consumes: `GateDef`, `GateKind` from `src/manifest/types.js`.
- Produces:
  - `emptyGate(): GateDef` → `{ name: '', kind: 'script', script: '' }`
  - `setGateKind(gate: GateDef, kind: GateKind): GateDef` — switches kind, dropping the other kind's fields
  - `validateGateDraft(gate: GateDef): string | null` — null when valid, else a message
  - `gateSummary(gate: GateDef): string` — one-line display form

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { emptyGate, setGateKind, validateGateDraft, gateSummary } from './gateDraft.js';

describe('gate draft helpers', () => {
  it('starts a new gate as an empty script gate', () => {
    expect(emptyGate()).toEqual({ name: '', kind: 'script', script: '' });
  });

  it('drops the other kind fields when switching kind', () => {
    const asCommand = setGateKind({ name: 'e2e', kind: 'script', script: 'test' }, 'command');
    expect(asCommand).toEqual({ name: 'e2e', kind: 'command', command: '', args: [] });
    expect(asCommand).not.toHaveProperty('script');
    const back = setGateKind(asCommand, 'script');
    expect(back).toEqual({ name: 'e2e', kind: 'script', script: '' });
  });

  it('never mutates its input', () => {
    const gate: GateDef = { name: 'a', kind: 'script', script: 's' };
    setGateKind(gate, 'command');
    expect(gate).toEqual({ name: 'a', kind: 'script', script: 's' });
  });

  it('rejects a nameless gate', () => {
    expect(validateGateDraft({ name: '  ', kind: 'script', script: 'test' }))
      .toContain('name');
  });

  it('rejects a script gate with no script and a command gate with no command', () => {
    expect(validateGateDraft({ name: 'a', kind: 'script' })).toContain('script');
    expect(validateGateDraft({ name: 'a', kind: 'command' })).toContain('command');
  });

  it('accepts a valid gate of each kind', () => {
    expect(validateGateDraft({ name: 'test', kind: 'script', script: 'test' })).toBeNull();
    expect(validateGateDraft({ name: 'e2e', kind: 'command', command: 'npx', args: ['playwright'] }))
      .toBeNull();
  });

  it('summarises each kind', () => {
    expect(gateSummary({ name: 'test', kind: 'script', script: 'test' })).toBe('npm run test');
    expect(gateSummary({ name: 'e2e', kind: 'command', command: 'npx', args: ['playwright', 'test'] }))
      .toBe('npx playwright test');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/ui/settings/gateDraft.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
import type { GateDef, GateKind } from '../../manifest/types.js';

/**
 * Pure helpers over one declared gate, shared by the UAT and review editors
 * (decision S2). `uat.gates` and `review.gates` are the same shape and already
 * share `validateGate` on the manifest side; two UI implementations would fork
 * on validation and copy and never remerge.
 *
 * Every helper returns a NEW object — the settings draft is edited immutably.
 */

export function emptyGate(): GateDef {
  return { name: '', kind: 'script', script: '' };
}

/** `gate` as `kind`, dropping the fields belonging to the kind it left. */
export function setGateKind(gate: GateDef, kind: GateKind): GateDef {
  if (kind === 'script') {
    const { command, args, ...rest } = gate;
    return { ...rest, kind: 'script', script: '' };
  }
  const { script, ...rest } = gate;
  return { ...rest, kind: 'command', command: '', args: [] };
}

/** null when the gate would validate; otherwise the reason, in the UI's voice. */
export function validateGateDraft(gate: GateDef): string | null {
  if (!gate.name || gate.name.trim().length === 0) return 'Gate needs a name.';
  if (gate.kind === 'script') {
    if (!gate.script || gate.script.trim().length === 0) {
      return `Gate "${gate.name}" needs a package.json script.`;
    }
    return null;
  }
  if (!gate.command || gate.command.trim().length === 0) {
    return `Gate "${gate.name}" needs a command.`;
  }
  return null;
}

/** One-line display form: what this gate will actually run. */
export function gateSummary(gate: GateDef): string {
  if (gate.kind === 'script') return `npm run ${gate.script ?? ''}`.trim();
  return [gate.command ?? '', ...(gate.args ?? [])].join(' ').trim();
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/ui/settings/gateDraft.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add src/ui/settings/gateDraft.ts src/ui/settings/gateDraft.test.ts
git commit -m "feat: shared gate draft helpers for uat and review editors"
```

---

## Task 11: The gate editor component

One renderer, parameterized by which block it edits. Mirrors `gateDraft.ts` into the webview the way
`SECTION_FIELDS` is mirrored, and `webview.test.ts` pins the two together (UI-R34).

**Files:**
- Modify: `src/ui/settings/webview.html` (`renderGateList`, mounted into `#qualityGates`)
- Test: `src/ui/settings/webview.test.ts`

**Interfaces:**
- Consumes: `emptyGate`, `setGateKind`, `validateGateDraft`, `gateSummary` (Task 10 — mirrored into the
  webview script).
- Produces: `renderGateList(block, gates)` where `block` is `'uat' | 'review'`; data attributes
  `data-gate-block`, `data-gate-idx`, `data-gate-field`.

- [ ] **Step 1: Write the failing differential test**

```ts
it('renders every gate exactly as the host summarises it', async () => {
  // Same shape as the existing transform mirror test: the webview's copy of
  // gateSummary must agree with the host's for every case we care about.
  const cases: GateDef[] = [
    { name: 'test', kind: 'script', script: 'test' },
    { name: 'e2e', kind: 'command', command: 'npx', args: ['playwright', 'test'] },
    { name: 'build', kind: 'script', script: 'build', repo: 'frontend' },
  ];
  for (const gate of cases) {
    expect(webviewGateSummary(gate)).toBe(gateSummary(gate));
  }
});

it('scopes a gate to a repository from the declared repositories only', () => {
  const dom = renderSettings({ manifest: { ...baseManifest, repositories: { api: {}, web: {} } } });
  const options = [...dom.querySelectorAll('[data-gate-field="repo"] option')].map((o) => o.value);
  // '' is "every target" — the absent-repo case, which must stay selectable.
  expect(options).toEqual(['', 'api', 'web']);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/ui/settings/webview.test.ts -t "gate"`
Expected: FAIL.

- [ ] **Step 3: Implement**

```js
  // Mirrors src/ui/settings/gateDraft.ts — webview.test.ts pins the two
  // together. A drift would validate differently than the host does.
  function gateSummary(gate) {
    if (gate.kind === 'script') return ('npm run ' + (gate.script || '')).trim();
    return [gate.command || ''].concat(gate.args || []).join(' ').trim();
  }

  // ONE renderer for both blocks (S2). `block` is 'uat' | 'review'.
  function renderGateList(block, gates) {
    const repoOpts = ['']
      .concat(Object.keys(draft.repositories || {}))
      .map((r) => `<option value="${esc(r)}">${r ? esc(r) : 'every target'}</option>`)
      .join('');
    const rows = (gates || []).map((g, i) => (
      `<div class="gate-row" data-gate-block="${block}" data-gate-idx="${i}">`
      + `<input type="text" aria-label="Gate ${i + 1} name" data-gate-field="name"`
      + ` data-gate-block="${block}" data-gate-idx="${i}" value="${esc(g.name || '')}"/>`
      + `<select aria-label="Gate ${i + 1} kind" data-gate-field="kind"`
      + ` data-gate-block="${block}" data-gate-idx="${i}">`
      + `<option value="script"${g.kind === 'script' ? ' selected' : ''}>script</option>`
      + `<option value="command"${g.kind === 'command' ? ' selected' : ''}>command</option>`
      + `</select>`
      + (g.kind === 'script'
        ? `<input type="text" aria-label="Gate ${i + 1} script" data-gate-field="script"`
          + ` data-gate-block="${block}" data-gate-idx="${i}" value="${esc(g.script || '')}"/>`
        : `<input type="text" aria-label="Gate ${i + 1} command" data-gate-field="command"`
          + ` data-gate-block="${block}" data-gate-idx="${i}" value="${esc(g.command || '')}"/>`
          + `<input type="text" aria-label="Gate ${i + 1} arguments" data-gate-field="args"`
          + ` data-gate-block="${block}" data-gate-idx="${i}"`
          + ` placeholder="space-separated" value="${esc((g.args || []).join(' '))}"/>`)
      + `<select aria-label="Gate ${i + 1} repository" data-gate-field="repo"`
      + ` data-gate-block="${block}" data-gate-idx="${i}">${repoOpts}</select>`
      + `<span class="gate-summary">${esc(gateSummary(g))}</span>`
      + `<button type="button" class="k-iconbtn k-iconbtn--danger"`
      + ` data-remove-gate="${block}" data-gate-idx="${i}"`
      + ` aria-label="Remove gate ${i + 1}" title="Remove gate ${i + 1}">&times;</button>`
      + `</div>`
    )).join('');
    return rows
      + `<button type="button" class="k-btn k-btn--secondary k-btn--sm"`
      + ` data-add-gate="${block}">+ Add gate</button>`;
  }
```

Set each `repo` select's value after render (a `selected` attribute inside a template string is error-prone
with an empty value). Handle `input`/`change` on `[data-gate-field]` by writing back through the
spread-preserving updater from Task 12.

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/ui/settings/webview.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ui/settings/webview.html src/ui/settings/webview.test.ts
git commit -m "feat: shared gate editor for uat and review"
```

---

## Task 12: Preserve inert keys through a Quality save

The guard for Task 8's trap. This is the task most likely to catch a real regression, so it gets its own test
cycle even though the code is small.

**Files:**
- Modify: `src/ui/settings/webview.html` (the Quality draft updaters)
- Test: `src/ui/settings/webview.test.ts`, `src/ui/settings/actions.test.ts`

**Interfaces:**
- Consumes: the Quality controls (Tasks 9, 11).
- Produces: `updateUat(patch)` / `updateReview(patch)` — spread-preserving draft updaters.

- [ ] **Step 1: Write the failing test**

```ts
it('preserves inert uat keys when the quality tab is saved', async () => {
  const onDisk: Manifest = {
    ...baseManifest,
    uat: {
      maxFixAttempts: 3,
      env: { BASE_URL: 'http://localhost:3000' },
      secrets: ['STRIPE_KEY'],
      passthrough: [],
      origins: ['https://api.stripe.com'],
      repositories: {},
    },
  };
  // The webview renders only maxFixAttempts and gates. Saving must not erase
  // the rest — mergeSection deletes fields absent from the posted draft, and
  // rebuilding draft.uat from the rendered controls would omit them.
  const posted = simulateQualityEdit(onDisk, { uatMaxFixAttempts: 7 });
  const merged = mergeSection(onDisk, posted, 'quality');

  expect(merged.uat?.maxFixAttempts).toBe(7);
  expect(merged.uat?.secrets).toEqual(['STRIPE_KEY']);
  expect(merged.uat?.env).toEqual({ BASE_URL: 'http://localhost:3000' });
  expect(merged.uat?.origins).toEqual(['https://api.stripe.com']);
});

it('preserves review.repositories overrides when editing global review gates', () => {
  const onDisk: Manifest = {
    ...baseManifest,
    review: {
      maxFixAttempts: 3,
      requireIndependentSignal: true,
      findings: { enabled: true, blockingSeverity: 'high', maxFindings: 50 },
      repositories: { api: { gates: [{ name: 'lint', kind: 'script', script: 'lint' }] } },
    },
  };
  const posted = simulateQualityEdit(onDisk, { reviewMaxFixAttempts: 5 });
  const merged = mergeSection(onDisk, posted, 'quality');
  expect(merged.review?.repositories?.api?.gates).toHaveLength(1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/ui/settings/webview.test.ts -t "preserves inert"`
Expected: FAIL — inert keys dropped.

- [ ] **Step 3: Implement**

```js
  // Quality renders only the WIRED keys, but `uat`/`review` are whole-field
  // section members: mergeSection replaces the entire block with what we post.
  // So every edit spreads the block as it stands and overrides one key —
  // rebuilding it from the rendered controls would erase uat.secrets,
  // uat.env, review.repositories and everything else the tab does not show.
  // Same failure mode as the approach drawer clobber (S1). Guarded by
  // "preserves inert uat keys when the quality tab is saved".
  function updateUat(patch) {
    draft.uat = { ...(draft.uat || {}), ...patch };
    markDirty();
  }

  function updateReview(patch) {
    draft.review = { ...(draft.review || {}), ...patch };
    markDirty();
  }

  function updateFindings(patch) {
    updateReview({
      findings: { ...REVIEW_DEFAULTS.findings, ...(draft.review?.findings || {}), ...patch },
    });
  }
```

Route every Quality control through these three. No Quality handler may assign `draft.uat` or `draft.review`
directly.

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/ui/settings/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ui/settings/webview.html src/ui/settings/webview.test.ts
git commit -m "fix: quality tab preserves manifest keys it does not render"
```

---

## Task 13: Per-repository gate overrides, prefilled from global

Implements **S3**. The override REPLACES the global list — never adds to it — and the UI has to show that,
because "add a gate for this repo" is the natural reading of a per-repo list.

**Files:**
- Modify: `src/ui/settings/webview.html` (the Quality tab's Gates card)
- Test: `src/ui/settings/webview.test.ts`

**Interfaces:**
- Consumes: `renderGateList` (Task 11), `updateUat`/`updateReview` (Task 12).
- Produces: nothing.

- [ ] **Step 1: Write the failing test**

```ts
it('prefills a new per-repo override with the global list, so replacement is visible', () => {
  const manifest = {
    ...baseManifest,
    repositories: { api: {}, web: {} },
    review: {
      maxFixAttempts: 3,
      requireIndependentSignal: true,
      findings: { enabled: true, blockingSeverity: 'high', maxFindings: 50 },
      gates: [{ name: 'build', kind: 'script', script: 'build' }],
      repositories: {},
    },
  };
  const dom = renderSettings({ manifest });
  clickAddOverride(dom, 'review', 'api');

  // The override REPLACES the global list. Starting empty would read as
  // "api runs no gates" the moment it is created — true, but invisible.
  expect(currentDraft().review.repositories.api.gates)
    .toEqual([{ name: 'build', kind: 'script', script: 'build' }]);
});

it('says the override replaces rather than extends', () => {
  const dom = renderSettings({ manifest: baseManifest });
  expect(dom.querySelector('#overrideHint').textContent).toMatch(/replaces/i);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/ui/settings/webview.test.ts -t "override"`
Expected: FAIL.

- [ ] **Step 3: Implement**

```js
  // A per-repo list REPLACES the global one (declaredGatesFor /
  // declaredReviewGatesFor), which is the opposite of how "add a gate for this
  // repo" reads. Seeding the new override with the global list makes the
  // replacement visible: the user edits a copy rather than starting from an
  // empty list that silently means "this repo runs nothing".
  function addRepoOverride(block, repo) {
    const blockDraft = draft[block] || {};
    const seed = clone(blockDraft.gates || []);
    const update = block === 'uat' ? updateUat : updateReview;
    update({
      repositories: {
        ...(blockDraft.repositories || {}),
        [repo]: { gates: seed },
      },
    });
    renderQuality();
  }
```

with the hint rendered beside the override list:

```html
          <div class="field-hint" id="overrideHint">
            A repository override <strong>replaces</strong> the gates above for that
            repository — it does not add to them.
          </div>
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/ui/settings/webview.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ui/settings/webview.html src/ui/settings/webview.test.ts
git commit -m "feat: per-repo gate overrides prefilled from the global list"
```

---

## Task 14: End-to-end Quality save round-trip

Proves the whole phase: edit on the Quality tab → validate → `writeManifest` → reload → the edits are there
and nothing else moved.

**Files:**
- Test: `src/ui/settings/actions.test.ts`, `src/manifest/writeManifest.test.ts`

**Interfaces:**
- Consumes: everything in Phase 4.
- Produces: nothing.

- [ ] **Step 1: Write the failing test**

```ts
it('round-trips a quality save through writeManifest', () => {
  const path = tmpManifestPath();
  writeManifest(path, {
    ...baseManifest,
    uat: { maxFixAttempts: 3, env: { A: 'b' }, secrets: ['K'], passthrough: [], origins: [], repositories: {} },
  });

  const { manifest: onDisk } = loadManifestWithDiagnostics(path);
  const posted = { ...onDisk, uat: { ...onDisk.uat!, maxFixAttempts: 9 } };
  writeManifest(path, mergeSection(onDisk, posted, 'quality'));

  const { manifest: after, notices } = loadManifestWithDiagnostics(path);
  expect(after.uat?.maxFixAttempts).toBe(9);
  expect(after.uat?.secrets).toEqual(['K']);
  expect(after.uat?.env).toEqual({ A: 'b' });
  // The inert keys survived a UI save, so they must still be reported.
  expect(notices.some((n) => n.includes('uat.secrets'))).toBe(true);
});

it('rejects an invalid quality draft with the field named', () => {
  const invalid = { ...baseManifest, review: { ...baseManifest.review, maxFixAttempts: 0 } };
  expect(() => validateManifest(invalid as never)).toThrow(/review\.maxFixAttempts/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/ui/settings/actions.test.ts -t "round-trips a quality save"`
Expected: FAIL if any earlier task regressed; PASS once Phase 4 is complete.

- [ ] **Step 3: Fix whatever it catches**

No new implementation is expected. If the round-trip drops a key, the defect is in Task 12's updaters — fix
there, not by special-casing the test.

- [ ] **Step 4: Run the full suite**

```bash
npm test
npm run typecheck
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ui/settings/actions.test.ts src/manifest/writeManifest.test.ts
git commit -m "test: quality tab save round-trips through the manifest"
```

---

## Task 15: Update the coverage report to match what shipped

`docs/config-ui-coverage.md` is the spec of record and will be read as current. Move every key this plan
exposed out of the GAP table, and record what remains yml-only.

**Files:**
- Modify: `docs/config-ui-coverage.md`

- [ ] **Step 1: Update the tables**

- Move to Covered: `uat.maxFixAttempts`, `uat.gates`, `uat.repositories.<n>.gates`,
  `review.maxFixAttempts`, `review.requireIndependentSignal`, `review.findings.*`, `review.gates`,
  `review.repositories.<n>.gates` — all under the new **Quality** tab.
- Add to Covered as read-only: `id` (General, displayed with provenance).
- Keep in Gaps, now with "inert — reported at load" rather than "no UI":
  `uat.testDir`/`env`/`secrets`/`passthrough`/`origins`/`authBootstrap`/`author`, the per-repo
  `env`/`secrets`/`testDir`, and `agents.<n>.role`/`.command`/`.promptPath`.
- Keep in Gaps: `repositories.<n>.scope`, `approaches[].workflow` (S1 now prevents its destruction, but there
  is still no editor — that was the decision, not an oversight).
- Update "How yml-only keys are set up today": `karst.openManifest` now exists and the resolved path is shown
  in Settings.

- [ ] **Step 2: Commit**

```bash
git add docs/config-ui-coverage.md
git commit -m "docs: update config coverage report for the quality tab"
```

---

## Self-review

**Spec coverage** — every decision in `docs/config-ui-coverage.md` maps to a task:

| Decision | Task |
|---|---|
| S1 approach drawer clobber | 1 |
| S2 one gate editor | 10, 11 |
| S3 overrides REPLACE, shown | 13 |
| S4 controls render manifest defaults | 9 |
| S5 keychain namespace | **none — correctly deferred.** Blocked on a `uat.secrets` consumer (D1 kept them inert), so there is nothing to store. Revisit in UAT Phase 2. |
| S6 `id` read-only with provenance | 7 |
| S7 secrets never in the draft | **none needed** — no secret control is built, and Task 12's updaters keep the draft a spread of the manifest. |
| D1 inert kept + marked | 2, 3, 4, 5 |
| D2 AgentDef follows D1 | 2 (`INERT_AGENT_KEYS`), 5 |
| D3 one Quality tab, wired keys only | 8, 9, 11, 13 |
| Discoverability prerequisite | 6, 7 |

**Known gaps left deliberately unbuilt**, all recorded in Task 15: `repositories.<n>.scope` (a one-line input,
but out of this plan's four decisions), `approaches[].workflow` editor (decided against), and every inert key's
UI (decided against until wired).

**Type consistency** — `detectInertKeys(raw: unknown): string[]` is defined in Task 2 and consumed in Tasks 3
and 5 with that signature. `LoadedManifestResult.notices: string[]` is defined in Task 3 and consumed in Task 4.
`emptyGate`/`setGateKind`/`validateGateDraft`/`gateSummary` are defined in Task 10 and consumed in Task 11.
`updateUat`/`updateReview`/`updateFindings` are defined in Task 12 and consumed in Task 13. `SettingsState`'s
two new fields are defined in Task 7 and used only there.

**Risk note for the implementer:** Tasks 8–13 all edit `src/ui/settings/webview.html`, which is ~3300 lines.
Land them in order and re-run `npx vitest run src/ui/settings/` after each — the mirror tests
(`webview.test.ts`) are what catch a drift between the host constants and the webview copies, and they fail
loudly rather than subtly.
