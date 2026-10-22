# Prerequisite Report: Dashboard React Migration (DASHBOARD-SANDBOX-AS-A-FULL)

- **Ticket:** DASHBOARD-SANDBOX-AS-A-FULL (T735)
- **Title:** Dashboard: Sandbox as a full-width placement strip above the grid (V1)
- **Date:** 2026-10-22
- **Verdict:** STOP AND REPORT (Prerequisite Not Landed)
- **Governing Constraints:** `@ui:REACT-VIEWS`, `CLAUDE.md`, Ticket Scenario "Given the React migration prerequisite has not landed..."

---

## 1. Executive Summary

This ticket specifies replacing the dashboard's separate half-width Sandbox panel with a full-width placement strip directly below the stage rail and above the 2x2 grid (variant V1).

However, the ticket prompt and acceptance criteria contain an explicit prerequisite guard:

> **Done when:**
> - Delivered as the sandbox slice of the dashboard's React migration; if that prerequisite has not landed, stop and report rather than editing the vanilla view.

> **Scenario:**
> - Given the React migration prerequisite has not landed, when the work is attempted, then a report is produced and the existing dashboard's Sandbox panel remains unchanged.

> **Context brief:**
> - Constraint: the dashboard is a vanilla v3.0 view. Per `ui:REACT-VIEWS` this feature needs the view migrated first; V1 is the sandbox slice of that migration and must not be committed to the vanilla webview beforehand. The prerequisite migration ticket is scoped separately.

Inspection of the repository confirms that the dashboard webview has **not** yet been migrated to React. In strict adherence to `@ui:REACT-VIEWS` and the ticket's acceptance conditions:
1. Work on modifying the dashboard view has stopped.
2. No edits have been made to the vanilla `src/ui/dashboard/webview.html` or existing dashboard view models.
3. The existing dashboard Sandbox panel and its integration tests remain untouched and functional.
4. This report is filed to record the prerequisite block and provide clear guidance for subsequent scheduling.

---

## 2. Findings and Evidence

### 2.1 Current State of `src/ui/dashboard`
- The dashboard is implemented entirely as a vanilla webview v3.0 surface (`src/ui/dashboard/webview.html`, ~407 KB) using direct DOM manipulation and template string rendering.
- No React application directory (`src/ui/dashboard/app/`) or React components (`.tsx`) exist in the dashboard subsystem.
- In contrast, the reference React webview in `src/ui/settings/app/` provides the target architecture:
  - Mounted once into `#root` via `app/main.tsx` owning `acquireVsCodeApi()`.
  - Component tree in `app/sections/` and `app/primitives/`.
  - Dedicated component stylesheets bundled via `esbuild`.

### 2.2 Invariant Constraints
- **`CLAUDE.md`**:
  > "React is the target for all webviews. Settings (`src/ui/settings/app/**`) is the reference pattern: mounted once into `#root`, `app/main.tsx` owns the single `acquireVsCodeApi()`, tests use `renderWebviewReady('<view>')`. New UI features are React only. The remaining views are vanilla (`ui:APPX-V31`) until migrated. Migrate one view per change, preserving behavior: no baseline or ledger edits, the parity floor holds, and the visual, unit and integration gates pass. On a vanilla view, only bug fixes are allowed; a feature there means migrating the view first, as a separate change. This supersedes the 'other views stay vanilla' scope in `ui:REACT-VIEWS` and the UI-RULES v3.1 annex (`ui:APPX-V31`)."
- **`docs/ui/UI-INVARIANTS.md` (`@ui:REACT-VIEWS`)**:
  > "Views not yet migrated stay vanilla v3.0: bug fixes only, and a feature there means migrating the view first, as a separate change."
- Committing variant V1 directly into `src/ui/dashboard/webview.html` would introduce a major feature redesign onto a vanilla v3.0 surface, directly violating both `CLAUDE.md` and `@ui:REACT-VIEWS`.

### 2.3 Verification of Unchanged Dashboard State
- `src/ui/dashboard/webview.html` remains unmodified.
- Existing unit tests (`src/ui/dashboard/sandboxView.test.ts`) pass without regression (6/6 tests passing).
- Existing integration tests (`src/ui/dashboard/sandboxCard.render.integration.test.ts`) pass without regression (8/8 tests passing).
- Typecheck (`npm run typecheck`) and documentation linting (`npm run docs:check`) pass cleanly.

---

## 3. Recommended Resolution

1. **Schedule Prerequisite Ticket:**
   Scope and execute a dedicated ticket to migrate `src/ui/dashboard` to React (following the `src/ui/settings/app` reference architecture with 100% behavioral and baseline parity).
2. **Execute DASHBOARD-SANDBOX-AS-A-FULL Post-Migration:**
   Once the dashboard's React foundation is landed, implement variant V1 (full-width placement strip above the grid with labelled actions, wrapping facts, and danger treatment on Remove) as a component within `src/ui/dashboard/app/`.
