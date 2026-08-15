# Task 4 report — P2 hygiene fixes

## Implementation

1. **Graph needs-you rail**
   - Added `graph-panel` as a navigational `RailCta` and passed the current
     stage blocker into `railNeeds` from dashboard state.
   - `approach-graph-failed` now says the graph needs a recovery decision;
     `awaiting-impl-marker` says it needs the implementation marker. Both use
     the compact `Open graph` control.
   - The dashboard webview maps `graph-panel` to `#inside`, the owner of graph
     recovery controls and marker guidance. It does not reuse `open-session`:
     a terminal graph has no live ticket session to focus.

2. **ACP map lifecycle**
   - A `session-ended` event now removes both the supervised session and ACP
     handle entries after terminal accounting. Subsequent lookup and permission
     replies cannot treat the terminal peer as live.

3. **Canonical-graph parse diagnostic**
   - After a claimed token is consumed, an unparseable canonical graph emits a
     `completion-rejection` line through `emitGraphDiagnostic`.
   - The line uses only fixed wording; it never includes parser prose or graph
     JSON. The shared emitter caps and redacts the line before it reaches the
     injected debug sink. Deterministic completions now forward their host
     debug sink to this shared seam.

4. **Driver transport capabilities**
   - Exported the readonly `SUPERVISED_CLI_TRANSPORT_CAPABILITIES` from the
     supervised transport and made the driver test harness return it instead
     of an inaccurate `exactModel: true` literal. Production values remain
     `exactModel: false`, `attributedTermination: true`.

5. **Documentation**
   - Added a dated update to the wrong-checkout review recording the launch,
     recovery, workspace, and E2E fixes delivered by `6fa8211`.
   - The update explains that `model/nowLine.ts` is stale because the standalone
     Now line was removed; its header ship decision now lives in
     `src/model/shipSlot.ts`. `railNeeds.ts` comments now use the same current
     terminology.

## Files

Production: `src/model/railNeeds.ts`, `src/ui/dashboard/state.ts`,
`src/ui/dashboard/webview.html`, `src/approaches/graph/transport/acpTransport.ts`,
`src/approaches/graph/coordinator/completion.ts`, `src/approaches/graph/driver.ts`,
and `src/approaches/graph/transport/supervisedCliTransport.ts`.

Tests: matching rail, dashboard state/webview, ACP transport, completion, and
driver test files.

Documentation: `docs/superpowers/plans/2026-08-15-review-wrong-checkout-graph-launch.md`.

## RED / GREEN evidence

- ACP lifecycle RED: the new terminal-session regression saw the stale session
  remain in the map (`expected []`, received one session). GREEN: the focused
  ACP and completion suites passed 34 tests after deletion.
- Completion diagnostic RED: after rebuilding the Node ABI through
  `npm run test:unit -- src/approaches/graph/coordinator/completion.test.ts`,
  the new malformed-canonical-graph test observed zero debug lines. GREEN:
  the bounded `completion-rejection` line is emitted and the token remains
  consumed without a successor.
- Rail RED: both graph blockers returned `null`; dashboard state provided no
  rail explanation; the webview lacked `graph-panel` navigation. GREEN: the
  rail/model, dashboard state, and webview focused suites passed 370 tests.

## Verification

- Focused: 7 files, 444 tests passed.
- `npm run typecheck` passed.
- `npm run test:unit` passed: 425 files, 7,693 tests.
- `npm run build` passed.
- `git diff --check` passed.

## Self-review

- Rail wording is host-owned, compact, blocker-specific, and points to the
  actual graph owner. The new CTA only navigates; it cannot advance a stage.
- ACP deletes both maps on the sole terminal transport event path, after
  process-run closure, and repeated terminal events remain harmless.
- The parse diagnostic routes only fixed, untrusted-input-free detail through
  the shared cap/redaction emitter; no graph content or parser text is logged.
- The test harness now reflects the actual supervised transport capability
  contract without changing graph adapter capability semantics.
- Documentation preserves the original review evidence while clearly marking
  its pre-fix conclusions as superseded by `6fa8211`.

## Concerns

None. The initial direct `npx vitest` completion run encountered the documented
better-sqlite3 ABI mismatch; rerunning through the unit-test script rebuilt the
Node addon and produced the expected test-level RED result.
