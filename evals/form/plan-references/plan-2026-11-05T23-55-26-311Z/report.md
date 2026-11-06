# Form planner bench

- pass: plan; provider claude; judge `claude-sonnet-5-5` via claude (effort high); started 2026-11-05T23:55:26.311Z
- Ground truth is the gold fix patch and the F2P tests, hidden from the planner. The judge is blind to the model and scores the union of the drafts.
- Excluded and counted, never scored 0: judge-errors, runs with no draft, timeouts and call errors.

## By model

| model | runs | scored | judge errors | no draft | timeouts | errors | notDone | unrequested | f2p coverage | static defect rate | planner tokens (reported) | judge tokens (reported) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| claude-opus-5-5 | 6 | 6 | 0 | 0 | 0 | 0 | 0.67 | 0.83 | 81% | 0% | 1541557 | 228272 |

## Per case

| case | model | status | drafts | notDone | unrequested | f2p | static defects |
|---|---|---|---|---|---|---|---|
| vuejs/core:pr-8470 | claude-opus-5-5 | ok | 1 | 0 | 0 | covered | none |
| vuejs/core:pr-8785 | claude-opus-5-5 | ok | 1 | The gold change is in resolveSetupReference(), so PROPS bindings also resolve for non-dotted component tags (step 4 lookup). Draft 1 explicitly limits the PROPS lookup to dotted tags. The gold's extra behavior for plain tags is not requested. The failing tests only check dotted tags. | 0 | covered, covered | none |
| vuejs/core:pr-9213 | claude-opus-5-5 | ok | 1 | 0 | Handle a symbol key by falling back to `_${name}` as the base key before the `_fb` suffix is appended. | partial, covered | none |
| mui/material-ui:pr-23778 | claude-opus-5-5 | ok | 1 | 0 | 0 | covered | none |
| mui/material-ui:pr-24010 | claude-opus-5-5 | ok | 1 | 0 | 0 | covered | none |
| mui/material-ui:pr-23806 | claude-opus-5-5 | ok | 1 | Replace React.useEffect with useEnhancedEffect (imported from ../utils/useEnhancedEffect) in useMediaQuery.js. The match state then updates synchronously, as a layout effect, on the client after the first render.<br>Add a 'Client-side only rendering' section to use-media-query.md. It explains the noSsr option and the global theme default through MuiUseMediaQuery defaultProps.<br>Rewrite the options.noSsr docs text. The new text says the hook renders twice: first with false, the server value, then with the resolved value. It also says to set noSsr for client-side only rendering. | Add a module-level hydrationCompleted flag, set it in the effect, and change the useState initializer to (noSsr \|\| hydrationCompleted) && supportMatchMedia<br>Export a testReset() function from useMediaQuery.js and call it in a beforeEach in the tests<br>Change the expected render count in 'should try to reconcile each time' and add a new test for the flag<br>Check the withWidth and lab ResponsiveWrapper tests for breakage caused by the initializer change | none | none |
