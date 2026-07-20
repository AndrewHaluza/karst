# Naming Templates + Live Status Encoding — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give tabs and terminals templated names and a single live status color (the karst logo tinted by the existing status glyph), plus a live status-bar item — so a ticket's stage/state/blockers read at a glance across every karst surface.

**Architecture:** Reuse `glyphFor` (`src/model/glyph.ts`) as the sole color source. A new pure `glyphColor` map turns a `Glyph` into a hex (for baked SVG icons) and a `terminal.ansi*` ThemeColor key (for the terminal tab label). Icons are runtime-generated tinted copies of `media/karst.svg`. Webview tab icons update live; terminals are static-at-launch (a node-pty spike proved live terminal rename costs the agent session on reload). A new `terminalNameTemplate` manifest field mirrors `ticketLabelTemplate`.

**Tech Stack:** TypeScript ESM (`.js` import suffixes, `moduleResolution: Bundler`), vitest, `@types/vscode` (dev only — `vscode` is never a runtime dep), better-sqlite3 store.

## Global Constraints

- **Host-agnostic core.** No `vscode` runtime import in testable logic. vscode-touching code is a thin wrapper behind an injected interface with a fake for tests (`src/ui/session.ts`, `dashboard/panel.ts` pattern). Copied verbatim from CLAUDE.md.
- **ESM quirks.** Imports need `.js` suffix. `noUncheckedIndexedAccess` is on — array/record access needs `!` or a guard.
- **Immutability.** Never mutate inputs; return new objects (user coding-style rule).
- **New Manifest field checklist:** add to `types.ts` + `validateManifest` (schema.ts, default it) + **`writeManifest` overlay (write.ts)** or Save silently drops it. Guarded by `writeManifest.test.ts` "round-trips every modeled section".
- **Webview HTML can't import TS** — any TS map used in a webview must be mirrored as a JS literal in the HTML (existing pattern for `ticketLabelTemplate`).
- **Two tsconfigs:** `tsconfig.json` (typecheck/vitest), `tsconfig.build.json` (emit, excludes tests). Run `npm run typecheck` and `npm test` (in-memory SQLite).
- **Commit style:** conventional commits, no attribution trailer (repo setting).
- **Glyph → color map (single source for this feature):**

  | glyph | hex       | terminal ThemeColor key    |
  |-------|-----------|----------------------------|
  | gray  | `#7f8896` | `terminal.ansiBrightBlack` |
  | blue  | `#3f8cff` | `terminal.ansiBlue`        |
  | amber | `#d99a2b` | `terminal.ansiYellow`      |
  | green | `#38a86b` | `terminal.ansiGreen`       |
  | red   | `#e35555` | `terminal.ansiRed`         |

---

## File Structure

**Create:**
- `src/model/glyphColor.ts` — `glyphHex`, `glyphThemeColorKey` (pure).
- `src/model/glyphColor.test.ts`
- `src/model/ticketGlyph.ts` — `currentStageStatus`, `ticketGlyph` (pure; extracted from `items.ts`).
- `src/model/ticketGlyph.test.ts`
- `src/ui/glyphIcon.ts` — `tintSvg` (pure) + `glyphIconPath` (thin fs wrapper).
- `src/ui/glyphIcon.test.ts`
- `src/ui/statusBar.ts` — `statusBarText` (pure) + `StatusBarManager` + `StatusBarHost`.
- `src/ui/statusBar.test.ts`

**Modify:**
- `src/manifest/types.ts` — `terminalNameTemplate?: string`.
- `src/manifest/schema.ts` — `validateTerminalNameTemplate` + wire into `validateManifest`.
- `src/manifest/write.ts` — overlay `terminalNameTemplate`.
- `src/store/ticketLabelTemplate.ts` — export `DEFAULT_TERMINAL_NAME_TEMPLATE`.
- `src/ui/sidebar/items.ts` — use `ticketGlyph` (no behavior change).
- `src/ui/session.ts` — `CreateTerminalOpts` gains `iconPath?`, `color?`; `openSession` gains a `naming?` bag.
- `src/ui/dashboard/panel.ts` — `DashboardPanel.setIcon`; manager calls it on push.
- `src/ui/onboarding/panel.ts` — `OnboardingPanel.setIcon`; manager calls it.
- `src/extension.ts` — `makeTerminalHost` maps icon/color; `makePanelHost`/onboarding host add `setIcon`; `karst.openSession` renders the terminal name + glyph icon; status-bar wiring.
- `src/ui/settings/webview.html` — "Terminal name template" input.
- `src/ui/sidebar/webview.html` — tint the row logo by glyph color.

---

## Task 1: Glyph → color map

**Files:**
- Create: `src/model/glyphColor.ts`
- Test: `src/model/glyphColor.test.ts`

**Interfaces:**
- Consumes: `Glyph` from `src/model/glyph.ts` (`'gray'|'blue'|'amber'|'green'|'red'`).
- Produces: `glyphHex(glyph: Glyph): string`, `glyphThemeColorKey(glyph: Glyph): string`.

- [ ] **Step 1: Write the failing test**

```typescript
// src/model/glyphColor.test.ts
import { describe, it, expect } from 'vitest';
import type { Glyph } from './glyph.js';
import { glyphHex, glyphThemeColorKey } from './glyphColor.js';

const ALL: Glyph[] = ['gray', 'blue', 'amber', 'green', 'red'];

describe('glyphColor', () => {
  it('maps every glyph to a distinct 6-digit hex', () => {
    const hexes = ALL.map(glyphHex);
    for (const h of hexes) expect(h).toMatch(/^#[0-9a-f]{6}$/);
    expect(new Set(hexes).size).toBe(ALL.length);
  });

  it('maps every glyph to a terminal.ansi* theme key', () => {
    for (const g of ALL) expect(glyphThemeColorKey(g)).toMatch(/^terminal\.ansi/);
  });

  it('pairs red with the red hex and ansiRed', () => {
    expect(glyphHex('red')).toBe('#e35555');
    expect(glyphThemeColorKey('red')).toBe('terminal.ansiRed');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/model/glyphColor.test.ts`
Expected: FAIL — cannot find module `./glyphColor.js`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/model/glyphColor.ts
import type { Glyph } from './glyph.js';

/**
 * Decorates the existing status glyph (`glyphFor`, H1 single source) with the two
 * color representations the naming feature needs: a baked-in hex for tinted SVG
 * icons, and a `terminal.ansi*` ThemeColor key for the terminal tab label (the
 * VS Code API accepts only registered theme colors there, not arbitrary hex).
 * This map ONLY decorates the glyph — it never reinvents the glyph logic.
 */
const HEX: Record<Glyph, string> = {
  gray: '#7f8896',
  blue: '#3f8cff',
  amber: '#d99a2b',
  green: '#38a86b',
  red: '#e35555',
};

const THEME_KEY: Record<Glyph, string> = {
  gray: 'terminal.ansiBrightBlack',
  blue: 'terminal.ansiBlue',
  amber: 'terminal.ansiYellow',
  green: 'terminal.ansiGreen',
  red: 'terminal.ansiRed',
};

export function glyphHex(glyph: Glyph): string {
  return HEX[glyph];
}

export function glyphThemeColorKey(glyph: Glyph): string {
  return THEME_KEY[glyph];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/model/glyphColor.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/model/glyphColor.ts src/model/glyphColor.test.ts
git commit -m "feat: glyph→hex and glyph→ansi color maps"
```

---

## Task 2: `ticketGlyph` helper (extract the shared derivation)

**Files:**
- Create: `src/model/ticketGlyph.ts`, `src/model/ticketGlyph.test.ts`
- Modify: `src/ui/sidebar/items.ts:1-42`

**Interfaces:**
- Consumes: `TicketWithStages` (`src/store/tickets.ts`), `glyphFor` (`src/model/glyph.ts`).
- Produces: `currentStageStatus(t: TicketWithStages): StageStatus`, `ticketGlyph(t: TicketWithStages): Glyph`.

- [ ] **Step 1: Write the failing test**

```typescript
// src/model/ticketGlyph.test.ts
import { describe, it, expect } from 'vitest';
import type { TicketWithStages } from '../store/tickets.js';
import { ticketGlyph } from './ticketGlyph.js';

function ticket(over: Partial<TicketWithStages>): TicketWithStages {
  return {
    id: 1, key: 'KAR-1', title: 'T', source: null, stageCurrent: 'impl',
    agentState: 'idle', sessionId: null, description: null, brief: null,
    sourceRef: null, sourceFetchedAt: null, approach: null, agent: null,
    selectedRepos: [], archivedAt: null, model: null,
    stages: [{ stageKey: 'impl', status: 'running' } as never],
    ...over,
  } as TicketWithStages;
}

describe('ticketGlyph', () => {
  it('waiting agent → amber (needs-you wins)', () => {
    expect(ticketGlyph(ticket({ agentState: 'waiting' }))).toBe('amber');
  });
  it('failed current stage → red', () => {
    expect(ticketGlyph(ticket({ stageCurrent: 'impl', stages: [{ stageKey: 'impl', status: 'failed' } as never] }))).toBe('red');
  });
  it('running → blue', () => {
    expect(ticketGlyph(ticket({ agentState: 'running' }))).toBe('blue');
  });
  it('pending/idle → gray', () => {
    expect(ticketGlyph(ticket({ agentState: 'idle', stages: [{ stageKey: 'impl', status: 'pending' } as never] }))).toBe('gray');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/model/ticketGlyph.test.ts`
Expected: FAIL — cannot find module `./ticketGlyph.js`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/model/ticketGlyph.ts
import type { TicketWithStages } from '../store/tickets.js';
import type { StageStatus, AgentState } from './types.js';
import { glyphFor, type Glyph } from './glyph.js';

/** Status of the ticket's current stage, defaulting to pending when unknown. */
export function currentStageStatus(t: TicketWithStages): StageStatus {
  const cur = t.stages.find((s) => s.stageKey === t.stageCurrent);
  return cur?.status ?? 'pending';
}

/**
 * The one derivation every surface (sidebar, tabs, terminal, status bar) uses so
 * they all show the same color. Wraps the H1 `glyphFor` over a ticket.
 */
export function ticketGlyph(t: TicketWithStages): Glyph {
  return glyphFor(currentStageStatus(t), (t.agentState ?? 'none') as AgentState);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/model/ticketGlyph.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Refactor `items.ts` to reuse it (no behavior change)**

In `src/ui/sidebar/items.ts`: delete the local `currentStageStatus` (lines 22-26) and replace the glyph line. New top imports + node build:

```typescript
// src/ui/sidebar/items.ts (top)
import { ticketLabel, type TicketWithStages } from '../../store/tickets.js';
import { ticketGlyph, currentStageStatus } from '../../model/ticketGlyph.js';
import type { Glyph } from '../../model/glyph.js';
```

Replace the `buildTicketNodes` map body's glyph + description lines with:

```typescript
    glyph: ticketGlyph(t),
    description: `${t.stageCurrent ?? 'none'} (${currentStageStatus(t)})`,
```

(Remove the now-unused `StageStatus, AgentState` and `glyphFor` imports; keep `Glyph` for the `TicketNode` type.)

- [ ] **Step 6: Run the sidebar tests to verify no regression**

Run: `npx vitest run src/ui/sidebar`
Expected: PASS (unchanged behavior).

- [ ] **Step 7: Commit**

```bash
git add src/model/ticketGlyph.ts src/model/ticketGlyph.test.ts src/ui/sidebar/items.ts
git commit -m "refactor: extract ticketGlyph as the shared status-color derivation"
```

---

## Task 3: `terminalNameTemplate` manifest field

**Files:**
- Modify: `src/manifest/types.ts:144`, `src/manifest/schema.ts:295-303,368`, `src/manifest/write.ts:105`, `src/store/ticketLabelTemplate.ts:11`
- Modify: `src/ui/settings/webview.html:377-380,682-683,719-727`
- Test: `src/manifest/load.test.ts`, `src/manifest/write.test.ts`

**Interfaces:**
- Produces: `Manifest.terminalNameTemplate?: string`; `DEFAULT_TERMINAL_NAME_TEMPLATE` from `ticketLabelTemplate.ts`.

- [ ] **Step 1: Write the failing test**

Add to `src/manifest/load.test.ts` (near the `ticketLabelTemplate` cases):

```typescript
  it('accepts terminalNameTemplate and normalizes blank to undefined', () => {
    expect(loadManifestFrom({ ...base, terminalNameTemplate: 'Karst: {key}' }).terminalNameTemplate)
      .toBe('Karst: {key}');
    expect(loadManifestFrom({ ...base, terminalNameTemplate: '   ' }).terminalNameTemplate)
      .toBeUndefined();
  });

  it('rejects a non-string terminalNameTemplate', () => {
    expect(() => loadManifestFrom({ ...base, terminalNameTemplate: 5 as never })).toThrow(/terminalNameTemplate/);
  });
```

(Use the file's existing helper for building a valid raw manifest — mirror how the `ticketLabelTemplate` tests construct `base`/`loadManifestFrom`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/manifest/load.test.ts`
Expected: FAIL — `terminalNameTemplate` is `undefined` / no validation.

- [ ] **Step 3: Implement across the checklist**

`src/manifest/types.ts` — after the `ticketLabelTemplate` field (line 144):

```typescript
  /**
   * Terminal-name template with the same `{var}` tokens as ticketLabelTemplate.
   * Undefined → the default `'Karst: {key} — {title}'`. Blank normalizes to
   * undefined at validation. Rendered once at launch (terminals are static).
   */
  terminalNameTemplate?: string;
```

`src/store/ticketLabelTemplate.ts` — after `DEFAULT_TICKET_LABEL_TEMPLATE` (line 11):

```typescript
/** Terminal-name default — the historical `"Karst: <key> — <title>"` convention. */
export const DEFAULT_TERMINAL_NAME_TEMPLATE = 'Karst: {key} — {title}';
```

`src/manifest/schema.ts` — add a validator mirroring `validateTicketLabelTemplate` (after it, ~line 303):

```typescript
/** Parse `terminalNameTemplate` — string or throw; blank → undefined (default). */
function validateTerminalNameTemplate(raw: unknown): string | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string') {
    throw new ManifestError('terminalNameTemplate must be a string');
  }
  return raw.trim() === '' ? undefined : raw;
}
```

Wire into the `validateManifest` return (after the `ticketLabelTemplate` line, ~368):

```typescript
    terminalNameTemplate: validateTerminalNameTemplate(raw.terminalNameTemplate),
```

`src/manifest/write.ts` — overlay after `ticketLabelTemplate` (line 105):

```typescript
    // Optional: written when set, dropped when cleared, falls back to default.
    terminalNameTemplate: manifest.terminalNameTemplate,
```

- [ ] **Step 4: Run tests to verify pass**

Run: `npx vitest run src/manifest`
Expected: PASS — including `write.test.ts` "round-trips every modeled section".

- [ ] **Step 5: Add the settings webview field**

`src/ui/settings/webview.html` — after the label-template block (line 380):

```html
          <label for="f-terminalTemplate">Terminal name template</label>
          <input type="text" id="f-terminalTemplate" placeholder="Karst: {key} — {title}" />
```

In the `render` population (after line 682):

```javascript
    el('f-terminalTemplate').value = draft.terminalNameTemplate || '';
```

Add the input handler (after the `f-labelTemplate` handler, line 727):

```javascript
  el('f-terminalTemplate').addEventListener('input', () => {
    const v = el('f-terminalTemplate').value;
    if (v.trim() === '') delete draft.terminalNameTemplate;
    else draft.terminalNameTemplate = v;
    markDirty();
  });
```

- [ ] **Step 6: Typecheck + build assets**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/manifest src/store/ticketLabelTemplate.ts src/ui/settings/webview.html
git commit -m "feat: terminalNameTemplate manifest field + settings input"
```

---

## Task 4: Tinted glyph icons (`glyphIcon.ts`)

**Files:**
- Create: `src/ui/glyphIcon.ts`, `src/ui/glyphIcon.test.ts`

**Interfaces:**
- Consumes: `Glyph`, `glyphHex` (Task 1), `media/karst.svg`.
- Produces: `tintSvg(svg: string, hex: string): string` (pure); `glyphIconPath(glyph: Glyph, dir: { storageDir: string; assetSvgPath: string }): string` — writes the tinted SVG under `storageDir/icons/karst-<glyph>.svg` and returns the file path.

- [ ] **Step 1: Write the failing test**

```typescript
// src/ui/glyphIcon.test.ts
import { describe, it, expect } from 'vitest';
import { tintSvg } from './glyphIcon.js';

const SRC = '<svg stroke="currentColor"><circle/></svg>';

describe('tintSvg', () => {
  it('replaces every currentColor with the hex', () => {
    expect(tintSvg(SRC, '#e35555')).toBe('<svg stroke="#e35555"><circle/></svg>');
  });
  it('is a no-op when there is no currentColor', () => {
    expect(tintSvg('<svg stroke="#000"/>', '#e35555')).toBe('<svg stroke="#000"/>');
  });
  it('leaves the source string unmutated (returns a new string)', () => {
    const src = SRC;
    tintSvg(src, '#38a86b');
    expect(src).toBe(SRC);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/ui/glyphIcon.test.ts`
Expected: FAIL — cannot find module `./glyphIcon.js`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/ui/glyphIcon.ts
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Glyph } from '../model/glyph.js';
import { glyphHex } from '../model/glyphColor.js';

/** Bake a color into an SVG authored with `stroke="currentColor"` (pure). */
export function tintSvg(svg: string, hex: string): string {
  return svg.replaceAll('currentColor', hex);
}

/**
 * Materialize the karst logo tinted for `glyph` into `<storageDir>/icons/` and
 * return its path (for `iconPath`). Idempotent — written once per glyph.
 * `iconPath` renders a static image VS Code will not theme-tint, so the hue is
 * baked here rather than passed as a ThemeColor.
 */
export function glyphIconPath(
  glyph: Glyph,
  opts: { storageDir: string; assetSvgPath: string },
): string {
  const dir = join(opts.storageDir, 'icons');
  const file = join(dir, `karst-${glyph}.svg`);
  if (existsSync(file)) return file;
  mkdirSync(dir, { recursive: true });
  const src = readFileSync(opts.assetSvgPath, 'utf8');
  writeFileSync(file, tintSvg(src, glyphHex(glyph)), 'utf8');
  return file;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/ui/glyphIcon.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/ui/glyphIcon.ts src/ui/glyphIcon.test.ts
git commit -m "feat: runtime-tinted karst glyph icons"
```

---

## Task 5: Terminal — templated name + static glyph icon/color

**Files:**
- Modify: `src/ui/session.ts:16-28,90-128`, `src/ui/session.test.ts`
- Modify: `src/extension.ts:1245-1275` (makeTerminalHost), `src/extension.ts:900-962` (openSession call)

**Interfaces:**
- Consumes: `DEFAULT_TERMINAL_NAME_TEMPLATE`, `renderTicketLabel`, `ticketGlyph`, `glyphIconPath`, `glyphThemeColorKey`.
- Produces: `CreateTerminalOpts` gains `iconPath?: string`, `color?: string`; `openSession(..., naming?: { name: string; iconPath?: string; color?: string })`.

- [ ] **Step 1: Write the failing test**

Add to `src/ui/session.test.ts` (the file already builds a `FakeTerminal` host — reuse it):

```typescript
  it('uses the naming bag for terminal name, icon and color when provided', () => {
    const { manager, host } = makeManager(); // existing helper in this test file
    manager.openSession(1, '/wt', { key: 'KAR-1', title: 'T' }, undefined, undefined, undefined, undefined, {
      name: 'Karst: KAR-1 · impl',
      iconPath: '/store/icons/karst-blue.svg',
      color: 'terminal.ansiBlue',
    });
    const term = host.created[0]; // existing FakeTerminal capture
    expect(term.name).toBe('Karst: KAR-1 · impl');
    expect(term.iconPath).toBe('/store/icons/karst-blue.svg');
    expect(term.color).toBe('terminal.ansiBlue');
  });

  it('falls back to the Karst: <key> name when no naming bag is given', () => {
    const { manager, host } = makeManager();
    manager.openSession(2, '/wt', { key: 'KAR-2', title: 'T2' });
    expect(host.created[0].name).toBe('Karst: KAR-2');
  });
```

(If the test file's helper names differ, adapt to the existing `FakeTerminal`/host capture — do not invent new ones. Extend `FakeTerminal` in `session.ts` with `iconPath?`, `color?` fields so the fake records them.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/ui/session.test.ts`
Expected: FAIL — `naming` param unknown / `iconPath` not recorded.

- [ ] **Step 3: Extend the interfaces and `openSession`**

`src/ui/session.ts` — `CreateTerminalOpts` (line 16) gains two fields:

```typescript
export interface CreateTerminalOpts {
  name: string;
  description?: string;
  cwd: string;
  shellPath: string;
  shellArgs: string[];
  /** File path to a tinted icon SVG (real: mapped to `vscode.Uri.file`). */
  iconPath?: string;
  /** Terminal-color ThemeColor key (real: `new vscode.ThemeColor(color)`). */
  color?: string;
}
```

`FakeTerminal` (line 31) gains `iconPath?: string; color?: string;`.

`openSession` (line 90) — append a `naming` param and use it:

```typescript
  openSession(
    ticketId: number,
    worktreePath: string,
    label?: { key?: string | null; title?: string | null },
    initialPrompt?: string,
    extraArgs?: string[],
    model?: string,
    resume?: string,
    naming?: { name: string; iconPath?: string; color?: string },
  ): void {
```

Replace the `createTerminal` call (lines 115-121) with:

```typescript
    const terminal = this.host.createTerminal({
      name: naming?.name ?? `Karst: ${label?.key ?? `#${ticketId}`}`,
      description: naming ? undefined : (label?.title ?? undefined),
      cwd: worktreePath,
      shellPath: cmd.command,
      shellArgs: cmd.args,
      ...(naming?.iconPath ? { iconPath: naming.iconPath } : {}),
      ...(naming?.color ? { color: naming.color } : {}),
    });
```

- [ ] **Step 4: Map icon/color in the real host**

`src/extension.ts` `makeTerminalHost` (line 1245) — pass icon/color to `vscode.window.createTerminal`:

```typescript
      const name = opts.description ? `${opts.name} — ${opts.description}` : opts.name;
      const terminal = vscode.window.createTerminal({
        name,
        cwd: opts.cwd,
        shellPath: opts.shellPath,
        shellArgs: opts.shellArgs,
        ...(opts.iconPath ? { iconPath: vscode.Uri.file(opts.iconPath) } : {}),
        ...(opts.color ? { color: new vscode.ThemeColor(opts.color) } : {}),
      });
```

Also record `iconPath`/`color` in the returned `SessionTerminal`? Not needed — the interface only needs behavior.

- [ ] **Step 5: Render the name + resolve the glyph at the call site**

`src/extension.ts` `karst.openSession` handler — before the `sessions.openSession(...)` call (line ~955), compute naming. `t`, `context`, `HERE`, `currentManifest()` are in scope:

```typescript
      // `t` (line ~801) is already getTicket(localStore, ticketId) → TicketWithStages,
      // which satisfies both renderTicketLabel's fields and ticketGlyph. No re-fetch.
      const glyph = ticketGlyph(t);
      const naming = {
        name: renderTicketLabel(t, currentManifest()?.terminalNameTemplate ?? DEFAULT_TERMINAL_NAME_TEMPLATE),
        iconPath: glyphIconPath(glyph, {
          storageDir: context.globalStorageUri.fsPath,
          assetSvgPath: join(HERE, '..', 'media', 'karst.svg'),
        }),
        color: glyphThemeColorKey(glyph),
      };
```

Pass `naming` as the 8th arg to `sessions.openSession(ticketId, wt.path, { key: t.key, title: t.title }, seedPrompt, extraArgs, model, resumeId, naming)`.

Add imports at the top of `extension.ts`:

```typescript
import { renderTicketLabel, DEFAULT_TERMINAL_NAME_TEMPLATE } from './store/ticketLabelTemplate.js';
import { ticketGlyph } from './model/ticketGlyph.js';
import { glyphIconPath } from './ui/glyphIcon.js';
import { glyphThemeColorKey } from './model/glyphColor.js';
```

> Note: `getTicket(store, id)` (`src/store/tickets.ts:140`) already returns `TicketWithStages`, which satisfies BOTH `renderTicketLabel`'s `TicketLabelFields` shape AND `ticketGlyph`. So `t` (the existing `getTicket(localStore, ticketId)` at line ~801) covers name-render and glyph with no re-fetch. Verify `media/karst.svg` is copied into `dist/` by `scripts/copy-assets.mjs`; if not, add it there (mirror how the webview HTMLs are copied) and confirm `assetSvgPath` (`join(HERE, '..', 'media', 'karst.svg')`) resolves from the emitted `dist/` layout at runtime — adjust the relative path if `HERE` is `dist/`.

- [ ] **Step 6: Run tests + typecheck**

Run: `npx vitest run src/ui/session.test.ts && npm run typecheck`
Expected: PASS; no type errors.

- [ ] **Step 7: Commit**

```bash
git add src/ui/session.ts src/ui/session.test.ts src/extension.ts
git commit -m "feat: terminal name template + static glyph icon/color at launch"
```

---

## Task 6: Live glyph icon on webview tabs

**Files:**
- Modify: `src/ui/dashboard/panel.ts` (interface + manager), `src/ui/onboarding/panel.ts` (interface + manager)
- Modify: `src/extension.ts` (dashboard + onboarding hosts add `setIcon`; pass an icon resolver into the managers)
- Test: `src/ui/dashboard/panel.test.ts`, `src/ui/onboarding/panel.test.ts`

**Interfaces:**
- Consumes: `ticketGlyph`, `glyphIconPath`.
- Produces: `DashboardPanel.setIcon(path: string): void`; `OnboardingPanel.setIcon(path: string): void`; managers gain an injected `iconFor?: (ticketId: number) => string | undefined` called on open + each state push.

- [ ] **Step 1: Write the failing test**

Add to `src/ui/dashboard/panel.test.ts` (uses the existing `FakePanel`):

```typescript
  it('sets the tab icon on open and on each refresh from iconFor', () => {
    const icons: string[] = [];
    // build manager with iconFor: () => '/store/icons/karst-blue.svg'
    // (mirror the existing manager-construction helper in this test file, adding iconFor)
    // open + push a state refresh
    // FakePanel records setIcon calls into `icons`
    expect(icons).toContain('/store/icons/karst-blue.svg');
  });
```

Extend `FakePanel` (in `dashboard/panel.ts`) with `icons: string[]` and `setIcon(p){ this.icons.push(p) }`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/ui/dashboard/panel.test.ts`
Expected: FAIL — `setIcon` missing / `iconFor` unused.

- [ ] **Step 3: Extend the panel interface + manager**

`src/ui/dashboard/panel.ts` — add to `DashboardPanel`:

```typescript
  /** Update the tab icon (real: `panel.iconPath = Uri.file(path)`). */
  setIcon(path: string): void;
```

Add `setIcon(p: string): void;` to `FakePanel` with the `icons: string[]` recorder.

`DashboardManager` constructor gains an optional `private readonly iconFor?: (ticketId: number) => string | undefined`. In `openDashboard` after creating/revealing the panel, and in the state-push method (where it already calls `postMessage`/sets title), add:

```typescript
    const icon = this.iconFor?.(ticketId);
    if (icon) panel.setIcon(icon);
```

- [ ] **Step 4: Wire the real host + resolver in `extension.ts`**

`makePanelHost` `createPanel` return object — add:

```typescript
        setIcon: (p: string) => { panel.iconPath = vscode.Uri.file(p); },
```

When constructing `DashboardManager`, pass an `iconFor`:

```typescript
  (ticketId) => {
    const t = getTicket(localStore, ticketId);
    return t ? glyphIconPath(ticketGlyph(t), {
      storageDir: context.globalStorageUri.fsPath,
      assetSvgPath: join(HERE, '..', 'media', 'karst.svg'),
    }) : undefined;
  }
```

- [ ] **Step 5: Repeat for onboarding**

Apply the identical interface + manager + host changes to `src/ui/onboarding/panel.ts` and its host in `extension.ts` (onboarding `createPanel`, `src/ui/onboarding/host.ts:23` if that host is the live one — wire `setIcon` there too). Onboarding tickets may be pre-key; `glyphIconPath(ticketGlyph(t), ...)` still resolves (a fresh ticket → gray).

- [ ] **Step 6: Run tests + typecheck**

Run: `npx vitest run src/ui/dashboard src/ui/onboarding && npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/ui/dashboard/panel.ts src/ui/dashboard/panel.test.ts src/ui/onboarding/panel.ts src/ui/onboarding/panel.test.ts src/extension.ts
git commit -m "feat: live glyph-tinted icon on dashboard & onboarding tabs"
```

---

## Task 7: Live status-bar item

**Files:**
- Create: `src/ui/statusBar.ts`, `src/ui/statusBar.test.ts`
- Modify: `src/extension.ts` (create the host, render on openDashboard/openSession + refresh sweeps)

**Interfaces:**
- Consumes: `Glyph`.
- Produces: `statusBarText(v: StatusTicket): string` (pure); `StatusBarManager` with `render(v: StatusTicket | null)`; `StatusBarHost`.

```typescript
export interface StatusTicket { ticketId: number; key: string; stage: string; state: string; glyph: Glyph; }
export interface StatusBarHost {
  set(text: string, warning: boolean, command: { id: string; arg: unknown }): void;
  hide(): void;
}
```

- [ ] **Step 1: Write the failing test**

```typescript
// src/ui/statusBar.test.ts
import { describe, it, expect } from 'vitest';
import { statusBarText, StatusBarManager, type StatusBarHost, type StatusTicket } from './statusBar.js';

const base: StatusTicket = { ticketId: 7, key: 'KAR-7', stage: 'review', state: 'running', glyph: 'blue' };

describe('statusBarText', () => {
  it('renders key · stage · state', () => {
    expect(statusBarText(base)).toBe('KAR-7 · review · running');
  });
  it('prefixes a warning glyph when blocked (red)', () => {
    expect(statusBarText({ ...base, stage: 'fix', state: 'idle', glyph: 'red' })).toBe('⚠ KAR-7 · fix · idle');
  });
});

describe('StatusBarManager', () => {
  it('sets text + warning + click command, hides on null', () => {
    const calls: Array<{ text: string; warning: boolean; cmd: unknown } | 'hide'> = [];
    const host: StatusBarHost = {
      set: (text, warning, command) => calls.push({ text, warning, cmd: command.arg }),
      hide: () => calls.push('hide'),
    };
    const m = new StatusBarManager(host);
    m.render({ ...base, glyph: 'red', stage: 'fix' });
    m.render(null);
    expect(calls[0]).toEqual({ text: '⚠ KAR-7 · fix · running', warning: true, cmd: 7 });
    expect(calls[1]).toBe('hide');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/ui/statusBar.test.ts`
Expected: FAIL — cannot find module `./statusBar.js`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/ui/statusBar.ts
import type { Glyph } from '../model/glyph.js';

export interface StatusTicket {
  ticketId: number;
  key: string;
  stage: string;
  state: string;
  glyph: Glyph;
}

export interface StatusBarHost {
  set(text: string, warning: boolean, command: { id: string; arg: unknown }): void;
  hide(): void;
}

/** `KAR-7 · review · running`; a red glyph prefixes `⚠` (blocker, multi-channel). */
export function statusBarText(v: StatusTicket): string {
  const body = `${v.key} · ${v.stage} · ${v.state}`;
  return v.glyph === 'red' ? `⚠ ${body}` : body;
}

/** Drives one status-bar item for the active/focused ticket. */
export class StatusBarManager {
  constructor(private readonly host: StatusBarHost) {}

  render(v: StatusTicket | null): void {
    if (!v) {
      this.host.hide();
      return;
    }
    this.host.set(statusBarText(v), v.glyph === 'red', {
      id: 'karst.openDashboard',
      arg: v.ticketId,
    });
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/ui/statusBar.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Wire the real host + render points in `extension.ts`**

Create the host near activation:

```typescript
  const sbItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  context.subscriptions.push(sbItem);
  const statusBar = new StatusBarManager({
    set: (text, warning, command) => {
      sbItem.text = text;
      sbItem.backgroundColor = warning ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
      sbItem.command = { command: command.id, title: 'Open dashboard', arguments: [command.arg] };
      sbItem.show();
    },
    hide: () => sbItem.hide(),
  });
```

Add a helper that renders the current ticket and call it from `karst.openDashboard` and `karst.openSession` handlers (and any driver refresh sweep that already re-reads a ticket):

```typescript
  const showStatusFor = (ticketId: number): void => {
    const t = getTicket(localStore, ticketId);
    if (!t) { statusBar.render(null); return; }
    statusBar.render({
      ticketId, key: t.key ?? `#${ticketId}`,
      stage: t.stageCurrent ?? 'none', state: t.agentState ?? 'none',
      glyph: ticketGlyph(t),
    });
  };
```

Call `showStatusFor(ticketId)` at the end of the `openDashboard` and `openSession` command handlers.

Import: `import { StatusBarManager } from './ui/statusBar.js';`

- [ ] **Step 6: Run tests + typecheck**

Run: `npx vitest run src/ui/statusBar.test.ts && npm run typecheck`
Expected: PASS; no type errors.

- [ ] **Step 7: Commit**

```bash
git add src/ui/statusBar.ts src/ui/statusBar.test.ts src/extension.ts
git commit -m "feat: live status-bar item for the active ticket"
```

---

## Task 8: Tint the sidebar row logo

**Files:**
- Modify: `src/ui/sidebar/webview.html` (row render — map `glyph` → hex, tint the logo)

**Interfaces:**
- Consumes: `TicketRow.glyph` (already present in the pushed state).

- [ ] **Step 1: Locate the current glyph render**

Run: `grep -n "glyph" src/ui/sidebar/webview.html`
Read the row-render function to see how `glyph` currently renders (a colored dot / class).

- [ ] **Step 2: Add the glyph→hex mirror + tinted logo**

In the webview `<script>`, add the mirror map (webviews can't import TS — mirror `glyphColor.ts`, add a matching source comment):

```javascript
  // Mirror of src/model/glyphColor.ts — keep in sync.
  const GLYPH_HEX = { gray:'#7f8896', blue:'#3f8cff', amber:'#d99a2b', green:'#38a86b', red:'#e35555' };
```

Render the karst mark inline, tinted, in place of (or alongside) the existing dot — use the logo path from `media/karst.svg`:

```javascript
  const hex = GLYPH_HEX[row.glyph] || GLYPH_HEX.gray;
  const mark = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="${hex}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="6" r="2.4"/><circle cx="18" cy="6" r="2.4"/><circle cx="12" cy="18" r="2.4"/><path d="M7.6 7.6 10.7 15.6"/><path d="M16.4 7.6 13.3 15.6"/><path d="M8 6h8"/></svg>`;
```

Insert `mark` where the row marker goes.

- [ ] **Step 3: Verify the sidebar state test still passes**

Run: `npx vitest run src/ui/sidebar`
Expected: PASS (state model unchanged; `glyph` still on every row).

- [ ] **Step 4: Build + manual check**

Run: `npm run build`
Then F5 → confirm sidebar rows show the tinted karst mark; a waiting ticket is amber, a failed one red. (If ABI blocks activation, apply the Task-9 note.)

- [ ] **Step 5: Commit**

```bash
git add src/ui/sidebar/webview.html
git commit -m "feat: tint sidebar row logo by status glyph"
```

---

## Task 9: Full-suite green + manual smoke

**Files:** none (verification).

- [ ] **Step 1: Run the whole suite + typecheck**

Run: `npm test && npm run typecheck`
Expected: all green. (`pretest` rebuilds better-sqlite3 for Node.)

- [ ] **Step 2: Manual smoke in the Extension Dev Host**

Run: `npm run build`, then F5. If activation fails on a better-sqlite3 ABI mismatch (this machine is Electron 42 / ABI 146 while `rebuild:electron` may copy Cursor's ABI): run
`BETTER_SQLITE3_ABI=146 node scripts/rebuild-better-sqlite3.mjs electron` (or source-build for the detected Electron), then reload the window (do NOT re-F5, which re-runs the wrong-ABI copy). This is a known pre-existing bug, tracked separately — not part of this feature.

Confirm: dashboard tab icon tints & updates on stage change; terminal launches with the karst logo + stage-in-name + a stage-appropriate color; status bar shows `KEY · stage · state`, warning-tinted when blocked; sidebar rows tinted.

- [ ] **Step 3: Final commit (if any smoke fixes)**

```bash
git add -A && git commit -m "chore: naming & status polish from smoke test"
```

---

## Self-Review

- **Spec coverage:** terminalNameTemplate (T3) ✓; tinted icons (T4) ✓; terminal static icon/color (T5) ✓; live tab icons (T6) ✓; status bar (T7) ✓; sidebar tint (T8) ✓; reuse glyph / no new palette (T1–T2) ✓; blocker multi-channel = red hex + `⚠` status text + `{stage}` text (T5/T7/T8) ✓. Out-of-scope items (pty, per-stage palette, gate-name tracking, rebuild-script fix) correctly absent.
- **Placeholder scan:** every code step carries real code; the two webview/test-helper adaptation notes (T5 FakeTerminal, T6 manager helper) point at existing named constructs, not TODOs.
- **Type consistency:** `Glyph` from `glyph.ts` throughout; `glyphHex`/`glyphThemeColorKey` (T1) used in T4/T5/T7; `ticketGlyph` (T2) used in T5/T6/T7; `StatusTicket`/`StatusBarHost` consistent across T7 test + impl + wiring; `CreateTerminalOpts.iconPath/color` (T5) consumed by the real host in the same task.
