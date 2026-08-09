---
name: karst-patterns
description: Coding patterns extracted from the karst repository git history — commit conventions, module layout, colocated test discipline, and recurring change workflows
version: 1.0.0
source: local-git-analysis
analyzed_commits: 200
---

# Karst Patterns

VS Code extension: AI-agent ticket orchestration across a multi-repo stack. TypeScript, ESM, vitest, better-sqlite3 + `node:sqlite` (CLI).

## Commit Conventions

Two styles coexist in history:

- **Conventional commits** (~100/200): `feat(scope): …`, `fix(scope): …`, `chore: …`, `docs: …`, `refactor(ui): …`, `test(init): …`. Scopes seen: `dashboard`, `sidebar`, `ship`, `workflow`, `store`, `agent`, `hooks`, `cli`, `runtime`, `driver`, `onboarding`, `welcome`, `init`, `package`, `brief`, `stages`, `review`, `session`.
- **Bracketed ticket style** (~77/200): `[FEAT] …`, `[FIX] …` — used on PR squash merges, usually ending `(#NN)`.

Rule for new work: use conventional commits (`<type>(<scope>): <description>`). PR titles may use the bracketed form. Subject states the *effect*, not the file touched — e.g. `fix: make everything karst writes into a worktree unstageable`, not `fix: update karstExcludes.ts`.

## Code Architecture

```
src/
├── extension.ts     # activation entry — the only place vscode bindings are wired
├── agent/           # AgentAdapter impls (claude, codex, antigravity, opencode), model catalog, token usage
├── agents/          # agent-facing prompt/marker assets
├── approaches/      # approach package install/classify/sanitize/resolve
├── attachments/     # ticket attachment download + markdown embedding
├── cli/             # `karst` CLI — node:sqlite only, never better-sqlite3
├── commands/        # generated /karst:<id> command assets
├── context/         # ticketContext — single shaping point for seed + CLI
├── diagnostics/     # issue reporting; OBSERVES only, never writes
├── extension/       # extension-host helpers split out of extension.ts
├── hooks/           # agent hook endpoint
├── init/            # fresh-install scaffolding + setup checklist
├── integrations/    # ticketing providers (ClickUp, GitHub, git) — substantial
├── logging/         # Karst output channel + error routing
├── manifest/        # karst.yml types/schema/validate/load/write/migrate
├── model/           # pure view-model builders (palette, nowLine, prPanelView, inside/)
├── project/         # project slug + binding (multi-window scoping)
├── recovery/        # session/stage recovery rounds
├── resolver/        # manifest → runnable resolution
├── runtime/         # worktrees, servers, ports, branch names, path scope
├── store/           # SQLite: one module per table + schema.sql + migrations.ts
├── template/        # {variable|transform} grammar — token.ts + transforms.ts
├── ui/              # webviews: dashboard/ sidebar/ settings/ ticketForm/ gettingStarted/
└── workflow/        # stage machine, graph, driver, gates/, stages/
```

Layering rules the history enforces:

- `vscode` is never a runtime import outside thin binding wrappers — logic takes injected interfaces (`PanelHost`, `TerminalHost`, `GhRunner`, `GateRunner`, `AgentAdapter`) so everything runs under vitest with fakes.
- One store module per table (`store/prs.ts`, `store/stageBlocks.ts`, …); every one of them has a sibling `.test.ts`. Elsewhere colocated tests are the strong default but not an invariant — pure leaf helpers (`agent/hookFailureLog.ts`, `workflow/gates/result.ts`) are covered by their consumers' suites instead.
- Webviews are plain HTML + injected CSS/JS (CSP forbids external assets); host-side TS constants mirrored into HTML are pinned by differential tests.
- Files stay small — 200–400 lines typical, 800 max. Large modules get split by responsibility, not by type.

## Workflows

### Adding a schema column
1. Add to `src/store/schema.sql` (fresh DBs).
2. Add a **guarded** ALTER in `src/store/migrations.ts` (guards read current columns, so re-open is a no-op).
3. Bump `SCHEMA_VERSION`.
4. Update `src/store/db.test.ts` version and table-count assertions.
5. Migrations never backfill data they cannot derive — defer to the host.

### Adding a manifest field
1. `src/manifest/types.ts` → 2. `validateManifest` in `schema.ts` (with a default) → 3. **`writeManifest` overlay in `write.ts`** (else Save silently drops it) → 4. `manifest/fixtures.ts` for repository/service fields.
Guard: `writeManifest.test.ts` "round-trips every modeled section".

### Adding a UI control
1. Read `docs/ui/UI-RULES.md`; every change is judged pass/fail against a numbered rule (`UI-R01`…). Cite the rule id in the commit.
2. Only `--k-*` tokens as style values — no hex, `rgba()`, raw px/rem, radius, shadow, duration.
3. Any control that posts to the host: local pending state on click, `aria-busy`, single-trigger guard, terminal `{type:'action-result', requestId, ok, message?}`, and a watchdog reporting "unknown" on timeout.
4. Actions are `<button>`, navigation is `<a href>`; icon-only controls carry identical `aria-label` + `title` ≤80 chars.

### Adding an agent core
1. New adapter in `src/agent/<name>.ts` implementing `AgentAdapter`.
2. Optional `materializeApproach` translating the neutral approach package into launch args — every target path guarded with `existsSync` before writing, and only self-created paths returned as `ownedPaths`.
3. Add the "never claims or overwrites pre-existing repository …" test, mirroring `codex.test.ts` / `claude.test.ts` / `antigravity.test.ts`.

### Adding a model
Edit **both** `src/agent/modelCatalog.ts` (`BUNDLED_CATALOG`) and root `model-catalog.json`; `modelCatalog.test.ts` "matches the published model feed exactly" fails otherwise. No model literal in any HTML.

## Testing Patterns

- **Strict TDD, RED→GREEN.** Behavior lands with its test in the same commit; there is no trailing "add tests" commit in history.
- Tests colocate as `<module>.test.ts` beside the source (`store/prs.ts` ↔ `store/prs.test.ts`). Integration suites use the `.integration.test.ts` suffix (`workflow/lifecycle.integration.test.ts`, `runtime/spin.integration.test.ts`).
- `npm test` → vitest run, SQLite via `openStore(':memory:')`. Single file: `npx vitest run src/path/to.test.ts`. Typecheck: `npm run typecheck`.
- Coverage target 80%+.
- **Discovery tests over enumeration**: `ui/designSystem.test.ts` and `ui/webviewCsp.test.ts` walk the webview directories rather than listing them, so a new webview cannot ship outside the system silently. Prefer this shape for any invariant that must hold across a growing set.
- **Differential tests** pin every TS→HTML mirrored constant (`SECTION_FIELDS`, `TICKET_TYPES`, `TRANSFORM_NAMES`, `deriveKey`) by running the webview copy against the host module.
- **Verbatim fixtures for parsed external output.** `git merge-tree` output fixtures in `mergeCheck.test.ts` / `mergeSync.test.ts` / `ship.test.ts` are real git bytes — an invented layout is what let the original parse bug pass its own tests.
- **Non-interference tests** assert import-graph boundaries: `diagnostics/nonInterference.test.ts` fails on `child_process`, `node:http`, `src/workflow/`, `src/hooks/`, or write SQL reachable from a reporting entry point.

## Recurring Fix Themes

History shows the same classes of defect recurring; check for them proactively:

- **Shared global state across IDE windows** — the DB lives in global storage. Scope every ticket query by `projectId`; per-window values go in `workspaceState`, never `globalState`.
- **Event-loop blocking in the extension host** — all gate commands go through `workflow/gates/run.ts` (async spawn). `spawnSync` is banned on that path.
- **Stale state read as current** — PR status, merge checks and server rows are re-probed, filtered on read, and a failed lookup (`unknown`) is never read as success.
- **Untrusted text reaching a verdict, log or label** — agent/CLI prose is collapsed to one line and capped; hook event names and CLI failure categories are normalized against closed unions before use.
- **Karst's own files entering a commit** — anything written into a worktree goes through `runtime/karstExcludes.ts` and under `.karst/`, never the tree root.
