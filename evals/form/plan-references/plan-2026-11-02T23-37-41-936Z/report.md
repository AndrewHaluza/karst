# Form planner bench

- pass: plan; provider claude; judge `claude-sonnet-5-5` via claude (effort high); started 2026-11-02T23:37:41.936Z
- Ground truth is the gold fix patch and the F2P tests, hidden from the planner. The judge is blind to the model and scores the union of the drafts.
- Excluded and counted, never scored 0: judge-errors, runs with no draft, timeouts and call errors.

## By model

| model | runs | scored | judge errors | no draft | timeouts | errors | notDone | unrequested | f2p coverage | static defect rate | planner tokens (reported) | judge tokens (reported) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| claude-opus-5-5 | 3 | 3 | 0 | 0 | 0 | 0 | 1.33 | 0.33 | 63% | 0% | 463901 | 108520 |

## Per case

| case | model | status | drafts | notDone | unrequested | f2p | static defects |
|---|---|---|---|---|---|---|---|
| vuejs/core:pr-8470 | claude-opus-5-5 | ok | 1 | 0 | 0 | covered | none |
| vuejs/core:pr-9213 | claude-opus-5-5 | ok | 1 | The gold fix marks the slot vnode with an `isSlotFallback` flag (set in renderSlot, declared in vnode.ts) and makes processFragment in renderer.ts unmount the old fragment when the flag changes. The drafts use a different fallback key and never touch renderer.ts or vnode.ts. This covers the same cases only if the key is not user-supplied. | 0 | partial, covered | none |
| mui/material-ui:pr-23806 | claude-opus-5-5 | ok | 1 | Replace React.useEffect with useEnhancedEffect (import from ../utils/useEnhancedEffect) in useMediaQuery.js, so the media query value is corrected before paint on the client. The drafts keep the existing useEffect.<br>Add a 'Client-side only rendering' section to use-media-query.md. It explains the double render and shows the noSsr option, both per call and globally through the theme's MuiUseMediaQuery defaultProps.<br>Reword the options.noSsr description in the docs. The first render returns false, the server value, and the second render returns the resolved value. Set noSsr to true for client-side only rendering. | Add a module-level hydrationCompleted flag, set in the hook's effect. In the useState initializer, call matchMedia when (noSsr \|\| hydrationCompleted) is true. | none | none |
