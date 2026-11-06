# Form planner bench

- pass: plan; provider claude; judge `claude-opus-5-5` via claude (effort low); started 2026-11-02T23:42:00.314Z
- Ground truth is the gold fix patch and the F2P tests, hidden from the planner. The judge is blind to the model and scores the union of the drafts.
- Excluded and counted, never scored 0: judge-errors, runs with no draft, timeouts and call errors.

## By model

| model | runs | scored | judge errors | no draft | timeouts | errors | notDone | unrequested | f2p coverage | static defect rate | planner tokens (reported) | judge tokens (reported) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| claude-sonnet-5-5 | 6 | 6 | 0 | 0 | 0 | 0 | 1.17 | 0.50 | 56% | 0% | 2557726 | 217065 |

## Per case

| case | model | status | drafts | notDone | unrequested | f2p | static defects |
|---|---|---|---|---|---|---|---|
| vuejs/core:pr-8470 | claude-sonnet-5-5 | ok | 1 | 0 | 0 | covered | none |
| vuejs/core:pr-8785 | claude-sonnet-5-5 | ok | 1 | Generate the exact expression that the gold uses for the prop root: wrap the prop access in the UNREF helper with bracket notation, `_unref($props["name"])` (non-inline) and `_unref(__props["name"])` (inline). The draft asks for `$props.name` or genPropsAccessExp output without unref, so the snapshot/string assertions will not match.<br>Put the PROPS check in resolveSetupReference, as the gold does. The draft explicitly rejects this option and keeps the check only in the dotted-tag branch. | Add PROPS_ALIASED handling that uses __propsAliases to resolve the original prop name<br>Add camelized and PascalCase name matching for the prop root in a new dotted-branch-only lookup | partial, partial | none |
| vuejs/core:pr-9213 | claude-sonnet-5-5 | ok | 1 | Mark the vnode that renderSlot returns as slot fallback or not (an isSlotFallback flag) in packages/runtime-core/src/helpers/renderSlot.ts<br>Add the internal isSlotFallback field to the VNode interface in packages/runtime-core/src/vnode.ts<br>In processFragment in packages/runtime-core/src/renderer.ts, unmount the old fragment and mount again when isSlotFallback differs between n1 and n2. The drafts explicitly reject a renderer change and use a key suffix instead | Append a '_fb' suffix to the Fragment key when the fallback renders | none, partial | none |
| mui/material-ui:pr-23778 | claude-sonnet-5-5 | ok | 1 | 0 | 0 | covered | none |
| mui/material-ui:pr-24010 | claude-sonnet-5-5 | ok | 1 | 0 | 0 | covered | none |
| mui/material-ui:pr-23806 | claude-sonnet-5-5 | ok | 1 | Change React.useEffect to useEnhancedEffect (useLayoutEffect on the client) in packages/material-ui/src/useMediaQuery/useMediaQuery.js. The draft forbids any edit to useMediaQuery.js.<br>Add a new 'Client-side only rendering' docs section with a noSsr example and the theme components.MuiUseMediaQuery.defaultProps example (the draft uses the older props: { MuiUseMediaQuery } shape). | 0 | none | none |
