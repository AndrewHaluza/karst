# Karst Icons — Tabler Icons standard

**The single icon vocabulary for Karst's webview UI.** Karst uses Tabler Icons
(github.com/tabler/tabler-icons, MIT) as the default library for common UI
actions instead of maintaining a custom icon set — terminal/session control,
process lifecycle (start/stop/restart), copying, diffing, archiving, deletion
and navigation are all Tabler's territory, and re-creating them by hand cost a
second icon style nobody could extend consistently (the dashboard's 16px
sprite and the sidebar's inline SVGs used to drift apart).

This document is the icon contract. It mirrors the pattern of the rest of the
design system: the decisions are centralized, and the pins in
`src/model/tablerIcons.test.ts` keep every webview honest (the same
discovery discipline as `ui/designSystem.test.ts`).

## 1. Asset strategy — vendored path data, delivered by marker injection

There is **no icon-font dependency and no external asset**. Every webview is a
self-contained document under `default-src 'none'` (see
[DESIGN-SYSTEM.md](./DESIGN-SYSTEM.md) §1), so an icon *package* cannot load at
runtime the way a website loads a webfont. The strategy is:

- **`src/model/tablerIcons.ts`** vendors the needed glyphs as **verbatim
  upstream path data** from Tabler's `icons/outline/` set — never a local
  redraw. Adding an icon means adding the upstream bytes to `TABLER_ICONS`;
  nothing else needs to change for the glyph to be usable everywhere.
- **`tablerIconsJs()`** rides the existing `/*KARST_DS_JS*/` marker and
  **`tablerIconsCss()`** rides `/*KARST_DS_CSS*/` — the same
  `injectDesignSystem(html)` seam as tokens, primitives and the async-action
  runtime. Every webview gets the catalog and the `karstIcon()` helper **by
  construction**; a new screen never needs a second icon mechanism (UI-R01).

### Rendering an icon

```js
karstIcon('refresh')              // → full <svg class="k-icon" …>…</svg> at 16px
karstIcon('terminal-2', 13)       // row-sized
karstIcon('refresh', 12, 'reload-icon')  // extra class beside .k-icon
```

Static markup (a button that exists before any script runs) inlines the same
path data inside a `.k-icon` svg — see §4.

## 2. The mapping — Karst concepts → Tabler glyphs

| Karst concept | Tabler glyph | Notes |
|---|---|---|
| Start service / spin | `player-play` | play glyph, canonical Tabler |
| Launch dev host (worktree) | `play-bug` | debug-play glyph — the worktree "launch dev" action, kept distinct from plain Start (ticket: bug icon appeared instead of play) |
| Stop service / session | `player-stop` | stroked square, canonical Tabler |
| Restart service / reload | `refresh` | circular arrow — also the settings "reload lists" glyph |
| Open in browser / external | `external-link` | address row action |
| Copy URL / branch | `copy` | |
| Show ticket changes (diff view) | `git-compare` | worktrees panel header |
| Session / terminal | `terminal-2` | sidebar session row + open-session actions |
| Open dashboard | `layout-dashboard` | sidebar body action |
| Open resource monitor | `dashboard` | sidebar toolbar |
| Open token usage stats | `chart-bar` | sidebar toolbar |
| Edit ticket | `pencil` | |
| Archive ticket | `archive` | |
| Restore / unarchive | `history` | matches the command palette's `$(history)` |
| Delete / destructive remove | `trash` | danger variant on the control, never the glyph |
| New ticket | `plus` | toolbar |
| Search / filter | `search` | toolbar + facets |
| Settings | `settings` | toolbar |
| Expand disclosure | `chevron-right` | rotates 90° when open |
| Dropdown disclosure | `chevron-down` | the `--chevron` data-URI, §4 |
| Done check (status glyph) | `circle-check` | sidebar compact row |
| Copy confirmation flash | `check` | transient button feedback |
| Server rack (empty state) | `server-2` | "no servers running" mark |
| Not runnable (empty state) | `circle-x` | "no runnable services in scope" mark |

Scope note: **attach/detach** and **clear-terminal** controls have no current
UI surface; when one appears it uses a native Tabler glyph (`link`/`unlink`
family, `trash-x`-family as appropriate) — never a bespoke drawing. The
initial-scope concept list from ticket 869eh4f40 is covered by the rows above
(open terminal → `terminal-2`, kill/close → `player-stop`, show logs → the
console surface's `terminal-2` identity, external/open → `external-link`).

## 3. Delivery details

- `karstIcon(name, size, cls)` renders the full `<svg>` with the canonical
  attributes: `viewBox="0 0 24 24"`, `aria-hidden="true"`, `focusable="false"`,
  `class="k-icon"` (+ optional extra class), `width`/`height` = `size`
  (default **16px** — the compact-toolbar baseline).
- **An unknown name renders `''`, never throws** — the render must never blow
  up a row because of a typo; the discovery test in `tablerIcons.test.ts`
  catches a misspelled name at test time (same contract as `applyTransforms`).
- `KARST_TABLER_ICONS` (the catalog object) is also exposed in the runtime for
  any future consumer; today `karstIcon` is the only sanctioned accessor.

## 4. Central sizing/stroke rules — one treatment, size is local

The canonical Tabler render is the treatment every glyph gets:

- **viewBox 24×24** (`TABLER_VIEWBOX`)
- **stroke-width 2** (`TABLER_STROKE`) — Tabler's canonical weight on a 24 grid
- `stroke: currentColor` — **theme-driven colour**: the glyph inherits the
  colour of whatever surface it sits on (the `.k-iconbtn` resting hues are
  the action tones, `--k-running`/`--k-attention`/`--k-failed`/`--k-passed`,
  keyed by action meaning — see the dashboard's `TONE` map)
- `stroke-linecap: round`, `stroke-linejoin: round`, `fill: none`

These live in **one place**: the `.k-icon` rule emitted by
`tablerIconsCss()` and the attributes emitted by `karstIcon()`. A surface may
change an icon's **size** (13–15px rows, 16px default) and its **colour**
(always via tokens/`currentColor`), never its stroke geometry. The dashboard's
`.ib svg` sizing (token-derived) and the sidebar's 13px rows are local
geometry — exactly the local-vs-shared split of UI-R04/R05.

The one glyph that cannot inherit colour: the **`--chevron` data-URI**
(settings + ticketForm dropdowns). A CSS background image cannot consume a
custom property; the Tabler path is embedded with a fixed mid-gray, documented
at its definition as the accepted exception.

## 5. Product-specific exceptions — documented, not silently second-styled

These stay **outside** the catalog by design. They are identity marks, not
interaction icons, and Tabler cannot express them (UI-R10c requires each agent
core's canonical mark, for example):

1. **The karst brand mark** — `media/karst.svg` / `media/karst-mark.svg`, the
   sidebar's `ic.mark` (215-viewBox silhouette), the dashboard artifact-origin
   chip's `KARST_MARK` (24-viewBox line version), the settings/gettingStarted
   footers, and the status-bar/session `karst-<glyph>` icons written by
   `src/ui/glyphIcon.ts`.
2. **Agent-core logos** — `src/model/agentIdentity.ts` (`AGENT_ICONS`,
   `AGENT_LINE_ICONS`): Claude Code, Codex, OpenCode, Antigravity marks.
3. **Ticketing-provider logos** — `src/model/providerIdentity.ts` (ClickUp).

Anything else that looks like an icon — including a glyph invented for a "new"
concept — belongs in `TABLER_ICONS` as upstream Tabler bytes, or it does not
ship (the "no `<g id="i-` sprite" pin in `tablerIcons.test.ts` enforces this).
VS Code's own `$(codicon)` literals in `package.json` command declarations are
the platform's affordance system, not Karst's UI, and are out of scope.

## 6. License / attribution

Tabler Icons is MIT-licensed. The copyright notice and license text live in
`THIRD_PARTY_NOTICES.md` (repo root — it ships in the VSIX); `tablerIcons.ts`
carries the attribution header and `tablerIcons.test.ts` pins it, so the
notice cannot be edited away.

## 7. Adding an icon (checklist)

1. Copy the upstream `<path>` markup from `icons/outline/<name>.svg`
   (raw.githubusercontent.com/tabler/tabler-icons/main/icons/outline/).
2. Add it to `TABLER_ICONS` in `src/model/tablerIcons.ts`.
3. Use it via `karstIcon('<name>', <size>)` in templated markup, or inline the
   path data in a `.k-icon` svg for static markup.
4. No test changes are required — the discovery test picks the new glyph up
   automatically. (Only add a pin if the glyph is load-bearing enough to
   deserve one, like `check`.)
