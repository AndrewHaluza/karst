# Naming Templates + Live Status Encoding — Design Spec

**Date:** 2026-07-17
**Ticket:** 869e5rwxh — [FEAT] Add template for naming
**Status:** ✅ Approved (terminal strategy + status encoding locked via AskUserQuestion + spike)
**Visual:** https://claude.ai/code/artifact/5f73b4bb-c4dd-40d2-8542-8863a8679143

## Context

The ticket asks for: a naming template for pages (webview tabs) and for terminals;
interactive names that show status (color / stage / blockers); the terminal icon
set to the extension logo, tinted by stage. And explicitly: present variants, user
approves.

Tabs already template via `ticketLabelTemplate`. Terminals are hardcoded. This spec
adds terminal templating and one consistent live-status color language across every
karst surface, using **Variant 1** (color carries stage; names stay clean).

## Spike outcome (do not re-litigate)

A throwaway node-pty spike (removed) established the capability boundary that shapes
this design:

- **Terminal name / icon / color are frozen at launch.** `Terminal.creationOptions`
  is `Readonly` (@types/vscode 1.105). The only live-rename path is
  `ExtensionTerminalOptions.pty` + `onDidChangeName`, i.e. karst owning the pty.
- **Owning the pty kills the agent session on window reload** — empirically
  confirmed: the pty child is a child of the extension host (dies on reload), vs
  VS Code's normal `shellPath` spawn which lives in the surviving pty host.
- node-pty is N-API (no ABI split) and REPL fidelity was fine — but the
  session-death cost is not worth a live terminal *name* alone, and pty buys **no**
  live terminal *color* regardless (`onDidChangeName` is name-only).
- **Webview tab `title` and `iconPath` ARE live-mutable** — the rich surface.

Decision (AskUserQuestion): **static terminal + live webview tabs + a new status-bar
item.** Terminal reads its stage-at-launch; liveness lives where it's free.

Separate finding (out of scope, file follow-up): `scripts/rebuild-better-sqlite3.mjs`
`detectElectronRuntime()` probes Cursor before VS Code, so running the extension in
VS Code copies Cursor's ABI prebuild. Also this machine's VS Code is now Electron 42
= ABI 146; CLAUDE.md still says 140. Not part of this ticket.

## Grounded data model (do not re-derive)

- **Stage keys** (`src/model/types.ts:11`): `scope|impl|uat|review|fix|ship|done`.
  Happy path `scope→impl→uat→review→ship→done`; `fix` is the parked/blocked state a
  failed gate routes to (`src/workflow/graph.ts:28` `STAGE_GRAPH`).
- **Agent state** (`src/model/types.ts:27`): `running|waiting|idle|none`. `waiting`
  is the needs-you signal, hook-driven, orthogonal to stage.
- **Label template engine** (`src/store/ticketLabelTemplate.ts`): pure, vscode-free.
  `renderTicketLabel(ticket, template?)`, tokens `{key}{title}{id}{status}{stage}
  {repos}`, default `'{key} — {title}'`, blank→default, unknown token→empty. Reused
  as-is for terminals; NOT forked.
- **Terminal creation**: `SessionManager.openSession` (`src/ui/session.ts:90`) builds
  `CreateTerminalOpts` (`src/ui/session.ts:16`: `name`, `description`, `cwd`,
  `shellPath`, `shellArgs`) and calls `host.createTerminal` (`:115`). Real host
  `makeTerminalHost` (`src/extension.ts:1245`) folds description into the name and
  calls `vscode.window.createTerminal`. Name currently `Karst: ${key}` +
  ` — ${title}` (`session.ts:116`, `extension.ts` fold).
- **Webview panels**: dashboard `createPanel` (`src/extension.ts:1225`), onboarding
  `createPanel` (`src/ui/onboarding/host.ts:23`). Neither sets `iconPath` today. The
  host-agnostic panel interfaces (`dashboard/panel.ts:14`, `onboarding/panel.ts`)
  expose no icon/title mutator yet.
- **Sidebar** is karst's own WebviewView HTML (`src/ui/sidebar/webview.html`,
  state `sidebar/state.ts`, rows `sidebar/items.ts`) — full render control and it
  already computes the row glyph, so tinting the logo there is trivial.
- **Manifest field checklist** (CLAUDE.md): `types.ts` → `schema.ts` (validate +
  wire in `validateManifest` `:329`) → `write.ts` overlay, else Save drops it.
  Mirror `ticketLabelTemplate` exactly (`types.ts:144`, `schema.ts:295/368`,
  `write.ts:105`).
- **Logo** (`media/karst.svg`): 24×24, three-node graph, `stroke="currentColor"`.

## Locked decisions

- **Variant 1 uniformly, reusing the existing status glyph.** Names render pure
  template text (no status words); the karst logo is **tinted by the status glyph**
  color; **stage rides as text** (name/description/status-bar); the **status bar** is
  the live verbose channel.
- **Reuse `glyphFor` — do NOT invent a per-stage palette.** `src/model/glyph.ts` is
  the single-source-of-truth color system (H1, "none reinvents it"). Locked via
  AskUserQuestion (2026-07-17) after the first spec draft wrongly added a competing
  7-stage palette.
- Because the glyph already folds stage-status **and** agent-state into one color, a
  separate state "pip" is **redundant and dropped** — icon color alone carries it.
- **Terminal:** static at launch — glyph-tinted logo icon + matching `color` + new
  `terminalNameTemplate` (stage as text keeps the frozen tab meaningful).
- **Blocker is multi-channel**, never color alone: a failed gate → `red` glyph
  **and** the `{stage}` text (`fix`) **and** a status-bar warning phrase.

## Color language — reuse the glyph

`glyphFor(stageStatus, agentState): Glyph` (`src/model/glyph.ts`) already returns
`'gray'|'blue'|'amber'|'green'|'red'`:

| glyph | meaning (from `glyphFor`)              | hex (icon) | terminal ThemeColor key    |
|-------|----------------------------------------|------------|----------------------------|
| gray  | pending / idle / skipped               | `#7f8896`  | `terminal.ansiBrightBlack` |
| blue  | running (stage or agent)               | `#3f8cff`  | `terminal.ansiBlue`        |
| amber | needs-you (`agentState==='waiting'`)   | `#d99a2b`  | `terminal.ansiYellow`      |
| green | passed                                 | `#38a86b`  | `terminal.ansiGreen`       |
| red   | failed / blocked                       | `#e35555`  | `terminal.ansiRed`         |

- New pure module `src/model/glyphColor.ts`: `glyphHex(glyph): string` and
  `glyphThemeColorKey(glyph): string`. Both total over the 5 `Glyph` values. This is
  the ONLY new color map; it decorates the existing glyph, it does not replace it.
- Icons carry the exact **hex**; the terminal tab *label* tints via the paired **ansi
  ThemeColor** (the API accepts only registered theme colors, not hex). Minor
  two-source color, visually consistent, legible on any user theme.
- One helper `ticketGlyph(ticket): Glyph` centralizes
  `glyphFor(currentStageStatus(t), agentState)` so every surface derives the same
  color the sidebar already shows (`sidebar/items.ts` currently inlines this).

## Component design

### 1. `terminalNameTemplate` (manifest field)

- `terminalNameTemplate?: string` on `Manifest` (`types.ts`). Absent/blank → default
  `'Karst: {key} — {title}'`. Plumb the 3-point checklist; validate = "string or
  throw", blank normalized to undefined (mirror `validateTicketLabelTemplate`).
- Rendering reuses `renderTicketLabel(ticket, template)` — the engine is generic; a
  different default string is the only difference. `SessionManager.openSession`
  currently receives a `label {key,title}` and hardcodes the `Karst:` name; instead
  pass the **rendered terminal name** (+ the resolved stage) in, so `session.ts` owns
  no format string.
- Settings webview: add a "Terminal name template" text field beside the existing
  ticket-label one (`src/ui/settings/webview.html:377`), same live-preview pattern.

### 2. Tinted logo icons (runtime-generated)

New `src/ui/glyphIcon.ts`:

- `glyphIconUri(glyph, storageDir): Uri` — reads `media/karst.svg`, replaces
  `currentColor` with `glyphHex(glyph)`, writes
  `<globalStorage>/icons/karst-<glyph>.svg` (idempotent cache; write once), returns a
  file `Uri`. vscode `Uri`/fs live in a thin wrapper; the string-transform
  (`tintSvg(svg, hex)`) is a pure, tested helper.
- Rationale: `iconPath` on both webview panels and terminals is a static image VS
  Code will not theme-tint, so the hue must be baked. Generating the 5 glyph SVGs
  avoids committing them and keeps the hex exact.

### 3. Webview tabs — live glyph icon

- Extend the host-agnostic panel interfaces with `setIcon(uri)` (dashboard
  `panel.ts:14`, onboarding). Real impl sets `panel.iconPath = uri`; fake records it.
- Dashboard/onboarding managers set the icon on open and **re-point it on state
  change** (they already receive state pushes; add an icon update alongside the title
  refresh) to `glyphIconUri(ticketGlyph(ticket))`. Title stays `ticketLabelTemplate`
  (unchanged).

### 4. Terminal — static tinted icon + color

- `CreateTerminalOpts` gains `iconPath?: string` (file path) and `color?: string`
  (ThemeColor key). `makeTerminalHost` maps them to `vscode.Uri.file(...)` and
  `new vscode.ThemeColor(color)`.
- `openSession` resolves the launch glyph once (`ticketGlyph`), sets `name` =
  rendered `terminalNameTemplate`, `iconPath` = `glyphIconUri(glyph)`, `color` =
  `glyphThemeColorKey(glyph)`. All frozen — matches the confirmed capability; stage
  stays legible via the template's `{stage}` text.

### 5. Sidebar rows — tinted logo icon

- The sidebar already computes the glyph (`sidebar/items.ts:37`) and renders it.
  Swap/augment its rendering so the **karst logo** is the marker, tinted with
  `glyphHex(node.glyph)` (inline SVG, `color:` set), instead of / alongside the plain
  dot. No new color logic — reuses the row's existing `glyph`.

### 6. Status bar item (new, live)

- New `src/ui/statusBar.ts` — host-agnostic `StatusBarView` behind a
  `StatusBarHost` (real: `vscode.window.createStatusBarItem`), unit-tested with a
  fake, per the "keep vscode a thin wrapper" rule.
- Tracks the **active/focused ticket** (the front dashboard, else the most-recently
  opened session). Text: `{key} · {stage} · {state}`, e.g. `KAR-12 · review ·
  running`. Blocker (`glyph==='red'`): prefix `⚠` and set `backgroundColor =
  new ThemeColor('statusBarItem.warningBackground')`. Clicking runs
  `karst.openDashboard` for that ticket.
- The verbose channel V1 depends on: whatever a tab/terminal abbreviates to color,
  the status bar states in words, always current.

## Testing (TDD, RED→GREEN)

- `glyphColor.test.ts` — every `Glyph` maps to a hex + a valid `terminal.ansi*` key;
  both maps total (no `undefined`); a red glyph → the red hex + `ansiRed`.
- `glyphIcon.test.ts` — `tintSvg` replaces `currentColor` with the hex; output still
  parses as the karst SVG; each of the 5 glyphs yields a distinct file name.
- `ticketGlyph.test.ts` — a waiting ticket → amber, a failed current stage → red, a
  running one → blue, pending → gray (mirrors `glyphFor`, over a `TicketWithStages`).
- `ticketLabelTemplate` — add the terminal-default case: blank/undefined template →
  `'Karst: {key} — {title}'` renders as `Karst: KAR-1 — Title`.
- `session.test.ts` — `openSession` passes rendered name + `iconPath` + `color` from
  the resolved glyph; re-open still focuses (no duplicate); blank template → default.
- `manifest/load.test.ts` — `terminalNameTemplate` validates, blank→undefined,
  round-trips through `writeManifest` (guarded by the existing "round-trips every
  modeled section" test).
- `statusBar.test.ts` — text for running/waiting/idle; a red glyph sets the warning
  bg + `⚠` prefix; tracks the active ticket; click command routes to the dashboard.
- Panel managers — `setIcon(glyphIconUri(...))` called on open and on each state push.

## Out of scope (YAGNI)

- Live terminal rename / recolor, pty wrapper (spike-rejected).
- Per-stage animation beyond the sidebar running-pulse.
- Configurable color palette / glyph vocabulary (ship fixed; revisit if asked).
- Tracking the *specific* failed gate for the status-bar phrase — show `fix`; the
  "which gate" detail is a later nicety, not required.
- The rebuild-script Electron-detection bug — separate follow-up.
