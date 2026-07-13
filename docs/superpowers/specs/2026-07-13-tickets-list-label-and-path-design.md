# Tickets List — Configurable Label + Relative Worktree Path — Design Spec

**Date:** 2026-07-13
**Area:** D of todo-4 decomposition (see `docs/todo-4.md`)
**Status:** ✅ Approved (variables + config UI locked via AskUserQuestion)

## Context

`docs/todo-4.md` decomposed into four sub-projects (A create-flow, B approaches,
C agents, D tickets list). A/B/C done; `services` port rename done (`1bb815f`).
This spec covers **D — tickets list**, two items:

- **D1 — configurable ticket label.** The label shown in the sidebar/dashboard/
  tab is hardcoded `"<key> — <title>"`. Users want a template string with
  variables, editable in Settings.
- **D2 — relative worktree path bug.** With `worktreePathDisplay: relative` set,
  the sidebar's expanded **Worktrees** line still shows the absolute path
  (`/Users/nd/Work/projects/tatto-timer`) instead of `./tatto-timer`.

## Grounded data model (do not re-derive)

### D1
- `ticketLabel(ticket)` (`src/store/tickets.ts:55`) is the SINGLE source of the
  `"<key> — <title>"` convention — returns `${key ?? #id} — ${title ?? (untitled)}`.
- Callers: `extension.ts:576,663`, `sidebar/items.ts:33`, `dashboard/panel.ts:65`,
  `onboarding/panel.ts:113`. All must pass the resolved template.
- `Ticket` carries `key`, `id`, `title`, `stageCurrent`, `agentState`,
  `selectedRepos` — the substitution source.
- New manifest field plumbing mirrors `worktreePathDisplay` exactly (CLAUDE.md
  checklist): `types.ts:138` → `schema.ts:269/342` (validate + wire) →
  `write.ts:102` (writeManifest overlay, else Save drops it).

### D2
- `repoDisplayPath(repo, ctx)` + `PathContext` live PRIVATE in
  `dashboard/state.ts:39/51`. Dashboard maps each worktree adding `repoDisplay`.
- Sidebar webview ALREADY renders `w.repoDisplay || w.repo`
  (`sidebar/webview.html:166`) — it's waiting for the field.
- `buildSidebarState` (`sidebar/state.ts:49`) puts the RAW `WorktreeView` in rows
  and never computes `repoDisplay` → falls back to absolute `w.repo`. **That is
  the whole bug.**
- `worktreePathContext(currentManifest)` (`extension.ts:738`) already produces the
  dashboard's `PathContext`; the sidebar panel (`sidebar/panel.ts:66`) calls
  `buildSidebarState` with NO context.

## Locked decisions (AskUserQuestion, 2026-07-13)

- **Variables available:** `{key} {title} {id} {status} {stage} {repos}` — the
  FULL set is substitutable so users CAN build richer labels, **but the default
  template stays `{key} — {title}`** (status/stage/repos are opt-in, never in the
  default).
- **Config surface:** a **Settings › General** text field writing manifest
  `ticketLabelTemplate`, with a **live preview** and the variable list shown.

## D1 — Design

### Manifest field
- `ticketLabelTemplate?: string` on `Manifest`. Absent → default
  `'{key} — {title}'`. Plumb through the 3-point checklist (types/schema/write).
- Validate: a string. Empty string → treat as unset (fall back to default) so a
  blank field can't erase every label. No hard failure on unknown `{vars}`
  (forward-compatible); unknown tokens render empty (see engine).

### Template engine (new vscode-free module `src/store/ticketLabelTemplate.ts`)
- `renderTicketLabel(ticket, template?)` — pure, unit-tested.
- Substitution map (each token resolves with the SAME fallbacks the current label
  uses, so the default template reproduces today's output byte-for-byte):
  - `{key}`   → `ticket.key ?? '#' + ticket.id`
  - `{title}` → `ticket.title ?? '(untitled)'`
  - `{id}`    → `String(ticket.id)`
  - `{status}`→ `ticket.agentState ?? ''`
  - `{stage}` → `ticket.stageCurrent ?? ''`
  - `{repos}` → `ticket.selectedRepos.join(', ')`
- Unknown `{token}` → empty string (never leaks a raw brace; forward-compatible).
- Whitespace: after substitution, collapse a label that trims to empty back to the
  default render (guards a template of only-empty vars, e.g. `{status}` on a fresh
  ticket, from yielding a blank row).
- `ticketLabel(ticket)` becomes a thin wrapper: `renderTicketLabel(ticket)` with
  the default template — so existing zero-arg callers keep working while callers
  that have the manifest pass the configured template. (Keeps `ticketLabel`'s name
  stable; avoids editing all 5 call sites' signatures if a wrapper suffices — the
  host resolves the template once and passes it where a ticket is labelled.)

### Threading
- Host resolves `manifest.ticketLabelTemplate` once and passes it to the label
  call sites (sidebar items, dashboard/onboarding panel titles, spin picker).
  Prefer a single resolved-template getter over re-reading the manifest per row.

### Settings UI (Settings › General)
- Text input bound to `ticketLabelTemplate` in the settings draft, Save writes it
  via `writeManifest`. Follows the existing settings field pattern (draft +
  markDirty + Save), all `--vscode-*` tokens.
- **Live preview** line: render the template against a representative ticket
  (a real ticket if one exists, else a synthetic sample) using the SAME engine —
  extract a JS mirror or push a host-computed preview. Show the variable list
  (`{key} {title} {id} {status} {stage} {repos}`) as a hint.
- Blank field → preview shows the default; never blocks Save.

## D2 — Design

- **Extract** `repoDisplayPath` + `PathContext` from `dashboard/state.ts` into a
  shared vscode-free module (e.g. `src/ui/worktreePath.ts`); dashboard imports it
  (no behavior change, covered by existing dashboard tests).
- `buildSidebarState(store, { facet, filter }, pathContext?)` — new optional 3rd
  arg. Map worktrees to add `repoDisplay: repoDisplayPath(w.repo, ctx)`, mirroring
  the dashboard. `TicketRow.worktrees` element type gains `repoDisplay: string`.
- `SidebarPanel` gains a `pathContext?: () => PathContext | undefined` dep (like
  `DashboardPanel` at `panel.ts:54`); `extension.ts` wires
  `() => worktreePathContext(currentManifest)`.
- Webview needs NO change (already reads `w.repoDisplay || w.repo`).

## Cross-cutting

- **Immutability:** engine is pure; state builders return new objects.
- **Error handling:** template render degrades to default on any malformed input;
  never throws across the message boundary.
- **Validation at boundary:** manifest field validated in `schema.ts`; settings
  input trimmed; empty → default.
- **Architecture invariants:** no `vscode` import in engine or path module; both
  unit-tested under vitest.
- **File size:** engine + path helper are small focused modules; `webview.html`
  gains only the General field render, no logic.

## Tests (TDD, RED first)

- `ticketLabelTemplate.test.ts` — default template == old `ticketLabel` output for
  key/no-key/no-title cases; each variable substitutes; unknown token → empty;
  all-empty result falls back to default; `{repos}` joins.
- `tickets.test.ts` — existing `ticketLabel` assertions stay green (wrapper).
- `sidebar/state.test.ts` — with a `relative` PathContext, worktree rows carry
  `repoDisplay` (`./name`); without context, `repoDisplay === repo` (absolute).
- `dashboard/state.test.ts` — unchanged (extraction is behavior-preserving).
- `manifest/load.test.ts` — `ticketLabelTemplate` parses; absent → undefined;
  empty → undefined/default.
- `writeManifest.test.ts` — round-trips `ticketLabelTemplate`.
- `settings/state.test.ts` / `actions.test.ts` — field surfaces in settings state;
  Save writes it.

## Out of scope

- Areas A/B/C (done).
- Per-surface label overrides (one template governs all surfaces).
- Rich token formatting (padding, conditionals) — plain `{var}` substitution only.

## Plan ordering

1. D2 first (small, isolated): extract path helper → thread into sidebar → wire host.
2. D1 engine (RED) → `ticketLabel` wrapper → manifest field (types/schema/write).
3. D1 host threading of resolved template into label call sites.
4. D1 Settings › General field + live preview.
