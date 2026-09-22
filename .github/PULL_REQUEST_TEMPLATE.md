<!--
Read this before you spend effort. Two things block a merge regardless of how
good the code is: an unsigned CLA, and a broken architecture invariant.
-->

## What this changes

<!-- One paragraph. What behaviour is different after this merges? -->

Closes #

## Before you opened this

- [ ] **Targets `develop`**, not `main`.
- [ ] **I will sign the [CLA](../blob/main/CLA.md).** A bot comments with the
      signing line on this pull request. Unsigned pull requests cannot be
      merged — not as a formality, it is what keeps Karst's licence able to
      convert to Apache 2.0.
- [ ] **An issue exists** for anything beyond a small fix, and the approach was
      agreed there. Karst has invariants that reject otherwise-good code.
- [ ] **I read the architecture document** covering what I touched —
      [CONTRIBUTING.md § 3](../blob/main/CONTRIBUTING.md#3-architecture-invariants)
      maps areas to files.

## Tests

- [ ] A test fails before this change and passes after it (RED → GREEN).
- [ ] `npm run typecheck`, `npm run test:unit` and `npm run test:e2e` pass
      locally.

<!-- If a test was not written, say why here. "Refactor, covered by existing
     tests" is an answer; silence is not. -->

## Invariants

Tick only what your change touches.

- [ ] **Host-agnostic core** — no new `vscode` import outside the binding
      layer; logic takes injected interfaces.
- [ ] **SQLite is the source of truth** — stage mutation through `setStage`,
      agent state through `setAgentState`.
- [ ] **Verdicts are deterministic** — exit codes, never an agent's
      self-report. `null` never transitions.
- [ ] **The extension host event loop is never blocked** — no `spawnSync` on a
      gate path.
- [ ] **Debug logging** — new stage runner, gate or adapter logs at entry,
      decision branch and exit, through the injected `debug` callback. No
      secrets, tokens, full prompts or repository contents.
- [ ] **UI** — judged against `docs/ui/UI-RULES.md`; the rule id is cited in
      the commit message where a change exists to satisfy one (UI-R35).
