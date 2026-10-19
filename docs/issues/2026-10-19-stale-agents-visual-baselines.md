<!-- AGENT INSTRUCTIONS:
This file uses an agent-optimized block format. DO NOT read this file entirely.
1. TABLE OF CONTENTS: Run this to list all available keys:
   grep -F "## [@" docs/issues/2026-10-19-stale-agents-visual-baselines.md

2. EXTRACT A RULE: Run this to read a specific block (Example for ID 'issue:BASE-01'):
   awk "/^## \[@issue:BASE-01\]/,/END_DOC_BLOCK: \[@issue:BASE-01\]/" docs/issues/2026-10-19-stale-agents-visual-baselines.md
-->
# Stale agents-page visual baselines (2026-10-19)

The UAT visual gate of ticket 706 (2026-10-19) failed on the three
Settings → Agents screenshots in all three themes. The baselines were stale:
they picture a Settings → Agents page that the code stopped rendering five
commits earlier. Nothing in the ticket's own change was involved — the drift
was inherited from `develop`.

| Item | Value |
| --- | --- |
| Failing shots | `agents-roles`, `agents-compare`, `agents-profile` × `dark` / `light` / `hc` |
| Stale commit | `787abaea` (feat(quota) — "re-record agents page visual baselines") |
| Page it pictures | pre-#651: one `Agent backend` dropdown, "host (prompted, no sandbox)" |
| Page the code renders | #651 (`7145886e`): per-core rows, "Choose per core: host stays the default" |
| Repair | the nine baselines restored from `7145886e` |

## [@issue:BASE-01] How a stale baseline set was committed

`787abaea` re-recorded the nine agents-page baselines "in the pinned Docker
image", but from a tree that predated #651 — the same per-core work that
`7145886e` had already recorded. The committed images show the old page:

| Signal | Reading |
| --- | --- |
| `agents-profile.png` blobs at `787abaea` | byte-identical to `e7868e86` (pre-#651), so not re-rendered |
| `agents-roles.png` / `agents-compare.png` blobs | new, but their pixels show the old `Agent backend` dropdown |
| `src/ui/settings/app/sections/BackendPanel.tsx` at HEAD | renders "Choose per core: …" and one row per core; the text "Opt-in:", "Agent backend" and "sbx: not checked" no longer exists in it |

The baseline drift reached `main` unnoticed because the CI `visual` job is
advisory (a screenshot diff does not block a PR); the host UAT gate is the
first place the sweep is a hard verdict.
END_DOC_BLOCK: [@issue:BASE-01]

## [@issue:BASE-02] The repair, and the rule for the next re-record

The nine agents-page baselines are restored from `7145886e` — the last
recording made from the tree that renders the current page (recorded in the
pinned image, user-approved for the #651 per-core rows). No fixture code and
no agents-section code changed between `7145886e` and HEAD, so that recording
is exactly what HEAD renders; the only `src/ui` change in between is
`src/ui/session.ts`, which the Settings webview does not load.

Re-recording rules that keep this from repeating:

- Re-record from a **clean tree at HEAD** in the pinned image
  (`npm run -s test:visual:docker:update`), never from a branch, a stash or a
  worktree that predates the page change.
- Open the recorded PNG and check it against the current page before
  committing. A changed blob proves only that the file was rewritten, not
  that it was rewritten from the right tree — the roles/compare set here was
  new and still wrong.
- Prefer the last recording that matches the rendered page over a fresh one
  when the page itself did not change: restoring the `7145886e` set fixed
  nine shots without re-rendering anything.
END_DOC_BLOCK: [@issue:BASE-02]
