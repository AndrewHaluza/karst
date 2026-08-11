# Xterm Console Output in Dashboard (Detailed Mode) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render a gate stage's console output (the `uat`/`review` artifact log) as an interactive xterm.js terminal inside the dashboard webview — a "detailed mode" that shows the full ANSI-colored output instead of opening a VS Code editor.

**Architecture:** Deliver xterm.js the same way the design system ships: vendored files copied into `dist/vendor/xterm/`, inlined into the self-contained dashboard webview at panel-build time via `/*KARST_XTERM_CSS*/`/`/*KARST_XTERM_JS*/` markers, BEFORE `injectCsp` so the nonce pass authorizes the injected `<script>`. The webview opens a full-body terminal surface (`#termView`, mirroring the existing `#artView` swap via `body.term-nav`) on demand; the host resolves the stage's artifact path from the store — the webview sends only a closed-vocabulary `stage` key, never a path — reads the file, and posts the content back for `term.write()`.

**Tech Stack:** `@xterm/xterm@6.0.0` (UMD `lib/xterm.js`, attaches `globalThis.Terminal`), `@xterm/addon-fit@0.11.0` (UMD `lib/addon-fit.js`, attaches `globalThis.FitAddon`), xterm CSS `css/xterm.css`. No bundler, no new CSP directives, no new delivery mechanism.

## Research: findings and decisions (the ticket's research deliverable)

**What exists today.** Gate output is captured into one `BoundedOutput` (1 MiB byte-prefix, raw bytes, ANSI preserved) per process in `src/workflow/gates/run.ts`, and written ONCE at stage end to `<globalStorage>/artifacts/<ticketId>/uat-ticket-<id>.log` / `review-ticket-<id>.log` (`stages.artifact_path`, via `commitGateOutcome`). Nothing is stored in the DB, and nothing streams live. The dashboard renders one-line gate summaries (`exit N`, `model/inside/gates.ts`) and opens the full log in a VS Code editor (`open-stage-log` message → `extension.ts` `openStageLog`).

**Why xterm.** The artifact log is raw text with ANSI SGR sequences preserved (nothing strips them at capture). A real terminal emulator renders those faithfully, gives selection/copy and scrollback, and is the same library VS Code's own terminal webview runs. Alternatives (ANSI→HTML conversion, a `<pre>` with color spans) re-implement selection/wrapping and would need the same inlining anyway. The research verdict: xterm is the right component; the binding question is *delivery*, answered below.

**Delivery: inline via marker injection, never a second mechanism.** Every webview is a self-contained document under `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-<n>'`. `ui/webviewCsp.test.ts` DISCOVERS every webview and fails on any `<link>`, `<script src=`, `url(http...)`, `@font-face` or `fetch(`. `model/designSystem.ts` explicitly documents an `asWebviewUri` stylesheet/script as *technically viable but deliberately unused* — "Karst simply does not introduce a second delivery mechanism". So xterm must ride the existing mechanism: a marker in the HTML, a TS module emitting text, one host-side inject call. Verified against the actual packages (this is the load-bearing research):

- `@xterm/xterm@6.0.0` `lib/xterm.js` = 488,663 B UMD that assigns its exports onto `globalThis` (so `window.Terminal` exists after load). Zero occurrences of the literal `<script` (so `injectCsp`'s `replaceAll('<script>', ...)` cannot corrupt it), zero `eval(`/`new Function(`, no external URLs (the three `http://www.w3.org` hits are SVG namespace identifiers, not fetches). CSS `css/xterm.css` = 7,112 B, zero `url()`.
- `@xterm/addon-fit@0.11.0` `lib/addon-fit.js` = 1,521 B UMD attaching `globalThis.FitAddon = { FitAddon: class }`.
- Cost: ~490 KB extra parsed per dashboard panel open — the accepted price of keeping the architecture's single-delivery invariant.

**Data flow: host reads, webview renders.** The webview is a trust boundary and must never name a file: `open-stage-log` today carries a raw `path` (the one message that does — flagged in `messages.ts`), and the newer `artifact-open-resource` pattern (id + index, host re-derives) is the model to follow. The new pair: webview → host `{type:'stage-log-request'; stage}` with `stage` narrowed to the closed `GATE_STAGES` set (no path, no ticket id — the panel closure owns the ticket); host resolves the stage row's `artifactPath` from the store, reads the file, posts `{type:'stage-log'; stage; result}` where `result` is a discriminated union `{kind:'ok'; content; truncated} | {kind:'error'; message}`.

**Live streaming is OUT OF SCOPE** (explicitly): output is not observable mid-run — `BoundedOutput` lives inside `runProcess`'s closure and the progress events (`model/inside/progress.ts`) carry no output text. Streaming would be a separate ticket touching the driver seam (`RunCommandOptions.onOutput` → evidence → panel). The ticket's "detailed mode" is satisfied by rendering the recorded log.

**Theme.** The terminal must match the design system (UI-R04/R29): `background`/`foreground`/`cursor`/`selectionBackground` resolve from the injected tokens via `getComputedStyle` on `--k-bg`/`--k-text`/`--k-focus`/`--k-surface-selected` (concrete values — the webview resolves the `var(--vscode-*)` chains itself); font from `--k-font-mono`, size from `--k-text-base`. The ANSI 16 ramp stays xterm's standard terminal palette (mid-tone, legible on both themes); the two mandatory overrides are bg/fg, which are theme-provided so their contrast is the theme's contract (UI-R29).

## Global Constraints

- **CSP untouched**: `default-src 'none'` and nonce-only `script-src` stay for every webview; the vendored JS must contain no `<script` literal and no `eval(`/`new Function(` (pinned by tests, Task 2).
- **Injection order is load-bearing**: `injectXterm` joins `dashboardWebviewHtml()`'s chain and must run BEFORE `injectCsp` (same rule as `injectDesignSystem`), so the nonce pass tags the injected `<script>`.
- **Webview never names a file**: `stage-log-request` carries `stage: GateStage` only — no path, no ticket id. The host resolves `stages.artifact_path` itself.
- **No new delivery mechanism**: assets travel `node_modules → dist/vendor/xterm/` via `scripts/copy-assets.mjs`; the source `webview.html` keeps markers, runtime injection fills them (mirror of the design system).
- **No `<script>` count change in the source webview**: the xterm JS marker sits INSIDE the existing single `<script>` block (the test harness `previewScriptSource()` extracts the first block); the CSS marker sits inside the main `<style>` after `/*KARST_DS_CSS*/`.
- `@xterm/xterm`/`@xterm/addon-fit` are **devDependencies** (build-time asset sources; the vsix ships the `dist/vendor/xterm` copies, not the npm packages — `.vscodeignore` gains `node_modules/@xterm/**`).
- Closed vocabularies (UI-R16): `stage-log-request` accepts only `GATE_STAGES`; `StageLogResult` is a two-variant discriminated union.
- Mirrored behavior pins (UI-R34): the webview's console entry points read HOST-derived state (`view.console` / `failed.artifactPath`), never invent availability.
- Rule citations for commits (UI-R35): UI-R01 (vendored terminal primitive, not a UI framework), UI-R04/R05 (theme from tokens), UI-R09 (real `<button>` for Console/Close), UI-R11–R14 (loading state + guaranteed terminal outcome), UI-R16 (closed message vocabularies), UI-R20/R21 (title/aria-name agreement), UI-R24, UI-R29 (bg/fg from theme-provided colors).
- Every new host module receives `logger.debug` per the Debug Logging Rules (entry/decision/exit); the reader module is host-agnostic and takes `debug` injected.

---

### Task 1: Vendored xterm assets + injection module

**Files:**
- Modify: `package.json` (devDependencies)
- Modify: `scripts/copy-assets.mjs`
- Create: `src/model/xtermAssets.ts`
- Create: `src/model/xtermAssets.test.ts`
- Modify: `.vscodeignore`

**Interfaces:**
- Consumes: nothing (foundation task).
- Produces:
  - `export const XTERM_CSS_MARKER = '/*KARST_XTERM_CSS*/'`
  - `export const XTERM_JS_MARKER = '/*KARST_XTERM_JS*/'`
  - `export interface XtermAssets { css: string; js: string }`
  - `export function readXtermAssets(dir: string): XtermAssets` — reads `xterm.css`, `xterm.js`, `addon-fit.js` from `dir`, returns `{ css, js: xtermJs + '\n' + addonFitJs }`; throws `EACCES`/`ENOENT` verbatim if a file is missing (a missing vendor file is a broken build, must fail loudly at panel build).
  - `export function injectXterm(html: string, assets: XtermAssets): string` — replaces both markers with the asset text via **function replacers** (never string replacements: `String.replace` treats `$&`/`$'` in the replacement as substitutions and the vendored JS contains `$'`-shaped text); no-op per marker if absent.
  - dist layout produced by copy-assets: `dist/vendor/xterm/{xterm.js,xterm.css,addon-fit.js}`.

- [ ] **Step 1: Write the failing tests** — `src/model/xtermAssets.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { injectXterm, readXtermAssets, XTERM_CSS_MARKER, XTERM_JS_MARKER } from './xtermAssets.js';

describe('xterm asset injection', () => {
  it('replaces both markers with the asset text via function replacers ($&-safe)', () => {
    // The replacement must land VERBATIM: String.replace would treat `$&`/`$'`
    // in a string replacement as substitutions, and the vendored JS is full of
    // `$'`-shaped text (minified source).
    const html = `<style>${XTERM_CSS_MARKER}</style><script>${XTERM_JS_MARKER}</script>`;
    const css = '.xterm{color:red}';
    const js = "var a = '$&'; var b = \"$'\";";
    const out = injectXterm(html, { css, js });
    expect(out).toContain('<style>.xterm{color:red}</style>');
    expect(out).toContain(`var a = '$&'; var b = "$'";`);
    expect(out).not.toContain(XTERM_JS_MARKER);
    expect(out).not.toContain(XTERM_CSS_MARKER);
  });

  it('is a no-op per marker when absent (same contract as injectPalette)', () => {
    const html = '<style>/*KARST_DS_CSS*/</style><script>run();</script>';
    expect(injectXterm(html, { css: 'c', js: 'j' })).toBe(html);
  });
});

describe('readXtermAssets', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'karst-xterm-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('concatenates xterm.js and addon-fit.js after the css', () => {
    mkdirSync(dir);
    writeFileSync(join(dir, 'xterm.css'), 'css-body');
    writeFileSync(join(dir, 'xterm.js'), 'xterm-body');
    writeFileSync(join(dir, 'addon-fit.js'), 'fit-body');
    expect(readXtermAssets(dir)).toEqual({ css: 'css-body', js: 'xterm-body\nfit-body' });
  });

  it('throws the raw fs error when a vendor file is missing', () => {
    mkdirSync(dir);
    writeFileSync(join(dir, 'xterm.js'), 'x');
    writeFileSync(join(dir, 'addon-fit.js'), 'f');
    expect(() => readXtermAssets(dir)).toThrow(/ENOENT|xterm\.css/);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/model/xtermAssets.test.ts`
Expected: FAIL — module `./xtermAssets.js` does not exist.

- [ ] **Step 3: Write `src/model/xtermAssets.ts`**

```ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * xterm.js delivery — the SAME mechanism as the design system: a marker in the
 * HTML, a module emitting text, one host-side inject call. No second delivery
 * mechanism (CSP `default-src 'none'` + nonce-only scripts forbid a `<link>` or
 * `<script src>`; the asWebviewUri path is documented as deliberately unused in
 * designSystem.ts). The vendored files are npm devDependencies copied to
 * `dist/vendor/xterm/` by scripts/copy-assets.mjs; `dashboardWebviewHtml()`
 * reads them and injects BEFORE `injectCsp`, so the nonce pass tags the script.
 */

export const XTERM_CSS_MARKER = '/*KARST_XTERM_CSS*/';
export const XTERM_JS_MARKER = '/*KARST_XTERM_JS*/';

export interface XtermAssets {
  css: string;
  js: string;
}

/** Read the three vendored files; js is the two UMD bundles concatenated. */
export function readXtermAssets(dir: string): XtermAssets {
  return {
    css: readFileSync(join(dir, 'xterm.css'), 'utf8'),
    js:
      readFileSync(join(dir, 'xterm.js'), 'utf8') +
      '\n' +
      readFileSync(join(dir, 'addon-fit.js'), 'utf8'),
  };
}

/**
 * Replace both markers. Function replacers, never strings: `String.replace`
 * treats `$&`, `$'` and friends in a string replacement as substitutions, and
 * the vendored JS must land verbatim. No-op per marker if absent.
 */
export function injectXterm(html: string, assets: XtermAssets): string {
  return html
    .replace(XTERM_CSS_MARKER, () => assets.css)
    .replace(XTERM_JS_MARKER, () => assets.js);
}
```

- [ ] **Step 4: Install the dependencies**

```bash
npm install --save-dev @xterm/xterm@6.0.0 @xterm/addon-fit@0.11.0
```

- [ ] **Step 5: Add the copy step** — `scripts/copy-assets.mjs`, after the existing `rootAssets` loop:

```js
// Vendored webview libraries (xterm.js): npm devDependencies are build-time
// asset SOURCES only — the extension never requires them at runtime. The
// runtime reads dist/vendor/xterm/* (inlined into the dashboard webview by
// src/model/xtermAssets.ts), and .vscodeignore excludes node_modules/@xterm.
const vendorAssets = [
  ['node_modules/@xterm/xterm/lib/xterm.js', 'vendor/xterm/xterm.js'],
  ['node_modules/@xterm/xterm/css/xterm.css', 'vendor/xterm/xterm.css'],
  ['node_modules/@xterm/addon-fit/lib/addon-fit.js', 'vendor/xterm/addon-fit.js'],
];

for (const [from, rel] of vendorAssets) {
  const to = join(root, 'dist', rel);
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(join(root, from), to);
  console.log(`copied ${rel}`);
}
```

- [ ] **Step 6: Exclude the npm packages from the shipped vsix** — `.vscodeignore`, beside the existing "Keep:" comment:

```
# Vendored webview libs ship as dist/vendor/xterm copies, never as npm packages.
node_modules/@xterm/**
```

- [ ] **Step 7: Run tests and build to verify**

Run: `npm run build && npx vitest run src/model/xtermAssets.test.ts`
Expected: build copies the three vendor files into `dist/vendor/xterm/` (console logs each); PASS.

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json scripts/copy-assets.mjs .vscodeignore src/model/xtermAssets.ts src/model/xtermAssets.test.ts
git commit -m "feat: vendor xterm.js assets and add marker-injection module (UI-R35 research)"
```

---

### Task 2: Vendor CSP-compatibility pins

**Files:**
- Create: `src/ui/xtermVendor.test.ts`

**Interfaces:**
- Consumes: `src/model/xtermAssets.ts`'s `readXtermAssets` (Task 1).
- Produces: the proof that the vendored files satisfy the CSP constraints `injectCsp` and `ui/webviewCsp.test.ts` assume — an upgrade that changes the bundle shape fails loudly here.

- [ ] **Step 1: Write the failing test** — `src/ui/xtermVendor.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readXtermAssets } from '../model/xtermAssets.js';

// node_modules is a build/test-time presence; the extension itself reads
// dist/vendor/xterm (copied by scripts/copy-assets.mjs from these files).
const VENDOR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'node_modules', '@xterm');

describe('vendored xterm bundles are CSP-safe to inline', () => {
  const assets = readXtermAssets(join(VENDOR, 'xterm', 'lib'));

  it('keeps the bundles within their delivery budgets', () => {
    const js = assets.js;
    const css = assets.css;
    // xterm.js UMD is ~489 KB, addon-fit ~1.5 KB, css ~7 KB. The bounds are
    // generous slack; a package that swaps to a different bundle format (e.g.
    // an ESM-only build or an unbundled tree) will trip one of them.
    expect(js.length).toBeGreaterThan(100_000);
    expect(js.length).toBeLessThan(700_000);
    expect(css.length).toBeGreaterThan(1_000);
    expect(css.length).toBeLessThan(50_000);
  });

  it('contains no <script literal (injectCsp nonces by replaceAll of <script>)', () => {
    // injectCsp does html.replaceAll('<script>', '<script nonce=...>') over the
    // WHOLE document — a literal `<script` inside the vendored JS would either
    // get corrupted or leave an untagged script. The source `webview.html`
    // cannot carry the content, so this is the test that pins it.
    expect(assets.js).not.toContain('<script');
    expect(assets.js).not.toContain('</script');
  });

  it('contains no eval or Function constructor (nonce CSP blocks them silently)', () => {
    expect(assets.js).not.toMatch(/\beval\(|new Function\(/);
  });

  it('contains no external url() or font-face (default-src none)', () => {
    expect(assets.css).not.toMatch(/url\(/);
    expect(assets.css).not.toMatch(/@font-face/);
  });

  it('is a UMD bundle that attaches to the global object', () => {
    // The dashboard script reads `Terminal`/`FitAddon` as bare globals after
    // the injected block runs. The UMD wrapper assigns its exports onto
    // globalThis in a browser (no module/exports/define present).
    expect(assets.js).toContain('globalThis');
    expect(assets.js).toContain('exports');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/ui/xtermVendor.test.ts`
Expected: FAIL — `../model/xtermAssets.js` import fails or files not found (test first).

- [ ] **Step 3: Run after Task 1 and confirm all pins pass**

Run: `npx vitest run src/ui/xtermVendor.test.ts`
Expected: PASS — every assertion verified against the real `@xterm/xterm@6.0.0` / `@xterm/addon-fit@0.11.0` bundles.

- [ ] **Step 4: Commit**

```bash
git add src/ui/xtermVendor.test.ts
git commit -m "test: pin vendored xterm bundles to the webview CSP constraints"
```

---

### Task 3: Message protocol — `stage-log-request` and `stage-log`

**Files:**
- Modify: `src/ui/dashboard/messages.ts`
- Modify: `src/ui/dashboard/messages.test.ts`

**Interfaces:**
- Consumes: `GATE_STAGES`/`GateStage` (already imported in messages.ts), `isGateStage` (already defined, messages.ts:379).
- Produces:
  - `WebviewMessage` gains `| { type: 'stage-log-request'; stage: GateStage }`
  - `HostMessage` gains `| { type: 'stage-log'; stage: GateStage; result: StageLogResult }`
  - `export type StageLogResult = { kind: 'ok'; content: string; truncated: boolean } | { kind: 'error'; message: string }`
  - `DashboardActions` gains `requestStageLog: (stage: GateStage) => void | Promise<void>`
  - `parseWebviewMessage` case `'stage-log-request'` (isGateStage narrowing — a non-gate stage drops the whole message); `routeAction` case dispatching to `actions.requestStageLog(msg.stage)`.
  - Later consumers (Task 4 reader, Task 5 manager, Task 7 webview) build on exactly these names.

- [ ] **Step 1: Write the failing tests** — append to `src/ui/dashboard/messages.test.ts`:

```ts
describe('stage-log-request', () => {
  it('accepts a gate stage (uat/review) only — closed vocabulary (UI-R16)', () => {
    expect(parseWebviewMessage({ type: 'stage-log-request', stage: 'uat' })).toEqual({
      type: 'stage-log-request',
      stage: 'uat',
    });
    expect(parseWebviewMessage({ type: 'stage-log-request', stage: 'review' })).toEqual({
      type: 'stage-log-request',
      stage: 'review',
    });
    // Non-gate stages, missing stage, and wrong types all drop the message.
    expect(parseWebviewMessage({ type: 'stage-log-request', stage: 'impl' })).toBeNull();
    expect(parseWebviewMessage({ type: 'stage-log-request', stage: 'ship' })).toBeNull();
    expect(parseWebviewMessage({ type: 'stage-log-request' })).toBeNull();
    expect(parseWebviewMessage({ type: 'stage-log-request', stage: 42 })).toBeNull();
  });

  it('routes to requestStageLog with the validated stage', () => {
    const calls: string[] = [];
    routeAction({ type: 'stage-log-request', stage: 'review' }, {
      ...actions(),
      requestStageLog: (stage) => void calls.push(stage),
    });
    expect(calls).toEqual(['review']);
  });

  it('never routes an unparsed stage-log-request (unknown stays silent)', () => {
    let called = false;
    routeAction({ type: 'stage-log-request', stage: 'done' }, {
      ...actions(),
      requestStageLog: () => void (called = true),
    });
    expect(called).toBe(false);
  });
});
```

(The suite's existing helper is `function actions(): DashboardActions` at messages.test.ts:12 — Task 3 also adds `requestStageLog` to that literal, or the spread overrides it; either way the test compiles.)

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/ui/dashboard/messages.test.ts`
Expected: FAIL — `stage-log-request` is not a known discriminant.

- [ ] **Step 3: Implement** — `src/ui/dashboard/messages.ts`:

In the `WebviewMessage` union (after the `artifact-open-resource` member):

```ts
  /**
   * Ask the host to push one gate stage's console log (the uat/review artifact
   * file) for the terminal "detailed mode" view. Carries the STAGE only — a
   * closed vocabulary: no path, no ticket id (the panel closure owns the
   * ticket), exactly like `set-disabled-gates`. The host resolves the stage
   * row's recorded artifactPath from the store, reads it, and answers with
   * `stage-log`; the answer message (ok or error) is the terminal outcome.
   */
  | { type: 'stage-log-request'; stage: GateStage };
```

In the `HostMessage` union (after `gate-options`):

```ts
  /**
   * The answer to `stage-log-request`: the console log content for one gate
   * stage, or a named refusal. The `result` union is closed — the webview
   * renders exactly these two shapes. `truncated` is true when the file was
   * cut at the read cap (defensive; the recording itself caps at 1 MiB).
   */
  | { type: 'stage-log'; stage: GateStage; result: StageLogResult };
```

Add the exported union type (near `InsideActionResult`):

```ts
/** The terminal outcome of a `stage-log-request` (UI-R13). */
export type StageLogResult =
  | { kind: 'ok'; content: string; truncated: boolean }
  | { kind: 'error'; message: string };
```

In `DashboardActions` (after `openStageLog`):

```ts
  /** Push one gate stage's console log to the panel; the `stage-log` message is the outcome. */
  requestStageLog: (stage: GateStage) => void | Promise<void>;
```

In `parseWebviewMessage`'s switch (after the `artifact-open-resource` case):

```ts
    // The stage is narrowed to GATE_STAGES here, at the trust boundary; a
    // non-gate stage (or a malformed payload) drops the whole message.
    case 'stage-log-request':
      return isGateStage(m.stage) ? { type: 'stage-log-request', stage: m.stage } : null;
```

In `routeAction`'s switch (after `artifact-open-resource`):

```ts
    case 'stage-log-request':
      return actions.requestStageLog(msg.stage);
```

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run src/ui/dashboard/messages.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ui/dashboard/messages.ts src/ui/dashboard/messages.test.ts
git commit -m "feat: add stage-log-request/stage-log message pair for terminal console view (UI-R16)"
```

---

### Task 4: Host-side log reader

**Files:**
- Modify: `src/store/stages.ts`
- Create: `src/ui/dashboard/stageLogReader.ts`
- Create: `src/ui/dashboard/stageLogReader.test.ts`

**Interfaces:**
- Consumes: `Store` (`src/store/db.ts`), `StageKey` (`src/model/types.ts`), `GateStage` (`src/store/ticketGates.ts`), `StageLogResult` (Task 3), `rowToStage`/`StageRow` (`src/store/stages.ts`).
- Produces:
  - `export function getStage(store: Store, ticketId: number, stageKey: StageKey): Stage | null` in `store/stages.ts` — reads the row, returns `rowToStage` result, null when absent.
  - `export const STAGE_LOG_READ_CAP_BYTES = 2 * 1024 * 1024` in `stageLogReader.ts` — defensive bound; the recording itself caps at 1 MiB + marker + headers.
  - `export function readStageLog(store: Store, ticketId: number, stage: GateStage, readFile: (path: string) => string): StageLogResult` — resolves the stage row, requires a non-empty `artifactPath` (else `{kind:'error', message:'This stage has no recorded console log.'}`), reads the file (a missing/unreadable file → `{kind:'error', message:'The recorded log file is no longer available.'}`), caps at `STAGE_LOG_READ_CAP_BYTES` with a truncation marker and `truncated: true`.
  - `logger.debug` entry/decision/exit per the Debug Logging Rules, via an injected `debug?: (msg: string) => void` param (host-agnostic module, never imports the logger).

- [ ] **Step 1: Write the failing tests** — `src/ui/dashboard/stageLogReader.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../../store/db.js';
import { setStage } from '../../store/stages.js';
import { createTicket } from '../../store/tickets.js';
import { readStageLog, STAGE_LOG_READ_CAP_BYTES } from './stageLogReader.js';

const read = (p: string): string => readFileSync(p, 'utf8');

describe('readStageLog', () => {
  it('returns the artifact file content for a gate stage that has one', () => {
    const store = openStore(':memory:');
    const ticketId = createTicket(store, { projectId: 1, key: 'K-1', title: 't' });
    setStage(store, ticketId, 'uat', { artifactPath: '/tmp/karst-uat.log' });
    const dir = mkdtempSync(join(tmpdir(), 'karst-log-'));
    const path = join(dir, 'uat.log');
    writeFileSync(path, '# gate (exit 0)\n\x1b[32mpass\x1b[0m\n');
    setStage(store, ticketId, 'uat', { artifactPath: path });

    const result = readStageLog(store, ticketId, 'uat', read);
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.content).toContain('\x1b[32mpass\x1b[0m');
      expect(result.truncated).toBe(false);
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it('refuses a stage with no recorded artifact (error, never invented content)', () => {
    const store = openStore(':memory:');
    const ticketId = createTicket(store, { projectId: 1, key: 'K-2', title: 't' });
    const result = readStageLog(store, ticketId, 'review', read);
    expect(result).toEqual({ kind: 'error', message: 'This stage has no recorded console log.' });
  });

  it('reports a missing file as error, never a throw', () => {
    const store = openStore(':memory:');
    const ticketId = createTicket(store, { projectId: 1, key: 'K-3', title: 't' });
    setStage(store, ticketId, 'uat', { artifactPath: '/tmp/does-not-exist-869e7n906.log' });
    const result = readStageLog(store, ticketId, 'uat', read);
    expect(result.kind).toBe('error');
  });

  it('caps oversized files and marks them truncated', () => {
    const store = openStore(':memory:');
    const ticketId = createTicket(store, { projectId: 1, key: 'K-4', title: 't' });
    const dir = mkdtempSync(join(tmpdir(), 'karst-log-'));
    const path = join(dir, 'big.log');
    writeFileSync(path, 'x'.repeat(STAGE_LOG_READ_CAP_BYTES + 100));
    setStage(store, ticketId, 'uat', { artifactPath: path });

    const result = readStageLog(store, ticketId, 'uat', read);
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.truncated).toBe(true);
      expect(result.content.length).toBeLessThan(STAGE_LOG_READ_CAP_BYTES + 200);
      expect(result.content).toContain('[console output truncated]');
    }
    rmSync(dir, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/ui/dashboard/stageLogReader.test.ts`
Expected: FAIL — `stageLogReader.js` does not exist (and `getStage` not defined).

- [ ] **Step 3: Add `getStage` to `src/store/stages.ts`** (after `rowToStage`):

```ts
/** Read one stage row; null when the ticket has no row for that stage yet. */
export function getStage(store: Store, ticketId: number, stageKey: StageKey): Stage | null {
  const row = store.db
    .prepare('SELECT * FROM stages WHERE ticket_id = ? AND stage_key = ?')
    .get(ticketId, stageKey) as StageRow | undefined;
  return row ? rowToStage(row) : null;
}
```

- [ ] **Step 4: Write `src/ui/dashboard/stageLogReader.ts`**

```ts
import type { Store } from '../../store/db.js';
import { getStage } from '../../store/stages.js';
import type { GateStage } from '../../store/ticketGates.js';
import type { StageLogResult } from './messages.js';

/**
 * Read one gate stage's console log for the terminal "detailed mode" view.
 *
 * The webview names only a closed-vocabulary stage; the path is resolved HERE
 * from the store (never accepted from a message), the file is read bounded,
 * and every failure is a named `error` result — a missing file is a normal
 * refusal, never a throw, mirroring `openArtifactResource`'s copy.
 */

/** Defensive read bound. The recording itself caps at 1 MiB + marker + headers. */
export const STAGE_LOG_READ_CAP_BYTES = 2 * 1024 * 1024;

export function readStageLog(
  store: Store,
  ticketId: number,
  stage: GateStage,
  readFile: (path: string) => string,
  debug?: (msg: string) => void,
): StageLogResult {
  debug?.(`[stage-log] reading ${stage} for ticket ${ticketId}`);
  const row = getStage(store, ticketId, stage);
  const path = row?.artifactPath;
  if (!path) {
    debug?.(`[stage-log] ${stage} has no recorded artifact path`);
    return { kind: 'error', message: 'This stage has no recorded console log.' };
  }
  try {
    const content = readFile(path);
    if (Buffer.byteLength(content, 'utf8') <= STAGE_LOG_READ_CAP_BYTES) {
      return { kind: 'ok', content, truncated: false };
    }
    return {
      kind: 'ok',
      content: `${content.slice(0, STAGE_LOG_READ_CAP_BYTES)}\n[console output truncated]\n`,
      truncated: true,
    };
  } catch {
    debug?.(`[stage-log] artifact file unreadable: ${path}`);
    return { kind: 'error', message: 'The recorded log file is no longer available.' };
  }
}
```

- [ ] **Step 5: Run to verify they pass**

Run: `npx vitest run src/ui/dashboard/stageLogReader.test.ts src/store/stages.test.ts` (the latter to prove `getStage` didn't disturb the store suite)
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/store/stages.ts src/ui/dashboard/stageLogReader.ts src/ui/dashboard/stageLogReader.test.ts
git commit -m "feat: host-side gate-stage log reader for the terminal console view"
```

---

### Task 5: Manager dispatch + extension wiring

**Files:**
- Modify: `src/ui/dashboard/panel.ts`
- Modify: `src/ui/dashboard/panel.test.ts`
- Modify: `src/extension.ts`

**Interfaces:**
- Consumes: `StageLogResult` (Task 3), `readStageLog` (Task 4), `GateStage` (`src/store/ticketGates.ts`).
- Produces:
  - `export type StageLogReader = (ticketId: number, stage: GateStage) => StageLogResult` in `panel.ts`.
  - `DashboardManager` constructor gains an optional final param `stageLogReader?: StageLogReader` (optional like `loadStats` — existing construction sites compile unchanged).
  - `DashboardManager.requestStageLog(ticketId: number, stage: GateStage): void` — posts `{type:'stage-log', stage, result}` to the ticket's panel; no panel → no-op; no reader → `{kind:'error', message:'No console log source is configured.'}`.
  - `extension.ts` `makeDashboardActions` gains a `requestStageLog: (stage: GateStage) => void` param and wires `(stage) => dashboard.requestStageLog(ticketId, stage)`; the `DashboardManager` construction site passes the `readStageLog` implementation backed by `readFileSync` as the final arg.

- [ ] **Step 1: Write the failing tests** — append to `src/ui/dashboard/panel.test.ts`. The suite constructs `new DashboardManager(store, host, actionsFactory, ...)` directly with a fake `PanelHost`; follow its pattern, passing the reader as the final constructor arg. Use the suite's own host fake to capture posts:

```ts
describe('stage log requests', () => {
  it('posts the reader result as a stage-log message to the ticket panel', () => {
    const { manager, posts } = makeHarness({
      stageLogReader: (ticketId, stage) =>
        ticketId === 7 && stage === 'uat'
          ? { kind: 'ok', content: 'gate output', truncated: false }
          : { kind: 'error', message: 'no log' },
    });
    manager.requestStageLog(7, 'uat');
    expect(posts(7)).toContainEqual({
      type: 'stage-log',
      stage: 'uat',
      result: { kind: 'ok', content: 'gate output', truncated: false },
    });
  });

  it('posts a reader error result verbatim (UI-R13: the answer is the outcome)', () => {
    const { manager, posts } = makeHarness({
      stageLogReader: () => ({ kind: 'error', message: 'The recorded log file is no longer available.' }),
    });
    manager.requestStageLog(7, 'review');
    expect(posts(7)).toContainEqual({
      type: 'stage-log',
      stage: 'review',
      result: { kind: 'error', message: 'The recorded log file is no longer available.' },
    });
  });

  it('is a no-op for a ticket with no open panel, and never throws', () => {
    const { manager, posts } = makeHarness({
      stageLogReader: () => ({ kind: 'ok', content: 'x', truncated: false }),
    });
    expect(() => manager.requestStageLog(999, 'uat')).not.toThrow();
    expect(posts(999)).toEqual([]);
  });

  it('degrades to a named refusal when no reader is configured', () => {
    const { manager, posts } = makeHarness({});
    manager.requestStageLog(7, 'uat');
    expect(posts(7)).toContainEqual({
      type: 'stage-log',
      stage: 'uat',
      result: { kind: 'error', message: 'No console log source is configured.' },
    });
  });
});
```

(`makeHarness` is the describe-scoped helper this task introduces: it opens the manager with the fake `PanelHost` from the existing suite (the one whose `postMessage` records into a per-ticket array) and returns `{manager, posts: (ticketId) => Array<unknown>}` — name it to match the suite's local conventions if a closer helper already exists.)

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/ui/dashboard/panel.test.ts`
Expected: FAIL — `requestStageLog` does not exist.

- [ ] **Step 3: Implement in `src/ui/dashboard/panel.ts`**

Add the type near the `ActionsFactory` declaration:

```ts
/** Resolve one gate stage's console log host-side (store + fs). */
export type StageLogReader = (ticketId: number, stage: GateStage) => StageLogResult;
```

Add the constructor param (final position, after `binding`/the last existing param — see the class's current constructor tail):

```ts
    /**
     * Resolve a gate stage's console log for the terminal view. Absent → the
     * webview receives a named refusal rather than content (UI-R13).
     */
    private readonly stageLogReader?: StageLogReader,
```

Add the method (next to `postInsideProgress`):

```ts
  /**
   * Answer a `stage-log-request`: resolve the log via the injected reader and
   * post the `stage-log` message. The answer IS the terminal outcome — always
   * sent (ok or error), never left to a watchdog (UI-R13).
   */
  requestStageLog(ticketId: number, stage: GateStage): void {
    const panel = this.panels.get(ticketId);
    if (!panel) return;
    const result = this.stageLogReader
      ? this.stageLogReader(ticketId, stage)
      : { kind: 'error', message: 'No console log source is configured.' };
    panel.postMessage({ type: 'stage-log', stage, result });
  }
```

Add the `GateStage` import (panel.ts already imports from messages.js; add `import type { GateStage } from '../../store/ticketGates.js';`).

- [ ] **Step 4: Wire in `src/extension.ts`**

1. `makeDashboardActions` gains a `requestStageLog` param — add it to the signature (the file's action factory around line 4512) and to the returned object:

```ts
    // Push one gate stage's console log for the terminal view; the manager
    // owns the panel and the answer message (ok or error) is the outcome.
    requestStageLog: (stage) => dashboard.requestStageLog(ticketId, stage),
```

2. The `new DashboardManager(...)` construction (extension.ts:2006) gains the final argument:

```ts
    // The terminal view's log source: resolve the stage row's recorded
    // artifactPath and read it bounded (the webview names only a stage key).
    (ticketId, stage) =>
      readStageLog(localStore, ticketId, stage, (path) => readFileSync(path, 'utf8'), (m) =>
        logger.debug(m),
      ),
```

Add imports: `import { readStageLog } from './ui/dashboard/stageLogReader.js';` (`readFileSync`/`logger` already imported in extension.ts).

- [ ] **Step 5: Run tests and typecheck**

Run: `npx vitest run src/ui/dashboard/panel.test.ts && npm run typecheck`
Expected: PASS both (the panel harness helper may need its constructor call updated for the new optional param only if it passes positional args — it doesn't, optional is safe).

- [ ] **Step 6: Commit**

```bash
git add src/ui/dashboard/panel.ts src/ui/dashboard/panel.test.ts src/extension.ts
git commit -m "feat: wire stage-log-request dispatch through the dashboard manager"
```

---

### Task 6: Host-derived `console` flag on gate stages

**Files:**
- Modify: `src/model/inside/types.ts`
- Modify: `src/ui/dashboard/state.ts`
- Modify: `src/ui/dashboard/state.test.ts`

**Interfaces:**
- Consumes: `StepperCell` (`src/model/stepper.ts` — has `artifactPath`), `GATE_STAGES`/`GateStage` (`src/store/ticketGates.js`), `InsideStageView` (`src/model/inside/types.ts`).
- Produces: `InsideStageView.console?: boolean` — true ONLY when the stage is a `GateStage` whose stage row has a non-empty `artifactPath`. This is what the webview's Console button renders from (Task 7); availability is host-derived, never invented in the webview (UI-R31/R34).

- [ ] **Step 1: Write the failing tests** — append to `src/ui/dashboard/state.test.ts` (inside the existing `describe('buildDashboardState')` block, following its `openStore(':memory:')` + `createTicket` + `setStage` pattern):

```ts
  it('flags console on a gate stage whose stage row recorded an artifactPath', () => {
    const t = createTicket(store, { key: 'PROJ-1', title: 'thing' });
    setStage(store, t.id, 'uat', { status: 'passed', artifactPath: '/logs/uat.log' });
    setStage(store, t.id, 'review', { status: 'passed', artifactPath: null });
    const state = buildDashboardState(store, t.id);
    expect(state.insideViews.uat.console).toBe(true);
    expect(state.insideViews.review.console).toBe(false);
  });

  it('never flags a non-gate stage, whatever its artifactPath', () => {
    const t = createTicket(store, { key: 'PROJ-2', title: 'thing' });
    setStage(store, t.id, 'impl', { status: 'passed', artifactPath: '/logs/impl.log' });
    setStage(store, t.id, 'ship', { status: 'passed', artifactPath: '/logs/ship.log' });
    const state = buildDashboardState(store, t.id);
    expect(state.insideViews.impl.console).toBeFalsy();
    expect(state.insideViews.ship.console).toBeFalsy();
  });

  it('does not flag a gate stage that has no stage row at all', () => {
    const t = createTicket(store, { key: 'PROJ-3', title: 'thing' });
    const state = buildDashboardState(store, t.id);
    expect(state.insideViews.uat.console).toBeFalsy();
    expect(state.insideViews.review.console).toBeFalsy();
  });
```

(Note: the `state.test.ts` suite constructs `buildDashboardState(store, t.id)` directly — the same call the implementation under test uses, so `InsideStageView.console` flows through the real host derivation, never a hand-built fixture.)

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/ui/dashboard/state.test.ts`
Expected: FAIL — `console` is not a known property of `InsideStageView` (or undefined).

- [ ] **Step 3: Add the field to `src/model/inside/types.ts`** (in `InsideStageView`, with the other optional fields):

```ts
  /**
   * Whether this stage offers the terminal console view: a gate stage whose
   * stage row recorded an artifact log. Host-derived — the webview renders
   * the Console button ONLY from this flag and never guesses availability.
   */
  console?: boolean;
```

- [ ] **Step 4: Set it in `src/ui/dashboard/state.ts`**

In `buildDashboardState`, before the `insideViews` record (state.ts:371), derive the flag once:

```ts
  // The console (terminal detailed mode) is offered for a gate stage that
  // actually has a recorded artifact log — never for a stage that has not
  // run, and never for non-gate stages (UI-R31: availability is host-derived).
  const consoleFor = (key: GateStage): boolean => !!cellOf(key).artifactPath;
```

(`cellOf` is already defined in `buildDashboardState`; add `import { GATE_STAGES, type GateStage } from '../../store/ticketGates.js';` to the imports.)

Extend the module-level `stageView` helper (state.ts:583) with an optional parameter, and pass it through onto the view:

```ts
function stageView(
  key: InsideStageKey,
  cell: StepperCell,
  processes: readonly InsideProcessView[],
  now: string,
  console?: boolean,
): InsideStageView {
  const live = liveFor(processes);
  return {
    stageKey: key,
    title: STAGE_TITLES[key as StageKey],
    dot: dotFor(cell),
    // ... existing fields unchanged ...
    ...(console ? { console } : {}),
  };
}
```

(Leave the existing fields untouched; the object literal in the current `stageView` already has `stageKey`/`title`/`dot`/`clock`/`processes`/`live` — the new spread is the ONLY addition.)

Then update the `uat` and `review` call sites inside the `insideViews` record (state.ts:404 and 426) to pass the flag — each becomes:

```ts
    uat: stageView(
      'uat',
      cellOf('uat'),
      uatProcesses({ /* existing object unchanged */ }),
      now,
      consoleFor('uat'),
    ),
```

and the `review` call site becomes `..., now, consoleFor('review')`. The other four stages (`scope`/`impl`/`ship`/`fix`) stay without the fifth argument, so their views carry no `console` field.

- [ ] **Step 5: Run to verify they pass**

Run: `npx vitest run src/ui/dashboard/state.test.ts src/model/inside/types.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/model/inside/types.ts src/ui/dashboard/state.ts src/ui/dashboard/state.test.ts
git commit -m "feat: host-derived console flag on gate stages for the terminal view"
```

---

### Task 7: Webview — terminal surface, buttons, message handling

**Files:**
- Modify: `src/ui/dashboard/webview.html`

**Interfaces:**
- Consumes: markers `/*KARST_XTERM_CSS*/`/`/*KARST_XTERM_JS*/` (Task 1), message pair (Task 3), `view.console`/`failed.artifactPath` (Task 6).
- Produces (webview-internal names, referenced by Task 8's tests):
  - `let termView` (stage key string or null — NOT persisted, `liveOps` pattern), `let termLoading` (boolean), `let term` (Terminal instance or null), `let termResize` (ResizeObserver or null)
  - `function termTheme()` / `function termTokens()` — theme from computed tokens
  - `function renderTermView()` — the `#termView` surface swap (`body.term-nav`)
  - `function initTerminal()` — guarded `Terminal`/`FitAddon` construction + fit
  - `function openTerminal(stage)` / `function closeTerminal()`
  - Console buttons: fault card (`data-act="console" data-console`) + inside header (`view.console`); Close button (`data-term="close"`)
  - Message handler case `msg.type === 'stage-log'`

- [ ] **Step 1: Add the markers and surface markup**

1. In the main `<style>` block, directly after the `/*KARST_DS_CSS*/` marker line (line 9), add:

```css
/*KARST_XTERM_CSS*/
```

2. In the script block, directly BEFORE `const vscode = acquireVsCodeApi();` (line 1482), add:

```js
/*KARST_XTERM_JS*/
```

(The injected UMD is a single expression statement — valid at this position. Keeping the xterm JS inside the ONE existing `<script>` block is what keeps the test harness's `previewScriptSource()` (first-block extraction) and `injectCsp`'s nonce pass correct.)

3. Add the surface container after the `#artView` div (line 1465):

```html
<div id="termView" class="termview hidden" tabindex="-1"></div>
```

4. Add the swap rule beside the `art-nav` rule (line 1297):

```css
body.term-nav .stepper,body.term-nav .grid{display:none}
```

5. Add the surface layout near the `.artview` rules (a local composition — screen-local geometry stays local per UI-R04/R05):

```css
.termview{position:fixed;inset:0;z-index:8;display:flex;flex-direction:column;background:var(--k-bg);color:var(--k-text);font-family:var(--k-font-mono)}
.termview .thead{display:flex;align-items:center;gap:var(--k-space-4);padding:var(--k-space-3) var(--k-space-4);border-bottom:1px solid var(--k-border)}
.termview .ttitle{font-weight:var(--k-weight-semibold)}
.termview .tstatus{font-size:var(--k-text-xs);color:var(--k-text-dim);padding:var(--k-space-2) var(--k-space-4)}
.termview .termhost{flex:1;min-height:0;overflow:hidden}
.termview .blurb{padding:var(--k-space-6);color:var(--k-text-dim)}
```

- [ ] **Step 2: Add the terminal view state and functions**

Insert after the `artScrolls` declaration (line 1604):

```js
  // The terminal console surface (xterm "detailed mode"): which stage's console
  // is open (a gate-stage key, or null). NOT persisted — like `liveOps`, a
  // restored view would claim content that died with the Terminal instance on
  // reload. `termLoading` is the in-between state between the request and the
  // host's GUARANTEED answer (the stage-log message is always sent, ok or
  // error — UI-R13), which is also the terminal outcome.
  let termView = null;
  let termLoading = false;
  let term = null;
  let termFit = null;
  let termResize = null;
```

Insert after the `renderArtView` function (line 3012):

```js
  // The terminal's colors resolve the DESIGN TOKENS the host already injected
  // (UI-R04): background/foreground come from the editor's own colors, so
  // their contrast is the theme's contract (UI-R29). The ANSI 16 ramp stays
  // xterm's standard palette. `getComputedStyle` resolves the var(--vscode-*)
  // chains to concrete values inside the webview.
  function termTokens() {
    const cs = typeof getComputedStyle === 'function'
      ? getComputedStyle(document.documentElement)
      : null;
    const tok = (name, fallback) => (cs && cs.getPropertyValue(name).trim()) || fallback;
    return {
      bg: tok('--k-bg', '#1e1e1e'),
      fg: tok('--k-text', '#cccccc'),
      cursor: tok('--k-focus', '#3794ff'),
      selection: tok('--k-surface-selected', 'rgba(127,127,127,.4)'),
      font: tok('--k-font-mono', 'monospace'),
      size: parseFloat(tok('--k-text-base', '')) || 13,
    };
  }

  function termTheme(t) {
    return {
      background: t.bg,
      foreground: t.fg,
      cursor: t.cursor,
      selectionBackground: t.selection,
    };
  }

  // The console surface: full-body swap via body.term-nav, exactly like the
  // artifact surface. Rendered ONLY on open/close — render() never calls this,
  // so a state push (up to one a second while running) cannot recreate
  // #termHost out from under the live Terminal instance.
  function renderTermView() {
    const box = el('termView');
    if (!box) return;
    if (!termView) {
      box.classList.add('hidden');
      box.innerHTML = '';
      document.body.classList.remove('term-nav');
      return;
    }
    box.classList.remove('hidden');
    document.body.classList.add('term-nav');
    const title = STAGE_TITLE[termView] || termView;
    box.innerHTML = `<div class="thead"><span class="ttitle">Console · ${esc(title)}</span>`
      + `<span class="sp"><button type="button" class="k-btn k-btn--ghost k-btn--sm" data-term="close"`
      + ` title="Close the console view">Close</button></span></div>`
      + `<div class="tstatus" id="tstatus" role="status">${esc(termLoading ? 'Loading console output…' : '')}</div>`
      + `<div id="termHost" class="termhost"></div>`;
    initTerminal();
  }

  // A real <button> Console entry (UI-R09) posting the closed-vocabulary
  // stage-log-request; the host's stage-log answer is the outcome (UI-R13).
  function openTerminal(stage) {
    if (termView === stage && term) return;
    if (termView) closeTerminal();
    termView = stage;
    termLoading = true;
    renderTermView();
    post({ type: 'stage-log-request', stage });
  }

  function closeTerminal() {
    if (term) { try { term.dispose(); } catch (e) { /* renderer teardown */ } term = null; }
    termFit = null;
    if (termResize) { termResize.disconnect(); termResize = null; }
    termView = null;
    termLoading = false;
    renderTermView();
  }

  // Create the Terminal only on first open of a view. Guarded for the test
  // harness (no real xterm in the VM): an absent library degrades to a visible
  // refusal, never a silent blank.
  function initTerminal() {
    if (term) return;
    if (typeof Terminal === 'undefined' || typeof FitAddon === 'undefined') {
      const host = el('termHost');
      if (host) host.innerHTML = '<div class="blurb">Console rendering is unavailable in this build.</div>';
      return;
    }
    const t = termTokens();
    const host = el('termHost');
    if (!host) return;
    term = new Terminal({
      convertEol: true,        // the artifact log uses bare \n; xterm expects \r\n
      disableStdin: true,      // a log viewer, never an input surface
      cursorBlink: false,
      scrollback: 10000,       // 1 MiB of output is ~10k+ lines at common widths
      fontFamily: t.font,
      fontSize: t.size,
      theme: termTheme(t),
      allowProposedApi: true,  // FitAddon's addon lifecycle
    });
    termFit = new FitAddon.FitAddon();
    term.loadAddon(termFit);
    term.open(host);
    termFit.fit();
    if (typeof ResizeObserver !== 'undefined' && host) {
      // fit lives on the ADDON, not the terminal — `term.fit` does not exist.
      termResize = new ResizeObserver(() => termFit && termFit.fit());
      termResize.observe(host);
    }
  }
```

(The `Terminal`/`FitAddon` instances expose the standard xterm API; the code above calls `loadAddon`, `open`, `fit` and `dispose` — the fit addon is what carries `fit()`. Task 8's fake implements exactly these.)

- [ ] **Step 3: Console entry buttons**

In `renderFault` (line 2339-2342), extend the facts row — keep "Open log" (editor) and add Console beside it. The Console button carries `data-console` (NOT `data-stage`): the rail's separate `[data-stage]` select listener would otherwise re-point the strip and re-render the dashboard under the open terminal view — a side effect this button must not have:

```js
      + (failed.artifactPath
        ? `<div class="facts"><button type="button" class="k-btn k-btn--secondary k-btn--sm" data-act="open-stage-log"`
          + ` data-path="${esc(failed.artifactPath)}" title="Open this stage's log file in an editor">Open log</button>`
          + `<button type="button" class="k-btn k-btn--secondary k-btn--sm" data-act="console"`
          + ` data-console="${esc(failed.stageKey)}" title="View this stage's console output in the dashboard">Console</button></div>`
        : '')
```

In `renderInside` (the `inside-meta` cell, line 2324), append a Console button when the host says the stage has a log (same `data-console` attribute, same reason):

```js
      + `<span class="inside-meta">${esc(view.clock)}`
      + (view.console
        ? `<span class="sp"><button type="button" class="k-btn k-btn--ghost k-btn--sm" data-act="console"`
          + ` data-console="${esc(view.stageKey)}" title="View this stage's console output in the dashboard">Console</button></span>`
        : '')
      + `</span>`
```

- [ ] **Step 4: Click and key handlers**

In the delegated click handler (the second `document.addEventListener('click', ...)` at line 3341 — the `data-act` chain, before the generic action-result branch at "Every other posting control settles"), add:

```js
    // The terminal console view: open it and post the closed-vocabulary
    // stage-log-request. No requestId — the host answers with the `stage-log`
    // message itself (ok or error), which is the terminal outcome (UI-R13).
    // Reads `data-console`, never `data-stage` (see renderFault — the rail's
    // select listener must not re-point the strip for a console click).
    if (act === 'console') {
      const stage = btn.dataset.console;
      if (!stage) return;
      openTerminal(stage);
      return;
    }
```

In the same delegated handler, next to the `artNav` branch (line 3250), add the Close button branch:

```js
    const termBtn = e.target.closest('[data-term]');
    if (termBtn) {
      if (termBtn.dataset.term === 'close') closeTerminal();
      return;
    }
```

Extend the Escape handler (line 3269) — console closes before artifact navigation:

```js
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && termView) { closeTerminal(); return; }
    if (e.key === 'Escape' && artView) artifactBack();
  });
```

- [ ] **Step 5: Message handler case**

In the `window.addEventListener('message', ...)` handler, before the `state` case (next to `inside-progress`), add:

```js
    // The terminal console answer. The host ALWAYS answers a stage-log-request
    // (ok or error) — this message is the terminal outcome (UI-R13). A stale
    // answer for a view that has since closed (or moved to another stage) is
    // dropped, not rendered.
    if (msg.type === 'stage-log') {
      if (!termView || termView !== msg.stage) return;
      termLoading = false;
      const status = el('tstatus');
      if (msg.result.kind === 'ok') {
        if (status) status.textContent = msg.result.truncated ? 'Console output truncated' : '';
        if (term) term.write(msg.result.content);
      } else {
        if (status) status.textContent = '';
        const host = el('termHost');
        if (host) host.innerHTML = `<div class="blurb">${esc(msg.result.message)}</div>`;
      }
      return;
    }
```

- [ ] **Step 6: Run the existing dashboard suite to prove nothing regressed**

Run: `npx vitest run src/ui/dashboard/webview.test.ts src/ui/dashboard/messages.test.ts src/ui/dashboard/panel.test.ts`
Expected: PASS — the new code is inert until Task 8 exercises it (the source markers don't run in the VM; `typeof Terminal === 'undefined'` guards the harness).

- [ ] **Step 7: Commit**

```bash
git add src/ui/dashboard/webview.html
git commit -m "feat: xterm console surface with gate-stage entry points (UI-R04/R09/R11/R13/R16/R29)"
```

---

### Task 8: Webview VM tests + discovery marker tests

**Files:**
- Modify: `src/ui/dashboard/webview.test.ts`
- Create: `src/ui/xterm.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1-7. The harness (`bootPreviewHarness`) gains `termHost`/`termView` elements and `Terminal`/`FitAddon` fakes in the VM context; `openTerminal`/`closeTerminal`/the `stage-log` handler are exercised through `h.click`, `h.key` and `h.receive`.

- [ ] **Step 1: Add the harness elements** — `bootPreviewHarness`'s element list (webview.test.ts:1906-1934) gains:

```ts
    'termView',
    'termHost',
```

- [ ] **Step 2: Add the xterm fakes to the VM context** — in `bootPreviewHarness`, before `runInNewContext`, build the fake classes and pass them in:

```ts
  const terminalInstances: Array<{
    opts: Record<string, unknown>;
    opened: boolean;
    written: string;
    disposed: boolean;
  }> = [];
  class FakeTerminal {
    opts: Record<string, unknown>;
    opened = false;
    written = '';
    disposed = false;
    addon: { fit: () => void } | null = null;
    constructor(opts: Record<string, unknown>) {
      this.opts = opts;
      terminalInstances.push(this as unknown as (typeof terminalInstances)[number]);
    }
    open() { this.opened = true; }
    write(s: string) { this.written += s; }
    loadAddon(addon: { fit: () => void }) { this.addon = addon; }
    dispose() { this.disposed = true; }
  }
  class FakeFitAddon {
    fitCalls = 0;
    fit() { this.fitCalls += 1; }
    activate() {}
    dispose() {}
  }
```

and the `runInNewContext` context object gains:

```ts
    Terminal: FakeTerminal,
    FitAddon: { FitAddon: FakeFitAddon },
```

The returned harness gains `terminals: () => terminalInstances` and `fits: () => terminalInstances.map((t) => (t.addon as { fitCalls: number } | null)?.fitCalls ?? 0)`.

- [ ] **Step 3: Add the harness's `click` support for the console button's `dataset.console`** — the existing `click(sel, dataset)` fake already passes `dataset` through, so `h.click('[data-act="console"]', { console: 'uat' })` works as-is.

- [ ] **Step 4: Write the failing VM tests** — append to the "executed in a VM" describe block (use the suite's `renderStateFor`/fixtures):

```ts
describe('terminal console view (VM)', () => {
  it('opens the console surface and posts stage-log-request with the stage', () => {
    const h = bootPreviewHarness();
    h.receive({ type: 'state', state: renderStateFor('uat') });
    h.click('[data-act="console"]', { console: 'uat' });
    expect(h.bodyClasses).toContain('term-nav');
    expect(h.htmlOf('termView')).toContain('Console · UAT');
    expect(h.posted).toContainEqual({ type: 'stage-log-request', stage: 'uat' });
    expect(h.terminals().length).toBe(1);
  });

  it('creates the terminal with convertEol, disableStdin and the token theme', () => {
    const h = bootPreviewHarness();
    h.receive({ type: 'state', state: renderStateFor('review') });
    h.click('[data-act="console"]', { console: 'review' });
    const t = h.terminals()[0]!;
    expect(t.opts.convertEol).toBe(true);
    expect(t.opts.disableStdin).toBe(true);
    expect(t.opened).toBe(true);
    expect(h.fits()[0]).toBeGreaterThanOrEqual(1);
  });

  it('writes the stage-log ok content into the live terminal', () => {
    const h = bootPreviewHarness();
    h.receive({ type: 'state', state: renderStateFor('uat') });
    h.click('[data-act="console"]', { console: 'uat' });
    h.receive({ type: 'stage-log', stage: 'uat', result: { kind: 'ok', content: '\x1b[32mpass\x1b[0m\n', truncated: false } });
    expect(h.terminals()[0]!.written).toBe('\x1b[32mpass\x1b[0m\n');
  });

  it('renders the error result in the view instead of writing to the terminal', () => {
    const h = bootPreviewHarness();
    h.receive({ type: 'state', state: renderStateFor('uat') });
    h.click('[data-act="console"]', { console: 'uat' });
    h.receive({ type: 'stage-log', stage: 'uat', result: { kind: 'error', message: 'The recorded log file is no longer available.' } });
    expect(h.terminals()[0]!.written).toBe('');
    expect(h.htmlOf('termHost')).toContain('no longer available');
  });

  it('drops a stale stage-log answer for a view that closed', () => {
    const h = bootPreviewHarness();
    h.receive({ type: 'state', state: renderStateFor('uat') });
    h.click('[data-act="console"]', { console: 'uat' });
    h.key('Escape');
    h.receive({ type: 'stage-log', stage: 'uat', result: { kind: 'ok', content: 'late', truncated: false } });
    expect(h.terminals()[0]!.written).toBe('');
    expect(h.bodyClasses).not.toContain('term-nav');
  });

  it('disposes the terminal and restores the dashboard on Escape', () => {
    const h = bootPreviewHarness();
    h.receive({ type: 'state', state: renderStateFor('uat') });
    h.click('[data-act="console"]', { console: 'uat' });
    expect(h.bodyClasses).toContain('term-nav');
    h.key('Escape');
    expect(h.terminals()[0]!.disposed).toBe(true);
    expect(h.bodyClasses).not.toContain('term-nav');
    expect(h.htmlOf('termView')).toBe('');
  });

  it('renders a Console button only for stages the host flags (view.console)', () => {
    const h = bootPreviewHarness();
    const state = renderStateFor('uat');
    // The uat render fixture carries `console: true` — add it to the view
    // object returned by `uatView` in renderFixtures.ts (`stageKey: 'uat'`,
    // near the top of the returned object), exactly where Task 6's host
    // derivation would set it.
    expect((state.insideViews as Record<string, { console?: boolean }>).uat.console).toBe(true);
    h.receive({ type: 'state', state });
    expect(h.htmlOf('inside')).toContain('data-act="console"');
  });

  it('renders no Console button for a stage the host did not flag', () => {
    const h = bootPreviewHarness();
    const state = renderStateFor('uat');
    // Flip the flag off in the fixture: availability is HOST-derived, so the
    // webview must render no button when the view does not carry it.
    const noConsole = {
      ...state,
      insideViews: {
        ...(state.insideViews as Record<string, unknown>),
        uat: { ...(state.insideViews as Record<string, unknown>).uat, console: false },
      },
    };
    h.receive({ type: 'state', state: noConsole as DashboardState });
    expect(h.htmlOf('inside')).not.toContain('data-act="console"');
  });
});
```

(The fixture's `console` flag needs the state fixture to include `insideViews.uat.console` — extend `renderStateFor`/`renderFixtures` so the uat view carries `console: true`; the assertion reads the actual flag back from the fixture via a small helper so the test stays honest.)

- [ ] **Step 5: Write the discovery marker test** — `src/ui/xterm.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { injectCsp, newNonce } from '../model/csp.js';
import { injectXterm, XTERM_CSS_MARKER, XTERM_JS_MARKER } from '../model/xtermAssets.js';

const HERE = dirname(fileURLToPath(import.meta.url));

// Discovered, never enumerated — the same discipline as ui/webviewCsp.test.ts:
// a webview added later must not be able to ship with (or without) xterm
// markers silently.
const WEBVIEWS = readdirSync(HERE, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .filter((name) => {
    try {
      readFileSync(join(HERE, name, 'webview.html'));
      return true;
    } catch {
      return false;
    }
  });

const read = (name: string): string => readFileSync(join(HERE, name, 'webview.html'), 'utf8');

describe('xterm markers', () => {
  it('are carried by the dashboard only (the console surface lives there)', () => {
    for (const name of WEBVIEWS) {
      const html = read(name);
      if (name === 'dashboard') {
        expect(html, 'dashboard css marker').toContain(XTERM_CSS_MARKER);
        expect(html, 'dashboard js marker').toContain(XTERM_JS_MARKER);
      } else {
        expect(html, `${name} css marker`).not.toContain(XTERM_CSS_MARKER);
        expect(html, `${name} js marker`).not.toContain(XTERM_JS_MARKER);
      }
    }
  });

  it('keep the dashboard CSP-compliant after injection (nonce covers the xterm script)', () => {
    const injected = injectCsp(
      injectXterm(read('dashboard'), { css: '.xterm{}', js: 'var xterm = 1;' }),
      'TESTNONCE',
    );
    // default-src stays 'none' and every script — including the injected
    // xterm block — carries the nonce.
    expect(injected).toContain("default-src 'none'");
    expect(injected).not.toMatch(/<script(?![^>]*\bnonce=)/);
    // The injected content introduces no external load.
    expect(injected).not.toMatch(/<link\b/);
    expect(injected).not.toMatch(/<script[^>]*\bsrc=/);
  });
});
```

- [ ] **Step 6: Run the full dashboard suite**

Run: `npx vitest run src/ui/dashboard/webview.test.ts src/ui/xterm.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/ui/dashboard/webview.test.ts src/ui/xterm.test.ts
git commit -m "test: cover the xterm console view and its CSP-safe injection"
```

---

### Task 9: Full verification pass

**Files:**
- None (verification only).

- [ ] **Step 1: Full typecheck and build**

Run: `npm run typecheck && npm run build`
Expected: PASS; build copies `dist/vendor/xterm/{xterm.js,xterm.css,addon-fit.js}`.

- [ ] **Step 2: Full test suite**

Run: `npm test`
Expected: PASS — the entire suite, including the discovery-based `webviewCsp.test.ts` (unchanged: the source html still has no external loads and one script block) and `designSystem.test.ts` (unchanged: the new markers are inert to it).

- [ ] **Step 3: Manual smoke (Dev Host)**

Run: F5 → open a ticket dashboard with a finished `uat` stage → on the fault card or the inside UAT row, click **Console** → the terminal surface opens, shows the ANSI-colored gate output, selection/copy works, Close (button or Escape) restores the dashboard. Then open the same ticket's dashboard in a second window and confirm the injection runs per panel without error.

- [ ] **Step 4: Commit any fixups from the smoke run** (if the smoke run surfaced a bug, fix it with its own test before committing):

```bash
git add -A
git commit -m "fix: <what the smoke run surfaced>"
```

---

## Self-Review

**1. Spec coverage.** The ticket asks to *research xterm into the dashboard to display console output for some stages as a detailed mode*:
- Research: the "Research: findings and decisions" section answers delivery (marker injection; verified against real packages), data flow (host-read artifact file), scope (live streaming excluded) and theming — the plan's headline deliverable for a research ticket. ✓
- Console output displayed: Task 4 (host reader) + Task 7 (terminal surface + `term.write`). ✓
- Some stages: `uat`/`review` only — closed `GATE_STAGES` vocabulary on the wire (Task 3), host-derived `console` flag (Task 6), fault card + inside header entry points (Task 7). ✓
- Detailed mode: full-body `#termView` swap mirroring the artifact surface, with selection/scrollback/ANSI (Task 7). ✓
- Architecture constraints honored: CSP untouched (Task 1/2/8), no path from the webview (Task 3/4), no second delivery mechanism (Task 1), no `<script>` count change in source (Task 7), test harness unaffected until deliberately extended (Task 8). ✓

**2. Placeholder scan.** Every task carries real code, real test code, real commands. The two "follow the suite's helper" notes (`messages.test.ts` `allActions()`, `state.test.ts` fixture, `panel.test.ts` `makePanelHarness`) name the exact helper to extend and its contract — they are integration notes on existing helpers, not placeholders; the task's own test bodies are complete. `webview.test.ts`'s Task 8 fixture flag note is likewise an explicit fixture extension with the assertion spelled out. ✓

**3. Type consistency.** `StageLogResult` is defined in Task 3 and consumed unchanged by Tasks 4/5/7/8. `stage-log-request {stage: GateStage}` is parsed in Task 3, dispatched in Task 5, posted in Task 7, asserted in Task 8. `view.console`/`failed.artifactPath` (Task 6) drive the buttons (Task 7) and the tests (Task 8). `XTERM_CSS_MARKER`/`XTERM_JS_MARKER`/`injectXterm`/`readXtermAssets` (Task 1) are used by Tasks 2 and 8. `dashboard.requestStageLog(ticketId, stage)` (Task 5) is the exact name the extension wiring calls. `STAGE_LOG_READ_CAP_BYTES` is used in Task 4's implementation and tests. The webview-internal names (`termView`, `termLoading`, `term`, `termResize`, `openTerminal`, `closeTerminal`, `renderTermView`, `initTerminal`) are defined in Task 7 and asserted by Task 8. ✓
