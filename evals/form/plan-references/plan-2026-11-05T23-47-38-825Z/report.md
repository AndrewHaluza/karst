# Form planner bench

- pass: plan; provider claude; judge `claude-sonnet-5-5` via claude (effort high); started 2026-11-05T23:47:38.825Z
- Ground truth is the gold fix patch and the F2P tests, hidden from the planner. The judge is blind to the model and scores the union of the drafts.
- Excluded and counted, never scored 0: judge-errors, runs with no draft, timeouts and call errors.

## By model

| model | runs | scored | judge errors | no draft | timeouts | errors | notDone | unrequested | f2p coverage | static defect rate | planner tokens (reported) | judge tokens (reported) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| claude-opus-5-5 | 6 | 6 | 0 | 0 | 0 | 0 | 0.33 | 0.83 | 81% | 0% | 1559364 | 226482 |

## Per case

| case | model | status | drafts | notDone | unrequested | f2p | static defects |
|---|---|---|---|---|---|---|---|
| vuejs/core:pr-8470 | claude-opus-5-5 | ok | 1 | 0 | 0 | covered | none |
| vuejs/core:pr-8785 | claude-opus-5-5 | ok | 1 | 0 | 0 | covered, covered | none |
| vuejs/core:pr-9213 | claude-opus-5-5 | ok | 1 | 0 | Run the runtime-core test suite and check hydration.spec.ts for assertions that the key change could affect | partial, covered | none |
| mui/material-ui:pr-23778 | claude-opus-5-5 | ok | 1 | 0 | 0 | covered | none |
| mui/material-ui:pr-24010 | claude-opus-5-5 | ok | 1 | 0 | 0 | covered | none |
| mui/material-ui:pr-23806 | claude-opus-5-5 | ok | 1 | Replace React.useEffect with useEnhancedEffect (import from ../utils/useEnhancedEffect) in useMediaQuery.js, so the media query value is resolved in a layout effect before paint on the client. The drafts keep the plain useEffect.<br>Add a 'Client-side only rendering' docs section with the noSsr examples, including the theme MuiUseMediaQuery defaultProps example. The drafts only edit the option text. | Add a module-level `hydrationCompleted` flag, set in the useEffect, and change the initializer to `(noSsr \|\| hydrationCompleted) && supportMatchMedia`.<br>Export `testReset()` from useMediaQuery.js to clear the flag, and call it in beforeEach in the tests.<br>Document the known limit that a second hydrate root can mismatch once the flag is set.<br>Run the withWidth, useMediaQueryTheme and ResponsiveWrapper tests with the flag in both states. | none | none |
